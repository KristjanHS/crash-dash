#!/usr/bin/env bash
#
# ladder-notify.sh <title> <priority> <tags> — one ntfy push for the ladder timer, body on stdin. Shared by
# scripts/ladder-alert.sh (a failed run) and scripts/eufin-run-local.sh (denied tool calls). Topic:
# NTFY_TOPIC (eufin.env), else the repo's .env.local — the ladder's push topic, same as `<leg>:apply`.
# Unset topic → a warning and exit 0 (the journal is the record). A failed push → exit 1.
#
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
topic="${NTFY_TOPIC:-$(sed -n 's/^NTFY_TOPIC=//p' "$REPO/.env.local" 2>/dev/null | tail -n1 | tr -d "\"' \r")}"
[ -n "$topic" ] || { echo "::warning:: NTFY_TOPIC unset — ladder push '$1' not sent" >&2; exit 0; }
curl -fsS -m 15 -H "Title: $1" -H "Priority: $2" -H "Tags: $3" \
  --data-binary @- "https://ntfy.sh/$topic" >/dev/null || { echo "::warning:: ntfy push failed" >&2; exit 1; }
echo "ntfy push sent: $1"
