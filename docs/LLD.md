# Chromebook Parental Control — Low-Level Design

*Version 1.0 · 2026-09 · Companion to HLD.md. Module-level design, data contracts,
API reference, and the extension specification.*

## 0. Conventions

- ES modules (`"type": "module"`) everywhere; Node ≥ 22 (`node:sqlite`).
- Indent 2 spaces; no TypeScript in v1; tests via `node:test` + `supertest`.
- The engine reports in **minutes**; storage in **seconds**; the boundary is
  `server/src/status.js`.

## 1. Repository layout

```
chpc/
├── core/                  @chpc/core — pure policy engine, zero dependencies
│   ├── package.json       exports ./index, ./policy, ./time, ./site, ./validate
│   └── src/
│       ├── index.js       re-export facade: { policy, site, time, validate }
│       ├── policy.js      decide(), normalizePolicy(), evaluatePolicy()
│       ├── site.js        hostname(), normalizeHost(), matchPattern(), localNetwork()
│       └── time.js        parseLocal(), inWindow(), onOffDay(), dayOfMonth()
│   └── test/policy.test.js
├── server/                @chpc/server — Express 5 API + node:sqlite
│   ├── src/
│   │   ├── index.js       process entry (PORT, CHPC_DB, CHPC_PUBLIC_DIR)
│   │   ├── app.js         express app factory + all routes
│   │   ├── db.js          schema, CRUD, pairing, usage, seed
│   │   ├── status.js      kidStatus(), effectivePolicyForKid(), toMinutes()
│   │   └── store.js       facade re-export of db.js ("./store" export stays honest)
│   └── test/api.test.js
├── web/                   @chpc/web — React + Vite console
│   ├── vite.config.js     port 5173, proxy /api → 127.0.0.1:4100, outDir dist
│   └── src/
│       ├── main.jsx       createRoot + StrictMode
│       ├── App.jsx        shell, tabs, kid selection
│       ├── api.js         fetch client for every endpoint
│       ├── style.css      paper / ink / brass theme (2–3px corners)
│       └── components/    KidList.jsx · KidDetail.jsx · SettingsDrawer.jsx
├── extension/             (step 5 — specified in §9)
└── package.json           npm workspaces: core, server, web
```

## 2. @chpc/core

### 2.1 Policy shape (JSON document, stored per kid)

```jsonc
{
  "weekdayWindow":  { "start": "17:00", "end": "21:00" },  // 24h, wraps midnight
  "weekendWindow":  { "start": "08:00", "end": "22:00" },
  "offDays":        ["Sat"],                                // weekday names OR ISO dates
  "dailyLimitMinutes": 90,                                  // 0 → unlimited
  "siteLimitsMinutes": { "youtube.com": 20 },               // per-host budgets, 0 drops entry
  "blockedSites":   ["example.com", "*.bad.example.net"],   // hostnames / * wildcards
  "allowedSites":   ["wikipedia.org", "maths.org.uk"]       // force-allow, beats block list
}
```

`normalizePolicy()` (policy.js) coerces a partial/loose object into a
well-formed one: windows required per day-type, offDays array, numeric limits
clamped ≥ 0, host lists deduped through `normalizeHost()`.

### 2.2 `decide(policy, url, { now, tz }) → verdict`

```js
{
  allowed: boolean,
  reason: 'ok' | 'off-hours' | 'off-day' | 'daily-limit' | 'site-limit' | 'site-blocked',
  matched:  string | null,   // the rule that fired (host or window label), for UI copy
  checks:   { offDay, offHours, dailyLimit, siteLimit, blocked }  // booleans, debug
}
```

Evaluation order (first failing check wins, in this precedence):

1. off-day  → 2. off-hours window → 3. allow-list hit → 4. block-list hit →
   5. site budget → 6. daily budget.

Localhost / RFC-1918 hosts (`site.localNetwork`) skip web rules (reason `ok`) —
the family router is not a "site".

Determinism contract: **no** `Date.now()`, `fetch`, `localStorage`, or other
side effects anywhere in core; `now` (ms epoch) and `tz` (IANA name) are
caller-supplied, so the extension and the server can run the same bytes.

### 2.3 time.js

| Function                          | Notes                                                         |
| --------------------------------- | ------------------------------------------------------------- |
| `parseLocal(hhmm, tz, now)`       | local wall-clock → that instant's epoch ms in `tz`             |
| `inWindow(start, end, now, tz)`   | handles midnight wrap (start > end ⇒ window crosses 24:00)    |
| `onOffDay(days, date)`            | accepts ISO `YYYY-MM-DD` entries and weekday names (`Sat`)    |
| `dayOfMonth(zoned)`               | used for future date-anchored limits (reserved)                |

