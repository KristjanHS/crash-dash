/**
 * `/lab`'s COVERAGE surface — the `⊗` member badge + the one-line ledger legend.
 *
 * Pure module (no DOM, no module-level side effects) so vitest collects it while `tsc`
 * (no allowJs) ignores it — the same seam idiom as `leg-attribution.js` / `feed-lag-foot.js`.
 * `lab.js` executes DOM/`localStorage` side effects at import and can never be reached by a test,
 * so the markup logic lives HERE.
 *
 * WHAT IT REPORTS. `LabResponse.coverage` is the list of families whose verdict the served run
 * rested on data that is NOT LIVE — each with the exact members (`lag`, past their own
 * `lagCutFor`; or `absent`, they did not report) holding it. That condition ARMS the coverage
 * floor (`coverageArmed`, alert-band.ts), which caps the band at `WATCH`. So `⊗` means *not live, and
 * arming the coverage floor* — never "the market moved". The forced-RED index-feed flip this seam
 * used to render is RETIRED (R1); a lagging member now folds its last-known state and speaks only
 * through this floor.
 *
 * ⚠ DOM CLASSES AND IDS ARE DELIBERATELY UNCHANGED across that rename — `.leg-flip`, `.sig-flip`,
 * `.df-flip-legend` and the host `#dfFlipLegend`. `public/lab.html`'s scoped `<style>` block already
 * styles all four, and the class-parity guard in `coverage-marks.test.js` reads them straight out of
 * this source; renaming the classes would buy nothing and break both.
 *
 * ⚠ The glyph is `⊗`, and it is NEVER `◌`/`⌁`. Those two are FEED-LAG diagnostics ("behind, but not
 * arming") and live in the ledger's `Lag` column; this one says the band was FLOORED because we
 * cannot see — a different claim that must not be read as the same one.
 *
 * ⚠ EVERY FIELD THE LEGEND PRINTS IS RECORDED AT RUN TIME — except the member's NAME, which is the
 * served `dangerModel.memberLabel` short label (a registry-derived display map, not a run
 * measurement; the raw feed symbol `CoverageMark.series` carries is no longer rendered). The
 * `ageDays` the lag cut was applied to rides the mark itself, straight off the persisted
 * alert row — so this seam never mixes in a REQUEST-path measurement (`feedLag`, which the read path
 * recomputes today and which drifts the moment the cron pauses or the alert row is not today's). A
 * null `ageDays` drops the age clause rather than fabricating a `0d` (the
 * substitute-a-value-for-an-absence defect `feed-lag-foot.js` also refuses).
 */
import { esc } from "./chart-primitives.js";

/** The coverage glyph. Deliberately distinct from the `◌`/`⌁` feed-lag marks. */
export const COVERAGE_GLYPH = "⊗";

/**
 * Index the served coverage MARKS by member id — the `attributionIndex` idiom, so the two board
 * paints (`buildTiles` and the `applyBoard` refresh) share one derivation. Both call sites hoist
 * the call ABOVE their per-family loop, so one payload yields one index. The family key and its
 * held verdict ride each entry, so a badge can name them without a second lookup.
 * @param {{coverage?: Array<{family?: string, verdict?: string,
 *   members?: Array<{id: string}>}>}|undefined} d the served `/api/lab` payload
 * @returns {Record<string, {id: string, reason: string, series: string|null, state: string|null,
 *   ageDays: number|null, family: string, verdict: string}>}
 */
export function coverageIndex(d) {
  const list = (d && d.coverage) || [];
  const byId = {};
  for (const c of list) {
    for (const m of (c && c.members) || []) {
      if (m && m.id) byId[m.id] = { ...m, family: c.family, verdict: c.verdict };
    }
  }
  return byId;
}

/**
 * The `⊗` badge for ONE member chip, or `""` when that member is live.
 *
 * Emits a LEADING space (the `leg-axis`/`leg-declined` badge convention in `lab.js`) and carries no
 * `data-id`: `applyBoard` wires every `.ids [data-id]` as a click/keyboard target that cycles a
 * member's state, and the badge is an annotation, not a leg.
 * The member is NAMED by its official SHORT label (Rule 2, `public/prose-names.test.ts`: a registry
 * id never renders bare in user-visible copy) — the same rule the sibling legend line follows. The
 * name comes from the chip's own served `member.label`; a member served without one degrades to its
 * id, exactly as the chip text does.
 * @param {{id?: string, reason?: string, ageDays?: number|null, family?: string,
 *   verdict?: string}|undefined} mark
 * @param {string|undefined} [name] the member's served short label
 * @returns {string} the badge markup, or "" when the member is not a coverage mark
 */
