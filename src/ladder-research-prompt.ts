import type { RungB } from "./ladder-prelabel.js";
import type { LadderPlan } from "./ladder-run.js";

/** The `<leg>:state` fields Rung 0+A's calls come from (ladder-token-cuts `rungAPrompt`). */
type Row = Pick<LadderPlan["research"][number], "sign" | "since" | "fetch" | "query" | "more" | "sides" | "measuredOnly">;
export type ResearchState = Pick<LadderPlan, "today" | "scan" | "verify"> & { research: readonly Row[] };

const sideQueries = (s: Row["sides"]): string[] => (!s ? [] : "both" in s ? [`both sides: ${s.both}`] : [`escalation side: ${s.escalation}`, `fizzle side: ${s.fizzle}`]);

/** The `ladder-research` prompt for Rung 0+A — every `scan`, `verify[]` and research-row call once; `measuredOnly` rows have none. */
export function rungAPrompt(state: ResearchState): string {
  const rows = state.research.filter((r) => !r.measuredOnly);
  const pages = new Map<string, string[]>();
  for (const r of rows) for (const u of r.fetch) pages.set(u, [...(pages.get(u) ?? []), `${r.sign} (since ${r.since})`]);
  const rung0 = [
    ...state.scan.map((q) => `- row scan · search: ${q}`),
    ...state.verify.map((v) => `- row verify: ${v.event} (${v.date}) · ${v.fetch?.length ? `in order: ${[...v.fetch.map((u) => `fetch ${u}`), `search ${v.query}`].join(" → ")}` : `search: ${v.query}`}`),
  ];
  const fetches = [...pages].map(([u, by]) => `- fetch ${u} · rows: ${by.join(", ")}`);
  const searches = rows.flatMap((r) => [...r.query, ...sideQueries(r.sides), ...r.more].map((q) => `- row ${r.sign} (since ${r.since}) · search: ${q}`));
  return [
    `Rung 0+A, today ${state.today}. Run every call below in ONE message and return only the findings table.`,
    "A fetched page with dated items, none bearing on its row → the literal line `row | <oldest item date> | url | fetch | no item on the row | ok` — never a free-text \"nothing found\".",
    ...(rung0.length ? ["", "Rung 0 — horizon + dates:", ...rung0] : []),
    ...(fetches.length ? ["", "Rung A — fetches (one fetch serves every row listed):", ...fetches] : []),
    ...(searches.length ? ["", "Rung A — searches:", ...searches] : []),
  ].join("\n");
}

/** The `ladder-research` prompt for Rung B — each owed row's `extended` search (its first `query` stem) and dating fetch, once. */
export function rungBPrompt(state: ResearchState, b: RungB): string {
  const since = new Map(state.research.map((r) => [r.sign, r]));
  const extended = b.extended.flatMap((s) => { const r = since.get(s); return r?.query[0] ? [`- row ${s} (since ${r.since}) · search extended: ${r.query[0]}`] : []; });
  const dating = b.dating.flatMap((d) => { const r = since.get(d.sign); return r ? [`- row ${d.sign} (since ${r.since}) · fetch ${d.url} — date the item this URL carries`] : []; });
  if (!extended.length && !dating.length) return "";
  return [
    `Rung B, today ${state.today}. Run every call below in ONE message and return only the findings table.`,
    ...(extended.length ? ["", "Rung B — extended searches:", ...extended] : []),
    ...(dating.length ? ["", "Rung B — dating fetches (one line per URL, dated from the page; `—` only if the page shows no date):", ...dating] : []),
  ].join("\n");
}
