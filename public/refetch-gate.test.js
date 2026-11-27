// Pure-logic unit tests for the P9 vintage gate (load-tolerance plan, P9.1 + P9.2). Plain `.js`
// so vitest's default glob collects it while `tsc` ignores it — no jsdom needed. The app.js
// wiring block at the bottom pins app.js's outcome dispatch as string assertions; the request
// ORDER lives in load-cycle.js and is pinned behaviourally by load-cycle.test.js.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { BOOT_KEY, BOOT_CAP_CHARS, vintageOf, refetchPlan, readBoot, writeBoot, hasBoot } from "./refetch-gate.js";

const V = { firedAt: "2026-09-05T17:22:10.922+00:00", deployId: "dpl_abc" };
const bundle = () => ({
  vintage: V,
  mult: 0,
  indicators: [{ id: "F1", label: "HY OAS" }],
  history: [{ level: "OK" }],
  config: { alertRank: ["OK"] },
  families: [{ key: "credit" }],
});
function memStorage(initial = {}, { throwOn = null } = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => {
      if (throwOn === "get") throw new Error("denied");
      return m.has(k) ? m.get(k) : null;
    },
    setItem: (k, v) => {
      if (throwOn === "set") throw new Error("quota");
      m.set(k, v);
    },
    dump: () => Object.fromEntries(m),
  };
}

describe("vintageOf / refetchPlan (P9.1)", () => {
  it("reads firedAt + deployId off /status; missing fields read as null", () => {
    expect(vintageOf({ verdict: { firedAt: V.firedAt }, deployId: V.deployId })).toEqual(V);
    expect(vintageOf({ verdict: {} })).toEqual({ firedAt: null, deployId: null });
    expect(vintageOf({ verdict: { firedAt: V.firedAt }, deployId: "" })).toEqual({ firedAt: V.firedAt, deployId: null });
    expect(vintageOf(null)).toEqual({ firedAt: null, deployId: null });
  });

  it("a refocus on the painted vintage STOPS — /status was the whole cost", () => {
    expect(refetchPlan(V, { ...V })).toBe("stop");
    // deployId is NOT compared in-session (the tab runs the build it loaded)
    expect(refetchPlan(V, { firedAt: V.firedAt, deployId: "dpl_new" })).toBe("stop");
  });

  it("first paint, a changed firedAt, or an unreadable one ⇒ full fan-out", () => {
    expect(refetchPlan(null, V)).toBe("full");
    expect(refetchPlan(V, { firedAt: "2026-09-06T17:22:10.922+00:00", deployId: V.deployId })).toBe("full");
    expect(refetchPlan(V, { firedAt: null, deployId: V.deployId })).toBe("full");
    expect(refetchPlan({ firedAt: null, deployId: null }, V)).toBe("full");
  });
});

describe("readBoot / writeBoot (P9.2)", () => {
  it("round-trips a bundle and paints ONLY on the same firedAt + deployId + mult", () => {
    const s = memStorage();
    expect(writeBoot(s, bundle())).toBe(true);
    expect(readBoot(s, { vintage: V, mult: 0 })?.indicators).toEqual([{ id: "F1", label: "HY OAS" }]);
    expect(readBoot(s, { vintage: { ...V, firedAt: "2026-09-06T00:00:00+00:00" }, mult: 0 })).toBeNull();
    expect(readBoot(s, { vintage: { ...V, deployId: "dpl_other" }, mult: 0 })).toBeNull();
    expect(readBoot(s, { vintage: V, mult: 1.5 })).toBeNull();
  });

  it("never paints from storage without a deploy id on EITHER side (local preview, pre-P9 build)", () => {
    const s = memStorage();
    expect(writeBoot(s, { ...bundle(), vintage: { firedAt: V.firedAt, deployId: null } })).toBe(false);
    expect(s.dump()).toEqual({});
    writeBoot(s, bundle());
    expect(readBoot(s, { vintage: { firedAt: V.firedAt, deployId: null }, mult: 0 })).toBeNull();
  });

  it("an empty families list (the failed-fetch marker getFamilies retries on) is neither written nor restored", () => {
    const s = memStorage();
    expect(writeBoot(s, { ...bundle(), families: [] })).toBe(false);
    writeBoot(s, bundle());
    s.setItem(BOOT_KEY, JSON.stringify({ ...JSON.parse(s.getItem(BOOT_KEY)), families: [] }));
    expect(readBoot(s, { vintage: V, mult: 0 })).toBeNull();
  });

  it("garbage, a foreign shape, a throwing storage, or no storage ⇒ null / false, never a throw", () => {
    expect(readBoot(memStorage({ [BOOT_KEY]: "{not json" }), { vintage: V })).toBeNull();
    expect(readBoot(memStorage({ [BOOT_KEY]: JSON.stringify({ v: 2, ...V }) }), { vintage: V })).toBeNull();
    expect(readBoot(memStorage({ [BOOT_KEY]: JSON.stringify({ v: 1, ...V, indicators: "x" }) }), { vintage: V })).toBeNull();
    expect(readBoot(memStorage({}, { throwOn: "get" }), { vintage: V })).toBeNull();
    expect(readBoot(null, { vintage: V })).toBeNull();
    expect(writeBoot(memStorage({}, { throwOn: "set" }), bundle())).toBe(false);
    expect(writeBoot(null, bundle())).toBe(false);
  });

  it("refuses a bundle over BOOT_CAP_CHARS and leaves the old one in place", () => {
    const s = memStorage();
    expect(writeBoot(s, bundle())).toBe(true);
    const big = { ...bundle(), indicators: [{ id: "F1", label: "x".repeat(BOOT_CAP_CHARS) }] };
    expect(writeBoot(s, big)).toBe(false);
    expect(readBoot(s, { vintage: V, mult: 0 })?.indicators).toEqual([{ id: "F1", label: "HY OAS" }]);
  });
});

