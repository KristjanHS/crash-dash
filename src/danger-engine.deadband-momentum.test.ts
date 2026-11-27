import { describe, it, expect } from "vitest";
import type { State } from "./domain-types.js";
import {
  pillarValue,
  computeField,
  EW_ROC_LOOKBACK,
  DANGER_CUTS,
  LOOKBACK,
  SN_ROC_LOOKBACK,
  type DangerInput,
  type MemberHistoryEntry,
} from "./danger-engine.js";
import {
  LEG_SENSITIVITY,
  MEMBER_WEIGHT,
  signalHoldClosesFor,
  type LegKey,
} from "./danger-ladder.js";
import { reriskDeadbandOf } from "./danger-deadband.js";
import { gf } from "./danger-engine.test-helpers.js";

// Hoisted all-GREEN calm windows (Rung-3 fixture hoist): deterministic and never mutated by any
// consumer — buildMemberStateAt/HeldAt read history entries only (verified 2026-09-20) — so each is
// built once here instead of rebuilt inside every test that seeds a fully-calm window.
const greenWindow = (len: number): MemberHistoryEntry[] =>
  Object.keys(MEMBER_WEIGHT).map((id) => ({
    id,
    history: Array.from({ length: len }, (_, i) => ({
      date: `d${String(i).padStart(2, "0")}`,
      value: 0,
      delta20: 0,
      rawState: "GREEN" as State,
      state: "GREEN" as State,
    })),
  }));
const SN_DEPTH = 10; // snRoc describe window depth (single source; consumed as `const N = SN_DEPTH`)
const GREEN_CLAMP_WINDOW = greenWindow(LOOKBACK + 1);
const GREEN_SN_WINDOW = greenWindow(SN_DEPTH);
const EW_DEPTH = 2 * EW_ROC_LOOKBACK; // > EW_ROC_LOOKBACK ⇒ the t−20 base is observed
const GREEN_EW_WINDOW = greenWindow(EW_DEPTH);

describe("computeField - directional deadband anti-whipsaw (the live-complacency fix)", () => {
  // The reported bug: a SINGLE volatility-family member amber rotated the calm-band hold off Semis
  // onto EM. The family-leg weights are vl Semis 1.0 / EM 0.8 (FINAL Stage-4.2); the driving member
  // here is VT (VIX-term), member-weight Semis 0.6 / EM 0.6 / S&P IT 1.0 — EM is merely blind to the
  // tech-niche signal, not safer. (Fixtures were repointed complacency-high → VT on 2026-07-20 when
  // `FAMILY_MEMBERS` moved onto DIAL_FAMILIES, which excludes the display-only SLOW complacency ids.)
  const band = { lo: 1, hi: 3, label: "aggressive" };

  it("RISING/cold-start - one complacency AMBER DOES rotate to the calmest EM (DERISK_DEADBAND 0)", () => {
    // No prior target ⇒ RISING ⇒ deadband 0 ⇒ held = strict calmest = EM (the P1 de-risk-fast fix;
    // even a marginal 0.122 gap rotates when danger is rising). Subsumes the RED half of Stage 2.1's
    // RISING branch: deadband 0 is strict calmest before severity can reach any branch.
    const { held } = computeField(gf([{ id: "VT", state: "AMBER" }]), band);
    expect(held?.sleeve).toBe("EM");
  });

  it("FALLING - ex-US→EU-Fin gap ≥ reriskDeadbandOf(DANGER_CUTS) rotates to EU-Fin; a gap just below holds ex-US", () => {
    const pair = { lo: 6, hi: 7 };
    const falling = (members: { id: string; state: State }[]) => {
      const f = computeField(gf(members), pair, undefined, pair.hi + 1, undefined, undefined, undefined, undefined, pair.hi);
      const own = (s: string) => f.legRows.find((r) => r.sleeve === s)!;
      const scaled = (s: string) => LEG_SENSITIVITY[s as LegKey] * own(s).danger;
      const conc = own("ex-US").concentrated || own("EU-Fin").concentrated;
      return { held: f.held?.sleeve, gap: scaled("ex-US") - scaled("EU-Fin"), conc };
    };
    const db = reriskDeadbandOf(DANGER_CUTS);
    const wide = falling([{ id: "F1", state: "AMBER" }, { id: "F9", state: "RED" }]);
    const narrow = falling([{ id: "F1", state: "RED" }]);
    // premise: no #R2 bump, and the two gaps straddle the deadband
    expect([wide.conc, narrow.conc, wide.gap >= db, narrow.gap > 0 && narrow.gap < db]).toEqual([false, false, true, true]);
    expect([wide.held, narrow.held]).toEqual(["EU-Fin", "ex-US"]);
  });
});

