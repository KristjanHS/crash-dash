/**
 * /lab overlay composers: the display-only `OverlayView` projections (r4 / fallShape / vtp / r1 /
 * r5 / y1) and the hoisted leg-growth read, shared by both `/lab` paths in `api/lab.ts`.
 */

import type { ReadStore, SeriesPoint } from "./store.js";
import { LADDER, type GrowthRsLeg, type LabBand, type OverlayView } from "./families.js";
import { computeR1, R1_FLOOR_RUNG } from "./r1.js";
import { computeR5, R5_MIN_GROSS, R5_MIN_OBS, R5_TARGET_VOL } from "./r5.js";
import { computeLegRs, computeVolAdjMom, computeY1, Y1_LOOKBACKS, Y1_MARGIN, Y1_MIN_LEGS, Y1_MIN_OBS, Y1_PERSIST, type LegRsResult, type Sleeve } from "./y1.js";
import { RERISK_DWELL_DAYS } from "./danger-ladder.js";
import { VTP } from "./registry-composite.js";
import { VT_BACKWARDATION_RATIO, VT_STREAK_AMBER, VT_STREAK_RED } from "./family-descriptor-rows.js";
import { BEAR_DWELL_CLOSES, DD_GATE_FIELD_LABEL, drawdownGateWouldFire, FALL_SHAPE_CONFIDENCE_COPY, fallShapeConfidence, fallShapeChips, V_BEAR_INFLUENCE_ENABLED, V_VELOCITY_CUT, type FallShape } from "./v-bear.js";
import type { FallShapeOverlayViewDTO } from "./api/types.js";
import type { R4Phase } from "./r4.js";
import { legCloseId } from "./scoreboard.js";
import { LABEL_OF, prevTargetOf } from "./lab-assembly.js";

/** The wire label of r4's phase field — a LOOKUP KEY the FE matches by string (`R4_PHASE_LABEL`,
 *  public/overlay-strip.js, parity-pinned in overlay-strip.test.js). */
export const R4_PHASE_FIELD_LABEL = "phase";

/** The two restricted fields `/api/lab` always serves as "-" (`redactLab`, api/lab.ts). */
export const R4_HY_OAS_FIELD_LABEL = LABEL_OF.F1!;
export const FALL_VELOCITY_FIELD_LABEL = "velocity";

/** Blank one field's value to "-" (display only — the view's tone/confidence were computed off the real value). */
export function withholdField<V extends OverlayView>(view: V, label: string): V {
  return { ...view, fields: view.fields.map((f) => (f.label === label ? { ...f, value: "-" } : f)) };
}

/** The `/lab` R5 statistics over the held leg's licensed closes (3.5b, ruled 2026-11-25): the `fields` labels
 *  `resolveR5View` prints them under, plus its `headline` (`computeR5`'s reason quotes the realized vol). */
const R5_STAT_FIELD_LABELS = ["gross", "realized vol", "cash (R5)", "if wired"] as const;
const R5_WITHHELD_HEADLINE = "vol-target stats withheld";

/** The redacted R5 view: every `R5_STAT_FIELD_LABELS` value "-" (the `withholdField` idiom) and the headline
 *  replaced; label/tone/held leg/target vol/note stay. A degraded view (`gross` already "-" — `computeR5`
 *  sized nothing, its reason a warm-up/stale note) carries no statistic and passes through. Pure; a copy. */
export function withholdR5Stats<V extends OverlayView>(view: V): V {
  if (view.fields.every((f) => f.label !== "gross" || f.value === "-")) return view;
  const withheld = R5_STAT_FIELD_LABELS.reduce((v, label) => withholdField(v, label), view);
  return { ...withheld, headline: R5_WITHHELD_HEADLINE };
}

/** The redacted `growthRs`: every row's `rs` null (a leg with no defensible RS already reads that way); the
 *  LADDER-ordered sleeve list stays. Pure; a copy. */
export function withholdGrowthRs(rows: readonly GrowthRsLeg[]): GrowthRsLeg[] {
  return rows.map((r) => ({ ...r, rs: null }));
}

/** The band's r4 HY OAS tail row (`buildLabBand`, src/alert-band.ts): its `value` is the raw F1 level.
 *  Drift-guarded by api/lab.test.ts's whole-body falsifier, not a shared constant. */
export const R4_HY_OAS_MEMBER_ID = "r4-hyoas";

