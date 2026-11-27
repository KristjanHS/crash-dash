import { describe, expect, it } from "vitest";
import {
  CASH_ACCEL_WINDOW,
  CASH_ENTER_CLOSES,
  CASH_PRIOR_MAX_AGE_DAYS,
  buildCashOverlayWindow,
  computeCashOverlay,
  resolveCash,
  type CashOverlayResult,
  type CashOverlayState,
  type CashPriorRow,
} from "./cash-overlay.js";
import { EQUITY_PCT } from "./exposure.js";
import { applyFallShape } from "./v-bear.js";
import { type R4Phase, type R4Result } from "./r4.js";
import { makeDial } from "./test-helpers.js";

const mkR4 = (over: Partial<R4Result> = {}): R4Result => ({
  cash: false,
  phase: "equity",
  entryFiredAt: null,
  reentryRung: null,
  reason: "on ladder",
  ...over,
});

const EMPTY: CashOverlayState = { recentTargetRungs: [], since: null };
const clock = () => "2026-07-18T22:00:00.000Z";

/** Feed a whole `targetRung` sequence through the fold, returning the final result. */
const run = (rungs: number[], from: CashOverlayState = EMPTY): CashOverlayResult => {
  let state = from;
  let out!: CashOverlayResult;
  for (const targetRung of rungs) {
    out = computeCashOverlay(makeDial({ targetRung }), state, clock);
    state = { recentTargetRungs: out.recentTargetRungs, since: out.since };
  }
  return out;
};

describe("cash overlay constants", () => {
  it("measures over a longer window than it needs to fire - 1 close in, 1 close out", () => {
    // The overlay's own two numbers, not a cross-module comparison: it commits (ENTER) on a single
    // qualifying close, but the rise it looks for may be spread across the whole measurement
    // window. Window ≤ enter-persistence would make the multi-close rise unreachable.
    expect(CASH_ACCEL_WINDOW).toBeGreaterThan(CASH_ENTER_CLOSES);
  });
});

describe("buildCashOverlayWindow", () => {
  const ASOF = "2026-07-18";
  /** `ASOF` minus n calendar days, as an ISO date. */
  const day = (n: number) => new Date(Date.parse(ASOF) - n * 86_400_000).toISOString().slice(0, 10);
  const row = (n: number, dialTargetRung: number | null): CashPriorRow => ({
    date: day(n),
    dialTargetRung,
  });

  it("emits MOST RECENT LAST (F-1)", () => {
    // Array equality, not a level assertion, and asymmetric values on purpose: `computeCashOverlay`
    // takes `Math.min` over the window, so a reversed order yields an IDENTICAL level/rise/reason.
    // This assertion is the only thing that can catch a reversal.
    expect(buildCashOverlayWindow([row(1, 5), row(2, 3)], ASOF)).toEqual([3, 5]);
  });

  it("caps at the newest priors, dropping the older surplus", () => {
    const out = buildCashOverlayWindow([row(1, 9), row(2, 8), row(3, 7), row(4, 6)], ASOF);
    expect(out).toEqual([8, 9]);
  });

  it("truncates at a calendar gap, keeping the NEWER side", () => {
    expect(buildCashOverlayWindow([row(1, 5), row(40, 2)], ASOF)).toEqual([5]);
    // The bound is pairwise, not newest-only: a fresh row does not license an ancient one.
    expect(CASH_PRIOR_MAX_AGE_DAYS).toBeLessThan(40);
  });

  it("bounds each window STEP pairwise, not the whole span against asOf", () => {
    // Both rows are older than CASH_PRIOR_MAX_AGE_DAYS measured from `asOf`, but each step
    // (asOf→-7, -7→-14) is exactly at the bound, so both are admitted. An asOf-anchored bound
    // would return length 1 — and the two other age tests (gap, stale-only) pass under BOTH
    // rules, so this is the only assertion that distinguishes them.
    const step = CASH_PRIOR_MAX_AGE_DAYS;
    expect(buildCashOverlayWindow([row(step, 5), row(step * 2, 3)], ASOF)).toEqual([3, 5]);
    // The composed worst case is INTENTIONAL ("stated not hidden"):
    // a 2-prior window can legitimately span 2 × CASH_PRIOR_MAX_AGE_DAYS
    // calendar days while the reason string still prints "3 closes"; no cumulative cap is added.
  });

  it("truncates at a null rung rather than splicing it out", () => {
    expect(buildCashOverlayWindow([row(1, 5), row(2, null), row(3, 2)], ASOF)).toEqual([5]);
    // Vacuity guard: the same fixture with the null filled must NOT be length 1, or this passes
    // against a builder that returns a single element unconditionally.
    expect(buildCashOverlayWindow([row(1, 5), row(2, 4), row(3, 2)], ASOF)).toEqual([4, 5]);
  });

  it("seeds empty when the only prior is stale", () => {
    expect(buildCashOverlayWindow([row(60, 3)], ASOF)).toEqual([]);
  });

  it("excludes a row carrying the current close's own obs_date", () => {
    // The intraday re-run case: `getRecentAlerts` includes today, but today is not a PRIOR close.
    expect(buildCashOverlayWindow([row(0, 9), row(1, 5), row(2, 3)], ASOF)).toEqual([3, 5]);
  });

  it("de-dupes a duplicated obs_date, keeping the newest-fired row", () => {
    // Input is newest-fired-first, so the first row seen for a date wins.
    expect(buildCashOverlayWindow([row(1, 5), row(1, 1), row(2, 3)], ASOF)).toEqual([3, 5]);
  });

  // NB: the sort repairs OBS_DATE order only. De-dupe runs first and keeps first-seen, which
  // assumes the input is newest-FIRED first — the one thing the sort cannot repair. Unreachable
  // through `getRecentAlerts` (`fired_at DESC` by construction), so this test covers out-of-order
  // rows WITHOUT duplicates; the duplicate case is pinned separately, in fired-order.
  it("is insensitive to out-of-order obs_dates (defensive sort)", () => {
    const rows = [row(2, 3), row(1, 5), row(4, 1)];
    expect(buildCashOverlayWindow(rows, ASOF)).toEqual(
      buildCashOverlayWindow([row(1, 5), row(2, 3), row(4, 1)], ASOF),
    );
    expect(buildCashOverlayWindow(rows, ASOF)).toEqual([3, 5]);
  });
});

