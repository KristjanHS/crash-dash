import { describe, expect, it } from "vitest";
import type { CellState, SignalCell } from "./danger-cell.js";
import type { Sev } from "./danger-engine.js";
import { SEV_CUTS } from "./danger-engine.js";
import { LEG_FIELD, type LegField, type SignalKey } from "./danger-ladder.js";
import { LADDER } from "./families.js";
import {
  computeLegGrowth,
  type Growth,
  growthRsId,
  growthRsReadingRows,
} from "./growth.js";
import type { Sleeve } from "./y1.js";

describe("growthRsReadingRows - GRS_* rows from a per-leg RS map", () => {
  it("emits no row for a null RS (never a 0 row) and length equals the non-null count", () => {
    const rs = new Map<Sleeve, number | null>();
    let expectedNonNull = 0;
    // Deterministically null out every third sleeve; the rest get finite RS (including 0, a legal RS).
    LADDER.forEach((sleeve, i) => {
      if (i % 3 === 0) {
        rs.set(sleeve, null);
      } else {
        rs.set(sleeve, i - 4); // spread across negative/zero/positive
        expectedNonNull += 1;
      }
    });

    const rows = growthRsReadingRows(rs, "2026-07-20");
    const ids = rows.map((r) => r.indicatorId);

    // Every null-RS leg's id is ABSENT (a .length check alone can't tell a skipped null from a
    // skipped finite value — this omission assertion is what goes red if null is read as 0).
    const nulled = LADDER.filter((_, i) => i % 3 === 0);
    expect(nulled.length).toBeGreaterThan(0);
    for (const sleeve of nulled) expect(ids).not.toContain(growthRsId(sleeve));
    expect(rows.length).toBe(expectedNonNull);
  });

  it("keeps a leg whose RS is exactly 0 (0 is a legal RS, not a missing one)", () => {
    const rs = new Map<Sleeve, number | null>(LADDER.map((s) => [s, null]));
    const zeroLeg = LADDER[0];
    rs.set(zeroLeg, 0);

    const rows = growthRsReadingRows(rs, "2026-07-20");
    expect(rows.map((r) => r.indicatorId)).toEqual([growthRsId(zeroLeg)]);
    expect(rows[0]?.value).toBe(0);
  });

  it("assigns exactly GRS_<LEG_SLUG[sleeve]> ids, derived from LADDER not hand-typed", () => {
    const rs = new Map<Sleeve, number | null>(LADDER.map((s, i) => [s, i + 1]));
    const rows = growthRsReadingRows(rs, "2026-07-20");
    // Derive the expectation from the source map, per .claude/rules/testing-project.md.
    expect(rows.map((r) => r.indicatorId)).toEqual(LADDER.map((s) => growthRsId(s)));
    for (const row of rows) {
      // Display-only navReadingRow shape.
      expect(row.date).toBe("2026-07-20");
      expect(row.delta20).toBe(0);
      expect(row.state).toBe("GREEN");
      expect(row.decision).toBeNull();
    }
  });

  it("drops non-finite RS (NaN/Infinity) exactly like null", () => {
    const rs = new Map<Sleeve, number | null>(LADDER.map((s) => [s, 1]));
    rs.set(LADDER[0], NaN);
    rs.set(LADDER[1], Infinity);
    const rows = growthRsReadingRows(rs, "2026-07-20");
    expect(rows.map((r) => r.indicatorId)).not.toContain(growthRsId(LADDER[0]));
    expect(rows.map((r) => r.indicatorId)).not.toContain(growthRsId(LADDER[1]));
    expect(rows.length).toBe(LADDER.length - 2);
  });
});

// ─── G1 — computeLegGrowth: brand + three-term weighted MEAN ─────────────────────────

// A leg the uT trend term is live on (uT members reach Semis/S&P IT/EM/Value/S&P 500/ex-US).
const SEMIS: LegField = LEG_FIELD.find((l) => l.sleeve === "Semis")!;

/** Minimal SignalCell builder — only `family`/`wsev` matter to the growth fold; the rest is shape. */
function cell(family: SignalKey, wsev: number | null): SignalCell {
  return {
    family,
    cellState: (wsev === null ? "na" : wsev === 0 ? "calm" : "lit") as CellState,
    M: 0,
    N: wsev === null ? 0 : 1,
    wsev,
    // OQ-5 Stage 5.2 census: shape only — the growth fold reads `family`/`wsev` and never
    // `observed`. A measured cell mirrors N (one observed member); an `na` cell has no members.
    observed: { fresh: wsev === null ? 0 : 1, lag: 0, absent: 0, deepLag: 0 },
    // B2 hold-window provenance: shape only — the growth fold never reads it.
    held: null,
  };
}

