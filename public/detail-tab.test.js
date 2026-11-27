// Pins the extracted detail-tab seam (public/detail-tab.js, P11.d) — plain `.js` so vitest
// collects it and tsc ignores it (frontend.md §Testable slices go in a pure seam module). app.js is NEVER imported here:
// fixture `state`/`deps` stand in for its live wiring, exactly what /overview will pass.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { guardToken, isCurrent } from "./app-state.js";
import { topIndicatorsFor, TOP_N, DEFAULT_LEG, OFF_LADDER_LEGS } from "./leg-top.js";
import { DETAIL_LIMIT, LONG_WINDOW } from "./chart-primitives.js";
import { LEG_CHART_ID } from "./leg-chart.js";
import { renderDetailTab, fetchDetailSeries, chipWindow, readDetailWindow, writeDetailWindow, DETAIL_WINDOW_KEY } from "./detail-tab.js";
import { sleeveLabel } from "./sleeve-label.js";
import { ALL_INDICATORS } from "../src/registry.ts";
import { buildIndicatorChart } from "../api/indicators";

// The hand row the leg pick must fan out to — derived from the seam's own ranking dep, never a
// hand-typed mirror (leg-top.js rule).
const LEG_IDS = topIndicatorsFor(DEFAULT_LEG, null).ids;
// Every leg's own chart id is served too, with its real wire spec — the leg slot is a member slot over it.
const legMeta = (id) => ({ id, label: `${id} label`, family: "pension-drawdown", chart: buildIndicatorChart(ALL_INDICATORS.find((i) => i.id === id)) });
const METAS = [
  ...LEG_IDS.map((id) => ({ id, label: `${id} label`, family: "credit" })),
  ...Object.values(LEG_CHART_ID).map(legMeta),
];
const LEG_PTS = [
  { date: "2026-01-01", value: 100 },
  { date: "2026-01-02", value: 110 },
];

/** Fixture state + recording deps — the seam's whole contract, no DOM. */
function harness(zoneD = {}) {
  const state = {
    indicators: METAS,
    zoneD: { tab: "detail", indicatorId: null, legId: null, compareIds: [null, null], details: null, ...zoneD },
    familyOrder: [],
  };
  const calls = [];
  const writes = [];
  const setStates = [];
  const deps = {
    getMemberWeight: async () => ({ F1: { [DEFAULT_LEG]: 0.5 } }),
    // Overview-style fetcher: the URL is composed ONLY from what the seam passes through —
    // there is no mult for the seam to add, which is the P11.d contract under test.
    fetchSeries: async (id, limit, detail = false, from = null) => {
      const url = `/api/series?id=${encodeURIComponent(id)}&limit=${limit}${detail ? "&detail=1" : ""}${
        from ? `&from=${encodeURIComponent(from)}` : ""
      }`;
      calls.push({ args: [id, limit, detail, from], url });
      return { points: [] };
    },
    legSlot: true,
    topIndicatorsFor,
    guardToken,
    isCurrent,
    setState: (slice, patch) => setStates.push([slice, patch]),
    setHTML: (el, html) => writes.push({ el, html }),
  };
  const panel = { id: "zone-d-panel" };
  return { state, deps, panel, calls, writes, setStates };
}

