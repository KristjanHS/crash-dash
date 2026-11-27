import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  drainKeyedFallbacks,
  fetchSeries as fetchSeriesUnbound,
  FRED_OUTAGE_MIN_FAILED,
  fredOutage,
  parseFredCsv,
  parseFredJson,
  resetKeyedFallbacks,
  startFredMemo,
  stopFredMemo,
  type VolIndexFetch,
} from "./fred.js";
import { clearRunBudget, type FetchLike, startRunBudget } from "./fetch-budget.js";
import { realFeeds } from "./feed-ports.js";
import { NoFreeSourceError } from "./no-free-source.js";

const fetchSeriesWith = realFeeds.fetchSeries;

// FRED CSV is `<date-header>,<series-id>` then `YYYY-MM-DD,<value>` rows, with
// "." OR an empty field for a missing observation. These pin the same failure modes the price
// parsers do — the FRED
// feed is the PRIMARY indicator source, so a silent header/format drift here
// rots the whole verdict. Per `docs/reference.md` §[runbook] External feeds this still needs an
// `npm start` live-verify; fixtures only catch shape regressions, not a free-tier change.
describe("parseFredCsv (daily series CSV)", () => {
  const HEADER = "DATE,BAMLH0A0HYM2";

  test("keeps (date, value) rows in feed order, drops the header", () => {
    const csv = [HEADER, "2026-06-25,4.20", "2026-06-26,4.35"].join("\n");
    expect(parseFredCsv(csv)).toEqual([
      { date: "2026-06-25", value: 4.2 },
      { date: "2026-06-26", value: 4.35 },
    ]);
  });

  // Bystander rows: the bad row vanishes while the two real rows survive intact — the filter is
  // selective, not drop-everything. The EMPTY case is the trap: Number("") === 0 is finite, so an
  // unguarded empty field would inject { value: 0 } and corrupt 20d return/velocity windows downstream.
  test.each([
    ["a missing-value '.' row", "2026-06-25,."],
    ["an EMPTY-value row, never as a spurious 0 (DCOILWTICO uses empty, not '.')", "2026-06-25,"],
    ["a non-numeric / malformed row", "2026-06-25,oops"],
    ["a row with no value column (no comma → raw undefined)", "2026-06-25"],
  ])("drops %s and keeps the surrounding real rows", (_case, bad) => {
    expect(parseFredCsv([HEADER, "2026-06-24,4.10", bad, "2026-06-26,4.35"].join("\n"))).toEqual([
      { date: "2026-06-24", value: 4.1 },
      { date: "2026-06-26", value: 4.35 },
    ]);
  });

  test("returns [] for a header-only body (valid header, no observations)", () => {
    // A valid header with no rows is empty-but-fine; downstream scoreIndicator throws on
    // too-short history, which is where a starved feed surfaces.
    expect(parseFredCsv(HEADER)).toEqual([]);
  });

  // Header hardening (audit rank 12 / DQ-A3): a drifted/error-page body served as a 200
  // must throw loudly naming the series, not parse to garbage.
  test("throws (naming the series) on a wrong header - feed drift / HTML error page", () => {
    expect(() => parseFredCsv("<html>Rate limited</html>", "DGS10")).toThrow(/DGS10/);
    expect(() => parseFredCsv("<html>Rate limited</html>", "DGS10")).toThrow(/header/i);
    // Three-column / renamed date header also rejected.
    expect(() => parseFredCsv("foo,bar,baz\n2026-06-25,4.2,x", "BAMLH0A0HYM2")).toThrow(
      /BAMLH0A0HYM2/,
    );
  });

  test("throws on an empty body (no header at all)", () => {
    expect(() => parseFredCsv("", "DGS10")).toThrow(/DGS10/);
  });

  test("accepts the current `observation_date` date-header variant", () => {
    const csv = ["observation_date,DGS10", "2026-06-25,4.20"].join("\n");
    expect(parseFredCsv(csv, "DGS10")).toEqual([{ date: "2026-06-25", value: 4.2 }]);
  });

  test("sorts an out-of-order body ascending by date (DQ-A3: reorder must not corrupt windows)", () => {
    const csv = [HEADER, "2026-06-26,4.35", "2026-06-24,4.10", "2026-06-25,4.20"].join("\n");
    expect(parseFredCsv(csv)).toEqual([
      { date: "2026-06-24", value: 4.1 },
      { date: "2026-06-25", value: 4.2 },
      { date: "2026-06-26", value: 4.35 },
    ]);
  });

  test("dedups a duplicate date - last value wins (FRED vintage revision)", () => {
    const csv = [HEADER, "2026-06-25,4.20", "2026-06-26,4.35", "2026-06-25,4.99"].join("\n");
    expect(parseFredCsv(csv)).toEqual([
      { date: "2026-06-25", value: 4.99 },
      { date: "2026-06-26", value: 4.35 },
    ]);
  });
});

