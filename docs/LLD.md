# Chromebook Parental Control — Low-Level Design

*Version 1.1 · 2026-09 · Companion to HLD.md. Module-level design, data contracts,
API reference and the extension internals. Everything here describes the code
as it is; when they disagree, the code and its tests win and this file is the bug.*

## 0. Conventions

- ES modules (`"type": "module"`) everywhere; Node ≥ 22 (`node:sqlite`).
- Indent 2 spaces; no TypeScript in v1; tests via `node:test` + `supertest`.
- The engine reports in **minutes**; storage in **seconds**; the boundary is
  `server/src/status.js`.
- Every string the engine compares is lower-cased on the way in
  (`server/src/validate.js`).

## 1. Repository layout

```
chpc/
├── core/                      @chpc/core — pure policy engine, zero dependencies
│   ├── package.json           exports ".", "./policy", "./rules", "./time", "./site"
│   ├── src/
│   │   ├── index.js           barrel re-export
│   │   ├── policy.js          decide(), remainingDaily(), internetOn()
│   │   ├── rules.js           buildDnrRules(), failClosedRules(), minimalBlockRules(),
│   │   │                      globalBlockCode(), patternToHost(), PRIORITIES, BLOCK_CODES
│   │   ├── site.js            getHost(), ruleMatchesHost(), isLocalHost()
│   │   └── time.js            parseHM(), fmtHM(), localClock(), inWindow(), dayAllowed(), isOffDay()
│   └── test/                  policy.test.js · rules.test.mjs
├── server/                    @chpc/server — Express 5 + node:sqlite
│   ├── src/
│   │   ├── index.js           process entry: env → createApp(); prints the setup code; refuses unsafe config
│   │   ├── app.js             createApp(opts) → { app, db, purge, getSetupCode, needsSetup }; all routes
│   │   ├── auth.js            makeRequirePin(), RateLimiter, pinProblem(), hashPin()/verifyPinHash() (scrypt)
│   │   ├── cli.js             `status` / `reset-pin` maintenance commands
│   │   ├── validate.js        validatePolicy(), validateName(), validateAgentId(), validTimeZone()
│   │   ├── db.js              schema, CRUD, pairing codes, usage, retention purge
│   │   ├── status.js          dayStartMs(), effectivePolicyForKid(), kidStatus()
│   │   └── store.js           facade re-export of db.js
│   └── test/api.test.js
├── web/                       @chpc/web — React 19 + Vite 7 console
│   ├── vite.config.js         dev port 5173, proxy /api → 127.0.0.1:4100, outDir dist
│   └── src/
│       ├── main.jsx           createRoot + StrictMode
│       ├── App.jsx            hash router, PIN gate, top bar, settings drawer
│       ├── api.js             fetch client; PIN storage; 401 broadcast
│       ├── fmt.js             formatting helpers
│       ├── style.css          paper / ink / brass theme
│       └── components/        SetupScreen · PinGate · KidList · KidDetail (Policy/Devices/Usage tabs) · SettingsDrawer
├── extension/                 Chrome MV3 extension (load unpacked)
│   ├── manifest.json          module service worker; permissions below
│   ├── background.js          tick loop, DNR application, metering, messages
│   ├── popup.html / popup.js  pairing, status, PIN-gated unpair
│   ├── pages/blocked.html/.js lock page
│   └── vendor/core.js         esbuild bundle of @chpc/core (committed; rebuild with npm run build:ext)
├── install.sh                 one-line installer: Node 22, build, systemd service, `chpc` helper
├── scripts/
│   ├── chpc-ctl.sh            the `chpc` helper (status/logs/update/reset-pin/restart)
│   ├── build-ext.mjs          bundles core → extension/vendor/core.js, lints the manifest, rejects inline scripts
│   ├── e2e-extension.mjs      real-Chromium end-to-end check (Playwright)
│   └── e2e-console.mjs        console smoke test (Playwright)
├── docs/                      HLD.md · LLD.md · USER-GUIDE.md · SECURITY-REPORT.md
├── Dockerfile · docker-compose.yml (prebuilt image) · docker-compose.build.yml · .env.example · SECURITY.md
└── package.json               npm workspaces: core, server, web
```

## 2. @chpc/core

### 2.1 Policy document (stored per child, exactly as validated)

