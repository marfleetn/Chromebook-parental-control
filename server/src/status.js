// @chpc/server — status layer.
// Joins stored policy + live usage into the exact shape decide() expects:
//   policy.usageToday            -> minutes used so far today
//   policy.siteBudgets[i].used   -> minutes used on that pattern today
// Storage holds SECONDS (db.js); the engine reads MINUTES. This file is the
// only unit-conversion boundary.

import { remainingDaily, ruleMatchesHost } from '@chpc/core';
import * as dbm from './db.js';

/**
 * Epoch-ms of local midnight for `tz` at time `now`.
 * Locale-free: builds parts with Intl, then Date.parse on an exact ISO string.
 */
export function dayStartMs(now, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(new Date(now))) p[type] = value;
  const localAsUTC = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
  const offset = localAsUTC - new Date(now).setMilliseconds(0); // tz offset at now
  return Date.parse(`${p.year}-${p.month}-${p.day}T00:00:00Z`) + offset;
}

/** Stored policy for a kid, with today's usage injected (minutes). */
export function effectivePolicyForKid(db, kidId, now, tz) {
  const stored = dbm.getPolicy(db, kidId) || {};
  const dayStart = dayStartMs(now, tz);
  const usedSecToday = dbm.kidUsageSinceMs(db, kidId, dayStart);
  const rows = dbm.usageRowsSince(db, kidId, dayStart);

  const secForPattern = (pattern) => {
    let s = 0;
    for (const r of rows) {
      if (r.site && ruleMatchesHost(pattern, r.site)) s += Number(r.seconds) || 0;
    }
    return s;
  };

  // Surface engine defaults in the effective policy so consumers (console UI,
  // extension) can rely on `internetAllowed` and `mode` always being present.
  const p = {
    internetAllowed: true,
    mode: 'unrestricted',
    ...stored,
    usageToday: Math.floor(usedSecToday / 60),
  };
  if (Array.isArray(p.siteBudgets)) {
    p.siteBudgets = p.siteBudgets.map((sb) =>
      sb && typeof sb === 'object' && sb.pattern != null
        ? { ...sb, used: Math.floor(secForPattern(sb.pattern) / 60) }
        : sb
    );
  }
  return p;
}

/** Summary numbers for one kid (all minutes; remainingDailyMin null = unbounded). */
export function kidStatus(db, kidId, now, tz) {
  const eff = effectivePolicyForKid(db, kidId, now, tz);
  return {
    internetAllowed: eff.internetAllowed !== false,
    dailyLimitMin: eff.dailyMinutes != null ? Number(eff.dailyMinutes) : null,
    usedTodayMin: eff.usageToday != null ? Math.floor(Number(eff.usageToday)) : 0,
    remainingDailyMin: remainingDaily(eff),
  };
}
