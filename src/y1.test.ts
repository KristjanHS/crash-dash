import { describe, expect, it } from "vitest";
import { LADDER } from "./families.js";
import { R1_FLOOR_RUNG } from "./r1.js";
import type { SeriesPoint } from "./store.js";
import {
  computeLegRs,
  computeVolAdjMom,
  computeY1,
  VAM_MIN_OBS,
  Y1_LOOKBACKS,
  Y1_MARGIN,
  Y1_MAX_SPAN_DAYS,
  Y1_MIN_OBS,
  Y1_PERSIST,
  Y1_REACH,
  type Sleeve,
} from "./y1.js";

const MS_PER_DAY = 86_400_000;
const BASE = Date.UTC(2024, 0, 1);

const isoDay = (offset: number): string =>
  new Date(BASE + offset * MS_PER_DAY).toISOString().slice(0, 10);

const range = (n: number): number[] => [...Array(n).keys()];

/** A leg's closes on the given day offsets: an exponential drift plus a 1% alternating wiggle, so
 *  every leg has a non-zero daily vol and the drifts differ across legs (a degenerate cross-section
 *  would drop every lookback, which is a different code path). */
function legSeries(offsets: number[], driftPerDay: number): SeriesPoint[] {
  return offsets.map((o, k) => ({
    date: isoDay(o),
    value: 100 * Math.exp(driftPerDay * k) * (1 + 0.01 * (k % 2)),
    delta20: 0,
    rawState: "GREEN" as const,
    state: "GREEN" as const,
  }));
}

/** Nine legs on a shared offset axis unless `overrides` moves one. */
function buildLegs(
  offsets: number[],
  overrides: Partial<Record<Sleeve, number[]>> = {},
): Map<Sleeve, SeriesPoint[]> {
  const m = new Map<Sleeve, SeriesPoint[]>();
  LADDER.forEach((sleeve, i) => {
    m.set(sleeve, legSeries(overrides[sleeve] ?? offsets, (i + 1) * 0.0002));
  });
  return m;
}

/** An RS map with the named sleeves set and every other sleeve null. */
function rsMap(entries: Partial<Record<Sleeve, number>>): Map<Sleeve, number | null> {
  const m = new Map<Sleeve, number | null>();
  for (const sleeve of LADDER) m.set(sleeve, entries[sleeve] ?? null);
  return m;
}

const EM = LADDER[2] as Sleeve; // rung 3
const VALUE = LADDER[3] as Sleeve; // rung 4
const EXUS = LADDER[5] as Sleeve; // rung 6
const SEMIS = LADDER[0] as Sleeve; // rung 1
const STAPLES = LADDER[8] as Sleeve; // rung 9

describe("computeLegRs - observation floor (Y1_MIN_OBS)", () => {
  it("252 observations ⇒ null RS, 253 ⇒ a number", () => {
    const short = computeLegRs(buildLegs(range(Y1_MIN_OBS - 1))).rs;
    for (const sleeve of LADDER) expect(short.get(sleeve)).toBeNull();

    const full = computeLegRs(buildLegs(range(Y1_MIN_OBS))).rs;
    for (const sleeve of LADDER) expect(typeof full.get(sleeve)).toBe("number");
  });
});

describe("computeLegRs - lookback ensemble (Y1_LOOKBACKS)", () => {
  it("dropping one lookback's data still produces an RS from the surviving two, and SAYS so", () => {
    // Baseline: a full axis runs all three lookbacks. Without this the assertion below cannot tell
    // "two survived" from "the count is always 2".
    expect(computeLegRs(buildLegs(range(260))).lookbacksUsed).toBe(3);

    // Every leg is individually eligible (260 closes), but one leg's dates are shifted 60 days, so
    // the INTERSECTED axis is only 200 dates — enough for 63 and 126, not for 252.
    const legs = buildLegs(range(260), { [STAPLES]: range(260).map((o) => o + 60) });
    const out = computeLegRs(legs);
    for (const sleeve of LADDER) expect(typeof out.rs.get(sleeve)).toBe("number");
    // The load-bearing half: the caller can SEE that only two lookbacks ran. A `typeof === "number"`
    // assertion alone passes identically on a silently single-lookback RS.
    expect(out.lookbacksUsed).toBe(2);
  });
});

