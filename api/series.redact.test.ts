/**
 * R7: an id on the redaction roster is served state-only to every request,
 * whatever headers it carries; any other id is untouched. No Supabase and no module mock (shared lane).
 */
import { describe, expect, test } from "vitest";
import { InMemoryStore } from "../src/store-memory.js";
import { makeStoredReading } from "../src/test-helpers.js";
import { LADDER } from "../src/families.js";
import { legCloseId } from "../src/scoreboard.js";
import { META } from "../src/api/http.js";
import type { SeriesResponse } from "../src/api/types.js";
import { handle, redactEstimates, redactSeries } from "./series.js";

const VINTAGE = "s-maxage=86400, stale-while-revalidate=86400";
const TOP_LEVEL = ["indicatorId", "label", "longLabel", "unit", "points", "confirmCloses", "valueOnly", "proxy", "redacted"];

// Any finite number anywhere in a point (nested objects included) is a leaked level.
const leaksNumber = (v: unknown): boolean =>
  typeof v === "number" ? Number.isFinite(v) : v !== null && typeof v === "object" && Object.values(v).some(leaksNumber);

describe("GET /api/series — R7 licensed redaction", () => {
  const store = new InMemoryStore();
  // A registered LEGP_* leg (a PENSION row since etf-dedup step 1; `?leg=1` retired in step 5): licensed.
  const LEGP = LADDER.map(legCloseId).find((id) => META.has(id))!;
  for (const id of ["F1", "SPY", "KBE_RS", "VXSMH", LEGP]) {
    store.recordReadings(
      Array.from({ length: 30 }, (_, i) =>
        makeStoredReading(id, {
          date: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
          value: 3.5 + i,
          delta20: 0.25,
        }),
      ),
      "2026-02-01T00:00:00Z",
    );
  }

  async function get(qs: string, auth?: { token: string }) {
    const req = new Request(`https://x/api/series?${qs}`, auth ? { headers: { authorization: `Bearer ${auth.token}` } } : {});
    const res = await handle(() => store, req, { now: new Date() });
    return { res, body: res.status === 200 ? ((await res.json()) as SeriesResponse) : undefined };
  }

  test("licensed (F1, SPY): redacted, no finite number in any point, whitelisted top level, vintage-cached", async () => {
    for (const id of ["F1", "SPY"]) {
      const { res, body } = await get(`id=${id}&detail=1`);
      expect(res.headers.get("Cache-Control"), id).toBe(VINTAGE);
      expect(body!.redacted, id).toBe(true);
      expect(body!.points.length, `${id}: non-empty, so the leak filter below can bite`).toBeGreaterThan(0);
      expect(body!.points.filter(leaksNumber), id).toEqual([]);
      expect(Object.keys(body!).filter((k) => !TOP_LEVEL.includes(k)), id).toEqual([]);
    }
  });

  test("a request carrying a bearer token gets the same body and cache policy as a plain one", async () => {
    for (const id of ["F1", "SPY", LEGP]) {
      const plain = await get(`id=${id}&detail=1`);
      const bearer = await get(`id=${id}&detail=1`, { token: "good" });
      expect(bearer.res.headers.get("Cache-Control"), id).toBe(plain.res.headers.get("Cache-Control"));
      expect(bearer.body!.redacted, id).toBe(true);
      expect(bearer.body, id).toEqual(plain.body);
    }
  });

  test("an id off the roster (KBE_RS): unchanged body + vintage cache", async () => {
    const { res, body } = await get("id=KBE_RS", { token: "good" });
    expect(res.headers.get("Cache-Control")).toBe(VINTAGE);
    expect(body!.redacted).toBeUndefined();
    expect(body!.points.at(-1)?.value).toBe(3.5 + 29);
  });

  test("VXSMH (licensed, cut-less chart-only): redacted with valueOnly, so the ribbon dims instead of painting GREEN", async () => {
    expect((await get("id=VXSMH")).body!).toMatchObject({ redacted: true, valueOnly: true });
  });

  test("LEGP_* leg on the ordinary PENSION path (on the roster): redacted, the proxy join kept", async () => {
    const out = await get(`id=${LEGP}`);
    expect(out.body!).toMatchObject({ redacted: true, valueOnly: true, unit: "€", proxy: { source: "SMH", until: "2021-08-06" } });
    expect(out.body!.points.filter(leaksNumber)).toEqual([]);
  });

  test("`auth` is an unknown param: 400 no-store, whatever its value", async () => {
    for (const v of ["1", "true"]) {
      const { res } = await get(`id=F1&auth=${v}`);
      expect(res.status, v).toBe(400);
      expect(res.headers.get("Cache-Control"), v).toBe("no-store");
    }
  });
});

