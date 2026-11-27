/**
 * /lab served-field build: the engine-only strip + display fields, the per-leg
 * ewPct cell, and the dual-axis firing-id gate.
 */

import type { ReadStore } from "./store.js";
import { pillarValue, type FieldResult, type PillarScore } from "./danger-engine.js";
import type { LegRowEngineOnly, PercentileCell } from "./api/types.js";
import type { SuperGroup } from "./danger-ladder.js";
import { basisChangeDates, ECDF_READ_SPAN, ECDF_WINDOW, LEG_PILLAR_GENERATOR, rollingEcdfRank } from "./leg-percentile.js";
import { DUAL_AXIS_ID_SET } from "./domain-legs.js";
import { type State } from "./domain-types.js";

// `ewPct` is attached HERE, after `computeField` returns, and exists only on `LegRowDTO`: display-only,
// so it never reaches danger/subDangers/regime/inBand/held/band/notify. Served shape
// (growth:number|null) pinned by src/api/types.ts + openapi.yaml. Per served leg with a COMPARABLE EW
// pillar, rank the live value in that leg's stored `leg_pillars` EW series (newest ECDF_READ_SPAN rows,
// LEG_PILLAR_GENERATOR vintage; `rollingEcdfRank`). Cell arms:
//   • na         — pillarValue === null (uncomparable): no read issued (read-budget gate, not just correctness).
//   • warmup     — < ECDF_WINDOW non-null stored values in the read span; never imputed.
//   • pct        — the rank (+ `basisSpans` when the ranked window straddles a roster change).
//   • stale-basis — stored vintage ≠ live LEG_PILLAR_GENERATOR.
// READ BUDGET (vercel.json maxDuration 60): ≤ 9 reads (one per leg, fewer when uncomparable), each capped
// at ECDF_READ_SPAN rows server-side, all via Promise.all. A failed read degrades to `warmup` but LOGS
// first (C1) — a silent degrade hides "code deployed, migration not pushed".
/** The runtime half of `LegRowEngineOnly` (src/api/types.ts). `satisfies Record<LegRowEngineOnly, true>`
 *  links BOTH directions (key drift is a compile error). Never "fix" a red literal by widening the alias. */
const LEG_ROW_ENGINE_ONLY = { riskClass: true } as const satisfies Record<LegRowEngineOnly, true>;

export async function toServedField(
  store: ReadStore | null,
  field: FieldResult,
  mom: Map<string, number | null>,
  held: FieldResult["held"],
): Promise<FieldResult> {
  const cells = await Promise.all(field.legRows.map((r) => ewPctCell(store, r.sleeve, r.subDangers.earlyWarn)));
  const legRows = field.legRows.map((r, i) => {
    const row = {
      ...r,
      growth: r.growth?.live ? (r.growth.value as number) : null,
      volAdjMom: mom.get(r.sleeve) ?? null,
      ewPct: cells[i]!,
    };
    // THE ENGINE-ONLY STRIP: the `...r` spread carries every inherited leg field onto the wire; this
    // delete is the ONE place the read-API exclusion is made true in bytes (declared once by
    // `LegRowEngineOnly`, src/api/types.ts, which `LegRowDTO`'s `Omit` also reads).
    for (const k of Object.keys(LEG_ROW_ENGINE_ONLY)) delete (row as Record<string, unknown>)[k];
    return row;
  });
  const heldRow = held ? legRows.find((l) => l.sleeve === held.sleeve) ?? null : null;
  // Each row's `cells` (and `SignalCell.observed`) ride the `...r` spread UNMODIFIED: this seam adds
  // display fields, never reduces the cell.
  return { ...field, legRows, held: heldRow } as unknown as FieldResult;
}

/** The one super-group W4 ranks — the same `SuperGroup` literal the backfill walk writes into
 *  `leg_pillars.super_group`, so the read filter can never drift from the write. */
const EW_SUPER_GROUP = "EARLY-WARN" satisfies SuperGroup;

/** One leg's `ewPct` cell. EXPORTED FOR TEST: with `/lab` fixtures every EW pillar is scored, so the
 *  `na`/read-budget branches are unreachable from GET and must be pinned against this function directly. */
