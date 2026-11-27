/**
 * The shared per-run memo's contract, pinned once for its three feed adapters (`fred.ts`, `treasury.ts`,
 * `prices.ts`) — each adapter's own suite keeps ONE wiring test proving its fetch path rides this memo.
 * Pure: loaders are `vi.fn`s, no global seam, so this file stays in the shared vitest project.
 */
import { describe, expect, test, vi } from "vitest";
import { runMemo } from "./run-memo.js";

/** A promise settled by hand, so a test controls exactly when a load resolves or rejects. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A hand-advanced clock for `ttlMs` tests: deterministic, no wall-clock dependency. */
function counterClock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

function countingLoad() {
  let n = 0;
  return () => Promise.resolve(++n);
}

describe("runMemo", () => {
  test("UNARMED by default and after stop(); start() arms a FRESH memo, dropping every entry", async () => {
    const memo = runMemo<string, number>();
    const load = countingLoad();
    expect([await memo.get("k", load), await memo.get("k", load)]).toEqual([1, 2]);
    memo.start();
    expect([await memo.get("k", load), await memo.get("k", load)]).toEqual([3, 3]);
    memo.start(); // a re-armed run never serves the last run's value
    expect(await memo.get("k", load)).toBe(4);
    memo.stop();
    expect(await memo.get("k", load)).toBe(5);
  });

  test("`armed: true` memoizes from construction and, without `copy`, hands every caller the one shared value", async () => {
    const memo = runMemo<string, number[]>({ armed: true });
    const load = vi.fn(() => Promise.resolve([1]));
    const a = await memo.get("k", load);
    expect(await memo.get("k", load)).toBe(a);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("armed: concurrent callers share ONE in-flight load, and a later call is a hit", async () => {
    const memo = runMemo<string, number[]>();
    memo.start();
    const d = deferred<number[]>();
    const load = vi.fn(() => d.promise);
    const a = memo.get("k", load);
    const b = memo.get("k", load);
    expect(load).toHaveBeenCalledTimes(1);
    d.resolve([7]);
    expect(await a).toEqual([7]);
    expect(await b).toEqual([7]);
    expect(await memo.get("k", load)).toEqual([7]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("keys are separate: distinct keys each load and each serve their own value", async () => {
    const memo = runMemo<string, string>();
    memo.start();
    const load = vi.fn((v: string) => Promise.resolve(v));
    await memo.get("a", () => load("A"));
    await memo.get("b", () => load("B"));
    expect(load).toHaveBeenCalledTimes(2);
    expect(await memo.get("a", () => load("X"))).toBe("A");
    expect(await memo.get("b", () => load("X"))).toBe("B");
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("a REJECTED load is evicted: the next get re-loads instead of serving the failure", async () => {
    const memo = runMemo<string, number>();
    memo.start();
    const load = vi.fn().mockRejectedValueOnce(new Error("503")).mockResolvedValueOnce(2);
    await expect(memo.get("k", load)).rejects.toThrow("503");
    expect(await memo.get("k", load)).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("a rejection settling after a re-arm evicts from ITS run only, never the new run's entry", async () => {
    const memo = runMemo<string, number>();
    memo.start();
    const old = deferred<number>();
    const stale = memo.get("k", () => old.promise);
    memo.start();
    const load = countingLoad();
    expect(await memo.get("k", load)).toBe(1);
    old.reject(new Error("late"));
    await expect(stale).rejects.toThrow("late");
    expect(await memo.get("k", load)).toBe(1);
  });

  test("`ttlMs`: an expired entry re-loads; one inside its TTL is a hit", async () => {
    const clock = counterClock();
    const memo = runMemo<string, number>({ armed: true, ttlMs: 50, now: clock.now });
    const load = countingLoad();
    expect(await memo.get("k", load)).toBe(1);
    clock.advance(49); // still inside its TTL
    expect(await memo.get("k", load)).toBe(1);
    clock.advance(1); // expiry is exclusive: at exactly ttlMs the entry is stale
    expect(await memo.get("k", load)).toBe(2);
  });

  test("an expired entry's late rejection never evicts the fresh entry that replaced it", async () => {
    const clock = counterClock();
    const memo = runMemo<string, number>({ armed: true, ttlMs: 50, now: clock.now });
    const first = deferred<number>();
    const stale = memo.get("k", () => first.promise);
    clock.advance(60); // the first entry expires while its load is still in flight
    const load = countingLoad();
    expect(await memo.get("k", load)).toBe(1);
    first.reject(new Error("late"));
    await expect(stale).rejects.toThrow("late");
    expect(await memo.get("k", load)).toBe(1);
  });

  test("`copy` runs on every value handed out — hit, miss and unarmed — so a caller cannot poison a sibling", async () => {
    const memo = runMemo<string, number[]>({ copy: (v) => v.slice() });
    memo.start();
    const loaded = [1, 2];
    const load = vi.fn(() => Promise.resolve(loaded));
    const [miss, hit] = await Promise.all([memo.get("k", load), memo.get("k", load)]);
    miss.length = 0;
    expect(await memo.get("k", load)).toEqual([1, 2]);
    memo.stop();
    const unarmed = await memo.get("k", load);
    expect([miss, hit, unarmed].map((v) => v === loaded)).toEqual([false, false, false]);
    expect([hit, unarmed]).toEqual([[1, 2], [1, 2]]);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
