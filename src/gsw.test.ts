import { describe, test, expect } from "vitest";
import { fetchGswForward, nearTermForward, ntfsFromLegs, parseGswCsv, svenssonZero } from "./gsw.js";

// Real feds200628 shape: a quoted staff-note preamble + a mnemonic table BEFORE the header, real
// column names (trimmed to the ones the parser locates by name), params off the live 1961 rows.
const PREAMBLE = [
  '"Note: This is not an official Federal Reserve statistical release."',
  "",
  "Series,Compounding Convention,Mnemonic(s)",
  "Zero-coupon yield,Continuously Compounded,SVENYXX",
  "Parameters,N/A,BETA0 to TAU2",
  "",
].join("\n");
const HEADER = "Date,BETA0,BETA1,BETA2,BETA3,SVEN1F01,SVENY01,SVENY02,TAU1,TAU2";
const ROW_1961_06_14 =
  "1961-06-14,3.91760612208239,-1.2779552459795,-1.94939709504669,0,3.8067,2.9825,3.3771,0.339217585301823,-999.99";
const ROW_1961_06_15 =
  "1961-06-15,3.97849786901152,-1.25740444250588,-2.24761738111161,0,3.8694,2.9941,3.4137,0.325774875695808,-999.99";
const FIXTURE = [PREAMBLE, HEADER, ROW_1961_06_14, ROW_1961_06_15].join("\n");

const P_1961_06_14 = {
  b0: 3.91760612208239,
  b1: -1.2779552459795,
  b2: -1.94939709504669,
  b3: 0,
  t1: 0.339217585301823,
  t2: -999.99,
};

describe("svenssonZero / nearTermForward (the formula itself)", () => {
  // The one cross-check that can fail against the PUBLISHED file: the fixture row carries the
  // Fed's own SVENY01/SVENY02 zero yields, so the formula must reproduce them from the params.
  test("reproduces the published SVENY01/SVENY02 off the same row's params", () => {
    expect(svenssonZero(P_1961_06_14, 1)).toBeCloseTo(2.9825, 3);
    expect(svenssonZero(P_1961_06_14, 2)).toBeCloseTo(3.3771, 3);
  });

  // Hand-computed on a synthetic 4-param row (β3 ≠ 0, real τ2 — exercises the second hump term
  // the 1961 rows zero out).
  test("fwd = (1.75·z(1.75) − 1.5·z(1.5)) / 0.25 on hand-computed values", () => {
    const p = { b0: 3, b1: -1, b2: 0.5, b3: 0.2, t1: 1.2, t2: 5 };
    expect(svenssonZero(p, 1.5)).toBeCloseTo(2.595973729056492, 10);
    expect(svenssonZero(p, 1.75)).toBeCloseTo(2.6483997559728465, 10);
    expect(nearTermForward(p)).toBeCloseTo(2.9629559174709748, 10);
  });
});

