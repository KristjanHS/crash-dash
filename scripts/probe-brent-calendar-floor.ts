/**
 * Read-only prod probe for the §4 feed-lag panel outage (2026-09-10).
 *
 * `freshnessFrom` throws in prod — `publicationCalendar(BRENT): 1 independent source(s), below the
 * floor of 2` — which degrades the WHOLE stamp, so `/api/status` omits `feedLag` (and the lag pill)
 * and the /lab panel can never populate. This reproduces the throw against the prod store and prints
 * WHY BRENT's containment grid recruits no peer: per candidate, how many of its own observation
 * dates fall on a day BRENT was chargeably silent (the `CONTAINMENT_TOLERANCE` test).
 */
import { resolveStore } from "./backfill/resolve-store.js";
import { CADENCE_OF, compositeComponentLegIds, freshnessFrom, LAG_SCAN_LIMIT } from "../src/feed-lag.js";
import { containmentGrid } from "../src/publication-calendar.js";

const TARGET = (process.argv.includes("--id") ? process.argv[process.argv.indexOf("--id") + 1] : "BRENT") ?? "BRENT";

// Prod creds are pulled LIVE via the Management API (`~/.supabase/access-token`), not read from
// `.env.prod` — whose SUPABASE_SERVICE_KEY is stale ("Invalid API key") and, being write-only in
// Vercel, cannot be refreshed by reading it back. `--env=local` reads `.env.local` instead.
const env = process.argv.includes("--env=local") ? "local" : "prod";
const store = await resolveStore(env, "ro");
console.log(`store: ${env}`);

// 1. The live failure, verbatim.
const stamp = await freshnessFrom(store, new Date()).catch((err: unknown) => {
  console.log("freshnessFrom THREW:", err instanceof Error ? err.message : err);
  return undefined;
});
console.log("stamp:", stamp ? `OK (${stamp.freshness.length} feeds)` : "UNDEFINED - degraded");

// 2. Why: rebuild the cohort EXACTLY as `freshnessFrom` does. The candidate set is DAILY-ONLY
//    (`allDailyFeeds`), but `gridFor` is called for every daily OR WEEKLY id — so a weekly target is
//    gridded against peers that publish on the days it is structurally silent.
const legIds = compositeComponentLegIds();
const slotIds = [...CADENCE_OF.keys()].filter((id) => {
  const c = CADENCE_OF.get(id) ?? "daily";
  return c === "daily" || c === "weekly";
});
const series = await store.getSeriesBulk(slotIds, { limit: LAG_SCAN_LIMIT });
const feedOf = (id: string) => ({
  id,
  dates: (series.get(id) ?? []).map((p: { date: string }) => p.date),
  independent: !legIds.has(id),
});
// The CANDIDATES `freshnessFrom` passes: daily only.
const allDailyFeeds = slotIds.filter((id) => (CADENCE_OF.get(id) ?? "daily") === "daily").map(feedOf);

const target = feedOf(TARGET);
console.log(
  `\n${TARGET}: cadence=${CADENCE_OF.get(TARGET)} rows=${target.dates.length} newest=${target.dates.at(-1)} independent=${target.independent}`,
);
console.log(
  `candidates (daily only): ${allDailyFeeds.length} feeds, ${allDailyFeeds.filter((f) => f.independent).length} independent`,
);
console.log(`  ⚠ ${TARGET} is${allDailyFeeds.some((f) => f.id === TARGET) ? "" : " NOT"} among its own candidates`);

try {
  const grid = containmentGrid(target, allDailyFeeds);
  console.log(`containmentGrid OK: ${grid.dates.length} grid dates for cohort ${grid.cohort}`);
} catch (err) {
  console.log("containmentGrid THREW:", err instanceof Error ? err.message : err);
}

// 3. Which peers were rejected, and by how much. A candidate joins only if at most
//    CONTAINMENT_TOLERANCE of its own dates fall on a day the target was chargeably silent.
const targetDates = new Set(target.dates);
const rows = allDailyFeeds
  .filter((g) => g.id !== TARGET && g.independent)
  .map((g) => ({
    id: g.id,
    rows: g.dates.length,
    shared: g.dates.filter((d) => targetDates.has(d)).length,
    onTargetSilent: g.dates.filter((d) => !targetDates.has(d)).length,
    newest: g.dates.at(-1),
  }))
  .sort((a, b) => a.onTargetSilent - b.onTargetSilent);
console.log(`\nindependent daily peers, by dates falling OUTSIDE ${TARGET}'s own observations:`);
for (const r of rows) {
  console.log(
    `  ${r.id.padEnd(12)} rows=${String(r.rows).padStart(4)} shared=${String(r.shared).padStart(4)} outside=${String(r.onTargetSilent).padStart(4)} newest=${r.newest}`,
  );
}

// 4. (Voter-admission section deleted 2026-09-13 with the outage-quorum excuse path — A4.
//    Every live-silent day is chargeable.)
const tSorted = [...target.dates].sort();
const tLo = tSorted[0]!;
const tHi = tSorted.at(-1)!;

