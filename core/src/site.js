/**
 * @chpc/core — URL/site classification helpers.
 *
 * "Allow/deny lists" are matched against the **hostname** of a URL, not the
 * full path, so `youtube.com` also covers `m.youtube.com` and `www.youtube.com`.
 * Rules support a few convenience patterns:
 *   - bare hostname or subdomain-suffix: `youtube.com` matches any *.youtube.com
 *   - `*.example.com` explicitly (same behaviour)
 *   - `example.com` will NOT match `notexample.com`
 *   - `1` / `127.0.0.1` / `localhost` / `*.local` are treated as "local network".
 */

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)$/i;

/** Extract hostname (no port, lowercase) from a web URL, or a bare hostname.
 *  Returns null if unparseable, or if this is not a web scheme — chrome://,
 *  mailto:, file:, data:, about: etc. are not internet navigations and are
 *  handled by the extension's own policy, so they must NOT resolve to a host. */
export function getHost(what) {
  if (typeof what !== 'string') return null;
  let s = what.trim();
  if (!s) return null;
  // Explicit scheme other than web -> not a web host (chrome:, mailto:, data:,...
  // mailto: is the tricky one: new URL() parses it as host=example.com).
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(s);
  if (scheme && !/^(https?|ws|wss)$/i.test(scheme[1])) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // Bare hostname: assume http for parsing so hostname is stable.
    s = 'http://' + s;
  }
  try {
    const u = new URL(s);
    if (!u.hostname) return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True when the host looks like an intranet / local machine (bypasses web policy in v1). */
export function isLocalHost(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  if (LOCAL_HOSTS.test(h)) return true;
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home') || h.endsWith('.internal')) return true;
  // 172.16.0.0/12
  const m = /^172\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  // file://, chrome://, chromewebstore:// etc. are handled by the extension separately; getHost already fails on those.
  return false;
}

/**
 * Does a single rule-string match the given hostname?
 * `pattern` can be:
 *   - `example.com`            -> example.com OR any *.example.com
 *   - `www.example.com`        -> EXACTLY www.example.com
 *   - `*.example.com`          -> any *.example.com (and example.com itself is also a match, see note)
 *   - `*`                      -> everything
 * NOTE: bare `example.com` is the "any subdomain" form to stay consistent with
 *       the "I typed one domain and meant the whole site" intuition most parents have.
 */
export function ruleMatchesHost(pattern, host) {
  if (typeof pattern !== 'string') return false;
  let p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p === '*' || p === '') return true;
  // Trailing glob: "tiktok.com*" means "tiktok.com and everything under it".
  // Drop the trailing * and treat it as a bare domain (matches self + subdomains).
  if (p.endsWith('*')) {
    p = p.slice(0, -1).trim();
    if (!p) return true;
  }
  // Strip protocol & path if the parent typed a full URL.
  p = getHost(p) || p;
  if (!host) return false;
  const h = host.toLowerCase();
  if (p === h) return true;
  // *.example.com -> matches any *.example.com AND example.com itself (most parents think of "*.co.uk" as all of co.uk).
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return h === base || h.endsWith('.' + base);
  }
  // Bare domain (no leading dot) -> match itself + any subdomain.
  return h.endsWith('.' + p);
}

/**
 * Strip glob stars from a site pattern without regular expressions (linear
 * time, safe on untrusted input): trailing `*`s, then leading `*`s and the
 * single `.` that may follow them. "*.example.com*" -> "example.com".
 */
export function stripStars(pattern) {
  const p = String(pattern);
  let start = 0;
  let end = p.length;
  while (end > start && p.charCodeAt(end - 1) === 42) end--;        // '*'
  const hadLeading = start < end && p.charCodeAt(start) === 42;
  while (start < end && p.charCodeAt(start) === 42) start++;
  if (hadLeading && start < end && p.charCodeAt(start) === 46) start++; // '.'
  return p.slice(start, end);
}
