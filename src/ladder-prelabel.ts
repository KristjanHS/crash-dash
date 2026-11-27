import { isNoItem, type Finding } from "./ladder-findings.js";
import { labelDate, RESEARCH_LABEL } from "./ladder-labels.js";
import type { LadderSource } from "./ladder-live.js";
import type { Measured } from "./ladder-run.js";

/** The `<leg>:state` research-row fields the pre-labeler reads. */
export type PrelabelRow = { sign: string; since: string; held: string | null; extended?: boolean; measured?: Measured; measuredOnly?: true };
/** `label` set = mechanical; unset = a judgement row (CHANGED vs UNCHANGED) whose `date` is the in-window label date. */
type Prelabel = { sign: string; label?: string; date?: string; sources?: LadderSource[]; why: string };
/** Rung B's owed calls: `extended` = row signs; `dating` = ≤ 1 undated line's URL per row. */
export type RungB = { extended: string[]; dating: { sign: string; url: string }[] };
export type PrelabelOut = { rows: Prelabel[]; patch: { signs: Record<string, { label: string; sources?: LadderSource[]; measuredOnly?: true }> }; rungB: RungB };

const src = (f: Finding): LadderSource => ({ date: f.date!, url: f.url });
const newest = (fs: readonly Finding[]): Finding => [...fs].sort((a, b) => b.date!.localeCompare(a.date!))[0]!;
/** A `measured` reading is a finding on every row (skill step 1); a `measuredOnly` row has no other lines. */
const linesOf = (r: PrelabelRow, lines: readonly Finding[]): Finding[] => {
  const m = r.measured && "sources" in r.measured ? r.measured : undefined;
  const own = m ? m.sources.map((s) => ({ row: r.sign, date: s.date, url: s.url, via: "fetch", fact: m.text, status: "ok" as const })) : [];
  return r.measuredOnly ? own : [...lines.filter((l) => l.row === r.sign), ...own];
};

/** One row's label by the skill's label table: in-window finding (measured included) → judgement dated max(held, newest); `held` → `UNCHANGED <held>`; same-year older → `STALE`; ok `no item` → `QUIET since max(since, its date)`; else `UNSOURCED`. */
const prelabelRow = (r: PrelabelRow, lines: readonly Finding[], today: string): Prelabel => {
  const own = linesOf(r, lines).filter((l) => l.status === "ok");
  const found = own.filter((l) => l.date !== null && !isNoItem(l) && l.date <= today);
  // The same-year test binds STALE only: a window opened last December still reads December findings.
  const inWindow = found.filter((l) => l.date! >= r.since);
  const dated = found.filter((l) => l.date!.slice(0, 4) === today.slice(0, 4));
  // Apply dates the label off the row's held sources too (`postPatchSources`), so `held` floors the hint.
  if (inWindow.length) return { sign: r.sign, date: labelDate([...inWindow.map(src), ...(r.held ? [{ date: r.held, url: "" }] : [])]), sources: inWindow.map(src), why: "in-window finding" };
  if (r.held) return { sign: r.sign, label: `UNCHANGED ${r.held.slice(5)}`, sources: [], why: "held, no in-window finding" };
  if (dated.length) { const f = newest(dated); return { sign: r.sign, label: `STALE ${f.date!.slice(5)}`, sources: [src(f)], why: "same-year finding older than since" }; }
  const quiet = own.find(isNoItem);
  if (quiet) {
    const on = quiet.date && quiet.date > r.since ? quiet.date : r.since;
    return { sign: r.sign, label: `QUIET since ${on.slice(5)}${/^https?:\/\/\S+$/.test(quiet.url) ? ` ${quiet.url}` : ""}`, sources: [], why: "listing with no item on the row" };
  }
  return { sign: r.sign, label: "UNSOURCED", sources: [], why: "no usable source" };
};

const host = (u: string): string | undefined => /^https?:\/\/(?:www\.)?([^/\s?#:]+)/i.exec(u)?.[1]?.toLowerCase();
/** Skill step 2 Rung B: rows with no in-window finding owe their `extended` search, and — unless `held` — ONE dating fetch of an undated line, never to a domain that FAILED this run or to `roic.ai`. */
const rungBOf = (rows: readonly PrelabelRow[], out: readonly Prelabel[], lines: readonly Finding[]): RungB => {
  const failed = new Set(lines.filter((l) => l.status === "FAILED").map((l) => host(l.url)));
  const datable = (l: Finding): boolean => { const h = host(l.url); return h !== undefined && !failed.has(h) && h !== "roic.ai" && !h.endsWith(".roic.ai"); };
  const open = rows.filter((r, i) => out[i]!.label !== undefined && !r.measuredOnly);
  const dating = open.filter((r) => !r.held).flatMap((r) => {
    const l = lines.find((x) => x.row === r.sign && x.status === "ok" && x.date === null && !isNoItem(x) && datable(x));
    return l ? [{ sign: r.sign, url: l.url }] : [];
  });
  return { extended: open.filter((r) => r.extended).map((r) => r.sign), dating };
};

/** Pre-labels every research row and the apply-patch stub: mechanical rows filled, judgement rows `{label: ""}`. */
export const prelabel = (rows: readonly PrelabelRow[], lines: readonly Finding[], today: string): PrelabelOut => {
  const out = rows.map((r) => prelabelRow(r, lines, today));
  for (const p of out) if (p.label !== undefined && !RESEARCH_LABEL.test(p.label)) throw new Error(`pre-label "${p.label}" for ${p.sign} breaks RESEARCH_LABEL`);
  const only = (i: number) => (rows[i]!.measuredOnly ? { measuredOnly: true as const } : {});
  return { rows: out, patch: { signs: Object.fromEntries(out.map((p, i) => [p.sign, p.label === undefined ? { label: "", ...only(i) } : { label: p.label, sources: p.sources, ...only(i) }])) }, rungB: rungBOf(rows, out, lines) };
};
