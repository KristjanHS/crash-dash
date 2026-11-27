import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { clearRunBudget, RUN_FETCH_BUDGET_MS, startRunBudget } from "./fetch-budget.js";
import {
  ECB_COLD_P100_MS,
  ECB_DEEP_ATTEMPTS,
  ECB_DEEP_TIMEOUT_MS,
  ECB_LAST_N,
  ECB_MAX_ATTEMPTS,
  ECB_SCORER_FLOORS,
  ECB_TIMEOUT_MS,
  ecbTimeoutFor,
  fetchEcbSeries,
  parseEcbCsv,
} from "./ecb.js";
import { EPATH, ESTR, EURGBP } from "./registry-composite.js";
import { scoreDerived } from "./scorers-core.js";
import { scoreRatioSpread } from "./scorers-composite.js";
import { scoreReturnOrMaSpread } from "./scorers-price.js";
import { EPATH_DESCRIPTOR } from "./family-descriptor-rows.js";

// ECB SDMX-CSV is a named-column header then one row per observation; TIME_PERIOD
// + OBS_VALUE are located BY NAME (order not contractual), so these pin the parse
// contract: header skipped, oldest→newest sort (the endpoint returns newest-first),
// and the missing-value drop (never a spurious 0). Pure parse — no network — like
// fred.test.ts / the price parser tests. Still needs an `npm start` live-verify per
// `docs/reference.md` §[runbook] External feeds; fixtures catch shape regressions, not a
// free-tier change.
describe("parseEcbCsv (SDMX-CSV yield-curve series)", () => {
  // A realistic (trimmed) header: leading dimension columns, then the two we read.
  const HEADER = "KEY,FREQ,REF_AREA,CURRENCY,TIME_PERIOD,OBS_VALUE";

  test("keeps (date, value) rows, drops the header, sorts oldest→newest", () => {
    // Endpoint returns newest-first — assert we re-sort ascending.
    const csv = [
      HEADER,
      "YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y,B,U2,EUR,2026-07-10,3.0569",
      "YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y,B,U2,EUR,2026-07-09,3.0102",
    ].join("\n");
    expect(parseEcbCsv(csv)).toEqual([
      { date: "2026-07-09", value: 3.0102 },
      { date: "2026-07-10", value: 3.0569 },
    ]);
  });

  test("drops a missing '.' OBS_VALUE, never as a spurious 0", () => {
    // The trap: Number("") === 0 and Number(".") is NaN — the empty case would
    // inject { value: 0 } unguarded and corrupt the 20d velocity window.
    const csv = [
      HEADER,
      "K,B,U2,EUR,2026-07-08,3.00",
      "K,B,U2,EUR,2026-07-09,.",
      "K,B,U2,EUR,2026-07-10,",
      "K,B,U2,EUR,2026-07-11,3.20",
    ].join("\n");
    const out = parseEcbCsv(csv);
    expect(out).toEqual([
      { date: "2026-07-08", value: 3.0 },
      { date: "2026-07-11", value: 3.2 },
    ]);
    expect(out.some((o) => o.value === 0)).toBe(false);
  });

  test("locates columns by NAME even when their position differs", () => {
    // OBS_VALUE before TIME_PERIOD — position-based parsing would read the wrong field.
    const csv = ["OBS_VALUE,TIME_PERIOD", "2.5,2026-07-10", "2.4,2026-07-09"].join("\n");
    expect(parseEcbCsv(csv)).toEqual([
      { date: "2026-07-09", value: 2.4 },
      { date: "2026-07-10", value: 2.5 },
    ]);
  });

  test("returns [] for a header-only or column-missing body (no observations)", () => {
    expect(parseEcbCsv(HEADER)).toEqual([]);
    expect(parseEcbCsv("")).toEqual([]);
    // Header without the two named columns → nothing located → [].
    expect(parseEcbCsv(["FOO,BAR", "a,b"].join("\n"))).toEqual([]);
  });
});

// The FEED half (the parse half is above). The EU2 plan
// substituted these for the retired
// "drop the API key and assert the fetch throws" falsifier — there is no key.
// Both would go green against a silently-broken feed without a stub, so fetch is
// stubbed and the URL it is handed is the thing under test.
describe("fetchEcbSeries (dataflow routing + failure path)", () => {
  function stubFetch(res: { ok: boolean; status?: number; statusText?: string; body?: string }) {
    const calls: string[] = [];
    const fetchImpl = (url: string) => {
      calls.push(url);
      return Promise.resolve({
        ok: res.ok,
        status: res.status ?? 200,
        statusText: res.statusText ?? "OK",
        text: () => Promise.resolve(res.body ?? ""),
      } as Response);
    };
    return { calls, fetchImpl };
  }

  // The dataflow rides on the SERIES_KEYS entry, so a key routed to the wrong dataflow 404s in prod.
  // Three live dataflows (YC, EST, CISS) ⇒ a hardcoded dataflow reddens at least two of the four rows.
  test("composes the URL from each series' OWN dataflow + key", async () => {
    // The body carries a missing '.' OBS_VALUE: it must not reach the caller as a 0 observation (0 is a
    // LEGAL spot rate at the zero bound, so a swallowed row is indistinguishable from a real print).
    const { calls, fetchImpl } = stubFetch({ ok: true, body: "TIME_PERIOD,OBS_VALUE\n2026-07-23,.\n2026-07-24,3.1" });
    expect(await fetchEcbSeries("SR_10Y", { fetchImpl })).toEqual([{ date: "2026-07-24", value: 3.1 }]);
    await fetchEcbSeries("SR_3M", { fetchImpl });
    await fetchEcbSeries("ESTR", { fetchImpl });
    await fetchEcbSeries("ECISS", { fetchImpl });
    expect(calls[0]).toContain("/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y?");
    expect(calls[1]).toContain("/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_3M?");
    expect(calls[2]).toContain("/service/data/EST/B.EU000A2X2A25.WT?");
    expect(calls[3]).toContain("/service/data/CISS/D.U2.Z0Z.4F.EC.SS_CIN.IDX?");
  });

  test("throws on a non-200 rather than returning [] (the !res.ok path) — a 4xx is never retried", async () => {
    const { calls, fetchImpl } = stubFetch({ ok: false, status: 404, statusText: "Not Found" });
    await expect(fetchEcbSeries("SR_10Y", { fetchImpl, sleep: noSleep })).rejects.toThrow(/SR_10Y: 404 Not Found/);
    expect(calls).toHaveLength(1);
  });
});

