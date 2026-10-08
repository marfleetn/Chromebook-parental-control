import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, inWindow, parseHM, remainingDaily, applyPendingUsage, internetOn } from '../src/policy.js';
import { localClock, fmtHM, dayAllowed, isOffDay } from '../src/time.js';
import { getHost, ruleMatchesHost, stripStars } from '../src/site.js';

// Fixed "now": 2026-09-18 (a Friday) 21:30 in Europe/London.
const LONDON_2130 = Date.parse('2026-09-18T21:30:00Z'); // 22:30 BST local
const LONDON_1900 = Date.parse('2026-09-18T18:00:00Z'); // 19:00 local, Friday

test('parseHM', () => {
  assert.equal(parseHM('08:00'), 480);
  assert.equal(parseHM('23:59'), 1439);
  assert.equal(parseHM('9:5'), null);
  assert.equal(parseHM('24:00'), null);
});

test('inWindow basic + wrap-midnight', () => {
  assert.ok(inWindow(480, '08:00', '17:00'));        // 08:00 start, inclusive
  assert.ok(!inWindow(1020, '08:00', '17:00'));     // 17:00 end, exclusive
  assert.ok(inWindow(1350, '20:00', '02:00'));      // 22:30 within 20:00-02:00
  assert.ok(inWindow(119, '20:00', '02:00'));       // 01:59 just inside wrap
  assert.ok(!inWindow(120, '20:00', '02:00'));      // 02:00 end, exclusive (start-incl/end-excl)
  assert.ok(!inWindow(720, '20:00', '02:00'));      // 12:00 not inside
});

test('master switch off wins over everything', () => {
  const d = decide({ internetAllowed: false }, 'https://youtube.com', { now: LONDON_1900, tz: 'Europe/London' });
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'disabled');
});

test('off-hours blocks outside window', () => {
  const policy = { internetAllowed: true, windows: [{ days: ['Fri'], start: '08:00', end: '17:00' }] };
  const out = decide(policy, 'https://example.com', { now: LONDON_2130, tz: 'Europe/London' });
  assert.equal(out.allowed, false);
  assert.equal(out.code, 'off-hours');
  const inw = decide(policy, 'https://example.com', { now: LONDON_1900 - 3 * 3600e3, tz: 'Europe/London' }); // 15:00 local, inside 08:00-17:00
  assert.equal(inw.allowed, true);
});

test('off-day block (weekday name)', () => {
  const policy = { internetAllowed: true, offDays: ['Fri'] };
  const d = decide(policy, 'https://example.com', { now: LONDON_1900, tz: 'Europe/London' });
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'off-day');
});

test('daily budget exhausted', () => {
  const policy = { dailyMinutes: 60, usageToday: 61, mode: 'unrestricted', allow: [] };
  const d = decide(policy, 'https://example.com', { now: LONDON_1900, tz: 'Europe/London' });
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'daily-budget');
});

test('site deny beats everything (even allowlist)', () => {
  const policy = { mode: 'allowlist', allow: ['tiktok.com'], deny: ['tiktok.com*'] };
  const d = decide(policy, 'https://www.tiktok.com/@x', { now: LONDON_1900, tz: 'Europe/London' });
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'site-denied');
});

test('allowlist: matches subdomain, rejects others', () => {
  const policy = { mode: 'allowlist', allow: ['youtube.com', 'khanacademy.org'], deny: [] };
  assert.equal(decide(policy, 'https://m.youtube.com/watch', { now: LONDON_1900, tz: 'Europe/London' }).allowed, true);
  assert.equal(decide(policy, 'https://khanacademy.org/math', { now: LONDON_1900, tz: 'Europe/London' }).allowed, true);
  const no = decide(policy, 'https://twitter.com/x', { now: LONDON_1900, tz: 'Europe/London' });
  assert.equal(no.allowed, false);
  assert.equal(no.code, 'not-allowed');
});

test('per-site budget', () => {
  const policy = {
    mode: 'unrestricted',
    siteBudgets: [{ pattern: 'youtube.com', minutes: 30, used: 30 }],
  };
  const yt = decide(policy, 'https://www.youtube.com/x', { now: LONDON_1900, tz: 'Europe/London' });
  assert.equal(yt.allowed, false);
  assert.equal(yt.code, 'site-budget');
});

test('local network bypasses web policy', () => {
  const policy = { internetAllowed: true, mode: 'allowlist', allow: [], deny: [] };
  assert.equal(decide(policy, 'http://192.168.1.50', { now: LONDON_1900, tz: 'Europe/London' }).allowed, true);
  assert.equal(decide(policy, 'http://172.18.0.5', { now: LONDON_1900, tz: 'Europe/London' }).allowed, true);
  assert.equal(decide(policy, 'http://printer.lan', { now: LONDON_1900, tz: 'Europe/London' }).allowed, true);
});

test('non-web schemes short-circuit as non-web (allowed by default)', () => {
  const policy = { mode: 'allowlist', allow: [] };
  const r = decide(policy, 'chrome://settings', { now: LONDON_1900, tz: 'Europe/London' });
  assert.equal(r.code, 'non-web');
  const r2 = decide(policy, 'mailto:nick@example.com', { now: LONDON_1900, tz: 'Europe/London' });
  assert.equal(r2.code, 'non-web');
});

test('remainingDaily', () => {
  assert.equal(remainingDaily({ dailyMinutes: 60, usageToday: 20 }), 40);
  assert.equal(remainingDaily({ dailyMinutes: 60, usageToday: 80 }), 0);
  assert.equal(remainingDaily({ dailyMinutes: null }), null);
});

