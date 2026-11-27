#!/usr/bin/env bash
#
# apply-waf-rules.sh — apply the WAF rate-limit rule from scripts/waf-rules.json to PROD.
#
# The rule payload lives in the repo (scripts/waf-rules.json — OUR schema, not Vercel's) and this
# script maps it onto the DOCUMENTED `vercel firewall rules add` flags. Never `--json` (that
# payload shape is undocumented and unverifiable without publishing).
#
# ⚠ Hobby budget: 1 rate-limit rule + 3 custom rules per project. EVERY path in waf-rules.json
# MUST therefore be covered by ONE OR-grouped rule (one `{"type":"path","op":"pre"}` condition per
# path, joined by `--or`), never one rule each — a second rate-limit rule exceeds the entitlement.
# The path set is read from the JSON (jq, below), so adding a path needs no edit here.
#
# Modes:
#   (no flag)          stage the draft (`rules add`) + `vercel firewall diff` + STOP. Prints what
#                      publishing would do. This is the manual operator flow.
#   --confirm-publish  stage + diff + `vercel firewall publish` (LIVE prod change — USER-GATED).
#   --check            READ-ONLY. `rules list` and assert our rule is already live AND that its
#                      live path set EQUALS waf-rules.json's `.paths`; exit non-zero otherwise.
#                      Exit codes: 0 live+matching · 1 absent or draft-only (publish it) ·
#                      2 could NOT tell (login/link/CLI/schema) · 3 PATH DRIFT (publishing does
#                      NOT fix it). 1 and 3 must stay distinct — they have opposite remedies.
#                      This is what `make ship` runs — it never stages a draft unattended (repeated
#                      `rules add` would pile up drafts and hit the Hobby cap).
#                      ⚠ Scope, ruled 2026-08-20: the path set is compared, `requests` /
#                      `windowSeconds` / `keys` / `rateLimitAction` are NOT. A threshold hand-edited
#                      in the Vercel UI still passes --check. That is an ACCEPTED gap, not an
#                      oversight — widening it is a separate decision.
#                      Why the path half exists: on 2026-08-20 the live rule carried 2 of the JSON's
#                      3 paths (the bulk time-series download — the redistribution surface — was
#                      missing) and a name-only check returned exit 0, so the gate was structurally
#                      incapable of failing on the exact drift the rule exists to prevent.
#                      No literal path may appear in this file: the JSON is the single touch point,
#                      and api/security-waf.test.ts reds on a hardcoded one.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

RULES_JSON="$REPO/scripts/waf-rules.json"
[ -f "$RULES_JSON" ] || { echo "::error:: $RULES_JSON not found"; exit 1; }

command -v jq >/dev/null 2>&1 || { echo "::error:: jq is required"; exit 1; }

MODE="stage"
case "${1:-}" in
  --confirm-publish) MODE="publish" ;;
  --check)           MODE="check" ;;
  "")                MODE="stage" ;;
  *) echo "::error:: unknown flag '$1' (use --confirm-publish or --check)"; exit 1 ;;
esac

# Prod-writes switch (scripts/lib/prod-writes.sh): stage/publish write the project's firewall — refuse first.
# `--check` is read-only and stays unguarded.
if [ "$MODE" != "check" ]; then
  # shellcheck source=lib/prod-writes.sh
  . "$REPO/scripts/lib/prod-writes.sh"
  require_prod_writes "the firewall write" || exit 1
fi

# `jq -r` prints the string "null" and exits 0 on a missing key — `-e` makes a typo loud.
jqx() { jq -re "$1" "$RULES_JSON" || { echo "::error:: $RULES_JSON: missing/!null $1" >&2; exit 1; }; }
NAME="$(jqx '.name')"
WINDOW="$(jqx '.windowSeconds')"
REQUESTS="$(jqx '.requests')"
RL_ACTION="$(jqx '.rateLimitAction')"

# The Vercel link comes from the prod config (VERCEL_ORG_ID / VERCEL_PROJECT_ID off `<dir>/.vercel/project.json`),
# never the cwd: the checkout holds no `.vercel/`, so an unlinked CLI failed every `--check` as "could NOT tell" and
# wedged each unattended `make ship` at the WAF join. A missing config is likewise "could NOT tell" (2), never
# "absent" (1) — ship.sh maps 1 to "publish it".
# shellcheck source=lib/prod-config.sh
. "$REPO/scripts/lib/prod-config.sh"
if ! load_prod_config --only VERCEL_ORG_ID,VERCEL_PROJECT_ID; then
  [ "$MODE" = "check" ] && exit 2
  exit 1
fi

vercel() { npx --yes vercel "$@"; }

