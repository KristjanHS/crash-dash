/**
 * Unit tests for the runner (plan Phase 3). `parseArgs` is pure; `main` is tested
 * with a fake `makeStore` (no real `resolveStore`, no network), a recording `RunIo` and a FAKE
 * registry of offline jobs — one passing, one throwing — so dispatch + exit codes are
 * deterministic and offline.
 */
import { describe, expect, it, vi } from "vitest";

import { setRequirePrimaryFeed } from "../../src/prices.js";
import { InMemoryStore } from "../../src/store-memory.js";
import type { Store } from "../../src/store.js";
import { makeStoredReading } from "../../src/test-helpers.js";
import type { BackfillJob, JobOpts } from "./registry.js";
import { liveRunIo, main, parseArgs, type RunIo } from "./run.js";

// The opts each tracking job was handed, so the CLI → job.run threading is pinned end-to-end.
const seen: Record<"indicators" | "dbreak" | "legs" | "legpillars", (JobOpts | undefined)[]> = {
  indicators: [], dbreak: [], legs: [], legpillars: [],
};
const tracking = (name: keyof typeof seen) => async (_store: Store, opts?: JobOpts) => {
  seen[name].push(opts);
  return { summary: "seeded", ids: [] };
};
const row = makeStoredReading("F1", { date: "2026-01-01" });

// Fake registry: `indicators` passes, `slow` throws. Names match the real ones so
// parseArgs lookups behave like prod.
const FAKE_REGISTRY: BackfillJob[] = [
  {
    name: "indicators",
    description: "fake indicators",
    supportsDeepen: true, // mirrors the real `indicators` — the only job that drives backfillAll
    // Writes TWO vintages of the same (id, date) so the runner's post-pass self-prune has a
    // shadowed row to delete (asserted below): an old one, and the pass's FRESH vintage stamped
    // from the wall clock inside the job — as every real pass does, which the frontier relies on.
    run: async (store, opts) => {
      seen.indicators.push(opts);
      await store.recordReadings([row], "2026-01-01T00:00:00.000Z");
      await store.recordReadings([row], new Date().toISOString());
      return { summary: "seeded", ids: ["F1"] };
    },
  },
  { name: "slow", description: "fake slow", run: async () => { throw new Error("boom"); } },
  // The one restate-capable job (mirrors the real `dbreak`).
  { name: "dbreak", description: "fake dbreak", supportsRestate: true, run: tracking("dbreak") },
  // A reshadow-all-capable raw-close job (mirrors the real `legs`/`pension`).
  { name: "legs", description: "fake legs", supportsReshadowAll: true, run: tracking("legs") },
  // A `--closes`-capable replay job (mirrors the real `legpillars`).
  { name: "legpillars", description: "fake legpillars", supportsCloses: true, run: tracking("legpillars") },
];

/** A recording IO: no console, no `.env.local` load, no process-global feed latch — the env-file
 *  loads and latch arms are RECORDED instead, so `main`'s env/latch wiring is assertable. */
function fakeIo(): RunIo & { lines: string[]; envFiles: string[]; latch: boolean[] } {
  const lines: string[] = [];
  const envFiles: string[] = [];
  const latch: boolean[] = [];
  return {
    lines,
    envFiles,
    latch,
    log: (l) => lines.push(l),
    error: (l) => lines.push(l),
    loadEnvFile: (path) => envFiles.push(path),
    setRequirePrimaryFeed: (on) => latch.push(on),
  };
}
const parse = (argv: string[]) => parseArgs(argv, FAKE_REGISTRY);
const run = (argv: string[], makeStore: (env: "local" | "prod") => Promise<Store>, io: RunIo = fakeIo()) =>
  main(argv, makeStore, FAKE_REGISTRY, io);

