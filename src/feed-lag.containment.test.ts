/**
 * `freshnessFrom` contains a per-feed calendar failure — it must NEVER degrade the whole stamp.
 *
 * Regression for the 2026-09-10 prod outage: `containmentGrid` throws by design below
 * `MIN_CALENDAR_SOURCES`, and that throw used to escape `freshnessFrom` entirely. Both `api/status.ts`
 * and `api/lab.ts` catch this call at the TOP, so ONE un-griddable feed (BRENT, on ICE London's
 * holiday calendar) took down every other feed's age, `/api/status`'s whole `feedLag` roster AND its
 * lagging pill, and left `/api/lab` serving `freshnessMissing: true`.
 *
 * The contract pinned here: the stamp RESOLVES, the healthy feeds keep real ages, and the broken feed
 * degrades to the same shape a zero-row id has — `lag: true` with NO `ageDays`/`ageUnit` key, the
 * absent-on-no-measurement contract `FreshnessStamp.ageDays` binds consumers to. Never a fabricated 0.
 */
import { describe, expect, it, vi } from "vitest";
import { CADENCE_OF, FEED_TZ_OF, freshnessFrom, LAG_CHUNK_IDS, LAG_SCAN_LIMIT } from "./feed-lag.js";
import { INTRADAY_CUTOFF_UTC_MIN } from "./intraday.js";
import { todayOnFeedCalendar } from "./dates.js";
import { slotAge } from "./publication-calendar.js";
import { InMemoryStore } from "./store-memory.js";
import { makeAlert, makeStoredReading } from "./test-helpers.js";
import { ESTIMATE_ROW_IDS } from "./nowcast-score.js";
import { CHART_ONLY_IDS } from "./registry-composite.js";
import { QUOTE_GRAFT_CARDS } from "./estimated.js";
import type { SeriesPoint, Store, StoredReading } from "./store.js";

/** Weekdays from `from`, `n` of them — a dense daily window every peer shares. */
function weekdays(from: string, n: number): string[] {
  const out: string[] = [];
  const t = new Date(`${from}T00:00:00Z`);
  while (out.length < n) {
    const day = t.getUTCDay();
    if (day !== 0 && day !== 6) out.push(t.toISOString().slice(0, 10));
    t.setUTCDate(t.getUTCDate() + 1);
  }
  return out;
}

const pts = (dates: readonly string[]): SeriesPoint[] => dates.map((date) => ({ date, value: 1 }) as SeriesPoint);

/**
 * Every id gets the SAME dense weekday window, except `brokenId`, which is silent on a scattered set
 * of days the rest of the cohort prints.
 *
 * ⚠ The broken feed misses ~8 interior weekdays. The guarantee under test is `freshnessFrom`'s
 * containment, not a replica of the live shape. Those days are weekdays it prints elsewhere (so §16's
 * plausibility filter keeps them chargeable), so at `CONTAINMENT_TOLERANCE = 0` every peer is charged
 * and dropped — the live BRENT shape, in miniature.
 */
function storeWithOneUngriddableFeed(brokenId: string, holidays: readonly string[]): Store {
  const window = weekdays("2026-03-02", 130);
  const getSeriesBulk = vi.fn(async (ids: string[]) => {
    const out = new Map<string, SeriesPoint[]>();
    for (const id of ids) {
      // The broken feed is silent on the holidays; a handful of peers print on them, which is what
      // charges those peers at zero tolerance.
      out.set(id, pts(id === brokenId ? window.filter((d) => !holidays.includes(d)) : window));
    }
    return out;
  });
  return { getSeriesBulk } as unknown as Store;
}

