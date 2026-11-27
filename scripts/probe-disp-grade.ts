/**
 * DISP real-close calibration probe — REPURPOSED for the 2026-07-22 redesign
 * (user decision).
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/probe-disp-grade.ts      # reads the local store, writes NOTHING
 *
 * The redesign makes the 20d BASKET RETURN the de-risk trigger and correlation a single STRICT
 * `> DISP_CORR (0.75)` confirm gate; basket DEPTH then splits the tiers (deep `< −2.5%` ⇒ RED,
 * shallow `−2.5%..0` ⇒ AMBER). This probe replaces the old "does an AMBER band exist on the
 * CORRELATION axis (corr dwell in [0.55, 0.70))" question — that band was DELETED — with the
 * redesign's real-close check: **does the basket-DEPTH split carve a genuine AMBER tier on the
 * confirm-gate (corr > 0.75, negative-basket) subsample, and does shallow AMBER dwell BEFORE a
 * deep RED (the early warning the depth split buys)?**
 *
 * The store is re-scored through the REAL production `dispersionState` (never reimplemented), so
 * the tiers reflect the CURRENT predicate regardless of what state the rows were persisted under.
 * `value` = the stored mean pairwise corr; `decision` = the persisted 20d basket return.
 *
 * ⚠ **Seed the store first** (`scripts/db.sh up dev` + `npm run backfill -- all`) — the probe
 * throws loudly on an empty store rather than printing a confident zero.
 *
 * ⚠⚠ **DWELL IS MEASURED ON THE RAW re-scored series, AND THAT CHOICE IS LOAD-BEARING.** The
 * 2-close confirmation buffer means the day before a confirmed RED is already a raw RED, so a
 * confirmed-series dwell is structurally ~0 by construction. The question — "does shallow AMBER
 * dwell before deep RED?" — is about the UNBUFFERED signal, so the walk-back below uses the raw
 * re-scored state.
 */
import {
  DISP_CORR,
  DISP_BASKET_RED,
  DISP_CORR_P,
  DISP_CORR_P_WINDOW,
  DISP_CORR_P_MIN_OBS,
} from "../src/family-descriptor-rows.js";
import { dispersionState } from "../src/scorers-composite.js";
import { rollingPercentile } from "../src/percentile.js";
import { getStore } from "../src/store.js";
import { SYNTH_HISTORY_LIMIT } from "../src/synth-cuts.js";
import { fmt4, mean, median } from "./lib/stats.js";
import { readEnv } from "../src/config.js";

