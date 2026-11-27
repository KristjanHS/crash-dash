import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, test } from "vitest";
import { assertDisposableStack, supabaseMarkerProbe } from "../src/disposable-guard.js";
import type { Observation } from "../src/domain-types.js";
import {
  PERSIST_N,
  SLOW_HIGH_WINDOW,
  scoreSlow,
  slowBackfillRows,
  slowStoredReadings,
  windowAsOf,
  type SlowComponent,
} from "../src/slow.js";
import { SupabaseStore, type StoredReading } from "../src/store.js";
import { makeStoredReading } from "../src/test-helpers.js";
import {
  backfillSlow,
  type SlowBackfillDeps,
} from "./backfill-slow.js";

/** `n` consecutive daily ISO dates from `startIso` (UTC). */
const daysFrom = (startIso: string, n: number): string[] => {
  const out: string[] = [];
  const d = new Date(`${startIso}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
};

// 600 consecutive days of synthetic QQQ (drift + deterministic ripple) and VIX — enough
// for the 272-close near-high m-of-n window and a 60-obs VIX cut within the trailing-2y slice.
const N = 600;
const dates = daysFrom("2020-01-01", N);
const qqq: Observation[] = dates.map((date, i) => ({ date, value: 100 + i * 0.1 + Math.sin(i / 7) * 3 }));
const vix: Observation[] = dates.map((date, i) => ({ date, value: 18 + Math.cos(i / 11) * 4 }));
const CUTOFF = "2020-01-01";

const pick = (r: StoredReading) => ({ id: r.indicatorId, value: r.value, state: r.state, rawState: r.rawState });

describe("windowAsOf (live-equivalent windows)", () => {
  // Direct boundary coverage so the parity test's "no drift" claim isn't tautological
  // (the parity test reuses windowAsOf on both sides, so a bug inside it would hide).
  const t = "2023-01-01";
  const qFrom = "2021-01-01"; // exactly 730 days before t
  const series = (d: string): Observation[] => [{ date: d, value: 1 }];

  test("VIX includes ≤ t, excludes > t", () => {
    expect(windowAsOf([], series("2023-01-01"), t).vixWin).toHaveLength(1);
    expect(windowAsOf([], series("2023-01-02"), t).vixWin).toHaveLength(0);
  });
  test("QQQ left boundary is EXCLUSIVE: a day exactly 730 days before t is dropped", () => {
    expect(windowAsOf(series(qFrom), [], t).qqqWin).toHaveLength(0); // == qFrom → excluded
    expect(windowAsOf(series("2021-01-02"), [], t).qqqWin).toHaveLength(1); // 729 days back → kept
  });
  test("QQQ right boundary is INCLUSIVE at t, excludes future", () => {
    expect(windowAsOf(series("2023-01-01"), [], t).qqqWin).toHaveLength(1);
    expect(windowAsOf(series("2023-01-02"), [], t).qqqWin).toHaveLength(0);
  });
});

describe("slowBackfillRows (point-in-time projection)", () => {
  const rows = slowBackfillRows(qqq, vix, CUTOFF);

  test("skips early dates without enough trailing history (≥272 obs)", () => {
    // First scorable date: SLOW_HIGH_WINDOW + PERSIST_N − 1 trailing closes (0-based index).
    const firstDate = rows[0]!.date;
    expect(firstDate).toBe(dates[SLOW_HIGH_WINDOW + PERSIST_N - 2]);
  });

  test("PARITY: the latest date's metric/state == live scoreSlow on the same window", () => {
    // The decisive guard: the point-in-time recompute at the newest date must reduce to
    // the live scoring on the equivalent trailing-2y QQQ + full VIX window. A window
    // drift or look-ahead in the backfill would diverge here. delta20 is excluded (the
    // backfill fills a real 20-obs delta; the live path persists 0).
    const latest = dates[N - 1]!;
    const { qqqWin, vixWin } = windowAsOf(qqq, vix, latest);
    const observability: SlowComponent[] = scoreSlow(qqqWin, vixWin).observability;
    const expected = slowStoredReadings(observability, latest).map(pick);
    const got = rows.filter((r) => r.date === latest).map(pick);
    expect(got).toEqual(expected);
  });

  test("delta20 is 0 until 20 observations exist, then a real change", () => {
    const accel = rows.filter((r) => r.indicatorId === "price-accel");
    expect(accel[0]!.delta20).toBe(0); // first emitted obs has no 20-back lookback
    expect(accel[19]!.delta20).toBe(0); // still < 20 prior
    expect(accel[20]!.delta20).toBe(accel[20]!.value - accel[0]!.value); // 20-obs change
  });
});

// --- DB-integration: vintage shadowing through the real readings_latest view --------
// Runs only with LOCAL Supabase creds + DB_TESTS=1 — mirrors store.test-helpers.ts's FOUR-layer
// gate (visible-as-skipped): this suite writes junk vintages into whatever DB the creds
// reach, so it must never run against prod or an un-opted-in seeded local DB.
//   1. isLocalUrl  — keeps prod creds out. Does NOT protect the dev DB: it IS localhost.
//   2. DB_TESTS=1  — an opt-in a .env.local line can satisfy on its own.
//   3+4. describe.runIf + the `_disposable_stack` marker, asserted in beforeAll BEFORE the
//        first write. Seeded ONLY by ci.yml's CI-only step, so no .env.local line forges it.
// Layer 3 is asserted, not merely skipped-past: this suite only INSERTS (it never truncates),
// but junk vintages in the irreplaceable dev DB are still damage the marker is there to stop.
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
const isLocalUrl = Boolean(url && /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url));
const hasDb = Boolean(url && key) && isLocalUrl && process.env.DB_TESTS === "1";

describe.runIf(hasDb)("backfillSlow vintage shadowing (DB)", () => {
  beforeAll(async () => {
    const admin = createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } });
    await assertDisposableStack(url!, supabaseMarkerProbe(admin));
  });

  test("a newer-vintage metric row shadows an old value=score row in getSeries", async () => {
    const store = new SupabaseStore(url!, key!);
    const id = "price-accel";
    const collisionDate = dates[N - 1]!; // the backfill's newest emitted date

    // 1. Seed an OLD vintage holding the legacy value=SCORE semantics (2).
    const oldVintage = "2000-01-01T00:00:00.000Z";
    await store.recordReadings(
      [makeStoredReading(id, { date: collisionDate, value: 2, rawState: "RED", state: "RED" })],
      oldVintage,
    );

    // 2. Backfill inserts a NEWER vintage (now.toISOString()) with the metric. Stub feeds
    //    so it's deterministic + offline; years=15 keeps the 2020 dates inside the cutoff.
    const deps: SlowBackfillDeps = { fetchQqq: async () => qqq, fetchVix: async () => vix };
    const res = await backfillSlow(store, deps, { now: new Date("2026-01-01T00:00:00Z"), years: 15 });
    expect(res.inserted).toBeGreaterThan(0);

    // 3. readings_latest returns the newest vintage per date → the metric (∈[0,1]),
    //    NOT the shadowed score (2).
    const series = await store.getSeries(id, 5000);
    const atDate = series.find((p) => p.date === collisionDate);
    expect(atDate).toBeDefined();
    expect(atDate!.value).toBeLessThanOrEqual(1);
    expect(atDate!.value).not.toBe(2);

    // 4. Re-running inserts a still-newer vintage → idempotent for reads (one row/date).
    const res2 = await backfillSlow(store, deps, { now: new Date("2026-06-01T00:00:00Z"), years: 15 });
    expect(res2.inserted).toBe(res.inserted);
    const series2 = await store.getSeries(id, 5000);
    expect(series2.filter((p) => p.date === collisionDate)).toHaveLength(1);
  });
});
