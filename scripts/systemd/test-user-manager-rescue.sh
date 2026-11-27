#!/usr/bin/env bash
#
# sudo scripts/systemd/test-user-manager-rescue.sh — force ONE failed user@1000 start (a /run-only drop-in) and assert the
# rescue unit brings it up within 20 s. Exit 0 PASS / 1 FAIL. Side effect: user timers start (Persistent catch-up runs).
# Output: only PID-1 lines about the user@/runtime-dir/rescue chain. The ONE induced failure group is tagged [expected];
# any other failure line is tagged [UNEXPECTED]. On FAIL the three units' full journals follow for the cause.
#
set -uo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
U=user@1000.service
R=user-manager-rescue@1000.service
RD=user-runtime-dir@1000.service
D=/run/systemd/system/$U.d
F=/run/user-manager-fail-once
cleanup() { rm -f "$D/fail-once.conf" "$F"; rmdir "$D" 2>/dev/null; systemctl daemon-reload; }
trap cleanup EXIT

systemctl show "$U" -p OnFailure --value | grep -q user-manager-rescue || { echo "FAIL: rescue not installed"; exit 1; }
[ "$(systemctl is-active "$U")" = active ] && { echo "PRECONDITION: $U is active; stop it first (systemctl stop $U)"; exit 1; }
systemctl reset-failed "$U" "$RD" "$R" 2>/dev/null

mkdir -p "$D"
printf '[Service]\nExecStartPre=+/bin/sh -c "[ ! -e %s ] || { rm -f %s; exit 1; }"\n' "$F" "$F" >"$D/fail-once.conf"
touch "$F"
systemctl daemon-reload
since="$(date '+%F %T')"
# The forced failure is the point of the test — swallow systemctl's "Job … failed" stderr; the journal below shows it.
systemctl start "$U" 2>/dev/null && { echo "FAIL: forced failure did not fail"; exit 1; }
[ -e "$F" ] && { echo "FAIL: fail-once flag not consumed"; exit 1; }

for _ in $(seq 20); do
  [ "$(systemctl is-active "$U")" = active ] && break
  sleep 1
done

# PID 1 only: -u $U would also match the user manager's own children (pipewire/RTKit realtime noise on WSL).
chain="$(journalctl --since "$since" -q -o short-iso --no-pager _PID=1 \
  | grep -E 'user@1000|user-manager-rescue|User Manager for UID 1000|user-runtime-dir@1000|User Runtime Directory /run/user/1000|run-user-1000')"

# Tag only the induced group: user@ failure lines up to the FIRST "Triggering OnFailure", and the runtime-dir
# stop failure that immediately follows its "Stopping"/unmount lines. Any later failure (a rescue retry, a runtime-dir
# START failure) is the real WSL race and stays visibly [UNEXPECTED]. Matches both systemd <250 and >=250 line formats.
printf '%s\n' "$chain" | awk '
  /user@1000\.service: Triggering OnFailure/ { triggered = 1 }
  {
    tag = ""
    if (!triggered && /user@1000\.service: (Control process exited|Failed with result)|Failed to start (user@1000\.service|User Manager)/) tag = "[expected: forced]"
    else if (/user-runtime-dir@1000\.service: Control process exited/ && prev ~ /Stopping User Runtime Directory|run-user-1000\.mount: Deactivated/ && !rdtagged) { tag = "[expected: runtime-dir stop after the failure]"; rdpending = 1 }
    else if (/user-runtime-dir@1000\.service: Failed with result/ && rdpending) { tag = "[expected: runtime-dir stop after the failure]"; rdpending = 0; rdtagged = 1 }
    else if (/FAILURE|Failed/) tag = "[UNEXPECTED]"
    print (tag == "" ? $0 : $0 "  " tag)
    prev = $0
  }'

# Attribution, from the chain order: the rescue must have STARTED, FINISHED successfully (oneshot "Finished" = its
# systemctl start exited 0) and not failed, and user@ must have reached Started AFTER the rescue started. Fails closed.
verdict="$(printf '%s\n' "$chain" | awk '
  /Starting .*Re-start user@1000/ && !rs { rs = NR }
  /Finished .*Re-start user@1000/ { rf = NR }
  /user-manager-rescue@1000\.service: Failed/ { rfail = 1 }
  /Started .*User Manager for UID 1000/ { us = NR }
  END {
    if (!rs) print "rescue never started"
    else if (rfail || !rf) print "rescue did not finish successfully"
    else if (us <= rs) print "user@ did not reach Started after the rescue started"
    else print "ok"
  }')"

fail() {
  echo "FAIL: $1"
  echo "--- full journal for $U $R $RD since $since ---"
  journalctl --since "$since" -q -o short-iso --no-pager -u "$U" -u "$R" -u "$RD" | tail -n 60
  exit 1
}
[ "$(systemctl is-active "$U")" = active ] || fail "$U is $(systemctl is-active "$U") 20 s after the forced failure"
[ "$verdict" = ok ] || fail "$U is active but not via the rescue: $verdict"
echo "PASS: forced failure → rescue → $U active"
