#!/usr/bin/env bash
# Create or rotate the read-only prod login role `crash_ro` (SELECT on public + supabase_migrations, pg_monitor).
# Password: generated here, written ONLY to ~/.pgpass; prod receives a SCRAM verifier, never the plaintext.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/prod-writes.sh"
require_prod_writes "the read-only role setup" || exit 1

# shellcheck source=lib/prod-config.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/prod-config.sh"
REF="$(prod_project_ref)" || exit 1
ROLE=crash_ro
# The pooler host: env SUPABASE_DB_HOST wins; else the prod config's (refuses with its ::error:: line when it has none).
[ -n "${SUPABASE_DB_HOST:-}" ] || load_prod_config --only SUPABASE_DB_HOST || exit 1
HOST=$SUPABASE_DB_HOST
PGPASS=~/.pgpass

pw=$(openssl rand -hex 24)
verifier=$(PW="$pw" python3 -I -c '
import base64, hashlib, hmac, os
pw = os.environ["PW"].encode(); salt = os.urandom(16); it = 4096
salted = hashlib.pbkdf2_hmac("sha256", pw, salt, it)
ck = hmac.new(salted, b"Client Key", "sha256").digest()
sk = hmac.new(salted, b"Server Key", "sha256").digest()
b = lambda x: base64.b64encode(x).decode()
print(f"SCRAM-SHA-256${it}:{b(salt)}${b(hashlib.sha256(ck).digest())}:{b(sk)}")')

sql="do \$do\$ begin
  if not exists (select from pg_roles where rolname = '$ROLE') then create role $ROLE; end if;
end \$do\$;
alter role $ROLE with login bypassrls nosuperuser nocreatedb nocreaterole noreplication connection limit 3 password '$verifier';
alter role $ROLE set default_transaction_read_only = on;
alter role $ROLE set statement_timeout = '60s';
alter role $ROLE set idle_in_transaction_session_timeout = '60s';
grant usage on schema public, supabase_migrations, extensions to $ROLE;
grant select on all tables in schema public, supabase_migrations to $ROLE;
alter default privileges for role postgres in schema public grant select on tables to $ROLE;
grant pg_monitor to $ROLE;"

TOKEN=$(cat ~/.supabase/access-token)
resp=$(jq -n --arg q "$sql" '{query: $q}' | curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") -H "Content-Type: application/json" -d @-)
# The API answers an SQL error as a JSON {"message": …}, not a non-zero exit.
if printf '%s' "$resp" | jq -e 'type == "object" and has("message")' >/dev/null; then
  echo "setup-prod-ro-role: FAILED — $resp" >&2; exit 1
fi

# Replace this role's ~/.pgpass line; other lines untouched.
touch "$PGPASS"; chmod 600 "$PGPASS"
grep -v ":$ROLE.$REF:" "$PGPASS" > "$PGPASS.tmp" || true
printf '%s:5432:postgres:%s.%s:%s\n' "$HOST" "$ROLE" "$REF" "$pw" >> "$PGPASS.tmp"
mv "$PGPASS.tmp" "$PGPASS"; chmod 600 "$PGPASS"
echo "setup-prod-ro-role: $ROLE ready; password stored in $PGPASS only"
