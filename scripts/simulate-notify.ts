/**
 * On-demand notify eye-check harness — drives the REAL Slice-3 notify path.
 *
 * WHY: production derives the ntfy band from the T1 dial. On a
 * live calm feed nothing elevated ever
 * renders, so the escalated notify copy (the `Dial: <regime> (rung N/9)` line,
 * the guidance band, the escalator/de-escalation-lag composition) can't be
 * eyeballed. This synthesizes indicator STATES engineered to trip each band and
 * runs the production chain:
 *
 *   synthetic states → computeFamilyPanel → computeT1Dial → computeAlertBand
 *                    → buildNotification(dial) → pushNtfy
 *
 * Only the feed-derived states are simulated — the family panel, the dial, the
 * band composition, the notification copy, and the HTTP push are all the exact
 * production code paths (mirrors `run-core.ts` `assembleRun` + `run-cycle-push.ts`).
 *
 * Usage:
 *   npm run sim:notify -- all                 # print body for every scenario (DRY default)
 *   npm run sim:notify -- all --quiet         # one line per scenario, same assertions (`npm run check`)
 *   npm run sim:notify -- dial-warning        # one scenario
 *   npm run sim:notify -- all --push          # actually POST to ntfy (real notification)
 *   npm run sim:notify -- all --push --topic my-test-topic
 *
 * The push goes to NTFY_TOPIC (env) or the dev default — NOT the private prod
 * phone topic unless you set NTFY_TOPIC (the off-prod-topic guard still
 * applies). Override per-run with --topic <name>. Run under
 * `tsx --env-file-if-exists=.env.local` (the npm script wires this) so the env
 * mirrors `npm start` — i.e. a local "review-prod" run.
 */

import { ALL_INDICATORS } from "../src/registry.js";
import { type Indicator, type Reading, type State } from "../src/domain-types.js";
import { ALERT_RANK, type AlertLevel } from "../src/ladder.js";
import { computeFamilyPanel } from "../src/families.js";
import { DIAL_FAMILIES } from "../src/dial-assembly.js";
import { computeT1Dial } from "../src/t1dial.js";
import { computeAlertBand, regimeToBand, DE_ESCALATION_DAYS } from "../src/alert-band.js";
import { buildNotification, NOTIFY_ANCHOR_IDS } from "../src/notify_format.js";
import { pushNtfy, ntfyTopic } from "../src/ntfy.js";
import { computeCashOverlay } from "../src/cash-overlay.js";
import { R4_EXIT_HY, R4_HY_TAIL, type R4Phase } from "../src/r4.js";
import type { AlertRecord } from "../src/store.js";
import { dashboardUrl, ntfyPushEnabled, readEnv, type Env } from "../src/config.js";
import { withConfigAlias } from "./lib/prod-base-url.js";

// --- synthetic-reading helper ---------------------------------------------

const ASOF = "2026-07-13";

/** A cut pair to place a synthetic magnitude against, read off the indicator's OWN config —
 *  never a hand-typed number, so a retune moves this harness's output without editing this file
 *  (`indicator-loop.md` §A retune is a ONE-place edit).
 *
 *  LEVEL axis: the registry level cuts ONLY. There is deliberately NO fallback to the
 *  detail-chart `derived` band, because the two are in different units: production's
 *  `buildReadings` (`scorers-core.ts`) sets `level` to the PLOTTED SERIES VALUE and puts the
 *  derived transform on the separate `decision` field, and `formatReading`
 *  (`notify_format.ts`) prints `level` and never reads `decision`. So for a derived-band id
 *  (F4/F6/F8/F13/G1/BRENT/CG/GT — the bespoke price scorers, which carry no level cut) the
 *  printed number is a PRICE with no static config anchor: it is NOT synthesizable here, and a
 *  derived-band number placed on `level` would render a wrong-unit falsehood (`WTI: 0.30` where
 *  production prints ~68). Such an id therefore takes an explicit scenario `levels` entry, or
 *  `synth` throws (see the printable guard there).
 *  DECISION axis: the `derived` band — placed on `decision`, the field production puts it on.
 *  Nothing on the notify path reads `decision` today, so it is output-inert; it exists so the
 *  fixture's shape matches production's rather than quietly diverging from it.
 *  VELOCITY axis: the registry velocity cuts.
 *  A half pair (one bound absent, e.g. NVDA's null red) is not usable and yields null — except a
 *  LEVEL axis carrying a red cut and no amber, which synthesizes its amber edge (see `levelBand`).
 *
 *  ⚠ Ids on the `synthPriors` / calibration seams (F3, F11 — F9 left 2026-08-08) resolve their LIVE cuts at runtime
 *  from their own stored history (`CALIB_MAP`, `domain-cuts.ts`); there is no static offline cut
 *  available here, so they fall back to the registry pair — which is only the degrade fallback.
 *  The number stays coherent with the fixture's state, but it is not their live cut. */
type Band = { amber: number; red: number };
const pair = (amber?: number | null, red?: number | null): Band | null =>
  typeof amber === "number" && typeof red === "number" ? { amber, red } : null;

