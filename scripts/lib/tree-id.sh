# shellcheck shell=bash
# tree_id — print the WORKING tree's git tree id (dirty + untracked-not-ignored files count). When git cannot
# (no checkout, an unreadable file) it prints nothing, warns on stderr and returns 0, so a caller runs unstamped.
tree_id() {
  local idx rc=0 id=""
  idx="$(mktemp)"
  # Seed from the real index (`-p` keeps its mtime, so git's racy-clean check still holds) — only stat-changed
  # files re-hash. No index to seed → let git build a fresh one.
  cp -p "$(git rev-parse --git-path index 2>/dev/null)" "$idx" 2>/dev/null || rm -f "$idx"
  id="$(GIT_INDEX_FILE="$idx" git add -A 2>/dev/null && GIT_INDEX_FILE="$idx" git write-tree 2>/dev/null)" || rc=$?
  rm -f "$idx"
  if [ "$rc" -eq 0 ]; then printf '%s' "$id"; else echo "check: tree id unavailable — running unstamped" >&2; fi
}
