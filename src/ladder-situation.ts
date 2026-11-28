/**
 * The `situation` prose's staleness rules — `planRun`'s `situationWhy` and `applyRun`'s rewrite refusals (src/ladder-run.ts) share them, so `:state` names the slots apply demands.
 * Not every trigger: on a reprobe leg a `block` key or a real event status/date change re-verdicts live at apply, which can still flip a tranche `:state` never showed.
 */
import { isoDay } from "./dates.js";
import { watchWord } from "./ladder-box.js";
import { EVENT_HORIZON_DAYS, EVENT_NEAR_DAYS, gap, landed, SITUATION_SLOTS, type LadderEvent, type LadderLive, type LadderRun, type LadderSlots, type LadderTranche, type LadderVerdict } from "./ladder-live.js";

/** A stored `situation.asOf` more than this many days before today owes the five-slot rewrite (`situationWhy`). */
const SITUATION_MAX_DAYS = 7;
/** Schema words a `situation` slot never carries (ladder-situation-prose-and-stale-rows R1) — the Verdict / Blockers / Episode tables are a gate's only home; a single-word verdict name (`credit`) is refused only beside one of these. */
const SITUATION_WORDS = ["gate", "gates", "cluster", "clusters", "criterion", "family", "families", "box", "vote", "votes", "tripped"];
/** An `n/m` count (`3/4 met`); a `MM-DD/DD` date range (`10-28/29`) is not one. */
const SLOT_COUNT = /(?<![-\d])\d+\/\d+(?![-\d])/;
const slotWords = (s: string): string[] => s.toLowerCase().replace(/[-_/]/g, " ").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** Words that never make a name pair — a gate label's `under a` / `and rising` / `no new` is prose, not the name. */
const SLOT_STOP = new Set(["a", "an", "the", "no", "not", "and", "or", "under", "over", "its", "of", "vs", "with", "on", "in", "to", "at", "is", "than"]);
/** The adjacent word pairs of `words` with both words content words (`SLOT_STOP` drops a pair, never closes the gap), as `w1 w2`. */
const contentPairs = (words: string[]): string[] => words.slice(1).map((w, i) => [words[i]!, w]).filter((p) => p.every((x) => !SLOT_STOP.has(x))).map((p) => p.join(" "));
/** The first schema word, `✓`/`✗`, `n/m` count, or content-word pair (`contentPairs`) of a cluster / family / criterion name the live `verdict` carries (R2: derived, never a hand list) a `situation` slot names — undefined when clean. */
export function situationRefusal(verdict: LadderVerdict | undefined, text: string): string | undefined {
  if (/[✓✗]/.test(text)) return "✓/✗";
  const count = SLOT_COUNT.exec(text)?.[0];
  if (count) return count;
  const words = slotWords(text);
  const schema = SITUATION_WORDS.find((w) => words.includes(w));
  if (schema) return schema;
  const esc: LadderVerdict["escalation"] | undefined = verdict?.escalation; // test fixtures cast a verdict without one
  const names = [...(esc?.clusters ?? []).map((c) => c.name), ...(esc?.families ?? []).map((f) => f.name), ...(verdict?.legs ?? []).map((l) => l.leg.replace(/^(gate|guard): /, ""))];
  const slot = new Set(contentPairs(words));
  return [...new Set(names)].find((name) => contentPairs(slotWords(name)).some((p) => slot.has(p)));
}
/** A slot's `MM-DD` / `YYYY-MM-DD`, or a range `MM-DD/DD` / `MM-DD/MM-DD`; a number range read as a size (`10-15 bp`, `10-12 %`, `5-10 pp`, `10-20 day`, `10-20-day`) is none. */
const SLOT_DATE = /(?<![\d-])(?:(\d{4})-)?(\d{2})-(\d{2})(?:\/(?:(\d{2})-)?(\d{2}))?(?!\d|[-/]\d|\s?(?:%|bps?\b|pp\b|days?\b)|-days?\b)/g;
/** `iso` is a real calendar day (`2026-02-30` is none). */
const isDay = (iso: string): boolean => !Number.isNaN(Date.parse(iso)) && isoDay(new Date(Date.parse(iso))) === iso;
/** A bare `MM-DD` as the real day nearest `today` among last, this and next year; undefined when none is real. */
const nearestDay = (md: string, today: string): string | undefined => {
  const year = Number(today.slice(0, 4));
  const real = [year - 1, year, year + 1].map((y) => `${y}-${md}`).filter(isDay);
  return real.sort((a, b) => Math.abs(gap(today, a)) - Math.abs(gap(today, b)))[0];
};
/** A range end read off its `start`: same year, a bare `/DD` below the start day = next month, an `MM-DD` before the start = next year. */
const rangeEnd = (start: string, m2: string | undefined, d2: string): string => {
  const [y, m, d] = start.split("-").map(Number) as [number, number, number];
  const month = m2 === undefined ? m + (Number(d2) < d ? 1 : 0) : Number(m2);
  const year = y + (month > 12 || (m2 !== undefined && `${m2}-${d2}` < start.slice(5)) ? 1 : 0);
  return `${year}-${String(((month - 1) % 12) + 1).padStart(2, "0")}-${d2}`;
};
/** Each date token a slot names as ISO days: `[day]`, or a range's `[start, end]` (`rangeEnd`; an unreal or not-later end keeps `[start]`); an unreal start drops the token. @internal */
export const slotDates = (text: string, today: string): string[][] =>
  [...text.matchAll(SLOT_DATE)].flatMap(([, y, m, d, m2, d2]) => {
    const start = y === undefined ? nearestDay(`${m}-${d}`, today) : isDay(`${y}-${m}-${d}`) ? `${y}-${m}-${d}` : undefined;
    if (start === undefined) return [];
    const end = d2 === undefined ? undefined : rangeEnd(start, m2, d2);
    return [end !== undefined && isDay(end) && end > start ? [start, end] : [start]];
  });
