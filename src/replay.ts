/**
 * Historical replay engine (mode 2b) — the SAME pure scoring pipeline the live
 * path runs (families → T1 dial → R4 cash breaker), advanced one historical close
 * at a time over caller-fetched stored series. Learning view only: it emits the
 * per-day leg-path (`targetRung` + band/regime) with the R4 overlay, NO verdict /
 * scoreboard / field.
 *
 * Pure leaf: `(memberSeries, range) → ReplayResult`, no store/fetch/clock imports.
 * The caller (api/lab.ts, Stage 2.1) fetches each member's `getSeries` rows and
 * hands them in oldest→newest; this file never touches the DB. Determinism is by
 * construction — the only "clock" is the day being replayed (`() => dayIso`).
 *
 * Engine source (auto-picked, recorded in the plan): store-based replay. The
 * backfill already persists per-day CONFIRMED states for every panel member, so a
 * day's panel is a forward-fill of stored `{date, state, value}` — no re-score, no
 * feed refetch (the stored history and the live scalar cannot drift by construction).
 */
import { regimeToBand } from "./alert-band.js";
import { computeFamilyPanel, type FamilyRegime } from "./families.js";
import { DIAL_FAMILIES } from "./dial-assembly.js";
import { computeT1Dial, techConfirmerBreadth, techConfirmerFromPanel } from "./t1dial.js";
import { computeR4, type R4Phase, type R4State } from "./r4.js";
import type { AlertLevel } from "./ladder.js";
import type { SeriesPoint } from "./store.js";

// ── Replay constants (all defaults; the plan's "Resolved constants" table) ───────
/** range start ≥ today−10y, else 400. Bounds store reads; matches backfill depth. Enforced in api/lab.ts (Stage 2.1), NOT here. */
export const REPLAY_MAX_YEARS = 10;
/** calendar span floor: a shorter range can't draw a path, else 400. Enforced in api/lab.ts (Stage 2.1). */
export const REPLAY_MIN_SPAN_DAYS = 7;
/** getSeries limit slack (Stage 2.1): calendar days range-start→today + this, covering warm-up + publication lag. */
export const SERIES_FETCH_SLACK = 90;
/** Engine iterates this many trading days (union observation dates) before range start from a cold
 *  `equity` prior, so an in-flight arm/cash episode at range start is approximated. Warm-up points are NOT emitted. */
const R4_WARMUP_TRADING_DAYS = 60;
/** Forward-fill horizon per member: no observation within this many calendar days of D ⇒ member absent that
 *  day (drops from its family's worst-of; computeFamilyPanel already excludes empty families — anti-fake-calm). */
export const FFILL_MAX_CALENDAR_DAYS = 120;

const MS_PER_CALENDAR_DAY = 86_400_000;

/** Server-authored honesty labels (rendered verbatim by the FE). The GEO label is
 *  static; the R4 warm-up label is templated with the actual warm-up depth run. */
const GEO_NOTE =
  "Geopolitics = auto G1 (oil) only; manual flags (`config.json`) have no history and are not replayed.";
const r4WarmupNote = (tradingDays: number): string =>
  `R4 state warmed from equity ${tradingDays} trading day${tradingDays === 1 ? "" : "s"} before range start.`;
/** Emitted whenever the caller supplies a NON-EMPTY `hyOasLevels` — the SEMANTICS label for E8 item 2.
 *  Without it the widening is silent, which is worse than the dark window it replaces: a null at least
 *  announced itself. Exported so `api/lab.test.ts` pins the served note against THIS string rather than
 *  restating it (a restated copy is a second source that cannot see a drift). @internal */
export const HY_STITCHED_NOTE =
  "R4's HY-OAS input is the STITCHED HY-OAS history (committed vintage + live FRED tail), not the stored F1 rows - so R4 is replayable before F1's stored coverage begins. The credit family's F1 STATE is still stored-only, so the replayed band/regime is unchanged.";

/** One replayed close — mirrors the plan's `ReplayResponse.points[]` element. */
export interface ReplayPoint {
  date: string;
  /** T1 dial's `targetRung` ∈ 1..9 — the leg-path value. */
  targetRung: number;
  /** `regimeToBand(dial.notifyRegime)` (OK/WATCH/WARNING/CRITICAL) — the alert band, so it
   *  follows the NOTIFY axis (notify-axis). Once the two cut sets diverge this is NO LONGER
   *  `regimeToBand(regime)` — the field below is the display axis. */
  band: AlertLevel;
  /** The DISPLAY regime — the chip a human reads. Deliberately stays on the dial axis. */
  regime: FamilyRegime;
  r4Phase: R4Phase;
  cash: boolean;
  reentryRung: number | null;
}

