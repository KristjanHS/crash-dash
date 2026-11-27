/**
 * BUND velocity/regime scorer probe —
 * `npm run probe:bund-velocity [-- --a1=0.20 --a2=0.30 --esc-2y=0.30 --esc-window=60 --rebound=0.10 --dates]`.
 * READ-ONLY, stores nothing. Drives the REAL `fetchBundYield` (Y10/Y02 from 2005) + `fetchDailyCloses`
 * (EU-Fin: EXSH.DE → EXSA.DE, first that reaches 2008; neither → exit 1) and scores the shipped
 * `bundLegSeries` per day — legs (a)/(b)/(c) of `scoreBundCurve`. Knob defaults = `BUND_DESCRIPTOR.scorer.constants`.
 * Episodes: zigzag on EU-Fin closes — a ≥5% fall from the running peak opens one, a `--rebound` rally off
 * the trough closes it. Cells = first AMBER/RED in [peak−60, trough] as EU-Fin trading-day offset vs the
 * peak (`*` = already on at window start); BUND is as-of joined onto the EU-Fin calendar.
 * Exit 1 when any leg's AMBER-or-worse share over the full BUND window is 0% or 100% (the can-fail arm).
 */
import { fetchBundYield } from "../src/bundesbank.js";
import { fetchDailyCloses } from "../src/prices.js";
import { BUND_DESCRIPTOR } from "../src/family-descriptor-rows.js";
import { bundLegSeries, ratioSpreadPoints } from "../src/scorers-composite.js";
import { alignByDate } from "../src/scorers-core.js";
import { resolveBands } from "../src/threshold-config.js";
import { STATE_RANK, VELOCITY_WINDOW, type Observation } from "../src/domain-types.js";
import { readEnv } from "../src/config.js";

const env = readEnv();

const arg = (name: string, fallback: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split("=")[1]) : fallback;
};
const K = BUND_DESCRIPTOR.scorer.constants;
const a1 = arg("a1", K.velAmber);
const a2 = arg("a2", K.velRed);
const esc2y = arg("esc-2y", K.escDrop2y);
const escWindow = arg("esc-window", K.escWindow);
const rebound = arg("rebound", 0.1);
const showDates = process.argv.includes("--dates");
const DD = 0.05;
const PRE = 60;
const GRID = [0.15, 0.2, 0.25, 0.3];
const SINCE = "2005-01-01";
const W = VELOCITY_WINDOW;

const [y10, y02] = await Promise.all([
  fetchBundYield("Y10", { sinceDate: SINCE, now: new Date().toISOString().slice(0, 10) }),
  fetchBundYield("Y02", { sinceDate: SINCE, now: new Date().toISOString().slice(0, 10) }),
]);
const spread = ratioSpreadPoints(BUND_DESCRIPTOR, y10, y02);
const { b: two } = alignByDate(y10, y02);
if (spread.length < 3000) {
  console.error(`FAIL: only ${spread.length} aligned Y10/Y02 rows`);
  process.exit(1);
}

const lookbackDays = Math.ceil((Date.now() - Date.parse(SINCE)) / 86_400_000);
let eu: Observation[] = [];
let sym = "";
for (const s of ["EXSH.DE", "EXSA.DE"]) {
  try {
    const o = await fetchDailyCloses(s, { deep: true, lookbackDays, now: Date.now, env });
    if (o.length > 0 && o[0]!.date < "2009-01-01") [eu, sym] = [o, s];
  } catch (e) {
    console.error(`${s}: ${(e as Error).message}`);
  }
  if (sym) break;
}
if (!sym) {
  console.error("FAIL: no EU-Fin symbol reaches 2008");
  process.exit(1);
}

// Per-BUND-day leg ranks (0 G · 1 A · 2 R); undefined inside the Δ20 head.
const lvl = resolveBands("BUND", BUND_DESCRIPTOR.amber, BUND_DESCRIPTOR.red, false);
const s = spread.map((p) => p.value);
const knobs = { velAmber: a1, velRed: a2, escDrop2y: esc2y, escWindow };
const legs = bundLegSeries(s, two, lvl.amber, knobs).map((l, i) => {
  if (!l) return undefined;
  const [a, b, c, w] = [l.a, l.b, l.c, l.state].map((x) => STATE_RANK[x]);
  return { date: spread[i]!.date, d: Math.abs(l.delta), a: a!, b: b!, c: c!, w: w! };
});
const scored = legs.filter((l) => l !== undefined);
const share = (f: (l: (typeof scored)[number]) => boolean) =>
  (100 * scored.filter(f).length) / scored.length;

// As-of join: EU-Fin day k → the latest BUND day ≤ it.
const asOf: ((typeof legs)[number])[] = [];
for (let k = 0, j = -1; k < eu.length; k++) {
  while (j + 1 < spread.length && spread[j + 1]!.date <= eu[k]!.date) j++;
  asOf.push(j >= 0 ? legs[j] : undefined);
}