async function main(): Promise<void> {
  const env = readEnv();
  const store = getStore("ro", env);
  const rows = await store.getSeries("DISP", SYNTH_HISTORY_LIMIT);

  console.log(`DISP — ${rows.length} stored rows (limit ${SYNTH_HISTORY_LIMIT})`);
  if (rows.length === 0) {
    throw new Error("DISP has NO stored history — seed the store first (`npm run backfill -- all`).");
  }
  console.log(`window: ${rows[0]!.date} → ${rows.at(-1)!.date}, latest meanCorr ${fmt4(rows.at(-1)!.value)}`);

  const nullDecision = rows.filter((r) => r.decision === null || r.decision === undefined).length;
  console.log(
    nullDecision > 0
      ? `⚠⚠ NULL decision on ${nullDecision} / ${rows.length} rows — those rows re-score GREEN and are excluded from the split.`
      : `null decision (basket return): 0 / ${rows.length}  ✓`,
  );

  // Re-score every row through the REAL predicate. `decision` (basket) is the trigger; `value`
  // (meanCorr) the confirm. A null decision → NaN → GREEN by the scorer's NaN-safe gate.
  // Same masked rolling p90 the cron and `api/series.ts` score against (a stored 0 is the degenerate
  // sentinel, never an observation) — without it this probe would grade against the pre-B2 predicate.
  const corrP90 = rollingPercentile(
    rows.map((r) => (r.value === 0 ? NaN : r.value)),
    DISP_CORR_P,
    DISP_CORR_P_WINDOW,
    DISP_CORR_P_MIN_OBS,
  );
  const scored = rows.map((r, i) => ({
    ...r,
    raw: dispersionState(r.value, (r.decision ?? NaN), DISP_CORR, corrP90[i]),
  }));

  // The confirm-gate subsample: corr > cut AND negative basket (i.e. every non-GREEN re-scored day).
  const fired = scored.filter((s) => s.raw !== "GREEN");
  const redDays = fired.filter((s) => s.raw === "RED").length; // deep: basket < −2.5%
  const amberDays = fired.filter((s) => s.raw === "AMBER").length; // shallow: −2.5%..0
  console.log(`\nconfirm-gate subsample (corr > ${DISP_CORR} AND basket < 0): ${fired.length} / ${rows.length} rows`);
  console.log(`  RED  (deep, basket < ${DISP_BASKET_RED}): ${redDays}`);
  console.log(`  AMBER (shallow, ${DISP_BASKET_RED} ≤ basket < 0): ${amberDays}`);

  // Raw GREEN→RED entries, and the shallow-AMBER dwell running up to each (the early warning).
  const redEntries: number[] = [];
  for (let i = 1; i < scored.length; i++) {
    if (scored[i - 1]!.raw !== "RED" && scored[i]!.raw === "RED") redEntries.push(i);
  }
  const runs: number[] = [];
  for (const i of redEntries) {
    let n = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (scored[j]!.raw === "AMBER") n++;
      else break; // a GREEN (or a RED further back) ends the pre-RED shallow-AMBER run
    }
    runs.push(n);
  }
  const nonZero = runs.filter((n) => n > 0);
  console.log(`\npre-RED shallow-AMBER dwell (consecutive AMBER days before each RAW RED entry):`);
  console.log(`  run lengths: ${runs.length ? runs.join(", ") : "(no RED entries)"}`);
  console.log(
    `  count=${runs.length}  with-dwell=${nonZero.length}  mean=${fmt4(mean(runs))}  median=${fmt4(median(runs))}  max=${runs.length ? Math.max(...runs) : 0}`,
  );

  // --- pre-registered artifact check (throws red on regression) ---------------
  // The redesign's premise is that the basket-depth split carves a REAL AMBER tier below the deep
  // RED tier on the confirm-gate subsample. Assert both tiers are populated AND the RED tier is
  // strictly the DEEP one — a regression that collapsed the split (e.g. DISP_BASKET_RED → 0) would
  // empty AMBER (every negative-basket confirm day would be RED), reddening this.
  if (redDays === 0 || amberDays === 0) {
    throw new Error(
      `ARTIFACT CHECK FAILED: the basket-depth split is not populated on real closes ` +
        `(RED=${redDays}, AMBER=${amberDays}). Either the store is unseeded/degenerate or the ` +
        `predicate collapsed the tiers.`,
    );
  }
  // Every RED day must be strictly deeper than every AMBER day's floor — the split is on depth.
  const badRed = fired.filter((s) => s.raw === "RED" && !((s.decision as number) < DISP_BASKET_RED)).length;
  const badAmber = fired.filter(
    (s) => s.raw === "AMBER" && !((s.decision as number) >= DISP_BASKET_RED && (s.decision as number) < 0),
  ).length;
  if (badRed > 0 || badAmber > 0) {
    throw new Error(`ARTIFACT CHECK FAILED: tier/depth mismatch (badRed=${badRed}, badAmber=${badAmber}).`);
  }
  console.log(
    `\nARTIFACT CHECK PASSED — basket-depth split is real: ${redDays} deep RED + ${amberDays} shallow ` +
      `AMBER days on the confirm-gate subsample; ${nonZero.length}/${runs.length} RED entries had ` +
      `pre-RED shallow-AMBER dwell (max ${runs.length ? Math.max(...runs) : 0}d).`,
  );
}

void main();
