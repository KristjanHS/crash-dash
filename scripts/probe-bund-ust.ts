/**
 * Read-only probe: how much does the Bund 10y−2y curve (`BUND`) tell you about the **US**
 * curve? Written 2026-07-24 to adjudicate `MEMBER_WEIGHT.BUND`'s zeros on `S&P IT`,
 * `S&P 500` and `EM` (`src/danger-ladder.ts`), which shipped as a VERBATIM copy of the
 * `EURC` row on the stated ground that the euro curve is "EU/DM-ex-US-scoped, US-only legs
 * and EM get 0". That claim was
 * an assertion, never measured.
 *
 *   npm run probe:bund-ust        # network only, writes NOTHING (no store handle at all)
 *
 * The sibling `probe:bund` (`probe-bund-eurc.ts`) measured Bund vs the ECB **euro** curve and
 * earned BUND its family seat. This one runs the SAME metric shapes against the **US** curve
 * (FRED `T10Y2Y`), so the two probes' numbers are directly comparable:
 *
 *   M1  Pearson r of daily LEVELS
 *   M2  Pearson r of 20d CHANGES (dynamics/timing, not the shared trend)
 *   M4  MARGINAL firing days — Bund AMBER-or-worse while the US curve is GREEN
 *   LL  lead/lag — argmax over k of corr(bund[t], us[t+k]); POSITIVE k ⇒ Bund LEADS
 *
 * ⚠ **The cuts are Bund-calibrated.** `BUND_AMBER`/`BUND_RED` were fitted on the Bund spread's
 * own distribution, so applying them to `T10Y2Y` does NOT give like-for-like base rates (the US
 * curve fires more often at the same cut). The load-bearing output is therefore the CONDITIONAL
 * lift `P(us fires | bund fires)` vs the US unconditional rate, printed side by side below —
 * never the raw counts on their own.
 *
 * ⚠ **States here are RAW, not CONFIRMED** (same caveat as `probe-bund-eurc.ts`): production
 * folds each raw state through the `CONFIRM_CLOSES` buffer first. A 2-close buffer only deletes
 * 1-day flickers, so raw marginal-day counts are an UPPER BOUND on the confirmed ones.
 *
 * ⚠ Both tenors come from one feed and `T10Y2Y` from another, joined by DATE STRING. If either
 * feed's date shape changed the inner join would go silently empty and every metric would be
 * vacuously computed over nothing — so a thin join throws rather than printing a confident table.
 */
import { parseBundesbankCsv, bundesbankCsvUrl, type BundMaturity } from "../src/bundesbank.js";
import { realFeeds } from "../src/feed-ports.js";
import { BUND_AMBER, BUND_RED } from "../src/family-descriptor-rows.js";
import { VELOCITY_WINDOW, type Observation } from "../src/domain-types.js";
import { runFetchSignal } from "../src/fetch-budget.js";
import { pct, pearson } from "./lib/stats.js";
import { readEnv } from "../src/config.js";

/** Widest lead/lag scanned, in trading days: ±120 for 20d changes, ±250 (~1y) for levels. */
const LAG_DELTA = 120;
const LAG_LEVEL = 250;

/**
 * Only the fetch LOOP is local: a bare `fetchBundYield` slices to its trailing `BUND_TAIL` window
 * and this probe needs the full ~7,300-row history. The URL and the PARSER both come
 * from `src/bundesbank.ts` — a re-stated URL is what silently rotted here when the REST host
 * went behind a bot challenge (see that module's docblock).
 */
async function fetchBundFull(maturity: BundMaturity): Promise<Observation[]> {
  const res = await fetch(bundesbankCsvUrl(maturity), {
    headers: { "User-Agent": "crash-dash/0.1 (+https://github.com/KristjanHS/crash-dash)" },
    signal: runFetchSignal(15_000),
  });
  if (!res.ok) throw new Error(`Bundesbank fetch failed for ${maturity}: ${res.status} ${res.statusText}`);
  const obs = parseBundesbankCsv(await res.text());
  if (obs.length === 0) throw new Error(`Bundesbank returned zero parsable rows for ${maturity}`);
  return obs;
}

/** Inner join N series on their shared dates, preserving ascending date order. */
function joinAll(series: Observation[][]): { dates: string[]; values: number[][] } {
  const maps = series.map((s) => new Map(s.map((o) => [o.date, o.value])));
  const dates = [...maps[0]!.keys()].filter((d) => maps.every((m) => m.has(d))).sort();
  return { dates, values: maps.map((m) => dates.map((d) => m.get(d)!)) };
}