test('getHost + ruleMatchesHost', () => {
  assert.equal(getHost('HTTPS://WWW.EXAMPLE.COM:8443/path?q=1'), 'www.example.com');
  assert.equal(getHost('example.com'), 'example.com');
  assert.equal(getHost('not a url at all'), null);
  assert.ok(ruleMatchesHost('example.com', 'www.example.com'));
  assert.ok(ruleMatchesHost('example.com', 'example.com'));
  assert.ok(!ruleMatchesHost('example.com', 'notexample.com'));
  assert.ok(ruleMatchesHost('*.example.com', 'a.example.com'));
  assert.ok(ruleMatchesHost('*', 'anything.example'));
});

test('stripStars removes glob stars in linear time, no regex', () => {
  assert.equal(stripStars('youtube.com'), 'youtube.com');
  assert.equal(stripStars('*.example.com'), 'example.com');
  assert.equal(stripStars('tiktok.com*'), 'tiktok.com');
  assert.equal(stripStars('**.a.b**'), 'a.b');
  assert.equal(stripStars('.a.b'), '.a.b', 'a dot without leading stars is kept');
  assert.equal(stripStars('*'), '');
  assert.equal(stripStars(''), '');
  const hostile = '*'.repeat(200000) + '.' + '*'.repeat(200000);
  const t0 = Date.now();
  assert.equal(stripStars(hostile), '');
  assert.ok(Date.now() - t0 < 200, 'hostile input handled quickly');
});

test('applyPendingUsage folds offline minutes into daily and per-site budgets', () => {
  const policy = { dailyMinutes: 60, usageToday: 10, siteBudgets: [{ pattern: 'youtube.com', minutes: 30, used: 5 }, { pattern: 'bbc.co.uk', minutes: 30 }] };
  const out = applyPendingUsage(policy, { 'm.youtube.com': 600, 'news.bbc.co.uk': 60, 'other.com': 60, junk: -5, '': 99 });
  assert.equal(out.usageToday, 22, '10 + 12 minutes');
  assert.equal(out.siteBudgets[0].used, 15, 'youtube subdomain counts toward the youtube budget');
  assert.equal(out.siteBudgets[1].used, 1);
  assert.equal(policy.usageToday, 10, 'input not mutated');
  assert.equal(policy.siteBudgets[0].used, 5);
  // Offline budget exhaustion is visible to decide()
  const now = LONDON_1900, tz = 'Europe/London';
  assert.equal(decide(applyPendingUsage({ dailyMinutes: 60, usageToday: 59 }, { 'x.com': 120 }), 'https://x.com', { now, tz }).code, 'daily-budget');
  assert.deepEqual(applyPendingUsage({ a: 1 }, null), { a: 1 });
  assert.deepEqual(applyPendingUsage({ a: 1 }, {}), { a: 1 });
  assert.equal(applyPendingUsage(null, { 'x.com': 60 }), null);
});

test('internetOn / fmtHM / dayAllowed / isOffDay helpers', () => {
  assert.equal(internetOn({}), true);
  assert.equal(internetOn({ internetAllowed: false }), false);
  assert.equal(fmtHM(0), '00:00');
  assert.equal(fmtHM(1439), '23:59');
  assert.equal(fmtHM(1500), '01:00', 'wraps past midnight');
  assert.equal(fmtHM(-60), '23:00', 'negative wraps backwards');
  assert.equal(dayAllowed(0, undefined), true);
  assert.equal(dayAllowed(0, ['Sun']), true);
  assert.equal(dayAllowed(1, ['Sun']), false);
  assert.equal(isOffDay('2026-09-19', 'not-an-array'), false);
});

test('localClock handles the Europe/London DST change (25 Oct 2026, clocks go back)', () => {
  // 00:30 UTC on 25 Oct = 01:30 BST (still summer time)
  const before = localClock(Date.parse('2026-10-25T00:30:00Z'), 'Europe/London');
  assert.equal(before.hour, 1); assert.equal(before.min, 30); assert.equal(before.date, '2026-10-25'); assert.equal(before.dow, 0);
  // 01:30 UTC on 25 Oct = 01:30 GMT (the repeated hour)
  const after = localClock(Date.parse('2026-10-25T01:30:00Z'), 'Europe/London');
  assert.equal(after.hour, 1); assert.equal(after.min, 30);
  // A window 20:00-07:00 still covers both instants
  const p = { windows: [{ start: '20:00', end: '07:00' }] };
  for (const ms of [Date.parse('2026-10-25T00:30:00Z'), Date.parse('2026-10-25T01:30:00Z'), Date.parse('2026-10-25T06:59:00Z')]) {
    assert.equal(decide(p, 'https://x.com', { now: ms, tz: 'Europe/London' }).allowed, true, new Date(ms).toISOString());
  }
  // 07:00 GMT = 07:00 UTC -> outside
  assert.equal(decide(p, 'https://x.com', { now: Date.parse('2026-10-25T07:00:00Z'), tz: 'Europe/London' }).code, 'off-hours');
  // Day boundary follows the zone, not UTC: 23:30 UTC on 24 Oct is already 00:30 on 25 Oct in London
  assert.equal(localClock(Date.parse('2026-10-24T23:30:00Z'), 'Europe/London').date, '2026-10-25');
  assert.equal(localClock(Date.parse('2026-10-24T23:30:00Z'), 'UTC').date, '2026-10-24');
});

test('decide: windows with junk entries and non-array days do not crash', () => {
  const p = { windows: [null, 'x', { days: 'Mon', start: '08:00', end: '09:00' }, { start: 'bad' }] };
  const r = decide(p, 'https://x.com', { now: LONDON_1900, tz: 'Europe/London' });
  assert.ok(['ok', 'off-hours'].includes(r.code));
});
