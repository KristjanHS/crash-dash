import { describe, expect, it, vi } from "vitest";
import { stitchHyOas } from "./hyoas-history.js";

const obs = (date: string, value: number) => ({ date, value });

describe("stitchHyOas", () => {
  it("stitches vintage + live tail, preferring live values on overlap", () => {
    const vintage = [obs("2025-04-08", 4.3), obs("2025-04-09", 4.37), obs("2025-04-10", 4.42)];
    const live = [obs("2025-04-09", 4.37), obs("2025-04-10", 4.41), obs("2025-04-11", 4.5)];
    expect(stitchHyOas(vintage, live)).toEqual([
      obs("2025-04-08", 4.3),
      obs("2025-04-09", 4.37),
      obs("2025-04-10", 4.41), // live preferred (within ±0.01)
      obs("2025-04-11", 4.5),
    ]);
  });

  it("prefers the live value and calls onDisagree on a sub-gross disagreement (FRED revision)", () => {
    const vintage = [obs("2025-04-09", 4.37), obs("2025-04-10", 4.42)];
    const live = [obs("2025-04-10", 4.44)]; // 0.02 — beyond noting tolerance, below gross
    const onDisagree = vi.fn();
    expect(stitchHyOas(vintage, live, onDisagree)).toEqual([
      obs("2025-04-09", 4.37),
      obs("2025-04-10", 4.44),
    ]);
    expect(onDisagree).toHaveBeenCalledTimes(1);
    expect(onDisagree.mock.calls[0]?.[0]).toMatch(/2025-04-10/);
  });

  it("stays silent within the ±0.01 noting tolerance", () => {
    const vintage = [obs("2025-04-10", 4.42)];
    const live = [obs("2025-04-10", 4.41)];
    const onDisagree = vi.fn();
    expect(stitchHyOas(vintage, live, onDisagree)).toEqual([obs("2025-04-10", 4.41)]);
    expect(onDisagree).not.toHaveBeenCalled();
  });

  it("throws with the offending date when overlap disagrees beyond the gross tolerance", () => {
    const vintage = [obs("2025-04-09", 4.37), obs("2025-04-10", 4.42)];
    const live = [obs("2025-04-10", 4.72)]; // 0.30 — vintage corruption territory
    expect(() => stitchHyOas(vintage, live)).toThrow(/2025-04-10/);
  });

  it("throws when the live tail starts more than 7 days after the vintage ends", () => {
    const vintage = [obs("2025-04-10", 4.42)];
    const live = [obs("2025-04-19", 4.5)];
    expect(() => stitchHyOas(vintage, live)).toThrow(/gap/);
  });

  it("accepts a live tail starting within the 7-day grace window", () => {
    const vintage = [obs("2025-04-10", 4.42)];
    const live = [obs("2025-04-18", 4.5)];
    expect(stitchHyOas(vintage, live)).toEqual([obs("2025-04-10", 4.42), obs("2025-04-18", 4.5)]);
  });

  it("throws on an empty vintage or empty live tail", () => {
    expect(() => stitchHyOas([], [obs("2025-04-10", 4.42)])).toThrow(/empty vintage/);
    expect(() => stitchHyOas([obs("2025-04-10", 4.42)], [])).toThrow(/empty live tail/);
  });
});
