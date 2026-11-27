#!/usr/bin/env bash
# Verify a per-(market,mode) calibration publish landed in prod (Stage-6 checks).
#
# After `make ship`'s publish step (`publish-calibration-prod.sh`) lands a vintage, this
# confirms the vintage actually WON in `calibration_latest` and surfaced through
# the read API — the failure mode a green publish log hides is a stale vintage
# out-ranking the new one (the view is DISTINCT ON (market,mode,channel,metric)
# ORDER BY computed_at DESC, so a lower `computed_at` is silently superseded; see
# the "CI restamps computed_at" gotcha in docs/reference.md §[arch] 9. Cross-file design invariants for why CI runs never
# hit that, but a hand-published vintage could).
#
# Read-only by default. `--cron` adds a prod-WRITING /api/cron/run (persists a
# real alert_log row + readings — one deliberate off-schedule run; don't spam it).
#
# Usage:   scripts/verify-calibration-publish.sh [--cron]
# Config:  BASE_URL (default: the prod alias — PROD_ALIAS, else the prod config's; neither refuses), SUPABASE_REF (default: the prod config's project ref), SUPABASE_ACCESS_TOKEN
#          (falls back to ~/.supabase/access-token), CRON_SECRET (falls back to
#          the checkout's prod config, $PROD_CONFIG_DIR/.env.prod) — only needed with --cron.
# Requires: curl + python3 (+ a Supabase Management API token).
set -euo pipefail

# shellcheck source=lib/prod-config.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/prod-config.sh"
BASE_URL="${BASE_URL:-}"
[ -n "$BASE_URL" ] || BASE_URL="$(prod_base_url)" || exit 1
BASE_URL="${BASE_URL%/}"
REF="${SUPABASE_REF:-}"
[ -n "$REF" ] || REF="$(prod_project_ref)" || exit 1
RUN_CRON=0
[ "${1:-}" = "--cron" ] && RUN_CRON=1

# Prod-writes switch (scripts/lib/prod-writes.sh via lib/cron-trigger.sh): `--cron` is a prod WRITE — refuse
# before anything runs (cron_trigger re-checks at the trigger). The default read-only mode stays unguarded.
if [ "$RUN_CRON" = 1 ]; then
  # shellcheck source=lib/cron-trigger.sh
  . "$(dirname "${BASH_SOURCE[0]}")/lib/cron-trigger.sh"
  require_prod_writes "the cron trigger" || exit 1
fi

TOKEN="${SUPABASE_ACCESS_TOKEN:-$(cat ~/.supabase/access-token 2>/dev/null || true)}"
[ -z "$TOKEN" ] && { echo "!! no Supabase token (set SUPABASE_ACCESS_TOKEN or ~/.supabase/access-token)"; exit 1; }

pgq() { # run read-only SQL via the Management API; $1 = query (single-quote SQL literals, no double-quotes)
  curl -fsS -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"query\":\"$1\"}"
}

echo "== 1. newest calibration vintages (top row must be a FRESH stamp) =="
pgq "select computed_at, count(*) n from calibration group by computed_at order by computed_at desc limit 5" \
  | python3 -c '
import sys, json
for r in json.load(sys.stdin):
    print("  " + str(r["computed_at"]) + "  n=" + str(r["n"]))
'

echo "== 2. per-(market,mode) cell coverage in calibration_latest =="
pgq "select market, mode, channel, metric, value, computed_at from calibration_latest where market is not null order by market, mode, channel, metric" \
  | python3 -c '
import sys, json
from collections import defaultdict
rows = json.load(sys.stdin)
cells = defaultdict(set); stamps = set()
for r in rows:
    ind = r["metric"].replace("_operative", "").rsplit("_", 1)[0]  # drop _amber/_red
    cells[(r["market"], r["mode"])].add(ind)
    stamps.add(r["computed_at"])
print("  " + str(len(rows)) + " rows / " + str(len(cells)) + " cells / " + str(len(stamps)) + " stamp(s): " + str(sorted(stamps)))
for key in sorted(cells):
    mkt, mode = key
    inds = sorted(cells[key])
    print("    " + mkt.ljust(5) + " " + mode.ljust(11) + " " + str(len(inds)) + " ind: " + ", ".join(inds))
'

echo "== 3. divergence sanity — dgs10 red cut per (market,mode) (correction should trip <= bear) =="
pgq "select market, mode, value from calibration_latest where metric = 'dgs10_operative_red' and market is not null order by market, mode" \
  | python3 -c '
import sys, json
from collections import defaultdict
by = defaultdict(dict)
for r in json.load(sys.stdin):
    by[r["market"]][r["mode"]] = r["value"]
for mkt in sorted(by):
    modes = by[mkt]
    parts = [m + "=" + str(modes[m]) for m in ("correction", "bear", "crash") if m in modes]
    flag = ""
    if "correction" in modes and "bear" in modes and modes["correction"] > modes["bear"]:
        flag = "  <-- WARN: correction > bear"
    print("    " + mkt.ljust(5) + " " + "  ".join(parts) + flag)
'

echo "== 4. /api/indicators — vintage surfaced live? =="
curl -fsS "$BASE_URL/api/indicators" -H 'Cache-Control: no-cache' \
  | python3 -c '
import sys, json
from collections import Counter
d = json.load(sys.stdin)
prov = dict(Counter(i.get("provenance") for i in d))
print("  provenance: " + str(prov))
if prov.get("convention") == len(d):
    print("  !! ALL convention — the vintage did NOT surface (publish skipped, or CDN stale — cache-bust + recheck)")
'

if [ "$RUN_CRON" -eq 1 ]; then
  echo "== 5. /api/cron/run (prod-WRITING — persists one real run) =="
  # CRON_SECRET from the env, else the checkout's prod config (scripts/lib/prod-config.sh; best-effort, so a missing
  # file or key reaches the friendly guard below).
  # shellcheck source=lib/prod-config.sh
  . "$(dirname "${BASH_SOURCE[0]}")/lib/prod-config.sh"
  load_prod_config --optional --only CRON_SECRET || exit 1
  SECRET="${CRON_SECRET:-}"
  [ -z "$SECRET" ] && { echo "  !! no CRON_SECRET (set CRON_SECRET or add it to $(prod_config_dir)/.env.prod — prod cron auth)"; exit 1; }
  BODY=$(mktemp)
  CODE=$(cron_trigger "$BASE_URL" "" "$SECRET" -sS -o "$BODY" -w '%{http_code}')
  echo "  HTTP $CODE"
  python3 -c '
import sys, json
d = json.load(open(sys.argv[1]))
v = d.get("verdict", d)
print("  level: " + str(v.get("level")) + "  vix: " + str(v.get("vix")))
print("  (no push at steady state; vol-channel divergence is VIX-conditional above the ~24.2 cut)")
' "$BODY"
  rm -f "$BODY"
else
  echo "== 5. /api/cron/run — SKIPPED (pass --cron to run it; it writes a real prod run) =="
fi

echo "done."
