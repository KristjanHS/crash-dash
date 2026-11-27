#!/usr/bin/env bash
# probe-dast.sh — the DAST pass against the live prod surface. MANUAL ONLY.
#
#   npm run probe:dast    /    make scan-dast    /    BASE_URL=… bash scripts/probe-dast.sh
#
# Deliberately NOT in `scan:sec` and NOT in any hook (plan R2): it fires real traffic at the
# production WAF and it is SLOW — the plan's "3-6 min" estimate is wrong, a throttled full-tag run
# measured >10 minutes on 2026-08-20. Run it backgrounded; no ship and no push should pay for it.
#
# ⛔ THE POINT OF THIS SCRIPT IS THE MITIGATION GUARD, not the finding list. On 2026-08-20 an
# unthrottled run (`-rl 20 -c 10`) returned 15 "findings" of which all ten HTTP ones were matchers
# describing Vercel's bot-challenge 403 (`X-Vercel-Mitigated: challenge`) — the app was never
# reached. A mitigated response is a SUCCESSFUL-LOOKING scan result, which is the dangerous shape:
# silently green while totally blind. So:
#   A (throttle) — `-rl 1 -c 1`. The trigger was isolated to rate x concurrency, not client
#     fingerprint: the same tool, same templates, same spoofed UA passes cleanly once throttled.
#   B (guard)    — any `X-Vercel-Mitigated` anywhere in the JSONL exits 1. Without B, A's success
#     cannot be told apart from a lucky quiet minute.
#   C (reach)    — B ALONE IS NOT ENOUGH, and this is the review finding that put C here. nuclei's
#     `-include-rr` records the response "for findings only", so it writes a JSONL line at all only
#     when a template MATCHES. If the WAF challenges every request and no matcher happens to fire
#     on the challenge page, the output file is EMPTY, B has nothing to grep, and the run reports
#     "0 findings" — byte-indistinguishable from a genuinely clean scan. B only fired on
#     2026-08-20 because a missing-headers matcher INCIDENTALLY matched the 403 page; that is luck,
#     not a guarantee. So a zero-finding run must additionally PROVE it reached the app: one
#     `curl` with nuclei's own spoofed UA, asserting a non-challenge status and no mitigation
#     header. Its limit, stated: one request in the same window is evidence the surface was
#     answering, not proof that every nuclei request was. It converts "empty ⇒ green" into
#     "empty AND demonstrably reachable ⇒ green", and makes a challenged window LOUD.
# That grep's ability to FIRE is established by the 2026-08-20 run itself — it is
# how the guard came to exist. To re-demonstrate it, re-run with `-rl 20 -c 10`.
#
# Escalation for a full-template sweep: a time-boxed Vercel WAF bypass rule keyed on a
# secret header (C) or Attack-Challenge-Mode off for an attended window (D) — revert either in the
# SAME sitting. Never leave a bypass rule standing.
set -uo pipefail

# BASE_URL wins; else the prod alias — env PROD_ALIAS, else the prod config's (scripts/lib/prod-config.sh, loaded in a
# subshell); neither → its ::error:: line, exit 1.
# shellcheck source=lib/prod-config.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/prod-config.sh"
BASE_URL="${BASE_URL:-}"
[ -n "$BASE_URL" ] || BASE_URL="$(prod_base_url)" || exit 1
TAGS="${DAST_TAGS:-misconfig,exposure,ssl,headers,cve}"
RL="${DAST_RL:-1}"
CONC="${DAST_CONC:-1}"

command -v nuclei >/dev/null 2>&1 || { echo "✗ probe:dast — \`nuclei\` is not installed; this probe fails closed rather than reporting a clean scan it never ran." >&2; exit 1; }

OUT="$(mktemp -t crash-dash-nuclei-XXXXXX.json)"
echo "▶ nuclei -u $BASE_URL -tags $TAGS -rl $RL -c $CONC   (throttled; >10 min — background it)"
nuclei -u "$BASE_URL" -tags "$TAGS" -rl "$RL" -c "$CONC" -j -o "$OUT" -silent
nrc=$?

# The guard runs even when nuclei itself errored — a partial JSONL full of challenges is exactly
# the state this exists to catch, and reporting "nuclei failed" would bury it.
if [ -s "$OUT" ] && grep -q 'X-Vercel-Mitigated' "$OUT"; then
  echo "✗ DAST blind: WAF challenged the scanner — every finding below describes Vercel's bot-challenge page, NOT the app. Re-run slower (DAST_RL=1 DAST_CONC=1), or use a time-boxed WAF bypass (C/D above). Raw: $OUT" >&2
  exit 1
fi
[ "$nrc" -eq 0 ] || { echo "✗ probe:dast — nuclei exited $nrc. Raw: $OUT" >&2; exit 1; }

n=$(grep -cve '^[[:space:]]*$' "$OUT" 2>/dev/null || true)
n=${n:-0}

# C — proof of reach. An empty $OUT is the ambiguous case (see the header): it means EITHER a clean
# scan OR a fully-challenged one whose challenge pages matched no template. Resolve it with one
# request, using nuclei's own spoofed UA, and fail LOUD rather than green on a challenge.
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
HDRS="$(mktemp)"; trap 'rm -f "$HDRS"' EXIT
# `-w` already prints 000 on a transport failure, so a `|| echo 000` fallback would CONCATENATE
# and yield "000000". Capture the body, then normalise an empty capture instead.
code=$(curl -sS -o /dev/null -D "$HDRS" -w '%{http_code}' -A "$UA" "$BASE_URL" 2>/dev/null)
code=${code:-000}
if grep -qi '^x-vercel-mitigated:' "$HDRS"; then
  echo "✗ DAST blind: the WAF is challenging this client RIGHT NOW (proof-of-reach curl got $code + X-Vercel-Mitigated), so the $n-finding result above says nothing about the app. Wait for the challenge window to pass and re-run, or use a time-boxed WAF bypass (C/D above). Raw: $OUT" >&2
  exit 1
fi
case "$code" in
  2*|3*) ;;
  *) echo "✗ probe:dast — proof-of-reach curl to $BASE_URL returned $code, so the scan cannot be called clean: an unreachable target produces the same empty output as a clean one. Raw: $OUT" >&2; exit 1 ;;
esac

if [ "$n" -gt 0 ]; then
  echo "▶ $n finding(s) — every one was ANSWERED by the app (no mitigation in the responses):"
  cat "$OUT"
fi
echo "✓ probe:dast: $BASE_URL reachable unmitigated (proof-of-reach curl $code), $n finding(s). Raw: $OUT"
