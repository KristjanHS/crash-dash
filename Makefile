.PHONY: help verify ship preview-live preview purge setup-hooks act-integration cidown devdown eufin value semis spit sp500 ladder-status ladder-runs ladder-log ladder-prod ladder-run

# The default goal: `make` with no argument lists the targets. Set explicitly because make
# otherwise takes the FIRST target it reads (`verify`) as the default. The listing is
# generated from the `## ` doc comment on each target line, so a new target documents
# itself by carrying one.
.DEFAULT_GOAL := help
help: ## show this list of targets
	@printf 'Usage: make <target>\n\n'
	@grep -hE '^[a-zA-Z][a-zA-Z0-9_.-]*:.*## ' $(MAKEFILE_LIST) \
	  | sed -E 's/^([^:]+):.*## /\1\t/' \
	  | awk -F'\t' '{printf "  %-16s %s\n", $$1, $$2}'
	@printf '\nFrom the shared include ($(HOME)/.config/make/worktree.mk), run from anywhere:\n'
	@printf '  %-16s %s\n' \
	  syncwt   'rebase the linked worktree, run the gate, ff-merge it into the primary' \
	  commit   'make commit <message...>  — stage all + commit on the current branch' \
	  commitwt 'same, but in the linked worktree'
	@printf '\nMost targets carry a longer comment above them in the Makefile — read it before a\nprod-writing run (ship, purge).\n'

# ── Release chain (scripts/ship.sh) — vitest runs ONCE; heavy steps are path-conditional ──
# verify: local checks only, no push (mid-dev gate).
# ship:   local checks + migrate-prod(local) + publish-calibration(local) + deploy(local)
#         + push + a cron re-derive (scripts/smoke-cron.sh, ship.sh §7). The DEFAULT release
#         path — the whole prod release runs locally so it NEVER bills CI minutes; CI on the
#         resulting push runs only the unit clean-room `check`.
#         ⚠ The trailing cron run is part of the release, not a smoke test bolted on: the
#         read API recomputes the ASSEMBLY at request time but reads the facts under it
#         (dial blob, band, heldSleeve, tier_state, per-indicator state) out of the LAST
#         cron's rows, so a deploy alone serves new-code assembly over old-code numbers —
#         each cell itself mixed — until a cycle re-derives them. It is also a REAL scoring
#         run: it can fire an ntfy push. `SHIP_SKIP_CRON=1 make ship` opts out.
#         `SHIP_KEEP_CI=1 make ship` leaves the crash-dash-ci stack UP afterwards, so a second
#         release skips a 26 s start + 13 s stop (warm re-entry 2.7 s). Pass it PER INVOCATION:
#         an un-flagged `db.sh with` reclaims the stack, but exporting it in a shell profile
#         leaves no un-flagged consumer and `make cidown` becomes the only way down.
#         Needs in .env.local: SUPABASE_PROJECT_REF + SUPABASE_DB_PASSWORD, plus a one-time
#         `supabase login` and `vercel login` (or set SUPABASE_ACCESS_TOKEN / VERCEL_TOKEN
#         for non-interactive use); the calibration publish reads SUPABASE_URL +
#         SUPABASE_SERVICE_KEY from .env.prod and no-ops when the vintage is already live.
verify: ## local checks only, no push (mid-dev gate)
	bash scripts/ship.sh verify
ship: ## the DEFAULT release: local checks + migrate + publish + deploy + push + cron re-derive
	bash scripts/ship.sh ship

# Security scan, FULL — the fast trio `make ship` already runs (gitleaks-git / osv-scanner /
# zizmor, scripts/scan-sec.sh) PLUS the 9-pack semgrep pass over src api public .github (~40 s).
# Manual only: too slow for the release chain, and `ship` already blocks on the trio.
scan-sec-full: ## security scan incl. the ~40s semgrep 9-pack (manual; ship runs the fast trio)
	bash scripts/scan-sec.sh --full

