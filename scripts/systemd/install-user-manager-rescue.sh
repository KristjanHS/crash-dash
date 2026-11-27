#!/usr/bin/env bash
#
# sudo scripts/systemd/install-user-manager-rescue.sh — copy the user-manager rescue units into /etc as root-owned
# files (re-run after any edit to them), then daemon-reload. Check: systemctl show user@1000.service -p OnFailure
#
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -d -o root -g root -m 0755 /etc/systemd/system/user@1000.service.d
install -o root -g root -m 0644 "$SRC/user@1000.service.d/rescue.conf" /etc/systemd/system/user@1000.service.d/rescue.conf
install -o root -g root -m 0644 "$SRC/user-manager-rescue@.service" /etc/systemd/system/user-manager-rescue@.service
systemctl daemon-reload
systemctl show --no-pager user@1000.service -p OnFailure -p DropInPaths
