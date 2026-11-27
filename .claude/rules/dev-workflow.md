---
paths:
  - "**/*.ts"
---
# Dev Workflow (Node / TypeScript)

Stack: **Node 24** (Vercel runtime; supabase-js needs native WebSocket, absent in Node 20) + TypeScript 5
(`strict`, `noEmit`); `tsx` runs TS directly — no build, no bundler, no ESLint on the TS path. `npm start`
wraps itself in `scripts/db.sh with dev`, so it boots a local Supabase stack (~30–40 s cold);
`npm run start:raw` is the bare entry.

**Whoever brings the dev stack up takes it down.** Prefer `scripts/db.sh with dev` (always tears the
stack down when the command ends) for any bounded task; if you use `db.sh up dev`, `make
devdown` is a mandatory end-of-session step — never leave it for the next session or the
user. `down` is safe: `supabase stop` removes containers only, the irreplaceable dev history lives in the
Docker volume.

## Verification gate
**`npm run check`** = `lint:ruling-ids` + `tsc --noEmit` + `lint:ts` (type-aware ESLint, 8 rules, baseline `eslint-suppressions.json`; prune with `lint:ts:prune` after every fix) + `vitest run --silent` + `sim:notify -- all --quiet` — `scripts/check.sh` runs the last four in parallel after the
serial lints; a tree already checked green runs only `lint:ruling-ids` (pass stamp; `CHECK_FULL=1` forces). Run it
once per step — don't re-run to "confirm". It is uninstrumented: vitest.config.ts's per-file thresholds gate
at `make ship` (`$COV` in `scripts/ship.sh`); `npm run check:cov` is the same gate on demand.
⚠ `sharedTestOptions` loads `.env.local` into the test env, so a feed key you hold (`FRED_API_KEY`) covers
branches CI cannot. Reproduce a CI-only coverage failure with an empty override in `.env.test.local`, then
delete it.

It collects co-located `*.test.ts` **and the FE suites `public/*.test.js`**
(plain `.js`: vitest collects, tsc skips — a `src/`/`tests/` grep misses the whole FE surface; authoring
rules → `frontend.md`). `--quiet` prints ONE line per sim scenario and runs every assertion; drop it (or
name a single scenario) to eyeball the rendered bodies.

Single-file runs: `vitest run --silent=true <file>` — bare `--silent <file>` eats the path as the flag's
value. Never gate a commit on `cmd | tail`: the pipe reports tail's exit status, masking a red run.

`scripts/run-unit-tests.sh` is ONE `vitest run` over both projects (merged 2026-08-15) — its final
`Test Files … Tests …` block IS the whole suite.

**It does NOT cover the DB half.** The `SupabaseStore` integration suites are `describe.runIf(hasDb)` on
`DB_TESTS=1`, and the slim local stack doesn't expose `SERVICE_ROLE_KEY` via `supabase status -o env` — so a
green `check` skips them silently. They TRUNCATE the target DB; opt in deliberately, never in `.env.local`.

**Changed `src/store*` or `supabase/migrations/**`? Run `npm run check:integration` before pushing** — it
arms `DB_TESTS=1` against the isolated `crash-dash-ci` stack. Other runners of that same suite: `make ship`
(**always** — it is the pre-prod-deploy gate; `make verify` is the path-conditional one) and
`integration.yml` (dispatch) — **never `ci.yml`, which is unit-only**. The
`scripts/git-hooks/pre-push` hook also blocks a non-green store/migration push (and `pre-commit` a net-new
ruling ID), **but only once `make setup-hooks` installs them** into the shared git dir, which every worktree
reads; a fresh clone has none (`SKIP_TESTS=1 git push` bypasses; `make ship` sets it).

Touched dial/band math, or reading a probe/backtest result? → **`research-probes.md`**. `check` runs the
oracles, but its `sim:notify` is structurally blind to whole classes of change — a green sim is not
evidence there.

**Never mark a UI/output-visible claim "verified" from code comments** — comments state intent, not rendered
behavior; drive the actual path (API values minimum, DOM/paint for a true close), and say what you drove vs.
what remains the user's eye.

Local eyeball — cheapest rung that answers the question:
 1. prod `/lab?s=…` deep-link (real `api/lab.ts`, no stack) or a read-only prod query — the dev DB has no
    cron, so a local before/after is vacuous.
 2. need data-derived cuts? publish the committed vintage locally (ONE command, runbook §Database) — no
    backfill.
 3. full backfill ONLY for deep-history/sparkline work. It does NOT give you Live `/lab` (`alert_log`=0)
    or pension (~242 < 400). A real `NTFY_TOPIC` + stale store = a real phone alert.

Never declare a behavior "prod-only" untried. Cheaper-than-a-backfill tooling → runbook §Cheaper than a
backfill.

**A code-review range is `<first-commit>^..<last>`, never `<first-commit>..<last>`** — `A..B` excludes `A`,
so naming the stage's first commit as the base silently drops its diff while the commit message still reads
like full coverage. Confirm with `git rev-list --oneline <range>` before dispatching, and record that list,
not the range, as what was read → `docs/claim-verification.md` §53.

