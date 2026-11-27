/**
 * Drawdown-gate ENGAGEMENT frequency probe — OFFLINE, READ-ONLY.
 *
 * (Stage 3.1. Measurement only — this script applies
 * NO ruling. Stage 4.1 records the numbers; the promotion decision is USER-OWNED, §8.)
 *
 * OFFLINE + READ-ONLY, structurally: the only I/O is `readFixture` over committed
 * `scripts/backtest/data/*.csv`. No feed call, no network, no DB, no store. It NEVER writes into
 * `scripts/backtest/data/` or `calibration.json` — a write there would read as an unreviewed
 * vintage bump (`.claude/rules/research-probes.md`). `--json=<path>` writes only where the caller names,
 * and `assertSafeJsonPath` ENFORCES that — the sentence above is executable, not just asserted.
 *
 * ── ONE LIMIT LEFT, ONE CLOSED (W5-e A-1) ─────────────────────────────────────
 *
 * (a) THE FAIL-OFF ARM IS NOW EXACT (D-4 CLOSED). The live gate boolean is
 *     `drawdownGateWouldFire(shape) === (shape !== "indeterminate")`, and `classifyFallShape`
 *     ALSO sends `dwell === null` and velocity-vs-dwell disagreement to `indeterminate` — both
 *     credit-driven (F1/F2, HY OAS). The committed `scripts/backtest/data/hyoas.csv` fixture
 *     (`npm run synth:fixtures` — real market data is not distributed with this repository) supplies that credit
 *     history, so the probe feeds it through the PRODUCTION `classifyFallShape` and those two
 *     branches are EVALUATED, not assumed. This probe therefore reports
 *
 *         nominal (dd <= V_MIN_DRAWDOWN)  >=  clipQualified (… && !peakClipped)  >=  failOff
 *
 *     with `failOff` an EXACT count and `gapFailOff = clipQualified − failOff` the closes the two
 *     credit branches remove — a number, no longer a bracket. Only the `failOff` arm consumes
 *     production `classifyFallShape`; `nominal`/`clipQualified` stay reimplemented in-probe.
 *
 * (b) ENGAGEMENT, NOT BITE. This counts how often the gate would have been ON. It cannot count how
 *     often it would have BITTEN — clamped an actual `>+1` rung move — because that needs rung
 *     history, which `acwi.csv` does not carry. Deferred D-5.
 *
 * ── THE ERA SPLIT, AND WHY (A-1/A-2, USER ruling) ──
 *
 * A-1: the walk starts at the FIRST close in `acwi.csv` (2008-03-28) and GROWS the trailing window
 * up to `LOOKBACK_DAYS` (400 CALENDAR days, `src/prices.ts`), rather than skipping dates until the
 * window is full. A full-window-only walk would begin ~2009-05-02, which would make the
 * pre-registered 2008-09 GFC episode — the deepest fall in the fixture — unmeasurable.
 *
 * A-2: the accepted cost is that on a short early window `peakClipped` (`peakIdx === 0 &&
 * closes.length > 1`, `src/v-bear.ts`) is TRIVIALLY true: a window only a few closes wide almost
 * always opens on its own high. That is NOT the same phenomenon as E-3's 400-day grind clip, and
 * blending them would report a clip rate that means two different things at once. So every arm,
 * every episode row and every total below is split into two eras and never summed across them:
 *
 *     warm-up      2008-03-28 .. 2009-05-01   (window still growing; peakClipped is degenerate)
 *     full-window  2009-05-02 onward          (window is a true 400-calendar-day trailing slice)
 *
 * ── METHOD ───────────────────────────────────────────────────────────────────
 *
 * For each close date `t`, slice the closes falling in `[t − LOOKBACK_DAYS, t]` — reproducing the
 * live price window so `peakClipped` is faithful — and call the PRODUCTION `fallVelocity` from
 * `src/v-bear.ts`. `fallVelocity` and `drawdownSeries` are NEVER reimplemented here: a probe that
 * re-derives what it tests can only test itself (`drift-guard.ts`'s own rule).
 *
 * Usage:
 *   npx tsx scripts/probe-drawdown-gate.ts
 *   npx tsx scripts/probe-drawdown-gate.ts --json=out.json
 *   npx tsx scripts/probe-drawdown-gate.ts --fixture=scripts/backtest/data/acwi.csv
 */
