/**
 * @chpc/core — declarativeNetRequest (DNR) rule generator.
 *
 * Pure mapping: (policy, clock, timezone) -> a deterministic array of DNR
 * dynamic rules. The extension's service worker calls this on startup, on
 * every policy refresh, and on a 60-second tick, then applies the result via
 * `chrome.declarativeNetRequest.updateDynamicRules`.
 *
 * Everything is pure — no `chrome.*`, no I/O. `at` defaults to Date.now()
 * only so callers without a clock (tests) still work; pass one explicitly
 * for determinism.
 *
 * Why the clock matters: DNR has NO time-based conditions. Chrome's
 * RuleCondition knows about URLs, resource types, domains, methods and tabs —
 * nothing else. So "outside the allowed hours" and "today is an off day" are
 * decided *here*, at `at`, and expressed as a plain block-everything rule
 * that is present or absent. The extension recomputes every minute, so the
 * rule set tracks wall-clock time with at most one minute of lag.
 *
 * Enforcement in MV3 is DNR: `webRequest` cannot block. Block rules use the
 * `redirect` action to a friendly lock page (`pages/blocked.html`) so the
 * child sees an explanation instead of Chrome's bare error. Two flavours:
 *
 *   - opts.lockUrl given (the extension passes chrome.runtime.getURL(...)):
 *     block rules use `regexFilter` + `regexSubstitution` so the lock page
 *     receives `?code=<reason>&url=<scheme://host>`.
 *   - no lockUrl: block rules use `extensionPath` (no reason/URL passed).
 *
 * Only `main_frame` requests are gated — sub-resources of an allowed page
 * are allowed, and a blocked page never loads far enough to fetch any.
 *
 * --- Priority ladder (DNR: highest priority rule that matches wins) -------
 *  4000  master switch OFF          — nothing, not even local, goes
 *  3950  local-network allow        — 127.*, 192.168.*, 10.*, 172.16-31.*, *.local ...
 *  3900  off day (today)            — weekday name or ISO date in policy.offDays
 *  3890  offline fail-closed         — never had a policy and server unreachable
 *  3800  daily budget exhausted     — usageToday >= dailyMinutes
 *  3500  outside time window (now)  — no policy.windows entry covers `at`
 *  3000  site veto (deny list)      — wins over allowlist
 *  2500  per-site budget exhausted
 *  2000  allowlist entries          — allow rules (mode === "allowlist")
 *  1000  allowlist baseline         — block everything else
 *  1000  unparseable policy         — fail-closed: block everything
 *
 * Every rule carries ONLY the fields Chrome accepts: id, priority, action,
 * condition. Descriptions live in `describeRules()` for debugging/tests.
 */
import { dayAllowed, inWindow, isOffDay, parseHM, localClock } from './time.js';
import { getHost, isLocalHost } from './site.js';

export const LOCK_PAGE = 'pages/blocked.html';

export const PRIORITIES = {
  master: 4000, local: 3950, offDay: 3900,
  failClosed: 3890,
  dailyBudget: 3800, timeWindow: 3500, siteVeto: 3000, siteBudget: 2500,
  allow: 2000, allowlistBase: 1000,
};

/** Block reason codes carried to the lock page (mirror decide().code). */
export const BLOCK_CODES = {
  master: 'disabled', offDay: 'off-day', timeWindow: 'off-hours',
  dailyBudget: 'daily-budget', siteVeto: 'site-denied', siteBudget: 'site-budget',
  allowlistBase: 'not-allowed', failClosed: 'fail-closed',
};

const MAIN_FRAME = ['main_frame'];

// Captures "scheme://host[:port]" of any http(s) URL (group 1) and consumes
// the rest: Chrome's regexSubstitution replaces only the MATCHED span, so a
// block regex must match the whole URL or the leftover path is appended to
// the lock-page URL (verified in Chromium).
const REST = '(?:[/?#].*)?$';
const ANY_WEB_REGEX = '^(https?://[^/?#]+)' + REST;

// Private / local addresses. Kept in sync with site.js isLocalHost().
// Split in two: Chrome compiles each regexFilter with a 2KB memory budget and
// one combined expression exceeds it (verified with isRegexSupported).
const HOST_END = '(?::\\d+)?(?:[/?#]|$)';
export const PRIVATE_IP_REGEX =
  '^https?://(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|localhost|\\[::1\\]|' +
  '192\\.168\\.\\d+\\.\\d+|10\\.\\d+\\.\\d+\\.\\d+|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d+\\.\\d+)' + HOST_END;
