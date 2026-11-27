/**
 * Shared T1 dial assembly — the ONE place the panel→carry→tech-confirmer→dial(→member history)
 * pipeline lives, consumed by BOTH the notify path (`src/run-cycle-dial.ts` cron) and `/api/lab`'s
 * live path. Before this seam existed the two hand-mirrored the same steps and only a
 * comment held the "dial band IS the notify band" invariant — divergence meant notifying
 * a band /lab never showed (the worst trust failure available; audit rank 9 / Evol-B1/B2).
 *
 * Everything here is the SAME logic both call sites used verbatim; the only per-caller
 * difference is the degrade/console side-effects, which stay OUT of this function:
 *   - the cron path records degrade events (dropped families, missing tech members) and
 *     logs carried families — it reads them off the returned `carried`/`dropped`/
 *     `lastKnownFamily` and passes an `onMissingTechMember` callback;
 *   - /api/lab is read-only and passes neither, so it gets identical VALUES with no writes.
 *
 * Store IO only (getSeries for the rank-7 family-carry last-known reads + the member-history
 * window: hold / regime / ROC). Pure derivation lives in families.ts / t1dial.ts / danger-engine.ts.
 */
import {
  computeFamilyPanel,
  applyFamilyCarry,
  tradingDaysBetween,
  CARRY_MAX_TRADING_DAYS,
  GLOBAL_FAMILIES,
  type FamilyDef,
  type FamilyKey,
  type FamilyPanel,
  type LastKnownFamily,
} from "./families.js";
import { computeT1Dial, earlyWarnFires, techConfirmerBreadth, techConfirmerFromPanel, type T1DialResult } from "./t1dial.js";

import type { MemberHistoryEntry, MemberStateMap } from "./danger-engine.js";
import { MEMBER_HISTORY_WINDOW, buildMemberState, buildMemberStateHeld, noHoldDepth } from "./danger-member-state.js";
import { DIAL_FAMILIES } from "./danger-ladder.js";
import { ALL_INDICATORS } from "./registry.js";
import { slotLag } from "./release-delay.js";
import { errMsg } from "./err-msg.js";
import { STATE_RANK, type State } from "./domain-types.js";
import type { Store, SeriesPoint } from "./store.js";
import { ESTIMATE_OVER_READ, getObservedSeries, isObservation, notifyObservationOn, keptRows, type RowKeep } from "./estimated.js";

// Leading history fetched beyond `MEMBER_HISTORY_WINDOW` so each member's lookback settles at the left
// edge; matches api/lab.ts's LOOKBACK_PAD (30).
const MEMBER_HISTORY_PAD = 30;

/** The member-history bulk read's whole-call failure — every member reads short ⇒ signal hold off. */
export type CissReadError = (ids: readonly string[], err: unknown) => void;
export const warnCissRead: CissReadError = (ids, err) =>
  console.warn(`[ciss] ${ids.length}-member history bulk read failed - signal hold off: ${errMsg(err)}`);

/**
 * Per-member history window (`MEMBER_HISTORY_WINDOW` + pad) feeding `computeField`'s signal hold, regime
 * fold and speed arrows; /api/lab's scenario path reads the SAME window so scenario↔live parity holds.
 * One `getSeriesBulk` wave; a missing id is an empty bucket, a whole-call failure an empty map — never aborts.
 */
export async function fetchCissHistory(
  store: Pick<Store, "getSeriesBulk">,
  panel: FamilyPanel[],
  keepRow: RowKeep = isObservation,
  onReadFail: CissReadError = warnCissRead,
): Promise<MemberHistoryEntry[]> {
  const ids = [...new Set(panel.flatMap((f) => f.members.map((m) => m.id)))];
  // `estimated` rows fold, ECY's open month too; E25 drops
  // `carried` ones — the over-read keeps the window full.
  const bulk = await store
    .getSeriesBulk(ids, { limit: MEMBER_HISTORY_WINDOW + MEMBER_HISTORY_PAD + ESTIMATE_OVER_READ })
    .catch((err: unknown) => {
      onReadFail(ids, err);
      return new Map<string, SeriesPoint[]>();
    });
  const keep = (id: string, h: SeriesPoint[]): SeriesPoint[] => keptRows(id, h, keepRow).slice(-(MEMBER_HISTORY_WINDOW + MEMBER_HISTORY_PAD));
  return ids.map((id) => ({ id, history: keep(id, bulk.get(id) ?? []) }));
}

