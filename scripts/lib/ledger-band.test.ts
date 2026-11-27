import { describe, it, expect } from "vitest";
import { ledgerBand, bandChanges, formatBandChanges } from "./ledger-band.js";
import { DANGER_CUTS } from "../../src/danger-concentration.js";

describe("ledgerBand — danger at DANGER_CUTS", () => {
  it("is GREEN below the amber cut", () => {
    expect(ledgerBand(0)).toBe("GREEN");
    expect(ledgerBand(DANGER_CUTS.amber - 1e-9)).toBe("GREEN");
  });
  it("is AMBER at exactly the amber cut (inclusive) and up to just below red", () => {
    expect(ledgerBand(DANGER_CUTS.amber)).toBe("AMBER");
    expect(ledgerBand(DANGER_CUTS.red - 1e-9)).toBe("AMBER");
  });
  it("is RED at exactly the red cut (inclusive) and above", () => {
    expect(ledgerBand(DANGER_CUTS.red)).toBe("RED");
    expect(ledgerBand(1)).toBe("RED");
  });
  it("bands at passed cuts instead of DANGER_CUTS when given", () => {
    const cuts = { amber: DANGER_CUTS.red, red: (DANGER_CUTS.red + 1) / 2 };
    expect(ledgerBand(DANGER_CUTS.amber, cuts)).toBe("GREEN");
    expect(ledgerBand(cuts.red, cuts)).toBe("RED");
  });
});

describe("bandChanges + formatBandChanges — the --arm=diff summary line", () => {
  const before = [
    { sleeve: "Semis", ledgerBand: "RED" as const },
    { sleeve: "Value", ledgerBand: "AMBER" as const },
    { sleeve: "Cash", ledgerBand: "GREEN" as const },
  ];

  it("names every leg whose band moved, in the AFTER arm's order", () => {
    const after = [
      { sleeve: "Cash", ledgerBand: "GREEN" as const },
      { sleeve: "Semis", ledgerBand: "GREEN" as const },
      { sleeve: "Value", ledgerBand: "RED" as const },
    ];
    const changes = bandChanges(before, after);
    expect(changes).toEqual([
      { leg: "Semis", before: "RED", after: "GREEN" },
      { leg: "Value", before: "AMBER", after: "RED" },
    ]);
    expect(formatBandChanges(changes)).toBe("BAND CHANGE: Semis R → G, Value A → R");
  });

  it("prints `no band change` when every band held, and skips a leg absent from BEFORE", () => {
    const after = [...before, { sleeve: "EM", ledgerBand: "RED" as const }];
    expect(bandChanges(before, after)).toEqual([]);
    expect(formatBandChanges([])).toBe("no band change");
  });
});
