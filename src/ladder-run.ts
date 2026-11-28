/**
 * A leg's skill-run mechanics over `LEGS[leg].json` — zero IO. `planRun` = which rows to research and how
 * (`<leg>:state`); `applyRun` = the run's research patch → the next state + the chat delta + the ntfy `alert` (`<leg>:apply`).
 * Leg-blind except for the thrown prefix, the delta head and the holdable tranches of a new event.
 */
import { boardFamilies, boardReading, boardRows, labelAged, leanGroup, leanWord, LEGS, measuredLiftsOf, newestSource, SITUATION_SLOTS, EVENT_HORIZON_DAYS, RETIRE_DAYS, allEvents, type LadderEventDone, EVENT_NEAR_DAYS, gap, landed, landedOn, outcomeOf, stripTags, watchGrade, type LadderCalendar, type LadderEvent, type LadderLegId, type LadderLive, type LadderPreRead, type LadderSign, type LadderSlots, type LadderSource, type LadderTranche, type LadderVerdict } from "./ladder-live.js";
import { watchWord } from "./ladder-box.js";
import { bareStatus, blockLine, CALLED, CLAUSE, CLAUSE_SPLIT, clauses, contextRow, contractOwed, deriveContract, DRAFT_SEP, liftsDue, measurableParts, isReleased, postPatchSources, releasedText, resolveBlocks, REVIEW_FALLBACK_DAYS, sourceWindowStart, sideClause, STALE_REVIEW_DAYS, stampRewritten, stuckProne, tierReason, vetBlockSet, vetContractOwed, vetLiftBy, vetOffCause, vetSpares, withUnblocking, type BlockLift } from "./ladder-block.js";
import { flipped, glyphs, lastWatch, relint, reread, runOf, situationRefusal, situationWhy, verdictMoves } from "./ladder-situation.js";
import type { NtfyMessage } from "./ntfy.js";
import { NTFY_BODY_MAX } from "./ntfy-limits.js";
import { isoDay } from "./dates.js";
import { dedupeCalendar, mergeCalendar } from "./ladder-calendar.js";
import { labelDate, RESEARCH_LABEL } from "./ladder-labels.js";
import { findLicensedLevelsInLeg } from "./licensed-levels.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
/** The run's `at` for `applyRun`: `now` when `today` is `now`'s local date (the skills always pass `--today=<today>`), else a backfill → none. */
export const runStamp = (today: string, now: Date | undefined): string | undefined => (now && today === now.toLocaleDateString("sv-SE") ? now.toISOString() : undefined);
/**
 * `--now=<ISO instant>` off a script's argv — the slot's wall clock for `planRun`'s event windows (replays, tests). Absent: the caller's `wall`
 * clock, unless a `--today=` other than the local date is given — a backfill, so no clock (undefined), as `runStamp` drops `at`. A non-instant fails loud.
 */
export const nowArg = (argv: readonly string[], where: string, wall: Date): Date | undefined => {
  const a = argv.find((x) => x.startsWith("--now="))?.slice(6);
  if (a === undefined) {
    const d = wall;
    const today = argv.find((x) => x.startsWith("--today="))?.slice(8);
    return today === undefined || today === d.toLocaleDateString("sv-SE") ? d : undefined;
  }
  const d = new Date(a);
  if (Number.isNaN(d.getTime())) throw new Error(`${where} — --now "${a}" is not an ISO instant`);
  return d;
};
/** [USER] 2026-10-16: a researched row re-reads every 3 days while a box row (`boardRows`) naming it is TRIPPED or near (the box can flip), else `cadence ?? 7`. */
const HOT_CADENCE_DAYS = 3;
export const addDays = (d: string, n: number): string => isoDay(new Date(Date.parse(d) + n * 864e5));
/** Verify/scan cadences: an unanswered `verify` date is re-asked every `VERIFY_EVERY` days, the `scan` query runs every `SCAN_EVERY` — both daily while an event is within `EVENT_NEAR_DAYS`. */
const VERIFY_EVERY = 3;
const SCAN_EVERY = 7;
/** A `preRead` event is owed its pre-event read from this many days out (`LadderPlan.preReadOwed`). */
const PRE_READ_DAYS = 7;
/** A sourceless researched row's `extended` search repeats every `EXTENDED_EVERY` days (`extendedOn`), daily within `EVENT_NEAR_DAYS` of its event. */
const EXTENDED_EVERY = 7;
/** A row researched `UNCHANGED`/`QUIET` on this many runs in a row (`LadderSign.quiet`) asks both `sides` in one query. */
const QUIET_MERGE_AT = 2;
/** A landed event's status in the `:state` print is clipped to this many chars (the stored status is untouched). */
const EVENT_STATUS_MAX = 120;
/** An apply stamp is stale when absent or `every` or more days before today. */
const stale = (stamp: string | undefined, today: string, every: number): boolean => stamp === undefined || gap(stamp, today) >= every;
const day = (d: string): string => `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
/** A pending status's run-owned `pre YYYY-MM-DD: <read>` (`LadderEvent.preRead`), bare or after ` · `; the pending recompute keeps it (`pendingStatus`). */
const PRE_READ = /(?:^| · )(pre (\d{4}-\d{2}-\d{2}): \S.*)$/;
/** A patch status that is a pre-event read, never an outcome — no push, no reread, no reverdict. */
const isPreRead = (status: string): boolean => /^pre \d{4}-\d{2}-\d{2}: \S/.test(status);
/** A sourced pre read's closing ` (<host>)` — the source that answered (`LadderPreRead`). */
const PRE_READ_HOST = / \((?:[a-z0-9-]+\.)+[a-z]{2,}\)$/i;
/** Still owes research: pending, or landed `mixed:` (a clause unchecked) — its rows stay on the watch until it re-lands `fizzle:` / `escalation:`. */
const unresolved = (e: LadderEvent): boolean => !landed(e) || outcomeOf(e) === "mixed";
/** At least one event holds `t`, and every one is dated on/before `d` with a `fizzle:` outcome; none holding, or one pending, escalated, `mixed:` or dated after `d` → false (fizzle-only by ruling, ladder-skill-kaizen-critique outcomeOf).
 *  A dropped event holds nothing (`holds: []`, `applyEventPatch`), so it never counts. */
export const allFizzled = (events: readonly Pick<LadderEvent, "date" | "holds" | "status">[], t: LadderTranche["id"], d: string): boolean =>
  ((held) => held.length > 0 && held.every((e) => e.date <= d && outcomeOf(e) === "fizzle"))(events.filter((e) => e.holds.includes(t)));
/** Pending and dated over `EVENT_WATCH_DAYS` before `today` — `planRun`'s `overdueOwed`; a patch moving its date must land it ≥ `today` (`applyEventPatch`). */
const overdueAt = (e: LadderEvent, today: string): boolean => !landed(e) && gap(e.date, today) > EVENT_WATCH_DAYS;
/** The day a holding `mixed:` falls owed — `landedOn` + `REVIEW_FALLBACK_DAYS`. */
const mixedOwedOn = (e: LadderEventDone): string => addDays(landedOn(e), REVIEW_FALLBACK_DAYS);
/** `planRun`'s `mixedOwed`: a `mixed:` holding (or cut from) a tranche, from `mixedOwedOn` — a set `heldBefore` keeps it owed whatever the dates say. */
const mixedOwedAt = (e: LadderEvent, today: string): boolean => outcomeOf(e) === "mixed" && (e.holds.length > 0 || e.heldBefore !== undefined) && (e.heldBefore !== undefined || today >= mixedOwedOn(e));
const linked = (live: LadderLive, sign: string): LadderEvent[] => live.events.filter((e) => e.signs.includes(sign));
const linkedAll = (live: LadderLive, sign: string): LadderEventDone[] => allEvents(live).filter((e) => e.signs.includes(sign));
/** The row's finding is sourced on/after the landing — `staleAfter` releases it, `retireEvents` may move it. */
const absorbed = (s: LadderSign, e: LadderEventDone): boolean => (s.sources[0]?.date ?? "") >= landedOn(e);
/**
 * When an event's outcome can first exist, as a Europe/Tallinn hour on its date: `pre` (a pre-US-open print) 16:00, `close` (the US close —
 * 16:00 ET = 23:00 Tallinn while both sides keep the same DST; an hour early in the weeks the US and EU switch apart) 23:00, `post` (default —
 * after hours) the next day (`landable`).
 */
const OWED_FROM: Record<NonNullable<LadderEvent["at"]>, number> = { pre: 16, close: 23, post: 24 };
const TALLINN = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Tallinn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
/** `now` on the Tallinn clock as `YYYY-MM-DDTHH` — compared as text against `windowKey`. */
const tallinnKey = (now: Date): string => {
  const p = Object.fromEntries(TALLINN.formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}`;
};
/** The event's `at` window start as `YYYY-MM-DDTHH` (`post`'s hour 24 = the next date's 00). */
const windowKey = (e: LadderEvent): string => ((h) => (h >= 24 ? `${addDays(e.date, 1)}T00` : `${e.date}T${String(h).padStart(2, "0")}`))(OWED_FROM[e.at ?? "post"]);
/**
 * An event whose outcome can exist by `now`: dated before today, or today once the Tallinn date + hour reached its `at` window (an instant past
 * midnight with `today` pinned to the window's date counts). No `now` (a backfill, a test) = no clock: every own-date event counts, as before the window existed.
 */
const landable = (e: LadderEvent, today: string, now?: Date): boolean => e.date < today || (e.date === today && (!now || tallinnKey(now) >= windowKey(e)));
/** An `unresolved` linked event within `days` of today, either side — an own-date event only once `landable` (before its window it is neither near nor past: a preview is not research). */
const near = (ev: LadderEvent[], today: string, days: number, now?: Date): boolean => ev.some((e) => unresolved(e) && Math.abs(gap(today, e.date)) <= days && (e.date > today || landable(e, today, now)));
/** `near`, or an `unresolved` linked event already `landable` — its outcome (or a `mixed:` event's unchecked clause) is still owed. */
const owed = (ev: LadderEvent[], today: string, days: number, now?: Date): boolean => near(ev, today, days, now) || ev.some((e) => unresolved(e) && landable(e, today, now));

/** A board number as the skills once mandated it (`CCC 12.52 % (10-08 close)`) — refused in `finding`/`situation`: the board column (`boardText`) prints the live reading, a stored copy only rots. */
const BOARD_NUMBER = /\(\d{2}-\d{2} (close|intraday)\)/;
const DRAFT_SUFFIX = " (draft)";
/**
 * The source grade (ladder-skill-implementation-order row 13, [USER 2026-10-16]): apply APPENDS these after the lean (and a landed event `status`
 * set this run), never rejects — the skill writes the bare text. Canonical order ` (press only)` → ` (single-source)` → ` (draft)`, rebuilt from
 * the evidence on every graded write, so a tag also clears when the evidence improves.
 */
const PRESS_SUFFIX = " (press only)";
const SINGLE_SUFFIX = " (single-source)";
/** A URL's host, lowercased, leading `www.` dropped; an unparsable URL counts as its own lowercased text. @internal */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return url.toLowerCase();
  }
};
/** The leg's primary tier: the hosts on ANY row's `primary[]` ∪ `brief.primaryTier[].hosts` ([USER 2026-10-16], order row 13b); an unknown host is press. @internal */
export const primaryHosts = (live: Pick<LadderLive, "signs" | "brief">): Set<string> =>
  new Set([...live.signs.flatMap((s) => s.primary.map(hostOf)), ...(live.brief?.primaryTier ?? []).flatMap((t) => t.hosts.map((h) => h.toLowerCase().replace(/^www\./, "")))]);
/** A host is primary-tier when it or a parent domain is in the tier, on a dot boundary: `tsmc.com` admits `investor.tsmc.com`, never `faketsmc.com`. @internal */
export const inTier = (host: string, tier: ReadonlySet<string>): boolean => host.split(".").some((_, i, parts) => tier.has(parts.slice(i).join(".")));
/** ` (press only)` when `pressGate` holds and no source is primary-tier (none at all counts), then ` (single-source)` when `singleGate` holds and < 2 distinct hosts. */
const gradeTags = (sources: readonly LadderSource[], tier: ReadonlySet<string>, pressGate: boolean, singleGate: boolean): string =>
  `${pressGate && !sources.some((x) => inTier(hostOf(x.url), tier)) ? PRESS_SUFFIX : ""}${singleGate && new Set(sources.map((x) => hostOf(x.url))).size < 2 ? SINGLE_SUFFIX : ""}`;
/** The one rule rebuilding a row's lean tag chain: the bare lean, ` (press only)` on a BLOCK or group-0 (bear / escalation-leaning) row with no primary-tier
 *  source, ` (single-source)` on a BLOCK row with < 2 distinct hosts, ` (draft)` while the draft segment stands (pre-existing or landing now). */
const gradedLean = (s: LadderSign, tier: ReadonlySet<string>): string => {
  const bare = stripTags(s.lean);
  return `${bare}${gradeTags(s.sources, tier, s.block || leanGroup(bare) === 0, s.block)}${s.measurable.includes(DRAFT_SEP) ? DRAFT_SUFFIX : ""}`;
};
const LEAN_LOG_CAP = 5;
/** Sets the row's lean, logging a bare-word move to `leanLog` (seeded off the old lean on first move). */
const moveLean = (s: LadderSign, lean: string, today: string): void => {
  if (leanWord(lean) !== leanWord(s.lean)) s.leanLog = [...(s.leanLog?.length ? s.leanLog : [{ date: s.checked ?? today, lean: leanWord(s.lean) }]), { date: today, lean: leanWord(lean) }].slice(-LEAN_LOG_CAP);
  s.lean = lean;
};
/** The row's bare lean the day before `date`: newest `leanLog` entry dated < `date`, else the current lean when the log is empty, else `unknown`. [USER 2026-10-17] */
const leanBefore = (s: LadderSign, date: string): string => (s.leanLog?.length ? (s.leanLog.filter((x) => x.date < date).at(-1)?.lean ?? "unknown") : leanWord(s.lean));
/** A landed status set this run, graded off the event's stored `sources`: tags the patch wrote are stripped, then both gates apply. */
const gradedStatus = (status: string, sources: readonly LadderSource[], tier: ReadonlySet<string>): string => `${stripTags(status)}${gradeTags(sources, tier, true, true)}`;
/** The user-set part carries no threshold clause (only `BLOCKING = …` / `UNBLOCKING = …`, or none) — a lean cannot be judged against it. */
const thresholdless = (m: string): boolean => clauses(measurableParts(m).base).every((c) => /^(UN)?BLOCKING = /.test(c));

/** Days around a pending linked event during which its rows are due every run (outside it a linked row follows its cadence, or a linked release — `releasedBy`; ladder-skill-kaizen-critique, eventWatch). */
const EVENT_WATCH_DAYS = 7;
/**
 * Due gate: a BLOCK row, or a row whose unresolved linked event is within `EVENT_WATCH_DAYS` (an own-date one only once `landable`) or
 * already `landable` with the outcome owed, is due once per day (every run within ±1 day of the event); any other row — a far-event row
 * included — is due on its `due` date, or earlier on a linked release (`releasedBy`). Before an own-date event's `at` window (`preWindow`) a row checked yesterday or today is held until it.
 * `label` set = the row is held and writes only that label.
 */
const eventWatch = (live: LadderLive, s: LadderSign, today: string, now?: Date): boolean => owed(linked(live, s.sign), today, EVENT_WATCH_DAYS, now);
/** HOT rows: those a TRIPPED (`unmet`) or near box row names (`boardRows` — a family, or a `hit` cluster member), or a non-`context` watch row whose correction cell is `hit` —
 *  re-read every `HOT_CADENCE_DAYS` and searched both sides (`PlanRow.sides`). */
const hotSigns = (v: LadderVerdict | undefined): Set<string> =>
  new Set([...boardRows(v).filter((f) => f.verdict === "unmet" || f.near).flatMap((f) => f.signs.map((s) => s.sign)), ...(v?.watch?.rows ?? []).filter((r) => r.role !== "context" && r.correction.cell === "hit").flatMap((r) => (r.signs ?? []).map((s) => s.sign))]);
/** A `probe` row's lean off the box rows naming it (`boardFamilies`): any tripped (`unmet`) → the leg's first group-0 lean (`bear`), else any clear (`met`) → its first
 * group-2 lean (`fizzle`); unread (`na`/none) → undefined. Off `leans`, never a leg id. A row's `probeLeans` replaces both words (`vetProbeLeans`). */
