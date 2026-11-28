/**
 * Per-leg live re-entry state — the schema of `LEGS[leg].json` (the one primary artifact per leg; `LEGS[leg].md` is
 * rendered from it, the `/lab` Re-entry block reads the EU-Fin one). Zero IO: the leg's probe writes `verdict` via
 * `--into`; every other per-run field is written by `applyRun` (`src/ladder-run.ts`) from the skill run's patch
 * (never `rules`). Parametrized by leg; the `Eufin*` names are
 * aliases kept for the EU-Fin importers.
 */

import { DEFAULT_LADDER_TZ } from "./config.js";
import type { Box, Cell, ClusterRead } from "./ladder-box.js";
import { blockSince, deriveContract, liftsText, releasedText, sourceWindowStart } from "./ladder-block.js";
import { scrubLicensedLevelsInLeg } from "./licensed-levels.js";
// @ts-expect-error — public/*.js ships no .d.ts (allowJs is off); resolves fine at runtime. Each binding is re-typed
// at its `*Js` → typed const below (the src/lab-request.ts → lab-lookback.js precedent).
import { allEvents as allEventsJs, blockers as blockersJs, countdown as countdownJs, conditionsOwed as conditionsOwedJs, foldLanded as foldLandedJs, foldDates as foldDatesJs, holdingEvent as holdingEventJs, holdingNow as holdingNowJs, landedOn as landedOnJs, landedWord as landedWordJs, decidingWeek as decidingWeekJs, DECIDING_DAYS as DECIDING_DAYS_JS, otherWeek as otherWeekJs, blockersSummary as blockersSummaryJs, HELD_NOTE as HELD_NOTE_JS, boardFamilies as boardFamiliesJs, boardRows as boardRowsJs, boardReading as boardReadingJs, boardText as boardTextJs, BOX_INDICATOR as BOX_INDICATOR_JS, boxHoldsText as boxHoldsTextJs, clusterBoxText as clusterBoxTextJs, clusterHead as clusterHeadJs, clusterRows as clusterRowsJs, foldText as foldTextJs, gridRows as gridRowsJs, JOB_LEGEND as JOB_LEGEND_JS, jobText as jobTextJs, labelAged as labelAgedJs, LEAN_GLYPH as LEAN_GLYPH_JS, leanGroup as leanGroupJs, leanWord as leanWordJs, seriesNote as seriesNoteJs, signsCell as signsCellJs, SITUATION_SLOTS as SITUATION_SLOTS_JS, shownStatus as shownStatusJs, stripTags as stripTagsJs, WATCH_CONTEXT_NOTE as WATCH_CONTEXT_NOTE_JS, watchContextRows as watchContextRowsJs, watchTable as watchTableJs, watchGrade as watchGradeJs, watchHead as watchHeadJs, watchRows as watchRowsJs } from "../public/ladder-views.js";

/**
 * The legs the ladder pipeline serves: the state file, its rendered md, the md title, the run's head word, the writer skill, the
 * verdict probe, `holds` = the tranches a deciding event may delay (EU-Fin's first was filled before the ladder went live; Value's T2/T3 also auto-follow the fill before them)
 * and `blockReach` = how far a `block: true` sign holds (graded reach): `"all"` = the kernel holds every ✓ tranche (`afterHolds`, ladder-run.ts);
 * `"graded"` = the probe's box holds it — a `VETO_ROWS` block holds T2·T3 alone, every tranche once its measured half trips or the box votes; any other row's block shows on its family row only.
 * `naGateHolds` = the probe's `tally` convention for a `na` gate: Value/Semis/S&P IT take `clear` over every gate (a na gate holds the tranche);
 * EU-Fin's filters `verdict !== "na"` first (a na gate holds nothing) — read by the Blockers view (`blockers`, public/ladder-views.js), mirrored in `REENTRY_LEGS`.
 */
/** Each leg's `lean` vocabulary — `applySign`/`signsAdd` vet against it; `unknown` may carry ` until YYYY-MM-DD` (bare `unknown` stays valid, [USER 2026-10-16]). Board groups: `LEAN_GROUPS` (public/ladder-views.js). */
const EUFIN_LEANS = ["escalation-leaning", "open", "mixed", "fizzle-leaning", "quiet", "unknown"] as const;
const US_LEANS = ["bear", "neutral", "fizzle", "unknown"] as const;
export const LEGS = {
  eufin: { json: "public/eufin.json", md: "docs/eufin.md", title: "EU-Fin live state", name: "EU-Fin", skill: "/eufin", probe: "probe:eufin-tranches", holds: ["T2", "T3"], blockReach: "all", naGateHolds: false, leans: EUFIN_LEANS },
  value: { json: "public/value.json", md: "docs/value.md", title: "Value live state", name: "Value", skill: "/value", probe: "probe:value-tranches", holds: ["T1", "T2", "T3"], blockReach: "graded", naGateHolds: true, leans: US_LEANS, measuredLifts: { credit: { series: "BAMLH0A3HYC", label: "CCC", below: 11.5 } } },
  semis: { json: "public/semis.json", md: "docs/semis.md", title: "Semis live state", name: "Semis", skill: "/semis", probe: "probe:semis-tranches", holds: ["T1", "T2", "T3"], blockReach: "graded", naGateHolds: true, leans: US_LEANS },
  spit: { json: "public/spit.json", md: "docs/spit.md", title: "S&P IT live state", name: "S&P IT", skill: "/spit", probe: "probe:spit-tranches", holds: ["T2", "T3"], blockReach: "graded", naGateHolds: true, leans: US_LEANS },
  sp500: { json: "public/sp500.json", md: "docs/sp500.md", title: "S&P 500 live state", name: "S&P 500", skill: "/sp500", probe: "probe:sp500-tranches", holds: ["T2", "T3"], blockReach: "graded", naGateHolds: true, leans: US_LEANS },
} as const;
export type LadderLegId = keyof typeof LEGS;
/** A measured lift's binding (`LEGS[leg].measuredLifts`, keyed by sign): FRED `series` closes under `below`; on only while the sign's `measurable` reads `fizzle = <label> < <below>`. */
export type MeasuredBinding = { series: string; label: string; below: number };
type MeasuredLifts = Readonly<Record<string, MeasuredBinding>>;
export const measuredLiftsOf = (leg: LadderLegId): MeasuredLifts | undefined => (LEGS[leg] as { measuredLifts?: MeasuredLifts }).measuredLifts;
/** A probe-stamped measured lift (`verdict.lifts`): `value` = the newest close, dated `date`, `since` = the oldest close read; the next apply persists it (`resolveBlocks`). */
export type LadderMeasuredLift = { sign: string; series: string; value: number; date: string; since: string };
/** `--leg=<id>` off a CLI argv, `eufin` when absent; an unknown id throws (`<cmd>` = the failing script's npm name for the message). */
export function legOf(argv: readonly string[], cmd = "ladder"): LadderLegId {
  const leg = argv.find((a) => a.startsWith("--leg="))?.slice(6) ?? "eufin";
  if (!(leg in LEGS)) throw new Error(`${cmd} — unknown --leg "${leg}" (one of ${Object.keys(LEGS).join(", ")})`);
  return leg as LadderLegId;
}

/** The re-entry tranche names; the ruling-ID lint (`scripts/check-ruling-ids.ts`) exempts them. */
export const TRANCHE_IDS = ["T1", "T2", "T3"] as const;
export type TrancheId = (typeof TRANCHE_IDS)[number];
type Mark = "met" | "unmet" | "na";
/** Why a tranche is ✓ with its own count short: an exit time stop, or AFTER_N closes after the prior fill (eufin/value/spit);
 * semis: `after T1` = the fizzle fast fill, `new high` = catch-up on a CATCHUP_HIGH_N-close SEC0 high, gates clear. */