describe("computeLegRs - cross-section floor (Y1_MIN_LEGS)", () => {
  it("fewer than Y1_MIN_LEGS legs with enough history ⇒ all-null", () => {
    const offsets = range(Y1_MIN_OBS);

    const two = buildLegs(offsets);
    for (const sleeve of LADDER.slice(2)) two.delete(sleeve);
    const rsTwo = computeLegRs(two).rs;
    // Dropped ⇒ null. A zero-fill would show up as 0 here, which is the bug this pins.
    for (const sleeve of LADDER) expect(rsTwo.get(sleeve)).toBeNull();

    const three = buildLegs(offsets);
    for (const sleeve of LADDER.slice(3)) three.delete(sleeve);
    const rsThree = computeLegRs(three).rs;
    for (const sleeve of LADDER.slice(0, 3)) expect(typeof rsThree.get(sleeve)).toBe("number");
  });

  it("a lookback only 2 legs can be scored on is dropped, while the other lookbacks still yield an RS", () => {
    // Reaches the PER-LOOKBACK drop (`scores.size < Y1_MIN_LEGS`), which the test above never
    // executes — it returns at the earlier `eligible.length` guard. All nine legs are eligible by
    // row count here; they simply cannot all be SCORED on the 63-day window, because seven of them
    // are perfectly FLAT across it (zero variance ⇒ `dailyVol` is 0 ⇒ the leg is skipped). The 126
    // and 252 windows reach back into the varying stretch, so all nine score there.
    const offsets = range(260);
    const flatFrom = 260 - (Math.min(...Y1_LOOKBACKS) + 1); // first index of the 63-lookback window
    const legs = new Map<Sleeve, SeriesPoint[]>();
    LADDER.forEach((sleeve, i) => {
      const movesLate = i < 2; // exactly 2 legs still move on the short window
      const drift = (i + 1) * 0.0002;
      legs.set(
        sleeve,
        offsets.map((o, k) => ({
          date: isoDay(o),
          value:
            k < flatFrom || movesLate
              ? 100 * Math.exp(drift * k) * (1 + 0.01 * (k % 2))
              : 100 * Math.exp(drift * flatFrom) * (1 + 0.01 * (flatFrom % 2)),
          delta20: 0,
          rawState: "GREEN" as const,
          state: "GREEN" as const,
        })),
      );
    });

    const out = computeLegRs(legs);
    // Exactly the 63-lookback was dropped — 2 < Y1_MIN_LEGS scorers — not the whole computation.
    expect(out.lookbacksUsed).toBe(Y1_LOOKBACKS.length - 1);
    for (const sleeve of LADDER) expect(typeof out.rs.get(sleeve)).toBe("number");
  });
});

