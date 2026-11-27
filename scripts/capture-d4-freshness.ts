/**
 * D4's STOP-gate capture.
 *
 * Serves `/api/lab` TWICE against the SAME database — once with the series-newest freshness stamp
 * wired ON (HEAD's behaviour), once with it OFF (the pre-stage-1 behaviour, where `computeField`
 * receives no `freshness` and `obsOf` falls back to `"lag"` on every member) — and asserts BOTH of
 * D4's conditions:
 *
 *   1. NON-VACUITY: the per-cell census must MOVE between the two arms, and the ON arm must be off
 *      `fresh: 0`. §I6.1 recorded a byte-identical capture taken on the dev DB whose census was
 *      `FRESH=0/STALE=64` on BOTH arms — there the no-move result was a tautology, not a proof. A
 *      capture that can only ever print "identical" is exactly the vacuous instrument this rung
 *      exists to reject, so the census control is a hard, exit-code-bearing condition.
 *   2. NO DECISION MOVED: every `danger` / `subDangers` (earlyWarn + stressNow) / `ewPct` /
 *      `coverage` on all nine legs, plus the field band + held and the dial rung,
 *      must be byte-identical. Freshness is a display/census concern; it must not move a number.
 *
 * Exit code is 0 only when BOTH hold. Run it read-only against PROD (that is the only DB whose cron
 * makes the census mixed — §I7.1):
 *
 *     npm run probe:d4-freshness            # uses .env.prod
 *
 * ⛔ Read-only. It issues GETs through the `/api/lab` handler and writes nothing.
 *
 * HOW THE OFF ARM IS BUILT — deliberately NOT a production toggle. `api/lab.ts` resolves the stamp
 * with `freshnessFrom(store).catch(() => undefined)`, i.e. a failed freshness read already
 * degrades to exactly the un-stamped state. This script reproduces that degradation from the
 * OUTSIDE, by patching `SupabaseStore.prototype.getSeriesBulk` for the duration of the OFF call and
 * throwing on the ONE call whose id list is exactly `CADENCE_OF`'s keys with `limit: 1` — the
 * freshness read and nothing else. No shipped code learns that this script exists. The patch is
 * self-checking: if it never fires, the OFF arm was not actually OFF and the run fails.
 */
import { GET } from "../api/lab.js";
import { CADENCE_OF, freshnessFrom } from "../src/feed-lag.js";
import { getStore, SupabaseStore } from "../src/store.js";
import { todayOnFeedCalendar } from "../src/dates.js";
import { readEnv } from "../src/config.js";

/** Mirrors `CellObserved` (`src/danger-cell.ts`) — `deepLag` included, because a local shape that
 *  omits a served counter silently drops it from `add`/`same`/`fmt` and the capture then cannot see
 *  a rot-count move at all. This script predates `deepLag` (it landed before the
 *  `deepLag`/`feedLag` server half); the omission was exactly that defect. */
type Census = { fresh: number; lag: number; absent: number; deepLag: number };

interface Arm {
  /** Census summed over every cell of every leg. */
  total: Census;
  /** Per-leg census, keyed by sleeve — what §I6.1's "fresh: 0 on all nine legs" talks about. */
  perLeg: Record<string, Census>;
  /** The decision surface: everything freshness must NOT move. */
  decisions: unknown;
  /** How many times the OFF patch intercepted the freshness read (0 on the ON arm, ≥1 on OFF). */
  patchHits: number;
}

/** The monthly/quarterly ids `freshnessFrom`'s stage 1 reads at limit 1 (since R14.4; the daily/weekly
 *  ids are read deep instead). Throwing on this read rejects the WHOLE stamp — the way a store failure
 *  already does — so it is the seam the OFF arm suppresses. */
const FRESHNESS_DAY_IDS = new Set(
  [...CADENCE_OF].filter(([, c]) => c !== "daily" && c !== "weekly").map(([id]) => id),
);

/** Is this `getSeriesBulk` call `freshnessFrom`'s stage-1 monthly/quarterly read? Matched on the exact
 *  id set + limit so the patch cannot silently swallow the leg-pillar / scoreboard / y1 reads. */
