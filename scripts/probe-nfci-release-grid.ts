/**
 * Re-derive F3's lag cut from the NFCI PUBLICATION CALENDAR (R1), keyless and read-only.
 *
 *   npm run probe:nfci-grid                 # 157 Wednesdays back from the last one
 *   npm run probe:nfci-grid -- --weeks=52
 *   npm run probe:nfci-grid -- --assert-cut=11   # the red-demo: proves the gate can FAIL
 *
 * WHY THIS EXISTS. `lagAfterDays: 12` on F3 was shipped 2026-08-03 with a derivation that did
 * not reach its own number — "stamps the week-ending Friday, releases the following Wednesday, so
 * it lands 5d old and ages another 7" tops out at ELEVEN, the value F9/F11/FXH carry. Either the
 * cut had a day of unearned slack (a missed NFCI release going unflagged an extra day, against
 * the R1 rule the change invoked) or the derivation was missing a term. This probe answers it
 * from the publisher's real calendar rather than from an age we happened to observe, and stays
 * runnable so the answer can be re-checked instead of re-argued.
 *
 * THE ANSWER (2026-08-03, 157 Wednesdays, 2023-08 → 2026-07): the derivation was wrong and the
 * NUMBER was right. 135 releases land T+5 (Wednesday). 22 slip to THURSDAY (T+6) — every one the
 * week after a Monday US holiday — and not one lands later than that. A row is the newest
 * available until its SUCCESSOR is released, so its peak age is `release(successor) − 1 − obs`:
 * 11 in a normal week, 12 when the successor slips. 11 would false-flag F3 ~7 weeks a year.
 *
 * METHOD. ALFRED serves the FRED real-time database keyless: `vintage_date=D` returns the series
 * exactly as it stood on D, so the newest row in that response is what a fetch on D could have
 * seen. Sampling one vintage per Wednesday finds every slip, because a release is either on that
 * Wednesday or later; each slip is then resolved by sampling the following days until the row
 * appears, which is what makes "never later than Thursday" a measurement and not an assumption.
 *
 * ⚠ NETWORK, so it is NOT in `npm run check` — this is a probe, like its `scripts/probe-*`
 * siblings. It writes nothing, hits no store, and needs no credentials.
 *
 * ⚠ The cut under test is IMPORTED from the registry on purpose. This is not an A/B control arm —
 * there is no baseline to re-base. The measurement is the
 * release calendar, which no code change can move; importing the cut is what makes the probe a
 * live gate on the registry rather than a second copy of it.
 */
import { ALL_INDICATORS } from "../src/registry.js";
import { lagCutFor } from "../src/ladder.js";
import { argOf } from "./lib/cli.js";
import { isoDay } from "../src/dates.js";

/** Wednesdays to scan. 157 ≈ 3 years — long enough to contain every US holiday twice over. */
const DEFAULT_WEEKS = 157;
/** NFCI's nominal release lag: an observation stamped Friday is published the following Wednesday. */
const NOMINAL_LAG_DAYS = 5;
/** Days past the nominal Wednesday to keep probing a slipped release before giving up. */
const MAX_SLIP_PROBE_DAYS = 7;
/** Concurrent ALFRED fetches. Politeness, not throughput — the whole scan is ~180 small requests. */
const CONCURRENCY = 8;

const WEEKS = Number(argOf("weeks") ?? DEFAULT_WEEKS);
/** Override the cut the gate asserts against — the red-demo hook, never a measurement input. */
const ASSERT_CUT = argOf("assert-cut");

const DAY_MS = 86_400_000;
const iso = (t: number): string => isoDay(new Date(t));
const parse = (d: string): number => Date.parse(`${d}T00:00:00Z`);
const shift = (d: string, days: number): string => iso(parse(d) + days * DAY_MS);
const daysBetween = (a: string, b: string): number => Math.round((parse(b) - parse(a)) / DAY_MS);

/**
 * The newest NFCI observation date visible in the FRED real-time database on `vintage`, or null
 * if that vintage predates the series. `cosd` trims the response to a few rows — the full series
 * starts in 1971 and we only ever read its tail.
 */
async function newestObsAsOf(vintage: string): Promise<string | null> {
  const cosd = shift(vintage, -90);
  const url = `https://alfred.stlouisfed.org/graph/alfredgraph.csv?id=NFCI&cosd=${cosd}&vintage_date=${vintage}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ALFRED ${vintage}: ${res.status} ${res.statusText}`);
  const rows = (await res.text())
    .trim()
    .split("\n")
    .slice(1) // header
    .map((line) => line.split(",")[0]!)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  return rows.at(-1) ?? null;
}

