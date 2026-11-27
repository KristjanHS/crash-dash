#!/usr/bin/env bash
# scan-sec.sh — the security scan gate. Two modes, one script:
#
#   scan-sec.sh          the FAST static trio (~20 s), wired into `scripts/ship.sh` as a step
#                        ABOVE the first prod mutation (`Migrate prod (local)`), beside the
#                        imprint / WAF gates. `npm run scan:sec`.
#   scan-sec.sh --full   the trio PLUS the 9-pack semgrep pass over src api public .github
#                        (~40 s). MANUAL only — `make scan-sec-full`. Never called from ship,
#                        never from a git hook (pre-push stays the store/migration gate it is).
#
# FAILS CLOSED, by the same doctrine as pre-push: a tool that cannot RUN is a non-zero exit and
# blocks the ship. A missing scanner is an unscanned release, not a skipped nicety — so there is
# deliberately no `command -v … || skip` path anywhere below.
#
# ⛔ Why the zizmor step counts files instead of trusting the exit code: zizmor SILENTLY SKIPS a
# workflow it cannot parse and still prints "No findings to report. Good job!" with exit 0. On
# 2026-08-20 an empty `with:` block made ci.yml unparseable and the only tell was the per-file
# `completed` line count dropping 7 -> 6. So the assert below is on the COUNT, not the findings:
# every file in .github/workflows/ must be audited, or this gate dies. Falsifier: break a
# workflow's YAML and re-run — the count drops and the step exits 1.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

FULL=0
case "${1:-}" in
  --full) FULL=1 ;;
  "") ;;
  *) echo "usage: scan-sec.sh [--full]" >&2; exit 2 ;;
esac