// 5. Is the throw a STALENESS artefact or structural? Re-grid with every peer truncated to the
//    target's own newest date. If that passes, the cause is BRENT being 6 sessions behind: the feed's
//    lag breaks the very calendar the lag detector needs — self-defeating. If it still throws, the
//    cause is a genuine calendar difference and truncation is irrelevant.
const truncated = allDailyFeeds.map((g) => ({ ...g, dates: g.dates.filter((d) => d <= tHi) }));
try {
  const grid = containmentGrid(target, truncated);
  console.log(`\n[truncated to ${tHi}] containmentGrid OK: ${grid.dates.length} grid dates  <-- STALENESS ARTEFACT`);
} catch (err) {
  console.log(`\n[truncated to ${tHi}] STILL THREW:`, err instanceof Error ? err.message : err);
}

// 6. And the converse: how far back must the whole cohort be cut for a calendar to build at all?
//    A SHORTER window builds where the full one throws, because it holds fewer of the target's
//    foreign-holiday silent days for peers to be charged on.
const CUTS = process.env.PROBE_CUTS ? process.env.PROBE_CUTS.split(",") : ["2026-08-25", "2026-08-01", "2026-07-01", "2026-06-01"];
for (const cut of CUTS) {
  const t2 = { ...target, dates: target.dates.filter((d) => d <= cut) };
  const c2 = allDailyFeeds.map((g) => ({ ...g, dates: g.dates.filter((d) => d <= cut) }));
  try {
    containmentGrid(t2, c2);
    console.log(`  cut<=${cut}: OK`);
  } catch {
    console.log(`  cut<=${cut}: throws`);
  }
}

// 7. BISECT: the first target observation date at which the grid stops building. The culprit is the
//    calendar divergence introduced on (or just before) that date.
const days = [...new Set(target.dates)].sort();
let lo = 0;
let hi = days.length - 1;
const buildsAt = (i: number): boolean => {
  const cut = days[i]!;
  const t2 = { ...target, dates: target.dates.filter((d) => d <= cut) };
  const c2 = allDailyFeeds.map((g) => ({ ...g, dates: g.dates.filter((d) => d <= cut) }));
  try {
    containmentGrid(t2, c2);
    return true;
  } catch {
    return false;
  }
};
if (buildsAt(hi)) {
  console.log("\nbisect: builds at the newest date - nothing to find");
} else {
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (buildsAt(mid)) lo = mid;
    else hi = mid;
  }
  console.log(`\nBISECT: last building cut = ${days[lo]}, first failing cut = ${days[hi]}`);
  const lastOk = days[lo]!;
  const firstBad = days[hi]!;
  console.log(`  peers printing in (${lastOk}, ${firstBad}] that BRENT did not:`);
  const tset = new Set(target.dates);
  const gap = new Map<string, string[]>();
  for (const g of allDailyFeeds) {
    for (const d of g.dates) {
      if (d > lastOk && d <= firstBad && !tset.has(d)) {
        if (!gap.has(d)) gap.set(d, []);
        gap.get(d)!.push(g.id);
      }
    }
  }
  for (const [d, ids] of [...gap].sort()) {
    console.log(`    ${d} (${new Date(d).toUTCString().slice(0, 3)}): ${ids.length} peers printed, BRENT silent`);
  }
}

// 8. THE CHARGE SURFACE: every date inside the target's span where the target was silent but at
//    least one peer printed - with weekday and peer count. A day the target's OWN weekday profile
//    makes implausible is skipped by `liveSilentDays`; every other one is charged, and with
//    CONTAINMENT_TOLERANCE = 0 it rejects every peer that printed on it.
{
  const tset = new Set(target.dates);
  const targetWeekdays = new Set([...tset].map((d) => new Date(d).getUTCDay()));
  console.log(`\nBRENT prints on weekdays: ${[...targetWeekdays].sort().join(",")} (0=Sun,6=Sat)`);
  const byDate = new Map<string, string[]>();
  for (const g of allDailyFeeds) {
    for (const d of g.dates) {
      if (d >= tLo && d <= tHi && !tset.has(d)) {
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d)!.push(g.id);
      }
    }
  }
  const n = allDailyFeeds.length;
  console.log(`dates BRENT was silent but peers printed (of ${n} candidates):`);
  for (const [d, ids] of [...byDate].sort()) {
    const dow = new Date(d).getUTCDay();
    const plausible = targetWeekdays.has(dow);
    console.log(
      `  ${d} dow=${dow} ${plausible ? "PLAUSIBLE" : "implausible"} peers=${String(ids.length).padStart(3)}/${n} (${(ids.length / n).toFixed(2)} of COHORT, not of quorum-eligible) ${ids.length <= 8 ? ids.join(",") : ids.slice(0, 8).join(",") + ",..."}`,
    );
  }
}
