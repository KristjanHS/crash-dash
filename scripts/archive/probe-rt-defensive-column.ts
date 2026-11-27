/**
 * Read-only probe: do the `rt` family's two DEFENSIVE columns — `Health` and `Staples` — differentiate
 * their members at all, and if not, does that cost anything? Written 2026-07-26 to ask
 * whether the defensive column of
 * `MEMBER_WEIGHT` (`src/danger-ladder.ts`) was ever derived, on the family that weights those legs
 * 1.0 in `FAMILY_LEG_WEIGHT.rt`.
 *
 *   npm run probe:rt-defensive     # offline, reads committed fixtures, writes NOTHING
 *
 * ⚠ **THE RUNG'S PREMISE ("0.4 across every single `rt` member") IS WRONG ON BOTH COLUMNS, WHICH IS
 * WHY THE COLUMN SHAPE IS DERIVED HERE PROGRAMMATICALLY AND NEVER HAND-TYPED** (`columnTable`).
 * Measured against the live table (after `R6`'s row was filled
 * to all 9 legs): NEITHER defensive column is constant. ⚠ THE SHAPES BELOW ARE AS OF
 * 2026-08-04 — a ruling dropped R2's and R4's `Staples` cells 0.6 → 0.4,
 * so `Staples` lost two of its three 0.6 carriers and R6 became the lone high row on BOTH columns.
 * NEITHER column is constant. For the
 * per-carrier values read `columnTable`'s OUTPUT — it derives them from the live table and is the only
 * authority, so a shape drift shows up there, never here. ⚠ DO NOT RE-TYPE AN ENUMERATION HERE: a
 * hand-typed one has now been wrong TWICE (a stale `R7` 0.4 after the 2026-08-02 euro-scope cut, then a
 * stale `EURC`/`BUND` 0.4 after 2026-08-04, then a stale carrier count and rowless-member pair once
 * `FAMILY_MEMBERS.rt` grew). The two columns remain two different
 * questions even while their carriers coincide, and the probe runs them as two arms, never one claim.
 * ⚠ The pre-§3.6 reading — "`Health` IS a structural constant, so no member differentiation is
 * possible there" — is RETIRED BY THE TABLE, not by an argument. Every branch below that keys off
 * `constant` is generic and simply no longer takes the constant path on `Health`.
 *
 * THE THREE ARMS, in the order the disposition needs them:
 *
 *  1. `columnTable` — the SHAPE, derived from `MEMBER_WEIGHT` over `FAMILY_MEMBERS.rt`. It separates
 *     three distinct kinds of absence that read identically at `memberWeight` (all return 0): a
 *     member with a row but no cell for this leg, a member with NO row at all, and a member outside
 *     the family. The table says which is which, per member, so a missing-cell case cannot be misread
 *     as a rowless member.
 *
 *  2. `constantColumnIdentity` — the STRUCTURAL consequence, CONFIRMED rather than asserted. A
 *     constant column `c` over the carriers would mean the family cell (`observedWeightedMax`,
 *     `danger-engine.ts`, the `quasiMaxFold` of `MEMBER_WEIGHT × SEV_NUM` — the scale lives in `danger-member-state.ts`) collapses to `fold(c × SEV)` over those
 *     carriers — the ARGMAX MEMBER'S IDENTITY COULD NOT MATTER. Both columns are now NON-constant, so
 *     both take the can-fire branch and neither takes the throwing one; the checks stay because the
 *     branch is generic and re-arms the moment a column is flattened again:
 *       • the per-day algebraic identity `cell == fold(c · SEV(carriers))`, run at each column's modal
 *         0.4 as the CAN-FIRE twin (it fails on N days, and that N is printed — a check that cannot
 *         fail is not a check); it is THROWN on only for a column the table makes constant;
 *       • `permutationArm`, a member-identity scramble: rotate the sev vector ACROSS members and
 *         re-score the cell. Over the carriers of a constant column this is invariant BY THE ALGEBRA,
 *         so any non-zero would be a defect and throws; over BOTH live columns it moves days, since
 *         each has several weight classes (`columnTable` prints them) the rotation swaps between.
 *
 *  3. `perturbArm` — THE LOAD-BEARING NUMBER: does the `Staples` 0.6-vs-0.4 gap ever move the rt
 *     CELL's band at `SEV_CUTS`? (The rt CELL's, not the LEG's — see "WHAT ACTUALLY CONSUMES THIS"
 *     below; the band count is a discrete summary, and an UPPER BOUND on any leg-level effect.)
 *     Same shape as rung 4's leave-one-out arm (`probe-r2-r4.ts`): re-score the rt cell twice per day
 *     per leg — once with the shipped weights, once with the column perturbed — and separate "the
 *     `wsev` differs" from "the `SEV_CUTS` band differs" (0.25 / 0.75). Four arms: `Staples`
 *     flattened DOWN to 0.4, `Staples` raised UP to 0.6, `Health` flattened DOWN to 0.4 (which moves
 *     R6's top cell — since §3.6 this is a LIVE arm, no longer the no-op placebo it was written as), and
 *     `Health` given `Staples`' own 0.6 pattern. ⚠ **THERE IS NO PLACEBO ARM LEFT, AND NONE IS
 *     FAKED**: with `Health` differentiated there is no arm here that cannot move, so the
 *     vacuous-arm guard now runs with ZERO exemptions — `perturbArm` throws on any arm whose
 *     overrides change no weight, which is what keeps that guard able to fail (can-fire demo below).
 *
 *  4. `argmaxTable` / `leaveOneOutTable` — who the fold's max term actually picks on these two legs, and
 *     whose presence moves the band, per member. The field is INCOMPLETE: a strict-argmax share is
 *     still an UPPER BOUND (a seated rival can only remove wins), but under the quasi-max the
 *     leave-one-out and perturbation counts have NO known bias direction (see below).
 *
 * ⚠ **WHAT ACTUALLY CONSUMES THIS — THE rt CELL'S BAND, NOT THE LEG'S, AND PRODUCTION READS NEITHER
 * AS A BAND.** Every `scaledSevBand` call below bands `cellWsev`, i.e. the **rt cell's** `wsev`. The
 * LEG's band is `legRAG` (`danger-engine.ts`), a `scaledSevBand` over the max of ALL SEVEN families'
 * cells — and it has **ZERO production callers** (verified file-wide 2026-07-26: only
 * `scripts/probe-absence-field.ts` and the `leg-rag` / `t1dial` tests). The real prod consumer of the
 * same `observedWeightedMax` number is `computeCells`/`familyWsev` → `superGroupDangerCissDetailed`
 * → `computeField` → the dial band → ntfy, and that path is **CONTINUOUS**: the cell's `wsev` enters
 * a weighted CISS/power-mean form as a real number and NEVER passes through `SEV_CUTS`. So the figure
 * that path consumes is the **wsev-differs** one (52.43% on the Staples flatten-down arm, 2026-07-31); the band
 * count is a discrete SUMMARY of the same perturbation, printed because a threshold crossing is
 * legible, not because production crosses it.
 *
 * ⚠ **AND THE CELL-BAND COUNT IS AN UPPER BOUND ON ANY LEG-LEVEL EFFECT.** Were anyone to read
 * `legRAG`, most rt-cell moves could not reach it: on `Health`/`Staples` the `cr`/`vl`/`xa` cells are
 * `estimated` and carry vintage reaches ŵ ≈ 0.58 / 0.72 / 0.80 (`Health`) and 0.78 / 0.70 / 0.81
 * (`Staples`) (`scripts/backtest/cell_sensitivity.json`, consumed by `estimatedWsev`), so ANY ONE of
 * those families merely `elev` already puts ≥ 0.29 into the leg's max — above `SEV_CUTS.amber` =
 * 0.25. The rt-cell AMBER→GREEN moves counted below therefore OVER-count leg-band moves: the
 * estimated cells sit in the same max and hold the leg at AMBER regardless.
 *
 * ⚠ **PLACEBO / CONTROL DISCIPLINE.** No arm here is a conditional-RETURN claim — every number is a
 * deterministic re-scoring of the same fold over the same days, with no forward window and no return
 * — so a date-rotation placebo would answer a question nobody asked (`research-probes.md` §"A
 * conditional-return claim owes a PLACEBO arm", the same reading rung 4's argmax arm took). The
 * control that IS owed is the vacuous-arm control, and it is enforced WITHOUT EXEMPTION since §3.6
 * retired the one arm that was deliberately inert: `perturbArm` THROWS on any arm whose overrides
 * change no weight (the `expectVacuous` escape hatch was REMOVED with the placebo it existed for —
 * an inert arm exempted from the guard is a guard that silently stops covering it), and
 * `permutationArm` THROWS on an identity rotation.
 *
 * ⚠ **`sim:notify` IS BLIND TO EVERY NUMBER HERE** — its 15 worlds set all members of a family to the
 * family's state, which saturates the fold and cancels per-member weight differentiation exactly
 * (`danger-ladder.ts` header; `research-probes.md`). Verification is by perturbation at this layer,
 * over real confirmed states replayed through the production chains.
 *
 * ⚠ **THE FIELD IS INCOMPLETE AND THE BIAS HAS NO KNOWN DIRECTION.** Members without a committed
 * offline fixture are absent (the run's `NOT in the field` line prints which, and which of those have
 * no `MEMBER_WEIGHT` row and so could never enter the fold). Under the retired plain max, seating an
 * absentee could only RAISE the cell, which made every band-move count an upper bound. The shipped
 * `quasiMaxFold` averages its breadth bonus over every non-max term, so a seated low-weight absentee
 * can LOWER the cell as easily as raise it — the counts below are the field's, not a bound either way.
 *
 * CAN-FIRE DEMOS (working tree, 2026-07-26 unless noted, all restored by re-typing):
 *   • `STATE_SEV.AMBER = 0.8` → `assertSevMapMatchesProduction` throws "STATE_SEV drift: R1 × Semis
 *     @ AMBER …" before any share prints;
 *   • `foldPairs`'s lambda scaled to `BREADTH_LAMBDA * 1.1` → `assertFoldMatchesProduction` throws
 *     "FOLD DRIFT on Health: production's computeCells rt cell reads wsev 0.211200, this probe's
 *     cellWsev says 0.212320 …" (2026-09-26, re-demoed when the fold became the imported quasi-max);
 *   • `.slice(0, 400)` on the joined `dates` → "the 6-member rt window is only 400 days";
 *   • the Staples FLATTEN-DOWN arm's overrides emptied → "VACUOUS ARM: Staples flatten … changes no
 *     weight";
 *   • the HEALTH FLATTEN-DOWN arm's overrides emptied (2026-07-31, re-demoed after `expectVacuous`
 *     was removed — the arm the guard used to exempt) → "VACUOUS ARM: Health FLATTEN DOWN … changes
 *     no weight";
 *   • `PERM_ROTATION = 0` → "IDENTITY PERMUTATION: … a rotation by 0 leaves every member's severity
 *     where it was".
 *
 * OFFLINE by construction: the only I/O is `readFixture` over committed
 * `scripts/backtest/data/{t10y3m,dgs10,dgs2,dfii10,move}.csv`. No feed call, no network, no DB, no
 * store, no write.
 */
