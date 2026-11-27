import { describe, expect, test } from "vitest";

import { InMemoryStore } from "./store-memory.js";
import { ALL_INDICATORS } from "./registry.js";
import { COMPOSITE_COMPONENTS } from "./registry-composite.js";
import { lagCutFor } from "./ladder.js";
import type { PillarScore } from "./danger-engine.js";
import { CADENCE_OF, EXPLICIT_OF, LAG_CUT_OF, isExplicitlyRegistered } from "./feed-lag.js";
import { LEG_FIELD } from "./danger-ladder.js";
import { ECDF_READ_SLACK, ECDF_READ_SPAN, ECDF_WINDOW, LEG_PILLAR_GENERATOR } from "./leg-percentile.js";
import { ewPctCell } from "./lab-served-field.js";

type StoreMethod = "getLegPillarSeries" | "getLegPillarLatestGenerator";

function recordCalls(s: InMemoryStore, method: StoreMethod): unknown[][] {
  const calls: unknown[][] = [];
  const real = (s[method] as (...a: unknown[]) => Promise<unknown>).bind(s);
  (s as unknown as Record<StoreMethod, (...a: unknown[]) => Promise<unknown>>)[method] = (...a) => {
    calls.push(a);
    return real(...a);
  };
  return calls;
}

function failWith(s: InMemoryStore, method: StoreMethod, message: string): void {
  (s as unknown as Record<StoreMethod, () => Promise<never>>)[method] = async () => {
    throw new Error(message);
  };
}

// §I7.2 — the freshness stamp scores each id's age against CADENCE_OF, and the composite COMPONENT
// ids (`CMP_FXH_*`) live in `COMPOSITE_COMPONENTS`, which is NOT spread into `ALL_INDICATORS` — a
// registry-only table would drop them onto its `?? "daily"` fallthrough. They resolve `daily` and,
// since the `lagAfterDays: 5` override retired slice-3, the bare daily tier — EQUAL to the
// fallthrough, so no VALUE can discriminate covered from defaulted; only MEMBERSHIP can.
// ⚠ The roster is therefore taken from the REGISTRY (`COMPOSITE_COMPONENTS`), never from
// `CADENCE_OF.keys()`: both freshness tables project from the SAME walk
// (`freshnessScoredIndicators`, feed-lag.ts), so a roster derived from one of them makes
// `has()` on either true by construction — a membership check that can never fail.
describe("CADENCE_OF covers the composite components (§I7.2)", () => {
  const FXH_COMPONENTS = (COMPOSITE_COMPONENTS.FXH ?? []).map((c) => c.id);

  test("the population this pin must admit is non-empty", () => {
    // Without this the filter above could quietly go empty and `every` would pass vacuously.
    expect(FXH_COMPONENTS.length).toBeGreaterThan(0);
  });

  test("every CMP_FXH_* id is covered (resolves daily; membership is the discriminator)", () => {
    expect(FXH_COMPONENTS.length).toBeGreaterThan(0);
    // The `lagAfterDays: 5` value-discriminator retired slice-3; covered now equals the tier default,
    // so coverage is that each registry component id is a KEY in both freshness tables (a component
    // dropped from the walk is ABSENT, not defaulted). Falsifiable because the roster is registry-
    // sourced: drop `CMP_FXH_*` from `freshnessScoredIndicators` and both `has()` calls go red.
    for (const id of FXH_COMPONENTS) expect(CADENCE_OF.has(id)).toBe(true);
    for (const id of FXH_COMPONENTS) expect(LAG_CUT_OF.has(id)).toBe(true);
    expect(FXH_COMPONENTS.map((id) => CADENCE_OF.get(id))).toEqual(FXH_COMPONENTS.map(() => "daily"));
  });

  // E7 Stage 3.2 — the board's cut table must agree with the notify path's resolver for EVERY id it
  // covers, or /lab paints a leg stale that `verdictHoldLegs` calls fresh. Expected is rebuilt here from
  // the registry itself (served indicators + composite components) through `lagCutFor`, so a
  // dropped or mis-resolved id in `LAG_CUT_OF` reds this line rather than being mirrored by hand.
  test("LAG_CUT_OF resolves the same cut as lagCutFor for every registry id", () => {
    const expected = new Map<string, number>();
    for (const i of ALL_INDICATORS) expected.set(i.id, lagCutFor(i));
    for (const comps of Object.values(COMPOSITE_COMPONENTS))
      for (const c of comps) expected.set(c.id, lagCutFor(c.indicator));
    expect(expected.size).toBe(CADENCE_OF.size); // vacuity guard: same population as the cadence table
    expect(LAG_CUT_OF).toEqual(expected);
  });

  // NOT ASSERTED — "…and none of these ids is in ALL_INDICATORS" would be green by construction:
  // `FAMILY_OF` (family-descriptor-rows.ts) throws for any ALL_INDICATORS id it has no census entry for,
  // so the state that assertion forbids cannot be reached (measured 2026-07-26 by attempting the
  // mutation: the module fails to load rather than the assertion going red). The two pins above
  // both red-demoed, and they are what the table owes.
});


