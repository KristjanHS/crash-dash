#!/usr/bin/env bash
#
# ladder-check.sh — read-only health checks of the crash-dash-eufin.timer runs (`/eufin` → `/value`
# → `/semis` → `/spit` → `/sp500`, scripts/eufin-run-local.sh). Backs the `make ladder-*` targets.
# Never starts, stops or edits anything.
#
#   status        timer next/last fire, last run's exit, the leftover unshipped marker
#   runs [DAYS]   one row per run over the last DAYS (default 7): result, duration, per-leg
#                 outcome, ship outcome — parsed from the script's own `[ladder …]` lines
#   log [full]    the latest run's journal; the `make ship` body is elided unless `full`
#   prod          the prod-served public/<leg>.json vs main's committed copy, per leg
#
set -euo pipefail
UNIT=crash-dash-eufin
UNSHIPPED="${XDG_CONFIG_HOME:-$HOME/.config}/crash-dash/eufin-unshipped"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/prod-config.sh
. "$REPO/scripts/lib/prod-config.sh"
# Every leg the runner knows (eufin-run-local.sh; its default LEGS is semis) — one column each in `runs`, one block in `prod`.
LEGS="eufin value semis spit sp500"

# `systemctl show -p` prints in its own property order, not the requested one — read key=value.
prop() { systemctl --user show "$1" -p "$2" --value; }

status() {
  local t_file t_active t_next t_last s_active s_result s_code s_start s_exit
  t_file="$(prop "$UNIT.timer" UnitFileState)"; t_active="$(prop "$UNIT.timer" ActiveState)"
  t_next="$(prop "$UNIT.timer" NextElapseUSecRealtime)"; t_last="$(prop "$UNIT.timer" LastTriggerUSec)"
  s_active="$(prop "$UNIT.service" ActiveState)"; s_result="$(prop "$UNIT.service" Result)"
  s_code="$(prop "$UNIT.service" ExecMainStatus)"
  s_start="$(prop "$UNIT.service" ExecMainStartTimestamp)"; s_exit="$(prop "$UNIT.service" ExecMainExitTimestamp)"
  printf 'timer     %s, %s · next %s · last %s\n' "$t_file" "$t_active" "${t_next:-—}" "${t_last:-—}"
  if [ "$s_active" = activating ]; then
    printf 'last run  RUNNING since %s\n' "$s_start"
  elif [ "$s_result" = success ] && [ "$s_code" = 0 ]; then
    printf 'last run  ok (exit 0) · %s → %s\n' "${s_start:-—}" "${s_exit:-—}"
  else
    printf 'last run  FAILED (result=%s, exit %s) · %s → %s — make ladder-log\n' "$s_result" "$s_code" "${s_start:-—}" "${s_exit:-—}"
  fi
  if [ -f "$UNSHIPPED" ]; then
    printf 'unshipped %s committed but not live — next slot retries, or run make ship\n' "$(cut -c1-8 <"$UNSHIPPED")"
  else
    printf 'unshipped none\n'
  fi
  "$REPO/scripts/ladder-pause.sh" status
  if systemctl --user show-environment | grep -q '^LADDER_AUTH='; then
    printf 'auth      ⚠ LADDER_AUTH is set on the user manager (an interrupted make ladder-run sub?) — the next run refuses and clears it\n'
  fi
}

