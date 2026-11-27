/**
 * `npm run restate` — the write/PROMOTE order, and the `only: [id]` narrowing.
 *
 * The regression: on 2026-08-16 a spread restate wrote 3351 rows, 11 unrelated price specs failed on a
 * price-feed hourly cap, and the CLI threw on those failures BEFORE `pruneShadowedReadings` — so the rows it
 * wrote stayed shadowed by the vintage they replaced and prod kept serving the old one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryStore } from "../src/store-memory.js";
import { setRequirePrimaryFeed } from "../src/prices.js";
import type { Store } from "../src/store.js";
import { main, parseRestateArgs, yearsReaching, type RestateDeps } from "./probe-restate.js";

const ROW = {
  date: "2026-01-01",
  indicatorId: "F1",
  value: 1,
  delta20: 0,
  rawState: "GREEN" as const,
  state: "GREEN" as const,
  decision: null,
};

const SHADOWED_RUN = "2026-01-01T00:00:00.000Z";
const WINNING_RUN = "2026-01-02T00:00:00.000Z";

/** A store holding TWO vintages of the same (id, date) — so a prune has something to delete. */
async function shadowedStore(): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  await store.recordReadings([ROW], SHADOWED_RUN);
  await store.recordReadings([ROW], WINNING_RUN);
  return store;
}

function deps(store: Store, over: Partial<RestateDeps> = {}): RestateDeps {
  return {
    makeStore: async () => store,
    backfillAll: async () => ({ total: 1, seeded: { F1: 1 }, failures: [] }),
    backfillDownsideBreaks: async () => ({ inserted: 0, perLeg: {} }),
    ...over,
  };
}

const ARGV = ["--id", "F1", "--env=prod", "--confirm-destructive"];

afterEach(() => {
  setRequirePrimaryFeed(false);
  vi.restoreAllMocks();
});

describe("restate promotes what it wrote BEFORE it reports failures", () => {
  it("prunes the shadowed vintage even when unrelated ids failed", async () => {
    const store = await shadowedStore();
    // premise: the OLD vintage is present before the run, so the assertion below can discriminate
    expect(await store.getReadingsForRun(SHADOWED_RUN)).toHaveLength(1);

    await expect(
      main(
        ARGV,
        deps(store, {
          backfillAll: async () => ({
            total: 1,
            seeded: { F1: 1 },
            // exactly the shape the price-feed cap produced
            failures: [{ id: "F4", error: "rate-limited" }],
          }),
        }),
      ),
      // still LOUD: the failure is reported, it just no longer pre-empts the promote
    ).rejects.toThrow(/1 indicator\(s\) failed: F4/);

    // MUTATE-AND-RED: move the `if (failures.length > 0) throw` back above the prune block in
    // probe-restate.ts and this line reds with the old vintage still present — the prod symptom.
    expect(await store.getReadingsForRun(SHADOWED_RUN)).toHaveLength(0);
    expect(await store.getReadingsForRun(WINNING_RUN)).toHaveLength(1);
  });

  it("returns 0 and prunes on a clean run", async () => {
    const store = await shadowedStore();
    expect(await main(ARGV, deps(store))).toBe(0);
    expect(await store.getReadingsForRun(SHADOWED_RUN)).toHaveLength(0);
  });

  it("narrows the pass to the named id (only) and restates it", async () => {
    const store = await shadowedStore();
    const seen: unknown[] = [];
    await main(
      ARGV,
      deps(store, {
        backfillAll: async (_s, _d, opts) => {
          seen.push(opts);
          return { total: 1, seeded: { F1: 1 }, failures: [] };
        },
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ restate: ["F1"], only: ["F1"] });
  });
});

describe("parseRestateArgs", () => {
  it("takes --id/--since spaced or `=`, defaults to a local, non-dry, unconfirmed run, and a later --env=dev wins", () => {
    const base = { id: "F1", env: "local", dryRun: false, confirmDestructive: false };
    for (const [args, want] of [
      [["--id", "F9", "--since", "2024-01-31"], { ...base, id: "F9", since: "2024-01-31" }],
      [["--id=F9", "--since=2024-01-31"], { ...base, id: "F9", since: "2024-01-31" }],
      [["--id", "F1"], base],
      [["--id", "F1", "--env=prod", "--env=dev", "--confirm-destructive"], { ...base, confirmDestructive: true }],
    ] as const) expect(parseRestateArgs([...args]), args.join(" ")).toEqual(want);
  });

  it("rejects a comma list, a repeated or missing --id, a flag swallowed as the id, a bad --since and an unknown argument", () => {
    for (const [args, error] of [
      [["--id", "F1,F2"], /takes ONE id/],
      [["--id", "F1", "--id=F2"], /--id given twice \(F1, F2\)/],
      [["--dry-run"], /^--id is required$/],
      [["--id="], /--id needs a value/],
      [["--id", "--env=prod"], /--id needs a value/],
      [["--id", "F1", "--since", "2024-1-31"], /--since needs YYYY-MM-DD/],
      [["--id", "F1", "--since"], /got: \(nothing\)/],
      // `--env prod` (spaced) is NOT the prod flag — silently running local would be the wrong DB
      [["--id", "F1", "--env", "prod"], /^unknown argument: --env$/],
    ] as const) expect(parseRestateArgs([...args]).error, args.join(" ")).toMatch(error);
  });

  it("refuses prod without --confirm-destructive, unless --dry-run", () => {
    expect(parseRestateArgs(["--id", "F1", "--env=prod"]).error).toMatch(
      /refusing --restate=F1 against --env=prod without --confirm-destructive/,
    );
    expect(parseRestateArgs(["--id", "F1", "--env=prod", "--dry-run"]).error).toBeUndefined();
    expect(parseRestateArgs(["--id", "F1", "--env=prod", "--confirm-destructive"])).toEqual({
      id: "F1",
      env: "prod",
      dryRun: false,
      confirmDestructive: true,
    });
  });
});

describe("yearsReaching", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  it("returns the smallest whole-year window covering `since`", () => {
    expect(yearsReaching("2025-06-01", now)).toBe(1);
    expect(yearsReaching("2023-06-01", now)).toBe(3);
  });

  it("keeps `since` ON the cutoff inside that window, and widens one day past it", () => {
    // MUTATE-AND-RED: `>` → `>=` in yearsReaching's loop turns the first line into 2 (a year too wide)
    expect(yearsReaching("2025-01-01", now)).toBe(1);
    expect(yearsReaching("2024-12-31", now)).toBe(2);
    expect(yearsReaching("2025-01-02", now)).toBe(1);
    expect(yearsReaching("2026-01-01", now)).toBe(1);
  });

  it("covers `since` on a leap-day `now` (isoCutoff rolls Feb 29 to Mar 1)", () => {
    const leap = new Date("2028-02-29T00:00:00Z");
    expect(yearsReaching("2027-03-01", leap)).toBe(1);
    expect(yearsReaching("2027-02-28", leap)).toBe(2);
  });

  it("caps at 200 years", () => {
    expect(yearsReaching("1700-01-01", now)).toBe(200);
  });
});