const probeLean = (v: LadderVerdict, s: LadderSign, leans: readonly string[]): string | undefined => {
  const marks = boardFamilies(v, s.sign).map((f) => f.verdict);
  const side = marks.includes("unmet") ? "tripped" : marks.includes("met") ? "clear" : undefined;
  return side === undefined ? undefined : (s.probeLeans?.[side] ?? leans.find((l) => leanGroup(l) === (side === "tripped" ? 0 : 2)));
};
/** `probeLeans` (hand-set): a probe row only, exactly `{tripped, clear}`, each a lean of the leg but `unknown`. */
const vetProbeLeans = (fail: Fail, s: LadderSign, leans: readonly string[]): void => {
  if (s.probeLeans === undefined) return;
  const o = s.probeLeans as Record<string, unknown> | null;
  const bad = typeof o !== "object" || o === null || !s.probe || Object.keys(o).length !== 2 || ["tripped", "clear"].some((k) => typeof o[k] !== "string" || o[k] === "unknown" || !leans.includes(o[k]));
  if (bad) fail(`${s.sign}: probeLeans ${JSON.stringify(o)} is not {tripped, clear} on a probe row, each one of ${leans.filter((l) => l !== "unknown").join("/")}`);
};
/** The row's research-window start (`sourceWindowStart`: today − max(7, cadence ?? 7)) — findings dated before it are STALE (`PlanRow.since`). */
const windowStart = (s: LadderSign, today: string): string => sourceWindowStart(s, today);
/**
 * An `MM-DD` the finding names after its newest source and before `today` — the named thing happened unobserved (`LadderPlan.eventOwed`).
 * Read in the source's year, or the next when that falls before the source (a 12-20 source naming `01-15`); never the tail of a full `YYYY-MM-DD`.
 */
const DATE_IN_TEXT = /(?<!\d{4}-)\b(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b(?!-\d)/g;
const findingEventDate = (s: LadderSign, today: string): string | undefined => {
  const newest = newestSource(s);
  if (newest === undefined) return undefined;
  const year = Number(newest.slice(0, 4));
  return [...s.finding.matchAll(DATE_IN_TEXT)]
    .map((m) => ((d) => (d < newest ? `${year + 1}-${m[0]}` : d))(`${year}-${m[0]}`))
    .find((d) => d > newest && d < today)
    ?.slice(5);
};
/**
 * Landed events naming the row whose outcome postdates the row's newest source — forced onto the research list until a finding sourced on/after it lands ([USER 2026-10-16], ladder-skill-kaizen-critique).
 * Bounded to outcomes on/after the row's window start: an older one can no longer have an in-window source, so it never forces (an emptied window would otherwise force the row forever).
 */
const staleAfter = (live: LadderLive, s: LadderSign, today: string): LadderEventDone[] => {
  if (s.probe) return [];
  const since = windowStart(s, today);
  return linkedAll(live, s.sign).filter((e) => landed(e) && landedOn(e) >= since && !absorbed(s, e));
};
/** The linked unresolved own-date event whose `at` window `now` has not reached yet (the earliest window); none without a clock. */
const preWindow = (ev: LadderEvent[], today: string, now?: Date): LadderEvent | undefined =>
  now ? ev.filter((e) => unresolved(e) && e.date === today && !landable(e, today, now)).sort((a, b) => windowKey(a).localeCompare(windowKey(b)))[0] : undefined;
/** A `preWindow` event's hold text: `16:00` / `23:00` on its date, the next date for `post`. */
const windowText = (e: LadderEvent): string => ((k) => (k.slice(0, 10) === e.date ? `${k.slice(11)}:00` : k.slice(0, 10)))(windowKey(e));
/** `<event> (<date>)` per linked release — a `calendar[]` row naming the sign (`~` date as-is), or a landed event listing it at `landedOn` (an unresolved one is `eventWatch`'s) — dated after the row's last check and on/before today: it ends a cadence hold. Never checked → none.
 *  A calendar row checked on its own date re-releases once the day after — that read may have preceded the print ([USER] 2026-11-10). */
const releasedBy = (live: LadderLive, s: LadderSign, today: string): string[] =>
  s.checked === null
    ? []
    : [...live.calendar.filter((c) => c.sign === s.sign).map((c) => ({ event: c.event, date: c.date, cal: true })), ...linkedAll(live, s.sign).filter(landed).map((e) => ({ event: e.event, date: landedOn(e), cal: false }))]
        .filter((c) => (s.checked! < c.date && c.date <= today) || (c.cal && s.checked === c.date && c.date < today))
        .map((c) => `${c.event} (${c.date})`);
function gate(live: LadderLive, s: LadderSign, today: string, now?: Date): { research: boolean; label?: string; release?: string[] } {
  if (s.probe) return { research: false, label: "PROBE" };
  const ev = linked(live, s.sign);
  const watched = s.block || isReleased(s, allEvents(live)) || eventWatch(live, s, today, now);
  const release = !watched && s.due && s.due > today ? releasedBy(live, s, today) : [];
  if (!watched && s.due && s.due > today && !release.length) return { research: false, label: `${s.checked ? "HELD" : "NOT DUE"} until ${s.due}` };
  // A preview is not research (`landable`): before an own-date event's window, a row checked yesterday (the D−1 watch)
  // or today waits for it — unless another linked event's outcome is already owed. Never checked, or last checked before yesterday → researched now.
  const wait = preWindow(ev, today, now);
  if (wait && !ev.some((e) => unresolved(e) && landable(e, today, now)) && s.checked !== null && s.checked >= addDays(today, -1)) return { research: false, label: `HELD until ${windowText(wait)}` };
  return { research: !watched || s.checked !== today || near(ev, today, 1, now), ...(release.length && { release }) };
}

type PlanRow = {
  sign: string;
  /** The criterion — what a finding is judged against. */
  measurable: string;
  /** User-set base rate — the skill never writes it. */
  base?: string;
  label: string;
  lean: string;
  finding: string;
  /** The live board reading of the families the row feeds (`boardReading`, `—` when none) — the skill's input for describing the number in words; the rendered board slot is a pointer (`boardText`). */
  board: string;
  /** Window start (today − max(7, cadence ?? 7)): findings dated before it are STALE. */
  since: string;
  /** The newest in-window source the row already holds (null = none): nothing contradicting it → `UNCHANGED <held>`, no dating fetch. */
  held: string | null;
  /** `WebFetch` each — `primary` then `press` (fetched alike, graded press), minus already-read URLs and pages failed on two runs. */
  fetch: string[];
  /** The standard searches, always run: the row's first stem, then `<event> outcome <Month YYYY>` per unresolved linked event dated on/before today. */
  query: string[];
  /** ≤ 1: the newest `searchNext` stem, else `search[1]`. Run only when `query` + `fetch` returned no in-window finding; empty = skip. */
  more: string[];
  /** One extended search allowed when the row still has no in-window finding — an event within 3 days, or a researched row (`checked` set) with `held` null whose last extended search (`extendedOn`) is ≥ `EXTENDED_EVERY` days old. */
  extended: boolean;
  /** The row's full `primary[]` — the patch's `primary` is this list with each `replace` page swapped in place or dropped. */
  primary: string[];
  /** Primary pages failed on two runs — the patch's `primary` swaps each in place or drops it (never to an empty list). [USER 2026-10-16] */
  replace: string[];
  /** HOT or event-day rows only (`sidesOf`): one standard search per side, both read before the label. [USER 2026-10-17]
   *  `both` = the two sides as ONE query, once a HOT row with no event on its day reaches `quiet` ≥ `QUIET_MERGE_AT`. */
  sides?: { escalation: string; fizzle: string } | { both: string };
  /** A `measure` row only: its script's reading, attached by `<leg>:state` (`withMeasured`) — never by `planRun`, which stays IO-free. */
  measured?: Measured;
  /** `dropMeasuredCalls` emptied the row's calls: `measured` + its `sources` are the finding. */
  measuredOnly?: true;
};
/** A sign's `measure` script's `--json` print: a dated computed reading the skill quotes, or why it failed. */
export type Measured = { asOf: string; text: string; sources: LadderSource[] } | { error: string };
const isSource = (x: unknown): x is LadderSource => typeof x === "object" && x !== null && typeof (x as LadderSource).date === "string" && typeof (x as LadderSource).url === "string";
const readMeasured = (script: string, run: (script: string) => string): Measured => {
  try {
    const o = JSON.parse(run(script)) as Partial<{ asOf: unknown; text: unknown; sources: unknown; error: unknown }>;
    if (typeof o.error === "string") return { error: `${script}: ${o.error}` };
    if (typeof o.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.asOf) && typeof o.text === "string" && Array.isArray(o.sources) && o.sources.length && o.sources.every(isSource))
      return { asOf: o.asOf, text: o.text, sources: o.sources };
    return { error: `${script}: malformed --json print (want {asOf, text, sources})` };
  } catch (e) {
    return { error: `${script}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` };
  }
};
/** Each due row whose sign names a `measure` gets that script's reading as `measured` (`run` = the IO: the script's stdout; a throw → `{error}`). */
export const withMeasured = (rows: readonly PlanRow[], live: Pick<LadderLive, "signs">, run: (script: string) => string): PlanRow[] => {
  const by = new Map(live.signs.flatMap((s) => (s.measure ? [[s.sign, s.measure] as const] : [])));
  return rows.map((r) => ((script) => (script ? { ...r, measured: readMeasured(script, run) } : r))(by.get(r.sign)));
};
/** R1 [USER 2026-11-14]: a non-block row whose `measured` is not `{error}` runs no web calls; its stub row says `measuredOnly`, so apply leaves its `fails` + `extendedOn` alone. */
export const dropMeasuredCalls = <P extends Pick<LadderPlan, "research" | "patch">>(plan: P, live: Pick<LadderLive, "signs">): P => {
  const block = new Map(live.signs.map((s) => [s.sign, s.block]));
  const only = new Set(plan.research.filter((r) => r.measured && !("error" in r.measured) && !block.get(r.sign)).map((r) => r.sign));
  if (!only.size) return plan;
  const research = plan.research.map((r): PlanRow => {
    if (!only.has(r.sign)) return r;
    const out: PlanRow = { ...r, fetch: [], query: [], more: [], extended: false, measuredOnly: true };
    delete out.sides;
    return out;
  });
  const patch = plan.patch && { signs: Object.fromEntries(Object.entries(plan.patch.signs).map(([k, v]) => [k, only.has(k) ? { ...v, measuredOnly: true as const } : v])) };
  return { ...plan, research, ...(patch && { patch }) };
};
/** `<leg>:apply --prelabels=<file>`: a researched row missing from the patch takes its mechanical pre-label (`ladder:prelabel`'s stub) with a `warn`; a judgement row (`label: ""`) stays missing, so apply still refuses it. */
export const fillMechanical = (patch: unknown, stub: { signs: Record<string, RowPatch> }, planned: readonly string[]): { patch: unknown; warned: string[] } => {
  if (!isObj(patch) || !isObj((patch as LadderPatch).signs)) return { patch, warned: [] };
  const signs = (patch as LadderPatch).signs;
  const fill = planned.filter((s) => !signs[s] && stub.signs[s]?.label);
  const filled = Object.fromEntries(fill.map((s) => [s, structuredClone(stub.signs[s]!)]));
  return { patch: { ...patch, signs: { ...signs, ...filled } }, warned: fill.map((s) => `warn ${s} — missing from the patch: filled from its pre-label ${stub.signs[s]!.label}`) };
};
export type LadderPlan = {
  today: string;
  rules: string[];
  research: PlanRow[];
  kept: string[];
  /** `dateNote` only while `verified !== true` — the run's alternate-date hints for Rung 0. A retired (`eventsDone`) entry printed for `findingOwed` carries no `escalationIf`/`fizzleIf`. */
  events: (Pick<LadderEvent, "date" | "event" | "signs" | "holds" | "status"> & Partial<Pick<LadderEvent, "escalationIf" | "fizzleIf" | "expect" | "dateNote">>)[];
  /** `<event> (<date>)`: the events `events` drops past `EVENT_HORIZON_DAYS` — known, so never re-added. Absent when none. */
  eventsLater?: string[];
  /** Settled events off the print (`events` + `eventsDone`, neither unresolved, ≤ 14 d nor `findingOwed`) — a count only. Absent when 0. */
  eventsSettled?: number;
  calendar: LadderCalendar[];
  /** `situationWhy` is non-empty — the skill patches its slots (all five on an `all:` reason or any other rewrite trigger). */
  situationOwed: boolean;
  /** `all: <trigger>` (asOf absent / too old, `tranche flip`, `watch <was> → <now>`) or `<slot>: <reason>` (src/ladder-situation.ts `situationWhy`). Absent when none.
   *  Not every apply trigger: a reprobe leg's live reverdict (`movesVerdict`, src/ladder-reverdict.ts) can still flip a tranche at apply. */
  situationWhy?: string[];
  /** `<sign> after <event>`: a landed event dated after the row's newest source (`staleAfter`) — the row is on `research` until its finding is rewritten off a source dated on/after the event. Absent when none. */
  findingOwed?: string[];
  /** `<sign> — <n> stale review(s) · earliest lift … > review …` (`contractOwed`, src/ladder-block.ts): a holding block whose contract is stuck — on `research` until the patch answers it (`vetContractOwed`). Absent when none. */
  contractOwed?: string[];
  /** `<sign> ← <event> (<date>)`: a cadence-held row a linked release passed since its last check (`releasedBy`) — on `research` early. Absent when none. */
  released?: string[];
  /** `<sign> <MM-DD>`: a date the finding names after its newest source and before today (`findingEventDate`) — the named thing happened unobserved; the row is on `research`, and the outcome lands via `eventsAdd` or a re-sourced finding. Absent when none. */
  eventOwed?: string[];
  /** `<event> (<date>)` per pending event dated over `EVENT_WATCH_DAYS` before today — its linked rows stay on `research`; answered by an outcome, a `date` ≥ today or `{drop}`. Its date leaves `eventOwed`. Absent when none. */
  overdueOwed?: string[];
  /** `<event> (<owed date>)` per `mixedOwedAt` event — its linked rows stay on `research`; answered only by re-landing `escalation:` / `fizzle:`. Absent when none. */
  mixedOwed?: string[];
  /** `<event> (<date>)` per passed unverified calendar row that matters (`calOwed`) — apply refuses until each is patched:
   *  moved (`{date, verified}`, date ≥ today) or dropped (`{drop: "<reason>"}`). Absent when none. */
  calendarOwed?: string[];
  /** `<event> (<date>): <preRead>` per pending event with `preRead` 0–`PRE_READ_DAYS` days out whose status holds no `pre` read dated ≥ yesterday — the run writes `pre <today>: <read>` as its `status`;
   *  a sourced `preRead` prints `{owed, sources}` (walked in order, the status ends ` (<host>)` or is `pre <date>: n/a (all unreadable)`). Absent when none. */
  preReadOwed?: (string | { owed: string; sources: string[] })[];
  /** `<event>: <sign> <STALE label> — <finding>` per unresolved linked event dated ≤ today — context for reading its outcome, never the outcome. Absent when none. */
  staleContext?: string[];
  /** `measurable` rows carrying a frozen `(live …)` number (`/\blive \d/`) — a snapshot labelled live; strip it, the board column prints the reading. */
  liveNumber?: string[];
  /** Rows whose `lean` ends ` (draft)` but whose `measurable` holds no ` · draft: ` segment — the suffix rotted; drop it (or restore the segment). */
  draftOrphan?: string[];
  /** `press` pages failed on two runs, as `<sign>: <url>` — off `fetch`, never in `replace` (`press` is user-set): the run lists each for the user to replace or drop. Absent when none. */
  pressDead?: string[];
  /** Due rows whose `measurable` has no threshold clause and no draft yet (`thresholdless`) — the skill drafts both sides as the patch's `measurableDraft`. Absent when none. */
  thresholdless?: string[];
  /** The patch shape to fill — one `{label: ""}` stub per `research[]` row (the agent fills blanks; `applyRun` rejects a missing or extra row). Absent when nothing is due. */
  patch?: { signs: Record<string, { label: string; measuredOnly?: true }> };
  /** `PATCH_FORMS` — the allowed form of each patch field the stub leaves out: `finding` + `searchNext` beside `patch`, `calendar.drop` beside `calendarOwed`, `events.drop` beside `overdueOwed`. Absent when none is. */
  patchForms?: Partial<typeof PATCH_FORMS>;
  /** `ARM_RULES` — the instruction per fired rare arm (`calendarOwed`, `overdueOwed`, `mixedOwed`, `preReadOwed`, `pressDead`, `thresholdless`, `siblings`, `contractOwed`, `staleContext`, `eventOwed`). Absent when none fires. */
  armRules?: Partial<Record<Arm, string>>;
  /** Rung 0's horizon search — dated items no row holds → `calendarAdd`. */
  scan: string[];
  /** Blocked rows whose earliest lift event is dated ≤ today + `LIFT_WINDOW_DAYS` (`liftsDue`, src/ladder-block.ts), by date — the lifts to watch this run. Absent when none. */
  blockLifts?: BlockLift[];
  /** The `stuck-prone: <sign> — earliest lift … > review …` lines (`stuckProne`, src/ladder-block.ts). Absent when none. */ stuckProne?: string[];
  /** Other legs' copies of own pending events (`siblingsOf`), grouped per own event; `conflict` = the dates differ. Absent when none. */
  siblings?: { event: string; date: string; siblings: Omit<LadderSibling, "event" | "date">[] }[];
  /** `lean hit rate: N of M calls` off the landed statuses' `called:` — ▲ vs `escalation:` / ▼ vs `fizzle:` = hit; ◆/○ and `mixed:` uncounted. Absent at M = 0. */
  leanHitRate?: string;
  /** Rung 0's date checks within 21 days, by date: pending unverified events whose name or `dateNote` flags a doubt (`DOUBT`), whose date conflicts with an unverified sibling, or that hold a tranche
   *  within `EVENT_NEAR_DAYS` (`starNear` — those carry `fetch`, the linked signs' `primary[]` issuer pages, read before `query`), and unverified calendar rows. */
  verify: { event: string; date: string; query: string; fetch?: string[] }[];
};
/** A ★ event (holds a tranche) within `EVENT_NEAR_DAYS` — its date is confirmed from the issuer page before the call; its `verified` counts only when `issuerSourced`
 *  or it has no `issuerPages` to fetch (a leg with no issuer page would otherwise re-verify every run). */