describe("parseArgs", () => {
  it("bare [] → jobs:null (print list), default env local", () => {
    expect(parse([])).toMatchObject({ jobs: null, all: false, env: "local" });
  });

  it("['indicators'] → that single job", () => {
    const p = parse(["indicators"]);
    expect(p.jobs?.map((j) => j.name)).toEqual(["indicators"]);
  });

  it("'all' and '--all' → the selectable registry (drops the by-name-only jobs)", () => {
    expect(parse(["all"]).jobs?.map((j) => j.name)).toEqual(["indicators", "slow", "dbreak", "legs", "legpillars"]);
    expect(parse(["--all"]).jobs?.map((j) => j.name)).toEqual([
      "indicators",
      "slow",
      "dbreak",
      "legs",
      "legpillars",
    ]);
  });

  it("'safe' and '--safe' → the selectable registry MINUS the destructive vintage writers (drops slow)", () => {
    expect(parse(["safe"]).jobs?.map((j) => j.name)).toEqual(["indicators", "dbreak", "legs", "legpillars"]);
    expect(parse(["--safe"]).jobs?.map((j) => j.name)).toEqual(["indicators", "dbreak", "legs", "legpillars"]);
  });

  it("unknown job name → error", () => {
    expect(parse(["bogus"]).error).toMatch(/unknown job: bogus/);
  });

  it("two job names → error", () => {
    expect(parse(["a", "b"]).error).toMatch(/one job at a time/);
  });

  it("unknown --flag → error", () => {
    expect(parse(["--nope"]).error).toMatch(/unknown flag: --nope/);
  });

  it("--env=prod parsed; default is local", () => {
    expect(parse(["all", "--env=prod", "--confirm-destructive"]).env).toBe("prod");
    expect(parse(["all"]).env).toBe("local");
  });

  it("--dry-run parsed; default is off", () => {
    expect(parse(["all", "--dry-run"])).toMatchObject({ dryRun: true });
    expect(parse(["all"])).toMatchObject({ dryRun: false });
  });
});

// Stage 3.1: the destructive dropdown must not be one click from deleting prod vintages.
describe("destructive confirmation gate", () => {
  it("slow/all against prod without --confirm-destructive → error, no jobs", () => {
    for (const argv of [["slow", "--env=prod"], ["all", "--env=prod"], ["--all", "--env=prod"]]) {
      const p = parse(argv);
      expect(p.error, argv.join(" ")).toMatch(/--confirm-destructive/);
      expect(p.jobs, argv.join(" ")).toBeNull();
    }
  });

  it("--confirm-destructive unlocks it", () => {
    const p = parse(["slow", "--env=prod", "--confirm-destructive"]);
    expect(p.error).toBeUndefined();
    expect(p.jobs?.map((j) => j.name)).toEqual(["slow"]);
  });

  it("--dry-run is never gated (it writes nothing)", () => {
    expect(parse(["all", "--env=prod", "--dry-run"]).error).toBeUndefined();
  });

  it("local is never gated, and a non-destructive prod job stays open", () => {
    expect(parse(["all"]).error).toBeUndefined();
    expect(parse(["indicators", "--env=prod"]).error).toBeUndefined();
  });

  it("'safe' against prod is never gated — it excludes the destructive jobs, so no --confirm needed", () => {
    const p = parse(["safe", "--env=prod"]);
    expect(p.error).toBeUndefined();
  });
});

