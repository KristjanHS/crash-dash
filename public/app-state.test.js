// Pure-logic unit tests for the app.js state container + stale-continuation
// guard helpers (D12 Stage 1). Plain `.js` so vitest's default glob collects it
// while `tsc` ignores it — no jsdom needed (the DOM render is covered by the
// Playwright harness). Mirrors format.test.js.
import { describe, it, expect } from "vitest";
import { createState, guardToken, isCurrent } from "./app-state.js";

describe("createState / setState", () => {
  it("top-level setState(patch) shallow-merges, leaving other keys alone", () => {
    const { state, setState } = createState({ familyOrder: [], ladderConfig: null });
    const families = [{ key: "credit" }];
    setState({ familyOrder: families });
    expect(state.familyOrder).toBe(families); // assigned as-is, no clone
    expect(state.ladderConfig).toBeNull(); // untouched
    setState({ ladderConfig: { alertRank: ["OK"] } });
    expect(state.familyOrder).toBe(families); // still untouched
    expect(state.ladderConfig).toEqual({ alertRank: ["OK"] });
  });

  it("slice setState('slice', patch) shallow-merges into the slice only", () => {
    const { state, setState } = createState({
      zoneD: { tab: "ladder", ladderLimit: 90, indicatorId: null },
      zoneC: { view: "grid" },
    });
    setState("zoneD", { tab: "detail", indicatorId: "F1" });
    expect(state.zoneD).toEqual({ tab: "detail", ladderLimit: 90, indicatorId: "F1" });
    expect(state.zoneC).toEqual({ view: "grid" }); // sibling slice untouched
  });

  it("slice form throws on a non-object slice (typo guard - no silent state creation)", () => {
    const { setState } = createState({ ladderConfig: null });
    expect(() => setState("ladderConfig", { x: 1 })).toThrow(TypeError);
    expect(() => setState("zoneZ", { x: 1 })).toThrow(TypeError);
  });

});

describe("guardToken / isCurrent", () => {
  it("captures top-level and slice-level fields; current until a captured field changes", () => {
    const { state, setState } = createState({ zoneD: { tab: "ladder", ladderLimit: 90 } });
    const token = guardToken(state, ["zoneD.tab", "zoneD.ladderLimit"]);
    expect(isCurrent(state, token)).toBe(true);
    setState("zoneD", { ladderLimit: 365 });
    expect(isCurrent(state, token)).toBe(false); // one drifted field is enough
  });

  it("ignores fields NOT captured in the token (same compound-guard scoping as today)", () => {
    const { state, setState } = createState({ zoneD: { tab: "bubble", indicatorId: null } });
    const token = guardToken(state, ["zoneD.tab"]);
    setState("zoneD", { indicatorId: "F4" }); // not a guarded field
    expect(isCurrent(state, token)).toBe(true);
  });

  it("lastView guard is object IDENTITY, never deep-equal", () => {
    const view = { verdict: "OK" };
    const { state, setState } = createState({ lastView: view });
    const token = guardToken(state, ["lastView"]);
    expect(isCurrent(state, token)).toBe(true);
    setState({ lastView: { verdict: "OK" } }); // deep-equal but a NEW object
    expect(isCurrent(state, token)).toBe(false); // identity compare: stale
  });

  it("interleaving: mutate away → stale; mutate back → current again", () => {
    // Intentional semantics, preserved from today's hand-rolled field-equality
    // guards: tab away and back before a slow fetch settles, and the late
    // continuation is treated as current again (it revalidates) — the guards
    // compare field values, not generation counters.
    const { state, setState } = createState({ zoneD: { tab: "detail", indicatorId: "F1" } });
    const token = guardToken(state, ["zoneD.tab", "zoneD.indicatorId"]);
    setState("zoneD", { tab: "ladder", indicatorId: null }); // user tabs away mid-await
    expect(isCurrent(state, token)).toBe(false);
    setState("zoneD", { tab: "detail", indicatorId: "F1" }); // …and back
    expect(isCurrent(state, token)).toBe(true);
  });

  it("token is frozen (a captured snapshot can never be edited to pass)", () => {
    const { state } = createState({ lastView: null });
    const token = guardToken(state, ["lastView"]);
    expect(Object.isFrozen(token)).toBe(true);
  });
});

describe("zoneD.window (detail window chips)", () => {
  it("rides the zoneD slice and the guard-token shallow-key set", () => {
    const { state, setState } = createState({ zoneD: { tab: "detail", window: null } });
    const token = guardToken(state, ["zoneD.window"]);
    expect(isCurrent(state, token)).toBe(true);
    setState("zoneD", { window: 63 });
    expect(state.zoneD.window).toBe(63);
    expect(isCurrent(state, token)).toBe(false);
  });
});
