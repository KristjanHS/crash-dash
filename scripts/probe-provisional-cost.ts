/**
 * PROVISIONAL-PUSH COST PROBE — lever 2(a) step 1 of the fast-credit-signal work.
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/probe-provisional-cost.ts                              # LIVE DEV store (wrap in db.sh with dev)
 *   npx tsx --env-file-if-exists=.env.local scripts/probe-provisional-cost.ts --env=prod --limit=6000
 *
 * WHAT IT MEASURES, per indicator, over the STORED reading history:
 *  · raw-RED days that NEVER reached a CONFIRMED RED — the false alarms a "push on raw RED"
 *    would have produced — grouped into EPISODES (contiguous raw-RED runs), because the
 *    design fires at most one provisional per episode.
 *  · the confirmed-RED episodes a provisional would have PRE-EMPTED, and by how many
 *    trading days (the lead the bypass actually buys).
 *  · both counts ANNUALISED over the indicator's own covered calendar span — the units the
 *    user's ≈12 fires/year tolerance gate is stated in.
 * The same numbers are emitted for AMBER (free: the identical fold, one rank up).
 *
 * ROUTE (the correctness question this probe has to answer honestly): the `readings` table
 * persists BOTH `raw_state` and the confirmed `state` (store.ts READINGS_COLS), so the raw
 * state is read straight off production's own persisted scoring output — no re-derivation
 * from values + cuts, and therefore NO opportunity for a probe-local cut copy to drift from
 * `resolveCuts`. The CONFIRMED series is then RE-FOLDED here through the real
 * `confirmedStateSeries` / `deriveConfirmedState` at `confirmClosesFor(id)` closes, and the
 * refold is CHECKED against the persisted `state` (see AGREEMENT below) — so a stored-state
 * vintage that predates a cut/fold change shows up as a disagreement count instead of
 * silently skewing the episode maths. Nothing here restates a cut or `CONFIRM_CLOSES`.
 *
 * NON-VACUITY: `selfTest()` runs the episode extractor over hand-checked synthetic raw-state
 * sequences and THROWS on mismatch — it fails if the fold semantics or the episode pairing
 * are wrong (demonstrated red by mutating the expectation or the extractor).
 *
 * ⚠ STRICTLY READ-ONLY: `getSeries` selects only. The dev-DB history is irreplaceable —
 * never insert/update/delete here, never set DB_TESTS.
 */
import { resolveStore } from "./backfill/resolve-store.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { confirmedStateSeries } from "../src/domain-fold.js";
import { confirmClosesFor } from "../src/family-table.js";
import type { State } from "../src/domain-types.js";
import { argOf, envArg as envArgOf } from "./lib/cli.js";

const envArg = envArgOf("local");
const LIMIT = Number(argOf("limit") ?? 6000);
const DAYS_PER_YEAR = 365.25;
const MS_PER_DAY = 86_400_000;

interface Episode {
  /** index of the first raw-<target> day of the run */
  start: number;
  /** index of the last raw-<target> day of the run */
  end: number;
  /** index of the first day the CONFIRMED series reached <target> inside the run, or -1 */
  confirmedAt: number;
  /**
   * The confirmed state was ALREADY `target` on the day before this run started — a
   * held-over confirmation from an earlier episode. Such a run can produce no provisional
   * push at all (production already sits at that state and `decideNotify` is upward-only
   * against the last persisted band), so it counts as neither a false alarm nor a
   * pre-emption. Reported separately so the exclusion is auditable rather than silent.
   *
   * This distinction is load-bearing and was found by the selfTest below going RED: with a
   * naive "any confirmed==target inside the run" test, a carried-over RED credits the run
   * with a confirmation it did not cause. For a NON-suppressed run the attribution is exact:
   * the fold only adopts a candidate that held `closes` consecutive raw days ending at k, and
   * every raw day before `start` differs from `target`, so any in-run confirmation is this
   * run's own.
   */
  suppressed: boolean;
}

/**
 * Split a raw-state series into contiguous runs of EXACTLY the `target` state — what a
 * raw-state push triggers on (`rawState === "RED"`) — and pair each with the confirmation
 * it actually caused. A non-suppressed run with `confirmedAt === -1` is a FALSE ALARM: the
 * provisional fired and the confirm never followed.
 */
export function episodesOf(raw: State[], confirmed: State[], target: State): Episode[] {
  const out: Episode[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== target) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < raw.length && raw[j + 1] === target) j++;
    const suppressed = i > 0 && confirmed[i - 1] === target;
    let confirmedAt = -1;
    for (let k = i; k <= j; k++) {
      if (confirmed[k] === target) {
        confirmedAt = k;
        break;
      }
    }
    out.push({ start: i, end: j, confirmedAt, suppressed });
    i = j + 1;
  }
  return out;
}

/** Hand-checked fixtures — the falsifier. Throws (non-zero exit) if the extractor or the
 *  real fold disagrees with the worked expectation. */
