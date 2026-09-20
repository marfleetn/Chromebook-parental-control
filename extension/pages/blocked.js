/* CHPC Family — lock page. Explains why the navigation was blocked. */
'use strict';
(function () {
  const REASONS = {
    'disabled':     ['Internet is switched off', 'A parent has switched the internet off for this account.'],
    'off-day':      ['Today is an off day', 'No web browsing is allowed today.'],
    'off-hours':    ['Outside allowed hours', 'It’s outside the hours when the internet is allowed.'],
    'daily-budget': ['Daily time is used up', 'Today’s internet time has been used. Try again tomorrow.'],
    'site-denied':  ['This site is blocked', 'A parent has blocked this site.'],
    'site-budget':  ['Time limit for this site reached', 'Today’s time on this site has been used.'],
    'not-allowed':  ['Site not on the approved list', 'Only sites a parent has approved can be opened.'],
    'fail-closed':  ['Console unreachable', 'The family console could not be reached, so the internet is locked until it is.'],
  };
  const q = new URLSearchParams(location.search);
  const url = q.get('url') || '';
  let host = url;
  try { host = new URL(url).hostname || url; } catch { /* keep raw */ }
  document.getElementById('url').textContent = host || '(unknown)';
  document.getElementById('when').textContent = new Date().toLocaleString();

  function show(code) {
    const r = REASONS[code];
    if (!r) return;
    document.getElementById('title').textContent = r[0];
    document.getElementById('lede').textContent = r[1] + ' If you think this is a mistake, ask a parent.';
    document.getElementById('reason').textContent = code;
  }
  const code = q.get('code');
  if (code && REASONS[code]) {
    show(code);
  } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    // No code in the URL (plain extensionPath redirect): ask the worker what applies right now.
    try {
      chrome.runtime.sendMessage({ type: 'CHPC_WHY' }, (resp) => {
        void chrome.runtime.lastError;
        if (resp && resp.code) show(resp.code); else show('site-denied');
      });
    } catch { show('site-denied'); }
  }
  document.getElementById('back').addEventListener('click', () => {
    if (history.length > 1) history.back(); else location.href = 'about:blank';
  });
})();
