# `MEMBER_WEIGHT` provenance

Also the home for the two sibling hand-set tables in the same file — `FAMILY_LEG_WEIGHT` (sections prefixed
`FLW.`) and `TIMING_CLASS` (sections prefixed `TC.`), both at the foot of this doc. The prefixes keep the
row keys unambiguous: `§cr` is the `MEMBER_WEIGHT` family block, `§FLW.cr` the `FAMILY_LEG_WEIGHT` row.
A third foot section — "Other `src/danger-ladder.ts` provenance" — holds the evacuated narrative for the
non-table constants in that file (`DIAL_FAMILIES`, `RERISK_CONFIRM`, `RERISK_DWELL_DAYS`).

Evacuated narrative for the `MEMBER_WEIGHT` hand-set table. **The LIVE table is `src/danger-ladder.ts`** —
that file's rows are the only source of truth for any weight, and its surviving docblock carries the
invariants/imperatives that bind an edit. Nothing here is load-bearing at runtime: this is the audit trail
(per-row rationale, measurement records, probe output, supersession history) that used to sit inline and
billed every reader of the table.

---

## Read/write protocol

**READ, before retuning a cell — section-scoped, never the whole file.** Three reads, in order:

1. **This section and the header above it** — the header carries the `FLW.`/`TC.` prefix legend.
2. **`## Table-wide — the two exclusion rules, at their seam`** — the unobserved-family/absent-member exclusions are
   read off this table and their populations move when a row here is edited.
3. **`grep -n '^## '` this file for your key, and read THAT SECTION ONLY.** Keys: `## <member-id>` for a
   `MEMBER_WEIGHT` row, `## <family> (family)` for family-wide material, `## FLW.<family>` and
   `## TC.<member>` for the two sibling tables.

**WRITE.** The retune itself goes into `src/danger-ladder.ts` — its rows are the only source of any value.
Into this doc goes ONLY the line that binds the next edit, **deleting the one it supersedes**; the
rationale, the measurements and the history go in the commit message (`.claude/rules/doc-writing.md`).

## Table-wide — the two exclusion rules, at their seam

⚠ **THE TWO EXCLUSION RULES, AT THEIR SEAM** — both in `danger-share.ts` `familyShare`/`pillarShare`,
both read off THIS table; a row's absolute magnitude is relevance only (except `uT` — §uT (family)); leg tilt lives in `LEG_SENSITIVITY`.

 1. **A family with no relevant observed member leaves the leg's pillar** — `familyShare` is `null` (stubbed,
    `isStructuralZero`, or every member with a cell > 0 unobserved), so it drops from the pillar mean AND `of`.
 2. **A member enters its family share only where its cell here is > 0 and it is observed** —
    Σ w·sev / Σ w over those members (uT: × min(1, full Σw) — §uT (family)); a missing cell or a 0 is dropped, never folded in at sev 0.

⚠ **A WEIGHT EDIT MOVES THE FAMILY SHARE unless `scripts/lib/weight-algebra.ts` calls it share-invariant**,
and fires no `DANGER_CUTS` re-derivation — a seat/unseat does (`.claude/rules/research-probes.md`).

⚠ **THE `Value` FIXTURE POST-DATES EVERY EVENT-STUDY NULL QUOTED IN THIS FILE.** `Value` was
structurally UNMEASURABLE — no committed fixture for `XDEV.DE` — in every arm run before 2026-08-05,
when it gained `LEG_FIXTURE.Value` = `scripts/backtest/data/value.csv` with `LEG_EVIDENCE.Value` =
WEAK. So a null quoted below covers the 32
of 36 leg × bucket × horizon cells it scored, says NOTHING about `Value`, and is re-runnable at the
full 36 — re-run before quoting one as current. A WEAK leg with no EXACT co-signer still cannot move
a cell on its own (`verdictOf` → `PASS (weak — …)`).

---

## rt (family) — the defensive-column audit

> **The `rt` defensive column shape is DERIVED, never hand-typed: `npm run probe:rt-defensive` is the
> only authority.** A hand-typed enumeration has now been wrong TWICE (a stale `R7` 0.4 after the
> 2026-08-02 euro-scope cut, then a stale `EURC`/`BUND` 0.4 after 2026-08-04). Re-run the probe; never
> carry a number forward.

What survived as fact rather than count, and is NOT re-measured here: `FAMILY_LEG_WEIGHT.rt` leads the
`Staples` column but NOT `Health`'s — the two defensive legs deliberately lead on different families
since the 2026-08-20 swap (§FLW.cr), and that asymmetry is the ONLY thing separating their leg danger;
both columns differentiate (carriers and rowless members: the probe's column tables, never this line);
and R6 is the lone TOP carrier on BOTH `Health` and `Staples`, at different weights since 2026-08-31
(§R6). The rung's own headline ("0.4 across every `rt` member") and its carried-in correction ("a
constant over 8 members") are BOTH wrong.
The probe folds through production's imported `quasiMaxFold`/`BREADTH_LAMBDA` since 2026-09-26 (its
hand-typed plain max had gone stale and its fold guard threw) — so its leave-one-out and perturbation
counts are the field's, NOT upper bounds: the breadth bonus lets a seated absentee lower the cell as
well as raise it. Strict-argmax shares stay upper bounds.

---

## R1 — term-spread inversion (T10Y3M)

R1 term-spread inversion (leading recession): high-beta cyclicals worst, defensives are havens.

⚠ `Health` 0.4 → 0.2 `[USER]` 2026-09-22 (QDVG sector-risk pass, 2y visual read of Health drawdowns — UNMEASURED; a
   magnitude change only, §Table-wide).

⚠ `Semis` 1.0 → 0.6 `[USER]` 2026-10-24.

⚠ **R1 AND R7 CARRY BYTE-IDENTICAL ROWS, AND THE ONLY ARGUMENT FOR THAT IS REFUTED.** Both
halves were measured; the values are deliberately
UNCHANGED and the measurement, not a mechanism story, is the record. Read it before touching
either row — and never re-derive one row off the other, which is the move that produced them.
(Historical: the two rows have since parted on `Health`/`Staples`/`Semis` — see R7.)

---

## R2 — 10y nominal shock

R2 10y nominal shock: duration hit on growth; bond-proxy income hurt.

⚠ "Value insulated" WAS the third clause of that sentence and is RETIRED (2026-08-05).
Value is duration-SHORT as a factor, but the
leg's fund carries a telecom bond-proxy block that is duration-long, so a long-rate shock reaches it
through a channel the one-line claim denied. See the `Value` note on R2's row.

⚠ **R2 AND R4 DIVERGE ON `Semis` AND `Value`** (they were cell-for-cell equal only between
2026-08-03 and 2026-08-04; `Value` re-split on 2026-08-05). The historical note below is about the
`Semis` cell alone: it was DELIBERATELY REMOVED as a differentiator on 2026-08-03 by
shape-matching R2's cell to R4's
(the ledger entry sits just above the R2 row below). Both halves
were measured BEFORE that demotion and the numbers are
kept as the PRE-DEMOTION record — the re-run is waived as a stated cost, so nothing below has been
re-measured against the equal rows. Read this whole block before touching either row: the measured
finding that the differentiating cell moved no BAND is precisely why removing it was safe.

⚠ `Semis` 1.0 → 0.6 (2026-08-03).
R2 is a near-subset of R4 —
`P(R4 | R2) = 0.847`, R2 lit alone on 27 of 3,750 days (0.7%) with 2 RED days in fifteen years, no lead
over R4 (Δ20 lead/lag argmax k = 0), and no R2 pair clears the 0.90 same-factor line. `Semis` was the
one cell on which the two rows disagreed, so shape-matching it to R4 removes the last divergence.
DEMOTE, NOT DISARM: leave-one-out has R2 moving a leg BAND on 34/5792 days with 31 of those R2-only,
so the thin marginal is real signal and the row keeps a non-zero `Semis` cell (stays `isRelevant`).
The `probe:r2-r4` re-run is WAIVED as a stated cost — do not schedule it, and do not record it as
missing follow-through.

⚠ THE 2026-08-03 CELL-FOR-CELL EQUALITY WAS RE-DIVERGED ON 2026-08-04 (Option A). `Semis` diverged again — R2 keeps the demoted 0.6 ruled 2026-08-03,
R4 goes back to 1.0 on the duration axis — so the deep-equal pin in `danger-ladder.test.ts` was DELETED
per its own instruction, NOT satisfied by editing the rows back together. The demotion reasoning above
still stands for R2; what the re-divergence rejects is applying it to R4, whose seat IS the real /
discount-rate channel. ⚠ CONSEQUENCE FOR `probe:r2-r4`: its arms can separate again (they were A/A by
construction while the rows were equal), but the waiver is unchanged — still do not schedule it.

⚠ `Semis` STOPPED BEING THE ONLY DIVERGENCE ON 2026-08-05: the Value retune
raised R2's `Value` cell and left R4's alone. The divergence set is now
{`Semis`, `Value`} — read both cells, not just `Semis`, before reasoning about the pair.

⚠ `EU-Fin` 0.6 → 0.4 and `Staples` 0.6 → 0.4 (2026-08-04, review §4). Both are channel-NEUTRAL repairs,
which is why they moved on this row as well as R4's: `EU-Fin` for R3 parity (rising yields are
NIM-expansionary for euro banks with sticky deposits, so a 58%-financials leg does not belong two tiers
above `Value`), `Staples` because the firm-level work names staples a LOW rate-sensitivity sector and
equal-to-`S&P 500` overstated it.

⚠ `Value` RAISED 2026-08-05 — see the
retired-claim note at the head of this row. ⚠ THIS ALSO RE-ORDERS THE `EU-Fin`-vs-`Value` COMPARISON in
the 2026-08-04 note above: that repair's stated ground was that a financials-heavy euro leg does not
belong ABOVE `Value` on a long-rate shock. The two cells have since crossed the other way, which the
repair neither ruled on nor forbids — the `EU-Fin` cell was set on its own euro-NIM evidence and is not
re-derived from `Value`'s rank. ⚠ RULED ACCEPTED 2026-08-05: the inversion is NOT a defect and no
weight moves for it — the `EU-Fin` cell rests on its own euro-NIM evidence, so what is stale is only the
2026-08-04 review's incidental phrasing about the ordering, never the table. "Restoring" the ordering is
FORBIDDEN absent NEW evidence on the `EU-Fin` cell itself; re-opening the 2026-08-04 review on this
ground alone is closed. Keep this note as the audit trail.

---

## R3 — 2y / Fed-path shock

R3 2y/Fed-path shock: transmits broadly, EM worst via USD/outflows; Value insulated.

⚠ `EU-Fin` 0.6 → 0.4 (2026-07-31, design §5.2). A 2y/Fed-path shock hit the old income sleeve through
its bond-proxy duration; European financials sit at the `Value`/short-duration end of that channel and
a policy-path repricing is partly favourable to them (deposit margins), so the leg drops to the row's
insulated tier alongside `Value`.

---

## R4 — 10y REAL-yield shock

R4 10y REAL-yield shock: THE equity-duration driver, maximal on growth; bond-proxy hurt; Value benefits.

