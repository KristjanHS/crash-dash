#!/usr/bin/env bash
# Post-deploy smoke test for the scoring cron (cron-failure-detection).
#
# CI/local check that the FULL write path works against the live deployment —
# not just that the app serves 200s. It triggers /api/cron/run server-side
# (`vercel crons run`: Vercel injects CRON_SECRET; REDERIVE=0 / BLOCKING=1 send .env.prod's) and asserts
# the run actually committed: alert_log's newest fired_at must advance to a fresh
# timestamp. It asserts that off the TABLE, never off the edge-cached /api/status.
# A run triggered before the intraday cutoff (src/intraday.ts) writes NO alert_log row by design —
# so there a readings advance whose run_at classifies intraday is only the cue, and the commit sentinel is the
# `intraday_verdict` slot's run_at. Past the cutoff a readings advance with NO alert row is NOT a failure yet: the
# seam-stamped writes (`seamRunAt`, runAt-1ms — src/series-db-first.ts, backfillHistory, gapFillSweep)
# land ~5 s into the run, while `recordRun` (readings + alert_log) lands ~15 s later — so the poll keeps
# waiting for fired_at and only the MAX_WAIT timeout fails it (false-red observed 2026-10-28 21:30 UTC).
# The same seam write precedes an INTRADAY run's commit too, so readings alone cannot prove it. By default
# that run RE-DERIVES the board: `record_intraday_run` commits its readings AND its verdict into the
# `intraday_verdict` slot (which /lab, /status and /api/exposure serve — `servedVerdict`, src/intraday.ts) in
# one transaction, so the slot turning this run's IS the commit; one that never does fails like an EOD run.
#
# REDERIVE=0 (on `make ship` or the prod scoring cron trigger) keeps the readings-only behaviour: the trigger becomes a
# direct `curl …/api/cron/run?rederive=0` (Bearer CRON_SECRET from .env.prod — `vercel crons run` cannot
# carry a query), the run empties the slot, and every verdict surface stays on the last EOD run until
# 22:00 UTC. Ignored past the cutoff (an EOD run always writes alert_log).
# BLOCKING=1 (the prod scoring cron trigger as the ladder run fires it) takes the same curl without the query: it returns after the
# seed tail + final purge (no `vercel login` needed); a 504 or `X-Vintage-Purged: false` warns, never fails.
#
# This catches anything that breaks the cron — schema drift, a bad env var, a
# feed contract change — within ~1 min of a deploy, instead of waiting for the
# next dead-man ping. The read API (/api/status) can stay green while the cron
# silently 500s (select("*") hides a missing column), so a 200 is NOT proof.
#
# Usage:  BASE_URL=https://<host> scripts/smoke-cron.sh
#         (BASE_URL defaults to the prod alias: PROD_ALIAS from the env or the prod config; neither → refuses.)
# Requires: vercel CLI (authed, or CRON_SECRET under REDERIVE=0 / BLOCKING=1) + curl + python3, AND the checkout's prod
#           config ($PROD_CONFIG_DIR: .env.prod's SUPABASE_URL + SUPABASE_SERVICE_KEY — the write-path assertion reads
#           the table directly — plus .vercel/project.json).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# Release lock (scripts/lib/release-lock.sh): one release at a time on this machine — a concurrent ship.sh or
# smoke-cron.sh could pass this poll on the OTHER run (slot_is_new). Refuse before anything else; under ship.sh §7
# the parent's lock is inherited, not re-taken.
# shellcheck source=lib/release-lock.sh
. "$REPO/scripts/lib/release-lock.sh"
release_lock_acquire "the cron trigger" || exit 1

# Prod-writes switch (scripts/lib/prod-writes.sh): the trigger is a prod WRITE — refuse before either trigger path
# (curl or `vercel crons run`) fires; cron_trigger (lib/cron-trigger.sh) re-checks at the curl
# (before the prod config is loaded: the guard needs nothing from it, and a refused run never loads prod creds).
# shellcheck source=lib/prod-writes.sh
. "$REPO/scripts/lib/prod-writes.sh"
require_prod_writes "the cron trigger" || exit 1

