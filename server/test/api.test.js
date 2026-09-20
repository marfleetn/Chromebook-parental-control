// @chpc/server — integration tests (node --test + supertest over real HTTP).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chpc-test-'));
  const { app } = createApp({ dbFile: path.join(dir, 'chpc.db') });
  return { app, dir };
}

test('GET /api/health', async (t) => {
  const { app, dir } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.service, 'chpc-server');
});

test('GET /api/settings defaults + PUT', async (t) => {
  const { app, dir } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let res = await request(app).get('/api/settings');
  assert.equal(res.status, 200);
  assert.equal(res.body.timezone, 'Europe/London');

  res = await request(app).put('/api/settings').send({ timezone: 'America/New_York' });
  assert.equal(res.status, 200);
  assert.equal(res.body.timezone, 'America/New_York');

  res = await request(app).put('/api/settings').send({ timezone: 'Not/AZure' });
  assert.equal(res.status, 400);

  res = await request(app).get('/api/settings');
  assert.equal(res.body.timezone, 'America/New_York');
});

test('kids CRUD + 404s', async (t) => {
  const { app, dir } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let res = await request(app).get('/api/kids');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.kids, []);

  res = await request(app).post('/api/kids').send({});
  assert.equal(res.status, 400);

  res = await request(app).post('/api/kids').send({ name: '  Maya  ' });
  assert.equal(res.status, 201);
  assert.equal(res.body.kid.name, 'Maya');
  const id = res.body.kid.id;

  res = await request(app).get('/api/kids');
  assert.equal(res.body.kids.length, 1);
  assert.ok(res.body.kids[0].status);

  res = await request(app).get('/api/kids/9999');
  assert.equal(res.status, 404);

  res = await request(app).delete('/api/kids/9999');
  assert.equal(res.status, 404);

  res = await request(app).delete('/api/kids/' + id);
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted, id);

  res = await request(app).get('/api/kids');
  assert.deepEqual(res.body.kids, []);
});

test('policy validation + storage', async (t) => {
  const { app, dir } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let res = await request(app).post('/api/kids').send({ name: 'Leo' });
  const id = res.body.kid.id;

  res = await request(app).get('/api/kids/' + id + '/policy');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.policy, {});
  assert.equal(res.body.effective.internetAllowed, true);
  assert.equal(res.body.effective.mode, 'unrestricted');

  const policy = {
    mode: 'denylist',
    dailyMinutes: 60,
    deny: ['reddit.com'],
    siteBudgets: [{ pattern: 'youtube.com', minutes: 30 }],
    windows: [{ days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], start: '16:00', end: '21:00' }],
  };
  res = await request(app).put('/api/kids/' + id + '/policy').send(policy);
  assert.equal(res.status, 200);
  assert.equal(res.body.policy.dailyMinutes, 60);
  assert.equal(res.body.policy.deny[0], 'reddit.com');

  for (const bad of [
    { mode: 'sometimes' },
    { dailyMinutes: -5 },
    { dailyMinutes: 'sixty' },
    { deny: 'reddit.com' },
    { siteBudgets: [{ minutes: 5 }] },
    { windows: [{ start: '25:99' }] },
    { windows: 'nope' },
  ]) {
    const r = await request(app).put('/api/kids/' + id + '/policy').send(bad);
    assert.equal(r.status, 400, 'expected 400 for ' + JSON.stringify(bad) + ' got ' + r.status);
  }

  res = await request(app).get('/api/kids/' + id + '/policy');
  assert.equal(res.body.policy.dailyMinutes, 60);
});

test('pairing flow + device endpoints', async (t) => {
  const { app, dir } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let res = await request(app).post('/api/kids').send({ name: 'Isla' });
  const kidId = res.body.kid.id;

  res = await request(app).post('/api/kids/' + kidId + '/pairings').send({ agentId: 'chromebook-xyz' });
  assert.equal(res.status, 201);
  const code = res.body.code;
  assert.match(code, /^[BCDFGHJKLMNPQRSTVWXZ]{6}$/);

  res = await request(app).get('/api/devices/' + code);
  assert.equal(res.status, 200);
  assert.equal(res.body.kid.id, kidId);
  assert.equal(res.body.policy.mode, 'unrestricted');
  assert.equal(res.body.device.agentId, 'chr\u2026xyz');

  res = await request(app).post('/api/devices/' + code + '/heartbeat').send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.timeZone, 'Europe/London');

  res = await request(app).get('/api/devices/NOPE');
  assert.equal(res.status, 404);
});

