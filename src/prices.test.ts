/**
 * prices.ts close-source router: no free source — `NoFreeSourceError` before any request, and the deep-only
 * `lookbackDays` guard. `fetch` and the clock are handed in as `PriceDeps` (no global stub) — no test hits the network.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { NoFreeSourceError } from "./no-free-source.js";
import type { PriceDeps } from "./price-cache.js";
import { fetchDailyCloses, startPriceFeed } from "./prices.js";

const NOW = Date.parse("2026-06-26T12:00:00Z");
const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
const io: PriceDeps = { fetchImpl: fetchMock, env: {}, now: () => NOW };

// Shared project: `startPriceFeed()` clears the memo AND drops an earlier file's run-cycle intraday latch.
beforeEach(() => {
  startPriceFeed();
  fetchMock.mockClear();
});

describe("fetchDailyCloses: no free source", () => {
  test("an index / FX / futures / exchange-suffixed symbol throws NoFreeSourceError before any request", async () => {
    for (const sym of ["^VIX", "^MOVE", "EURUSD=X", "HG=F", "EXSH.DE"]) {
      const err = await fetchDailyCloses(sym, io).catch((e: unknown) => e);
      expect(err, sym).toBeInstanceOf(NoFreeSourceError);
      expect((err as NoFreeSourceError).symbol).toBe(sym);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an intraday run throws NoFreeSourceError", async () => {
    try {
      startPriceFeed({ intraday: true });
      await expect(fetchDailyCloses("SPY", io)).rejects.toBeInstanceOf(NoFreeSourceError);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      startPriceFeed(); // disarm: EOD for every later test
    }
  });

  // A shallow caller passing `lookbackDays` used to get a 2y window and no warning: that is how R6's 1500d ask
  // shipped inert on 2026-08-30.
  test("throws when lookbackDays is passed without deep — the bound would be silently dropped", async () => {
    await expect(fetchDailyCloses("SPY", { env: {}, lookbackDays: 1500, now: () => NOW })).rejects.toThrow(/deep-only/);
  });
});