/** The skill's figure stamp `<figure> <intraday|close> <MM-DD>` dates a reading, not a pending claim — the past-date lint skips it; no number before it (`positions close 11-02`) is no stamp. */
const FIGURE_STAMP = /(?<=\d(?:\s?(?:%|bps?|pp))?) (close|intraday) (?:\d{4}-)?\d{2}-\d{2}(?!\d)/gi;
/** One slot's reasons: blank, a schema name (`situationRefusal`), a date token whose last day is before today. */
const slotLint = (k: keyof LadderSlots, text: string, verdict: LadderVerdict | undefined, today: string): string[] => {
  if (!text) return [`${k}: blank`];
  const named = situationRefusal(verdict, text);
  const past = slotDates(text.replace(FIGURE_STAMP, " $1"), today).filter((t) => t.at(-1)! < today).map((t) => t[0]!.slice(5));
  return [...(named === undefined ? [] : [`${k}: names "${named}"`]), ...(past.length ? [`${k}: names ${past.join(", ")}, before today`] : [])];
};
/** A pending event `decides` names by MM-DD: on/after today and within `EVENT_NEAR_DAYS`, or holding a tranche within `EVENT_HORIZON_DAYS`. */
const decidesOwes = (e: LadderEvent, today: string): boolean => {
  if (landed(e) || e.date < today) return false;
  return gap(today, e.date) <= EVENT_NEAR_DAYS || (e.holds.length > 0 && gap(today, e.date) <= EVENT_HORIZON_DAYS);
};
/** The slot defects as `<slot>: <reason>`: `slotLint` per slot, then each `decidesOwes` event `decides` omits. */
const slotDefects = (slots: Partial<LadderSlots> | undefined, verdict: LadderVerdict | undefined, events: readonly LadderEvent[], today: string): string[] => {
  const cited = new Set(slotDates(slots?.decides ?? "", today).flat());
  const missed = events.filter((e) => decidesOwes(e, today) && !cited.has(e.date)).map((e) => `decides: misses ${e.date.slice(5)} ${e.event}`);
  return [...SITUATION_SLOTS.flatMap(([k]) => slotLint(k, slots?.[k]?.trim() ?? "", verdict, today)), ...missed];
};

const tally = (t: LadderTranche): string => `${t.met}/${t.total} ${t.ok ? "✓" : "✗"}`;
/** The run row a verdict writes (`applyRun`'s `runs[0]`) — `:state` predicts it off `live.verdict`. */
export const runOf = (v: LadderVerdict, today: string): LadderRun => ({ date: today, t1: tally(v.tranches[0]!), t2: tally(v.tranches[1]!), t3: tally(v.tranches[2]!), live: `${v.live.map((t) => (t.ok ? "✓" : "✗")).join("")}${v.prov ? " prov." : ""}`, ...(v.watch && { watch: v.watch.grade }) });
/** A run row's ✓/✗ per tranche: close T1–T3, or the live head's first three glyphs; anything else (no glyph) → undefined. */
export const glyphs = (r: LadderRun | undefined, live: boolean): (string | undefined)[] =>
  (live ? [...(r?.live ?? "").slice(0, 3)] : [r?.t1, r?.t2, r?.t3].map((t) => t?.at(-1))).map((g) => (g === "✓" || g === "✗" ? g : undefined));
