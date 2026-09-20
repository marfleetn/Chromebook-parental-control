import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDnrRules, failClosedRules, patternToUrlFilter } from '../src/rules.js';

// Fixed instant so time-window rules are deterministic.
const AT = 1758000000000;
const TZ = 'Europe/London';
const O = { at: AT, tz: TZ };

// Does a rule's condition cover `host` or any of its subdomains?
function coversHost(cond, host) {
  for (const d of cond.domains || []) {
    if (d === host || host.endsWith('.' + d)) return true;
  }
  const f = cond.urlFilter || '';
  if (f.startsWith('||')) {
    const h = f.slice(2);
    if (f.indexOf('||', 2) === -1 && (host === h || host.endsWith('.' + h))) return true;
  }
  if (f === 'http*' || f === 'https*') return true; // catch-all rule
  if (cond.regexFilter) return false; // matched via private-net regex elsewhere
  return false;
}
function blocksFor(rules, host) {
  return rules.filter(
    (r) => r.action.type === 'redirect' && coversHost(r.condition, host)
  );
}
function allowsFor(rules, host) {
  return rules.filter(
    (r) => r.action.type === 'allow' && coversHost(r.condition, host)
  );
}

// --- patternToUrlFilter -----------------------------------------------------
test('patternToUrlFilter: bare domain -> ||domain (self+subdomains)', () => {
  assert.equal(patternToUrlFilter('youtube.com'), '||youtube.com');
});
test('patternToUrlFilter: *.example.com -> ||example.com', () => {
  assert.equal(patternToUrlFilter('*.example.com'), '||example.com');
});
test('patternToUrlFilter: "*" and empty -> null (handled by baseline)', () => {
  assert.equal(patternToUrlFilter('*'), null);
  assert.equal(patternToUrlFilter(''), null);
});
test('patternToUrlFilter: local host -> null (covered by local rule)', () => {
  assert.equal(patternToUrlFilter('localhost'), null);
  assert.equal(patternToUrlFilter('192.168.1.1'), null);
});

// --- master switch ----------------------------------------------------------
test('master OFF -> single block-all rule, nothing else', () => {
  const rules = buildDnrRules({ internetAllowed: false, deny: ['a.com'] }, O);
  const blocks = rules.filter((r) => r.action.type === 'redirect');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].priority, 4000);
});

// --- local network always allowed ------------------------------------------
test('local-address allow rule always present when master is on', () => {
  const rules = buildDnrRules({ deny: ['a.com'] }, O);
  assert.ok(rules.some((r) => r.action.type === 'allow' && r.condition.regexFilter));
});

// --- site deny (veto) -------------------------------------------------------
test('deny list -> redirect-to-lock rule per site', () => {
  const rules = buildDnrRules({ deny: ['tiktok.com'] }, O);
  const t = blocksFor(rules, 'tiktok.com');
  assert.equal(t.length, 1);
  assert.equal(t[0].priority, 3000);
  assert.equal(t[0].action.redirect.extensionPath, 'pages/blocked.html');
});

// --- time windows -----------------------------------------------------------
test('window on some days -> off-hour block rules carry dayOfWeek + time bounds', () => {
  const rules = buildDnrRules(
    { windows: [{ days: ['Mon', 'Wed'], start: '08:00', end: '17:00' }] }, O);
  const off = rules.filter(
    (r) => r.action.type === 'redirect' && r.condition.timeOfDayStart
      && r.condition.timeOfDayStart.h === 0
  );
  // Outside 08:00-17:00 on Mon/Wed is blocked in two bands: 00:00-08:00 and 17:00-24:00
  const monBands = rules.filter((r) => {
    const c = r.condition;
    return c.dayOfWeek && c.dayOfWeek.includes('MONDAY') && r.action.type === 'redirect'
      && c.timeOfDayStart && c.timeOfDayEnd;
  });
  assert.ok(monBands.length >= 2, 'expected >=2 Mon off-hours bands, got ' + monBands.length);
});

// --- off days ---------------------------------------------------------------
test('weekday-name off day -> full-day block rule with that weekday', () => {
  const rules = buildDnrRules({ offDays: ['Saturday'] }, O);
  const sat = rules.filter(
    (r) => r.action.type === 'redirect'
      && (r.condition.dayOfWeek || []).includes('SATURDAY')
      && !r.condition.timeOfDayStart
  );
  assert.ok(sat.length >= 1, 'expected a full Saturday block rule');
});

// --- daily budget exhausted -------------------------------------------------
test('daily budget exhausted -> block-all budget rule', () => {
  const rules = buildDnrRules({ dailyMinutes: 60, usageToday: 60 }, O);
  assert.ok(rules.some((r) => r.action.type === 'redirect' && r.priority === 3800));
});
test('daily budget not exhausted -> no budget rule', () => {
  const rules = buildDnrRules({ dailyMinutes: 60, usageToday: 10 }, O);
  assert.ok(!rules.some((r) => r.priority === 3800));
});

// --- per-site budget --------------------------------------------------------
test('per-site budget exhausted -> redirect rule at site-budget priority', () => {
  const rules = buildDnrRules(
    { siteBudgets: [{ pattern: 'youtube.com', minutes: 30, used: 45 }] }, O);
  assert.ok(rules.some((r) => r.action.type === 'redirect' && r.priority === 2500));
});

// --- allowlist mode ---------------------------------------------------------
test('allowlist mode -> allow per listed site + baseline block-everything-else', () => {
  const rules = buildDnrRules(
    { mode: 'allowlist', allow: ['khanacademy.org', 'youtube.com'] }, O);
  assert.ok(allowsFor(rules, 'khanacademy.org').length === 1);
  assert.ok(allowsFor(rules, 'youtube.com').length === 1);
  const baseline = rules.find((r) => r.action.type === 'redirect' && r.priority === 1000);
  assert.ok(baseline, 'expected the allowlist baseline block rule');
});

// --- fail-closed ------------------------------------------------------------
test('failClosedRules -> block-all plus local allow', () => {
  const rules = failClosedRules();
  assert.ok(rules.some((r) => r.action.type === 'redirect' && r.priority === 4000));
  assert.ok(rules.some((r) => r.action.type === 'allow'));
});
test('unparseable policy (null/number) -> single fail-closed block rule', () => {
  const a = buildDnrRules(null, O);
  const b = buildDnrRules(42, O);
  assert.equal(a.length, 1);
  assert.equal(a[0].action.type, 'redirect');
  assert.equal(b.length, 1);
});

// --- invariants -------------------------------------------------------------
test('rule ids are unique in the full set', () => {
  const rules = buildDnrRules(
    {
      windows: [{ days: ['Mon'], start: '08:00', end: '17:00' }],
      offDays: ['Saturday'],
      dailyMinutes: 10, usageToday: 20,
      deny: ['a.com', 'b.org'],
      siteBudgets: [{ pattern: 'c.net', minutes: 5, used: 9 }],
      mode: 'allowlist', allow: ['d.com'],
    }, O);
  const ids = rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});
test('deterministic across runs', () => {
  const p = { windows: [{ days: ['Mon'], start: '08:00', end: '17:00' }], deny: ['a.com'] };
  assert.deepEqual(buildDnrRules(p, O), buildDnrRules(p, O));
});
