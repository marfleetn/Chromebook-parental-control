/* CHPC Family — popup control (pairing + status). */
'use strict';

const $ = (id) => document.getElementById(id);
const state = { s: {}, msg: null, msgErr: false };

function store() {
  return chrome.storage.local.get([
    'pairingCode', 'apiBase', 'tz', 'kidName',
    'lastSuccess', 'lastFail', 'cachedPolicy', 'lastCount',
  ]);
}

function paint(s) {
  const paired = !!(s.pairingCode);
  $('pair-code').value = s.pairingCode || '';
  $('api-base').value = s.apiBase || '';
  $('unpair-btn').hidden = !paired;
  $('policy-section').hidden = !paired;

  const age = s.lastSuccess ? Date.now() - new Date(s.lastSuccess).getTime() : Infinity;
  const dot = $('dot');
  let text;
  if (!paired) {
    text = 'Enter a pairing code from the parent console.';
    dot.className = 'dot wait';
  } else if (age < 5 * 60 * 1000) {
    text = `Online${s.kidName ? ' · ' + s.kidName : ''}`;
    dot.className = 'dot ok';
  } else if (age < 60 * 60 * 1000) {
    text = 'Checking… (last success ' + shortAge(age) + ' ago)';
    dot.className = 'dot wait';
  } else {
    text = 'Offline — last known policy in effect';
    dot.className = 'dot bad';
  }
  $('status-text').textContent = text;

  const p = s.cachedPolicy || {};
  const bits = [];
  if (p.internetAllowed === false) bits.push('no internet');
  else if (Array.isArray(p.allow) && p.allow.length) bits.push('allowlist: ' + p.allow.join(', '));
  if (Array.isArray(p.deny) && p.deny.length) bits.push('blocked: ' + p.deny.length);
  if (Array.isArray(p.windows) && p.windows.length) bits.push(`${p.windows.length} window(s)`);
  if (Array.isArray(p.siteBudgets) && p.siteBudgets.length) bits.push('budgets on');
  $('policy-preview').value = bits.length ? ` ${bits.join(' · ')} ` : ' (no policy cached yet)';
  $('kid-name').textContent = (s.kidName || (paired ? 'Paired device' : 'Not paired yet'));
}

function shortAge(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return m + ' min';
  const h = Math.round(m / 60);
  return h + ' h';
}

function showMsg(text, err) {
  const el = $('msg');
  el.textContent = text;
  el.className = 'msg' + (err ? ' err' : '');
}

// ---- actions ----
async function pair() {
  const code = $('pair-code').value.trim();
  const base = $('api-base').value.trim().replace(/\/+$/, '');
  if (!code) { showMsg('Enter a pairing code first.', true); return; }
  if (!base) { showMsg('Enter the console address first.', true); return; }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(base + '/api/devices/' + encodeURIComponent(code), { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      showMsg('Pairing failed: ' + (body.error || r.status), true);
      return;
    }
    const j = await r.json();
    const tz = (j.device && j.device.timeZone) || null;
    await chrome.storage.local.set({
      pairingCode: code,
      apiBase: base,
      tz,
      kidName: (j.kid && (j.kid.name || j.kid.nick)) || null,
      cachedPolicy: j.policy || null,
      lastSuccess: new Date().toISOString(),
    });
    state.s = await store();
    paint(state.s);
    showMsg('Paired. Policy applied.');
    // kick a beat in the SW so rules land immediately
    chrome.runtime.sendMessage({ type: 'CHPC_REFRESH' }, () => void chrome.runtime.lastError);
  } catch (e) {
    showMsg('Could not reach console (' + (e.name === 'AbortError' ? 'timeout' : e.message) + ')', true);
  }
}

async function unpair() {
  await chrome.storage.local.remove([
    'pairingCode', 'apiBase', 'tz', 'kidName',
    'lastSuccess', 'lastFail', 'cachedPolicy', 'lastCount',
  ]);
  state.s = await store();
  paint(state.s);
  showMsg('Unpaired. Local rules kept until next start.');
}

async function refresh() {
  showMsg('Refreshing…');
  chrome.runtime.sendMessage({ type: 'CHPC_REFRESH' }, async (resp) => {
    void chrome.runtime.lastError;
    state.s = await store();
    paint(state.s);
    if (resp && resp.rules !== undefined) showMsg(resp.rules + ' rules active.');
    else if (resp && resp.error) showMsg(String(resp.error), true);
    else showMsg('Refresh sent.');
  });
}

$('pair-btn').addEventListener('click', pair);
$('unpair-btn').addEventListener('click', unpair);
$('refresh-btn').addEventListener('click', refresh);

store().then((s) => {
  state.s = s;
  paint(s);
});
