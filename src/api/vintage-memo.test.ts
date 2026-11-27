/**
 * Contract tests for `memoByVintage` (P12.a): same-vintage dedupe, replace-on-new-vintage
 * (one entry per name), retry-after-rejection, and the empty-key bypass.
 */
import { beforeEach, describe, expect, test } from "vitest";

import { memoByVintage, resetVintageMemo } from "./vintage-memo.js";

beforeEach(() => resetVintageMemo());

describe("memoByVintage", () => {
  test("same firedAt: the loader runs ONCE across 3 calls, all resolving the same value", async () => {
    let runs = 0;
    const loader = async () => ({ n: ++runs });
    const [a, b, c] = await Promise.all([
      memoByVintage("synth", "2026-09-01T21:00:00Z", loader),
      memoByVintage("synth", "2026-09-01T21:00:00Z", loader),
      memoByVintage("synth", "2026-09-01T21:00:00Z", loader),
    ]);
    expect(runs).toBe(1);
    // Same PROMISE, not merely equal values — the concurrent-MISS dedupe is the point.
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("a new firedAt reruns the loader and EVICTS the old entry (one entry per name)", async () => {
    let runs = 0;
    const loader = async () => ++runs;
    expect(await memoByVintage("synth", "v1", loader)).toBe(1);
    expect(await memoByVintage("synth", "v2", loader)).toBe(2); // rerun on the new vintage
    // The old entry is GONE: asking for v1 again must re-run, never serve the stale cache.
    expect(await memoByVintage("synth", "v1", loader)).toBe(3);
  });

  test("names are independent entries", async () => {
    let runs = 0;
    const loader = async () => ++runs;
    expect(await memoByVintage("synth", "v1", loader)).toBe(1);
    expect(await memoByVintage("ciss", "v1", loader)).toBe(2);
    expect(await memoByVintage("synth", "v1", loader)).toBe(1); // still cached
  });

  test("a rejected loader deletes its entry: the next call RETRIES and can succeed", async () => {
    let runs = 0;
    const loader = async () => {
      runs += 1;
      if (runs === 1) throw new Error("transient");
      return "ok";
    };
    await expect(memoByVintage("synth", "v1", loader)).rejects.toThrow("transient");
    expect(await memoByVintage("synth", "v1", loader)).toBe("ok");
    expect(runs).toBe(2);
  });

  test("cacheIf false: the value is RETURNED but not cached - the next call retries", async () => {
    let runs = 0;
    const loader = async () => new Map(runs++ === 0 ? [] : [["F3", 1]]);
    const cacheIf = (m: Map<string, number>) => m.size > 0;
    const first = await memoByVintage("synth", "v1", loader, { cacheIf });
    expect(first.size).toBe(0); // the degraded value still reaches THIS caller
    expect(await memoByVintage("synth", "v1", loader, { cacheIf })).toBe(
      await memoByVintage("synth", "v1", loader, { cacheIf }), // retried once, then cached
    );
    expect(runs).toBe(2);
  });

  test("no cacheIf: an empty value is cached regardless (opt-in only)", async () => {
    let runs = 0;
    const loader = async () => (runs++, new Map());
    expect((await memoByVintage("synth", "v1", loader)).size).toBe(0);
    expect((await memoByVintage("synth", "v1", loader)).size).toBe(0);
    expect(runs).toBe(1);
  });

  test.each([["" as string], [null], [undefined]])(
    "empty/absent firedAt (%j) BYPASSES the memo: every call runs the loader, nothing cached",
    async (key) => {
      let runs = 0;
      const loader = async () => ++runs;
      expect(await memoByVintage("synth", key, loader)).toBe(1);
      expect(await memoByVintage("synth", key, loader)).toBe(2);
      // …and a bypass call never poisoned the map for a real vintage either.
      expect(await memoByVintage("synth", "v1", loader)).toBe(3);
      expect(await memoByVintage("synth", "v1", loader)).toBe(3);
    },
  );
});