function levelBand(indicator: Indicator): Band | null {
  // Canonical read (domain-types.ts): `rawThresholds ?? thresholds` — the pre-multiplier pair
  // where the earliness multiplier stamped one, the live pair otherwise.
  // ⚠ DEAD BRANCH TODAY: no shipped indicator carries `rawThresholds` (nothing stamps an
  // earliness multiplier — `withMultipliedThresholds` is identity at the current settings), so
  // this always reads `thresholds`. If a multiplier is ever stamped, the branch wakes up and this
  // harness places against the PRE-multiplier pair: a GREEN then sits at `rawAmber − step`, which
  // can be on the WRONG side of the live post-multiplier amber (an earlier amber pulls the cut
  // toward the GREEN placement). Re-read this pair choice at that point — the fix is to place
  // against `thresholds` and keep `rawThresholds` only for the documented pre-multiplier trace.
  const t = indicator.rawThresholds ?? indicator.thresholds;
  const both = pair(t.amberLevel, t.redLevel);
  if (both) return both;
  // RED-ONLY level axis (R1 since 2026-08-30, `registry-fred.ts`): the amber leg was retired
  // because it is REGIME-RELATIVE (the armed rung / the always-on drawdown leg), so no absolute
  // amber cut exists to place against — but the red cut does, in the printed unit, and R1 is a
  // `NOTIFY_ANCHOR_IDS` anchor so it is printable on EVERY scenario. Synthesize the missing edge
  // one step off the red cut, the same derivation `place` already uses for a zero-width band (a
  // fifth of the cut's own magnitude, floored at 1 unit so a red cut OF zero still spans). Polarity
  // comes from `direction`, not from the pair, because a one-sided band cannot express it. This
  // restates NO cut: move `redLevel` and every placement here moves with it.
  if (typeof t.redLevel !== "number") return null;
  const sign = indicator.direction === "LOW" ? -1 : 1; // sign of "worse"
  return { amber: t.redLevel - sign * (Math.max(Math.abs(t.redLevel), 1) / 5), red: t.redLevel };
}

function velocityBand(indicator: Indicator): Band | null {
  const t = indicator.rawThresholds ?? indicator.thresholds;
  return pair(t.amberVelocity, t.redVelocity);
}

/** The DECISION-variable band (detail-chart `derived`) — decision-variable units, NOT the units
 *  the body prints. Placed on `Reading.decision`, exactly where production puts it. */
function decisionBand(indicator: Indicator): Band | null {
  return pair(indicator.derived?.amber, indicator.derived?.red);
}

/** Place a magnitude for `state` against a cut pair: GREEN outside amber, AMBER between the two,
 *  RED past red. Polarity comes from the pair itself — RED's side IS the dangerous side — which is
 *  `direction` (domain-legs.ts `evaluateLegs`: a LOW id flips the level comparison) expressed once
 *  and read the same way for the descending bands (F4's -0.15/-0.25 return, R1's synthesized-amber/0 spread) as
 *  for the ordinary highward ones. The offset is HALF the amber→red gap: derived from the cuts,
 *  clear of both, and never a second statement of either. A zero-width band falls back to a tenth
 *  of the cut's own magnitude — still derived. */
function place(band: Band, state: State): number {
  const { amber, red } = band;
  const gap = Math.abs(red - amber);
  const step = (gap > 0 ? gap : Math.max(Math.abs(red), 1) / 5) / 2;
  const sign = red >= amber ? 1 : -1; // sign of "worse"
  if (state === "RED") return red + sign * step;
  if (state === "AMBER") return (amber + red) / 2;
  return amber - sign * step;
}

/** Stamp a chosen confirmed state onto every real indicator config (default GREEN).
 *  The dial reads confirmed STATES off the family panel; `escalatorFloor` /
 *  `buildNotification` read full `Reading` objects — so ONE
 *  `Reading[]` feeds the panel, the escalators, and the body. The
 *  scoring math (feed → state) is already unit-tested; this harness's job is the
 *  notify path, so states are set directly, not re-derived from synthetic feeds.
 *
 *  The MAGNITUDES are derived from the state, because the body PRINTS them
 *  (`notify_format.ts` `formatReading`) and a flat `level: 0` rendered a number the fixture never
 *  set — a false `HY OAS: 0.00%` on every body (E8 item 3). Each axis is filled INDEPENDENTLY from
 *  its own band: `level` from the level cuts, `delta20` from the velocity cuts, `decision` from the
 *  `derived` band — so any id carrying a VELOCITY band prints a state-coherent 30d Δ instead of a
 *  fabricated `+0.00`. That is the dual-axis set (F1/F2/F10/F11/T10YIE/T5YIFR) plus
 *  **F9, which is velocity-ONLY since 2026-08-07** — it has a velocity band and NO level band, so it
 *  sits in neither bucket named here and takes its printed level from `SPOT` below.
 *  An axis whose band is absent stays 0/null:
 *  a level-only id (R1/R5/F3/EBP/R6/OVX) prints `Δ +0.00`, which is an unremarkable rounded
 *  reading rather than an impossible one — the harness does not invent a move the config can't
 *  place. `levels` supplies the level for the two cases that cannot be derived: an id whose PRINTED
 *  unit has no config anchor (a derived-band price id — see `levelBand`) and a scenario whose point
 *  is a magnitude the cuts can't express (the r4 tail — see `r4-cash`).
 *
 *  GUARD: every PRINTABLE reading must carry a real level. Printable = any non-GREEN driver plus
 *  the three `NOTIFY_ANCHOR_IDS` anchors (`compactBodyBlock`, notify_format.ts). If such an id has
 *  no level band and no `levels` entry, this THROWS rather than reprinting the `0.00` that E8 item
 *  3 removed — the ~24 band-less ids (R7, VT, F7, EURC, …) are one careless scenario override away
 *  from that, and the guard is what keeps the claim "no printable id lands in the no-band branch"
 *  true by construction instead of by today's scenario list. */