describe("freshnessFrom - a per-feed calendar failure is contained", () => {
  const ids = [...CADENCE_OF.keys()];
  const slotIds = ids.filter((id) => {
    const c = CADENCE_OF.get(id) ?? "daily";
    return c === "daily" || c === "weekly";
  });
  // Pick the target off the live registry rather than naming BRENT: the guarantee is about ANY feed
  // whose grid cannot be built, and hard-coding an id would rot the moment the registry moves.
  const broken = slotIds[0]!;
  // Scattered interior weekdays the broken feed skips — past CONTAINMENT_TOLERANCE for peers that
  // print on them.
  const holidays = weekdays("2026-03-02", 130).filter((_, i) => i % 17 === 3);

  it("resolves the stamp, keeps every healthy feed's age, and degrades + names only the broken feed", async () => {
    const warned: unknown[][] = [];
    const store = storeWithOneUngriddableFeed(broken, holidays);

    const stamp = await freshnessFrom(store, new Date("2026-09-10T12:00:00Z"), (...a) => warned.push(a));

    // The whole point: it RESOLVES. Before containment this rejected and the caller served nothing.
    expect(stamp.freshness.length).toBe(ids.length);
    // EVERY healthy slot feed keeps a real measured age, not merely one — `.some` would still pass
    // if the containment leaked and degraded most of the roster, which is the regression that matters.
    // The broken feed is silent on days its peers printed, which charges nothing against a healthy
    // target, so all of them grid.
    const healthy = slotIds.filter((id) => id !== broken);
    expect(healthy.filter((id) => !stamp.ageDays.has(id))).toEqual([]);

    // The broken feed degrades to unmeasured: lateness was uncomputable, so `unmeasured: true` and NO
    // `lag` key (never a fabricated `lag: true`).
    const row = stamp.freshness.find((f) => f.id === broken);
    expect(row?.unmeasured).toBe(true);
    expect(row && "lag" in row).toBe(false);
    // ⚠ The load-bearing half: absent, not 0. A 0 here reads as "fresh today" on every consumer.
    expect(stamp.ageDays.has(broken)).toBe(false);
    // `ageUnit` shares its keys with `ageDays` exactly — the pair moves as one source.
    expect(stamp.ageUnit.has(broken)).toBe(false);

    // It says WHICH feed lost its calendar, so the degrade is not silent.
    expect(warned.some((c) => String(c[0]).includes(broken))).toBe(true);

    // A MONTHLY id stays on CALENDAR days (§5), never the slot grid.
    const monthly = ids.find((id) => CADENCE_OF.get(id) === "monthly")!;
    const calendarDays = (Date.parse("2026-09-10") - Date.parse(weekdays("2026-03-02", 130).at(-1)!)) / 86_400_000;
    expect([stamp.ageUnit.get(monthly), stamp.ageDays.get(monthly)]).toEqual(["days", calendarDays]);
  });
});

/**
 * Feed-lag slice 1: a composite LEG inherits its PARENT's
 * containment grid instead of being gridded alone. A leg has 0 independent sources (its siblings are
 * legs too), so gridding it alone throws below `MIN_CALENDAR_SOURCES` and degrades to the fabricated
 * `lag: true` with NO age — the false-behind pill counted `CMP_BUND_*` (which printed TODAY) as
 * behind. R14.3: a leg shares its parent's fetch, so it shares the parent's publication calendar.
 */
describe("freshnessFrom - a composite leg rides its parent's grid", () => {
  const LEG = "CMP_BUND_DE2Y";
  const PARENT = "BUND"; // COMPOSITE_COMPONENTS key for CMP_BUND_DE2Y

  // The DISCRIMINATING regime — a dense fixture cannot tell the fix from the bug (dozens of
  // independent peers survive, so the leg grids alone too). Instead the LEG carries the same
  // ungriddable shape the first suite's `broken` feed does: a mostly-dense window silent on a
  // scatter of interior weekdays its peers all print. Being mostly-dense, its peers ARE admitted as
  // calendar voters (a Mondays-only target has none, so nothing charges and it grids alone anyway),
  // so those missed days ARE chargeable, and at CONTAINMENT_TOLERANCE = 0 EVERY independent peer is
  // charged and dropped — the leg alone reaches 0 sources and THROWS. The PARENT is fully dense, so
  // nothing charges against it and it grids off all its peers. Only riding the parent grid ages the
  // leg here.
  const holidays = weekdays("2026-03-02", 130).filter((_, i) => i % 17 === 3);

  function storeRidingParentGrid(): Store {
    const dense = weekdays("2026-03-02", 130);
    // The leg misses the scattered interior days (⇒ ungriddable alone) AND its last day (⇒ its
    // newest is 1 dense slot behind the parent's, which proves the AGE is the leg's OWN observation
    // while the CALENDAR is the parent's).
    const legWindow = dense.filter((d) => !holidays.includes(d)).slice(0, -1);
    const getSeriesBulk = vi.fn(async (ids: string[]) => {
      const out = new Map<string, SeriesPoint[]>();
      for (const id of ids) out.set(id, pts(id === LEG ? legWindow : dense));
      return out;
    });
    return { getSeriesBulk } as unknown as Store;
  }

  it("grids the leg on the parent's calendar where gridding it alone would throw", async () => {
    const stamp = await freshnessFrom(storeRidingParentGrid(), new Date("2026-09-10T12:00:00Z"));

    // The parent grids (dense ⇒ nothing charged, all peers survive).
    const parentAge = stamp.ageDays.get(PARENT);
    expect(parentAge).not.toBeUndefined();

    // Pre-fix: the leg was gridded ALONE → every independent peer dropped → 0 sources → threw →
    // `lag: true`, NO age. Slice 1: it now HAS a real measured slot age off the parent's calendar.
    expect(stamp.ageDays.has(LEG)).toBe(true);
    expect(stamp.ageUnit.get(LEG)).toBe("slots");

    // Age is the LEG's OWN newest (1 dense slot behind the parent), scored on the PARENT's grid:
    // same calendar (equality would hold at offset 0) AND leg-owned-newest (the +1).
    expect(stamp.ageDays.get(LEG)).toBe(parentAge! + 1);
  });
});

