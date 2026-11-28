import type { LadderEvent, LadderEventDone, LadderLive, LadderMeasuredLift, LadderSign, LadderSource, MeasuredBinding } from "./ladder-live.js";
// @ts-expect-error — public/*.js ships no .d.ts (allowJs is off); re-typed below, as in src/ladder-live.ts.
import { allEvents as allEventsJs, LEAN_GROUPS as LEAN_GROUPS_JS, leanGroup as leanGroupJs, leanWord as leanWordJs, stripTags as stripTagsJs } from "../public/ladder-views.js";

const LEAN_GROUPS = LEAN_GROUPS_JS as readonly (readonly string[])[];
const leanWord = leanWordJs as (lean: string) => string;
const leanGroup = leanGroupJs as (lean: string) => number;
const stripTags = stripTagsJs as (text: string) => string;
const allEvents = allEventsJs as (live: Pick<LadderLive, "events" | "eventsDone">) => LadderEventDone[];

/** `released` = the row holds nothing (`released`) — its fizzle paths in `lifts` clear it; the UNBLOCKING and sourced-lean paths are a holding block's only. `pinned` = a live `blocked.pinned.until` (≥ today). */
export type BlockContract = { on: string; by?: string; cause: string; lifts: { event: string; date: string }[]; unblocking: boolean; sourcedLean: boolean; released: boolean; day: number; demoted?: true; pinned?: string };

/** Settled — never a pending lift: a landed outcome, or a `dropped: <reason>` event (cancelled, so it lifts nothing). */
const SETTLED = /^(escalation|fizzle|mixed|dropped): /;
const UNBLOCKING = /(^|[;:]\s*)UNBLOCKING = /;
const days = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 864e5);

/** ` · called: <row>=<lean>, …` — apply-written on a landed status, before the grade tags; never part of a status compare. */
export const CALLED = / · called: .*$/;
/** An escalation releases a row its `spares` names ([USER 2026-11-13]); every other row it names is blocked. */
const releasesRow = (e: LadderEventDone, sign: string): boolean => e.spares?.includes(sign) === true;
/** A released row — stored (`blocked.reach: "released"`), or read off a legacy `{on, by}` block whose `by` escalation `spares` the row (the next apply persists it, `resolveBlocks`). */
export const isReleased = (s: Pick<LadderSign, "sign" | "block" | "blocked">, events: readonly LadderEventDone[]): boolean =>
  s.blocked?.reach === "released" || (s.block && ((e) => e?.status.startsWith("escalation: ") === true && releasesRow(e, s.sign))(events.find((e) => e.event === s.blocked?.by)));
/** The signs as they hold: a legacy block that reads `released` reads `block: false` — what a probe's box and vetoes take. */
export const heldSigns = <T extends LadderSign>(signs: readonly T[], events: readonly LadderEventDone[]): T[] => signs.map((s) => (s.block && isReleased(s, events) ? { ...s, block: false } : s));

/** A stored block's (or release's) contract, derived at read: `lifts` = unlanded (or landed `mixed:`, still owed) events dated ≥ `on` in the `by` escalation's `liftBy` — or, with no `liftBy` (a manual
 * block, a legacy escalation) or on a release, that name the row: resolveBlocks' lifting fizzle paths (its `causeMatched`, the one membership rule); `sourcedLean` = its sourced-lean path applies (every non-probe holding row);
 * `demoted` = an unrelated fizzle capped the block at T2·T3 (`blocked.reach: "T2T3"`). */
export const deriveContract = (sign: Pick<LadderSign, "sign" | "block" | "blocked" | "measurable" | "probe">, events: readonly LadderEventDone[], today: string): BlockContract | undefined => {
  const rel = isReleased(sign, events);
  if (!sign.blocked || !(sign.block || rel)) return undefined;
  const { on, by } = sign.blocked;
  const liftBy = new Set(events.find((e) => e.event === by)?.liftBy ?? []);
  const lifts = events
    .filter((e) => (!SETTLED.test(e.status) || (e.status.startsWith("mixed: ") && liftBy.has(e.event))) && e.date >= on && (liftBy.has(e.event) || (e.signs.includes(sign.sign) && (rel || !liftBy.size))))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => ({ event: e.event, date: e.date }));
  return { on, ...(by ? { by, cause: by } : { cause: "manual" }), lifts, unblocking: !rel && UNBLOCKING.test(sign.measurable), sourcedLean: !rel && !sign.probe, released: rel, day: days(on, today), ...(sign.blocked.reach === "T2T3" && { demoted: true as const }), ...(!rel && (sign.blocked.pinned?.until ?? "") >= today && { pinned: sign.blocked.pinned!.until }) };
};

const origin = (c: BlockContract): string => `since ${c.on.slice(5)}${c.by ? ` (${c.by})` : ""}`;
export const blockSince = (c: BlockContract, today: string): string => `${origin(c)} · day ${days(c.on, today)}${c.demoted ? " · T2·T3 (demoted)" : ""}${c.pinned ? ` · pinned to ${c.pinned.slice(5)}` : ""}`;
/** A released row's cell / push word: `RELEASED since MM-DD (by)` — it holds nothing, so no day count. */
export const releasedText = (c: BlockContract): string => `RELEASED ${origin(c)}`;
/** A lean that reverses a block: the fizzle group's words but `quiet` (no news is no reversal). */
const LIFT_LEANS = LEAN_GROUPS[2]!.filter((w) => w !== "quiet");
export const liftsLean = (lean: string): boolean => LIFT_LEANS.includes(leanWord(lean));
export const liftsText = (c: BlockContract): string =>
  `lifts on: ${[...c.lifts.map((l) => `${l.event} ${l.date.slice(5)} fizzle`), ...(c.unblocking ? ["UNBLOCKING clause"] : []), ...(c.sourcedLean ? [`a sourced ${LIFT_LEANS.join(" or ")} lean`] : [])].join(" · ") || "none named"}`;
/** The new-block push body's contract: `since MM-DD (by) · lifts on: …` — day 0 at block time goes unsaid. */
export const blockLine = (c: BlockContract): string => `${origin(c)} · ${liftsText(c)}`;

/** A held `VETO_ROWS` block's box reach: T2·T3 once demoted (`cap` = its `blocked.reach`), else every tranche on an `"all"` leg or once its measured half trips, else T2·T3 — the caller passes `LEGS[leg].blockReach`. */
export const reachOf = (measuredTripped: boolean, blockReach: "all" | "graded", cap?: string): "all" | "T2T3" => (cap !== "T2T3" && (blockReach === "all" || measuredTripped) ? "all" : "T2T3");

