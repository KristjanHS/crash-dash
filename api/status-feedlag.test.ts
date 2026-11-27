/**
 * The `/api/status` FEED-LAG OVERVIEW block.
 *
 * Slice 4.1 adds a top-level `feedLag[]` to the status payload: one row per REGISTERED feed, off the
 * SAME freshness walk that produces the per-feed pill, so /lab's ledger panel renders "age now /
 * healthy cut / deep-lag bar" without a second fetch.
 *
 * WHAT THESE PIN (each is falsifiable — the red demos live in the stage report):
 *  1. the roster is REGISTRY-complete — every id in ALL_INDICATORS + COMPOSITE_COMPONENTS gets a
 *     row. Built from the registry DIRECTLY, never from `CADENCE_OF`/`LAG_CUT_OF`, so it is not the
 *     tautological coverage check an earlier commit removed (a projection of the same walk the handler
 *     builds the roster from would pass no matter what the handler dropped).
 *  2. every row carries a `source` ∈ {p90, tier} — an unlabelled bar is the rot class §4 forbids.
 *  3. a tier row's `deepLagBar` is exactly the cadence-tier derivation `DEEP_LAG_MULTIPLE ×
 *     LAG_THRESHOLDS[cadence]`.
 *  4. a fully-fresh store issues NO stage-2 query (§COST): `freshnessFrom` reads only its stage-1
 *     batch, so `getSeriesBulk` is called exactly `1 + ceil(slotIds / LAG_CHUNK_IDS)` times and every
 *     row is tier-derived. A single DARK daily feed is left in to exercise the lagging-first sort and
 *     the NO-DATA (no p90 ⇒ tier) branch WITHOUT arming a stage-2 read (a slot suspect reuses the
 *     stage-1 window; only a monthly/quarterly suspect would issue a new query).
 */
import { beforeAll, describe, expect, test } from "vitest";

import { InMemoryStore } from "../src/store-memory.js";
import { type Store, type StoredReading } from "../src/store.js";
import { makeAlert } from "../src/test-helpers.js";
import { CADENCE_OF, DEEP_LAG_MULTIPLE, FEED_TZ_OF, LAG_CHUNK_IDS } from "../src/feed-lag.js";
import { LAG_THRESHOLDS } from "../src/ladder.js";
import { todayOnFeedCalendar } from "../src/dates.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { COMPOSITE_COMPONENTS } from "../src/registry-composite.js";
import type { StatusResponse } from "../src/api/types.js";
import { handle } from "./status.js";

// The clock is the fixture's input, injected through `handle`'s `opts.now` seam (rung 8b) — the
// production default (a real clock read) never runs here. Each describe seeds its OWN store.
const NOW = new Date("2026-06-26T12:00:00.000Z");
const get = async (store: Store): Promise<StatusResponse> =>
  (await (await handle(() => store, undefined, { env: {}, now: NOW })).json()) as StatusResponse;

// The registry roster, derived from the REGISTRY (not CADENCE_OF) so a handler that drops a feed
// reds test 1 instead of the check silently tracking the drop.
const REGISTRY_IDS = [
  ...ALL_INDICATORS.map((i) => i.id),
  ...Object.values(COMPOSITE_COMPONENTS).flatMap((cs) => cs.map((c) => c.id)),
];

// One DARK daily feed — left unseeded so it is NO-DATA (lag: true, no p90 ⇒ source "tier"), which
// exercises the lagging-first sort. Daily/weekly ⇒ a SLOT suspect, which stage 2 serves off the
// stage-1 window, so it adds NO getSeriesBulk call (test 4 stays true). Picked deterministically.
const DARK_ID = [...CADENCE_OF].find(([, c]) => c === "daily")![0];

const freshRow = (id: string): StoredReading => ({
  // dated TODAY on the feed's OWN publication calendar ⇒ age 0 ⇒ FRESH for every id, the same seam
  // `freshnessFrom` resolves each id's "today" through.
  date: todayOnFeedCalendar(FEED_TZ_OF.get(id), NOW),
  indicatorId: id,
  value: 1,
  delta20: 0,
  rawState: "GREEN",
  state: "GREEN",
});

const TODAY = todayOnFeedCalendar(undefined, NOW);
const RUN_AT = "2026-06-26T05:00:00.000Z";

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const weekdaysBetween = (fromISO: string, toISO: string): string[] => {
  const out: string[] = [];
  for (const d = new Date(`${fromISO}T00:00:00Z`); iso(d) <= toISO; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(iso(d));
  }
  return out;
};
const rowsFor = (id: string, dates: string[]): StoredReading[] =>
  dates.map((date) => ({ date, indicatorId: id, value: 1, delta20: 0, rawState: "GREEN" as const, state: "GREEN" as const }));
