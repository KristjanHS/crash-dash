// Calendar dedupe: exact key refuses at `calendarAdd`, word overlap warns, apply collapses exact groups.
import { gap, type LadderCalendar, type LadderEvent } from "./ladder-live.js";

/** Word-overlap (Jaccard) at or above which a same-sign ±1 d pair prints `calendar possible dup` — warns, never refuses. */
const NEAR_DUP_JACCARD = 0.25;

/** The normalized title: lowercase, `10-year` → `10y`, `results` / `after the close` noise and punctuation dropped. */
function calKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/10-year/g, "10y")
    .replace(/\b(results|after the close)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const words = (title: string): Set<string> => new Set(calKey(title).split(" ").filter((w) => w.length > 1));

function jaccard(a: string, b: string): number {
  const [x, y] = [words(a), words(b)];
  const both = [...x].filter((w) => y.has(w)).length;
  const union = x.size + y.size - both;
  return union ? both / union : 0;
}

type Dated = { date: string; event: string; signs: (string | undefined)[] };
const near = (a: Dated, b: Dated): boolean => Math.abs(gap(a.date, b.date)) <= 1 && a.signs.some((s) => b.signs.includes(s));
const asDated = (x: LadderCalendar | LadderEvent): Dated => ({ date: x.date, event: x.event, signs: "signs" in x ? x.signs : [x.sign] });

/** The calendar row or event that `row` duplicates (same normalized title, a shared sign, dates ±1 d), else undefined. */
function calDupOf(row: LadderCalendar, against: readonly (LadderCalendar | LadderEvent)[]): LadderCalendar | LadderEvent | undefined {
  const r = asDated(row);
  return against.find((x) => x !== row && near(r, asDated(x)) && calKey(x.event) === calKey(row.event));
}

/** `calendar possible dup: …` per non-exact neighbour of `row` whose word overlap reaches `NEAR_DUP_JACCARD`. */
function nearDups(row: LadderCalendar, against: readonly (LadderCalendar | LadderEvent)[]): string[] {
  const r = asDated(row);
  return against
    .filter((x) => x !== row && near(r, asDated(x)) && calKey(x.event) !== calKey(row.event) && jaccard(x.event, row.event) >= NEAR_DUP_JACCARD)
    .map((x) => `calendar possible dup: ${row.event} (${row.date}) ~ ${x.event} (${x.date})`);
}

/** `stored` (already collapsed by `dedupeCalendar`) with each dated `adds` row appended — a twin of a stored row, an earlier add or an event goes to `refuse`, a near one to `delta`. */
export function mergeCalendar(stored: readonly LadderCalendar[], adds: readonly LadderCalendar[], events: readonly LadderEvent[], refuse: (note: string) => void): { calendar: LadderCalendar[]; delta: string[] } {
  const calendar = [...stored];
  const delta: string[] = [];
  for (const c of adds) {
    const prior = [...calendar, ...events];
    const twin = typeof c.event === "string" && typeof c.date === "string" ? calDupOf(c, prior) : undefined;
    if (twin) refuse(`calendarAdd "${c.event}": duplicates ${"signs" in twin ? "event" : "calendar"} "${twin.event}" (${twin.date}) — patch that row instead`);
    else if (typeof c.event === "string" && typeof c.date === "string") delta.push(...nearDups(c, prior));
    calendar.push(c);
  }
  return { calendar, delta };
}

const MERGED = ["matters", "verified", "verifyChecked", "dateNote"] as const;

/** `acc` (the group so far) and its later twin `c` as one row: the first verified one's identity, `matters` the first non-`—`, `verified` any, the newest `verifyChecked`, the first `dateNote`. */
function absorb(acc: LadderCalendar, c: LadderCalendar): { row: LadderCalendar; base: LadderCalendar; loser: LadderCalendar } {
  const [base, loser] = c.verified && !acc.verified ? [c, acc] : [acc, c];
  const checked = [acc.verifyChecked, c.verifyChecked].filter((d) => d !== undefined).sort().at(-1);
  const note = acc.dateNote !== undefined ? acc.dateNote : c.dateNote;
  const row = { ...base, matters: acc.matters !== "—" ? acc.matters : c.matters, verified: acc.verified || c.verified, ...(checked !== undefined && { verifyChecked: checked }), ...(note !== undefined && { dateNote: note }) };
  return { row, base, loser };
}

/** Collapses each exact-key group into one row (`absorb`; inputs untouched) — `calendar deduped: …` per absorbed row, naming any field it changed. */
export function dedupeCalendar(calendar: readonly LadderCalendar[]): { calendar: LadderCalendar[]; delta: string[] } {
  const keep: LadderCalendar[] = [];
  const delta: string[] = [];
  for (const c of calendar) {
    const i = keep.findIndex((k) => calDupOf(c, [k]));
    if (i < 0) {
      keep.push(c);
      continue;
    }
    const { row, base, loser } = absorb(keep[i]!, c);
    keep[i] = row;
    const changed = MERGED.filter((k) => row[k] !== base[k]);
    delta.push(`calendar deduped: ${loser.event} (${loser.date}) = ${row.event}${changed.length ? ` · merged ${changed.join(", ")}` : ""}`);
  }
  return { calendar: keep, delta };
}