/** The look-ahead for a block's lift: same literal as planRun's Rung 0 date-check window (not shared — the two may move apart). */
const LIFT_WINDOW_DAYS = 21;
/** A plan's `blockLifts` entry: a blocked row's earliest lift event (`deriveContract`'s first) — passed and still unlanded included. */
export type BlockLift = { sign: string; event: string; date: string };
/** Blocked rows whose earliest lift is dated ≤ today + `LIFT_WINDOW_DAYS`, by date — the lifts a run should watch for. */
export const liftsDue = (signs: readonly LadderSign[], events: readonly LadderEventDone[], today: string): BlockLift[] =>
  signs
    .flatMap((s) => ((l) => (l && days(today, l.date) <= LIFT_WINDOW_DAYS ? [{ sign: s.sign, event: l.event, date: l.date }] : []))(deriveContract(s, events, today)?.lifts[0]))
    .sort((a, b) => a.date.localeCompare(b.date));

/** `measurable`'s clause grammar — `<label> = …` split on `;`; `BLOCKING = …` is the block rule, never a threshold a lean is judged against. */
export const CLAUSE_SPLIT = /\s*;\s*(?=[\w -]{1,20} = )/;
export const CLAUSE = /^([\w -]{1,20}) = /;
export const clauses = (text: string): string[] => text.split(CLAUSE_SPLIT).filter((c) => CLAUSE.test(c));
/** The one apply-written suffix of the user-set `measurable`: the skill's drafted sides land after it (ladder-skill-research-fixes measurableDraft), and the row's lean carries `DRAFT_SUFFIX` until the user promotes them. */
export const DRAFT_SEP = " · draft: ";
export const measurableParts = (m: string): { base: string; draft: string } => {
  const i = m.indexOf(DRAFT_SEP);
  return i < 0 ? { base: m, draft: "" } : { base: m.slice(0, i), draft: m.slice(i + DRAFT_SEP.length) };
};
/** A context row: its user-set `BLOCKING = none …` clause — no escalation or patch blocks it, and a stored block on one is lifted (it would hold nothing). */
export const contextRow = (s: Pick<LadderSign, "measurable">): boolean => clauses(measurableParts(s.measurable).base).some((c) => /^BLOCKING = none\b/i.test(c));
/** Closes a measured lift reads, each strictly under `below` — mirrors the 2-close fold, not imported from domain-fold.ts; 11.4 → 11.6 does not lift. */
export const MEASURED_LIFT_CLOSES = 2;
type Bindings = Readonly<Record<string, MeasuredBinding>>;
const escRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A binding is on while a base clause (`clauses`) of the row's user-set `measurable` is exactly `fizzle = <label> < <below>`, an optional `%` — else clause drift, the binding off. */
export const bindingOn = (b: MeasuredBinding, measurable: string): boolean => clauses(measurableParts(measurable).base).some((c) => new RegExp(`^fizzle = ${escRe(b.label)} < ${escRe(String(b.below))}(?: ?%)?\\s*$`).test(c));
/** The newest close, `since` = the oldest read's date, when the last `MEASURED_LIFT_CLOSES` closes all sit strictly under `below`; fewer closes lift nothing. */
export const measuredLift = <P extends { date: string; value: number }>(b: MeasuredBinding, closes: readonly P[]): (P & { since: string }) | undefined =>
  ((w) => (w.length === MEASURED_LIFT_CLOSES && w.every((p) => p.value < b.below) ? { ...w.at(-1)!, since: w[0]!.date } : undefined))(closes.slice(-MEASURED_LIFT_CLOSES));
/** The one guard on a measured lift — the probe stamps and apply persists only these: a holding, unreleased row, its binding on and on `l`'s series, every close read (`since`) dated ≥ `blocked.on`. */
export const liftTaken = (s: Pick<LadderSign, "block" | "blocked" | "measurable">, l: Pick<LadderMeasuredLift, "series" | "since">, b: MeasuredBinding | undefined): boolean =>
  !!b && s.block && s.blocked?.reach !== "released" && bindingOn(b, s.measurable) && l.series === b.series && l.since >= (s.blocked?.on ?? "");
/** A probe-stamped `verdict.lifts` entry the row takes (`liftTaken`) — the measured lift `resolveBlocks` persists. */
const stampedLift = (s: LadderSign, lifts: readonly LadderMeasuredLift[] | undefined, bindings: Bindings | undefined): LadderMeasuredLift | undefined =>
  lifts?.find((l) => l.sign === s.sign && liftTaken(s, l, bindings?.[s.sign]));
/** A researched row's own reading this run — a `STALE` finding, a `QUIET` listing or `UNSOURCED` is none (SKILL.md: not a sourced reversal). */
export const SOURCED_LABEL = /^(CHANGED|UNCHANGED( \d{2}-\d{2})?)$/;
/** A second vetted `causeFalse` ≥ this after `blocked.causeFalseOn` lifts the block. @internal */
export const NEUTRAL_LIFT_GAP_DAYS = 7;
type CauseFalsePatch = { label: string; lean?: string; sources?: readonly LadderSource[]; causeFalse?: unknown } | undefined;
type SourcedRow = { lean: string; sources: readonly LadderSource[]; blocked?: LadderSign["blocked"]; cadence?: number };
/** The row's newest source dated ≤ `today` is dated > its `blocked.on` — the sourced-lean lift's and `causeFalseRead`'s one evidence test (a future date is no evidence, as `effectiveReach`). */
const sourcedAfterOn = (s: Pick<SourcedRow, "sources" | "blocked">, today: string): boolean => (s.sources.map((x) => x.date).filter((d) => d <= today).sort().at(-1) ?? "") > (s.blocked?.on ?? "");
/** The row's research-window start: `run − max(7, cadence ?? 7)` — a source dated before it is stale (ladder-situation-prose-and-stale-rows R3), a hold notwithstanding. */
export const sourceWindowStart = (s: Pick<LadderSign, "cadence">, run: string): string => new Date(Date.parse(run) - Math.max(7, s.cadence ?? 7) * 864e5).toISOString().slice(0, 10);
/** The sources `applySign` lands on a patched row: patch + stored, dated ≥ `since` (its `sourceWindowStart`) — an emptied window keeps the newest patched source (the STALE finding the label
 *  dates stays citable, ladder-skill-kaizen-critique) — one per URL at its NEWEST date (a re-dated patch beside the held entry; never insertion order, R1), newest first. */
