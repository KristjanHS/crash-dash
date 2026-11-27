import { describe, expect, test } from "vitest";
import { nonEwLead, verdict } from "./probe-defleg-live.js";

type Sub = { ew: number; sn: number; trend: number | null; gp: number | null };
const row = (sleeve: string, danger: number, s: Sub) => ({
  sleeve,
  danger,
  subDangers: { earlyWarn: { kind: "scored" as const, value: s.ew }, stressNow: { kind: "scored" as const, value: s.sn }, trend: s.trend, gp: s.gp },
});
const body = (h: ReturnType<typeof row>, st: ReturnType<typeof row>) => ({ asOf: "2026-11-06", field: { legRows: [h, st], held: { sleeve: "S&P 500" } } });

describe("probe:defleg-live verdict", () => {
  test("a trend term saturating both defensive legs is a by-design tie → INCONCLUSIVE, not FAIL (prod 2026-11-06 shape)", () => {
    const b = body(row("Health", 1, { ew: 0.4811, sn: 0.4365, trend: 1, gp: 0 }), row("Staples", 1, { ew: 0.424, sn: 0.6111, trend: 1, gp: 0 }));
    const v = verdict(b, "MISS");
    expect(v.code).toBe(2);
    expect(v.lines.join("\n")).toContain("Health=TREND & Staples=TREND");
  });
  test("an EW-led bit-identical fresh pair still FAILs (the arm can return non-zero)", () => {
    const b = body(row("Health", 0.5, { ew: 0.5, sn: 0.2, trend: 0.1, gp: 0 }), row("Staples", 0.5, { ew: 0.5, sn: 0.3, trend: null, gp: null }));
    expect(verdict(b, "MISS").code).toBe(1);
    expect(verdict(b, "HIT").code).toBe(2);
  });
  test("a separated pair PASSes only when EW leads; a gp- or SN-led separation is INCONCLUSIVE", () => {
    expect(verdict(body(row("Health", 0.5, { ew: 0.5, sn: 0.2, trend: 0, gp: 0 }), row("Staples", 0.4, { ew: 0.4, sn: 0.3, trend: 0, gp: 0 })), "HIT").code).toBe(0);
    expect(verdict(body(row("Health", 0.5, { ew: 0.1, sn: 0.2, trend: 0, gp: 0.5 }), row("Staples", 0.4, { ew: 0.4, sn: 0.3, trend: 0, gp: 0 })), "MISS").code).toBe(2);
    expect(nonEwLead(row("Staples", 0.6, { ew: 0.4, sn: 0.6, trend: 0, gp: 0 }))).toBe("STRESS-NOW");
    expect(nonEwLead(row("Staples", 0, { ew: 0, sn: 0, trend: 0, gp: 0 }))).toBeNull();
  });
  test("tie-break order is STRESS-NOW → TREND → GP: the first non-EW term equal to danger names the lead", () => {
    // sn ≥ ew opens the trend gate swap-proof, so all three terms are eligible and only the order decides.
    expect(nonEwLead(row("Staples", 0.6, { ew: 0.4, sn: 0.6, trend: 0.6, gp: 0.6 }))).toBe("STRESS-NOW");
    expect(nonEwLead(row("Staples", 0.6, { ew: 0.4, sn: 0.5, trend: 0.6, gp: 0.6 }))).toBe("TREND");
    expect(nonEwLead(row("Staples", 0.6, { ew: 0.4, sn: 0.5, trend: 0.55, gp: 0.6 }))).toBe("GP");
  });
  test("a trend lead under a part-open, EW-driven gate is swap-sensitive — a fresh identical pair still FAILs", () => {
    const b = body(row("Health", 0.25, { ew: 0.2, sn: 0.1, trend: 0.25, gp: 0 }), row("Staples", 0.25, { ew: 0.2, sn: 0.15, trend: 0.25, gp: 0 }));
    expect(verdict(b, "MISS").code).toBe(1);
  });
});
