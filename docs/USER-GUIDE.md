# Chromebook Parental Control — User Guide

*For the parent, not the developer. If you just want to set up the rules,
this is the only document you need.*

## What you get

- A **console** you open in your own browser, protected by a PIN only you
  know: add each child, set their internet rules, see what they actually use.
- An **enforcing Chrome extension** for each child's Chromebook that blocks
  disallowed browsing before the page loads and shows a friendly lock page
  that says *why*.
- **Usage metering**: the Chromebook counts a minute for every minute a site is
  open in the focused window while the child is active, so daily and per-site
  limits are based on real use.
- **No cloud**: everything lives on your own machine. If the server is off, the
  Chromebook keeps enforcing the last rules it knew about.

## What you can control

| Control | What it does |
| ------- | ------------ |
| Internet on/off | One switch that blocks every website for that child. |
| Mode | *Everything allowed except blocked sites*, or *Approved sites only*. |
| Allowed hours | Internet only between, say, 08:00 and 20:00, on the days you tick. A window can cross midnight. |
| Off days | Whole days with no web access: weekdays (e.g. every Sunday) or one-off dates (exams, holidays). |
| Daily limit | A total minutes-per-day cap across every site. Blank = no limit. |
| Per-site limits | A minutes cap for one site — e.g. 30 minutes of YouTube, everything else as normal. |
| Blocked sites | Never allowed, whatever else is set. `youtube.com` also covers `m.youtube.com`, `www.youtube.com`, etc. |
| Approved sites | In *Approved sites only* mode, the only sites that open. |

Home-network addresses (your router, printer, this console) always stay
reachable unless the internet switch is off.

## Setup — one time

**On the machine that will host the server** (a Raspberry Pi, a laptop that is
usually on, a NAS with Docker, or the Chromebook itself in Linux mode). Pick
whichever of these you find easier.

### Option A — one line (Raspberry Pi, Ubuntu/Debian, Chromebook Linux)

Open a terminal and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/marfleetn/Chromebook-parental-control/main/install.sh | sudo bash
```

Wait a minute or two. At the end it prints:

- the **console address** (something like `http://192.168.1.23:4100`) and a QR
  code you can scan with your phone;
- a one-time **setup code** like `KTRM-XPBD`.

CHPC now starts by itself whenever the machine boots. Handy commands later:
`sudo chpc status`, `sudo chpc logs`, `sudo chpc update`, `sudo chpc reset-pin`.

### Option B — Docker (NAS, home server)

```bash
curl -fsSLO https://raw.githubusercontent.com/marfleetn/Chromebook-parental-control/main/docker-compose.yml
docker compose up -d
docker compose logs chpc
```

The log shows the **setup code**. The console is at `http://<that machine>:4100`.
(Many NAS apps, such as Portainer or Container Manager, let you paste the
compose file into a form instead of typing commands.)

### Option C — Node by hand

```bash
git clone <your-repo-url> chpc && cd chpc
npm install && npm run build
HOST=0.0.0.0 CHPC_PUBLIC_DIR=web/dist npm start
```

The terminal prints the setup code.

### Then: choose your PIN

Open the console address in a browser. The first screen asks for the **setup
code** and a **PIN** of your choosing (6+ characters; `123456` and the like are
refused). The code works once; after that the PIN is the only key.

> **Choosing a PIN.** Anyone with the PIN can change every rule — it is the key to
> the whole system. You can change it later in **Settings**. Lost it? On the
> server run `sudo chpc reset-pin` (or `docker compose exec chpc node
> server/src/cli.js reset-pin` then `docker compose restart`) to get a fresh
> setup code.

## Unlocking the console

Open the console address. Enter the PIN. Tick **Remember on this device** only
on your own phone or laptop, never on a shared or child device. The **Lock**
button in the top bar forgets the PIN again. After ten wrong attempts from one
device the console locks that device out for 15 minutes.

## Adding a child and their rules

1. Type the child's name in **New child name…** and click **Add child**.
2. You land on their page with three tabs: **Policy · Devices · Usage**.
3. On **Policy**:
   - leave **Internet is allowed** on (turn it off for an instant "everything off");
   - pick the **Mode**;
   - set a **Daily minutes limit** if you want one;
   - tick **Off days** and/or add one-off dates;
   - tick **Restrict internet to these hours** and set the times and days;
   - add **Blocked sites** and **Per-site time limits** (type the site, press Enter or Add);
   - click **Save policy**. A yellow *unsaved changes* pill reminds you if you
     forget.
4. Changes reach the child's Chromebook within a minute.

## Pairing the child's Chromebook (one time per device)

1. In the console, open the child → **Devices** → give the device a name →
   **Generate code**. You get an 8-letter code like `KTRM-XPBD` and the console
   address to type in. The code is that Chromebook's key: whoever has it can
   read the child's rules and report usage as that device. Revoke it from the
   same tab if it leaks.
2. On the Chromebook, signed in as the child:
   - copy the `extension/` folder from this repo onto the Chromebook (Files app,
     a USB stick, or download the repo zip);
   - open `chrome://extensions`, switch **Developer mode** on (top right),
     click **Load unpacked**, pick the `extension` folder;
   - pin the *CHPC Family* icon (puzzle-piece menu → pin) and click it;
   - enter the **console address** (`http://SERVER-IP:4100`) and the **pairing
     code**, click **Pair & connect**. The popup should say *Paired* and show
     the child's name.
