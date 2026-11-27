/** Spec depth-parity: a since-plan run must
 *  reproduce the full run's rows past `maxDate`. Fix a red id by deepening (R3/R4), never the tolerance. */
import { isDeepStrictEqual } from "node:util";

import { describe, expect, it } from "vitest";

import { DOWNSIDE_DETECTORS, RS_LEGS } from "../src/registry-price.js";
import { InMemoryStore } from "../src/store-memory.js";
import type { SeriesPoint } from "../src/store.js";
import {
  FRESH_MARGIN_DAYS,
  SCORED_WARMUP_DAYS,
  SKIP_SAFE_IDS,
  backfillAll,
  backfillDownsideBreaks,
  isoDaysBefore,
  specCutoff,
  specRoster,
  type BackfillDeps,
} from "./backfill.js";
import { AGE_DAYS, STUB_NOW, opts, seedRow, windowedStub } from "./backfill.test-helpers.js";

const NOW_MS = STUB_NOW.getTime();
// Every id leads in by its own read-path head.
const headLeadDays = (id: string): number =>
  (NOW_MS - Date.parse(specCutoff(id, isoDaysBefore(STUB_NOW, 0), STUB_NOW))) / 86_400_000;
const WARMUP = new Map(specRoster().map((s) => [s.id, s.warmupDays ?? SCORED_WARMUP_DAYS]));
/** Per-id long-feed depth: twice that id's warmup (≥ its head lead-in; detector legs: the scored default), plus the stale age. */
const feedDaysOf = (id: string): number =>
  2 * Math.max(WARMUP.get(id) ?? SCORED_WARMUP_DAYS, headLeadDays(id)) + AGE_DAYS;
// A month inside the feed floor: a weekday/weekly/monthly grid's first row lands up to 31 days past it.
const feedStartOf = (id: string): string => isoDaysBefore(STUB_NOW, feedDaysOf(id) - 1 - 31);

type Failures = { id: string; error: string }[];
type Job = (store: InMemoryStore, deps: BackfillDeps, id: string) => Promise<Failures>;
const specJob: Job = async (store, deps, id) => (await backfillAll(store, deps, { ...opts, only: [id] })).failures;
const legJob: Job = (store, deps, id) =>
  backfillDownsideBreaks(store, deps, { ...opts, only: [id] }).then(
    () => [],
    (err: unknown) => [{ id, error: String(err) }],
  );

/** One isolated `only:[id]` run (R6: fresh store, fresh deps ⇒ fresh priceCache); `firstDates` = each fetch's oldest row. */
async function run(job: Job, id: string, maxDate: string | null) {
  const store = new InMemoryStore();
  if (maxDate !== null) await seedRow(store, id, maxDate);
  const firstDates: string[] = [];
  const note = (obs: { date: string }[]) => obs[0] !== undefined && firstDates.push(obs[0].date);
  const deps = Object.fromEntries(
    Object.entries(windowedStub(feedDaysOf(id))).map(([k, f]) => [
      k,
      async (...a: unknown[]) => {
        const r = await (f as (...x: unknown[]) => Promise<unknown>)(...a);
        for (const obs of Array.isArray(r) ? [r] : Object.values(r as object)) note(obs as { date: string }[]);
        return r;
      },
    ]),
  ) as unknown as BackfillDeps;
  const failures = await job(store, deps, id);
  return { failures, rows: await store.getSeries(id, Number.MAX_SAFE_INTEGER), firstDates };
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
const closeOpt = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || b == null ? (a ?? null) === (b ?? null) : Object.is(a, b) || close(a, b);

/** Per-date fields a too-short window can move while `state`/`value` stay put (a constant-state id, a raw-close value). */
const fieldDiffs = (r: SeriesPoint, t: SeriesPoint): string[] => [
  r.state !== t.state ? `state ${r.state}≠${t.state}` : "",
  r.rawState !== t.rawState ? `rawState ${r.rawState}≠${t.rawState}` : "",
  close(r.value, t.value) ? "" : `value ${r.value}≠${t.value}`,
  closeOpt(r.delta20, t.delta20) ? "" : `delta20 ${r.delta20}≠${t.delta20}`,
  (r.decision ?? null) === (t.decision ?? null) ? "" : `decision ${r.decision}≠${t.decision}`,
  isDeepStrictEqual(r.bandCuts ?? null, t.bandCuts ?? null) ? "" : `bandCuts ${JSON.stringify(r.bandCuts)}≠${JSON.stringify(t.bandCuts)}`,
];

function expectParity(id: string, arm: string, full: SeriesPoint[], since: SeriesPoint[], maxDate: string) {
  const f = full.filter((r) => r.date > maxDate);
  const s = since.filter((r) => r.date > maxDate);
  expect.soft(f.length, `${id} ${arm}: full run emits nothing past maxDate — lengthen feedDaysOf`).toBeGreaterThan(0);
  expect.soft(s.map((r) => r.date), `${id} ${arm}: date-set`).toEqual(f.map((r) => r.date));
  const bySince = new Map(s.map((r) => [r.date, r]));
  const off = f.flatMap((r) => {
    const t = bySince.get(r.date);
    if (t === undefined) return [];
    const bad = fieldDiffs(r, t).filter(Boolean);
    return bad.length > 0 ? [`${r.date} ${bad.join(" ")}`] : [];
  });
  expect.soft(off.slice(0, 3), `${id} ${arm}: per-date fields (${off.length} dates)`).toEqual([]);
}

/** Full vs stale (+ fresh unless skip-safe) since-plan runs of `job` for `id`; returns the since runs' shallow-fetch count. */
async function expectDepthParity(job: Job, id: string): Promise<number> {
  const full = await run(job, id, null);
  expect.soft(full.failures, `${id} full`).toEqual([]);
  const arms: [string, string][] = [["stale", isoDaysBefore(STUB_NOW, AGE_DAYS)]];
  if (!SKIP_SAFE_IDS.has(id)) arms.push(["fresh", isoDaysBefore(STUB_NOW, FRESH_MARGIN_DAYS)]);
  let shallow = 0;
  for (const [arm, maxDate] of arms) {
    const since = await run(job, id, maxDate);
    expect.soft(since.failures, `${id} ${arm}`).toEqual([]);
    shallow += since.firstDates.filter((d) => d > feedStartOf(id)).length;
    expectParity(id, arm, full.rows, since.rows, maxDate);
  }
  return shallow;
}

describe("backfillAll since-plan ≡ full-plan past maxDate, per spec (R1/R2)", () => {
  let shallowFetches = 0;
  it.each(specRoster())("$id", async ({ id }) => {
    shallowFetches += await expectDepthParity(specJob, id);
  });

  // Runs last: guards the roster above against a stub that ignores every window arg.
  it("≥1 since-plan fetch is shallower than its id's feed window", () => {
    expect(shallowFetches).toBeGreaterThan(0);
  });
});

describe("backfillDownsideBreaks since-plan ≡ full-plan past maxDate, per detector leg (R5)", () => {
  let shallowFetches = 0;
  it.each([...DOWNSIDE_DETECTORS, ...RS_LEGS].map((d) => ({ id: d.indicator.id })))("$id", async ({ id }) => {
    shallowFetches += await expectDepthParity(legJob, id);
  });

  it("≥1 since-plan fetch is shallower than its id's feed window", () => {
    expect(shallowFetches).toBeGreaterThan(0);
  });
});
