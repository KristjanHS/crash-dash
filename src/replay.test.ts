import { describe, it, expect } from "vitest";
import { computeReplay, HY_STITCHED_NOTE } from "./replay.js";
import { computeFamilyPanel, GLOBAL_FAMILIES } from "./families.js";
import { DIAL_FAMILIES } from "./dial-assembly.js";
import { SLOW_INDICATOR_IDS } from "./registry-price.js";
import { computeT1Dial, techConfirmerBreadth, techConfirmerFromPanel } from "./t1dial.js";
import { R4_HY_TAIL, R4_REENTRY_START, R4_RATCHET_DAYS } from "./r4.js";
import type { State } from "./domain-types.js";
import type { SeriesPoint } from "./store.js";

// ── synthetic-series helpers (all DB-free) ───────────────────────────────────────
const MS_DAY = 86_400_000;
/** ISO date `n` calendar days after `base`. */
const plusDays = (base: string, n: number): string =>
  new Date(Date.parse(base) + n * MS_DAY).toISOString().slice(0, 10);

/** One SeriesPoint — only `date/value/state` matter to the replay pipeline. */
const pt = (date: string, state: State, value: number): SeriesPoint => ({
  date,
  value,
  delta20: 0,
  rawState: state,
  state,
});

/** Every member id across GLOBAL_FAMILIES (deduped) — the panel the dial aggregates. */
const ALL_IDS = [...new Set(GLOBAL_FAMILIES.flatMap((f) => f.ids))];

/** Oracle: run the SAME live pipeline directly (no replay reimplementation) for a
 *  single fully-observed day (all members present → forward-fill is a no-op). */
function oracleRung(readings: { id: string; state: State }[]): number {
  // DIAL_FAMILIES mirrors what computeReplay folds against (B-11) — an oracle over the full
  // GLOBAL table would stop being an oracle the moment a fixture carried a SLOW leg.
  const panel = computeFamilyPanel(readings, DIAL_FAMILIES);
  const techP = techConfirmerBreadth(techConfirmerFromPanel(panel.families));
  return computeT1Dial(panel.families, techP).targetRung;
}

describe("computeReplay - forward-fill horizon", () => {
  // Two ARM leaders + one FIRE family drive the dial: rates (R1) + volatility (R5) observed at
  // A, A+119, A+121 (constant RED), credit (F1) observed ONLY at A. R5 RED makes the dial `fired`
  // so the armed-unfired cap (6) doesn't flatten both days — two RED leaders reach rung 9, one
  // reaches 6, so the credit drop is observable. Forward-fill of F1: gap 119 ≤ 120 fills (credit
  // RED, 2 firing leaders); gap 121 > 120 drops it (credit non-live, 1 firing leader) → the sole
  // present-member of its family gone flips the family live:false, LOWERING the rung.
  const A = "2020-01-01";
  const d119 = plusDays(A, 119);
  const d121 = plusDays(A, 121);

  const series = [
    { id: "F1", points: [pt(A, "RED", 9)] }, // credit — one observation only
    { id: "R1", points: [pt(A, "RED", 9), pt(d119, "RED", 9), pt(d121, "RED", 9)] }, // rates — constant
    { id: "R5", points: [pt(A, "RED", 9), pt(d119, "RED", 9), pt(d121, "RED", 9)] }, // volatility — fires the dial
    { id: "F2", points: [] as SeriesPoint[] }, // empty-series member (coverage null case)
  ];

  const res = computeReplay(series, { start: A, end: d121 });
  const byDate = new Map(res.points.map((p) => [p.date, p]));

  it("fills a gap < 120d: F1 present at A+119 ⇒ both leaders fire", () => {
    // Oracle: credit RED (F1 filled) + rates RED + volatility RED present.
    const oracle = oracleRung([{ id: "F1", state: "RED" }, { id: "R1", state: "RED" }, { id: "R5", state: "RED" }]);
    expect(byDate.get(d119)!.targetRung).toBe(oracle);
  });

  it("drops the member (and its sole-member family) at gap ≥ 120d: F1 absent at A+121 lowers the rung", () => {
    // Oracle: only rates RED (+ volatility RED) present (credit family has no present member ⇒ live:false).
    const oracle = oracleRung([{ id: "R1", state: "RED" }, { id: "R5", state: "RED" }]);
    expect(byDate.get(d121)!.targetRung).toBe(oracle);
    // The drop is observable: fewer firing leaders ⇒ a strictly lower rung than the filled day.
    expect(byDate.get(d121)!.targetRung).toBeLessThan(byDate.get(d119)!.targetRung);
  });
});

