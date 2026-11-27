#!/usr/bin/env bash
#
# db.sh — one front door for BOTH local Supabase stacks. Default posture: DOWN.
#
#   dev — project "crash-dash",    API :54321 / DB :54322, workdir = this repo.
#         Holds the IRREPLACEABLE dev history (free feeds may close; see `docs/reference.md`
#         §[runbook] Database (local Supabase)). This script only ever `start`/`stop`s it — never `db reset`, never
#         `stop --no-backup`, both of which wipe the Docker volume.
#   ci  — project "crash-dash-ci", API :55321 / DB :55322, disposable. Delegates to
#         ci-stack.sh, which owns config generation + the _disposable_stack marker.
#
# Usage:
#   scripts/db.sh up   {dev|ci|both}      start a stack and LEAVE it up (work session)
#   scripts/db.sh down {dev|ci|both}      stop a stack (containers down, volumes kept)
#   scripts/db.sh status                  what is running right now
#   scripts/db.sh with {dev|ci} -- CMD…   ephemeral: up (if down) → run CMD → ALWAYS down
#     DB_WITH_KEEP=1 holds the stack up after CMD (warm reuse); the next un-flagged `with`
#     reclaims it — pass it per invocation, never from a profile. See the `with` case below.
#
# `with` ALWAYS tears the stack down, however it was found. DOWN is the default posture, so a
# stack found up is by construction an orphan and the next `with` reclaims it — that is the whole
# self-heal, no reaper. The teardown runs on EXIT/INT/TERM, so Ctrl-C on a long-running server
# still cleans up. Use `up` for an explicit work session; it does NOT survive a later `with`.
#
# `down` is durable across reboots because `supabase stop` REMOVES the containers (data lives on
# in the Docker volume) — there is nothing left for Docker's restart policy to bring back up.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The slim config (supabase/config.toml disables realtime/studio/storage/…) starts exactly these
# four containers per stack. All four must be up for the stack to be usable: store.ts talks to
# PostgREST *through* kong, so a live Postgres with a dead kong is not "up", it is broken; and
# `supabase status -o env` emits the service-role key (ci-stack.sh `service_key`) only while auth runs.
DEV_CONTAINERS="supabase_db_crash-dash supabase_kong_crash-dash supabase_rest_crash-dash supabase_auth_crash-dash"
CI_CONTAINERS="supabase_db_crash-dash-ci supabase_kong_crash-dash-ci supabase_rest_crash-dash-ci supabase_auth_crash-dash-ci"

containers_for() { case "$1" in dev) echo "$DEV_CONTAINERS" ;; ci) echo "$CI_CONTAINERS" ;; esac; }
expected_count() { local -a c; read -ra c <<<"$(containers_for "$1")"; echo "${#c[@]}"; }

# Every subcommand below reaches for the Docker daemon, and every one of them MISREPORTS its
# absence: running_count swallows the error (`2>/dev/null`) so `status` prints a confident
# "down" for a stack it never looked at, and `up`/`with` hand the failure to ci-stack.sh's
# self-heal, which reads it as volume damage. Check once, loudly, up front.
require_docker() {
  if ! command -v docker >/dev/null 2>&1 || ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    echo "db.sh: the Docker daemon is UNREACHABLE — cannot start, stop, or report on the local stacks." >&2
    echo "  On WSL this is almost always Docker Desktop being stopped, or its WSL integration being" >&2
    echo "  off for this distro. Start Docker Desktop on the Windows host, wait for Running, re-run." >&2
    echo "  Check from here with: docker version" >&2
    exit 1
  fi
}

# Exact-name match: `docker ps --filter name=X` is a SUBSTRING match, so it would report the
# dev stack as running whenever only crash-dash-ci is up. Compare the full name instead.
running_count() {
  local n=0 c
  for c in $(containers_for "$1"); do
    docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$c" && n=$((n + 1))
  done
  echo "$n"
}