export type Via = "time stop" | "after T1" | "after T2" | "new high";
/** `filledSince` = the follow path's anchor (`followOf`/`firesAt`) — data only, never rendered. */
export type LadderTranche = { id: TrancheId; met: number; total: number; need: number; ok: boolean; ready: boolean; via?: Via; gates?: Mark[]; filledSince: string | null };
export type LadderSource = { date: string; url: string };
/**
 * `lean` = the one-word judgment; `finding` = the dated fact behind it; `checked`/`due` = the row's research cadence (`cadence` = days to the next due, default 7); `sources` = the run's URLs.
 * User-set, the skill never rewrites: `why`/`measurable` (the criterion), `primary` (primary-tier pages fetched — issuer/agency/regulator + data originators; every row's
 * `primary[]` hosts together are the leg's primary tier, `primaryHosts` in `src/ladder-run.ts`), `press` (news/republisher pages — fetched after `primary`, never primary-tier),
 * `search` (query stems), `seed` (the at-sale press, skipped as already read).
 * `fails` = consecutive failed fetches per `primary` or `press` URL; at 2 the page drops off the fetch list — a `primary` page until the run replaces it,
 * a `press` page until the user does (the plan lists it as `pressDead`, `src/ladder-run.ts`).
 * `extendedOn` (apply-stamped, never patched) = the last run whose plan gave the row an `extended` search: absent an in-window source the costly search repeats only every `EXTENDED_EVERY` days (daily within `EVENT_NEAR_DAYS` of its event) — a structurally absent datum (a quarterly 10-Q figure) no longer earns it every run (`EXTENDED_EVERY`).
 * `searchNext` (apply-written from the patch, ≤ `SEARCH_NEXT_MAX`, oldest dropped) = month-less stems a run found better; the next plan's `more` is the newest, cleared once a run cites an in-window source.
 * `quiet` (apply-written, absent = 0) = consecutive researched runs labelled `UNCHANGED …`/`QUIET …`; at `QUIET_MERGE_AT` a HOT row's `sides` merge into one query unless an event is on its day (`src/ladder-run.ts`).
 * `lean` may end in apply-written grade tags ` (press only)` · ` (single-source)` · ` (draft)` (`stripTags`/`leanWord` drop them).
 * `probe` (user-set) = never researched (gate `PROBE`); apply writes its bare lean off its escalation-box family (`probeLean`, `src/ladder-run.ts`).
 * `probeLeans` (user-set, probe rows) = the `{tripped, clear}` lean words replacing the default bear/fizzle read (`vetProbeLeans`, `src/ladder-run.ts`).
 * `measure` (user-set) = an npm script whose `--json` print (`Measured`) `<leg>:state` attaches to the row when due (`withMeasured`, `src/ladder-run.ts`).
 */
export type LadderSign = { sign: string; label: string; lean: string; finding: string; why: string; measurable: string; base?: string; block: boolean; checked: string | null; due: string | null; primary: string[]; press?: string[]; search: string[]; seed: string[]; sources: LadderSource[]; fails?: Record<string, number>; cadence?: number; leanLog?: { date: string; lean: string }[]; extendedOn?: string; searchNext?: string[]; quiet?: number; probe?: true; probeLeans?: { tripped: string; clear: string }; measure?: string; /** Set with `block`: `on` = the escalation's evidence date (`resolveBlocks`) or, for a patch `block: true`, the run day — only later evidence lifts it; `by` = the escalation event; `reach: "released"` = that escalation's `spares` names the row, a second demotion (fizzle or stale review) or the `STALE_REVIEW_CAP` release, so `block` stays false, the row holds nothing and is due every run until the cause's fizzle clears it (`isReleased`, src/ladder-block.ts); `reach: "T2T3"` = an unrelated fizzle (`resolveBlocks`) or a stale review (`effectiveReach`) demoted the block one tier — it holds T2·T3 only, a second demotes it to `released`; `setRun` / `cause` / `lifts` / `reviewBy` = the lift contract apply stamps on a block lacking `setRun` (`stampContract`; a `reviewBy` a demotion set this run is kept), `reviewed` = the day a stale review, a pinned hold, a re-arm or an unrelated-fizzle demotion last moved `reviewBy`, `staleReviews` = consecutive stale reviews since (a re-arm or a new block resets it; `STALE_REVIEW_CAP` releases), `pinned.until` = a vetted patch `pin`: through that day a stale review neither demotes nor releases the block (an unrelated fizzle still demotes it), `rewritten` = the day apply took the row's `contractOwed` answer (`vetContractOwed`) — owed again once a later review moves `reviewed` past it, or a stale review (the same run's included) drops it (`reviewBlock`), `causeFalseOn` = the day apply first took a vetted patch `causeFalse` (`causeFalseLifts`). */ blocked?: { on: string; by?: string; reach?: "released" | "T2T3"; setRun?: string; cause?: string; lifts?: string[]; reviewBy?: string; reviewed?: string; staleReviews?: number; pinned?: { until: string }; rewritten?: string; causeFalseOn?: string } };
/** A deciding event: `signs` = the `signs[].sign` rows it is the subject of (DELAY-tagged; due every run only within 7 days of the pending event, or once it is past with the outcome owed or landed `mixed:` (a clause unchecked) — else on cadence, `eventWatch` in `src/ladder-run.ts`); `holds` = the tranches it delays (empty = context only, e.g. `secondary`).
 * `sources` = the pages a landed `status` cites (the run patch's, replaced when given); a landed status set by a run carries the same grade tags as a lean (` (press only)` / ` (single-source)`).
 * `at` = when on its date the outcome can first exist (`pre` a pre-US-open print · `close` the US close · `post`, the default, after hours): an own-date event is owed only from that window (`landable`, `src/ladder-run.ts`) — before it, a slot's run is a free idle run (`landable`). */
export type LadderEvent = { date: string; event: string; signs: string[]; escalationIf: string; fizzleIf: string; holds: ("T1" | "T2" | "T3")[]; secondary: boolean; status: string; sources?: LadderSource[]; verified?: boolean; dateNote?: string; expect?: string; at?: "pre" | "close" | "post"; verifyChecked?: string; preRead?: string | LadderPreRead; /** Events whose `fizzle:` lifts the blocks this event's escalation set (`resolveBlocks`, src/ladder-block.ts) — the only ones: set, a fizzle of another event naming the row demotes the block one tier; absent, any naming event's fizzle lifts. */ liftBy?: string[]; /** Set with a `mixed:` landing on a block's `liftBy` event: its unchecked clause is not the cause, so it lifts (`vetOffCause`, src/ladder-block.ts). */ offCause?: true; /** Signs an `escalation:` landing names but spares — released, not blocked (`resolveBlocks`; [USER 2026-11-13]). */ spares?: string[]; /** The `holds` an owed `mixed:` held before `degradeMixed` cut them — an `escalation:` re-land restores them, a `fizzle:` drops the field. */ heldBefore?: ("T1" | "T2" | "T3")[] };
/** `preRead` (user-set, or run-patched) = what to read before the event (e.g. CME FedWatch odds), bare or `{text, sources}`: the sources walked in order, each an `http(s)://` URL or `search: <stem>`;
 * the run writes the read into the pending `status` as `pre <date>: <read> (<host>)` (`preReadOwed`, `vetPreRead`, `src/ladder-run.ts`). */
