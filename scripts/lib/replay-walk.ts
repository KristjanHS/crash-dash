/**
 * The probes' shared per-close replay walk.
 *
 * Fifteen files carried a near-identical ~30-line block: fetch every member series → abort
 * loud on a swallowed fetch failure → build the F4 trading-day axis → walk it with a
 * forward-fill cursor. This module is that block, once. (Fourteen were `scripts/probe-*.ts`;
 * the fifteenth is `scripts/backtest/g4-mode-study.ts`, so a `probe-*` glob under-counts.)
 *
 * ⚠ **Measure the remaining set by BODY SHAPE, never by an export name or an import.** A
 * name-based grep once declared a batch of this rewire empty while four sites existed under
 * local names. The block has two halves; grep for each, drop this module's own adopters:
 *
 *     { grep -rlF --include=*.ts 'while (i + 1 < pts.length' scripts/;
 *       grep -rlF --include=*.ts 'fetchFailed' scripts/; } | grep -v '^scripts/lib/' | sort -u \
 *       | comm -23 - <(grep -rlF --include=*.ts 'lib/replay-walk.js' scripts/ | sort -u)
 *
 * → **0 files** (2026-08-02, after the carriers round slice 2 — the set is DRAINED). The original
 * fifteen were ALL rewired by Stage 3.C-3, leaving two hits that were never in that count at all — the
 * same forward-fill cursor shape under local names. Both adopted `loadSeries` / `calendarFrom` /
 * `makeCursor`: `scripts/backfill/leg-pillar-walk.ts` in slice 1,
 * `scripts/archive/stage1c-pillar-replay.ts` (which also took `selectReplayDates`) in slice 2.
 *
 * ⚠ **Zero here is a drained set, not a broken grep** — check that before trusting it. The first half
 * still returns 2 raw hits (this module and `backtest/g4-mode-study.ts`, whose `legWindow` per-leg trailing
 * slice is a deliberate NON-member, not the member walk) and the second still returns 1
 * (this module); the `grep -v '^scripts/lib/'` and the `comm -23` against the adopter list are what
 * carry it to zero. If BOTH halves ever go empty pre-drop, the grep strings have rotted and the
 * predicate is vacuous — re-derive them from the block's current body, don't report the zero.
 *
 * ⚠ The older `grep -rl FFILL_MAX_CALENDAR_DAYS` falsifier is a PROXY, not this predicate: a
 * rewired caller that keeps the constant for its own use still matches, and a caller that inlined the
 * horizon literal would not. It reads 5 today
 * (`grep -rl FFILL_MAX_CALENDAR_DAYS --include=*.ts scripts/`, this module excluded): three in code or
 * docblock prose (`probe-leader-split`, `probe-member-contribution`, `probe-is7-diffusion-replay`;
 * a fourth, `probe-r4-arming`, was retired 2026-09-05 (token-efficiency round 3 B4; git history keeps it)) plus the two carriers-round SEAM comments that name the constant while
 * declining the horizon (`backfill/leg-pillar-walk.ts`, `archive/stage1c-pillar-replay.ts`). That is
 * SIX more than the real predicate, over a disjoint set — the proxy now moves in the opposite
 * direction from it (adopting the helpers ADDS a SEAM mention). Never read one as corroborating the other.
 *
 * ⚠ **This is NOT `src/replay.ts`'s `computeReplay`, and must not become it.** The probes
 * hand-roll the loop deliberately: `ReplayPoint` exposes only
 * `{date, targetRung, band, regime, r4Phase, cash, reentryRung}`, while the probes need
 * `positionP` / `leadingP` / the numeric `band.{lo,hi}` / continuous `rung` — the exact terms
 * the patches under test move. What IS imported from production stays imported
 * (`FFILL_MAX_CALENDAR_DAYS` here; the dial itself at each call site).
 *
 * ⚠ **Nothing measurement-bearing belongs here.** An A/B probe's control arm and every cut a
 * slice may retune stay in-probe as literals — a shared module that a retune silently re-bases
 * is precisely an A/A collapse. This module owns
 * the *plumbing* (fetch, axis, cursor), never the *comparison*.
 *
 * ## The four structural seams (widened 2026-08-02, Stage 3.0 — all optional, defaults unmoved)
 *
 * A survey of the 15 probes still carrying the inline block found none of them a clean swap;
 * each diverges structurally. The seams below make those shapes expressible **without moving a
 * single measurement decision in here**:
 *
 * 1. **Calendar axis.** `calendarFrom(seriesById, axisId)` still defaults to `DEFAULT_AXIS_ID`
 *    (F4), so existing semantics are the default; pass any id for a per-leg axis (a leg's own
 *    closes), or use `unionCalendar` for the union of every member's observation dates. An
 *    axis that does not come from the store at all (a fixture such as `acwi.csv`) needs no
 *    export here: `selectReplayDates` and `walkReplay` both take a plain `string[]`, so the
 *    caller maps its own rows to dates and hands them straight in.
 * 2. **Pluggable fetch.** `loadSeriesWith(fetchSeries, ids, opts)` takes any per-id async read
 *    — a `getSeriesBulk` round-trip served from a pre-filled map, a probe's own fetch — and
 *    keeps the fail-loud ABORT verbatim. `loadSeries(store, ids, span)` is now a thin wrapper
 *    over it, unchanged for its callers.
 * 3. **Vintage truncation.** `opts.asOf` drops every point after that date as the series is
 *    loaded, so a point-in-time replay forward-fills from vintage data only. It is a date
 *    filter and nothing more — the *choice* of anchor, and any counterfactual arm that removes
 *    the truncation, stay in the probe.
 * 4. **Caller-threaded walk state.** `walkReplay` owns only the cursor and the ascending walk;
 *    the per-close body is the caller's closure and the fold state `S` is the caller's type.
 *    Path-dependent per-arm state (prevTarget hysteresis, clamp carry, two arms folded side by
 *    side) lives in that `S`, in the probe, where a retune can move it.
 *
 * ## The fifth seam: the single-date panel (widened 2026-08-02, Stage 3.B-0)
 *
 * Three probes evaluate at a FIXED anchor date and then inspect — there is no calendar walk for
 * `walkReplay` to own — yet each hand-rolled the same coupling of a forward-filled reading set
 * with each present member's trailing history slice. `panelAt` is that pair, once: the
 * `{ readings, cissHistory }` shape `computeFamilyPanel` and `computeField` consume together.
 * All three adopted it in Stage 3.B-2 (`probe-absence-field`, `probe-leg-ordering`,
 * `probe-member-contribution`), each carrying a `// SEAM (Stage 3.B-2)` line saying the walk fold
 * does not apply. Stage 3.C-1 added a second usage shape: `probe-drawdown-bite` and
 * `probe-drawdown-clamp-2022` keep their OWN ascending loop (fixture axis + `prevHeld` hysteresis) and
 * call `panelAt` per close through one shared `makeCursor` — legal because their dates are
 * non-decreasing, and the reason the `cursor` option exists. `probe-member-contribution` keeps its own `nearestBefore` — a wrapper over the
 * shared `makeCursor`, threaded back in as `opts.cursor` — because its attribution table needs a
 * nearest-before pick for members the horizon EXCLUDES, which is not panel assembly.
 *
 * ⚠ The slice LENGTH is a required option, deliberately un-defaulted. Every caller today passes
 * `MEMBER_WINDOW + MEMBER_HISTORY_PAD` (the pad hand-mirrored in-probe). The production values this
 * file imports are `FFILL_MAX_CALENDAR_DAYS` and `MEMBER_HISTORY_WINDOW`.
 *
 * What `panelAt` does NOT carry, and what therefore stays in-probe as a literal: the seated-member
 * baseline (`EUFIN_SEATED_KEYS`, `probe-leg-ordering`), the state-severity map (`STATE_SEV`,
 * `probe-member-contribution`), every member relevance/weight mutation table, and the anchor-date
 * aborts each probe words for its own verdict. It assembles a panel; it decides nothing.
 *
 * What deliberately did NOT arrive with these seams: R4 state machines, decision gates
 * (`decideRotationHold` / `decideNotify` / band folding), per-member attribution, and **every
 * control-arm constant or retunable cut** — those stay in-probe literals. If a caller can only
 * fit by importing such a value from here, that fragment stays inline.
 */