import { FAMILY_MEMBERS, LEG_FIELD, MEMBER_WEIGHT, type LegKey } from "../src/danger-ladder.js";
import {
  BREADTH_LAMBDA,
  SEV_CUTS,
  computeCells,
  quasiMaxFold,
  memberScaledBand,
  scaledSevBand,
  type MemberStateMap,
  type Sev,
  type Severity,
} from "../src/danger-engine.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { R7 } from "../src/registry-composite.js";
import { bullSteepenerReadingSeries } from "../src/scorers-composite.js";
import { confirmedStateLabels } from "./backtest/event-study.js";
import { readFixture } from "./backtest/drift-guard.js";
import { countBy, pct2 } from "./lib/stats.js";

/** The two legs rung 5 adjudicates — `FAMILY_LEG_WEIGHT.rt` is 1.0 on both (with `EU-Fin`), so `rt`
 *  member magnitudes here are the family's most load-bearing cells, not decoration. */
const DEFENSIVE_LEGS = ["Health", "Staples"] as const;

/** Member-identity scramble for `permutationArm`: rotate each day's severity vector by this many
 *  positions across the member list. Any non-zero value ≠ 0 mod |members| works; 1 is the simplest. */
const PERM_ROTATION = 1;

/**
 * Grid severity of a confirmed state on `SEV_NUM`'s scale — `severityOf` + `SEV_NUM`
 * (`danger-member-state.ts`) compose to RED→lit→1, AMBER→elev→0.5, else calm→0. `severityOf` is module-private there, so
 * the literals are restated here and CHECKED against production by `assertSevMapMatchesProduction`
 * (rung 4's guard, reused verbatim in spirit).
 */
