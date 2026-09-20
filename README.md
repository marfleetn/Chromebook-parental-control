# Chromebook Parental Control (CHPC)

Self-hosted parental control for family Chromebooks. A parent sets rules from a
web console; a Chrome **extension enforces** them on each child's Chromebook and
reports usage. No third-party cloud: the machine running this repo (a laptop, a
Chromebook in Linux mode, a small server or a Docker host) is the source of truth.

## Packages

| Path          | What it is                                                                          |
| ------------- | ----------------------------------------------------------------------------------- |
| `core/`       | Pure policy engine: `decide()` for verdicts, `buildDnrRules()` for Chrome rules. No deps. |
| `server/`     | Express 4 + `node:sqlite` API: guardian PIN auth, kids, policies, pairing, usage.    |
| `web/`        | React + Vite parent console (served by the server).                                  |
| `extension/`  | Chrome Manifest V3 extension: applies the policy with declarativeNetRequest, meters usage. |
| `docs/`       | [User guide](docs/USER-GUIDE.md) · [High-level design](docs/HLD.md) · [Low-level design](docs/LLD.md) · [Security report](docs/SECURITY-REPORT.md) |

## Requirements

- **Node.js ≥ 22** (uses the built-in `node:sqlite` module — no native build step).
- npm 10+.
- Chrome / ChromeOS **116 or newer** on each child device.

## Quick start (development, this machine only)

```bash
npm install                 # installs all workspaces
npm test                    # core + API tests (node:test)
npm run build               # console bundle -> web/dist, extension bundle -> extension/vendor/core.js
CHPC_PUBLIC_DIR=web/dist npm start
```

The server listens on `http://127.0.0.1:4100`. Bound to the loopback address
and with no PIN configured it serves the console **without** authentication,
with a warning in the log — fine for trying it out on your own machine, never
for a network-reachable install.

## Quick start (family install)

```bash
cp .env.example .env        # then edit: at least CHPC_GUARDIAN_PIN
docker compose up --build   # console on http://<host>:4100
```

Or without Docker:

```bash
npm install && npm run build
HOST=0.0.0.0 CHPC_GUARDIAN_PIN='choose-a-real-pin' CHPC_PUBLIC_DIR=web/dist npm start
```

The server **refuses to start** on a non-loopback address without a PIN of at
least 6 characters. Then, on each child Chromebook:

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → the `extension/` folder.
2. In the console: add the child → **Devices** → **Generate code**.
3. Click the extension icon on the Chromebook, enter the console address and the code.

Full walkthrough: [docs/USER-GUIDE.md](docs/USER-GUIDE.md).

## Configuration

| Variable              | Default          | Meaning                                                                 |
| --------------------- | ---------------- | ----------------------------------------------------------------------- |
| `PORT`                | `4100`           | Listen port.                                                            |
| `HOST`                | `127.0.0.1`      | Bind address. `0.0.0.0` exposes it to the LAN (requires a PIN).         |
| `CHPC_GUARDIAN_PIN`   | *(unset)*        | Parent PIN, ≥ 6 chars, not sequential/repeated. Required unless loopback. |
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

- **Console and parent API** require the guardian PIN on every request
  (`X-Guardian-PIN` header or `Authorization: Bearer`). The PIN is compared in
  constant time against a SHA-256 kept in memory; ten failures from one address
  lock that address out for 15 minutes.
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
  put it behind a TLS reverse proxy (Caddy, nginx) and set `CHPC_TRUST_PROXY=1`.

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
npm test              # 61 tests across core and server
npm run check         # syntax-check every JS file
npm run build:ext     # rebuild extension/vendor/core.js after touching core/
npm run dev           # API with --watch; console dev server: npm run dev:web (proxies /api)
npm run audit:prod    # dependency advisories for the runtime tree
```

Set `CHPC_GUARDIAN_PIN` for `npm run dev` too, or the console will run
unauthenticated on loopback.

## Licence

MIT — see `LICENSE`.
