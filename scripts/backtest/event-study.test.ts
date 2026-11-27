/**
 * Pins the event-study harness.
 *
 * The harness (`event-study.ts`) is a committed, re-runnable replacement for W2's throwaway `.mts`,
 * and three rulings depend on the numbers it prints. This suite pins the STRUCTURE (the leg-fixture
 * completeness, the two counting primitives, the placebo rotation, the calm-arm crisis shadow) and
 * the two DISP figures Stage 3.2 reads, each with the mutation that turns it red.
 *
 * Offline + READ-ONLY: committed `scripts/backtest/data/*.csv` only. No network, no DB, no
 * `DB_TESTS=1` — runs in plain `npm run check`.
 *
 * SYNTHETIC FIXTURES. The price/FX leg fixtures (and the SPY·FEZ·EEM DISP inputs, the QQQ/QQQE
 * breadth inputs, the HY OAS / VIX / MOVE stress-label levels) are seeded synthetic series from
 * `synth-fixtures.ts` — real market data is not distributed with this repository. Every figure and verdict pinned below is therefore a REGRESSION
 * pin of the harness pipeline over those fixtures (it moves when the harness, a scorer or a fixture
 * moves), never a market finding: no assertion here says what any real leg did after any real signal.
 *
 * CAN-FAIL DEMONSTRATIONS (each mutation executed 2026-07-21, reverted after confirming one red):
 *   1. leg completeness   — delete one `LEG_FIXTURE` entry ⇒ keys ≠ LADDER, red.
 *   2. Value MEASURABLE/WEAK — restore the `Unavailable` object on `LEG_FIXTURE.Value` ⇒ its rows go
 *                            UNMEASURABLE again, red (re-pinned 2026-08-05, demo re-run then).
 *   3. bucketEpisodes      — DROP the run-edge guard (`&& buckets[i-1] !== bucket`), i.e. count every
 *                            matching day instead of each run's rising edge ⇒ the per-bucket episode
 *                            sum (6) ≠ risingEdgeFires' elevated-entry count (4), red. NB a symmetric
 *                            `i-1`→`i+1` off-by-one does NOT red this — it counts falling edges, whose
 *                            count equals the rising-edge count; the guard-drop is the real falsifier.
 *   4. rotate              — swap the modulo index for a clamp ⇒ the multiset/cyclic identity breaks, red.
 *   5. MIN_EPISODES        — set it to 15 ⇒ falls out of (21, 134), red.
 *   6. crisis shadow       — set `CRISIS_SHADOW_MONTHS = 0` ⇒ shadowed calm months are retained and
 *                            one has a non-GREEN EBP month inside its forward window, red. The check
 *                            window is a LITERAL 3 months here, NOT the constant under test — using
 *                            the constant would make the mutated (=0) case pass vacuously.
 *   7/8. pinned figures    — bump `DISP_CORR` (family-descriptor-rows.ts, 0.75) by 0.01 ⇒ the RED region shrinks, so
 *                            DISP RED nEpisodes and RED×Semis×20d excessPp both move off their pins, red.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  CONFIRM_CLOSES,
  type State,
  VELOCITY_WINDOW,
} from "../../src/domain-types.js";
import { confirmedStateSeries, rawStateSeries } from "../../src/domain-fold.js";
import { resolveCuts } from "../../src/domain-cuts.js";
import { LADDER } from "../../src/families.js";
import { EBP } from "../../src/registry-fred.js";
import { synthesizedCalib } from "../../src/synth-cuts.js";
import { loadPublishedVintage, readFixture } from "./drift-guard.js";
import {
  breadthConcentration,
  bucketEpisodes,
  creditStress,
  creditStressEbp,
  crossAssetStress,
  dispThreeLevel,
  ebpCalmTerciles,
  type EventStudyRow,
  LEG_EVIDENCE,
  LEG_FIXTURE,
  type LabelPoint,
  MIN_EPISODES,
  MOVE_CRISIS_LEVEL,
  MOVE_STRESS_LEVEL,
  moveVolStress,
  moveVolStressStrict,
  permutationP,
  PLACEBO_OFFSET_YEARS,
  rotate,
  rotationOffsets,
  runEventStudy,
  volStress,
} from "./event-study.js";
import { risingEdgeFires } from "./replay.js";

// Each study is shared across the describes below and run once, lazily; each describe warms its own in `beforeAll`.
const memo = <T>(f: () => T): (() => T) => {
  let v: T | undefined;
  return () => (v ??= f());
};
const dispSpec = memo(() => dispThreeLevel());
const dispRows = memo((): readonly EventStudyRow[] => runEventStudy(dispSpec()));
const crRows = memo(() => runEventStudy(creditStress()));
const vlRows = memo(() => runEventStudy(volStress()));
const xaRows = memo(() => runEventStudy(crossAssetStress()));
const ebpRows = memo(() => runEventStudy(creditStressEbp()));

describe("event-study harness — Stage 1.3 pins", () => {
  beforeAll(() => void dispRows());
  it("LEG_FIXTURE keys are exactly the LADDER sleeves (completeness)", () => {
    // Mirrors `coveredIdsMatchRegistry`: no missing leg, no stray key. Mutation: delete one entry.
    expect([...Object.keys(LEG_FIXTURE)].sort()).toEqual([...LADDER].sort());
  });

  it("Value is MEASURABLE on its own instrument and grades WEAK — its DISP rows score, none UNMEASURABLE", () => {
    // Repointed 2026-08-05: the leg now reads
    // `value.csv`, its OWN `XDEV.DE`-derived series, and grades WEAK because the pre-2016-11-03 segment
    // tracked a different index (the provenance finding lives at the `LEG_EVIDENCE.Value` site).
    // Mutation: restore the `Unavailable` object on `LEG_FIXTURE.Value`.
    expect(typeof LEG_FIXTURE.Value).toBe("string");
    const valueRows = dispRows().filter((r) => r.leg === "Value");
    expect(valueRows.length).toBeGreaterThan(0);
    for (const r of valueRows) {
      expect(r.verdict).not.toBe("UNMEASURABLE");
      expect(Number.isFinite(r.excessPp)).toBe(true);
    }
    // A WEAK leg can never be read literally: a PASS scored at Value's grade must carry the co-signer
    // rider, not a bare PASS. Value's own DISP cells do not PASS on the seeded fixtures, so the rider is
    // shown on the one DISP cell that does (RED × Semis @60d, a bare PASS at its EXACT grade) re-scored
    // at Value's grade. Mutation: set `LEG_EVIDENCE.Value` to EXACT ⇒ the rider disappears.
    const exactPass = dispRows().find((r) => r.bucket === "RED" && r.leg === "Semis" && r.horizon === 60);
    expect(exactPass?.verdict).toBe("PASS");
    const atValueGrade = runEventStudy({ ...dispSpec(), legs: ["Semis"], legEvidence: { Semis: LEG_EVIDENCE.Value } });
    const regraded = atValueGrade.find((r) => r.bucket === "RED" && r.horizon === 60);
    expect(regraded?.verdict).toBe("PASS (weak — needs an exact co-signer)");
  });

  it("bucketEpisodes agrees with risingEdgeFires on a GREEN/AMBER/RED series", () => {
    // Each elevated run below is a single bucket (no AMBER↔RED within a run), so the count of
    // GREEN→non-GREEN entries equals the sum of the per-bucket contiguous-run counts. Falsifier:
    // drop bucketEpisodes' run-edge guard so it counts every matching day (sum 6 ≠ 4).
    const states: State[] = ["GREEN", "RED", "RED", "GREEN", "AMBER", "AMBER", "GREEN", "RED", "GREEN", "AMBER"];
    const dates = states.map((_, i) => `2020-01-${String(i + 1).padStart(2, "0")}`);
    const perBucket = bucketEpisodes(states, "AMBER") + bucketEpisodes(states, "RED");
    expect(perBucket).toBe(risingEdgeFires(states, dates).length);
    expect(perBucket).toBe(4); // pin the concrete count so a coincidental both-wrong can't pass
  });

  it("rotate preserves the bucket multiset and rotates cyclically", () => {
    // Mutation: replace the modulo index with a clamp.
    const v = ["a", "b", "c", "d", "e"] as const;
    const n = v.length;
    const k = 2;
    const r = rotate(v, k);
    expect([...r].sort()).toEqual([...v].sort()); // multiset preserved
    for (let i = 0; i < n; i++) expect(r[i]).toBe(v[(((i - k) % n) + n) % n]); // cyclic formula
    expect(rotate(v, n)).toEqual([...v]); // full turn is identity
    expect(rotate(rotate(v, k), -k)).toEqual([...v]); // inverse
  });

  it("MIN_EPISODES sits in the pinned (21, 134) gap", () => {
    // W2 ruled 17/20/21 thin and 134/272 usable, so the boundary lives strictly between. Mutation: 15.
    expect(MIN_EPISODES).toBeGreaterThan(21);
    expect(MIN_EPISODES).toBeLessThan(134);
  });

  it("no retained calm-arm month has a non-GREEN EBP month in its forward shadow window", () => {
    // Independent oracle: rebuild the CONFIRMED EBP monthly state series through the real notify
    // chain (the same one ebpCalmTerciles scores through), then check every retained calm label is
    // shadow-clean. SHADOW_CHECK_MONTHS is a LITERAL 3 (≈60 trading days, the longest horizon), NOT
    // CRISIS_SHADOW_MONTHS — verifying with the constant would make the mutated (=0) case vacuous.
    const SHADOW_CHECK_MONTHS = 3;
    const obs = readFixture("scripts/backtest/data/ebp.csv");
    const histories = new Map([[EBP.id, obs.map((o) => o.value)]]);
    const calib = synthesizedCalib(EBP, loadPublishedVintage(), histories);
    const cuts = resolveCuts(EBP.id, calib, EBP.direction ?? "HIGH");
    const confirmed = confirmedStateSeries(rawStateSeries(EBP, obs, cuts), CONFIRM_CLOSES);
    const alignedDates = obs.slice(VELOCITY_WINDOW).map((o) => o.date);
    const idxOf = new Map(alignedDates.map((d, i) => [d, i] as const));

    const labels = ebpCalmTerciles().labels;
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      const i = idxOf.get(label.date);
      expect(i).toBeDefined();
      for (let j = i! + 1; j <= i! + SHADOW_CHECK_MONTHS && j < confirmed.length; j++) {
        expect(confirmed[j]).toBe("GREEN");
      }
    }
  });

  it("PINNED FIGURE 1 — DISP RED nEpisodes", () => {
    // Pinned on the seeded SPY·FEZ·EEM fixtures (`synth-fixtures.ts`), scored through the LIVE
    // `dispersionReadingSeries` seam. Mutation: bump DISP_CORR (0.75) by 0.01 (shrinks the RED set → figure moves).
    const red = dispRows().find((r) => r.bucket === "RED" && r.leg === "Semis" && r.horizon === 20);
    expect(red?.nEpisodes).toBe(139);
  });

  it("PINNED FIGURE 2 — DISP RED × Semis × 20d excessPp (2dp)", () => {
    // Pinned on the seeded fixtures. Correlation is a single STRICT >0.75 confirm gate and basket
    // DEPTH (<−2.5%) splits RED from AMBER. Mutation: bump DISP_CORR (0.75) by 0.01 (shrinks the RED
    // set → figure moves).
    const red = dispRows().find((r) => r.bucket === "RED" && r.leg === "Semis" && r.horizon === 20);
    expect(red?.excessPp.toFixed(2)).toBe("-1.33");
  });
});

/**
 * W2 stress-episode specs (Stage 2.1). One smoke pin per
 * new spec — nEpisodes + excessPp for a named defensive `(bucket, leg)`, filled from a real run
 * (`npm run probe:event-study -- --probe=cr|vl|xa`), never hand-derived. These pin the harness's
 * measurement of each family's stress episodes against the committed label + leg fixtures; Stage 2.2
 * adds the discriminating per-cell VERDICT pins on top. NOT vacuous: each literal is emitted by the
 * scored state chain, so widening the bucket predicate (GREEN→AMBER) or repointing a fixture moves it.
 */