describe("detail-tab seam", () => {
  it("no indicator and no leg picked: paints both pickers + the prompt, fetches nothing", async () => {
    const h = harness();
    await renderDetailTab(h.panel, h.state, h.deps);
    expect(h.calls).toEqual([]);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].el).toBe(h.panel);
    const html = h.writes[0].html;
    expect(html).toContain("Pick an indicator.");
    expect(html).toContain('class="ind-picker"');
    expect(html).toContain('class="leg-picker"');
    // Leg options derive from the served memberWeight row keys, never a hand roster.
    expect(html).toContain(`<option value="${DEFAULT_LEG.replace(/&/g, "&amp;")}"`);
  });

  it(`a leg pick fans out to the leg's own chart id + TOP_N (${TOP_N}) members, all through fetchSeries`, async () => {
    const h = harness({ legId: DEFAULT_LEG });
    await renderDetailTab(h.panel, h.state, h.deps);
    expect(LEG_IDS).toHaveLength(TOP_N); // the row itself carries TOP_N seats…
    // …every seat is fetched in row order, after the leg's LEG_CHART_ID at the default slot 1.
    expect(h.calls.map((c) => c.args[0])).toEqual([LEG_CHART_ID[DEFAULT_LEG], ...LEG_IDS]);
    // Chart-spec-less metas: count window = DETAIL_LIMIT + 0 lead, detail recompute on, no from.
    for (const c of h.calls) expect(c.args.slice(1)).toEqual([DETAIL_LIMIT, true, null]);
    const html = h.writes.at(-1).html;
    expect(html).toContain("Why these indicators"); // legDescBlock replaces the primary blurb
    expect(html).toContain("Top holdings."); // leg-desc.js `holdings` reach the leg stack
    expect((html.match(/No history yet/g) ?? []).length).toBe(TOP_N + 1); // empty series ⇒ one msg per slot, leg included
    expect(html).not.toContain("what-if"); // no mult anywhere ⇒ no badge
    // The pointer-readout seam hands back one (null) entry per slot — TOP_N members + the leg.
    expect(h.setStates).toEqual([["zoneD", { details: Array(TOP_N + 1).fill(null) }]]);
  });

  it("a compare id absent from the served metas renders no Unknown row — its picker reads '— none —' and nothing is fetched for it", async () => {
    const [primary, known] = LEG_IDS;
    const h = harness({ indicatorId: primary, compareIds: ["NOT_SERVED", known] });
    await renderDetailTab(h.panel, h.state, h.deps);
    const html = h.writes.at(-1).html;
    expect(html).not.toContain("Unknown indicator");
    expect(html).toMatch(/data-slot="0"[^>]*>\s*<option value="" selected>/); // slot 1 picker: none
    expect(h.calls.map((c) => c.args[0])).toEqual([primary, known]); // the known compare still charts
  });

  it("no legSlot dep (/overview): a leg pick paints the TOP_N members only — no leg slot, no position picker", async () => {
    const h = harness({ legId: DEFAULT_LEG, legChartPos: 3 });
    delete h.deps.legSlot;
    await renderDetailTab(h.panel, h.state, h.deps);
    expect(h.calls.map((c) => c.args[0])).toEqual(LEG_IDS); // still exactly TOP_N reads
    const html = h.writes.at(-1).html;
    expect((html.match(/No history yet/g) ?? []).length).toBe(TOP_N);
    expect(html).not.toContain("leg-chart-pos");
    expect(h.setStates).toEqual([["zoneD", { details: Array(TOP_N).fill(null) }]]);
  });

  it("places the leg chart at the chosen 1-based legChartPos slot", async () => {
    const legId = LEG_CHART_ID[DEFAULT_LEG];
    for (const pos of [1, 5]) {
      const h = harness({ legId: DEFAULT_LEG, legChartPos: pos });
      // Only the leg's chart id has points, so the sole `data-chart-slot` marker's index IS the leg's
      // stack position — pos-1 exactly when placeLegChart is honoured.
      h.deps.fetchSeries = async (id) => ({ points: id === legId ? LEG_PTS : [], unit: "€" });
      await renderDetailTab(h.panel, h.state, h.deps);
      const html = h.writes.at(-1).html;
      const slots = [...html.matchAll(/data-chart-slot="(\d+)"/g)].map((m) => m[1]);
      expect(slots).toEqual([String(pos - 1)]); // exactly one chart, at the chosen slot
      expect(html).toContain(legId); // the indicator chart's head band carries the leg's chart id
    }
  });

  it("supplies no mult: nothing mult-shaped crosses deps.fetchSeries, so overview URLs carry no &mult=", async () => {
    const h = harness({ legId: DEFAULT_LEG });
    await renderDetailTab(h.panel, h.state, h.deps);
    expect(h.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(h.calls.map((c) => c.args))).not.toContain("mult");
    for (const c of h.calls) expect(c.url).not.toContain("mult");
  });
});

