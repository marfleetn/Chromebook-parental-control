# Chromebook Parental Control (CHPC)

[![Tests](https://github.com/marfleetn/Chromebook-parental-control/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/marfleetn/Chromebook-parental-control/actions/workflows/ci.yml)
[![Security](https://github.com/marfleetn/Chromebook-parental-control/actions/workflows/security.yml/badge.svg?branch=main)](https://github.com/marfleetn/Chromebook-parental-control/actions/workflows/security.yml)
[![Extension](https://github.com/marfleetn/Chromebook-parental-control/actions/workflows/extension.yml/badge.svg?branch=main)](https://github.com/marfleetn/Chromebook-parental-control/actions/workflows/extension.yml)
[![Publish](https://github.com/marfleetn/Chromebook-parental-control/actions/workflows/publish.yml/badge.svg?branch=main)](https://github.com/marfleetn/Chromebook-parental-control/actions/workflows/publish.yml)
<br>
[![tests](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmarfleetn%2FChromebook-parental-control%2Fbadges%2Ftests.json)](https://github.com/marfleetn/Chromebook-parental-control/actions/workflows/ci.yml)
[![runtime vulnerabilities](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmarfleetn%2FChromebook-parental-control%2Fbadges%2Fvulnerabilities.json)](https://github.com/marfleetn/Chromebook-parental-control/actions/workflows/security.yml)
[![all-deps vulnerabilities](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmarfleetn%2FChromebook-parental-control%2Fbadges%2Fvulnerabilities-dev.json)](https://github.com/marfleetn/Chromebook-parental-control/actions/workflows/security.yml)
[![CodeQL](https://img.shields.io/badge/CodeQL-security--and--quality-2ea44f?logo=github)](https://github.com/marfleetn/Chromebook-parental-control/security/code-scanning)
<br>
[![extension](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmarfleetn%2FChromebook-parental-control%2Fbadges%2Fextension.json&logo=googlechrome&logoColor=white)](extension/manifest.json)
[![Manifest V3](https://img.shields.io/badge/Chrome%20extension-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![Chrome ≥ 116](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmarfleetn%2FChromebook-parental-control%2Fmain%2Fextension%2Fmanifest.json&query=%24.minimum_chrome_version&label=Chrome&prefix=%E2%89%A5%20&color=4285F4&logo=googlechrome&logoColor=white)](extension/manifest.json)
[![Node ≥ 22](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmarfleetn%2FChromebook-parental-control%2Fmain%2Fpackage.json&query=%24.engines.node&label=Node&color=339933&logo=nodedotjs&logoColor=white)](package.json)
[![Docker image](https://img.shields.io/badge/ghcr.io-chromebook--parental--control-2496ED?logo=docker&logoColor=white)](https://github.com/marfleetn/Chromebook-parental-control/pkgs/container/chromebook-parental-control)
[![Licence: MIT](https://img.shields.io/github/license/marfleetn/Chromebook-parental-control)](LICENSE)

Self-hosted parental control for family Chromebooks. A parent sets rules from a
web console; a Chrome **extension enforces** them on each child's Chromebook and
reports usage. No third-party cloud: the machine running this repo (a Raspberry
Pi, a laptop, a Chromebook in Linux mode, a NAS or any Docker host) is the
source of truth.

## Install in one line

On a Debian/Ubuntu/Raspberry Pi OS machine, or inside a Chromebook's Linux
terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/marfleetn/Chromebook-parental-control/main/install.sh | sudo bash
```

It installs Node 22 if needed, builds CHPC, sets it up as an always-on service
and finishes by printing the console address, a QR code and a one-time **setup
code**. Open the address in a browser, enter the code, choose your PIN. Done.
Manage it later with `sudo chpc status | logs | update | reset-pin`.

**Prefer Docker?** No build step: the image is published to GitHub Container Registry.

```bash
curl -fsSLO https://raw.githubusercontent.com/marfleetn/Chromebook-parental-control/main/docker-compose.yml
docker compose up -d
docker compose logs chpc        # shows the setup code
```

Then, on each child's Chromebook, load the extension and pair it with a code
from the console. Full walkthrough: [docs/USER-GUIDE.md](docs/USER-GUIDE.md).

## Packages

| Path          | What it is                                                                          |
| ------------- | ----------------------------------------------------------------------------------- |
| `core/`       | Pure policy engine: `decide()` for verdicts, `buildDnrRules()` for Chrome rules. No deps. |
| `server/`     | Express 4 + `node:sqlite` API: guardian PIN auth, first-run setup, kids, policies, pairing, usage. |
| `web/`        | React + Vite parent console (served by the server).                                  |
| `extension/`  | Chrome Manifest V3 extension: applies the policy with declarativeNetRequest, meters usage. |
| `install.sh`  | One-line installer (systemd service, `chpc` helper).                                 |
| `docs/`       | [User guide](docs/USER-GUIDE.md) · [High-level design](docs/HLD.md) · [Low-level design](docs/LLD.md) · [Security report](docs/SECURITY-REPORT.md) |

## Requirements

- Server: **Node.js ≥ 22** (built-in `node:sqlite`, no native build) **or** Docker.
- Chrome / ChromeOS **116 or newer** on each child device.

## Running from source (developers)

```bash
npm install
npm test                    # 66 unit + integration tests
npm run build               # console -> web/dist, extension bundle -> extension/vendor/core.js
CHPC_PUBLIC_DIR=web/dist npm start
```

The server prints a setup code on first run; open http://127.0.0.1:4100 and
choose a PIN. To skip the PIN entirely while developing, set
`CHPC_ALLOW_NO_PIN=1` (honoured on loopback addresses only). Real-browser
checks: `npm run e2e:ext` and `npm run e2e:web` (need Playwright + Chromium).

## Configuration

Everything is optional. The installer writes these to `/etc/chpc/chpc.env`;
Docker reads them from `.env`.

| Variable              | Default          | Meaning                                                                 |
| --------------------- | ---------------- | ----------------------------------------------------------------------- |
| `PORT`                | `4100`           | Listen port.                                                            |
| `HOST`                | `127.0.0.1`      | Bind address. `0.0.0.0` exposes it to the LAN (installer and Docker do this). |
| `CHPC_GUARDIAN_PIN`   | *(unset)*        | Advanced: fix the PIN in config instead of choosing it in the console. ≥ 6 chars, not sequential/repeated. |
| `CHPC_ALLOW_NO_PIN`   | *(off)*          | Developers only: no PIN at all. Loopback only.                          |
| `CHPC_DB`             | `./data/chpc.db` | SQLite file. Created `0600` in a `0700` directory.                      |
| `CHPC_PUBLIC_DIR`     | *(unset)*        | Built console directory to serve at `/`.                                |
| `CHPC_RETENTION_DAYS` | `90`             | Usage rows older than this are purged (0 = keep forever).               |
| `CHPC_CORS_ORIGINS`   | *(none)*         | Comma-separated origins allowed to call the API cross-origin. Usually unnecessary. |
| `CHPC_TRUST_PROXY`    | *(off)*          | Set to `1` behind a reverse proxy so rate limits see real client IPs.   |

## Architecture

```
  Parent console (web/)                  Child Chromebook (extension/)
  ┌────────────────────────┐             ┌────────────────────────────────┐
  │ PIN-gated React SPA    │  X-Guardian │ service worker, every minute:  │
  │ kids · policy · usage  │────PIN────► │  GET  /api/devices/:code       │
  └────────────────────────┘   API +     │  POST /api/devices/:code/usage │
                               SQLite    │  buildDnrRules(policy, now)    │
                                 ▲       │  → declarativeNetRequest       │
                                 └───────┤  blocked → pages/blocked.html  │
                                         └────────────────────────────────┘
```

- `core/` is the single source of truth: `decide()` scores one navigation;
  `buildDnrRules()` turns a policy plus the current time into the exact
  declarativeNetRequest rule set Chrome enforces. Both are pure and tested.
- The extension recomputes rules every minute so time windows, off days and
  exhausted budgets flip over without a server round-trip, and keeps applying
  the last cached policy when the server is unreachable.
- Usage is metered on the device (one minute per minute the focused tab shows
  a site while the child is active) and reported in batches. The server clock
  is authoritative and only hostnames are stored.

## Security model

- **First-run setup** is guarded by a one-time code that only the person with
  access to the server's log or disk can see. Until a PIN exists, the parent
  API answers "setup required" to everyone.
- **Console and parent API** require the guardian PIN on every request
  (`X-Guardian-PIN` header or `Authorization: Bearer`). Stored PINs are scrypt
  hashes; comparisons are constant time; ten failures from one address lock
  that address out for 15 minutes. The PIN can be changed in Settings.
- **Devices** authenticate with their pairing code: 8 characters from a
  22-letter alphabet, generated with a CSPRNG, revocable from the console.
  Unknown codes are rate-limited per address.
- **Cross-origin calls are refused** by default (no CORS headers), so a web page
  the child visits cannot talk to the API. Security headers (CSP,
  `X-Frame-Options`, `nosniff`, `Referrer-Policy`) are set on every response.
- **Unpairing from the Chromebook requires the guardian PIN**, verified against
  the server.
- **Data minimisation**: only hostnames, never URLs; usage purged after 90 days
  by default; database file created with owner-only permissions.
- **Transport**: HTTP on your LAN. To reach the console from outside the house,
  put it behind a TLS reverse proxy (Caddy, nginx) or use Tailscale, and set
  `CHPC_TRUST_PROXY=1` for a proxy.

### Known limits (read this)

- The extension is loaded **unpacked in Developer mode**. A child who can open
  `chrome://extensions` can disable or remove it. On a Chromebook, use a
  supervised (Family Link) child account or an enterprise-managed device that
  force-installs the extension and blocks Developer mode; CHPC cannot enforce
  that itself.
- Only Chrome web navigation is controlled. Android apps, Linux apps, guest
  mode and other browsers are out of scope.
- Enforcement is by hostname. It does not inspect page content.

See [docs/SECURITY-REPORT.md](docs/SECURITY-REPORT.md) for the full assessment.

## Development

```bash
npm test              # 66 tests across core and server
npm run check         # syntax-check every JS file
npm run build:ext     # rebuild extension/vendor/core.js after touching core/
npm run dev           # API with --watch; console dev server: npm run dev:web (proxies /api)
npm run audit:prod    # dependency advisories for the runtime tree
npm run cli -- status # or reset-pin (CHPC_DB points at the database)
```

### Continuous integration and badges

| Workflow | What it proves | Badge data |
| -------- | -------------- | ---------- |
| **Tests** (`ci.yml`) | syntax check, 66 unit + integration tests, console and extension builds, bundle freshness, Docker build | after a green run on `main`, regenerates `tests.json`, `vulnerabilities*.json` and `extension.json` on the `badges` branch via `npm run badges` |
| **Security** (`security.yml`) | `npm audit` (fails on any runtime advisory), CodeQL static analysis; also weekly | code-scanning alerts under the repository's Security tab |
| **Extension** (`extension.yml`) | Manifest V3 sanity, no inline scripts, then the extension **and** console run end to end in a real Chromium | — |
| **Publish** (`publish.yml`) | multi-arch image to `ghcr.io/marfleetn/chromebook-parental-control` on `main`; extension zip on `v*` releases | — |

Dependabot (`.github/dependabot.yml`) opens weekly PRs for npm, GitHub Actions
and the base image. Static badges (Manifest V3, Chrome ≥ 116, Node ≥ 22) read
the values straight from `extension/manifest.json` and `package.json`.

## Licence

MIT — see `LICENSE`.
