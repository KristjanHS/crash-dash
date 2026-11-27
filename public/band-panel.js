// BAND-column render seam — pure HTML projection of the LIVE-ONLY `LabResponse.band` (LabBand,
// src/families.ts): the deduction chain (dangerScore →cut→ REGIME →floors→ BAND) + escalator floors.
// Kept OUT of lab.js so band-panel.test.js pins the exact markup (same pattern as scoreboard-card.js).
//
// Every floor renders named member rows with a RAG left bar; non-firing members fold behind `+N calm ▸`
// (lab.js toggles it); r4 rows always show. FLOOR_DESC/MEMBER_DESC below supply the `title=` tooltips.
// The binding floor (`id === band.source`) is emphasised, the rest dimmed.
//
// Member-cell rule (§7 Q2): render `cappedState`, NEVER raw `state` — a `rate` member whose signal is
// RED paints AMBER since its floor caps below CRITICAL (`capMemberState`, src/alert-band.ts).
//
// scenario/replay serve `band: undefined`, so renderBandPanel returns "" and the host stays blank.

/** Same RAG→class table as lab.js (STATE_CLASS) — not exported there. `s` = suppressed/no-feed. */
const STATE_CLASS = { GREEN: "g", AMBER: "a", RED: "r" };

/** Static per-FLOOR descriptions → the floor-head `title=` tooltip. Each states the floor's channel,
 *  its CAP (how high it can push the notify band), and whether member cells are capped with it.
 *  EXPORTED for `prose-names.test.ts` only: these VALUES carry indicator names in free prose
 *  (`HY OAS` in `r4`) that can drift to a pre-rename form; the test scans the values, not the KEYS
 *  (floor ids `credit`/`r4`/…, never `ALL_INDICATORS` ids). No render site imports this. */
export const FLOOR_DESC = {
  credit:
    "CREDIT floor - HY & IG option-adjusted spreads: the market's own price for corporate default and funding risk, and the earliest broad stress channel. RED-capable - this floor alone can drive the notify band to CRITICAL, so member cells show their own confirmed RAG uncapped.",
  r4: "R4 floor - the cash / haven circuit-breaker. Its four rows are the ENTER gate, read as dial rung AND family breadth AND (HY OAS tail print OR VIX-term tail print); each shows today's live value vs its gate with a bar for how close it sits. RED-capable - can reach CRITICAL. Each row is toned by ITS OWN proximity to ITS OWN gate: amber from 80% of the gate, green below, never red - no single row is an entry on its own, since a hot tail row is only one side of the OR and still needs both AND-ed conditions beside it. Those AND-ed conditions are satisfied on ONE close - there is no arming delay. The breaker's PHASE (equity → cash → re-entry) is the chip on this head.",
  geo: "GEO floor - geopolitical / commodity shock: manual flags declared in config.json plus the automatic oil channel (WTI 20-day return, crude implied vol, Brent confirm). Member cells show their own uncapped RAG, but the FLOOR caps at WARNING - geopolitics can never push the band to CRITICAL on its own.",
  rate: "RATE floor - Treasury curve level plus the three velocity legs (nominal 10y, 2y, 10y real). Caps at WATCH: a member whose own confirmed signal is RED is displayed AMBER here, because this floor can never reach higher.",
  ew: "EARLY-WARN floor - the fast downside-break detectors (SMH semis, XLK S&P-500 IT), each AND-gated with its own relative-strength row (the ETF/SPY price ratio vs that ratio's 50-day average). A pair arms the floor only when BOTH conditions hold - the drawdown break past its cut AND relative strength below its 50-day MA - with an OR across the two pairs; a half-met pair stays quiet and both its rows name the missing condition. The FLOOR caps at WATCH (a bounded advisory nudge), but a member past its own red cut paints RED in its cell - the cap is on the floor, not on the read ([USER] 2026-07-23).",
  coverage:
    "COVERAGE floor - the only floor that is NOT a market reading: it says WE CANNOT SEE. It lifts the band to WATCH when a dial family's verdict rests on data that is not live - a member past its own lag cut, or a roster member dark past its own lag cut (a shorter absence is carried on its last close and does not floor) - so the family is voting on last-known data. Caps at WATCH and can never reach WARNING or CRITICAL: blindness is a reason to look, never a reason to de-risk. It arms only while OTHER daily feeds are still flowing, so a market holiday or a whole-run outage (everything lagging together) does NOT trip it - the claim is divergence between feeds, not age on its own. Its rows name the affected families, not indicators.",
};