## Release
**`make ship` is the release** — green gate → prod schema (`migrate-prod-local.sh`) → deploy
(`deploy-prod-local.sh`) → `SKIP_TESTS=1 git push` → a cron re-derive (`smoke-cron.sh`, §7 — a deploy alone
leaves the board a mixed vintage; `SHIP_SKIP_CRON=1` opts out, runbook §Deploying to prod has the mechanism),
in that order, so schema always reaches prod before the code that depends on it. **A plain `git push` migrates nothing and deploys nothing** (auto-apply-on-merge
removed 2026-07-19); CI on push runs the unit `check` only, so a green CI is not a green prod. Still confirm
it (`gh run list --branch <branch> --limit 1`) — CI-only steps can fail while local checks pass, and a red
main goes unnoticed across sessions. Detail → runbook §Deploying to prod.

- `scan-sec` vuln with a FIXED VERSION → fix unasked: `npm update <pkg>` (exact transitive pin → `npm pkg set
  overrides.<pkg>=^<fixed>` + `npm install`) → `npm run scan:sec` clean → commit → re-ship; ask only if no fix.
- `make ship` migrates prod from the WORKING TREE's `supabase/migrations/`, not the shipped commit —
  `git status --short supabase/migrations/` must be empty first.
- A fix to code a GH workflow runs lands via a green `make ship` BEFORE `gh workflow run <wf> --ref main` —
  never `SKIP_TESTS=1 git push` + dispatch.
- Fails in one checkout, not another? `node_modules` is per-checkout and per-`npm install` (a sibling can
  swap it mid-session): diff `node_modules/<pkg>/package.json` `version` vs `package.json`'s range BEFORE a
  concurrency story (the shared `crash-dash-ci` stack, `docs/reference.md` §[live] Repo, ship & doc
  landmines; `/tmp/crash-dash-ship-log-*` names each caller). A runner that suddenly collects zero files = config-key/version mismatch — re-run unfiltered.

## Standing answers for an impag/qimpag round
Offer these pre-selected; still ask when the plan's own evidence contradicts one.
- Run every write step in-session, destructive prod writes included — never hold one behind a downstream
  `[USER]` eyeball; if a later ruling invalidates it, re-run. Under auto mode the classifier blocks
  destructive prod writes: do the non-destructive half and hand the exact commands back as a `Needs you:` line.
- Minimize probe spend — no new script, npm entry or fixture suite when a loop in an existing probe does it.
- NEVER dry-run a restate/backfill before the real one — its full-history price fetch burns the price feed's
  hourly quota, and the real `--confirm-destructive` run then aborts on `--require-primary-feed` for ~an hour.
- Prefer deleting stale data unless evidence shows the rows are load-bearing — then surface it and re-ask.

## Cron-seed
**Before calling a feed "wired," check it's written on the cron path.** A persisted series id the dial READS
(`getSeries("<id>")`) but no cron job SEEDS is silently dark in prod (self-disabling at
`VAL_MAX_STALE_DAYS`); grep each new dial read for a writer on the run loop's (`run-*.ts`) cron path (the manual `backfill`
CLI does NOT count). Likewise a persisted `alert_level` can be a **lag-hold** — never read one day's
`CRITICAL` as fresh without checking `bandReason`/`dialBand`.

## Import convention
**`.js` extensions on relative imports** (`./fred.js`) + `moduleResolution: "bundler"`. `.js` resolves to
`.ts` under tsc/tsx/vitest AND real Node ESM (Vercel's per-file runtime); extensionless fails prod with
`ERR_MODULE_NOT_FOUND`. Never `.ts` in a specifier. **Inverted inside `public/*.test.js`** → `frontend.md`.

## Dependencies
**Two runtime deps:** `@supabase/supabase-js` (behind `store.ts`) and `@vercel/functions` (ONE import, `invalidateByTag` in `api/cron/run.ts`); devDeps per `package.json`. Data feeds and
the notifier each stay behind one function (v4 §9) — which feed is which → `CLAUDE.md`'s source map.

## Architecture
Seams stay one-concern-per-file (map → `CLAUDE.md`); swapping DB is a one-file edit. **No new re-export
barrels** — import the file that defines the symbol; **no N=2 abstractions.**

## Shared working tree — attribute before mutating
Parallel sessions share this checkout. **Before `git stash`/`checkout`/`reset`, run `git status --short` and
STOP if it lists a file you did not touch** (2026-07-20: a sibling's `git stash` swept another session's
in-flight work — no undo once merged with foreign WIP). Subagents: git is read-only here; probe other
states with `git show <sha>:<path>`.

## On-demand detail → `docs/reference.md` §[runbook]
**local Supabase** setup · **cheaper than a backfill** (`probe-feed-diff`, `--dry-run`, `--restate=`,
`--reshadow-all=`, `--require-primary-feed`, `--closes=`) · **deploying to prod** (schema via
`migrate-prod-local.sh`) · **prod ops** via the Management API · **front-end** preview/mock gotchas ·
**external-feed** live-verify + lag · `--silent` gate noise · `vitest.config.ts` env gating.

Sibling rules: `research-probes.md` · `frontend.md` · `testing-project.md` · `migrations.md` ·
`plan-hygiene.md`.

Writing a claim into code — a coverage claim in a docblock, a constant cite, a falsifier, a "this is
untouched" / "no-op" assertion, a widened union? The taxonomy with the verification move for each class is
`docs/claim-verification.md` (not path-gated; §1 and §16 are the ones that bind `*.ts` most often).