export const postPatchSources = (s: { sources: readonly LadderSource[] }, p: { sources?: readonly LadderSource[] }, since: string): LadderSource[] => {
  const patched = (Array.isArray(p.sources) ? p.sources : []).filter((x) => typeof x?.date === "string");
  const inWindow = [...patched, ...s.sources].filter((x) => x.date >= since);
  const byUrl = new Map<string, LadderSource>();
  for (const x of inWindow.length ? inWindow : [...patched].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 1)) if (!byUrl.has(x.url) || x.date > byUrl.get(x.url)!.date) byUrl.set(x.url, x);
  return [...byUrl.values()].sort((a, b) => b.date.localeCompare(a.date));
};
/** `s` as apply leaves it — a patched row's sources are `postPatchSources` over its `sourceWindowStart` at `today`, an unpatched row's untouched; read before apply lands them, so a vet reads what apply keeps. */
export const withPatchSources = <T extends SourcedRow>(s: T, p: CauseFalsePatch, today: string): T => (p ? { ...s, sources: postPatchSources(s, p, sourceWindowStart(s, today)) } : s);
/** A causeFalse call: the key, a `SOURCED_LABEL`, a neutral-group (`leanGroup` 1) lean. */
const causeFalseCalled = (p: CauseFalsePatch, s: Pick<SourcedRow, "lean">): boolean => p?.causeFalse === true && SOURCED_LABEL.test(p.label) && leanGroup(p.lean ?? s.lean) === 1;
/** A patch row's `causeFalse` read: `causeFalseCalled` + `sourcedAfterOn` over `s`'s post-patch sources (`withPatchSources`). */
const causeFalseRead = (p: CauseFalsePatch, s: SourcedRow, today: string): boolean => causeFalseCalled(p, s) && sourcedAfterOn(s, today);
/** The one causeFalse lift rule — resolveBlocks' lift and `movesVerdict`'s trigger: a holding non-probe block, a `causeFalseRead`, a stamp ≥ `NEUTRAL_LIFT_GAP_DAYS` old. */
export const causeFalseLifts = (s: Pick<LadderSign, "lean" | "sources" | "block" | "blocked" | "probe">, p: CauseFalsePatch, today: string): boolean =>
  !s.probe && s.block && s.blocked?.reach !== "released" && causeFalseRead(p, s, today) && !!s.blocked?.causeFalseOn && days(s.blocked.causeFalseOn, today) >= NEUTRAL_LIFT_GAP_DAYS;
/** When an escalation's evidence dates it: the landed outcome's newest source dated ≤ `today`, else the event's own date — never the run day, so evidence after it and before the run can lift. */
const evidenceDate = (e: LadderEvent, today: string): string => (e.sources ?? []).map((x) => x.date).filter((d) => d <= today).sort().at(-1) ?? e.date;
/** `resolveBlocks`' demotion delta line, `DEMOTED  <sign> — unrelated evidence (<event>; cause <by>) → T2·T3|released`: [1] the sign, [2] the evidence — what runAlert's push reason reads back. */
const DEMOTED_LINE = /^DEMOTED {2}(\S+) — (unrelated evidence \(.+\)) → (?:T2·T3|released)$/;
/**
 * The block lifecycle, every leg alike ([USER 2026-11-09]): `landing` = events whose outcome landed this run. An `escalation:` blocks every non-probe, non-context row it
 * names, stamping `blocked` {on: its `evidenceDate`, by: it} — but a row its `spares` names is released instead (`block: false`,
 * `blocked.reach: "released"`): it holds nothing, due every run; a holding block stays as it is. A legacy block that reads `released` is persisted released first.
 * A lift needs later evidence, cause-matched: a `fizzle:` on an event dated ≥ `on` that is the `by` event itself or in the `by` escalation's `liftBy` — a fizzle merely
 * naming the row lifts only a manual or `liftBy`-less block; a probe's measured lift (`stampedLift` off `next.verdict.lifts`, `bindings` = the leg's `measuredLifts`); the row
 * researched this run (`SOURCED_LABEL`) at a `liftsLean` lean, its newest source dated > `on`; a second vetted `causeFalse` (`causeFalseLifts`; the first stamps `causeFalseOn`); or a context row. A fizzle naming a `liftBy` block's row outside its `liftBy`, with no lift applying, demotes it one tier (`blocked.reach` → `"T2T3"`, a second →
 * `"released"`) — never lifts. A release clears (its `blocked` deleted) on any fizzle naming the row, in `liftBy`, or of the `by` event itself — or as a context row.
 * A same-run escalation beats every lift; a patch `block` key beats a lift or demotion — the stale review excepted, so a re-affirming `block: true` never dodges the breaker.
 * Mutates `next.signs` (every unstamped block or release — set this run, or legacy — gets its `stampContract`; every row then its patch `pin` (`pinBlock`) and, unless an escalation set it this run, its `reviewBlock` — a demotion this run is its review), adds each row whose block moved to `graded`;
 * returns the delta's `RELEASED` / `LIFTED` / `CLEARED` / `DEMOTED` (`DEMOTED_LINE`) / `STALE` / `CAPPED` / `PINNED` / `RE-ARMED` / `PIN-SET` lines, and a `stuckLine` per contract stamped this run.
 */
/** The `by` escalation's `liftBy` of a block (or release) — empty for a manual block or a `liftBy`-less escalation. */
const liftByOf = (live: Pick<LadderLive, "events" | "eventsDone">, s: LadderSign): readonly string[] => (s.blocked?.by && allEvents(live).find((e) => e.event === s.blocked!.by)?.liftBy) || [];
/** Whether an off-cause `mixed:` landing of `f` lifts row `s` — the one rule `resolveBlocks`' off-cause lift and `vetOffCause` both read: a non-probe, non-context row
 * holding a block (or a release), no patch `block` key on it, `f` dated ≥ its `blocked.on` and in its `by` escalation's `liftBy`. */
