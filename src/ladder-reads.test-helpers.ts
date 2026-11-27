// Fixtures for the read-schema parity + Grid tests (src/ladder-reads.test.ts, src/ladder-live.test.ts, public/lab-reentry.test.js,
// public/ladder-views.test.js) — NOT a `.test.ts`, vitest would collect it.
import { watchOf, type Cell, type Roster } from "./ladder-box.js";
import { BOX_INDICATOR, type LadderLive, type ReadTag, type WatchRow } from "./ladder-live.js";

/** A tag no probe emits: its strings are canaries — a renderer that prints any tag field surfaces `TAGGED` in its output. */
export const DUMMY_TAG: ReadTag = { indicator: "TAGGED-indicator", series: ["TAGGED-series"], job: "composite", agg: "box" };

/** The committed `public/<leg>.json` with `tag` stamped on every verdict row and every escalation family — the parity fixture
 *  (a stored file compared with itself would be a tautology: tags reach stored JSON only via `--into`). Deep-copies; `live` is untouched. */
export const injectTags = (live: LadderLive, tag: ReadTag = DUMMY_TAG): LadderLive => {
  const out = structuredClone(live);
  if (out.verdict) {
    out.verdict.legs = out.verdict.legs.map((l) => ({ ...l, tag: { ...tag, series: [...tag.series] } }));
    if (out.verdict.escalation.families) out.verdict.escalation.families = out.verdict.escalation.families.map((f) => ({ ...f, tag: { ...tag, series: [...tag.series] } }));
  }
  return out;
};

/** The committed JSON with every `tag` removed — the untagged fixture once an `--into` run has stamped the stored file (`toVerdict` keeps tags). Deep-copies. */
export const stripTags = (live: LadderLive): LadderLive => {
  const out = structuredClone(live);
  if (out.verdict) {
    out.verdict.legs = out.verdict.legs.map(({ tag: _tag, ...l }) => l);
    if (out.verdict.escalation.families) out.verdict.escalation.families = out.verdict.escalation.families.map(({ tag: _tag, ...f }) => f);
  }
  return out;
};

/** The committed JSON with per-row DISTINCT tags derived from each row's key — the Grid fixture (`injectTags` stamps ONE tag everywhere and
 *  would collapse the grid to one row): same stem across T1–T3 → one multi-tranche row, distinct stems → distinct rows; a `*-esc` row → the
 *  box read (`BOX_INDICATOR`, composite); a family → a box-agg level read on its name. Deep-copies; `live` is untouched. */
export const injectRowTags = (live: LadderLive): LadderLive => {
  const out = structuredClone(live);
  if (out.verdict) {
    out.verdict.legs = out.verdict.legs.map((l) => {
      const indicator = l.key.replace(/^t[123]-/, "");
      const tag: ReadTag = l.key.endsWith("-esc") ? { indicator: BOX_INDICATOR, series: [], job: "composite", agg: "allOf" } : { indicator, series: [indicator], job: l.gate ? "regime" : "level", agg: l.gate ? "allOf" : "kOfN" };
      return { ...l, tag };
    });
    if (out.verdict.escalation.families) out.verdict.escalation.families = out.verdict.escalation.families.map((f) => ({ ...f, tag: { indicator: f.name, series: [f.name], job: "level", agg: "box" } }));
  }
  return out;
};

const WATCH_ROSTER = [{ name: "credit", kind: "coincident", members: ["F1"] }, { name: "macro", kind: "lead", members: ["R5"] }] as const satisfies Roster<string>;
/** `live` + a `verdict.watch` graded by the real `watchOf`: F1/R5 measured (`cells` = their correction cells, bear all `false`), `claims` manual (lean `bear`); `exit` absent = held. Deep-copies. */
export const injectWatch = (live: LadderLive, cells: { F1: Cell; R5: Cell } = { F1: "hit", R5: false }, exit?: string): LadderLive => {
  const out = structuredClone(live);
  const rows: WatchRow[] = [
    { key: "F1", label: "HY OAS", cluster: "credit", now: "3.10", correction: { rule: "≥ 3.00", cell: cells.F1 }, bear: { rule: "≥ 5.00", cell: false } },
    { key: "R5", label: "10y", cluster: "macro", now: "4.10", correction: { rule: "≥ 4.50", cell: cells.R5 }, bear: { rule: "≥ 5.00", cell: false } },
    { key: "claims", label: "ICSA claims", cluster: "macro", now: "—", correction: { rule: "4-wk ≥ 1.15× low", cell: "na" }, bear: { rule: "—", cell: "na" }, manual: true, signs: [{ sign: "claims", lean: "bear", block: false }] },
  ];
  out.verdict = { ...out.verdict!, watch: { held: exit === undefined, ...(exit && { exit }), rows, ...watchOf(WATCH_ROSTER, rows) } };
  return out;
};