describe("event-study harness — W2 stress-spec smoke pins (Stage 2.1)", () => {
  beforeAll(() => void [crRows(), vlRows(), xaRows()]);
  const cell = (rows: readonly EventStudyRow[], bucket: string, leg: string, horizon: number) =>
    rows.find((r) => r.bucket === bucket && r.leg === leg && r.horizon === horizon);

  it("creditStress AMBER × Health × 20d — nEpisodes + excessPp (F1 HY-OAS)", () => {
    // Red demo: widen creditStress's bucket predicate so GREEN days also bucket AMBER ⇒ nEpisodes
    // moves off its pin, red. Restore by re-typing the predicate. `nEpisodes` is a property of the
    // LABEL series; `excessPp` additionally reads the seeded Health fixture (`xlv.csv`).
    const c = cell(crRows(), "AMBER", "Health", 20);
    expect(c?.nEpisodes).toBe(63);
    expect(c?.excessPp.toFixed(2)).toBe("0.15");
  });

  it("volStress RED × Health × 20d — nEpisodes + excessPp (R5 VIX)", () => {
    // Mutation: repoint volStress's fixture (vix.csv → spy.csv) ⇒ both figures move, pin reds.
    const c = cell(vlRows(), "RED", "Health", 20);
    expect(c?.nEpisodes).toBe(72);
    expect(c?.excessPp.toFixed(2)).toBe("-0.88");
  });

  it("crossAssetStress RED × Semis × 20d — nEpisodes + excessPp (FXH FX-haven)", () => {
    // Mutation: repoint one FXH leg fixture ⇒ the worst-of haven-move series shifts, pin reds.
    // FXH scores through the LIVE `fxHavenReadingSeries` seam.
    const c = cell(xaRows(), "RED", "Semis", 20);
    expect(c?.nEpisodes).toBe(65);
    expect(c?.excessPp.toFixed(2)).toBe("0.49");
  });
});

