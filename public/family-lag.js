/**
 * The FAMILIES-BOARD feed-lag roll-up — one mark per family header.
 *
 * The measurement rides the wire (`d.feedLag`, `FeedLagNote[]`); this seam paints one mark per family
 * so a GREEN chip whose feed stopped reporting days ago no longer reads as a measured calm.
 *
 * A pure seam (`.claude/rules/frontend.md`): DOM-free, no module-level side effects, plain `.js` so
 * vitest collects it and `tsc` ignores it — `lab.js`/`app.js` execute DOM/`localStorage` side
 * effects at import and can never be reached from a test.
 *
 * ⚠ PER-TILE ROLL-UP ONLY, never a per-chip mark on a member: a chip carries the member's RAG colour,
 * and feed-lag marks are diagnostics that must leave operational columns. WHICH member is behind needs a hover.
 *
 * ⚠ NO LAGGING FEED MAY VANISH FROM THE BOARD. A roster-only join silently
 * drops any marked feed that belongs to no family's served `members` — and that set is not empty:
 * `F7`/CAPE is a real persisted series (`src/registry.ts`, CONTEXT channel, never scored) whose
 * family stub `valuation` has `FamilyDef.ids: []`, so a lagging CAPE appears in no roster at all.
 * Hence the join is two-level with an UNCONDITIONAL residual (`familyLagMarks` below): served
 * roster → the family's ABSENT roster (`absentIds`) → `orphans`. The residual is what makes
 * "nothing vanishes" a guarantee rather than a claim that holds only while the rosters are
 * complete, and `family-lag.test.js` pins it as a PARTITION, not as three separate cases.
 *
 * The residual closes the ROSTER leak; the second leak is the LABEL one, and it is closed the same
 * way: the FE does not re-filter the served list by label. `api/lab.ts` already dropped everything it
 * classified as unmarked, so a label this file's `tierOf` table does not recognize means the FE
 * MIRROR drifted, not that the feed is fine — and dropping it would remove the feed from `byFamily`
 * and `orphans` both, on the one path built to guarantee it cannot disappear. Such an entry is
 * marked at the quiet `sig-lag-soft` tier instead.
 *
 * ⚠ This is NOT `verdictHoldIds` (`src/families.ts`) and must never be folded into it. That field
 * fires only for a lagging member that IS the family's worst state — one holding the family verdict
 * up — and it ARMS THE COVERAGE FLOOR. The motivating case is exactly the one it cannot see: EU2
 * was GREEN while `credit` was AMBER, so `verdictHoldIds` was `[]` and `coverageDegraded` was `false`
 * on the very day the feed had been silent for nine days. Widening that predicate would arm the floor
 * off a diagnostic. THIS MARK ARMS NOTHING — it is display-only, end to end.
 *
 * ⚠ The mark lights for reasons outside our control: EU2's nine unpublished days were an ECB publication
 * pause, verified upstream. Copy must read "this feed is behind", never "something is broken here".
 */
import { esc } from "./chart-primitives.js";
import { lagMeasure } from "./feed-lag-foot.js";
import { idIfDistinct } from "./leading-name.js";

/**
 * FE mirror of `lagTier` (`src/feed-lag.ts`): `DEEP-LAG`/`NO-DATA` are the heavier tier,
 * `LAG`/`MISCADENCED` the quiet one, anything else is not a mark at all.
 *
 * Re-encoded here only because a `public/*.js` module is unbundled browser ESM and cannot import a
 * `.ts` source. It is NOT a second source of truth by consent: `family-lag.test.js` imports the real
 * `lagTier` AND parses the `export type Label` union out of `src/feed-lag.ts` AS TEXT, then drives the
 * parity cases off that parsed list — a `Label` union is a TS type with no runtime handle, so a
 * hand-copied `it.each` list would have gone on passing while a NEW label drifted past this table.
 * Adding a member to `Label` therefore reds the FE suite on the next run
 * (`.claude/rules/frontend.md` — an FE test pins against the server truth rather than re-typing it).
 *
 * ⚠ Returning `null` here is NOT permission to DROP a note (see `familyLagMarks`): the served list is
 * already all-marked by the server, so an unrecognized label means this table drifted, and the drift
 * must show as a quiet-tier mark rather than as a feed silently missing from the board.
 */