# Auth, mirroring scripts/deploy-prod-local.sh exactly — `ship.sh` §7 runs this AFTER the
# irreversible deploy+push, so a machine authed only by .env.prod's VERCEL_TOKEN (the
# non-interactive path the Makefile header promises) must not fail auth here when §5 succeeded.
#
# The checkout's prod config (scripts/lib/prod-config.sh): `<dir>/.env.prod` into the env (a non-empty env key wins,
# except an identity key the file contradicts → refuse) + VERCEL_ORG_ID / VERCEL_PROJECT_ID from
# `<dir>/.vercel/project.json`. `vercel crons run` resolves the project from those two ids (they win over any
# .vercel/ in the cwd); unlinked, the CLI would PROMPT ("Set up project?") — and both invocations below redirect, so
# the prompt text is swallowed and the run parks silently. Under ship.sh that hang sits after the deploy AND the push.
# So either file missing → one ::error:: line here, the same way deploy-prod-local.sh refuses.
# shellcheck source=lib/prod-config.sh
. "$REPO/scripts/lib/prod-config.sh"
load_prod_config || exit 1

# --token if provided (CI-style, non-interactive); else rely on a prior `vercel login`.
# ⚠ `vercel login` alone is NOT enough since the assertion moved to the table: the guard
# below hard-requires .env.prod's Supabase creds and exits BEFORE the trigger without them.
TOKEN_ARG=()
if [ -n "${VERCEL_TOKEN:-}" ]; then TOKEN_ARG=(--token "$VERCEL_TOKEN"); fi

BASE_URL="${BASE_URL:-}"
[ -n "$BASE_URL" ] || BASE_URL="$(prod_config_base_url)" || exit 1 # PROD_ALIAS: the load above
BASE_URL="${BASE_URL%/}"
CRON_PATH="/api/cron/run"
MAX_WAIT_SECS="${MAX_WAIT_SECS:-180}" # > RUN_FETCH_BUDGET_MS + persist (fetch-budget.ts)
FRESH_LIMIT_SECS=600 # the new firedAt must be < 10 min old (i.e. from THIS run)
EDGE_WAIT_SECS="${EDGE_WAIT_SECS:-60}" # purge-visibility budget; warns, never fails the release
REDERIVE="${REDERIVE:-1}"

[ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_KEY:-}" ] \
  || { echo "::error:: SUPABASE_URL + SUPABASE_SERVICE_KEY must be in .env.prod — the write-path assertion reads the table, not the edge." >&2; exit 1; }

# shellcheck source=lib/cron-trigger.sh
. "$REPO/scripts/lib/cron-trigger.sh"

fired_at() { # echoes alert_log's newest fired_at, or empty on any failure
  set +x # ⛔ the service key rides a -H below; under `bash -x` xtrace would expand it to stderr
  # ⛔ NEVER assert the write path off `$BASE_URL/api/status`: since S-1 it 400s `?cb=`, so the
  # poll cannot bust the P-2 day-long s-maxage and reads whatever edge shard answers — which
  # false-GREENS on another shard's older run and false-REDS while a purge propagates.
  # --connect-timeout/--max-time are MANDATORY: without them a stalled host makes the very
  # first `before=$(fired_at)` call hang forever with ZERO output ("stuck, shows nothing").
  curl -fsS --connect-timeout 6 --max-time 12 \
    -H "apikey: $SUPABASE_SERVICE_KEY" -H "authorization: Bearer $SUPABASE_SERVICE_KEY" \
    "$SUPABASE_URL/rest/v1/alert_log?select=fired_at&order=fired_at.desc&limit=1" 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["fired_at"])' 2>/dev/null || true
}

newest_run_at() { # echoes readings' newest run_at (the intraday run's only commit), or empty on any failure
  set +x # ⛔ same service-key xtrace guard as fired_at
  curl -fsS --connect-timeout 6 --max-time 12 \
    -H "apikey: $SUPABASE_SERVICE_KEY" -H "authorization: Bearer $SUPABASE_SERVICE_KEY" \
    "$SUPABASE_URL/rest/v1/readings?select=run_at&order=run_at.desc&limit=1" 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["run_at"])' 2>/dev/null || true
}

slot_run_at() { # echoes the intraday_verdict slot's run_at, EMPTY for an empty slot, `?` when unreadable
  set +x # ⛔ same service-key xtrace guard as fired_at
  curl -fsS --connect-timeout 6 --max-time 12 \
    -H "apikey: $SUPABASE_SERVICE_KEY" -H "authorization: Bearer $SUPABASE_SERVICE_KEY" \
    "$SUPABASE_URL/rest/v1/intraday_verdict?select=run_at&limit=1" 2>/dev/null \
    | python3 -c 'import sys,json; r=json.load(sys.stdin); print(r[0]["run_at"] if r else "")' 2>/dev/null || echo "?"
}