export function coverageBadgeHtml(mark, name) {
  if (!mark || !mark.reason) return "";
  const age = mark.ageDays;
  const aged = typeof age === "number" && Number.isFinite(age);
  // `carried` = absent this run but folded on its own IN-CUT last close, so it arms NO floor (distinct
  // from `lag`/`absent`, which do); its title says so rather than claiming the WATCH floor.
  const why =
    mark.reason === "absent"
      ? "absent"
      : mark.reason === "carried"
        ? aged
          ? `carried ${age}d`
          : "carried"
        : aged
          ? `lag ${age}d`
          : "lag";
  const who = name || mark.id;
  const title =
    mark.reason === "carried"
      ? `${who} is not live (${why}) - folded into ${mark.family}'s ${mark.verdict} verdict on its ` +
        `last-known close, still within its lag cut, so it does not arm the coverage floor`
      : `${who} is not live (${why}) and is holding ${mark.family}'s ${mark.verdict} verdict - ` +
        `this arms the coverage floor (band ≥ WATCH)`;
  return ` <span class="leg-flip" data-flip="${esc(mark.reason)}" title="${esc(title)}">${COVERAGE_GLYPH}</span>`;
}

/**
 * The ONE ledger-legend line naming which families are being held up by data we cannot see.
 *
 * Renders NOTHING for an empty/absent list — the healthy state. The host is its own always-visible
 * line under the ledger head (`<p class="df-live-line" id="dfFlipLegend">`, a sibling of the
 * collapsed `#dfLegend`): this is a LIVE READING of an active degradation, so the
 * legend disclosure must never swallow it. Returning `""` leaves that `<p>` childless and
 * `#dfFlipLegend:empty { display: none }` (lab.html) collapses it, so a healthy board pays zero
 * height for the line.
 * The family, its held verdict and the run-time age all ride the served coverage entry itself —
 * recorded on the run that pushed the dial, never measured on this request. The member's NAME is the
 * served short label (`labels`), so the line reads `rates GREEN held by MOVE, 15d old` rather than
 * naming a registry id or a feed symbol nobody recognises.
 * @param {Array<{family: string, verdict: string, members?: Array<{id: string, reason?: string,
 *   series?: string|null, ageDays?: number|null}>}>|undefined} coverage served `coverage`
 * @param {Record<string, string>|undefined} labels member-id → served short label
 *   (`dangerModel.memberLabel`) — the SAME map the ledger footnote renders names from
 * @returns {string} the legend markup, or "" when the run's coverage was clean
 */
export function coverageLegendHtml(coverage, labels) {
  const list = Array.isArray(coverage) ? coverage.filter((c) => c && c.family) : [];
  if (list.length === 0) return "";
  // Rule 2 (Addendum C): the OFFICIAL SHORT NAME alone (`Indicator.label`, served as
  // `dangerModel.memberLabel`) — the same map the feed-lag footnote names members from. Neither the
  // registry id nor the raw feed symbol (`BAMLC0A0CM`) is a name a reader recognises; the id survives
  // only as the fallback when no label was served. `ageDays` is nullable on the wire ("not assessed"/
  // absent, never "fresh"): print no age clause rather than a fabricated 0d.
  const named = (m) => {
    const name = (labels || {})[m.id] || m.id;
    const age = m.ageDays;
    return typeof age === "number" && Number.isFinite(age) ? `${name}, ${age}d old` : name;
  };
  const clauses = list
    .map((c) => {
      const ms = (c.members || []).filter((m) => m && m.id);
      // A CARRIED member (within its lag cut) rides `c.members` but arms NO floor, so it does not HOLD
      // the verdict — the per-chip badge says the same. List it separately, never under "held by".
      const held = esc(ms.filter((m) => m.reason !== "carried").map(named).join(", "));
      const carried = ms.filter((m) => m.reason === "carried").map(named);
      const carriedNote = carried.length ? ` (${esc(carried.join(", "))} carried, not arming)` : "";
      return `${esc(c.family)} ${esc(c.verdict)} held by ${held}${carriedNote}`;
    })
    .join(" · ");
  const title =
    "The band was floored at WATCH because we cannot SEE, not because the market moved. Each family " +
    "below reached its verdict on data that is not live - a member past its own lag cut, or one " +
    "that did not report at all - so the verdict is last-known, and the floor caps the band at WATCH " +
    "until the feed comes back. The members are named by their short label; their ages are recorded " +
    "on the run that pushed this dial, never measured on this request.";
  return (
    `<span class="df-flip-legend" title="${esc(title)}">` +
    `<span class="sig-flip">${COVERAGE_GLYPH}</span> COVERAGE - ${clauses}` +
    `</span>`
  );
}
