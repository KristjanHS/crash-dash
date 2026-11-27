#!/usr/bin/env bash
#
# user-manager-boot-check.sh [--push] — who brought user@<uid> up THIS boot; falsifier for user-manager-rescue@.service.
# Exit 0 PASS (our rescue alone) · 1 FAIL · 2 INCONCLUSIVE (no race, or WSL's rescue fired too). --push = ntfy the verdict.
# Optional: before the reboot, `cat /proc/sys/kernel/random/boot_id > "${XDG_STATE_HOME:-$HOME/.local/state}/crash-dash/pre-reboot-boot-id"`;
# a match on the next run FAILs (no reboot happened). Absent ⇒ that check is skipped.
#
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
uid="$(id -u)"
unit="user@$uid.service"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/crash-dash"

prop() { systemctl show "$unit" -p "$1" --value 2>/dev/null; }
count() { grep -cF -- "$1" <<<"$2"; }

unit_log="$(journalctl -b -u "$unit" -o cat --no-pager 2>/dev/null)"
kern_log="$(journalctl -b -k -o cat --no-pager 2>/dev/null)"
all_log="$(journalctl -b -o cat --no-pager -t systemd 2>/dev/null)"

state="$(prop ActiveState)"
nrestarts="$(prop NRestarts)"
dropins="$(prop DropInPaths)"
fails="$(count 'Failed with result' "$unit_log")"
rescue_log="$(journalctl -b -u "user-manager-rescue@$uid.service" -o cat --no-pager 2>/dev/null)"
rescued="$(count 'Finished Re-start' "$rescue_log")"
wsl_rescue="$(count "is-active $unit returned: failed" "$kern_log")"
wsl_timeout="$(count "Timed out waiting for user session for uid=$uid" "$kern_log")"
pam_owner="$(count "Runtime directory '/run/user/$uid' is not owned" "$all_log")"
boot_id="$(cat /proc/sys/kernel/random/boot_id)"
prev_boot="$(cat "$state_dir/pre-reboot-boot-id" 2>/dev/null)"

if [ -n "$prev_boot" ] && [ "$prev_boot" = "$boot_id" ]; then
  verdict=FAIL; why="no reboot since the pre-reboot boot_id was saved"
elif [[ "$dropins" != *rescue.conf* ]]; then
  verdict=FAIL; why="rescue.conf drop-in not loaded"
elif [ "$state" != active ]; then
  verdict=FAIL; why="$unit is $state after boot"
elif [ "$fails" -eq 0 ]; then
  verdict=INCONCLUSIVE; why="race did not occur this boot; rescue not exercised"
elif [ "$rescued" -eq 0 ]; then
  verdict=FAIL; why="$unit failed but the rescue unit never ran (OnFailure not wired)"
elif [ "$wsl_rescue" -eq 0 ]; then
  verdict=PASS; why="first start failed; our rescue alone brought it up (wsl-timeout=$wsl_timeout)"
else
  verdict=INCONCLUSIVE; why="both our rescue and WSL's fired; ours not isolated"
fi

stamps="$(for f in "$HOME"/.local/share/systemd/timers/stamp-crash-dash-*.timer; do [ -e "$f" ] || continue; t="${f##*/stamp-crash-dash-}"; printf '%s=%s ' "${t%.timer}" "$(date -r "$f" '+%F %T' 2>/dev/null)"; done)"
report="$verdict: $why
state=$state NRestarts=${nrestarts:-?} start-fails=$fails our-rescues=$rescued pam-owner-refusals=$pam_owner
wsl-rescue=$wsl_rescue wsl-session-timeout=$wsl_timeout boot_id=${boot_id:0:8} prev=${prev_boot:0:8}
timer stamps: $stamps"
printf '%s\n' "$report"

if [ "${1:-}" = --push ]; then
  [ -n "${NTFY_TOPIC:-}" ] || NTFY_TOPIC="$(sed -n 's/^NTFY_TOPIC=//p' "$HOME/.config/crash-dash/eufin.env" 2>/dev/null | tail -n1 | tr -d "\"' \r")"
  export NTFY_TOPIC
  prio=default; [ "$verdict" = FAIL ] && prio=high
  printf '%s\n' "$report" | "$REPO/scripts/ladder-notify.sh" "user-manager boot check: $verdict" "$prio" "white_check_mark"
fi

case "$verdict" in PASS) exit 0 ;; FAIL) exit 1 ;; *) exit 2 ;; esac
