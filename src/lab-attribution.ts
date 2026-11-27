/**
 * /lab leg attribution: recompute one dual-axis id's winning OR-leg and roll the
 * firing ids into the display-only legAttribution block.
 */

import type { ReadStore, CalibrationParam } from "./store.js";
import { ALL_INDICATORS } from "./registry.js";
import { resolveCuts } from "./domain-cuts.js";
import { scoredDaySeries, asymConfirmedStateSeries } from "./domain-fold.js";
import { type Indicator, type Observation } from "./domain-types.js";
import { loadSynthHistories, synthesizedCalib } from "./synth-cuts.js";
import { hasSynthPriors } from "./domain-cuts.js";
import { isVelocityLeg } from "./domain-legs.js";
import { type State } from "./domain-types.js";
import { confirmClosesFor, type LegAttribution } from "./families.js";
import { memoByVintage } from "./api/vintage-memo.js";
import { legHistoryLimitFor } from "./lab-assembly.js";
import { dualAxisFiringIds } from "./lab-served-field.js";
import { getObservedSeries } from "./estimated.js";

/**
 * Recompute ONE dual-axis id's winning OR-leg for its OWN persisted close (the row's `date`, which lags
 * `asOf`), mirroring the notify path's cut resolution (`confirmers.ts` scoreWithCuts: `resolveCuts` with
 * NO cell, vintage through `synthesizedCalib`). A /series cross-check is only apples-to-apples at the
 * DEFAULT cell.
 *
 * ⚠ THE GATE BOUNDS STATE, NOT LEG IDENTITY: it requires the recompute to reproduce the persisted DATE
 * and STATE, but confirmed state is an OR over six legs, so a moved history can flip WHICH leg wins while
 * the state holds — "right state, possibly the wrong one of its legs". The reason this must never feed
 * the band.
 *
 * FIDELITY GATE — every refusal returns an explicit `declined` REASON, never nothing:
 *   - `no-history`          — no stored rows to recompute from.
 *   - `mid-confirm`         — raw ≠ confirmed on the tail day (`winningLegSeries` suppressed it). Carries
 *                             `confirmCloses` so the chip names the fold from DATA; N lives only in `CONFIRM_TIERS`.
 *   - `recompute-disagreed` — recompute date or state ≠ THAT ROW's. /lab never re-scores (api/lab.ts);
 *                             attribution is the ONE read-time recompute, so it may only speak when it agrees.
 */
async function attributeLeg(
  store: ReadStore,
  indicator: Indicator,
  calib: ReadonlyArray<CalibrationParam>,
  synthHistories: Awaited<ReturnType<typeof loadSynthHistories>> | undefined,
  persistedDate: string,
  persistedState: State,
): Promise<LegAttribution> {
  const id = indicator.id;
  // `synthHistories` is consumed only by synth ids (F3/F11); pass it only there.
  const synthCalib = synthesizedCalib(indicator, calib, hasSynthPriors(id) ? synthHistories : undefined);
  const cuts = resolveCuts(id, synthCalib, indicator.direction ?? "HIGH");
  const stored = await getObservedSeries(store, id, legHistoryLimitFor(indicator));
  const observations: Observation[] = stored.map((p) => ({ date: p.date, value: p.value }));
  if (observations.length === 0) return { id, declined: "no-history" };
  // ONE fold: `scoredDaySeries` returns raw states AND per-day legs from a single `classify` walk. Every
  // DUAL_AXIS_IDS member is `classify()`-scored (since 2026-09-04), so the generic fold is the only
  // branch. `confirmCloses` is read by the fold and shipped on the `mid-confirm` arm; the FE names the
  // fold by this count and never restates it.
  const confirmCloses = confirmClosesFor(id);
  const { rawStates, legs } = scoredDaySeries(indicator, observations, cuts, undefined, confirmCloses);
  if (rawStates.length === 0) return { id, declined: "no-history" };
  const confirmed = asymConfirmedStateSeries(rawStates, confirmCloses).at(-1)!;
  const date = observations.at(-1)!.date;
  // ⚠ Compared against the PERSISTED ROW's date, never `asOf` (a run-level MAX): anchoring on `asOf`
  // failed the gate for every id whose feed lags the freshest. The row's own date is the vintage this
  // recompute must reproduce.
  if (date !== persistedDate || confirmed !== persistedState) return { id, declined: "recompute-disagreed" };
  const leg = legs.at(-1);
  // `confirmCloses` rides ONLY this reason: the buffer that suppressed the leg, rendered as "mid N-close
  // confirmation fold" rather than hardcoding the tier.
  if (!leg) return { id, declined: "mid-confirm", confirmCloses };
  return { id, leg, axis: isVelocityLeg(leg) ? "velocity" : "level" };
}

