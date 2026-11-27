/**
 * Read-only probe counting the days the LOW branch of `classifyDerived`
 * (`src/scorers-core.ts`) reclassifies when its amber comparison moves from strict
 * `d < amber` to inclusive `d <= amber` — the audit's row-18 HARD GATE
 * (CORE-B6).
 *
 *   npm run probe:low-tie        # reads the store, writes NOTHING
 *
 * ## Why an exact-tie count IS the full replay
 *
 * The two arms differ on exactly one input: a decision variable EQUAL to the resolved
 * amber cut. Everything strictly below amber is AMBER under both; everything strictly
 * above is GREEN under both; and the RED branch (`d <= red`, unchanged) already claims
 * every `d <= red`. Since a LOW descriptor has `red < amber`, a day sitting ON amber is
 * never RED, so its whole transition set is the single arrow GREEN → AMBER. Counting
 * `d === amber` therefore enumerates the changed days exactly — it is not a sample of
 * the replay, it is the replay's changed-set.
 *
 * ⚠ **[USER] budget cap (2026-08-08, reaffirmed 2026-08-09): AGGREGATE COUNTS ONLY.**
 * This probe prints days-changed and transitions by tier and MUST NOT gain a per-day
 * log — the history is not to be pulled into an agent's context. The `--dates` escape
 * hatch below prints at most `MAX_DATES` ISO dates and exists only so a NON-ZERO count
 * can be chased by a human; it is capped, not a log.
 *
 * ## The population is derived, never hand-listed
 *
 * Membership is `!derivedFiresHighward(view)` over the SHIPPED registry, evaluated on
 * the RESOLVED bands — the same view `classifyDerived` recomputes `high` from — so a
 * new LOW-firing indicator joins the probe automatically.
 *
 * ⚠ This roster is a DIFFERENT set from the one the plan's prose named ("maSpread, plus
 * return with a negative amber"), NOT a superset — an earlier version of this docblock
 * claimed superset and was wrong in both directions:
 *   - the justification it gave is empty: ZERO `identity` descriptors ship (`DerivedKind`
 *     admits the kind; no registry entry uses it), so that class adds nobody today;
 *   - and the roster EXCLUDES one id the prose includes. **F6** is described raw as
 *     `amber -0.025 / red -0.05` (a negative-amber return ⇒ LOW by the prose), but
 *     `threshold-config.json` gives it the SIGN-FLIPPING `amberMult -6.0 / redMult -0.5`,
 *     so its resolved pair is `amber +0.15 / red +0.025` and `derivedFiresHighward` on the
 *     RESOLVED view is true. Excluding it is CORRECT twice over: `classifyDerived`
 *     recomputes `high` from that same resolved view, so F6 genuinely takes the HIGH branch
 *     there; and F6 never reaches `classifyDerived` at all — `relStrengthReadingSeries`
 *     (`src/scorers-price.ts`) classifies it with its own rules.
 *
 * Using the RESOLVED rather than the unresolved view is therefore the load-bearing choice
 * here. Note `derivedRawStateSeries` computes `firesHighward` from the UNRESOLVED descriptor
 * before calling `resolveBands`; had this probe copied that shape it would have counted F6
 * spuriously. If the printed roster disagrees with the plan's prose, the roster is right.
 *
 * ## The roster is CONSERVATIVE: only 2 of the 5 can actually move
 *
 * Of the 5 shipped members (F4, NVDA, F13, CG, GT), only **NVDA** and **GT** reach
 * `classifyDerived` for their card state — both route through `derivedReadingSeries`. The
 * other three classify with their OWN closures and never touch the LOW branch: F4 via
 * `semisReadingSeries`, F13 via `downsideBreakReadingSeries`'s bespoke two-leg drawdown rule,
 * CG via `ratioSpreadState` (`src/scorers-composite.ts`). Their ties therefore could not have
 * changed anything under either operator (and all three already use inclusive amber edges of
 * their own). Over-inclusive is the safe direction — it keeps K = 0 valid as a gate — but it
 * matters if this probe is re-run after a retune: a non-zero count on F4/F13/CG is NOT
 * evidence the LOW branch moved a day.
 *
 * ## What this measures, stated as its own limit
 *
 * The decision variable is the PERSISTED cron-time `decision` column (single-sourced by
 * `decisionAt`, the same scalar the scorer classifies), compared against TODAY'S
 * resolved bands. So a day is counted iff its cron-time decision ties the CURRENT cut.
 * That is the right question for an operator change — the operator is what moved, the
 * cut did not — but it is NOT a point-in-time replay of historical cuts, and the count
 * must never be read as one. Rows with a null `decision` (pre-migration, or a degraded
 * cycle) cannot be scored either way and are reported as `unscoreable`, never silently
 * dropped: an all-null run would otherwise print a confident `0`.
 */