import { writeFileSync } from "node:fs";
import {
  classifyFallShape,
  drawdownGateWouldFire,
  fallVelocity,
  V_MIN_DRAWDOWN,
} from "../src/v-bear.js";
import { LOOKBACK_DAYS } from "../src/price-cache.js";
import type { State } from "../src/domain-types.js";
import type { SeriesPoint } from "../src/store.js";
import { assertSafeJsonPath, readFixture } from "./backtest/drift-guard.js";
import { f1Indicator, f1ShippedCuts, replayConfirmed } from "./backtest/f1-percentile-cuts.js";
import { argOf } from "./lib/cli.js";
import { isoDay } from "../src/dates.js";

const DEFAULT_FIXTURE = "scripts/backtest/data/acwi.csv";

/**
 * The committed HY OAS (F1) credit fixture (`npm run synth:fixtures` — real market data is not
 * distributed with this repository). It is what closes the fail-OFF bracket (D-4): with a credit
 * history the probe runs the PRODUCTION `classifyFallShape` end-to-end, so its two
 * credit-driven `indeterminate` branches (`dwell === null`, velocity-vs-dwell disagreement)
 * are EVALUATED rather than assumed absent. Static + committed; the probe only READS it.
 */
export const HYOAS_FIXTURE = "scripts/backtest/data/hyoas.csv";

/**
 * F1's SHIPPED per-close confirmed states over the committed HY OAS fixture, through the
 * PRODUCTION fold (`replayConfirmed` = `rawStateSeries` ∘ `confirmedStateSeries`, the same path
 * `probe:f1-cuts` uses). This is the only NON-reimplemented credit input the probe feeds; the
 * `nominal`/`clipQualified` control arms stay reimplemented in-probe via `fallVelocity`.
 *
 * ⚠ F2 (IG OAS `BAMLC0A0CM`) has NO committed deep vintage — keyless FRED clamps it to a rolling
 * ~3y window (`drift-guard.ts` `DRIFT_FIXTURES`), so no offline fixture can span the walk. The
 * probe therefore feeds F1's HY OAS history as BOTH `f1` and `f2` to `classifyFallShape`, which
 * makes `creditDwellCloses`'s `max(tailRedRun(f1), tailRedRun(f2))` the HY OAS dwell exactly.
 * This is the deepest credit series available offline and matches `creditBlowout`'s "EITHER F1
 * or F2 confirmed RED" with the one series that has the history — recorded, not hidden.
 *
 * ⚠ The stand-in biases `failOff` by a small, SIGN-AMBIGUOUS amount — NOT a clean lower bound.
 * `classifyFallShape` fires on `fast XOR grinding`, so a deeper true IG-OAS dwell is non-monotonic:
 * it could DROP the ~14 v-shaped (`fast && !grinding`, short-dwell) fires — a longer credit dwell
 * flips them `fast && grinding` → disagree → `indeterminate` → no fire — while ADDING slow-drift
 * (`!fast && !grinding`) disagreement fires. Empirically HY dwells RED longer than IG in crises
 * (`max(HY,IG) ≈ HY`, small effect), but the sign is not guaranteed.
 */
export function loadF1States(fixture: string = HYOAS_FIXTURE): { date: string; state: State }[] {
  return replayConfirmed(f1Indicator(), readFixture(fixture), f1ShippedCuts());
}