const STATE_SEV: Record<string, number> = { RED: 1, AMBER: 0.5, GREEN: 0 };

/** `memberWeight` (`danger-engine.ts`) verbatim — absent member OR absent leg ⇒ 0 reach. */
const legWeight = (member: string, leg: string): number => MEMBER_WEIGHT[member]?.[leg as LegKey] ?? 0;

/** The 9 ladder sleeves, derived from the real `LEG_FIELD` export so the leg set cannot drift. */
const LEGS = LEG_FIELD.map((l) => l.sleeve);

/** A per-(member,leg) weight function: the shipped table, or a perturbed copy of it. */
type WeightFn = (member: string, leg: string) => number;

const shippedWeight: WeightFn = legWeight;

/** The shipped table with `overrides` (member → new weight) applied ON ONE LEG ONLY. */
function overrideOn(leg: string, overrides: Readonly<Record<string, number>>): WeightFn {
  return (m, l) => (l === leg && m in overrides ? overrides[m]! : legWeight(m, l));
}

const tally = (m: Map<string, number>): string =>
  [...m.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([k, c]) => `${k} ${c}`)
    .join(" · ") || "none";

// ---------- arm 1: the COLUMN SHAPE, derived from the table ----------

interface ColumnCell {
  member: string;
  /** the shipped weight, or `null` when the member has no cell for this leg (reach 0) */
  weight: number | null;
  /** true when the member has NO `MEMBER_WEIGHT` row at all — a different absence from a missing cell */
  rowless: boolean;
}

function columnOf(leg: string): ColumnCell[] {
  return FAMILY_MEMBERS.rt.map((member) => {
    const row = MEMBER_WEIGHT[member];
    return { member, weight: row?.[leg as LegKey] ?? null, rowless: row === undefined };
  });
}

/** The carriers of a column: members whose weight on this leg is > 0, i.e. the only members that can
 *  ever enter the leg's fold (`observedWeightedMax` folds `isRelevant` members only, and relevance is
 *  derived from weight > 0 — so a 0-weight member is excluded outright, never a diluting 0 term). */
const carriersOf = (leg: string): string[] => columnOf(leg).filter((c) => (c.weight ?? 0) > 0).map((c) => c.member);

function columnTable(leg: string): string {
  const col = columnOf(leg);
  const carriers = col.filter((c) => (c.weight ?? 0) > 0);
  const values = [...new Set(carriers.map((c) => c.weight!))].sort((a, b) => a - b);
  const constant = values.length === 1;
  const byValue = new Map<number, string[]>();
  for (const c of carriers) byValue.set(c.weight!, [...(byValue.get(c.weight!) ?? []), c.member]);
  return [
    `\n${leg} COLUMN — derived from MEMBER_WEIGHT over the ${FAMILY_MEMBERS.rt.length} FAMILY_MEMBERS.rt members (never hand-typed):`,
    ...col.map(
      (c) =>
        `  ${c.member.padEnd(7)} ${
          c.weight === null
            ? c.rowless
              ? "—      NO MEMBER_WEIGHT ROW AT ALL ⇒ reach 0 on all 9 legs, isRelevant excludes it everywhere"
              : "—      row present, NO cell for this leg ⇒ reach 0 here only"
            : c.weight.toFixed(1)
        }`,
    ),
    `  ⇒ carriers ${carriers.length}/${col.length}   distinct values ${values.map((v) => v.toFixed(1)).join(" / ")}   ` +
      `${constant ? "CONSTANT over its carriers — no member differentiation is possible (see the identity arm)" : "NOT constant — the column differentiates"}`,
    ...(constant ? [] : [...byValue.entries()].sort((a, b) => b[0] - a[0]).map(([v, ms]) => `     ${v.toFixed(1)}: ${ms.join(", ")}`)),
  ].join("\n");
}

