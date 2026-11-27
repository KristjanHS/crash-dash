#!/usr/bin/env bash
#
# prune-backups-branch.sh — grandfather-father-son retention for a separate backup repo's
# data-only `backups` branch, where every commit is one full DB snapshot
# (supabase/backups/*.sql).
#
# Retained set, by commit age in whole days (USER 2026-09-05: "10 versions — 1-6 days old,
# 1/2/3/4 weeks old"):
#   daily   age < 7 days                          every snapshot (≤ 7; ~5-6 at weekday cadence)
#   weekly  [7,14) [14,21) [21,28) [28,35) days   the OLDEST snapshot in each window
# Everything else is dropped. "Oldest in window" is what makes the ladder roll: the commit a
# daily slot releases at age 7 is the only one left in window 1, sits there until age 14,
# graduates into window 2, … and falls off at 35. Keeping the NEWEST per window would refill
# window 1 every day and starve windows 2-4 forever.
#
# Mechanism: the branch is rewritten as a linear chain of the kept commits, oldest → newest,
# by re-hashing each kept commit object with only its `parent` line changed (tree, author,
# committer, dates, message all byte-identical — so an untouched prefix keeps its SHAs and a
# run that drops nothing is a no-op). The caller pushes with --force-with-lease; a force
# push is inherent to shrinking a git branch, and this branch is data-only by design.
#
# Usage: run INSIDE a checkout that holds the branch (any worktree of the repo):
#   prune-backups-branch.sh [branch=backups]
# Needs the branch history fetched deep enough to see every commit ≤ 35 days old — after the
# first prune that is ≤ 11 commits; callers fetch --depth 60. A commit whose parent lies past
# a shallow boundary is re-rooted (its parent is older than everything kept, so it was going
# to be dropped anyway).
#
# Knobs: PRUNE_NOW=<epoch> pins "now" (tests) · PRUNE_DRY_RUN=1 reports, rewrites nothing.
#
set -euo pipefail
branch="${1:-backups}"
now="${PRUNE_NOW:-$(date +%s)}"
DAY=86400

git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null \
  || { echo "::error:: no local branch '$branch' to prune." >&2; exit 1; }

# Newest first: "%H %ct". The last hash seen per weekly window is that window's oldest.
declare -A oldest_in_window=()
keep_newest_first=()
total=0
while read -r h ct; do
  total=$((total + 1))
  age=$(( (now - ct) / DAY ))
  if [ "$age" -lt 7 ]; then
    keep_newest_first+=("$h")
  elif [ "$age" -lt 35 ]; then
    oldest_in_window[$((age / 7))]="$h"
  fi
done < <(git log --format='%H %ct' "refs/heads/$branch")

for w in 1 2 3 4; do
  [ -n "${oldest_in_window[$w]:-}" ] && keep_newest_first+=("${oldest_in_window[$w]}")
done
kept=${#keep_newest_first[@]}
echo "[prune] $branch: keeping $kept of $total snapshot(s), dropping $((total - kept))" >&2
for h in "${keep_newest_first[@]}"; do
  echo "[prune]   keep $(git log -1 --format='%h %cs' "$h")" >&2
done

if [ "$kept" -eq "$total" ]; then
  echo "[prune] nothing to drop — branch unchanged" >&2
  exit 0
fi
if [ -n "${PRUNE_DRY_RUN:-}" ]; then
  echo "[prune] PRUNE_DRY_RUN — not rewriting" >&2
  exit 0
fi

# Rebuild oldest → newest. A kept commit whose parent IS the previous kept commit is reused
# as-is (identical object); otherwise re-hash it with the parent line swapped.
parent=""
for (( i = kept - 1; i >= 0; i-- )); do
  h="${keep_newest_first[$i]}"
  orig_parent="$(git rev-parse --verify --quiet "$h^" 2>/dev/null || true)"
  if [ -n "$parent" ] && [ "$orig_parent" = "$parent" ]; then
    new="$h"
  else
    # Header = lines before the first blank line: drop every `parent`, insert ours before
    # `author`, and drop any `gpgsig` block (a signature over the old parent is void anyway).
    new="$(git cat-file commit "$h" | awk -v p="$parent" '
      NR == 1 { hdr = 1 }
      hdr && /^$/ { hdr = 0 }
      hdr && sig && /^ / { next }
      hdr { sig = 0 }
      hdr && /^parent / { next }
      hdr && /^gpgsig/ { sig = 1; next }
      hdr && /^author / && p != "" { print "parent " p }
      { print }' | git hash-object -t commit -w --stdin)"
  fi
  parent="$new"
done

old_tip="$(git rev-parse "refs/heads/$branch")"
git update-ref -m "prune: GFS retention" "refs/heads/$branch" "$parent" "$old_tip"
echo "[prune] $branch rewritten: $old_tip → $parent" >&2