describe("indicator picker option text", () => {
  it("ETFs group options show the label alone (short name + ticker); other groups keep a distinct id", async () => {
    const h = harness();
    h.state.indicators = [
      { id: "LEGP_EUFIN", label: "EU-Fin EXSH", family: "pension-drawdown" },
      { id: "F1", label: "HY OAS", family: "credit" },
    ];
    h.state.familyOrder = [
      { key: "credit", label: "Credit", ids: ["F1"] },
      { key: "pension-drawdown", label: "ETFs", ids: ["LEGP_EUFIN"] },
    ];
    await renderDetailTab(h.panel, h.state, h.deps);
    const picker = h.writes[0].html.match(/<select class="ind-picker"[\s\S]*?<\/select>/)[0];
    expect(picker).toContain('<option value="LEGP_EUFIN">EU-Fin EXSH</option>');
    expect(picker).toContain('<option value="F1">HY OAS F1</option>');
  });
});

describe("off-ladder legs (Commodities, AW Fundam) in the leg picker", () => {
  const opt = (k) => `<option value="${k.replace(/&/g, "&amp;")}"`; // esc() mirror for the option value

  it("lists EVERY off-ladder leg under an Off-ladder optgroup while memberWeight is present", async () => {
    const h = harness();
    await renderDetailTab(h.panel, h.state, h.deps);
    const html = h.writes[0].html;
    expect(html).toContain('<optgroup label="Off-ladder">');
    for (const leg of OFF_LADDER_LEGS) expect(html, leg).toContain(opt(leg)); // both Commodities + AW Fundam
    expect(html).toContain(opt(DEFAULT_LEG)); // served sleeves still present
  });

  it("labels every leg option 'short leg name + ticker' (ladder via sleeveLabel, off-ladder via OFF_LADDER_LABEL)", async () => {
    const h = harness();
    await renderDetailTab(h.panel, h.state, h.deps);
    const html = h.writes[0].html;
    const optText = (k) => html.match(new RegExp(`${opt(k)}[^>]*>([^<]*)<`))?.[1];
    for (const leg of OFF_LADDER_LEGS) expect(optText(leg), leg).toMatch(new RegExp(`^${leg} [A-Z0-9]{3,5}$`));
    expect(optText(DEFAULT_LEG)).toBe(sleeveLabel(DEFAULT_LEG).replace(/&/g, "&amp;"));
    expect(optText(DEFAULT_LEG)).not.toBe(DEFAULT_LEG.replace(/&/g, "&amp;")); // premise: the ladder leg carries a ticker
  });

  it("keeps EVERY off-ladder leg selectable while memberWeight is cold (null): enabled select, no disabled attr", async () => {
    const h = harness();
    h.deps.getMemberWeight = async () => null; // model hasn't loaded
    await renderDetailTab(h.panel, h.state, h.deps);
    const html = h.writes[0].html;
    for (const leg of OFF_LADDER_LEGS) expect(html, leg).toContain(opt(leg)); // both stay listed while cold
    expect(html).toContain('class="leg-picker" aria-label="leg">'); // enabled: no `disabled` attr
  });

  it.each(OFF_LADDER_LEGS)("picking %s fetches its LEG_CHART_ID as a member chart and renders the position control", async (leg) => {
    const legId = LEG_CHART_ID[leg];
    expect(legId).toBeDefined(); // premise: the off-ladder leg resolves a chart id (parity owned by leg-chart.test.js)
    const h = harness({ legId: leg, legChartPos: 3 });
    h.deps.fetchSeries = async (...args) => {
      h.calls.push({ args });
      return { points: args[0] === legId ? LEG_PTS : [], unit: "€" };
    };
    await renderDetailTab(h.panel, h.state, h.deps);
    const html = h.writes.at(-1).html;
    expect(h.calls.filter((c) => c.args[0] === legId).map((c) => c.args.slice(1, 3))).toEqual([[DETAIL_LIMIT, true]]);
    expect(html).toContain("leg-chart-pos"); // position control renders for the off-ladder leg
    expect(html).toContain(legId); // the leg chart's head band carries its id
    expect(html).toContain("Why these indicators"); // legDescBlock still renders the leg basis/why
    // Stack is TOP_N members + 1 leg slot; only the leg slot (real points) carries a pointer readout.
    const details = h.setStates[0][1].details;
    expect(details).toHaveLength(TOP_N + 1);
    expect(details.filter((d) => d !== null)).toHaveLength(1);
  });

  it("a leg with no LEG_CHART_ID entry (idless) still yields members-only — no leg fetch, no position control", async () => {
    const IDLESS = "__no_chart_leg__"; // stands in for a future off-ladder leg added without a LEG_CHART_ID
    expect(LEG_CHART_ID[IDLESS]).toBeUndefined(); // premise: the guard's false branch is reachable
    const h = harness({ legId: IDLESS, legChartPos: 3 });
    h.deps.topIndicatorsFor = () => ({ ids: LEG_IDS.slice(0, 2), source: "config" });
    await renderDetailTab(h.panel, h.state, h.deps);
    const html = h.writes.at(-1).html;
    expect(h.calls.map((c) => c.args[0])).toEqual(LEG_IDS.slice(0, 2)); // members only, no `undefined` slot
    expect(html).not.toContain("leg-chart-pos"); // no position control
  });

  it("a leg chart id already among the members is drawn once — the stack is the leg chart then the remaining members", async () => {
    const legId = LEG_CHART_ID[DEFAULT_LEG];
    const ids = [LEG_IDS[0], legId, LEG_IDS[1]];
    const h = harness({ legId: DEFAULT_LEG, legChartPos: 1 });
    h.deps.topIndicatorsFor = () => ({ ids, source: "config" });
    await renderDetailTab(h.panel, h.state, h.deps);
    // The leg's chart moves to its slot (1); the member copy is dropped, so no id is fetched twice.
    expect(h.calls.map((c) => c.args[0])).toEqual([legId, LEG_IDS[0], LEG_IDS[1]]);
    expect(h.setStates.at(-1)[1].details).toHaveLength(ids.length);
  });
});

