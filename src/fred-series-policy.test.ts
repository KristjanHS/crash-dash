import { describe, expect, it, vi } from "vitest";
import { fetchSeries } from "./fred.js";
import { NoFreeSourceError } from "./no-free-source.js";

describe("fetchSeries refuses a refused id", () => {
  it("rejects NoFreeSourceError before the wire or the volatility-index port", async () => {
    const fetchImpl = vi.fn();
    const fetchVolIndexCloses = vi.fn();
    // A refused id with no vol-index route: the refusal fronts the FRED wire.
    await expect(
      fetchSeries("VIXCLS", {
        fetchImpl,
        fetchVolIndexCloses,
        refusedSeries: new Set(["VIXCLS"]),
        env: { FRED_API_KEY: "k" },
        now: new Date("2026-11-20T22:00:00Z"),
      }),
    ).rejects.toBeInstanceOf(NoFreeSourceError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fetchVolIndexCloses).not.toHaveBeenCalled();
  });

  it("rejects a refused vol-index-route id (VXSMH) before the volatility-index port", async () => {
    // VXSMH is the one id `fetchWindow` serves through the vol-index port; refusing it here proves
    // the refusal sits ahead of that branch, not just ahead of the FRED wire.
    const fetchImpl = vi.fn();
    const fetchVolIndexCloses = vi.fn();
    await expect(
      fetchSeries("VXSMH", {
        fetchImpl,
        fetchVolIndexCloses,
        refusedSeries: new Set(["VXSMH"]),
        env: { FRED_API_KEY: "k" },
        now: new Date("2026-11-20T22:00:00Z"),
      }),
    ).rejects.toBeInstanceOf(NoFreeSourceError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fetchVolIndexCloses).not.toHaveBeenCalled();
  });
});