/** Null one band member's `value` at the wire edge (display only — its proximity `state`/`threshold` were
 *  computed off the real value). Returns a copy; `buildLabBand` output is never mutated. */
export function withholdBandMemberValue(band: LabBand, memberId: string): LabBand {
  return {
    ...band,
    floors: band.floors.map((f) =>
      f.members.some((m) => m.id === memberId)
        ? { ...f, members: f.members.map((m) => (m.id === memberId ? { ...m, value: null } : m)) }
        : f,
    ),
  };
}

/** Project the R4 cash-breaker state into the shared `OverlayView` — ONE projector for both `/lab`
 *  paths. Pure reshape; never recompute here. `reason` blank ⇒ `note` omitted. */
export function r4View(r4: {
  cash: boolean;
  phase: R4Phase | null;
  reentryRung: number | null;
  hyOas: number | null;
  vt: number | null;
  reason: string;
}): OverlayView {
  const tone: OverlayView["tone"] = r4.cash ? "alert" : r4.phase === "reentry" ? "reentry" : "neutral";
  return {
    id: "r4",
    label: "Cash / haven circuit-breaker",
    headline: r4.cash ? `in cash (${r4.phase ?? "—"})` : `phase: ${r4.phase ?? "—"}`,
    tone,
    fields: [
      { label: R4_PHASE_FIELD_LABEL, value: r4.phase ?? "-" },
      { label: "re-entry rung", value: r4.reentryRung == null ? "-" : String(r4.reentryRung) },
      // Registry label (F1's `Indicator.label`), never hand-typed.
      { label: R4_HY_OAS_FIELD_LABEL, value: r4.hyOas == null ? "-" : r4.hyOas.toFixed(2) },
      { label: "VIX/VIX3M", value: r4.vt == null ? "-" : r4.vt.toFixed(2) },
    ],
    ...(r4.reason ? { note: r4.reason } : {}),
  };
}

/** Project the PERSISTED W5-d fall-shape class into the shared `OverlayView` (display only).
 *  Read straight off the alert row (`fall_shape`/`fall_velocity`/`credit_dwell_closes`) — never
 *  re-derive here (a read-time recompute fetches a different vintage). LIVE ONLY. `note` is derived
 *  from `enabled` (default `V_BEAR_INFLUENCE_ENABLED`), never hardcoded. `confidence` rides as a first-class wire key. */
export function fallShapeView(
  shape: FallShape,
  velocity: number | null,
  dwell: number | null,
  enabled: boolean = V_BEAR_INFLUENCE_ENABLED,
): FallShapeOverlayViewDTO {
  const confidence = fallShapeConfidence(shape, velocity, dwell);
  const tone: OverlayView["tone"] = shape === "bear" ? "caution" : "neutral";
  const cuts = `fast <= ${(V_VELOCITY_CUT * 100).toFixed(2)} pp/day \u00b7 grinding >= ${BEAR_DWELL_CLOSES} closes`;
  return {
    id: "fallShape",
    label: "Fall shape",
    headline: `shape: ${shape} · ${confidence}`,
    tone,
    confidence,
    fields: [
      { label: "shape", value: shape },
      // The key plus its copy — never the bare key.
      { label: "confidence", value: `${confidence} - ${FALL_SHAPE_CONFIDENCE_COPY[confidence]}` },
      // Drawdown per trading day (pp/day — V_VELOCITY_CUT's units); null ⇒ "-".
      { label: FALL_VELOCITY_FIELD_LABEL, value: velocity == null ? "-" : `${(velocity * 100).toFixed(2)} pp/day` },
      { label: "credit dwell", value: dwell == null ? "-" : `${dwell} closes` },
      // DD-gate probe: measurement only, steers nothing. Label is `DD_GATE_FIELD_LABEL`
      // (src/v-bear.ts), not a literal — `public/overlay-strip.test.js` pins the FE spelling.
      { label: DD_GATE_FIELD_LABEL, value: drawdownGateWouldFire(shape) ? "would fire" : "off" },
    ],
    // Disclaimer derived from the kill switch, never hardcoded. The dd-gate clause stays OUTSIDE
    // the ternary (that ternary is W5-d's seam; folding it in would retire the probe's disclaimer).
    note: `${enabled ? cuts : `display only — influence disabled \u00b7 ${cuts}`} \u00b7 dd-gate probe: measurement only, steers nothing`,
  };
}

/** Promote the fall-shape verdict onto the `r4` floor head (and only that floor) via `fallShapeChips`.
 *  DISPLAY promotion at the wire edge — never in `buildLabBand` (the fall shape is not a notify input).
 *  `phase === "equity"` ⇒ `[]` ⇒ band returned untouched. */
