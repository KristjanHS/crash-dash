#!/usr/bin/env bash
# ExecStartPre of the Persistent= timer units: wait ≤ ${2:-60} s for DNS + HTTPS (any HTTP answer) after a resume; exit 1 on timeout.
# Falsifier: `scripts/systemd/wait-online.sh https://nonexistent.invalid 3; echo $?` → 1.
set -u
url="${1:-https://github.com}"
limit="${2:-60}"
deadline=$((SECONDS + limit))
until curl -sS -o /dev/null --max-time 5 "$url"; do
  if ((SECONDS >= deadline)); then
    echo "wait-online: no network after ${limit} s ($url)" >&2
    exit 1
  fi
  sleep 2
done