describe("computeReplay - forward-fill horizon boundary (gap == 120 fills)", () => {
  // The horizon is INCLUSIVE: a member last seen exactly FFILL_MAX_CALENDAR_DAYS (120)
  // calendar days ago still fills (gap <= 120); only gap > 120 drops it — pins the
  // boundary the plan's "≥120 drops" wording rounds off (code's <= is the chosen behavior).
  // F1 seen only at A; R1 also at A+120 so there's a union date exactly 120d out.
  const A = "2020-01-01";
  const d120 = plusDays(A, 120);
  const series = [
    { id: "F1", points: [pt(A, "RED", 9)] },
    { id: "R1", points: [pt(A, "RED", 9), pt(d120, "RED", 9)] },
  ];
  const res = computeReplay(series, { start: A, end: d120 });
  const byDate = new Map(res.points.map((p) => [p.date, p]));

  it("fills a gap of exactly 120 calendar days: both leaders still fire at A+120", () => {
    // Oracle: F1 present (gap 120 fills) + R1 present ⇒ both leaders RED. A `<` boundary
    // would drop F1 here and yield a strictly lower rung (see the gap ≥ 120 drop case above).
    const oracle = oracleRung([{ id: "F1", state: "RED" }, { id: "R1", state: "RED" }]);
    expect(byDate.get(d120)!.targetRung).toBe(oracle);
  });
});

describe("computeReplay - dial leg-path", () => {
  // Hand-built two-family escalation; every member observed each day so forward-fill is a
  // no-op and the oracle is a direct computeT1Dial call with the same readings.
  const D1 = "2021-03-01"; // calm
  const D2 = "2021-03-02"; // credit RED
  const D3 = "2021-03-03"; // credit RED + rates RED
  const dates = [D1, D2, D3];

  // Start all members GREEN, then escalate F1 (credit) and R1 (rates).
  const series = ALL_IDS.map((id) => {
    const state = (d: string): State =>
      id === "F1" && (d === D2 || d === D3) ? "RED" : id === "R1" && d === D3 ? "RED" : "GREEN";
    return { id, points: dates.map((d) => pt(d, state(d), 1)) };
  });

  const res = computeReplay(series, { start: D1, end: D3 });

  it("emits one point per trading day, dates monotone", () => {
    expect(res.points.map((p) => p.date)).toEqual([D1, D2, D3]);
  });

  it("each day's targetRung matches a direct computeT1Dial oracle", () => {
    const readingsFor = (d: string) =>
      ALL_IDS.map((id) => ({
        id,
        state: (id === "F1" && (d === D2 || d === D3) ? "RED" : id === "R1" && d === D3 ? "RED" : "GREEN") as State,
      }));
    for (const d of dates) {
      const oracle = oracleRung(readingsFor(d));
      expect(res.points.find((p) => p.date === d)!.targetRung).toBe(oracle);
    }
  });

  it("escalation is monotone non-decreasing as families redden", () => {
    const [p1, p2, p3] = res.points;
    expect(p2!.targetRung).toBeGreaterThanOrEqual(p1!.targetRung);
    expect(p3!.targetRung).toBeGreaterThanOrEqual(p2!.targetRung);
    // band mirrors the dial regime (regimeToBand), so it never disagrees with the rung climb.
    expect(["OK", "WATCH", "WARNING", "CRITICAL"]).toContain(p3!.band);
  });
});

