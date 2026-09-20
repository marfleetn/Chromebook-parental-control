# Security policy

CHPC is a self-hosted tool that controls a child's internet access, so security
bugs are treated as the highest-priority class of bug.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Instead, e-mail
the repository owner (see the GitHub profile) with:

- what you found and how to reproduce it,
- the version/commit you tested,
- whether you believe a child could use it to bypass a rule.

You should get an acknowledgement within a week. Fixes are released as normal
commits on `main` with a note in `docs/SECURITY-REPORT.md`.

## Scope

In scope: the API (`server/`), the console (`web/`), the Chrome extension
(`extension/`), the rule engine (`core/`), Docker packaging.

Out of scope (documented limitations, not bugs): a child with Developer-mode
access removing the extension; traffic from other browsers, Android or Linux
apps; anything that requires the guardian PIN.

## Hardening checklist for operators

- Set a strong `CHPC_GUARDIAN_PIN`; never run on `HOST=0.0.0.0` without one
  (the server refuses anyway).
- Keep port 4100 inside your LAN; for remote access use a TLS reverse proxy
  and set `CHPC_TRUST_PROXY=1`.
- Back up `data/chpc.db` (or the Docker volume) somewhere private; it contains
  your children's browsing hostnames.
- Update regularly: `git pull && npm ci && npm run build` (or `docker compose
  up -d --build`), and run `npm run audit:prod`.
- Use supervised (Family Link) or managed accounts on the Chromebooks so the
  extension cannot be disabled.