/** Static per-MEMBER descriptions → the member-row `title=` (MEANING + TRIGGERING CONDITION). The
 *  `coverage` floor's rows are family keys, not indicators, and carry NO entry here — they fall
 *  through to the server-composed note (see `memberTitle`). r4 rows (and a half-met ew pair's rows)
 *  ALSO append their live `note`; a member with no entry falls back to the note, then to nothing.
 *  Prose-level on the CALIBRATED cuts (F1/F2/R1–R4 resolve cuts from measured history at run time — a
 *  number typed here would drift); the static-constant cuts (oil, Brent, DB_*) DO carry their numbers.
 *  Each entry is the bare SENTENCE — no leading "<name> — " clause; `memberTitle` emits the name.
 *  Coverage (every floor member has an entry) is pinned by band-panel.test.js; stays EXPORTED for that. */
import { posAttrs } from "./inline-pos.js";
import { secTip } from "./section-tips.js";
import { idIfDistinct } from "./leading-name.js";

export const MEMBER_DESC = {
  // --- credit ------------------------------------------------------------------------------
  F1: "the US high-yield option-adjusted spread: the extra yield demanded to hold junk-rated corporate debt over Treasuries. Higher is worse. Two legs fire it: the spread LEVEL, and a widening VELOCITY over a 30-day window - cut-points are resolved from its own measured history, not hand-set, and a state counts the day it prints - there is no confirmation buffer to clear.",
  F2: "the investment-grade credit spread (top-rated corporate debt over Treasuries). It moves far less than high yield, so a widening here means stress has reached the SAFEST corporate borrowers. Level + 20-day velocity legs, cuts calibrated off the long-history Baa−10y reference series, and same-day state (no confirmation buffer).",
  // --- r4 (the four enter gates; each row also appends its live `note`) --------------------
  "r4-rung": "where the danger dial currently targets on the fixed 9-leg ladder (1 = most aggressive equities, 9 = most defensive equities). This gate asks whether the dial has ALREADY walked the ladder to its defensive floor; cash sits past rung 9, so the breaker refuses to fire while the dial still has equity rungs left. The bar shows today's rung as a fraction of the gate.",
  "r4-families": "how many of the 5 DIAL families (credit · rates · volatility · cross-asset · trend) are confirmed non-GREEN. A breadth test: the breaker wants stress in several independent channels at once, never one loud leg. Geopolitics is excluded (it has its own GEO floor, so counting it here would double-count one shock) and valuation is excluded because it never arms - it is filtered out of both the leading and the coincident sets, so no valuation member (ECY, or the two breakevens) can select a band or move a rung.",
  "r4-hyoas": "the live high-yield spread LEVEL against R4's own tail threshold, which sits far above F1's amber/red cuts. Deliberately not the same test as the CREDIT floor: that one asks 'is credit elevated', this one asks 'is credit at a genuine crisis print' - the tail of the distribution.",
  "r4-vt": "near-month implied vol divided by the 3-month. Above 1.00 the curve is INVERTED (backwardation): the market pays more for protection now than in three months, which is the acute-panic tell rather than a high-but-calm vol level. Enters at the tail threshold shown on the row.",
  // --- geo ---------------------------------------------------------------------------------
  GEO_MANUAL:
    "hand-declared events counted from config.json (editing it is a redeploy, by design). AMBER whenever at least one flag is active, GREEN at zero; each flag also adds one step to the geo escalator base. This is the HUMAN override channel - nothing automatic ever sets it.",
  GEO_STAGE:
    "the declared crisis-stage ladder's addend to the geo escalator base (the playbook stage set in config.json; a stand-down hold from a released stage 4 counts here too, with its calm-day dwell in the row note). AMBER while it adds anything, GREEN at zero - this row IS the '+N stage' term the ⓘ footnote sums, so the board's rows now add up to the base.",
  G1: "WTI crude oil (FRED DCOILWTICO), the automatic oil-shock channel. The band it draws is the 20-day RETURN - amber at a +20% run-up, red at +40% - and that read is ADMITTED by a level GATE: the close must also be at or above its trailing 3-year peak. A run-up that never breaches the peak is a rally off a low, not a shock, so it reads GREEN; an expensive-but-stable oil price reads GREEN too, because the run-up leg never fires. The gate can only suppress, never redden on its own.",
  OVX: "crude-oil implied volatility (OVX): what the options market expects oil to do next; G1's implied-vol sibling. Two legs, either of which can fire (the worse one wins), higher is worse: the LEVEL band - amber above 45 (a sustained oil-shock regime), red above 60 (the 2020/2022-class blowout zone) - OR a fast five-session SPIKE. For implied vol a spike off a low base is informative in a way a price run-up is not, which is why these legs are OR'd while the crude prices are gated. Stated priors - uncalibrated.",
  BRENT:
    "Brent crude (FRED DCOILBRENTEU), the seaborne oil benchmark and G1's confirm leg. Same two-leg shape as G1: the drawn band is a fast 20-day run-up (amber +15%, red +25%), ADMITTED by the level gate - the close at or above its trailing 3-year peak. Both must hold, so the gate can only SUPPRESS a run-up that isn't making new highs; it never reddens a day on its own. The trailing peak replaced a fixed dollar cut (retired 2026-08-06) because it self-recalibrates and never needs a retune. Stated priors - uncalibrated.",
  // --- rate (floor caps at WATCH — a RED signal is displayed AMBER) -------------------------
  R1: "the Treasury term spread (FRED T10Y3M), i.e. the slope of the Treasury curve. INVERTED polarity, lower is worse: amber as the curve flattens toward zero, red once it INVERTS (the 10-year yielding less than the 3-month), the classic recession lead. Level-only - there is no velocity leg - with cuts calibrated from its own history and same-day state (no confirmation buffer).",
  R2: "10-year Treasury yield velocity (FRED DGS10): the 20-day CHANGE in the nominal long yield, not its level. A fast rise is a rate shock every other asset has to reprice against. Velocity-only: a high but stable yield reads GREEN, because only the speed of the move is the danger.",
  R3: "2-year Treasury yield velocity (FRED DGS2): the 20-day change in the 2-year yield, i.e. how fast the market is repricing the expected Fed path. Same shape as R2 but on the policy-expectations leg, which moves first and further in a rate shock. Velocity-only.",
  R4: "10-year REAL yield velocity (10y RY — FRED DFII10, 10y TIPS): the 20-day change in the inflation-adjusted long yield: the discount rate that actually prices long-duration equity. Velocity-only, so the series' frequent negative LEVELS never matter - a fast RISE is the shock regardless of sign.",
  // --- ew ----------------------------------------------------------------------------------
  DB_SMH:
    "downside break on SMH (semiconductor ETF): drawdown from its own 3-month high, gated on price being below its 50-day average so a dip inside a healthy uptrend never counts. Amber at −5%, red at −8%. The fast tech-break early warning; it arms the floor only together with its RS_SMH relative-strength row (break AND rel-strength breakdown), belongs to no family, and feeds only this floor.",
  DB_XLK:
    "downside break on XLK (S&P 500 IT sector): the same 3-month-high drawdown with the same MA50 trend gate, amber −5% / red −8%. This is the DIRECT read on the S&P 500 IT sector - every other tech-risk leg on the board is a proxy for it. Arms the floor only together with its RS_XLK relative-strength row (break AND rel-strength breakdown).",
  RS_SMH:
    "relative strength of SMH against the broad market: the SMH/SPY price ratio measured vs its own 50-day moving average, amber once the ratio closes below that average - semis lagging the market rather than just falling with it. The AND-gate partner of the SMH fast break: the ew floor arms only when both this breakdown and the break hold, and a half-met pair's note names the missing condition.",
  RS_XLK:
    "relative strength of XLK against the broad market: the XLK/SPY price ratio measured vs its own 50-day moving average, amber once the ratio closes below that average - the S&P 500 IT sector lagging the market rather than just falling with it. The AND-gate partner of the XLK fast break: the ew floor arms only when both this breakdown and the break hold, and a half-met pair's note names the missing condition.",
};

