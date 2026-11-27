/**
 * Read-only probe: R7's DYNAMIC ranked cuts — which history may they be ranked against, and how far
 * is the STORED ribbon from the model that now scores it? Written 2026-08-14 when
 * those cuts were drawn on the detail chart.
 *
 *   npm run probe:r7-cuts        # live FRED read, writes NOTHING
 *
 * Two arms, both of which the plan cites as pre-registered expectations:
 *
 *   A  BASE SENSITIVITY — the cuts over the FULL span `src/confirmers.ts` fetches (`fullHistory:
 *      true`) vs over the STORED span only (prod holds 2011-08-02 onward). Measured 2026-08-14:
 *      they disagree — `dropRed` −0.95 vs −0.62, and 140 of 3,486 comparable days (4.0%) score a
 *      different raw state — so the chart branch MUST re-fetch FRED rather than rank stored rows
 *      like CG does, or it draws lines that contradict its own ribbon.
 *
 *   B  RESTATE SIZE — the stored span re-scored under the RETIRED fixed pair (`amber2y` −0.35 /
 *      `red2y` −0.6, no steepening leg) vs under the shipped dynamic ranks. This is the diff
 *      `backfill:raw -- indicators --restate=R7` will write, and the falsifier for that run.
 *      Measured 2026-08-14: 401 of 3,758 rows (10.7%) change, all de-escalating — AMBER→GREEN 363,
 *      RED→AMBER 38.
 *
 *   C  DROP-CUT CANDIDATES — for each candidate drop-cut policy, the stored-span non-GREEN count and
 *      how many of its AMBER days the DROP cut alone earns. Grounds §7 6b's [USER DECISION]; also
 *      prints the recent secondary-axis domain, which is what "off frame" means.
 *
 * ⚠ Arm B's FIXED pair is a HISTORICAL constant, deliberately hard-coded here and nowhere else: it
 * names a model that no longer exists in the source tree (removed by an earlier commit), so it cannot be
 * imported and must never be re-introduced as a live constant.
 *
 * ⚠ Both arms run `bullSteepenerLegSeries` — the scorer's own seam — never a local re-implementation
 * of the legs or the four `expandingPercentile` calls, which is what drifted before 2026-08-14.
 *
 * ⚠ T10Y3M is fetched as the seam's JOIN KEY, not as a ranked leg: neither leg reads it, but the
 * inner join means its 1982-01-04 start sets the ranking base's left edge (DGS2 reaches 1976-06-01).
 */
import { realFeeds } from "../src/feed-ports.js";
import {
  bullSteepenerLegSeries,
  bullSteepenerState,
  type BullSteepenerCuts,
  type BullSteepenerLegs,
} from "../src/scorers-composite.js";
import type { State } from "../src/domain-types.js";
import { expandingPercentile, rollingPercentile } from "../src/percentile.js";
import { BULL_MIN_OBS } from "../src/family-descriptor-rows.js";
import { readEnv } from "../src/config.js";

/** First stored R7 obs_date in prod (measured 2026-08-14 via `/api/series?id=R7`). The store's own
 *  left edge, used to reproduce the stored span without a DB read — this probe is feed-only. */
const STORED_FROM = "2011-08-02";

/** The RETIRED fixed pair (pre-removal). Historical; see the ⚠ above. */
const RETIRED_CUTS: BullSteepenerCuts = {
  dropAmber: -0.35,
  dropRed: -0.6,
  steepAmber: -Infinity, // the old model had no steepening leg — its tail was always "met"
  steepRed: -Infinity,
};

const CUT_KEYS = ["dropAmber", "dropRed", "steepAmber", "steepRed"] as const;

const at = (l: BullSteepenerLegs, i: number): BullSteepenerCuts => ({
  dropAmber: l.cuts.dropAmber[i]!,
  dropRed: l.cuts.dropRed[i]!,
  steepAmber: l.cuts.steepAmber[i]!,
  steepRed: l.cuts.steepRed[i]!,
});
const finite = (c: BullSteepenerCuts): boolean => Object.values(c).every((v) => Number.isFinite(v));

