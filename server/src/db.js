// @chpc/server — data layer (node:sqlite, no native deps).
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function defaultDir() {
  return path.join(process.cwd(), 'data');
}

export function openDb(file) {
  const dbFile = file || process.env.CHPC_DB || path.join(defaultDir(), 'chpc.db');
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbFile);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS kids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS policy (
      kid_id INTEGER PRIMARY KEY REFERENCES kids(id) ON DELETE CASCADE,
      json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    -- One row per reported slice of browsing. Only the hostname is kept
    -- (data minimisation): full URLs are never written.
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kid_id INTEGER NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
      site TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      seconds INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_usage_kid_ts ON usage(kid_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(started_at);

    CREATE TABLE IF NOT EXISTS devices (
      code TEXT PRIMARY KEY,
      kid_id INTEGER NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      paired_at TEXT NOT NULL,
      last_seen TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      json TEXT NOT NULL
    );
  `);
  if (dbFile !== ':memory:') {
    try { fs.chmodSync(dbFile, 0o600); } catch { /* best effort (e.g. non-POSIX) */ }
  }
  return db;
}

const nowIso = () => new Date().toISOString();

/* ---------- settings ---------- */
export function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT json FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.json); } catch { return fallback; }
}
export function setSetting(db, key, value) {
  db.prepare(`INSERT INTO settings (key, json) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET json = excluded.json`)
    .run(key, JSON.stringify(value));
}

/* ---------- kids ---------- */
export function listKids(db) {
  return db.prepare('SELECT id, name, created_at FROM kids ORDER BY id').all();
}
export function getKid(db, id) {
  if (!Number.isInteger(id) || id < 1) return undefined;
  return db.prepare('SELECT id, name, created_at FROM kids WHERE id = ?').get(id);
}
export function createKid(db, name) {
  const r = db.prepare('INSERT INTO kids (name, created_at) VALUES (?, ?)').run(name, nowIso());
  const id = Number(r.lastInsertRowid);
  db.prepare('INSERT INTO policy (kid_id, json, updated_at) VALUES (?, ?, ?)')
    .run(id, JSON.stringify({}), nowIso());
  return getKid(db, id);
}
export function renameKid(db, id, name) {
  db.prepare('UPDATE kids SET name = ? WHERE id = ?').run(name, id);
  return getKid(db, id);
}
export function deleteKid(db, id) {
  db.prepare('DELETE FROM kids WHERE id = ?').run(id);
}

export function getPolicy(db, kidId) {
  const row = db.prepare('SELECT json, updated_at FROM policy WHERE kid_id = ?').get(kidId);
  if (!row) return {};
  try { return JSON.parse(row.json); } catch { return {}; }
}
export function setPolicy(db, kidId, policy) {
  db.prepare(`INSERT INTO policy (kid_id, json, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(kid_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`)
    .run(kidId, JSON.stringify(policy), nowIso());
}

/* ---------- devices ---------- */
export function listDevices(db, kidId = null) {
  const q = kidId == null
    ? 'SELECT * FROM devices ORDER BY paired_at DESC'
    : 'SELECT * FROM devices WHERE kid_id = ? ORDER BY paired_at DESC';
  return kidId == null ? db.prepare(q).all() : db.prepare(q).all(kidId);
}
export function deviceForCode(db, code) {
  const c = normalizeCode(code);
  if (!c) return undefined;
  return db.prepare('SELECT * FROM devices WHERE code = ?').get(c);
}
export function pairDevice(db, kidId, agentId) {
  // Retry on the (astronomically unlikely) primary-key collision.
  for (let i = 0; i < 5; i++) {
    const code = makeCode();
    try {
      db.prepare('INSERT INTO devices (code, kid_id, agent_id, paired_at) VALUES (?, ?, ?, ?)')
        .run(code, kidId, agentId, nowIso());
      return code;
    } catch (e) {
      if (!/UNIQUE|PRIMARY KEY/i.test(String(e && e.message))) throw e;
    }
  }
  throw new Error('could not mint a unique pairing code');
}
export function touchDevice(db, code) {
  db.prepare('UPDATE devices SET last_seen = ? WHERE code = ?').run(nowIso(), code);
}
export function deleteDevice(db, code) {
  db.prepare('DELETE FROM devices WHERE code = ?').run(code);
}

/* ---------- usage ---------- */
export function addUsage(db, { kidId, site, startedAt, endedAt, seconds }) {
  db.prepare(`INSERT INTO usage (kid_id, site, url, started_at, ended_at, seconds)
              VALUES (?, ?, '', ?, ?, ?)`)
    .run(kidId, site || '', startedAt || nowIso(), endedAt || nowIso(), seconds || 0);
}

export function kidUsageSinceMs(db, kidId, ms) {
  const row = db.prepare('SELECT COALESCE(SUM(seconds),0) AS s FROM usage WHERE kid_id = ? AND started_at >= ?')
    .get(kidId, new Date(ms).toISOString());
  return Number(row.s) || 0;
}

/** All usage rows for a kid since an epoch-ms (ASC). For per-site budget accounting. */
export function usageRowsSince(db, kidId, sinceMs) {
  return db.prepare('SELECT site, seconds, started_at FROM usage WHERE kid_id = ? AND started_at >= ? ORDER BY started_at ASC')
    .all(kidId, new Date(sinceMs).toISOString());
}

/** Summed seconds + row count for a kid between two epoch-ms instants [start, end). */
export function usageTotalBetween(db, kidId, startMs, endMs) {
  const row = db.prepare(
    'SELECT COALESCE(SUM(seconds), 0) AS s, COUNT(*) AS n FROM usage WHERE kid_id = ? AND started_at >= ? AND started_at < ?'
  ).get(kidId, new Date(startMs).toISOString(), new Date(endMs).toISOString());
  return { seconds: Number(row.s) || 0, visits: Number(row.n) || 0 };
}

/** Delete usage rows older than `days` days. Returns the number removed. */
export function purgeUsageOlderThan(db, days) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const r = db.prepare('DELETE FROM usage WHERE started_at < ?').run(cutoff);
  return Number(r.changes) || 0;
}

/* ---------- pairing codes ---------- */
// Unambiguous consonant alphabet (no vowels => no accidental words, no 0/O/1/I).
export const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const CODE_LENGTH = 8;

/** Cryptographically random pairing code, e.g. "KTRMXPBD". */
export function makeCode(len = CODE_LENGTH) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}

/** Canonical form of a typed code: uppercase letters only, or '' if hopeless. */
export function normalizeCode(input) {
  if (typeof input !== 'string') return '';
  const c = input.toUpperCase().replace(/[^A-Z]/g, '');
  return c.length >= 4 && c.length <= 16 ? c : '';
}

/** Display form: "KTRM-XPBD". */
export function formatCode(code) {
  return String(code || '').replace(/(.{4})(?=.)/g, '$1-');
}
