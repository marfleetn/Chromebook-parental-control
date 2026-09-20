// @chpc/server — request validation. Strict allow-listing: unknown policy
// keys are dropped, every list is bounded, every string is trimmed and
// lowercased where the engine compares lowercase. Errors are `{error, field}`.
import { getHost, stripStars } from '@chpc/core';

export const LIMITS = {
  name: 60,
  listEntries: 500,
  pattern: 253,
  dailyMinutesMax: 24 * 60,
  windows: 14,
  offDays: 400,
  agentId: 100,
  usageSecondsMax: 60 * 60,        // one report may not claim more than an hour
};

export const MODES = ['unrestricted', 'denylist', 'allowlist'];
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const bad = (error, field) => ({ error, field });

/** "Sat", "saturday", "SAT" -> "Sat"; null when not a weekday name. */
export function weekdayName(s) {
  if (typeof s !== 'string') return null;
  const k = s.trim().slice(0, 3).toLowerCase();
  return WEEKDAYS.find((d) => d.toLowerCase() === k) || null;
}

/** Trim/lowercase a site pattern and check it names a host (or "*"). */
export function normalizePattern(raw) {
  if (typeof raw !== 'string') return null;
  const p = raw.trim().toLowerCase();
  if (!p || p.length > LIMITS.pattern) return null;
  if (p === '*') return p;
  const core = stripStars(p);
  if (!core) return null;
  const host = getHost(core);
  if (!host || /\s/.test(host)) return null;
  return p;
}

function checkList(p, key) {
  if (p[key] === undefined) return null;
  if (!Array.isArray(p[key])) return bad(key + ' must be an array of site patterns', key);
  if (p[key].length > LIMITS.listEntries) return bad(key + ` may hold at most ${LIMITS.listEntries} entries`, key);
  const out = [];
  for (const x of p[key]) {
    const n = normalizePattern(x);
    if (!n) return bad(key + ` contains an invalid site pattern: ${JSON.stringify(x).slice(0, 80)}`, key);
    if (!out.includes(n)) out.push(n);
  }
  p[key] = out;
  return null;
}

/**
 * Validate + normalise a policy document. Returns { policy } or { error, field }.
 * Only known keys survive; the stored document is exactly what decide() reads.
 */
