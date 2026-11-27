import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Observation } from "../../src/domain-types.js";
import { fetchSeries } from "../../src/fred.js";
import { ALL_INDICATORS } from "../../src/registry.js";
import { BOTTOM_INDICATORS } from "../../src/registry-price.js";
import { InMemoryStore } from "../../src/store-memory.js";
import { DEEP_PROBE, backfillAll, backfillBottom, backfillInputSeries, backfillSinceDate, type BackfillDeps } from "../backfill.js";
import { N, obsSeries, opts as stubOpts, stub } from "../backfill.test-helpers.js";
import { readVintageText } from "../../src/hyoas-vintage.js";
import { FRED_ARCHIVE, readArchive, withFredArchive } from "./fred-archive.js";

/** The HY-OAS vintage file is not distributed with this repository; F1's archive exists only when it is present. */
const HAS_VINTAGE = readVintageText() !== undefined;

// Pinned `now`: the archive is real dated data, so the clamp geometry is only meaningful at a fixed date.
const NOW = new Date("2026-09-29T00:00:00Z");
/** FRED's clamped ICE window (F1) as served on NOW (first obs 2023-09-29) — synthetic weekday values. */
function clampedFeed(): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = [];
  for (let d = new Date("2023-09-29T00:00:00Z"); d < NOW; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() % 6 !== 0) out.push({ date: d.toISOString().slice(0, 10), value: 3 });
  }
  return out;
}

const F1 = ALL_INDICATORS.find((i) => i.id === "F1")!;

describe("withFredArchive", () => {
  it.skipIf(!HAS_VINTAGE)("prepends only archived closes dated before the feed's first, and passes an un-archived series through", () => {
    const feed = [{ date: "2024-01-02", value: 99 }];
    const merged = withFredArchive(F1.series!, feed);
    expect(merged.at(-1)).toEqual(feed[0]); // live feed wins on the overlap
    expect(merged.slice(0, -1).every((o) => o.date < "2024-01-02")).toBe(true);
    expect(merged.length).toBeGreaterThan(1);
    expect(withFredArchive("DGS10", feed)).toBe(feed);
  });

  it.runIf(!HAS_VINTAGE)("without the vintage file F1 has no archive entry and passes through untouched", () => {
    const feed = [{ date: "2024-01-02", value: 99 }];
    expect(Object.keys(FRED_ARCHIVE)).not.toContain(F1.series);
    expect(withFredArchive(F1.series!, feed)).toBe(feed);
  });
});

describe("readArchive", () => {
  const isWeekend = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() % 6 === 0;
  it("sheds a BAML archive's weekend month-end marks; a non-BAML id reading the same file keeps them", () => {
    // 2024-08-31 is a Saturday month-end mark between two weekday closes.
    const file = join(mkdtempSync(join(tmpdir(), "fred-archive-")), "baml.csv");
    writeFileSync(file, "date,value\n2024-08-30,3.1\n2024-08-31,3.2\n2024-09-02,3.3\n");
    const asFiled = readArchive(file, "KBE"); // non-BAML id → rows as filed
    expect(asFiled.some((o) => isWeekend(o.date))).toBe(true); // premise: the file carries weekend marks
    expect(readArchive(file, "BAMLH0A0HYM2")).toEqual(asFiled.filter((o) => !isWeekend(o.date)));
  });
});

// F1 (Semis seat) declares 5y over a clamped ICE feed.
describe(`${F1.id} full backfill reaches its declared depth through the clamp`, () => {
  it.skipIf(!HAS_VINTAGE)("stores the id back to backfillSinceDate although FRED serves only ~3y", async () => {
    // Premise (can-fail): the clamped feed alone starts AFTER the declared floor.
    expect(clampedFeed()[0]!.date > backfillSinceDate(F1.id, NOW)).toBe(true);
    const deps: BackfillDeps = {
      ...stub,
      fetchFred: async (series, o) => (series === F1.series ? clampedFeed() : stub.fetchFred(series, o as never)),
    };
    const store = new InMemoryStore();
    await backfillAll(store, deps, { now: NOW, only: [F1.id], deepen: [F1.id] });
    const stored = await store.getSeries(F1.id, DEEP_PROBE);
    expect(stored[0]!.date <= backfillSinceDate(F1.id, NOW), `first stored ${F1.id} row ${stored[0]!.date}`).toBe(true);
    // The archive rows are real values, not the feed's flat 3.
    const archived = new Map(FRED_ARCHIVE[F1.series!]!.map((o) => [o.date, o.value]));
    expect(stored[0]!.value).toBe(archived.get(stored[0]!.date));
  });
});

// A refused id (the owner bars redistribution) throws `NoFreeSourceError` at the real FRED seam, refused by this
// test's own set so it holds whatever `REFUSED_SERIES` lists. Each pass skips it, never aborting.
describe("a refused FRED id is skipped by every backfill pass, never a failure", () => {
  const VIX = BOTTOM_INDICATORS[0]!;
  const refused = new Set([F1.series!, "BAA10Y", VIX.series]);
  const refusing =
    (base: (series: string) => Promise<Observation[]>) =>
    (series: string, o: { fullHistory?: boolean; since?: string }): Promise<Observation[]> =>
      refused.has(series) ? fetchSeries(series, { ...o, refusedSeries: refused, env: {}, now: NOW }) : base(series);
  const feed = async (): Promise<Observation[]> => obsSeries(N);

  it("indicators: the refused id seeds 0 with no failure; the next id still seeds", async () => {
    const deps: BackfillDeps = { ...stub, fetchFred: refusing((s) => stub.fetchFred(s, {})) };
    const res = await backfillAll(new InMemoryStore(), deps, { ...stubOpts, only: [F1.id, "F4"], deepen: [F1.id] });
    expect(res.failures).toEqual([]);
    expect(res.seeded[F1.id]).toBe(0);
    expect(res.seeded.F4).toBeGreaterThan(0);
  });

  it("inputs + bottom: the pass resolves, the refused id seeds 0 and a later one still seeds", async () => {
    const inputs = await backfillInputSeries(new InMemoryStore(), { fetchFred: refusing(feed), fetchPrices: feed, fetchNtfs: feed }, { now: NOW });
    expect(inputs.perLeg.BAA10Y).toBe(0);
    expect(inputs.perLeg.AAA10Y).toBe(N); // after BAA10Y in the roster
    const bottom = await backfillBottom(new InMemoryStore(), { fetchFred: refusing(feed) }, { now: NOW, years: 100 });
    expect(bottom.perLeg[VIX.id]).toBe(0);
    expect(bottom.perLeg[BOTTOM_INDICATORS[1]!.id]).toBeGreaterThan(0);
  });
});