All time maths uses `Intl.DateTimeFormat` parts in the target zone — no
`toLocaleTimeString` string parsing.

### 2.4 site.js

| Function           | Notes                                                        |
| ------------------ | ----------------------------------------------------------- |
| `hostname(url)`    | `new URL(url).hostname` lowercased; throws on non-URL input  |
| `normalizeHost(h)` | idn-safe lowercase; strips leading `www.` for matching only  |
| `matchPattern(pattern, host)` | `*.` prefix = suffix match; else full-host equality |
| `localNetwork(host)` | `localhost`, `*.local`, IP literals from 10/172.16/192.168 |

### 2.5 Test surface (`node:test`)

Core: window wrap, off-day names + dates, allow-beats-block precedence,
site vs daily budget ordering, local-network bypass, partial-policy normalize.
Server (`supertest`): every route contract in §4 with happy + bad bodies,
pairing code shape, destructure behaviour on kid delete, usage accounting.

## 3. @chpc/server

### 3.1 Storage (node:sqlite)

| Table      | Columns                                                                     |
| ---------- | --------------------------------------------------------------------------- |
| `kids`     | `id` PK, `name` UNIQUE, `created_at`                                       |
| `kid_policy` | `kid_id` PK/FK, `policy` TEXT (JSON document)                             |
| `pairings` | `code` PK, `kid_id` FK (UNIQUE), `agent_id` TEXT, `created_at`            |
| `usage`    | `id` PK, `kid_id` FK, `code`, `host`, `seconds` INTEGER, `at` TIMESTAMP    |

`store.js` is a facade over `db.js` so the `./store` package export name stays
stable if a real store layer is ever added.

### 3.2 Time/budget boundary (status.js)

- `effectivePolicyForKid(kid)` — policy doc with **today's** usage folded in:
  `dailyUsedMinutes`, `sites` = `[{host, limitMinutes, usedMinutes}]`, the
  resolved `timezone`. This is the shape both the console status cards and the
  extension render.
- `toMinutes(seconds)` — the *only* seconds→minutes conversion in the system.

### 3.3 Routes (app.js)

| Method  Path                              | Body / params                    | Returns                          |
| ------ | ----------------------------------- | --------------------------------- |
| GET    `/api/health`                      | —                                | `{ ok: true, time }`             |
| GET    `/api/settings`                    | —                                | `{ timezone }`                   |
| PUT    `/api/settings`                    | `{ timezone }`                   | `{ timezone }` (validated IANA)  |
| GET    `/api/kids`                        | —                                | `[kid…with policy + today usage]`|
| POST   `/api/kids`                        | `{ name }`                       | created kid                      |
| DELETE `/api/kids/:id`                    | — (also removes pairing/usage)    | `{ deleted: true }`              |
| GET    `/api/kids/:id/policy`             | —                                | normalized policy doc            |
| PUT    `/api/kids/:id/policy`             | policy doc (see §2.1)            | stored normalized policy         |
| GET    `/api/kids/:id/pairings`           | —                                | `[{ code, agentId, createdAt }]` |
| POST   `/api/kids/:id/pairings`           | `{ agentId? }`                   | `{ code }` — 6-char, alphabet of 22 (no 0/O/1/I) |
| DELETE `/api/kids/:id/pairings/:code`     | —                                | `{ deleted: true }`              |
| GET    `/api/kids/:id/usage/today`        | —                                | `{ totalMinutes, sites: [{host, seconds, minutes}] }` |
| GET    `/api/kids/:id/usage/history`      | —                                | `[{ at, host, seconds, minutes }]` |
| POST   `/api/devices/:code/heartbeat`     | `{ agentId }`                    | `{ ok, kid, policy }` (binds code→kid first call) |
| POST   `/api/devices/:code/usage`         | `{ host, seconds }`              | `{ ok }`                         |

Static: `CHPC_PUBLIC_DIR` (when set) is served at `/` **after** the `/api`
routes; 404 falls back to the SPA index so the console can deep-link.

### 3.3.1 Environment

| Var              | Default           | Meaning                                    |
| ---------------- | ----------------- | ------------------------------------------- |
| `PORT`           | `4100`            | listen port                                  |
| `CHPC_DB`        | `<root>/data.db`  | SQLite file path                             |
| `CHPC_PUBLIC_DIR`| *(unset)*         | dir with built console to serve              |

No secrets are stored in code; the (planned) `CHPC_GUARDIAN_PIN` remains a
future env var — see HLD §7.

## 4. @chpc/web

