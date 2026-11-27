/**
 * Tests for GET /api/indicators (api/indicators.ts) — the per-(market, mode) resolved
 * bands / hide flags, the chart spec, and the static EW-7 bps report.
 *
 * The `provenance` field and its describe block were REMOVED 2026-07-30 with the wire
 * field itself
 * ("IS-3 consequence 2" [USER]). The honesty flag it read (`synthCutsDegraded`,
 * thin-history ⇒ hand-typed prior) is still pinned directly in `src/dashboard.synth-cuts.test.ts`.
 *
 * The handler takes an optional injected store (rung 8a); we hand it a pre-seeded
 * InMemoryStore directly (same pattern as api/status.test.ts).
 */
import { beforeEach, describe, expect, test } from "vitest";

import { ALL_INDICATORS, ID_SETS } from "../src/registry.js";
import { CHART_ONLY_INDICATORS } from "../src/registry-composite.js";
import { cardGroupOf, familyOf } from "../src/families.js";
import { resolveBands } from "../src/threshold-config.js";
import { derivedFiresHighward } from "../src/scorers-core.js";
import { InMemoryStore } from "../src/store-memory.js";
import type { CalibrationParam } from "../src/store.js";
import { PCT_MIN_OBS } from "../src/slow.js";
import { SYNTH_VEL_WINDOW } from "../src/synth-cuts.js";
import type { IndicatorMeta } from "../src/api/types.js";

const store = new InMemoryStore();

const { handle, indicatorsBody, STORED_COMPANION_HORIZON, buildIndicatorChart } = await import("./indicators.js");
const { CHART_ONLY_IDS } = await import("../src/registry-composite.js");
const { RS_LEG_OF } = await import("../src/registry-price.js");
const { MEMBER_WEIGHT } = await import("../src/danger-ladder.js");
const { EARLY_WARN_MEMBERS } = await import("../src/t1dial.js");

// The F3 chart test below seeds real history; every other describe assumes an empty
// store, so flush readings globally rather than leaking a seeded window sideways.
beforeEach(() => {
  store.readings.length = 0;
});

/** A calibration row with the boilerplate metadata filled in. */
function param(
  channel: string,
  metric: string,
  value: number,
  cell?: { market: string; mode: string },
): CalibrationParam {
  return {
    market: cell?.market ?? null,
    mode: cell?.mode ?? null,
    channel,
    metric,
    value,
    ciLow: null,
    ciHigh: null,
    method: "test",
    nEvents: 5,
    windowStart: null,
    windowEnd: null,
    notes: null,
    computedAt: "2026-06-30T00:00:00Z",
  };
}

/** The full body (`indicatorsBody`, before `handle`'s response rule redacts it), as a Response. */
const fullRes = async (): Promise<Response> => Response.json(await indicatorsBody(() => store, console.warn));

async function metaById(as: "redacted" | "full" = "redacted"): Promise<Map<string, IndicatorMeta>> {
  const res = as === "full" ? await fullRes() : await handle(() => store);
  expect(res.status).toBe(200);
  const body = (await res.json()) as IndicatorMeta[];
  return new Map(body.map((m) => [m.id, m]));
}

/**
 * EW-R1 Stage 4.1 / EW-7 — the bps sensitivity report on the wire. Static (vintage-
 * independent): it reports what the SHIPPED PERCENTILE implies in bps over three as-of
 * windows, sourced from the committed measurement output.
 */