/** Pure roster builder: every registered feed prints `peerDates`, except `targetId`, which prints `targetDates`. */
const rosterRows = (targetId: string, targetDates: string[], peerDates: string[]): StoredReading[] =>
  REGISTRY_IDS.flatMap((id) => rowsFor(id, id === targetId ? targetDates : peerDates));

/** A fresh store holding `rows` plus one reading-less run (it must not re-seed any feed's series). */
const seedStore = async (rows: StoredReading[]): Promise<InMemoryStore> => {
  const store = new InMemoryStore();
  await store.recordReadings(rows, RUN_AT);
  await store.recordRun([], RUN_AT, makeAlert({ date: TODAY, firedAt: RUN_AT }));
  return store;
};

describe("GET /api/status - the feedLag overview block (§7.2)", () => {
  // ONE GET serves every test below: through a counting delegate over the real-writer store, so the
  // stage-2 test reads its call count off the same response the roster tests read.
  let body: StatusResponse;
  let bulkCalls = 0;
  beforeAll(async () => {
    const seeded = await seedStore(REGISTRY_IDS.filter((id) => id !== DARK_ID).map(freshRow));
    // A counting delegate over the seeded store — instance-local, so the real read still answers
    // and no module seam is involved.
    const counting: Store = Object.assign(Object.create(seeded) as Store, {
      getSeriesBulk: (...args: Parameters<Store["getSeriesBulk"]>) => {
        bulkCalls += 1;
        return seeded.getSeriesBulk(...args);
      },
    });
    body = await get(counting);
  });

  test("the roster is registry-complete — one row per registered feed", () => {
    expect(body.feedLag, "the block is served when the freshness read succeeds").toBeDefined();
    const served = [...body.feedLag!.map((r) => r.id)].sort();
    expect(served, "every registered feed gets a row").toEqual([...new Set(REGISTRY_IDS)].sort());
  });

  test("a fully-griddable fresh store serves an EMPTY unmeasuredFeedIds set beside the pill", () => {
    // The set is emitted (stamp read succeeded) and empty — no feed here is ungriddable. A future
    // ungriddable feed would appear here and NOT in laggingFeedIds (the exclusion this field exists for).
    expect(body.unmeasuredFeedIds, "emitted with the pill fields").toEqual([]);
    for (const id of body.unmeasuredFeedIds ?? []) {
      expect(body.laggingFeedIds ?? [], "unmeasured ids are excluded from the lagging count").not.toContain(id);
    }
  });

  test("a tier row's deepLagBar is DEEP_LAG_MULTIPLE × the cadence tier", () => {
    const tierRows = body.feedLag!.filter((r) => r.source === "tier");
    expect(tierRows.length, "a fresh store yields tier-derived rows").toBeGreaterThan(0);
    for (const r of tierRows) {
      expect(r.deepLagBar, `${r.id} (${r.cadence}) tier bar`).toBe(LAG_THRESHOLDS[r.cadence] * DEEP_LAG_MULTIPLE);
    }
  });

  test("a fully-fresh store issues no stage-2 query and every row is tier-derived", () => {
    const slotIds = [...CADENCE_OF].filter(([, c]) => c === "daily" || c === "weekly");
    // stage 1 = one getSeriesBulk over the monthly/quarterly ids (limit 1) + one per slot chunk.
    // Stage 2 (the suspect deep read) would ADD calls; a fully-fresh store fires none.
    const expectedStage1Calls = 1 + Math.ceil(slotIds.length / LAG_CHUNK_IDS);
    // + 1: the ETFs-group `return20d` read (api/status.ts `ETF_CARD_IDS`), not part of the freshness walk.
    expect(bulkCalls, "no stage-2 deep read on a fresh store").toBe(expectedStage1Calls + 1);
    // The only lagging feed is the deliberately-dark slot id; every seeded feed is FRESH, and none
    // carries a measured p90, so the whole roster is tier-derived.
    expect(body.feedLag!.every((r) => r.source === "tier"), "no measured p90 without a suspect").toBe(true);
    expect(body.feedLag!.filter((r) => r.lag).map((r) => r.id), "only the dark feed lags").toEqual([DARK_ID]);
    // §7.2: lagging rows sort first.
    expect(body.feedLag![0]!.id, "the lagging feed sorts to the top").toBe(DARK_ID);
  });

  test("R10: a row whose newest point is intraday (RUN_AT before the cutoff) serves provisional", () => {
    const provisional = body.feedLag!.filter((r) => r.provisional === true).map((r) => r.id).sort();
    expect(provisional).toEqual([...new Set(REGISTRY_IDS)].filter((id) => id !== DARK_ID).sort());
  });
});

