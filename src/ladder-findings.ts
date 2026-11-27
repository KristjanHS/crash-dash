/** The `ladder-research` findings table (`.claude/agents/ladder-research.md`): `row | YYYY-MM-DD or — | url | fetch or search | fact | ok or FAILED`. */
export type Finding = { row: string; date: string | null; url: string; via: string; fact: string; status: "ok" | "FAILED" };

/** The fact a listing that shows nothing on the row carries; its date is the listing's oldest item. */
const NO_ITEM = "no item on the row";
export const isNoItem = (f: Pick<Finding, "fact">): boolean => f.fact.toLowerCase().startsWith(NO_ITEM);

const SEPARATOR = /^:?-{2,}:?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** `—`, `undated` and a month-only `YYYY-MM` carry no MM-DD to date a label → `date: null`. */
const UNDATED = /^(|—|-|–|undated|\d{4}-\d{2})$/i;

/** Every table line in `text` (repeated tables included); header + separator lines skipped, prose lines without a `|` ignored, a row's ` (…)` suffix dropped. Throws on a short line, a malformed date or an unknown status. */
export const parseFindings = (text: string): Finding[] => {
  const out: Finding[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.includes("|")) continue;
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.every((c) => SEPARATOR.test(c) || c === "")) continue;
    if (cells[0]?.toLowerCase() === "row") continue;
    if (cells.length < 6) throw new Error(`findings line has ${cells.length} cells, want 6: ${line}`);
    const [row, date, url, via] = cells as [string, string, string, string];
    const status = cells.at(-1)!;
    const fact = cells.slice(4, -1).join(" | ");
    if (status !== "ok" && status !== "FAILED") throw new Error(`findings line has unknown status "${status}": ${line}`);
    if (!UNDATED.test(date) && !DATE.test(date)) throw new Error(`findings line has malformed date "${date}": ${line}`);
    out.push({ row: row.replace(/^`|`$/g, "").replace(/\s+\(.*\)$/, ""), date: UNDATED.test(date) ? null : date, url: url.replace(/^<|>$/g, ""), via, fact, status });
  }
  return out;
};
