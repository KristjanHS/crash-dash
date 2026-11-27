/**
 * The `/lab` ledger's FEED-LAG FOOTNOTE — a pure seam.
 *
 * The nullable-`age`/`p90Gap` guard below is load-bearing, and `lab.js` executes DOM/`localStorage`
 * side effects at import so no test can reach it there (`.claude/rules/frontend.md` — testable
 * slices live in a pure seam module). DOM-free, no module-level side effects, covered by
 * `feed-lag-foot.test.js`.
 *
 * One clause per feed `/lab` classified as marked (`d.feedLag`, `FeedLagNote[]` from
 * `src/feed-lag.ts`), e.g. `EBP · LAG · 71d vs lag cut 70d · deep-lag bar 80d · registered monthly`, so the
 * ledger's Lag-column `⌁`/`◌` marks are falsifiable rather than an unexplained smudge.
 *
 * ⚠ The bars are `lagCut` and `deepLagBar`, NEVER `p90Gap` — see `lagMeasure`.
 *
 * ⚠ `age`, `deepLagBar` and `p90Gap` are NULLABLE — null for `NO-DATA` (no newest observation to age
 * from) and for every `?s=lag:<id>` knob-forced entry (the knob ASSERTS a classification, it does
 * not measure one). They render `—`; printing `0d` would be the substitute-a-value-for-an-absence
 * defect this whole wave removes. When ALL are null there is nothing measured to compare at all,
 * so they collapse to a single `—` (`F1 · LAG · — · registered daily`) rather than the hollow
 * `— vs lag cut — · deep-lag bar —`. An empty list renders nothing.
 */
import { esc } from "./chart-primitives.js";
import { idIfDistinct } from "./leading-name.js";

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** The measurement clause for one note, shared with the families-board roll-up (`family-lag.js`): age
 *  against the two bars the classifier applies — `lagCut` (crossed ⇒ LAG) then `deepLagBar`. `p90Gap`
 *  renders only for MISCADENCED, the one label it decides — on a monthly feed it is obs spacing, not an age norm. */
export function lagMeasure(n) {
  // Nothing measured on ANY axis ⇒ one `-`, not a hollow clause (`lagCut` is config, not a measurement).
  if (!finite(n.age) && !finite(n.deepLagBar) && !finite(n.p90Gap)) return "-";
  const days = (v) => (finite(v) ? `${v}d` : "-");
  const own = n.label === "MISCADENCED" ? ` · own p90 ${days(n.p90Gap)}` : "";
  return `${days(n.age)} vs lag cut ${days(n.lagCut)} · deep-lag bar ${days(n.deepLagBar)}${own}`;
}

/**
 * @param {Array<{id: string, label: string, age: number|null, p90Gap: number|null, deepLagBar: number|null, lagCut?: number|null, registered: string}>} notes
 *   the served `feedLag` list
 * @param {Record<string, string>} labels member-id → served member label (`dangerModel.memberLabel`
 *   at the `lab.js` call site — passed IN so this seam reaches for no module global)
 * @returns {string} the footnote markup, or `""` when nothing is marked
 */
export function feedLagFootHtml(notes, labels) {
  const list = Array.isArray(notes) ? notes : [];
  if (list.length === 0) return "";
  const lbls = labels || {};
  const lines = list
    .map((n) => {
      const measure = lagMeasure(n);
      // Rule 2 (`prose-names.test.ts`): a feed id IS a registry key, so it never
      // renders bare as element text — it is paired with the served member label via
      // `idIfDistinct` exactly as the cell tooltips do (a restating id collapses to the label).
      const lab = lbls[n.id];
      const name = [idIfDistinct(lab, n.id), lab].filter(Boolean).join(" ");
      return `<span class="df-foot-lag">${esc(name)} · ${esc(n.label)} · ${measure} · registered ${esc(n.registered)}</span>`;
    })
    .join("");
  return (
    `<span class="df-foot-note df-foot-lags" title="Feeds behind the rhythm expected of them - the justification for the ledger's Lag-column ⌁/◌ marks. LAG = aged past its lag cut (the publisher's expected delay) but still under its deep-lag bar. DEEP-LAG = aged past the deep-lag bar (twice its own p90, or twice its registered cadence tier where the registry set one). MISCADENCED = past the cut but within its own p90 spacing. - = not measured (NO-DATA, or a ?s=lag: knob assertion).">` +
    `<b>feed lag</b>${lines}</span>`
  );
}
