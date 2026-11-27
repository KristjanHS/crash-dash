/**
 * Stage 0.2 golden pins.
 *
 * Recomputes readings + chart specs from the committed fixture through the SAME dispatch
 * module the regen script uses (`src/goldens/dispatch.ts` — script and test cannot
 * diverge) and strict-deep-equals against the committed JSON. NEVER vitest snapshot
 * APIs / `-u` (§8): rebaseline = `npm run golden:regen` + commit the diff.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  FIXTURE_PATH,
  READINGS_PATH,
  CHARTS_PATH,
  computeReadings,
  computeCharts,
  enumeratedReadingIds,
  enumeratedChartIds,
  stringifySorted,
} from "./goldens/dispatch.js";
import type { Observation } from "./domain-types.js";

/** Round-trip through the regen serializer so undefined-dropping + key order match the
 *  committed files exactly (toStrictEqual distinguishes `{a: undefined}` from `{}`). */
function serialized(v: unknown): unknown {
  return JSON.parse(stringifySorted(v)) as unknown;
}

// Lazy: each describe warms its data in `beforeAll`.
const memo = <T>(f: () => T): (() => T) => {
  let v: T | undefined;
  return () => (v ??= f());
};
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
const committedReadings = memo(() => readJson(READINGS_PATH));
const committedCharts = memo(() => readJson(CHARTS_PATH));
const liveReadings = memo(() => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, Observation[]>;
  return serialized(computeReadings(fixture)) as Record<string, unknown>;
});
const liveCharts = memo(() => serialized(computeCharts()) as Record<string, unknown>);

describe("golden pins: key-set coverage (registry-derived, never hardcoded)", () => {
  beforeAll(() => void [committedReadings(), committedCharts()]);

  it("golden-readings.json keys strict-equal ALL_INDICATORS ∪ CMP_* component ids", () => {
    expect(Object.keys(committedReadings()).sort()).toStrictEqual(enumeratedReadingIds());
  });

  it("golden-charts.json keys strict-equal the ALL_INDICATORS id set", () => {
    expect(Object.keys(committedCharts()).sort()).toStrictEqual(enumeratedChartIds());
  });
});

/** The first differing path between two JSON values (depth-first, key-sorted), as `path: expected vs actual`. */
function firstDiff(expected: unknown, actual: unknown, path = ""): string {
  if (isDeepStrictEqual(expected, actual)) return "";
  const bothObjects = typeof expected === "object" && expected !== null && typeof actual === "object" && actual !== null;
  if (bothObjects && Array.isArray(expected) === Array.isArray(actual)) {
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    for (const k of [...new Set([...Object.keys(e), ...Object.keys(a)])].sort()) {
      const d = firstDiff(e[k], a[k], `${path}.${k}`);
      if (d) return d;
    }
  }
  return `${path || "(root)"}: ${JSON.stringify(expected)} vs ${JSON.stringify(actual)}`;
}

/** One message per diverging id (its first diff), so a red names EVERY failing id, not just the first. */
function goldenViolations(ids: readonly string[], committed: Record<string, unknown>, live: Record<string, unknown>): string[] {
  return ids.flatMap((id) => {
    const d = firstDiff(committed[id], live[id]);
    return d ? [`${id} ${d}`] : [];
  });
}

describe("golden pins: per-id rows (collecting — a red lists each diverging id's first diff, expected vs actual)", () => {
  it("reading rows for every enumerated id match the committed golden", () => {
    expect(goldenViolations(enumeratedReadingIds(), committedReadings(), liveReadings())).toEqual([]);
  });

  it("chart specs for every enumerated id match the committed golden", () => {
    expect(goldenViolations(enumeratedChartIds(), committedCharts(), liveCharts())).toEqual([]);
  });

  it("firstDiff CAN fail: names the first diverging path, and a missing id", () => {
    expect(goldenViolations(["A", "B", "C"], { A: { x: [1, 2] }, B: 1, C: { y: 1 } }, { A: { x: [1, 3] }, B: 1 })).toEqual([
      "A .x.1: 2 vs 3",
      "C (root): {\"y\":1} vs undefined",
    ]);
  });
});