/** R10 (plan 2026-09-29 intraday, B6): an intraday newest row ages 0 and carries `provisional`. */
describe("freshnessFrom - a provisional newest row is flagged (R10)", () => {
  const TODAY = "2026-09-10";
  const cutoff = Date.parse(`${TODAY}T00:00:00Z`) + INTRADAY_CUTOFF_UTC_MIN * 60_000;
  const daily = [...CADENCE_OF.keys()].filter((id) => (CADENCE_OF.get(id) ?? "daily") === "daily");
  const [intraday, final] = [daily[0]!, daily[1]!];

  function storeWithRunAts(): Store {
    const dense = weekdays("2026-03-02", 200).filter((d) => d <= TODAY);
    const getSeriesBulk = vi.fn(async (ids: string[]) => {
      const out = new Map<string, SeriesPoint[]>();
      for (const id of ids) {
        const series = pts(dense);
        const runAt = id === intraday ? cutoff - 60_000 : id === final ? cutoff : undefined;
        if (runAt !== undefined) series[series.length - 1]!.runAt = new Date(runAt).toISOString();
        out.set(id, series);
      }
      return out;
    });
    return { getSeriesBulk } as unknown as Store;
  }

  it("marks only the row whose newest point was written before its date's cutoff; both age 0", async () => {
    const stamp = await freshnessFrom(storeWithRunAts(), new Date(`${TODAY}T15:00:00Z`));
    const rowOf = (id: string) => stamp.freshness.find((f) => f.id === id);
    expect(rowOf(intraday)?.provisional).toBe(true);
    expect(stamp.ageDays.get(intraday)).toBe(0);
    expect(rowOf(final)?.provisional).toBeUndefined();
    expect(stamp.ageDays.get(final)).toBe(0);
    expect(stamp.freshness.filter((f) => f.provisional).map((f) => f.id)).toEqual([intraday]);
  });
});

/** E11 (plan 2026-10-03 estimated-value-all-indicators): a feed's age is its newest PRINT — an `estimated` head
 *  (T10YIE/G1/BRENT) carried past a source outage must never read the feed fresh. */
describe("freshnessFrom - an `estimated` head never ages a feed", () => {
  const TODAY = "2026-09-10";
  const ID = "T10YIE";
  const dense = weekdays("2026-03-02", 200).filter((d) => d <= TODAY);
  const prints = dense.slice(0, -5); // a source outage: five slots without a print

  function storeWith(estimateHead: boolean): Store {
    const getSeriesBulk = vi.fn(async (ids: string[]) => {
      const out = new Map<string, SeriesPoint[]>();
      for (const id of ids) {
        if (id !== ID) out.set(id, pts(dense));
        else out.set(id, [...pts(prints), ...(estimateHead ? [{ date: TODAY, value: 2, estimated: true } as SeriesPoint] : [])]);
      }
      return out;
    });
    return { getSeriesBulk } as unknown as Store;
  }

  it("every estimate-row id (+ each quote card's EOD quote head) is a slot (deep-read) feed, so the print filter reaches it", () => {
    const slot = (id: string) => ["daily", "weekly"].includes(CADENCE_OF.get(id) ?? "unregistered");
    const cards = QUOTE_GRAFT_CARDS;
    expect(ESTIMATE_ROW_IDS).toContain("VXNCLS");
    const estimateIds = ESTIMATE_ROW_IDS.filter((id) => !CHART_ONLY_IDS.includes(id)); // chart-only VXNCLS is never on the feed-lag roster
    expect([...estimateIds, ...cards].filter((id) => !slot(id))).toEqual([]);
  });

  // `newest` keeps the estimate: its one consumer is /status's B7 overlay, which serves it as EST (E3).
  it("an estimate head over an old print reports the print's age, but `newest` stays the estimate", async () => {
    const now = new Date(`${TODAY}T23:00:00Z`);
    const [withEst, printsOnly] = await Promise.all([freshnessFrom(storeWith(true), now), freshnessFrom(storeWith(false), now)]);
    expect(printsOnly.ageDays.get(ID)).toBeGreaterThan(0); // non-vacuity: the print IS stale
    expect(withEst.ageDays.get(ID)).toBe(printsOnly.ageDays.get(ID));
    expect(withEst.newest.get(ID)).toMatchObject({ date: TODAY, estimated: true });
    expect(printsOnly.newest.get(ID)?.date).toBe(prints.at(-1));
  });
});