function tally(pairs: Array<[State, State]>): { changed: number; moves: Record<string, number> } {
  const moves: Record<string, number> = {};
  let changed = 0;
  for (const [a, b] of pairs) {
    if (a === b) continue;
    changed++;
    moves[`${a}->${b}`] = (moves[`${a}->${b}`] ?? 0) + 1;
  }
  return { changed, moves };
}

async function main(): Promise<void> {
  const env = readEnv();
  const [spread, dgs2, dgs10] = await Promise.all([
    realFeeds.fetchSeries("T10Y3M", { fullHistory: true, now: new Date(), env }),
    realFeeds.fetchSeries("DGS2", { fullHistory: true, now: new Date(), env }),
    realFeeds.fetchSeries("DGS10", { fullHistory: true, now: new Date(), env }),
  ]);

  const full = bullSteepenerLegSeries(spread, dgs2, dgs10);
  console.log(
    `scorer join population: ${full.dates.length} days, ${full.dates[0]} → ${full.dates.at(-1)}` +
      ` (DGS2 alone reaches ${dgs2[0]!.date})`,
  );

  // The stored-span arm feeds the seam the SLICED observations, so its 20d lookback and its
  // percentile base both start at the store's left edge — the shallow view a stored-rows chart sees.
  const from = (obs: typeof spread) => obs.filter((o) => o.date >= STORED_FROM);
  const shallow = bullSteepenerLegSeries(from(spread), from(dgs2), from(dgs10));
  const shallowAt = new Map(shallow.dates.map((d, i) => [d, i]));

  const last = full.dates.length - 1;
  const lastShallow = shallow.dates.length - 1;
  console.log(`\nA. latest cuts (pp), ${full.dates.at(-1)} — full history vs stored base (${STORED_FROM}+)`);
  for (const k of CUT_KEYS) {
    const f = full.cuts[k][last]!;
    const s = shallow.cuts[k][lastShallow]!;
    console.log(`   ${k.padEnd(10)} full=${f.toFixed(4)}  stored-base=${s.toFixed(4)}  Δ=${(s - f).toFixed(4)}`);
  }

  const basePairs: Array<[State, State]> = [];
  const restatePairs: Array<[State, State]> = [];
  for (let i = 0; i < full.dates.length; i++) {
    const date = full.dates[i]!;
    if (date < STORED_FROM) continue;
    const cFull = at(full, i);
    if (!Number.isFinite(full.drop[i]!) || !finite(cFull)) continue;
    const live = bullSteepenerState(full.drop[i]!, full.d10[i]!, cFull);
    const j = shallowAt.get(date);
    if (j !== undefined) {
      const cShallow = at(shallow, j);
      if (finite(cShallow)) {
        basePairs.push([live, bullSteepenerState(full.drop[i]!, full.d10[i]!, cShallow)]);
      }
    }
    restatePairs.push([bullSteepenerState(full.drop[i]!, full.d10[i]!, RETIRED_CUTS), live]);
  }
  const a = tally(basePairs);
  console.log(
    `\nA. raw-state disagreement, full vs stored base: ${a.changed}/${basePairs.length} ` +
      `(${((a.changed / basePairs.length) * 100).toFixed(1)}%)`,
    a.moves,
  );
  const b = tally(restatePairs);
  console.log(
    `\nB. restate diff (retired fixed pair → shipped dynamic ranks) over the stored span: ` +
      `${b.changed}/${restatePairs.length} (${((b.changed / restatePairs.length) * 100).toFixed(1)}%)`,
    b.moves,
  );
  const leavingNonGreen = Object.entries(b.moves)
    .filter(([k]) => !k.startsWith("GREEN") && k.endsWith("GREEN"))
    .reduce((n, [, v]) => n + v, 0);
  console.log(`   rows leaving the non-GREEN set: ${leavingNonGreen}`);

  // C. What "off frame" means: the secondary axis' domain is the two LEGS alone
  // (D0-a parity).
  const tail = full.dates.map((_d, i) => i).filter((i) => full.dates[i]! >= STORED_FROM);
  const fin = (xs: number[]) => xs.filter(Number.isFinite);
  // The plotted legs are `drop` and `dSteep` (chart-rail.ts `bullLegs.drop`/`bullLegs.steep`) —
  // NOT `d10`, which is only dSteep's input. Read both off the seam; never recompute either here.
  console.log(`\nC. secondary domain by window (both legs) — R7 declares no spec.window, so it draws DETAIL_LIMIT=365:`);
  for (const w of [180, 365, 756, tail.length]) {
    const legVals = fin(tail.slice(-w).flatMap((i) => [full.drop[i]!, full.dSteep[i]!]));
    const lo = Math.min(...legVals);
    const mark = w === 365 ? "  <- what the chart draws today" : "";
    console.log(
      `   ${String(w).padStart(5)} obs: [${lo.toFixed(3)}, ${Math.max(...legVals).toFixed(3)}]` +
        `  dropAmber -0.540 ${lo <= -0.54 ? "IN" : "off"} frame, dropRed -0.950 ${lo <= -0.95 ? "IN" : "off"} frame${mark}`,
    );
  }

  // Candidate drop-cut policies. `null` = keep the shipped expanding-percentile rank for that level.
  const CANDIDATES: Array<{ name: string; dropAmber: number | null; dropRed: number | null }> = [
    { name: "shipped p5/p1 (dynamic)", dropAmber: null, dropRed: null },
    { name: "hand-set 0.0 / -0.1 (§6b as asked)", dropAmber: 0.0, dropRed: -0.1 },
    { name: "hand-set -0.10 / -0.30", dropAmber: -0.1, dropRed: -0.3 },
    { name: "hand-set -0.20 / -0.40", dropAmber: -0.2, dropRed: -0.4 },
    { name: "hand-set -0.25 / -0.50", dropAmber: -0.25, dropRed: -0.5 },
  ];
  console.log(`   stored-span rows scored: ${restatePairs.length}`);
  for (const c of CANDIDATES) {
    let gateOn = 0;
    let nonGreen = 0;
    let red = 0;
    let amberByDropOnly = 0;
    let latestAmber = NaN;
    let latestRed = NaN;
    for (let i = 0; i < full.dates.length; i++) {
      if (full.dates[i]! < STORED_FROM) continue;
      const base = at(full, i);
      if (!Number.isFinite(full.drop[i]!) || !finite(base)) continue;
      const cuts: BullSteepenerCuts = {
        ...base,
        dropAmber: c.dropAmber ?? base.dropAmber,
        dropRed: c.dropRed ?? base.dropRed,
      };
      latestAmber = cuts.dropAmber;
      latestRed = cuts.dropRed;
      // Every quantity comes off the seam — `dSteep` and `shortEndDriven` are its own arrays, and
      // `bullSteepenerState` takes d10y (not dSteep) and derives the curve change internally.
      const d2y = full.drop[i]!;
      const dSteep = full.dSteep[i]!;
      if (full.shortEndDriven[i]) gateOn++;
      const st = bullSteepenerState(d2y, full.d10[i]!, cuts);
      if (st !== "GREEN") nonGreen++;
      if (st === "RED") red++;
      // Does the DROP cut still discriminate? Count AMBER days the steepening cut would NOT have made.
      if (st === "AMBER" && d2y <= cuts.dropAmber && !(dSteep >= cuts.steepAmber)) amberByDropOnly++;
    }
    console.log(
      `   ${c.name.padEnd(36)} non-GREEN=${String(nonGreen).padStart(4)} (RED ${String(red).padStart(3)})` +
        `  gate-on=${gateOn}  AMBER-by-drop-alone=${String(amberByDropOnly).padStart(4)}` +
        `  latest cuts ${latestAmber.toFixed(3)}/${latestRed.toFixed(3)}`,
    );
  }

  // D. WINDOW SWEEP (2026-08-29): the shipped cuts are EXPANDING over a 1982-based join, so ~250
  // new deltas barely move a p5/p1 quantile taken on ~11k — the drawn cut is a straight line. Each
  // candidate re-ranks the SEAM's OWN leg arrays (`full.drop` / `full.dSteep`, never re-derived)
  // under `rollingPercentile`, and reports the raw crossing rate + how far each cut TRAVELS over
  // the last 365 scored days (the F5/SPCONC ruling's evidence shape).
  const SWEEP: Array<{ window: number | null; amberP: number; redP: number; minObs?: number }> = [
    { window: null, amberP: 0.05, redP: 0.01 },
    { window: 1260, amberP: 0.05, redP: 0.01 },
    { window: 756, amberP: 0.05, redP: 0.01 },
    { window: 504, amberP: 0.05, redP: 0.01 },
    { window: 504, amberP: 0.08, redP: 0.02 },
    { window: 252, amberP: 0.05, redP: 0.01 },
    { window: 252, amberP: 0.10, redP: 0.02 },
    { window: 252, amberP: 0.10, redP: 0.03 },
    { window: 252, amberP: 0.15, redP: 0.05 },
    { window: 252, amberP: 0.20, redP: 0.05 },
    { window: 378, amberP: 0.10, redP: 0.03 },
    { window: 504, amberP: 0.10, redP: 0.03 },
    { window: 126, amberP: 0.10, redP: 0.03, minObs: 100 },
    { window: 126, amberP: 0.15, redP: 0.05, minObs: 100 },

  ];
  const storedIdx = full.dates.map((_, i) => i).filter((i) => full.dates[i]! >= STORED_FROM);
  console.log(`\nD. window sweep over the stored span (${storedIdx.length} candidate days)`);
  console.log(`   ${"policy".padEnd(28)} ${"AMBER".padStart(6)} ${"RED".padStart(6)}   travel(365d) dropA/dropR/steepA/steepR   latest dropA/dropR/steepA/steepR`);
  for (const c of SWEEP) {
    const mo = c.minObs ?? BULL_MIN_OBS;
    const cuts = c.window === null
      ? {
          dropAmber: expandingPercentile(full.drop, c.amberP, mo),
          dropRed: expandingPercentile(full.drop, c.redP, mo),
          steepAmber: expandingPercentile(full.dSteep, 1 - c.amberP, mo),
          steepRed: expandingPercentile(full.dSteep, 1 - c.redP, mo),
        }
      : {
          dropAmber: rollingPercentile(full.drop, c.amberP, c.window, mo),
          dropRed: rollingPercentile(full.drop, c.redP, c.window, mo),
          steepAmber: rollingPercentile(full.dSteep, 1 - c.amberP, c.window, mo),
          steepRed: rollingPercentile(full.dSteep, 1 - c.redP, c.window, mo),
        };
    let n = 0;
    let amber = 0;
    let red = 0;
    let redOr = 0;
    const scored: number[] = [];
    for (const i of storedIdx) {
      const cc: BullSteepenerCuts = {
        dropAmber: cuts.dropAmber[i]!,
        dropRed: cuts.dropRed[i]!,
        steepAmber: cuts.steepAmber[i]!,
        steepRed: cuts.steepRed[i]!,
      };
      if (!Number.isFinite(full.drop[i]!) || !finite(cc)) continue;
      n++;
      scored.push(i);
      const st = bullSteepenerState(full.drop[i]!, full.d10[i]!, cc);
      if (st === "AMBER") amber++;
      if (st === "RED") red++;
      // "or" variant: RED on EITHER tail (the 2026-08-19 sovereign-spread precedent), same gate.
      if (full.shortEndDriven[i] && (full.drop[i]! <= cc.dropRed || full.dSteep[i]! >= cc.steepRed)) redOr++;
    }
    const win = scored.slice(-365);
    const travel = CUT_KEYS.map((k) => {
      const xs = win.map((i) => cuts[k][i]!).filter(Number.isFinite);
      return xs.length ? Math.max(...xs) - Math.min(...xs) : NaN;
    });
    const lastI = scored.at(-1);
    if (lastI === undefined) { console.log(`   (no scored days)`); continue; }
    const label = c.window === null ? `expanding p${c.amberP * 100}/p${c.redP * 100}` : `rolling${c.window} p${c.amberP * 100}/p${c.redP * 100}`;
    console.log(
      `   ${label.padEnd(28)} ${((amber / n) * 100).toFixed(1).padStart(5)}% ${((red / n) * 100).toFixed(1).padStart(5)}%` +
        `  (or-RED ${((redOr / n) * 100).toFixed(1)}%)   ${travel.map((t) => t.toFixed(3)).join(" / ")}` +
        `   ${CUT_KEYS.map((k) => cuts[k][lastI]!.toFixed(3)).join(" / ")}`,
    );
  }

  // E. THE SHIPPED PACKAGE (2026-08-29 [USER]): rolling126 p15/p5, RED on EITHER tail ("or").
  // Full state census + episode structure — the live instant-up/buffered-down fold stretches every
  // episode, and the F5 ruling was surprised by exactly that.
  for (const [W, AP, RP, MO] of [[126,0.15,0.05,126],[126,0.15,0.03,126],[126,0.15,0.02,126],[126,0.20,0.05,126],[126,0.20,0.03,126],[252,0.15,0.03,252]] as const) {
  const eCuts = {
    dropAmber: rollingPercentile(full.drop, AP, W, MO),
    dropRed: rollingPercentile(full.drop, RP, W, MO),
    steepAmber: rollingPercentile(full.dSteep, 1 - AP, W, MO),
    steepRed: rollingPercentile(full.dSteep, 1 - RP, W, MO),
  };
  /** The "or" state: same gate + AMBER rule, RED on EITHER tail. */
  const orState = (i: number, c: BullSteepenerCuts): State => {
    if (!full.shortEndDriven[i]) return "GREEN";
    if (full.drop[i]! <= c.dropRed || full.dSteep[i]! >= c.steepRed) return "RED";
    if (full.drop[i]! <= c.dropAmber || full.dSteep[i]! >= c.steepAmber) return "AMBER";
    return "GREEN";
  };
  let eN = 0;
  const census: Record<State, number> = { GREEN: 0, AMBER: 0, RED: 0 };
  const before: Record<State, number> = { GREEN: 0, AMBER: 0, RED: 0 };
  const eMoves: Record<string, number> = {};
  let redEpisodes = 0;
  let nonGreenEpisodes = 0;
  let prev: State = "GREEN";
  let gateOnStored = 0;
  for (const i of storedIdx) {
    const c: BullSteepenerCuts = {
      dropAmber: eCuts.dropAmber[i]!,
      dropRed: eCuts.dropRed[i]!,
      steepAmber: eCuts.steepAmber[i]!,
      steepRed: eCuts.steepRed[i]!,
    };
    const live = at(full, i);
    if (!Number.isFinite(full.drop[i]!) || !finite(c) || !finite(live)) continue;
    eN++;
    if (full.shortEndDriven[i]) gateOnStored++;
    const now = orState(i, c);
    const old = bullSteepenerState(full.drop[i]!, full.d10[i]!, live);
    census[now]++;
    before[old]++;
    if (old !== now) eMoves[`${old}->${now}`] = (eMoves[`${old}->${now}`] ?? 0) + 1;
    if (now === "RED" && prev !== "RED") redEpisodes++;
    if (now !== "GREEN" && prev === "GREEN") nonGreenEpisodes++;
    prev = now;
  }
  const pct = (x: number) => `${((x / eN) * 100).toFixed(2)}%`;
  console.log(`\nE. SHIPPED PACKAGE — rolling${W} p${AP * 100}/p${RP * 100}, minObs ${MO}, combine "or" (${eN} rows)`);
  console.log(`   before  AMBER ${before.AMBER} (${pct(before.AMBER)})  RED ${before.RED} (${pct(before.RED)})  non-GREEN ${pct(before.AMBER + before.RED)}`);
  console.log(`   after   AMBER ${census.AMBER} (${pct(census.AMBER)})  RED ${census.RED} (${pct(census.RED)})  non-GREEN ${pct(census.AMBER + census.RED)}`);
  console.log(`   restate diff: ${JSON.stringify(eMoves)} = ${Object.values(eMoves).reduce((a, b) => a + b, 0)} rows`);
  console.log(
    `   episodes: ${nonGreenEpisodes} non-GREEN (mean run ${((census.AMBER + census.RED) / nonGreenEpisodes).toFixed(2)}d),` +
      ` ${redEpisodes} RED (mean run ${(census.RED / redEpisodes).toFixed(2)}d)`,
  );
  console.log(`   gate ceiling: ${gateOnStored} gate-on days = ${((gateOnStored / eN) * 100).toFixed(1)}%`);
  console.log(
    `   latest cuts: dropA ${eCuts.dropAmber.at(-1)!.toFixed(3)} dropR ${eCuts.dropRed.at(-1)!.toFixed(3)}` +
      ` steepA ${eCuts.steepAmber.at(-1)!.toFixed(3)} steepR ${eCuts.steepRed.at(-1)!.toFixed(3)}`,
  );
  }
}

await main();
