/**
 * The per-cell OBSERVATION census on the front-end.
 *
 * The server ships `SignalCell.observed = { fresh, lag, absent }` (src/danger-engine.ts): `fresh + lag`
 * is the member set that ENTERED the cell's severity max, `absent` the set EXCLUDED from it. Without
 * this a calm `○` on a cell whose members never reported is indistinguishable from a measured calm;
 * these helpers make the difference visible.
 *
 * A pure seam (`.claude/rules/frontend.md`): DOM-free, no module-level side effects, unit-tested in
 * `cell-observed.test.js` — `lab.js` executes DOM/localStorage side effects at import and is never
 * imported from a test.
 *
 * SERVER PARITY: `memberSeverity` is the FE mirror of `severityOf` (src/danger-member-state.ts). The
 * server rule is "no state observed ⇒ ABSENT, no key in the member map"; `memberSeverity` returns
 * `null` for an unobserved state and the caller OMITS THE KEY, exactly as `buildMemberState` does
 * server-side. The parity is pinned against the real `buildMemberState` in `cell-observed.test.js`.
 */

/** The display severity for a member with NO observation — a fourth glyph state alongside
 *  calm/elev/lit, deliberately distinct from `na` (which means "not relevant to this leg"). */
export const ABSENT_SEV = "absent";

/** FE mirror of `severityOf` (src/danger-member-state.ts): RED→lit, AMBER→elev, any other OBSERVED
 *  state→calm, and a null/undefined state (the member did not report) → `null` = ABSENT.
 *  `null` is not "calm": a GREEN reading is an observation, a missing one is not. */
export function memberSeverity(state) {
  if (state === null || state === undefined) return null;
  return state === "RED" ? "lit" : state === "AMBER" ? "elev" : "calm";
}

/** Normalise a served cell's census — degrades a response with no `observed` key to an all-zero census
 *  ("nothing to report"), never a fabricated one.
 *
 *  `deepLag` is the DEEP-LAG SUBSET of `lag` — members whose feed lag classifies `deepLag` (`lagTier`,
 *  src/feed-lag.ts) rather than merely lagging. Same `n()` clamp, so a missing `deepLag` key degrades to
 *  0. The `fresh + lag + absent = N` invariant is untouched: `deepLag` is a subset counter, not a fourth bucket.
 *
 *  `absentIds` — the member ids behind `absent`, served so the footnote can NAME the dark member; a
 *  response without it degrades to `[]`, never invented ids. */
export function censusOf(cell) {
  const o = (cell && cell.observed) || {};
  const n = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const absentIds = Array.isArray(o.absentIds) ? o.absentIds.filter((v) => typeof v === "string") : [];
  return { fresh: n(o.fresh), lag: n(o.lag), absent: n(o.absent), deepLag: n(o.deepLag), absentIds };
}

/** The tooltip clause naming the census, e.g. `obs 2 fresh · 1 lag · 1 absent`.
 *  Empty string when the cell quantifies over no members at all (`na` / structural cells) — an
 *  all-zero census is not a measurement and must not print as one.
 *
 *  ⚠ COUNTS ONLY, no cause — it does not assert why any member is missing.
 *
 *  B2 appends a ` · held <member> …` clause when the server says this cell's severity max landed on a
 *  member the hold window raised (`heldOf`). Every number in it is SERVED — the member, the AGE of the
 *  severity shown (`ageCloses`) and the window it cannot outlive (`closes`) — and it asserts nothing
 *  about why. Omitted entirely when the server named no held member.
 *
 *  ⚠ The hold ENDS AS SOON AS THE MEMBER PRINTS GREEN, so the window is an upper bound and the age is
 *  the fact worth showing: the copy states both and says what releases the hold. An age the server did
 *  not send prints `age unknown`, never a fabricated number (`heldOf`); the FE holds NO copy of any
 *  window value. `0` is reachable (the newest stored close can predate the live panel), and the copy is
 *  true there too. */