describe("computeField - empty in-band guard", () => {
  it("returns held=null (never throws) when no leg's risk falls in the band", () => {
    const d = gf([{ id: "F1", state: "RED" }]);
    const call = () => computeField(d, { lo: 10, hi: 12 });
    expect(call().held).toBeNull();
  });
});

describe("computeField - momentum is opt-in (only when memberHistory is passed)", () => {
  const d = gf([{ id: "F1", state: "RED" }]);
  const band = { lo: 1, hi: 3 };

  it("omits momentum when no history window is supplied", () => {
    const { legRows } = computeField(d, band);
    expect(legRows.every((l) => l.momentum === undefined)).toBe(true);
  });

  it("computes momentum from t−LOOKBACK when history is supplied", () => {
    // All-GREEN t−LOOKBACK ⇒ share danger 0 there, so momentum = √danger / √DANGER_CUTS.amber.
    const panel = gf(Object.keys(MEMBER_WEIGHT).map((id) => ({ id, state: (id === "F1" ? "AMBER" : "GREEN") as State })));
    const semis = computeField(panel, band, GREEN_CLAMP_WINDOW).legRows.find((l) => l.sleeve === "Semis")!;
    const expected = Math.sqrt(semis.danger) / Math.sqrt(DANGER_CUTS.amber);
    expect(expected).toBeGreaterThan(0); // premise: lit, and inside the clamp
    expect(expected).toBeLessThan(1);
    expect(semis.momentum).toBeCloseTo(expected, 10);
  });

  // The `Math.max(-1, Math.min(1, …))` clamp, on a fixture that genuinely reaches it. Added 2026-07-16:
  // the sibling above was renamed `computes clamped momentum` → `computes momentum` when the Slice 1.2
  // m₁² rescale dropped its ROC under 1, and NO test replaced the lost clamp coverage.
  //
  // Fixture: VT + CG RED alone ⇒ Semis SN share 1; the unclamped-ROC vacuity guards catch a stranding retune.
  const clampFixture = [
    { id: "VT", state: "RED" as State },
    { id: "CG", state: "RED" as State },
  ];
  const seedAll = (pattern: (id: string) => State): MemberHistoryEntry[] =>
    Object.keys(MEMBER_WEIGHT).map((id) => ({
      id,
      history: Array.from({ length: LOOKBACK + 1 }, (_, i) => {
        const st = pattern(id);
        return { date: `d${String(i).padStart(2, "0")}`, value: 0, delta20: 0, rawState: st, state: st };
      }),
    }));

  it("clamps momentum at +1 when severity rises by more than one band width over the window", () => {
    // Calm at t−20 ⇒ raw ROC ≈ +1.22 ⇒ clamped to exactly 1. Vacuity guard first: without it a
    // fixture that quietly stopped reaching the clamp would still pass a `<= 1` assertion.
    const { legRows } = computeField(gf(clampFixture), { lo: 1, hi: 3 }, GREEN_CLAMP_WINDOW);
    const semis = legRows.find((l) => l.sleeve === "Semis")!;
    // the UNCLAMPED severity-space ROC really is out of range
    expect(Math.sqrt(semis.danger) / Math.sqrt(DANGER_CUTS.amber)).toBeGreaterThan(1);
    expect(semis.momentum).toBe(1);
  });

  it("clamps momentum at −1 when severity falls by more than one band width over the window", () => {
    // The mirror: every member RED at t−LOOKBACK (share danger 1), calm now ⇒ raw ROC = −1/√amber ⇒ −1.
    // A one-sided clamp (`Math.min(1, …)` alone) passes the +1 test above and fails here.
    const { legRows } = computeField(gf([]), { lo: 1, hi: 3 }, seedAll(() => "RED"));
    const semis = legRows.find((l) => l.sleeve === "Semis")!;
    expect(semis.danger).toBe(0); // calm now…
    expect(1 / Math.sqrt(DANGER_CUTS.amber)).toBeGreaterThan(1); // …the unclamped ROC is out of range
    expect(semis.momentum).toBe(-1);
  });
});