export function tierOf(label) {
  if (label === "DEEP-LAG" || label === "NO-DATA") return "deep";
  if (label === "MISCADENCED" || label === "LAG") return "soft";
  return null;
}

/** Rule 2 (`public/prose-names.test.ts`): a feed id IS a registry key, so it never renders bare as
 *  element text — it is paired with the served member label via `idIfDistinct`, exactly as
 *  `feedLagFootHtml` does (a label that already restates the id collapses to the label alone). */
function nameOf(id, labels) {
  const lab = (labels || {})[id];
  return [idIfDistinct(lab, id), lab].filter(Boolean).join(" ");
}

/**
 * Build one mark from an already-selected set of notes. Shared by the per-family and orphan paths so
 * the two can never disagree on tier, glyph or tooltip shape.
 *
 * `⌁` is the glyph, with the count as a superscript (`⌁¹`). It is already the per-ROW feed-lag
 * roll-up in the `/lab` ledger (`legLagMark`, `cell-observed.js`); a per-FAMILY roll-up is the
 * same claim on a different axis. `◌` stays the per-cell mark and is not used here. `⊗` (the
 * coverage floor) is untouched — `public/coverage-marks.test.js` pins that it is never `◌`/`⌁`.
 *
 * Worst-of tier: any `deepLag` note ⇒ `sig-lag-deep`, the heavier tier (at least one feed is in deep lag), else
 * `sig-lag-soft`, the quiet one (lag, not deep lag). Tier only; no second glyph, no extra characters.
 *
 * ⚠ NEITHER TIER IS A SIGNAL COLOUR. These
 * marks are diagnostics about our SIGHT of a feed, not an operational reading, so both classes
 * paint from the neutral `--lag-diag` / `--lag-diag-hi` ramp declared in lab.html's `:root`,
 * separated by luminance alone — the ledger legend calls them "soft grey = lag · bright grey =
 * deep lag". `sig-lag-deep` used to borrow `--danger` (= `--state-red`, the operational alarm ink), which
 * made a transient publisher pause read like an F1 RED firing; do not restore it. The coverage `⊗`
 * badge (`.sig-flip` / `.leg-flip`) DOES stay on `--danger` on purpose — an unseeable verdict
 * floors the band, so it is an alarm condition rather than a lag diagnostic.
 *
 * A note whose label this FE table does not recognize (`tierOf` → `null`) falls into that same
 * `sig-lag-soft` default rather than being dropped — an unmarked-by-us note is still a SERVED note,
 * and the quiet tier is the visible-but-unalarming way to say "behind, tier unknown to this build".
 *
 * @returns {{cls: "sig-lag-deep"|"sig-lag-soft", count: number, ids: string[], which: string,
 *   html: string}|null} `null` when nothing is marked — the happy path renders an EMPTY header
 *   slot, never a `⌁⁰` (the same rule `legCellLagMark` follows).
 *
 * `ids` is the marked set, carried explicitly rather than left to be recovered from `which`: the
 * measurement clause itself contains ` · `, so `which` has no fixed arity per note and cannot be
 * parsed back. The partition test asserts over `ids` AND checks each name reached `html`, so the
 * field can never claim coverage the rendered mark does not have.
 */
function markFrom(notes, labels, scopeCopy) {
  if (notes.length === 0) return null;
  const cls = notes.some((n) => tierOf(n.label) === "deep") ? "sig-lag-deep" : "sig-lag-soft";
  const which = notes
    .map((n) => `${nameOf(n.id, labels)} · ${n.label} · ${lagMeasure(n)}`)
    .join(" · ");
  const tier =
    cls === "sig-lag-deep"
      ? "at least one feed here broke its own rhythm (deep lag, not merely lag)"
      : "at least one feed here is lagging - behind, not deep lag";
  const title = `feed lag - ${scopeCopy}: ${tier}. ${which}`;
  return {
    cls,
    count: notes.length,
    ids: notes.map((n) => n.id),
    which,
    html: `<span class="fam-lag ${cls}" title="${esc(title)}">⌁<sup class="fam-lag-n">${notes.length}</sup></span>`,
  };
}

