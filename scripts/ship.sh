#!/usr/bin/env bash
#
# ship.sh — the local release chain. One command runs every verification step ONCE, then
# (per mode) publishes and/or does the prod release locally.
#
# The independent read-only gates (typecheck, ESLint, notify oracle, and in `ship` the WAF + security
# checks) run CONCURRENTLY with the test pass and are joined before the first prod mutation —
# so the chain is fail-fast per PHASE, not per step. Every verdict is unchanged; see bg_start.
#
# Modes (see the Makefile targets):
#   verify — checks only, no push. The mid-dev gate.                        (make verify)
#   ship   — FULL green gate → migrate-prod(local) → publish-calibration(local)
#            → deploy(local) → vintage-drift gate (auto-restate on drift)
#            → push → cron re-derive.                                       (make ship)
#            The trailing cron run is NOT a smoke-test afterthought: a deploy leaves the
#            board a MIXED VINTAGE until a cron cycle re-persists the derived half (see §7).
#            The DEFAULT: the whole prod release runs from here so it never bills CI
#            minutes. Before any irreversible prod step, the ENTIRE suite (incl. the
#            DB-backed integration half) must be green — see the pre-deploy gate below.
#            CI on the resulting push runs ONLY the unit clean-room `check`.
#            (`all-local` is accepted as an alias for `ship`.)
#
# vitest runs exactly ONCE (no duplicate integration): DB-armed (unit+integration in one
# pass, against the isolated crash-dash-ci stack) whenever integration is in scope —
# ALWAYS in `ship` (it's the pre-prod-deploy gate), and in `verify` only when the push
# range touches src/store*/migrations. The final push uses `SKIP_TESTS=1 git push` (of the
# §0a-pinned sha, never the branch tip) so the
# BLOCKING pre-push hook never re-runs the same suite — this run IS the evidence it wants.
#
# Heavy steps are PATH-CONDITIONAL, mirroring the CI path filters — a step runs only when
# its inputs changed in this push (or when the range can't be computed, in which case every
# step runs: a safe superset that never under-verifies).
#
# Checks and payload are HEAD-only; the live tree is read only by the §5 prod scripts (§0 gates those):
#   · checks (§1–§4) run against a `git archive HEAD` copy in /tmp (§0b), so a half-finished
#     edit — yours or a parallel session's in this same repo — can neither fail a run whose
#     commit is fine nor green-light a HEAD that is broken;
#   · the deploy payload (§5) is a detached-HEAD worktree, so what Vercel serves is exactly
#     the commit §6 pushes.
# So there is NO general dirty-tree gate. `ship` refuses only uncommitted edits to the live-tree
# prod scripts (migrate-prod-local, publish-calibration-prod, smoke-cron) and supabase/migrations (§0).
#
# Output: every step's raw output goes to $SHIP_LOG (path printed at the end), while the
# screen shows a trimmed view — repetitive filler dropped with a hidden-line count, never
# silently. Warnings are re-printed as one block after the last step (warn_recap).
#
set -uo pipefail

MODE="${1:-verify}"
case "$MODE" in verify|ship) ;; all-local) MODE=ship ;; *)
  echo "usage: ship.sh [verify|ship]  (all-local = alias for ship)" >&2; exit 2 ;;
esac

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

# The checkout's prod config (scripts/lib/prod-config.sh) — resolved ONCE here and exported, so every prod script this
# run calls (migrate, publish, deploy, smoke-cron, the restate) reads the same directory.
# shellcheck source=lib/prod-config.sh
. "$REPO/scripts/lib/prod-config.sh"
PROD_CONFIG_DIR="$(prod_config_dir)" || { echo "✗ $MODE: the prod config directory cannot be resolved (reason above) — nothing was run." >&2; exit 1; }
export PROD_CONFIG_DIR

# Prod-writes switch (scripts/lib/prod-writes.sh) — `ship` only, once, before the fold, the gates or anything
# outward (each §5–§7 step re-checks it too).
if [ "$MODE" = ship ]; then
  # shellcheck source=lib/prod-writes.sh
  . "$REPO/scripts/lib/prod-writes.sh"
  require_prod_writes "ship" || { echo "✗ ship: prod writes are off — nothing was run." >&2; exit 1; }