/** Any tranche whose glyph is set on both runs and differs — `[was, now]`. */
export const flipped = (p: readonly (readonly (string | undefined)[])[]): boolean => p[1]!.some((g, i) => g && p[0]![i] && g !== p[0]![i]);
/** The grade of the newest prior run row that has one — a degraded/re-verdict row without `watch` never hides the next move. */
export const lastWatch = (live: LadderLive): string | undefined => live.runs.find((r) => r.watch)?.watch;
/** The rewrite triggers a verdict's run row carries: a close tranche flip vs `runs[0]`, a watch-word move vs `lastWatch` (a ` (thin)`-only move is none). */
export const verdictMoves = (live: LadderLive, v: LadderVerdict | undefined, today: string): string[] => {
  if (!v) return [];
  const row = runOf(v, today);
  const [was, now] = [lastWatch(live), row.watch];
  const flip = flipped([glyphs(live.runs[0], false), glyphs(row, false)]) ? ["tranche flip"] : [];
  return [...flip, ...(was !== undefined && now !== undefined && watchWord(was) !== watchWord(now) ? [`watch ${watchWord(was)} → ${watchWord(now)}`] : [])];
};

/** `LadderPlan.situationWhy`: `all: <trigger>` (asOf absent or older than `SITUATION_MAX_DAYS`, a `verdictMoves` move), then the stored text's `slotDefects`. */
export const situationWhy = (live: LadderLive, today: string): string[] => {
  const asOf = live.situation?.asOf;
  const age = !asOf ? ["asOf absent"] : gap(asOf, today) > SITUATION_MAX_DAYS ? [`asOf ${gap(asOf, today)} days old`] : [];
  return [...[...age, ...verdictMoves(live, live.verdict, today)].map((w) => `all: ${w}`), ...slotDefects(live.situation, live.verdict, live.events, today)];
};
/** The slot a `situationWhy` reason names — `all` for a trigger. */
const slotOf = (w: string): string => w.slice(0, w.indexOf(":"));
const ALL_FIVE = `all five slots (${SITUATION_SLOTS.map(([k]) => k).join(", ")})`;
/** Apply's rewrite refusals: `given` = the slots the patch names (undefined = no `situation`); `fired` + the plan's `all:` reasons owe all five, else `why`'s slots. */
export function reread(given: readonly string[] | undefined, fired: readonly string[], why: readonly string[]): string[] {
  const triggers = [...new Set([...fired, ...why.filter((w) => slotOf(w) === "all").map((w) => w.slice(5))])];
  const slotWhy = why.filter((w) => slotOf(w) !== "all");
  if (given === undefined) {
    if (triggers.length) return [`situation not rewritten — write ${ALL_FIVE}: ${triggers.join(" / ")}.`];
    return slotWhy.length ? [`situation not rewritten — patch the slots situationWhy names: ${slotWhy.join("; ")}.`] : [];
  }
  if (given.length === SITUATION_SLOTS.length) return [];
  if (!given.length) return ["situation: {} names no slot — omit it, or patch the slots situationWhy names"];
  if (triggers.length) return [`situation: a partial patch, but a rewrite trigger fired (${triggers.join(" / ")}) — write ${ALL_FIVE}`];
  if (!slotWhy.length) return [`situation: a partial patch, but situationWhy flags no slot — write ${ALL_FIVE}`];
  return slotWhy.filter((w) => !given.includes(slotOf(w))).map((w) => `situation ${w} — the partial patch omits that slot`);
}
/** The merged post-patch slots re-linted for dates and `decides` vs the post-patch events; a kept slot's stored defect is `reread`'s, a blank or schema name the vet's. */
export const relint = (next: LadderLive, given: readonly string[], why: readonly string[], verdict: LadderVerdict | undefined, today: string): string[] =>
  !given.length
    ? []
    : slotDefects(next.situation, verdict, next.events, today)
        .filter((w) => !/: (blank|names ")/.test(w) && (given.includes(slotOf(w)) || !why.includes(w)))
        .map((w) => `situation ${w} — ${w.startsWith("decides: misses") ? "decides names that event by its MM-DD" : "no slot names a date before today"}`);
/** The slots without the apply-stamped `asOf` (apply refuses it echoed). */
export const slotsOf = (s: LadderLive["situation"]): LadderSlots | undefined => {
  if (!s) return undefined;
  const { asOf: _asOf, ...slots } = s;
  return slots;
};
/** The `:state` print's `situation`: on `--situation` (`asked`), a due research row or `situationOwed` — so no rewrite needs a second state call. */
export const printedSituation = (live: LadderLive, plan: { research: readonly unknown[]; situationOwed: boolean }, asked: boolean): LadderSlots | undefined =>
  asked || plan.research.length > 0 || plan.situationOwed ? slotsOf(live.situation) : undefined;