const offCauseLifts = (live: Pick<LadderLive, "events" | "eventsDone">, patch: { signs: Record<string, { block?: boolean }> }, s: LadderSign, f: Pick<LadderEvent, "event" | "date">): boolean => {
  const p = patch.signs[s.sign];
  return !s.probe && (s.block || s.blocked?.reach === "released") && !contextRow(s) && !(p && "block" in p) && !!s.blocked && f.date >= s.blocked.on && liftByOf(live, s).includes(f.event);
};
export const resolveBlocks = (next: LadderLive, patch: { signs: Record<string, { label: string; lean?: string; block?: boolean; pin?: string; causeFalse?: unknown }> }, landing: readonly LadderEvent[], graded: Set<string>, today: string, bindings?: Bindings): string[] => {
  const escalations = landing.filter((e) => e.status.startsWith("escalation: ")).sort((a, b) => a.date.localeCompare(b.date));
  const on = (s: LadderSign): string => s.blocked?.on ?? "";
  const lines: string[] = [];
  /** Blocks an escalation set this run — never reviewed the run that sets them (a patch `block: true` sets `on` = today, so its review is a no-op: lifts ≥ today, no source after today). */
  const setNow = new Set<string>();
  const releasedLine = (s: LadderSign, e: LadderEventDone): string => `RELEASED ${s.sign} — ${e.event} spares it`;
  const inLiftBy = (s: LadderSign, event: string): boolean => liftByOf(next, s).includes(event);
  /** Cause-matched — `deriveContract`'s lift membership, read live (the stamped `blocked.lifts` is a record, never read here): a manual block, any naming event; the `by`
   * event's own fizzle; else an event in the `by` escalation's `liftBy` — or, a `liftBy`-less escalation, any event naming the row. */
  const causeMatched = (s: LadderSign, f: LadderEvent): boolean =>
    !s.blocked?.by || f.event === s.blocked.by || (liftByOf(next, s).length ? inLiftBy(s, f.event) : f.signs.includes(s.sign));
  for (const s of next.signs) {
    if (s.probe) continue;
    const by = allEvents(next).find((e) => e.event === s.blocked?.by);
    if (s.block && by && isReleased(s, allEvents(next))) {
      [s.block, s.blocked] = [false, { on: s.blocked!.on, by: by.event, reach: "released" }];
      graded.add(s.sign);
      lines.push(releasedLine(s, by));
    }
    const esc = contextRow(s) ? undefined : escalations.filter((e) => e.signs.includes(s.sign)).at(-1);
    if (esc) {
      if (releasesRow(esc, s.sign)) {
        if (s.block || (s.blocked?.reach === "released" && s.blocked.by === esc.event)) continue;
        s.blocked = { on: evidenceDate(esc, today), by: esc.event, reach: "released" };
        lines.push(releasedLine(s, esc));
        continue;
      }
      if (!s.block) graded.add(s.sign);
      [s.block, s.blocked] = [true, { on: evidenceDate(esc, today), by: esc.event }];
      setNow.add(s.sign);
      continue;
    }
    const p = patch.signs[s.sign];
    const rel = s.blocked?.reach === "released";
    if (!(s.block || rel) || (p && "block" in p)) continue;
    const fizzles = landing.filter((f) => f.status.startsWith("fizzle: ") && ((f.date >= on(s) && (f.signs.includes(s.sign) || inLiftBy(s, f.event))) || (rel && f.event === s.blocked!.by)));
    const fizzle = fizzles.find((f) => rel || causeMatched(s, f));
    const offCause = landing.find((f) => f.offCause === true && f.status.startsWith("mixed: ") && offCauseLifts(next, patch, s, f));
    const measured = stampedLift(s, next.verdict?.lifts, bindings);
    const why = contextRow(s) ? "context row — BLOCKING = none"
      : fizzle ? `${fizzle.event} fizzle${fizzle.signs.includes(s.sign) || fizzle.event === s.blocked?.by ? "" : ` (liftBy of ${s.blocked!.by})`}`
      : offCause ? `${offCause.event} mixed (off-cause: ${bareStatus(offCause.status).split(" — unchecked: ")[1]}; liftBy of ${s.blocked!.by})`
      : measured ? `measured: ${measured.series} ${measured.value}`
      : !rel && p && SOURCED_LABEL.test(p.label) && liftsLean(s.lean) && sourcedAfterOn(s, today) ? `lean ${leanWord(s.lean)}`
      : !rel && causeFalseLifts(s, p, today) ? "cause sourced false"
      : undefined;
    if (!rel && s.blocked && !s.blocked.causeFalseOn && causeFalseRead(p, s, today)) s.blocked.causeFalseOn = today;
    const unrelated = why === undefined ? fizzles[0] : undefined;
    if (unrelated) {
      // Ruled: evidence outside the block's lifts demotes one tier — all → T2·T3 → released — never lifts; any lift `why` (a
      // context row, a cause-matched fizzle, a sourced lean) beats it.
      const cap = s.blocked!.reach === "T2T3";
      // A demotion is this run's review, so a same-day probe's read (`reviewedSigns`) agrees with what apply persists.
      [s.block, s.blocked] = [!cap, { ...s.blocked!, reach: cap ? "released" : "T2T3", reviewed: today, reviewBy: addDays(today, STALE_REVIEW_DAYS) }];
      graded.add(s.sign);
      lines.push(`DEMOTED  ${s.sign} — unrelated evidence (${unrelated.event}; cause ${s.blocked.by})${cap ? " → released" : " → T2·T3"}`);
      continue;
    }
    if (why === undefined) continue;
    if (s.block) graded.add(s.sign);
    s.block = false;
    delete s.blocked;
    lines.push(`${rel ? "CLEARED " : "LIFTED  "} ${s.sign} — ${why}`);
  }
  for (const s of next.signs) {
    const since = s.blocked && lastReview(s.blocked);
    if (!s.blocked?.setRun) {
      stampContract(s, allEvents(next), next.run, setNow.has(s.sign) ? today : undefined);
      lines.push(...stuckLine(s, allEvents(next), today, bindings));
    }
    const pinned = pinBlock(s, patch.signs[s.sign]?.pin, today);
    if (since && !setNow.has(s.sign)) lines.push(...reviewBlock(s, allEvents(next), today, graded, since));
    lines.push(...pinned);
    if (s.blocked?.causeFalseOn && (!s.block || leanGroup(s.lean) !== 1)) delete s.blocked.causeFalseOn;
  }
  return lines;
};
/** The review date: a block's earliest dated lift + `REVIEW_GRACE_DAYS`, else its `on` + `REVIEW_FALLBACK_DAYS`. @internal */
export const REVIEW_GRACE_DAYS = 7;
export const REVIEW_FALLBACK_DAYS = 21;
const addDays = (d: string, n: number): string => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
/** Persists a block's (or release's) `deriveContract` as stored fields: `setRun` the stamping run, `lifts` its lift events' names + `UNBLOCKING clause`, `reviewBy` (a demotion's, when one ran first, else `reviewDate` —
 * for a block an escalation set this run, stamped on `floor`, the later of it and `floor` + `STALE_REVIEW_DAYS`, so it is never reviewed sooner than a stale review would re-set it). */
