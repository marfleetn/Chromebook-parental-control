# Chromebook Parental Control

Self-hosted parental control for family Chromebooks. A parent sets rules from a
web console; a Chrome **extension enforces** them and reports usage. No third‑party
cloud — your Chromebook (or any Linux box) is the source of truth.

## Packages

| Path          | What it is                                                        |
| ------------- | ----------------------------------------------------------------- |
| `core/`       | Pure policy engine (time windows, daily budgets, site rules). No deps. |
| `server/`     | Express + `node:sqlite` API, accounts, rules, usage, activity.     |
| `web/`        | React + Vite parent console.                                        |
| `extension/`  | Chrome MV3 agent that **enforces** policy + reports usage.         |

## Requirements

- **Node.js ≥ 22** (uses the built‑in `node:sqlite` module — no native build).
- npm

## Quick start (development)

```bash
npm install                 # installs all workspaces
npm run test                # core + API tests (node:test)
npm run build:web           # build the console bundle -> server/public
npm start                   # start the API + console on http://localhost:8787
```

Set `CHPC_GUARDIAN_PIN` in the environment (or `server/.env`) before first run —
that PIN guards the whole console.

## Quick start (Chromebook, Linux dev mode)

1. Enable **Linux (beta)** → open the terminal.
2. Install Node 22: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`
3. Copy this repo (e.g. `scp` from your laptop, or `git clone <your-repo>`).
4. `npm install && npm run build:web`
5. `CHPC_GUARDIAN_PIN=your-pin npm start`
6. Console: http://localhost:8787
7. Load the extension on each child Chromebook:
   `chrome://extensions` → toggle **Developer mode** → **Load unpacked** → pick
   `extension/` folder → enter the pairing code shown for the child.

## Architecture

```
  Parent console (web/)                 Chromebook (extension/)
  ┌───────────────────┐                 ┌────────────────────────┐
  │ pair, rules,      │   HTTPS/HTTP    │ webRequest onBeforeRequest│
  │ status, activity  │ ⇄ API ⇄ SQLite  │  └─ core/decide()        │
  └───────────────────┘                 │  reports usage → API     │
                                        └────────────────────────┘
```

- The **core policy engine** is the single source of truth for "is this
  navigation allowed now" — identical code runs server‑side (status / status
  checks) and inside the extension (real‑time blocking).
- The **extension** blocks before the request is sent and shows a lock page on
  denial. It also tallies minutes per site and reports to the API every
  navigation + every 30s. It caches the last policy so a Chromebook still
  respects limits while offline.

## Security model (v1)

- Console is guarded by a single **guardian PIN** (bcrypt‑sha256 hashed at
  rest) passed as the `X-Guardian-PIN` header. This is a single‑family
  gateway, not a multi‑tenant service.
- The extension talks to its server with a **device API key** that is issued
  at pairing. Revoking a child (deleting) revokes the key.
- HTTPS is your job: if you expose this beyond the LAN, put it behind Caddy /
  nginx with TLS.

## Roadmap (post‑v1)

- Per‑site time‑of‑day rules, allow/deny overrides for specific days.
- Webapp‑specific blocklist (e.g. "TikTok always off", "YouTube no after 21:00").
- Multi‑guardian PINs + audit log.
- iOS / Android companion (browser profile via Shortcuts, or a managed profile).
- Scheduled "silent hours" for the whole house.

## Licence

MIT — see `LICENSE`.
