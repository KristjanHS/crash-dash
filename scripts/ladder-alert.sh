#!/usr/bin/env bash
#
# ladder-alert.sh <unit> — one ntfy push for a failed ladder run; ExecStart of
# crash-dash-ladder-alert.service (the OnFailure= of crash-dash-eufin.service). The body is the failed
# invocation's systemd Result plus its last `::error::` lines, so a kill/timeout the run script never
# saw still alerts. Pushed via scripts/ladder-notify.sh (topic resolution lives there); unset topic → the journal only.
#
set -uo pipefail
UNIT="${1:-crash-dash-eufin.service}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

result="$(systemctl --user show "$UNIT" -p Result --value)"
inv="$(systemctl --user show "$UNIT" -p InvocationID --value)"
errors="$(journalctl --user -u "$UNIT" ${inv:+_SYSTEMD_INVOCATION_ID="$inv"} --no-pager -o cat 2>/dev/null \
  | grep -F '::error::' | sed 's/^::error:: //' | tail -n5)"
body="result: ${result:-unknown}${errors:+$'\n'$errors}"$'\n'"make ladder-log"

printf '%s' "$body" | "$REPO/scripts/ladder-notify.sh" "crash-dash ladder run failed" high warning