describe("parseGswCsv (preamble + header-by-name → fwd rows)", () => {
  test("skips the preamble, locates params by name, yields per-date fwd oldest→newest", () => {
    const out = parseGswCsv(FIXTURE);
    expect(out.map((o) => o.date)).toEqual(["1961-06-14", "1961-06-15"]);
    expect(out[0]!.value).toBeCloseTo(nearTermForward(P_1961_06_14), 10);
    expect(out[1]!.value).toBeCloseTo(3.8921405501239477, 8);
  });

  test("drops an NA-param row, keeps the parseable one", () => {
    const naRow = "1961-06-16,NA,-1.4,-1.8,0,3.86,3.0,3.4,0.34,-999.99";
    const out = parseGswCsv([HEADER, ROW_1961_06_14, naRow].join("\n"));
    expect(out.map((o) => o.date)).toEqual(["1961-06-14"]);
  });

  test("drops an EMPTY-param-cell row - Number('') === 0 must never coerce into a fwd", () => {
    const emptyCellRow = "1961-06-16,3.9,-1.4,,0,3.86,3.0,3.4,0.34,-999.99";
    const out = parseGswCsv([HEADER, ROW_1961_06_14, emptyCellRow].join("\n"));
    expect(out.map((o) => o.date)).toEqual(["1961-06-14"]);
  });

  test("dedups by date, LAST value wins (parseFredCsv revision semantics)", () => {
    const revised = ROW_1961_06_15.replace("3.97849786901152", "4.0");
    const out = parseGswCsv([HEADER, ROW_1961_06_15, revised].join("\n"));
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toBeCloseTo(
      nearTermForward({ ...P_1961_06_14, b0: 4.0, b1: -1.25740444250588, b2: -2.24761738111161, t1: 0.325774875695808 }),
      10,
    );
  });

  test.each([
    { name: "no header", csv: "<html>maintenance page</html>", err: /no "Date,…" header/ },
    { name: "missing column", csv: "Date,BETA0,BETA1,BETA2,BETA3,TAU1\n1961-06-14,1,2,3,4,5", err: /lacks column TAU2/ },
    { name: "header but no rows", csv: [PREAMBLE, HEADER].join("\n"), err: /0 parseable parameter rows/ },
    { name: "only NA-param rows", csv: [HEADER, "1961-06-17,NA,NA,NA,NA,x,y,z,NA,NA"].join("\n"), err: /0 parseable parameter rows/ },
  ])("fails LOUD on malformed input: $name", ({ csv, err }) => {
    expect(() => parseGswCsv(csv)).toThrow(err);
  });
});

describe("ntfsFromLegs (fwd − DGS3MO, inner-joined per date)", () => {
  // The legs mix vintages up to ~1wk (GSW publishes ~4 business days behind FRED), so each
  // one-sided tail date must DROP — the series ends at the last COMMON date.
  test("drops dates missing either leg; last row is the last common date", () => {
    const fwd = [
      { date: "2026-08-04", value: 4.5 },
      { date: "2026-08-05", value: 4.6 },
      { date: "2026-08-06", value: 4.7 },
    ];
    const dgs3mo = [
      { date: "2026-08-05", value: 4.4 },
      { date: "2026-08-06", value: 4.35 },
      { date: "2026-08-11", value: 4.3 },
    ];
    const out = ntfsFromLegs(fwd, dgs3mo);
    expect(out).toEqual([
      { date: "2026-08-05", value: expect.closeTo(0.2, 10) },
      { date: "2026-08-06", value: expect.closeTo(0.35, 10) },
    ]);
  });
});

// The FEED half, fetch stubbed per the repo pattern (ecb.test.ts): the URL handed to fetch and
// the fail-loud path are the things under test — no fallback construction may swallow a non-OK.
describe("fetchGswForward (URL + failure path)", () => {
  function stubFetch(res: { ok: boolean; status?: number; statusText?: string; body?: string }) {
    const calls: string[] = [];
    const fetchImpl = (url: string) => {
      calls.push(String(url));
      return Promise.resolve({
        ok: res.ok,
        status: res.status ?? 200,
        statusText: res.statusText ?? "OK",
        text: () => Promise.resolve(res.body ?? ""),
      } as Response);
    };
    return { calls, fetchImpl };
  }

  test("fetches the feds200628 CSV and parses it", async () => {
    const { calls, fetchImpl } = stubFetch({ ok: true, body: FIXTURE });
    const out = await fetchGswForward({ fetchImpl });
    expect(calls[0]).toBe("https://www.federalreserve.gov/data/yield-curve-tables/feds200628.csv");
    expect(out).toHaveLength(2);
  });

  test("throws on a non-200 rather than degrading (exact-GSW-only ruling)", async () => {
    const { fetchImpl } = stubFetch({ ok: false, status: 503, statusText: "Service Unavailable" });
    await expect(fetchGswForward({ fetchImpl })).rejects.toThrow(/503 Service Unavailable/);
  });
});