/**
 * W2 credit co-signer arm (Stage 2.1b). EBP is monthly and its confirmed states barely flicker, and the
 * defensive leg fixtures only start 1998-12, so most of its episodes score against no leg data at all.
 * The arm's episode count is a LABEL property and stays below MIN_EPISODES (THIN) whatever the leg
 * fixtures hold; `excessPp` is a regression pin over the seeded Health fixture.
 */
describe("event-study harness — W2 EBP credit co-signer arm (Stage 2.1b)", () => {
  beforeAll(() => void ebpRows());
  it("creditStressEbp AMBER × Health × 20d — nEpisodes + excessPp (EBP monthly co-signer)", () => {
    // Red demo: repoint creditStressEbp's fixture (ebp.csv → another monthly series) ⇒ a different
    // series scores different states, nEpisodes and excessPp move off their pins, red.
    // Restore by re-typing the path.
    const c = ebpRows().find((r) => r.bucket === "AMBER" && r.leg === "Health" && r.horizon === 20);
    expect(c?.nEpisodes).toBe(19); // < MIN_EPISODES — deeper history, FEWER episodes than F1's 63
    expect(c?.excessPp.toFixed(2)).toBe("-0.03");
  });
});

/**
 * W2 per-cell measurability (Stage 2.2 mechanics). A cell's verdict CLASS is gated on its arm's episode
 * count before any leg return is read: below MIN_EPISODES it reads THIN whatever the leg did; at or above
 * it the cell is MEASURED and lands in PLACEBO-FAIL or a PASS — never THIN or UNMEASURABLE on a leg
 * with data at every horizon. Episode counts are properties of the LABEL series; WHICH measured class a
 * cell lands in reads the seeded leg fixtures, so it is not asserted here.
 * Red demo: in `decideVerdict` change `nEpisodes < MIN_EPISODES` to `nEpisodes < 0` ⇒ the EBP arm's
 * cells stop reading THIN, red.
 */
