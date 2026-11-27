# crash-dash — reference

Merged 2026-08-09 from architecture-overview, dev-workflow-runbook, prod-testing-and-verification, adding-an-indicator, disaster-recovery. **`grep -n '^#\+ '` is the index** — only `##` carries an origin tag, so a `§[tag] <name>` cite may resolve to a `###` under it; `grep -n '^## \[prod\]'` scopes to one origin.

⚠ `.claude/rules/doc-writing.md`'s row binds every line here (the 2026-08-09 merge amnesty ended with the compliance pass);
`scripts/reference-shape.test.ts` holds the reshaped sections to ≤2-line units.

## [arch] overview
# crash-dash — architecture overview (recon cache)

**On-demand only — never always-loaded.** Read this first; grep the source only for facts it lacks.
**Confidence:** ✓ = verified against source; ~ = inferred, **verify on first touch** and upgrade to ✓.

---

## [arch] 1. System map — two spines

### A. Backtest → calibration → publish (offline)
```
scripts/backtest/replay.ts   emits per-(market,mode) indicator fire labels + bucket edges
        │  (TS backtest; MARKET_FIXTURES × MODES grid)
        ▼
scripts/backtest/publish-calibration.ts → Supabase `calibration` table (calibration.json = frozen vintage)
```

### B. Live scoring (online)
```
src/domain-cuts.ts: resolveCuts / CALIB_MAP / CalibrationCuts; domain-fold.ts: classify   (calibration → cut edges)
      ▼
src/danger-engine.ts (computeField) + src/danger-share.ts (share-lit leg danger) + src/danger-ladder.ts (weight/label tables) + src/alert-band.ts (computeAlertBand)
      ▼
src/ladder.ts   ALERT_RANK / decideNotify / decideReassert              (band → notify decision)
      ▼
src/run-cycle.ts runScoringCycle: persist + push (ntfy)
      ▼
api/status.ts  (repo-root live handler; src/api/ holds only types.ts + contract test; openapi.yaml)
      ▼
public/app.js   dashboard render
```

