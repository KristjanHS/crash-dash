#!/usr/bin/env bash
#
# run-integration-tests.sh — the implementation-end "integration-green" gate.
#
# Brings up the isolated crash-dash-ci Supabase stack, arms the integration half of vitest
# against it (SUPABASE_URL/SERVICE_KEY + DB_TESTS=1), runs the full suite, then always takes
# the stack back down. Satisfy this BEFORE pushing changes to src/store* or
# supabase/migrations/** — the pre-push hook runs this same suite and BLOCKS the push if it
# isn't green, so this is where integration errors get FIXED rather than discovered.
# Invoked as `npm run check:integration`.
#
# Stack lifecycle is db.sh's `with ci`: DOWN is the default posture, so this starts the CI
# stack if it isn't already up and ALWAYS stops it on the way out (including on Ctrl-C or a
# red suite) — a stack you opened yourself via `scripts/db.sh up ci` is torn down too.
#
# Passes any extra args straight to vitest (e.g. `npm run check:integration -- store.contract.test.ts`)
# — an args run is a single serial vitest invocation, exactly as before.
#
# The no-args gate runs in TWO phases under ONE stack lifecycle (2026-07-24 speedup):
#   1. the DB-truncating files (every *.test.ts containing `describe.runIf(hasDb)`) — serial,
#      because they share one Supabase and the store suites' truncate() races concurrent DB tests;
#   2. everything else with INTEG_EXCLUDE listing the phase-1 files — vitest.config.ts then
#      excludes them and re-enables file parallelism (nothing left touches the DB).
# Phases 1+2 partition the full suite, so the gate still covers everything; the DB-file list
# comes from scripts/db-test-files.sh (shared with ship.sh §2) fresh each run, so a NEW
# runIf(hasDb) file lands in phase 1 automatically rather than racing in phase 2.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Release lock (scripts/lib/release-lock.sh) — crash-dash-ci is ONE shared stack, and this run truncates it and
# tears it down, so a concurrent ship.sh (either mode), smoke-cron.sh or another run of this script from any
# checkout makes this one refuse before the stack is touched. Run as a child of a holder (fd 8 +
# CRASH_DASH_RELEASE_LOCK_HELD inherited), it inherits the lock instead of refusing.
# shellcheck source=lib/release-lock.sh
. "$REPO/scripts/lib/release-lock.sh"
release_lock_acquire "the integration suite" || exit 1

# `with ci` seeds the marker, arms SUPABASE_URL/SUPABASE_SERVICE_KEY/DB_TESTS (asserting
# DB_TESTS=1, so this can never silently degrade to a unit-only pass), and owns teardown.
# vitest's exit status propagates back out through db.sh, so a red suite still fails the gate.
# INTEG_EXCLUDE is explicitly CLEARED on every path that runs DB tests: vitest.config.ts
# honors it unconditionally, so a stale exported value would silently exclude DB files from
# a serial run (green-as-unit-only) or re-enable parallelism under them (the truncate race).
if [ "$#" -gt 0 ]; then
  "$REPO/scripts/db.sh" with ci -- env INTEG_EXCLUDE= npx vitest run "$@"
else
  mapfile -t DB_FILES < <(bash "$REPO/scripts/db-test-files.sh")
  [ "${#DB_FILES[@]}" -gt 0 ] || { echo "run-integration-tests: db-test-files.sh returned nothing — refusing to run without the DB phase" >&2; exit 1; }
  EXCLUDE="$(IFS=,; echo "${DB_FILES[*]}")"
  "$REPO/scripts/db.sh" with ci -- bash -c \
    "INTEG_EXCLUDE= npx vitest run ${DB_FILES[*]} && INTEG_EXCLUDE='$EXCLUDE' npx vitest run"
fi