export function withFallShapeChips(
  band: LabBand,
  phase: R4Phase,
  shape: FallShape,
  velocity: number | null,
  dwell: number | null,
): LabBand {
  const chips = fallShapeChips(phase, shape, fallShapeConfidence(shape, velocity, dwell));
  if (!chips.length) return band;
  return { ...band, floors: band.floors.map((f) => (f.id === "r4" ? { ...f, chips } : f)) };
}

/** Latest `VTP` close only: the streak IS that reading's `level` (scorers-composite.ts), so no window. */
const VTP_SERIES_LIMIT = 1;

/** R3 VT-backwardation persistence leg as a DISPLAY-ONLY overlay — unweighted, notify-excluded.
 *  Streak NOT computed here: reads the persisted `VTP` reading's `level` (`scoreVixTermPersistence-
 *  Indicator`, FAST_CONFIRMERS). LIVE ONLY; returns `null` (key omitted) when no `VTP` is stored. */
export async function resolveVixPersistenceView(
  store: ReadStore,
  warn: (...args: unknown[]) => void = console.warn,
): Promise<OverlayView | null> {
  const persisted = await store
    .getSeries(VTP.id, VTP_SERIES_LIMIT)
    .catch((err: unknown): SeriesPoint[] => {
      warn(`[lab] ${VTP.id} read failed - overlay omitted:`, err);
      return [];
    });
  // getSeries returns oldest→newest, so with limit 1 the tail IS the latest stored close.
  const latest = persisted.at(-1);
  if (!latest) return null;
  const streak = latest.value;
  const state = latest.state;
  return {
    id: "vtp",
    label: "Backwardation streak (VIX/VIX3M)",
    headline:
      streak === 0
        ? "calm - no days in backwardation"
        : `${streak} consecutive day${streak === 1 ? "" : "s"} in backwardation - ${state.toLowerCase()}`,
    // Never "alert" — chart-only; Amber/Red ⇒ caution at most.
    tone: state === "GREEN" ? "neutral" : "caution",
    fields: [
      { label: "streak", value: `${streak} closes` },
      { label: "state", value: state },
      {
        label: "cuts",
        value: `> ${VT_BACKWARDATION_RATIO.toFixed(2)} ratio · Amber ${VT_STREAK_AMBER}d / Red ${VT_STREAK_RED}d`,
      },
      // ⚠ "if wired" is an FE lookup key matched by string equality — never rename the label.
      {
        label: "if wired",
        value: `adds a VIX-backwardation confirm gate to notify (${state === "GREEN" ? "passes now" : "blocks"})`,
      },
    ],
    note: "chart-only · persisted + charted, but unweighted - steers no band, family, roll-up, or push",
  };
}

/** Resolve the R1 walk-down path into the shared `OverlayView` — one resolver for both `/lab` paths.
 *  ⚠ DISPLAY-ONLY: `nextRung` must never feed `computeField`/`dial.band`/anything `run-*.ts` reads.
 *  Falsifier: `grep -rn "computeR1" src/run-*.ts src/danger-engine.ts` → zero hits.
 *  Returns `null` (caller omits the `r1` key) when `path` is empty — cold start or already at target. */
