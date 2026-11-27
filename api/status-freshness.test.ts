/**
 * GET /api/status — the TWO freshness surfaces, in the one regime that discriminates them.
 *
 * WHY ITS OWN FILE rather than a case in `api/status.test.ts`: both claims need a store whose
 * roster is almost entirely empty AND a pinned clock, and that file's module-level store is
 * wall-clock-anchored (its CAPE window is built off the real clock). A second alert recorded into
 * it would also displace `getLastAlert` for every case there.
 *
 * The fixture puts the two pills in DISAGREEMENT, which is the whole point of shipping both:
 *   • `verdict.date` is TODAY ⇒ the run-wide heartbeat (`stale`/`feedAgeDays`) reads FRESH;
 *   • exactly ONE id (F1) has any stored observation ⇒ every other roster id is past its own cut,
 *     so `feedsLagging` is the roster minus one.
 * A `feedsLagging` wired to the heartbeat instead of the per-feed roster reads 0 here and goes red.
 *
 * It also pins §Ruled contract 1 — a reading's age follows the SERIES, not the run's row. The run
 * wrote an OLD F1 row over a newer stored one (the 2-of-9-legs false-stale `freshnessFrom`'s
 * docblock records); `date` still names the run's row, while `ageDays`/`stale` describe the feed.
 */
import { beforeAll, describe, expect, test } from "vitest";

import { InMemoryStore } from "../src/store-memory.js";
import { type Store, type StoredReading } from "../src/store.js";
import { makeAlert } from "../src/test-helpers.js";
import { CADENCE_OF } from "../src/feed-lag.js";
import { assessIndicatorFreshness } from "../src/ladder.js";
import { todayOnFeedCalendar } from "../src/dates.js";
import { META } from "../src/api/http.js";
import { VAL_Z_WINDOW } from "../src/valuation.js";
import type { StatusResponse } from "../src/api/types.js";
import { handle, statusBody } from "./status.js";

const store = new InMemoryStore();

// The clock is the fixture's input, injected through `handle`'s `opts.now` seam (rung 8b) — the
// production default (a real clock read) never runs here. Every date below is derived from NOW.
const NOW = new Date("2026-06-26T12:00:00.000Z");
const get = () => handle(() => store, undefined, { env: {}, now: NOW });

// A read-only store variant with one method overridden: the fixture store stays the prototype, so
// every other read still answers from the seeded series. Instance-local — no module seam involved.
const overriding = (over: Partial<Store>): Store => Object.assign(Object.create(store) as Store, over);

// `today` on the DEFAULT publication calendar — derived through the same seam the handler and
// `freshnessFrom` resolve their dates through, never hand-typed as a UTC slice.
const TODAY = todayOnFeedCalendar(undefined, NOW);
// The stale row the RUN wrote — old enough to be past the daily cut, which the guard in the second
// test asserts off `assessIndicatorFreshness` rather than assuming.
const RUN_ROW_DATE = "2026-06-01";

const RUN_AT = "2026-06-25T21:00:00.000Z";
// Past the 21:05 UTC cutoff: a FINAL row. 21:00 would be an INTRADAY one, which B7 overlays onto the card.
const LATER_RUN_AT = "2026-06-26T22:00:00.000Z";

const row = (date: string): StoredReading => ({
  date,
  indicatorId: "F1",
  value: 4.2,
  delta20: 0.3,
  rawState: "GREEN",
  state: "GREEN",
});

