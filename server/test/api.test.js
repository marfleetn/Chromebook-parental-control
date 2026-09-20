// @chpc/server — integration tests (node --test + supertest over real HTTP).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { RateLimiter, pinProblem } from '../src/auth.js';
import { validatePolicy, normalizePattern } from '../src/validate.js';
import { makeCode, normalizeCode, formatCode, openDb, addUsage, purgeUsageOlderThan, createKid } from '../src/db.js';

const PIN = 'family-2026';
const CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/;

function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chpc-test-'));
  const built = createApp({ dbFile: path.join(dir, 'chpc.db'), guardianPin: PIN, log: () => {}, ...extra });
  t.after(() => { try { built.db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  // Parent-side client: every request carries the PIN.
  const as = (pin = PIN) => ({
    get: (u) => request(built.app).get(u).set('x-guardian-pin', pin),
    post: (u) => request(built.app).post(u).set('x-guardian-pin', pin),
    put: (u) => request(built.app).put(u).set('x-guardian-pin', pin),
    patch: (u) => request(built.app).patch(u).set('x-guardian-pin', pin),
    delete: (u) => request(built.app).delete(u).set('x-guardian-pin', pin),
  });
  return { ...built, dir, parent: as(), anon: request(built.app), as };
}

async function kidWithDevice(parent, name = 'Kid', policy = null) {
  const kidId = (await parent.post('/api/kids').send({ name })).body.kid.id;
  if (policy) await parent.put('/api/kids/' + kidId + '/policy').send(policy);
  const code = (await parent.post('/api/kids/' + kidId + '/pairings').send({})).body.code;
  return { kidId, code };
}

// --- auth -------------------------------------------------------------------
test('parent routes need the guardian PIN; device + health routes do not', async (t) => {
  const { anon, parent, as, app } = fixture(t);
  assert.equal((await anon.get('/api/health')).status, 200);
  for (const [m, u] of [['get', '/api/kids'], ['get', '/api/settings'], ['post', '/api/kids'], ['get', '/api/auth/check']]) {
    const r = await (m === 'get' ? anon.get(u) : anon[m](u).send({ name: 'x' }));
    assert.equal(r.status, 401, `${m} ${u} should be 401 without a PIN`);
    assert.equal(r.body.code, 'pin-required');
  }
  assert.equal((await as('wrong-pin-1').get('/api/kids')).status, 401);
  assert.equal((await as('wrong-pin-1').get('/api/kids')).body.code, 'pin-wrong');
  assert.equal((await parent.get('/api/auth/check')).status, 200);
  // Bearer form works too.
  const r = await request(app).get('/api/kids').set('Authorization', 'Bearer ' + PIN);
  assert.equal(r.status, 200);
  // Device route: 404 for unknown code, never 401.
  assert.equal((await anon.get('/api/devices/BBBBBBBB')).status, 404);
});

test('PIN brute force is rate limited per client', async (t) => {
  const { as, parent } = fixture(t);
  let last;
  for (let i = 0; i < 10; i++) last = await as('nope-' + i).get('/api/kids');
  assert.equal(last.status, 401);
  const blocked = await as(PIN).get('/api/kids');   // even the right PIN is refused while locked out
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers['retry-after']);
  void parent;
});

test('unknown pairing codes are rate limited per client', async (t) => {
  const { anon } = fixture(t);
  let r;
  for (let i = 0; i < 20; i++) r = await anon.get('/api/devices/ZZZZZZZZ');
  assert.equal(r.status, 404);
  r = await anon.get('/api/devices/ZZZZZZZZ');
  assert.equal(r.status, 429);
});

test('no PIN configured -> parent routes 503 unless allowNoPin (loopback dev mode)', async (t) => {
  const a = fixture(t, { guardianPin: null });
  const r = await a.anon.get('/api/kids');
  assert.equal(r.status, 503);
  const b = fixture(t, { guardianPin: null, allowNoPin: true });
  assert.equal((await b.anon.get('/api/kids')).status, 200);
});

test('pinProblem rejects weak or missing PINs', () => {
  assert.ok(pinProblem(''));
  assert.ok(pinProblem('1234'));
  assert.ok(pinProblem('111111'));
  assert.ok(pinProblem('123456'));
  assert.equal(pinProblem('family-2026'), null);
  assert.equal(pinProblem('839201'), null);
});

test('RateLimiter: sliding window', () => {
  let now = 0;
  const rl = new RateLimiter({ limit: 3, windowMs: 100, now: () => now });
  rl.fail('a'); rl.fail('a');
  assert.equal(rl.blocked('a'), false);
  rl.fail('a');
  assert.equal(rl.blocked('a'), true);
  assert.equal(rl.blocked('b'), false);
  now = 150;
  assert.equal(rl.blocked('a'), false);
  rl.fail('a'); rl.fail('a'); rl.fail('a'); rl.reset('a');
  assert.equal(rl.blocked('a'), false);
});

// --- headers / CORS ---------------------------------------------------------
test('security headers on every response, no CORS by default, opt-in origins', async (t) => {
  const { anon } = fixture(t, { corsOrigins: ['http://console.example'] });
  const r = await anon.get('/api/health');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.match(r.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-powered-by'], undefined);
  assert.equal(r.headers['access-control-allow-origin'], undefined);

  const evil = await anon.get('/api/health').set('Origin', 'http://evil.example');
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
  const ok = await anon.options('/api/kids').set('Origin', 'http://console.example')
    .set('Access-Control-Request-Method', 'PUT');
  assert.equal(ok.status, 204);
  assert.equal(ok.headers['access-control-allow-origin'], 'http://console.example');
  assert.match(ok.headers['access-control-allow-headers'], /X-Guardian-PIN/);
});

test('malformed JSON -> 400, oversize body -> 413', async (t) => {
  const { parent } = fixture(t);
  const r = await parent.post('/api/kids').set('Content-Type', 'application/json').send('{"name": ');
  assert.equal(r.status, 400);
  const big = await parent.post('/api/kids').send({ name: 'x'.repeat(300 * 1024) });
  assert.equal(big.status, 413);
});

// --- settings ---------------------------------------------------------------
test('GET /api/settings defaults + PUT validates the time zone', async (t) => {
  const { parent } = fixture(t);
  let res = await parent.get('/api/settings');
  assert.equal(res.status, 200);
  assert.equal(res.body.timezone, 'Europe/London');

  res = await parent.put('/api/settings').send({ timezone: 'America/New_York' });
  assert.equal(res.status, 200);
  assert.equal(res.body.timezone, 'America/New_York');

  res = await parent.put('/api/settings').send({ timezone: 'Not/AZure' });
  assert.equal(res.status, 400);
  assert.equal(res.body.field, 'timezone');

  res = await parent.get('/api/settings');
  assert.equal(res.body.timezone, 'America/New_York');
});

// --- kids -------------------------------------------------------------------
test('kids CRUD + 404s + name validation', async (t) => {
  const { parent } = fixture(t);

  let res = await parent.get('/api/kids');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.kids, []);

  assert.equal((await parent.post('/api/kids').send({})).status, 400);
  assert.equal((await parent.post('/api/kids').send({ name: '   ' })).status, 400);
  assert.equal((await parent.post('/api/kids').send({ name: 'x'.repeat(61) })).status, 400);
  assert.equal((await parent.post('/api/kids').send({ name: 42 })).status, 400);

  res = await parent.post('/api/kids').send({ name: '  Maya\u0000  ' });
  assert.equal(res.status, 201);
  assert.equal(res.body.kid.name, 'Maya');
  const id = res.body.kid.id;

  res = await parent.get('/api/kids');
  assert.equal(res.body.kids.length, 1);
  assert.ok(res.body.kids[0].status);
  assert.deepEqual(res.body.kids[0].devices, []);

  res = await parent.patch('/api/kids/' + id).send({ name: 'Maya R' });
  assert.equal(res.body.kid.name, 'Maya R');

  assert.equal((await parent.get('/api/kids/9999')).status, 404);
  assert.equal((await parent.get('/api/kids/abc')).status, 404);
  assert.equal((await parent.get('/api/kids/1e9')).status, 404);
  assert.equal((await parent.delete('/api/kids/9999')).status, 404);

  res = await parent.delete('/api/kids/' + id);
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted, id);
  assert.deepEqual((await parent.get('/api/kids')).body.kids, []);
});