# Was the slot written by THIS trigger? Strictly newer than the pre-trigger readings sentinel ($2; empty ⇒ any).
# Never "equal to the new sentinel": the deferred input-series seed writes readings ~40 s AFTER the slot.
slot_is_new() { python3 -c 'import sys,datetime as d; p=lambda s: d.datetime.fromisoformat(s.replace("Z","+00:00")); sys.exit(0 if sys.argv[2]=="" or p(sys.argv[1])>p(sys.argv[2]) else 1)' "$1" "$2" 2>/dev/null; }

# The cutoff lives ONCE, in src/intraday.ts — evaluated there, never restated here. Loaded via tsx, not
# bare Node type-stripping: intraday.ts imports `./dates.js`, which only tsx remaps to the .ts source.
is_intraday() { node --import tsx -e 'import("./src/intraday.ts").then((m) => console.log(m.isIntradayCronRun(new Date(process.argv[1]))))' "$1"; }

edge_fired_at() { # the same fact as the EDGE serves it — purge visibility, never the write path
  curl -fsS --connect-timeout 6 --max-time 12 -H 'Cache-Control: no-cache' "$BASE_URL/api/status" 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["verdict"]["firedAt"])' 2>/dev/null || true
}

run_degrades() { # echoes one line per `degraded` scope on the alert_log row fired at $1 ("" when healthy)
  set +x # ⛔ same service-key xtrace guard as fired_at
  # A degraded indicator is OMITTED from the run's readings by design (ECY 2026-08-11), so the id set
  # alone cannot tell omission from a feed another path writes; the run's own `degraded` trace can.
  local ts; ts="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1")"
  curl -fsS --connect-timeout 6 --max-time 12 \
    -H "apikey: $SUPABASE_SERVICE_KEY" -H "authorization: Bearer $SUPABASE_SERVICE_KEY" \
    "$SUPABASE_URL/rest/v1/alert_log?select=degraded&fired_at=eq.$ts&limit=1" 2>/dev/null \
    | python3 -c 'import sys,json; [print(d.get("scope","?")) for d in (json.load(sys.stdin)[0]["degraded"] or [])]' 2>/dev/null \
    || echo "(degraded trace unreadable)"
}
# .replace("Z",..) so a Zulu-suffixed timestamp parses on Python < 3.11 (GH
# runners) — PostgREST currently returns +00:00, but don't bank on it.
age_secs() { python3 -c 'import sys,datetime as d; t=d.datetime.fromisoformat(sys.argv[1].replace("Z","+00:00")); print(int((d.datetime.now(d.timezone.utc)-t).total_seconds()))' "$1"; }

before="$(fired_at)"
before_run="$(newest_run_at)"
echo "before: firedAt=${before:-<none>}  readings run_at=${before_run:-<none>}"

# `--yes vercel@latest` matches scripts/deploy-prod-local.sh: --yes makes npx
# NON-INTERACTIVE (never prompts to install — a prompt would be swallowed by the
# `>/dev/null` below and hang invisibly), and the version anchor keeps both prod
# scripts on one CLI. Not a devDependency on purpose: this 11MB CLI is only used
# by local prod ops, never by CI's unit `check`.
VERCEL="npx --yes vercel@latest"
command -v vercel >/dev/null 2>&1 \
  || echo "note: resolving the Vercel CLI via npx (first run downloads ~11MB to the npx cache) ..."

# BLOCKING=1 (the ladder run): the same direct curl, which returns only after the run's seed tail + final edge purge.
if [ "$REDERIVE" = "0" ] || [ "${BLOCKING:-0}" = "1" ]; then
  set +x # ⛔ the cron secret is expanded below (guard + -H)
  [ -n "${CRON_SECRET:-}" ] || { echo "::error::REDERIVE=0 / BLOCKING=1 need CRON_SECRET (.env.prod) — 'vercel crons run' cannot pass ?rederive=0 nor block." >&2; exit 1; }
  query=""; [ "$REDERIVE" = "0" ] && query="?rederive=0"
  echo "triggering $CRON_PATH$query (blocking until the run returns) ..."
  # The TABLE poll below is the authority: a 504 is the maxDuration kill in the seed tail, AFTER the commit, and under
  # BLOCKING a 500 can be an EOD tail rethrow after the commit too — so only an auth reject (or a REDERIVE=0 500) fails here.
  hdrs="$(mktemp)"
  # Header via stdin so the secret never sits in argv (ps).
  code="$(cron_trigger "$BASE_URL" "$query" "$CRON_SECRET" -sS -o /dev/null -D "$hdrs" -w '%{http_code}' \
    --connect-timeout 10 --max-time 330 || true)"
  purged_hdr="$(tr -d '\r' <"$hdrs" | sed -n 's/^x-vintage-purged: *//Ip' | tail -n1)"; rm -f "$hdrs"
  case "$code" in
    401|403) echo "::error::cron $CRON_PATH$query returned HTTP $code (bad CRON_SECRET?)"; exit 1 ;;
    500) [ "${BLOCKING:-0}" = "1" ] || { echo "::error::cron $CRON_PATH$query returned HTTP 500 (the cycle threw? — function log)"; exit 1; }
         echo "::warning::cron returned HTTP 500 (a seed-tail rethrow, or the cycle threw — function log) — polling the table for the commit." ;;
    2??) [ "$purged_hdr" != "false" ] || echo "::warning::X-Vintage-Purged: false — an edge purge failed; reads may serve the previous run (function log: '[cron] edge purge')." ;;
    *) echo "::warning::cron $CRON_PATH$query returned HTTP ${code:-<none>} (504 = maxDuration kill in the seed tail: its final purge never ran) — polling the table for the commit." ;;
  esac
