#!/usr/bin/env bash
# Unit suite — ONE `vitest run` over the `shared` / `isolated` projects declared in
# vitest.config.ts (`test.projects`). Vitest 4 honours per-project `isolate`/`pool`
# (measured 2026-08-08: `--project=shared` alone 4.6s, the same run with `--isolate` 10.2s),
# so the partition lives entirely in the config; this wrapper only forwards args.
# History (two sequential passes, why the split exists, Vitest 2 CLI-only isolate) → git log.
set -euo pipefail

npx vitest run "$@"
