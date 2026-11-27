/**
 * Stage 1.1 GATE probe — does the Baa−Aaa quality-spread bridge predict EBP's next print?
 * Pre-registered, stopping rule R6/R7.
 *
 *   npx tsx scripts/probe-cqs-ebp-bridge.ts
 *
 * Feeds only (no store, no env): `fetchEbp()` (keyless Fed CSV) + `fetchSeries` for BAA10Y/AAA10Y
 * (keyless FRED CSV fallback when no key). `spread = BAA10Y − AAA10Y`, inner-joined by date.
 *
 * Bridge statistic (origin §3.2 / archived Stage 3): for each
 * consecutive EBP print pair (prev→cur), `signal = sign(spread(print_date − 1 trading day) −
 * spread(anchor(prev)))` predicts `outcome = sign(EBP(cur) − EBP(prev))`. The signal endpoint is measured the
 * trading day BEFORE cur's print lands (the honest end of the live bridge window, ~4 business days past the
 * month-end), NOT at the month-end. EBP rows carry only the month label, so cur's print date is DERIVED as
 * the 4th business day after `anchor(cur)` (the Fed posts on the 4th business day of the following month);
 * the endpoint is then the last daily spread strictly before that date. `anchor(label)` is the month-END of
 * the label month (R2: label 2026-07-01 describes July, anchors 2026-07-31); the subtracted anchor is
 * `anchor(prev)`. Directional hit rate ≥ 0.60 (R6). Placebo (R7): K=1000 pinned-seed arms recompute the same
 * statistic with the SAME subtracted-anchor term drawn at random from the daily spread history (endpoint
 * unchanged); the real arm must be strictly above the 2.5–97.5 band.
 *
 * TIE CONVENTION (R8, ruled `[USER]` 2026-08-16): a flat bridge (`sCur === sPrev`) is a NO-CALL and is
 * EXCLUDED from the denominator — `rateExcl` is the load-bearing verdict; `rateMiss` prints as context only.
 * Merit: BAA10Y/AAA10Y publish at 2dp, so a flat bridge means the move is below the feed's own resolution.
 * ⚠ Do NOT re-pick the convention to move a verdict — that is a re-cut, banned by the stopping rule below.
 *
 * ⚠ REVISED-VINTAGE LIMITATION ([USER] 2026-08-16, printed beside the verdict): this backtest runs on
 * today's fully-revised EBP vintage — EBP restates its entire history each month and the Fed overwrites
 * one permanent CSV, so no real-time vintage archive exists and the real-time hit rate may differ.
 *
 * STOPPING RULE (R6/R7): if either bar misses that is a legitimate, successful outcome — the probe reds
 * and the arc stops. Do NOT re-cut a threshold, add an arm, or tune the anchor. Exits 1 if any of the
 * four checks fails; 0 only when all pass.
 */
import { fetchEbp } from "../src/ebp.js";
import { realFeeds } from "../src/feed-ports.js";
import type { Observation } from "../src/domain-types.js";
import { isoDay } from "../src/dates.js";
import { readEnv } from "../src/config.js";

const env = readEnv();

const HIT_RATE_BAR = 0.6; // R6 (UNMOVED — no post-hoc fitting)
const K = 1000; // R7 placebo arms
const SEED = 0x9e3779b9; // R7 — PINNED so the placebo band is reproducible

const CAVEAT =
  "CAVEAT (revised vintage): this backtest runs on today's fully-revised EBP vintage — EBP restates its\n" +
  "  entire history each month and the Fed overwrites one permanent CSV, so no real-time vintage archive\n" +
  "  exists and the real-time hit rate may differ.";

/** Pinned-seed PRNG (mulberry32) — deterministic; the repo has no seeded RNG and Math.random is banned here. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sign = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);
const ym = (iso: string): string => iso.slice(0, 7);
const monthsBetween = (ym1: string, ym2: string): number => {
  const [y1, m1] = ym1.split("-").map(Number);
  const [y2, m2] = ym2.split("-").map(Number);
  return (y2! - y1!) * 12 + (m2! - m1!);
};
/** R2 anchor: the month-END of the label month (label 2026-07-01 → 2026-07-31). */
const monthEndOf = (labelIso: string): string => {
  const [y, m] = labelIso.split("-").map(Number);
  return isoDay(new Date(Date.UTC(y!, m, 0))); // m is 1-based → day 0 of month m+1 = last day of m
};

