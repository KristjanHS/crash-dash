/**
 * Tests for the cron HTTP wrapper (api/cron/run.ts). The route is a thin auth +
 * error-boundary shim around runScoringCycle; these assert the boundary, not the
 * scoring logic (covered by the src/run.*.test.ts suites).
 *
 * Every seam is injected through `handle(req, deps)` — no module mock, env write or fake
 * clock — so this file shares the module registry. `GET`'s wiring to the production seams is
 * pinned at the end: `CRON_DEPS` identity against the real imports + a scan of `GET`'s body.
 *
 * Regression guard (cron-failure-detection): a throw from the cycle MUST be
 * console.error'd, not just folded into the 500 body — otherwise a cron that
 * fails every run leaves no log trail (the prod schema-drift incident).
 */
import { readFileSync } from "node:fs";
import { invalidateByTag as realInvalidateByTag } from "@vercel/functions";
import { describe, expect, test, vi } from "vitest";
import { runScoringCycle as realRunScoringCycle, seedIntradayTail as realSeedIntradayTail } from "../../src/run-cycle.js";
import { cronSecret as realCronSecret, readEnv as realReadEnv, type Env } from "../../src/config.js";
import { VINTAGE_TAG } from "../../src/api/http.js";
import { CRON_DEPS, handle, type CronDeps } from "./run.js";

const SECRET = "test-secret";
// A sentinel env: the asserts below pin that the handler threads ITS one `readEnv()` value to the cycle + seed tail.
const ENV: Env = { NTFY_TOPIC: "cron-test-env" };
const req = (q = "", bearer: string | null = SECRET) =>
  new Request(`https://x/api/cron/run${q}`, bearer === null ? {} : { headers: { authorization: `Bearer ${bearer}` } });

const INTRADAY = new Date("2026-09-29T10:05:00Z");
const EOD = new Date("2026-09-29T22:00:00Z");

/** One injected world: every seam a recorder; `verdict` is what the cycle resolves to. */
function world(verdict: unknown = {}) {
  const order: string[] = [];
  const clock = { at: EOD };
  const deps = {
    // Models the cycle's contract: `onCommitted` fires at the commit point, then the EOD seed tail runs.
    runScoringCycle: vi.fn(async (...[, opts]: Parameters<CronDeps["runScoringCycle"]>) => {
      if (opts.onCommitted) {
        await opts.onCommitted();
        order.push("tail");
      }
      return verdict as Awaited<ReturnType<CronDeps["runScoringCycle"]>>;
    }),
    seedIntradayTail: vi.fn(async (..._args: Parameters<CronDeps["seedIntradayTail"]>) => void order.push("seed")),
    invalidateByTag: vi.fn(async (_tag: string) => void order.push("purge")),
    purgeTimeoutMs: 1,
    readEnv: () => ENV,
    cronSecret: () => SECRET as string | undefined,
    now: () => clock.at,
    error: vi.fn(),
  } satisfies CronDeps;
  return { deps, order, clock };
}

