// P4 — load-cycle.js request ORDER, driven with deferred fetch stubs: on a first load every fetch
// STARTS before `/api/status` resolves; on a refocus `/api/status` goes alone and the rest wait on
// the vintage gate. Plain `.js`, no jsdom.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDashboard, loadOverview } from "./load-cycle.js";
import { BOOT_KEY, writeBoot } from "./refetch-gate.js";
import { dangerModel, loadDangerModel } from "./lab-board.js";

const V = { firedAt: "2026-10-02T22:05:00.000+00:00", deployId: "dpl_1" };
const statusBody = (firedAt = V.firedAt) => ({ verdict: { firedAt }, deployId: V.deployId, lag: false });

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
const res = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** fetch stub: every call parks on its own deferred, keyed by URL; `started()` lists URLs in call order. */
function stubFetch() {
  const calls = new Map();
  const order = [];
  const fetch = (url) => {
    order.push(url);
    const d = deferred();
    calls.set(url, d);
    return d.promise;
  };
  return { fetch, started: () => [...order], settle: (url, r) => calls.get(url).resolve(r), fail: (url) => calls.get(url).reject(new Error("net")) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
function memStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, v) };
}

let f;
beforeEach(() => {
  f = stubFetch();
});

describe("loadOverview (overview.js loadAll)", () => {
  const BOARD = ["/api/lab?hist=20", "/api/families", "/api/indicators"];

  it("first load: status + lab + families + indicators (and the danger model) all START before status resolves", async () => {
    const loadDangerModel = vi.fn(async () => {});
    const p = loadOverview({ vintage: null, loadDangerModel, fetch: f.fetch });
    await flush();
    expect(f.started().sort()).toEqual(["/api/status", ...BOARD].sort());
    expect(loadDangerModel).toHaveBeenCalledTimes(1);
    f.settle("/api/status", res(statusBody()));
    f.settle("/api/lab?hist=20", res({ board: 1 }));
    f.settle("/api/families", res([{ key: "credit" }]));
    f.settle("/api/indicators", res([{ id: "F1" }]));
    const out = await p;
    expect(out).toMatchObject({ kind: "paint", d: { board: 1 }, familyOrder: [{ key: "credit" }], indicators: [{ id: "F1" }] });
    expect(f.started()).toHaveLength(4);
  });

  it("refocus (vintage known): status alone first; same vintage stops at that ONE request", async () => {
    const loadDangerModel = vi.fn(async () => {});
    const p = loadOverview({ vintage: V, loadDangerModel, fetch: f.fetch });
    await flush();
    expect(f.started()).toEqual(["/api/status"]);
    f.settle("/api/status", res(statusBody()));
    expect(await p).toEqual({ kind: "stop" });
    expect(f.started()).toEqual(["/api/status"]);
    expect(loadDangerModel).not.toHaveBeenCalled();
  });

  it("refocus on a moved vintage: the board fetches start only AFTER status resolves", async () => {
    const p = loadOverview({ vintage: V, loadDangerModel: async () => {}, fetch: f.fetch });
    await flush();
    expect(f.started()).toEqual(["/api/status"]);
    f.settle("/api/status", res(statusBody("2026-10-05T22:05:00.000+00:00")));
    await flush();
    expect(f.started()).toEqual(["/api/status", ...BOARD]);
    BOARD.forEach((u) => f.settle(u, res([])));
    expect((await p).kind).toBe("paint");
  });

  it("degrades exactly as before: failed status ⇒ error (abandoned board fetches never reject unhandled); families !ok ⇒ []; lab !ok ⇒ error", async () => {
    let p = loadOverview({ vintage: null, loadDangerModel: async () => {}, fetch: f.fetch });
    await flush();
    f.fail("/api/status");
    BOARD.forEach((u) => f.fail(u));
    expect(await p).toEqual({ kind: "error" });

    f = stubFetch();
    p = loadOverview({ vintage: null, loadDangerModel: async () => {}, fetch: f.fetch });
    await flush();
    f.settle("/api/status", res(statusBody()));
    f.settle("/api/lab?hist=20", res({}));
    f.settle("/api/families", res(null, 500));
    f.settle("/api/indicators", res([]));
    expect(await p).toMatchObject({ kind: "paint", familyOrder: [] });

    f = stubFetch();
    p = loadOverview({ vintage: null, loadDangerModel: async () => {}, fetch: f.fetch });
    await flush();
    f.settle("/api/status", res(statusBody()));
    f.settle("/api/lab?hist=20", res(null, 504));
    f.settle("/api/families", res([]));
    f.settle("/api/indicators", res([]));
    expect(await p).toEqual({ kind: "error" });
  });
});

