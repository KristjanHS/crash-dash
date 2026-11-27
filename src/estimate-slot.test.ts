import { describe, expect, test } from "vitest";
import { estimateSlot } from "./estimate-slot.js";

const final = (date: string, value: number | null = 1) => ({ date, value });
const est = (date: string, value: number | null = 2) => ({ date, value, estimated: true });

describe("estimateSlot (the served estimate is the stored `estimated` tail)", () => {
  test("estimated newest point ⇒ its date/value, fromDate = the newest final before it", () => {
    expect(estimateSlot([final("2026-10-01"), final("2026-10-02"), est("2026-10-05", 4.3)])).toEqual({
      date: "2026-10-05",
      value: 4.3,
      fromDate: "2026-10-02",
    });
  });

  test("multi-day estimated tail ⇒ the NEWEST estimate, anchored on the print before the whole tail", () => {
    expect(estimateSlot([final("2026-10-01"), est("2026-10-02", 3), est("2026-10-05", 5)])).toEqual({
      date: "2026-10-05",
      value: 5,
      fromDate: "2026-10-01",
    });
  });

  test("a provisional newest estimate ⇒ `provisional: true`; an EOD one ⇒ the key absent", () => {
    const intraday = estimateSlot([final("2026-10-01"), { ...est("2026-10-02"), provisional: true }]);
    expect([intraday?.provisional, "provisional" in estimateSlot([final("2026-10-01"), est("2026-10-02")])!]).toEqual([true, false]);
  });

  test.each<{ name: string; points: Parameters<typeof estimateSlot>[0] }>([
    { name: "newest point not estimated, even with an older estimated row", points: [final("2026-10-01"), est("2026-10-02"), final("2026-10-05")] },
    { name: "estimated tail with no final before it", points: [est("2026-10-02"), est("2026-10-05")] },
    { name: "empty list", points: [] },
    { name: "a null (warm-up gap) estimated value", points: [final("2026-10-01"), est("2026-10-02", null)] },
  ])("$name ⇒ null", ({ points }) => {
    expect(estimateSlot(points)).toBeNull();
  });
});