```jsonc
{
  "internetAllowed": true,                  // master switch
  "mode": "unrestricted" | "denylist" | "allowlist",   // denylist ≡ unrestricted (both: block only `deny`)
  "dailyMinutes": 90 | null,                // total minutes/day; null = no limit
  "deny":  ["tiktok.com", "*.roblox.com"],  // veto: wins over everything but local network
  "allow": ["khanacademy.org"],             // used only in allowlist mode
  "siteBudgets": [{ "pattern": "youtube.com", "minutes": 30 }],
  "windows": [{ "start": "08:00", "end": "20:00", "days": ["Mon","Tue"] }],  // days omitted = every day
  "offDays": ["Sat", "2026-12-25"]          // weekday names (Mon..Sun) or ISO dates
}
```

The *effective* policy (server → console/extension) is the stored document plus
`usageToday` (minutes) and `siteBudgets[i].used` (minutes), with
`internetAllowed`/`mode` defaults filled in.

### 2.2 `decide(policy, urlOrHost, { now, tz }) → decision`

```js
{ allowed: boolean,
  code: 'ok' | 'non-web' | 'disabled' | 'off-day' | 'off-hours' | 'daily-budget'
      | 'site-denied' | 'site-budget' | 'not-allowed',
  reason: 'human sentence', host: 'normalised hostname' | null }
```

Evaluation order: non-web scheme → local host → master switch → off day →
time window → daily budget → deny list → site budget → allowlist → ok.

### 2.3 `buildDnrRules(policy, { at, tz, lockUrl }) → Rule[]`

Pure mapping to Chrome `declarativeNetRequest` dynamic rules. Rules carry only
`id`, `priority`, `action`, `condition`; every condition has
`resourceTypes: ['main_frame']`. Time-dependent blocks (off day, off hours,
exhausted daily budget) are decided at `at` via `globalBlockCode()` and emitted
as a block-everything rule or not at all; the extension recomputes each minute.

| Priority | Rule | Condition |
| -------- | ---- | --------- |
| 4000 | master switch off → block all | none (all main frames) |
| 3950 | local network allow (two rules) | `PRIVATE_IP_REGEX`, `LOCAL_SUFFIX_REGEX` |
| 3900 | off day today → block all | — |
| 3890 | offline fail-closed → block all | — |
| 3800 | daily budget exhausted → block all | — |
| 3500 | outside allowed hours now → block all | — |
| 3000 | deny-list host → block | `||host` or host regex |
| 2500 | site budget exhausted → block | `||host` or host regex |
| 2000 | allowlist entry → allow | `||host` |
| 1000 | allowlist baseline → block all | — |

Two flavours: with `lockUrl` (the extension passes
`chrome.runtime.getURL('pages/blocked.html')`) block rules use `regexFilter`
that consumes the whole URL and `redirect.regexSubstitution =
"<lockUrl>?code=<reason>&url=\1"` (group 1 = `scheme://host`); without it they
use `redirect.extensionPath = '/pages/blocked.html'`. Every regex is kept under
Chrome's 2 kB compiled budget (the private-network expression is split in two
for that reason; verified with `isRegexSupported`). `failClosedRules()` = block
all + local allows; `minimalBlockRules()` = one block-all rule (last resort).

### 2.4 time.js / site.js

| Function | Notes |
| -------- | ----- |
| `localClock(ms, tz)` | `{date:'YYYY-MM-DD', dow, hour, min, minsOfDay}` via `toLocale*` with an explicit zone |
| `inWindow(minsOfDay, 'HH:MM', 'HH:MM')` | start inclusive, end exclusive; wraps midnight when end ≤ start |
| `dayAllowed(dow, days)` | empty/missing days = every day |
| `isOffDay(date, offDays)` | ISO dates and weekday names |
| `getHost(urlOrHost)` | lower-cased hostname; `null` for non-web schemes (`chrome:`, `mailto:` …) |
| `ruleMatchesHost(pattern, host)` | `example.com` matches itself + subdomains; `*.x` same; `*` everything; never lookalikes |
| `isLocalHost(host)` | loopback, RFC 1918, `*.local/.lan/.home/.internal` |

### 2.5 Tests

`core/test/policy.test.js` (13): parsing, windows, each decision code, local
bypass, non-web schemes. `core/test/rules.test.mjs` (24): Chrome schema
assertions on every rule set, both flavours, each priority band, time
evaluation at fixed instants, boundary safety, junk tolerance, regex size.

## 3. @chpc/server

### 3.1 Storage (node:sqlite, WAL, foreign keys on)

