#!/usr/bin/env bash
#
# migrate-prod-local.sh — apply supabase/migrations/** to PROD from the laptop.
#
# The local mirror of an optional operator-side break-glass migrate job's apply path: link → destructive
# BODY gate (with the same db-push cross-check that closes the empty-reviewed-set hole) →
# `db push --include-all --yes` → drift verify. Invoked by `make ship-all-local`.
#
# ⚠ No dry-run preview runs here, so preview a DESTRUCTIVE/non-additive migration with
# `supabase db push --dry-run` first — this
# local path is for additive/backward-compatible migrations you're confident in. The
# destructive-body gate below still fires and will refuse an unreviewed destructive body.
#
# Creds: the checkout's prod config ($PROD_CONFIG_DIR/.env.prod) if present (PROD creds live there, never .env.local),
# else the environment; a key already set in the environment wins.
#   SUPABASE_PROJECT_REF   (required; non-secret — your project ref)
#   SUPABASE_DB_PASSWORD   (required; Supabase → Project Settings → Database)
#   SUPABASE_ACCESS_TOKEN  (OPTIONAL — if unset, falls back to a prior `supabase login`)
#
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# Human-facing view of the migration-list table: header (2 lines) + the 5 newest rows only —
# the full list runs dozens long. Parsing below always consumes the full "$out"; ONLY this echo
# is trimmed. Rows start at line 3 (NR>2), matching every awk gate in this script.
show_migration_list() { printf '%s\n' "$1" | head -2; printf '%s\n' "$1" | tail -n +3 | tail -5; }

# Prod-writes switch (scripts/lib/prod-writes.sh): refuse before link/push
# (before the prod config is loaded: the guard needs nothing from it, and a refused run never loads prod creds).
# shellcheck source=lib/prod-writes.sh
. "$REPO/scripts/lib/prod-writes.sh"
require_prod_writes "the schema migration" || exit 1

# The checkout's prod config (scripts/lib/prod-config.sh), best-effort: a non-empty env key wins, except an identity
# key the file contradicts → refuse; no `<dir>/.env.prod` → the environment alone.
# shellcheck source=lib/prod-config.sh
. "$REPO/scripts/lib/prod-config.sh"
load_prod_config --optional || exit 1

: "${SUPABASE_PROJECT_REF:?set SUPABASE_PROJECT_REF (repo var / .env.prod)}"
: "${SUPABASE_DB_PASSWORD:?set SUPABASE_DB_PASSWORD (Supabase → Project Settings → Database)}"
export SUPABASE_DB_PASSWORD

# Management-API call: retry ONLY a transient Cloudflare/API 5xx; any other failure is final. Knobs: SUPABASE_API_ATTEMPTS (3), SUPABASE_API_BACKOFF (s, 60).
supabase_api() {
  local n=1 out rc
  while :; do
    out="$("$@" 2>&1)" && rc=0 || rc=$?
    printf '%s\n' "$out"
    [ "$rc" -ne 0 ] && [ "$n" -lt "${SUPABASE_API_ATTEMPTS:-3}" ] \
      && grep -qE '"retryable":true|Error 5(0[234]|2[0-4])|"status":5(0[234]|2[0-4])|status 5(0[234]|2[0-4]):' <<<"$out" || return "$rc"
    echo "::warning:: Supabase API transient 5xx (attempt $n) — retrying in ${SUPABASE_API_BACKOFF:-60}s" >&2
    sleep "${SUPABASE_API_BACKOFF:-60}"; n=$((n + 1))
  done
}

# Auth: prefer SUPABASE_ACCESS_TOKEN (non-interactive) if provided; otherwise fall back to a
# prior `supabase login` (the CLI's stored token). Probe auth here so we fail early with a
# clear message rather than deep inside `db push`.
if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  export SUPABASE_ACCESS_TOKEN
elif supabase_api npx --yes supabase projects list >/dev/null; then
  echo "▶ Using stored \`supabase login\` credentials (SUPABASE_ACCESS_TOKEN not set)"
else
  echo "::error:: not authenticated to Supabase (or its API is down — see any 5xx retry warnings above) — run \`supabase login\` once, or set SUPABASE_ACCESS_TOKEN (sbp_… from Supabase → Account → Access Tokens)." >&2
  exit 1
fi

echo "▶ Link prod project ($SUPABASE_PROJECT_REF)"
supabase_api npx --yes supabase link --project-ref "$SUPABASE_PROJECT_REF" --password "$SUPABASE_DB_PASSWORD"