/**
 * `DIAL_FAMILIES` — GLOBAL_FAMILIES as the DIAL sees it (B-11, ruled 2026-07-20). The definition
 * + its full rationale moved to `danger-ladder.ts` in Stage 2.1 so `FAMILY_MEMBERS` could derive
 * from the same table without importing this module (which would close a runtime cycle
 * danger-ladder → dial-assembly → danger-engine → danger-ladder). `families.ts` could not host it
 * either — see the ⚠ note there. This re-export keeps every existing importer of
 * `dial-assembly.js` working unchanged.
 */
export { DIAL_FAMILIES };

/**
 * The four `assembleDial` fields the live `/api/lab` read path consumes, persisted whole into
 * `alert_log.panel_state` (jsonb) so that path serves them off the row instead of re-running
 * `assembleDial` (§7 Stage C′). Written at the SAME site as `dial_state` (`store.recordRun`), so the
 * panel can never carry a different vintage than the dial it accompanies. All plain data — JSON-safe.
 */
export interface PersistedPanel {
  globalPanel: FamilyPanel[];
  displayPanel: FamilyPanel[];
  cissHistory: MemberHistoryEntry[];
  heldMemberState: MemberStateMap;
}

/**
 * The result of one dial assembly.
 *
 * `globalPanel` is the CARRIED **DIAL_FAMILIES** panel (the exact `.families` fed to
 * `computeT1Dial`), reused downstream by the danger field + notification — the NOTIFY axis.
 *
 * `displayPanel` is the same reduction against the full `GLOBAL_FAMILIES` table — the DISPLAY
 * axis, served by /api/lab as `globalFamilies` and rendered as /lab's board tiles, ledger member
 * chips and replay member lists. B-11's ruling is display-ONLY membership for the SLOW legs: they
 * must still RENDER, so the board cannot be fed the dial panel (that would silently delete
 * `price-accel` + the three `complacency-*` from the Volatility tile and orphan their help copy).
 * Every caller passes the SLOW legs (cron + re-derive append the slow track's rows, /lab's fallback
 * reads the whole persisted run); without them this panel serves the four as absent.
 *
 * `carried`/`dropped`/`lastKnownFamily` are the rank-7 carry bookkeeping the caller turns
 * into its own side-effects (cron: degrade events + logs; lab: ignored) — reported for the DIAL
 * panel, the axis those degrade events describe.
 */
interface DialAssembly {
  globalPanel: FamilyPanel[];
  displayPanel: FamilyPanel[];
  dial: T1DialResult;
  cissHistory: MemberHistoryEntry[];
  /**
   * The very member map this run's tech confirmer read (`selectMemberStateMap`) — returned, not
   * re-derivable: `/api/lab`'s legacy null-`dialState` arm recomputes the confirmer and must feed it
   * THIS object, so its chip can never run on a different clock from the cron's. Additive — every
   * existing caller destructures, so nothing breaks by its presence.
   */
  heldMemberState: MemberStateMap;
  carried: FamilyKey[];
  dropped: FamilyKey[];
  lastKnownFamily: Partial<Record<FamilyKey, LastKnownFamily>>;
  /** MEMBER-level carry (distinct from the family-level `carried` above): absent roster members whose
   *  last persisted close is within their OWN `lagCutFor`, re-injected into the fold with that state.
   *  Empty unless the caller passed `carryLagCutById`. Consumed by the `[coverage]` emitter to mark
   *  them `reason: "carried"`. */
  carriedMembers: CarriedMember[];
}

/** One absent roster member carried back into the fold on its own last persisted close. `date` is the
 *  close's observation date; `ageDays` its age against `asOf` — publication slots for daily/weekly,
 *  calendar days otherwise, resolved through `ageOf`/`resolveFreshness` (≤ the cut). */
