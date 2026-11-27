import { describe, expect, test } from "vitest";
import { mapLimit } from "./map-limit.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

describe("mapLimit - bounded fan-out", () => {
  test("never more than `limit` in flight, results in input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 4, 3, 2, 1, 0], 3, async (x) => {
      peak = Math.max(peak, ++inFlight);
      await tick();
      inFlight--;
      return x * 10;
    });
    expect(peak).toBe(3);
    expect(out).toEqual([50, 40, 30, 20, 10, 0]);
  });

  test("a rejection rejects the call and starts no further item", async () => {
    const started: number[] = [];
    await expect(
      mapLimit([0, 1, 2, 3, 4, 5], 2, async (x) => {
        started.push(x);
        await tick();
        if (x === 0) throw new Error("boom");
        return x;
      }),
    ).rejects.toThrow("boom");
    for (let i = 0; i < 10; i++) await tick();
    expect(started).toEqual([0, 1]);
  });
});