/** Per-input-member data coverage — `firstDate` is the earliest observation, null when the member has no history. */
export interface ReplayCoverage {
  id: string;
  firstDate: string | null;
}

export interface ReplayResult {
  points: ReplayPoint[];
  coverage: ReplayCoverage[];
  notes: string[];
}

/** Forward-fill cursor over one member's oldest→newest points: `advance(D)` moves to
 *  the latest point with `date ≤ D`, then `present(D)` reports it iff within the
 *  forward-fill horizon. Monotone in D (the replay loop walks dates ascending). */
interface MemberCursor {
  id: string;
  points: SeriesPoint[];
  /** index of the latest point with date ≤ the last-advanced D; −1 = before the first point. */
  idx: number;
}

/**
 * Replay the T1 leg-path + R4 overlay across `range`, one point per union observation
 * date ≥ `range.start`. `memberSeries` is caller-fetched (oldest→newest per member).
 *
 * Per day D (union of all members' observation dates, from R4_WARMUP_TRADING_DAYS
 * union-dates before range.start): forward-fill each member (≤ FFILL_MAX_CALENDAR_DAYS,
 * else absent) → computeFamilyPanel → computeT1Dial → computeR4, with the R4 prior
 * threaded sequentially (the 5-phase state machine — never parallelized). Warm-up
 * days are consumed (they prime the R4 prior) but not emitted.
 */
