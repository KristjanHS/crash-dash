# Indicator cut provenance

Evacuated per-indicator cut rationale and measurement records from `src/registry.ts`. **`src/registry.ts`
is the live source of the cut VALUES** — nothing here is load-bearing at runtime, and no number written
below is a source for anything. This is the audit trail (why a pair was retuned, what was measured, what
was retired) that used to sit inline and billed every reader of the registry.

Organised **by indicator id**. Each vacated seam in `src/registry.ts` carries a one-line pointer to its
section here.

---

## Read/write protocol

**READ, before moving a cut — section-scoped, never the whole file.** Read this section and the header
above it (nothing below is a source for any number), then `grep -n '^## '` this file for the indicator id
and read THAT SECTION ONLY.

**WRITE.** The retune itself goes into `src/registry.ts` — it is the only source of any cut value. Into
this doc goes ONLY the line that binds the next edit, **deleting the one it supersedes**; the rationale and
the measurements go in the commit message (`.claude/rules/doc-writing.md`).

---

## F2 — IG OAS

The VELOCITY pair was retuned 2026-07-28 (`[USER]`); the LEVEL pair was retuned then and again
2026-09-01 (`[USER]`, hand-set off the Indicator Detail chart). The retired set was the v4 §4 textbook stress
band — re-affirmed by the C4 pass 2026-07-15 as "150 bps elevated / 200 crisis-onset" —
which sits above the post-2023 IG-OAS range, so BOTH legs were dark. The live pair below
is inside that range and makes the axis crossable. C4's complacency (low-side) read is
still not expressible in the high-side schema.

## F3 — NFCI Risk (the 157-Wednesday lag derivation)

Measured over 157 consecutive release Wednesdays (2023-08 → 2026-07) of real
ALFRED vintages — `npm run probe:nfci-grid`, which re-derives this number from the live
calendar: 135 on the T+5 grid, 22 slipped to THURSDAY (T+6), every one of them the week
after a Monday US holiday, and not one ever later than Thursday. So 11 would false-flag F3
on ~7 weeks a year and 12 is the structural maximum, matching the F9/F11/FXH H.10 precedent
below. Against
the cadence tier's 9, the cycle above reads as lagging on ages 10–11 — 2 of the 7 days a normal week's row is
newest — and on 10–12, 3 of 8, in a slipped week: blended over the same 157 Wednesdays,
(135·2 + 22·3) / (135·7 + 22·8) = 336/1121 ≈ **30% of all days**, with the feed healthy.

## F6 — SMH/SPY vs MA200 (2026-09-02)

RED iff SMH/SPY < its own trailing MA200, no AMBER — `F6_DESCRIPTOR` (`src/family-descriptor-rows.ts`;
`maWindow: PRICE_WINDOWS.ma`, `amber: null`, `red: 0`) is the only source; multiplier flat 1.0 — and F6 is OUT of `REACHABLE_IDS` (2026-09-05): amber null + red 0 make any override a no-op, so a non-1.0 `threshold-config.json` F6 entry throws in `validateMultiplierConfig`.
Sector risk flag, NOT a timer — post-2016: RED 25.4% of days, P(XLK −10% in 63d) 16.3% vs 7.2% base,
but P(SPY −10%) only 7.4% vs 5.9%, mean fwd-63d SPY +1.8%; never read a RED as a broad-market call.
Measured 2026-09-02 (offline measurement): the E4 monthly ribbon holds a forward −10% coverage edge
over the retired 252d-return
rule; a re-measurement that loses it reopens the cut.

## R4 — 10y TIPS Δ

Retuned 2026-07-23 from +0.30/+0.50 ([USER] decision). These convention bounds now sit
BELOW every measured leg (EVT 0.3654/0.623; regime-z 1.5σ/2.0σ ⇒ 0.3269/0.4359 in Δ20
units off the published `dfii10` zref), so the convention leg is the binding one at both
severities. Fire rate over DFII10
2003→2026: amber 7.9% → 16.8% of days, red 3.2% → 10.6%.

## R1 — 10y−3m on a 21/63-obs mean