# ⚠ `--output-format text` is NOT redundant with the documented default. Since CLI 2.109.x the
# `--agent auto` default sniffs AI_AGENT/CLAUDECODE and silently emits JSON instead of the
# `Local | Remote | Time` table every awk below parses. Under an agent-run `make ship` that made
# the line-72 post-apply drift check pass VACUOUSLY (no row ever matches `NR>2` ⇒ `d` unset ⇒
# "✓ prod schema now matches" without verifying). Pin the format; never drop these flags.
echo "▶ Destructive-body gate (pending migrations with a destructive body need a review sentinel)"
out="$(npx --yes supabase migration list --linked --output-format text)"; show_migration_list "$out"
# Strip every non-digit, not just whitespace: CLI 2.109.x wraps each table cell in backticks
# (`20260719120000`), which a whitespace-only gsub leaves in place — the version then fails the
# line-50 glob as "0 files — cannot review" rather than reviewing anything.
# Anchor on a full 14-digit version, never "contains a digit". Defence-in-depth: the CLI's
# upgrade banner ("v2.109.1 … currently installed v2.108.0") is a `|`-free line with an empty
# $2 that the old test would admit as a phantom version (2109121080) — but the banner goes to
# STDERR and this capture takes stdout only, so it never reached the awk (verified 2026-07-19).
# The anchor is what keeps that true if anyone adds a `2>&1` here.
pending="$(echo "$out" | awk -F'|' 'NR>2 && $2 !~ /[0-9]/ {gsub(/[^0-9]/,"",$1); if ($1 ~ /^[0-9]{14}$/) print $1}')"
files=()
for v in $pending; do
  match=(supabase/migrations/"${v}"_*.sql)
  { [ -f "${match[0]}" ] && [ "${#match[@]}" -eq 1 ]; } || { echo "::error:: pending $v has ${#match[@]} files — cannot review"; exit 1; }
  files+=("${match[0]}")
done
# Cross-check the parsed pending-set against what db push will actually apply — an empty
# reviewed-set with a non-empty apply-set is the specific hole this closes.
dry="$(npx --yes supabase db push --dry-run --include-all --output-format text --password "$SUPABASE_DB_PASSWORD" 2>&1)" \
  || { echo "$dry"; echo "::error:: db push --dry-run failed — see output above"; exit 1; }
echo "$dry"
dry_versions="$(echo "$dry" | grep -oE '[0-9]{14}_[^[:space:]]*\.sql' | grep -oE '^[0-9]{14}' | sort -u || true)"
gate_versions="$(printf '%s\n' ${pending:-} | sed '/^$/d' | sort -u)"
[ "$dry_versions" = "$gate_versions" ] || { echo "::error:: gate DIVERGED from db push apply-set — refusing"; exit 1; }
if [ -z "$gate_versions" ]; then
  # Stage 7 (vintage drift): tell ship.sh's detector nothing was applied. An EMPTY manifest
  # means "no decree headers to honour"; a MISSING one makes the probe WARN instead — so the
  # zero-pending path writes the empty file rather than skipping the hand-off. Unset (a bare
  # break-glass run) ⇒ no-op.
  if [ -n "${SHIP_APPLIED_MIGRATIONS:-}" ]; then : > "$SHIP_APPLIED_MIGRATIONS"; fi
  echo "✓ nothing pending — prod already up to date"; exit 0
fi
# The checkout's own tsx bin when installed: `npx` loads npm's install/registry stack (~200 modules, ~350 ms)
# before it ever looks in node_modules/.bin. No install → `npx tsx`.
TSX=("$REPO/node_modules/.bin/tsx")
[ -x "${TSX[0]}" ] || TSX=(npx tsx)
"${TSX[@]}" scripts/check-destructive-migrations.ts "${files[@]}"

echo "▶ Apply pending migrations to prod"
npx --yes supabase db push --include-all --yes --password "$SUPABASE_DB_PASSWORD"

# Stage 7 (vintage drift): record the just-applied migration files (repo-relative, one per
# line — the same $files the destructive-body gate reviewed and the dry-run cross-checked)
# so ship.sh's probe:vintage-drift can honour their `-- restate: <id,…>` decree headers.
# Unset ⇒ no-op: a bare break-glass run has no detector step to feed.
if [ -n "${SHIP_APPLIED_MIGRATIONS:-}" ]; then
  printf '%s\n' "${files[@]}" > "$SHIP_APPLIED_MIGRATIONS"
fi

echo "▶ Verify zero drift remains"
out="$(npx --yes supabase migration list --linked --output-format text)"; show_migration_list "$out"
if echo "$out" | awk -F'|' 'NR>2 && $2 !~ /[0-9]/ {v=$1; gsub(/[^0-9]/,"",v); if (v ~ /^[0-9]{14}$/) d=1} END{exit !d}'; then
  echo "::error:: a local migration is still unapplied after db push — investigate"; exit 1
fi
echo "✓ prod schema now matches supabase/migrations/"