describe("computeField - snRoc: raw STRESS-NOW delta over 5 closes (ledger idiom item 5)", () => {
  const band = { lo: 1, hi: 9 };
  // Depth 10 ≥ SN_ROC_LOOKBACK+1 ⇒ the t−5 base is observed.
  const N = SN_DEPTH;
  const seed = (pattern: (id: string, i: number) => State, len = N): MemberHistoryEntry[] =>
    Object.keys(MEMBER_WEIGHT).map((id) => ({
      id,
      history: Array.from({ length: len }, (_, i) => {
        const st = pattern(id, i);
        return { date: `d${String(i).padStart(2, "0")}`, value: 0, delta20: 0, rawState: st, state: st };
      }),
    }));
  const spxRow = (d: DangerInput, h?: MemberHistoryEntry[]) =>
    computeField(d, band, undefined, null, h).legRows.find((l) => l.sleeve === "S&P 500")!;

  it("rising SN (calm at t−5, R5+DISP RED now) ⇒ snRoc > 0 and EXACTLY stressNow − 0 (raw units, no divisor)", () => {
    const row = spxRow(
      gf([{ id: "R5", state: "RED" }, { id: "DISP", state: "RED" }]),
      GREEN_SN_WINDOW, // whole window calm ⇒ SN at t−5 = 0
    );
    expect(pillarValue(row.subDangers.stressNow)).toBeGreaterThan(0);
    // Raw-unit contract the FE cuts (|snRoc| ≥ 0.02/0.05/0.10) rely on: no normaliser and no
    // severity-space re-expression — the delta from a calm t−5 is the full current stressNow,
    // in raw SN units (≠ `momentum`, which is severity-space and band-normalised).
    expect(row.snRoc).toBeCloseTo(pillarValue(row.subDangers.stressNow)!, 10);
  });

  it("flat SN (same AMBER severities at t−5 and t) ⇒ snRoc exactly 0", () => {
    const row = spxRow(
      gf([{ id: "R5", state: "AMBER" }, { id: "DISP", state: "AMBER" }]),
      seed((id) => (id === "R5" || id === "DISP" ? "AMBER" : "GREEN")),
    );
    expect(row.snRoc).toBe(0);
  });

  it("FLAT non-zero SN at every observed depth ⇒ snRoc exactly 0 (the share arm has no regime band)", () => {
    const flat = (len: number) =>
      spxRow(
        gf([{ id: "R5", state: "AMBER" }, { id: "DISP", state: "AMBER" }]),
        seed((id) => (id === "R5" || id === "DISP" ? "AMBER" : "GREEN"), len),
      );
    expect(pillarValue(flat(N).subDangers.stressNow)).toBeGreaterThan(0); // vacuity guard: SN is genuinely lit
    for (const len of [SN_ROC_LOOKBACK + 1, 2 * N, 4 * N]) expect(flat(len).snRoc).toBe(0); // shallowest observed base → deep
  });

  // Depth of close `i` in a `seed(...)` window of length `N` — index N−1 is t, so depth = N−1−i.
  const depthOfClose = (i: number, len = N) => len - 1 - i;
  // R5/DISP are both `coin` ⇒ hold 3 (read through `signalHoldClosesFor`, never typed).
  const SN_HOLD = Math.max(signalHoldClosesFor("R5"), signalHoldClosesFor("DISP"));

  it("falling SN (RED at t−5, COOLED across the whole hold window) ⇒ snRoc < 0", () => {
    // RE-PINNED for `SIGNAL_HOLD_CLOSES` (Stage 2.1): the t-side member state is now the HELD map, so a fire
    // anywhere in a member's hold window keeps the pillar lit at t. The old fixture was RED at EVERY
    // close (including t) and only the empty PANEL made it "calm now" — the hold resurrects those
    // closes, so it now reads exactly 0. A genuine negative delta needs the fire pushed OUTSIDE the
    // window: RED from t−5 back, GREEN across t … t−(SN_HOLD−1).
    expect(SN_HOLD).toBeLessThan(SN_ROC_LOOKBACK); // …only observable while the hold is the shorter of the two
    const row = spxRow(
      gf([]),
      seed((id, i) =>
        (id === "R5" || id === "DISP") && depthOfClose(i) >= SN_ROC_LOOKBACK ? "RED" : "GREEN",
      ),
    );
    expect(row.snRoc).toBeLessThan(0);
  });

  it("…but a re-fire INSIDE the hold window (RED at t−5 AND t−2) ⇒ snRoc exactly 0 (SIGNAL_HOLD_CLOSES)", () => {
    // The companion that makes the pair discriminating rather than a one-sided re-pin: same t−5 fire,
    // plus a re-fire running back from t−1 to depth SN_HOLD−1 — the last close the hold still reaches.
    // The held map is lit at BOTH ends of the delta, so the arrow correctly reads flat.
    //
    // RE-SHAPED for arm C: the re-fire used to
    // sit at depth SN_HOLD−1 ALONE, with GREEN prints between it and t. The hold now RELEASES on an
    // observed recovery, so a green print at t−1 would truncate the walk before that fire ever came
    // into reach. The fire therefore stays at SN_HOLD−1 — the LAST close the window reaches, which is
    // what makes this test window-boundary sensitive — and the closes between it and t are made
    // ABSENT instead of GREEN. Silence is spanned, contradiction is not, so the walk still arrives.
    //
    // ⚠ The intermediate closes MUST be absent rather than RED (the review's finding: an unbroken RED
    // run reaches the fire from every shorter window too, so nothing pins the boundary). Shorten the
    // WINDOW by one at `signalHoldWindowOf` — `Math.max(signalHoldClosesFor(id) - 1, 1)`, the mutation that moves
    // the window without moving this fixture, which derives its depths from the same table — and t
    // sees its own GREEN close plus holes only ⇒ this goes negative. Remove the hold entirely and
    // `sn.live` is false at t (empty panel) ⇒ `undefined`. The guard below keeps the absent range
    // well-formed at the shortest window that reaches this branch at all.
    expect(SN_HOLD).toBeGreaterThan(1);
    const hist = seed((id, i) =>
      (id === "R5" || id === "DISP") &&
      (depthOfClose(i) >= SN_ROC_LOOKBACK || depthOfClose(i) === SN_HOLD - 1)
        ? "RED"
        : "GREEN",
    );
    // The holes model the `!pt` branch of `heldFoldMap` — the depths at which the member did not
    // report — exactly as the "SPANS an absent close" pin does.
    for (const e of hist)
      if (e.id === "R5" || e.id === "DISP")
        for (let dep = 1; dep <= SN_HOLD - 2; dep++) delete e.history[e.history.length - 1 - dep];
    const row = spxRow(gf([]), hist);
    expect(row.snRoc).toBe(0);
  });

  it("cold start (history depth < SN_ROC_LOOKBACK+1) ⇒ snRoc OMITTED, never a spurious spike", () => {
    // Fresh deploy / new member set: only 3 stored closes, so the t−5 snapshot would be
    // IMPUTED calm — the old behavior emitted snRoc ≈ stressNow(t), a false level-3
    // "stress spiking" arrow. The fix suppresses the field until depth ≥ SN_ROC_LOOKBACK+1.
    const row = spxRow(
      gf([{ id: "R5", state: "RED" }, { id: "DISP", state: "RED" }]),
      seed(() => "GREEN", SN_ROC_LOOKBACK - 2), // depth 3 < 6 observed closes
    );
    expect(pillarValue(row.subDangers.stressNow)).toBeGreaterThan(0); // SN is genuinely live NOW
    expect(row.snRoc).toBeUndefined(); // …but the t−5 base is imputed ⇒ no arrow
  });

  it("EW at the SAME depth is cold-start-suppressed - the 20-close guard is not SN's 5", () => {
    // Guards the generalization itself: this describe's N=10 window is deep enough for snRoc
    // (>5) but NOT for ewRoc (>20). A guard that ignored its lookback arg would emit an
    // imputed-calm EW spike here while SN is legitimately live.
    const row = spxRow(gf([{ id: "F1", state: "RED" }]), GREEN_SN_WINDOW);
    expect(pillarValue(row.subDangers.earlyWarn)).toBeGreaterThan(0); // EW genuinely live NOW
    expect(row.ewRoc).toBeUndefined(); // …t−20 unreachable at depth 10 ⇒ no arrow
  });

  it("omitted without cissHistory (scenario path) - momentum's ?hist window alone does NOT enable it", () => {
    const d = gf([{ id: "R5", state: "RED" }]);
    expect(computeField(d, band).legRows.every((l) => l.snRoc === undefined)).toBe(true);
    const memberHistory: MemberHistoryEntry[] = [
      { id: "R5", history: [{ state: "GREEN" }] },
    ];
    const withHist = computeField(d, band, memberHistory);
    expect(withHist.legRows.every((l) => l.snRoc === undefined)).toBe(true);
    expect(withHist.legRows.some((l) => l.momentum !== undefined)).toBe(true); // ?hist momentum untouched
  });
});