// --- feeds --------------------------------------------------------------------------------------
const [ebpRaw, baa, aaa] = await Promise.all([
  fetchEbp(),
  realFeeds.fetchSeries("BAA10Y", { fullHistory: true, now: new Date(), env }),
  realFeeds.fetchSeries("AAA10Y", { fullHistory: true, now: new Date(), env }),
]);

const ebp = [...ebpRaw].sort((p, q) => p.date.localeCompare(q.date));

// Inner-join the two daily FRED series by date → the spread series, sorted ascending.
const aaaByDate = new Map(aaa.map((o) => [o.date, o.value]));
const spread: Observation[] = baa
  .filter((o) => aaaByDate.has(o.date))
  .map((o) => ({ date: o.date, value: o.value - aaaByDate.get(o.date)! }))
  .sort((p, q) => p.date.localeCompare(q.date));
const spreadDates = spread.map((o) => o.date);
const spreadVals = spread.map((o) => o.value);

/** Last daily spread at or before `date` (rightmost date ≤ target); undefined if none. */
function spreadAtOrBefore(date: string): number | undefined {
  let lo = 0,
    hi = spreadDates.length - 1,
    ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spreadDates[mid]! <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans === -1 ? undefined : spreadVals[ans]!;
}

/** Last daily spread STRICTLY before `date` (= `date` − 1 trading day on the spread calendar); undefined if none. */
function spreadStrictlyBefore(date: string): number | undefined {
  let lo = 0,
    hi = spreadDates.length - 1,
    ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spreadDates[mid]! < date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans === -1 ? undefined : spreadVals[ans]!;
}

/** `n`-th business day (Mon–Fri) strictly after `iso`; the Fed posts EBP on the 4th business day of the
 *  following month, so `addBusinessDays(anchor(cur), 4)` derives cur's print date from its month label. */
function addBusinessDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) added++;
  }
  return isoDay(d);
}

console.log(
  `[probe:cqs-bridge] feeds: EBP ${ebp.length} prints (${ebp[0]?.date}→${ebp.at(-1)?.date}); ` +
    `spread ${spread.length} daily obs (${spreadDates[0]}→${spreadDates.at(-1)}).`,
);

// --- CHECK 1: R2 anchor premise — newest EBP label strictly BEFORE the fetch month ---------------
const newestLabelYm = ym(ebp.at(-1)!.date);
const fetchYm = ym(isoDay(new Date()));
if (!(newestLabelYm < fetchYm)) {
  console.error(
    `[probe:cqs-bridge] CHECK 1 FAIL: newest EBP label month ${newestLabelYm} is NOT strictly before the ` +
      `fetch month ${fetchYm} — a month-START convention would permit a current-month row. STOP and re-ask.`,
  );
  process.exit(1);
}
console.log(
  `[probe:cqs-bridge] CHECK 1 PASS: newest EBP label month ${newestLabelYm} < fetch month ${fetchYm} ` +
    `(R2 month-END anchor premise holds).`,
);