interface CarriedMember {
  id: string;
  state: State;
  date: string;
  ageDays: number;
}

/**
 * THE member-map selection for the tech confirmer — the held member state at t (`SIGNAL_HOLD_CLOSES` applied
 * at depth 0) on a store with depth, the engine's unheld fallback on a cold one.
 *
 * ⛔ THE ONE PRODUCTION SITE OF THE `noHoldDepth(ciss) ? buildMemberState : buildMemberStateHeld`
 * EXPRESSION (the single-touch-point
 * directive). `assembleDial` calls it below and returns the
 * result as `heldMemberState`; `/api/lab`'s `?s=` scenario arm calls it directly (it never calls
 * `assembleDial` — C1 persist-assembled-dial keeps the live branch on the PERSISTED dial while `?s=`
 * always recomputes). Re-typing the ternary at either lab arm is the defect this export prevents.
 * Falsifier — exactly one non-comment hit, the line below:
 *   `grep -rn "buildMemberStateHeld({" --include=*.ts src/ api/ | grep -v "\.test\.ts" | grep -vP ':\s*(\*|//)'`
 * ⚠ SCOPED TO `src/` + `api/` DELIBERATELY, and the scope is not a convenience:
 * the probes under `scripts/` re-type the same ternary and must keep doing so — they thread the
 * probe-only `probeHoldOff` control-arm seam, which this function does not carry (see the
 * production-path scoping note below). Adding `scripts/` to the grep's paths therefore returns
 * STRICTLY MORE than the one production hit, by design — that widening is also the demonstration
 * that the falsifier is not vacuous, and no count is restated here: a new probe must not rot it.
 *
 * ⛔ THE HELD BRANCH MUST BE `buildMemberStateHeld`, NOT `buildMemberStateHeldAt` — ONE MAP, NOT TWO
 * (Stage 6.1). `computeField` builds `buildMemberStateHeld(d, cissHistory)` = merge(LIVE panel,
 * held at 0); this used to build `buildMemberStateHeldAt(cissHistory, 0)` = held at 0 alone, which
 * never sees the live panel — so a member lit in the live panel but not yet in the persisted member-history
 * window was missing here while the engine had it.
 * ⚠ THE SEAM IS INERT TODAY AND UNPINNED — this ⛔ is a RATIONALE, not a guard; do not read it as one.
 * Reverting the branch below to `buildMemberStateHeldAt(cissHistory, 0)` — the exact split forbidden
 * above — leaves the ENTIRE suite green (measured 2026-08-07). WHY it is inert: this map's ONLY
 * consumer is `techConfirmerFromPanel` (t1dial.ts), which re-does the raise against the LIVE panel
 * itself, and `State` is exactly `"GREEN" | "AMBER" | "RED"`, so `SEV_STATE` round-trips every
 * severity losslessly — merged-vs-raw-held is unobservable through that consumer. Keep the merged
 * builder anyway: the day a SECOND consumer reads this map, or the confirmer stops re-raising, the
 * split becomes observable and the dial and the engine would read two different maps. A pin is OWED
 * (carried in `docs/backlog.md`); until one exists nothing here fails if the split returns.
 *
 * ⛔ AND THE COLD-STORE FALLBACK IS THE ENGINE'S (Stage 6.2, ruling 10). The predicate is IMPORTED,
 * never re-typed: "cold store" has one definition and it lives at `noHoldDepth`.
 *
 * ⚠ THE "SAME AS `computeField`" CLAIM IS SCOPED TO THE PRODUCTION PATH. The engine core selects its
 * unheld builder on `noDepth || probeHoldOff` (reachable only through `computeFieldProbe`); this branches
 * on `noHoldDepth` alone. `probeHoldOff` is a
 * probe-only control-arm seam neither this function nor `assembleDial` carries: the probe
 * (`scripts/probe-leg-ordering.ts`) never routes through here — it builds its own chip map and threads
 * the flag into it directly. With it unset, as it always is in production, the two selections agree on
 * every input, and that is the whole of ruling 10.
 *
 * `freshness` is deliberately NOT threaded: `DangerInput`'s two fields are both optional, and the dial
 * has no `MemberFreshness` projection of its own to pass. This map's ONLY consumer,
 * `techConfirmerFromPanel`, reads `h.sev` alone. ⚠ Scope that claim to what the consumer reads, not to
 * the map's contents: `buildMemberState` writes BOTH `obs` AND the `lag` label from freshness, so an
 * unthreaded `freshness` does change what a future consumer reading `held[id].lag` would see.
 */
