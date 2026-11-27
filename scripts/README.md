# `scripts/` — map, groups, and the shared helpers

Read-only unless noted. Prod base URL = `https://<PROD_ALIAS>` from the prod config
(override with `BASE_URL`). Full prod procedures live in `docs/reference.md` §[prod] (`grep -n '^## \[prod\]' docs/reference.md`).

Everything here falls into one of **six groups**. Find your group, then reuse before you write:
a new probe that re-declares `argOf` or re-rolls the replay walk is a regression, not a new file.

| Group | Where | What it is |
|---|---|---|
| **0. Shared helpers** | `lib/` | The only sanctioned home for cross-script utilities — read §0 first |
| **1. Release / ops shell** | `*.sh` | `make ship`'s chain, DB lifecycle, prod verification |
| **2. Backfill** | `backfill/`, `backfill*.ts` | Seed/top-up persisted history (idempotent, insert-missing) |
| **3. Research probes** | `probe-*.ts`, `capture-*.ts` | One-shot evidence runs behind a decision — see `.claude/rules/research-probes.md` |
| **4. Backtest / calibration** | `backtest/` | The Python harness, its vintages, and the TS replay/publish bridge |
| **5. Preview / eyeball** | `preview/`, `eyeball-check.mjs` | Local FE preview server + manual-check support |

---

## 0. Shared helpers (`scripts/lib/`) — **use these, don't re-declare them**

Extracted 2026-08-02 from measured duplication: `argOf` existed as 18 byte-identical copies,
the `--env`/`--from`/`--to`/`--out` quartet as 15, and the per-close replay walk as 16.
Those are the counts **at extraction**. The replay-walk rewire has drained its documented set AND the two
later carriers: **0 files** carry a hand-rolled copy of the block today (2026-08-02, after the carriers
round slice 2) — `backfill/leg-pillar-walk.ts` adopted the helpers in slice 1 and
`backtest/stage1c-pillar-replay.ts` (since archived) in slice 2. Measure it by BODY SHAPE, never by an export name or an
import, with the two-half grep in `lib/replay-walk.ts`'s docblock — and read that docblock's note on why
this zero is a drained set rather than a rotted grep before quoting it.

| Module | Exports | Replaces |
|---|---|---|
| `lib/cli.ts` | `argOf` · `hasFlag` · `envArg` · `envArgStrict` · `windowArgs` | the inline `argOf` + `--env` cast |
| `lib/stats.ts` | `mean` · `sd` · `median` · `medianOrNull` · `quantileNearest` · `quantileLinear` · `pearson` · `pct` · `pct2` · `pctOf` · `fmt4` · `countBy` | per-probe descriptive-stats copies |
| `lib/replay-walk.ts` | `loadSeries` · `loadSeriesWith` · `coverageOf` · `printCoverage` · `makeCursor` · `calendarFrom` · `unionCalendar` · `selectReplayDates` · `ffillReadings` · `panelAt` · `walkReplay` | the fetch → axis → forward-fill cursor block, and the single-date panel |

Four of those arrived after the first extraction and are the ones most often re-rolled by hand:

- **`walkReplay`** — the ascending per-close walk itself (the most-adopted export: **8 adopters** today —
  7 `probe-*.ts` plus `backtest/g4-mode-study.ts`, measured by call site, not by file mention:
  `grep -rn walkReplay --include=*.ts scripts/ | grep -v '^scripts/lib/' | grep -v '//' | grep -v '\*'`).
  It owns the cursor and
  the iteration order only; `onClose` is the probe's body and the fold state `S` is the probe's type, so
  path-dependent per-arm state stays in the probe. Strictly sequential and `await`ed per close, so `dates`
  MUST be ascending.
- **`loadSeriesWith`** — `loadSeries` with the read injected: same parallel fetch, same fail-loud ABORT
  text, for callers whose read is not `store.getSeries(id, span)` (a `getSeriesBulk` round-trip, a
  fixture-backed read, a vintage view). The injected read MUST reject rather than resolve to `[]`.
- **`unionCalendar`** — the ascending, de-duplicated UNION of every member's observation dates (the axis
  `computeReplay` uses), for probes that need every point at which anything moved rather than one series'
  trading days. `calendarFrom` remains the single-axis (F4-by-default) alternative.
