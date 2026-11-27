import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildScoringConstants } from "./emit-scoring-constants.js";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "data");

// The LAST non-circular TS-side pin of `expandingZ` — do not "collapse" it into a read of
// `fixtures.expandingZ`. Post-Stage-4.1, `expanding-z.test.ts` reads that fixture, but the
// fixture is emitted FROM the same `expandingZ`, so its assertion cannot fail on a formula
// change (it says so itself, and pins the wiring instead). These literals are the
// Python-validated golden (validated against the harness's hand-computed values before the
// Python suite was deleted 2026-08-15), kept by hand: reading them from the fixture would make
// this `expect(fixture).toEqual(fixture)` and leave the TS port unpinned.
const GOLDEN: (number | null)[] = [
  null, null, -0.353553390593, -1.761409691856, 7.7, -1.644711568067, 7.839720783242, -0.106739169002,
  -0.276094327861, 1.790409231821, 5.8744312214, -0.886980796688, -0.738078839546, -0.870509832562, 0.153950489008,
];

describe("emit-scoring-constants (D0 Stage 2.2)", () => {
  // Seam S2 — the "did you re-run the emitter?" guard: the committed JSON must equal a
  // fresh in-process build, so an edited src/ constant with a stale JSON fails here.
  it("committed scoring_constants.json deep-equals a fresh buildScoringConstants()", () => {
    const committed = JSON.parse(readFileSync(join(DATA_DIR, "scoring_constants.json"), "utf8"));
    expect(committed).toEqual(buildScoringConstants());
  });

  // Seam S2 — the standing correctness pin: the emitted expandingZ fixture must equal the
  // Python-validated GOLDEN within 1e-9. Every other TS assertion on expandingZ now reads
  // that fixture, so this is the only TS test a formula regression can redden (the Python
  // parity test would catch it too, from the other side of the port).
  it("emitted expandingZ fixture matches the Python-validated GOLDEN (1e-9)", () => {
    const { input, expected } = buildScoringConstants().fixtures.expandingZ;
    // input must still be the same numbers the GOLDEN was produced from
    expect(input).toEqual([2.34, 2.3, 2.31, 2.28, 2.5, 2.2, 3.1, 2.4, 2.35, 2.9, 4.2, 2.1, 2.15, 2.05, 2.6]);
    expect(expected).toHaveLength(GOLDEN.length);
    const warmup = GOLDEN.flatMap((g, i) => (g === null ? [i] : []));
    const scored = GOLDEN.flatMap((g, i) => (g === null ? [] : [[i, g] as const]));
    expect(warmup.length).toBeGreaterThan(0);
    expect(scored.length).toBeGreaterThan(0);
    for (const i of warmup) expect(expected[i], `index ${i} should be null (warmup)`).toBeNull();
    for (const [i, g] of scored) {
      expect(expected[i], `index ${i} should be non-null`).not.toBeNull();
      expect(expected[i]!, `index ${i}`).toBeCloseTo(g, 9);
    }
  });
});