// --- policy -----------------------------------------------------------------
test('policy validation: normalises, strips unknown keys, rejects junk', async (t) => {
  const { parent } = fixture(t);
  const id = (await parent.post('/api/kids').send({ name: 'Leo' })).body.kid.id;

  let res = await parent.get('/api/kids/' + id + '/policy');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.policy, {});
  assert.equal(res.body.effective.internetAllowed, true);
  assert.equal(res.body.effective.mode, 'unrestricted');

  const policy = {
    mode: 'denylist',
    dailyMinutes: '60',
    deny: ['Reddit.com', 'reddit.com', 'https://www.TikTok.com/@x', '*.roblox.com'],
    siteBudgets: [{ pattern: 'YouTube.com', minutes: 30 }],
    windows: [{ days: ['monday', 'Tue', 'wed', 'Thu', 'Fri', 'Fri'], start: '8:00', end: '21:00' }],
    offDays: ['saturday', '2026-12-25', 'Sat'],
    __proto__x: 1, evil: 'ignored', usageToday: 0,
  };
  res = await parent.put('/api/kids/' + id + '/policy').send(policy);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.policy, {
    internetAllowed: true,
    mode: 'denylist',
    dailyMinutes: 60,
    deny: ['reddit.com', 'https://www.tiktok.com/@x', '*.roblox.com'],
    allow: [],
    siteBudgets: [{ pattern: 'youtube.com', minutes: 30 }],
    windows: [{ start: '08:00', end: '21:00', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] }],
    offDays: ['Sat', '2026-12-25'],
  });

  for (const bad of [
    { mode: 'sometimes' },
    { mode: 'strict' },
    { dailyMinutes: -5 },
    { dailyMinutes: 'sixty' },
    { dailyMinutes: 12.5 },
    { dailyMinutes: 100000 },
    { deny: 'reddit.com' },
    { deny: ['not a host'] },
    { deny: [''] },
    { deny: [42] },
    { allow: Array.from({ length: 501 }, (_, i) => `s${i}.com`) },
    { siteBudgets: [{ minutes: 5 }] },
    { siteBudgets: [{ pattern: 'a.com', minutes: 0 }] },
    { siteBudgets: [{ pattern: 'a.com', minutes: 5 }, { pattern: 'A.com', minutes: 6 }] },
    { siteBudgets: [{ pattern: '*', minutes: 5 }] },
    { windows: [{ start: '25:99', end: '10:00' }] },
    { windows: [{ start: '08:00' }] },
    { windows: [{ start: '08:00', end: '08:00' }] },
    { windows: [{ start: '08:00', end: '09:00', days: ['Funday'] }] },
    { windows: 'nope' },
    { offDays: ['2026-02-30'] },
    { offDays: ['tomorrow'] },
    { offDays: 'Sat' },
    { internetAllowed: 'yes' },
    [1, 2, 3],
  ]) {
    const r = await parent.put('/api/kids/' + id + '/policy').send(bad);
    assert.equal(r.status, 400, 'expected 400 for ' + JSON.stringify(bad).slice(0, 80) + ' got ' + r.status);
    assert.ok(r.body.error && r.body.field, 'error + field for ' + JSON.stringify(bad).slice(0, 80));
  }

  res = await parent.get('/api/kids/' + id + '/policy');
  assert.equal(res.body.policy.dailyMinutes, 60);

  // 0 / blank daily minutes -> no limit
  res = await parent.put('/api/kids/' + id + '/policy').send({ dailyMinutes: 0 });
  assert.equal(res.body.policy.dailyMinutes, null);
  res = await parent.put('/api/kids/' + id + '/policy').send({ dailyMinutes: '' });
  assert.equal(res.body.policy.dailyMinutes, null);
});

