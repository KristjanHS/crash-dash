#!/usr/bin/env bash
#
# eufin-run-local.sh — headless re-entry ladder runs (`/eufin` → `/value` → `/semis` → `/spit` → `/sp500`) under the
# crash-dash-eufin.timer systemd unit. The script + unit names predate /value and are kept: the
# unit is symlinked into ~/.config/systemd/user/, so renaming it would orphan the live install.
#
# Runs each skill through `claude -p` with a Claude Console API key, NOT the claude.ai
# login — every timer fire, asserted at start (§ Auth). The one exception is a manual
# `make ladder-run sub`, which bills the claude.ai login for that single run. Why: the Max plan's monthly API credit covers "`claude -p` ... when you run them
# yourself with an API key from your linked Claude Console organization" and excludes
# interactive Claude Code and the Claude Code GitHub Action, even with -p
# (support.claude.com/en/articles/17154008). A local timer also costs zero GitHub Actions
# minutes — the Free allowance ran out once already (2026-07-25).
#
# The key comes from the operator's environment file ~/.config/crash-dash/eufin.env (chmod 600, never in
# the repo), loaded by the unit's EnvironmentFile=. It is set only inside this unit, so interactive sessions keep the
# subscription login. Never commit it, never `Read` that file. The key MUST be workspace-scoped
# (created under a workspace in Console → API keys): an org-level key fails every request with
# "400 ... must include the anthropic-workspace-id header". Verified 2026-10-08: a run drew down
# the promotional line, not the prepaid balance.
#
# Permissions: print mode has no prompt. The skills' steps are pre-allowed — probe/state/apply via
# `npm run`, the pathspec'd `git commit`, the patch `Write`/`Edit` (scoped to $SCRATCH_ROOT), the foreground `ladder-research` Agent and its
# WebFetch/WebSearch (all legs share them). Anything else falls to the session's permission mode: under `default` it is denied,
# under the user settings' `auto` the classifier decides (the mode is logged per leg). Every denied
# call — rule, hook or classifier, a foreground subagent's included — is read off the JSON transcript
# (`permission_denials`) and pushed to ntfy right after its leg, with why it was denied
# (scripts/ladder-claude-summary.mjs → scripts/ladder-notify.sh), so a denial is never silent — high priority
# only when the leg made no commit (apply did not land), low when the run recovered.
# The research Agent call runs foreground (skill §2): a background one's denials would land after the transcript closes.
#
# Fresh data: before any leg, the run fires `BLOCKING=1 make prodcron` (§ Fresh prod data) so the probes read a just-committed
# prod cron run (a failed purge / 504 only warns); two failed triggers fail the whole run (exit 1 → alert), no leg runs.
#
# Legs run in sequence, each its own `claude -p` with its own budget. A failed leg is logged and
# the next one still runs; the unit exits 1 at the end if any leg failed.
#
# Shared-tree guard: a leg commits only public/<leg>.json (docs/<leg>.md is gitignored, rendered locally); a dirty
# json would fold someone's in-flight edit into the cron commit, so that leg is skipped as an error (dev-workflow.md).
#
# Ship: after the legs, if any committed, the run calls `make ship` (SHIP=1, the default) ONCE so
# prod serves the new state — the full local release chain (suite + deploy + push + cron
# re-derive, ~5-10 min).
# Auth is the stored `vercel login` ONLY — no VERCEL_TOKEN (user ruling 2026-10-08: a personal
# token is account-wide and long-lived; the OAuth session is 8 h + a rotating refresh). The run
# probes `vercel whoami` (which itself refreshes the session, deploy-prod-local.sh § Preflight):
# fresh → ship; stale → push main and keep the commit in $UNSHIPPED for the user's next manual
# `make ship` (or the next run whose probe succeeds). Git pushes over HTTPS via the stored gh
# credential. Ship is skipped (exit 0, retried next slot) when anything else holds the release lock
# (scripts/lib/release-lock.sh): a release (ship.sh ship, smoke-cron.sh) or a run on the one shared crash-dash-ci
# stack that ship's gate truncates and tears down (ship.sh verify = `make verify`, run-integration-tests.sh =
# `npm run check:integration`) — each of those takes the lock for its whole run.
# Note `make ship` releases HEAD: any other unshipped commits on main go live with it.
# SHIP_PUSH_HORIZON_S (unit default 0): ship's push look-ahead before the 08:00 push-policy window; ship.sh alone defaults 2700.
# LADDER_RELEASE_MAKE (default `make`) is the make invocation for `prodcron` and `ship`; set it (e.g.
# `make -C /abs/dir`) to one whose Makefile defines BOTH. This repo's Makefile defines `ship` only, so the
# default stops at `prodcron`, before any leg. Leg targets and git work stay in this checkout. Paths in it
# must be ABSOLUTE: systemd's EnvironmentFile expands neither `~` nor `$HOME`. A value that splits to
# no words (whitespace only) is refused at start (exit 1), before any make call.
#
# API limit: a leg whose output says the Console API usage limit is reached writes the reset time
# to ~/.config/crash-dash/ladder-paused-until, skips the remaining legs and alerts once; every fire
# before that time exits 0 at once (scripts/ladder-pause.sh; `make ladder-status` shows it).
# A leg answered "Credit balance is too low" skips the remaining legs (the committed ones still ship).
# API-key runs are locked each billing cycle until a manual `make ladder-run` unlocks it (§ Manual unlock).
#
# Knobs: LEGS (default "semis"; any of eufin value semis spit sp500) · SHIP=0 disables the ship step ·
# PUSH=1 (only with SHIP=0) pushes main after a leg commit this run · LADDER_BUDGET_USD (default 5,
# per leg — a runaway guard sized at ~1.7× a modelled 20-search Fable/high run (~$3), user ruling
# 2026-10-09; the Console workspace spend limit caps the month; the pre-/value EUFIN_BUDGET_USD is still honoured as a fallback) · DRY_RUN=1 prints each
# leg's claude command and exits · LADDER_RENEWAL_DAY (default 2) starts each billing cycle — the
# manual-unlock period and the LADDER_CYCLE_CAP_USD (default 80) spend cap.
# LADDER_PRERUN (default 1; 0 = the plain path) runs a leg's Rung 0+A, then any owed Rung B extended/dating calls, as Sonnet `claude -p`s (the
# ladder-research body, web tools only) before Opus, then hands Opus those tables + `ladder:prelabel` pre-labels; only for legs in
# LADDER_PRERUN_LEGS (space-separated, default "semis"), both calls capped together at LADDER_PRERUN_BUDGET_USD (default 1). A Rung 0+A failure warns and
# that leg takes the plain path; a Rung B failure leaves Rung B to Opus. Its cost is booked in the cycle ledger and summed into the leg's `cost $` line.
# LADDER_LEG_WRAP (default unset): a command prefix; each leg re-runs this script under it, with cwd = a detached worktree
# of $REPO at $LADDER_BASE_SHA, then $REPO fast-forwards to that worktree's HEAD. Whitespace only is refused at start.
# LADDER_PROTECTED_PATHS (default unset; needs LADDER_LEG_WRAP): a file of one `<path>` per line (`#` = comment);
# a bad or empty list, or a leg any one of whose worktree commits touches a listed path, is refused — no merge, push or ship, exit 1.
# LADDER_PREFLIGHT (default unset): a command run once before `prodcron` and any leg (cwd = $REPO; skipped for an inner
# leg and under DRY_RUN=1); a non-zero exit fails the run there (`run-preflight`, exit 1 → alert), no credit spent.
# Whitespace only is refused at start.
# Model + effort are pinned, NOT knobs (user ruling 2026-11-05: Opus at medium effort; was high 2026-11-02). Both
# go on the command line so neither an env var nor settings.json `effortLevel` can drift the run.
#
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