# One row per run. A run opens on systemd's "Starting" line and closes on "Finished" / "Failed";
# everything between is read off the script's fixed log phrases (eufin-run-local.sh), so a
# reworded log line there shows up here as a blank cell, never as a wrong verdict.
runs() {
  local days="${1:-7}"
  journalctl --user -u "$UNIT.service" --since "-${days}d" -o short-iso --no-pager -q |
  gawk -v days="$days" -v legs="$LEGS" '
    function ts(s) { return mktime(substr(s,1,4) " " substr(s,6,2) " " substr(s,9,2) " " substr(s,12,2) " " substr(s,15,2) " " substr(s,18,2)) }
    function flush(end, res,   d, i) {
      if (!start) return
      d = end ? ts(end) - ts(start) : -1
      printf "%-16s  %6s  %-14s", substr(start,1,10) " " substr(start,12,5), d < 0 ? "—" : sprintf("%dm%02ds", d/60, d%60), res
      for (i = 1; i <= nl; i++) printf "  %-21s", L[i] in leg ? leg[L[i]] : "—"
      printf "  %s\n", ship ? ship : "—"
      n++; start = ""; ship = ""; delete leg
    }
    BEGIN {
      nl = split(legs, L, " "); re = "(" L[1]; for (i = 2; i <= nl; i++) re = re "|" L[i]; re = re ")"
      printf "%-16s  %6s  %-14s", "START", "DUR", "RESULT"
      for (i = 1; i <= nl; i++) printf "  %-21s", toupper(L[i])
      printf "  SHIP\n"
    }
    / systemd\[[0-9]+\]: Starting crash-dash/ { flush("", "running?"); start = $1; next }
    !start { next }
    / systemd\[[0-9]+\]: Finished crash-dash/ { flush($1, "ok"); next }
    /crash-dash-eufin.service: Failed with result/ { match($0, /result .([a-z-]+)./, m); flush($1, "FAIL:" m[1]); next }
    / systemd\[[0-9]+\]: Failed to start crash-dash/ { flush($1, "FAIL"); next }
    / systemd\[[0-9]+\]: Stopped crash-dash/ { flush($1, "STOPPED"); next }
    match($0, "\\] " re ": committed ([0-9a-f]+)", m)    { leg[m[1]] = (leg[m[1]] == "FAIL exit" ? "FAIL+commit " : "committed ") m[2]; next }
    match($0, "\\] " re ": nothing due — applied without claude: ([0-9a-f]+)", m) { leg[m[1]] = "no-claude " m[2]; next }
    match($0, "\\] " re ": no commit", m)               { if (!leg[m[1]]) leg[m[1]] = "no commit"; next }
    match($0, "::error:: /" re " made no commit", m)      { if (leg[m[1]] != "FAIL exit") leg[m[1]] = "FAIL no-commit"; next }
    match($0, "::error:: " re " artifacts have uncommitted", m) { leg[m[1]] = "SKIP dirty"; next }
    match($0, "::error:: /" re " run exited non-zero", m) { leg[m[1]] = "FAIL exit"; next }
    match($0, "::error:: " re " (probe/state|state output|no-research)", m) { leg[m[1]] = "FAIL " (m[2] == "no-research" ? "apply" : "probe/state"); next }
    /\] paused — API usage limit/       { ship = "(paused — API limit)"; next }
    match($0, "::error:: /" re " hit the API usage limit", m) { leg[m[1]] = "API LIMIT"; next }
    match($0, "::error:: /" re " credit balance too low", m) { leg[m[1]] = "NO CREDIT"; next }
    match($0, "/" re " skipped — cycle spend cap", m) { leg[m[1]] = "CYCLE CAP"; next }
    /\] locked — cycle/                 { ship = "(locked — make ladder-run)"; next }
    /another ladder run is in progress/ { ship = "(locked out by a running run)"; next }
    /\] shipped — prod serves/          { ship = "shipped " $NF; next }
    /vercel login stale/                { ship = (ship ~ /FAIL push/ ? "FAIL push + login stale" : "push only — login stale"); next }
    /another ship.sh is running/        { ship = "deferred — ship.sh busy"; next }
    /\] nothing unshipped/              { ship = "none"; next }
    /::error:: .* -s prodcron failed twice/ { ship = "(prodcron failed — no legs)"; next }
    /::error:: another release or CI-stack run .* holds the release lock/ { ship = "(prodcron busy — no legs)"; next }
    /::error:: make ship failed/        { ship = "FAIL make ship"; next }
    /::error:: git push failed/         { ship = ship " + FAIL push"; next }
    /::error:: vercel CLI not resolvable/ { ship = "FAIL vercel CLI"; next }
    END { flush("", "running?"); if (!n) print "(no runs in the last " days " days)" }
  '
}

log_last() {
  local id
  id="$(systemctl --user show "$UNIT.service" -p InvocationID --value)"
  [ -n "$id" ] || { echo "no run recorded since the user manager started — make ladder-runs for older ones" >&2; exit 1; }
  if [ "${1:-}" = full ]; then
    journalctl --user _SYSTEMD_INVOCATION_ID="$id" + USER_INVOCATION_ID="$id" -o short-iso --no-pager -q -a
    return
  fi
  # Elide the `make ship` body (suite + deploy + cron output, ~100 lines) between the script's
  # "make ship (…)" line and its next own line; ::error:: lines always print.
  journalctl --user _SYSTEMD_INVOCATION_ID="$id" + USER_INVOCATION_ID="$id" -o short-iso --no-pager -q |
  gawk '
    /\[ladder [0-9:]+\] make ship/ { print; inship = 1; next }
    inship && /\[ladder [0-9:]+\]|systemd\[[0-9]+\]:/ { if (cut) printf "    … %d make ship lines elided — make ladder-log full\n", cut; inship = 0 }
    inship && !/::error::/ { cut++; next }
    { print }
  '
}

prod() {
  local leg live main PROD
  # The prod alias: env PROD_ALIAS, else the prod config's (loaded in a subshell); neither → its ::error:: line, exit 1.
  PROD="$(prod_base_url)" || exit 1
  for leg in $LEGS; do
    if ! live="$(curl -fsS --max-time 20 "$PROD/$leg.json" | jq -S .)"; then
      printf '%-6s FAIL fetching %s/%s.json\n' "$leg" "$PROD" "$leg"; continue
    fi
    main="$(git -C "$REPO" show "main:public/$leg.json" | jq -S .)"
    printf '%-6s prod run %s · last tally row %s\n' "$leg" "$(jq -r '.run' <<<"$live")" "$(jq -c '.runs[-1]' <<<"$live")"
    if [ "$live" = "$main" ]; then
      printf '       == main (prod serves the committed state)\n'
    else
      printf '       ≠ main — main run %s (unshipped, or edge cache still warm: make purge)\n' "$(jq -r '.run' <<<"$main")"
    fi
  done
}

case "${1:-}" in
  status) status ;;
  runs)   runs "${2:-7}" ;;
  log)    log_last "${2:-}" ;;
  prod)   prod ;;
  *) echo "usage: $0 status | runs [DAYS] | log [full] | prod" >&2; exit 2 ;;
esac
