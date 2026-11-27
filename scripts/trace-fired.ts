/**
 * trace-fired.ts — W1-j (OQ-5): trace WHICH family/floor drove the alert band on a
 * given fired-date, and whether the driving feeds were LAGGING.
 *
 * "A dial eyeballed on garbage inputs is a worthless verdict" — before the W2-e
 * eyeball trusts a prod alert (e.g. the 2026-07-15 CRITICAL), this dumps:
 *   - the persisted alert row: level + `bandReason` (floor:credit / regime / lag-hold
 *     / floor:geo|rate|r4 / no-dial) + `dialBand` + the `degraded[]` non-live-feed trace;
 *   - every stored reading for that run: obs_date, age (fired-date − obs_date, in days),
 *     state, and family — so a RED-but-lagging driver is visible at a glance.
 *
 * Read-only. Runs against whatever store the env points at — LOCAL by default
 * (`.env.local`); the 2026-07-15 CRITICAL lives only in PROD, so run this from the
 * host with prod `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` in the env:
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npx tsx scripts/trace-fired.ts 2026-07-15
 *
 * Default date is 2026-07-15. Age is calendar days; read it against the id's own resolved cut
 * (`lagCutFor` / `LAG_THRESHOLDS`, ladder.ts) rather than a number remembered here — a T+1
 * daily feed is legitimately several days behind on a Monday, and a weekly one (FXH / H.10) rides
 * a whole release cycle. The report FLAGS, it does not decide.
 */
import { getStore, type AlertRecord, type StoredReading } from "../src/store.js";
import { familyOf } from "../src/families.js";
import type { State } from "../src/domain-types.js";
import { isoDay } from "../src/dates.js";
import { readEnv } from "../src/config.js";

const DEFAULT_DATE = "2026-07-15";
/** Calendar days a reading may lag before we mark it ⚠ in the report (not a gate — a hint). */
const STALE_HINT_DAYS = 4;

function utcDate(iso: string): string {
  // firedAt is an ISO timestamp; obs_date is already YYYY-MM-DD. Normalise both to the UTC day.
  return isoDay(new Date(iso));
}

function daysBetween(laterIso: string, earlierIso: string): number {
  const a = Date.parse(`${utcDate(laterIso)}T00:00:00Z`);
  const b = Date.parse(`${utcDate(earlierIso)}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

async function main(): Promise<void> {
  const env = readEnv();
  const target = process.argv[2] ?? DEFAULT_DATE;
  // A "ro" handle is a `ReadStore`: it holds no write method at all (type AND run time), so a
  // write-shaped store call in this script fails `tsc` and would be `undefined` if forced.
  const store = getStore("ro", env);

  const alerts = await store.getRecentAlerts(90);
  // Match on the UTC fired-date OR the obs_date (the store keys history on fired-date,
  // but an intraday run before the 21:05 cutoff carries yesterday's obs_date).
  const hits = alerts.filter((a) => utcDate(a.firedAt) === target || a.date === target);

  if (hits.length === 0) {
    console.log(`No alert row found for ${target}.`);
    console.log(
      `  Store held ${alerts.length} recent rows: ${alerts
        .slice(0, 8)
        .map((a) => `${utcDate(a.firedAt)}=${a.level}`)
        .join(", ")}${alerts.length > 8 ? " …" : ""}`,
    );
    console.log(
      "  If this is LOCAL, the 2026-07-15 prod CRITICAL is not here — run against prod (see file header).",
    );
    return;
  }

  for (const a of hits) {
    printAlert(a);
    const readings = await store.getReadingsForRun(a.firedAt);
    printReadings(readings, a.firedAt);
    console.log("");
  }
}

function printAlert(a: AlertRecord): void {
  console.log("=".repeat(72));
  console.log(`ALERT  obs_date=${a.date}  firedAt=${a.firedAt}  (fired UTC day ${utcDate(a.firedAt)})`);
  console.log(`  level      = ${a.level}`);
  console.log(`  bandReason = ${a.bandReason ?? "(null — pre-migration row)"}   <-- WHAT drove the band`);
  console.log(`  dialBand   = ${a.dialBand ?? "(null — no dial / degraded run)"}   (raw regime band, pre-floor/lag)`);
  console.log(`  coincident = ${a.coincident}   finReds = ${a.finReds}   geoFlags = ${a.geoFlags}`);
  console.log(`  pushedAt   = ${a.pushedAt ?? "(silent)"}   pushError = ${a.pushError ?? "-"}`);
  const deg = a.degraded;
  if (deg === null) {
    console.log("  degraded   = (null — pre-migration row; non-live feeds NOT recoverable)");
  } else if (deg.length === 0) {
    console.log("  degraded   = [] — every feed was LIVE this run");
  } else {
    console.log(`  degraded   = ${deg.length} feed(s) fell back to a stored/proxy vintage:`);
    for (const d of deg) console.log(`      - ${d.scope} :: ${d.reason}`);
  }
}

function printReadings(readings: StoredReading[], firedAt: string): void {
  if (readings.length === 0) {
    console.log("  readings   = (none stored for this run_at)");
    return;
  }
  // Non-GREEN first (they're what can raise the band), then by lag.
  const rank: Record<State, number> = { RED: 0, AMBER: 1, GREEN: 2 };
  const rows = readings
    .map((r) => ({ r, age: daysBetween(firedAt, r.date), fam: familyOf(r.indicatorId) ?? "-" }))
    .sort((x, y) => rank[x.r.state] - rank[y.r.state] || y.age - x.age);

  console.log("  readings (non-GREEN first; ⚠ = obs_date older than the fired day by ≥ " + STALE_HINT_DAYS + "d):");
  console.log("    id      state   obs_date     age  family");
  for (const { r, age, fam } of rows) {
    const stale = age >= STALE_HINT_DAYS ? "⚠" : " ";
    const id = r.indicatorId.padEnd(7);
    const st = r.state.padEnd(6);
    const od = r.date.padEnd(11);
    const ag = String(age).padStart(3);
    console.log(`  ${stale} ${id} ${st}  ${od} ${ag}d  ${fam}`);
  }

  const staleNonGreen = rows.filter((x) => x.r.state !== "GREEN" && x.age >= STALE_HINT_DAYS);
  if (staleNonGreen.length > 0) {
    console.log(`  ⚠ non-GREEN driver(s) ≥ ${STALE_HINT_DAYS}d old — VERIFY CADENCE before calling it lag`);
    console.log("    (daily FRED F1/F2/F9 @ ≥4d = suspect; weekly FXH/H.10 @ ~5-7d and monthly EBP lag NORMALLY):");
    for (const { r, age, fam } of staleNonGreen) {
      console.log(`      ${r.indicatorId} = ${r.state}, ${age}d old (family ${fam})`);
    }
  }
}

main().catch((e) => {
  console.error("trace-fired failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