export function resolveR1View(
  targetRung: number,
  priorRung: number | null,
  reriskConfirmCount: number,
  heldDays: number,
  /** The one surviving re-risk gate (`trendConfirming`, same read `run-core.ts` hands
   *  `decideRotationHold`); the headline branches on it, not a pure rung comparison. */
  trendOk: boolean,
): OverlayView | null {
  // computeR1 learns only whether a move is queued (`path` non-empty) and where it lands (`path`'s
  // last element = clamped dial target) — the engine jumps the held leg in one close, never steps.
  const r1 = computeR1(targetRung, priorRung, reriskConfirmCount);

  if (r1.path.length === 0) return null;

  // `path` is inclusive of the target, so its last element IS the (clamped) dial target.
  const destRung = r1.path[r1.path.length - 1] as number;
  const sleeveOf = (rung: number) => (LADDER as readonly string[])[rung - 1] ?? "-";
  // Re-clamp the prior to r1.ts's bounds [1, R1_FLOOR_RUNG] so an off-ladder prior matches computeR1.
  const heldRung = Math.min(R1_FLOOR_RUNG, Math.max(1, Math.round(priorRung as number)));
  // On the rung-1-aggressive axis a re-risk climbs to a LOWER rung number.
  const rerisk = destRung < heldRung;
  // ⚠ Two surviving divergences (`gateHeld` docblock is canonical): the trend veto, and the deadband/
  // prior-target asymmetry. Only the veto is waitable, so the copy branches on the real `trendOk`.
  const trendHeld = rerisk && !trendOk;

  // Earliest commit, in closes. `RERISK_DWELL_DAYS` is 0 ⇒ 0 every close; chip suppressed below.
  const earliest = Math.max(RERISK_DWELL_DAYS - heldDays, 0);
  // ⚠ Render gate: at `RERISK_DWELL_DAYS === 0` both chips are noise — derived from the constant,
  // never a restated 0, so a re-arm brings them back with no edit here.
  const dwellChipsLive = RERISK_DWELL_DAYS > 0;

  return {
    id: "r1",
    label: "Defensive-sector rotation",
    headline: `${rerisk ? (trendHeld ? "re-risk held by trend" : "re-risk pending") : "de-risk queued"}: r${heldRung} (${sleeveOf(heldRung)}) → r${destRung} (${sleeveOf(destRung)})`,
    // Never "alert" (R4's cash override): re-risk neutral, de-risk caution.
    tone: rerisk ? "neutral" : "caution",
    fields:
      rerisk && dwellChipsLive
        ? [
            { label: "earliest", value: `~${earliest} close${earliest === 1 ? "" : "s"}` },
            { label: "dwell", value: `${heldDays}/${RERISK_DWELL_DAYS}` },
          ]
        : [],
    note: trendHeld
      ? "blocked while a trend (uT) member is confirmed RED - commits on the first close after it clears · fires as one jump, not a gradual walk"
      : rerisk
        ? "trend is NOT vetoing - the held sleeve trails the dial target because the pick must clear the re-risk deadband (and the hold is the last cron close, not this read) · fires as one jump, not a gradual walk"
        : "fires as one jump, not a gradual walk",
  };
}

/** Pad beyond `R5_MIN_OBS` covering the store's per-date collapse over three venue calendars.
 *  Pure slack — `computeR5` reads only the newest points; over-fetch is deliberately generous. */
const R5_SERIES_PAD = 20;

/** Resolve R5 vol-target sizing into the shared `OverlayView` — one resolver for both `/lab` paths.
 *  R5 has no persisted state (pure function of the held leg's `LEGP_*` closes), so a read-time recompute
 *  cannot diverge. ⚠ DISPLAY-ONLY: `gross` must never feed `computeField`/`dial.band`/`run-*.ts`. Falsifier:
 *  `grep -rn 'r5\.js' src api public scripts | grep -v '\.test\.' | grep -v '^src/lab-overlays\.ts:' | grep -vE '^[^:]+:[0-9]+: *(\*|//)'`
 *  Returns `null` (key omitted) with no on-ladder held sleeve; a degraded series still renders. Never throws. */
export async function resolveR5View(
  store: ReadStore | null,
  heldSleeve: string | null | undefined,
  warn: (...args: unknown[]) => void = console.warn,
): Promise<OverlayView | null> {
  const sleeve = (LADDER as readonly string[]).includes(heldSleeve ?? "")
    ? (heldSleeve as (typeof LADDER)[number])
    : null;
  if (!sleeve) return null;

  const id = legCloseId(sleeve);
  const closes = store
    ? await store.getSeries(id, R5_MIN_OBS + R5_SERIES_PAD).catch((err: unknown): SeriesPoint[] => {
        warn(`[lab] ${id} read failed - R5 renders warming-up:`, err);
        return [];
      })
    : [];
  const r5 = computeR5(closes);

  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

  return {
    id: "r5",
    label: "Volatility targeting",
    headline: r5.reason,
    // Never "alert" (R4's cash override): cut-only, floored at R5_MIN_GROSS ⇒ caution at most;
    // degraded ⇒ neutral (the fail-safe is fully invested).
    tone: r5.gross == null || r5.gross >= 1 ? "neutral" : "caution",
    fields: [
      { label: "held leg", value: sleeve },
      { label: "gross", value: r5.gross == null ? "-" : pct(r5.gross) },
      { label: "realized vol", value: r5.realizedVol == null ? "-" : pct(r5.realizedVol) },
      { label: "target vol", value: pct(R5_TARGET_VOL) },
      // R5's OWN cash (not R4's); bounded by 1 − R5_MIN_GROSS.
      { label: "cash (R5)", value: r5.gross == null ? "-" : pct(1 - r5.gross) },
      {
        label: "if wired",
        value: `gross ${r5.gross == null ? "—" : pct(r5.gross)} (trims toward cash only if realized vol > ${pct(R5_TARGET_VOL)})`,
      },
    ],
    note: `R5 cash caps at ${pct(1 - R5_MIN_GROSS)} - anything deeper is R4's breaker, not sizing`,
  };
}