// --- CHECK 2: derived-n — usable monthly prints === month-count derived from the join's own ends --
// A print is usable when its month-END anchor has a spread observation at or before it (this binds the
// inner join at BAA10Y's 1986 start, not EBP's 1973). Never a hardcoded literal (487 is today's value).
const usable = ebp.filter((p) => spreadAtOrBefore(monthEndOf(p.date)) !== undefined);
const firstYm = ym(usable[0]!.date);
const lastYm = ym(usable.at(-1)!.date);
const expectedN = monthsBetween(firstYm, lastYm) + 1;
if (usable.length !== expectedN) {
  const present = new Set(usable.map((p) => ym(p.date)));
  const missing: string[] = [];
  for (let k = 0; k <= monthsBetween(firstYm, lastYm); k++) {
    const [y, m0] = firstYm.split("-").map(Number);
    const d = new Date(Date.UTC(y!, m0! - 1 + k, 1)).toISOString().slice(0, 7);
    if (!present.has(d)) missing.push(d);
  }
  console.error(
    `[probe:cqs-bridge] CHECK 2 FAIL: ${usable.length} usable prints ≠ ${expectedN} derived from ` +
      `${firstYm}→${lastYm}. Missing months: ${missing.join(", ")}.`,
  );
  process.exit(1);
}
console.log(
  `[probe:cqs-bridge] CHECK 2 PASS: ${usable.length} usable monthly prints === ${expectedN} derived ` +
    `from the join's own first/last (${firstYm}→${lastYm}).`,
);

// --- BAR 1 (R6): directional hit rate on consecutive usable prints -------------------------------
// signal = sign(spread(print_date(cur) − 1 trading day) − spread(anchor(prev))); outcome = sign(EBP(cur) − EBP(prev)).
// cur's print date is the 4th business day after anchor(cur) (Fed cadence); the endpoint is the last daily
// spread strictly before it — the freshest observation the live bridge sees just before the next print lands.
// A flat bridge (`sCur === sPrev`) yields `sign()===0` and is a NO-CALL: R8 excludes it from the
// denominator, so `rateExcl` is the verdict and `rateMiss` is printed as context only.
const outcomes: number[] = [];
const sCurs: number[] = [];
const signals: number[] = [];
let signalTies = 0; // sCur === sPrev  (flat bridge — the no-call pairs)
let outcomeTies = 0; // EBP(cur) === EBP(prev)  (flat outcome — reviewer expects 0)
for (let i = 1; i < usable.length; i++) {
  const prev = usable[i - 1]!,
    cur = usable[i]!;
  const sPrev = spreadAtOrBefore(monthEndOf(prev.date));
  const printDate = addBusinessDays(monthEndOf(cur.date), 4);
  const sCur = spreadStrictlyBefore(printDate);
  // Explicit refusal to score a missing endpoint: `sign(NaN)===0` would otherwise become a silent miss.
  if (sPrev === undefined || sCur === undefined) {
    throw new Error(
      `[probe:cqs-bridge] bridge endpoint missing for pair ${prev.date}→${cur.date} ` +
        `(sPrev=${sPrev}, sCur=${sCur}) — a usable-print invariant broke; refusing to score it as a tie/miss.`,
    );
  }
  const sg = sign(sCur - sPrev);
  const oc = sign(cur.value - prev.value);
  if (sg === 0) signalTies++;
  if (oc === 0) outcomeTies++;
  sCurs.push(sCur);
  signals.push(sg);
  outcomes.push(oc);
}
const nPairs = outcomes.length;
let hits = 0;
for (let i = 0; i < nPairs; i++) if (signals[i] !== 0 && signals[i] === outcomes[i]) hits++;

const nExcl = nPairs - signalTies; // ties-excluded denominator (no-call pairs dropped)
const rateMiss = hits / nPairs; // ties-as-misses (flat bridge counted as a wrong call)
const rateExcl = hits / nExcl; // ties-excluded (flat bridge = no call)
const missPass = rateMiss >= HIT_RATE_BAR;
const exclPass = rateExcl >= HIT_RATE_BAR;
console.log(
  `[probe:cqs-bridge] BAR 1 (R6, bar ≥ ${(HIT_RATE_BAR * 100).toFixed(0)}%): ` +
    `${signalTies} signal ties (flat bridge), ${outcomeTies} outcome ties (flat EBP)`,
);
console.log(
  `  ties-as-misses: ${hits}/${nPairs} = ${(rateMiss * 100).toFixed(2)}% (${missPass ? "PASS" : "FAIL"})`,
);
console.log(
  `  ties-excluded:  ${hits}/${nExcl} = ${(rateExcl * 100).toFixed(2)}% (${exclPass ? "PASS" : "FAIL"})`,
);

