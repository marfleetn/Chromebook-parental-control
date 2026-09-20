import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDnrRules, failClosedRules, minimalBlockRules, patternToUrlFilter, patternToHost,
  globalBlockCode, PRIORITIES, BLOCK_CODES, describeRules, LOCAL_REGEXES,
} from '../src/rules.js';

// Fixed instants (Europe/London, BST in September 2026).
const TZ = 'Europe/London';
const FRI_1900 = Date.parse('2026-09-18T18:00:00Z'); // Friday 19:00 local
const FRI_2230 = Date.parse('2026-09-18T21:30:00Z'); // Friday 22:30 local
const SAT_1200 = Date.parse('2026-09-19T11:00:00Z'); // Saturday 12:00 local
const O = { at: FRI_1900, tz: TZ };
const LOCK = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/pages/blocked.html';

// Chrome's RuleCondition / Rule schema: anything else makes updateDynamicRules throw.
const RULE_KEYS = new Set(['id', 'priority', 'action', 'condition']);
const COND_KEYS = new Set([
  'urlFilter', 'regexFilter', 'isUrlFilterCaseSensitive', 'initiatorDomains', 'excludedInitiatorDomains',
  'requestDomains', 'excludedRequestDomains', 'resourceTypes', 'excludedResourceTypes',
  'requestMethods', 'excludedRequestMethods', 'domainType', 'tabIds', 'excludedTabIds',
]);
function assertChromeShape(rules) {
  const ids = new Set();
  for (const r of rules) {
    assert.deepEqual(Object.keys(r).filter((k) => !RULE_KEYS.has(k)), [], 'unexpected rule key');
    assert.ok(Number.isInteger(r.id) && r.id >= 1, 'id must be a positive integer');
    assert.ok(!ids.has(r.id), 'duplicate id ' + r.id); ids.add(r.id);
    assert.ok(Number.isInteger(r.priority) && r.priority >= 1);
    assert.deepEqual(Object.keys(r.condition).filter((k) => !COND_KEYS.has(k)), [], 'unexpected condition key');
    assert.deepEqual(r.condition.resourceTypes, ['main_frame']);
    assert.ok(!(r.condition.urlFilter && r.condition.regexFilter), 'urlFilter and regexFilter are exclusive');
    if (r.condition.regexFilter) new RegExp(r.condition.regexFilter); // must at least be a valid regex
    if (r.action.type === 'redirect') {
      const red = r.action.redirect;
      assert.ok(red && (red.extensionPath || red.regexSubstitution));
      if (red.extensionPath) assert.ok(red.extensionPath.startsWith('/'), 'extensionPath must start with /');
      if (red.regexSubstitution) assert.ok(r.condition.regexFilter, 'regexSubstitution needs regexFilter');
    } else {
      assert.equal(r.action.type, 'allow');
    }
  }
}

// Does a rule's condition cover `scheme://host/`?
function covers(cond, url) {
  const host = new URL(url).hostname;
  if (cond.urlFilter) {
    const f = cond.urlFilter;
    if (f.startsWith('||')) { const h = f.slice(2); return host === h || host.endsWith('.' + h); }
    return false;
  }
  if (cond.regexFilter) return new RegExp(cond.regexFilter).test(url);
  return true; // no filter: matches every main_frame request
}
function winner(rules, url) {
  const m = rules.filter((r) => covers(r.condition, url));
  if (!m.length) return null;
  return m.sort((a, b) => b.priority - a.priority)[0];
}
const blocked = (rules, url) => { const w = winner(rules, url); return !!w && w.action.type === 'redirect'; };
const blockCode = (rules, url) => {
  const w = winner(rules, url);
  const sub = w?.action?.redirect?.regexSubstitution || '';
  return /code=([a-z-]+)/.exec(sub)?.[1] || null;
};

