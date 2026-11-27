// R1 leg marginal-contribution probe — which of R1's threshold legs still earn their place, and
// which are SLOW (only fire long after the level has already moved). Run: `npx tsx scripts/probe-r1-leg-marginal.ts`.
// Legs measured (the four independent triggers; the two secondary-axis lines are AND-gates on
// legs 3/4, not triggers of their own):
//   amber-static  v < AMBER_STATIC                   (the fixed 0.5 cut, RETIRED 2026-08-30 —
//                                                     kept as a measurable arm, see the const)
//   amber-armed   v < armed expanding-percentile cut (postInversionCutSeries, needs qualifyN arming)
//   amber-drawdn  regime-relative drawdown leg       (126d high − dropPp, |short move| gate)
//   red-static    v < thresholds.redLevel            (fixed 0.0)
// Columns: fire = firing days; sole = days this leg is the ONLY firer (drop it ⇒ GREEN that day);
// lag = median obs between a 0.40pp fall over 126d completing and this leg first firing (the
// responsiveness number — lower is faster); lead'07/'20 = earliest fire inside the 504-obs run-up
// to the NBER onset; calm% = firing days neither in nor running up to a recession.
import { realFeeds } from "../src/feed-ports.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { T10Y3M_DRAWDOWN } from "../src/registry-fred.js";
import { postInversionCutSeries, drawdownCutSeries, steepenerEscalationSeries } from "../src/scorers-core.js";
import { readEnv } from "../src/config.js";

const env = readEnv();

const SINCE = "2006-01-01";
const R1 = ALL_INDICATORS.find((i) => i.id === "R1")!;
const cfg = R1.postInversionCooldown!;
const dd = T10Y3M_DRAWDOWN; // un-wired from R1 2026-08-31 — the leg stays as code
const [obs, short] = await Promise.all([realFeeds.fetchSeries("T10Y3M", { since: SINCE, now: new Date(), env }), realFeeds.fetchSeries("DGS3MO", { since: SINCE, now: new Date(), env })]);
const v = obs.map((o) => o.value), d = obs.map((o) => o.date), N = v.length;

// The RETIRED fixed amber cut ([USER] 2026-08-30). Held here as a local because the registry knob
// it used to read is GONE — `R1.thresholds.amberLevel` would be `undefined`, `x < undefined` is
// always false, and the leg's row would report `fire=0` (reading as "never fires", not "removed")
// with no throw. This probe is the cited command for re-deciding the ruling, so its retired arm has
// to keep measuring; ⛔ never re-point it at the registry.
const AMBER_STATIC = 0.5;

const armedCut = postInversionCutSeries(v, cfg, d);
const ddCut = drawdownCutSeries(v, dd);
const ddGate = steepenerEscalationSeries(obs, short, { shortLegWindow: dd.gateWindow, shortLegDropBp: dd.gateBp }, "either");
const bull = steepenerEscalationSeries(obs, short, cfg);

const legs: Array<[string, boolean[]]> = [
  ["amber-static", v.map((x) => x < AMBER_STATIC)],
  ["amber-armed", v.map((x, i) => armedCut[i] !== null && x < armedCut[i]!)],
  ["amber-drawdn", v.map((x, i) => ddCut[i] !== null && x < ddCut[i]! && ddGate[i]!)],
  ["red-static", v.map((x) => x < R1.thresholds.redLevel!)],
];

const ONSETS = ["2007-12-03", "2020-02-20"];
const REC: Array<[string, string]> = [["2007-12-01", "2009-06-30"], ["2020-02-01", "2020-04-30"]];
const inRec = (dt: string) => REC.some(([a, b]) => dt >= a && dt <= b);
const oIdx = ONSETS.map((o) => d.findIndex((x) => x >= o));
const useful = (i: number) => inRec(d[i]!) || oIdx.some((oi) => i <= oi && oi - i <= 504);
const calmDays = d.filter((_, i) => !useful(i)).length;

// Responsiveness: every index where a 0.40pp fall over the trailing 126 obs has just COMPLETED
// (crossing day). How many obs until each leg first fires from there?
const W = 126, DROP = 0.4;
const fell = v.map((x, i) => i >= W && Math.max(...v.slice(i - W, i + 1)) - x >= DROP);
const events = fell.map((f, i) => (f && !fell[i - 1] ? i : -1)).filter((i) => i > 0);
const median = (a: number[]) => (a.length === 0 ? NaN : a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]!);

