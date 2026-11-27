/**
 * Direct unit tests for `computeLegAttribution` (src/lab-attribution.ts) — plain
 * InMemoryStore inputs, no mocks. Handler wiring pins stay in api/lab.test.ts.
 */
import { describe, expect, test } from "vitest";

import { computeLegAttribution } from "./lab-attribution.js";
import { dualAxisFiringIds } from "./lab-served-field.js";
import { InMemoryStore } from "./store-memory.js";
import type { StoredReading } from "./store.js";
import type { State } from "./domain-types.js";
import { ALL_INDICATORS } from "./registry.js";
import { confirmClosesFor } from "./families.js";

const TAIL = "2026-06-25";
const FIRED_AT = `${TAIL}T21:00:00.000Z`;
const RUN_AT = "2026-06-24T21:00:00.000Z";

const dayStrings = (end: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.parse(end) - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );

const row = (indicatorId: string, date: string, value: number, state: State = "RED"): StoredReading => ({
  date, indicatorId, value, delta20: 0, rawState: state, state,
});

const reading = (id: string, state: State, date = TAIL): { id: string; state: State; date: string } =>
  ({ id, state, date });

// Cuts READ from the registry, never re-typed — a retune carries every fixture along.
const F10_CUTS = ALL_INDICATORS.find((i) => i.id === "F10")!.thresholds;
const F1_CUTS = ALL_INDICATORS.find((i) => i.id === "F1")!.thresholds;
const F1_FLAT = F1_CUTS.amberLevel! - 1;
// Clears F1's Red level AND (off the flat base) Red velocity cut, so the option-D AND fires both legs.
const F1_RED_HEAD = Math.max(F1_CUTS.redLevel!, F1_FLAT + F1_CUTS.redVelocity!) * 1.01;

/** 30 F10 closes flat above its Red level cut, ending on TAIL ⇒ stable confirmed RED via `op`. */
async function seedF10Red(store: InMemoryStore): Promise<void> {
  await store.recordReadings(
    dayStrings(TAIL, 30).map((d) => row("F10", d, F10_CUTS.redLevel! * 1.05)),
    RUN_AT,
  );
}

