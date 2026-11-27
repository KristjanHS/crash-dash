/**
 * `--depth`: per Semis / S&P IT / S&P 500 verdict id, its stored first close, deep route, upstream first close, and COVERS|SHORT on the holdout and sweep windows.
 * Its own entry, not `ladder-replay-feeds.ts`'s: the probes import feeds, so a feeds main importing the probes re-enters its own unsettled top-level await.
 */
import { coverageOf, deepParts, mergeDeep, routeSrc } from "./ladder-replay-feeds.js";
import { closes, HOLDOUT_WINDOW, REPLAY, type Pt } from "./ladder-replay.js";
import { VERDICT_IDS as SEMIS_IDS } from "./probe-semis-tranches.js";
import { VERDICT_IDS as SPIT_IDS } from "./probe-spit-tranches.js";
import { VERDICT_IDS as SP500_IDS } from "./probe-sp500-tranches.js";
import { isoDay } from "../src/dates.js";
import { prodBaseUrl } from "./lib/prod-base-url.js";

const isMain = process.argv[1]?.endsWith("ladder-replay-depth.ts") ?? false;
if (isMain) {
  if (!process.argv.includes("--depth")) throw new Error("ladder-replay-depth: --depth [--base=<url>]");
  const base = process.argv.find((a) => a.startsWith("--base="))?.slice("--base=".length) ?? prodBaseUrl();
  const legs = [
    { leg: "semis", fund: "LEGP_SEMIS", ids: [...new Set<string>(["LEGP_SEMIS", ...SEMIS_IDS])] },
    { leg: "spit", fund: "LEGP_SPIT", ids: [...new Set<string>(["LEGP_SPIT", ...SPIT_IDS])] },
    { leg: "sp500", fund: "LEGP_SPX", ids: [...new Set<string>(["LEGP_SPX", ...SP500_IDS])] },
  ];
  const all = [...new Set(legs.flatMap((l) => [l.fund, ...l.ids]))];
  const { stored, up } = await deepParts(base, all);
  const s = mergeDeep(stored, up, all);
  const today = isoDay(new Date());
  const first = (c: Pt[] | undefined): string => closes(c ?? [])[0]?.date ?? "—";
  const windows = [["holdout", HOLDOUT_WINDOW.FROM, HOLDOUT_WINDOW.TO], ["sweep", REPLAY.FROM, today]] as const;
  for (const l of legs) {
    const cov = windows.map(([, from, to]) => coverageOf(s, l.ids, l.fund, from, to));
    console.log(`\n${l.leg} (fund ${l.fund}) · id · stored from · route · upstream from · ${windows.map(([w, from, to]) => `${w} ${from} → ${to}`).join(" · ")}`);
    for (const id of l.ids) {
      console.log(`  ${id.padEnd(11)} ${first(stored[id]).padEnd(10)}  ${routeSrc(id).padEnd(34)} ${first(up[id]).padEnd(10)}  ${cov.map((c) => `${c.short.includes(id) ? "SHORT " : "COVERS"} ${String(c.n[id]).padStart(4)}/${c.n[l.fund]}`).join("  ")}`);
    }
    console.log(`Depth ${l.leg}: ${windows.map(([w], i) => `${w} SHORT = ${cov[i]!.short.join(", ") || "—"}`).join(" · ")}`);
  }
}
