// Replays the R1/R8 post-inversion floor rung over live full-history T10Y3M and prints per-year
// state counts, recent transitions, and the flat floor vs close. Run: `npm run probe:post-inversion`.
// ⚠ The R8 leg replays the RUNG MECHANICS on T10Y3M means — R8's live feed moved to NTFS
// (2026-08-13, gsw.ts); for series-level R8 questions use `npm run probe:ntfs`.
import { realFeeds } from "../src/feed-ports.js";
import { ALL_INDICATORS } from "../src/registry.js";
import {
  indicatorReadingSeries,
  postInversionCutSeries,
  smoothedLevelReadingSeries,
} from "../src/scorers-core.js";
import { SMOOTHED_LEVEL_OF } from "../src/family-descriptor-rows.js";
import { readEnv } from "../src/config.js";

const env = readEnv();

// Optional knob overrides for a retune sweep: --floor= --release= --qualify= --off
const args = process.argv.slice(2);
const fromYear = args.find((a) => !a.startsWith("--")) ?? "2024";
const flag = (name: string) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : Number(hit.split("=")[1]);
};

const obs = await realFeeds.fetchSeries("T10Y3M", { fullHistory: true, now: new Date(), env });
const base = ALL_INDICATORS.find((i) => i.id === "R1")!.postInversionCooldown!;
const cfg = {
  ...base,
  floorLevel: flag("floor") ?? base.floorLevel,
  releaseN: flag("release") ?? base.releaseN,
  qualifyN: flag("qualify") ?? base.qualifyN,
};
const rung = args.includes("--off") ? undefined : cfg;
console.log(`rung ${rung ? JSON.stringify(cfg) : "OFF"}`);
const r1 = { ...ALL_INDICATORS.find((i) => i.id === "R1")!, postInversionCooldown: rung };
const r8 = { ...ALL_INDICATORS.find((i) => i.id === "R8")!, postInversionCooldown: rung };
const cuts = postInversionCutSeries(obs.map((o) => o.value), cfg, obs.map((o) => o.date));

// Armed episodes off the cut series (null→value = arm) — the qualifyN sweep's evidence.
const eps: Array<{ from: string; to: string; days: number }> = [];
for (let i = 0; i < cuts.length; i++) {
  if (cuts[i] === null) continue;
  if (i === 0 || cuts[i - 1] === null) eps.push({ from: obs[i]!.date, to: "", days: 0 });
  const e = eps.at(-1)!;
  e.to = obs[i]!.date;
  e.days++;
}
console.log(`armed episodes ${eps.length}: ${eps.map((e) => `${e.from}→${e.to} (${e.days} obs)`).join(", ")}`);

for (const [id, rs] of [
  ["R1", indicatorReadingSeries(r1, obs)],
  ["R8", smoothedLevelReadingSeries(r8, obs, SMOOTHED_LEVEL_OF.R8!.window)],
] as const) {
  const byYear: Record<string, Record<string, number>> = {};
  let prev = "";
  for (const r of rs) {
    const y = r.date.slice(0, 4);
    if (y >= fromYear) {
      (byYear[y] ??= {})[r.state] = (byYear[y][r.state] ?? 0) + 1;
      if (prev && r.state !== prev) console.log(`  ${id} ${r.date}: ${prev} -> ${r.state}`);
    }
    prev = r.state;
  }
  console.log(id, JSON.stringify(byYear), `latest ${rs.at(-1)!.date} ${rs.at(-1)!.state}`);
}

const lastObs = obs.at(-1)!;
const cut = cuts.at(-1) ?? null;
console.log(
  `latest close ${lastObs.date} = ${lastObs.value} vs floor ${cut === null ? "null (rung unarmed/released)" : cut.toFixed(2)}`,
);
if (cut !== null) {
  let streak = 0; // trailing closes ≥ floorLevel — the release run in progress
  for (let i = obs.length - 1; i >= 0 && obs[i]!.value >= cfg.floorLevel; i--) streak++;
  console.log(`release streak ${streak}/${cfg.releaseN} closes ≥ ${cfg.floorLevel}`);
}