sec_step() { printf '\n\033[1;36m·· %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✗ scan-sec: %s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "\`$1\` is not installed — this gate fails closed; install it (see \`make scan-sec-full\`) or the release goes out unscanned."; }

# ── 1. secrets, over the TRACKED surface (history) ───────────────────────────────────────
# `gitleaks git`, not `gitleaks dir`: the worktree form flags the four untracked, gitignored
# `.env*` files on every run, and a permanently-red scanner is one nobody reads. Config +
# falsifiers: .gitleaks.toml.
#
# INCREMENTAL by default: history is immutable, so a commit already scanned under the SAME
# rules by the SAME binary cannot grow a new secret — re-proving it cost 23.5 s of the trio's
# 24.5 s (measured 2026-08-20, ~157 MB re-read per ship). The cache records the last sha proven
# clean; the scan is then `<that sha>..<rev>`. THREE conditions void it and force a full-history
# pass, because each makes "already scanned" a false claim:
#   · .gitleaks.toml or .gitleaksignore changed — new rules/allowlists/ignores re-judge old commits;
#   · the gitleaks version changed — same, for built-in rules;
#   · the shallow graft boundary changed — a deepened fetch made older commits visible;
#   · the cached sha is not an ancestor of the rev — history was rewritten under us.
# Anything unreadable (no cache, corrupt line, unknown sha) is treated as "never scanned" →
# full pass. The cache only ever skips commits a green run covered under the same key; it is not
# a suppression list, and it holds no findings.
# Falsifiers (both demonstrated 2026-08-20, both exit 1): commit a secret on top of a primed
# cache → the delta pass flags it; edit .gitleaks.toml → the next run says "full history".
# `--full` (make scan-sec-full) always scans the whole history, so the manual audit is total.
#
# Any data-only `backups` ref (local, or fetched from a remote such as a separate backup repo) is
# SUBTRACTED from `--all` in both forms:
# each of its commits is one large DB snapshot (supabase/backups/*.sql, the branch's only path —
# `git log --name-only backups` shows nothing else), and generating those diffs alone
# cost 29 s per ship even with the path allowlisted in .gitleaks.toml (measured 2026-09-05; with
# the regex pass too, 3m37s of a 3m38s step). That allowlist row stays as the net for a dump that
# lands on any OTHER ref, so the subtraction removes a code-free branch, not a scanned path.
sec_step "gitleaks (tracked history)"
need gitleaks

# The rev the BASELINE is recorded at — not a scope limit. ship.sh passes its PINNED $SHIP_SHA so
# the cache advances to the released commit rather than to a tip that moved past it; the scan
# itself covers every ref (see the --all form below), exactly as the pre-cache full pass did.
SCAN_REV="${SCAN_SEC_REV:-HEAD}"
git rev-parse --verify -q "$SCAN_REV^{commit}" >/dev/null || fail "SCAN_SEC_REV='$SCAN_REV' is not a commit in this repo."
SCAN_SHA="$(git rev-parse "$SCAN_REV^{commit}")"

# One cache file per OBJECT STORE, not per machine: `git rev-parse --git-common-dir` is shared by
# a repo and its linked worktrees (so the shipping worktree reuses the baseline) but differs for a
# separate clone, whose shas the ancestor check would reject anyway — degrading to a full scan,
# which is safe but pointlessly slow to re-derive on every alternation.
GL_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/crash-dash"
GL_CACHE="$GL_CACHE_DIR/gitleaks-last-clean-$(cd "$(git rev-parse --git-common-dir)" && pwd -P | sha256sum | cut -c1-12)"
# The key every cached sha is qualified by: config content + binary version. Different key ⇒
# the cached verdict was reached under different rules and is discarded, not adapted.
# THREE parts, and the third is the one a review caught missing: this repo is SHALLOW (17 grafts).
# A `git fetch --unshallow`/`--deepen` makes thousands of ancestor commits visible for the first
# time — commits an `A..B` range excludes BY DEFINITION, since they are reachable from A. Without
# the boundary in the key all three other guards pass, the newly-visible history is skipped, and
# line ~110 seals the gap in permanently. Hashing `.git/shallow` (absent = unshallowed = a
# different key) voids the cache on exactly that event.
gl_key() {
  printf '%s|%s|%s' \
    "$([ -r .gitleaks.toml ] && cat .gitleaks.toml .gitleaksignore 2>/dev/null | sha256sum | cut -d' ' -f1)" \
    "$(gitleaks version 2>/dev/null | tr -d '\n')" \
    "$(sha256sum "$(git rev-parse --git-common-dir)/shallow" 2>/dev/null | cut -d' ' -f1 || echo unshallow)"
}
GL_KEY="$(gl_key)"
# Every half is asserted: a `gitleaks version` that changes format would otherwise leave an empty
# field, and the "binary changed" condition would go silently inert while still reading as armed.
{ [ -n "$(printf '%s' "$GL_KEY" | cut -d'|' -f1)" ] && [ -n "$(printf '%s' "$GL_KEY" | cut -d'|' -f2)" ]; } \
  || fail "cannot build the gitleaks cache key (.gitleaks.toml unreadable, or \`gitleaks version\` gave nothing) — refusing to run under a key that cannot detect a rules or binary change."

# `^ref` form, never `--not`: `--not` flips the sense of EVERY rev after it, so `--not $base ^ref`
# re-INCLUDES the backups ref. No trailing whitespace either: gitleaks splits --log-opts on spaces
# and hands git an empty "" arg, which makes `git log` scan 0 commits and report a clean green
# (measured 2026-09-05 on 8.30.1 — twice). Both traps are what the count guard below catches.
# Empty when no backups ref exists locally (fresh clone).
GL_SKIP_REFS="$(git for-each-ref --format='^%(refname)' refs/heads/backups 'refs/remotes/*/backups' | paste -sd' ' -)"
# gitleaks CAN silently scan nothing (see above) and exit 0. Its "N commits scanned." line is
# held against git's own `--no-merges` count of the same rev set: gitleaks counts only commits
# that emit a TEXT patch (merges, empty and binary-only commits are invisible to it — 4679 vs
# 4792 on 2026-09-05), so exact parity is unattainable and the bar is ≥ 90 %. A 0-for-thousands
# (the trap above) or a partial skip fails closed. Falsifier (demonstrated 2026-09-05): a
# trailing space in the log-opts → gitleaks 0, git 4792 → ✗ before the cache is written.
gl_scan() { # $1 = git's --no-merges commit count for the rev set, $2 = the log-opts string
  local out rc scanned
  out="$(gitleaks git . --no-banner --redact --log-opts="$2" 2>&1)"; rc=$?
  printf '%s\n' "$out" | grep -v '^$'
  [ "$rc" -eq 0 ] || return "$rc"
  scanned="$(printf '%s\n' "$out" | sed -n 's/.*[^0-9]\([0-9][0-9]*\) commits scanned.*/\1/p' | tail -1)"
  [ "${scanned:-x}" != x ] || fail "gitleaks printed no 'N commits scanned.' line — output format changed; the coverage guard cannot judge it, refusing to record a green."
  [ "$((scanned * 10))" -ge "$(($1 * 9))" ] || fail "gitleaks scanned $scanned commit(s) but git counts $1 non-merge commits in the same rev set (log-opts: $2) — the scan did NOT cover the history it claims to; refusing to record a green."
}

GL_BASE=""
if [ "${SCAN_SEC_FULL_HISTORY:-0}" != "1" ] && [ "$FULL" -eq 0 ] && [ -r "$GL_CACHE" ]; then
  read -r cached_sha cached_key <"$GL_CACHE" || true
  if [ "${cached_key:-}" = "$GL_KEY" ] &&
     git rev-parse --verify -q "${cached_sha:-missing}^{commit}" >/dev/null &&
     git merge-base --is-ancestor "$cached_sha" "$SCAN_SHA" 2>/dev/null; then
    GL_BASE="$cached_sha"
  fi
fi

if [ -n "$GL_BASE" ]; then
  # `--all ^<base>`, NOT `<base>..<rev>`. A bare `gitleaks git` traverses every REF; a
  # two-dot range traverses one line of descent, so a secret committed on an unmerged branch goes
  # unseen until it merges. Measured 2026-08-20 on gitleaks 8.30.1 with a PEM key on a side
  # branch: no --log-opts → exit 1, `<root>..HEAD` → exit 0 (missed), `--all --not <root>` →
  # exit 1. The scope stays "every ref but backups"; only proven ancestry + snapshots are subtracted.
  # shellcheck disable=SC2086 # GL_SKIP_REFS is a deliberate space-separated ref list
  n_new="$(git rev-list --count --no-merges --all "^$GL_BASE" $GL_SKIP_REFS)"
  printf '   incremental: %s non-merge commit(s) across all refs (minus backups) since %s (rules+binary+graft unchanged)\n' "$n_new" "$(git rev-parse --short "$GL_BASE")"
  gl_scan "$n_new" "--all ^$GL_BASE${GL_SKIP_REFS:+ $GL_SKIP_REFS}" \
    || fail "gitleaks found a secret in the commits since $(git rev-parse --short "$GL_BASE") — do NOT ship. If it is a verified non-secret, allowlist it NARROWLY in .gitleaks.toml (never blanket-disable a rule)."
else
  # shellcheck disable=SC2086
  n_all="$(git rev-list --count --no-merges --all $GL_SKIP_REFS)"
  printf '   full history: %s non-merge commit(s) across all refs minus backups (no usable cache — first run, changed rules/binary, or rewritten history)\n' "$n_all"
  gl_scan "$n_all" "--all${GL_SKIP_REFS:+ $GL_SKIP_REFS}" \
    || fail "gitleaks found a secret in tracked history — do NOT ship. If it is a verified non-secret, allowlist it NARROWLY in .gitleaks.toml (never blanket-disable a rule)."
fi

# Only reached when the scan above exited 0: $SCAN_SHA and everything reachable from it is
# clean under $GL_KEY. Written last so a failed/interrupted scan never advances the baseline.
# tmp+mv, because the cache is SHARED across linked worktrees and this repo runs concurrent
# sessions: a bare `>` truncates first, so a sibling could read a half-written line. (It would
# degrade to a full scan, not a false green — but the fix is one line.)
mkdir -p "$GL_CACHE_DIR" &&
  printf '%s %s\n' "$SCAN_SHA" "$GL_KEY" >"$GL_CACHE.$$" &&
  mv "$GL_CACHE.$$" "$GL_CACHE" || rm -f "$GL_CACHE.$$"

# ── 2. dependency vulnerabilities, off the lockfile ──────────────────────────────────────
sec_step "osv-scanner (lockfile)"
need osv-scanner
osv-scanner scan source --lockfile=package-lock.json || fail "osv-scanner reported a dependency vulnerability — resolve or explicitly accept it before shipping."

# ── 3. GitHub Actions ────────────────────────────────────────────────────────────────────
sec_step "zizmor (.github/workflows)"
need zizmor
ZOUT="$(mktemp)"; trap 'rm -f "$ZOUT"' EXIT
zizmor --offline .github/workflows/ >"$ZOUT" 2>&1; zrc=$?
cat "$ZOUT"
[ "$zrc" -eq 0 ] || fail "zizmor reported a GitHub Actions finding (exit $zrc) — fix it, or add a NARROW inline \`# zizmor: ignore[<rule>]\` with a comment naming why."

# The parse-coverage assert (see the header block).
want=$(find .github/workflows -maxdepth 1 \( -name '*.yml' -o -name '*.yaml' \) | wc -l | tr -d ' ')
got=$(grep -c 'completed .github/workflows/' "$ZOUT" || true)
[ "$want" -gt 0 ] || fail "no workflow files found under .github/workflows/ — the zizmor step would be vacuous."
[ "$got" -eq "$want" ] || fail "zizmor audited $got of $want workflow files — it SKIPS a file it cannot parse and still exits 0. Find the unparseable workflow (\`zizmor --offline .github/workflows/<f>\` one at a time) and fix its YAML."
printf '   zizmor audited %s/%s workflows\n' "$got" "$want"

# ── 4. SAST — manual mode only (~40 s) ───────────────────────────────────────────────────
if [ "$FULL" -eq 1 ]; then
  sec_step "semgrep 9-pack (src api public .github)"
  need semgrep
  semgrep scan --metrics=off --error \
    --config=p/typescript --config=p/javascript --config=p/nodejs \
    --config=p/owasp-top-ten --config=p/secrets --config=p/xss \
    --config=p/sql-injection --config=p/github-actions --config=p/security-audit \
    src api public .github || fail "semgrep reported a finding — triage it before shipping."
fi

printf '\n\033[1;32m✓ scan-sec: clean%s\033[0m\n' "$([ "$FULL" -eq 1 ] && echo ' (full, incl. semgrep)')"