- **`panelAt`** — the panel at ONE date: `ffillReadings`' reading set plus each present member's trailing
  history slice, as `{ readings, cissHistory }`. For probes that evaluate at a fixed anchor and inspect,
  with no calendar to walk — and, since Stage 3.C-1, for a probe that keeps its own ascending loop and
  calls `panelAt` per close with a shared `makeCursor` (`probe-drawdown-bite`,
  `probe-drawdown-clamp-2022`). A member dropped by the forward-fill horizon appears in NEITHER list, and the
  slice length is a REQUIRED option (callers pass `MEMBER_WINDOW + MEMBER_HISTORY_PAD`; `MEMBER_WINDOW` is
  `replay-walk.ts`'s own 60, so no danger-engine retune reaches a probe through it).

**Two deliberate non-consolidations.** `quantileNearest` (nearest-rank) and `quantileLinear`
(interpolated) are genuinely different functions that had drifted apart under one name —
collapsing them would move printed numbers, so both survive. `median` (NaN on empty) and
`medianOrNull` likewise. Pick by contract, not by name length.

### What may NOT move into `lib/`

`.claude/rules/research-probes.md` requires an A/B probe's **control arm** — and every cut a
later slice might retune — to live in-probe as a literal, never imported. A shared module that
a retune silently re-bases turns a banked counterfactual into an A/A comparison that still
prints a populated table. So `lib/` owns **plumbing** (argv, fetch, axis, cursor, formatting)
and never **the comparison**. Same reason `lib/cli.ts` carries no window/closes defaults.

`lib/replay-walk.ts` is also NOT `src/replay.ts`'s `computeReplay`, and must not converge on
it: `ReplayPoint` exposes only `{date, targetRung, band, regime, r4Phase, cash, reentryRung}`,
while the probes measure `positionP` / `leadingP` / numeric `band.{lo,hi}` / continuous `rung`.
Keeping the walk out of `computeReplay` is deliberate; what production owns
(`FFILL_MAX_CALENDAR_DAYS`, the dial itself) stays imported from production.

**But the loop itself is no longer hand-rolled.** Since Stage 3.A (2026-08-02) the shared fold is
`walkReplay`, and the three anchor-only probes that have no loop to fold (`probe-absence-field`,
`probe-leg-ordering`, `probe-member-contribution`) took `panelAt` instead in Stage 3.B-2. Stage 3.C-1's
two `probe-drawdown-*` probes are the middle case: helpers-only (`loadSeries` · `coverageOf` ·
`makeCursor` · `panelAt`) with the loop retained, because their axis is the `acwi.csv` fixture and their
fold state is `prevHeld` hysteresis; Stage 3.C-2's `probe-is7-diffusion-replay` is helpers-only for a
different reason (`loadSeries` · `unionCalendar` · `makeCursor` · `ffillReadings`) — its point-in-time
vintage truncation lives inside the read closure, downstream of where `walkReplay` fetches; Stage 3.C-3's
`probe-r4-arming` is helpers-only for a third (`loadSeries` · `calendarFrom` · `selectReplayDates` ·
`makeCursor`) — its four arms are closures over their own level pairs and `walkReplay`'s single `S` cannot
multiplex them. A script keeps
its own loop, its own fetch or its own assembly **only** with a
`// SEAM:` comment naming the divergence. Live example: `probe-growth.ts:113` keeps a tolerant
`Promise.all` for its `LEGP_*` leg reads because `loadSeries` is fail-loud and an empty leg there is
data (the null-skip the G0/G1 wave is built on), not an abort — the DIAL members in the same probe do
go through `loadSeries`, where fail-loud is correct.

---

## 1. Release / ops shell

| Script | What it does | Writes prod? |
|---|---|---|
| `ship.sh` | **The release.** Green gate → prod schema → calibration publish → deploy → push → cron re-derive (§7 — a deploy alone leaves the board a mixed vintage; `SHIP_SKIP_CRON=1` opts out). Driven by `make ship`, never invoked bare. | ✅ |
| `migrate-prod-local.sh` | Applies the migration ledger to prod, with a destructive-body gate. | ✅ schema |
| `deploy-prod-local.sh` | `vercel deploy` **and** the alias promotion — a `READY` deploy that never took the alias leaves prod on the old build. | ✅ |
| `db.sh` | Local Supabase lifecycle. `db.sh with dev -- <cmd>` always ends with the stack down, however it was found — prefer it over `up`/`down` for bounded work. | ❌ |
| `publish-calibration-prod.sh` | Publishes the COMMITTED `backtest/calibration.json` vintage. Idempotent by **content**; `--force` overrides; requires `.env.prod` (refuses ambient creds). Called by `ship.sh` §5b. | ✅ calibration rows |
| `verify-calibration-publish.sh` | Post-publish reconciliation: newest vintages, per-`(market,mode)` cell coverage, `dgs10` divergence sanity, `/api/indicators` provenance. Needs a Supabase Mgmt API token. `--cron` adds a prod-writing run. | ❌ (✅ with `--cron`) |
| `verify-migration-state.sh` (`npm run verify:migrations`) | Reconcile the local migration ledger vs prod. | ❌ |
| `smoke-cron.sh` | Post-deploy smoke: triggers `/api/cron/run` and asserts `alert_log.fired_at` advanced — off the TABLE, never the edge-cached `/api/status` (no cache-bust since S-1, so a poll there false-greens on a stale shard). Edge purge visibility WARNS only. `BASE_URL`, `MAX_WAIT_SECS`, `EDGE_WAIT_SECS`. | ✅ one cron run |
| `run-unit-tests.sh` / `run-integration-tests.sh` / `act-integration.sh` / `ci-stack.sh` | The gate runners. ⚠ `run-unit-tests.sh` runs vitest **twice** (shared, then isolated) — the tail summary is the isolated phase alone, never the total. | ❌ |
| `link-worktree-env.sh` (`npm run wt:link-env`) | Symlinks the primary checkout's `.env.local`/`.env.prod` into a linked worktree. | ❌ |

**Known duplication, deliberately left:** seven of these carry their own
`set -a && . ./.env.prod && set +a` + localhost-refusal block. The variation is real (required
vs best-effort; different refusal messages) and these sit on the release path, where an
unverifiable refactor is a bad trade. Extract only alongside a real `make ship` rehearsal.

## 2. Backfill

| Entry | What it does |
|---|---|
| `npm run backfill -- <job> --env=prod\|local` | Seed/top-up indicator history (idempotent, insert-missing) → `backfill/run.ts` |
| `npm run backfill:slow` | The slow/price-replay track (`backfill/run.ts slow`) |
| `npm run backfill:dial-state` | Dial-state replay column |
| `backfill/resolve-store.ts` | **The store seam every script should use** — `resolveStore(env, "ro" | "rw", liveResolveDeps)` (only `rw` consults `.prod-writes`); guards against an `--env=local` run pointed at prod |
| `backfill/leg-pillar-walk.ts` · `registry.ts` · `dry-run-store.ts` | Walk/registry/dry-run internals |

## 3. Research probes

~45 one-shot evidence runs, each behind a decision recorded in `docs/plans/`. Nearly all take
`--env=local|prod`; most take `--closes=`, `--from=`, `--to=`, `--out=`. Three
(`probe-drawdown-bite`, `probe-drawdown-clamp-2022`, `probe-absence-field`) are **hardcoded
local** and need `db.sh with dev`. Two require an explicit arg with no default on purpose —
`probe-r4-arming --expect-shipped=`, `probe-member-contribution --leg=` — because a default
would silently re-pin the thing the probe exists to detect.

Full invocation list: `npm run` (every `probe:*` entry). Discipline — control arms, placebo
arms, vintage regen, what `sim:notify` cannot see — is `.claude/rules/research-probes.md`;
don't restate it here.

## 4. Backtest / calibration

`publish-calibration.ts` is the sole prod-publish bridge; `calibration.json` is a frozen vintage.
`backtest/data/*.csv` are SHARED fixtures: a `--refresh` is a vintage change, not a fetch.

## 5. Preview / eyeball

`preview/` (see `preview/README.md`) — local preview server; inject/flip `STATUS.verdict` fields
to exercise UI states without a live selloff. `eyeball-check.mjs` (`npm run eyeball`) precomputes
the server-side truth behind the manual browser checks and prints a runbook with **this-run**
expectations, exiting 1 if a card is empty or an endpoint is down.

---

_One path publishes calibration to prod: **`make ship`** (every release —
`publish-calibration-prod.sh` writes the committed `calibration.json` vintage, skipping when prod
already has it). `backtest.yml` was deleted 2026-08-15 — a fresh vintage = run the harness locally
and commit `calibration.json` before shipping. See the runbook §6._
