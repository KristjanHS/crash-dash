# Backlog — assistant-owed follow-ups

Permanent, never-archived home for **assistant-owed** follow-ups (contrast: §OWED[USER] below is the
home for USER-owed items — anything only the user can judge or decide).

⛔ **An entry is deleted in the commit that ships its work** — `.claude/rules/plan-hygiene.md` §Archiving and deleting a plan doc.

⛔ **A closed line is DELETED, never a `DONE` tombstone** — `.claude/rules/doc-writing.md` (backlog row); the trigger is read-for-write.

## Open

⚠ `rules` / `expect` are user-set leg fields (CLAUDE.md: no leg field may rely on the user) and `rules[0]` is stale ("holds every tranche", pre-Stage-4) · seam: make `rules` apply-writable via a vetted patch key or derive it at read · falsifier: `grep -c "holds every tranche" public/{value,semis,spit,sp500}.json`

⚠ An API ladder run whose init lacks WebFetch (real-key policy fetch fails → `allow_web_fetch` fails closed) still commits + ships; `<leg>:no-webfetch` only alerts · seam: `scripts/eufin-run-local.sh` ship block (gate on `failed`) or a stream-json init abort · falsifier: `npx vitest run --silent=true scripts/ladder-claude-summary.test.ts`


⚠ **`REDERIVE=0` smoke-cron passes on a seam-stamped write (runAt−1 ms) when the run is killed (504) before `recordReadings`** — no slot sentinel in that mode · seam: `scripts/smoke-cron.sh` REDERIVE=0 branch · falsifier: a `REDERIVE=0` prod scoring cron trigger against a run killed after its seam write must exit 1.