describe("event-study harness — W2 per-cell measurability (Stage 2.2)", () => {
  beforeAll(() => void [dispRows(), crRows(), vlRows(), xaRows(), ebpRows()]);
  const cell = (rows: readonly EventStudyRow[], bucket: string, leg: string, horizon: number) => {
    const r = rows.find((x) => x.bucket === bucket && x.leg === leg && x.horizon === horizon);
    if (!r) throw new Error(`no row for ${bucket} ${leg} ${horizon}d`);
    return r;
  };
  const MEASURED = /^(PLACEBO-FAIL|PASS)/;
  const DEFENSIVE = ["Health", "Staples", "EU-Fin"] as const;

  it("the F1 credit arm is measurable on every defensive cell; the EBP co-signer arm is THIN", () => {
    for (const leg of DEFENSIVE)
      for (const bucket of ["AMBER", "RED"] as const) {
        expect(cell(crRows(), bucket, leg, 20).nEpisodes).toBeGreaterThanOrEqual(MIN_EPISODES);
        expect(cell(ebpRows(), bucket, leg, 20).nEpisodes).toBeLessThan(MIN_EPISODES);
        for (const h of [20, 60] as const) {
          expect(cell(crRows(), bucket, leg, h).verdict).toMatch(MEASURED);
          expect(cell(ebpRows(), bucket, leg, h).verdict).toBe("THIN");
        }
      }
  });

  it("the vol, DISP and FXH arms are measurable on every defensive cell", () => {
    for (const rows of [vlRows(), dispRows(), xaRows()])
      for (const leg of DEFENSIVE)
        for (const bucket of ["AMBER", "RED"] as const) {
          expect(cell(rows, bucket, leg, 20).nEpisodes).toBeGreaterThanOrEqual(MIN_EPISODES);
          for (const h of [20, 60] as const) expect(cell(rows, bucket, leg, h).verdict).toMatch(MEASURED);
        }
  });
});

