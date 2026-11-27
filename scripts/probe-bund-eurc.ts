/**
 * Stage 0.1 — the read-only
 * probe that decides whether a Bund 10y−2y curve earns a seat in the GLOBAL rates family
 * beside the shipped `EURC` (ECB AAA composite, 10y−3m).
 *
 *   npm run probe:bund            # network only, writes NOTHING (no store handle at all)
 *
 * The verdict rule is PRE-REGISTERED: this script
 * computes M1–M4 and prints the verdict the rule yields, so the rule grades itself and cannot be moved after
 * seeing the numbers.
 *
 *   M1  Pearson r of daily LEVELS      bund(10y−2y)  vs  eurc(SR_10Y−SR_3M)
 *   M2  Pearson r of daily 20d CHANGES (dynamics/timing, not the shared trend)
 *   M3  state-disagreement rate        ratioSpreadState(bund) ≠ ratioSpreadState(eurc), both at 0.50/0.00
 *   M4  MARGINAL FIRING DAYS           Bund AMBER-or-worse while EURC is GREEN  ← the decisive one
 *
 * M4 is exactly the incremental contribution a *worst-of* family member makes: on every other
 * day the family state is already whatever EURC says. If M4 ≈ 0 the member is ceremony by
 * construction, however good its provenance story.
 *
 * ⚠ **States here are RAW, not CONFIRMED.** Production folds each raw state through the
 * CONFIRM_CLOSES=2 buffer before it reaches a family. A 2-close buffer can only DELETE
 * 1-day flickers, never create firing days, so raw M3/M4 are an UPPER BOUND on the confirmed
 * ones. That direction is the safe one for a rule whose ADD branch needs M4 to be LARGE —
 * an ADD verdict resting on a raw M4 barely over 5.0% deserves a re-read, a DROP verdict
 * does not.
 *
 * ⚠ **The two feeds are joined by DATE STRING.** Bundesbank CSV and ECB SDMX-CSV both emit
 * `YYYY-MM-DD`; if either ever changed shape the inner join would silently go empty and every
 * metric would be vacuously computed over 0 days. The script therefore fails loud on a thin
 * join rather than printing a confident table over nothing.
 */
import { fetchEcbSeries } from "../src/ecb.js";
import { bundesbankCsvUrl, type BundMaturity } from "../src/bundesbank.js";
import { ratioSpreadState } from "../src/scorers-composite.js";
import { EURC_AMBER, EURC_RED, BUND_AMBER, BUND_RED } from "../src/family-descriptor-rows.js";
import { EURC_DESCRIPTOR } from "../src/family-descriptor-rows.js";
import { VELOCITY_WINDOW, type Observation, type State } from "../src/domain-types.js";
import { runFetchSignal } from "../src/fetch-budget.js";
// 2dp throughout: this probe's rule lines are 1.0% / 5.0% and its quantile prints sit under 1%,
// so `lib/stats.js`'s 1dp `pct` would collapse them — hence `pct2`, under its own name.
import { pct2 } from "./lib/stats.js";

/** ECB's daily `YC` curve starts 2004-09; ask from just before so the join is feed-limited, not arg-limited. */
const SHARED_START = "2004-01-01";

/**
 * The URL comes from `src/bundesbank.ts` — this script originally inlined its own copy
 * because Stage 0.1 predated that module, and the copy then rotted silently when the REST
 * host went behind a bot challenge (see that module's docblock). The parse stays local and
 * deliberately independent: it is the cross-check on the shipped parser's preamble/
 * missing-value handling (incl. the `Number("") === 0` trap), which is the whole point of
 * a probe that grades its own pre-registered rule.
 */
