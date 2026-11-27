/**
 * Tests for GET /api/replay (api/replay.ts) — the wiring, not the exposure math (that's
 * src/exposure.test.ts) nor the replay mechanics (src/exposure-replay.test.ts). STORE-ONLY
 * since load-tolerance P1.3: inputs are seeded into an InMemoryStore as raw GREEN-stamped rows
 * (priceLegReadingSeries — the same shape the cron writes) and handed to `handle` with the
 * HY-OAS vintage, a pinned clock and a warn sink — so no module mock is needed and the file runs
 * in the `shared` project. That the handler never fetches upstream is api/no-upstream-fetch.test.ts's
 * job (it walks this handler's transitive import graph). We verify: the whole-payload DTO shape;
 * VINTAGE_HEADERS on every 200; the §6 missing-row rule (an absent input id omits its
 * leg/companion, 200, warned); the redaction, served alike to every request; and, by static scan, that every
 * redactable handler serves through `serveRedactable` and no handler reads a request credential.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";

import { EPISODES } from "../src/exposure-replay.js";
import { InMemoryStore } from "../src/store-memory.js";
import { priceLegReadingSeries } from "../src/pension.js";
import { VINTAGE_HEADERS } from "../src/api/http.js";
import type { Observation } from "../src/domain-types.js";
import type { ExposureReplayResponse, ReplayCompanionResponse } from "../src/api/types.js";
import { handle, type ReplaySeams } from "./replay.js";

// P1 staleness (readInputSeries, INPUT_MAX_STALE_DAYS vs the handler's `now` seam): the clock sits
// BEFORE every fixture date, so no seeded input can read as stale here (a future-dated newest row has
// negative age). Stale behavior itself is unit-tested in src/input-series.test.ts.
const NOW = new Date("2000-01-01T00:00:00Z");

/** Daily observations from `start` for `days` calendar days. */
function daily(start: string, days: number, valueAt: (i: number) => number): Observation[] {
  const t0 = Date.parse(start);
  return Array.from({ length: days }, (_, i) => ({
    date: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10),
    value: valueAt(i),
  }));
}

/** A store seeded the way the cron does (raw GREEN-stamped rows under each id itself). */
async function storeWith(series: Record<string, Observation[]>): Promise<InMemoryStore> {
  const s = new InMemoryStore();
  for (const [id, obs] of Object.entries(series)) {
    await s.recordReadings(priceLegReadingSeries(id, obs), "2026-09-05T21:00:00.000Z");
  }
  return s;
}

/** A warn sink recording every call's args — injected as `warn`, never a console spy (that re-isolates this file). */
function warnSink(): { warn: (...args: unknown[]) => void; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return { warn: (...args) => void calls.push(args), calls };
}

// Base world. Vintage F1 spans 2005-01-01 → 2007-08, so the 2008 episode window (2006-10-31 →
// 2008-11-20) opens covered; the 1998/2002 windows predate it (points stay empty there).
const BASE_DAYS = 950;
const BASE_VINTAGE = daily("2005-01-01", BASE_DAYS, (i) => 3 + (i % 50) * 0.05); // in [3, 5.45]
const BASE_HY = BASE_VINTAGE.slice(-60); // agrees on overlap, no gap → stitch = vintage
const BASE_GSPC = daily("2005-01-01", BASE_DAYS, (i) => 1000 + i); // rising → trend intact
// ACWI deliberately UNSEEDED → FIRE runs off ^GSPC alone (splice-null path).

/** The handler under test with the file's seams bound; `seams` overrides per call. */
const call = (s: InMemoryStore, request?: Request, seams: Partial<ReplaySeams> = {}) =>
  handle(() => s, request, { vintage: () => BASE_VINTAGE, now: NOW, warn: () => {}, ...seams });