// ── F7/CAPE: the SECOND site §Ruled contract 1 names ────────────────────────────────────────────
// The bridge serves a value-only F7 card read-time. Its age/stale must follow the SERIES like every
// other reading — nothing pinned that, and reverting the site to `capeRunRow` left the whole suite
// green (review I1). The discriminating regime is the one `api/status.ts` states: the NEWEST STORED
// F7 row is one the bridge will NOT serve (here: a non-finite value, dropped by BOTH
// `computeCapeValuation`'s `Number.isFinite` filter and the `capeDate` pick, kept by the freshness
// roster, which reads dates only). Series age ⇒ measured from that row; run-row age ⇒ from the
// served monthly observation. They differ by weeks.
const CAPE_RUN_AT = "2026-06-26T05:00:00.000Z";
// `today` on F7's OWN publication calendar, resolved through the same seam the handler uses.
const F7_TODAY = todayOnFeedCalendar(META.get("F7")?.feedTimeZone, NOW);
// The newest observation the bridge SERVES — a full VAL_Z_WINDOW of monthly points is required or
// `computeCapeValuation` degrades and no F7 card is served at all.
const CAPE_SERVED_DATE = "2026-06-01";
// The newest STORED F7 row: later than the served one, and non-finite so the bridge skips it.
const CAPE_UNSERVED_DATE = "2026-06-20";
const capeRow = (date: string, value: number): StoredReading => ({
  date,
  indicatorId: "F7",
  value,
  delta20: 0,
  rawState: "GREEN",
  state: "GREEN",
});
await store.recordReadings(
  [
    ...Array.from({ length: VAL_Z_WINDOW }, (_, i) =>
      // 360 monthly points ending on CAPE_SERVED_DATE; the values vary so the z-window is not
      // degenerate (an all-equal window degrades to no card).
      capeRow(new Date(Date.UTC(2026, 5 - (VAL_Z_WINDOW - 1 - i), 1)).toISOString().slice(0, 10), 20 + (i % 11)),
    ),
    capeRow(CAPE_UNSERVED_DATE, Number.NaN),
  ],
  CAPE_RUN_AT,
);

// The NEWER stored observation, written by a run that is NOT the alert's run…
await store.recordReadings([row(TODAY)], LATER_RUN_AT);
// …and the alert's own run, carrying an OLDER row for the same id. `verdict.date` is TODAY: the
// heartbeat reads the verdict, not the readings, so it is fresh while this row is not.
await store.recordRun([row(RUN_ROW_DATE), { ...row(RUN_ROW_DATE), indicatorId: "VXSMH" }], RUN_AT, makeAlert({ date: TODAY, firedAt: RUN_AT }));

describe("GET /api/status - the run-wide heartbeat and the per-feed pill are independent", () => {
  // ONE body serves the three tests below — same store, same clock.
  let body: StatusResponse;
  beforeAll(async () => {
    body = (await (await get()).json()) as StatusResponse;
  });

  test("one fresh feed keeps `stale` false while the per-feed roster counts every other id behind", () => {
    // Heartbeat: asOf === today ⇒ fresh. Byte-identical to its pre-pill behaviour (`assessFreshness`
    // over `verdict.date`), which is the "keep BOTH pills" ruling.
    expect(body.lag, "run-wide heartbeat reads fresh").toBe(false);
    expect(body.feedAgeDays).toBe(0);

    // Per-feed: the denominator is `freshnessFrom`'s FULL roster, derived here rather than typed.
    expect(body.feedsTotal, "denominator is the freshness roster").toBe(CADENCE_OF.size);
    // F1 and F7 are the ONLY ids with a current stored observation ⇒ every other roster id is past
    // its own cut. This is the assertion a heartbeat-wired `feedsLagging` (0 here) cannot satisfy.
    expect(body.feedsLagging).toBe(CADENCE_OF.size - 2);
    expect(body.laggingFeedIds?.length, "the tooltip ids ARE the counted set").toBe(body.feedsLagging);
    expect(body.laggingFeedIds, "the two current feeds are not counted behind").not.toContain("F1");
    expect(body.laggingFeedIds).not.toContain("F7");
  });

  test("a reading's age follows the SERIES, not the older row the run wrote", () => {
    const f1 = body.readings.find((r) => r.indicatorId === "F1");

    // The served `date` is still the RUN's row — only the freshness moved sources.
    expect(f1?.date, "date names the run's own row").toBe(RUN_ROW_DATE);
    // …while the age is measured against the newest STORED observation (TODAY) ⇒ 0 and fresh.
    expect(f1?.ageDays, "age is measured from the newest stored observation").toBe(0);
    expect(f1?.lag).toBe(false);

    // Non-vacuity: the fixture really sits in the regime where the two sources DISAGREE. Derived
    // from the cut via the same helper the old wiring used — a hand-typed age would drift with it.
    expect(
      assessIndicatorFreshness(RUN_ROW_DATE, TODAY, "daily").lag,
      "the run-row source alone would have called F1 stale",
    ).toBe(true);
  });

  // §Ruled contract 1 names BOTH sites; only the loop above was pinned (review I1).
  test("the F7/CAPE bridge ages off the SERIES too, not the observation it serves", () => {
    const f7 = body.readings.find((r) => r.indicatorId === "F7");

    // The bridge still SERVES the newest finite observation…
    expect(f7?.date, "the served observation is the newest finite one").toBe(CAPE_SERVED_DATE);
    expect([f7?.valueOnly, body.readings.find((r) => r.indicatorId === "VXSMH")?.valueOnly], "F7 + a cut-less chart-only card (CUTLESS_CHART_IDS) neutralize their dot").toEqual([true, true]);
    // …while age/stale describe the newest STORED F7 row, which the bridge skipped.
    const series = assessIndicatorFreshness(CAPE_UNSERVED_DATE, F7_TODAY, "monthly");
    expect(f7?.ageDays, "age is measured from the newest stored F7 observation").toBe(series.ageDays);
    expect(f7?.lag).toBe(series.lag);

    // Non-vacuity: the two sources really disagree here, so reverting this site to `capeRunRow`
    // reds. Derived through the same helper the old wiring used, never hand-typed.
    const runRow = assessIndicatorFreshness(CAPE_SERVED_DATE, F7_TODAY, "monthly");
    expect(runRow.ageDays, "the run-row source would have reported a different age").not.toBe(series.ageDays);
  });
});