# DAST against the LIVE prod surface — >10 min (the plan's "3-6 min" was measured wrong on
# 2026-08-20), and it fires real traffic at the production WAF,
# so it is manual only (never in ship, never in a hook). The throttle (-rl 1 -c 1) is what keeps
# the scanner from being challenged; the X-Vercel-Mitigated guard is what makes a challenge LOUD
# instead of silently green. Both live in scripts/probe-dast.sh.
scan-dast: ## DAST the live prod surface with nuclei, throttled + mitigation-guarded (manual, >10 min)
	bash scripts/probe-dast.sh

# Live read-API + public/ (incl. /lab) at http://localhost:4321.
# One `db.sh with dev` around BOTH steps: the dev stack comes up once, the cron run seeds
# alert_log, the server serves off it, and the stack goes down on Ctrl-C — instead of each
# npm script paying its own start/stop cycle.
preview-live: ## live read-API + public/ (incl. /lab) on the dev stack at localhost:4321
	bash scripts/db.sh with dev -- sh -c 'npm run start:raw && npm run preview:live:raw'

# Stop the disposable crash-dash-ci stack (volumes kept). The fix for a `make ship` that dies
# with "supabase start is already running." + "supabase_db_crash-dash-ci container is not
# running: exited": an unclean Docker/WSL shutdown leaves the CI containers behind as `exited`,
# which `docker ps` (and so db.sh's own probe) reads as down while the supabase CLI sees them and
# refuses to start. Only `supabase stop` REMOVES them — run this, then re-run `make ship`.
# Never touches the dev stack's irreplaceable DB (that one is `make devdown`).
cidown: ## stop the disposable crash-dash-ci stack (fixes "supabase start is already running")
	bash scripts/ci-stack.sh down

# Stop the dev stack (crash-dash). Containers are REMOVED, the docker volume is KEPT — db.sh's
# dev_down never passes --no-backup, so the irreplaceable dev history survives. No-ops when the
# stack is already down. Does not touch crash-dash-ci (that one is `make cidown`).
devdown: ## stop the dev stack, keeping its irreplaceable DB volume
	bash scripts/db.sh down dev

# Static-only preview (no live API)
preview: ## static-only preview, no live API
	npm start
	npm run preview

# Purge the prod Vercel edge cache, so the read API serves fresh responses instead of
# waiting out s-maxage (a `Cache-Control: no-cache` request header does NOT bust it).
purge: ## purge the prod Vercel edge cache (fresh reads without waiting out s-maxage)
	@bash -c '. scripts/lib/prod-writes.sh && require_prod_writes "the edge-cache purge"'
	@# The project comes from the checkout's prod config: VERCEL_ORG_ID / VERCEL_PROJECT_ID (they win over any .vercel/ in the cwd).
	bash -c '. scripts/lib/prod-config.sh && load_prod_config --only VERCEL_ORG_ID,VERCEL_PROJECT_ID && exec npx vercel cache purge --yes'

# EU-Fin fizzle-path tranches T1–T3 over prod /api/series (read-only; scripts/probe-eufin-tranches.ts):
# 80 columns: per leg a close row over a live row (estimated closes + the intraday head), totals per tranche.
#   make eufin          the table
#   make eufin json     the raw evaluate() result
eufin: ## EU-Fin tranche T1–T3 check vs prod, closes + live — make eufin [json]
	@npm run -s probe:eufin-tranches -- $(if $(filter json,$(MAKECMDGOALS)),--json)

# Value (XDEV) entry tranches, three independent thirds over prod /api/series + public/value.json signs
# (read-only; scripts/probe-value-tranches.ts). Same shape: make value [json].
value: ## Value entry tranche T1–T3 check vs prod, closes + live — make value [json]
	@npm run -s probe:value-tranches -- $(if $(filter json,$(MAKECMDGOALS)),--json)

# Semis (SEC0) re-entry tranches over prod /api/series + public/semis.json signs
# (read-only; scripts/probe-semis-tranches.ts). Same shape: make semis [json].
semis: ## Semis re-entry tranche T1–T3 check vs prod, closes + live — make semis [json]
	@npm run -s probe:semis-tranches -- $(if $(filter json,$(MAKECMDGOALS)),--json)
