import { describe, expect, it } from "vitest";
// Extensionless on purpose — a plain `.js` test file must NOT use a `.js` specifier for a TS module
// (frontend.md §"A `public/*.test.js` importing a TS module must NOT use a `.js` specifier").
import { computeT1Dial } from "../src/t1dial";
import { armFireClause, estPushTag, HEADLINE_TAIL_SEP } from "./dial-headline.js";

/** One family panel in the shape `computeT1Dial` reads. Trend seeds a GT member because the dial
 *  reads trend's band depth from GT/GB members only (mirrors src/t1dial.test.ts's `panel`). */
function panel(key, state) {
  const CONTRIB = { GREEN: 0, AMBER: 0.5, RED: 1 };
  const members = key === "trend" ? [{ id: "GT", label: "GT", state }] : [];
  return {
    key,
    label: key,
    state,
    live: true,
    firing: state !== "GREEN",
    contribution: CONTRIB[state],
    members,
  };
}

/** The 4 leading+coincident families, GREEN unless overridden. */
function build(overrides = {}) {
  return ["credit", "rates", "volatility", "trend"].map((k) =>
    panel(k, overrides[k] ?? "GREEN"),
  );
}

/** build() + cross-asset — the shock override needs volatility+cross-asset+trend. */
function buildXa(overrides, xa) {
  return [...build(overrides), panel("cross-asset", xa)];
}

describe("armFireClause - the /lab board head's slice of t1dial.headline (E11)", () => {
  // The anti-mirror pin: the expectation is DERIVED from the real producer, not hand-typed, so a
  // change to `t1dial.ts`'s headline template cannot leave this seam silently slicing the wrong
  // thing.
  // This is ALSO the separator contract's only pin — `dial-headline.js` depends on ` → ` appearing
  // exactly once in a real headline, and nothing else in the suite asserts that.
  it("slices a REAL computed headline at the separator, keeping the whole arm/fire clause", () => {
    const d = computeT1Dial(build({ credit: "AMBER" }));
    const parts = d.headline.split(HEADLINE_TAIL_SEP);
    expect(parts).toHaveLength(2); // exactly one separator — the contract the seam relies on
    expect(armFireClause(d.headline)).toBe(parts[0]);
    // What the board must NOT paint: the regime/rung tail, already shown by `.board-head`.
    expect(armFireClause(d.headline)).not.toContain(HEADLINE_TAIL_SEP.trim());
    expect(armFireClause(d.headline)).not.toContain(String(d.targetRung));
    // Anti-vacuity: pin the PRIMED shape, not the substring "primed" — "unprimed" contains "primed",
    // so a fixture that silently stopped arming would satisfy every other assertion here.
    expect(armFireClause(d.headline)).toMatch(/^primed \(credit\)/);
  });

  // The `+ shock` branch appends AFTER the arm/fire clause and BEFORE the separator, so a template
  // edit introducing a second arrow inside it would be invisible to case 1's single-leader fixture.
  it("keeps the shock suffix, and still finds exactly one separator, on a shock-override headline", () => {
    const d = computeT1Dial(buildXa({ volatility: "RED", trend: "RED" }, "RED"));
    expect(d.shockOverride).toBe(true); // the branch under test is actually reached
    expect(d.headline.split(HEADLINE_TAIL_SEP)).toHaveLength(2);
    expect(armFireClause(d.headline)).toContain("+ shock");
    expect(armFireClause(d.headline)).not.toContain(String(d.targetRung));
  });

  // Rule 2 — the HYDRATION exposure. `api/lab.ts` serves `t1dial` hydrated from the persisted
  // `alert_log.dial_state`, so a live row can carry a tail built by an older template whose arrow
  // differs. Keying on the tail's grammar (`<Regime>, rung <n>`) instead of the glyph keeps such a
  // row from painting the tail this rung exists to drop.
  it("strips a tail whose arrow this deploy does not use - a headline persisted by an older template", () => {
    expect(armFireClause("primed (credit) + unfired => Caution, rung 4")).toBe(
      "primed (credit) + unfired",
    );
    expect(armFireClause("unprimed + unfired -> Calm, rung 1")).toBe("unprimed + unfired");
    // No arrow at all still strips, and every regime label in the union is covered.
    expect(armFireClause("primed (rates) + fired (trend) Crisis, rung 9")).toBe(
      "primed (rates) + fired (trend)",
    );
    expect(armFireClause("unprimed + unfired Stress, rung 6")).toBe("unprimed + unfired");
  });

  it("returns a string matching NEITHER rule WHOLE, not empty - the template-drift fallback", () => {
    expect(armFireClause("primed (credit) + unfired")).toBe("primed (credit) + unfired");
  });

  it("returns '' for a missing headline so the caller keeps its bare firing count", () => {
    expect(armFireClause(undefined)).toBe("");
    expect(armFireClause("")).toBe("");
  });
});

describe("estPushTag - E14 display-vs-notify divergence tag", () => {
  const lab = (display, notify, level = "WATCH") => ({
    t1dial: { regime: display },
    ...(notify ? { band: { level, chain: { regime: notify } } } : {}),
  });
  it("tags EST + the pushed band when the display regime differs from the notify regime", () => {
    expect(estPushTag(lab("Stress", "Caution", "WATCH"))).toBe("EST · push band: WATCH");
  });
  it("is silent when the regimes agree (incl. a legacy display-null row) or `band` is absent", () => {
    expect(estPushTag(lab("Caution", "Caution"))).toBe("");
    expect(estPushTag(lab("Stress", undefined))).toBe("");
  });
});
