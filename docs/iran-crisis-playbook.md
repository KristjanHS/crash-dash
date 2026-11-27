# Iran-conflict crisis playbook — asset map + stage ladder

**Status:** LIVE reference (user-facing strategy aid). Not a plan — nothing here is open work.
**Origin:** extracted 2026-08-05 from the Iran-crisis prep plan, whose
§1/§3 this replaces verbatim-then-corrected.
**Cited by:** `config.json` `_crisisStage_comment` — the §Stage ladder below is the definition of what
`crisisStage` 0–4 means.

## Asset impact map — 9 legs + bonds + gold

Historical anchors: 1973-74 (oil 4x, S&P -48%, gold +130%), 1979-80, 1990 Gulf (S&P -20%, full recovery
6m — the one *disinflationary* case where long bonds rallied), 2022 Russia (XLE +59%, long bonds -31%,
EUR< parity), Jun-2025 12-day war (round-trip in 30 sessions), and the live 2026 episode (S&P -8% → ATH in
50 days → relapsing at $100 oil).

| Rung | Leg | Expected in Hormuz-shock | Notes (EUR investor) |
|---|---|---|---|
| 1 | Global Semis (`SEC0.DE`/SMH) | **Worst leg: -15…-35%** | Highest beta + rate-sensitive (real yields rise in inflation shock). USD cushion softens EUR-terms only partially. |
| 2 | S&P 500 IT (`QDVE.DE`) | **-12…-28%** | Same mechanics, slightly less extreme. |
| 3 | EM IMI (`IS3N.DE`) | **-10…-20%, bifurcated** | Gulf oil exporters (~8% of index) gain; India/China/Korea/Taiwan (importers + tech) lose. Net negative. |
| 4 | World Value (`XDEV.DE`) | **Mild negative to flat** — best *core* relative hold | Energy/financials overweight is the offset (2022: Value ≈ -6% vs World -18%). |
| 5 | S&P 500 (`SPYL.DE`) | **-8…-20%**, recovers if no recession | A USD rally shrinks the EUR-terms drawdown; the old "~3-8pp" estimate was struck 2026-08-05 as underived — same class as rows 8/9. |
| 6 | World ex-US (`CHSI.DE`) | **Worse than S&P** | Europe/Japan are oil *importers*: terms-of-trade + currency double hit; no USD cushion on the EUR-zone slice. |
| 7 | High Div (`VHYD.L`-scored) | **-3…-10%, defensive-relative** | Energy/utility/staples tilt; dividend factor outperformed 1973-74 and 2022. |
| 8 | S&P 500 Health Care (`QDVG.DE`) | **Strong relative hold — unquantified** | ~100% US underlying, **unhedged**: the EUR-terms outcome is FX-dominated and cuts both ways. |
| 9 | S&P U.S. Consumer Staples (`ZPDS.DE`) | **Least-bad equity leg — unquantified** | Margin squeeze from input costs caps it, but least-bad sector 1973-74 after energy. ~100% US underlying, unhedged — same FX caveat as rung 8. |

**Rows 8/9 carry no drawdown band by decision (`[USER]` 2026-08-05).** The `-3…-8%` / `-2…-8%` bands and the
"~65% USD exposure = FX cushion" rationale that stood here until 2026-08-05 were derived for the **old global
MSCI World** sector sleeves (`XDWH.DE` / `XDWS.DE`), not the US-only unhedged funds that replaced them
(the 2026-08-02 ticker swap). Rather than carry unmeasured numbers under
new instruments, the cells keep only the **relative ordering** the playbook actually relies on — staples ≥
health ≥ high-div in relative terms — and state the FX channel qualitatively. Re-deriving measured bands was
considered and declined; do not reinstate the old figures.

**Beyond the ladder — PIK-selected instruments (user 2026-07-24; LHV PIK has hundreds more):**
gold `XGDU` · 0-1y govt `EUN6`, `PRAB` · World Value `XDEV` (= rung 4) · High Div `VGWE` (= rung 7 card) ·
EUR HY corporate `XHYA` · cash · crypto.