export function observedNote(cell) {
  const c = censusOf(cell);
  const total = c.fresh + c.lag + c.absent;
  if (total === 0) return "";
  const h = heldOf(cell);
  const age = heldAgeNote(h);
  const held = h
    ? ` · held ${h.member} - severity from the hold window, ${age}, window ≤${h.closes}; ` +
      `the hold ends when ${h.member} prints green`
    : "";
  return `obs ${c.fresh} fresh · ${c.lag} lag · ${c.absent} absent${held}`;
}

/** Normalise a served cell's `held` mark — the server's statement that the member THIS cell's severity
 *  max landed on was RAISED (or resurrected above calm) by the SIGNAL-HOLD WINDOW, i.e. that member's
 *  state is an earlier close's, which is why the cell can read `elev` while every live chip is green.
 *  `{ member, closes, ageCloses }` or `null` — `ageCloses` is the AGE IN CLOSES of the severity shown
 *  (`0` = the newest stored close), `null` when the payload carried none.
 *
 *  ⚠ It does NOT say the cell would read calmer without the hold — the server's max advances on strict
 *  `>`, so a held member tying a live-lit one still wins the argmax (`SignalCell.held`, src/danger-cell.ts).
 *
 *  ⚠ SCOPED TO THE ARGMAX: a held NON-argmax member still enters the family share (a weighted mean over
 *  every reporting member) yet leaves this mark `null`, so `null` ≠ "the hold contributed nothing".
 *
 *  ⚠ DEFENSIVE, asymmetrically: a missing `held` key, a `null`, or a malformed one (non-string member,
 *  non-finite/non-positive `closes`) all degrade to `null`. It NEVER fabricates a mark or a window length
 *  — the window is the server's (`signalHoldClosesFor`, src/danger-ladder.ts). `member` is passed through
 *  as the served string; the caller escapes it before markup. */
export function heldOf(cell) {
  const h = cell && cell.held;
  if (!h || typeof h !== "object") return null;
  const member = h.member;
  const closes = h.closes;
  if (typeof member !== "string" || member === "") return null;
  if (typeof closes !== "number" || !Number.isFinite(closes) || closes <= 0) return null;
  const age = h.ageCloses;
  // ASYMMETRIC on purpose: a missing/malformed age is `null` = UNKNOWN, and the copy says so. It is
  // never defaulted to 0, to `closes`, or to anything else — an invented age would read as a measured
  // one on screen, and the FE has nothing legitimate to derive it from.
  const ageCloses =
    typeof age === "number" && Number.isFinite(age) && age >= 0 ? Math.floor(age) : null;
  return { member, closes: Math.floor(closes), ageCloses };
}

/** Normalise a served member's `fold` mark — `{ raw, of }` iff its raw state ≠ its confirmed state (mid
 *  directional 2-close stand-down), else `null`. `of` is the server's clean-close count, NEVER an FE
 *  literal; same asymmetric degrade as `heldOf` (missing/malformed → null, never a partial or throw). */
export function foldOf(member) {
  const f = member && member.fold;
  if (!f || typeof f !== "object") return null;
  const raw = f.raw;
  const of = f.of;
  if (typeof raw !== "string" || raw === "") return null;
  if (typeof of !== "number" || !Number.isFinite(of) || of <= 0) return null;
  return { raw, of: Math.floor(of) };
}

/** The ONE age phrase both hold-provenance surfaces print — `observedNote` here and the `ct-held` row of
 *  the live drill-down panel (`cell-tip.js`). One formatter so the two surfaces cannot drift.
 *
 *  Takes a NORMALISED mark (`heldOf`'s output) or `null`, and carries `heldOf`'s ASYMMETRIC degrade to
 *  the screen: a payload that sent no age reads `age unknown` — never `0`, never the window's own number.
 *  Singular at 1 (`1 close back`), and true at `0` (the newest stored close can predate the live panel). */
