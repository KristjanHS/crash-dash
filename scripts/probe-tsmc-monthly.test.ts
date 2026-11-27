import { describe, expect, it } from "vitest";
import { measureTsmcMonthly, QUERY_URL, rocDate, type RevenueRow } from "./probe-tsmc-monthly.js";

/** Two rows of the real `t187ap05_L` response fetched 2026-11-14 (1077 rows; 2303 kept as the non-2330 neighbour). */
const UMC: RevenueRow = { "出表日期": "1151113", "資料年月": "11510", "公司代號": "2303", "公司名稱": "聯電", "產業別": "半導體業", "營業收入-當月營收": "25197532", "營業收入-上月營收": "25350431", "營業收入-去年當月營收": "21294974", "營業收入-上月比較增減(%)": "-0.603141619170104", "營業收入-去年同月增減(%)": "18.32619283780295", "累計營業收入-當月累計營收": "229207213", "累計營業收入-去年累計營收": "197038628", "累計營業收入-前期比較增減(%)": "16.32602973666666", "備註": "-" };
const TSMC: RevenueRow = { "出表日期": "1151113", "資料年月": "11510", "公司代號": "2330", "公司名稱": "台積電", "產業別": "半導體業", "營業收入-當月營收": "586890319", "營業收入-上月營收": "511857399", "營業收入-去年當月營收": "367473051", "營業收入-上月比較增減(%)": "14.658949962741477", "營業收入-去年同月增減(%)": "59.709757600700904", "累計營業收入-當月累計營收": "4485617293", "累計營業收入-去年累計營收": "3130436902", "累計營業收入-前期比較增減(%)": "43.29045540365918", "備註": "因先進製程產品需求增加所致。" };

describe("probe:tsmc-monthly", () => {
  it("reads TSMC's month off the 2330 row: revenue NT$B, m/m, y/y vs +30 %, prior month; asOf = table date capped at the next month's 10th", () => {
    expect(measureTsmcMonthly([UMC, TSMC], QUERY_URL)).toEqual({
      asOf: "2026-11-10",
      text: "TWSE 2330 monthly 11-10: Oct 2026 revenue NT$586.89B, m/m +14.7 % (rise), y/y +59.7 % (≥ +30 %) · prior month Sep 2026 NT$511.86B · Jan–Oct cum y/y +43.3 %",
      sources: [{ date: "2026-11-10", url: QUERY_URL }],
    });
  });
  it("a table dated before the deadline dates the reading; a December row rolls into January; falls and sub-line y/y say so", () => {
    const dec = { ...TSMC, "出表日期": "1160107", "資料年月": "11512", "營業收入-上月比較增減(%)": "-2.04", "營業收入-去年同月增減(%)": "29.96" };
    expect(measureTsmcMonthly([dec], QUERY_URL)).toMatchObject({ asOf: "2027-01-07", sources: [{ date: "2027-01-07" }], text: expect.stringContaining("Dec 2026 revenue NT$586.89B, m/m −2.0 % (fall), y/y +30.0 % (< +30 %) · prior month Nov 2026") });
    expect(measureTsmcMonthly([{ ...TSMC, "資料年月": "11501" }], QUERY_URL)).toMatchObject({ asOf: "2026-02-10", text: expect.stringContaining("prior month Dec 2025") });
  });
  it("converts ROC dates (民國 + 1911) and rejects malformed ones", () => {
    expect([rocDate("11510"), rocDate("1151113"), rocDate("9912")]).toEqual([{ y: 2026, m: 10 }, { y: 2026, m: 11, d: 13 }, { y: 2010, m: 12 }]);
    expect([rocDate("11513"), rocDate("1151132"), rocDate("115100"), rocDate("2026-10"), rocDate(undefined)]).toEqual([null, null, null, null, null]);
  });
  it("is an {error} on an empty response, no 2330 row, a malformed month or a non-numeric revenue", () => {
    expect(measureTsmcMonthly([], QUERY_URL)).toEqual({ error: "TWSE t187ap05_L: no 2330 row in 0 row(s)" });
    expect(measureTsmcMonthly([UMC], QUERY_URL)).toEqual({ error: "TWSE t187ap05_L: no 2330 row in 1 row(s)" });
    expect(measureTsmcMonthly([{ ...TSMC, "資料年月": "1151013" }], QUERY_URL)).toHaveProperty("error");
    const bad = ([{ "營業收入-當月營收": "0" }, { "營業收入-去年同月增減(%)": "" }] as RevenueRow[]).map((f) => measureTsmcMonthly([{ ...TSMC, ...f }], QUERY_URL));
    expect(bad).toEqual(Array(2).fill({ error: "TWSE t187ap05_L 2330: non-numeric revenue field" }));
  });
});