function isFreshnessRead(ids: readonly string[], opts: { limit: number }): boolean {
  return opts.limit === 1 && ids.length === FRESHNESS_DAY_IDS.size && ids.every((id) => FRESHNESS_DAY_IDS.has(id));
}

const ZERO: Census = { fresh: 0, lag: 0, absent: 0, deepLag: 0 };
const add = (a: Census, b: Census): Census => ({
  fresh: a.fresh + b.fresh,
  lag: a.lag + b.lag,
  absent: a.absent + b.absent,
  deepLag: a.deepLag + b.deepLag,
});

/** Serve `/api/lab` once. `off === true` suppresses the freshness read the way a store failure
 *  already does, so `computeField` runs with `freshness: undefined` on all four call sites. */
async function serve(off: boolean): Promise<Arm> {
  let patchHits = 0;
  const original = SupabaseStore.prototype.getSeriesBulk;
  if (off) {
    SupabaseStore.prototype.getSeriesBulk = async function (
      this: SupabaseStore,
      ids: string[],
      opts: { limit: number; range?: Parameters<SupabaseStore["getSeriesBulk"]>[1]["range"] },
    ) {
      if (isFreshnessRead(ids, opts)) {
        patchHits += 1;
        throw new Error("capture-d4-freshness: freshness read suppressed (OFF arm)");
      }
      return original.call(this, ids, opts);
    };
  }
  let json: {
    field: {
      band: unknown;
      held: unknown;
      legRows: {
        sleeve: string;
        cells: { family: string; observed: Census }[];
        danger: unknown;
        subDangers: unknown;
        ewPct: unknown;
        coverage: unknown;
        regime: unknown;
      }[];
    };
    t1dial?: unknown;
    band?: unknown;
    ladder?: unknown;
    bandReason?: unknown;
    firingCount?: unknown;
    asOf?: unknown;
  };
  try {
    const res = await GET(new Request("https://capture.local/api/lab"));
    if (res.status !== 200) throw new Error(`/api/lab returned ${res.status}`);
    json = (await res.json()) as typeof json;
  } finally {
    if (off) SupabaseStore.prototype.getSeriesBulk = original;
  }

  const perLeg: Record<string, Census> = {};
  let total = ZERO;
  for (const leg of json.field.legRows) {
    let legTotal = ZERO;
    for (const cell of leg.cells) legTotal = add(legTotal, cell.observed);
    perLeg[leg.sleeve] = legTotal;
    total = add(total, legTotal);
  }

  const decisions = {
    band: json.band,
    ladder: json.ladder,
    bandReason: json.bandReason,
    firingCount: json.firingCount,
    asOf: json.asOf,
    t1dial: json.t1dial,
    fieldBand: json.field.band,
    fieldHeld: json.field.held,
    legs: json.field.legRows.map((leg) => ({
      sleeve: leg.sleeve,
      danger: leg.danger,
      subDangers: leg.subDangers,
      ewPct: leg.ewPct,
      coverage: leg.coverage,
      regime: leg.regime,
      // the cell numbers themselves are decisions too — `stripObserved` removes only the display half
      cells: leg.cells,
    })),
  };
  return { total, perLeg, decisions, patchHits };
}

/** Drop every `observed` census, at ANY depth, from the decision surface — `field.held` re-serves a
 *  whole leg row (cells included), so a shallow strip on `legRows` alone would leave a census inside
 *  the compared object and turn condition 2 into a restatement of condition 1. `observed` is the
 *  ONLY display half; everything else in those objects (`cellState`/`M`/`N`/`wsev`) stays compared. */
function stripObserved(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripObserved);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => k !== "observed")
        .map(([k, v]) => [k, stripObserved(v)]),
    );
  }
  return value;
}

const fmt = (c: Census) => `fresh=${c.fresh} lag=${c.lag} absent=${c.absent} rot=${c.deepLag}`;
const same = (a: Census, b: Census) =>
  a.fresh === b.fresh && a.lag === b.lag && a.absent === b.absent && a.deepLag === b.deepLag;

