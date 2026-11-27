import { describe, expect, it } from "vitest";
import { HY_NOWCAST_PARAMS, nowcastHyOas as nowcast } from "./hyoas-nowcast.js";

const nowcastHyOas = (oas: Parameters<typeof nowcast>[0], p: Parameters<typeof nowcast>[1], h: Parameters<typeof nowcast>[2]) =>
  nowcast(oas, p, h, HY_NOWCAST_PARAMS);
const obs = (rows: [string, number][]) => rows.map(([date, value]) => ({ date, value }));

describe("nowcastHyOas", () => {
  const oas = obs([["2026-09-16", 3.0], ["2026-09-17", 3.1]]);

  it("widens the spread when HYG falls with IEF flat, sized by the duration constant", () => {
    const drop = Math.exp(-0.01);
    const n = nowcastHyOas(oas, obs([["2026-09-17", 80], ["2026-09-18", 80 * drop]]), obs([["2026-09-17", 95], ["2026-09-18", 95]]));
    expect(n).toEqual({ date: "2026-09-18", fromDate: "2026-09-17", value: expect.closeTo(3.1 + 1 / HY_NOWCAST_PARAMS.spreadDurationYears, 10) });
  });

  it("hedges out a rates move: HYG and IEF falling β-for-one leaves the estimate at the print", () => {
    const r = -0.004;
    const n = nowcastHyOas(
      oas,
      obs([["2026-09-17", 80], ["2026-09-18", 80 * Math.exp(HY_NOWCAST_PARAMS.hedgeBeta * r)]]),
      obs([["2026-09-17", 95], ["2026-09-18", 95 * Math.exp(r)]]),
    );
    expect(n!.value).toBeCloseTo(3.1, 10);
  });

  it("accumulates over a multi-day FRED lag from the close at the print date", () => {
    const n = nowcastHyOas(
      oas,
      obs([["2026-09-17", 80], ["2026-09-18", 79], ["2026-09-21", 80 * Math.exp(-0.02)]]),
      obs([["2026-09-17", 95], ["2026-09-18", 95], ["2026-09-21", 95]]),
    );
    expect(n).toMatchObject({ date: "2026-09-21", fromDate: "2026-09-17" });
    expect(n!.value).toBeCloseTo(3.1 + 2 / HY_NOWCAST_PARAMS.spreadDurationYears, 10);
  });
});