/**
 * The R6/MOVE arms, mechanics only.
 *
 *   • shipped arm (`moveVolStress`, the registry pair through `classify`): both buckets clear
 *     MIN_EPISODES, so every leg × bucket × horizon cell is MEASURED.
 *   • native-regime arm (`moveVolStressStrict`, 120/150, level leg only): rarer than the shipped arm by
 *     construction; its AMBER bucket is still measurable and its RED bucket is THIN on every leg.
 *
 * Episode counts are LABEL properties; the `Semis` AMBER @20d excess pins are regression pins over the
 * seeded leg fixture and differ between the arms because the bucket definition differs.
 *
 * CAN-FAIL DEMONSTRATION (restored by re-typing): repoint `moveVolStress`'s fixture (`move.csv` →
 * `vix.csv`) ⇒ a different series scores different states, the episode counts move off the pinned
 * episode counts and the Semis excess off its pinned value, red.
 */
describe("event-study harness — rung 2 R6/MOVE measured reach (rates weight audit)", () => {
  let shipped: readonly EventStudyRow[];
  let strict: readonly EventStudyRow[];
  beforeAll(() => {
    shipped = runEventStudy(moveVolStress());
    strict = runEventStudy(moveVolStressStrict());
  });
  const cell = (rows: readonly EventStudyRow[], bucket: string, leg: string, horizon: number) => {
    const r = rows.find((x) => x.bucket === bucket && x.leg === leg && x.horizon === horizon);
    if (!r) throw new Error(`no row for ${bucket} ${leg} ${horizon}d`);
    return r;
  };
  const MEASURED = /^(PLACEBO-FAIL|PASS)/;

  it("native-regime arm uses the MOVE-native prior cuts, not the shipped [USER] pair", () => {
    expect([MOVE_STRESS_LEVEL, MOVE_CRISIS_LEVEL]).toEqual([120, 150]);
    // Rarer than the shipped [USER] pair is the WHOLE point of the second arm — if the strict arm
    // ever fires as often as the shipped one it has no power the shipped arm lacks.
    expect(cell(strict, "AMBER", "Semis", 20).nDays).toBeLessThan(cell(shipped, "AMBER", "Semis", 20).nDays);
  });

  it("shipped arm is MEASURABLE — every leg × bucket × horizon cell scores a measured class", () => {
    expect(cell(shipped, "AMBER", "Semis", 20).nEpisodes).toBe(113);
    expect(cell(shipped, "RED", "Semis", 20).nEpisodes).toBe(49);
    // Every leg carries a fixture, so the sweep is unconditional — no leg exempted by a missing series.
    for (const bucket of ["AMBER", "RED"] as const)
      for (const h of [20, 60] as const)
        for (const leg of LADDER) expect(cell(shipped, bucket, leg, h).verdict).toMatch(MEASURED);
  });

  it("native-regime arm: AMBER measurable on every leg; RED is THIN", () => {
    expect(cell(strict, "AMBER", "Semis", 20).nEpisodes).toBe(64);
    expect(cell(strict, "AMBER", "Semis", 20).nEpisodes).toBeGreaterThanOrEqual(MIN_EPISODES);
    expect(cell(strict, "RED", "Semis", 20).nEpisodes).toBeLessThan(MIN_EPISODES);
    for (const h of [20, 60] as const)
      for (const leg of LADDER) {
        expect(cell(strict, "AMBER", leg, h).verdict).toMatch(MEASURED);
        expect(cell(strict, "RED", leg, h).verdict.startsWith("THIN")).toBe(true);
      }
  });

  it("Semis AMBER @20d — the same cell MOVES WITH THE CUT between the two arms", () => {
    expect(cell(shipped, "AMBER", "Semis", 20).excessPp.toFixed(2)).toBe("1.64");
    expect(cell(strict, "AMBER", "Semis", 20).excessPp.toFixed(2)).toBe("0.30");
  });
});

