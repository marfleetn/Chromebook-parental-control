/**
 * CHPC Family — MV3 service worker.
 *
 * Responsibilities:
 *  1. Pairing state lives in chrome.storage.local (set by popup.html).
 *  2. Heartbeat every 5 min  -> POST /api/devices/:code/heartbeat  (liveness + tz)
 *  3. Policy refresh on      -> GET  /api/devices/:code            (effective policy)
 *  4. DNR rules recomputed   -> every 60 s (time windows / budgets flip) and
 *     applied via chrome.declarativeNetRequest.updateDynamicRules
 *  5. Usage metering         -> webRequest (observation only, MV3 cannot
 *     block with webRequest) — count seconds per site for requests that
 *     actually went through, flush every 60 s:
 *                               POST /api/devices/:code/usage
 *
 * Fail-closed behaviour:
 *  - unparseable policy  -> single block-everything rule (core failClosedRules)
 *  - never paired yet    -> no rules (extension inert until paired)
 *  - server unreachable > 10 min after a good session -> last cached policy;
 *    if there is no cache -> fail-closed block-all (local network excepted).
 */

const ALARM_BEAT = 'chpc-beat-5m';   // heartbeat + policy refresh
const ALARM_TICK = 'chpc-tick-60s';  // rule recompute + usage flush
const OFFLINE_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------- storage --
async function store() {
  const o = await chrome.storage.local.get(
    ['serverUrl', 'pairingCode', 'kidName', 'cachedPolicy',
     'lastSuccess', 'tz', 'pendingUsage']);
  return o;
}
async function put(pairs) { await chrome.storage.local.set(pairs); }

function apiBase(s) { return String(s.serverUrl || '').replace(/\/+$/, ''); }

// ---------------------------------------------------------------- network --
async function withTimeout(promise, ms = 8000) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

async function heartbeat(s) {
  const base = apiBase(s);
  if (!base || !s.pairingCode) return { ok: false, reason: 'not paired' };
  const r = await withTimeout(fetch(base + '/api/devices/' + encodeURIComponent(s.pairingCode) + '/heartbeat',
    { method: 'POST' }));
  if (!r.ok) return { ok: false, reason: 'heartbeat ' + r.status };
  const j = await r.json().catch(() => ({}));
  const tz = j && typeof j.timeZone === 'string' ? j.timeZone : (s.tz || 'UTC');
  await put({ lastSuccess: Date.now(), tz });
  return { ok: true, tz };
}

async function fetchPolicy(s) {
  const base = apiBase(s);
  const r = await withTimeout(fetch(base + '/api/devices/' + encodeURIComponent(s.pairingCode)));
  if (!r.ok) throw new Error('policy ' + r.status);
  const j = await r.json();
  if (!j || typeof j !== 'object' || !j.policy) throw new Error('malformed policy payload');
  await put({
    cachedPolicy: j.policy,
    kidName: (j.kid && (j.kid.name || j.kid.nick)) || s.kidName || null,
    lastSuccess: Date.now(),
    tz: (j.device && j.device.timeZone) || s.tz || 'UTC',
  });
  return j.policy;
}

// -------------------------------------------------------- DNR application --
/** MV3 DNR rejects anchored / grouped regexes in some builds — normalise. */
function dnrSafeRule(r) {
  const cond = Object.assign({}, r.condition);
  if (typeof cond.regexFilter === 'string') {
    cond.regexFilter = cond.regexFilter.replace(/^\^/, '').replace(/\$$/, '');
  }
  return { id: r.id, priority: r.priority, action: r.action, condition: cond,
           description: r.description || '' };
}

async function applyPolicy(s) {
  const dnr = await import('./vendor/core.js');
  let policy = s.cachedPolicy;
  if (policy == null) policy = {};
  const raw = dnr.buildDnrRules(policy, { at: Date.now(), tz: s.tz || 'UTC' });
  const rules = raw.map(dnrSafeRule);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: rules,
  });
  return rules.length;
}

// ------------------------------------------------------------- metering ----
/** Accumulate {host: seconds} in storage across service-worker wakes. */
async function bumpUsage(host, seconds = 60) {
  const s = await store();
  const pending = (s.pendingUsage && typeof s.pendingUsage === 'object') ? { ...s.pendingUsage } : {};
  const h = (typeof host === 'string' ? host : '').toLowerCase().slice(0, 253);
  if (!h) return;
  pending[h] = Math.round((Number(pending[h]) || 0) + seconds);
  await put({ pendingUsage: pending });
}

async function flushUsage(s) {
  const pending = s.pendingUsage;
  if (!pending || typeof pending !== 'object' || !Object.keys(pending).length) return { sent: 0 };
  const base = apiBase(s);
  const code = s.pairingCode;
  if (!base || !code) { await put({ pendingUsage: {} }); return { sent: 0 }; }
  let sent = 0;
  for (const [host, seconds] of Object.entries(pending).sort((a, b) => a[0].localeCompare(b[0]))) {
    try {
      const r = await withTimeout(fetch(base + '/api/devices/' + encodeURIComponent(code) + '/usage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ site: host, seconds: Math.max(1, seconds) }),
      }), 8000);
      if (r.ok) sent++;
    } catch { /* keep pending for next tick */ }
  }
  if (sent === Object.keys(pending).length) await put({ pendingUsage: {} });
  return { sent };
}

/** webRequest: observation only (MV3 blocks are done by DNR above).
 *  Requests that end up DNR-redirected never reach this listener, so
 *  counting here == counting only what actually loaded. */
function observeNavigation() {
  chrome.webRequest.onBeforeRequest.addListener(
    (d) => {
      if (d.type !== 'mainFrame') return;
      if (!/^https?:/i.test(d.url || '')) return;
      let host = '';
      try { host = new URL(d.url).host.toLowerCase(); } catch { return; }
      bumpUsage(host, 60);
    },
    { urls: ['http://*/*', 'https://*/*'] },
  );
}

// ------------------------------------------------------------- top level --
async function beat() {
  const s = await store();
  if (!s.pairingCode) return;            // not paired yet: stay inert
  const hb = await heartbeat(s).catch(() => ({ ok: false }));
  const s2 = await store();
  const fresh = await (hb.ok || s2.lastSuccess
    ? fetchPolicy(s2).then((p) => p).catch(() => null)
    : null);
  const policy = fresh != null ? fresh : s2.cachedPolicy;
  const age = s2.lastSuccess ? Date.now() - s2.lastSuccess : Infinity;
  if (policy == null && age > OFFLINE_MS) {
    // never had a policy and server gone: fail closed.
    const dnr = await import('./vendor/core.js');
    await applyFailClosed(dnr);
    return;
  }
  await applyPolicy({ ...s2, cachedPolicy: policy }).catch(() => {
    const dnr = import('./vendor/core.js');
    import('./vendor/core.js').then(applyFailClosed);
  });
}

async function applyFailClosed(dnr) {
  const rules = dnr.failClosedRules().map(dnrSafeRule);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: rules,
  });
}

async function tick() {
  const s = await store();
  if (!s.pairingCode) return;
  await flushUsage(s).catch(() => {});
  await beat();   // recompute rules (windows/budgets flip on the minute)
}

function ensureAlarms() {
  chrome.alarms.create(ALARM_BEAT, { periodInMinutes: 5 });
  chrome.alarms.create(ALARM_TICK, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarms(); observeNavigation(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarms(); observeNavigation(); beat().catch(() => {}); });
if (typeof chrome !== 'undefined' && chrome.alarms) {
  observeNavigation();
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === ALARM_TICK) tick().catch(() => {});
  });
}