describe("R14.4 stage-1 derivation — per-target containment grids, euro self-partitions (§15/§16c)", () => {
  // R14.4 retired the tz-keyed cohort table (`CALENDAR_COHORTS`/`calendarCohortOf`). Every
  // daily/weekly id `freshnessFrom` scores now derives its OWN slot grid from `containmentGrid` over
  // `allDailyFeeds`, and the `publicationCalendar` floor throw stays the fail-loud mechanism — BOTH
  // `freshnessFrom` call sites (api/status.ts, api/lab.ts) CATCH that throw, so a target that falls
  // below the floor silently degrades the WHOLE stamp. These pin the equivalent of the retired
  // cohort-table coverage under the new derivation.

  /** A run of business days (Mon–Fri) from `start`, `count` weekdays, optionally skipping holidays. */
  function businessDays(start: string, count: number, skip: readonly string[] = []): string[] {
    const out: string[] = [];
    const skipSet = new Set(skip);
    let t = Date.parse(`${start}T00:00:00Z`);
    while (out.length < count) {
      const d = new Date(t).toISOString().slice(0, 10);
      const dow = new Date(t).getUTCDay();
      if (dow !== 0 && dow !== 6 && !skipSet.has(d)) out.push(d);
      t += 86_400_000;
    }
    return out;
  }

  it("THROUGH freshnessFrom: a euro target self-partitions off a US-only phantom slot, not a plain union", async () => {
    // `containmentGrid`'s own tests (src/publication-calendar.test.ts) build the grid DIRECTLY; this
    // drives the SAME shape THROUGH the freshnessFrom wiring under review (R14.4 stage 1). A revert of stage 1 to a plain union
    // over every daily feed's dates would keep the deep-read shape and pass every OTHER freshness test
    // (moved here from api/lab.test.ts — `freshnessFrom` is pure over its store) — but it would pool the US-only phantom slot D2 into EURGBP's grid and read its age 4, not 3.
    // Only ageDays discriminates here: both 3 and 4 clear the daily slot cut of 1, so `lag` stays
    // true either way. Grounded on the REAL euro-tz daily ids the wiring places in `allDailyFeeds`.
    const D1 = "2026-08-06"; // Thu — euro holiday INSIDE EURGBP's live window: 08-06 is then a chargeable
    //                          silent day the US feeds print, so containment DROPS them from EURGBP's grid.
    const D2 = "2026-08-17"; // Mon — euro holiday AFTER EURGBP's newest, before "today": the US-only
    //                          phantom print a pooled union would inject as an extra slot.
    // Pin "today" to the euro business day right after the window, so D2 is the ONLY slot separating
    // containment (3) from a plain union (4) — a later NOW would swamp it under unrelated slots.
    const NOW_EURO = new Date("2026-08-19T09:00:00Z"); // 11:00 CEST ⇒ Berlin "today" = 2026-08-19
    const today = todayOnFeedCalendar(FEED_TZ_OF.get("EURGBP"), NOW_EURO);
    expect(today).toBe("2026-08-19"); // premise guard: the anchor the age math below assumes

    const usDays = businessDays("2026-08-03", 15); // SIFMA run — prints through D1 and D2
    const euroDays = businessDays("2026-08-03", 17, [D1, D2]).filter((d) => d <= "2026-08-19"); // euro venue closed D1/D2
    const usIds = ["F1", "F2", "R1", "R2"] as const; // US-tz independent daily feeds (print the phantom day)
    const euroIds = ["EURC", "BUND", "ESTR"] as const; // euro-tz independent daily peers — they skip D1 too, so
    //                                                    08-06 is chargeable to the US feeds that printed it
    const TARGET_DATES = euroDays.filter((d) => d <= "2026-08-13"); // EURGBP's own prints; newest = 2026-08-13 (Thu)

    const mk = (id: string, date: string): StoredReading => makeStoredReading(id, { date });
    const store = new InMemoryStore();
    await store.recordRun(
      [
        ...usIds.flatMap((id) => usDays.map((d) => mk(id, d))),
        ...euroIds.flatMap((id) => euroDays.map((d) => mk(id, d))),
        ...TARGET_DATES.map((d) => mk("EURGBP", d)),
      ],
      "2026-06-25T21:00:00.000Z",
      makeAlert(),
    );

    const { ageDays, ageUnit } = await freshnessFrom(store, NOW_EURO);
    // CONTAINMENT: EURGBP's grid drops the US feeds (they printed the chargeable silent day 08-06), so the
    // US-only D2 print stays OUT of the grid and only euro slots after 08-13 count: 08-14, 08-18, 08-19.
    expect(ageUnit.get("EURGBP")).toBe("slots");
    expect(ageDays.get("EURGBP")).toBe(3);

    // NON-VACUITY, on the discriminating column: the phantom slot exists and a plain union WOULD
    // charge it. The union grid over the SAME seeded daily feeds reads 4 — the exact +1 the revert ships.
    const unionDates = [...new Set([...usDays, ...euroDays, ...TARGET_DATES])].sort();
    expect(slotAge("2026-08-13", today, { cohort: "union", dates: unionDates }, () => false)).toBe(4); // raw union, no excusal
    expect(unionDates).toContain(D2); // …and D2 is that discriminating slot the union pools in
  });
});