// ── G4 additions (2026-08-02): the widened placebo set + the permutation p ────────────────────
//
// CAN-FAIL DEMONSTRATIONS (each mutation executed 2026-08-02, output quoted in the commit message,
// each restored by RE-TYPING, never `git checkout --`):
//   7. rotationOffsets default — return `[k]` instead of `[k, -k]` ⇒ the default arm set drops to 3,
//      "the DEFAULT arm set is unchanged" reds with `expected 3 to be 6`.
//   8. rotationOffsets floor   — drop the `out.size !== placeboRotations` throw ⇒ the short-series
//      case silently returns 3 deduped arms and the `toThrow` red fires.
//   9. permutationP            — use `>` instead of `>=` when counting arms at least as extreme ⇒ a
//      tied arm stops counting and p drops below its own `1/(K+1)` floor, red.
describe("rotationOffsets — the arm set (G4 §E-3)", () => {
  it("the DEFAULT arm set is unchanged: ±1/±2/±3 years, 6 arms, every pre-existing spec untouched", () => {
    const daily = rotationOffsets(5000, undefined, "daily");
    expect(daily.length).toBe(PLACEBO_OFFSET_YEARS.length * 2);
    expect(daily).toEqual([250, -250, 500, -500, 750, -750]);
    expect(rotationOffsets(5000, undefined, "monthly")).toEqual([12, -12, 24, -24, 36, -36]);
  });

  it("199 rotations are 199 DISTINCT non-zero shifts — the count p's denominator is built from", () => {
    const arms = rotationOffsets(2600, 199, "daily");
    expect(arms.length).toBe(199);
    expect(new Set(arms).size).toBe(199);
    expect(arms.every((k) => k !== 0 && k > 0 && k < 2600)).toBe(true);
  });

  it("throws rather than silently deduping when the series is too short to realize the arms", () => {
    // 199 arms over a 4-observation series can only produce 3 distinct non-zero shifts; a silent
    // dedupe would compute p against arms that never ran.
    expect(() => rotationOffsets(4, 199, "daily")).toThrow(/only 3 distinct non-zero shifts/);
  });
});

