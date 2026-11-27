/**
 * Shared per-leg pillar replay walk — the ONE code path behind both the EW-liveness probe
 * (`scripts/probe-earlywarn.ts`, prints) and the `legpillars` backfill job (writes).
 *
 * Extracted from the probe in W4 Stage 4.2.1
 * precisely so the probe stays a real control arm for the job rather than a lookalike that can drift.
 *
 * PURE-ish by contract: no `process.argv`, no store construction here. The caller injects `store` and
 * `closes`; every cursor is a function-local (`makeCursor`), so two calls in one process each replay
 * from a fresh cursor.
 *
 * ⚠ ONE ruled exception to "no `console.*`": the member fetch is `lib/replay-walk.js`'s fail-loud
 * `loadSeries`, which prints an ABORT and `process.exit(1)`s if any read REJECTS (carriers round,
 * 2026-08-02). It replaced a `.catch(() => [])` whose silently-empty member was absent for EVERY date,
 * dropping its family out of `computeFamilyPanel`'s worst-of and moving `positionP` — skew that this
 * walk's writer (`backfill-leg-pillars.ts`) PERSISTS. Deliberate, and it reaches both callers.
 * Threading strictness through the `deps` seam was offered and declined: it would widen the shared walk
 * for one caller.
 *
 * STRICTLY READ-ONLY: the injected store is used for `getSeries` only — never insert/update/delete.
 */
import type { Store } from "../../src/store.js";
import { US_FAMILIES, GLOBAL_FAMILIES, computeFamilyPanel } from "../../src/families.js";
import { computeT1Dial, techConfirmerBreadth } from "../../src/t1dial.js";
import {
  computeField,
  pillarValue,
  CAPABLE_FAMILIES,
  type MemberHistoryEntry,
} from "../../src/danger-engine.js";
import { DIAL_FAMILIES, FAMILY_MEMBERS, type SuperGroup } from "../../src/danger-ladder.js";
import type { PillarSuperGroup } from "../../src/leg-percentile.js";
import { DOWNSIDE_DETECTOR_IDS } from "../../src/registry-price.js";
import type { State } from "../../src/domain-types.js";
import { loadSeries, calendarFrom, makeCursor, MEMBER_WINDOW } from "../lib/replay-walk.js";

/** Formula-vintage tags, owned by `src/leg-percentile.ts` and RE-EXPORTED here (Stage 4.3) so every
 *  4.2 importer is unchanged. `LEG_PILLAR_GENERATOR` = `legPillarGenerator("EARLY-WARN")`; the walk
 *  stamps each row `legPillarGenerator(r.superGroup)` (§11.1), so SN rows carry their own `sn-` tag.
 *  The writer (this walk) and the reader (`api/lab.ts`'s filter) must agree, and a Vercel function may
 *  not import out of `scripts/` — so the source lives on the `src/` side. Do NOT re-introduce a copy. */
export { LEG_PILLAR_GENERATOR, legPillarGenerator } from "../../src/leg-percentile.js";

/** The probe's pinned reference arm — the 2026-07-21 finding, as a CHECKED constant rather than
 *  docstring prose (Stage 4.2 §2.1). `--check-reference` recomputes it and exits non-zero on drift. */
export const EW_REFERENCE_ARM = {
  closes: 900,
  env: "prod",
  date: "2023-08-08",
  ewMin: 0.063,
  ewMax: 0.507,
} as const;

/** Tolerance for the reference-arm EW min/max comparison. */
export const EW_REFERENCE_TOLERANCE = 0.001;

/** The two pillar super-groups the walk emits, paired with their `SubDangers` key. */
const PILLAR_SUPER_GROUPS = [
  { key: "earlyWarn", superGroup: "EARLY-WARN" },
  { key: "stressNow", superGroup: "STRESS-NOW" },
] as const satisfies readonly { key: "earlyWarn" | "stressNow"; superGroup: SuperGroup }[];

/** One replayed (date × leg × super-group) pillar observation. */
export interface LegPillarWalkRow {
  date: string;
  sleeve: string;
  /** Only ever a ranked pillar super-group (`PILLAR_SUPER_GROUPS`) — narrowed so a row can be
   *  stamped `legPillarGenerator(superGroup)` without a widening cast. */
  superGroup: PillarSuperGroup;
  /** `pillarValue` — `null` for an `uncomparable` (not-live) pillar. */
  value: number | null;
  /** Always `false` (the share engine imputes nothing); kept for the NOT NULL `leg_pillars.estimated` column (no migration). */
  estimated: false;
  /** Plaintext roster the pillar was computed over (see `legPillarBasis`). */
  basis: string;
  /** EARLY-WARN rows only: the engine's raw EW ROC when present. */
  ewRoc?: number;
  /** The engine's own coverage read for this super-group (never recounted here). */
  coverage?: { live: number; capable: number };
}

