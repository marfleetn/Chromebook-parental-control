/**
 * CHPC Family — MV3 service worker (ES module).
 *
 * Responsibilities
 *  1. Pairing state lives in chrome.storage.local (written by popup.js).
 *  2. Every minute (chrome.alarms):
 *       a. meter the active tab: +60 s for its host, only when the browser
 *          window is focused and the user is not idle;
 *       b. flush metered seconds  -> POST /api/devices/:code/usage
 *       c. refresh the policy     -> GET  /api/devices/:code
 *       d. recompute DNR rules from (policy, now, tz) and apply them via
 *          chrome.declarativeNetRequest.updateDynamicRules when they changed.
 *  3. Answer popup / lock-page messages (status, refresh, "why was I blocked").
 *
 * Fail-closed behaviour
 *  - never paired            -> no rules (extension is inert until paired)
 *  - server unreachable      -> keep applying the last cached policy; local
 *                               metering keeps budgets counting down offline
 *  - no policy ever fetched and server unreachable > 10 min -> block all
 *    (local network excepted)
 *  - Chrome rejects the rule set -> retry in the simpler rule flavour, then
 *    fall back to the fail-closed set. A broken rule set never means "open".
 */
import { buildDnrRules, failClosedRules, minimalBlockRules, globalBlockCode, stripStars, LOCK_PAGE } from './vendor/core.js';

const ALARM_TICK = 'chpc-tick';
const OFFLINE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const KEYS = ['apiBase', 'pairingCode', 'kidName', 'cachedPolicy', 'lastSuccess', 'lastFail',
  'lastError', 'tz', 'pendingUsage', 'lastRules', 'lastBlock', 'ruleMode', 'ruleCount'];

// ---------------------------------------------------------------- storage --
const store = () => chrome.storage.local.get(KEYS);
const put = (pairs) => chrome.storage.local.set(pairs);

function apiBase(s) { return String(s.apiBase || '').replace(/\/+$/, ''); }
function deviceUrl(s, suffix = '') {
  return apiBase(s) + '/api/devices/' + encodeURIComponent(s.pairingCode) + suffix;
}

// ---------------------------------------------------------------- network --
async function fetchJson(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** GET the effective policy; caches it on success. Throws on failure. */
async function refreshPolicy(s) {
  const r = await fetchJson(deviceUrl(s));
  if (r.status === 404) {
    // The parent revoked this pairing: forget it and go inert (no rules).
    await forgetPairing('This device was unpaired from the console.');
    throw new Error('unpaired');
  }
  if (!r.ok) throw new Error('policy HTTP ' + r.status);
  const j = r.body;
  if (!j || typeof j !== 'object' || !j.policy || typeof j.policy !== 'object') throw new Error('malformed policy payload');
  await put({
    cachedPolicy: j.policy,
    kidName: (j.kid && j.kid.name) || s.kidName || null,
    tz: typeof j.timeZone === 'string' ? j.timeZone : (s.tz || 'UTC'),
    lastSuccess: Date.now(),
    lastError: null,
  });
  return j.policy;
}

/** POST pending usage as one batch; clears what was accepted. */
async function flushUsage(s) {
  const pending = (s.pendingUsage && typeof s.pendingUsage === 'object') ? s.pendingUsage : {};
  const entries = Object.entries(pending)
    .filter(([, sec]) => Number(sec) > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 100)
    .map(([site, seconds]) => ({ site, seconds: Math.round(Number(seconds)) }));
  if (!entries.length) return;
  const r = await fetchJson(deviceUrl(s, '/usage'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries }),
  });
  if (!r.ok) throw new Error('usage HTTP ' + r.status);
  const rest = { ...pending };
  for (const e of entries) delete rest[e.site];
  await put({ pendingUsage: rest });
}

// ------------------------------------------------------------- metering ----
/** Add `seconds` to the host of the focused, active tab — if the user is active. */
async function meterActiveTab(seconds = 60) {
  try {
    const idle = await chrome.idle.queryState(60);
    if (idle !== 'active') return;
    const win = await chrome.windows.getLastFocused({ populate: false }).catch(() => null);
    if (!win || !win.focused) return;
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    if (!tab || !/^https?:/i.test(tab.url || '')) return;
    const host = new URL(tab.url).hostname.toLowerCase();
    if (!host) return;
    const s = await chrome.storage.local.get(['pendingUsage']);
    const pending = (s.pendingUsage && typeof s.pendingUsage === 'object') ? { ...s.pendingUsage } : {};
    pending[host] = Math.min(6 * 3600, (Number(pending[host]) || 0) + seconds);
    await put({ pendingUsage: pending });
  } catch { /* metering is best-effort */ }
}

/** Fold not-yet-reported local usage into the cached policy so budgets keep counting offline. */
function withLocalUsage(policy, pending) {
  if (!policy || typeof policy !== 'object' || !pending || typeof pending !== 'object') return policy;
  const p = { ...policy };
  const hosts = Object.entries(pending).filter(([, sec]) => Number(sec) > 0);
  if (!hosts.length) return p;
  const totalMin = hosts.reduce((a, [, sec]) => a + Number(sec), 0) / 60;
  p.usageToday = (Number(p.usageToday) || 0) + totalMin;
  if (Array.isArray(p.siteBudgets)) {
    p.siteBudgets = p.siteBudgets.map((sb) => {
      if (!sb || typeof sb.pattern !== 'string') return sb;
      const pat = stripStars(sb.pattern.toLowerCase());
      const extra = hosts.filter(([h]) => h === pat || h.endsWith('.' + pat)).reduce((a, [, sec]) => a + Number(sec), 0) / 60;
      return extra ? { ...sb, used: (Number(sb.used) || 0) + extra } : sb;
    });
  }
  return p;
}