// ---------- the offline rt field (rung 4's `buildRtField`, same production chains) ----------

/** rt members with a committed OFFLINE fixture. R7 is a composite (three inputs, no single fixture)
 *  and is built separately; every other `FAMILY_MEMBERS.rt` member has no committed CSV and is
 *  reported absent by `buildRtField`. */
const RT_FIXTURE: Record<string, string> = {
  R1: "scripts/backtest/data/t10y3m.csv",
  R2: "scripts/backtest/data/dgs10.csv",
  R3: "scripts/backtest/data/dgs2.csv",
  R4: "scripts/backtest/data/dfii10.csv",
  R6: "scripts/backtest/data/move.csv",
};

interface RtField {
  members: string[];
  missing: string[];
  dates: string[];
  sev: Record<string, number[]>;
}

/**
 * THE RESTATEMENT GUARD (rung 4's, reused): `memberScaledBand(m, state, [leg])` IS
 * `scaledSevBand(memberWeight(m, leg) · SEV_NUM[severityOf(state)])`, so driving it over every field
 * member × all 9 legs × all 3 states pins the re-typed `STATE_SEV` against production, and catches
 * `MEMBER_WEIGHT` and `LEG_FIELD` drifting apart.
 */
function assertSevMapMatchesProduction(members: readonly string[]): void {
  for (const m of members) {
    const row = MEMBER_WEIGHT[m];
    if (!row) throw new Error(`[probe-rt-defensive] ${m} has no MEMBER_WEIGHT row — the field would read it as zero reach`);
    const extra = Object.keys(row).filter((leg) => !LEGS.includes(leg));
    if (extra.length > 0) {
      throw new Error(
        `[probe-rt-defensive] MEMBER_WEIGHT.${m} is keyed by ${extra.join(", ")}, which LEG_FIELD does not list — ` +
          `the ladder shape and the weight table have drifted apart, so every count below is short.`,
      );
    }
    for (const leg of LEGS) {
      for (const state of ["RED", "AMBER", "GREEN"] as const) {
        const mine = scaledSevBand((legWeight(m, leg) * STATE_SEV[state]!) as Sev);
        const prod = memberScaledBand(m, state, [leg]);
        if (mine !== prod) {
          throw new Error(
            `[probe-rt-defensive] STATE_SEV drift: ${m} × ${leg} @ ${state} — this probe bands ` +
              `${(legWeight(m, leg) * STATE_SEV[state]!).toFixed(4)} as ${mine}, production's memberScaledBand ` +
              `says ${prod}. Fix STATE_SEV before reading any number below.`,
          );
        }
      }
    }
  }
}

/**
 * THE FOLD GUARD. `cellWsev` RESTATES `observedWeightedMax` (`danger-engine.ts`) — a restatement is a
 * claim, and prose equivalence is not a check. `STATE_SEV` has `assertSevMapMatchesProduction`; this
 * is the same discipline for the fold itself, and it is owed twice over because `computeCells` has
 * since grown an `estimated` arm (`estimatedWsev`, W6 Stage 6.4) that returns a DIFFERENT number for
 * a non-`measured` cell — nothing but this assert stops the rt cell drifting onto it.
 *
 * It drives the REAL `computeCells(leg, memberState)` on synthetic member states — the full 3^|field|
 * cartesian over calm/elev/lit, so no severity pattern is untested — pulls the `rt` cell's `wsev`,
 * and compares it to `cellWsev`'s answer for the same day. Absent members carry no key, exactly as
 * production reads them, so the fold runs over the same set both sides. Throws on any mismatch.
 */
function assertFoldMatchesProduction(members: readonly string[]): void {
  const LABELS = ["GREEN", "AMBER", "RED"] as const;
  const SEV_OF: Record<(typeof LABELS)[number], Severity> = { GREEN: "calm", AMBER: "elev", RED: "lit" };
  // full cartesian over the field's severity labels — 3^6 = 729 states on the shipped field
  let combos: (typeof LABELS)[number][][] = [[]];
  for (let j = 0; j < members.length; j++) combos = combos.flatMap((c) => LABELS.map((s) => [...c, s]));
  const synth: RtField = {
    members: [...members],
    missing: [],
    dates: combos.map((_, i) => `synthetic-${i}`),
    sev: Object.fromEntries(members.map((m, j) => [m, combos.map((c) => STATE_SEV[c[j]!]!)])),
  };
  for (const leg of DEFENSIVE_LEGS) {
    const legField = LEG_FIELD.find((l) => l.sleeve === leg);
    if (!legField) throw new Error(`[probe-rt-defensive] ${leg} is not a LEG_FIELD sleeve — the leg set has drifted`);
    for (let i = 0; i < combos.length; i++) {
      const memberState: MemberStateMap = Object.fromEntries(
        members.map((m, j) => [m, { sev: SEV_OF[combos[i]![j]!], obs: "lag" as const }]),
      );
      const cell = computeCells(legField, memberState).find((c) => c.family === "rt");
      if (!cell) throw new Error(`[probe-rt-defensive] computeCells returned no rt cell for ${leg}`);
      const mine = cellWsev(synth, leg, i, shippedWeight);
      if (cell.wsev === null || Math.abs(cell.wsev - mine) > 1e-12) {
        throw new Error(
          `[probe-rt-defensive] FOLD DRIFT on ${leg}: production's computeCells rt cell reads wsev ` +
            `${cell.wsev === null ? "null (the cell is no longer `measured` — the estimated arm?)" : cell.wsev.toFixed(6)}, ` +
            `this probe's cellWsev says ${mine.toFixed(6)}, on the member state ` +
            `${members.map((m, j) => `${m}=${combos[i]![j]}`).join(" ")}. cellWsev has drifted from ` +
            `observedWeightedMax — every number below is measuring the wrong fold.`,
        );
      }
    }
  }
}

