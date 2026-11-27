#!/usr/bin/env bash
# Link the primary checkout's gitignored dev env file into a worktree.
#
# Git worktrees do not share untracked files, so .env.local lives ONLY in the main
# checkout. The 25 `--env-file-if-exists=.env.local` npm scripts then silently find
# nothing in a worktree and abort with "no store reachable" — stalling any store-backed
# work (probes, backfills, e2e).
#
# This symlinks it in so path-relative env resolution just works. `.env.*` is
# gitignored, so the link never shows in `git status` or gets committed. Idempotent;
# a no-op when run from the primary checkout. The prod config (.env.prod + the
# .vercel/ link) is deliberately NOT linked: the prod scripts resolve it at the main
# worktree root or at an explicit PROD_CONFIG_DIR (scripts/lib/prod-config.sh).
# `.prod-writes` needs no link either: the switch is resolved at the main worktree
# root (src/prod-writes.ts), so every worktree obeys the primary's. Run once after
# `git worktree add`:
#     npm run wt:link-env
set -euo pipefail

primary="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
here="$(git rev-parse --show-toplevel)"

if [ "$primary" = "$here" ]; then
  echo "in the primary checkout ($here) — nothing to link"
  exit 0
fi

f=.env.local
if [ -L "$here/$f" ]; then
  echo "$f already linked -> $(readlink "$here/$f")"
elif [ -e "$here/$f" ]; then
  echo "$f exists (not a symlink) — left as-is"
elif [ -e "$primary/$f" ]; then
  ln -s "$primary/$f" "$here/$f"
  echo "linked $f -> $primary/$f"
else
  echo "primary has no $f — skipped"
fi