/** Characterization of the stage-1 READ SHAPE (ai-debt sweep 5.8): one `limit: 1` read of every
 *  monthly/quarterly id, then the daily/weekly ids `LAG_SCAN_LIMIT`-deep in `LAG_CHUNK_IDS` chunks —
 *  and the deep window's estimate filter: an all-estimate slot feed ages as zero-row yet keeps its
 *  raw head on `newest`. */
describe("freshnessFrom - stage-1 read shape", () => {
  const TODAY = "2026-09-10";
  const ids = [...CADENCE_OF.keys()];
  const isSlot = (id: string) => ["daily", "weekly"].includes(CADENCE_OF.get(id) ?? "daily");
  const slotIds = ids.filter(isSlot);
  const dayIds = ids.filter((id) => !isSlot(id));
  const ALL_EST = slotIds.find((id) => (CADENCE_OF.get(id) ?? "daily") === "daily")!;
  const dense = weekdays("2026-03-02", 200).filter((d) => d <= TODAY);

  it("reads day ids shallow then slot ids deep in chunks; an all-estimate slot feed is zero-row with its raw head kept", async () => {
    const calls: { ids: string[]; limit: number | undefined }[] = [];
    const getSeriesBulk = vi.fn(async (req: string[], opts?: { limit?: number }) => {
      calls.push({ ids: [...req], limit: opts?.limit });
      const out = new Map<string, SeriesPoint[]>();
      for (const id of req) {
        const series =
          id === ALL_EST ? dense.map((date) => ({ date, value: 1, estimated: true }) as SeriesPoint) : pts(dense);
        out.set(id, opts?.limit === undefined ? series : series.slice(-opts.limit));
      }
      return out;
    });
    const stamp = await freshnessFrom({ getSeriesBulk } as unknown as Store, new Date(`${TODAY}T23:00:00Z`));

    const chunks: string[][] = [];
    for (let i = 0; i < slotIds.length; i += LAG_CHUNK_IDS) chunks.push(slotIds.slice(i, i + LAG_CHUNK_IDS));
    expect(chunks.length).toBeGreaterThan(1); // non-vacuity: the chunk loop is exercised past one chunk
    expect(dayIds.length).toBeGreaterThan(0);
    expect(calls.slice(0, 1 + chunks.length)).toEqual([
      { ids: dayIds, limit: 1 },
      ...chunks.map((c) => ({ ids: c, limit: LAG_SCAN_LIMIT })),
    ]);

    expect(stamp.freshness.find((f) => f.id === ALL_EST)).toEqual({ id: ALL_EST, lag: true, label: "NO-DATA" }); // stage 2 reuses the FILTERED window
    expect(stamp.ageDays.has(ALL_EST)).toBe(false);
    expect(stamp.newest.get(ALL_EST)).toMatchObject({ date: TODAY, estimated: true });
    // A day id's `limit: 1` row is its newest; a healthy slot id's newest is the dense head.
    expect(stamp.newest.get(dayIds[0]!)?.date).toBe(TODAY);
    expect(stamp.newest.get(slotIds.find((id) => id !== ALL_EST)!)?.date).toBe(TODAY);
    expect(stamp.newest.size).toBe(ids.length);
  });
});
