/**
 * §3 "the trim" measurement: the max PUBLICATION-SLOT
 * age each daily `=X` id has actually reached in prod's stored `readings` history, which decides whether
 * its `lagAfterDays: 5` override is retired (max ≤ 1) or restated in slot units (max = N > 1).
 *
 *   npm run probe:slot-lag-fx        # = bash scripts/with-prod-config.sh --optional tsx scripts/probe-slot-lag-fx.ts
 *
 * METHOD (deliberately MINIMAL — barely good enough, ruled). The six `=X` ids share one closes-provider FX
 * publication calendar, so their pooled observation dates ARE that calendar: `containmentGrid` over the
 * cohort, then per stored observation `slotAge(d[i], d[i+1], grid)` — the slots it stayed newest before
 * its successor landed. A healthy one-session-behind `=X` pair reads 1; a genuinely skipped publication
 * day the peers printed reads 2+. FXH the parent carries no stored series of its own; its slot age is the
 * worst of its three CMP legs. Read-only against prod — never writes.
 */
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import { envArgStrict } from "./lib/cli.js";
import { isSlotExcused } from "../src/market-closures.js";
import { containmentGrid, slotAge, type FeedObservations } from "../src/publication-calendar.js";

const STORED = ["F11", "F17", "CMP_FXH_DEXUSEU", "CMP_FXH_DEXSZUS", "CMP_FXH_DEXJPUS"] as const;
const FXH_LEGS = ["CMP_FXH_DEXUSEU", "CMP_FXH_DEXSZUS", "CMP_FXH_DEXJPUS"] as const;

const store = await resolveStore(envArgStrict("prod"), "ro", liveResolveDeps);

const datesById = new Map<string, string[]>();
for (const id of STORED) {
  const pts = await store.getSeries(id, 6000);
  datesById.set(id, [...new Set(pts.map((p) => p.date))].sort());
}

const cohort: FeedObservations[] = STORED.map((id) => ({ id, dates: datesById.get(id)!, independent: true }));

/** Max slot age + histogram over one id's stored observations, scored on the shared FX grid. */
function slotAgesFor(id: string): { max: number; hist: Record<number, number> } {
  const grid = containmentGrid(cohort.find((c) => c.id === id)!, cohort);
  const dates = datesById.get(id)!;
  const hist: Record<number, number> = {};
  let max = 0;
  for (let i = 0; i + 1 < dates.length; i++) {
    const age = slotAge(dates[i]!, dates[i + 1]!, grid, (d, post) => isSlotExcused(id, d, post));
    hist[age] = (hist[age] ?? 0) + 1;
    max = Math.max(max, age);
  }
  return { max, hist };
}

const maxById = new Map<string, number>();
for (const id of STORED) {
  const { max, hist } = slotAgesFor(id);
  maxById.set(id, max);
  const n = datesById.get(id)!.length;
  console.log(`${id}: n=${n} rows ${datesById.get(id)![0]}→${datesById.get(id)!.at(-1)} · MAX ${max} slot(s) · hist ${JSON.stringify(hist)}`);
}

const fxhMax = Math.max(...FXH_LEGS.map((id) => maxById.get(id)!));
console.log(`FXH: worst-of-3 legs · MAX ${fxhMax} slot(s)`);

console.log("\nDECISION (≤1 ⇒ delete override, N>1 ⇒ restate lagAfterDays: N in slots):");
for (const id of ["F11", "F17"] as const) console.log(`  ${id}: max ${maxById.get(id)} ⇒ ${maxById.get(id)! <= 1 ? "DELETE" : `RESTATE ${maxById.get(id)}`}`);
console.log(`  FXH: max ${fxhMax} ⇒ ${fxhMax <= 1 ? "DELETE" : `RESTATE ${fxhMax}`}`);
for (const id of FXH_LEGS) console.log(`  ${id}: max ${maxById.get(id)} ⇒ ${maxById.get(id)! <= 1 ? "DELETE" : `RESTATE ${maxById.get(id)}`}`);
