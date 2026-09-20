// @chpc/server — guardian PIN authentication + small in-memory rate limiter.
//
// Threat model: the API sits on the family LAN. Anyone on that LAN — and any
// web page the child visits (cross-origin fetch) — can reach it. Parent routes
// therefore require a shared secret (the guardian PIN) on every request, sent
// as `X-Guardian-PIN: <pin>` or `Authorization: Bearer <pin>`. Device routes
// authenticate with the pairing code in the path instead.
//
// The PIN is never stored; only its SHA-256 is kept in memory, and the
// comparison is constant-time. Failed attempts are rate-limited per client
// IP so a 6-digit PIN cannot be brute-forced over the LAN.
import crypto from 'node:crypto';

export const MIN_PIN_LENGTH = 6;

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

/** Validate a PIN chosen by the operator. Returns an error string or null. */
export function pinProblem(pin) {
  if (typeof pin !== 'string' || !pin) return 'CHPC_GUARDIAN_PIN is not set';
  if (pin.length < MIN_PIN_LENGTH) return `CHPC_GUARDIAN_PIN must be at least ${MIN_PIN_LENGTH} characters`;
  if (/^(.)\1+$/.test(pin) || /^(0123456789|123456789|12345678|1234567|123456|654321|password|qwerty)/i.test(pin)) {
    return 'CHPC_GUARDIAN_PIN is too guessable (repeated or sequential characters)';
  }
  return null;
}

/** Pull the supplied PIN out of a request, or null. */
export function pinFromRequest(req) {
  const h = req.get('x-guardian-pin');
  if (typeof h === 'string' && h) return h;
  const auth = req.get('authorization');
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1];
  }
  return null;
}

/**
 * Build the `requirePin` middleware.
 * @param {object} o  { pin: string|null, allowNoPin: boolean, limiter?: RateLimiter, log?: fn }
 */
export function makeRequirePin({ pin, allowNoPin = false, limiter = new RateLimiter(), log = console.warn } = {}) {
  const pinHash = pin ? sha256(pin) : null;

  return function requirePin(req, res, next) {
    if (!pinHash) {
      if (allowNoPin) return next();
      return res.status(503).json({
        error: 'guardian PIN is not configured on the server',
        hint: 'set CHPC_GUARDIAN_PIN (at least 6 characters) and restart',
      });
    }
    const key = req.ip || 'unknown';
    if (limiter.blocked(key)) {
      res.set('Retry-After', String(Math.ceil(limiter.windowMs / 1000)));
      return res.status(429).json({ error: 'too many failed PIN attempts — try again later' });
    }
    const supplied = pinFromRequest(req);
    if (supplied == null) {
      res.set('WWW-Authenticate', 'Bearer realm="chpc"');
      return res.status(401).json({ error: 'guardian PIN required', code: 'pin-required' });
    }
    const ok = crypto.timingSafeEqual(sha256(supplied), pinHash);
    if (!ok) {
      limiter.fail(key);
      log(`[chpc-server] bad guardian PIN from ${key}`);
      return res.status(401).json({ error: 'guardian PIN is wrong', code: 'pin-wrong' });
    }
    limiter.reset(key);
    next();
  };
}