/**
 * The §E-2 SEAM the whole G4 verdict rests on. `g4-mode-study.ts` scores nine legs against their OWN
 * exported `LEGP_*` closes by passing `spec.legFixture` / `spec.legEvidence`; without those overrides
 * reaching `runEventStudy`, the study would silently fall through to the committed `LEG_FIXTURE`
 * proxies — under which `LEG_EVIDENCE` grades at least one leg non-EXACT (`S&P IT` and `Value` both WEAK
 * as of 2026-08-05; read the current set off `LEG_EVIDENCE`, not off this line — grades
 * move as fixtures are repointed, and a count here rots silently) — and print a fully populated,
 * differently-scoped table with NO visible symptom. Nothing pinned that before this suite.
 *
 * CAN-FAIL DEMONSTRATIONS (executed 2026-08-02, each restored by RE-TYPING, never `git checkout --`):
 *  10. override reach  — drop `spec.legFixture?.[leg] ??` / `spec.legEvidence?.[leg] ??` in
 *      `runEventStudy` so it always reads the module tables ⇒ `Value` keeps its committed WEAK grade and
 *      `value.csv` numbers under the override, and the overridden `Semis` rows stop differing from the
 *      default ones, red. (Re-pinned 2026-08-05: `Value` used to discriminate by being UNMEASURABLE
 *      without an override; it now discriminates by GRADE and by NUMBERS, which is strictly stronger.)
 *  11. arm ORDER       — iterate the placebo offsets reversed
 *      (`for (const k of [...offsets].reverse())`) in `runEventStudy` ⇒ arm k is no longer
 *      `rotationOffsets`' k-th shift and the per-arm oracle below reds.
 */
describe("event-study — the §E-2 per-spec fixture/evidence overrides", () => {
  // Two labels, one date axis, one leg — the smallest spec that can show the override landing.
  const spec = dispThreeLevel();

  it("an override REACHES runEventStudy, and the module-level tables are never mutated", () => {
    // `Value` is the discriminating leg: its committed grade is WEAK on its own `value.csv`, so an
    // EXACT grade AND `spy.csv` numbers can only come from BOTH overrides having landed.
    const tables = { fixture: LEG_FIXTURE.Value, evidence: LEG_EVIDENCE.Value };
    expect(tables.evidence).not.toBe("EXACT");
    const committed = runEventStudy({ ...spec, legs: ["Value"] });
    const overridden = runEventStudy({
      ...spec,
      legs: ["Value"],
      legFixture: { Value: "scripts/backtest/data/spy.csv" },
      legEvidence: { Value: "EXACT" },
    });
    expect(overridden.length).toBeGreaterThan(0);
    for (const r of overridden) {
      expect(r.evidence).toBe("EXACT");
      expect(Number.isFinite(r.excessPp)).toBe(true);
    }
    expect(overridden.map((r) => r.excessPp)).not.toEqual(committed.map((r) => r.excessPp));

    // …and the override is per-SPEC. The module tables still carry their committed values, so every
    // other spec in this file (and in production probe runs) keeps its own arms.
    expect({ fixture: LEG_FIXTURE.Value, evidence: LEG_EVIDENCE.Value }).toEqual(tables);
    const after = runEventStudy({ ...spec, legs: ["Value"] });
    for (const r of after) expect(r.evidence).toBe(tables.evidence);

    // A fixture override on an ALREADY-measurable leg must move that leg's numbers too — otherwise
    // the assertions above could pass on `Value`'s special case alone while the merge silently
    // ignored the override for every other leg.
    const dflt = runEventStudy({ ...spec, legs: ["Semis"] });
    const swapped = runEventStudy({
      ...spec,
      legs: ["Semis"],
      legFixture: { Semis: "scripts/backtest/data/spy.csv" },
    });
    expect(swapped.map((r) => r.excessPp)).not.toEqual(dflt.map((r) => r.excessPp));
  });

  it("placeboExcessPp arm order IS rotationOffsets order — arm k is the same shift for every leg", () => {
    // This is what makes G4's pooled statistic JOINT rather than nine unrelated shuffles: the pooled
    // spread for arm k averages arm k across legs, which is only the same permutation everywhere if
    // index k means `rotationOffsets(...)[k]` on every row. `g4-mode-study.ts` asserts the label
    // series all have the same LENGTH — necessary, but it cannot see the ORDER, so pin it here.
    const ROTATIONS = 3;
    const labels = [...spec.labels].sort((a, b) => a.date.localeCompare(b.date));
    const buckets = labels.map((l) => l.bucket);
    const offsets = rotationOffsets(buckets.length, ROTATIONS, "daily");
    expect(offsets.length).toBe(ROTATIONS);

    const real = runEventStudy({ ...spec, legs: ["Semis"], placeboRotations: ROTATIONS });
    const row = real.find((r) => r.bucket === "RED" && r.horizon === 20);
    expect(row?.placeboExcessPp.length).toBe(ROTATIONS);

    // Independent oracle: arm k's excess must equal the REAL excess of the same study run on labels
    // pre-rotated by `offsets[k]` — computed through a separate `runEventStudy` call, so a reordering
    // inside the harness cannot make both sides move together.
    offsets.forEach((k, i) => {
      const rotated: LabelPoint[] = rotate(buckets, k).map((bucket, j) => ({ date: labels[j]!.date, bucket }));
      const armRows = runEventStudy({ ...spec, legs: ["Semis"], labels: rotated, placeboRotations: ROTATIONS });
      const armRow = armRows.find((r) => r.bucket === "RED" && r.horizon === 20);
      expect(armRow?.excessPp, `arm ${i} (shift ${k}) is out of order`).toBeCloseTo(row!.placeboExcessPp[i]!, 10);
    });
  });
});