// An unlicensed id whose estimate rows carry ONE licensed lead (G1 ← CL=F, BRENT ← BZ=F, R2/R3 ← a sovereign-quote yield):
// its prints stay public, its `estimated` rows and the `oilEst` slot are redacted in the served body.
describe("GET /api/series — estimate rows carried over a licensed lead", () => {
  const store = new InMemoryStore();
  // 20 weekday prints (2026-03-02..03-27) + the next session's estimate, so `estimateAnchored` keeps it.
  const weekdays = Array.from({ length: 28 }, (_, i) => new Date(Date.UTC(2026, 2, 2) + i * 86_400_000))
    .filter((d) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
    .map((d) => d.toISOString().slice(0, 10));
  const EST_DATE = "2026-03-30";
  for (const id of ["G1", "R1"]) {
    store.recordReadings(
      [
        ...weekdays.map((date, i) => makeStoredReading(id, { date, value: 70 + i, delta20: 1 })),
        makeStoredReading(id, { date: EST_DATE, value: 99.5, delta20: 2.5, estimated: true }),
      ],
      "2026-03-31T00:00:00Z",
    );
  }

  async function get(qs: string, bearer = false) {
    const req = new Request(`https://x/api/series?${qs}`, bearer ? { headers: { authorization: "Bearer t" } } : {});
    const res = await handle(() => store, req, { now: new Date("2026-03-31T12:00:00Z") });
    return { res, body: (await res.json()) as SeriesResponse };
  }

  test("G1, with or without a bearer: the estimate point is redacted and the oilEst slot dropped; prints keep their values", async () => {
    const { res, body } = await get("id=G1");
    expect(await get("id=G1", true).then((b) => b.body)).toEqual(body);
    expect(res.headers.get("Cache-Control")).toBe(VINTAGE);
    expect(body.redacted).toBeUndefined();
    const est = body.points.find((p) => p.date === EST_DATE)!;
    expect(est).toMatchObject({ value: null, delta20: null, estimated: true, state: "GREEN" });
    expect(leaksNumber(est)).toBe(false);
    expect(body.oilEst).toBeUndefined();
    expect(body.points.find((p) => p.date === "2026-03-27")?.value).toBe(70 + weekdays.length - 1);
  });

  test("two roster leads (R1: 10y and 3m) stay derived: the estimate is served as-is", async () => {
    const { res, body } = await get("id=R1", true);
    expect(res.headers.get("Cache-Control")).toBe(VINTAGE);
    expect(body.points.find((p) => p.date === EST_DATE)?.value).toBe(99.5);
  });
});

describe("redactEstimates — only the estimate rows and their slot", () => {
  test("an estimated point keeps only the whitelist; a print and every other top-level field pass as-is", () => {
    const full = {
      indicatorId: "G1",
      label: "WTI",
      unit: "$",
      points: [
        { date: "2026-01-01", value: 70, delta20: 1, rawState: "GREEN", state: "GREEN" },
        { date: "2026-01-02", value: 71, delta20: 2, rawState: "AMBER", state: "GREEN", decision: 71, cusum: 3, estimated: true, provisional: true },
      ],
      effAmber: 4,
      oilEst: { date: "2026-01-02", value: 71, fromDate: "2026-01-01" },
      confirmCloses: 2,
    } as unknown as SeriesResponse;
    expect(redactEstimates(full)).toEqual({
      indicatorId: "G1",
      label: "WTI",
      unit: "$",
      points: [
        { date: "2026-01-01", value: 70, delta20: 1, rawState: "GREEN", state: "GREEN" },
        { date: "2026-01-02", value: null, delta20: null, rawState: "AMBER", state: "GREEN", provisional: true, estimated: true },
      ],
      effAmber: 4,
      confirmCloses: 2,
    });
  });
});

describe("redactSeries — a whitelist, so an unlisted field never leaks", () => {
  test("drops level-bearing point + top-level fields it does not name", () => {
    const full = {
      indicatorId: "F1",
      label: "HY OAS",
      unit: "%",
      points: [
        { date: "2026-01-01", value: 4.2, delta20: 0.3, rawState: "RED", state: "AMBER", decision: 4.2, bandCuts: { a: 1 }, cusum: 2, leg: "op", gates: { belowMA200: true } },
      ],
      effAmber: 4,
      effRed: 5,
      legBounds: { op: { amber: 4, red: 5 } },
      oilEst: { date: "2026-01-01", value: 4.2, fromDate: "2025-12-31" },
      confirmCloses: 2,
    } as unknown as SeriesResponse;
    expect(redactSeries(full)).toEqual({
      indicatorId: "F1",
      label: "HY OAS",
      unit: "%",
      points: [{ date: "2026-01-01", value: null, delta20: null, rawState: "RED", state: "AMBER", leg: "op", gates: { belowMA200: true } }],
      confirmCloses: 2,
      redacted: true,
    });
  });
});
