#!/usr/bin/env bash
# with-prod-config.sh [--optional] [--only KEY,KEY] [--] <cmd…> — run <cmd…> with the checkout's prod config loaded
# into its environment (scripts/lib/prod-config.sh: PROD_CONFIG_DIR, else the main worktree root). The npm-script form
# of `node --env-file`, so a script reads the same config wherever the knob points.
#
#   (no flag)  `<dir>/.env.prod` is required (the one `::error:: no target configured …` line, exit 1, otherwise) —
#              `--env-file=` semantics. VERCEL_ORG_ID / VERCEL_PROJECT_ID are exported when `<dir>/.vercel/project.json`
#              holds them; a missing Vercel link is NOT a refusal here (no npm script needs it — the deploy path loads
#              the config itself and requires it).
#   --optional a missing file or key is a quiet pass — `--env-file-if-exists=` semantics; the script's own key checks
#              still refuse when a key it needs is absent.
#   --only     loads just the named keys and refuses when one stays unset (load_prod_config's rule).
# A non-empty key already in the environment wins, except an identity key the file contradicts (refuses) — the
# helper's rule. On success the command REPLACES this shell (`exec`): its exit status is the command's.
set -euo pipefail

# shellcheck source=lib/prod-config.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/prod-config.sh"

optional=""
only=""
while [ $# -gt 0 ]; do
  case "$1" in
    --optional) optional=1 ;;
    --only)
      [ $# -ge 2 ] || { echo "::error:: with-prod-config.sh: --only needs KEY,KEY" >&2; exit 1; }
      only="$2"
      shift
      ;;
    --only=*) only="${1#--only=}" ;;
    --) shift; break ;;
    -*) echo "::error:: with-prod-config.sh: unknown option '$1'" >&2; exit 1 ;;
    *) break ;;
  esac
  shift
done
[ $# -gt 0 ] || { echo "::error:: with-prod-config.sh: no command — usage: with-prod-config.sh [--optional] [--only KEY,KEY] <cmd…>" >&2; exit 1; }

if [ -n "$only" ]; then
  load_prod_config ${optional:+--optional} --only "$only" || exit 1
elif [ -n "$optional" ]; then
  load_prod_config --optional || exit 1
else
  # The env file is required; the Vercel link is not (header). The helper's own --optional load then reports an
  # unreadable file or a relative knob exactly as a required load would.
  dir="$(prod_config_dir)" || exit 1
  if [ ! -e "$dir/.env.prod" ] && [ ! -L "$dir/.env.prod" ]; then
    _prod_config_missing "$dir/.env.prod" || exit 1
  fi
  load_prod_config --optional || exit 1
fi
exec "$@"