export function selectMemberStateMap(
  globalPanel: FamilyPanel[],
  cissHistory: MemberHistoryEntry[] | undefined,
): MemberStateMap {
  return noHoldDepth(cissHistory)
    ? buildMemberState({ globalFamilies: globalPanel })
    : buildMemberStateHeld({ globalFamilies: globalPanel }, cissHistory);
}

/** How the carry gate learns a member's vintage: the caller's binding of the run's ONE freshness
 *  resolver (`resolveFreshness`, scorers-core.ts). Returns the age of `date` against `asOf` in the
 *  id's OWN unit, or `null` when no publication calendar could be built for it. */
export type CarryAgeOf = (id: string, date: string, asOf: string) => number | null;

/** A carry read's store failure — it still reads as "no persisted close"; this names the id. */
export type CarryReadError = (id: string, err: unknown) => void;
const warnCarryRead: CarryReadError = (id, err) =>
  console.warn(`[dial-carry] ${id} stored-close read failed - read as no persisted close: ${errMsg(err)}`);

/** The carry reads' one cached tail per id (`seriesCache` dedupes member + family reads). */
function cachedTail(store: Pick<Store, "getSeries">, cache: Map<string, Promise<SeriesPoint[]>>, id: string, keepRow: RowKeep, onReadFail: CarryReadError): Promise<SeriesPoint[]> {
  let p = cache.get(id);
  if (!p) {
    // D's estimate row is the last close; a carry row never is
    p = getObservedSeries(store, id, 2, keepRow).catch((err: unknown): SeriesPoint[] => {
      onReadFail(id, err);
      return [];
    });
    cache.set(id, p);
  }
  return p;
}

/**
 * Absent-member carry: a roster member
 * absent from THIS run's fetch re-enters the fold with its last persisted state while that close is
 * within the member's OWN `lagCutFor` (calendar days vs `asOf`) — a one-run fetch hiccup must not
 * silently shrink a family's denominator (the false-coverage bug). Beyond the cut it stays absent
 * (the caller's `absentIds` path arms the WATCH floor); the stored row is NEVER re-dated. Gated on
 * `lagCutById` being supplied (cron + /api/lab pass it, byte-unchanged for every other caller), and on
 * the id actually being absent — a present member is untouched. `seriesCache` dedupes the reads with
 * `carryPanel`'s family-level reads. Distinct clock from the sibling family carry by ruling: per-member
 * `lagCutFor`, not `CARRY_MAX_TRADING_DAYS`.
 */