describe("fetchDetailSeries — date-anchored `from` lands on the /api/series month grid (P5)", () => {
  it("floors the anchor-pad `from` to a YYYY-MM-01 so a live detail chart never mints a 400", async () => {
    // Clock-free red-demo: sweep 32 CONSECUTIVE anchor days. At most one calendar day in any 32 is
    // a month-start, so WITHOUT the floor ≥31 emitted `from`s fail the -01 shape and this reds on
    // every run date; WITH it all 32 are a YYYY-MM-01.
    const froms = [];
    const deps = {
      fetchSeries: async (_id, _limit, _detail, from) => {
        froms.push(from);
        return { points: [] };
      },
    };
    for (let d = 100; d < 132; d++) {
      await fetchDetailSeries({ id: "F13", label: "F13", chart: { fromDays: d } }, deps);
    }
    expect(froms).toHaveLength(32);
    for (const from of froms) expect(from, from).toMatch(/^\d{4}-\d{2}-01$/);
  });
});

describe("fetchDetailSeries — date-anchored pad covers the spec's `lead`", () => {
  it("a 200-obs lead (F1's toggle MA200) reaches ≥ 200 trading days (≥ 290 cal days) behind the anchor", async () => {
    const froms = [];
    const deps = { fetchSeries: async (_id, _l, _d, from) => (froms.push(from), { points: [] }) };
    const { chartMeta } = await fetchDetailSeries({ id: "F1", label: "F1", chart: { fromDays: 739, lead: 200 } }, deps);
    const gapDays = (Date.parse(chartMeta.chart.fromDate) - Date.parse(froms[0])) / 86_400_000;
    expect(gapDays).toBeGreaterThanOrEqual(Math.ceil((200 * 365) / 252));
  });
});

