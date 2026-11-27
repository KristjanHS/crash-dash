/**
 * SECTION-TITLE tooltips for the two `.lab` shells — /lab (`#lab`) and /overview (`#overview`);
 * copy only, rendered from five files (lab.js, band-panel.js, lab-board.js, scoreboard-card.js,
 * overview.js), pinned by section-tips.test.js.
 *
 * Every host MUST carry `class="… sec-tip"` beside the emitted `title=`: both shells are
 * tap-first, so `HELP_CARVEOUT_SELECTOR` (`.lab .sec-tip[title]` — CLASS-scoped, so the same
 * heading is tap-readable on either page) is what makes these readable on a phone.
 *
 * Copy: no `"` (interpolated into a double-quoted attribute) and no indicator NAMES (drift).
 */

/** @type {Record<string, string>} */
export const SECTION_TIP = {
  chain:
    "The deduction chain for today, read left to right: the danger score (0 calm - 1 extreme), the REGIME its cut-points put that score in, and the ALERT BAND that regime became once the escalator floors below had their say. The band is how LOUD to be (OK - WATCH - WARNING - CRITICAL), never which ladder rung to hold. Floors can only RAISE the regime's band, never lower it, so a band above the regime means some floor bound: open floors below to see which, and what moves what for the split between alert level and position.",
  families:
    "The live signal board: one card per family (credit, rates, volatility, cross-asset, trend, geopolitics), each showing its confirmed state and the indicator legs behind it, with the regime and the day's danger score on the head. This is the INPUT side of the bench - everything else on this page is computed from these states. A card shows the WORST of its members, never an average, and a state must clear its confirmation buffer before it counts. In Scenario mode, tap a card to cycle its state and watch the rest of the bench respond.",
  dangerLedger:
    "One row per ladder leg, sorted by that leg's OWN danger - so a leg's POSITION in this list means how dangerous it is right now, not where it sits on the risk ladder. Each cell is the worst member reporting into that leg, never an average. Read it to answer why the held leg is the one held: which families are lit, for which legs, and how far apart the legs actually are. The rN in the risk column is a leg's fixed seat on the ladder, not a score - the dial gives a WINDOW of rungs and this board picks by danger inside it, so the held rN routinely differs from the dial's target rung; click the held row for that pick trace. LEGEND decodes the glyphs, region/sector widens the grid, and DETAIL opens the held-path trace under it.",
  methodCards:
    "The method catalog. Pick a chip to read one rotation method in full - what it is, which indicators it reads, its rule, and where it breaks - and the callout at the top ties that text to the LIVE board, showing what this method would be doing with today's signal. Active methods are wired into the ladder; shelf methods are concepts kept for comparison and drive nothing. Reading surface only: choosing a card never changes the alert or the position.",
  structureMap:
    "The same holdings laid out by region against exposure type instead of by ladder rung, each cell tinted by its own danger. Read it for SHAPE rather than rank: whether the danger is concentrated in one region or one kind of exposure, or spread evenly across the grid - the thing a sorted list cannot show. Hover or tap a cell for the sleeve behind it. Display-only: it reports the board, it never moves it.",
  rotationQuadrant:
    "The legs plotted as a map instead of a list: horizontal is how dangerous a leg is (calm on the left, dangerous on the right), vertical is which way it is moving (improving up, worsening down). Read the top-left as safe and healing, the bottom-right as dangerous and still deteriorating - a leg heading down-right is the one to watch even while it still reads calm. The ring marks the band candidate and the triangle the leg actually held. Display-only.",
  floors:
    "The escalator floors behind today's alert band - the channels that can lift it above what the danger score alone earned: credit, the cash/haven circuit-breaker, geopolitics, rates, the fast downside early-warn, and a coverage floor that fires when a family is voting on data that is not live. A floor can only RAISE the band, never lower it, and each has its own ceiling, so some can reach CRITICAL and others stop at WATCH. Open it when the band sits above the regime and you want to know WHICH channel lifted it, or to see how close a quiet floor is to firing - every member row shows its own read against its own gate. It sets how LOUD to be, never which ladder rung to hold.",
  indicatorDetail:
    "The raw material under everything above: one indicator plotted over its own history, with the cut-points that turn that line into Green / Amber / Red drawn across it - so a state on the board can be traced back to the number that produced it (a licensed market feed shows its state only). Pick an indicator to plot it, or pick a ladder LEG to be offered the indicators that report into that leg, worst first; the two compare slots overlay a second and third series on the same axis. Reading surface only - nothing chosen here changes the board, the alert or the position.",
  scoreboard:
    "The report card on the STRATEGY, not on today's market: two gates read separately - the drawdown-pain gate and the override gate - measured over the recorded run history against a stated yardstick. Read it to judge whether the machinery is earning its keep over time. The two gates are deliberately not combined into one verdict, and neither auto-decides anything: they inform the human kill decision. Before enough runs exist it says so and leaves the metrics blank rather than inventing them.",
};

/** Local esc (lab.js's is not exported; same table as band-panel.js / scoreboard-card.js). */
function esc(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

/**
 * The ` title="…"` attribute for a section heading, or "" for an unknown key (never a crash,
 * never a literal `undefined` in the markup). The host must ALSO carry `class="… sec-tip"` —
 * see the MOBILE note above.
 * @param {keyof typeof SECTION_TIP | string} key
 */
export function secTip(key) {
  const t = SECTION_TIP[key];
  return t ? ` title="${esc(t)}"` : "";
}
