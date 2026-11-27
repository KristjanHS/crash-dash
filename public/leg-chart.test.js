// Stage 1.2 seam tests for public/leg-chart.js — plain `.js` so vitest collects it and tsc skips it
// (frontend.md). No jsdom: the module is DOM-free and storage is passed in as a fake.
//
// The TS import uses an EXTENSIONLESS specifier (`../src/scoreboard`), not `.js` — the inverse of
// the repo's TS convention, because vite resolves a `.js` test's specifier literally and `.ts` there
// would report `no tests` (frontend.md §A `public/*.test.js` importing a TS module).
import { describe, it, expect } from "vitest";
import {
  LEG_CHART_ID,
  LEG_CHART_POSITIONS,
  LEG_CHART_POS_KEY,
  placeLegChart,
  readLegChartPos,
  writeLegChartPos,
} from "./leg-chart.js";
import { TOP_N, OFF_LADDER_LEGS } from "./leg-top.js";
import { legCloseId, offLadderLegCloseId } from "../src/scoreboard";
import { LADDER } from "../src/families";
import { ALL_INDICATORS } from "../src/registry";

describe("LEG_CHART_ID maps LADDER ∪ OFF_LADDER_LEGS to registered indicator chart ids", () => {
  const ALL_KEYS = [...LADDER, ...OFF_LADDER_LEGS];
  // Value charts the raw XDEV row, never LEGP_VALUE; every other leg its TS close id.
  const expectedId = (key) =>
    key === "Value" ? "XDEV" : LADDER.includes(key) ? legCloseId(key) : offLadderLegCloseId(key);

  it("maps each leg to its TS close id, Value to XDEV", () => {
    expect(LADDER).toContain("Value"); // premise: the Value exception is reachable
    for (const key of ALL_KEYS) expect(LEG_CHART_ID[key], key).toBe(expectedId(key));
  });

  it("every value is a registered indicator id (the leg slot fetches it as a member chart)", () => {
    const registered = new Set(ALL_INDICATORS.map((i) => i.id));
    for (const [key, id] of Object.entries(LEG_CHART_ID)) expect(registered.has(id), `${key} → ${id}`).toBe(true);
  });

  it("has exactly the LADDER ∪ OFF_LADDER_LEGS key set — both directions, no extra and no missing leg", () => {
    const mapKeys = Object.keys(LEG_CHART_ID).sort();
    expect(mapKeys).toEqual([...ALL_KEYS].sort());
    // Direction 2 made explicit (guards a stray key that a set-equality on sorted arrays already
    // catches, but this reds with a clearer message on either drift):
    for (const key of ALL_KEYS) expect(key in LEG_CHART_ID).toBe(true);
    for (const key of Object.keys(LEG_CHART_ID)) expect(ALL_KEYS).toContain(key);
  });
});

describe("LEG_CHART_POSITIONS is [1 .. TOP_N + 1]", () => {
  it("is derived from TOP_N, not a literal", () => {
    expect(LEG_CHART_POSITIONS).toEqual(
      Array.from({ length: TOP_N + 1 }, (_, i) => i + 1),
    );
    // Anchor the count so a TOP_N change is visible here too (TOP_N is currently 10 ⇒ 11 positions).
    expect(LEG_CHART_POSITIONS.length).toBe(TOP_N + 1);
  });
});

describe("placeLegChart inserts the leg slot at the resolved position", () => {
  const ids = ["a", "b", "c"]; // ids.length + 1 = 4 slots

  it("puts the leg at a valid 1-based position, members in order elsewhere", () => {
    expect(placeLegChart(ids, 1)).toEqual([
      { kind: "leg" },
      { kind: "indicator", id: "a" },
      { kind: "indicator", id: "b" },
      { kind: "indicator", id: "c" },
    ]);
    expect(placeLegChart(ids, 3)).toEqual([
      { kind: "indicator", id: "a" },
      { kind: "indicator", id: "b" },
      { kind: "leg" },
      { kind: "indicator", id: "c" },
    ]);
  });

  it("places the leg last at the max position (ids.length + 1)", () => {
    expect(placeLegChart(ids, 4)).toEqual([
      { kind: "indicator", id: "a" },
      { kind: "indicator", id: "b" },
      { kind: "indicator", id: "c" },
      { kind: "leg" },
    ]);
  });

  it("always returns ids.length + 1 slots with exactly one leg", () => {
    for (const pos of [-5, 0, 1, 2, 3, 4, 99]) {
      const slots = placeLegChart(ids, pos);
      expect(slots.length).toBe(ids.length + 1);
      expect(slots.filter((s) => s.kind === "leg").length).toBe(1);
      expect(slots.filter((s) => s.kind === "indicator").map((s) => s.id)).toEqual(ids);
    }
  });

  it("clamps out-of-range positions to the ends", () => {
    expect(placeLegChart(ids, 0)[0]).toEqual({ kind: "leg" }); // below ⇒ first
    expect(placeLegChart(ids, -3)[0]).toEqual({ kind: "leg" });
    expect(placeLegChart(ids, 99).at(-1)).toEqual({ kind: "leg" }); // above ⇒ last
  });

  it("falls back to position 1 for a non-integer, NaN, null or undefined pos", () => {
    for (const bad of [2.5, NaN, null, undefined, "2", {}]) {
      expect(placeLegChart(ids, bad)[0]).toEqual({ kind: "leg" });
    }
  });
});

/** A Storage-like fake over a plain object; `blocked` makes every access throw (private mode). */
function fakeStorage(initial = {}, { blocked = false } = {}) {
  const map = { ...initial };
  return {
    getItem(k) {
      if (blocked) throw new Error("storage blocked");
      return k in map ? map[k] : null;
    },
    setItem(k, v) {
      if (blocked) throw new Error("storage blocked");
      map[k] = String(v);
    },
    _map: map,
  };
}

describe("readLegChartPos / writeLegChartPos round-trip through passed-in storage", () => {
  it("reads back a written valid position under the exported key", () => {
    const s = fakeStorage();
    writeLegChartPos(s, 5);
    expect(s._map[LEG_CHART_POS_KEY]).toBe("5");
    expect(readLegChartPos(s)).toBe(5);
  });

  it("defaults to 1 when the key is absent", () => {
    expect(readLegChartPos(fakeStorage())).toBe(1);
  });

  it("defaults to 1 for an out-of-range or non-numeric stored value", () => {
    expect(readLegChartPos(fakeStorage({ [LEG_CHART_POS_KEY]: "0" }))).toBe(1);
    expect(readLegChartPos(fakeStorage({ [LEG_CHART_POS_KEY]: String(TOP_N + 2) }))).toBe(1);
    expect(readLegChartPos(fakeStorage({ [LEG_CHART_POS_KEY]: "abc" }))).toBe(1);
    expect(readLegChartPos(fakeStorage({ [LEG_CHART_POS_KEY]: "" }))).toBe(1);
  });

  it("defaults to 1 when storage access throws (blocked)", () => {
    expect(readLegChartPos(fakeStorage({}, { blocked: true }))).toBe(1);
  });

  it("ignores an invalid n on write (no throw, nothing stored)", () => {
    const s = fakeStorage();
    for (const bad of [0, TOP_N + 2, 2.5, NaN, null, undefined, "3"]) {
      writeLegChartPos(s, bad);
    }
    expect(LEG_CHART_POS_KEY in s._map).toBe(false);
  });

  it("swallows a throw from a blocked storage on write", () => {
    expect(() => writeLegChartPos(fakeStorage({}, { blocked: true }), 4)).not.toThrow();
  });
});