describe("computeLegRs - axis lag gate (Y1_MAX_SPAN_DAYS)", () => {
  it("an axis spanning more than Y1_MAX_SPAN_DAYS degrades; at the bound it computes", () => {
    // 253 dates: 252 consecutive, then one final close pushed out so the span is exactly the bound.
    const atBound = [...range(Y1_MIN_OBS - 1), Y1_MAX_SPAN_DAYS];
    const ok = computeLegRs(buildLegs(atBound)).rs;
    for (const sleeve of LADDER) expect(typeof ok.get(sleeve)).toBe("number");

    const overBound = [...range(Y1_MIN_OBS - 1), Y1_MAX_SPAN_DAYS + 1];
    const stale = computeLegRs(buildLegs(overBound)).rs;
    for (const sleeve of LADDER) expect(stale.get(sleeve)).toBeNull();
  });

  it("a short axis is gated pro-rata - 64 dates over 500 days degrades", () => {
    // A near-dead feed: only 64 shared dates (just enough for the 63-lookback) smeared over 500
    // calendar days — ~8 days per "daily" close, so `dailyVol` would read 8-day moves as daily
    // returns. Under a FLAT 520-day bound this passes (500 <= 520) and Y1 paints a live pick with no
    // degrade marker; under the pro-rata bound (520 * 64 / 253 ≈ 131.5) it degrades.
    const n = Math.min(...Y1_LOOKBACKS) + 1;
    // Each leg must clear the Y1_MIN_OBS ROW floor, or the early `eligible.length` guard fires and
    // the span gate is never reached (which would make this test pass for the wrong reason). So each
    // leg gets `Y1_MIN_OBS` rows: the `shared` dates plus PRIVATE dates no other leg has, which pad
    // the row count without joining the intersection. The AXIS is therefore exactly `shared`.
    const padded = (shared: number[]): Map<Sleeve, SeriesPoint[]> => {
      const m = new Map<Sleeve, SeriesPoint[]>();
      LADDER.forEach((sleeve, i) => {
        const priv = range(Y1_MIN_OBS - shared.length).map((k) => 2000 + i * 1000 + k);
        m.set(sleeve, legSeries([...priv, ...shared].sort((a, b) => a - b), (i + 1) * 0.0002));
      });
      return m;
    };

    const stretched = range(n).map((k) => Math.round((k * 500) / (n - 1)));
    expect(stretched[stretched.length - 1] as number).toBe(500);
    expect(500).toBeLessThanOrEqual(Y1_MAX_SPAN_DAYS); // the flat bound would NOT have bound here

    const out = computeLegRs(padded(stretched));
    for (const sleeve of LADDER) expect(out.rs.get(sleeve)).toBeNull();
    expect(out.lookbacksUsed).toBe(0);

    // Vacuity guard: the SAME 64-date axis, built the same way but contiguous, DOES compute — so the
    // degrade above is the span gate firing, not the row padding or a too-short axis.
    const tight = computeLegRs(padded(range(n)));
    for (const sleeve of LADDER) expect(typeof tight.rs.get(sleeve)).toBe("number");
    expect(tight.lookbacksUsed).toBe(1);
  });
});

describe("computeY1 - candidate set (Y1_REACH, D4)", () => {
  it("the candidate set never contains a rung below band.lo and never exceeds band.hi + Y1_REACH", () => {
    // The two runaway leaders sit OUTSIDE the band on both sides.
    const rs = rsMap({ [SEMIS]: 99, [STAPLES]: 99, [EM]: 0, [VALUE]: 0.1, [EXUS]: 5 });
    const history = Array.from({ length: Y1_PERSIST }, () => rs);
    const out = computeY1(rs, { lo: 3, hi: 5 }, 3, history);

    expect(out.switched).toBe(true);
    expect(out.pickRung).toBe(6); // band.hi + Y1_REACH, the deepest reachable rung
    expect(out.pickSleeve).toBe(EXUS);
    expect(out.incumbentRung).toBeGreaterThanOrEqual(3);
    expect(out.incumbentRung).toBeLessThanOrEqual(6);
  });

  it("clamps an incumbent held more aggressively than band.lo into the candidate set", () => {
    const rs = rsMap({ [SEMIS]: 99, [EM]: 0, [VALUE]: 0.1, [EXUS]: 0.2 });
    const out = computeY1(rs, { lo: 3, hi: 5 }, 1, []);
    expect(out.incumbentRung).toBe(3);
    expect(out.pickRung).toBe(3);
  });

  it("never reaches past R1_FLOOR_RUNG", () => {
    // `band.hi + Y1_REACH` = 10 here, so the clamp is what has to bind. Asserting on `pickRung`
    // instead would be VACUOUS: LADDER has only 9 rungs, so with the clamp removed the scan hits
    // `LADDER[9] === undefined` and skips, leaving `bestRung` at 9 either way. `bounds.hi` is the
    // field that actually goes 9 → 10 when the clamp is deleted.
    const rs = rsMap({ [STAPLES]: 1 });
    const out = computeY1(rs, { lo: 8, hi: 9 }, 9, []);
    expect(9 + Y1_REACH).toBeGreaterThan(R1_FLOOR_RUNG); // guard: the clamp has something to do
    expect(out.bounds.hi).toBe(R1_FLOOR_RUNG);
    expect(out.pickRung).toBe(9);
  });
});

