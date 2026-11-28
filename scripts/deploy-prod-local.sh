#!/usr/bin/env bash
#
# deploy-prod-local.sh <SRC_DIR> — deploy a tree to Vercel PROD from the laptop.
#
# The local code-deploy path (ci.yml's `deploy` job runs only in a repo that sets CI_DEPLOY=true). Invoked by `make ship`.
# The checkout's prod config ($PROD_CONFIG_DIR, scripts/lib/prod-config.sh) carries the Vercel link
# (.vercel/project.json: the org/project IDs), so the CLI needs only auth: a VERCEL_TOKEN in the
# env / .env.prod, or an interactive `vercel login` already done on this machine.
#
# SRC_DIR is the payload Vercel uploads — REQUIRED, and never this checkout (a relative path resolves
# against the caller's cwd): before any network call, scripts/stamp-deploy-config.ts stamps the
# checkout's prod config over the repo copy's placeholders IN SRC_DIR, so an in-place run would
# rewrite tracked files (refused). ship.sh passes a
# detached-HEAD worktree, so a `make ship` deploy is byte-for-byte the commit it then pushes, plus
# the stamp — see ship.sh §5. Creds + the vercel link always come from the checkout's prod config
# (both gitignored, so a clean checkout of HEAD has neither).
#
# ⚠ A break-glass run against a hand-made tree deploys public/*.js UNBUNDLED and UNMINIFIED.
# `make ship` (ship.sh §5) bundles + minifies the detached deploy worktree before calling this
# script; that step deliberately does NOT live here. Heavier over the wire — correct, just not
# optimal.
#
# Knobs (all optional): DEPLOY_TIMEOUT (s, default 900) caps the wait for READY · DEPLOY_POLL
# (s, default 10) is the status-poll interval · ALIAS_WAIT (s, default 120) caps the wait for the
# production alias to attach after READY · DEPLOY_ATTEMPTS (default 3) is how many times the
# create-deployment call may be retried when the upload dies mid-flight.
#
# Not knobs: the production domain asserted once the build is READY (and warmed after it) is always the prod
# config's PROD_ALIAS (no default). It, SUPABASE_URL and SUPABASE_ANON_KEY — the stamp's three keys — and the
# Vercel link's orgId + projectId are read from the config's FILES alone: a file lacking one refuses, even with
# that key in the env, so an ambient value never names the target.
#
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# SRC_DIR made absolute against the CALLER's cwd, before the cd below re-roots relative paths at $REPO.
SRC_ARG="${1:-}"
case "$SRC_ARG" in "" | /*) ;; *) SRC_ARG="$PWD/$SRC_ARG" ;; esac
cd "$REPO"

# Prod-writes switch (scripts/lib/prod-writes.sh): refuse before the CLI runs
# (before the prod config is loaded: the guard needs nothing from it, and a refused run never loads prod creds).
# shellcheck source=lib/prod-writes.sh
. "$REPO/scripts/lib/prod-writes.sh"
require_prod_writes "the deploy" || exit 1

# An in-place deploy would stamp (rewrite) this checkout's tracked files — refuse before loading creds.
[ -n "$SRC_ARG" ] || { echo "::error:: deploy-prod-local.sh needs a deploy tree (SRC_DIR) — never this checkout; use \`make ship\`." >&2; exit 1; }
SRC="$(cd "$SRC_ARG" && pwd -P)" # physical on both sides: a symlink to the checkout is still the checkout
[ "$SRC" != "$(cd "$REPO" && pwd -P)" ] || { echo "::error:: refusing to deploy this checkout in place ($REPO) — pass a deploy tree; use \`make ship\`." >&2; exit 1; }

# The checkout's prod config (scripts/lib/prod-config.sh): `<dir>/.env.prod` into the env (a non-empty env key wins,
# except an identity key the file contradicts → refuse) + VERCEL_ORG_ID / VERCEL_PROJECT_ID from
# `<dir>/.vercel/project.json`. Either file missing → one ::error:: line, nothing deployed.
# shellcheck source=lib/prod-config.sh
. "$REPO/scripts/lib/prod-config.sh"
load_prod_config || exit 1
CFG_DIR="$(prod_config_dir)"
# The deploy's target, from the config's FILES alone: the load above lets an env value win over a file that lacks
# the key (only a value the file contradicts refuses), so the stamp's keys and the Vercel ids are re-read in a
# subshell with them unset — a file lacking one (or no project.json at all) refuses here, one `no target configured`
# line, instead of stamping an ambient Supabase project into public JS or deploying under an ambient org.
# `%q` re-quotes each value for the one eval below.
CFG_TARGET="$(
  unset SUPABASE_URL SUPABASE_ANON_KEY PROD_ALIAS VERCEL_ORG_ID VERCEL_PROJECT_ID
  load_prod_config --only SUPABASE_URL,SUPABASE_ANON_KEY,PROD_ALIAS,VERCEL_ORG_ID,VERCEL_PROJECT_ID \
    && printf 'CFG_SUPABASE_URL=%q CFG_SUPABASE_ANON_KEY=%q CFG_PROD_ALIAS=%q' "$SUPABASE_URL" "$SUPABASE_ANON_KEY" "$PROD_ALIAS"
)" || exit 1
eval "$CFG_TARGET"
PROD_ALIAS="$CFG_PROD_ALIAS"

# The link config is gitignored, so a HEAD worktree has no .vercel/ — graft the config's in (checked above: a
# file carrying both ids), else the CLI would treat SRC as an unlinked project and interactively re-create one.
mkdir -p "$SRC/.vercel"
cp "$CFG_DIR/.vercel/project.json" "$SRC/.vercel/project.json"
echo "▶ deploying from $SRC, linked via $CFG_DIR/.vercel"

# Stamp the checkout's prod config over the payload's placeholders — after ship.sh's bundle + minify, and before
# any network call (CLI resolve, whoami, roster). Refuses (nothing written) on a missing key or any placeholder
# left: never ships one.
# The checkout's own tsx bin when installed: `npx` loads npm's install/registry stack (~200 modules, ~350 ms)
# before it ever looks in node_modules/.bin. No install → `npx tsx`.
TSX=("$REPO/node_modules/.bin/tsx")
[ -x "${TSX[0]}" ] || TSX=(npx tsx)
SUPABASE_URL="$CFG_SUPABASE_URL" SUPABASE_ANON_KEY="$CFG_SUPABASE_ANON_KEY" PROD_ALIAS="$CFG_PROD_ALIAS" \
  "${TSX[@]}" "$REPO/scripts/stamp-deploy-config.ts" "$SRC" || { echo "::error:: deploy config stamp refused — nothing was deployed." >&2; exit 1; }

# ── Deploy, then wait in the open ─────────────────────────────────────────────────────────
# A blocking `vercel deploy` prints "Building…" the instant the upload lands — even while the
# deployment is still QUEUED for a build machine — with no elapsed counter and no upper bound.
# On 2026-07-25 one sat 5m01s in INITIALIZING (platform-side; the build itself was the usual
# 48s) and `make ship` read as hung, parked between an irreversible prod migrate and the push.
# So: create with --no-wait and poll readyState ourselves — true state, elapsed seconds, and a
# hard cap that fails loudly instead of blocking forever.
DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-900}"
DEPLOY_POLL="${DEPLOY_POLL:-10}"
DEPLOY_ATTEMPTS="${DEPLOY_ATTEMPTS:-3}"

# Resolve the CLI ONCE — the poll loop reruns it every $DEPLOY_POLL seconds, and each
# `npx …vercel@latest` re-checks the registry for "latest".
# Overridable so the retry/poll logic can be exercised against a stub CLI without deploying.
VERCEL_BIN="${VERCEL_BIN:-$(npx --yes --package=vercel@latest -c 'command -v vercel')}"

# --token if provided (CI-style, non-interactive); else rely on a prior `vercel login`.
# An EMPTY `VERCEL_TOKEN=` in .env.prod is the intended local setup and is inert on both
# sides: this gate skips --token, and the CLI's own env branch tests the value's truthiness
# (dist/index.js `else if (process.env.VERCEL_TOKEN)`), so it never takes over auth either.
TOKEN_ARG=()
if [ -n "${VERCEL_TOKEN:-}" ]; then TOKEN_ARG=(--token "$VERCEL_TOKEN"); fi

# DEPLOY_DEBUG=1 (default) runs the create attempt under `vercel --debug`. The firehose is
# filtered off the console and kept in $DEPLOY_ERR, so a failure carries the API error code
# and request-id instead of the bare server string — see the auth notes below.
DEPLOY_DEBUG="${DEPLOY_DEBUG:-1}"
DEBUG_ARG=()
[ "$DEPLOY_DEBUG" = "1" ] && DEBUG_ARG=(--debug)
DEPLOY_ERR="$(mktemp -t crash-dash-deploy-stderr-XXXXXX)"

# Preflight the session ONCE, before the upload. `auth.json` holds an OAuth access token with
# an 8h TTL plus a ROTATING refresh token; every command silently refreshes when the access
# token has expired (`ensureAuthorized()`), and on a refresh failure it EMPTIES auth.json and
# returns WITHOUT an error — the command then runs unauthenticated and the API answers a bare
# `Error: Not authorized` naming neither auth nor tokens. Probing here turns that state into
# one actionable line instead of $DEPLOY_ATTEMPTS opaque retries.
if ! WHOAMI="$("$VERCEL_BIN" whoami "${TOKEN_ARG[@]}" 2>/dev/null | tail -n1)" || [ -z "$WHOAMI" ]; then
  echo "::error:: \`vercel whoami\` returned no user — this machine is not authenticated. Run \`vercel login\` (the stored OAuth token expires 8h after each refresh), then re-run." >&2
  exit 1
fi
echo "▶ vercel session OK — deploying as $WHOAMI"

# The payload commit's AUTHOR email must be on the Vercel team roster, else the platform BLOCKS the
# deployment before building. Roster = /v2/teams/<orgId>/members; DEPLOY_AUTHORS=a@x,b@y overrides it.
DEPLOY_AUTHORS="${DEPLOY_AUTHORS:-}"
AUTHOR_EMAIL="$(git -C "$SRC" log -1 --format=%ae 2>/dev/null || true)"
json_field() { node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]]??""))}catch{}' "$1" "$2"; }
if [ -z "$DEPLOY_AUTHORS" ]; then
  tok="${VERCEL_TOKEN:-}"
  auth_json="${XDG_DATA_HOME:-$HOME/.local/share}/com.vercel.cli/auth.json"
  [ -z "$tok" ] && [ -f "$auth_json" ] && tok="$(json_field "$auth_json" token)"
  org_id="${VERCEL_ORG_ID:-}"
  if [ -n "$tok" ] && [ -n "$org_id" ]; then
    DEPLOY_AUTHORS="$(curl -sf -H "Authorization: Bearer $tok" "https://api.vercel.com/v2/teams/$org_id/members?limit=100" | node -e '
      let s = ""
      process.stdin.on("data", d => (s += d)).on("end", () => {
        try { process.stdout.write((JSON.parse(s).members || []).map(m => m.email).filter(Boolean).join(",")) } catch {}
      })' || true)"
  fi
fi
if [ -z "$AUTHOR_EMAIL" ] || [ -z "$DEPLOY_AUTHORS" ]; then
  echo "::warning:: commit-author preflight skipped (author: ${AUTHOR_EMAIL:-unknown}, roster: ${DEPLOY_AUTHORS:-unresolved}) — a non-member author is BLOCKED by Vercel after upload."
else
  case ",$DEPLOY_AUTHORS," in
    *",$AUTHOR_EMAIL,"*) echo "▶ payload commit author $AUTHOR_EMAIL is on the Vercel team roster" ;;
    *)
      # Plain quotes only in these hints: on 2026-10-13 the backtick-quoted commands in the old hint
      # were EXECUTED on the laptop (`git config --remove-section user` ran), not printed.
      echo "::error:: payload commit $(git -C "$SRC" rev-parse --short HEAD) is authored as $AUTHOR_EMAIL — not on the Vercel team roster ($DEPLOY_AUTHORS); Vercel BLOCKS it before building." >&2
      echo "::error:: unblock now: land ONE commit with a roster author on top (an empty 'git commit --allow-empty' is enough — Vercel checks only the payload HEAD's author) and re-run. Rewriting the existing authors is a user call." >&2
      if [ "$AUTHOR_EMAIL" = "noreply@anthropic.com" ]; then
        echo "::error:: cause: the commit was made in a Claude cloud session with the container's own identity. Give the cloud environment a setup step that sets user.name/user.email --local in every attached clone, then cloud commits are authored as you." >&2
      else
        echo "::error:: cause: a git identity override on the machine that made the commit — run 'git config --show-origin user.email' there and fix the scope it names." >&2
      fi
      exit 1
      ;;
  esac
fi

# One field out of `vercel inspect --format json` (arrays come back space-joined). Prints ""
# when the call or the parse fails — a transient API blip must not abort a deploy that is
# still progressing server-side; only DEPLOY_TIMEOUT ends the wait.
inspect_field() {
  "$VERCEL_BIN" inspect --format json "$DEPLOY_URL" "${TOKEN_ARG[@]}" 2>/dev/null | node -e '
    let s = ""
    process.stdin.on("data", d => (s += d)).on("end", () => {
      try {
        const v = JSON.parse(s)[process.argv[1]]
        process.stdout.write(Array.isArray(v) ? v.join(" ") : String(v ?? ""))
      } catch {}
    })' "$1" || true
}

cd "$SRC"
# create_deployment — one `vercel deploy` attempt. Prints the deployment URL on stdout, or
# nothing when the attempt failed; NEVER returns non-zero (the retry loop below owns that
# decision, and `set -e` would otherwise kill the run on the first flaky upload).
#
# --no-wait: the Inspect/Production links go to stderr; stdout carries the deployment URL —
# but the SHAPE depends on the CLI. Up to ~v57 stdout was the bare URL; CLI 58.3.0 piped
# (non-TTY) emits a pretty-printed JSON object instead, so the old `tail -n1` captured its
# closing `}`. Every poll then inspected "}" , printed "still unreachable", and the run died
# at the DEPLOY_TIMEOUT cap while the deployment had been READY in 31s (2026-07-29 ship).
# So: accept BOTH shapes — parse JSON when the output is JSON, else take the last https:// line.
#
# stderr (upload progress, the Inspect/Production links, errors, and the --debug firehose) is
# captured to $DEPLOY_ERR rather than streamed, so the retry loop can CLASSIFY the failure;
# it is replayed to the console after the attempt with the debug lines filtered out. The cost
# is that the progress bar arrives in one burst at the end instead of live.
create_deployment() {
  : >"$DEPLOY_ERR"
  "$VERCEL_BIN" deploy --prod --yes --no-wait "${DEBUG_ARG[@]}" "${TOKEN_ARG[@]}" 2>"$DEPLOY_ERR" | node -e '
    let s = ""
    process.stdin.on("data", d => (s += d)).on("end", () => {
      let url = ""
      try {
        const j = JSON.parse(s)
        url = j.url || j.deploymentUrl || (Array.isArray(j.alias) ? j.alias[0] : "") || ""
      } catch {
        const lines = s.split("\n").map(l => l.trim()).filter(l => /^https?:\/\/\S+$/.test(l))
        url = lines[lines.length - 1] || ""
      }
      // Last resort (JSON whose URL key we do not know): any *.vercel.app host in the raw text.
      // vercel.com inspector links are excluded by the .vercel.app anchor.
      if (!url) url = (s.match(/[a-z0-9-]+(?:-[a-z0-9]+)*\.vercel\.app/gi) || []).pop() || ""
      if (url && !/^https?:\/\//.test(url)) url = "https://" + url
      process.stdout.write(url)
    })' || true
  # Two debug shapes, both on stderr (verified on the 2026-08-09 ship: 47 `> [debug]` from the
  # CLI's output manager, 151 `[client-debug]` from the deployment client — stdout stayed clean,
  # so the URL parse above is unaffected either way). Drop both from the console; the trace keeps
  # them.
  grep -av -E '^(> \[debug\]|\[client-debug\])' "$DEPLOY_ERR" >&2 || true
}

# Retry the CREATE step. On 2026-08-02 a ship died three times in a row with a bare
# `Error: fetch failed`, each time part-way through `Uploading […] (838.2KB/1.1MB)`: the CLI
# has no retry around its per-file POST to /v2/files, so one dropped connection aborts the
# whole deploy. Retrying is close to free because the upload is CONTENT-ADDRESSED — the API
# answers a re-create with `missing_files`, so attempt N+1 re-uploads only what never landed
# (that run: 1.1MB → 794KB → a single 46KB file, which then succeeded). Nothing here is
# irreversible: a create that fails leaves NO deployment behind (`vercel ls --prod` showed
# none), so a retry cannot double-deploy — the only cost of an unnecessary attempt is seconds.
DEPLOY_URL=""
attempt=1
while :; do
  DEPLOY_URL="$(create_deployment)"
  [ -n "$DEPLOY_URL" ] && break
  # An authorization rejection is NOT a flaky upload — retrying it re-runs the same rejected
  # call and buries the cause under identical output (2026-08-09 08:25: three attempts, three
  # bare `Error: Not authorized`, no diagnosis). Stop on the first one and hand over the trace.
  if grep -aqiE '(^|[^a-z])(not authorized|forbidden|401|403)([^a-z]|$)' "$DEPLOY_ERR"; then
    echo "::error:: vercel rejected the deploy as UNAUTHORIZED on attempt $attempt — not retrying (a 403 is not a flaky upload)." >&2
    echo "::error:: full CLI trace (--debug when DEPLOY_DEBUG=1, the default): $DEPLOY_ERR" >&2
    echo "::error:: triage: \`vercel whoami\` passed at preflight, so the session was live when the upload started — read the trace for the API error code + request-id before assuming a credential problem." >&2
    exit 1
  fi
  if [ "$attempt" -ge "$DEPLOY_ATTEMPTS" ]; then
    echo "::error:: vercel deploy printed no deployment URL after $attempt attempt(s) — CLI trace: $DEPLOY_ERR" >&2
    exit 1
  fi
  echo "::warning:: deploy attempt $attempt/$DEPLOY_ATTEMPTS produced no deployment URL — retrying in 5s (uploads are content-addressed; only the missing files re-upload)."
  attempt=$((attempt + 1))
  sleep 5
done

started=$SECONDS
last=""
while :; do
  state="$(inspect_field readyState)"
  elapsed=$((SECONDS - started))
  if [ -n "$state" ] && [ "$state" != "$last" ]; then
    printf '  [%4ds] %s\n' "$elapsed" "$state"
    last="$state"
  elif [ "$elapsed" -ge 60 ] && [ $((elapsed % 60)) -lt "$DEPLOY_POLL" ]; then
    printf '  [%4ds] still %s …\n' "$elapsed" "${state:-unreachable}"
  fi
  case "$state" in
    READY) break ;;
    ERROR | CANCELED)
      echo "::error:: deployment $state after ${elapsed}s — logs: vercel inspect --logs $DEPLOY_URL" >&2
      exit 1
      ;;
    BLOCKED)
      # Terminal: nothing was built. Vercel blocks a deploy whose commit author is not a team member.
      echo "::error:: deployment BLOCKED after ${elapsed}s — payload author: $(git -C "$SRC" log -1 --format='%an <%ae>' 2>/dev/null); see https://vercel.com/docs/deployments/troubleshoot-project-collaboration#team-configuration" >&2
      exit 1
      ;;
  esac
  if [ "$elapsed" -ge "$DEPLOY_TIMEOUT" ]; then
    echo "::error:: still ${state:-unreachable} after ${elapsed}s (cap ${DEPLOY_TIMEOUT}s — raise with DEPLOY_TIMEOUT=)." >&2
    echo "::error:: it may still finish server-side; nothing was cancelled. Watch: vercel inspect $DEPLOY_URL" >&2
    exit 1
  fi
  sleep "$DEPLOY_POLL"
done

# --no-wait hands the wait to us, so no local process assigns the production domain — Vercel
# aliases server-side once the build is READY. Assert that landed: a READY deploy that never
# took the alias means prod silently keeps serving the PREVIOUS build. Retried, because the
# alias write lands during Vercel's POST-BUILD phase, which `inspect` reports separately from
# the build and which can run well past READY (23s on the 2026-09-30 ship, where a 15s window
# reported a false "never took" while prod had in fact switched). ALIAS_WAIT (s, default 120)
# caps the wait; the deploy is never cancelled either way.
if [ -n "$PROD_ALIAS" ]; then
  aliases=""
  alias_wait="${ALIAS_WAIT:-120}"
  alias_elapsed=0
  while :; do
    aliases="$(inspect_field aliases)"
    case " $aliases " in *" $PROD_ALIAS "*) break ;; esac
    if [ "$alias_elapsed" -ge "$alias_wait" ]; then break; fi
    sleep 5
    alias_elapsed=$((alias_elapsed + 5))
  done
  case " $aliases " in
    *" $PROD_ALIAS "*)
      [ "$alias_elapsed" -gt 0 ] && echo "▶ $PROD_ALIAS attached ${alias_elapsed}s after READY (post-build lag)" >&2
      # probe:prod-full c1 compares `vercel inspect <alias>` id against this file.
      ship_id="$(inspect_field id)"; [ -n "$ship_id" ] || ship_id="$(inspect_field uid)"
      if [ -n "$ship_id" ]; then
        ship_dir="${XDG_CONFIG_HOME:-$HOME/.config}/crash-dash"
        mkdir -p "$ship_dir" && printf '%s\n' "$ship_id" > "$ship_dir/last-ship.tmp" && mv "$ship_dir/last-ship.tmp" "$ship_dir/last-ship" \
          || echo "::warning:: could not record last-ship (probe:prod-full c1 will FAIL)" >&2
      else
        echo "::warning:: inspect returned no deploy id — last-ship not recorded (probe:prod-full c1 will FAIL)" >&2
      fi
      ;;
    *)
      echo "::error:: $DEPLOY_URL is READY but had not taken $PROD_ALIAS after ${alias_elapsed}s (aliases: ${aliases:-none})" >&2
      echo "::error:: — prod may still be serving the previous build. Re-check: vercel inspect $DEPLOY_URL (raise with ALIAS_WAIT=)." >&2
      exit 1
      ;;
  esac
fi
echo "✓ deployed to Vercel prod — $DEPLOY_URL → $PROD_ALIAS"

# P12.c warm: a ship flushes the edge cache, so the first visitor would pay every MISS (the /api/lab
# one is 5–10 s). Touch `warmUrls()` (scripts/probe-load-budget.ts — the one list: the public /overview
# set only, signed-in pages are not warmed), paced, non-fatal; only the deploy host's region warms.
if [ -n "$PROD_ALIAS" ] && [ "${SKIP_WARM:-0}" != "1" ]; then
  WARM_URLS="$(cd "$REPO" && "${TSX[@]}" scripts/probe-load-budget.ts --print-urls)" || WARM_URLS=""
  [ -n "$WARM_URLS" ] || echo "  warm ✗ --print-urls failed (non-fatal)" >&2
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    if curl -fsS -o /dev/null --max-time 60 "https://$PROD_ALIAS$path"; then
      echo "  warm ✓ $path"
    else
      echo "  warm ✗ $path (non-fatal)" >&2
    fi
    sleep 1
  done <<< "$WARM_URLS"
fi