import { FFILL_MAX_CALENDAR_DAYS } from "../../src/replay.js";
import { MEMBER_HISTORY_WINDOW } from "../../src/danger-member-state.js";
import type { SeriesPoint, Store } from "../../src/store.js";
import type { State } from "../../src/domain-types.js";

export const MS_PER_CALENDAR_DAY = 86_400_000;

/** The axis id every probe walks: F4 daily closes (deepest trading-day cadence). */
export const DEFAULT_AXIS_ID = "F4";

/** stage1c's calendar-headroom margin: the store must reach PAST the window, not just to it. */
export const CALENDAR_MARGIN = 30;

/** src's member-history fetch window (`MEMBER_HISTORY_WINDOW`), imported — never a mirrored literal. */
export const MEMBER_WINDOW = MEMBER_HISTORY_WINDOW;

export interface Coverage {
  id: string;
  firstDate: string | null;
  lastDate: string | null;
  points: number;
}

/**
 * Fetch every id in parallel, then ABORT if any read threw.
 *
 * The fail-loud is load-bearing, not defensive dressing: a member that silently resolves to
 * `[]` is absent for EVERY date, which can drop its family out of `computeFamilyPanel`'s
 * worst-of and move `positionP` — the quantity under measurement. Because A/B arms run as
 * separate processes, a failure in one arm only would skew the diff invisibly.
 *
 * (Empty-but-SUCCEEDED is a different case: that is genuine store state, and it is reported by
 * `coverageOf` rather than aborted on.)
 *
 * READ-ONLY: `getSeries` selects only — never insert/update/delete/upsert.
 */