function synth(overrides: Record<string, State>, levels: Record<string, number> = {}): Reading[] {
  return ALL_INDICATORS.map((indicator) => {
    const state = overrides[indicator.id] ?? "GREEN";
    const lvl = levelBand(indicator);
    const vel = velocityBand(indicator);
    const dec = decisionBand(indicator);
    const explicit = levels[indicator.id];
    const printable = state !== "GREEN" || (NOTIFY_ANCHOR_IDS as readonly string[]).includes(indicator.id);
    if (printable && explicit === undefined && !lvl) {
      throw new Error(
        `synth: ${indicator.id} is printable (state ${state}) but has no level band and no \`levels\` entry — ` +
          `its printed level would be a false 0.00. Add a \`levels: { ${indicator.id}: … }\` entry to the scenario ` +
          `(a derived band is in decision-variable units and must NOT be used as the level).`,
      );
    }
    const level = explicit ?? (lvl ? place(lvl, state) : 0);
    const delta20 = vel ? place(vel, state) : 0;
    const decision = dec ? place(dec, state) : null;
    return { indicator, date: ASOF, level, delta20, rawState: state, state, decision };
  });
}

/** Standing spot magnitudes for the DERIVED-band ids a scenario drives non-GREEN. Their printed
 *  `level` is the plotted PRICE (production: `buildReadings` — the derived band lives on `decision`
 *  in decision-variable units), and no config carries a price, so there is nothing to derive these
 *  from: they are hand-picked, units-correct standing values, deliberately round.
 *  They restate NO cut — a retune of any threshold cannot touch them — and they carry NO state: the
 *  state comes from the scenario override, and these only stop the body printing an impossible
 *  `WTI: 0.00`. They are illustrative, not a claim about today's tape. */
const SPOT = {
  G1: 68, // WTI, $/bbl
  F4: 250, // SMH, $/share
  // F9 joined 2026-08-07 for the SAME reason, by a different route: its LEVEL axis was retired
  // so `levelBand(F9)` is now undefined and
  // a scenario driving it RED would print a false `Broad USD: 0.00`. USDU (WisdomTree USD Bullish
  // ETF, F9's feed since 2026-08-10) trades around $30/share, so 30 is the round, units-correct
  // standing value. It restates NO cut — F9's surviving cuts are velocity-only and live in
  // `registry.ts` alone.
  F9: 30, // USDU, $/share
} as const;

// --- scenarios -------------------------------------------------------------
//
// Leading families select the band: credit = F1,F2,EBP · rates =
// R1,R2,R3,R4,R7,EURC. The `expectBand` oracles below are pinned to the NOTIFY axis
// (`NOTIFY_REGIME_CUTS`, families.ts — W3-c), NOT the dial/display cuts. Since the
// W3-c §6 ruling those cuts are RUNG boundaries — Calm below rung 3 · Caution 3–5 ·
// Stress 5–7 · Crisis ≥7 — which still coincide numerically with the dial's quartiles
// (.25/.5/.75), so no row moved. If a future ruling MOVES a rung, re-trace every row
// against `NOTIFY_REGIME_CUTS`. The traced dial/band per row is the
// expected-output oracle — verify by running (see the plan's verification gate);
// if a trace is off, the mechanism (or the cut assumption) is what to check,
// and the fix is the scenario override, NEVER the production code.

interface Scenario {
  key: string;
  title: string;
  overrides: Record<string, State>;
  // Per-id LEVEL override, for the rare scenario whose point is a magnitude a cut-derived level
  // can't express (the r4 tail). Everything else takes the state-derived level from `synth`.
  levels?: Record<string, number>;
  expectBand: AlertLevel; // the composed band this scenario must resolve to (pins the cut/floor trace)
  recentDialBands?: AlertLevel[]; // default []
  r4Phase?: R4Phase; // default "equity"
  // Auto-GEO stage walk (2026-08-15): declared crisisStage {0,2,3,4} and the persisted calm streak.
  // Absent ⇒ engine defaults (stage 0, streak = DE_ESCALATION_DAYS = calm) — pre-walk scenarios unchanged.
  crisisStage?: number;
  geoCalmStreak?: number;
  // Auto-hold state handed to buildNotification (i7a) — same shape as run-core.ts's live hold.
  hold?: { held: string; dialSleeve: string; override: boolean; prevHeld: string | null; changed: boolean };
  note: string;
}

