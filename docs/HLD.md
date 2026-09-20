# Chromebook Parental Control — High-Level Design

*Version 1.0 · 2026-09 · Status: design of record for core/server/web; extension specified (planned step 5).*

## 1. Purpose

CHPC is a self-hosted parental-control system for family Chromebooks. A parent
author internet rules from a web console; a Chrome **extension enforces** those
rules locally on each child device and reports usage back to the API so time
budgets are real, not just recorded. There is **no third-party cloud**: the
machine running this repo (a laptop, a Chromebook in Linux dev mode, or a small
server) is the single source of truth.

**Goals**

- Rules are simple to state: time windows, off days, daily minutes, per-site
  budgets, block lists, allow lists.
- Enforcement is **local and offline-tolerant** — the extension calls the same
  pure decision function the server does.
- Zero native build steps: `node:sqlite` (built into Node ≥ 22) means
  `npm install` works on a fresh Chromebook Linux environment.
- One code base, one repo, small and auditable.

**Non-goals (v1)**

- Content filtering of page *bodies* (we gate at URL/host and time/budget).
- Multi-admin roles, per-child PIN bypass, audit log export.
- Mobile-app control; Chrome/Chromebook web traffic only.

## 2. Actors

| Actor    | What they do                                                        |
| -------- | ------------------------------------------------------------------- |
| Parent   | Opens the console, adds children, edits policies, pairs devices, watches usage. |
| Child    | Browses with the enforcing extension installed; never touches settings. |
| Operator | Installs the stack, runs tests, builds, deploys (Docker or bare Node). |

## 3. System context

```
                ┌─────────────────────────────┐
                │        Parent (console)     │
                │   React SPA — author rules  │
                └──────────────┬──────────────┘
                               │ HTTPS/HTTP, JSON (/api)
                ┌──────────────▼──────────────┐
                │        CHPC Server          │
                │  Express API + node:sqlite  │
                │  - policy CRUD              │
                │  - device pairing           │
                │  - usage accounting         │
                │  - serves the built console │
                └───────┬───────────────┬─────┘
                        │               │
        policy + tz     │               │   decision verdict
                        ▼               ▼
   ┌────────────────────────┐   ┌────────────────────────┐
   │  @chpc/core (pure JS)  │   │   Chrome extension     │
   │  decide(): allow/deny  │◄──┤   (child Chromebook)   │
   │  same code, both sides │   │   web blocker + meter  │
   └────────────────────────┘   └────────────────────────┘
```

## 4. Components

| Component    | Package      | Role                                                                     |
| ------------ | ------------ | ------------------------------------------------------------------------ |
| Policy core  | `@chpc/core` | Pure decision engine + time/site helpers. No I/O, no clock. Shared by server **and** extension. |
| Server       | `@chpc/server` | Express 4 API, SQLite persistence, device pairing, usage accounting, static console serving. |
| Console      | `@chpc/web`    | React single-page app: kids, policy editor, devices, settings, usage. |
| Extension    | `extension/`   | Chrome MV3 agent on the child device: enforces `decide()`, shows lock page, reports usage. **Specified here; implemented in step 5.** |
| Packaging    | root scripts + Docker (step 6) | One-command dev, build, test; container for deployment. |

**Key invariant — single source of truth:** `decide(policy, url, {now, tz})`
is the *only* place a navigation verdict is computed. The server uses it to
report status; the extension uses it to actually block. Because it is pure
(no `Date.now()`, no I/O, no globals), the identical bytes of JavaScript run
in Node and in the extension and produce identical verdicts. Any new rule
dimension lands in exactly one file.

## 5. Primary flows

**5.1 Policy authoring (parent)**
Console → `PUT /api/kids/:id/policy` → stored as a JSON document per kid →
read back with today's usage injected (`effectivePolicyForKid`).

