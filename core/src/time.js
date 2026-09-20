/**
 * @chpc/core — time helpers.
 *
 * Everything here is deterministic and pure (no `Date.now()` calls) so the
 * same logic tests identically on server and inside the extension. Callers
 * pass an explicit `now` (ms epoch) and a `tz` (IANA zone) each time.
 */

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Parse "HH:MM" (24h) to minutes past midnight. null on invalid. */
export function parseHM(s) {
  if (typeof s !== 'string') return null;
  const m = TIME_RE.exec(s.trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** Format minutes past midnight -> "HH:MM". */
export function fmtHM(mins) {
  mins = ((Math.floor(mins) % 1440) + 1440) % 1440;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/**
 * Get the local wall-clock components for a given epoch-ms in an IANA tz.
 * Returns {date:'YYYY-MM-DD', d:1..31, mo:0..11, dow:0..6 (Sun=0), hour, min, minsOfDay, ts}.
 */
export function localClock(ts, tz = 'UTC') {
  const d = new Date(ts);
  // Pull date and time with two separate calls. A single combined
  // toLocaleString produces an ICU/locale-dependent separator (comma, double
  // space, etc.) that is fragile to split on. Both of these forms are stable
  // across en-GB ICU builds: "25/08/2026" and "15:00".
  const dateRaw = d.toLocaleString('en-GB', {
    timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric',
  });
  const timeRaw = d.toLocaleTimeString('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const dowName = d.toLocaleDateString('en-GB', { timeZone: tz, weekday: 'short' });
  const [dd, mm, yyyy] = dateRaw.split('/').map(Number); // en-GB -> DD/MM/YYYY
  const [hh, mi] = timeRaw.split(':').map(Number);
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`,
    d: dd, mo: mm - 1, dow: dowMap[dowName], hour: hh, min: mi,
    minsOfDay: hh * 60 + mi, ts,
  };
}

/**
 * Is `minsOfDay` (local) inside window "start-HH:MM".."end-HH:MM"?
 * Window is inclusive on start, exclusive on end. A window that wraps over
 * midnight (end <= start, e.g. 20:00-02:00) is honoured.
 */
export function inWindow(minsOfDay, start, end) {
  const s = parseHM(start);
  const e = parseHM(end);
  if (s === null || e === null) return false;
  if (s < e) return minsOfDay >= s && minsOfDay < e;
  // wraps midnight
  return minsOfDay >= s || minsOfDay < e;
}

/** True when the weekday (0=Sun) is allowed by a list of "Mon".."Sun" names. Empty/undefined = all days. */
export function dayAllowed(dow, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  const names = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return allowed.includes(names[dow]);
}

/** True when today (date string "YYYY-MM-DD") is a listed "off day". */
export function isOffDay(date, offDays) {
  if (!Array.isArray(offDays)) return false;
  // offDays may be ISO dates ("2026-09-21") or weekday names ("Sat").
  if (offDays.includes(date)) return true;
  const names = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const d = new Date(date + 'T12:00:00Z');
  const dow = d.getUTCDay();
  return offDays.some(x => names[x] === dow);
}
