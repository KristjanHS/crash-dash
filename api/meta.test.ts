/**
 * Tests for GET /api/meta (api/meta.ts) — the consolidated router that folds the thin
 * health / history / families / danger-model / config handlers behind one Vercel function
 * (audit rank 14). config.test.ts / families.test.ts / danger-model.test.ts own the view bodies; THIS suite
 * proves the router dispatches `?view=` to the SAME body byte-for-byte (so the vercel.json
 * rewrites reach identical responses at the unchanged public URLs), plus the 400 default.
 */
import { beforeAll, describe, expect, test } from "vitest";

import { InMemoryStore } from "../src/store-memory.js";
import { POSTGREST_MAX_ROWS, type AlertRecord, type Store } from "../src/store.js";
import { makeAlert } from "../src/test-helpers.js";
import { cronBearerOk } from "../src/config.js";
import { handle } from "./meta.js";
import {
  healthView,
  historyView,
  familiesView,
  dangerModelView,
  configView,
} from "../src/api/meta-views.js";

// health + history hit the store; families/danger-model/config are pure. Hand the router a
// pre-seeded InMemoryStore through the injected seam (rung 8a) — no module mock, so this
// suite runs in the `shared` project.
const store = new InMemoryStore();
const storeOf = () => store;

const SECRET = "test-cron-secret";
const healthReq = (auth?: string) =>
  new Request("https://x/api/meta?view=health", auth == null ? {} : { headers: { authorization: auth } });

const route = (view: string, qs = "") =>
  handle(storeOf, new Request(`https://x/api/meta?view=${view}${qs}`, { method: "GET" }), { env: {} });

async function shape(res: Response): Promise<{ status: number; cache: string | null; body: unknown }> {
  return { status: res.status, cache: res.headers.get("Cache-Control"), body: await res.json() };
}

describe("GET /api/meta router", () => {
  test.each([
    ["health", () => healthView(storeOf, undefined, undefined)],
    ["families", () => familiesView()],
    ["danger-model", () => dangerModelView()],
    ["config", () => configView()],
  ] as const)("?view=%s dispatches to the same body + cache as the direct view", async (view, direct) => {
    const viaRouter = await shape(await route(view));
    const viaDirect = await shape(await direct());
    expect(viaRouter).toEqual(viaDirect);
  });

  test("?view=history dispatches to historyView (same body) and passes ?limit through", async () => {
    const viaRouter = await shape(await route("history", "&limit=25"));
    const viaDirect = await shape(await historyView(new Request("https://x/api/history?limit=25"), storeOf));
    expect(viaRouter).toEqual(viaDirect);
  });

  test("an unknown / missing view is a 400 (never a silent wrong-view answer)", async () => {
    expect((await route("nope")).status).toBe(400);
    expect((await handle(storeOf, new Request("https://x/api/meta"), { env: {} })).status).toBe(400);
  });

  test("an unrecognised query param is a 400 no-store (?cb= cannot mint an edge key)", async () => {
    // S-1: reject BEFORE dispatch, so `?cb=` no longer routes a MISS with a view body behind it.
    const res = await handle(storeOf, new Request("https://x/api/meta?view=health&cb=1"), { env: {} });
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // A store that refuses to construct/read (which is how missing store creds arrive)
  // surfaces as a 503 carrying the thrown message, not as a degraded 200 — on BOTH health paths.
  test.each([
    ["cheap (no bearer)", "getLastAlert", undefined],
    ["deep (right bearer)", "checkSchema", `Bearer ${SECRET}`],
  ] as const)("%s: a store failure in %s becomes a 503 carrying the error message", async (_, method, auth) => {
    const boom = new InMemoryStore();
    boom[method] = async () => {
      throw new Error("[store] some read-path failure");
    };
    const res = await handle(() => boom, healthReq(auth), { env: { CRON_SECRET: SECRET } });
    expect(res.status).toBe(503);
    expect((await res.json()) as { ok: boolean; error: string }).toMatchObject({
      ok: false,
      error: "[store] some read-path failure",
    });
  });
});

// D3 (perf top-5 P5): public /api/health is ONE cheap read; the deep probe needs the cron bearer.
// A Proxy (not a vitest spy — that would re-isolate this file) logs every store method the view calls.
describe("GET /api/health store calls per hit (D3)", () => {
  function countingStore(): { storeOf: () => Store; calls: string[] } {
    const inner = new InMemoryStore();
    const calls: string[] = [];
    const proxy = new Proxy(inner, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r) as unknown;
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => (calls.push(String(p)), (v as (...a: unknown[]) => unknown).apply(t, args));
      },
    });
    return { storeOf: () => proxy, calls };
  }
  const hit = async (auth: string | undefined, cronSecret = SECRET) => {
    const { storeOf: s, calls } = countingStore();
    const res = await handle(s, healthReq(auth), { env: { CRON_SECRET: cronSecret } });
    return { status: res.status, cache: res.headers.get("Cache-Control"), body: await res.json(), calls };
  };

  test("no bearer → exactly ONE store call and a bare {ok:true}", async () => {
    expect(await hit(undefined)).toEqual({ status: 200, cache: "no-store", body: { ok: true }, calls: ["getLastAlert"] });
  });

  test("right bearer → the deep probe (checkSchema + maxRowsProbe) and its drift fields", async () => {
    const r = await hit(`Bearer ${SECRET}`);
    expect(r.calls).toEqual(expect.arrayContaining(["checkSchema", "maxRowsProbe"]));
    expect(r.body).toMatchObject({ ok: true, maxRows: POSTGREST_MAX_ROWS, maxRowsObserved: null });
    expect(r.cache).toBe("no-store");
  });

  test("wrong bearer → the cheap body (200, never a 401), one store call", async () => {
    expect(await hit("Bearer nope")).toEqual({ status: 200, cache: "no-store", body: { ok: true }, calls: ["getLastAlert"] });
  });

  // Unset CRON_SECRET must not turn the literal `Bearer undefined` into a deep-probe key.
  test("cronBearerOk: an unset secret never matches", () => {
    expect(cronBearerOk(healthReq("Bearer undefined"), undefined)).toBe(false);
  });
});