describe("computeLegAttribution", () => {
  test("no dual-axis firing id (GREEN, or velocity-only like R2) → empty, not degraded", async () => {
    const store = new InMemoryStore();
    const out = await computeLegAttribution(store, [reading("F1", "GREEN"), reading("R2", "RED")], FIRED_AT);
    expect(out).toEqual({ attribution: [], degraded: false });
  });

  test("declines `no-history` on an empty store - a legit decline never sets degraded", async () => {
    const out = await computeLegAttribution(new InMemoryStore(), [reading("F10", "RED")], FIRED_AT);
    expect(out).toEqual({ attribution: [{ id: "F10", declined: "no-history" }], degraded: false });
  });

  test("SPEAKS level: flat above F10's registry Red cut attributes the `op` leg", async () => {
    const store = new InMemoryStore();
    await seedF10Red(store);
    const out = await computeLegAttribution(store, [reading("F10", "RED")], FIRED_AT);
    expect(out).toEqual({ attribution: [{ id: "F10", leg: "op", axis: "level" }], degraded: false });
  });

  test("SPEAKS velocity: F1's Red AND fires both own legs as the `op+vel-op` composite", async () => {
    const store = new InMemoryStore();
    const dates = dayStrings(TAIL, 60);
    await store.recordReadings(
      dates.map((d, i) => row("F1", d, i === dates.length - 1 ? F1_RED_HEAD : F1_FLAT)),
      RUN_AT,
    );
    const out = await computeLegAttribution(store, [reading("F1", "RED")], FIRED_AT);
    expect(out).toEqual({ attribution: [{ id: "F1", leg: "op+vel-op", axis: "velocity" }], degraded: false });
  });

  test("declines `recompute-disagreed` when the row's date is off the series tail, or its state differs", async () => {
    const store = new InMemoryStore();
    await seedF10Red(store);
    const disagreed = { attribution: [{ id: "F10", declined: "recompute-disagreed" }], degraded: false };
    expect(await computeLegAttribution(store, [reading("F10", "RED", "2026-06-26")], FIRED_AT)).toEqual(disagreed);
    expect(await computeLegAttribution(store, [reading("F10", "AMBER", TAIL)], FIRED_AT)).toEqual(disagreed);
  });

  test("declines `mid-confirm` carrying the id's own fold depth when raw recovers on the tail", async () => {
    const store = new InMemoryStore();
    // 29 Red closes then a tail recovery under amber: raw GREEN, confirmed still RED (directional fold).
    await store.recordReadings(
      dayStrings(TAIL, 30).map((d, i) =>
        i === 29
          ? { ...row("F10", d, F10_CUTS.amberLevel! * 0.5, "RED"), rawState: "GREEN" as State }
          : row("F10", d, F10_CUTS.redLevel! * 1.05),
      ),
      RUN_AT,
    );
    const out = await computeLegAttribution(store, [reading("F10", "RED")], FIRED_AT);
    expect(out).toEqual({
      attribution: [{ id: "F10", declined: "mid-confirm", confirmCloses: confirmClosesFor("F10") }],
      degraded: false,
    });
  });

  test("a getCalibration REJECTION flags degraded but still attributes off registry cuts", async () => {
    const store = new InMemoryStore();
    await seedF10Red(store);
    store.getCalibration = () => Promise.reject(new Error("store down"));
    const out = await computeLegAttribution(store, [reading("F10", "RED")], FIRED_AT);
    expect(out).toEqual({ attribution: [{ id: "F10", leg: "op", axis: "level" }], degraded: true });
  });

  test("a synth-history store REJECTION flags degraded (the loader no longer swallows it into priors)", async () => {
    const store = new InMemoryStore();
    store.getSeriesBulk = () => Promise.reject(new Error("store down"));
    const warns: unknown[] = [];
    // Own vintage key: the per-vintage "synth" memo is module state shared across files.
    const out = await computeLegAttribution(store, [reading("F3", "RED")], `${TAIL}T21:07:00.000Z`, (m) => warns.push(m));
    expect(out).toEqual({ attribution: [{ id: "F3", declined: "no-history" }], degraded: true });
    expect(warns).toEqual([expect.stringContaining("F3")]);
  });

  test("a per-id getSeries REJECTION degrades that id to `recompute-disagreed`", async () => {
    const store = new InMemoryStore();
    store.getSeries = () => Promise.reject(new Error("store down"));
    const out = await computeLegAttribution(store, [reading("F10", "RED")], FIRED_AT);
    expect(out).toEqual({ attribution: [{ id: "F10", declined: "recompute-disagreed" }], degraded: true });
  });
});

/** `dualAxisFiringIds` is the SINGLE gate on which ids may be attributed; nothing downstream
 *  re-filters, so the velocity-ONLY tautology exclusion is proven here or nowhere. */
describe("dualAxisFiringIds", () => {
  test("R2/R3/R4 are NEVER attributable, even firing RED - they are velocity-ONLY", () => {
    const firing = ["R2", "R3", "R4"].map((id) => ({ id, state: "RED" as State }));
    expect(dualAxisFiringIds(firing)).toEqual([]);
    expect(dualAxisFiringIds([...firing, { id: "F1", state: "RED" as State }])).toEqual(["F1"]);
  });

  test("returns the dual-axis ids that are confirmed non-GREEN", () => {
    // F10 is ABSENT from `CALIB_MAP`, so a calibration edit cannot strip its level axis and
    // make the AMBER arm vacuous (F9 and F11 each left `DUAL_AXIS_IDS` that way).
    expect(
      dualAxisFiringIds([
        { id: "F1", state: "RED" },
        { id: "F10", state: "AMBER" },
        { id: "F2", state: "GREEN" },
      ]),
    ).toEqual(["F1", "F10"]);
  });

  test("non-dual-axis ids (level-only / off-ladder) are excluded too", () => {
    expect(dualAxisFiringIds([{ id: "R1", state: "RED" }, { id: "VT", state: "RED" }])).toEqual([]);
  });
});
