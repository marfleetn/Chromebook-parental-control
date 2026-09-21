import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, inWindow, parseHM, remainingDaily } from '../src/policy.js';
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