describe("computeY1 - switch gate (Y1_MARGIN)", () => {
  it("a gap just under Y1_MARGIN does not switch, a gap at the margin does", () => {
    const band = { lo: 3, hi: 5 };

    const under = rsMap({ [EM]: 0, [EXUS]: Y1_MARGIN - 0.01 });
    const outUnder = computeY1(
      under,
      band,
      3,
      Array.from({ length: Y1_PERSIST }, () => rsMap({ [EM]: 0, [EXUS]: Y1_MARGIN })),
    );
    expect(outUnder.switched).toBe(false);
    expect(outUnder.streak).toBe(0);
    expect(outUnder.pickRung).toBe(3);

    const at = rsMap({ [EM]: 0, [EXUS]: Y1_MARGIN });
    const outAt = computeY1(
      at,
      band,
      3,
      Array.from({ length: Y1_PERSIST }, () => at),
    );
    expect(outAt.switched).toBe(true);
    expect(outAt.pickRung).toBe(6);
  });

  it("is two-sided - switching BACK needs the same margin", () => {
    // Incumbent is now the deep leg; the aggressive candidate leads by only 0.4.
    const rs = rsMap({ [EM]: 0.4, [EXUS]: 0 });
    const out = computeY1(
      rs,
      { lo: 3, hi: 5 },
      6,
      Array.from({ length: Y1_PERSIST }, () => rs),
    );
    expect(out.switched).toBe(false);
    expect(out.pickRung).toBe(6);
  });
});

describe("computeY1 - persistence (Y1_PERSIST)", () => {
  it("a streak one close short of Y1_PERSIST holds the incumbent, at Y1_PERSIST it switches", () => {
    const rs = rsMap({ [EM]: 0, [EXUS]: 0.8 });
    const band = { lo: 3, hi: 5 };

    // history length Y1_PERSIST − 2 + the current close = one close short of the gate.
    const short = computeY1(
      rs,
      band,
      3,
      Array.from({ length: Y1_PERSIST - 2 }, () => rs),
    );
    expect(short.streak).toBe(Y1_PERSIST - 1);
    expect(short.switched).toBe(false);
    expect(short.pickRung).toBe(3);

    const full = computeY1(
      rs,
      band,
      3,
      Array.from({ length: Y1_PERSIST - 1 }, () => rs),
    );
    expect(full.streak).toBe(Y1_PERSIST);
    expect(full.switched).toBe(true);
    expect(full.pickRung).toBe(6);
  });

  it("a break in the run resets the streak", () => {
    const rs = rsMap({ [EM]: 0, [EXUS]: 0.8 });
    const broken = rsMap({ [EM]: 0, [EXUS]: 0.1 });
    const out = computeY1(rs, { lo: 3, hi: 5 }, 3, [rs, rs, rs, broken, rs]);
    expect(out.streak).toBe(2);
    expect(out.switched).toBe(false);
  });
});

describe("computeY1 - tie-break and degrade", () => {
  it("prefers the MORE DEFENSIVE rung on an RS tie", () => {
    const rs = rsMap({ [EM]: 0, [VALUE]: 0.9, [EXUS]: 0.9 });
    const out = computeY1(
      rs,
      { lo: 3, hi: 5 },
      3,
      Array.from({ length: Y1_PERSIST }, () => rs),
    );
    expect(out.switched).toBe(true);
    expect(out.pickRung).toBe(6);
    expect(out.pickSleeve).toBe(EXUS);
  });

  it("holds the incumbent, silently, when no candidate has an RS", () => {
    const out = computeY1(rsMap({}), { lo: 3, hi: 5 }, 4, []);
    expect(out.pickRung).toBe(4);
    expect(out.margin).toBeNull();
    expect(out.streak).toBe(0);
    expect(out.switched).toBe(false);
    expect(out.reason).toContain("RS unavailable");
  });

  it("falls back to band.lo when the incumbent is null", () => {
    const out = computeY1(rsMap({}), { lo: 5, hi: 7 }, null, []);
    expect(out.incumbentRung).toBe(5);
  });
});

