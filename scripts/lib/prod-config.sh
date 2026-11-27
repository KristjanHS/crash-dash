# shellcheck shell=bash
# The checkout's prod config — the directory holding `.env.prod` (the deploy target's keys) and `.vercel/project.json`
# (its Vercel link). Every prod-touching script resolves it here, so one knob moves it.
#   PROD_CONFIG_DIR (absolute; a relative value refuses; empty = unset) → that directory.
#   unset → the MAIN worktree root of this checkout, resolved exactly like `prod_writes_file` (scripts/lib/prod-writes.sh),
#           so linked worktrees and trees with no git metadata inherit it.
# Anything missing → ONE `::error:: no target configured — <dir>/.env.prod (set PROD_CONFIG_DIR)` line on stderr and a
# non-zero return. Never a fallback (not cwd, not another file).
#
#   prod_config_dir                       prints the directory
#   load_prod_config [--optional] [--only KEY,KEY]
#                                         exports the keys `<dir>/.env.prod` assigns, plus VERCEL_ORG_ID /
#                                         VERCEL_PROJECT_ID from `<dir>/.vercel/project.json` (orgId / projectId).
#                                         Values are read LITERALLY, by node's dotenv parser (the TS twin's) — the file
#                                         is never sourced, so a `$` or a backtick in a value stays as written.
#                                         A key already set non-empty in the env WINS (node `--env-file` semantics), so a
#                                         one-command override survives — except the identity keys SUPABASE_URL,
#                                         SUPABASE_PROJECT_REF, PROD_ALIAS, SUPABASE_ANON_KEY (vs `.env.prod`) and
#                                         VERCEL_ORG_ID, VERCEL_PROJECT_ID (vs project.json): an env value its file
#                                         contradicts refuses (one ::error:: line, nothing loaded; `--optional` does not
#                                         waive it; a key the file lacks is not compared). `PROD_WRITES` and `PROD_CONFIG_DIR` are
#                                         never taken from the file. `--only` loads just the named keys (a Vercel id among them
#                                         or not) and refuses when one stays unset; `--optional` turns every refusal
#                                         about a missing file or key into a quiet pass (a relative knob, an unreadable
#                                         `.env.prod` — a dangling symlink too — and an unparsable project.json still refuse).
#   prod_config_ref                       the Supabase project ref: env SUPABASE_PROJECT_REF, else `<ref>` of
#                                         SUPABASE_URL's host `<ref>.supabase.co`; both set and disagreeing → refuse
#   prod_project_ref                      the ops scripts' ref: env SUPABASE_PROJECT_REF, else the config file's
#                                         (only those two keys read, own subshell; the env's SUPABASE_URL ignored)
#   prod_config_base_url                  `https://<PROD_ALIAS>`: a bare host or an https URL, no trailing slash
#   prod_base_url                         the probes' prod base URL: env PROD_ALIAS when non-blank (after an ASCII trim;
#                                         never compared against the file), else the config file's (only that key read,
#                                         own subshell), as `https://<host>`
# prod_config_ref and prod_config_base_url read the env only — call load_prod_config first. Callers:
# `load_prod_config || exit 1`, `ref="$(prod_config_ref)"` under `set -e`. prod_project_ref instead loads the
# config itself (in its subshell): `REF="$(prod_project_ref)" || exit 1`, no load_prod_config before it; so does
# prod_base_url: `base="$(prod_base_url)" || exit 1`.
#
# TS twin: scripts/lib/prod-config.ts — same resolution, same rules; change both together
# (scripts/lib/prod-config.test.ts runs both over one table).

# shellcheck source=prod-writes.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/prod-writes.sh"

# _prod_config_trim <value> — prints <value> without leading/trailing ASCII whitespace.
_prod_config_trim() {
  local LC_ALL=C v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  printf '%s' "$v"
}

# _prod_config_missing <what> — the one refusal line for an absent config (<what> = the file, or `<file> has no K`).
_prod_config_missing() {
  echo "::error:: no target configured — $1 (set PROD_CONFIG_DIR)" >&2
  return 1
}

# _prod_config_wanted <key> — 0 when load_prod_config's `--only` list (its local `only`, ",KEY,KEY,") is unset or holds <key>.
_prod_config_wanted() { [ -z "$only" ] || [[ $only == *",$1,"* ]]; }

# prod_config_dir — prints the prod config directory (rule in the header); returns 1 (one ::error:: line) otherwise.
prod_config_dir() {
  local d="${PROD_CONFIG_DIR:-}" f
  if [ -n "$d" ]; then
    if [ "${d#/}" = "$d" ]; then
      echo "::error:: PROD_CONFIG_DIR must be an absolute path — got '$d'" >&2
      return 1
    fi
    while [ "$d" != / ] && [ "${d%/}" != "$d" ]; do d="${d%/}"; done
    printf '%s\n' "$d"
    return 0
  fi
  if ! f="$(prod_writes_file)"; then
    echo "::error:: no target configured — cannot locate the main worktree root of ${_PROD_WRITES_CHECKOUT:-this checkout} (set PROD_CONFIG_DIR)" >&2
    return 1
  fi
  printf '%s\n' "$(dirname -- "$f")"
}