// E7 §Stage 4 fork — the REGISTRY half of the ruling. `EXPLICIT_OF` decides which arm every id is
// classified under: an explicitly registered id rots against `max(p90Gap, LAG_THRESHOLDS[registered])`
// — the cadence TIER, re-based off the resolved cut at §Stage 4.7-R2 — and is withheld from
// the correction list, an unregistered one keeps the strict p90 form. Before this block the whole
// half was uncovered — emptying `explicitRegistrationIndex()` (restoring the exact false-RED the fork
// removed) or making `isExplicitlyRegistered` universally true both left the full suite green.
// Modelled on `LAG_CUT_OF` above: the id-for-id walk alone cannot see a universally-true predicate
// (both sides move together), so the discriminating literals are what catch that mutation.
describe("EXPLICIT_OF - which arm of the §Stage 4 fork each id is classified under", () => {
  test("EXPLICIT_OF flags the same ids as isExplicitlyRegistered over the same registry walk", () => {
    const expected = new Map<string, boolean>();
    for (const i of ALL_INDICATORS) expected.set(i.id, isExplicitlyRegistered(i));
    for (const comps of Object.values(COMPOSITE_COMPONENTS))
      for (const c of comps) expected.set(c.id, isExplicitlyRegistered(c.indicator));
    expect(expected.size).toBe(CADENCE_OF.size); // vacuity guard: same population as the cadence table
    expect(EXPLICIT_OF).toEqual(expected);
  });

  // The DISCRIMINATING pair: both arms are populated, so an index that answered a constant would red
  // here whichever constant it picked.
  test("a registered id reads true and an unregistered one reads false", () => {
    expect(new Set(EXPLICIT_OF.values())).toEqual(new Set([true, false]));
  });
});


