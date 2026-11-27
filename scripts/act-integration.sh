#!/usr/bin/env bash
#
# act-integration.sh — run integration.yml's `integration` job LOCALLY via act.
#
# Validates the GitHub Actions job DEFINITION (checkout → setup-node → npm ci → the
# ci-stack.sh integration run) exactly as a registered self-hosted runner would — BEFORE
# any runner is registered. This is the YAML-layer complement to `npm run check:integration`,
# which runs the same vitest suite directly and so never exercises the workflow file itself.
#
# HOW: act's `-self-hosted` platform runs the job's steps DIRECTLY ON THE HOST (no container),
# so `runs-on: [self-hosted, linux]` behaves like the real runner — ci-stack.sh reaches the
# existing crash-dash-ci stack on :55322, no Docker-in-Docker. Host-exec proved robust and
# mirrors production, so the containerized-with-host-socket variant the plan flagged was never
# needed.
#
#   --no-cache-server  disables act's cache backend so setup-node's `cache: npm` post-step
#                      no-ops instead of tar-ing a multi-GB cache on every run.
#
# Prereqs: act + docker on PATH. The crash-dash-ci stack is brought up idempotently by the
# job's own `ci-stack.sh up` step. Extra args pass through to act, e.g.
#   npm run act:integration -- -v      # verbose act output
#
set -euo pipefail

command -v act >/dev/null 2>&1 || {
  echo "act not found on PATH. Install it: https://github.com/nektos/act (e.g. brew install act)" >&2
  exit 127
}
docker version >/dev/null 2>&1 || {
  echo "docker daemon not reachable — the crash-dash-ci stack runs on it (and act touches it to manage the job)." >&2
  exit 1
}

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# workflow_dispatch + target=self-hosted satisfies the job's
#   if: github.event_name == 'push' || inputs.target == 'self-hosted'
exec act workflow_dispatch \
  -W "$REPO/.github/workflows/integration.yml" \
  -j integration \
  --input target=self-hosted \
  -P self-hosted=-self-hosted -P linux=-self-hosted \
  --no-cache-server \
  "$@"