describe("computeReplay - R4 threading", () => {
  // All families RED with a HY-OAS tail print (F1 value ≥ R4_HY_TAIL) satisfies the full
  // ENTER gate every day. 5 consecutive enter closes, range starting on the 3rd ⇒ the first
  // two are warm-up closes consumed but NOT emitted. Post-NF-1(A) the FIRST of them already
  // enters cash and the second holds it, so the 3rd (first emitted) day still prints cash —
  // what the warm-up now proves is that the fold CONSUMES pre-range closes, not that it
  // counts them.
  const base = "2020-03-02";
  const enterDates = [0, 1, 2, 3, 4].map((n) => plusDays(base, n)); // 03-02..03-06
  const calmDate = plusDays(base, 8); // 03-10 — a few days later, still < ratchet window
  const walkDates = [plusDays(base, 9), plusDays(base, 10)]; // reentry walk continues

  const dates = [...enterDates, calmDate, ...walkDates];
  const series = ALL_IDS.map((id) => ({
    id,
    points: dates.map((d) => {
      const enter = enterDates.includes(d);
      return pt(d, enter ? "RED" : "GREEN", enter ? 9 : 1); // F1=9 ≥ tail on enter days; calm=1 clears
    }),
  }));

  // range.start = enterDates[2] ⇒ enterDates[0],[1] are the 2 warm-up union-dates.
  const res = computeReplay(series, { start: enterDates[2]!, end: walkDates[1]! });
  const byDate = new Map(res.points.map((p) => [p.date, p]));

  it("consumes warm-up days without emitting them", () => {
    expect(res.points.map((p) => p.date)).toEqual([enterDates[2], enterDates[3], enterDates[4], calmDate, ...walkDates]);
    expect(byDate.has(enterDates[0]!)).toBe(false);
    expect(byDate.has(enterDates[1]!)).toBe(false);
  });

  it("consecutive enter closes → cash, held across the range", () => {
    expect(byDate.get(enterDates[2]!)!.cash).toBe(true);
    expect(byDate.get(enterDates[2]!)!.r4Phase).toBe("cash");
    expect(byDate.get(enterDates[3]!)!.r4Phase).toBe("cash"); // holds while danger persists
  });

  it("exit → laddered re-entry walk from the most-defensive rung", () => {
    // First calm close (danger cleared, < ratchet days in cash) begins re-entry at rung 9.
    expect(byDate.get(calmDate)!.cash).toBe(false);
    expect(byDate.get(calmDate)!.r4Phase).toBe("reentry");
    expect(byDate.get(calmDate)!.reentryRung).toBe(R4_REENTRY_START);
    // Subsequent calm closes walk the rung down toward the (low) live target.
    expect(byDate.get(walkDates[0]!)!.reentryRung).toBe(R4_REENTRY_START - 1);
    expect(byDate.get(walkDates[1]!)!.reentryRung).toBe(R4_REENTRY_START - 2);
  });
});

describe("computeReplay - entryFiredAt anchored to the replayed day (not wall clock)", () => {
  // A > R4_RATCHET_DAYS-calendar-day cash stay in HISTORICAL dates, then a calm close with
  // the dial receded (targetRung ≤ 6) ⇒ the idle-cash ratchet snaps straight to equity. This
  // only fires when entryFiredAt is the replayed day ISO: a wall-clock anchor would make the
  // historical exit's `daysInCash` negative (entry "in the future"), missing the ≥20d ratchet.
  const base = "2019-06-03";
  const enterDates = [0, 1, 2].map((n) => plusDays(base, n)); // 3 enter closes → cash
  const exitDate = plusDays(base, 2 + R4_RATCHET_DAYS + 5); // well past the ratchet window
  const dates = [...enterDates, exitDate];

  const series = ALL_IDS.map((id) => ({
    id,
    points: dates.map((d) => {
      const enter = enterDates.includes(d);
      return pt(d, enter ? "RED" : "GREEN", enter ? 9 : 1);
    }),
  }));

  const res = computeReplay(series, { start: enterDates[0]!, end: exitDate });
  const byDate = new Map(res.points.map((p) => [p.date, p]));

  it("F1 enter tail actually meets the threshold (guards the fixture)", () => {
    expect(9).toBeGreaterThanOrEqual(R4_HY_TAIL);
  });

  it("ratchet snaps to equity after a long historical cash stay", () => {
    expect(byDate.get(enterDates[2]!)!.r4Phase).toBe("cash");
    expect(byDate.get(exitDate)!.r4Phase).toBe("equity"); // ratchet snap, not reentry
    expect(byDate.get(exitDate)!.reentryRung).toBeNull();
  });
});