describe("hasBoot (P4: stored bundle ⇒ the first load stays status-first)", () => {
  it("true for any bundle readBoot would restore under this mult; false otherwise", () => {
    const s = memStorage();
    expect(hasBoot(s, 0)).toBe(false);
    writeBoot(s, bundle());
    expect(hasBoot(s, 0)).toBe(true);
    expect(hasBoot(s, 2)).toBe(false); // a foreign ?mult= never restores
    expect(hasBoot(memStorage({ [BOOT_KEY]: "{not json" }), 0)).toBe(false);
    expect(hasBoot(memStorage({}, { throwOn: "get" }), 0)).toBe(false);
    expect(hasBoot(null, 0)).toBe(false);
    const noFam = memStorage({ [BOOT_KEY]: JSON.stringify({ v: 1, ...V, mult: 0, indicators: [], history: [], config: {}, families: [] }) });
    expect(hasBoot(noFam, 0)).toBe(false); // readBoot's own shape rules decide
  });
});

describe("app.js wiring (string assertions — app.js is not importable)", () => {
  const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const fetchAll = src.slice(src.indexOf("async function fetchAll()"), src.indexOf("// --- Card click"));

  // The gate → restore → clear → fan-out ORDER is behavioural in load-cycle.test.js; app.js owns the dispatch.
  it("fetchAll runs loadDashboard over the painted vintage and dispatches its outcomes", () => {
    expect(fetchAll).toMatch(/loadDashboard\(\{[^}]*vintage: state\.vintage,/);
    expect(fetchAll).toContain("onFull: () => state.seriesCache.clear()");
    // the painted vintage is set only AFTER a successful render, on both paths (a failed fan-out
    // must stay retryable on the next refocus)
    const renders = [...fetchAll.matchAll(/render\(\{ status/g)].map((m) => m.index);
    const vintageSets = [...fetchAll.matchAll(/setState\(\{ vintage: next \}\)/g)].map((m) => m.index);
    expect(renders).toHaveLength(2);
    expect(vintageSets).toHaveLength(2);
    expect(vintageSets[0]).toBeGreaterThan(renders[0]);
    expect(vintageSets[1]).toBeGreaterThan(renders[1]);
    // a same-vintage refocus still repaints the wall-clock pills from the fresh body
    const stop = fetchAll.slice(fetchAll.indexOf('r.kind === "stop"'), fetchAll.indexOf('r.kind === "stored"'));
    expect(stop).toContain("renderZoneA({ ...state.lastView, ...statusPills(status) })");
  });

  it("visibilitychange calls fetchAll on visible and persists the bundle on hidden; pagehide persists too", () => {
    expect(src).toMatch(/visibilityState === "visible"\) fetchAll\(\)/);
    expect(src).toMatch(/visibilityState === "hidden"\) persistBoot\(\)/);
    expect(src).toMatch(/addEventListener\("pagehide", persistBoot\)/);
  });

  it("the load-path fetch fan-out is ≤ 6 call sites (P3 guard)", () => {
    // fetchAll's own requests live in load-cycle.js's loadDashboard (P4) — count both files.
    const cycle = readFileSync(new URL("./load-cycle.js", import.meta.url), "utf8");
    const dash = src + cycle.slice(cycle.indexOf("export async function loadDashboard("));
    // Comments hold prose like `/status` — strip block comments first, then line comments, so only
    // real fetch() call sites count (stripping ` * ` docblock lines first would eat closing `*/`s).
    const code = dash.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // http.js call shapes count beside the prefetch-taking `fetchOnce(`.
    const sites = [...code.matchAll(/(?:fetch(?:Once)?|getJson|request|send)\(`([^`]*)`/g)].map((m) => m[1]);
    // Interaction-only fetch sites — fired on click/scrub/card-activate, NEVER the cold load fan-out.
    // Each must still match a real site (a stale entry is a hole in the count).
    const INTERACTION_ONLY = [
      { why: "getMemberWeight — /danger-model, lazy on card activate", re: /\/danger-model/ },
      { why: "renderLadderTab range button — /history ladder tab (default tab is detail)", re: /\/history\?limit=\$\{limit\}/ },
    ];
    for (const { why, re } of INTERACTION_ONLY) {
      expect(sites.filter((u) => re.test(u)), `interaction-only site "${why}" no longer exists`).toHaveLength(1);
    }
    const loadPath = sites.filter((u) => !INTERACTION_ONLY.some(({ re }) => re.test(u)));
    // Non-vacuity anchor: the collapse endpoints the parser must have found.
    expect(loadPath.some((u) => u.includes("/indicators"))).toBe(true);
    expect(loadPath.some((u) => u.includes("/status"))).toBe(true);
    expect(loadPath.length).toBeLessThanOrEqual(6);
  });
});
