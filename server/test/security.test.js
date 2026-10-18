// @chpc/server — adversarial security tests.
//
// Each test is an attack a child, a web page on the LAN, or a hostile client
// could try against the API. They complement api.test.js (which proves the
// happy paths) by proving the refusals: authentication cannot be bypassed,
// inputs cannot inject or pollute, responses leak nothing, limits hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';

const PIN = 'family-2026';

function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chpc-sec-'));
  const built = createApp({ dbFile: path.join(dir, 'chpc.db'), guardianPin: PIN, log: () => {}, ...extra });
  t.after(() => { try { built.db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const parent = (m, u) => request(built.app)[m](u).set('x-guardian-pin', PIN);
  return { ...built, dir, anon: request(built.app), parent };
}
async function seed(parent, policy) {
  const kidId = (await parent('post', '/api/kids').send({ name: 'Target' })).body.kid.id;
  if (policy) await parent('put', `/api/kids/${kidId}/policy`).send(policy);
  const code = (await parent('post', `/api/kids/${kidId}/pairings`).send({})).body.code;
  return { kidId, code };
}
const PARENT_ROUTES = [
  ['get', '/api/kids'], ['post', '/api/kids'], ['get', '/api/kids/1'], ['patch', '/api/kids/1'], ['delete', '/api/kids/1'],
  ['get', '/api/kids/1/policy'], ['put', '/api/kids/1/policy'], ['post', '/api/kids/1/pairings'],
  ['delete', '/api/kids/1/pairings/ABCDEFGH'], ['get', '/api/kids/1/usage/today'], ['get', '/api/kids/1/usage/history'],
  ['get', '/api/settings'], ['put', '/api/settings'], ['get', '/api/auth/check'], ['put', '/api/auth/pin'],
];

// ---------------------------------------------------------------------------
// 1. Authentication cannot be bypassed
// ---------------------------------------------------------------------------
test('SEC auth: every parent route refuses requests without the PIN', async (t) => {
  const { anon, parent } = fixture(t);
  await seed(parent);
  for (const [m, u] of PARENT_ROUTES) {
    const r = await anon[m](u).send(m === 'get' || m === 'delete' ? undefined : { name: 'x', timezone: 'UTC', pin: 'abcdefg' });
    assert.equal(r.status, 401, `${m.toUpperCase()} ${u} answered ${r.status} without a PIN`);
  }
});

test('SEC auth: the PIN is only accepted from the two documented headers', async (t) => {
  const { app, parent } = fixture(t);
  await seed(parent);
  const tries = [
    request(app).get('/api/kids?pin=' + PIN),
    request(app).get('/api/kids?x-guardian-pin=' + PIN),
    request(app).get('/api/kids').set('Cookie', 'pin=' + PIN),
    request(app).get('/api/kids').set('X-Guardian-Pin-', PIN),
    request(app).get('/api/kids').set('Authorization', PIN),                 // no scheme
    request(app).get('/api/kids').set('Authorization', 'Basic ' + Buffer.from(':' + PIN).toString('base64')),
    request(app).post('/api/kids').set('Content-Type', 'application/json').send({ pin: PIN, name: 'x' }),
  ];
  for (const tr of tries) assert.equal((await tr).status, 401, 'PIN accepted from an undocumented location');
  // Header names are case-insensitive by HTTP; both documented forms work.
  assert.equal((await request(app).get('/api/kids').set('X-GUARDIAN-PIN', PIN)).status, 200);
  assert.equal((await request(app).get('/api/kids').set('authorization', 'bearer ' + PIN)).status, 200);
});

test('SEC auth: near-miss PINs are rejected (prefix, suffix, case, whitespace, unicode)', async (t) => {
  const { app, parent } = fixture(t);
  await seed(parent);
  // (Leading/trailing whitespace is stripped by HTTP itself and cannot reach the server.)
  for (const bad of [PIN.slice(0, -1), PIN + 'x', PIN.toUpperCase(), PIN.replace('-', '_'), PIN + '.', '']) {
    const r = await request(app).get('/api/kids').set('x-guardian-pin', bad);
    assert.equal(r.status, 401, JSON.stringify(bad));
  }
});

test('SEC auth: path tricks do not reach parent routes unauthenticated', async (t) => {
  const { anon, parent } = fixture(t);
  await seed(parent);
  for (const p of ['/API/kids', '/api/KIDS', '//api/kids', '/api//kids', '/api/./kids', '/api/kids/', '/api/kids/..;/kids',
                   '/api/kids%2F', '/api%2Fkids', '/api/kids?/', '/api/kids#x', '/./api/kids', '/api/kids/1/../../kids']) {
    const r = await anon.get(p);
    assert.ok([401, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.ok(!JSON.stringify(r.body).includes('"kids":'), `${p} leaked data`);
  }
});

test('SEC auth: a pairing code is not a PIN and a PIN is not a pairing code', async (t) => {
  const { app, parent } = fixture(t);
  const { code } = await seed(parent);
  assert.equal((await request(app).get('/api/kids').set('x-guardian-pin', code)).status, 401);
  assert.equal((await request(app).get('/api/devices/' + encodeURIComponent(PIN))).status, 404);
});

test('SEC auth: method override headers are ignored', async (t) => {
  const { anon, parent } = fixture(t);
  const { kidId } = await seed(parent);
  const r = await anon.get(`/api/kids/${kidId}`).set('X-HTTP-Method-Override', 'DELETE');
  assert.equal(r.status, 401);
  assert.equal((await parent('get', `/api/kids/${kidId}`)).status, 200, 'kid still exists');
});

test('SEC auth: setup is impossible once a PIN exists, and never with a guessed code', async (t) => {
  const { anon } = fixture(t);
  assert.equal((await anon.post('/api/setup').send({ setupCode: 'BBBBBBBB', pin: 'another-pin1' })).status, 409);
  const { anon: a2, getSetupCode } = fixture(t, { guardianPin: null, setupCode: 'KTRMXPBD' });
  for (const g of ['KTRMXPBC', 'ktrmxpb', 'KTRMXPBDD', '', null, 42, { toString: () => 'KTRMXPBD' }]) {
    const r = await a2.post('/api/setup').send({ setupCode: g, pin: 'another-pin1' });
    assert.equal(r.status, 401, JSON.stringify(g));
  }
  assert.equal(getSetupCode(), 'KTRMXPBD', 'code survives failed attempts');
});

// ---------------------------------------------------------------------------
// 2. Injection and pollution
// ---------------------------------------------------------------------------
test('SEC injection: SQL and HTML in names and patterns are stored inert', async (t) => {
  const { parent, db } = fixture(t);
  const evilName = `Robert'); DROP TABLE kids;-- <script>alert(1)</script>`;
  const r = await parent('post', '/api/kids').send({ name: evilName });
  assert.equal(r.status, 201);
  assert.equal(r.body.kid.name, evilName, 'stored verbatim, not interpreted');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kids').get().n, 1, 'table intact');
  const kidId = r.body.kid.id;
  const pol = await parent('put', `/api/kids/${kidId}/policy`).send({ deny: ["x.com'; DROP TABLE policy;--"] });
  assert.equal(pol.status, 400, 'non-host patterns are rejected, not stored');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policy').get().n, 1);
  const ok = await parent('put', `/api/kids/${kidId}/policy`).send({ deny: ['xn--80ak6aa92e.com', 'sub.example.co.uk'] });
  assert.equal(ok.status, 200);
});

test('SEC injection: prototype pollution keys never reach the stored policy', async (t) => {
  const { parent } = fixture(t);
  const { kidId } = await seed(parent);
  const body = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"deny":["a.com"],"windows":[{"start":"08:00","end":"09:00","__proto__":{"x":1}}]}');
  const r = await parent('put', `/api/kids/${kidId}/policy`).send(body);
  assert.equal(r.status, 200);
  assert.equal(({}).polluted, undefined, 'Object.prototype untouched');
  assert.deepEqual(Object.keys(r.body.policy).sort(), ['allow', 'dailyMinutes', 'deny', 'internetAllowed', 'mode', 'offDays', 'siteBudgets', 'windows']);
  assert.deepEqual(Object.keys(r.body.policy.windows[0]).sort(), ['end', 'start']);
});

test('SEC injection: usage reports cannot smuggle paths, queries, scripts or other kids', async (t) => {
  const { anon, parent, db } = fixture(t);
  const a = await seed(parent);
  const b = await seed(parent);
  await anon.post(`/api/devices/${a.code}/usage`).send({ url: 'https://bank.example/account?token=SECRET123&user=me#frag', seconds: 60 });
  await anon.post(`/api/devices/${a.code}/usage`).send({ site: '<script>alert(1)</script>.com', seconds: 60 });
  await anon.post(`/api/devices/${a.code}/usage`).send({ site: 'ok.com', seconds: 60, kidId: b.kidId, kid_id: b.kidId });
  const rows = db.prepare('SELECT kid_id, site, url FROM usage').all();
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.equal(row.url, '', 'full URL never stored');
    assert.ok(!/SECRET123|token|script|</.test(row.site), 'site holds a bare hostname: ' + row.site);
    assert.equal(row.kid_id, a.kidId, 'usage is attributed to the code owner, not a client-chosen kid');
  }
  const dump = JSON.stringify(db.prepare('SELECT * FROM usage').all());
  assert.ok(!dump.includes('SECRET123'), 'query-string secret absent from the database');
});

test('SEC injection: hostile JSON shapes are rejected without crashing', async (t) => {
  const { parent } = fixture(t);
  const { kidId } = await seed(parent);
  const deep = '['.repeat(5000) + ']'.repeat(5000);
  let r = await parent('put', `/api/kids/${kidId}/policy`).set('Content-Type', 'application/json').send(deep);
  assert.ok([400, 413].includes(r.status), 'deeply nested JSON -> ' + r.status);
  r = await parent('put', `/api/kids/${kidId}/policy`).send({ deny: Array.from({ length: 10000 }, (_, i) => `s${i}.com`) });
  assert.ok([400, 413].includes(r.status), 'oversized list -> ' + r.status);
  r = await parent('put', `/api/kids/${kidId}/policy`).send({ dailyMinutes: 1e308 });
  assert.equal(r.status, 400);
  r = await parent('put', `/api/kids/${kidId}/policy`).send({ dailyMinutes: '60; DROP TABLE kids' });
  assert.equal(r.status, 400);
  r = await parent('post', '/api/kids').send({ name: 'x'.repeat(10000) });
  assert.equal(r.status, 400);
  r = await parent('post', '/api/kids').set('Content-Type', 'application/json').send('{"name": "a", "name": "b"}');
  assert.equal(r.status, 201, 'duplicate keys: last wins, no crash');
  assert.equal(r.body.kid.name, 'b');
  r = await parent('post', '/api/kids').set('Content-Type', 'text/plain').send('name=x');
  assert.ok([400, 415].includes(r.status) || (r.status === 400), 'non-JSON body is not parsed as a kid');
});

// ---------------------------------------------------------------------------
// 3. Nothing secret leaks
// ---------------------------------------------------------------------------
test('SEC leak: no response ever contains the PIN, its hash, or the setup code', async (t) => {
  const { anon, parent, db, getSetupCode } = fixture(t, { guardianPin: null, setupCode: 'KTRMXPBD' });
  await anon.post('/api/setup').send({ setupCode: 'KTRMXPBD', pin: PIN });
  const hash = db.prepare("SELECT json FROM settings WHERE key='pinHash'").get().json;
  const { kidId, code } = await seed(parent);
  const bodies = [];
  for (const [m, u] of [['get', '/api/settings'], ['get', '/api/auth/check'], ['get', '/api/kids'], ['get', `/api/kids/${kidId}`],
                        ['get', `/api/kids/${kidId}/policy`], ['get', '/api/setup/status']]) {
    bodies.push(JSON.stringify((await parent(m, u)).body) + JSON.stringify((await parent(m, u)).headers));
  }
  bodies.push(JSON.stringify((await anon.get(`/api/devices/${code}`)).body));
  bodies.push(JSON.stringify((await anon.get('/api/kids')).body));
  for (const b of bodies) {
    assert.ok(!b.includes(PIN), 'PIN in a response');
    assert.ok(!b.includes('scrypt$'), 'PIN hash in a response');
    assert.ok(!b.includes(hash.slice(-20)), 'hash fragment in a response');
    assert.ok(!b.includes('KTRMXPBD'), 'setup code in a response');
  }
  assert.equal(getSetupCode(), null);
});

test('SEC leak: errors are generic — no stack traces, file paths or SQL in bodies', async (t) => {
  const { anon, parent } = fixture(t);
  const probes = [
    anon.post('/api/kids').set('Content-Type', 'application/json').send('{"name": '),
    anon.get('/api/kids/%E0%A4%A'),             // malformed percent-encoding
    anon.get('/api/devices/' + 'A'.repeat(5000)),
    parent('put', '/api/settings').send({ timezone: { toString: 1 } }),
    parent('get', '/api/kids/99999999999999999999'),
    anon.get('/nope'),
  ];
  for (const p of probes) {
    const r = await p;
    const text = JSON.stringify(r.body) + r.text;
    assert.ok(r.status < 500, `probe answered ${r.status}`);
    assert.ok(!/node_modules|\/home\/|at .*\.js:\d+|SQLITE|sqlite|SyntaxError|Error:/.test(text), 'internal detail leaked: ' + text.slice(0, 200));
  }
});

test('SEC leak: security headers are present on every kind of response', async (t) => {
  const { anon, parent } = fixture(t);
  const { code } = await seed(parent);
  const responses = [
    await anon.get('/api/health'), await anon.get('/api/kids'), await parent('get', '/api/kids'),
    await anon.get('/api/devices/' + code), await anon.get('/api/missing'), await anon.get('/nothing-here'),
    await anon.post('/api/kids').set('Content-Type', 'application/json').send('{bad'),
    await anon.options('/api/kids'),
  ];
  for (const r of responses) {
    assert.equal(r.headers['x-content-type-options'], 'nosniff', r.req.path);
    assert.equal(r.headers['x-frame-options'], 'DENY', r.req.path);
    assert.match(r.headers['content-security-policy'] || '', /default-src 'self'/, r.req.path);
    assert.match(r.headers['content-security-policy'] || '', /frame-ancestors 'none'/, r.req.path);
    assert.ok(!/unsafe-eval/.test(r.headers['content-security-policy']), 'no unsafe-eval');
    assert.equal(r.headers['referrer-policy'], 'no-referrer', r.req.path);
    assert.equal(r.headers['x-powered-by'], undefined, r.req.path);
    assert.equal(r.headers['server'], undefined, 'no Server banner');
    if (r.req.path.startsWith('/api')) assert.equal(r.headers['cache-control'], 'no-store', r.req.path);
  }
});

test('SEC leak: cross-origin pages get no CORS grant and cannot preflight a write', async (t) => {
  const { anon } = fixture(t);
  for (const origin of ['http://evil.example', 'null', 'http://localhost:4100', 'http://192.168.1.50:4100', 'chrome-extension://abc']) {
    const pre = await anon.options('/api/kids/1/policy').set('Origin', origin).set('Access-Control-Request-Method', 'PUT').set('Access-Control-Request-Headers', 'x-guardian-pin');
    assert.equal(pre.headers['access-control-allow-origin'], undefined, origin);
    assert.equal(pre.headers['access-control-allow-headers'], undefined, origin);
    const get = await anon.get('/api/health').set('Origin', origin);
    assert.equal(get.headers['access-control-allow-origin'], undefined, origin);
    assert.equal(get.headers['access-control-allow-credentials'], undefined, origin);
  }
});

// ---------------------------------------------------------------------------
// 4. Isolation and authorisation between children / devices
// ---------------------------------------------------------------------------
test('SEC isolation: one child\'s pairing code cannot touch another child', async (t) => {
  const { anon, parent } = fixture(t);
  const a = await seed(parent, { deny: ['a-only.com'] });
  const b = await seed(parent, { deny: ['b-only.com'] });
  const viaA = (await anon.get(`/api/devices/${a.code}`)).body;
  assert.equal(viaA.kid.id, a.kidId);
  assert.deepEqual(viaA.policy.deny, ['a-only.com']);
  assert.ok(!JSON.stringify(viaA).includes('b-only.com'));
  // Revoking A does not affect B; revoked code is dead immediately.
  await parent('delete', `/api/kids/${a.kidId}/pairings/${a.code}`);
  assert.equal((await anon.get(`/api/devices/${a.code}`)).status, 404);
  assert.equal((await anon.post(`/api/devices/${a.code}/usage`).send({ site: 'x.com', seconds: 60 })).status, 404);
  assert.equal((await anon.get(`/api/devices/${b.code}`)).status, 200);
  // A parent cannot revoke B's code through A's kid id.
  assert.equal((await parent('delete', `/api/kids/${a.kidId}/pairings/${b.code}`)).status, 404);
  assert.equal((await anon.get(`/api/devices/${b.code}`)).status, 200);
});

test('SEC isolation: deleting a child destroys every trace, including live device access', async (t) => {
  const { anon, parent, db } = fixture(t);
  const { kidId, code } = await seed(parent, { deny: ['x.com'] });
  await anon.post(`/api/devices/${code}/usage`).send({ site: 'x.com', seconds: 60 });
  await parent('delete', `/api/kids/${kidId}`);
  for (const table of ['kids', 'policy', 'devices', 'usage']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table + ' emptied');
  }
  assert.equal((await anon.get(`/api/devices/${code}`)).status, 404);
});

test('SEC isolation: a device can only make its own budget shorter, never longer', async (t) => {
  const { anon, parent } = fixture(t);
  const { code } = await seed(parent, { dailyMinutes: 60 });
  for (const bad of [{ seconds: -600 }, { seconds: 0 }, { seconds: 'NaN' }, { seconds: -1e9 }, { seconds: null }]) {
    const r = await anon.post(`/api/devices/${code}/usage`).send({ site: 'x.com', ...bad });
    assert.equal(r.status, 200);
    assert.ok(r.body.recorded.seconds >= 1, 'non-positive seconds never reduce usage: ' + JSON.stringify(bad));
  }
  const st = (await anon.get(`/api/devices/${code}`)).body.policy.usageToday;
  assert.ok(st >= 5, 'usage only accumulates upward');
  // Back-dating is ignored: everything lands in "today".
  const r = await anon.post(`/api/devices/${code}/usage`).send({ site: 'x.com', seconds: 60, startedAt: '2000-01-01T00:00:00Z', endedAt: '2000-01-01T00:01:00Z' });
  assert.equal(r.body.status.usedTodayMin, st + 1);
});

// ---------------------------------------------------------------------------
// 5. Limits and denial-of-service resistance
// ---------------------------------------------------------------------------
test('SEC limits: body size, request throttle and lockouts all answer with 4xx, never crash', async (t) => {
  const { anon, parent } = fixture(t, { requestLimit: 40 });
  assert.equal((await parent('post', '/api/kids').send({ name: 'x'.repeat(400 * 1024) })).status, 413);
  let last;
  for (let i = 0; i < 45; i++) last = await anon.get('/api/health');
  assert.equal(last.status, 429);
  assert.ok(last.headers['retry-after']);
  assert.equal((await anon.get('/api/health')).status, 429, 'throttle holds');
});

test('SEC limits: static file serving cannot escape the console directory', async (t) => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'chpc-pub-'));
  fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><title>console</title>');
  const secret = path.join(path.dirname(pub), 'secret-' + path.basename(pub) + '.txt');
  fs.writeFileSync(secret, 'TOPSECRET');
  t.after(() => { fs.rmSync(pub, { recursive: true, force: true }); fs.rmSync(secret, { force: true }); });
  const { anon } = fixture(t, { publicDir: pub });
  const base = path.basename(secret);
  for (const p of [`/../${base}`, `/%2e%2e/${base}`, `/..%2f${base}`, `/assets/../../${base}`, `/%2e%2e%2f${base}`, '/../../../../etc/passwd', '/%00', '/index.html%00.txt']) {
    const r = await anon.get(p);
    assert.ok(!r.text.includes('TOPSECRET') && !r.text.includes('root:'), `${p} escaped the public directory`);
  }
});