// Zigzag episodes on EU-Fin closes.
const eps: { pk: number; tr: number; open: boolean }[] = [];
let up = true;
let pk = 0;
let tr = 0;
eu.forEach((o, i) => {
  if (up) {
    if (o.value > eu[pk]!.value) pk = i;
    else if (o.value <= eu[pk]!.value * (1 - DD)) [up, tr] = [false, i];
  } else if (o.value < eu[tr]!.value) tr = i;
  else if (o.value >= eu[tr]!.value * (1 + rebound)) {
    eps.push({ pk, tr, open: false });
    [up, pk] = [true, i];
  }
});
if (!up) eps.push({ pk, tr, open: true });

type Key = "a" | "b" | "c" | "w";
const first = (e: (typeof eps)[number], k: Key, lv: number, cut?: number) => {
  const start = Math.max(0, e.pk - PRE);
  for (let i = start; i <= e.tr; i++) {
    const l = asOf[i];
    if (l && (cut === undefined ? l[k] >= lv : l.d >= cut)) return { i, atStart: i === start };
  }
  return undefined;
};
const cell = (e: (typeof eps)[number], k: Key, lv: number) => {
  const f = first(e, k, lv);
  if (!f) return "·";
  const off = f.i - e.pk;
  return (showDates ? eu[f.i]!.date : `${off > 0 ? "+" : ""}${off}`) + (f.atStart ? "*" : "");
};
const pad = (x: string, n: number) => x.padStart(n);
const pctS = (x: number) => `${x.toFixed(1)}%`;

const L = legs[legs.length - 1]!;
console.log(
  `EU-Fin ${sym} ${eu.length} closes ${eu[0]!.date} → ${eu[eu.length - 1]!.date} | BUND 10y−2y ${spread.length} obs ${spread[0]!.date} → ${L.date}`,
);
console.log(
  `today: slope ${s[s.length - 1]!.toFixed(2)}pp |Δ20| ${L.d.toFixed(2)} 2yΔ20 ${(two[two.length - 1]! - two[two.length - 1 - W]!).toFixed(2)}  legs a${L.a} b${L.b} c${L.c}`,
);
console.log(
  `knobs: a1 ${a1} a2 ${a2} pp | (b) level cut amber ${lvl.amber} (single cut, never RED) | (c) esc-2y ${esc2y}pp esc-window ${escWindow} obs | rebound ${rebound}`,
);
const sa = share((l) => l.a >= 1);
const sb = share((l) => l.b >= 1);
const sc = share((l) => l.c >= 1);
console.log(
  `\nfiring share (${scored.length} scored BUND days): (a) amber+ ${pctS(sa)} red ${pctS(share((l) => l.a >= 2))} | (b) amber ${pctS(sb)} | (c) red ${pctS(sc)} | worst-of amber+ ${pctS(share((l) => l.w >= 1))} red ${pctS(share((l) => l.w >= 2))}`,
);
console.log(`\n|Δ20| cut  share   eps firing ≤peak / in window (of ${eps.length})`);
for (const c of GRID) {
  const pre = eps.filter((e) => {
    const f = first(e, "a", 0, c);
    return f && f.i <= e.pk;
  }).length;
  const any = eps.filter((e) => first(e, "a", 0, c)).length;
  console.log(`  ${c.toFixed(2)}    ${pad(pctS(share((l) => l.d >= c)), 6)}   ${pad(String(pre), 2)} / ${any}`);
}
console.log(
  `\nepisodes ≥${DD * 100}% (offset = EU-Fin trading days vs peak; A/R = first AMBER/RED in [peak−${PRE}, trough])`,
);
console.log(`  peak       trough      depth   (a) A / R      (b) A    (c) R    worst A / R`);
const hit = { a: 0, b: 0, c: 0, w: 0 };
for (const e of eps) {
  for (const k of ["a", "b", "c", "w"] as const) {
    const f = first(e, k, 1);
    if (f && f.i <= e.pk) hit[k]++;
  }
  const depth = (100 * (1 - eu[e.tr]!.value / eu[e.pk]!.value)).toFixed(0);
  const w = showDates ? 11 : 5;
  console.log(
    `  ${eu[e.pk]!.date} ${eu[e.tr]!.date}${e.open ? "~" : " "} ${pad(`-${depth}%`, 5)}  ${pad(cell(e, "a", 1), w)} / ${pad(cell(e, "a", 2), w)}  ${pad(cell(e, "b", 1), w)}  ${pad(cell(e, "c", 2), w)}  ${pad(cell(e, "w", 1), w)} / ${pad(cell(e, "w", 2), w)}`,
  );
}
console.log(
  `amber+ at/before peak: (a) ${hit.a} · (b) ${hit.b} · (c) ${hit.c} · worst ${hit.w}  of ${eps.length} episodes (~ = open)`,
);

const degenerate = (
  [
    ["(a)", sa],
    ["(b)", sb],
    ["(c)", sc],
  ] as const
).filter(([, v]) => v === 0 || v === 100);
if (degenerate.length) {
  console.error(`FAIL: leg firing share degenerate — ${degenerate.map(([n, v]) => `${n} ${v}%`).join(", ")}`);
  process.exit(1);
}