describe("computeCashOverlay - UD-1(c) dial acceleration", () => {
  it("fires on the FIRST qualifying close (CASH_ENTER_CLOSES = 1)", () => {
    const out = run([3, 5]);
    expect(out.level).toBe("partial");
    expect(out.since).toBe(clock());
    expect(out.reason).toContain("3→5");
  });

  it("does not fire on a rise smaller than one band width", () => {
    expect(run([3, 4]).level).toBe("off");
  });

  it("does not fire on a grind that reaches the same depth below the required RATE", () => {
    // 3→6 total, but only +1 per two closes: the trough is evicted before the peak arrives, so no
    // window ever spans CASH_ACCEL_RUNGS. A naive compare-against-the-first-ever-rung would fire.
    const grind = [3, 3, 4, 4, 5, 5, 6];
    expect(grind.length).toBeGreaterThan(CASH_ACCEL_WINDOW);
    expect(run(grind).level).toBe("off");
    // Vacuity guard: the fold is not unconditionally "off" — the same peak reached fast DOES fire.
    expect(run([3, 3, 6]).level).toBe("partial");
  });

  it("exits on the first non-qualifying close and drops `since`", () => {
    const fired = run([3, 5]);
    expect(fired.level).toBe("partial");
    const after = computeCashOverlay(
      makeDial({ targetRung: 5 }),
      { recentTargetRungs: fired.recentTargetRungs, since: fired.since },
      clock,
    );
    // window = [3,5,5] → trough 3, rise 2 — still accelerating.
    expect(after.level).toBe("partial");
    const settled = run([5, 5], { recentTargetRungs: after.recentTargetRungs, since: after.since });
    expect(settled.level).toBe("off");
    expect(settled.since).toBeNull();
  });

  it("preserves the ENTRY stamp across a continuously-active run", () => {
    const first = run([3, 5]);
    let ticks = 0;
    const laterClock = () => `2026-07-19T22:00:00.00${++ticks}Z`;
    const next = computeCashOverlay(
      makeDial({ targetRung: 6 }),
      { recentTargetRungs: first.recentTargetRungs, since: first.since },
      laterClock,
    );
    expect(next.level).toBe("partial");
    expect(next.since).toBe(first.since);
    expect(ticks).toBe(0); // the clock was never consulted while already active
  });

  it("fails toward under-reaction on an absent dial, and clears the window", () => {
    const fired = run([3, 5]);
    const out = computeCashOverlay(
      null,
      { recentTargetRungs: fired.recentTargetRungs, since: fired.since },
      clock,
    );
    expect(out.level).toBe("off");
    expect(out.reason).toBe("no dial");
    expect(out.recentTargetRungs).toEqual([]);
    // The clear is what stops a stale low rung manufacturing a false rise on the next real close.
    expect(run([5], { recentTargetRungs: out.recentTargetRungs, since: out.since }).level).toBe("off");
  });

  it("keeps `nonEquityPct` null - W5-b sizes at `resolveCash`, never here (§4.3.1)", () => {
    expect(run([3, 5]).nonEquityPct).toBeNull();
    expect(run([3, 3]).nonEquityPct).toBeNull();
    expect(computeCashOverlay(null, EMPTY, clock).nonEquityPct).toBeNull();
  });

  it("ORTHOGONALITY (DEC-1) - mutates neither the dial nor the prior state", () => {
    const dial = makeDial({ targetRung: 7 });
    const snapshot = structuredClone(dial);
    const prior: CashOverlayState = { recentTargetRungs: [3, 4], since: null };
    const priorSnapshot = structuredClone(prior);
    computeCashOverlay(dial, prior, clock);
    expect(dial).toEqual(snapshot);
    expect(prior).toEqual(priorSnapshot);
  });
});