describe("GET /api/indicators - bps sensitivity report (EW-7)", () => {
  // Hand-pinned from `scripts/backtest/f1_cuts.json`'s `spliced.asOfLadder` rather than
  // re-read from it: a test that recomputed the expectation from the same file the handler
  // reads would be circular and could not see a mis-mapped column or a dropped window.
  const EXPECTED = [
    { asOf: "2026-07-21", amberBps: 379.94, redBps: 469 },
    { asOf: "2015-12-31", amberBps: 555.32, redBps: 695 },
    { asOf: "2019-12-31", amberBps: 465.64, redBps: 629.6 },
  ];

  test("F1 carries today / 2015 / 2019, amber below red on every window", async () => {
    const f1 = (await metaById("full")).get("F1");
    const bps = f1?.bpsSensitivity;
    expect(bps, "F1 must carry the report").toBeDefined();
    expect(bps!.series).toBe(f1!.series); // the report describes THIS indicator's series
    expect(bps!.leg).toBe("level");
    // The amber/red bps columns are looked up by percentile (`p66_bps` from 0.66), so a
    // republish at a different pair must be a deliberate edit here, not a silent reuse.
    expect(bps!.percentiles).toEqual({ amber: 0.66, red: 0.9 });
    expect(bps!.points.map((p) => ({ asOf: p.asOf, amberBps: p.amberBps, redBps: p.redBps }))).toEqual(EXPECTED);
    for (const p of bps!.points) {
      expect(p.amberBps, `amber < red @ ${p.asOf}`).toBeLessThan(p.redBps);
      expect(p.n, `window ${p.asOf} is not thin`).toBeGreaterThan(252);
    }
  });

  test("the SAME percentile implies materially different bps per window - the point of the report", async () => {
    // Non-vacuity: a handler that emitted one window three times, or that served the
    // shipped cut as a constant, passes every shape check above and fails this one.
    const amber = (await metaById("full")).get("F1")!.bpsSensitivity!.points.map((p) => p.amberBps);
    expect(new Set(amber).size).toBe(amber.length);
    expect(Math.max(...amber) - Math.min(...amber)).toBeGreaterThan(100); // bps, not noise
  });

  test("every other indicator omits the field - no measurement exists for their series", async () => {
    const meta = await metaById("full");
    const carriers = [...meta.values()].filter((m) => m.bpsSensitivity !== undefined).map((m) => m.id);
    expect(carriers).toEqual(["F1"]);
  });
});