/** A leg of `n` constant closes on the shared offset axis — flat ⇒ zero realized vol. */
function flatLeg(n: number): SeriesPoint[] {
  return range(n).map((o) => ({
    date: isoDay(o),
    value: 100,
    delta20: 0,
    rawState: "GREEN" as const,
    state: "GREEN" as const,
  }));
}

describe("computeVolAdjMom - history floor (VAM_MIN_OBS)", () => {
  it("a leg with fewer than VAM_MIN_OBS closes ⇒ null", () => {
    const short = computeVolAdjMom(buildLegs(range(VAM_MIN_OBS - 1)));
    for (const sleeve of LADDER) expect(short.mom.get(sleeve)).toBeNull();
    expect(short.lookbacksUsed).toBe(0);

    const full = computeVolAdjMom(buildLegs(range(VAM_MIN_OBS)));
    for (const sleeve of LADDER) expect(typeof full.mom.get(sleeve)).toBe("number");
    expect(full.lookbacksUsed).toBe(LADDER.length);
  });
});

describe("computeVolAdjMom - cross-sectional standardization", () => {
  it("returns a mean-0 / sd-1 z-score, highest-momentum leg highest", () => {
    // buildLegs drifts each leg by (i+1)*0.0002/day, so momentum rises monotonically with rung index
    // while the ±1% wiggle keeps realized vol comparable — a known cross-section of nine.
    const out = computeVolAdjMom(buildLegs(range(200)));
    const values = LADDER.map((s) => out.mom.get(s)).filter((v): v is number => v != null);
    expect(values.length).toBe(LADDER.length);

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(
      values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (values.length - 1),
    );
    expect(mean).toBeCloseTo(0, 9);
    expect(sd).toBeCloseTo(1, 9);

    // The highest-drift leg (rung 9) carries the strongest momentum ⇒ the highest z.
    let argmax = LADDER[0] as Sleeve;
    for (const sleeve of LADDER) {
      if ((out.mom.get(sleeve) as number) > (out.mom.get(argmax) as number)) argmax = sleeve;
    }
    expect(argmax).toBe(LADDER[LADDER.length - 1]);
  });

  it("a zero realized-vol leg ⇒ null, others still score", () => {
    const legs = buildLegs(range(200));
    legs.set(SEMIS, flatLeg(200)); // flat ⇒ dailyVol 0 ⇒ excluded
    const out = computeVolAdjMom(legs);
    expect(out.mom.get(SEMIS)).toBeNull();
    const others = LADDER.filter((sleeve) => sleeve !== SEMIS);
    expect(others.length).toBeGreaterThan(0);
    for (const sleeve of others) expect(typeof out.mom.get(sleeve)).toBe("number");
    expect(out.lookbacksUsed).toBe(LADDER.length - 1);
  });

  it("fewer than Y1_MIN_LEGS defined legs ⇒ all null (degenerate cross-section, mirrors RS floor)", () => {
    // TWO defined legs is the discriminating regime: it clears the old `< 2` floor but not the
    // Y1_MIN_LEGS floor. A 2-value z-score is a constant ±0.707 carrying no dispersion, so — like RS's
    // own ≥3 floor — VAM must return all-null here. This fixture goes RED if the floor reverts to 2.
    const two = buildLegs(range(200));
    for (const sleeve of LADDER.slice(2)) two.delete(sleeve);
    expect([...two.keys()].length).toBe(2);
    const out = computeVolAdjMom(two);
    for (const sleeve of LADDER) expect(out.mom.get(sleeve)).toBeNull();
    expect(out.lookbacksUsed).toBe(0);
  });
});
