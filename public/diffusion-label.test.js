// IS-7 Stage 2 — PARITY pin: the `/lab` seam (`public/diffusion-label.js`) must render the
// member-level diffusion count byte-identically to the formatter of record
// (`diffusionLabel`, src/families.ts) that the push body renders from. A hand-copied expectation
// would guard only one direction, so every case asserts seam === TS first; the literal pins that
// follow exist so a SYNCHRONISED drift (both sides edited together) still reds.
//
// ⚠ `.ts` specifier on purpose (frontend.md): a `.js` specifier in a `public/*.test.js` resolves
// literally, fails to load, and the suite reports "no tests" — a collection error, not a failure.
import { describe, expect, it } from "vitest";
import { diffusionLabel } from "../src/families.ts";
import { STATE_RANK } from "../src/domain-types.ts";
import { diffusionText } from "./diffusion-label.js";

// I2 — the state-union guard. The TS formatter asks `STATE_RANK[m.state] >= STATE_RANK.AMBER`;
// the browser twin cannot import `STATE_RANK` and hardcodes `"AMBER" || "RED"` (and `=== "RED"`
// for the red count), so a FOURTH `State` value would diverge silently forever — `public/**` is
// outside `tsc`, so `npm run check` stays green. This list is DERIVED from `STATE_RANK`, whose
// type is `Record<State, number>` (src/domain-types.ts): widening `State` without adding the rank
// entry is already a tsc error in `src/`, so these keys ARE the union at runtime. The compile-time
// half of the guard cannot live in a `.js` file (tsc has `allowJs` off and never reads this file);
// it is the `UncoveredState` block in `src/families.test.ts`.
const STATE_VALUES = Object.keys(STATE_RANK);

const m = (id, state) => ({ id, label: id, state });
/** …and the same with the registry's `geoFactor` tag attached (R2 — the collapse-by-factor cases). */
const mf = (id, state, factor) => ({ id, label: id, state, factor });

/** Shared case table — one fixture, both surfaces. `expected` is the byte-exact string. */
const CASES = [
  {
    name: "0 red / 0 elevated, absent === 0 (no dark suffix)",
    panel: { key: "trend", members: [m("a", "GREEN"), m("b", "GREEN"), m("c", "GREEN")], absent: 0 },
    expected: "0 red / 0 elevated of 3",
  },
  {
    name: "red === elevated (every firing member is RED)",
    panel: { key: "credit", members: [m("a", "RED"), m("b", "RED"), m("c", "GREEN")], absent: 0 },
    expected: "2 red / 2 elevated of 3",
  },
  {
    name: "red < elevated - the nested pair, AMBER counted as elevated only",
    panel: {
      key: "credit",
      members: [m("a", "RED"), m("b", "AMBER"), m("c", "AMBER"), m("d", "GREEN")],
      absent: 0,
    },
    expected: "1 red / 3 elevated of 4",
  },
  {
    name: "absent > 0 - the shrink is stated, not silent",
    panel: { key: "credit", members: [m("a", "RED"), m("b", "AMBER")], absent: 2 },
    expected: "1 red / 2 elevated of 2 (2 dark)",
  },
  {
    name: "single-member family",
    panel: { key: "vol", members: [m("a", "AMBER")], absent: 0 },
    expected: "0 red / 1 elevated of 1",
  },
  {
    // `gp` holds three reads of ONE oil factor. Counting members printed `2 red / 3 elevated of 3`
    // — a breadth claim asserting
    // three independent signals agree. Both surfaces must collapse per factor.
    name: "three reads of ONE factor collapse to one signal (gp's oil trio)",
    panel: {
      key: "gp",
      members: [mf("G1", "RED", "oil"), mf("BRENT", "RED", "oil"), mf("OVX", "AMBER", "oil")],
      absent: 0,
    },
    expected: "1 red / 1 elevated of 1",
  },
  {
    // The fallback half: an UNTAGGED member counts as its own factor, so it can only ever be as
    // loud as before — never silently folded into a tagged neighbour.
    name: "tagged trio beside an untagged member - the untagged one is its own factor",
    panel: {
      key: "gp",
      members: [mf("G1", "RED", "oil"), mf("BRENT", "AMBER", "oil"), m("GT", "AMBER")],
      absent: 1,
    },
    expected: "1 red / 2 elevated of 2 (1 dark)",
  },
  {
    name: "zero-member family - reachable via applyFamilyCarry (live+firing, members: [])",
    panel: { key: "credit", members: [], absent: 6 },
    expected: "no members reporting (6 dark)",
  },
  {
    name: "zero-member family with absent 0 - no suffix, still no fabricated calm",
    panel: { key: "stub", members: [], absent: 0 },
    expected: "no members reporting",
  },
];

