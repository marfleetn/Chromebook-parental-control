// @chpc/server — Express API.
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import {
  openDb, listKids, getKid, createKid, deleteKid,
  getPolicy, setPolicy,
  listDevices, deviceForCode, pairDevice, touchDevice, deleteDevice,
  getSetting, setSetting,
  addUsage, usageRowsSince,
} from './db.js';
import { effectivePolicyForKid, kidStatus, dayStartMs } from './status.js';
import { decide, remainingDaily, ruleMatchesHost } from '@chpc/core';

const DEFAULT_TZ = 'Europe/London';

export function createApp(opts = {}) {
  const dbFile = opts.dbFile || process.env.CHPC_DB || path.join(process.cwd(), 'data', 'chpc.db');
  const db = openDb(dbFile);
  const publicDir = opts.publicDir ? path.resolve(opts.publicDir) : null;

  const tzOf = (req) =>
    req?.headers?.['x-chpc-tz'] ||
    getSetting(db, 'tz', undefined) ||
    DEFAULT_TZ;

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '256kb' }));

  const err = (res, code, msg, extra = {}) =>
    res.status(code).json({ error: msg, ...extra });
  const kidOr404 = (res, id) => {
    const k = getKid(db, Number(id));
    if (!k) { err(res, 404, 'kid not found'); return null; }
    return k;
  };
  const pubDev = (d) => ({
    code: d.code, kidId: d.kid_id,
    agentId: d.agent_id && d.agent_id.length > 6 ? d.agent_id.slice(0,3)+'\u2026'+d.agent_id.slice(-3) : d.agent_id,
    pairedAt: d.paired_at, lastSeen: d.last_seen,
  });

  app.get('/api/health', (req, res) =>
    res.json({ ok: true, service: 'chpc-server', time: new Date().toISOString() }));

  app.get('/api/settings', (req, res) =>
    res.json({ timezone: getSetting(db, 'tz', DEFAULT_TZ) }));
  app.put('/api/settings', (req, res) => {
    if (req.body && typeof req.body.timezone === 'string' && req.body.timezone) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: req.body.timezone }); }
      catch { return err(res, 400, 'timezone is not a valid IANA time zone'); }
      setSetting(db, 'tz', req.body.timezone);
    }
    res.json({ timezone: getSetting(db, 'tz', DEFAULT_TZ) });
  });

  app.get('/api/kids', (req, res) => {
    const now = Date.now();
    const tz = tzOf(req);
    res.json({ kids: listKids(db).map((k) => ({ ...k, status: kidStatus(db, k.id, now, tz) })) });
  });
  app.post('/api/kids', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return err(res, 400, 'name is required');
    res.status(201).json({ kid: createKid(db, name) });
  });
  app.get('/api/kids/:id', (req, res) => {
    const k = kidOr404(res, req.params.id);
    if (!k) return;
    const now = Date.now();
    const tz = tzOf(req);
    res.json({
      kid: k,
      policy: getPolicy(db, k.id),
      status: kidStatus(db, k.id, now, tz),
      devices: listDevices(db, k.id).map(pubDev),
    });
  });
  app.delete('/api/kids/:id', (req, res) => {
    const k = kidOr404(res, req.params.id);
    if (!k) return;
    deleteKid(db, k.id);
    res.json({ deleted: k.id });
  });

  app.get('/api/kids/:id/policy', (req, res) => {
    const k = kidOr404(res, req.params.id);
    if (!k) return;
    const tz = tzOf(req);
    const now = Date.now();
    res.json({
      policy: getPolicy(db, k.id),
      effective: effectivePolicyForKid(db, k.id, now, tz),
    });
  });
  app.put('/api/kids/:id/policy', (req, res) => {
    const k = kidOr404(res, req.params.id);
    if (!k) return;
    const p = validatePolicy(req.body);
    if (p.error) return err(res, 400, p.error, { field: p.field });
    setPolicy(db, k.id, p.policy);
    res.json({ policy: p.policy, updatedAt: new Date().toISOString() });
  });

  app.post('/api/kids/:id/pairings', (req, res) => {
    const k = kidOr404(res, req.params.id);
    if (!k) return;
    const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId.slice(0, 200) : '';
    const code = pairDevice(db, k.id, agentId || 'pending');
    res.status(201).json({ code, pairedAt: new Date().toISOString() });
  });
  app.delete('/api/kids/:id/pairings/:code', (req, res) => {
    const k = kidOr404(res, req.params.id);
    if (!k) return;
    const d = deviceForCode(db, String(req.params.code || '').trim());
    if (!d || d.kid_id !== k.id) return err(res, 404, 'device not found for this kid');
    deleteDevice(db, d.code);
    res.json({ deleted: d.code });
  });

  app.get('/api/devices/:code', (req, res) => {
    const d = deviceForCode(db, String(req.params.code || '').trim());
    if (!d) return err(res, 404, 'unknown pairing code');
    const tz = tzOf(req);
    const kid = getKid(db, d.kid_id);
    const now = Date.now();
    const policy = effectivePolicyForKid(db, d.kid_id, now, tz);
    const rawHost = String(req.query.host || '').trim().toLowerCase();
    const host = rawHost ? (rawHost.includes('.') ? rawHost : `*${rawHost}`) : null;
    res.json({
      device: pubDev(d),
      kid,
      policy,
      decision: host ? decide(policy, host, { now, tz }) : null,
    });
  });
  app.post('/api/devices/:code/heartbeat', (req, res) => {
    const d = deviceForCode(db, String(req.params.code || '').trim());
    if (!d) return err(res, 404, 'unknown pairing code');
    touchDevice(db, d.code);
    res.json({ ok: true, timeZone: getSetting(db, 'tz', DEFAULT_TZ) });
  });
  app.post('/api/devices/:code/usage', (req, res) => {
    const d = deviceForCode(db, String(req.params.code || '').trim());
    if (!d) return err(res, 404, 'unknown pairing code');
    const tz = tzOf(req);
    const body = req.body || {};
    const url = typeof body.url === 'string' ? body.url : '';
    const site = typeof body.site === 'string' && body.site
      ? body.site
      : (url ? safeHost(url) : '');
    const now = Date.now();
    const startedAt = body.startedAt ? Date.parse(body.startedAt) : now;
    const endedAt = body.endedAt ? Date.parse(body.endedAt) : now;
    let seconds = Number(body.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      seconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
      if (!seconds) seconds = 60;
    }
    addUsage(db, {
      kidId: d.kid_id,
      site,
      url,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      seconds,
    });
    // Evaluate the decision on this URL so the extension can get a
    // consistent block reason without re-pulling the policy.
    const policy = effectivePolicyForKid(db, d.kid_id, now, tz);
    const decision = decide(policy, url || site || '*', { now, tz });
    res.json({
      ok: true,
      recorded: { site, seconds },
      decision,
    });
  });

  app.get('/api/kids/:id/usage/today', (req, res) => {
    const k = kidOr404(res, req.params.id);
    if (!k) return;
    const tz = tzOf(req);
    const now = Date.now();
    const rows = usageRowsSince(db, k.id, dayStartMs(now, tz));
    const bySite = new Map();
    for (const r of rows) {
      if (!r.site) continue;
      const s = bySite.get(r.site) || { site: r.site, seconds: 0, visits: 0 };
      s.seconds += Number(r.seconds) || 0;
      s.visits += 1;
      bySite.set(r.site, s);
    }
    const budgets = getPolicy(db, k.id).siteBudgets || [];
    const sites = [...bySite.values()]
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 50)
      .map((s) => {
        const match = budgets.find((b) => b && b.pattern != null && ruleMatchesHost(b.pattern, s.site));
        return {
          site: s.site,
          minutes: Math.floor(s.seconds / 60),
          visits: s.visits,
          budgetMinutes: match ? match.minutes : null,
        };
      });
    res.json({
      ts: now, tz,
      dayStart: new Date(dayStartMs(now, tz)).toISOString(),
      status: kidStatus(db, k.id, now, tz),
      sites,
    });
  });

  app.get('/api/kids/:id/usage/history', (req, res) => {
    const k = kidOr404(res, req.params.id);
    if (!k) return;
    const tz = tzOf(req);
    const days = clampInt(req.query.days, 1, 90, 7);
    const out = [];
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const todayStart = dayStartMs(now, tz);
    for (let i = 0; i < days; i++) {
      const end = i === 0 ? now : todayStart - (i - 1) * DAY;
      const start = end - DAY;
      const row = db.prepare(
        'SELECT COALESCE(SUM(seconds), 0) AS s, COUNT(*) AS n FROM usage WHERE kid_id = ? AND started_at >= ? AND started_at < ?'
      ).get(k.id, new Date(start).toISOString(), new Date(end).toISOString());
      out.push({
        isoDay: dateLabel(i === 0 ? todayStart : start, tz),
        minutes: Math.floor(Number(row.s) / 60),
        visits: Number(row.n),
      });
    }
    out.reverse();
    res.json({ days, perDay: out, timezone: tz });
  });

  if (publicDir && fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.get(/.html?$/, (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  }

  app.use((req, res) => err(res, 404, 'not found', { path: req.path }));
  app.use((e, req, res, _next) => {
    const status = e.status || 500;
    if (status >= 500) console.error('[chpc-server]', e);
    res.status(status).json({ error: status >= 500 ? 'server error' : (e.message || 'error') });
  });

  return { app, db };
}

// ---------- helpers ----------
function validatePolicy(body) {
  if (body === undefined || body === null) return { policy: {} };
  if (typeof body !== 'object' || Array.isArray(body)) return { error: 'policy must be a JSON object', field: 'body' };
  const p = { ...body };
  if (p.internetAllowed === undefined) p.internetAllowed = true;
  if (typeof p.internetAllowed !== 'boolean') return { error: 'internetAllowed must be a boolean', field: 'internetAllowed' };
  if (p.mode === undefined) p.mode = 'unrestricted';
  if (!['unrestricted', 'strict', 'denylist', 'allowlist'].includes(p.mode)) {
    return { error: 'invalid mode', field: 'mode' };
  }
  if (p.dailyMinutes !== undefined && p.dailyMinutes !== null) {
    if (!Number.isFinite(Number(p.dailyMinutes)) || Number(p.dailyMinutes) < 0) {
      return { error: 'dailyMinutes must be a non-negative number (minutes)', field: 'dailyMinutes' };
    }
    p.dailyMinutes = Number(p.dailyMinutes);
  }
  for (const key of ['deny', 'allow']) {
    if (p[key] === undefined) continue;
    if (!Array.isArray(p[key]) || !p[key].every((x) => typeof x === 'string' && x.trim().length)) {
      return { error: key + ' must be an array of non-empty strings', field: key };
    }
    p[key] = p[key].map((x) => x.trim().toLowerCase());
  }
  if (p.siteBudgets !== undefined) {
    if (!Array.isArray(p.siteBudgets)) return { error: 'siteBudgets must be an array', field: 'siteBudgets' };
    for (const sb of p.siteBudgets) {
      if (!sb || typeof sb !== 'object' || typeof sb.pattern !== 'string' || !sb.pattern.trim()) {
        return { error: 'siteBudgets entries need a non-empty pattern string', field: 'siteBudgets' };
      }
      if (sb.minutes !== undefined && (sb.minutes === null ? false : !Number.isFinite(Number(sb.minutes)))) {
        return { error: 'siteBudgets entries need a numeric minutes value', field: 'siteBudgets' };
      }
      sb.pattern = sb.pattern.trim().toLowerCase();
    }
  }
  if (p.windows !== undefined) {
    if (!Array.isArray(p.windows)) return { error: 'windows must be an array', field: 'windows' };
    for (const w of p.windows) {
      if (!w || typeof w !== 'object') return { error: 'windows entries must be objects', field: 'windows' };
      if (w.days !== undefined && (!Array.isArray(w.days) || !w.days.every((x) => ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].includes(x)))) {
        return { error: 'windows[*].days must be weekday names', field: 'windows.days' };
      }
      if (w.start !== undefined && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(w.start)) {
        return { error: 'windows[*].start must be HH:MM (24h)', field: 'windows.start' };
      }
      if (w.end !== undefined && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(w.end)) {
        return { error: 'windows[*].end must be HH:MM (24h)', field: 'windows.end' };
      }
    }
  }
  if (p.offDays !== undefined && !Array.isArray(p.offDays)) {
    return { error: 'offDays must be an array', field: 'offDays' };
  }
  return { policy: p };
}
function safeHost(u) { try { return new URL(u).hostname; } catch { return ''; } }
function dateLabel(ms, tz) {
  const p = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms))) p[type] = value;
  return `${p.year}-${p.month}-${p.day}`;
}
function clampInt(v, lo, hi, fb) {
  const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.min(hi, Math.max(lo, n));
}

