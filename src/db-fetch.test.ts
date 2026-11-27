import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DB_CALL_TIMEOUT_MS, dbFetch, dbStats, dbStatsLine, resetDbStats } from "./db-fetch.js";
import {
  MAX_COLD_OFFSET_MS,
  RUN_FETCH_BUDGET_MS,
  RUN_HARD_DEADLINE_MS,
  RUN_TRACE_DEADLINE_MS,
  clearRunBudget,
  markRunAnchor,
  openTraceWindow,
  runBudgetExhausted,
  runHardDeadline,
  runMsUntilHardDeadline,
  startRunBudget,
} from "./fetch-budget.js";
import { SupabaseStore, type AlertRecord } from "./store.js";
import { persistRunTrace } from "./run-cycle-persist.js";
import type { RunBase } from "./run-cycle-ctx.js";

/** A fetch that never answers until its signal aborts — a stalled PostgREST call. */
const hungFetch = vi.fn(
  (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error), { once: true });
    }),
);

/** `startRunBudget`'s anchor line — captured, never printed. */
const log = vi.fn((_msg: string) => {});

beforeEach(() => {
  vi.useFakeTimers();
  log.mockClear();
  resetDbStats();
  clearRunBudget();
  hungFetch.mockClear();
});
afterEach(() => {
  clearRunBudget();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("dbFetch — per-call cap", () => {
  test("outside a run budget it adds no signal (backfills, read API)", async () => {
    const plain = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response("[]"));
    vi.stubGlobal("fetch", plain);
    await dbFetch("http://db.test/rest/v1/readings");
    expect(plain.mock.calls[0]![1]).toBeUndefined();
  });

  test("inside a run budget a stalled call aborts at DB_CALL_TIMEOUT_MS with its own message", async () => {
    vi.stubGlobal("fetch", hungFetch);
    startRunBudget(RUN_FETCH_BUDGET_MS, performance.now());
    const p = dbFetch("http://db.test/rest/v1/readings");
    const settled = expect(p).rejects.toThrow(`[db] call exceeded ${DB_CALL_TIMEOUT_MS}ms`);
    await vi.advanceTimersByTimeAsync(DB_CALL_TIMEOUT_MS - 1);
    expect(dbStats().failed).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(dbStats().failed).toBe(1);
  });
});

test("a stalled SupabaseStore GET aborts once at the cap — postgrest-js does not retry it", async () => {
  vi.stubGlobal("fetch", hungFetch);
  startRunBudget(RUN_FETCH_BUDGET_MS, performance.now());
  const p = new SupabaseStore("http://db.test", "key").getLastAlert({ notifyBaseline: true }); // a `.from().select()` GET — the retried shape
  const settled = expect(p).rejects.toThrow(`[db] call exceeded ${DB_CALL_TIMEOUT_MS}ms`);
  await vi.advanceTimersByTimeAsync(60_000);
  await settled;
  expect(hungFetch).toHaveBeenCalledTimes(1);
});

describe("run anchor — cold start charged to the budget and the DB hard deadline", () => {
  test("cold anchor: fetch budget and hard deadline both count from process start", async () => {
    const now = performance.now();
    markRunAnchor(now, 9_000);
    startRunBudget(45_000, now, log);
    await vi.advanceTimersByTimeAsync(45_000 - 9_000 - 1);
    expect(runBudgetExhausted()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(runBudgetExhausted()).toBe(true);
    expect(runHardDeadline()!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(RUN_HARD_DEADLINE_MS - 45_000);
    expect(runHardDeadline()!.aborted).toBe(true);
  });

  test("past the hard deadline, openTraceWindow lets the trace write run until RUN_TRACE_DEADLINE_MS", async () => {
    vi.stubGlobal("fetch", hungFetch);
    const now = performance.now();
    markRunAnchor(now, 0);
    startRunBudget(RUN_FETCH_BUDGET_MS, now, log);
    await vi.advanceTimersByTimeAsync(RUN_HARD_DEADLINE_MS);
    openTraceWindow(performance.now());
    const p = dbFetch("http://db.test/rest/v1/alert_log");
    const settled = expect(p).rejects.toThrow("[db] run trace deadline");
    await vi.advanceTimersByTimeAsync(RUN_TRACE_DEADLINE_MS - RUN_HARD_DEADLINE_MS);
    await settled;
  });

  test("persistRunTrace's write lands after the tail spent the hard deadline", async () => {
    // Answers at once — unless the signal already fired, as real fetch rejects.
    vi.stubGlobal("fetch", vi.fn(async (_i: Parameters<typeof fetch>[0], init?: RequestInit) => (init?.signal?.throwIfAborted(), new Response("[]"))));
    const now = performance.now();
    markRunAnchor(now, 0);
    startRunBudget(RUN_FETCH_BUDGET_MS, now, log);
    await vi.advanceTimersByTimeAsync(RUN_HARD_DEADLINE_MS);
    let landed = 0;
    const store = { updateRunTrace: async () => (await dbFetch("http://db.test/rest/v1/alert_log"), ++landed) };
    await persistRunTrace({ store } as unknown as RunBase, { firedAt: "2026-11-04T22:55:31.000Z", degraded: [] } as unknown as AlertRecord);
    expect(landed).toBe(1);
  });

  test("a call still in flight at the hard deadline aborts with the deadline message", async () => {
    vi.stubGlobal("fetch", hungFetch);
    const now = performance.now();
    markRunAnchor(now, 0);
    startRunBudget(45_000, now, log);
    await vi.advanceTimersByTimeAsync(RUN_HARD_DEADLINE_MS - 2_000);
    const p = dbFetch("http://db.test/rest/v1/alert_log");
    const settled = expect(p).rejects.toThrow("[db] run hard deadline");
    await vi.advanceTimersByTimeAsync(2_000);
    await settled;
  });

  test("warm (second) anchor charges nothing; cold offset clamps at MAX_COLD_OFFSET_MS", async () => {
    const now = performance.now();
    markRunAnchor(now, 60_000);
    startRunBudget(45_000, now, log);
    expect(log).toHaveBeenLastCalledWith(`[budget] anchor offset=${(MAX_COLD_OFFSET_MS / 1000).toFixed(1)}s (cold)`);
    markRunAnchor(now, 60_000);
    startRunBudget(45_000, now, log);
    expect(log).toHaveBeenLastCalledWith("[budget] anchor offset=0.0s (warm)");
  });

  test("a cold anchor on the run clock charges the process-uptime offset, clamped to [0, MAX_COLD_OFFSET_MS]", () => {
    markRunAnchor(performance.now());
    startRunBudget(RUN_FETCH_BUDGET_MS, performance.now(), log);
    const offsetS = Number(/anchor offset=(-?[\d.]+)s \(cold\)/.exec(String(log.mock.lastCall?.[0]))?.[1]);
    expect(offsetS).toBeGreaterThanOrEqual(0);
    expect(offsetS).toBeLessThanOrEqual(MAX_COLD_OFFSET_MS / 1000);
  });

  test("an un-anchored (CLI) budget arms no hard deadline", () => {
    startRunBudget(RUN_FETCH_BUDGET_MS, performance.now());
    expect(runHardDeadline()).toBeNull();
    expect(runMsUntilHardDeadline(performance.now())).toBe(Infinity);
  });

  test("runMsUntilHardDeadline counts down from the anchor (cold offset charged)", async () => {
    const now = performance.now();
    markRunAnchor(now, 9_000);
    startRunBudget(45_000, now, log);
    expect(runMsUntilHardDeadline(performance.now())).toBe(RUN_HARD_DEADLINE_MS - 9_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runMsUntilHardDeadline(performance.now())).toBe(RUN_HARD_DEADLINE_MS - 39_000);
    clearRunBudget();
    expect(runMsUntilHardDeadline(performance.now())).toBe(Infinity);
  });
});

describe("dbFetch — per-run tally", () => {
  test("counts calls, overlap and busy wall time", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((r) => setTimeout(() => r(new Response("[]")), 100))),
    );
    const a = dbFetch("http://db.test/a");
    await vi.advanceTimersByTimeAsync(50);
    const b = dbFetch("http://db.test/b");
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([a, b]);
    expect(dbStats()).toMatchObject({ calls: 2, maxInFlight: 2, busyMs: 150, slowestMs: 100 });
    expect(dbStatsLine()).toBe("[db] calls=2 failed=0 busy=0.1s maxInFlight=2 slowest=0.1s");
  });

  test("SupabaseStore routes its requests through dbFetch", async () => {
    const plain = vi.fn(async () => new Response("[]", { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", plain);
    await new SupabaseStore("http://db.test", "key").getEstimateDates(["F1"], "2026-10-01");
    expect(plain).toHaveBeenCalled();
    expect(dbStats().calls).toBe(plain.mock.calls.length);
  });
});