// Licensed-level gate: each row's VIXCLS/VXVCLS level is withheld from every body.
describe("GET /api/history - vix/vix3m withheld from every body", () => {
  const hist = new InMemoryStore();
  const histOf = () => hist;
  const histReq = (qs = "", token?: string) =>
    new Request(`https://x/api/history${qs}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  beforeAll(() => hist.recordAlert(makeAlert({ vix: 18.5, vix3m: 20.1, ratio: 0.92, fallVelocity: -0.4 })));

  test("served with or without a bearer, through the router too: vix/vix3m null, ratio kept, vintage-cached", async () => {
    for (const res of [
      await historyView(histReq(), histOf),
      await historyView(histReq("", "good"), histOf),
      await handle(histOf, new Request("https://x/api/meta?view=history", { headers: { authorization: "Bearer good" } }), { env: {} }),
    ]) {
      expect(res.headers.get("Cache-Control")).toBe("s-maxage=86400, stale-while-revalidate=86400");
      expect(((await res.json()) as AlertRecord[])[0]).toMatchObject({ vix: null, vix3m: null, fallVelocity: null, ratio: 0.92 });
    }
  });

  test("`auth` is an unknown param on history and on the paramless views (⇒ 400)", async () => {
    for (const view of ["history", "config"]) {
      expect((await handle(histOf, new Request(`https://x/api/meta?view=${view}&auth=1`), { env: {} })).status, view).toBe(400);
    }
  });
});

// Redaction seam: the raw body is the seeded rows verbatim, the served body the same rows with the withheld
// fields nulled; both expected bodies are built from the seeded fixture, independent of the handler.
describe("GET /api/history - raw rows vs served body", () => {
  const hist = new InMemoryStore();
  const ALERTS = [
    makeAlert({ vix: 18.5, vix3m: 20.1, ratio: 0.92, fallVelocity: -0.4 }),
    makeAlert({ date: "2026-06-26", firedAt: "2026-06-26T21:00:00.000Z", vix: 22, vix3m: 21, ratio: 1.05, fallVelocity: -1.2 }),
  ];
  const at = (req: Request) => historyView(req, () => hist);
  let raw: AlertRecord[], redacted: AlertRecord[];
  beforeAll(async () => {
    for (const a of ALERTS) await hist.recordAlert(a);
    // `raw` = the rows the handler reads (the store's narrow history read); `redacted` = what it serves.
    [raw, redacted] = (await Promise.all([
      hist.getRecentAlerts(100),
      at(new Request("https://x/api/history")).then((r) => r.json()),
    ])) as [AlertRecord[], AlertRecord[]];
  });

  test("the served body nulls only vix/vix3m/fallVelocity, row for row", () => {
    // The narrow history read drops the panel blob; newest first.
    const seeded = ALERTS.map(({ panelState: _p, ...a }) => a).reverse();
    expect(raw).toEqual(seeded);
    expect(redacted).toEqual(seeded.map((a) => ({ ...a, vix: null, vix3m: null, fallVelocity: null })));
  });
});