**5.2 Device pairing (parent ↔ child)**
`POST /api/kids/:id/pairings` mints a 6-character code (unambiguous alphabet,
no 0/O/1/I). Parent reads the code off screen; it is typed once into the
extension on the child Chromebook; the extension heartbeats with the code,
which binds `device.code → kid_id`. De-pairing is `DELETE .../pairings/:code`.

**5.3 Enforcement (child)**
Every web navigation → extension calls `decide()` with the kid's effective
policy → allow, or block with a lock page naming the reason
(off-hours, budget used, site denied…). Permitted browsing is metered in
minutes and reported to `POST /api/devices/:code/usage`, which feeds the
daily/ site budgets used by `decide()` — a feedback loop, not just logging.

## 6. Data & time semantics

- Policy is a **document** (one JSON row per kid), not a relational rule
  table: parents' rules are free-form; a document fits.
- Usage is **relational** (seconds, per site, timestamped) so it sums.
- Storage unit is **seconds**; the engine's unit is **minutes**; the server's
  status layer is the *only* conversion boundary.
- Time reasoning is done in an explicit IANA timezone (default
  `Europe/London`) against an explicit `now`; windows may wrap midnight;
  off days may be ISO dates *or* weekday names ("Sat").
- Allow/deny rules match the **hostname** (so `youtube.com` covers
  `www.`/`m.` subdomains); local-network addresses bypass web policy by design
  (the family router and printers are not "sites").

## 7. Trust & security model

In-scope trust boundary is the LAN. Assumptions and controls:

| Concern                 | Approach                                                                 |
| ----------------------- | ------------------------------------------------------------------------ |
| Console exposure        | Server binds `127.0.0.1` by default; bind another interface + TLS to expose. A guardian PIN gate is planned (see README) but not yet enforced in code — v1 relies on the LAN trust boundary. |
| Pairing codes           | 6 chars from a 22-char unambiguous alphabet, shown once, revocable; codes are bearer tokens — treat like a password. |
| Secrets                 | No credentials or secrets in the repo or in project files; configuration is environment variables only. |
| Extension integrity     | MV3 extension is user-installed; the parent is the only party who holds pairing codes. |
| Usage tampering         | v1 trusts device-reported minutes (good-faith); server-side clock is authoritative for *when* budgets reset. |

## 8. Deployment scenarios

1. **Laptop/desktop dev & personal use** — `npm install && npm test && npm run build:web && npm start`; console on the server port.
2. **Chromebook (Linux dev mode)** — same commands inside the Linux (beta) shell; extension loaded unpacked from `extension/`.
3. **Small server / Docker** (step 6) — one container, one volume for the SQLite file, `CHPC_PUBLIC_DIR` baked in at build time.

## 9. Status register (as of this design)

| Area                 | Status     |
| -------------------- | ---------- |
| Core decision engine | **Implemented + tested** |
| Server API + SQLite  | **Implemented + tested** |
| React console        | **Implemented, UI-verified** (kids, policy, blocked sites, pairing, live `site-denied` verdict) |
| Chrome extension     | Specified (this doc + LLD §6); implementation is step 5 |
| Docker + env example | Step 6 |
| Guardian PIN gate    | Documented in README; **not yet implemented in code** |

## 10. Key design decisions (record)

| #  | Decision                                  | Rationale                                            |
| -- | ----------------------------------------- | ---------------------------------------------------- |
| D1 | One pure `decide()` shared server/extension | Verdicts can never drift between UI and enforcement; pure ⇒ deterministic tests. |
| D2 | `node:sqlite`, no ORM, no native deps     | `npm install` must work on a fresh Chromebook Linux. |
| D3 | Policy as JSON document                   | Parents' rules are free-form; migrations stay trivial. |
| D4 | Hostname matching, subdomain-inclusive    | Matches parent intuition ("I meant the whole site"). |
| D5 | Code-only pairing, no accounts            | Zero credential surface on child devices. |
| D6 | Usage reported by device                  | Enforcement and metering live where the browsing happens. |
