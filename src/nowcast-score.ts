/**
 * Oil nowcast SCORING + persistence (a retired plan L2,
 * E8): G1 / BRENT (`oil-nowcast.ts`) carry their print grid to the futures' newest close. An intraday run scores off
 * the extended grid; every run persists the point as an `estimated` row, which the EOD sweep removes once its print lands.
 * `hyoas-nowcast.ts` stays for the F1/F2 probes.
 */
import { type Estimator, headObs, type Observation } from "./domain-types.js";
import { nowcastOilSpots } from "./oil-nowcast.js";
import { ALL_INDICATORS } from "./registry.js";
import { CHART_ONLY_INDICATORS } from "./registry-composite.js";

/** The registry rows carrying an `estimator` literal — every roster below derives from these (registry order). */
const ESTIMATORS: ReadonlyMap<string, Estimator> = new Map([...ALL_INDICATORS, ...CHART_ONLY_INDICATORS].flatMap((i) => (i.estimator ? [[i.id, i.estimator] as const] : [])));
const idsWhere = (pred: (e: Estimator) => boolean): string[] => [...ESTIMATORS].filter(([, e]) => pred(e)).map(([id]) => id);

/** `id`'s registry estimator narrowed to `kind` — throws when the row has none or it is another kind. */
export function estimatorOf<K extends Estimator["kind"]>(id: string, kind: K): Extract<Estimator, { kind: K }> {
  const e = ESTIMATORS.get(id);
  if (e?.kind !== kind) throw new Error(`[nowcast] ${id} has no "${kind}" estimator on its registry row (found ${e?.kind ?? "none"})`);
  return e as Extract<Estimator, { kind: K }>;
}

/** The oil ids scored off the extended grid intraday and persisted as estimate rows at EOD (E8: F1 out). */
export const NOWCAST_SCORED_IDS: readonly string[] = idsWhere((e) => e.kind === "carry-log");
/** Every id that writes `estimated` rows — the EOD sweeps (L4, E3) read this roster. */
export const ESTIMATE_ROW_IDS: readonly string[] = [...ESTIMATORS.keys()];
/** Estimators that failed their pre-registered gate yet write an `estimated` row — the notify dial never reads those rows. */
export const GATE_FAILED_ESTIMATORS: ReadonlySet<string> = new Set(idsWhere((e) => e.gateFailed === true));
export type NowcastScoredId = string;

/** `prints` with the estimates appended as observations — only those dated AFTER the newest print (an estimate on a
 *  print's own date adds nothing), oldest first (I2: one per missing session). */
export function extendWithEstimate(prints: Observation[], ests: readonly Observation[]): Observation[] {
  const newest = prints.at(-1)?.date;
  const add = ests.filter((e) => newest === undefined || e.date > newest).sort((a, b) => a.date.localeCompare(b.date));
  return add.length === 0 ? prints : [...prints, ...add.map((e) => headObs(e.date, e.value, "proxyCarry"))];
}

/** The estimates as observations, keyed by id, one per missing session (I2) — absent where there are none (no carry
 *  window, stale prints, a failed proxy fetch, nothing newer than the print). `fetchCloses` is the run's memoized
 *  daily-close feed; a leg that throws yields no estimate for its id, never a thrown run — `onFail` names it first. */
export async function intradayNowcastPoints(
  prints: Readonly<Record<NowcastScoredId, Observation[]>>,
  fetchCloses: (symbol: string) => Promise<Observation[]>,
  onFail: (msg: string, err: unknown) => void = console.warn,
): Promise<Map<NowcastScoredId, Observation[]>> {
  const closes = async (symbol: string): Promise<Observation[]> => {
    try {
      return await fetchCloses(symbol);
    } catch (err) {
      onFail(`[oil-nowcast] ${symbol} closes unavailable - estimate points omitted`, err);
      return [];
    }
  };
  const out = new Map<NowcastScoredId, Observation[]>();
  for (const id of NOWCAST_SCORED_IDS) {
    const leg = estimatorOf(id, "carry-log");
    const own = prints[id] ?? [];
    if (own.length === 0) continue;
    const ext = extendWithEstimate(own, nowcastOilSpots(own, await closes(leg.leads[0]), leg.beta));
    if (ext.length > own.length) out.set(id, ext.slice(own.length));
  }
  return out;
}

/** Every live leg symbol the run's nowcasts read (the G1/BRENT futures; E8 retired the OAS legs) — `INPUT_SERIES` rows, so
 *  `withStoredLegs` can fill their live-feed holes (Defect 1). */
export const NOWCAST_LEG_SYMBOLS: readonly string[] = NOWCAST_SCORED_IDS.map((id) => estimatorOf(id, "carry-log").leads[0]);