# S&P IT (QDVE) re-entry tranches, Value's family-ladder shape over prod /api/series + public/spit.json signs
# (read-only; scripts/probe-spit-tranches.ts). Same shape: make spit [json].
spit: ## S&P IT re-entry tranche T1–T3 check vs prod, closes + live — make spit [json]
	@npm run -s probe:spit-tranches -- $(if $(filter json,$(MAKECMDGOALS)),--json)

# S&P 500 (SXR8) re-entry tranches + drawdown watch over prod /api/series + public/sp500.json signs
# (read-only; scripts/probe-sp500-tranches.ts). Same shape: make sp500 [json].
sp500: ## S&P 500 re-entry tranche T1–T3 check + drawdown watch vs prod, closes + live — make sp500 [json]
	@npm run -s probe:sp500-tranches -- $(if $(filter json,$(MAKECMDGOALS)),--json)

# Read-only checks of the headless re-entry ladder timer (crash-dash-eufin.timer);
# all four are scripts/ladder-check.sh — they never start, stop or edit the unit.
#   make ladder-status        timer next/last fire, last run's exit, a leftover unshipped marker
#   make ladder-runs [DAYS]   one row per run (default last 7 days): result, duration, per-leg + ship outcome
#   make ladder-log [full]    the latest run's journal; the `make ship` body is elided unless `full`
#   make ladder-prod          prod-served public/<leg>.json vs main's committed copy, per leg
ladder-status: ## ladder timer: next/last fire, last run's exit, unshipped marker
	@scripts/ladder-check.sh status
ladder-runs: ## ladder timer: one row per run (result, legs, ship) — make ladder-runs [DAYS]
	@scripts/ladder-check.sh runs $(or $(filter-out $@,$(MAKECMDGOALS)),7)
ladder-log: ## ladder timer: the latest run's journal — make ladder-log [full]
	@scripts/ladder-check.sh log $(filter full,$(MAKECMDGOALS))
ladder-prod: ## ladder timer: is prod serving main's per-leg ladder state?
	@scripts/ladder-check.sh prod

# Fire the ladder service NOW, off-schedule — the same oneshot the timer starts (default LEGS=semis only; any of /eufin
# → /value → /semis → /spit → /sp500). NOT read-only: it spends the Max monthly API credit, may commit
# public/<leg>.json, and on a commit OR a leftover unshipped
# marker runs `make ship` (prod deploy + push + cron) — deferred if another ship.sh is running,
# push-only if the vercel login is stale (scripts/eufin-run-local.sh is the authority).
# --no-block returns at once — the unit runs up to 80 min and a blocking start reads as a hang;
# follow it with `make ladder-status` / `make ladder-log`. A run already in flight is left alone.
# Also unlocks the billing cycle: timer fires skip until a manual run (eufin-run-local.sh § Manual unlock).
#   make ladder-run sub   the same run billed to the claude.ai subscription login instead of the API key
#                         (ignores the API-limit pause). It writes a one-shot token and sets
#                         LADDER_AUTH=claude-ai:<token> on the user manager only until the run has spawned
#                         (its InvocationID changes); the run consumes the token, and a timer fire that
#                         inherits a leaked variable finds no token and refuses (eufin-run-local.sh § Auth).
#                         A changed InvocationID proves the spawn only while the unit has no
#                         ExecCondition=/ExecStartPre= (ExecStart's env is read at its own spawn).
ladder-run: ## ladder timer: start a run now (default LEGS=semis; spends API credit, may ship) — non-blocking; make ladder-run sub = claude.ai subscription
	@u=crash-dash-eufin.service; \
	if [ "$$(systemctl --user show $$u -p ActiveState --value)" = activating ]; then \
	  echo "ladder run already in flight, NOT unlocked by this call — make ladder-status / make ladder-log; rerun make ladder-run once it ends"; exit 0; \
	fi; \
	if [ -z "$(filter sub,$(MAKECMDGOALS))" ]; then \
	  : >"$${XDG_CONFIG_HOME:-$$HOME/.config}/crash-dash/ladder-arm-request" || exit 1; \
	  systemctl --user start --no-block $$u && echo "ladder run started (unlocks this billing cycle) — follow with make ladder-status / make ladder-log"; exit; \
	fi; \
	script="$$(sed -n 's/^ExecStart=//p' "$$(systemctl --user show $$u -p FragmentPath --value)" | head -n1)"; \
	grep -q ladder-auth-once "$$script" || { echo "the unit runs $$script, which predates ladder-run sub — merge it into that checkout first" >&2; exit 1; }; \
	tok="$${XDG_CONFIG_HOME:-$$HOME/.config}/crash-dash/ladder-auth-once"; \
	n="$$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"; \
	(umask 077; printf '%s' "$$n" >"$$tok") || exit 1; \
	old="$$(systemctl --user show $$u -p InvocationID --value)"; \
	abort() { systemctl --user unset-environment LADDER_AUTH; rm -f "$$tok"; \
	  [ "$$(systemctl --user show $$u -p InvocationID --value)" != "$$old" ] || systemctl --user stop $$u; }; \
	trap 'abort; echo "interrupted — sub run cancelled" >&2; exit 130' INT TERM HUP; \
	systemctl --user set-environment LADDER_AUTH=claude-ai:$$n || { rm -f "$$tok"; exit 1; }; \
	systemctl --user start --no-block $$u || { abort; exit 1; }; \
	echo "waiting for the run to spawn (≤ 60 s)…"; \
	for i in $$(seq 60); do [ "$$(systemctl --user show $$u -p InvocationID --value)" = "$$old" ] || break; sleep 1; done; \
	if [ "$$(systemctl --user show $$u -p InvocationID --value)" = "$$old" ]; then \
	  abort; echo "ladder run did not start within 60 s (network not up?) — cancelled" >&2; exit 1; \
	fi; \
	systemctl --user unset-environment LADDER_AUTH; trap - INT TERM HUP; \
	echo "ladder run started on the claude.ai subscription — follow with make ladder-status / make ladder-log"

