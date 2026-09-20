// @chpc/server — Express API.
//
// Route families and who may call them:
//   /api/health                 anyone (liveness; reveals nothing)
//   /api/devices/:code/*        the paired Chromebook — the pairing code IS the credential
//   /api/auth/check, /api/settings, /api/kids/**   the parent — guardian PIN required
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  openDb, listKids, getKid, createKid, renameKid, deleteKid,
  getPolicy, setPolicy,
  listDevices, deviceForCode, pairDevice, touchDevice, deleteDevice,
  getSetting, setSetting,
  addUsage, usageRowsSince, usageTotalBetween, purgeUsageOlderThan, formatCode, makeCode, normalizeCode,
} from './db.js';
import { effectivePolicyForKid, kidStatus, dayStartMs } from './status.js';
import { makeRequirePin, RateLimiter, hashPin, pinProblem } from './auth.js';
import {
  validatePolicy, validateName, validateAgentId, validTimeZone, clampInt, LIMITS,
} from './validate.js';
import { decide, ruleMatchesHost, getHost } from '@chpc/core';

const DEFAULT_TZ = 'Europe/London';
const DAY = 24 * 60 * 60 * 1000;

/**
 * @param {object} opts
 *   dbFile          SQLite path (default ./data/chpc.db)
 *   publicDir       built console to serve at / (optional)
 *   guardianPin     PIN fixed by the environment (CHPC_GUARDIAN_PIN); null = use the
 *                   hash stored in the database, or first-run setup if there is none
 *   allowNoPin      serve parent routes without a PIN while none is set (loopback dev only)
 *   setupCode       override the generated one-time setup code (tests)
 *   setupCodeFile   path to write the setup code to (0600) while setup is pending
 *   corsOrigins     array of origins allowed to call the API cross-origin (default none)
 *   trustProxy      express 'trust proxy' setting (default false)
 *   retentionDays   purge usage older than this at startup / on purge() (0 = keep forever)
 *   log             logger fn for warnings (default console.warn)
 */