Scored on MEANS, never daily closes ([USER] 2026-08-31,
measured by `npm run probe:r1-lit`): RED = 63-obs mean < 0 (Harvey quarterly), AMBER = 21-obs mean < 0
(Estrella–Trubin monthly) OR the armed rung below run on the 21-obs mean. The windows are literature-fixed on
`SMOOTHED_LEVEL_OF.R1` — ⛔ never retune by sweep. ⛔ No fixed `amberLevel`, no drawdown leg, no bull-steepener
escalation on R1 (`T10Y3M_DRAWDOWN` stays as un-wired code; re-wire = re-add `drawdownLeg` + delete the
`SMOOTHED_LEVEL_OF` entry + restate).

`qualifyN` is HAND-SET ([USER] 2026-08-12), accepted cost: an inversion running fewer than `qualifyN`
consecutive closes never arms — sweep a retune with `npm run probe:post-inversion -- --qualify=N`
(N≥42 loses the 1989→1990-91 episode; N≥63 also 2019→2020).

Armed cut = expanding percentile (knobs on `T10Y3M_POST_INVERSION`, ruled 2026-08-12);
`floorLevel` stays HAND-SET as warm-up hold +
release threshold. `cutPctile` retuned 0.40→0.37 ([USER] 2026-08-13, "cut ≈0.70 today"); the [USER]-pinned
chart dates (2026-05-15/2026-07-31/2026-08-05 GREEN, 2026-06-29 AMBER, +2026-03-16/2026-04-15 AMBER on the mean) bind it — `src/registry.test.ts` pins them.
⛔ Never reintroduce a time expiry — release is by LEVEL only
(`releaseN` closes ≥ `floorLevel`): the retired 252-obs clock released GREEN into the 2001/2007/2020
recession starts.

## R8 — near-term forward spread (NTFS) on a 21-obs mean

Series = NTFS ([USER] 2026-08-13): exact
GSW construction ONLY (`src/gsw.ts` — feds200628 Svensson params → 1.5y→1.75y fwd, minus FRED DGS3MO,
inner-joined), fail LOUD, no runtime fallback.
Banked future option (same plan §Stage B): FRED-only `fwd ≈ −1.25·THREEFY1 + 2.25·THREEFY2`
(+0.15–0.3 pp level bias vs exact).

Level cuts = armed expanding percentiles of the anchored (≥2006-01-01) pool of 21-obs means — knobs on
`R8_MEAN_POST_INVERSION` (`src/registry.ts`), HAND-SET off /lab ([USER] 2026-08-13); pctiles carried
over from the t10y3m pool (derivation in an earlier commit message, no shipped derive script), the CLAMPS
retuned to NTFS levels ([USER] 2026-08-13) after the t10y3m-vintage pair pinned both lines flat.

