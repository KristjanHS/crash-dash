# shellcheck shell=bash
# Release lock — ONE flock file for every prod release AND every user of the shared crash-dash-ci stack on this
# machine, whichever checkout runs it. `ship.sh` (both modes: `verify` runs the DB-armed suite on that stack too),
# `smoke-cron.sh` and `run-integration-tests.sh` hold it for their whole run; a second holder fails fast with one
# `::error::` line (no wait: the scripts' other single-flight locks are `flock -n` too, and a queued release would
# re-poll a cron run that is no longer its own). eufin-run-local.sh only PROBES it (`release_lock_busy`) before its
# prod scoring cron trigger / ship.
#
# Path: fixed — independent of cwd, of the checkout, and of session env (a systemd timer and a login shell can see
# different XDG_RUNTIME_DIR/TMPDIR, which would split one lock into two). CRASH_DASH_RELEASE_LOCK overrides it
# (tests point it at a temp dir).
#
# Held on fd 8 (fd 9 is the ladder run's own lock). A holder that runs another holder inside it (ship.sh §7 →
# smoke-cron.sh, or any holder → run-integration-tests.sh) hands the lock down: the child inherits fd 8 and the
# exported CRASH_DASH_RELEASE_LOCK_HELD=<path>, and re-locking that inherited descriptor succeeds because it IS the
# holder's open file — a fresh open of the path would conflict with the parent. Nothing here ever unlocks: the lock ends when the last holder of fd 8 exits.

# release_lock_path — prints the lock file path.
release_lock_path() {
  printf '%s\n' "${CRASH_DASH_RELEASE_LOCK:-/tmp/crash-dash-release-$(id -u).lock}"
}

# release_lock_acquire <what> — takes the release lock on fd 8 for the rest of the caller's run (or confirms the
# one inherited from a parent holder). Held elsewhere / unopenable ⇒ ONE `::error::` line on stderr, return 1.
# Callers: `release_lock_acquire "<what>" || exit 1`, before the first write.
release_lock_acquire() {
  local what="${1:-a release}" path
  path="$(release_lock_path)"
  if [ "${CRASH_DASH_RELEASE_LOCK_HELD:-}" = "$path" ] && [ /dev/fd/8 -ef "$path" ] && flock -n 8; then
    return 0
  fi
  if ! { exec 8>>"$path"; } 2>/dev/null; then
    echo "::error:: refusing $what — cannot open the release lock $path" >&2
    return 1
  fi
  if ! flock -n 8; then
    exec 8>&-
    echo "::error:: refusing $what — another release or CI-stack run (ship.sh / smoke-cron.sh / run-integration-tests.sh) holds the release lock $path" >&2
    return 1
  fi
  export CRASH_DASH_RELEASE_LOCK_HELD="$path"
}

# release_lock_busy — returns 0 when another process holds the release lock (or it cannot be opened: fail safe),
# 1 when it is free. Probes in a subshell and releases at once; the caller's own fds are untouched.
release_lock_busy() {
  local path
  path="$(release_lock_path)"
  ! ( exec 8>>"$path" && flock -n 8 ) 2>/dev/null
}
