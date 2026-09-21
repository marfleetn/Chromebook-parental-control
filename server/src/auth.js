// @chpc/server — guardian PIN authentication + small in-memory rate limiter.
//
// Threat model: the API sits on the family LAN. Anyone on that LAN — and any
// web page the child visits (cross-origin fetch) — can reach it. Parent routes
// therefore require a shared secret (the guardian PIN) on every request, sent
// as `X-Guardian-PIN: <pin>` or `Authorization: Bearer <pin>`. Device routes
// authenticate with the pairing code in the path instead.
//
// Where the PIN comes from (first match wins):
//   1. CHPC_GUARDIAN_PIN in the environment (legacy / advanced installs);
//   2. a scrypt hash stored in the database by the first-run setup screen;
//   3. nothing yet -> "setup required": the server prints a one-time setup
//      code and the console lets the parent choose a PIN with it.
//
// Verification: env PINs compare SHA-256 digests in constant time; stored PINs
// verify with scrypt. Because every parent request carries the PIN, the digest
// of the last successfully verified PIN is cached in memory so scrypt runs
// once per process (or per PIN change), not once per request.
import crypto from 'node:crypto';

export const MIN_PIN_LENGTH = 6;
export const MAX_PIN_LENGTH = 128;

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();

/**
 * Sliding-window failure counter keyed by string (client IP).
 * `limit` failures within `windowMs` => blocked until the window drains.
 */
export class RateLimiter {
  constructor({ limit = 10, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }
  _prune(key) {
    const t = this.now();
    const arr = (this.hits.get(key) || []).filter((x) => t - x < this.windowMs);
    if (arr.length) this.hits.set(key, arr); else this.hits.delete(key);
    return arr;
  }
  /** True when `key` has exhausted its allowance. */
  blocked(key) {
    return this._prune(key).length >= this.limit;
  }
  /** Record one failure for `key`. */
  fail(key) {
    const arr = this._prune(key);
    arr.push(this.now());
    this.hits.set(key, arr);
    // Bound memory: never track more than a few thousand distinct clients.
    if (this.hits.size > 5000) this.hits.delete(this.hits.keys().next().value);
  }
  /** Forget failures for `key` (on success). */
  reset(key) {
    this.hits.delete(key);
  }
}

/**
 * Plain per-client request throttle for a route group: counts every request
 * (not just failures) in a sliding window and answers 429 past `limit`.
 * Generous by default (300/min) — the console polls a few times a minute.
 */
export function makeRequestLimiter({ limit = 300, windowMs = 60 * 1000, now = Date.now } = {}) {
  const rl = new RateLimiter({ limit, windowMs, now });
  return function requestLimiter(req, res, next) {
    const key = req.ip || 'unknown';
    if (rl.blocked(key)) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: 'too many requests — slow down', code: 'rate-limited' });
    }
    rl.fail(key); // count this request
    next();
  };
}

/** Validate a PIN chosen by the operator. Returns an error string or null. */
export function pinProblem(pin) {
  if (typeof pin !== 'string' || !pin) return 'the PIN is empty';
  if (pin.length < MIN_PIN_LENGTH) return `the PIN must be at least ${MIN_PIN_LENGTH} characters`;
  if (pin.length > MAX_PIN_LENGTH) return `the PIN must be at most ${MAX_PIN_LENGTH} characters`;
  if (/^(.)\1+$/.test(pin) || /^(0123456789|123456789|12345678|1234567|123456|654321|password|qwerty)/i.test(pin)) {
    return 'the PIN is too guessable (repeated or sequential characters)';
  }
  return null;
}

/* ---------- stored PIN hashes (scrypt) ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/** Hash a PIN for storage: "scrypt$<salt b64>$<key b64>". */
export function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pin), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Constant-time check of `pin` against a hashPin() string. */
export function verifyPinHash(pin, stored) {
  if (typeof stored !== 'string') return false;
  const [algo, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const key = crypto.scryptSync(String(pin), salt, expected.length, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** Pull the supplied PIN out of a request, or null. */
export function pinFromRequest(req) {
  const h = req.get('x-guardian-pin');
  if (typeof h === 'string' && h) return h;
  const auth = req.get('authorization');
  if (typeof auth === 'string' && auth.length <= 512) {
    // "Bearer <token>" parsed without a regex (linear time on hostile input).
    const t = auth.trim();
    if (t.length > 7 && t.slice(0, 7).toLowerCase() === 'bearer ') {
      const token = t.slice(7).trim();
      if (token) return token;
    }
  }
  return null;
}

/**
 * Build the `requirePin` middleware.
 * @param {object} o
 *   getPin      () => { source: 'env'|'db'|'none', pin?: string, hash?: string }
 *   allowNoPin  serve parent routes without a PIN when source is 'none' (dev only)
 *   limiter     RateLimiter for failures per client
 *   log         warning logger
 * The returned middleware has `.invalidate()` to drop the verified-PIN cache
 * (call after the PIN changes) and `.verify(pin)` for direct checks.
 */
export function makeRequirePin({ getPin, allowNoPin = false, limiter = new RateLimiter(), log = console.warn } = {}) {
  let okDigest = null; // sha256 of the last PIN that verified successfully

  const verify = (supplied) => {
    if (typeof supplied !== 'string' || !supplied || supplied.length > MAX_PIN_LENGTH) return false;
    const digest = sha256(supplied);
    if (okDigest && crypto.timingSafeEqual(digest, okDigest)) return true;
    const cfg = getPin();
    let ok = false;
    if (cfg.source === 'env') ok = crypto.timingSafeEqual(digest, sha256(cfg.pin));
    else if (cfg.source === 'db') ok = verifyPinHash(supplied, cfg.hash);
    if (ok) okDigest = digest;
    return ok;
  };

  function requirePin(req, res, next) {
    const cfg = getPin();
    if (cfg.source === 'none') {
      if (allowNoPin) return next();
      return res.status(503).json({
        error: 'the guardian PIN has not been set up yet',
        code: 'setup-required',
        hint: 'open the console and enter the setup code shown in the server log',
      });
    }
    const key = req.ip || 'unknown';
    if (limiter.blocked(key)) {
      res.set('Retry-After', String(Math.ceil(limiter.windowMs / 1000)));
      return res.status(429).json({ error: 'too many failed PIN attempts — try again later', code: 'locked-out' });
    }
    const supplied = pinFromRequest(req);
    if (supplied == null) {
      res.set('WWW-Authenticate', 'Bearer realm="chpc"');
      return res.status(401).json({ error: 'guardian PIN required', code: 'pin-required' });
    }
    if (!verify(supplied)) {
      limiter.fail(key);
      log(`[chpc-server] bad guardian PIN from ${key}`);
      return res.status(401).json({ error: 'guardian PIN is wrong', code: 'pin-wrong' });
    }
    limiter.reset(key);
    next();
  }
  requirePin.invalidate = () => { okDigest = null; };
  requirePin.verify = verify;
  return requirePin;
}