| Table | Columns |
| ----- | ------- |
| `kids` | `id` PK, `name`, `created_at` |
| `policy` | `kid_id` PK/FK cascade, `json`, `updated_at` |
| `devices` | `code` PK (8 letters), `kid_id` FK cascade, `agent_id` (label), `paired_at`, `last_seen` |
| `usage` | `id` PK, `kid_id` FK cascade, `site` (hostname), `url` (always `''`), `started_at`, `ended_at`, `seconds` |
| `settings` | `key` PK, `json` (currently `tz`) |

File is created `0600` in a `0700` directory. `purgeUsageOlderThan(days)` runs
at start-up and every 6 h (`CHPC_RETENTION_DAYS`, default 90, 0 = never).

### 3.2 Authentication (auth.js)

- PIN source, first match wins: `CHPC_GUARDIAN_PIN` (env) → `settings.pinHash`
  (scrypt, written by first-run setup or a PIN change) → none = **setup required**.
- `makeRequirePin({ getPin, allowNoPin, limiter })` → middleware mounted on
  `/api/auth`, `/api/settings`, `/api/kids`. Accepts `X-Guardian-PIN: <pin>` or
  `Authorization: Bearer <pin>`. Env PINs: SHA-256 + `timingSafeEqual`; stored
  PINs: scrypt verify, with the digest of the last good PIN cached in memory so
  scrypt runs once per process, not per request (`invalidate()` on change).
  Responses: `401 {code:'pin-required'|'pin-wrong'}`, `429 {code:'locked-out'}`
  after 10 failures per IP in 15 min (`Retry-After`), `503 {code:'setup-required'}`
  while no PIN exists (unless `allowNoPin`).
- First-run setup: while no PIN exists `createApp` mints a one-time 8-letter
  code (`makeCode()`), returns it via `getSetupCode()` and writes it `0600` to
  `setupCodeFile` (next to the DB). `POST /api/setup` consumes it (constant-time
  compare, 10 attempts per IP per 15 min) and stores the scrypt hash; the file
  is then removed. `index.js` prints the code in a banner.
- `pinProblem(pin)` — ≥ 6 chars, ≤ 128, not repeated/sequential. Applied to env
  PINs at start-up and to every PIN chosen in the console.
- `RateLimiter` — in-memory sliding window keyed by `req.ip`; also used for
  unknown pairing codes (20 per 15 min).

### 3.3 Validation (validate.js)

`validatePolicy(body)` returns `{ policy }` or `{ error, field }`. Only known
keys survive. Limits: 500 list entries, pattern ≤ 253 chars and host-shaped,
`dailyMinutes` integer 0..1440 (0/blank → null), budgets integer 1..1440 with
unique patterns, ≤ 14 windows each with valid `HH:MM` start ≠ end and weekday
names, off days as weekday names or real ISO dates. Names ≤ 60 chars, control
characters stripped. Time zones checked with `Intl.DateTimeFormat`.

### 3.4 Routes (app.js)

Auth column: **P** = guardian PIN, **C** = pairing code in path, — = public.

| Method & path | Auth | Body / query | Returns |
| ------------- | ---- | ------------ | ------- |
| `GET /api/health` | — | | `{ ok, service }` |
| `GET /api/setup/status` | — | | `{ needsSetup, pinSource: 'env'\|'db'\|'none' }` |
| `POST /api/setup` | setup code | `{ setupCode, pin }` | `201 { ok, pinSource:'db' }`; `401 setup-code-wrong`, `400` weak PIN, `409 already-set-up`, `429` |
| `GET /api/auth/check` | P | | `{ ok, pinSource }` |
| `PUT /api/auth/pin` | P | `{ pin }` | `{ ok }`; `400` weak, `409 pin-managed-by-env` |
| `GET /api/settings` | P | | `{ timezone, retentionDays, pinSource }` |
| `PUT /api/settings` | P | `{ timezone }` | same (400 on invalid zone) |
| `GET /api/kids` | P | | `{ kids: [{ id, name, createdAt, status, devices[] }] }` |
| `POST /api/kids` | P | `{ name }` | `201 { kid }` |
| `GET /api/kids/:id` | P | | `{ kid, policy, status, devices[] }` |
| `PATCH /api/kids/:id` | P | `{ name }` | `{ kid }` |
| `DELETE /api/kids/:id` | P | | `{ deleted: id }` (cascades) |
| `GET /api/kids/:id/policy` | P | | `{ policy, effective }` |
| `PUT /api/kids/:id/policy` | P | policy document | `{ policy, updatedAt }` or `400 { error, field }` |
| `POST /api/kids/:id/pairings` | P | `{ agentId? }` (label) | `201 { code, codeDisplay, pairedAt }` |
| `DELETE /api/kids/:id/pairings/:code` | P | | `{ deleted: code }` |
| `GET /api/kids/:id/usage/today` | P | | `{ ts, tz, dayStart, status, sites: [{ site, minutes, visits, budgetMinutes }] }` |
| `GET /api/kids/:id/usage/history` | P | `?days=1..90` (7) | `{ days, perDay: [{ isoDay, minutes, visits }] oldest→today, timezone }` |
| `GET /api/devices/:code` | C | `?host=` optional | `{ device, kid: {id,name}, timeZone, policy (effective), decision }`; touches `last_seen` |
| `POST /api/devices/:code/heartbeat` | C | | `{ ok, timeZone }` |
| `POST /api/devices/:code/usage` | C | `{ site\|url, seconds }` or `{ entries: [{ site, seconds }] }` (≤ 100) | `{ ok, recorded, decision, status }` |