async function main(): Promise<void> {
  const env = readEnv();
  const on = await serve(false);
  const off = await serve(true);

  // The PER-ID figure §I7.1 banked (≈58 fresh / 12 lagging) — re-measured here through the wiring's own
  // `freshnessFrom`, never asserted from the plan. It is the input to the per-cell census below.
  // The DEFAULT publication calendar's date, for the log line only — `freshnessFrom` resolves each
  // id's own `feedTimeZone` internally, so a single date here would misreport what it scored against.
  const today = todayOnFeedCalendar(undefined, new Date());
  const { freshness: perId } = await freshnessFrom(getStore("ro", env), new Date());
  const staleIds = perId.filter((m) => m.lag).map((m) => m.id);

  console.log("=== D4 STOP-gate capture — /api/lab, freshness ON vs OFF ===");
  console.log(`today=${today}  ids=${perId.length}  per-id: FRESH=${perId.length - staleIds.length} LAG=${staleIds.length}`);
  console.log(`lag ids: ${staleIds.join(" ") || "(none)"}`);
  console.log(`ON   census (all legs): ${fmt(on.total)}`);
  console.log(`OFF  census (all legs): ${fmt(off.total)}`);
  console.log("");
  console.log("per-leg census (ON | OFF):");
  for (const [sleeve, onLeg] of Object.entries(on.perLeg)) {
    const offLeg = off.perLeg[sleeve] ?? ZERO;
    const moved = same(onLeg, offLeg) ? "   " : " * ";
    console.log(`${moved}${sleeve.padEnd(16)} ${fmt(onLeg)}  |  ${fmt(offLeg)}`);
  }

  const failures: string[] = [];

  // --- Condition 0: the OFF arm really was OFF -------------------------------------------------
  if (off.patchHits === 0) {
    failures.push("OFF arm never intercepted the freshness read — the two arms ran the SAME code path");
  }

  // --- Condition 1: non-vacuity — the census must move --------------------------------------------
  if (on.total.fresh === 0) {
    failures.push(`ON census is fresh: 0 — every member reads unassessed, the vacuous regime of §I6.1`);
  }
  if (same(on.total, off.total)) {
    failures.push(
      `census did NOT move between ON and OFF (${fmt(on.total)} both ways) — this DB cannot falsify ` +
        `anything and the byte-identical result below proves NOTHING (§I6.1)`,
    );
  }

  // --- Condition 2: no decision moved -------------------------------------------------------------
  const onJson = JSON.stringify(stripObserved(on.decisions), null, 1);
  const offJson = JSON.stringify(stripObserved(off.decisions), null, 1);
  // The strip must be COMPLETE: a surviving census would make condition 2 a restatement of condition
  // 1 (guaranteed to differ) instead of the no-move proof it is supposed to be.
  // Applied to BOTH arms: the OFF arm is a separately-serialized object, so checking only `onJson`
  // left the asymmetry that a census surviving on one side alone would go unreported.
  const CENSUS_KEY = /"fresh":|"lag":|"absent":|"rot":/;
  if (CENSUS_KEY.test(onJson) || CENSUS_KEY.test(offJson)) {
    failures.push("a census survived `stripObserved` — the decision diff below is not a decision diff");
  }
  if (onJson === offJson) {
    console.log("\ndecision surface: IDENTICAL (danger / subDangers / ewPct / coverage /");
    console.log("                  regime / cell wsev+M+N+cellState on all legs, band, held, dial)");
  } else {
    const onLines = onJson.split("\n");
    const offLines = offJson.split("\n");
    const diffs: string[] = [];
    for (let i = 0; i < Math.max(onLines.length, offLines.length); i += 1) {
      if (onLines[i] !== offLines[i]) diffs.push(`  line ${i + 1}: ON ${onLines[i]}  ≠  OFF ${offLines[i]}`);
      if (diffs.length >= 40) break;
    }
    console.log(`\ndecision surface: ${diffs.length >= 40 ? "40+" : diffs.length} differing line(s):`);
    console.log(diffs.join("\n"));
    failures.push("a decision field MOVED between ON and OFF — D4's STOP-gate condition 2 failed");
  }

  console.log("");
  if (failures.length > 0) {
    console.log("VERDICT: FAIL");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("VERDICT: PASS — the census moved (non-vacuity control) and no decision number did.");
}

await main();