// --- BAR 2 (R7): pinned-seed placebo — random anchors drawn from the daily spread history ---------
// Each arm keeps sCur and the outcomes identical, replacing only the SUBTRACTED anchor with a random
// daily-spread value (per pair). Both tie conventions are reported so the real and placebo arms are the
// SAME statistic under each rule — the reviewer's asymmetry: the real arm eats many ties (adjacent-month
// spreads repeat at 2dp), a random-anchor arm should eat far fewer, so ties-as-misses is not symmetric.
const rand = mulberry32(SEED);
const armRatesMiss: number[] = [];
const armRatesExcl: number[] = [];
let totalArmTies = 0;
for (let k = 0; k < K; k++) {
  let armHits = 0,
    armTies = 0;
  for (let i = 0; i < nPairs; i++) {
    const r = spreadVals[Math.floor(rand() * spreadVals.length)]!;
    const sg = sign(sCurs[i]! - r);
    if (sg === 0) armTies++;
    else if (sg === outcomes[i]) armHits++;
  }
  totalArmTies += armTies;
  armRatesMiss.push(armHits / nPairs);
  armRatesExcl.push(armHits / (nPairs - armTies));
}
const meanArmTies = totalArmTies / K;
const bandOf = (rates: number[]): [number, number] => {
  const s = [...rates].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.min(K - 1, Math.max(0, Math.round(p * (K - 1))))]!;
  return [at(0.025), at(0.975)];
};
const [loMiss, hiMiss] = bandOf(armRatesMiss);
const [loExcl, hiExcl] = bandOf(armRatesExcl);
const bar2MissPass = rateMiss > hiMiss;
const bar2ExclPass = rateExcl > hiExcl;
console.log(
  `[probe:cqs-bridge] BAR 2 (R7, K=${K}, seed=0x${SEED.toString(16)}): ` +
    `real arm ${signalTies} ties vs placebo mean ${meanArmTies.toFixed(2)} ties/arm ` +
    `— the tie penalty is asymmetric, so the arms are the same statistic only WITHIN a convention`,
);
console.log(
  `  ties-as-misses: band [${(loMiss * 100).toFixed(2)}%, ${(hiMiss * 100).toFixed(2)}%] · ` +
    `real ${(rateMiss * 100).toFixed(2)}% ${rateMiss > hiMiss ? ">" : "≤"} upper (${bar2MissPass ? "PASS" : "FAIL"})`,
);
console.log(
  `  ties-excluded:  band [${(loExcl * 100).toFixed(2)}%, ${(hiExcl * 100).toFixed(2)}%] · ` +
    `real ${(rateExcl * 100).toFixed(2)}% ${rateExcl > hiExcl ? ">" : "≤"} upper (${bar2ExclPass ? "PASS" : "FAIL"})`,
);

// --- verdict (R8 convention: ties excluded) -------------------------------------------------------
// Both bars are evaluated on the ties-excluded statistic; either missing reds the gate and ends the arc.
const gatePass = exclPass && bar2ExclPass;
console.log(`\n  ${CAVEAT}\n`);
console.log(
  `[probe:cqs-bridge] VERDICT: ${gatePass ? "PASS" : "FAIL"} (R8: ties excluded) — ` +
    `BAR 1 ${(rateExcl * 100).toFixed(2)}% vs bar ${(HIT_RATE_BAR * 100).toFixed(0)}% ` +
    `(${exclPass ? "PASS" : "FAIL"}); BAR 2 real ${(rateExcl * 100).toFixed(2)}% vs band upper ` +
    `${(hiExcl * 100).toFixed(2)}% (${bar2ExclPass ? "PASS" : "FAIL"}). Context only: ties-as-misses ` +
    `${(rateMiss * 100).toFixed(2)}% (${missPass ? "PASS" : "FAIL"}). ` +
    (gatePass
      ? `Gate PASSED — Stages 2.1/3.1 open.`
      : `Gate FAILED — STOP the arc; do NOT re-cut, do NOT add an arm, do NOT re-pick the convention.`),
);
process.exit(gatePass ? 0 : 1);
