#!/usr/bin/env bash
#
# ci-stack.sh — isolated "crash-dash-ci" Supabase stack for the integration suite.
#
# Runs ALONGSIDE the dev stack: dev is project_id "crash-dash" on ports 5432x, this one
# is "crash-dash-ci" on ports 5532x (every config.toml `port =` offset +1000). Same Docker
# images as dev ⇒ warm start (seconds), no 72s image pull.
#
# ⚠ NEVER touches the irreplaceable dev DB (:54322). The `_disposable_stack` marker table
# — the barrier that store.test-helpers.ts's truncate() checks before it deletes a row — is seeded
# ONLY here, and every seed/DB URL is asserted to contain :55322 first. An unmarked stack
# (like dev) makes truncate() throw "refusing to truncate", so the dev DB stays safe even
# if a URL is ever misconfigured.
#
# Usage: scripts/ci-stack.sh {up|down|reset|status|env}
#   up     — generate the CI config (if absent), start the stack, APPLY PENDING MIGRATIONS, seed
#            the marker. Idempotent. `supabase start` alone does NOT apply migrations authored
#            since the volume was created (it's a no-op on an existing volume, and `down` keeps
#            the volume) — so `up` follows it with `supabase migration up` to reconcile the CI DB
#            schema to supabase/migrations/ on EVERY bring-up. This runs BEFORE seed_marker so the
#            `notify pgrst, 'reload schema'` there refreshes PostgREST's cache over the new schema.
#            Without this, `make ship` ran its integration gate against a stale stack and failed on
#            a column the migration had already added (e.g. dial_state, 2026-07-21).
#            Readiness is gated by wait_ready(), NOT by `supabase start`'s own 30s health check —
#            see start_stack(). A stack that is genuinely unreachable self-heals rather than aborting
#            the caller: recreate the containers, then (only if that still fails) wipe the disposable
#            CI volume — see `up` below.
#   down   — stop the CI stack (containers down; volumes kept).
#   reset  — re-apply migrations into a clean CI DB (npx supabase db reset), re-seed marker.
#   status — npx supabase status for the CI stack.
#   env    — print `export …` lines (SUPABASE_URL / SUPABASE_SERVICE_KEY / DB_TESTS) for eval.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CI_WORKDIR="${CRASH_DASH_CI_WORKDIR:-$HOME/.crash-dash-ci}"
CI_API_PORT=55321
CI_DB_PORT=55322
CI_API_URL="http://127.0.0.1:${CI_API_PORT}"
CI_DB_URL="postgresql://postgres:postgres@127.0.0.1:${CI_DB_PORT}/postgres"
# The exact endpoint `supabase start` health-checks PostgREST on: the probe goes through KONG on the
# published API port, not to the rest container — so a failure here is "the host cannot reach :55321",
# which is why start_stack() below re-probes it rather than trusting the CLI's verdict.
CI_READY_URL="${CI_API_URL}/rest-admin/v1/ready"
# psql is NOT on the WSL host PATH (only inside the db container / on GitHub-hosted runners),
# so seed SQL is piped INTO the container's own psql. Name is deterministic from project_id.
CI_DB_CONTAINER="supabase_db_crash-dash-ci"

# The stack's service_role key, read from the running stack — never committed. `status -o env`
# emits SERVICE_ROLE_KEY only because `[auth]` is enabled in supabase/config.toml (with auth off it
# prints URLs alone). The key is the CLI's stock local one: it only ever authenticates to this
# 127.0.0.1 stack. Fails loud on an empty read so a caller never arms DB_TESTS with no key.
service_key() {
  local key err
  err="$(mktemp)"
  key="$(sb status -o env 2>"$err" | grep '^SERVICE_ROLE_KEY=' | cut -d= -f2- | tr -d '"')"
  if [ -z "$key" ]; then
    echo "ci-stack.sh: \`supabase status -o env\` printed no SERVICE_ROLE_KEY — the auth container must be running ([auth] enabled in supabase/config.toml). The CLI said:" >&2
    cat "$err" >&2; rm -f "$err"; return 1
  fi
  rm -f "$err"
  printf '%s' "$key"
}

sb() { npx --no-install supabase --workdir "$CI_WORKDIR" "$@"; }