async function carryAbsentMembers(
  families: readonly FamilyDef[],
  readings: readonly { id: string }[],
  asOf: string,
  store: Pick<Store, "getSeries">,
  seriesCache: Map<string, Promise<SeriesPoint[]>>,
  lagCutById: ReadonlyMap<string, number>,
  ageOf: CarryAgeOf,
  keepRow: RowKeep,
  onReadFail: CarryReadError,
): Promise<CarriedMember[]> {
  const presentIds = new Set(readings.map((r) => r.id));
  const rosterIds = [...new Set(families.flatMap((f) => f.ids))];
  const out: CarriedMember[] = [];
  for (const id of rosterIds) {
    if (presentIds.has(id)) continue;
    const cut = lagCutById.get(id);
    if (cut === undefined) continue; // no cut known ⇒ cannot judge vintage ⇒ leave absent
    const point = (await cachedTail(store, seriesCache, id, keepRow, onReadFail)).at(-1);
    if (!point) continue; // no persisted close ⇒ genuinely dark, stays absent
    // SLICE 3 (2026-09-09): this gate RESOLVES NO FRESHNESS OF ITS OWN. `ageOf` is the caller's
    // binding of the run's single resolver (`resolveFreshness`, scorers-core.ts) over the run's own
    // publication calendars, so a daily/weekly member's vintage is counted in the SAME publication
    // slots its `cut` is now expressed in. A second `assessFreshness` here would compare calendar
    // days against a slot cut — the exact defect the one-computation-site shape forbids.
    // `null` ⇒ no calendar could be built ⇒ the vintage is UNJUDGEABLE, so the member stays absent
    // (fail-safe: the caller's `absentIds` path arms the WATCH floor), never carried on a guess.
    const ageDays = ageOf(id, point.date, asOf);
    // Net of the member's measured release delay (release-delay.ts) — the SAME `slotLag` both
    // resolution points score with; a healthy T+1 member at age 2 vs cut 1 is carried, not dropped.
    if (ageDays === null || slotLag(ageDays, cut, id)) continue; // unjudgeable or past its own cut ⇒ stays absent
    out.push({ id, state: point.state, date: point.date, ageDays });
  }
  return out;
}

/** id → the registry's official SHORT + descriptive LONG name (`Indicator.label`/`longLabel`) and
 *  its `geoFactor` — the SAME table src/lab-assembly.ts builds as `LABEL_OF`/`LONG_LABEL_OF` (api/lab.ts: `FACTOR_OF`). */
const NAME_OF: ReadonlyMap<string, { label: string; longLabel: string; factor?: string }> = new Map(
  ALL_INDICATORS.map((i) => [i.id, { label: i.label, longLabel: i.longLabel, factor: i.geoFactor }]),
);

/**
 * Stamp the registry NAMES onto every row the panels fold, here rather than at each caller.
 *
 * The panels this module builds are PERSISTED (`alert_log.panel_state`) and served VERBATIM by
 * /api/lab, and `computeFamilyPanel` defaults a label-less row to its own `id` — so a row that
 * arrives unnamed paints a raw registry id (`F1`, `EBP`) on every board chip and hover instead of
 * the official short name. Two producers arrive unnamed: the cron's `dialReadings` projection
 * (run-cycle-dial.ts) and the CARRIED absent-member rows built a few lines above, which have no reading
 * row to inherit from at all. A row that already carries a name keeps it (the lab fallback path
 * supplies its own from the same registry, so the values agree either way).
 */
function named<T extends { id: string; label?: string; longLabel?: string; factor?: string }>(rows: T[]): T[] {
  return rows.map((r) => {
    const n = NAME_OF.get(r.id);
    if (!n) return r;
    return {
      ...r,
      label: r.label ?? n.label,
      longLabel: r.longLabel ?? n.longLabel,
      factor: r.factor ?? n.factor,
    };
  });
}

/**
 * Rank 7 (fail-toward-calm): a family whose feed dropped THIS run but was FIRING in its
 * most-recent persisted observation keeps that firing state on the panel for
 * ≤CARRY_MAX_TRADING_DAYS trading days, then drops. A non-live family's members are absent
 * from the panel, so read their last persisted point here — gated on there actually being a
 * fully-dropped family (usually none ⇒ zero extra reads). getSeries collapses to the
 * latest-vintage point per date; today's row isn't persisted yet on the cron path (carry runs
 * before recordRun) ⇒ `.at(-1)` is the last LIVE observation.
 *
 * Parameterised by the family TABLE so the dial (DIAL_FAMILIES) and display (GLOBAL_FAMILIES)
 * panels each carry against their OWN membership — a family can be non-live on one table and
 * live on the other, and the carry loop reads `fam.ids`. `seriesCache` dedupes the getSeries
 * reads across the two calls, so the two-panel split costs no extra IO.
 */