function selfTest(): void {
  const G: State = "GREEN";
  const R: State = "RED";
  // 2-close fold. Run of 1 (never confirms) · run of 3 (confirms on its 2nd day) · run of 1.
  // Run of 1 (never confirms) · run of 3 (confirms on its 2nd day) · run of 1 that sits
  // under a HELD-OVER confirmed RED (index 6's lone GREEN cannot de-confirm at 2 closes) —
  // suppressed, so neither a false alarm nor a pre-emption.
  const raw: State[] = [G, R, G, R, R, R, G, R];
  const confirmed = confirmedStateSeries(raw, 2);
  const eps = episodesOf(raw, confirmed, R);
  const got = eps.map((e) => `${e.start}-${e.end}@${e.confirmedAt}${e.suppressed ? "s" : ""}`).join(",");
  const want = "1-1@-1,3-5@4,7-7@7s";
  if (got !== want) throw new Error(`selfTest: episodes ${got} !== ${want}`);
  const falseAlarms = eps.filter((e) => !e.suppressed && e.confirmedAt < 0);
  if (falseAlarms.length !== 1) throw new Error(`selfTest: expected 1 false alarm, got ${falseAlarms.length}`);
  const falseDays = falseAlarms.reduce((n, e) => n + (e.end - e.start + 1), 0);
  if (falseDays !== 1) throw new Error(`selfTest: expected 1 false-alarm day, got ${falseDays}`);
  if (eps.filter((e) => e.suppressed).length !== 1) throw new Error("selfTest: expected 1 suppressed run");
  const lead = eps[1]!.confirmedAt - eps[1]!.start;
  if (lead !== 1) throw new Error(`selfTest: expected 1 day of lead, got ${lead}`);
  // A 3-close fold must NOT confirm the 3-day run until its 3rd day.
  const c3 = confirmedStateSeries(raw, 3);
  const e3 = episodesOf(raw, c3, R)[1]!;
  if (e3.confirmedAt - e3.start !== 2) throw new Error(`selfTest: 3-close lead ${e3.confirmedAt - e3.start} !== 2`);
  if (e3.suppressed) throw new Error("selfTest: the 3-day run must not be suppressed at 3 closes");
}

interface Row {
  id: string;
  closes: number;
  n: number;
  first: string;
  last: string;
  years: number;
  falseEpisodes: number;
  falseDays: number;
  preempted: number;
  meanLead: number;
  suppressed: number;
  disagree: number;
}

function measure(
  id: string,
  closes: number,
  dates: string[],
  raw: State[],
  confirmed: State[],
  target: State,
  disagree: number,
): Row {
  const eps = episodesOf(raw, confirmed, target);
  const live = eps.filter((e) => !e.suppressed);
  const bad = live.filter((e) => e.confirmedAt < 0);
  const good = live.filter((e) => e.confirmedAt >= 0);
  const first = dates[0] ?? "-";
  const last = dates[dates.length - 1] ?? "-";
  const years =
    dates.length > 1 ? (Date.parse(last) - Date.parse(first)) / MS_PER_DAY / DAYS_PER_YEAR : 0;
  const leads = good.map((e) => e.confirmedAt - e.start);
  return {
    id,
    closes,
    n: dates.length,
    first,
    last,
    years,
    falseEpisodes: bad.length,
    falseDays: bad.reduce((n, e) => n + (e.end - e.start + 1), 0),
    preempted: good.length,
    meanLead: leads.length === 0 ? 0 : leads.reduce((a, b) => a + b, 0) / leads.length,
    suppressed: eps.length - live.length,
    disagree,
  };
}

const rate = (count: number, years: number): number => (years <= 0 ? Number.NaN : count / years);

/** Minimum covered span before an annualised rate is quotable at all. */
const MIN_YEARS = 1;

/**
 * Why a row is NOT a candidate for the provisional path, or "" if it is one. Two
 * exclusions, both of which otherwise read as a flattering 0.0/yr:
 *  - `closes <= 1` (volatility + cross-asset families, `CONFIRM_TIERS`): the fold is a
 *    same-day identity, so raw IS confirmed — there is no confirm day to bypass and the
 *    false-alarm count is 0 BY CONSTRUCTION, not by measurement.
 *  - a span under `MIN_YEARS`: the annualisation divides by a fraction of a year and the
 *    rate is noise (a 2-row series "measures" 182/yr).
 */
const excludedBecause = (r: Row): string =>
  r.closes <= 1 ? "same-day fold (no confirm to bypass)" : r.years < MIN_YEARS ? "span < 1y" : "";
const pad = (s: string, w: number): string => s.padEnd(w);
const padL = (s: string, w: number): string => s.padStart(w);

