import { describe, expect, it } from "vitest";
import { COGS_URL, INV_URL, measure, measureMuDio, quarters, type Fact } from "./probe-mu-dio.js";

/** Trimmed real EDGAR companyconcept facts (CIK 723125) fetched 2026-11-14: InventoryNet + CostOfGoodsAndServicesSold, `accn` dropped. */
const INV: Fact[] = [
  { end: "2025-08-28", val: 8355000000, fy: 2025, fp: "FY", form: "10-K", filed: "2025-10-03" },
  { end: "2025-08-28", val: 8355000000, fy: 2026, fp: "FY", form: "10-K", filed: "2026-10-09", frame: "CY2025Q3I" },
  { end: "2025-11-27", val: 8205000000, fy: 2026, fp: "Q1", form: "10-Q", filed: "2025-12-18", frame: "CY2025Q4I" },
  { end: "2026-02-26", val: 8267000000, fy: 2026, fp: "Q2", form: "10-Q", filed: "2026-03-19", frame: "CY2026Q1I" },
  { end: "2026-05-28", val: 8567000000, fy: 2026, fp: "Q3", form: "10-Q", filed: "2026-06-25", frame: "CY2026Q2I" },
  { end: "2026-09-03", val: 10372000000, fy: 2026, fp: "FY", form: "10-K", filed: "2026-10-09", frame: "CY2026Q3I" },
];
const FY26: Fact = { start: "2025-08-29", end: "2026-09-03", val: 25684000000, fy: 2026, fp: "FY", form: "10-K", filed: "2026-10-09", frame: "CY2026" };
const COGS: Fact[] = [
  { start: "2025-02-28", end: "2025-05-29", val: 5793000000, fy: 2025, fp: "Q3", form: "10-Q", filed: "2025-06-26" },
  { start: "2025-02-28", end: "2025-05-29", val: 5793000000, fy: 2026, fp: "Q3", form: "10-Q", filed: "2026-06-25", frame: "CY2025Q2" },
  { start: "2024-08-30", end: "2025-08-28", val: 22505000000, fy: 2025, fp: "FY", form: "10-K", filed: "2025-10-03" },
  { start: "2025-08-29", end: "2025-11-27", val: 5997000000, fy: 2026, fp: "Q1", form: "10-Q", filed: "2025-12-18", frame: "CY2025Q4" },
  { start: "2025-08-29", end: "2026-02-26", val: 12102000000, fy: 2026, fp: "Q2", form: "10-Q", filed: "2026-03-19" },
  { start: "2025-11-28", end: "2026-02-26", val: 6105000000, fy: 2026, fp: "Q2", form: "10-Q", filed: "2026-03-19", frame: "CY2026Q1" },
  { start: "2025-08-29", end: "2026-05-28", val: 18502000000, fy: 2026, fp: "Q3", form: "10-Q", filed: "2026-06-25" },
  { start: "2026-02-27", end: "2026-05-28", val: 6400000000, fy: 2026, fp: "Q3", form: "10-Q", filed: "2026-06-25", frame: "CY2026Q2" },
  FY26,
];

