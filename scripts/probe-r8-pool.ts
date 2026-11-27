/** R8 pool quantiles — the anchored (>= cutAnchorDate) pool of 21-obs NTFS means the armed level
 *  cuts rank against. Hand-setting `R8_MEAN_POST_INVERSION.levelCuts` pctiles/clamps reads this.
 *  Run: npx tsx scripts/probe-r8-pool.ts */
import { fetchNtfsSeries } from "../src/gsw.js";
import { R8_MEAN_POST_INVERSION } from "../src/registry-fred.js";
import { SMOOTHED_LEVEL_OF } from "../src/family-descriptor-rows.js";
import { readEnv } from "../src/config.js";

const env = readEnv();

const obs = await fetchNtfsSeries(new Date(), env);
const w = SMOOTHED_LEVEL_OF.R8!.window;
const means: Array<{ date: string; v: number }> = [];
for (let i = w - 1; i < obs.length; i++) {
  let s = 0;
  for (let k = i - w + 1; k <= i; k++) s += obs[k]!.value;
  means.push({ date: obs[i]!.date, v: s / w });
}
const anchor = R8_MEAN_POST_INVERSION.cutAnchorDate;
const pool = means.filter((m) => m.date >= anchor).map((m) => m.v).sort((a, b) => a - b);
const q = (p: number) => pool[Math.min(pool.length - 1, Math.floor(p * pool.length))]!;
console.log(`pool n=${pool.length} anchor=${anchor} window=${w} last=${means.at(-1)!.date} mean=${means.at(-1)!.v.toFixed(3)}`);
console.log([0.05, 0.1, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
  .map((p) => `p${(p * 100).toFixed(0)}=${q(p).toFixed(3)}`).join(" "));
const cur = means.at(-1)!.v;
console.log(`current mean rank pctile=${(pool.filter((v) => v < cur).length / pool.length).toFixed(3)}`);