// --- patternToHost / patternToUrlFilter -------------------------------------
test('patternToHost normalises core patterns to a bare host', () => {
  assert.equal(patternToHost('youtube.com'), 'youtube.com');
  assert.equal(patternToHost('*.example.com'), 'example.com');
  assert.equal(patternToHost('tiktok.com*'), 'tiktok.com');
  assert.equal(patternToHost('HTTPS://WWW.Example.org/path'), 'www.example.org');
  assert.equal(patternToHost('*'), null);
  assert.equal(patternToHost(''), null);
  assert.equal(patternToHost('localhost'), null);
  assert.equal(patternToHost('192.168.1.1'), null);
  assert.equal(patternToHost('printer.lan'), null);
  assert.equal(patternToHost(42), null);
});
test('patternToUrlFilter -> ||host', () => {
  assert.equal(patternToUrlFilter('youtube.com'), '||youtube.com');
  assert.equal(patternToUrlFilter('*'), null);
});

// --- shape ------------------------------------------------------------------
const FULL = {
  windows: [{ days: ['Mon', 'Fri'], start: '08:00', end: '17:00' }],
  offDays: ['Sat', '2026-12-25'],
  dailyMinutes: 10, usageToday: 20,
  deny: ['a.com', 'b.org', 'a.com', 'evil.example*'],
  siteBudgets: [{ pattern: 'c.net', minutes: 5, used: 9 }, { pattern: 'd.net', minutes: 5, used: 1 }],
  mode: 'allowlist', allow: ['d.com', '*.e.com'],
};
test('every rule set is valid Chrome DNR shape (extensionPath mode)', () => {
  assertChromeShape(buildDnrRules(FULL, O));
  assertChromeShape(buildDnrRules({}, O));
  assertChromeShape(buildDnrRules(null, O));
  assertChromeShape(failClosedRules());
});
test('every rule set is valid Chrome DNR shape (lockUrl / regex mode)', () => {
  const rules = buildDnrRules(FULL, { ...O, lockUrl: LOCK });
  assertChromeShape(rules);
  for (const r of rules.filter((r) => r.action.type === 'redirect')) {
    assert.match(r.action.redirect.regexSubstitution, /^chrome-extension:\/\/[a-p]{32}\/pages\/blocked\.html\?code=[a-z-]+&url=\\1$/);
  }
  assertChromeShape(failClosedRules({ lockUrl: LOCK }));
});
test('deterministic across runs', () => {
  assert.deepEqual(buildDnrRules(FULL, O), buildDnrRules(FULL, O));
});
test('describeRules gives one line per rule', () => {
  const rules = buildDnrRules(FULL, O);
  assert.equal(describeRules(rules).length, rules.length);
});

// --- master switch ----------------------------------------------------------
test('master OFF -> single block-all rule, nothing else (not even local)', () => {
  const rules = buildDnrRules({ internetAllowed: false, deny: ['a.com'] }, O);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].priority, PRIORITIES.master);
  assert.ok(blocked(rules, 'http://192.168.1.1/'));
  assert.equal(blockCode(buildDnrRules({ internetAllowed: false }, { ...O, lockUrl: LOCK }), 'https://x.com/'), 'disabled');
});

// --- local network ----------------------------------------------------------
test('local addresses stay reachable under every other block', () => {
  const rules = buildDnrRules({ mode: 'allowlist', allow: [], offDays: ['Fri'] }, O);
  for (const u of ['http://192.168.1.50/', 'http://10.0.0.2:8080/x', 'http://172.20.3.4/', 'http://localhost:4100/api',
                   'http://printer.lan/', 'http://nas.local/', 'http://127.0.0.1/']) {
    assert.ok(!blocked(rules, u), 'expected local allow for ' + u);
  }
  assert.ok(blocked(rules, 'http://172.15.0.1/'), '172.15 is not private');
  assert.ok(blocked(rules, 'http://notlocalhost.com/'), 'must not match a lookalike host');
});

// --- deny list --------------------------------------------------------------
test('deny list -> one block rule per unique host; matches subdomains, not lookalikes', () => {
  const rules = buildDnrRules({ deny: ['tiktok.com', 'TikTok.com', 'https://www.reddit.com/r/x'] }, O);
  const vetoes = rules.filter((r) => r.priority === PRIORITIES.siteVeto);
  assert.equal(vetoes.length, 2);
  assert.ok(blocked(rules, 'https://www.tiktok.com/@x'));
  assert.ok(blocked(rules, 'https://tiktok.com/'));
  assert.ok(!blocked(rules, 'https://notiktok.com/'));
  assert.ok(!blocked(rules, 'https://tiktok.com.evil.net/'));
  assert.ok(blocked(rules, 'https://www.reddit.com/'));
  assert.ok(!blocked(rules, 'https://bbc.co.uk/'));
});
test('deny list in regex mode carries the site-denied code and is boundary-safe', () => {
  const rules = buildDnrRules({ deny: ['tiktok.com'] }, { ...O, lockUrl: LOCK });
  assert.equal(blockCode(rules, 'https://m.tiktok.com/x?y=1'), 'site-denied');
  assert.ok(!blocked(rules, 'https://tiktok.com.evil.net/'));
  assert.ok(!blocked(rules, 'https://notiktok.com/'));
  assert.ok(blocked(rules, 'https://tiktok.com:8443/'));
});