export async function loadSeries(
  store: Pick<Store, "getSeries">,
  ids: readonly string[],
  span: number,
  opts: LoadOptions = {},
): Promise<Map<string, SeriesPoint[]>> {
  return loadSeriesWith((id) => store.getSeries(id, span), ids, opts);
}

export interface LoadOptions {
  /**
   * Point-in-time truncation: keep only points with `date <= asOf`, so the walk forward-fills
   * from vintage data. A plain date filter — which anchor to replay, and whether to run an arm
   * WITHOUT the truncation, are the probe's decisions and stay there.
   */
  asOf?: string | undefined;
  /** The ABORT seams — default the console and the process; a test passes its own. */
  log?: (msg: string) => void;
  exit?: (code: number) => never;
}

/**
 * `loadSeries` with the read injected — same parallel fetch, same fail-loud ABORT (same text).
 *
 * For callers whose read is not `store.getSeries(id, span)`: a single `getSeriesBulk`
 * round-trip resolved per id, a fixture-backed read, a vintage view. `fetchSeries` MUST reject
 * (not resolve to `[]`) on failure — the abort exists because a silently-empty member is absent
 * for every date and moves the quantity under measurement, invisibly and in one arm only.
 *
 * READ-ONLY by contract: pass a select-only read.
 */
export async function loadSeriesWith(
  fetchSeries: (id: string) => Promise<SeriesPoint[]>,
  ids: readonly string[],
  opts: LoadOptions = {},
): Promise<Map<string, SeriesPoint[]>> {
  const seriesById = new Map<string, SeriesPoint[]>();
  const fetchFailed: string[] = [];
  await Promise.all(
    ids.map(async (id) => {
      const pts = await fetchSeries(id).catch((e: unknown) => {
        fetchFailed.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
        return [] as SeriesPoint[];
      });
      seriesById.set(id, opts.asOf === undefined ? pts : pts.filter((p) => p.date <= opts.asOf!));
    }),
  );
  if (fetchFailed.length > 0) {
    const { log = console.log, exit = (code: number): never => process.exit(code) } = opts;
    log(
      `ABORT: ${fetchFailed.length} member fetch(es) FAILED — a measurement over a partial panel is ` +
        `not comparable across arms. Re-run.\n    ${fetchFailed.join("\n    ")}`,
    );
    exit(1);
  }
  return seriesById;
}

