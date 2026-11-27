# shellcheck shell=bash
# Parallel job runner for scripts/check.sh (sourced, never executed).
#
#   bg_jobs_init              — fresh log dir + job table (call once)
#   bg_job <label> <cmd...>   — start <cmd> in the background; stdout+stderr → its own log
#   bg_jobs_join              — wait for every job. First failure wins: the rest are killed, the table
#                               is printed, then the failing job's full log; returns that job's rc.
#                               All green: prints the table in START order and returns 0.
#   bg_jobs_kill              — kill every live job (trap it on EXIT/INT/TERM)
#
# Each job runs under `setsid`, so it leads its own process group and a kill reaches its
# grandchildren too (npx → node → vitest workers); killing only the direct child leaves them running.
# A background job of a non-interactive shell is never a group leader, so setsid execs in place and
# `$!` IS the group id. The trade: the jobs leave the terminal's group, so Ctrl-C reaches them only
# through the caller's INT trap → bg_jobs_kill.
#
# Needs bash ≥ 5.1 (`wait -n -p`).

bg_jobs_init() {
  BGJ_DIR="$(mktemp -d -t bg-jobs-XXXXXX)"
  BGJ_LABELS=()
  declare -gA BGJ_PID=() BGJ_STATE=()
}

bg_job() {
  local label="$1"; shift
  # The job times itself, so a duration is the job's own cost, not when the join got round to it.
  setsid bash -c 't0=$EPOCHREALTIME; "$@"; rc=$?; printf "%s\n" "$t0 $EPOCHREALTIME" >"$0.t"; exit "$rc"' \
    "$BGJ_DIR/$label" "$@" >"$BGJ_DIR/$label.log" 2>&1 </dev/null &
  BGJ_PID[$label]=$!
  BGJ_STATE[$label]=running
  BGJ_LABELS+=("$label")
}

bg_jobs_kill() {
  local label pid
  for label in ${BGJ_LABELS+"${BGJ_LABELS[@]}"}; do
    [ "${BGJ_STATE[$label]}" = running ] || continue
    pid="${BGJ_PID[$label]}"
    kill -TERM -- "-$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    BGJ_STATE[$label]=killed
  done
}

# Seconds the job ran, one decimal; "-" when it never finished.
bg__secs() {
  local t0 t1
  [ -s "$BGJ_DIR/$1.t" ] || { printf -- '-'; return; }
  read -r t0 t1 <"$BGJ_DIR/$1.t"
  awk -v a="$t0" -v b="$t1" 'BEGIN { printf "%.1f s", b - a }'
}

bg__table() {
  local label
  for label in "${BGJ_LABELS[@]}"; do
    printf '  %-6s %-12s %s\n' "${BGJ_STATE[$label]}" "$label" "$(bg__secs "$label")"
  done
}

bg_jobs_join() {
  local -A by_pid=()
  local label pid done_pid rc failed=""
  for label in "${BGJ_LABELS[@]}"; do by_pid[${BGJ_PID[$label]}]="$label"; done
  local live=("${BGJ_PID[@]}")
  while [ ${#live[@]} -gt 0 ]; do
    rc=0
    wait -n -p done_pid "${live[@]}" || rc=$?
    label="${by_pid[$done_pid]}"
    local next=()
    for pid in "${live[@]}"; do [ "$pid" = "$done_pid" ] || next+=("$pid"); done
    live=(${next+"${next[@]}"})
    if [ "$rc" -eq 0 ]; then
      BGJ_STATE[$label]=ok
    else
      BGJ_STATE[$label]=FAIL
      failed="$label"
      bg_jobs_kill
      break
    fi
  done
  bg__table
  if [ -n "$failed" ]; then
    printf '\n── %s failed (rc %s) — full log ──\n' "$failed" "$rc"
    cat "$BGJ_DIR/$failed.log"
    return "$rc"
  fi
  return 0
}