`status` = `{ internetAllowed, dailyLimitMin, usedTodayMin, remainingDailyMin }`.
Device objects: `{ code, codeDisplay, kidId, agentId, pairedAt, lastSeen }`.
Codes are accepted in any case, with or without the display hyphen.

Cross-cutting: security headers + CSP on every response, `Cache-Control:
no-store` on `/api`, no CORS unless the origin is in `corsOrigins`, JSON body
≤ 256 kB (`413`), malformed JSON `400`, unknown route `404 { error }`, 5xx
logged server-side and returned as `{ error: 'server error' }`. When
`publicDir` is set the console is served at `/` with an `index.html` fallback
for non-API GETs that accept HTML.

### 3.5 Environment (index.js)

| Var | Default | Meaning |
| --- | ------- | ------- |
| `PORT` | `4100` | listen port |
| `HOST` | `127.0.0.1` | bind address (installer and Docker use `0.0.0.0`) |
| `CHPC_GUARDIAN_PIN` | unset | advanced: fixed PIN; weak value → **exit 1**. Unset → stored PIN or first-run setup |
| `CHPC_ALLOW_NO_PIN` | off | developers: no PIN at all; refused on non-loopback hosts |
| `CHPC_DB` | `./data/chpc.db` | SQLite file |
| `CHPC_PUBLIC_DIR` | unset | built console to serve |
| `CHPC_RETENTION_DAYS` | `90` | usage retention, 0 = forever |
| `CHPC_CORS_ORIGINS` | none | comma-separated allowed origins |
| `CHPC_TRUST_PROXY` | off | `1` behind a reverse proxy |

### 3.6 Tests (`server/test/api.test.js`, 29)

Auth (401/429/503, Bearer), first-run setup (code file, wrong/weak/right,
single use, restart pickup, rate limit), PIN change (db vs env), scrypt
helpers, rate limits, headers/CORS, malformed/oversize
bodies, settings, kids CRUD + name rules, policy normalisation + 25 rejected
shapes, pairing flow + code normalisation + revoke, usage single/batch/caps/
server clock/hostname-only, today + history aggregation, cascade delete,
retention purge, static console fallback.

## 4. @chpc/web

- `api.js` — `req()` adds `X-Guardian-PIN` from `pinStore`, throws `ApiError
  { status, code, field }`, broadcasts 401s via `onUnauthorized()`.
- `App.jsx` — hash router (`#/`, `#/kid/:id`), health + settings polling every
  30 s; `SetupScreen` while the server answers `setup-required`, then `PinGate`
  until `/api/auth/check` succeeds; Lock button clears the PIN.
- `SetupScreen.jsx` — setup code + new PIN (twice); explains where the code is.
- `KidList.jsx` — add/delete children; device count, last seen, budget meter.
- `KidDetail.jsx` — rename; tabs: **Policy** (master switch, mode + approved
  list, daily limit, off days incl. one-off dates, allowed hours, blocked
  sites, per-site limits; unsaved-changes indicator), **Devices** (paired list
  with last seen, generate code + console address hint, revoke, test a
  decision), **Usage** (today, top sites, 7-day bars).
- `SettingsDrawer.jsx` — time zone with live preview; change PIN (hidden when the PIN comes from the environment); data & privacy summary.
- Build: `vite build` → `web/dist`, served by the server (`CHPC_PUBLIC_DIR`).

## 5. Extension