describe("window chips - the ONE global row atop #zone-d-panel", () => {
  it("renders the five chips + touch hint; the default '2y' pressed by default", async () => {
    const h = harness();
    await renderDetailTab(h.panel, h.state, h.deps);
    const html = h.writes[0].html;
    expect(html).toContain('<button class="range win" data-window="63" aria-pressed="false">3m</button>');
    expect(html).toContain('<button class="range win" data-window="126" aria-pressed="false">6m</button>');
    expect(html).toContain('<button class="range win" data-window="252" aria-pressed="false">1y</button>');
    expect(html).toContain('<button class="range win" data-window="default" aria-pressed="true">2y</button>');
    expect(html).toContain(`<button class="range win" data-window="${LONG_WINDOW}" aria-pressed="false">5y</button>`);
    expect(html).toContain('<span class="touch-hint">tap to read</span>');
  });

  it("a picked window presses its own chip only", async () => {
    const h = harness({ window: 126 });
    await renderDetailTab(h.panel, h.state, h.deps);
    const html = h.writes[0].html;
    expect(html).toContain('data-window="126" aria-pressed="true"');
    expect(html).toContain('data-window="default" aria-pressed="false"');
    expect(html).toContain('data-window="63" aria-pressed="false"');
  });

  it("exactly ONE chip row regardless of chart count (leg stack = TOP_N+1 slots)", async () => {
    const h = harness({ legId: DEFAULT_LEG });
    await renderDetailTab(h.panel, h.state, h.deps);
    const html = h.writes.at(-1).html;
    expect((html.match(/data-window="63"/g) ?? []).length).toBe(1);
    // Placement: under the pickers, before the first chart block.
    expect(html.indexOf("win-controls")).toBeGreaterThan(html.indexOf("leg-picker"));
    expect(html.indexOf("win-controls")).toBeLessThan(html.indexOf("No history yet"));
  });

  it.each(["./app.js", "./overview.js"])("%s wires the delegated .range.win click -> chipWindow -> zoneD.window (F1)", (file) => {
    // overview.js runs module-level DOM side effects, so it is never imported in a test
    // (frontend.md) - the source scan pins the wiring both pages must carry.
    const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    expect(src).toMatch(/import \{[^}]*\bchipWindow\b[^}]*\} from "\.\/detail-tab\.js"/);
    expect(src).toContain("{ window: chipWindow(range.dataset.window) }");
    // The chip persists across reloads: seeded from storage, written on every click.
    expect(src).toMatch(/window: readDetailWindow\(safeStorage\(\)\)/);
    expect(src).toContain("writeDetailWindow(safeStorage(), state.zoneD.window);");
  });

  it("readDetailWindow / writeDetailWindow round-trip every chip; invalid, missing or blocked storage reads the default", () => {
    const map = {};
    const s = { getItem: (k) => (k in map ? map[k] : null), setItem: (k, v) => (map[k] = String(v)) };
    for (const w of [63, 126, 252, LONG_WINDOW, null]) {
      writeDetailWindow(s, w);
      expect(readDetailWindow(s)).toBe(w);
    }
    writeDetailWindow(s, 63);
    writeDetailWindow(s, 999); // not a chip ⇒ ignored, the last chip survives
    expect(readDetailWindow(s)).toBe(63);
    map[DETAIL_WINDOW_KEY] = "999";
    expect(readDetailWindow(s)).toBeNull();
    expect(readDetailWindow(null)).toBeNull();
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readDetailWindow(blocked)).toBeNull();
    expect(() => writeDetailWindow(blocked, 63)).not.toThrow();
  });

  it("the 5y chip widens every member + leg fetch to LONG_WINDOW; a narrower chip keeps the default fetch", async () => {
    const wide = harness({ legId: DEFAULT_LEG, window: LONG_WINDOW });
    await renderDetailTab(wide.panel, wide.state, wide.deps);
    for (const c of wide.calls) expect(c.args.slice(1)).toEqual([LONG_WINDOW, true, null]);
    expect(wide.calls.map((c) => c.args[0])).toContain(LEG_CHART_ID[DEFAULT_LEG]); // the leg rides the member fetch
    const narrow = harness({ legId: DEFAULT_LEG, window: 126 });
    await renderDetailTab(narrow.panel, narrow.state, narrow.deps);
    for (const c of narrow.calls) expect(c.args.slice(1)).toEqual([DETAIL_LIMIT, true, null]);
    expect(narrow.calls.map((c) => c.args[0])).toContain(LEG_CHART_ID[DEFAULT_LEG]);
  });

  it("chipWindow maps the chip dataset value ('default' => null, else trading days)", () => {
    expect(chipWindow("default")).toBeNull();
    expect(chipWindow(String(LONG_WINDOW))).toBe(LONG_WINDOW);
    expect(chipWindow("63")).toBe(63);
    expect(chipWindow("252")).toBe(252);
  });

  it("zoneD.window is a guarded key: a mid-fetch chip click drops the stale continuation", async () => {
    const h = harness({ indicatorId: LEG_IDS[0] });
    h.deps.fetchSeries = async () => {
      h.state.zoneD.window = 63; // chip clicked while the series fetch is in flight
      return { points: [] };
    };
    await renderDetailTab(h.panel, h.state, h.deps);
    expect(h.writes).toEqual([]); // the stale continuation never painted
    expect(h.setStates).toEqual([]);
  });
});