# The JS prelude load_prod_config's node readers share: q(s) = s single-quoted for one bash `eval` (a `'` → `'\''`).
_PROD_CONFIG_JS_Q='const q = (s) => "\x27" + s.replaceAll("\x27", "\x27\\\x27\x27") + "\x27";'

# load_prod_config [--optional] [--only KEY,KEY] — exports the config into THIS shell (rule in the header).
# Three phases, so a refusal loads nothing: read both files, check (identity conflicts, a missing Vercel id), export.
load_prod_config() {
  local IFS=$' \t\n' optional="" only="" dir env_file vercel_file k v field out
  local -A file_val=() link_val=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --optional) optional=1 ;;
      --only)
        [ $# -ge 2 ] || { echo "::error:: load_prod_config: --only needs KEY,KEY" >&2; return 1; }
        only=",$2,"
        shift
        ;;
      --only=*) only=",${1#--only=}," ;;
      *) echo "::error:: load_prod_config: unknown argument '$1'" >&2; return 1 ;;
    esac
    shift
  done
  dir="$(prod_config_dir)" || return 1
  env_file="$dir/.env.prod"
  vercel_file="$dir/.vercel/project.json"

  # ── read ── `.env.prod` through node's own dotenv parser (the TS twin's), so a value is read LITERALLY — never
  # sourced: no `$` expansion, no command substitution. Node hands back `file_val[KEY]='<value>'` lines, single-quote
  # escaped, identifier keys only; each reader's output is eval'd once.
  if [ -e "$env_file" ] || [ -L "$env_file" ]; then
    if [ -d "$env_file" ] || [ ! -r "$env_file" ]; then
      echo "::error:: cannot read $env_file" >&2
      return 1
    fi
    # shellcheck disable=SC2016 # JS template literals, not shell expansions
    out="$(node -e "$_PROD_CONFIG_JS_Q"'
      for (const [k, v] of Object.entries(require("node:util").parseEnv(require("node:fs").readFileSync(process.argv[1], "utf8")))) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) process.stdout.write(`file_val[${k}]=${q(v)}\n`);
      }' "$env_file")" || {
      echo "::error:: cannot read $env_file" >&2
      return 1
    }
    eval "$out"
  elif [ -z "$optional" ]; then
    _prod_config_missing "$env_file"
    return 1
  fi
  if { _prod_config_wanted VERCEL_ORG_ID || _prod_config_wanted VERCEL_PROJECT_ID; } && [ -f "$vercel_file" ]; then
    # shellcheck disable=SC2016 # JS template literals, not shell expansions
    out="$(node -e "$_PROD_CONFIG_JS_Q"'
      const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      for (const f of ["orgId", "projectId"]) {
        const v = j[f];
        if (typeof v === "string" && v !== "") process.stdout.write(`link_val[${f}]=${q(v)}\n`);
      }' "$vercel_file" 2>/dev/null)" || {
      echo "::error:: cannot parse $vercel_file" >&2
      return 1
    }
    eval "$out"
  fi

  # ── check ── the identity keys name the target itself: an env value its file contradicts names another one.
  for k in SUPABASE_URL SUPABASE_PROJECT_REF PROD_ALIAS SUPABASE_ANON_KEY; do
    { _prod_config_wanted "$k" && [ -n "${!k:-}" ] && [ -n "${file_val[$k]+x}" ]; } || continue
    if [ "${!k}" != "${file_val[$k]}" ]; then
      echo "::error:: $k in the environment disagrees with $env_file — unset it or set PROD_CONFIG_DIR" >&2
      return 1
    fi
  done
  for k in VERCEL_ORG_ID:orgId VERCEL_PROJECT_ID:projectId; do
    field="${k#*:}"
    k="${k%%:*}"
    _prod_config_wanted "$k" || continue
    v="${link_val[$field]:-}"
    if [ -n "${!k:-}" ]; then
      if [ -n "$v" ] && [ "${!k}" != "$v" ]; then
        echo "::error:: $k in the environment disagrees with $vercel_file — unset it or set PROD_CONFIG_DIR" >&2
        return 1
      fi
    elif [ -z "$v" ] && [ -z "$optional" ]; then
      if [ -f "$vercel_file" ]; then _prod_config_missing "$vercel_file has no $field"; else _prod_config_missing "$vercel_file"; fi
      return 1
    fi
  done

  # ── export ── a key already set non-empty wins; PROD_WRITES / PROD_CONFIG_DIR never come from the file.
  for k in "${!file_val[@]}"; do
    case "$k" in PROD_WRITES | PROD_CONFIG_DIR) continue ;; esac
    { _prod_config_wanted "$k" && [ -z "${!k:-}" ]; } || continue
    export "$k=${file_val[$k]}"
  done
  for k in VERCEL_ORG_ID:orgId VERCEL_PROJECT_ID:projectId; do
    field="${k#*:}"
    k="${k%%:*}"
    { _prod_config_wanted "$k" && [ -z "${!k:-}" ] && [ -n "${link_val[$field]:-}" ]; } || continue
    export "$k=${link_val[$field]}"
  done

  if [ -n "$only" ] && [ -z "$optional" ]; then
    local -a keys
    IFS=, read -r -a keys <<<"${only#,}"
    for k in "${keys[@]}"; do
      [ -n "$k" ] || continue
      [ -n "${!k:-}" ] || { _prod_config_missing "$env_file has no $k"; return 1; }
    done
  fi
  return 0
}

