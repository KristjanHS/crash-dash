/**
 * backfill suite — the pure POLICY describes (split 2026-09-05 from backfill.test.ts): probe
 * depth (a >2000-point series is fully probed under DEEP_PROBE, and the default 2000 probe
 * demonstrably misses the oldest date — the §4.5 bug the deep probe fixes), `isoCutoff` /
 * `specCutoff`, `planFetch` (pure full/skip/since branches), the common backfill window
 * (floor/override-depth rows), the shared sovereign-quote spread-leg depth, and the no-waste
 * depth proofs (CG/HCX plan-independence + the skip proof). Shared fixtures + the memoized
 * virgin run: backfill.test-helpers.ts. Job runs → backfill.jobs.test.ts; restate/reshadow →
 * backfill.restate.test.ts.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { ALL_INDICATORS } from "../src/registry.js";
import { CHART_ONLY_INDICATORS } from "../src/registry-composite.js";
import type { Observation } from "../src/domain-types.js";
import { bundLegHead, cgLookbackDays, readPathHeadRows } from "../src/scorers-composite.js";
import { CG_DESCRIPTOR, HCX_SYMBOLS } from "../src/family-descriptor-rows.js";
import { backfillHistory, wallClock } from "../src/run-seeds.js";
import { InMemoryStore } from "../src/store-memory.js";
import { DFII10_ORIGIN, EUFIN_BACKFILL_YEARS } from "../src/backfill-depth.js";
import {
  BACKFILL_YEARS,
  DEEP_PROBE,
  BACKFILL_FLOOR,
  BACKFILL_FLOOR_WARMUP_DAYS,
  BACKFILL_WINDOW,
  CHART_SPAN_DAYS,
  backfillFloorsFor,
  backfillDepthFor,
  backfillFloorBound,
  probeFor,
  backfillSinceDate,
  chartSpanBound,
  backfillTrimYears,
  resolveBackfillSince,
  FRESH_MARGIN_DAYS,
  RAW_WARMUP_DAYS,
  REVISION_TAIL_DAYS,
  SCORED_WARMUP_DAYS,
  backfillAll,
  isoCutoff,
  isoDaysBefore,
  planFetch,
  specCutoff,
  headLedSince,
  SPEC_CUTOFF_SLACK_DAYS,
  tradingToCalendarDays,
  type BackfillDeps,
} from "./backfill.js";
import { AT1_BACKFILL_YEARS, AT1_INCEPTION, BONOS_BACKFILL_YEARS, ESTR_BACKFILL_YEARS, EURGBP_BACKFILL_YEARS, EXSH_GATE_BACKFILL_YEARS } from "../src/backfill-depth.js";
import { N, PROBE_IND, obsSeries, opts, readingSeries, seedRow, sharedVirginRun, stub } from "./backfill.test-helpers.js";

let recSovereignFrom: Map<string, string>;
let recSovereignCalls: Map<string, number>;

beforeAll(async () => {
  ({ recSovereignFrom, recSovereignCalls } = await sharedVirginRun());
});

describe("backfillHistory probe depth", () => {
  it("DEEP_PROBE fully probes a >2000-point series so a re-run inserts zero", async () => {
    const store = new InMemoryStore();
    const series = readingSeries(2001);
    expect(await backfillHistory(store, PROBE_IND.id, series, DEEP_PROBE, wallClock)).toBe(2001);
    expect(await backfillHistory(store, PROBE_IND.id, series, DEEP_PROBE, wallClock)).toBe(0);
  });

  it("re-inserts existing dates whose stored decision is null once the series carries one", async () => {
    const store = new InMemoryStore();
    let t = 0;
    const clock = () => new Date(1700000000000 + ++t * 1000).toISOString(); // strictly increasing run_at
    const bare = readingSeries(10); // no decision — the pre-migration vintage
    expect(await backfillHistory(store, PROBE_IND.id, bare, DEEP_PROBE, clock)).toBe(10);
    const withDecision = bare.map((r) => ({ ...r, decision: r.level * 2 }));
    expect(await backfillHistory(store, PROBE_IND.id, withDecision, DEEP_PROBE, clock)).toBe(10); // repair pass
    expect(await backfillHistory(store, PROBE_IND.id, withDecision, DEEP_PROBE, clock)).toBe(0); // idempotent after repair
    const pts = await store.getSeries(PROBE_IND.id, 20);
    expect(pts).toHaveLength(10); // vintage shadow, not duplicate dates
    expect(pts.every((p) => p.decision != null)).toBe(true);
  });

  it("the default 2000 probe misses the oldest date of a 2001-point series", async () => {
    const store = new InMemoryStore();
    const series = readingSeries(2001);
    expect(await backfillHistory(store, PROBE_IND.id, series, 2000, wallClock)).toBe(2001); // first run: probe empty
    // re-run with the shallow probe: getSeries(id, 2000) returns the most-recent
    // 2000 dates, so the single oldest date looks "missing" and re-inserts — the
    // duplicate-row bug DEEP_PROBE prevents.
    expect(await backfillHistory(store, PROBE_IND.id, series, 2000, wallClock)).toBe(1);
  });

  it("carries Reading.bandCuts into the stored row; an absent cut writes an explicit null", async () => {
    const store = new InMemoryStore();
    const [withCut, withoutCut] = readingSeries(2);
    const cuts = { levelAmber: 1.5 };
    expect(await backfillHistory(store, PROBE_IND.id, [{ ...withCut!, bandCuts: cuts }, withoutCut!], DEEP_PROBE, wallClock)).toBe(2);
    const byDate = new Map(store.readings.map((r) => [r.date, r]));
    expect(byDate.get(withCut!.date)?.bandCuts).toEqual(cuts);
    expect(byDate.get(withoutCut!.date)?.bandCuts).toBeNull(); // toRow's `?? null`, same as readingRow
  });
});

describe("isoCutoff", () => {
  it("subtracts whole years and returns a YYYY-MM-DD date", () => {
    expect(isoCutoff(new Date("2026-06-28T12:00:00Z"), 15)).toBe("2011-06-28");
  });
});

// specCutoff pushes the central reading-trim back by the read path's head so an id api/series.ts
// re-scores (CG) stores that head too. Every number DERIVES from readPathHeadRows / the exported
// conversion — the test restates no 510/480/331/252 (an
// `indicator-loop.md` §A retune is a ONE-place edit).
describe("specCutoff", () => {
  const NOW = new Date("2026-06-28T12:00:00Z");
  const CUTOFF = isoCutoff(NOW, 15); // 2011-06-28

  it("returns the plain cutoff for an id the read path does not re-score (head 0)", () => {
    expect(readPathHeadRows("R1"), "premise: R1 carries no read-path head").toBe(0);
    expect(specCutoff("R1", CUTOFF, NOW)).toBe(CUTOFF);
  });

  it("pushes CG back by its read-path head (trading→calendar) + slack", () => {
    expect(readPathHeadRows("CG"), "premise: CG IS re-scored on read").toBeGreaterThan(0);
    const shift = tradingToCalendarDays(readPathHeadRows("CG")) + SPEC_CUTOFF_SLACK_DAYS;
    expect(specCutoff("CG", CUTOFF, NOW)).toBe(isoDaysBefore(new Date(`${CUTOFF}T00:00:00Z`), shift));
    expect(specCutoff("CG", CUTOFF, NOW) < CUTOFF, "CG's stored edge sits below the plain cutoff").toBe(true);
  });
});

// --- no-waste incremental fetch (§6) -----------------------------------------
// planFetch is the pure core; the three "proof" suites drive the real backfill loop and
// assert the FEED was (or wasn't) called with the shrunk window — each goes red if its
// branch (skip / shrink / re-shadow) is removed from production.
describe("planFetch (pure — full / skip / since branches)", () => {
  const now = new Date("2026-06-01T00:00:00Z");

  it("null maxDate → full (first seed)", () => {
    expect(planFetch(null, RAW_WARMUP_DAYS, now, true)).toEqual({ mode: "full" });
  });

  it("within margin + KNOWN-final (!revises) → skip (0 requests)", () => {
    // age == FRESH_MARGIN_DAYS is the inclusive boundary (age <= freshMargin).
    const fresh = isoDaysBefore(now, FRESH_MARGIN_DAYS);
    expect(planFetch(fresh, RAW_WARMUP_DAYS, now, false)).toEqual({ mode: "skip" });
  });

  it("within margin + revision-prone → re-shadow the tail, window = tail + warmup (never a true skip)", () => {
    const fresh = isoDaysBefore(now, FRESH_MARGIN_DAYS);
    // Scored warmup: the fetch window must clear the scorer lookback, else the re-shadow builds []
    // and is inert (review I1). Goes red if the branch reverts to a bare REVISION_TAIL_DAYS window.
    const lookbackDays = REVISION_TAIL_DAYS + SCORED_WARMUP_DAYS;
    expect(planFetch(fresh, SCORED_WARMUP_DAYS, now, true)).toEqual({
      mode: "since",
      sinceDate: isoDaysBefore(now, lookbackDays),
      lookbackDays,
      reshadowTailDays: REVISION_TAIL_DAYS,
    });
  });

  it("stale + revision-prone → since gap+warmup WITH a re-shadow tail", () => {
    const age = 30;
    const stale = isoDaysBefore(now, age);
    const lookbackDays = age + SCORED_WARMUP_DAYS;
    expect(planFetch(stale, SCORED_WARMUP_DAYS, now, true)).toEqual({
      mode: "since",
      sinceDate: isoDaysBefore(now, lookbackDays),
      lookbackDays,
      reshadowTailDays: REVISION_TAIL_DAYS,
    });
  });

  it("stale + KNOWN-final → since gap+warmup, NO re-shadow tail (contrastive vs revision-prone)", () => {
    const age = 30;
    const stale = isoDaysBefore(now, age);
    const lookbackDays = age + SCORED_WARMUP_DAYS;
    const plan = planFetch(stale, SCORED_WARMUP_DAYS, now, false);
    expect(plan).toMatchObject({ mode: "since", lookbackDays, sinceDate: isoDaysBefore(now, lookbackDays) });
    // The only field distinguishing a KNOWN-final stale plan from a revision-prone one — bites
    // if the `revises ? … : undefined` branch is dropped.
    expect((plan as { reshadowTailDays?: number }).reshadowTailDays).toBeUndefined();
  });
});

// THE COMMON BACKFILL WINDOW (`BACKFILL_WINDOW`, [USER] 2026-08-29).
//
// ⛔ WHAT THESE MUST NOT ASSERT: `backfillSinceDate` ends in `min(depth, floor − lead-in)`, so
// "the resolved bound is at or before the floor" is TRUE BY CONSTRUCTION for every id and every
// depth — the version that shipped first asserted exactly that across an `it.each` roster and
// stayed green with every override replaced by `{ days: 1 }` (2026-08-29 review). The assertions
// below all route a depth THE TEST SUPPLIES through `resolveBackfillSince`, so each one names an
// arm that can lose.
describe("the common backfill window: the floor binds a too-shallow depth", () => {
  const now = new Date("2026-08-29T00:00:00Z");
  const floorBound = backfillFloorBound();

  // THE assertion with teeth, and its own can-fire demo in one: a 30-day depth reaches NEITHER the
  // floor nor the chart span, so the resolver must hand back the deeper of those two rather than the
  // depth. Delete a `min` arm in `resolveBackfillSince` and this fails; the old formulation
  // ("the bound is at or before the floor") passed either way.
  // ⚠ WHICH arm wins moves with the calendar — the floor is a fixed date, the chart span rolls — so
  // the expectation is composed from both, never hand-typed as one of them.
  it("a depth too shallow to reach either bound resolves to the DEEPER bound, not to itself", () => {
    const shallow = { days: 30 } as const;
    const deepest = [floorBound, chartSpanBound(now)].reduce((a, b) => (a < b ? a : b));
    expect(resolveBackfillSince(shallow, now)).toBe(deepest);
    expect(resolveBackfillSince(shallow, now)).not.toBe(isoDaysBefore(now, shallow.days));
  });

  // The contrast arm — without it the resolver could return the floor unconditionally and the test
  // above would still pass, silently clipping every deep override to the floor's ~2 years.
  it("a depth deeper than the floor resolves to ITSELF, not to the floor", () => {
    const deep = { days: 6100 } as const; // fixture: any span far past the floor
    expect(resolveBackfillSince(deep, now)).toBe(isoDaysBefore(now, deep.days));
    expect(resolveBackfillSince(deep, now)).not.toBe(floorBound);
  });

  it("a `since` depth resolves to its own date when deeper, to the deeper bound when not", () => {
    expect(resolveBackfillSince({ since: DFII10_ORIGIN }, now)).toBe(DFII10_ORIGIN);
    const deepest = [floorBound, chartSpanBound(now)].reduce((a, b) => (a < b ? a : b));
    expect(resolveBackfillSince({ since: isoDaysBefore(now, 30) }, now)).toBe(deepest);
  });

  it("the floor bound leads the floor in, so the floor is the first CHARTED date", () => {
    // A bound EQUAL to the floor would store the first row ~20 trading days late for the windowed
    // scorers (`ratioSpreadReadingSeries`); the lead-in is what makes the floor the charted edge.
    expect(floorBound < BACKFILL_FLOOR).toBe(true);
    expect(floorBound).toBe(isoDaysBefore(new Date(`${BACKFILL_FLOOR}T00:00:00Z`), BACKFILL_FLOOR_WARMUP_DAYS));
  });
});

// The per-id registry `backfill` declarations are the whole point of the config, so each is pinned
// to the depth it carries — a deleted declaration silently re-depths its id to the shared default: BUND would lose its EU-Fin 5y span, F3/CG would lose the deep
// expanding-percentile prefix, F7 its warm-up head.
describe("the common backfill window: every override row is the depth its feed needs", () => {
  it.each([
    ["BUND", { years: EUFIN_BACKFILL_YEARS }],
    ["VT", { years: EUFIN_BACKFILL_YEARS }],
    ["F13", { years: EUFIN_BACKFILL_YEARS }],
    ["KBE_RS", { years: EUFIN_BACKFILL_YEARS }],
    ["INS_RS", { years: EUFIN_BACKFILL_YEARS }],
    ["EXSH_GATE", { years: EXSH_GATE_BACKFILL_YEARS }],
    ["GT", { years: EUFIN_BACKFILL_YEARS }],
    ["F3", { years: 15 }],
    ["CG", { years: 15 }],
    ["F7", { years: BACKFILL_YEARS + 1 }],
    ["ESTR", { years: ESTR_BACKFILL_YEARS }],
    ["EURGBP", { years: EURGBP_BACKFILL_YEARS }],
    ["BONOS", { years: BONOS_BACKFILL_YEARS }],
  ])("%s carries its own depth, not the shared default", (id, depth) => {
    expect(backfillDepthFor(id)).toEqual(depth);
    expect(backfillDepthFor(id)).not.toEqual(BACKFILL_WINDOW.depth);
  });

  // EPATH copied EURC's chart-span carve-out and stored ~2y under the [USER] 3y ruling (2026-10-05); EURC
  // itself moved to the default the same day. A shallower-than-default seed must be a pinned row in the
  // table above, never a silent copy.
  it("no id seeds shallower than the shared default unless it is a pinned carve-out", () => {
    const SHALLOW_CARVE_OUTS = new Set<string>();
    const now = new Date("2026-10-05T00:00:00Z");
    const defaultSince = resolveBackfillSince(BACKFILL_WINDOW.depth, now);
    // The chart-span depth (the old carve-out shape) IS shallower: proves the comparison discriminates.
    expect(resolveBackfillSince({ days: CHART_SPAN_DAYS }, now) > defaultSince).toBe(true);
    // Every carve-out still IS shallower: reds on a stale entry.
    for (const id of SHALLOW_CARVE_OUTS) expect(backfillSinceDate(id, now) > defaultSince, id).toBe(true);
    const shallow = [...ALL_INDICATORS, ...CHART_ONLY_INDICATORS].map((i) => i.id).filter(
      (id) => !SHALLOW_CARVE_OUTS.has(id) && backfillSinceDate(id, now) > defaultSince,
    );
    expect(shallow).toEqual([]);
  });

  // Ruled depth floors at their prod seed date; each row reds if that id's depth shrinks past its floor.
  it.each([
    // [USER] eufin top5 C3: ECISS seeds from 2007-01-01 (pre-GFC).
    { id: "ECISS", seed: "2026-09-24", floor: "2007-01-01" },
    // S6.1: EXSH_GATE seeds from 2008-02-01 (EXSH.DE/EXSA.DE closes-feed start).
    { id: "EXSH_GATE", seed: "2026-09-24", floor: "2008-02-01" },
  ])("$id depth reaches the $floor floor at the $seed prod seed", ({ id, seed, floor }) => {
    const since = backfillSinceDate(id, new Date(`${seed}T00:00:00Z`));
    expect(since <= floor, since).toBe(true);
  });

  // btp-bund S3: AT1 seeds from XAT1.DE closes-provider inception (`AT1_INCEPTION`, the one copy of the date); red if
  // its depth shrinks past it. The ONE-YEAR-SHALLOWER arm proves the floor is binding, not slack.
  it("AT1 depth reaches the XAT1.DE inception floor at the 2026-09-24 prod seed, and one year less would not", () => {
    const now = new Date("2026-09-24T00:00:00Z");
    const since = backfillSinceDate("AT1", now);
    expect(since <= AT1_INCEPTION, since).toBe(true);
    const shallower = resolveBackfillSince({ years: AT1_BACKFILL_YEARS - 1 }, now);
    expect(shallower > AT1_INCEPTION, shallower).toBe(true);
  });

  // The DEFAULT arm, asserted on a real indicator rather than a stand-in id: F2 is a plain FRED
  // spec with no override, and it is what `backfillAll` trims at `backfillTrimYears()`.
  it("an indicator with no override takes the shared default depth, and that depth IS the trim", () => {
    expect(backfillDepthFor("F2")).toEqual(BACKFILL_WINDOW.depth);
    expect(backfillTrimYears()).toBe(BACKFILL_YEARS);
  });

  // The §4.5 bound: a span whose weekdays outrun the id's probe strands its oldest dates outside
  // the idempotency probe and re-inserts them on every re-run. Binds EVERY registry-declared depth plus the shared default.
  it("every depth's weekday span stays inside its own probeFor", () => {
    const now = new Date("2026-10-24T00:00:00Z");
    const ids = ["F2", ...ALL_INDICATORS.filter((i) => i.backfill).map((i) => i.id)];
    expect(ids).toContain("R4");
    const over = ids.filter((id) => {
      const floor = backfillFloorsFor(id, isoCutoff(now, backfillTrimYears()), now).trimFloor;
      const days = (now.getTime() - Date.parse(`${floor}T00:00:00Z`)) / 86_400_000;
      return Math.ceil((days * 5) / 7) >= probeFor(floor, now);
    });
    expect(over).toEqual([]);
  });

  // A new id deeper than DEEP_PROBE's span joins this list deliberately, never silently.
  it("probeFor deepens past DEEP_PROBE for R4 alone", () => {
    const now = new Date("2026-10-24T00:00:00Z");
    const deep = ALL_INDICATORS.map((i) => i.id).filter(
      (id) => probeFor(backfillFloorsFor(id, isoCutoff(now, backfillTrimYears()), now).trimFloor, now) > DEEP_PROBE,
    );
    expect(deep).toEqual(["R4"]);
  });
});

// prod R4 is stored from DFII10_ORIGIN by the cron (`r4DbFirstFeed`): a restate must prune none of it, and an insert-missing re-run must insert none.
describe("R4 full-depth restate keeps the cron's DFII10_ORIGIN rows", () => {
  const now = new Date("2026-10-24T00:00:00Z");
  const feed: Observation[] = [];
  for (let t = Date.parse(`${DFII10_ORIGIN}T00:00:00Z`), i = 0; t <= now.getTime(); t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) feed.push({ date: d.toISOString().slice(0, 10), value: 1 + Math.sin(i++ / 9) });
  }
  const deps: BackfillDeps = {
    ...stub,
    fetchFred: async (series, o) => (series !== "DFII10" ? stub.fetchFred(series, o) : o.since ? feed.filter((x) => x.date >= o.since!) : feed),
  };

  it("restate prunes 0 pre-first rows; a deepen re-run inserts 0", async () => {
    const store = new InMemoryStore();
    await backfillAll(store, deps, { years: 100, now, probe: 20_000, only: ["R4"] });
    const seeded = await store.getSeries("R4", 20_000);
    expect(seeded.length).toBeGreaterThan(DEEP_PROBE); // premise: the store outruns the global probe
    await backfillAll(store, deps, { now, only: ["R4"], restate: ["R4"] });
    const after = await store.getSeries("R4", 20_000);
    expect([after[0]?.date, after.length]).toEqual([seeded[0]?.date, seeded.length]);
    expect((await backfillAll(store, deps, { now, only: ["R4"], deepen: ["R4"] })).seeded.R4).toBe(0);
  });
});

// CG's level leg is a history-anchored expanding percentile, so its band is a function of base DEPTH.
// Its feeds are therefore plan-INDEPENDENT (`{ deep: true }`, unbounded, cron parity): a `since` plan
// scoring off a shallower base would re-shadow the deep-scored tail rows one tier off.
// BONOS's scorer emits nothing until `oatLegBase(c)` trading days (its velocity σ warm-up) precede a date,
// so its legs are led in by that head (`specCutoff`) — the deepest of the sovereign-quote consumers, which the ONE
// shared pull per symbol (`sovereignFeedSince`) must reach. The wiring this pins.
describe("BONOS seeds deeper than BUND — its head-led bound leads the shared sovereign-quote pulls", () => {
  it("asks each sovereign-quote leg ONCE at the deepest consumer bound; BUND's head-led feed floor sits inside it", () => {
    // Both bounds come from the ONE common window (`backfillSinceDate`), keyed by stored id — the
    // same resolver the specs call, so a depth-override edit moves the assertion with the wiring.
    const shallow = backfillSinceDate("BUND", opts.now);
    const deep = backfillSinceDate("BONOS", opts.now);
    expect(deep, "BONOS's resolved bound is its own `years` override").toBe(isoCutoff(opts.now, BONOS_BACKFILL_YEARS));
    const bundFeed = headLedSince(shallow, bundLegHead());
    // The FEED floor is the bound led in by the σ head (`specCutoff`) so the head burns below `deep`.
    const feed = specCutoff("BONOS", deep, opts.now);
    expect(feed < deep, "the lead-in must reach below BONOS's bound").toBe(true);
    expect(feed < bundFeed, "BONOS's σ-head lead-in must reach further back than BUND's scorer-head lead-in").toBe(true);
    // ONE request per sovereign-quote leg serves BONOS/BUND (N3), at the DEEPEST of their bounds and re-sliced
    // per consumer (`sovereign`, backfill.ts) — DE10Y-DE, their shared German leg, included.
    expect([...recSovereignFrom.keys()].sort()).toEqual(["DE10Y-DE", "DE2Y-DE", "ES10Y-ES"]);
    for (const symbol of recSovereignFrom.keys()) {
      expect(recSovereignFrom.get(symbol), `${symbol}: the shared sovereign-quote pull takes BONOS's deepest bound`).toBe(feed);
      expect(recSovereignCalls.get(symbol), `${symbol}: ONE request across every spread spec`).toBe(1);
    }
    // DEPTH floor, independent of `headLedSince`: BUND's feed floor must lead its bound by ≥ `bundLegHead()` business
    // days in calendar terms, else leg (c)'s inversion memory starts blind on the first stored rows.
    const need = isoDaysBefore(new Date(`${shallow}T00:00:00Z`), tradingToCalendarDays(bundLegHead()));
    expect(bundFeed <= need, "BUND's feed floor covers bundLegHead()").toBe(true);
  });

  // Decades-deep weekday feed honouring its lower bound, like the sovereign-yield quote feed.
  const deepWeekdays = (since: string | undefined, bump: number) => {
    const out: { date: string; value: number }[] = [];
    for (let d = new Date("2000-01-03T00:00:00Z"), i = 0; d < opts.now; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      if (d.getUTCDay() % 6 !== 0 && iso >= (since ?? "")) out.push({ date: iso, value: 2 + Math.sin(i++ / 9) + bump });
    }
    return out;
  };

  // The DEFAULT trim (not `opts`' 100y): the σ head must burn BELOW BONOS's bound, so the first STORED row reaches it.
  it("stores BONOS back to its own bound under the default trim (the head burns below it, not inside)", async () => {
    const now = opts.now;
    const deep: BackfillDeps = {
      ...stub,
      fetchSovereignDaily: async (symbol, from) => deepWeekdays(from, symbol === "DE10Y-DE" ? 0 : 0.5),
    };
    const store = new InMemoryStore();
    const res = await backfillAll(store, deep, { now, only: ["BONOS"], deepen: ["BONOS"] });
    expect(res.failures).toEqual([]);
    const first = (await store.getSeries("BONOS", DEEP_PROBE))[0]?.date ?? "none";
    expect(first <= backfillSinceDate("BONOS", now), `first stored BONOS row ${first}`).toBe(true);
  });

  // The shared pull hides each curve's own slice: only a slice led in by `bundLegHead` (the per-consumer
  // `curveFeedSince` floor in backfill.ts) scores its first row ON the bound, not a velocity window after it.
  it("stores BUND from its own bound — its sovereign-quote slice is head-led", async () => {
    const now = opts.now;
    const store = new InMemoryStore();
    const res = await backfillAll(store, { ...stub, fetchSovereignDaily: async (_s, from) => deepWeekdays(from, 0) }, { now, only: ["BUND"] });
    expect(res.failures).toEqual([]);
    const first = (await store.getSeries("BUND", DEEP_PROBE))[0]?.date ?? "none";
    expect(first, "first stored BUND row").toBe(deepWeekdays(backfillSinceDate("BUND", now), 0)[0]!.date);
  });
});

// CG's level leg is an expanding percentile and HCX's `hcxBasketSeries` compounds `I_0 = 1` at the first
// aligned close it is handed, so a `since`-bounded fetch moves CG's band and re-bases HCX's whole level
// series (prod: a read-path distance-from-high cliff 2026-08-21 → 2026-08-24, dist −0.116 → −0.960).
// Both ride plan-independent fetch opts (`{ deep: true }`; CG bounded at `cgLookbackDays(now)`), never `priceOpts(win)`.
describe("no-waste: CG/HCX feed depth is plan-independent; the skip proof", () => {
  // Every ask per symbol, not the last: `backfillAll`'s price memo shares SPY across specs and keeps the DEEPEST.
  const asked = new Map<string, { deep: boolean; lookbackDays?: number }[]>();
  const fredCalls: string[] = [];
  let res: Awaited<ReturnType<typeof backfillAll>>;

  beforeAll(async () => {
    const store = new InMemoryStore();
    // Seed AT `now` (age 0): the re-shadow branch is the TIGHTEST window any spec can plan. F13 rides the
    // shared `priceOpts(win)` helper and is the bounded CONTRAST; R4 = DFII10 ∈ SKIP_SAFE_IDS plans → skip.
    for (const id of ["CG", "HCX", "F13", "R4"]) await seedRow(store, id, opts.now.toISOString().slice(0, 10));
    const recStub: BackfillDeps = {
      ...stub,
      fetchPrices: async (symbol, o) => {
        asked.set(symbol, [...(asked.get(symbol) ?? []), o]);
        return stub.fetchPrices(symbol, o);
      },
      fetchFred: async (series) => {
        fredCalls.push(series);
        return obsSeries(N);
      },
    };
    res = await backfillAll(store, recStub, { ...opts, only: ["CG", "HCX", "F13", "R4", "ECY", "F1"] });
  });

  // Derived from the descriptors, so adding a fifth hyperscaler moves the assertion with the wiring.
  it.each([
    ["CG", CG_DESCRIPTOR.inputs as readonly string[], cgLookbackDays(opts.now)],
    ["HCX", [...HCX_SYMBOLS, "SPY"], undefined],
  ])("%s asks its legs for a plan-independent deep window even on the tightest incremental plan", (_id, symbols, lookbackDays) => {
    for (const symbol of symbols) {
      const planFree = (asked.get(symbol) ?? []).some((o) => o.deep && o.lookbackDays === lookbackDays);
      expect(planFree, `${symbol}: must be fetched deep at lookbackDays=${lookbackDays}, unbounded by the plan`).toBe(true);
    }
    // Non-vacuity: a sibling price spec on the SAME tightest plan IS window-bounded, so the recorder
    // demonstrably can observe `lookbackDays` — the `undefined` above is a real distinction.
    expect(asked.get("HYG")?.at(-1)?.lookbackDays, "F13's shared-helper feed must stay bounded").toBe(
      REVISION_TAIL_DAYS + SCORED_WARMUP_DAYS,
    );
  });

  // ⚠ The proof runs on R4/DFII10, NOT R5/VIXCLS: since the 2026-07-26 VT repoint onto keyless FRED,
  // VIXCLS has a SECOND consumer in `specs()` (VT's ratio numerator), so a fetch of it no longer
  // discriminates "R5 skipped" from "R5 re-fetched". The single-consumer premise the retarget rests on
  // is NOT checkable by grep — a series id can reach `fredObs` through a descriptor array
  // (`EURC_DESCRIPTOR`/`BUND_DESCRIPTOR` inputs) that neither `fredObs(<id>` nor `series:` matches — so it
  // is asserted EXECUTABLY by the DFII10 consumer-count assertions piggybacked on the R8 seed test's
  // unseeded run (backfill.jobs.test.ts). Retargeting this proof onto another id = repoint both sites.
  it("does NOT re-fetch R4 (DFII10) when it is stored current, but DOES fetch unseeded F1", () => {
    // Skip = R4's build (and thus ITS DFII10 fetch) never runs — goes red if the skip branch is
    // removed (count → 2). The remaining 1 is ECY's plan-independent full pull, which never skips.
    expect(fredCalls.filter((s) => s === "DFII10")).toHaveLength(1);
    expect(res.seeded.R4).toBe(0);
    // F1 (BAMLH0A0HYM2) is unseeded + revision-prone → full fetch. Guards against a stub that
    // silently no-ops every fetch (which would make the assertion above vacuous).
    expect(fredCalls).toContain("BAMLH0A0HYM2");
    expect(res.seeded.F1).toBeGreaterThan(0);
  });
});