/** Pad beyond `Y1_MIN_OBS + Y1_PERSIST` covering the store's per-date collapse over three venue
 *  calendars (the date-intersected axis `computeLegRs` builds is shorter than any leg's row count).
 *  Pure slack — surplus rows ignored; 40 for holiday-stretch headroom at zero cost. */
const Y1_SERIES_PAD = 40;

/** ONE `getSeriesBulk` read of the nine `LEGP_*` series, hoisted above the pick so `computeField` and
 *  `resolveY1View` share it (sourcing off the resolver's return would cycle through the gate).
 *  `rs`/`mom` are the cron path's derivations over the push's served rows, estimates included (`pushLegSeries`). Never throws: a failed read warns ⇒ empty bulk. */
export async function loadLegGrowth(
  store: ReadStore | null,
  warn: (...args: unknown[]) => void = console.warn,
): Promise<{
  bulk: Map<string, SeriesPoint[]>;
  rs: Map<Sleeve, number | null>;
  mom: Map<Sleeve, number | null>;
}> {
  const ids = LADDER.map((sleeve) => legCloseId(sleeve));
  const bulk = store
    ? await store
        .getSeriesBulk(ids, { limit: Y1_MIN_OBS + Y1_PERSIST + Y1_SERIES_PAD })
        .catch((err: unknown) => {
          warn(`[lab] ${ids.join(",")} read failed - leg growth renders warming-up:`, err);
          return new Map<string, SeriesPoint[]>();
        })
    : new Map<string, SeriesPoint[]>();
  const legSeries = new Map<Sleeve, SeriesPoint[]>();
  for (const sleeve of LADDER) legSeries.set(sleeve, bulk.get(legCloseId(sleeve)) ?? []);
  return { bulk, rs: computeLegRs(legSeries).rs, mom: computeVolAdjMom(legSeries).mom };
}

/** Resolve the Y1 relative-strength pick into the shared `OverlayView` — one resolver for both `/lab`
 *  paths. Y1 is stateless (input = persisted `LEGP_*` closes), so `streak` is RECONSTRUCTED here by
 *  truncating and re-ranking — the reason Y1 must never gain a column (`src/y1.ts`).
 *  ONE `getSeriesBulk` over all nine `LEGP_*` ids, never nine `getSeries`. Falsifier (a COUNT, comment
 *  lines excluded via `grep -vE '^ *\*'`; `resolveR5View` legitimately makes one such call):
 *  `grep -cE 'getSeries\(legCloseId|getSeries\("LEGP_' src/lab-overlays.ts` → exactly **1**.
 *  ⚠ DISPLAY-ONLY: the pick must never feed `computeField`/`dial.band`/`run-*.ts`. Falsifier:
 *  `grep -rn 'computeY1\b' src api public scripts | grep -v '\.test\.' | grep -vE '^src/(lab-overlays|y1)\.ts:' | grep -vE '^[^:]+:[0-9]+: *(\*|//)'`
 *  Returns `null` (key omitted) with no store; a present view whose `margin` prints `—` is the
 *  warming-up degrade and renders. Never throws. */