/** The roster a super-group's pillar is computed over: the sorted member-ids of its CAPABLE families,
 *  joined with `,`. Plaintext, not a hash (Stage 4.2 §2.2) — it genuinely varies across super-groups
 *  and moves when the registry moves, which is what keeps Stage 4.4's mixed-basis detection live. */
export function legPillarBasis(sg: SuperGroup): string {
  return [...CAPABLE_FAMILIES[sg].flatMap((f) => FAMILY_MEMBERS[f])].sort().join(",");
}

/** Replay the danger engine over the last `closes` store closes and return every leg's per-super-group
 *  pillar reading, in date order (and, within a date, in `legRows` order). */
export async function replayLegPillars(
  deps: { store: Pick<Store, "getSeries"> },
  opts: { closes: number },
): Promise<LegPillarWalkRow[]> {
  const { store } = deps;
  const replayN = opts.closes;

  const memberIds = [...new Set([...US_FAMILIES, ...GLOBAL_FAMILIES].flatMap((f) => f.ids))];
  // tech-confirmer inputs; order (SMH, XLK) mirrors DOWNSIDE_DETECTORS (registry source), no consumer here depends on it
  const dbIds = DOWNSIDE_DETECTOR_IDS;
  const seriesById = await loadSeries(store, [...memberIds, ...dbIds], replayN + MEMBER_WINDOW + 200);

  // Calendar = F4 daily closes (deep trading-day cadence); earlier closes are member pre-history.
  // `calendarFrom`'s default axis IS "F4" (`DEFAULT_AXIS_ID`), so this is the previous expression exactly.
  const calendar = calendarFrom(seriesById);
  // SEAM (carriers round): `selectReplayDates` DECLINED — it adds a `CALENDAR_MARGIN` floor and three
  // `console.log` + `process.exit(1)` aborts this PURE-ish-contracted function never had, and would
  // turn a short store into a hard exit inside the backfill writer. The bare slice is the behavior.
  const replayDates = calendar.slice(-replayN);
  const advance = makeCursor(seriesById);
  const histTail = MEMBER_WINDOW + 30; // enough for EW_ROC_LOOKBACK=20 observed base
  const basisOf = new Map<SuperGroup, string>(
    PILLAR_SUPER_GROUPS.map((p) => [p.superGroup, legPillarBasis(p.superGroup)]),
  );

  const rows: LegPillarWalkRow[] = [];
  // SEAM (carriers round): `panelAt` / `ffillReadings` DECLINED — both drop a member whose
  // forward-filled point is older than `FFILL_MAX_CALENDAR_DAYS`; this walk applies NO lag
  // horizon, so adopting either would change which members reach `computeFamilyPanel` on sparse
  // dates — and those rows are persisted. (`walkReplay` follows them out: it folds over
  // `ffillReadings`.) `unionCalendar` likewise declined: the axis is F4 trading days by design.
  for (const d of replayDates) {
    const readings: { id: string; state: State }[] = [];
    const history: MemberHistoryEntry[] = [];
    for (const id of memberIds) {
      const i = advance(id, d);
      if (i < 0) continue;
      const pts = seriesById.get(id)!;
      readings.push({ id, state: pts[i]!.state });
      history.push({ id, history: pts.slice(Math.max(0, i + 1 - histTail), i + 1) });
    }
    const panel = computeFamilyPanel(readings, DIAL_FAMILIES);
    const dbStates = dbIds.map((id) => {
      const i = advance(id, d);
      return i < 0 ? null : seriesById.get(id)![i]!.state;
    });
    const band = computeT1Dial(panel.families, techConfirmerBreadth(dbStates)).band;
    const field = computeField({ globalFamilies: panel.families }, band, undefined, null, history);
    for (const r of field.legRows) {
      for (const p of PILLAR_SUPER_GROUPS) {
        const pillar = r.subDangers[p.key];
        rows.push({
          date: d,
          sleeve: r.sleeve,
          superGroup: p.superGroup,
          value: pillarValue(pillar),
          estimated: false,
          basis: basisOf.get(p.superGroup)!,
          // READ the engine's coverage field (Contract 1) — never recount here.
          ...(p.superGroup === "EARLY-WARN" ? { ewRoc: r.ewRoc } : {}),
          coverage: r.coverage?.[p.superGroup],
        });
      }
    }
  }
  return rows;
}