// ── Lazy detail stack (ex-detail-tab.lazy.test.js) ──────────────────────────────────────────────
// Lazy detail stack (public/detail-tab.js): with an `observe` dep, a leg stack fetches a row only
// when its observe callback fires. The fake `observe` records (el, cb) so the test fires rows by hand.
describe("lazy detail stack", () => {
  // LEG_IDS is the module-level one above (same derivation); METAS here is the lazy fixture's own.
  const METAS = [...LEG_IDS, LEG_CHART_ID[DEFAULT_LEG]].map((id) => ({ id, label: `${id} label`, family: "credit" }));

  function lazyHarness() {
    const state = {
      indicators: METAS,
      zoneD: { tab: "detail", indicatorId: null, legId: DEFAULT_LEG, compareIds: [null, null], details: null },
      familyOrder: [],
    };
    const calls = []; // every deps.fetchSeries invocation
    const cache = new Map(); // app.js seriesCache stand-in: a miss is a network request
    const network = [];
    const writes = [];
    const observed = [];
    const nodes = new Map();
    const deps = {
      getMemberWeight: async () => ({ F1: { [DEFAULT_LEG]: 0.5 } }),
      fetchSeries: async (...args) => {
        calls.push(args);
        const key = JSON.stringify(args);
        if (!cache.has(key)) {
          network.push(args);
          cache.set(key, { points: [] });
        }
        return cache.get(key);
      },
      legSlot: true,
      topIndicatorsFor,
      guardToken,
      isCurrent,
      setState: (slice, patch) => Object.assign(state[slice], patch),
      setHTML: (el, html) => writes.push({ el, html }),
      observe: (el, cb) => observed.push({ el, cb }),
    };
    const node = (sel) => nodes.get(sel) ?? nodes.set(sel, { sel }).get(sel);
    const panel = { id: "zone-d-panel", querySelector: node };
    return { state, deps, panel, calls, network, writes, observed };
  }

  // Slot 0 is the leg's own chart (placeLegChart's default position), so slot 1 is the first member row.
  const memberRow = (h, from = 0) => h.observed[from + 1];

  it("fetches nothing until a row's observe cb fires; a row fetches once; re-render reuses seriesCache", async () => {
    const h = lazyHarness();
    await renderDetailTab(h.panel, h.state, h.deps);
    expect(h.calls).toHaveLength(0);
    expect(h.observed).toHaveLength(TOP_N + 1); // every member + the leg's own chart
    expect(h.writes[0].html).toContain("data-lazy-slot");

    const row = memberRow(h);
    await row.cb();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0][0]).toBe(LEG_IDS[0]);
    expect(h.writes.at(-1).el).toBe(row.el); // the row paints into its own placeholder

    await row.cb(); // a second intersect never refetches
    expect(h.calls).toHaveLength(1);
    await h.observed[0].cb(); // the leg's own row is lazy too, fetched as a member chart
    expect(h.calls.at(-1)[0]).toBe(LEG_CHART_ID[DEFAULT_LEG]);
    expect(h.calls).toHaveLength(2);

    const seen = h.observed.length;
    await renderDetailTab(h.panel, h.state, h.deps);
    expect(h.calls).toHaveLength(2); // the re-render is lazy too
    await memberRow(h, seen).cb();
    expect(h.network).toHaveLength(2); // same args ⇒ seriesCache hit, no new request
  });

  it("a row from a superseded render (same selection) paints nothing into the old DOM", async () => {
    const h = lazyHarness();
    await renderDetailTab(h.panel, h.state, h.deps);
    const stale = memberRow(h);
    await renderDetailTab(h.panel, h.state, h.deps);
    const before = h.writes.length;
    const details = h.state.zoneD.details;
    await stale.cb();
    expect(h.writes).toHaveLength(before);
    expect(h.state.zoneD.details).toBe(details);
  });
});