describe("GET /api/status - a failed freshness read degrades, it does not 500", () => {
  // `api/lab.ts` catches `freshnessFrom` (`.catch(() => undefined)`); `/api/status` calling it bare
  // turned any `getSeriesBulk` failure — or an `assertNotTruncated` throw — into a 500 on the
  // PRIMARY dashboard payload, which had always served a verdict regardless (review I3).
  test("still serves the verdict, omits the pill fields, and pairs BOTH age fields off the run row", async () => {
    const failingBulk = overriding({
      getSeriesBulk: () => Promise.reject(new Error("PostgREST read failed")),
    });
    const warned: unknown[][] = [];
    const res = await handle(() => failingBulk, undefined, { env: {}, now: NOW, warn: (...args) => void warned.push(args) });
    expect(res.status, "the endpoint still answers").toBe(200);
    expect(warned.map((c) => String(c[0]))).toEqual(["[status] freshness stamp read failed - serving run-row ages, no pill or feedLag:"]);
    const body = (await res.json()) as StatusResponse;
    expect(body.verdict.date, "the verdict is served").toBe(TODAY);

    // The three pill fields are OMITTED, never `feedsLagging: 0` — a 0 would read "all feeds
    // current", which is precisely what this request failed to measure.
    expect(body.feedsLagging).toBeUndefined();
    expect(body.laggingFeedIds).toBeUndefined();
    expect(body.feedsTotal).toBeUndefined();

    // …and the per-indicator pair falls back to the RUN's row — both fields from that one source
    // (`FreshnessStamp.ageDays`' promise), not a series stale flag beside a run-row age.
    const f1 = body.readings.find((r) => r.indicatorId === "F1");
    const runRow = assessIndicatorFreshness(RUN_ROW_DATE, TODAY, "daily");
    expect(f1?.ageDays).toBe(runRow.ageDays);
    expect(f1?.lag).toBe(runRow.lag);
    // Non-vacuity: this is NOT the series answer the green path serves (0 / false).
    expect(runRow.ageDays).toBeGreaterThan(0);
    expect(runRow.lag).toBe(true);
  });

  // The OTHER half of the asymmetry, and the one nothing pinned. The test above is a decline-only
  // guard: it passes unchanged if BOTH reads degrade. Since the two now run concurrently under one
  // `Promise.all`, hoisting the `.catch` off the freshness promise onto the combined call is a
  // one-character-looking edit that would swallow a readings fault too — serving an empty-but-200
  // dashboard where the endpoint owes a throw. Only this fixture distinguishes the two.
  test("a failed READINGS read still propagates - the catch is NOT on the combined promise", async () => {
    const failingReadings = overriding({
      getReadingsForRun: () => Promise.reject(new Error("readings read failed")),
    });
    await expect(handle(() => failingReadings, undefined, { env: {}, now: NOW })).rejects.toThrow(
      "readings read failed",
    );
  });

  test("an `estimated` served CAPE row reads EST on the F7 card; a FINAL one does not", async () => {
    const estF7 = overriding({ getSeries: async (id, ...rest) => (await store.getSeries(id, ...rest)).map((p) => (id === "F7" && p.date === CAPE_SERVED_DATE ? { ...p, estimated: true } : p)) });
    const est = (await (await handle(() => estF7, undefined, { env: {}, now: NOW })).json()) as StatusResponse;
    const flag = (b: StatusResponse) => b.readings.find((r) => r.indicatorId === "F7")?.estimated;
    expect([flag(est), flag((await (await get()).json()) as StatusResponse)]).toEqual([true, undefined]);
  });

  test("a failed F7 read serves no CAPE card, warned", async () => {
    const failingF7 = overriding({ getSeries: (id, ...rest) => (id === "F7" ? Promise.reject(new Error("F7 read failed")) : store.getSeries(id, ...rest)) });
    const warned: unknown[][] = [];
    const body = (await (await handle(() => failingF7, undefined, { env: {}, now: NOW, freshness: async () => undefined, warn: (...args) => void warned.push(args) })).json()) as StatusResponse;
    expect(body.readings.some((r) => r.indicatorId === "F7")).toBe(false);
    expect(warned.map((c) => String(c[0]))).toEqual(["[status] F7 read failed - serving no CAPE card:"]);
  });
});

