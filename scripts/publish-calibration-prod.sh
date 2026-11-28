#!/usr/bin/env bash
#
# publish-calibration-prod.sh — write the COMMITTED calibration vintage
# (scripts/backtest/calibration.json) into the PROD `calibration` table from the laptop.
#
# Before this, prod calibration moved only
# on a manual non-`refresh` `gh workflow run backtest.yml` (workflow deleted 2026-08-15), so a committed harness vintage
# could sit unpublished indefinitely while the code that reads it shipped — cut-points
# silently lagging the release. scripts/ship.sh §5b now calls this on every `make ship`,
# after the prod migrate and BEFORE the deploy (same "dependency first" ordering as the
# schema: the code that reads new params must not go live ahead of them).
#
# Idempotent by CONTENT, not by run or by stamp: publish-calibration.ts publishes only the
# vintages whose params actually differ from prod's collapsed rows (the table is append-only),
# and REFUSES to revert a prod vintage newer than the repo's — it warns instead. `--force`
# publishes regardless. Why content and not `computed_at` → decidePublish's docblock.
#
# ⚠ Guard: the cron's fail-loud path requires the
# `hyoas_evt_level_*` rows to be present in prod — never publish a vintage that drops them.
#
# Creds: the checkout's prod config ($PROD_CONFIG_DIR/.env.prod, scripts/lib/prod-config.sh) — REQUIRED (PROD creds
# live there, never .env.local); a key already set in the environment wins, except an identity key the file contradicts.
#   SUPABASE_URL          (required)
#   SUPABASE_SERVICE_KEY  (required — service_role; the publish writes through the store seam)
#
# $PUBLISH_TREE overrides which checkout supplies calibration.json (never the creds — those come from
# the prod config): ship.sh points it at its §0b `git archive HEAD` copy so the published vintage is the
# COMMIT's, exactly like every other step of that chain. Default = this script's own repo.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PUBLISH_TREE:-$REPO}"

# Prod-writes switch (scripts/lib/prod-writes.sh): refuse before the publish writes
# (before the prod config is loaded: the guard needs nothing from it, and a refused run never loads prod creds).
# shellcheck source=lib/prod-writes.sh
. "$REPO/scripts/lib/prod-writes.sh"
require_prod_writes "the calibration publish" || exit 1

# The prod config is REQUIRED, not best-effort: SUPABASE_URL/SUPABASE_SERVICE_KEY are routinely
# exported in a dev shell pointing at the LOCAL stack, so falling back to the ambient
# environment would let `make ship` write calibration into local Supabase, print
# "wrote N param(s)", and sail on to the prod deploy. A fresh clone is exactly that state.
# First call: `<dir>/.env.prod` must exist and the pair must resolve (else one ::error:: line); an ambient
# SUPABASE_URL the file contradicts refuses. Second: the file's remaining keys, as before (no Vercel link needed).
# shellcheck source=lib/prod-config.sh
. "$REPO/scripts/lib/prod-config.sh"
load_prod_config --only SUPABASE_URL,SUPABASE_SERVICE_KEY || exit 1
load_prod_config --optional || exit 1

: "${SUPABASE_URL:?set SUPABASE_URL (.env.prod) — the PROD project URL}"
: "${SUPABASE_SERVICE_KEY:?set SUPABASE_SERVICE_KEY (.env.prod) — the PROD service_role key}"
case "$SUPABASE_URL" in
  *localhost*|*127.0.0.1*) echo "::error:: SUPABASE_URL=$SUPABASE_URL is a LOCAL stack — .env.prod must hold the prod project URL" >&2; exit 1 ;;
esac
export SUPABASE_URL SUPABASE_SERVICE_KEY

# No --env-file: the prod creds are already exported and node's --env-file does not override
# an already-set variable, so the flag would be inert here — it belongs on the LOCAL publish
# form documented in the runbook, not on this one.
#
# The output assertion is the step's falsifier: publish-calibration.ts prints exactly one
# `[publish-calibration] wrote|skipped|::warning:: stale` line on every path, so a run that
# produced none (entry guard stopped firing, zero params mapped, output swallowed) FAILS here
# instead of reading as a green publish in the ship chain.
# The tree's own tsx bin when installed: `npx` loads npm's install/registry stack (~200 modules, ~350 ms)
# before it ever looks in node_modules/.bin. No install → `npx tsx`.
TSX=("$PWD/node_modules/.bin/tsx")
[ -x "${TSX[0]}" ] || TSX=(npx tsx)
# `|| rc=$?`, never `; rc=$?`: under `set -e` a failing substitution in an assignment exits on the spot, so the
# printf below — the failure's only route into the ship log — would never run.
rc=0
out="$("${TSX[@]}" scripts/backtest/publish-calibration.ts "$@" 2>&1)" || rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || exit "$rc"
printf '%s\n' "$out" | grep -qE '^\[publish-calibration\] (wrote|skipped|::warning:: stale)' || {
  echo "::error:: publish-calibration.ts exited 0 without a wrote/skipped/stale line — the publish did not run" >&2
  exit 1
}