import { ALL_INDICATORS } from "../src/registry.js";
import { derivedFiresHighward, resolvedDerivedBands } from "../src/scorers-core.js";
import { getStore } from "../src/store.js";
import { readEnv } from "../src/config.js";

/** Deep enough to cover every scored history in the store; the probe is read-only. */
const HISTORY_LIMIT = 20000;
/** Cap on the `--dates` escape hatch — a bounded chase list, never a per-day log. */
const MAX_DATES = 20;

type Row = {
  id: string;
  kind: string;
  amber: number | null;
  red: number | null;
  scored: number;
  unscoreable: number;
  ties: number;
  tieDates: string[];
};

async function main(): Promise<void> {
  const env = readEnv();
  const showDates = process.argv.includes("--dates");
  const store = getStore("ro", env);

  const low = ALL_INDICATORS.filter((i) => {
    if (!i.derived) return false;
    const { amber, red } = resolvedDerivedBands(i);
    return !derivedFiresHighward({ ...i.derived, amber, red });
  });
  if (low.length === 0) {
    throw new Error("no LOW-firing derived indicators in the shipped registry — the probe is vacuous");
  }

  const rows: Row[] = [];
  for (const ind of low) {
    const { amber, red } = resolvedDerivedBands(ind);
    const points = await store.getSeries(ind.id, HISTORY_LIMIT);
    const row: Row = {
      id: ind.id,
      kind: ind.derived!.kind,
      amber,
      red,
      scored: 0,
      unscoreable: 0,
      ties: 0,
      tieDates: [],
    };
    for (const p of points) {
      if (p.decision == null) {
        row.unscoreable++;
        continue;
      }
      row.scored++;
      // `amber === null` ⇒ the band never fires under EITHER operator, so no day can tie.
      if (amber !== null && p.decision === amber) {
        row.ties++;
        if (row.tieDates.length < MAX_DATES) row.tieDates.push(p.date);
      }
    }
    rows.push(row);
  }

  const K = rows.reduce((a, r) => a + r.ties, 0);
  const scored = rows.reduce((a, r) => a + r.scored, 0);
  const unscoreable = rows.reduce((a, r) => a + r.unscoreable, 0);

  console.log("LOW-branch `d < amber` → `d <= amber` — changed-day count (row 18 HARD GATE)");
  console.log(`population: ${rows.length} LOW-firing derived indicators (derived from the registry)`);
  console.log("");
  console.log("id       kind         amber        red        scored  unscoreable  ties");
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(8)} ${r.kind.padEnd(12)} ${String(r.amber).padEnd(12)} ${String(r.red).padEnd(10)} ` +
        `${String(r.scored).padStart(6)}  ${String(r.unscoreable).padStart(11)}  ${String(r.ties).padStart(4)}`,
    );
  }
  console.log("");
  // INDICATOR-days, not calendar days: this is the per-id `scored` column SUMMED over the
  // roster, so ~3.7k calendar days × 5 ids. Labelling it "days" read as a calendar span.
  console.log(`scored indicator-days      : ${scored} (sum over ${rows.length} ids)`);
  console.log(`unscoreable indicator-days : ${unscoreable} (null decision — pre-migration or degraded)`);
  console.log(`days changed (K) : ${K}`);
  console.log("transitions by tier:");
  console.log(`  GREEN -> AMBER : ${K}`);
  console.log(`  AMBER -> RED   : 0   (the RED branch's \`d <= red\` is unchanged)`);
  console.log(`  any -> GREEN   : 0   (the inclusive cut can only ever ESCALATE)`);
  if (showDates && K > 0) {
    console.log("");
    console.log(`tie dates (capped at ${MAX_DATES} per id — a chase list, NOT a per-day log):`);
    for (const r of rows.filter((x) => x.ties > 0)) {
      console.log(`  ${r.id}: ${r.tieDates.join(" ")}${r.ties > MAX_DATES ? ` … (+${r.ties - MAX_DATES})` : ""}`);
    }
  }
  if (scored === 0) {
    throw new Error(
      `every one of the ${unscoreable} rows read had a null decision — the store is unseeded for this ` +
        `population, so "days changed: 0" would be an artifact. Re-run against a seeded store.`,
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
