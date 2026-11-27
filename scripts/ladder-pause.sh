#!/usr/bin/env bash
#
# ladder-pause.sh — the ladder timer's API-limit pause (scripts/eufin-run-local.sh).
# When the Console API answers "You have reached your specified API usage limits. You will regain
# access on <date> at <time> UTC", every later fire would just fail again and alert, so the run
# writes the reset time to a pause file and each fire before it is a no-op (exit 0, no alert).
# The file lives outside the repo, so it survives a WSL restart; delete it to resume early.
#
#   detect <file>   scan a leg's captured output; on the limit message write the pause file and print
#                   the reset time (exit 0). No message → exit 1. Message but no readable date → exit 2.
#   check           not paused → exit 0 (an expired or malformed pause file is removed). Paused →
#                   print the reset time, exit 1.
#   status          one line for `make ladder-status`.
#
# Exit 1 means exactly the answer above; any other failure (a pause file it cannot write or remove)
# is exit 3, so the caller never mistakes a broken helper for "paused" or "no limit".
#
set -euo pipefail
PAUSE_FILE="${LADDER_PAUSE_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/crash-dash/ladder-paused-until}"
# The Console wording, seen 2026-10-16. Case-insensitive so a capitalisation change still matches.
LIMIT_RE='reached your specified API usage limits'

# The pause file's reset time as epoch seconds — only the ISO form `detect` writes is accepted, so a
# hand edit like "next month" cannot become a pause that never ends.
pause_epoch() {
  local iso
  iso="$(cat "$PAUSE_FILE" 2>/dev/null)" || return 1
  [[ "$iso" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00Z$ ]] || return 1
  date -u -d "$iso" +%s 2>/dev/null
}
drop() { rm -f "$PAUSE_FILE" || { echo "::error:: cannot remove $PAUSE_FILE" >&2; exit 3; }; }

case "${1:-}" in
  detect)
    grep -qiF "$LIMIT_RE" "${2:?detect needs a file}" || exit 1
    # "regain access on 2026-11-01 at 00:00 UTC" → 2026-11-01T00:00:00Z (no time given → midnight UTC).
    when="$(grep -oiE 'regain access on [0-9]{4}-[0-9]{2}-[0-9]{2}( at [0-9]{1,2}:[0-9]{2})?' "$2" | tail -n1 |
      sed -E 's/.* on ([0-9-]+)( at ([0-9:]+))?/\1 \3/I')" || true
    day="${when%% *}"; hm="${when#* }"
    [ -n "$day" ] || exit 2
    [ -n "$hm" ] || hm=00:00
    [ ${#hm} = 4 ] && hm="0$hm"
    iso="${day}T${hm}:00Z"
    date -u -d "$iso" +%s >/dev/null 2>&1 || exit 2
    { mkdir -p "$(dirname "$PAUSE_FILE")" && echo "$iso" >"$PAUSE_FILE"; } || { echo "::error:: cannot write $PAUSE_FILE" >&2; exit 3; }
    echo "$iso"
    ;;
  check)
    [ -f "$PAUSE_FILE" ] || exit 0
    if ! reset_at="$(pause_epoch)"; then
      echo "::warning:: malformed pause file $PAUSE_FILE — ignored and removed" >&2; drop; exit 0
    fi
    if [ "$(date -u +%s)" -ge "$reset_at" ]; then drop; exit 0; fi
    date -u -d "@$reset_at" +%Y-%m-%dT%H:%M:00Z; exit 1
    ;;
  status)
    if [ -f "$PAUSE_FILE" ] && reset_at="$(pause_epoch)" && [ "$(date -u +%s)" -lt "$reset_at" ]; then
      printf 'paused    API usage limit — runs skip until %s (rm %s to resume early)\n' "$(date -u -d "@$reset_at" +%Y-%m-%dT%H:%M:00Z)" "$PAUSE_FILE"
    else
      printf 'paused    no\n'
    fi
    ;;
  *) echo "usage: $0 detect <file> | check | status" >&2; exit 64 ;;
esac