console.log(`T10Y3M ${d[0]}..${d[N - 1]}  N=${N}  today=${v[N - 1]!.toFixed(2)}`);
console.log(`armed cut today ${armedCut[N - 1]?.toFixed(2) ?? "unarmed"} | drawdown cut today ${ddCut[N - 1]?.toFixed(2)} | gate today ${ddGate[N - 1]}`);
console.log(`fall events (${DROP}pp/${W}obs completions): ${events.length}\n`);
console.log("leg           | fire | sole | lag(med) | new/latched/miss | lead'07 | lead'20 | calm%  | fires today");
for (const [name, fire] of legs) {
  const others = legs.filter(([n]) => n !== name).map(([, f]) => f);
  const sole = fire.filter((f, i) => f && !others.some((o) => o[i])).length;
  const lags: number[] = [];
  let already = 0, never = 0;
  for (const e of events) {
    if (fire[e]) { already++; continue; }            // latched on BEFORE the fall — no response to measure
    let hit = -1;
    for (let i = e; i < N && i < e + 504; i++) if (fire[i]) { hit = i - e; break; }
    if (hit < 0) never++; else lags.push(hit);
  }
  const lead = (oi: number) => { for (let i = Math.max(0, oi - 504); i <= oi; i++) if (fire[i]) return `${oi - i}d`; return "none"; };
  const calm = fire.filter((f, i) => f && !useful(i)).length / calmDays;
  console.log(
    `${name.padEnd(13)} | ${String(fire.filter(Boolean).length).padStart(4)} | ${String(sole).padStart(4)} | ` +
    `${String(median(lags)).padStart(8)} | ${String(lags.length).padStart(3)}/${String(already).padStart(3)}/${String(never).padStart(3)} | ${lead(oIdx[0]!).padStart(7)} | ${lead(oIdx[1]!).padStart(7)} | ` +
    `${(100 * calm).toFixed(1).padStart(5)}% | ${fire[N - 1] ? "YES" : "no"}`,
  );
}

// Escalation reach: red days the bull gate manufactures on top of red-static.
const redStatic = legs[3]![1];
const esc = v.map((_, i) => (armedCut[i] !== null && v[i]! < armedCut[i]! && bull[i]!));
console.log(`\nred-escalation (armed AND bull-fall≥${cfg.shortLegDropBp}bp): fire ${esc.filter(Boolean).length}, sole ${esc.filter((f, i) => f && !redStatic[i]).length}, today ${esc[N - 1] ? "YES" : "no"}`);

// Recent picture: last 400 obs, per-leg firing counts + the first day each leg turned on in 2026.
const recent = (fire: boolean[]) => fire.slice(-400).filter(Boolean).length;
const runs = (f: boolean[]) => { const r: number[] = []; let c = 0; for (const x of f) { if (x) c++; else if (c) { r.push(c); c = 0; } } if (c) r.push(c); return r; };
console.log("\nrun lengths (consecutive firing days):", legs.map(([n, f]) => { const r = runs(f); return `${n}: n=${r.length} med=${median(r)} max=${Math.max(...r)}`; }).join(" | "));
console.log("\nlast 400 obs firing days:", legs.map(([n, f]) => `${n}=${recent(f)}`).join("  "), `| red-esc=${recent(esc)}`);

// --- Counterfactual: R1's REAL confirmed state (full scorer path) with each leg removed ---------
const { indicatorReadingSeries } = await import("../src/scorers-core.js");
const variant = (name: string, mut: (i: typeof R1) => typeof R1) => {
  const rs = indicatorReadingSeries(mut(structuredClone(R1)), obs, undefined, undefined, short);
  const off = obs.length - rs.length;
  const st = rs.map((r) => r.state);
  const elev = st.filter((s) => s !== "GREEN").length;
  const red = st.filter((s) => s === "RED").length;
  const calm = st.filter((s, k) => s !== "GREEN" && !useful(k + off)).length / calmDays;
  const lead = (oi: number) => { for (let k = Math.max(0, oi - off - 504); k <= oi - off; k++) if (st[k] !== "GREEN") return `${oi - off - k}d`; return "none"; };
  const last400 = st.slice(-400);
  console.log(
    `${name.padEnd(22)} | ${String(elev).padStart(4)} | ${String(red).padStart(4)} | ${(100 * calm).toFixed(1).padStart(5)}% | ` +
    `${lead(oIdx[0]!).padStart(6)} | ${lead(oIdx[1]!).padStart(6)} | ${String(last400.filter((s) => s !== "GREEN").length).padStart(3)}/400 | ${st[st.length - 1]}`,
  );
};
// ⚠ POLARITY: `amber-static` is RETIRED, so its arm RE-ADDS the cut rather than removing it — the
// shipped row is the "without" side and `+amber-static` the "with". Every other arm still removes.
console.log("\nvariant                | elev |  red | calm%  | ld'07  | ld'20  | last400 | today");
variant("shipped (live legs)", (i) => i);
variant("+amber-static(0.5)", (i) => ({ ...i, thresholds: { ...i.thresholds, amberLevel: AMBER_STATIC } }));
variant("−red-static(0.0)", (i) => ({ ...i, thresholds: { ...i.thresholds, redLevel: -99 } }));
variant("−armed rung", (i) => ({ ...i, postInversionCooldown: undefined }));
variant("−drawdown leg", (i) => ({ ...i, drawdownLeg: undefined }));
variant("−drawdown move gate", (i) => ({ ...i, drawdownLeg: { ...i.drawdownLeg!, gateBp: 0 } }));