// The keyed FRED API returns JSON `observations` (missing = "." as in the CSV). This pins
// the JSON parser drops the same missing-value rows the CSV path does, so keyed and keyless
// stay byte-equivalent downstream.
describe("parseFredJson (keyed FRED API observations)", () => {
  test("keeps numeric rows, drops '.'/empty missing values", () => {
    const json = {
      observations: [
        { date: "2026-06-24", value: "4.10" },
        { date: "2026-06-25", value: "." },
        { date: "2026-06-26", value: "" },
        { date: "2026-06-27", value: "4.35" },
      ],
    };
    expect(parseFredJson(json)).toEqual([
      { date: "2026-06-24", value: 4.1 },
      { date: "2026-06-27", value: 4.35 },
    ]);
  });

  test("sorts + dedups (last wins) to stay byte-equivalent to the CSV path", () => {
    const json = {
      observations: [
        { date: "2026-06-26", value: "4.35" },
        { date: "2026-06-25", value: "4.20" },
        { date: "2026-06-25", value: "4.99" }, // revision → last wins
      ],
    };
    expect(parseFredJson(json)).toEqual([
      { date: "2026-06-25", value: 4.99 },
      { date: "2026-06-26", value: 4.35 },
    ]);
  });

  test("a wrong-typed body throws a named shape error, never a silent garbage row", () => {
    expect(() => parseFredJson({ observations: "x" })).toThrow(/observations is not an array/);
    expect(() => parseFredJson({ observations: [{ date: "2026-06-25", value: 4.2 }] })).toThrow(/observations\[0\] date\/value is not a string/);
    expect(parseFredJson({})).toEqual([]);
  });
});