// --restate rebuilds a detector's FULL stored history after a CUT retune (scripts/backfill.ts ⚠);
// --reshadow-all re-writes a raw-close job's FULL history under a fresh VINTAGE (feed re-seed). Every
// guard here exists because the failure mode is a run that reports success having propagated nothing.
describe("flag ↔ job guards", () => {
  it.each([
    ["--restate", "restate", "dbreak", "DB_XLK", "DB_SMH"],
    ["--reshadow-all", "reshadowAll", "legs", "LEGP_us_large", "LEGP_eu"],
  ])("%s parses an id list (default empty), rejects naming no ids, and is destructive-gated against prod", (flag, key, job, a, b) => {
    expect(parse([job, `${flag}=${a}`])).toMatchObject({ [key]: [a] });
    expect(parse([job, `${flag}=${a},${b}`])).toMatchObject({ [key]: [a, b] });
    expect(parse([job])).toMatchObject({ [key]: [] });
    for (const argv of [[job, flag], [job, `${flag}=`]]) {
      const p = parse(argv);
      expect(p.error, argv.join(" ")).toBeDefined();
      expect(p.jobs, argv.join(" ")).toBeNull();
    }
    // Gated on the FLAG, so a plain prod run of the job stays an ungated insert-missing pass.
    const arg = `${flag}=${a}`;
    expect(parse([job, arg, "--env=prod"]).error).toMatch(/--confirm-destructive/);
    expect(parse([job, "--env=prod"]).error).toBeUndefined();
    expect(parse([job, arg, "--env=prod", "--confirm-destructive"]).error).toBeUndefined();
    expect(parse([job, arg, "--env=prod", "--dry-run"]).error).toBeUndefined();
    expect(parse([job, arg]).error).toBeUndefined(); // local
  });

  it.each(["--restate=DB_XLK", "--reshadow-all=LEGP_us_large", "--closes=900", "--deepen"])(
    "%s naming no job is an error — the list-print exit would read as success",
    (arg) => {
      const p = parse([arg]);
      expect(p.error).toMatch(`${arg.split("=")[0]} needs a job`);
      expect(p.jobs).toBeNull();
    },
  );

  // [rejected job, the job the error names] — a selector names its first non-supporting member.
  it.each([
    ["--restate=DB_XLK", [["indicators", "indicators"], ["safe", "indicators"]], "dbreak"],
    ["--reshadow-all=LEGP_us_large", [["indicators", "indicators"], ["dbreak", "dbreak"]], "legs"],
    ["--closes=900", [["indicators", "indicators"], ["safe", "indicators"]], "legpillars"],
    ["--deepen", [["dbreak", "dbreak"], ["safe", "dbreak"]], "indicators"],
  ])("%s on a job that would DROP it is rejected (incl. via a selector)", (arg, rejected, accepted) => {
    for (const [job, named] of rejected) {
      const p = parse([job!, arg]);
      expect(p.error, job).toMatch(`${arg.split("=")[0]} is not supported by: ${named}`);
      expect(p.jobs, job).toBeNull();
    }
    expect(parse([accepted, arg]).error).toBeUndefined();
  });
});

// `--require-primary-feed` arms the strict-primary-feed latch in prices.ts (inert while daily closes have
// no free source; this pins only the flag parse). ⚠ The old contract here was "opt-in ONLY, nothing may
// imply it" — OVERTURNED by the `[USER]` ruling of 2026-08-02: a destructive pass is a history REWRITE,
// so `--confirm-destructive` now IMPLIES it. What survives of the old pin is the half that still binds:
// the CRON path (which passes neither flag) must never arm the latch.
describe("--require-primary-feed", () => {
  it("explicit flag arms it; absent any destructive flag it stays off (the cron's lenient default)", () => {
    expect(parse(["legs", "--require-primary-feed"])).toMatchObject({ requirePrimaryFeed: true });
    expect(parse(["legs"]).requirePrimaryFeed).toBe(false);
    // --env=prod alone is not destructive: no rewrite, so no implication.
    expect(parse(["legs", "--env=prod"]).requirePrimaryFeed).toBe(false);
  });

  it("--confirm-destructive IMPLIES it", () => {
    expect(
      parse(["legs", "--reshadow-all=LEGP_SEMIS", "--env=prod", "--confirm-destructive"]).requirePrimaryFeed,
    ).toBe(true);
    expect(parse(["slow", "--env=prod", "--confirm-destructive"]).requirePrimaryFeed).toBe(true);
  });

  it("--allow-fallback-feed cancels the implication — the DEXUSEU-style escape", () => {
    const parsed = parse([
      "pension", "--reshadow-all=DEXUSEU", "--env=prod", "--confirm-destructive", "--allow-fallback-feed",
    ]);
    expect(parsed.requirePrimaryFeed).toBe(false);
    expect(parsed.allowFallbackFeed).toBe(true);
    // The escape does not weaken the destructive gate itself — that flag is still required.
    expect(parse(["slow", "--env=prod", "--allow-fallback-feed"]).error).toMatch(/confirm-destructive/);
  });

  it("--allow-fallback-feed with an EXPLICIT --require-primary-feed is a usage error, not a silent winner", () => {
    // Order-independent: the guard runs after the whole argv is parsed, so neither flag wins by position.
    for (const argv of [
      ["slow", "--env=prod", "--confirm-destructive", "--require-primary-feed", "--allow-fallback-feed"],
      ["slow", "--env=prod", "--confirm-destructive", "--allow-fallback-feed", "--require-primary-feed"],
    ]) {
      const parsed = parse(argv);
      expect(parsed.error).toMatch(/--allow-fallback-feed contradicts --require-primary-feed/);
      expect(parsed.jobs).toBeNull();
    }
  });
});