describe("computeReplay - coverage & notes", () => {
  const A = "2022-01-03";
  const series = [
    { id: "F1", points: [pt(A, "GREEN", 1), pt(plusDays(A, 1), "GREEN", 1)] },
    { id: "R1", points: [pt(plusDays(A, 1), "GREEN", 1)] }, // first observation one day later
    { id: "VT", points: [] as SeriesPoint[] }, // no history
  ];
  const res = computeReplay(series, { start: A, end: plusDays(A, 1) });

  it("reports firstDate per member; empty series ⇒ null", () => {
    expect(res.coverage).toEqual([
      { id: "F1", firstDate: A },
      { id: "R1", firstDate: plusDays(A, 1) },
      { id: "VT", firstDate: null },
    ]);
  });

  it("emits the server-authored honesty labels (GEO + R4 warm-up)", () => {
    expect(res.notes[0]).toContain("Geopolitics = auto G1 (oil) only");
    expect(res.notes[1]).toBe("R4 state warmed from equity 0 trading days before range start.");
  });

  it("templates the warm-up label with the actual depth consumed", () => {
    // start = A+1 ⇒ exactly one union-date (A) precedes it, so 1 warm-up day is run.
    const r = computeReplay(series, { start: plusDays(A, 1), end: plusDays(A, 1) });
    expect(r.notes[1]).toBe("R4 state warmed from equity 1 trading day before range start.");
  });

  // Review 2026-08-01 (N4): an EMPTY override array is truthy, so `?? null` took the override branch
  // — R4 read null every day AND the response claimed "R4's HY-OAS input is the STITCHED history".
  // The note is the observable half; the level half is pinned by the non-vacuity control below.
  it("an EMPTY hyOasLevels array is NOT an override - no stitched note", () => {
    const r = computeReplay(series, { start: A, end: plusDays(A, 1) }, { hyOasLevels: [] });
    expect(r.notes).not.toContain(HY_STITCHED_NOTE);
    // NON-VACUITY: a real override on the same call DOES emit it, so the assertion above can fail.
    const withLevels = computeReplay(series, { start: A, end: plusDays(A, 1) }, {
      hyOasLevels: [{ date: A, value: R4_HY_TAIL }],
    });
    expect(withLevels.notes).toContain(HY_STITCHED_NOTE);
  });
});

describe("computeReplay - B-11: the display-only SLOW legs cannot move the replayed band", () => {
  // /api/replay's member series come from api/lab.ts's per-member getSeries over the PERSISTED
  // rows, and the slow rows ARE persisted (run-cycle-persist.ts's recordRun) — so unlike the cron dial, this
  // path really does see them. It serves `targetRung` + `band`, the NOTIFY axis, so folding them
  // in would replay a band the live cron can never produce. computeReplay reduces against
  // DIAL_FAMILIES; this pins that.
  //
  // The fixture is chosen so the leg WOULD bite under the full table: volatility's fast members
  // are calm (R5 GREEN), so a RED `complacency-high` is the only thing that could fire the family
  // — and volatility is a FIRE family, which gates rungs 7-9.
  const A = "2020-01-01";
  const B = plusDays(A, 1);
  const fast = [
    { id: "R1", points: [pt(A, "RED", 9), pt(B, "RED", 9)] }, // rates firing (an ARM leader)
    { id: "R5", points: [pt(A, "GREEN", 1), pt(B, "GREEN", 1)] }, // volatility's fast leg: calm
  ];
  const withSlow = [
    ...fast,
    { id: "complacency-high", points: [pt(A, "RED", 9), pt(B, "RED", 9)] },
  ];

  const base = computeReplay(fast, { start: A, end: B });
  const slow = computeReplay(withSlow, { start: A, end: B });

  it("fixture guard: the RED slow leg is really in the second series set", () => {
    // Without this the parity assertion below could pass vacuously on two identical inputs.
    expect(withSlow.length).toBe(fast.length + 1);
    expect(SLOW_INDICATOR_IDS.has("complacency-high")).toBe(true);
    expect(slow.coverage.find((c) => c.id === "complacency-high")?.firstDate).toBe(A);
    expect(base.points.length).toBeGreaterThan(0);
  });

  it("fixture guard: the leg WOULD fire volatility under the full GLOBAL_FAMILIES table", () => {
    // Proves the pin is not vacuous by construction: under the table replay used BEFORE the fix,
    // this reading set fires volatility; under DIAL_FAMILIES it does not.
    const readings = [{ id: "R1", state: "RED" as State }, { id: "R5", state: "GREEN" as State }, { id: "complacency-high", state: "RED" as State }];
    const globalVol = computeFamilyPanel(readings, GLOBAL_FAMILIES).families.find((f) => f.key === "volatility")!;
    const dialVol = computeFamilyPanel(readings, DIAL_FAMILIES).families.find((f) => f.key === "volatility")!;
    expect(globalVol.firing).toBe(true);
    expect(dialVol.firing).toBe(false);
  });

  it("replays the SAME targetRung + band with and without the slow leg", () => {
    expect(slow.points.map((p) => ({ date: p.date, targetRung: p.targetRung, band: p.band }))).toEqual(
      base.points.map((p) => ({ date: p.date, targetRung: p.targetRung, band: p.band })),
    );
    // …and it matches the live-pipeline oracle over the fast readings alone.
    expect(slow.points.at(-1)!.targetRung).toBe(
      oracleRung([{ id: "R1", state: "RED" }, { id: "R5", state: "GREEN" }]),
    );
  });
});