export type LadderPreRead = { text: string; sources: string[] };
/** A retired event: a settled landing (`retireEvents`) or a `dropped: <reason>` one with `holds: []` (`applyEventPatch`, src/ladder-run.ts) — `LadderEvent` minus its pre-outcome fields; every `LadderEvent` is one. */
export type LadderEventDone = Pick<LadderEvent, "date" | "event" | "signs" | "holds" | "secondary" | "status" | "sources" | "liftBy" | "spares">;
/** `dateNote` (events and calendar rows) = the date's provenance/doubt, kept out of the title; rendered ` (<note>)` only while `verified !== true` (`noted`). */
/** `verifyChecked` (events and calendar rows, apply-stamped, never patched) = the last run that searched the row's date (`verify[]`): an unanswered check is re-queued after `VERIFY_EVERY` days, daily within `EVENT_NEAR_DAYS` of the date (`VERIFY_EVERY`). */
/** A dated item that delays nothing, rendered under its `sign` (a `signs[].sign`) — sign-less, or naming no `signs[]` row, in the board's "Dated, no sign" list; `verified: false` = the date is from a search summary, re-sourced when the row comes into the window. */
export type LadderCalendar = { date: string; sign?: string; event: string; matters: string; verified: boolean; dateNote?: string; verifyChecked?: string };
/** User-set lines heading the Signs & deciding events board: the calendar guard, the clean-outcome note, the escalation exit. */
type LadderRules = string[];
/** The skill-written head of the Signs & deciding events board, plain language: the lean (where the leg stands + the binding gate) · the slow (grind) threat · the fast (gap) threat · what decides it (why the dated events matter now, which hold T2/T3) · what flips the lean — ≤ 2 sentences each, never indicator-by-tranche detail (the Verdict's). */
export type LadderSlots = { lean: string; slow: string; fast: string; decides: string; flips: string };
/** `asOf` = the apply's day of the last full five-slot write (apply-stamped, never patched; `SITUATION_MAX_DAYS` in src/ladder-situation.ts). */
type LadderSituation = LadderSlots & { asOf?: string };
/** `watch` = the run's `verdict.watch.grade`, absent on a leg without a watch. */
export type LadderRun = { date: string; t1: string; t2: string; t3: string; live: string; watch?: string };
/** Calendar days from `from` to `to` (ISO days). */
export const gap = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 864e5);
/** An event within this many days is near: daily verify/scan/extended cadences (src/ladder-run.ts) and `decides` coverage (src/ladder-situation.ts). */
export const EVENT_NEAR_DAYS = 3;
/** The `:state` print drops an event dated more than this many days after today unless it is on `verify` (the stored events are untouched). */
export const EVENT_HORIZON_DAYS = 31;
/** A landed event's outcome off its `status` prefix (`escalation:` / `fizzle:` / `mixed:` — the third = landed with an escalation-side clause unchecked, ladder-skill-kaizen-critique outcomeOf); undefined while pending. */
type Outcome = "escalation" | "fizzle" | "mixed";
export const outcomeOf = (e: Pick<LadderEvent, "status">): Outcome | undefined => /^(escalation|fizzle|mixed): /.exec(e.status)?.[1] as Outcome | undefined;
export const landed = (e: Pick<LadderEvent, "status">): boolean => outcomeOf(e) !== undefined;
/** A settled landing older than this many days moves to `eventsDone` (`retireEvents`, src/ladder-run.ts) — the board's `DECIDING_DAYS`. */
export const RETIRE_DAYS = DECIDING_DAYS_JS as number;
/** `events` + `eventsDone` — every history read; live reads (verify, scan, siblings, `decidingWeek`, `eventWatch`) keep `events`. */
export const allEvents = allEventsJs as (live: Pick<LadderLive, "events" | "eventsDone">) => LadderEventDone[];
/** When a landed event's outcome came out (`landedOn`, public/ladder-views.js). */
export const landedOn = landedOnJs as (e: Pick<LadderEvent, "date" | "sources">) => string;
type Reading = { value: string; verdict: Mark; count?: { got: number; need: number } };
/**
 * Read schema — metadata on every emitted row; the Grid/Blockers views render `job` + `variant`
 * (parity pinned in src/ladder-reads.test.ts + public/lab-reentry.test.js). `indicator` = the leg's one canonical name for the series read
 * (`makeTagOf` over the leg's `INDICATOR` table derives it from a single series; a multi-series row names it by hand); `series` = the ids read;
 * `job` = what the threshold compares against. `composite` is decided FIRST: a rule reading ≥ 2 comparand classes (shock/peak, moving average,
 * recent-window high/percentile, lagged own value Δ, absolute level); a multi-series read with one comparand class keeps that class's job. Only a
 * single-comparand rule whose wording fits two labels takes the fixed precedence `recovery` (vs a named shock/peak) > `regime` (vs a moving average) > `relative` (vs a recent-window high/percentile) >
 * `speed` (Δ over N closes, z of Δ included) > `level` (absolute); `manual` = a sign row or a sign-only box family (no close read, `series: []`); `agg` = the row's one aggregation role (`kOfN` criterion, `allOf` gate, `box` family).
 * Lives on each probe's static def (`LegDef` / family def), set at the row-factory CALL SITE, copied onto the row by the emit path.
 */
export const READ_JOBS = ["speed", "relative", "recovery", "regime", "level", "manual", "composite"] as const;
type ReadJob = (typeof READ_JOBS)[number];
const READ_AGGS = ["kOfN", "allOf", "box"] as const;
type ReadAgg = (typeof READ_AGGS)[number];
export type ReadTag = { indicator: string; series: string[]; job: ReadJob; agg: ReadAgg; variant?: string };
/** A row's tag request, as written at the row-factory call site; `Id` = the leg's series ids. */
export type TagSpec<Id extends string> = { series: readonly Id[]; job: ReadJob; agg: ReadAgg; indicator?: string; variant?: string };
/**
 * The ONE read-tag builder, bound per leg to its `INDICATOR` table (series id → the leg's canonical name): a single-series row derives
 * `indicator` from the table; every other row (multi-series, or `series: []`) names it by hand — throws at module load otherwise, so a
 * multi-series row can never silently take `series[0]`'s name.
 */
export const makeTagOf =
  <Id extends string>(INDICATOR: Readonly<Record<Id, string>>) =>
  (t: TagSpec<Id>): ReadTag => {
    const name = t.indicator ?? (t.series.length === 1 ? INDICATOR[t.series[0]!] : undefined);
    if (name === undefined) throw new Error(`a multi-series read names its indicator: ${t.series.join("+") || "(no series)"}`);
    return { indicator: name, series: [...t.series], job: t.job, agg: t.agg, ...(t.variant ? { variant: t.variant } : {}) };
  };
/** Structural check for the "every row tagged" test (`scripts/ladder-read-tags.test.ts`): all four fields present, enums honoured, `series` non-empty unless `manual`, `variant` (a named variant of the job's shared form) non-empty when present. */
export const isReadTag = (t: unknown): t is ReadTag =>
  !!t && typeof t === "object" && typeof (t as ReadTag).indicator === "string" && (t as ReadTag).indicator.length > 0 && Array.isArray((t as ReadTag).series) && (t as ReadTag).series.every((s) => typeof s === "string" && s.length > 0) && (READ_JOBS as readonly string[]).includes((t as ReadTag).job) && (READ_AGGS as readonly string[]).includes((t as ReadTag).agg) && ((t as ReadTag).series.length > 0 || (t as ReadTag).job === "manual") && ((t as ReadTag).variant === undefined || (typeof (t as ReadTag).variant === "string" && (t as ReadTag).variant!.length > 0));
/** `tip` = the expected cell's anchor what + why — a `/lab` tooltip only, never in the md. `foot` = a clause shared across rows, a numbered footnote on the expected cell (`footer`). `tag` = the read schema above (absent on rows stored before stage 1). @internal */
export type VerdictLeg = Reading & { key: string; tranche: TrancheId; leg: string; rule: string; tip?: string; foot?: string; gate: boolean; live: Reading; tag?: ReadTag };
/** One escalation-box family in `VerdictLeg` cell grammar: `unmet` = TRIPPED, `na` = no close read and no sign row; `near` = untripped but close; `live` = the same read over the latest prints (absent = the close cell repeats); `signs` = the rows feeding it. */
/** A clustered box row (`boxOf`): each member's `rule` / `value` / `live` are the probe's display cells, `—` when absent; `tag.series` = the ids its ruled read fills its cells from; `signs` = the rows it carries (`boardRows`); `near` = untripped but close (the hot cadence). @internal */
export type ClusterView = Omit<ClusterRead, "members"> & { members: (ClusterRead["members"][number] & { rule?: string; value?: string; live?: string; liveCell?: Cell; tag?: ReadTag; signs?: LadderFamily["signs"]; near?: boolean })[] };
export type LadderFamily = { name: string; rule: string; value: string; verdict: Mark; near?: boolean; live?: { value: string; verdict: Mark }; signs: { sign: string; lean: string; block: boolean }[]; tag?: ReadTag };
/** Leg-agnostic row builder: `close` null = no close read (`—`); a `block: true` sign forces `unmet` on both cells; a `na` close with sign rows reads off them (`met` unless blocked). */
export function familyRow(name: string, rule: string, close: { value: string; verdict: Mark } | null, signs: readonly Pick<LadderSign, "sign" | "lean" | "block">[], opts: { near?: boolean; live?: { value: string; verdict: Mark } | null; tag?: ReadTag } = {}): LadderFamily {
  const blocked = signs.some((s) => s.block);
  const settle = (c: { value: string; verdict: Mark } | null): { value: string; verdict: Mark } => ({ value: c?.value ?? "—", verdict: blocked ? "unmet" : c && c.verdict !== "na" ? c.verdict : signs.length ? "met" : "na" });
  const cell = settle(close);
  return { name, rule, ...cell, ...(opts.near && { near: true }), live: opts.live ? settle(opts.live) : cell, signs: signs.map(({ sign, lean, block }) => ({ sign, lean, block })), ...(opts.tag && { tag: opts.tag }) };
}
/** Any tagged read a probe emits — a `VerdictLeg` (`key` = its row key) or a family (`key` = its name). */
export type TaggedRead = { key: string; tag?: ReadTag };
export type ReadGroup = { indicator: string; job: ReadJob; agg: ReadAgg; keys: string[] };
const groupKey = (t: ReadTag): string => `${t.indicator}\u0000${t.job}\u0000${t.agg}`;
/**
 * Duplicate-read lint over ONE leg's reads: groups of ≥ 2 rows sharing `indicator` + `job` + `agg` — tags only, never rule prose
 * (`z(Δ20) < 1 ×5` modulo N/k is not decidable on strings), so a read repeated per tranche with only N/k varying IS reported; over-reporting
 * is accepted. Untagged rows are ignored (the "every row tagged" test, `scripts/ladder-read-tags.test.ts`, owns them). Sorted by indicator, job, agg;
 * `keys` in emit order. `ACCEPTED` in `scripts/lint-ladder-reads.ts` is the only pin of the accepted groups (all four legs); its `--strict` exits 1
 * on an unpinned group, a stale `ACCEPTED` entry, or an untagged read — never on a pinned group.
 */