describe("diffusionText (public seam) === diffusionLabel (src/families.ts)", () => {
  for (const c of CASES) {
    it(`is byte-identical: ${c.name}`, () => {
      // Parity FIRST — this is the assertion the stage exists for.
      expect(diffusionText(c.panel)).toBe(diffusionLabel(c.panel));
      // …and both are the string §17.1/§17.2 ruled, so a synchronised drift also reds.
      expect(diffusionText(c.panel)).toBe(c.expected);
      expect(diffusionLabel(c.panel)).toBe(c.expected);
    });
  }

  // --- I2: the case table must SPAN the state union, and both predicates must hold on it -----

  it("every State value appears in at least one fixture panel", () => {
    // Adding a 4th state REDS this until a case is written for it — without this the table could
    // silently stop covering the union while every case above stays green.
    expect(STATE_VALUES.length).toBeGreaterThan(0); // vacuity: an empty union would pass the loop
    const seen = new Set(CASES.flatMap((c) => c.panel.members.map((mm) => mm.state)));
    for (const s of STATE_VALUES) expect([...seen], `State "${s}" is in no fixture panel`).toContain(s);
  });

  for (const s of STATE_VALUES) {
    it(`both predicates (elevated AND red) agree across the seam for state ${s}`, () => {
      // One member at `s` beside a GREEN one, so the state moves BOTH counts independently of the
      // denominator. A new state ranked amber-or-worse (or RED-equivalent) that the twin's
      // hardcoded literals don't know about makes these two strings differ.
      const panel = { key: "credit", members: [m("x", s), m("y", "GREEN")], absent: 1 };
      expect(diffusionText(panel)).toBe(diffusionLabel(panel));
      // Non-vacuity: the shared string really does carry both numbers and the dark clause.
      expect(diffusionText(panel)).toMatch(/^\d+ red \/ \d+ elevated of 2 \(1 dark\)$/);
    });
  }

  // --- N5: a served payload with NO `absent` field (a cached response spanning the deploy) ----

  it("renders a MISSING `absent` as unknown, never as calm", () => {
    // `(? dark)`, not a silent full-looking denominator: defaulting to 0 would print `of 2` with
    // no shrink clause — the "denominator shrinks without saying so" behaviour §17.2 forbids.
    // Seam-only: `FamilyPanel.absent` is required, so `diffusionLabel` cannot be handed this.
    const missing = { key: "credit", members: [m("a", "RED"), m("b", "AMBER")] };
    expect(diffusionText(missing)).toBe("1 red / 2 elevated of 2 (? dark)");
    expect(diffusionText({ key: "credit", members: [] })).toBe("no members reporting (? dark)");
    // …and the SAME panel with `absent` present is still byte-identical to the TS formatter.
    const present = { ...missing, absent: 0 };
    expect(diffusionText(present)).toBe(diffusionLabel(present));
  });

  it("never prints a pair that reads as two independent populations (elevated >= red)", () => {
    // Non-vacuity guard for the nested-pair rule: the table must actually CONTAIN a case where
    // the two numbers differ, or the invariant would hold for an unrelated reason.
    const pairs = CASES.map((c) => /^(\d+) red \/ (\d+) elevated/.exec(c.expected))
      .filter(Boolean)
      .map((mm) => [Number(mm[1]), Number(mm[2])]);
    expect(pairs.some(([red, elev]) => elev > red)).toBe(true);
    for (const [red, elev] of pairs) expect(elev).toBeGreaterThanOrEqual(red);
  });
});