# Install the tracked git hooks (.git/hooks is untracked, so this survives a reclone).
# Idempotent — safe to re-run. The pre-push hook BLOCKS a store/migration push whose
# integration suite isn't green (see scripts/git-hooks/pre-push for the escape hatches).
setup-hooks: ## install the tracked git hooks (pre-commit ruling-ID lint + commit-msg guard-loosening gate + pre-push integration gate)
	@hooks="$$(git rev-parse --git-common-dir)/hooks"; for h in pre-commit commit-msg pre-push; do cp scripts/git-hooks/$$h "$$hooks/$$h" && chmod +x "$$hooks/$$h" || exit 1; done
	@echo "installed pre-commit (BLOCKING ruling-ID lint on the staged diff) + commit-msg (BLOCKING: a guard loosened vs HEAD needs a Guard-loosened trailer) + pre-push (BLOCKING integration gate on store/migration pushes; SKIP_TESTS=1 to bypass)"

# Run integration.yml's `integration` job locally via act (host-exec) — validates the
# GitHub Actions workflow definition against the crash-dash-ci stack before a self-hosted
# runner is registered. See scripts/act-integration.sh.
act-integration: ## run integration.yml's job locally via act (host-exec)
	bash scripts/act-integration.sh

# Worktree/commit targets (syncwt, commit, commitwt) + the %-swallow come from an optional per-user
# include (`-include` below: absent ⇒ skipped, and those targets do not exist).
# GATE auto-detects package.json's "check" script → `npm run check` stays the gate here.
-include $(HOME)/.config/make/worktree.mk

# Argument-word swallow for THIS repo's arg-taking targets. The optional include's catch-all (when present)
# fires only after commit/commitwt, so without this `make ladder-runs 14`
# runs the report and THEN fails "No rule to make target '14'". Gated on the FIRST goal,
# so a bare typo (`make strat`) still fails.
ARG_GOALS := eufin value semis spit sp500 ladder-runs ladder-log ladder-run
ifneq ($(filter $(ARG_GOALS),$(firstword $(MAKECMDGOALS))),)
%:
	@:
endif
