// @chpc/server — data layer (node:sqlite, no native deps).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

function defaultDir() {
  return path.join(process.cwd(), 'data');
}

export function openDb(file) {
  const dbFile = file || process.env.CHPC_DB || path.join(defaultDir(), 'chpc.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`
    PRAGMA foreign_keys = ON;

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
  return db.prepare('SELECT id, name, created_at FROM kids WHERE id = ?').get(id);
}
export function createKid(db, name) {
  const r = db.prepare('INSERT INTO kids (name, created_at) VALUES (?, ?)').run(name, nowIso());
  const id = Number(r.lastInsertRowid);
  db.prepare('INSERT INTO policy (kid_id, json, updated_at) VALUES (?, ?, ?)')
    .run(id, JSON.stringify({}), nowIso());
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
export function codeForKid(db, kidId) {
  return db.prepare('SELECT code FROM devices WHERE kid_id = ? ORDER BY paired_at DESC LIMIT 1').get(kidId);
}
export function deviceForCode(db, code) {
  return db.prepare('SELECT * FROM devices WHERE code = ?').get(code);
}
export function pairDevice(db, kidId, agentId) {
  const code = makeCode();
  db.prepare('INSERT INTO devices (code, kid_id, agent_id, paired_at) VALUES (?, ?, ?, ?)')
    .run(code, kidId, agentId, nowIso());
  return code;
}
export function touchDevice(db, code) {
  db.prepare('UPDATE devices SET last_seen = ? WHERE code = ?').run(nowIso(), code);
}
export function deleteDevice(db, code) {
  db.prepare('DELETE FROM devices WHERE code = ?').run(code);
}

/* ---------- usage ---------- */
export function addUsage(db, { kidId, site, url, startedAt, endedAt, seconds }) {
  db.prepare(`INSERT INTO usage (kid_id, site, url, started_at, ended_at, seconds)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(kidId, site || '', url || '', startedAt || nowIso(), endedAt || nowIso(), seconds || 0);
}

export function kidUsageSinceMs(db, kidId, ms) {
  const row = db.prepare('SELECT COALESCE(SUM(seconds),0) AS s FROM usage WHERE kid_id = ? AND started_at >= ?')
    .get(kidId, new Date(ms).toISOString());
  return Number(row.s) || 0;
}
export function siteUsageSinceMs(db, kidId, site, ms) {
  const row = db.prepare('SELECT COALESCE(SUM(seconds),0) AS s FROM usage WHERE kid_id = ? AND site = ? AND started_at >= ?')
    .get(kidId, site, new Date(ms).toISOString());
  return Number(row.s) || 0;
}
export function activity(db, kidId, sinceMs, limit = 100) {
  return db.prepare('SELECT * FROM usage WHERE kid_id = ? AND started_at >= ? ORDER BY started_at DESC LIMIT ?')
    .all(kidId, new Date(sinceMs).toISOString(), limit);
}

/** All usage rows for a kid since an epoch-ms (no limit, ASC). For per-site budget accounting. */
export function usageRowsSince(db, kidId, sinceMs) {
  return db.prepare('SELECT * FROM usage WHERE kid_id = ? AND started_at >= ? ORDER BY started_at ASC')
    .all(kidId, new Date(sinceMs).toISOString());
}

const CHARS = 'BCDFGHJKLMNPQRSTVWXZ';  // unambiguous 22-char alphabet
export function makeCode(len = 6) {
  let s = '';
  for (let i = 0; i < len; i++) s += CHARS[Math.floor(Math.random() * CHARS.length)];
  return s;
}
