# CHPC — Security, Compliance and Code-Hygiene Report

*Review date: 2026-09-20 · Scope: whole repository at commit `c1634f0` ("CHPC: core policy
engine, Express API, React console, Chrome MV3 extension, Docker, docs") · Outcome:
findings below were fixed in the same change set; residual risks are listed in §6.*

## 1. Summary

The codebase was reviewed for security, usability, compatibility and documentation
accuracy. The design was sound (pure shared rule engine, SQLite, small dependency
surface) but the implementation had **four critical defects**: the API had no
authentication despite the README promising a PIN; cross-origin requests were
allowed from any web page; the Chrome extension could not work at all because
its rules used field names Chrome rejects and its two halves used different
storage keys; and the console mis-read several API responses. The design
documents described a different codebase.

Everything in §3 and §4 is now fixed and covered by tests. Verification status:

| Check | Result |
| ----- | ------ |
| Unit + integration tests (`npm test`) | 61 / 61 pass (core 37, server 24) |
| Extension end-to-end in real Chromium (`npm run e2e:ext`) | pass — Chrome accepts the rules, blocked sites land on the lock page with the right reason, usage flushes, unpair needs the PIN |
| Console end-to-end in real Chromium (`npm run e2e:web`) | pass — PIN gate, policy save, pairing, test-a-decision, usage, lock |
| `npm audit --omit=dev` (runtime deps) | 0 vulnerabilities |
| `npm audit` (incl. dev toolchain) | 0 vulnerabilities (was 1 moderate + 1 high: esbuild ≤ 0.24.2 dev-server request forgery via Vite 5) |
| Syntax check (`npm run check`), console + extension builds | pass |

Severity scale: **Critical** = a child or a web page can bypass or rewrite the
rules; **High** = enforcement silently fails or data is exposed; **Medium** =
weakens a control; **Low** = hygiene.

## 2. Method

- Read every source, test, config and documentation file (≈ 7 300 lines).
- Threat model: the actors are the parent (trusted, holds the PIN), the child
  (untrusted, physically holds the Chromebook and the pairing code), any web
  page the child visits (untrusted, can issue LAN requests), and any other
  device on the home Wi-Fi.
- Compared the code against the Chrome `declarativeNetRequest` and MV3
  service-worker contracts, then **executed the extension in Chromium 141**
  (Playwright) to confirm what Chrome actually accepts, rather than reasoning
  from documentation alone. This caught two defects the unit tests could not.
- Ran `npm audit`, reviewed the lockfile, Dockerfile and compose file.
- Checked each document claim against the code.

## 3. Security findings and fixes

| # | Severity | Finding | Fix |
| - | -------- | ------- | --- |
| S1 | **Critical** | **No authentication.** Every parent route (`/api/kids/**`, `/api/settings`) was open. README claimed a "guardian PIN (bcrypt-sha256 hashed)"; the code contained none. Any device on the Wi-Fi, or the child themselves, could rewrite their own policy or delete their record. | `server/src/auth.js`: `X-Guardian-PIN` / `Bearer` on all parent routes; SHA-256 + `timingSafeEqual`; `401` with machine-readable codes; `503` when unconfigured. `index.js` **refuses to start** on a non-loopback address without a PIN ≥ 6 chars that is not repeated/sequential; loopback-only runs warn loudly. Console gained a PIN gate (`PinGate.jsx`) and a Lock button. Docker compose aborts without the PIN. |
| S2 | **Critical** | **Wildcard CORS** (`cors()` with no options) plus no auth meant a web page the child visited could `fetch('http://<server>:4100/api/kids/1/policy', {method:'PUT'})` and unlock everything. | Removed the `cors` package. No CORS headers by default (browsers then block cross-origin reads and all preflighted writes; the PIN header forces a preflight). Opt-in `CHPC_CORS_ORIGINS` for unusual deployments. Tested. |
| S3 | **High** | **Pairing codes from `Math.random()`**, 6 characters (≈ 1.1×10⁸), no rate limit on unknown-code lookups, so the device credential was enumerable from the LAN. | `crypto.randomInt`, 8 characters (≈ 5.5×10¹⁰), display form `KTRM-XPBD`, case/hyphen-insensitive input; unknown-code lookups rate-limited (20 per 15 min per IP); PIN failures rate-limited (10 per 15 min per IP) with `Retry-After`. |
| S4 | **High** | **Child could unpair or re-point the extension** from the popup ("Forget", editable server address) with no check, and the popup and worker disagreed on storage keys anyway. | Unpair now requires the guardian PIN, verified against `GET /api/auth/check` on the server; the pairing form is hidden while paired. Verified end-to-end (wrong PIN leaves rules in place; right PIN clears them). |
| S5 | **High** | **Full URLs of a child's browsing stored** (`usage.url`), including query strings that can carry session tokens; **no retention** — data grew forever. Client-supplied timestamps were trusted, allowing back-dated usage. | Only the hostname is stored (`url` column kept as `''` for schema compatibility); `CHPC_RETENTION_DAYS` (default 90) purges at start-up and every 6 h; server clock stamps every row; one report capped at 3 600 s; batch endpoint added. |
| S6 | **Medium** | **Loose policy validation**: unknown keys stored and echoed back; a `strict` mode accepted that the engine treats as "unrestricted"; windows accepted without `end`; off-day entries and site patterns not checked; no list bounds. A malformed policy could reach the engine. | `server/src/validate.js`: allow-listed keys only, host-shaped patterns, weekday names / real ISO dates, integer bounds, list caps (500), windows need valid start ≠ end, `dailyMinutes` 0 ⇒ null. 25 malformed shapes rejected in tests. |
| S7 | **Medium** | **No security headers**, `X-Powered-By` leaked, API responses cacheable; a `X-Chpc-TZ` request header was passed straight to `Intl` and an invalid value crashed the request with a 500. | CSP (`default-src 'self'`, no inline scripts), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `COOP`, `Cache-Control: no-store` on `/api`; `x-powered-by` disabled; per-request time-zone override removed (server setting only, validated). |
| S8 | **Medium** | Database directory and file created with default permissions (world-readable on many systems). | Directory `0700`, file `0600`; Docker `/data` `chmod 700`, container runs read-only root FS, all capabilities dropped, `no-new-privileges`. |
| S9 | **Medium** | **Dev toolchain advisories**: esbuild ≤ 0.24.2 (GHSA-67mh-4wv8-2f99, any site can read from the dev server) via Vite 5. | Vite 7.3, `@vitejs/plugin-react` 5.2, esbuild 0.25 (bundler). `npm audit` clean on both trees. |
| S10 | **Low** | Root `package.json` depended on `express@5` (unused; the server uses Express 4) — two Express copies installed, LLD claimed Express 5. | Removed; single Express 4.22 in the tree; docs corrected. |
| S11 | **Low** | Error handler returned raw `e.message` for 4xx (parser internals); no JSON-size errors distinguished. | `400 request body is not valid JSON`, `413` for oversize; 5xx text generic, details logged server-side only. |

## 4. Compatibility and correctness findings (enforcement silently failing)

| # | Severity | Finding | Fix / evidence |
| - | -------- | ------- | -------------- |
| C1 | **Critical** | **DNR rules used fields Chrome does not have**: `requestTypes: ['mainFrame']` (real: `resourceTypes: ['main_frame']`), `dayOfWeek`, `timeOfDayStart/End`, `regexType`, a `description` property, and `extensionPath` without a leading `/`. `updateDynamicRules` throws on any unknown property, so **no rule would ever have been installed** — the extension would have enforced nothing. | `core/src/rules.js` rewritten: only `id/priority/action/condition`; `resourceTypes: ['main_frame']`; time is evaluated in the engine each minute and expressed as rule presence (DNR has no time conditions). Unit tests assert the exact Chrome schema; the e2e run shows Chrome accepting the set. |
| C2 | **Critical** | Service worker used **dynamic `import()`**, which is not permitted in MV3 service workers, and the popup wrote `apiBase` while the worker read `serverUrl`; the popup's refresh message had no listener; the usage listener checked `type === 'mainFrame'` (real value `main_frame`), so **usage was never metered**; `lastSuccess` was a string in one file and a number in another. | `background.js` rewritten as a **module** worker with static imports, one storage schema, message handlers (`STATUS`, `REFRESH`, `WHY`, `FORGET`), tick-based metering of the focused active tab gated on `chrome.idle`, batch flush, offline accounting. |
| C3 | **High** | **Inline `<script>` in the lock page** — MV3's default CSP blocks inline scripts in extension pages, so the page could never show the URL or reason. | Moved to `pages/blocked.js`; `build:ext` now fails the build if any inline script reappears. |
| C4 | **High** | Found only by running Chromium: the combined private-network **regex exceeded Chrome's 2 kB compiled-regex budget**, which rejected the entire rule set — and the fallback path then reported "2 rules applied" while **zero** rules were installed. | Regex split in two (verified with `isRegexSupported`); the worker reads the applied count back from Chrome, retries a simpler flavour, then a fail-closed set, then a one-rule block-all. It can no longer report success it did not observe. |
| C5 | **High** | Found only by running Chromium: `regexSubstitution` replaces the **matched span only**, so the leftover path was appended to the lock-page URL (`…&url=http://www.example.comsome/path`). | Block regexes now consume the whole URL; the lock page receives `scheme://host` only (also better for privacy). |
| C6 | Medium | Local-network bypass differed between `decide()` (`*.lan/.local/…` allowed) and the DNR rules (not allowed) — the two "identical" code paths disagreed. | Both use the same host classes; tested for `printer.lan`, `nas.local`, every RFC 1918 range and the `172.15` / lookalike negatives. |
| C7 | Medium | Console contract mismatches: device list read `d.kid.devices` and `pairingCode` (API sends `devices` and `code`); history read `hist.days` (a number) and `.date` (API: `perDay`, `isoDay`) — the Usage tab **threw**; test-a-decision stringified a Promise; per-site limit minutes were never wired (always 30); status pill never populated. | All fixed in `KidDetail.jsx`, `KidList.jsx`, `api.js`; `/api/kids` now includes devices; verified by the console e2e. |
| C8 | Low | `SettingsDrawer` used a `.scrim` class that does not exist in the stylesheet (no backdrop). | Uses `.drawer-veil`. |

## 5. Usability improvements

- PIN gate with clear messages (wrong / locked out / not configured) and an
  optional "remember on this device"; Lock button.
- Mode selector with an **Approved sites only** editor (the engine supported
  allow-lists; the console could not set them).
- One-off off-day **dates**, "unsaved changes" indicator, rename child, device
  labels, code shown as `KTRM-XPBD` with the console address to type in,
  friendlier pairing copy that matches the real flow (console mints the code).
- Popup: normalises the code and address, explains failures, shows current
  block reason and rule count; lock page names the reason and has *Go back*.
- Extension forgets itself when the parent revokes the code (404), so a revoked
  device stops being managed within a minute without touching it.
- Server exits with a plain-English reason on unsafe configuration.

## 6. Residual risks (accepted or out of scope) — read before relying on CHPC

| Risk | Why it remains | Mitigation |
| ---- | -------------- | ---------- |
| **A child with Developer-mode access can disable or remove the unpacked extension.** | Chrome gives the device's user that power; an extension cannot protect itself. | Use a Family Link supervised account or an enterprise-managed device (force-install, Developer mode blocked). Watch *last seen* in the console. Documented in README, HLD §7, user guide. |
| PIN travels in clear text over the home Wi-Fi. | The server speaks HTTP; TLS termination was out of scope. | Reverse proxy with TLS + `CHPC_TRUST_PROXY=1` for anything beyond the LAN. Documented. |
| Single shared PIN, no audit log of who changed what. | Product scope (one household). | Follow-up if multiple guardians need separate identities. |
| Rate limits are in-memory, per process. | Simplicity; one-family scale. | Restarts clear them; a reverse proxy can add stronger limits. |
| Extension pairing code is readable from `chrome.storage` by anyone with Developer-mode devtools. | Same root cause as row 1. | Same mitigation; the code only grants device-level access (read policy, report usage), never the parent API. |
| A device can over-report usage (locking itself out sooner) but never under-report. | Metering happens where browsing happens. | Acceptable direction of error. |
| Only Chrome web navigation is controlled (not Android/Linux apps, other browsers, guest mode). | Product scope. | Documented. |

## 7. Compliance notes (UK/EU family context)

This is a self-hosted tool a parent runs for their own children, so the parent
is the controller and no third party processes the data. The following
practices now hold and are worth keeping:

- **Data minimisation**: hostnames only; no page URLs, searches or content;
  no accounts, no telemetry, no external calls from server or extension.
- **Storage limitation**: automatic deletion after 90 days by default.
- **Security of processing**: authentication on all parent access, rate
  limiting, least-privilege file permissions and container settings, CSP.
- **Transparency to the child**: the lock page states the reason for every
  block in plain words. Consider also telling children that usage is metered.
- **Right to erasure**: deleting a child cascades to policy, devices and usage.
- **Extension permissions** are the minimum needed (`storage`,
  `declarativeNetRequest`, `tabs`, `alarms`, `idle`, host access for
  redirects); `webRequest` was removed. If ever published to the Chrome Web
  Store, the privacy disclosure would be: hostnames of visited sites, sent only
  to the parent's own server.

## 8. Code hygiene and best practice

| Area | Before | After |
| ---- | ------ | ----- |
| Tests | 40 (core 27, server 13); rules tests asserted a schema Chrome rejects | 61 unit/integration + 2 real-browser e2e scripts; rules tests assert Chrome's actual schema |
| Dependencies (runtime) | `express@4` + unused `express@5` + `cors` | `express@4` only |
| Dependencies (dev) | Vite 5 / esbuild 0.21 with advisories | Vite 7 / esbuild 0.25, clean audit |
| Dead code | `codeForKid`, `activity`, `siteUsageSinceMs`, unused imports, `lastSeenMax`, `context` import | removed |
| Duplicated logic | policy validation inline in `app.js`; two local-host definitions | `validate.js`, `auth.js` modules; one host classification |
| CI | none | `.github/workflows/ci.yml`: check, test, build, bundle-freshness, prod audit, Docker build |
| Docs | README wrong port (8787 vs 4100), promised unimplemented PIN; LLD described non-existent functions, tables, routes and policy shape; user guide described a different UI | README, HLD, LLD, user guide rewritten from the code; SECURITY.md added; this report |
| Container | ran as non-root already | plus read-only FS, dropped capabilities, `no-new-privileges`, `0700` data dir, PIN required by compose |
| Scripts | `test` glob missed `.mjs` in `core/test` in some shells | explicit globs; `check`, `audit:prod`, `e2e:*` added |

### Recommended next steps (not done here)

1. Add ESLint + Prettier configs and run them in CI (kept out to avoid adding
   toolchain scope in this pass).
2. Consider publishing the extension unlisted on the Chrome Web Store so
   Family Link's extension approval and auto-update apply.
3. Optional: per-guardian PINs with an audit table if more than one adult
   administers the console.
4. Optional: TLS in-process (or a documented Caddy recipe) for households that
   want the console reachable from a phone away from home.

## 9. Addendum — easier deployment path (same day)

Added after the review to lower the bar for non-technical parents without
weakening the model above:

| Change | Security notes |
| ------ | -------------- |
| **First-run PIN setup in the console.** No PIN configured → server mints a one-time 8-letter code (CSPRNG), prints it and writes it `0600` next to the database; `POST /api/setup` exchanges code + chosen PIN for a stored **scrypt** hash, then retires the code and deletes the file. | Parent routes answer `503 setup-required` to everyone until then, so an unset console cannot be claimed from the LAN. Setup attempts are rate-limited (10 / 15 min / IP); weak PINs are refused; the code is single use and regenerated on each restart while unset. PIN change from Settings requires the current PIN. `CHPC_GUARDIAN_PIN` still works and, when set, disables in-console changes. The implicit "no PIN on loopback" dev mode became an explicit `CHPC_ALLOW_NO_PIN`, refused on non-loopback hosts. |
| **`install.sh` one-liner** (apt + systemd). | Runs as root by necessity; installs only from the pinned GitHub tarball (`CHPC_REF`), creates an unprivileged `chpc` user, `0700` data dir, `0600` env file, and a hardened unit (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `ReadWritePaths` limited to the data dir). Re-runs are in-place upgrades. Parents should read the script before piping it to `sudo bash`, as with any installer. |
| **Prebuilt image** on GHCR via `publish.yml` (multi-arch), compose without secrets. | Built by GitHub Actions from the repository; pin a version tag (`:1.0.0`) rather than `:latest` if you want reproducibility. Container remains non-root, read-only, capabilities dropped. |
| `chpc` helper / `cli.js reset-pin`. | Requires root on the server; resetting the PIN only removes the hash, and a new setup code is needed to choose another — no back door. |

Tests: 66 unit/integration (was 61); console e2e now exercises the setup screen end to end.

## 10. How to re-verify

```bash
npm ci
npm run check && npm test && npm run build && npm audit --omit=dev
# real-browser checks (needs Playwright + Chromium):
npm i -D playwright && npx playwright install chromium
npm run e2e:ext && npm run e2e:web
```
