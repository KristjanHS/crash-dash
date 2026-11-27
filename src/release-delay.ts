/**
 * The measured RELEASE DELAY per feed — how many publication slots after an observation date the
 * store first sees that observation. A T+1 FRED series (F1: FRED publishes obs `D` during `D+1`
 * at ~14:40 UTC) reads 1; a same-day close (SPY) reads 0.
 *
 * WHY. `slotAge` counts grid dates in `(newest, today]`, so a healthy T+1 feed reads 2 every morning
 * once any same-day peer stores today's row — and `lag = age > LAG_THRESHOLDS.daily (1)` flagged
 * the whole US T+1 cluster false-behind. Both freshness
 * resolution points now score `age - delay > cut`: sensitivity is unchanged (one missed release still
 * flags the next day), the false positive is gone, and F1 vs R2 — same publisher, different
 * containment grids — get the same verdict.
 *
 * DERIVED, NOT HAND-SET (`[USER]` 2026-09-10) — with ONE narrow exception, `RELEASE_DELAY_HAND_FLOOR` below:
 * a hand value re-applied only to an id the probe lands in `unmeasured` (fewer than 5 live samples, or ungriddable
 * like G1), removed per id once its own measurement lands (`docs/backlog.md` rows cite each). `readings` is append-only, so `min(run_at)` per
 * `(indicator_id, obs_date)` IS the first-persist time; `scripts/probe-release-delay.ts` takes the
 * MODE of `slotAge(obs_date, dateOf(min run_at))` over a 90-day window per feed — over observations
 * a LIVE run stored (a `run_at` shared by ≥2 obs dates is a bulk backfill, whose delay is the
 * backfill's age, not the publisher's; see the probe's ESTIMATOR note) — and writes the
 * committed snapshot this module indexes at load — the `LAG_CUT_OF` shape. Regenerate with
 * `npm run probe:release-delay` and commit the JSON in the same commit; `release-delay.test.ts`
 * pins the snapshot's id set to the live registry so a new daily/weekly id announces the regen.
 *
 * Absent id ⇒ 0 — today's behaviour, never a fabricated slot. Leaf module: no `src/` imports, so
 * both `scorers-core.ts` (run path) and `feed-lag.ts` (read path) can hold it without a cycle.
 */
import RELEASE_DELAY_SNAPSHOT from "../scripts/release-delay.snapshot.json" with { type: "json" };

export interface ReleaseDelaySnapshot {
  /** ISO timestamp of the probe run that wrote the file. */
  capturedAt: string;
  /** Observation-date window the modes were taken over. */
  windowDays: number;
  /** id → modal first-persist delay in publication slots (integer ≥ 0), over live-run samples. */
  delays: Record<string, number>;
  /** Daily/weekly ids the probe could NOT measure (no grid, or no rows in the window) — scored at 0. */
  unmeasured: string[];
}

export const RELEASE_DELAY_SNAPSHOT_TYPED: ReleaseDelaySnapshot = RELEASE_DELAY_SNAPSHOT;

/** id → measured release delay in slots. Built once at module load off the committed snapshot. */
export const RELEASE_DELAY_OF: ReadonlyMap<string, number> = new Map(
  Object.entries(RELEASE_DELAY_SNAPSHOT_TYPED.delays).map(([id, d]) => [id, Math.max(0, Math.trunc(d))]),
);

/**
 * id → the ids whose fetches carry its INPUTS. A derived id's readings are the date-intersection of
 * those inputs, so it cannot print before the slowest of them: the probe floors its delay at the max
 * of these donors' delays, and scores it at that max when short of own live samples (a new id lands
 * backfill-only) instead of 0.
 * EPATH = SR_1Y (ECB `YC`, EURC's dataflow) ∩ ESTR — read false-behind at delay 0 every morning
 * beside its T+1 siblings (2026-10-05).
 */
export const RELEASE_DELAY_INPUT_DONORS: Readonly<Record<string, readonly string[]>> = {
  EPATH: ["EURC", "ESTR"],
};

/**
 * id → hand-set delay the probe RE-APPLIES whenever a regen lands the id in `unmeasured` (fewer than its
 * `MIN_LIVE_SAMPLES` live samples, or ungriddable). A measurement with enough samples always wins (even one BELOW
 * the floor) — the floor only replaces the 0 an unmeasured id would otherwise score at, which read false-behind
 * every morning.
 * Values: BBB ← FRED ICE BofA T+1 siblings F1/F2/F10 = 1; G1 = its last measurement before it went
 * ungriddable on prod (1 calendar source). Remove an id once its own measurement lands.
 * Pinned in release-delay.test.ts: none of these ids may ship in `unmeasured` or without a delay entry (the
 * snapshot does not record floored vs measured, so the shipped value itself is not pinned).
 */
export const RELEASE_DELAY_HAND_FLOOR: Readonly<Record<string, number>> = {
  G1: 1,
  BBB: 1,
};

/** The delay term for one id — 0 when the snapshot has no measurement (unchanged scoring). */
export function releaseDelayFor(id: string): number {
  return RELEASE_DELAY_OF.get(id) ?? 0;
}

/**
 * THE lag comparison for a slot-scored feed, shared by both resolution points:
 * lagging iff the slots the store is behind EXCEEDS the feed's own release delay by more than `cut`.
 */
export function slotLag(age: number, cut: number, id: string): boolean {
  return age - releaseDelayFor(id) > cut;
}