const stampContract = (s: LadderSign, events: readonly LadderEventDone[], run: string, floor?: string): void => {
  const c = deriveContract(s, events, run);
  if (!c) return;
  const [r, min] = [reviewDate(c), floor ? addDays(floor, STALE_REVIEW_DAYS) : ""];
  s.blocked = { ...s.blocked!, setRun: run, cause: c.cause, lifts: [...c.lifts.map((l) => l.event), ...(c.unblocking ? ["UNBLOCKING clause"] : [])], reviewBy: s.blocked!.reviewBy ?? (r < min ? min : r) };
};
const reviewDate = (c: BlockContract): string => ((l) => addDays(l?.date ?? c.on, l ? REVIEW_GRACE_DAYS : REVIEW_FALLBACK_DAYS))(c.lifts[0]);
/** A stuck-prone holding block: its earliest lift (its first dated `lifts` event, else none) falls after its review (`reviewBy`, else `reviewDate`) — never a row whose measured binding is on (daily-observable). */
const stuckLine = (s: LadderSign, events: readonly LadderEventDone[], today: string, bindings?: Bindings): string[] => {
  const c = s.block && !s.probe ? deriveContract(s, events, today) : undefined;
  if (!c || c.released || ((b) => b && bindingOn(b, s.measurable))(bindings?.[s.sign])) return [];
  const [lift, review] = [c.lifts[0]?.date, s.blocked!.reviewBy ?? reviewDate(c)];
  return lift && lift <= review ? [] : [`stuck-prone: ${s.sign} — earliest lift ${lift ? lift.slice(5) : "none"} > review ${review.slice(5)}`];
};
/** A stale review's new `reviewBy` = today + this ([USER 2026-11-13]) — never `REVIEW_GRACE_DAYS`. */
export const STALE_REVIEW_DAYS = 11;
type Reach = "all" | "T2T3" | "released";
const reachNow = (c: BlockContract): Reach => (c.released ? "released" : c.demoted ? "T2T3" : "all");
const TIER_DOWN = { all: "T2T3", T2T3: "released", released: "released" } as const;
/** Consecutive stale reviews (`blocked.staleReviews`) that release a block outright — a live pin holds it ([USER 2026-11-13]). @internal */
export const STALE_REVIEW_CAP = 2;
/** A patch `pin` date is ≤ today + this ([USER 2026-11-13]). @internal */
export const PIN_MAX_DAYS = 21;
/** The day a block was last reviewed — a source dated after it is fresh. Apply reads it after this run's lift / demotion mutations and before its stamp; the pin vet and a probe read the row as stored. */
const lastReview = (b: NonNullable<LadderSign["blocked"]>): string => b.reviewed ?? b.setRun ?? b.on;
/** A block's reach at `today` (`effectiveReach`): a non-probe holding block with a `reviewBy` re-arms to `all` on a `SOURCED_LABEL` escalation-group (`leanGroup` 0) row whose newest
 * source ≤ today is dated after `since` (`lastReview`, `staleReviews` → 0), else past `reviewBy` counts a stale review: a live pin holds the reach (`pinned`), the `STALE_REVIEW_CAP`-th releases it (`capped`), else one tier down (`stale`); each sets `reviewBy` = today + `STALE_REVIEW_DAYS`. Apply persists it (`reviewBlock`), a probe reads it (`reviewedSigns`). */
const effectiveReach = (c: BlockContract, s: Pick<LadderSign, "label" | "lean" | "sources" | "blocked" | "probe">, today: string, since: string): { reach: Reach; reviewBy?: string; move?: "stale" | "capped" | "pinned" | "rearm"; staleReviews?: number } => {
  const [reach, b] = [reachNow(c), s.blocked];
  if (c.released || s.probe || !b?.reviewBy) return { reach };
  const newest = s.sources.map((x) => x.date).filter((d) => d <= today).sort().at(-1) ?? "";
  const reviewBy = addDays(today, STALE_REVIEW_DAYS);
  if (SOURCED_LABEL.test(s.label) && leanGroup(s.lean) === 0 && newest > since) return { reach: "all", reviewBy, move: "rearm", staleReviews: 0 };
  if (today <= b.reviewBy) return { reach };
  const n = (b.staleReviews ?? 0) + 1;
  if (c.pinned) return { reach, reviewBy, move: "pinned", staleReviews: n };
  return n >= STALE_REVIEW_CAP ? { reach: "released", reviewBy, move: "capped", staleReviews: n } : { reach: TIER_DOWN[reach], reviewBy, move: "stale", staleReviews: n };
};
const TIER_WORD = { all: "all", T2T3: "T2·T3", released: "released" } as const;
/** Persists `effectiveReach` on one row; a reach move adds it to `graded` and returns its `STALE` / `CAPPED` / `RE-ARMED` delta line, a pinned hold its `PINNED` line (a clock-only re-arm returns none). */
const reviewBlock = (s: LadderSign, events: readonly LadderEventDone[], today: string, graded: Set<string>, since: string): string[] => {
  const c = deriveContract(s, events, today);
  const r = c && effectiveReach(c, s, today, since);
  if (!c || !r?.move) return [];
  const was = s.blocked!.reviewBy!;
  s.blocked = { ...s.blocked!, reviewBy: r.reviewBy!, reviewed: today, staleReviews: r.staleReviews! };
  // A stale review (pinned or capped too) drops `rewritten`: an answer stamped this same run predates it, so the row owes the next run (`owedRows`).
  if (r.move !== "rearm") delete s.blocked.rewritten;
  if (!r.staleReviews) delete s.blocked.staleReviews;
  if (r.reach === "all") delete s.blocked.reach;
  else s.blocked.reach = r.reach;
  s.block = r.reach !== "released";
  if (r.move === "pinned") return [`PINNED   ${s.sign} — review ${was.slice(5)} passed, held to ${c.pinned!.slice(5)}`];
  if (r.reach === reachNow(c)) return [];
  graded.add(s.sign);
  return [r.move === "stale" ? `STALE    ${s.sign} — review ${was.slice(5)} passed, no fresh source → ${TIER_WORD[r.reach]}`
    : r.move === "capped" ? `CAPPED   ${s.sign} — ${r.staleReviews!} stale reviews → released` : `RE-ARMED ${s.sign} — a fresh sourced escalation source → all`];
};
/** Stamps a vetted patch `pin` (`vetBlockSet`) on a still-holding block as `blocked.pinned`, returning its `PIN-SET` delta line; drops an expired one. */
const pinBlock = (s: LadderSign, pin: string | undefined, today: string): string[] => {
  if (s.blocked?.pinned && s.blocked.pinned.until < today) delete s.blocked.pinned;
  if (pin === undefined || !s.block || !s.blocked) return [];
  s.blocked.pinned = { until: pin };
  return [`PIN-SET  ${s.sign} — pinned to ${pin.slice(5)}`];
};
/** The signs as a probe reads them at `today`: each block at its `effectiveReach` (`T2T3` → `blocked.reach`, `released` → `block: false`), an unstamped one
 * `stampContract`ed first on a clone, as apply does (`reviewMoves`) — read only, never persisted. */
