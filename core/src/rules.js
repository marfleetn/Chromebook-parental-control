/**
 * @chpc/core — declarativeNetRequest (DNR) rule generator.
 *
 * Pure mapping: (policy, clock, timezone) -> a deterministic array of DNR
 * dynamic rules. The extension's service worker calls this on startup, on
 * every policy refresh, and on a 60-second tick (so time windows and one-off
 * off-days flip over without a server round-trip), then applies the result
 * via `chrome.declarativeNetRequest.updateDynamicRules`.
 *
 * Everything is pure — no `chrome.*`, no I/O. `at` defaults to Date.now()
 * only so callers without a clock (tests) still work; pass one explicitly
 * for determinism.
 *
 * Enforcement in MV3 is DNR: `webRequest` cannot block. Block rules use the
 * `redirect` action to a friendly lock page (`pages/blocked.html`) so the
 * child sees an explanation instead of Chrome's bare error.
 *
 * --- Priority ladder (DNR: highest priority rule that matches wins) -------
 *  4000  master switch OFF          — nothing, not even local, goes
 *  3950  local-network allow        — 127.*, 192.168.*, 10.*, 172.16-31.*
 *  3900  scheduled off-day          — weekday names in policy.offDays
 *  3901  one-off off-day (today)    — ISO date in policy.offDays
 *  3800  daily budget exhausted     — usageToday >= dailyMinutes
 *  3500  outside time window        — complement of policy.windows
 *  3000  site veto (deny list)      — wins over allowlist
 *  2500  per-site budget exhausted
 *  2000  allowlist entries          — allow rules (mode === "allowlist")
 *  1000  allowlist baseline         — block everything else
 *  1000  unparseable policy         — fail-closed: block everything
 *
 * --- Policy shape (see policy.js) -----------------------------------------
 * internetAllowed, windows[{days,start,end}], offDays, dailyMinutes,
 * usageToday, mode, allow[], deny[], siteBudgets[{pattern,minutes,used}]
 */
import { dayAllowed, inWindow, isOffDay, parseHM, localClock } from './time.js';
import { getHost } from './site.js';

export const LOCK_PAGE = 'pages/blocked.html';

const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

const blockAction = () => ({ type: 'redirect', redirect: { extensionPath: LOCK_PAGE } });
const allowAction = () => ({ type: 'allow' });

/** Normalize a core site pattern to a DNR urlFilter.
 *  Core semantics (ruleMatchesHost): every non-`*` pattern covers the host
 *  and all its subdomains — map that to the `||host` form (host boundaries
 *  on both sides, so `tiktok.com` never matches `notiktok.com`).
 *  Returns null for `*`, empty, or local hosts (handled by the local rule). */
export function patternToUrlFilter(pattern) {
  if (typeof pattern !== 'string') return null;
  let p = pattern.trim().toLowerCase();
  if (!p || p === '*') return null;
  p = p.replace(/^\*+\./, '').replace(/^\*+/, '');
  if (!p) return null;
  const host = getHost(p) || p;
  if (!host || isLocalish(host)) return null;
  return '||' + host;
}