// --closes sizes a replay window (`legpillars`). Failure mode mirrors --restate's: a run that
// reports success having replayed a window the operator never asked for — so a dropped flag, a
// bare flag and a junk value must all be errors, never a silent fall back to the job's default.
describe("--closes", () => {
  it("parses a positive integer; default is undefined (the job's own default)", () => {
    expect(parse(["legpillars", "--closes=900"])).toMatchObject({ closes: 900 });
    expect(parse(["legpillars", "--closes=400"])).toMatchObject({ closes: 400 });
    expect(parse(["legpillars"]).closes).toBeUndefined();
  });

  it("a bare / zero / non-numeric value is a usage error, not a silent default", () => {
    for (const argv of [
      ["legpillars", "--closes"],
      ["legpillars", "--closes="],
      ["legpillars", "--closes=0"],
      ["legpillars", "--closes=-5"],
      ["legpillars", "--closes=abc"],
      ["legpillars", "--closes=9.5"],
      // Exotic numeric literals: `Number.isInteger` ALONE admits both (1e3→1000, 0x10→16), so the
      // guard would accept a window nobody typed while its error promises "a positive integer".
      ["legpillars", "--closes=1e3"],
      ["legpillars", "--closes=0x10"],
    ]) {
      const p = parse(argv);
      expect(p.error, argv.join(" ")).toMatch(/--closes needs a positive integer/);
      expect(p.jobs, argv.join(" ")).toBeNull();
      expect(p.closes, argv.join(" ")).toBeUndefined();
    }
  });
});

// --deepen re-fetches a frozen left edge (cause A). Unlike --restate it is NON-destructive
// (insert-missing), so a bare flag is VALID (every spec) and it is NEVER gated against prod. Only
// `indicators` drives backfillAll, so it alone supports it — every other job must reject the flag.
describe("--deepen", () => {
  it("bare ⇒ 'all'; =<ids> ⇒ the list; =<empty> ⇒ 'all'; default undefined", () => {
    expect(parse(["indicators", "--deepen"]).deepen).toBe("all");
    expect(parse(["indicators", "--deepen="]).deepen).toBe("all");
    expect(parse(["indicators", "--deepen=CG,F1"]).deepen).toEqual(["CG", "F1"]);
    expect(parse(["indicators"]).deepen).toBeUndefined();
  });

  it("is NEVER destructive-gated against prod (insert-missing only, no --confirm-destructive)", () => {
    expect(parse(["indicators", "--deepen", "--env=prod"]).error).toBeUndefined();
    expect(parse(["indicators", "--deepen=CG", "--env=prod"]).error).toBeUndefined();
  });
});

