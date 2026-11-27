/**
 * Early-warn pillar liveness probe (falsifier) — READ-ONLY.
 *
 * Drives the REAL danger-engine `computeField` over the last N store closes and prints,
 * for the hottest-EW dates, per-leg `subDangers.earlyWarn` + `ewRoc`. Answers one question:
 * is the EARLY-WARN pillar (share-lit over the credit + rates families) genuinely LIVE and
 * PER-LEG differentiated, or stuck-at-0?
 *
 * Origin: on a fully-calm market every leg reads earlyWarn=0 (correct — the gated reading of an
 * all-GREEN credit/rates pillar), which is indistinguishable by eye from a dead wire. This probe
 * replays a window that INCLUDES stress (e.g. 2023-08 rates/credit) so a live axis MUST emit a
 * spread of non-zero per-leg values. A run where maxEW stays ~0 across a known stress window is
 * the stuck-at-0 signature. The 2026-07-21 reference finding is no longer restated here — it is the
 * CHECKED constant `EW_REFERENCE_ARM` in `backfill/leg-pillar-walk.ts`, compared by `--check-reference`.
 *
 * The walk itself lives in `backfill/leg-pillar-walk.ts` (`replayLegPillars`) so this probe and the
 * `legpillars` backfill job exercise the SAME code path; this file is a thin CLI over it.
 *
 * STRICTLY READ-ONLY: getSeries selects only — never insert/update/delete/upsert.
 *
 * Usage:
 *   npm run probe:ew                       # defaults: --closes=900 --env=prod --top=5
 *   npx tsx --env-file-if-exists=.env.local scripts/probe-earlywarn.ts [--closes=900] [--env=local|prod] [--top=5] [--check-reference]
 * Store resolution mirrors scripts/backfill (resolve-store.ts): SUPABASE_URL+KEY in env → that
 * store; else --env=prod pulls prod creds via the Management API (host).
 */
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import {
  replayLegPillars,
  EW_REFERENCE_ARM,
  EW_REFERENCE_TOLERANCE,
} from "./backfill/leg-pillar-walk.js";
import { argOf, envArg as envArgOf } from "./lib/cli.js";

// ---------- args ----------
const REPLAY_N = Number(argOf("closes") ?? 900);
const envArg = envArgOf("prod");
const TOP = Number(argOf("top") ?? 5);
const CHECK_REFERENCE = process.argv.includes("--check-reference");

const store = await resolveStore(envArg, "ro", liveResolveDeps);

const walkRows = await replayLegPillars({ store }, { closes: REPLAY_N });

// ---------- shape the EARLY-WARN rows back into the per-date view ----------
interface Row {
  d: string;
  maxEw: number;
  per: {
    sleeve: string;
    ew: number | null;
    ewRoc: number | undefined;
    cov: { live: number; capable: number } | undefined;
  }[];
}
const byDate = new Map<string, Row>();
for (const r of walkRows) {
  if (r.superGroup !== "EARLY-WARN") continue;
  let row = byDate.get(r.date);
  if (!row) {
    row = { d: r.date, maxEw: 0, per: [] };
    byDate.set(r.date, row);
  }
  row.per.push({ sleeve: r.sleeve, ew: r.value, ewRoc: r.ewRoc, cov: r.coverage });
}
const out = [...byDate.values()];
for (const r of out) r.maxEw = Math.max(0, ...r.per.map((p) => p.ew ?? 0));
// Equal to the walk's own `replayDates.length` by construction: `replayLegPillars` emits an
// EARLY-WARN row for EVERY leg of `field.legRows` on every replayed date, and `legRows` is the
// fixed 9-leg ladder — so each replayed date contributes exactly one `byDate` entry. (If a date
// could ever yield no `legRows`, this count would silently under-report the window walked.)
const closesWalked = out.length;
out.sort((a, b) => b.maxEw - a.maxEw);

const hottest = out[0];
const distinct = hottest ? new Set(hottest.per.map((p) => (p.ew ?? 0).toFixed(3))).size : 0;
console.log(
  `EW-liveness over ${closesWalked} closes (${envArg}): peak maxEW=${(hottest?.maxEw ?? 0).toFixed(3)} on ${hottest?.d ?? "-"}, ` +
    `${distinct} distinct per-leg values at peak.`,
);
console.log(
  hottest && hottest.maxEw > 0.05 && distinct >= 3
    ? "VERDICT: LIVE — earlyWarn emits a non-zero, per-leg-differentiated spread on the stress window."
    : "VERDICT: SUSPECT — maxEW stayed ~0 / undifferentiated across the window; investigate stuck-at-0.",
);
console.log(`\nTop-${TOP} EW closes (per-leg subDangers.earlyWarn | ewRoc):`);
for (const r of out.slice(0, TOP)) {
  console.log(`\n${r.d}  maxEW=${r.maxEw.toFixed(3)}`);
  for (const p of r.per) {
    if ((p.ew ?? 0) > 0 || p.ewRoc !== undefined)
      console.log(
        `   ${p.sleeve.padEnd(9)} ew=${p.ew === null ? "null" : p.ew.toFixed(3)}  ewRoc=${p.ewRoc === undefined ? "-" : p.ewRoc.toFixed(3)}  cov=${p.cov ? `${p.cov.live}/${p.cov.capable}` : "-/-"}`,
      );
  }
}

// ---------- pinned reference arm (opt-in, exits non-zero on drift) ----------
if (CHECK_REFERENCE) {
  const ews = (hottest?.per ?? []).map((p) => p.ew).filter((v): v is number => v !== null);
  const ewMin = ews.length ? Math.min(...ews) : NaN;
  const ewMax = ews.length ? Math.max(...ews) : NaN;
  const near = (a: number, b: number) => Math.abs(a - b) <= EW_REFERENCE_TOLERANCE;
  const drifts: string[] = [];
  if (REPLAY_N !== EW_REFERENCE_ARM.closes || envArg !== EW_REFERENCE_ARM.env)
    drifts.push(
      `arm is pinned at --closes=${EW_REFERENCE_ARM.closes} --env=${EW_REFERENCE_ARM.env}, ran --closes=${REPLAY_N} --env=${envArg}`,
    );
  if ((hottest?.d ?? "-") !== EW_REFERENCE_ARM.date)
    drifts.push(`hottest close ${hottest?.d ?? "-"} ≠ ${EW_REFERENCE_ARM.date}`);
  if (!near(ewMin, EW_REFERENCE_ARM.ewMin))
    drifts.push(`ewMin ${ewMin.toFixed(3)} ≠ ${EW_REFERENCE_ARM.ewMin}`);
  if (!near(ewMax, EW_REFERENCE_ARM.ewMax))
    drifts.push(`ewMax ${ewMax.toFixed(3)} ≠ ${EW_REFERENCE_ARM.ewMax}`);
  if (drifts.length === 0) {
    console.log(
      `\nREFERENCE: MATCH (${EW_REFERENCE_ARM.date}, EW ${EW_REFERENCE_ARM.ewMin}..${EW_REFERENCE_ARM.ewMax})`,
    );
  } else {
    console.log(`\nREFERENCE: DRIFT (${drifts.join("; ")})`);
    process.exitCode = 1;
  }
}
