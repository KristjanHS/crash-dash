#!/usr/bin/env bash
# Read-only prod SQL as the `crash_ro` role (setup-prod-ro-role.sh): `scripts/prod-psql-ro.sh "<sql>"`.
# Prod safety is the role's privileges. The one check here protects THIS machine: psql backslash commands run local shell (\!).
set -euo pipefail
sql=${1:?usage: scripts/prod-psql-ro.sh \"<sql>\"}
[[ $# -eq 1 ]] || { echo "prod-psql-ro: exactly one SQL argument" >&2; exit 2; }
[[ $sql == *\\* ]] && { echo "prod-psql-ro: backslashes refused (psql meta-commands run local shell)" >&2; exit 2; }
# shellcheck source=lib/prod-config.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/prod-config.sh"
# The pooler host: env SUPABASE_DB_HOST wins; else the prod config's (refuses with its ::error:: line when it has none).
[ -n "${SUPABASE_DB_HOST:-}" ] || load_prod_config --only SUPABASE_DB_HOST || exit 1
REF="$(prod_project_ref)" || exit 1
exec psql -X -v ON_ERROR_STOP=1 -P pager=off \
  "host=$SUPABASE_DB_HOST port=5432 dbname=postgres user=crash_ro.$REF sslmode=require" \
  -c "$sql"