describe("computeField - ewRoc: raw EARLY-WARN delta over 20 closes (D2.1)", () => {
  const band = { lo: 1, hi: 9 };
  const N = EW_DEPTH;
  const seed = (pattern: (id: string, i: number) => State, len = N): MemberHistoryEntry[] =>
    Object.keys(MEMBER_WEIGHT).map((id) => ({
      id,
      history: Array.from({ length: len }, (_, i) => {
        const st = pattern(id, i);
        return { date: `d${String(i).padStart(2, "0")}`, value: 0, delta20: 0, rawState: st, state: st };
      }),
    }));
  const spxRow = (d: DangerInput, h?: MemberHistoryEntry[]) =>
    computeField(d, band, undefined, null, h).legRows.find((l) => l.sleeve === "S&P 500")!;

  // F1 = credit (cr) ⇒ EARLY-WARN, the mirror of the snRoc block's R5/DISP (STRESS-NOW).
  it("rising EW (calm at t−20, F1 RED now) ⇒ ewRoc EXACTLY earlyWarn (raw units, no divisor)", () => {
    // R5/DISP lit too: SN gates on its OWN lookback, so snRoc still emits beside ewRoc.
    const row = spxRow(
      gf([{ id: "F1", state: "RED" }, { id: "R5", state: "RED" }, { id: "DISP", state: "RED" }]),
      GREEN_EW_WINDOW,
    );
    expect(pillarValue(row.subDangers.earlyWarn)).toBeGreaterThan(0);
    // Same raw-unit contract as snRoc — the FE applies SN_ROC_CUTS to BOTH pillars, which is
    // only sound because neither carries a divisor. A calm t−20 base ⇒ delta = full earlyWarn.
    expect(row.ewRoc).toBeCloseTo(pillarValue(row.subDangers.earlyWarn)!, 10);
    expect(row.snRoc).toBeGreaterThan(0);
  });

  it("FLAT EW at every observed depth (21-40) ⇒ ewRoc exactly 0 (the share arm has no regime band)", () => {
    const flat = (len: number) =>
      spxRow(gf([{ id: "F1", state: "AMBER" }]), seed((id) => (id === "F1" ? "AMBER" : "GREEN"), len));
    const atN = flat(N);
    expect(pillarValue(atN.subDangers.earlyWarn)).toBeGreaterThan(0); // vacuity guard: EW is genuinely lit
    for (const len of [EW_ROC_LOOKBACK + 1, N - 1]) expect(flat(len).ewRoc).toBe(0);
    expect(atN.ewRoc).toBe(0);
  });

  const depthOfClose = (i: number, len = N) => len - 1 - i;
  const EW_HOLD = signalHoldClosesFor("F1"); // `coin` ⇒ 3, read through the table, never typed

  it("falling EW (F1 RED at t−20, COOLED across the whole hold window) ⇒ ewRoc < 0", () => {
    // RE-PINNED for `SIGNAL_HOLD_CLOSES` (Stage 2.1) — the snRoc block's repair at EW's cadence. The old
    // fixture was F1 RED at every close and leaned on the empty PANEL for "calm now"; the held map
    // resurrects those closes, so it read exactly 0. Push the cooling outside the hold window.
    expect(EW_HOLD).toBeLessThan(EW_ROC_LOOKBACK);
    const row = spxRow(
      gf([]),
      seed((id, i) => (id === "F1" && depthOfClose(i) >= EW_ROC_LOOKBACK ? "RED" : "GREEN")),
    );
    expect(row.ewRoc).toBeLessThan(0);
  });

  it("…but a re-fire INSIDE the hold window (F1 RED at t−20 AND t−2) ⇒ ewRoc exactly 0 (SIGNAL_HOLD_CLOSES)", () => {
    // Companion to the falling case, so the pair discriminates instead of one-sidedly re-pinning:
    // the same t−20 fire plus a re-fire running back from t−1 to depth EW_HOLD−1, the last close the
    // hold still reaches. RE-SHAPED for arm C at EW's cadence — see the snRoc twin for the whole
    // argument: the fire stays at the window's LAST reachable depth (so shortening the window by one at
    // `signalHoldWindowOf` reds this test) and the closes between it and t are ABSENT, which the hold spans,
    // rather than
    // GREEN, which would release it, or RED, which would reach the fire from any window at all.
    expect(EW_HOLD).toBeGreaterThan(1);
    const hist = seed((id, i) =>
      id === "F1" && (depthOfClose(i) >= EW_ROC_LOOKBACK || depthOfClose(i) === EW_HOLD - 1)
        ? "RED"
        : "GREEN",
    );
    for (const e of hist)
      if (e.id === "F1")
        for (let dep = 1; dep <= EW_HOLD - 2; dep++) delete e.history[e.history.length - 1 - dep];
    const row = spxRow(gf([]), hist);
    expect(row.ewRoc).toBe(0);
  });

  it("omitted without cissHistory (scenario path) - parity with snRoc", () => {
    expect(computeField(gf([{ id: "F1", state: "RED" }]), band).legRows.every((l) => l.ewRoc === undefined)).toBe(
      true,
    );
  });
});