export const duplicateReads = (reads: readonly TaggedRead[]): ReadGroup[] => {
  const groups = new Map<string, ReadGroup>();
  for (const r of reads) {
    if (!r.tag) continue;
    const k = groupKey(r.tag);
    const g = groups.get(k) ?? { indicator: r.tag.indicator, job: r.tag.job, agg: r.tag.agg, keys: [] };
    g.keys.push(r.key);
    groups.set(k, g);
  }
  return [...groups.values()].filter((g) => g.keys.length >= 2).sort((a, b) => a.indicator.localeCompare(b.indicator) || a.job.localeCompare(b.job) || a.agg.localeCompare(b.agg));
};
export type ReadScope = { indicator: string; job: ReadJob; variant?: string; tranches: TrancheId[] };
/** Tranche scope of each `indicator` + `job` (+ `variant`) read, DERIVED from the tranches carrying its rows — never stored on a row. `splitGates` is not this: it groups byte-identical gate readings for the Criteria detail. Untagged rows are skipped; tranches in `TRANCHE_IDS` order. */
export const readScope = (rows: readonly Pick<VerdictLeg, "tranche" | "tag">[]): ReadScope[] => {
  const scopes = new Map<string, ReadScope>();
  for (const r of rows) {
    if (!r.tag) continue;
    const k = `${r.tag.indicator}\u0000${r.tag.job}\u0000${r.tag.variant ?? ""}`;
    const s = scopes.get(k) ?? { indicator: r.tag.indicator, job: r.tag.job, ...(r.tag.variant && { variant: r.tag.variant }), tranches: [] };
    if (!s.tranches.includes(r.tranche)) s.tranches.push(r.tranche);
    scopes.set(k, s);
  }
  return [...scopes.values()].map((s) => ({ ...s, tranches: TRANCHE_IDS.filter((t) => s.tranches.includes(t)) }));
};
/** A published shock: `base`/`peak`/`last`/`sigma` are `null` for a licensed id (`scrubLicensedLevelsInLeg`, src/licensed-levels.ts). */
type Shock = { base: number | null; peak: number | null; peakDate: string; last?: number | null; lastDate?: string; sigma: number | null; broke: boolean };
type RawTranche = { tranche: TrancheId; metCount: number; total: number; need: number; gates: Mark[]; ready: boolean; clear: boolean; via?: Via };
/** A read that is never a gate: the leg's price vs its `maN`-close MA, and the first close of the open zone run (Value only). */
export type LadderDisplay = { maN: number; vsMa: number | null; zoneSince: string | null };
/** A drawdown watch row: `manual` = shown with its sign's lean, never graded (`watchOf` throws on one in the roster). */
/** A watch row outside the roster: `context` is shown and never touches the grade (rendered in its own table); `confirmer` lifts a lead-voted ELEVATED;
 *  `step` never votes, but its hit lets an open drawdown's ELEVATED step to HIGH (semis `stretch`). Absent = votes in its cluster. */
export type WatchRole = "context" | "confirmer" | "step";
export type WatchRow ={ key: string; label: string; cluster: string; role?: WatchRole; now: string; correction: { rule: string; cell: Cell }; bear: { rule: string; cell: Cell }; manual?: true; signs?: LadderFamily["signs"]; tag?: ReadTag };
/** `watchOf` (src/ladder-box.ts) + the rows; computed with or without an open drawdown (`held` = none open), display/notify only — never a gate or a tranche input.
 *  `latched`: the raw HIGH/SEVERE session (ISO) a latched HIGH holds from; `stretched`: the stretched anchor high (ISO) a stepped HIGH holds from; `lifted`: the confirmer keys that lifted it (semis `watchLatched`). */
export type LadderWatch = { held: boolean; exit?: string; grade: string; latched?: string; stretched?: string; lifted?: string[]; rows: WatchRow[]; correction: Box; bear: Box };
/** The verdict's read dates over the series it reads: newest close, newest live head, `est` = any live head an estimate (heads the close/live columns). */
export type LadderAsOf = { close: string; live: string; est: boolean };
/**
 * The shared verdict shape every leg's probe emits through `toVerdict`. `regime.exshVsMa200` and the optional keys below it are
 * the EU-Fin probe's extras; `display` is the Value probe's.
 */
export type LadderVerdict = {
  legs: VerdictLeg[];
  tranches: LadderTranche[];
  live: LadderTranche[];
  prov: boolean;
  regime: { set: string; exshVsMa200?: number | null };
  display?: LadderDisplay;
  asOf?: LadderAsOf;
  /** `families`: the sign rows (`familyRow`), shown under the cluster table without a vote.
   *  `clusters` / `veto` / `quorum` / `hold` / `holdT2T3`: the clustered box (`boxOf`, src/ladder-box.ts); without `clusters` no Episode gates render. */
  escalation: { tripped: number; need: number; hits: string[]; near?: string[]; unread?: string[]; families?: LadderFamily[]; clusters?: ClusterView[]; veto?: string[]; quorum?: { live: number; n: number; need: number; t1Only: boolean }; hold?: boolean; holdT2T3?: boolean; leadAlone?: boolean };
  sessionsSinceExit?: number;
  lifts?: LadderMeasuredLift[];
  shocks?: Record<string, Shock | null>;
  inactive?: { set: string; tranches: RawTranche[] };
  watch?: LadderWatch;
};
/** `runAt` = the apply's wall-clock instant (ISO, UTC), absent on a backfill (`runStamp`, src/ladder-run.ts) — rendered as a local `HH:MM TZ` beside `run`. */
/** User-set leg facts the skill body reads off the `<leg>:state` print instead of carrying ×4 — never written by apply (the patch-key `vet` excludes it). */
/** A primary-tier source by name, with the bare domains (`tsmc.com`, no scheme, no `www.`) whose host or subdomains grade primary (ladder-skill-implementation-order 13b). */
type LadderTier = { name: string; hosts: string[] };
type LadderBrief = { fund: string; primaryTier: LadderTier[]; holdsPolicy: string; gates: string; eventScope: string };
/** `scannedOn` (apply-stamped) = the last run that ran the `scan` query — weekly (`SCAN_EVERY`), always with an unlanded event within `EVENT_NEAR_DAYS` (`SCAN_EVERY`). */
export type LadderLive = { run: string; runAt?: string; scannedOn?: string; rules: LadderRules; brief?: LadderBrief; situation?: LadderSituation; verdict?: LadderVerdict; signs: LadderSign[]; events: LadderEvent[]; eventsDone?: LadderEventDone[]; calendar: LadderCalendar[]; runs: LadderRun[] };

/** A probe's tranche row before `toVerdict` folds it into a `LadderTranche`. */
type ProbeTranche = { tranche: TrancheId; metCount: number; total: number; need: number; met: boolean; ready: boolean; via?: Via; gates: Mark[]; since: string | null };
/** What a leg's `evaluateShipped` returns: the verdict minus `prov`, with the two tranche arrays still in probe form. */
export type LadderProbeResult = Omit<LadderVerdict, "tranches" | "live" | "prov"> & { tranches: ProbeTranche[]; tranchesLive: ProbeTranche[] };

const tranche = (t: ProbeTranche): LadderTranche => ({ id: t.tranche, met: t.metCount, total: t.total, need: t.need, ok: t.met, ready: t.ready, ...(t.via && { via: t.via }), gates: t.gates, filledSince: t.since });

