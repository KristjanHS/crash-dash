/**
 * Tests for GET /api/lab (api/lab.ts) — the wiring, not the panel math (that's
 * exhaustively covered in src/families.test.ts). We verify: 404 before any run,
 * readings→panel reduction on a seeded run, and that asOf/firedAt echo the verdict.
 *
 * Drives `handle` (the read-handler idiom) with its seams bound to this file's per-test state — a
 * swappable InMemoryStore, the HY-OAS vintage and a pinned clock — so no module mock is needed and the
 * file runs in the shared vitest project. NETWORK-FREE is pinned statically by
 * api/no-upstream-fetch.test.ts (the handler's transitive import graph), not by a fetch stub here.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { InMemoryStore } from "../src/store-memory.js";
import { PRUNE_DEGRADE_SCOPE, type CoverageDegrade, type StoredReading } from "../src/store.js";
import { makeAlert, makeDial, makeStoredReading } from "../src/test-helpers.js";
import { GLOBAL_FAMILIES, LADDER, type FamilyPanel, type LabResponse } from "../src/families.js";
import { ALL_INDICATORS, ID_SETS } from "../src/registry.js";
import { SLOW_INDICATOR_IDS } from "../src/registry-price.js";
import { VTP } from "../src/registry-composite.js";
import {
  backwardationStreak,
  vixTermPersistenceReadingSeries,
  vixTermPersistenceState,
} from "../src/scorers-composite.js";

/** The R4 overlay's HY field label is read off F1's registry `Indicator.label` (src/lab-overlays.ts `r4View`),
 *  so pin the expectation against that same source rather than hand-typing it (the hyphenated
 *  "HY-OAS" form was retired 2026-07-24; prose-names.test.ts guards drift back to it). */
const F1_LABEL = ALL_INDICATORS.find((i) => i.id === "F1")!.label;
import type { State } from "../src/domain-types.js";
import type { Observation } from "../src/domain-types.js";
import { R4_ENTER_RUNG, R4_HY_TAIL, R4_VT_TAIL } from "../src/r4.js";
// @ts-expect-error — public/*.js ships no .d.ts; vitest resolves it at runtime (allowJs is off).
// Same idiom as public/prose-names.test.ts. The one served ?hist window (P12.b).
import { LAB_LOOKBACK } from "../public/lab-lookback.js";
import { WALK_CAP } from "../src/lab-request.js";
import { assembleDial } from "../src/dial-assembly.js";
import { DIAL_FAMILIES, LEG_FIELD } from "../src/danger-ladder.js";
import { ECDF_WINDOW, LEG_PILLAR_GENERATOR } from "../src/leg-percentile.js";
import {
  B1_OVERRIDES_PER_YEAR,
  legCloseId,
  MIN_UI_RUNS,
  SB_BENCH_ID,
  SB_STRAT_ID,
} from "../src/scoreboard.js";
import { HY_STITCHED_NOTE } from "../src/replay.js";
import { resetVintageMemo } from "../src/api/vintage-memo.js";
import { SYNTH_HISTORY_LIMIT } from "../src/synth-cuts.js";
import { ewPctCell, handle, labFullBody, legHistoryLimitFor, type LabSeams } from "./lab.js";
import { priceLegReadingSeries } from "../src/pension.js";
import { todayOnFeedCalendar } from "../src/dates.js";
import { DEGRADED_HEADERS, VINTAGE_HEADERS } from "../src/api/http.js";
import { CADENCE_OF, FEED_TZ_OF, lagTier } from "../src/feed-lag.js";
import { ESTIMATE_OVER_READ } from "../src/estimated.js";
import { R5_MIN_GROSS, R5_MIN_OBS } from "../src/r5.js";
import { Y1_MIN_OBS, Y1_PERSIST } from "../src/y1.js";
import { FALL_SHAPE_CONFIDENCE_VALUES } from "../src/v-bear.js";
import type { FallShapeOverlayViewDTO } from "../src/api/types.js";

// `let` so each test can swap in a fresh store; the bound `storeOf` reads it per call.
let store = new InMemoryStore();
// A throwing thunk models the real getStore's FAIL-LOUD on missing SUPABASE_URL/SUPABASE_SERVICE_KEY (store.ts).
const unconfiguredStore = (): never => {
  throw new Error("[store] SUPABASE_URL and SUPABASE_SERVICE_KEY are required.");
};

// ── VINTAGE SEAM (review 2026-08-01, C1) ───────────────────────────────────────────────────────
// The `?replay=` branch stitches the committed HY-OAS vintage onto the STORED input tail. Injected,
// not read from disk: a clean, AGREEING vintage/tail pair by default (not `[]`), because the replay
// branch may reach the real `stitchHyOas` from any case and an empty vintage is one of its fail-loud
// conditions. That the handler never fetches upstream is api/no-upstream-fetch.test.ts's job.
const HY_VINTAGE_DEFAULT: Observation[] = Array.from({ length: 400 }, (_, i) => ({
  date: new Date(Date.parse("2022-01-01") + i * 86_400_000).toISOString().slice(0, 10),
  value: 5,
}));
let hyVintage: Observation[] = HY_VINTAGE_DEFAULT;
// The request clock a describe pins (`undefined` ⇒ the handler's own `new Date()`).
let clock: Date | undefined;

/** The handler under test, seams bound to the state above; `seams` overrides per call (e.g. a `warn` sink). */
function GET(request?: Request, seams: Partial<LabSeams> = {}): Promise<Response> {
  return handle(() => store, request, { vintage: () => hyVintage, ...(clock ? { now: clock } : {}), ...seams });
}

/** The FULL body (`labFullBody`, the withheld statistics in place) on the same seams — what `handle` redacts. */
async function FULL(request?: Request): Promise<LabResponse> {
  return (await labFullBody(() => store, request, { vintage: () => hyVintage, ...(clock ? { now: clock } : {}) })) as LabResponse;
}

/** A warn sink recording every call's args — injected as `warn`, never a console spy (that re-isolates this file). */
function warnSink(): { warn: (...args: unknown[]) => void; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return { warn: (...args) => void calls.push(args), calls };
}

/** `target` with `overrides` shadowing the named methods — a Proxy, not a vitest spy (a spy re-isolates
 *  this file). Methods run with the PROXY as `this`, so a store method's internal self-call (e.g.
 *  `getSeriesBulk` → `this.getSeries`) still hits an override, exactly as an instance spy did. */
function overriding<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(t, p, r) {
      if (Object.hasOwn(overrides, p)) return overrides[p as keyof T];
      return Reflect.get(t, p, r) as unknown;
    },
  });
}

// P12.a: the vintage memo is MODULE-LEVEL state inside api/lab.ts — clear it per test, or a
// cached synth/ciss promise from one test's store would be served against the next test's.
beforeEach(() => resetVintageMemo());

const RUN_AT = "2026-06-25T21:00:00.000Z";

// Minimal alert whose firedAt === the run's run_at (the commit point /lab reads).
const alert = makeAlert();

function sr(indicatorId: string, state: State): StoredReading {
  return { date: "2026-06-25", indicatorId, value: 1, delta20: 0, rawState: state, state };
}

// CURATED seed (stage3 §7-H2: HISTORY, not a registry axis) — this 14-id all-green panel mixes
// channels (FIN/RATE/COINCIDENT/CONTEXT) and deliberately omits scored ids (F3, EBP, G1, SPCONC,
// the GLOBAL legs…) whose presence would CHANGE the family panel under test ("geopolitics
// absent" is asserted). No honest indicatorIds() expression reproduces this membership, so it
// stays one curated literal, guarded against the registry universe by the curated-seed guard
// test in this file (`GREEN_SEED stays a subset of the registry id universe`).
const GREEN_SEED: readonly string[] = [
  "F1", "F2", "R5", "R6", "VT", "R1", "R2", "R3", "R4", "R7", "F4", "F5", "NVDA", "CG",
];


test("GREEN_SEED stays a subset of the registry id universe (curated-seed guard)", () => {
  expect(GREEN_SEED.every((id) => ID_SETS.all.includes(id))).toBe(true);
});