| Asset | Expected | Verdict |
|---|---|---|
| **Gold ETC — `XGDU`** | **Positive in EVERY episode of this family** (1973-74 +130%, 1990 +10%, 2022 +6% EUR-terms, 2026 held gains) | **The crisis diversifier for this shock type.** EUR-gold gains extra when USD rallies. |
| **Short EUR govt bonds (0-1y) — `EUN6` / `PRAB`** | ~Flat to +1-2% | Safe parking; the correct "bond" in an *inflationary* shock. 0-1y is even better than 0-3y here — near-zero duration risk. |
| **Long EUR govt bonds (7-10y+)** | **DANGEROUS** — 1973/79/2022/2026 pattern: yields *rise* (long Bund -17% in 2022; ECB priced to HIKE) | Only helps in a 1990-style demand-destruction recession. Do NOT treat "govt bonds" as one asset — duration is the whole call. |
| **EUR HY corporate bonds — `XHYA`** | **NOT defensive — equity-lite.** HY spreads widen exactly when Stage 2 fires (2022: EUR HY ~-11%); it's the asset class behind regime-discriminator F1 | Fine in Calm as a carry hold; **exit alongside equities, never rotate INTO it as "bonds" in a crisis.** |
| **Energy equities** (not a leg) | **Clear winner** (XLE +59% 2022; only positive sector 1973-74) | Not in the ladder or PIK plan — noted for completeness. |
| **Cash EUR** | Nominal-safe, real erosion (~-12%/yr real in 1973) | High optionality value; fine as a short-dwell stop. |
| **Crypto** | No reliable crisis hedge record — traded as risk-on beta in 2022 | Not a defensive asset for this playbook. |

**Near-unaffected / positive set (the "where to go when it gets serious" answer):**
**gold ETC > short-duration EUR govt bonds > staples (rung 9) / health (rung 8) / high-div (rung 7)**,
with **World Value (rung 4)** the best mid-ladder hold. The ladder's own defensive band already points the
right way; the *additions* the ladder can't express are **gold (`XGDU`) and 0-1y bonds (`EUN6`/`PRAB`)** —
both already PIK-selected. Two traps: fleeing to **long**-duration bonds out of 2008-era instinct (this is
the crisis family where they lose), and mistaking **`XHYA` for a bond refuge** (high-yield credit sells off
*with* equities — it is the widening leg of the F1 signal, not a shelter from it).

## Stage ladder — steps on signs

**`config.json` `crisisStage` records the DECLARED stages only (2, plus 4 to start a wind-down; a
committed 1 or 3 throws at load, `src/geo.ts` — declared 3 merged into 2, A2 2026-08-15)** — the machine
scores the mechanical transitions itself: 0→1
arm, 1→0 stand-down and the declared-4→0 release run off the four stage ids + the persisted
`geoCalmStreak` dwell (`escalatorFloorBreakdown`, `src/alert-band.ts`; a declared 2 overrides the
machine). Read the live stage off `/api/lab`'s geo basis, never a stage number quoted in this file; the
descriptions below are the standing ladder. Only **→ 0 changes the band** once no manual flag is up
(`STAGE_TO_FLAGS` against a geo floor capped at WARNING): 1 and 4 are both +1, 2 is +2 — the machine's
release dwell is the "real read of all four stage-4 ids" a 4 → 0 move owes; the rungs
above it are posture, not band.

Framing: the dial (T1) stays the single authority for *equity-rung* moves. This playbook adds the two
assets the ladder can't express (gold, short bonds) and pins WHICH signs justify each step. Stagflation
twist throughout: "safety" = short duration + gold, NOT long bonds.

⚠ **Every trigger below is a LIVE dashboard read.** Stages 1 and 4 formerly also quoted Polymarket
closure-odds and IMF PortWatch Hormuz transit counts. Both are gone (`[USER]` 2026-08-05): the Polymarket
leg was removed outright, and PortWatch was ruled CLOSED and never built. Keeping unfeedable members in a
quorum understated how strict the real test was, so both stages are restated over what the dashboard can
actually score. See `docs/iran-crisis-playbook.md` §Standing rules for what this costs.