log() { echo "[ladder $(date -u +%H:%M:%S)] $*"; }

# Inner-leg mode (the LADDER_LEG_WRAP re-exec, § Run each leg): only leg $LADDER_INNER_LEG runs, every run-level step is
# skipped, and its outcome goes to $LADDER_LEG_RESULT_FILE for the outer run.
INNER_LEG="${LADDER_INNER_LEG:-}"
if [ -n "$INNER_LEG" ]; then
  [ "$(git rev-parse HEAD)" = "${LADDER_BASE_SHA:-}" ] && [ -n "${LADDER_LEG_RESULT_FILE:-}" ] && [ -n "${LADDER_PUSH_FAILED_FILE:-}" ] ||
    { echo "::error:: LADDER_INNER_LEG=$INNER_LEG needs cwd at LADDER_BASE_SHA + LADDER_LEG_RESULT_FILE + LADDER_PUSH_FAILED_FILE — refused" >&2; exit 1; }
fi

# ── Failure alert ─────────────────────────────────────────────────────────────────────
# Not here: the unit's OnFailure= (crash-dash-ladder-alert.service → scripts/ladder-alert.sh) pushes
# one ntfy line on ANY failed run — a non-zero exit, the TimeoutStartSec kill, SIGKILL/OOM, a unit
# that never started — which a shell trap cannot all see. So every real problem must exit non-zero.