// W4 Stage 4.3 falsifier 4 — "uncomparable ⇒ never a `pct` arm", pinned at the UNIT seam: with every
// `/lab` handler fixture each of the 9 legs comes back `subDangers.earlyWarn.kind === "scored"`, so
// the `na` branch is UNREACHABLE from `GET`.
//
// The store carries a FULL `ECDF_WINDOW` history for the sleeve under test — that is the whole
// point: `na` must be decided BEFORE the read, not by a read that happened to come back empty. The
// recorder counts calls, so "issues no read" is asserted rather than assumed, and the scored twin below
// proves the counter CAN register.
describe("ewPctCell - the uncomparable short-circuit", () => {
  const SLEEVE = LEG_FIELD[0]!.sleeve;

  async function countingStore(): Promise<{ store: InMemoryStore; calls: unknown[][] }> {
    const s = new InMemoryStore();
    const day = (i: number) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    await s.putLegPillars(
      Array.from({ length: ECDF_WINDOW }, (_, i) => ({
        obsDate: day(i),
        sleeve: SLEEVE,
        superGroup: "EARLY-WARN",
        value: i / ECDF_WINDOW, // 0 … just under 1, ascending
        estimated: false,
        basis: "F1,F2",
        generator: LEG_PILLAR_GENERATOR,
      })),
    );
    return { store: s, calls: recordCalls(s, "getLegPillarSeries") };
  }

  // NON-VACUITY CONTROL for the two cases below: on the SAME store a scored pillar issues exactly
  // one read, with the vintage + window filter the design specifies, and prices.
  test("a scored pillar issues exactly ONE filtered read and prices it", async () => {
    const { store: s, calls } = await countingStore();
    const cell = await ewPctCell(s, SLEEVE, { kind: "scored", value: 0.5 });
    // The read asks for the SPAN (window + null slack, review I3), not the bare window.
    expect(calls).toEqual([[SLEEVE, "EARLY-WARN", LEG_PILLAR_GENERATOR, ECDF_READ_SPAN]]);
    // Out-of-band literal, NOT re-derived from `rollingEcdfRank`: the seeded window is i/500 for
    // i∈[0,500), and `i/500 <= 0.5` holds for i∈[0,250] ⇒ 251/500.
    expect(cell).toEqual({ kind: "pct", value: 251 / ECDF_WINDOW });
  });

  // REVIEW 2026-07-25 (I3) — the null-drop-after-limit bug. The window is 500 CLOSES, not "500 rows
  // minus holes": a `null` stored value is an uncomparable DAY and is dropped, so reading exactly
  // `ECDF_WINDOW` ROWS meant ONE hole ⇒ 499 samples ⇒ `warmup`, with hundreds of closes in the
  // table. This fixture is the discriminating one: 505 rows whose newest FIVE are null, so the
  // newest 500 ROWS carry only 495 closes while 500 closes exist just past them.
  // Red demo: narrow the read back to `ECDF_WINDOW` in `ewPctCell` ⇒ this reds with warmup.
  test("nulls inside the newest ECDF_WINDOW rows do NOT strand the leg at warmup", async () => {
    const s = new InMemoryStore();
    const day = (i: number) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    const NULLS = 5;
    await s.putLegPillars(
      Array.from({ length: ECDF_WINDOW + NULLS }, (_, i) => ({
        obsDate: day(i),
        sleeve: SLEEVE,
        superGroup: "EARLY-WARN",
        // The NEWEST `NULLS` rows carry no number; the older ECDF_WINDOW are the ascending closes.
        value: i < ECDF_WINDOW ? i / ECDF_WINDOW : null,
        estimated: false,
        basis: "F1,F2",
        generator: LEG_PILLAR_GENERATOR,
      })),
    );
    // Same seeded ladder and same probe as the control above ⇒ the SAME out-of-band 251/500. That
    // the holes cost nothing is the claim: a rank of 251/500 is only reachable over all 500 closes.
    expect(await ewPctCell(s, SLEEVE, { kind: "scored", value: 0.5 })).toEqual({
      kind: "pct",
      value: 251 / ECDF_WINDOW,
    });
  });

  // The slack is FINITE and the fallback is honest: more holes than `ECDF_READ_SLACK` inside the
  // span leaves fewer than ECDF_WINDOW closes, and the answer is `warmup` — never a rank over a
  // short sample. Without this the fix above would read as "nulls never matter".
  test("more nulls than ECDF_READ_SLACK ⇒ warmup, never a short-sample rank", async () => {
    const s = new InMemoryStore();
    const day = (i: number) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    const NULLS = ECDF_READ_SLACK + 1;
    await s.putLegPillars(
      Array.from({ length: ECDF_WINDOW + NULLS }, (_, i) => ({
        obsDate: day(i),
        sleeve: SLEEVE,
        superGroup: "EARLY-WARN",
        value: i < ECDF_WINDOW - 1 ? i / ECDF_WINDOW : null,
        estimated: false,
        basis: "F1,F2",
        generator: LEG_PILLAR_GENERATOR,
      })),
    );
    expect(await ewPctCell(s, SLEEVE, { kind: "scored", value: 0.5 })).toEqual({ kind: "warmup" });
  });

  test.each<PillarScore>([
    { kind: "uncomparable", reason: "not-live" },
  ])("an uncomparable ($reason) pillar ⇒ {kind:'na'} and ZERO store reads", async (ew) => {
    const { store: s, calls } = await countingStore();
    const cell = await ewPctCell(s, SLEEVE, ew);
    expect(cell).toEqual({ kind: "na" });
    // The read-budget half of the contract: a rank over an absent value is meaningless, so the
    // round trip is never paid.
    expect(calls).toEqual([]);
  });
});