// --- time windows (evaluated at `at`) ---------------------------------------
test('inside the window -> no time rule; outside -> block-all at timeWindow priority', () => {
  const p = { windows: [{ days: ['Fri'], start: '08:00', end: '20:00' }] };
  const inside = buildDnrRules(p, { at: FRI_1900, tz: TZ });
  assert.ok(!inside.some((r) => r.priority === PRIORITIES.timeWindow));
  assert.ok(!blocked(inside, 'https://bbc.co.uk/'));
  const outside = buildDnrRules(p, { at: FRI_2230, tz: TZ });
  assert.ok(outside.some((r) => r.priority === PRIORITIES.timeWindow));
  assert.ok(blocked(outside, 'https://bbc.co.uk/'));
  assert.ok(!blocked(outside, 'http://192.168.0.1/'));
  // Saturday is not in the window's days -> blocked all day
  assert.ok(blocked(buildDnrRules(p, { at: SAT_1200, tz: TZ }), 'https://bbc.co.uk/'));
  assert.equal(globalBlockCode(p, { at: FRI_2230, tz: TZ }), BLOCK_CODES.timeWindow);
  assert.equal(globalBlockCode(p, { at: FRI_1900, tz: TZ }), null);
});
test('window wrapping midnight is honoured', () => {
  const p = { windows: [{ start: '20:00', end: '02:00' }] };
  assert.ok(!blocked(buildDnrRules(p, { at: FRI_2230, tz: TZ }), 'https://x.com/'));
  assert.ok(blocked(buildDnrRules(p, { at: FRI_1900, tz: TZ }), 'https://x.com/'));
});
test('windows with missing start/end are ignored (= always on)', () => {
  const rules = buildDnrRules({ windows: [{ days: ['Fri'] }, { start: '25:00', end: '09:00' }] }, { at: FRI_2230, tz: TZ });
  assert.ok(!blocked(rules, 'https://x.com/'));
});

// --- off days ---------------------------------------------------------------
test('weekday-name off day blocks only on that day', () => {
  const p = { offDays: ['Sat'] };
  assert.ok(blocked(buildDnrRules(p, { at: SAT_1200, tz: TZ }), 'https://x.com/'));
  assert.ok(!blocked(buildDnrRules(p, { at: FRI_1900, tz: TZ }), 'https://x.com/'));
  assert.equal(blockCode(buildDnrRules(p, { at: SAT_1200, tz: TZ, lockUrl: LOCK }), 'https://x.com/'), 'off-day');
});
test('ISO-date off day blocks only on that date (in the family tz)', () => {
  const p = { offDays: ['2026-09-19'] };
  assert.ok(blocked(buildDnrRules(p, { at: SAT_1200, tz: TZ }), 'https://x.com/'));
  assert.ok(!blocked(buildDnrRules(p, { at: FRI_1900, tz: TZ }), 'https://x.com/'));
  // 23:30 UTC Friday is already Saturday 00:30 in London
  assert.ok(blocked(buildDnrRules(p, { at: Date.parse('2026-09-18T23:30:00Z'), tz: TZ }), 'https://x.com/'));
});

// --- daily budget -----------------------------------------------------------
test('daily budget exhausted -> block-all; not exhausted -> no rule', () => {
  const gone = buildDnrRules({ dailyMinutes: 60, usageToday: 60 }, O);
  assert.ok(gone.some((r) => r.priority === PRIORITIES.dailyBudget));
  assert.ok(blocked(gone, 'https://x.com/'));
  const ok = buildDnrRules({ dailyMinutes: 60, usageToday: 10 }, O);
  assert.ok(!ok.some((r) => r.priority === PRIORITIES.dailyBudget));
  assert.equal(blockCode(buildDnrRules({ dailyMinutes: 60, usageToday: 61 }, { ...O, lockUrl: LOCK }), 'https://x.com/'), 'daily-budget');
});

