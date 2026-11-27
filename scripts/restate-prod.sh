#!/usr/bin/env bash
# Re-score + re-write named ids' FULL prod history after a CUT retune.
#   bash scripts/restate-prod.sh F9,F11          the real pass (--confirm-destructive, as prod demands)
#   bash scripts/restate-prod.sh F9,DB_SMH dry   preview it — row counts + prune scope, writes nothing
# Prod loads NO env file, so the feed key comes from the checkout's prod config (scripts/lib/prod-config.sh),
# best-effort: a key already set in the env wins, a missing file or key stays unset. Plus the two footguns the bare
# npm invocation walks into: the positional job (a flag-only run prints the job list and EXITS 0, writing nothing)
# and --confirm-destructive (restate re-inserts history and prunes the vintages it shadows, so prod refuses it
# unconfirmed). ROUTING: the comma list is partitioned by id prefix — detector ids (`DB_*`/`RS_*`, the
# `DOWNSIDE_DETECTORS` + `RS_LEGS` legs `restatableIds()` enumerates in scripts/backfill.ts) run the `dbreak` job,
# every other id the `indicators` job; each job runs only when its subset is non-empty, so ONE call with
# `F9,DB_SMH` covers both restate seams. ship.sh's vintage-drift gate auto-runs this on drift. SCOPE: each job's
# pass runs ONLY the named ids — an unrelated id's feed failure (a price-feed hourly cap over the price specs) can
# no longer fail the restate after it wrote, strand the `--stamp`, and abort the release.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() { echo "usage: bash scripts/restate-prod.sh <id,…> [dry]   e.g. bash scripts/restate-prod.sh F9,DB_SMH" >&2; exit 2; }

flag=--confirm-destructive
ids=()
for arg in "$@"; do
  if [ "$arg" = dry ]; then flag=--dry-run; continue; fi
  IFS=',' read -r -a parts <<<"$arg"
  for id in "${parts[@]}"; do
    if [ -n "$id" ]; then ids+=("$id"); fi
  done
done
[ "${#ids[@]}" -gt 0 ] || usage

ind=() det=()
for id in "${ids[@]}"; do
  case "$id" in
    DB_* | RS_*) det+=("$id") ;;
    *) ind+=("$id") ;;
  esac
done

# Loads the feed key (best-effort) in a child bash, then `exec`s the job — the keys never enter this shell.
run_job() {
  # shellcheck disable=SC2016 # "$@" expands in the child bash, not here
  bash -c '. scripts/lib/prod-config.sh && load_prod_config --optional --only FRED_API_KEY && exec "$@"' restate-keys \
    npm run backfill:raw -- "$1" --restate="$2" --env=prod "$flag"
}

join_ids() { local IFS=,; printf '%s' "$*"; }
if [ "${#ind[@]}" -gt 0 ]; then run_job indicators "$(join_ids "${ind[@]}")"; fi
if [ "${#det[@]}" -gt 0 ]; then run_job dbreak "$(join_ids "${det[@]}")"; fi