function printTable(title: string, rows: Row[], gate: number): void {
  console.log(`\n=== ${title} ===`);
  console.log(
    `${pad("id", 8)}${padL("cls", 4)}${padL("rows", 6)}  ${pad("span", 24)}${padL("yrs", 6)}` +
      `${padL("falseEp", 8)}${padL("/yr", 7)}${padL("falseDy", 8)}${padL("dy/yr", 7)}` +
      `${padL("preempt", 8)}${padL("lead", 6)}${padL("supp", 6)}${padL("dis", 5)}`,
  );
  for (const r of rows) {
    const epr = rate(r.falseEpisodes, r.years);
    const dyr = rate(r.falseDays, r.years);
    console.log(
      `${pad(r.id, 8)}${padL(String(r.closes), 4)}${padL(String(r.n), 6)}  ` +
        `${pad(`${r.first}..${r.last}`, 24)}${padL(r.years.toFixed(2), 6)}` +
        `${padL(String(r.falseEpisodes), 8)}${padL(epr.toFixed(1), 7)}` +
        `${padL(String(r.falseDays), 8)}${padL(dyr.toFixed(1), 7)}` +
        `${padL(String(r.preempted), 8)}${padL(r.meanLead.toFixed(2), 6)}` +
        `${padL(String(r.suppressed), 6)}${padL(String(r.disagree), 5)}  ${excludedBecause(r)}`,
    );
  }
  const eligible = rows.filter((r) => excludedBecause(r) === "");
  const admitted = eligible.filter((r) => rate(r.falseEpisodes, r.years) <= gate);
  console.log(
    `\nAT OR UNDER ${gate}/yr, of the ${eligible.length} ids with a real fold AND ≥${MIN_YEARS}y of span: ` +
      `${admitted.length} — ` +
      (admitted.length === 0 ? "(none)" : admitted.map((r) => r.id).join(", ")),
  );
  const over = eligible.filter((r) => rate(r.falseEpisodes, r.years) > gate);
  console.log(`OVER the gate: ${over.length === 0 ? "(none)" : over.map((r) => r.id).join(", ")}`);
  console.log(`EXCLUDED: ${rows.length - eligible.length} (reason in the last column)`);
}

async function main(): Promise<void> {
  selfTest();
  console.log(`selfTest OK (episode extractor + real fold).`);

  const store = await resolveStore(envArg, "ro");
  const rowsRed: Row[] = [];
  const rowsAmber: Row[] = [];
  let totalRows = 0;
  let globalFirst = "9999-99-99";
  let globalLast = "0000-00-00";
  /** Registry ids with ZERO stored rows — measured nothing, so they must be NAMED, not
   *  silently skipped (a missing id would otherwise read as "no false alarms"). */
  const noHistory: string[] = [];

  for (const ind of ALL_INDICATORS) {
    const pts = await store.getSeries(ind.id, LIMIT);
    if (pts.length === 0) {
      noHistory.push(ind.id);
      continue;
    }
    // getSeries already returns oldest→newest; sort anyway so the fold's direction is
    // this probe's own invariant, not an inherited one.
    const asc = [...pts].sort((a, b) => a.date.localeCompare(b.date));
    const dates = asc.map((p) => p.date);
    const raw = asc.map((p) => p.rawState);
    const stored = asc.map((p) => p.state);
    const closes = confirmClosesFor(ind.id);
    const confirmed = confirmedStateSeries(raw, closes);
    // AGREEMENT: how many days the re-fold differs from the persisted confirmed state. A
    // non-zero count means the stored vintage was scored under different cuts/fold — the
    // episode maths below is the RE-FOLD's, which is the live semantics.
    const disagree = confirmed.reduce((n, s, k) => n + (s === stored[k] ? 0 : 1), 0);
    totalRows += dates.length;
    if (dates[0]! < globalFirst) globalFirst = dates[0]!;
    if (dates[dates.length - 1]! > globalLast) globalLast = dates[dates.length - 1]!;
    rowsRed.push(measure(ind.id, closes, dates, raw, confirmed, "RED", disagree));
    rowsAmber.push(measure(ind.id, closes, dates, raw, confirmed, "AMBER", disagree));
  }

  if (rowsRed.length === 0) {
    console.log("ABORT: no stored readings found — nothing to measure.");
    process.exitCode = 1;
    return;
  }

  const byRate = (a: Row, b: Row): number => {
    const ra = rate(a.falseEpisodes, a.years);
    const rb = rate(b.falseEpisodes, b.years);
    if (Number.isNaN(ra)) return 1;
    if (Number.isNaN(rb)) return -1;
    return ra - rb || a.id.localeCompare(b.id);
  };

  console.log(
    `\nCOVERED: ${globalFirst} .. ${globalLast} · ${totalRows} reading rows across ${rowsRed.length} indicators` +
      ` (per-indicator span + row count in the table; "cls" = confirmClosesFor, "dis" = refold-vs-stored disagreements).`,
  );
  console.log(
    `NO STORED HISTORY (measured nothing, NOT "no false alarms"): ` +
      (noHistory.length === 0 ? "(none)" : noHistory.join(", ")),
  );
  printTable("RAW RED never confirmed (the provisional-push false-alarm cost)", [...rowsRed].sort(byRate), 12);
  printTable("RAW AMBER never confirmed (free, same fold)", [...rowsAmber].sort(byRate), 12);
}

await main();