# Three states, and the middle one is why this isn't a boolean:
#   healthy — all up              partial — some up (crashed/killed container)      down — 0 up
# `supabase start` does NOT repair `partial`: on a stack it considers started it prints
# "supabase start is already running." and returns 0 WITHOUT recreating the dead containers —
# verified 2026-07-20 by killing kong+rest, after which a wrapped curl got HTTP 000 and the
# earlier "start is idempotent so it heals" assumption was proved false. Repair therefore has to
# be an explicit stop→start cycle (safe: `stop` keeps the volumes, so no data is at risk).
stack_state() {
  local n; n="$(running_count "$1")"
  if   [ "$n" = "$(expected_count "$1")" ]; then echo healthy
  elif [ "$n" = 0 ]; then echo down
  else echo partial
  fi
}

dev_running() { [ "$(stack_state dev)" != down ]; }
ci_running()  { [ "$(stack_state ci)"  != down ]; }

# After start: same local `auth.*` hosted-parity shim ci-stack.sh applies to the CI DB — catalog-only
# `create or replace`, touches no rows (the dev history stays untouched). See scripts/sql/local-auth-shim.sql.
dev_up()   {
  npx --no-install supabase --workdir "$REPO" start >&2
  docker exec -i supabase_db_crash-dash psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
    < "$REPO/scripts/sql/local-auth-shim.sql" >/dev/null
}
dev_down() { npx --no-install supabase --workdir "$REPO" stop >&2; }   # volumes KEPT — never --no-backup

ci_up()   { "$REPO/scripts/ci-stack.sh" up >/dev/null; }
ci_down() { "$REPO/scripts/ci-stack.sh" down; }

# Bring a stack to `healthy`, repairing a `partial` one on the way (see stack_state).
stack_up() {
  case "$1" in
    dev|ci)
      if [ "$(stack_state "$1")" = partial ]; then
        echo "db.sh: $1 stack is HALF-UP ($(running_count "$1")/$(expected_count "$1") containers) — cycling it to repair" >&2
        stack_down "$1"
      fi
      case "$1" in dev) dev_up ;; ci) ci_up ;; esac
      # Assert the repair actually took, rather than handing the caller a stack with no REST API.
      [ "$(stack_state "$1")" = healthy ] || {
        echo "db.sh: $1 stack still not healthy ($(running_count "$1")/$(expected_count "$1") containers up) after start" >&2
        exit 1
      }
      ;;
    both) stack_up dev; stack_up ci ;;
    *) echo "unknown stack '$1' (want dev|ci|both)" >&2; exit 2 ;;
  esac
}

stack_down() {
  case "$1" in
    dev) dev_running && dev_down || true ;;
    ci)  ci_running  && ci_down  || true ;;
    both) stack_down dev; stack_down ci ;;
    *) echo "unknown stack '$1' (want dev|ci|both)" >&2; exit 2 ;;
  esac
}

cmd="${1:-}"
shift || true

case "$cmd" in up|down|status|with) require_docker ;; esac