/** `res` minus its two tranche arrays, which become `tranches` (closes) and `live` (latest prints); `prov` = any series' newest row is an intraday head.
 *  Licensed index levels are not published: every string comes back through `scrubLicensedLevelsInLeg` (src/licensed-levels.ts), so an
 *  observed level reads `—` while ✓/✗ and our own thresholds stay — the one choke point every verdict writer (a probe's `--into`, apply's
 *  `reverdict`) passes, so no per-formatter subject plumbing is needed. The one numeric level field, `shocks`, has a licensed id's numbers nulled there too. */
export function toVerdict(res: LadderProbeResult, prov: boolean): LadderVerdict {
  const { tranches, tranchesLive, ...rest } = res;
  return scrubLicensedLevelsInLeg<LadderVerdict>({ ...rest, tranches: tranches.map(tranche), live: tranchesLive.map(tranche), prov }).live;
}

const cell = (v: string): string => v.replace(/\|/g, "\\|");
const row = (...cols: string[]): string => `| ${cols.map(cell).join(" | ")} |`;
const table = (head: string[], body: string[][]): string[] => [row(...head), `|${head.map(() => "---").join("|")}|`, ...body.map((r) => row(...r))];
/** ` · gates ✓✗–` in leg-definition order; "" when absent or empty — mirrored by `gatesText` in public/lab-reentry.js. */
export const gatesText = (gates: LadderTranche["gates"]): string => (gates?.length ? ` · gates ${gates.map((g) => MARK[g] ?? "–").join("")}` : "");
/** `✗: 4/4 need 3 (time stop) · gates ✓✗–` — the ready mark leads, no date (the pages never show a fill); the one tranche cell for the md, `<leg>:state` and (via `probeTrancheCell`) both legs' probes — mirrored by `tranche` in public/lab-reentry.js. */
export const trancheCell = (t: LadderTranche): string => `${t.ok ? "✓" : "✗"}: ${t.met}/${t.total} need ${t.need}${t.via ? ` (${t.via})` : ""}${gatesText(t.gates)}`;
/** `trancheCell` over a probe's raw tranche result. */
export const probeTrancheCell = (t: ProbeTranche): string => trancheCell(tranche(t));
/** `toFixed` with a negative zero rendering (`-0.00`) unsigned. */
const fixed = (x: number, d: number): string => x.toFixed(d).replace(/^-(?=[0.]+$)/, "");
/** The probes' value-cell number: `d` decimals, `—` when absent or non-finite, never `-0.00`. */
export const fixNum = (x: number | null | undefined, d = 2): string => (x === null || x === undefined || !Number.isFinite(x) ? "—" : fixed(x, d));
/** Decimals ≥ d at which a value and its expected print apart; a true tie (within 1e-9) stays at d. @internal */
export const dpApart = (a: number, b: number, d = 2): number => {
  while (d < 6 && Math.abs(a - b) > 1e-9 && fixed(a, d) === fixed(b, d)) d++;
  return d;
};
type Num = number | null | undefined;
const finite = (x: Num): x is number => typeof x === "number" && Number.isFinite(x);
/** One width for a whole cell: the widest `dpApart` (≥ d) over its compared pairs; a pair with an absent side is skipped. */
export const dpCell = (pairs: readonly (readonly [Num, Num])[], d = 2): number =>
  Math.max(d, ...pairs.flatMap(([a, b]) => (finite(a) && finite(b) ? [dpApart(a, b, d)] : [])));
/** A value and its expected, fixed to one shared `dpApart` width. */
export const vs = (a: Num, b: Num, d = 2): [string, string] => ((n) => [fixNum(a, n), fixNum(b, n)])(dpCell([[a, b]], d));
/** `MM-DD` off an ISO date — a value cell's date never carries the year. */
export const mmdd = (date: string): string => date.slice(5);
/** `value/cut` — the newest close over the cut it is read against, widened until they differ. */
export const vc = (x: Num, cut: Num, d = 2): string => vs(x, cut, d).join("/");
/** `vc` + the bare date of the past close the cut is: `3.36/3.32 (10-06)`. */
export const vcAt = (x: Num, cut: { value: number; date: string } | null, d = 2): string => `${vc(x, cut?.value, d)}${cut ? ` (${mmdd(cut.date)})` : ""}`;
/** `z 0.76<1` — z against its cap; a short history prints `z —`. */
export const zVs = (z: number | null, max: number): string => (z === null ? "z —" : `z ${vs(z, max)[0]}<${max}`);
/** A return and its cut as signed `%`, widened past 1 dp until they differ. */
export const pctVs = (x: number, cut: number): [string, string] => vs(x * 100, cut * 100, 1).map((t, k) => `${[x, cut][k]! >= 0 ? "+" : ""}${t}%`) as [string, string];
/** An RV in % points at `d` decimals (1 unless widened apart from its cut), no `%` sign. */
export const rvn = (x: Num, d = 1): string => fixNum(x === null || x === undefined ? x : x * 100, d);
/** The decimals (≥ 1) at which an RV prints apart from every cut it is read against. */
export const rvApart = (x: number, cuts: (number | null)[]): number => dpCell(cuts.map((k) => [x * 100, k === null ? null : k * 100] as const), 1);
/** A speed row: `Δ ≤0✓ <max M MM-DD✓`, Δ / 0 / max at one width (2 while either is absent). */
export const speedCell = (s: { d: number | null; max: number; maxDate: string | null }): string => {
  const w = s.d === null || !Number.isFinite(s.max) ? 2 : dpCell([[s.d, 0], [s.d, s.max]]);
  const mark = (ok: boolean): string => (ok ? "✓" : "✗");
  return `${fixNum(s.d, w)} ≤0${mark(s.d !== null && s.d <= 0)} <max ${fixNum(s.max, w)}${s.maxDate ? ` ${mmdd(s.maxDate)}` : ""}${mark(s.d !== null && s.d < s.max)}`;
};
/** A retrace line's source points: `(peak 3.60 10-02 low 2.80 09-01)`; an undated floor (a median base) prints its value alone. */
export const peakLow = (peak: { value: number; date: string }, low: { value: number; date?: string }, lowWord = "low"): string =>
  `(peak ${fixNum(peak.value, 2)} ${mmdd(peak.date)} ${lowWord} ${fixNum(low.value, 2)}${low.date ? ` ${mmdd(low.date)}` : ""})`;
const gapText = (gap: number | null): string => (gap === null ? "—" : `${gap >= 0 ? "+" : ""}${(gap * 100).toFixed(1)}%`);
const MARK = { met: "✓", unmet: "✗", na: "–" } as const;
const reading = (r: LadderVerdict["legs"][number]["live"]): string => `${r.value} ${MARK[r.verdict]}${r.count ? ` ${r.count.got}/${r.count.need}` : ""}`;
type Leg = LadderVerdict["legs"][number];
/** Per-doc footnote numbers: 1-based in first-appearance order, deduped by text — mirrored by `footer` in public/lab-reentry.js. */
const footer = () => {
  const m = new Map<string, number>();
  return { n: (t: string): number => m.get(t) ?? m.set(t, m.size + 1).size, all: (): [string, number][] => [...m] };
};
type Footer = ReturnType<typeof footer>;
const legRow = (l: Leg, label: string, feet: Footer): string[] => [label, `${l.rule}${l.foot ? `[^${feet.n(l.foot)}]` : ""}`, reading(l), reading(l.live)];
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
/** ` · Fri 10-09` off an ISO date, "" when absent — mirrored by `stamp` in public/lab-reentry.js. */
const stamp = (d: string | undefined): string => (d ? ` · ${DAY[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${d.slice(5)}` : "");
/** The close + live column heads, dated off `asOf` (` est.` when a live head is an estimate), bare without it — mirrored by `heads` in public/lab-reentry.js. */
const heads = (v: LadderVerdict, live = "live"): [string, string] => [`close${stamp(v.asOf?.close)}`, `${live}${stamp(v.asOf?.live)}${v.asOf?.est ? " est." : ""}`];
/** Per tranche: its criteria table, then a table of its gates (`gate: ` prefix dropped) when it has any — mirrored by `trancheCriteria` in public/lab-reentry.js. */
const trancheCriteria = (legs: Leg[], h: [string, string], feet: Footer): string[] => {
  const gates = legs.filter((l) => l.gate);
  return [
    ...table(["criterion", "expected", ...h], legs.filter((l) => !l.gate).map((l) => legRow(l, l.leg, feet))),
    "",
    ...(gates.length ? [...table(["gate (all must pass)", "expected", ...h], gates.map((l) => legRow(l, l.leg.replace(/^gate: /, ""), feet))), ""] : []),
  ];
};
/** Gate rows identical across ≥ 2 tranches (same label, rule and both readings) render once in the "shared gates" block, labelled with their tranches
 *  when fewer than three (`HY OAS no new high (T2·T3)`); the tranche tables keep only their own rows — mirrored by `splitGates` in public/lab-reentry.js. @internal */