// --- per-site budget --------------------------------------------------------
test('per-site budget exhausted -> block rule for that host only', () => {
  const rules = buildDnrRules({ siteBudgets: [{ pattern: 'youtube.com', minutes: 30, used: 45 }, { pattern: 'bbc.co.uk', minutes: 30, used: 5 }] }, O);
  assert.ok(blocked(rules, 'https://m.youtube.com/watch'));
  assert.ok(!blocked(rules, 'https://www.bbc.co.uk/'));
  assert.equal(rules.filter((r) => r.priority === PRIORITIES.siteBudget).length, 1);
});

// --- allowlist mode ---------------------------------------------------------
test('allowlist mode -> allow listed sites, block everything else, deny still wins', () => {
  const rules = buildDnrRules({ mode: 'allowlist', allow: ['khanacademy.org', 'youtube.com'], deny: ['youtube.com'] }, O);
  assert.ok(!blocked(rules, 'https://www.khanacademy.org/math'));
  assert.ok(blocked(rules, 'https://twitter.com/x'));
  assert.ok(blocked(rules, 'https://youtube.com/'), 'deny beats allow');
  assert.ok(!blocked(rules, 'http://192.168.1.1/'), 'local still reachable');
  assert.equal(blockCode(buildDnrRules({ mode: 'allowlist', allow: [] }, { ...O, lockUrl: LOCK }), 'https://x.com/'), 'not-allowed');
});
test('denylist / unrestricted mode -> no baseline block', () => {
  for (const mode of ['denylist', 'unrestricted', undefined]) {
    const rules = buildDnrRules({ mode, allow: ['a.com'] }, O);
    assert.ok(!rules.some((r) => r.priority === PRIORITIES.allowlistBase), 'mode ' + mode);
    assert.ok(!blocked(rules, 'https://anything.com/'));
  }
});

// --- fail-closed ------------------------------------------------------------
test('every regexFilter stays small enough for Chrome\'s 2KB compiled budget (proxy: < 160 chars)', () => {
  for (const re of LOCAL_REGEXES) assert.ok(re.length < 160, re);
  const rules = buildDnrRules(FULL, { ...O, lockUrl: LOCK });
  for (const r of rules) if (r.condition.regexFilter) assert.ok(r.condition.regexFilter.length < 400, r.condition.regexFilter);
});
test('minimalBlockRules blocks everything (last resort)', () => {
  const rules = minimalBlockRules();
  assertChromeShape(rules);
  assert.ok(blocked(rules, 'https://x.com/'));
  assert.ok(blocked(rules, 'http://192.168.1.1/'));
});
test('failClosedRules -> block-all plus local allow', () => {
  const rules = failClosedRules();
  assert.ok(blocked(rules, 'https://x.com/'));
  assert.ok(!blocked(rules, 'http://192.168.1.1/'));
  assert.equal(blockCode(failClosedRules({ lockUrl: LOCK }), 'https://x.com/'), 'fail-closed');
});
test('unparseable policy (null/number/string) -> single fail-closed block rule', () => {
  for (const bad of [null, 42, 'nope', undefined]) {
    const r = buildDnrRules(bad, O);
    assert.equal(r.length, 1);
    assert.ok(blocked(r, 'https://x.com/'));
  }
  assert.equal(globalBlockCode(null), BLOCK_CODES.failClosed);
});

// --- garbage tolerance ------------------------------------------------------
test('junk entries in lists are skipped, not fatal', () => {
  const rules = buildDnrRules({
    deny: [null, 42, '', '*', 'ok.com'], allow: [{}, 'x.com'], offDays: [null, 7, 'Never'],
    siteBudgets: [null, { pattern: 3, minutes: 1, used: 5 }, { pattern: 'y.com', minutes: 0, used: 5 }],
    windows: 'nope', mode: 'allowlist',
  }, O);
  assertChromeShape(rules);
  assert.ok(blocked(rules, 'https://ok.com/'));
  assert.ok(!blocked(rules, 'https://x.com/'));
});