async function carryPanel(
  families: readonly FamilyDef[],
  readings: { id: string; label?: string; state: State; longLabel?: string; factor?: string; lag?: boolean; carried?: boolean }[],
  asOf: string,
  store: Pick<Store, "getSeries">,
  seriesCache: Map<string, Promise<SeriesPoint[]>>,
  keepRow: RowKeep,
  onReadFail: CarryReadError,
): Promise<{
  panel: FamilyPanel[];
  carried: FamilyKey[];
  dropped: FamilyKey[];
  lastKnownFamily: Partial<Record<FamilyKey, LastKnownFamily>>;
}> {
  const rawPanel = computeFamilyPanel(readings, families).families;
  // Non-live (rank-7) AND carried-only families both need a `lastKnownFamily` read — `applyFamilyCarry`
  // folds the carried-only one's state worse-of last-known, so the read cannot be skipped for it.
  const carryKeys = new Set(rawPanel.filter((f) => !f.live || f.carriedOnly === true).map((f) => f.key));
  const lastKnownFamily: Partial<Record<FamilyKey, LastKnownFamily>> = {};
  for (const fam of families) {
    if (!carryKeys.has(fam.key) || fam.ids.length === 0) continue;
    const points = await Promise.all(fam.ids.map((id) => cachedTail(store, seriesCache, id, keepRow, onReadFail)));
    let worst: State | null = null;
    let date: string | null = null;
    for (const pts of points) {
      const p = pts.at(-1);
      if (!p) continue;
      // Discard members whose last-live point is already older than the carry age budget: a member
      // that died months ago must NOT contribute its lagging worst-of state (nor freshly re-date the
      // family) when a still-live sibling only just dropped. Without this the worst-of fold could
      // pair a months-old AMBER with a yesterday max-date and re-fire the family every future run —
      // the age gate in applyFamilyCarry never bites because the date it sees is fresh. Gating each
      // member here keeps the fold and that gate in agreement.
      if (tradingDaysBetween(p.date, asOf) > CARRY_MAX_TRADING_DAYS) continue;
      if (worst === null || STATE_RANK[p.state] > STATE_RANK[worst]) worst = p.state;
      if (date === null || p.date > date) date = p.date;
    }
    if (worst !== null && date !== null) lastKnownFamily[fam.key] = { state: worst, date };
  }
  const carry = applyFamilyCarry(rawPanel, lastKnownFamily, asOf);
  return { panel: carry.panel, carried: carry.carried, dropped: carry.dropped, lastKnownFamily };
}

/**
 * Reduce a run's combined confirmed readings ({id, state}) into the T1 danger dial the SAME
 * way both the cron notify path and /api/lab do:
 *  1. `computeFamilyPanel(readings, DIAL_FAMILIES)` → the raw dial panel (plus the same fold over
 *     the full `GLOBAL_FAMILIES` for the board's `displayPanel` — B-11, see `DialAssembly`);
 *  2. rank-7 family carry: a previously-firing family whose feed dropped this run keeps its
 *     last-known firing state for ≤CARRY_MAX_TRADING_DAYS trading days (last-known read from
 *     the store), else it drops (reported in `dropped`);
 *  3. the US-tech downside-breadth confirmer off the carried panel (missing member ⇒ a null
 *     confirmer-non-live slot, NOT a calm GREEN — `onMissingTechMember` lets the caller degrade);
 *  4. `computeT1Dial(panel, techConfirmerP, slowArmed)`;
 *  5. the member-history window (per-member sub-severity history: hold / regime / ROC) feeding `computeField`.
 *
 * `readings` is the caller's COMBINED reading set (cron: main + global readings; lab: the
 * persisted run's readings). `asOf` is the run's data date (drives the carry age gate).
 * Pure but for `store.getSeries`.
 */