export function heldAgeNote(h) {
  return h && h.ageCloses !== null
    ? `printed ${h.ageCloses} close${h.ageCloses === 1 ? "" : "s"} back`
    : "age unknown";
}

/** The VISIBLE mark for a cell whose severity ARGMAX MEMBER was raised by the hold window: the
 *  `sig-held` class on the cell (styled in lab.html). `null` when the server named no held argmax.
 *
 *  ⚠ NO GLYPH AND NO SUPERSCRIPT, deliberately. The number the cell shows is the severity; the hold
 *  changes WHERE it came from, not HOW MANY members reported (`absentMark`'s `<sup>` owns the count and
 *  must keep meaning exactly one thing). The member, age and window are in the drill-down panel's
 *  `ct-held` row (`cellTipHtml`, `cell-tip.js`), which states COUNTS AND FACTS ONLY — the served
 *  `member`/`closes`, no claim about WHY the member is held. */
export function heldMark(cell) {
  const h = heldOf(cell);
  if (!h) return null;
  return { cls: "sig-held", member: h.member, closes: h.closes };
}

/** The VISIBLE mark for a cell with ≥1 absent relevant member: a superscript count beside the
 *  glyph plus the `sig-absent` class on the cell (styled in lab.html). `null` when every member
 *  this cell quantifies over reported. */
export function absentMark(cell) {
  const c = censusOf(cell);
  const absent = c.absent;
  if (absent === 0) return null;
  return {
    cls: "sig-absent",
    html: `<sup class="sig-abs-n">${absent}</sup>`,
    count: absent,
  };
}

/**
 * The VISIBLE FEED-LAG mark for a cell whose severity rests on members whose feeds are lagging
 * (§I9.8 J1). A pure sibling of `absentMark`: a MODIFIER, never a replacement — the caller keeps the
 * severity glyph and merely appends `cls` to the cell and `html` beside `absentMark`'s `<sup>`, so a
 * cell can read `○²◌`. Swapping the glyph out would erase the severity map the grid exists to show.
 *
 * Firing predicate (§I1): `lag > 0` off `censusOf`. An all-zero census (an `na` / structural cell)
 * stays unmarked, the same rule `observedNote` follows — an absence of members is not a measurement
 * of lag.
 *
 * ⚠ **`absent` DOES NOT FIRE THIS MARK** — the predicate is `lag > 0` ONLY, never `|| absent > 0`:
 * absence is not lateness, and `absentMark`'s `<sup>` already counts it. The column then agrees with
 * `/api/lab`'s `feedLag: []` and `/api/status`'s `feedsLagging: 0` instead of contradicting them.
 *
 * Two tiers, both painted in lab.html's scoped sheet: `sig-lag-deep` — the heavier tier — when at least
 * one member reads deep lag, else `sig-lag-soft`, the quiet tier.
 *
 * ⚠ The `◌` no longer rides IN the signal cell: both feed-lag marks are DIAGNOSTICS, not operational
 * signal, and live in the ledger's rightmost `Lag` column. This function is the per-cell PREDICATE +
 * tier — consumed by `legLagMark` and `legCellLagMark`, which build what that column renders.
 *
 * ⚠ NEITHER TIER IS A SIGNAL COLOUR. Both classes paint from the neutral `--lag-diag` / `--lag-diag-hi`
 * ramp declared in lab.html's `:root`, separated by luminance alone — the legend calls them "soft grey =
 * lag · bright grey = deep lag". Do NOT restore `--danger` (= `--state-red`) on `sig-lag-deep` — it made
 * a publisher pause read like an F1 RED. The coverage `⊗` badge (`.sig-flip` / `.leg-flip`) DOES stay on
 * `--danger` deliberately: an unseeable verdict floors the band, so it is an alarm, not a lag diagnostic.
 */