# Fail fast, and BEFORE the two-stage self-heal below, when the Docker daemon is unreachable.
# Without this the `up` path reads "start failed" as "container/volume damage" and escalates all
# the way to `stop --no-backup` — wiping the CI volume over a problem that was never in it (and
# then failing anyway). On this WSL host `/usr/bin/docker` is a symlink INTO the Docker Desktop
# mount, so a stopped Desktop makes the binary itself vanish (broken symlink), not just the
# daemon: both shapes have to be reported, and neither is fixable from inside WSL.
require_docker() {
  if ! command -v docker >/dev/null 2>&1 || ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    echo "ci-stack.sh: the Docker daemon is UNREACHABLE — not starting (and not 'self-healing') the crash-dash-ci stack." >&2
    echo "  On WSL this is almost always Docker Desktop being stopped, or its WSL integration being off" >&2
    echo "  for this distro. Start Docker Desktop on the Windows host (Settings > Resources > WSL" >&2
    echo "  integration must list this distro), wait for it to report Running, then re-run." >&2
    echo "  Check from here with: docker version" >&2
    exit 1
  fi
}

# Fail loud if a URL that is about to be seeded/truncated is anything but the CI DB.
assert_ci_db() {
  case "$1" in
    *:${CI_DB_PORT}*|*:${CI_API_PORT}*) : ;;
    *) echo "REFUSING: '$1' is not the crash-dash-ci stack (:${CI_DB_PORT}/:${CI_API_PORT}) — never seed/truncate the dev DB" >&2; exit 1 ;;
  esac
}

gen_config() {
  mkdir -p "$CI_WORKDIR/supabase"
  # Copy the repo config, rewriting ONLY for isolation:
  #  - project_id  -> crash-dash-ci
  #  - every `port = N`  -> N+1000  (5432x -> 5532x)
  #    (NOTE: `shadow_port = 54320` is intentionally NOT offset — it's db-diff-only
  #     (config.toml:42) and no ci-stack.sh subcommand runs `supabase db diff`, so it
  #     never binds. Offset it here only if this stack ever starts diffing.)
  #  - [db.seed] enabled -> false   (empty stack: migrations only, tests seed their own
  #                                  fixtures; skips loading the 6.3 MB dev seed.sql)
  awk '
    /^\[/                                          { section = $0 }
    /^project_id[[:space:]]*=/                     { print "project_id = \"crash-dash-ci\""; next }
    section == "[db.seed]" && /^enabled[[:space:]]*=/ { print "enabled = false"; next }
    /^[[:space:]]*port[[:space:]]*=[[:space:]]*[0-9]+/ {
      match($0, /[0-9]+/)
      pre = substr($0, 1, RSTART - 1)
      print pre (substr($0, RSTART, RLENGTH) + 1000)
      next
    }
    { print }
  ' "$REPO/supabase/config.toml" > "$CI_WORKDIR/supabase/config.toml"

  # Migrations live once, in the repo; symlink so the CI stack applies the same DDL.
  ln -sfn "$REPO/supabase/migrations" "$CI_WORKDIR/supabase/migrations"
}

# Seed the marker that authorises truncate() on THIS stack only. Lifted from ci.yml's
# "Seed the _disposable_stack marker" step, retargeted to the CI ports. Table EXISTENCE is
# the marker (src/disposable-guard.ts's probe is a zero-row projection); PostgREST caches
# its schema at boot, so we reload + poll through PostgREST (the path the guard reads).
# Bring the local `auth.*` helpers to hosted parity (JSON `request.jwt.claims` GUC). The image's
# init bodies read the legacy per-claim GUCs PostgREST v14 never sets, so RLS keyed on
# `auth.uid()` is NULL locally without this — see scripts/sql/local-auth-shim.sql. Idempotent.
apply_auth_shim() {
  docker exec -i "$CI_DB_CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
    < "$REPO/scripts/sql/local-auth-shim.sql" >/dev/null
}

# Prints how the CI DB's migration history disagrees with this checkout's files; exit 1 when it agrees (or the
# history table is not there yet — a fresh volume `migration up` builds). The CI volume is SHARED by every checkout
# (gen_config re-points the symlink at the last caller), so a worktree's migration left in it failed `migration up`
# from main (2026-11-09 ladder ship): `up` rebuilds the disposable DB on extra/renamed rows or a gap below the newest.
history_mismatch() {
  local db files max extra gap f b
  db="$(docker exec -i "$CI_DB_CONTAINER" psql -U postgres -d postgres -Atc \
    "select version || '_' || coalesce(name, '') from supabase_migrations.schema_migrations" 2>/dev/null | LC_ALL=C sort)" || return 1
  [ -n "$db" ] || return 1
  files="$(for f in "$REPO"/supabase/migrations/*.sql; do b="${f##*/}"; echo "${b%.sql}"; done | LC_ALL=C sort)"
  extra="$(LC_ALL=C comm -23 <(printf '%s\n' "$db") <(printf '%s\n' "$files") | tr '\n' ' ')"
  max="$(printf '%s\n' "$db" | tail -1 | cut -d_ -f1)"
  gap="$(LC_ALL=C comm -13 <(printf '%s\n' "$db") <(printf '%s\n' "$files") | awk -F_ -v m="$max" '$1 < m' | tr '\n' ' ')"
  [ -n "$extra$gap" ] || return 1
  echo "${extra:+not in this checkout: $extra}${gap:+unapplied below the newest: $gap}"
}

seed_marker() {
  case "$CI_DB_CONTAINER" in
    *crash-dash-ci*) : ;;
    *) echo "REFUSING: db container '$CI_DB_CONTAINER' is not the crash-dash-ci stack" >&2; exit 1 ;;
  esac
  docker exec -i "$CI_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
create table if not exists public._disposable_stack (
  id bigint primary key generated always as identity,
  note text not null default 'ephemeral crash-dash-ci stack — safe to truncate; seeded by ci-stack.sh, NOT by a migration'
);
insert into public._disposable_stack default values;
grant select on public._disposable_stack to service_role;
notify pgrst, 'reload schema';
SQL
  assert_ci_db "$CI_API_URL"
  local key
  key="$(service_key)" || exit 1
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    code=$(curl -s -o /dev/null -w '%{http_code}' \
      -H "apikey: $key" -H "Authorization: Bearer $key" \
      "$CI_API_URL/rest/v1/_disposable_stack?select=id&limit=1")
    if [ "$code" = "200" ]; then echo "marker visible through PostgREST after $attempt attempt(s)" >&2; return 0; fi
    sleep 1
  done
  echo "::error:: PostgREST never served public._disposable_stack (last HTTP $code) — stale schema cache; the guard's probe would return false and every integration test would fail as 'refusing to truncate'." >&2
  exit 1
}

