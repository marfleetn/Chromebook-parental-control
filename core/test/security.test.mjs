// @chpc/core — security invariants of the rule engine.
//
// The engine runs on the child's device against a policy fetched from the
// network and hostnames chosen by the child. These tests prove that no input
// can make it fail open, hang, or produce rules Chrome would reject.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, applyPendingUsage } from '../src/policy.js';
import { getHost, ruleMatchesHost, isLocalHost } from '../src/site.js';
import { buildDnrRules, failClosedRules, minimalBlockRules, patternToHost, PRIORITIES } from '../src/rules.js';

const O = { at: Date.parse('2026-09-18T18:00:00Z'), tz: 'Europe/London' };
const covers = (cond, url) => cond.regexFilter ? new RegExp(cond.regexFilter).test(url)
  : cond.urlFilter ? (() => { const h = new URL(url).hostname, f = cond.urlFilter.slice(2); return h === f || h.endsWith('.' + f); })() : true;
const winner = (rules, url) => rules.filter((r) => covers(r.condition, url)).sort((a, b) => b.priority - a.priority)[0];
const blocked = (rules, url) => { const w = winner(rules, url); return !!w && w.action.type === 'redirect'; };

const GARBAGE = [null, undefined, 0, 1, '', 'policy', [], [1, 2], () => {}, Symbol.for('x'), 1e308, NaN, true,
  { internetAllowed: 'false' }, { internetAllowed: 0 }, { mode: 'allowlist', allow: 'everything' }, { deny: 'tiktok.com' },
  { deny: [null, 1, {}, [], ''] }, { windows: {} }, { windows: [{}] }, { siteBudgets: 'x' }, { offDays: 'Sat' },
  { dailyMinutes: 'a lot', usageToday: 'none' }, { dailyMinutes: -1 }, { usageToday: Infinity, dailyMinutes: 10 },
  JSON.parse('{"__proto__":{"internetAllowed":true},"mode":"allowlist","allow":[]}')];

test('SEC engine: garbage policies never crash and never produce an "allow everything" rule set', () => {
  for (const g of GARBAGE) {
    let rules;
    assert.doesNotThrow(() => { rules = buildDnrRules(g, O); }, 'buildDnrRules threw on ' + String(g));
    assert.ok(Array.isArray(rules));
    const allowAll = rules.some((r) => r.action.type === 'allow' && !r.condition.urlFilter && !r.condition.regexFilter);
    assert.ok(!allowAll, 'an unconditional allow rule was generated for ' + JSON.stringify(g));
    assert.doesNotThrow(() => decide(g, 'https://example.com/', { now: O.at, tz: O.tz }));
    assert.doesNotThrow(() => applyPendingUsage(g, { 'a.com': 60 }));
  }
});

test('SEC engine: non-object policies fail closed (block all), objects default to the documented semantics', () => {
  for (const g of [null, undefined, 0, '', 'x', 42, true]) {
    const rules = buildDnrRules(g, O);
    assert.ok(blocked(rules, 'https://example.com/'), 'fail-closed for ' + String(g));
  }
  assert.ok(blocked(failClosedRules(), 'https://example.com/'));
  assert.ok(!blocked(failClosedRules(), 'http://192.168.1.1/'), 'fail-closed keeps the home network reachable');
  assert.ok(blocked(minimalBlockRules(), 'http://192.168.1.1/'), 'the last-resort set blocks everything');
});

test('SEC engine: the master switch cannot be undone by any other field', () => {
  const p = { internetAllowed: false, mode: 'allowlist', allow: ['*', 'example.com'], deny: [], windows: [], offDays: [], dailyMinutes: null };
  const rules = buildDnrRules(p, O);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].priority, PRIORITIES.master);
  for (const u of ['https://example.com/', 'http://192.168.1.1/', 'http://localhost:4100/', 'https://x.local/']) assert.ok(blocked(rules, u), u);
  assert.equal(decide(p, 'http://192.168.1.1/', { now: O.at, tz: O.tz }).code, 'ok', 'decide() exempts local before the switch — documented and mirrored by the extension');
});