const noSleep = () => Promise.resolve();
const stall = () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

describe("fetchEcbSeries timeout retry (each retry on its own CDN cache key)", () => {
  beforeEach(() => clearRunBudget());
  afterEach(() => clearRunBudget()); // the fired-budget test must not leak an armed deadline to the next file

  test("a stalled attempt retries on a cache-busted URL and returns its data", async () => {
    const calls: string[] = [];
    const fetchImpl = (url: string) => {
      calls.push(url);
      return calls.length === 1 ? stall() : Promise.resolve(new Response("TIME_PERIOD,OBS_VALUE\n2026-11-10,0.83545"));
    };
    expect(await fetchEcbSeries("EURGBP", { fetchImpl, sleep: noSleep })).toEqual([{ date: "2026-11-10", value: 0.83545 }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain("&_=");
    expect(calls[1]?.startsWith(`${calls[0]}&_=`)).toBe(true);
  });

  test("all-stall: bounded retries, each on its own cache key, then gives up naming the series + attempt count", async () => {
    const calls: string[] = [];
    const fetchImpl = (url: string) => (calls.push(url), stall());
    const err = await fetchEcbSeries("ECISS", { fetchImpl, sleep: noSleep }).catch((e: unknown) => e);
    expect(calls).toHaveLength(ECB_MAX_ATTEMPTS);
    expect(new Set(calls).size).toBe(calls.length);
    expect((err as Error).message).toMatch(
      new RegExp(`^ECISS: The operation was aborted due to timeout \\(gave up after ${calls.length} attempt\\(s\\), [\\d.]+ s\\)$`),
    );
    const deep: string[] = [];
    await fetchEcbSeries("ECISS", { startPeriod: "2020-01-01", fetchImpl: (u: string) => (deep.push(u), stall()), sleep: noSleep }).catch(
      () => {},
    );
    expect(deep).toHaveLength(ECB_DEEP_ATTEMPTS);
  });

  test("a cron attempt outlasts the slowest measured cold answer, and the all-timeout case leaves half the run's fetch budget", () => {
    expect(ECB_MAX_ATTEMPTS).toBeGreaterThan(1);
    expect(ECB_TIMEOUT_MS).toBeGreaterThan(ECB_COLD_P100_MS);
    expect(ECB_MAX_ATTEMPTS * ECB_TIMEOUT_MS).toBeLessThan(RUN_FETCH_BUDGET_MS / 2);
  });

  test("once the run fetch budget has fired, a failure is rethrown raw — no retry", async () => {
    startRunBudget(0, performance.now(), () => {});
    await new Promise((done) => setTimeout(done, 1)); // let the 0 ms deadline fire
    const calls: string[] = [];
    const err = await fetchEcbSeries("EURGBP", { fetchImpl: (u: string) => (calls.push(u), stall()), sleep: noSleep }).catch(
      (e: unknown) => e,
    );
    expect(calls).toHaveLength(1);
    expect((err as Error).message).not.toContain("gave up after");
  });
});

// A cold `startPeriod` query took 9.9 s on ECB and the old shared `ECB_TIMEOUT_MS` abort killed every backfill retry.
describe("ecbTimeoutFor (per-attempt timeout by branch)", () => {
  test("startPeriod gets the deep timeout, the bounded window keeps the short one", () => {
    expect(ecbTimeoutFor({ startPeriod: "2023-10-05" })).toBe(ECB_DEEP_TIMEOUT_MS);
    expect(ecbTimeoutFor()).toBe(ECB_TIMEOUT_MS);
    expect(ECB_DEEP_TIMEOUT_MS).toBeGreaterThan(ECB_TIMEOUT_MS);
  });
});

// The bounded window must feed every ECB scorer's own min-closes floor (ESTR's 60-obs `change` sat above the old 60).
describe("ECB_LAST_N covers each ECB scorer's floor", () => {
  const series = (n: number) => Array.from({ length: n }, (_, i) => ({ date: `d${String(i).padStart(3, "0")}`, value: 1 }));
  const obs = series(ECB_LAST_N);
  test("ESTR scoreDerived", () => expect(() => scoreDerived(ESTR, obs)).not.toThrow());
  test("EURGBP scoreReturnOrMaSpread", () => expect(() => scoreReturnOrMaSpread(EURGBP, obs)).not.toThrow());
  // At its OWN floor, not ECB_LAST_N: the ESTR term dominates the max, so only this reds on a short EPATH term.
  test("EPATH scoreRatioSpread at its own ECB_SCORER_FLOORS term", () => {
    const own = series(ECB_SCORER_FLOORS.EPATH);
    expect(() => scoreRatioSpread(EPATH, EPATH_DESCRIPTOR, own, own)).not.toThrow();
  });
});