export function lagMark(cell) {
  const c = censusOf(cell);
  if (c.lag === 0) return null;
  return { cls: c.deepLag > 0 ? "sig-lag-deep" : "sig-lag-soft", html: `<sup class="sig-lag">◌</sup>` };
}

/**
 * The PER-LEG roll-up of the CELL marks (`◌`), for the rightmost `Lag` column. One `◌` per row carrying
 * the COUNT of the leg's firing cells as a superscript, and the tier of the worst one (`sig-lag-deep` >
 * `sig-lag-soft`) — the same worst-of rule `legLagMark` uses, so the two marks in the column can never
 * disagree on tier. Both tiers paint from the neutral diagnostics ramp, never a signal colour (see
 * `lagMark`). WHICH families fired survives in the title.
 *
 * `null` when no cell fires — the happy path renders an empty column cell, never a `◌⁰`.
 */
export function legCellLagMark(cells) {
  const list = Array.isArray(cells) ? cells : [];
  const firing = list.map((c) => ({ c, m: lagMark(c) })).filter((x) => x.m);
  if (firing.length === 0) return null;
  const cls = firing.some((x) => x.m.cls === "sig-lag-deep") ? "sig-lag-deep" : "sig-lag-soft";
  const which = firing
    .map((x) => `${x.c.family || "?"} ${x.m.cls === "sig-lag-deep" ? "deep lag" : "lag"}`)
    .join(" · ");
  return {
    cls,
    count: firing.length,
    html:
      `<span class="cell-lag ${cls}" title="signal cells resting on feeds that are lagging ` +
      `- ${which}">◌<sup class="cell-lag-n">${firing.length}</sup></span>`,
  };
}

/**
 * The PER-LEG feed-lag mark — the at-a-glance half of the same instrument: it fires when ANY cell of the
 * leg fires `lagMark`, and takes the WORST tier across them (one deep-lag cell ⇒ the heavier tier).
 * Computed here, in the pure seam, off the leg's own cell list — `lab.js` must not recompute the census
 * on a second render path. `cells` may be missing/short (a degraded field), which reads as "nothing fired".
 */
export function legLagMark(cells) {
  const list = Array.isArray(cells) ? cells : [];
  const marks = list.map(lagMark).filter(Boolean);
  if (marks.length === 0) return null;
  const cls = marks.some((m) => m.cls === "sig-lag-deep") ? "sig-lag-deep" : "sig-lag-soft";
  const tier =
    cls === "sig-lag-deep"
      ? "at least one feed behind this leg broke its own rhythm (deep lag, not merely lag)"
      : "at least one feed behind this leg is lagging - behind, not deep lag";
  return { cls, html: `<span class="leg-lag ${cls}" title="feed lag - ${tier}">⌁</span>` };
}

/**
 * What the `Lag` column renders when the payload carries NO freshness stamp at all
 * (`LabResponse.freshnessMissing === true`, the A4 flag).
 *
 * ⚠ Root cause it guards: `obsOf` (`src/danger-engine.ts`) resolves an UNMEASURED member to `obs: "lag"`
 * (neutral for the severity fold). So when `freshnessFrom` throws and `api/lab.ts` serves
 * `freshness: undefined`, EVERY populated cell comes back `observed.lag === N` and the column would
 * assert lagging feeds off ZERO measurements — with `feedLag: []` naming nobody. Do not render that as lag.
 *
 * Rendering NOTHING would be the same defect mirrored — an empty cell reads as "every feed current". So
 * the absence is rendered AS an absence: the `—` its sibling `feed-lag-foot.js` uses for "not measured",
 * on the quiet neutral ramp.
 */
export function unmeasuredLagMark() {
  return {
    cls: "sig-lag-unmeasured",
    html:
      `<span class="leg-lag sig-lag-unmeasured" title="feed lag NOT MEASURED - the freshness stamp ` +
      `was unavailable for this response, so nothing is known about these feeds. Not a claim that ` +
      `they are lagging, and not a claim that they are current.">-</span>`,
  };
}