case "$cmd" in
  up)
    stack_up "${1:-both}"
    ;;

  down)
    # No default here (unlike `up`): a fat-fingered bare `down` would otherwise yank a parallel
    # session's dev stack. Say which one, or `both` explicitly.
    [ -n "${1:-}" ] || { echo "usage: scripts/db.sh down {dev|ci|both}  (no default — name the stack)" >&2; exit 2; }
    stack_down "$1"
    ;;

  status)
    dev_running && echo "dev  UP    (API :54321, DB :54322)" || echo "dev  down"
    ci_running  && echo "ci   UP    (API :55321, DB :55322)" || echo "ci   down"
    ;;

  with)
    stack="${1:-}"; shift || true
    [ "${1:-}" = "--" ] && shift
    case "$stack" in dev|ci) : ;; *) echo "usage: scripts/db.sh with {dev|ci} -- CMD…" >&2; exit 2 ;; esac
    [ "$#" -gt 0 ] || { echo "usage: scripts/db.sh with $stack -- CMD…" >&2; exit 2; }

    # Teardown is UNCONDITIONAL — there is no ownership snapshot any more. A stack found up is by
    # construction an orphan (nothing legitimately holds one across commands), so reclaiming it is
    # the fix for the 2026-07-25 incident: a SIGKILLed backgrounded `ship` left a stack up and every
    # later consumer took the old "already up — leaving it up" branch, making the orphan permanent.
    # DB_WITH_KEEP=1 — the ONE opt-out, and it belongs to THIS caller only. `ship.sh` sets it
    # (SHIP_KEEP_CI=1) so back-to-back releases stop paying 26 s start + 13 s stop per run
    # (measured 2026-08-20). It does NOT resurrect the 2026-07-25 orphan: the reclaim rule that
    # fixed that incident was "a `with` that finds a stack up tears it down anyway", and every
    # un-flagged `with` still does exactly that. So a held stack is reclaimed by the next un-flagged
    # consumer IF ONE RUNS — that is a conditional, not a structural, guarantee: export
    # SHIP_KEEP_CI=1 in a shell profile and every consumer is flagged, leaving `make cidown` the
    # only reclaim. Prefer `SHIP_KEEP_CI=1 make ship` per invocation.
    # Warm reuse also keeps ROWS, not just the volume: ci-stack.sh re-runs `migration up` on every
    # bring-up so the SCHEMA is never stale, but a test that needs an empty table must truncate.
    KEEP="${DB_WITH_KEEP:-0}"
    teardown() {
      if [ "$KEEP" = "1" ]; then
        echo "db.sh: LEAVING the $stack stack up (DB_WITH_KEEP=1) — the next un-flagged \`db.sh with\`, or \`make ${stack}down\`, stops it" >&2
        return 0
      fi
      echo "db.sh: stopping the $stack stack" >&2
      stack_down "$stack"
    }
    # EXIT and INT/TERM are split deliberately. On SIGINT bash runs the handler and then
    # RESUMES past the interrupted command, falls off the end of the script and exits 0 —
    # so an interrupted `preview:live` would report success. `exit 130` in the signal handler
    # both fixes the status and stops the teardown from racing the still-dying child. The
    # EXIT trap then re-runs teardown, which is harmless: stack_down re-checks whether the
    # stack is actually running (via dev_running/ci_running) before stopping anything.
    trap teardown EXIT
    # An INTERRUPTED run always tears down, DB_WITH_KEEP or not: the flag says "the next release
    # will reuse this stack", and a half-run command leaves no such promise.
    trap 'KEEP=0; teardown; exit 130' INT TERM

    # ALWAYS bring the stack to healthy, whatever state it was found in — a stack found `partial`
    # must be repaired or the command runs against a dead REST API (HTTP 000 — the exact failure
    # seen 2026-07-20). stack_up is a cheap no-op on an already-healthy stack.
    stack_up "$stack"

    # The CI stack's env (URL/key/DB_TESTS) must be armed for the command; dev reads .env.local.
    # Capture-then-eval, mirroring scripts/ship.sh: `eval "$(...)"` returns EVAL's status, not the
    # substitution's, so a failed/empty `ci-stack.sh env` silently no-ops, DB_TESTS stays unset,
    # the store.*.test.ts hasDb gate (src/store.test-helpers.ts) self-skips, and the suite passes GREEN AS UNIT-ONLY. This is the
    # pre-push integration gate, so assert the arming instead of trusting it.
    if [ "$stack" = ci ]; then
      _ci_env="$("$REPO/scripts/ci-stack.sh" env)" || { echo "db.sh: failed to read crash-dash-ci env" >&2; exit 1; }
      eval "$_ci_env"
      [ "${DB_TESTS:-}" = "1" ] || { echo "db.sh: integration not armed (DB_TESTS != 1) — refusing to run a unit-only pass as the integration gate" >&2; exit 1; }
    fi

    "$@"
    ;;

  *)
    echo "usage: scripts/db.sh {up|down|status|with}" >&2
    echo "  scripts/db.sh up   {dev|ci|both}" >&2
    echo "  scripts/db.sh down {dev|ci|both}" >&2
    echo "  scripts/db.sh status" >&2
    echo "  scripts/db.sh with {dev|ci} -- CMD…" >&2
    exit 2
    ;;
esac
