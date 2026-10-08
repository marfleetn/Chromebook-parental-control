## What changed

<!-- One or two sentences. Link the issue if there is one. -->

## Why

## How it was tested

- [ ] `npm run lint` and `npm test` pass locally
- [ ] If `core/` changed: `npm run build:ext` run and `extension/vendor/core.js` committed
- [ ] If the console or extension changed: `npm run e2e:web` / `npm run e2e:ext` pass locally (or I am relying on the Extension workflow)
- [ ] Docs updated where behaviour changed (README, docs/USER-GUIDE.md, docs/LLD.md)

## Security checklist (tick what applies)

- [ ] No new permission in `extension/manifest.json`
- [ ] No new runtime dependency, or `npm audit --omit=dev` is still clean
- [ ] New API routes are behind `requirePin` (parent) or the pairing-code guard (device)
- [ ] No full URLs, PINs or codes written to logs or the database