function buildRtField(): RtField {
  const per = new Map<string, Map<string, string>>();
  for (const id of FAMILY_MEMBERS.rt) {
    const fixture = RT_FIXTURE[id];
    if (fixture) {
      const ind = ALL_INDICATORS.find((i) => i.id === id);
      if (!ind) throw new Error(`[probe-rt-defensive] ${id} is in FAMILY_MEMBERS.rt but not in ALL_INDICATORS`);
      per.set(id, new Map(confirmedStateLabels(ind, fixture).map((p) => [p.date, p.bucket])));
    } else if (id === "R7") {
      const readings = bullSteepenerReadingSeries(
        R7,
        readFixture("scripts/backtest/data/t10y3m.csv"),
        readFixture("scripts/backtest/data/dgs2.csv"),
        readFixture("scripts/backtest/data/dgs10.csv"),
      );
      per.set(id, new Map(readings.map((r) => [r.date, r.state])));
    }
  }
  const members = [...per.keys()];
  const missing = FAMILY_MEMBERS.rt.filter((id) => !per.has(id));
  // A column arm needs at least two CARRIERS of each defensive leg in the field, or "does any member
  // differentiate this column" is not a question the field can answer.
  for (const leg of DEFENSIVE_LEGS) {
    const seated = carriersOf(leg).filter((m) => per.has(m));
    if (seated.length < 2) {
      throw new Error(
        `[probe-rt-defensive] only ${seated.length} carrier(s) of the ${leg} column are seated in the offline field ` +
          `(${seated.join(", ") || "none"}). With fewer than two, no differentiation arm on that column can say ` +
          `anything — fix RT_FIXTURE before reading any number below.`,
      );
    }
  }
  assertSevMapMatchesProduction(members);
  assertFoldMatchesProduction(members);
  const first = per.get(members[0]!)!;
  const dates = [...first.keys()].filter((d) => members.every((m) => per.get(m)!.has(d))).sort();
  if (dates.length < 1000) {
    throw new Error(
      `[probe-rt-defensive] the ${members.length}-member rt window is only ${dates.length} days (expected ~5,800 — ` +
        `dfii10.csv from 2003-01 is the binding leg). The fixtures' date shapes have diverged; every count would be vacuous.`,
    );
  }
  const sev: Record<string, number[]> = {};
  for (const m of members) sev[m] = dates.map((d) => STATE_SEV[per.get(m)!.get(d)!] ?? 0);
  return { members, missing, dates, sev };
}

/** `observedWeightedMax`'s value over `[weight, SEV]` pairs, via production's own `quasiMaxFold` /
 *  `BREADTH_LAMBDA` (imported, never re-typed: the hand-typed plain max this replaced went stale when the
 *  breadth bonus shipped, and `assertFoldMatchesProduction` threw on every run). Unlike a plain max, the
 *  quasi-max's bonus averages over every term, so a weight-0 member is NOT inert — it would dilute
 *  `mean(rest)`. Production folds `isRelevant` members only, and `MEMBER_RELEVANCE` is derived from
 *  `MEMBER_WEIGHT > 0`, so this drops `w === 0` pairs. Every arm below folds through here. */
const foldPairs = (pairs: readonly (readonly [number, number])[]): number =>
  quasiMaxFold(pairs.filter(([w]) => w > 0).map(([w, s]) => w * s), BREADTH_LAMBDA);

/** The family cell's weighted severity on one leg, one day. Every field member is observed on every
 *  joined day, so the fully-unobserved early return cannot apply. */
const cellWsev = (f: RtField, leg: string, i: number, w: WeightFn, members: readonly string[] = f.members): number =>
  foldPairs(members.map((m) => [w(m, leg), f.sev[m]![i]!] as const));

// ---------- arm 2: the STRUCTURAL consequence of a constant column ----------

/**
 * THE ALGEBRAIC IDENTITY, CONFIRMED PER DAY RATHER THAN ASSERTED. For a column that is constant at
 * `c` over its carriers, `observedWeightedMax` reduces to the fold of `c × SEV` over those carriers;
 * the quasi-max is SYMMETRIC in its inputs (max + a bonus on the mean of the rest), so WHICH member
 * carries which severity cannot change the cell's value — member differentiation on that leg is
 * structurally impossible, not merely rare.
 *
 * Returns the number of days the identity FAILS. Zero is the claim for a constant column; the caller
 * throws on a non-zero there. For a non-constant column the same check is run at its modal value
 * purely as the CAN-FIRE twin — it must come back non-zero, or the check is not a check.
 */