if [ "$MODE" = "check" ]; then
  echo "▶ Check: is WAF rule '$NAME' live on prod?"
  # exit 0 = live · exit 1 = absent or draft-only · exit 2 = could NOT tell.
  # Never collapse 2 into 1 — that aborts a release for the wrong reason.
  # stdout ONLY — the CLI writes progress chatter ("Retrieving project…") to stderr, and folding
  # it in with 2>&1 makes the payload unparseable, which read as "rule absent" (a false exit 1).
  err="$(mktemp)"; trap 'rm -f "$err"' EXIT
  if ! live="$(vercel firewall rules list --json --non-interactive 2>"$err")"; then
    echo "::error:: could NOT determine WAF rule state (not linked, not logged in, or CLI error)." >&2
    tail -20 "$err" >&2
    exit 2
  fi
  # A non-JSON payload is an UNKNOWN state (exit 2), never "absent" (exit 1).
  if ! printf '%s' "$live" | jq -e . >/dev/null 2>&1; then
    echo "::error:: WAF rule state could NOT be parsed — \`firewall rules list --json\` did not return JSON." >&2
    printf '%s\n' "$live" | tail -20 >&2
    exit 2
  fi
  if ! printf '%s' "$live" | jq -e --arg n "$NAME" 'first(.. | objects | select(.name? == $n))' >/dev/null 2>&1; then
    echo "::error:: WAF rule '$NAME' is NOT present — run \`bash scripts/apply-waf-rules.sh --confirm-publish\` to publish it." >&2
    exit 1
  fi
  # Path-set equality. A rule of the right NAME can still have drifted to a smaller condition
  # group, leaving a listed path entirely unprotected while the name assertion above passes.
  want_paths="$(jq -rc '[.paths[]] | sort' "$RULES_JSON")"
  live_paths="$(printf '%s' "$live" | jq -rc --arg n "$NAME" \
    '[first(.. | objects | select(.name? == $n)) | .conditionGroup[]?.conditions[]?
      | select(.type? == "path") | .value] | sort')"
  # An EMPTY extraction is ambiguous (schema moved vs. genuinely no conditions) -> UNKNOWN, not
  # "absent": exit 2, never 1. Same doctrine as the unparseable-payload branch above.
  if [ "$live_paths" = "[]" ] || [ -z "$live_paths" ]; then
    echo "::error:: could NOT read any path condition off live rule '$NAME' — \`firewall rules list --json\` schema may have changed." >&2
    exit 2
  fi
  if [ "$live_paths" != "$want_paths" ]; then
    echo "::error:: WAF rule '$NAME' path set has DRIFTED from $RULES_JSON." >&2
    echo "::error::   want (waf-rules.json): $want_paths" >&2
    echo "::error::   live (prod):           $live_paths" >&2
    # ⛔ 2026-08-20: on Hobby, --confirm-publish CANNOT fix this. `vercel firewall rules add`
    # returns {"status":"error","message":"Rate limiting is not available for this plan (401)"} —
    # the live rule survives from an earlier entitlement and cannot be re-created or widened. Do
    # NOT send the operator to a command that 401s; the resolution is a plan/design decision.
    echo "::error:: \`--confirm-publish\` will NOT fix this on the Hobby plan: \`firewall rules add\` returns 401 'Rate limiting is not available for this plan'." >&2
    echo "::error:: The live rule predates that entitlement and cannot be widened. Resolve the coverage gap by decision (drop the path from the JSON, cap it in-handler, or upgrade the plan)." >&2
    # exit 3, NOT 1. Callers map 1 to "absent -> publish it", and publishing is exactly the wrong
    # remedy here (it 401s on Hobby). A drift needs its own code or the wrapper contradicts the
    # ::error:: lines above. ship.sh has a matching `3)` arm.
    exit 3
  fi

  # `rules list` includes UNPUBLISHED DRAFTS, so presence alone is not "live".
  if ! draft="$(vercel firewall diff --non-interactive 2>&1)"; then
    echo "::error:: could NOT read the firewall draft diff." >&2
    exit 2
  fi
  if printf '%s' "$draft" | grep -qF "$NAME"; then
    echo "::error:: WAF rule '$NAME' exists only as an UNPUBLISHED DRAFT — publish it with \`bash scripts/apply-waf-rules.sh --confirm-publish\`." >&2
    printf '%s\n' "$draft" | tail -20 >&2
    exit 1
  fi
  echo "✓ WAF rule '$NAME' is live (present, no pending draft, paths $live_paths)."
  exit 0
fi

# Build the flag vector from the JSON — one --condition per path, joined by --or, and one
# --rate-limit-keys per key.
add_args=("$NAME" --action rate_limit
  --rate-limit-window "$WINDOW"
  --rate-limit-requests "$REQUESTS"
  --rate-limit-action "$RL_ACTION")

keys_raw="$(jqx '.keys[]')"
while IFS= read -r key; do
  add_args+=(--rate-limit-keys "$key")
done <<<"$keys_raw"

paths_raw="$(jqx '.paths[]')"
first=1
while IFS= read -r path; do
  [ "$first" -eq 1 ] || add_args+=(--or)
  first=0
  add_args+=(--condition "{\"type\":\"path\",\"op\":\"pre\",\"value\":\"$path\"}")
done <<<"$paths_raw"

add_args+=(--yes)

echo "▶ Stage draft rule '$NAME' (${REQUESTS} req / ${WINDOW}s, action=$RL_ACTION, keys=$(jq -rc '.keys' "$RULES_JSON"))"
echo "  vercel firewall rules add ${add_args[*]}"
vercel firewall rules add "${add_args[@]}"

echo "▶ Draft diff (not yet live):"
vercel firewall diff

if [ "$MODE" = "publish" ]; then
  echo "▶ Publishing draft to prod (LIVE change)…"
  vercel firewall publish
  echo "✓ Published. The rate-limit rule is now live."
else
  echo
  echo "⏸ STAGED ONLY — nothing is live yet. Publishing would run: vercel firewall publish"
  echo "   Re-run with --confirm-publish to make it live (USER-GATED)."
fi