/** Minimal `SeriesPoint` — `classifyFallShape` reads only `.state` and `.length`. */
function toSeriesPoints(states: { date: string; state: State }[]): SeriesPoint[] {
  return states.map((s) => ({ date: s.date, value: 0, delta20: 0, rawState: s.state, state: s.state }));
}

/**
 * The era boundary (A-2). `acwi.csv` opens 2008-03-28; the first
 * date whose trailing 400-CALENDAR-day window is fully backed by fixture history is 2009-05-02 (2008-03-28 +
 * 400d).
 */
export const FULL_WINDOW_FROM = "2009-05-02";

type Era = "warm-up" | "full-window";
const ERAS: Era[] = ["warm-up", "full-window"];

/**
 * Pre-registered episodes, enumerated BEFORE the run (Stage 3.1).
 * Named a priori — no episode is added or dropped after seeing the output. Ranges are the conventional
 * peak-to-trough spans of each drawdown, not fitted to this fixture.
 */
export const EPISODES: { name: string; from: string; to: string }[] = [
  { name: "2008-09 GFC", from: "2008-09-01", to: "2009-03-31" },
  { name: "2011 EU crisis", from: "2011-07-01", to: "2011-12-31" },
  { name: "2015-16", from: "2015-08-01", to: "2016-02-29" },
  { name: "2018Q4", from: "2018-10-01", to: "2018-12-31" },
  { name: "2020 COVID", from: "2020-02-01", to: "2020-04-30" },
  { name: "2022", from: "2022-01-01", to: "2022-12-31" },
  { name: "2025", from: "2025-01-01", to: "2025-12-31" },
];

/** `iso` shifted back `days` CALENDAR days — the live window anchor, one place. */
function minusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return isoDay(d);
}

interface Row {
  date: string;
  era: Era;
  dd: number;
  peakClipped: boolean;
  nominal: boolean;
  clipQualified: boolean;
  /**
   * The EXACT live gate boolean — `drawdownGateWouldFire(classifyFallShape(window, f1, f2))` —
   * or `null` when `f1States` was not supplied (the synthetic window-shape test). No longer a
   * `<= clipQualified` upper bound: with real credit it is the measurement itself.
   */
  failOff: boolean | null;
}

/**
 * One row per close.
 *
 * `nominal`/`clipQualified` are the CONTROL arms, reimplemented in-probe via the production
 * `fallVelocity`. `failOff` is the only arm that consumes production `classifyFallShape`: when
 * `f1States` is supplied (F1's confirmed credit states, oldest-first — `loadF1States`), each
 * close is scored through the live classifier so its two credit-driven `indeterminate` branches
 * are evaluated. `classifyFallShape` recomputes `fall` from the SAME window, so `failOff === true`
 * strictly implies `clipQualified === true` (the gate collapses to `shape !== "indeterminate"`).
 */
export function walk(
  obs: { date: string; value: number }[],
  f1States?: { date: string; state: State }[],
): Row[] {
  const rows: Row[] = [];
  const f1Points = f1States ? toSeriesPoints(f1States) : null;
  let lo = 0;
  let f1Hi = -1; // last F1 index with date <= the current close; monotone, so it only advances.
  for (let t = 0; t < obs.length; t++) {
    const date = obs[t]!.date;
    const cutoff = minusDays(date, LOOKBACK_DAYS);
    while (obs[lo]!.date < cutoff) lo++;
    const window = obs.slice(lo, t + 1).map((o) => o.value);
    const fall = fallVelocity(window);
    // `fallVelocity` returns null only on an empty window, which cannot happen here (the slice
    // always contains `t` itself). Skipping rather than asserting keeps the probe measurement-only.
    if (!fall) continue;
    const nominal = fall.dd <= V_MIN_DRAWDOWN;
    let failOff: boolean | null = null;
    if (f1Points) {
      while (f1Hi + 1 < f1Points.length && f1Points[f1Hi + 1]!.date <= date) f1Hi++;
      const credit = f1Points.slice(0, f1Hi + 1);
      // F1's HY OAS stands in for both F1 and F2 (see `loadF1States`): the deepest offline credit
      // series, and `creditDwellCloses`'s max reduces to the HY OAS dwell exactly.
      failOff = drawdownGateWouldFire(classifyFallShape(window, credit, credit).shape);
    }
    rows.push({
      date,
      era: date < FULL_WINDOW_FROM ? "warm-up" : "full-window",
      dd: fall.dd,
      peakClipped: fall.peakClipped,
      nominal,
      clipQualified: nominal && !fall.peakClipped,
      failOff,
    });
  }
  return rows;
}