/** Δ over `w` rows, aligned to `values[w..]` (the same convention as `velocityDelta`). */
function delta(values: number[], w: number): number[] {
  return values.slice(w).map((v, i) => v - values[i]!);
}

/**
 * argmax over k ∈ [−span, +span] of corr(a[t], b[t+k]). POSITIVE k ⇒ `a` LEADS `b`
 * (today's `a` lines up with `b` k days LATER); negative k ⇒ `b` leads `a`.
 */
function leadLag(a: number[], b: number[], span: number): { k: number; r: number } {
  let best = { k: 0, r: -2 };
  for (let k = -span; k <= span; k++) {
    const x = k >= 0 ? a.slice(0, a.length - k) : a.slice(-k);
    const y = k >= 0 ? b.slice(k) : b.slice(0, b.length + k);
    const r = pearson(x, y);
    if (r > best.r) best = { k, r };
  }
  return best;
}

async function main(): Promise<void> {
  const env = readEnv();
  const [b10, b02, ust] = await Promise.all([
    fetchBundFull("Y10"),
    fetchBundFull("Y02"),
    realFeeds.fetchSeries("T10Y2Y", { fullHistory: true, now: new Date(), env }),
  ]);
  for (const [name, s] of [["bund 10y", b10], ["bund 2y", b02], ["fred T10Y2Y", ust]] as const) {
    console.log(
      `${name.padEnd(12)} ${String(s.length).padStart(6)} rows  ${s[0]!.date} → ${s.at(-1)!.date}  latest ${s.at(-1)!.value}`,
    );
  }

  const { dates, values } = joinAll([b10, b02, ust]);
  if (dates.length < 1000) {
    throw new Error(
      `shared history is only ${dates.length} days (expected ~7,100) — the Bundesbank/FRED date ` +
        `formats have diverged, so every metric below would be vacuous. Inspect the raw CSVs first.`,
    );
  }
  const bund = values[0]!.map((x, i) => x - values[1]![i]!);
  const us = values[2]!;
  console.log(`\nshared history: ${dates.length} days  ${dates[0]} → ${dates.at(-1)}`);

  console.log(`\n  M1  level r   ${pearson(bund, us).toFixed(4)}`);
  console.log(`  M2  Δ20 r     ${pearson(delta(bund, VELOCITY_WINDOW), delta(us, VELOCITY_WINDOW)).toFixed(4)}`);
  console.log(`      Δ1 r      ${pearson(delta(bund, 1), delta(us, 1)).toFixed(4)}`);

  // Both curves scored at the SAME (Bund-calibrated) cuts — see the base-rate caveat in the
  // header: read the conditional LIFT, not the raw counts.
  for (const [label, cut] of [
    ["AMBER-or-worse", BUND_AMBER],
    ["below context `red` (leg (b) never scores RED)", BUND_RED],
  ] as const) {
    const bFires = bund.map((v) => v < cut);
    const uFires = us.map((v) => v < cut);
    const nB = bFires.filter(Boolean).length;
    const nU = uFires.filter(Boolean).length;
    const both = bFires.filter((v, i) => v && uFires[i]).length;
    const marginal = nB - both;
    console.log(
      `\n${label} (spread < ${cut}) over ${dates.length} days:\n` +
        `  bund fires        ${String(nB).padStart(5)} (${pct(nB / dates.length)})\n` +
        `  us fires          ${String(nU).padStart(5)} (${pct(nU / dates.length)})   ← unconditional base rate\n` +
        `  BOTH              ${String(both).padStart(5)} (${pct(both / dates.length)})\n` +
        `  bund-only (M4)    ${String(marginal).padStart(5)} (${pct(marginal / dates.length)})\n` +
        `  us-only           ${String(nU - both).padStart(5)} (${pct((nU - both) / dates.length)})\n` +
        `  P(us | bund)      ${(both / Math.max(1, nB)).toFixed(3)}   lift ×${(both / Math.max(1, nB) / (nU / dates.length)).toFixed(2)}`,
    );
  }

  const llDelta = leadLag(delta(bund, VELOCITY_WINDOW), delta(us, VELOCITY_WINDOW), LAG_DELTA);
  const llLevel = leadLag(bund, us, LAG_LEVEL);
  console.log(`\nLEAD/LAG (positive k ⇒ Bund LEADS the US curve by k trading days):`);
  console.log(`  Δ20    k=${String(llDelta.k).padStart(4)}  r=${llDelta.r.toFixed(4)}`);
  console.log(`  level  k=${String(llLevel.k).padStart(4)}  r=${llLevel.r.toFixed(4)}`);
}

await main();