⚠ pick-side knobs (#R2 `CONC_WEIGHT`, momentum, growth tiebreak) were tuned on the CISS scale, never re-walked on share-lit · seam: `danger-concentration.ts` / `danger-engine.ts` · falsifier: `npm run probe:leg-ordering -- --env=prod --walk=2022-01-01..2022-12-31 --held`

⚠ F1's served percentile cuts (`f1_cuts.json`) were measured on weekend-tainted HY OAS rows — `scripts/backtest/f1-percentile-cuts.ts` + its test read `loadHyOasVintageAsFiled()` (n 1307→1291 weekday-only) and `scripts/backtest/data/hyoas_live_overlap.json` carries weekend rows; its live-tail splice now drops weekends, so the next regen mixes both · seam: switch both to `loadHyOasVintage`, recapture the overlap fixture, follow `indicator-cut-provenance.md` §Read/write protocol · falsifier: `npm run probe:f1-cuts` regen + `scripts/backtest/f1-percentile-cuts.test.ts` green on weekday rows


⚠ sp500 `--replay=p0:*` is deferred (throws): sp500 `firesAt` ≡ spit `firesFrom` except the binding split · seam: extract into `scripts/ladder-tranche.ts`, give sp500's `replaySpec` a `head.p0` · falsifier: `npm run probe:sp500-tranches -- --replay=p0:sweep` exits 0

⚠ sp500 breadth watch rows are manual ([USER] 2026-10-24: own plan) — needs a daily job over ~500 member closes → % ≥20 % off 52-wk high, % > MA200 · seam: new member-breadth feed · falsifier: `npm run -s probe:sp500-tranches` grades the breadth row

[USER] `/spit` 2026-10-22 (crowding row next due): cite etf.com 10-15 daily flows https://www.etf.com/sections/daily-etf-flows/etf-fund-flows-semiconductors-leveraged-etfs-dominate — 10-14 creations SOXL $1.71 B (AUM $22.39 B) · NVDL $1.08 B · TQQQ $654 M · SMH $618 M, QQQ redemptions -$4.28 B — in the crowding finding (lean stays neutral; etf.com 403s the fetcher, user pastes) · falsifier: `grep -c 'etf-fund-flows-semiconductors' public/spit.json` (0 until written); delete this line in that commit.

[USER] `make ship` the Saturday repair cron (`0 5 * * 6`, `isIntradayCronRun`) · falsifier: `npx vercel crons ls` lists both entries.

[USER] `$LADDER_RELEASE_MAKE ship` (carries the 2026-11-19 semis live-state commit + the ECB 15 s × 2 fix) → `make ladder-prod` → `systemctl --user enable --now ~/projects/crash-dash/scripts/systemd/crash-dash-eufin.timer` · falsifier: `npm run -s probe:prod-full` → c10 PASS after the next timer run, c4 PASS on the next 5 EOD crons.

[USER] `.claude/rules/indicator-loop.md` `paths:` still lists the deleted family-descriptor barrel — re-point to `src/family-descriptor-rows.ts` · falsifier: `! grep -n 'family-descriptor.ts"' .claude/rules/indicator-loop.md`

[USER] `.claude/rules/dev-workflow.md` says lint:ts is "8 rules" — `eslint.config.mjs` now carries 11 · falsifier: `! grep -n '8 rules' .claude/rules/dev-workflow.md`

[USER] read-only prod role `crash_ro`: `scripts/setup-prod-ro-role.sh` fails 42501 (superuser check — try dropping NOSUPERUSER/NOREPLICATION);
then allow-list `scripts/prod-psql-ro.sh` + deny Edit/Write on it, drop the `prod-sql-ro.sh` allow.

[USER] phone eyeball, ranked: tap a chart → crosshair + bar stays after lift; tap the bar → full text; `3m` → every chart redraws ~63 pts; margin taps read first/last sample; swipe scrolls.

⚠ guard-ask re-measure owed on/after 2026-11-20 — **trailer audit only**: since 2026-11-18 the hook warns the agent instead of asking (GUARD_ASK=1 restores the ask), so no new `hook:PreToolUse` ask records land and the ask-count half of the re-measure is retired (sample ends 2026-11-18) · seam: `.claude/hooks/guard-ask.mjs` · falsifier: `npm run probe:guard-ask -- --since=2026-11-13` (trailer audit)

[USER] restart Claude Code so `.claude/settings.json` loads (`guard-ask` hook + `CLAUDE_CODE_FORK_SUBAGENT=0`); the next ladder run checks its `Agent` call blocks.

⚠ `danger-deadband.ts` EW ROC lookback 20 rests on "every EW member is DAILY" — ECY (`vb`) is monthly · seam: EW ROC lookback · falsifier: a monthly-step ECY fixture through the deadband ROC

Re-landing a `mixed:` event as `escalation:` sets `block` on its sign rows without the "finding not rewritten for <row> after <event>" check (`src/ladder-run.ts`, the check skips any event already landed) — output-visible (a block with a stale finding). Fix: gate on `!unresolved(was)` plus a same-status skip; found in the order-plan row 12 review.



[USER] Value escalation box retune candidate (measured 2026-10-13): with the box disabled (ESC_NEED 7) the P5 holdout worst bear reads +0.0 % vs −0.6 % and the `all` column +35.3 % vs +33.7 %, worst fill −11.4 % unchanged, sweep inert — the box costs holdout return and protects nothing in either window. Kept by the S5 rule (any change → keep); dropping `escLeg` + `tally`'s guard (display table stays) is a user call.

⚠ `/lab` `span.leg-calm` is a DEAD `[title]` host on tap in scenario/replay/episodes modes (mobile tooltip unreachable) · seam: `public/lab*.js` leg-calm render · falsifier: `node scripts/preview/mobile-tooltip-audit.mjs` exits 0


⚠ G1 is UNGRIDDABLE on prod (1 independent calendar source), so the release-delay snapshot carries its last measured `1` by hand; `RELEASE_DELAY_HAND_FLOOR` (`src/release-delay.ts`) re-applies it on every regen, so the live defect is only that it is unmeasurable · seam: `containmentGrid` peers for G1 (`src/publication-calendar.ts`) · falsifier: `npm run probe:release-delay -- --dry --ids=G1` prints `delay=`.


⚠ BBB scores at its hand floor 1 (`RELEASE_DELAY_HAND_FLOOR`) until ≥5 live samples — then drop it from the map · seam: `src/release-delay.ts` · falsifier: `npm run probe:release-delay -- --dry --ids=BBB` (prints `HAND FLOOR` until measured)

⚠ run-path vs read-path publication-grid SOURCE parity is untested — `lagCalendarsFrom` (`src/scorers-core.ts`) and `gridFor` (`src/feed-lag.ts`) build `containmentGrid` pools apart
seam: a parity test feeding one store's rows through both · falsifier: change one pool's `independent`/composite-leg rule — `npm run check` stays green today.

⚠ F17 has no direct override-retirement pin — `RULED` in `src/registry.test.ts` (`per-source lag overrides - E7`) omits it · seam: add `F17: { cadence: "daily" }`
falsifier: give F17 a `lagAfterDays` in its registry cfg — `npx vitest run --silent=true src/registry.test.ts` stays green today.


⚠ The 2026-09-22 Health cells (R1 0.2 · R7 0.1 · CQS 0.1 · R5 0.5 · F1 0.6) rest on a 2y VISUAL read, unmeasured — owed: a prod read-only probe of each member's severity vs `LEGP_HEALTH` drawdown over the same window, and, before any F9 `Health` seat, which way the EUR-holder correlation runs (USD weakness, not strength, is the QDVG-in-EUR drawdown channel).


⚠ `/journal`'s drawdown card, the ladder `<select>` and the pension-free `/` have never been painted — J1/J2/J4 shipped 2026-09-07 with unit parity only · seam: the `/journal` drawdown card · falsifier: sign in with ≥2 entries and hand-chain the same `LEGP_*` rows against the card's dd %. · not run (2026-09-13 sweep: manual class excluded)

⚠ Local dev DB cannot restore the `alert_log` snapshot — `mode_channel_scores` column missing locally (migration in repo, prod has it), so the §[dr] restore test (`docs/reference.md`) is red for the one irreplaceable table · seam: local `supabase_db_crash-dash` migrations · falsifier: the restore-test loop exits 0 for `alert_log` once local is migrated/reset. · not run (2026-09-13 sweep: manual class excluded)


⚠ Value column + `LEG_TOP.Value` re-check after the 2026-11-30 MSCI Enhanced Value rebalance — MU's ~14% resets on a fresh value score · seam: `MEMBER_WEIGHT` Value cells (F8/F4/R5/VT/F17) + `FAMILY_LEG_WEIGHT.vl` · falsifier: `npm run probe:leg-ordering -- --env=prod` before/after. · not run (2026-09-13 sweep: npm-probe class excluded)

⚠ EW-cluster open questions — OQ-4 (compensatory aggregator / AMPI) owes an evidence round; OQ-5's homogenization-inside-the-form bullet is open · seam: `src/danger-engine.ts`. · falsifier: none stated (2026-09-13 sweep)

⚠ R8's bull-steepener escalation (`shortLegWindow/DropBp`) rests on practitioner commentary only — the 2026-08-31 literature search found no measured test; R1 dropped its own · seam: `src/registry-fred.ts` R8 cfg · falsifier: none until a probe runs R8 escalation-off vs on over 2006→today (`probe:r1-lit`'s `steepenerEscalationSeries` arm is the template). · not run (2026-09-13 sweep: manual class excluded)



⚠ Machine-enforce the two prose-only plan-hygiene cite rules — they bind `docs/` where the guard never walks · seam: `scripts/check-rule-cites.test.ts` — widen the no-prefixed-`docs/plans`-cites check to `docs/**/*.md` and extend `§`-resolves to `.md → .md` · falsifier: a `docs/plans/<stem>.md` cite in any `docs/*.md` passes today.

⚠ `CG` (38), `NG` (2), `ECY` (1), `SPCONC` (1, newest row, written after the 10-03 restate) store states the recompute disagrees with at identical values · seam: stored `bandCuts`/`rawState` vs the recompute's, per id · falsifier: `probe-feed-diff.ts indicators` shows 0 flips for the id.

