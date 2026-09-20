# Chromebook Parental Control — User Guide

*For the parent, not the developer. If you just want to set up the rules,
this is the only document you need.*

## What you get

- A **console** you open in your own browser: add each child, set their
  internet rules, watch what they are actually using.
- An **enforcing Chrome extension** for each child's Chromebook that blocks
  disallowed browsing in real time and shows a friendly lock page.
- **Usage metering**: the child's device reports how many minutes it spent on
  each site, so your daily and per-site limits are based on real usage.
- **No cloud**: everything lives on your own machine. If your WiFi is down
  but the server is on, rules keep working; if the server is off, the
  extension keeps enforcing the last policy it knew about.

## What you can control

| Control              | What it does                                                                 |
| -------------------- | ---------------------------------------------------------------------------- |
| Time windows         | Internet only between, say, 5.00 pm and 9.00 pm on weekdays. Can wrap midnight. |
| Off days             | Days with no web access at all — e.g. school days, or specific exam dates.   |
| Daily budget         | A total minutes-per-day cap across every site (0 = unlimited).               |
| Per-site budgets     | A minutes cap for one site only — e.g. 20 min on YouTube, everything else as normal. |
| Blocked sites        | Sites that are never allowed — e.g. shopping sites. Wildcards allowed.        |
| Allowed sites        | Sites that are always allowed even if their parent domain is blocked.        |

## Setup — one time

**On the machine that will host the server** (your laptop, or the Chromebook
itself in Linux dev mode):

1. Get Node 22. On a Chromebook in Linux dev mode:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```
   On a Linux laptop: `nvm install 22 && nvm use 22` or the distro package.

2. Get the code (from your laptop, or clone the private repo directly):
   ```bash
   # Option A — copy the folder over
   scp -r <you>@<laptop>:/path/to/chpc ~/chpc
   # Option B — clone (needs your GitHub access)
   git clone <your-repo-url> chpc
   ```

3. Build once:
   ```bash
   cd chpc
   npm install
   npm run build:web
   ```

4. Start it:
   ```bash
   npm start
   ```
   → Console is on **http://localhost:4100** (or `http://SERVER-IP:4100`
   from other devices on the same WiFi).

> **Tip** — keep it running in a terminal with `tmux`, or set up a
> system service / autostart if you want it to come up on its own.

## Adding a child and their rules

1. Open the console, click **+ Add child**, type their name.
2. Pick their name on the left — the tabs **Policy · Devices · Usage** appear.
3. **Policy tab** — set:
   - A *weekday* time window (e.g. 17.00–21.00) and a *weekend* window
     (e.g. 09.00–22.00).
   - *Off days* (e.g. Mon–Fri if you want weekends only, or specific ISO
     dates like exams).
   - A **daily limit** in minutes, or leave at 0 for unlimited.
   - **Blocked sites**, one per line or space-separated — e.g.
     `amazon.co.uk`, `facebook.com`, `*.bad-shop.example.net`.
   - **Site limits** — a minutes cap for a specific site, e.g. `youtube.com`
     → 20.
   - **Allowed sites** — e.g. `wikipedia.org`, `bbc.co.uk` — these always work
     even outside the window or on an off day.
   - **Save**.
4. **Devices tab** — click **Generate pairing code**. You see a
   6-character code like `K7F2QX`. That code is what the child's Chromebook
   needs — keep it somewhere safe; anyone with the code can use that
   pairing. Revoke it from the same tab if needed.

## Pairing the child's Chromebook (one time per device)

1. On the Chromebook: `chrome://extensions` → switch **Developer mode** on
   (top-right toggle).
2. Click **Load unpacked** and pick the `extension/` folder (either:
   - copy it over with the same `scp` you used for the rest, or
   - point the file browser at the network share).
3. The extension appears. Click its icon → **Settings** (or the setup page
   it opens on first run) → enter the **server address** (`SERVER-IP:4100`)
   and the **pairing code**.
4. The device locks in. From this point on, every web navigation is checked
   against that child's rules.

## Day to day

| Want to…                          | Do this                                                              |
| --------------------------------- | --------------------------------------------------------------------- |
| Check what a child used today     | Console → child → **Usage** tab → "today" summary + per-site list.    |
| See last week                     | Same tab → **History**.                                                |
| Pause a child for the day         | Set their daily limit to 1 (or 0 if you'd prefer unlimited), save.     |
| Extend hours for one evening      | Widen the weekday window on the Policy tab, save.                       |
| Give a one-off site allowance     | Add it to **Allowed sites**, save.                                     |
| Unpair a device                   | Devices tab → **Revoke** next to the code.                              |
| Remove a child entirely           | Right-click (or the ⋯ menu) on their name → Delete. Confirmed; all their usage and pairings are removed with them. |
| Change the timezone the rules run in | Settings drawer (⚙ icon, top-right of the console).                 |

## What the lock page says

When the extension blocks a navigation, the child sees a simple lock page
that names **why** — one of:

- *It's outside your internet hours.*
- *Today is an off day for online use.*
- *You've used up your daily internet time.*
- *You've reached the limit for this site today.*
- *This site is not allowed.*
- *This site is on the always-allowed list — allowing.* (and it loads)

If the child is confused about a block, they can read that line on the lock
page — no "why was I blocked" guessing.

## Troubleshooting

| Symptom                                                        | First thing to check                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------- |
| Console says "server unreachable"                              | Is `npm start` still running? Is the browser on the machine that is hosting it, on the same network? |
| Extension says "code not recognised"                            | Did you copy the code exactly? Revoke + regenerate from the Devices tab. |
| Child can browse but no limits are applied                      | Open the Console → child's **Usage** tab — if totals are 0, the extension's heartbeat/usage is not landing. Check the pairing. |
| A site you wanted to block still works                          | Wildcards need to match the *hostname* — check spelling. Also confirm the **Allowed sites** list doesn't contain the parent domain. |
| Rules changed but the child's browser still acts on old rules   | The extension refreshes its policy every 5 minutes and on startup. Close and reopen the child's Chrome to force a refresh immediately. |
| You're on the child's own laptop (not a Chromebook)?            | Works fine — install Chrome, use the same `extension/` folder with *Load unpacked*. |

## Privacy

- Rules, kids, usage — all in one SQLite file on your machine
  (default `server/data.db`).
- Nothing leaves the family network except the child's own browsing traffic,
  which goes to the sites they actually visit.
- You can delete a child (name + usage + pairings) from the console; a
  database rebuild is just deleting that file.

## Files worth knowing

| Path                 | What it is                                            |
| -------------------- | ------------------------------------------------------ |
| `server/data.db`     | Your data. Back this up if you don't want to lose rules. |
| `server/src/app.js`  | All the routes — useful if a developer wants to add one. |
| `core/src/policy.js` | The single decision engine — the thing that says allow or deny. |
| `web/dist/`          | The built console the server serves.                   |
| `docs/HLD.md`        | High-level design (what and why).                       |
| `docs/LLD.md`        | Low-level design (module-level, API, and extension spec). |
