#!/usr/bin/env bash
# Read-only prod SQL via the Supabase Management API: `scripts/prod-sql-ro.sh "<one statement>"`.
# Postgres enforces it (BEGIN READ ONLY); the guards below close what a read-only transaction still allows.
set -euo pipefail

sql=${1:?usage: scripts/prod-sql-ro.sh \"<one SQL statement>\"}
sql=$(printf '%s' "$sql" | sed -E -e ':a' -e 'N' -e '$!ba' -e 's/[[:space:];]+$//')
refuse() { echo "prod-sql-ro: $1" >&2; exit 2; }

# A second statement could COMMIT/SET its way out of the read-only transaction.
[[ $sql == *";"* ]] && refuse "one statement only (no ';')"
# CLUSTER/REINDEX/ANALYZE/LOCK/LISTEN/SET run inside a read-only transaction — admit query forms only.
first=$(printf '%s' "$sql" | sed -E 's/^[[:space:](]+//' | grep -oiE '^[a-z]+' | tr '[:upper:]' '[:lower:]' || true)
[[ $first =~ ^(select|with|explain|show|table|values)$ ]] || refuse "only SELECT/WITH/EXPLAIN/SHOW/TABLE/VALUES"
# Unicode/escaped identifiers (U&"…") would dodge the name checks below.
printf '%s' "$sql" | grep -qiE 'u&' && refuse "U& escapes refused"
# Function names are checked with double quotes removed, so "pg_x"( is seen as pg_x(.
bare=$(printf '%s' "$sql" | tr -d '"' | tr '[:upper:]' '[:lower:]')
if printf '%s' "$bare" | grep -qE '\b(dblink[a-z_]*|copy|program|set_config|lo_[a-z_]+|query_to_xml[a-z_]*|cursor_to_xml|table_to_xml[a-z_]*)\b'; then
  refuse "construct reaches outside the read-only transaction"
fi
for fn in $(printf '%s' "$bare" | grep -oE '\bpg_[a-z0-9_]+[[:space:]]*\(' | grep -oE 'pg_[a-z0-9_]+' | sort -u); do
  [[ $fn =~ ^(pg_get_[a-z_]+|pg_size_pretty|pg_relation_size|pg_total_relation_size|pg_table_size|pg_indexes_size|pg_column_size|pg_database_size|pg_typeof|pg_backend_pid)$ ]] \
    || refuse "function $fn is not on the read-only allowlist"
done

# The ref comes from the prod config (PROD_CONFIG_DIR, else this checkout) — never hard-coded (flip 4.4 config split).
# shellcheck source=lib/prod-config.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/prod-config.sh"
REF="$(prod_project_ref)" || exit 1
TOKEN=$(cat ~/.supabase/access-token)
# Newline before '; commit' ends any trailing '--' comment in the statement.
body=$(jq -n --arg q "begin transaction read only; set local statement_timeout = '60s'; $sql
; commit;" '{query: $q}')
# Header via process substitution keeps the token out of the process list.
curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") -H "Content-Type: application/json" -d "$body"
echo