**Manifest**: MV3, `background.type = module`, permissions `storage`,
`declarativeNetRequest`, `tabs`, `alarms`, `idle`; host permissions
`<all_urls>` (needed to redirect any site); `pages/blocked.html` web-accessible
for http/https. No inline scripts anywhere (MV3 CSP; enforced by `build:ext`).

**Storage keys** (`chrome.storage.local`): `apiBase`, `pairingCode`, `kidName`,
`cachedPolicy`, `lastSuccess`, `lastFail`, `lastError`, `tz`, `pendingUsage`
(`{host: seconds}`), `lastRules` (signature of the applied set), `lastBlock`
(current block-all reason), `ruleMode` (`regex`|`path`), `ruleCount`.

**Tick** (alarm every minute, also on install/start-up, pairing change and
popup refresh; serialised):
1. not paired → remove all dynamic rules, stop;
2. meter: +60 s to the focused active tab's hostname if `chrome.idle` is `active`;
3. flush `pendingUsage` as one batch; keep it on failure;
4. `GET /api/devices/:code` → cache policy, tz, kid name; `404` → forget
   pairing (parent revoked); other failures → mark offline;
5. rules from the cached policy (offline: with local pending usage folded in);
   apply only when the signature changed; regex flavour → path flavour →
   fail-closed → minimal block. Counts are read back from Chrome.
6. no policy ever and offline > 10 min → fail-closed.

**Messages**: `CHPC_STATUS` (popup), `CHPC_REFRESH` (popup; runs a tick),
`CHPC_WHY` (lock page without a code), `CHPC_FORGET` (popup, after the server
accepted the PIN on `GET /api/auth/check`).

**Popup**: pairing form (code normalised to letters, address normalised to a
URL, checked with `GET /api/devices/:code` before saving); when paired: status
dot (online < 3 min, reconnecting < 1 h, offline), rules summary, Refresh,
Unpair (PIN). **Lock page**: reads `code` + `url`, shows a friendly reason and
the host, falls back to `CHPC_WHY`, has a Go back button.

## 6. Packaging

- `Dockerfile` — multi-stage `node:22-alpine`: build console → slim runtime,
  `npm ci --omit=dev`, non-root `chpc` user, `/data` volume, health check.
- `docker-compose.yml` — one service from the **prebuilt image**
  `ghcr.io/marfleetn/chromebook-parental-control:latest`; no PIN needed up
  front (first-run setup; code in `docker compose logs`). Hardened: read-only
  root FS, all capabilities dropped, `no-new-privileges`.
  `docker-compose.build.yml` overrides to build from source.
- `install.sh` — apt-based systems with systemd: installs Node 22 if < 22,
  downloads `CHPC_REF` (default `main`) tarball, `npm ci && npm run build &&
  npm prune --omit=dev`, installs to `/opt/chpc`, data in `/var/lib/chpc`
  (0700, user `chpc`), settings in `/etc/chpc/chpc.env` (0600), hardened
  systemd unit, `/usr/local/bin/chpc` helper; prints URL, QR (if `qrencode`)
  and the setup code. Idempotent: re-running upgrades in place.
- `.github/workflows/ci.yml` — Node 22: `npm ci`, `check`, `test`, `build`,
  bundle freshness, `npm audit --omit=dev`, Docker build.
- `.github/workflows/publish.yml` — multi-arch image to GHCR on `main` and
  `v*` tags; extension zip attached to `v*` releases.
- Root scripts: `test`, `check`, `build`, `build:web`, `build:ext`, `start`,
  `dev`, `dev:web`, `audit:prod`, `e2e:ext`, `e2e:web`, `cli`.

## 7. Known gaps / follow-ups

1. **Extension removal by the child** is outside CHPC's control (Developer
   mode). Recommend supervised/managed accounts; consider publishing to the
   Chrome Web Store (unlisted) so Family Link approval flows apply.
2. **Single guardian PIN**, no per-parent identity or audit trail of who changed
   what. Fine for one household; a multi-guardian model would need accounts.
3. **Rate limiting is in-memory** and per process; restarting clears it. Good
   enough for one family server; a reverse proxy can add more.
4. **HTTP on the LAN**: the PIN travels in clear text on the home Wi-Fi. TLS
   via a reverse proxy is documented as the fix; the server does not terminate
   TLS itself.
5. **Time-zone changes mid-day** shift the "today" boundary; the console warns.
6. **Only one allowed-hours window is editable** in the console (the API
   supports several).
7. Metering counts the focused active tab only; audio playing in a background
   tab is not counted.