export const splitGates = <L extends Pick<Leg, "tranche" | "leg" | "rule" | "foot" | "value" | "verdict" | "count" | "live" | "gate">>(legs: L[]): { shared: { leg: L; label: string }[]; own: L[] } => {
  const keyOf = (l: L): string => [l.leg, l.rule, l.foot, l.value, l.verdict, l.count?.got, l.count?.need, l.live.value, l.live.verdict, l.live.count?.got, l.live.count?.need].join("\u0000");
  const tranches = new Map<string, L["tranche"][]>();
  for (const l of legs) if (l.gate) tranches.set(keyOf(l), [...(tranches.get(keyOf(l)) ?? []), l.tranche]);
  const isShared = (l: L): boolean => l.gate && new Set(tranches.get(keyOf(l))).size >= 2;
  const seen = new Set<string>();
  const shared = legs.filter((l) => isShared(l) && !seen.has(keyOf(l)) && seen.add(keyOf(l))).map((l) => ((ts) => ({ leg: l, label: `${l.leg.replace(/^gate: /, "")}${ts.length < 3 ? ` (${ts.join("·")})` : ""}` }))([...new Set(tranches.get(keyOf(l)))]));
  return { shared, own: legs.filter((l) => !isShared(l)) };
};
/** Collapsed per-leg detail: the shared-gates table (`splitGates`), criteria + gate tables per tranche — mirrored by `criteria` in public/lab-reentry.js. */
const criteria = (v: LadderVerdict, feet: Footer): string[] => {
  const g = splitGates(v.legs);
  return [
    "<details><summary>Criteria detail — T1 · T2 · T3</summary>",
    "",
    ...(g.shared.length ? ["**shared gates**", "", ...table(["gate (all must pass)", "expected", ...heads(v)], g.shared.map((s) => legRow(s.leg, s.label, feet))), ""] : []),
    ...(["T1", "T2", "T3"] as const).flatMap((t) => [`**${t}**`, "", ...trancheCriteria(g.own.filter((l) => l.tranche === t), heads(v), feet)]),
    "",
    "</details>",
  ];
};
/** The close cell: `value ✓/✗/–`, ` TRIPPED` on unmet, ` near` when near (the live cell is a bare `reading`) — mirrored by `familyCell` in public/lab-reentry.js. */
const familyCell = (c: { value: string; verdict: Mark }, near = false): string => `${c.value} ${MARK[c.verdict]}${c.verdict === "unmet" ? " TRIPPED" : ""}${near ? " near" : ""}`;
// The shared view model (public/ladder-views.js), re-typed — one copy, both renderers import it.
/** One Grid row: `kind` box = a `BOX_INDICATOR` leg row, read = every other tagged leg row (families add no rows since 2026-10-13). */
type GridRow = { indicator: string; series: string[]; first: boolean; job: ReadJob; variant?: string; kind: "read" | "box"; open: boolean; scope: TrancheId[]; cells: Record<TrancheId, string> };
type GridView = { untagged: boolean; rows: GridRow[] };
/** The `tag.indicator` every probe sets on its `*-esc` gate row. @internal */
export const BOX_INDICATOR = BOX_INDICATOR_JS as string;
const gridRows = gridRowsJs as (v: LadderVerdict) => GridView;
/** One Blockers tranche: rows routed by the close verdict (`unmet` / `passing` / `unread`), the close box beside them. */
type BlockerBox = { holds: boolean; present: boolean; hold: boolean; holdT2T3: boolean; votes: string[]; veto: string[]; quorum: LadderVerdict["escalation"]["quorum"] | null };
type BlockerTranche = { id: TrancheId; close: LadderTranche; live: LadderTranche | null; filled: boolean; unmet: VerdictLeg[]; passing: VerdictLeg[]; unread: VerdictLeg[]; box: BlockerBox };
type BlockersView = { tranches: BlockerTranche[]; held: boolean };
const blockers = blockersJs as (v: LadderVerdict, opts?: { naGateHolds?: boolean }) => BlockersView;
const blockersSummary = blockersSummaryJs as (b: BlockersView) => string;
/** @internal */
export const HELD_NOTE = HELD_NOTE_JS as string;
const foldText = foldTextJs as (t: BlockerTranche) => string;
const boxHoldsText = boxHoldsTextJs as (box: BlockerBox) => string;
const clusterHead = clusterHeadJs as (v: LadderVerdict) => string;
const clusterRows = clusterRowsJs as (v: LadderVerdict) => string[][];
const clusterBoxText = clusterBoxTextJs as (v: LadderVerdict) => string;
const jobText = jobTextJs as (row: GridRow) => string;
const seriesNote = seriesNoteJs as (g: GridView) => string;
const JOB_LEGEND = JOB_LEGEND_JS as string;
export const leanGroup = leanGroupJs as (lean: string) => 0 | 1 | 2 | 3;
export const leanWord = leanWordJs as (lean: string) => string;
export const stripTags = stripTagsJs as (text: string) => string;
const LEAN_GLYPH = LEAN_GLYPH_JS as readonly ["▲", "◆", "▼", "○"];
export const labelAged = labelAgedJs as (label: string, checked: string | null) => string;
const signsCell = signsCellJs as (signs: LadderFamily["signs"]) => string;
/** `WATCH_HEAD` + rows, minus the signs column when no row carries a sign. */
const watchTable = watchTableJs as (rows: string[][]) => { head: string[]; rows: string[][] };
const watchHead = watchHeadJs as (v: LadderVerdict) => string;
export const watchGrade = watchGradeJs as (w: LadderWatch) => string;
export const watchRows = watchRowsJs as (v: LadderVerdict) => string[][];
export const watchContextRows = watchContextRowsJs as (v: LadderVerdict) => string[][];
const WATCH_CONTEXT_NOTE = WATCH_CONTEXT_NOTE_JS as string;
/** The live board reading beside a sign row (every `boardRows` row naming it; `—` when none) — the number's home beside the grid; a researched row's `finding` never carries one, a probe row's finding IS it (`findingCell`). `live` adds the latest-print cell when it differs. */
export const boardReading = boardReadingJs as (verdict: LadderVerdict | undefined, sign: string, live?: boolean) => string;
const boardText = boardTextJs as (verdict: LadderVerdict | undefined, sign: string) => string;
export const boardFamilies = boardFamiliesJs as (verdict: LadderVerdict | undefined, sign: string) => LadderFamily[];
export const boardRows = boardRowsJs as (verdict: LadderVerdict | undefined) => LadderFamily[];
/** The open Episode gates block between the last-5-runs table and Signs: one row per cluster member (`clusterRows`, its signs last), `clusterBoxText`, then the
 *  families as signs — mirrored by `episodeGates` in public/lab-reentry.js. */
const episodeGates = (v: LadderVerdict): string[] => {
  if (!v.escalation.clusters) return [];
  const fams = v.escalation.families;
  const h = heads(v);
  const famTable = (fs: LadderFamily[]): string[] => table(["family", "trips when", ...h, "signs"], fs.map((f) => [f.name, f.rule, familyCell(f, f.near), reading(f.live ?? f), signsCell(f.signs)]));
  return [`## ${clusterHead(v)}`, "", ...table(["cluster", "member", "trips when", ...h, "signs"], clusterRows(v)), "", clusterBoxText(v), "", ...(fams?.length ? ["**signs (shown, no vote)**", "", ...famTable(fams), ""] : [])];
};
const sourceText = (s: LadderSource): string => `${s.date} ${s.url}`;
/** The never-a-gate display read — mirrored by `displayText` in the probe's own table. */
export const displayText = (d: LadderDisplay): string => `display: ${gapText(d.vsMa)} vs MA${d.maN} — never a gate${d.zoneSince ? ` · zone open since ${d.zoneSince}` : ""}`;
const LEAN_NAME = ["escalation", "open/mixed", "fizzle/quiet", "not yet"] as const;
const LEGEND = "★ deciding (holds a tranche) · ☆ event, holds none · • dated · ~ date unverified";
export const SITUATION_SLOTS = SITUATION_SLOTS_JS as [keyof LadderSlots, string][];
/** A `situation` slot's text, `—` when the slot is missing or blank (the board head's slot paragraphs). */
const slotText = (live: LadderLive, k: keyof LadderSlots): string => live.situation?.[k]?.trim() || "—";
/** The board head: the five `situation` slots as `**head** — text` paragraphs (always, `—` per empty slot; each its own paragraph), then the user-set `rules` in a closed fold, then a blank line. */
const boardHead = (live: LadderLive): string[] => {
  const slots = SITUATION_SLOTS.flatMap(([k, h]) => [`**${h}** — ${slotText(live, k)}`, ""]);
  const rules = live.rules?.length ? ["<details><summary>Rules (user-set)</summary>", "", ...live.rules.map((r) => `- ${r}`), "", "</details>", ""] : [];
  return [...slots, ...rules];
};
const countdown = countdownJs as (from: string, to: string) => string;
const decidingWeek = decidingWeekJs as (live: LadderLive) => string;
const otherWeek = otherWeekJs as (live: LadderLive) => string;
/** One dated item under a sign; `landed` = the event's `landedWord` (`escalation` / `fizzle` / `mixed` / `DELAY`), shown instead of the countdown; `fold` = a `foldLanded` chip's whole text.
 *  `on` = a landed event's `landedOn`; `holding` = `holdingEvent` — both read by `foldDates`. */
