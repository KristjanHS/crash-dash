# shellcheck shell=bash
# Prod-writes switch — one gitignored file, `.prod-writes`, at the MAIN worktree root says whether this checkout may
# write to its deploy target (rows, schema, roles, cron runs, deploys, pushes). Reads never consult it.
#   `on` → pass · `off` → refuse · missing → pass (fresh clone) · any other content / unreadable → refuse.
#   Env PROD_WRITES=on|off wins over the file for one command; an empty/blank value counts as unset.
#   PROD_WRITES=<non-blank> in an env file → refuse, whatever the value: a writer that loads .env.prod / .env.local
#   into its env (`tsx --env-file=.env.local`, a hand-run `set -a` source) would otherwise turn a one-command override into a
#   permanent one. Checked in .env.prod + .env.local at the switch's directory, at this checkout (a linked
#   worktree's own) AND at an absolute PROD_CONFIG_DIR (the checkout's prod config; a relative value refuses);
#   only that one key is read, a `#` comment line never counts, an `export ` prefix and quotes
#   are allowed, an unreadable file refuses.
#   Values are trimmed of ASCII whitespace only (LC_ALL=C [:space:] — CRLF passes, a BOM or NBSP refuses) and
#   compared case-insensitively.
# Where the file lives — resolved from THIS helper's checkout (computed once, at source time), never from cwd:
#   <checkout>/.git absent  → <checkout>/.prod-writes (a tree with no git metadata)
#   <checkout>/.git present → <parent of `git rev-parse --git-common-dir`>/.prod-writes, i.e. the main worktree root,
#                             so every linked worktree obeys the primary's switch; `git` failing here refuses.
#
# TS twin: src/prod-writes.ts (`requireProdWrites`) — same file, same parse, same rule; change both together
# (src/prod-writes.test.ts runs both over one table).

# <checkout> — this file lives at <checkout>/scripts/lib/. Empty when it cannot be resolved (→ refuse at call time).
_PROD_WRITES_CHECKOUT="$(CDPATH='' cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd -P)" ||
  _PROD_WRITES_CHECKOUT=""

# prod_writes_file — prints the switch file's path (rule above); returns 1 when it cannot be resolved.
prod_writes_file() {
  local dir="$_PROD_WRITES_CHECKOUT" common
  [ -n "$dir" ] || return 1
  if [ ! -e "$dir/.git" ]; then
    printf '%s\n' "$dir/.prod-writes"
    return 0
  fi
  # Unset inherited repo-pointing vars (set inside git hooks) so the answer is about THIS checkout.
  common="$(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR \
    git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
  [ -n "$common" ] || return 1
  printf '%s\n' "$(dirname -- "$common")/.prod-writes"
}

# _prod_writes_env_file_sets <file> — 0 when <file> holds a `PROD_WRITES=<non-blank>` line (blank = empty, `""`/`''`,
# or only a `#` comment), 1 when it does not, 2 when it cannot be read. Never prints a line of the file.
_prod_writes_env_file_sets() {
  local LC_ALL=C line v
  { [ ! -d "$1" ] && [ -r "$1" ]; } || return 2
  while IFS= read -r line || [ -n "$line" ]; do
    [[ $line =~ ^[[:space:]]*(export[[:space:]]+)?PROD_WRITES[[:space:]]*=(.*)$ ]] || continue
    v="${BASH_REMATCH[2]}"
    v="${v#"${v%%[![:space:]]*}"}"
    v="${v%"${v##*[![:space:]]}"}"
    case "$v" in '#'*) continue ;; esac
    if [[ $v =~ ^\"(.*)\"$ ]] || [[ $v =~ ^\'(.*)\'$ ]]; then
      v="${BASH_REMATCH[1]}"
      v="${v#"${v%%[![:space:]]*}"}"
      v="${v%"${v##*[![:space:]]}"}"
    fi
    [ -n "$v" ] && return 0
  done <"$1"
  return 1
}

# require_prod_writes <what> — returns 0 when prod writes are on (or unguarded); otherwise ONE `::error::` line on
# stderr and returns 1. Callers: `require_prod_writes "<what>" || exit 1`, BEFORE the first write.
require_prod_writes() {
  local LC_ALL=C # ASCII [:space:] and case folding, matching the TS twin
  local what="${1:-a prod write}" val src file="" cfg="${PROD_CONFIG_DIR:-}" seen="" d name env_file rc
  # The checkout's prod config dir (scripts/lib/prod-config.sh) is the third place a loader reads env files from.
  if [ -n "$cfg" ]; then
    if [ "${cfg#/}" = "$cfg" ]; then
      echo "::error:: refusing $what — PROD_CONFIG_DIR must be an absolute path — got '$cfg'" >&2
      return 1
    fi
    while [ "$cfg" != / ] && [ "${cfg%/}" != "$cfg" ]; do cfg="${cfg%/}"; done
  fi
  # The env-file check runs first and whatever the env says: it is what makes the env override trustworthy.
  file="$(prod_writes_file)" || file=""
  for d in ${file:+"$(dirname -- "$file")"} ${_PROD_WRITES_CHECKOUT:+"$_PROD_WRITES_CHECKOUT"} ${cfg:+"$cfg"}; do
    case "$seen" in *"|$d|"*) continue ;; esac
    seen="$seen|$d|"
    for name in .env.prod .env.local; do
      env_file="$d/$name"
      [ -e "$env_file" ] || continue
      rc=0
      _prod_writes_env_file_sets "$env_file" || rc=$?
      if [ "$rc" = 2 ]; then
        echo "::error:: refusing $what — cannot read $env_file to check it for PROD_WRITES" >&2
        return 1
      fi
      if [ "$rc" = 0 ]; then
        echo "::error:: refusing $what — PROD_WRITES must not be set in an env file ($env_file) — remove it" >&2
        return 1
      fi
    done
  done
  val="${PROD_WRITES:-}"
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  if [ -n "$val" ]; then
    src="env PROD_WRITES"
  else
    if [ -z "$file" ]; then
      echo "::error:: refusing $what — cannot locate the .prod-writes switch for ${_PROD_WRITES_CHECKOUT:-this checkout}; re-run with PROD_WRITES=on to override" >&2
      return 1
    fi
    [ -e "$file" ] || return 0
    if [ -d "$file" ] || ! val="$(cat -- "$file" 2>/dev/null)"; then
      echo "::error:: refusing $what — cannot read $file; re-run with PROD_WRITES=on to override" >&2
      return 1
    fi
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    src="$file"
  fi
  [ "${val,,}" = on ] && return 0
  echo "::error:: refusing $what — prod writes are not on ($src); re-run with PROD_WRITES=on to override" >&2
  return 1
}
