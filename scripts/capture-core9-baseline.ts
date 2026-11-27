/**
 * CORE-9 Stage B — the MODULE-EVAL CENSUS, with its non-vacuity control arm inside it.
 *
 *     npm run probe:core9              # capture → scripts/capture-core9-baseline.snapshot.json
 *     npm run probe:core9 -- --control # sensitivity check; exits 1 if the arms are EQUAL
 *
 * WHY. CORE-9 moves `confirmClosesFor`'s closure out of `families.ts` into a leaf module. Every
 * symbol below is produced at MODULE EVAL from the family/ladder tables, so a relocation that
 * changes evaluation order can silently change a table without changing a single expression. A
 * green suite does not cover that (`claim-verification.md` §30: an unchanged suite only covers
 * symbols that moved verbatim), so this census is the instrument the extraction is measured against:
 * capture at HEAD, capture again after the move, demand byte-identity.
 *
 * NO DB, NO NETWORK, NO ENV. It imports the tables and serializes them; that is the whole probe.
 *
 * LOAD-BEARING ROWS (§0.5). `perFamilyMemberCount` and the sorted `memberRelevanceReachSet` are the
 * two quantities `danger-engine.ts`'s import-order note claims can shift, so they are DERIVED here
 * (never hand-typed) and are the rows Stage C reads.
 *
 * DETERMINISM. `stable()` sorts every OBJECT key and expands every `Set` to a sorted array, so
 * nothing in the output depends on runtime insertion order. ARRAY order is preserved deliberately —
 * `LADDER`, `SIGNALS`, `LEG_FIELD` and every family's `ids` are ORDERED contracts (E6(a) impact
 * order), so a reorder MUST show up as a census move rather than being sorted away.
 *
 * THE CONTROL ARM (`claim-verification.md` §28). `--control` re-runs the census over a deep copy of
 * `MEMBER_WEIGHT` with ONE documented cell perturbed (`PERTURBATION` below) and fails when the two
 * arms come out equal: a harness that cannot produce a difference has not shown invariance, it has
 * shown it is insensitive. Shape copied from `scripts/capture-d4-freshness.ts`. Production objects
 * are never mutated — the perturbation is applied to a copy, and `--control` refuses to write the
 * snapshot.
 *
 * ⚠ The perturbation touches `MEMBER_WEIGHT`, but **no weight change ships from this file**: the
 * perturbed table is a local deep copy that exists for the length of one `--control` run and is
 * NEVER COMMITTED. Read the diff of this script as instrumentation, not as an uninstrumented weight
 * edit.
 *
 * The reach derivation below is a REIMPLEMENTATION of `MEMBER_RELEVANCE`'s rule — and the
 * exported `controlArmFaithful()` guard pins it against the production symbol, so it cannot drift
 * into measuring something else. That guard runs in BOTH arms of `main()` AND is asserted from
 * `capture-core9-baseline.test.ts` — without the test-side assertion the census's
 * `dangerLadder.MEMBER_RELEVANCE` row (computed from `deriveReach`, not from the production symbol)
 * could stay byte-identical while production `MEMBER_RELEVANCE` changed rule, and the permanent pin
 * would silently miss it.
 */
import { writeFileSync } from "node:fs";
import {
  GLOBAL_FAMILIES,
  US_FAMILIES,
  DASHBOARD_FAMILIES,
  CONFIRM_TIERS,
  SIGNAL_OF,
  FAMILY_OF_SIGNAL,
  LADDER,
  DIAL_REGIME_CUTS,
  NOTIFY_REGIME_CUTS,
  confirmClosesFor,
} from "../src/families.js";
import {
  DIAL_FAMILIES,
  FAMILY_MEMBERS,
  MEMBER_WEIGHT,
  FAMILY_LEG_WEIGHT,
  MEMBER_RELEVANCE,
  MEMBER_LABEL,
  SIGNALS,
  SUPER_GROUP_OF,
  LEG_FIELD,
  type LegKey,
} from "../src/danger-ladder.js";
import {
  DANGER_CUTS,
  CONC_THRESHOLD,
  RERISK_DEADBAND,
} from "../src/danger-engine.js";
import { TREND_GATE_FLOOR } from "../src/danger-share.js";
import { ALL_INDICATORS } from "../src/registry.js";
export const serialize = (v: unknown): string => JSON.stringify(v, null, 2) + "\n";

/** Recursively sort object keys and expand Sets; ARRAY order is preserved deliberately (an ordered
 *  contract must surface a reorder as a move). */