export async function assembleDial(opts: {
  /** `lag` (OPTIONAL, already resolved through `lagCutFor` by the caller) rides each row into
   *  `computeFamilyPanel`, where it decides `FamilyPanel.coverageDegraded` (R5). Omitted ⇒ NOT
   *  ASSESSED ⇒ nothing is claimed degraded — this seam resolves no lag of its own. */
  readings: { id: string; label?: string; state: State; longLabel?: string; factor?: string; lag?: boolean; carried?: boolean }[];
  asOf: string;
  store: Pick<Store, "getSeries" | "getSeriesBulk">;
  /** Cron passes recordDegrade; lab omits it (read-only). Fires per missing tech member. */
  onMissingTechMember?: (id: string) => void;
  /** Bubble-arming bit (this run's scored slow band ≥ ELEVATED) → `computeT1Dial`'s notify-cut
   *  shift. Omitted (lab read paths, tests) ⇒ `slowArmed=false` — the persisted dial already carries it. */
  slowArmed?: boolean;
  /** id → its resolved `lagCutFor`. When supplied, an absent roster member whose last persisted close
   *  is within its cut is carried back into the fold (`carryAbsentMembers`). Omitted ⇒ no member carry
   *  (byte-unchanged for tests / callers with no registry in hand). */
  carryLagCutById?: ReadonlyMap<string, number>;
  /** The run's own freshness resolver, bound by the caller — `(id, observationDate, asOf)` → the age
   *  in THAT id's unit (publication slots for daily/weekly, calendar days for monthly/quarterly), or
   *  `null` when it cannot be judged. Slice 3 (2026-09-09): this seam resolves no freshness itself,
   *  so the carry gate and the reading stamp cannot disagree about a member's vintage or its unit.
   *  REQUIRED for the carry alongside `carryLagCutById` — omitted ⇒ no member carry, the same
   *  fail-safe as an unknown cut (a caller with no calendars in hand cannot judge a vintage). */
  carryAgeOf?: CarryAgeOf;
  /** The cron NOTIFY assembly only: the run's fired date; stored reads take `notifyObservationOn(notifyToday)`. Omitted (display dial, /api/lab) ⇒ `isObservation`. */
  notifyToday?: string;
  /** A carry read's store failure; default `console.warn`. Cron's NOTIFY assembly passes `recordDegrade`; display reads always warn. */
  onReadFail?: CarryReadError;
  /** The member-history bulk read's failure; default `console.warn`. Cron's NOTIFY assembly passes `recordDegrade`. */
  onCissReadError?: CissReadError;
}): Promise<DialAssembly> {
  const { readings, asOf, store, onMissingTechMember, slowArmed = false, carryLagCutById, carryAgeOf, onReadFail = warnCarryRead, onCissReadError = warnCissRead } = opts;
  const keepRow = opts.notifyToday === undefined ? isObservation : notifyObservationOn(opts.notifyToday);

  // Two panels, one reduction each (rank-7 carry included in both — see `carryPanel`):
  //  · the DIAL panel over DIAL_FAMILIES, which every downstream notify-axis consumer reads;
  //  · the DISPLAY panel over the full GLOBAL_FAMILIES, served to /lab's board so the
  //    display-only SLOW legs still render as `volatility` members (B-11).
  // The display panel is carried too, deliberately: that reproduces BYTE-FOR-BYTE the single
  // panel this function returned before the DIAL/DISPLAY split, which is what /lab's board
  // rendered — the split must be invisible to the board.
  const seriesCache = new Map<string, Promise<SeriesPoint[]>>();
  // Absent-member carry FIRST (both panels fold the same augmented readings): an absent roster member
  // within its own `lagCutFor` re-enters with its last persisted state (`lag: false` — within the cut
  // it is not lagging, so it arms no floor; day-1 hiccup stays quiet). `carryPanel`'s family-level
  // carry then runs over the augmented set — a family with even one carried member is no longer
  // fully-dropped, so it takes the normal live path rather than the rank-7 family carry.
  // Roster = DIAL_FAMILIES (NOT the full GLOBAL_FAMILIES): the SLOW display-only legs are absent from
  // dialReadings on cron yet persisted in-cut every run, so the wider roster false-carries all four.
  const carriedMembers =
    carryLagCutById && carryAgeOf
      ? await carryAbsentMembers(DIAL_FAMILIES, readings, asOf, store, seriesCache, carryLagCutById, carryAgeOf, keepRow, onReadFail)
      : [];
  // `carried: true` marks the injected rows so `computeFamilyPanel` can tell a genuinely-present member
  // from a carried one (Stage C `carriedOnly`); `lag: false` — within the cut it arms no lag floor.
  const foldOf = (members: CarriedMember[]) =>
    named(members.length ? [...readings, ...members.map((c) => ({ id: c.id, state: c.state, lag: false, carried: true }))] : readings);
  const foldReadings = foldOf(carriedMembers);
  const carry = await carryPanel(DIAL_FAMILIES, foldReadings, asOf, store, seriesCache, keepRow, onReadFail);
  const globalPanel = carry.panel;
  // The DISPLAY panel never reads through `notifyObservationOn`: under `notifyToday` it takes its own `isObservation` carry + cache.
  const displayCache = keepRow === isObservation ? seriesCache : new Map<string, Promise<SeriesPoint[]>>();
  const displayReadError = displayCache === seriesCache ? onReadFail : warnCarryRead;
  const displayFold =
    keepRow !== isObservation && carryLagCutById && carryAgeOf
      ? foldOf(await carryAbsentMembers(DIAL_FAMILIES, readings, asOf, store, displayCache, carryLagCutById, carryAgeOf, isObservation, displayReadError))
      : foldReadings;
  const displayPanel = (await carryPanel(GLOBAL_FAMILIES, displayFold, asOf, store, displayCache, isObservation, displayReadError)).panel;
  const lastKnownFamily = carry.lastKnownFamily;

  // Member-history window — see `fetchCissHistory`. Fetched on the CRON path too (NOT just /lab), or
  // cron would run the signal hold off forever (the /lab≠notify divergence class).
  //
  // MOVED ABOVE THE CONFIRMER by Stage 2.1:
  // the tech confirmer now reads the same HELD member map the danger engine does, so
  // the history has to be in hand first. It depends only on `store` + `globalPanel` (both resolved
  // above) and on nothing the dial produces, so the move is order-preserving for every other value
  // in this function.
  const cissHistory = await fetchCissHistory(store, globalPanel, keepRow, onCissReadError);
  // The member map the tech confirmer reads: held at t on a store with depth, the engine's
  // unheld fallback on a cold one. WHY each half is what it is — the 6.1 merged-map ruling, the
  // 6.2/ruling-10 cold-store convergence, and the deliberately unthreaded
  // `freshness` (consumer-scoped) — lives in `selectMemberStateMap`'s docblock, which is now the ONE
  // site of that selection (Stage 6.3 ruling 13). Do not re-type the ternary here or anywhere else.
  // RETURNED below as `heldMemberState` so `/api/lab`'s legacy null-`dialState` arm consumes THIS very
  // object rather than a recomputation that merely agrees.
  const heldMemberState = selectMemberStateMap(globalPanel, cissHistory);

  // US-tech downside-breadth confirmer off the carried panel's trend-family members. Uses the
  // shared `techConfirmerFromPanel` so the two paths can't diverge; a MISSING member is a null
  // confirmer-non-live slot (NOT a calm GREEN), and `onMissingTechMember` lets the caller emit a
  // degrade event. Band-independent (built from the panel, no dial dependency) ⇒ before the dial.
  const techConfirmerP = techConfirmerBreadth(
    techConfirmerFromPanel(globalPanel, onMissingTechMember, heldMemberState),
  );

  // EARLY-WARN sub-signal (fast-breaks redesign §1): stamp the fast-break fire onto the dial from the
  // SAME combined `readings` (which carry the persisted DB_SMH row via run-cycle-dial.ts's `price.downside` fold).
  // The pure `computeT1Dial` fold cannot see DB_SMH — it left the trend panel in D-D — so this is the
  // one place the fire is derived on the notify path. It feeds ONLY `ewFloor` (capped WATCH) + UI; it
  // never enters the rung/band math, so `armed`/`fired`/`rung` are byte-identical to before.
  const dial: T1DialResult = { ...computeT1Dial(globalPanel, techConfirmerP, slowArmed), fastBreakEW: earlyWarnFires(readings) };

  return {
    globalPanel,
    displayPanel,
    dial,
    cissHistory,
    heldMemberState,
    carried: carry.carried,
    dropped: carry.dropped,
    lastKnownFamily,
    carriedMembers,
  };
}