export const LOCAL_SUFFIX_REGEX = '^https?://[^/?#:]+\\.(?:local|lan|home|internal)' + HOST_END;
export const LOCAL_REGEXES = [PRIVATE_IP_REGEX, LOCAL_SUFFIX_REGEX];

/** Escape a hostname for use inside a regex. */
function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalise a core site pattern to a bare hostname ("youtube.com").
 * Core semantics (ruleMatchesHost): every non-`*` pattern covers the host
 * and all its subdomains. Returns null for `*`, empty or local hosts (those
 * are handled by the catch-all / local rules).
 */
export function patternToHost(pattern) {
  if (typeof pattern !== 'string') return null;
  let p = pattern.trim().toLowerCase();
  if (!p || p === '*') return null;
  p = p.replace(/\*+$/, '').replace(/^\*+\.?/, '');
  if (!p) return null;
  const host = getHost(p);
  if (!host || isLocalHost(host)) return null;
  // Literal IPs are not "sites"; the local rule covers private ones and a
  // public IP literal is far too rare to justify a rule.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return null;
  return host;
}

/** Legacy helper kept for callers/tests: `||host` urlFilter form. */
export function patternToUrlFilter(pattern) {
  const h = patternToHost(pattern);
  return h ? '||' + h : null;
}

/** Regex matching a whole URL whose host is `host` or a subdomain; group 1 = scheme://host. */
function hostRegex(host) {
  return '^(https?://(?:[^/?#]*\\.)?' + reEscape(host) + ')(?::\\d+)?' + REST;
}

function blockAction(lockUrl, code) {
  if (lockUrl) {
    return { type: 'redirect', redirect: { regexSubstitution: `${lockUrl}?code=${code}&url=\\1` } };
  }
  return { type: 'redirect', redirect: { extensionPath: '/' + LOCK_PAGE } };
}
const allowAction = () => ({ type: 'allow' });

function windowEmpty(w) {
  if (!w || typeof w !== 'object') return true;
  return !(parseHM(w.start) != null && parseHM(w.end) != null);
}

/**
 * Which block-everything reason (if any) applies right now, in evaluation
 * order. Shared by buildDnrRules() and the extension's status display.
 * @returns one of BLOCK_CODES values or null
 */
export function globalBlockCode(policy, opts = {}) {
  if (!policy || typeof policy !== 'object') return BLOCK_CODES.failClosed;
  if (policy.internetAllowed === false) return BLOCK_CODES.master;
  const at = opts.at != null ? opts.at : Date.now();
  const tz = opts.tz || 'UTC';
  const clock = localClock(at, tz);

  const offDays = Array.isArray(policy.offDays) ? policy.offDays.filter((x) => typeof x === 'string') : [];
  if (offDays.length && isOffDay(clock.date, offDays)) return BLOCK_CODES.offDay;

  const windows = (Array.isArray(policy.windows) ? policy.windows : []).filter((w) => !windowEmpty(w));
  if (windows.length) {
    const inside = windows.some((w) => dayAllowed(clock.dow, w.days) && inWindow(clock.minsOfDay, w.start, w.end));
    if (!inside) return BLOCK_CODES.timeWindow;
  }

  if (policy.dailyMinutes != null && policy.dailyMinutes > 0 &&
      (Number(policy.usageToday) || 0) >= policy.dailyMinutes) {
    return BLOCK_CODES.dailyBudget;
  }
  return null;
}

/**
 * Build the full DNR dynamic-rule set for one child's policy.
 * @param {object} policy  per-child policy (see policy.js header)
 * @param {object} [opts]  { at: epoch ms, tz: IANA zone, lockUrl: absolute URL of the lock page }
 * @returns array of DNR dynamic rules (id, priority, action, condition only)
 */