function stable(value: unknown): unknown {
  if (value instanceof Set) return [...value].map(String).sort();
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

export const SNAPSHOT_PATH = "scripts/capture-core9-baseline.snapshot.json";

/** The ONE documented control perturbation: `G1` (oil shock) carries no `Health` weight today, so
 *  seating one moves that member's REACH — the load-bearing row — not merely a magnitude. Chosen
 *  over nudging an existing weight precisely because reach is what the census must be able to see. */
const PERTURBATION = { member: "G1", leg: "Health" as LegKey, weight: 0.6 } as const;

type WeightTable = Record<string, Readonly<Partial<Record<LegKey, number>>>>;

/** All 9 leg sleeves in ladder order — the axis `MEMBER_RELEVANCE` is derived over. */
const ALL_LEGS: readonly string[] = LEG_FIELD.map((l) => l.sleeve);

/** `MEMBER_RELEVANCE`'s rule, reimplemented in-probe: a leg is relevant iff its weight > 0.
 *  Legs are SORTED, not left in ladder order — production stores a `ReadonlySet`, which `stable()`
 *  expands sorted, so the two representations must agree for `controlArmFaithful` to compare them.
 *  Reach is set-valued; order carries no meaning here (unlike `LADDER`/`ids`, see DETERMINISM). */
function deriveReach(weights: WeightTable): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(weights).map(([id, row]) => [
      id,
      ALL_LEGS.filter((leg) => (row[leg as LegKey] ?? 0) > 0).sort(),
    ]),
  );
}

/** Sorted `id|leg` pairs — the full reach set as one flat, order-free list. */
function reachSet(reach: Record<string, string[]>): string[] {
  return Object.entries(reach)
    .flatMap(([id, legs]) => legs.map((leg) => `${id}|${leg}`))
    .sort();
}

/** Deep-copy `MEMBER_WEIGHT` and seat the one perturbed cell. Production is never mutated. */
function perturbed(): WeightTable {
  const copy: WeightTable = Object.fromEntries(
    Object.entries(MEMBER_WEIGHT).map(([id, row]) => [id, { ...row }]),
  );
  copy[PERTURBATION.member] = {
    ...(copy[PERTURBATION.member] ?? {}),
    [PERTURBATION.leg]: PERTURBATION.weight,
  };
  return copy;
}

const countMembers = (entries: readonly { key: string; ids: readonly string[] }[]) =>
  Object.fromEntries(entries.map((f) => [f.key, f.ids.length]));

/**
 * The census. `weights === MEMBER_WEIGHT` is the BASELINE arm; any other table is a control arm.
 * Key order below is FIXED by construction (object literal order survives `JSON.stringify`; only
 * the nested values are key-sorted by `stable`).
 */
export function buildCensus(weights: WeightTable = MEMBER_WEIGHT): Record<string, unknown> {
  const reach = deriveReach(weights);
  return {
    probe: "CORE-9 Stage B module-eval census",
    families: {
      GLOBAL_FAMILIES: stable(GLOBAL_FAMILIES),
      US_FAMILIES: stable(US_FAMILIES),
      DASHBOARD_FAMILIES: stable(DASHBOARD_FAMILIES),
      CONFIRM_TIERS: stable(CONFIRM_TIERS),
      SIGNAL_OF: stable(SIGNAL_OF),
      FAMILY_OF_SIGNAL: stable(FAMILY_OF_SIGNAL),
      LADDER: stable(LADDER),
      DIAL_REGIME_CUTS: stable(DIAL_REGIME_CUTS),
      NOTIFY_REGIME_CUTS: stable(NOTIFY_REGIME_CUTS),
    },
    dangerLadder: {
      DIAL_FAMILIES: stable(DIAL_FAMILIES),
      FAMILY_MEMBERS: stable(FAMILY_MEMBERS),
      MEMBER_WEIGHT: stable(weights),
      FAMILY_LEG_WEIGHT: stable(FAMILY_LEG_WEIGHT),
      MEMBER_RELEVANCE: stable(reach),
      MEMBER_LABEL: stable(MEMBER_LABEL),
      SIGNALS: stable(SIGNALS),
      SUPER_GROUP_OF: stable(SUPER_GROUP_OF),
      LEG_FIELD: stable(LEG_FIELD),
    },
    dangerEngine: {
      DANGER_CUTS: stable(DANGER_CUTS),
      CONC_THRESHOLD,
      RERISK_DEADBAND,
      TREND_GATE_FLOOR,
    },
    /** `confirmClosesFor` over EVERY `ALL_INDICATORS` id — the function that sits on the cut edge. */
    confirmClosesFor: Object.fromEntries(
      [...ALL_INDICATORS.map((i) => i.id)].sort().map((id) => [id, confirmClosesFor(id)]),
    ),
    /** DERIVED load-bearing row 1 — per-family member count, on both the dial and display axes. */
    perFamilyMemberCount: {
      dial: stable(
        Object.fromEntries(Object.entries(FAMILY_MEMBERS).map(([sig, ids]) => [sig, ids.length])),
      ),
      global: stable(countMembers(GLOBAL_FAMILIES)),
      dashboard: stable(countMembers(DASHBOARD_FAMILIES)),
    },
    /** DERIVED load-bearing row 2 — the full sorted `MEMBER_RELEVANCE` reach set. */
    memberRelevanceReachSet: reachSet(reach),
  };
}