const starNear = (e: LadderEvent, today: string): boolean => e.holds.length > 0 && gap(today, e.date) >= 0 && gap(today, e.date) <= EVENT_NEAR_DAYS;
/** The event's issuer pages: its linked signs' `primary[]`, deduped — Rung 0's `fetch`. */
const issuerPages = (live: LadderLive, e: Pick<LadderEvent, "signs">): string[] => [...new Set(e.signs.flatMap((n) => live.signs.find((s) => s.sign === n)?.primary ?? []))];
const issuerSourced = (e: LadderEvent, tier: ReadonlySet<string>): boolean => (e.sources ?? []).some((x) => inTier(hostOf(x.url), tier));
const DOUBT = /conflict|NOT confirmed|est\.|~/;
const doubted = (e: LadderEvent): boolean => DOUBT.test(e.event) || DOUBT.test(e.dateNote ?? "");
/** An event name without its trailing `(…)` / `[…]` notes — the search stem. */
const bare = (name: string): string => name.replace(/\s*[([].*$/, "") || name;
/** The other legs' state `:state` reads for `siblings` — the own leg's key is ignored. */
export type LadderOthers = Partial<Record<LadderLegId, Pick<LadderLive, "events">>>;
const SIBLING_DAYS = 10;
/** `sources` = a landed sibling's evidence, never its outcome — the own event is judged on its own sides. */
type LadderSibling = { event: string; date: string; sibling: string; status: string; verified: boolean; conflict: boolean; sources?: LadderSource[] };
/** Name words that never pair two events — periods, months, report nouns, years. */
const NAME_STOP = /^(q\d|h\d|fy\S*|fq\S*|us|uk|est\.?|call|guide|outlook|earnings|results|after|close|no|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mpm|on|the|and|of|\d{4})$/i;
const nameWords = (name: string): string[] => bare(name).toLowerCase().split(/[\s+&,/]+/).filter((w) => w.length > 1 && !NAME_STOP.test(w));
/** Another leg's event sharing a `nameWords` word within `SIBLING_DAYS` of an own pending event. [USER 2026-10-17] */
const siblingsOf = (e: LadderEvent, leg: LadderLegId, others: LadderOthers): LadderSibling[] => {
  const words = new Set(nameWords(e.event));
  return (Object.entries(others) as [LadderLegId, Pick<LadderLive, "events">][])
    .filter(([l]) => l !== leg)
    .flatMap(([l, o]) => o.events.filter((x) => Math.abs(gap(e.date, x.date)) <= SIBLING_DAYS && nameWords(x.event).some((w) => words.has(w))).map((x) => ({ l, x })))
    .map(({ l, x }) => ({ event: e.event, date: e.date, sibling: `${l} · ${x.event} · ${x.date}`, status: x.status, verified: x.verified === true, conflict: x.date !== e.date, ...(landed(x) && { sources: x.sources ?? [] }) }));
};
const monthOf = (date: string): string => `${LONG[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;

const ESCALATION_SIDE = /^(bear|escalation|BLOCKING)$/i;
const FIZZLE_SIDE = /^(fizzle|turn|unblocking)$/i;
/** A side as a search phrase: no `(…)`/`[…]` notes, cut at the first ` — ` / `: ` / `; `, at most 12 words. */
const terse = (text: string): string => {
  let t = text;
  for (let prev = ""; prev !== t; ) [prev, t] = [t, t.replace(/\([^()]*\)|\[[^[\]]*\]/g, " ")];
  return t.split(/ — |: |; /)[0]!.trim().split(/\s+/).slice(0, 12).join(" ");
};
/**
 * Both sides' queries on a HOT row or an event-day row (an unresolved linked event within ±1 day, or past and owed); undefined otherwise.
 * The nearest event-day event's `escalationIf`/`fizzleIf`; with none, `<stem> <sideClause>`, a missing side → `<stem> worsening|easing`. [USER 2026-10-17]
 * A HOT row with no event on its day at `quiet` ≥ `QUIET_MERGE_AT`: one `{both}` query, `<stem> <escalation> or <fizzle> <Month YYYY>` — an event-day row stays two-sided.
 */
const sidesOf = (s: LadderSign, ev: LadderEvent[], today: string, hot: ReadonlySet<string>, now?: Date): PlanRow["sides"] => {
  const onDay = ev.filter((e) => owed([e], today, 1, now));
  if (!hot.has(s.sign) && !onDay.length) return undefined;
  const e = onDay.sort((a, b) => Math.abs(gap(today, a.date)) - Math.abs(gap(today, b.date)))[0];
  const side = (re: RegExp, fallback: string): string => ((b) => (b === undefined ? fallback : terse(b)))(sideClause(s.measurable, re));
  const [head, esc, fiz, month] = e
    ? [bare(e.event), terse(e.escalationIf), terse(e.fizzleIf), monthOf(e.date)]
    : [s.search[0] ?? s.sign, side(ESCALATION_SIDE, "worsening"), side(FIZZLE_SIDE, "easing"), monthOf(today)];
  return !e && (s.quiet ?? 0) >= QUIET_MERGE_AT ? { both: `${head} ${esc} or ${fiz} ${month}` } : { escalation: `${head} ${esc} ${month}`, fizzle: `${head} ${fiz} ${month}` };
};

const planRow = (live: LadderLive, s: LadderSign, today: string, hot: ReadonlySet<string>, leg: LadderLegId, others: LadderOthers, now?: Date): PlanRow => {
  const ev = linked(live, s.sign).filter(unresolved);
  const sourcedSibling = (e: LadderEvent): boolean => !landed(e) && siblingsOf(e, leg, others).some((x) => x.sources?.length);
  const sides = sidesOf(s, ev, today, hot, now);
  const read = new Set([...s.seed, ...s.sources.map((x) => x.url)]);
  const month = monthOf(today);
  const failed = (u: string): boolean => (s.fails?.[u] ?? 0) >= 2;
  const held = s.sources.filter((x) => x.date >= windowStart(s, today)).map((x) => x.date).sort().at(-1) ?? null;
  return {
    sign: s.sign,
    measurable: s.measurable,
    ...(s.base && { base: s.base }),
    label: labelAged(s.label, s.checked),
    lean: s.lean,
    finding: s.finding,
    board: boardReading(live.verdict, s.sign, true),
    since: windowStart(s, today),
    held,
    fetch: [...s.primary, ...(s.press ?? [])].filter((u) => !read.has(u) && !failed(u)),
    query: [...new Set([`${s.search[0] ?? s.sign} ${month}`, ...ev.filter((e) => landable(e, today, now) && !sourcedSibling(e)).map((e) => `${bare(e.event)} outcome ${monthOf(e.date)}`)])],
    more: !ev.length || owed(ev, today, 7, now) ? [s.searchNext?.at(-1) ?? s.search[1]].filter((q) => q !== undefined).map((q) => `${q} ${month}`) : [],
    extended: owed(ev, today, EVENT_NEAR_DAYS, now) || (s.checked !== null && held === null && stale(s.extendedOn, today, EXTENDED_EVERY)),
    primary: [...s.primary],
    replace: s.primary.filter(failed),
    ...(sides && { sides }),
  };
};

const PATCH_FORMS = {
  finding: "<fact in words, source date>; CHANGED (+ lean) or fresher UNCHANGED",
  searchNext: "1 stem, no past/current year, month or MM-DD; only without an in-window source",
  "calendar.drop": "\"happened <MM-DD>: <outcome> (<host>)\" or \"<why>\", sole key",
  "events.drop": "\"<why>\" (cancelled / duplicate / out of eventScope), sole key; refused on a landed event holding a tranche or one named by blocked.by",
};
/** The skill's rare-arm prose, printed as `armRules` only for the arms that fire — `<leg>` is rendered with the leg id. */
const ARM_RULES = {
  calendarOwed:
    "`<event> (<date>)` = passed calendar rows that matter with no outcome recorded — apply refuses the patch until each is landed (step 3's `calendar`). " +
    "Step 2: each `calendarOwed` row → one `<event> <date>` search in Rung A's call; a `research: []` run does not wait: ONE `ladder-research` call searching `<event> <date>` per row, then step 4 with `{\"signs\": {}, \"calendar\": {…}}`. " +
    "Step 3 `calendar`: a `calendarOwed` row lands one of three ways: re-dated → `{date: ≥ today, verified}`; happened → `{drop: \"happened <MM-DD>: <outcome> (<host>)\"}`; cancelled / no trace → `{drop: \"<why>\"}`.",
  overdueOwed:
    `\`<event> (<date>)\` = pending events passed over ${EVENT_WATCH_DAYS} days with no outcome. Step 2: one \`<event> outcome\` search each in Rung A's call. ` +
    "Step 3 `events` answers each: an outcome lands (`escalation:` / `fizzle:` / `mixed:`); re-dated → `{date: ≥ today, verified}`; cancelled / out of scope / no trace → `{drop: \"<why>\"}`, sole key.",
  mixedOwed:
    `\`<event> (<owed date>)\` = landed \`mixed:\` events holding a tranche ${REVIEW_FALLBACK_DAYS} days after landing with the clause still unchecked — from the owed date apply cuts their \`holds\` to T3, ${STALE_REVIEW_DAYS} days later to none. ` +
    "Step 2: one `<event> <unchecked clause>` search each in Rung A's call. Step 3 `events` answers each ONLY by re-landing `escalation:` (restores the holds) or `fizzle:` from a source dated after the landing — a `mixed:` re-land or a `date` move does not answer it.",
  preReadOwed:
    "Step 3: read the named pre-event figure in Rung A's call and write `events` `{\"<event>\": {status: \"pre <today>: <read>\"}}` — apply keeps it after the pending status; never an outcome. " +
    "A string entry (`<event> (<date>): <preRead>`): an unreadable page writes `pre <today>: n/a (<host> unreadable)`, discharging it for the day. An `{owed, sources}` entry lists `sources` `in order` (a URL fetched, `search: <stem>` searched), stopping at the first that answers, and writes `pre <today>: <read> (<host>)`; `pre <today>: n/a (all unreadable)` only after the last fails. " +
    "A `research: []` run skips it — a `preReadOwed` waits for a run that researches.",
  pressDead: "Press pages failed on two runs — `press` is user-set, so step 5 lists each for the user (headless: the runner journals them); the run never edits `press`.",
  thresholdless:
    "Step 2 Judge: a row listed under `thresholdless` (`measurable has no threshold: <row>`) has no clause to judge by — DRAFT them: `measurableDraft` = `<lean> = … ; <lean> = …`, one clause per side " +
    "in the leg's `leans` words; `<leg>:apply` lands the draft and suffixes the row's `lean` ` (draft)` itself — never paste it into `measurable`.",
  contractOwed: "A `contractOwed` row (a stale-demoted or stuck-prone block) owes ONE answer, else apply refuses: a fresh sourced escalation-group source, a new lift dated ≤ its review (as `stuckProne`), `unblocking: \"<reachable clause>\"` (replaces its UNBLOCKING clause — a repeat is refused), or `causeFalse: true` while its lift falls by the review.",
  staleContext: "`staleContext` lists a due event's rows' `STALE` findings — re-cite one as context, never as the outcome.",
  eventOwed: "`eventOwed` → a finding's date passed unobserved: `eventsAdd` its outcome or re-source the finding.",
  siblings:
    "Step 2 Rung 0: a `siblings[].siblings[]` entry (another leg's copy of the own event `siblings[].event`): a `verified` copy's date → `events` `{date, verified: true}`, never re-searched. " +
    "A landed sibling's `status` + `sources` are evidence only — judge the own event against its OWN `escalationIf`/`fizzleIf` (cite those sources), never copy the status. An unverified `conflict` is already in `verify[]`.",
};
type Arm = keyof typeof ARM_RULES;
/** The run's research list: due rows with their calls; `kept` = rows the gate holds, as `sign — label`. `now` = the slot's wall clock (`landable`); absent = no clock. */
export function planRun(live: LadderLive, today: string, leg: LadderLegId = "eufin", others: LadderOthers = {}, now?: Date): LadderPlan {
  const research: PlanRow[] = [];
  const tier = primaryHosts(live);
  const kept: string[] = [];
  const findingOwed: string[] = [];
  const owedBy = new Set<string>();
  const released: string[] = [];
  const eventOwed: string[] = [];
  // Pending past `EVENT_WATCH_DAYS`: asked once, as `overdueOwed` — its linked rows' `eventOwed` for the same date is dropped.
  const overdue = live.events.filter((e) => overdueAt(e, today));
  const overdueOwed = overdue.map((e) => `${e.event} (${e.date})`);
  const mixedDue = live.events.filter((e) => mixedOwedAt(e, today));
  const mixedOwed = mixedDue.map((e) => `${e.event} (${mixedOwedOn(e)})`);
  const hot = hotSigns(live.verdict);
  const fail: Fail = (msg) => {
    throw new Error(`${leg}:state — ${msg}`);
  };
  for (const s of live.signs) vetProbeLeans(fail, s, LEGS[leg].leans);
  const owedContract = contractOwed(live.signs, allEvents(live), today, measuredLiftsOf(leg));
  const owesContract = new Set(owedContract.map((l) => l.split(" — ")[0]!));
  for (const s of live.signs) {
    const g = gate(live, s, today, now);
    const after = staleAfter(live, s, today);
    for (const e of after) owedBy.add(e.event);
    findingOwed.push(...after.map((e) => `${s.sign} after ${e.event}`));
    released.push(...(g.release ?? []).map((r) => `${s.sign} ← ${r}`));
    // A row with no finding ever is due every run until its first — a sourceless `QUIET`/`UNSOURCED` finding is a finding; one naming a date
    // after its source and before today is due with `eventOwed` (ladder-situation-prose-and-stale-rows).
    const unsourced = !s.probe && !s.finding.trim();
    const eventDate = s.probe ? undefined : findingEventDate(s, today);
    const overdueRow = !s.probe && [...overdue, ...mixedDue].some((e) => e.signs.includes(s.sign));
    if (eventDate !== undefined && !overdue.some((e) => e.signs.includes(s.sign) && e.date.slice(5) === eventDate)) eventOwed.push(`${s.sign} ${eventDate}`);
    if (g.research || after.length || unsourced || eventDate !== undefined || overdueRow || owesContract.has(s.sign)) research.push(planRow(live, s, today, hot, leg, others, now));
    else kept.push(`${s.sign} — ${g.label ?? `${labelAged(s.label, s.checked)} (checked today)`}`);
  }
  const hits = allEvents(live).flatMap((e) => {
    const o = outcomeOf(e);
    const c = CALLED.exec(stripTags(e.status))?.[0];
    if (!c || o === "mixed" || o === undefined) return [];
    return [...c.matchAll(/=([^=,]+?)(?=, |$)/g)].map((m) => leanGroup(m[1]!)).filter((g) => g === 0 || g === 2).map((g) => (g === 0) === (o === "escalation"));
  });
  const staleContext = live.events
    .filter((e) => landable(e, today, now) && unresolved(e))
    .flatMap((e) => live.signs.filter((s) => e.signs.includes(s.sign) && s.label.startsWith("STALE ")).map((s) => `${e.event}: ${s.sign} ${labelAged(s.label, s.checked)} — ${s.finding}`));
  const liveNumber = live.signs.filter((s) => /\blive \d/.test(s.measurable)).map((s) => `measurable carries a live number: ${s.sign}`);
  const draftOrphan = live.signs.filter((s) => !s.probe && s.lean.endsWith(DRAFT_SUFFIX) && !s.measurable.includes(DRAFT_SEP)).map((s) => `lean carries (draft) without a draft segment: ${s.sign}`);
  const pressDead = live.signs.flatMap((s) => (s.probe ? [] : (s.press ?? [])).filter((u) => (s.fails?.[u] ?? 0) >= 2).map((u) => `${s.sign}: ${u}`));
  const noThreshold = research.filter((r) => thresholdless(r.measurable) && !r.measurable.includes(DRAFT_SEP)).map((r) => `measurable has no threshold: ${r.sign}`);
  const pairs = live.events.filter((e) => !landed(e)).flatMap((e) => siblingsOf(e, leg, others).map((row) => ({ own: e, row })));
  const conflicted = new Set(pairs.filter(({ row }) => row.conflict && !row.verified).map(({ own }) => own.event));
  for (const { own, row } of pairs) if (row.verified) conflicted.delete(own.event);
  const shown = pairs.filter(({ own, row }) => row.conflict || row.sources || (row.verified && !own.verified));
  const siblings = [...new Set(shown.map(({ own }) => own))].map((own) => ({ event: own.event, date: own.date, siblings: shown.filter((p) => p.own === own).map(({ row: { event: _e, date: _d, ...rest } }) => rest) }));
  // The events a run reads: unresolved, landed ≤ 14 d, or owed by a row's `staleAfter` (the rest = `eventsSettled`), none past `EVENT_HORIZON_DAYS` unless on `verify` — a landed status clipped to `EVENT_STATUS_MAX`; `:state --full` prints them all (`EVENT_STATUS_MAX`).
  const preReadOwed = live.events
    .filter((e) => e.preRead && !landed(e) && gap(today, e.date) >= 0 && gap(today, e.date) <= PRE_READ_DAYS && !((PRE_READ.exec(e.status)?.[2] ?? "") >= addDays(today, -1)))
    .map((e) => (typeof e.preRead === "object" ? { owed: `${e.event} (${e.date}): ${e.preRead.text}`, sources: [...e.preRead.sources] } : `${e.event} (${e.date}): ${e.preRead}`));
  // Collapsed as apply will collapse it, so every calendar name printed here is a survivor's — patchable by name.
  const cal = dedupeCalendar(live.calendar).calendar;
  const calendarOwed = cal.filter((c) => calOwed(c, today)).map((c) => `${c.event} (${c.date})`);
  const verify = [...live.events.filter((e) => !landed(e) && (!e.verified ? doubted(e) || conflicted.has(e.event) || starNear(e, today) : starNear(e, today) && !issuerSourced(e, tier) && issuerPages(live, e).length > 0)), ...cal.filter((c) => !c.verified)]
    .filter((x) => x.date >= today && gap(today, x.date) <= 21 && (gap(today, x.date) <= EVENT_NEAR_DAYS || stale(x.verifyChecked, today, VERIFY_EVERY)))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((x) => {
      const fetch = "holds" in x && starNear(x, today) ? issuerPages(live, x) : [];
      return { event: x.event, date: x.date, query: `${bare(x.event).replace(/\s+date$/i, "")} date`, ...(fetch.length && { fetch }) };
    });
  const verifying = new Set(verify.map((v) => v.event));
  // A retired event `staleAfter` owes rides along, so `findingOwed`'s `<sign> after <event>` names a printed event.
  const readEvents: (LadderEventDone & Partial<LadderEvent>)[] = [...live.events.filter((e) => unresolved(e) || gap(landedOn(e), today) <= 14 || owedBy.has(e.event)), ...(live.eventsDone ?? []).filter((e) => owedBy.has(e.event))];
  const eventsSettled = allEvents(live).length - readEvents.length;
  const nearby = (e: Pick<LadderEvent, "date" | "event">): boolean => gap(today, e.date) <= EVENT_HORIZON_DAYS || verifying.has(e.event);
  const shownEvents = readEvents.filter(nearby);
  const eventsLater = readEvents.filter((e) => !nearby(e)).map((e) => `${e.event} (${e.date})`);
  const armCount: Record<Arm, number> = { calendarOwed: calendarOwed.length, overdueOwed: overdueOwed.length, mixedOwed: mixedOwed.length, preReadOwed: preReadOwed.length, pressDead: pressDead.length, thresholdless: noThreshold.length, siblings: siblings.length, contractOwed: owedContract.length, staleContext: staleContext.length, eventOwed: eventOwed.length };
  const fired = (Object.keys(armCount) as Arm[]).filter((a) => armCount[a] > 0);
  const why = situationWhy(live, today);
  return {
    today,
    rules: live.rules,
    research,
    kept,
    events: shownEvents.map(({ date, event, signs, holds, escalationIf, fizzleIf, expect, status, dateNote, verified }) => ({ date, event, signs, holds, ...(escalationIf !== undefined && { escalationIf }), ...(fizzleIf !== undefined && { fizzleIf }), ...(expect && { expect }), ...(dateNote && verified !== true && { dateNote }), status: status.length > EVENT_STATUS_MAX ? `${status.slice(0, EVENT_STATUS_MAX - 1)}…` : status })),
    ...(eventsLater.length && { eventsLater }),
    ...(eventsSettled > 0 && { eventsSettled }),
    calendar: cal.filter((c) => !c.verified && c.date >= today && gap(today, c.date) <= 14),
    situationOwed: why.length > 0,
    ...(why.length && { situationWhy: why }),
    ...(findingOwed.length && { findingOwed }),
    ...(owedContract.length && { contractOwed: owedContract }),
    ...(released.length && { released }),
    ...(eventOwed.length && { eventOwed }),
    ...(overdueOwed.length && { overdueOwed }),
    ...(mixedOwed.length && { mixedOwed }),
    ...(calendarOwed.length && { calendarOwed }),
    ...(preReadOwed.length && { preReadOwed }),
    ...(staleContext.length && { staleContext }),
    ...(liveNumber.length && { liveNumber }),
    ...(draftOrphan.length && { draftOrphan }),
    ...(pressDead.length && { pressDead }),
    ...(noThreshold.length && { thresholdless: noThreshold }),
    ...(research.length && { patch: { signs: Object.fromEntries(research.map((r) => [r.sign, { label: "" }])) } }),
    ...((research.length || calendarOwed.length || overdueOwed.length) && {
      patchForms: { ...(research.length && { finding: PATCH_FORMS.finding, searchNext: PATCH_FORMS.searchNext }), ...(calendarOwed.length && { "calendar.drop": PATCH_FORMS["calendar.drop"] }), ...(overdueOwed.length && { "events.drop": PATCH_FORMS["events.drop"] }) },
    }),
    ...(fired.length && { armRules: Object.fromEntries(fired.map((a) => [a, ARM_RULES[a].replaceAll("<leg>", leg)])) }),
    scan: stale(live.scannedOn, today, SCAN_EVERY) || live.events.some((e) => !landed(e) && gap(today, e.date) >= 0 && gap(today, e.date) <= EVENT_NEAR_DAYS) ? [`${LEGS[leg].name} catalyst calendar ${monthOf(today)}`] : [],
    ...(hits.length && { leanHitRate: `lean hit rate: ${hits.filter(Boolean).length} of ${hits.length} calls` }),
    ...(siblings.length && { siblings }),
    ...((l, s) => ({ ...(l.length && { blockLifts: l }), ...(s.length && { stuckProne: s }) }))(liftsDue(live.signs, allEvents(live), today), stuckProne(live.signs, allEvents(live), today, measuredLiftsOf(leg))),
    verify,
  };
}

/** One researched row's result. `finding` + `lean` on CHANGED; `finding` alone on UNCHANGED (the same fact re-sourced fresher); `primary` only to swap a `replace` page in place or drop it (≥ 1 page stays). */
/** `measurableDraft` only on a `thresholdless` row: `<lean> = … ; <lean> = …` in the leg's lean words — lands as `measurable`'s ` · draft: ` segment; apply suffixes the lean ` (draft)` itself; `unblocking` = the UNBLOCKING clause body a new `block: true` needs, or a `contractOwed` row's rewrite (`withUnblocking` replaces its clause), `pin` = the date a holding block's reach holds through, `causeFalse` = the block's cause sourced false at a neutral lean (`vetBlockSet`, `causeFalseLifts`). */
/** `searchNext` = one better month-less stem for the next run's `more` — never printed for the user. */
type RowPatch = { label: string; finding?: string; lean?: string; sources?: LadderSource[]; block?: boolean; failed?: string[]; primary?: string[]; measurableDraft?: string; searchNext?: string; unblocking?: string; pin?: string; causeFalse?: true; measuredOnly?: true };
/** @internal */
export const SEARCH_NEXT_MAX = 2;
/** A stem dated to now goes stale (the plan appends the month): a year ≤ today's (a forward "2027 capex" stays), a full month name ("May" left out — a common verb), an MM-DD; a fiscal-quarter token names a report and stays. */
const datedStem = (q: string, today: string): boolean =>
  [...q.matchAll(/(?<!\d)(20[2-9]\d)(?!\d)/g)].some((m) => m[1]! <= today.slice(0, 4)) ||
  /\b(january|february|march|april|june|july|august|september|october|november|december)\b|\b(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/i.test(q);
/** The run's research, keyed by `signs[].sign` / `events[].event` / `calendar[].event`. Every planned row must appear in `signs`, and no other. */
type NewEvent = Omit<LadderEvent, "status"> & { status?: string };
export type LadderPatch = {
  signs: Record<string, RowPatch>;
  /** `sources` = the pages a landed `status` cites (replace the stored list); apply grades the status off them. */
  /** `drop` = the reason a pending (or landed, non-holding) event unnamed by `blocked.by` moves to `eventsDone` as `dropped: <reason>`, `holds: []` — its entry's sole key. */
  events?: Record<string, { status?: string; date?: string; sources?: LadderSource[]; verified?: boolean; dateNote?: string; preRead?: LadderPreRead; liftBy?: string[]; spares?: string[]; offCause?: true; drop?: string }>;
  /** `status` optional — a pending status is recomputed from `date` on every apply. */
  eventsAdd?: NewEvent[];
  /** `drop` = the reason a passed owed row (`calOwed`) is removed — patch-only, its sole key; an owed row otherwise moves (`date` ≥ today). */
  calendar?: Record<string, { date?: string; verified?: boolean; dateNote?: string; drop?: string }>;
  /** `matters` defaults `—`, `verified` `false` (a search-summary date, re-sourced in-window). */
  calendarAdd?: (Omit<LadderCalendar, "matters" | "verified"> & Partial<Pick<LadderCalendar, "matters" | "verified">>)[];
  /** All five slots on any rewrite trigger (stamps `asOf`); on a lint-only owed, a subset covering every `situationWhy` slot, merged onto the stored (`asOf` kept). */
  situation?: Partial<LadderSlots>;
};

/** A row's tag: `BLOCK` (its `block` flag) · `MIXED (<event>)` (a `mixed:` holding event — landed, never DELAY) · `DELAY until <d> (<event>)` / `DELAY — outcome unsourced (<event>)` (a pending holding event) · `CLEAR`. @internal */
export function tagOf(live: LadderLive, s: LadderSign, today: string): string {
  if (s.block && !isReleased(s, allEvents(live))) return "BLOCK";
  const mixed = linked(live, s.sign).find((e) => e.holds.length && outcomeOf(e) === "mixed");
  if (mixed) return `MIXED (${mixed.event})`;
  const pending = linked(live, s.sign).filter((e) => e.holds.length && !landed(e)).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (!pending) return "CLEAR";
  return pending.date <= today ? `DELAY — outcome unsourced (${pending.event})` : `DELAY until ${day(pending.date)} (${pending.event})`;
}

/** Per tranche: probe ✗ → ✗; ✓ + a BLOCK row on a `blockReach: "all"` leg → HELD (BLOCK: sign) — T2·T3 only once demoted (`blocked.reach: "T2T3"`); ✓ + an escalated holding event → HELD (ESCALATION: event); ✓ + a `mixed:` holding event → HELD (MIXED: event); ✓ + a pending holding event → HELD until its latest date (or outcome unsourced once passed); else ✓. @internal */
export function afterHolds(live: LadderLive, today: string, t: LadderTranche, leg: LadderLegId = "eufin"): string {
  if (!t.ok) return "✗";
  const block = LEGS[leg].blockReach === "all" && live.signs.find((s) => s.block && !isReleased(s, allEvents(live)) && (s.blocked?.reach !== "T2T3" || t.id !== "T1"));
  if (block) return `HELD (BLOCK: ${block.sign})`;
  const esc = allEvents(live).find((e) => e.holds.includes(t.id) && outcomeOf(e) === "escalation");
  if (esc) return `HELD (ESCALATION: ${esc.event})`;
  const mixed = live.events.find((e) => e.holds.includes(t.id) && outcomeOf(e) === "mixed");
  if (mixed) return `HELD (MIXED: ${mixed.event})`;
  const last = live.events.filter((e) => e.holds.includes(t.id) && !landed(e)).map((e) => e.date).sort().at(-1);
  return !last ? "✓" : last <= today ? "HELD — outcome unsourced" : `HELD until ${day(last)}`;
}

type Fail = (msg: string) => never;
/** A patch rejection: `message` = `<leg>:apply — <reason>`; `reason` = the defect lines alone (one per line), for a `defects` collector to fold. */
class Defect extends Error {
  constructor(
    prefix: string,
    readonly reason: string,
  ) {
    super(`${prefix} — ${reason}`);
  }
}
const failer =
  (leg: LadderLegId): Fail =>
  (msg) => {
    throw new Defect(`${leg}:apply`, msg);
  };
/** One apply's defect list: `note` records a defect, `sub` runs a check that `fail`s (a `Defect` caught into the list — any other throw escapes) and says whether it passed, `done` throws the list as one `Defect`. */
const defects = (fail: Fail) => {
  const bad: string[] = [];
  return {
    bad,
    note: (msg: string): void => void bad.push(msg),
    sub: (check: () => void): boolean => {
      const n = bad.length;
      try {
        check();
      } catch (e) {
        if (!(e instanceof Defect)) throw e;
        bad.push(e.reason);
      }
      return bad.length === n;
    },
    done: (): void => {
      if (bad.length) fail(bad.join("\n"));
    },
    /** `note(msg)` then `done()`: throws the list with `msg` last. */
    stop: (msg: string): never => fail([...bad, msg].join("\n")),
  };
};
const isObj = (o: unknown): o is object => typeof o === "object" && o !== null && !Array.isArray(o);
/** Throws once, listing every key outside `allowed` and every non-ISO value under a `date` key (a non-object `o` alone). */
const vet = (fail: Fail, where: string, o: unknown, allowed: readonly string[]): void => {
  if (!isObj(o)) fail(`${where}: is not an object`);
  const bad = defects(fail);
  for (const [k, v] of Object.entries(o)) {
    if (!allowed.includes(k)) bad.note(`${where}: "${k}" is not writable here (${allowed.join(", ")})`);
    if (k === "date" && !(typeof v === "string" && ISO.test(v))) bad.note(`${where}: date "${String(v)}" is not YYYY-MM-DD`);
  }
  bad.done();
};
const SIGN_KEYS = ["label", "finding", "lean", "sources", "block", "failed", "primary", "measurableDraft", "searchNext", "unblocking", "pin", "causeFalse", "measuredOnly"] as const;
const EVENT_KEYS = ["date", "event", "signs", "escalationIf", "fizzleIf", "holds", "secondary", "status", "sources", "verified", "dateNote", "preRead", "at", "liftBy", "spares"] as const;
/** Quote-aggregator hosts a new citation may not point at (cite the primary source instead) — data publishers, issuers and central banks are primaries, never listed here. */
const UNCITABLE_HOSTS = ["yahoo.com", "cnbc.com", "onvista.de"] as const;
/** The uncitable domain `url`'s host is on or under (dot boundary, trailing root dot ignored), else undefined. @internal */
export const uncitable = (url: string): string | undefined => {
  const h = hostOf(url).replace(/\.$/, "");
  return UNCITABLE_HOSTS.find((d) => h === d || h.endsWith(`.${d}`));
};
/**
 * `o` (a patch's sign row or event) with every `http(s)://` source on an uncitable host dropped from `sources` and `preRead.sources`, one `warn` line per drop —
 * never a refusal, so a resent stored list keeps its other sources. Input untouched; a malformed shape passes through to the vets, and a list the drop
 * empties meets its own emptiness rule there. Only patch content passes here: stored rows' sources are not re-vetted.
 */
const dropUncitable = <T>(o: T, where: string, warn: (msg: string) => void): T => {
  if (!isObj(o)) return o;
  const keep = (url: unknown): boolean => {
    const host = typeof url === "string" && /^https?:\/\//.test(url) ? uncitable(url) : undefined;
    if (host) warn(`warn ${where} — source ${String(url)} dropped: a market-data vendor host (${host}) — cite the primary source`);
    return !host;
  };
  const out = { ...o } as Record<string, unknown>;
  if (Array.isArray(out.sources)) out.sources = (out.sources as unknown[]).filter((x) => !isObj(x) || keep((x as { url?: unknown }).url));
  const pre = out.preRead;
  if (isObj(pre) && Array.isArray((pre as { sources?: unknown }).sources)) out.preRead = { ...pre, sources: ((pre as { sources: unknown[] }).sources).filter(keep) };
  return out as T;
};
/** `sources` (a sign row's or an event's): an array of `{date, url}` — ISO date (`vet`) ≤ `today`, an `http(s)://` url (so `hostOf` always parses a host). */
const vetSources = (fail: Fail, where: string, sources: unknown, today: string): void => {
  if (sources === undefined) return;
  if (!Array.isArray(sources)) fail(`${where}: sources is a list of {date, url}`);
  const bad = defects(fail);
  for (const x of sources as LadderSource[]) {
    if (!bad.sub(() => vet(fail, `${where} source`, x, ["date", "url"])) && !isObj(x)) continue;
    if (typeof x.date !== "string" || typeof x.url !== "string" || !x.url) bad.note(`${where} source: needs date + url`);
    else if (!/^https?:\/\//.test(x.url)) bad.note(`${where} source: url "${x.url}" is not http(s)://`);
    else if (ISO.test(x.date) && x.date > today) bad.note(`${where} source: date ${x.date} is after today ${today}`);
  }
  bad.done();
};
/** `preRead`: a non-empty string, or `{text, sources}` — non-empty text, ≥ 1 source, each an `http(s)://` URL or `search: <stem>` (walked in order). */
const vetPreRead = (fail: Fail, where: string, v: unknown): void => {
  if (typeof v === "string") {
    if (!v.trim()) fail(`${where}: preRead is non-empty`);
    return;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(`${where}: preRead is a string or {text, sources}`);
  const bad = defects(fail);
  bad.sub(() => vet(fail, `${where} preRead`, v, ["text", "sources"]));
  const { text, sources } = v as Partial<LadderPreRead>;
  if (typeof text !== "string" || !text.trim()) bad.note(`${where}: preRead.text is non-empty`);
  if (!Array.isArray(sources) || !sources.length) bad.note(`${where}: preRead.sources lists ≥ 1 source`);
  else for (const x of sources) if (typeof x !== "string" || !(/^https?:\/\/\S+$/.test(x) || /^search: \S/.test(x))) bad.note(`${where}: preRead source "${String(x)}" is not an http(s):// URL or \`search: <stem>\``);
  bad.done();
};
const CAL_KEYS = ["date", "sign", "event", "matters", "verified", "dateNote"] as const;
/** A passed, unverified calendar row that matters — its outcome is owed (`LadderPlan.calendarOwed`). */
const calOwed = (c: Pick<LadderCalendar, "date" | "verified" | "matters">, today: string): boolean => c.date < today && !c.verified && c.matters !== "—";

/** `now` = `was` with each `replace` page swapped in place for a new URL or dropped; every other page keeps its place. Order-preserving walk. */
const primaryMoved = (was: readonly string[], now: readonly string[], replace: readonly string[]): boolean => {
  let j = 0;
  for (const u of was) {
    if (now[j] === u) j++;
    else if (!replace.includes(u)) return false;
    else if (j < now.length && !was.includes(now[j]!)) j++; // swapped in place; otherwise dropped
  }
  return j === now.length;
};
/**
 * The row patch's vets — throws the defect list — then `sources` = the post-patch list (`postPatchSources`), `inWindow` = an in-window source in the patch or the row,
 * `p` = the vetted patch: a dated label's `MM-DD` = `labelDate(sources)`, a disallowed `finding` dropped, an in-window `searchNext` kept (`mergeSignPatch` skips it) — each a `warn` line, never a refusal.
 */
const vetSignPatch = (fail: Fail, s: LadderSign, given: RowPatch, plan: PlanRow, today: string, leans: readonly string[], warn: (msg: string) => void): { inWindow: boolean; sources: LadderSource[]; p: RowPatch } => {
  const bad = defects(fail);
  const p = dropUncitable({ ...given }, s.sign, warn);
  bad.sub(() => vet(fail, s.sign, p, SIGN_KEYS));
  const typed = (["finding", "lean", "measurableDraft"] as const).filter((k) => p[k] !== undefined && typeof p[k] !== "string");
  for (const k of typed) bad.note(`${s.sign}: ${k} is a string`);
  if (typed.length) bad.done();
  if (!RESEARCH_LABEL.test(p.label)) bad.note(`${s.sign}: label "${p.label}" is not a research label`);
  if (typeof p.label !== "string") bad.done();
  const changed = p.label === "CHANGED";
  if (changed && (p.finding === undefined || p.lean === undefined)) bad.note(`${s.sign}: CHANGED carries finding + lean`);
  if (!changed && p.lean !== undefined) bad.note(`${s.sign}: lean only on CHANGED`);
  if (p.measurableDraft !== undefined && !thresholdless(s.measurable)) bad.note(`${s.sign}: measurable already carries a threshold`);
  if (p.measurableDraft !== undefined) bad.sub(() => vetDraft(fail, s.sign, p.measurableDraft!, leans));
  if (changed && p.lean !== undefined) bad.sub(() => vetLean(fail, s.sign, p.lean!, leans, p.measurableDraft !== undefined || s.measurable.includes(DRAFT_SEP)));
  if (!changed && p.finding !== undefined && !/^UNCHANGED\b/.test(p.label)) {
    warn(`warn ${s.sign} — finding dropped: only on CHANGED or UNCHANGED`);
    delete p.finding;
  }
  if (p.measuredOnly !== undefined && ((p.measuredOnly as unknown) !== true || !s.measure || s.block)) {
    warn(`warn ${s.sign} — measuredOnly dropped: only on a non-block \`measure\` row`);
    delete p.measuredOnly;
  }
  const board = p.finding !== undefined && BOARD_NUMBER.exec(p.finding)?.[0];
  if (board) bad.note(`${s.sign}: finding carries a board number "${board}" — the board column prints the live reading; say it in words (above the line, rising)`);
  const sourced = bad.sub(() => vetSources(fail, s.sign, p.sources, today));
  if (p.block === true && contextRow(s)) bad.note(`${s.sign}: a context row (BLOCKING = none) never blocks — a block there would hold nothing`);
  if (p.searchNext !== undefined && (typeof p.searchNext !== "string" || !p.searchNext.trim() || datedStem(p.searchNext, today)))
    bad.note(`${s.sign}: searchNext is one non-empty stem with no current/past year, quarter, month or date — the plan appends the month`);
  if (p.primary && (!plan.replace.length || !primaryMoved(s.primary, p.primary, plan.replace))) bad.note(`${s.sign}: primary only swaps a page failed on two runs, in place, or drops it`);
  if (p.primary && !p.primary.length) bad.note(`${s.sign}: dropping the last primary page would leave none — swap it instead`);
  for (const u of Array.isArray(p.primary) ? p.primary : []) if (typeof u === "string" && !s.primary.includes(u) && uncitable(u)) bad.note(`${s.sign}: primary swap-in "${u}" is on a market-data vendor host (${uncitable(u)}) — swap in the publisher's page`);
  if (!sourced) bad.done();
  // One window read with the block vets (`withPatchSources`), so a vet never answers off a source apply drops.
  const [inWindow, sources] = [[...(p.sources ?? []), ...s.sources].some((x) => x.date >= plan.since), postPatchSources(s, p, plan.since)];
  const dated = /^(UNCHANGED|STALE)(?: (\d{2}-\d{2}))?$/.exec(p.label);
  if (dated || changed) {
    const derived = labelDate(sources);
    if (derived === undefined) bad.note(`${s.sign}: ${p.label} needs a source (in the patch, or one the row already holds in-window)`);
    else if (dated?.[1] === "STALE" && sources[0]!.date >= plan.since) bad.note(`${s.sign}: STALE but the newest source ${sources[0]!.date} is in-window — label it UNCHANGED or CHANGED`);
    else if (dated) {
      if (dated[2] !== undefined && dated[2] !== derived) warn(`warn ${s.sign} — label date ${dated[2]} → ${derived}`);
      p.label = `${dated[1]} ${derived}`;
    }
  } else if (p.label === "UNSOURCED" && p.sources?.length) bad.note(`${s.sign}: UNSOURCED carries no source`);
  // `mergeSignPatch` keeps no searchNext on an in-window row.
  if (inWindow && p.searchNext !== undefined) warn(`warn ${s.sign} — searchNext dropped: the row holds an in-window source`);
  bad.done();
  return { inWindow, sources, p };
};
/** A vetted row patch onto `s` (mutated): label, finding, lean, measurable, sources, searchNext, block, fails, primary, quiet, checked. */
const mergeSignPatch = (s: LadderSign, plan: PlanRow, today: string, { inWindow, sources, p }: ReturnType<typeof vetSignPatch>): void => {
  if (plan.extended && !p.measuredOnly) s.extendedOn = today;
  s.label = p.label;
  if (p.finding !== undefined) s.finding = p.finding;
  if (p.label === "CHANGED") moveLean(s, p.lean!, today);
  if (p.measurableDraft !== undefined) s.measurable = `${measurableParts(s.measurable).base}${DRAFT_SEP}${p.measurableDraft}`;
  if (p.unblocking !== undefined) s.measurable = withUnblocking(s.measurable, p.unblocking);
  // The lean's tag chain (` (draft)` included) is rebuilt by `gradedLean` once the run's blocks are final (`applyRun`, after the event loop).
  s.sources = sources;
  const stem = p.searchNext?.trim();
  const fresh = stem && !s.search.includes(stem) ? [stem] : [];
  const next = inWindow ? [] : [...(s.searchNext ?? []).filter((q) => q !== stem), ...fresh].slice(-SEARCH_NEXT_MAX);
  if (next.length) s.searchNext = next;
  else delete s.searchNext;
  if (p.block === true && !s.block) s.blocked = { on: today };
  if (p.block === false) delete s.blocked;
  if (p.block !== undefined) s.block = p.block;
  const fails = { ...s.fails };
  for (const u of p.measuredOnly ? [] : plan.fetch) if (p.failed?.includes(u)) fails[u] = (fails[u] ?? 0) + 1;
  else delete fails[u];
  if (p.primary) s.primary = p.primary;
  for (const u of Object.keys(fails)) if (!s.primary.includes(u) && !s.press?.includes(u)) delete fails[u];
  if (Object.keys(fails).length) s.fails = fails;
  else delete s.fails;
  if (/^(UNCHANGED|QUIET)/.test(p.label)) s.quiet = (s.quiet ?? 0) + 1;
  else delete s.quiet;
  s.checked = today;
};
/** Vet + merge one row; returns the patch as merged (`vetSignPatch`'s `p`). */
const applySign = (fail: Fail, s: LadderSign, p: RowPatch, plan: PlanRow, today: string, leans: readonly string[], warn: (msg: string) => void): RowPatch => {
  const vetted = vetSignPatch(fail, s, p, plan, today, leans, warn);
  mergeSignPatch(s, plan, today, vetted);
  return vetted.p;
};

/** A new deciding event: whole shape, ISO date, unique name, `holds` within the leg's holdable tranches (`LEGS[leg].holds`), none on a `secondary` event. */
/** A new event's pending status off its date (the apply-time recompute keeps it current). */
const pendingStatus = (e: Pick<LadderEvent, "date" | "holds">, today: string): string => (e.date > today ? `NOT DUE until ${e.date}` : e.holds.length ? "DELAY — outcome unsourced" : "outcome unsourced");
/** A new event's stored status: pending off its date when absent, a given landed one graded (`gradedStatus`), anything else as given (the next full apply recomputes a pending one). */
const addedStatus = (e: NewEvent, today: string, tier: ReadonlySet<string>): string =>
  e.status === undefined ? pendingStatus(e, today) : outcomeOf({ status: e.status }) ? gradedStatus(e.status, e.sources ?? [], tier) : e.status;
const vetEvent = (fail: Fail, live: LadderLive, e: NewEvent, holdable: readonly string[], adds: readonly NewEvent[], today: string): void => {
  if (!isObj(e)) fail("eventsAdd: an entry is not an object");
  const bad = defects(fail);
  bad.sub(() => vet(fail, `eventsAdd "${e.event}"`, e, EVENT_KEYS));
  const missing = EVENT_KEYS.some((k) => k !== "status" && k !== "sources" && k !== "verified" && k !== "dateNote" && k !== "preRead" && k !== "at" && k !== "liftBy" && k !== "spares" && !(k in e));
  if (missing || allEvents(live).some((x) => x.event === e.event)) bad.note(`eventsAdd "${e.event}": needs every field but \`status\` / \`sources\` / \`verified\` / \`dateNote\` / \`preRead\` / \`at\` / \`liftBy\` / \`spares\`, and a new name`);
  if (e.at !== undefined && !(e.at in OWED_FROM)) bad.note(`eventsAdd "${e.event}": at "${String(e.at)}" is not ${Object.keys(OWED_FROM).join(" / ")}`);
  bad.sub(() => vetSources(fail, `eventsAdd "${e.event}"`, e.sources, today));
  if ("preRead" in e) bad.sub(() => vetPreRead(fail, `eventsAdd "${e.event}"`, e.preRead));
  bad.sub(() => vetLiftBy(fail, `eventsAdd "${e.event}"`, e.liftBy, live, adds, e.event));
  bad.sub(() => vetSpares(fail, `eventsAdd "${e.event}"`, e.spares, Array.isArray(e.signs) ? e.signs : [], e.status));
  const shapeless = !missing && (!Array.isArray(e.holds) || !Array.isArray(e.signs) || (e.status !== undefined && typeof e.status !== "string"));
  if (shapeless) bad.note(`eventsAdd "${e.event}": holds and signs are lists, status a string`);
  if (missing || shapeless) bad.done();
  if (e.holds.some((t) => !holdable.includes(t)) || (e.secondary && e.holds.length)) bad.note(`eventsAdd "${e.event}": holds ${holdable.join("/")} only, none when secondary`);
  const probes = e.signs.filter((x) => live.signs.some((s) => s.sign === x && s.probe));
  if (probes.length) bad.note(`eventsAdd "${e.event}": sign ${probes.join(", ")} is a probe row — read off its box family, never researched or blocked, so no event names it`);
  bad.done();
};

/** The patch's shape (top-level keys, row/event/list types) — a bad shape throws the list at once — then the `situation` slots, noted on `bad`. */
const vetPatchShape = (fail: Fail, bad: ReturnType<typeof defects>, live: LadderLive, patch: LadderPatch): void => {
  bad.sub(() => vet(fail, "patch", patch, ["signs", "events", "eventsAdd", "calendar", "calendarAdd", "situation"]));
  const shape = bad.bad.length;
  if (!isObj(patch.signs)) bad.note(`patch: signs is an object of row patches ({} when none)`);
  else for (const [sign, p] of Object.entries(patch.signs)) if (!isObj(p)) bad.note(`${sign}: a row patch is an object`);
  for (const k of ["events", "calendar"] as const) if (patch[k] !== undefined && !isObj(patch[k])) bad.note(`patch: ${k} is an object keyed by name`);
  for (const k of ["eventsAdd", "calendarAdd"] as const) if (patch[k] !== undefined && !Array.isArray(patch[k])) bad.note(`patch: ${k} is a list`);
  if (bad.bad.length > shape) bad.done();
  if (patch.situation !== undefined && (bad.sub(() => vet(fail, "situation", patch.situation, SITUATION_SLOTS.map(([k]) => k))) || isObj(patch.situation))) {
    for (const [k] of SITUATION_SLOTS) if (k in patch.situation && (typeof patch.situation[k] !== "string" || !patch.situation[k].trim())) bad.note(`situation.${k}: a patched slot is a non-empty string`);
    for (const [k] of SITUATION_SLOTS) {
      const text = patch.situation[k];
      if (typeof text !== "string") continue;
      const board = BOARD_NUMBER.exec(text)?.[0];
      if (board) bad.note(`situation.${k}: carries a board number "${board}" — the board column prints the live reading; say it in words`);
      const named = situationRefusal(live.verdict, text);
      if (named !== undefined) bad.note(`situation.${k}: names "${named}" — gates, clusters, criteria, votes and counts live in the Verdict / Blockers / Episode tables; write the conclusion and what it commits the holder to`);
    }
  }
};

/** A `<mult>×<base>` hit (`1.3×73.39`, ASCII `1.3x73.39`). */
const MULT_FORM = /\d\s*×|\d[xX]\s*\d/;
/** Licensed levels are not published: every patch string `findLicensedLevels` flags (src/licensed-levels.ts — the same rule the
 *  verdict scrub applies) is a defect naming its path and the quoted level — a licensed index level or a licensed close; thresholds,
 *  criteria and ✓/✗ pass. A `<mult>×<level>` threshold is refused too (never auto-rewritten on apply, as no level is), its note
 *  quoting the WHOLE string as the scrub rewrites it (the product behind a comparison, else `—`) — scan-stable, so following it passes. */
const vetLicensedLevels = (note: (m: string) => void, patch: LadderPatch): void => {
  for (const { path, hit, kind, scrubbed } of findLicensedLevelsInLeg(patch)) {
    const what = kind === "close" ? "licensed close" : "licensed index level";
    note(
      `patch${path}: quotes the ${what} "${hit}" — ${what}s are not published; ${MULT_FORM.test(hit) && scrubbed !== undefined ? `print the threshold as the scrub does: "${scrubbed}"` : `write "—" or its state against the criterion (e.g. "CCC — (above fizzle line)")`}`,
    );
  }
};

/** What one `events` entry reads and writes: `live` = the pre-run state, `next` = the row's home (a `drop` moves the row to `next.eventsDone`), `landedNowRows` collects every outcome landing this run, `droppedLines` one delta line per drop. */
type EventRun = { live: LadderLive; next: LadderLive; eventsAdd: LadderPatch["eventsAdd"]; today: string; tier: Set<string>; landedNowRows: LadderEvent[]; droppedLines: string[]; warn: (msg: string) => void };
/** One `events` entry onto its `next` row: `fail`s with the entry's defect list, else stores it and re-grades the status (a pre-read keeps the pending status);
 *  a `drop` moves the row to `eventsDone` as `dropped: <reason>` with `holds: []`. An overdue pending event's date moves only to ≥ today unless an outcome lands. */
const applyEventPatch = (fail: Fail, { live, next, eventsAdd, today, tier, landedNowRows, droppedLines, warn }: EventRun, name: string, given: NonNullable<LadderPatch["events"]>[string]): void => {
  const e = dropUncitable(given, `event "${name}"`, warn);
  const ev = defects(fail);
  if (!ev.sub(() => vet(fail, `event "${name}"`, e, ["status", "date", "sources", "verified", "dateNote", "preRead", "liftBy", "spares", "offCause", "drop"])) && !isObj(e)) return ev.done();
  ev.sub(() => vetLiftBy(fail, `event "${name}"`, e.liftBy, next, eventsAdd, name));
  if (e.status !== undefined && typeof e.status !== "string") return ev.stop(`event "${name}": status is a string`);
  const row = next.events.find((x) => x.event === name);
  if (!row) return ev.stop(`event "${name}" ${retiredName(next, name) ? "is retired (eventsDone) — history is read-only" : "not found"}`);
  ev.sub(() => vetSpares(fail, `event "${name}"`, e.spares, row.signs, e.status ?? row.status));
  if ("drop" in e) {
    if (typeof e.drop !== "string" || !e.drop.trim() || Object.keys(e).length !== 1) ev.note(`event "${name}": drop is a non-empty reason, its entry's sole key`);
    if (landed(row) && row.holds.length) ev.note(`event "${name}": drop is only for a pending event or a landed one holding no tranche — it holds ${row.holds.join("+")}`);
    const by = next.signs.filter((s) => s.blocked?.by === name).map((s) => s.sign);
    if (by.length) ev.note(`event "${name}": drop refused — blocked.by names it (${by.join(", ")})`);
    if (mixedOwedAt(row, today)) ev.note(`event "${name}" mixedOwed: drop refused — re-land escalation: or fizzle: from a source dated after the landing`);
    ev.done();
    next.events = next.events.filter((x) => x !== row);
    next.eventsDone = [...(next.eventsDone ?? []), doneOf({ ...row, holds: [], status: `dropped: ${e.drop}` })];
    droppedLines.push(`events   ${name} — dropped: ${e.drop}`);
    return;
  }
  ev.sub(() => vetSources(fail, `event "${name}"`, e.sources, today));
  if (e.preRead !== undefined) {
    ev.sub(() => vetPreRead(fail, `event "${name}"`, e.preRead));
    if (typeof e.preRead !== "object") ev.note(`event "${name}": a patch preRead is {text, sources}`);
    if (landed(row)) ev.note(`event "${name}": a preRead is a pending event's — this one has landed`);
  }
  // The grade tags are apply's: a patch status that carries them is vetted (and stored) bare, then re-graded off the stored sources.
  const status = e.status === undefined ? undefined : stripTags(e.status);
  const was = live.events.find((x) => x.event === name);
  if (was && overdueAt(was, today) && e.date !== undefined && e.date !== was.date && e.date < today && !(status !== undefined && outcomeOf({ status })))
    ev.note(`event "${name}" (${was.date}) overdue: a move needs date >= ${today}, else land an outcome or drop it`);
  if (was && mixedOwedAt(was, today) && e.date !== undefined && e.date !== was.date && !/^(escalation|fizzle): /.test(status ?? ""))
    ev.note(`event "${name}" mixedOwed: a date move does not answer it — re-land escalation: or fizzle: from a source dated after the landing`);
  if (was && mixedOwedAt(was, today) && /^(escalation|fizzle): /.test(status ?? "") && !(Array.isArray(e.sources) ? e.sources : []).some((x: unknown) => isObj(x) && "date" in x && typeof x.date === "string" && x.date > landedOn(was)))
    ev.note(`event "${name}" mixedOwed: a re-land answers it only from a source dated after the landing (${landedOn(was)}) — the patch's sources carry none`);
  if (status !== undefined && isPreRead(status)) {
    if (landed(row) || status.slice(4, 14) > today || status.slice(4, 14) < addDays(today, -1)) ev.note(`event "${name}": a \`pre <date>: <read>\` status is a pending event's, dated yesterday or today`);
    // A sourced preRead cites the host that answered (the list walked in order), or reports the whole list unreadable — a bare string keeps the bare read.
    // An `n/a` read names no host: it passes only as the exact all-unreadable form (a single host's n/a is not the walked list's verdict).
    if (typeof (e.preRead ?? row.preRead) === "object" && (status.slice(16).startsWith("n/a") ? status !== `pre ${status.slice(4, 14)}: n/a (all unreadable)` : !PRE_READ_HOST.test(status)))
      ev.note(`event "${name}": a sourced preRead's status ends \` (<host>)\` (the source that answered) or is \`pre <date>: n/a (all unreadable)\``);
    ev.done();
    Object.assign(row, e);
    row.status = `${pendingStatus(row, today)} · ${status}`;
    return;
  }
  if (status !== undefined && !/^(escalation|fizzle|mixed): /.test(status)) ev.note(`event "${name}": a patch status is a landed outcome (escalation: / fizzle: / mixed:) or a pending event's \`pre <date>: <read>\``);
  if (status?.startsWith("mixed: ") && !/^mixed: .+ — unchecked: \S/.test(status)) ev.note(`event "${name}": a mixed: status is \`mixed: <outcome, date> — unchecked: <clause>\``);
  if (status?.startsWith("fizzle: ") && /unverified|unchecked|not re-sourced/i.test(status)) ev.note(`event "${name}": a fizzle: with an unverified clause is a mixed:`);
  if (status !== undefined && row.expect && !/\bvs cons \S/.test(status)) ev.note(`event "${name}": an \`expect\` event's status carries \`vs cons <x>\` (expect: ${row.expect})`);
  ev.done();
  const stored = row.status;
  const wasPending = !landed(row);
  Object.assign(row, e);
  if (status !== undefined && !e.offCause) delete row.offCause;
  // Landing replaces the sources: a pending event's are Rung 0's date pages, never the outcome's (else graded primary / an early `landedOn`).
  if (status !== undefined && wasPending) {
    if (e.sources?.length) row.sources = e.sources;
    else delete row.sources;
  }
  // `called` reads the PRE-run signs (this run's lean moves are not the call); a re-sent identical outcome keeps its stored segment.
  const called = live.signs.filter((s) => row.signs.includes(s.sign)).map((s) => `${s.sign}=${leanBefore(s, row.date)}`);
  const segment = status !== undefined && bareStatus(status) === bareStatus(stored) ? (CALLED.exec(stripTags(stored))?.[0] ?? "") : called.length ? ` · called: ${called.join(", ")}` : "";
  if (status !== undefined) row.status = gradedStatus(`${status.replace(CALLED, "")}${segment}`, row.sources ?? [], tier);
  // A sources-only patch on a landed status re-grades it off the new list (`gradedStatus` strips the old tags first).
  else if (e.sources !== undefined && outcomeOf(row)) row.status = gradedStatus(row.status, row.sources ?? [], tier);
  // Only an outcome landing this run moves a block (`resolveBlocks`); a re-sent identical one is no new evidence.
  if (status !== undefined && bareStatus(status) !== bareStatus(stored)) landedNowRows.push(row);
};

/** The run's patch → the next state (input untouched) + the delta lines for the chat (SKILL.md step 5). */
/** `reverdict` (a `blockReach: "graded"` leg) re-derives the verdict off the patched `signs` before the `runs` row and the delta read it. */
/** `at` = the run's wall-clock instant → `runAt` (`runStamp`); absent (a backfill) drops a stale `runAt`. `now` = the same instant for the re-plan's event windows (`planRun`), so apply plans what `:state` planned. */
export function applyRun(live: LadderLive, patch: LadderPatch, today: string, leg: LadderLegId = "eufin", reverdict?: (next: LadderLive) => LadderVerdict, at?: string, now?: Date): { next: LadderLive; delta: string[]; alert?: NtfyMessage } {
  const fail = failer(leg);
  if (!ISO.test(today)) fail(`today "${today}" is not YYYY-MM-DD`);
  if (at !== undefined && !INSTANT.test(at)) fail(`at "${at}" is not an ISO instant`);
  const v0 = live.verdict ?? fail("no verdict — run the probe first");
  for (const s of live.signs) vetProbeLeans(fail, s, LEGS[leg].leans);
  if (!isObj(patch)) fail("patch: is not an object");
  const bad = defects(fail);
  vetPatchShape(fail, bad, live, patch);
  vetLicensedLevels(bad.note, patch);
  vetBlockSet(bad.note, live, patch, today, measuredLiftsOf(leg));
  const rewritten = vetContractOwed(bad.note, live, patch, today, measuredLiftsOf(leg));
  const plan = planRun(live, today, leg, {}, now);
  const planned = new Map(plan.research.map((r) => [r.sign, r]));
  for (const sign of Object.keys(patch.signs)) if (!planned.has(sign)) bad.note(`${sign}: not on this run's research list`);
  const missing = [...planned.keys()].filter((sign) => !patch.signs[sign]);
  if (missing.length) bad.note(`researched rows missing from the patch: ${missing.join(", ")} — copy the \`patch\` stub whole`);
  const next: LadderLive = structuredClone(live);
  next.run = today;
  if (at === undefined) delete next.runAt;
  else next.runAt = at;
  const warned: string[] = [];
  const vetted: Record<string, RowPatch> = {};
  for (const s of next.signs) {
    const p = patch.signs[s.sign];
    const row = planned.get(s.sign);
    if (p && row) bad.sub(() => void (vetted[s.sign] = applySign(fail, s, p, row, today, LEGS[leg].leans, (w) => void warned.push(w))));
    else s.label = gate(live, s, today, now).label ?? s.label;
  }
  // Every later read (blocks, nags, the alert) sees the rows as merged.
  patch = { ...patch, signs: { ...patch.signs, ...vetted } };
  const tier = primaryHosts(next);
  const graded = new Set(Object.keys(patch.signs));
  const landedNowRows: LadderEvent[] = [];
  const droppedEvents: string[] = [];
  const eventRun: EventRun = { live, next, eventsAdd: patch.eventsAdd, today, tier, landedNowRows, droppedLines: droppedEvents, warn: (w) => void warned.push(w) };
  for (const [name, e] of Object.entries(patch.events ?? {})) bad.sub(() => applyEventPatch(fail, eventRun, name, e));
  // offCause vets against the state every event patch left (a same-patch `liftBy` counts, whatever the key order), before resolveBlocks reads it.
  for (const [name, e] of Object.entries(patch.events ?? {})) {
    const row = isObj(e) && (e.status === undefined || typeof e.status === "string") ? next.events.find((x) => x.event === name) : undefined;
    if (row) bad.sub(() => vetOffCause(fail, `event "${name}"`, e.offCause, e.status, live.events.find((x) => x.event === name)?.status, row, next, patch));
  }
  // Probe rows (never in `graded`, so no grade tag lands on them): read → bare lean + `PROBE <MM-DD>` + `checked`, both the verdict's close date (else today);
  // unread keeps its last read's word and label, its grade tags stripped (a ` (draft)` there has no draft segment to clear it).
  const probedOn = v0.asOf?.close ?? today;
  next.signs.forEach((s, i) => {
    if (!s.probe) return;
    const lean = probeLean(v0, s, LEGS[leg].leans);
    if (lean) {
      moveLean(s, lean, today);
      [s.label, s.checked] = [`PROBE ${probedOn.slice(5)}`, probedOn];
      return;
    }
    s.lean = stripTags(s.lean);
    if (live.signs[i]!.label.startsWith("PROBE ")) s.label = live.signs[i]!.label;
  });
  const adds = (patch.eventsAdd ?? []).map((e) => dropUncitable(e, `eventsAdd "${isObj(e) ? e.event : "?"}"`, (w) => void warned.push(w))).filter((e) => bad.sub(() => vetEvent(fail, next, e, LEGS[leg].holds, patch.eventsAdd ?? [], today)));
  const addedRows = adds.map((e) => ({ ...e, status: addedStatus(e, today, tier) }));
  next.events.push(...addedRows);
  stampRewritten(next.signs, rewritten, today);
  const lifts = resolveBlocks(next, patch, [...landedNowRows, ...addedRows.filter(landed)], graded, today, measuredLiftsOf(leg));
  // Before the head's `afterHolds`, so it reads the cut holds.
  const valve = degradeMixed(next, today);
  // Blocks are final: rebuild the tag chain of every researched row and every row whose block moved.
  for (const s of next.signs) if (graded.has(s.sign)) s.lean = gradedLean(s, tier);
  for (const e of next.events)
    if (!landed(e)) e.status = `${pendingStatus(e, today)}${((m) => (m ? ` · ${m[1]}` : ""))(PRE_READ.exec(e.status))}`;
  const dropped: string[] = [];
  const calFailed = new Set<string>();
  const deduped = dedupeCalendar(next.calendar);
  next.calendar = deduped.calendar;
  for (const [name, c] of Object.entries(patch.calendar ?? {})) {
    const ok = bad.sub(() => {
      const cal = defects(fail);
      if (!cal.sub(() => vet(fail, `calendar "${name}"`, c, ["verified", "date", "dateNote", "drop"])) && !isObj(c)) return cal.done();
      const row = next.calendar.find((x) => x.event === name);
      if (!row) {
        cal.note(`calendar "${name}" not found`);
        return cal.done();
      }
      const owed = calOwed(row, today);
      if ("drop" in c) {
        if (!owed) cal.note(`calendar "${name}": drop is only for a passed unrecorded row`);
        if (typeof c.drop !== "string" || !c.drop.trim() || Object.keys(c).length !== 1) cal.note(`calendar "${name}": drop is a non-empty reason, its entry's sole key`);
        cal.done();
        dropped.push(`calendar dropped: ${row.event} (${row.date}) — ${c.drop}`);
        next.calendar = next.calendar.filter((x) => x !== row);
        return;
      }
      if (owed && !(c.date !== undefined && c.date >= today)) cal.note(`calendar "${name}" (${row.date}) passed: a move needs date >= ${today}, else drop it`);
      cal.done();
      Object.assign(row, c);
    });
    if (!ok) calFailed.add(name);
  }
  for (const c of next.calendar) if (calOwed(c, today) && !calFailed.has(c.event)) bad.note(`calendar "${c.event}" (${c.date}) passed unrecorded — move it ({date, verified}) or drop it ({drop: "<reason>"})`);
  for (const c of patch.calendarAdd ?? []) {
    if (!isObj(c)) {
      bad.note("calendarAdd: an entry is not an object");
      continue;
    }
    bad.sub(() => vet(fail, `calendarAdd "${c.event}"`, c, CAL_KEYS));
    if (!("date" in c) || !("event" in c) || (c.sign !== undefined && !next.signs.some((s) => s.sign === c.sign))) bad.note(`calendarAdd "${c.event}": needs date + event, and a given sign must be a signs[] row`);
  }
  const { calendar, delta: calDelta } = mergeCalendar(next.calendar, (patch.calendarAdd ?? []).filter(isObj).map((c) => ({ matters: "—", verified: false, ...c })), next.events, (n) => bad.note(n));
  const unrecorded = calendar.filter((c) => c.date < today && !c.verified && c.matters !== "—").map((c) => `calendar passed, outcome unrecorded: ${c.event}`);
  next.calendar = calendar.filter((c) => c.date >= today);
  // Cadence stamps: the rows this run's plan sent to `verify[]` and the `scan` query it ran — apply re-plans with the same clock, so the stamped set is the set `:state` printed.
  // Only on a research run: `research: []` skips Rung 0 (the skill's step 1, the scripted idle path), so nothing was searched.
  if (plan.research.length) {
    const checked = new Set(plan.verify.map((v) => v.event));
    for (const x of [...next.events, ...next.calendar]) if (checked.has(x.event)) x.verifyChecked = today;
    if (plan.scan.length) next.scannedOn = today;
  }
  const given = SITUATION_SLOTS.map(([k]) => k).filter((k) => isObj(patch.situation) && k in patch.situation);
  if (given.length === SITUATION_SLOTS.length) next.situation = { ...(patch.situation as LadderSlots), asOf: today };
  else if (given.length) next.situation = { ...live.situation!, ...patch.situation };
  const v = reverdict && !bad.bad.length ? (next.verdict = reverdict(next)) : v0;
  // The probe stamped watch-row leans before this patch moved them — re-read each off the patched row.
  for (const x of (next.verdict?.watch?.rows ?? []).flatMap((r) => r.signs ?? [])) x.lean = next.signs.find((s) => s.sign === x.sign)?.lean ?? x.lean;
  const hot = hotSigns(v);
  for (const s of next.signs) if (planned.has(s.sign)) s.due = s.block || isReleased(s, allEvents(next)) || eventWatch(next, s, today, now) ? today : addDays(today, hot.has(s.sign) ? Math.min(HOT_CADENCE_DAYS, s.cadence ?? 7) : (s.cadence ?? 7));
  next.runs = [runOf(v, today), ...next.runs.filter((r) => r.date !== today)].slice(0, 5);

  const held = (ts: LadderTranche[]): string[] => ts.map((t) => afterHolds(next, today, t, leg));
  const close = held(v.tranches);
  const head = `${LEGS[leg].name} ${today} · ${v.regime.set} set · after holds: ${close.map((c, i) => `T${i + 1} ${c}`).join(" · ")} · live ${held(v.live).join(" ")}${v.prov ? " (prov.)" : ""}${v.watch ? ` · watch ${v.watch.grade}` : ""}`;
  const lines = next.signs.flatMap((s, i) => {
    const before = live.signs[i]!;
    const tag = tagOf(next, s, today);
    if (tag !== "BLOCK" && tag === tagOf(live, before, today) && s.label === before.label && s.finding === before.finding) return [];
    const kind = tag === "BLOCK" ? "BLOCK" : s.label.split(" ")[0]!;
    return [`${kind.padEnd(8)} ${s.sign} — ${tag} — ${s.label}${s.finding !== before.finding ? `: ${s.finding}` : ""}`];
  });
  const events = next.events.flatMap((e) => {
    const was = live.events.find((x) => x.event === e.event)?.status;
    return was === e.status ? [] : [`events   ${e.event} — ${was ?? "new"} → ${e.status}`];
  });
  // A re-stated already-landed status is no change — only a status differing from the stored event's counts (as `runAlert` filters); a grade-tag-only difference is none.
  const redated = Object.entries(patch.events ?? {}).some(([name, e]) => e.date !== undefined && e.date !== live.events.find((x) => x.event === name)?.date);
  const fired = [
    ...(Object.values(patch.signs).some((p) => p.label === "CHANGED") ? ["CHANGED row"] : []),
    ...(Object.entries(patch.events ?? {}).some(([name, e]) => restatus(live, name, e.status)) ? ["event status change"] : []),
    ...verdictMoves(live, v, today),
    ...(patch.eventsAdd?.length ? ["added event"] : []),
    ...(redated ? ["re-dated event"] : []),
  ];
  const why = plan.situationWhy ?? [];
  const rewrite = [...reread(patch.situation === undefined ? undefined : given, fired, why), ...relint(next, given, why, live.verdict, today)];
  // A slot kept byte-identical while naming the `MM-DD` of an event landing this run still reads that event as pending
  // (a date a still-pending event shares stays nameable; an eventsAdd landed in-run counts as landing).
  const stillPending = new Set(next.events.filter((e) => !landed(e)).map((e) => e.date.slice(5)));
  const landedNow = next.events
    .filter((e) => ((was) => landed(e) && (!was || !landed(was)))(live.events.find((x) => x.event === e.event)))
    .map((e) => e.date.slice(5))
    .filter((m) => !stillPending.has(m));
  const keptSlots = SITUATION_SLOTS.flatMap(([k]) => {
    const text = patch.situation?.[k];
    const d = text !== undefined && text === live.situation?.[k] ? landedNow.find((m) => new RegExp(`(?<!\\d)${m}(?!\\d)`).test(text)) : undefined;
    return d === undefined ? [] : [`situation ${k} kept unchanged but names ${d}, an event landing this run — rewrite it past the outcome.`];
  });
  // An event landing THIS run (pending before, a status in the patch) whose named rows were researched but keep their finding — a row off the
  // research list or a non-row name cannot have been rewritten, so it never nags (review 2026-10-16).
  // Off the patch, not `next`: a row whose `applySign` failed is unmutated, so its own finding (if any) still counts as the rewrite.
  const unrewritten = (sign: string): boolean => planned.has(sign) && ((was) => (patch.signs[sign]?.finding ?? was) === was)(live.signs.find((s) => s.sign === sign)?.finding);
  const nagFinding = (sign: string, event: string): string => `finding not rewritten for ${sign} after ${event} — a landed event rewrites each named row's finding.`;
  const landing = Object.entries(patch.events ?? {}).flatMap(([name, e]) => {
    const was = live.events.find((x) => x.event === name);
    if (e.status === undefined || isPreRead(stripTags(e.status)) || !was || landed(was)) return [];
    return was.signs.filter(unrewritten).map((sign) => nagFinding(sign, name));
  });
  // An earlier landed event the row's newest source still predates (`staleAfter`), judged on the PRE-patch row planRun saw — so apply rejects
  // only what `:state` forced (a QUIET patch emptying the window must not conjure a nag), and a post-event source without a rewritten finding
  // still fails. Plus an `eventsAdd` landing this run (it exists only in `next`), judged on the same pre-patch row.
  const added = new Set((patch.eventsAdd ?? []).map((e) => e.event));
  const lingering = live.signs.flatMap((s) =>
    unrewritten(s.sign) ? [...staleAfter(live, s, today), ...staleAfter(next, s, today).filter((e) => added.has(e.event))].map((e) => nagFinding(s.sign, e.event)) : [],
  );
  // Both nags are hard fails: the patch is rejected before `next` is written, so a stale finding or situation never lands (ladder-skill-kaizen-critique, pipeline).
  for (const nag of [...new Set([...landing, ...lingering]), ...rewrite, ...keptSlots]) bad.note(nag);
  bad.done();
  const alert = runAlert(live, next, patch, leg, today, v, lifts, valve.cuts);
  const early = (plan.released ?? []).map((r) => `released ${r}`);
  const retired = retireEvents(next, today);
  return { next: retired.next, delta: [head, ...warned, ...lines, ...early, ...lifts, ...events, ...droppedEvents, ...valve.delta, ...retired.delta, ...deduped.delta, ...dropped, ...calDelta, ...unrecorded], ...(alert && { alert }) };
}

/** A lean is one of the leg's `leans`; only `unknown` may carry the ` until YYYY-MM-DD` suffix; the grade tags are stripped first (`stripTags` — apply rebuilds them,
 *  `gradedLean`), ` (draft)` among them only while `drafted` (a `measurableDraft` in the patch, or a draft segment the row already holds). */
const vetLean = (fail: Fail, where: string, lean: string, leans: readonly string[], drafted = false): void => {
  const bare = stripTags(lean);
  if (lean.slice(bare.length).includes(DRAFT_SUFFIX) && !drafted) fail(`${where}: lean "${lean}" carries "${DRAFT_SUFFIX}" without a measurableDraft (or a draft segment in measurable)`);
  const k = leanWord(bare);
  if (!leans.includes(k) || (k !== bare && k !== "unknown")) fail(`${where}: lean "${lean}" is not one of ${leans.join("/")} (only unknown may carry \` until YYYY-MM-DD\`)`);
};
/** `<lean> = … ; <lean> = …` — two or more sides, each label a lean of the leg but `unknown`, none twice, none empty. */
const vetDraft = (fail: Fail, where: string, draft: string, leans: readonly string[]): void => {
  const parts = draft.split(CLAUSE_SPLIT);
  const labels = parts.map((c) => CLAUSE.exec(c)?.[1]);
  const bad = parts.length < 2 || labels.some((l) => !l || l === "unknown" || !leans.includes(l)) || new Set(labels).size !== labels.length || parts.some((c) => !c.replace(CLAUSE, "").trim()) || draft.includes(DRAFT_SEP);
  if (bad) fail(`${where}: measurableDraft "${draft}" is not \`<lean> = … ; <lean> = …\` (one clause per side, each of ${leans.filter((l) => l !== "unknown").join("/")})`);
};
/** [USER] 2026-10-13: a lean move pushes, except into `unknown` and unknown → the neutral group (`leanGroup` 1: neutral / open / mixed). */
const leanMoved = (was: string, now: string): boolean => {
  const [a, b] = [leanWord(was), leanWord(now)];
  return a !== b && b !== "unknown" && !(a === "unknown" && leanGroup(now) === 1);
};
const holdText = (tag: string): string =>
  tag === "CLEAR" ? "none" : tag.replace(/^DELAY until (.+?) \((.+)\)$/, "waits on $2 ($1)").replace(/^DELAY — outcome unsourced \((.+)\)$/, "waits on $1 — outcome not found yet").replace(/^MIXED \((.+)\)$/, "waits on $1 — a clause still unchecked");
const holdsText = (e: LadderEvent): string => `holds ${e.holds.join("/") || "nothing"}`;
const trancheLine = (ts: LadderTranche[], was: (string | undefined)[], now: (string | undefined)[], held: string[]): string =>
  ts
    .map((t, i) => {
      const g = was[i] && now[i] && was[i] !== now[i] ? `${was[i]} → ${now[i]}` : t.ok ? "✓" : "✗";
      return `T${i + 1} ${g} ${t.met}/${t.total}${held[i] === "✓" || held[i] === "✗" ? "" : ` (${held[i]!.replace(/^HELD/, "held")})`}`;
    })
    .join(" · ");

/** The phone body: moved rows old → new, landed/new events, tranches vs `live.runs[0]`, then what to watch on the moved rows. */
function pushBody(live: LadderLive, next: LadderLive, leg: LadderLegId, today: string, v: LadderVerdict): string[] {
  const wasWatch = lastWatch(live);
  const moved = next.signs.flatMap((s, i) => {
    const b = live.signs[i]!;
    const [t0, t1] = [tagOf(live, b, today), tagOf(next, s, today)];
    const fresh = s.finding !== b.finding;
    return fresh || t0 !== t1 || leanWord(b.lean) !== leanWord(s.lean) || !!b.block !== !!s.block ? [{ s, b, t0, t1, fresh }] : [];
  });
  const rows = moved.flatMap(({ s, b, t0, t1, fresh }) => [
    `${s.sign}  lean ${leanWord(b.lean) === leanWord(s.lean) ? s.lean : `${b.lean} → ${s.lean}`} · ${((c) => (c?.released ? releasedText(c) : s.block ? "BLOCK" : "no block"))(deriveContract(s, allEvents(next), today))}${!!b.block === !!s.block ? "" : s.block ? ` (new)${((c) => (c ? ` ${blockLine(c)}` : ""))(deriveContract(s, allEvents(next), today))}` : s.blocked ? "" : " (lifted)"}`,
    ...(fresh ? [`  was: ${b.finding || "nothing recent found"}`, `  now: ${s.finding}`] : []),
    ...(t0 === t1 || !!b.block !== !!s.block ? [] : [`  hold: ${holdText(t0)} → ${holdText(t1)}`]),
  ]);
  const events = next.events.flatMap((e) => {
    const was = live.events.find((x) => x.event === e.event)?.status;
    const pre = PRE_READ.exec(e.status)?.[1];
    const bare = pre === undefined || landed(e) ? e.status : e.status.replace(PRE_READ, "");
    const now = `${/outcome unsourced$/.test(bare) ? (e.date === today ? "today, outcome not in yet" : "outcome not found yet") : bare.replace(/^NOT DUE until (\S+)$/, "due $1")}${bare === e.status ? "" : ` · ${pre}`}`;
    return was !== undefined && stripTags(was) === stripTags(e.status) ? [] : [`${e.event} (${day(e.date)}): ${was === undefined ? "new, " : ""}${now} · ${holdsText(e)}`];
  });
  const close = [glyphs(live.runs[0], false), glyphs(next.runs[0], false)] as const;
  const intra = [glyphs(live.runs[0], true), glyphs(next.runs[0], true)] as const;
  const held = (ts: LadderTranche[]): string[] => ts.map((t) => afterHolds(next, today, t, leg));
  const watch = [
    ...new Set(
      moved.flatMap(({ s }) => [
        // Only `<label> = <criterion>` clauses (`clauses`): a measurability note is not a criterion; the drafted sides print as `draft: <lean> if …`.
        ...clauses(measurableParts(s.measurable).base).map((c) => `  ${s.sign}: ${c.replace(/^BLOCKING = /, "BLOCK if ").replace(CLAUSE, "$1 if ")}`),
        ...clauses(measurableParts(s.measurable).draft).map((c) => `  ${s.sign}: draft: ${c.replace(CLAUSE, "$1 if ")}`),
        ...linked(next, s.sign).filter((e) => !landed(e)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 1).map((e) => `  ${day(e.date)} ${e.event} — ${holdsText(e)}; escalates if ${e.escalationIf}`),
      ]),
    ),
  ];
  const impact = [
    `Tranches: ${flipped(close) ? "" : "no change — "}${trancheLine(v.tranches, ...close, held(v.tranches))}`,
    ...(flipped(intra) ? [`Intraday: ${trancheLine(v.live, ...intra, held(v.live))}`] : []),
    ...(v.watch && wasWatch && watchWord(wasWatch) !== watchWord(v.watch.grade) ? [`Drawdown watch: ${wasWatch} → ${watchGrade(v.watch)} (correction votes ${v.watch.correction.votes.join(", ") || "—"})`] : []),
  ];
  return fitBody([...rows, ...events], impact, watch, LEGS[leg].md);
}

const bytes = (lines: string[]): number => new TextEncoder().encode(lines.join("\n")).length;
// The surrogate strip: a UTF-16 cut can halve an emoji.
const clip = (line: string): string => (line.length > CLIP_AT && /^ {2}(was|now): /.test(line) ? `${line.slice(0, CLIP_AT).replace(/[\uD800-\uDBFF]$/, "")}…` : line);
/** One entry per change item: an unindented line + its indented detail lines. */
const items = (lines: string[]): string[][] => lines.reduce<string[][]>((g, l) => (l.startsWith("  ") && g.length ? g.at(-1)!.push(l) : g.push([l]), g), []);
const CLIP_AT = 160;
/**
 * Under `NTFY_BODY_MAX` or the phone gets an attachment, not text — degrade in order: Watch → a pointer, was/now clipped
 * to `CLIP_AT`, then whole change items cut from the end; the tranche impact is never dropped.
 * @internal
 */
export function fitBody(change: string[], impact: string[], watch: string[], md: string): string[] {
  const watched = watch.length ? ["Watch:", ...watch] : [];
  const pointer = watch.length ? [`Watch: in ${md}`] : [];
  for (const body of [[...change, ...impact, ...watched], [...change, ...impact, ...pointer], [...change.map(clip), ...impact, ...pointer]]) if (bytes(body) <= NTFY_BODY_MAX) return body;
  const kept = items(change.map(clip));
  const total = kept.length;
  const more = (): string[] => (total > kept.length ? [`… ${total - kept.length} more item${total - kept.length === 1 ? "" : "s"} in ${md}`] : []);
  while (kept.length && bytes([...kept.flat(), ...more(), ...impact]) > NTFY_BODY_MAX) kept.pop();
  return [...kept.flat(), ...more(), ...impact];
}

/** `<leg>:apply`'s stdout cap (SKILL.md step 5) — the final turn caches what it prints (ladder-token-waste). @internal */
export const APPLY_ECHO_MAX = 600;
/** The bytes the head line leaves the push line when the delta does not fit whole. */
const PUSH_ROOM = 80;
const clipBytes = (line: string, room: number): string => {
  if (bytes([line]) <= room) return line;
  let l = line;
  while (l && bytes([`${l}…`]) > room) l = l.slice(0, -1);
  return `${l.replace(/[\uD800-\uDBFF]$/, "")}…`;
};
/** `<leg>:apply`'s stdout: the whole delta + the `push` line within `APPLY_ECHO_MAX` bytes, else the delta's first line + `delta in <md>` + the push line, each clipped to fit. */
export function applyEcho(delta: string[], md: string, push?: string): string[] {
  const tail = push === undefined ? [] : [push];
  if (bytes([...delta, ...tail]) <= APPLY_ECHO_MAX) return [...delta, ...tail];
  // `warn` lines (apply's own fixes to the patch) survive the cut: the md never records them.
  const pointer = [...delta.filter((l) => l.startsWith("warn ")), `delta in ${md}`];
  const short = [clipBytes(delta[0]!, APPLY_ECHO_MAX - bytes(pointer) - 1 - (push === undefined ? 0 : PUSH_ROOM + 1)), ...pointer];
  return push === undefined ? short : [...short, clipBytes(push, APPLY_ECHO_MAX - bytes(short) - 1)];
}

/** A patch `status` that lands something new: set, and differing from the stored event's status once both drop their grade tags (`stripTags`). */
export const restatus = (live: LadderLive, name: string, status: string | undefined): boolean => !!status && !isPreRead(stripTags(status)) && bareStatus(status) !== bareStatus(live.events.find((x) => x.event === name)?.status ?? "");
/** A push title: ntfy's Title is an HTTP header — non-ASCII (an event's en-dash) is rejected, so it's flattened. */
const pushTitle = (leg: LadderLegId, reasons: readonly [string, number][], flips: number): string => `${LEGS[leg].name}: ${reasons.map(([r]) => r).join(", ")}${flips ? "" : ", tranches unchanged"}`.replace(/[^\x20-\x7e]/g, "-");
/** The run's push: flips vs `live.runs[0]` (same-day re-runs dedupe), BLOCK on/off, a lean move, a landed event, a `degradeMixed` cut (`valveCuts`). */
function runAlert(live: LadderLive, next: LadderLive, patch: LadderPatch, leg: LadderLegId, today: string, v: LadderVerdict, blockLines: readonly string[], valveCuts: readonly string[]): NtfyMessage | undefined {
  const reasons: [string, number][] = [];
  for (const kind of [false, true]) {
    const was = glyphs(live.runs[0], kind);
    glyphs(next.runs[0], kind).forEach((g, i) => {
      if (!g || !was[i] || g === was[i]) return;
      // A probe ✓ a hold still blocks is not actionable — say so, one priority down.
      const held = g === "✓" && afterHolds(next, today, (kind ? v.live : v.tranches)[i]!, leg) !== "✓";
      reasons.push([`${kind ? "live " : ""}T${i + 1} ${g === "✓" ? `now OK${held ? " (held)" : ""}` : "lost OK"}`, kind ? 2 : held ? 3 : 4]);
    });
  }
  const flips = reasons.length;
  next.signs.forEach((s, i) => {
    const b = live.signs[i]!;
    const [was, now] = [b.blocked?.reach === "released", s.blocked?.reach === "released"];
    const [tier, pin] = [tierReason(blockLines, s.sign), tierReason(blockLines, s.sign, "pin")];
    if (tier) reasons.push([tier, 3]);
    else if (now && (!was || b.block)) reasons.push([`${s.sign} released (${s.blocked!.by})`, 3]);
    else if (!!s.block !== !!b.block || (s.block && b.blocked?.reach === "T2T3" && !s.blocked?.reach)) reasons.push([`${s.sign} ${s.block ? `BLOCK${s.blocked?.by ? ` (${s.blocked.by})` : ""}` : "unblocked"}`, 4]);
    else if (was && !s.blocked) reasons.push([`${s.sign} cleared`, 3]);
    else if (pin) reasons.push([pin, 3]);
  });
  next.signs.forEach((s, i) => {
    const was = live.signs[i]!.lean;
    // the word decides the move; the title prints the raw lean, its grade tags included. A probe row's move never pushes ([USER 2026-10-18]); a tranche flip it shadows still does.
    if (!s.probe && leanMoved(was, s.lean)) reasons.push([`${s.sign} ${was}->${s.lean}`, 3]);
  });
  for (const [name, e] of Object.entries(patch.events ?? {})) if (restatus(live, name, e.status)) reasons.push([`${name} ${e.status!.split(":")[0]}`, 3]);
  // A valve cut frees a tranche as a block release does — same priority.
  for (const c of valveCuts) reasons.push([c, 3]);
  // Any watch-grade move vs the newest graded run (same-day re-runs dedupe; a watch-less row is skipped): the bare word decides the move, the title prints the raw new grade (` (thin)` kept — a quorum loss must not read as a calm).
  const [wasRaw, nowRaw] = [lastWatch(live), next.runs[0]?.watch];
  if (wasRaw && nowRaw && watchWord(wasRaw) !== watchWord(nowRaw)) reasons.push([`watch ${wasRaw}->${nowRaw}`, 3]);
  if (!reasons.length) return undefined;
  const title = pushTitle(leg, reasons, flips);
  return { title, body: pushBody(live, next, leg, today, v).join("\n"), priority: Math.max(...reasons.map(([, p]) => p)) };
}

/** An events-only patch (`<leg>:apply --events-only`): new deciding events, a named event's `holds` and/or `liftBy`, new sign rows — nothing a run writes. A `liftBy` moves no verdict: `deriveContract` reads it at read; the lift itself waits for a full run to land the fizzle. */
export type LadderEventsPatch = {
  eventsAdd?: NewEvent[];
  events?: Record<string, { holds?: LadderEvent["holds"]; liftBy?: string[] }>;
  signsAdd?: LadderSign[];
};
const SIGN_REQUIRED = ["sign", "label", "lean", "finding", "why", "measurable", "block", "checked", "due", "primary", "search", "seed", "sources"] as const;
const SIGN_ALL: readonly string[] = [...SIGN_REQUIRED, "fails", "cadence", "press"];

/**
 * The events-only patch → the next state (input untouched) + the delta lines. No re-probe, no research demand: `run`/`runAt`/
 * `runs`/`verdict`, every sign label/`due` and every event `status` stay as they are. `signsAdd` lands first so a new event may
 * name a new sign; a new event's `signs` must be `signs[]` rows; `holds` vetted as `vetEvent` does (`LEGS[leg].holds`, none when `secondary`).
 * Its only push: a `degradeMixed` cut (`alert`, at a block release's priority), titled as `runAlert` titles one.
 */
export function applyEvents(live: LadderLive, patch: LadderEventsPatch, leg: LadderLegId, today: string): { next: LadderLive; delta: string[]; alert?: NtfyMessage } {
  const fail = failer(leg);
  vet(fail, "events-only patch", patch, ["eventsAdd", "events", "signsAdd"]);
  for (const k of ["eventsAdd", "signsAdd"] as const) if (patch[k] !== undefined && !Array.isArray(patch[k])) fail(`events-only patch: ${k} is a list`);
  if (patch.events !== undefined && !isObj(patch.events)) fail("events-only patch: events is an object keyed by name");
  const next: LadderLive = structuredClone(live);
  const holdable: readonly string[] = LEGS[leg].holds;
  const delta: string[] = [];
  for (const raw of patch.signsAdd ?? []) {
    if (!isObj(raw)) fail("signsAdd: an entry is not an object");
    const s = dropUncitable(raw, `signsAdd "${raw.sign}"`, (w) => void delta.push(w));
    // a new row's `primary[]` lands in the leg's public JSON too: a non-empty list of `http(s)://` pages (the full apply's ≥ 1-page rule); a vendor-host page
    // drops with a warn line, as a source does; a list the drop would empty is refused
    if (!Array.isArray(s.primary) || !s.primary.length || s.primary.some((u) => typeof u !== "string" || !/^https?:\/\//.test(u))) fail(`signsAdd "${s.sign}": primary is a non-empty list of http(s):// pages`);
    const kept = s.primary.filter((u) => {
      const host = uncitable(u);
      if (host) delta.push(`warn signsAdd "${s.sign}" — primary ${u} dropped: a market-data vendor host (${host}) — cite the publisher's page`);
      return !host;
    });
    if (!kept.length) fail(`signsAdd "${s.sign}": every primary page is on a market-data vendor host — cite the publisher's page`);
    s.primary = kept;
    vet(fail, `signsAdd "${s.sign}"`, s, SIGN_ALL);
    if (SIGN_REQUIRED.some((k) => !(k in s)) || next.signs.some((x) => x.sign === s.sign)) fail(`signsAdd "${s.sign}": needs every required field and a new sign id`);
    vetLean(fail, `signsAdd "${s.sign}"`, s.lean, LEGS[leg].leans, s.measurable.includes(DRAFT_SEP));
    vetSources(fail, `signsAdd "${s.sign}"`, s.sources, today);
    if (s.measurable.includes(DRAFT_SEP)) vetDraft(fail, `signsAdd "${s.sign}"`, measurableParts(s.measurable).draft, LEGS[leg].leans); // a hand-written segment meets the same shape vet as a patch's draft
    // a `blockReach: "graded"` leg's block moves the verdict, which --events-only never re-derives
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- `s` is untyped patch JSON: a missing or non-boolean `block` must fail too
    if (LEGS[leg].blockReach !== "all" && s.block !== false) fail(`signsAdd "${s.sign}": block must be false here — --events-only never re-verdicts; set a block on a full \`${leg}:apply\` run`);
    next.signs.push(s);
    delta.push(`signs    ${s.sign} — new`);
  }
  for (const [name, e] of Object.entries(patch.events ?? {})) {
    vet(fail, `event "${name}"`, e, ["holds", "liftBy"]);
    const row = next.events.find((x) => x.event === name) ?? fail(`event "${name}" ${retiredName(next, name) ? "is retired (eventsDone) — history is read-only" : "not found"}`);
    vetLiftBy(fail, `event "${name}"`, e.liftBy, next, patch.eventsAdd, name);
    if (e.liftBy) { delta.push(`events   ${name} — liftBy [${(row.liftBy ?? []).join(",")}] → [${e.liftBy.join(",")}]`); row.liftBy = [...e.liftBy]; }
    if (e.holds === undefined && e.liftBy) continue;
    const holds = Array.isArray(e.holds) && !e.holds.some((t) => !holdable.includes(t)) && !(row.secondary && e.holds.length) ? e.holds : fail(`event "${name}": holds ${holdable.join("/")} only, none when secondary`);
    if (mixedOwedAt(row, today)) fail(`event "${name}" mixedOwed: a holds write does not answer it — re-land escalation: or fizzle: from a source dated after the landing on a full \`${leg}:apply\` run`);
    delta.push(`events   ${name} — holds [${row.holds.join(",")}] → [${holds.join(",")}]`);
    row.holds = [...holds];
    delete row.heldBefore; // the written holds are the valve's new base
  }
  for (const raw of patch.eventsAdd ?? []) {
    const e = isObj(raw) ? dropUncitable(raw, `eventsAdd "${raw.event}"`, (w) => void delta.push(w)) : raw;
    vetEvent(fail, next, e, holdable, patch.eventsAdd ?? [], today);
    if (/^(escalation|fizzle): /.test(e.status ?? "")) fail(`eventsAdd "${e.event}": a landed escalation:/fizzle: moves blocks — land it on a full \`${leg}:apply\` run`);
    for (const s of e.signs) if (!next.signs.some((x) => x.sign === s)) fail(`eventsAdd "${e.event}": sign "${s}" is not a signs[] row`);
    const added = { ...e, status: addedStatus(e, today, primaryHosts(next)) }; // the next full apply recomputes a pending one anyway
    next.events.push(added);
    delta.push(`events   ${e.event} — new (${e.date}, holds [${e.holds.join(",")}]) → ${added.status}`);
  }
  const valve = degradeMixed(next, today);
  const v = live.verdict;
  const g = glyphs(live.runs[0], false); // no re-probe: the close glyphs are the last run's
  const alert: NtfyMessage | undefined = valve.cuts.length
    ? { title: pushTitle(leg, valve.cuts.map((c) => [c, 3]), 0), body: [...valve.delta, ...(v ? [`Tranches: no change — ${trancheLine(v.tranches, g, g, v.tranches.map((t) => afterHolds(next, today, t, leg)))}`] : [])].join("\n"), priority: 3 }
    : undefined;
  const retired = retireEvents(next, today);
  return { next: retired.next, delta: [...delta, ...valve.delta, ...retired.delta], ...(alert && { alert }) };
}

const retiredName = (live: LadderLive, name: string): boolean => (live.eventsDone ?? []).some((x) => x.event === name);
/** A `fizzle:` / non-holding `escalation:` landed > `RETIRE_DAYS` ago, named by no `blocked.by`, absorbed by every linked non-probe row (checked + newest source ≥ `landedOn`). */
const retirable = (live: LadderLive, e: LadderEvent, today: string): boolean => {
  const o = outcomeOf(e);
  const on = landedOn(e);
  return (o === "fizzle" || (o === "escalation" && !e.holds.length)) && gap(on, today) > RETIRE_DAYS && !live.signs.some((s) => s.blocked?.by === e.event) &&
    live.signs.filter((s) => e.signs.includes(s.sign) && !s.probe).every((s) => s.checked !== null && s.checked >= on && absorbed(s, e));
};
/** An event in its compact `eventsDone` shape. */
function doneOf({ date, event, signs, holds, secondary, status, sources, liftBy, spares }: LadderEvent): LadderEventDone {
  return { date, event, signs, holds, secondary, status, ...(sources && { sources }), ...(liftBy && { liftBy }), ...(spares && { spares }) };
}
/** The `mixedOwed` valve, in place: from `mixedOwedOn` holds → their T3 subset, `STALE_REVIEW_DAYS` later → none, the pre-cut set kept as `heldBefore`;
 *  an `escalation:` re-land restores `heldBefore`, a `fizzle:` drops it. One delta line per step, plus one push reason (`cuts`) per cut step; a same-day re-run moves nothing. */
function degradeMixed(live: LadderLive, today: string): { delta: string[]; cuts: string[] } {
  const delta: string[] = [];
  const cuts: string[] = [];
  const move = (e: LadderEvent, to: LadderEvent["holds"], why: string): void => {
    delta.push(`events   ${e.event} — ${why}: holds [${e.holds.join(",")}] → [${to.join(",")}]`);
    cuts.push(`${e.event} ${why.replace(/ \S+$/, "")}: holds [${e.holds.join(",")}]->[${to.join(",")}]`);
    e.heldBefore ??= [...e.holds];
    e.holds = to;
  };
  for (const e of live.events) {
    if (e.heldBefore !== undefined && outcomeOf(e) !== "mixed") {
      if (outcomeOf(e) === "escalation" && e.heldBefore.join() !== e.holds.join()) {
        delta.push(`events   ${e.event} — escalation re-land: holds [${e.holds.join(",")}] → [${e.heldBefore.join(",")}]`);
        e.holds = e.heldBefore;
      }
      delete e.heldBefore;
      continue;
    }
    if (!mixedOwedAt(e, today)) continue;
    const owed = mixedOwedOn(e);
    if (e.holds.some((t) => t !== "T3")) move(e, e.holds.filter((t) => t === "T3"), `mixed owed ${owed}`);
    if (e.holds.length && today >= addDays(owed, STALE_REVIEW_DAYS)) move(e, [], `mixed unanswered ${addDays(owed, STALE_REVIEW_DAYS)}`);
  }
  return { delta, cuts };
}
/** Moves every `retirable` event from `events` to `eventsDone` in its compact shape; input untouched, one delta line per move. */
function retireEvents(live: LadderLive, today: string): { next: LadderLive; delta: string[] } {
  const moving = live.events.filter((e) => retirable(live, e, today));
  if (!moving.length) return { next: live, delta: [] };
  return {
    next: { ...live, events: live.events.filter((e) => !moving.includes(e)), eventsDone: [...(live.eventsDone ?? []), ...moving.map(doneOf)] },
    delta: moving.map((e) => `events   ${e.event} — retired (${outcomeOf(e)}, ${gap(landedOn(e), today)} d)`),
  };
}

