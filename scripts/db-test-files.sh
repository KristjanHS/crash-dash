#!/usr/bin/env bash
# db-test-files.sh — the ONE source of the DB-truncating test files (every *.test.{ts,js} holding
# `describe.runIf(hasDb)`), repo-relative, one per line, sorted; exit 1 on an empty list (grep rotted).
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mapfile -t FILES < <(grep -rlE '\.runIf\(hasDb\)' --include='*.test.ts' --include='*.test.js' src scripts api public | sort)
[ "${#FILES[@]}" -gt 0 ] || { echo "db-test-files: found no runIf(hasDb) test files — grep rotted; refusing an empty DB phase" >&2; exit 1; }
printf '%s\n' "${FILES[@]}"