/**
 * The control arm's reimplemented reach derivation must reproduce production `MEMBER_RELEVANCE`
 * EXACTLY on the unperturbed table — otherwise the arms could differ because the derivation drifted
 * rather than because the perturbation bit, and the whole sensitivity check would be measuring the
 * probe instead of the tables.
 */
export function controlArmFaithful(): string | null {
  const derivedJson = JSON.stringify(stable(deriveReach(MEMBER_WEIGHT)));
  const productionJson = JSON.stringify(stable(MEMBER_RELEVANCE));
  return derivedJson === productionJson
    ? null
    : "the in-probe reach derivation NO LONGER reproduces production `MEMBER_RELEVANCE` — the " +
        "control arm would be measuring the probe, not the tables";
}

function main(argv: readonly string[]): number {
  const control = argv.includes("--control");
  const failures: string[] = [];

  const faithful = controlArmFaithful();
  if (faithful !== null) failures.push(faithful);

  const baseline = serialize(buildCensus());

  if (!control) {
    writeFileSync(SNAPSHOT_PATH, baseline);
    console.log("=== CORE-9 Stage B — module-eval census (BASELINE) ===");
    console.log(`wrote snapshot → ${SNAPSHOT_PATH}  (${baseline.length} bytes)`);
    const census = buildCensus();
    const counts = census.perFamilyMemberCount as { dial: Record<string, number> };
    console.log(`per-family member count (dial): ${JSON.stringify(counts.dial)}`);
    console.log(`MEMBER_RELEVANCE reach set: ${(census.memberRelevanceReachSet as string[]).length} pairs`);
    console.log(
      `confirmClosesFor over ${Object.keys(census.confirmClosesFor as object).length} ALL_INDICATORS ids`,
    );
    if (failures.length > 0) {
      console.log("VERDICT: FAIL");
      for (const f of failures) console.log(`  - ${f}`);
      return 1;
    }
    console.log("VERDICT: PASS — baseline captured.");
    return 0;
  }

  // --- control arm: the census MUST move under the documented perturbation --------------------
  const controlCensus = serialize(buildCensus(perturbed()));
  console.log("=== CORE-9 Stage B — module-eval census (CONTROL arm, §28 non-vacuity) ===");
  console.log(
    `perturbation: MEMBER_WEIGHT["${PERTURBATION.member}"]["${PERTURBATION.leg}"] = ` +
      `${PERTURBATION.weight} (was ${MEMBER_WEIGHT[PERTURBATION.member]?.[PERTURBATION.leg] ?? "absent"})`,
  );
  console.log("⚠ applied to a LOCAL DEEP COPY — never committed, never written to the snapshot.");

  const baseReach = new Set(reachSet(deriveReach(MEMBER_WEIGHT)));
  const ctrlReach = reachSet(deriveReach(perturbed()));
  const gained = ctrlReach.filter((p) => !baseReach.has(p));
  console.log(`reach pairs: baseline ${baseReach.size} → control ${ctrlReach.length}`);
  console.log(`reach GAINED by the perturbation: ${gained.join(", ") || "(none)"}`);

  // TWO conditions, deliberately. Byte-difference ALONE is too weak a pass criterion: the census
  // serialises `MEMBER_WEIGHT` itself, so ANY weight edit (e.g. 0.5 → 0.51) separates the arms
  // whether or not the load-bearing DERIVED rows move — the arm would then certify sensitivity it
  // never demonstrated. Demand that the perturbation also moves the REACH set, which is the row
  // Stage C reads and the quantity the import-order claim is about (§28: pin the guard to the
  // discriminating column, not the total).
  if (gained.length === 0) {
    failures.push(
      "the perturbation is REACH-NEUTRAL — it gained no `id|leg` pair, so the census's derived " +
        "load-bearing row never moved and a byte-difference here only reflects MEMBER_WEIGHT " +
        "being serialized verbatim. Choose a perturbation that seats a weight on an absent leg.",
    );
  }
  if (controlCensus === baseline) {
    failures.push(
      "the CONTROL capture is BYTE-IDENTICAL to the baseline — this census cannot see a " +
        "MEMBER_WEIGHT reach change, so any byte-identical result it reports proves NOTHING (§28)",
    );
  } else {
    const b = baseline.split("\n");
    const c = controlCensus.split("\n");
    let moved = 0;
    for (let i = 0; i < Math.max(b.length, c.length); i += 1) if (b[i] !== c[i]) moved += 1;
    console.log(`census DIFFERS on ${moved} line(s) — the harness is sensitive.`);
  }

  if (failures.length > 0) {
    console.log("VERDICT: FAIL");
    for (const f of failures) console.log(`  - ${f}`);
    return 1;
  }
  console.log("VERDICT: PASS — the arms differ, so a baseline-vs-post-move byte-identity means something.");
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