3. Back in the console, the Devices tab shows *last seen just now* within a
   minute. Type a site into **Test a decision** to see what the Chromebook will
   do with it right now.

### Important: what the extension cannot stop

The extension is installed in Developer mode. A child who can open
`chrome://extensions` can switch it off or remove it. To close that door:

- use a **Family Link supervised account** for the child on the Chromebook
  (it restricts extensions and Developer mode), or a school/enterprise-managed
  device that force-installs the extension;
- do **not** give the child the owner account of the Chromebook;
- check the **Devices** tab now and then: *last seen* going stale means the
  extension has stopped talking to the console.

Unpairing from inside the popup requires the guardian PIN, and only works while
the console is reachable, so the child cannot quietly opt out that way.

## Day to day

| Want to… | Do this |
| -------- | ------- |
| See what a child used today | Child → **Usage**: minutes used, top sites, 7-day bars. |
| Switch the internet off right now | Child → **Policy** → untick **Internet is allowed** → Save. |
| Give one extra hour tonight | Widen the **Allowed hours** or raise the **Daily minutes limit**, Save. Undo tomorrow. |
| Block a site for good | **Blocked sites** → type it → Add → Save. |
| Let only school sites work | Mode → **Approved sites only**, add the sites, Save. |
| Check what the Chromebook would do with a site | **Devices** → **Test a decision**. |
| Unpair a Chromebook | **Devices** → **Unpair** next to it. It stops being managed within a minute. |
| Rename a child | Click the name at the top of their page. |
| Remove a child | Dashboard → × next to the name. Their rules, devices and usage are deleted. |
| Change the time zone the rules run in | **Settings** (top right). |
| Change the PIN | **Settings** → Guardian PIN. Every browser and every Chromebook popup will ask for the new one. |
| Forgot the PIN | On the server: `sudo chpc reset-pin` (Docker: see Setup). It prints a new setup code. |
| Update CHPC | `sudo chpc update` (Docker: `docker compose pull && docker compose up -d`). Rules and data are kept. |

## What the lock page says

When a page is blocked the child sees a lock page naming the site and one of:

- *Internet is switched off*
- *Today is an off day*
- *Outside allowed hours*
- *Daily time is used up*
- *This site is blocked*
- *Time limit for this site reached*
- *Site not on the approved list*
- *Console unreachable* (the Chromebook has never received rules and cannot
  reach the console — everything except the home network is locked until it can)

## Troubleshooting

| Symptom | First thing to check |
| ------- | -------------------- |
| Console shows *server offline* | Is the server running? Same Wi-Fi? Right IP and port 4100? |
| Console shows "set up your PIN" again | The PIN was reset, or the database was moved. Use the setup code from `sudo chpc status` / the server log. |
| Lost the setup code | `sudo chpc status` shows it while setup is pending; or restart the server for a fresh one. |
| Popup says the code is not recognised | Codes are letters only, no digits — retype it, or revoke and generate a new one. Check the console address (include `http://`). |
| Child can browse but no limits apply | Devices tab: is *last seen* recent? If not, the extension is off, unpaired or cannot reach the server. Reload it from `chrome://extensions`. |
| Usage stays at 0 | Minutes are only counted while the child is active in a focused Chrome window. If it stays at 0 while they browse, see the previous row. |
| A site I blocked still opens | Match is by site name: `bbc.co.uk` blocks `www.bbc.co.uk` and `news.bbc.co.uk`, but not `bbc.com`. Add each. |
| Rules changed but the Chromebook still acts on old ones | It refreshes every minute. The popup's **Refresh now** forces it. |
| Wrong day boundary / off day starts at the wrong time | Check the time zone in **Settings**. |
| Locked out after too many PIN attempts | Wait 15 minutes, or restart the server. |
| Using a normal laptop instead of a Chromebook | Works the same: install Chrome, load the same `extension/` folder unpacked. |

## Privacy

- Rules, children, devices and usage live in **one SQLite file** on your
  machine (`/var/lib/chpc/chpc.db` with the installer, the `/data` volume in Docker). Back it up if you
  care about the rules; deleting it is a full reset.
- Your PIN is stored only as a salted hash; nobody can read it back.
- Only the **site name** (hostname) of what the child visits is recorded —
  never full page addresses, searches or page content.
- Usage older than **90 days** is deleted automatically
  (`CHPC_RETENTION_DAYS` changes this).
- Nothing leaves your home network: no accounts, no telemetry, no cloud.
- Deleting a child deletes everything about them immediately.

## Files worth knowing

| Path | What it is |
| ---- | ---------- |
| `/var/lib/chpc/chpc.db` | Your data (one-line installer). Docker: the `chpc-data` volume. By hand: `data/chpc.db`. |
| `/etc/chpc/chpc.env` | Service settings (one-line installer). |
| `extension/` | The folder to load on each Chromebook. |
| `docs/SECURITY-REPORT.md` | What was reviewed, what was fixed, what remains. |
| `docs/HLD.md`, `docs/LLD.md` | Design documents, if a developer helps you. |
