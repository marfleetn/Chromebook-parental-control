#!/usr/bin/env bash
# CHPC one-line installer for Debian/Ubuntu/Raspberry Pi OS and the Chromebook
# Linux container. Installs Node 22 if needed, downloads and builds CHPC, sets
# it up as an always-on service, and prints the console address + setup code.
#
#   curl -fsSL https://raw.githubusercontent.com/marfleetn/Chromebook-parental-control/main/install.sh | sudo bash
#
# Re-running upgrades in place and keeps your data. Environment overrides:
#   CHPC_REPO  (default marfleetn/Chromebook-parental-control)
#   CHPC_REF   (default main — a branch, tag or commit)
#   CHPC_PORT  (default 4100)
set -euo pipefail

CHPC_REPO="${CHPC_REPO:-marfleetn/Chromebook-parental-control}"
CHPC_REF="${CHPC_REF:-main}"
CHPC_PORT="${CHPC_PORT:-4100}"
APP_DIR=/opt/chpc
DATA_DIR=/var/lib/chpc
ENV_FILE=/etc/chpc/chpc.env
SERVICE=chpc

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mxx  %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "please run with sudo:  curl -fsSL <url>/install.sh | sudo bash"
command -v systemctl >/dev/null 2>&1 || die "this installer needs systemd (Debian, Ubuntu, Raspberry Pi OS, Chromebook Linux). For other systems use Docker: see README."
command -v apt-get >/dev/null 2>&1 || die "this installer supports apt-based systems only. For other systems use Docker: see README."

say "Installing prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates tar >/dev/null
apt-get install -y -qq qrencode >/dev/null 2>&1 || true   # optional: QR code at the end

need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "node $(node --version), npm $(npm --version)"

say "Downloading CHPC ($CHPC_REPO @ $CHPC_REF)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://github.com/${CHPC_REPO}/archive/${CHPC_REF}.tar.gz" -o "$tmp/chpc.tar.gz"
mkdir -p "$tmp/src"
tar -xzf "$tmp/chpc.tar.gz" -C "$tmp/src" --strip-components=1

say "Building (this takes a minute on a Raspberry Pi)"
( cd "$tmp/src" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent && npm prune --omit=dev --no-audit --no-fund --loglevel=error )

say "Installing to $APP_DIR"
id -u chpc >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin chpc
systemctl stop "$SERVICE" 2>/dev/null || true
rm -rf "$APP_DIR.new"
mkdir -p "$APP_DIR.new"
cp -a "$tmp/src/." "$APP_DIR.new/"
rm -rf "$APP_DIR.old"
[ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.old"
mv "$APP_DIR.new" "$APP_DIR"
rm -rf "$APP_DIR.old"
chown -R root:root "$APP_DIR"
mkdir -p "$DATA_DIR" && chown chpc:chpc "$DATA_DIR" && chmod 700 "$DATA_DIR"

mkdir -p "$(dirname "$ENV_FILE")"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
# CHPC service settings. Edit, then: sudo systemctl restart chpc
HOST=0.0.0.0
PORT=${CHPC_PORT}
CHPC_DB=${DATA_DIR}/chpc.db
CHPC_PUBLIC_DIR=${APP_DIR}/web/dist
CHPC_RETENTION_DAYS=90
# Advanced: fix the PIN here instead of choosing it in the console.
# CHPC_GUARDIAN_PIN=
EOF
  chmod 600 "$ENV_FILE"
fi

cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=CHPC — Chromebook parental control
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=chpc
Group=chpc
EnvironmentFile=${ENV_FILE}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/env node ${APP_DIR}/server/src/index.js
Restart=always
RestartSec=3
# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${DATA_DIR}
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF

install -m 755 "$APP_DIR/scripts/chpc-ctl.sh" /usr/local/bin/chpc

say "Starting the service"
systemctl daemon-reload
systemctl enable --now "$SERVICE" >/dev/null
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:${CHPC_PORT}/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:${CHPC_PORT}/api/health" >/dev/null 2>&1 || { journalctl -u "$SERVICE" -n 30 --no-pager; die "the service did not come up; see the log above"; }

ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$ip" ] || ip="$(hostname)"
url="http://${ip}:${CHPC_PORT}"
setup_code=""
[ -f "$DATA_DIR/setup-code.txt" ] && setup_code="$(cat "$DATA_DIR/setup-code.txt")"

printf '\n\033[1;32m✔ CHPC is installed and running.\033[0m\n\n'
echo   "  Console:      $url"
if [ -n "$setup_code" ]; then
  echo "  Setup code:   ${setup_code:0:4}-${setup_code:4}   (single use — choose your PIN in the console)"
fi
echo   "  Manage with:  sudo chpc status | logs | update | reset-pin | restart"
if command -v qrencode >/dev/null 2>&1; then
  echo; echo "  Scan on your phone to open the console:"; qrencode -t ANSIUTF8 -m 2 "$url" | sed 's/^/  /'
fi
echo
echo "  Next: open the console, choose a PIN, add a child, then load the extension"
echo "  from $APP_DIR/extension on the Chromebook (see docs/USER-GUIDE.md)."