describe("loadDashboard (app.js fetchAll)", () => {
  const FAN = ["/api/indicators", "/api/history?limit=2"];
  const deps = (over = {}) => ({
    api: "/api",
    vintage: null,
    storage: memStorage(),
    mult: 0,
    getConfig: vi.fn(async () => ({ alertRank: ["OK"] })),
    getFamilies: vi.fn(async () => [{ key: "credit" }]),
    onFull: vi.fn(),
    fetch: f.fetch,
    ...over,
  });

  it("first load, nothing stored: status + indicators + history + config + families all START before status resolves", async () => {
    const d = deps();
    const p = loadDashboard(d);
    await flush();
    expect(f.started().sort()).toEqual(["/api/status", ...FAN].sort());
    expect(d.getConfig).toHaveBeenCalledTimes(1);
    expect(d.getFamilies).toHaveBeenCalledTimes(1);
    f.settle("/api/status", res(statusBody()));
    f.settle("/api/indicators", res([{ id: "F1" }]));
    f.settle("/api/history?limit=2", res([{ level: "OK" }]));
    expect(await p).toMatchObject({ kind: "fresh", next: V, indicators: [{ id: "F1" }], config: { alertRank: ["OK"] } });
    expect(d.onFull).toHaveBeenCalledTimes(1);
  });

  it("refocus (vintage known): status alone first; same vintage stops with the status body for the pills", async () => {
    const d = deps({ vintage: V });
    const p = loadDashboard(d);
    await flush();
    expect(f.started()).toEqual(["/api/status"]);
    f.settle("/api/status", res(statusBody()));
    expect(await p).toMatchObject({ kind: "stop", status: { lag: false } });
    expect(f.started()).toEqual(["/api/status"]);
    expect(d.getConfig).not.toHaveBeenCalled();
    expect(d.onFull).not.toHaveBeenCalled();
  });

  it("first load WITH a stored bundle stays status-first, and a matching bundle restores with zero fan-out (P9.2 unchanged)", async () => {
    const storage = memStorage();
    writeBoot(storage, { vintage: V, mult: 0, indicators: [{ id: "F1" }], history: [], config: {}, families: [{ key: "credit" }] });
    const d = deps({ storage });
    const p = loadDashboard(d);
    await flush();
    expect(f.started()).toEqual(["/api/status"]);
    f.settle("/api/status", res(statusBody()));
    expect(await p).toMatchObject({ kind: "stored", next: V, stored: { indicators: [{ id: "F1" }] } });
    expect(f.started()).toEqual(["/api/status"]);
    expect(d.getConfig).not.toHaveBeenCalled();
    expect(d.onFull).not.toHaveBeenCalled();
  });

  it("a stale stored bundle (other vintage) falls through to the full fan-out after status", async () => {
    const storage = memStorage({ [BOOT_KEY]: JSON.stringify({ v: 1, firedAt: "old", deployId: "dpl_0", mult: 0, indicators: [], history: [], config: {}, families: [{ key: "x" }] }) });
    const p = loadDashboard(deps({ storage }));
    await flush();
    expect(f.started()).toEqual(["/api/status"]);
    f.settle("/api/status", res(statusBody()));
    await flush();
    expect(f.started()).toEqual(["/api/status", ...FAN]);
    FAN.forEach((u) => f.settle(u, res([])));
    expect((await p).kind).toBe("fresh");
  });

  it("degrades exactly as before: 404 ⇒ empty, 5xx / network ⇒ error (abandoned fan-out never rejects unhandled), fan-out !ok ⇒ error", async () => {
    let p = loadDashboard(deps());
    await flush();
    f.settle("/api/status", res(null, 404));
    FAN.forEach((u) => f.fail(u));
    expect(await p).toEqual({ kind: "empty" });

    f = stubFetch();
    p = loadDashboard(deps());
    await flush();
    f.fail("/api/status");
    FAN.forEach((u) => f.fail(u));
    expect(await p).toEqual({ kind: "error" });

    f = stubFetch();
    p = loadDashboard(deps());
    await flush();
    f.settle("/api/status", res(null, 503));
    expect(await p).toEqual({ kind: "error" });

    f = stubFetch();
    const d = deps();
    p = loadDashboard(d);
    await flush();
    f.settle("/api/status", res(statusBody()));
    f.settle("/api/indicators", res([]));
    f.settle("/api/history?limit=2", res(null, 500));
    expect(await p).toEqual({ kind: "error" });
    expect(d.onFull).toHaveBeenCalledTimes(1); // cleared before the fan-out was awaited, as before
  });
});

// A first load now fires loadDangerModel before /api/status: a FAILED fetch must not be cached,
// or a refocus repaint (which re-calls it) never retries and the ledger stays blank until reload.
describe("loadDangerModel (lab-board.js) caches only a success", () => {
  it("a network error, then a 5xx, each retry on the next call; the success is kept", async () => {
    const MODEL = { members: { F1: { label: "F1" } } };
    const calls = [];
    const fetchOf = (outcome) => (url) => (calls.push(url), outcome());
    await loadDangerModel(fetchOf(() => Promise.reject(new Error("offline"))));
    expect(dangerModel).toBeNull();
    await loadDangerModel(fetchOf(async () => res(null, 503)));
    expect(dangerModel).toBeNull();
    await loadDangerModel(fetchOf(async () => res(MODEL)));
    expect(dangerModel).toEqual(MODEL);
    await loadDangerModel(fetchOf(() => Promise.reject(new Error("must not be called"))));
    expect(dangerModel).toEqual(MODEL);
    expect(calls).toEqual(["/api/danger-model", "/api/danger-model", "/api/danger-model"]);
  });
});
