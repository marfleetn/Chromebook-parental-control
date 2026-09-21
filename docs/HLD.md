# Chromebook Parental Control — High-Level Design

*Version 1.1 · 2026-09 · Status: design of record. All components implemented; the
status register in §9 says what is verified how.*

## 1. Purpose

CHPC is a self-hosted parental-control system for family Chromebooks. A parent
authors internet rules in a web console; a Chrome **extension enforces** those
rules locally on each child device and reports usage back to the API so time
budgets are real, not just recorded. There is **no third-party cloud**: the
machine running this repo (a laptop, a Chromebook in Linux mode, a small server
or a Docker host) is the single source of truth.

**Goals**

- Rules are simple to state: allowed hours, off days, daily minutes, per-site
  limits, blocked sites, an approved-sites-only mode.
- Enforcement is **local and offline-tolerant**: the extension carries the
  same pure rule engine the server uses and keeps working from its cache.
- Zero native build steps: `node:sqlite` (built into Node ≥ 22) means
  `npm install` works on a fresh Chromebook Linux environment.
- One code base, one repo, small and auditable.
- Safe by default: no network-reachable install without a guardian PIN; a
  broken or missing policy never means "open".

**Non-goals (v1)**

- Content filtering of page *bodies* (we gate at hostname and time/budget).
- Multi-admin roles, per-child PIN bypass, audit-log export.
- Mobile-app control; Chrome/ChromeOS web traffic only.
- Preventing a child with Developer-mode access from removing the extension
  (see §7 — that is the device owner's account model to enforce).

## 2. Actors

| Actor    | What they do                                                                     |
| -------- | -------------------------------------------------------------------------------- |
| Parent   | Unlocks the console with the guardian PIN; adds children, edits policies, pairs devices, watches usage. |
| Child    | Browses with the enforcing extension installed; sees a lock page when blocked. Cannot unpair without the PIN. |
| Operator | Installs the stack, sets the PIN, runs tests, builds, deploys (Docker or bare Node). Usually the parent. |

## 3. System context

```
                ┌─────────────────────────────┐
                │        Parent (console)     │
                │  React SPA, PIN-gated       │
                └──────────────┬──────────────┘
                               │ same-origin JSON /api, X-Guardian-PIN
                ┌──────────────▼──────────────┐
                │        CHPC Server          │
                │  Express 5 + node:sqlite    │
                │  - guardian PIN auth        │
                │  - policy CRUD, validation  │
                │  - device pairing (codes)   │
                │  - usage accounting         │
                │  - serves the built console │
                └───────┬───────────────▲─────┘
        effective policy│               │ metered usage (host, seconds)
                        ▼               │
   ┌────────────────────────────────────┴──┐
   │   Chrome extension (child Chromebook) │
   │   @chpc/core buildDnrRules()          │
   │   → declarativeNetRequest rules       │
   │   → lock page on block                │
   └───────────────────────────────────────┘
```

## 4. Components

| Component  | Package        | Role |
| ---------- | -------------- | ---- |
| Policy core | `@chpc/core`  | Pure functions, no I/O, no clock: `decide()` scores one navigation; `buildDnrRules()` maps (policy, now, tz) to Chrome declarativeNetRequest rules; time and hostname helpers. Shared by server **and** extension (bundled by esbuild into `extension/vendor/core.js`). |
| Server     | `@chpc/server` | Express 5 API, SQLite persistence, guardian PIN middleware, rate limiting, strict input validation, usage retention, static console serving. |
| Console    | `@chpc/web`    | React 19 + Vite 7 single-page app: PIN gate, kids, policy editor, devices/pairing, usage. |
| Extension  | `extension/`   | Chrome Manifest V3: module service worker applies rules every minute, meters the focused tab, reports usage, popup for pairing/status, lock page. |
| Packaging  | root scripts, Docker | One-command test/build; multi-stage image; compose file. CI workflow runs tests, builds and a production dependency audit. |

**Key invariant — single source of truth.** The engine in `core/` is the only
place a verdict is computed. `decide()` answers "is this host allowed now?" for
the server's status and test-a-decision features; `buildDnrRules()` turns the
same policy into the rule set Chrome enforces, evaluated at the same instant
with the same time-zone. Both are pure, so identical bytes run in Node and in
the extension, and both are unit-tested against the same fixtures.

## 5. Primary flows

**5.0 First run (operator).** With no PIN configured, the server prints a
one-time setup code (also written `0600` next to the database, and shown by
the installer / `chpc status`). The console opens on a setup screen; the code
plus a chosen PIN (`POST /api/setup`) stores a scrypt hash and retires the code.
Until then every parent route answers `503 setup-required`. Advanced installs
may still fix the PIN with `CHPC_GUARDIAN_PIN`.

**5.1 Unlock (parent).** The console asks for the guardian PIN, verifies it with
`GET /api/auth/check`, then sends it as `X-Guardian-PIN` on every parent
request. It is kept in `sessionStorage` (or `localStorage` if the parent ticks
"remember on this device"). A `401` anywhere returns the app to the gate.

**5.2 Policy authoring.** Console → `PUT /api/kids/:id/policy`. The server
validates strictly (allow-listed keys, bounded lists, host-like patterns,
weekday names, ISO dates, integer minutes) and stores the normalised JSON
document. Reads return the stored document plus the *effective* policy with
today's usage folded in.

**5.3 Device pairing.** `POST /api/kids/:id/pairings` mints an 8-letter code
from a 22-letter unambiguous alphabet using a CSPRNG (≈ 5×10¹⁰ combinations).
The parent types the code and the console address into the extension popup on
the child's Chromebook. The code is that device's credential; unknown codes are
rate-limited per client address; the parent revokes with
`DELETE /api/kids/:id/pairings/:code`, after which the device forgets its pairing
on the next minute tick and applies no rules.

**5.4 Enforcement.** Every minute the extension fetches the effective policy,
computes the rule set for *now* in the family time-zone and, if it changed,
replaces Chrome's dynamic rules. Blocked navigations are redirected before any
request leaves the device to `pages/blocked.html?code=<reason>&url=<origin>`.
Only `main_frame` requests are gated. If Chrome rejects a rule set, the worker
retries in a simpler flavour and finally applies a fail-closed set; it never
ends with zero rules while paired.

**5.5 Metering.** Each tick attributes 60 seconds to the hostname of the active
tab in the focused window, only when `chrome.idle` says the user is active.
Pending seconds are flushed in one batch to `POST /api/devices/:code/usage`;
the server stamps rows with its own clock, caps a report at one hour, stores
the hostname only, and returns the current status. While offline, pending
seconds are folded into the cached policy locally so budgets keep counting.

**5.6 Unpair from the device.** The popup's "Unpair" asks for the guardian PIN
and verifies it with the server before clearing storage and rules. Without the
server online, unpairing is impossible from the device.

## 6. Data & time semantics

- Policy is a **document** (one JSON row per child), validated on write.
- Usage is **relational** (seconds, per hostname, server-timestamped) so it
  sums; rows older than `CHPC_RETENTION_DAYS` (default 90) are purged.
- Storage unit is **seconds**; the engine's unit is **minutes**; the server's
  status layer is the only conversion boundary.
- Time reasoning uses one family-wide IANA time-zone (default `Europe/London`)
  against an explicit `now`; windows may wrap midnight; off days may be ISO
  dates or weekday names. Changing the zone moves the "today" boundary.
- Allow/deny rules match the **hostname** and its subdomains (`youtube.com`
  covers `m.youtube.com`), never lookalikes (`notyoutube.com`). Private
  addresses (`127.*`, `10.*`, `172.16-31.*`, `192.168.*`, `localhost`,
  `*.local/.lan/.home/.internal`) bypass web policy so routers and printers
  keep working, except when the master switch is off.

## 7. Trust & security model

The trust boundary is the family LAN, **but the LAN is not trusted**: any web
page a child visits can issue requests to LAN addresses, and any device on the
Wi-Fi can reach the port.

| Concern | Control |
| ------- | ------- |
| Console / parent API exposure | Guardian PIN on every parent request; env PINs compared as SHA-256 in constant time, stored PINs as scrypt hashes; 10 failures per address → 15-minute lockout. No PIN yet → all parent routes answer "setup required"; setup needs a one-time code visible only to whoever can read the server's log or disk. Weak PINs refused everywhere. Dev mode without a PIN is explicit (`CHPC_ALLOW_NO_PIN`) and loopback-only. |
| Cross-site request forgery from a page the child visits | No CORS headers by default → browsers refuse cross-origin reads and block preflighted writes (PIN header forces preflight). Opt-in `CHPC_CORS_ORIGINS` for unusual setups. |
| Clickjacking / injection in the console | `Content-Security-Policy` (self only, no inline scripts), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on the API. React escapes output; no `dangerouslySetInnerHTML`. |
| Pairing code guessing | CSPRNG, 8 chars / 22 letters; unknown-code lookups rate-limited per address (20 per 15 min). Codes are revocable bearer credentials — treat like a password. |
| Input abuse | Strict validation: allow-listed policy keys, list caps (500), pattern length cap, host-shape check, integer bounds, JSON body limit 256 kB, malformed JSON → 400. |
| Usage tampering | Server clock is authoritative (client timestamps ignored); one report capped at 3600 s; only the device's own code can report. A device can over-report (locking itself out sooner) but never under-report. |
| Child defeats the extension | Unpairing requires the PIN. Disabling/removing an unpacked extension in Developer mode is **not** preventable by CHPC: use a supervised (Family Link) or enterprise-managed Chrome account that blocks Developer mode / force-installs the extension. Documented limitation. |
| Data exposure at rest | SQLite file created `0600` in a `0700` directory; hostnames only, never URLs; retention purge; delete-child cascades. Back-ups are the operator's responsibility. |
| Transport | Plain HTTP on the LAN by design. For remote access, terminate TLS at a reverse proxy and set `CHPC_TRUST_PROXY=1` so rate limits key on the real client IP. |
| Supply chain | Two runtime dependencies (`express`, `supertest` dev-only aside); `npm audit --omit=dev` clean; dev toolchain kept current (Vite 7, esbuild 0.25+). CI re-audits. |

## 8. Deployment scenarios

1. **One-line installer** (recommended) — `curl … install.sh | sudo bash` on Raspberry Pi / Debian / Ubuntu / Chromebook Linux: systemd service, `chpc` helper, prints URL + setup code.
2. **Docker** — `docker compose up -d` with the prebuilt GHCR image; setup code in the logs; one volume for `/data`, health check, non-root, read-only.
3. **From source** — `npm install && npm run build && HOST=0.0.0.0 CHPC_PUBLIC_DIR=web/dist npm start`; setup code in the terminal.
4. **Remote access** — any of the above behind Caddy/nginx with TLS or via Tailscale; never expose port 4100 directly to the internet.

## 9. Status register

| Area | Status | Verified by |
| ---- | ------ | ----------- |
| Core decision engine (`decide`) | Implemented | 13 unit tests |
| Core DNR rule generator | Implemented, Chrome-schema-checked | 24 unit tests incl. schema assertions; real-Chromium e2e |
| Server API, auth, first-run setup, validation, retention | Implemented | 29 integration tests (supertest) |
| React console | Implemented | Vite production build; browser smoke test (`scripts/e2e-console.mjs`) incl. first-run setup |
| Chrome extension | Implemented | `scripts/e2e-extension.mjs`: pairs via popup, Chrome accepts rules, lock page reason, block-all, usage flush, PIN-gated unpair |
| Docker + env example | Implemented | Prebuilt multi-arch image published by CI; compose needs no secrets up front |
| One-line installer | Implemented | `bash -n`; exercised manually on apt/systemd hosts (not in CI) |
| Guardian PIN gate | **Implemented** | Auth + setup tests; console setup screen and PIN gate; popup unpair check |

## 10. Key design decisions (record)

| #  | Decision | Rationale |
| -- | -------- | --------- |
| D1 | One pure engine shared server/extension | Verdicts never drift between console and enforcement; pure ⇒ deterministic tests. |
| D2 | `node:sqlite`, no ORM, no native deps | `npm install` must work on a fresh Chromebook Linux. |
| D3 | Policy as a validated JSON document | Parents' rules are free-form; migrations stay trivial; validation keeps the stored shape exactly what the engine reads. |
| D4 | Hostname matching, subdomain-inclusive, boundary-safe | Matches parent intuition ("I meant the whole site") without lookalike leaks. |
| D5 | Code-only pairing, PIN-gated unpair | Zero credentials typed on child devices beyond the code; the child cannot silently opt out. |
| D6 | Usage metered on the device, stamped by the server | Enforcement and metering live where browsing happens; the server clock prevents back-dating. |
| D7 | declarativeNetRequest with per-minute recomputation | MV3 cannot block from `webRequest`; DNR has no time conditions, so time is evaluated in the engine each minute and expressed as rule presence. |
| D8 | Rich regex rules with reason, plain rules as fallback, fail-closed last | The child sees *why*; Chrome's 2 kB compiled-regex budget and future API changes cannot leave the browser open. |
| D9 | Hostnames only, 90-day retention | Data minimisation for a child's browsing record; enough for budgets and a week's history. |
| D10 | PIN chosen in the browser, unlocked by a one-time setup code | Non-technical parents never edit config files; possession of the server's log/disk is the proof of ownership, so the LAN cannot claim an unset console. |
