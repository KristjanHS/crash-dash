/**
 * How old a HEALTHY daily FRED feed reads at
 * REQUEST time, measured from the publisher's own calendar rather than from ALFRED vintages.
 *
 *   npx tsx scripts/probe-readpath-lag.ts                       # DGS10 + VIXCLS, 3y
 *   npx tsx scripts/probe-readpath-lag.ts -- --ids=DGS10 --years=1
 *   npx tsx scripts/probe-readpath-lag.ts -- --unit=slots       # slice 2: slot age, max 1 (not 5)
 *   npx tsx scripts/probe-readpath-lag.ts -- --assert-cut=9     # red-demo: proves the gate can PASS
 *
 * WHY A SECOND PROBE. Its sibling asks ALFRED "what did vintage D hold?", and an ALFRED vintage is a
 * WHOLE DAY — it already contains that day's release. `assessIndicatorFreshness` is not evaluated at
 * end of day: `api/status.ts` calls it with a request-time `new Date()`, so every read between the
 * feed's calendar rollover and its release hour sees ONE MORE DAY of age than any vintage can show.
 * That is the half of the maximum the vintage walk structurally cannot reach, and it is the half that
 * fires: the sibling reads 4d on the Tuesday after Labor Day 2023/2024/2025, while prod on
 * 2026-09-08 09:00 ET read 5d for the same cluster.
 *
 * METHOD. A T+1 business-day series' own observation dates ARE its publication calendar: obs `d[i]`
 * first becomes readable on `d[i+1]` (the next day the publisher posts) and stays the newest row
 * until `d[i+2]`'s release. So for every calendar day in `[d[i+1], d[i+2]]` the newest KNOWABLE
 * observation is `d[i]`, and the read-path age is `day − d[i]`. No holiday table is needed or wanted:
 * a holiday is exactly a weekday the publisher skipped, which the series' own gaps already encode.
 *
 * The maximum this yields is the smallest cut a healthy feed can live under. `LAG_THRESHOLDS.daily`
 * is IMPORTED, never restated, so this is a live gate on the ladder rather than a second copy of it.
 *
 * ⚠ NETWORK (keyless fredgraph CSV, read-only, no credentials, writes nothing), so it is NOT in
 * `npm run check` — a probe, like its `scripts/probe-*` siblings.
 */
import { LAG_THRESHOLDS, lagCutFor } from "../src/ladder.js";
import { isSlotExcused } from "../src/market-closures.js";
import { CONTAINMENT_TOLERANCE, containmentGrid, type FeedObservations, type PublicationCalendar, slotAge } from "../src/publication-calendar.js";
import { INDICATORS } from "../src/registry-fred.js";
import { FEED_OF } from "../src/registry-fred.js";
import { slotLag } from "../src/release-delay.js";
import { argOf } from "./lib/cli.js";
import { isoDay } from "../src/dates.js";
import { REFUSED_SERIES } from "../src/fred-series-policy.js";
import { noFreeSource } from "../src/no-free-source.js";

const DAY_MS = 86_400_000;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** SWEPT TARGETS (§16c). DGS10 + VIXCLS are the two calendars' representatives; DGS2/DGS30 and the
 *  HY OAS credit spread are the MINORITY-CALENDAR bond targets the review flagged — a bond target's
 *  Columbus/Veterans/Good-Friday day is exactly where an equity-majority roster could excuse a
 *  phantom slot. DGS30 is not in the registry's daily loop, so it is a swept target only, not a
 *  roster peer; DGS2/DGS10/BAMLH0A0HYM2 are both. */
const DEFAULT_IDS = ["DGS10", "VIXCLS", "DGS2", "DGS30", "BAMLH0A0HYM2"];

/** THE CONTAINMENT ROSTER (§16c). R14.4's real call site is `containmentGrid(target, allDailyFeeds)`
 *  over every DAILY-cadence registry id, whose bond:equity balance is whatever the registry holds —
 *  NOT the old hand-balanced 5-bond/4-equity 9. The honest, registry-DERIVED proxy is the keyless-FRED
 *  daily loop: `INDICATORS` (registry-fred.ts, the FRED fetch loop), cadence daily, with no `FEED_OF`
 *  ⚠ THE SELECTION RATIONALE BELOW IS STALE FRAMING, NOT A STALE SWEEP (§16e, 2026-09-09). The
 *  "equity-majority roster excuses a minority-calendar holiday" story it names was REFUTED by
 *  measurement: the feeds that actually broke the quorum were the BAML OAS SUPERSETS (every VIXCLS
 *  day plus month-end WEEKENDS), not a majority venue. The roster and the targets remain exactly
 *  right — they span both US publisher calendars AND both BAML supersets — so the falsifier is
 *  unchanged; only the reason these ids were picked reads narrower than what they caught.
 *  price/ntfs override (absent ⇒ keyless FRED). This is the network-fetchable subset of `allDailyFeeds`
 *  and spans BOTH US publisher calendars — the SIFMA rate/credit feeds (DGS, DFII10, T10Y3M, T10YIE,
 *  T5YIFR/BAML OAS, which skip Columbus & Veterans Day) and the index publisher's vol feeds (VIXCLS — OVX left this
 *  FRED roster for `^OVX` on the closes feed at S6, FEED_OF.OVX="prices"; VIXCLS still FRED — which
 *  skip Good Friday) — so the sweep exercises the real minority-calendar excusal, not a curated one. */