function constantColumnIdentity(f: RtField, leg: string, c: number): { fails: number; carriers: string[] } {
  const carriers = carriersOf(leg).filter((m) => f.members.includes(m));
  let fails = 0;
  for (let i = 0; i < f.dates.length; i++) {
    const cell = cellWsev(f, leg, i, shippedWeight);
    const reduced = foldPairs(carriers.map((m) => [c, f.sev[m]![i]!] as const));
    if (Math.abs(cell - reduced) > 1e-12) fails++;
  }
  return { fails, carriers };
}

/**
 * THE MEMBER-IDENTITY SCRAMBLE. Rotate each day's severity vector across `scope`'s members and
 * re-score the cell: if the column is constant over `scope`, the fold is invariant BY THE ALGEBRA, so
 * a non-zero count is a defect (the caller throws). Run over a non-constant column — or over a scope
 * that includes a NON-carrier, which is a 0-vs-`c` difference and therefore itself a differentiation
 * — it moves days, which is what makes the invariance result a measurement rather than a tautology
 * about an instrument that never fires.
 */
function permutationArm(f: RtField, leg: string, scope: readonly string[]): { value: number; band: number } {
  if (scope.length < 2 || PERM_ROTATION % scope.length === 0) {
    throw new Error(
      `[probe-rt-defensive] IDENTITY PERMUTATION on ${leg} over ${scope.length} member(s): a rotation by ` +
        `${PERM_ROTATION} leaves every member's severity where it was, so the arm would report invariance ` +
        `for a reason that has nothing to do with the weights.`,
    );
  }
  let value = 0;
  let band = 0;
  for (let i = 0; i < f.dates.length; i++) {
    const real = cellWsev(f, leg, i, shippedWeight);
    const permuted = foldPairs([
      // member at position j takes the severity of the member PERM_ROTATION positions earlier
      ...scope.map((m, j) => [legWeight(m, leg), f.sev[scope[(j - PERM_ROTATION + scope.length * 2) % scope.length]!]![i]!] as const),
      // members outside the scope keep their own severity, exactly as production sees them
      ...f.members.filter((m) => !scope.includes(m)).map((m) => [legWeight(m, leg), f.sev[m]![i]!] as const),
    ]);
    if (Math.abs(real - permuted) > 1e-12) value++;
    if (scaledSevBand(real as Sev) !== scaledSevBand(permuted as Sev)) band++;
  }
  return { value, band };
}

// ---------- arm 3: the COLUMN PERTURBATION — does the gap ever move a BAND? ----------

/**
 * THE LOAD-BEARING ARM. Re-score the rt cell on one leg twice per day — shipped weights vs a
 * perturbed column — and separate the two questions rung 4 learned to keep apart: how often the
 * `wsev` differs at all, and how often that difference crosses a `SEV_CUTS` boundary so the **rt
 * CELL's** band changes.
 *
 * ⚠ THE BAND IS THE CELL'S, NOT THE LEG'S, AND PRODUCTION READS THE CONTINUOUS `wsev` — the prod
 * consumer downstream of `observedWeightedMax` is `computeCells`/`familyWsev` →
 * `superGroupDangerCissDetailed` → `computeField` → dial band, which never applies `SEV_CUTS`; the
 * leg-level band (`legRAG`) has no production caller at all. So the wsev-differs count is the figure
 * production consumes, and the band count is a discrete summary AND an upper bound on any leg-level
 * effect (the estimated `cr`/`vl`/`xa` defensive cells sit in the same leg max). See the header.
 *
 * EVERY arm THROWS if its overrides move no weight — there is no `expectVacuous` exemption any more
 * (it existed for the `Health`-flatten placebo, which §3.6's R6 `Health: 0.6` cell turned into a live
 * arm; an exempted arm is one the guard silently stops covering). So no arm can print a reassuring
 * zero that is really "the perturbation did nothing".
 */
function perturbArm(
  f: RtField,
  label: string,
  leg: string,
  overrides: Readonly<Record<string, number>>,
): string {
  const moved = Object.entries(overrides).filter(([m, v]) => legWeight(m, leg) !== v);
  if (moved.length === 0) {
    throw new Error(
      `[probe-rt-defensive] VACUOUS ARM: ${label} on ${leg} changes no weight — every override already equals the ` +
        `shipped value, so a zero band-move count below would measure nothing. (If the disposition slice has since ` +
        `flattened this column, this arm has served its purpose and should be retired, not silenced.)`,
    );
  }
  const w = overrideOn(leg, overrides);
  let valueDays = 0;
  let bandDays = 0;
  const pairs = new Map<string, number>();
  const litBy = new Map<string, number>();
  for (let i = 0; i < f.dates.length; i++) {
    const real = cellWsev(f, leg, i, shippedWeight);
    const alt = cellWsev(f, leg, i, w);
    if (Math.abs(real - alt) > 1e-12) valueDays++;
    const bReal = scaledSevBand(real as Sev);
    const bAlt = scaledSevBand(alt as Sev);
    if (bReal === bAlt) continue;
    bandDays++;
    pairs.set(`${bReal} → ${bAlt}`, (pairs.get(`${bReal} → ${bAlt}`) ?? 0) + 1);
    const lit = f.members.filter((m) => f.sev[m]![i]! > 0);
    const key = lit.length === 0 ? "none lit" : lit.join("+");
    litBy.set(key, (litBy.get(key) ?? 0) + 1);
  }
  const n = f.dates.length;
  return [
    `\n  ${label}  [${leg}]`,
    `    overrides       ${Object.entries(overrides).map(([m, v]) => `${m} ${legWeight(m, leg).toFixed(1)}→${v.toFixed(1)}`).join(" · ") || "none"}` +
      `   (${moved.length} of ${Object.keys(overrides).length} actually move)`,
    `    days the rt cell's wsev differs:        ${valueDays}/${n} = ${pct2(valueDays / n)}   ← what PRODUCTION consumes (CISS → computeField → dial band is continuous, no SEV_CUTS)`,
    `    days the rt CELL's band differs:        ${bandDays}/${n} = ${pct2(bandDays / n)}   ← a discrete summary at SEV_CUTS, and an UPPER BOUND on any LEG-level effect (legRAG has no prod caller; the estimated cr/vl/xa defensive cells sit in the same leg max)`,
    `      band moves:   ${tally(pairs)}`,
    `      lit members on those days:  ${tally(litBy)}`,
  ].join("\n");
}