export async function ewPctCell(
  store: ReadStore | null,
  sleeve: string,
  ew: PillarScore,
  warn: (...args: unknown[]) => void = console.warn,
): Promise<PercentileCell> {
  const value = pillarValue(ew);
  if (value === null) return { kind: "na" };
  // No reachable store (degraded scenario path): `warmup`, never a fabricated rank.
  if (!store) return { kind: "warmup" };
  // LOG-THEN-DEGRADE: the `warmup` fallback must not 500 the board, but the log line is the ONLY signal
  // that separates a real failure (leg_pillars absent, or `assertNotTruncated`'s throw) from a warm-up.
  let readFailed = false;
  const points = await store
    .getLegPillarSeries(sleeve, EW_SUPER_GROUP, LEG_PILLAR_GENERATOR, ECDF_READ_SPAN)
    .catch((err: unknown) => {
      readFailed = true;
      warn(
        `[lab] ewPct read failed for sleeve=${sleeve} (${EW_SUPER_GROUP}/${LEG_PILLAR_GENERATOR}) - ` +
          `degrading to warmup: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    });
  // STALE-BASIS PROBE: LEG_PILLAR_GENERATOR is a hash over the pillar formula, so an engine edit mints
  // a new vintage and the generator-filtered read comes back empty — ambiguous between warmup and a
  // stale history. One extra 1-row read ONLY on the empty branch separates them. NOT issued after a
  // FAILED read (the probe would hit the same broken table; the logged warmup is the honest answer).
  if (!readFailed && points.length === 0) {
    const stored = await store.getLegPillarLatestGenerator(sleeve, EW_SUPER_GROUP).catch((err: unknown) => {
      warn(
        `[lab] ewPct stale-basis probe failed for sleeve=${sleeve} (${EW_SUPER_GROUP}) - ` +
          `degrading to warmup: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    });
    // Compared rather than assumed: a race with an in-flight regen must fall through to `warmup`,
    // never label the LIVE vintage stale.
    if (stored !== null && stored !== LEG_PILLAR_GENERATOR) {
      return { kind: "stale-basis", stored, live: LEG_PILLAR_GENERATOR };
    }
  }
  // `null` stored values are dropped, never coerced to 0 (that would bias every rank upward). We read
  // ECDF_READ_SPAN (= window + null slack) rather than exactly ECDF_WINDOW so holes don't strand a leg
  // at `warmup`; `rollingEcdfRank` ranks the newest ECDF_WINDOW, and falls short to `warmup` if holes
  // outnumber the slack.
  const closes: { date: string; value: number; basis: string }[] = points.flatMap((p) =>
    p.value === null ? [] : [{ date: p.date, value: p.value, basis: p.basis }],
  );
  const rank = rollingEcdfRank(
    closes.map((p) => p.value),
    value,
  );
  if (rank.kind === "warmup") return rank;
  // MIXED-BASIS DETECTION: `basis` is the roster hash each stored close was computed off. Inspect the
  // exact newest ECDF_WINDOW non-null closes the rank ran on, so it costs NO extra read. Serve the
  // number and mark the mix rather than printing `—`.
  const ranked = closes.slice(Math.max(0, closes.length - ECDF_WINDOW));
  const basisSpans = basisChangeDates(ranked);
  // OMITTED, not `undefined`, on a single-basis window: openapi.yaml's `pct` arm is
  // additionalProperties:false with basisSpans absent from `required`.
  return basisSpans.length > 0
    ? { kind: "pct", value: rank.value, basisSpans }
    : { kind: "pct", value: rank.value };
}

/** The ids worth attributing: DUAL_AXIS_IDS whose PERSISTED confirmed state is non-GREEN. The single
 *  gate — nothing downstream re-filters. R2/R3/R4 are absent (not in DUAL_AXIS_IDS: velocity-only, so
 *  "via velocity" is a tautology). */
export function dualAxisFiringIds(readings: { id: string; state: State }[]): string[] {
  return readings.filter((r) => DUAL_AXIS_ID_SET.has(r.id) && r.state !== "GREEN").map((r) => r.id);
}