test('usage reporting records + decision', async (t) => {
  const { app, dir } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let res = await request(app).post('/api/kids').send({ name: 'Theo' });
  const kidId = res.body.kid.id;

  await request(app).put('/api/kids/' + kidId + '/policy').send({
    mode: 'denylist',
    dailyMinutes: 60,
    deny: ['reddit.com'],
  });
  const pair = await request(app).post('/api/kids/' + kidId + '/pairings').send({});
  const code = pair.body.code;

  // allowed site
  let r = await request(app)
    .post('/api/devices/' + code + '/usage')
    .send({ url: 'https://bbc.co.uk/news', seconds: 300 });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.decision.allowed, true);

  // denied site -> decision.allowed false, code denied
  r = await request(app)
    .post('/api/devices/' + code + '/usage')
    .send({ url: 'https://www.reddit.com/r/ask', seconds: 120 });
  assert.equal(r.status, 200);
  assert.equal(r.body.decision.allowed, false);
  assert.equal(r.body.decision.code, 'site-denied');

  // budget exhausted -> 67 min used on a 60 min budget
  for (let i = 0; i < 12; i++) {
    await request(app)
      .post('/api/devices/' + code + '/usage')
      .send({ url: 'https://bbc.co.uk/', seconds: 300 }); // 5 min x 12 = 60 min
  }
  // 300s + 120s + 3600s = 4020s = 67 min used. Next site decision must be budget_exceeded.
  r = await request(app)
    .post('/api/devices/' + code + '/usage')
    .send({ url: 'https://bbc.co.uk/', seconds: 60 });
  assert.equal(r.body.decision.allowed, false);
  assert.equal(r.body.decision.code, 'daily-budget');
});

test('today usage dashboard aggregates sites + budgets', async (t) => {
  const { app, dir } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let res = await request(app).post('/api/kids').send({ name: 'Ada' });
  const kidId = res.body.kid.id;
  await request(app).put('/api/kids/' + kidId + '/policy').send({
    mode: 'denylist',
    dailyMinutes: 240,
    siteBudgets: [{ pattern: 'youtube.com', minutes: 45 }],
  });
  const code = (await request(app).post('/api/kids/' + kidId + '/pairings').send({})).body.code;

  await request(app).post('/api/devices/' + code + '/usage').send({ url: 'https://www.youtube.com/watch?v=abc', seconds: 1200, site: 'youtube.com' });
  await request(app).post('/api/devices/' + code + '/usage').send({ url: 'https://youtube.com/shorts', seconds: 600, site: 'youtube.com' });
  await request(app).post('/api/devices/' + code + '/usage').send({ url: 'https://bbc.co.uk/news', seconds: 300, site: 'bbc.co.uk' });

  const r = await request(app).get('/api/kids/' + kidId + '/usage/today');
  assert.equal(r.status, 200);
  const sites = r.body.sites;
  // youtube totals 30 min, budget 45 min; bbc 5 min, no budget
  const yt = sites.find((s) => s.site === 'youtube.com');
  assert.equal(yt.minutes, 30);
  assert.equal(yt.visits, 2);
  assert.equal(yt.budgetMinutes, 45);
  const bbc = sites.find((s) => s.site === 'bbc.co.uk');
  assert.equal(bbc.minutes, 5);
  assert.equal(bbc.budgetMinutes, null);
});

test('history returns requested day count', async (t) => {
  const { app, dir } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const kidId = (await request(app).post('/api/kids').send({ name: 'Rae' })).body.kid.id;
  const code = (await request(app).post('/api/kids/' + kidId + '/pairings').send({})).body.code;
  await request(app).post('/api/devices/' + code + '/usage').send({ url: 'https://bbc.co.uk', seconds: 600 });

  let r = await request(app).get('/api/kids/' + kidId + '/usage/history?days=3');
  assert.equal(r.status, 200);
  assert.equal(r.body.perDay.length, 3);
  assert.equal(r.body.perDay[r.body.perDay.length - 1].minutes, 10); // today (oldest-first)

  r = await request(app).get('/api/kids/' + kidId + '/usage/history?days=999');
  assert.equal(r.body.perDay.length, 90); // clamped
});

test('internet off blocks everything (end-to-end with decide())', async (t) => {
  const { app, dir } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const kidId = (await request(app).post('/api/kids').send({ name: 'NoNet' })).body.kid.id;
  await request(app).put('/api/kids/' + kidId + '/policy').send({ internetAllowed: false });
  const code = (await request(app).post('/api/kids/' + kidId + '/pairings').send({})).body.code;

  const r = await request(app)
    .post('/api/devices/' + code + '/usage')
    .send({ url: 'https://bbc.co.uk', seconds: 10 });
  assert.equal(r.body.decision.allowed, false);
  assert.equal(r.body.decision.code, 'disabled');
});

test('unknown device usage -> 404', async (t) => {
  const { app, dir } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = await request(app).post('/api/devices/ZZZZZZ/usage').send({ url: 'https://x.com', seconds: 10 });
  assert.equal(r.status, 404);
});
