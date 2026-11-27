import { describe, expect, test } from "vitest";
import { tailRoster, tailViolations } from "./probe-series-holes.js";
import { ANCHOR_ROSTER } from "../src/estimated.js";

describe("tailViolations", () => {
  test("an estimate past a missing/provisional previous session fails; a gap and an anchored estimate do not", () => {
    // F1: Wed 01-28 final, Thu estimated (anchored), Fri gap, Mon estimated (Fri has no final), Tue provisional, Wed estimated.
    const pts = [
      { date: "2026-01-28" },
      { date: "2026-01-29", estimated: true as const },
      { date: "2026-02-02", estimated: true as const },
      { date: "2026-02-03", provisional: true as const },
      { date: "2026-02-04", estimated: true as const },
    ];
    expect(tailViolations("F1", pts)).toEqual(["2026-02-02:estimate-without-2026-01-30-final", "2026-02-04:estimate-without-2026-02-03-final"]);
    // 01-19 is F4's source holiday: Tue 01-20's previous session is Fri 01-16.
    expect(tailViolations("F4", [{ date: "2026-01-16" }, { date: "2026-01-20", estimated: true as const }])).toEqual([]);
  });

  test("past a missing previous session: a provisional estimate is no violation; an EU leg's settled estimate and a US leg's are", () => {
    const gap = [{ date: "2026-01-28" }, { date: "2026-01-30", estimated: true as const }];
    expect(tailViolations("F1", [gap[0]!, { ...gap[1]!, provisional: true as const }])).toEqual([]);
    expect([tailViolations("LEGP_EUFIN", gap), tailViolations("LEGP_SEMIS", gap)]).toEqual([["2026-01-30:estimate-without-2026-01-29-final"], ["2026-01-30:estimate-without-2026-01-29-final"]]);
  });

  test("an id serving no row in the window is a violation, not a vacuous pass", () => {
    expect(tailViolations("F1", [])).toEqual(["empty-series"]);
  });
});

describe("tailRoster", () => {
  test("covers ALL of ANCHOR_ROSTER — the chained-only ids (LEGP_VALUE + the SB NAV pair) are served, nothing is unserved", () => {
    const { served, unserved } = tailRoster();
    expect(served).toEqual(expect.arrayContaining(["F1", "LEGP_EUFIN", "LEGP_VALUE", "SB_STRAT", "SB_BENCH"]));
    expect([...served, ...unserved].sort()).toEqual([...ANCHOR_ROSTER].sort());
    expect(unserved).toEqual([]);
  });
});
