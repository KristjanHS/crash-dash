/**
 * Tests for GET /api/series (api/series.ts) over the PENSION legs (SPY/LEGP_EXUS/DEXUSEU).
 * Every seam rides `seriesBody(storeOf, req, seams)` (the full body `handle` serves) — the store thunk, a fixed `now`, the warn sink
 * and the multiplier resolver — so this file needs no module mock or fake clock.
 *
 * Contract: once the legs are registered,
 * /series serves all three, AND the latest point's delta20 is a REAL value (priceLegReadingSeries
 * computes a true 20-obs delta once ≥21 obs exist) — not a permanent 0 that would read as
 * a data-quality bug.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, test, vi } from "vitest";

import type { Store } from "../src/store.js";

import { InMemoryStore } from "../src/store-memory.js";
import { resetVintageMemo } from "../src/api/vintage-memo.js";
import { resolveCuts } from "../src/domain-cuts.js";
import {
  FXH_AMBER,
  FXH_RED,
  DISP_BASKET_RED,
  DISP_CORR_P_MIN_OBS,
  DISP_CORR_P_WINDOW,
} from "../src/family-descriptor-rows.js";
import { confirmedStateSeries } from "../src/domain-fold.js";
import { confirmClosesFor } from "../src/families.js";
import { resolveMultiplier } from "../src/threshold-config.js";
import type { SeriesResponse } from "../src/api/types.js";
import {
  RUN_AT,
  seedSharedStore,
  F1,
  headersOf,
  r7LegByDate,
  r7Inputs,
  r7Rows,
  seedR7,
  calibRow,
  GATE_N,
  MA_WIN,
  DISP_MULT,
  AMBER_BASKET,
  DISP_ROWS,
  ramp,
  seedPension,
  VTP_IND,
  vtpDates,
} from "../src/api-series.test-helpers.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { KBE_WORST_DROP } from "../src/registry-price.js";
import { worstDrop } from "../scripts/probe-value-tranches.js";
import { seriesBody, type SeriesSeams } from "./series.js";

// One shared seeded InMemoryStore. `withStore` swaps the store the handler's thunk hands back for
// one call, so a test needing its OWN history (the CG warmup-head fixture, which must be SHORTER than
// the deep one for the same id) cannot contaminate the shared seed.
const store = new InMemoryStore();
let activeStore: Store = store;
const withStore = async <T>(s: Store, fn: () => Promise<T>): Promise<T> => {
  activeStore = s;
  try {
    return await fn();
  } finally {
    activeStore = store;
  }
};

// DISP's shipped multiplier is 1.0, at which `earlierCut` is the IDENTITY — so with the
// real config a `firesHighward: true → false` flip in api/series.ts' cut-gate branch is a
// literal no-op and no fixture could ever catch it. Inject a non-1.0 multiplier for DISP
// ONLY (every other id passes through to the real resolver, so no other test moves), which
// separates the two directions: red cut 0.7 resolves to 0.63 highward vs 0.77 lowward.
const multiplierOf = (id: string): number => (id === "DISP" ? DISP_MULT : resolveMultiplier(id));

// P1 staleness (readInputSeries, INPUT_MAX_STALE_DAYS vs `now`): a clock BEFORE every fixture
// date, so no seeded input can read as stale here (a future-dated newest row has negative age).
// Stale behavior itself is unit-tested in src/input-series.test.ts.
const NOW = new Date("1999-01-01T00:00:00Z");

// R7: these suites pin the FULL body ⇒ every request reads `seriesBody`, before the response rule redacts it.
const GET = async (req: Request, seams: Partial<SeriesSeams> = {}): Promise<Response> => {
  const body = await seriesBody(() => activeStore, req, { now: NOW, multiplierOf, ...seams });
  return body instanceof Response ? body : Response.json(body);
};

// P12.a: the vintage memo is MODULE-LEVEL state inside api/series.ts — clear it per test, or a
// cached synth promise from one test's store would be served against the next test's.
beforeEach(() => resetVintageMemo());

await seedSharedStore(store);

const serve = async (id: string): Promise<{ status: number; body: SeriesResponse }> => {
  const res = await GET(new Request(`https://x/api/series?id=${id}`));
  return { status: res.status, body: (await res.json()) as SeriesResponse };
};

const serveDetail = async (id: string, limit: number): Promise<SeriesResponse> => {
  const res = await GET(new Request(`https://x/api/series?id=${id}&detail=1&limit=${limit}`));
  return (await res.json()) as SeriesResponse;
};

const servePension = async (s: InMemoryStore, qs: string): Promise<SeriesResponse> =>
  withStore(s, async () => (await (await GET(new Request(`https://x/api/series?${qs}`))).json()) as SeriesResponse);

describe("GET /api/series - FXH three-leg haven-move ribbon", () => {
  const bandOf = (m: number) => (m >= FXH_RED ? "RED" : m >= FXH_AMBER ? "AMBER" : "GREEN");

  test("per-point max(havenLegs) crossing a band matches the stored rawState; the move-axis effAmber/effRed ride along", async () => {
    const { status, body } = await serve("FXH");
    expect(status).toBe(200);
    expect(body.effAmber).toBe(FXH_AMBER);
    expect(body.effRed).toBe(FXH_RED);
    for (const p of body.points) {
      const m = Math.max(p.havenLegs!.eur, p.havenLegs!.chf, p.havenLegs!.jpy);
      expect(bandOf(m), `@${p.date} move=${m}`).toBe(p.rawState);
    }
    // Vacuity: the fixture actually spans bands and reaches a confirmed RED — the invariant
    // is exercised across a real transition, not on a constant all-GREEN ribbon.
    const raws = new Set(body.points.map((p) => p.rawState));
    expect(raws.size).toBeGreaterThan(1);
    expect(body.points.at(-1)!.state).toBe("RED");
  });
});


describe("GET /api/series - R7 bull-steepener leg + ranked-cut overlay", () => {
  test("attaches bullLegs + the four ranked cuts (derived from the seam) on a settled point", async () => {
    const s = await seedR7();
    const { status, body } = await withStore(s, () => serve("R7"));
    expect(status).toBe(200);
    const newest = body.points.at(-1)!;
    const exp = r7LegByDate.get(newest.date)!;
    // Premise: the newest seeded date is PAST the cut warm-up floor, or "keys present" pins nothing.
    expect([exp.r7DropAmber, exp.r7DropRed, exp.r7SteepAmber, exp.r7SteepRed].every(Number.isFinite)).toBe(true);
    expect(newest.bandCuts).toEqual({
      r7DropAmber: exp.r7DropAmber,
      r7DropRed: exp.r7DropRed,
      r7SteepAmber: exp.r7SteepAmber,
      r7SteepRed: exp.r7SteepRed,
    });
    expect(newest.bullLegs).toEqual({ drop: exp.drop, steep: exp.steep });
    expect(newest.gates!.shortEndDriven).toBe(exp.gate);
  });

  test("missing leg rows (P1.2): 200 + unchanged headers, stored passthrough, ONE warn per leg across two reads", async () => {
    const s = await seedR7(false); // R7 rows only — the three input ids are ABSENT from the store
    const warn = vi.fn();
    const res = await withStore(s, () => GET(new Request("https://x/api/series?id=R7"), { warn }));
    await withStore(s, () => GET(new Request("https://x/api/series?id=R7"), { warn })); // 2nd read: warn dedupes
    for (const legId of Object.keys(r7Inputs)) {
      expect(warn.mock.calls.filter((c) => String(c[0]).includes(legId)).length, legId).toBe(1);
    }
    const status = res.status;
    const missingHeaders = headersOf(res);
    const body = (await res.json()) as SeriesResponse;
    const healthy = await withStore(await seedR7(), () => GET(new Request("https://x/api/series?id=R7")));
    expect(missingHeaders).toEqual(headersOf(healthy)); // never no-store/503 on the missing-row path
    expect(status).toBe(200);
    expect(body.points.length).toBe(r7Rows.length);
    const seeded = new Map(r7Rows.map((r) => [r.date, r.state]));
    for (const p of body.points) {
      expect(p.state).toBe(seeded.get(p.date));
      expect(p.bullLegs).toBeUndefined();
      expect(p.bandCuts?.r7DropAmber).toBeUndefined();
    }
    // Vacuity: the seeded ribbon spans states, so "verbatim" is exercised across values.
    expect(new Set(r7Rows.map((r) => r.state)).size).toBeGreaterThan(1);
  });
});


describe("GET /api/series - F6/F8 stored decision + state passthrough", () => {
  test.each(["F6", "F8"])(
    "%s echoes stored decision AND stored state per point (no on-read re-score)",
    async (id) => {
      const stored = await store.getSeries(id, 365);
      const { status, body } = await serve(id);
      expect(status).toBe(200);
      // Verbatim passthrough: value/delta20/rawState/state/decision all match the store,
      // point-for-point. The deleted bespoke branch would have overwritten state (via a
      // double-divided F6 re-score) and never emitted `decision`.
      expect(body.points).toEqual(stored.map(({ bandCuts: _s, runAt: _r, ...rest }) => rest));
      // The stored decision reached the wire as a real number (Stage-1 column served through,
      // not recomputed) — toEqual(stored) alone wouldn't catch a shared null.
      expect(body.points.every((p) => typeof p.decision === "number")).toBe(true);
      // The ribbon is non-constant, so the echo is exercised across real transitions.
      expect(new Set(body.points.map((p) => p.state)).size).toBeGreaterThan(1);
    },
  );
});


describe("GET /api/series - Case 4 gate flags (F4)", () => {
  test("emits own + cross-series MA gates where covered; passthrough stays verbatim", async () => {
    const { status, body } = await serve("F4");
    expect(status).toBe(200);
    expect(body.points).toHaveLength(GATE_N);
    // Below full MA coverage (< MA_WIN−1 within the fetched window) no key is emitted.
    expect(body.points[0]!.gates).toBeUndefined();
    // Flat region with full coverage: value == MA (own) and NVDA == MA ⇒ both false.
    const flat = body.points[MA_WIN + 10]!;
    expect(flat.gates).toEqual({ smhBelowMA200: false, nvdaBelowMA200: false });
    // After the drop: SMH deep under its MA ⇒ own gate true; NVDA still flat ⇒ false.
    const last = body.points.at(-1)!;
    expect(last.gates).toEqual({ smhBelowMA200: true, nvdaBelowMA200: false });
    // Gates are ADDITIVE: state/decision are the stored values, untouched (Case 2 invariant).
    expect(last.state).toBe("GREEN");
    expect(last.decision).toBe(-0.1);
  });

  test("cross gate runs over the date-INTERSECTION calendar: aux-only pre-history never shifts the MA or emits early cross-only flags", async () => {
    const { body } = await serve("F4");
    // Own-uncovered head: NO gates object at all. The cross flag runs over the F4∩NVDA
    // calendar, so it is exactly as (un)covered as the own flag; an own-calendar recompute
    // would instead emit a resolved — and WRONG (100 < the 1e6-inflated MA ⇒ true) —
    // cross-only flag here. The renderer side of that shape (a point carrying only the
    // cross flag must not dim) is pinned in generic-detail-chart.test.js.
    for (const p of body.points.slice(0, MA_WIN - 1)) expect(p.gates, `@${p.date}`).toBeUndefined();
    // First covered point onward both flags resolve, and NVDA's flat-100 window reads
    // false — the 1e6 rows (dates F4 lacks) are excluded, matching the scorer's gate.
    expect(body.points[MA_WIN - 1]!.gates).toEqual({ smhBelowMA200: false, nvdaBelowMA200: false });
  });

  test("left-edge fidelity: a short limit still resolves gates via the window pad", async () => {
    const res = await GET(new Request("https://x/api/series?id=F4&limit=20"));
    const body = (await res.json()) as SeriesResponse;
    expect(body.points).toHaveLength(20);
    // Every visible point sits in the dropped tail with a fully padded MA window.
    for (const p of body.points) expect(p.gates?.smhBelowMA200, `@${p.date}`).toBe(true);
  });

  test("an unrecognised query param is a 400 no-store (S-1)", async () => {
    // Rejected BEFORE the id/store read — `?cb=` can no longer mint a MISS with a full re-score behind it.
    const rej = await GET(new Request("https://x/api/series?id=F4&limit=20&cb=1"));
    expect(rej.status).toBe(400);
    expect(rej.headers.get("Cache-Control")).toBe("no-store");
  });
});


describe("GET /api/series - Case 4 gate flags, atOrAboveCut rule (DISP)", () => {
  test("resolves both arms' cut gates per point, inclusive at the edge, off the stored VALUE", async () => {
    const { status, body } = await serve("DISP");
    expect(status).toBe(200);
    expect(body.points).toHaveLength(DISP_ROWS.length);
    // The injected multiplier is non-1.0 — at 1.0 earlierCut is the identity, and the
    // mutation-1 witness rows silently stop distinguishing anything.
    expect(DISP_MULT).not.toBe(1);
    // Cut gates have NO lookback, so unlike the F4 MA gates every point — including the
    // first — carries both flags. A missing key here is mutation 4.
    expect(body.points.map((p) => [p.value, p.gates?.corrAtOrAboveCut])).toEqual(
      DISP_ROWS.map((r) => [r.corr, r.on]),
    );
    // Additive: the drawn decision leg reaches the wire untouched (Case-2 invariant).
    expect(body.points.map((p) => p.decision)).toEqual(DISP_ROWS.map((r) => r.basket));
  });

  // Change 2 (2026-07-22 DISP eyeball): the ribbon state/rawState are RE-SCORED on read
  // through today's dispersionState + confirm buffer, so the AMBER tier surfaces and the
  // stale binary states each row was written under are overwritten. Prod's DISP history
  // predates the AMBER tier — this is the read-path fix that makes it appear.
  test("re-scores state/rawState on read: overwrites stored GREEN, surfaces AMBER", async () => {
    const { body } = await serve("DISP");
    // The injected DISP multiplier is live (cut 0.675), so the corr-confirm gate opens for the 0.7/0.75
    // rows: their shallow baskets score AMBER, the deep-basket 0.95 row scores RED, and the
    // gate-off / >= -edge rows stay GREEN. Out-of-band literal (hand-computed from the fixture),
    // NOT derived through dispersionState — so a wrong cut or a dropped re-score goes red.
    const expectedRaw = ["GREEN", "GREEN", "GREEN", "AMBER", "AMBER", "RED"] as const;
    expect(body.points.map((p) => p.rawState)).toEqual([...expectedRaw]);
    // The confirmed ribbon folds those raws DIRECTIONALLY at DISP's down buffer (`confirmClosesFor`
    // = 2, the same source the live `dispersionReadingSeries` → `buildReadings` fold reads): this
    // fixture only ESCALATES, and escalation confirms same-day (asym fold, [USER] 2026-08-26), so
    // the ribbon must equal the raw row exactly. Pinned against the out-of-band literal, NOT a
    // re-fold of the same array: a regression to the SYMMETRIC 2-close fold lags the AMBER onset
    // and the RED and goes red on the equality below.
    expect(confirmClosesFor("DISP")).toBe(2);
    expect(body.points.map((p) => p.state)).toEqual([...expectedRaw]);
    // ...and the buffered fold really WOULD differ, so the equality above is not vacuous.
    expect(confirmedStateSeries([...expectedRaw], 2)).not.toEqual([...expectedRaw]);
    // Non-vacuity guards: the re-score actually changed the stored all-GREEN states, and the
    // AMBER tier — impossible under the old binary logic — is genuinely present.
    expect(body.points.every((p) => p.state === "GREEN")).toBe(false);
    expect(body.points.some((p) => p.state === "AMBER")).toBe(true);
    // A known corr+basket pair maps to AMBER end-to-end: row 3 (corr 0.7 > cut, basket ∈
    // [DISP_BASKET_RED, 0)) is raw AMBER.
    expect([body.points[3]!.value, body.points[3]!.decision]).toEqual([0.7, AMBER_BASKET]);
    expect(body.points[3]!.rawState).toBe("AMBER");
  });
});


describe("GET /api/series - DISP B2 deepener re-scored on read (2026-09-08)", () => {
  // The read path owes the cron's OWN rolling p90: same masked corr array, and a lookback pad so the
  // p90 is settled at the visible left edge. This fixture sits ON the warm-up boundary, so it fails
  // both if the deepener is missing AND if the forced-0 (degenerate) rows are counted as observations.
  const ZEROS = 5; // corr exactly 0 = the scorer's degenerate-day sentinel; masked OUT of the p90
  const dispDate = (i: number) => new Date(Date.UTC(2010, 0, 4) + i * 86_400_000).toISOString().slice(0, 10);
  const SHALLOW = DISP_BASKET_RED / 2; // ∈ [DISP_BASKET_RED, 0) ⇒ base tier AMBER
  // ZEROS sentinels, then exactly DISP_CORR_P_MIN_OBS − 1 real observations, then TWO high-corr days:
  // masked, the first is still one observation short (NaN cut ⇒ AMBER) and the second is settled (RED).
  const REALS = DISP_CORR_P_MIN_OBS - 1;
  const CORRS = [
    ...Array.from({ length: ZEROS }, () => 0),
    ...Array.from({ length: REALS }, (_, i) => 0.7 + 0.0008 * (i % 250)),
    0.99,
    0.99,
  ];
  const seedDisp = async (): Promise<InMemoryStore> => {
    const s = new InMemoryStore();
    await s.recordReadings(
      CORRS.map((corr, i) => ({
        date: dispDate(i),
        indicatorId: "DISP",
        value: corr,
        delta20: 0,
        rawState: "GREEN" as const,
        state: "GREEN" as const,
        decision: SHALLOW,
      })),
      RUN_AT,
    );
    return s;
  };

  test("the deepener fires on read at the warm-up boundary, and forced-0 rows are NOT observations", async () => {
    const body = await withStore(await seedDisp(), async () =>
      JSON.parse(await (await GET(new Request("https://x/api/series?id=DISP"))).text()) as SeriesResponse,
    );
    expect(body.points).toHaveLength(CORRS.length);
    const last = body.points.at(-1)!;
    const penultimate = body.points.at(-2)!;
    expect([penultimate.value, last.value]).toEqual([0.99, 0.99]); // same inputs, same basket
    // ONE observation short ⇒ NaN cut ⇒ NO-OP deepener; one day later the cut is settled and the SAME
    // corr/basket pair deepens. Counting the ZEROS as observations would fire both rows RED.
    expect(penultimate.rawState).toBe("AMBER");
    expect(last.rawState).toBe("RED");
    // The 0-corr sentinel rows are GREEN in their own right (below the confirm gate) — non-vacuity for
    // the mask: they are in the served window, so a mask regression has somewhere to go wrong.
    expect(body.points.slice(0, ZEROS).map((p) => p.rawState)).toEqual(Array.from({ length: ZEROS }, () => "GREEN"));
    // Every real row below the p90 keeps its base AMBER tier — the deepener is not a blanket lift.
    expect(body.points.slice(ZEROS, ZEROS + REALS).some((p) => p.rawState === "AMBER")).toBe(true);
  });

  test("the lookback pad settles the p90 at the VISIBLE left edge (limit far shorter than the window)", async () => {
    const body = await withStore(await seedDisp(), async () =>
      JSON.parse(await (await GET(new Request("https://x/api/series?id=DISP&detail=1&limit=2"))).text()) as SeriesResponse,
    );
    // Only 2 points are served, but they are scored against the p90 of the padded history behind them:
    // without the pad both would see a NaN cut and come back AMBER.
    expect(body.points).toHaveLength(2);
    expect(body.points.map((p) => p.rawState)).toEqual(["AMBER", "RED"]);
    expect(DISP_CORR_P_WINDOW).toBeGreaterThan(2); // the pad is doing real work at this limit
    // Stage 2 (2026-09-09): the deepener cut travels onto the wire as `corrP90`, drawn as its own
    // line. It must survive the `padded.slice(-limit)` correctly aligned: the RED row carries the
    // finite settled cut it scored against (its 0.99 corr is AT/above it), while the AMBER row's
    // warm-up NaN cut is left OFF the wire (a gap, never 0). A misaligned or dropped write reds here.
    const [amberPt, redPt] = body.points;
    expect(redPt!.corrP90).toBeGreaterThan(0); // finite settled cut on the RED (deepened) row
    expect(redPt!.value).toBeGreaterThanOrEqual(redPt!.corrP90!); // it is the cut the RED was scored against
    expect(amberPt!.corrP90).toBeUndefined(); // warm-up NaN ⇒ omitted, so the line gaps
  });
});

describe("GET /api/series - PENSION legs", () => {
  test("a held-fund leg carries ONE series-level proxy {source, until}; a non-leg id carries none", async () => {
    expect((await serve("LEGP_SEMIS")).body.proxy).toEqual({ source: "SMH", until: "2021-08-06" });
    const exus = (await serve("LEGP_EXUS")).body;
    expect(exus.proxy).toEqual({ source: "VEA", until: "2025-03-03" });
    expect(exus.points.some((p) => "proxy" in p), "never per-point flags").toBe(false);
    expect((await serve("F1")).body).not.toHaveProperty("proxy");
  });
});


describe("GET /api/series - PENSION serves the stored values (window-invariant)", () => {
  // 22 closes stepping +4 from 400; stored delta20 latest = (400+21·4) − (400+1·4) = 80.
  const RAW22 = ramp(400, 4, 22);
  const unitOf = (id: string) => ALL_INDICATORS.find((i) => i.id === id)!.unit;

  test("two from= windows serve the identical stored € for a shared date, in indicator.unit", async () => {
    const s = await seedPension("XDEV", RAW22);
    const d = (i: number) => RAW22[i]!.date;
    const wide = await servePension(s, `id=XDEV&from=${d(0)}&to=${d(5)}`);
    const narrow = await servePension(s, `id=XDEV&from=${d(4)}&to=${d(5)}`); // d(4) is this window's first point
    const at = (b: SeriesResponse, date: string) => b.points.find((p) => p.date === date)!.value;
    expect(at(narrow, d(4))).toBe(at(wide, d(4)));
    expect(at(narrow, d(4))).toBe(RAW22[4]!.value); // 416, no 100 anchor
    expect(unitOf("XDEV")).toBe("€");
    expect(wide.unit).toBe(unitOf("XDEV"));
    expect(narrow.unit).toBe(unitOf("XDEV"));
  });

  test("delta20 is the stored delta, unscaled", async () => {
    const body = await servePension(await seedPension("XDEV", RAW22), "id=XDEV");
    expect(body.points.at(-1)!.delta20).toBeCloseTo(80, 10);
  });

  test("KBE's worstDrop decision is stamped on read and equals the probe's worstDrop — not highDist", async () => {
    // Peak 140 at index 10, trough 98 at index 15 (−30%), then a bounce to 126: highDist would read 126/140 − 1 = −10%.
    const vals = [...Array.from({ length: 11 }, (_, i) => 100 + 4 * i), 130, 120, 110, 100, 98, 105, 112, 118, 122, 124, 126];
    const obs = RAW22.map((o, i) => ({ ...o, value: vals[i]! }));
    const body = await servePension(await seedPension("KBE", obs), "id=KBE");
    expect(body.valueOnly, "KBE's stored GREEN is a placeholder — the ribbon must neutralize").toBe(true);
    const decisions = body.points.map((p) => p.decision);
    expect(decisions.slice(0, KBE_WORST_DROP.window - 1).every((d) => d === null), "gap until a full window").toBe(true);
    const probe = worstDrop(obs.map(({ date, value }) => ({ date, value })), KBE_WORST_DROP.window)!.dd;
    expect(decisions.at(-1)).toBeCloseTo(probe, 12);
    expect(probe).toBeCloseTo(98 / 140 - 1, 12);
    expect(decisions.at(-1)).not.toBeCloseTo(126 / 140 - 1, 6);
    const vwo = await servePension(await seedPension("VWO", obs), "id=VWO");
    expect(vwo.points.every((p) => p.decision == null), "a PENSION row with no `derived` stays decision-less").toBe(true);
  });

  test("CCC (FRED, %) and VGK (vendor, unitless) both serve stored values in their own unit", async () => {
    for (const id of ["CCC", "VGK"]) {
      const body = await servePension(await seedPension(id, RAW22), `id=${id}`);
      expect(body.unit).toBe(unitOf(id));
      expect(body.points[0]!.value).toBe(RAW22[0]!.value);
    }
  });
});


describe("GET /api/series - VTP chart-only streak history", () => {
  test("serves the stored streak series: 200, > 1 row, spanning the seeded dates", async () => {
    const { status, body } = await serve("VTP");

    expect(status).toBe(200); // 400 here = the id fell out of META and the history is unreachable
    expect(body.indicatorId).toBe("VTP");
    expect(body.label).toBe(VTP_IND.label); // reconstructed from META, not the bare id
    expect(body.points.length).toBe(vtpDates.length);
    expect(body.points.at(0)!.date).toBe(vtpDates.at(0));
    expect(body.points.at(-1)!.date).toBe(vtpDates.at(-1));
  });

  test("the served points carry the per-day streak and its state ribbon", async () => {
    const { body } = await serve("VTP");
    // The run starts at index 18, so the last point's streak is 12 (RED) while index 17 is 0
    // (GREEN) — a passthrough that dropped the streak or flattened the ribbon fails here.
    expect(body.points.at(-1)!.value).toBe(12);
    expect(body.points.at(-1)!.state).toBe("RED");
    expect(body.points[17]!.value).toBe(0);
    expect(body.points[17]!.state).toBe("GREEN");
    // Streak-banded state IS the confirmation — served un-refolded, so no "N-close confirm" legend.
    expect(body.confirmCloses).toBeUndefined();
  });

  test.each(["FDX", "HCX"])("%s (chart-only but folded via ratioReadingSeries) keeps its confirm legend", async (id) => {
    const { body } = await serve(id);
    expect(body.confirmCloses).toBe(confirmClosesFor(id));
  });
});


// --- from/to date-range slicing (E3 Stage 2.1 — replay companion-chart data path) ---
// SPY fixture spans 2024-04-01..2026-01-01 (22 monthly month-start points, seeded by `seedSharedStore`
// in `src/api-series.test-helpers.ts`). from/to must be month-start (P5, `parseRange`).
describe("GET /api/series - from/to range", () => {
  const serveRaw = async (qs: string): Promise<{ status: number; body: SeriesResponse }> => {
    const res = await GET(new Request(`https://x/api/series?${qs}`));
    return { status: res.status, body: (await res.json()) as SeriesResponse };
  };

  test("slices inclusively to [from, to]", async () => {
    const { status, body } = await serveRaw("id=SPY&from=2024-06-01&to=2024-11-01");
    expect(status).toBe(200);
    expect(body.points.map((p) => p.date)).toEqual([
      "2024-06-01",
      "2024-07-01",
      "2024-08-01",
      "2024-09-01",
      "2024-10-01",
      "2024-11-01",
    ]);
  });

  test("either bound alone works", async () => {
    const fromOnly = await serveRaw("id=SPY&from=2025-11-01");
    expect(fromOnly.body.points.map((p) => p.date)).toEqual(["2025-11-01", "2025-12-01", "2026-01-01"]);
    const toOnly = await serveRaw("id=SPY&to=2024-06-01");
    expect(toOnly.body.points.map((p) => p.date)).toEqual(["2024-04-01", "2024-05-01", "2024-06-01"]);
  });

  test("range before stored history is an honest empty payload, not a 400", async () => {
    const { status, body } = await serveRaw("id=SPY&from=2020-01-01&to=2020-12-01");
    expect(status).toBe(200);
    expect(body.points).toEqual([]);
    expect(body.indicatorId).toBe("SPY"); // envelope intact so the client can note "history starts …"
  });

  // P5: from/to are CLOSED to the month grid — a within-month bound is a 400 no-store (never
  // snapped). Both live callers (public/month-grid.js) snap before emitting, so a shipped URL never
  // reaches these branches.
  test.each([
    { qs: "from=2026-1-5", grid: false },
    { qs: "to=notadate", grid: false },
    { qs: "from=2026-13-40", grid: false },
    { qs: "from=2024-06-15", grid: true },
    { qs: "to=2024-06-15", grid: true },
    { qs: "from=2024-06-01&to=2024-11-30", grid: true },
  ])("$qs ⇒ 400 (no-store when off the month grid: $grid)", async ({ qs, grid }) => {
    const res = await GET(new Request(`https://x/api/series?id=SPY&${qs}`));
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control") === "no-store").toBe(grid);
  });

  test("probe shape (`to` + limit=1, no `from`): the store is asked for ≤ limit rows, rows unchanged", async () => {
    // The /lab eligibility burst fires ~43 of these; the passthrough must push the client
    // `limit` into the range-anchored store query instead of fetching MAX_LIMIT=4000 rows
    // per boolean. The store applies the range BEFORE its desc cap, so the served rows are
    // identical to the old fetch-4000-then-slice(-limit).
    // A recording view of the shared store: `getSeries` calls are logged, then forwarded.
    const calls: Parameters<Store["getSeries"]>[] = [];
    const recording = new Proxy(store, {
      get: (target, key, receiver) =>
        key === "getSeries"
          ? (...args: Parameters<Store["getSeries"]>) => {
              calls.push(args);
              return target.getSeries(...args);
            }
          : Reflect.get(target, key, receiver),
    });
    await withStore(recording, async () => {
      const hit = await serveRaw("id=SPY&to=2024-08-01&limit=1");
      expect(hit.status).toBe(200);
      // latest row on-or-before `to` — same row the old deep-fetch + slice(-1) served
      expect(hit.body.points.map((p) => p.date)).toEqual(["2024-08-01"]);

      const empty = await serveRaw("id=SPY&to=2015-01-01&limit=1");
      expect(empty.status).toBe(200);
      expect(empty.body.points).toEqual([]); // range before history: honest empty, unchanged

      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call[1], "store fetch capped at the client limit").toBeLessThanOrEqual(1);
        expect(call[2]).toEqual({ from: null, to: expect.any(String) }); // range pushed into the query
      }
    });
  });

  test("explicit limit applies AFTER the slice: latest-N within the window", async () => {
    const { body } = await serveRaw("id=SPY&from=2025-08-01&limit=3");
    // Window is 2025-08-01..end (6 pts); limit=3 keeps the latest 3 of those.
    expect(body.points.map((p) => p.date)).toEqual(["2025-11-01", "2025-12-01", "2026-01-01"]);
  });
});

describe("GET /api/series - legBounds envelope (caption redesign #7)", () => {
  it("recompute branch carries legBounds keyed by scorerLegs, valued off the resolved cuts; absent otherwise", async () => {
    const body = await serveDetail("F1", 40);
    // Present exactly beside `scorerLegs`, keys identical (both in LEG_ORDER).
    expect(body.legBounds).toBeDefined();
    expect(Object.keys(body.legBounds!)).toEqual(body.scorerLegs);
    // Values are the SAME resolved cuts the scorer tests: F1 resolves no calibration row, so both
    // legs carry the registry pairs — read off the constant, never restated as literals.
    expect(body.legBounds).toEqual({
      op: { amber: F1.thresholds.amberLevel!, red: F1.thresholds.redLevel! },
      "vel-op": { amber: F1.thresholds.amberVelocity!, red: F1.thresholds.redVelocity! },
    });
    // Non-recompute payload: absent, exactly like `scorerLegs`.
    const paramless = await serve("F1");
    expect(paramless.body.legBounds).toBeUndefined();
  });

  it("velocity-σ legs with no plotted-axis image serve null bounds, the legs staying present (F9)", async () => {
    // F9's σ-convention pair backs `vel-z` in σ MULTIPLES and its CUSUM limits live on the
    // accumulator axis — neither has an image on the plotted Δ60 axis here (F9's z is a
    // ROLLING-σ standardization; no `fx/dtwexbgs` velZref row exists to invert through), so the
    // contract serves every severity null rather than a number the client's Δ-axis formatter
    // would print as a wrong value with a wrong above/below-plot side note.
    const body = await serveDetail("F9", 40);
    expect(body.scorerLegs).toEqual(["vel-z", "vel-cusum"]);
    expect(body.legBounds).toEqual({
      "vel-z": { amber: null, red: null },
      "vel-cusum": { amber: null, red: null },
    });
  });

  it("a measured vel-z cut is served velZref-INVERTED into Δ-axis units, never as a σ multiple (R2)", async () => {
    // Publish a σ-cut + reference distribution for R2 (prefix dgs10, no `velocitySigma`, so the
    // units gate stays quiet and the measured `zscore_*` rows land on the `vel-z` leg).
    await store.recordCalibration([
      calibRow("dgs10_zscore_amber", 1.5),
      calibRow("dgs10_zscore_red", 2.5),
      calibRow("dgs10_zref_mean", 0.02),
      calibRow("dgs10_zref_std", 0.05),
    ]);
    // Expectations from the SAME resolved cuts the handler reads — never a restated literal.
    const cuts = resolveCuts("R2", await store.getCalibration(), "HIGH");
    // Vacuity floor: the leg must actually resolve a cut and a usable zref, or the equality
    // below degenerates to null === null.
    expect(cuts.velZAmber).toBeDefined();
    expect(cuts.velZRed).toBeDefined();
    expect(cuts.velZrefStd).toBeGreaterThan(0);
    const body = await serveDetail("R2", 40);
    expect(body.scorerLegs).toContain("vel-z");
    // Sign is always + on the velocity axis (HIGH polarity), mirroring `effectiveCuts`.
    expect(body.legBounds!["vel-z"]).toEqual({
      amber: cuts.velZrefMean! + cuts.velZAmber! * cuts.velZrefStd!,
      red: cuts.velZrefMean! + cuts.velZRed! * cuts.velZrefStd!,
    });
  });
});

describe("GET /api/series - a failed side read degrades, warned with the id", () => {
  class SideReadsDown extends InMemoryStore {
    override async getCalibration(): Promise<never> {
      throw new Error("calibration down (fixture)");
    }
    override async getSeriesBulk(): Promise<never> {
      throw new Error("bulk down (fixture)");
    }
    override async getSeries(id: string, limit: number, range?: Parameters<InMemoryStore["getSeries"]>[2]) {
      if (id === "F7" || id === "NVDA") throw new Error(`${id} down (fixture)`);
      return super.getSeries(id, limit, range);
    }
  }
  test.each([
    ["F1&detail=1", "[series] F1 calibration read failed - re-scoring on convention cuts:"],
    ["FXH", "[series] FXH haven-leg read failed - serving the stored series, no havenLegs:"],
    ["ECY", "[series] ECY F7/DFII10 join read failed - no derived cut:"],
    ["F4", "[series] F4 gate source NVDA read failed - gate key omitted:"],
  ])("?id=%s → 200 + one warn", async (qs, message) => {
    const warned: unknown[][] = [];
    const res = await withStore(new SideReadsDown(), () =>
      GET(new Request(`https://x/api/series?id=${qs}`), { warn: (...args) => void warned.push(args) }),
    );
    expect(res.status).toBe(200);
    expect(warned.map((c) => String(c[0]))).toEqual([message]);
  });
});

// ai-debt sweep 5.3 characterization: pins `handle`'s branch dispatch (which builder wins, which
// reads it issues, what reaches the wire) across every branch arm, so the `resolveBranchPoints`
// extraction can be checked byte-identical. Points ride as a sha256 (a full body would bloat the
// snapshot); `reads` logs every store call in order, so a reordered or dropped branch read reds too.
describe("GET /api/series - branch dispatch characterization (sweep 5.3)", () => {
  const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
  const logged = (s: Store, reads: string[]): Store =>
    new Proxy(s, {
      get(t, k) {
        const v = Reflect.get(t, k, t) as unknown;
        if (typeof v !== "function") return v;
        return (...a: unknown[]) => {
          reads.push(`${String(k)}(${JSON.stringify(a)})`);
          return (v as (...x: unknown[]) => unknown).apply(t, a);
        };
      },
    });
  const QUERIES = [
    "id=R2", // store passthrough
    "id=R2&from=1900-01-01&limit=10", // passthrough, range pushed into the store
    "id=R2&detail=1&limit=40", // recompute
    "id=R2&detail=1&from=1900-01-01&to=2100-01-01&limit=30", // recompute, deep fetch on a `to` window
    "id=R2&detail=1&limit=40&mult=1", // recompute + echoed mult
    "id=F1&detail=1&limit=40", // recompute + scorerLegs/legBounds
    "id=F9&detail=1&limit=60", // recompute + σ overlay
    "id=FXH", // fxHaven
    "id=F4", // gated
    "id=F4&detail=1&limit=20", // gated (F4 is `derived` — no recompute)
    "id=F6", // passthrough + stored decision
    "id=F8", // gated
    "id=DISP", // dispersion (excluded from gated)
    "id=SPY", // PENSION derived decision on read
    "id=DB_SMH", // downside (no rows seeded)
    "id=ECY", // ecyJoin (no rows seeded)
    "id=CG", // per-point band cuts (no rows seeded)
  ];
  const digest = async (s: Store, qs: string) => {
    const reads: string[] = [];
    const warns: string[] = [];
    const res = await withStore(logged(s, reads), () =>
      GET(new Request(`https://x/api/series?${qs}`), { warn: (...a) => void warns.push(String(a[0])) }),
    );
    const { points, ...rest } = (await res.json()) as SeriesResponse;
    return { qs, status: res.status, rest: sha(rest), keys: Object.keys(rest), n: points.length, points: sha(points), reads, warns };
  };

  test("every branch arm's wire body + store reads are pinned", async () => {
    const out = [];
    for (const qs of QUERIES) out.push(await digest(store, qs));
    out.push(await digest(await seedR7(), "id=R7")); // bullSteepener
    expect(out).toMatchSnapshot();
  });
});