describe("probe:mu-dio", () => {
  it("reads FQ4-26 off the 10-K: avg-inventory DIO vs ~140d, period-end basis, prior FQ3-26, q/q change; asOf = filed", () => {
    expect(measureMuDio(INV, COGS)).toEqual({
      asOf: "2026-10-09",
      text:
        "EDGAR MU 10-K filed 2026-10-09: FQ4-26 (qtr to 2026-09-03, 98 d) DIO 129.2 d on avg inventory (Micron's basis), ≤ ~140d line; period-end basis 141.5 d ($10.37B inventory / $7.18B COGS) · " +
        'prior FQ3-26 (to 2026-05-28) 119.7 d · change +9.5 d q/q (rise) · "guided to rise/fall" NOT covered — guidance is textual (call/press release), not XBRL',
      sources: [{ date: "2026-10-09", url: COGS_URL }, { date: "2026-10-09", url: INV_URL }],
    });
  });
  it("derives FQ4 = FY − the three 10-Q quarters (53-week year → 98 d), drops YTD spans, keeps each period's original filing; a gap in FQ1–FQ3 derives no FQ4", () => {
    const qs = quarters(COGS);
    expect(qs.map((q) => `${q.end} FQ${q.q}-${q.fy} ${q.days}d ${q.filed}`)).toEqual(["2025-05-29 FQ3-2025 91d 2025-06-26", "2025-11-27 FQ1-2026 91d 2025-12-18", "2026-02-26 FQ2-2026 91d 2026-03-19", "2026-05-28 FQ3-2026 91d 2026-06-25", "2026-09-03 FQ4-2026 98d 2026-10-09"]);
    const noQ3 = [...COGS.filter((f) => f.start !== "2026-02-27"), { ...FY26, start: "2026-05-29", val: 7182000000, frame: undefined }];
    expect(quarters(noQ3).filter((q) => q.end === "2026-09-03").map((q) => q.cogs)).toEqual([7182000000]);
    expect(qs.at(-1)).toEqual({ start: "2026-05-29", end: "2026-09-03", cogs: 7182000000, days: 98, fy: 2026, q: 4, form: "10-K", filed: "2026-10-09" });
  });
  it("before the 10-K the latest 10-Q quarter leads, prior = the quarter before it; a fall says so; the ~140d line splits 139.99 / 140.01", () => {
    expect(measureMuDio(INV, COGS.filter((f) => f !== FY26))).toMatchObject({ asOf: "2026-06-25", text: expect.stringContaining("FQ3-26 (qtr to 2026-05-28, 91 d) DIO 119.7 d on avg inventory (Micron's basis), ≤ ~140d line; period-end basis 121.8 d ($8.57B inventory / $6.40B COGS) · prior FQ2-26 (to 2026-02-26) 122.8 d · change −3.1 d q/q (fall)") });
    const at = (val: number) => measureMuDio(INV.map((f) => (f.end === "2026-09-03" ? { ...f, val } : f)), COGS);
    expect([at(11952e6), at(11954e6)]).toMatchObject([{ text: expect.stringContaining("DIO 140.0 d on avg inventory (Micron's basis), ≤ ~140d line") }, { text: expect.stringContaining("DIO 140.0 d on avg inventory (Micron's basis), > ~140d line") }]);
  });
  it("is an {error} on empty data, a missing or non-positive inventory, a quarter gap, or a fetch failure", async () => {
    expect(measureMuDio(INV, [])).toEqual({ error: "EDGAR MU: 0 fiscal quarter(s) of COGS, need 2" });
    expect(measureMuDio([], COGS)).toEqual({ error: "EDGAR MU: no InventoryNet at 2026-02-26, 2026-05-28, 2026-09-03" });
    expect(measureMuDio(INV.map((f) => (f.end === "2026-02-26" ? { ...f, val: 0 } : f)), COGS)).toEqual({ error: "EDGAR MU: no InventoryNet at 2026-02-26" });
    expect(measureMuDio(INV, COGS.filter((f) => f.start !== "2025-11-28"))).toEqual({ error: "EDGAR MU: FQ3-26 has no adjoining prior quarter (prior ends 2025-11-27)" });
    const http = (inv: number, cogs: number) => async (url: string) => new Response("{}", { status: url === INV_URL ? inv : cogs });
    expect(await Promise.all([measure(http(403, 200)), measure(http(200, 503))])).toEqual([{ error: "EDGAR MU: HTTP 403 InventoryNet / 200 CostOfGoodsAndServicesSold" }, { error: "EDGAR MU: HTTP 200 InventoryNet / 503 CostOfGoodsAndServicesSold" }]);
    expect(await measure(http(200, 200))).toEqual({ error: "EDGAR MU: 0 fiscal quarter(s) of COGS, need 2" });
  });
});