describe("GET /api/lab", () => {
  test("404 before any run is recorded", async () => {
    store = new InMemoryStore();
    const res = await GET();
    expect(res.status).toBe(404);
  });

  test("reduces the latest run's readings to the family panel + run identity", async () => {
    store = new InMemoryStore();
    // Credit AMBER (EBP), everything else the live families green; the unscored valuation family + geopolitics absent.
    const green = GREEN_SEED;
    await store.recordRun(
      // F1/VT carry DISTINCT, non-default values so the `HY OAS` / `VIX/VIX3M` field pin below
      // is a real read of THIS run's rows (sr's default `value: 1` would render 1.00 for both,
      // and a swapped/dropped lookup would still pass).
      [sr("EBP", "AMBER"), ...green.map((id) => sr(id, "GREEN"))].map((r) =>
        r.indicatorId === "F1"
          ? { ...r, value: 4.2 }
          : r.indicatorId === "VT"
            ? { ...r, value: 1.05 }
            : r,
      ),
      RUN_AT,
      // Non-null r4Phase AND r4ReentryRung so the overlay pin below is non-vacuous: with the
      // helper's defaults (both null) every field renders the "—" placeholder and the headline
      // reads "phase: —" whether or not the live branch actually reads the persisted columns.
      { ...alert, r4Phase: "reentry" as const, r4ReentryRung: 3 },
    );

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as LabResponse;

    expect(body.mode).toBe("live");
    // Stage 0.1: the R4 overlay rides the shared `overlays` record, projected from the
    // PERSISTED verdict.r4* columns — the headline carries the phase, tone says "armed".
    const liveR4 = body.overlays.r4!;
    expect(liveR4.id).toBe("r4");
    expect(liveR4.headline).toContain("reentry");
    // R1 (2026-07-18): phase `reentry` now gets its OWN tone rather than collapsing to
    // "caution" — that collapse is what cost the ◆ climb marker on the strip.
    expect(liveR4.tone).toBe("reentry");
    // Whole-shape pin: phase/rung/VT trace to distinct seeded inputs; F1 is seeded (4.20) yet served
    // "-" — withholdField drops the licensed HY OAS level from the shared body.
    expect(liveR4.fields).toEqual([
      { label: "phase", value: "reentry" },
      { label: "re-entry rung", value: "3" },
      { label: F1_LABEL, value: "-" },
      { label: "VIX/VIX3M", value: "1.05" },
    ]);
    // The live DENOMINATOR excludes the unscored valuation family and geopolitics (no G1).
    expect(body.liveFamilyCount).toBe(5);
    expect(body.firingCount).toBe(1); // only Credit is amber-or-worse
    // run identity echoed from the verdict.
    expect(body.asOf).toBe(alert.date);
    expect(body.firedAt).toBe(RUN_AT);
    // BUG-2 (W2-d): the persisted band-reason rides the live snapshot verbatim.
    expect(body.bandReason).toBe("regime");
    // the valuation family renders but is excluded from scoring.
    expect(body.families.find((f) => f.key === "valuation")!.live).toBe(false);
    // Rung 3 (Stage 5.1): it carries its REASON on the wire so /lab can render
    // "awaiting feed — …" instead of the generic empty state. Present on `valuation` only —
    // a blanket field would paint the awaiting copy over every live tile.
    expect(body.families.find((f) => f.key === "valuation")!.awaiting).toMatch(/regional CAPE/);
    for (const f of body.families.filter((f) => f.key !== "valuation")) {
      expect(f.awaiting).toBeUndefined();
    }

    // slice-3 i7a: the danger field is always present — legRows + band + held.
    expect(body.field).toBeDefined();
    expect(body.field.legRows.length).toBeGreaterThan(0);
    expect(body.field.band).toEqual(body.t1dial.band);
    // Stage 2.2: the two Level-1.5 super-group pillars ride every leg row on the wire.
    expect(
      body.field.legRows.every(
        (l) => "earlyWarn" in l.subDangers && "stressNow" in l.subDangers,
      ),
    ).toBe(true);
    // §5 UI: the display-only per-leg `trend` read rides every leg
    // row too — `{ value: number|null, counting: boolean }` (value null where the leg has no uT cell).
    expect(
      body.field.legRows.every(
        (l) =>
          l.trend != null &&
          (l.trend.value === null || typeof l.trend.value === "number") &&
          typeof l.trend.counting === "boolean",
      ),
    ).toBe(true);
    // OQ-5 Stage 5.4 — the per-cell OBSERVATION census rides every served cell. A RUNTIME pin, and
    // it has to be: `toServedField` ends in `as unknown as FieldResult`, so a handler that dropped
    // or reshaped `observed` would still typecheck, and `src/api/contract.test.ts` only proves the
    // TYPE and the YAML agree — not that the bytes reach the client.
    const servedCells = body.field.legRows.flatMap((l) => l.cells);
    expect(servedCells.length).toBeGreaterThan(0);
    for (const c of servedCells) {
      expect(c.observed, `cell ${c.family} carries its census`).toBeDefined();
      for (const k of ["fresh", "lag", "absent"] as const) {
        expect(Number.isInteger(c.observed[k])).toBe(true);
        expect(c.observed[k]).toBeGreaterThanOrEqual(0);
      }
    }
    // A MEASURED cell (N > 0) quantifies over exactly its leg-relevant members, so the census
    // must be a partition of N — that is what makes it readable as "3 of 5 members reported".
    const measured = servedCells.filter((c) => c.N > 0);
    expect(measured.length).toBeGreaterThan(0);
    for (const c of measured) expect(c.observed.fresh + c.observed.lag + c.observed.absent).toBe(c.N);
    // NON-VACUITY, both halves: this fixture must actually exercise a measured cell AND actually
    // contain an absent member (GREEN_SEED deliberately omits scored ids), or the partition check
    // above and the FE's absent marking would be pinned against an all-zero census.
    expect(servedCells.some((c) => c.N > 0)).toBe(true);
    expect(servedCells.some((c) => c.observed.absent > 0)).toBe(true);
    // `held` is the calmest-in-band leg or null; either way the key is present.
    expect("held" in body.field).toBe(true);
    // No ?hist ⇒ momentum is NOT computed on any leg (zero momentum cost).
    expect(body.field.legRows.every((l) => l.momentum === undefined)).toBe(true);
  });

  // ── SHARED-FIXTURE PAIR (merged 2026-09-01): two reader tests over ONE `[sr("F1","GREEN")]`
  // served run. Each formerly re-ran the full handler over the IDENTICAL seed; the GET now happens
  // once in beforeAll and both tests read the same `body`. (The W4 4.3 `pct` test below is NOT
  // part of the pair — it seeds a full ECDF_WINDOW of leg pillars, a different fixture.)
  describe("served leg rows on the [sr(F1,GREEN)] run (shared GET)", () => {
    let body: LabResponse;
    beforeAll(async () => {
      store = new InMemoryStore(); // a run, but no LEGP_* ⇒ rs/mom null on every leg
      await store.recordRun([sr("F1", "GREEN")], RUN_AT, alert);
      body = (await (await GET(new Request("https://lab.test/api/lab"))).json()) as LabResponse;
    });

    // G1 Stage 1.3b: every served leg row carries the FLATTENED growth pillar (number|null, not the
    // {value,live} object) + the raw volAdjMom. On a store with a run but NO LEGP_* series, rs/mom are
    // null everywhere, so the served growth is the `uT` TREND TERM ALONE — which is what makes this a
    // real check rather than a shape assertion.
    test("G1: /lab leg rows carry a flattened growth (number|null) + volAdjMom; the trend term is live on every leg", async () => {
      const rows = body.field.legRows as unknown as { sleeve: string; growth: number | null; volAdjMom: number | null }[];
      expect(rows.length).toBeGreaterThan(0);
      for (const l of rows) {
        expect(l).toHaveProperty("growth");
        expect(l).toHaveProperty("volAdjMom");
        // Flattened at the boundary: a number or null, never the engine's {value,live} object.
        expect(l.growth === null || typeof l.growth === "number").toBe(true);
      }
      // Still discriminating: with rs/mom null everywhere, growth is the trend term ALONE, so any
      // regression that stops the `uT` cell resolving on a leg reds this.
      expect(rows.every((l) => typeof l.growth === "number")).toBe(true);
    });

    test("every served leg row carries the display-only `familiesLit` counts", async () => {
      const rows = body.field.legRows;
      expect(rows.length).toBeGreaterThan(0);
      const bad = rows.filter((l) => [l.familiesLit?.earlyWarn, l.familiesLit?.stressNow].some((c) => !Number.isInteger(c?.of)));
      expect(bad.map((l) => l.sleeve)).toEqual([]);
    });

    // THE ENGINE-ONLY STRIP (2026-08-02, seating Stage 3 review). `LegRow extends LegField`, so every
    // field added to the leg-property row reaches the wire by inheritance through `toServedField`'s
    // `...r` spread — `riskClass` did exactly that when it was declared, undocumented in `openapi.yaml`.
    // `toServedField` now deletes the `LegRowEngineOnly` keys, and this is the only check that the
    // BYTES agree: the handler ends in `as unknown as FieldResult`, so tsc cannot see the served shape,
    // and `src/api/contract.test.ts` types a hand-written literal rather than handler output.
    // Asserted over the JSON round-trip (what the client actually receives), on `legRows` AND on
    // `held` — `held` is a second reference into the same rows and would leak on its own if the strip
    // were applied to only one of them. Red demo: drop the `delete` loop in `toServedField` ⇒ reds
    // with `sleeve Semis serves no riskClass`.
    test("no engine-only field rides a served leg row (riskClass is stripped at toServedField)", async () => {
      const rows = body.field.legRows as unknown as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(0); // vacuity guard: an empty ledger would pass the loop
      // Non-vacuity of the FIELD itself: the engine row this is stripped FROM must really carry it,
      // or the loop below would be green against an engine that never had the field.
      expect(LEG_FIELD.every((l) => l.riskClass === "cyclical" || l.riskClass === "defensive")).toBe(true);
      for (const l of rows) {
        expect(Object.keys(l), `sleeve ${String(l.sleeve)} serves no riskClass`).not.toContain("riskClass");
      }
      const heldRow = body.field.held as unknown as Record<string, unknown> | null;
      expect(heldRow).not.toBeNull();
      expect(Object.keys(heldRow!)).not.toContain("riskClass");
      // The row is otherwise INTACT — the strip removes one key, it does not reshape the row.
      expect(rows.every((l) => typeof l.sleeve === "string" && typeof l.risk === "number")).toBe(true);
    });
  });

  // W4 Stage 4.3 — `toServedField` ends in `as unknown as FieldResult`, so tsc cannot see the served
  // `ewPct`. This is the only check that the rolling ECDF is actually WIRED into the handler: `src/leg-percentile.test.ts` proves the
  // arithmetic, but a `toServedField` that never called it would leave that suite green.
  test("W4 4.3: with ≥ECDF_WINDOW stored pillar closes, a comparable leg serves a real `pct` arm", async () => {
    store = new InMemoryStore();
    await store.recordRun([sr("F1", "GREEN")], RUN_AT, alert);
    // Seed a full window for EVERY leg, so which legs end up `na` is decided by the ENGINE (an
    // uncomparable EW pillar), never by which sleeve we happened to seed.
    const day = (i: number) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    for (const leg of LEG_FIELD) {
      await store.putLegPillars(
        Array.from({ length: ECDF_WINDOW }, (_, i) => ({
          obsDate: day(i),
          sleeve: leg.sleeve,
          superGroup: "EARLY-WARN",
          // 0 … just under 1, ascending — so any live pillar value ranks strictly inside (0,1].
          value: i / ECDF_WINDOW,
          estimated: false,
          basis: "F1,F2",
          generator: LEG_PILLAR_GENERATOR,
        })),
      );
    }
    const res = await GET(new Request("https://lab.test/api/lab"));
    const body = (await res.json()) as LabResponse;
    const rows = body.field.legRows as unknown as {
      sleeve: string;
      subDangers: { earlyWarn: { kind: string } };
      ewPct?: { kind?: string; value?: number };
    }[];
    const priced = rows.filter((l) => l.ewPct?.kind === "pct");
    // Non-vacuity: the `pct` arm is REACHED. Without this the loop below passes on an all-`na` board.
    expect(priced.length).toBeGreaterThan(0);
    for (const l of priced) {
      expect(typeof l.ewPct!.value).toBe("number");
      expect(l.ewPct!.value).toBeGreaterThan(0);
      expect(l.ewPct!.value).toBeLessThanOrEqual(1);
    }
    // Every leg on this fixture has a SCORED EW pillar, so `pct` is the only admissible arm here.
    // (The na / warmup / stale-basis arms are pinned at the seam, src/lab-served-field.test.ts.)
    for (const l of rows) {
      expect(l.subDangers.earlyWarn.kind).toBe("scored");
      expect(l.ewPct?.kind).toBe("pct");
    }
  });

  // C1 (persist-assembled-dial, Stage 3): the LIVE branch must SERVE the persisted `dial_state`
  // blob off the row it reads, NOT recompute the dial from the readings. We seed an all-GREEN panel
  // (whose recompute is an unmistakably CALM dial — targetRung 1, band {1,3}, "Calm") but persist a
  // distinctive CRISIS `dialState`. If the handler recomputed, `t1dial.targetRung` would be 1 and the
  // band {1,3}; serving the persisted blob makes it 8 / {6,8} / "Crisis". Mutating the live-branch
  // `hydrateOrComputeT1Dial(verdict.dialState, …)` back to a bare recompute turns every assert below red.
  test("live branch serves the persisted dial_state (hydrate), not a recompute", async () => {
    store = new InMemoryStore();
    const green = GREEN_SEED;
    // A dial no all-green recompute could ever produce — the falsifier for a silent recompute.
    const persistedDial = makeDial(
      {
        // rung 7.6 ⇒ dangerScore 0.825 ⇒ targetRung 8, and a fully-split leader axis ⇒ band {6,8}.
        // `creditFiring` is what EARNS the "Crisis" label at that score (applyCrisisGate demotes an
        // uncorroborated Crisis to Stress) and is coherent with the 2 firing leaders below — the
        // whole book DERIVED, so it stays one production can emit.
        rung: 7.6,
        armed: true,
        fired: true,
        leadingFiring: 2,
        coincidentFiring: 2,
        positionP: 0.5,
        headline: "HYDRATED-FROM-PERSISTED",
      },
      { leaderSplit: 1, creditFiring: true },
    );
    await store.recordRun(
      green.map((id) => sr(id, "GREEN")),
      RUN_AT,
      { ...alert, dialState: persistedDial },
    );

    const body = (await (await GET()).json()) as LabResponse;
    expect(body.mode).toBe("live");
    // The WHOLE persisted object rides the wire verbatim — a recompute would replace it wholesale.
    expect(body.t1dial).toEqual(persistedDial);
    // Spell out the load-bearing fields so a partial recompute (band-only, rung-only) can't slip: an
    // all-green recompute yields targetRung 1 / band {1,3} / "Calm".
    expect(body.t1dial.targetRung).toBe(8);
    expect(body.t1dial.band).toEqual({ lo: 5, hi: 8 }); // fixed-width: dialBandFor(8, split→1)
    expect(body.t1dial.regime).toBe("Crisis");
    expect(body.t1dial.headline).toBe("HYDRATED-FROM-PERSISTED");
    // The danger field bands off the SAME (hydrated) dial — the read/notify agreement C1 guarantees.
    expect(body.field.band).toEqual(persistedDial.band);
  });

  // E12/E2: display surfaces read `display_*`;
  // the band chain and `dialFamilies` stay notify — identical to the same row with display null.
  // §7 Stage C′ (persist-panel), the legacy arm: the LIVE branch SERVES the persisted `panel_state` blob
  // off the row it reads, NOT an `assembleDial` recompute — the notify panel carries a SENTINEL label an
  // all-green recompute could never reproduce. Mutating the live-branch `verdict.panelState ?? (await
  // assembleDial(...))` back to a bare recompute reverts the label ⇒ the NOTIFY-PANEL asserts red. The
  // null-`panel_state` recompute fallback is pinned by the B-11 LIVE-path `dialFamilies` test
  // (makeAlert's panelState defaults to null); the jsonb round-trip by src/store.pure-seams.test.ts.
  test("E12: board/headline/field serve the display dial + panel; band + dialFamilies stay notify", async () => {
    const assembled = await assembleDial({
      readings: GREEN_SEED.map((id) => ({ id, state: "GREEN" as const })),
      asOf: alert.date,
      store: new InMemoryStore(),
    });
    const notifyDial = makeDial({ headline: "NOTIFY" });
    const displayDial = makeDial(
      { rung: 7.6, armed: true, fired: true, leadingFiring: 2, coincidentFiring: 2, positionP: 0.5, headline: "DISPLAY" },
      { leaderSplit: 1, creditFiring: true },
    );
    const g0 = assembled.globalPanel[0]!.key;
    const d0 = assembled.displayPanel[0]!.key;
    const tag = (fs: FamilyPanel[], label: string) => fs.map((f, i) => (i === 0 ? { ...f, label } : f));
    const panelTagged = (label: string) => ({
      ...assembled,
      globalPanel: tag(assembled.globalPanel, label),
      displayPanel: tag(assembled.displayPanel, label),
    });
    const notifyPanel = panelTagged("NOTIFY-PANEL");
    const displayPanel = panelTagged("DISPLAY-PANEL");
    const serve = async (display: boolean) => {
      store = new InMemoryStore();
      await store.recordRun(GREEN_SEED.map((id) => sr(id, "GREEN")), RUN_AT, {
        ...alert,
        dialState: notifyDial,
        panelState: notifyPanel,
        displayDialState: display ? displayDial : null,
        displayPanelState: display ? displayPanel : null,
      });
      return (await (await GET()).json()) as LabResponse;
    };
    const legacy = await serve(false);
    const body = await serve(true);
    expect(legacy.mode).toBe("live");
    // Legacy (display null): both served rosters are the PERSISTED notify panel, not a recompute.
    expect(legacy.dialFamilies.find((f) => f.key === g0)!.label).toBe("NOTIFY-PANEL");
    expect(legacy.globalFamilies.find((f) => f.key === d0)!.label).toBe("NOTIFY-PANEL");
    expect(legacy.t1dial).toEqual(notifyDial);
    expect(body.t1dial).toEqual(displayDial);
    expect(body.field.band).toEqual(displayDial.band);
    expect(body.globalFamilies.find((f) => f.key === d0)!.label).toBe("DISPLAY-PANEL");
    expect(body.band!.chain.regime).toBe(notifyDial.regime);
    expect(body.band).toEqual(legacy.band);
    expect(body.dialFamilies).toEqual(legacy.dialFamilies);
  });

  // I1 regression: on the LIVE path the danger-field `held` marker MUST be the M5
  // re-risk-confirm-GATED sleeve that persisted + pushed to ntfy (verdict.heldSleeve),
  // NOT computeField's stateless/ungated in-band pick. We force divergence: all-green
  // panel ⇒ calm band whose ungated calmest-in-band pick is the aggressive "Semis"
  // leg, while the persisted verdict still holds a defensive sleeve mid re-risk-confirm.
  test("live danger-field held == verdict.heldSleeve (gated), not computeField's ungated pick", async () => {
    store = new InMemoryStore();
    const green = GREEN_SEED;
    const HELD = "Staples"; // a defensive leg the gate is still holding as danger falls
    await store.recordRun(
      green.map((id) => sr(id, "GREEN")),
      RUN_AT,
      { ...alert, heldSleeve: HELD },
    );

    const body = (await (await GET()).json()) as LabResponse;
    // The marker on the wire is the GATED sleeve…
    expect(body.field.held).not.toBeNull();
    expect(body.field.held!.sleeve).toBe(HELD);
    // …and it diverges from computeField's ungated calmest-in-band pick (an all-green
    // calm band would otherwise mark the most-aggressive in-band leg, not Staples).
    const ungatedCalmest = [...body.field.legRows]
      .filter((l) => l.risk >= body.field.band.lo && l.risk <= body.field.band.hi)
      .sort((a, b) => a.danger - b.danger || a.risk - b.risk)[0];
    expect(ungatedCalmest!.sleeve).not.toBe(HELD); // proves the override actually moved the marker
  });

  // --- R3 (EW-13) vtp overlay fixtures -------------------------------------------------------
  // Since stage B.4 the overlay READS the persisted `VTP`
  // reading instead of re-walking the raw ^VIX/^VIX3M closes at the wire edge. Both halves of the
  // fixture are derived from producers, never hand-typed: the raw legs from a backwardation
  // pattern, the persisted rows from `vixTermPersistenceReadingSeries` (the very series
  // `scripts/backfill.ts` / the FAST confirmer emit).
  const vtpLegs = (dates: string[], back: boolean[]) => ({
    // ratio 22/20 = 1.1 > VT_BACKWARDATION_RATIO on a backwardation day, 18/20 = 0.9 otherwise.
    vix: dates.map((date, i) => ({ date, value: back[i] ? 22 : 18 })),
    vix3m: dates.map((date) => ({ date, value: 20 })),
  });
  const vtpRawRows = (legs: ReturnType<typeof vtpLegs>): StoredReading[] =>
    legs.vix.flatMap((p, i) => [
      makeStoredReading("VIX", { date: p.date, value: p.value }),
      makeStoredReading("VIX3M", { date: p.date, value: legs.vix3m[i]!.value }),
    ]);
  const vtpPersistedRows = (legs: ReturnType<typeof vtpLegs>): StoredReading[] =>
    vixTermPersistenceReadingSeries(VTP, legs.vix, legs.vix3m).map((r) => ({
      date: r.date,
      indicatorId: VTP.id,
      value: r.level,
      delta20: r.delta20,
      rawState: r.rawState,
      state: r.state,
      decision: r.decision,
    }));
  // EXACTLY-5 streak: one non-backwardation close then 5 backwardation closes → Amber (EW-11 cut).
  const FIVE_DATES = ["2026-06-18", "2026-06-19", "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25"];
  const FIVE_BACK = [false, true, true, true, true, true];

  // DISPLAY-ONLY, UNWEIGHTED: the overlay must render on the live path yet move neither the notify
  // band nor any family/leg. Control = same panel with no VTP history at all ⇒ key omitted.
  test("surfaces the chart-only vtp streak overlay without moving band/families", async () => {
    const green = GREEN_SEED;

    // Control: identical green panel, NO VTP reading stored ⇒ vtp OMITTED — the feed-down null
    // fail-safe (`scoreVixTermPersistenceIndicator` emits NOTHING when either ^VIX leg is empty, so "no
    // VTP row" IS the feed-down case), never a fabricated 0-day "calm". Raw ^VIX/^VIX3M closes ARE
    // present (a 5-day streak), so the omission also proves the wire edge never recomputes from them.
    store = new InMemoryStore();
    await store.recordReadings(vtpRawRows(vtpLegs(FIVE_DATES, FIVE_BACK)), "2026-06-25T20:00:00.000Z");
    await store.recordRun(green.map((id) => sr(id, "GREEN")), RUN_AT, alert);
    const control = (await (await GET()).json()) as LabResponse;
    expect("vtp" in control.overlays).toBe(false);

    // Treatment: same panel PLUS the persisted VTP readings for a 5-close backwardation run.
    store = new InMemoryStore();
    await store.recordReadings(
      vtpPersistedRows(vtpLegs(FIVE_DATES, FIVE_BACK)),
      "2026-06-25T20:00:00.000Z",
    );
    await store.recordRun(green.map((id) => sr(id, "GREEN")), RUN_AT, alert);
    const body = (await (await GET()).json()) as LabResponse;

    // (1) The overlay renders, Amber at streak 5 — read straight off the persisted reading, with
    // NO raw ^VIX/^VIX3M rows in the store at all (the pre-B.4 re-walk had nothing to walk).
    const vtp = body.overlays.vtp!;
    expect(vtp.id).toBe("vtp");
    expect(vtp.fields.find((f) => f.label === "streak")!.value).toBe("5 closes");
    expect(vtp.fields.find((f) => f.label === "state")!.value).toBe("AMBER");

    // (2) Chart-only invariant: the Amber streak moved NEITHER the notify band NOR the
    // family firing count vs. the control — it feeds no roll-up (band IS the notify band).
    expect(body.field.band).toEqual(control.field.band);
    expect(body.firingCount).toBe(control.firingCount);
    // …and the streak identity is in no dial family / leg.
    expect(body.globalFamilies.flatMap((f) => f.members.map((m) => m.id))).not.toContain("VTP");
  });

  // B.4 de-dup discriminator. The store holds BOTH halves and they DISAGREE: the raw ^VIX/^VIX3M
  // closes recompute to a 5-day streak (Amber) while the persisted VTP reading — itself emitted by
  // the producer over a LONGER backwardation run, so it is a book the engine can really reach —
  // stands at 12 (Red). The persisted reading is authoritative, so the overlay must print 12/RED.
  // Red = the retired wire-edge recomputation still wins (it would print 5 closes / AMBER).
  test("vtp overlay reads the PERSISTED reading, not a recomputation of the raw VIX legs", async () => {
    const rawLegs = vtpLegs(FIVE_DATES, FIVE_BACK);
    const longRun = Array.from({ length: 12 }, (_, i) => `2026-05-${String(i + 4).padStart(2, "0")}`);
    const persisted = vtpPersistedRows(vtpLegs(longRun, longRun.map(() => true)));
    const tail = persisted.at(-1)!;

    // Non-vacuity: the two halves must actually DISAGREE, else the test cannot separate them.
    expect(backwardationStreak(rawLegs.vix, rawLegs.vix3m)).toBe(5);
    expect(tail.value).toBe(12);
    expect(tail.state).toBe("RED");
    expect(vixTermPersistenceState(backwardationStreak(rawLegs.vix, rawLegs.vix3m))).toBe("AMBER");

    store = new InMemoryStore();
    await store.recordReadings(vtpRawRows(rawLegs), "2026-06-25T20:00:00.000Z");
    // Persisted VTP rows recorded LAST so their run_at is the latest vintage.
    await store.recordReadings(persisted, "2026-06-25T20:05:00.000Z");
    await store.recordRun(GREEN_SEED.map((id) => sr(id, "GREEN")), RUN_AT, alert);

    const body = (await (await GET()).json()) as LabResponse;
    const vtp = body.overlays.vtp!;
    expect(vtp.fields.find((f) => f.label === "streak")!.value).toBe("12 closes");
    expect(vtp.fields.find((f) => f.label === "state")!.value).toBe("RED");
  });

  test("maps the persisted DB_* rows to downsideDetectors (display ids), live only", async () => {
    store = new InMemoryStore();
    // The slice-2 detector rows run-cycle-dial.ts persists under dedicated DB_* ids.
    await store.recordRun(
      [
        sr("F1", "GREEN"),
        sr("DB_SMH", "RED"),
      ],
      RUN_AT,
      alert,
    );

    const body = (await (await GET()).json()) as LabResponse;
    expect(body.downsideDetectors).toEqual([
      { id: "SMH", state: "RED" },
    ]);
    // Live-only: the seeded scenario-shape test in the `?s=` describe pins the strip's absence there.
  });

  // The live body is ONE edge-cached response, so the
  // licensed F1 level and alert `fallVelocity` must appear NOWHERE in it — raw or in their served formats.
  // Whole-body walk, not per-slot pins: a new key echoing either value reds here without being enumerated.
  test("a distinctive stored F1 level and fallVelocity appear nowhere in the live body", async () => {
    const HY = 4.2371;
    const VEL = -0.0013579;
    store = new InMemoryStore();
    await store.recordRun(
      GREEN_SEED.map((id) => (id === "F1" ? { ...sr(id, "GREEN"), value: HY } : sr(id, "GREEN"))),
      RUN_AT,
      { ...alert, fallShape: "bear" as const, fallVelocity: VEL, creditDwellCloses: 40 },
    );
    const body = (await (await GET()).json()) as LabResponse;
    const leaks: string[] = [];
    const walk = (v: unknown, path: string): void => {
      if (typeof v === "number" && (Math.abs(v - HY) < 1e-9 || Math.abs(v - VEL) < 1e-12)) leaks.push(`${path}=${v}`);
      else if (typeof v === "string" && (v === HY.toFixed(2) || v.includes(`${(VEL * 100).toFixed(2)} pp/day`)))
        leaks.push(`${path}=${JSON.stringify(v)}`);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    walk(body, "body");
    expect(leaks).toEqual([]);
    // Non-vacuity: the seeded run IS the one served, and both withheld slots exist on it.
    expect(body.firedAt).toBe(RUN_AT);
    expect(body.overlays.fallShape).toBeDefined();
    expect(body.band!.floors.flatMap((f) => f.members).some((m) => m.id === "r4-hyoas")).toBe(true);
  });
});

describe("GET /api/lab - withheld slots (serveRedactable)", () => {
  // One world, three requests: a plain one, a bearer-carrying one, and `auth=1` (an unknown param).
  // Distinctive F1 level + fallVelocity so each withheld slot traces to THIS run's row.
  const HY = 4.2371;
  const VEL = -0.0013579;
  let plainRes: Response;
  let plainText: string;
  let redacted: LabResponse;
  let bearerRes: Response;
  let bearerText: string;
  beforeAll(async () => {
    resetVintageMemo();
    store = new InMemoryStore();
    await store.recordRun(
      GREEN_SEED.map((id) => (id === "F1" ? { ...sr(id, "GREEN"), value: HY } : sr(id, "GREEN"))),
      RUN_AT,
      { ...alert, fallShape: "bear" as const, fallVelocity: VEL, creditDwellCloses: 40 },
    );
    plainRes = await GET(new Request("https://lab.test/api/lab"));
    plainText = await plainRes.text();
    redacted = JSON.parse(plainText) as LabResponse;
    bearerRes = await GET(new Request("https://lab.test/api/lab", { headers: { authorization: "Bearer good" } }));
    bearerText = await bearerRes.text();
  });
  const fieldOf = (b: LabResponse, id: string, label: string) => b.overlays[id]!.fields.find((f) => f.label === label)!.value;
  const bandHyOf = (b: LabResponse) => b.band!.floors.flatMap((f) => f.members).find((m) => m.id === "r4-hyoas")!.value;

  test("the HY OAS field, fall velocity and band r4-hyoas value are withheld, vintage-cached", () => {
    expect([fieldOf(redacted, "r4", F1_LABEL), fieldOf(redacted, "fallShape", "velocity"), bandHyOf(redacted)]).toEqual(["-", "-", null]);
    expect(plainRes.headers.get("Cache-Control")).toBe(VINTAGE_HEADERS["Cache-Control"]);
  });

  test("a request carrying a bearer token gets the same served body and cache policy byte for byte; `auth` 400s", async () => {
    expect(bearerRes.headers.get("Cache-Control")).toBe(plainRes.headers.get("Cache-Control"));
    expect(bearerText).toBe(plainText);
    for (const v of ["1", "2"]) {
      expect((await GET(new Request(`https://lab.test/api/lab?auth=${v}`))).status, v).toBe(400);
    }
  });
});


describe("GET /api/lab - Stage 2b BAND drill-down (response.band)", () => {
  test("live: populated 5-floor drill-down, chain reuses pushed band, members capped to floor reach", async () => {
    store = new InMemoryStore();
    // Deterministic hydrated dial (persisted dialState rides verbatim — C1) so chain/r4 inputs pin.
    const dial = makeDial({
      // targetRung 8 is the load-bearing input (the r4 ENTER rung); dangerScore (0.875) and both
      // regime axes derive from it — the pre-2026-08-02 fixture hand-typed dangerScore 0.5 BESIDE
      // targetRung 8, a pairing `computeT1Dial` cannot emit (0.5 ⇒ targetRung 5). The label stays
      // "Stress" as before: no credit/volatility family fires here, so `applyCrisisGate` demotes
      // the Crisis-scored dial — which is exactly why the score and the label can differ.
      rung: 8,
      leadingFiring: 2,
      coincidentFiring: 1,
      fired: true,
      fastBreakEW: true,
    });
    const readings: StoredReading[] = [
      sr("F1", "GREEN"),
      sr("F2", "GREEN"),
      sr("R1", "RED"), // a RATE non-confirmer, own RED — the WATCH-capped `rate` floor's member
      sr("G1", "AMBER"), // auto GEO-channel member
    ];
    await store.recordRun(readings, RUN_AT, {
      ...alert,
      dialState: dial,
      // r4 floor RECOMPUTE → CRITICAL; the phase tone (RED for `cash`) rides the floor HEAD (`phaseState`).
      r4Phase: "cash",
      level: "WATCH", // the persisted pushed band — DELIBERATELY LOWER than the r4 recompute so
      // the headline (off pushedBand) and the floor recompute DIVERGE: sourcing `level`/`chain.band`
      // from `breakdown.band` instead of `pushedBand` would read CRITICAL and this test goes red.
    });

    const body = (await (await GET()).json()) as LabResponse;
    expect(body.mode).toBe("live");
    const band = body.band!;
    expect(band).toBeDefined();
    // level + chain.band REUSE the persisted pushed band (never re-derived — the bandReason rule):
    // WATCH, NOT the CRITICAL the r4 floor recompute below produces.
    expect(band.level).toBe("WATCH");
    // chain echoes the PERSISTED dial's own scalars (single-sourced off the fixture, which derives
    // them from production — a hand-typed pair here would re-open the drift this fixture just closed).
    expect(band.chain).toEqual({ dangerScore: dial.dangerScore, regime: dial.regime, band: "WATCH" });
    // R6 ([USER] 2026-07-31): the PRE-FLOOR dial band crosses the wire, read off the SAME alert row
    // (`dial_band`, the store's projection of the persisted dial ⇒ regimeToBand(Stress) = WARNING).
    // Non-vacuous BY the same divergence this test is built on: the persisted pushed band is WATCH,
    // so a handler that passed `level`/`chain.band` would read WATCH here. (It does NOT discriminate
    // the persisted read from buildLabBand's own `regimeToBand(dial.notifyRegime)` default — the row
    // and the hydrated dial are the same run, which is exactly why the default is a safe fallback.)
    expect(band.dialBand).toBe("WARNING");
    expect(band.dialBand).not.toBe(band.level);
    // every floor, most-severe-first, each carrying the engine's own cap (§5). `coverage` (R4,
    // 2026-08-01) is the trailing WATCH-capped floor — armed on this path since Stage 3.3; this
    // fixture's frozen 2026-06-25 readings leave it unarmed (see the coverage describe below).
    expect(band.floors.map((f) => f.id)).toEqual(["credit", "r4", "geo", "rate", "ew", "coverage"]);
    expect(band.floors.map((f) => f.cap)).toEqual(["CRITICAL", "CRITICAL", "WARNING", "WATCH", "WATCH", "WATCH"]);
    // r4 in cash ⇒ its own RECOMPUTED level is CRITICAL and it BINDS `source` — this is the
    // divergence witness: the floor engine still computes CRITICAL while the headline stays WATCH.
    const r4 = band.floors.find((f) => f.id === "r4")!;
    expect(r4.level).toBe("CRITICAL");
    expect(band.source).toBe("r4");
    // The breaker's PHASE now rides the floor HEAD ([USER] E5, 2026-07-26) — it used to tone every
    // member row identically.
    expect(r4.phase).toBe("cash");
    expect(r4.phaseState).toBe("RED");
    // The r4 enter-input row carries the hydrated dial's rung vs its R4_ENTER_RUNG gate.
    const rung = r4.members.find((m) => m.id === "r4-rung")!;
    expect(rung.value).toBe(8);
    expect(rung.threshold).toBe(R4_ENTER_RUNG);
    // The RATE non-confirmer member's cell collapses RED→AMBER under the WATCH cap.
    const rate = band.floors.find((f) => f.id === "rate")!.members.find((m) => m.id === "R1")!;
    expect(rate.state).toBe("RED");
    expect(rate.cappedState).toBe("AMBER");
  });

  // Stage 3 (auto-geo-stage): the PERSISTED calm streak reaches buildLabBand off the alert row — a
  // held streak (0) prints a stage/hold term in the geo basisDetail; a streak-less row (pre-migration
  // null) keeps the assume-calm default and prints none. Robust across committed crisisStage 0 and 4;
  // a declared ≥2 would print "2 stage" on both paths and red the calm control LOUDLY, not silently.
  test("geo floor reads the persisted geoCalmStreak - held row prints a stage term, streak-less row stays calm", async () => {
    store = new InMemoryStore();
    await store.recordRun([sr("F1", "GREEN")], RUN_AT, { ...alert, dialState: makeDial(), geoCalmStreak: 0 });
    const held = (await (await GET()).json()) as LabResponse;
    const geoHeld = held.band!.floors.find((f) => f.id === "geo")!;
    expect(geoHeld.basisDetail).toMatch(/stage/);
    expect(geoHeld.level).toBe("WATCH");

    store = new InMemoryStore();
    await store.recordRun([sr("F1", "GREEN")], RUN_AT, { ...alert, dialState: makeDial() });
    const calm = (await (await GET()).json()) as LabResponse;
    const geoCalm = calm.band!.floors.find((f) => f.id === "geo")!;
    expect(geoCalm.basisDetail).not.toMatch(/stage/);
    expect(geoCalm.level).toBe("OK");
  });

  // R4/R5 Stage 3.3 — the COVERAGE floor is now ARMED on the /lab read path (it shipped inert in
  // 3.1). The `volatility` DIAL roster is VT/R5, so seeding VT alone leaves R5 absent (the family's
  // GREEN verdict rests on a roster we cannot fully see ⇒ `coverageDegraded`); the clean-roster OK
  // half is pinned at the seam (src/alert-band.floors.test.ts). No other DIAL family has a present
  // member here, so each is `live: false` and cannot degrade: the member list below is an EXACT pin,
  // not a `toContain`.
  //
  // Dates ride the REQUEST clock (`freshnessFrom(store)`, which reads it and resolves a date per
  // feed calendar) —
  // `sr`'s frozen 2026-06-25 would read every feed stale and the `someDailyFeedFresh` divergence
  // guard inside `coverageArmed` would (correctly) refuse to arm on a whole-store outage. The
  // request clock is PINNED to a weekday — a wall-clock weekend "today" is no publication slot, so
  // every seeded row read stale and the floor never armed on a Saturday/Sunday.
  describe("the coverage floor (R4/R5 Stage 3.3)", () => {
    beforeEach(() => {
      clock = new Date("2026-10-02T14:00:00Z"); // a Friday
    });
    afterEach(() => {
      clock = undefined;
    });

    const today = (): string => clock!.toISOString().slice(0, 10);
    const freshSr = (indicatorId: string): StoredReading => ({
      date: today(),
      indicatorId,
      value: 1,
      delta20: 0,
      rawState: "GREEN",
      state: "GREEN",
    });
    const runWith = async (ids: string[]): Promise<LabResponse> => {
      store = new InMemoryStore();
      await store.recordRun(ids.map(freshSr), RUN_AT, { ...alert, dialState: makeDial(), level: "OK" });
      return (await (await GET()).json()) as LabResponse;
    };

    test("a coverage-degraded DIAL family floors the band at WATCH and names itself in the rows", async () => {
      const body = await runWith(["VT"]); // R5 absent from the volatility roster
      const coverage = body.band!.floors.find((f) => f.id === "coverage")!;
      expect(coverage.level).toBe("WATCH");
      // The synthetic row IS the family (no indicator behind it), and the note names the absent
      // roster member — the display half of the claim, beside the level.
      expect(coverage.members.map((m) => m.id)).toEqual(["volatility"]);
      expect(coverage.members[0]!.note).toContain("R5");
    });
  });
});


describe("GET /api/lab - D9 scoreboard (Stage 3)", () => {
  // ISO date `offset` calendar days before now — the handler's trailing-365d cutoff
  // is clock-relative, so seeded override/alert dates must be too.
  const daysAgo = (offset: number): string =>
    new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

  /** One persisted SB NAV point (state fields are NOT-NULL placeholders, never read). */
  function sbRow(indicatorId: string, date: string, nav: number): StoredReading {
    return { date, indicatorId, value: nav, delta20: 0, rawState: "GREEN", state: "GREEN", decision: null };
  }

  /** ≥ MIN_UI_RUNS flat SB points for BOTH ids so gate (a) resolves (UI 0 vs 0 → PASS). */
  async function seedSbRows(): Promise<void> {
    for (let i = 0; i < MIN_UI_RUNS; i++) {
      const date = `2026-06-${String(i + 1).padStart(2, "0")}`;
      await store.recordReadings(
        [sbRow(SB_STRAT_ID, date, 100), sbRow(SB_BENCH_ID, date, 100)],
        `${date}T21:00:00.000Z`,
      );
    }
  }

  test("live response carries scoreboard with both gates when SB rows exist", async () => {
    store = new InMemoryStore();
    await store.recordRun([sr("F1", "GREEN")], RUN_AT, alert);
    await seedSbRows();

    const body = (await (await GET()).json()) as LabResponse;
    expect(body.scoreboard).toBeDefined();
    const sb = body.scoreboard!;
    expect(sb.warmingUp).toBe(false);
    expect(sb.runs).toBe(MIN_UI_RUNS);
    expect(sb.since).toBe("2026-06-01");
    // Gate (a) resolves (both series have ≥ MIN_UI_RUNS points; flat ⇒ 0 ≤ 0 ⇒ PASS)…
    expect(sb.gates.ulcer.verdict).toBe("PASS");
    // …and gate (b) is a SEPARATE verdict (0 recorded overrides ≤ budget).
    expect(sb.gates.overrides).toEqual({ verdict: "PASS", count: 0, limit: B1_OVERRIDES_PER_YEAR });
  });

  test("3.5b: the served body has every NAV statistic null (returns, ulcer, drawdown, recovery); the full body carries them", async () => {
    store = new InMemoryStore();
    await store.recordRun([sr("F1", "GREEN")], RUN_AT, alert);
    await seedSbRows();

    const full = (await FULL()).scoreboard!;
    const redacted = ((await (await GET()).json()) as LabResponse).scoreboard!;
    const statsOf = (sb: typeof full): Record<string, number | null> => ({
      ...Object.fromEntries(
        (["strategy", "benchmark"] as const).flatMap((side) =>
          (["ulcer", "maxDD", "calmar", "recoveryRuns", "annRet"] as const).map((m) => [`${side}.${m}`, sb[side][m].value]),
        ),
      ),
      strategyUi: sb.gates.ulcer.strategyUi,
      benchmarkUi: sb.gates.ulcer.benchmarkUi,
      returnVsFundPp: sb.returnVsFundPp,
    });
    // Non-vacuity: flat NAVs ⇒ a real 0 ulcer / annual return, not the n/a null.
    const fullStats = statsOf(full);
    expect([fullStats["strategy.ulcer"], fullStats["strategy.annRet"], fullStats.strategyUi, fullStats.returnVsFundPp]).toEqual([0, 0, 0, 0]);
    expect(statsOf(redacted)).toEqual(Object.fromEntries(Object.keys(fullStats).map((k) => [k, null])));
    // The cell invariant holds (naReason set exactly when value is null); verdicts, window and counts stay.
    expect(redacted.strategy.annRet.naReason).not.toBeNull();
    expect(redacted.gates.ulcer.verdict).toBe(full.gates.ulcer.verdict);
    expect({ ...redacted, strategy: full.strategy, benchmark: full.benchmark, gates: full.gates, returnVsFundPp: full.returnVsFundPp }).toEqual(full);
  });

  test("`estimateAnchored`: an SB NAV estimate chained onto an estimate never reaches the scoreboard", async () => {
    store = new InMemoryStore();
    await store.recordRun([sr("F1", "GREEN")], RUN_AT, alert);
    const rows = ["2026-06-01", "2026-06-02", "2026-06-03"].flatMap((date, i) =>
      [SB_STRAT_ID, SB_BENCH_ID].map((id) => ({ ...sbRow(id, date, 100 + i), ...(i > 0 ? { estimated: true } : {}) })));
    await store.recordReadings(rows, "2026-06-03T22:00:00.000Z");
    const sb = ((await (await GET()).json()) as LabResponse).scoreboard!;
    expect([sb.runs, sb.since]).toEqual([2, "2026-06-01"]);
  });

  test("override count flows from seeded InMemoryStore overrides; >365d rows excluded", async () => {
    store = new InMemoryStore();
    await store.recordRun([sr("F1", "GREEN")], RUN_AT, alert);
    // B1_OVERRIDES_PER_YEAR + 1 recent rows breach the budget; the ancient row must
    // NOT count — a count of limit+2 would mean the 365d filter is broken.
    for (let i = 0; i < B1_OVERRIDES_PER_YEAR + 1; i++) {
      store.overrides.push({ obsDate: daysAgo(10 + i), note: `override ${i}` });
    }
    store.overrides.push({ obsDate: daysAgo(400), note: null }); // outside the window

    const body = (await (await GET()).json()) as LabResponse;
    expect(body.scoreboard!.gates.overrides.count).toBe(B1_OVERRIDES_PER_YEAR + 1);
    expect(body.scoreboard!.gates.overrides.verdict).toBe("FAIL");
  });
});


describe("GET /api/lab?hist=N - i5 momentum window", () => {
  // P12.b closed the key space to {0, LAB_LOOKBACK}: the ONLY served window is the one the
  // shipped clients request, so the fixture pins against that same constant, never a free N.
  const HIST = LAB_LOOKBACK;

  // Seed N distinct-date points for two GLOBAL_FAMILIES members (F1=credit, R1=rates),
  // all at RUN_AT so they're present in the run AND have an N-deep getSeries history.
  function seedHistoryRows(): StoredReading[] {
    const rows: StoredReading[] = [];
    for (const id of ["F1", "R1"]) {
      for (let i = 1; i <= HIST; i++) {
        const day = String(i).padStart(2, "0");
        rows.push(makeStoredReading(id, { date: `2026-06-${day}` }));
      }
    }
    return rows;
  }

  test("?hist=N computes momentum server-side; memberHistory never reaches the wire", async () => {
    store = new InMemoryStore();
    await store.recordRun(seedHistoryRows(), RUN_AT, alert);

    const res = await GET(new Request("https://lab.test/api/lab?hist=" + HIST));
    expect(res.status).toBe(200);
    const body = (await res.json()) as LabResponse;
    // §10 momentum gating: a ?hist request computes per-leg momentum on the field.
    expect(body.field.legRows.some((l) => l.momentum !== undefined)).toBe(true);
    expect(body).not.toHaveProperty("memberHistory");
  });

  // The closed `?hist` key space (`hist ∈ {0, LAB_LOOKBACK}`, off-grid ⇒ 400 no-store) is pinned at
  // `parseHist` (src/lab-request.test.ts); this is the wire half.
  test("the off-grid 400 precedes every store read: an empty DB would 404 on the verdict read", async () => {
    // A Proxy (not a vitest spy — that would re-isolate this file) logs every store method called.
    const calls: string[] = [];
    store = new Proxy(new InMemoryStore(), {
      get(t, p, r) {
        const v = Reflect.get(t, p, r) as unknown;
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => (calls.push(String(p)), (v as (...a: unknown[]) => unknown).apply(t, args));
      },
    });
    expect((await GET(new Request(`https://lab.test/api/lab?hist=${HIST + 1}`))).status).toBe(400);
    expect(calls).toEqual([]);
  });

});

describe("intraday verdict slot", () => {
  const DAY_RUN_AT = "2026-06-26T12:00:00.000Z"; // newer than RUN_AT, before its own day's 21:05 UTC cutoff
  const seed = (date: string) => [sr("EBP", "AMBER"), ...GREEN_SEED.map((id) => sr(id, "GREEN"))].map((r) => ({ ...r, date }));

  test("a newer slot IS the served verdict: provisional body, its own readings, EST on nowcast ids, INTRADAY elsewhere", async () => {
    store = new InMemoryStore();
    await store.recordRun([...seed("2026-06-25"), sr("G1", "GREEN")], RUN_AT, alert);
    // The daytime run: rows dated ITS day (provisional under its runAt), the verdict in the slot only; G1's carries
    // the stored `estimated` marker (the run's oil nowcast row).
    const dayRows = seed("2026-06-26").map((r) => (r.indicatorId === "F1" ? { ...r, state: "AMBER" as const, rawState: "AMBER" as const } : r));
    await store.recordReadings([...dayRows, { ...sr("G1", "GREEN"), date: "2026-06-26", estimated: true }], DAY_RUN_AT);
    // A PERSISTED panel folded with F1 GREEN, so the served AMBER row DISAGREES with the panel: only the
    // `!provisional` guard keeps it out of `bandLagIds` (mutating the guard out reds the assertion below).
    const panelState = await assembleDial({
      readings: [{ id: "EBP", state: "AMBER" as const }, ...[...GREEN_SEED, "G1"].map((id) => ({ id, state: "GREEN" as const }))],
      asOf: "2026-06-26",
      store,
    });
    await store.putIntradayVerdict({ ...alert, firedAt: DAY_RUN_AT, date: "2026-06-26", panelState });

    const body = (await (await GET()).json()) as LabResponse;
    expect(body.provisional).toBe(true);
    expect(body.firedAt).toBe(DAY_RUN_AT);
    expect(body.asOf).toBe("2026-06-26");
    const members = body.globalFamilies.flatMap((f) => f.members);
    const f1 = members.find((m) => m.id === "F1");
    expect(f1?.provisional).toBe(true);
    expect(f1?.estimated).toBeUndefined(); // no stored marker ⇒ INTRADAY, never EST (E3: the roster no longer decides)
    expect(f1?.state).toBe("AMBER"); // the intraday-scored state, not the EOD row's GREEN
    const r5 = members.find((m) => m.id === "R5");
    expect(r5?.provisional).toBe(true);
    expect(r5?.estimated).toBeUndefined();
    // The run's OWN served row carries the marker ⇒ EST (the `served === own` arm).
    expect(members.find((m) => m.id === "G1")).toMatchObject({ provisional: true, estimated: true });
    // A provisional row never marks a band lag (R7).
    expect(body.globalFamilies.every((f) => !f.bandLagIds?.length)).toBe(true);
  });

  test("a non-session row between the quote head and its previous session never lifts the head past the notify read's bound", async () => {
    store = new InMemoryStore();
    await store.recordRun([...seed("2026-06-25"), { ...sr("BUND", "GREEN"), date: "2026-06-24" }], RUN_AT, alert);
    await store.recordReadings([{ ...sr("BUND", "GREEN"), date: "2026-06-27" }], "2026-06-27T22:00:00.000Z");
    await store.recordReadings([{ ...sr("BUND", "RED"), date: "2026-06-29", estimated: true }], "2026-06-29T21:10:00.000Z");
    const body = (await (await GET()).json()) as LabResponse;
    const dial = body.dialFamilies.flatMap((f) => f.members).find((m) => m.id === "BUND");
    expect([dial?.state, dial?.obs]).toEqual(["GREEN", "2026-06-24"]);
  });

  // Older-slot-ignored and throwing-slot-degrades are pinned at their seams (src/intraday.test.ts
  // `servedVerdict` / `readIntradaySlot`); the newer-slot test above is the wire.

  test("pruneFailed rides the EOD row's prune degrade even under a newer daytime slot; absent on a clean EOD row", async () => {
    store = new InMemoryStore();
    const prune = { scope: PRUNE_DEGRADE_SCOPE, reason: "canceling statement due to statement timeout", effect: "trace" as const };
    await store.recordRun(seed("2026-06-25"), RUN_AT, { ...alert, degraded: [prune] });
    await store.putIntradayVerdict({ ...alert, firedAt: DAY_RUN_AT, date: "2026-06-26", degraded: [] });
    const body = (await (await GET()).json()) as LabResponse;
    expect(body.provisional).toBe(true);
    expect(body.pruneFailed).toEqual({ firedAt: RUN_AT, reason: prune.reason });

    store = new InMemoryStore();
    await store.recordRun(seed("2026-06-25"), RUN_AT, { ...alert, degraded: [{ scope: "[baa10y] feed down", reason: "x", effect: "notify" }] });
    expect("pruneFailed" in ((await (await GET()).json()) as LabResponse)).toBe(false);
  });
});

// The two logged degrades of `ewPctCell` (src/lab-served-field.ts). They live in this isolated file
// because they spy `console.warn`; the rest of the seam's cases are in src/lab-served-field.test.ts.
describe("ewPctCell - a failed read or probe degrades to warmup and LOGS", () => {
  const SLEEVE = LEG_FIELD[0]!.sleeve;

  // REVIEW 2026-07-25 (C1) — a failed read still degrades to `warmup` (a display badge must not 500
  // the board), but it must LEAVE A TRACE. The bare `.catch(() => [])` this replaces made "table
  // missing / ungranted in prod" and "assertNotTruncated threw" look exactly like a legitimate
  // warm-up: `(—)` on all nine legs, forever, no log line.
  // Red demo: drop the `warn` from the catch ⇒ the warn assertion reds.
  test("a FAILED read degrades to warmup but LOGS the reason", async () => {
    const s = overriding(new InMemoryStore(), {
      getLegPillarSeries: () => Promise.reject(new Error('relation "leg_pillars" does not exist')),
    });
    const { warn, calls } = warnSink();
    expect(await ewPctCell(s, SLEEVE, { kind: "scored", value: 0.5 }, warn)).toEqual({ kind: "warmup" });
    expect(calls).toHaveLength(1);
    // The message must name the SLEEVE and carry the DB's own error text — a bare "read failed"
    // would not tell an operator which of the nine legs, nor that the table is absent.
    const msg = String(calls[0]?.[0]);
    expect(msg).toContain(SLEEVE);
    expect(msg).toContain('relation "leg_pillars" does not exist');
  });

  // The probe itself failing is a third failure mode: log + warmup, never a 500 and never a
  // half-populated `stale-basis`.
  test("a failed PROBE degrades to warmup and logs", async () => {
    const s = overriding(new InMemoryStore(), {
      getLegPillarLatestGenerator: () => Promise.reject(new Error("permission denied for table leg_pillars")),
    });
    const { warn, calls } = warnSink();
    expect(await ewPctCell(s, SLEEVE, { kind: "scored", value: 0.5 }, warn)).toEqual({ kind: "warmup" });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.[0])).toContain("permission denied for table leg_pillars");
  });
});

