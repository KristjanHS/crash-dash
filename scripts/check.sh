#!/usr/bin/env bash
# `npm run check` — the dev-loop gate and the one `make syncwt` auto-detects.
# Pass stamp, parallel jobs, incremental tsc, ESLint cache.
#
#   1. fix:shape — a FIXER (may rewrite docs/reference.md), so it runs before the tree is keyed.
#   2. Pass stamp: key = the WORKING tree's id (temp index + `git add -A`: dirty and untracked-not-ignored
#      files count) + node version. A hit runs only lint:ruling-ids — it reads the commit range against
#      origin/main, not the tree — and exits 0. Keying the working tree is what lets a check run before
#      a commit count for the committed tree. Outside the key: gitignored inputs (`.env.local`,
#      node_modules). `CHECK_FULL=1` skips the lookup.
#   3. Serial cheap lints (~3 s; they fail before anything heavy starts).
#   4. tsc ∥ ESLint (cached) ∥ vitest ∥ sim:notify (scripts/lib/bg-jobs.sh): first failure kills the rest. T1's
#      alone re-run waits for the join (`T1_DEFER_ALONE`), so the other jobs cannot load it.
#   5. All green and the tree unchanged since step 2 → write the stamp.
# `make ship` and CI run their own full gates and never read this stamp.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
# shellcheck source=lib/bg-jobs.sh
source "$REPO/scripts/lib/bg-jobs.sh"
# shellcheck source=lib/tree-id.sh
source "$REPO/scripts/lib/tree-id.sh"
BIN="$REPO/node_modules/.bin"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/crash-dash"
T0=$EPOCHREALTIME
elapsed() { awk -v a="$T0" -v b="$EPOCHREALTIME" 'BEGIN { printf "%.1f s", b - a }'; }

npm run -s fix:shape

TREE="$(tree_id)"
STAMP=""
[ -n "$TREE" ] && STAMP="$CACHE/check-pass/$TREE-$(node --version)"
if [ -n "$STAMP" ] && [ -z "${CHECK_FULL:-}" ] && [ -e "$STAMP" ]; then
  npm run -s lint:ruling-ids
  printf 'check skipped (stamp %s) — %s\n' "${TREE:0:9}" "$(elapsed)"
  exit 0
fi

npm run -s lint:ruling-ids
npm run -s lint:ladder-reads -- --strict
npm run -s lint:backfill-years

# Per-worktree buildinfo: siblings never thrash one file, and ship keeps its own ship.tsbuildinfo.
# Content-hashed, so a stale file only costs a recheck.
mkdir -p "$CACHE"
WT="$(basename "$REPO")-$(printf '%s' "$REPO" | md5sum | cut -c1-8)"
TSBI="$CACHE/check-$WT.tsbuildinfo"
# ESLint keys its cache on file content + eslint config only, so the name adds the type env (tsconfig, lockfile);
# a cross-file type change is still missed until `make ship` / CI, which run uncached.
ESLC="$CACHE/check-$WT-$(cat tsconfig.json package-lock.json | md5sum | cut -c1-8).eslintcache"
find "$CACHE" -maxdepth 1 -name "check-$WT*.eslintcache" ! -name "${ESLC##*/}" -delete

bg_jobs_init
trap 'bg_jobs_kill; rm -rf "$BGJ_DIR"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bg_job tsc "$BIN/tsc" --noEmit --incremental --tsBuildInfoFile "$TSBI"
bg_job eslint npm run -s lint:ts -- --cache --cache-strategy content --cache-location "$ESLC"
T1_OFFENDERS="$BGJ_DIR/t1-offenders.json"
bg_job vitest env T1_DEFER_ALONE="$T1_OFFENDERS" bash scripts/run-unit-tests.sh --silent
bg_job sim:notify npm run -s sim:notify -- all --quiet
bg_jobs_join
# Green-run surfaces the serial chain printed: one line per sim scenario.
cat "$BGJ_DIR/sim:notify.log"
if [ -e "$T1_OFFENDERS" ]; then "$BIN/tsx" scripts/test-budget-confirm.ts "$T1_OFFENDERS"; fi

if [ -n "$STAMP" ] && [ "$(tree_id)" = "$TREE" ]; then
  mkdir -p "${STAMP%/*}"
  : >"$STAMP.$$" && mv "$STAMP.$$" "$STAMP"
  printf 'check passed — %s (stamped %s)\n' "$(elapsed)" "${TREE:0:9}"
elif [ -n "$STAMP" ]; then
  printf 'check passed — %s (not stamped: the tree changed during the run)\n' "$(elapsed)"
else
  printf 'check passed — %s (not stamped: no git tree)\n' "$(elapsed)"
fi