interface ArmStat {
  fires: number;
  pct: number;
  longestRun: number;
}
interface Summary {
  label: string;
  total: number;
  nominal: ArmStat;
  clipQualified: ArmStat;
  /** The EXACT live gate arm (production `classifyFallShape`), replacing the old upper bound. */
  failOff: ArmStat;
  gap: number;
  /** `clipQualified − failOff`: closes the credit branches remove (the D-4 bracket, now a number). */
  gapFailOff: number;
}

function armStat(rows: Row[], pick: (r: Row) => boolean): ArmStat {
  let fires = 0;
  let run = 0;
  let longestRun = 0;
  for (const r of rows) {
    if (pick(r)) {
      fires++;
      run++;
      if (run > longestRun) longestRun = run;
    } else {
      run = 0;
    }
  }
  return { fires, pct: rows.length ? (100 * fires) / rows.length : 0, longestRun };
}

function summarize(label: string, rows: Row[]): Summary {
  const nominal = armStat(rows, (r) => r.nominal);
  const clipQualified = armStat(rows, (r) => r.clipQualified);
  const failOff = armStat(rows, (r) => r.failOff === true);
  return {
    label,
    total: rows.length,
    nominal,
    clipQualified,
    failOff,
    gap: nominal.fires - clipQualified.fires,
    gapFailOff: clipQualified.fires - failOff.fires,
  };
}

const pad = (s: string, n: number) => s.padEnd(n);
const rpad = (s: string, n: number) => s.padStart(n);
/** Stays local: the argument is ALREADY scaled to 0–100 (`Summary.pct` is `100 * fires / rows`),
 *  whereas `lib/stats.js`'s `pct` takes a 0–1 share and multiplies by 100 itself. */
const pct = (n: number) => `${n.toFixed(1)}%`;

function formatTable(title: string, rows: Summary[]): string {
  const out = [title, ""];
  out.push(
    pad("scope", 30) +
      rpad("closes", 8) +
      rpad("nominal", 10) +
      rpad("%", 8) +
      rpad("run", 6) +
      rpad("clipQual", 10) +
      rpad("%", 8) +
      rpad("run", 6) +
      rpad("gap", 6),
  );
  out.push("-".repeat(92));
  for (const s of rows) {
    out.push(
      pad(s.label, 30) +
        rpad(String(s.total), 8) +
        rpad(String(s.nominal.fires), 10) +
        rpad(pct(s.nominal.pct), 8) +
        rpad(String(s.nominal.longestRun), 6) +
        rpad(String(s.clipQualified.fires), 10) +
        rpad(pct(s.clipQualified.pct), 8) +
        rpad(String(s.clipQualified.longestRun), 6) +
        rpad(String(s.gap), 6),
    );
  }
  return out.join("\n");
}

/**
 * The fail-OFF arm — the EXACT live gate boolean via production `classifyFallShape` (D-4 closed).
 * `gapFailOff = clipQualified − failOff` is the count the two credit-driven `indeterminate`
 * branches (`dwell === null`, velocity-vs-dwell disagreement) remove — a number, not a bracket.
 */
