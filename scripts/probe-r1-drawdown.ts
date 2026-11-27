// R1 regime-relative drawdown leg — the knob grid behind the 2026-08-30 ruling (window × drop ×
// direction gate) over T10Y3M since 2006. Run: `npm run probe:r1-drawdown`. NEGATIVE-RESULT PROVENANCE since
// 2026-08-31: R1 no longer wires the leg; `probe:r1-lit` is the cited sim.
// Columns: lead = earliest firing day inside the 504-obs run-up to each NBER onset; FP% = firing days
// that are neither in a recession nor in such a run-up; "+days vs shipped" = warning days the leg adds
// over the shipped armed rung. RULED cell: 126 / 0.40 / move.
import { realFeeds } from "../src/feed-ports.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { postInversionCutSeries, steepenerBullSeries } from "../src/scorers-core.js";
import { readEnv } from "../src/config.js";

const env = readEnv();

const SINCE = "2006-01-01";
const cfg = ALL_INDICATORS.find((i) => i.id === "R1")!.postInversionCooldown!;
const [obs, short] = await Promise.all([realFeeds.fetchSeries("T10Y3M", { since: SINCE, now: new Date(), env }), realFeeds.fetchSeries("DGS3MO", { since: SINCE, now: new Date(), env })]);
const v = obs.map((o) => o.value), d = obs.map((o) => o.date), N = v.length;
const sm = new Map(short.map((o) => [o.date, o.value]));
let last = short[0]!.value;
const sh = d.map((x) => (last = sm.get(x) ?? last));
const bull = steepenerBullSeries(sh, cfg);
// bear leg: the SHORT rate RISING >= shortLegDropBp over the same window (hiking-driven flattening)
const bear = sh.map((y, i) => i >= cfg.shortLegWindow && y - sh[i - cfg.shortLegWindow]! >= cfg.shortLegDropBp / 100);
const GATES: Array<[string, (i: number) => boolean]> = [["none", () => true], ["bull", (i) => bull[i]!], ["move", (i) => bull[i]! || bear[i]!]];
const ONSETS = ["2007-12-03", "2020-02-20"];
const REC: Array<[string, string]> = [["2007-12-01", "2009-06-30"], ["2020-02-01", "2020-04-30"]];
const inRec = (dt: string) => REC.some(([a, b]) => dt >= a && dt <= b);
const oIdx = ONSETS.map((o) => d.findIndex((x) => x >= o));
const useful = (i: number) => inRec(d[i]!) || oIdx.some((oi) => i <= oi && oi - i <= 504);
const shipped = postInversionCutSeries(v, cfg, d);
const shippedFire = v.map((x, i) => (shipped[i] !== null && x < shipped[i]!) || x < 0.5);

console.log(`today ${d[N - 1]} spread ${v[N - 1]!.toFixed(2)}; shipped-fire today ${shippedFire[N - 1]}`);
console.log("win  drop  gate | lead'07 lead'20 |  FP%  | cut today | +days vs shipped | 2026 fire-days");
for (const w of [126, 252]) {
  const mx = v.map((_, i) => (i < w ? null : Math.max(...v.slice(i - w, i + 1))));
  for (const x of [0.4, 0.5, 0.6, 0.75]) {
    for (const [gname, gfn] of GATES) {
      const cut = mx.map((m) => (m === null ? null : m - x));
      const fire = v.map((y, i) => cut[i] !== null && y < cut[i]! && gfn(i));
      const lead = (oi: number) => { for (let i = Math.max(0, oi - 504); i <= oi; i++) if (fire[i]) return `${oi - i}d`; return "none"; };
      const fp = fire.filter((f, i) => f && !useful(i)).length / d.filter((_, i) => !useful(i)).length;
      const extra = fire.filter((f, i) => f && !shippedFire[i]!).length;
      const y26 = fire.filter((f, i) => f && d[i]!.startsWith("2026")).length;
      console.log(`${String(w).padStart(3)}  ${x.toFixed(2)}  ${gname.padEnd(4)} | ${lead(oIdx[0]!).padStart(6)} ${lead(oIdx[1]!).padStart(6)} | ${(100 * fp).toFixed(1).padStart(5)}% | ${(v[N - 1]! < (cut[N - 1] ?? -9) ? "FIRES " : "silent")} ${cut[N - 1]!.toFixed(2)} | ${String(extra).padStart(4)} | ${String(y26).padStart(3)}`);
    }
  }
}
