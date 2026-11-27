/**
 * Registry tests (audit SCRIPT-1, Stage 3.1): the prune scope each job hands the runner.
 * The passes are injected fakes (`makeRegistry`), so this is offline and DB-free — what is under
 * test is the id mapping, not the passes themselves.
 */
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../../src/store-memory.js";
import { backfillAll, backfillDownsideBreaks } from "../backfill.js";
import { livePasses, makeRegistry, seededIds, type BackfillPasses } from "./registry.js";

const indicatorsPass = {
  result: { total: 0, seeded: { F1: 0, F2: 0, F3: 0 } as Record<string, number>, failures: [] as { id: string; error: string }[] },
  lastOpts: undefined as { only?: readonly string[] } | undefined,
  dbreakLastOpts: undefined as { only?: readonly string[] } | undefined,
};

// Only the passes the tests below drive; an undriven job's pass is absent and throws if run.
const fakePasses = {
  liveDeps: {},
  livePensionDeps: {},
  liveBottomDeps: {},
  liveFxhCmpDeps: {},
  // A realistic no-op `indicators` pass: every id already complete (0 rows seeded). Mutable so the
  // partial-failure case below can drive the SAME job without a second registry.
  backfillAll: async (_s: unknown, _d: unknown, o: { only?: readonly string[] }) => {
    indicatorsPass.lastOpts = o;
    return indicatorsPass.result;
  },
  backfillPension: async () => ({ inserted: 4, perLeg: { SPY: 4, VEA: 0, DEXUSEU: 0, SP500IT: 0 } }),
  // The bottom job's perLeg keys are STORED ids (VIX/VIX3M), never the feed's series ids.
  backfillBottom: async () => ({ inserted: 0, perLeg: { VIX: 0, VIX3M: 0 } }),
  // A PARTIAL downside-break pass: DB_SMH seeded, DB_XLK already complete (0) — so the
  // `seededIds` prune scope must drop DB_XLK, not report both detectors.
  backfillDownsideBreaks: async (_s: unknown, _d: unknown, o: { only?: readonly string[] }) => {
    indicatorsPass.dbreakLastOpts = o;
    return { inserted: 3, perLeg: { DB_SMH: 3, DB_XLK: 0 } };
  },
  // A PARTIAL fxhcmp pass: two components already complete (0) ⇒ out of the prune scope.
  backfillFxhCmp: async () => ({ inserted: 2, perLeg: { CMP_FXH_DEXUSEU: 2, CMP_FXH_DEXSZUS: 0, CMP_FXH_DEXJPUS: 0 } }),
  liveInputSeriesDeps: {},
  // A PARTIAL inputs pass: one id already complete (0) => out of the prune scope.
  backfillInputSeries: async () => ({ inserted: 2, perLeg: { VIXCLS: 2, T10Y2Y: 0 } }),
  liveSlowDeps: {},
  // A REAL backfill-slow id. This fixture has now been retargeted twice by feed retirements
  // ("F14" → "F12" on 2026-07-17 Stage 1.1, "F12" → here hours later at Stage 1.2) because it
  // kept naming ids the `slow` job never emits. `complacency-vix` is one the job ACTUALLY emits
  // (slowStoredReadings' observability components), so it cannot be invalidated by an unrelated
  // indicator retirement again.
  backfillSlow: async () => ({ inserted: 2, dates: 1, runAt: "2026-01-01T00:00:00.000Z", ids: ["complacency-vix"] }),
} as unknown as BackfillPasses;

const FAKE_REGISTRY = makeRegistry(fakePasses);
const findJob = (name: string) => FAKE_REGISTRY.find((j) => j.name === name);

describe("seededIds", () => {
  it("keeps only ids that actually seeded rows", () => {
    expect(seededIds({ F1: 3, F2: 0, F3: 1 })).toEqual(["F1", "F3"]);
    expect(seededIds({ F1: 0, F2: 0 })).toEqual([]);
    expect(seededIds({})).toEqual([]);
  });
});