test('validatePolicy / normalizePattern units', () => {
  assert.equal(normalizePattern(' YouTube.com '), 'youtube.com');
  assert.equal(normalizePattern('*.example.co.uk'), '*.example.co.uk');
  assert.equal(normalizePattern('tiktok.com*'), 'tiktok.com*');
  assert.equal(normalizePattern('*'), '*');
  assert.equal(normalizePattern('has space.com'), null);
  assert.equal(normalizePattern('chrome://settings'), null);
  assert.equal(normalizePattern(''), null);
  assert.equal(normalizePattern('a'.repeat(300)), null);
  assert.deepEqual(validatePolicy(undefined), { policy: {} });
  assert.ok(validatePolicy('str').error);
});

// --- pairing + devices ------------------------------------------------------
test('pairing flow + device endpoints', async (t) => {
  const { parent, anon } = fixture(t);
  const kidId = (await parent.post('/api/kids').send({ name: 'Isla' })).body.kid.id;

  let res = await parent.post('/api/kids/' + kidId + '/pairings').send({ agentId: 'chromebook-xyz' });
  assert.equal(res.status, 201);
  const code = res.body.code;
  assert.match(code, CODE_RE);
  assert.equal(res.body.codeDisplay, code.slice(0, 4) + '-' + code.slice(4));

  // Typed loosely: lowercase, with the dash.
  res = await anon.get('/api/devices/' + res.body.codeDisplay.toLowerCase());
  assert.equal(res.status, 200);
  assert.equal(res.body.kid.id, kidId);
  assert.deepEqual(Object.keys(res.body.kid).sort(), ['id', 'name']);
  assert.equal(res.body.policy.mode, 'unrestricted');
  assert.equal(res.body.device.agentId, 'chromebook-xyz');
  assert.equal(res.body.timeZone, 'Europe/London');
  assert.equal(res.body.decision, null);

  res = await anon.get('/api/devices/' + code + '?host=https://www.youtube.com/watch');
  assert.equal(res.body.decision.host, 'www.youtube.com');
  assert.equal(res.body.decision.allowed, true);

  res = await anon.post('/api/devices/' + code + '/heartbeat').send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.timeZone, 'Europe/London');

  res = await parent.get('/api/kids/' + kidId);
  assert.equal(res.body.devices.length, 1);
  assert.equal(res.body.devices[0].code, code);
  assert.ok(res.body.devices[0].lastSeen, 'heartbeat updates lastSeen');
  assert.equal((await parent.get('/api/kids')).body.kids[0].devices.length, 1);

  assert.equal((await anon.get('/api/devices/NOPE')).status, 404);

  // Unpair -> device becomes unknown immediately.
  res = await parent.delete('/api/kids/' + kidId + '/pairings/' + code.toLowerCase());
  assert.equal(res.status, 200);
  assert.equal((await anon.get('/api/devices/' + code)).status, 404);
  assert.equal((await parent.delete('/api/kids/' + kidId + '/pairings/' + code)).status, 404);
});

