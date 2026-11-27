/**
 * Per-point `provisional` on /api/series (B1): a point `isProvisional` (src/intraday.ts) carries
 * `provisional: true`; a final point omits the key; store-only `runAt` never reaches the wire.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { InMemoryStore } from "../src/store-memory.js";
import { provisionalBefore } from "../src/intraday.js";
import { makeStoredReading } from "../src/test-helpers.js";
import type { SeriesResponse } from "../src/api/types.js";
import { OAS_NOWCAST_LEGS } from "../src/hyoas-nowcast.js";
import { estimatorOf } from "../src/nowcast-score.js";
import { priceLegReadingSeries } from "../src/pension.js";
import { resetVintageMemo } from "../src/api/vintage-memo.js";

import { handle, seriesBody } from "./series.js";

let store = new InMemoryStore();
const GET = (req: Request, now?: Date): Promise<Response> => handle(() => store, req, { now: now ?? new Date() });

const DATES = ["2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29"];
const serve = async (): Promise<SeriesResponse> =>
  (await (await GET(new Request("https://x/api/series?id=EXSH_GATE"))).json()) as SeriesResponse;

async function seed(runAt: string): Promise<void> {
  store = new InMemoryStore();
  await store.recordReadings(DATES.map((date) => makeStoredReading("EXSH_GATE", { date })), runAt);
}

describe("/api/series per-point provisional flag", () => {
  test("run before the newest date's cutoff ⇒ only that point is provisional", async () => {
    await seed("2026-09-29T10:05:00.000Z");
    const body = await serve();
    expect(body.points.at(-1)).toMatchObject({ date: "2026-09-29", provisional: true });
    // Not a nowcast-scored id ⇒ a provisional point is an intraday CLOSE, never `estimated` (Defect 2).
    expect(body.points.at(-1)).not.toHaveProperty("estimated");
    for (const p of body.points.slice(0, -1)) expect(p).not.toHaveProperty("provisional");
  });

  test("EOD run (after the cutoff) ⇒ no point carries the key", async () => {
    await seed("2026-09-29T22:00:00.000Z");
    const body = await serve();
    expect(body.points.length).toBe(DATES.length);
    for (const p of body.points) expect(p).not.toHaveProperty("provisional");
  });
});

describe("retired `?leg=1` leg-close path (etf-dedup step 5)", () => {
  test("`estimateAnchored` on the plain path: a US id's (F1) estimate chained onto an estimate is never served; an EU leg's all are", async () => {
    store = new InMemoryStore();
    const dates = ["2026-09-30", "2026-10-01", "2026-10-02"];
    for (const id of ["F1", "LEGP_EUFIN"])
      await store.recordReadings(dates.map((date, i) => makeStoredReading(id, { date, value: 50 + i, ...(i > 0 ? { estimated: true } : {}) })), "2026-10-02T22:00:00Z");
    // R7: LEGP_* is redacted on the wire — read the full body before the response rule.
    const body_ = async (id: string): Promise<SeriesResponse> =>
      (await seriesBody(() => store, new Request(`https://x/api/series?id=${id}`), { now: new Date() })) as SeriesResponse;
    const f1 = await body_("F1");
    expect(f1.points.map((p) => p.date)).toEqual(dates.slice(0, 2));
    // `oilEst` is read off the FILTERED points: the anchored estimate, never the chained newest row.
    expect(f1.oilEst).toEqual({ date: dates[1], value: 51, fromDate: dates[0] });
    expect((await body_("LEGP_EUFIN")).points.map((p) => p.date)).toEqual(dates);
  });
});

describe("detail=1 rebuilt-point branches keep the flag (I1)", () => {
  // F11 = recompute branch, F9 = recompute + σ overlay, DB_SMH = downside branch (detail-independent).
  const cases = [["F11", "&detail=1"], ["F9", "&detail=1"], ["DB_SMH", ""]] as const;
  const get = async (id: string, q: string): Promise<SeriesResponse> =>
    (await (await GET(new Request(`https://x/api/series?id=${id}${q}`))).json()) as SeriesResponse;

  // Deep enough for the 63d drawdown high and F9's σ depth; varying closes so every scorer emits.
  const days = Array.from({ length: 400 }, (_, i) => new Date(Date.UTC(2026, 8, 29) - i * 86_400_000))
    .filter((d) => d.getUTCDay() % 6 !== 0)
    .map((d) => d.toISOString().slice(0, 10))
    .reverse();
  test.each(cases)("%s%s: provisional newest ⇒ flagged; EOD ⇒ not", async (id, q) => {
    for (const [runAt, flagged] of [["2026-09-29T10:05:00.000Z", true], [provisionalBefore("2026-09-29", id), false]] as const) {
      store = new InMemoryStore();
      await store.recordReadings(days.map((date, i) => makeStoredReading(id, { date, value: 100 + (i % 7) })), runAt);
      const body = await get(id, q);
      expect(body.points.at(-1)?.date).toBe("2026-09-29");
      expect(body.points.at(-1)?.provisional).toBe(flagged ? true : undefined);
      for (const p of body.points) expect(p).not.toHaveProperty("runAt");
    }
  });
});

// Nowcast anchor hole: on a nowcast-scored id the intraday row IS the stored
// same-day estimate (L2). `estimateSlot`: the read path no longer recomputes —
// `oilEst` IS that stored row, anchored (`fromDate`) on the newest FINAL print, never on the estimate itself.
describe("nowcast-scored id: provisional newest row is the ESTIMATE, not a print (Defect 2)", () => {
  const FINAL = ["2026-09-28", "2026-09-29"]; // FRED prints, written by the EOD runs
  const TODAY = "2026-09-30"; // the intraday run's provisional estimate row
  const EOD = "2026-09-29T22:00:00.000Z";
  const INTRADAY = "2026-09-30T10:05:00.000Z";
  const EOD_EST = "2026-09-30T22:00:00.000Z"; // TODAY's EOD run (post-cutoff) writing the E8 estimate row
  // Moving closes on every day incl. TODAY ⇒ the estimator fires and moves off the print.
  const price = [{ date: FINAL[0]!, value: 80 }, { date: FINAL[1]!, value: 79.6 }, { date: TODAY, value: 79.1 }];
  const hedge = [{ date: FINAL[0]!, value: 95 }, { date: FINAL[1]!, value: 95.1 }, { date: TODAY, value: 95.4 }];
  const printObs = [{ date: FINAL[0]!, value: 4.0 }, { date: FINAL[1]!, value: 4.1 }];
  const EST_ROW = 4.3; // the stored estimate's own value — never an anchor

  // P1 staleness (readInputSeries vs `new Date()`): pin the clock to the fixture's day.
  const NOW = new Date(`${TODAY}T12:00:00Z`);
  beforeEach(() => resetVintageMemo());

  // `estimated` = the E3 stored marker the run writes on a nowcast-scored id; `estRunAt` = EOD_EST seeds the EOD case.
  async function seedNowcast(id: string, legs: Record<string, { date: string; value: number }[]>, estimated = true, estRunAt = INTRADAY): Promise<void> {
    store = new InMemoryStore();
    await store.recordReadings(printObs.map((o) => makeStoredReading(id, o)), EOD);
    await store.recordReadings([makeStoredReading(id, { date: TODAY, value: EST_ROW, estimated })], estRunAt);
    for (const [leg, obs] of Object.entries(legs)) await store.recordReadings(priceLegReadingSeries(leg, obs), INTRADAY);
  }
  // The full body: G1's estimate rows are redacted on the wire (api/series.redact.test.ts).
  const get = async (id: string): Promise<SeriesResponse> =>
    (await seriesBody(() => store, new Request(`https://x/api/series?id=${id}`), { now: NOW })) as SeriesResponse;

  // the slot IS the stored estimate row (value EST_ROW), anchored on the newest FINAL print — never a recompute.
  test("G1: oilEst serves the provisional `estimated` row, fromDate = the newest FINAL print", async () => {
    await seedNowcast("G1", { [estimatorOf("G1", "carry-log").leads[0]]: price });
    const body = await get("G1");
    expect(body.oilEst).toEqual({ date: TODAY, value: EST_ROW, fromDate: FINAL[1], provisional: true });
    expect(body.points.at(-1)).toMatchObject({ date: TODAY, provisional: true, estimated: true });
  });

  // E8: the EOD run writes the G1 estimate too — a final-cutoff `estimated` row is still no print and still `estimated`.
  test("G1 EOD: a non-provisional `estimated` newest row is served as oilEst, wire `estimated`, no `provisional`", async () => {
    await seedNowcast("G1", { [estimatorOf("G1", "carry-log").leads[0]]: price }, true, EOD_EST);
    const body = await get("G1");
    expect(body.oilEst).toEqual({ date: TODAY, value: EST_ROW, fromDate: FINAL[1] });
    expect(body.points.at(-1)).toMatchObject({ date: TODAY, estimated: true });
    expect(body.points.at(-1)).not.toHaveProperty("provisional");
  });

  test("F2 (no stored marker) keeps its provisional point un-`estimated`", async () => {
    const legs = OAS_NOWCAST_LEGS.F2;
    await seedNowcast("F2", { [legs.price]: price, [legs.hedge]: hedge }, false);
    const body = await get("F2");
    expect(body.points.at(-1)).toMatchObject({ date: TODAY, provisional: true });
    expect(body.points.at(-1)).not.toHaveProperty("estimated");
  });
});