/**
 * The per-family roll-up, for ONE id set. Joins it against the served `feedLag` list — a pure join on
 * `id`, no new wire field.
 *
 * ⚠ TEST-ONLY ENTRY POINT (`@internal`). No production caller: the board goes through
 * `familyLagMarks`, which reaches the shared `markFrom` directly. It is kept because its cases in
 * `family-lag.test.js` exercise shipped code (`markFrom`, `lagMeasure`, `nameOf`, `tierOf`) through a
 * thin wrapper. THE RISK IF SOMETHING EVER CALLS IT FROM `lab.js`: this entry point does the
 * SINGLE-level join only — it sees neither the family's ABSENT roster (`absentIds`) nor the
 * unconditional `orphans` residual — so a marked feed on no roster it was handed would reach no
 * mark at all. That is exactly the vanishing bug the ⚠ block at the top of this file forbids. A new
 * production call site must use `familyLagMarks`, not this.
 *
 * @param {ReadonlyArray<string>} ids the family's id set (served `members[].id` ∪ `absentIds`)
 * @param {ReadonlyArray<{id: string, label: string, age: number|null, p90Gap: number|null,
 *   deepLagBar: number|null, registered: string}>} feedLag the served `d.feedLag`
 * @param {Record<string, string>} [labels] member-id → served member label, passed IN so this seam
 *   reaches for no module global (the `feedLagFootHtml` convention)
 * @returns {{cls: "sig-lag-deep"|"sig-lag-soft", count: number, which: string, html: string}|null}
 *
 * Degrades to `null` — "nothing fired" — on a missing or short `feedLag`/`ids` (a degraded read),
 * never to a mark. A degraded freshness read serves `[]` and the board then carries no marks, which
 * is the same thing the footnote does, so the two surfaces agree.
 *
 * EVERY served entry whose id is in `ids` is marked, including one whose label `tierOf` does not
 * recognize — the server already decided what is marked (`api/lab.ts` serves only notes with a
 * non-null `lagTier`), and re-litigating that decision on the FE is what makes a feed vanish. An
 * unrecognized label takes the quiet `sig-lag-soft` default via `markFrom`.
 */
export function familyLagMark(ids, feedLag, labels) {
  const want = new Set(Array.isArray(ids) ? ids : []);
  const list = Array.isArray(feedLag) ? feedLag : [];
  const notes = list.filter((n) => n && want.has(n.id));
  return markFrom(notes, labels, "this family");
}

/**
 * The BOARD-level entry point: every family's mark plus the residual, in one pass.
 *
 * The join is two-level, then unconditional residual (see the ⚠ block at the top of this file):
 *   (a) the family's served roster — `f.members[].id`, the normal path;
 *   (b) the family's ABSENT roster — `f.absentIds[]`, already on the wire (`src/families.ts`:
 *       "`FamilyDef.ids` minus the ids that reported this run"). A feed lagging enough to drop out of
 *       `members` entirely is exactly the case a roster-only join would lose;
 *   (c) `orphans` — every marked id matched by neither, rolled into ONE mark for the board header.
 *
 * A marked id claimed by two families (an id on two rosters) marks both — the mark is a diagnostic,
 * not a count of feeds, so double-marking is honest and under-marking is not. It is still counted
 * as matched exactly once for the partition, which is why `orphans` is computed from the matched
 * SET rather than by subtracting counts. (`family-lag.test.js`'s partition pool carries an id on two
 * rosters, and asserts BOTH families mark — a regression to count-subtraction reds there.)
 *
 * ⚠ THE SERVED LIST IS TAKEN AS AUTHORITATIVE, NOT RE-FILTERED. `api/lab.ts` already serves only the
 * notes it classified as marked (`lagTier(row.label) !== null`), so every entry on the wire belongs
 * on the board. This function therefore filters on SHAPE (an object with an id) and never on label:
 * dropping an entry whose label `tierOf` does not recognize would delete a served feed from BOTH
 * `byFamily` and `orphans` — the exact silent vanishing the ⚠ block at the top of this file forbids,
 * and it would happen precisely when the FE table has drifted from the server ladder. An
 * unrecognized label is marked at the quiet `sig-lag-soft` tier instead (`markFrom`), so the drift is
 * visible rather than silent.
 *
 * @param {ReadonlyArray<{key: string, members?: Array<{id: string, label?: string}>,
 *   absentIds?: ReadonlyArray<string>}>} families the served `d.globalFamilies`
 * @param {ReadonlyArray<object>} feedLag the served `d.feedLag`
 * @param {Record<string, string>} [labels] member-id → served member label
 * @returns {{byFamily: Map<string, object>, orphans: object|null}}
 *   `byFamily` holds ONLY the families that fired (an unmarked family has no entry, so callers
 *   render an empty slot rather than a `⌁⁰`); `orphans` is `null` when every marked id found a
 *   family, which is the expected steady state.
 */