export const reviewedSigns = <T extends LadderSign>(signs: readonly T[], events: readonly LadderEventDone[], today: string): T[] =>
  signs.map((s) => {
    const t = s.block && s.blocked ? structuredClone(s) : undefined;
    if (t && !t.blocked?.setRun) stampContract(t, events, today);
    const c = t && deriveContract(t, events, today);
    const r = c && effectiveReach(c, t, today, lastReview(s.blocked!));
    if (!r?.move) return s;
    const { reach: _, ...rest } = s.blocked!;
    return { ...s, block: r.reach !== "released", blocked: r.reach === "all" ? rest : { ...rest, reach: r.reach } };
  });
/** Whether apply's review moves a row's reach (`stampContract` first on an unstamped block, as `resolveBlocks` does) — `movesVerdict`'s stale / cap-release / re-arm trigger; a pinned hold moves none. */
export const reviewMoves = (s: LadderSign, events: readonly LadderEventDone[], today: string): boolean => {
  const t = structuredClone(s);
  const since = t.blocked && lastReview(t.blocked);
  if (!t.blocked?.setRun) stampContract(t, events, today);
  const c = deriveContract(t, events, today);
  return !!c && !!since && effectiveReach(c, t, today, since).reach !== reachNow(c);
};
const [STALE_LINE, CAPPED_LINE, PIN_LINE, REARMED_LINE] = [/^STALE {4}(\S+) — .* → (\S+)$/, /^CAPPED {3}(\S+) — (\d+) /, /^(?:PINNED {3}|PIN-SET {2})(\S+) — .*(?:held|pinned) to (\S+)$/, /^RE-ARMED (\S+) — /];
/** runAlert's push reason for a row whose reach `resolveBlocks` moved: `<sign> demoted — <evidence>` (`DEMOTED_LINE`), `BLOCK stale: <sign> → T2·T3|released`, `BLOCK released: <sign> — <n> stale reviews`, `BLOCK re-armed: <sign>`;
 * `kind: "pin"` — a pin held or set (`PINNED` / `PIN-SET`) on a row no reach line moved: `BLOCK pinned: <sign> to MM-DD`. */
export const tierReason = (lines: readonly string[], sign: string, kind: "reach" | "pin" = "reach"): string | undefined => {
  const reach = lines.map((l) => {
    const [d, st, c] = [DEMOTED_LINE.exec(l), STALE_LINE.exec(l), CAPPED_LINE.exec(l)];
    if (d?.[1] === sign) return `${sign} demoted — ${d[2]!}`;
    if (st?.[1] === sign) return `BLOCK stale: ${sign} → ${st[2]!}`;
    if (c?.[1] === sign) return `BLOCK released: ${sign} — ${c[2]!} stale reviews`;
    return REARMED_LINE.exec(l)?.[1] === sign ? `BLOCK re-armed: ${sign}` : undefined;
  }).find(Boolean);
  if (kind === "reach" || reach) return kind === "reach" ? reach : undefined;
  const p = lines.map((l) => PIN_LINE.exec(l)).find((m) => m?.[1] === sign);
  return p ? `BLOCK pinned: ${sign} to ${p[2]!}` : undefined;
};
/** A plan's `stuckProne`: every `stuckLine` this run. */
export const stuckProne = (signs: readonly LadderSign[], events: readonly LadderEventDone[], today: string, bindings?: Bindings): string[] => signs.flatMap((s) => stuckLine(s, events, today, bindings));
/** A holding block owing its contract rewrite: stale-demoted (`staleReviews`) or stuck-prone (`stuckLine`), as `[sign, why]` — none once an answer (`blocked.rewritten`) dates on/after its last review. */
const owedRows = (signs: readonly LadderSign[], events: readonly LadderEventDone[], today: string, bindings?: Bindings): [LadderSign, string][] =>
  signs.flatMap((s) => {
    if (!s.block || s.probe || !s.blocked || (s.blocked.rewritten ?? "") >= lastReview(s.blocked)) return [];
    const n = s.blocked.staleReviews;
    const why = [...(n ? [`${n} stale review${n > 1 ? "s" : ""}`] : []), ...stuckLine(s, events, today, bindings).map((l) => l.replace(/^stuck-prone: \S+ — /, ""))];
    return why.length ? [[s, why.join(" · ")] as [LadderSign, string]] : [];
  });
/** A plan's `contractOwed`: `<sign> — <n> stale review(s) · earliest lift … > review …`. */
export const contractOwed = (signs: readonly LadderSign[], events: readonly LadderEventDone[], today: string, bindings?: Bindings): string[] => owedRows(signs, events, today, bindings).map(([s, why]) => `${s.sign} — ${why}`);
/** The patch fields `vetBlockSet` and `vetContractOwed` read — structural, so ladder-run's `LadderPatch` passes as is; event entries stay `unknown` (their own vet reports a non-object). */
type BlockSetPatch = { signs: Record<string, { label: string; lean?: string; sources?: readonly LadderSource[]; block?: boolean; unblocking?: string; pin?: string; causeFalse?: unknown }>; events?: Record<string, unknown>; eventsAdd?: readonly unknown[] };
const isObj = (o: unknown): o is Record<string, unknown> => typeof o === "object" && o !== null;
/** A patch row's fresh sourced escalation-group source — a `SOURCED_LABEL`, a `leanGroup` 0 lean, a patch source dated in (`lastReview`, today]: the pin vet's and a `contractOwed` answer's one test. */
const freshSourced = (p: BlockSetPatch["signs"][string], s: LadderSign, today: string): boolean =>
  ((since) => SOURCED_LABEL.test(p.label) && leanGroup(p.lean ?? s.lean) === 0 && (p.sources ?? []).some((x) => x.date > since && x.date <= today))(lastReview(s.blocked!));
