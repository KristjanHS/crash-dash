/**
 * `=X` close-day label census. Per closes-provider `=X`-fed id: stored rows on a
 * Sat/Sun label, and stored dates inside a fresh `fetchDailyCloses` window that the parser does not emit
 * (a pre-relabel row). Exits 1 on either. Read-only.
 *   npm run probe:fx-weekend-labels   (default --env=prod)
 */
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import { envArgStrict } from "./lib/cli.js";
import { fetchDailyCloses } from "../src/prices.js";
import { readEnv } from "../src/config.js";

const env = readEnv();
const store = await resolveStore(envArgStrict("prod"), "ro", liveResolveDeps);
const IDS: Array<[string, string]> = [
  ["F11", "CNY=X"], ["F17", "JPY=X"], ["DEXUSEU", "EURUSD=X"],
  ["CMP_FXH_DEXUSEU", "EURUSD=X"], ["CMP_FXH_DEXSZUS", "CHF=X"], ["CMP_FXH_DEXJPUS", "JPY=X"],
];
let bad = 0;
// FXH is derived (no single symbol): weekend labels only.
const fxh = await store.getSeries("FXH", 6000);
const fxhWeekend = fxh.filter((p) => [0, 6].includes(new Date(p.date + "T00:00:00Z").getUTCDay()));
bad += fxhWeekend.length;
console.log(`FXH: ${fxh.length} rows ${fxh[0]?.date}→${fxh.at(-1)?.date} · weekend ${fxhWeekend.length}`);
for (const [id, symbol] of IDS) {
  const pts = await store.getSeries(id, 6000);
  const weekend = pts.filter((p) => [0, 6].includes(new Date(p.date + "T00:00:00Z").getUTCDay()));
  const parsed = await fetchDailyCloses(symbol, { now: Date.now, env });
  const emitted = new Set(parsed.map((o) => o.date));
  const stray = pts.filter((p) => p.date >= parsed[0]!.date && p.date < parsed.at(-1)!.date && !emitted.has(p.date));
  bad += weekend.length + stray.length;
  console.log(
    `${id}: ${pts.length} rows ${pts[0]?.date}→${pts.at(-1)?.date} · weekend ${weekend.length} · ` +
      `not-emitted-in-window ${stray.length}${stray.length ? ` (${stray.slice(-3).map((p) => p.date).join(",")})` : ""}`,
  );
}
process.exit(bad > 0 ? 1 : 0);