type SignItem = { date: string; event: boolean; mark: string; text: string; detail: string[]; landed: string; fold?: string; on?: string; holding?: boolean; owed?: boolean };
const landedWord = landedWordJs as (status: string) => string;
const foldLanded = foldLandedJs as (chips: SignItem[]) => SignItem[];
const conditionsOwed = conditionsOwedJs as (word: string) => boolean;
const foldDates = foldDatesJs as (run: string, items: SignItem[]) => { shown: SignItem[]; history: { text: string; items: SignItem[] } | null };
const holdingEvent = holdingEventJs as (live: LadderLive, e: LadderEventDone) => boolean;
type AnyEvent = LadderEventDone & Partial<LadderEvent>;
const holdingNow = holdingNowJs as (live: LadderLive) => string;
const shownStatus = shownStatusJs as (status: string, run: string) => string;
const noted = (r: AnyEvent | LadderCalendar): string => `${r.event}${r.dateNote && r.verified !== true ? ` (${r.dateNote})` : ""}`;
const eventItem = (e: AnyEvent, live: LadderLive): SignItem => {
  const landed = landedWord(e.status);
  return {
    date: e.date,
    event: true,
    mark: e.holds.length ? "★" : "☆",
    text: `${noted(e)}${e.secondary ? " (secondary)" : ""}`,
    detail: [e.holds.length ? `holds ${e.holds.join("+")}` : "holds no tranche", ...(conditionsOwed(landed) ? [`escalation if: ${e.escalationIf}`, `fizzle if: ${e.fizzleIf}`] : []), `status: ${shownStatus(e.status, live.run)}`, ...(e.sources?.length ? [`sources: ${e.sources.map(sourceText).join(", ")}`] : [])],
    landed,
    ...(outcomeOf(e) && { on: landedOn(e) }),
    holding: holdingEvent(live, e),
  };
};
/** `owed` = passed, unverified and mattering (`calOwed` in src/ladder-run.ts) — `foldDates` keeps it shown. */
const calendarItem = (c: LadderCalendar, run: string): SignItem => ({ date: c.date, event: false, mark: c.verified ? "•" : "~", text: noted(c), detail: [...(c.matters && c.matters !== "—" ? [`matters: ${c.matters}`] : []), ...(c.verified ? [] : ["date unverified"])], landed: "", owed: c.date < run && !c.verified && c.matters !== "—" });
const signItems = (live: LadderLive, sign: string): SignItem[] =>
  [...allEvents(live).filter((e) => e.signs.includes(sign)).map((e) => eventItem(e, live)), ...(live.calendar ?? []).filter((c) => c.sign === sign).map((c) => calendarItem(c, live.run))].sort((a, b) => a.date.localeCompare(b.date));
/** The row's date chips: every event (a landed one keeps its outcome; 2+ settled ones fold, `foldLanded`), plus the next calendar row when it lands before the next non-dropped event — mirrored by `chipItems` in public/lab-reentry.js. */
const chipItems = (run: string, items: SignItem[]): SignItem[] => {
  const nextEvent = items.find((i) => i.event && i.landed !== "dropped" && i.date >= run);
  const nextCal = items.find((i) => !i.event && i.date >= run);
  return foldLanded(items.filter((i) => i.event || (i === nextCal && (!nextEvent || i.date < nextEvent.date))));
};
const chipText = (run: string, i: SignItem): string => i.fold ?? `${i.mark} ${i.date.slice(5)} ${i.landed || countdown(run, i.date)}`;
const itemText = (i: SignItem): string => `${i.mark} ${i.date} ${i.text}${i.detail.length ? ` — ${i.detail.join(" · ")}` : ""}`;
type SignRow = { s: LadderSign; group: 0 | 1 | 2 | 3; items: SignItem[]; chips: SignItem[] };
/** Signs in board order — lean group, then the soonest upcoming chip (none = last), then `signs[]` order — mirrored by `signRows` in public/lab-reentry.js. */
const signRows = (live: LadderLive): SignRow[] =>
  live.signs
    .map((s, i) => {
      const items = signItems(live, s.sign);
      const chips = chipItems(live.run, items);
      return { s, i, group: leanGroup(s.lean), items, chips, next: chips.find((c) => c.date >= live.run)?.date ?? "9999" };
    })
    .sort((a, b) => a.group - b.group || a.next.localeCompare(b.next) || a.i - b.i);
/** Events naming no `signs[]` row — kept as their own rows so a deciding event never drops off the board. */
const orphanEvents = (live: LadderLive): LadderEventDone[] => {
  const names = new Set(live.signs.map((s) => s.sign));
  return allEvents(live).filter((e) => !e.signs.some((n) => names.has(n)));
};
/** Calendar rows with no live sign row to sit under — mirrored by `loneCalendar` in public/lab-reentry.js. */
const loneCalendar = (live: LadderLive): SignItem[] => {
  const names = new Set(live.signs.map((s) => s.sign));
  return (live.calendar ?? []).filter((c) => !c.sign || !names.has(c.sign)).map((c) => calendarItem(c, live.run)).sort((a, b) => a.date.localeCompare(b.date));
};
const held = (run: string, s: LadderSign): string => (s.due && s.due > run ? `held → ${s.due.slice(5)}` : "—");
const dayGap = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 864e5);
export const newestSource = (s: LadderSign): string | undefined => s.sources.map((x) => x.date).sort().at(-1);
/** ` (+Nd)` — the finding's age (run − newest source) once that source predates the window; empty while fresh or unsourced. @internal */
export const findingAge = (run: string, s: LadderSign): string => {
  const newest = newestSource(s);
  return newest !== undefined && newest < sourceWindowStart(s, run) ? ` (+${dayGap(newest, run)}d)` : "";
};
/** Old non-holding landed items fold into one `history:` line ahead of the rest (`foldDates`) — mirrored by `foldedDd` in public/lab-reentry.js. */
const datesBlock = (run: string, items: SignItem[]): string[] => {
  const f = foldDates(run, items);
  return items.length ? ["- dates:", ...(f.history ? [`  - ${f.history.text}`] : []), ...f.shown.map((i) => `  - ${itemText(i)}`)] : ["- dates: —"];
};
/** R4: a `probe` row's finding is its live box reading (`boardReading`, [USER] 2026-11-10) — never its stored `finding`, no age, no `checked`/`due`/`sources`. */
const findingCell = (live: LadderLive, s: LadderSign): string => (s.probe ? boardReading(live.verdict, s.sign, true) : s.finding ? `${s.finding}${findingAge(live.run, s)}` : "—");
const signBlock = (live: LadderLive, r: SignRow): string[] => [
  `**${r.s.sign}** — ${labelAged(r.s.label, r.s.checked)}${!r.s.probe && r.s.checked ? ` · checked ${r.s.checked}` : ""}${!r.s.probe && r.s.due ? ` · due ${r.s.due}` : ""}`,
  `- why: ${r.s.why || "—"} (measurable: ${r.s.measurable || "—"})`,
  ...(r.s.base ? [`- base: ${r.s.base}`] : []),
  `- board: ${boardText(live.verdict, r.s.sign)}`,
  ...datesBlock(live.run, r.items),
  ...(r.s.probe ? [] : [`- sources: ${r.s.sources.length ? r.s.sources.map(sourceText).join(" · ") : "—"}`]),
  "",
];
/** Signs + deciding events as one board: the situation head + rules fold (`boardHead`), the tally + legend, a lean-sorted 5-col table (the `board` column = the family pointer, `boardText`), then each row's detail in the same order. */
const blockCell = (live: LadderLive, s: LadderSign, feet: Footer): string => {
  const c = deriveContract(s, allEvents(live), live.run);
  return c?.released ? ` · ${releasedText(c)}` : c ? ` · **BLOCK** ${blockSince(c, live.run)}[^${feet.n(liftsText(c))}]` : s.block ? " · **BLOCK**" : "";
};
const signsSection = (live: LadderLive, feet: Footer): string[] => {
  const rows = signRows(live);
  const orphans = orphanEvents(live);
  const lone = loneCalendar(live);
  if (!rows.length && !orphans.length && !lone.length) return [...boardHead(live), "_none_", ""];
  const tally = LEAN_NAME.map((n, g) => `${LEAN_GLYPH[g]}${rows.filter((r) => r.group === g).length} ${n}`).join(" · ");
  return [
    ...boardHead(live),
    `_${tally} — ${LEGEND}_`,
    "",
    ...table(
      ["lean", "sign", "finding", "board", "dates"],
      [
        ...rows.map((r) => [`${LEAN_GLYPH[r.group]} ${r.s.lean}${r.s.block || r.s.blocked ? blockCell(live, r.s, feet) : ""}`, r.s.sign, findingCell(live, r.s), boardText(live.verdict, r.s.sign), r.chips.length ? r.chips.map((c) => chipText(live.run, c)).join(" · ") : r.s.probe ? "—" : held(live.run, r.s)]),
        ...orphans.map((e) => ["·", eventItem(e, live).text, "event, no sign row", "—", chipText(live.run, eventItem(e, live))]),
      ],
    ),
    "",
    ...rows.flatMap((r) => signBlock(live, r)),
    ...orphans.flatMap((e) => [`**${eventItem(e, live).text}** — event, no sign row`, ...datesBlock(live.run, [eventItem(e, live)]), ""]),
    ...(lone.length ? ["**Dated, no sign**", ...lone.map((i) => `- ${itemText(i)}`), ""] : []),
  ];
};