# prod_config_ref — prints the Supabase project ref (rule in the header).
prod_config_ref() {
  local LC_ALL=C ref url host from_url="" dir
  ref="$(_prod_config_trim "${SUPABASE_PROJECT_REF:-}")"
  ref="${ref,,}"
  url="$(_prod_config_trim "${SUPABASE_URL:-}")"
  if [ -n "$url" ]; then
    host="${url#*://}"
    host="${host%%/*}"
    host="${host,,}"
    if [[ $url == https://* ]] && [[ $host =~ ^([a-z0-9]+)\.supabase\.co$ ]]; then
      from_url="${BASH_REMATCH[1]}"
    else
      echo "::error:: SUPABASE_URL is not https://<ref>.supabase.co — got '$url'" >&2
      return 1
    fi
  fi
  if [ -n "$ref" ]; then
    if [[ ! $ref =~ ^[a-z0-9]+$ ]]; then
      echo "::error:: SUPABASE_PROJECT_REF is not a project ref — got '$ref'" >&2
      return 1
    fi
    if [ -n "$from_url" ] && [ "$from_url" != "$ref" ]; then
      echo "::error:: SUPABASE_PROJECT_REF ($ref) disagrees with SUPABASE_URL's host ($host) — fix the prod config" >&2
      return 1
    fi
    printf '%s\n' "$ref"
    return 0
  fi
  if [ -n "$from_url" ]; then
    printf '%s\n' "$from_url"
    return 0
  fi
  dir="$(prod_config_dir)" || return 1
  _prod_config_missing "$dir/.env.prod has no SUPABASE_URL"
}

# prod_project_ref — prints the ops scripts' Supabase project ref: env SUPABASE_PROJECT_REF, else the prod config's
# (its SUPABASE_PROJECT_REF, else the <ref> of its SUPABASE_URL). Runs in a subshell, so nothing is exported to the
# caller; the env's SUPABASE_URL is never consulted, so a guard comparing it against this ref can still fail.
# TS twin: `prodProjectRef` (scripts/supabase-project.ts). Callers: `REF="$(prod_project_ref)" || exit 1`.
prod_project_ref() {
  (
    unset SUPABASE_URL
    if [ -z "$(_prod_config_trim "${SUPABASE_PROJECT_REF:-}")" ]; then
      unset SUPABASE_PROJECT_REF
      load_prod_config --optional --only SUPABASE_PROJECT_REF,SUPABASE_URL || exit 1
    fi
    prod_config_ref
  )
}

# prod_config_base_url — prints `https://<PROD_ALIAS>` (rule in the header).
prod_config_base_url() {
  local LC_ALL=C a dir
  a="$(_prod_config_trim "${PROD_ALIAS:-}")"
  if [ -z "$a" ]; then
    dir="$(prod_config_dir)" || return 1
    _prod_config_missing "$dir/.env.prod has no PROD_ALIAS"
    return 1
  fi
  while [ "${a%/}" != "$a" ]; do a="${a%/}"; done
  case "$a" in
    https://*) ;;
    *://*) echo "::error:: PROD_ALIAS must be a host or an https URL — got '$a'" >&2; return 1 ;;
    *) a="https://$a" ;;
  esac
  if [[ ! $a =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
    echo "::error:: PROD_ALIAS must be a host or an https URL — got '$a'" >&2
    return 1
  fi
  printf '%s\n' "$a"
}

# prod_base_url — prints the probes' prod base URL `https://<host>`: env PROD_ALIAS wins when non-blank after an ASCII
# trim (a one-command override, never compared against the config file); blank → the config file's PROD_ALIAS (only
# that key loaded). Runs in a subshell, so nothing is exported to the caller. TS twin: `prodBaseUrl`
# (scripts/lib/prod-base-url.ts). Callers: `base="$(prod_base_url)" || exit 1`.
prod_base_url() {
  (
    if [ -z "$(_prod_config_trim "${PROD_ALIAS:-}")" ]; then
      unset PROD_ALIAS
      load_prod_config --only PROD_ALIAS || exit 1
    fi
    prod_config_base_url
  )
}