else
  echo "triggering $CRON_PATH ..."
  $VERCEL crons run "$CRON_PATH" "${TOKEN_ARG[@]}" >/dev/null || { # keep stderr: surfaces the real CLI error
    echo "::error::failed to trigger cron via 'vercel crons run' (auth? path not in vercel.json? CLI outdated?)"
    exit 1
  }
fi

echo "polling alert_log fired_at (EOD) / the intraday_verdict slot (intraday) to advance (up to ${MAX_WAIT_SECS}s) ..."
classified_run=""; eod_pending=""; intraday=""; intraday_pending=""; intraday_slot="" # never inherited from the caller / the prod config load (load_prod_config exports every key)
# Wall-clock bound ($SECONDS), not a sum of sleeps: each probe's curls (--max-time 12) + python spawns count too.
start=$SECONDS; waited=0
# Interval widens 2 → 4 s after the first two probes: the cron commits in 8-16 s on a normal
# release (measured across 2026-08-20's runs), so a fixed 4 s opener spends up to 4 s waiting on
# a run that already landed, while a 2 s poll for the whole MAX_WAIT_SECS window would just add requests.
interval=2
while [ "$waited" -lt "$MAX_WAIT_SECS" ]; do
  sleep "$interval"; waited=$((SECONDS - start))
  [ "$waited" -ge 4 ] && interval=4
  # run_at BEFORE fired_at: `recordRun` commits readings + alert_log in one transaction, so a run_at
  # written by recordRun always sees its alert row — never misread as an alert-less intraday commit (the
  # reverse pairing, fired_at advanced with run_at still old, just takes the fired_at branch). The EARLIER
  # seam-stamped write (runAt-1ms, pre-recordRun) is the "EOD in flight" case handled below.
  run="$(newest_run_at)"
  now="$(fired_at)"
  # Heartbeat every iteration: without it the loop is silent for the full
  # MAX_WAIT_SECS, so a failing cron is indistinguishable from a hang.
  echo "  ...waited ${waited}s/${MAX_WAIT_SECS}s (firedAt=${now:-<unreachable>} run_at=${run:-<unreachable>})"
  if [ -n "$run" ] && [ "$run" != "$before_run" ] && [ "$now" = "$before" ]; then
    # Classify once per run_at: is_intraday spawns node+tsx (~1 s), and an EOD run's seam write repeats this branch every poll.
    if [ "$run" != "$classified_run" ]; then
      intraday="$(is_intraday "$run")" || { echo "::error::is_intraday failed for '$run' — src/intraday.ts unloadable?"; exit 1; }
      classified_run="$run"
    fi
    if [ "$intraday" != "true" ]; then
      # EOD run in flight: a seam-stamped readings write landed, recordRun (alert_log) has not — keep polling fired_at.
      [ "$eod_pending" = "$run" ] || echo "  ...EOD run in flight: readings at $run (seam stamp, runAt-1ms), alert_log row pending"
      eod_pending="$run"
      continue
    fi
    age="$(age_secs "$run")" || { echo "::error::age_secs failed for '$run' — unexpected timestamp format?"; exit 1; }
    [ "$age" -le "$FRESH_LIMIT_SECS" ] || { echo "::error::run_at advanced but is stale (~${age}s) — clock skew?"; exit 1; }
    slot="$(slot_run_at)"
    if [ "$REDERIVE" != "0" ]; then
      # `record_intraday_run` commits readings + slot in ONE transaction, so the slot IS the commit sentinel:
      # readings without this run's slot are a seam-stamped write (runAt-1ms) ahead of the commit — keep polling.
      if [ "$slot" = "?" ] || [ -z "$slot" ] || ! slot_is_new "$slot" "$before_run"; then
        [ "$intraday_pending" = "$run" ] || echo "  ...intraday run in flight: readings at $run, verdict slot still ${slot:-<empty>} ('?' = unreadable) — commit pending"
        intraday_pending="$run"; intraday_slot="$slot"
        continue
      fi
      echo "after:  verdict slot run_at=$slot  (readings + slot, one transaction) — INTRADAY run: no alert_log row, no push (by design)."
      echo "OK — cron committed a fresh intraday run; /lab, /status and /api/exposure serve its dial/band/held (push + alert_log stay EOD)."
      exit 0
    fi
    # REDERIVE=0: the trigger curl above blocked until the run returned, so the slot clear is already done or failed.
    echo "after:  readings run_at=$run  (~${age}s old) — INTRADAY run: no alert_log row, no push (by design)."
    echo "OK — cron committed a fresh intraday run (write path healthy)."
    if [ -z "$slot" ]; then
      echo "REDERIVE=0 — readings only: the verdict slot is empty, so /lab, /status and /api/exposure serve the last EOD verdict until the 22:00 UTC cron."
    else
      echo "::warning::REDERIVE=0 but intraday_verdict reads '$slot' ('?' = unreadable) after the run returned — the slot clear failed (function log: '[intraday] verdict slot not cleared') or the read did; verdict reads serve that older daytime verdict."
    fi
    exit 0
  fi
  if [ -n "$now" ] && [ "$now" != "$before" ]; then
    age="$(age_secs "$now")" || { echo "::error::age_secs failed for '$now' — unexpected timestamp format?"; exit 1; }
    echo "after:  firedAt=$now  (~${age}s old)"
    if [ "$age" -le "$FRESH_LIMIT_SECS" ]; then
      echo "OK — cron committed a fresh run (write path healthy)."
      # Degrades are by design (a non-live feed drops, never aborts), so they WARN, never fail the
      # release — but each is surfaced here instead of hiding behind a green exit.
      degrades="$(run_degrades "$now")" || degrades="(degraded trace unreadable)"
      if [ -n "$degrades" ]; then
        while IFS= read -r scope; do echo "::warning::degraded this run: $scope"; done <<<"$degrades"
      else echo "degraded: none"; fi
      # P-2's day-long TTL is safe ONLY while the cron's `invalidateByTag("vintage")` lands, so a
      # lagging edge is reported — never fatal: the write path is the release fact, this self-heals.
      edge=""; ewaited=0
      while [ "$ewaited" -lt "$EDGE_WAIT_SECS" ]; do
        edge="$(edge_fired_at)"; [ "$edge" = "$now" ] && break
        sleep 4; ewaited=$((ewaited + 4))
      done
      if [ "$edge" = "$now" ]; then echo "edge: /api/status serves this run after ~${ewaited}s (vintage purge OK)."
      else echo "::warning::edge still serves ${edge:-<unreachable>} after ${EDGE_WAIT_SECS}s — vintage purge lagging or FAILED (board may go day-stale)."; fi
      exit 0
    fi
    echo "::error::firedAt advanced but is stale (~${age}s) — clock skew?"
    exit 1
  fi