# Evidence for the next occurrence, printed before each escalation rung. The discriminating
# question is whether the CONTAINERS are sick or only the host's route to them: kong `healthy`
# + a non-200 here is the Docker-Desktop port-forward false negative (the stack needed patience,
# not a rebuild); anything else is a real container failure.
diagnose() {
  echo "--- ci-stack diagnostics ---"
  docker ps -a --filter "label=com.supabase.cli.project=crash-dash-ci" \
    --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>&1 || true
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$CI_READY_URL" || true)
  # curl still WRITES the 000 placeholder before exiting non-zero, so never append a fallback here.
  echo "readiness probe: HTTP ${code:-none} <- $CI_READY_URL"
  echo "----------------------------"
}

# Poll the CLI's own readiness endpoint until it serves 200. Budget is ELAPSED SECONDS, not an
# attempt count: a probe that hangs costs `--max-time 5` + the 1s sleep, so a 90-iteration loop
# would run up to 9 minutes in exactly the failure this script exists to survive (a dead host route
# can stall rather than refuse — the kill-kong fault injection only covers the fast-refusal half).
# Deadline arithmetic keeps the wall clock inside the budget (+ one in-flight probe).
wait_ready() {
  local budget="${1:-90}" code=""
  local deadline=$((SECONDS + budget))  # separate statement: `local a=$1 b=$((a))` reads a as unset
  while [ "$SECONDS" -lt "$deadline" ]; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$CI_READY_URL" || true)
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  echo "ci-stack.sh: $CI_READY_URL never served 200 in ${budget}s (last HTTP ${code:-none})" >&2
  return 1
}

# Bring the stack up and gate on OUR readiness probe, not the CLI's.
#
# `supabase start` health-checks PostgREST by HEADing $CI_READY_URL on a 1s×30 schedule and, when
# that budget runs out, TEARS THE STACK DOWN ("Stopping containers...") and exits non-zero — even
# though the containers themselves were healthy. Measured on this host (2026-09-09): kong publishes
# :55321 ~14s into a start and the first HEAD after that succeeds, so the normal path uses 1 of the
# 30 retries. A Docker-Desktop/WSL2 hiccup in host→container port forwarding burns all 30 while
# every container stays docker-healthy (the CLI's failure list named ONLY the rest container, never
# kong) — a false negative that used to escalate this script's ladder all the way to wiping the CI
# volume and re-applying every migration, repairing something that was never broken.
#
# `--ignore-health-check` ("Ignore unhealthy services and exit 0") keeps the containers alive so we
# can decide for ourselves; wait_ready() is then the real gate, with a budget the CLI does not offer
# a knob for. A genuinely broken stack (the pgsodium crash-loop below, an unhealthy db) still fails
# here — nothing serves :55321 — and still escalates exactly as before. Anything wait_ready() lets
# through is re-gated immediately by `migration up` + seed_marker, which both fail loud.
start_stack() {
  sb start --ignore-health-check >&2 && wait_ready "${1:-90}"
}