async function fetchBund(maturity: BundMaturity): Promise<Observation[]> {
  const res = await fetch(bundesbankCsvUrl(maturity), {
    headers: { "User-Agent": "crash-dash/0.1 (+https://github.com/KristjanHS/crash-dash)" },
    signal: runFetchSignal(15_000),
  });
  if (!res.ok) throw new Error(`Bundesbank fetch failed for ${maturity}: ${res.status} ${res.statusText}`);
  const obs = parseBund(await res.text());
  if (obs.length === 0) throw new Error(`Bundesbank returned zero parsable rows for ${maturity}`);
  return obs;
}

function parseBund(text: string): Observation[] {
  const out: Observation[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(",");
    const date = cols[0]?.trim();
    // Preamble skip by SHAPE, never by line count — a preamble length change must not eat data.
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const value = cols[1]?.trim().replace(/^"|"$/g, "");
    // "." / "No value available" / empty are all holiday markers. Number("") === 0 is finite,
    // so an unguarded parse injects a spurious 0 and corrupts the 20d velocity window.
    if (!value || value === "." || value === "No value available") continue;
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    out.push({ date, value: n });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // Dedup by date, last wins (matches parseFredCsv's guarantee).
  return out.filter((o, i) => out[i + 1]?.date !== o.date);
}

/** Inner join N series on their shared dates, preserving ascending date order. */
function joinAll(series: Observation[][]): { dates: string[]; values: number[][] } {
  const maps = series.map((s) => new Map(s.map((o) => [o.date, o.value])));
  const dates = [...maps[0]!.keys()].filter((d) => maps.every((m) => m.has(d))).sort();
  return { dates, values: maps.map((m) => dates.map((d) => m.get(d)!)) };
}

// Deliberately NOT `lib/stats.ts`'s `pearson` — that one truncates to `min(|a|,|b|)`; this one
// takes `n = a.length` outright, so a `b` shorter than `a` silently changes the denominator here
// rather than shortening the window. The seam is named in `lib/stats.ts`'s `pearson` docblock too.
function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / Math.sqrt(da * db);
}

/** Δ over VELOCITY_WINDOW rows, aligned to `values[VELOCITY_WINDOW..]` (same convention as velocityDelta). */
function delta20(values: number[]): number[] {
  return values.slice(VELOCITY_WINDOW).map((v, i) => v - values[i]!);
}

/** Group dated firing days into episodes: a gap of >`GAP` calendar days starts a new one. */
const EPISODE_GAP_DAYS = 30;
function episodes(dates: string[]): Array<{ from: string; to: string; days: number }> {
  const out: Array<{ from: string; to: string; days: number }> = [];
  for (const d of dates) {
    const last = out.at(-1);
    const gap = last ? (Date.parse(d) - Date.parse(last.to)) / 86_400_000 : Infinity;
    if (last && gap <= EPISODE_GAP_DAYS) {
      last.to = d;
      last.days++;
    } else {
      out.push({ from: d, to: d, days: 1 });
    }
  }
  return out;
}

/** Share of `series` strictly below `cut` — the empirical quantile OF a cut, matching `ratioSpreadState`'s spread `<`. */
function quantileOf(series: number[], cut: number): number {
  return series.filter((v) => v < cut).length / series.length;
}

/** Inverse of `quantileOf`: the value whose strictly-below share is ≈ `q` (nearest-rank). */
function valueAtQuantile(series: number[], q: number): number {
  const sorted = [...series].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * sorted.length)));
  return sorted[idx]!;
}

/** M3/M4 for a pair of state series: total disagreement, and A-fires-while-B-green marginal days. */
function compare(a: State[], b: State[]): { m3: number; m4: number; reverse: number } {
  let disagree = 0;
  let marginal = 0;
  let reverse = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) disagree++;
    if (a[i] !== "GREEN" && b[i] === "GREEN") marginal++;
    if (b[i] !== "GREEN" && a[i] === "GREEN") reverse++;
  }
  return { m3: disagree / a.length, m4: marginal / a.length, reverse: reverse / a.length };
}