export function createApp(opts = {}) {
  const dbFile = opts.dbFile || process.env.CHPC_DB || path.join(process.cwd(), 'data', 'chpc.db');
  const db = openDb(dbFile);
  const publicDir = opts.publicDir ? path.resolve(opts.publicDir) : null;
  const log = opts.log || console.warn;
  const corsOrigins = Array.isArray(opts.corsOrigins) ? opts.corsOrigins.filter(Boolean) : [];
  const retentionDays = Number.isFinite(Number(opts.retentionDays)) ? Number(opts.retentionDays) : 0;

  const tzOf = () => {
    const tz = getSetting(db, 'tz', undefined);
    return validTimeZone(tz) ? tz : DEFAULT_TZ;
  };

  const app = express();
  app.disable('x-powered-by');
  if (opts.trustProxy) app.set('trust proxy', opts.trustProxy);

  // ---- security headers + CORS ---------------------------------------------
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    res.set('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');

    const origin = req.get('origin');
    if (origin && corsOrigins.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, X-Guardian-PIN, Authorization');
      res.set('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
  app.use(express.json({ limit: '256kb' }));

  // ---- guardian PIN source ---------------------------------------------------
  const envPin = opts.guardianPin || null;
  const getPin = () => {
    if (envPin) return { source: 'env', pin: envPin };
    const hash = getSetting(db, 'pinHash', null);
    if (typeof hash === 'string' && hash) return { source: 'db', hash };
    return { source: 'none' };
  };
  const requirePin = makeRequirePin({
    getPin,
    allowNoPin: !!opts.allowNoPin,
    limiter: new RateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 }),
    log,
  });
  // First-run setup: while no PIN exists, a one-time code (printed by index.js,
  // optionally written to a 0600 file) authorises choosing one from the console.
  let setupCode = null;
  const setupLimiter = new RateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });
  const needsSetup = () => getPin().source === 'none' && !opts.allowNoPin;
  const writeSetupFile = () => {
    if (!opts.setupCodeFile) return;
    try {
      if (setupCode) fs.writeFileSync(opts.setupCodeFile, setupCode + '\n', { mode: 0o600 });
      else if (fs.existsSync(opts.setupCodeFile)) fs.unlinkSync(opts.setupCodeFile);
    } catch (e) { log('[chpc-server] could not update setup code file', e && e.message); }
  };
  if (needsSetup()) { setupCode = normalizeCode(opts.setupCode) || makeCode(); writeSetupFile(); }
  // Unknown pairing codes are rate-limited per client so codes can't be enumerated.
  const codeLimiter = new RateLimiter({ limit: 20, windowMs: 15 * 60 * 1000 });

  // ---- helpers -------------------------------------------------------------
  const err = (res, code, msg, extra = {}) => res.status(code).json({ error: msg, ...extra });
  const kidOr404 = (res, id) => {
    const n = Number(id);
    const k = Number.isInteger(n) ? getKid(db, n) : undefined;
    if (!k) { err(res, 404, 'kid not found'); return null; }
    return k;
  };
  const pubKid = (k) => ({ id: k.id, name: k.name, createdAt: k.created_at });
  const pubDev = (d) => ({
    code: d.code, codeDisplay: formatCode(d.code), kidId: d.kid_id,
    agentId: d.agent_id, pairedAt: d.paired_at, lastSeen: d.last_seen,
  });
  const deviceOr404 = (req, res) => {
    const d = deviceForCode(db, String(req.params.code || ''));
    if (!d) {
      const key = req.ip || 'unknown';
      codeLimiter.fail(key);
      err(res, 404, 'unknown pairing code');
      return null;
    }
    return d;
  };
  const codeGuard = (req, res, next) => {
    if (codeLimiter.blocked(req.ip || 'unknown')) {
      res.set('Retry-After', '900');
      return err(res, 429, 'too many unknown pairing codes from this address — try again later');
    }
    next();
  };

  // ---- public --------------------------------------------------------------
  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'chpc-server' }));

  // ---- first-run setup (public; guarded by the one-time setup code) ---------
  app.get('/api/setup/status', (req, res) =>
    res.json({ needsSetup: needsSetup(), pinSource: getPin().source }));
  app.post('/api/setup', (req, res) => {
    if (!needsSetup()) return err(res, 409, 'the guardian PIN is already set', { code: 'already-set-up' });
    const key = req.ip || 'unknown';
    if (setupLimiter.blocked(key)) {
      res.set('Retry-After', '900');
      return err(res, 429, 'too many setup attempts — try again later', { code: 'locked-out' });
    }
    const body = req.body || {};
    const supplied = normalizeCode(body.setupCode);
    if (!supplied || !setupCode || supplied.length !== setupCode.length ||
        !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(setupCode))) {
      setupLimiter.fail(key);
      return err(res, 401, 'setup code is wrong — it is printed in the server log', { code: 'setup-code-wrong', field: 'setupCode' });
    }
    const problem = pinProblem(body.pin);
    if (problem) return err(res, 400, problem, { field: 'pin' });
    setSetting(db, 'pinHash', hashPin(body.pin));
    setupCode = null;
    writeSetupFile();
    requirePin.invalidate();
    log('[chpc-server] guardian PIN set up from ' + key);
    res.status(201).json({ ok: true, pinSource: 'db' });
  });

  // ---- device routes (pairing-code auth) -----------------------------------
  app.get('/api/devices/:code', codeGuard, (req, res) => {
    const d = deviceOr404(req, res);
    if (!d) return;
    touchDevice(db, d.code);
    const tz = tzOf();
    const kid = getKid(db, d.kid_id);
    const now = Date.now();
    const policy = effectivePolicyForKid(db, d.kid_id, now, tz);
    const rawHost = typeof req.query.host === 'string' ? req.query.host.trim().toLowerCase().slice(0, LIMITS.pattern) : '';
    const host = rawHost ? getHost(rawHost) : null;
    res.json({
      device: { ...pubDev(d), timeZone: tz },
      kid: kid ? { id: kid.id, name: kid.name } : null,
      timeZone: tz,
      policy,
      decision: host ? decide(policy, host, { now, tz }) : null,
    });
  });
  app.post('/api/devices/:code/heartbeat', codeGuard, (req, res) => {
    const d = deviceOr404(req, res);
    if (!d) return;
    touchDevice(db, d.code);
    res.json({ ok: true, timeZone: tzOf() });
  });
  app.post('/api/devices/:code/usage', codeGuard, (req, res) => {
    const d = deviceOr404(req, res);
    if (!d) return;
    const tz = tzOf();
    const body = req.body || {};
    const now = Date.now();

    // Accept one report {site|url, seconds} or a batch {entries:[{site, seconds}]}.
    const entries = Array.isArray(body.entries) ? body.entries.slice(0, 100) : [body];
    const recorded = [];
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue;
      const url = typeof e.url === 'string' ? e.url : '';
      const site = getHost(typeof e.site === 'string' && e.site ? e.site : url);
      if (!site) continue;
      let seconds = Math.round(Number(e.seconds));
      if (!Number.isFinite(seconds) || seconds <= 0) seconds = 60;
      seconds = Math.min(seconds, LIMITS.usageSecondsMax);
      // The server clock is authoritative: a device cannot back-date usage.
      const stamp = new Date(now).toISOString();
      addUsage(db, { kidId: d.kid_id, site, startedAt: stamp, endedAt: stamp, seconds });
      recorded.push({ site, seconds });
    }
    touchDevice(db, d.code);

    const policy = effectivePolicyForKid(db, d.kid_id, now, tz);
    const single = entries.length === 1 && recorded.length === 1 ? recorded[0].site : null;
    res.json({
      ok: true,
      recorded: Array.isArray(body.entries) ? recorded : (recorded[0] || null),
      decision: single ? decide(policy, single, { now, tz }) : null,
      status: kidStatus(db, d.kid_id, now, tz),
    });
  });

  // ---- parent routes (guardian PIN) ----------------------------------------
  app.use(['/api/auth', '/api/settings', '/api/kids'], requirePin);

  app.get('/api/auth/check', (req, res) => res.json({ ok: true, pinSource: getPin().source }));
  app.put('/api/auth/pin', (req, res) => {
    if (getPin().source === 'env') {
      return err(res, 409, 'the PIN is fixed by CHPC_GUARDIAN_PIN on the server; change it there', { code: 'pin-managed-by-env' });
    }
    const problem = pinProblem(req.body?.pin);
    if (problem) return err(res, 400, problem, { field: 'pin' });
    setSetting(db, 'pinHash', hashPin(req.body.pin));
    requirePin.invalidate();
    log('[chpc-server] guardian PIN changed from ' + (req.ip || 'unknown'));
    res.json({ ok: true, pinSource: 'db' });
  });

  app.get('/api/settings', (req, res) => res.json({ timezone: tzOf(), retentionDays, pinSource: getPin().source }));
  app.put('/api/settings', (req, res) => {
    const tz = req.body && req.body.timezone;
    if (tz !== undefined) {
      if (!validTimeZone(tz)) return err(res, 400, 'timezone is not a valid IANA time zone', { field: 'timezone' });
      setSetting(db, 'tz', tz);
    }
    res.json({ timezone: tzOf(), retentionDays, pinSource: getPin().source });
  });

  app.get('/api/kids', (req, res) => {
    const now = Date.now();
    const tz = tzOf();
    res.json({
      kids: listKids(db).map((k) => ({
        ...pubKid(k),
        status: kidStatus(db, k.id, now, tz),
        devices: listDevices(db, k.id).map(pubDev),
      })),
    });
  });
  app.post('/api/kids', (req, res) => {
    const v = validateName(req.body?.name);
    if (v.error) return err(res, 400, v.error, { field: v.field });
    if (listKids(db).length >= 50) return err(res, 400, 'too many children (max 50)');
    res.status(201).json({ kid: pubKid(createKid(db, v.name)) });
  });
  app.get('/api/kids/:id', (req, res) => {
    const k = kidOr404(res, req.params.id);
    if (!k) return;
    const now = Date.now();
    const tz = tzOf();
    res.json({
      kid: pubKid(k),
      policy: getPolicy(db, k.id),
      status: kidStatus(db, k.id, now, tz),
      devices: listDevices(db, k.id).map(pubDev),
    });
  });
  app.patch('/api/kids/:id', (req, res) => {
    const k = kidOr404(res, req.params.id);
    if (!k) return;
    const v = validateName(req.body?.name);
    if (v.error) return err(res, 400, v.error, { field: v.field });
    res.json({ kid: pubKid(renameKid(db, k.id, v.name)) });
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
    res.json({
      policy: getPolicy(db, k.id),
      effective: effectivePolicyForKid(db, k.id, Date.now(), tzOf()),
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
    const v = validateAgentId(req.body?.agentId ?? req.body?.label);
    if (v.error) return err(res, 400, v.error, { field: v.field });
    if (listDevices(db, k.id).length >= 20) return err(res, 400, 'too many devices for this child (max 20)');
    const code = pairDevice(db, k.id, v.agentId);
    res.status(201).json({ code, codeDisplay: formatCode(code), pairedAt: new Date().toISOString() });
  });
  app.delete('/api/kids/:id/pairings/:code', (req, res) => {
    const k = kidOr404(res, req.params.id);
    if (!k) return;
    const d = deviceForCode(db, String(req.params.code || ''));
    if (!d || d.kid_id !== k.id) return err(res, 404, 'device not found for this kid');
    deleteDevice(db, d.code);
    res.json({ deleted: d.code });
  });

  app.get('/api/kids/:id/usage/today', (req, res) => {
    const k = kidOr404(res, req.params.id);
    if (!k) return;
    const tz = tzOf();
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
        return { site: s.site, minutes: Math.floor(s.seconds / 60), visits: s.visits, budgetMinutes: match ? match.minutes : null };
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
    const tz = tzOf();
    const days = clampInt(req.query.days, 1, 90, 7);
    const now = Date.now();
    const todayStart = dayStartMs(now, tz);
    const out = [];
    for (let i = 0; i < days; i++) {
      // Day i: [todayStart - i*DAY, todayStart - (i-1)*DAY), today runs to `now`.
      const start = todayStart - i * DAY;
      const end = i === 0 ? now : start + DAY;
      const t = usageTotalBetween(db, k.id, start, end);
      out.push({ isoDay: dateLabel(start, tz), minutes: Math.floor(t.seconds / 60), visits: t.visits });
    }
    out.reverse();
    res.json({ days, perDay: out, timezone: tz });
  });

  // ---- static console ------------------------------------------------------
  if (publicDir && fs.existsSync(publicDir)) {
    app.use(express.static(publicDir, { index: 'index.html', maxAge: '1h' }));
    app.get(/^\/(?!api(\/|$)).*/, (req, res, next) => {
      if (!req.accepts('html')) return next();
      res.set('Cache-Control', 'no-cache');
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  }

  app.use((req, res) => err(res, 404, 'not found'));
  // eslint-disable-next-line no-unused-vars
  app.use((e, req, res, _next) => {
    const status = e.status || e.statusCode || 500;
    if (status >= 500) log('[chpc-server]', e);
    if (e.type === 'entity.parse.failed') return err(res, 400, 'request body is not valid JSON');
    if (e.type === 'entity.too.large') return err(res, 413, 'request body too large');
    res.status(status).json({ error: status >= 500 ? 'server error' : (e.message || 'error') });
  });

  const purge = () => (retentionDays > 0 ? purgeUsageOlderThan(db, retentionDays) : 0);
  purge();

  return { app, db, purge, getSetupCode: () => setupCode, needsSetup };
}

// ---------- helpers ----------
function dateLabel(ms, tz) {
  const p = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms))) p[type] = value;
  return `${p.year}-${p.month}-${p.day}`;
}