/** `runAt` → `16:37 EEST` in `timeZone` (default: the process's own) — mirrored by `runTime` in public/lab-reentry.js. @internal */
export const runTime = (at: string, timeZone?: string): string =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short", timeZone }).format(new Date(at));

/** `## Blockers` between `## Verdict` and `## Grid`: one OPEN `<details>`; per tranche a head line (`**T2** close · live`), then — unless filled — one `- leg — close · live` line
 *  per unmet row (`blockers`, `LEGS[leg].naGateHolds`), the indented box line when the box holds, and a closed fold (`foldText`) of the passing + unread rows. */
const blockersSection = (v: LadderVerdict, L: (typeof LEGS)[LadderLegId]): string[] => {
  const b = blockers(v, { naGateHolds: L.naGateHolds });
  const line = (l: Leg): string => `- ${l.leg} — ${reading(l)} · live ${reading(l.live)}`;
  return [
    "## Blockers",
    "",
    `<details open><summary>${blockersSummary(b)}</summary>`,
    "",
    ...(b.held ? [HELD_NOTE, ""] : []),
    ...b.tranches.flatMap((t) => [
      `**${t.id}** ${trancheCell(t.close)} · live ${t.live ? trancheCell(t.live) : "—"}`,
      ...(t.filled
        ? [""]
        : [
            ...t.unmet.map(line),
            ...(t.box.holds ? [`  - ${boxHoldsText(t.box)}`] : []),
            "",
            `<details><summary>${foldText(t)}</summary>`,
            "",
            ...t.passing.map(line),
            ...t.unread.map(line),
            "",
            "</details>",
            "",
          ]),
    ]),
    "</details>",
    "",
  ];
};

/** `## Grid` after `## Blockers`: one closed `<details>` holding the 5-column `indicator × job` table (`gridRows`) + the series footnote and the job legend — the empty-state line, naming the leg's `--into` run, until the stored JSON carries tags. */
const gridSection = (v: LadderVerdict, L: (typeof LEGS)[LadderLegId]): string[] => {
  const g = gridRows(v);
  return [
    "## Grid",
    "",
    "<details><summary>Grid — one row per indicator × job</summary>",
    "",
    ...(g.untagged ? [`_no read tags yet — run \`npm run ${L.probe} -- --into=${L.json}\`_`] : [...table(["indicator", "job", ...TRANCHE_IDS], g.rows.map((r) => [r.indicator, jobText(r), ...TRANCHE_IDS.map((t) => r.cells[t])])), ...[seriesNote(g), JOB_LEGEND].filter(Boolean).flatMap((n) => ["", `_${n}_`])]),
    "",
    "</details>",
    "",
  ];
};

/** `## Drawdown watch` before `## Verdict`: `watchHead`, the 5-col graded `watchRows` table, then `WATCH_CONTEXT_NOTE` + the `watchContextRows` table when any, the stored grades of the last 5 runs —
 *  mirrored by `watchBlock` in public/lab-reentry.js, except the grade history (md-only; /lab has none). */
const watchSection = (live: LadderLive, v: LadderVerdict): string[] => {
  const grades = live.runs.slice(0, 5).filter((r) => r.watch);
  const ctx = watchContextRows(v);
  const tbl = (rows: string[][]): string[] => ((t) => table(t.head, t.rows))(watchTable(rows));
  return [
    "## Drawdown watch", "", watchHead(v), "", ...tbl(watchRows(v)), "",
    ...(ctx.length ? [`_${WATCH_CONTEXT_NOTE}_`, "", ...tbl(ctx), ""] : []),
    ...(grades.length ? [`_grades, last 5 runs: ${grades.map((r) => `${mmdd(r.date)} ${r.watch}`).join(" · ")}_`, ""] : []),
  ];
};

/** `LEGS[leg].md`, whole: title + run · Drawdown watch when `verdict.watch` · Verdict (+ criteria detail, last 5 runs) · Blockers · Grid · Episode gates when `escalation.clusters` · Signs & deciding events · `[^n]:` footnotes — deterministic for a given `timeZone`, pure, no table wider than 5 columns but the 6-column cluster table. */
export function renderLadderMd(live: LadderLive, leg: LadderLegId, timeZone: string = DEFAULT_LADDER_TZ): string {
  const L = LEGS[leg];
  const v = live.verdict;
  const feet = footer();
  const verdict = v
    ? [
        ...table(["tranche", ...heads(v, v.prov ? "live (prov.)" : "live")], v.tranches.map((t, i) => [t.id, trancheCell(t), v.live[i] ? trancheCell(v.live[i]) : "—"])),
        "",
        `regime: **${v.regime.set}** set${v.regime.exshVsMa200 === undefined ? "" : ` · EXSH ${gapText(v.regime.exshVsMa200)} vs MA200`}`,
        "",
        ...(v.display ? [displayText(v.display), ""] : []),
        ...((h) => (h ? [`**Holding now** — ${h}`, ""] : []))(holdingNow(live)),
        `**Deciding in the next 7 days** — ${decidingWeek(live)}`,
        "",
        `**Other events in the next 7 days** — ${otherWeek(live)}`,
        "",
        ...criteria(v, feet),
      ]
    : [`_no verdict yet — run \`npm run ${L.probe} -- --into=${L.json}\`_`];
  const runs = live.runs.length ? ["_last 5 runs_", "", ...table(["date", "T1", "T2", "T3", "live"], live.runs.slice(0, 5).map((r) => [r.date, r.t1, r.t2, r.t3, r.live])), ""] : [];
  const out = [
    `# ${L.title}`,
    "",
    `run ${live.run}${live.runAt ? ` ${runTime(live.runAt, timeZone)}` : ""} · rendered from \`${L.json}\` — never hand-edit; writer: \`${L.skill}\``,
    "",
    ...(v?.watch ? watchSection(live, v) : []),
    "## Verdict",
    "",
    ...verdict,
    "",
    ...runs,
    ...(live.verdict ? [...blockersSection(live.verdict, L), ...gridSection(live.verdict, L)] : []),
    ...(live.verdict ? episodeGates(live.verdict) : []),
    "## Signs & deciding events",
    "",
    ...signsSection(live, feet),
    ...feet.all().flatMap(([t, n]) => [`[^${n}]: ${t}`, ""]),
  ];
  return out.join("\n");
}
/** The EU-Fin renderer, as its importers call it. */
