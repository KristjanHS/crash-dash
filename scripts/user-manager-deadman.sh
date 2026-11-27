#!/usr/bin/env bash
#
# user-manager-deadman.sh — cron dead-man: one ntfy push per day while user@<uid>.service is down (every
# crash-dash user timer and its OnFailure alert live inside it). Crontab: */15 * * * * <repo>/scripts/user-manager-deadman.sh
#
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unit="user@$(id -u).service"
state="$(systemctl is-active "$unit" 2>/dev/null)"
mark="${XDG_STATE_HOME:-$HOME/.local/state}/crash-dash/user-manager-deadman"
case "$state" in active|activating|reloading) rm -f "$mark"; exit 0 ;; esac

today="$(date +%F)"
[ "$(cat "$mark" 2>/dev/null)" = "$today" ] && exit 0

[ -n "${NTFY_TOPIC:-}" ] || NTFY_TOPIC="$(sed -n 's/^NTFY_TOPIC=//p' "$HOME/.config/crash-dash/eufin.env" 2>/dev/null | tail -n1 | tr -d "\"' \r")"
export NTFY_TOPIC
since="$(systemctl show "$unit" -p InactiveEnterTimestamp --value 2>/dev/null)"
printf '%s is %s since %s: no crash-dash user timer fires.\nfix: sudo systemctl start %s\n' \
  "$unit" "${state:-unknown}" "${since:-?}" "$unit" \
  | "$REPO/scripts/ladder-notify.sh" "crash-dash user timers down" high warning || exit 1
mkdir -p "$(dirname "$mark")" && printf '%s\n' "$today" >"$mark"