export function validatePolicy(body) {
  if (body === undefined || body === null) return { policy: {} };
  if (typeof body !== 'object' || Array.isArray(body)) return bad('policy must be a JSON object', 'body');

  const p = {};
  p.internetAllowed = body.internetAllowed === undefined ? true : body.internetAllowed;
  if (typeof p.internetAllowed !== 'boolean') return bad('internetAllowed must be a boolean', 'internetAllowed');

  p.mode = body.mode === undefined ? 'unrestricted' : body.mode;
  if (!MODES.includes(p.mode)) return bad(`mode must be one of ${MODES.join(', ')}`, 'mode');

  if (body.dailyMinutes !== undefined && body.dailyMinutes !== null && body.dailyMinutes !== '') {
    const n = Number(body.dailyMinutes);
    if (!Number.isInteger(n) || n < 0 || n > LIMITS.dailyMinutesMax) {
      return bad(`dailyMinutes must be a whole number of minutes between 0 and ${LIMITS.dailyMinutesMax}`, 'dailyMinutes');
    }
    p.dailyMinutes = n === 0 ? null : n;   // 0 and blank both mean "no daily limit"
  } else {
    p.dailyMinutes = null;
  }

  for (const key of ['deny', 'allow']) {
    p[key] = body[key];
    const e = checkList(p, key);
    if (e) return e;
    if (p[key] === undefined) p[key] = [];
  }

  p.siteBudgets = [];
  if (body.siteBudgets !== undefined) {
    if (!Array.isArray(body.siteBudgets)) return bad('siteBudgets must be an array', 'siteBudgets');
    if (body.siteBudgets.length > LIMITS.listEntries) return bad('too many siteBudgets', 'siteBudgets');
    for (const sb of body.siteBudgets) {
      if (!sb || typeof sb !== 'object' || Array.isArray(sb)) return bad('siteBudgets entries must be objects', 'siteBudgets');
      const pattern = normalizePattern(sb.pattern);
      if (!pattern || pattern === '*') return bad('siteBudgets entries need a valid site pattern', 'siteBudgets');
      const m = Number(sb.minutes);
      if (!Number.isInteger(m) || m < 1 || m > LIMITS.dailyMinutesMax) {
        return bad(`siteBudgets[*].minutes must be a whole number between 1 and ${LIMITS.dailyMinutesMax}`, 'siteBudgets');
      }
      if (p.siteBudgets.some((x) => x.pattern === pattern)) return bad(`duplicate site budget for ${pattern}`, 'siteBudgets');
      p.siteBudgets.push({ pattern, minutes: m });
    }
  }

  p.windows = [];
  if (body.windows !== undefined) {
    if (!Array.isArray(body.windows)) return bad('windows must be an array', 'windows');
    if (body.windows.length > LIMITS.windows) return bad(`at most ${LIMITS.windows} windows`, 'windows');
    for (const w of body.windows) {
      if (!w || typeof w !== 'object' || Array.isArray(w)) return bad('windows entries must be objects', 'windows');
      if (typeof w.start !== 'string' || !HM_RE.test(w.start.trim())) return bad('windows[*].start must be HH:MM (24h)', 'windows.start');
      if (typeof w.end !== 'string' || !HM_RE.test(w.end.trim())) return bad('windows[*].end must be HH:MM (24h)', 'windows.end');
      const out = { start: pad(w.start.trim()), end: pad(w.end.trim()) };
      if (out.start === out.end) return bad('a window must not start and end at the same time', 'windows');
      if (w.days !== undefined && w.days !== null) {
        if (!Array.isArray(w.days)) return bad('windows[*].days must be an array of weekday names', 'windows.days');
        const days = [];
        for (const d of w.days) {
          const n = weekdayName(d);
          if (!n) return bad(`windows[*].days contains an unknown day: ${JSON.stringify(d).slice(0, 40)}`, 'windows.days');
          if (!days.includes(n)) days.push(n);
        }
        if (days.length === 0) continue;               // a window with no days is a no-op
        if (days.length < 7) out.days = WEEKDAYS.filter((d) => days.includes(d));
      }
      p.windows.push(out);
    }
  }

  p.offDays = [];
  if (body.offDays !== undefined) {
    if (!Array.isArray(body.offDays)) return bad('offDays must be an array', 'offDays');
    if (body.offDays.length > LIMITS.offDays) return bad('too many offDays', 'offDays');
    for (const d of body.offDays) {
      const name = weekdayName(d);
      let v = name;
      if (!v && typeof d === 'string' && ISO_DATE_RE.test(d.trim())) {
        const t = d.trim();
        const parsed = new Date(t + 'T12:00:00Z');
        if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== t) {
          return bad(`offDays contains an impossible date: ${t}`, 'offDays');
        }
        v = t;
      }
      if (!v) return bad(`offDays entries must be weekday names (Mon..Sun) or ISO dates (YYYY-MM-DD): ${JSON.stringify(d).slice(0, 40)}`, 'offDays');
      if (!p.offDays.includes(v)) p.offDays.push(v);
    }
  }

  return { policy: p };
}

function pad(hm) {
  const [h, m] = hm.split(':');
  return h.padStart(2, '0') + ':' + m;
}

/** Child name: trimmed, 1..60 chars, no control characters. */
export function validateName(raw) {
  if (typeof raw !== 'string') return bad('name is required', 'name');
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name) return bad('name is required', 'name');
  if (name.length > LIMITS.name) return bad(`name may be at most ${LIMITS.name} characters`, 'name');
  return { name };
}

/** Optional device label supplied at pairing. */
export function validateAgentId(raw) {
  if (raw === undefined || raw === null || raw === '') return { agentId: 'device' };
  if (typeof raw !== 'string') return bad('agentId must be a string', 'agentId');
  // eslint-disable-next-line no-control-regex
  const a = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, LIMITS.agentId);
  return { agentId: a || 'device' };
}

/** IANA time zone check. */
export function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Positive integer from a query-string value, clamped. */
export function clampInt(v, lo, hi, fb) {
  const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.min(hi, Math.max(lo, n));
}