describe("resolveCash - §3 precedence", () => {
  const active = run([3, 5]);
  const idle = run([3, 3]);
  // Core: the mid posture, so `standing` is a distinctive 30 rather than a boundary value.
  const CORE = EQUITY_PCT.Core;

  it("R4 cash dominates unconditionally", () => {
    expect(resolveCash(mkR4({ cash: true, phase: "cash" }), active, CORE).level).toBe("full");
    expect(resolveCash(mkR4({ cash: true, phase: "cash" }), idle, CORE).level).toBe("full");
  });

  it("suppresses an active overlay during R4 re-entry (the D8 whipsaw)", () => {
    const merged = resolveCash(mkR4({ phase: "reentry", reentryRung: 9 }), active, CORE);
    expect(merged.level).toBe("off");
    expect(merged.reason).toContain("re-entry");
  });

  it("surfaces the overlay as `partial` while R4 is on the ladder", () => {
    const merged = resolveCash(mkR4({ phase: "equity" }), active, CORE);
    expect(merged.level).toBe("partial");
    expect(merged.reason).toBe(active.reason);
    expect(merged.nonEquityPct).toBe(100 - CORE);
  });

  // B-22 — `suppressedBy` names WHY an early overlay is held back, when it is (all three are `off`).
  it("flags each cash HOLD distinctly, and never a plain quiet off", () => {
    // `active` FIRES partial (the state can change); applyFallShape must flip it off to matter.
    expect(resolveCash(mkR4({ phase: "equity" }), active, CORE).suppressedBy).toBeNull();
    const suppressed = applyFallShape(active, "v-shaped", true);
    expect(suppressed.level).toBe("off"); // the suppressor really fired
    const merged = resolveCash(mkR4({ phase: "equity" }), suppressed, CORE);
    expect(merged.level).toBe("off");
    expect(merged.suppressedBy).toBe("v-shape");
    // a plain quiet off carries a non-null reason too, yet is NOT a hold — the misfire a
    // reason-presence gate would make.
    expect(resolveCash(mkR4({ phase: "equity" }), idle, CORE).suppressedBy).toBeNull();
    // r4 re-entry is its own hold; R4 `full` is R4 firing, not a hold.
    expect(resolveCash(mkR4({ phase: "reentry", reentryRung: 9 }), active, CORE).suppressedBy).toBe(
      "r4-reentry",
    );
    expect(resolveCash(mkR4({ cash: true, phase: "cash" }), active, CORE).suppressedBy).toBeNull();
  });

  // W5-b §4.3.2 — the semantic break: a suppressed LEVEL no longer implies a null SCALAR. Written
  // against the pre-4.1 code these three would each read `null` and fail.
  it("carries the standing scalar in every non-R4-cash state, `off` included", () => {
    expect(resolveCash(mkR4({ phase: "equity" }), idle, CORE).nonEquityPct).toBe(100 - CORE);
    expect(resolveCash(mkR4({ phase: "reentry" }), active, CORE).nonEquityPct).toBe(100 - CORE);
  });

  it("propagates a degraded posture as null rather than fabricating a number", () => {
    for (const phase of ["equity", "reentry"] as R4Phase[]) {
      expect(resolveCash(mkR4({ phase }), active, null).nonEquityPct).toBeNull();
      expect(resolveCash(mkR4({ phase }), idle, null).nonEquityPct).toBeNull();
    }
    // R4's terminal cash is total BY DEFINITION and does not consult the posture, so it survives
    // the degrade at 100 — the one branch where a null `equityPct` does NOT null the scalar.
    expect(resolveCash(mkR4({ cash: true, phase: "cash" }), idle, null).nonEquityPct).toBe(100);
  });

  it("is total over the R4 × overlay × posture product, and never emits two magnitudes", () => {
    // Every member of the narrowed union (NF-1(A)) — the totality claim is only as good as this
    // list, so it must enumerate `R4Phase` exhaustively, not sample it.
    const phases: R4Phase[] = ["equity", "cash", "reentry"];
    const postures: (number | null)[] = [null, ...Object.values(EQUITY_PCT)];
    const partials: { phase: R4Phase; cash: boolean }[] = [];
    for (const phase of phases) {
      for (const overlay of [active, idle]) {
        for (const equityPct of postures) {
          const r4 = mkR4({ phase, cash: phase === "cash" });
          const merged = resolveCash(r4, overlay, equityPct);
          // The single-magnitude guarantee, now a BICONDITIONAL across all three axes:
          // `nonEquityPct === 100` ⟺ `level === "full"` ⟺ `r4.cash`. It holds only because the
          // deepest posture (Defensive, 15% equity) tops the standing scalar out at 85 < 100.
          expect(merged.level === "full").toBe(r4.cash);
          expect(merged.nonEquityPct === 100).toBe(r4.cash);
          if (merged.level === "partial") partials.push({ phase, cash: r4.cash });
        }
      }
    }
    expect(partials.length).toBeGreaterThan(0);
    for (const { phase, cash } of partials) {
      expect(cash).toBe(false);
      expect(phase).not.toBe("reentry");
    }
  });
});
