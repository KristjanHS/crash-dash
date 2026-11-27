/**
 * Read-only span probe for the indicator-detail LEG TOP-N stacks.
 *
 *   npm run probe:leg-span            # prod (read-only; writes NOTHING)
 *   npm run probe:leg-span -- --all   # same bar over every registry id + the nine LEGP_* leg closes
 *
 * WHAT IT ANSWERS: every id that appears in any `LEG_TOP` row (public/leg-top.js) is charted
 * on the indicator-detail leg stack, so its STORED history is the chart's span. This prints the
 * earliest stored `obs_date` per member and grades it two ways: FLOOR against `BACKFILL_FLOOR` —
 * the one common repair floor four short-window feeds must reach — and DEPTH against
 * `MIN_USABLE_DEPTH_TRADING_DAYS`, the span a charted member actually needs to be worth reading.
 *
 * ⛔ Never re-grade DEPTH against `backfillSinceDate(id, now)`: that is the FETCH bound, and seven
 * members sit under it permanently (feed truncation / scorer warmup — evidence in the archived
 * history-deepening plan). The gap still PRINTS, never fails.
 *
 * ⚠ `BACKFILL_FLOOR` and the fetch bound are imported, never re-typed, so a floor/depth move shows
 * up here on the next run. `BACKFILL_FLOOR_WARMUP_DAYS` is NO LONGER read by this file — a warmup
 * move does not surface here. The id roster is read out of `LEG_TOP`, so a seat retune does.
 *
 * GUARD (can fire, and the demo is RUNNABLE): an id whose bulk read comes back EMPTY is `MISSING`,
 * and any MISSING, floor-SHORT, or DEPTH-SHALLOW id exits 1. `npm run probe:leg-span:dev` points
 * the same code at the local/dev store — which has no cron and a fraction of prod's rows — and is
 * the non-zero demonstration. (A prod-only entry with the demo described but unreachable would be
 * the "falsifier that cannot fail" anti-pattern.)
 */
import { fileURLToPath } from "node:url";
import { getStore } from "../src/store.js";
import { BACKFILL_FLOOR, backfillSinceDate, tradingToCalendarDays } from "./backfill.js";
import { DETAIL_WINDOW } from "../src/family-descriptor-rows.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { LADDER } from "../src/families.js";
import { legCloseId } from "../src/scoreboard.js";
import { readEnv } from "../src/config.js";

const env = readEnv();

// `public/leg-top.js` is a browser module and tsconfig has no `allowJs` (the `disclaimer-parity`
// precedent), so a static import is a type error. A RUNTIME import off a computed specifier
// evaluates the real module — the roster is read from the shipped seam, never re-typed here, so a
// seat retune is measured the day it lands.
const { LEG_TOP } = (await import(fileURLToPath(new URL("../public/leg-top.js", import.meta.url)))) as {
  LEG_TOP: Record<string, { ids: string[] }>;
};

// `--all` widens the roster to EVERY registry id (the leg-top members are a strict subset) PLUS the
// nine `LEGP_*` per-leg EUR close series, which are cron-written but NOT registry ids — so without
// this they were graded nowhere. /journal's drawdown card chains exactly these nine, so their floor
// is the card's span. Same probe, one roster switch — the LEG_TOP roster stays the default and the
// grade semantics are unchanged.
const ALL = process.argv.includes("--all");
const LEG_CLOSE_IDS = LADDER.map((sleeve) => legCloseId(sleeve));
const ids = ALL
  ? [...new Set([...ALL_INDICATORS.map((i) => i.id), ...LEG_CLOSE_IDS])].sort()
  : [...new Set(Object.values(LEG_TOP).flatMap((r) => r.ids))].sort();
const ROSTER = ALL ? `registry id(s) + ${LEG_CLOSE_IDS.length} LEGP_*` : "top-5 member(s)";

const store = getStore("ro", env);
// `limit` must exceed the deepest stored history (CAPE reaches 1871) so the earliest row is in
// the page; the range is left open on both sides for the same reason.
const series = await store.getSeriesBulk(ids, { limit: 100_000 });

