#!/usr/bin/env bash
# `chpc` — helper installed by install.sh to /usr/local/bin/chpc.
#   sudo chpc status      what's running, console address, PIN state, setup code if pending
#   sudo chpc logs        follow the service log
#   sudo chpc restart     restart the service
#   sudo chpc update      re-run the installer (keeps data and settings)
#   sudo chpc reset-pin   forget the PIN and print a fresh setup code
set -euo pipefail
APP_DIR=/opt/chpc
ENV_FILE=/etc/chpc/chpc.env
SERVICE=chpc
[ "$(id -u)" -eq 0 ] || { echo "run with sudo: sudo chpc $*"; exit 1; }
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a
export CHPC_DB="${CHPC_DB:-/var/lib/chpc/chpc.db}"

case "${1:-status}" in
  status)
    systemctl --no-pager --lines=0 status "$SERVICE" | sed -n '1,3p' || true
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"; echo "console:    http://${ip:-$(hostname)}:${PORT:-4100}"
    (cd "$APP_DIR" && node server/src/cli.js status)
    ;;
  logs)      journalctl -u "$SERVICE" -f --no-pager ;;
  restart)   systemctl restart "$SERVICE" && echo "restarted" ;;
  update)
    curl -fsSL "https://raw.githubusercontent.com/${CHPC_REPO:-marfleetn/Chromebook-parental-control}/${CHPC_REF:-main}/install.sh" | bash
    ;;
  reset-pin)
    (cd "$APP_DIR" && node server/src/cli.js reset-pin)
    systemctl restart "$SERVICE"
    for _ in $(seq 1 20); do [ -f "$(dirname "$CHPC_DB")/setup-code.txt" ] && break; sleep 0.5; done
    code="$(cat "$(dirname "$CHPC_DB")/setup-code.txt" 2>/dev/null || true)"
    [ -n "$code" ] && echo "new setup code: ${code:0:4}-${code:4}  (open the console to choose a new PIN)"
    ;;
  *) echo "usage: sudo chpc status|logs|restart|update|reset-pin"; exit 1 ;;
esac