describe("prune scope", () => {
  const run = (name: string) => findJob(name)!.run(new InMemoryStore());

  // Each mocked pass seeds 0 rows for some ids; those stay out of the scope. `indicators` is a
  // no-op pass — regression: `Object.keys(seeded)` returned all ~25 ids here, pruning across the lot.
  it.each([
    ["indicators", []],
    ["pension", ["SPY"]],
    ["bottom", []],
    ["dbreak", ["DB_SMH"]],
    ["fxhcmp", ["CMP_FXH_DEXUSEU"]],
    ["inputs", ["VIXCLS"]],
    ["slow", ["complacency-vix"]],
  ])("`%s` prunes only the ids it actually seeded", async (name, ids) => {
    expect((await run(name)).ids).toEqual(ids);
  });

  // 2026-08-16: this job used to THROW on `failures`, which made the runner skip its prune at
  // `backfill/run.ts` — the rows the pass DID write stayed shadowed by the vintage they replaced.
  it("a PARTIAL `indicators` pass returns its failures and still reports the written prune scope", async () => {
    const restore = indicatorsPass.result;
    indicatorsPass.result = { total: 3, seeded: { F1: 3, F2: 0 }, failures: [{ id: "F4", error: "rate-limited" }] };
    try {
      // MUTATE-AND-RED: restore the `throw new Error(...)` in registry.ts and this line reds on the
      // rejection instead of returning a prune scope.
      const res = await run("indicators");
      expect(res.ids).toEqual(["F1"]);
      expect(res.failures).toEqual(["F4"]);
      expect(res.summary).toMatch(/1 FAILED: F4/);
    } finally {
      indicatorsPass.result = restore;
    }
  });

  // `--deepen=BONOS` must pass BONOS alone: a full pass re-shadows + prunes every other id (~5.4k rows).
  it("`--deepen=<ids>` narrows the `indicators` pass to those ids; bare `--deepen` keeps the full pass", async () => {
    await findJob("indicators")!.run(new InMemoryStore(), { deepen: ["BONOS"], restate: ["F3"] });
    expect(indicatorsPass.lastOpts?.only).toEqual(["BONOS", "F3"]);
    await findJob("indicators")!.run(new InMemoryStore(), { deepen: "all" });
    expect(indicatorsPass.lastOpts?.only).toBeUndefined();
  });

  // ship.sh's auto-restate (2026-09-24): the prod re-score of the drifted spread ids ran every spec and died on a price-feed
  // cap over 14 price ids the restate never touched — after the named spreads were already re-written and
  // before the `--stamp`, so the release aborted and the next ship would re-restate the same drift.
  it("`--restate=<ids>` alone narrows the `indicators` pass to those ids; a plain pass stays full", async () => {
    await findJob("indicators")!.run(new InMemoryStore(), { restate: ["BUND", "BONOS"] });
    expect(indicatorsPass.lastOpts?.only).toEqual(["BUND", "BONOS"]);
    await findJob("indicators")!.run(new InMemoryStore(), { restate: [] });
    expect(indicatorsPass.lastOpts?.only).toBeUndefined();
    await findJob("indicators")!.run(new InMemoryStore(), {});
    expect(indicatorsPass.lastOpts?.only).toBeUndefined();
    // Bare `--deepen` + `--restate`: the deepen-all keeps the full pass (restate ids are inside it).
    await findJob("indicators")!.run(new InMemoryStore(), { deepen: "all", restate: ["BUND"] });
    expect(indicatorsPass.lastOpts?.only).toBeUndefined();
    // Same contract on the detector seam.
    await findJob("dbreak")!.run(new InMemoryStore(), { restate: ["DB_SMH"] });
    expect(indicatorsPass.dbreakLastOpts?.only).toEqual(["DB_SMH"]);
    await findJob("dbreak")!.run(new InMemoryStore(), {});
    expect(indicatorsPass.dbreakLastOpts?.only).toBeUndefined();
  });
});

describe("makeRegistry", () => {
  it("defaults to the live passes", () => {
    expect(livePasses.backfillAll).toBe(backfillAll);
    expect(livePasses.backfillDownsideBreaks).toBe(backfillDownsideBreaks);
    expect(makeRegistry.toString()).toMatch(/passes\s*=\s*livePasses/);
  });
});