// Fault tolerance (audit rank 3): fetchSeries must survive one transient failure and route
// keyed-vs-keyless off FRED_API_KEY. Every call gets an injected fetch, env and no-op retry sleep.
describe("fetchSeries (retry + keyed/keyless routing)", () => {
  const OK_CSV = "DATE,X\n2026-06-25,4.20\n2026-06-26,4.35";
  const OK_JSON = JSON.stringify({
    observations: [
      { date: "2026-06-25", value: "4.20" },
      { date: "2026-06-26", value: "4.35" },
    ],
  });
  const EXPECTED = [
    { date: "2026-06-25", value: 4.2 },
    { date: "2026-06-26", value: 4.35 },
  ];
  const csvOk = () => new Response(OK_CSV, { status: 200 });
  const jsonOk = () => new Response(OK_JSON, { status: 200 });
  const err500 = () => new Response("upstream error", { status: 500, statusText: "Server Error" });

  let fetchMock: ReturnType<typeof vi.fn>;
  let env: NodeJS.ProcessEnv;
  let now: Date | undefined;
  beforeEach(() => {
    fetchMock = vi.fn();
    env = {};
    now = undefined;
    // Shared project: a run cycle in an earlier file leaves the per-run memo armed and would serve its rows here.
    stopFredMemo();
  });
  const noSleep = async (): Promise<void> => {};
  // Transport tests: an empty refused set, so a refused id still exercises the wire path whatever the build refuses
  // (the refusal itself is pinned in fred-series-policy.test.ts).
  const fetchSeries = (series: string, opts: { fullHistory?: boolean; since?: string } = {}) =>
    fetchSeriesWith(series, { ...opts, fetchImpl: fetchMock as unknown as FetchLike, env, sleep: noSleep, now: now ?? new Date(), refusedSeries: new Set() });
  /** Lets a `startRunBudget(1)` deadline fire for real. */
  const budgetLapse = () => new Promise((r) => setTimeout(r, 5));

  const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

  // Both transports: the drop sits above the keyless/keyed split, so moving it into either path reds the other arm.
  const rowsCsv = (id: string, rows: [string, string][]) => `DATE,${id}\n${rows.map((r) => r.join(",")).join("\n")}`;
  const rowsJson = (_id: string, rows: [string, string][]) =>
    JSON.stringify({ observations: rows.map(([date, value]) => ({ date, value })) });
  test.each([
    { path: "keyless CSV", key: undefined, body: rowsCsv, host: "fred.stlouisfed.org/graph/fredgraph.csv" },
    { path: "keyed JSON", key: "testkey", body: rowsJson, host: "api.stlouisfed.org/fred/series/observations" },
  ])("$path: drops an ICE BofA weekend month-end mark; keeps a monthly series dated a weekend 1st", async ({ key, body, host }) => {
    if (key) env.FRED_API_KEY = key;
    // 2026-02-28 is a Saturday (F1's lone raw RED that episode); 2026-03-01 is a Sunday.
    const baml = body("BAMLH0A0HYM2", [["2026-02-27", "3.10"], ["2026-02-28", "3.40"], ["2026-03-02", "3.15"]]);
    const monthly = body("CP0000EZ19M086NEST", [["2026-02-01", "1.70"], ["2026-03-01", "1.90"]]);
    fetchMock
      .mockResolvedValueOnce(new Response(baml, { status: 200 }))
      .mockResolvedValueOnce(new Response(monthly, { status: 200 }));
    expect((await fetchSeries("BAMLH0A0HYM2")).map((o) => o.date)).toEqual(["2026-02-27", "2026-03-02"]);
    expect((await fetchSeries("CP0000EZ19M086NEST")).map((o) => o.date)).toEqual(["2026-02-01", "2026-03-01"]);
    expect(urls().every((u) => u.includes(host))).toBe(true); // the arm really rode its own transport
  });

  test("retries a thrown fetch once, then succeeds (keyless CSV)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network 503")).mockResolvedValueOnce(csvOk());
    expect(await fetchSeries("BAMLH0A0HYM2")).toEqual(EXPECTED);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urls().every((u) => u.startsWith("https://fred.stlouisfed.org"))).toBe(true);
  });

  test("unset FRED_API_KEY: keyless CSV only, never touches the api.stlouisfed.org host", async () => {
    fetchMock.mockResolvedValueOnce(csvOk());
    expect(await fetchSeries("DGS10")).toEqual(EXPECTED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urls()[0]).toContain("fred.stlouisfed.org/graph/fredgraph.csv");
    expect(urls().some((u) => u.includes("api.stlouisfed.org"))).toBe(false);
  });

  test("FRED_API_KEY set: keyed JSON API is the primary path", async () => {
    env.FRED_API_KEY = "testkey";
    fetchMock.mockResolvedValueOnce(jsonOk());
    expect(await fetchSeries("DGS10")).toEqual(EXPECTED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = urls()[0]!;
    expect(url).toContain("api.stlouisfed.org/fred/series/observations");
    expect(url).toContain("series_id=DGS10");
    expect(url).toContain("api_key=testkey");
    expect(url).toContain("file_type=json");
  });

  test("FRED_API_KEY set but the API fails: falls back to the keyless CSV path", async () => {
    env.FRED_API_KEY = "testkey";
    // Keyed API 500s on both attempts (retry), then the keyless CSV succeeds.
    fetchMock
      .mockResolvedValueOnce(err500())
      .mockResolvedValueOnce(err500())
      .mockResolvedValueOnce(csvOk());
    expect(await fetchSeries("DGS10")).toEqual(EXPECTED);
    const seen = urls();
    expect(seen.slice(0, 2).every((u) => u.includes("api.stlouisfed.org"))).toBe(true);
    expect(seen.at(-1)).toContain("fred.stlouisfed.org/graph/fredgraph.csv");
  });

  describe("FRED-wide outage (fredOutage)", () => {
    // 2026-10-21 shape: FRED served an HTML page instead of data on both paths.
    const html = () => new Response("<!doctype html><html></html>", { status: 200 });
    beforeEach(() => {
      clearRunBudget();
      startFredMemo();
    });
    afterEach(() => {
      stopFredMemo();
      clearRunBudget();
    });

    test("a FRED fetch the run budget aborted counts as unserved - a hang is an outage too", async () => {
      env.FRED_API_KEY = "testkey";
      startRunBudget(1, performance.now());
      await budgetLapse();
      fetchMock.mockRejectedValue(new Error("run fetch budget of 1ms exhausted - feed aborted"));
      for (const s of ["A", "B", "C"]) await expect(fetchSeries(s)).rejects.toThrow();
      expect(fredOutage()?.summaries).toEqual(["run fetch budget exhausted"]);
    });

    const run = async (bad: number, good: number) => {
      fetchMock.mockImplementation(async (url: string) => (String(url).includes("BAD") ? html() : csvOk()));
      for (let i = 0; i < bad; i++) await expect(fetchSeries(`BAD${i}`)).rejects.toThrow();
      for (let i = 0; i < good; i++) await fetchSeries(`OK${i}`);
      return fredOutage();
    };

    test("most series failing on every path is an outage, with the series-free cause", async () => {
      env.FRED_API_KEY = "testkey"; // keyed AND keyless both fail
      const o = await run(3, 3);
      expect(o?.failed).toEqual(["BAD0", "BAD1", "BAD2"]);
      expect(o?.total).toBe(6);
      expect(o?.summaries).toHaveLength(1);
      expect(o?.summaries[0]).toContain("<!doctype html>");
    });

    test.each([
      ["below the minimum failed count", FRED_OUTAGE_MIN_FAILED - 1, 0],
      ["failures a minority of the run's series", FRED_OUTAGE_MIN_FAILED, FRED_OUTAGE_MIN_FAILED + 1],
    ])("no outage when %s", async (_case, bad, good) => {
      expect(FRED_OUTAGE_MIN_FAILED).toBeGreaterThan(1);
      expect(await run(bad, good)).toBeNull();
    });
  });

  // WHICH PATH SERVED — the fallback above is data-identical, so the ONLY observable difference
  // between "keyed served" and "keyed died and keyless served" is this trace. `console.warn` alone
  // left the question unanswerable in prod (Vercel retains no past cron logs), which is the blind
  // spot the collector exists to close; run-cycle-persist.ts folds a drained batch onto the alert row.
  //
  // Two tests, because either alone is vacuous: the RECORD test passes against an implementation
  // that pushes unconditionally, and the SILENT test passes against one that never pushes at all.
  describe("keyed→keyless fallback trace (drainKeyedFallbacks)", () => {
    // Module-level collector, and the shared suite pass runs with `--no-isolate` — so a sibling
    // test's leftover would leak in. Clear before each, and assert on the drained batch only.
    // Same for the module-level run budget: an aborted deadline left open here would suppress
    // every later test's collector (and every other file's feed fetches) in the shared pass.
    beforeEach(() => {
      resetKeyedFallbacks();
      clearRunBudget();
    });
    afterEach(() => clearRunBudget());

    /** One keyed failure (500 on both keyed attempts), then the keyless CSV serves. */
    const oneKeyedFallback = async (series: string) => {
      env.FRED_API_KEY = "testkey";
      fetchMock.mockResolvedValueOnce(err500()).mockResolvedValueOnce(err500()).mockResolvedValueOnce(csvOk());
      await fetchSeries(series);
    };

    test("records the failing series + a series-free summary carrying the upstream status", async () => {
      await oneKeyedFallback("BAMLH0A0HYM2");

      const drained = drainKeyedFallbacks();
      expect(drained).toHaveLength(1);
      expect(drained[0]!.series).toBe("BAMLH0A0HYM2");
      // The summary carries the upstream status ON THE NON-OK-RESPONSE PATH (this one), so a
      // persisted trace distinguishes a dead key (401/429) from a transient FRED outage (5xx).
      // The other two paths into this collector carry no status: an empty parse summarises as
      // "0 observations", and a network/timeout throw carries only its own message.
      expect(drained[0]!.summary).toContain("500");
      // ...and it must NOT carry the series id: the drain dedups on this string, and the flagship
      // failure (an expired key 401-ing every FRED term) is exactly N copies of ONE cause.
      expect(drained[0]!.summary).not.toContain("BAMLH0A0HYM2");
    });

    test("the drain is one-shot - a second call sees an empty collector", async () => {
      await oneKeyedFallback("DGS10");
      // Vacuity guard, not a masking assertion: `beforeEach` clears via `resetKeyedFallbacks`,
      // which does not go through `splice` — so a `splice(0)`→`slice(0)` mutation leaves this
      // first drain at 1 and reds the SECOND expect, the one the test is about.
      expect(drainKeyedFallbacks()).toHaveLength(1);
      expect(drainKeyedFallbacks()).toEqual([]);
    });

    test("resetKeyedFallbacks clears without draining - a warm container starts each run clean", async () => {
      // The leak this closes: run-seeds.ts fetches in the post-recordRun tail, BELOW run-cycle's
      // drain, so on a warm lambda a tail failure would be stamped on the NEXT run's alert row.
      await oneKeyedFallback("DGS10");
      resetKeyedFallbacks();
      expect(drainKeyedFallbacks()).toEqual([]);
    });

    test.each([
      ["the keyed path succeeds - a healthy run's trace is unchanged", "testkey", jsonOk],
      ["there is no key - the keyless-only path is not a 'fallback'", undefined, csvOk],
    ])("silent when %s", async (_case, key, ok) => {
      if (key !== undefined) env.FRED_API_KEY = key;
      fetchMock.mockResolvedValueOnce(ok());
      expect(await fetchSeries("DGS10")).toEqual(EXPECTED);
      expect(drainKeyedFallbacks()).toEqual([]);
    });

    test("silent when the RUN BUDGET aborted the keyed attempt - not a keyed-API rejection", async () => {
      // The run-wide deadline (fetch-budget.ts) aborts every in-flight and subsequent fetch, so
      // the keyed attempt lands in the same catch as a 500. Recording it would headline "keyed
      // API fell back to keyless CSV" for a series the keyed endpoint never rejected — and the
      // run already reports that cause once, explicitly, as BUDGET_ABORT_SCOPE.
      env.FRED_API_KEY = "testkey";
      startRunBudget(1, performance.now());
      await budgetLapse();
      const aborted = () => Promise.reject(new Error("run fetch budget of 1ms exhausted - feed aborted"));
      fetchMock.mockImplementationOnce(aborted).mockImplementationOnce(aborted).mockResolvedValueOnce(csvOk());
      // Bystander, and it describes the MOCK, not production: `fetch` is injected, so the keyless
      // retry resolves here. In a real run it composes onto the same already-aborted deadline
      // (`runFetchSignal` → `AbortSignal.any`) and aborts too — the series is simply absent. Only
      // the assertion below is the contract: whatever the keyless leg does, the trace stays silent.
      expect(await fetchSeries("DGS10")).toEqual(EXPECTED);
      expect(drainKeyedFallbacks()).toEqual([]);
    });
  });

  // PER-RUN MEMO wiring. The memo's own contract (unarmed default, rejection eviction, re-arm) is
  // pinned once in run-memo.test.ts; this proves `fetchSeries` rides it with fred's key and copy.
  describe("per-run memo (startFredMemo / stopFredMemo)", () => {
    // Module-level state under a `--no-isolate` shared pass — arm inside the block and DISARM after,
    // or every sibling test in the run silently stops seeing its own fetches go to the wire.
    beforeEach(() => startFredMemo());
    afterEach(() => stopFredMemo());

    test("collapses a duplicate (series, window) to ONE fetch, own arrays; `fullHistory` is a DISTINCT key", async () => {
      // The ruled-out optimization, pinned as a prohibition: serving the short window from a slice
      // of the long one is where a leading observation goes missing.
      fetchMock.mockImplementation(() => Promise.resolve(csvOk()));
      const [a, b] = await Promise.all([
        fetchSeries("DGS3MO"),
        fetchSeries("DGS3MO"),
        fetchSeries("DGS3MO", { fullHistory: true }),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [bounded, deep] = urls();
      expect(bounded).toContain("cosd=");
      expect(deep).not.toContain("cosd=");
      expect(a).toEqual(EXPECTED);
      expect(b).toEqual(EXPECTED);
      expect(a).not.toBe(b); // a hit returns its OWN array — an in-place sort cannot reach a sibling caller
    });
  });

  // VXSMH is served by the volatility-index port ONLY (FRED carries no copy) and is not a refused id, so every run
  // still routes it there. The production binding throws `NoFreeSourceError`; the injected source below stands in for
  // the port's contract (whole history, memoized per run, intraday flag, no FRED fallback).
  describe("vol-index-only route (VXSMH)", () => {
    const VOL_ROWS = [
      { date: "2026-09-24", value: 31.2 },
      { date: "2026-09-25", value: 29.8 },
    ];
    const isVol = (u: string) => u.startsWith("vol:");
    /** The injected source: its wire is `fetchMock` at `vol:<symbol>`, so one mock answers both legs. */
    const volSource = vi.fn<VolIndexFetch>(async (symbol, deps) => {
      const r = await (deps.fetchImpl ?? fetch)(`vol:${symbol}`);
      if (!r.ok) throw new Error(`vol-index fetch failed for ${symbol}: ${r.status}`);
      return VOL_ROWS.map((o) => ({ ...o }));
    });
    const volOk = () => new Response("", { status: 200 });
    const fetchVol = (opts: { fullHistory?: boolean; since?: string } = {}) =>
      fetchSeriesWith("VXSMH", { ...opts, fetchImpl: fetchMock as unknown as FetchLike, env, sleep: noSleep, now: now ?? new Date(), fetchVolIndexCloses: volSource });
    beforeEach(() => {
      now = new Date("2026-09-26T12:00:00Z");
      volSource.mockClear();
      clearRunBudget();
    });
    afterEach(() => stopFredMemo());

    test("the production binding: rejects NoFreeSourceError without a FRED fallback", async () => {
      fetchMock.mockImplementation(async () => csvOk());
      await expect(fetchSeries("VXSMH")).rejects.toBeInstanceOf(NoFreeSourceError);
      expect(urls()).toEqual([]);
    });

    test("an unbound direct fetch throws naming the missing source, before any request", async () => {
      const deps = { fetchImpl: fetchMock as unknown as FetchLike, env, sleep: noSleep, now: now! };
      await expect(fetchSeriesUnbound("VXSMH", deps)).rejects.toThrow("no volatility-index source bound for VXSMH");
      expect(urls()).toEqual([]);
    });

    test("serves the source's closes windowed by `since`; `fullHistory` serves them all; FRED is never asked", async () => {
      fetchMock.mockImplementation(async () => volOk());
      expect(await fetchVol({ since: "2026-09-25" })).toEqual([{ date: "2026-09-25", value: 29.8 }]);
      expect(await fetchVol({ fullHistory: true })).toEqual(VOL_ROWS);
      expect(urls()).toEqual(["vol:VXSMH", "vol:VXSMH"]); // unarmed memo: every call reaches the source
    });

    test("a source failure throws through — no FRED request", async () => {
      fetchMock.mockImplementation(async (u: string) => (isVol(u) ? err500() : csvOk()));
      await expect(fetchVol()).rejects.toThrow("vol-index fetch failed for VXSMH: 500");
      expect(urls()).toEqual(["vol:VXSMH"]);
    });

    test("an armed run memo costs ONE source attempt per symbol across windows — a rejection included", async () => {
      startFredMemo();
      fetchMock.mockImplementation(async () => volOk());
      const a = await fetchVol({ since: "2026-09-25" });
      const b = await fetchVol({ fullHistory: true });
      expect(a).toEqual([{ date: "2026-09-25", value: 29.8 }]);
      expect(b).toEqual(VOL_ROWS);
      expect(volSource).toHaveBeenCalledTimes(1);

      startFredMemo(); // a new run re-arms with an empty memo
      volSource.mockClear();
      fetchMock.mockImplementation(async () => err500());
      await expect(fetchVol({ since: "2026-09-25" })).rejects.toThrow(/500/);
      await expect(fetchVol({ fullHistory: true })).rejects.toThrow(/500/);
      expect(volSource).toHaveBeenCalledTimes(1);
    });

    test.each([false, true])("startFredMemo({ intraday: %s }) hands the source that flag, with the caller's fetch and clock", async (intraday) => {
      startFredMemo({ intraday });
      fetchMock.mockImplementation(async () => volOk());
      await fetchVol({ since: "2026-09-24" });
      expect(volSource.mock.calls).toEqual([["VXSMH", { fetchImpl: fetchMock, now, intraday }]]);
      // Disarming resets the flag: an off-cron caller never inherits a run's intraday mode.
      stopFredMemo();
      volSource.mockClear();
      await fetchVol({ since: "2026-09-24" });
      expect(volSource.mock.calls[0]![1].intraday).toBe(false);
    });
  });
});