// W4 Stage 4.4 falsifier 2 — "a stale number is never served". Unit seam: `/lab` handler fixtures
// seed NO `leg_pillars` rows, so `GET` never reaches the stale-basis branch.
describe("ewPctCell - stale-basis (Stage 4.4)", () => {
  const SLEEVE = LEG_FIELD[0]!.sleeve;
  const day = (i: number) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);

  /** A FULL, rankable window stored under `generator` — enough rows that `warmup` could only be the
   *  answer because of the VINTAGE, never because of the sample size. */
  async function seed(generator: string): Promise<InMemoryStore> {
    const s = new InMemoryStore();
    await s.putLegPillars(
      Array.from({ length: ECDF_WINDOW }, (_, i) => ({
        obsDate: day(i),
        sleeve: SLEEVE,
        superGroup: "EARLY-WARN",
        value: i / ECDF_WINDOW,
        estimated: false,
        basis: "F1,F2",
        generator,
      })),
    );
    return s;
  }

  // NON-VACUITY CONTROL. The identical fixture under the LIVE generator prices — so the stale case
  // below fails on the vintage and nothing else (a fixture that merely failed to seed would give
  // `warmup` here too and make the stale assertion meaningless).
  test("the same 500-close window under the LIVE generator prices normally", async () => {
    const s = await seed(LEG_PILLAR_GENERATOR);
    expect(await ewPctCell(s, SLEEVE, { kind: "scored", value: 0.5 })).toEqual({
      kind: "pct",
      value: 251 / ECDF_WINDOW,
    });
  });

  // Red demo: delete the `stored !== LEG_PILLAR_GENERATOR` branch in `ewPctCell` ⇒ this reds with
  // `{kind:"warmup"}`.
  test("a full window under an OLD generator ⇒ {kind:'stale-basis'}, naming both vintages - never a pct", async () => {
    const s = await seed("old");
    const cell = await ewPctCell(s, SLEEVE, { kind: "scored", value: 0.5 });
    expect(cell).toEqual({ kind: "stale-basis", stored: "old", live: LEG_PILLAR_GENERATOR });
    // The load-bearing half stated separately, so a future arm rename cannot quietly reintroduce a
    // number: whatever this cell is, it carries no rank.
    expect(cell.kind).not.toBe("pct");
    expect(cell).not.toHaveProperty("value");
  });

  // The other side of the ambiguity the probe exists to resolve: nothing stored at all is a real
  // warm-up, not a stale basis. Without this, "always return stale-basis on an empty read" passes.
  test("an EMPTY table ⇒ warmup, not stale-basis", async () => {
    const s = new InMemoryStore();
    expect(await ewPctCell(s, SLEEVE, { kind: "scored", value: 0.5 })).toEqual({ kind: "warmup" });
  });

  // Read budget: the probe is the EMPTY-branch cost only. On the happy path the extra round trip is
  // never paid — asserted rather than claimed in a docblock.
  test("the probe is issued ONLY when the vintage-filtered read comes back empty", async () => {
    const live = await seed(LEG_PILLAR_GENERATOR);
    const liveProbe = recordCalls(live, "getLegPillarLatestGenerator");
    await ewPctCell(live, SLEEVE, { kind: "scored", value: 0.5 });
    expect(liveProbe).toEqual([]);

    const stale = await seed("old");
    const staleProbe = recordCalls(stale, "getLegPillarLatestGenerator");
    await ewPctCell(stale, SLEEVE, { kind: "scored", value: 0.5 });
    expect(staleProbe).toEqual([[SLEEVE, "EARLY-WARN"]]);
  });

  // A FAILED series read must not then fabricate a vintage verdict off a probe against the same
  // broken table — the honest answer stays the logged `warmup` (review C1's contract, extended).
  test("a failed series read degrades to warmup WITHOUT probing", async () => {
    const s = await seed("old");
    failWith(s, "getLegPillarSeries", 'relation "leg_pillars" does not exist');
    const probe = recordCalls(s, "getLegPillarLatestGenerator");
    expect(await ewPctCell(s, SLEEVE, { kind: "scored", value: 0.5 })).toEqual({ kind: "warmup" });
    expect(probe).toEqual([]);
  });
});