/**
 * The live path's `legAttribution` block: one entry per firing dual-axis id — `{leg, axis}` (agreed) or
 * a `declined` reason (did not). Every id degrades independently; attribution is display-only and must
 * never 500 the board. ZERO external I/O: every input is read from the STORE.
 *
 * The `ids.length === 0` short-circuit is a LIVE guard, not dead code — do not delete: zero firing
 * dual-axis ids is an ordinary run (a level leg scores GREEN on stretches of its own window). Reads: ONE `getCalibration`; ONE `getSeries(id, legHistoryLimitFor(id))`
 * per firing id; plus, only when a synth id fires, ONE `loadSynthHistories(store)` hoisted out of the
 * per-id `Promise.all` so it is paid once.
 */
export async function computeLegAttribution(
  store: ReadStore,
  readings: { id: string; state: State; date: string }[],
  firedAt: string,
  warn: (...args: unknown[]) => void = console.warn,
): Promise<{ attribution: LegAttribution[]; degraded: boolean }> {
  const ids = dualAxisFiringIds(readings);
  if (ids.length === 0) return { attribution: [], degraded: false };
  const stateOf = new Map(readings.map((r) => [r.id, r.state]));
  // Per-id vintage, not the run's `asOf` — see the gate in `attributeLeg`.
  const dateOf = new Map(readings.map((r) => [r.id, r.date]));
  // A store REJECTION in any swallow below flags `degraded` so the 200 rides DEGRADED_HEADERS
  // (s-maxage=60); a legit decline never sets it.
  let degraded = false;
  const [calib, synthHistories] = await Promise.all([
    store.getCalibration().catch(() => {
      degraded = true;
      return [] as CalibrationParam[];
    }),
    // Hoisted + deduped, skipped when no synth id fires; memoized per vintage (`firedAt`) so a warm
    // instance pays the bulk once.
    ids.some((id) => hasSynthPriors(id))
      ? // The loader's store failure is rethrown: the memo drops the rejection, and it flags `degraded`.
        memoByVintage("synth", firedAt, () => loadSynthHistories(store, (msg, err) => { warn(msg, err); throw err; })).catch(() => {
          degraded = true;
          return undefined;
        })
      : Promise.resolve(undefined),
  ]);
  const out: LegAttribution[] = await Promise.all(
    ids.map(async (id) => {
      const indicator = ALL_INDICATORS.find((i) => i.id === id);
      if (!indicator) return { id, declined: "recompute-disagreed" as const };
      return attributeLeg(store, indicator, calib, synthHistories, dateOf.get(id)!, stateOf.get(id)!).catch(() => {
        degraded = true;
        return { id, declined: "recompute-disagreed" as const };
      });
    }),
  );
  // Server-side trace so a "no badge" can be diagnosed from logs alone.
  const declined = out.filter((a) => a.declined);
  if (declined.length > 0) {
    console.log(
      `[lab] legAttribution declined: ${declined.map((a) => `${a.id}=${a.declined}`).join(", ")}`,
    );
  }
  return { attribution: out, degraded };
}
