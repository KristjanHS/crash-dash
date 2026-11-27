import { describe, it, expect } from "vitest";
import type { T1DialResult } from "./t1dial.js";
import { makeDial, type DialOverrides } from "./test-helpers.js";
import {
  computeR4,
  R4_HY_TAIL,
  R4_EXIT_HY,
  R4_VT_TAIL,
  R4_REENTRY_START,
  type R4State,
} from "./r4.js";

/**
 * A full T1DialResult at the top of the ladder; only `targetRung` + the two firing counts +
 * `pillarsLive` matter to R4. Built through the shared `makeDial` (2026-08-02), so the four
 * rung-derived cells and the band come from production.
 *
 * WHY THE CONVERSION: the pre-2026-08-02 local literal froze `rung: 9 / dangerScore: 1 /
 * targetRung: 9 / Crisis / band {7,9}` and applied `...over` on top — but EVERY call site here
 * overrides `targetRung` ALONE, so `dial({ targetRung: 6 })` returned a rung-9 danger book wearing a
 * rung-6 label. That literal is internally CONSISTENT — the contradiction lives in the SPREAD, not
 * in the literal, so no scan over the literal could catch it. Routing through `DialOverrides` is what
 * closes it — the union makes `{ rung, targetRung }` together a compile error, and one override now
 * moves the whole book.
 *
 * `leaderSplit: 1` reproduces the old hand-typed `{lo: 7, hi: 9}` through `dialBandFor`
 * (width = POSITION_SPAN × 1), and `creditFiring: true` earns the "Crisis" label the crisis gate
 * would otherwise demote — consistent with `leadingFiring: 2` (both leading families firing).
 */
function dial(over: DialOverrides = { targetRung: 9 }): T1DialResult {
  return makeDial(
    {
      leadingFiring: 2,
      coincidentFiring: 2,
      leadingP: 1,
      coincidentP: 1,
      positionP: 1,
      armed: true,
      fired: true,
      ...over,
    } as DialOverrides,
    { leaderSplit: 1, creditFiring: true },
  );
}

/** Fixed clock — R4 only reads it for `entryFiredAt` and the idle-cash age. */
const clk = (iso: string) => () => iso;
const NOW = "2026-07-12T00:00:00.000Z";
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

const equityPrior: R4State = { phase: "equity", entryFiredAt: null, reentryRung: null };
/** a dial+tail that satisfies the full ENTER gate (deep band, ≥3 firing, HY tail print). */
const enterDial = dial({ targetRung: 9, leadingFiring: 2, coincidentFiring: 2 });
const enterHy = R4_HY_TAIL; // exactly AT the tail cut — a tail print, whatever the cut's value is
const calmVt = 1.0; // < R4_VT_TAIL, so the tail rides on HY alone

describe("R4 HY hysteresis band - the R4_EXIT_HY < R4_HY_TAIL invariant", () => {
  // LOAD-BEARING, not decorative:
  // both levels are now hand-set ABSOLUTE literals and the `0.75 ×` relation that used to keep the
  // exit under the tail structurally is RETIRED. This assertion is the only thing left that fails
  // when a retune inverts them. Written as a relation between the SYMBOLS — never as two literals,
  // which would pass unchanged through exactly the retune it exists to catch.
  it("the EXIT level sits strictly BELOW the ENTER tail, so the band is inverted-hysteresis", () => {
    expect(R4_EXIT_HY).toBeLessThan(R4_HY_TAIL);
  });
});