test('pairing codes: CSPRNG alphabet, normalisation, display', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) { const c = makeCode(); assert.match(c, CODE_RE); seen.add(c); }
  assert.equal(seen.size, 200);
  assert.equal(normalizeCode(' ktrm-xpbd '), 'KTRMXPBD');
  assert.equal(normalizeCode('x'), '');
  assert.equal(normalizeCode(null), '');
  assert.equal(formatCode('KTRMXPBD'), 'KTRM-XPBD');
});

// --- usage ------------------------------------------------------------------
test('usage reporting records + decision, server clock is authoritative', async (t) => {
  const { parent, anon } = fixture(t);
  const { kidId, code } = await kidWithDevice(parent, 'Theo', { mode: 'denylist', dailyMinutes: 60, deny: ['reddit.com'] });

  let r = await anon.post('/api/devices/' + code + '/usage')
    .send({ url: 'https://bbc.co.uk/news?token=secret', seconds: 300, startedAt: '2001-01-01T00:00:00Z' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.recorded, { site: 'bbc.co.uk', seconds: 300 });
  assert.equal(r.body.decision.allowed, true);
  assert.equal(r.body.status.usedTodayMin, 5, 'back-dated startedAt is ignored');

  r = await anon.post('/api/devices/' + code + '/usage').send({ url: 'https://www.reddit.com/r/ask', seconds: 120 });
  assert.equal(r.body.decision.allowed, false);
  assert.equal(r.body.decision.code, 'site-denied');

  // Absurd claims are capped at an hour per report.
  r = await anon.post('/api/devices/' + code + '/usage').send({ site: 'bbc.co.uk', seconds: 10 ** 9 });
  assert.equal(r.body.recorded.seconds, 3600);
  r = await anon.post('/api/devices/' + code + '/usage').send({ site: 'bbc.co.uk', seconds: 60 });
  assert.equal(r.body.decision.allowed, false);
  assert.equal(r.body.decision.code, 'daily-budget');

  // Full URLs are never stored — only the host.
  const today = await parent.get('/api/kids/' + kidId + '/usage/today');
  assert.ok(today.body.sites.every((s) => !s.site.includes('/') && !s.site.includes('?')));

  // Junk is ignored, not fatal.
  r = await anon.post('/api/devices/' + code + '/usage').send({ site: 'not a host', seconds: 5 });
  assert.equal(r.status, 200);
  assert.equal(r.body.recorded, null);
  r = await anon.post('/api/devices/' + code + '/usage').send('nonsense');
  assert.equal(r.status, 200);
});

test('usage batch reports', async (t) => {
  const { parent, anon } = fixture(t);
  const { kidId, code } = await kidWithDevice(parent, 'Batch');
  const r = await anon.post('/api/devices/' + code + '/usage').send({
    entries: [{ site: 'a.com', seconds: 60 }, { site: 'b.com', seconds: 120 }, { site: '', seconds: 5 }, null],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.recorded.length, 2);
  assert.equal(r.body.status.usedTodayMin, 3);
  const today = await parent.get('/api/kids/' + kidId + '/usage/today');
  assert.equal(today.body.sites.length, 2);
});

test('today usage dashboard aggregates sites + budgets', async (t) => {
  const { parent, anon } = fixture(t);
  const { kidId, code } = await kidWithDevice(parent, 'Ada', {
    mode: 'denylist', dailyMinutes: 240, siteBudgets: [{ pattern: 'youtube.com', minutes: 45 }],
  });
  await anon.post('/api/devices/' + code + '/usage').send({ url: 'https://www.youtube.com/watch?v=abc', seconds: 1200, site: 'youtube.com' });
  await anon.post('/api/devices/' + code + '/usage').send({ url: 'https://youtube.com/shorts', seconds: 600, site: 'youtube.com' });
  await anon.post('/api/devices/' + code + '/usage').send({ url: 'https://bbc.co.uk/news', seconds: 300 });

  const r = await parent.get('/api/kids/' + kidId + '/usage/today');
  assert.equal(r.status, 200);
  const yt = r.body.sites.find((s) => s.site === 'youtube.com');
  assert.equal(yt.minutes, 30);
  assert.equal(yt.visits, 2);
  assert.equal(yt.budgetMinutes, 45);
  const bbc = r.body.sites.find((s) => s.site === 'bbc.co.uk');
  assert.equal(bbc.minutes, 5);
  assert.equal(bbc.budgetMinutes, null);
  assert.equal(r.body.status.usedTodayMin, 35);
});

test('history returns requested day count, oldest first, today last', async (t) => {
  const { parent, anon } = fixture(t);
  const { kidId, code } = await kidWithDevice(parent, 'Rae');
  await anon.post('/api/devices/' + code + '/usage').send({ url: 'https://bbc.co.uk', seconds: 600 });

  let r = await parent.get('/api/kids/' + kidId + '/usage/history?days=3');
  assert.equal(r.status, 200);
  assert.equal(r.body.perDay.length, 3);
  const last = r.body.perDay[2];
  assert.equal(last.minutes, 10);
  assert.match(last.isoDay, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.body.perDay[0].minutes, 0);
  assert.ok(r.body.perDay[0].isoDay < r.body.perDay[1].isoDay);

  r = await parent.get('/api/kids/' + kidId + '/usage/history?days=999');
  assert.equal(r.body.perDay.length, 90);
  r = await parent.get('/api/kids/' + kidId + '/usage/history?days=abc');
  assert.equal(r.body.perDay.length, 7);
});

test('internet off blocks everything (end-to-end with decide())', async (t) => {
  const { parent, anon } = fixture(t);
  const { code } = await kidWithDevice(parent, 'NoNet', { internetAllowed: false });
  const r = await anon.post('/api/devices/' + code + '/usage').send({ url: 'https://bbc.co.uk', seconds: 10 });
  assert.equal(r.body.decision.allowed, false);
  assert.equal(r.body.decision.code, 'disabled');
});

test('unknown device usage -> 404', async (t) => {
  const { anon } = fixture(t);
  const r = await anon.post('/api/devices/ZZZZZZZZ/usage').send({ url: 'https://x.com', seconds: 10 });
  assert.equal(r.status, 404);
});

test('deleting a kid cascades to devices, policy and usage', async (t) => {
  const { parent, anon, db } = fixture(t);
  const { kidId, code } = await kidWithDevice(parent, 'Gone');
  await anon.post('/api/devices/' + code + '/usage').send({ site: 'a.com', seconds: 60 });
  await parent.delete('/api/kids/' + kidId);
  assert.equal((await anon.get('/api/devices/' + code)).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policy').get().n, 0);
});

// --- retention --------------------------------------------------------------
test('usage retention purge removes only old rows', () => {
  const db = openDb(':memory:');
  const kid = createKid(db, 'R');
  const old = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
  addUsage(db, { kidId: kid.id, site: 'old.com', startedAt: old, endedAt: old, seconds: 60 });
  addUsage(db, { kidId: kid.id, site: 'new.com', seconds: 60 });
  assert.equal(purgeUsageOlderThan(db, 90), 1);
  assert.equal(db.prepare('SELECT site FROM usage').get().site, 'new.com');
  db.close();
});

test('createApp with retentionDays purges at startup', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chpc-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'chpc.db');
  const db = openDb(file);
  const kid = createKid(db, 'R');
  const old = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
  addUsage(db, { kidId: kid.id, site: 'old.com', startedAt: old, endedAt: old, seconds: 60 });
  db.close();
  const built = createApp({ dbFile: file, guardianPin: PIN, retentionDays: 30 });
  t.after(() => built.db.close());
  assert.equal(built.db.prepare('SELECT COUNT(*) AS n FROM usage').get().n, 0);
  const s = await request(built.app).get('/api/settings').set('x-guardian-pin', PIN);
  assert.equal(s.body.retentionDays, 30);
});

// --- static console ---------------------------------------------------------
test('serves the console and falls back to index.html for non-API paths', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chpc-pub-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>console</title>');
  const { anon } = fixture(t, { publicDir: dir });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.match((await anon.get('/')).text, /console/);
  assert.match((await anon.get('/kids/1').set('Accept', 'text/html')).text, /console/);
  assert.equal((await anon.get('/api/nope')).status, 404);
  assert.equal((await anon.get('/api')).status, 404);
});