function formatFailOff(rows: Summary[]): string {
  const out = ["fail-OFF arm (the EXACT live gate boolean, production classifyFallShape)", ""];
  out.push(
    pad("scope", 30) +
      rpad("clipQual", 10) +
      rpad("failOff", 10) +
      rpad("%", 8) +
      rpad("run", 6) +
      rpad("gap↓", 6),
  );
  out.push("-".repeat(92));
  for (const s of rows) {
    out.push(
      pad(s.label, 30) +
        rpad(String(s.clipQualified.fires), 10) +
        rpad(String(s.failOff.fires), 10) +
        rpad(pct(s.failOff.pct), 8) +
        rpad(String(s.failOff.longestRun), 6) +
        rpad(String(s.gapFailOff), 6),
    );
  }
  out.push("");
  out.push("gap↓ = clipQualified − failOff: closes the credit branches (dwell===null + velocity/dwell disagree) remove.");
  return out.join("\n");
}

// ---------- CLI ----------


const isMain = process.argv[1]?.endsWith("probe-drawdown-gate.ts") ?? false;
if (isMain) {
  const fixture = argOf("fixture") ?? DEFAULT_FIXTURE;
  const jsonPath = argOf("json");
  const obs = readFixture(fixture);
  if (obs.length === 0) {
    console.log(`ABORT: ${fixture} parsed to 0 observations — nothing to walk.`);
    process.exit(1);
  }

  const f1States = loadF1States();
  const rows = walk(obs, f1States);
  const byEra = ERAS.map((era) => summarize(era, rows.filter((r) => r.era === era)));

  const episodeRows: Summary[] = [];
  for (const ep of EPISODES) {
    for (const era of ERAS) {
      const slice = rows.filter(
        (r) => r.era === era && r.date >= ep.from && r.date <= ep.to,
      );
      if (slice.length === 0) continue;
      episodeRows.push(summarize(`${ep.name} [${era}]`, slice));
    }
  }

  console.log("drawdown-gate ENGAGEMENT probe — OFFLINE, READ-ONLY, no ruling applied");
  console.log(`fixture:   ${fixture}  (${obs.length} closes, ${obs[0]!.date} .. ${obs.at(-1)!.date})`);
  console.log(`credit:    ${HYOAS_FIXTURE}  (${f1States.length} F1 confirmed states, ${f1States[0]!.date} .. ${f1States.at(-1)!.date})`);
  console.log(`window:    LOOKBACK_DAYS = ${LOOKBACK_DAYS} CALENDAR days, trailing, growing from the first close`);
  console.log(`cut:       V_MIN_DRAWDOWN = ${V_MIN_DRAWDOWN}`);
  console.log(`eras:      warm-up = .. ${minusDays(FULL_WINDOW_FROM, 1)}  |  full-window = ${FULL_WINDOW_FROM} ..`);
  console.log(`limits:    (a) failOff is now EXACT via production classifyFallShape (D-4 closed)  (b) ENGAGEMENT, not bite (D-5)`);
  console.log("");
  console.log(formatTable("TOTALS by era — never summed across eras (§2a A-2)", byEra));
  console.log("");
  console.log(formatFailOff(byEra));
  console.log("");
  console.log(formatTable("PRE-REGISTERED EPISODES (named a priori, §3.1)", episodeRows));
  console.log("");
  console.log("gap = nominal − clipQualified, i.e. closes the peak-clip guard removes (E-3's understatement).");
  console.log("In the warm-up era that gap is DEGENERATE by construction — a growing window opens on its own high.");

  if (jsonPath) {
    assertSafeJsonPath(jsonPath);
    writeFileSync(
      jsonPath,
      JSON.stringify(
        { fixture, lookbackDays: LOOKBACK_DAYS, vMinDrawdown: V_MIN_DRAWDOWN, fullWindowFrom: FULL_WINDOW_FROM, byEra, episodes: episodeRows },
        null,
        2,
      ),
    );
    console.log(`\nwrote ${jsonPath}`);
  }
}