// Values read off a restricted series are redacted on the wire; the full body keeps them (`redactIndicators`).
describe("GET /api/indicators - licensed history-read values redacted in the served body", () => {
  // F7 (CAPE, licensed): a full monthly window anchored on this month, so the CAPE read does not degrade.
  const seedCape = () => {
    const now = new Date();
    return store.recordReadings(
      Array.from({ length: 400 }, (_, i) => ({
        date: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (399 - i), 1)).toISOString().slice(0, 10),
        indicatorId: "F7",
        value: 20 + i * 0.05,
        delta20: 0,
        rawState: "GREEN" as const,
        state: "GREEN" as const,
      })),
      "2026-09-07T00:00:00Z",
    );
  };
  const capeCuts = (m: IndicatorMeta | undefined) =>
    (Array.isArray(m?.chart?.bands) ? m.chart.bands : []).filter((b) => b.source === "displayBand").map((b) => b.value);

  test("the full body's F7 chart carries the CAPE band cuts read off the stored history", async () => {
    await seedCape();
    const res = await fullRes();
    const f7 = ((await res.json()) as IndicatorMeta[]).find((m) => m.id === "F7");
    const cuts = capeCuts(f7);
    expect(cuts).toHaveLength(2);
    for (const c of cuts) expect(Number.isFinite(c)).toBe(true);
  });

  test("public: F7's chart has no CAPE band cut (the cut-less spec), vintage-cached", async () => {
    await seedCape();
    const res = await handle(() => store);
    expect(res.headers.get("Cache-Control")).toBe("s-maxage=86400, stale-while-revalidate=86400");
    const f7 = ((await res.json()) as IndicatorMeta[]).find((m) => m.id === "F7")!;
    expect(capeCuts(f7)).toEqual([]);
    expect(f7.chart).toEqual(buildIndicatorChart(ALL_INDICATORS.find((i) => i.id === "F7")!));
  });

  test("public: F1's bps report (quantiles of a licensed series) is omitted; hand-set thresholds stay", async () => {
    const [redacted, unredacted] = [await metaById(), await metaById("full")];
    expect(redacted.get("F1")!.bpsSensitivity).toBeUndefined();
    expect(unredacted.get("F1")!.bpsSensitivity).toBeDefined();
    expect(redacted.get("F1")!.thresholds).toEqual(unredacted.get("F1")!.thresholds);
  });

  test("`auth` is an unknown param ⇒ 400 no-store", async () => {
    const res = await handle(() => store, new Request("https://x/api/indicators?auth=1"));
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

// The store-free structural chart tests (R1/R8 + F9 perPoint spec, CCC dual axis, MA-gate
// overlays, per-id shape coverage, fromDays, F2/VT/DISP) moved to api/indicators.chart.test.ts
// (rung 7c) — they call buildIndicatorChart directly. This suite keeps the wiring pins.

// N2 (registry convention bands strictly separated) moved to src/registry.test.ts —
// it never calls GET and belongs at the registry layer, resolving through the shared
// `operativePairUsable` predicate instead of a local replica.

describe("emitted derived band lines track the config threshold seam", () => {
  // The SCORER resolves F6/F8 bands through resolveBands(); the displayed `derived` line
  // must resolve identically or a config edit moves the ribbon but freezes the line (the
  // observed prod bug). Guard: emitted derived.amber/red === resolveBands(id, raw...).
  // For any indicator the config actually tunes, also assert the emitted value DIFFERS
  // from the raw registry band — proves the test isn't vacuous at the current config.
  test("derived.amber/red === resolveBands(id, registry band)", async () => {
    const meta = await metaById();
    for (const i of ALL_INDICATORS) {
      if (!i.derived) continue;
      const want = resolveBands(i.id, i.derived.amber, i.derived.red, derivedFiresHighward(i.derived));
      const d = meta.get(i.id)!.derived!;
      expect(d.amber).toBe(want.amber);
      expect(d.red).toBe(want.red);
    }
    // No divergence anchor remains: F8 (2026-07-23) and then F6 (2026-09-02 E4) both moved to
    // effective-form bands behind a plain 1.0 multiplier, so the shipped config is all-pass-through
    // and emitted === registry everywhere BY DESIGN. The seam still resolving (not frozen) is
    // pinned at the unit layer instead — resolveBands' multiplier/sign-flip tests in
    // src/dashboard.cuts.test.ts exercise the non-1.0 branches this config no longer reaches.
  });
});

describe("GET /api/indicators - declarative chart spec (Case 1, Stage 2)", () => {
  beforeEach(() => {
    store.calibration.length = 0;
  });


  // F3 scores the OR of FOUR legs (level cut + EVT tail + velocity cut + velocity EVT,
  // `CALIB_MAP.F3`), and until 2026-07-29 its detail chart drew the LEVEL pair alone — the whole
  // velocity axis could colour a bar with no line on screen to explain it. The four legs reduce
  // to TWO distinct cut values: F3 is a `synthPriors` id with no published vintage row, so the
  // `evt_*` and `operative_*` rows are emitted from the same computed percentile and the EVT leg
  // can never fire where its operative twin does not (`domain-cuts.ts`). So the completeness
  // claim is "one band pair per AXIS", which is what this pins — plus the cut values, which must
  // resolve off the seeded history rather than the dead degrade-fallback priors.
  // Red demo: drop `dualAxis` from F3's CHART_PARAMS_OF entry ⇒ no secondary axis ⇒ red.
  test("F3 draws both scoring axes as MOVING perPoint cuts: level pair + velocity amber, no phantom red", async () => {
    const n = PCT_MIN_OBS + SYNTH_VEL_WINDOW + 50;
    await store.recordReadings(
      Array.from({ length: n }, (_, i) => ({
        date: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
        indicatorId: "F3",
        value: 100 + 10 * Math.sin(i / 7), // a real distribution — a flat series collapses amber===red
        delta20: 5 * Math.sin(i / 5), // the velocity axis needs its own spread, or evt_vel_* degenerates
        rawState: "GREEN" as const,
        state: "GREEN" as const,
      })),
      "2026-07-29T00:00:00Z",
    );
    const chart = (await metaById()).get("F3")!.chart!;
    const bands = chart.bands as Array<{ axis: string; source: string; level?: string; fromPoint?: string }>;
    // Stage 1: F3's four synth legs' cuts are MOVING (expanding percentile), so both axes carry
    // perPoint lines, NOT the static threshold pairs — level amber+red on the primary, velocity
    // AMBER on the secondary. The velocity RED band is DROPPED (F3's prior defines no redVelocity).
    expect(bands.filter((b) => b.source === "threshold")).toHaveLength(0);
    expect(bands.filter((b) => b.axis === "primary" && b.source === "perPoint")).toHaveLength(2);
    const sec = bands.filter((b) => b.axis === "secondary" && b.source === "perPoint");
    expect(sec).toHaveLength(1);
    expect(sec[0]!.level).toBe("amber");
    // The velocity axis exists at all, and its caption names F3's WEEKLY span, not "d".
    const secondary = chart.axes.find((a) => a.id === "secondary")!;
    expect(secondary.label).toMatch(/Δ\d+w$/);
  });

  // Wiring pin (rung 7c): the wire `chart` IS `buildIndicatorChart`'s output per served id
  // (empty store ⇒ null capeCuts, the builder's own path). Shape/content pins live in the
  // direct suite (api/indicators.chart.test.ts).
  test("every served meta's chart deep-equals buildIndicatorChart(i) - the wire runs the builder", async () => {
    const meta = await metaById();
    const served = [...ALL_INDICATORS, ...CHART_ONLY_INDICATORS];
    for (const i of served) {
      // JSON round-trip mirrors the wire (Response.json collapses -0 to 0, e.g. F13's band).
      expect(meta.get(i.id)!.chart, `${i.id} chart wiring`).toEqual(JSON.parse(JSON.stringify(buildIndicatorChart(i))));
    }
    expect(meta.size).toBe(ALL_INDICATORS.length + CHART_ONLY_INDICATORS.length);
  });

  // The chart-only half of the 2026-07-26 VTP ruling (option B): "streak history + a chart, and
  // stays OFF notify". `/api/series?id=VTP` already served the history; a card + detail chart also
  // needs a SERVED META with a card group — renderZoneC (public/app.js) paints only ids having
  // both. Pinned per-consequence rather than as one shape assertion so a regression names itself.
  test("a CHART_ONLY id is served as a carded, chart-bearing, explicitly unweighted meta", async () => {
    const meta = await metaById();
    for (const i of CHART_ONLY_INDICATORS) {
      const m = meta.get(i.id);
      expect(m, `${i.id} is served by /api/indicators`).toBeDefined();
      // (a) the card exists: renderZoneC drops any meta with no family key.
      expect(m!.family, `${i.id} resolves a card group`).toBe(cardGroupOf(i.id));
      expect(m!.family, `${i.id} card group`).toBeDefined();
      // (b) it is DISTINGUISHABLE from a scored indicator on the wire — the flag the card's
      //     "chart only — not scored" marker reads.
      expect(m!.chartOnly, `${i.id} is flagged chart-only`).toBe(true);
      // (c) the chart is well-formed (the same contract the coverage test asserts above).
      expect(m!.chart, `${i.id} emits a chart`).toBeDefined();
      expect(m!.chart!.series.length, `${i.id} chart series`).toBeGreaterThan(0);
      // (d) steering NOTHING is structural, so pin it structurally: it is in no scored set and in
      //     no dial/panel family (a card group is NOT a family — cardGroupOf falls through to the
      //     display overlay when familyOf is undefined).
      expect(ID_SETS.scored, `${i.id} stays out of the scored set`).not.toContain(i.id);
      expect(familyOf(i.id), `${i.id} seats no panel/dial family`).toBeUndefined();
    }
    // Vacuity guard: the loop above is silent on an empty set, and every scored id must be
    // free of the flag (else "distinguishable" means nothing).
    expect(CHART_ONLY_INDICATORS.length).toBeGreaterThan(0);
    for (const i of ALL_INDICATORS) expect(meta.get(i.id)!.chartOnly, `${i.id} is not chart-only`).toBeUndefined();
  });

  test("F1 chart: 504d window + 30d lead, roc30 secondary series, one line per DRAWABLE scoring leg", async () => {
    // 2026-07-23 (`[USER]`) — F1's chart must let a bar colour be confirmed off the lines. F1
    // scores TWO legs since 2026-08-06 (`op` OR `vel-op` at Amber, `op` AND `vel-op` at Red —
    // it was an OR of four until the borrowed pair was retired); both are drawable, each with
    // its own band pair:
    // operative level (threshold → the registry prior) and the 30d velocity pair on the
    // secondary axis. The ARM +50/+28bp display bands that used to occupy that axis are GONE —
    // ARM is the exposure latch, not an F1 leg, so its lines confirmed nothing. The measured EVT
    // LEVEL pair that briefly drew a third, dotted pair here is gone too (retired 2026-07-23
    // `[USER]` — permanently dominated, so it could never be the leg that coloured a bar). The
    // borrowed regime-z leg on the Baa10y proxy — the one leg that had no line here, whose days
    // the renderer tagged instead — is gone too: the leg was retired 2026-08-06 and Stage 5.2
    // deleted both the proxy-z path and the renderer's tagging machinery
    // (`UNDRAWN_LEGS`/`legTagSvg`/`legTagLegend`). EVERY leg F1 scores is drawable
    // now, so the chart below is complete by construction rather than by a tagging fallback.
    await store.recordCalibration([
      param("credit", "hyoas_evt_level_amber", 3.7994),
      param("credit", "hyoas_evt_level_red", 4.69),
    ]);
    const chart = (await metaById()).get("F1")!.chart!;
    expect(chart.window).toBe(504); // ARM_RANGE_WINDOW
    expect(chart.lead).toBe(200); // max(ARM_ROC_WINDOW, the toggle MA200's window)
    const bands = chart.bands;
    if (bands === "context-only") throw new Error("F1 must declare real bands");

    // Secondary axis + roc30 series present.
    expect(chart.axes.some((a) => a.id === "secondary" && a.side === "right")).toBe(true);
    const roc = chart.series.find((s) => s.axis === "secondary");
    expect(roc?.compute).toBe("roc30");

    // Secondary axis now carries the SCORED velocity pair, resolved per mode — not a baked
    // ARM number. Mutate-red: restoring either ARM band re-adds a `displayBand` here.
    const sec = bands.filter((b) => b.axis === "secondary");
    expect(sec.map((b) => b.level).sort()).toEqual(["amber", "red"]);
    for (const b of sec) {
      expect(b.source).toBe("threshold");
      expect(b.metric).toBe("velocity");
      expect(b.value).toBeUndefined(); // resolved client-side from the mode cell, never baked
    }
    expect(bands.some((b) => (b.label ?? "").includes("ARM"))).toBe(false);

    // NO dotted EVT pair, even though the vintage above publishes those very rows — the routing
    // is what was retired, so this stays empty until `CALIB_MAP.F1.evtLevel` is reopened.
    expect(bands.filter((b) => b.style === "evt")).toEqual([]);

    // Primary threshold level cuts intact (both severities) — now the only primary pair.
    const primary = bands.filter((b) => b.axis === "primary" && b.source === "threshold");
    expect(primary.map((b) => b.level).sort()).toEqual(["amber", "red"]);
    for (const b of primary) expect(b.metric).toBe("level");
  });

  // One GET, one parity loop: the span/grid/mode fields are passed through RAW from the registry
  // (absent stays absent — the lean-wire convention), collected over every served id and asserted
  // once; the per-id facts the FE reads ride the same body below.
  test("wire parity: cadence/velocityWindow/velocityMode/obsCadence pass through raw; F9 caption, F3/F2 omissions", async () => {
    const meta = await metaById();
    const FIELDS = ["cadence", "velocityWindow", "velocityMode", "obsCadence"] as const;
    const violations: string[] = [];
    for (const i of [...ALL_INDICATORS, ...CHART_ONLY_INDICATORS]) {
      const m = meta.get(i.id);
      for (const f of FIELDS) {
        if (m?.[f] !== i[f]) violations.push(`${i.id}.${f}: wire ${String(m?.[f])} ≠ registry ${String(i[f])}`);
      }
    }
    expect(violations, "wire field ≠ registry field").toEqual([]);

    // F9 (broad-USD scorer redesign): the velocity span rides the
    // meta and the velocity-only axis carries its composed caption — the two wire facts the FE needs
    // to stop printing the hardcoded "Δ20 (20-day change)". F9 left the weekly H.10 release for daily
    // `USDU` 2026-08-10, so release and grid agree and the word resolves "d" through the plain
    // fallback; span derived so a retune moves it.
    const f9 = meta.get("F9")!;
    expect(f9.cadence).toBe("daily");
    const axis = f9.chart!.axes.find((a) => a.id === "primary")!;
    expect(axis.label).toBe(`Δ${f9.velocityWindow}d`);
    // The axis it captions really is the velocity one (a level axis would make this vacuous).
    expect(f9.chart!.series.find((s) => s.axis === "primary")?.fromPoint).toBe("delta20");
    // The OBSERVATION grid rides the meta only where it diverges (slice 2.2): F9 no longer declares
    // one, so the FE's `obsCadence ?? cadence` falls back to the now-daily cadence.
    expect(f9.obsCadence).toBeUndefined();

    // An id whose release schedule IS its observation grid omits obsCadence — the arm that keeps
    // F3's card honestly captioned "Δ4w". If this ever starts emitting, the FE's
    // `obsCadence ?? cadence` still holds — but the payload stopped being lean.
    const f3 = meta.get("F3")!;
    expect(ALL_INDICATORS.find((i) => i.id === "F3")!.obsCadence).toBeUndefined();
    expect(f3.obsCadence).toBeUndefined();
    expect(f3.cadence).toBe("weekly");

    // An id on the global default omits velocityWindow (absent = 20) — mirrors `cadence`'s
    // absent-means-default rule. F2 takes the default and must stay silent. Its caption still names
    // 20 — pinned by the F2 chart test, not restated here.
    expect(ALL_INDICATORS.find((i) => i.id === "F2")!.velocityWindow).toBeUndefined();
    expect(meta.get("F2")!.velocityWindow).toBeUndefined();

    expect(meta.get("F2")!.velocityMode).toBeUndefined();
  });

});

// D2 — the served `role` is derived from the SAME engine sets the scorers run on, so a roster
// move (a new chart-only id, a third downside detector, a seated member) re-labels the wire
// without an api/ edit. Each clause below is anchored non-empty so a registry refactor cannot
// turn a loop into a vacuous pass.
describe("GET /api/indicators - engine role (D2)", () => {
  test("every served id carries a role, and each engine set maps to its bucket", async () => {
    const meta = await metaById();
    const ewIds = EARLY_WARN_MEMBERS.flatMap((id) => [id, RS_LEG_OF[id]!]);
    expect(ewIds.length).toBeGreaterThan(0);
    expect(CHART_ONLY_IDS.length).toBeGreaterThan(0);
    for (const m of meta.values())
      expect(["member", "chart-only", "early-warning", "context"], `${m.id} role`).toContain(m.role);
    for (const id of CHART_ONLY_IDS) expect(meta.get(id)!.role, `${id} role`).toBe("chart-only");
    for (const id of ewIds) expect(meta.get(id)!.role, `${id} role`).toBe("early-warning");
    // Every SERVED MEMBER_WEIGHT key outside the two sets above is a member. The carve-out is
    // load-bearing for exactly one id: DB_SMH holds a dead weight row (danger-ladder.ts — never
    // looked up since D-D) but its live seat is the EW floor, so early-warning wins.
    const memberIds = Object.keys(MEMBER_WEIGHT).filter(
      (id) => meta.has(id) && !CHART_ONLY_IDS.includes(id) && !ewIds.includes(id),
    );
    expect(memberIds.length).toBeGreaterThan(0);
    expect(ewIds.filter((id) => id in MEMBER_WEIGHT)).toEqual(["DB_SMH"]); // the carve-out's population
    for (const id of memberIds) expect(meta.get(id)!.role, `${id} role`).toBe("member");
    // The fourth bucket is real: raw composite legs / pension / observability ids match no set.
    const contextIds = [...meta.values()].filter((m) => m.role === "context").map((m) => m.id);
    expect(contextIds).toContain("VIX"); // a raw VT leg — never weighted, never chart-only
    expect(contextIds).toContain("SPY"); // pension track — weighted in pension.ts, not the danger model
  });
});

// S-1: /indicators takes NO query param, so any param (`?cb=`) is a 400 no-store BEFORE the
// vintage DB read — closing the caller-selectable cache key that guaranteed a MISS with work.
describe("GET /api/indicators - unknown-param rejection (S-1 cache-key canonicalisation)", () => {
  test("an unknown param is a 400 no-store", async () => {
    const res = await handle(() => store, new Request("https://x/api/indicators?cb=1"));
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});


describe("GET /api/indicators - companionAnchorDate rides the payload (P4)", () => {
  const seed = (id: string, startUtc: number, n: number, runAt: string) =>
    store.recordReadings(
      Array.from({ length: n }, (_, i) => ({
        date: new Date(startUtc + i * 86_400_000).toISOString().slice(0, 10),
        indicatorId: id,
        value: i, // ascending, so oldest->newest ordering is checkable and values are distinct
        delta20: 0,
        rawState: "GREEN" as const,
        state: "GREEN" as const,
      })),
      runAt,
    );

  test("companionAnchorDate is the companion anchor: present iff history reaches the horizon", async () => {
    await seed("F1", Date.UTC(2014, 10, 20), 35, "2026-09-07T00:00:00Z"); // last obs 2014-12-24 <= horizon
    await seed("F2", Date.UTC(2020, 0, 1), 32, "2026-09-07T00:00:00Z"); // wholly post-horizon
    const meta = await metaById();
    const f1 = meta.get("F1")!.companionAnchorDate!;
    expect(f1 <= STORED_COMPANION_HORIZON).toBe(true); // it anchors the eligibility test
    expect(f1).toBe("2014-12-24"); // newest obs <= horizon (the anchor), not the earliest 2014-11-20
    expect(meta.get("F2")!.companionAnchorDate).toBeUndefined(); // no obs <= horizon => ineligible => absent
  });

  test("an id the store holds no rows for omits companionAnchorDate (absent, never empty)", async () => {
    await seed("F1", Date.UTC(2014, 10, 20), 5, "2026-09-07T00:00:00Z");
    const f13 = (await metaById()).get("F13")!; // never seeded
    expect(f13.companionAnchorDate).toBeUndefined();
  });
});

describe("GET /api/indicators - a failed store read degrades the route, warned", () => {
  test("200, and the warn names F7", async () => {
    const failing = Object.assign(new InMemoryStore(), { getSeries: () => Promise.reject(new Error("db down")) });
    const warned: unknown[][] = [];
    const res = await handle(() => failing, undefined, { warn: (...args) => void warned.push(args) });
    expect(res.status).toBe(200);
    expect(warned.map((c) => String(c[0]))).toContain("[indicators] F7 read failed - serving no CAPE bands:"); // the fake's bulk read rides getSeries too
  });

  test("a failed companion-anchor bulk read serves 200 with no anchors, and warns", async () => {
    const failing = Object.assign(new InMemoryStore(), { getSeriesBulk: () => Promise.reject(new Error("db down")) });
    const warned: unknown[][] = [];
    const res = await handle(() => failing, undefined, { warn: (...args) => void warned.push(args) });
    expect(res.status).toBe(200);
    expect(warned.map((c) => String(c[0]))).toEqual(["[indicators] companion-anchor bulk read failed - serving no companionAnchorDate:"]);
  });
});