const now = new Date();
const DAY_MS = 86_400_000;

/** DEPTH gate — TRADING days of stored history a charted top-5 member must hold. DERIVED from the
 *  detail chart's OWN span ([USER] 2026-08-30): the bar is exactly "holds what it draws", so a span
 *  raise re-grades prod on the next run instead of leaving a hand-set 500 behind. Was hand-set at
 *  500 (2026-08-29), one number away from the 365 the charts actually drew. */
const MIN_USABLE_DEPTH_TRADING_DAYS = DETAIL_WINDOW;
/** ⛔ Grade the SPAN, never the row COUNT: `EBP` is MONTHLY (431 rows over 51 years), so a
 *  count-based bar would call the deepest member on the board shallow. */
const MIN_USABLE_DEPTH_DAYS = tradingToCalendarDays(MIN_USABLE_DEPTH_TRADING_DAYS);

const rows = ids.map((id) => {
  const pts = series.get(id) ?? [];
  const dates = pts.map((p) => p.date).sort();
  const first = dates[0] ?? null;
  const bound = backfillSinceDate(id, now);
  // INFORMATIONAL ONLY (see the DEPTH note in the docblock): days the stored head sits ABOVE
  // (younger than) its own FETCH bound. Printed, never graded — several members are bound by a
  // truncated feed or a scorer warmup and can never close this gap.
  const gapDays = first === null ? null : Math.round((Date.parse(first) - Date.parse(bound)) / DAY_MS);
  // What DEPTH actually grades: calendar days of history the id holds today.
  const heldDays = first === null ? null : Math.round((now.getTime() - Date.parse(first)) / DAY_MS);
  return { id, n: pts.length, first, last: dates[dates.length - 1] ?? null, bound, gapDays, heldDays };
});

const short = rows.filter((r) => r.first === null || r.first > BACKFILL_FLOOR);
const shallow = rows.filter((r) => r.heldDays === null || r.heldDays < MIN_USABLE_DEPTH_DAYS);

console.log(
  `floor ${BACKFILL_FLOOR} · min usable depth ${MIN_USABLE_DEPTH_TRADING_DAYS} trading days (${MIN_USABLE_DEPTH_DAYS} cal) · ${ids.length} ${ROSTER}`,
);
console.log(`gap = days above the 15y FETCH bound (informational, never graded)\n`);
console.log("id            rows    first        last         floor    bound        gap      held     depth");
for (const r of rows) {
  const floor = r.first === null ? "MISSING" : r.first > BACKFILL_FLOOR ? "SHORT" : "ok";
  const depth =
    r.first === null ? "MISSING" : (r.heldDays ?? 0) < MIN_USABLE_DEPTH_DAYS ? `SHALLOW ${r.heldDays}d` : "ok";
  const gap = r.gapDays === null ? "-" : r.gapDays > 0 ? `+${r.gapDays}d` : `${r.gapDays}d`;
  console.log(
    `${r.id.padEnd(13)} ${String(r.n).padStart(5)}  ${(r.first ?? "-").padEnd(11)}  ${(r.last ?? "-").padEnd(11)}  ${floor.padEnd(8)} ${r.bound.padEnd(11)}  ${gap.padEnd(7)}  ${String(r.heldDays ?? "-").padStart(5)}d   ${depth}`,
  );
}
if (short.length > 0) {
  console.error(`\n${short.length} member(s) do not reach the floor: ${short.map((r) => r.id).join(", ")}`);
}
if (shallow.length > 0) {
  console.error(
    `\n${shallow.length} member(s) hold less than ${MIN_USABLE_DEPTH_TRADING_DAYS} trading days (${MIN_USABLE_DEPTH_DAYS} cal) of history: ${shallow
      .map((r) => `${r.id} ${r.heldDays ?? "MISSING"}d`)
      .join(", ")}`,
  );
}
if (short.length > 0 || shallow.length > 0) {
  process.exit(1);
}
console.log(`\nevery id in the roster reaches its floor and holds at least ${MIN_USABLE_DEPTH_TRADING_DAYS} trading days`);