/** Local esc (lab.js's is not exported; same table as ew-badge.js / scoreboard-card.js). */
function esc(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

/** r4 enter/exit input value / threshold → text; a present-but-null input reads `n/a`.
 *  Numeric inputs are rounded to 3 significant figures (trailing zeros dropped) so a raw
 *  float like `0.907767010517176` renders as `0.908`, not its full double precision. */
function fmtInput(v) {
  if (v === null || v === undefined) return "n/a";
  const n = typeof v === "number" ? v : Number(v);
  if (typeof v !== "boolean" && Number.isFinite(n) && String(v).trim() !== "") {
    return esc(String(Number(n.toPrecision(3))));
  }
  return esc(String(v));
}

/** True when a member carries the r4 enter/exit input pair (absent on RAG members). */
function hasInput(m) {
  return m.value !== undefined || m.threshold !== undefined;
}

/** A member is "firing" (shown by default) when its capped tone is AMBER or RED; GREEN and
 *  suppressed members fold (plan #4 / OQ-3). r4 rows bypass this — they always show. */
function isFiring(m) {
  return m.cappedState === "AMBER" || m.cappedState === "RED";
}

/** The `title=` for a member: NAME segment (short name · id), then the static MEMBER_DESC sentence,
 *  then the live r4 note, joined by ` · `; absent segments skipped. The short name comes from `label`;
 *  the id follows only when it ADDS information — a restating id (`OVX`/`OVX`) is dropped by
 *  `idIfDistinct` so the hover reads `OVX · …` not `OVX · OVX · …`. `longLabel` is not rendered. */
function memberTitle(m) {
  const name = [m.label, idIfDistinct(m.label, m.id)].filter(Boolean).join(" · ");
  const t = [name, MEMBER_DESC[m.id], m.note].filter(Boolean).join(" · ");
  return t ? ` title="${esc(t)}"` : "";
}

/** r4 margin bar (plan #6): how close the live value sits to its gate threshold. Every r4 row is a
 *  `value ≥ threshold to enter` gate (rung/families/HY-OAS/VT — plan OQ-1), so higher value = fuller
 *  bar = closer to trip. Rendered only when BOTH numbers are present (a null value = feed hiccup).
 *
 *  Width rides `posAttrs` (inline-pos.js), never a style attribute (`.claude/rules/frontend.md` §Inline style attributes are dead in prod). The fill is
 *  neutral grey, never a RAG tone: a proximity bar is not itself a fired condition. */
function marginBar(m) {
  if (m.value === null || m.value === undefined || m.threshold === null || m.threshold === undefined) return "";
  const frac = m.threshold === 0 ? 0 : Math.max(0, Math.min(1, m.value / m.threshold));
  const pct = Number((frac * 100).toFixed(1));
  return `<span class="bp-margin"><span class="bp-margin-fill"${posAttrs({ width: pct })}></span></span>`;
}

/** One member row: label + (r4 only) live input vs gate + margin bar. The capped tone is the left
 *  border (class), the note/description is the `title=` tooltip. Renders `cappedState` — never `state` (§7 Q2). */
function memberRow(m) {
  const cls = STATE_CLASS[m.cappedState] || "s";
  const inputs = hasInput(m)
    ? `<span class="bp-input"><b>${fmtInput(m.value)}</b> vs <b>${fmtInput(m.threshold)}</b></span>`
    : "";
  return (
    `<div class="bp-member ${cls}" data-id="${esc(m.id)}"${memberTitle(m)}>` +
    `<span class="bp-mlabel">${esc(m.label)}</span>` +
    inputs +
    marginBar(m) +
    `</div>`
  );
}

/** binding-floor emphasis: the floor whose id is `band.source` is ringed, the rest dimmed.
 *  When `source` is null (all-OK) nothing is emphasised. */
function floorEmph(f, source) {
  if (!source) return "";
  return f.id === source ? " bp-binding" : " bp-dim";
}

/** The floor head — id + own-level chip, with the FLOOR_DESC tooltip. r4 additionally carries the
 *  breaker's PHASE chip; its tone comes from the server (`phaseState`) — the phase→tone table is NOT
 *  mirrored in the FE. Rendered only when `phase` is present. */
/** Extra server-toned chips on a floor head, in wire order — `r4`'s fall-shape + confidence pair.
 *  ⚠ Renders what the server sent and NOTHING else (label, tone `state`, hover `title` all pre-decided).
 *  There is NO shape→tone/confidence→tone table in this file and must never be one — the classification
 *  lives in `src/v-bear.ts` (`fallShapeChips`); a second FE spelling is how the two drift. A chip with
 *  no `state` paints the quiet base outline (`STATE_CLASS` miss ⇒ `s`). */
function floorChips(f) {
  return (f.chips || [])
    .map(
      (c) =>
        `<span class="bp-floor-fchip ${STATE_CLASS[c.state] || "s"}"` +
        (c.title ? ` title="${esc(c.title)}"` : "") +
        `>${esc(c.label)}</span>`,
    )
    .join("");
}

function floorHead(f) {
  const phase = f.phase
    ? `<span class="bp-floor-phase ${STATE_CLASS[f.phaseState] || "s"}" title="cash / haven circuit-breaker phase - equity (calm) → cash (entered on the FIRST qualifying close, off-ladder) → re-entry (walking back onto the ladder). The rows below tone by proximity to their own gates, not by this.">phase: ${esc(f.phase)}</span>`
    : "";
  return (
    `<div class="bp-floor-head">` +
    `<span class="bp-floor-id">${esc(f.id)}</span>` +
    // Order: id · phase · fall-shape chips · level chip. Only `.bp-floor-phase` carries
    // `margin-left:auto` (styles.css) — a second auto margin would split the free space and pull the
    // level chip off the right edge, breaking the single vertical scan line across all five floors.
    phase +
    floorChips(f) +
    `<span class="bp-floor-chip lvl-${esc(f.level)}">${esc(f.level)}</span>` +
    `</div>`
  );
}

/** The floor's count, printed under the head — `geo` carries it: `geo base 4`, with the addends
 *  (`= 1 manual + 1 auto (OVX, BRENT) + 2 stage`) behind a ⓘ footnote. BOTH strings cross the wire
 *  fully composed (`formatGeoBasisLead`/`formatGeoBasis`, src/alert-band.ts); this file counts NOTHING
 *  and must never start — a browser-side recount is drift by construction — and must not SLICE the lead
 *  out of the detail. The ⓘ is appended by `decorateHelp` on the `[title]` host. Absent ⇒ nothing renders. */
function floorBasis(f) {
  if (!f.basis) return "";
  const note = f.basisDetail ? ` title="${esc(f.basisDetail)}"` : "";
  return `<div class="bp-floor-basis"${note}>${esc(f.basis)}</div>`;
}

/** One escalator floor: head + firing member rows, with calm (GREEN/suppressed) members folded behind
 *  a `+N calm ▸` affordance. r4 rows never fold (they carry the binding numbers). */
function floorSection(f, source) {
  const desc = FLOOR_DESC[f.id] ? ` title="${esc(FLOOR_DESC[f.id])}"` : "";
  const members = f.members || [];
  const alwaysShow = f.id === "r4";
  const firing = alwaysShow ? members : members.filter(isFiring);
  const calm = alwaysShow ? [] : members.filter((m) => !isFiring(m));
  const fold = calm.length
    ? `<button type="button" class="bp-fold" aria-expanded="false">+${calm.length} calm ▸</button>` +
      `<div class="bp-calm" hidden>${calm.map(memberRow).join("")}</div>`
    : "";
  return (
    `<div class="bp-floor${floorEmph(f, source)}" data-floor="${esc(f.id)}"${desc}>` +
    floorHead(f) +
    floorBasis(f) +
    `<div class="bp-members">${firing.map(memberRow).join("")}</div>` +
    fold +
    `</div>`
  );
}

/** The two-list footnote under the floors. The floors panel is the most common point of confusion on
 *  /lab — a floor reads as "this is what changed my holding". It is not: `src/alert-band.ts` is
 *  notify-only (no store, no clock), and leg selection is `computeField(…, dial.band, …)` in
 *  `src/run-core.ts`, reading the DIAL's rung window `[lo,hi]` — never the composed alert band.
 *  Load-bearing facts behind the copy:
 *   - valuation/CAPE is a member of NO family; its danger home is the ECY member (vb), and the dial
 *     applies NO valuation multiplier.
 *   - the base band IS `regimeToBand(dial.notifyRegime)`; the floors only `max` over it.
 *   - `geo` is on BOTH lists (with `r4`): one oil shock feeds the geo escalator floor AND the per-leg
 *     danger field → `ownDanger` → `effDanger` → `pickHeld`. The oil contribution is the share arm's
 *     per-leg `gp` term (the `MEMBER_WEIGHT`-weighted share over G1/OVX/BRENT, capped below the amber
 *     cut), so it RE-ORDERS the legs, never lifts them equally. The
 *     double-count with the geo escalator floor is INTENDED (band = how loud, position = what to hold).
 *   - only `ew` is cleanly notify-only (dial-assembly.ts: feeds ONLY `ewFloor` + UI); the credit and
 *     rate floors' INPUTS carry `MEMBER_WEIGHT` rows and so move the leg by another route.
 *  Deliberately STATIC copy: the second list names engine concepts (`RERISK_DEADBAND`, `TREND_GATE_FLOOR`,
 *  `CONC_THRESHOLD`, the exogenous member weights, the cash overlay) with no served projection here.
 *  Mirrored in README §How the score works step 4 — kept in sync BY HAND.
 *  COLLAPSED BY DEFAULT: the toggle is `position:absolute` into the panel's existing 12px top padding,
 *  so it adds ZERO height; wired by the delegated `.bp-note-toggle` handler in lab.js `buildBandPanel`. */
/** The floors disclosure ([USER] 2026-08-29): the escalation sentence AND the five floor blocks are
 *  COLLAPSED BY DEFAULT behind `floors ▸`. Rationale: on the overwhelming majority of days the panel's
 *  chain strip is the whole answer, and the floor column is the most-misread part of /lab (see
 *  `bandNote`). Both pieces move together on purpose — the sentence ("the market read is OK; the ew
 *  floor raised it to WATCH") is a caption for the column below it, so revealing one without the other
 *  leaves a dangling caption. Wired by the delegated `.bp-floors-toggle` handler in lab-board.js
 *  `buildBandPanel` (aria-controls → `#bpFloors`, same resolution path as `.bp-note-toggle`).
 *  TITLED ([USER] 2026-08-30): the disclosure carries its own `Floors` heading with the section
 *  footnote (`SECTION_TIP.floors`), so the collapsed strip says what is behind it. The heading and
 *  the toggle are SEPARATE elements on purpose — help-bar.js's capture handler opens a `.sec-tip`
 *  host's footnote on tap, and a tooltip host that is ALSO the disclosure button would fire both
 *  on one phone tap. The button keeps the chevron `toggleDisclosure` rewrites (▸/▾). */
function floorsBody(band, floors) {
  return (
    `<div class="bp-floors-head">` +
    `<h2 class="bp-floors-title sec-tip"${secTip("floors")}>Floors</h2>` +
    `<button type="button" class="bp-floors-toggle" aria-expanded="false" aria-controls="bpFloors">` +
    `show ▸</button>` +
    `</div>` +
    `<div class="bp-floors" id="bpFloors" hidden>` +
    escalationLine(band) +
    `<div class="bp-column">${floors}</div>` +
    `</div>`
  );
}

function bandNote() {
  return (
    `<button type="button" class="bp-note-toggle" aria-expanded="false" aria-controls="bpNote">` +
    `what moves what ▸</button>` +
    `<div class="bp-note" id="bpNote" hidden>` +
    `<div class="bp-note-lead">These floors move the ALERT LEVEL only - not which ladder rung.</div>` +
    `<div><span class="bp-note-k">Raises the alert level:</span> the dial's own regime (the band ` +
    `starts there; everything else only raises it) · the five floors above · the de-escalation lag · ` +
    `the +1 divergence bump · the lagging-feed hold. Whichever binds names itself as the band reason. ` +
    `A floor MECHANISM raises the alert only - but the reading behind it may still move the position ` +
    `by another route (credit and rates carry member weights; only the early-warn nudge is ` +
    `notify-only).</div>` +
    `<div><span class="bp-note-k">Moves the position:</span> the dial's rung window · ` +
    `the per-leg danger field inside that window (the family cells and their member ` +
    `weights - this is where valuation / CAPE enters, through the ECY member; the CAPE card ` +
    `itself is display-only context and moves nothing) · the exogenous danger term (a confirmed oil shock raises each leg's danger to AT ` +
    `LEAST its own oil share, capped just below amber - a worst-of, not a sum, so oil alone never ` +
    `sets a band) · ` +
    `the re-risk deadband (this makes re-risking slower, never faster; the dwell/streak clocks that ` +
    `used to sit beside it were retired 2026-08-07, so a re-risk now commits on one close like a ` +
    `de-risk, subject only to the deadband and the trend gate) · ` +
    `the trend gate · the concentration gate · the cash overlay (scales cash without changing ` +
    `the leg) · the R4 cash breaker (takes you off the ladder entirely).</div>` +
    `<div class="bp-note-foot">r4 and geo are on both lists, for different reasons: for r4 the ` +
    `causation runs the other way round - the breaker moves the position first, and that is why its ` +
    `floor fires; for geo one reading (the oil shock) has two separate effects - the geo ` +
    `escalator floor and the exogenous danger term. That is deliberate, not a duplicate: one says ` +
    `how loud to be, the other what to hold.</div>` +
    `</div>`
  );
}

/** The escalation sentence under the chain strip — the PRE-FLOOR dial band beside the final one, e.g.
 *  `the market read is WATCH; the geo floor raised it to WARNING`.
 *
 *  CONDITIONAL: emitted ONLY when `band.dialBand` differs from `band.level`; when they agree nothing renders.
 *
 *  ⚠ Reads `band.dialBand`, NEVER `band.chain.band`: the chain field is the pushed POST-floor band and
 *  equals `level` by construction, so keying off it would make this dead code that still looks wired.
 *  "raised" is safe because the served pair obeys `level ≥ dialBand`.
 *
 *  The binding floor NAMES itself when there is one; `source: null` with a gap means the lift came from
 *  the lag / divergence / verdict hold — this file must not guess which, it is not served that.
 *
 *  ⚠ `source` alone is NOT permission to say "raised it to". `LabBand.source` is the highest floor
 *  ABOVE OK whether or not it reached the final band; `computeAlertBandDetail` emits `floor:<id>` only
 *  when the floor's level EQUALS the band. So a merely-elevated floor is still named here on a
 *  lag-hold/divergence-bump/verdict-hold day. The named floor must prove it BOUND — its own `level`
 *  equal to `band.level` — before it is named; otherwise this falls through to "it is held at". */
function escalationLine(band) {
  if (!band.dialBand || band.dialBand === band.level) return "";
  const from = `<b class="bp-esc-band">${esc(band.dialBand)}</b>`;
  const to = `<b class="bp-esc-band">${esc(band.level)}</b>`;
  const named = band.source ? (band.floors || []).find((f) => f && f.id === band.source) : null;
  const bound = !!named && named.level === band.level;
  const lift = bound
    ? `the ${esc(band.source)} floor raised it to ${to}`
    : `it is held at ${to}`;
  return `<div class="bp-chain-esc">the market read is ${from}; ${lift}</div>`;
}

/**
 * The BAND panel markup, or "" when the response carries no `band` (scenario/replay — the host
 * stays blank). Never crashes on the empty shape.
 * @param {import("../src/families.ts").LabBand | null | undefined} band the served LabBand.
 */
export function renderBandPanel(band) {
  if (!band) return "";
  const c = band.chain;
  const score = Number(c.dangerScore).toFixed(2);
  // Top strip spanning both columns — reads left→right as the actual deduction (§7 Q1).
  const chain =
    `<div class="bp-chain sec-tip"${secTip("chain")}>` +
    `danger ${esc(score)} -cut→ ${esc(String(c.regime).toUpperCase())} -floors→ ${esc(c.band)}` +
    `</div>`;
  const floors = (band.floors || []).map((f) => floorSection(f, band.source)).join("");
  return `<div class="band-panel">${chain}${floorsBody(band, floors)}${bandNote()}</div>`;
}