The velocity pair is Δ10-tail-derived from the committed t10y3m history (same commit's record), carried
over UNCHANGED onto NTFS (same ruling); the probit
axis is DISPLAY-ONLY (2026-08-09 ruling) — `public/probit.test.js` reds on a reintroduced level pair.

## F9 — Broad USD (the retired LEVEL axis)

**The LEVEL axis is retired, not retuned, and is not to be re-opened** — D3 put the level mask's base rate
at 54.7% (vs 18.5% on velocity) with every "detection" saturated at the `LOOKBACK_PRE_PEAK` ceiling.
**Leg shape is `vel-z OR vel-cusum`** (Shewhart–CUSUM, Lucas 1982); ANDing them, or retiring the CUSUM leg
(offered three times, DECLINED), is not to be re-opened.

**The CUSUM leg is two-tier and the restart is at the ACTION limit — FIR, to `h_red/2`** (2026-08-11
`[USER]`). `F9_CUSUM_H` = warning limit (AMBER, fire test only); `F9_CUSUM_H_RED` = action limit (RED, where
the recurrence restarts). Three mechanisms bind an edit:
- No on-alarm reset → the accumulator ratchets and never clears (confirmed defect).
- Reset at the WARNING limit → RED unreachable except by one outsized step.
- ⛔ `F9_CUSUM_H` is NOT the accumulation lever (absent from the recurrence) — **do not re-offer "just lower
  the amber threshold"**; `k` is the lever. `cusumHRed` DOES feed the recurrence, so moving it moves S⁺.

**`F9_CUSUM_K` = the stored-era in-control offset (median row below) + a 0.25σ sensitivity allowance**
(2026-08-11 `[USER]`). ⛔ A `k` BELOW the median was offered and REJECTED (re-arms the ratchet).
In-control offset estimators — stored era, n = 2,866 usable-z days, 2015-03-18 … 2026-08-10
(`scripts/probe-sigma-cusum-candidacy.ts --id=F9`; ⚠ CONDITIONAL on `F9_SIGMA_WINDOW` — a window move
re-runs this probe before the k split is restated):

| estimator | offset | note |
|---|---|---|
| full-sample mean | 0.2114 | contaminated — inflated by the episodes the leg exists to catch |
| median | 0.3037 | symmetric, robust to the episode tail — **the shipped offset** |
| 10% trimmed mean | 0.2210 | symmetric |
| 20% trimmed mean | 0.2466 | symmetric |
| one-sided in-control | 0.0227 | ⛔ NOT comparable — biased LOW as a location estimate |

⛔ **No `h` sweep is owed; the empirical-`h` calibration stays DECLINED** (the ARL target assumes i.i.d.
input; z is ~98% autocorrelated).
⛔ **THE Δ60d σ PAIR SHIPPED UNMEASURED, BY RULING** (2026-08-09, `[USER]`) — no day-share, fire rate or
episode count exists at the live pair, measuring one is **NOT OWED** — do not stage a probe or a `--restate`
for it, and do not carry Round 5's owed-measurement debt forward — and no `vel-z`/`vel-cusum` figure
anywhere in the tree describes the live population.

Every cut here is hand-set off the detail chart (`docs/reference.md` §[arch] 4); `src/registry.ts` is the
only source of every live value.

## F10 — EM OAS

Stage 6.3 briefly put F10 on the runtime empirical-CDF seam (`synthPriors`), which
computed 2.38/2.64 — an ESCALATION on a phone-firing input. FEED-TRUNCATION
CONSTRAINT: keyless FRED serves ICE BofA OAS (`BAMLEMCBPIOAS`) over a rolling ~3-year
window — 796 rows from 2023-07-18, where
non-ICE `DTWEXBGS` (5356) / `DEXCHUS` (11877) come back in full — and `npm run
backfill -- indicators --dry-run` adds 1 row, so the store is already at the feed's
full depth: **not fixable by backfilling.** A percentile over that window is fitted
to one benign credit regime containing no event, and `PCT_MIN_OBS = 252` cannot
catch it (a depth floor never certifies the window spans the tail it claims to
locate).

## F11 — CNY spot (the retired LEVEL axis)

RETIRED OUTRIGHT 2026-08-08: `DEXCHUS` is a
MANAGED float, so an absolute level cut reads the PEG REGIME, not danger — not to be re-opened with a
better number. The other half of the kill switch is `CALIB_MAP.F11` (`domain-cuts.ts`); F11 left
`DUAL_AXIS_IDS` and the `drift-guard` population — both pinned in `src/registry.test.ts` §"F11
velocity-only (level axis retired 2026-08-08)".

RE-HORIZONED 2026-08-08 (§7.2 item 1b): `velocityWindow: 60` TRADING DAYS on the `registry.ts` entry (F9's
quarter horizon; grid = `CNY=X` daily closes). One field moves both the scored `delta20` and the quantity
the cuts are denominated in.

**SIGMA pair HAND-SET 2026-08-16 (`[USER]`), floor still MEASURED 2026-08-10** (`velocitySigma`,
`registry.ts` — the only source of all three). The looser red arm IS the ruling — a σ-arm move no longer
re-owes the fire-rate fit, so never "restore" the retired rate. Sweep before any further move:
`npm run probe:sigma-response -- --id=F11 --csv=scripts/backtest/data/cny.csv --multiples=<a>,<r>`
(`--floor=<f>` sweeps the estimator). The amber multiple is REACHED inside the 3-year drift window, so
`registry.test.ts` §"F11 velocity-only" asserts `MOVES`; raising it above that window's z max flips it to
`PINNED[GREEN]`.

**A retune of the σ pair is an OUTPUT move, never display-only** — measured 2026-08-08 (`npm run
probe:f11-horizon`), the re-horizon moved the HELD sleeve on 33 of the 418 closes where the two arms
differed (~1 in 13). ⚠ That measurement RETRACTS the "absorbed by the family fold" record of `0006101f`
(a one-close verdict at a saturated dial).

ACCEPTED, NOT FIXED — the persisted `delta20` column stays in POINTS, not log/percent; the σ
re-denomination moved the CUT off points, not the column. ⛔ Do not reopen the column as a migration
stage (persisted, charted and restated in level units on prod and dev; ~30% residue post-2005).

## T10YIE — 10y breakeven

Both pairs RULED by the user 2026-07-31 off the re-derived occupancy table
(committed fixture `be_10y.csv`, n=5,898).
LEVEL: the previous red sat one tick UNDER this series' all-time max and cleared on exactly
one day in 5,898 — that day being the max itself, so it marked a record rather than warning
of one — hence the pair was pulled down into a reachable band.
⛔ NEITHER PAIR IS PROVISIONAL — the flag was dropped from both registry entries 2026-08-31 `[USER]`;
the cuts are FINAL and no calibration pass is owed.
VELOCITY leg added 2026-07-31 `[USER]`: a breakeven's de-anchoring read is level AND
direction — "above the anchor and still climbing" — which a level pair alone cannot
express. Δ over the default VELOCITY_WINDOW, drawn on the dual-axis storedDelta route
(`family-descriptor-rows.ts` CHART_PARAMS_OF). Amber is set clear of this series' Δ20d p90,
which the shipped prior sat BELOW (it fired on >12% of days into the `rates` worst-of
roll-up); red clears both breakevens' p97.

## T5YIFR — 5y5y forward

LEVEL pair is the playbook's de-anchoring line (red) and its Stage-4 "re-anchored below"
unwind rule (amber) — REVIEWED and deliberately KEPT by the user 2026-07-31, RE-AFFIRMED `[USER]`
2026-08-31. Anchoring on the playbook rather than this series' own distribution is why the pair reads
LOWER than T10YIE's while the series runs HIGHER, and why it sits amber-or-worse on ~a third of days.
⛔ THE BIND: a percentile-asymmetry argument is NOT grounds for a retune (the alternative was put to the
user 2026-08-31 and REJECTED) — overturning needs a new playbook read, not a new quantile table.

## F5 — QQQ/QQQE equal-weight breadth (2026-08-29)

The cut is a DYNAMIC ROLLING percentile of the strict-prior distance-from-high, hand-set as F5's OWN
`BREADTH_BAND` triple in `src/family-descriptor-rows.ts` — the only source; SPCONC split off to `SPCONC_BAND`
2026-08-30 (`[USER]`) and holds the older rolling-126 p85/p98 pair as a control, so never re-merge them;
`POINT_BAND_CUTS_OF` references them, so the drawn band follows a retune with no second edit.
⚠ Binds the next edit: window and pair move TOGETHER — a shorter window has fatter local tails, so
shortening it without lifting the pair raises the fire rate. Both the scorer and the drawn cut go
through the ONE `breadthCutSeries`; never call a percentile helper directly for these ids.
⛔ This OVERTURNS an earlier "no scalable cut" ruling and the 2026-07-26
"not to be retuned" feedback; the pointer is in `docs/backlog.md`.
**Forward-reach verdict (2026-08-30): PLACEBO-FAIL — measured, not asserted.** `npm run probe:event-study
-- --probe=f5` (spec `breadthConcentration`) on the pre-registered `RED × S&P IT` cell over the QQQE
fixture window (2012-03-21 forward): 101 RED episodes — well over `MIN_EPISODES`, so this is a
POWERED null and not a THIN — excess **+0.60pp @20d, +0.49pp @60d**, both under their placebo arms.
⚠ Re-measured on the rolling-63 band the same day; the pre-retune triple read 74 episodes / +0.34 /
−0.56 and failed on the sign-flip branch instead. The VERDICT is unchanged, the branch is not.
AMBER is the same shape. All nine legs failed. SPCONC inherits NOTHING from it since the 2026-08-30
split — its own band is unmeasured offline (`rsp.csv` does not exist).
⚠ Binds the next edit: this bears on F5's **reach**, not on its cut. It is not grounds to move the
`BREADTH_*` triple — the band itself is behaving (a 16-day RED ending at the 2026-05-15 concentration
peak). The pre-registration's consumer is `indicator-loop.md` §Keep-or-cut — an indicator earns its place, i.e. whether F5 keeps its
dial/trend seat at all; that ruling is `[USER]`-owed and NOT taken (`docs/backlog.md`).
⚠ Binds the next edit: do not re-run this hoping for a different verdict. The pre-registration fixes horizons at 20/60 and forbids sweeping;
the run is spent and pinned in `scripts/backtest/event-study.test.ts`.

⚠ Binds the next edit: the band needs `BREADTH_MIN_CLOSES` aligned closes, and the feed depth
(`BREADTH_LOOKBACK_DAYS`, `registry-price.ts`) is DERIVED from it — raising HIGH_WINDOW,
BREADTH_CUT_WINDOW or CONFIRM_CLOSES must not be split across commits.

## HCX — hyperscaler-capex basket ÷ SPY (2026-08-29)

Hand-set by the user off a percentile grid measured on the ratio, as the pair `(amberP, redP)` on `HCX_BAND`
(`src/family-descriptor-rows.ts`) — the only source; the drawn band reads the same two percentiles, so a
retune follows with no second edit.
⚠ Binds the next edit: judge a candidate on the SEPARATION between the two DRAWN cuts, not on fire
rate. This leg's lower tail is steep, so tightening the percentiles collapses amber and red into one
visually indistinguishable band — the ruled pair is the loosest of the measured grid for that reason,
and long red runs are an accepted consequence, not a defect to tune away.
⚠ Binds the next edit: HCX is CHART-ONLY. If it is ever seated (`channel` → `GLOBAL`), the pair was
never chosen against a false-alarm cost and must be re-ruled before it can move the notify band.

## FDX — TSM ÷ SMH foundry dependency (2026-08-29)

Hand-set by the user off a percentile grid measured on the ratio, as the four fractions on
`FDX_DESCRIPTOR.scorer.constants` (`src/family-descriptor-rows.ts`) — the only source.
⛔ Binds the next edit: never put the ms50 amber ON the MA50 crossing (`0`). The measured median day
sits above its own MA50, so a crossing-as-amber cut lights amber on ~half of all days by
construction. That was the shipped prior and it is what this ruling corrected.
⚠ Binds the next edit: never port a fraction across from F13. HYG/LQD is a credit-ETF ratio and
travels an order of magnitude less per day than this relative EQUITY ratio; a cut here is only
interpretable against this ratio's OWN percentiles.
⚠ Binds the next edit: FDX is CHART-ONLY and FAILED its frozen direction gate
(`npm run probe:fdx-direction`), so the d20 leg was ruled responsive on the ground that a fire costs
pixels. A seat would invalidate that ground and both legs must be re-ruled first.

## SPCONC — S&P 500 concentration (SPY/RSP)

Same dynamic rolling-percentile shape and the same cut triple as F5 (2026-08-29) — the AT-HIGH
finding below is now the INPUT VARIABLE, not the classify rule.

The AT-HIGH shape was chosen over a 20d-ROC velocity variable after measuring both on
SPY/RSP adjusted closes 2012-03→2026-07 (3,610 days) against forward XLK return:
at-high = +3.60% fwd-60d vs +5.03% unconditional and survives a label-rotation placebo;
ROC ≥ +2%/20d = +6.29% (POSITIVELY associated with forward tech returns — wrong sign)
and fails the placebo.

## F13 — HYG/LQD credit appetite

The lead is MEASURED, not a prior (median +3 td vs BAA10Y's Δ30d leg,
placebo-cleared); a duration-matched HYG/IEF pair LOST head-to-head — USER RULED keep this form 2026-07-23.

**Two-leg rule (2026-08-08, `38f077aa`)** on `F13_DESCRIPTOR` (`src/family-descriptor-rows.ts`): a **d20**
velocity leg (`retWindow`-obs ratio return) with its own amber/red pair, joined to the **ms50** position leg
(%-spread vs its own MA) by `AMBER = d20 tripped OR ms50 tripped`, `RED = d20 tripped AND ms50 tripped`.
Values live ONLY in `F13_DESCRIPTOR.scorer.constants` — do not restate them here.
No peer-reviewed study scores HYG/LQD as a leading equity
signal; the repo's own lead measurement, on the shipped ms50 transform, outranks
the practitioner z-score recipes — so the incumbent kept its leg and d20 was added alongside, not swapped in.

**Cut path.** Every live cut on both legs is HAND-SET off the Indicator Detail two-leg chart, STARTING
PRIORS, uncalibrated, no bake-off probe run on any of them. Last moved 2026-09-01 (`d20Amber` and the ms50
`red`). The ms50 `amber` is still the shipped negative zero — the user DECLINED loosening it (§5.3). The
OR admits every ms50-tripped day as at least AMBER, so F13's non-GREEN share is floored at ms50's own trip
rate for as long as that cut sits at −0 (the 2026-08-08 OR demoted former Reds to Amber; severity moved, not
frequency). **The "Amber half the time" defect cannot be fixed without moving that cut.** No live duty-cycle
figure exists: every one ever quoted was measured on the 2026-08-08 pair.

## EBP — excess bond premium

The 2026-07-29 pair
(amber −0.21 / red −0.0104, retired) was measured by review at ≈30th pct amber / ≈53rd pct red
over 642 monthly obs — 36 of the last 60 months cleared amber — i.e. it was too TIGHT to act as
a crisis-only confirmer, and the retune of 2026-07-31 (`[USER]`) loosened both legs deliberately.

## R6 — MOVE bond-market vol

Scored by `scoreMoveLevel` (`scorers-composite.ts`), not `scoreIndicator`: **two** OR'd legs — the velocity
leg and the registry absolute pair. There is **no percentile LEVEL leg and no `R6_DESCRIPTOR.levelBand`**.

⛔ **Two percentile level legs have been deleted here. Do not ship a third without measuring it first.**
- **L1** (detrended rolling percentile of the deviation from MOVE's own 200d trend) — DELETED 2026-08-31
  (`[USER]`): inverted for a regime
  gauge (a MOVE pinned flat at 150 scores GREEN).
- **N1** (rolling percentile of the RAW level, 252d, p75/p90) — DELETED 2026-09-02 (`[USER]`):
  its solo RED calls all landed BELOW
  R6's own absolute amber cut. ⚠ Binds the next such call: that is a FALSIFICATION, not a "stated cost" —
  the ruling owed is deletion, not a caveat paragraph. Widening the window was rejected too (it rots again
  after three quiet years); the only durable shapes for a third leg are an absolute floor AND-gated under
  the percentile, or none — and the floor alone IS the leg (`[USER]` ruling, option D).
- The `"rolling-percentile"` band KIND survives MEMBERLESS in `family-descriptor-rows.ts` / `scorers-composite.ts`,
  kept deliberately (`[USER]`) for a future id whose series has **no published absolute scale**; deleting
  the machinery is a separate ruling.

The absolute pair is hand-set on the published MOVE regime map (amber on normal/stress, red on
stress/crisis, [USER] 2026-08-30). Do not re-derive it from a sweep: the 2026-07-31 [USER] ruling DECLINED
the validated 92/95 winner and stands (`docs/reference.md` §[arch] 4). `CALIB_MAP.R6` is DELETED — do not
re-add it. The velocity constants (`R6_DESCRIPTOR.scorer.constants`) are ACCEPTED unmeasured ([USER] 2026-08-30); a probe is not owed,
but they are now R6's ONLY dynamic read.

⚠ `R6_MOVE_LOOKBACK_DAYS` is HELD at 900 (deep-only; `moveLegBase()` = 255 is the only warm-up left). Do NOT
re-cut the ask toward that floor: the extra depth is what lets a future band be MEASURED before it ships.
Pinned in `confirmers.test.ts`; `prices.ts` throws on the bad pairing.

The detail chart draws BOTH surviving legs (`buildMoveChart`); its toggled `MOVE_MEDIAN` line is display-only, never a third leg. R6 emits NO `bandCuts` and no
`POINT_BAND_CUTS_OF` row; it stays EXCLUDED from `api/series.ts`'s `supportsRecompute` via
`COMPOSITE_RESTATE_OF`, not the level-band map. ⚠ Binds the next edit: the read-path per-point branch is
entered for `COMPOSITE_RESTATE_OF` membership as well as for `bandCuts` — gating it on `bandCuts` alone
silently drops R6 back to the stored vintage.

## BUND — Bund curve 10y−2y

Source: the `DE10Y` − `DE2Y` daily quote legs (2026-10-02); the level cuts carry the quote-leg−Bundesbank offset — re-eye
them post-ship off the chart, then `[USER]` sets them.
`BUND_DESCRIPTOR.scorer.constants` (velocity + escalation) are `[USER]` hand-set 2026-09-29 off the S1 probe
— re-run `npm run probe:bund-velocity` before any retune; `[USER]` sets the values off the chart.

## ECY — excess CAPE yield × GT trend gate

Cut PROVISIONAL (`expensiveP` rank cut, 2026-08-11 unmeasured; `[USER]` hand-tunes off the detail viz)
and live on `ECY_DESCRIPTOR` in `src/family-descriptor-rows.ts` — the one edit place; for THIS id the
registry pair is not the live cut. The scored/persisted value is the expanding percentile RANK
(strict-prefix, floor `PCT_MIN_OBS` prior joined months); under the floor or past `maxStaleDays` the
read is no-data/DEGRADED, never GREEN. F7/CAPE's card bands are the same expanding percentile
(`CHART_PARAMS_OF.F7` `p` entries) — display-only, F7 stays unscored.
Deviation: ECY here = 1/CAPE − DFII10/100 — the daily TIPS real yield (DFII10) stands in for Shiller's
published GS10 − trailing-CPI form.

## AT1 — bank sub-credit proxy (XAT1.DE ÷ EXHA.DE vs MA50)

**Hand-set 2026-09-24 (`[USER]`, btp-bund S4)** — one `scoreRelStrengthBreak` row: the cut pair is the literal on
`AT1_DESCRIPTOR` (`family-descriptor-rows.ts`, fed through `RS_CUT_OVERRIDES`) — its OWN row, never an alias of
`KBE_RS_DESCRIPTOR` or the RS default, so either retunes alone. A retune edits that ONE literal and re-measures
its firing share + RED episodes; AT1 is SEATED on EU-Fin `cr` (member-weight provenance §AT1).
⚠ Re-cut [USER] 2026-09-26 (eufin-overlap R10): a seated member's RED must isolate bank-capital episodes (2023-03..05, 2020-03), not 2022 rate drift; prod owes `--restate=AT1` after the next ship.
⚠ Re-cut [USER] 2026-09-29 (AT1 scorer review, re-cut again same day) — LOOSENED, superseding R10's bank-capital-only RED.
⚠ Denominator → EXHA.DE (Bund ETF) [USER] 2026-10-11: 09-29 pair KEPT on XAT1/EXHA [USER] 2026-10-11; prod owes a re-score of `AT1` after the next ship.

## CCC — ICE BofA CCC & lower US HY OAS

Live move: the cuts are the literal on the `CCC` row (`src/registry-fred.ts`), provisional [USER] 2026-10-20 — set at F1's own 3y-percentile cuts, Red = both legs like F1 (`FOLD_POLICY.CCC`); a retune edits that literal, then the prod re-score of `CCC`.
Falsifier: `npx vitest run --silent=true src/dashboard.score-indicator.test.ts` (the CCC describe pins the row's states).

## BONOS — Spanish−German 10y sovereign spread

Spain's OWN pair on `BONOS.thresholds` (`registry-composite.ts`, the ONE source; hand-set [USER] 2026-09-24, the Q5 reference retired) — never re-point it at another id's thresholds object. Falsifier: `npx vitest run --silent=true src/bonos-spread.test.ts`.

## MU_RS — MU/SMH vs MA50 (2026-09-29)

Cuts borrowed from the `rsCuts` default (moves with `RS_SMH_DESCRIPTOR`); a [USER] hand-set adds an
`RS_CUT_OVERRIDES` row, then the prod re-score of `MU_RS`.

## JPT — Japan equity trend, 1306.T vs MA200 (2026-09-29)

Cuts borrowed by reference from `GT_AMBER`/`GT_RED` (a GT retune moves JPT); a [USER] hand-set gives JPT its
own constants, then the prod re-score of `JPT`.

## EXSH_GATE — EU-Fin 3-check re-entry gate, EXSH.DE vs MA50/MA200 + EXSH.DE/EXSA.DE vs MA50 (2026-10-06)

Rule B ruled `[USER]` 2026-10-06 (replaces EXSH_TREND +
EXSH_RS): RED iff the close ≤ its MA200; else AMBER iff the close ≤ its MA50 or EXSH/EXSA ≤ its MA50; else
GREEN. All three are pure crosses — no cushion band; cuts + windows live ONLY on `EXSH_GATE_DESCRIPTOR`.
Baseline a retune must beat (10y, rawState): G 38% / A 37% / R 25%, ~22 flips/yr.
A retune edits that descriptor only, then the prod re-score of `EXSH_GATE`.

## FXH — haven-FX worst-of-3 20d move

**Retuned 2026-09-04 (`[USER]`)** from the coarse shipped priors to a σ-scaled pair on
`FXH_DESCRIPTOR.scorer.constants` (`src/family-descriptor-rows.ts`, the ONE source): amber ≈ 1.5σ and red ≈
2.5σ of a 20-session single-leg move at typical G10 realized vol. The retired priors were ~0.5σ / ~1σ of one
leg, so the worst-of-3 max tripped amber on ordinary months. Sized so every crisis-scale haven bid on record
(2008-10, 2020-03, 2024-08 JPY; 2025-04 CHF, all ≥ 8% in ≤ 20 sessions) clears red. Hand-set, no sweep. The
stored `readings.state` column keeps the prior vintage until the prod re-score of `FXH` runs.

## F12 — China credit impulse (deleted 2026-07-17)

F12 (China credit impulse, FRED QCNPAM770A) had its definition here until 2026-07-17 —
DELETED with the dead-feed retirement (DEC-21). Not a dead FEED like F14/F15 (the BIS series
still prints) but a dead SIGNAL: quarterly with a ~9mo BIS publication lag, no faster keyless
path exists (every FRED China credit series is the same BIS feed at the same print; TSF/AFRE
is not on FRED at all), and its documented lead is to INDUSTRIAL cycles, not equity drawdowns.
It was `macro-cycle`'s last surviving member, which left that family memberless by construction,
so the family KEY itself was removed too (DEC-22).

## VXNT — VXN term structure

Cuts are `VT_DESCRIPTOR.amber`/`.red` by reference (`VXNT_DESCRIPTOR`, `family-descriptor-rows.ts`): a VT retune
moves VXNT and gets no separate review. A VT `threshold-config.json` multiplier does NOT reach VXNT — `resolveBands`
keys on the id — so re-point VXNT if VT ever gets a non-1.0 multiplier.
`VXNT_K_WINDOW` is user-ruled [USER] 2026-10-20 — never swept.
Display-only (`CONTEXT`, `CHART_ONLY_INDICATORS`); promotion to a dial member is a new user ruling plus a replay,
never a weight edit.

## BBB — ICE BofA BBB US Corporate OAS

Never scored (`thresholds: {}`, no registry cut to move). Its semis cuts — the drawdown-watch `bbb` confirmer (`W_BBB_*`) and the
T2·T3 re-entry gate (`BBB_MIN_WIDEN`, retrace shared with HY's `T2_RETRACE`/`T3_RETRACE`) — live in `SEMIS_RULES`
(`probe-semis-tranches.ts`) — retune there, never here.
