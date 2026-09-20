/**
 * @chpc/core — the policy engine.
 *
 * One pure function, `decide()`, answers: "is THIS navigation allowed for THIS
 * kid, at THIS time?" It is the single source of truth: the server uses it to
 * report status and validate, the Chrome extension uses it to actually block
 * before a request is sent. Because it is pure (no I/O, no `Date.now()`), the
 * exact same JS runs in Node and in the extension with identical results.
 *
 * --- Policy shape (per child) ---------------------------------------------
 * policy = {
 *   internetAllowed: boolean,      // master internet switch
 *   windows: [{days:[..], start:"HH:MM", end:"HH:MM"}, ..] , // allowed hours ({} = always)
 *   offDays: [ "2026-09-21" | "Sat", .. ],                  // scheduled off days
 *   dailyMinutes: number|null,      // total internet budget/day (mins) — null = none
 *   usageToday: number,             // minutes already used today
 *   mode: "unrestricted" | "allowlist" | "denylist",
 *   allow: ["youtube.com", "khanacademy.org", ..],          // for allowlist mode
 *   deny:  ["tiktok.com", ..],        // veto — wins over allow
 *   siteBudgets: [{pattern:"youtube.com", minutes:30, used:12}, ..],
 * }
 *
 * --- Decision shape --------------------------------------------------------
 * decide(...) -> {
 *   allowed: boolean,
 *   code:    "ok"|"non-web"|"disabled"|"off-day"|"off-hours"
 *          |"daily-budget"|"site-denied"|"site-budget"|"not-allowed",
 *   reason:  human sentence (UI-ready),
 *   host:    normalised hostname|null,
 * }
 */
import { localClock, inWindow, dayAllowed, isOffDay, parseHM } from './time.js';
import { getHost, ruleMatchesHost, isLocalHost } from './site.js';
export { localClock, inWindow, dayAllowed, isOffDay, parseHM } from './time.js';
export { getHost, ruleMatchesHost, isLocalHost } from './site.js';

const DAY_WINDOW_EMPTY = (w) => {
  if (!w) return true;
  if (w.days && w.days.length && !Array.isArray(w.days)) return true;
  return !(parseHM(w.start) != null && parseHM(w.end) != null);
};

/**
 * Evaluate a navigation against a child's policy.
 *
 * @param {object} policy   per-child policy (see top of file)
 * @param {string} urlOrHost full URL or bare hostname to test
 * @param {object} [opts]   { now: ms epoch, tz: "Europe/London" }
 * @returns decision object
 */
export function decide(policy, urlOrHost, opts = {}) {
  policy = policy || {};
  const now = opts.now != null ? opts.now : Date.now();
  const tz = opts.tz || 'UTC';
  const host = getHost(urlOrHost);

  // Non-web schemes (chrome://, data:, mailto:, about:) — not internet nav.
  // The extension applies its own stricter handling for these.
  if (host === null) {
    return { allowed: true, code: 'non-web', reason: 'Not a web navigation.', host: null };
  }

  // Local network / device addresses bypass web policy by design.
  if (isLocalHost(host)) {
    return { allowed: true, code: 'ok', reason: 'Local device / network.', host };
  }

  const clock = localClock(now, tz);

  // 1) Master internet switch.
  if (policy.internetAllowed === false) {
    return { allowed: false, code: 'disabled', reason: 'Internet is switched off for this child.', host };
  }

  // 2) Scheduled off days (holidays, exam days, "Saturday is TV day").
  if (policy.offDays && policy.offDays.length && isOffDay(clock.date, policy.offDays)) {
    return { allowed: false, code: 'off-day', reason: 'Today is a scheduled break — no internet.', host };
  }

  // 3) Time-of-day windows. Empty/missing windows = always allowed.
  const windows = Array.isArray(policy.windows) ? policy.windows : [];
  const windowsConfigured = windows.some(w => !DAY_WINDOW_EMPTY(w));
  if (windowsConfigured) {
    const inside = windows.some(w =>
      !DAY_WINDOW_EMPTY(w) && dayAllowed(clock.dow, w.days) && inWindow(clock.minsOfDay, w.start, w.end)
    );
    if (!inside) {
      return { allowed: false, code: 'off-hours', reason: "It's outside this child's allowed internet hours.", host };
    }
  }

  // 4) Daily total budget (across all sites).
  if (policy.dailyMinutes != null && policy.dailyMinutes > 0) {
    const used = Number(policy.usageToday) || 0;
    if (used >= policy.dailyMinutes) {
      return {
        allowed: false, code: 'daily-budget',
        reason: `Daily internet time (${policy.dailyMinutes} min) is used up. Try again tomorrow.`, host,
        remaining: 0,
      };
    }
  }

  // 5) Site veto — always wins, in any mode.
  const deny = policy.deny || [];
  if (deny.some((p) => ruleMatchesHost(p, host))) {
    return { allowed: false, code: 'site-denied', reason: 'This site is blocked for this child.', host };
  }

  // 6) Per-site budget.
  if (Array.isArray(policy.siteBudgets)) {
    for (const sb of policy.siteBudgets) {
      if (sb && sb.minutes != null && sb.minutes > 0 && ruleMatchesHost(sb.pattern, host)) {
        const used = Number(sb.used) || 0;
        if (used >= sb.minutes) {
          return {
            allowed: false, code: 'site-budget',
            reason: `Time limit for ${host} (${sb.minutes} min) is used up for today.`, host,
            remaining: 0, pattern: sb.pattern,
          };
        }
      }
    }
  }

  // 7) Allowlist mode: must be explicitly on the allow list.
  const mode = policy.mode || 'unrestricted';
  if (mode === 'allowlist') {
    const allow = policy.allow || [];
    if (!allow.some((p) => ruleMatchesHost(p, host))) {
      return { allowed: false, code: 'not-allowed', reason: 'This site is not in the approved list.', host };
    }
  }

  // 8) Fall through: allowed.
  return { allowed: true, code: 'ok', reason: 'OK.', host };
}

/**
 * Summarise a child's remaining daily budget (for UIs).
 * Returns null when there is no daily budget set.
 */
export function remainingDaily(policy = {}) {
  if (policy.dailyMinutes == null || policy.dailyMinutes <= 0) return null;
  const used = Math.max(0, Number(policy.usageToday) || 0);
  return Math.max(0, policy.dailyMinutes - used);
}

/** Convenience: is the master switch on? (treats missing as on) */
export function internetOn(policy = {}) {
  return policy.internetAllowed !== false;
}