function isLocalish(host) {
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.lan') ||
      host.endsWith('.home') || host.endsWith('.internal')) return true;
  if (/^(\[)?::1/.test(host)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // any literal IP: allow via local rule
  return false;
}

function mainFrame(extra = {}) {
  return { requestTypes: ['mainFrame'], ...extra };
}

const PRIVATE_NET_REGEX =
  '^https?://(127\\.0\\.0\\.1|localhost|192\\.168\\.\\d{1,3}\\.\\d{1,3}|10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|172\\.(1[6-9]|2[0-9]|3[0-1])\\.\\d{1,3}\\.\\d{1,3})(:\\d+)?(/.*)?$';

/** One full-day interval (no time bounds) — used for whole off-days. */
function dayCond(dowIdx, hourBounds = null) {
  const c = mainFrame({ dayOfWeek: [DAY_NAMES[dowIdx]] });
  if (hourBounds != null) {
    c.timeOfDayStart = { h: Math.floor(hourBounds[0] / 60), m: hourBounds[0] % 60 };
    c.timeOfDayEnd = { h: Math.floor(hourBounds[1] / 60), m: hourBounds[1] % 60 };
  }
  return c;
}

/** Split [0,1440] minus a list of allowed [s,e) intervals into complement intervals. */
function complement(allows) {
  const sorted = allows
    .filter((x) => x[0] != null && x[1] != null && x[1] > x[0])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  let cursor = 0;
  for (const [s, e] of sorted) {
    if (s > cursor) out.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < 1440) out.push([cursor, 1440]);
  return out;
}

function windowEmpty(w) {
  if (!w) return true;
  return !(parseHM(w.start) != null && parseHM(w.end) != null);
}

export const PRIORITIES = {
  master: 4000, local: 3950, offDay: 3900, offDayToday: 3901,
  dailyBudget: 3800, timeWindow: 3500, siteVeto: 3000, siteBudget: 2500,
  allow: 2000, allowlistBase: 1000,
};

/**
 * Build the full DNR dynamic-rule set for one child's policy.
 * @param {object} policy  per-child policy (see file header)
 * @param {object} [opts]  { at: epoch ms, tz: IANA zone }
 * @returns array of DNR dynamic rules
 */
export function buildDnrRules(policy, opts = {}) {
  const at = opts.at != null ? opts.at : Date.now();
  const tz = opts.tz || 'UTC';
  const rules = [];
  const add = (id, condition, action, priority, description = '') => {
    rules.push({ id, priority, action, condition, description });
  };

  // Fail closed on garbage — a broken policy must never unlock the browser.
  if (!policy || typeof policy !== 'object') {
    add(1, mainFrame({ urlFilter: 'http*' }), blockAction(), PRIORITIES.allowlistBase,
      'UNPARSEABLE POLICY — fail closed: internet disabled');
    return rules;
  }

  // 1) Master switch.
  if (policy.internetAllowed === false) {
    add(1, mainFrame({ urlFilter: 'http*' }), blockAction(), PRIORITIES.master,
      'Master internet switch is OFF');
    return rules; // nothing else can win; keep the rule set minimal
  }

  // 2) Local network / device addresses — always reachable (core policy.js
  //    exempts them the same way), below the master switch, above everything.
  add(2, mainFrame({ regexFilter: PRIVATE_NET_REGEX, regexType: 'ECMASCRIPT' }),
    allowAction(), PRIORITIES.local, 'Local network / device addresses');

  const clock = localClock(at, tz);
  const offDays = Array.isArray(policy.offDays) ? policy.offDays : [];
  let idBase = 10;

  // 3) Scheduled off-days: weekday names + today-if-listed ISO dates.
  for (const od of offDays) {
    if (typeof od !== 'string') continue;
    const name = od.trim();
    if (name.length >= 3 && !/^\d{4}-\d{2}-\d{2}$/.test(name)) {
      const idx = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(name.toLowerCase().slice(0, 3));
      if (idx >= 0) {
        add(idBase++, dayCond(idx), blockAction(), PRIORITIES.offDay,
          'Scheduled off day: ' + name);
      }
    } else if (name === clock.date) {
      add(idBase++, mainFrame({ urlFilter: 'http*' }), blockAction(),
        PRIORITIES.offDayToday, 'One-off off day (today): ' + clock.date);
    }
  }

  // 4) Time windows (empty/missing = always on). Compute the per-day
  //    "outside the window" complement and emit block rules for it.
  const windows = (Array.isArray(policy.windows) ? policy.windows : []).filter((w) => !windowEmpty(w));
  if (windows.length) {
    for (let d = 0; d < 7; d++) {
      const allows = windows
        .filter((w) => dayAllowed(d, w.days))
        .map((w) => [parseHM(w.start), parseHM(w.end)]);
      for (const [s, e] of complement(allows)) {
        const cond = (s === 0 && e === 1440) ? mainFrame({ dayOfWeek: [DAY_NAMES[d]] }) : dayCond(d, [s, e]);
        add(idBase++, cond, blockAction(), PRIORITIES.timeWindow,
          'Outside allowed internet hours (day: ' + DAY_NAMES[d] + ')');
      }
    }
  }

  // 5) Daily total budget exhausted.
  if (policy.dailyMinutes != null && policy.dailyMinutes > 0 &&
      (Number(policy.usageToday) || 0) >= policy.dailyMinutes) {
    add(idBase++, mainFrame({ urlFilter: 'http*' }), blockAction(), PRIORITIES.dailyBudget,
      'Daily internet budget is used up');
  }

  // 6) Site veto — always wins over allowlist.
  for (const pat of policy.deny || []) {
    const f = patternToUrlFilter(pat);
    if (f) add(idBase++, mainFrame({ urlFilter: f }), blockAction(), PRIORITIES.siteVeto,
      'Site veto: ' + pat);
  }

  // 7) Per-site budgets exhausted.
  for (const sb of policy.siteBudgets || []) {
    if (sb && sb.minutes != null && sb.minutes > 0 &&
        (Number(sb.used) || 0) >= sb.minutes) {
      const f = patternToUrlFilter(sb.pattern);
      if (f) add(idBase++, mainFrame({ urlFilter: f }), blockAction(), PRIORITIES.siteBudget,
        'Site time limit used up: ' + sb.pattern);
    }
  }

  // 8) Allowlist mode: allow the listed sites, block the rest.
  if ((policy.mode || 'unrestricted') === 'allowlist') {
    const allow = policy.allow || [];
    for (const pat of allow) {
      const f = patternToUrlFilter(pat);
      if (f) add(idBase++, mainFrame({ urlFilter: f }), allowAction(), PRIORITIES.allow,
        'Allowlisted: ' + pat);
    }
    add(idBase++, mainFrame({ urlFilter: 'http*' }), blockAction(), PRIORITIES.allowlistBase,
      'Allowlist baseline: everything else is not approved');
  }

  return rules;
}

/** Convenience for tests/offline fallback: a minimal fail-closed set. */
export function failClosedRules() {
  return [
    {
      id: 1, priority: PRIORITIES.master,
      action: blockAction(),
      condition: mainFrame({ urlFilter: 'http*' }),
      description: 'OFFLINE FAIL-CLOSED — server unreachable too long',
    },
    {
      id: 2, priority: PRIORITIES.local,
      action: allowAction(),
      condition: mainFrame({ regexFilter: PRIVATE_NET_REGEX, regexType: 'ECMASCRIPT' }),
      description: 'Local network / device addresses',
    },
  ];
}
