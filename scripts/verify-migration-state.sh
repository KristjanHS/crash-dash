#!/usr/bin/env bash
# verify-migration-state.sh — reconcile local migrations vs prod (Supabase --linked).
#
# Prints the highest local migration timestamp vs the highest remote-APPLIED one and
# exits non-zero on drift. This is the mechanical form of impag's "reconcile every live
# migration claim on resume" step, and doubles as the runbook's read-only prod check.
#
# Authoritative source is `supabase migration list --linked` (see .claude/rules/migrations.md) — NOT
# `db diff --linked`, which misleads for this purpose. Prod applies migrations LOCALLY via `make ship`
# (auto-apply-on-merge removed 2026-07-19; break-glass is an optional operator-side dispatch), so drift
# here means "local is ahead, pending a `make ship`" — merging or pushing will NOT clear it.
#
# Guard: if the linked project can't be reached (offline / not linked / not logged in),
# prints RECONCILE-SKIPPED and exits 0 — it never blocks on missing network.
#
# ⚠ This script does NOT validate credentials. `supabase migration list --linked` uses creds
# cached at `link` time and returns exit 0 even with a garbage --password, so a green run here
# says nothing about whether SUPABASE_DB_PASSWORD is correct. For that, run `npm run probe:dbauth`
# (a direct pg connect — the only real falsifier).
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mig_dir="$repo_root/supabase/migrations"

# Highest local migration timestamp (14-digit prefix of *.sql filenames).
highest_local="$(ls -1 "$mig_dir"/*.sql 2>/dev/null \
  | sed -E 's#.*/([0-9]{14})_.*#\1#' \
  | grep -E '^[0-9]{14}$' \
  | sort | tail -1)"

if [[ -z "$highest_local" ]]; then
  echo "RECONCILE-SKIPPED (no local migrations found under $mig_dir)"
  exit 0
fi

# Query prod. --linked needs network + auth; capture both stdout+stderr so a failure
# (unreachable / not logged in) falls through to the skip guard rather than aborting.
# ⚠ `--output-format text` is NOT redundant with the documented default: since CLI 2.109.x the
# `--agent auto` default sniffs AI_AGENT/CLAUDECODE and emits JSON, which the awk below cannot
# parse (remote reads empty ⇒ false DRIFT). Pin the format so the output is invocator-invariant.
list_out="$(npx supabase migration list --linked --output-format text 2>&1)"
list_rc=$?

if [[ $list_rc -ne 0 ]] || ! grep -qE '[0-9]{14}' <<<"$list_out"; then
  echo "RECONCILE-SKIPPED (not linked / unreachable)"
  echo "  local highest: $highest_local"
  exit 0
fi

# Highest REMOTE-applied timestamp, read from the "Local | Remote | Time (UTC)" table.
# Header-anchored: locate the Remote column index from the header row rather than hard-coding
# $2, so a supabase CLI format bump (e.g. bordered `| Local | Remote |` rows, which would shift
# every field by one) can't silently mask drift as IN SYNC. If the header is never matched,
# remote stays empty → the != check below reports drift (a visible failure, never a false sync).
# gsub strips padding; the separator rule and local-only rows (empty Remote cell) filter out.
highest_remote="$(awk -F'|' '
  col==0 { for (i=1;i<=NF;i++){ t=$i; gsub(/^[ \t]+|[ \t]+$/,"",t); if (t=="Remote"){ col=i } } next }
  { v=$col; gsub(/[^0-9]/,"",v); if (v ~ /^[0-9]{14}$/) print v }
' <<<"$list_out" | sort | tail -1)"

echo "  local highest:  ${highest_local}"
echo "  remote highest: ${highest_remote:-<none applied>}"

# Tip-only comparison:
# highest-local vs highest-remote. This catches the "local ahead, pending merge" case it exists for; it does NOT assert full set-equality, so
# an interior migration applied on only one side while the tips match still reads as IN SYNC.
if [[ "$highest_local" != "$highest_remote" ]]; then
  echo "DRIFT: local and remote highest migration differ"
  if [[ -z "$highest_remote" || "$highest_local" > "$highest_remote" ]]; then
    echo "  → local is AHEAD of prod (migration(s) pending merge to main / CI apply)"
  else
    echo "  → prod is AHEAD of local (pull/rebase migrations before writing new ones)"
  fi
  exit 1
fi

echo "IN SYNC (prod current through $highest_local)"
exit 0