export function computeReplay(
  memberSeries: { id: string; points: SeriesPoint[] }[],
  range: { start: string; end: string },
  opts?: {
    /**
     * OPTIONAL HY-OAS LEVEL OVERRIDE (E8 item 2), oldest→newest. When supplied, R4 reads its HY-OAS
     * level from THIS series instead of the stored `F1` member's `value`.
     *
     * WHY AN OVERRIDE AND NOT A SUBSTITUTED MEMBER: the stored `F1` rows begin 2023-07-25, so every
     * earlier replay day had `hyOas = null` and neither `R4_HY_TAIL` nor `R4_EXIT_HY` was reachable —
     * a structural null. Swapping the whole member out would also have to invent a `state` for the
     * pre-2023 days (a stitched `Observation` carries none), and a placeholder GREEN would inject a
     * fake-calm credit member into the family worst-of — moving the replayed BAND, which is a far
     * bigger semantics change than the one being fixed. Level-only touches exactly the defect.
     *
     * The override does NOT contribute to `unionDates` (the axis stays the stored members' trading
     * days) and is forward-filled on the same `FFILL_MAX_CALENDAR_DAYS` horizon. Out of horizon ⇒
     * null, never a fall-back to the stored level: a supplied override is the sole HY source.
     *
     * Still a pure store-free leaf — the caller fetches and stitches (api/lab.ts).
     */
    hyOasLevels?: readonly { date: string; value: number }[];
  },
): ReplayResult {
  // `?.length ?` — NOT `?? null`. An EMPTY override array is truthy, so `??` took the override branch,
  // left `hyLevel` null on every day (the cursor never advances past an empty series) AND emitted
  // `HY_STITCHED_NOTE`, i.e. a note claiming R4 reads the stitched history while R4 read nothing at all.
  // The caller happens never to pass `[]` today, but a leaf must not depend on a caller-side invariant
  // it can check this cheaply (review 2026-08-01, N4).
  const hyOas = opts?.hyOasLevels?.length ? opts.hyOasLevels : null;
  /** Forward-fill cursor over `hyOasLevels`, monotone in D like the member cursors below. */
  let hyIdx = -1;
  const coverage: ReplayCoverage[] = memberSeries.map((m) => ({
    id: m.id,
    firstDate: m.points[0]?.date ?? null,
  }));

  // Union of every member's observation dates, ascending — the replay's per-day axis
  // (no interpolation across days no member observed: a trading-day axis).
  const unionDates = [...new Set(memberSeries.flatMap((m) => m.points.map((p) => p.date)))].sort();

  // Warm-up start = R4_WARMUP_TRADING_DAYS union-dates before the first in-range date
  // (data permitting). startIdx = first date ≥ range.start; endIdx = last date ≤ range.end.
  const startIdx = unionDates.findIndex((d) => d >= range.start);
  const firstIdx = startIdx === -1 ? unionDates.length : startIdx;
  const warmupStartIdx = Math.max(0, firstIdx - R4_WARMUP_TRADING_DAYS);
  const warmupDays = firstIdx - warmupStartIdx;

  const cursors: MemberCursor[] = memberSeries.map((m) => ({ id: m.id, points: m.points, idx: -1 }));

  const points: ReplayPoint[] = [];
  let prior: R4State = { phase: "equity", entryFiredAt: null, reentryRung: null };

  for (let i = warmupStartIdx; i < unionDates.length; i++) {
    const dayIso = unionDates[i]!;
    if (dayIso > range.end) break;

    // Forward-fill every member to D: advance its cursor to the latest point ≤ D, then
    // keep it only if that point is within the horizon (else the member is absent today).
    const present = new Map<string, SeriesPoint>();
    for (const c of cursors) {
      while (c.idx + 1 < c.points.length && c.points[c.idx + 1]!.date <= dayIso) c.idx++;
      if (c.idx < 0) continue;
      const p = c.points[c.idx]!;
      const gapDays = Math.floor((Date.parse(dayIso) - Date.parse(p.date)) / MS_PER_CALENDAR_DAY);
      // Horizon is INCLUSIVE: gap == FFILL_MAX_CALENDAR_DAYS (120) still fills; only gap > 120 drops.
      if (gapDays <= FFILL_MAX_CALENDAR_DAYS) present.set(c.id, p);
    }

    const value = (id: string): number | null => present.get(id)?.value ?? null;
    const readings = [...present].map(([id, p]) => ({ id, state: p.state }));

    // SAME pipeline as the live path (api/lab.ts / run-cycle-dial.ts): panel → tech confirmer →
    // dial (two-key ARM/FIRE band math) → R4 (F1 = HY-OAS, VT ratio; clock = the day).
    // DIAL_FAMILIES, not GLOBAL_FAMILIES (B-11): this fold serves `targetRung` + `band` — the
    // NOTIFY axis — and its readings come from api/lab.ts's per-member getSeries over the
    // PERSISTED rows, which DO include the slow legs. Reducing against the full table here would
    // replay a band the real cron can never produce (a RED complacency-* leg firing volatility).
    const panel = computeFamilyPanel(readings, DIAL_FAMILIES);
    // ⚠ EXEMPT FROM THE HELD MEMBER MAP, DELIBERATELY (Stage 6.3 ruling 12):
    // the walk has NO `cissHistory` seam at all — it
    // reconstructs each day's panel from forward-filled persisted rows and never fetches member history —
    // and a replay at day t would need the hold window as of t, not as of today. So this stays unheld
    // (byte-identical to pre-Stage-2.1), and the third argument is omitted rather than forgotten.
    const techP = techConfirmerBreadth(techConfirmerFromPanel(panel.families));
    const dial = computeT1Dial(panel.families, techP);
    // HY-OAS level: the override when supplied (same ffill horizon, its own cursor), else the stored
    // F1 member's level. `hyOas != null` is the branch key — an override that is merely dark today
    // yields null rather than silently reverting to the stored series (see the opts docblock).
    let hyLevel = value("F1");
    if (hyOas) {
      hyLevel = null;
      while (hyIdx + 1 < hyOas.length && hyOas[hyIdx + 1]!.date <= dayIso) hyIdx++;
      if (hyIdx >= 0) {
        const p = hyOas[hyIdx]!;
        if (Math.floor((Date.parse(dayIso) - Date.parse(p.date)) / MS_PER_CALENDAR_DAY) <= FFILL_MAX_CALENDAR_DAYS) {
          hyLevel = p.value;
        }
      }
    }

    const r4 = computeR4(dial, hyLevel, value("VT"), prior, () => dayIso);
    prior = { phase: r4.phase, entryFiredAt: r4.entryFiredAt, reentryRung: r4.reentryRung };

    // Emit only in-range days; warm-up days just primed `prior` above.
    if (dayIso >= range.start) {
      points.push({
        date: dayIso,
        targetRung: dial.targetRung,
        band: regimeToBand(dial.notifyRegime), // notify-axis
        regime: dial.regime, // display axis — the chip, deliberately NOT rewired
        r4Phase: r4.phase,
        cash: r4.cash,
        reentryRung: r4.reentryRung,
      });
    }
  }

  return {
    points,
    coverage,
    notes: [GEO_NOTE, r4WarmupNote(warmupDays), ...(hyOas ? [HY_STITCHED_NOTE] : [])],
  };
}