const SCENARIOS: Scenario[] = [
  {
    key: "dial-watch",
    title: "T1 dial alone lifts OK → WATCH",
    overrides: { F1: "AMBER" },
    expectBand: "WATCH",
    note: "ONE shallow ARM leader (credit AMBER) armed, unfired ⇒ L=1, lo=4, positionP 0 ⇒ rung 4 (Caution) → band WATCH. Was {F1,R1} AMBER pre-DEC-B3; under breadth-only selection TWO firing leaders are FULL ARM breadth ⇒ lo=7 ⇒ WARNING, so this scenario's purpose (the dial alone reaching WATCH) now needs a single leader",
  },
  {
    key: "dial-warning",
    title: "a deep dial leader → WARNING",
    overrides: { R1: "RED" },
    expectBand: "WARNING",
    note: "one deep ARM leader (rates RED) armed, unfired ⇒ L=1, lo=4, leadingP 1 ⇒ pre-cap rung 6, clipped to ARMED_UNFIRED_CAP (5) (Stress) → band WARNING (W2-b: the cap now binds; rung 5 still maps to WARNING)",
  },
  {
    key: "armed-unfired-cap",
    title: "two RED ARM leaders, no FIRE family firing → capped WARNING (ARMED_UNFIRED_CAP)",
    overrides: { F3: "RED", R1: "RED" },
    expectBand: "WARNING",
    note: "credit (via F3, a non-F1/F2 member ⇒ no CRITICAL credit floor) + rates both RED ⇒ L=2, lo=7, pre-cap rung 9, but NO FIRE family fires ⇒ ARMED_UNFIRED_CAP pulls rung to 5 (Stress) → band WARNING (the two-key cap, unmasked by any escalator)",
  },
  {
    key: "credit-unfired",
    title: "credit escalator, ONE key (F1 RED, no FIRE family firing)",
    overrides: { F1: "RED" },
    expectBand: "WARNING",
    note: "F1 confirmed RED ⇒ credit family RED ⇒ armed, but NO FIRE family fires ⇒ one key only. THE W3-d delta scenario: pre-gate the credit escalator floored CRITICAL here; post-gate it degrades to CREDIT_UNFIRED_FLOOR=WARNING, which is exactly the band the dial itself already reaches (armed+unfired, capped at ARMED_UNFIRED_CAP ⇒ Stress). Floor and dial now agree",
  },
  {
    key: "credit-fired",
    title: "credit escalator, BOTH keys (F1 RED + volatility RED)",
    overrides: { F1: "RED", R5: "RED" },
    expectBand: "CRITICAL",
    note: "F1 RED (credit armed) AND R5 RED (volatility fired) ⇒ both keys ⇒ CRITICAL must survive W3-d. Unlike dial-critical (whose dial is already Crisis), the credit floor is load-bearing here rather than masked",
  },
  {
    key: "credit-fired-amber",
    title: "credit escalator, second key turned by an AMBER coincident (the real `fired` boundary)",
    overrides: { F1: "RED", R5: "AMBER" },
    expectBand: "CRITICAL",
    note: "PINS THE ACTUAL BAR for the second key: `fired` = any coincident family firing, and `firing` is state !== GREEN — so a merely AMBER volatility family turns the key and F1 RED still reaches CRITICAL. Lower bar than 'both RED' prose implies; internally consistent (same definition the dial's own two-key caps use) and strictly less aggressive than pre-gate, but it was unpinned until this scenario — every other fired=true assertion passes the boolean directly or uses RED. Flip R5 to GREEN and this must fall to WARNING (credit-unfired)",
  },
  {
    key: "dial-critical",
    title: "two-key CRITICAL (armed ARM leaders + a firing FIRE family reach rung 9)",
    overrides: { F1: "RED", R1: "RED", R5: "RED" },
    expectBand: "CRITICAL",
    note: "credit + rates RED (armed, L=2, lo=7, leadingP 1) AND volatility RED via R5 (fired) ⇒ caps don't bite ⇒ rung 9 (Crisis) → band CRITICAL (belt-and-suspenders with the F1 credit-blowout floor)",
  },
  {
    key: "shock-override",
    title: "unarmed triple-RED coincident shock → WARNING (SHOCK_RUNG)",
    overrides: { R5: "RED", F9: "RED", F4: "RED" },
    // F4: derived-band id (printed level is the SMH price). F9: LEVEL-AXIS-RETIRED id — no level
    // band exists to place it on. Neither is derivable from cuts.
    levels: { F4: SPOT.F4, F9: SPOT.F9 },
    expectBand: "WARNING",
    note: "volatility (R5) + cross-asset (F9) + trend (F4) all live-and-RED, ARM leaders green ⇒ unarmed cap 3, but the shock override lifts rung to SHOCK_RUNG=6 (Stress) → band WARNING (the 2020/2008 vol-shock class credit misses)",
  },
  {
    key: "crisis-gate",
    title: "Crisis label gated: rates-only ARM + deep FIRE set → WARNING, not CRITICAL",
    overrides: { R1: "RED", F4: "RED", F9: "RED" },
    // F4: derived-band id (printed level is the SMH price). F9: LEVEL-AXIS-RETIRED id — no level
    // band exists to place it on. Neither is derivable from cuts.
    levels: { F4: SPOT.F4, F9: SPOT.F9 },
    expectBand: "WARNING",
    note: "rates RED (armed, L=1, lo=4, leadingP 1 ⇒ base 6) + trend/cross-asset RED (fired, xa bump +1) ⇒ rung 7, score 0.75 ⇒ raw Crisis — but credit AND volatility both green ⇒ L1 Stage-5 gate downgrades the label to Stress → band WARNING (pushes can't read CRITICAL without credit or vol non-green)",
  },
  {
    key: "escalator-geo",
    title: "escalator floor bypasses a calm dial (OK → WATCH)",
    overrides: { G1: "AMBER" },
    levels: { G1: SPOT.G1 }, // derived-band id: its printed level is the WTI price, not derivable from cuts
    expectBand: "WATCH",
    note: "G1 is in NO dial family ⇒ dial stays Calm (OK); the GEO floor alone lifts band WATCH",
  },
  // --- auto-GEO stage 0↔1↔4 walk (2026-08-15 plan Stage 4): arm → flare → dwell-hold → stand-down,
  // then the declared-4 release pair. Streaks derive from DE_ESCALATION_DAYS, never a literal.
  {
    key: "geo-stage-arm",
    title: "auto GEO stage arms — one trigger factor flares (OK → WATCH)",
    overrides: { G1: "AMBER" },
    levels: { G1: SPOT.G1 }, // derived-band id: printed level is the WTI price, not derivable from cuts
    geoCalmStreak: 0,
    expectBand: "WATCH",
    note: "G1 AMBER ⇒ litSet 1 factor (oil) ⇒ autoTerm 1 ⇒ geoBase 1 ⇒ WATCH; streak 0 (flare resets it) — the hold addend is 0 while a factor is lit (max, not sum)",
  },
  {
    key: "geo-stage-flare",
    title: "flare widens — second distinct trigger factor (T5YIFR) ⇒ WARNING",
    overrides: { G1: "AMBER", T5YIFR: "AMBER" },
    levels: { G1: SPOT.G1 },
    geoCalmStreak: 0,
    expectBand: "WARNING",
    note: "two DISTINCT geoFactors (oil + infl-exp) ⇒ autoTerm 2 ⇒ geoBase 2 ⇒ geo floor WARNING (its cap); T5YIFR AMBER also nudges the dial to Caution (WATCH) — the floor still lifts one band above it",
  },
  {
    key: "geo-stage-hold",
    title: "all four triggers GREEN, dwell one close short — stage-hold keeps WATCH",
    overrides: {},
    geoCalmStreak: DE_ESCALATION_DAYS - 1,
    expectBand: "WATCH",
    note: "nothing lit (autoTerm's factor count 0) but streak = DE_ESCALATION_DAYS−1 < DE_ESCALATION_DAYS ⇒ heldStage1 ⇒ base 1 ⇒ WATCH — the stand-down assertion that must fail one close short",
  },
  {
    key: "geo-stage-release",
    title: "dwell completes — streak reaches DE_ESCALATION_DAYS ⇒ stand-down to OK",
    overrides: {},
    geoCalmStreak: DE_ESCALATION_DAYS,
    expectBand: "OK",
    note: "streak = DE_ESCALATION_DAYS ⇒ heldStage1 false ⇒ geoBase 0 ⇒ no floor, dial Calm ⇒ OK (re-arm fast, stand down slow: the pair with geo-stage-hold pins the exact dwell boundary)",
  },
  {
    key: "geo-declared4-hold",
    title: "declared stage 4, dwell one close short — +1 held (WATCH)",
    overrides: {},
    crisisStage: 4,
    geoCalmStreak: DE_ESCALATION_DAYS - 1,
    expectBand: "WATCH",
    note: "declared 4 (STAGE_TO_FLAGS[4] = +1) with streak = DE_ESCALATION_DAYS−1 ⇒ declaredTerm still 1 ⇒ WATCH; the auto heldStage1 machine is off (crisisStage ≥ 2 overrides it)",
  },
  {
    key: "geo-declared4-release",
    title: "declared 4 releases at DE_ESCALATION_DAYS calm closes (OK)",
    overrides: {},
    crisisStage: 4,
    geoCalmStreak: DE_ESCALATION_DAYS,
    expectBand: "OK",
    note: "streak = DE_ESCALATION_DAYS releases the declared 4 ⇒ declaredTerm 0 ⇒ geoBase 0 ⇒ OK — config still says 4, the machine's release is what stands the board down",
  },
  {
    key: "hold-band-up",
    title: "band-transition push naming the held sleeve (· hold X)",
    overrides: { F1: "AMBER" }, // single ARM leader ⇒ L=1, lo=4 ⇒ rung 4 (Caution) ⇒ WATCH (DEC-B3)
    expectBand: "WATCH",
    hold: { held: "Value", dialSleeve: "Value", override: false, prevHeld: "EM", changed: true },
    note: "OK → WATCH upward push carries the auto-hold ⇒ summary line ends `· hold Value`",
  },
  {
    key: "hold-only",
    title: "hold-change-only push (band steady — the hold IS the reason)",
    overrides: {},
    expectBand: "OK",
    hold: { held: "Value", dialSleeve: "Value", override: false, prevHeld: "EM", changed: true },
    note: "band OK unchanged, held sleeve rotated EM → Value ⇒ push fires with header `hold changed EM → Value`",
  },
  {
    key: "hold-veto",
    title: "held ABOVE dial sleeve (de-risk lag) — held ≠ dialSleeve (adds the ceiling note)",
    overrides: { F1: "AMBER" }, // single ARM leader ⇒ L=1, lo=4 ⇒ rung 4 (Caution) ⇒ WATCH (DEC-B3)
    expectBand: "WATCH",
    // Value (LADDER rung 4) is MORE defensive than the dial sleeve EM (rung 3) ⇒ held ABOVE ceiling.
    hold: { held: "Value", dialSleeve: "EM", override: true, prevHeld: "EM", changed: true },
    note: "override:true ⇒ body adds `held Value · dial sleeve EM — holding more defensively above the dial ceiling (de-risk lag)` under the dial line",
  },
  {
    key: "hold-below",
    title: "held BELOW dial sleeve (re-risk hold) — held ≠ dialSleeve (adds the ceiling note)",
    overrides: { F1: "AMBER" }, // single ARM leader ⇒ L=1, lo=4 ⇒ rung 4 (Caution) ⇒ WATCH (DEC-B3)
    expectBand: "WATCH",
    // Semis (LADDER rung 1) is calmer/more aggressive than the dial sleeve EM (rung 3) ⇒ held BELOW.
    hold: { held: "Semis", dialSleeve: "EM", override: true, prevHeld: "EM", changed: true },
    note: "override:true ⇒ body adds `held Semis · dial sleeve EM — per-leg read held calmer within the band ceiling` under the dial line",
  },
  {
    key: "r4-cash",
    title: "R4 breaker in the terminal cash phase (the `R4: cash` line + the CRITICAL floor)",
    overrides: { F1: "RED", R1: "RED", R5: "RED" },
    // F1's HY-OAS print, placed ABOVE the r4 ENTER tail and clear of the EXIT floor by half the
    // re-arm gap — derived from the two shipped symbols (`src/r4.ts`), never a typed literal, so a
    // retune of either moves this fixture with it. The state-derived RED level (registry cuts)
    // sits below `R4_HY_TAIL`, which is exactly why the tail needs its own override here.
    levels: { F1: R4_HY_TAIL + (R4_HY_TAIL - R4_EXIT_HY) / 2 },
    r4Phase: "cash",
    expectBand: "CRITICAL",
    note: "the ONLY scenario reaching `r4Phase === 'cash'` — before it, no body mentioned an R4 phase at all and an r4 copy/wording regression was invisible to this trace (E8 item 3). The world is coherent rather than minimal: credit+rates+vol RED (dial Crisis, rung 9) with F1's HY-OAS past R4_HY_TAIL, i.e. the dial-deep + breadth + tail set the real ENTER gate needs. Consequence: the CRITICAL r4 floor is MASKED by an already-CRITICAL dial — the assertion this scenario carries is the body's `R4: cash` line, not the floor. Still blind to the STATEFUL trigger itself (`computeR4` is never run — the phase is handed in), by construction",
  },
  {
    key: "deescalation-lag",
    title: "de-escalation lag holds a dropped dial (OK → WARNING)",
    overrides: {},
    recentDialBands: ["WARNING"],
    expectBand: "WARNING",
    note: "dial is Calm (OK) today, but a recent WARNING is held by the N=2 de-escalation lag → band WARNING",
  },
];