cmd="${1:-}"
# Every subcommand needs a daemon — `env` too: it reads the key from the running stack.
case "$cmd" in up|down|reset|status|env) require_docker ;; esac
case "$cmd" in
  up)
    gen_config
    # `start` is idempotent — a no-op if the stack is already running.
    #
    # Two-stage self-heal, because a CI-stack `start` fails from CONTAINER state far more often
    # than from anything in this repo. Seen 2026-08-08: the db container crash-looped on
    # `pgsodium_getkey.sh: /etc/postgresql-custom/pgsodium_root.key: Is a directory` → `FATAL:
    # invalid secret key`, through Docker's whole restart backoff (1s…50s) until the CLI gave up
    # with "container is not ready: unhealthy" — and `make ship` died on it. The key is a plain
    # file the CLI puts into the container at create time; once the container exists in that broken
    # shape, every retry restarts the SAME container and re-reads the same directory. Recreating it
    # (`stop` REMOVES containers, keeps the volume) cleared it on the first try. Same shape as the
    # leftover-`exited`-containers trap the `cidown` Makefile target documents — so do the recovery
    # here instead of leaving the user a manual `make cidown && make ship`.
    #
    # Stage 2 wipes the CI volume. That is safe ONLY because this stack is disposable and the
    # workdir pins project_id to crash-dash-ci: `migration up` below rebuilds the schema and the
    # tests seed their own fixtures. The dev stack (separate workdir/project/volume) is untouched —
    # and `--no-backup` never appears on any dev path.
    if ! start_stack; then
      echo "ci-stack.sh: the stack never became reachable — recreating the CI containers (volume kept) and retrying" >&2
      diagnose >&2
      sb stop >&2 || true
      if ! start_stack; then
        echo "ci-stack.sh: still failing — the CI volume itself looks broken; wiping it (disposable stack) and retrying once more" >&2
        diagnose >&2
        grep -q 'project_id = "crash-dash-ci"' "$CI_WORKDIR/supabase/config.toml" || {
          echo "REFUSING: $CI_WORKDIR is not the crash-dash-ci project — never --no-backup a stack that might be dev" >&2; exit 1; }
        sb stop --no-backup >&2 || true
        start_stack 120 || { echo "::error:: ci-stack.sh: the CI stack is unreachable after a full wipe — see the container table above." >&2; exit 1; }
      fi
    fi
    # Reconcile schema to supabase/migrations/. `start` does NOT apply migrations added since the
    # volume was created (and `down` keeps the volume), so on an existing CI DB the newest migration
    # is missing until we apply it here — the stale-stack trap this stack's header warns about, now
    # closed rather than left to a manual `reset`. Direct --db-url (:55322) so it can never touch the
    # dev DB; idempotent (a clean no-op when nothing is pending). MUST precede seed_marker: that
    # step's `notify pgrst, 'reload schema'` is what makes the freshly-added columns visible through
    # PostgREST's cache (the "Could not find the '…' column in the schema cache" failure otherwise).
    assert_ci_db "$CI_DB_URL"
    if drift="$(history_mismatch)"; then
      echo "ci-stack.sh: the CI DB's migration history disagrees with $REPO/supabase/migrations ($drift) — another checkout touched it; rebuilding the disposable CI DB from this checkout's migrations" >&2
      sb db reset >&2
    fi
    sb migration up --db-url "$CI_DB_URL" >&2
    apply_auth_shim
    seed_marker
    echo "$CI_API_URL"
    ;;
  down)
    sb stop >&2
    ;;
  reset)
    # No start_stack()/wait_ready() ladder here, deliberately: `db reset` health-waits on the DB
    # CONTAINER only (A5(…,[dbContainerId],{timeoutSeconds: db.health_timeout}) in the CLI) and never
    # probes /rest-admin/v1/ready through kong, so the gateway false negative `up` guards against
    # cannot occur on this path. seed_marker's own 10-attempt PostgREST poll is the gate that remains.
    gen_config
    sb db reset >&2
    apply_auth_shim
    seed_marker
    echo "$CI_API_URL"
    ;;
  status)
    sb status >&2
    ;;
  env)
    # For `eval "$(scripts/ci-stack.sh env)"` — arms the integration half of vitest.
    key="$(service_key)" || exit 1
    echo "export SUPABASE_URL='$CI_API_URL'"
    echo "export SUPABASE_SERVICE_KEY='$key'"
    echo "export DB_TESTS=1"
    ;;
  *)
    echo "usage: scripts/ci-stack.sh {up|down|reset|status|env}" >&2
    exit 2
    ;;
esac