describe("main", () => {
  const makeStore = (): Promise<Store> => Promise.resolve(new InMemoryStore());

  it("bare args → returns 0, prints list, never resolves a store", async () => {
    const spy = vi.fn(makeStore);
    const code = await run([], spy);
    expect(code).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("defaults to the live registry and live IO", async () => {
    expect(parseArgs(["fxhcmpdeep"]).jobs?.map((j) => j.name)).toEqual(["fxhcmpdeep"]);
    const io = fakeIo();
    expect(await main([], makeStore, undefined, io)).toBe(0);
    expect(io.lines).toContainEqual(expect.stringMatching(/^ {2}fxhcmpdeep — /));
    expect(liveRunIo.setRequirePrimaryFeed).toBe(setRequirePrimaryFeed);
    expect(main.toString()).toMatch(/io\s*=\s*liveRunIo/);
  });

  it("all-pass job → returns 0", async () => {
    expect(await run(["indicators", "--env=prod"], makeStore)).toBe(0);
  });

  it("threads --restate through to the job (the flag is inert if the runner drops it)", async () => {
    seen.dbreak.length = 0;
    expect(await run(["dbreak", "--restate=DB_XLK"], makeStore)).toBe(0);
    expect(await run(["dbreak"], makeStore)).toBe(0);
    expect(seen.dbreak).toEqual([
      { restate: ["DB_XLK"], reshadowAll: [], closes: undefined, dryRun: false },
      { restate: [], reshadowAll: [], closes: undefined, dryRun: false },
    ]);
  });

  it("threads --reshadow-all through to the job (the flag is inert if the runner drops it)", async () => {
    seen.legs.length = 0;
    expect(await run(["legs", "--reshadow-all=LEGP_us_large"], makeStore)).toBe(0);
    expect(await run(["legs"], makeStore)).toBe(0);
    expect(seen.legs).toEqual([
      { restate: [], reshadowAll: ["LEGP_us_large"], closes: undefined, dryRun: false },
      { restate: [], reshadowAll: [], closes: undefined, dryRun: false },
    ]);
  });

  // Both new JobOpts fields, end-to-end: `closes` is inert if the runner drops it, and `dryRun`
  // is what lets the job stop before a write the dry-run Store wrapper cannot tally.
  it("threads --closes and --dry-run through to the job", async () => {
    seen.legpillars.length = 0;
    expect(await run(["legpillars", "--closes=400", "--dry-run"], makeStore)).toBe(0);
    expect(await run(["legpillars"], makeStore)).toBe(0);
    expect(seen.legpillars).toEqual([
      { restate: [], reshadowAll: [], closes: 400, dryRun: true },
      { restate: [], reshadowAll: [], closes: undefined, dryRun: false },
    ]);
  });

  it("threads --deepen through to the job (the flag is inert if the runner drops it)", async () => {
    seen.indicators.length = 0;
    expect(await run(["indicators", "--deepen=CG"], makeStore)).toBe(0);
    expect(await run(["indicators"], makeStore)).toBe(0);
    expect(seen.indicators).toEqual([
      { restate: [], reshadowAll: [], closes: undefined, dryRun: false, deepen: ["CG"] },
      { restate: [], reshadowAll: [], closes: undefined, dryRun: false, deepen: undefined },
    ]);
  });

  it("self-prunes shadowed vintages for the ids a job wrote — frontier-scoped to the job's start", async () => {
    const store = new InMemoryStore();
    // A shadowed pair this job never touched (both vintages predate it, both past the floor): a FULL
    // sweep over F1 would delete the older one; the frontier (`since` = job start) must leave it.
    const untouched = makeStoredReading("F1", { date: "2019-01-01" });
    await store.recordReadings([untouched], "2025-01-01T00:00:00.000Z");
    await store.recordReadings([untouched], "2025-01-02T00:00:00.000Z");
    const t0 = Date.now();
    expect(await run(["indicators", "--env=prod"], async () => store)).toBe(0);
    // The fake job wrote 2 vintages of (F1, 2026-01-01); the runner's prune keeps only the newest.
    const job = store.readings.filter((r) => r.date === "2026-01-01");
    expect(job).toHaveLength(1);
    expect(Date.parse(job[0]!.runAt)).toBeGreaterThanOrEqual(t0);
    expect(store.readings.filter((r) => r.date === "2019-01-01")).toHaveLength(2);
  });

  it("self-prune is FLOORED, so it cannot delete the live cron run's row", async () => {
    // RED before 2026-07-23: the runner passed no retention floor, so a pass covering today's
    // obs_date deleted the current cron run's row for every id it touched — and that row is the
    // only vintage `getReadingsForRun(<latest firedAt>)` serves (/api/lab's BAND members +
    // downsideDetectors). A same-obs_date row written NOW must therefore survive the pass.
    // Two vintages of ONE (id, date) written moments apart: the older is shadowed, and both are
    // newer than the floor. The pass's prune scope covers F1, so an UNFLOORED prune deletes the
    // shadowed one; the floored prune must leave both standing. (The fake job's own 2026-01
    // vintages are far older than the floor, so the existing self-prune test still bites.)
    const store = new InMemoryStore();
    const row = makeStoredReading("F1", { date: "2020-01-01", value: 9, rawState: "RED", state: "RED" });
    const shadowed = new Date(Date.now() - 1000).toISOString();
    await store.recordReadings([row], shadowed);
    await store.recordReadings([row], new Date().toISOString());
    expect(await run(["indicators", "--env=prod"], async () => store)).toBe(0);
    expect(store.readings.some((r) => r.runAt === shadowed)).toBe(true);
  });

  it("--dry-run writes nothing and never prunes, but still reports the scope", async () => {
    const store = new InMemoryStore();
    const prune = vi.fn(store.pruneShadowedReadings.bind(store));
    store.pruneShadowedReadings = prune;
    const io = fakeIo();
    expect(await run(["indicators", "--env=prod", "--dry-run"], async () => store, io)).toBe(0);
    expect(store.readings).toHaveLength(0); // the fake job's two recordReadings calls were tallied, not written
    expect(prune).not.toHaveBeenCalled();
    expect(io.lines.join("\n")).toMatch(/DRY-RUN indicators: would write 2 row\(s\); prune scope: F1 — NOTHING WRITTEN/);
  });

  it("a confirmed destructive prod run arms the primary-feed latch and never loads .env.local", async () => {
    const io = fakeIo();
    await run(["slow", "--env=prod", "--confirm-destructive"], makeStore, io); // `slow` throws by design; the exit code is pinned below
    expect(io.latch).toEqual([true]);
    expect(io.envFiles).toEqual([]);
  });

  it("a default (local-env) run loads .env.local and leaves the latch unarmed", async () => {
    const io = fakeIo();
    expect(await run(["indicators"], makeStore, io)).toBe(0);
    expect(io.envFiles).toEqual([".env.local"]);
    expect(io.latch).toEqual([]);
  });

  it("destructive prod job without confirmation → returns 1 without resolving a store", async () => {
    const spy = vi.fn(makeStore);
    expect(await run(["slow", "--env=prod"], spy)).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });

  // --confirm-destructive here so these assert the THROW path, not the confirmation gate.
  it("a throwing job → returns 1", async () => {
    expect(await run(["slow", "--env=prod", "--confirm-destructive"], makeStore)).toBe(1);
  });

  it("all → returns 1 when any job throws", async () => {
    expect(await run(["all", "--env=prod", "--confirm-destructive"], makeStore)).toBe(1);
  });

  it("parse error → returns 1 without resolving a store", async () => {
    const spy = vi.fn(makeStore);
    expect(await run(["bogus"], spy)).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });
});
