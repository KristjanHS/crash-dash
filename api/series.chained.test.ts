/**
 * GET /api/series over the chained-only display lines (`src/api-routes/series-chained.ts`): `LEGP_VALUE` + the
 * `SB_STRAT`/`SB_BENCH` NAV pair have no registry row, yet `ANCHOR_ROSTER` binds them, so the endpoint serves
 * their stored rows — the input `scripts/probe-series-holes.ts --tail` sweeps over plain HTTP.
 */
import { describe, expect, test } from "vitest";
import { InMemoryStore } from "../src/store-memory.js";
import { makeStoredReading } from "../src/test-helpers.js";
import type { SeriesResponse } from "../src/api/types.js";
import { handle, seriesBody } from "./series.js";

const CHAINED = ["LEGP_VALUE", "SB_STRAT", "SB_BENCH"] as const;
// Mon 2026-02-02 … Thu 2026-02-05: a session on every calendar these ids ride (US for SB_*, Xetra for LEGP_VALUE).
const FINALS = ["2026-02-02", "2026-02-03", "2026-02-04"];
const EST = "2026-02-05";
const RUN_AT = "2026-02-10T00:00:00.000Z"; // past every date's cutoff ⇒ every row FINAL (not provisional)

async function seeded(finals: readonly string[]): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  await store.recordReadings(
    CHAINED.flatMap((id) => [
      ...finals.map((date, i) => makeStoredReading(id, { date, value: 100 + i })),
      makeStoredReading(id, { date: EST, value: 104, estimated: true }),
    ]),
    RUN_AT,
  );
  return store;
}

async function get(store: InMemoryStore, qs: string, unredacted = true): Promise<{ status: number; body: SeriesResponse & { error?: string } }> {
  const req = new Request(`https://x/api/series?${qs}`);
  const opts = { now: new Date("2026-02-06T00:00:00Z") };
  const full = unredacted ? await seriesBody(() => store, req, opts) : undefined;
  const res = full === undefined ? await handle(() => store, req, opts) : full instanceof Response ? full : Response.json(full);
  return { status: res.status, body: (await res.json()) as SeriesResponse & { error?: string } };
}

// The three ids share one code path ⇒ each fact is ONE collecting assert over all three (the Cost section of the testing-project rule).
const serveAll = async (finals: readonly string[], unredacted = true) => {
  const store = await seeded(finals);
  return Promise.all(CHAINED.map(async (id) => ({ id, ...(await get(store, `id=${id}`, unredacted)) })));
};

describe("GET /api/series — chained-only ids (no registry row)", () => {
  test("each id: 200 with its stored rows, value-only, no fold/cut semantics, the estimate slot served", async () => {
    const got = (await serveAll(FINALS)).map(({ id, status, body }) => ({
      id,
      status,
      indicatorId: body.indicatorId,
      points: body.points.map((p) => [p.date, p.value, p.estimated]),
      valueOnly: body.valueOnly,
      confirmCloses: body.confirmCloses,
      oilEst: body.oilEst,
    }));
    expect(got).toEqual(
      CHAINED.map((id) => ({
        id,
        status: 200,
        indicatorId: id,
        points: [...FINALS.map((d, i) => [d, 100 + i, undefined]), [EST, 104, true]],
        valueOnly: true,
        confirmCloses: undefined,
        oilEst: { date: EST, value: 104, fromDate: "2026-02-04" },
      })),
    );
  });

  test("an estimate whose previous session holds no FINAL row is not served", async () => {
    const got = (await serveAll(["2026-02-02", "2026-02-03"])).map(({ id, status, body }) => [id, status, body.points.map((p) => p.date)]);
    expect(got).toEqual(CHAINED.map((id) => [id, 200, ["2026-02-02", "2026-02-03"]]));
  });

  test("redacted (outside the registry ⇒ licensed); dates + estimate flag survive", async () => {
    const got = (await serveAll(FINALS, false)).map(({ id, status, body }) => [id, status, body.redacted, body.points.map((p) => [p.date, p.value, p.estimated])]);
    expect(got).toEqual(CHAINED.map((id) => [id, 200, true, [...FINALS.map((d) => [d, null, undefined]), [EST, null, true]]]));
  });

  test("a range read serves the latest-`limit` in-window rows", async () => {
    const store = await seeded(FINALS);
    await store.recordReadings([makeStoredReading("SB_STRAT", { date: "2026-03-02", value: 105 })], RUN_AT); // past `to`
    const { body } = await get(store, "id=SB_STRAT&from=2026-02-01&to=2026-03-01&limit=2");
    expect(body.points.map((p) => p.date)).toEqual(["2026-02-04", EST]);
  });

  test("any other non-registry id still 400s, and the error names the chained ids", async () => {
    const { status, body } = await get(await seeded(FINALS), "id=SB_NOPE");
    expect(status).toBe(400);
    expect(body.error).toContain("SB_STRAT");
  });
});