// -------------------------------------------------------- DNR application --
async function setDynamicRules(rules) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: rules,
  });
  const applied = await chrome.declarativeNetRequest.getDynamicRules();
  if (applied.length !== rules.length) throw new Error(`Chrome kept ${applied.length} of ${rules.length} rules`);
  return applied.length;
}

/**
 * Apply `policy` as DNR rules. Tries the rich "regex + reason" flavour first,
 * then the plain extensionPath flavour, then the fail-closed set. Never
 * reports a rule count it did not read back from Chrome.
 */
async function applyPolicy(policy, s) {
  const tz = s.tz || 'UTC';
  const at = Date.now();
  const lockUrl = chrome.runtime.getURL(LOCK_PAGE);
  const flavours = s.ruleMode === 'path' ? ['path', 'regex'] : ['regex', 'path'];
  let lastErr = null;
  for (const mode of flavours) {
    const rules = buildDnrRules(policy, { at, tz, lockUrl: mode === 'regex' ? lockUrl : null });
    const sig = mode + ':' + JSON.stringify(rules);
    if (sig === s.lastRules) return { rules: rules.length, mode, changed: false };
    try {
      const n = await setDynamicRules(rules);
      await put({ lastRules: sig, ruleMode: mode, ruleCount: n, lastBlock: globalBlockCode(policy, { at, tz }), lastError: null });
      return { rules: n, mode, changed: true };
    } catch (e) {
      lastErr = e;
    }
  }
  const n = await applyFailClosed('rules rejected by Chrome: ' + (lastErr && lastErr.message));
  return { rules: n, mode: 'fail-closed', changed: true, error: String(lastErr && lastErr.message) };
}

/** Block everything (local network excepted where Chrome allows it). Returns the applied count. */
async function applyFailClosed(reason) {
  const lockUrl = chrome.runtime.getURL(LOCK_PAGE);
  let n = 0;
  for (const rules of [failClosedRules({ lockUrl }), failClosedRules(), minimalBlockRules()]) {
    try { n = await setDynamicRules(rules); break; } catch { /* try the next, simpler set */ }
  }
  await put({ lastRules: 'fail-closed', lastBlock: 'fail-closed', ruleMode: null, ruleCount: n, lastError: reason || null });
  return n;
}

async function clearRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (existing.length) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id) });
  await put({ lastRules: null, ruleCount: 0, lastBlock: null });
}

async function forgetPairing(message) {
  await chrome.storage.local.remove(KEYS);
  await put({ lastError: message || null });
  await clearRules();
}

// ------------------------------------------------------------- top level --
let ticking = null;
/** One full cycle: meter, flush, refresh, apply. Serialised. */
function tick(opts = {}) {
  if (ticking) return ticking;
  ticking = (async () => {
    const s0 = await store();
    if (!s0.pairingCode || !s0.apiBase) { await clearRules().catch(() => {}); return { paired: false }; }
    if (opts.meter !== false) await meterActiveTab(60);

    let online = true;
    let s = await store();
    try { await flushUsage(s); } catch { online = false; }
    s = await store();
    try {
      await refreshPolicy(s);
    } catch (e) {
      if (e && e.message === 'unpaired') return { paired: false, unpaired: true };
      online = false;
      await put({ lastFail: Date.now(), lastError: String(e && e.message || e) });
    }
    s = await store();
    const age = s.lastSuccess ? Date.now() - Number(s.lastSuccess) : Infinity;
    if (s.cachedPolicy == null) {
      const n = age > OFFLINE_MS ? await applyFailClosed('no policy yet and the console is unreachable') : (s.ruleCount || 0);
      return { paired: true, online, rules: n, failClosed: age > OFFLINE_MS };
    }
    const policy = online ? s.cachedPolicy : withLocalUsage(s.cachedPolicy, s.pendingUsage);
    let r;
    try { r = await applyPolicy(policy, s); }
    catch (e) { r = { rules: await applyFailClosed(String(e && e.message || e)).catch(() => 0), mode: 'fail-closed' }; }
    return { paired: true, online, ...r };
  })().finally(() => { ticking = null; });
  return ticking;
}

function ensureAlarm() {
  chrome.alarms.get(ALARM_TICK, (a) => {
    if (!a) chrome.alarms.create(ALARM_TICK, { periodInMinutes: 1 });
  });
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); tick({ meter: false }).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); tick({ meter: false }).catch(() => {}); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM_TICK) tick().catch(() => {}); });

// Popup pairs/unpairs by writing storage; react immediately.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.pairingCode || changes.apiBase) tick({ meter: false }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg !== 'object') return { error: 'bad message' };
    switch (msg.type) {
      case 'CHPC_REFRESH': {
        const r = await tick({ meter: false });
        return { ok: true, ...r };
      }
      case 'CHPC_STATUS': {
        const s = await store();
        return {
          paired: !!(s.pairingCode && s.apiBase), kidName: s.kidName || null,
          lastSuccess: s.lastSuccess || null, lastFail: s.lastFail || null, lastError: s.lastError || null,
          rules: s.ruleCount || 0, block: s.lastBlock || null, tz: s.tz || null,
          policy: s.cachedPolicy || null,
          pendingMinutes: Math.round(Object.values(s.pendingUsage || {}).reduce((a, b) => a + Number(b), 0) / 60),
        };
      }
      case 'CHPC_WHY': {
        const s = await store();
        return { code: s.lastBlock || null, kidName: s.kidName || null };
      }
      case 'CHPC_FORGET': {
        // The popup has already verified the guardian PIN with the server.
        await forgetPairing(null);
        return { ok: true };
      }
      default:
        return { error: 'unknown message' };
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e && e.message || e) }));
  return true; // async response
});

ensureAlarm();