describe("computeLegGrowth - three-term weighted MEAN", () => {
  it("null RS + null mom + a live uT cell ⇒ trend term ALONE (never imputed to 0.5)", () => {
    const wsev = 0.4;
    const { value, live } = computeLegGrowth([cell("uT", wsev)], SEMIS, null, null);
    expect(live).toBe(true);
    // Trend alone: (1 − wsev). A mean with an imputed 0.5 RS/mom would diverge from this.
    expect(value).toBeCloseTo(1 - wsev, 12);
  });

  it("is a MEAN: one hot + one calm term land STRICTLY between them (worst-of hits an endpoint)", () => {
    const hot = 1 - 0.9; // trend term = 0.10
    const strong = 1.0; // RS z = +3 → winsorize 1.0
    const { value } = computeLegGrowth([cell("uT", 0.9)], SEMIS, +3, null);
    expect(value).toBeGreaterThan(Math.min(hot, strong));
    expect(value).toBeLessThan(Math.max(hot, strong));
  });

  it.each([
    ["RS", (z: number) => computeLegGrowth([], SEMIS, z, null)],
    ["mom", (z: number) => computeLegGrowth([], SEMIS, null, z)],
  ] as const)("winsorize pins for %s: +3 → 1.0, −3 → 0.0, 0 → 0.5 (that term alone, no trend cell)", (_, g) => {
    expect(g(+3).value).toBeCloseTo(1.0, 12);
    expect(g(-3).value).toBeCloseTo(0.0, 12);
    expect(g(0).value).toBeCloseTo(0.5, 12);
  });

  it("zero surviving terms ⇒ { value: 0, live: false } (both no-term and na-cell forms)", () => {
    expect(computeLegGrowth([], SEMIS, null, null)).toEqual({ value: 0, live: false, rsMomLive: false });
    // An na trend cell (wsev null) contributes nothing — still zero live terms.
    expect(computeLegGrowth([cell("uT", null)], SEMIS, null, null)).toEqual({
      value: 0,
      live: false,
      rsMomLive: false,
    });
  });

  // These pin the two flags APART — the discriminating regime is the trend-only fold.
  describe("rsMomLive - the cross-sectional liveness predicate, strictly narrower than `live`", () => {
    it("THE DIVERGENCE WITNESS: a trend-only fold is `live` but NOT `rsMomLive`", () => {
      const g = computeLegGrowth([cell("uT", 0.4)], SEMIS, null, null);
      expect(g.live).toBe(true); // …so reading `live` as the gate would admit this leg
      expect(g.rsMomLive).toBe(false);
    });

    it("either cross-sectional term alone sets it; both null never does, whatever the trend cell", () => {
      expect(computeLegGrowth([], SEMIS, 0, null).rsMomLive).toBe(true); // rs alone
      expect(computeLegGrowth([], SEMIS, null, 0).rsMomLive).toBe(true); // mom alone
      expect(computeLegGrowth([cell("uT", 0.4)], SEMIS, +1, -1).rsMomLive).toBe(true); // both
      expect(computeLegGrowth([cell("uT", null)], SEMIS, null, null).rsMomLive).toBe(false);
    });

    it("it is NOT an inference from `value`: a zero-valued rs read is still a real read", () => {
      // rs = −3 ⇒ winsorZ 0 ⇒ value 0, indistinguishable BY VALUE from the no-term case above.
      const g = computeLegGrowth([], SEMIS, -3, null);
      expect(g.value).toBeCloseTo(0, 12);
      expect(g.rsMomLive).toBe(true);
    });
  });

  it("type-level: the Growth brand isolates it from Sev (the phantom tag's whole job)", () => {
    // A Sev must NOT satisfy a Growth-typed slot. This is the red-DEMOABLE direction: delete
    // `& { __scale: "growth" }` from the Growth alias and Growth becomes plain `number`, which a
    // branded Sev IS assignable to — the @ts-expect-error then goes UNUSED and tsc fails. (The
    // reverse `scaledSevBand(growth)` form is vacuous w.r.t. this brand: `Sev` rejects a plain
    // `number` too, so removing the Growth brand can't flip it.)
    const s: Sev = SEV_CUTS.amber;
    // @ts-expect-error — a Sev (__scale "sev") must not satisfy a Growth (__scale "growth")
    const g: Growth = s;
    expect(typeof g).toBe("number");
  });
});