**Live band formula:** `band = max(deEscalationLag(regimeToBand(dial.notifyRegime), N=2), escalatorFloor(readings, geoFlags, r4Phase, dial.fired))`. **Two regime axes since W3-c:** `dial.notifyRegime` (cuts `NOTIFY_REGIME_CUTS`) decides the pushed band and is what `run-core.ts` persists to `alert_log.dial_band`; `dial.regime` (cuts `DIAL_REGIME_CUTS`) is the DISPLAY label a human reads (push copy, `/lab` dial card, `headline`, `ReplayPoint.regime`). Both run the identical Crisis gate (`applyCrisisGate`, `t1dial.ts`), so they can differ in CUTS but never in GATING. The two cut sets ship IDENTICAL — choosing the notify values is a `[USER DECISION]`, so `regimeToBand(regime) === band` is true today but must not be relied on. Escalators: F1/F2 confirmed RED → CRITICAL **when `dial.fired`, else WARNING** (W3-d/OQ-2 — the credit escalator is gated behind the two-key model, so one key can't reach the top tier; the unfired tier is DERIVED from `ARMED_UNFIRED_CAP`, not chosen), GEO ≥1/≥2→WATCH/WARNING, R4 cash→CRITICAL, RATE base ≥2→WATCH (`alert-band.ts`). The gate reads `fired` only — `armed` is provably tautological for this predicate.

**Cross-spine link:** `calibration.json` is a spine-A / CI **artifact**, NOT read directly in prod.
`publish-calibration.ts` (runs on `make ship`; `backtest.yml` + `swap-guard.ts` were deleted 2026-08-15) is the sole bridge that pushes
its params into the Supabase `calibration` table; the live scorer reads that TABLE via
`store.getCalibration()` (`run-cycle-fred.ts`), then maps through `CALIB_MAP`. `market`/`mode` are the join
keys.

**Load-bearing corrections:**
- **`classify` REPLACES the convention absolute with `opAmber/opRed/velOp*` when `resolveCuts` returns
  them** — a substitution, NOT a non-binding OR-leg. The modes-and-markets *design doc*'s
  "unbuilt ①→②→③ / OR-legs only" language is stale/superseded by code.
- **Per-cell governance:** `score_cell_sweeps` gates each candidate on BOTH `recall_ok` AND
  `sweeps.survives_overfit_gate` (PBO<0.5, DSR≥0.95) inline (`calibration.cell_sweep_calibration`).
- **NDX modes can't diverge under strict full-recall** (0 qualifying cells; by design). SPX-crash +
  EAFE-crash DO qualify (`vix_operative` 24.2, thin-N degenerate amber==red). Relaxing full-recall for
  NDX is a reserved USER methodology decision, not a bug.

---

## [arch] 2. Canonical constants (grep targets)

| Constant | Value | Anchor | Confidence |
|----------|-------|--------|-----------|
| `MARKET_FIXTURES` | `{ NDX:"ndx", SPX:"spy", EAFE:"vea" }` | `scripts/backtest/replay.ts:266` | ✓ |
| `Market` type | `keyof typeof MARKET_FIXTURES` | `replay.ts:267` | ✓ |
| `MODES` | `correction(-0.1,126)`, `bear(-0.2,252)`, `crash(-0.3,63)` (threshold, window-days) | `replay.ts:287` | ✓ |
| `CALIB_MAP` | indicatorId → `{ channel, prefix }` map | `src/domain-cuts.ts` (`CALIB_MAP`) | ✓ |

**No canonical per-(market,mode) episode table exists** — only per-fire data emitted by
`replay.ts`. Don't hunt for one.

---

## [arch] 3. Data-flow contracts (record shapes)

- **`calibration.json` params** are keyed by `channel / metric / value / market / mode`, where
  `metric = ${prefix}_${suffix}`.
- **Fire-label records** emitted by `replay.ts` carry per-(market, mode) fire timing + bucket
  (caught / minor / noise) with per-mode edges.

---

## [arch] 4. Conventions

- **Indicator IDs (backtest swap-sweep only, `PREFIX_TO_ID`):** `R1`–`R5`, `EBP`, plus `F1`/`F2`
  (financial); the live registry is much larger (`ALL_INDICATORS`). Velocity indicators = `R2/R3/R4`.
- **Thresholds:** every registry indicator passes `withMultipliedThresholds` — `threshold-config.json`
  (`resolveMultiplier`) scales committed priors at score time; sensitivity tuning = config edit + redeploy.
- **Cuts are HAND-SET by default; the backtest/calibration spine is opt-in (USER ruling 2026-07-30).**
  The sweep → overfit-gate → `calibration.json` → publish chain (spine A, §1) costs far more tokens and
  wall-clock than it returns for a single-operator board, so a new or retuned cut is set by the USER
  reading the indicator's own **detail visualisation** — the trendline with the candidate cut lines drawn
  on it — and picking landmarks off the series. Spine A stays wired and correct for the ids already on it
  (`CALIB_MAP`); it is **not** the route for new work, and "run the harness first" is no longer a
  precondition for shipping a cut. What a hand-set cut still owes: a single source (below) and the measured
  firing-day share reported in the commit body so a mis-set pair is visible. It owes **no** provenance label:
  that wire field was dropped 2026-07-30 because hand-set is the permanent posture, so nothing served
  distinguishes a hand-set cut from a published one.
- **A hand-set pair lives in ONE place, and the growing convention is `family-descriptor-rows.ts`.** Two homes
  coexist: inline literals in `registry.ts` (the older `INDICATORS`-array set) and a descriptor constant
  in `family-descriptor-rows.ts` that `registry.ts` **derives** from via a re-exported symbol (`GT`,
  `GB`, `BUND`, `EURC`, `G1`, `BRENT`, `FXH`, …). Prefer the descriptor form for anything new. Either way
  the value is **never restated** — not in a docblock, a comment, a fixture, FE copy, or this file
  (`indicator-loop.md` §A retune is a ONE-place edit); derive test expectations from the constant, as the F16 rows in
  `dashboard.score-indicator.test.ts` do. No test pins a constant's value (`const-pin-lint.test.ts`);
  a re-typed cut is caught by `threshold-single-source.test.ts`, minus its documented blind spots and `ALLOWLIST`.
- **Metric naming:** `${prefix}_${suffix}`.
- **`isMain` guard:** entry-guard pattern in `replay.ts` (`main()` runs only when invoked directly).
- **False-positive suppression is the default bias.**
  A missed escalation is recoverable; a false one burns the notify channel's credibility, so every new
  indicator or severity rule inherits three obligations: (1) **prefer the less-noisy variant** of a
  signal — R1 is `T10Y3M`, not `T10Y2Y`, on that ground alone; (2) **cross-confirmation before
  severity** — no single leg liquidates (the confirmer gate + the ≥2-channel CRITICAL rule); (3)
  **persistence before firing** — `CONFIRM_CLOSES` (2 closes) applies to the new leg too, and an
  unvalidated prior stays CONTEXT/confirmer until it shows lead *and* a low false-positive rate —
  **but since the 2026-07-30 ruling above, that evidence is normally the USER's read of the detail
  visualisation plus a measured firing-day share, not a harness run.** A rule that widens the CRITICAL
  path needs an explicit, recorded USER override; one that narrows it (an AND-gate) does not.
- **A `Math.min`/`Math.max` pair is a RANGE check, not a fail-safe — rung clamps must be TOTAL and
  directional.** On this ladder rung 1 is the most aggressive leg and rung 9 (`R1_FLOOR_RUNG`) the
  defensive floor, so the idiomatic `min(hi, max(lo, x))` inverts the safety direction: a `-Infinity`
  input clamped to rung **1**, i.e. a garbage input silently produced *maximum* risk, and `NaN` defeats
  both bounds (it propagates, and in `computeR1`'s walk-down it HANGS rather than fails — see
  `r1.test.ts`). `clampRung` (`src/r1.ts`) is now total via an explicit `Number.isFinite` guard landing
  on the floor. **Every other min/max rung clamp inherits the un-fixed shape** — `t1dial.ts`'s
  `ARMED_UNFIRED_CAP` / `UNARMED_CAP` / `shockFloor` / `LADDER_MAX` chain and its `band.lo` — so when
  next touching one, add the non-finite guard and check which end "safe" is. Falsifier:
  `grep -nE 'Math\.(min|max)' src/*.ts | grep -iE 'rung|leg'`.
- **A "source of truth" function with zero production callers is a liability, not a spine — pin mirrors
  against the original, or don't mirror.** W5-a shipped `resolveCash` (`cash-overlay.ts`) as the declared
  precedence authority while every live path re-derived the same precedence inline; the three copies agreed
  only by coincidence of `r4.ts` internals, and its tests graded the unused copy. Falsifier for any such
  function: `grep -rn "<name>" src/ api/ --include=*.ts` returning only its own definition and `*.test.ts`.
  When a rule must exist in more than one place, either the mirrors **import** the original, or a test pins
  each mirror against it — a review lens to apply whenever a plan names a new single-source-of-truth helper.
- **"Zero invocations in N sessions" is NOT evidence a probe is dead** — a probe's duty may be a retune-protocol step or a
  test's own failure message (`probe-leg-ordering`, kept at the B4 retirement 2026-09-05). Before retiring one, grep
  the provenance docs' `## Read/write protocol` sections and `*.test.ts` assertion messages for its npm entry; only a
  probe no protocol or message names is dormant.

---

## [arch] 5. Test / CI / infra layout

- **Vitest** (TS): co-located `src/*.test.ts` + `api/*.test.ts` + `scripts/backtest/*.test.ts` (enumerate with
  `ls`, don't cache the list here).
- **A test fixture that shells `git config`/`git commit` MUST run inside its own `mkdtemp` repo** — run from a
  worktree checkout, a leaked call lands in the SHARED `.git` (`core.bare` flipped, fake commits on the branch).
- **Snapshot update: `vitest run <files> --update`, never `vitest run -u <file>`** — vitest 4.1 parses the path as `-u`'s value and re-snapshots the WHOLE suite.
- **No jsdom** (`inline-pos.test.js:11`): a `public/*.test.js` proving DOM *behaviour* is impossible —
  pin the selector + its `lab.css` rule instead, or pay for `scripts/e2e/*` (playwright, live DB stack).
- **CI:** `ci.yml` (main check gate) + `integration.yml` are this repo's only workflows; migration drift, backup and dead-man are optional operator-side schedules, break-glass migrate an optional operator-side manual dispatch (README §Scheduled jobs and leg runs).
- **DB migrations:** `supabase/migrations/*.sql` (e.g. add_calibration, calibration_cell,
  alert_mode_cells).
- **API contract:** `openapi.yaml` + `src/api/types.ts`.
- **Repo/push:** origin `github.com/KristjanHS/crash-dash`, branch `main`; `gh` authed as KristjanHS over
  HTTPS, so `git push` runs from the WSL host. Migrated off Bun → Node 24 + TS in the env-parity overhaul
  (2026-06-26).

---

## [arch] 6. Edit-seam FAQ (where common changes go)

- **Per-(market,mode) cell cuts (lift the global-only filter):** the "collapse to global" filter is
  `p.market == null && p.mode == null && …` at **`src/domain-cuts.ts:604`** — this is what a per-cell
  calibration lookup must relax to match on `market`/`mode`. ✓
- **Add a market:** `MARKET_FIXTURES` (`replay.ts:266`) + fixtures/data + calibration rows.
- **Add/tune a mode:** `MODES` (`replay.ts:287`); threshold + window-days pair.
- **Alert banding / ranking:** `computeAlertBand` in `src/alert-band.ts`; `ALERT_RANK` /
  `decideNotify` in `src/ladder.ts`.
- **Add a live CONTEXT/confirmer indicator (online, non-FRED-native):** the established 5-seam recipe
  R6/R7/EBP walked: ① bespoke `scoreX`/`xReadingSeries` in `scorers-*.ts`
  funnelling through `buildReadings(indicator, values, dates, rawStates, baseOffset, confirm=true)`; ②
  register the `Indicator` in `registry.ts` and splice into **`ALL_INDICATORS`** only — NOT `INDICATORS`
  (FRED-native) and NOT `PRICE_SCORERS` (keyed F4/F5/NVDA); ③ new feed via `fetchDailyCloses(symbol,{deep?})`
  in `prices.ts` (primary→fallback routing; index and FX symbols force-route to the fallback — but
  **NOT futures**, which have no primary-feed endpoint); ④ `run-dbfirst.ts` degrade-wrap `degrade("[tag] msg",[],…)`
  added to the secondary-feeds `Promise.all` batch + spread into `readings[]`; ⑤ **CONTEXT ≠ notify-neutral post-O2** (the T1 dial is the alert
  engine and reads `GLOBAL_FAMILIES` with no channel filter — any family member's confirmed RED can move the
  dial and fire a push; USER accepted this at F13 ship). A gate off a CONTEXT signal
  must read the CONFIRMED `reading.state` (`deriveConfirmedState`, `CONFIRM_CLOSES=2`).
- **Release a re-entry leg's escalation hold** (an `escalation:` event in `public/<leg>.json` keeps holding its tranches):
  `npm run -s <leg>:apply -- <patch> --events-only` with `{"events": {"<event>": {"holds": []}}}` (`applyEvents`,
  `src/ladder-run.ts`); the `block` it set on its sign rows lifts on later evidence (`resolveBlocks`) or a run patch's `block: false`. Moved here from the
  skill body — a hand recipe, never part of a run.

---

## [arch] 7. File inventory (`src/` + `scripts/backtest/`)

Verified listing 2026-07-03. Roles marked ~ are name-inferred — **upgrade to ✓ when you touch them.**

**`src/`**
| File | Role | Conf |
|------|------|------|
| `domain-*.ts` | split: `domain-types.ts` / `domain-cuts.ts` (`resolveCuts`, `CALIB_MAP`, `CalibrationCuts`) / `domain-legs.ts` / `domain-fold.ts` (`classify`); global-filter seam | ✓ |
| `ladder.ts` | `AlertLevel`, `ALERT_RANK`, `decideNotify`/`decideReassert`, `assessFreshness` | ✓ |
| `danger-engine.ts` | danger field: `computeField` over the share-lit arm (`danger-share.ts` `legDangerShare`) | ✓ |
| `danger-ladder.ts` | weight/label tables: `MEMBER_WEIGHT`, `FAMILY_LEG_WEIGHT`, `MEMBER_LABEL` — per-row rationale/measurement history lives in `docs/member-weight-provenance.md`, not inline | ✓ |
| `alert-band.ts` | alert-band math: `computeAlertBand` (dial band + de-escalation lag + escalator floors) | ✓ |
| `run.ts` | CLI entry → `runScoringCycle` (`run-cycle.ts`) — persist + push | ✓ |
| `scorers-core.ts` | `scoreIndicator`, `buildReadings`/`ratioReadingSeries` (`Indicator` type → `domain-types.ts`) | ✓ |
| `tracks.ts` | `TRACKS`, `ScoredTrack` | ✓ |
| `store.ts` | Supabase store: `getCalibration`, `getLastBand`, `AlertRecord`, `checkSchema` | ✓ |
| `api/` (in `src/`) | `types.ts` (StatusResponse) + contract test only — live handlers are repo-root `api/*.ts` | ✓ |
| `registry.ts` | `ALL_INDICATORS` assembly over `registry-{fred,price,composite,geo}.ts` (`INDICATORS` in `-fred`, `PRICE_SCORERS` in `-price`); add-an-indicator seam | ✓ |
| `ebp/fred/geo/slow/slow_tier/bottom/bottom_tier/vix_term/prices.ts` | per-indicator / data-source modules | ~ |
| `pension{,_tier,_holdings}.ts` · `ntfy.ts` `notify_tier.ts` · `config.ts` | pension track (`_holdings` = the effective-dated weight series) · push path · app config | ~ |
| `families.ts` `t1dial.ts` | LIVE production alert engine — `dial-assembly.ts` `computeT1Dial` (`GLOBAL_FAMILIES` panel) → `computeAlertBand`; also reused by `api/lab.ts`. `families.ts` = family panel + `THREAT_MAP`; `t1dial.ts` = two-tier band-select/graded dial. | ✓ |

**`scripts/backtest/`**
| File | Role | Conf |
|------|------|------|
| `replay.ts` | TS backtest carve-out; `MARKET_FIXTURES`, `MODES`, `rawSeriesConfirmedByDate` (Python harness + spikes deleted 2026-08-15, B5) | ✓ |
| `publish-calibration.ts` | push `calibration.json` → Supabase | ✓ |
| `calibration.json` / `pension_calibration.json` | frozen calibration vintages (generators deleted 2026-08-15) | ✓/~ |
| `data/` · `expanding-z/fetch/fetch-pension.ts` | fixtures · fetch/z-score tools | ~ |

---

## [arch] 8. Keeping this fresh

Re-run the seeding recon when a refactor moves a spine seam; upgrade ~ rows to ✓ when a task touches them.
⛔ Both are add-verbs — the paired drain is `.claude/rules/doc-writing.md`'s reference row (one in, one out)
and `~/.claude/references/memory-system.md` §Graduation routing.

---

## [arch] 9. Cross-file design invariants (facts with no single edit site)

Facts with **no single edit site**. Admission + the one-in-one-out drain → `.claude/rules/doc-writing.md`.

Shape guard: `scripts/reference-shape.test.ts` — every unit ≤2 physical lines, count ≤ its hand-set ceiling.

### Backfill depth (a shallow sleeve does NOT deepen on a normal pass)

- **Backfill plans each leg from `latestStoredDate` — a recent row never re-deepens; `BACKFILL_YEARS` caps, never forces.**
  Force `{mode:"full"}`: `--reshadow-all=`/`--restate=` (gated; never dry-run first — `dev-workflow.md` §Standing answers for an impag/qimpag round) or `--deepen[=<ids>]`; flags via `backfill:raw`.

- **Backfill trims READINGS, never FEEDS** — `backfillAll` alone trims, at `specCutoff`; a `trim(` inside `specs()` shapes
  a feed. A DEEP feed burns warmup below the cutoff — `fredObs` bounds at `cutoff − warmupDays` (the spec's own, default `SCORED_WARMUP_DAYS`), never the bare cutoff (that pinned G1/BRENT's 756-obs level leg GREEN forever).

- **`DETAIL_WINDOW_CONFIG` (`family-descriptor-rows.ts`) is the SOLE detail-chart span, in both units;** `resolveBackfillSince`'s
  `chartSpanBound` arm makes every seed reach it. ⛔ Never raise ONE id's window — per-id `window:` rows are gone.

### Registry fan-out (adding an id)

- **A CONTEXT-only (`thresholds:{}`) id trips FOUR coverage gates, ALL fed in the same commit** — `CONTEXT_ONLY_ALLOWLIST`,
  `public/indicator-desc.js`, `PLACEHOLDER_STATE_IDS`, `CARD_ONLY_GROUPS`; a SCORED `thresholds:{}` leg → §[indicator] 4.
- ⚠ **`CARD_ONLY_GROUPS` is NOT context-only wiring** — a SCORED id with no `MEMBER_WEIGHT` STILL needs a row or it draws
  NO card, tests green. `families.test.ts` pins the reverse (every id resolves a card group); NVDA sole exemption.
- **A new `trend`/`cross-asset` member goes at BOTH `families.ts` sites — the re-point branch is a hardcoded literal
  `ids:[...]` that DROPS `f.ids`**: a US-only add never reaches `FAMILY_MEMBERS.uT`, suite green. Trust the literal, not its rotted guard comment.
- **`RATE_STRESS_FLOOR = 2` (`alert-band.ts`) is a FIXED floor never rescaled as the RATE population grows** — any new
  RATE non-confirmer at RED trips the WATCH floor unilaterally; a new RATE leg ships `confirmer:true` or re-derives the floor.
- **Every table DERIVED from `MEMBER_WEIGHT` (`MEMBER_RELEVANCE`, `danger-ladder.ts`) is a second copy frozen at MODULE
  EVAL** — a post-import override never reaches it; an in-process A/B arm re-derives every dependent table after the override.

### Cron write path (`run-cycle-persist.ts`, `record_run`)

- **Every feed parser owes an ISO-normalized `date` — the run's `asOf` is a LEXICOGRAPHIC max**: one non-`YYYY-MM-DD`
  cell outsorts every real date and folds a FABRICATED all-zero posture. Normalize at the feed's seam and THROW on an unrecognized third format.
- **A run-path guard that MUTATES a reading's state must be projected live-only — the stored array is the feed's record,**
  else a synthetic verdict back-dates into the vintage PERMANENTLY. Split at `assembleRun`'s `readingsForStore`; firing-day store-vs-live divergence is accepted.
- **Same-day rows: `record_run` is APPEND-ONLY; reads collapse by FIRED-date, never `obs_date`** (→ §[prod] ⚠️ Gotchas).
  *Scoring* prev-state reads the latest PRIOR fired-date (`getLastAlertBefore`/`getLastBandBefore`); the *notify* baseline is the ABSOLUTE latest (`getLastAlert`).
- ⚠ **`hold.changed` is a NOTIFY consumer despite sitting in the `prevDay` block** — an independent bidirectional trigger.
  A new prev-state consumer wired to the wrong side fails silently in ONE direction only (churn, or a dup push).

### Live read path (`api/lab.ts`, `api/status.ts`)

- **Anything on `/lab` or `/status` must be PERSISTED — the read handler maps stored `readings` rows and does NOT
  re-score; the run loop (`run-*.ts`) never builds a `LabResponse`.** (Memory: `api-handlers-live-in-repo-root`.)
- **A new dial INPUT threads into `computeT1Dial` in `assembleDial` ONLY; live `/lab` HYDRATES the persisted `dial_state`
  blob (`hydrateOrComputeT1Dial`), never re-deriving** (`src/replay.ts` + `?s=` are the what-if sites). Re-grep `computeT1Dial(`.

**Danger-model change discipline (stated once):** any weight-axis, membership, or held-pick-deadband change ⇒ regenerate
`danger-engine.*.test.ts` fixtures + `npm run probe:core9`, re-eyeball dial band, `CONC_THRESHOLD`, level thresholds. All three axes are SERVER-ONLY — not in `public/lab.js` nor the FE-mirror parity guard.

- **Two silent-liveness traps in `assembleDial`:** (a) a member PROMOTED into a side-bucket (`price.downside`) renders
  DARK unless explicitly folded into the assembled panel; (b) a slot absent from `MEMBER_WEIGHT` stays GREEN forever (never confirmed live).
- **Freshness recomputes at REQUEST time — a bare UTC `toISOString().slice(0,10)` manufactures a phantom stale day.**
  Both INDEPENDENT paths (`/api/status`; `feed-lag.ts`'s `freshnessFrom`) resolve via `todayOnFeedCalendar(feedTimeZone)`; any third aging surface owes the same seam.

### Backtest / calibration methodology

- **The keyless credit-spread feeds (F1/F2/F10) CLAMP to a rolling exactly-3-year window — deep-history work over them is
  unmeasurable** (their long-history lift proxy is unit-free and barred from operative cuts).
- **`_operative_*` rows are ALL cell-scoped — the notify path never reads one** (`resolveCuts(id, calib)`'s cell-less arm
  matches only `(null,null)` rows); a regen moves DASHBOARD cells, never the alert — withheld rows fall back safe. Falsifier: `calibration.json` holds no `operative` metric with `market:null`.

- **A probe's control arm REIMPLEMENTS a production formula from frozen literals** (`probe-band-split.ts`,
  `probe-leader-split.ts`) — whenever a scored/band expression changes: `grep -rn '<expression>' scripts/probe-*.ts`.

### The 2-close confirmation fold (shared across notify · bottom · pension)

- **The fold is NOT pointwise-monotone — worsening ONE raw day can HOLD an OLDER, GREENER confirmed state.** Never make
  it monotone: it is the one audited implementation shared by notify, bottom and pension.
- **The fold has only TWO speeds — `closes ≤ 1` degenerates to the identity** (a `CONFIRM_TIERS` `1` ≡ `0`; `1→2` real,
  `1→0` no-op); `winningLegSeries` callers pass `confirmClosesFor`, never a literal, or a leg folds at a different speed than its family.

### A ratio-spread descriptor's head-skip is ONE expression — `ratioSpreadBaseOffset(desc)`

- **`scorers-composite.ts`'s scorer `base`, `ratioSpreadMinLen` and `probe-vintage-consistency.ts`'s `expectedHead` all call `ratioSpreadBaseOffset`; never restate its `max` inline.** The TAILS still differ by design (`minLength: base + 1` vs `base + CONFIRM_CLOSES`) and fail OPPOSITE ways if one is narrowed: the scorer's → loud run-time throw; `minLen`'s → SILENT zero readings.

### Reading a live check without misdiagnosing it

- **A lag cut comes from the source's published RELEASE calendar (validated `>=` the measured maxAge), never the
  observed age** — `probe:feed-lag`'s `medianGap`/`p90Gap` measure OBS-date spacing, blind to batch release cadence.
- **The bar is `max(p90Gap, LAG_THRESHOLDS[registered]) × MULT` for the `EXPLICIT_OF` ids, the strict form otherwise** —
  a NEW feed registers the publisher's calendar, never widens a cut after the fact.

- **A `BAND_DRIVING` bridge seats IN THE BRIDGED ID'S PLACE only on days that id is silent — live-vs-scenario parity
  holds only while the bridged id is genuinely SLOW** (short/hand-built fixture series make any id look silent; the paths then diverge, suite green).
- **A bridge may ALSO be a plain `members` entry (CQS)** — it then rides the band daily and substitution only swaps its
  seat and drops its `capped` ceiling. Check the bridged id's REAL cadence; a fixture asserting a seated bridge says so explicitly.

### Standing invariants graduated from auto-memory (2026-08-09)

- **R8's posture bound is FOUR-sited and the exposure push binds as a PAIR** — floor first (`resolveCompoundFloor`,
  inclusive `>=`), then `resolveOverlayStepDown` (only from `Full`); sites `run-core.ts`, `api/exposure.ts`, `run-cycle.ts`'s `boundExposurePairForPush`, deliberately-RAW `src/exposure-replay.ts`.
- **The pair binder gates on SYMMETRY — either row absent or rung-blind ⇒ BOTH bind raw;** `resolvePersistedCashLevel`
  returns a LEVEL only — never widen it to a full `CashState`.
- **Backfill's `pruneShadowedReadings(ids)` is UNFLOORED vs cron's floored `(null,30)`** — seeding ≥1 row unfloor-prunes
  that id's whole shadow history (no obs DATE lost); never dry-run first — `dev-workflow.md` §Standing answers for an impag/qimpag round.
- ⛔ **Never re-add `cache: npm` to a self-hosted job; no manual shadow-row repair** (the nightly floored prune collects
  them, there is no PITR); `integration.yml`'s `push:` trigger stays commented — dispatch-only.
- **Two re-seed levers, and insert-missing can NEVER heal either:** a CUT retune needs `dbreak --restate=`, a FEED
  re-provenance `--reshadow-all=` (after ANY retune); a cron FINAL-row rewrite is primary-feed-only — hop/intraday symbols stay insert-only (`finalRewriteHeld`, `fallbackGate`).
- **Every "retired claim" from the NF track is STILL LIVE — never sweep them:** `geo` keeps its WARNING floor (→ §[live]
  Standing closures), `ew` its WATCH cap, `staleHoldFloor` stays ungated with no K, the cash overlay fires on acceleration alone at any rung.
- **VT red no longer means backwardation (fires below 1.00)** — a prose sweep must NOT "fix" the four
  `ratio > 1.00 = backwardation` sites (`registry.ts`, `scorers-composite.ts`, `r4.ts`, `public/band-panel.js`): they describe VTP, not VT.
- **Enrolling an id in a cross-cutting SET / wire map (`DUAL_AXIS_IDS`, `POINT_BAND_CUTS_OF`, …) commits it to that set's consumer
  contract — and DELETING a row silently drops every behaviour gated on the key** (`bandCuts` also gated R6's read-path re-score); grep the CONSUMERS both ways.
- **An expanding/ranked cut must be SCORED and DRAWN off the same untrimmed pool** — every consumer feeds `fullHistory`
  and trims READINGS, never the `MAX_LIMIT` vintage or `fredObs` window. Falsifier: `/api/series` `bandCuts` vs a deep-feed re-score — unequal ⇒ pools diverged.
- **A ratio id's STORED `band_cuts` (CG) are DEVIATION-space while its drawn cut is RATIO-space** — substitute the stored
  cut into the back-transform (`api/series.ts` `pointBandCutSeries`) before drawing, never draw it raw. Falsifier: `npm run probe:band-cuts-parity`.
- **A `synthPriors` restate is the store's FLOOR, and the cron's pool is INCLUSIVE of today** — a restate prunes stored rows older than BOTH the id's depth cutoff and the rebuilt series' first emitted date (`backfillHistory`, ≤`PRE_FIRST_PRUNE_MAX_SHARE` else throw; warm-up rows
  inside the depth window survive) and the cron appends its newest observation pre-percentile (`synthHistoriesInclusive`) — ONE pool for cron, restate, read path. Falsifier: `probe:band-cuts-parity --env=prod` (was F3 60/60, 2026-09-02).

- **`chainSplices` ABSENT is not "no base break"** — only breaks ≥ `CHAIN_BREAK_RATIO` count; smaller ones surface only
  as `maxChainRatio` (above `CHAIN_QUIET_RATIO`). A base break is a CHART defect, never an alert one (`state`/band read `decision`); restate declined [USER] 2026-08-30.
- **An id persists its PRIMARY `series` as `readings.value` (NOT NULL) — a composite whose primary is ANOTHER id's series DUPLICATES that value column by construction** (R7/R1, DB_SMH/F4/SMH, F6/RS_SMH, …).
  Before registering an id whose `series` another id already stores: `npm run probe:e6b-aliasing` — RED until the duplicate write path is retired.
- **A DB-first id must store RAW values, never its smoothed series** — the tail arm re-smooths whatever it reads, so a
  smoothed row is smoothed twice per cron (R1 2026-09-04). Falsifier: `probe:band-cuts-parity --env=prod`.
- **A vitest fixture that shells `git config`/`git commit` runs inside the SHARED `.git` of a worktree checkout** under the pre-push hook's leaked
  `GIT_DIR` — flipped `core.bare`, landed fake commits on a live branch, wrote the fixture `user.email` into `.git/config` (Vercel BLOCKS deploys by a non-member author). Child env strips `GIT_*`; pins = `prune-backups-branch.test.ts` rev-parse self-check + the `deploy-prod-local.sh` author preflight.

### A probe's FIXTURE ROSTER can make it green on the one input that matters least

- **A falsifier able to fail still certifies nothing when its population isn't production's** — `probe:readpath-lag` sweeps a hand-balanced 5-bond/4-equity roster (`scripts/probe-readpath-lag.ts:91`); `containmentGrid`'s live caller passes the whole ~54-id `allDailyFeeds`.
- **Any RATIO-over-roster rule (the outage quorum, deleted 2026-09-13 on a 0-decision measurement, was one) is adjudicated by the fixture's composition, not the data** — the green is real, the claim built on it is not. Test: name the quantity the probe computes, then ask whether its DENOMINATOR is the production one; if the population is curated, "the probe adjudicates X" is a coverage over-claim that rots silently.

### A plan's own DIAGNOSED MECHANISM is a claim, not a premise

- **A fix authored against a mechanism the plan merely ASSERTS can ship inert** — green proves the fix broke nothing, never that it did something.
  Test: A/B the fix against the same arm disabled; identical output on the motivating population ⇒ the mechanism was mis-modelled — report that, don't ship it as a fix. Same class at a SHARED seam: a parity claim green in the seam's suite can be inert at a CALL SITE feeding it a degenerate input — F1 handed `resolveCarryWindow` one-row print series, so R10's walk-back could never fire; check each consumer's argument SHAPE.

### A chart-spec band that is in the GOLDEN is not proof it renders

- **The golden pins the SPEC, not the pixel** — a golden diff cannot catch a declared band that draws on no pixel: both sides agree, and both are the spec (`DISP_CORR`'s primary `displayBand` sat unrendered until a 2026-09-09 fix, `genericDerived` in `public/detail-chart.js` concat'ing only `threshold`/`derived`).
  Test: for a NEW band, assert the rendered SVG contains its label — the renderer's per-route filters are the real admission list, so read the route your builder falls to (`genericDerived` vs `genericSingle`).

## [runbook] overview
# Dev Workflow — runbook (on-demand detail)

Extracted from `.claude/rules/dev-workflow.md` so the always-loaded (every-`.ts`-edit) rule stays
tight. This file has **no `paths:` frontmatter**, so it never auto-loads — read it when a task
actually needs deploy / prod-ops / front-end / external-feed detail.

## [runbook] Adding a rung
New detail worth keeping? Tier it: a one-liner every `.ts` edit must see stays in the **rule**; a paragraph-plus gotcha becomes a new `##` section (a *rung*) **here**.
Then wire it — add/extend a ≤1-line entry under the rule's `## On-demand detail` pointer so the rung is discoverable without auto-loading; keep the rule itself trigger + summary only, depth lives here.

## [runbook] Gate noise — `--silent` hides TEST `console.log` only
⚠ `--silent` on the gate (as in `ship.sh`) silences test logging, **not** production logging under test. The
backfill suites drive the REAL `backfillAll`/`backfillPension` over `InMemoryStore` + stub feeds, so
`[backfill] F1: seeded 280 …` (449 lines, 83% of an unsilenced run) reads mid-gate like a live backfill — it
is hermetic, no network/DB (giveaway: identical `280` for every FRED id = 300 synthetic pts − warmup).
Failures, traces and the summary survive; `npm test` stays loud. `make syncwt` auto-detects this gate and
inherits it.

## [runbook] `vitest.config.ts` env gates must read `loadEnv`, not raw `process.env`
⚠ They diverge on `.env*`-set vars (vitest merges those into worker env only): gating
`fileParallelism: !DB_TESTS` off `process.env.DB_TESTS` parallelizes the DB-truncating suite whenever
`DB_TESTS` lives in a dotfile. Read BOTH —
`(process.env.DB_TESTS ?? loadEnv(mode, cwd, "").DB_TESTS) === "1"` (the shipped form).

## [runbook] External feeds
**External-feed indicators:** fixture tests stay green while a live free tier rots — `npm start` live-verify before shipping.

**Lagging feed vs a freshness threshold — fix the source, not the threshold.** When an external feed trips a lag gate (e.g. `MAX_STALE_DAYS`), first confirm whether the lag is *inherent* to that source and whether a fresher free source exists, before loosening the gate. Loosening masks the problem and weakens the gate's real job (detecting a down feed). Known: an upstream weekly-published FX series carries a normal 6–11d publication lag, while the price feed's daily FX quote is fresh and shares the equity legs' calendar. In an inner-join across legs, the **laggiest leg is the binding freshness constraint** — a per-leg-fresh threshold breaks on the slowest feed, not the one you calibrated for.

**An upstream daily credit-spread series can repeat the prior close on US bond holidays — upstream, not a carry bug.** Not guaranteed every holiday, and `src/source-holidays.ts` has no row for that family, so the row is stored as a fresh print, not a carry. Falsify before debugging the store: `tail -3` the series' upstream CSV — a duplicate there is upstream's, not ours.

## [runbook] Front-end (`public/*.js`)
FE gate, pure-seam pattern and test-import specifier rule → `.claude/rules/frontend.md`; this section is preview servers, mock drift, screenshots.

- `npm run preview` = hand-mocked `mock-data.mjs` (`scripts/preview/server.mjs`; CI-cheap `preview:shot`); `npm run preview:live`
  (`server-live.mjs`, `.env.local` store) = the real persisted store — the e2e eyeball path for a new indicator/verdict render.
- `/lab` needs `preview:live`: the mock serves a STATIC all-calm `/lab` that ignores `?s=`. Drive it via the Scenario toggle
  (`#modebar [data-mode="scenario"]`) — Live mode 404s on a fresh local DB (no cron row). Restart a stale server on the SAME port (4321).
- A fresh local DB parks z-derived bands (`?early=`, `?detail=1` `effAmber/effRed`) at registry cuts — a default, not a limit: publish the
  vintage (§Database) and R1–R5/EBP flip to data-derived cuts. F1/F2 draw the static absolute band, so `?early=` never moves their line.
- A blank/unset `NTFY_TOPIC` off-prod suppresses push, so a local `npm start` with an empty topic pushes nothing (→ §[prod] 9 `NTFY_TOPIC`).
- A new `/api/indicators` field renders the OLD path in `preview:shot` until `mock-data.mjs` carries it AND a series ≥ the lookback window;
  add a shot assertion for the new render (`.line-derived`) or the gate greens without exercising it. Labels import from the registry (a restated one throws).
- The preview servers run under `tsx` (the fixture imports `src/*.ts`); plain `node scripts/preview/server.mjs` dies `ERR_MODULE_NOT_FOUND` — loud by design.
- Client-side chart math needs div-by-zero guards: a non-finite denominator emits `NaN`/`Infinity` into SVG path coords → silent broken render.
- Non-calm `/lab` without the local stack: Playwright-`route` `**/api/lab*` and fulfill a state-mutated copy of the fixture.
- `/lab?s=` deep-links two-way (seeds from `location.search`, `replaceState`s back), so ANY board state is drivable against prod with plain
  Playwright at `<PROD_ALIAS>/lab?s=…` — scenario acceptance needs no manual eyeball.
- Scratchpad probes: import the repo's absolute `node_modules/playwright/index.mjs`, and name them `.mts` — outside the repo's `"type": "module"`
  a `.ts` compiles as CJS and top-level await fails.
- Behavior-preserving `public/*` refactor: copy `scripts/preview/out/*.png` aside, re-run `preview:shot`, `cmp` each pair — the shots are
  deterministic, so 12/12 byte-identical is the gate.
- **FE copy for a one-way engine rule names the direction** (the dial band FLOORS the notify band; the fold delays a rise,
  not a fall): write "can only raise" / "delays a rise", never a symmetric "matches" — the other direction reads as a bug.
- `screenshot.mjs` negative asserts ("no nav happened") need a settle window — `waitForTimeout`, not `waitForFunction(absence)` (resolves instantly).

## [runbook] Database (local Supabase)
- Schema = `supabase/migrations/`, the single source; `supabase start` applies them. `supabase db reset` re-applies clean — on the
  **CI stack only** (`scripts/ci-stack.sh reset`); against dev it wipes the irreplaceable history and is never the answer.
- Both stacks default DOWN — drive them through `scripts/db.sh {up|down} {dev|ci|both}` (held open) or `scripts/db.sh with {dev|ci} -- CMD`
  (ephemeral: starts if down, runs CMD, ends down — a found-up stack is reclaimed, a parallel `up` is stopped under it; opt-out `DB_WITH_KEEP=1` = ship's `SHIP_KEEP_CI=1`, interrupt still tears down).
- Teardown runs on EXIT/INT/TERM; cold round-trip ≈ 30–40 s; `scripts/db.sh status` says what's up. `db.sh` never `db reset`s or
  `stop --no-backup`s the dev volume (both wipe the irreplaceable history).
- Wrapped: `npm start`, `backfill`, `backfill:slow`, `preview:live`, `check:integration`, `make preview-live` — each keeps a `:raw` variant for
  inside a held-open session (and for callers that must NOT touch a local stack, e.g. a prod-targeting `backfill:raw` run). Reach for `with` before a mock.
- Stale-schema trap: `db.sh up ci`/`with ci` re-run `ci-stack.sh up` (applies `supabase migration up`); `:raw` scripts inside a held-open
  `up ci` session skip that reconcile and green against the OLD schema — `scripts/ci-stack.sh reset` before trusting green. The dev path never reconciles.
- ⚠ `db.sh: the Docker daemon is UNREACHABLE` over SSH-into-WSL → `systemctl status docker-desktop-proxy.service` first; `docker … could not be found in this WSL 2 distro`
  = Docker Desktop Resource Saver, not a dead daemon. Never stop/start via the Docker Desktop UI — the CLI-owned `unless-stopped` containers resurrect.
- No host `psql`: `docker exec -i supabase_db_<crash-dash|crash-dash-ci> psql -U postgres -d postgres`; falsify a local backfill with
  `-Atc "select count(distinct indicator_id), max(obs_date) from readings"`. Dev ports blocked → `db.sh with ci -- CMD` (:55321).
- Creds: `SUPABASE_URL=http://127.0.0.1:54321` + the **service_role** JWT in `.env.local` (`.env.example` = template) — `supabase status` prints no
  keys; read it from `docker exec supabase_kong_crash-dash cat /home/kong/kong.yml`. A linked worktree has no `.env*` → `npm run wt:link-env` once.
- A replay-over-store job on the CI stack owes a seed first — `backfill:raw -- indicators` then `legs` against :55321, else `legpillars --closes=900`
  reds `no EARLY-WARN (sleeve, super_group) pair at all`. `store.test-helpers.ts`'s truncate clears the seed.
- Local `calibration` is empty until published (every indicator scores off STATIC convention cuts; `?early=`/`?detail=1` invisible):
  `npx tsx --env-file-if-exists=.env.local scripts/backtest/publish-calibration.ts` → `wrote 152 param(s)`; verify `calibration_latest` = 152 rows.
- `publish-calibration.ts` reads `process.env` directly and is NOT wired with `--env-file` — pass the flag yourself or `getStore()` throws. The
  committed `calibration.json` IS what `make ship` publishes to prod (§5b, `publish-calibration-prod.sh`: skips when prod matches, WARNS on a newer prod vintage).
- `/api/lab` Live mode 404s (`no runs recorded yet`) until a local cron run writes `alert_log` — backfill fills `readings` only. Fix: `npm start`
  once against local (writes one `alert_log` row). The pension track stays null until `MIN_PENSION_HISTORY` aligned rows exist.
- A stale local band + a real `NTFY_TOPIC` in `.env.local` = a REAL push to the dev topic (the notify diff runs against the LOCAL last band). Blank
  the topic, or divert: `NTFY_TOPIC=crash-dash-localverify npm start` (the env var wins; `--env-file` never overrides an already-set var).

## [runbook] Cheaper than a backfill
A re-seed is the *most* expensive way to answer most data questions, and against prod it is destructive-gated.
Reach for these first — each answers a narrower question without writing a row.

- **"Are the stored rows actually stale / what would change?"** → `scripts/probe-feed-diff.ts`. Writes
  **nothing**: it recomputes every backfill job's history from the current feed stack against a proxy Store
  that reports every id unseeded, then diffs the recompute against what the DB holds.
  `set -a; . .env.prod; set +a; npx tsx scripts/probe-feed-diff.ts [job …]` (default: every job).
  It answers *"are the stored rows stale?"*. Read its per-id **STALE PREFIX** line: rows older than the fetch's earliest date are a
  population no counter in the probe can compare.
- **"Preview the writes without making them."** → `--dry-run` on the runner, or the prod seed's preview
  (`backfill:raw -- safe --dry-run --env=prod`). ⚠ Never as a pre-step to a real restate/backfill (price-feed quota →
  `dev-workflow.md` §Standing answers for an impag/qimpag round).
- **"A cut moved — propagate it without a full reseed."** → `--restate=<id,…>` re-scores and re-writes just
  those ids' full stored history (`dbreak` jobs only). Bare `--restate` / `--restate=` is a **usage error**,
  not a normal pass. Destructive-gated for the same reason `slow` is.
- **"Regenerate a raw-close vintage for specific ids."** → `--reshadow-all=<id,…>`. Same bare-flag guard,
  same destructive gate; a job that doesn't declare support errors rather than silently dropping the flag.
- **"Did this re-seed silently fall back to the keyless feed?"** → `--require-primary-feed` turns any
  primary→fallback price-feed switch into a hard failure that aborts **before** any write. Unlike the flags above it
  has **no per-job support check** — the runner sets it globally and every job honours it, so reach for it
  on any price-touching re-seed. It is a runner flag only: the cron never parses it, and `prices.ts`
  defaults lenient there so a degraded feed doesn't take the cron dark.
  ⚠ **`--confirm-destructive` IMPLIES it** (ruled `[USER]` 2026-08-02): a destructive pass is a history
  rewrite, so a fallback bakes a second feed's numbers in permanently while still reporting success.
  Where a fallback is BY DESIGN — the pension job's FX re-shadow — pass **`--allow-fallback-feed`**
  to cancel the implication. Passing it together with an explicit `--require-primary-feed` is a usage
  error rather than one silently winning.
  ⚠ **The abort is per-id, not per-run.** An exhausted price-feed free hourly allocation hard-aborts every
  primary-feed id while the job's other-feed ids complete normally, so a destructive pass that reports
  failure has still rewritten part of the history — re-check per id before re-running, and reach for
  `--allow-fallback-feed` locally when the allocation, not the feed, is the blocker.
- **"Size a replay window."** → `--closes=<n>` (`legpillars` only). A bare / non-integer / `<1` value is a
  usage error, never a silent fall back to the job's default.

A genuine re-seed is needed only for **deep history** the probes can't synthesise: detail-chart depth, the
pension track's ≥400 aligned rows, or a brand-new id with no stored series at all.

## [runbook] Deploying to prod — LOCAL by default via `make ship` (schema is a separate step)
- `make ship` = full green gate → `migrate-prod-local.sh` (schema: link → destructive gate → `supabase db push --include-all` → drift verify; idempotent when prod is current) → `deploy-prod-local.sh` (code) → vintage-drift gate (`probe:vintage-drift` vs prod + the applied migrations' `-- restate:` headers; auto-runs the prod re-score (`restate-prod.sh`) of the drifted ids + `--stamp` on restatable drift, `DRIFT-NORESTATE` aborts pre-restate) → `SKIP_TESTS=1 git push` → `smoke-cron.sh` (re-derive). Schema ALWAYS precedes code. **`ship` is NOT an integration gate** — it never calls `scripts/run-integration-tests.sh` and `SKIP_TESTS=1` bypasses the pre-push hook; run it by hand before shipping a store/migration change.
- A plain `git push` deploys nothing and applies no migration — CI on push runs only the unit `check` (~1 min). Skip the schema step and deployed
  code 500s on a column prod lacks while the read API stays green (`select("*")` hides it). Backstop: a scheduled migration-drift check (optional, operator-side; fails on any unapplied migration).
- Break-glass: dispatch the operator-side break-glass migrate job (schema only). The `ci.yml` `deploy` job runs only on a `main` push with repo variable `CI_DEPLOY=true` (+ variables `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `SUPABASE_URL`, `PROD_ALIAS`; secrets `VERCEL_TOKEN`, `SUPABASE_ANON_KEY`); unset, code ships only via `make ship`. Creds: `.env.prod` (`SUPABASE_PROJECT_REF` +
  `SUPABASE_DB_PASSWORD`) + one-time `supabase login` + `vercel login`. No PITR — rollback = forward-fix migration + the data-only backups repo (README §Deploy, `.claude/rules/migrations.md`).
- `make verify` = mid-dev gate (local only, no push); `all-local` aliases `make ship`. Heavy steps are path-conditional (empty range ⇒ run all);
  vitest runs exactly ONCE — DB-armed always in `ship`, in `verify` only when the range touches `src/store*`/`supabase/migrations/**`.
- The release is pinned to ONE commit (`ship.sh` §0a): check tree, deploy payload and push all name `$SHIP_SHA` — the push is
  `git push origin $SHIP_SHA:refs/heads/$SHIP_BRANCH`. Mid-run commits ship next run (a `::warning::` names them); local `main` ahead of origin after a ship is the pin working.
- A deploy alone leaves the board a MIXED VINTAGE: the read API recomputes the ASSEMBLY (family/member panel, ledger cells, floor rows, freshness,
  `/api/exposure` posture) but reads its FACTS (`alert_log.level`/`bandReason`/`dialBand`, `heldSleeve`/`heldDays`, r4/overlay, `tier_state`, per-indicator `state`/`rawState`/`delta20`, the `T1DialResult` blob) from the LAST cron.
- So between deploy and the next cron the screen looks broken — new-code layout over the old cron's severity; nothing is corrupted, no read handler
  writes. `ship.sh` §7's cron run closes the gap (`SHIP_SKIP_CRON=1` opts out, warns) — a daytime ship too: its intraday run writes the `intraday_verdict` slot the verdict reads serve (`REDERIVE=0` opts out). §5b's calibration publish widens it the same way (cuts read at request time).
- §7 is a REAL scoring cycle (`runScoringCycle` → `decideNotify` against prod) — past the 21:05 UTC cutoff a ship whose band differs from the last push
  pushes (a midday ship is intraday: silent, no alert_log row). It cannot double-tick the hold clock: `record_run` is append-only and every prev-state read cuts off strictly before this run's fired-day.
- `deploy-prod-local.sh` creates with `--no-wait` and polls `readyState` itself (state changes + heartbeat) — a blocking `vercel deploy` prints
  "Building…" while still QUEUED, indistinguishable from a hang. Knobs: `DEPLOY_TIMEOUT` (900s; expiry exits non-zero WITHOUT cancelling — re-check before re-shipping), `DEPLOY_POLL` (10s), `PROD_ALIAS`, `DEPLOY_ATTEMPTS` (3).
- A bare `Error: fetch failed` mid-`Uploading` is the CLI's un-retried per-file POST dropping — the create step retries (content-addressed: `missing_files`
  re-uploads only what never landed); a failed create leaves NO deployment, so a retry cannot double-deploy. All attempts fail → `vercel ls --prod` before re-shipping.
- Once `READY` the script asserts the production domain moved to the new deployment — a `READY` deploy that never took the alias leaves prod silently on the previous build.

## [runbook] Trigger the prod cron manually
The prod scoring cron trigger (`scripts/smoke-cron.sh`) fires `/api/cron/run` server-side, then polls **`alert_log` directly** (before the 21:05 UTC intraday cutoff: `readings.run_at`, since an intraday run writes no alert row; its `run_at` must classify intraday via `src/intraday.ts` — past the cutoff a readings-only advance is a seam-stamped pre-`recordRun` write (`seamRunAt`, runAt−1 ms: DB-first tail, backfillHistory, gapFillSweep) and the poll keeps waiting for `fired_at`, failing only at `MAX_WAIT_SECS`; an intraday readings advance is only the cue — the commit sentinel is the `intraday_verdict` slot turning this run (`record_intraday_run` commits readings + slot in one transaction), else it fails at `MAX_WAIT_SECS` like a missing alert row. `REDERIVE=0` = readings only: curl `?rederive=0` with `.env.prod`'s `CRON_SECRET`, slot emptied, every verdict read stays EOD until 22:00 UTC) (never the edge-cached `/api/status`: since S-1 it 400s `?cb=`, so a poll cannot bust the P-2 day TTL and reads whatever shard answers — false-greens on an older run, false-reds while the purge propagates) and asserts `fired_at` advanced to a fresh (<10 min) timestamp. Edge visibility is then checked separately and WARNS (`EDGE_WAIT_SECS`, default 60), never fails the release. Needs the `vercel` CLI authed (`.env.prod` `VERCEL_TOKEN` or `vercel login`) + `curl` + `python3`, **plus `.env.prod`'s `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`** — the assertion reads the table, so a `vercel login`-only machine now exits at the guard before the trigger. Override the target with `BASE_URL=…`. Trigger recipes (curl + `CRON_SECRET`, secretless `npx vercel crons run`) → §[prod] 3. (Local has no cron — seed with `npm run backfill -- all`.)

## [runbook] Prod ops via Management API (no dashboard / no psql)
Auth = `Bearer $(cat ~/.supabase/access-token)` (CLI's stored PAT — header only, never echo). Ref = `prod_project_ref` (`scripts/lib/prod-config.sh`).
- **PostgREST settings** (e.g. `max_rows` — a SEPARATE prod setting `config.toml` does NOT carry):
  `PATCH /v1/projects/<ref>/postgrest` body `{"max_rows":5000}`. Partial PATCH — send only the changed field;
  GET to confirm (its body returns `jwt_secret`, so don't print raw).
- **Read-only prod SQL** → `PROD_CONFIG_DIR=<prod config dir> scripts/prod-sql-ro.sh "<one statement>"` (BEGIN READ ONLY;
  no config → exit 1); falsifiers: `… "delete from readings where false"` → exit 2 (keyword guard, never sent);
  `… "with x as (delete from readings where false returning 1) select count(*) from x"` → `25006` (read-only txn).

## [runbook] Backfill to prod + verifying `/api/series` reads
- **Run a backfill against prod from the host:** the prod seed defaults to `safe` — every job
  EXCEPT the destructive vintage writers (currently `slow`); `all` = complete reseed incl. `slow`;
  `slow` = just that job; `--dry-run` = preview (writes nothing); or any single job name.
  Command: `npm run backfill:raw -- <job|all|safe> --env=prod` (jobs: `indicators`, `slow`,
  `pension`, `bottom`, `cape`, `legs`; selectors: `all` = every job, `safe` = all-but-destructive, derived
  from `DESTRUCTIVE_JOBS` so it never drifts). `all`/`slow` vs prod need `--confirm-destructive`;
  `safe` never does.
  ⚠ **`:raw` is required for prod** — plain `npm run backfill` wraps itself in `db.sh with dev` and would boot a
  local dev stack in front of a prod-targeting run (the bug a prod backfill hit).
  ⚠ **A flag-only invocation is a silent no-op that EXITS 0** — omit the positional `<job|all|safe>` (e.g.
  `backfill:raw -- --restate=ECY --env=prod`) and `backfill/run.ts`'s `if (!parsed.jobs)` prints the job list and
  returns 0, writing nothing. Always name the job: `indicators --restate=ECY`.
  `--env=prod` pulls live prod creds via the Management API using
  `~/.supabase/access-token` + `DEFAULT_PROJECT_REF` (host-only path; `--env=local` loads `.env.local` and prod
  NEVER loads ANY env file — footgun guard in `scripts/backfill/run.ts` — so keyed FEEDS need their key
  exported in the shell — the prod re-score after a cut retune, `bash scripts/restate-prod.sh <id,…> [dry]`, loads the
  feed key (`FRED_API_KEY`) plus the job name (`indicators`/`dbreak`) and `--confirm-destructive`). The `safe` jobs are **idempotent insert-missing**
  on id/date keys (re-run = 0 rows); `slow` is **vintage-shadow** (re-inserts a fresh vintage + self-prunes) —
  idempotent for reads, but a run KILLED between its insert and prune leaves read-invisible disk duplicates the
  next full run cleans up. Either way re-running is safe and deploy-order-independent. (Legacy `scripts/backfill.ts` holds the same
  `backfillBottom`/`backfillPension` fns the registry wraps — invoke via the runner, not the legacy CLI.)
- ⛔ **A MANUAL prod write is invisible to the read endpoints until the next cron run** (P-2, 2026-08-20).
  `/api/series`, `/api/status`, `/api/exposure`, `/api/lab`, `/api/indicators`, `/api/history`,
  `/api/families` and `/api/danger-model` ship `VINTAGE_HEADERS` (`src/api/http.ts`) — a day-long
  s-maxage+SWR whose bust is `invalidateByTag("vintage")`, and that call lives in `api/cron/run.ts`
  ALONE. `npm run restate`, `npm run backfill:raw` and `scripts/probe-restate.ts` write a new vintage
  from a local process with no Vercel runtime to purge from, so **after any manual prod write, trigger a
  cron** (`bash scripts/smoke-cron.sh`) or the board serves the pre-write snapshot for up to 24h.
  Waiting out the window still works; the `&_cb=<nonce>` bust this passage used to recommend **now 400s**
  (`rejectUnknownParams`, S-1). Same cause behind a transient false-BLOCK from `npm run eyeball` right
  after a backfill — the DB is already correct.

**Live deploy status is on-demand:** check it only when the user explicitly asks — when asked, always
verify the *actual* live deployment (Vercel prod alias + latest cron-run health), never local `tsc`/`vitest`
or CI-only signals as a proxy for "deployed and working".

## [prod] overview
# Prod live-regression runbook

How to exercise and verify the **live prod deployment** (Vercel + prod Supabase) by hand after any
deploy that touches the **feeds, scoring, or schema**: schema checks, the host-only seed, triggering
the real cron, reading `/api/status`, read-only prod SQL, and the feed-freshness / flap check. Plus
the gotchas that bite.

Prod project ref: from the prod config — `prodProjectRef` (`scripts/supabase-project.ts`) / shell twin
`prod_project_ref` (`scripts/lib/prod-config.sh`); never hard-coded.
Prod alias: **`<PROD_ALIAS>`** from the prod config (`prodConfigBaseUrl`, `scripts/lib/prod-config.ts`);
hashed deploy URLs are 302-protected.

---

## [prod] Regression checklist (run after any feed / scoring / schema deploy)

Run the subset that applies to the change; disclose any prod rows you add.

1. **Deploy is live** — Vercel Production `Ready` (`vercel ls crash-dash --prod`) **and** CI green
   (`gh run list --branch main --limit 1`). A cron triggered before the deploy lands runs the *old* code.
   **Deployed ≠ run:** a newly-added indicator renders fully empty (no value, `—` dot, empty detail chart;
   `/api/series` = 0 pts) until the first post-deploy cron persists a row — before diagnosing "persistence
   code missing", compare `git show -s --format=%ci <commit>` vs `/api/status` `.verdict.firedAt`.
2. **Schema migrated** — §1 (only if the deploy carried a migration).
3. **Trigger one real cron** — §3. Safe off-schedule; no snapshot needed first (why → Gotchas).
4. **Read `/api/status`** — §4: the field your change affects is populated (not `null` / missing) and
   isolation holds (no cross-channel leakage).
5. **Feed-freshness / flap check** — §5: every leg's newest `obs_date` is within `MAX_STALE_DAYS`, and
   the band isn't flapping `null ↔ value` across recent `fired_at`.
6. **No unexpected ntfy** — a steady-state run logs `No push — silent`; only an *upward* band change
   pushes to the live topic (see Gotchas).
7. **Calibration vintage** (only if a calibration publish ran) — §6: the newest `calibration` vintage
   matches the publish (row count vs the run's `[publish-calibration] wrote N param(s)` log). The vintage no
   longer surfaces on `/api/indicators`; it feeds only the notify path via `resolveCuts`.

---

## [prod] Auth session lifetime
`jwt_exp` 3600 s + `refresh_token_rotation_enabled` (10 s reuse interval); browser renewal is
`auth-session.js` `ensureSession`. Supabase `sessions_timebox`/`sessions_inactivity_timeout` are
**Pro-only** (PATCH → "User sessions can only be configured on Pro Plans and up"), so the 36 h
bound is client-side (`SESSION_TIMEBOX_MS`). Read the live config:
`curl -s https://api.supabase.com/v1/projects/$REF/config/auth -H "Authorization: Bearer $TOKEN"`.

## [prod] Credentials — where they live, never echo them

| Cred | Source | Used for |
|---|---|---|
| Supabase **access token** (PAT) | `~/.supabase/access-token` (CLI's stored token) | Management API (schema queries, read-only SQL, pulling the service_role key) |
| Supabase **service_role key** | pulled live from Management API `…/api-keys?reveal=true` | direct `SupabaseStore` writes (the backfill seed) |
| **CRON_SECRET** | `.env.prod` (line `CRON_SECRET=…`, 64 chars — prod info lives in `.env.prod`, not `.env.local`) | Bearer auth to trigger `/api/cron/run` |

Extract into a shell var, never print the value. `.env.prod` also holds the prod `SUPABASE_*` — grep only
the one line you need (`grep -E '^CRON_SECRET=' .env.prod | cut -d= -f2-`), don't `cat` the file.

**Cloud session (Claude Code on the web) — what to grant, by what the debugging needs** (2026-10-13). Set them
as environment variables in the cloud environment's settings under these exact names; a new session picks them
up. Copy values from `.env.prod`, never `vercel env pull` (Vercel's copies are write-only). Grant the lowest row
that answers the question — a stored-reading question is usually row 1.

| Need | Grant |
|---|---|
| Read stored readings / verdicts, or the upstream feed itself | nothing — `<PROD_ALIAS>/api/*` and the FRED CSV are keyless |
| Read-only store (`getStore("ro")`, read-path `scripts/`) · writes / backfill seed | `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (`"ro"` = the same key behind a `ReadStore` with no write method) |
| Schema / read-only SQL via Management API | Supabase PAT (`~/.supabase/access-token` → an env var) |
| Trigger a cron run · read Vercel logs | `CRON_SECRET` · `VERCEL_TOKEN` |

**Vercel env vars are write-only.** `vercel env pull` returns `""` for them (stored encrypted,
un-readable), so a secret you didn't save is **unrecoverable** — don't try to read it back,
**rotate**: `vercel env rm CRON_SECRET production --yes`, then
`printf '%s' "$(openssl rand -hex 32)" | vercel env add CRON_SECRET production`, then redeploy
(env changes only take effect on a new deploy) and update the `.env.prod` copy. Vercel cron reads
`CRON_SECRET` from env automatically; only manual curl testing needs the literal value.

**Rotation drill — the other two.** Same doctrine (write-only => rotate, never read back):
- **`SUPABASE_SERVICE_KEY`** — never stored by us; it is pulled live from the Management API
  (`.../api-keys?reveal=true`) per run. To rotate, roll it in the Supabase dashboard
  (Project Settings -> API Keys -> `service_role` -> *Roll*), then re-run whatever pulls it; every
  local script re-pulls, so there is no copy to update. The one exception is the `.env.prod`
  `SUPABASE_SERVICE_KEY=` line the prod scoring cron trigger reads — refresh that line after a roll.
- **`VERCEL_TOKEN`** — `vercel tokens ls`, `vercel tokens rm <name>`, then
  `vercel tokens add <name>` and paste the new value into `.env.prod`. An **empty**
  `VERCEL_TOKEN=` there is the intended local setup (the CLI gates on truthiness and falls back to
  `vercel login`), so a rotation that leaves it blank is not a breakage.

**Secret scanners.** `npm run scan:secrets` scans **commits, not the working tree**, so an
uncommitted planted key is invisible to it (deliberate: the untracked, gitignored `.env*` files made
the old working-tree scan permanently red, and a permanently-red scanner is one nobody reads). Both
secret scanners' repo-root configs allowlist only VERIFIED non-secrets and each carries its own falsifier.
Local env files are `chmod 600`.

**Bash shell state does NOT persist between tool calls** (each call is a fresh shell from the
profile). So `export`ed creds vanish next call — re-export in the same call that uses them. Upside:
no risk of a stray `SUPABASE_URL` leaking into a later `npm run check`.

---

## [prod] 1. Verify prod SCHEMA is migrated

Schema reaches prod only via `make ship` (mechanism → §[runbook] Deploying to prod); the merge/CI signal
says nothing about prod's schema, and the read API stays green over a missing column (`select("*")`).
Always verify the actual columns, not just the migration ledger.

(a) The drift/apply jobs are optional operator-side (README §Scheduled jobs and leg runs) — `./scripts/verify-migration-state.sh` is the local check; or use the column query below.
```bash
# (b) authoritative — query the live schema via Management API
REF=$(. scripts/lib/prod-config.sh && prod_project_ref); TOKEN=$(cat ~/.supabase/access-token)
curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"select column_name, data_type from information_schema.columns where table_name='\''alert_log'\'' and column_name = '\''<the new column>'\''"}'
```
Where the operator runs the optional migration-drift job, a green run is strong evidence prod has no
unapplied migrations; the column query is the proof.

---

## [prod] 2. Host-only prod SEED (backfill)

Prod backfills (every job in `scripts/backfill/registry.ts`, `pension` included) run only from the
**WSL host** — no CI workflow runs them:

```bash
FRED_API_KEY=… npm run backfill:raw -- pension --env=prod
```
⚠ **Two separate traps in the `npm` invocation:**
- **`:raw` is required for prod** — plain `npm run backfill` boots a local dev stack in front of the run
  → §[runbook] Backfill to prod + verifying `/api/series` reads.
- **`--env=prod` loads NO env file**, so feed keys must be primed from the prod config —
  `bash scripts/with-prod-config.sh --only FRED_API_KEY npm run backfill:raw -- <job> --env=prod` — or hand-passed. Without `FRED_API_KEY` every FRED
  indicator burns 2×15 s against the keyless CSV host that went dark 2026-07-31 and the seed fails
  wholesale. The hand-passed form is
  `FRED_API_KEY=… npm run backfill:raw -- pension --env=prod`.

How `--env=prod` gets creds (`scripts/backfill/resolve-store.ts`): precedence is
**(1)** `SUPABASE_URL`+`SUPABASE_SERVICE_KEY` already in env → use them; **(2)** `--env=prod`, none in
env → pull live from Management API; **(3)** `--env=local`, none → fail loud. `scripts/backfill/run.ts`
loads `.env.local` **only** for `--env=local` (the footgun guard) — so a host `--env=prod` never
picks up local creds. **Check `env | grep SUPABASE_` is empty first**, else precedence (1) silently
runs prod-flagged against whatever creds are exported.

It's **insert-missing / idempotent**: a fully-seeded store returns a tiny top-up
(`2 row(s) (SPY:1, VEA:1, DEXUSEU:0)`), an empty store ~3×3,800 rows. So a small count = already
seeded, not a failure.

---

## [prod] 3. Trigger the REAL cron (deployed code, Vercel IP)

`/api/cron/run` runs the same `runScoringCycle()` the schedule does, behind `Bearer $CRON_SECRET`
(`api/cron/run.ts`). Use this over a local `tsx src/run.ts` run — it exercises the **deployed** code
from Vercel's IP (upstream throttling differs by IP), and is the authoritative behavior.

```bash
SECRET=$(grep -E '^CRON_SECRET=' .env.prod | cut -d= -f2- | tr -d '"')
curl -s "https://<PROD_ALIAS>/api/cron/run" -H "Authorization: Bearer $SECRET" \
  -w "\nHTTP %{http_code}\n"
```
Returns the stored verdict JSON (200), or a readable 500 body on upstream failure. Each call
persists a real prod run — see Gotchas.

**Secretless alternative:** `npx vercel crons run /api/cron/run` triggers the same endpoint through
the authed Vercel CLI — no `CRON_SECRET` needed (this is what `scripts/smoke-cron.sh` uses).

---

## [prod] 4. Read `/api/status`

```bash
curl -s "https://<PROD_ALIAS>/api/status" -H 'Cache-Control: no-cache'
```
Do **not** append `?cb=…` — since S-1 the handler 400s on an unknown query param
(`{"error":"unknown query param \"cb\""}`), and the request header never busts the edge s-maxage
anyway (§[prod] 3). Confirm freshness via `x-vercel-cache: MISS` or read `alert_log` directly.
Top-level keys: `verdict, readings, asOf, stale, feedAgeDays`. **The pension/slow/bottom fields are
nested INSIDE `verdict`**, not top-level — `verdict.pensionBand`, `verdict.pensionDd`,
`verdict.slowBand`, `verdict.bottomState`, etc. (don't probe `d['pensionBand']` — it's `None` there
and misleads). `readings` = every `ALL_INDICATORS` id minus the off-ladder track legs (filtered via
`OFF_LADDER_IDS` in `api/status.ts`).

---

## [prod] 5. Read-only prod SQL + feed-freshness / flap check

Use to verify what `migration list` (ledger-only) can't — actual rows, columns, RPC bodies.

```bash
REF=$(. scripts/lib/prod-config.sh && prod_project_ref); TOKEN=$(cat ~/.supabase/access-token)
curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"<SQL>"}'
```

**Schema facts (verify before relying):**
- `readings` table: keyed by `indicator_id` + `obs_date`. Pension legs stored under
  ids `SPY` / `VEA` / `DEXUSEU`.
- `alert_log` table: run timestamp is **`fired_at`** (NOT `date` — the verdict's `date` maps to
  `obs_date`, the market date). Pension cols: `pension_band`, `pension_dd`, `pension_us_dd`,
  `pension_nonus_dd`. Slow: `slow_score`, `slow_band`. Bottom: `bottom_state`, `vix`, `vix3m`, `ratio`.
- **`obs_date` is NOT unique per run** — the cron fires several times while the market date holds
  (e.g. over a weekend), so many `alert_log` rows share one `obs_date`. **Order by `fired_at` for
  true chronology**, never by `obs_date`.

**Freshness / flap regression queries** — run after any feed change (why an inner-join binds freshness
to the laggiest leg → §[runbook] External feeds). Confirm every leg is fresh
and the band is stable:

```sql
-- each leg's newest obs should be within MAX_STALE_DAYS of today
select indicator_id, max(obs_date) newest, count(*) n
from readings where indicator_id in ('SPY','VEA','DEXUSEU') group by indicator_id;
-- band stability across recent runs (no null <-> value flapping)
select fired_at, pension_band, slow_band from alert_log order by fired_at desc limit 12;
```

A single leg lagging the others by more than `MAX_STALE_DAYS` is the flap signature. **Fix the
source, not the threshold** → §[runbook] External feeds.

---

## [prod] 6. Verify a calibration vintage published + surfaced

The Stage-2 calibration harness publishes data-driven cut-points to the prod
`calibration` table; the live app reads them through `getCalibration()` and resolves the null/null
calibration cell into the notify path via `resolveCuts`. The vintage no longer surfaces on
`/api/indicators` — the per-cell `modeThresholds`/`modeHidden`/`modeLift` mirror was removed 2026-08-27,
so the DB-rows check (a) is the surviving verification. **Publishing runs on `make ship`** — `publish-calibration-prod.sh` pushes the committed
`calibration.json` (`backtest.yml` deleted 2026-08-15). There
is no cron: the monthly publish + quarterly refresh schedules were dropped 2026-08-01 to stop the heavy
replay burning free-tier CI minutes, so a vintage now lands only when a ship publishes one. Verify with the
checks below afterward.

> **One-shot verifier:** `scripts/verify-calibration-publish.sh` runs checks (a)–(b) below
> (read-only; `--cron` adds a prod-writing `/api/cron/run`). Reach for it after any publish; the manual
> recipes below stay for ad-hoc queries.

**Run modes — only ONE of the two publishes.** The publish step is gated
`github.event_name != 'push' && env.IS_REFRESH != 'true' && <prod creds present>` (the `push` arm is
vestigial — the workflow has had no push trigger since 2026-07-19 and no schedule since 2026-08-01, so
`workflow_dispatch` is the only way in):
- `refresh: false` dispatch — **PUBLISHES.** Replays the **committed**
  backtest fixtures (deterministic, reproducible from the repo) through the live ladder
  and writes the vintage to prod. This is the only mode that lands cut-points.
- `refresh: true` dispatch — **does NOT publish** (`IS_REFRESH=true` gates the publish
  step off). Re-fetches the live upstream feeds, then opens a reviewable PR with the refreshed fixtures
  (`peter-evans/create-pull-request`, branch `backtest/refresh-fixtures`). Two-phase flow: refresh → merge
  the PR → a following non-refresh run republishes matching numbers off the now-fresh committed fixtures.
  Publishing fresh cut-points while the fixtures sit in an unmerged PR would flip-flop prod against the
  committed vintage — hence the gate. The PR step needs repo setting `can_approve_pull_request_reviews=true`
  (else it fails with *"GitHub Actions is not permitted to create or approve pull requests"*). The `fetch.ts`
  shrinkage guard fails the run if any fixture returns fewer rows than committed (partial-fetch signature) —
  override a genuine trailing revision with `ALLOW_FIXTURE_SHRINK=1`.
Only a deliberate non-refresh dispatch lands a vintage — a green CI push is not a publish.

**(a) Rows landed in prod** (Management API, read-only):
```bash
REF=$(. scripts/lib/prod-config.sh && prod_project_ref); TOKEN=$(cat ~/.supabase/access-token)
curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"select computed_at, count(*) n from calibration group by computed_at order by computed_at desc limit 5"}'
```
The newest `computed_at` should match the run's publish time and its `n` the param count the run logged
(`[publish-calibration] wrote N param(s)`). **Publish APPENDS — it never deletes prior vintages**, so the
table accumulates rows (intended audit trail). `getCalibration()` reads the **`calibration_latest`** view
(`DISTINCT ON (channel, metric) … computed_at DESC`), so older vintages are harmlessly superseded per
(channel, metric) — no JS dedupe, nothing to clean up for correctness.

**(b) Vintage drives the notify path** — the per-cell rows no longer surface on `/api/indicators` (the
`modeThresholds` mirror was removed 2026-08-27); the null/null calibration cell now feeds only the notify
path via `resolveCuts`. Confirm it landed by (a)'s row count against the run's own
`[publish-calibration] wrote N param(s)` log, and its EFFECT via the served `readings.state` after a cron
re-derive — a scorer/cut change does not move stored state without a `--restate` (→ §[live] Live constraints).

---

## [prod] 7. Hobby-plan caps (and how to work around them)

- **Scheduled cron: once/day, UTC only.** `vercel.json` schedules `0 22 * * 1-5` (weekday EOD) + `0 5 * * 6` (Saturday
  repair, forced intraday in `api/cron/run.ts`); Hobby fires anytime within the hour. Sub-daily *schedules* in `vercel.json` fail
  deployment on Hobby; sub-daily *HTTP calls* never do — to run more often, call the endpoint
  yourself (§3 curl, `npx vercel crons run /api/cron/run`, or an external scheduler such as
  cron-job.org / GitHub Actions `schedule:`). Timezone-pinned / precise-minute cron needs Pro —
  deliberately not bought ("~after US close" tolerance is fine for a daily drawdown gauge).
  ⛔ **The 22:00 hour is pinned from BELOW by `INTRADAY_CUTOFF_UTC_MIN` (21:05 UTC, `src/intraday.ts`)** —
  any earlier hour is an `isIntradayRun` (in-progress bars, no push, NO alert row), so the daily cron would never
  commit a verdict. And it buys nothing upstream: the F1/F2 credit-spread
  batch publishes in the **US morning**, so 20:00, 21:00 and 22:00 UTC all read the SAME obs date — moving the
  hour changes only when the push lands (01:00–02:00 EEST today), never the data. The upstream publishes no official
  time-of-day for that release and disclaims its calendar as an availability guarantee; only observation pins it.
  Asked and re-ruled KEEP 22:00 ([USER] 2026-08-25).
- **`maxDuration`: `api/cron/*.ts` 300 s (Hobby + Fluid max; `RUN_MAX_DURATION_MS`), read handlers `api/*.ts` 60 s** —
  keep the two `functions` globs disjoint (Vercel documents no overlap precedence); `api/deploy-budget.test.ts` pins disjointness + the cron cap, `public/http.test.js` the read cap.
- **12-function cap** (the Vercel Hobby platform limit) silently freezes prod when exceeded — distinct
  from the repo's own smaller handler-file pin (`api/deploy-budget.test.ts`, §Appendix Live-endpoint
  inventory), which holds the set below it. Guarded by that test
  plus `.vercelignore` (`*.test.ts` — test files would otherwise count as functions). Count it locally:
  `vercel build && find .vercel/output/functions -name '*.func' | wc -l`.
- **Active CPU: 4 CPU-hours/month** — a breach pauses the feature for the cycle (no overage bill); project it
  with `npm run probe:load-budget`.
- **GitHub Actions Free: 2,000 Linux min/month** — `ci.yml` `check` runs on every push, so push cadence is the
  lever: keep `timeout-minutes` tight (speed the job up, never raise the cap), weigh every new/scheduled
  workflow against it, and never re-enable Vercel Git integration (`vercel.json` `git.deploymentEnabled`) for
  a minutes win.

## [prod] 8. Dead-man ping (external cron liveness)

The Vercel cron is the heartbeat; **a heartbeat can't detect its own non-execution.** The dead-man
ping (`dead-man-ping`) is an optional operator-side job on an independent scheduler, run after the Vercel
22:00 UTC run lands (README §Scheduled jobs and leg runs); this repo ships no such workflow.

A watcher, not a redundant trigger: it reads the unauthenticated read-only `/api/status` (no
`CRON_SECRET`), never runs the scoring cycle, and fails when `verdict.firedAt` (the alert row = the
run's commit point) is older than 12h — a `200` alone is not proof the cron ran.

## [prod] 9. Secrets inventory & invariants

Every secret, where it lives, and the invariants that keep them out of git / logs / payloads.
(Access paths for hands-on verification work → §Credentials above.)

| Secret | Where it lives | Used by | Notes |
|---|---|---|---|
| `SUPABASE_URL` | Vercel project env (prod) · `.env.prod` (prod) · `.env.local` (local dev stack) | `store.ts` (server-side) | Project URL; not secret alone but kept with the key. |
| `SUPABASE_SERVICE_KEY` | Vercel project env (prod) · `.env.prod` (prod) · `.env.local` (local dev stack) | `store.ts` (server-side) | **service_role** key — bypasses RLS. Server-side only, never shipped to a client. |
| `SUPABASE_ANON_KEY` | Vercel project env (prod) · `.env.local` (local dev stack) | browser pages (sign-in session) | Public **anon** key — holds no grant in schema `public`; browser REST calls carry a user bearer (`authenticated`). NOT a store key: `getStore("ro")` uses `SUPABASE_SERVICE_KEY` behind a `ReadStore`. Rejected from `.env.prod`. |
| `CRON_SECRET` | Vercel project env (prod) · `.env.prod` (literal copy — prod info, NOT `.env.local`) | `api/cron/run` bearer check; Vercel cron sends it | Write-only in Vercel — unrecoverable, **rotate** don't read (§Credentials). |
| `NTFY_TOPIC` | Vercel project env (prod) · `.env.local` — **a DEV topic, never the prod one** (the two topics are distinct; a local run can never push to the prod topic by accident) | `src/ntfy.ts` via `src/config.ts` | Unset on **prod runtime** → `ntfyTopic()` THROWS (refuses the public `DEV_NTFY_TOPIC` fallback, `src/config.ts`); blank/unset **off-prod** → push suppressed (`ntfyPushEnabled`). |
| `BREVO_API_KEY` | Vercel project env (prod) · `.env.local` (optional) | `src/email.ts` via `src/config.ts` | Brevo transactional-API key for the band-mail fan-out. Write-only in Vercel — rotate, never read back. Blank (prod included) ⇒ `sendBandEmail` warns + skips; ntfy unaffected. |
| `EMAIL_FROM` | Vercel project env (prod) · `.env.local` (optional) | `src/email.ts` via `src/config.ts` | The Brevo-VERIFIED sender. Each subscriber is its own Brevo `messageVersions` entry (own `to`, own body with a prefilled `?email=` unsubscribe link; ≤99 versions per call) — no BCC, nobody sees another address. Not secret. Blank ⇒ same skip as a blank `BREVO_API_KEY`. |
| Supabase Auth redirect allow-list | Supabase dashboard Authentication → URL Configuration → Redirect URLs — NOT in the repo | every magic-link `redirect_to` | Carries `https://<PROD_ALIAS>/**` (checked 2026-09-06 via `GET api.supabase.com/v1/projects/<ref>/config/auth` → `uri_allow_list`, bearer = `~/.supabase/access-token`), so every page path — `/journal`, `/subscribe?a=…`, `/signin` — is covered; a NEW page needs no entry, a NEW HOST does. A `redirect_to` not on the list is silently replaced by the Site URL (`/`), whose `app.js` has no `parseAuthHash` — the fragment is dropped and the visitor lands on `/overview` signed out, with no error anywhere. |
| Supabase Auth "Magic Link" template | Supabase dashboard / Management API `config/auth` (`mailer_subjects_magic_link`, `mailer_templates_magic_link_content`) — NOT in the repo | every OTP mail (journal sign-in, `/subscribe` sub + unsub) | Go-template `{{ if eq .RedirectTo "<pearl>/subscribe?a=unsub" }}` branches give sub/unsub their own subject+body ("Confirm: unsubscribe from crash-dash band alerts"), else the sign-in copy. Renaming the pearl host or the `?a=` values breaks the match ⇒ every mail falls back to sign-in copy. ⚠ The `smtp_*` fields are ONE atomic block in that API: a PATCH naming one nulls the rest — set all six in the dashboard. ⚠ Enabling custom SMTP does NOT raise `rate_limit_email_sent` — it stays at the built-in-mailer default of 2/hour until raised by hand (Authentication → Rate Limits; set 30/h, Brevo free = 300/day). Third OTP mail in an hour ⇒ `429 over_email_send_rate_limit` on /subscribe (hit 2026-09-05). `smtp_max_frequency` (60 s per address) returns the same code. |
| `CRON_BASE_URL` | **GitHub** repo secret | the optional operator-side dead-man ping | Just the prod origin URL — the dead-man reads `/api/status`, no auth needed. |

**Invariants:**
- **Server-side only.** Every secret is read in `api/*` / `src/*` server code; none reaches a
  browser. The read endpoints (`/api/status`, `/api/history`, `/api/series`, `/api/indicators`,
  `/api/families`, `/api/danger-model`, `/api/lab`, `/api/health`, `/api/config`, `/api/exposure`,
  `/api/replay`) return no secret — only public market data. Note `/api/indicators` is **not** static metadata: it resolves the
  bands from the live calibration vintage in the DB (`getStore().getCalibration()`).
- **Never in git.** `.env.local` is gitignored; `.env.example` holds placeholders only.
- **Never in logs/payloads.** Auth is a header bearer compare in `api/cron/run`; never echoed.
- **DB locked down.** `anon` holds no table, sequence or function grant in schema `public`
  (`20261117180000_revoke_anon_data_reads.sql`; falsifier `scripts/anon-read-coverage.test.ts`).
- **Preview shares the PROD database** — `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` are scoped Production+Preview
  (`vercel env ls`); only `CRON_SECRET` (Production-only, `api/cron/run.ts` 500s without it) guards the write
  path, so a write in any other handler is unguarded on Preview.

**Verify (any time):**
```bash
git check-ignore .env.local                       # must print the path (ignored)
git grep -nE "eyJ[A-Za-z0-9_-]{20,}|(SERVICE_KEY|CRON_SECRET)=['\"]?[A-Za-z0-9]" -- . ':!.env.example' ':!docs/**'  # no hits = no leaked JWTs / inline secret values
grep -nE 'SUPABASE_SERVICE_KEY|CRON_SECRET' api/status.ts api/history.ts api/indicators.ts  # no hits = read endpoints expose nothing
```

## [prod] ⚠️ Gotchas / things that bite

- **⛔ A WAF `challenge`/`deny` on `/api/series`, `/api/status`, `/api/indicators` or `/api/lab` takes the dashboard down** — the FE `fetch()`es them and an XHR cannot solve a challenge (refuted 2026-08-30;
  `scripts/waf-custom-rules.json` keeps `api-series-challenge` at `published: false`, DO NOT REPUBLISH). HTML or a 4xx from prod is the WAF — probe `readings` via `resolveStore` (`scripts/probe-parity.ts` pattern).
- **Vercel's own DDoS mitigation challenges any IP after ~15 requests in ~2 min** and `firewall system-bypass` is unavailable on Hobby —
  batch prod HTTP checks into one spaced pass.
- **`firewall diff`, never `firewall overview`** (404s on Hobby); `--condition` takes the OBJECT form only. ⛔ Never delete the live
  `rate-limit-lab-replay` rule — it survives an earlier entitlement and rate-limit rule creation now 401s.
- **`vercel logs` fetches one batch then EXITS** — trigger, wait ~30 s, then fetch + grep. `src/prices.ts` warns
  only on a primary-feed failure, so its absence ⇒ the primary feed served.
- **A prod read served stale after a deploy is the CDN edge, not the DB** — flush with
  `npx vercel cache purge --type cdn -y`, then re-read before diagnosing the handler.
- **A prod probe from a LINKED WORKTREE rejects the loopback** — `npm run wt:link-env` symlinks the primary's `.env.local`. Unset first:
  `env -u SUPABASE_URL -u SUPABASE_SERVICE_KEY npx tsx --env-file-if-exists=.env.prod <script> --env=prod`.
- **Vercel CLI `Error: Not authorized` = a silently failed token refresh** (`~/.local/share/com.vercel.cli/auth.json`); an empty `VERCEL_TOKEN=` in `.env.prod` is INERT, and a passing
  `whoami`/`ls` does not prove the write path. `deploy-prod-local.sh` runs the create under `--debug` and refuses to retry a 401/403 — read the trace's API error code first.
- **`npm start` and `/api/cron/run` send REAL ntfy pushes on an upward alert-level change** (notify-on-change, `run.ts` §6.5) when `NTFY_TOPIC` is set (or on prod runtime; §9 row) — ntfy has no recall.
  Local live-verify divert recipe → §[runbook] Database (local Supabase).
- **Triggering the cron off-schedule is safe — `record_run` is APPEND-ONLY** since `20260717010000_record_run_append_only.sql`; reads resolve same-date duplicates, so a manual
  trigger adds a row and needs no backup-job dispatch first. Still disclose the rows you added.
- **The append-only bullet above is the MAINTAINED copy of the `record_run` regime — never restate it in a checklist or runbook** (§[arch] 9 holds pointers only; every copy has rotted when a migration moved the function).
  On any doubt the newest `record_run` migration in `supabase/migrations/` is the live answer.
- **Calibration publish appends, never replaces** (`recordCalibration` → `insert` in `src/store.ts`; read model → §6(a)) —
  never mutate the table to "clean up"; pruning old vintages is housekeeping, not a correctness fix.

---

## [prod] Appendix: re-bootstrap (recreating the Vercel project from scratch)

Only needed if the Vercel project (or the whole deployment) is ever recreated. Normal operation
never touches this.

**Vercel project settings (import screen):**

| Setting | Value |
|---|---|
| **Framework Preset** | **Other** (no frontend framework — `api/*` functions + static `public/`) |
| **Root Directory** | `./` |
| **Build Command** | leave empty (Vercel compiles `api/*.ts` itself) |
| **Output Directory** | default / none |
| **Install Command** | default (`npm install`) |

**Steps:** `vercel login` → `vercel link` (interactive, user-side) → set the prod env vars
(`SUPABASE_URL`, `SUPABASE_SERVICE_KEY` = cloud **service_role** key from Project Settings → API,
`CRON_SECRET` = long random string, optional `NTFY_TOPIC` — semantics in §9) →
deploy. Schema reaches the (new) prod DB via **`make ship`**, run locally from the host — it migrates
(`migrate-prod-local.sh`) before it deploys. There is no apply-on-merge path (removed 2026-07-19); detail:
`reference.md` §[runbook] Deploying to prod.

**Verify the bootstrap** (deployed run writes to cloud Supabase + reads resolve):

```bash
BASE=https://<your-project>.vercel.app
curl -s $BASE/api/indicators | head            # metadata + vintage-resolved bands (reads DB)
curl -s -H "Authorization: Bearer $CRON_SECRET" $BASE/api/cron/run   # runs the cycle → writes DB
curl -s $BASE/api/status                        # latest verdict + readings (reads resolve)
curl -s "$BASE/api/history?limit=5"             # alert_log rows
```
`/api/cron/run` without the bearer header must return 401; with a missing `CRON_SECRET` env it
returns 500 (fail-loud).

**Live-endpoint inventory — public URLs and handler FILES are not the same set.**

- **Handler files** (`ls api/`): `cron/run`, `status`, `series`, `indicators`, `lab`, `meta`, `replay`,
  `exposure`. That set is pinned exactly by `api/deploy-budget.test.ts` — a new handler file fails
  `npm run check`, so extend an existing response instead of adding a ninth. **The glob is
  `api/**/*.ts`, not "files exporting a GET"** — so a shared, non-handler api HELPER also trips it.
  Such a helper belongs in `src/api/` (`rejectUnknownParams`, `src/api/http.ts`, went there for exactly
  this reason, 2026-08-20).
- **Public URLs with no handler file of their own**: `/api/health`, `/api/history`, `/api/families`,
  `/api/danger-model`, `/api/config` — all `vercel.json` rewrites onto `api/meta.ts?view=…`. They are live
  (e.g. `public/lab.js` fetches `/api/danger-model`); grepping `api/` for a file by that name finds
  nothing and is not evidence the URL is dead.

## [indicator] overview
# Adding a new indicator — checklist

The registry fans an indicator out to several sites. Miss one and it fails silently in a
specific way (noted per row). Verify with `npm run check` + a live `/api/series` probe.

**Start with `npm run new-indicator -- --dry-run …`.** It writes §1's registry entry and the
`FAMILY_OF` row for you and prints the rest of this checklist scoped to your id — the sections below are
the full reference behind what it prints. Process rules for an indicator arc (retune = one-place edit,
sweep-grid membership, plan-time checks) → `.claude/rules/indicator-loop.md`.

## [indicator] 1. Define + register (`src/registry.ts`)
- [ ] Declare the `Indicator` config (id, label, series, `channel`, `thresholds` or `derived`, `unit`).
- [ ] Add it to its **feed array**:
  - keyless FRED level/velocity → `INDICATORS`
  - price-fed → `PRICE_SCORERS` (id→scorer+inputs) — **not** into `PRICE_INDICATORS` (F4/F5/F6/F8/F13) unless a bespoke fn consumes it by name.
  - own feed (EBP/ECB/global) → its own scored block in `run-cycle-feeds.ts`.
- [ ] Add the id to **`ALL_INDICATORS`** — *else `/api/indicators` + `/api/series` skip it (400 on series, blank detail-chart).*

## [indicator] 2. Explainer copy (`public/indicator-desc.js`)
- [ ] Add an `INDICATOR_DESC[id]` entry: `{tip, means, drives}`, plus optional `derivation:{rationale}` (rendered as app.js's "Why these cut-points" block). Threshold-free prose (bands carry live cuts). *Else `indicator-desc.test.js` reds (`npm run check` fails) — it requires an entry per `ALL_INDICATORS` id with `tip`/`means`/`drives`; `derivation` is optional. Add no other keys: every prose leaf is scanned by `public/prose-names.test.ts`'s vacuity floor.*

## [indicator] 3. Deep history (`scripts/backfill.ts` → `specs()`)
- [ ] Add a `{ id, build }` entry reusing the **same `*ReadingSeries` builder + fetch symbols** the live scorer uses (anti-drift). *Else `backfill -- indicators` exits 0 seeding zero history → the detail chart shows only cron-only single-day points.*
- [ ] Bump the hermetic count in `scripts/backfill.jobs.test.ts` (`toHaveLength(N)`) + its id list.

**Retuning a cut ≠ backfilling a source.** A backfill fixes a SOURCE revision (re-fetches the recent tail only); a per-id CUT change invalidates the WHOLE persisted `state` history, and plain insert-missing preserves the stale scores verbatim. Suite AND notify both stay GREEN over the stale history, so nothing surfaces it — after any cut retune re-seed with `--restate=<id,…>` (re-scores existing rows), not `backfill -- indicators`. Flag mechanics + bare-flag guard → §[runbook] Cheaper than a backfill.

## [indicator] 4. Bespoke scorer (only if `thresholds:{}` / `derived`)
- [ ] Add `scoreX` + `xReadingSeries` in `src/scorers-*.ts` (guard-light: return `[]` below the window).
- [ ] **A SCORED `thresholds:{}` price leg fans out ~12 sites — two no plan-grep finds:** (1) `run-dbfirst.ts`'s `scorePriceIndicators` fetch set is built from `PRICE_SCORERS.inputs` ONLY, so a fetch symbol absent there is never pulled (scorer silently sees empty data); (2) a movable-band leg needs a `REACHABLE_IDS` row + a `threshold-config.json` entry, else `validateMultiplierConfig` throws (see step 3 under *Bands* below).

## [indicator] 5. Feeds the danger dial? (only if it drives a family)
- [ ] Add the id to its family + a `MEMBER_WEIGHT` row in `src/danger-ladder.ts` **only** (`MEMBER_RELEVANCE` is derived from weights >0; `public/lab.js` reads membership off the served `/api/danger-model` — no FE copy to mirror, the old CI parity guard is gone). Mirror the served payload into `scripts/preview/mock-data.mjs` (§6).
- [ ] `MEMBER_HELP` string in `public/member-help.js` (tooltip — `public/lab.js` only *imports* it) + `MEMBER_LABEL` string server-side in `src/danger-ladder.ts` (board cell — served via `/api/danger-model`).
- [ ] A family member on a leg also enters the orthogonal `FAMILY_LEG_WEIGHT` axis (`src/danger-ladder.ts` — Level-2 averaging weight): same fixture-regen + `CONC_THRESHOLD` re-eyeball discipline as `MEMBER_WEIGHT`.

## [indicator] 6. Test + preview
- [ ] FRED indicators need **no** bump — `FRED_COUNT = INDICATORS.length` in `run.test-helpers.ts` is derived, so a new `INDICATORS` entry moves the assert with it. A **non-FRED persisted** id does need a row in `run.wiring.test.ts`'s all-calm `EXPECTED_EXTRA` — and in `run.wiring.secondary-feeds.test.ts`'s feeds-down one too unless its feed is one that test downs (price/oil/EBP) — or the `FRED_COUNT + EXPECTED_EXTRA.length` census reds.
- [ ] Add to `scripts/preview/mock-data.mjs` so the preview renders it (falsifier: `mock-data.mjs`'s `labelOf()` throws at import on any id absent from the registry, so a mocked typo fails loudly at preview boot — no count to pair).
- [ ] Goldens: entry in `src/goldens/dispatch.ts` + its fixture series in `scripts/golden-regen.ts`, then `npm run golden:regen` in the same commit — `dispatch.ts`'s `series()` throws on a name absent from the fixture.

## [indicator] 7. Ship + verify
- [ ] **`make ship`** (from the host) — green gate → prod schema → deploy → push → cron re-derive, in that order. *A plain `git push` migrates nothing and deploys nothing (2026-07-19), so the verify steps below would run against the previous build.*
- [ ] The first post-deploy **scoring cron** persists the live point — `make ship` §7 now runs it for you (`scripts/smoke-cron.sh`), so this is a check, not a step, unless you shipped with `SHIP_SKIP_CRON=1`. Deep history still needs a prod seed of the **`indicators`** job. *Never bare `npm run backfill`, and never the raw form without hand-passed keys → `docs/reference.md` §[prod] 2. Host-only prod SEED (backfill).*
- [ ] Probe: `curl .../api/series?id=<ID>` returns points; the id appears in `/api/indicators`.

**Channel note:** no channel is notify-neutral — if the indicator joins a family (§5), calibrate before shipping → see `docs/reference.md` §[arch] 6. Edit-seam FAQ (where common changes go).

## [indicator] Bands & the threshold multiplier

`threshold-config.json` scales an indicator's AMBER/RED bands at score time, only where a scorer reads it —
the reachable set is `REACHABLE_IDS` (`src/threshold-config.ts`), the sole roster. Not every id has an entry.

### Wiring steps

- **1 Config entry** (`threshold-config.json`) — fewer keys than registry ids, nothing enforces one-per-id;
  a missing key falls back to the shared `default`, then 1.0. Check the key exists before assuming it does.
- **2 Wire the scorer** — default to the descriptor field on the shared `ratioReadingSeries` builder:
  `bands: { amber: <AMBER_CONST>, red: <RED_CONST>, firesHighward: <bool> }` (`true` = HIGH is the danger side).
- **2b Fallback hand-call** (a scorer off that builder — `grep 'resolveBands(' src/scorers*.ts` lists them):
  `const { amber, red } = resolveBands(id, <AMBER>, <RED>, <FIRES_HIGHWARD>)` before the loop; compare to those.
- **3 Add the id to `REACHABLE_IDS`** — AFTER step 2, never before (the set catches an unwired id; adding
  first disarms it). `validateMultiplierConfig` throws on a non-default multiplier outside the set.
- **3b The throw has two causes** — the set is hand-maintained: either the scorer is unwired (do step 2) or
  it is wired and the set is stale (add the id). Check the scorer before assuming the first.
- **Config knobs** (`resolveBands`, per-leg first): raw per-leg `amberMult`/`redMult` = a sign-sensitive
  multiply per leg (a negative flips a band's sign — the F6/F8 sign-flip indirection, retired on both; no live user).
- **Shared `multiplier`** = the fallback when a leg has no per-leg value: a missing/zero/negative/non-finite
  per-id value degrades to the top-level `default`, then 1.0 (`resolveMultiplier`); applied via `earlierCut`.
- **4 Test** (`src/dashboard.score-indicator.test.ts`) — derive fixtures from the band constants, never
  literals (F6 derives from `rsCuts(F6.id)`, F8 from the `MU_*` constants — `dashboard.price-scorers.test.ts`); assert the resulting state.
- **5** `npm run check`, then edit the JSON value + redeploy — static import, no hot reload.

### Display line (auto-wired — nothing to do)

- The drawn line/number comes from `api/indicators.ts` `scaleDerived` → `resolveBands`, baked into
  `chart.bands` (`buildChart`); the client reads `meta.chart.bands`, never `meta.derived.amber/red`.
- Pinned: `api/indicators.test.ts` "derived band lines track the config threshold seam".
- Only ids with a `derived` block draw a scalar line; FRED level/velocity ids (F1/F2/R1–R4) draw from
  `thresholds`, which `resolveBands` does NOT touch.
- `scaleDerived` moves the line for EVERY `derived` id, the scorer only for `REACHABLE_IDS` — a non-1.0 mult
  on a derived id outside the set (NVDA, F5) moves the line, not the score. Wire scorer + add id in one change.

### State ribbon (the detail chart's coloured strip)

- The ribbon draws each point's STORED `state`: `/api/series` echoes cron-time `state`/`rawState`/`decision`
  verbatim (the `bespokeStateSeries` re-score branch is DELETED). Never resurrect a re-score branch.
- Accepted Case-2 consequence: a multiplier edit moves the line at once but re-colours the ribbon only after
  the next cron/backfill. The Case-4 gate branch attaches `gates` flags, never re-scores.

### Wired-list (ids whose SCORER consumes the multiplier)

- Roster = `REACHABLE_IDS` (`src/threshold-config.ts`), each id's `firesHighward` noted beside it; read the
  live cut off the descriptor, never a doc row. HIGH-firing ⇒ m<1 moves the cut DOWN; LOW-firing ⇒ UP.
- Seam exceptions: DISP scales its two corr cuts via `earlierCut` directly; FXH's mult ALSO moves
  `fxHavenSeries` band emission in `api/series.ts`; CG is reachable on its VELOCITY leg only (see the set).
- **Display-band parity:** VT/EURC/BUND/GB/DISP also render a `displayBand` line in `api/indicators.ts`
  `buildChart` through the SAME `resolveBands`/`earlierCut` calls — line and cut move together.

### Immovable cuts (zero under the |v|-relative earliness form)

- A zero-valued cut is fixed under `earlierCut` (`|0| = 0`). EURC red and R1 red are zero, each with a movable
  amber sibling, so an override still means something. A retune moves an id on/off this list — check the descriptor.
- NVDA has NO nonzero sibling (amber 0 maSpread, red null): a non-1.0 override is a total no-op, so it is
  dropped from `REACHABLE_IDS` and throws (skip list below).

### Visibility gotcha — worst-of envelope can absorb a small multiplier

- `effAmber/effRed` (and the drawn lines) are `effectiveCuts`' worst-of across ALL legs; the multiplier moves
  only the calib-cut legs at query time (convention thresholds get theirs at registry time).
- A mild m on an id whose BINDING leg is a convention constant (R1 amber, R5) moves nothing visible — that is
  correct, not a bug. Probe or eyeball multiplier behaviour at m=0.5, never m≈1.

### Skip list (deliberately outside `REACHABLE_IDS`)

- These carry inert 1.0 placeholders in `threshold-config.json` but stay OUT of the set, so a non-1.0
  override fails loud (the scorer would silently ignore it):
- `price-accel`, `complacency-vix`, `complacency-high`, `complacency-duration` (SLOW, `src/slow.ts`) —
  percentile / distance-to-high / run-length scorers; no `|v|`-relative cut to scale. **SKIP.**
- `SPY`, `DEXUSEU`, `SP500IT` (PENSION) and `VIX`, `VIX3M` (BOTTOM) — off-ladder legs persisted for
  detail charts/observability, never scored against a movable band. **SKIP.**
- `F5` — the rule is 12-mo-high AND rising; its only derived band is amber 0, immovable. **SKIP.**
- `NVDA` — amber 0 (maSpread) + red null: a non-1.0 override is a TOTAL no-op; DROPPED from `REACHABLE_IDS`
  so it fails loud. **SKIP.**
- `F6` — amber null + red 0 (maSpread vs MA200, the 2026-09-02 rescore): same total no-op; DROPPED from
  `REACHABLE_IDS` 2026-09-05 so it fails loud. **SKIP.**

### Where each indicator's bands live (not all are simple constants)

- **Bespoke price/ratio scorers** (F6, F8, CG, VT, GT, GB, DISP, R7, G1, …) — module constants in
  `family-descriptor-rows.ts` (`RELSTR_AMBER`, `MU_RED`, `CG_AMBER_RET`); a retune edits the constant.
- **FRED level+velocity ids** (F1, F2, R1–R4, …) — `scoreIndicator` against calibrated cuts (`resolveCuts`,
  `src/domain-cuts.ts`), not constants; scale the resolved `opAmber`/`opRed` there (`src/channel-score.ts` is a near-miss).
- Two further seams (both via `CALIB_MAP`, `domain-cuts.ts`) make a retune something other than a constant
  edit — check the seam BEFORE promising a one-place change (`indicator-loop.md` §A retune is a ONE-place edit):
- **Runtime expanding percentile (`synthPriors`)** — no typed cut exists; the scorer computes the pair off the id's
  stored history each run and persists it (`readings.band_cuts`); `/api/series` draws that, never a recompute.
- **A published `evt_*`/`operative_*` row (a MEASURED leg)** — a hand-set registry pair is invisible (the legs
  OR; the lower measured amber binds). Retire the leg (`evtLevel`/`evtVelocity: false`) so the `op` leg scores.
- Retirement changes two things: the `op`/`vel-op` convention leg is strict `>` where the measured leg was
  `>=`, and any guard asserting the vintage has nothing resolving off it any more.

### Direction (important)

- **Normalized shared** (`multiplier` / top-level `default`): `earlierCut` routes through the caller's
  `firesHighward`, so m<1 fires EARLIER and m>1 LATER for every cut, whatever its sign — no sense flip.
- **Raw per-leg** (`amberMult` / `redMult`): a plain sign-sensitive multiply; bands compare with `<=`, so
  whether a factor loosens or tightens depends on the constant's sign and the scorer — check the scorer.

## [dr] overview
No PITR, no down-migrations: rollback = a new forward-fix migration; verify state with
`./scripts/verify-migration-state.sh`.

## [live] Standing closures — do NOT re-open

Prohibitions and live symbols only — the track narrative stays in `git log`.

- **`/lab` legibility + indicator-order (E1–E11).** ⛔ E1 is closed PERMANENTLY in BOTH forms (1-close roster,
  leg-level `confirmedRegime` ratchet). Ruled NOT actioned: F4, F8, T10YIE, T5YIFR, the BRENT drop, the OVX re-cut.
- **E6(b) geo count.** `autoGeoBase` counts distinct FACTORS, not readings — weight-gating and
  provisional-gating are both DECLINED. R2's `Semis` shape-match is the remaining ruled item.
- **E6(b) SPCONC half.** ⛔ DONE — do not re-arm: `MEMBER_WEIGHT.SPCONC` already sits below F5 on every cell
  and `scripts/backfill.ts` already holds its `specs()` entry.
- **EU2 (SovCISS France).** ⛔ REMOVED OUTRIGHT [USER] 2026-09-05 (supersedes the 08-31 KEEP; its marginal bar had FAILED — never re-add on coverage grounds): indicator, descriptor, ECB SovCISS key, backfill job, drift fixture, probe all deleted.
  Prod `readings` rows for `EU2` are orphaned, not deleted (no reader) — `DELETE … WHERE indicator = 'EU2'` is the owed cleanup.
- **T10YIE/T5YIFR cut pairs.** ⛔ FINAL [USER] 2026-08-31, `provisional` dropped — a percentile-asymmetry
  argument is not grounds to re-open them (`docs/indicator-cut-provenance.md` §T5YIFR carries the bind).
- **Notify path (NF-1…NF-6).** ⚠ R4's delay is **3 closes**, not `deEscalationLag`; floors never move position —
  `computeField` reads `dial.band`, so only `r4` touches it. NF-3/NF-4(ii)/NF-5/NF-6 stay RETIRED.
- **Rotation output (R1–R10).** ARM's onset is moved by `ARM_ROC_BP` only — `ARM_LEVEL_PCT` is nearly inert and
  `ARM_RELEASE_PCT` moves duration. ⛔ Do NOT re-ask the ROC question; the release knob was widened instead.
- **Indicator-scoring layer (IS-1…IS-8):**
  IS-x > J1–J8. ⛔ IS-3: deliberately-EARLY hand-set cuts are permanent — **never propose a backtest for a cut**.
- **CAPE cluster.** Valuation's single home is the `ECY` danger member; `computeCapeValuation` serves only the
  /status card + degrade verdict. ⛔ Never add a `MEMBER_WEIGHT[F7]` row (F7 feeds ECY). ⚠ Never re-quote `R²≈0.78`.
- **EU-1.** No `EU1` id exists — the level axis is a market-beta proxy and the 20d speed axis confirms, never
  leads. `xa` is SEATED on `EU-Fin` (the §xa overturn) — the measured zero was overridden, not upheld.
- **SP500IT.** ⛔ Do NOT re-research the six closes-provider leads; rungs 5 / 6-lead2 / 4-lead2 are CLOSED
  UNBUILT on the indicator-value prism.
- **Asia channel (Korea "leads US semis").** ⛔ MEASURED FALSE 2026-08-20 — COINCIDENT, not leading, in both
  `npm run probe:asia-lead` arms (kept runnable). `EWY` stays UNWIRED: fixture + probe are evidence only.
- **G2.** ⛔ `DERISK_DEADBAND` / audit row CORE-2 is CLOSED WONTFIX — wired through `/api/danger-model`, do NOT
  delete it. ⚠ A placebo re-run owes a **fresh** pre-registration (`assertPreRegisteredConstants` throws).
- **Geo-floor counting rule.** ⚠ The WARNING → WATCH prediction is REFUTED live — do not re-assert the flip.
  The `geoBase >= 2 ⇒ WARNING` threshold and the manual/stage addends are UNTOUCHABLE.
- **EW cluster.** ⛔ Do NOT implement W5 5.2's liveness flip (superseded). After W6 an unobserved cell carries a
  shrunk `ŵ` flagged `estimated`, NOT a binary uncomparable flag. Open OQ-4/OQ-5 → `docs/backlog.md` §Open.
- **Rotation W0–W6 ledger.**
  Not-bugs: `SHOCK_RUNG` is decoupled from `ARMED_UNFIRED_CAP`; W2-d `bandReason` is LIVE-ONLY.
- **D9 momentum.** ⛔ Re-opening owes a MEASUREMENT (≥3/9 legs at |momentum|=1), never an eyeball —
  `scripts/backtest/d9-momentum-probe.ts --hist=20 --env=prod`. `MOMENTUM_DIVISOR` stays `√DANGER_CUTS.amber`.

## [live] Live constraints

### Prod store, keys & restate ops

- ⛔ **`cashOverlay` stays `off` until W5-a-FIX-1 is deployed AND ≥3 daily crons have accumulated a rung window** —
  backfill does NOT seed the `alert_log` rung sequence, so a seeded-looking history is not a rung history.
- ⛔ **`hyoas_evt_level_*` must stay present in prod Supabase** — the cron requires it; never drop it.
- ⛔ **`.env.prod`'s `SUPABASE_ANON_KEY` is REJECTED** — LOCAL copy only; deployed `/api/*` uses Vercel's env. No
  store needs it: a `getStore("ro")` script measures prod on `.env.prod`'s service key.
- ⛔ **`getStore("ro")` = `SUPABASE_SERVICE_KEY` behind a `ReadStore`** (`get*` + `checkSchema` + `maxRowsProbe`, no
  write method at run time) — never type a "ro" consumer as `Store`; `SUPABASE_ANON_KEY` is no store's key.
- ⚠ **MAIN checkout's `.env.example` has `SUPABASE_ANON_KEY` emptied in its working tree**; git HEAD still carries it —
  recover with `git show HEAD:.env.example | grep '^SUPABASE_ANON_KEY='`. The inline copy IS the recovery path — do not commit its removal.
- ⚠ **The local dev stack drifts behind `supabase/migrations/`** and fails backfills at the prune RPC with a
  schema-cache "could not find function" — reconcile with `npx supabase migration up --local`, never `db reset`.
- ⛔ **A prod `--restate` is TWO jobs when the ids span detectors** — `indicators --restate=<id>` rejects a `dbreak` id
  (`knownIds` guard); both need `--confirm-destructive` ⇒ `--require-primary-feed`, whose abort is per-indicator, not job-wide; prime `FRED_API_KEY` from the prod config (`scripts/lib/prod-config.sh`).
- ⛔ **`npm run backfill` wraps itself in `db.sh with dev`** and boots the BLOCKED dev stack in front of a prod run
  (a prod backfill hit it). Use `backfill:raw` (the prod seed).
- ⛔ **Never pipe a backfill run through `tail -N`** — it truncates the per-id `re-shadowed N revised tail row(s)`
  line that IS the restate's evidence. Redirect to a log, then grep.
- ⛔ **A failing indicator makes the whole `indicators` job exit 1, so its `pruneShadowedReadings` is skipped** —
  superseded rows survive. Serving is unaffected (`store.ts` serves max `run_at` per date).
- ⛔ **BRENT's newest close (2026-08-03) is an UPSTREAM feed stall, not a stored vintage** — don't restate G1 for it
  again; the gate-absent-on-391-of-500 remainder needs `--restate=BRENT` instead.

### Scoring & read-path model

- ⚠ **Rotation capital lives in an Estonian II-pillar PIK @ LHV** — intra-account trading has NO tax/cost floor (low
  turnover is purely behavioural); the enemy is IDLE CASH (Cash rung stays rare/extreme-only); honest benchmark = Tuleva Maailma (MSCI ACWI).
- ⛔ **`/lab` renders the CRON-vintage persisted state; `/api/series` re-scores latest-`run_at` rows** — after a
  restate they can disagree on identical closes; name which vintage each surface read before calling it a bug.
- ⚠ **F9's CUSUM is LOUD, not near-inert** (`f83180f4`, k 0.5→0.1 / h 3.0→1.5) — every "near-inert" claim in the
  tree is void. **`readings` carry the OLD vintage until the restate.**
- ⛔ **Every measured fire-rate figure for F9's CUSUM is pinned to its (k,h) arm** — the round-2 table in
  `docs/indicator-cut-provenance.md` §F9 does NOT contain the shipped `h`. Read a row, never a number.
- ⛔ **DISP DEGRADES on a frozen tail** — `scoreDispersion` throws when the series' last date ≠ the last aligned
  close; caught by `degrade()` so cron still reaches `recordRun`, but SPY/FEZ/EEM `componentBackfillSeries` rows drop for that cycle.
- ⚠ **`backfill.ts` still writes 0-level GREEN rows for INTERIOR all-degenerate windows** — dropping them breaks
  the contiguous fold `buildReadings` needs.
- ⛔ **`POINT_BAND_CUTS_OF` (`family-descriptor-rows.ts`) is a DISPATCH KEY** — `api/series.ts` routes any id in it through
  `pointBandCutSeries` (CG's branch, WINS on the paramless path); a non-CG id there gets CG-shaped cuts. σ-multiple ids use `POINT_BAND_SIGMA_CUTS`.
- ⛔ **CG read path re-scores `rawState`/`state` on read** (`api/series.ts`), so ribbon and drawn cuts are one model;
  the payload DROPS the unscoreable head (`levelBandHead`) and the ribbon is a NEAR twin of the notified state — a boundary day can differ by one tier.
- ⛔ **2026-07-03 is an unfixable ORPHAN in the STORE** (`ORPHAN_DATE_ALLOWANCE`) — the read path scores it correctly.
- ⛔ **Skew moves CG's p20 cut UP** (deep 0.001776 vs stored 0.001664) — never re-derive it as "down"; before calling
  a CG gap skew, rescore with the production scorer over the DEEP feed, not the stored base.
- ⚠ **`expandingPercentile` is NaN-SKIPPING** — bit-identical on finite input; `liveCut` fails safe to `undefined`.
- ⚠ **A future published `fx/dtwexbgs_*` operative row would be RAW-units and would dominate F9's σ pair** —
  documented in `domain-cuts.ts`, not guarded by a test.
- ⚠ **`getRecentAlerts` collapses same-UTC-date rows** — query `alert_log` directly.
- ⛔ **A `SMOOTHED_LEVEL_OF` id (R8 today) must never take the core loop's stored-series fallback** — its persisted
  `value` is the 21-obs mean, not the feed close, so re-feeding it means-of-means.
- **active-5 = T1 + R1/R4/R5/Y1 (T6 removed 2026-08-12).** ⚠ D6 is AMENDED — bond rung, **instrument = EUNH**,
  validation = VISUAL episode replays only; never validate it by backtest.
- ⚠ **`FXH` 5d-stale = FRED H.10 weekly release lag — expected.** Never file it as a feed break.

### Fixtures, probes & test traps

- ⚠ **`npm run probe:low-tie` is the LOW-branch tie instrument** — read-only, aggregate-only by [USER] cap; its 5-id
  population EXCLUDES F6 and is over-inclusive — re-read its docblock before re-running after a retune.
- ⛔ **`--check-pins` DRIFT is EXPECTED and permanent** — `headArcFlags` pins `FOLD_POLICY.{F1,F2}` +
  `PROXY_Z_RETIRED.{F1,F2}` at pre-arc values. Never "fix" it by re-pinning — that collapses the banked counterfactual to A/A.
- ⛔ **A FLAT F1 fixture can no longer reach RED** (flat ⇒ Δ30d = 0 ⇒ `vel-op` dark ⇒ AMBER under the AND) — use
  `f1RedBothLegs(head)` (`src/run.test-helpers.ts`). ⚠ `HOLD_CLOSES.coin = 3` is close to INERT under arm C.
- ⚠ **`priceUp()` (`src/run.test-helpers.ts`) carries a ±0.05% even-period WIGGLE — NOT inert**: MA-window consumers shift
  ~3e-4, daily-return sd 1.2e-16 → 5.0e-4. `priceUpDeep()` is unwiggled.
- ⚠ **`drift-guard` watches NEITHER shipped instance of the retired-level-axis defect class** (F9 and F11 both left
  its population) and no velocity-only id. Ruled acceptable twice; do not re-litigate.
- ⚠ **`public/leg-attribution.test.js` pins an UNREACHABLE `{id:"F1", leg:"vel-z"}` pair** — green, but no longer
  describes production.
- ⚠ **`scripts/verify-calibration-publish.sh` check 4 is unsatisfiable by construction** — it guards
  `prov.get("convention") == len(d)` on a `{None: 52}` census, so it passes forever; verify the vintage against the `calibration` table rows (check a) instead.
- ⚠ **`synthCutsDegraded` (`src/synth-cuts.ts`) has NO live caller since the provenance drop** — a docblock marker
  plus a passing test READS as live coverage. Retire-or-rewire.
- ⚠ **Retiring F11's level axis leaves F3 as the only `synthPriors` id with a level axis** — the Stage-6.2b
  knife-edge tests lost their carrier.
- ⛔ **A vintage-consistency read over `DOWNSIDE_DETECTORS` AND the `POINT_BAND_CUTS_OF` ids DOES
  falsify CG** — but only against the STORED base, never the deep feed the cron scores on. An `indicators` id in neither map has no falsifier but its own `[backfill] <id>: seeded N row(s)` line (`already complete (0)` = no repaint).
- ⛔ **`SYNTH_PRIOR_IDS` is a SINGLETON — F3 only.** A test using a "live synthPriors id" as a vacuity anchor has no
  successor if F3 leaves; retire it, don't repoint.
- ⛔ **Probe-only danger arms are no longer expressible from production** — `computeField` takes no `ProbeArms`,
  `computeFieldProbe` is the only door. A probe that "stopped working" wants the wrapper, not a new field.
- ⛔ **A completeness-walk test that anchors on a module specifier is blind to re-export barrels** — it passes green
  with sites missing. Pin the hop itself (`percentile.sites.test.ts` derives its barrel set).

### Repo, ship & doc landmines

- ⛔ **A SWEPT-CUT RETUNE IS TWO STEPS AND `npm run check` SEES NEITHER** — the committed artifact
  (`copper_gold_sweep.json`, `warning_fires.json`) only moves when `npx tsx scripts/backtest/replay.ts` re-runs.
- ⛔ **A stale swept artifact is a `make ship` gate failure, not a `check` failure** — and the gate builds from
  **HEAD in a temp checkout**, so commit before re-shipping.
- ⚠ **`v4 §6.2, §6.3, §6.4, §6.4.1, §6.4.2, §6.5.1` live in `## Appendix A`** of design-v4 — same heading numbers,
  so all 43 code cites resolve. Never renumber a `v4 §X.Y`.
- ⚠ **`emit-scoring-constants.ts` emits only the GLOBAL `velocityWindow`**, so the Python side carries no per-id
  window for F1/F3/F9.
- ⚠ **`public/` `esc()` is single-sourced from `chart-primitives.js`**, which also escapes `'` → `&#39;`.
- ⚠ **Every `make ship` is a REAL scoring run that can fire an ntfy push** (`ship.sh` §7); `SHIP_SKIP_CRON=1` opts
  out. ⚠ `crash-dash-ci` is ONE global instance — concurrent `make ship` runs collide.
- ⛔ **The velocity-span commit is a BROKEN bisect point** — it took only the two new `public/velocity-span.*` files; the
  other 22 landed in a later commit. Left deliberately — the amend is the user's call.
- ⚠ **`broad_usd_fires_level.csv` / `_vel.csv` are DELETED** — recover from git history if needed.
- ⛔ **`docs/reference.md` is the merged home; the five old paths are read-only stubs** — its index is
  `grep -n '^#\+ '`; a `§[tag] <name>` cite may resolve to a `###`, which carries no tag.
- ⛔ **The sentinel arms at the PARENT slug only** — the session driver (`impag-chain`, per-user `~/.claude/` config, README §Agent tooling) computes `$mem` from `${PWD//\//-}`, so a worktree
  launch resolves a dir with no `memory/` and the grep fails silently. Verify with the driver's own slug, not the harness's.
- ⛔ **A repo-root `--include=*.md` sweep CANNOT see auto-memory** — `project_state.md` lives in
  `~/.claude/projects/<slug>/memory/`. Add that dir to any cite sweep before calling it repo-wide.
- ⚠ **The exposure-dial rebuild's `mc RED + xa RED` trigger was partly a
  DEAD-FEED ARTIFACT** (F14 frozen) — **verdict stands, basis doesn't**; never re-derive the trigger from that basis.

### Open arcs & owed checks

- ▶ **`VTP.series` is still a display literal, not its real feed's series id** (`registry-composite.ts`) — the
  re-judge of a repoint to the real id is DUE (its blocker, coverage-floor Stage 4.2, shipped 2026-08-01); grep `series` consumers first.
- ▶ **UNEXPLAINED, open investigation: the dial's rung 5 → rung 1 collapse** (opened 2026-08-06; NOT the EBP date
  bug). Next probe: `getReadingsForRun` on both `fired_at` values, diff the vintages, check for a deploy between.
- ▶ ⚠ **A second non-determinism source for the rung collapse**: the Fed restated `ebp_csv.csv` over its whole
  history between vintages — check before blaming deploys.
- ⛔ **OUTPUT-VISIBLE COPY IS FALSE — `public/indicator-desc.js`** still tells the reader the proxy series' numbers are what
  F1/F2 score their borrowed leg against. ⚠ Sweep the CONCEPT, not the word: `reference distribution`, `borrow`, `proxy`, `regime-z`, `z-leg`.
- ⚠ **The re-risk arc's post-ship check**: the first prod close where `dialTargetRung < rungOfSleeve(heldSleeve)`
  must rotate ON that close, `heldDays` resetting to 0 and no "queued" card.

### Accepted design residue and durable lessons

- ⛔ **obs_date regression is ACCEPTED** — the cron can still write a row whose `obs_date` is older than that id's stored max; cause fixed at the FETCH layer only, no write guard by ruling.
  A run's rows are NOT a truthful feed-state source (`/lab` freshness must stay **series newest**) and **no falsifier exists**.
- ⛔ **`SPCONC` and `DB_XLK` ship as STATED, UNVALIDATED priors** — closed on the merits, not deferred; neither
  deferred falsifier will ever be built and band calibration for both is closed ON PRINCIPLE (§[arch] 4).
- ⚠ **Slice 2.1** — `?s=` is no longer a pure function of the query string (it reads the store); an
  unconfigured store degrades to the pre-2.1 shape with a `console.warn`.
- **CALIBRATION-DEPTH** — if a TS scorer is ever reimplemented in Python, a TS↔Python parity check replaces
  the retired C3.
- ⛔ **Any comment a test PARSES is KEEP by construction** — `danger-engine.stand-ins.test.ts` reads
  `STAND-IN AUDIT (…): OK|WRONG` markers out of source. A per-file `tsc` cannot see this class.
- ⛔ **"Describes the past" is NOT the test for superseded prose** — "describes a world that ended" is. A constraint
  moving from prose into the code it governs acquires a self-indictment risk: grep every claim at its NEW seam, excluding comment lines.
- ⛔ **`**` does not cross a dot-segment** (`dot:false`), so `**/CLAUDE.md` never matched `~/.claude/CLAUDE.md`.
  Any rule that must reach a `.claude/` path spells it literally.