export const coverageOf = (
  seriesById: ReadonlyMap<string, SeriesPoint[]>,
  ids: readonly string[],
): Coverage[] =>
  ids.map((id) => {
    const pts = seriesById.get(id) ?? [];
    return {
      id,
      firstDate: pts[0]?.date ?? null,
      lastDate: pts.at(-1)?.date ?? null,
      points: pts.length,
    };
  });

/** The `ID  N rows  first → last` block, byte-for-byte as the probes printed it. */
export function printCoverage(coverage: readonly Coverage[]): void {
  for (const c of coverage) {
    console.log(
      `    ${c.id.padEnd(8)} ${String(c.points).padStart(6)} rows   ` +
        `${c.firstDate ?? "—"} → ${c.lastDate ?? "—"}`,
    );
  }
}

/**
 * A monotonic per-id forward-fill cursor: `advance(id, date)` returns the index of the newest
 * point at or before `date`, or `-1` before the series starts.
 *
 * Monotonic by construction — each id's pointer only moves forward — so callers MUST walk
 * dates in ascending order. Walking backwards silently returns a stale index.
 */
export function makeCursor(
  seriesById: ReadonlyMap<string, SeriesPoint[]>,
): (id: string, d: string) => number {
  const ptr = new Map<string, number>();
  return (id: string, d: string): number => {
    const pts = seriesById.get(id) ?? [];
    let i = ptr.get(id) ?? -1;
    while (i + 1 < pts.length && pts[i + 1]!.date <= d) i++;
    ptr.set(id, i);
    return i;
  };
}

/**
 * The replay axis.
 *
 * ⚠ This axis DIFFERS from `computeReplay`'s, which iterates the UNION of all members'
 * observation dates. Deliberate — a trading-day axis is the better proxy for a daily cron —
 * but it means absolute rates are per-F4-trading-day, not per-`computeReplay`-point.
 */
export const calendarFrom = (
  seriesById: ReadonlyMap<string, SeriesPoint[]>,
  axisId: string = DEFAULT_AXIS_ID,
): string[] => (seriesById.get(axisId) ?? []).map((p) => p.date);

/**
 * The UNION of every member's observation dates, ascending and de-duplicated — the axis
 * `computeReplay` uses, for probes that need every point at which anything moved rather than
 * one series' trading days.
 *
 * `ids` defaults to every key present in `seriesById`.
 */
export const unionCalendar = (
  seriesById: ReadonlyMap<string, SeriesPoint[]>,
  ids: readonly string[] = [...seriesById.keys()],
): string[] => {
  const dates = new Set<string>();
  for (const id of ids) for (const p of seriesById.get(id) ?? []) dates.add(p.date);
  return [...dates].sort();
};

export interface ReplayWindow {
  calendar: readonly string[];
  replayN: number;
  fromArg?: string | undefined;
  toArg?: string | undefined;
  margin?: number;
  axisId?: string;
}

/**
 * The last `replayN` closes, narrowed by `--from`/`--to`, with the three no-silent-truncation
 * aborts the probes each spelled out (with trivially drifted wording — unified here on the
 * most informative variant).
 */
export function selectReplayDates({
  calendar,
  replayN,
  fromArg,
  toArg,
  margin = CALENDAR_MARGIN,
  axisId = DEFAULT_AXIS_ID,
}: ReplayWindow): string[] {
  if (calendar.length < replayN + margin) {
    console.log(
      `ABORT: calendar too short (${calendar.length} ${axisId} closes for --closes=${replayN}) — is ` +
        `this the backfilled store? Achievable max --closes here is ` +
        `${Math.max(0, calendar.length - margin)} ` +
        `(${calendar.length} closes minus the ${margin}-close warm-up margin).`,
    );
    process.exit(1);
  }

  let replayDates = calendar.slice(-replayN);
  if (fromArg) replayDates = replayDates.filter((d) => d >= fromArg);
  if (toArg) replayDates = replayDates.filter((d) => d <= toArg);

  if (replayDates.length === 0) {
    console.log(
      `ABORT: the --from=${fromArg ?? "—"}/--to=${toArg ?? "—"} window selects 0 of the last ` +
        `${replayN} closes (${calendar.at(-replayN)} → ${calendar.at(-1)}). Widen --closes.`,
    );
    process.exit(1);
  }
  if (fromArg && replayDates[0]! > fromArg) {
    console.log(
      `ABORT: calendar too short for --from=${fromArg} — the last ${replayN} closes start at ` +
        `${replayDates[0]}. Re-run with a larger --closes (calendar has ${calendar.length} closes, ` +
        `first ${calendar[0]}).`,
    );
    process.exit(1);
  }
  return replayDates;
}