# ── Pin Node to .nvmrc ────────────────────────────────────────────────────────────────
# Under systemd no interactive shell loads nvm, so `node` resolves to the distro's (no native WebSocket, which
# supabase-js needs): resolve the .nvmrc major explicitly, newest patch first, and refuse a missing one.
want="$(tr -dc '0-9' < .nvmrc)"
if [ "$(node -v 2>/dev/null | tr -dc '0-9.' | cut -d. -f1)" != "$want" ]; then
  shopt -s nullglob
  nvm_bins=("${NVM_DIR:-$HOME/.nvm}"/versions/node/v"$want".*/bin)
  shopt -u nullglob  # scoped to this one glob — left on, an empty glob later expands to no args (`ls` → the cwd)
  [ ${#nvm_bins[@]} -gt 0 ] || { echo "::error:: Node $want not found under ${NVM_DIR:-$HOME/.nvm}/versions/node (nvm install $want)." >&2; exit 1; }
  PATH="$(printf '%s\n' "${nvm_bins[@]}" | sort -V | tail -1):$PATH"
  export PATH
fi
log "node $(node -v)"

# ── API-limit pause ───────────────────────────────────────────────────────────────────
# A leg that hit the Console API usage limit wrote the reset time (scripts/ladder-pause.sh); until
# then every fire is a no-op — no probe, no apply, no ship, no alert. Delete the file to resume early.
# ── Auth: the API key, always — except one manual `make ladder-run sub` ────────────────
# Timer fires must never bill the claude.ai login. Only `make ladder-run sub` may: it writes a
# one-shot token file and passes LADDER_AUTH=claude-ai:<token> for that one start. Anything else —
# a variable leaked into the user manager by an interrupted make, a hand-set LADDER_AUTH, a stale
# token — is refused (exit 1 → alert) and the leaked variable is cleared, so the next fire runs on
# the key. The resolved method is then asserted against `claude auth status` (Preconditions).
# In claude-ai mode the API-limit pause does not apply (it guards the API quota, not the subscription).
AUTH=api
AUTH_TOKEN_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/crash-dash/ladder-auth-once"
if [ -n "$INNER_LEG" ]; then
  AUTH="${LADDER_INNER_AUTH:-}"
  [[ $AUTH = api || $AUTH = claude-ai ]] || { echo "::error:: LADDER_INNER_AUTH='$AUTH' is not api|claude-ai" >&2; exit 1; }
elif [ -n "${LADDER_AUTH:-}" ]; then
  token="$(find "$AUTH_TOKEN_FILE" -mmin -10 -exec cat {} \; 2>/dev/null || true)"
  rm -f "$AUTH_TOKEN_FILE"
  if [ -n "$token" ] && [ "$LADDER_AUTH" = "claude-ai:$token" ]; then
    AUTH=claude-ai
  else
    systemctl --user unset-environment LADDER_AUTH 2>/dev/null || true
    echo "::error:: LADDER_AUTH set without a fresh make-ladder-run-sub token — refused and cleared from the user manager; runs stay on the API key" >&2
    exit 1
  fi
fi
# Higher-precedence auth sources than the key are never wanted here.
unset ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
if [ "$AUTH" = claude-ai ]; then unset ANTHROPIC_API_KEY; fi


# ── Billing cycle: starts on the Max renewal day (unlock + spend cap) ─────────────────
RENEWAL_DAY="${LADDER_RENEWAL_DAY:-2}"
[[ $RENEWAL_DAY =~ ^[0-9]{1,2}$ ]] && (( 10#$RENEWAL_DAY >= 1 && 10#$RENEWAL_DAY <= 31 )) ||
  { echo "::error:: LADDER_RENEWAL_DAY='$RENEWAL_DAY' is not a day of month (1–31)" >&2; exit 1; }
# The make invocation for `prodcron` + `ship` (header § Ship). `:-make` covers unset/empty only; a
# whitespace-only value splits to no words and would run `-s`/`ship` as the command.
read -ra RELEASE_MAKE <<<"${LADDER_RELEASE_MAKE:-make}"
[ ${#RELEASE_MAKE[@]} -gt 0 ] ||
  { echo "::error:: LADDER_RELEASE_MAKE='${LADDER_RELEASE_MAKE:-}' names no command — set it to a make invocation (e.g. make -C /abs/dir) or unset it" >&2; exit 1; }
read -ra LEG_WRAP <<<"${LADDER_LEG_WRAP:-}"
[ -z "${LADDER_LEG_WRAP:-}" ] || [ ${#LEG_WRAP[@]} -gt 0 ] ||
  { echo "::error:: LADDER_LEG_WRAP='$LADDER_LEG_WRAP' names no command — set a command prefix or unset it" >&2; exit 1; }
read -ra PREFLIGHT <<<"${LADDER_PREFLIGHT:-}"
[ -z "${LADDER_PREFLIGHT:-}" ] || [ ${#PREFLIGHT[@]} -gt 0 ] ||
  { echo "::error:: LADDER_PREFLIGHT='$LADDER_PREFLIGHT' names no command — set a command or unset it" >&2; exit 1; }
# Prints the LADDER_PROTECTED_PATHS entries, inline `#` comments stripped; non-zero = unreadable, a line that is
# not a single path (any whitespace inside the line), or no entry at all.
protected_list() {
  [ -f "$LADDER_PROTECTED_PATHS" ] && [ -r "$LADDER_PROTECTED_PATHS" ] || return 1
  awk '{ sub(/#.*/, "") } !NF { next } NF == 1 { print $1; n++; next }
    { bad = 1; exit } END { exit (bad || !n) }' "$LADDER_PROTECTED_PATHS"
}
if [ -z "$INNER_LEG" ] && [ -n "${LADDER_PROTECTED_PATHS:-}" ]; then
  [ ${#LEG_WRAP[@]} -gt 0 ] ||
    { echo "::error:: LADDER_PROTECTED_PATHS is set but LADDER_LEG_WRAP is not — its legs would run unchecked; refused" >&2; exit 1; }
  protected_list >/dev/null ||
    { echo "::error:: LADDER_PROTECTED_PATHS='$LADDER_PROTECTED_PATHS' is not a readable list of one-path lines with an entry — refused" >&2; exit 1; }
fi
# The renewal date in month YYYY-MM, clamped to its last day (a 31st renews on Nov 30).
renewal_in() {
  local last; last="$(date -d "$1-01 +1 month -1 day" +%-d)"
  if [ "$((10#$RENEWAL_DAY))" -le "$last" ]; then last="$((10#$RENEWAL_DAY))"; fi
  printf '%s-%02d' "$1" "$last"
}
run_day="$(date +%F)"
cycle="$(renewal_in "$(date +%Y-%m)")"
if [[ $run_day < $cycle ]]; then cycle="$(renewal_in "$(date -d "$(date +%Y-%m-01) -1 month" +%Y-%m)")"; fi

# A `make ladder-run` request unlocks the cycle before any early exit (the pause below included);
# the lock itself is enforced in § Manual unlock.
ARMED_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/crash-dash/ladder-armed"
ARM_REQUEST="${XDG_CONFIG_HOME:-$HOME/.config}/crash-dash/ladder-arm-request"
if [ -z "$INNER_LEG" ] && [ "${DRY_RUN:-0}" != 1 ] && [ "$AUTH" = api ]; then
  if [ -n "$(find "$ARM_REQUEST" -mmin -10 2>/dev/null)" ]; then
    echo "$cycle" >"$ARMED_FILE"; log "manual start — cycle $cycle unlocked"
  fi
  rm -f "$ARM_REQUEST"
fi

if [ -z "$INNER_LEG" ] && [ "${DRY_RUN:-0}" != 1 ] && [ "$AUTH" = api ]; then
  prc=0; reset_at="$(scripts/ladder-pause.sh check)" || prc=$?
  case "$prc" in
    0) ;;
    1) log "paused — API usage limit reached; runs skip until $reset_at"; exit 0 ;;
    *) echo "::error:: scripts/ladder-pause.sh check failed (exit $prc)" >&2; exit 1 ;;
  esac
fi

# ── Preconditions ─────────────────────────────────────────────────────────────────────
if [ -z "$INNER_LEG" ]; then
  [ "$AUTH" = claude-ai ] || [ -n "${ANTHROPIC_API_KEY:-}" ] || { echo "::error:: ANTHROPIC_API_KEY unset — put it in ~/.config/crash-dash/eufin.env" >&2; exit 1; }
  command -v claude >/dev/null || { echo "::error:: claude not on PATH ($PATH)" >&2; exit 1; }
  # Ask claude which credential it will bill: the key from the env file, or (sub only) the claude.ai login.
  got="$(claude auth status --json 2>/dev/null | node -e 'try{const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(j.authMethod+" "+(j.apiKeySource||"-"))}catch{console.log("unreadable")}')"
  want="api_key ANTHROPIC_API_KEY"; [ "$AUTH" = claude-ai ] && want="claude.ai -"
  [ "$got" = "$want" ] || { echo "::error:: claude would authenticate as '$got', this run needs '$want' — refusing" >&2; exit 1; }
  log "auth: $got"

  # ── Single-flight (the outer run holds it for its inner legs) ───────────────────────
  exec 9>"${TMPDIR:-/tmp}/crash-dash-eufin.lock"
  flock -n 9 || { log "another ladder run is in progress — exiting"; exit 0; }
fi

MODEL=opus
EFFORT=medium
BUDGET="${LADDER_BUDGET_USD:-${EUFIN_BUDGET_USD:-5}}"
PRERUN="${LADDER_PRERUN:-1}"
PRERUN_BUDGET="${LADDER_PRERUN_BUDGET_USD:-1}"
PRERUN_LEGS="${LADDER_PRERUN_LEGS:-semis}"
[[ $PRERUN_BUDGET =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "::error:: LADDER_PRERUN_BUDGET_USD='$PRERUN_BUDGET' is not a USD amount" >&2; exit 1; }
UNSHIPPED="${XDG_CONFIG_HOME:-$HOME/.config}/crash-dash/eufin-unshipped"
[ -z "$INNER_LEG" ] || UNSHIPPED=/dev/null # the outer run marks it after its merge

# ── Cycle spend cap ───────────────────────────────────────────────────────────────────
# Keep the ladder's spend per Max billing cycle under the $100 promo: past it, requests bill purchased
# credit and one admitted at a positive balance overdraws (−$0.91 on 2026-11-02). API-key runs only.
CAP="${LADDER_CYCLE_CAP_USD:-80}"
SPEND_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/crash-dash/ladder-spend"
CAP_ALERTED="$SPEND_FILE.alerted"
spent=0
if [ -e "$SPEND_FILE" ]; then
  line="$(cat "$SPEND_FILE")"
  [[ $line =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2})\ ([0-9]+(\.[0-9]+)?)$ ]] ||
    { echo "::error:: spend ledger $SPEND_FILE unreadable ('$line') — check the Console Cost page, then write '<cycle-start> <usd>' or delete it" >&2; exit 1; }
  if [ "${BASH_REMATCH[1]}" = "$cycle" ]; then spent="${BASH_REMATCH[2]}"; fi
fi
book() { printf '%s %s\n' "$cycle" "$1" >"$SPEND_FILE.tmp" && mv "$SPEND_FILE.tmp" "$SPEND_FILE"; }

# ── Manual unlock (once per cycle) ────────────────────────────────────────────────────
# API-key runs stay locked each cycle until `make ladder-run` (not `sub`) starts one: it drops a one-shot
# request file consumed under § Billing cycle. Locked fires exit 0; the cycle's first one pings ntfy once.
if [ -z "$INNER_LEG" ] && [ "${DRY_RUN:-0}" != 1 ] && [ "$AUTH" = api ]; then
  if [ "$(cat "$ARMED_FILE" 2>/dev/null)" != "$cycle" ]; then
    log "locked — cycle $cycle not unlocked yet; make ladder-run starts and unlocks it"
    if [ "$(cat "$ARMED_FILE.reminded" 2>/dev/null)" != "$cycle" ]; then
      if echo "Scheduled ladder runs skip until you run: make ladder-run" |
         scripts/ladder-notify.sh "crash-dash ladder locked for cycle $cycle" default lock; then
        echo "$cycle" >"$ARMED_FILE.reminded"
      else
        echo "::warning:: ntfy reminder for the locked cycle failed — retried next fire" >&2
      fi
    fi
    exit 0
  fi
fi
failed=()
committed=0
legs=0
stop=0 # 1 = a leg broke the loop (API limit / credit)
# `<leg>:apply` appends `<leg>: <title> — <err>` here on a failed ntfy push (it exits 0 so the commit lands) — checked after the loop.
# An inner leg appends to the outer run's file (inherited) and leaves its removal to the outer.
push_failed_own=""
if [ -z "$INNER_LEG" ]; then LADDER_PUSH_FAILED_FILE="$(mktemp)"; export LADDER_PUSH_FAILED_FILE; push_failed_own="$LADDER_PUSH_FAILED_FILE"; fi
SCRATCH_ROOT="$(mktemp -d)" # per-leg `<scratchpad>` dirs live under it (see the claude -p call)
out=""; err=""; leg_denied=""; res=""
trap 'rm -f ${push_failed_own:+"$push_failed_own"} ${out:+"$out"} ${err:+"$err"} ${leg_denied:+"$leg_denied"} ${res:+"$res"}; rm -rf "$SCRATCH_ROOT"' EXIT
finish() {
  if [ ${#failed[@]} -gt 0 ]; then echo "::error:: failed: ${failed[*]}" >&2; exit 1; fi
  exit 0
}

# ── Run preflight (LADDER_PREFLIGHT, header § Knobs) ──────────────────────────────────
# A leg can fail mid-skill on a precondition while `claude -p` still exits 0. Checked here: no credit spent, and the
# failure is the run's, so the alert fires.
if [ -z "$INNER_LEG" ] && [ "${DRY_RUN:-0}" != 1 ] && [ ${#PREFLIGHT[@]} -gt 0 ]; then
  "${PREFLIGHT[@]}" || { echo "::error:: LADDER_PREFLIGHT failed (exit $?) — every leg skipped" >&2; failed+=("run-preflight"); finish; }
  log "preflight ok"
fi

# ── Fresh prod data ───────────────────────────────────────────────────────────────────
# `BLOCKING=1 make prodcron` re-runs the prod scoring cycle and returns after its seed tail + final purge; one retry, then every leg skipped.
# Never beside another ship.sh/smoke-cron.sh: either poll could pass on the other's run (slot_is_new in smoke-cron.sh).
# Both hold the release lock for their run (as do `make verify` and run-integration-tests.sh, which skip prodcron
# too: smoke-cron.sh would refuse on the same lock); `release_lock_busy` probes it and lets go at once.
# shellcheck source=lib/release-lock.sh
. "$REPO/scripts/lib/release-lock.sh"
if [ -z "$INNER_LEG" ] && [ "${DRY_RUN:-0}" != 1 ]; then
  busy() {
    if release_lock_busy; then
      echo "::error:: another release or CI-stack run (ship.sh / smoke-cron.sh / run-integration-tests.sh) holds the release lock — ${RELEASE_MAKE[*]} -s prodcron not fired, every leg skipped (retried next slot)" >&2; failed+=("prodcron-busy"); finish
    fi
  }
  busy; log "${RELEASE_MAKE[*]} -s prodcron (fresh prod data before the probes)"
  if ! BLOCKING=1 "${RELEASE_MAKE[@]}" -s prodcron; then
    log "${RELEASE_MAKE[*]} -s prodcron failed — retrying once in ${PRODCRON_RETRY_S:-60}s"; sleep "${PRODCRON_RETRY_S:-60}"; busy
    BLOCKING=1 "${RELEASE_MAKE[@]}" -s prodcron || { echo "::error:: ${RELEASE_MAKE[*]} -s prodcron failed twice — prod data not refreshed, every leg skipped (output above)" >&2; failed+=("prodcron"); finish; }
  fi
fi

# ── Run each leg's skill ──────────────────────────────────────────────────────────────
# Print mode + the Console key bills as Agent SDK usage (the covered path). Allowed tools
# are the skills' exact needs; sub runs add read-only Skill/Read/Grep/Glob — API runs' --tools has none of them.
# One flag set for the legs AND the preflight; its invalid key fails unbilled after init lists the tools (--bare once left only Bash).
# A subagent only gets tools the main --tools lists, so WebFetch/WebSearch stay; the skill routes them through
# the `ladder-research` agent (.claude/agents/ladder-research.md, passed as --agents) and the summary warns on a main-model web call.
API_TOOLS="Bash,Write,Edit,WebFetch,WebSearch,Agent"
# WebFetch is policy-gated (`allow_web_fetch` fails closed with no policy verdict, which the invalid key's 401 guarantees)
# → the preflight skips it; ladder-claude-summary.mjs checks it on the real run's init (exit 3).
PREFLIGHT_TOOLS="$(tr , '\n' <<<"$API_TOOLS" | grep -vx WebFetch | paste -sd,)"
# `//` = an absolute path in a permission rule; an Edit rule also gates Write, so both are denied outside it under `default`.
allowed=("Edit(/$SCRATCH_ROOT/**)" "WebFetch" "WebSearch" "Agent" "Task" "Bash(npm run:*)" "Bash(git commit:*)" "Bash(git log:*)")
agents_json="$(node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");const m=/^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(s);
const f=Object.fromEntries(m[1].split("\n").map(l=>[l.slice(0,l.indexOf(":")).trim(),l.slice(l.indexOf(":")+1).trim()]));
console.log(JSON.stringify({[f.name]:{description:f.description,prompt:m[2].trim(),tools:f.tools.split(/,\s*/),model:f.model}}))' .claude/agents/ladder-research.md)" ||
  { echo "::error:: .claude/agents/ladder-research.md unreadable — API runs fail the tools preflight (every leg skipped), sub runs have no research agent" >&2; agents_json='{}'; }
auth_flags=()
if [ "$AUTH" = api ]; then auth_flags=(--setting-sources project --strict-mcp-config --tools "$API_TOOLS"); else allowed+=("Skill" "Read" "Grep" "Glob"); fi
claude_flags=("${auth_flags[@]}" --model "$MODEL" --effort "$EFFORT" --max-budget-usd "$BUDGET" --agents "$agents_json"
  --allowedTools "${allowed[@]}" --disallowedTools "Read(~/.config/crash-dash/**)")
# The Rung 0+A (+ Rung B) pre-run: Sonnet, web tools only, the agent body (frontmatter stripped) as its system-prompt tail.
pre_flags=(--model sonnet --allowedTools WebSearch WebFetch --disallowedTools "Read(~/.config/crash-dash/**)")
# shellcheck disable=SC2054 # --tools takes one comma-separated list
if [ "$AUTH" = api ]; then pre_flags=(--setting-sources project --strict-mcp-config --tools WebSearch,WebFetch "${pre_flags[@]}"); fi
pre_warn() { echo "::warning:: /$leg rung-a pre-run: $* — ${pre_then:-this leg takes the plain path}" >&2; }
# One web-tools-only Sonnet call: $1 rung tag, $2 prompt, $3 USD cap, $4 findings file, $5 its failure's warning suffix; adds its cost to $pre_cost.
research_call() {
  local tag="$1" prompt="$2" cap="$3" md="$4" pre_then="${5:-}" pjson="$scratch/$1.json" perr="$scratch/$1.err" pden="$scratch/$1.denied" c crc=0 src=0
  local pcmd=(env FORCE_PROMPT_CACHING_5M=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude -p "$prompt"
    --append-system-prompt-file "$scratch/research-agent.md" "${pre_flags[@]}" --max-budget-usd "$cap" --output-format json --verbose)
  if [ "${DRY_RUN:-0}" = 1 ]; then printf '%q ' "${pcmd[@]}"; echo; return 0; fi
  log "claude -p $tag pre-run /$leg (model=sonnet, budget=\$$cap)"
  : >"$pden"; "${pcmd[@]}" >"$pjson" 2>"$perr" || crc=$?
  cat "$perr" >&2
  # No readable cost (claude died before its result) → book the call's whole cap.
  c="$(node -e 'const r=[].concat(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))).findLast(m=>m.type==="result");const c=r?.total_cost_usd;if(typeof c!=="number"||!isFinite(c))process.exit(1);console.log(c)' "$pjson" 2>/dev/null)" || c="$cap"
  pre_cost="$(awk -v p="$pre_cost" -v c="$c" 'BEGIN{printf "%.4f", p+c}')"
  node scripts/ladder-claude-summary.mjs --research "$pjson" "$pden" "$md" || src=$?
  while IFS= read -r d; do echo "::warning:: /$leg $tag pre-run tool call denied: $d" >&2; done <"$pden"
  [ "$crc" = 0 ] || { pre_warn "$tag: claude exited $crc"; return 1; }
  # Sub runs keep ToolSearch, so their init may list WebFetch as deferred — only API runs gate on it.
  case "$src" in 0) ;; 3) [ "$AUTH" != api ] || { pre_warn "$tag: init lacks WebFetch"; return 1; } ;; *) pre_warn "$tag: transcript unreadable (summary exit $src)"; return 1 ;; esac
  node -e 'const r=[].concat(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))).findLast(m=>m.type==="result");process.exit(r?.subtype==="success"&&!r.is_error?0:1)' "$pjson" ||
    { pre_warn "$tag: result not a success (budget abort or API error)"; return 1; }
  grep -q '[^[:space:]]' "$md" || { pre_warn "$tag: empty findings table"; return 1; }
}
prelabel() { # $1 = comma-separated findings tables → $scratch/prelabels.json
  npm run -s ladder:prelabel -- --state="$scratch/state.json" --table="$1" >"$scratch/prelabels.json" &&
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).patch||process.exit(1)' "$scratch/prelabels.json"
}
# Needs $leg $scratch $state; sets $pre_cost + $rung_b (1 = rung-b.md folded in). 0 = $scratch/rung-a.md + $scratch/prelabels.json ready (DRY_RUN: printed).
# Rung B spends what Rung A left of the LADDER_PRERUN_BUDGET_USD cap; its failure keeps the Rung-A pre-labels and Opus runs Rung B itself.
prerun() {
  local prompt left
  pre_cost=0; rung_b=0
  awk 'f==2; /^---$/ && f<2 {f++}' .claude/agents/ladder-research.md >"$scratch/research-agent.md" && grep -q '[^[:space:]]' "$scratch/research-agent.md" ||
    { pre_warn ".claude/agents/ladder-research.md has no body"; return 1; }
  if [ "${DRY_RUN:-0}" = 1 ]; then
    research_call rung-a '<ladder:research-prompt output>' "$PRERUN_BUDGET" "$scratch/rung-a.md"
    research_call rung-b '<ladder:research-prompt --rung-b output, if non-empty>' '<budget left>' "$scratch/rung-b.md"; return 0
  fi
  printf '%s' "$state" >"$scratch/state.json"
  prompt="$(npm run -s ladder:research-prompt -- --state="$scratch/state.json")" && [ -n "$prompt" ] ||
    { pre_warn "ladder:research-prompt failed or printed nothing"; return 1; }
  research_call rung-a "$prompt" "$PRERUN_BUDGET" "$scratch/rung-a.md" || return 1
  prelabel "$scratch/rung-a.md" || { pre_warn "ladder:prelabel failed"; return 1; }
  prompt="$(npm run -s ladder:research-prompt -- --state="$scratch/state.json" --rung-b="$scratch/prelabels.json")" ||
    { echo "::warning:: /$leg rung-b prompt failed — Opus runs Rung B" >&2; return 0; }
  [ -n "$prompt" ] || return 0
  left="$(awk -v b="$PRERUN_BUDGET" -v c="$pre_cost" 'BEGIN{printf "%.4f", b-c}')"
  awk -v l="$left" 'BEGIN{exit !(l >= 0.05)}' || { echo "::warning:: /$leg rung-b skipped — \$$left of the pre-run cap left; Opus runs Rung B" >&2; return 0; }
  cp "$scratch/prelabels.json" "$scratch/prelabels-a.json"
  if research_call rung-b "$prompt" "$left" "$scratch/rung-b.md" "Opus runs Rung B itself" && prelabel "$scratch/rung-a.md,$scratch/rung-b.md"; then rung_b=1
  else cp "$scratch/prelabels-a.json" "$scratch/prelabels.json"; echo "::warning:: /$leg rung-b pre-run failed — Opus runs Rung B" >&2; fi
}
claude_ok=1
[ -z "$INNER_LEG" ] || claude_ok="${LADDER_INNER_CLAUDE_OK:-0}"
# One unbilled init probe → sets $init and $missing (empty = every tool present). $1 = the --debug-file path.
tools_preflight() {
  init="$(ANTHROPIC_API_KEY=sk-invalid-preflight timeout 60 claude -p preflight "${claude_flags[@]}" --output-format stream-json --verbose --debug-file "$1" 2>/dev/null | grep -m1 '"subtype":"init"')" || true
  # init lists the Agent tool as `Task`.
  missing="$(printf '%s' "$init" | node -e 'let j;try{j=JSON.parse(require("fs").readFileSync(0,"utf8"))}catch{console.log("no init event");process.exit()}
if(j.apiKeySource!=="ANTHROPIC_API_KEY"){console.log(`key source ${j.apiKeySource}`);process.exit()}
const t=[...(j.tools||[]),...(j.agents||[])];console.log([...process.argv[1].replace("Agent","Task").split(","),"ladder-research"].filter(x=>!t.includes(x)).join(" "))' "$PREFLIGHT_TOOLS")" || missing="node failed"
}
if [ "$AUTH" = api ] && [ -z "$INNER_LEG" ]; then
  # A failed probe retries once after PREFLIGHT_RETRY_S (probes are free). Only a failed probe's CLI debug log is kept (10 newest).
  # Evidence capture never gates the run: an unusable state dir just drops the debug log (/dev/null).
  retry_s="${PREFLIGHT_RETRY_S:-60}"; [[ $retry_s =~ ^[0-9]+$ ]] || retry_s=60
  dbg_dir="${XDG_STATE_HOME:-$HOME/.local/state}/crash-dash/preflight-debug"
  if mkdir -p "$dbg_dir" 2>/dev/null && chmod 700 "$dbg_dir" 2>/dev/null; then dbg="$dbg_dir/$(date -u +%Y%m%dT%H%M%SZ)"; else dbg_dir=""; fi
  dlog() { if [ -n "$dbg_dir" ]; then echo "$dbg-$1.log"; else echo /dev/null; fi; }
  tools_preflight "$(dlog 1)"
  if [ -z "$missing" ]; then
    [ -z "$dbg_dir" ] || rm -f "$(dlog 1)"
  else
    echo "::warning:: claude tools preflight: missing $missing (debug log $(dlog 1)) — retrying in ${retry_s}s" >&2
    sleep "$retry_s"
    tools_preflight "$(dlog 2)"
    if [ -z "$missing" ]; then [ -z "$dbg_dir" ] || rm -f "$(dlog 2)"; log "claude tools preflight: retry passed"; fi
  fi
  # find, not a glob: no shell option can turn an empty match into "list the cwd".
  [ -z "$dbg_dir" ] || find "$dbg_dir" -maxdepth 1 -type f -name '*.log' -printf '%T@ %p\n' | sort -rn | tail -n +11 | cut -d' ' -f2- | xargs -r -d '\n' rm -f -- || true
  if [ -n "$missing" ]; then
    echo "::error:: claude tools preflight: missing $missing after retry (debug logs $(dlog 1) $(dlog 2)) — every claude leg skipped" >&2; failed+=("preflight"); claude_ok=0
  else
    log "claude tools preflight: $(printf '%s' "$init" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).tools.join(","))')"
  fi
fi
# Warn-only, never a gate ([USER] 2026-11-02): past STATE_WARN a hand `/<leg>` step-1 print overflows the Bash output.
STATE_WARN=28000
[ -n "$INNER_LEG" ] || for l in eufin value semis spit sp500; do
  n="$(npm run -s "$l:state" -- --no-measure 2>/dev/null | wc -m)" || continue
  [ "$n" -le "$STATE_WARN" ] || echo "::warning:: $l:state prints $n chars > $STATE_WARN — a hand /$l overflows its Bash output" >&2
done
# Prints each LADDER_PROTECTED_PATHS entry that any one commit in $1..$2 touches (a reverted touch included);
# non-zero = a bad list, $2 not a descendant of $1, or the log failed.
protected_touched() {
  local list names
  list="$(protected_list)" && git -C "$REPO" merge-base --is-ancestor "$1" "$2" &&
    names="$(git -c core.quotePath=false -C "$REPO" log --no-renames --diff-merges=first-parent --name-only --format= "$1..$2" | sort -u)" ||
    return 1
  PLIST="$list" awk 'BEGIN { n = split(ENVIRON["PLIST"], a, "\n"); for (i = 1; i <= n; i++) p[a[i]] = 1 } $0 in p' <<<"$names"
}
refused=0
for leg in ${INNER_LEG:-${LEGS:-semis}}; do
  case "$leg" in eufin|value|semis|spit|sp500) legs=$((legs + 1)) ;; *) echo "::error:: unknown leg '$leg' in LEGS (eufin|value|semis|spit|sp500)" >&2; failed+=("$leg"); continue ;; esac

  # Attribute before mutating — this leg's tracked artifact only (docs/<leg>.md is gitignored, rendered locally).
  dirty="$(git status --short -- "public/$leg.json")"
  if [ -n "$dirty" ]; then
    echo "::error:: $leg artifacts have uncommitted changes — a sibling session (or an interrupted earlier run) owns them; skipping $leg:" >&2
    echo "$dirty" >&2
    failed+=("$leg"); continue
  fi

  # LADDER_LEG_WRAP: this whole leg re-runs as an inner leg in a worktree at HEAD; its outcome comes back through $leg_res.
  if [ ${#LEG_WRAP[@]} -gt 0 ] && [ -z "$INNER_LEG" ] && [ "${DRY_RUN:-0}" != 1 ]; then
    base="$(git -C "$REPO" rev-parse HEAD)"; leg_res="$SCRATCH_ROOT/$leg.result"; : >"$leg_res"; wrc=0
    log "$leg: worktree run at $(cut -c1-8 <<<"$base") via ${LEG_WRAP[*]}"
    # The inner's knobs ride its own command line (a wrapper may drop env); a copy without inner-leg mode runs as a
    # full run instead — LADDER_RELEASE_MAKE=false fails its prodcron before any leg, and SHIP=0 PUSH=0 bar push + ship.
    LADDER_BASE_SHA="$base" "${LEG_WRAP[@]}" env LADDER_BASE_SHA="$base" LADDER_INNER_LEG="$leg" LADDER_INNER_AUTH="$AUTH" \
      LADDER_INNER_CLAUDE_OK="$claude_ok" LADDER_LEG_RESULT_FILE="$leg_res" LADDER_PUSH_FAILED_FILE="$LADDER_PUSH_FAILED_FILE" \
      SHIP=0 PUSH=0 LEGS="$leg" LADDER_RELEASE_MAKE=false PRODCRON_RETRY_S=0 bash scripts/eufin-run-local.sh || wrc=$?
    proto=""; head=""; leg_committed=0; leg_stop=0
    while read -r k v; do
      case "$k" in proto) proto="$v" ;; head) head="$v" ;; committed) leg_committed="$v" ;; stop) leg_stop="$v" ;; failed) failed+=("$v") ;; esac
    done <"$leg_res"
    # Only inner-leg mode writes `proto 1`; a stop it set still ends the loop when the wrapper then fails.
    if [ "$wrc" != 0 ] || [ "$proto" != 1 ] || [ -z "$head" ]; then
      echo "::error:: /$leg worktree run exited $wrc (proto '${proto}', head '${head}') — nothing merged" >&2; failed+=("$leg")
      [ "$leg_stop" != 1 ] || break
      continue
    fi
    if [ "$head" != "$base" ]; then
      hit=""
      if [ -n "${LADDER_PROTECTED_PATHS:-}" ] && { ! hit="$(protected_touched "$base" "$head")" || [ -n "$hit" ]; }; then
        echo "::error:: /$leg worktree commits refused — protected paths: ${hit:-list $LADDER_PROTECTED_PATHS bad, $head not a descendant of $base, or log failed}; not merged, no push or ship" >&2
        failed+=("$leg:protected"); refused=1; break
      fi
      if ! git -C "$REPO" merge -q --ff-only "$head"; then
        echo "::error:: /$leg cannot fast-forward $REPO to $head — not merged" >&2; failed+=("$leg:ff"); continue
      fi
      log "$leg: merged $(git -C "$REPO" log -1 --format='%h %s')"
    fi
    if [ "$leg_committed" = 1 ]; then committed=1; git -C "$REPO" rev-parse HEAD >"$UNSHIPPED"; fi
    [ "$leg_stop" != 1 ] || break
    continue
  fi
  before="$(git rev-parse HEAD)"

  # Nothing due → the skill's own `research: []` path (probe → empty patch → apply → commit) runs
  # here, no claude: those runs were ~60% of ladder spend (2026-10-11 audit).
  # The guard above proved the json clean, so a failed leg resets it and re-renders the gitignored md from it
  # (no md describing uncommitted state); the alert fires, and the next slot recovers on its own.
  restore() { git checkout -q -- "public/$leg.json"; npm run -s "$leg:render" >/dev/null 2>&1 || true; }
  if [ "${DRY_RUN:-0}" != 1 ]; then
    if ! state="$(npm run -s "probe:$leg-tranches" -- --into="public/$leg.json" >/dev/null && npm run -s "$leg:state" -- --no-measure)"; then
      echo "::error:: $leg probe/state failed — skipping $leg" >&2; failed+=("$leg"); restore; continue
    fi
    rc=0
    # A passed calendar row that matters (`calendarOwed`) also routes to the skill: the empty patch's apply refuses it.
    # `today` + the state's clock `now`: apply re-plans on the same instant, so a window crossed in between never fails the empty patch.
    plan="$(printf '%s' "$state" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));if(j.research.length||j.calendarOwed?.length)process.exit(3);console.log(j.today,j.now)')" || rc=$?
    today="${plan%% *}"; now="${plan#* }"
    if [ "$rc" = 0 ]; then
      patch="$(mktemp --suffix=.json)"; echo '{"signs":{}}' >"$patch"
      if npm run -s "$leg:apply" -- "$patch" --today="$today" --now="$now" && git commit -q -m "docs($leg): live state $today" -- "public/$leg.json"; then
        log "$leg: nothing due — applied without claude: $(git log -1 --format='%h %s')"; committed=1; git rev-parse HEAD >"$UNSHIPPED"
      else
        echo "::error:: $leg no-research apply/commit failed" >&2; failed+=("$leg"); restore
      fi
      rm -f "$patch"; continue
    elif [ "$rc" != 3 ]; then
      echo "::error:: $leg state output unreadable (exit $rc) — skipping $leg" >&2; failed+=("$leg"); restore; continue
    fi
    # The skill's step 1, run here with its measure scripts: the prompt carries it, so claude makes no step-1 call.
    if ! state="$(npm run -s "$leg:state")"; then
      echo "::error:: $leg state (measured) failed — skipping $leg" >&2; failed+=("$leg"); restore; continue
    fi
  else
    state='<state>'
  fi

  # 5-minute cache: the longest gap between a leg's calls is ~3 min, so the 1h write price (2×) buys nothing.
  if [ "$claude_ok" != 1 ]; then
    echo "::error:: $leg needs claude — skipped (tools preflight failed)" >&2; failed+=("$leg"); [ "${DRY_RUN:-0}" = 1 ] || restore; continue
  fi
  # `claude -p` has no session scratchpad, so the skill's `<scratchpad>` resolved to a fixed /tmp path: on
  # 2026-11-09 a stale /tmp/semis-patch.json from an earlier run blocked the patch Write ("not read yet"), the
  # parallel apply read that stale file, and the model's own `mkdir` for a fresh dir was denied → an ntfy push.
  # Each leg gets an empty dir of its own instead (removed by the EXIT trap).
  scratch="$SCRATCH_ROOT/$leg"; mkdir -p "$scratch"
  pad="This is a headless run. Your \`<scratchpad>\` is $scratch — empty, made for this leg; write the patch there."
  # DRY_RUN has no state print, so there the knobs alone select the pre-run.
  pre=0; pre_cost=0; need="$BUDGET"
  if [ "$PRERUN" = 1 ] && [[ " $PRERUN_LEGS " == *" $leg "* ]]; then
    if [ "${DRY_RUN:-0}" = 1 ] || printf '%s' "$state" | node -e 'process.exit(JSON.parse(require("fs").readFileSync(0,"utf8")).research?.length?0:1)'; then
      pre=1; need="$(awk -v b="$BUDGET" -v p="$PRERUN_BUDGET" 'BEGIN{printf "%.4f", b+p}')"
    fi
  fi
  if [ "${DRY_RUN:-0}" != 1 ] && [ "$AUTH" = api ]; then
    # Capped → only the claude call is skipped (no-claude legs still run); alerts once per cycle.
    if awk -v s="$spent" -v b="$need" -v c="$CAP" 'BEGIN{exit !(s+b>c)}'; then
      if [ "$(cat "$CAP_ALERTED" 2>/dev/null)" != "$cycle" ]; then
        echo "::error:: /$leg skipped — cycle spend cap: \$$spent since $cycle + \$$need leg budget > \$$CAP (LADDER_CYCLE_CAP_USD, ledger $SPEND_FILE)" >&2
        failed+=("$leg:cycle-cap"); echo "$cycle" >"$CAP_ALERTED"
      else
        log "/$leg skipped — cycle spend cap (\$$spent of \$$CAP; alerted earlier this cycle)"
      fi
      restore; continue
    fi
    # Reserve the whole budget first: a leg killed mid-run (timeout, sleep) stays booked.
    book "$(awk -v s="$spent" -v b="$need" 'BEGIN{printf "%.4f", s+b}')"
  fi
  rung_a=""
  if [ "$pre" = 1 ]; then
    if prerun; then
      if [ "${DRY_RUN:-0}" = 1 ]; then tbl='<rung-a.md>'; pl='<prelabels.json>'; else tbl="$(cat "$scratch/rung-a.md")"; pl="$(cat "$scratch/prelabels.json")"; fi
      rb=""; if [ "$rung_b" = 1 ]; then rb="

rungB — Rung B's extended searches + dating fetches already ran; its findings table (make none of them again; only opening fetches remain):
$(cat "$scratch/rung-b.md")"; fi
      rung_a="

rungA — Rung 0+A already ran; its findings table (make no Rung 0+A call):
$tbl$rb

prelabels — mechanical pre-labels for those rows (JSON):
$pl

Pass \`--prelabels=$scratch/prelabels.json\` to \`$leg:apply\`."
    fi
    if [ "${DRY_RUN:-0}" != 1 ] && [ "$AUTH" = api ]; then
      # Pre-run cost booked now; the Opus budget stays reserved on top.
      spent="$(awk -v s="$spent" -v c="$pre_cost" 'BEGIN{printf "%.4f", s+c}')"
      book "$(awk -v s="$spent" -v b="$BUDGET" 'BEGIN{printf "%.4f", s+b}')"
    fi
  fi
  cmd=(env FORCE_PROMPT_CACHING_5M=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude -p)
  if [ "$AUTH" = api ]; then
    # Not --bare: it caps --tools at Bash/Read/Edit. The SKILL rides in the system prompt.
    cmd+=("Run the ladder skill in your system prompt. $pad Its step-1 \`$leg:state\` print (the probe already ran):
$state$rung_a"
      --append-system-prompt-file ".claude/skills/$leg/SKILL.md")
  else
    cmd+=("/$leg $state$rung_a

$pad")
  fi
  cmd+=("${claude_flags[@]}" --output-format json --verbose)
  if [ "${DRY_RUN:-0}" = 1 ]; then printf '%q ' "${cmd[@]}"; echo; continue; fi

  log "claude -p /$leg (model=$MODEL, effort=$EFFORT, budget=\$$BUDGET)"
  # The JSON transcript lands in $out; its closing text, permission mode and any denied tool calls are
  # read off it (the summary prints the text, so the journal still shows the run's answer).
  out="$(mktemp)"; err="$(mktemp)"; leg_denied="$(mktemp)"; res="$(mktemp)"
  crc=0; "${cmd[@]}" >"$out" 2>"$err" || crc=$?
  cat "$err" >&2
  src=0; node scripts/ladder-claude-summary.mjs "$out" "$leg_denied" "$res" || src=$?
  # A headless step 5 replies one word, so the lines the user acts on come straight off the state print.
  { printf '%s' "$state" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const p of j.pressDead??[])console.log(`pressDead ${p}`);for(const r of j.research??[])if(r.measured?.error)console.log(`measured {error} ${r.sign}: ${r.measured.error}`)' |
    while IFS= read -r l; do log "$leg: $l"; done; } || echo "::warning:: /$leg state print unreadable — pressDead / measured errors not logged" >&2
  case "$src" in
    0) ;;
    # Sub runs keep ToolSearch, so their init may list WebFetch as deferred — only API runs gate on it.
    3) [ "$AUTH" != api ] || { echo "::error:: /$leg ran without WebFetch — its init tool list lacks it (policy-gated allow_web_fetch)" >&2; failed+=("$leg:no-webfetch"); } ;;
    *) echo "::warning:: /$leg transcript unreadable — its denied tool calls could not be checked" >&2 ;;
  esac
  while IFS= read -r d; do
    echo "::warning:: /$leg tool call denied: $d" >&2
  done <"$leg_denied"
  # Pushed per leg, at once — a run killed later (timeout, abort) cannot drop it. Capped below ntfy's
  # 4 KiB message limit (larger bodies arrive as an attachment).
  if [ -s "$leg_denied" ]; then
    # High only when the leg did not land [USER 2026-11-14]: a run that recovered (its own pathspec'd commit,
    # i.e. apply went through — same path attribution as the commit check below) pushes at low priority.
    prio=high; how="apply did not land"
    [ -z "$(git log --format=%h "$before..HEAD" -- "public/$leg.json")" ] || { prio=low; how="recovered, leg committed"; }
    # Whole lines only: a byte cut mid-UTF-8 makes ntfy deliver the body as an attachment.
    { LC_ALL=C awk '{n+=length($0)+1; if(n>3500){m++; next} print} END{if(m) print "… +" m " more"}' "$leg_denied"; echo "make ladder-log"; } |
      scripts/ladder-notify.sh "crash-dash ladder /$leg: $(wc -l <"$leg_denied") tool call(s) denied, $how" "$prio" no_entry_sign ||
      { echo "::error:: ntfy push of /$leg's denied tool calls failed" >&2; failed+=("$leg:denied-ntfy"); }
  fi
  if [ "$crc" != 0 ]; then
    echo "::error:: /$leg run exited non-zero — see its output above" >&2
    failed+=("$leg")
  fi

  # Console API usage limit? (1 = no; 0 = yes, paused; 2 = yes, no readable date; else helper broke.)
  # Scans the closing text + stderr only — never tool output or pages the model read.
  cat "$err" >>"$res"
  prc=0; reset_at="$(scripts/ladder-pause.sh detect "$res")" || prc=$?
  credit=0; ! grep -qiF 'credit balance is too low' "$res" || credit=1
  if [ "$AUTH" = api ]; then
    # No readable cost (claude died before its result) → book the whole leg budget.
    cost="$(node -e 'const r=[].concat(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))).findLast(m=>m.type==="result");const c=r?.total_cost_usd;if(typeof c!=="number"||!isFinite(c))process.exit(1);console.log(c)' "$out" 2>/dev/null)" || cost="$BUDGET"
    spent="$(awk -v s="$spent" -v c="$cost" 'BEGIN{printf "%.4f", s+c}')"
    book "$spent"
    [ "$pre" != 1 ] || cost="$(awk -v p="$pre_cost" -v c="$cost" 'BEGIN{printf "%.4f", p+c}')"
    log "$leg: cost \$$cost — cycle $cycle spend \$$spent of \$$CAP cap"
  fi
  rm -f "$out" "$err" "$leg_denied" "$res"; out=""; err=""; leg_denied=""; res=""

  # Attribute by path, not by HEAD: a sibling session may commit on main during the run. Runs before
  # the limit check, so a leg that committed and then hit the limit still ships.
  mine="$(git log --format='%h %s' "$before..HEAD" -- "public/$leg.json")"
  if [ -n "$mine" ]; then
    log "$leg: committed $mine"
    committed=1
    git rev-parse HEAD >"$UNSHIPPED"
  else
    log "$leg: no commit — the run changed nothing (or stopped before apply; see the output above)"
    # Every healthy run commits (apply stamps runAt), so no commit = the skill stopped on an error
    # while `claude -p` still exited 0. The API-limit and credit cases report themselves below.
    [ "$prc" != 1 ] || [ "$credit" = 1 ] || { echo "::error:: /$leg made no commit — the skill stopped before apply" >&2; failed+=("$leg:no-commit"); }
    restore
    [ "$before" = "$(git rev-parse HEAD)" ] || log "$leg: HEAD moved by another session's commit — not attributed, not a ship trigger"
  fi

  # Limit hit → every run pauses until the reset time the message names, and this run stops here:
  # the remaining legs would hit the same wall. One alert says so (this run exits 1).
  if [ "$prc" != 1 ]; then
    case "$prc" in
      0) echo "::error:: /$leg hit the API usage limit — ladder runs paused until $reset_at (scripts/ladder-pause.sh)" >&2 ;;
      2) echo "::error:: /$leg hit the API usage limit but the message names no readable reset date — NOT paused" >&2 ;;
      *) echo "::error:: API usage limit check failed (scripts/ladder-pause.sh exit $prc) — NOT paused" >&2 ;;
    esac
    failed+=("$leg:api-limit")
    stop=1; break
  fi
  # Empty balance → stop here; like the API-limit break it skips no-claude legs too. Committed legs still ship.
  if [ "$credit" = 1 ]; then
    echo "::error:: /$leg credit balance too low — remaining legs skipped; check promo vs purchased credit on the Console Billing page" >&2
    failed+=("$leg:credit")
    stop=1; break
  fi
done
if [ -n "$INNER_LEG" ]; then
  { echo "proto 1"; echo "head $(git rev-parse HEAD)"; echo "committed $committed"; echo "stop $stop"
    for f in "${failed[@]}"; do echo "failed $f"; done; } >"$LADDER_LEG_RESULT_FILE"
  exit 0
fi
while IFS= read -r line; do echo "::error:: ntfy push failed — $line" >&2; failed+=("${line%%:*}:ntfy"); done <"$LADDER_PUSH_FAILED_FILE"
rm -f "$LADDER_PUSH_FAILED_FILE"
[ "$legs" -gt 0 ] || { echo "::error:: LEGS='${LEGS:-}' names no leg" >&2; failed+=("legs"); }
[ "$refused" = 0 ] || finish # a protected-path refusal: no push, no ship
[ "${DRY_RUN:-0}" = 1 ] && finish

# ── Ship ──────────────────────────────────────────────────────────────────────────────
# One ship for all legs, on a commit this run or a leftover marker. Every exit goes via finish.
push() {
  if git push -q origin HEAD:main; then log "pushed main"
  else echo "::error:: git push failed — the commits stay local" >&2; failed+=("push"); fi
}
if [ "${SHIP:-1}" != 1 ]; then
  if [ "${PUSH:-0}" = 1 ] && [ "$committed" = 1 ]; then push; fi
  finish
fi
[ -f "$UNSHIPPED" ] || { log "nothing unshipped — no ship"; finish; }
if release_lock_busy; then
  log "another release or CI-stack run (ship.sh / smoke-cron.sh / run-integration-tests.sh) holds the release lock (shared crash-dash-ci stack) — ship deferred to the next slot"
  finish
fi
if [ -z "${VERCEL_BIN:-}" ] && ! VERCEL_BIN="$(npx --yes --package=vercel@latest -c 'command -v vercel')"; then
  echo "::error:: vercel CLI not resolvable via npx — ship deferred" >&2; failed+=("ship"); finish
fi
if ! WHOAMI="$("$VERCEL_BIN" whoami 2>/dev/null | tail -n1)" || [ -z "$WHOAMI" ]; then
  push
  log "vercel login stale — ship deferred (marker $(cut -c1-8 <"$UNSHIPPED") kept for your next ${RELEASE_MAKE[*]} ship)"
  echo "::error:: ship deferred (stale login) — prod still serves the old state; vercel login + ${RELEASE_MAKE[*]} ship" >&2; failed+=("ship-deferred")
  finish
fi
log "${RELEASE_MAKE[*]} ship (releases HEAD $(git rev-parse --short HEAD); unshipped marker $(cut -c1-8 <"$UNSHIPPED"))"
if "${RELEASE_MAKE[@]}" ship; then
  rm -f "$UNSHIPPED"
  log "shipped — prod serves $(git rev-parse --short HEAD)"
else
  echo "::error:: ${RELEASE_MAKE[*]} ship failed — see its SHIP_LOG path above; the commit stays local and is retried next slot" >&2
  failed+=("ship")
fi
finish