export function familyLagMarks(families, feedLag, labels) {
  const fams = Array.isArray(families) ? families : [];
  const list = (Array.isArray(feedLag) ? feedLag : []).filter((n) => n && n.id);
  const byFamily = new Map();
  const matched = new Set();

  for (const f of fams) {
    if (!f || !f.key) continue;
    const ids = new Set([
      ...(Array.isArray(f.members) ? f.members.map((m) => m && m.id).filter(Boolean) : []),
      ...(Array.isArray(f.absentIds) ? f.absentIds.filter(Boolean) : []),
    ]);
    const notes = list.filter((n) => ids.has(n.id));
    if (notes.length === 0) continue;
    for (const n of notes) matched.add(n.id);
    const mark = markFrom(notes, labels, "this family");
    if (mark) byFamily.set(f.key, mark);
  }

  const stray = list.filter((n) => !matched.has(n.id));
  const orphans = markFrom(
    stray,
    labels,
    "behind, and on no family's roster - visible here so it cannot vanish from the board",
  );
  return { byFamily, orphans };
}

/**
 * The TILE-HEADER slot's inner markup for one family — the ONE producer both `/lab` paint paths
 * call (`lab.js`: `buildTiles` at build, and the `applyBoard` tile loop on every poll), so the
 * mark's markup exists in exactly one place. This is `legStripHtml`'s shape, deliberately chosen
 * over the local `.dot`/`.st`/`.t-diff` empty-slot-then-fill idiom: a mark emitted only in
 * `buildTiles` paints on load and goes stale — or vanishes — on the first board update.
 *
 * Pure and idempotent over the SAME `marks` (it only reads the map), which is what lets
 * `lab.family-lag.test.js` render twice and assert the mark survives without a DOM.
 *
 * @returns {string} `""` when this family fired nothing — the happy path leaves the slot EMPTY
 *   (`.t-lag:empty { display: none }`), never a `⌁⁰`.
 */
export function familyLagSlotHtml(marks, key) {
  const mark = marks && marks.byFamily instanceof Map ? marks.byFamily.get(key) : null;
  return mark ? mark.html : "";
}

/**
 * The BOARD-HEADER residual slot: the one mark for every marked feed on no family's roster
 * (`familyLagMarks`' `orphans`). Painted every `applyBoard` from the same producer as the tiles.
 *
 * Usually `""` — and that is not a reason to skip it. It is what makes "no lagging feed vanishes from
 * the board" a GUARANTEE rather than a claim that holds only while the rosters
 * are complete: `F7`/CAPE is a real persisted series whose family stub carries `FamilyDef.ids: []`,
 * so a lagging CAPE reaches no tile at all and would otherwise be visible only in the footnote.
 *
 * @returns {string} `""` when every marked id found a family — the expected steady state.
 */
export function orphanLagSlotHtml(marks) {
  return marks && marks.orphans ? marks.orphans.html : "";
}