describe("GET /api/status - unmeasuredFeedIds excludes an ungriddable feed from the pill (slice 2)", () => {
  // The feed forced UNGRIDDABLE: a daily SERVED (independent, non-leg) feed. Its window carries a genuine
  // FOREIGN-calendar difference from the cohort — it prints three Saturdays no peer prints and is silent
  // across 06-15..06-19, weekdays every peer prints. Containment CHARGES those days and drops every peer, leaving the target below MIN_CALENDAR_SOURCES.
  // gridFor then throws ⇒ the row is `unmeasured`, not a fabricated `lag` (the live BRENT shape).
  const UNGRIDDABLE_ID = ALL_INDICATORS.find((i) => (CADENCE_OF.get(i.id) ?? "daily") === "daily")!.id;
  // Cohort window: every weekday of June up to `today`. Target window: prints 06-01..06-12, is SILENT
  // 06-15..06-19, prints again 06-22, plus three foreign Saturdays — a calendar difference that survives
  // the outage quorum.
  const PEER_DATES = weekdaysBetween("2026-06-01", "2026-06-26");
  const TARGET_DATES = [
    ...weekdaysBetween("2026-06-01", "2026-06-12"),
    "2026-06-22",
    "2026-06-06",
    "2026-06-13",
    "2026-06-20",
  ].sort();

  let store: InMemoryStore;
  beforeAll(async () => {
    store = await seedStore(rosterRows(UNGRIDDABLE_ID, TARGET_DATES, PEER_DATES));
  });

  test("the ungriddable feed is served unmeasured, NOT lagging, and the pill count matches its ids", async () => {
    const body = await get(store);
    // The exclusion this field exists for: a feed whose lateness is UNCOMPUTABLE is served unmeasured,
    // never counted behind.
    expect(body.unmeasuredFeedIds, "the ungriddable feed is served unmeasured").toContain(UNGRIDDABLE_ID);
    expect(body.laggingFeedIds ?? [], "an unmeasured feed is NOT counted lagging").not.toContain(UNGRIDDABLE_ID);
    const row = body.feedLag!.find((r) => r.id === UNGRIDDABLE_ID)!;
    expect(row.unmeasured, "the row self-identifies unmeasured").toBe(true);
    expect(row.lag, "no fabricated lag verdict on an unmeasured row").toBeUndefined();
    // ONE expression feeds both the count and the names, so the pill can never print a number that
    // disagrees with the ids it lists.
    expect(body.feedsLagging).toBe((body.laggingFeedIds ?? []).length);
  });
});

describe("GET /api/status - a measured slot row's deep split", () => {
  const TARGET_ID = ALL_INDICATORS.find((i) => (CADENCE_OF.get(i.id) ?? "daily") === "daily")!.id;
  const PEER_DATES = weekdaysBetween("2026-05-01", TODAY);
  // Silent for the last trading week: 7 calendar days, 5 slots behind.
  const TARGET_DATES = weekdaysBetween("2026-05-01", "2026-06-19");
  // A weekday-only feed's p90 gap is the 3-day weekend gap.
  const DAY_BAR = DEEP_LAG_MULTIPLE * Math.max(3, LAG_THRESHOLDS.daily);

  let store: InMemoryStore;
  beforeAll(async () => {
    store = await seedStore(rosterRows(TARGET_ID, TARGET_DATES, PEER_DATES));
  });

  test("serves the server's DEEP-LAG verdict and the bar recounted in slots", async () => {
    const body = await get(store);
    const row = body.feedLag!.find((r) => r.id === TARGET_ID)!;
    expect(row.source).toBe("p90");
    expect(row.ageUnit).toBe("slots");
    expect(row.lag).toBe(true);
    expect(row.deep, "7 calendar days > the day bar ⇒ the server says DEEP-LAG").toBe(true);
    const cutoff = iso(new Date(Date.parse(TODAY) - DAY_BAR * 86_400_000));
    expect(row.deepLagBar, "the day bar, recounted as publication slots").toBe(PEER_DATES.filter((d) => d > cutoff).length);
    // Only the lagging, measured row carries a verdict.
    expect(body.feedLag!.filter((r) => r.deep !== undefined).map((r) => r.id)).toEqual([TARGET_ID]);
  });
});