describe("GET /api/cron/run", () => {
  test("returns 500 AND logs the error when the cycle throws", async () => {
    const boom = new Error("column alert_log.pushed_at does not exist");
    const { deps } = world();
    deps.runScoringCycle.mockRejectedValueOnce(boom);

    const res = await handle(req(), deps);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: boom.message });
    // The breadcrumb: without this call, a daily-failing cron is invisible in logs.
    expect(deps.error).toHaveBeenCalledWith("[cron] scoring cycle failed:", boom);
  });

  test("`?email=force` reaches the cycle as forceEmail:true; a plain call passes false", async () => {
    const { deps } = world();
    await handle(req(), deps);
    expect(deps.runScoringCycle).toHaveBeenLastCalledWith(expect.any(Function), expect.objectContaining({ forceEmail: false }));
    await handle(req("?email=force"), deps);
    expect(deps.runScoringCycle).toHaveBeenLastCalledWith(expect.any(Function), expect.objectContaining({ forceEmail: true }));
  });

  test("a run before 21:05 UTC is intraday (silent, alert-less); the 22:00 cron is not", async () => {
    const { deps, clock } = world();
    clock.at = INTRADAY;
    await handle(req(), deps);
    expect(deps.runScoringCycle).toHaveBeenLastCalledWith(expect.any(Function), expect.objectContaining({ intraday: true }));
    await handle(req("?email=force"), deps);
    expect(deps.runScoringCycle).toHaveBeenLastCalledWith(expect.any(Function), { env: ENV, forceEmail: true, intraday: false, onCommitted: expect.any(Function) });
    clock.at = EOD;
    await handle(req(), deps);
    expect(deps.runScoringCycle).toHaveBeenLastCalledWith(expect.any(Function), expect.objectContaining({ intraday: false }));
  });

  test("a UTC-weekend `?email=force` run reaches the cycle intraday (rule: `isIntradayCronRun`, intraday.test.ts)", async () => {
    const { deps, clock } = world();
    clock.at = new Date("2026-11-14T22:30:00Z");
    await handle(req("?email=force"), deps);
    expect(deps.runScoringCycle).toHaveBeenLastCalledWith(expect.any(Function), expect.objectContaining({ intraday: true }));
  });

  test("`?rederive=0` reaches an intraday cycle as rederive:false; absent ⇒ no key (default re-derives); EOD ignores it", async () => {
    const { deps, clock } = world();
    clock.at = INTRADAY;
    await handle(req("?rederive=0"), deps);
    expect(deps.runScoringCycle).toHaveBeenLastCalledWith(expect.any(Function), expect.objectContaining({ intraday: true, rederive: false }));
    await handle(req(), deps);
    expect(deps.runScoringCycle.mock.lastCall?.[1]).not.toHaveProperty("rederive");
    clock.at = EOD;
    await handle(req("?rederive=0"), deps);
    expect(deps.runScoringCycle).toHaveBeenLastCalledWith(expect.any(Function), { env: ENV, forceEmail: false, intraday: false, onCommitted: expect.any(Function) });
  });

  test("N3: intraday purges, then seeds, then purges again; EOD purges before its seed tail and again after it", async () => {
    const { deps, clock, order } = world();
    clock.at = INTRADAY;
    await handle(req(), deps);
    expect(deps.runScoringCycle).toHaveBeenLastCalledWith(expect.any(Function), expect.objectContaining({ intraday: true, deferIntradaySeed: true }));
    expect(order).toEqual(["purge", "seed", "purge"]);
    const cycleClock = deps.runScoringCycle.mock.lastCall![0];
    expect(cycleClock()).toBe(INTRADAY.toISOString());
    expect(deps.seedIntradayTail).toHaveBeenCalledWith(ENV, cycleClock);
    clock.at = EOD;
    await handle(req(), deps);
    expect(deps.runScoringCycle).toHaveBeenLastCalledWith(expect.any(Function), { env: ENV, forceEmail: false, intraday: false, onCommitted: expect.any(Function) });
    expect(order).toEqual(["purge", "seed", "purge", "purge", "tail", "purge"]);
  });

  test("`?email=force` without the bearer is still 401 (no cycle)", async () => {
    const { deps } = world();
    const res = await handle(req("?email=force", null), deps);
    expect(res.status).toBe(401);
    expect(deps.runScoringCycle).not.toHaveBeenCalled();
  });

  test("401 when the bearer is wrong (no cycle, no error log)", async () => {
    const { deps } = world();
    const res = await handle(req("", "nope"), deps);
    expect(res.status).toBe(401);
    expect(deps.runScoringCycle).not.toHaveBeenCalled();
    expect(deps.error).not.toHaveBeenCalled();
  });

  test("returns the stored verdict when the cycle succeeds - minus the replay-only runInputs", async () => {
    const { deps } = world({ level: "OK", runInputs: { v: 1 } });
    const res = await handle(req(), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ level: "OK" });
    // P-2: the day-long edge TTL is only safe because this purge ran.
    expect(res.headers.get("X-Vintage-Purged")).toBe("true");
    expect(deps.invalidateByTag).toHaveBeenCalledWith(VINTAGE_TAG);
  });

  test("500 'not configured' when CRON_SECRET is unset", async () => {
    const { deps } = world();
    const res = await handle(req(), { ...deps, cronSecret: () => undefined });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "CRON_SECRET is not configured" });
    expect(deps.runScoringCycle).not.toHaveBeenCalled();
  });
  // Red-demo'd 2026-08-20: drop the try/catch around invalidateByTag and this test throws
  // a 500 instead; drop the header and it reads null. A purge failure must NOT abort the
  // run (the vintage is already persisted) but must never pass silently either.
  test("a failed edge purge is surfaced, not swallowed, and does not fail the run", async () => {
    const { deps } = world({ level: "OK" });
    deps.invalidateByTag.mockRejectedValueOnce(new Error("purge refused"));
    const res = await handle(req(), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ level: "OK" });
    expect(res.headers.get("X-Vintage-Purged")).toBe("false");
    expect(deps.error).toHaveBeenCalled();
  });

  test("a rejected intraday seed tail still gets the final purge", async () => {
    const { deps, clock, order } = world();
    clock.at = INTRADAY;
    deps.seedIntradayTail.mockRejectedValueOnce(new Error("tail down"));
    await handle(req(), deps);
    expect(order).toEqual(["purge", "purge"]);
  });

  test("a hung commit-point purge times out, so the EOD seed tail still runs", async () => {
    const { deps, order } = world({ level: "OK" });
    deps.invalidateByTag.mockImplementationOnce(() => new Promise(() => {}));
    const res = await handle(req(), deps);
    expect(order).toEqual(["tail", "purge"]);
    expect(res.headers.get("X-Vintage-Purged")).toBe("false");
  });
});

describe("GET runs with the production seams", () => {
  test("CRON_DEPS holds the real cycle, seed tail, edge purge, env reader and secret reader", () => {
    expect(CRON_DEPS.runScoringCycle).toBe(realRunScoringCycle);
    expect(CRON_DEPS.seedIntradayTail).toBe(realSeedIntradayTail);
    expect(CRON_DEPS.invalidateByTag).toBe(realInvalidateByTag);
    expect(CRON_DEPS.cronSecret).toBe(realCronSecret);
    expect(CRON_DEPS.readEnv).toBe(realReadEnv);
  });

  // Static: `GET` cannot run here without the live cycle, so its body is scanned instead —
  // it must hand `handle` the request alone, leaving every seam at its `CRON_DEPS` default, and anchor the
  // run on the same monotonic clock `startRunBudget` reads (a wall-clock anchor aborts every fetch at once).
  test("GET calls handle(req) with no seam override and anchors the run on performance.now()", () => {
    const src = readFileSync(new URL("./run.ts", import.meta.url), "utf8");
    const body = /export async function GET\(req: Request\): Promise<Response> \{\n([\s\S]*?)\n\}\n/.exec(src)?.[1];
    expect(body, "GET's body was not found - update this scan's anchor").toBeDefined();
    const code = (body ?? "").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect([...code.matchAll(/\bhandle\(([^)]*)\)/g)].map((m) => m[1])).toEqual(["req"]);
    expect([...code.matchAll(/\bmarkRunAnchor\(([^)]*\)?)\)/g)].map((m) => m[1])).toEqual(["performance.now()"]);
  });
});