const FRED_DAILY_ROSTER: string[] = INDICATORS.filter(
  (i) => (i.cadence ?? "daily") === "daily" && FEED_OF[i.id] !== "prices" && FEED_OF[i.id] !== "ntfs",
).map((i) => i.series);

async function observationDates(series: string): Promise<string[]> {
  // A direct fredgraph read, so it honours the FRED seam's refusals itself.
  if (REFUSED_SERIES.has(series)) noFreeSource(series);
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}`);
  if (!res.ok) throw new Error(`${series}: HTTP ${res.status}`);
  return (await res.text())
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(","))
    .filter(([, v]) => v !== undefined && v.trim() !== "" && v.trim() !== "." && Number.isFinite(Number(v)))
    .map(([d]) => d as string);
}

export interface Sample {
  day: string;
  obs: string;
  age: number;
}

/** Every calendar day a healthy feed spends with `obs` as its newest READABLE row. */
export function readPathAges(dates: readonly string[]): Sample[] {
  const out: Sample[] = [];
  for (let i = 0; i + 2 < dates.length; i++) {
    const obs = dates[i]!;
    const firstReadable = Date.parse(dates[i + 1]!); // obs becomes readable when the next row posts
    const supersededOn = Date.parse(dates[i + 2]!); // ...and stays newest until the row after that posts
    // INCLUSIVE of `supersededOn`: that calendar day's release has not happened yet at, say, 09:00 ET,
    // so a read then still sees `obs`. This endpoint IS the read-path day the vintage walk cannot see.
    for (let t = firstReadable; t <= supersededOn; t += DAY_MS) {
      out.push({ day: isoDay(new Date(t)), obs, age: Math.floor((t - Date.parse(obs)) / DAY_MS) });
    }
  }
  return out;
}

export interface ScoredSlot extends Sample {
  slot: number;
}

/** Read-path samples scored in the feed's OWN publication slots. A same-day publication day is
 *  decremented (pre-release read, §2): at ~09:00 the store does not yet hold `day`'s own print. */
export function scoreSlots(dates: readonly string[], grid: PublicationCalendar, id: string): ScoredSlot[] {
  const gridSet = new Set(grid.dates);
  const excused = (d: string, post: number) => isSlotExcused(id, d, post);
  return readPathAges(dates).map((s) => ({ ...s, slot: slotAge(s.obs, s.day, grid, excused) - (gridSet.has(s.day) ? 1 : 0) }));
}

/** The worst (largest-slot) sample; throws on empty rather than reading absence as fresh. */
export function maxSlot(scored: readonly ScoredSlot[]): ScoredSlot {
  if (scored.length === 0) throw new Error("maxSlot: no samples");
  return scored.reduce((a, s) => (s.slot > a.slot ? s : a), scored[0]!);
}

/** The gate over the per-id slot maxima: a healthy feed above `cut` is UNSATISFIABLE. */
export function slotGate(perIdMax: readonly number[], cut: number): { worst: number; fail: boolean } {
  const worst = perIdMax.reduce((a, m) => Math.max(a, m), 0);
  return { worst, fail: worst > cut };
}

async function main(): Promise<void> {
  const years = Number(argOf("years") ?? 3);
  const requested = (argOf("ids") ?? DEFAULT_IDS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const ids = requested.filter((id) => !REFUSED_SERIES.has(id));
  const skipped = requested.filter((id) => REFUSED_SERIES.has(id));
  if (skipped.length > 0) console.error(`skipped (no free source): ${skipped.join(", ")}`);
  const from = isoDay(new Date(Date.now() - years * 365 * DAY_MS));
  const datesById = new Map<string, string[]>();
  for (const id of ids) datesById.set(id, (await observationDates(id)).filter((d) => d >= from));

  // SLOT ARM (--unit=slots): the same healthy read-path days scored in the feed's OWN publication
  // slots (slice 2/2b) rather than calendar days. The cut
  // is the DAILY TIER resolved through `lagCutFor` — since slice 3 (2026-09-09) that is the single
  // cut table for both paths, the read-path-only `LAG_SLOT_THRESHOLDS`/`slotCutFor` pair having been
  // deleted. IMPORTED, never restated, so this is a live gate on the shipped table. Falsifier
  // target: max 1 here where the calendar arm reads 5.
  if (argOf("unit") === "slots") {
    const cut = lagCutFor({ cadence: "daily" });
    // R14.2/§16c: the grid is DERIVED per feed by containment peers, NOT a single union over a keyed
    // cohort. The roster is the REAL registry-derived `allDailyFeeds` proxy (FRED_DAILY_ROSTER above)
    // plus any swept targets not already in it (e.g. DGS30). Raw FRED feeds are each independent.
    const roster = [...new Set([...ids, ...FRED_DAILY_ROSTER])].filter((id) => !REFUSED_SERIES.has(id));
    console.log(`roster (${roster.length} FRED daily feeds): ${roster.join(", ")}`);
    const feedsById = new Map<string, FeedObservations>();
    for (const id of roster) {
      const dates = datesById.get(id) ?? (await observationDates(id)).filter((d) => d >= from);
      datesById.set(id, dates);
      feedsById.set(id, { id, dates, independent: true });
    }
    const candidates = [...feedsById.values()];
    console.log(`SLOT age vs LAG_THRESHOLDS.daily = ${cut} (unit=slots, containment tol=${CONTAINMENT_TOLERANCE})`);
    const maxima: number[] = [];
    for (const id of ids) {
      const grid = containmentGrid(feedsById.get(id)!, candidates);
      // PRE-RELEASE READ (§2): `scoreSlots` decrements a same-day publication day — at ~09:00 the
      // store does not yet hold `day`'s own print, exactly why `freshnessFrom`'s grid lacks it.
      const scored = scoreSlots(datesById.get(id)!, grid, id);
      if (scored.length === 0) throw new Error(`${id}: no samples in the last ${years}y - series empty or renamed`);
      const max = maxSlot(scored);
      const over = scored.filter((s) => s.slot > cut);
      const hist = scored.reduce<Record<number, number>>((a, s) => ({ ...a, [s.slot]: (a[s.slot] ?? 0) + 1 }), {});
      maxima.push(max.slot);
      console.log(
        `  ${id}: n=${scored.length} max=${max.slot} slot(s) on ${max.day} (${DOW[new Date(max.day).getUTCDay()]}, newest obs ${max.obs}, grid ${grid.dates.length}d)` +
          ` · over cut: ${over.length} (${((100 * over.length) / scored.length).toFixed(1)}%) · slots ${JSON.stringify(hist)}`,
      );
    }
    const { worst, fail } = slotGate(maxima, cut);
    if (fail) {
      console.log(`\nFAIL_UNSATISFIABLE: a healthy feed reaches ${worst} slot(s), above the slot cut of ${cut}.`);
      process.exitCode = 1;
      return;
    }
    console.log(`\nPASS: no healthy feed exceeded ${cut} slot(s).`);
    return;
  }

  // CALENDAR ARM (default): the shipped calendar-day metric, KNOWN-RED against the daily cut — the
  // whole reason slice 2 moves the read path to slots. `--assert-cut` overrides the cut to demo the
  // gate CAN pass (red-demo of the falsifier itself).
  const assertCut = argOf("assert-cut");
  const cut = assertCut === undefined ? LAG_THRESHOLDS.daily : Number(assertCut);
  console.log(`read-path lag vs LAG_THRESHOLDS.daily = ${cut}${assertCut === undefined ? "" : " (--assert-cut override)"}`);
  let worst = 0;
  for (const id of ids) {
    const samples = readPathAges(datesById.get(id)!);
    if (samples.length === 0) throw new Error(`${id}: no samples in the last ${years}y - series empty or renamed`);
    const max = samples.reduce((a, s) => (s.age > a.age ? s : a), samples[0]!);
    const over = samples.filter((s) => slotLag(s.age, cut, id));
    const hist = samples.reduce<Record<number, number>>((a, s) => ({ ...a, [s.age]: (a[s.age] ?? 0) + 1 }), {});
    worst = Math.max(worst, max.age);
    console.log(
      `  ${id}: n=${samples.length} max=${max.age}d on ${max.day} (${DOW[new Date(max.day).getUTCDay()]}, newest obs ${max.obs})` +
        ` · over cut: ${over.length} (${((100 * over.length) / samples.length).toFixed(1)}%) · ages ${JSON.stringify(hist)}`,
    );
    if (over.length > 0) console.log(`    first over-cut days: ${over.slice(0, 6).map((s) => `${s.day}(${DOW[new Date(s.day).getUTCDay()]}) ${s.age}d`).join(" · ")}`);
  }
  if (worst > cut) {
    console.log(`\nFAIL_UNSATISFIABLE: a healthy feed reaches ${worst}d, above the cut of ${cut} - the cut false-flags on its own publication calendar.`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nPASS: no healthy feed exceeded ${cut}d.`);
}

const isMain = process.argv[1]?.endsWith("probe-readpath-lag.ts") ?? false;
if (isMain) await main();