describe("permutationP — the rank of the real arm (G4 §E-3)", () => {
  it("is floored at 1/(K+1): 6 arms can never report p ≤ 0.05, which is why G4 widened to 199", () => {
    expect(permutationP(100, [1, 1, 1, 1, 1, 1])).toBeCloseTo(1 / 7, 10);
    expect(1 / 7).toBeGreaterThan(0.05);
    expect(permutationP(100, new Array(199).fill(1))).toBeCloseTo(1 / 200, 10);
  });

  it("counts arms AT LEAST as extreme, sign-blind, and drops non-finite arms from the denominator", () => {
    expect(permutationP(2, [-3, 1, 1])).toBeCloseTo(2 / 4, 10); // |-3| ≥ 2 counts
    expect(permutationP(2, [2, 1, 1])).toBeCloseTo(2 / 4, 10); // a TIE counts
    expect(permutationP(2, [3, 1, NaN])).toBeCloseTo(2 / 3, 10); // NaN arm never ran
    expect(permutationP(NaN, [1, 2])).toBeNaN();
    expect(permutationP(1, [])).toBeNaN();
  });
});

/**
 * F5 breadth arm — the one smoke pin every spec owes, on the
 * PRE-REGISTERED cell and no other (`RED × S&P IT`); the other eight legs are deliberately NOT pinned.
 *
 * NOT VACUOUS. `nEpisodes` moves if `breadthReadingSeries`' band moves (the `BREADTH_BAND` triple, the
 * strict-prior high window, the classify direction) or the seeded QQQ/QQQE inputs move; `excessPp`
 * additionally moves if the `S&P IT` fixture override is dropped, since `LEG_FIXTURE` ships `qqq.csv`
 * there and this spec overrides it to `xlk.csv`. Red demo: delete `legFixture` from the spec ⇒ excessPp
 * moves off the pinned value below.
 */
describe("event-study harness — F5 breadth spec smoke pin (2026-08-30)", () => {
  let rows: readonly EventStudyRow[];
  beforeAll(() => {
    rows = runEventStudy(breadthConcentration());
  });
  const cell = (bucket: string, leg: string, horizon: number) =>
    rows.find((r) => r.bucket === bucket && r.leg === leg && r.horizon === horizon);

  it("RED × S&P IT — the pre-registered cell is measurable, pinned on the seeded fixtures", () => {
    const c20 = cell("RED", "S&P IT", 20);
    const c60 = cell("RED", "S&P IT", 60);
    expect(c20?.nEpisodes).toBe(89);
    expect(c20!.nEpisodes).toBeGreaterThan(MIN_EPISODES);
    expect(c20?.excessPp.toFixed(2)).toBe("0.58");
    expect(c60?.excessPp.toFixed(2)).toBe("-0.73");
    expect(c20?.verdict).toMatch(/^(PLACEBO-FAIL|PASS)/);
  });

  it("the S&P IT leg is scored on the XLK override, EXACT — not on its LEG_FIXTURE default", () => {
    // The paired override is what keeps the study off its own label numerator; if it silently
    // stopped applying, the leg would fall back to WEAK and every S&P IT row would be annotated.
    expect(LEG_EVIDENCE["S&P IT"]).not.toBe("EXACT");
    expect(cell("RED", "S&P IT", 20)?.evidence).toBe("EXACT");
  });
});
