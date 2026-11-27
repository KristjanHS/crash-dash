import { describe, expect, it } from "vitest";
import { measureCftcYen, QUERY_URL, type TffRow } from "./probe-cftc-yen.js";

const row = (date: string, long: number, short: number, market = "JAPANESE YEN - CHICAGO MERCANTILE EXCHANGE"): TffRow => ({ report_date_as_yyyy_mm_dd: `${date}T00:00:00.000`, market_and_exchange_names: market, lev_money_positions_long: String(long), lev_money_positions_short: String(short) });

describe("probe:cftc-yen", () => {
  it("reads leveraged-funds net (long − short) and its w/w change, dated by the report", () => {
    expect(measureCftcYen([row("2026-10-20", 69351, 92241), row("2026-10-13", 65309, 98982)], QUERY_URL)).toEqual({
      asOf: "2026-10-20",
      text: "CFTC TFF JPY leveraged funds net −22,890 (wk to 10-20, Δ +10,783 w/w)",
      sources: [{ date: "2026-10-20", url: QUERY_URL }],
    });
  });
  it("is an {error} on an empty response or the EUR/JPY cross", () => {
    expect(measureCftcYen([], QUERY_URL)).toEqual({ error: "CFTC TFF 097741: 0 report(s), need 2 for Δ w/w" });
    expect(measureCftcYen([row("2026-10-20", 1, 2), row("2026-10-13", 1, 2, "EURO FX/JAPANESE YEN XRATE - CHICAGO MERCANTILE EXCHANGE")], QUERY_URL)).toHaveProperty("error");
  });
});