/**
 * The forward-filled reading set at one close.
 *
 * The horizon is INCLUSIVE, matching `replay.ts`: a gap exactly equal to
 * `FFILL_MAX_CALENDAR_DAYS` still fills; only a strictly larger one drops.
 */
export function ffillReadings(
  seriesById: ReadonlyMap<string, SeriesPoint[]>,
  cursor: (id: string, d: string) => number,
  ids: readonly string[],
  d: string,
  horizon: number = FFILL_MAX_CALENDAR_DAYS,
): { id: string; state: State }[] {
  const readings: { id: string; state: State }[] = [];
  for (const id of ids) {
    const i = cursor(id, d);
    if (i < 0) continue;
    const p = seriesById.get(id)![i]!;
    const gapDays = Math.floor((Date.parse(d) - Date.parse(p.date)) / MS_PER_CALENDAR_DAY);
    if (gapDays <= horizon) readings.push({ id, state: p.state });
  }
  return readings;
}

/** The replay harness keeps FULL points in its history slices (the F11 probe restates `rawState`/
 *  `delta20` per arm and the tests assert `date`s); structurally assignable to the engine's
 *  state-only `MemberHistoryEntry`, so `computeField` consumes it unchanged. */
export type FullMemberHistoryEntry = { id: string; history: SeriesPoint[] };

/** The pair `computeFamilyPanel` / `computeField` consume at one close. */
export interface Panel {
  /** Identical to `ffillReadings(seriesById, cursor, ids, d, horizon)` — same members, same order. */
  readings: { id: string; state: State }[];
  /** One entry per PRESENT member (absent members are omitted from both lists, not nulled). */
  cissHistory: FullMemberHistoryEntry[];
}

export interface PanelOptions {
  /**
   * Points to keep in each present member's history slice, ending at (and including) the
   * forward-filled point.
   *
   * REQUIRED on purpose. Its callers all pass `MEMBER_WINDOW + MEMBER_HISTORY_PAD`; the pad mirrors a
   * private `dial-assembly.ts` constant, so the expression stays at the call site.
   */
  historyLen: number;
  horizon?: number;
  /**
   * Share a cursor across id sets — or across `panelAt` calls, under ONE invariant: **`d` must be
   * non-decreasing across every call sharing the cursor.** Pointers are monotonic (`makeCursor`), so a
   * shared cursor called at a DESCENDING date returns the stale index parked at the later date — it
   * forward-fills from the future, silently, with no throw and no empty result. Anchor probes that
   * evaluate at unordered dates must NOT share one.
   *
   * This is a **parameter default**, re-evaluated per call: omitting `cursor` always yields a fresh
   * full scan, which is what makes the unordered-anchor case safe by default (`probe-absence-field`).
   *
   * (`WalkOptions.cursor` states the adjacent, different hazard: reuse across two sequential walks.)
   */
  cursor?: (id: string, d: string) => number;
}