⚠ OQ-1 — re-run the band-selection probe against the SHIPPED `RERISK_DEADBAND` (`DANGER_CUTS.amber / 2` since 2026-08-07, not the frozen pre-2026-08-07 width `DANGER_CUTS.amber`) · seam: `RERISK_DEADBAND` (`src/danger-engine.ts`) · falsifier: the probe must read the constant, not a literal — a hardcoded legacy width reports agreement by construction. · not run (2026-09-13 sweep: manual class excluded)

⚠ Owed 2026-09-07 — the A3 re-measure: re-measure the four files' chars; success = 08-07→09-07 growth below the 08-01→08-07 weekly rate; one measurement, then close · falsifier: a growth-composition query must still separate new-section from existing-entry growth. · not run (2026-09-13 sweep: manual class excluded)

⚠ The per-run streak tick has no test — same close, two `fired_at` values ⇒ `reriskConfirmCount` advances while `heldDays` does not; it needs a trend-vetoed fixture at the `assembleRun` layer with injected `globalFamilies: trendRed` (lift the shape from `src/run.alert-state.test.ts`'s re-risk-basis-epoch describe) · falsifier: at `RERISK_CONFIRM = 1` an un-vetoed re-risk resets the streak on both runs, so the counter cannot advance. · not run (2026-09-13 sweep: manual class excluded)


⚠ Search the established approaches to cross-asset factor reach weights (measured betas / shrinkage / PCA vs asserted expert prior) — informs whether `FAMILY_LEG_WEIGHT`'s hand-set-prior house style stays; not a defect report against any current weight. · falsifier: none stated (2026-09-13 sweep)

⚠ Dangling rule-`§` cites in `docs/**.md` are unguarded — `collectSectionCites()` walks only `src api scripts public`; widening needs a tombstone convention + an archive policy first · seam: `SOURCE_DIRS` in `scripts/check-rule-cites.test.ts` · falsifier: re-take the population with the walker's OWN gap regex + resolution rule, never a prose grep — the two disagree on the denominator. · ambiguous (2026-09-13 sweep): falsifier needs the walker's own gap regex run, not a grep

⚠ `<file>.md §<text>` cites onto non-rule docs are resolved by nothing — the sixth `check-rule-cites.test.ts` assertion's stem alternation is built from `.claude/rules/*.md` only · seam: that stem alternation · falsifier: grep `src api scripts public` for `\.md §` cites outside the eight rule stems — none resolve, including cites onto plan-doc bold paragraphs.

⚠ The roster 75-vs-74 population drift is pinned by nothing · falsifier: a test asserting either number — none exists, so both counts stay simultaneously "true" in prose.

⚠ The "two sources must agree — a hand-copied literal is a THIRD source" invariant is orphaned (an earlier commit removed its rule section; no successor) · seam: `public/sub-dangers.test.js`'s `DANGER_CUTS` import from `src/danger-engine` · falsifier: re-type `DANGER_CUTS` as a literal there — suite stays green; restore the rule or lint `public/*.test.js` literals mirroring an importable server constant. · not run (2026-09-13 sweep: manual class excluded)

⚠ Three fixture-derivation drift sites survive the retired dial-book guard, each in a non-dial producer: `src/alert-band.floors.test.ts` hand-types `coverageDegraded` (an output of `computeFamilyPanel`; its `noteFor([], [])` case is unreachable), `src/families.test.ts` `mkPanel`'s `contribution` map restates the producer's state→weight mapping, `scripts/probe-feed-lag.test.ts` `row()` hand-types `impliedCadence` beside a derived `cut` · falsifier: mutate the named producer's mapping — these fixtures stay green. · not run (2026-09-13 sweep: manual class excluded)

⚠ Retune `GROWTH_RS_WEIGHT` + `GROWTH_MOM_WEIGHT` 0.95 → the then-measured `familyLegWeight("uT", ·)` mean ([USER] 2026-08-02, record-now-retune-later). The retune commit moves BOTH constants, re-measures the mean at that commit (never copies 0.933333 forward), and owes a growth-fold before/after on all nine legs · seam: `computeLegGrowth` (`src/growth.ts`).

⚠ No roster-independent pin for the bound's COMPOSITION inside `familyCells` — since the 2026-08-07 regen the ŵ literal no longer differs from `wHatUnbounded`, so composition is pinned not at all · seam: a loop over `committed.cells` asserting `limitedTranslation(c.wHatUnbounded, c.rawSens, c.sigma) ≈ c.wHat` · falsifier: an argument-order slip in that call passes today's suite. · not run (2026-09-13 sweep: manual class excluded)

⚠ Nothing pins the exo-saturated leg-danger ordering — on an exo-saturated close all nine leg dangers equal `OVX weight × EXO_SCALE`, and a `DANGER_CUTS` move re-ranks them with a green suite · seam: `EXO_SCALE` derivation (`src/danger-engine.ts`) · falsifier: a golden at a known exo-saturated close (2026-07-31 is one) — none exists.

⚠ The OQ-5 6.1 fabricated-calm detector was a throwaway one-off — the only check that catches Option A2 silently reverting (a measured cell with `observed.fresh + stale === 0` carrying `wsev !== null`) is not in `scripts/` · seam: promote it beside `probe-absence-field` as a re-runnable guard. · falsifier: none stated (2026-09-13 sweep)

⚠ Ledger panel: no Playwright/screenshot cover — `wireCellTip`'s open/pin/close and `placeCellTip`'s viewport clamp are DOM behaviour the pure-seam suite cannot reach. · falsifier: none stated (2026-09-13 sweep)

⚠ Semis watch lead re-test — TRIGGER: a SEC0 episode exiting after 2026-10-13: bump `TO` in `scripts/capture-semis-watch-fixture.ts`, run `npm run probe:semis-watch-fixture`, then `npx vitest run scripts/probe-semis-tranches.watch.test.ts`; a context lead row (`hcx`/`ry`/`rs`/`dram`) that passes admission drops `role: "context"` · seam: `SEMIS_WATCH` (`scripts/semis-watch.ts`), knobs in `scripts/probe-semis-tranches.ts`.

## 2026-08-30 — R6's read-time ribbon diverges from its scored state (C5 rung)

## `/lab`'s LIVE branch serves a WALKED held with zero disclosure

⚠ A hand-typed `/lab?walk=N` on the LIVE board prints the day-N hold as the held sleeve with no trajectory log and no footer clause (both gate on `mode === "scenario"`) — documented in `openapi.yaml` but never decided; output-visible, triage as a bug · seam: `gateHeld(liveField, walkedVerdict.heldSleeve)` in the LIVE branch (`api/lab.ts`) — either pin live to the incumbent like scenario, or render log + footer whenever `walkPath` is present · falsifier: `/lab?walk=20` on LIVE shows a walked held with zero disclosure. · not run (2026-09-13 sweep: manual class excluded)

## 2026-08-06 — proxy-z retirement residue

⚠ Comments still claim to mirror the deleted live proxy-z path — `scripts/backtest/replay.ts` cites `proxyZSeries` (a symbol that never existed under that name), and `src/api/types.ts`, `scripts/backfill.ts`, `src/effective-cuts.test.ts`, `public/generic-detail-chart.test.js` carry the same class · falsifier: `grep -rn 'proxyZSeries\|proxyZFor' scripts/ src/` returns hits.

## 2026-08-05 — three more from the F1/F2 Stage-7 review's non-probe half

⚠ `public/held-path.test.js` "SCENARIO_WALK_DAYS — one touch point" block asserts only `Number.isInteger`/`> 0` while the single-touch-point claim is already false (the value is restated in prose in two places) · seam: the block's claim vs `held-path.js`'s single-source docblock · falsifier: retune `SCENARIO_WALK_DAYS` to 6 — suite green while prose asserts 10; the fix owes a file-wide grep of the VALUE. · ambiguous (2026-09-13 sweep): falsifier is a retune + suite run, not a file check

⚠ `scripts/probe-leg-ordering.ts`'s parenthetical rationale for the multi-line-import count is false (the counts re-count correctly; the stated shape rule does not) — fix the rationale before anyone keys a falsifier on it. · falsifier: none stated (2026-09-13 sweep)

⚠ `public/held-path.test.js` re-risk-direction test is non-discriminating — day 1's `reriskConfirmCount: 1` makes the fallback return the same string as the branch under test; set it to 0.

⚠ `public/lab.js` footer prints `no in-band sleeve` under a trajectory table still painting "today → Value" when the incumbent is null — `heldWalkPhrase` interpolates only inside the truthy-`held` branch. · falsifier: none stated (2026-09-13 sweep)

## Oil-trio arc (R4/R6) — assistant-owed remainder


⚠ `trailingPeakLegs` hard-wires `levelGateState` — a future `"and"`+trailing-peak id would mute at underrun; consider rejecting non-`"split"` combines there. · falsifier: none stated (2026-09-13 sweep)

⚠ Fold-oracle combine step leans on production `combineLevelVelocity` — inline the GREEN-level mapping if independence matters. · falsifier: none stated (2026-09-13 sweep)

## 2026-08-07 — `run-cycle.ts`'s prev-state comment describes a reversed migration as live

## 2026-08-07 — three pins the lead-precedence gate took with it when it was retired

⚠ `selectMemberStateMap`'s merged-vs-raw-held choice is unpinned (unobservable through the only consumer; docblock already corrected) · seam: `src/dial-assembly.ts` — a real pin needs a second consumer or a live-only-member assertion · falsifier: revert the held branch to `buildMemberStateHeldAt(cissHistory!, 0)` — the whole suite stays green. · not run (2026-09-13 sweep: manual class excluded)

⚠ `dial-assembly.test.ts`'s "ruling 10 — COLD store" and sibling 6.1 tests no longer discriminate — deleting or inverting `noHoldDepth` moves the prod dial band (= the notify band) with the suite green · seam: those two tests' fixtures. · falsifier: none stated (2026-09-13 sweep)

⚠ `api/lab.ts`'s ruling-12/13 held-map wiring is completely unpinned; a cheap post-gate replacement raises a slot member via the hold window · falsifier: pass `undefined` at the two `techConfirmerFromPanel` held-map call sites and re-run `api/lab.test.ts` — green. · not run (2026-09-13 sweep: manual class excluded)

⚠ Every "merged vs raw-held" delta claim is now suspect (`--before=s61` is A/A by construction, third instance of the class) — sweep the claims in one pass, not per-arm. · falsifier: none stated (2026-09-13 sweep)

## 2026-08-08 — two review findings R4's fix round left open

⚠ R3 may have under-restored a duty — `research-probes.md` §Three smaller traps' "opening a previously-INERT leg/axis is a BEHAVIORAL expansion" has no equivalent in `indicator-loop.md` · seam: `.claude/rules/indicator-loop.md` · falsifier: grep it for an equivalent clause; if none, a descriptor edit that opens an inert axis loads no rule saying to verify the ripple.

⚠ `diffWeights` sees only cells that DIFFER, so a control literal rotted into HEAD's value drops out of the edit list silently and the probe can print `IDENTICAL BY ALGEBRA` for the wrong reason · seam: `diffWeights`/`evaluateBeforeArm` in `scripts/probe-leg-ordering.ts` · falsifier: set one frozen literal to HEAD's current value and run the arm — it certifies instead of aborting. · not run (2026-09-13 sweep: manual class excluded)

## 2026-08-08 — `frontend.md`'s ESM syntax gate is a false-pass

## 2026-08-08 — four Suggestions from the doc-layer token-diet R4/R5 review

⚠ The `COMPOUND_RISK_FLOOR` no-occupancy-series claim has two touch points in `src/exposure.ts` (the graduated block vs the pre-existing `[USER DECIDED]` block) · falsifier: if both say the same thing about `/api/replay`/`replayExposure`, delete the graduated one. · not run (2026-09-13 sweep: manual class excluded)

⚠ A test-fixture constraint sits on a production constant — `CALM_2024`'s tripwire note landed on `DUAL_AXIS_IDS` (`src/domain-legs.ts`) while the fixture file carries it in detail · falsifier: `CALM_2024` is defined TWICE in `src/crisis-indicators.test.ts` and the graduated comment disambiguates neither.

⚠ The veto-cap C6 deletion left no carrier in the main tree — reference.md's surviving sentence still implies a combine-level power-mean base exists · seam: `combineLegDanger` (`src/danger-engine.ts`) — a one-line docblock stating the deletion closes it · falsifier: `grep -rin 'VETO_CAP\|veto.cap' src/` returns zero.

## CG vintage falsifier — review follow-up (2026-08-08)

## 2026-08-08 — F9's persisted `state` column is a retired vintage

## 2026-08-08 — F13's two-leg rule: the lattice is open-coded

⚠ Route `creditAppetiteReadingSeries`'s classify through `combineLevelVelocity(…, "split", …)` — F13's RED=AND / AMBER=either lattice is bit-for-bit the shipped `"split"` mode, making an AND⇄OR flip a one-word data edit · seam: the `classify` callback in `src/scorers-price.ts` (per-leg banding stays) · falsifier: the F13 describes in `dashboard.price-scorers.test.ts` and the F13 golden must stay green with NO rebaseline — any churn means the lattices were not equivalent. · not run (2026-09-13 sweep: manual class excluded)

⚠ `scripts/backtest/f1-percentile-cuts.ts` measures F1 lead times against a scorer that no longer exists (`replayConfirmed` folds at 2 closes; live F1 is 0 since IS-5 — pessimistic by up to 2 td, conservative direction) · seam: `replayConfirmed` — switch to `confirmClosesFor("F1")` or report both buffers · falsifier: `FOLD_BY_SITE.backtestHarness` pins the gap as a FACT; nothing fails while the bias persists.

## 2026-08-09 — engine / dial / API, drained from auto-memory's NTH sections

⚠ **Owed: `DISP` has two cut legs but silently ignores per-leg multipliers.** `validateMultiplierConfig` ACCEPTS `DISP: { amberMult: 0.9 }` on any `REACHABLE_IDS` member and it does nothing. **Seam:** `dispersionReadingSeries` in `src/scorers-composite.ts` routes only the shared `m` through `earlierCut`, never `amberMult`/`redMult`. **Falsifier:** `grep -c 'amberMult' src/scorers-composite.ts` → 0.

⚠ **Owed: `EW_ROC_LOOKBACK` 20 → ~5** — 20 was sized to the retired monthly/quarterly EARLY-WARN members. **Seam:** the knob in `src/danger-engine.ts` plus the tombstoned comments in `src/api/types.ts`, `public/sub-dangers.js`, `public/app.js`. **Falsifier:** `grep EW_ROC_LOOKBACK src/danger-engine.ts` still reads 20 ⇒ open.

⚠ **Owed: UTC cast belt-and-braces on `record_run`.** **Seam:** a migration `alter function record_run(jsonb, jsonb) set timezone = 'UTC'`, guarding `(fired_at at time zone 'utc')::date`. **Falsifier:** `grep -rn "set timezone" supabase/migrations/` is empty ⇒ open.

⚠ **Owed: CISS depth non-monotonicity wants a falsifier.** On constant input `EW(t)` drops 0.36 → 0.1805 at depth 29–30 and returns at 31 — it moves `danger`, the SORT KEY. Pre-existing. **Seam:** `cissForm` in `src/danger-engine.ts`. **Falsifier:** none exists; a constant-input monotonicity assertion across depths 1..40 is the missing test.

⚠ **Owed: degraded (dial-less) runs persist `held_days=0`, wiping dwell.** Fail-safe, but one degraded cron mid-dwell restarts the 10-close clock. **Seam:** the dial-less branch in `src/run-core.ts`. **Falsifier:** run a degraded cycle mid-dwell and read `held_days` back. · not run (2026-09-13 sweep: manual class excluded)

⚠ **Owed: decide whether `cross-asset` contributes to any breadth count.** It is amber-or-worse on 99.5% of closes, so it may carry no information. Independent of the E8 `R4_ENTER_FAMILIES` decision. **Seam:** `src/families.ts`. **Falsifier:** recompute the amber-or-worse rate over the stored history; ≥99% ⇒ still inert. · not run (2026-09-13 sweep: manual class excluded)

⚠ **Owed: two stale claims found beside the trend work.** (1) the `GLOBAL_FAMILIES` trend-override comment is stale against the literal below it; (2) `public/indicator-desc.js` declares itself "deliberately threshold-free" while F4's `drives` hardcodes a cut that a non-1.0 multiplier falsifies. **Seam:** `src/families.ts` and `public/indicator-desc.js`. **Falsifier:** rotted-claim class — grep file-wide, not at one site. · ambiguous (2026-09-13 sweep): 'deliberately threshold-free' still present; whether the claim rotted needs the family read, not a grep

⚠ **Owed: promoting F13 `channel: "CONTEXT"` → `FIN` is deferred, not rejected** — it re-scores the FIN roll-up and the notify band, so it is its own plan. **Seam:** `src/registry.ts`. **Falsifier:** `grep -A3 'export const F13' src/registry.ts` shows `channel: "CONTEXT"` ⇒ still open.

⚠ **Owed: `preview:shot` exits 1 on three /lab-side checks** — board tiles=7 (expect 8), ledger two-pillar idiom cells 0/9, 2 missing detail explainers (`R4`, `price-accel`); none ever triaged. **Seam:** the `/lab` block of `scripts/preview/screenshot.mjs` vs `public/lab.js`. **Falsifier:** `npm run preview:shot` — exits non-zero printing those three lines. · not run (2026-09-13 sweep: manual class excluded)

⚠ **Owed: empty-history proxy-z detail tab returns a raw 500** (`confirmedSeries: empty history` instead of "No history yet"). **Seam:** `proxySeries` (`api/series.ts` → `src/domain-fold.ts`). **Falsifier:** request an F1 detail against a store with no F1 rows. · not run (2026-09-13 sweep: manual class excluded)

⚠ **Owed: claim-verification sweep of the remaining README sections against `src/`** — one section was found two engine changes behind on the notify path; README is PUBLIC. **Seam:** `README.md`. **Falsifier:** grep each README claim's named symbol at its seam. · ambiguous (2026-09-13 sweep): falsifier names no claim/symbol to grep

⚠ **Owed: `f4c_fires.csv` + `breadth_fires.csv` are UNGUARDED and STALE** — `derive.ts` emits committed artifacts with no build step, so refreshing a raw feed without re-running it silently truncates a decision variable. **Seam:** `scripts/backtest/derive.ts` (the old `harness.py` guard is deleted). **Falsifier:** re-run `derive.ts` and `git diff --stat` the two CSVs — churn with a green gate is the defect. · not run (2026-09-13 sweep: manual class excluded)

⚠ **Owed: `mkDial = (regime, fired = true)` defaults opposite to `run-core.ts`'s fail-safe.** Flip to `false` and make the 8 legacy call sites explicit when the helper is next touched. **Seam:** `src/alert-band.test-helpers.ts`. **Falsifier:** the default disagrees with the production default, so a test can pass on a path production never takes.

## 2026-08-09 — harness, drained from auto-memory's NTH sections

⚠ **Owed: vitest collected-count wobble.** One PASSING case appears and disappears across invocations at the SAME commit; likely a wall-clock-relative fixture crossing an age boundary. **Seam:** freeze with `vi.setSystemTime` and pin the fixture. **Falsifier:** run the suite twice at one commit and diff the collected counts. · not run (2026-09-13 sweep: manual class excluded)

## 2026-08-09 — frontend / UX, drained from auto-memory's NTH sections

⚠ `freshnessMissing` is still unread by `famLagMarks` and `feedLagFoot` — both read `d.feedLag`, served `[]` on a degraded read, so the families board and ledger footnote paint "every feed current" (the mirrored A4 defect; the `Lag` legend also never mentions the `—`) · seam: `famLagMarks` + `feedLagFoot` in `public/lab.js`; the structural fix is a "not assessed" value in `MemberObs` (`src/danger-engine.ts`) · falsifier: serve a payload with `freshnessMissing: true` and assert neither surface paints a calm/empty state. ⚠ Undiagnosed: why `freshnessFrom` throws on prod (~27 sequential PostgREST round trips; log retention outran the incident). · not run (2026-09-13 sweep: manual class excluded)

⚠ **Owed: emitted-class-has-no-CSS — three instances, build ONE test.** A `public/*.js` seam emits classes with no rule in `styles.css`/`lab.html` and paints unstyled (overlay-strip `overlay-*` fixed 2026-09-19; band-panel `.bp-*` fixed; scoreboard `.sb-*` latent — the TEST is still owed, and would have caught all three). **Seam:** one repo-wide parity check — static class literals plus dynamic suffixes per seam must each resolve to a selector, with an allowlist. **Falsifier:** the check itself; today nothing fails. · not run (2026-09-13 sweep: manual class excluded)

⚠ **Owed: T6 renders an overlay row on EVERY close.** Emit `—` for a nudged rung and drop the note when `nudge === 0`. **Seam:** the T6 view builder (behaviour, not CSS). **Falsifier:** a T6 close with `nudge === 0` still paints a note. · The CSS half — `overlay-<tone>` and the whole `overlay-*` family unstyled, so `alert`/`caution` painted as `neutral` — SHIPPED 2026-09-19.

⚠ **Owed: the B-22 `/lab` chip leaks its raw internal reason** (`… (was: target rung 3→5 …)`) while the push shows clean copy — strip the `(was: …)` tail. **Seam:** the suppressed-overlay chip in `public/lab.js`. **Falsifier:** render a suppressed v-shape and diff the chip text against the push text. · not run (2026-09-13 sweep: manual class excluded)

⚠ **Owed: R1's `stepsRemaining` understates on an unconfirmed re-risk** — `computeR1(3,6,0)` → 3 while arrival takes 4; `api/lab.ts`'s hold headline also hardcodes "re-risk to N pending". **Seam:** `computeR1` (`src/r1.ts`) + the hold headline (`api/lab.ts`). **Falsifier:** `computeR1(3,6,0)` returns 3. · not run (2026-09-13 sweep: manual class excluded)

⚠ **Owed: `/lab` live `r4.reason` is `""`** — hardcoded on the live path, renders empty while scenario shows text. **Seam:** `api/lab.ts` — persist it, or a phase→text map at read time. **Falsifier:** `grep -n 'reason: ""' api/lab.ts | grep -v '^[0-9]*: *\*'` non-empty ⇒ open.

⚠ **Owed: `[geo]` ops log overstates a RELEASED declared 4** — prints `+${STAGE_TO_FLAGS[crisisStage]}` after `declaredTerm` went 0. **Seam:** the crisis-stage log line in `src/run-cycle.ts` — print `geoBasis.stage`. **Falsifier:** run with declared 4 + streak ≥ `DE_ESCALATION_DAYS`; log says +1, band says OK. · not run (2026-09-13 sweep: manual class excluded)

⚠ **Owed: geo calm streak counts a stale trigger's carried GREEN as calm** — no lag gate in the streak read. **Seam:** the streak loop in `src/run-core.ts`. **Falsifier:** feed a trigger reading with stale lag + GREEN mid-dwell; streak advances. · not run (2026-09-13 sweep: manual class excluded)

## §OWED[USER] — open decisions only
- **Capped manual block exit?** (stale-review-cap review): a `STALE_REVIEW_CAP`-released `by`-less block (sp500 `private_credit` after 11-26) is due every run with no clearing path — let it clear on sourced-lean / `causeFalse`, or due-every-run only for `spares` releases? seam: `resolveBlocks` `!rel` gates · `isReleased` due gate (`ladder-run.ts`)

- **Last-guards widen?** (last-guards review): add `email`/`treasury`/`indicator-feed`/`feed-http`/`db-fetch`/`official-legs` to G3's `IO_SHELL`; add a parse-diagnostics syntax gate for `public/*.js` to `npm run check`.
- **guard-ask: re-ask on non-WRITER Bash writes to gate paths?** `chmod -x`, `python3 -c`/`node -e`, `perl -pi`, `install`, `git stash push -- .claude/hooks/…` edit a live hook unasked (G1 sees it only at commit). seam: `liveCmds` (`.claude/hooks/guard-ask.mjs`)
- **Superseded text: keep or delete?** `claim-verification.md` §20/§50/§11 say keep the pre-verdict text marked superseded; `~/.claude/rules/prose-budget.md` + `doc-writing.md` say delete it (`git show` keeps it). Rule which wins, then rewrite the losers.
- **`graftQuoteLevel` (pure, no IO) is a `FeedPorts` port**, against the X4b "never port non-feed logic" ruling: delete the intraday BUND "two sessions past the bars" test (prod can't build that world), re-drive it on a calendar-coverage-gap year, or keep the port? The GILT "throwing estimate path" test also uses it. seam: `FeedPorts` (`src/feed-ports.ts`)

- **Blockers shows a HELD tranche as filled with nothing blocking it** (semis T2 is `HELD until 29 Oct` by deciding events, yet `docs/semis.md` / `/lab` Blockers print `**T2** ✓ …` alone): `filled` is the probe's close `ok`; fold the event-hold + sign-veto predicate (`afterHolds`, `src/ladder-run.ts`) into `blockers` (public/ladder-views.js, takes `events`/`signs`/`blockReach`) and print ` · HELD …` on the head line, or leave Blockers to the close verdict as ruled? seam: `blockers` · falsifier: `npx tsx -e` rendering semis T2 after the port.
- **Trend-gate ramp reach** (`trendGateFactor`): a RED `uT` now reads a leg RED from C=J EW ≥ 0.138 with ONE family lit (Semis rt-only 0.21 → 0.60) — keep the ramp, or step gate on the C=J pillars? falsifier: `npm run probe:leg-ordering -- --env=prod --arm=diff` across dates (prod read needs a user run/permission).

- **⌁ cannot-arm counts unweighted off-band members** (e.g. rates `R8` while R1 speaks) under "deepens the dial" — gate `cannotArmMark` on the dial `legP` predicate too? seam: `cannotArmMark` (`src/families.ts`).
- **Rename leg id `EU-Fin` → `EU-HiDiv`?** the fund is 60% fins (labels flipped 2026-09-20); an id rename is a persisted-key migration — seam: the `High-Div` legacy alias in `src/families.ts`.
- **R8's Δ10-of-mean velocity leg is scored but undrawn** — drawing it needs a third axis or displacing the probit; recorded as `chart-lines-explain-ribbon.test.ts`'s accepted blind spot, deliberately NOT allowlisted.
- **Level-1 quasi-max sub-rulings:** bounded (`max + λ(1−max)·mean(rest)`) or clamped, and what λ? λ=0.25 staged hand-set · seam: `observedWeightedMax`, `src/danger-engine.ts`.
- **Ladder push: should unknown → `quiet` (eufin's neutral) also stay silent,** as unknown → neutral does? seam: `leanMoved` (`src/ladder-run.ts`).
- **Banked for a GLOBAL session:** a scanner that records output ONLY on a match cannot distinguish blind from clean — any such gate owes a positive proof-of-reach assertion (instance: nuclei `-include-rr`; seam: `scripts/probe-dast.sh` guard C).
- ⛔ **One item is SIBLING-SESSION-OWNED — do not re-ask:** the `R4_EXIT_HY` level pick.
- Should `pillarsLive` (`src/t1dial.ts`) count a **carried-only** family as live? Today it does, so R4's cash-breaker EXIT leg can clear on zero genuinely-present members — the starved-read case it exists to catch. A ruling that needs code owes a new `docs/plans/` doc.
- **Trading rules slice 2 — revise + retire UI?** Slice 1 ships list+add only, so every save mints a
  fresh `rule_key` and a typo is permanent · seam: `saveRule()`, `public/journal.js` · without it the
  archived spec's manual-verify items 3 and 4 are unperformable.
- ⚠ **S5 — the other four hover surfaces** (`replay-chart.js:309`, `exposure-replay-chart.js:334`, `lab.js`'s two painters) still use the corner-pinned `hover-read`; decide per surface whether each inherits the chip · falsifier: `grep -n 'hover-read' public/*.js`.

- **Move the cron region `iad1` → `arn1` (next to Supabase eu-north-1)?** First cold prod scoring cron trigger (2026-10-19): `[db] busy=15.3s` of a ~35 s run, 362 calls, slowest 1.3 s · seam: `vercel.json` `regions`.
- **Delete orphan prod rows?** `XDEV_GATE` `readings` ×11, the old `EXSH_RS`/`EXSH_TREND` rows, the `EUNH.DE` input rows.
- **Confirm the EU-Fin gate-row ruling:** the episode-gate row holds own-leg fills while the escalation box trips · seam: `scripts/probe-eufin-tranches.ts`.
- **Re-eye hand-set cuts off `/lab` detail:** INS_RS (KBE_RS's −0.03/−0.06) · BUND 0.35/−0.03 · BONOS levels · MU_RS/JPT (unblocks D2) — keep, or hand-edit.
- **CH tick lane?** the wide CH frame's worst-case y-tick label can occlude ~2 px of the stripe — model a CH tick lane, or accept.
- **eufin `brief.primaryTier` agency hosts** (`moodys.com` · `spglobal.com` · `fitchratings.com`) — confirm the set · seam: `public/eufin.json` `brief.primaryTier`.
- **OBDC escalationIf `non-accruals up q/q` fired on a 2.8→2.9 % at-cost tick (11-04)**; [USER] 11-05: re-landed `mixed:` — next `/sp500` owes `private_credit` `block: false`; add a size threshold?

## Plan-doc menu — armable work, one pointer per doc

- **Cloud sessions see auto-memory** — PARKED; re-enable steps in its `## Next action` when cloud needs memory.
- **AI-debt sweep** — resume Stage 7 (Stage 12 cites drifted — re-grep); Stages 2–14 review deferred to its Stage 15 (the sweep's own commit range).

- **Intraday estimate kept past EOD, labelled** — SHIPPED 2026-11-05; `/lab` tooltip `ESTIMATED · INTRADAY` eyeball owed.
- **US legs top-10 → impact order** — SHIPPED 2026-09-30; `make ship` + `/lab` eyeball owed.
- **Intraday C5 proxies** → R2–R4 closed (Treasury head); BUND moved to the DE10Y quote leg.

_2026-09-20: every older entry is archived._

- **Backlog falsifier sweep** — SHIPPED 2026-09-13: 111 items swept, 6 closed, 28 fired, 77 tagged.

- **Detail-chart window chips** — SHIPPED 2026-09-13 (global 3m/6m/1y/all row atop zone D, tap-pins touch readout, margins clamp to edge samples, compact phone readout bar); deploy owed.
- **Indicator-detail copy redesign** — SHIPPED 2026-09-12 (slices 1–3); deploy owed.
- **DISP severity redesign** — CLOSED 2026-09-09 (slice 1 + slice-2 Stage 1 shipped; Stage 3 DROPPED).
- Journal drawdown **chart** of the chained book (segment boundaries at each entry date, `.pension-*` shading, reuse `public/sparkline.js` path helpers) — deferred out of the plan 2026-09-07; revisit only after J1+J2 have been eyeballed.
- **CG db-first warmup persist** — SHIPPED 2026-09-05; `make ship` + two-cron probe confirm owed (§OWED[USER]).

⚠ `docs/2026-08-29-sp500-and-sp-it-top5-timing-research.md:45` quotes `MEMBER_WEIGHT["S&P IT"].F5` as 0.8, superseded (live 0.4) — the S&P IT redesign that consumes it owes the correction · falsifier: `grep -n 'F5' docs/2026-08-29-sp500-and-sp-it-top5-timing-research.md` shows 0.8 against the live row.


⚠ F9 RED on prod board (lab reads the cron-run vintage) while restated rows score the SAME closes GREEN · seam: run-cycle F9 live fetch on Vercel vs host · falsifier: re-probe AFTER the 2026-08-11 retunes ship + `--restate=F9`; if still divergent, `vercel logs --follow` during the prod scoring cron trigger, grep `[F9]` warn lines.

## Value leg — D2 seat edit, gated on U2 cuts

- ⚠ Once `MU_RS` + `JPT` carry hand-set cuts (`## MU_RS`/`## JPT` in `docs/indicator-cut-provenance.md`): `LEG_TOP.Value` → `F8 · MU_RS · HCX · RS_SMH · F17 · JPT · KBE_RS · R7 · F1 · CG` + `leg-desc.js` Value prose · seam: `public/leg-top.js` · falsifier: `grep -c 'MU_RS' public/leg-top.js`.

## 2026-08-30 — R1 drawdown-leg arc, surviving half

⚠ The api-handler half of `withPostInversionCut`'s rung-independence guard has no test — the handler resolves indicators from the registry by id, so a rung-less carrier cannot be injected through `GET` without a registry fake (the chart-spec half IS pinned in `src/chart-rail.test.ts`) · seam: `api/series.ts` handler. · falsifier: none stated (2026-09-13 sweep)

⚠ Any future R1 recompute must pass `shortLeg` — `indicatorReadingSeries(r1, obs)` without it leaves `steepenerEscalationSeries` all-false (gate off, no RED), which manufactured the refuted "2026-01 recomputes 0 RED" artefact · seam: every R1 recompute call site · falsifier: recompute a known-escalated date with and without `shortLeg` — states must differ. · not run (2026-09-13 sweep: manual class excluded)

## 2026-08-31 — owed from the shipped R6 N1 arc

⚠ `probe:r6-restate-delta` has rotted — it throws `[R6] level-leg percentile cut is not finite` in `beforeRibbon` (the series head sits inside `levelBandHead`); its question is already answered (2026-10-10 `probe-feed-diff.ts indicators`: 0 R6 flips) · seam: `scripts/probe-r6-restate-delta.ts:88` vs `percentileLevelState`'s finite-cut guard · falsifier: `npm run -s probe:r6-restate-delta` exits 0 — fix or delete the probe.

- **N2 / N3 candidate methods are UNRULED, [USER]-owned** — N2 a dwell gate on the absolute pair, N3 a MOVE/VIX ratio band (`npm run probe:move-vix` exists) · falsifier: none stated (2026-09-13 sweep)

## 2026-08-31 — owed from the shipped DB-first cron arc

⚠ R7's R1 leg issues one extra `fetchSeries("T10Y3M", { fullHistory: true })` per run on the tail arm (memoized, degrade-safe, no scoring effect — wire cost only); closing it means threading the loop's merged points across the confirmer boundary or routing R7 through DB-first · seam: `r7LegSeries`/`r7LegLoopDeep` (`confirmers.ts`), `CORE_LOOP_DB_FIRST` (`run-cycle.ts`) · falsifier: count `fetchSeries` calls for `T10Y3M` in a tail-arm run — currently 2, should be 1. · not run (2026-09-13 sweep: manual class excluded)

⚠ The breadth SPY series silently depends on the pension writer storing ADJUSTED closes under the `SPY` id — same feed today, nothing pins it · seam: `BREADTH_READ_ONLY` (`registry-price.ts`) vs the `pension_holdings.ts` SPY row · falsifier: assert the two paths' feed-option shapes agree — no such assertion exists. · not run (2026-09-13 sweep: manual class excluded)

⚠ §2's exit-1 vintage falsifier stays report-only by [USER] ruling (always exit 0 — it ESTABLISHES NOTHING); re-offer the exit-1 form before anyone calls §2 falsified · seam: the composite block of the vintage-consistency probe. · falsifier: none stated (2026-09-13 sweep)
- **Semis `capex_guides` veto: expire, or yield to price?** It is T1's last open gate since the HY easing OR (2026-11-13) · seam: `VETO_ROWS` (`scripts/probe-semis-tranches.ts`).