const req = (qs: string, token?: string) =>
  new Request(`https://lab.test/api/replay?${qs}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

// The two episode bodies most tests read, computed ONCE off the base world: a plain request, and one
// carrying a bearer token (served exactly alike).
let base: InMemoryStore;
let servedRes: Response;
let served: ExposureReplayResponse;
let bearerRes: Response;
let bearer: ExposureReplayResponse;
beforeAll(async () => {
  base = await storeWith({
    BAMLH0A0HYM2: BASE_HY,
    "^GSPC": BASE_GSPC,
    IEF: daily("2005-01-01", BASE_DAYS, (i) => 90 + (i % 20) * 0.1), // covers 2008 open
  });
  servedRes = await call(base, req(""));
  served = (await servedRes.json()) as ExposureReplayResponse;
  bearerRes = await call(base, req("", "good"));
  bearer = (await bearerRes.json()) as ExposureReplayResponse;
});

describe("GET /api/replay", () => {
  test("returns every episode in one payload with the right shape", () => {
    expect(servedRes.status).toBe(200);
    const body = served;

    expect(typeof body.asOf).toBe("string");
    expect(body.episodes).toHaveLength(EPISODES.length);

    for (const ep of body.episodes) {
      expect(ep).toMatchObject({
        id: expect.any(String),
        label: expect.any(String),
        start: expect.any(String),
        end: expect.any(String),
        candidate: expect.any(Boolean),
        rationale: expect.any(String),
      });
      expect(Array.isArray(ep.points)).toBe(true);
      expect(Array.isArray(ep.notes)).toBe(true);
    }

    // 2008 opens inside the fixture window → non-empty points with the full point shape.
    const y2008 = body.episodes.find((e) => e.id === "2008")!;
    expect(y2008.points.length).toBeGreaterThan(0);
    const p = y2008.points[0]!;
    // The redacted body: raw closes withheld.
    expect(body.redacted).toBe(true);
    expect(p).toMatchObject({
      date: expect.any(String),
      price: null,
      armed: expect.any(Boolean),
      fired: expect.any(Boolean),
      degraded: expect.any(Boolean),
    });
    expect([...(["Full", "Core", "Reduced", "Defensive"] as const), null]).toContain(p.posture);

    // IEF history opens (2005) before the 2008 window → `defensive` present (dates only signed
    // out), and NO bond-rung caveat (coverage from the window's open needs neither the partial nor the absent note).
    expect(y2008.defensive?.length).toBeGreaterThan(0);
    expect(y2008.defensive![0]).toMatchObject({ date: expect.any(String), price: null });
    expect(y2008.notes.some((n) => /bond-rung \(IEF\)/.test(n))).toBe(false);

    // 2002 predates every seeded series → empty points, no defensive line, IEF-absent note.
    const y2002 = body.episodes.find((e) => e.id === "2002")!;
    expect(y2002.points).toHaveLength(0);
    expect(y2002.defensive).toBeUndefined();
    expect(y2002.notes.some((n) => /bond-rung \(IEF\)/.test(n))).toBe(true);

    // …and the payload carries the vintage-cache headers (pure function of the store).
    expect(servedRes.headers.get("Cache-Control")).toBe(VINTAGE_HEADERS["Cache-Control"]);
    expect(servedRes.headers.get("Vercel-Cache-Tag")).toBe(VINTAGE_HEADERS["Vercel-Cache-Tag"]);
  });

  test("IEF opening MID-window → partial defensive line from its first close + inception note (Rung B4)", async () => {
    const s = await storeWith({
      BAMLH0A0HYM2: BASE_HY,
      "^GSPC": BASE_GSPC,
      IEF: daily("2007-06-01", 400, () => 90), // inside 2006-10-31 → 2008-11-20
    });
    const body = (await (await call(s)).json()) as ExposureReplayResponse;
    const y2008 = body.episodes.find((e) => e.id === "2008")!;

    expect(y2008.defensive?.[0]?.date).toBe("2007-06-01");
    expect(y2008.notes.some((n) => n.includes("No bond-rung (IEF) data before 2007-06-01"))).toBe(true);
  });

  test("IEF absent from the store → defensive omitted, 200, VINTAGE_HEADERS, warned (§6)", async () => {
    const s = await storeWith({ BAMLH0A0HYM2: BASE_HY, "^GSPC": BASE_GSPC });
    const { warn, calls } = warnSink();

    const res = await call(s, undefined, { warn });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ExposureReplayResponse;
    const y2008 = body.episodes.find((e) => e.id === "2008")!;
    // The old fetch-failure shape, now store-shaped: NO defensive field, NO IEF note at all.
    expect(y2008.defensive).toBeUndefined();
    expect(y2008.notes.some((n) => /bond-rung \(IEF\)/.test(n))).toBe(false);
    // Missing rows never degrade the cache posture — the cron seeding them purges the tag.
    expect(res.headers.get("Cache-Control")).toBe(VINTAGE_HEADERS["Cache-Control"]);
    expect(res.headers.get("Vercel-Cache-Tag")).toBe(VINTAGE_HEADERS["Vercel-Cache-Tag"]);

    // The missing input reaches the warn seam (once-per-instance is src/input-series.test.ts's fact).
    const iefWarns = calls.filter((c) => String(c[0]).includes("IEF"));
    expect(iefWarns).toHaveLength(1);
    expect(String(iefWarns[0]![0])).toContain("[input-series] IEF missing/stale in the store (replay)");
  });

  test("a deep (>HY_LIVE_TAIL_ROWS-old) FRED revision beyond GROSS_TOLERANCE never 500s: the read is tail-capped (I4)", async () => {
    // Vintage 1996→ (~10k rows); the stored copy agrees EXCEPT on its very first date, where it
    // disagrees grossly (+1.0 > GROSS_TOLERANCE 0.25). Newest-HY_LIVE_TAIL_ROWS excludes that
    // row, so the stitch sees only the fresh tail. Red demo: read BAMLH0A0HYM2 at
    // INPUT_ROW_LIMIT (31*365) in api/replay.ts ⇒ the deep row enters the overlap ⇒ throw.
    const vintage = daily("1996-01-01", 10_000, () => 4);
    const revised = vintage.map((o, i) => (i === 0 ? { ...o, value: o.value + 1 } : o));
    const s = await storeWith({ BAMLH0A0HYM2: revised });
    const res = await call(s, undefined, { vintage: () => vintage });
    expect(res.status).toBe(200);
  });

  test("BAMLH0A0HYM2 absent → every episode serves empty points, 200 with VINTAGE_HEADERS, never a 500 (§6)", async () => {
    const s = await storeWith({ "^GSPC": BASE_GSPC, IEF: daily("2005-01-01", BASE_DAYS, () => 90) });
    const res = await call(s);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ExposureReplayResponse;
    for (const ep of body.episodes) expect(ep.points).toHaveLength(0);
    // No feed, no feed-error note — the omission IS the shape; headers stay cacheable.
    expect(res.headers.get("Cache-Control")).toBe(VINTAGE_HEADERS["Cache-Control"]);
  });

  test("vintage file absent → the same degrade: every episode serves empty points, 200, never a 500", async () => {
    const s = await storeWith({ BAMLH0A0HYM2: BASE_HY, "^GSPC": BASE_GSPC, IEF: daily("2005-01-01", BASE_DAYS, () => 90) });
    const res = await call(s, undefined, { vintage: () => undefined });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ExposureReplayResponse;
    expect(body.episodes.length).toBeGreaterThan(0);
    for (const ep of body.episodes) expect(ep.points).toHaveLength(0);
  });
});

describe("GET /api/replay?companion= (Rung E3)", () => {
  test("serves a stored FRED companion sliced to from/to, vintage-cached", async () => {
    const s = await storeWith({ T10Y2Y: daily("2000-01-01", 1200, (i) => 1 + (i % 10) / 10) });
    const res = await call(s, req("companion=T10Y2Y&from=2002-03-01&to=2002-03-10"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReplayCompanionResponse;

    expect(body.indicatorId).toBe("T10Y2Y");
    // server-side slice: inclusive from/to, one point per fixture calendar day
    expect(body.points).toHaveLength(10);
    expect(body.points[0]).toMatchObject({ date: "2002-03-01", value: expect.any(Number) });
    expect(body.points.at(-1)!.date).toBe("2002-03-10");
    expect(res.headers.get("Cache-Control")).toBe(VINTAGE_HEADERS["Cache-Control"]);
  });

  test("dispatches by id - T10Y2Y and DCOILWTICO each serve their own series + unit", async () => {
    const s = await storeWith({ T10Y2Y: daily("2000-01-01", 5, () => 1.2), DCOILWTICO: daily("2000-01-01", 5, () => 25) });
    const curve = (await (await call(s, req("companion=T10Y2Y"))).json()) as ReplayCompanionResponse;
    const oil = (await (await call(s, req("companion=DCOILWTICO"))).json()) as ReplayCompanionResponse;

    expect(curve.points[0]!.value).toBe(1.2);
    expect(curve.unit).toBe("%");
    expect(oil.points[0]!.value).toBe(25);
    expect(oil.unit).toBe("$");
  });

  test("^IXIC (price-feed id) dispatches off its stored rows — served redacted", async () => {
    const s = await storeWith({ "^IXIC": daily("2001-01-01", 30, (i) => 2000 - i) });
    const res = await call(s, req("companion=%5EIXIC", "good"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReplayCompanionResponse;

    expect(body.indicatorId).toBe("^IXIC");
    expect([body.redacted, body.points]).toEqual([true, []]);
  });

  test("unknown companion id or malformed from/to → 400", async () => {
    const s = await storeWith({ VIXCLS: daily("2000-01-01", 5, () => 15) });
    expect((await call(s, req("companion=NOPE"))).status).toBe(400);
    expect((await call(s, req("companion=VIXCLS&from=03-01-2002"))).status).toBe(400);
    expect((await call(s, req("companion=VIXCLS&to=2002-3-1"))).status).toBe(400);
  });

  test("a companion with NO stored rows → 200 empty points, VINTAGE_HEADERS (§6 missing-row rule)", async () => {
    // T10Y2Y is deliberately unseeded here.
    const res = await call(new InMemoryStore(), req("companion=T10Y2Y"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as ReplayCompanionResponse).points).toEqual([]);
    // A missing input is NOT a degraded feed day: the response stays a pure function of the
    // vintage (the cron seeding the rows purges the tag), so no `no-store` anywhere.
    expect(res.headers.get("Cache-Control")).toBe(VINTAGE_HEADERS["Cache-Control"]);
  });

  test("an unrecognised query param is a 400 no-store; companion= still routes (S-1)", async () => {
    const s = await storeWith({ VIXCLS: daily("2000-01-01", 3, () => 20) });
    expect((await call(s, req("companion=VIXCLS&cb=1"))).status).toBe(400);
    const rej = await call(s, req("cb=1"));
    expect(rej.status).toBe(400);
    expect(rej.headers.get("Cache-Control")).toBe("no-store");
    expect((await call(s, req("companion=VIXCLS"))).status).toBe(200);
  });
});

describe("GET /api/replay — redaction, alike for every request", () => {
  test("every raw close is null, redacted:true, vintage-cached — and a bearer request gets the identical body + policy", () => {
    expect(served.redacted).toBe(true);
    const prices = served.episodes.flatMap((e) => [...e.points, ...(e.defensive ?? [])].map((p) => p.price));
    expect(prices.length, "non-empty, so the null filter below can bite").toBeGreaterThan(0);
    expect(prices.filter((v) => v !== null)).toEqual([]);
    expect(servedRes.headers.get("Cache-Control")).toBe(VINTAGE_HEADERS["Cache-Control"]);
    expect(bearer).toEqual(served);
    expect(bearerRes.headers.get("Cache-Control")).toBe(servedRes.headers.get("Cache-Control"));
  });

  test("`auth` is an unknown param ⇒ 400", async () => {
    expect((await call(base, req("auth=1"))).status).toBe(400);
  });

  test("restricted companions (VIXCLS, ^IXIC), with or without a bearer: redacted, no points, vintage-cached", async () => {
    const s = await storeWith({ VIXCLS: daily("2000-01-01", 5, () => 15), "^IXIC": daily("2000-01-01", 5, () => 2000) });
    for (const id of ["VIXCLS", "^IXIC"]) {
      const qs = `companion=${encodeURIComponent(id)}`;
      for (const out of [await call(s, req(qs)), await call(s, req(qs, "good"))]) {
        const body = (await out.json()) as ReplayCompanionResponse;
        expect(body, id).toEqual({ indicatorId: id, label: expect.any(String), unit: expect.any(String), points: [], redacted: true });
        expect(out.headers.get("Cache-Control"), id).toBe(VINTAGE_HEADERS["Cache-Control"]);
      }
    }
  });

  test("other companions (T10Y2Y, DCOILWTICO) unchanged: values served, vintage-cached", async () => {
    const s = await storeWith({ T10Y2Y: daily("2000-01-01", 5, () => 1.2), DCOILWTICO: daily("2000-01-01", 5, () => 25) });
    for (const id of ["T10Y2Y", "DCOILWTICO"]) {
      const res = await call(s, req(`companion=${id}`, "good"));
      const body = (await res.json()) as ReplayCompanionResponse;
      expect(body.redacted, id).toBeUndefined();
      expect(body.points, id).toHaveLength(5);
      expect(res.headers.get("Cache-Control"), id).toBe(VINTAGE_HEADERS["Cache-Control"]);
    }
  });
});

// Static scan (no module mock — a mocked store module would re-isolate this file): every read handler
// with redactable fields serves through `serveRedactable`, and no live handler reads a request credential, so
// every request is served the same body. The roster is explicit: a new redactable handler appends one entry.
describe("every redactable read serves through serveRedactable, credential-blind (static scan)", () => {
  const ROSTER = ["api/exposure.ts", "api/indicators.ts", "api/lab.ts", "api/replay.ts", "api/series.ts", "api/status.ts", "src/api/meta-views.ts"];
  const REPO = fileURLToPath(new URL("..", import.meta.url));
  /** Code text with block comments and `//`-opened lines removed (prose naming a symbol never counts). */
  const codeOf = (rel: string): string =>
    readFileSync(join(REPO, rel), "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//")) // first: a `//` line naming `api/*` must not open a block
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
  const liveTs = (dir: string): string[] =>
    (readdirSync(join(REPO, dir), { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.includes("test-helpers"))
      .map((f) => `${dir}/${f}`);
  // `src/api/http.ts` defines both seams — its own definitions are not handler calls.
  const live = [...liveTs("api"), ...liveTs("src/api"), ...liveTs("src/api-routes")].filter((f) => f !== "src/api/http.ts");
  const calling = (re: RegExp): string[] => live.filter((f) => re.test(codeOf(f)));

  test("the roster is exactly the live files serving through serveRedactable", () => {
    expect(live, "a broken walker must not pass empty").toEqual(expect.arrayContaining(ROSTER));
    expect(live.some((f) => f.startsWith("src/api-routes/")), "the handler-logic dir is walked").toBe(true);
    expect(calling(/\bserveRedactable\(/).sort()).toEqual([...ROSTER].sort());
  });

  // `authorization` is the bearer header; `"auth"` the old cache-key param. Both absent from live handler code
  // (comments excluded) ⇒ no request header or param can change what a read serves.
  test("no live handler file reads the authorization header or an `auth` param", () => {
    expect(calling(/\bauthorization\b|["']auth["']/)).toEqual([]);
  });
});