test('SEC engine: deny always beats allow, whatever the order or casing', () => {
  const p = { mode: 'allowlist', allow: ['TikTok.com', '*.tiktok.com', 'tiktok.com*'], deny: ['tiktok.com'] };
  const rules = buildDnrRules(p, { ...O, lockUrl: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/pages/blocked.html' });
  for (const u of ['https://tiktok.com/', 'https://www.tiktok.com/@x', 'https://TIKTOK.COM/'.toLowerCase(), 'https://m.tiktok.com:443/x']) assert.ok(blocked(rules, u), u);
  assert.equal(decide(p, 'https://m.tiktok.com/', { now: O.at, tz: O.tz }).code, 'site-denied');
});

test('SEC engine: hostname matching has no lookalike or suffix leaks', () => {
  const cases = [
    ['tiktok.com', 'nottiktok.com', false], ['tiktok.com', 'tiktok.com.evil.net', false], ['tiktok.com', 'tiktok.co', false],
    ['tiktok.com', 'tiktok.com', true], ['tiktok.com', 'a.b.tiktok.com', true], ['co.uk', 'bbc.co.uk', true],
    ['*.tiktok.com', 'tiktok.com', true], ['tiktok.com', 'xn--tiktok-abc.com', false], ['tiktok.com', 'tiktok.com%2Eevil.net', false],
  ];
  for (const [pat, host, want] of cases) assert.equal(ruleMatchesHost(pat, host), want, `${pat} vs ${host}`);
  // A tracking-pixel style host cannot be made "local" to dodge rules.
  for (const h of ['192.168.1.1.evil.com', 'localhost.evil.com', 'local.evil.com', '10.0.0.1.nip.io', 'evil.com.local.', 'xlocal']) {
    assert.equal(isLocalHost(h), false, h);
  }
  for (const h of ['192.168.1.1', '10.0.0.1', '172.16.0.1', 'printer.local', 'localhost']) assert.equal(isLocalHost(h), true, h);
});

test('SEC engine: getHost refuses non-web schemes and oddities instead of mis-parsing them', () => {
  for (const s of ['javascript:alert(1)', 'data:text/html,<b>', 'chrome://settings', 'chrome-extension://abc/x', 'file:///etc/passwd',
                   'mailto:a@b.com', 'about:blank', 'blob:https://x.com/uuid', 'ftp://x.com/', '   ', 'http://', 'http:///x', '//x.com\\@evil.com']) {
    const h = getHost(s);
    assert.ok(h === null || !/evil/.test(h), `${s} -> ${h}`);
    if (/^(javascript|data|chrome|chrome-extension|file|mailto|about|blob|ftp):/.test(s)) assert.equal(h, null, s);
  }
  assert.equal(getHost('https://user:pass@evil.com@good.com/'), 'good.com', 'userinfo cannot spoof the host');
  assert.equal(patternToHost('javascript:alert(1)'), null);
  assert.equal(patternToHost('http://127.0.0.1:4100'), null, 'the console address is never block-listable');
});

test('SEC engine: every generated regex is safe against hostile URLs (no catastrophic backtracking)', () => {
  const lock = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/pages/blocked.html';
  const policy = {
    mode: 'allowlist', allow: ['a.com'],
    deny: ['tiktok.com', 'x'.repeat(240) + '.com', 'a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p.q.r.s.t.u.v.w.x.y.z.com'],
    siteBudgets: [{ pattern: 'youtube.com', minutes: 1, used: 5 }],
    windows: [{ start: '08:00', end: '09:00' }],
  };
  const rules = buildDnrRules(policy, { ...O, lockUrl: lock });
  const hostile = [
    'https://' + 'a.'.repeat(5000) + 'tiktok.com/',
    'https://' + 'a'.repeat(20000) + '/',
    'https://tiktok.com/' + '/'.repeat(20000),
    'https://' + '.'.repeat(10000) + '/',
    'https://tiktok.com:' + '9'.repeat(10000) + '/',
    'http://' + 'x'.repeat(240) + '.com' + '?'.repeat(10000),
  ];
  for (const r of rules) {
    if (!r.condition.regexFilter) continue;
    const re = new RegExp(r.condition.regexFilter);
    for (const u of hostile) {
      const t0 = process.hrtime.bigint();
      re.test(u);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.ok(ms < 50, `regex ${r.condition.regexFilter.slice(0, 60)}… took ${ms.toFixed(1)}ms on hostile input`);
    }
    assert.ok(r.condition.regexFilter.length < 400, 'regex within Chrome budget proxy');
  }
});

test('SEC engine: decide() is pure — same inputs, same answer, inputs untouched', () => {
  const policy = Object.freeze({ mode: 'allowlist', allow: Object.freeze(['a.com']), deny: Object.freeze(['b.com']), dailyMinutes: 10, usageToday: 2 });
  const a = decide(policy, 'https://a.com/x', { now: O.at, tz: O.tz });
  const b = decide(policy, 'https://a.com/x', { now: O.at, tz: O.tz });
  assert.deepEqual(a, b);
  assert.deepEqual(buildDnrRules(policy, O), buildDnrRules(policy, O));
  const snapshot = JSON.stringify(policy);
  applyPendingUsage(policy, { 'a.com': 600 });
  assert.equal(JSON.stringify(policy), snapshot, 'frozen policy not mutated');
});

test('SEC engine: lock-page URL is embedded verbatim and only once per rule', () => {
  const lock = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/pages/blocked.html';
  const rules = buildDnrRules({ deny: ['a.com'], internetAllowed: true, mode: 'allowlist', allow: [] }, { ...O, lockUrl: lock });
  for (const r of rules.filter((r) => r.action.type === 'redirect')) {
    const sub = r.action.redirect.regexSubstitution;
    assert.ok(sub.startsWith(lock + '?code='), sub);
    assert.equal((sub.match(/chrome-extension:/g) || []).length, 1);
    assert.ok(!/[\s"'<>]/.test(sub), 'no injectable characters in the redirect target');
  }
});
