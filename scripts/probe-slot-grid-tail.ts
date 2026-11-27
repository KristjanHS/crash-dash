/**
 * WHY. `/api/status` served 17 lagging feeds on 2026-09-10 while F1 (HY OAS) sat at its NORMAL
 * T+1 age. Two ids with the SAME newest observation date read different slot ages (F1 = 2, R2 = 1),
 * which no publisher behaviour can explain — only their per-target containment grids can.
 *
 * WHAT IT PRINTS. Per id: newest stored observation, its resolved cut, its slot age, and the GRID
 * DATES strictly after the newest — each annotated with the peer feeds that contributed it. A grid
 * date NO peer with the target's own calendar could have printed is contamination: it inflates the
 * age by one slot per date.
 *
 *   bash scripts/with-prod-config.sh tsx scripts/probe-slot-grid-tail.ts                 # the daily FRED cluster
 *   bash scripts/with-prod-config.sh tsx scripts/probe-slot-grid-tail.ts --ids=F1,R2
 *
 * ⚠ Reads the PROD store (read-only, writes nothing).
 */
import { CADENCE_OF, compositeComponentLegIds, LAG_CHUNK_IDS, LAG_CUT_OF, FEED_TZ_OF } from "../src/feed-lag.js";
import { lagCutFor } from "../src/ladder.js";
import { todayOnFeedCalendar } from "../src/dates.js";
import { isSlotExcused } from "../src/market-closures.js";
import { containmentGrid, LAG_SCAN_LIMIT, slotAge, type FeedObservations } from "../src/publication-calendar.js";
import { releaseDelayFor, slotLag } from "../src/release-delay.js";
import { getStore } from "../src/store.js";
import { argOf } from "./lib/cli.js";
import { readEnv } from "../src/config.js";

const env = readEnv();

const TARGETS = (argOf("ids") ?? "F1,F2,R2,R3,R5,F10,VEA,DEXUSEU,SMH,VGK,VWO,XDEV,SP500IT,BUND,BONOS").split(",");

const store = getStore("ro", env);
const now = new Date();
const ids = [...CADENCE_OF.keys()];
const slotIds = ids.filter((id) => {
  const c = CADENCE_OF.get(id) ?? "daily";
  return c === "daily" || c === "weekly";
});
const chunks: string[][] = [];
for (let i = 0; i < slotIds.length; i += LAG_CHUNK_IDS) chunks.push(slotIds.slice(i, i + LAG_CHUNK_IDS));
const parts = await Promise.all(chunks.map((c) => store.getSeriesBulk(c, { limit: LAG_SCAN_LIMIT })));
const seriesById = new Map<string, readonly { date: string }[]>();
for (const m of parts) for (const [id, pts] of m) seriesById.set(id, pts);

const legIds = compositeComponentLegIds();
const allDailyFeeds: FeedObservations[] = [];
for (const id of slotIds) {
  if ((CADENCE_OF.get(id) ?? "daily") !== "daily") continue;
  allDailyFeeds.push({ id, dates: (seriesById.get(id) ?? []).map((p) => p.date), independent: !legIds.has(id) });
}
const datesOf = new Map(allDailyFeeds.map((f) => [f.id, new Set(f.dates)]));

for (const id of TARGETS) {
  const own = (seriesById.get(id) ?? []).map((p) => p.date);
  const newest = own.at(-1);
  if (newest == null) {
    console.log(`${id.padEnd(12)} NO ROWS`);
    continue;
  }
  const today = todayOnFeedCalendar(FEED_TZ_OF.get(id), now);
  let grid;
  try {
    grid = containmentGrid({ id, dates: own, independent: !legIds.has(id) }, allDailyFeeds);
  } catch (err) {
    console.log(`${id.padEnd(12)} newest=${newest} today=${today} UNGRIDDABLE: ${(err as Error).message}`);
    continue;
  }
  const cut = LAG_CUT_OF.get(id) ?? lagCutFor({ cadence: CADENCE_OF.get(id) ?? "daily" });
  const age = slotAge(newest, today, grid, (d, post) => isSlotExcused(id, d, post));
  const tail = grid.dates.filter((d) => d > newest && d <= today);
  const uniq = [...new Set(tail)].sort();
  const who = uniq.map((d) => `${d}<-${[...datesOf].filter(([, s]) => s.has(d)).map(([p]) => p).join(",") || "(own)"}`);
  console.log(`${id.padEnd(12)} newest=${newest} today=${today} age=${age} cut=${cut} ${slotLag(age, cut, id) ? "LAG" : "ok"} delay=${releaseDelayFor(id)}`);
  for (const w of who) console.log(`   ${w}`);
}