describe("computeR4", () => {
  // NF-1(A), 2026-07-26: the arming ladder is DELETED, not shortened. Written against the old
  // 3-close machine this goes red on the very first assertion (`arm1` ≠ `cash`).
  it("enter-gate: ONE qualifying close from equity enters cash and stamps entryFiredAt", () => {
    const c1 = computeR4(enterDial, enterHy, calmVt, equityPrior, clk(NOW));
    expect(c1.phase).toBe("cash");
    expect(c1.cash).toBe(true);
    expect(c1.entryFiredAt).toBe(NOW); // the idle-cash ratchet clock is anchored on close 1
    expect(c1.reentryRung).toBeNull();
  });

  it("enter-gate: the next close simply HOLDS cash - no counter survives the entry", () => {
    const c1 = computeR4(enterDial, enterHy, calmVt, equityPrior, clk(NOW));
    const c2 = computeR4(enterDial, enterHy, calmVt, { phase: c1.phase, entryFiredAt: c1.entryFiredAt, reentryRung: c1.reentryRung }, clk(NOW));
    expect(c2.phase).toBe("cash");
    expect(c2.cash).toBe(true);
    expect(c2.entryFiredAt).toBe(NOW); // carried from the ENTRY close, not re-stamped
  });

  it("tail-required guard: deep band + breadth but NO tail print never leaves equity", () => {
    // targetRung 9 and 4 firing families, but HY < R4_HY_TAIL AND VT < R4_VT_TAIL → tail un-met.
    const noTail = dial({ targetRung: 9, leadingFiring: 2, coincidentFiring: 2 });
    let prior = equityPrior;
    for (let i = 0; i < 4; i++) {
      const r = computeR4(noTail, R4_HY_TAIL - 0.1, R4_VT_TAIL - 0.01, prior, clk(NOW));
      expect(r.phase).toBe("equity");
      expect(r.cash).toBe(false);
      prior = { phase: r.phase, entryFiredAt: r.entryFiredAt, reentryRung: r.reentryRung };
    }
  });

  // NF-1(A) applied CONSISTENTLY: a re-surge while walking back onto the ladder is itself a
  // "first qualifying close", so it goes straight to cash — never back to an arming state, and
  // never merely a pause in the walk. Written against the old machine this reads `arm1` and reds.
  it("re-entry re-surge: one qualifying close mid-walk goes straight to cash (not an arming state)", () => {
    const walking: R4State = { phase: "reentry", entryFiredAt: null, reentryRung: R4_REENTRY_START - 2 };
    const r = computeR4(enterDial, enterHy, calmVt, walking, clk(NOW));
    expect(r.phase).toBe("cash");
    expect(r.cash).toBe(true);
    expect(r.entryFiredAt).toBe(NOW); // a fresh ratchet anchor, as on any entry
    expect(r.reentryRung).toBeNull(); // the walk is abandoned, not resumed later
  });

  // Stage 8.1 audit fix (leg a) — the rung-clear EXIT leg is liveness-gated. A non-live pillar is
  // dropped from the dial fold and counts as LOW, so a run that merely exhausted the fetch budget
  // prints the SAME calm targetRung a genuinely calm close does. EXIT is single-close AND
  // persisted, so pre-fix one starved close walked the breaker out of cash and cost 3 closes to
  // re-arm. Goes RED against the pre-fix `rungClear = dial.targetRung <= R4_EXIT_RUNG`.
  it("liveness guard: a starved (non-live-pillar) calm rung does NOT exit cash; the same rung LIVE does", () => {
    const cash: R4State = { phase: "cash", entryFiredAt: daysAgo(2), reentryRung: null };
    // Tails still hot, so the tail-clear leg cannot exit — the rung leg is the only candidate.
    const starved = computeR4(dial({ targetRung: 6, pillarsLive: false }), R4_HY_TAIL, R4_VT_TAIL, cash, clk(NOW));
    expect(starved.phase).toBe("cash");
    expect(starved.cash).toBe(true);

    // Control: identical close with the denominator intact still exits exactly as before, so the
    // guard is liveness-only and did not move the exit rung.
    const live = computeR4(dial({ targetRung: 6, pillarsLive: true }), R4_HY_TAIL, R4_VT_TAIL, cash, clk(NOW));
    expect(live.phase).toBe("reentry");
  });

  it("liveness guard: a starved rung cannot trigger the idle-cash ratchet snap either", () => {
    const longStay: R4State = { phase: "cash", entryFiredAt: daysAgo(25), reentryRung: null };
    // Tails clear ⇒ exitCond fires via the tail leg regardless; the question is only whether the
    // starved rung is allowed to ACCELERATE that into a straight snap to target.
    const starved = computeR4(dial({ targetRung: 5, pillarsLive: false }), R4_HY_TAIL - 3, R4_VT_TAIL - 0.1, longStay, clk(NOW));
    expect(starved.phase).toBe("reentry"); // laddered walk, never the snap
    const live = computeR4(dial({ targetRung: 5, pillarsLive: true }), R4_HY_TAIL - 3, R4_VT_TAIL - 0.1, longStay, clk(NOW));
    expect(live.phase).toBe("equity"); // control: a live receded close still snaps
  });

  it("laddered re-entry: cash→reentry at rung 9, walks 1 rung/close toward the target", () => {
    const cash: R4State = { phase: "cash", entryFiredAt: daysAgo(2), reentryRung: null };
    const target = dial({ targetRung: 5 });
    // exit close → reentry seeded at the most-defensive rung
    const e = computeR4(target, R4_HY_TAIL, R4_VT_TAIL, cash, clk(NOW));
    expect(e.phase).toBe("reentry");
    expect(e.reentryRung).toBe(R4_REENTRY_START); // 9

    // subsequent calm closes walk 9 → 8 → 7 → 6, then reaching target 5 completes → equity
    const seen: (number | null)[] = [];
    let prior: R4State = { phase: e.phase, entryFiredAt: e.entryFiredAt, reentryRung: e.reentryRung };
    for (let i = 0; i < 5; i++) {
      const r = computeR4(target, R4_HY_TAIL - 1, calmVt, prior, clk(NOW));
      seen.push(r.reentryRung);
      prior = { phase: r.phase, entryFiredAt: r.entryFiredAt, reentryRung: r.reentryRung };
      if (r.phase === "equity") break;
    }
    expect(seen).toEqual([8, 7, 6, null]); // 1-rung steps, then equity (null) on reaching 5
  });

  it("20-day ratchet boundary (calendar days): 19d walks, 20d snaps; snap gated off when targetRung ≥ 7", () => {
    const receded = dial({ targetRung: 5 }); // exitCond via rung, snap-eligible
    const at19 = computeR4(receded, R4_HY_TAIL, R4_VT_TAIL, { phase: "cash", entryFiredAt: daysAgo(19), reentryRung: null }, clk(NOW));
    expect(at19.phase).toBe("reentry"); // 19 < 20 → still walks

    const at20 = computeR4(receded, R4_HY_TAIL, R4_VT_TAIL, { phase: "cash", entryFiredAt: daysAgo(20), reentryRung: null }, clk(NOW));
    expect(at20.phase).toBe("equity"); // 20 ≥ 20 AND targetRung ≤ 6 → SNAP straight to target

    // gated off: long stay but dial still elevated (targetRung 7) → exit via tails-clear, no snap
    const stillHot = dial({ targetRung: 7 });
    const gated = computeR4(stillHot, R4_HY_TAIL - 3, R4_VT_TAIL - 0.1, { phase: "cash", entryFiredAt: daysAgo(25), reentryRung: null }, clk(NOW));
    expect(gated.phase).toBe("reentry"); // never accelerates while targetRung ≥ 7
    expect(gated.cash).toBe(false);
  });
});