// B7 (R7/R9): a newer INTRADAY row overlays the card's value/state/date, flagged `provisional`; the
// verdict (dial/band) stays the EOD run's by construction. Control: the same row written after the cutoff is final.
describe("B7 - /status card overlay from a newer provisional row", () => {
  const eod = (date: string, state: "GREEN" | "RED", value: number): StoredReading => ({
    ...row(date), state, rawState: state, value,
  });
  const seed = async (): Promise<InMemoryStore> => {
    const s = new InMemoryStore();
    await s.recordRun([eod("2026-06-25", "GREEN", 4.2)], "2026-06-25T22:00:00.000Z",
      makeAlert({ firedAt: "2026-06-25T22:00:00.000Z", date: "2026-06-25" }));
    return s;
  };
  // F1 is redacted on the wire: read the full body (`statusBody`) so the overlaid VALUE is there.
  const f1Of = async (s: Store): Promise<StatusResponse> =>
    (await statusBody(() => s, { env: {}, now: NOW }, new WeakSet())) as StatusResponse;

  // No verdict assertion: `verdict` is `getLastAlert()` verbatim, no overlay path reaches it (it could not fail).
  const INTRADAY_AT = "2026-06-26T11:00:00.000Z";
  const EOD_AT = "2026-06-26T22:00:00.000Z";
  test.each([
    {
      name: "intraday row: card serves its value/state, provisional",
      runAt: INTRADAY_AT, estimated: false,
      card: { value: 5.1, state: "RED", rawState: "RED", date: "2026-06-26", provisional: true, estimated: undefined },
    },
    {
      name: "E3: an overlaid `estimated` intraday row carries the marker — the card reads EST",
      runAt: INTRADAY_AT, estimated: true,
      card: { value: 5.1, date: "2026-06-26", provisional: true, estimated: true },
    },
    {
      name: "E2: an EOD `estimated` head newer than the run's row overlays the card as EST, not INTRADAY",
      runAt: EOD_AT, estimated: true,
      card: { value: 5.1, date: "2026-06-26", estimated: true, provisional: undefined },
    },
    {
      name: "control: a final (post-cutoff) newer row is NOT overlaid — the card stays on the verdict run",
      runAt: EOD_AT, estimated: false,
      card: { value: 4.2, state: "GREEN", date: "2026-06-25", provisional: undefined },
    },
  ])("$name", async ({ runAt, estimated, card }) => {
    const s = await seed();
    await s.recordReadings([{ ...eod("2026-06-26", "RED", 5.1), ...(estimated ? { estimated: true } : {}) }], runAt);
    const served = (await f1Of(s)).readings.find((r) => r.indicatorId === "F1")!;
    for (const [k, v] of Object.entries(card)) expect(served[k as keyof typeof served], k).toEqual(v);
  });

  // E22: the tag reaches the wire (when it fires is `lastPrintTag`'s own suite, src/last-print.test.ts).
  test("E22: a weekly id's stored head reaches the card as `lastPrint`, aged to the run's date", async () => {
    const s = new InMemoryStore();
    await s.recordRun([eod("2026-06-25", "GREEN", 4.2), { ...row("2026-06-20"), indicatorId: "F3" }], "2026-06-25T22:00:00.000Z",
      makeAlert({ firedAt: "2026-06-25T22:00:00.000Z", date: "2026-06-25" }));
    const card = (await f1Of(s)).readings.find((r) => r.indicatorId === "F3")!;
    expect(card.lastPrint).toEqual({ date: "2026-06-20", days: 5, cadence: "weekly", reason: "cadence" });
  });
});