⚠ **Two kinds of number appear below.** A **shipped cut** is cited by SYMBOL only (`BRENT_RED_ROC`,
`BRENT_DESCRIPTOR`'s `levelWindow`, T5YIFR's cuts, OVX's `registry.ts` thresholds) — never restated, so a retune cannot
falsify this page. **The same discipline binds a scorer's COMBINE MODE**: never write "OR" or "AND" about a
shipped scorer here — name the members and let the descriptor say how they combine, so a mode flip
costs no edit to this page. The only remaining **hand-set posture markers** are the gold sizes `~5-10%` /
`~15-20%`: judgement aids with no constant behind them. Don't go looking for one — every stage criterion
below is now scored on shipped bands (restated 2026-08-15).

**Stage 0 — baseline calm: Stage 4's condition has held `DE_ESCALATION_DAYS` further scored closes**
(symbol in `alert-band.ts`; each GREEN already stands on the confirmation fold, so this dwells on top).
- The ladder's ONE band-moving step (§Stage ladder lead): with no manual flag up it takes the geo base to
  0, releasing the geo floor from WATCH to OK. Authored 2026-08-14 — stage 0 previously had no entry test.
- No panic move justified: equities are not pricing systemic crisis; Jun-2025 and Jun-2026 both round-tripped.
- Do: hold per dial; instruments verified ✅ (`XGDU` gold, `EUN6`/`PRAB` 0-1y govt). If holding `XHYA`, note
  it exits WITH equities at Stage 2, not into.

**Stage 1 — WATCH: any of `G1`, `OVX`, `BRENT`, `T5YIFR` confirmed AMBER-or-worse on its shipped band.**
- Exact complement of Stage 4's "all four GREEN" — entry and exit are inverses of one measurement, so a
  retune moves both together (restated 2026-08-15; the old joint test fired on 0.90% of days, a top-1%
  event as the lowest rung, and a flat-but-extreme oil level never fired it — `BRENT_DESCRIPTOR`'s
  trailing-peak gate now covers that).
- Hysteresis is deliberately asymmetric: re-arming is one confirmed print; standing down costs Stage 0's
  `DE_ESCALATION_DAYS` dwell on top. Re-arm fast, stand down slow.
- Equities: let the dial walk down the ladder (rungs 7-9 territory as it scores).
- New: open a **gold starter position (~5-10%, `XGDU`)**; stop new money into rungs 1-2 and `XHYA`.

**Stage 2 — SERIOUS (ALL of): `BRENT` confirmed RED · `R5` or `F16` confirmed RED · `T5YIFR` confirmed
RED — each on its shipped band.**
- Restated 2026-08-15: the hand-typed `$110` fired on 12.4% of days — looser than the rung below it — and
  `VIX/EU-vol >28` was unsatisfiable as a ratio and a third hand-typed vol cut as a level. No dwell number
  here: confirmation is the fold (§Standing rules).
- Equity sleeve fully in the defensive band (7-9), tilted staples/health/high-div; Value if mid-ladder
  exposure retained.
- **Gold (`XGDU`) to ~15-20%; free cash into 0-1y govt (`EUN6`/`PRAB`); exit `XHYA` if held.** Explicitly
  do NOT buy long duration here.
- Expect ECB hikes, not cuts — don't wait for a central-bank rescue of bond prices.

**Within Stage 2 — the RECESSION-TRANSMISSION pivot (formerly declared Stage 3; merged 2026-08-15, A2:
both mapped +2, so the second declared rung bought a second criteria set + redeploy for zero band effect).
Signs, ALL of: F1's trailing-low widening (`lowRise` block, window `F1_LOW_RISE_WINDOW`) at or above
`F1_LOW_RISE_AMBER` · `T5YIFR` back under its shipped AMBER cut having printed RED during the current
declared crisis · `BRENT` confirmed GREEN.** A posture pivot inside the declared 2 — no config edit, no
band move.
- The widening leg is `displayOnly` — persisted daily and served on `/api/series?id=F1` (`decision`), never
  scored, so it carries no confirmed state: read the served value against the cut symbol, like the flag list.
- The last two are the testable spellings of "breakevens rolling over" and "oil falling from its peak" —
  both already computed. Restated 2026-08-15; before that two of three legs named no threshold at all.
- **A transition, not an escalation**: this pivot wants oil off its peak while Stage 2's entry wants it
  extreme — a different regime, not a worse one.
- This is the 1990-pattern pivot: inflation shock → demand destruction. NOW long(er) duration starts
  working: extend bond duration stepwise; gold typically still holds.
- Equity re-entry: only on the dial's own re-risk path (dwell rules), not on headlines.

**Stage 4 — DE-ESCALATION (ALL of): `G1`, `OVX`, `BRENT` and `T5YIFR` confirmed GREEN on their shipped
bands.**
- No number lives here by design (restated 2026-08-14) — the four ids ARE the test, scored on their own
  `registry.ts` cuts, so a retune moves Stage 1's entry and this exit together. Read off `/api/lab`.
- Replaces the hand-set `OVX <35` + `Brent 20d ROC ≤ 0` pair, which measured mean reversion, not the event:
  it cleared 42–440 days after each OVX spike since 2007 and fired on 10.5% of ALL days, mostly plain calm.
- **The T5YIFR member is not optional decoration** — it is what keeps this stage compliant with §Standing
  rules below: price alone would re-risk the book on an oil round-trip with expectations still de-anchored.
- Unwind gold overweight gradually (it round-trips fast: Jun-2025 gave back its spike in ~30 days);
  re-risk per dial. The short-bond sleeve unwinds **last**, after T5YIFR has held GREEN.

## Standing rules

- Every criterion above is read off **confirmed** states — `deriveConfirmedState`'s fold IS the dwell (no
  per-stage close counts; the Jun-2025 lesson is that single-day geopolitical spikes mean-revert).
- Never act on ONE indicator class alone: **price (oil/OVX) + regime (breakevens/HY) must agree for stages
  ≥2.** This dropped from three classes to two on 2026-08-05: the **physical channel (Hormuz transits) has
  no feed and never will under the current rulings**, so it is a human news read that informs judgement and
  never a scored gate. Requiring a class the dashboard cannot observe made the rule unsatisfiable as written.
- The enemy in the PIK is idle cash (rotation-account memory) — stages park money in gold/short-bonds,
  not cash, except as a brief transit stop.