/** The §3.2 pre-registered rule, verbatim. Thresholds are DECISION thresholds — never tune them. */
function verdict(m2: number, m4: number): string {
  if (m4 >= 0.05) return m2 < 0.9 ? "ADD" : "REPLACE";
  if (m4 < 0.01) return "DROP-to-context";
  return "ARMS-USER-DECISION";
}

async function main(): Promise<void> {
  const [b10, b02, sr10y, sr3m] = await Promise.all([
    fetchBund("Y10"),
    fetchBund("Y02"),
    fetchEcbSeries("SR_10Y", { startPeriod: SHARED_START }),
    fetchEcbSeries("SR_3M", { startPeriod: SHARED_START }),
  ]);
  for (const [name, s] of [["bund 10y", b10], ["bund 2y", b02], ["ecb SR_10Y", sr10y], ["ecb SR_3M", sr3m]] as const) {
    console.log(`${name.padEnd(11)} ${String(s.length).padStart(6)} rows  ${s[0]!.date} → ${s.at(-1)!.date}  latest ${s.at(-1)!.value}`);
  }

  const { dates, values } = joinAll([b10, b02, sr10y, sr3m]);
  // A zero/thin join means the two feeds' date formats diverged — every metric below would be
  // vacuous. Fail loud rather than print a confident table over nothing.
  if (dates.length < 1000) {
    throw new Error(
      `shared history is only ${dates.length} days (expected ~5,500) — the Bundesbank/SDMX date ` +
        `formats have diverged, so M1–M4 would be vacuous. Inspect the raw CSVs before trusting anything.`,
    );
  }
  const bundSpread = values[0]!.map((x, i) => x - values[1]![i]!);
  const eurcSpread = values[2]!.map((x, i) => x - values[3]![i]!);
  console.log(`\nshared history: ${dates.length} days  ${dates[0]} → ${dates.at(-1)}`);

  const m1 = pearson(bundSpread, eurcSpread);
  const m2 = pearson(delta20(bundSpread), delta20(eurcSpread));

  // Both curves scored at the SAME 0.50/0.00 cuts — the comparison is of the underlying
  // series, not of two different band choices.
  const bundState: State[] = bundSpread.map((s) => ratioSpreadState(s, EURC_DESCRIPTOR, EURC_AMBER, EURC_RED));
  const eurcState: State[] = eurcSpread.map((s) => ratioSpreadState(s, EURC_DESCRIPTOR, EURC_AMBER, EURC_RED));
  let disagree = 0;
  const marginalDates: string[] = [];
  for (let i = 0; i < dates.length; i++) {
    if (bundState[i] !== eurcState[i]) disagree++;
    if (bundState[i] !== "GREEN" && eurcState[i] === "GREEN") marginalDates.push(dates[i]!);
  }
  const m3 = disagree / dates.length;
  const m4 = marginalDates.length / dates.length;

  console.log(`\n  M1  level r            ${m1.toFixed(4)}`);
  console.log(`  M2  Δ20 r              ${m2.toFixed(4)}   (rule line: 0.90)`);
  console.log(`  M3  state disagreement ${pct2(m3)}`);
  console.log(`  M4  MARGINAL firing    ${pct2(m4)}   ${marginalDates.length} days   (rule lines: 1.0% / 5.0%)`);

  console.log(`\nmarginal-firing episodes (gap >${EPISODE_GAP_DAYS}d starts a new one), largest first:`);
  const eps = episodes(marginalDates).sort((a, b) => b.days - a.days).slice(0, 5);
  if (eps.length === 0) console.log("  (none — Bund never fires while EURC is green)");
  for (const e of eps) console.log(`  ${e.from} → ${e.to}   ${e.days} days`);

  // ── §7a falsifier: is M4 measuring SIGNAL, or just a band OFFSET? ─────────────────────────────
  // M4 above scored both curves at EURC's cuts. But a 10y−2y spread sits structurally BELOW a
  // 10y−3m spread on a normal upward-sloping curve, and with M1 r ≈ 0.95 the two series are
  // near-affine — so a nonzero level offset at a SHARED cut mechanically manufactures
  // one-directional firing (Bund amber, EURC green) carrying no new information. Re-cut each curve
  // at its OWN equal historical quantile: EURC's live cuts are held FIXED (they are production
  // calibration) and BUND moves to the equally-rare value. If M4 survives, the marginal firing is
  // signal; if it collapses, the one-directional asymmetry was manufactured by the offset. (Note:
  // a collapse does NOT license "an EURC_AMBER move would have got the same effect" — no arm here
  // tests that counterfactual, and the nonzero reverse direction argues against it.)
  const qAmber = quantileOf(eurcSpread, EURC_AMBER);
  const qRed = quantileOf(eurcSpread, EURC_RED);
  const bundAmberQ = valueAtQuantile(bundSpread, qAmber);
  const bundRedQ = valueAtQuantile(bundSpread, qRed);

  // Baseline-arm pin. The recorded §7a numbers are only meaningful at EURC's 0.50/0.00 calibration,
  // and the baseline arm imports those constants from production — so a future EURC re-calibration
  // (the open [USER DECISION] option B would do exactly this) silently invalidates the doc's table
  // with nothing going red. Fail loud instead. This is the retroactive-collapse shape: shipping the
  // treatment collapses an already-written probe.
  if (EURC_AMBER !== 0.5 || EURC_RED !== 0) {
    throw new Error(
      `EURC cuts have moved to ${EURC_AMBER}/${EURC_RED}; §7a's recorded 6.81%/1.55%/10.59% baseline ` +
        `was measured at 0.50/0.00 and no longer applies. Re-run and re-record before citing it.`,
    );
  }

  // Treatment-arm pin (the mirror of the EURC guard above, added 2026-07-19 after a review found
  // this file NEVER read the constants it licensed). Ruling (B) shipped BUND_AMBER/BUND_RED AT the
  // quantile-matched pair computed here, and §7a's recorded table + the family-descriptor-rows.ts docblocks quote
  // those numbers. Until this check existed the probe imported only the EURC pair, so a BUND
  // recalibration — or a feed revision moving the computed match — left every recorded number
  // stale with nothing going red, and the 2026-07-19 "re-run confirms" was an A/A w.r.t. the
  // shipped constants. Tolerance is the printed 4-decimal precision: anything the table shows
  // must still be what the descriptor carries. Since BUND S2 only BUND_AMBER scores (leg (b) is
  // single-cut); BUND_RED is context-only, pinned here as the recorded pair's other half.
  const TOL = 5e-5;
  if (Math.abs(bundAmberQ - BUND_AMBER) > TOL || Math.abs(bundRedQ - BUND_RED) > TOL) {
    throw new Error(
      `BUND descriptor cuts ${BUND_AMBER}/${BUND_RED} no longer match this run's quantile-matched pair ` +
        `${bundAmberQ.toFixed(4)}/${bundRedQ.toFixed(4)} — the §7a RESULT table and the BUND_AMBER/` +
        `BUND_RED docblocks describe cuts the descriptor no longer carries. Re-run this probe and re-record ` +
        `both before citing either.`,
    );
  }

  const bundStateQ: State[] = bundSpread.map((s) => ratioSpreadState(s, EURC_DESCRIPTOR, bundAmberQ, bundRedQ));

  // Control-arm guard — throws when the arms agree day-for-day.
  // Compares the STATE ARRAYS, not the cut values: equal cuts are sufficient for arm identity but
  // not necessary — any two cut pairs with no observation in the gap between them produce
  // byte-identical states, and the perfect agreement would then read as "M4 survives" when nothing
  // was tested. This repo has shipped the A/A collapse twice; a value-equality check misses it.
  if (bundStateQ.every((s, i) => s === bundState[i])) {
    throw new Error(
      `quantile-matched states are byte-identical to the inherited-cut states (cuts ` +
        `${bundAmberQ}/${bundRedQ} vs ${EURC_AMBER}/${EURC_RED}) — no observation separates them, ` +
        `so this run is A/A and proves nothing.`,
    );
  }
  const raw = compare(bundState, eurcState);
  const matched = compare(bundStateQ, eurcState);

  console.log(`\n§7a falsifier — quantile-matched cuts (joined window, ${dates.length} days)`);
  console.log(`  base rate < 0.50:  BUND ${pct2(quantileOf(bundSpread, 0.5))}   EURC ${pct2(quantileOf(eurcSpread, 0.5))}`);
  console.log(`  base rate < 0.00:  BUND ${pct2(quantileOf(bundSpread, 0))}   EURC ${pct2(quantileOf(eurcSpread, 0))}`);
  console.log(`  EURC cuts sit at quantiles: amber ${pct2(qAmber)}, red ${pct2(qRed)}`);
  console.log(`  → BUND cuts at those same quantiles: amber ${bundAmberQ.toFixed(4)}, red ${bundRedQ.toFixed(4)}`);
  // Bundesbank yields are 2dp, so the spread has heavy duplicates and valueAtQuantile returns the
  // SMALLEST value at the rank — ties push the achieved share below target, i.e. fewer BUND ambers
  // and a downward-biased M4, which is the direction that favours a COLLAPSE verdict. Print the
  // achieved share so that residual is visible rather than assumed away.
  console.log(
    `  achieved vs target quantile: amber ${pct2(quantileOf(bundSpread, bundAmberQ))} vs ${pct2(qAmber)}, ` +
      `red ${pct2(quantileOf(bundSpread, bundRedQ))} vs ${pct2(qRed)}`,
  );
  console.log(`  M4 inherited cuts  ${pct2(raw.m4)}   (reverse direction ${pct2(raw.reverse)}, M3 ${pct2(raw.m3)})`);
  console.log(`  M4 quantile-matched ${pct2(matched.m4)}   (reverse direction ${pct2(matched.reverse)}, M3 ${pct2(matched.m3)})`);
  console.log(
    `  §7a VERDICT: ${
      matched.m4 >= 0.05
        ? "SURVIVES (≥5.0%) — ADD is fully vindicated, §7a closes"
        : "COLLAPSES (<5.0%) — M4 was substantially band offset. FOLLOW-UP RULED 2026-07-19: option (B), BUND earns its own quantile-matched pair; BUND_AMBER ships at the amber printed above (BUND_RED is context-only since BUND S2, leg (b) never RED) — a coupling the treatment-arm pin above CHECKS (it throws when they diverge), it is not merely asserted here."
    }`,
  );

  // Degeneracy sanity-check over the FULL Bund history (not just the ECB-limited join): a cut
  // that is near-always or near-never true is a bad cut. Kept at the INHERITED 0.50/0.00 even
  // though BUND now ships 0.42/0.04 — this is the historical record the ADD verdict was argued
  // on, and re-basing it would erase what the shipped cuts were compared against. It does NOT
  // validate either pair; it only rules out the two degenerate picks.
  const fullSpread = joinAll([b10, b02]);
  const full = fullSpread.values[0]!.map((x, i) => x - fullSpread.values[1]![i]!);
  const below = (cut: number) => full.filter((v) => v < cut).length / full.length;
  console.log(
    `\nBund 10y−2y full history (${full.length} days, ${fullSpread.dates[0]} → ${fullSpread.dates.at(-1)}): ` +
      `share < 0.50 = ${pct2(below(0.5))}, share < 0.00 = ${pct2(below(0))}`,
  );

  console.log(`\n§3.2 VERDICT: ${verdict(m2, m4)}`);
  console.log("(pre-registered rule — record this in §3.3 verbatim; do not run further arms once it has fired)");
}

void main();