// W4 Stage 4.4 falsifier 3 — the `basis` half: a ranked window that SPANS a roster change serves the
// number but is marked, and carries the change dates. Unit seam: `GET` never reaches a `pct` arm on
// a mixed-basis window.
describe("ewPctCell - mixed-basis marking (Stage 4.4)", () => {
  const SLEEVE = LEG_FIELD[0]!.sleeve;
  const day = (i: number) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);

  /** A full rankable window whose `basis` is `basisAt(i)` — same ascending i/500 ladder as the
   *  blocks above, so the RANK stays the out-of-band 251/500 and only the marking can differ. */
  async function seedWindow(basisAt: (i: number) => string, rows = ECDF_WINDOW): Promise<InMemoryStore> {
    const s = new InMemoryStore();
    await s.putLegPillars(
      Array.from({ length: rows }, (_, i) => ({
        obsDate: day(i),
        sleeve: SLEEVE,
        superGroup: "EARLY-WARN",
        value: i / ECDF_WINDOW,
        estimated: false,
        basis: basisAt(i),
        generator: LEG_PILLAR_GENERATOR,
      })),
    );
    return s;
  }

  // NON-VACUITY CONTROL: the identical fixture under ONE roster carries no `basisSpans`. Without
  // this, "always mark" would pass below.
  test("a single-roster window ⇒ no basisSpans", async () => {
    const s = await seedWindow(() => "F1,F2");
    const cell = await ewPctCell(s, SLEEVE, { kind: "scored", value: 0.5 });
    expect(cell).toEqual({ kind: "pct", value: 251 / ECDF_WINDOW });
    expect(cell).not.toHaveProperty("basisSpans"); // OMITTED, not `[]` — the wire arm is optional
  });

  // Red demo: drop the `basisChangeDates` call in `ewPctCell` ⇒ this reds on the missing dates.
  test("a window straddling a roster change ⇒ the change dates", async () => {
    // The measured shape (spec §0): the roster gains a member partway through the window, so the
    // OLDER closes were computed off a smaller member set. Boundary at i = 300 ⇒ day(300).
    const s = await seedWindow((i) => (i < 300 ? "F1,F2" : "F1,F2,EURC"));
    const cell = await ewPctCell(s, SLEEVE, { kind: "scored", value: 0.5 });
    // The NUMBER is still served — refuse-to-mix is unshippable (it would print `—` until ~2028) —
    // and it is the same rank the single-roster control gets: marking never changes the arithmetic.
    expect(cell).toEqual({
      kind: "pct",
      value: 251 / ECDF_WINDOW,
      basisSpans: [day(300)],
    });
  });

  // WINDOW-SCOPED, not series-scoped. A change that fell OUT of the back of the rolling window is
  // history the rank never touched, so naming it would be a false alarm that never clears. This is
  // the fixture that discriminates "detect over the ranked slice" from "detect over the rows read".
  test("a roster change OLDER than the ranked window is NOT reported", async () => {
    // 550 rows: the change sits at i = 20, and the newest ECDF_WINDOW closes start at i = 50.
    const s = await seedWindow((i) => (i < 20 ? "OLD" : "F1,F2"), ECDF_WINDOW + 50);
    const cell = await ewPctCell(s, SLEEVE, { kind: "scored", value: 0.5 });
    expect(cell).not.toHaveProperty("basisSpans");
    expect(cell).toEqual({ kind: "pct", value: (251 - 50) / ECDF_WINDOW });
  });

  // Two changes inside one window are both named — the real May-2026 shape (EURC then BUND).
  test("two roster changes inside the window ⇒ both dates, ascending", async () => {
    const s = await seedWindow((i) => (i < 200 ? "A" : i < 400 ? "B" : "C"));
    const cell = await ewPctCell(s, SLEEVE, { kind: "scored", value: 0.5 });
    expect(cell).toEqual({
      kind: "pct",
      value: 251 / ECDF_WINDOW,
      basisSpans: [day(200), day(400)],
    });
  });

  // Nulls are dropped BEFORE the rank (review I3), so the span scan must run over the same
  // null-free slice — a scan over the raw rows would pair a change date with a row the rank never saw.
  test("the span scan runs over the NON-NULL closes the rank used", async () => {
    const s = new InMemoryStore();
    const NULLS = 5;
    await s.putLegPillars(
      Array.from({ length: ECDF_WINDOW + NULLS }, (_, i) => ({
        obsDate: day(i),
        sleeve: SLEEVE,
        superGroup: "EARLY-WARN",
        // The newest five rows are holes; the 500 closes below them straddle a change at i = 300.
        value: i < ECDF_WINDOW ? i / ECDF_WINDOW : null,
        estimated: false,
        basis: i < 300 ? "F1,F2" : "F1,F2,EURC",
        generator: LEG_PILLAR_GENERATOR,
      })),
    );
    expect(await ewPctCell(s, SLEEVE, { kind: "scored", value: 0.5 })).toEqual({
      kind: "pct",
      value: 251 / ECDF_WINDOW,
      basisSpans: [day(300)],
    });
  });
});
