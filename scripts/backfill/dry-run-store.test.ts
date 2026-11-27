/**
 * `makeDryRunStore` seam — the `deleteReadingsOnDates` tally branch and the
 * deny-by-default fallthrough the whole file exists for. Tested directly against a spy store,
 * never through the backfill runner.
 */
import { describe, expect, it, vi } from "vitest";

import { makeDryRunStore } from "./dry-run-store.js";
import type { Store } from "../../src/store.js";

/** A store whose `deleteReadingsOnDates` throws if ever reached — a dry run must never call it. */
function spyStore(): Store {
  return {
    deleteReadingsOnDates: vi.fn(() => {
      throw new Error("deleteReadingsOnDates reached the underlying store during a dry run");
    }),
    deleteEstimatesOnDates: vi.fn(() => {
      throw new Error("deleteEstimatesOnDates reached the underlying store during a dry run");
    }),
    deleteNonEstimatesOnDates: vi.fn(() => {
      throw new Error("deleteNonEstimatesOnDates reached the underlying store during a dry run");
    }),
    // A genuine but unclassified write method — the deny-by-default fallthrough must throw on it.
    wipeAll: () => {
      throw new Error("wipeAll reached the underlying store during a dry run");
    },
  } as unknown as Store;
}

describe("makeDryRunStore deleteReadingsOnDates", () => {
  it("tallies date count by id and never calls the underlying store", async () => {
    const under = spyStore();
    const { store, tally } = makeDryRunStore(under);
    const ret = await store.deleteReadingsOnDates("FXH", ["2026-01-01", "2026-01-02", "2026-01-03"]);
    expect(ret).toBe(0);
    expect(tally.deletes.FXH).toBe(3);
    expect((under.deleteReadingsOnDates as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("the estimate-only and non-estimate dated deletes tally too, never reaching the store", async () => {
    const under = spyStore();
    const { store, tally } = makeDryRunStore(under);
    expect(await store.deleteEstimatesOnDates("G1", ["2026-10-01"])).toBe(0);
    expect(await store.deleteNonEstimatesOnDates("G1", ["2026-10-02", "2026-10-03"])).toBe(0);
    expect(tally.deletes.G1).toBe(3);
    expect(under.deleteEstimatesOnDates as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(under.deleteNonEstimatesOnDates as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("deny-by-default: throws for an unclassified method name", () => {
    const { store } = makeDryRunStore(spyStore());
    // `wipeAll` is a real method but neither a read (`get*`/`checkSchema`/`maxRowsProbe`) nor a tallied write.
    expect(() => (store as unknown as Record<string, unknown>).wipeAll).toThrow(
      /refusing to call unclassified Store method/,
    );
  });
});
