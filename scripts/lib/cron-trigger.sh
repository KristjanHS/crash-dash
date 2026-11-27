# shellcheck shell=bash
# Trigger the deployed cron (`<base>/api/cron/run<query>` with the CRON_SECRET bearer) — a prod WRITE, so the
# prod-writes switch (lib/prod-writes.sh) is consulted FIRST, before curl runs. The bearer goes in on stdin
# (`-H @-`), never argv.
#
# TS twin: scripts/lib/cron-trigger.ts (`triggerCron`) — every CRON_SECRET-bearing trigger in scripts/ goes
# through one of the two (scripts/lib/cron-trigger.test.ts greps for strays).

# shellcheck source=lib/prod-writes.sh
. "$(dirname "${BASH_SOURCE[0]}")/prod-writes.sh"

# cron_trigger <base-url> <query> <secret> [curl args…] — runs curl on <base>/api/cron/run<query> with the bearer;
# extra args (output, -w, timeouts) pass through and curl's stdout/exit status are returned as-is. Prod writes
# off ⇒ one ::error:: line, return 1, curl never runs.
cron_trigger() {
  local base="${1%/}" query="$2" secret="$3"
  shift 3
  require_prod_writes "the cron trigger" || return 1
  printf 'authorization: Bearer %s\n' "$secret" | curl -H @- "$@" "$base/api/cron/run$query"
}