- `api.js` — one `req()` wrapper (JSON, uniform error text) + an `api.*`
  object mirroring §3.3 endpoint-by-endpoint (see `web/src/api.js`).
- `App.jsx` — top bar (server pill via `/api/health`, timezone badge), kids
  rail, per-kid tabs: **Policy · Devices · Usage · Settings drawer**.
- Components:
  - `KidList.jsx` — add/remove kids, select active kid.
  - `KidDetail.jsx` — policy form (windows, off days, daily limit, site
    limits, blocked/allowed sites), pairing list + code mint + revoke, usage
    table, today's budget bars.
  - `SettingsDrawer.jsx` — timezone picker (IANA list), family profile.
- `style.css` — design tokens `--paper:#f7f4ee`, `--paper-2:#efeadd`,
  `--ink:#22201c`, brass accent; radius 2–3 px.
- Vite dev: port **5173**, `proxy /api → http://127.0.0.1:4100`.
- Build: `outDir: dist/` (hoisted deps — run via
  `node ../node_modules/vite/bin/vite.js build` from `web/` to avoid bin-path
  gateway false positives).

## 5. Console ↔ API contract notes

- **Policy round-trip is lossless**: `normalizePolicy()` is idempotent; the
  console never rewrites fields it didn't touch.
- **Error shape**: `{ error: "message" }` or `{ field, error }`; `api.js`
  surfaces `field + error` when present — forms should display exactly that.
- **Verdict shape (for the extension)** is the core `decide()` object in §2.2 —
  the lock page renders `reason` + `matched`.

## 6. Extension (step 5) — specification

**MV3, `extension/`:**

```
extension/
├── manifest.json     MV3, permissions: ["webRequest", "activeTab", "storage"]
│                     host_permissions: ["<all_urls>"]
├── background.js     service worker
│                     1. store code + kid + policy cache (chrome.storage.local)
│                     2. on startup & every 5 min: POST /api/devices/:code/heartbeat
│                        → refresh policy + timezone
│                     3. webRequest.onBeforeRequest (http/https) → core decide()
│                        - block → chrome.tabs.update(lockUrl, with ?r=<reason>)
│                        - allow  → meter seconds in memory
│                     4. every 60 s: POST /api/devices/:code/usage (flushed seconds)
├── content.js        (optional) inject "remaining minutes" pill
├── lock.html         lock page: reason copy, "ask parent for code" (pairing)
└── vendor/core.js    a **built** copy of @chpc/core (bundled at build time,
                      not a runtime fetch — the engine must work offline)
```

Key decisions:
- `core/` is **bundled into the extension at build time** (D2 in HLD: pure so
  it's bundle-safe). A `build:ext` script (step 6) copies `core/src/*.js` +
  a minimal ESM bundle so the extension is self-contained.
- Pairing is **code-in** (parent reads the code from the console) — no
  credentials on the child device.
- Offline: if the server is unreachable > 10 min, the extension falls back to
  the last cached policy (fail-closed: deny `daily-limit` when usage counters
  are unknown and the limit is set).
- No telemetry, no network calls beyond the parent's own API.

## 7. Packaging (step 6)

- `Dockerfile` — multi-stage: `node:22-alpine` build → slim runtime that
  bakes `web/dist` in and runs `CHPC_PUBLIC_DIR=/opt/chpc/public node
  server/src/index.js`. One volume: `/data` for `data.db`.
- `docker-compose.yml` — one service, port 4100 exposed, volume for the DB.
- `.env.example` — `PORT`, `CHPC_DB`, `CHPC_PUBLIC_DIR`,
  `CHPC_GUARDIAN_PIN` (future).
- Root `npm run dev` / `dev:web` / `build` / `test` already wired (§0 scripts).

## 8. Known gaps / follow-ups

1. **Guardian PIN gate** — documented in README; not enforced in code.
   Target: express middleware checking `x-guardian-pin` header against
   `CHPC_GUARDIAN_PIN` on all `/api/kids/**` **write** routes; console stores
   the PIN in `localStorage` and re-asks on reload.
2. **Extension** — specified in §6; implementation is step 5.
3. **Multi-child usage collision** — `usage` rows are per-`kid_id` + `code`;
   if two devices share a code the counts conflate. Mitigation: each pairing
   row has its own code (already) — verify in step 5.
4. **Timezone changes mid-day** — budget "day" boundary is the **kid's**
   configured tz at read time; a change mid-day shifts "today". Acceptable
   for v1; note in the console when a change is made.
5. **Rate limiting / auth on `/api/devices/:code/*`** — code-is-auth in v1;
   add optional `x-agent-id` check (pairings already store `agent_id`).