export function buildDnrRules(policy, opts = {}) {
  const lockUrl = typeof opts.lockUrl === 'string' && opts.lockUrl ? opts.lockUrl : null;
  const rules = [];
  let nextId = 1;
  const add = (condition, action, priority) => {
    rules.push({ id: nextId++, priority, action, condition });
  };
  const blockAll = (code, priority) => {
    const cond = lockUrl
      ? { resourceTypes: MAIN_FRAME, regexFilter: ANY_WEB_REGEX }
      : { resourceTypes: MAIN_FRAME };
    add(cond, blockAction(lockUrl, code), priority);
  };
  const blockHost = (host, code, priority) => {
    const cond = lockUrl
      ? { resourceTypes: MAIN_FRAME, regexFilter: hostRegex(host) }
      : { resourceTypes: MAIN_FRAME, urlFilter: '||' + host };
    add(cond, blockAction(lockUrl, code), priority);
  };

  // Fail closed on garbage — a broken policy must never unlock the browser.
  if (!policy || typeof policy !== 'object') {
    blockAll(BLOCK_CODES.failClosed, PRIORITIES.allowlistBase);
    return rules;
  }

  // 1) Master switch: nothing else can win; keep the rule set minimal.
  if (policy.internetAllowed === false) {
    blockAll(BLOCK_CODES.master, PRIORITIES.master);
    return rules;
  }

  // 2) Local network / device addresses — always reachable (policy.js
  //    exempts them the same way), below the master switch, above the rest.
  for (const re of LOCAL_REGEXES) add({ resourceTypes: MAIN_FRAME, regexFilter: re }, allowAction(), PRIORITIES.local);

  // 3) Time-based whole-day blocks, evaluated at `at`.
  const gcode = globalBlockCode(policy, opts);
  if (gcode === BLOCK_CODES.offDay) blockAll(gcode, PRIORITIES.offDay);
  else if (gcode === BLOCK_CODES.timeWindow) blockAll(gcode, PRIORITIES.timeWindow);
  else if (gcode === BLOCK_CODES.dailyBudget) blockAll(gcode, PRIORITIES.dailyBudget);

  // 4) Site veto — always wins over allowlist.
  const seenDeny = new Set();
  for (const pat of Array.isArray(policy.deny) ? policy.deny : []) {
    const h = patternToHost(pat);
    if (h && !seenDeny.has(h)) { seenDeny.add(h); blockHost(h, BLOCK_CODES.siteVeto, PRIORITIES.siteVeto); }
  }

  // 5) Per-site budgets exhausted.
  const seenBudget = new Set();
  for (const sb of Array.isArray(policy.siteBudgets) ? policy.siteBudgets : []) {
    if (sb && sb.minutes != null && sb.minutes > 0 && (Number(sb.used) || 0) >= sb.minutes) {
      const h = patternToHost(sb.pattern);
      if (h && !seenBudget.has(h)) { seenBudget.add(h); blockHost(h, BLOCK_CODES.siteBudget, PRIORITIES.siteBudget); }
    }
  }

  // 6) Allowlist mode: allow the listed sites, block the rest.
  if ((policy.mode || 'unrestricted') === 'allowlist') {
    const seenAllow = new Set();
    for (const pat of Array.isArray(policy.allow) ? policy.allow : []) {
      const h = patternToHost(pat);
      if (h && !seenAllow.has(h)) {
        seenAllow.add(h);
        add({ resourceTypes: MAIN_FRAME, urlFilter: '||' + h }, allowAction(), PRIORITIES.allow);
      }
    }
    blockAll(BLOCK_CODES.allowlistBase, PRIORITIES.allowlistBase);
  }

  return rules;
}

/** Offline fallback: block everything except the local network. */
export function failClosedRules(opts = {}) {
  const lockUrl = typeof opts.lockUrl === 'string' && opts.lockUrl ? opts.lockUrl : null;
  return [
    {
      id: 1, priority: PRIORITIES.failClosed,
      action: blockAction(lockUrl, BLOCK_CODES.failClosed),
      condition: lockUrl
        ? { resourceTypes: MAIN_FRAME, regexFilter: ANY_WEB_REGEX }
        : { resourceTypes: MAIN_FRAME },
    },
    ...LOCAL_REGEXES.map((re, i) => ({
      id: 2 + i, priority: PRIORITIES.local,
      action: allowAction(),
      condition: { resourceTypes: MAIN_FRAME, regexFilter: re },
    })),
  ];
}

/** Last-resort rule: block every web navigation, no lock-page details, no local exemption. */
export function minimalBlockRules() {
  return [{ id: 1, priority: PRIORITIES.master, action: blockAction(null, BLOCK_CODES.failClosed), condition: { resourceTypes: MAIN_FRAME } }];
}

/** Human-readable one-liner per rule (debugging / popup). */
export function describeRules(rules) {
  const names = Object.fromEntries(Object.entries(PRIORITIES).map(([k, v]) => [v, k]));
  return rules.map((r) => {
    const what = r.action.type === 'allow' ? 'allow' : 'block';
    const where = r.condition.urlFilter || r.condition.regexFilter || '*';
    return `${r.id}: ${what} ${where} (${names[r.priority] || r.priority})`;
  });
}