/** Whether the patch gives the row's contract a lift event it lacked (`liftBy` on its `by` event, or an `eventsAdd`), dated today … its review as stored — `reviewBy`, else the
 * UNPATCHED contract's `reviewDate`, so a far lift never sets its own bound (a past review → today + `STALE_REVIEW_DAYS`). */
const newLift = (live: LadderLive, patch: BlockSetPatch, s: LadderSign, today: string): boolean => {
  const liftBy = (e: LadderEventDone): unknown => ((p) => (isObj(p) ? p.liftBy : undefined))(patch.events?.[e.event]);
  const adds = (patch.eventsAdd ?? []).filter((e): e is LadderEventDone => isObj(e) && typeof e.event === "string" && typeof e.date === "string" && Array.isArray(e.signs));
  const patched = [...allEvents(live).map((e) => ((l) => (Array.isArray(l) && l.every((x) => typeof x === "string") ? { ...e, liftBy: l } : e))(liftBy(e))), ...adds.map((e) => ({ ...e, status: typeof e.status === "string" ? e.status : "" }))];
  const before = new Set(deriveContract(s, allEvents(live), today)?.lifts.map((l) => l.event));
  const review = answerBound(live, s, today);
  return !!deriveContract(s, patched, today)?.lifts.some((l) => !before.has(l.event) && l.date >= today && l.date <= review);
};
/** A `contractOwed` answer's last lift day — `newLift`'s and `causeFalse`'s one bound (see `newLift`). */
const answerBound = (live: LadderLive, s: LadderSign, today: string): string =>
  ((stored) => ((r) => (r >= today ? r : addDays(today, STALE_REVIEW_DAYS)))(s.blocked!.reviewBy ?? (stored ? reviewDate(stored) : today)))(deriveContract(s, allEvents(live), today));
/** The body of the base's `UNBLOCKING = …` clause (`clauses`), trimmed — undefined when it carries none. */
const unblockingOf = (m: string): string | undefined => clauses(measurableParts(m).base).find((c) => /^UNBLOCKING = /.test(c))?.replace(/^UNBLOCKING = /, "").trim();
const norm = (t: string): string => t.trim().replace(/\s+/g, " ").toLowerCase();
/** Notes each `contractOwed` row the patch leaves unanswered — ONE of `freshSourced`, `newLift`, an `unblocking` body that differs (whitespace / case aside) from the row's own
 * UNBLOCKING clause (`withUnblocking` replaces it) — and a repeat of that clause; returns the answered signs (`stampRewritten`). */
export const vetContractOwed = (note: (msg: string) => void, live: LadderLive, patch: BlockSetPatch, today: string, bindings?: Bindings): string[] => {
  const answered: string[] = [];
  for (const [s] of owedRows(live.signs, allEvents(live), today, bindings)) {
    const p = patch.signs[s.sign];
    const un = isObj(p) && typeof p.unblocking === "string" ? norm(p.unblocking) : "";
    const rewrite = !!un && un !== norm(unblockingOf(s.measurable) ?? "");
    if (un && !rewrite) note(`${s.sign}: unblocking repeats the row's UNBLOCKING clause — a contractOwed rewrite changes it`);
    const causeFalse = isObj(p) && causeFalseRead(p, withPatchSources(s, p, today), today) && addDays(s.blocked!.causeFalseOn ?? today, NEUTRAL_LIFT_GAP_DAYS) <= answerBound(live, s, today);
    if ((isObj(p) && freshSourced(p, s, today)) || rewrite || newLift(live, patch, s, today) || causeFalse) answered.push(s.sign);
    else note(`${s.sign}: contractOwed unanswered — send a fresh sourced escalation-group source, a new lift dated ${today} … its review (events.<by>.liftBy, or an eventsAdd naming a manual / liftBy-less block's row), unblocking: "<a new UNBLOCKING clause body>", or causeFalse: true while its lift (+${NEUTRAL_LIFT_GAP_DAYS} d) falls by the review`);
  }
  return answered;
};
/** Stamps `blocked.rewritten` = today on each answered row still holding a block — call before `resolveBlocks`, so a same-run escalation's new block or stale review drops it. */
export const stampRewritten = (signs: readonly LadderSign[], answered: readonly string[], today: string): void => {
  for (const s of signs) if (s.block && s.blocked && answered.includes(s.sign)) s.blocked.rewritten = today;
};
/** A status with its tags and ` · called: …` segment stripped — the one test of a landing (a bare status new to its event), shared with ladder-run. */
export const bareStatus = (status: string): string => stripTags(status).replace(CALLED, "");
/** A block set by this patch names its lift: an `escalation:` landing (its bare status new to the event), blocking ≥ 1 non-probe, non-context, unspared row, carries a `liftBy` (patched or stored);
 * a patch `block: true` on an unblocked row needs an UNBLOCKING clause — stored, or `unblocking` (one clause body, landed by `withUnblocking`; only a `contractOwed` row may send one over a stored clause);
 * a `pin` rides a holding block, dated in (today, today + `PIN_MAX_DAYS`], with a fresh `SOURCED_LABEL` escalation-group source in the same patch. */