done

if [ -n "$intraday_pending" ]; then
  echo "::error::intraday readings advanced (latest $intraday_pending) but the verdict slot never became this run within ${MAX_WAIT_SECS}s (last read: ${intraday_slot:-<empty>}, '?' = unreadable) — record_intraday_run never committed: the run died between its seam-stamped write and the commit, or the RPC threw (function log: '[cron] scoring cycle failed')."
elif [ -n "$eod_pending" ]; then
  echo "::error::readings committed at $eod_pending (past the intraday cutoff) but NO alert_log row within ${MAX_WAIT_SECS}s — an EOD run died between the DB-first seam and recordRun (500 / maxDuration?)."
else
  echo "::error::firedAt did not advance within ${MAX_WAIT_SECS}s — cron did not commit (likely a 500)."
fi
echo "--- newest alert_log row (source of truth) + what the edge serves ---"
printf '  table: %s\n  edge:  %s\n' "$(fired_at)" "$(edge_fired_at)"
echo "--- recent prod logs ---"
# `timeout 30`: `vercel logs` can STREAM, so `| head -40` returns only once 40 lines arrive —
# fewer than that and this failure path stalls indefinitely, now on the release path (ship.sh §7).
# shellcheck disable=SC2086  # $VERCEL is a COMMAND ("npx --yes vercel@latest") — the split is the point.
timeout 30 $VERCEL logs "$BASE_URL" "${TOKEN_ARG[@]}" 2>&1 | head -40 || echo "(vercel logs unavailable or timed out — run 'npx vercel logs <deployment>' manually)"
exit 1
