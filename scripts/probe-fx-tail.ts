/**
 * `=X` FX-tail probe — the live falsifier for the 2026-08-20 monotonicity defect.
 *
 *   npx tsx scripts/probe-fx-tail.ts
 *
 * WHAT IT ANSWERS: does a run made DURING a session see the previous session's FX close, or
 * only the one before it? the closes provider timestamps an `=X` daily bar at the start of the London
 * session and withholds its `adjclose` until the NEXT session ends, so the bar carrying
 * yesterday's close reads null all day. `parseClosesChart` used to skip it, and the newest FX
 * obs_date then walked BACKWARDS between the evening cron (which keeps the live-quote row) and
 * the next morning's run — tripping the run-cycle monotonicity guard on the five `=X` ids
 * (F11, F17, FXH + its three `CMP_FXH_*` legs) and freezing the cross-asset panel.
 *
 * THE ASSERTION: every `=X` symbol's newest observation is at least as recent as the ETF grid's
 * (SPY), which is what sets the run's `asOf`. An FX tail behind SPY is exactly the state that
 * makes the guard fire.
 *
 * ⚠ It CAN fail: before the parser's null-close fallback it failed on all five symbols
 * (measured 2026-08-20 13:20 UTC — FX ended 08-18 against SPY's 08-19). Run it before 21:05
 * UTC on a weekday, when the FX bar carrying yesterday's close is still null upstream.
 * ⚠ VACUOUS SINCE 2026-09-29: the parsers now KEEP today's live-quote row at every hour (intraday.ts),
 * so it always covers the hole — the probe cannot fail until a same-day drop returns.
 */
import { fetchDailyCloses } from "../src/prices.js";
import { readEnv } from "../src/config.js";

const env = readEnv();

const FX_SYMBOLS = ["EURUSD=X", "CHF=X", "JPY=X", "CNY=X"];
const GRID_SYMBOL = "SPY";

async function tail(symbol: string): Promise<string> {
  const series = await fetchDailyCloses(symbol, { now: Date.now, env });
  return series[series.length - 1]?.date ?? "(empty)";
}

console.warn("[fx-tail] ⚠ VACUOUS: today's live-quote row is always kept (intraday.ts) and masks a withheld bar.");

const grid = await tail(GRID_SYMBOL);
let behind = 0;
for (const symbol of FX_SYMBOLS) {
  const last = await tail(symbol);
  const ok = last >= grid;
  if (!ok) behind++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${symbol.padEnd(9)} ${last}   (${GRID_SYMBOL} ${grid})`);
}

if (behind > 0) {
  console.error(`\n[fx-tail] ${behind}/${FX_SYMBOLS.length} FX tails lag the ${GRID_SYMBOL} grid.`);
  process.exit(1);
}
console.log(`\n[fx-tail] all ${FX_SYMBOLS.length} FX tails reach the ${GRID_SYMBOL} grid (${grid}).`);