/**
 * The panel at ONE date: the forward-filled reading set plus each present member's trailing
 * history slice, assembled in a single pass.
 *
 * For probes that evaluate at a fixed anchor rather than walking a calendar — there is no fold for
 * `walkReplay` to own, but the panel assembly is the same every time. Also for a probe that keeps its
 * own ascending loop and needs `readings` and `cissHistory` together at each close: pass one shared
 * `cursor` (see `PanelOptions.cursor`). Presence is decided exactly
 * as `ffillReadings` decides it (inclusive horizon), so `readings` is that function's output and a
 * member dropped by the horizon appears in NEITHER list.
 *
 * The slice runs `[i + 1 - historyLen, i + 1)` over the member's own points, so it ends at the
 * forward-filled point and never reaches past `d` — a shorter-than-`historyLen` member yields a
 * shorter slice rather than being padded (the signal hold reads depth off that length).
 *
 * Assembly only: which members to pass, which anchor to evaluate, and what to conclude are the
 * probe's, along with every seated-member baseline, severity map and weight table.
 */
export function panelAt(
  seriesById: ReadonlyMap<string, SeriesPoint[]>,
  ids: readonly string[],
  d: string,
  {
    historyLen,
    horizon = FFILL_MAX_CALENDAR_DAYS,
    cursor = makeCursor(seriesById),
  }: PanelOptions,
): Panel {
  const readings: { id: string; state: State }[] = [];
  const cissHistory: FullMemberHistoryEntry[] = [];
  for (const id of ids) {
    const i = cursor(id, d);
    if (i < 0) continue;
    const pts = seriesById.get(id)!;
    const p = pts[i]!;
    const gapDays = Math.floor((Date.parse(d) - Date.parse(p.date)) / MS_PER_CALENDAR_DAY);
    if (gapDays > horizon) continue;
    readings.push({ id, state: p.state });
    cissHistory.push({ id, history: pts.slice(Math.max(0, i + 1 - historyLen), i + 1) });
  }
  return { readings, cissHistory };
}

export interface WalkClose<S> {
  /** The close being replayed. */
  date: string;
  /** Its 0-based position in `dates`. */
  index: number;
  /** The forward-filled reading set at `date` — `ffillReadings`, unchanged. */
  readings: { id: string; state: State }[];
  /** Whatever the previous close returned (`initial` on the first one). */
  state: S;
}

export interface WalkOptions<S> {
  dates: readonly string[];
  seriesById: ReadonlyMap<string, SeriesPoint[]>;
  /** Members to forward-fill at each close. */
  ids: readonly string[];
  /** The fold seed. */
  initial: S;
  /** The per-close body; its return value becomes the next close's `state`. */
  onClose: (close: WalkClose<S>) => S | Promise<S>;
  horizon?: number;
  /**
   * Supply your own cursor when a second id set must be forward-filled on the SAME closes.
   *
   * Supported usage — build the cursor with `makeCursor(seriesById)`, pass it here, and call
   * `ffillReadings(seriesById, cursor, setB, date)` **inside `onClose`**, so both sets advance
   * on the same date within one ascending pass.
   *
   * ⚠ **Never reuse a cursor across two sequential `walkReplay` calls.** Pointers are monotonic
   * per id (`makeCursor`): the second walk restarts at the earliest date with every pointer
   * already parked at the series end, so it forward-fills from the FUTURE. There is no throw
   * and no empty result — it only misbehaves where the two id sets overlap, so it is
   * intermittent. Two sequential walks each get their own cursor (omit this option).
   */
  cursor?: (id: string, d: string) => number;
}

/**
 * The ascending per-close walk, with the caller's own state folded through it.
 *
 * This module owns the cursor and the iteration order ONLY. `onClose` is the probe's body and
 * `S` is the probe's type, so path-dependent per-arm state (prevTarget hysteresis, a clamp
 * carry, two arms folded side by side in one object) stays in the probe where a retune can
 * move it. Nothing is decided here.
 *
 * Strictly sequential and `await`ed per close — a path-dependent fold cannot be parallelised,
 * and `makeCursor` is monotonic, so `dates` MUST be ascending.
 */
export async function walkReplay<S>({
  dates,
  seriesById,
  ids,
  initial,
  onClose,
  horizon = FFILL_MAX_CALENDAR_DAYS,
  cursor = makeCursor(seriesById),
}: WalkOptions<S>): Promise<S> {
  let state = initial;
  for (const [index, date] of dates.entries()) {
    const readings = ffillReadings(seriesById, cursor, ids, date, horizon);
    state = await onClose({ date, index, readings, state });
  }
  return state;
}
