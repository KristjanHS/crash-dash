/**
 * Regenerates `scripts/probe-semis-tranches.watch.json` — the drawdown-watch harness fixture
 * (Stage 1.1, ruling T2).
 *
 *     npm run probe:semis-watch-fixture
 *
 * Series: stored prod `/api/series` via `deepParts` (routed ids also rebuilt upstream, `mergeDeep` parity-checked
 * against stored — a breach throws) + keyless FRED `BAMLC0A4CBBB` as `BBB` (not stored until Stage 6.3).
 * Events: `public/semis.json` `events` + `eventsDone` (`allEvents`), copied as-is. Cut to `FROM`..`TO`; an id whose history starts
 * later ships short (its cells read `none` before its first point) — never padded. Null-valued points
 * (HCX before its 12-mo high is decidable) are dropped. Prints each id's full-history first date + count.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { deepParts, mergeDeep } from "./ladder-replay-feeds.js";
import { isWeekend } from "./probe-eufin-tranches.js";
import { realFeeds } from "../src/feed-ports.js";
import { readEnv } from "../src/config.js";
import { prodBaseUrl } from "./lib/prod-base-url.js";

const IDS = ["LEGP_SEMIS", "F1", "HCX", "F8", "MU_RS", "VXSMH", "RS_SMH", "R4"] as const;
const FROM = "2024-10-01";
const TO = "2026-10-30";
const OUT = new URL("./probe-semis-tranches.watch.json", import.meta.url);

type Row = [string, number];
const rows = (pts: readonly { date: string; value: number | null }[]): Row[] =>
  pts.filter((p): p is { date: string; value: number } => p.value !== null && Number.isFinite(p.value)).map((p) => [p.date, Number(p.value.toPrecision(8))]);

// Values read STORED (the series the live watch reads; every id's stored history starts before FROM): the upstream closes provider
// rebuilds jitter in the 7th–8th significant digit between fetches (F8/MU_RS/RS_SMH, measured 2026-10-31), so they cannot
// regenerate byte-identically. Upstream is fetched only for `mergeDeep`'s parity check (throws past PARITY_TOL), HCX excluded:
// its rebuild breaches on one pre-window date (2024-02-02, |Δ| 0.0375 vs 0.02 tol).
const { stored, up } = await deepParts(prodBaseUrl(), IDS);
mergeDeep(stored, up, IDS.filter((id) => id !== "HCX"));
const deep = Object.fromEntries(IDS.map((id) => [id, (stored[id] ?? []).filter((p) => !isWeekend(p.date))]));
const bbb = await realFeeds.fetchSeries("BAMLC0A4CBBB", { fullHistory: true, now: new Date(), env: readEnv() });
const full: Record<string, Row[]> = { ...Object.fromEntries(IDS.map((id) => [id, rows(deep[id] ?? [])])), BBB: rows(bbb) };
const ids = Object.keys(full);

for (const id of ids) console.log(`depth ${id}: ${full[id]![0]?.[0] ?? "—"} · n=${full[id]!.length}`);
const series = Object.fromEntries(ids.map((id) => [id, full[id]!.filter(([d]) => d >= FROM && d <= TO)]));
const semisJson = JSON.parse(readFileSync(new URL("../public/semis.json", import.meta.url), "utf8")) as { events: unknown[]; eventsDone?: unknown[] };
const events = [...semisJson.events, ...(semisJson.eventsDone ?? [])]; // the watch replays history — `allEvents`, src/ladder-live.ts

const head = { generatedBy: "npm run probe:semis-watch-fixture", from: FROM, to: TO, ids };
const body = [
  `{${Object.entries(head).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",")},`,
  `"series":{`,
  ids.map((id) => `${JSON.stringify(id)}:${JSON.stringify(series[id])}`).join(",\n"),
  `},`,
  `"events":${JSON.stringify(events)}}`,
].join("\n");
writeFileSync(OUT, `${body}\n`);
for (const id of ids) console.log(`window ${id}: ${series[id]![0]?.[0] ?? "—"} → ${series[id]!.at(-1)?.[0] ?? "—"} · n=${series[id]!.length}`);
