// Sims plan-B's short-leg gate on the R1/R8 post-inversion floor: while armed, "bull steepening" =
// the 3m yield (DGS3MO) fell ≥ --drop bp over the trailing --window obs. Run: `npx tsx scripts/probe-steepener-gate.ts`.
import { realFeeds } from "../src/feed-ports.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { indicatorReadingSeries, postInversionCutSeries, steepenerBullSeries } from "../src/scorers-core.js";
import { readEnv } from "../src/config.js";

const env = readEnv();

const R1 = ALL_INDICATORS.find((i) => i.id === "R1")!;
const cfg = R1.postInversionCooldown!;
const args = process.argv.slice(2);
const flag = (name: string, dflt: number) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : Number(hit.split("=")[1]);
};
const window = flag("window", cfg.shortLegWindow);
const dropBp = flag("drop", cfg.shortLegDropBp);

const [spread, short] = await Promise.all([
  realFeeds.fetchSeries(R1.series, { fullHistory: true, now: new Date(), env }),
  realFeeds.fetchSeries(cfg.shortLegSeries, { fullHistory: true, now: new Date(), env }),
]);
const shortByDate = new Map(short.map((o) => [o.date, o.value]));
const joined = spread.filter((o) => shortByDate.has(o.date));
const values = joined.map((o) => o.value);
const shorts = joined.map((o) => shortByDate.get(o.date)!);

const cuts = postInversionCutSeries(values, cfg, joined.map((o) => o.date));
const bull = steepenerBullSeries(shorts, { shortLegWindow: window, shortLegDropBp: dropBp });
// "Lift" counts only days the floor changes the read: rung-off state GREEN under an armed sub-floor
// close. Sub-floor days already AMBER/RED by R1's own cuts do no floor work and are excluded.
const offState = new Map(indicatorReadingSeries({ ...R1, postInversionCooldown: undefined }, joined).map((r) => [r.date, r.state]));

console.log(`gate: 3m fell ≥ ${dropBp}bp over ${window} obs; floor ${cfg.floorLevel} (joined drops ${spread.length - joined.length} of ${spread.length} spread obs)`);
type Ep = { from: string; to: string; armed: number; bullObs: number; liftNow: number; liftGated: number; escalate: number };
const eps: Ep[] = [];
for (let i = 0; i < cuts.length; i++) {
  if (cuts[i] === null) continue;
  if (i === 0 || cuts[i - 1] === null) eps.push({ from: joined[i]!.date, to: "", armed: 0, bullObs: 0, liftNow: 0, liftGated: 0, escalate: 0 });
  const e = eps.at(-1)!;
  e.to = joined[i]!.date;
  e.armed++;
  if (bull[i]) e.bullObs++;
  const subFloor = values[i]! < cfg.floorLevel;
  const off = offState.get(joined[i]!.date);
  if (subFloor && off === "GREEN") e.liftNow++;
  if (subFloor && off === "GREEN" && bull[i]) e.liftGated++;
  if (subFloor && bull[i] && off !== "RED") e.escalate++; // days the RULED escalation newly paints RED
}
for (const e of eps) {
  console.log(
    `${e.from}→${e.to}: armed ${e.armed} obs · bull-steepening ${e.bullObs} · floor lifts now ${e.liftNow} vs gated ${e.liftGated} · escalates ${e.escalate}`,
  );
}
const last = joined.length - 1;
console.log(
  `latest ${joined[last]!.date}: spread ${values[last]}, 3m ${shorts[last]} (Δ${window}obs ${(shorts[last]! - shorts[last - window]!).toFixed(2)}), gate ${bull[last] ? "ON (bull)" : "off (bear/flat)"}, armed ${cuts[last] !== null}`,
);
// Recent 3m trajectory for the round's ASCII — monthly first-obs samples over the last ~24 months.
const samples: string[] = [];
let prevMonth = "";
for (let i = Math.max(0, joined.length - 505); i < joined.length; i++) {
  const m = joined[i]!.date.slice(0, 7);
  if (m !== prevMonth) samples.push(`${m}:${shorts[i]!.toFixed(2)}/${values[i]!.toFixed(2)}`);
  prevMonth = m;
}
console.log(`3m/spread by month: ${samples.join(" ")}`);