export const vetBlockSet = (note: (msg: string) => void, live: LadderLive, patch: BlockSetPatch, today: string, bindings?: Bindings): void => {
  const owed = new Set(owedRows(live.signs, allEvents(live), today, bindings).map(([s]) => s.sign));
  const escalating = (name: unknown, e: { status?: unknown; liftBy?: unknown; spares?: unknown; signs?: unknown }, was?: LadderEvent): void => {
    const [signs, spares] = [was?.signs ?? e.signs, e.spares ?? was?.spares];
    if (typeof e.status !== "string" || !e.status.startsWith("escalation: ") || (was && bareStatus(was.status) === bareStatus(e.status)) || (e.liftBy ?? was?.liftBy) !== undefined || !Array.isArray(signs)) return;
    const blocks = live.signs.filter((s) => signs.includes(s.sign) && !s.probe && !contextRow(s) && !(Array.isArray(spares) && spares.includes(s.sign))).map((s) => s.sign);
    if (blocks.length) note(`${String(name)}: an escalation that blocks ${blocks.join(", ")} needs liftBy — the events whose fizzle lifts it`);
  };
  for (const e of patch.eventsAdd ?? []) if (isObj(e)) escalating(e.event, e);
  for (const [name, e] of Object.entries(patch.events ?? {})) ((was) => was && isObj(e) && escalating(name, e, was))(live.events.find((x) => x.event === name));
  for (const [sign, p] of Object.entries(patch.signs)) {
    const s = live.signs.find((x) => x.sign === sign);
    if (!s) continue;
    const has = UNBLOCKING.test(s.measurable);
    if (p.unblocking !== undefined && (typeof p.unblocking !== "string" || !p.unblocking.trim() || / = |;/.test(p.unblocking))) note(`${sign}: unblocking is one clause body — no " = " or ";"`);
    else if (p.unblocking !== undefined && has && !owed.has(sign)) note(`${sign}: unblocking on a row whose measurable already carries an UNBLOCKING clause`);
    if (p.block === true && !s.block && !has && p.unblocking === undefined) note(`${sign}: block: true needs an UNBLOCKING = … clause — add unblocking: "<clause>"`);
    if (p.causeFalse !== undefined && p.causeFalse !== true) note(`${sign}: causeFalse is \`true\` or absent`);
    else if (p.causeFalse === true && (!s.block || !s.blocked || s.probe || isReleased(s, allEvents(live)))) note(`${sign}: causeFalse rides a holding block`);
    else if (p.causeFalse === true && !causeFalseCalled(p, s)) note(`${sign}: causeFalse needs a SOURCED label and a neutral-group lean (${LEAN_GROUPS[1]!.join(" / ")})`);
    else if (p.causeFalse === true && !sourcedAfterOn(withPatchSources(s, p, today), today)) note(`${sign}: causeFalse needs a source dated after ${s.blocked!.on}`);
    if (p.causeFalse !== undefined && "block" in p) note(`${sign}: causeFalse with a block key`);
    if (p.pin === undefined) continue;
    if (!s.block || !s.blocked || s.probe || isReleased(s, allEvents(live))) {
      note(`${sign}: pin rides a holding block`);
      continue;
    }
    if (typeof p.pin !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.pin) || p.pin <= today || p.pin > addDays(today, PIN_MAX_DAYS)) note(`${sign}: pin is a YYYY-MM-DD date after today, ≤ today + ${PIN_MAX_DAYS} d`);
    if (!freshSourced(p, s, today)) note(`${sign}: pin needs a fresh sourced escalation-group source in this patch — a SOURCED label, an escalation-group lean, a source dated after ${lastReview(s.blocked)}`);
  }
};
/** `measurable` with its base's `UNBLOCKING = …` clause replaced in place by `clause` (a `contractOwed` rewrite), else `; UNBLOCKING = <clause>` appended — a draft segment stays after it. */
export const withUnblocking = (m: string, clause: string): string => {
  const { base, draft } = measurableParts(m);
  const parts = base.split(new RegExp(`(${CLAUSE_SPLIT.source})`));
  const i = parts.findIndex((c) => /^UNBLOCKING = /.test(c));
  return `${i < 0 ? `${base}; UNBLOCKING = ${clause}` : parts.map((c, j) => (j === i ? `UNBLOCKING = ${clause}` : c)).join("")}${draft ? `${DRAFT_SEP}${draft}` : ""}`;
};
/** `liftBy`: the names of events (stored, or added this run) whose `fizzle:` lifts the blocks this event's escalation sets — none may name the event itself. */
export const vetLiftBy = (fail: (msg: string) => never, where: string, v: unknown, live: LadderLive, adds: readonly Pick<LadderEvent, "event">[] | undefined, self?: string): void => {
  if (v === undefined) return;
  if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string")) fail(`${where}: liftBy is a non-empty list of event names`);
  const known = new Set([...allEvents(live).map((e) => e.event), ...(adds ?? []).map((e) => e.event)]);
  const bad = (v as string[]).filter((x) => !known.has(x) || x === self);
  if (bad.length) fail(`${where}: liftBy names ${bad.map((x) => `"${x}"`).join(", ")} — not another known event`);
};
/** `offCause: true` rides a new `mixed:` status (`status` = the patch's, `stored` = the row's before this run) of an event that `offCauseLifts` some held block — every
 * such block of one `blocked.by` cause (off-cause-ness is per block, the flag per event). Read off `live` after every event patch applied, so a same-patch `liftBy` counts. */
export const vetOffCause = (fail: (msg: string) => never, where: string, v: unknown, status: string | undefined, stored: string | undefined, f: Pick<LadderEvent, "event" | "date">, live: LadderLive, patch: { signs: Record<string, { block?: boolean }> }): void => {
  if (v === undefined) return;
  if (v !== true) fail(`${where}: offCause is \`true\` or absent`);
  if (!status?.startsWith("mixed: ")) fail(`${where}: offCause rides a mixed: status — this patch sends ${status === undefined ? "no status" : `"${status.split(":")[0]}:"`}`);
  if (stored !== undefined && bareStatus(status) === bareStatus(stored)) fail(`${where}: offCause rides a new status — this mixed: one is already stored`);
  const causes = [...new Set(live.signs.filter((s) => offCauseLifts(live, patch, s, f)).map((s) => s.blocked!.by))];
  if (!causes.length) fail(`${where}: offCause lifts no block — no held, non-probe, non-context row blocked on or before ${f.date} without a patch \`block\` key has it in its \`by\` escalation's liftBy`);
  if (causes.length > 1) fail(`${where}: offCause is per event but off-cause is per block — it would lift blocks of ${causes.length} causes (${causes.join(", ")})`);
};
/** `spares` rides an `escalation:` status and names only signs its event lists. */
export const vetSpares = (fail: (msg: string) => never, where: string, v: unknown, signs: readonly string[], status: string | undefined): void => {
  if (v === undefined) return;
  if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string")) fail(`${where}: spares is a non-empty list of sign names`);
  if (!status?.startsWith("escalation: ")) fail(`${where}: spares rides an escalation: status`);
  const bad = (v as string[]).filter((x) => !signs.includes(x));
  if (bad.length) fail(`${where}: spares names ${bad.map((x) => `"${x}"`).join(", ")} — not a sign the event lists`);
};
/** The body of `measurable`'s first clause (base, then draft) whose label matches `side`; a `none …` body (a context row's BLOCKING) is no side. */
export const sideClause = (m: string, side: RegExp): string | undefined => {
  const { base, draft } = measurableParts(m);
  for (const c of [...clauses(base), ...clauses(draft)]) {
    const [head, label] = CLAUSE.exec(c)!;
    const body = c.slice(head.length).trim();
    if (side.test(label!.trim()) && !/^none\b/i.test(body)) return body;
  }
  return undefined;
};