export async function resolveY1View(
  store: ReadStore | null,
  heldSleeve: string | null | undefined,
  band: { lo: number; hi: number },
  /** The leg-close series, already read by `loadLegGrowth`; passed in (not re-fetched) to keep
   *  the request at ONE `getSeriesBulk`. */
  bulk: Map<string, SeriesPoint[]>,
): Promise<{
  view: OverlayView;
  growthRs: GrowthRsLeg[];
  lookbacksUsed: number;
  rs: Map<Sleeve, number | null>;
  mom: Map<Sleeve, number | null>;
} | null> {
  if (!store) return null;

  // Truncation axis = sorted DATE intersection of row-count-eligible legs, built exactly as
  // `computeLegRs` builds its own. ⚠ Cut by DATE, never by row count (`slice(length - drop)`):
  // row-count cuts collapse distinct `drop`s to one as-of and double-count the current close.
  const eligibleRows = LADDER.map((sleeve) => bulk.get(legCloseId(sleeve)) ?? []).filter(
    (rows) => rows.length >= Y1_MIN_OBS,
  );
  const truncAxis =
    eligibleRows.length < Y1_MIN_LEGS
      ? [] // `computeLegRs` returns all-null here anyway, so the as-of is moot
      : [...new Set((eligibleRows[0] as SeriesPoint[]).map((p) => p.date))]
          .filter((d) => eligibleRows.every((rows) => rows.some((p) => p.date === d)))
          .sort();

  const rsAt = (drop: number): LegRsResult => {
    const cutoff = drop === 0 ? null : (truncAxis[truncAxis.length - 1 - drop] ?? null);
    const legSeries = new Map<Sleeve, SeriesPoint[]>();
    for (const sleeve of LADDER) {
      const rows = bulk.get(legCloseId(sleeve)) ?? [];
      // `drop` past the axis ⇒ empty series (degrade to null), never reuse the newest close.
      legSeries.set(
        sleeve,
        drop === 0 ? rows : cutoff == null ? [] : rows.filter((p) => p.date <= cutoff),
      );
    }
    return computeLegRs(legSeries);
  };

  const current = rsAt(0);
  const rs = current.rs;
  // Per-leg vol-adjusted momentum off the SAME `bulk` (no 2nd fetch), display-only; threaded through
  // `computeField` to light the leg growth pillar.
  const currentLegSeries = new Map<Sleeve, SeriesPoint[]>();
  for (const sleeve of LADDER) currentLegSeries.set(sleeve, bulk.get(legCloseId(sleeve)) ?? []);
  const momResult = computeVolAdjMom(currentLegSeries);
  // Per-leg RS already ranked (reuses `current`, no 2nd computeLegRs), one row per sleeve.
  // `?? null` preserves a legitimate 0 RS (only null/undefined substituted), never conflating 0 with starved.
  const growthRs: GrowthRsLeg[] = LADDER.map((sleeve) => ({
    sleeve,
    rs: current.rs.get(sleeve) ?? null,
  }));
  // oldest→newest and EXCLUDING the current close, exactly as `computeY1` documents `rsHistory`.
  const rsHistory: Map<Sleeve, number | null>[] = [];
  for (let back = Y1_PERSIST; back >= 1; back--) rsHistory.push(rsAt(back).rs);

  const y1 = computeY1(rs, band, prevTargetOf(heldSleeve), rsHistory);

  const rungOf = (sleeve: string | null, rung: number | null) =>
    sleeve == null || rung == null ? "-" : `${sleeve} (rung ${rung})`;

  const view: OverlayView = {
    id: "y1",
    label: "Factor tilts",
    headline:
      current.lookbacksUsed === 1
        ? `${y1.reason} - 1 of ${Y1_LOOKBACKS.length} lookbacks only, RS is weaker than usual`
        : y1.reason,
    // Never "alert" (R4's cash override): Y1 moves only within band (D4); switch ⇒ caution, hold ⇒ neutral.
    tone: y1.switched ? "caution" : "neutral",
    fields: [
      { label: "pick", value: rungOf(y1.pickSleeve, y1.pickRung) },
      { label: "incumbent", value: rungOf(LADDER[y1.incumbentRung - 1] ?? null, y1.incumbentRung) },
      // In cross-sectional sd, the same unit as Y1_MARGIN — "—" means one side had no defensible RS.
      { label: "margin", value: y1.margin == null ? "-" : `${y1.margin.toFixed(2)} sd` },
      { label: "streak", value: `${y1.streak}/${Y1_PERSIST}` },
      { label: "lookbacks", value: `${current.lookbacksUsed}/${Y1_LOOKBACKS.length}` },
      { label: "candidates", value: `rungs ${y1.bounds.lo}-${y1.bounds.hi}` },
      {
        label: "if wired",
        value: `pick ${y1.pickSleeve ?? "—"} (r${y1.pickRung ?? "—"}) over ${(LADDER as readonly string[])[y1.incumbentRung - 1] ?? "—"} (r${y1.incumbentRung}) by rel-strength`,
      },
    ],
    note: `switch needs ${Y1_MARGIN} sd for ${Y1_PERSIST} closes; never more aggressive than the band's floor`,
  };
  return { view, growthRs, lookbacksUsed: current.lookbacksUsed, rs: current.rs, mom: momResult.mom };
}