// ---------- arm 4: who the fold picks, and whose presence moves the band ----------

/** Members whose weighted severity STRICTLY beats every other field member's on this leg, day `i`. */
function strictArgmax(f: RtField, leg: string, i: number): string | null {
  let best: string | null = null;
  let bestVal = 0;
  let tied = false;
  for (const m of f.members) {
    const v = legWeight(m, leg) * f.sev[m]![i]!;
    if (v <= 0) continue;
    if (v > bestVal) {
      bestVal = v;
      best = m;
      tied = false;
    } else if (v === bestVal) tied = true;
  }
  return tied ? null : best;
}

function argmaxTable(f: RtField, leg: string): string {
  const counts = new Map<string, number>();
  let anyStrict = 0;
  let anyLit = 0;
  for (let i = 0; i < f.dates.length; i++) {
    if (cellWsev(f, leg, i, shippedWeight) > 0) anyLit++;
    const m = strictArgmax(f, leg, i);
    if (!m) continue;
    anyStrict++;
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  const n = f.dates.length;
  const top = Math.max(0, ...carriersOf(leg).map((x) => legWeight(x, leg)));
  const hi = carriersOf(leg).filter((m) => f.members.includes(m) && legWeight(m, leg) === top);
  const hiDays = hi.reduce((s, m) => s + (counts.get(m) ?? 0), 0);
  // On a CONSTANT column every carrier is a top-weight carrier, so this line degenerates into the
  // previous one; say so rather than printing it as if it discriminated.
  const degenerate = new Set(carriersOf(leg).map((m) => legWeight(m, leg))).size === 1;
  return [
    `\n  STRICT weighted-severity ARGMAX on ${leg}, over all ${n} days:`,
    `    days the cell is lit at all:            ${anyLit}/${n} = ${pct2(anyLit / n)}`,
    `    days ONE member is the strict argmax:   ${anyStrict}/${n} = ${pct2(anyStrict / n)}   (the rest are TIES — the signature of a flat column)`,
    `      by member:    ${tally(counts)}`,
    `    top-weight carriers (${hi.join(", ") || "none"} @ ${top.toFixed(1)}) are the strict argmax on ` +
      `${hiDays}/${n} = ${pct2(hiDays / n)} of days` +
      (degenerate ? `   ⇒ DEGENERATE: the column is constant, so this is the line above under another name` : ``),
  ].join("\n");
}

/** Days dropping `me` from the field moves the leg's BAND — rung 4's leave-one-out, per member. Under the
 *  quasi-max a member's presence can LOWER the cell too (a low term dilutes the breadth bonus's mean), so
 *  both directions are counted and a band move is counted on either. */
function leaveOneOutTable(f: RtField, leg: string): string {
  const rows = f.members.map((me) => {
    const others = f.members.filter((m) => m !== me);
    let raise = 0;
    let lower = 0;
    let band = 0;
    for (let i = 0; i < f.dates.length; i++) {
      const withMe = cellWsev(f, leg, i, shippedWeight);
      const without = cellWsev(f, leg, i, shippedWeight, others);
      if (Math.abs(withMe - without) <= 1e-12) continue;
      if (withMe > without) raise++;
      else lower++;
      if (scaledSevBand(withMe as Sev) !== scaledSevBand(without as Sev)) band++;
    }
    return `    ${me.padEnd(4)} weight ${legWeight(me, leg).toFixed(1)}   raises wsev ${String(raise).padStart(4)} d (${pct2(raise / f.dates.length)})   lowers ${String(lower).padStart(4)} d (${pct2(lower / f.dates.length)})   moves the rt CELL's BAND ${String(band).padStart(4)} d (${pct2(band / f.dates.length)})`;
  });
  return [
    `\n  LEAVE-ONE-OUT on ${leg} — drop each member, re-score the rt CELL (the field is incomplete, bias of` +
      ` unknown sign under the quasi-max; a CELL-band move is an upper bound on a LEG-band move — see the header):`,
    ...rows,
  ].join("\n");
}

function main(): void {
  const f = buildRtField();
  console.log(
    `${"═".repeat(96)}\nrt DEFENSIVE COLUMN AUDIT (rung 5 slice 1) — Health / Staples over ${f.dates.length} days ${f.dates[0]} → ${f.dates.at(-1)}`,
  );
  console.log(`  field             ${f.members.join(", ")}   (${f.members.length} of ${FAMILY_MEMBERS.rt.length} FAMILY_MEMBERS.rt)`);
  console.log(
    `  NOT in the field  ${f.missing.join(", ") || "none"}   ← no committed offline fixture; of those, ` +
      `${f.missing.filter((m) => !MEMBER_WEIGHT[m]).join(", ") || "none"} have NO MEMBER_WEIGHT row (0 reach on all 9 legs, so they could never bind)`,
  );
  console.log(`  SEV_CUTS          amber ${SEV_CUTS.amber} · red ${SEV_CUTS.red}   ← the cuts every band below is read at`);

  // --- arm 1: the shape ---
  for (const leg of DEFENSIVE_LEGS) console.log(columnTable(leg));

  // --- arm 2: what a constant column implies, confirmed ---
  console.log(`\n${"─".repeat(96)}\nSTRUCTURAL ARM — a constant column collapses the fold to fold(c × SEV) (member identity cannot matter)`);
  for (const leg of DEFENSIVE_LEGS) {
    const col = columnOf(leg).filter((c) => (c.weight ?? 0) > 0);
    const values = [...new Set(col.map((c) => c.weight!))];
    const constant = values.length === 1;
    // For a non-constant column the identity is run at the MODAL weight purely as the can-fire twin.
    const modal = countBy(col.map((c) => c.weight!))[0]![0];
    const c = constant ? values[0]! : modal;
    const { fails, carriers } = constantColumnIdentity(f, leg, c);
    console.log(
      `\n  ${leg}: identity  cell == fold(${c.toFixed(1)} · SEV(${carriers.join(", ")}))  FAILS on ${fails}/${f.dates.length} days   ` +
        (constant
          ? `⇒ CONFIRMED — the cell IS fold(${c.toFixed(1)} × SEV), so no ${leg} weight edit can differentiate members without breaking the constant`
          : `⇒ the CAN-FIRE TWIN: the column is NOT constant (${values.map((v) => v.toFixed(1)).join("/")}), the identity breaks, and that non-zero is what proves the check above can fail`),
    );
    if (constant && fails > 0) {
      throw new Error(
        `[probe-rt-defensive] ${leg} is a constant ${c} over ${carriers.join(", ")}, yet the cell differs from ` +
          `fold(${c} · SEV) on ${fails} days. Either the column is not the constant this probe derived, or ` +
          `cellWsev has drifted from observedWeightedMax — do not read any number below until this is resolved.`,
      );
    }
    const scoped = permutationArm(f, leg, carriers.filter((m) => f.members.includes(m)));
    const whole = permutationArm(f, leg, f.members);
    console.log(
      `    permute severities ACROSS CARRIERS only:  ${scoped.value} days change the cell's wsev, ${scoped.band} change its band` +
        (constant ? `   ⇒ INVARIANT by the algebra (a non-zero here throws)` : ``),
    );
    console.log(
      `    permute across ALL ${f.members.length} field members:      ${whole.value} days change the cell's wsev, ${whole.band} change its band` +
        (constant
          ? `   ⇒ NON-ZERO because the scope adds the NON-carrier (${columnOf(leg).filter((x) => x.weight === null && !x.rowless).map((x) => x.member).join(", ") || "none"}): a missing cell IS the column's only differentiation`
          : ``),
    );
    if (constant && scoped.value > 0) {
      throw new Error(
        `[probe-rt-defensive] ${leg} is constant over its carriers, yet permuting severities among them moved the ` +
          `cell on ${scoped.value} days — the invariance claim is false, so the "no differentiation is possible" ` +
          `reading below is unsupported.`,
      );
    }
  }

  // --- arm 3: the perturbation — does the gap move a band? ---
  console.log(
    `\n${"─".repeat(96)}\nPERTURBATION ARM — re-score the rt cell with the column changed; wsev-differs vs BAND-differs, over all ${f.dates.length} days`,
  );
  const staplesHi = f.members.filter((m) => legWeight(m, "Staples") === 0.6);
  const staplesLo = f.members.filter((m) => legWeight(m, "Staples") === 0.4);
  console.log(
    perturbArm(f, "Staples FLATTEN DOWN — the 0.6 rows cut to 0.4 (the whole column at its low value)", "Staples", Object.fromEntries(staplesHi.map((m) => [m, 0.4]))),
  );
  console.log(
    perturbArm(f, "Staples RAISE UP — the 0.4 rows lifted to 0.6 (the whole column at its high value)", "Staples", Object.fromEntries(staplesLo.map((m) => [m, 0.6]))),
  );
  console.log(
    perturbArm(
      f,
      "Health FLATTEN DOWN — every row ABOVE the column's low value cut to 0.4. WAS the inert CONTROL while R6 had no Health cell; §3.6 seated one and the 2026-08-31 retune moved it to 0.5, so the disposition is a `> 0.4` TEST, never an equality on a literal weight — a hand-typed cut value here goes stale on the next retune and silently empties the arm",
      "Health",
      Object.fromEntries(f.members.filter((m) => legWeight(m, "Health") > 0.4).map((m) => [m, 0.4])),
    ),
  );
  console.log(
    perturbArm(
      f,
      `Health MIRROR — give Health Staples' own 0.6 pattern, over the ${staplesHi.length} Staples-0.6 rows (all of which now carry a Health cell); the overrides line prints how many actually move, since a row already at 0.6 on Health contributes nothing. Same leg, same code path`,
      "Health",
      Object.fromEntries(staplesHi.map((m) => [m, 0.6])),
    ),
  );

  // --- arm 4: who binds ---
  console.log(`\n${"─".repeat(96)}\nBINDING ARM — who the fold's max term picks on these two legs, and whose presence moves the band`);
  for (const leg of DEFENSIVE_LEGS) {
    console.log(argmaxTable(f, leg));
    console.log(leaveOneOutTable(f, leg));
  }
}

main();
