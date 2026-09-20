/* CHPC Family — popup (pairing + status). No inline scripts: MV3 CSP forbids them. */
'use strict';

const $ = (id) => document.getElementById(id);
const REASONS = {
  'disabled': 'Internet is switched off',
  'off-day': 'Today is an off day',
  'off-hours': 'Outside allowed hours',
  'daily-budget': 'Daily time is used up',
  'fail-closed': 'Console unreachable — locked',
};

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp || null);
      });
    } catch { resolve(null); }
  });
}

function showMsg(text, isErr) {
  const el = $('msg');
  el.textContent = text || '';
  el.className = 'msg' + (isErr ? ' err' : '');
}

function shortAge(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  return h + ' h ago';
}

async function paint() {
  const st = (await send({ type: 'CHPC_STATUS' })) || { paired: false };
  const paired = !!st.paired;
  $('pair-section').hidden = paired;
  $('paired-section').hidden = !paired;
  $('kid-name').textContent = paired ? (st.kidName || 'Paired device') : 'Not paired yet';

  const dot = $('dot');
  let text;
  if (!paired) {
    text = 'Enter the pairing code from the parent console.';
    dot.className = 'dot wait';
  } else {
    const age = st.lastSuccess ? Date.now() - Number(st.lastSuccess) : Infinity;
    if (age < 3 * 60 * 1000) { text = 'Online'; dot.className = 'dot ok'; }
    else if (age < 60 * 60 * 1000) { text = 'Reconnecting… (last seen ' + shortAge(age) + ')'; dot.className = 'dot wait'; }
    else { text = 'Offline — last known rules apply'; dot.className = 'dot bad'; }
  }
  $('status-text').textContent = text;

  if (paired) {
    const p = st.policy || {};
    const bits = [];
    if (st.block && REASONS[st.block]) bits.push(REASONS[st.block]);
    if ((p.mode || 'unrestricted') === 'allowlist') bits.push('approved sites only');
    if (Array.isArray(p.deny) && p.deny.length) bits.push(p.deny.length + ' blocked site' + (p.deny.length === 1 ? '' : 's'));
    if (Array.isArray(p.windows) && p.windows.length) bits.push('allowed hours set');
    if (p.dailyMinutes) bits.push(`${Math.max(0, p.dailyMinutes - Math.floor(Number(p.usageToday) || 0))} of ${p.dailyMinutes} min left`);
    if (Array.isArray(p.siteBudgets) && p.siteBudgets.length) bits.push('site limits set');
    $('policy-preview').textContent = bits.length ? bits.join(' · ') : 'No restrictions right now';
    $('rules-count').textContent = `${st.rules || 0} rule${st.rules === 1 ? '' : 's'} active`;
    if (st.lastError && !st.lastSuccess) showMsg(st.lastError, true);
  }
}

// ---- actions ----
async function pair() {
  const code = $('pair-code').value.toUpperCase().replace(/[^A-Z]/g, '');
  let base = $('api-base').value.trim().replace(/\/+$/, '');
  if (!code || code.length < 6) { showMsg('Enter the 8-letter pairing code first.', true); return; }
  if (!base) { showMsg('Enter the console address first.', true); return; }
  if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
  try { new URL(base); } catch { showMsg('That console address is not a valid URL.', true); return; }

  $('pair-btn').disabled = true;
  showMsg('Contacting the console…');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(base + '/api/devices/' + encodeURIComponent(code), { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      showMsg(r.status === 404 ? 'That pairing code is not recognised. Check it in the console.' : ('Pairing failed: ' + (body.error || r.status)), true);
      return;
    }
    await chrome.storage.local.set({
      pairingCode: code,
      apiBase: base,
      tz: typeof body.timeZone === 'string' ? body.timeZone : null,
      kidName: (body.kid && body.kid.name) || null,
      cachedPolicy: body.policy || null,
      lastSuccess: Date.now(),
      lastError: null,
    });
    const r2 = await send({ type: 'CHPC_REFRESH' });
    showMsg(r2 && r2.rules != null ? `Paired. ${r2.rules} rule${r2.rules === 1 ? '' : 's'} applied.` : 'Paired.');
    await paint();
  } catch (e) {
    showMsg('Could not reach the console (' + (e && e.name === 'AbortError' ? 'timed out' : (e && e.message) || e) + ').', true);
  } finally {
    $('pair-btn').disabled = false;
  }
}

async function forget() {
  const pin = $('pin').value;
  if (!pin) { showMsg('Enter the guardian PIN to unpair.', true); return; }
  const s = await chrome.storage.local.get(['apiBase']);
  const base = String(s.apiBase || '').replace(/\/+$/, '');
  if (!base) { showMsg('No console address stored.', true); return; }
  $('forget-btn').disabled = true;
  showMsg('Checking PIN with the console…');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(base + '/api/auth/check', {
      headers: { 'X-Guardian-PIN': pin }, signal: ctrl.signal, cache: 'no-store',
    });
    clearTimeout(timer);
    if (r.status === 401) { showMsg('Wrong PIN.', true); return; }
    if (r.status === 429) { showMsg('Too many attempts — try again later.', true); return; }
    if (!r.ok) { showMsg('Console refused (' + r.status + ').', true); return; }
    await send({ type: 'CHPC_FORGET' });
    $('pin').value = '';
    $('forget-row').hidden = true;
    showMsg('Unpaired. All rules removed.');
    await paint();
  } catch (e) {
    showMsg('Could not reach the console — unpairing needs it online.', true);
  } finally {
    $('forget-btn').disabled = false;
  }
}

async function refresh() {
  showMsg('Refreshing…');
  const r = await send({ type: 'CHPC_REFRESH' });
  if (!r) showMsg('Background worker did not answer.', true);
  else if (r.error) showMsg(String(r.error), true);
  else if (r.paired === false) showMsg('Not paired.');
  else showMsg((r.online ? 'Policy refreshed. ' : 'Console unreachable — using cached rules. ') + `${r.rules ?? 0} rule${r.rules === 1 ? '' : 's'} active.`, !r.online);
  await paint();
}

$('pair-btn').addEventListener('click', pair);
$('pair-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') pair(); });
$('api-base').addEventListener('keydown', (e) => { if (e.key === 'Enter') pair(); });
$('refresh-btn').addEventListener('click', refresh);
$('show-forget-btn').addEventListener('click', () => { $('forget-row').hidden = !$('forget-row').hidden; if (!$('forget-row').hidden) $('pin').focus(); });
$('forget-btn').addEventListener('click', forget);
$('pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') forget(); });

paint();