⚠ THIS ROW DIVERGES FROM R2 ON TWO CELLS — `Semis` (2026-08-04)
and `Value` (2026-08-05,
which raised R2's cell only).
It was cell-for-cell identical to R2 from 2026-08-03 to
2026-08-04; that identity is what the review's finding F1 rejected — a row equal to R2 everywhere
contributes no SHAPE, so R4 could matter only by being worse than R2 in STATE, never in shape, and
the real/discount-rate channel R4 exists to isolate went unexpressed in the leg mapping.

⚠ Never re-derive one of these rows off the other — the rule SURVIVED the rows becoming equal and
survives their re-divergence. It is the reason this stays an inline object literal rather than a
shared constant (excess-property checking only fires on fresh literals; see the live file's header).
The deep-equal pin that held the 2026-08-03 identity has been DELETED from `danger-ladder.test.ts`,
per that test's own instruction — a re-divergence ruling deletes it rather than editing these rows
back into agreement. Nothing pins the pair's relationship now; the rows are independent priors.

⚠ `Semis` 0.6 → 1.0 (2026-08-04, review §4, finding F2), restoring `Semis ≥ S&P IT`. The 2026-07-14
demotion's stated ground — coincident momentum plus an F6 lead claim (itself falsified 2026-09-02:
F6 is `coin`) — is a LEAD/LAG argument, and THIS table's
documented meaning is absolute magnitude inside the `max`; timing is `TIMING_CLASS` / `SIGNAL_HOLD_CLOSES`'s
axis. ⚠ THAT POINTER WAS `FAMILY_LEG_WEIGHT` UNTIL 2026-08-04 AND WAS FALSE — that table is
WITHIN-leg RELATIVE family importance, column-normalized, and encodes no timing at all. The timing axis
did not exist when this comment shipped; it does now. Since repaired.
Semis
are the longest-duration, highest-beta cash flows in the index, so on a pure discount-rate shock they
rank at or above `S&P IT`. R2's cell stays 0.6: its demotion was ruled on its own nominal-shock ground.

⚠ `Staples` 0.6 → 0.4 (2026-08-04, review §4) — a channel-NEUTRAL repair applied identically to R2
above; the grounds are recorded there and are not restated per-row.
⚠ `EU-Fin` LOWERED 2026-10-08 [USER]: US real yields reach the fund only as
global-rates spillover, and higher yields help its ~31% insurers. `R2`/`R3` deliberately NOT moved; `R2`'s re-open gate is untouched.

⚠ `EM` 0.8 is KNOWINGLY UNRESOLVED, not endorsed — review finding F6 holds that the EM hit is
concentrated in TERM-PREMIUM-driven rises with dollar appreciation, which R4 alone cannot discriminate.
That was queued as Option B's question, deliberately not touched by this hand repair — see the null
directly below for what Option B can and cannot answer.

⚠ THIS WHOLE ROW IS UNADJUDICATED BY FORWARD-EXCESS MEASUREMENT, and that is measured, not assumed.
`realRateShock()` (`scripts/backtest/event-study.ts`, `--probe=rt`) scores exactly the study review
§2's Option B proposed — each sleeve's forward excess return conditioned on R4's confirmed AMBER/RED
buckets, against six placebo rotations. Re-run 2026-08-04: **32 of 36 leg × bucket × horizon rows
PLACEBO-FAIL** and the other 4 are `Value`, UNMEASURABLE at that run — §Table-wide.
The best `p` in the arm is 0.143, which IS the floor six rotations can produce
(`research-probes.md` §A conditional-return claim owes a PLACEBO arm), so no cell clears any bar that
is reachable at all. Per the live file's standing convention a PLACEBO-FAIL moves no cell ⇒ **the nine
magnitudes here remain hand-set on the review's sourced sector evidence, and no forward-excess study
may be quoted to move one.** ⚠ WHAT THE NULL DOES NOT SAY: the harness measures FORWARD excess after
the bucket lights — a PREDICTION claim — while this table's documented meaning is damage magnitude
inside the `max`. The same rule's own window caveat covers this ("a forward-looking weight table and a
contemporaneous-damage narrative can then both be right"), so the null refutes R4-as-predictor, not
R4-as-magnitude. The surviving question — whether the sleeve ORDERING is stable across the six
rotations even though every LEVEL fails — is not answered here.

---

## R7 — bull steepener

R7 bull-steepener (2y collapse = recession onset): worst for cyclicals/EM; defensives outperform.

⚠ UNMEASURED PRIOR. It WAS byte-identical to R1's row — see the byte-identical-rows block under R1 for why
that identity had no surviving justification and why the values were otherwise left alone. The
two rows now differ on exactly three cells, `Health`/`Staples` (euro-scope cut below) and `Semis`.

⚠ `Health` 0.3 → 0.1 `[USER]` 2026-09-22 (QDVG sector-risk pass, 2y visual read of Health drawdowns — UNMEASURED; a
   magnitude change only, §Table-wide).

⚠ `Semis` 0.8 `[USER]` 2026-10-25: never lower it on R7's `lag`
   `TIMING_CLASS` — that class gates the prognosis top-10, not the danger ledger.

⚠ `Staples` 0.4 → 0.3 (2026-08-02,
values on the euro-scope rule).
A MAGNITUDE change only (§Table-wide). R7 is a US
bull-steepener read, so the cut is the SMALLEST of the three in this stage: it is trimmed for the
haven tilt, not for euro scope (QDVG/ZPDS hold no European assets, which is what moves EURC/BUND
twice as far).

---

## EURC — euro-curve inversion (10y−3m)

EURC euro-curve inversion (10y−3m) — the row BUND was copied FROM. Its zeros on `S&P IT`,
`S&P 500` and `EM` carried the stated ground "EU/DM-ex-US-scoped: US-only legs and EM get 0", sourced to an MSCI value-vs-growth blog and never
measured. `npm run probe:eurc-ust` measured it
(5,406 shared days, 2004-09-07 → 2026-07-23) and it does not hold — EURC owed its OWN arm because
it is 10y−3m, not BUND's 10y−2y, so the like-for-like US comparator is R1's own `T10Y3M`.

⚠ `EU-Fin` LOWERED 2026-10-08 [USER]: the euro-curve slope is confirmation-only for
banks; the cell stays BELOW `ex-US`, BELOW `GILT` (UK reach belongs to the gilt member) and STRICTLY ABOVE `BUND` —
pin: `danger-ladder.test.ts` "EU-Fin rates ordering".

⚠ `Health` / `Staples` 0.4 → 0.2 (2026-08-02;
research §2 on the §4.1 EURO-SCOPE rule). The mirror image of the `EU-Fin` raise above: QDVG and
ZPDS hold ZERO European assets, so a euro-area stress member reaches them only through the global
risk channel, never directly — half the reach of the US-sourced R7 cell, which keeps 0.3. A
MAGNITUDE change only (§Table-wide).

⚠ SCOPE — deliberately small (§BUND's SCOPE note cites this one): `rt` is ALREADY live on all 9 legs via R1, so no
cell flips na→live and NO power-mean denominator moves. The family cell is a MAX fold, so these
three cells bind only when EURC's confirmed state is worse than every US rates member — rare by
the 0.956 co-firing above; the bite is the marginal AMBER-only set — M4 10.7% raw on the
**T10Y3M AMBER-or-worse arm** (580/5,406 days; the T10Y2Y arm reads 10.1% at the shared cut and
12.7% quantile-matched), an upper bound on the confirmed count since the probe scores RAW
states. Correlational: no claim that this improves rotation calls is made here
— that would owe a placebo arm (research-probes.md).

---

## GILT — UK 10y gilt velocity

SPARSE by [USER] ruling (uk-gilt Q3): `EU-Fin` + `ex-US` ONLY, off-band (never `BAND_DRIVING`) — add no third cell.
`ex-US` hand-set [USER] 2026-09-20; `EU-Fin` RAISED [USER] 2026-10-08 — keep it ABOVE `BUND`/`EURC`: the UK is EXSH's largest region (pin: `danger-ladder.test.ts` "EU-Fin rates ordering").

## UKDE — UK gilt − German Bund 10y spread velocity

SPARSE by [USER] ruling: `EU-Fin` + `ex-US` ONLY, off-band — add no third cell.
Keep both cells BELOW `GILT`'s: UKDE is the UK-specific slice of GILT's move, not a second full reach.

## ESTR — euro overnight-rate cut speed

SPARSE by [USER] ruling (eufin-top5 Q5): `EU-Fin` ONLY, off-band (never `BAND_DRIVING`) — add no second cell.
`EU-Fin` hand-set [USER] 2026-09-24 at HALF the `rt` peer median: the 2024–25 cycle (200 bp of cuts) left EU bank
NII +4–5% y/y and the basket is ~29% UK (Bank of England, not ECB) — raise it only on a measured margin hit to EXSH.

## BUND — German 10y−2y inversion

BUND German 10y−2y inversion — a GLOBAL duration/policy-PATH read, NOT a euro-only one.

⚠ THIS ROW WAS EURC'S VERBATIM COPY UNTIL 2026-07-24, INCLUDING EURC's ZEROS ON `S&P IT`,
`S&P 500` and `EM`. Those zeros carried EURC's stated ground — "EU/DM-ex-US-scoped: US-only
and EM get 0" — which was an ASSERTION, never measured.
`npm run probe:bund-ust` measured it (7,110 shared days, 1997-08-07 → 2026-07-23, vs FRED
T10Y2Y) and it does not hold.
Literature agrees in the same direction: non-US G7 term spreads are STRONGER <1y predictors of
US recessions than the US spread (Ahmed & Chinn, La Follette WP 2022-002), and ~HALF the
reaction in German yields spills into US yields — near-identical to FOMC→Bund (Fed IFDP 1226).
That ~0.5 spillover coefficient is the anchor for the US cells: ~0.5× the inversion-shaped
US rows (R1/R7), which is what BUND is a read OF. `ex-US` is top-of-row on euro home turf (sole top
since 2026-09-20 — see the `EU-Fin` note below), the
defensive haven tilt was CUT 2026-08-02 (see the euro-scope note below the `EU-Fin` block), and
`Semis` keeps 0.6 — but on the GLOBAL-cyclical mechanism,
NOT the old "European exposure" one (Europe is only ~6% of world semiconductor sales; SMH is
~7% EU-domiciled via ASML/NXP — both too thin to carry a 0.6 on their own).

⚠ `EU-Fin` LOWERED [USER] 2026-10-08 (together with `EURC`) — keep it STRICTLY BELOW `EURC`'s
(same euro-curve aspect; 10y−2y is confirmation-only — banks rallied on an inverted curve in 2022–23) and BELOW `GILT`'s, which owns UK
reach (pin: `danger-ladder.test.ts` "EU-Fin rates ordering").

⚠ `Health` / `Staples` 0.4 → 0.2 (2026-08-02;
research §2 on the §4.1 EURO-SCOPE rule) — same cut and same ground as EURC's cells above, and
the same direction as the `EU-Fin` raise: reach follows where the leg's assets actually sit.
QDVG/ZPDS hold zero European assets, so the Bund curve reaches them only through the global
duration/policy channel this row is a read of, not through euro home turf. Note this row does NOT
inherit R7's 0.3 — BUND is measured euro-SOURCED even though it is globally RELEVANT, and it is
the sourcing, not the relevance, that the defensive cells price. A MAGNITUDE change only (§Table-wide).

EM 0.5 closes the row's sharpest internal contradiction: every OTHER rt member weights EM
0.8–1.0 (its highest cells), and the euro area is a first-order EM final-demand destination
(IMF WP/15/215: a ~4% euro-area activity shortfall ⇒ ~4pp off China's growth).

⚠ SCOPE OF THE EDIT — deliberately small, the same argument as §EURC's SCOPE note, with BUND's own
numbers: P(US inverted | Bund inverted) = 0.966 makes the max-fold bite rare, and it is confined to
the ~530 marginal AMBER-only days (7.5%) — the same marginal-day set (M4 6.81%) that earned the seat.

`[USER]` 2026-09-29: cells kept across the level → velocity rescore (K1).

---

## cr (family) — OAS widening

⚠ `CQS.Health` 0.3 → 0.1 `[USER]` 2026-09-22 (QDVG sector-risk pass, 2y visual read — UNMEASURED; no
`## CQS` section exists, so the line lives here; a magnitude change only, §Table-wide).

⚠ `Health` / `Staples` SEATED 2026-08-02 on all 8 `cr` members
(values under the
cross-leg cap). The seat is MECHANISM-derived, not evidence-derived — the credit-fixture gap recorded
below is NOT closed and travels with every cell: OAS widening raises the discount rate and tightens
funding for defensive equity too, just less than for high-beta cyclicals, which is why the whole
column sits at or below the row's mid tier. The VALUES are NOT restated here — each cell's literal
in the live table is its one home, so a retune stays a one-place edit. The SHAPE: the broad US credit reads
(EBP/F1/F2/F3) sit at the top of the defensive column, the narrower EM/appetite reads (F10/F13) a
tier under them, and a euro-native credit read belongs at the floor tier because QDVG/ZPDS hold
zero European assets — §4.1's euro-scope rule (research §2 / §4.1).
THE STANDING EVIDENCE CAVEAT (unchanged by the seat — read it before retuning any `cr` cell):
measured 2026-07-25, the cells were
REACH-UNMEASURED, NOT a measured zero. BOTH credit-stress arms are THIN (< MIN_EPISODES 30), and the
co-signer was TRIED, not skipped ⇒ the gap is FLAGGED (credit-fixture bound, not "nobody looked"):
no `cr` arm has the episode count to confirm OR refute these cells, so the EW marker on
Health/Staples rests on the mechanism above, not on data (episode counts and fixture caveats in the
history).

---

## F1 — US HY OAS

F1 US HY OAS — high-beta cyclicals/EM hit hardest; `Semis` demoted: credit reads coincident-to-late on tech-led drawdowns, so the sector's own semis reads outrank it.
⚠ `Health` 0.5 → 0.6 `[USER]` 2026-09-22 (QDVG sector-risk pass, 2y visual read of Health drawdowns — UNMEASURED; a
   magnitude change only, §Table-wide).

⚠ `EU-Fin` cell ADDED 2026-08-01; LOWERED [USER] 2026-10-08:
US HY is spillover, not the leg's own credit market — keep the cell BELOW 1.0.
Rung 7 is a European-bank fund, and a US equity correction transmits to euro-area equity at roughly a
0.9 beta with EA credit spreads — HY included — widening alongside (ECB *FSR* May 2021 spillovers box).
The cell sits BELOW 1.0 because euro-native HY is this leg's own funding market and US HY is only
its correlated foreign twin. No `FAMILY_LEG_WEIGHT` companion
was needed — `cr` already reaches `EU-Fin`.

⚠ `Value` RAISED 2026-08-05: the cell sat at
this row's floor while `F13` held the row's top on the same leg, which had the broad-HY read quieter than
a single sub-channel on a leg whose fund is financials-heavy and deep-cyclical. F1 is the broad credit
lead there; it now ranks accordingly and still sits below `F13`.

---

## F2 — US IG OAS

F2 US IG — milder/broader than HY.

⚠ F2's `EU-Fin` cell is LIVE — SEATED 2026-08-16 [USER], overturning the
2026-07-31 drop; value is sibling-parity in the EBP/F3/F13 tier, under `F1` (evidence in the 2026-08-16 seating commit).

---

## EBP — excess bond premium

EBP excess bond premium — broad risk-appetite, HY-like.

⚠ `Value` RAISED 2026-08-05: EBP is the
cleanest risk-appetite read available, and the leg's fund is bank-heavy — risk appetite is the channel
that prices bank equity first.

---

## F3 — NFCI-Risk

F3 NFCI-Risk — US-broad financial conditions (leverage/funding/vol composite); reaches all US-exposed
legs, defensives lighter (havens under stress). Reach ≥ F2 so retiring F2 later leaves no leg uncovered.

---

## BONOS — Bonos−Bund sovereign spread

⚠ NO ROW — card-only (`CARD_ONLY_GROUPS` credit), RULED [USER] 2026-09-30: measured on the prod series 2010-08→2026-09,
BONOS moves with the Italian sovereign spread (daily-Δ corr 0.78, state agreement 78 %) whose level pair sat RED on ~93 % of 2010–2024
days and whose velocity leg fired AFTER the equity break in every non-euro-crisis episode (2020-03, 2024-08, 2025-04) —
no forecasting value on any leg. Never re-seat it without a new ruling; pin: `danger-ladder.test.ts` sovereign-pair.

---

## F13 — HYG/LQD credit appetite

F13 HYG/LQD credit appetite — leading, rate-clean credit read; Value primary, broad cyclical spillover.
A lone F13 RED trips the Value leg RAG to RED (weight-scaled max ≥ 0.75); AMBER (0.5) → Value AMBER.

⚠ EU-Fin 0.6 → 0.4 (2026-07-31, design §5.2): F13 is a **US** HYG/LQD pair, and the 0.6 priced a
global income sleeve that held US credit-adjacent duration directly. A European-financials leg reads
US credit appetite only as spillover, so it drops to the row's floor tier. Full-RED still scales to
0.4 ⇒ EU-Fin AMBER only (0.4 ≥ 0.25, < 0.75) — the soft-nudge, never-solo-trigger property is
unchanged by the cut, so the leg's RAG behaviour under a lone F13 RED does not move.

## AT1 — AT1 CoCo (USD, EUR-hedged) / bank sub-credit

⚠ SPARSE by ruling: `EU-Fin` cell ONLY, per-leg only (`PER_LEG_ONLY_MEMBERS` — never the band, never `legP`) — RULED
[USER] 2026-09-26; cell RAISED [USER] 2026-10-08 (bank AT1 +
insurer RT1 issuers ≈ 55% of the fund). Cuts live on `AT1_DESCRIPTOR`, not here.

## CCC — ICE BofA CCC & lower US HY OAS

RULED [USER] 2026-10-12: all nine legs, per-leg only (`PER_LEG_ONLY_MEMBERS`); invariant
`CCC <= F1` on every leg — pinned by `danger-ladder.test.ts` "CCC sits at or below F1 on every leg and has a cell on all nine".

---

## vl (family) — VIX equity-vol / MOVE bond-vol spikes

⚠ THE `Health`/`Staples` SPLIT — RE-MEASURED 2026-08-02, and the two legs part company: the re-run
on EXACT-declared QDVG/ZPDS fixtures OVERTURNS the 2026-07-25 both-zero reading on one leg only
(probe command and measured rows in the
history):
 • `Health` — SEATED on measured placebo-beating damage at BOTH horizons (the pre-registered bar):
   `R5` 0.4 and `F16` 0.2 (§4.1's euro cut). The earlier "positive excess ⇒ forward BENEFIT" reading
   is RETIRED: the sign convention there scored the leg's own excess return, and the re-run reads
   placebo-relative damage, which is the quantity the weight encodes.
 • `Staples` — the MEASURED ZERO STANDS, now on the EXACT-declared fixtures: all four rows
   PLACEBO-FAIL. `R5`/`VT` SEATED on `Staples` 2026-08-20 [USER] anyway — MECHANISM at the
   column FLOOR rung (the forward-return null answers a different question than a within-leg damage-reach
   weight); the placebo evidence is what this overrides, never re-derive the seat from it
  .
 • `VT` — SEATED on `Staples` 2026-08-20 [USER], REVERSING §5's "R5 only" proposal: a one-member `vl`
   cell would make Staples' whole vol reach hostage to a single VIX-level member, and VT is the
   term-structure member of the same family. MECHANISM seat with NO FALSIFIER ON TODAY'S DATA — `vl`
   severity is 0 board-wide, so its effect today is exactly zero; it asserts behaviour under a vol
   spike, not a measured row. `Health` keeps NO `VT` cell (its `vl` is already measured via `R5`/`F16`).

---

## R5 — VIX

R5 VIX — high-beta growth worst; `Semis` demoted: coincident vol, a confirmer behind the sector's own semis reads.
⚠ `Health` 0.4 → 0.5 `[USER]` 2026-09-22 (QDVG sector-risk pass, 2y visual read of Health drawdowns — UNMEASURED; a
   magnitude change only, §Table-wide).
⚠ `Staples` SEATED 2026-08-20 [USER] — mechanism seat, column floor rung (§vl split above); coupled
`FAMILY_LEG_WEIGHT.vl` in the same commit.

⚠ `EU-Fin` cell ADDED 2026-08-01; DEMOTED [USER] 2026-09-26
— keep it BELOW `VT`'s, which carries US vol on this leg.
One global risk factor accounts for ~a quarter of global risky-return variance and VIX is its most
liquid proxy, strongly correlated with the euro-area vol index (Miranda-Agrippino & Rey, NBER WP 29327). The cell sits
BELOW `F16` deliberately: the euro vol index is this leg's euro-native vol read, VIX its correlated US twin.
No `FAMILY_LEG_WEIGHT` companion was needed — `vl` already reaches `EU-Fin` (0.6, via F16).

⚠ `Value` SEATED 2026-09-04 at 0.6 [USER]: MU ~14% of the index makes
realised vol single-name US semis vol — `F16` alone reads the wrong 25%; coupled `FAMILY_LEG_WEIGHT.vl` 0.5 → 0.7 same commit.

---

## VT — VIX term structure

VT VIX-term — systemic, less EM-specific; `Semis` demoted: coincident vol, a confirmer behind the sector's own semis reads.
⚠ `EU-Fin` LOWERED [USER] 2026-10-08: US-origin vol — Europe-only shocks barely register
(2012 peak 0.95); `F16` + `EXSH_GATE` carry the euro-vol duty, so the cell sits BELOW `F16`'s on this leg.
⚠ `Value` SEATED 2026-09-04 at 0.6 [USER] beside `R5` — every engine-bearing `LEG_TOP.Value` member holds a seat;
the row stays a timing order (`leg-top.js` rule 1), never a weight ranking.
⚠ `Staples` SEATED 2026-08-20 [USER], reversing §5 — mechanism seat, NO falsifier on today's data
(`vl` severity 0 board-wide, effect today exactly zero); see §vl `VT` bullet.

---

## R6 — MOVE bond-vol (an `rt` member; its row sits inside the `vl` block)

R6 MOVE bond-vol — reassigned volatility→RATES (`rt`) at the Stage-1.2 taxonomy merge with
"weights unchanged", i.e. the family moved and the row did not. Rung 2
measured both halves of that row (2026-07-26):
  • R6 IS A DISTINCT FACTOR, so it keeps its seat: `npm run probe:move-vix` puts Δ20 r far below
    the 0.90 same-factor line, contemporaneous, neither leads. ⚠ This REFUTES the "VIX/MOVE corr
    ≈0.93" line in R6's own registry docblock, which is the stated ground for translating VIX cuts
    onto MOVE; treat that number as retired.
  • ITS LEG COLUMN HAS NO MEASURED SUPPORT — `npm run probe:event-study -- --probe=rt` runs two
    arms and they agree: EVERY leg × bucket × horizon PLACEBO-FAILs. Pinned in
    `scripts/backtest/event-study.test.ts`. The low power of the shipped arm is by design, not an
    accident — which is WHY the rarer second arm exists, and why the null cannot be dismissed as
    "the cut is too loose".
⚠ THE MEASURED NULL STANDS AND IS NOT OVERTURNED BY THE 2026-07-31 RULING BELOW — the row is now
MECHANISM-DERIVED, not evidence-derived; the placebo-fail above is the standing caveat on every
cell of it. The historical 4-cell shape (`Semis`/`S&P IT`/`EU-Fin`/`Staples` lit, the other five
zero) had NO stated mechanism at all: it needed two (high-beta de-levering ⇒ `Semis`/`S&P IT`, plus
bond-proxy duration ⇒ `EU-Fin`/`Staples`) and neither explained where the row STOPPED — `EM`, the
classic rate-vol casualty and every other `rt` member's highest or near-highest cell, sat at 0.
That gap is what the ruling closes; retiring the member outright stays out of scope.
⚠ WHAT THE RULING COSTS, MEASURED — the defensive-column leave-one-out numbers (`npm run probe:rt-defensive`),
their retirement flags and the "upper bound" caveat that travels with them (plain-max era — it does
NOT carry to post-2026-09-26 runs, §rt) are in the history; live
reaches are NOT quotable from here — derive each from `cellSensitivity(family, leg)`.
RULED 2026-07-31 ([USER]): the row is filled to
all 9 legs off ONE stated mechanism — **RATE-DURATION SENSITIVITY**. Long-duration growth
(`Semis` / `S&P IT`) · bond-proxy defensives (`Health`, `Staples`) ·
broad indices (`S&P 500` / `ex-US`) · short-duration (`Value`, and `EU-Fin` since the
2026-07-31 rung-7 re-set below — §3.6 shipped it in the bond-proxy tier under the bond-proxy reading) ·
`EM` high because it is the
most rate-and-dollar-sensitive leg (its old zero was the least defensible cell). NOT derived off a
sibling row — that is the refuted R1/R7 move.
⚠ `EU-Fin` 0.8 → **0.4**, RULED 2026-07-31
([USER]) — a PARTIAL REVERSAL of the §3.6 ruling four bullets up, taken the SAME DAY, and the
supersession is recorded at that doc's §3.6 as well. Scope: this ONE cell; the other eight are
untouched (the superseded leave-one-out figures and their retirement flags are in the history).
WHY 0.4 AND NOT A ONE-NOTCH 0.6: §3.6 priced this cell as a **bond-proxy defensive**, which is what
the rung-7 sleeve was — a global high-dividend income fund. The rung-7 rename swapped the instrument
to a 58%-financials European fund, and that mechanism does not merely weaken, it INVERTS at the
sector level: banks are not bond proxies. Their liabilities re-price faster than their assets, so
they are the archetypal SHORT-duration sector and they GAIN from the steepening a bond-vol spike
accompanies. Since R6's row is filled off rate-duration sensitivity ALONE, a short-duration leg
belongs in the row's short-duration tier — 0.4, beside `Value` — not one notch below the bond
proxies. This is deliberately DEEPER than the R2/R4 0.8 → 0.6 demotions in the same arc: those rows
read a rate LEVEL shock (some duration survives in a bank's bond book), whereas R6 reads rate VOL,
which is the purest duration instrument of the six and therefore the one a short-duration leg is
least exposed to. The row-wide measured NULL flagged above still applies to this cell: like every
other cell of R6 it is mechanism-derived, not evidence-derived.
⚠ `Health` 0.6 → **0.5**, RULED 2026-08-31 ([USER], archived).
Scope: this ONE cell; `Staples` stays 0.6. TWO THINGS BIND THE NEXT EDIT HERE (grounds, episodes and
βs are in the commit message, not repeated):
 (1) **0.5 is a FOURTH rung in what was a three-tier taxonomy** — now 0.8 long-duration growth /
     0.6 bond proxies + broad / **0.5 partial bond proxy** / 0.4 short duration. `Health` sits below
     the bond proxies but is not a bank, so the short-duration 0.4 is refused on mechanism. A move
     off 0.5 owes an argument against the rung, not merely for a value.
 (2) **The `rt` family now discounts `Health` on BOTH axes** — this member cell AND
     `FAMILY_LEG_WEIGHT.rt` (`Health` 0.85 / `Staples` 1.00, 2026-08-20), off the same evidence,
     which §FLW.rt already bars widening by citation. A session tightening EITHER axis must slacken
     the other or restate this caveat.

---

## xa (family) — cross-asset: haven bid = risk-off, cyclicals/EM hurt

⚠⚠ `Health`/`Staples` SEATED on `FXH`/`DISP` 2026-08-20 [USER] — the xa-wide exclusion is OVERTURNED
for them on MECHANISM at the column FLOOR rung, the same route as `EU-Fin` below: the measured zeros are
forward-EXCESS-RETURN nulls, `MEMBER_WEIGHT` is a within-leg DAMAGE-REACH weight (a different question),
so NEVER re-derive the seat from the placebo evidence. Arithmetic ground: the SN cells read an imputed
0.796/0.839 today, so the seat moves them TOWARD the measured null, not away from it. `CG` stays
EXCLUDED on its own frozen-row grounds (§CG). The measured-zero evidence below is what this overrides — kept as that, not as a live
exclusion.
MEASURED-ZERO (measured 2026-07-25 — supersedes the
2026-07-20 "documented exclusion" ASSERTION with a measurement): BOTH cross-asset arms are measurable
and BOTH PLACEBO-FAIL every AMBER/RED bucket on all three defensive legs — DISP three-level (280 AMBER
/ 156 RED) and FXH FX-haven worst-of (775 AMBER / 415 RED). No defensive leg shows placebo-beating
negative forward excess at both horizons, so none earns FORWARD-RETURN reach — a different question from
the DAMAGE-REACH the seat above answers, so the cells are now seated on mechanism, not absent. Granting
any xa member weight there ALSO requires the same legs in FAMILY_LEG_WEIGHT.xa in the
SAME commit, or `danger-ladder.test.ts`'s reach-coverage pin fails (the F16 stale-leg-reach bug class).

⚠ `EU-Fin`'s third of that zero was RE-MEASURED ON ITS OWN INSTRUMENT, 2026-07-31 (the
pre-registered probe re-run once with
`LEG_FIXTURE["EU-Fin"] = exsh.csv`, `LEG_EVIDENCE["EU-Fin"] = "EXACT"`). Verdict: PLACEBO-FAIL on
all four (bucket × horizon) cells of the binding DISP arm, the FXH arm too — a MEASURED ZERO on
the leg's own series, NOT a reach-unmeasured gap, but read it for exactly what it is: a
FORWARD-RETURN zero for the two arms measured, not a no-mechanism finding (the four-cell table is
in the history). `Health`/`Staples` were SEATED 2026-08-20 on that same forward-return-vs-damage-
reach distinction (opening block); the 2026-07-25 WEAK-proxy read is the evidence the overturn
overrides.
⚠⚠ THE `EU-Fin` OVERTURN — RULED [USER] 2026-08-01. The W2 (2026-07-20) xa-wide exclusion, and its 2026-07-25/2026-07-31 measured
restatements above, are OVERTURNED FOR `EU-Fin` here, and for `Health`/`Staples` on the SAME route
2026-08-20 (opening block). Two things changed that the earlier verdicts could not weigh:
  • The INSTRUMENT. W2 ruled when rung 7 was a GLOBAL DIVIDEND sleeve; it is now a European BANK fund
    (EXSH.DE). The USD-funding / bank-risk-capacity channel — dollar strength contracts global
    credit supply through banks that run large USD books, and euro-area banks run some of the largest
    (Bruno & Shin, BIS WP 819; Avdjiev et al., *IMF Econ Rev* 2019; ECB *FSR* Nov 2024) — is
    BANK-SPECIFIC in a way a dividend sleeve's exclusion never weighed, because a dividend sleeve has
    no funding book to squeeze. The 2026-07-31 re-measurement above ran on EXSH.DE's own series but
    tested the DISP/dispersion arm's forward returns; it never tested this channel.
  • The QUESTION. The measured zeros are forward-EXCESS-RETURN nulls at 20d/60d. `MEMBER_WEIGHT` is a
    within-leg damage-reach weight, and the ruling seats the two members on the MECHANISM, at the
    bottom of the column, where the evidence grade actually sits: `FXH` 0.4 (BIS-grade mechanism, no
    equity elasticity anywhere in the literature ⇒ it can never climb toward the euro-native tier) and
    `CG` 0.2 (the floor rung — unpublished, index-level, growth-cycle rather than bank-stress).
The coupled `FAMILY_LEG_WEIGHT.xa["EU-Fin"]` 0.4 shipped in the SAME commit (see that table's docblock
for the anchor). Do NOT re-derive this from the placebo evidence above — it is a ruled decision, and
the evidence it overrides is scoped to a question the ruling is not answering.

---

## FXH — FX haven bid

FXH FX haven bid — high-beta + EM (USD) worst. The STRONGEST placebo survivor of the five xa members in
the W2 event study (134 episodes, same sign, real effect ~2× placebo) — weak support: enough to KEEP the
row, not enough for a max-capable cell. (DISP also partially survived, sign-only; the other three did not.)
 • ROW MAX 0.6 — RULED [USER] 2026-09-04: haven FX is COINCIDENT and downstream of the vol shock (Ranaldo
   & Söderlind 2010, contemporaneous hours-to-days; VIX Granger-causes USD/JPY, not the reverse), so on a
   worst-of fold a solo FXH RED must never out-vote `R5`/`VT` on any leg. The six high-beta cells follow
   the Aug-2024 carry-unwind damage order (BIS Bulletin 90: Japan/semis/US tech/EM carry targets worst,
   broad US index least). Do NOT raise any cell above 0.6 without a lead-evidence measurement.
 • `Health`/`Staples` SEATED 2026-08-20 (mechanism, column floor rung — the §xa overturn at the top);
   coupled `FAMILY_LEG_WEIGHT.xa` entries shipped in the same commit.
 • `EU-Fin` 0.4 — SEATED 2026-08-01, the exclusion OVERTURNED for this leg only (see the OVERTURN
   block above for the full ruling). Ties `EBP`/`F3` on this leg: a BIS-grade funding mechanism
   (euro-area banks' USD books) with no equity elasticity anywhere in the literature, so it cannot
   climb toward the euro-native credit/rates/vol tier.
 • `Value` RAISED 2026-08-05: Japan is the
   leg's #2 country. `F17` (USD/JPY) is seated on `Value` since 2026-08-10 (§F17), so this basket is no
   longer the leg's only JPY read; FXH reads JPY as flight-to-safety only, not as a standing currency weight.

---

## CG — copper/gold

CG copper/gold — cyclical Semis+EM worst.
 • `Health`/`Staples` = NO CG cell — the §xa overturn seats them on `FXH`/`DISP` only; CG's row is
   FROZEN (17-episode placebo-beaten, the one member ranking defensives high), so it grants no reach.
 • `EU-Fin` 0.2 — SEATED 2026-08-01 on the same overturn (block above), at the column FLOOR rung.
   Its evidence is the table's weakest admitted: country-level equity-return prediction at 3–12m
   (Roh et al., SSRN 2025), unpublished, index-level, and a growth-cycle read rather than bank stress.
⚠ THIN SAMPLE, UNADJUDICATED: 17 episodes, and the W2 placebo
(RED labels rotated forward 250 trading days) produced a STRONGER effect than the real one (Semis −7.17
vs −3.60), so the study cannot move this row in either direction. Frozen 2026-07-20 on every leg but `Semis`
(0.6 [USER] 2026-10-24 — episode replay, not this study); it is also the only
member ranking defensives high, which is exactly the ranking the placebo destroys — do not read it as
evidence for granting xa defensive reach.

**SHAPE CHANGE 2026-08-08 — NO WEIGHT CELL MOVED.** CG gained a second scoring leg (the HG÷GC
LEVEL's place in its own expanding distribution) beside the 20d return, joined by `combine: "split"`
(RED needs both legs, AMBER takes either). This is recorded here because the row's `EU-Fin` seat rests
on Roh et al. (SSRN 2025), and that cite is about the ratio **LEVEL** — the form CG only started
scoring on this date. The seat therefore got *better* aligned with its own evidence, but the
freeze above still binds: the placebo-FAIL is a property of the 17-episode event study, not of the
scored form, and no re-run has been done. **Do not read the level leg as validation of any cell in
this row.** The level cuts are STARTING PRIORS living on `CG_DESCRIPTOR.levelBand` and nowhere else.

---

## DISP — dispersion (broad multi-region structure stress)

DISP — EM most correlation-sensitive; broad moderate. ITS ZEROS ARE MEASURED, NOT FORGOTTEN:
 • `Semis` / `S&P IT` = BENEFIT cells. On DISP's 1714 RED days across 272 episodes the W2 event study put
   them at the LARGEST POSITIVE forward excess of ANY leg at BOTH horizons (Semis +0.42pp@20d / +0.85@60d;
   S&P IT +0.28 / +0.46). Per this table's own convention — a leg that BENEFITS gets a LOW weight so it
   floats up as the rotation haven — absent is CORRECT, not an omission. Mechanism: DISP cannot fire
   without an already-negative 20d basket, so its forward window is a MEAN-REVERSION window and the
   highest-beta legs revert hardest. The "diversification stopped working must hurt high-beta" narrative
   describes CONTEMPORANEOUS damage, which is a PRECONDITION here, not a forecast; this table is forward-
   looking by construction, so adding weight would encode a backward window into a forward table.
   Proposed as W2 ruling 3, VETOED by the probe, DECLINED by the user 2026-07-20.
   (Evidence caveat: `S&P IT` is measured through `qqq`, a 100-name growth index, not the IT sector —
   weaker evidence. `Semis` matches its ticker exactly and carries the finding.)
 • `Health`/`Staples` SEATED 2026-08-20 (mechanism, column floor rung — the §xa overturn at the top);
   coupled `FAMILY_LEG_WEIGHT.xa` entries shipped in the same commit.
 • `EU-Fin` 0.4 — SEATED 2026-08-16 [USER], overturning the 2026-07-20 W2 `xa` DECLINE despite
   PLACEBO-FAIL at all four cells (RED@60d excess +0.3035pp). Falsifier that the seat is live, not dark:
   `npx tsx --env-file=.env.prod scripts/probe-member-contribution.ts --env=prod --leg=EU-Fin
   --asOf=2022-06-16` → DISP row reads `LIT`, never `ABSENT`.
 ⚠ MAGNITUDE OF THE FOUR LIVE CELLS — RATIFIED FINAL. The three-level DISP event study ran
   2026-07-21 (`npm run probe:event-study -- --probe=disp`) against the re-cut AMBER/RED buckets.
   No forward-excess signal beat placebo at either horizon: every AMBER and RED cell PLACEBO-FAILs
   (RED n=272 episodes, AMBER n=131; `Value` UNMEASURABLE at that run — §Table-wide; re-running it
   changes NOTHING here, these four magnitudes are RATIFIED FINAL). So the
   three-level conditioning adds NO uplift over the binary DISP the numbers were set on, and the
   existing magnitudes stand as final — the study moves nothing (a PLACEBO-FAIL moves no cell).

---

## F9 — broad USD

F9 broad USD — the row encodes the FINANCING channel (EM outflows, USD-debt service, global financial
conditions), which transmits in days. The EARNINGS-TRANSLATION channel is DISCOUNTED, not overlooked:
Tech/Materials are the most dollar-sensitive S&P sectors (>43% average international revenue) and semi
equipment is the single most FX-exposed sub-industry (~85–95% foreign revenue), so on fundamentals alone
Semis would rank at or above ex-US. That damage arrives over reporting quarters, while this table drives a
rotation acted on now — the same lead/lag pricing as F1/R5/VT/F4's `Semis` demotions elsewhere in this
table. (⚠ arc history: the lead/lag precedent this row once cited was reversed 2026-08-04 —
finding F2 ruled lead/lag a category error on THIS table, timing is `TIMING_CLASS` /
`SIGNAL_HOLD_CLOSES`'s axis, magnitude is this one's — and the row was re-grounded with the four
`Semis` demotions.)
✅ HOLD DISCHARGED 2026-08-05 — that plan is implemented and ARCHIVED, so the blanket "no cell moves
until it is ruled" is spent and this row is editable again. The THIN-SAMPLE bar below is a SEPARATE
and still-binding constraint: it forbids moving the `EM` / `ex-US` cells on the 2026-07-20 study.
Splitting
F9 into two members would be a NO-OP: the family cell is a `max` fold, so the larger channel swallows the
smaller one and nothing downstream sees the split.
 • `Value` RAISED TO THE ROW TOP 2026-08-05.
   It sat at the row floor on the reading that the leg was an insulated US-domestic value sleeve — a
   reading the pre-2026-07-20 prose asserted outright while the code already granted weight. The fund
   (`LEG_TICKER.Value` = XDEV.DE) is a EUR-denominated line holding a MAJORITY of non-EUR assets, so the
   broad-USD axis is the leg's dominant transmission channel, not its least-affected one.
   ⚠ Not adjudicable by the forward-excess study either way: the leg IS measurable since 2026-08-05
   (`scripts/backtest/data/value.csv`), but `LEG_EVIDENCE.Value` grades WEAK — the fund switched index
   mid-window — and a WEAK leg with no EXACT co-signer cannot move a cell on its own (`verdictOf` →
   `PASS (weak — …)`). Its rows are a REPORT; this cell rests on the fund's published composition.
 • `Health`/`Staples` = the xa-wide documented exclusion above. ⚠ THE ONE MEASURED `Health`-vs-`Staples`
   ASYMMETRY ANYWHERE ON THIS AXIS lives here — SSGA App. II (verified at source 2026-08-30): `Staples`
   USD β **+0.65, R² 0.15**, `Health` NO significant USD row at all. It still cannot seat a cell: 0.3 only
   TIES `xa`'s FXH/DISP max and is inert, and 0.4 would need a [USER] overturn of the exclusion to buy a channel that §1 of the seating research
   prices as a HEDGE on these EUR-marked USD legs, not damage. Quote the beta; do not seat on it.
 • `EU-Fin` stays ABSENT on this row's OWN ground, not the narrowed xa-wide exclusion (§xa OVERTURN
   block), which ruled on `FXH`/`CG` only and never considered F9: it encodes the EM FINANCING
   channel, and its thin/unadjudicated sample below cannot move any cell in either direction. Note
   `FXH` — the OTHER broad-USD member — IS now seated at 0.4, so the USD-funding channel does reach
   this leg; F9 would be a second draw on it.
 ⚠ THIN SAMPLE, UNADJUDICATED — 20 episodes, and the W2 placebo flipped Semis to +3.31 against the real
   −0.60 (a 4× swing), so the study cannot move this row. It DID show EM +1.34 / ex-US +2.16 excess on F9
   RED days — the opposite of the shipped ranking — but that is precisely the cell the placebo destroys, so
   it is NOT evidence. Do not demote the `EM` / `ex-US` cells on it. ⚠ THIS BAR SURVIVES the
   2026-08-05 discharge of the lead-lag hold above — it is sample-based, not plan-based, so the two
   EM cells stay pinned to it even though the row as a whole is editable again.

---

## F10 — EM credit stress

F10 EM credit stress — EM leg dominant.

---

## F11 — CNY / China risk

F11 CNY/China risk — EM + commodity/semis cyclicals.
 • `S&P IT: 0` — CNY transmits through commodity and EM-cyclical demand, not US software/services;
   inherited from the 2026-07-14 EM-leading-indicators pass and never re-derived (see the thin-sample
   note below for why W2 could not re-derive it either).
 • `Health`/`Staples` = the xa-wide documented exclusion above.
 • `EU-Fin` stays ABSENT on this row's OWN ground, not the narrowed xa-wide exclusion (§xa OVERTURN
   block), which never considered F11: CNY transmits through commodity and EM-cyclical demand, and
   the thin/unadjudicated sample below carries no information about this row.
 ⚠ THIN SAMPLE, UNADJUDICATED — 21 episodes, and the W2 placebo was INDISTINGUISHABLE from the real run
   (S&P IT ranks 1st in both), i.e. the study carries no information about this row. Frozen 2026-07-20.

---

## F17 — USD/JPY (yen weakness)

F17 seats `Value` ONLY (its `MEMBER_WEIGHT` row) — ruled 2026-08-10; seating
any other leg needs a new ruling, not a re-derivation from F11's row.
`Value` 1.0 → 0.4 (2026-09-04 [USER]): a member outside `LEG_TOP.Value` stays
below `F9` 1.0 inside `xa`; Japan 20% keeps the seat.

---

## F16 — euro-area vol index

F16 — EU-vol CONFIRMER (not a leader); ex-US + EU high-beta; US-VIX legs stay on VT/R5.

⚠ `EU-Fin` LOWERED 2026-09-20 [USER] W6 (only 16.4% of the fund is Euro STOXX 50 names, holdings CSV
2026-09-17); the cell sits ABOVE `VT`'s (lowered 2026-10-08, holdings W5) and `R5`'s on this leg. `FLW.vl["EU-Fin"]` deliberately NOT moved with it.
⚠ `F16` is the only EURO-vol member reaching `EU-Fin` (`R5`/`VT` reach it too); this cell and
`FLW.vl["EU-Fin"]` still compound — read both before retuning either.

(The ⛔ residual-risk directive — nothing PINS the compounding, so retuning either cell alone ⇒
re-read the other first — is KEPT INLINE at the `F16` row, not moved.)

---

## uT (family) — trend/breadth: global trend break

"S&P 500" weights added 2026-07-21 (research pass): IT ~32% of the index / semis ~16-18% / NVDA ~7%,
so a tech drawdown mechanically hits the broad index at ~0.5× the S&P IT weight (2022: the index
realized ~0.45× the Mag-7 move). GT/GB stay 0.6 (genuinely broad signals).
S&P 500 already had GT/GB reach, so no uT cell flips
na→live and no power-mean denominator moves (the live docblock's dilution warning n/a here).

⚠ `uT` moves `LegRow.danger` via `trendShare` (`danger-share.ts`) = observed average × min(1, full uT Σw on the leg) — so
a uT edit owes the 9-leg ordering / `DANGER_CUTS` check; on Health/Staples (`GT` alone) GT's cell IS the trend ceiling.

---

## GT — ACWI trend break

GT ACWI trend break — semis/EM highest-beta.

⚠ `EU-Fin` cell ADDED 2026-08-01; DEMOTED [USER] 2026-09-26
— keep it BELOW `EXSH_GATE`'s, which leads `uT` on this leg.
GT is a broad global-index trend read, and the two findings that ground it are index-level: a US
equity correction transmits to euro-area equity at roughly a 0.9 beta (ECB *FSR* May 2021), and one
global factor carries ~a quarter of global risky-return variance (Miranda-Agrippino & Rey, NBER WP
29327). Neither is BANK-specific, so the cell stays out of the euro-native
tier. ⚠ Seating GT here turns on a `gatedTrend` term that was structurally 0 on this leg, so it
MOVES `LegRow.danger` (mechanism: the ⚠ in §uT (family) above; also the `uT`/`gp` docblock in
`FAMILY_LEG_WEIGHT`). The coupled `FAMILY_LEG_WEIGHT.uT["EU-Fin"]`
0.9 shipped in the SAME commit — required by the reach-coverage pin, not by the danger mechanism.
`GB` (global breadth) was considered in the same ruling and DECLINED: its source predicts returns
across 64 countries but explicitly FAILS on skewness/tail (Zaremba & Szyszka, *Economic Modelling*
2020), and reach is about drawdown.

⚠ `Health` 0.4 / `Staples` 0.3 ADDED 2026-08-02 (values
under the cross-leg cap). Same mechanism as
the ⚠ in §uT (family) above — NOT display-only; the coupled `FAMILY_LEG_WEIGHT.uT` 0.9/0.9 shipped in the
SAME commit for the reach-coverage pin. `Health` > `Staples` is the market-beta channel (§4.6): a global
trend break reaches health care harder than staples, the lowest-beta sleeve on the ladder. The other six
`uT` members (`GB`, `SPCONC`, `F6`, `F5`, `F4`, `F8`) stay UNSEATED on both legs — this arc seats the
broad-index trend read only. `NVDA` is NOT a `uT` member (`src/family-table.ts` re-points the family to
GT/GB/SPCONC/F6/F5/F4/F8), so it has no cell here to seat.

⚠ `GT`/`GB` `Value` RAISED 2026-08-05. Both
are GLOBAL reads (ACWI trend, global breadth) and the leg's fund is majority ex-US, so a global trend or
breadth break reaches it more directly than the old US-domestic reading of the leg allowed for.

---

## GB — global breadth

GB global breadth loss — mirrors trend. (Its `Value` raise is the `GT`/`GB` note in §GT above.)
⚠ `EU-Fin` DEMOTED [USER] 2026-09-26 with `GT`'s — keep it BELOW `EXSH_GATE`'s, which leads `uT` on this leg.

---

## F4 — US semis proxy

F4 US semis proxy — tech-LED; `Semis` demoted: coincident momentum, duplicative of the leg's full-weight F6 trend gate (2026-07-14 rebalance).
`S&P 500` at ~0.5×IT: semis ~16-18% of the index.

⚠ `Value` SEATED 2026-08-05 — a ROSTER change, not a magnitude one.
The three semis/hardware reads (`F4`, `F6`, `F8`) reached every other equity leg but
not this one, on the reading that an Enhanced Value index is structurally short semis. It is not: the
index's single largest constituent is a memory name (MU ~14% at 2026-08-31, `Value` 0.4 → 0.5 on 2026-09-04
[USER]: MU + QCOM + Murata ≈ 16% = the S&P 500's slice in one high-beta name), so semis is the leg's biggest single concentration. `uT × Value` was ALREADY `sensitive`/`measured` (`GT`
and `GB` are seated) and `FAMILY_LEG_WEIGHT.uT` already carries the leg, so this widens an existing fold
rather than creating a cell — no class flips and nothing enters or leaves the sensitivity vintage.
`F5` (QQQ/QQQE) and `SPCONC` stay DELIBERATELY ABSENT: they read momentum-tech BREADTH/concentration,
which an Enhanced Value index really is short — seating them would invert the thesis, whereas the single
names and the relative-semis read track the concentration the index actually holds.
  ⇒ THE `DANGER_CUTS` RE-DERIVATION TRIGGER DOES NOT FIRE — this seat widened a cell that was ALREADY
  `sensitive`/`measured` (`GT` + `GB` seated on `uT × Value`), which is the widening case in
  §Table-wide. Do not edit `DANGER_CUTS` (`danger-engine.ts`) on this arc's account.

---

## DB_SMH — TOMBSTONE (inert row, kept)

Fast-breaks EARLY-WARN redesign, D-C/D-D 2026-07-21. `DB_SMH` left BOTH the trend family (D-D) AND the
tech confirmer slot (D-C, reverted to `F4`) for its own capped EW sub-signal, so it is in NO family and
its `MEMBER_WEIGHT` row is never looked up — it is NOT a scored member. The row was kept, not deleted,
only because `MEMBER_WEIGHT` was out of scope that stage ("trusted as-is"); it still carries a
`TIMING_CLASS` entry for the same reason. **Do not retune it, and do not read its cells as live danger.**
The live file carries a one-line inline note at the row saying so — that seam must never go silent, since
the row is otherwise byte-indistinguishable from a scored one.

---

## SPCONC — SPY/RSP concentration

SPCONC SPY/RSP — the BROAD-market concentration read; the live row is `MEMBER_WEIGHT.SPCONC` —
`Semis` capped at 0.4. Shipped DAMPED ~0.5× the natural
{0.4/0.6/1.0} shape by USER ruling 2026-07-23 — an unvalidated new leg should not move
a leg's danger much until D5′-c retires one of the two concentration reads. Revisit
with that pick-one. ⛔ The 2026-08-26 cap RULES OVER the 2026-08-15 Micron-focus raise on `Semis` (user,
2026-08-30): keep that cell at or below 0.4. (SPCONC is CONTEXT/gatedTrend-only: its weight
reaches danger only via the ramped trend term `trendShare`·`trendGateFactor`.)
⚠ THE LIVE CRITERION IS "QUIETER THAN F5", NOT THE 0.5× RATIO. The 2026-07-23 ruling as WRITTEN is
"damped ~0.5× the natural `{Semis 0.4, S&P IT 0.6, S&P 500 1.0}`" and says nothing about F5; the
2026-08-06 ruling REPLACED it on `S&P 500` alone, capping that leg 0.5 → 0.3 (which is 0.3× of 1.0,
not 0.5×) so the row is quieter than F5 (0.4) everywhere — the prior 0.5 made SPCONC the LOUDER
concentration read there under the `max` fold, the opposite of the stated intent. ⚠ NO EDIT IS OWED
ON `S&P IT`: under either criterion that cell is already on-target.
📜 THE REACHABILITY EXEMPTION THIS ROW USED TO CLAIM IS **RETIRED** with the lead-precedence gate
— there is no admission test any more, so
SPCONC is now admitted on every close, on every path (the mechanism it rested on and the measured
UNGATED-branch numbers, which now describe PRODUCTION, are in the history). ⛔ A future SPCONC
weight edit is NOT exempt from duty (a) on any leg; it owes the real 9-leg ordering probe
(`npm run probe:leg-ordering` — the duty rides in the failing message of the weight-table pin in
`scripts/capture-core9-baseline.test.ts`, not in a rule file, since 2026-08-08). A co-observation
-coupling domination argument could still stand in, but the ceiling algebra by itself never
bought the exemption, and no rule file carries the exemption text to lean on.

---

## F5 — US breadth proxy

F5 US breadth proxy — tech-LED. ⛔ **DEMOTED 2026-08-30 [USER]**; the old `S&P 500` ≈0.5×IT dilution
rationale is SUPERSEDED. Keep every cell STRICTLY ABOVE the SPCONC cell on the same leg (§SPCONC).
⚠ NOTIFY-path row — an F5 RED bands AMBER in `memberScaledBand`, so a retune re-derives
`src/t1dial.test.ts` and the `--before=f5` literals (`scripts/probe-leg-ordering.ts`) in the same commit.

---

## NVDA — single-name gate

NVDA gate — single-name; `S&P 500` at ~0.6-0.7×IT, the least discounted: NVDA is ~7% of the index itself.

---

## F6 — SMH/SPY rel-strength vs MA200

F6 rel-strength break (RED iff SMH/SPY < its MA200, no AMBER — 2026-09-02 E4 `[USER]`) — tech seats
only: `Semis` 1.0, `S&P IT` 0.8; the `S&P 500`/`EM`/`Value` cells DELETED (no measured read there).
Sector risk flag, NOT a timer — post-2016: RED 25.4% of days, P(XLK −10% in 63d) 16.3% vs 7.2% base,
but P(SPY −10%) only 7.4% vs 5.9% and mean fwd-63d SPY +1.8%; re-seating a broad leg owes new evidence.
Measured 2026-09-02 (offline measurement): the E4 ribbon beats the prod rule on XLK-forward −10%
coverage; a re-measurement that
loses that edge reopens the seats.

---

## F8 — MU memory-cycle proxy

F8 MU memory-cycle proxy — noisy single-name; SOFT confirming weight off `Semis`.
`Semis` 0.6 [USER] 2026-10-24 (SEC0 holds MU ~7.7 %):
keep it below `SEV_CUTS.red` — an F8 RED alone bands Semis AMBER, never RED.
`S&P 500` at ~0.5×IT: thin single-name memory proxy, small direct index weight — kept proportionally low.
`Value` seated 2026-08-05 (roster note §F4), 0.6 → 1.0 on 2026-09-04 [USER] (MU ~14% of the index, ≈3× its SMH
weight): the row top, and outranks F4/F6 on this leg alone — the name F8 tracks IS the largest constituent.

## KBE_RS — KBE/SPY rel-strength vs MA50

`EU-Fin` ONLY, ruled [USER] 2026-09-24 — add no second cell.
Kept BELOW `EXSH_GATE`: a US-bank proxy for a UK/FR-listed basket, an indirect read of the held leg. LOWERED [USER] 2026-10-08:
US banks lag and made US-specific later lows (May-20, May-23).

---

## INS_RS — EXH5/EXSA insurers rel-strength vs MA50

`EU-Fin` ONLY, per-leg only (`PER_LEG_ONLY_MEMBERS`), seated [USER] 2026-10-08:
insurers are ≈ 31% of the fund and had no seat. Keep it ABOVE `KBE_RS` (the US-bank proxy) and BELOW 1.0. Cuts live on
`INS_RS_DESCRIPTOR` (defaulted to KBE_RS's pair, pending a [USER] re-eye), not here.

---

## EXSH_GATE — EU-Fin 3-check re-entry gate (EXSH.DE vs MA50/MA200, EXSH.DE/EXSA.DE vs MA50)

`EU-Fin` ONLY — the cell inherited from EXSH_RS ([USER] 2026-09-24),
which EXSH_GATE replaced [USER] 2026-10-06 (rule B) — add no second cell.
Kept ABOVE `KBE_RS`: the held fund's own trend + rel-strength gate, the direct read of the leg.

---

## ECY — excess CAPE yield × GT trend gate (vb's sole member, seated 2026-08-11 E5)

The 9-leg row's two binds: **Value is the haven cell** — its 0.3 stays the row minimum (cheap style is
the intra-equity refuge under a valuation de-rate; raising it above any other cell inverts the member's
whole mechanism). **Defensive 0.4 floor** — Health/Staples never drop below 0.4: a rich market de-rates
defensives too (they are duration-carrying equities, not bonds), so the row must keep reaching them.

## gp (family) — geopolitics: oil/commodity shock (G1 · OVX · BRENT)

ALL THREE OF THE FAMILY'S MEMBERS CARRY A ROW since the 2026-08-06 re-seat,
which OVERTURNED [USER] the 2026-08-02 §7
drop of `MEMBER_WEIGHT.BRENT`. The history — the A/A measurement that justified the drop, and why it
still holds — is the HISTORY note in §BRENT below; read it before touching the `BRENT` row.
⚠ ALL THREE SEATED ROWS SHARE ONE CROSS-LEG SHAPE, SCALED BY ONE SCALAR PER MEMBER — `OVX ×1.0`,
`BRENT ×1.0` (re-seated 2026-08-06 at a deliberate TIE with OVX — see below), `G1 ×0.5` (demoted
from ×0.75 in the same [USER] ruling) (evidence §0.4).
The three are NOT independent reads of three things — they are three reads of ONE factor (all three members carry
`geoFactor: "oil"` in `registry.ts`, which is why `alert-band.ts` already collapses them to one
escalator factor), so a bespoke per-member shape would be fitting noise on a sample of one.
The scalar is a LEAD ranking, not a confidence ranking: OVX has documented 1–20 day predictive
power for realized oil volatility (Physica A 2018), so it leads on turbulence TIMING; WTI and Brent
are cointegrated with only a slight, unstable WTI lead (Yang et al. 2020, TOPS, 1987–2017),
tightened further by the Dec-2015 export-ban repeal and WTI Midland's June-2023 inclusion in Dated
Brent — the same cointegration that made a separate Brent row redundant enough to drop in 2026-08-02,
and that is exactly why the 2026-08-06 re-seat put BRENT at a TIE with OVX rather than above it.
⚠ WHAT THE `BRENT` = `OVX` TIE DOES AND DOES NOT BUY — READ THIS BEFORE REASONING ABOUT THE ROW.
⛔ A WEIGHT TIE IS **NOT** DOMINATION. `observedWeightedMax` maxes `memberWeight(m, leg) × SEV_NUM[sev]`,
so equal WEIGHTS decide nothing until the SEVERITIES are also equal. BRENT and OVX are two different
scorers on two different feeds (BRENT: 20d ROC ∧ trailing-peak gate; OVX: level OR spike), so
**BRENT RED with OVX GREEN is an ORDINARY close, not a feed gap** — and on it BRENT is the STRICT
argmax and sets the leg. Measured on this exact fixture (fixture and per-leg numbers in the
history): the re-seat
RE-ORDERS all nine legs on a Brent-led close and reaches `computeField → held_sleeve` — the NOTIFY
path, not just display. It is a real, UNMEASURED behaviour change.
The 9-leg replay this re-seat and the `G1` demotion owe is **OWED and WAIVED [USER]
2026-08-06** — accepted, not discharged.
What the TIE does buy is narrower than "no effect": BRENT never OUTRANKS OVX on a close where both
are equally lit, so the row makes no magnitude claim about which read of one factor is stronger, and
it restores the member to `MEMBER_RELEVANCE` (derived from this table) and to the family's seated
roster. That is the ruled intent — redundancy plus roster, not inertness. The
alternative considered and REJECTED [USER] 2026-08-06 was `BRENT ×1.0` with `OVX` demoted to ×0.75,
which would have overturned OVX's documented lead (Physica A 2018 timing lead; Kilian & Park 2009
sign-isolation, cited at the `OVX` row) on a sample of one.
`combineLegDanger` is a `max`, so the scaled-down member can only bind when the leader is quiet:
that is the second-opinion case, the intended mechanism, not a
defect. ⚠ CAVEAT carried deliberately (it is what justifies shared-shape×scalar over a bespoke OVX
shape): OVX→oil-RETURN causality is state- and quantile-dependent and sign-unstable, and OVX is a
persistent net RECEIVER of volatility spillovers (Energy Economics 2016) — on macro-driven events
VIX/credit fire first and OVX relays.

⚠ THIS TABLE IS THE CROSS-LEG SHAPE ONLY — IT IS **NOT** THE FAMILY'S AUTHORITY. The `1.0` on
`OVX.EM` means "the most oil-sensitive leg", NOT "this member may set a leg's danger to 1.0".
Since 2026-08-02 `combineLegDanger` multiplies the whole `gp` cell by `EXO_SCALE`
(`danger-engine.ts` owns its derivation off `DANGER_CUTS`), so a full-weight RED here tops out just under the
red cut. That split exists BECAUSE these two questions were briefly conflated; the prod incident
that forced the split apart is in the history. (The **retune the AUTHORITY at `EXO_SCALE`,
the SHAPE here** directive is KEPT INLINE at the `gp` separator, not moved.)

THE SHAPE (identical ORDERING on both seated rows) and why each rung sits where it does:
  • `EM` top — importer-dominated on current weights (MSCI FactorLab oil sensitivity). Honest
    caveat: it is a MIXED basket (Saudi/UAE/Brazil exporters vs China/India/Korea/Taiwan importers),
    so the aggregate is an unstable weighted cancellation, not a clean read.
  • `ex-US` second — **World ex-USA is the MOST negative** region in MSCI FactorLab, while the US is
    mildly POSITIVE (net producer since shale). That asymmetry is why `S&P 500` sits mid-pack here
    rather than near the top, and why the US legs are NOT the epicentre of an oil shock.
  • `Semis` / `S&P IT` 0.30 — ⚠ **DOWN FROM 0.8**, the pre-2026-08-02 row's joint-top. NO
    peer-reviewed sector study gives semis or IT a significant oil beta: SSGA's macro-sensitivity
    study (WTI vs sector relative returns, Jul 2003–Dec 2022) DROPS both at its R² ≥ 0.08 screen for
    insufficient explanatory power. The only surviving channel is INDIRECT — oil → inflation →
    yields → duration de-rate — which is a RATES beta and is already carried by `rt`. The old 0.8
    was a tech-crash-era prior, not evidence. This move is the intended one; it lowers gp-sourced
    danger on the two tech legs and raises it on the defensives/ex-US.
  • `EU-Fin` LOWERED 2026-09-20 [USER] W5 to the defensive tier, and again 2026-10-08 [USER]
    (OVX/BRENT tie preserved): the fund's ~10% Energy sleeve (Aker BP, Orlen, Rubis — 2026-10-06) is a partial HEDGE on an oil shock.
    ⚠ THIS IS A HAND-SET RUNG, like the rest of the row — do not read the cell as measured: the
    composition × sector-beta derivation that proposed replacing the WHOLE shape was MEASURED and
    ABANDONED [USER] 2026-08-03 (no function of (region, composition) can express the
    double-counting correction above), and the corroboration gate that followed
    WAS NEVER WIRED and is ABANDONED [USER] 2026-08-03 —
    its plan is archived CLOSED WITHOUT SHIPPING, its three constants deleted, and **nothing decays
    a solo `gp` lead today**. The split-correction derivation
    CLOSED 2026-08-04 without shipping a derived
    row either, so the row stays hand-set (both arc histories in the history file).
  • `Staples` 0.3 **EQUAL to `Health`**, deliberately — the input-cost intuition was TESTED AND
    REJECTED; do not re-litigate it: SSGA App. II (re-verified at source 2026-08-30) puts the two
    betas statistically indistinguishable (numbers in the history). If the channel were input costs
    Staples would have to dominate; it does not. Both are low-beta risk-appetite loadings.
  • `Value` LOWEST — its oil beta is MECHANICALLY Energy's index weight (~13% of the S&P 500 in 2008
    → ~2% in 2020), i.e. COMPOSITION, not signal. No sector-neutral estimate exists.
⚠ ANY FIXED WEIGHT HERE IS A REGIME BET — stated rather than implied. There is a structural break
~2014 (shale): oil increases lowered US equities over 1990–2007 but not post-2010 (J. Macroeconomics
2019; Dallas Fed WP 2021), and the post-2020 oil–US-equity correlation is modestly POSITIVE. Read
this column as a prior with a known regime dependence, never as measured truth.

---

## G1 — WTI spike

G1 WTI spike — the shape ×0.5 (DEMOTED from ×0.75 [USER] 2026-08-06, same ruling that re-seated BRENT).

---

## OVX — crude implied vol

OVX — the LEAD member (×1.0), the shape at full strength.

⚠ **LEVEL-ONLY AND DIRECTION-BLIND** (`fred-level-velocity`, `registry.ts`): a demand-destruction
COLLAPSE lights OVX identically to a supply spike, so this row fires in both. A WTI-direction SIGN
GATE on this member was ruled and then **DELIBERATELY DECLINED** (2026-08-02, second qimpag round).
Why it was dropped: no
direction reaches `combineLegDanger` on the live path (`MemberObservation` is `{sev, obs, lag}`,
`FamilyPanel.members` rows are `{id, label, state}` — no value, no rate-of-change); threading one
widens `DangerInput` and leaves the gate silently ABSENT in every non-live constructor; and proxying
it off G1's severity is strictly harsher than what was ruled. The two-sided-vol exposure is a
**documented accepted limitation**, not an oversight — a future reader must not "restore" the gate.
Why the level read still leads on the shock class this family exists for: Kilian & Park (2009, *IER*
50:1267–87) — oil-specific precautionary-DEMAND shocks hit equities, aggregate-demand shocks help
them, supply shocks are largely insignificant — so a raw PRICE move is a sign-ambiguous mixture,
while implied vol isolates the component most reliably signed negative.

---

## BRENT — Brent crude

BRENT — RE-SEATED 2026-08-06 at ×1.0, a DELIBERATE TIE with `OVX` (the argument is in the ⚠ TIE
paragraph of §gp (family) above; the short form: a weight tie dominates only at EQUAL severity, so
on a BRENT-more-severe close this row is the strict argmax and moves the leg — effect UNMEASURED).

📜 HISTORY — the row was DELETED 2026-08-02 and that drop is now OVERTURNED [USER] 2026-08-06; the
2026-08-02 A/A evidence for the drop (293/293 evaluated closes, zero rank permutations) and the
retired `>$100` level-tail rationale are recorded in the history file. What binds here:
⛔ THAT A/A FINDING DOES **NOT** TRANSFER TO THE RE-SEATED ROW — do not quote it as a prediction:
it was measured on the OLD BRENT scorer at ×0.5, and a weight TIE is not domination (see the ⚠
block in §gp (family) above). The correct statement is that the re-seat's effect is UNMEASURED and
the replay that would measure it was waived. The `>$100` argument was ruled NOT a reason to keep the
row and is not the reason for the re-seat either — do not revive it, and do not "absorb" this row
by retuning `OVX`. (`G1` ×0.75→×0.5 IS part of this same ruling — see its row.) The
counterfactual stays re-provable forever — `probe-leg-ordering.ts`'s `--before=brent` arm measures
exactly "live minus BRENT" at the shipped ×1.0 weights (the arm's re-inversion history and the
`BRENT_ROW_PRE_DROP` provenance are in the history file).

---

## vl ⊇ complacency (family) — stretched-positioning warnings

Per-row reads, high-beta most vulnerable:

- `price-accel` — parabolic; mega-cap tech snap-back risk.
- `complacency-vix` — low VIX; broad risk-on complacency.
- `complacency-high` — highs + narrow leadership; tech-concentrated.
- `complacency-duration` — stretched calm; mild broad warning.

---

# `FAMILY_LEG_WEIGHT` provenance

Evacuated from `src/danger-ladder.ts` 2026-08-08 (same treatment as `MEMBER_WEIGHT` above). **The LIVE
table is `src/danger-ladder.ts`**; its surviving docblock carries the contract and the invariants that bind
an edit. Organised by row key (`FLW.<family>`).

## FLW — table-wide

uT (CONFIRMING gate) + gp (EXOGENOUS — a per-leg weighted `max` TERM in `combineLegDanger` since C1
2026-08-02, not an overlay) left the danger mean (Stage 2/3), so columns are renormalized: each leg's
top LIVE-in-mean family (cr/rt/vl/xa) = 1.0. Mid-ladder values are episode-evidence interpolations,
not regressions.

## FLW.cr — credit

cr: the top family for the broad/defensive-adjacent columns once uT left the mean.

⚠ `Semis` 0.7 → 0.6 (2026-08-15, credit slow/indirect for MU).

⚠ `EU-Fin` 0.6 → 1.0 (2026-07-31, design §5.1) — rung 7 is now a European-financials fund, for which
funding/credit stress is the dominant drawdown channel; coupled to `rt["EU-Fin"]` 1.0 → 0.8 (demoting
`rt` alone reddens the normalization pin — the two land together).

⚠ `Health` / `Staples` SPLIT 2026-08-20 [USER] — `cr` TAKES THE COLUMN ON `Health`, and steps below
`rt` on `Staples`. This
SUPERSEDES the 2026-08-02 seat's reading that `rt` leads both defensive legs; the two columns now lead
on DIFFERENT families and that asymmetry is the ONLY thing separating the two legs' danger — this is
the coupled half of `rt`'s entry below, and re-equalising either pair re-ties the legs exactly.
⛔ Do NOT reach for `MEMBER_WEIGHT` to express a Health/Staples difference: every member-axis asymmetry
between them MEASURED INERT on the 2026-08-20 closes, where R6 (`rt`) and FXH·DISP (`xa`) sat at or above
the edited member's weighted severity (the F3 equalise moved no fold); on those closes only the family axis reached. ⚠ The split bites only where the EARLY-WARN pillar wins the worst-of `max` — on an
SN-dominated close the two legs still tie.

## FLW.rt — rates/curve

⚠ `Health` 1.0 → 0.85 2026-08-20 [USER], `Staples` KEEPS the 1.0 — the coupled half of §FLW.cr's
defensive split above; read that entry for the channel, the measured deltas and the inert-member-axis
bar.
⚠ THE 0.15 SPREAD HAS NO REGRESSION BACKING — do not widen it by citing one. SSGA App. II (fetched
2026-08-30) does NOT discriminate the two legs on rate sensitivity (nested CIs). The spread rests on
the n=2 episode table alone, and its 0.1 fallback arm stays the documented retreat.

⚠ `Semis` 1.0 [USER] 2026-10-25: a family weight weights the cell's `wsev`, a MAX over its members (`observedWeightedMax`) — it routes no mass to any member.

⚠ `EU-Fin` 1.0 → 0.8 (2026-07-31) — rates are a
MIXED channel for a bank fund (banks earn the steepener); `cr` takes the 1.0. RAISED [USER] 2026-10-08
(low confidence — power-mean effect unmeasured): UK rates + insurers' rate sensitivity are the fund's largest single channel; stays BELOW `cr`'s 1.0.

⚠ `Value` RAISED 2026-08-05 — the fund
(XDEV.DE, MSCI World Enhanced Value) is financials-heavy and carries a long-duration telecom
bond-proxy block; rates are a first-order channel there, not a peripheral one.

## FLW.vb — valuation

Every cell < 1.0 — valuation is never a leg's TOP family (`cr`/`rt` keep each leg's 1.0): monthly,
GT-gated, one member. Keys = ECY's reach exactly (sole member on all nine legs).

## FLW.vl — volatility

vl ⊇ old complacency: vol-spike/positioning-unwind epicenter = high-beta tech (Semis/IT 1.0,
Aug-2024 + Volmageddon); EM vol-sensitive but FX/flows rival (0.8).
`Value` 0.5 → 0.7 (2026-09-04 [USER]): with `R5`/`VT`
seated the leg's vol read is US single-name semis vol, not `F16` alone.

⚠ `EU-Fin` KEPT at its 2026-07-31 level (2026-09-20 [USER] W6, `MEMBER_WEIGHT.F16` moved without it);
`F16` (only EURO-vol member here — `R5`/`VT` reach it too) still compounds — **read `MEMBER_WEIGHT.F16` above before retuning this cell**.

⚠ `Health` 0.4 SEATED 2026-08-02; `Staples` SEATED
2026-08-20 — the FLW.vl `Staples` weight is the
seat's pillar DENOMINATOR. **The measurement, the Health/Staples split and the `VT` seat live at
`MEMBER_WEIGHT.vl` / §R5 / §VT above — read them before retuning this cell**; not restated here (one
home per ruling).

(The `Staples` cell is now SEATED — the prior must-stay-absent invariant is retired.)

## FLW.xa — cross-asset

xa = dispersion+flight: EM is the canonical RORO asset (1.0, KC Fed/BIS); ex-US 0.8 via the
mechanical FX-haven translation channel; Semis 0.6 ([USER] 2026-10-24, paired with `CG`
`Semis` 0.6 — no xa member has a measured lead on semis); SPX 0.4 (partly the *destination* of risk-off flows). ⚠ `FXH`/`DISP` REACH
Health/Staples since the 2026-08-20 seat (§xa overturn), so those two cells are now `sensitive`
(measured), not the `insensitive` retained-at-s=0 placeholder they were before. No `na` row remains
since `ECY` seated `vb` (2026-08-11). See §Table-wide — the two exclusion rules.

Health/Staples SEATED 2026-08-20 [USER] (§xa overturn), reversing the W2 (2026-07-20) exclusion.
Adding a leg here is a coupled edit: it must land in the SAME commit as the matching MEMBER_WEIGHT
entries or `danger-ladder.test.ts`'s reach-coverage pin fails (the F16 stale-leg-reach bug class, now
guarded). *(That imperative is KEPT inline in the `.ts`.)*

⚠ `EU-Fin` 0.4 SEATED 2026-08-01 — it LEFT that exclusion, which now covers `Health`/`Staples` only.
THE FULL RULING AND ITS EVIDENCE LIVE AT
`MEMBER_WEIGHT.FXH`'s OVERTURN block — read it before retuning this cell; it is not restated here
(one home per ruling). The coupled `MEMBER_WEIGHT` entries (`FXH` 0.4, `CG` 0.2) shipped in the SAME
commit.

⚠ `Value` RAISED 2026-08-05 — FX/dispersion
is this leg's #1 within-leg axis: a EUR-denominated line whose majority of assets are non-EUR. The
column now ties `cr` at the top; ties are already legal here (`Semis` runs `rt` = `vl`).

## FLW.uT — trend

uT/gp rows: OUT of the L2 danger mean (uT = CONFIRMING gate, gp = EXOGENOUS shock). `Semis` RAISED
from 0.9 (2026-08-15 Micron-focus; coupled `GROWTH_RS_WEIGHT` mean re-record in `src/growth.ts`).

⚠ AND SO DOES `gp` SINCE 2026-08-02 (C1) — ALL THREE
`gp` members (G1/OVX/BRENT) carry `MEMBER_WEIGHT` rows above, and the `gp` cell's `wsev` is
`combineLegDanger`'s FOURTH (ungated) `Math.max` term. `uT` and `gp` are now the SAME mechanism,
differing only in the gate.

⚠ `EU-Fin` 0.9 ADDED 2026-08-01: `MEMBER_WEIGHT.GT["EU-Fin"]` was seated
and obliged this cell; LOWERED [USER] 2026-10-08
(low confidence) to the `uT` row's FLOOR — `GT`/`GB` are US-heavy global trend reads with no bank specificity.

⚠ `Health` 0.9 / `Staples` 0.9 ADDED 2026-08-02, the same reach-coverage coupling as `EU-Fin` above —
both take the row's 0.9 FLOOR. Declaring these cells makes the trend term LIVE on the two legs, which
is why the seat, not a standalone retune, is what moves `GROWTH_RS_WEIGHT`'s measured mean (see that
constant's docblock in `src/growth.ts`).

## FLW.gp — the DELETED row

Why the reach-coverage pin is not a reason to restore it: restoring it would only re-arm the
reach-coverage
pin against a family whose weights are decoration — and the 2026-08-02 seating of `OVX` on all 9
legs would then demand three brand-new DEAD cells (`EU-Fin`, `Health`, `Staples`). That still holds
after §7 dropped `MEMBER_WEIGHT.BRENT` and after the 2026-08-06 re-seat put it back: `OVX` reaches
all nine on its own in every one of those states, so the three dead cells the pin would demand are
exactly the same three throughout.

Evacuated 2026-08-08 — why the deletion still holds after Slice 2:

⚠ Still true after Slice 2 made `gp` load-bearing in `legDangerShare`: that term is the LEVEL-1
`MEMBER_WEIGHT` axis (magnitude inside the max), which is a different table from this one (the
within-leg family importance feeding the pillar mean). `gp` entering the leg's worst-of does not
put it in any pillar mean, so this row still has no reader. Restoring it is a compile error —
the outer key is `Exclude<SignalKey, "gp">`.

## FLW.mc — TOMBSTONE

Reviving macro-cycle means re-deriving its weights against a live feed, not restoring the 2026-07-15
priors.

---

# `TIMING_CLASS` provenance

Evacuated from `src/danger-ladder.ts` 2026-08-08: the three multi-line classification arguments, and (same
day, second pass) the per-row rationale that used to trail every row of the table. The `.ts` now carries the
class labels alone plus the two prohibitions that bind a re-classifier at their own seam. Organised by
member id (`TC.<member>`), in table order; the three argued-at-length members — `TC.F1`, `TC.F11`,
`TC.SPCONC` — keep their longer sections at the foot of this section.

## TC.F2

IG OAS — "milder/broader than HY", the same realized-spread channel as F1

## TC.EBP

excess bond premium — the informative NON-default risk-appetite component (Gilchrist et al.)

## TC.F3

NFCI-Risk — a financial-CONDITIONS composite (leverage/funding/vol), fires ahead of spreads

## TC.F10

EM OAS — a realized spread level, same class as F1/F2

## TC.F13

HYG/LQD — its row records "leading, rate-clean credit read"

## TC.AT1

AT1 CoCo (XAT1, EUR-hedged USD) vs € govt rel-strength — `coin` (eufin-overlap R7): a realized sub-debt reprice, read the same session as the bank repricing.

## TC.CCC

CCC & lower US HY OAS — `coin` (ccc-credit-seat D1): weekly cross-correlation with F1 peaks at lag 0, no lead.

## TC.R1

term-spread inversion — its row records "leading recession"

## TC.R2

10y nominal shock — the duration hit lands as the rate moves

## TC.GILT

UK 10y nominal shock — R2's gilt twin: the duration hit lands as the rate moves

## TC.UKDE

GILT's class: the UK-specific repricing lands as the spread moves.

## TC.ESTR

policy-rate cut speed — ESTR moves the DAY AFTER the decision (full immediate pass-through per the ECB's own
ESTR review); the market prices the cut weeks earlier in OIS / the 3M AAA yield (EURC's second tenor), so the
spot rate CONFIRMS, never leads — `coin` (retimed [USER] 2026-09-24 from `lead`)

## TC.R3

2y/Fed-path shock — a FORWARD policy path, repriced before the damage

## TC.R4

the event-study null "refutes R4-as-predictor, not R4-as-magnitude" (its row)

## TC.R6

MOVE — realized bond-market vol, coincident stress like R5/VT

## TC.R7

"AND IT LAGS AT RED — ONLY": the one row of its lead/lag split outside its placebo band

## TC.EURC

its row: curves "co-move CONTEMPORANEOUSLY in changes"; no ~4-month lead is supported

## TC.BUND

10y−2y inversion — "a GLOBAL duration/policy-PATH read", the R1 instrument class

## TC.T5YIFR

5y5y forward inflation — a forward expectation by construction

## TC.T10YIE

10y breakeven — market-implied forward inflation, same construction

## TC.ECY

lead — the EARLY-WARN family default: richness precedes the de-rate it warns of; the coincident half is
supplied by the GT gate inside the scorer, so the member itself stays `lead`.

## TC.R5

VIX — its row: "coincident vol, a confirmer behind the sector's own semis reads"

## TC.VT

VIX term structure — same sentence on its own row

## TC.F16

The euro-area vol index — the EU sibling of R5/VT

## TC.FXH

haven FX bid — a live risk-off flow read

## TC.DISP

its row: "the extant work measures CONTEMPORANEOUS fragility"

## TC.CG

copper/gold — "a growth-cycle read", country-level prediction at 3–12m (its row)

## TC.F9

broad USD — damage arrives through translation over reporting quarters

## TC.GT

ACWI trend break — confirms a move already made

## TC.GB

global breadth loss — "mirrors trend"

## TC.F5

QQQ/QQQE breadth — a breadth-loss confirmer, mirrors trend

## TC.F4

SMH — its row: "coincident momentum, duplicative of the leg's full-weight F6 trend gate"

## TC.F6

`coin` (2026-09-02 E4; was `lead`) — the lead ground is FALSIFIED: the velocity leg fails OOS
(measured 2026-09-02, offline measurement); an MA200 level break prints stress as it happens, F1/F4's ground.

## TC.KBE_RS

`coin` ([USER] 2026-09-24, eufin-top5 Q9) — F6 precedent: a rel-strength MA break prints stress as it happens.

## TC.INS_RS

`coin` ([USER] 2026-10-08) — KBE_RS precedent: a rel-strength MA break prints stress as it happens.

## TC.EXSH_GATE

`coin` — inherited from EXSH_RS ([USER] 2026-09-24, eufin-top5 Q9, F6 precedent) when EXSH_GATE replaced it
2026-10-06: all three checks are coincident crosses on the held fund.

## TC.F8

MU — its row: "SOFT confirming weight off `Semis`"

## TC.G1

WTI spike — the price shock IS the event

## TC.BRENT

Brent — same shock, second contract

## TC.OVX

crude implied vol — realized-now vol, the R5/VT class

## TC.price-accel

parabolic — a pre-snap-back warning, fires before the damage

## TC.complacency-vix

low VIX — a pre-stress complacency warning

## TC.complacency-high

highs + narrow leadership — a pre-top warning

## TC.complacency-duration

stretched calm — a mild broad pre-stress warning

## TC.NVDA

single-name % vs MA200 — a price level, coincident

## TC.DB_SMH

downside break — a realized price break, the F4 class (inert member, still classed)

## TC.F1 — HY OAS

HY OAS — realized spread level; the lead lives in EBP (GZ 2012), stocks lead bonds (Kwan 1996).
STAYS `coin`, re-grounded 2026-08-05 by Stage 6.0's literature audit:
the predictive content
of a corporate credit spread sits in the EXCESS BOND PREMIUM residual, which this repo already seats
separately as `EBP: "lead"` — classing the raw index `lead` too would double-count the one component
that carries the lead. Neither cited source supports `lead` for a realized spread level.

## TC.F11 — USD/CNY

USD/CNY — a daily spot-FX RORO price; F9's translation-lag mechanism does not transfer (F9's `lag`
is an earnings-translation, reporting-quarter channel a daily spot price does not have).

**MOVED `lag` → `coin` 2026-08-05** by Stage 6.0's audit:
CNY moves WITH or
slightly BEFORE the equity drawdown, never after.
⚠ `lead` was CONSIDERED AND REFUSED: two devaluation episodes are an event narrative, not a
lead-time estimate, and a managed float can be smoothed by the PBOC, which cuts the other way. The
evidence establishes "not lagging" far more strongly than it establishes a lead, so the class stops
at `coin`.

## TC.F17 — USD/JPY

F17 `coin` — F11's ground, not F9's: a daily spot-FX price prints stress as it happens; F9's `lag` is
an earnings-translation (reporting-quarter) mechanism a spot price does not have. Minted 2026-08-10.

## TC.SPCONC — SPY/RSP concentration

Row label, evacuated 2026-08-08: concentration at a 12-mo high, and the drawdown leads it
(k = −20/−60)

SPCONC SPY/RSP concentration — `lag` STANDS, but on a NEW ground; the audit's move is RETRACTED.
(1) The ORIGINAL ground is WITHDRAWN: it read `MEMBER_WEIGHT.SPCONC`'s engine parenthetical
("CONTEXT/gatedTrend-only … ramped trend term") as a timing claim. That sentence says what
`gatedTrend` permits a `uT` member to DO to a leg, not when the indicator prints — `F6` sits under
the identical restriction and is `lead`. Not a timing ground; do not re-cite it.
(2) Stage 6.0's audit MOVED it `lag` → `lead` on 2026-08-05; that move is **RETRACTED** on its
surviving EMPIRICALLY-BACKWARDS ground: the audit's own cited source measures the drawdown LEADING
the concentration read (k = −20/−60) — a lagging property.
⛔ The former STRUCTURALLY-INERT / "no RED arm" ground is VOID since an earlier commit gave F5/SPCONC a
dynamic percentile band that CAN red (`severityOf` RED→`lit` now fires for them); do not re-cite it.

⛔ The audit's rule "a placebo-surviving forward-return effect is a leading property by definition"
is REFUTED by that same plan, which attributes such forward-return gaps to regime clustering. Do
not re-use it here or on `F5` (SPCONC's exact twin, also `lag`).
*(Both prohibitions are KEPT inline in the `.ts`, re-wrapped.)*

---

# Other `src/danger-ladder.ts` provenance

Evacuated 2026-08-08: narrative from the file's non-table constants. The `.ts` keeps the directive and the
compiler-invisible invariant at each seam and points here for the rest.

## DIAL_FAMILIES — the rejected relocation to `families.ts`

The relocation was deliberately NOT taken — it churns this file's consumers for no structural gain
(CORE-9 §0.5 put it out of scope). Open follow-up, not a constraint.

## RERISK_CONFIRM — the superseded grounds for the prior value 2

The prior value 2 argued the
regime-persistence asymmetry (arXiv 2402.05272) — **that reasoning is superseded, not merely
re-tuned.**

## RERISK_DWELL_DAYS — the superseded grounds for the prior value 3

The prior value 3 was RATIFIED [USER] 2026-07-23 off a
no-trade-region / whipsaw-literature argument for a 2–5-close band; **that ratification is superseded
by the later ruling, not overridden by accident**.