/** Map `fn` over `items` at most `CONCURRENCY` at a time, preserving order. */
async function mapLimit<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
    }),
  );
  return out;
}

/** The most recent Wednesday on or before `from` (UTC). */
function lastWednesday(from: string): string {
  const dow = new Date(parse(from)).getUTCDay(); // 0=Sun … 3=Wed
  return shift(from, -((dow - 3 + 7) % 7));
}

async function main(): Promise<void> {
  const today = iso(Date.now());
  const lastWed = lastWednesday(today);
  const wednesdays = Array.from({ length: WEEKS }, (_, i) => shift(lastWed, -7 * (WEEKS - 1 - i)));

  console.log(`NFCI release grid · ${WEEKS} Wednesdays · ${wednesdays[0]} → ${lastWed} · ALFRED (keyless)\n`);

  const seen = await mapLimit(wednesdays, newestObsAsOf);

  // A Wednesday is ON GRID when the observation it should have published is already visible.
  // Otherwise that release slipped, and we walk forward day by day to find where it landed.
  const slipped: Array<{ obs: string; nominal: string; released: string }> = [];
  let onGrid = 0;
  for (const [i, wed] of wednesdays.entries()) {
    const due = shift(wed, -NOMINAL_LAG_DAYS);
    if (seen[i] === due) {
      onGrid++;
      continue;
    }
    if (seen[i] === null || daysBetween(seen[i]!, due) <= 0) {
      // Vintage predates the series, or ALFRED already served something newer than the row we
      // expected — neither is a slip, and neither may be counted as one.
      console.log(`  ?  ${wed}  newest=${seen[i]} (expected ${due}) — not a slip, skipped`);
      continue;
    }
    let released: string | null = null;
    for (let d = 1; d <= MAX_SLIP_PROBE_DAYS; d++) {
      const probe = shift(wed, d);
      if (parse(probe) > parse(today)) break; // the future has no vintage
      if ((await newestObsAsOf(probe)) === due) {
        released = probe;
        break;
      }
    }
    if (released === null) {
      console.log(`  ?  ${wed}  obs ${due} unresolved within ${MAX_SLIP_PROBE_DAYS}d — excluded from the max`);
      continue;
    }
    slipped.push({ obs: due, nominal: wed, released });
  }

  const worstLag = slipped.reduce((m, s) => Math.max(m, daysBetween(s.obs, s.released)), NOMINAL_LAG_DAYS);
  for (const s of slipped) {
    const dow = new Date(parse(s.released)).toUTCString().slice(0, 3);
    console.log(
      `  SLIP  obs ${s.obs}  due ${s.nominal}  released ${s.released} (${dow}, T+${daysBetween(s.obs, s.released)})`,
    );
  }

  // Peak age of an observation = the day before its SUCCESSOR is published, minus its own date.
  // The successor is one week later, so the worst lag anywhere on the grid sets the worst peak.
  const peakNormal = 7 + NOMINAL_LAG_DAYS - 1;
  const peakWorst = 7 + worstLag - 1;

  console.log(`\n  on grid (T+${NOMINAL_LAG_DAYS}): ${onGrid}/${WEEKS} · slipped: ${slipped.length}/${WEEKS}`);
  console.log(`  worst release lag observed: T+${worstLag}`);
  console.log(`  peak request-time age: ${peakNormal}d normal week · ${peakWorst}d worst week`);

  const f3 = ALL_INDICATORS.find((i) => i.id === "F3");
  if (!f3) throw new Error("no registry entry for F3"); // non-vacuity: a renamed id fails loudly
  const cut = ASSERT_CUT === undefined ? lagCutFor(f3) : Number(ASSERT_CUT);
  const label = ASSERT_CUT === undefined ? "registry" : "--assert-cut";
  console.log(`  F3 cut under test (${label}): ${cut}d\n`);

  if (cut < peakWorst) {
    console.error(
      `FAIL: cut ${cut}d is below the measured peak ${peakWorst}d — F3 would read stale on a healthy release week.`,
    );
    process.exit(1);
  }
  const slack = cut - peakWorst;
  console.log(
    slack === 0
      ? `OK: cut ${cut}d is exactly the measured structural maximum — R1-faithful and maximally sensitive.`
      : `OK, but LOOSE: cut ${cut}d carries ${slack}d of slack over the measured maximum ${peakWorst}d.`,
  );
}

await main();