// --- driver ----------------------------------------------------------------

async function runScenario(s: Scenario, push: boolean, quiet: boolean, env: Env): Promise<void> {
  const readings = synth(s.overrides, s.levels);
  const families = computeFamilyPanel(
    // `factor` (the registry `geoFactor` tag) rides through because this sim RENDERS `diffusionLabel`
    // in the push bodies it certifies (R2, 2026-08-06): the label counts DISTINCT FACTORS, so an
    // untagged row would print `gp`'s three oil reads as three agreeing signals and the oracle would
    // certify a body prod cannot emit. ⚠ The ~15 `scripts/probe-*.ts` callers of this function
    // deliberately DON'T thread it — they read ORDERING/danger only, never the label — so a missing
    // `factor` there is inert, not an oversight (the same note lives on the `factor` field in
    // `computeFamilyPanel`'s `members` docblock, src/families.ts).
    readings.map((r) => ({ id: r.indicator.id, state: r.state, factor: r.indicator.geoFactor })),
    // DIAL_FAMILIES, not GLOBAL_FAMILIES (B-11): synth() maps ALL_INDICATORS, which INCLUDES the
    // SLOW legs, so the full table would let a complacency-* override certify a band the real cron
    // — whose dial never sees those rows — cannot produce. This is the notify oracle; it must
    // reduce against the notify table.
    DIAL_FAMILIES,
  ).families;
  const dial = computeT1Dial(families);
  const geoFlags = 0; // manual flags; auto oil rides `readings` (G1)
  const r4Phase = s.r4Phase ?? "equity";
  const recentDialBands = s.recentDialBands ?? [];
  const band = computeAlertBand({
    dial,
    readings,
    geoFlags,
    r4Phase,
    recentDialBands,
    crisisStage: s.crisisStage,
    geoCalmStreak: s.geoCalmStreak,
  });

  // Exact-band oracle: the composed band must equal the scenario's traced value.
  // This pins the two dial-band cases (dial-watch/dial-warning) that the structural
  // invariant below can't distinguish, so the DRY output is self-checking rather
  // than eyeball-dependent.
  if (band !== s.expectBand) {
    throw new Error(`${s.key}: band ${band} ≠ expected ${s.expectBand}`);
  }

  // Rot-free structural invariants (survive cut/floor recalibration, unlike the
  // exact expectBand above). These guard the `max(deEscalationLag(dial), floor)`
  // COMPOSE contract itself, not any one scenario's band:
  //  - band ≥ dialBand always holds by construction (band = max over dialBand-inclusive
  //    terms), so this throw is a tripwire for a future refactor that breaks the max-compose;
  //  - the escalator/lag pair must sit STRICTLY above their (OK) dial — proving the floor
  //    and the N=2 lag actually lift a calm dial.
  const dialBand = regimeToBand(dial.notifyRegime); // notify-axis
  if (ALERT_RANK[band] < ALERT_RANK[dialBand]) throw new Error(`${s.key}: band ${band} < dial ${dialBand}`);
  const mustLift = [
    "escalator-geo",
    "deescalation-lag",
    // the geo-stage walk's elevated closes: every band here is floor-made over a Calm dial
    "geo-stage-arm",
    "geo-stage-flare",
    "geo-stage-hold",
    "geo-declared4-hold",
  ];
  if (mustLift.includes(s.key) && ALERT_RANK[band] <= ALERT_RANK[dialBand]) {
    throw new Error(`${s.key}: floor/lag did not lift (band ${band} ≤ dial ${dialBand})`);
  }

  // last = null ⇒ OK baseline (decideNotify): an elevated band is an upward change → push.
  const last: AlertRecord | null = null;
  const { push: wouldPush, message } = buildNotification(last, band, dial, families, readings, ASOF, {
    // Stage 4.2: the option is the whole `R4Result` (`resolveCash`'s input). The sim only ever
    // varies the phase, so the rest is the resting state; `cash` tracks `phase === "cash"`.
    r4: { cash: r4Phase === "cash", phase: r4Phase, entryFiredAt: null, reentryRung: null, reason: "sim" },
    hold: s.hold,
  });

  // The regression this change exists to make eyeball-able: the dial line must render.
  if (!message.body.includes("Dial:")) {
    throw new Error(`${s.key}: notification body is missing the "Dial:" line`);
  }

  // E8 item 3 — the r4 copy guard. A cash phase MUST name itself on the body (`r4Note`,
  // notify_format.ts).
  //
  // The second check is a PLUMBING guard, not a threshold guard: the scenario itself computes
  // F1's level from `R4_HY_TAIL`, so this can never catch a wrong tail — it re-reads the same
  // expression. What it CAN catch is the `levels` override failing to reach `synth` (a dropped
  // argument, a renamed field, a key typo, a future `synth` branch that overwrites an explicit
  // level), which would silently put F1 back on its cut-derived level and leave the "cash over a
  // world that entered cash" premise false while every other assertion still passed.
  if (r4Phase === "cash") {
    if (!message.body.includes("R4: cash")) {
      throw new Error(`${s.key}: body is missing the "R4: cash" phase line`);
    }
    const hy = readings.find((r) => r.indicator.id === "F1");
    if (!hy || hy.level < R4_HY_TAIL) {
      throw new Error(`${s.key}: F1 level ${hy?.level} does not clear R4_HY_TAIL`);
    }
  }

  // W5-a Stage 1.2 — the overlay's calibration read, printed for all 15 worlds.
  // ⚠ UD-1 = (c) DIAL ACCELERATION, which is STATEFUL: it fires on a rise in `targetRung` across up
  // to `CASH_ACCEL_WINDOW` closes. Every scenario here is a SINGLE synthetic close with no rung
  // history, so the window is always length 1, the rise is always 0, and the trigger is structurally
  // UNREACHABLE in this harness — it must read `off` in all 15. That is the honest result, not a
  // calibration: the line documents the blind spot rather than hiding it. The real calibration read
  // is `npm run probe:cash-overlay`, which folds the same function over REAL persisted closes.
  // Orthogonality invariant (§0): read-only — nothing below feeds `band`, `dial` or the message.
  const overlay = computeCashOverlay(dial, { recentTargetRungs: [], since: null }, () => ASOF);

  // `--quiet` (the `npm run check` mode): ONE line per scenario. Every assertion above and below
  // still runs — this trims only the eyeball transcript, which is the part `check` can't read.
  // The full body stays one command away: `npm run sim:notify -- <key>`.
  if (quiet) {
    const rung = `${dial.regime} r${dial.targetRung}`;
    console.log(
      `  ${s.key.padEnd(Math.max(...SCENARIOS.map((x) => x.key.length)))} ${band.padEnd(8)} (dial ${dialBand}) · ${rung} · band ${dial.band.lo}–${dial.band.hi} · overlay ${overlay.level} · push=${wouldPush}`,
    );
    if (push) await pushNtfy(message, { env });
    return;
  }

  console.log(`\n=== ${s.key} — ${s.title} ===`);
  console.log(`  ${s.note}`);
  console.log(`  dial: ${dial.headline}`);
  console.log(`  band: ${band}  (dialBand ${dialBand})`);
  // W3-b: the DIAL band [lo,hi] — the rotation band that selects the held leg — printed because the
  // wave's gate is "re-read the traces", and the `band:` line above is the ALERT level, not this.
  // Before W3-b this appeared only as prose inside each scenario's hand-written `note`.
  console.log(`  dial band: ${dial.band.lo}–${dial.band.hi}  (width ${dial.band.hi - dial.band.lo})`);
  console.log(`  cash overlay: ${overlay.level} — ${overlay.reason}`);

  console.log(`  --- ntfy message (push=${wouldPush}) ---`);
  console.log(`  Title: ${message.title}`);
  console.log(`  Tags: ${message.tags}  Priority: ${message.priority}`);
  console.log(`  Click: ${dashboardUrl(env) ?? "(none — no PROD_ALIAS)"}`);
  console.log(
    message.body
      .split("\n")
      .map((l) => `  | ${l}`)
      .join("\n"),
  );

  if (!wouldPush) {
    console.log(`  (no push — band not an upward change; nothing sent)`);
    return;
  }
  if (!push) {
    console.log(`  (dry run — pass --push to POST this to ntfy.sh/${ntfyTopic(env)})`);
    return;
  }
  await pushNtfy(message, { env });
  console.log(`  ✓ pushed to ntfy.sh/${ntfyTopic(env)}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const push = args.includes("--push");
  const quiet = args.includes("--quiet");
  const topicIdx = args.indexOf("--topic");
  const topicValueIdx = topicIdx === -1 ? -1 : topicIdx + 1; // the index of --topic's value, if any
  const topic = topicValueIdx === -1 ? undefined : args[topicValueIdx];
  // The tap link (`Click`) a host run lacks without PROD_ALIAS comes from the prod config; none ⇒ no link. A real
  // send fills it only toward an explicit topic — never the public dev fallback topic.
  const base: Env = topic ? { ...readEnv(), NTFY_TOPIC: topic } : readEnv();
  const env: Env = !push || ntfyPushEnabled(base) ? withConfigAlias(base) : base;

  // The first bare (non-flag) arg that isn't the --topic value is the scenario key.
  const wanted = args.find((a, i) => !a.startsWith("--") && i !== topicValueIdx) ?? "all";
  const selected = wanted === "all" ? SCENARIOS : SCENARIOS.filter((s) => s.key === wanted);
  if (selected.length === 0) {
    console.error(`Unknown scenario "${wanted}". Options: ${SCENARIOS.map((s) => s.key).join(", ")}, all`);
    process.exit(1);
  }

  // COVERAGE assertion (not a scenario assertion): the `R4: cash` copy guard in `runScenario` is
  // gated on `r4Phase === "cash"`, so deleting the one scenario that supplies it would retire the
  // guard SILENTLY — a green run proving nothing about the r4 line. Run over the whole SCENARIOS
  // table, not the selection, so a single-key run can't mask it.
  if (!SCENARIOS.some((s) => s.r4Phase === "cash")) {
    throw new Error(`no scenario sets r4Phase "cash" — the "R4: cash" body guard would never run`);
  }

  console.log(`Simulating ${selected.length} scenario(s) · target topic: ntfy.sh/${ntfyTopic(env)} · push=${push}`);
  for (const s of selected) await runScenario(s, push, quiet, env);
  if (quiet) console.log(`\nquiet — re-run without --quiet (or with a single scenario key) for full bodies.`);
  if (!push) console.log(`DRY RUN — re-run with --push to send real notification(s).`);
}

main().catch((err: unknown) => {
  console.error("simulate-notify failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