fi
# Release lock (scripts/lib/release-lock.sh) — BOTH modes, held for the whole run, before the fold, the gates or the
# CI stack: `verify` runs the DB-armed suite on the one shared crash-dash-ci stack too, so a concurrent ship.sh,
# smoke-cron.sh or run-integration-tests.sh from any checkout makes this one refuse. §7's smoke-cron.sh inherits it
# (fd 8 + CRASH_DASH_RELEASE_LOCK_HELD).
# shellcheck source=lib/release-lock.sh
. "$REPO/scripts/lib/release-lock.sh"
release_lock_acquire "$MODE" || { echo "✗ $MODE: release lock not taken (reason above) — nothing was run." >&2; exit 1; }

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; printf '\n▶ %s\n' "$*" >>"${SHIP_LOG:-/dev/null}"; }
die()  { warn_recap; printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── Output discipline: full log on disk, trimmed view on screen ──────────────────────────
# The chain emitted ~1,500 lines, so both a non-fatal warning and any real detail scrolled
# past unread. Two mechanisms, neither of which DISCARDS anything:
#   1. every step's raw output is appended verbatim to $SHIP_LOG, whose path is printed at
#      the end — nothing is lost, it just stops competing for the screen;
#   2. the terminal view drops only provably-redundant filler (see NOISE), and each step
#      reports how many lines it hid so the trim is never silent.
# Warnings are additionally harvested into $WARN_LOG and re-printed as one block after the
# final step — on the die path, immediately above the ✗ line.
SHIP_LOG="${SHIP_LOG:-$(mktemp -t crash-dash-ship-log-XXXXXX)}"
WARN_LOG="$(mktemp)"
TIME_LOG="$(mktemp)"
CLEAN_DIRS=()
# CI-stack bookkeeping is minimal: §2 wraps vitest in `db.sh with ci`, which owns start-if-down →
# repair-if-partial → env, and traps its own INT/TERM teardown. The one piece kept here is the
# post-pass stop, moved to the background (ci_down_start). See the §2 comment for why the rest
# of that delegation is load-bearing.
cleanup() {
  # The background CI-stack start/stop are WAITED for, never killed (see ci_up_start / ci_down_start);
  # a stack brought up for a phase A that never ran (die during phase B) is stopped here.
  if [ -n "${CI_UP_PID:-}" ]; then printf '\033[2m  … waiting for the background crash-dash-ci start to finish before stopping it\033[0m\n'; wait "$CI_UP_PID" 2>/dev/null; rm -f "$CI_UP_OUT" "$CI_UP_OUT.t"; fi
  [ -n "${CI_UP_OUT:-}" ] && [ "${CI_UP_CONSUMED:-0}" != 1 ] && bash "$REPO/scripts/db.sh" down ci >>"${SHIP_LOG:-/dev/null}" 2>&1 || true
  [ -n "${CI_DOWN_PID:-}" ] && wait "$CI_DOWN_PID" 2>/dev/null
  rm -f ${CI_DOWN_OUT:+"$CI_DOWN_OUT" "$CI_DOWN_OUT.t"}
  # Background gates (§1–§4) outlive a die() otherwise, and cleanup then rm -rf's $CHECK_DIR out
  # from under a live tsc. `$!` is the SUBSHELL's pid and the scanner runs as its child, so the
  # subshell alone is not the target: kill the child first (pkill -P), then the wrapper. Verified
  # 2026-08-20 — killing only the subshell left the grandchild reparented to init and running.
  for p in ${BG_ALL_PIDS+"${BG_ALL_PIDS[@]}"}; do
    pkill -P "$p" 2>/dev/null || true
    kill "$p" 2>/dev/null || true
  done
  rm -f "$WARN_LOG" "$TIME_LOG" ${SHIP_APPLIED_MIGRATIONS:+"$SHIP_APPLIED_MIGRATIONS"} ${DRIFT_OUT:+"$DRIFT_OUT"} ${BG_ALL_OUT+"${BG_ALL_OUT[@]}"}
  for d in ${CLEAN_DIRS+"${CLEAN_DIRS[@]}"}; do
    git worktree remove --force "$d" >/dev/null 2>&1 || rm -rf "$d"
  done
  [ ${#CLEAN_DIRS[@]} -gt 0 ] && git worktree prune >/dev/null 2>&1
  [ -n "${FOLD_BRANCH:-}" ] && git branch -D -q "$FOLD_BRANCH" >/dev/null 2>&1   # §00's scratch branch, after its worktree
  # Last line on every exit path (✓, ✗, Ctrl-C) — when the run finished, in the system's local zone.
  printf '\n\033[2mfinished %s\033[0m\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
  return 0
}
trap cleanup EXIT
# …and on a signal too. A bash EXIT trap does NOT run when the shell is killed by a signal,
# so a Ctrl-C mid-run used to leave the §5 deploy worktree registered under $TMPDIR — dead
# bookkeeping that then made `wt-resolve` (make syncwt/commitwt) see two linked worktrees and
# halt as ambiguous. Clean up, disarm EXIT so cleanup does not run twice, and exit 128+signo
# so the caller still sees an interrupt.
on_signal() { cleanup; trap - EXIT; exit "$((128 + $1))"; }
trap 'on_signal 1' HUP
trap 'on_signal 2' INT
trap 'on_signal 15' TERM

# Screen-only noise. ONLY lines that carry no per-run information belong here:
#   · npm's `> pkg@ver` / `> tsx …` script preamble, echoed for every npm run.
NOISE='^> (crash-dash@|tsx |node )'

# Vitest PASS rows only — the per-file ` ✓ src/foo.test.ts (12 tests) 6ms` (~109 of them) and
# the indented slow-test rows the dot reporter appends under them. Nothing else starts with ✓:
# a failing file prints `❯ … (n tests | 1 failed)`, and the ⎯ FAILED ⎯ blocks, stack traces,
# stderr/console warnings and the final Test Files/Tests summary all survive this filter.
TEST_NOISE='^ *✓ '

# note <text> — record a ship-level warning (also printed inline, so it is never only in the recap).
note() { printf '\033[1;33m::warning:: %s\033[0m\n' "$*"; printf '[ship] %s\n' "$*" >>"$WARN_LOG"; }

# What counts as a warning worth re-printing in the end-of-run recap. Two families:
#   · `::warning::` / `::error::` — our own annotations (note(), the gate scripts).
#   · a third-party tool's own leading `Warning:`/`Error:` line — the supabase CLI emits
#     `Warning: failed to cache migrations catalog: …` (a non-fatal pg-delta side path) and
#     `db push` still exits 0, so WITHOUT this the only signal was ~20 lines that scrolled
#     past mid-chain and never reached the recap. Deliberately anchored to the leading line:
#     the `    at …` stack frames that follow stay in $SHIP_LOG instead of flooding the recap.
WARN_RE='::(warning|error)::|^(Warning|WARNING|warning|Error|ERROR|error):'

# tick <label> <seconds> — one row for the end-of-run timing recap. Every step self-times, so a
# claim about what `make ship` costs is read off the run rather than guessed at.
tick() { printf '%-10s %s\n' "$1" "$2" >>"$TIME_LOG"; }

# capture <label> <cmd...> — run a step: raw output → $SHIP_LOG, trimmed → screen, warnings
# → $WARN_LOG. Exit status is the COMMAND's, not tee's/grep's, so `|| die` still holds.
capture() {
  local label="$1"; shift
  local out rc hidden t0=$SECONDS
  out="$(mktemp)"
  "$@" 2>&1 | tee -a "$out"
  rc=${PIPESTATUS[0]}
  cat "$out" >>"$SHIP_LOG"
  grep -aE "$WARN_RE" "$out" | sed "s|^|[$label] |" >>"$WARN_LOG" || true
  rm -f "$out"
  tick "$label" "$((SECONDS - t0))s"
  return "$rc"
}

# drop_noise <regex> — `grep -avE <regex>` that does not hold a partial line hostage. grep only
# emits whole lines, and vitest's dot reporter writes its progress as ONE newline-less line
# (~110 KB of `·`), so behind grep the whole test pass showed nothing until it ended. A partial
# line made only of dot-reporter glyphs (· x - *) and ANSI SGR colour codes — under ship vitest
# colours every dot (`\e[33m\e[39m\e[32m·\e[39m`), and a glyph-only match held the line until
# the pass ended — is passed through as it arrives, tolerating an escape or UTF-8 lead byte
# split across reads; every other line is still judged whole against <regex>.
drop_noise() {
  NOISE_RE="$1" perl -e '
    $| = 1; my $re = qr/$ENV{NOISE_RE}/; my ($line, $sent) = ("", 0);
    while (sysread(STDIN, my $buf, 65536)) {
      $line .= $buf;
      while ((my $i = index($line, "\n")) >= 0) {
        my $l = substr($line, 0, $i + 1, "");
        print $sent ? substr($l, $sent) : $l if $sent || $l !~ $re;
        $sent = 0;
      }
      if ($line =~ /\A(?:\e\[[0-9;]*m|\xC2\xB7|[x*-])+(?:\e(?:\[[0-9;]*)?|\xC2)?\z/) { print substr($line, $sent); $sent = length $line }
    }
    print substr($line, $sent), "\n" if length($line) && ($sent || $line !~ $re);'
}

# Same contract as capture(), but the screen view drops $NOISE — or $QUIET_RE when the caller
# sets it for one step (e.g. QUIET_RE="$TEST_NOISE" capture_quiet tests …). Loud steps only.
capture_quiet() {
  local label="$1"; shift
  local out rc hidden noise="${QUIET_RE:-$NOISE}" t0=$SECONDS
  out="$(mktemp)"
  "$@" 2>&1 | tee -a "$out" | drop_noise "$noise"
  rc=${PIPESTATUS[0]}
  cat "$out" >>"$SHIP_LOG"
  hidden="$(grep -acE "$noise" "$out")"
  [ "${hidden:-0}" -gt 0 ] && printf '\033[2m  … %s repetitive line(s) hidden — full output in %s\033[0m\n' "$hidden" "$SHIP_LOG"
  grep -aE "$WARN_RE" "$out" | sed "s|^|[$label] |" >>"$WARN_LOG" || true
  rm -f "$out"
  tick "$label" "$((SECONDS - t0))s"
  return "$rc"
}

# ── Background gates — the independent read-only checks run DURING the test pass ──────────
# Typecheck, the notify oracle, the WAF check and the security scan share no inputs with each
# other or with vitest, yet cost ~35 s of strictly serial wall clock. They now run concurrently
# with the test pass and are COLLECTED (in a fixed order, with the same die messages) before the
# first irreversible prod step — the ordering property that actually matters is "every gate is
# green before the migrate", not "every gate ran alone".
# What this trades away: fail-fast latency. A broken typecheck no longer aborts before the tests
# spend their 34 s; it reports right after them. Nothing is skipped and no verdict is weakened.
# Output cannot interleave: a background gate writes to its own file and prints nothing until
# bg_wait renders it under its step header, so the foreground test run still streams live.
BG_ALL_PIDS=(); BG_ALL_OUT=()
declare -A BG_PID=() BG_OUT=() BG_TITLE=() BG_T0=() BG_NOISE=() BG_WHEN=()

# bg_start <label> <title> <cmd...>
bg_start() {
  local label="$1" title="$2"; shift 2
  local out; out="$(mktemp)"
  # The job times ITSELF into $out.t — a duration measured at the join would be the gate's cost
  # plus however long it then sat waiting for the test pass, which is not a number anyone can use.
  ( t0=$SECONDS; "$@"; rc=$?; printf '%s' "$((SECONDS - t0))" >"$out.t"; exit "$rc" ) >"$out" 2>&1 </dev/null &
  BG_PID[$label]=$!; BG_OUT[$label]="$out"; BG_TITLE[$label]="$title"; BG_T0[$label]=$SECONDS
  BG_ALL_PIDS+=("$!"); BG_ALL_OUT+=("$out" "$out.t")
  printf '\033[2m  ↗ running in background: %s\033[0m\n' "$title"
}

# bg_wait <label> — join the job, render its output under its step header (same trimming and
# warning harvest as capture_quiet), and return ITS exit status so `|| die` still holds.
bg_wait() {
  local label="$1" rc=0 out noise hidden
  out="${BG_OUT[$label]}"; noise="${BG_NOISE[$label]:-$NOISE}"
  # Header FIRST: a gate's output is buffered until the join, so waiting silently would make a
  # stalled scanner indistinguishable from a hang — the failure mode smoke-cron.sh's heartbeat
  # exists to prevent.
  step "${BG_TITLE[$label]} — joining"
  wait "${BG_PID[$label]}" || rc=$?
  grep -avE "$noise" "$out"
  cat "$out" >>"$SHIP_LOG"
  hidden="$(grep -acE "$noise" "$out")"
  [ "${hidden:-0}" -gt 0 ] && printf '\033[2m  … %s repetitive line(s) hidden — full output in %s\033[0m\n' "$hidden" "$SHIP_LOG"
  grep -aE "$WARN_RE" "$out" | sed "s|^|[$label] |" >>"$WARN_LOG" || true
  local ran; ran="$(cat "$out.t" 2>/dev/null)"
  rm -f "$out" "$out.t"
  tick "$label" "${ran:-$((SECONDS - BG_T0[$label]))}s (bg, ${BG_WHEN[$label]:-ran alongside the tests})"
  return "$rc"
}

# Background CI-stack teardown (§2). NOT a bg_start job: cleanup() kills those on a die, and a
# `supabase stop` killed halfway leaves the stack `partial`. This one is waited for, never killed —
# joined by warn_recap (both exit paths, so its time lands in the recap) and by cleanup as a backstop.
# Background CI-stack bring-up (§2 phase A). Same posture as ci_down: waited for, never killed — a
# `supabase start` killed halfway leaves the stack `partial`. Started right after §0b so the ~26 s
# boot overlaps phase B; joined before phase A. cleanup() tears an unconsumed stack down.
CI_UP_PID=""; CI_UP_OUT=""; CI_UP_CONSUMED=0
ci_up_start() {
  CI_UP_OUT="$(mktemp)"
  ( t0=$SECONDS; bash "$REPO/scripts/db.sh" up ci; rc=$?; printf '%s' "$((SECONDS - t0))" >"$CI_UP_OUT.t"; exit "$rc" ) >"$CI_UP_OUT" 2>&1 </dev/null &
  CI_UP_PID=$!
  printf '\033[2m  ↗ starting the crash-dash-ci stack in background\033[0m\n'
}
ci_up_join() {
  [ -n "$CI_UP_PID" ] || return 0
  local rc=0; wait "$CI_UP_PID" || rc=$?
  cat "$CI_UP_OUT" >>"$SHIP_LOG"
  tick "ci-up" "$(cat "$CI_UP_OUT.t" 2>/dev/null || echo '?')s (bg, ran alongside phase B)"
  rm -f "$CI_UP_OUT" "$CI_UP_OUT.t"; CI_UP_PID=""
  return "$rc"
}

CI_DOWN_PID=""; CI_DOWN_OUT=""
ci_down_start() {
  CI_DOWN_OUT="$(mktemp)"
  ( t0=$SECONDS; bash "$REPO/scripts/db.sh" down ci; rc=$?; printf '%s' "$((SECONDS - t0))" >"$CI_DOWN_OUT.t"; exit "$rc" ) >"$CI_DOWN_OUT" 2>&1 </dev/null &
  CI_DOWN_PID=$!
  printf '\033[2m  ↗ stopping the crash-dash-ci stack in background\033[0m\n'
}
ci_down_join() {
  [ -n "$CI_DOWN_PID" ] || return 0
  local rc=0; wait "$CI_DOWN_PID" || rc=$?; CI_DOWN_PID=""
  cat "$CI_DOWN_OUT" >>"$SHIP_LOG"
  [ "$rc" -eq 0 ] || note "background crash-dash-ci teardown exited $rc — run \`make cidown\` (output in $SHIP_LOG)"
  tick cidown "$(cat "$CI_DOWN_OUT.t" 2>/dev/null)s (bg, ran alongside the prod release)"
  rm -f "$CI_DOWN_OUT" "$CI_DOWN_OUT.t"
}

# Re-print everything harvested, last. Called on both the success and the die paths.
warn_recap() {
  ci_down_join
  if [ -s "$TIME_LOG" ]; then
    printf '\n\033[2m─── step wall-clock (total %ss; a (bg, …) row OVERLAPS the step it names) ───\033[0m\n' "$SECONDS"
    sed 's/^/  /' "$TIME_LOG"
  fi
  printf '\n\033[2mfull unfiltered log: %s\033[0m\n' "$SHIP_LOG"
  [ -s "$WARN_LOG" ] || return 0
  printf '\033[1;33m─── warnings raised during this run (%s) ───\033[0m\n' "$(wc -l <"$WARN_LOG" | tr -d ' ')"
  cat "$WARN_LOG"
  printf '\033[1;33m─────────────────────────────────────────────\033[0m\n'
}

# ── 00. Fold in-window commits — `ship` only, BEFORE the pin (§0a) ───────────────────────
# The optional pre-push commit-time policy hook is NAMED by `git config ship.pushPolicyHook` (a
# machine-local setting, kept outside this tree): `<name>` → the hook `hook.<name>.command`, or
# `none` → no policy hook, the fold and §6's recheck skip with a one-line note and the push is a
# plain one. UNSET refuses the ship before anything runs — a silently skipped fold is exactly the
# deploy-then-refused-push failure below. A set name whose `hook.<name>.command` is empty refuses
# too. The hook's script is the first `*.py` word of that command, read back rather than kept as a
# second setting, so §00 runs exactly what the hook runs. With the hook, a push is refused if it
# carries own commits dated inside the hook's push-policy window, and EVERY push is refused while
# that window is open. The hook's built-in auto-fold fires only on a plain `git push`. §6 pushes a
# pinned `<sha>:refs/heads/<branch>`, so without this step a release reached prod and then died at
# the push (2026-11-13: 58 in-window commits, prod ahead of origin). Folding here, before the pin,
# makes the folded commit the one that is verified, deployed and pushed.
#   · window open now, or within SHIP_PUSH_HORIZON_S (a ship takes 5–15 min) ⇒ NO-PUSH release
#     [USER 2026-11-13]: no fold, deploy as usual, §6 skips the push with a note, and the next
#     out-of-window `make ship` folds + pushes. Prod is ahead of origin until then — chosen over a
#     stale board (a weekday ladder ship may land in the window; its timer runs horizon 0).
#   · count, range and fold base all come from the hook itself (runpy: `work_commits` /
#     `fold_base` over its own `HEAD --not --remotes` range) — never a re-typed copy, so what is
#     folded is exactly what the hook would refuse, and a merge with no in-window commit passes;
#     a range holding merges folds along its first-parent chain (the hook's own fold).
#   · the fold runs in a scratch worktree — the fold refuses a dirty tree, and §0 promises no
#     dirty-tree gate — with node_modules symlinked in (the repo's pre-commit/commit-msg hooks
#     run `node --import tsx` on the fold's repoint commit). The branch then moves by CAS
#     (`update-ref new old`) + a two-tree `read-tree -m -u`: the folded tip's tree equals the old
#     one except for the repoint commit (sha cites in tracked files), so staged and unstaged
#     work survives, and read-tree refuses rather than clobber a dirty file the repoint touches.
POLICY_PY=""   # §00: the script hook.<ship.pushPolicyHook>.command runs
SHIP_PUSH_HORIZON_S="${SHIP_PUSH_HORIZON_S:-2700}"
SHIP_PUSH=1
POLICY_GATE=0   # 1 once §00 finds the policy hook configured AND its script present
FOLD_BRANCH=""
fold_policy_commits() {
  local branch plan rc n base old tmp new others
  branch="$(git rev-parse --abbrev-ref HEAD)"
  [ "$branch" != HEAD ] || return 0   # §0a dies on a detached HEAD
  # exit 3 = push window closed; prints "<in-window count> <fold base|root|->".
  plan="$(python3 -I - "$POLICY_PY" "$SHIP_PUSH_HORIZON_S" <<'PY'
import runpy, sys
m = runpy.run_path(sys.argv[1])
t = m["now"]()
if m["is_work"](t) or m["is_work"](t + int(sys.argv[2])):
    sys.exit(3)
rng = ["HEAD", "--not", "--remotes"]
w = m["work_commits"](rng)
print(len(w), m["fold_base"](rng) if w else "-")
PY
)"; rc=$?
  if [ "$rc" = 3 ]; then
    SHIP_PUSH=0
    note "the hook's push-policy window is open now or opens within $((SHIP_PUSH_HORIZON_S / 60)) min: the $POLICY_HOOK guard refuses every push — deploying WITHOUT a push; the next out-of-window \`make ship\` folds + pushes."
    return 0
  fi
  [ "$rc" = 0 ] || die "push-policy plan failed (exit $rc) — see the python error above; nothing was run."
  read -r n base <<<"$plan"
  [ "$n" = 0 ] && return 0
  step "Fold $n in-window commit(s) on $branch (the hook never auto-folds §6's pinned-sha push)"
  old="$(git rev-parse HEAD)"
  # Other local branches built on commits the fold rewrites — a later rebase replays the old ones.
  others="$(git for-each-ref --format='%(refname:short)' --contains "$(git rev-list --reverse HEAD --not --remotes | head -n1)" refs/heads | grep -vxF "$branch" | paste -sd' ')"
  [ -n "$others" ] && note "fold rewrites commits that local branch(es) $others are built on — rebase them onto the folded $branch, or their next push re-carries the unfolded in-window commits."
  tmp="$(mktemp -d -t crash-dash-fold-XXXXXX)"
  CLEAN_DIRS+=("$tmp/wt" "$tmp")
  FOLD_BRANCH="ship-fold-$$"
  git worktree add -q -b "$FOLD_BRANCH" "$tmp/wt" "$old" || die "could not create the fold worktree at $tmp/wt"
  [ -d "$REPO/node_modules" ] && ln -s "$REPO/node_modules" "$tmp/wt/node_modules"
  capture fold sh -c 'cd "$1" && python3 -I "$2" fold --base "$3"' _ "$tmp/wt" "$POLICY_PY" "$base" \
    || die "fold failed — $branch untouched (still ${old:0:10}); see above. If it got as far as 'repointed', memory files + secrets/sha-map.json now cite the discarded fold."
  new="$(git rev-parse "$FOLD_BRANCH")"
  git worktree remove --force "$tmp/wt" && git branch -D -q "$FOLD_BRANCH" && FOLD_BRANCH=""
  git update-ref -m "ship: fold in-window commits" "refs/heads/$branch" "$new" "$old" \
    || die "$branch moved during the fold — not re-pointing it. Re-run \`make ship\` (memory files + secrets/sha-map.json now cite the discarded fold ${new:0:10})."
  if ! git read-tree -m -u "$old" "$new"; then
    git update-ref "refs/heads/$branch" "$old" "$new" \
      || die "folded to ${new:0:10}; read-tree failed (see its error above) AND rolling $branch back to ${old:0:10} failed — $branch is at $(git rev-parse --short "$branch"); check \`git status\` and \`git reflog $branch\` before anything else."
    die "folded to ${new:0:10}, but read-tree refused the checkout (see its error above — usually a dirty file the fold's repoint commit rewrites) — $branch left at ${old:0:10}; fix that and re-run (memory files + secrets/sha-map.json now cite the discarded fold)."
  fi
  echo "[ship] $branch folded: ${old:0:10} → ${new:0:10}"
}
POLICY_HOOK=""   # §00: the hook name `git config ship.pushPolicyHook` gives (`none` = no policy hook)
if [ "$MODE" = ship ]; then
  POLICY_HOOK="$(git config --get ship.pushPolicyHook)" \
    || die "git config ship.pushPolicyHook is unset or unreadable — name the pre-push commit-time policy hook (\`git config --global ship.pushPolicyHook <hook name>\`), or set it to \`none\` when no such hook is wired; nothing was run."
  [ -n "$POLICY_HOOK" ] || die "git config ship.pushPolicyHook is empty — set it to the policy hook's name, or to \`none\`; nothing was run."
  if [ "$POLICY_HOOK" = none ]; then
    echo "[ship] ship.pushPolicyHook=none — no pre-push commit-time policy hook; skipping the in-window fold."
  else
    hook_cmd="$(git config --get "hook.$POLICY_HOOK.command")" || hook_cmd=""
    [ -n "$hook_cmd" ] || die "ship.pushPolicyHook names hook '$POLICY_HOOK', but git config has no hook.$POLICY_HOOK.command — fix the name, or set it to \`none\`; nothing was run."
    # The script the hook's command runs: its first `*.py` word, a leading `~` expanded as the hook's shell would.
    read -ra hook_words <<<"$hook_cmd"
    for w in "${hook_words[@]}"; do
      case "$w" in *.py) POLICY_PY="${w/#\~/$HOME}"; break ;; esac
    done
    [ -n "$POLICY_PY" ] || die "hook.$POLICY_HOOK.command ($hook_cmd) names no *.py script — §00 calls that script's functions directly; nothing was run."
    # Wired but its script gone ⇒ the hook itself fails §6's push AFTER the deploy — refuse now.
    [ -f "$POLICY_PY" ] || die "git config wires the hook.$POLICY_HOOK policy hook but its script $POLICY_PY is missing — §6's push would fail after the deploy; nothing was run."
    POLICY_GATE=1
    fold_policy_commits
  fi
fi

# ── What will this push change? origin/main..HEAD ∪ working tree (superset). ───────────
# If origin/main is unknown (never fetched / detached), CHANGED stays empty and every
# conditional below treats that as "run it" — we never silently skip a needed gate.
CHANGED=""
if git rev-parse --verify -q origin/main >/dev/null; then
  CHANGED="$(git diff --name-only origin/main..HEAD; git status --porcelain | awk '{print $2}')"
else
  echo "[ship] origin/main not found locally — running ALL heavy steps (safe superset)."
fi
touches() { [ -z "$CHANGED" ] && return 0; printf '%s\n' "$CHANGED" | grep -qE "$1"; }

INTEGRATION_NEEDED=false; touches '^(src/store|supabase/migrations/)' && INTEGRATION_NEEDED=true
MIGRATIONS_NEEDED=false;  touches '^supabase/migrations/'            && MIGRATIONS_NEEDED=true

# `ship` deploys to prod, so its pre-deploy gate is the FULL suite: force the DB-backed
# integration half on regardless of what changed (a deploy ships api/ + run-loop (`src/run-*.ts`) code that
# hits the DB even when src/store* itself is untouched). `verify` stays path-conditional.
[ "$MODE" = "ship" ] && INTEGRATION_NEEDED=true

echo "[ship] mode=$MODE  integration=$INTEGRATION_NEEDED  migrations=$MIGRATIONS_NEEDED"

# ── 0a. Pin the commit under release — ONE resolution of HEAD, reused end to end ─────────
# Every later step (§0b's check tree, §5's deploy payload, §6's push) refers to $SHIP_SHA,
# never to the moving `HEAD`. Parallel sessions commit to `main` in this same repo, so HEAD
# is not stable across a run that takes minutes: on 2026-08-02 a sibling session committed
# between the checks and the deploy, and prod ended up serving a commit the suite had never
# seen. Pinning makes "what was verified == what was deployed == what was pushed" a property
# of the chain rather than a race it happens to win.
SHIP_SHA="$(git rev-parse HEAD)"
SHIP_SHA_SHORT="$(git rev-parse --short HEAD)"
SHIP_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$MODE" = "ship" ] && [ "$SHIP_BRANCH" = "HEAD" ] && \
  die "detached HEAD — \`ship\` pushes $SHIP_SHA_SHORT to a named branch; check one out first."

# ── 0. Tree state — REPORTED; `ship` gates only the live-tree prod scripts ───────────────
# No general clean-tree requirement: the checks below don't read the tree (§0b) and the
# deploy payload is a HEAD checkout (§5). Blocking on other edits would only force a pointless stash
# mid-development. This is purely a heads-up that what you are looking at in the editor is
# NOT what was verified; it lands in the end-of-run recap, where it can't scroll past.
DIRTY_N="$(git status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
[ "$DIRTY_N" != "0" ] && note "$DIRTY_N uncommitted tracked file(s) — NOT verified by this run (payload is $SHIP_SHA_SHORT; commit them to include them)."
# §5 runs these from the live tree against prod — `ship` refuses uncommitted or untracked edits to them.
LIVE_PROD_DIRTY="$(git status --porcelain -- scripts/migrate-prod-local.sh scripts/publish-calibration-prod.sh scripts/smoke-cron.sh supabase/migrations)" \
  || die "git status failed — nothing was deployed."
[ "$MODE" = ship ] && [ -n "$LIVE_PROD_DIRTY" ] && \
  die "uncommitted prod-path edits (§5 runs them from the live tree, not $SHIP_SHA_SHORT) — commit or stash them; nothing was deployed:
$LIVE_PROD_DIRTY"

# ── 0b. Materialize HEAD — every check below runs THERE, never in the live tree ──────────
# `git archive` (not a worktree): no .git, no worktree bookkeeping, and nothing to leak if
# this run is killed — teardown is the rm -rf already in cleanup().
#
# Why at all: what ships is HEAD, so HEAD is what must be green. Checking the live tree got
# it wrong in both directions — a half-finished local edit (or a PARALLEL SESSION's WIP in
# this same repo) failed a run whose payload was fine, and a tree-only fix could green-light
# a HEAD that was broken. `verify` gets the same treatment: it gates the commit you are about
# to ship, and "it passes on my machine because of an unsaved-elsewhere edit" is the same bug.
#
# The one deliberate exception: ci-stack.sh (§2) symlinks $REPO/supabase/migrations into the
# disposable DB stack, and pointing that at a temp dir would leave the stack holding a dangling
# symlink after cleanup. It is NOT cwd that protects this — since §2 delegates to db.sh through
# in_head, ci-stack.sh actually runs with cwd=$CHECK_DIR — but path resolution: both db.sh and
# ci-stack.sh resolve their own $REPO from $BASH_SOURCE, so the symlink target is the real repo
# regardless of cwd. Only matters if you run with an UNCOMMITTED migration — the §0 dirty note
# is the warning for that case.
step "Materialize $SHIP_SHA_SHORT — all checks run against the commit, not the tree"
CHECK_DIR="$(mktemp -d -t crash-dash-head-XXXXXX)"
CLEAN_DIRS+=("$CHECK_DIR")
git archive "$SHIP_SHA" | tar -x -C "$CHECK_DIR" || die "could not materialize $SHIP_SHA_SHORT into $CHECK_DIR"
# Gitignored inputs a fresh checkout of HEAD has none of. SYMLINKED, never copied, so the
# check tree cannot drift from the repo's installed deps/creds. node_modules is the live
# tree's install, so a HEAD that bumps package-lock.json is checked against the previous
# install — the one hermeticity gap here, and exactly what CI's clean-room `check` covers
# on the resulting push.
for f in node_modules .env .env.local; do
  [ -e "$REPO/$f" ] && ln -sfn "$REPO/$f" "$CHECK_DIR/$f"
done
# No prod config here: the npm probes §5c runs (`probe:vintage-drift --env=prod`) load it through
# scripts/with-prod-config.sh from the PROD_CONFIG_DIR exported above.
echo "[ship] checks run in $CHECK_DIR ($SHIP_SHA_SHORT)"
$INTEGRATION_NEEDED && ci_up_start

# in_head <cmd...> — run a check against the HEAD copy. Subshell cd, so $REPO stays the cwd
# for everything else (ci-stack.sh, migrate, deploy, push).
in_head() { ( cd "$CHECK_DIR" && exec "$@" ); }

# Binaries straight out of the symlinked node_modules: `npx` re-resolves the package tree on
# every call (0.32 s vs 0.06 s, measured 2026-08-20) and the chain makes several.
BIN="$CHECK_DIR/node_modules/.bin"
{ [ -x "$BIN/tsc" ] && [ -x "$BIN/vitest" ] && [ -x "$BIN/eslint" ] && [ -x "$BIN/tsx" ]; } || die "no tsc/vitest/eslint/tsx under $BIN — §0b symlinks the repo's node_modules into the check tree, so this means the repo itself has no install; run \`npm ci\` in $REPO."

# ── 1. Typecheck — BACKGROUND, joined at §4 ────────────────────────────────────────────
# --incremental against a buildinfo cached OUTSIDE the per-run check tree: 8.1 s → 2.0 s
# (measured 2026-08-20, cold vs warm across two fresh archive dirs). Seeding it survives the
# mktemp dir because the file records paths RELATIVE to its own location and file CONTENT
# hashes — both invariant across runs — so a changed file re-checks on content, never mtime.
# Written back only on a GREEN run (§4): a buildinfo from a failing pass would carry the
# errors forward as settled knowledge.
TSBI_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/crash-dash/ship.tsbuildinfo"
cp "$TSBI_CACHE" "$CHECK_DIR/.tsbuildinfo" 2>/dev/null || true
bg_start typecheck "Typecheck (tsc --noEmit, incremental)" \
  in_head "$BIN/tsc" --noEmit --incremental --tsBuildInfoFile .tsbuildinfo

# ── 1b. Type-aware ESLint (the `lint:ts` half of `npm run check`) — BACKGROUND, joined at §4 ──
# Plain `eslint`, never `--prune-suppressions` / `--pass-on-unpruned-suppressions`: a suppression in
# `eslint-suppressions.json` that no longer matches a violation is a stale baseline and FAILS the ship —
# `npm run lint:ts:prune` is the fix, run by whoever removed the violation.
bg_start eslint "ESLint (type-aware, eslint-suppressions.json baseline, stale suppressions fail)" \
  in_head "$BIN/eslint"

# ── 3. Notify-band oracle (dry — never POSTs) — BACKGROUND, joined at §4 ─────────────────
# `--quiet` (the `npm run check` mode): one line per scenario — band, dial, rung, overlay, push.
# Every assertion still runs; only the per-scenario ntfy body transcript is dropped. The full
# body for one world stays one command away: `npm run sim:notify -- <key>`.
bg_start oracle "Notify-band oracle (sim:notify -- all --quiet, dry)" \
  in_head npm run sim:notify -- all --quiet

# The two prod-facing read-only gates, ship-only as before (`verify` has never run them).
# They used to sit BELOW the tests and above the migrate, serial; they are now launched here
# and joined at §4 — still, and this is the load-bearing half, before the first irreversible
# prod mutation.
if [ "$MODE" = "ship" ]; then
  bg_start waf "WAF rate-limit rule (check the limiter is live on prod)" \
    bash "$REPO/scripts/apply-waf-rules.sh" --check
  # SCAN_SEC_REV pins the secret scan to the RELEASE sha (§0a), not to a branch tip that may
  # have moved past it.
  bg_start scansec "Security scan (gitleaks · osv-scanner · zizmor — fast trio)" \
    env SCAN_SEC_REV="$SHIP_SHA" bash "$REPO/scripts/scan-sec.sh"
fi

# ── 2. Vitest — ONCE. DB-armed iff store/migrations changed (covers unit+integration). ──
# This pass is the ONLY local gate on vitest.config.ts's coverage thresholds — `npm run check` runs
# uninstrumented. Never drop $COV from either arm below.
# The json reporter feeds cov_gaps: on a red threshold it names the uncovered lines per failing
# file, so the fix needs no diagnostic re-run (text-summary alone prints only percentages).
COV="--coverage --coverage.reporter=text-summary --coverage.reporter=json"
# Appended to $WARN_LOG (and $SHIP_LOG) so die's warn recap carries it, not just the scrolled-off screen.
cov_gaps() {
  local gaps
  gaps="$(in_head "$BIN/tsx" "$REPO/scripts/coverage-gaps.ts" coverage/coverage-final.json <"$WARN_LOG" 2>&1)" || true
  [ -n "$gaps" ] && printf '%s\n' "$gaps" | tee -a "$SHIP_LOG" >>"$WARN_LOG"
  return 0
}
export SHIP_LANE=1 # arms the subprocess tests the unit lane skips (api/security-waf.test.ts)
if $INTEGRATION_NEEDED; then
  step "Tests — phase B: the whole suite UNARMED (DB files excluded), parallel, coverage"
  # Stack lifecycle is DELEGATED to scripts/db.sh — the one front door for the default-DOWN
  # posture. It brings crash-dash-ci up if down, CYCLES it if half-up, asserts all 3 containers
  # are healthy before running, arms SUPABASE_URL/SERVICE_KEY/DB_TESTS (capture-then-eval, with
  # an explicit DB_TESTS=1 assertion so this gate can never pass green as unit-only), and ALWAYS
  # tears the stack down — however it was found, including one held open via `scripts/db.sh up ci`.
  #
  # This was hand-rolled here until it drifted: the local copy probed only the DB container, so
  # a half-up stack (Postgres alive, PostgREST dead) read as UP, went unrepaired, and the
  # pre-prod integration gate ran against a dead REST API. db.sh grew the three-state repair in
  # an earlier commit; duplicating that logic is what produced the divergence, so every LOCAL entry point
  # (here, run-integration-tests.sh, the wrapped npm scripts, the Makefile) now shares one copy.
  # integration.yml's self-hosted job goes through the same single `db.sh with ci` call.
  #
  # Two phases partition the suite (2026-10-08, 98 s serial → ~30 s): B = everything but the
  # `runIf(hasDb)` files, unarmed, parallel, $COV (the coverage gate); A = those files alone,
  # DB-armed, serial, on the stack §0b started in the background. The file list is
  # scripts/db-test-files.sh, shared with run-integration-tests.sh.
  #
  # in_head puts vitest's cwd in $CHECK_DIR (HEAD, not the tree). db.sh and ci-stack.sh both
  # resolve their own $REPO from $BASH_SOURCE, so ci-stack.sh still symlinks the REAL
  # supabase/migrations — see §0b, where that exception is now stated as a path-resolution
  # property rather than a cwd one. The cwd move does add one coupling: ci-stack.sh's
  # `npx --no-install supabase` resolves the binary by walking up from cwd, which is now a
  # /tmp dir, so it depends on §0b symlinking node_modules into $CHECK_DIR. Failure is loud
  # (--no-install errors rather than silently downloading a different CLI version).
  #
  # --reporter=dot + $TEST_NOISE: vitest's dot reporter STILL emits a ` ✓ <file> (n tests)` row
  # per file (~109 of them), so the filter drops those pass rows. Failures, console warnings and
  # the final summary all print in full, and the raw run is in $SHIP_LOG.
  #
  # SHIP_KEEP_CI=1 hands db.sh DB_WITH_KEEP=1, which holds the stack up after the pass so the
  # NEXT release skips a 26 s start + 13 s stop (measured 2026-08-20). Opt-in, because
  # default-DOWN is the posture that keeps an orphaned stack from becoming permanent — and it
  # still does: any un-flagged `db.sh with` reclaims a held stack, as does `make cidown`.
  #
  # db.sh is ALWAYS told to keep the stack; ship.sh does the teardown itself so the 13 s stop can
  # run in the background, off the critical path — nothing after this step touches the CI stack.
  # A red pass stops it in the foreground before dying (die → cleanup would otherwise race it),
  # and an interrupted pass is still torn down by db.sh itself (its INT/TERM trap ignores KEEP).
  mapfile -t DB_FILES < <(in_head bash scripts/db-test-files.sh)
  [ "${#DB_FILES[@]}" -gt 0 ] || die "scripts/db-test-files.sh returned no runIf(hasDb) files — the grep rotted; phase A would be empty"
  EXCLUDE="$(IFS=,; echo "${DB_FILES[*]}")"
  QUIET_RE="$TEST_NOISE" capture_quiet tests \
    in_head env INTEG_EXCLUDE="$EXCLUDE" "$BIN/vitest" run $COV --reporter=dot --silent \
    || { cov_gaps; die "tests failed (phase B, unarmed)"; }
  step "Tests — phase A: ${#DB_FILES[@]} DB-armed file(s), serial against the crash-dash-ci stack"
  ci_up_join || die "crash-dash-ci stack failed to start — its output is in $SHIP_LOG"
  CI_UP_CONSUMED=1
  tests_rc=0
  QUIET_RE="$TEST_NOISE" capture_quiet tests-db \
    in_head env DB_WITH_KEEP=1 bash "$REPO/scripts/db.sh" with ci -- env INTEG_EXCLUDE= "$BIN/vitest" run "${DB_FILES[@]}" --reporter=dot --silent=true \
    || tests_rc=$?
  if [ "${SHIP_KEEP_CI:-0}" != 1 ]; then
    if [ "$tests_rc" -ne 0 ]; then bash "$REPO/scripts/db.sh" down ci >>"$SHIP_LOG" 2>&1 || true
    else ci_down_start; fi
  fi
  [ "$tests_rc" -eq 0 ] || die "tests failed (phase A, DB-armed)"
else
  step "Tests (unit — integration half self-skips without DB creds)"
  QUIET_RE="$TEST_NOISE" capture_quiet tests in_head "$BIN/vitest" run $COV --reporter=dot --silent || { cov_gaps; die "tests failed (unit)"; }
fi

# ── 4. Join the background gates — fixed order, unchanged verdicts, all before any mutation ──
bg_wait typecheck || die "typecheck failed"
# Only now, on green: publish the buildinfo for the next run.
if [ -s "$CHECK_DIR/.tsbuildinfo" ]; then
  mkdir -p "$(dirname "$TSBI_CACHE")" &&
    cp "$CHECK_DIR/.tsbuildinfo" "$TSBI_CACHE.$$" &&
    mv "$TSBI_CACHE.$$" "$TSBI_CACHE" || rm -f "$TSBI_CACHE.$$"
fi

bg_wait eslint || die "eslint failed (a violation, or a stale row in eslint-suppressions.json — \`npm run lint:ts:prune\` after the fix)"

bg_wait oracle || die "notify-band oracle mismatch"

# Same lint the pre-push hook runs — here it blocks before migrate/deploy, not after.
git diff -U0 -M --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/ "origin/main...$SHIP_SHA" -- src api scripts public \
  | (cd "$REPO" && "$BIN/tsx" scripts/check-ruling-ids.ts) || die "net-new plan-local ruling IDs in code prose (see above)"

# Same strict clone-group gate `npm run check` runs — `ACCEPTED` in scripts/lint-ladder-reads.ts is its single owner.
(cd "$REPO" && "$BIN/tsx" scripts/lint-ladder-reads.ts --strict >/dev/null) || die "ladder-reads clone groups changed — share the form or update ACCEPTED in scripts/lint-ladder-reads.ts"

# Same stale-literal gate `npm run check` runs — a line naming a backfill-depth constant beside a year-numeral.
(cd "$REPO" && "$BIN/tsx" scripts/lint-backfill-years.ts) || die "a line restates a backfill-depth constant's value (see above) — cite the constant"

if [ "$MODE" = "verify" ]; then
  printf '\n\033[1;32m✓ verify passed — nothing pushed.\033[0m\n'
  warn_recap
  exit 0
fi

# ── Pre-deploy gate ──────────────────────────────────────────────────────────────────────
# Every check above die's on failure, so reaching this line means the FULL suite (typecheck,
# ESLint, unit+integration vitest, notify oracle) is green. Nothing below
# — the irreversible prod migrate + deploy — runs unless we get here.
printf '\n\033[1;32m✓ all checks green — proceeding to prod release (migrate → publish-calibration → deploy → vintage-drift gate → push → cron re-derive).\033[0m\n'

# ── 5. Prod release, from here (never bills CI) — migrate (schema first) then deploy ──────
# Migrate runs before deploy whenever its inputs changed SINCE THE LAST SUCCESSFUL MIGRATE — a
# stamp (SYNC_CACHE/migrated-sha), not origin/main..HEAD, so a migration pushed outside `make ship`
# (e.g. from the host) is still inside the diffed range and still applied. The unchanged case —
# an idempotent link + db push no-op — is skipped (~12 s). No stamp, a stamp that is not an
# ancestor of $SHIP_SHA, or an uncommitted migration in the tree ($MIGRATIONS_NEEDED) ⇒ it runs.
# What this trades away: prod drift that did NOT come from the repo (a hand-applied or reverted
# migration, a reset DB) is no longer re-checked every release — `SHIP_FORCE_SYNC=1` forces both
# this step and §5b's publish.
# WAF rate-limit rule — READ-ONLY check, launched at §1 and JOINED below, still ahead of the
# migrate: a gate that can abort the release must resolve before the first irreversible prod
# mutation. Never staged or published unattended — publishing is USER-GATED (`apply-waf-rules.sh --confirm-publish`), and a
# repeated `rules add` would pile up drafts and blow the Hobby 1-rate-limit-rule cap.
# Imprint completeness — READ-ONLY, and it sits BESIDE the WAF check for the same reason: a gate
# that can abort the release must run before the first irreversible prod mutation. `imprint.html`
# ships with `OPERATOR TODO` sentinels standing in for the operator's legal name and email;
# deploying it unfilled would publish a legally-required
# page with blanks. This is a SHIP gate rather than a unit-test pin on purpose — a pin that is red
# by design would commit a red suite and poison bisect. Greps the HEAD copy, not the live tree.
step "Imprint completeness (no unfilled OPERATOR TODO in public/imprint.html)"
# Existence guard FIRST: `grep -q` on a missing file exits 2, the `if` is false, and this
# launch-blocking gate silently PASSES — so a renamed/deleted imprint must die here, not void it.
in_head test -f public/imprint.html || die "public/imprint.html is MISSING from the release — the launch-required imprint (e-Commerce Dir. Art. 5 / EE InfoTS §4) cannot be verified; restore it, then re-ship."
if in_head grep -q 'OPERATOR TODO' public/imprint.html; then
  die "public/imprint.html still carries an OPERATOR TODO placeholder — fill the operator's legal name and email (the imprint fields this site publishes), then re-ship."
fi

# The two prod-facing gates LAUNCHED at §1 are joined here — the last thing before the first
# irreversible prod mutation, which is where their verdict has to land. Running them during the
# test pass changes when they execute, never what they decide.
waf_rc=0
bg_wait waf || waf_rc=$?
# The script separates "absent" (1) from "could not tell" (2); collapsing them here would tell
# the operator to publish when the real fault is a login/link/CLI failure.
case "$waf_rc" in
  0) ;;
  1) die "WAF rate-limit rule is NOT live — publish it with \`bash scripts/apply-waf-rules.sh --confirm-publish\` (USER-GATED), then re-ship." ;;
  # 3 = the rule IS live but its path set has drifted from waf-rules.json. Publishing is NOT the
  # remedy (Hobby returns 401 'Rate limiting is not available for this plan' on `rules add`), so
  # this must not fall into the arm above — the ::error:: lines already name the real options.
  3) die "WAF rate-limit rule path set has DRIFTED from scripts/waf-rules.json — see the ::error:: lines above for why \`--confirm-publish\` will NOT fix it and for the owed decision." ;;
  *) die "WAF rate-limit rule state could NOT be determined (see the ::error:: above) — publishing is NOT the fix; resolve the vercel link/login, then re-ship." ;;
esac

# Security scan — READ-ONLY. The FAST trio only (gitleaks-git · osv-scanner · zizmor); the ~40 s
# semgrep 9-pack is `make scan-sec-full`, manual. gitleaks scans the commits since its last green
# sha rather than all of history, and skips any data-only `backups` ref (such as a separate backup
# repo's, if one is fetched here). scan-sec.sh §1 states the cache-voiding conditions and why that
# ref is subtracted.
# Fails closed — a scanner that cannot RUN blocks the ship, same doctrine as pre-push.
bg_wait scansec || die "security scan FAILED — the reason is in the ✗ line above; nothing has been mutated on prod yet. Fix it and re-ship (\`npm run scan:sec\` reproduces this step alone)."

# Stage 7 (vintage drift): the migrate step records the migrations it just applies into this
# manifest, so the §5c detector can honour their `-- restate: <id,…>` decree headers
# (drift-by-decree). mktemp pre-creates it EMPTY — a migrate path that writes nothing still
# hands the detector "nothing to add", never the missing-manifest WARN. Removed by cleanup().
SHIP_APPLIED_MIGRATIONS="$(mktemp -t crash-dash-ship-applied-XXXXXX)"
export SHIP_APPLIED_MIGRATIONS

# Deploy the COMMIT, not the tree. `vercel deploy` uploads its cwd, so pointing it at a
# detached-HEAD worktree is what makes "live == repo" a property of the chain instead of a
# warning about it: the payload is exactly the commit pushed in §6 — the same commit §0b
# just verified — with no local-only file (editor scratch, a half-finished edit, a stale
# build artifact) able to reach prod. There is no dirty-tree gate anywhere in this chain;
# HEAD-materialization on both ends is what makes one unnecessary.
#
# This is a SECOND, separate checkout from §0b's, deliberately: §0b symlinks .env.local in for
# the tests and probes, and this tree is uploaded to Vercel. Sharing one would put those creds on
# the payload path. (Neither tree holds the prod config: it stays at $PROD_CONFIG_DIR.)
#
# The worktree is checked out at $SHIP_SHA (§0a), NOT at `HEAD`: a sibling session committing
# to this same branch mid-run would otherwise slip an unverified commit into the payload.
prep_payload() {
  git worktree add --detach --quiet "$DEPLOY_DIR" "$SHIP_SHA" || { echo "::error:: could not create $SHIP_SHA_SHORT worktree at $DEPLOY_DIR"; return 1; }

  # E1 remedy: bundle the DEPLOY WORKTREE's per-page module graph into one `<page>.bundle.js` (first
  # paint = 1 JS request, not the whole static graph). Same posture as the minify step below — mutates
  # the deploy worktree only, never the repo tree; any esbuild failure aborts the release.
  npm run --silent bundle:public -- "$DEPLOY_DIR" || { echo "::error:: public/ bundle failed — refusing to deploy a partially-bundled payload"; return 1; }

  # Rung 8 (P-3): minify the DEPLOY WORKTREE's public/*.js before it is uploaded. The repo working
  # tree is never touched — `public/*.js` stays exactly what is authored and what dev serves, and only
  # the deployed copy is minified (per-file transform; the bundle step above already collapsed the graph).
  # ⚠ This step lives HERE and not in deploy-prod-local.sh on purpose: the only mutation that script
  # owns is the config stamp (after this step, refusing the checkout as its tree). Accepted
  # consequence — a break-glass `deploy-prod-local.sh` run against a hand-made tree ships UNMINIFIED.
  npm run --silent minify:public -- "$DEPLOY_DIR" || { echo "::error:: public/ minify failed — refusing to deploy a partially-minified payload"; return 1; }
}

# Payload prep (checkout → bundle → minify) touches no prod state, so it runs in the background
# while the migrate + publish below talk to prod, and is joined just before the deploy. A failure
# still dies before the deploy; a die elsewhere kills it and cleanup removes the worktree.
DEPLOY_PARENT="$(mktemp -d -t crash-dash-ship-XXXXXX)"
DEPLOY_DIR="$DEPLOY_PARENT/head"
CLEAN_DIRS+=("$DEPLOY_DIR" "$DEPLOY_PARENT")   # child first — the parent is a plain rm -rf

# Did the branch move under us while the checks ran? Harmless now — every step below is
# pinned — but the operator must know the newer commits are NOT in this release.
NOW_SHA="$(git rev-parse HEAD)"
[ "$NOW_SHA" != "$SHIP_SHA" ] && note "$SHIP_BRANCH moved during this run ($SHIP_SHA_SHORT → $(git rev-parse --short "$NOW_SHA")) — this release deploys and pushes the VERIFIED $SHIP_SHA_SHORT only; the newer commit(s) ship on the next run."

BG_WHEN[payload]="ran alongside migrate + publish"
bg_start payload "Deploy payload — checkout $SHIP_SHA_SHORT to a clean worktree, bundle + minify public/" prep_payload

# changed_since <stamp> <pathspec…> — true (run the step) unless <stamp> names an ancestor of
# $SHIP_SHA and nothing under <pathspec> differs between the two. Missing/unreadable ⇒ run.
SYNC_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/crash-dash"
changed_since() {
  local sha; sha="$(cat "$SYNC_CACHE/$1" 2>/dev/null)" && [ -n "$sha" ] || return 0; shift
  git merge-base --is-ancestor "$sha" "$SHIP_SHA" 2>/dev/null || return 0
  ! git diff --quiet "$sha" "$SHIP_SHA" -- "$@"
}
stamp_sync() { mkdir -p "$SYNC_CACHE" && printf '%s\n' "$SHIP_SHA" >"$SYNC_CACHE/$1.$$" && mv "$SYNC_CACHE/$1.$$" "$SYNC_CACHE/$1"; }

if [ "${SHIP_FORCE_SYNC:-0}" = 1 ] || $MIGRATIONS_NEEDED || changed_since migrated-sha supabase/migrations/ scripts/migrate-prod-local.sh; then
  step "Migrate prod (local) — apply any pending migrations (no-op if up to date)"
  capture migrate bash "$REPO/scripts/migrate-prod-local.sh" || die "prod migration failed"
  stamp_sync migrated-sha
else
  step "Migrate prod — SKIPPED: no migration change since the last successful migrate ($(cut -c1-8 "$SYNC_CACHE/migrated-sha")); SHIP_FORCE_SYNC=1 forces it"
fi

# ── 5b. Publish the committed calibration vintage — BEFORE the deploy ─────────────────────
# ⚠ **`make ship` PUBLISHES calibration** (ship.sh §5b) — needs the prod config's `.env.prod`. Its content key includes
# `ci_low`/`ci_high`, so a pure-RNG regen rewrites ~109 prod rows: the key does NOT mean "cuts moved".
# Same "dependency first" rule as the migrate above: calibration.json's cut-points are data
# the deployed code reads, so they land before the code that reads them, not after. Until
# this step existed, prod calibration moved only on a manual `gh workflow run backtest.yml`
# dispatch, so a committed vintage could lag the release indefinitely. Idempotent by CONTENT, not by stamp — publish-calibration.ts compares the file's
# params against prod's collapsed rows and skips only when every one already matches, so an
# unchanged-calibration ship is a cheap no-op that DID compare (the wrapper fails the step if
# no verdict line was printed). Fails the chain BEFORE the irreversible deploy.
# One non-fatal outcome: `::warning:: stale` — prod carries a NEWER vintage than the repo
# (a CI harness run), which this step refuses to revert; it lands in the end-of-run recap.
# PUBLISH_TREE=$CHECK_DIR: publish the COMMIT's calibration.json (§0b's HEAD archive, which
# already has node_modules symlinked in; the creds come from $PROD_CONFIG_DIR), never the live tree's — same rule as
# every check above and as the §5 deploy payload.
# Skipped (~7 s) by the same since-last-success stamp as the migrate. What that trades away: the
# `::warning:: stale` report (prod holds a NEWER vintage than the repo) now surfaces only on a
# release that publishes. Migrations are in the pathspec because they can reshape the table.
if [ "${SHIP_FORCE_SYNC:-0}" = 1 ] || changed_since published-sha scripts/backtest/calibration.json \
     scripts/backtest/publish-calibration.ts scripts/publish-calibration-prod.sh supabase/migrations/; then
  step "Publish calibration (local) — write scripts/backtest/calibration.json to prod (skips if already published)"
  capture publish env PUBLISH_TREE="$CHECK_DIR" bash "$REPO/scripts/publish-calibration-prod.sh" \
    || die "calibration publish failed"
  stamp_sync published-sha
else
  step "Publish calibration — SKIPPED: calibration unchanged since the last successful publish ($(cut -c1-8 "$SYNC_CACHE/published-sha")); SHIP_FORCE_SYNC=1 forces it"
fi

# The payload launched before the migrate (prep_payload) must be complete before the upload.
bg_wait payload || die "deploy payload prep failed (checkout/bundle/minify — see the ::error:: above); prod schema/calibration may have moved, the code did not."

step "Deploy prod (local) — vercel deploy --prod (payload = $SHIP_SHA_SHORT)"
capture deploy bash "$REPO/scripts/deploy-prod-local.sh" "$DEPLOY_DIR" || die "prod deploy failed"

# ── 5b. Prod smoke gate — BLOCKING, and deliberately BEFORE the push. ──────────────────
# This replaces the standing manual "eyeball all four pages after a deploy" step: the probe
# asserts each page serves 200 with its security headers AND that its module graph loads, which
# is the failure a healthy 200 hides (a CSP slip darks the page, not the response).
#
# Ordering is the point. Before the push, a broken prod aborts the RELEASE — origin never gets a
# sha prod cannot serve. After the push it would only report a mess that is already published.
# The probe separates "could not reach prod" (infra) from "prod is broken" (this deploy); both
# stop the run, and the message says which — read it before assuming the deploy is at fault.
step "Prod smoke gate (4 pages + their module graphs, against the live alias)"
capture smoke in_head npm run probe:prod-smoke \
  || die "prod smoke FAILED — prod is serving $SHIP_SHA_SHORT but did not pass; NOT pushing. See the probe's UNREACHABLE-vs-BROKEN line above."

# ── 5c. Scorer-vintage drift gate — AFTER the deploy, BEFORE the push. ────────────────────
# Placement is the point (rulings 1 + 4b):
#   · AFTER the deploy, so the auto-restate below re-scores under exactly the prod code +
#     schema this release just made live — a pre-deploy restate would rebuild history under
#     the OLD scorers and be re-owed immediately;
#   · BEFORE the push, so a failed or un-restatable drift aborts the RELEASE — origin never
#     gets a sha whose persisted prod history contradicts its own scorers.
# Exit 1 with only restatable drift ⇒ AUTO-RUN the probe's own `bash scripts/restate-prod.sh <ids>`
# line (user ruling — the script already gates the destructive prod write with
# --confirm-destructive), then `--stamp` those ids (a restate bypasses `recordRun`, so
# without the explicit stamp the NEXT ship would re-restate the same drift), then re-check.
# Any `DRIFT-NORESTATE` id ⇒ die BEFORE running any restate, so the operator sees the whole
# picture at once (ruling 4b). Any exit other than 0/1 ⇒ die (probe/infra fault, not drift).
# KNOWN LIMITATION (accepted):
# a prod cron firing in the deploy→detector window (~1–2 min) stamps the new vintage before the detector reads it,
# masking one drift — deploys happen only via `make ship`, and the ad-hoc probe plus the
# next retune's detector run bound the exposure.
# Same capture contract as every step: raw output → $SHIP_LOG + screen, exit status is the
# probe's — plus a kept copy in $DRIFT_OUT because THIS step parses its own output.
DRIFT_OUT="$(mktemp)"
# $1 = the --applied manifest, passed on the FIRST run only: a `-- restate:` decree is
# drift-by-decree "hash-clean or not", so a re-check that re-reads the manifest after the
# restate + stamp re-emits the same DRIFT lines and the gate would die on the very release
# the decree was written for (review finding, 2026-09-05). The re-check is the plain diff.
run_drift() {
  local rc t0=$SECONDS applied="${1-}"
  : >"$DRIFT_OUT"
  in_head npm run probe:vintage-drift -- --env=prod ${applied:+--applied="$applied"} 2>&1 | tee -a "$DRIFT_OUT"
  rc=${PIPESTATUS[0]}
  cat "$DRIFT_OUT" >>"$SHIP_LOG"
  tick vintage "$((SECONDS - t0))s"
  return "$rc"
}
step "Scorer-vintage drift gate (probe:vintage-drift vs prod — auto-restate on drift)"
drift_rc=0; run_drift "$SHIP_APPLIED_MIGRATIONS" || drift_rc=$?
if [ "$drift_rc" -eq 1 ]; then
  if grep -qE '^DRIFT-NORESTATE ' "$DRIFT_OUT"; then
    nr_ids="$(grep -E '^DRIFT-NORESTATE ' "$DRIFT_OUT" | awk '{print $2}' | paste -sd, -)"
    die "un-restatable scorer-vintage drift: $nr_ids — NOT pushing, and no restate was run (the whole picture first — ruling 4b). Prod IS serving $SHIP_SHA_SHORT. Handle those ids' stored history by hand, then clear the flag with \`npm run probe:vintage-drift -- --env=prod --stamp=$nr_ids\` and re-ship."
  fi
  restate_ids="$(grep -E '^bash scripts/restate-prod\.sh ' "$DRIFT_OUT" | head -1 | awk '{print $3}')"
  [ -n "$restate_ids" ] || die "probe:vintage-drift exited 1 without a \`bash scripts/restate-prod.sh\` line to parse — see its output above; nothing was restated, NOT pushing."
  step "Auto-restate drifted ids on prod (scripts/restate-prod.sh $restate_ids — destructive, --confirm-destructive via the script)"
  capture restate bash scripts/restate-prod.sh "$restate_ids" \
    || die "scripts/restate-prod.sh $restate_ids FAILED — prod IS serving $SHIP_SHA_SHORT but its history still carries the old vintage; NOT pushing. Fix and re-run \`bash scripts/restate-prod.sh $restate_ids\`, then \`npm run probe:vintage-drift -- --env=prod --stamp=$restate_ids\`, then re-ship."
  capture stamp in_head npm run probe:vintage-drift -- --env=prod --stamp="$restate_ids" \
    || die "vintage stamp FAILED after a SUCCESSFUL restate of $restate_ids — without it the next ship re-restates them; run \`npm run probe:vintage-drift -- --env=prod --stamp=$restate_ids\` by hand, then re-ship. NOT pushing."
  drift_rc=0; run_drift || drift_rc=$?   # no manifest: decrees were discharged by the restate above
  [ "$drift_rc" -eq 0 ] || die "scorer-vintage drift REMAINS after restate + stamp (probe exit $drift_rc) — see the DRIFT lines above; NOT pushing."
elif [ "$drift_rc" -ne 0 ]; then
  die "probe:vintage-drift errored (exit $drift_rc — neither clean nor drift; an infra/probe fault) — NOT pushing. Reproduce with \`npm run probe:vintage-drift -- --env=prod\`."
fi
rm -f "$DRIFT_OUT"

# ── 6. Publish code. SKIP_TESTS=1 ⇒ the BLOCKING pre-push hook does NOT re-run vitest. ──
# Push the PINNED sha explicitly, not the branch tip — the tip may have moved past what was
# verified and deployed (see the note above), and `git push` would then publish commits prod
# is not serving. `$SHIP_SHA:refs/heads/$SHIP_BRANCH` keeps origin == prod exactly.
# §00 judged the START clock; a ship that ran into the push-policy window (now + 60 s) skips the push here — the hook would refuse it.
if [ "$SHIP_PUSH" = 1 ] && [ "$POLICY_GATE" = 1 ]; then
  python3 -I - "$POLICY_PY" <<'PY'
import runpy, sys
m = runpy.run_path(sys.argv[1])
sys.exit(3 if m["is_work"](m["now"]() + 60) else 0)
PY
  [ $? = 3 ] && { SHIP_PUSH=0; note "the push-policy window opened during this ship — skipping the push instead of letting the hook refuse it."; }
fi
if [ "$SHIP_PUSH" = 1 ]; then
  step "git push $SHIP_SHA_SHORT → $SHIP_BRANCH (SKIP_TESTS=1 — no duplicate integration run)"
  capture push env SKIP_TESTS=1 git push origin "$SHIP_SHA:refs/heads/$SHIP_BRANCH" \
    || die "git push failed — prod is ALREADY serving $SHIP_SHA_SHORT; push it (or roll prod back) so live == repo."
else
  note "push SKIPPED (push-policy window, §00) — prod serves $SHIP_SHA_SHORT, origin/$SHIP_BRANCH lags until the next out-of-window \`make ship\`."
fi

# ── 7. Re-derive the persisted half of the board under the code just deployed ──────────────
# A deploy alone leaves prod serving a MIXED VINTAGE, and the board looks wrong until the next
# cron for a reason that is not a bug. It is NOT a clean split of the screen into two halves:
# what the read API recomputes at request time is the ASSEMBLY (the family/member panel, every
# ledger cell + its `observed` census, the escalator-floor rows, freshness, `/api/exposure`'s
# posture), while the FACTS that assembly is built out of are read back from what the LAST cron
# persisted — `alert_log.level`/`bandReason`/`dialBand`, `heldSleeve`/`heldDays`, the r4 +
# cash-overlay fields, `tier_state`, and per-indicator `state`/`rawState`/`delta20` in
# `readings`, plus the whole `T1DialResult` blob (verbatim but for ONE read-time rewrite:
# `hydrateOrComputeT1Dial` runs the stored `headline` through `restateDialVocabulary`, which
# restates `armed`/`unarmed` as `primed`/`unprimed`; every other field is untouched, and a null
# column falls back to a fresh `computeT1Dial`). So an individual cell is itself mixed: new-code
# layout carrying the old cron's severity. `api/lab.ts` says so — it "CONSUMES the persisted
# confirmed `.state` — it never re-scores at read time" — as does `api/status.ts` ("must be
# PERSISTED at cron time, NOT recomputed at read time"); both do it ON PURPOSE. `/api/exposure`
# is hybrid the same way: recomputed off the persisted F1/GT series, but its compound floor and
# overlay step-down read `heldSleeve`/`r4Phase`/`cashOverlay` off the last alert ROW. §5b widens
# the gap: the calibration vintage published there is read at REQUEST time, so new cuts reach
# the recomputed assembly while the persisted states still carry the old vintage. Only a cron
# cycle re-derives the persisted side.
#
# So the cron run is part of the release, not a follow-up: without it the window lasts until
# the next scheduled cron. smoke-cron.sh is exactly the right instrument — it triggers
# /api/cron/run server-side and ASSERTS the run committed (firedAt advances and is fresh), so
# it doubles as the post-deploy write-path smoke test it was written to be.
#
# ⚠ A ship BEFORE the 21:05 UTC intraday cutoff (src/intraday.ts) triggers an INTRADAY run: silent, no
# alert_log row, no push — but it still re-derives the board: its verdict lands in the `intraday_verdict`
# slot, which /lab, /status and /api/exposure serve (`servedVerdict`); smoke-cron.sh passes it only once
# the slot is this run (`record_intraday_run` commits readings + slot together), failing at MAX_WAIT_SECS. `REDERIVE=0 make ship` keeps the
# readings-only run (slot emptied — every verdict read stays on the last EOD run until 22:00 UTC).
# At/after the cutoff it is a genuine scoring cycle
# (`runScoringCycle` → `decideNotify`), so a band that differs from the last push EMITS A REAL ntfy PUSH.
# What it CANNOT do is double-tick the hold clock: `record_run` is append-only (20260717010000
# reversed the same-day replace), and the SCORING prev-state reads all cut off strictly before
# this run's fired-day — `getLastAlertBefore` (`prevDay`, which feeds `prevHeldDays` /
# `prevDay.reriskConfirmCount` / the r4 phase), `getLastBandBefore` for `lastDialBand`, and
# `getRecentAlerts`, which collapses to one row per UTC fired-date (latest run wins). So a
# second run on the same date re-derives `heldDays`/`reriskConfirmCount`/R4 from the SAME prior
# day's row the scheduled run will read; it does not advance them twice.
#
# Runs AFTER the push, not before: a failure here must not leave prod serving a commit that
# was never published (the §6 die message exists because that asymmetry is the expensive one).
# SHIP_SKIP_CRON=1 opts out — for a deploy that touches nothing on the scoring path.
if [ "${SHIP_SKIP_CRON:-}" = "1" ]; then
  note "SHIP_SKIP_CRON=1 — no cron run; prod serves a MIXED VINTAGE (new-code panel beside the last cron's dial/band/held) until the next scheduled run."
else
  step "Re-derive prod state (local) — trigger the scoring cron so the persisted half stops being the old code's opinion"
  capture cron bash "$REPO/scripts/smoke-cron.sh" \
    || die "prod cron did not commit a fresh run — $SHIP_SHA_SHORT IS deployed and pushed, but the board is serving a MIXED VINTAGE (new-code assembly over the previous cron's dial/band/held/state). WHICH arm failed is in the step output above — it distinguishes a trigger that never fired ('vercel crons run' auth / path missing from vercel.json / stale CLI) from a run that fired but never committed (firedAt did not advance, or advanced stale; intraday: the verdict slot never became this run), and an age_secs parse failure from both. Do NOT re-run 'make ship' — it would redeploy and re-verify an already-shipped sha; re-run the prod scoring cron trigger (scripts/smoke-cron.sh)."
fi

if [ "$SHIP_PUSH" = 1 ]; then
  printf '\n\033[1;32m✓ shipped %s — prod migrated+deployed+re-derived locally. CI on this push runs ONLY the unit clean-room check (~1 min); no migrate/backtest/deploy billed.\033[0m\n' "$SHIP_SHA_SHORT"
else
  printf '\n\033[1;32m✓ deployed %s — prod migrated+deployed+re-derived locally, NOT pushed (push-policy window); the next out-of-window `make ship` folds + pushes.\033[0m\n' "$SHIP_SHA_SHORT"
fi
warn_recap