describe("GET /api/lab?s= - scenario path", () => {
  // Slice 2.1: the scenario path DOES read the store now (member history + held sleeve), so the
  // standing pin here is the one that survived: a COLD store must degrade, never 404.
  test("valid ?s= → seeded scenario panel on an empty store (mode=scenario, no-store, no 404)", async () => {
    store = new InMemoryStore(); // empty — a scenario must degrade, not 404
    const res = await GET(new Request("https://lab.test/api/lab?s=credit:RED"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as LabResponse & { mode: string; states: Record<string, State> };

    expect(body.mode).toBe("scenario");
    expect(body.states).toEqual({ credit: "RED" });
    expect(body.liveFamilyCount).toBe(7); // all 7 live families seeded (valuation live via ECY, 2026-08-11)
    expect(body.firingCount).toBe(1); // Credit red alone fires
    // Ledger Stage 2: `regime` rides every wire leg row (openapi enum calm|deter|stress|recov) — pinned
    // here on the empty store (nothing to inherit) so the assertion can't flake.
    expect(body.field.legRows.length).toBeGreaterThan(0);
    for (const row of body.field.legRows) expect(["calm", "deter", "stress", "recov"]).toContain(row.regime);
    expect(body.field.held).not.toBeNull();
    expect(["calm", "deter", "stress", "recov"]).toContain(body.field.held!.regime);
  });

  // The scenario path replays no persisted run, so every LIVE-ONLY key is absent there — even on a
  // store carrying each one's source data. Each feature's own live test pins the populated arm (band
  // drill-down, scoreboard, coverage, legAttribution, fall-shape, downsideDetectors). `?hist` is
  // live-only too: an off-grid N on the scenario path is ignored, never a 400.
  test("scenario shape on a seeded store: every live-only key absent, an off-grid ?hist ignored", async () => {
    store = new InMemoryStore();
    const coverage: CoverageDegrade = {
      family: "rates",
      verdict: "RED",
      carried: false,
      members: [{ id: "R6", reason: "lag", series: "^MOVE", state: "RED", ageDays: 55 }],
    };
    // F3 AMBER = a firing attribution target; DB_SMH = a downside-detector row; SB_* = scoreboard NAVs.
    await store.recordRun(
      [sr("F3", "AMBER"), sr("DB_SMH", "RED"), ...GREEN_SEED.map((id) => sr(id, "GREEN"))],
      RUN_AT,
      makeAlert({
        dialState: makeDial(),
        level: "CRITICAL",
        fallShape: "bear",
        fallVelocity: -0.001,
        creditDwellCloses: 40,
        degraded: [{ scope: "[coverage] rates verdict held by non-live data", reason: "RED held by R6 (lag 55d)", effect: "notify", coverage }],
      }),
    );
    await store.recordReadings(
      Array.from({ length: MIN_UI_RUNS }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`).flatMap((date) =>
        [SB_STRAT_ID, SB_BENCH_ID].map((indicatorId) => ({ ...sr(indicatorId, "GREEN"), date, value: 100 })),
      ),
      "2026-06-24T21:00:00.000Z",
    );

    const res = await GET(new Request(`https://lab.test/api/lab?s=credit:RED&hist=${LAB_LOOKBACK + 1}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as LabResponse;
    expect(body.mode).toBe("scenario");
    expect(body.band).toBeUndefined();
    expect("scoreboard" in body).toBe(false);
    expect(body.coverage).toEqual([]);
    expect(body.legAttribution).toBeUndefined();
    expect(body.downsideDetectors).toBeUndefined();
    expect("fallShape" in body.overlays).toBe(false);
    // …while the scenario's own surfaces still ship ⇒ non-vacuous: the danger field (§2: it responds
    // to `?s=`) banded off the scenario dial, and the r4 overlay beside the absent fallShape.
    expect(body.field.band).toEqual(body.t1dial.band);
    expect(body.overlays.r4).toBeDefined();
  });

  // Slice 2.1 review I5: `?s=` now acquires getStore("ro"), which FAILS LOUD without
  // SUPABASE_URL/SUPABASE_SERVICE_KEY (store.ts, deliberate — v4 §6.7). Pre-2.1 the bench needed no
  // DB env at all, so an unconfigured local dev box must degrade to the honest pre-2.1 shape, not
  // 500 — and must SAY SO (the `warn` seam), never degrade silently into a "purity" illusion.
  test("unconfigured store → scenario degrades to the pre-2.1 shape + warns, never 500s", async () => {
    const { warn, calls } = warnSink();
    const res = await handle(unconfiguredStore, new Request("https://lab.test/api/lab?s=credit:RED"), { warn });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LabResponse;
    expect(body.mode).toBe("scenario");
    expect(body.field.legRows.length).toBeGreaterThan(0);
    // The degrade is loud, and names the scenario path.
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[0]![0])).toContain("?s=");
    // No store to rank over ⇒ the y1 key is omitted entirely; G0 Stage 0.3 — growthRs (and its
    // lookbacksUsed) ride the same storeless-absence rule.
    expect("y1" in body.overlays).toBe(false);
    expect("growthRs" in body).toBe(false);
    expect("lookbacksUsed" in body).toBe(false);
  });

  test("a failed verdict read → scenario degrades to verdict: null + warns", async () => {
    store = overriding(new InMemoryStore(), { getLastAlert: () => Promise.reject(new Error("alert_log down")) });
    const { warn, calls } = warnSink();
    const res = await GET(new Request("https://lab.test/api/lab?s=credit:RED"), { warn });
    expect(res.status).toBe(200);
    expect(calls.map((c) => String(c[0]))).toContain("[lab] scenario verdict read failed - DEGRADED to verdict: null:");
  });

  // …but the LIVE path keeps failing loud on an unconfigured store: only the bench is spared.
  test("unconfigured store still throws on the live path (fail-loud preserved)", async () => {
    await expect(handle(unconfiguredStore, new Request("https://lab.test/api/lab"))).rejects.toThrow(/SUPABASE_URL/);
  });

  test("malformed ?s= → 400", async () => {
    store = new InMemoryStore();
    const bad = await GET(new Request("https://lab.test/api/lab?s=credit:PURPLE"));
    expect(bad.status).toBe(400);
  });

  // THE ECHO NAMES EVERY OVERRIDE THE
  // PARSER ACCEPTED. `parseScenario` takes six segment shapes; before this pin only the family
  // states were echoed, so `?s=F2:AMBER,tail:1` applied two overrides the payload never named and a
  // caller could not tell an applied knob from one the server had ignored. One request exercising
  // all six, one assertion per shape.
  test("?s= echo names every accepted override shape (states + members + knobs)", async () => {
    store = new InMemoryStore();
    const s = "credit:RED,F2:AMBER,tail:1,sustained:1,daysInCash:20,lag:F1";
    const res = await GET(new Request(`https://lab.test/api/lab?s=${encodeURIComponent(s)}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as LabResponse;

    expect(body.states).toEqual({ credit: "RED" }); // (5) family key
    expect(body.members).toEqual({ F2: "AMBER" }); // (6) per-member override
    // …and the parsed members reach the panel (the override rule itself: families.test.ts).
    expect(body.globalFamilies.find((f) => f.key === "credit")!.members.find((m) => m.id === "F2")!.state).toBe("AMBER");
    expect(body.knobs).toEqual({
      tail: true, // (1)
      sustained: true, // (2)
      daysInCash: 20, // (3)
      lag: ["F1"], // (4)
    });
  });

  // The echo must be TOTAL, not "present when non-default": a caller reading back an empty
  // `?s=` has to see the zero-override shape rather than absent keys it cannot distinguish
  // from an older deploy that never echoed at all.
  test("?s= echo is total - an all-green scenario still names the empty overrides", async () => {
    store = new InMemoryStore();
    const body = (await (await GET(new Request("https://lab.test/api/lab?s="))).json()) as LabResponse;
    expect(body.members).toEqual({});
    expect(body.knobs).toEqual({ tail: false, sustained: false, daysInCash: 0, lag: [] });
  });
});


describe("GET /api/lab?s= - R4 knobs (Stage 4)", () => {
  test("extreme dial + tail + sustained prior → the r4 overlay reaches cash", async () => {
    store = new InMemoryStore();
    const res = await GET(
      new Request(
        "https://lab.test/api/lab?s=credit:RED,rates:RED,volatility:RED,tail:1,sustained:1",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as LabResponse;
    const r4 = body.overlays.r4!;
    // `tone: "alert"` IS the cash flag on the overlay wire (the FE breaker reads it).
    expect(r4.tone).toBe("alert");
    expect(r4.headline).toContain("cash");
    // The tail levels survive the reshape as formatted field values, in order.
    expect(r4.fields).toEqual([
      { label: "phase", value: "cash" },
      { label: "re-entry rung", value: "-" },
      { label: F1_LABEL, value: R4_HY_TAIL.toFixed(2) },
      { label: "VIX/VIX3M", value: R4_VT_TAIL.toFixed(2) },
    ]);
  });

  test("daysInCash:20 on a receded (calm) dial → ratchet-snap back to equity", async () => {
    store = new InMemoryStore();
    // No family override ⇒ all-green ⇒ receded dial; a 20-day-old cash prior + cleared
    // tails ⇒ exit fires ⇒ idle-cash ratchet snaps straight to target (phase "equity").
    const res = await GET(new Request("https://lab.test/api/lab?s=daysInCash:20"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as LabResponse;
    expect(body.overlays.r4!.tone).toBe("neutral");
    expect(body.overlays.r4!.headline).toContain("equity");
  });
});


// §I3 / §I9.6 item 6 — the SCENARIO-ONLY `lag:<id>` knob. It forces one member's freshness entry to
// `{ lag: true, label: "LAG" }`, i.e. the QUIET tier, and appends the matching footnote entry, so the
// late half of D4's acceptance is eyeball-able without waiting for a feed to rot. SCENARIO-ONLY by
// construction: `applyLagKnob` runs INSIDE the `?s=` branch, downstream of the shared stamp.
describe("GET /api/lab?s=lag: - the scenario freshness knob (§I9.6 item 6)", () => {
  const noteFor = (b: LabResponse, id: string) => b.feedLag.filter((n) => n.id === id);

  test("lag:F1 appends exactly one DIM footnote entry, and no knob appends none", async () => {
    store = new InMemoryStore();
    await store.recordRun(GREEN_SEED.map((id) => sr(id, "GREEN")), RUN_AT, alert);

    // PREMISE (non-vacuity): without the knob this fixture marks nothing for F1, so the entry below
    // is the knob's doing and not a feed that was already classified.
    const bare = (await (await GET(new Request("https://lab.test/api/lab?s=credit:RED"))).json()) as LabResponse;
    expect(noteFor(bare, "F1")).toEqual([]);

    const forced = (await (
      await GET(new Request("https://lab.test/api/lab?s=credit:RED,lag:F1"))
    ).json()) as LabResponse;
    // `age`/`p90Gap`/`deepLagBar` stay NULL: the knob ASSERTS a classification, it does not measure one
    // — a fabricated "9d against a 6d bar" would be a lie with a number on it.
    const note = noteFor(forced, "F1");
    expect(note).toEqual([
      { id: "F1", label: "LAG", age: null, p90Gap: null, deepLagBar: null, lagCut: null, registered: "daily" },
    ]);
    // The label the knob ACTUALLY emitted, run through the server's own tier rule — the bridge the
    // FE's QUIET-tier paint rests on (`lagTier` decides `deepLag` in danger-engine's censusOf, and `sig-lag-deep`
    // downstream of it). Derived, never re-typed: this reds the moment `applyLagKnob` emits a
    // label that classifies `deepLag`. Was a hand-typed FE census in `cell-observed.test.js` and could
    // not fail there.
    expect(lagTier(note[0]!.label)).not.toBe("deep");
    // The QUIET tier, not the heavier one: forcing LATE must not move any cell's `deepLag` subset. (The
    // fixture's own NO-DATA ids already produce rot > 0, so this is a real comparison, not 0 = 0.)
    const rotTotal = (b: LabResponse) =>
      b.field.legRows.flatMap((r) => r.cells).reduce((n, c) => n + c.observed.deepLag, 0);
    expect(rotTotal(bare)).toBeGreaterThan(0);
    expect(rotTotal(forced)).toBe(rotTotal(bare));
  });
});


// Stage 4.1 / R8 — `coverage`: the COVERAGE DEGRADES the served run recorded, projected off the
// alert row's STRUCTURED `degraded[].coverage` (recorded by run-cycle-dial.ts's `[coverage]` emitter;
// the recording end is pinned in src/run.wiring.dial.test.ts). The no-parse rule is the point: an event without
// the structured payload is simply not a coverage degrade.
// This is the SINGLE describe over the field (a second, weaker one pinning the same four behaviours
// was folded in here 2026-08-01 — its store-unmoved assertion survives below). The forced-RED
// state-override the retired flip used to surface is gone with R1: a stale member now folds its
// LAST-KNOWN state and speaks only through the coverage floor, so what /lab shows is the family whose
// verdict a non-live member is holding — never a state the notify path overrode.
describe("GET /api/lab - coverage (the run's non-live-verdict trace)", () => {
  const COVERAGE: CoverageDegrade = {
    family: "rates",
    verdict: "RED",
    carried: false,
    members: [
      { id: "R6", reason: "lag", series: "^MOVE", state: "RED", ageDays: 55 },
      { id: "R1", reason: "absent", series: null, state: null, ageDays: null },
    ],
  };
  const liveLab = async (): Promise<LabResponse> =>
    (await (await GET(new Request("https://lab.test/api/lab"))).json()) as LabResponse;

  test("a coverage event on the alert row is served verbatim, and a plain event is FILTERED", async () => {
    store = new InMemoryStore();
    await store.recordRun(
      GREEN_SEED.map((id) => sr(id, "GREEN")),
      RUN_AT,
      makeAlert({
        degraded: [
          {
            scope: "[coverage] rates verdict held by non-live data",
            reason: "RED held by R6 (lag 55d), R1 (absent)",
            effect: "notify",
            coverage: COVERAGE,
          },
          // A plain degrade event alongside it — a `map` over every event would serve an undefined.
          // The scope string is ARBITRARY payload here (only its coverage-less SHAPE matters), so
          // it is deliberately not pinned to any producer's wording; refreshed 2026-08-06 off
          // `run-cycle.ts` because the old text named the deleted proxy degrade.
          { scope: "[baa10y] Baa10y feed unavailable", reason: "fetch failed", effect: "notify" },
        ],
      }),
    );

    const body = await liveLab();
    expect(body.coverage).toEqual([COVERAGE]);
    // The store is UNMOVED — the served member keeps its persisted GREEN even though the coverage
    // entry above reports R6 holding a RED verdict. Without this the field could be read as "R6 is
    // RED on the board", the exact claim it must not make: the coverage floor says we cannot SEE,
    // never that the market moved.
    const rates = body.globalFamilies.find((f) => f.key === "rates")!;
    expect(rates.members.find((m) => m.id === "R6")!.state).toBe("GREEN");
  });

  test("a run with clean coverage serves [] - never omitted, never fabricated", async () => {
    store = new InMemoryStore();
    await store.recordRun(GREEN_SEED.map((id) => sr(id, "GREEN")), RUN_AT, alert);
    // `toEqual([])` also carries the never-OMITTED half: an absent key would red here too. (The
    // key's PRESENCE against the contract is pinned independently by src/api/contract.test.ts's
    // `LabResponse` required-set assertion — `coverage` is not in its `optional` list.)
    expect((await liveLab()).coverage).toEqual([]);

    // An event whose scope LOOKS like a coverage event but carries no structured payload stays
    // invisible — the no-prose-fallback ruling.
    store = new InMemoryStore();
    await store.recordRun(
      GREEN_SEED.map((id) => sr(id, "GREEN")),
      RUN_AT,
      makeAlert({ degraded: [{ scope: "[coverage] rates verdict held by non-live data", reason: "RED held by R6", effect: "notify" }] }),
    );
    expect((await liveLab()).coverage).toEqual([]);
  });

  // The scenario path serves [] (it replays no persisted run): the seeded scenario-shape test in the
  // `?s=` describe, on a store carrying this same coverage event.
});


/**
 * Slice 2.1 (rung 2) falsifier.
 *
 * `scenario(?s = today's live states)` deep-equals the live field UNCONDITIONALLY: the scenario gets
 * the SAME `cissHistory`, `prevTarget` and gated held sleeve, substituting only the `?s=` states at t.
 *
 * The fixture is deliberately MIXED-DEPTH — credit / rates / cross-asset carry 25 closes, the THIN
 * families today's close only — since a uniformly-deep history would hide a history-scoped parity bug.
 */
describe("GET /api/lab?s= - Slice 2.1: scenario↔live field parity (rung 2)", () => {
  const idsOf = (key: string): readonly string[] => GLOBAL_FAMILIES.find((f) => f.key === key)!.ids;
  const DEEP = [...idsOf("credit"), ...idsOf("rates"), ...idsOf("cross-asset")];
  // `macro-cycle` was listed here until 2026-07-17; it contributed `[]` (memberless) before its
  // key was removed, so dropping it from THIN is a literal no-op on the fixture's id set.
  // `valuation` (ECY) joined 2026-08-11: an unseeded sole member left the LIVE panel absent
  // (`absent: 1, live: false`) while the scenario path built the family live — breaking parity.
  const THIN = [...idsOf("volatility"), ...idsOf("trend"), ...idsOf("geopolitics"), ...idsOf("valuation")];
  const HIST_RUN_AT = "2026-06-24T21:00:00.000Z";
  // A defensive sleeve the M5 re-risk gate is still holding: non-null so BOTH inherited scalars
  // (prevTarget = its ladder rank, held = the gated marker) are actually exercised — a null
  // heldSleeve would make the two paths agree vacuously.
  const HELD = "Staples";

  /** Per-family history: `rt` fires on a strict SUPERSET of `cr`'s days, `xa` on d%5 — three distinct deep series. */
  function histState(id: string, d: number): State {
    if (idsOf("credit").includes(id)) return d % 3 === 0 ? "AMBER" : "GREEN";
    if (idsOf("rates").includes(id)) return d % 3 === 0 || d % 7 === 0 ? "AMBER" : "GREEN";
    return d % 5 === 0 ? "RED" : "GREEN"; // cross-asset
  }

  async function seed(todayOverrides: Record<string, State>): Promise<void> {
    store = new InMemoryStore();
    const hist: StoredReading[] = [];
    for (let d = 1; d <= 24; d++) {
      const date = `2026-06-${String(d).padStart(2, "0")}`;
      for (const id of DEEP) {
        const state = histState(id, d);
        hist.push({ date, indicatorId: id, value: 1, delta20: 0, rawState: state, state });
      }
    }
    // Older run_at than RUN_AT so getReadingsForRun(RUN_AT) sees ONLY today's close (the panel),
    // while getSeriesBulk unions history + today (the member history). 24 + today = 25.
    await store.recordReadings(hist, HIST_RUN_AT);
    // The DEEP families' today close carries a FRESH obs date. This mirrors the credit precedent's
    // bridged id (EBP is monthly, so at the fixture's stale run date it still reads SPEAKING, and
    // `computeFamilyPanel` never substitutes CQS onto credit's band). Rates' bridged id R1 is DAILY,
    // so a stale date would read `lag` and seat R8 on the LIVE band while the presence-based scenario
    // path (`computeFamilyPanelFromStates`, no lag input) seats R1 — a bridge asymmetry that would
    // break the deep-equal. Fresh-dating DEEP makes R1 speak, so both paths seat R1. The THIN
    // families stay stale-dated, which is what keeps the LIVE `coverageDegraded === true` non-vacuity
    // guard below armed. State overrides, band and field are date-independent, so nothing else moves.
    const FRESH = new Date().toISOString().slice(0, 10);
    await store.recordRun(
      [
        ...DEEP.map((id) => ({ ...sr(id, todayOverrides[id] ?? "GREEN"), date: FRESH })),
        ...THIN.map((id) => sr(id, todayOverrides[id] ?? "GREEN")),
      ],
      RUN_AT,
      { ...alert, heldSleeve: HELD },
    );
  }

  const scenarioQuery = (o: Record<string, State>): string =>
    "https://lab.test/api/lab?s=" +
    encodeURIComponent(Object.entries(o).map(([id, s]) => `${id}:${s}`).join(","));

  test.each([
    ["thin CALM family beside a deep lit one", { F1: "RED", DISP: "RED" }],
    // ROW DELETED 2026-07-17: ["thin LIT family (fires the EARLY-BIAS max() floor)",
    // { F1: "RED", F12: "AMBER", DISP: "RED" }]. F12 was mc's sole member and is now retired
    // (DEC-21), so `?s=F12:AMBER` names an id the registry no longer knows and the fixture cannot
    // be built.
  ] as [string, Record<string, State>][])(
    "mixed-depth %s → scenario(?s = live states) field deep-equals live",
    async (_name, overrides) => {
      await seed(overrides);

      const live = (await (await GET(new Request("https://lab.test/api/lab"))).json()) as LabResponse;
      const scenario = (await (await GET(new Request(scenarioQuery(overrides)))).json()) as LabResponse;

      // COVERAGE CARVE-OUT (R5 Stage 2, widened to `verdictHoldIds` by Stage 4.1/B4) — the ONLY keys
      // these two panels may differ on, and they are two halves of ONE claim. `coverageDegraded` is
      // a claim about FEED LIVENESS at request time and `verdictHoldIds` names the members holding
      // it; `?s=` re-states member STATES, not publication dates, and
      // `computeFamilyPanelFromStates` is given no lag input at all, so the scenario path can
      // never claim either (pinned `false`/`[]` at its producer). Compared modulo those keys — and
      // the divergence is PINNED below in both directions rather than hidden, so the carve-out
      // cannot quietly widen into "the panels disagree".
      // Strips serve-time-only fields (`bandLagIds` + per-member `obs`/`fold`/`lastPrint`): `fold` is raw-vs-confirmed
      // on the served row, `lastPrint` (E22) its stored head; `?s=` carries neither. Only these keys go.
      const sansCoverage = (fs: readonly FamilyPanel[]) =>
        fs.map(({ coverageDegraded: _cd, verdictHoldIds: _vh, bandLagIds: _bl, members, ...rest }) => ({
          ...rest,
          members: members.map(({ obs: _obs, fold: _fold, lastPrint: _lp, ...m }) => m),
        }));
      // Precondition: the `?s=` string really does reproduce today's live panel (otherwise the
      // deep-equal below would be comparing two different worlds and still pass on a bug).
      expect(sansCoverage(scenario.globalFamilies)).toEqual(sansCoverage(live.globalFamilies));
      expect(scenario.globalFamilies.every((f) => f.coverageDegraded === false)).toBe(true);
      expect(scenario.globalFamilies.every((f) => f.verdictHoldIds?.length === 0)).toBe(true);
      // Non-vacuity: the seeded run is dated 2026-06, so every member reads stale against the
      // request clock and the LIVE panel really does arm. Without this the carve-out above would
      // be comparing two all-`false` panels and would strip nothing.
      expect(live.globalFamilies.some((f) => f.coverageDegraded === true)).toBe(true);
      // …and the C1 §17.7 notify-axis twin the two paths compute separately (scenario:
      // `computeFamilyPanelFromStates` over DIAL_FAMILIES; live: assembleDial's `globalPanel`).
      // This pins the two paths AGAINST EACH OTHER; the live path's roster is pinned on its own
      // in the B-11 describe ("the LIVE path (no `?s=`) serves the DIAL roster as `dialFamilies`"),
      // so a mutation of `api/lab.ts`'s live `dialFamilies:` no longer rests on this line alone.
      expect(sansCoverage(scenario.dialFamilies)).toEqual(sansCoverage(live.dialFamilies));
      expect(scenario.t1dial.band).toEqual(live.t1dial.band);
      // Both inherited scalars are live (non-vacuous): the gated held marker IS the persisted sleeve.
      expect(live.field.held!.sleeve).toBe(HELD);
      expect(scenario.field.held!.sleeve).toBe(HELD);

      // THE FALSIFIER — unconditional, no ≤1-lit / held-sleeve carve-out.
      expect(scenario.field).toEqual(live.field);
    },
  );

  // ⚠ No non-degeneracy guard: the parity row above does not prove the member history (hold / ROC)
  // moves a single number on this fixture — its pre-share-lit guard was deleted 2026-07-17 (F12, DEC-21).

});

describe("GET /api/lab - R1 walk overlay (Stage 2.2)", () => {
  // The live panel here is all-green ⇒ a LOW targetRung. Seeding a DEFENSIVE held sleeve therefore
  // makes the live path a RE-RISK, and the scenario path (`?s=…:RED`) a DE-RISK against the SAME
  // inherited prior — which is exactly the Slice-2.1 rule this stage rides on.
  const GREEN = GREEN_SEED;

  async function seed(
    overrides: Parameters<typeof makeAlert>[0],
    extraReadings: readonly StoredReading[] = [],
  ): Promise<void> {
    store = new InMemoryStore();
    await store.recordRun(
      [...GREEN.map((id) => sr(id, "GREEN")), ...extraReadings],
      RUN_AT,
      makeAlert(overrides),
    );
  }

  // WIRING ONLY: the copy per (target, prior, trend) is owned by src/lab-overlays.test.ts `resolveR1View`.
  // The CAUSE the headline names must be the cause the code READ (review finding 1, 2026-08-07): the
  // handler threads the real `trendConfirming` read, so two arms identical but for one member state
  // must render DIFFERENT copy. Staples = rung 9, the ladder floor; an all-green board targets far
  // below it, so both arms are a re-risk.
  test("the trend read is threaded: a confirmed-RED GT flips a re-risk from 'pending' to 'held by trend'", async () => {
    const headOf = async (extra: readonly StoredReading[]) => {
      await seed({ heldSleeve: "Staples", reriskConfirmCount: 0 }, extra);
      const body = (await (await GET()).json()) as LabResponse;
      const target = body.t1dial.targetRung;
      expect(target).toBeLessThan(9); // else this is not a re-risk and the case proves nothing
      return { headline: body.overlays.r1!.headline, route: `r9 (Staples) → r${target} (${body.ladder[target - 1]})` };
    };
    // No GT/GB member RED ⇒ trendConfirming is TRUE ⇒ the veto is NOT what is holding this.
    const calm = await headOf([]);
    expect(calm.headline).toBe(`re-risk pending: ${calm.route}`);
    // GT is a `CONFIRMING_TREND_MEMBERS` id — the one extra reading is exactly what `trendConfirming` reads.
    const vetoed = await headOf([sr("GT", "RED")]);
    expect(vetoed.headline).toBe(`re-risk held by trend: ${vetoed.route}`);
  });

  test("a crisis scenario against the INHERITED live prior renders a de-risk queued jump", async () => {
    await seed({ heldSleeve: "Value", reriskConfirmCount: 0 }); // Value = rung 4

    const body = (await (
      await GET(new Request("https://lab.test/api/lab?s=credit:RED,volatility:RED,trend:RED,cross-asset:RED,rates:RED"))
    ).json()) as LabResponse;
    expect(body.mode).toBe("scenario");
    const target = body.t1dial.targetRung;
    expect(target).toBeGreaterThan(4); // else this is not a de-risk and the case proves nothing
    // The r4 origin is the persisted hold the scenario path inherited (Slice-2.1 rule).
    expect(body.overlays.r1!.headline).toBe(`de-risk queued: r4 (Value) → r${target} (${body.ladder[target - 1]})`);
  });

  test("SILENCE: no held sleeve (cold start) omits the r1 KEY entirely - not a blank row", async () => {
    await seed({ heldSleeve: null });
    const body = (await (await GET()).json()) as LabResponse;
    // Key ABSENT, because overlay-strip.js's isEmptyValue drops empty FIELDS but always paints a
    // head — so a returned view can never be silent. Its siblings still ship.
    expect("r1" in body.overlays).toBe(false);
    expect(body.overlays.r4).toBeDefined();
  });
});


describe("GET /api/lab?replay= - historical replay (mode 2b)", () => {
  // P1 staleness (readInputSeries, INPUT_MAX_STALE_DAYS vs the handler's `now` seam): pin the clock
  // inside the armStitch fixtures' 45-day freshness window (BAMLH0A0HYM2 newest ≈ 2023-02-04); the
  // relative daysAgo fixtures below derive from the same pinned `clock`. Stale behavior itself is
  // unit-tested in src/input-series.test.ts.
  beforeEach(() => {
    clock = new Date("2023-03-01T12:00:00Z");
  });
  afterEach(() => {
    clock = undefined;
    hyVintage = HY_VINTAGE_DEFAULT;
  });
  // The replay shape (mirror of the plan's ReplayResponse — Stage 2.2 mints the DTO).
  interface ReplayBody {
    mode: string;
    start: string;
    end: string;
    points: { date: string; targetRung: number; r4Phase: string; cash: boolean }[];
    coverage: { id: string; firstDate: string | null }[];
    notes: string[];
  }

  // Validation involves "today" (the 10y floor, the getSeries limit), so seeded dates
  // and range endpoints are computed RELATIVE to now — never hard-coded wall-clock dates.
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  const daysAgo = (n: number): string => iso(new Date(clock!.getTime() - n * 86_400_000));

  // Union of GLOBAL_FAMILIES member ids the handler fetches — the coverage denominator.
  const MEMBER_IDS = [...new Set(GLOBAL_FAMILIES.flatMap((f) => f.ids))];

  function replayRow(indicatorId: string, date: string): StoredReading {
    return { date, indicatorId, value: 1, delta20: 0, rawState: "GREEN", state: "GREEN" };
  }

  /** Seed `count` consecutive daily GREEN closes ending `endDaysAgo` back, for members. */
  async function seedDailySeries(members: string[], count: number, endDaysAgo: number): Promise<void> {
    const rows: StoredReading[] = [];
    for (let i = 0; i < count; i++) {
      const date = daysAgo(endDaysAgo + i);
      for (const id of members) rows.push(replayRow(id, date));
    }
    // One run_at is fine — getSeries collapses to latest-vintage per date regardless.
    await store.recordReadings(rows, `${daysAgo(endDaysAgo)}T21:00:00.000Z`);
  }

  test("a parseReplay error and the ?s conflict both 400", async () => {
    store = new InMemoryStore();
    const status = async (qs: string): Promise<number> =>
      (await GET(new Request(`https://lab.test/api/lab?${qs}`))).status;

    expect(await status("replay=garbage")).toBe(400);
    expect(await status(`s=credit:RED&replay=${daysAgo(30)}:${daysAgo(1)}`)).toBe(400);
  });

  test("happy path: seeded InMemoryStore → mode=replay, points, monotone dates, full coverage, notes", async () => {
    store = new InMemoryStore();
    // 40 daily closes for two members ending yesterday; a 30-day range covers ~29 of them.
    await seedDailySeries(["F1", "R1"], 40, 1);
    const start = daysAgo(30);
    const end = daysAgo(0);

    const res = await GET(new Request(`https://lab.test/api/lab?replay=${start}:${end}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("s-maxage=600");
    const body = (await res.json()) as ReplayBody;

    expect(body.mode).toBe("replay");
    expect(body.start).toBe(start);
    expect(body.end).toBe(end);
    expect(body.points.length).toBeGreaterThan(0);
    // Dates strictly increasing (trading-day axis, no dupes) and each targetRung ∈ 1..9.
    for (let i = 1; i < body.points.length; i++) {
      expect(body.points[i]!.date > body.points[i - 1]!.date).toBe(true);
    }
    expect(body.points.every((p) => p.targetRung >= 1 && p.targetRung <= 9)).toBe(true);
    // Coverage has an entry per REQUESTED member (the union GLOBAL_FAMILIES id set)…
    expect(body.coverage.map((c) => c.id).sort()).toEqual([...MEMBER_IDS].sort());
    // …and the two seeded members carry a real firstDate.
    expect(body.coverage.find((c) => c.id === "F1")!.firstDate).toBe(daysAgo(40));
    expect(body.notes.length).toBeGreaterThan(0);
  });

  test("empty store → 200, empty points, coverage present with all-null firstDates (honest, not 404)", async () => {
    store = new InMemoryStore();
    const { warn, calls } = warnSink();
    const res = await GET(new Request(`https://lab.test/api/lab?replay=${daysAgo(30)}:${daysAgo(0)}`), { warn });
    // §6 missing-row rule: the HY-OAS input rows are absent → warnMissingInput, lab:replay label.
    // (Once per instance PER SINK — a fresh injected sink starts its own once-set, so the warn fires here.)
    expect(
      calls.some((c) => String(c[0]).includes("BAMLH0A0HYM2 missing/stale in the store (lab:replay)")),
    ).toBe(true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReplayBody;
    expect(body.mode).toBe("replay");
    expect(body.points).toEqual([]);
    expect(body.coverage.map((c) => c.id).sort()).toEqual([...MEMBER_IDS].sort());
    expect(body.coverage.every((c) => c.firstDate === null)).toBe(true);
  });

  test("a failed member read → 200, that member absent, warned with its id", async () => {
    const base = new InMemoryStore();
    store = overriding(base, { getSeries: (id, limit, range) => (id === "F1" ? Promise.reject(new Error("F1 down")) : base.getSeries(id, limit, range)) });
    const { warn, calls } = warnSink();
    const res = await GET(new Request(`https://lab.test/api/lab?replay=${daysAgo(30)}:${daysAgo(0)}`), { warn });
    expect(res.status).toBe(200);
    expect(calls.map((c) => String(c[0]))).toContain("[lab] replay F1 read failed - replayed as an absent member:");
  });

  // ── E8 item 2 — the stitched HY-OAS level override (review 2026-08-01, C1 + I2) ───────────────
  //
  // These four cases are what the fixture feed bought: before it, the replay tests ran whichever
  // branch ambient connectivity happened to give them, with no assertion able to tell the two apart.

  const dayMs = 86_400_000;
  const shift = (start: string, i: number): string => iso(new Date(Date.parse(start) + i * dayMs));
  /** Daily HY-OAS observations at a CONSTANT level — `value` is the level R4 reads. */
  const hyDaily = (start: string, days: number, value: number): Observation[] =>
    Array.from({ length: days }, (_, i) => ({ date: shift(start, i), value }));

  /** Seed `days` consecutive RED closes from `start` for every requested member.
   *  `value: 1` everywhere is load-bearing on TWO members: VT's 1 is below `R4_VT_TAIL`, so the VT
   *  tail can never carry the R4 ENTER gate, and a stored F1 (where seeded) is below `R4_HY_TAIL`,
   *  so the stored level can't either. The HY OVERRIDE is therefore the only route into cash — which
   *  is what makes the arms below discriminate "R4 saw the stitched level" from "R4 saw nothing". */
  async function seedRedWindow(members: string[], start: string, days: number): Promise<void> {
    const rows: StoredReading[] = [];
    for (let i = 0; i < days; i++) {
      const date = shift(start, i);
      for (const id of members) {
        rows.push({ date, indicatorId: id, value: 1, delta20: 0, rawState: "RED", state: "RED" });
      }
    }
    await store.recordReadings(rows, `${start}T21:00:00.000Z`);
  }

  const WIN_START = "2022-06-01"; // pre-2023: the stored F1 rows begin 2023-07-25 in prod
  const RANGE = "replay=2022-06-15:2022-08-20";
  /** Every DIAL/board member EXCEPT F1 — the dark-credit shape the override exists for. */
  const MEMBERS_NO_F1 = MEMBER_IDS.filter((id) => id !== "F1");

  /** Arm a CLEAN stitch the P1.3 store-only way: vintage covering the window at `level`, and the
   *  cron-shaped BAMLH0A0HYM2 rows (raw GREEN-stamped, priceLegReadingSeries) seeded as its last
   *  30 rows (identical values ⇒ no overlap disagreement, no gap ⇒ the real stitchHyOas runs clean). */
  async function armStitch(level: number): Promise<void> {
    hyVintage = hyDaily("2022-01-01", 400, level);
    await store.recordReadings(priceLegReadingSeries("BAMLH0A0HYM2", hyVintage.slice(-30)), "2022-06-01T21:00:00.000Z");
  }

  // THE STITCHED-BRANCH CASE, pinned on OBSERVABLE OUTPUT rather than on the note alone: a note-only
  // assertion proves the wiring emitted a label, not that R4 ever read a level. Same store, same
  // window, same range, run twice — once with the override reaching R4 (HY ≥ R4_HY_TAIL ⇒ the ENTER
  // gate's tail leg is met ⇒ cash) and once with it absent (stored F1 dark ⇒ hyOas null ⇒ the tail
  // leg is structurally unreachable ⇒ equity forever). The DIVERGENCE is the pin.
  // Red demo: drop `{ hyOasLevels }` from the computeReplay call in api/lab.ts ⇒ the `cash` line reds.
  test("stitched branch: a pre-2023 window with DARK stored F1 reaches cash off the override", async () => {
    store = new InMemoryStore();
    await seedRedWindow(MEMBERS_NO_F1, WIN_START, 90);
    // Derived from the cut, not typed: whatever R4_HY_TAIL is, this level clears it.
    await armStitch(R4_HY_TAIL + 1);

    const withOverride = (await (await GET(new Request(`https://lab.test/api/lab?${RANGE}`))).json()) as ReplayBody;
    expect(withOverride.notes).toContain(HY_STITCHED_NOTE);
    expect(withOverride.points.length).toBeGreaterThan(0); // vacuity: an empty path proves nothing
    // R4 DEMONSTRABLY read a non-null HY level: the only tail available cleared R4_HY_TAIL.
    expect(withOverride.points.some((p) => p.cash && p.r4Phase === "cash")).toBe(true);

    // The SAME window with no override: a fresh store WITHOUT the BAMLH0A0HYM2 input rows —
    // the HY tail is unreachable, so the breaker never fires (§6 missing-row degrade).
    store = new InMemoryStore();
    await seedRedWindow(MEMBERS_NO_F1, WIN_START, 90);
    const noOverride = (await (await GET(new Request(`https://lab.test/api/lab?${RANGE}`))).json()) as ReplayBody;
    expect(noOverride.points.length).toBe(withOverride.points.length); // same axis, same days
    expect(noOverride.points.every((p) => !p.cash && p.r4Phase === "equity")).toBe(true);
  });

  // THE DEGRADE CASE (§6 missing-row rule). Absent BAMLH0A0HYM2 input rows are caught (the stitch
  // and the vintage load are NOT — corruption 500s, a missing input degrades), never fetched.
  // Red demo: swap the `storedTail === undefined` degrade for a `throw` in api/lab.ts ⇒ 500 here.
  test("missing stored BAMLH0A0HYM2 rows → 200 with the honest fallback note, and NO stitched note", async () => {
    store = new InMemoryStore();
    await seedRedWindow(MEMBERS_NO_F1, WIN_START, 90);
    hyVintage = hyDaily("2022-01-01", 400, R4_HY_TAIL + 1);

    const res = await GET(new Request(`https://lab.test/api/lab?${RANGE}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReplayBody;
    expect(body.notes.some((n) => /HY-OAS live tail unavailable - R4 fell back to the STORED F1 series/.test(n))).toBe(true);
    // The SEMANTICS label must not ride a response whose R4 never saw the stitched history.
    expect(body.notes).not.toContain(HY_STITCHED_NOTE);
  });

  // An ABSENT vintage file (a checkout without data/BAMLH0A0HYM2-vintage.csv) takes the same degrade as a
  // missing input — the stored rows are armed here, so only the vintage seam separates it from the cash case.
  // Red demo: make the `vintage === undefined` branch in api/lab.ts fall through to `stitchHyOas` ⇒ a 500 here.
  test("absent vintage file → 200 with the history-unavailable note, never the stitch (stays equity)", async () => {
    store = new InMemoryStore();
    await seedRedWindow(MEMBERS_NO_F1, WIN_START, 90);
    await armStitch(R4_HY_TAIL + 1);

    const res = await GET(new Request(`https://lab.test/api/lab?${RANGE}`), { vintage: () => undefined });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReplayBody;
    expect(body.notes.some((n) => /HY-OAS history unavailable - R4 fell back to the STORED F1 series/.test(n))).toBe(true);
    expect(body.notes).not.toContain(HY_STITCHED_NOTE);
    expect(body.points.length).toBeGreaterThan(0);
    expect(body.points.every((p) => !p.cash && p.r4Phase === "equity")).toBe(true);
  });

  // P1.3 — the stitch runs off the STORE, never a feed: owned statically by api/no-upstream-fetch.test.ts
  // (no feed module in this handler's transitive import graph), not by a counting fetch mock here.

  // I2 — the WINDOW gate, and that it is derived FROM THE DATA. Both arms run against the same
  // store, whose F1 coverage opens at WIN_START; only the range start moves. A gate that restated a
  // "2023-07-25" literal instead of reading `memberSeries` would read the input in BOTH arms (both
  // starts precede that date), reddening the first arm. The HY input read is the replay path's ONLY
  // `getSeriesBulk` caller (readInputSeries), so the spy discriminates the gate exactly.
  // Red demo: replace `storedF1First > parsed.start` with `true` ⇒ the first arm reds with 1 call.
  test("window gate: a range inside the stored F1 coverage skips the input read entirely", async () => {
    store = new InMemoryStore();
    await seedRedWindow(MEMBER_IDS, WIN_START, 90); // F1 SEEDED here — coverage opens WIN_START
    await armStitch(R4_HY_TAIL + 1);
    const seeded = store;
    let bulkCalls = 0;
    store = overriding(seeded, {
      getSeriesBulk: (ids, opts) => (bulkCalls++, seeded.getSeriesBulk(ids, opts)),
    });

    const inside = (await (
      await GET(new Request("https://lab.test/api/lab?replay=2022-06-15:2022-08-20"))
    ).json()) as ReplayBody;
    expect(bulkCalls).toBe(0); // no store input read at all
    expect(inside.notes).not.toContain(HY_STITCHED_NOTE);

    // NON-VACUITY: the same store with a range OPENING BEFORE that coverage does read and stitch.
    const before = (await (
      await GET(new Request("https://lab.test/api/lab?replay=2022-05-01:2022-08-20"))
    ).json()) as ReplayBody;
    expect(bulkCalls).toBe(1);
    expect(before.notes).toContain(HY_STITCHED_NOTE);
  });

  // CHARACTERIZATION (ai-debt sweep 5.4): the whole `?replay=` wire — status, cache header, body — on
  // the stitched window, so extracting the branch out of `handle` must reproduce it byte for byte.
  test("characterization: the stitched-window replay response", async () => {
    store = new InMemoryStore();
    await seedRedWindow(MEMBERS_NO_F1, WIN_START, 90);
    await armStitch(R4_HY_TAIL + 1);
    const res = await GET(new Request(`https://lab.test/api/lab?${RANGE}`));
    expect({ status: res.status, cache: res.headers.get("Cache-Control"), body: await res.json() }).toMatchSnapshot();
  });
});




describe("GET /api/lab - legAttribution wiring (D3 Stage 2.3)", () => {
  const green = GREEN_SEED;

  // The decline arms (no-history / recompute-disagreed / mid-confirm), the axis mapping and the
  // degraded flag are pinned directly in src/lab-attribution.test.ts (rung 7a, 2026-09-20).

  /**
   * F1's proxy fixture (2026-07-28; the borrowed legs it was built for are RETIRED). 60 daily
   * closes shared by F1 and the BAA10Y proxy, ending on the run's date:
   *  - F1's OWN value is flat and a full point under its own `amberLevel`, so at the `F1_FLAT`
   *    base neither `op` nor `vel-op` (flat ⇒ Δ30d = 0) can fire; the firing cases pass
   *    `F1_RED_HEAD` instead, which lights F1's own `op`+`vel-op` AND.
   *  - the proxy steps ONCE, exactly 30 closes before the tail, from `PROXY_LO` to `PROXY_HI`.
   *    ⚠ F1/F2's borrowed `z`/`vel-z` legs were retired 2026-08-06 and the whole proxy-z path
   *    deleted with them, so that step scores NOTHING today. The BAA10Y rows survive only as
   *    BAA10Y's OWN stored series (a second seeded id), not as an input to F1.
   * Both proxy numbers derive from FROZEN copies of BAA10Y's last live cuts — the indicator (and
   * its `family-descriptor-rows.ts` cuts) retired outright 2026-08-11, so there is no source to import.
   */
  const FROZEN_BAA10Y_LEVEL_AMBER = 1.71;
  const FROZEN_BAA10Y_VEL_RED = 0.09;
  const PROXY_HI = FROZEN_BAA10Y_LEVEL_AMBER - 0.01;
  const PROXY_LO = PROXY_HI - 2 * FROZEN_BAA10Y_VEL_RED;
  const F1_FLAT = ALL_INDICATORS.find((i) => i.id === "F1")!.thresholds.amberLevel! - 1;
  const PROXY_DATES = Array.from({ length: 60 }, (_, i) =>
    new Date(Date.parse("2026-06-25") - (59 - i) * 86_400_000).toISOString().slice(0, 10),
  );
  const HISTORY_RUN_AT = "2026-06-24T21:00:00.000Z";

  /**
   * Seed the 60 shared closes, F1's own tail PLUS the BAA10Y series.
   *
   * BAA10Y is seeded UNCONDITIONALLY (the `withProxy: boolean` first parameter was dropped
   * 2026-08-06: its `false` arm existed for the `proxy-unavailable` decline, deleted with the
   * proxy-z path, and both surviving callers passed `true`). It is still seeded even though F1 no
   * longer borrows it, so a regression that re-admitted the borrowed legs would have the data to
   * name one and the assertions below would see it. The stored-proxy read stays a DB read, never a
   * live BAA10Y fetch.
   *
   * `laggingBy` re-dates the OTHER (green) rows that many days FORWARD of F1's tail — the
   * real-world shape where a price feed has today's close while FRED credit still carries
   * Friday's — and moves the alert with them, since the run's `asOf` is the MAX over reading
   * dates (`run-core.ts`). F1's own rows never move.
   */
  /**
   * F1's OWN-axis Red pair, stepped: `F1_RED_HEAD` clears the registry Red LEVEL cut and, jumping
   * off the calm `F1_FLAT` base, the Red VELOCITY cut too — so BOTH legs of the option-D AND fire.
   * Both cuts are READ from the registry, never
   * restated; a retune moves the head with them.
   */
  const F1_RED_HEAD = (() => {
    const t = ALL_INDICATORS.find((i) => i.id === "F1")!.thresholds;
    return Math.max(t.redLevel!, F1_FLAT + t.redVelocity!) * 1.01;
  })();

  async function seedProxyFixture(laggingBy = 0, f1Head = F1_FLAT): Promise<void> {
    const row = (date: string, indicatorId: string, value: number): StoredReading => ({
      date, indicatorId, value, delta20: 0, rawState: "RED", state: "RED",
    });
    const asOf = new Date(Date.parse(PROXY_DATES.at(-1)!) + laggingBy * 86_400_000)
      .toISOString()
      .slice(0, 10);
    // Leading history under an EARLIER run_at, like the F9 case: `getReadingsForRun` keys on
    // run_at, so seeding under RUN_AT would inject duplicates into the panel's readings.
    await store.recordReadings(
      PROXY_DATES.slice(0, -1).map((d) => row(d, "F1", F1_FLAT)),
      HISTORY_RUN_AT,
    );
    await store.recordReadings(
      PROXY_DATES.map((d, i) => row(d, "BAA10Y", i < 30 ? PROXY_LO : PROXY_HI)),
      HISTORY_RUN_AT,
    );
    await store.recordRun(
      [
        row(PROXY_DATES.at(-1)!, "F1", f1Head),
        ...green
          .filter((id) => id !== "F1")
          .map((id) => ({ ...sr(id, "GREEN"), date: asOf })),
      ],
      RUN_AT,
      makeAlert({ date: asOf }),
    );
  }

  // ⚠ CONTRACT REWRITTEN 2026-08-06: F1's Red is an
  // AND over its OWN pair, surfaced as the composite `"op+vel-op"` (velocity-class by the split
  // rule) — pinned in both directions in src/lab-attribution.test.ts. The lag case below keeps the
  // fixture (and the seeded BAA10Y series, so a borrowed-leg regression has data to name one).

  /**
   * The LAGGING-FEED regime (live prod 2026-07-27): the run's `asOf` is a MAX over every reading's
   * date, so an id off a slower feed carries an OLDER close than the run. Anchoring the fidelity
   * gate on `asOf` made that mismatch read as "the recompute disagreed" and declined F1/F2/BAA10Y
   * on every single run — prod served `asOf: 2026-07-27` beside a stored credit tail of 07-24.
   * This is the WIRING pin: the handler must hand `computeLegAttribution` each row's OWN date
   * (api/lab.ts, `toStoredReadings`), never the run's `asOf` — only that input can pass the gate here.
   */
  test("SPEAKS for F1 when its feed LAGS the run's asOf - the gate anchors on the row's own date", async () => {
    store = new InMemoryStore();
    await seedProxyFixture(4, F1_RED_HEAD);

    const body = (await (await GET()).json()) as LabResponse;
    expect(body.asOf).not.toBe(PROXY_DATES.at(-1)); // vacuity guard: the lag is real
    expect(body.legAttribution).toEqual([{ id: "F1", leg: "op+vel-op", axis: "velocity" }]);
  });

  /**
   * The proxy path's own decline arm (`proxy-unavailable`, F1 with BAA10Y unstored) was DELETED
   * 2026-08-06 with the proxy-z path: with no borrowed leg there is nothing a missing BAA10Y
   * series can stop F1 from scoring, so the arm became unreachable rather than merely untested.
   * F1's own-series attribution is pinned by the lag case above + src/lab-attribution.test.ts.
   */
  // Omitted on the scenario path: pinned by the seeded scenario-shape test in the `?s=` describe.
});

describe("GET /api/lab - R5 vol-target sizing overlay (Stage 4.2)", () => {
  // Seeded under an EARLIER runAt than the live run so the LEGP_* rows join the SERIES reads
  // without joining the current run's panel readings.
  const LEGP_RUN_AT = "2026-06-25T20:00:00.000Z";
  const LEGP_OBS = R5_MIN_OBS + 5;

  /** `n` daily closes for one leg, alternating ±`r` in log space so the realized vol is
   *  predictable. Dates step back from 2026-06-24 (the day before the verdict). */
  function legRows(sleeve: (typeof LADDER)[number], n: number, r: number): StoredReading[] {
    const rows: StoredReading[] = [];
    let close = 100;
    for (let i = 0; i < n; i++) {
      if (i > 0) close *= Math.exp(i % 2 === 0 ? r : -r);
      const d = new Date(Date.UTC(2026, 5, 24) - (n - 1 - i) * 86_400_000);
      rows.push(makeStoredReading(legCloseId(sleeve), { date: d.toISOString().slice(0, 10), value: close }));
    }
    return rows;
  }

  /** Seed EVERY leg, so the test never has to predict which sleeve the panel ends up holding. */
  async function seedAllLegs(annualVol: number): Promise<void> {
    // Matches r5.test.ts's closed form: for an alternating ±r series of n returns,
    // σ = r·√((n+1)/n), and the SHORT window dominates the ensemble max.
    const n = 19;
    const r = (annualVol / Math.sqrt(252)) / Math.sqrt((n + 1) / n);
    for (const sleeve of LADDER) {
      await store.recordReadings(legRows(sleeve, LEGP_OBS, r), LEGP_RUN_AT);
    }
  }

  async function seedRun(): Promise<void> {
    await store.recordRun([sr("F1", "GREEN")], RUN_AT, alert);
  }

  const fieldOf = (view: { fields: { label: string; value: string }[] }, label: string) =>
    view.fields.find((f) => f.label === label)!.value;

  /** 3.5b: the vol-target stats (realized vol over the held leg's licensed closes) are in `full` (non-vacuity)
   *  and never on the wire; the held leg and target vol stay. */
  function expectR5Withheld(redacted: LabResponse["overlays"][string], full: LabResponse["overlays"][string]): void {
    for (const label of ["gross", "realized vol", "cash (R5)", "if wired"]) {
      expect(fieldOf(full, label), label).not.toBe("-");
      expect(fieldOf(redacted, label), label).toBe("-");
    }
    expect(full.headline).toMatch(/realized vol \d/);
    expect(redacted.headline).toBe("vol-target stats withheld");
    expect(fieldOf(redacted, "held leg")).toBe(fieldOf(full, "held leg"));
    expect(fieldOf(redacted, "target vol")).toBe(fieldOf(full, "target vol"));
  }

  // WIRING PIN (rung 7b): the R5 view math is unit-tested in src/lab-overlays.test.ts; here we
  // prove the handler wires the seeded LEGP_* series + the persisted hold into the view and out.
  test("the handler wires the held leg's LEGP_* series into overlays.r5", async () => {
    store = new InMemoryStore();
    await seedRun();
    await seedAllLegs(0.45); // 45%/yr ⇒ 0.15/0.45 = 0.33 ⇒ floored at R5_MIN_GROSS

    const res = await GET();
    expect(res.status).toBe(200);
    const redacted = (await res.json()) as LabResponse;
    const body = await FULL();
    const r5 = body.overlays.r5!;
    expect(r5.id).toBe("r5");
    // The overlay must never name a different leg than the board highlights.
    expect(fieldOf(r5, "held leg")).toBe(body.field.held!.sleeve);
    // The seeded series reached the view: a sized gross, never the empty-store "-" degrade.
    expect(fieldOf(r5, "gross")).toBe(`${(R5_MIN_GROSS * 100).toFixed(0)}%`);
    expectR5Withheld(redacted.overlays.r5!, r5);
  });

  test("the scenario path renders R5 off the LIVE held leg (?s= re-states families, not the hold)", async () => {
    store = new InMemoryStore();
    await seedRun();
    await seedAllLegs(0.45);

    const redacted = (await (
      await GET(new Request("https://lab.test/api/lab?s="))
    ).json()) as LabResponse;
    const body = await FULL(new Request("https://lab.test/api/lab?s="));
    expect(body.mode).toBe("scenario");
    const r5 = body.overlays.r5!;
    expect(fieldOf(r5, "held leg")).toBe(body.field.held!.sleeve);
    expect(fieldOf(r5, "gross")).toBe(`${(R5_MIN_GROSS * 100).toFixed(0)}%`);
    expectR5Withheld(redacted.overlays.r5!, r5);
  });
});


describe("GET /api/lab - Y1 relative-strength pick overlay (Stage 5.2)", () => {
  // Seeded under an EARLIER runAt than the live run so the LEGP_* rows join the SERIES reads
  // without joining the current run's panel readings — same trick as the R5 block above.
  const LEGP_RUN_AT = "2026-06-25T20:00:00.000Z";
  // One close per calendar day, so the newest Y1_MIN_OBS dates span Y1_MIN_OBS−1 days — well
  // inside Y1_MAX_SPAN_DAYS, i.e. the lag gate is deliberately NOT the thing under test here.
  const Y1_OBS = Y1_MIN_OBS + Y1_PERSIST + 3;
  const NOISE = 0.01;

  /** `n` daily closes whose log return alternates ±NOISE around a constant `drift`. Every leg then
   *  carries the SAME realized vol, so the vol-scaled cross-section ranks purely on drift — which is
   *  what lets a test name the intended leader without predicting z-scores. */
  function legRows(sleeve: (typeof LADDER)[number], n: number, drift: number): StoredReading[] {
    const rows: StoredReading[] = [];
    let logClose = Math.log(100);
    for (let i = 0; i < n; i++) {
      if (i > 0) logClose += drift + (i % 2 === 0 ? NOISE : -NOISE);
      const d = new Date(Date.UTC(2026, 5, 24) - (n - 1 - i) * 86_400_000);
      rows.push(makeStoredReading(legCloseId(sleeve), { date: d.toISOString().slice(0, 10), value: Math.exp(logClose) }));
    }
    return rows;
  }

  /** Seed all nine legs flat, except `leader`, which trends hard enough to clear Y1_MARGIN by a
   *  wide margin on every lookback — and does so on every one of the last Y1_PERSIST closes too,
   *  since the drift is constant, so the streak completes. */
  async function seedLegs(leader: (typeof LADDER)[number], n = Y1_OBS): Promise<void> {
    for (const sleeve of LADDER) {
      await store.recordReadings(legRows(sleeve, n, sleeve === leader ? 0.004 : 0), LEGP_RUN_AT);
    }
  }

  async function seedRun(): Promise<void> {
    await store.recordReadings([sr("F1", "GREEN")], RUN_AT);
    await store.recordRun([sr("F1", "GREEN")], RUN_AT, alert);
  }

  const fieldOf = (view: { fields: { label: string; value: string }[] }, label: string) =>
    view.fields.find((f) => f.label === label)!.value;

  test("a dominant leg INSIDE the candidate set is picked, with a completed streak", async () => {
    store = new InMemoryStore();
    await seedRun();
    // Live band is {1,3} (fixed-width base) ⇒ candidates 1–4, incumbent Semis (rung 1). S&P IT is rung 2: inside.
    await seedLegs("S&P IT");

    const body = (await (await GET()).json()) as LabResponse;
    expect(body.t1dial.band).toEqual({ lo: 1, hi: 3 });
    const y1 = body.overlays.y1!;
    expect(y1.id).toBe("y1");
    expect(fieldOf(y1, "candidates")).toBe("rungs 1-4");
    expect(fieldOf(y1, "pick")).toBe("S&P IT (rung 2)");
    expect(fieldOf(y1, "incumbent")).toBe(`${body.field.held!.sleeve} (rung 1)`);
    expect(fieldOf(y1, "streak")).toBe(`${Y1_PERSIST}/${Y1_PERSIST}`);
    // A live switch is the one state worth a colour — and it is never "alert" (R4 owns that tone).
    expect(y1.tone).toBe("caution");
    expect(y1.headline).toContain("switching");
  });

  // G0 Stage 0.3 — the per-leg growthRs block (display-only, reused from resolveY1View's rsAt(0)).
  test("growthRs: one entry per LADDER sleeve; a leg with no RS serializes rs: null (Object.is)", async () => {
    store = new InMemoryStore();
    await seedRun(); // NO leg closes ⇒ every leg has no defensible RS ⇒ rs null across the board
    const body = (await (await GET()).json()) as LabResponse;

    expect(body.growthRs).toBeDefined();
    // One row per ladder sleeve, in ladder order.
    expect(body.growthRs!.map((e) => e.sleeve)).toEqual([...LADDER]);
    // rs is NULL — asserted with Object.is, not falsiness: a legitimate 0 RS is falsy but must
    // NOT satisfy this. Mutating the serializer to `rs ?? 0` turns these nulls into 0 and reds
    // exactly this line (the G0 red-demonstration).
    for (const entry of body.growthRs!) {
      expect(Object.is(entry.rs, null)).toBe(true);
    }
    expect(body.lookbacksUsed).toBe(0);
  });

  test("growthRs carries the resolver's live RS (non-vacuous: the leader's rs is real, not null)", async () => {
    store = new InMemoryStore();
    await seedRun();
    await seedLegs("S&P IT"); // a rankable cross-section ⇒ real RS on every eligible leg

    const body = await FULL();
    expect(body.growthRs!.length).toBe(LADDER.length);
    // The seeded leader has a defensible, finite RS — proves the block is not the all-null degrade
    // and that the value the Y1 resolver ranked is the value in the full body.
    const leader = body.growthRs!.find((e) => e.sleeve === "S&P IT")!;
    expect(leader.rs).not.toBeNull();
    expect(Number.isFinite(leader.rs!)).toBe(true);
    expect(body.lookbacksUsed).toBeGreaterThan(0);
  });

  test("3.5b: the served growthRs has every rs null (live and ?s=); the full body carries the leader's RS", async () => {
    store = new InMemoryStore();
    await seedRun();
    await seedLegs("S&P IT");

    for (const url of ["https://lab.test/api/lab", "https://lab.test/api/lab?s="]) {
      const full = await FULL(new Request(url));
      const redacted = (await (await GET(new Request(url))).json()) as LabResponse;
      expect(full.growthRs!.find((e) => e.sleeve === "S&P IT")!.rs, url).not.toBeNull();
      expect(redacted.growthRs!.map((e) => e.sleeve), url).toEqual([...LADDER]);
      for (const e of redacted.growthRs!) expect(Object.is(e.rs, null), `${url} ${e.sleeve}`).toBe(true);
      expect(redacted.lookbacksUsed, url).toBe(full.lookbacksUsed);
    }
  });
  // ABSENT (no store to rank over ⇒ y1/growthRs/lookbacksUsed omitted) rides the unconfigured-store
  // scenario test in the `?s=` describe — the same storeless world.
});


describe("GET /api/lab - B-11: SLOW legs are DISPLAY-only, on both the live and scenario paths", () => {
  // The ruling has two halves and they point OPPOSITE ways, so both are pinned here on the
  // SERVED response (not on an internal seam): the four slow legs must RENDER on the board —
  // `public/lab.js` builds tiles, `buildMemberState`, `membersByFamily` and the replay member
  // map from `d.globalFamilies` — while never reaching `t1dial`, which IS the notify band.
  // C1 ruling, 2026-07-31:
  // /lab's member-level diffusion count folds the DIAL axis, so the response must serve
  // that panel in its OWN field — additively, beside the display axis. Pins both B-11 halves, the
  // new field AND the neutrality claim (no scored field moves).
  test("a RED slow leg reddens the display axis only: `dialFamilies` and t1dial stay calm", async () => {
    store = new InMemoryStore();
    const calm = (await (await GET(new Request("https://lab.test/api/lab?s="))).json()) as LabResponse;
    const lit = (await (
      await GET(new Request("https://lab.test/api/lab?s=complacency-high:RED"))
    ).json()) as LabResponse;

    // 0. Display half: the served globalFamilies carries the FULL declared volatility roster, the
    //    slow legs included (an earlier regression wired it to the DIAL panel), and the RED
    //    leg reddens its tile off a calm baseline.
    const litVol = lit.globalFamilies.find((f) => f.key === "volatility")!;
    expect(litVol.members.map((m) => m.id)).toEqual(GLOBAL_FAMILIES.find((f) => f.key === "volatility")!.ids);
    expect(SLOW_INDICATOR_IDS.size).toBeGreaterThan(0);
    for (const id of SLOW_INDICATOR_IDS) expect(litVol.members.map((m) => m.id)).toContain(id);
    expect(litVol.members.find((m) => m.id === "complacency-high")!.state).toBe("RED");
    expect(calm.globalFamilies.find((f) => f.key === "volatility")!.state).toBe("GREEN");
    // Notify half: the dial does not move (volatility is a FIRE family — folding it against
    // GLOBAL_FAMILIES would flip `fired` and gate rungs 7-9), while the board's `firingCount`,
    // folded off the display panel, does.
    expect(lit.t1dial).toEqual(calm.t1dial);
    expect(lit.firingCount).toBe(calm.firingCount + 1);

    // 1. The new field IS the dial table's fold — its volatility roster is the DIAL one, so the
    //    four SLOW ids are absent from it (and present on the display panel, pinned above).
    const dialVol = lit.dialFamilies.find((f) => f.key === "volatility")!;
    expect(dialVol.members.map((m) => m.id)).toEqual(
      DIAL_FAMILIES.find((f) => f.key === "volatility")!.ids,
    );
    for (const id of SLOW_INDICATOR_IDS) expect(dialVol.members.map((m) => m.id)).not.toContain(id);
    // Vacuity guard: the two rosters really do differ, or the parity below proves nothing.
    expect(dialVol.members.length).toBeLessThan(
      lit.globalFamilies.find((f) => f.key === "volatility")!.members.length,
    );

    // 2. Discriminating: the RED slow leg reddens the DISPLAY panel and NOT the dial one — the
    //    exact divergence §17.7 rules the count must follow (the dial side, matching the push).
    expect(lit.globalFamilies.find((f) => f.key === "volatility")!.state).toBe("RED");
    expect(dialVol.state).toBe("GREEN");

    // 3. NEUTRALITY: state/live/firing/contribution are byte-identical across the two axes for
    //    EVERY family except the one the tables differ on — on both runs. Serving the dial panel
    //    moves the counted population and nothing else.
    const quad = (fs: LabResponse["globalFamilies"]) =>
      Object.fromEntries(
        fs.map((f) => [f.key, { state: f.state, live: f.live, firing: f.firing, contribution: f.contribution }]),
      );
    const rosters = (fs: LabResponse["globalFamilies"]) =>
      Object.fromEntries(fs.map((f) => [f.key, f.members.map((m) => m.id)]));
    for (const body of [calm, lit]) {
      const g = quad(body.globalFamilies);
      const d = quad(body.dialFamilies);
      const gIds = rosters(body.globalFamilies);
      const dIds = rosters(body.dialFamilies);
      expect(Object.keys(d)).toEqual(Object.keys(g)); // same families, same order
      // The one family the two tables differ on: its ROSTER diverges on BOTH runs (the quad
      // only diverges on `lit`, where the slow leg is RED — on `calm` it still agrees).
      expect(Object.keys(g)).toContain("volatility");
      expect(dIds.volatility).not.toEqual(gIds.volatility);
      // On `lit` the volatility quad is the ruled scored divergence, pinned above.
      for (const key of Object.keys(g).filter((k) => k !== "volatility" || body !== lit)) {
        expect(d[key], `family ${key} scored differently across the axes`).toEqual(g[key]);
      }
      for (const key of Object.keys(g).filter((k) => k !== "volatility")) {
        // The quad is a pure function of the worst-of state (`contribution = CONTRIBUTION[state]`),
        // so on these near-all-GREEN fixtures it agrees trivially; POPULATION equality is the claim
        // this block actually makes, and a roster divergence in any other family must red here.
        expect(dIds[key], `family ${key} folds a different member population`).toEqual(gIds[key]);
      }
    }
  });

  // The test above drives `?s=` only, so the LIVE path's `dialFamilies` wiring (api/lab.ts's
  // `dialFamilies: globalFamilies`, the assembleDial DIAL panel) rested on one transitive
  // assertion — the scenario↔live deep-equal in the mixed-depth suite. This pins it directly.
  test("the LIVE path (no `?s=`) serves the DIAL roster as `dialFamilies`", async () => {
    store = new InMemoryStore();
    const volIds = GLOBAL_FAMILIES.find((f) => f.key === "volatility")!.ids;
    // Every DISPLAY-axis volatility member reports, so the two rosters can only differ by the
    // table the panel was folded against — not by which feeds happened to be present.
    await store.recordRun(volIds.map((id) => sr(id, "GREEN")), RUN_AT, alert);

    const body = (await (await GET()).json()) as LabResponse;
    const dialVol = body.dialFamilies.find((f) => f.key === "volatility")!;
    // Goes RED if the live path serves the display panel here (the C1 defect).
    expect(dialVol.members.map((m) => m.id)).toEqual(
      DIAL_FAMILIES.find((f) => f.key === "volatility")!.ids,
    );
    for (const id of SLOW_INDICATOR_IDS) expect(dialVol.members.map((m) => m.id)).not.toContain(id);
    // Discriminating: the display field on the SAME live response keeps the full roster, so the
    // assertion above is a choice of axis and not two identical panels agreeing by accident.
    expect(body.globalFamilies.find((f) => f.key === "volatility")!.members.map((m) => m.id)).toEqual(volIds);
    expect(dialVol.members.length).toBeLessThan(volIds.length);
  });
});


describe("GET /api/lab - W5-d fall-shape overlay (Stage 4.1)", () => {
  // The three persisted columns carry DISTINCT, non-default values so every assertion below
  // traces to a real read of THIS row: makeAlert's defaults are
  // ("indeterminate", null, null), against which a dropped lookup would still render.
  const seed = async (over: Partial<Parameters<typeof makeAlert>[0]> = {}) => {
    store = new InMemoryStore();
    await store.recordRun([sr("F1", "GREEN")], RUN_AT, { ...makeAlert(), ...over });
    return (await (await GET()).json()) as LabResponse;
  };
  const fieldOf = (view: { fields: { label: string; value: string }[] }, label: string) =>
    view.fields.find((f) => f.label === label)!.value;

  // WIRING PIN (rung 7b): the projection (headline/tone/fields/copy per persisted triple) is
  // unit-tested in src/lab-overlays.test.ts. Here we prove the handler reads the three PERSISTED
  // columns off THIS run's alert row and serves the view — every value is distinct and non-default
  // (makeAlert's defaults are "indeterminate"/null/null), so a dropped column read reds its row.
  test("the persisted {shape, velocity, dwell} triple reaches the served view", async () => {
    const fs = (await seed({ fallShape: "bear", fallVelocity: -0.001, creditDwellCloses: 40 }))
      .overlays.fallShape as FallShapeOverlayViewDTO;
    expect(fs.id).toBe("fallShape");
    // NF-1 Stage 5.2: `confidence` rides as a first-class REQUIRED wire key — the type system
    // cannot supply this (`toServedField` ends in `as unknown as FieldResult`), so pin the parsed JSON.
    expect(Object.hasOwn(fs, "confidence")).toBe(true);
    expect(FALL_SHAPE_CONFIDENCE_VALUES).toContain(fs.confidence);
    expect(fieldOf(fs, "shape")).toBe("bear");
    expect(fieldOf(fs, "velocity")).toBe("-"); // licensed (single-input ACWI line) — withheld
    expect(fieldOf(fs, "credit dwell")).toBe("40 closes");
  });

  test("a withheld velocity still drives confidence (indeterminate + velocity ⇒ no-fall, not dark)", async () => {
    const fs = (await seed({ fallShape: "indeterminate", fallVelocity: -0.001, creditDwellCloses: null }))
      .overlays.fallShape as FallShapeOverlayViewDTO;
    expect(fs.confidence).toBe("no-fall");
  });
  // LIVE ONLY: the scenario-shape test in the `?s=` describe pins the fallShape key's absence there.
});


describe("GET /api/lab?walk=N - forward walk (Slice 2)", () => {
  // A minimal seeded live run so getLastAlert()/getReadingsForRun() have something to seed day-0.
  const green = GREEN_SEED;
  async function seedRun(): Promise<void> {
    store = new InMemoryStore();
    await store.recordRun(green.map((id) => sr(id, "GREEN")), RUN_AT, alert);
  }

  test("walk=0 / absent leaves the current body untouched (no walkPath)", async () => {
    await seedRun();
    const absent = (await (await GET(new Request("https://lab.test/api/lab"))).json()) as LabResponse;
    const zero = (await (await GET(new Request("https://lab.test/api/lab?walk=0"))).json()) as LabResponse;
    expect("walkPath" in absent).toBe(false);
    expect("walkPath" in zero).toBe(false);
    // Byte-untouched: the walk=0 body equals the absent one.
    expect(zero).toEqual(absent);
  });

  // walk > WALK_CAP ⇒ 400 is pinned at its parser (src/lab-request.test.ts `parseWalk`); the
  // `walk=` arm below is the wire half — the handler FORWARDS that Response above the store read.
  test.each([["cb=1"], [`walk=${WALK_CAP + 1}`]])(
    "?%s is a 400 no-store before any store read (?cb= no longer mints a MISS-with-work edge key; an over-cap walk is refused, not clamped)",
    async (query) => {
      await seedRun();
      // S-1: rejected BEFORE the store read + deep freshness hoist — an unknown param or an over-cap
      // walk costs a 400, not the ~7s forward-walk recompute behind a fresh caller-selectable edge key.
      // A Proxy (not a vitest spy — that would re-isolate this file) logs every store method called.
      const calls: string[] = [];
      const seeded = store;
      store = new Proxy(seeded, {
        get(t, p, r) {
          const v = Reflect.get(t, p, r) as unknown;
          if (typeof v !== "function") return v;
          return (...args: unknown[]) => (calls.push(String(p)), (v as (...a: unknown[]) => unknown).apply(t, args));
        },
      });
      const rej = await GET(new Request(`https://lab.test/api/lab?${query}`));
      expect(rej.status).toBe(400);
      expect(rej.headers.get("Cache-Control")).toBe("no-store");
      expect(calls).toEqual([]);
    },
  );

  test("walk composes with ?s= - a scenario + walk returns a day-indexed walked body", async () => {
    await seedRun();
    const res = await GET(new Request("https://lab.test/api/lab?s=credit:RED&walk=5"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as LabResponse;
    expect(body.mode).toBe("scenario");
    expect(body.walkPath!.map((p) => p.day)).toEqual([1, 2, 3, 4, 5]);
  });

  // Ruling 2026-08-05: the ledger headline
  // is TODAY'S POSITION, so `field.held` must be the UN-WALKED persisted hold even when the request
  // walks. The walk reaches the wire as `walkPath` and nothing else.
  //
  // DISCRIMINATING by construction: the seed holds the most AGGRESSIVE leg while the scenario runs
  // credit RED, so the walk de-risks off it on its first close (the de-risk side has no confirm /
  // dwell / trend gate — `src/rotation-commit.ts`). The `not.toBe` is the vacuity guard: it goes red
  // if the fixture ever stops separating the walked endpoint from the incumbent.
  test("a walked scenario serves the INCUMBENT held, not the settled one", async () => {
    store = new InMemoryStore();
    await store.recordRun(
      GREEN_SEED.map((id) => sr(id, "GREEN")),
      RUN_AT,
      makeAlert({ heldSleeve: "Semis", heldDays: 99, reriskConfirmCount: 99 }),
    );
    const body = (await (
      await GET(new Request("https://lab.test/api/lab?s=credit:RED&walk=12"))
    ).json()) as LabResponse;
    const settled = body.walkPath![body.walkPath!.length - 1]!.heldSleeve;
    expect(settled).not.toBe("Semis"); // the walk really does move the hold
    expect(body.field.held?.sleeve).toBe("Semis"); // …and the headline stays put
  });
});

// ── A4 ────────────────────────────
// THE CHECK THAT CAN GO RED. Before A4 a DEAD freshness read and a live one that found nothing
// stale were the same bytes: both leave every member unstamped (⇒ `obs: "lag"` on every cell) and
// both serve `feedLag: []`. So the one instrument that would show a feed outage could be
// stuck-on-dark with nothing on the wire saying so.
//
// Two arms, guarding two different production lines (each red-demoed separately):
//   1. HEALTHY — the store's own newest rows are current ⇒ the served census must report SOME
//      `fresh`. Guards `freshness = stamp?.freshness` in api/lab.ts's hoist (the wiring that carries
//      the stamp into `computeField`); mutating it to `undefined` reds this arm at `fresh: 0`.
//   2. DEAD READ — `freshnessFrom`'s own bulk read throws ⇒ the census legitimately reports zero
//      `fresh`, and `freshnessMissing: true` is what says so. Guards
//      `freshnessMissing = stamp === undefined`; pinning that to `false` reds this arm.
// Arm 2's `fresh: 0` line is not a duplicate of arm 1: it is what makes the flag discriminating —
// the two arms differ in exactly one input (a working store read) and the flag is the only wire
// field that separates them.
//
// The seed date is DERIVED through `todayOnFeedCalendar`/`FEED_TZ_OF` — the same seam
// `freshnessFrom` resolves "today" through — never a literal, so it cannot rot on a calendar
// boundary the way a hand-typed date would. The clock itself is PINNED to a weekday: a wall-clock
// Saturday/Sunday "today" is no publication slot on any feed calendar, so the census read every
// seeded row as `lag` and the control arm went red every weekend.
describe("A4 - a dead freshness read is distinguishable from a live one on the wire", () => {
  beforeEach(() => {
    clock = new Date("2026-10-02T14:00:00Z"); // a Friday
  });
  afterEach(() => {
    clock = undefined;
  });

  const freshCount = (b: LabResponse) =>
    b.field.legRows.reduce((a, r) => a + r.cells.reduce((n, c) => n + c.observed.fresh, 0), 0);

  /** A run whose stored observations are TODAY on each id's own publication calendar. */
  async function currentStore(extra: readonly StoredReading[] = []): Promise<InMemoryStore> {
    const s = new InMemoryStore();
    const now = clock!;
    await s.recordRun(
      [...extra, ...GREEN_SEED.map((id) => sr(id, "GREEN"))].map((r) => ({
        ...r,
        date: todayOnFeedCalendar(FEED_TZ_OF.get(r.indicatorId), now),
      })),
      RUN_AT,
      alert,
    );
    return s;
  }

  test("current rows ⇒ the census reports fresh members and the payload claims a stamp", async () => {
    // F3 AMBER makes this a FIRING run (it reaches getCalibration/attributeLeg/loadSynthHistories), so
    // it is also the healthy control arm of the calibration/attribution-reject describe below.
    store = await currentStore([sr("F3", "AMBER")]);
    const res = await GET(new Request("https://lab.test/api/lab"));
    expect(res.status).toBe(200);
    // A healthy live payload rides the full vintage policy (the control arm of both degraded-header describes).
    expect(res.headers.get("Cache-Control")).toBe(VINTAGE_HEADERS["Cache-Control"]);
    const body = (await res.json()) as LabResponse;
    // The defect this arm forbids: an all-`lag` census served off rows that are current today.
    expect(freshCount(body)).toBeGreaterThan(0);
    expect(body.freshnessMissing).toBe(false);
  });

  test("a THROWING freshness read serves freshnessMissing: true beside its zero-fresh census", async () => {
    const current = await currentStore();
    // Kill ONLY the stamp's own read. Since R14.4 `freshnessFrom`'s stage 1 reads the
    // monthly/quarterly ids at limit 1 (and the daily/weekly ids deep) — this is the one caller that
    // asks for exactly the DAY_IDS set at limit 1, so throwing there rejects the whole stamp while
    // every other bulk read in the handler still runs for real.
    const DAY_IDS = new Set(
      [...CADENCE_OF].filter(([, c]) => c !== "daily" && c !== "weekly").map(([id]) => id),
    );
    expect(DAY_IDS.size).toBeGreaterThan(0); // vacuity: there IS a monthly/quarterly day read to kill
    store = overriding(current, {
      getSeriesBulk: async (ids, opts) => {
        if (opts.limit === 1 && ids.length === DAY_IDS.size && ids.every((id) => DAY_IDS.has(id))) {
          throw new Error("[lab.test] the freshness read is dead");
        }
        return current.getSeriesBulk(ids, opts);
      },
    });
    const { warn, calls } = warnSink();
    const res = await GET(new Request("https://lab.test/api/lab"), { warn });
    expect(res.status).toBe(200); // the swallow stands: a dead stamp never 500s the board
    // P12.d negative caching: a store-degraded 200 must NOT be day-cached as the vintage —
    // it rides DEGRADED_HEADERS so the edge retries on its short TTL per key.
    expect(res.headers.get("Cache-Control")).toBe(DEGRADED_HEADERS["Cache-Control"]);
    const body = (await res.json()) as LabResponse;
    expect(body.freshnessMissing).toBe(true);
    // …and this is why the flag has to exist: the census now looks exactly like a healthy payload
    // on which no feed happens to be fresh — same bytes, opposite meaning.
    expect(freshCount(body)).toBe(0);
    expect(body.feedLag).toEqual([]);
    // The swallow reports in the LOGS too, not only on the wire.
    expect(calls.some((c) => String(c[0]).includes("freshness stamp UNAVAILABLE"))).toBe(true);
  });
});


// ── P12.e — a store REJECTION in the calibration/attribution swallows rides DEGRADED_HEADERS ─────
// The two named swallows (`store.getCalibration().catch` and `attributeLeg(...).catch` inside
// `computeLegAttribution`) plus the synth-load swallow used to leave a store-degraded 200 riding the
// day-long vintage, so a degraded public /overview stuck up to 24h. `degraded` now folds into the
// same header pick as `freshnessMissing`. Red demo: drop `|| degraded` at the header pick ⇒ the three
// reject arms red (they serve VINTAGE), the healthy control stays green.
describe("P12.e - a calibration/attribution store reject serves DEGRADED_HEADERS, not the vintage", () => {
  // F3 = a `synthPriors` id AND a DUAL_AXIS member ⇒ non-GREEN makes it a FIRING attribution target,
  // the only shape that reaches getCalibration/attributeLeg/loadSynthHistories in computeLegAttribution.
  const firing = () => [sr("F3", "AMBER"), ...GREEN_SEED.map((id) => sr(id, "GREEN"))];
  const cache = (res: Response) => res.headers.get("Cache-Control");

  // The healthy control arm (a FIRING run riding VINTAGE) is the dead-freshness describe's current-rows test above.
  test("getCalibration rejects ⇒ 200, CDN-cached degraded", async () => {
    store = new InMemoryStore();
    await store.recordRun(firing(), RUN_AT, alert);
    let hit = false;
    store = overriding(store, {
      getCalibration: () => ((hit = true), Promise.reject(new Error("[lab.test] calibration read is dead"))),
    });
    const res = await GET(new Request("https://lab.test/api/lab"));
    expect(res.status).toBe(200); // the swallow stands: a degraded read never 500s the board
    expect(hit).toBe(true); // non-vacuity: this fixture DOES reach getCalibration
    expect(cache(res)).toBe(DEGRADED_HEADERS["Cache-Control"]);
    expect(cache(res)).not.toBe(VINTAGE_HEADERS["Cache-Control"]);
  });

  test("the per-leg attributeLeg read rejects ⇒ 200, CDN-cached degraded", async () => {
    store = new InMemoryStore();
    await store.recordRun(firing(), RUN_AT, alert);
    const seeded = store;
    let hit = false;
    // attributeLeg reads F3 at legHistoryLimitFor(F3) (+ the carry over-read); narrow to that exact (id, limit)
    // so only the attribution recompute rejects, never another live-path getSeries("F3") on a different limit.
    const f3Limit = legHistoryLimitFor(ALL_INDICATORS.find((i) => i.id === "F3")!) + ESTIMATE_OVER_READ;
    store = overriding(seeded, {
      getSeries: async (id, limit, range) => {
        if (id === "F3" && limit === f3Limit) {
          hit = true;
          throw new Error("[lab.test] attribution series read is dead");
        }
        return seeded.getSeries(id, limit, range);
      },
    });
    const res = await GET(new Request("https://lab.test/api/lab"));
    expect(res.status).toBe(200);
    expect(hit).toBe(true); // non-vacuity: the attribution read for F3 WAS reached
    expect(cache(res)).toBe(DEGRADED_HEADERS["Cache-Control"]);
  });

  test("an attribution recompute that rejects outright warns naming the scope", async () => {
    store = new InMemoryStore();
    await store.recordRun(firing(), RUN_AT, alert);
    const seeded = store;
    const { warn, calls } = warnSink();
    // A SYNC throw escapes `getCalibration().catch` ⇒ `computeLegAttribution` itself rejects.
    const res = await handle(() => overriding(seeded, { getCalibration: () => { throw new Error("[lab.test] sync throw"); } }), new Request("https://lab.test/api/lab"), { warn });
    expect(res.status).toBe(200);
    expect(calls.map((c) => String(c[0]))).toContain("[lab] leg attribution failed - served empty, degraded:");
  });

});


// FXH-staleness parity: the served panel member
// state and field.memberState for the same id CANNOT disagree in one payload once option C serves the
// freshest close. Before the fix, globalFamilies FXH sat AMBER (the stale last-run 08-18 row) beside
// field.memberState FXH lit (the signal-hold raise walked readings_latest's fresher 08-19 RED) — one
// close, two vintages. The falsifier is the general invariant, not the FXH cell alone.
describe("§2d served-panel ⟷ field.memberState parity (option C)", () => {
  const mk = (id: string, state: State, date: string): StoredReading =>
    makeStoredReading(id, { date, rawState: state, state });
  const memberSev = (s: State | null | undefined): string | null =>
    s == null ? null : s === "RED" ? "lit" : s === "AMBER" ? "elev" : "calm";

  test("no id disagrees between the served panel and the field census", async () => {
    store = new InMemoryStore();
    // A depth of FXH RED closes ending 08-19 (so the signal-hold window has a fresh RED to raise on),
    // committed by an EARLIER run…
    const fxhDeep = Array.from({ length: 30 }, (_, i) =>
      mk("FXH", "RED", new Date(Date.parse("2026-07-21") + i * 86_400_000).toISOString().slice(0, 10)),
    );
    await store.recordRun(
      fxhDeep,
      "2026-08-19T22:51:00.000Z",
      makeAlert({ firedAt: "2026-08-19T22:51:00.000Z", date: "2026-08-19" }),
    );
    // …then the LAST run folds an OLDER FX obs (08-18) that scored AMBER — the non-monotonic slip 2b.
    await store.recordRun(
      [mk("FXH", "AMBER", "2026-08-18"), mk("F1", "GREEN", "2026-08-20")],
      "2026-08-20T06:33:00.000Z",
      makeAlert({ firedAt: "2026-08-20T06:33:00.000Z", date: "2026-08-20" }),
    );

    const body = (await (await GET(new Request("https://lab.test/api/lab"))).json()) as LabResponse;

    // The invariant, over EVERY id present in both maps: unless the field entry is a HOLD-OVER from an
    // older close (heldAge > 0 — a legitimate signal-hold, not a staleness bug), the served panel member
    // and the field census must read the same severity.
    let checked = 0;
    for (const f of body.globalFamilies) {
      for (const m of f.members) {
        const cell = body.field.memberState[m.id];
        if (!cell) continue;
        if (cell.held && (cell.heldAge ?? 0) > 0) continue; // hold-over ⇒ panel < field is legitimate
        checked++;
        expect(memberSev(m.state), `panel ${m.id} vs field.memberState[${m.id}]`).toBe(cell.sev);
      }
    }

    // Non-vacuity: FXH is the discriminating id — the field lit off the fresh 08-19 RED with NO hold-over
    // (heldAge 0), and option C serves that same RED on the panel (provisional chip). Without the swap
    // the panel read AMBER (elev) beside the lit field cell and the loop above reds.
    const xa = body.globalFamilies.find((fam) => fam.key === "cross-asset")!;
    const fxh = xa.members.find((m) => m.id === "FXH")!;
    expect(body.field.memberState.FXH?.sev).toBe("lit");
    expect(body.field.memberState.FXH?.heldAge ?? 0).toBe(0);
    expect(fxh.state).toBe("RED"); // served the freshest close, not the folded 08-18 AMBER
    expect(fxh.obs).toBe("2026-08-19"); // item 3: the served member carries its freshest obs_date
    // FXH is `=X`-fed: its 08-19 row written 08-19 EOD stays provisional (SESSION_CLOSE_UTC_MIN) ⇒ chip, no band-lag mark.
    expect([fxh.provisional, xa.bandLagIds ?? []]).toEqual([true, []]);
    expect(checked).toBeGreaterThan(0);
  });
});


// B5 (R7/R9): an INTRADAY served row colours + labels the chip but never marks `bandLagIds`; the
// dial and band stay on the EOD run. Control + resolver arms → src/lab-served-members.test.ts.
describe("B5 - a provisional served member never sets bandLagIds", () => {
  const mk = (id: string, state: State, date: string): StoredReading =>
    makeStoredReading(id, { date, rawState: state, state });
  const seed = async (): Promise<void> => {
    store = new InMemoryStore();
    await store.recordRun(
      [mk("FXH", "GREEN", "2026-08-19"), mk("F1", "GREEN", "2026-08-19")],
      "2026-08-19T22:51:00.000Z",
      makeAlert({ firedAt: "2026-08-19T22:51:00.000Z", date: "2026-08-19" }),
    );
  };
  const get = async (): Promise<LabResponse> =>
    (await (await GET(new Request("https://lab.test/api/lab"))).json()) as LabResponse;
  const fxhOf = (b: LabResponse) => {
    const xa = b.globalFamilies.find((fam) => fam.key === "cross-asset")!;
    return { xa, fxh: xa.members.find((m) => m.id === "FXH")! };
  };

  test("intraday RED row: chip serves RED + provisional, no bandLagIds, dial members stay EOD", async () => {
    await seed();
    const before = await get();
    // Intraday run (14:00 UTC < the 21:05 cutoff) writes readings only — no alert row (R1).
    await store.recordReadings([mk("FXH", "RED", "2026-08-20")], "2026-08-20T14:00:00.000Z");
    const after = await get();
    const { xa, fxh } = fxhOf(after);
    expect(fxh.state).toBe("RED"); // R9: coloured by its intraday state
    expect(fxh.obs).toBe("2026-08-20");
    expect(fxh.provisional).toBe(true);
    expect(xa.bandLagIds).toBeUndefined();
    for (const f of after.dialFamilies) expect(f.bandLagIds, f.key).toBeUndefined();
    // I2/R1: the DIAL panel (the diffusion count's input) keeps the EOD member states + obs dates.
    const dialMembers = (b: LabResponse) => b.dialFamilies.flatMap((f) => f.members.map((m) => [m.id, m.state, m.obs]));
    expect(dialMembers(after)).toContainEqual(["FXH", "GREEN", "2026-08-19"]);
    expect(dialMembers(after)).toEqual(dialMembers(before));
    expect(fxhOf(before).fxh.provisional).toBeUndefined();
  });
});

// ── P12.a — the per-vintage synth-history memo on the live path ────────────────────────────────
// Memo semantics (cacheIf, vintage keying) are owned by src/api/vintage-memo.test.ts; this pins the
// handler's "synth" memoByVintage wiring. Red demos: unwrap the call back to
// an un-memoized `loadSynthHistories(...)` ⇒ the "cached" assertion reds with 3; drop the loader's
// rethrowing `onFail` ⇒ the "retried" assertion reds with 1 (the swallowed empty map pinned).
describe("GET /api/lab - P12.a synth vintage memo", () => {
  test("a transient synth bulk failure is retried, the success is cached per vintage, and a new run pays again", async () => {
    store = new InMemoryStore();
    // F3 = the one `synthPriors` id AND a DUAL_AXIS member — non-GREEN makes it a firing
    // attribution target, the gate on `loadSynthHistories` in computeLegAttribution.
    const readings = [sr("F3", "AMBER"), ...GREEN_SEED.map((id) => sr(id, "GREEN"))];
    await store.recordRun(readings, RUN_AT, alert);
    const seeded = store;
    let failed = false;
    // Only the synth load reads at SYNTH_HISTORY_LIMIT — the member-history/pillar/scoreboard/freshness
    // bulks on this path all use other limits, so the counter counts exactly the memoized read.
    let synthBulks = 0;
    store = overriding(seeded, {
      getSeriesBulk: async (ids, opts) => {
        if (opts?.limit === SYNTH_HISTORY_LIMIT) {
          synthBulks++;
          if (!failed) {
            failed = true;
            throw new Error("transient store failure"); // rethrown by /lab's loader ⇒ the memo drops it
          }
        }
        return seeded.getSeriesBulk(ids, opts);
      },
    });
    const synthCalls = () => synthBulks;
    expect((await GET()).status).toBe(200);
    expect(synthCalls()).toBe(1); // non-vacuity: the failing bulk WAS reached
    expect((await GET()).status).toBe(200);
    expect(synthCalls()).toBe(2); // retried: the empty-map failure result was not cached
    expect((await GET()).status).toBe(200);
    expect(synthCalls()).toBe(2); // …and the successful retry IS cached for the vintage
    // A new run (new firedAt) is the invalidator (nightly cron in prod): the bulk is paid again.
    const RUN_AT2 = "2026-06-26T21:00:00.000Z";
    await store.recordRun(readings, RUN_AT2, { ...alert, firedAt: RUN_AT2 });
    expect((await GET()).status).toBe(200);
    expect(synthCalls()).toBe(3);
  });
});

// ── CHARACTERIZATION (ai-debt sweep 5.4) ─────────────────────────────────────────────────────────
// The whole `?s=` wire — status, cache header, body — on a pinned clock, so extracting the scenario
// branch out of `handle` must reproduce it byte for byte. Two worlds: a seeded store carrying a hold,
// every R4 knob and a composed `?walk=` (the store-backed arm), and the unconfigured store (the
// degraded pre-2.1 arm + its warn).
describe("characterization: the ?s= scenario response", () => {
  beforeEach(() => {
    clock = new Date("2026-06-26T15:00:00Z");
  });
  afterEach(() => {
    clock = undefined;
  });

  test("seeded store + every knob + walk", async () => {
    store = new InMemoryStore();
    await store.recordRun(
      GREEN_SEED.map((id) => sr(id, "GREEN")),
      RUN_AT,
      makeAlert({ heldSleeve: "Semis", heldDays: 4, reriskConfirmCount: 1 }),
    );
    const res = await GET(
      new Request("https://lab.test/api/lab?s=credit:RED,F2:AMBER,tail:1,daysInCash:20,lag:F1&walk=3"),
    );
    expect({ status: res.status, cache: res.headers.get("Cache-Control"), body: await res.json() }).toMatchSnapshot();
  });

  test("unconfigured store (degraded arm)", async () => {
    const { warn, calls } = warnSink();
    const res = await handle(unconfiguredStore, new Request("https://lab.test/api/lab?s=volatility:AMBER&walk=2"), {
      warn,
      now: clock!,
    });
    expect({
      status: res.status,
      cache: res.headers.get("Cache-Control"),
      body: await res.json(),
      warns: calls.map((c) => c.map(String)),
    }).toMatchSnapshot();
  });
});
