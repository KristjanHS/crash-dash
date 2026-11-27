/**
 * Tests for GET /api/exposure (api/exposure.ts) — the wiring, not the posture
 * math (that's covered in src/exposure.test.ts). We verify: calm F1 + a GT cushion
 * clear of GT's resolved band → 200 Full with both keys quiet; armed+fired → Defensive; empty store → 200
 * posture null; a throwing store degrades to a 200 (never 500); and the edge-cache
 * header.
 *
 * Each test swaps in a fresh InMemoryStore and passes it through the injected seam (rung 8a).
 */
import { VINTAGE_HEADERS, VINTAGE_TAG } from "../src/api/http.js";
import { describe, expect, test } from "vitest";

import { InMemoryStore } from "../src/store-memory.js";
import { type StoredReading, type Store } from "../src/store.js";
import {
  ARM_MIN_OBS,
  EQUITY_PCT,
  EXPOSURE_THRESHOLDS,
  FIRE_MA_APPROACH_SPREAD,
} from "../src/exposure.js";
import { assembleRun } from "../src/run-core.js";
import { LADDER } from "../src/families.js";
import type { AlertRecord } from "../src/store.js";
import type { T1DialResult } from "../src/t1dial.js";
import { makeDial } from "../src/test-helpers.js";
import { gf } from "../src/danger-engine.test-helpers.js";
import type { Reading } from "../src/domain-types.js";
import { CASH_ACCEL_RUNGS } from "../src/cash-overlay.js";
import { GT } from "../src/registry-composite.js";
import { resolvedDerivedBands } from "../src/scorers-core.js";
import type { ExposureResponse } from "../src/api/types.js";

// `let` so each test can swap in a fresh store; every call passes it through the seam.
let store: Store = new InMemoryStore();

const { exposureBody, handle } = await import("./exposure.js");

const RUN_AT = "2026-06-25T21:00:00.000Z";
const N_F1 = ARM_MIN_OBS + 40; // clears the degraded floor with headroom

/** Sequential YYYY-MM-DD dates so getSeries collapses cleanly by obs_date. */
function dateAt(i: number): string {
  return new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
}

async function seedF1(s: InMemoryStore, values: number[]): Promise<void> {
  await s.recordReadings(
    values.map((value, i) => ({
      date: dateAt(i),
      indicatorId: "F1",
      value,
      delta20: 0,
      rawState: "GREEN",
      state: "GREEN",
    })) satisfies StoredReading[],
    RUN_AT,
  );
}

async function seedGT(s: InMemoryStore, decisions: number[]): Promise<void> {
  await s.recordReadings(
    decisions.map((decision, i) => ({
      date: dateAt(i),
      indicatorId: "GT",
      value: 1,
      delta20: 0,
      rawState: "GREEN",
      state: "GREEN",
      decision,
    })) satisfies StoredReading[],
    RUN_AT,
  );
}

// Calm credit: a gently drifting 2y body with the LATEST value alone below all of
// it → percentile rank ~0 and a negative 30d ROC → NOT armed, NOT degraded. (Body
// values must DIFFER — a perfectly flat window degrades the percentile to null.)
const CALM_F1 = Array.from({ length: N_F1 }, (_, i) => (i === N_F1 - 1 ? 3 : 4 + i * 0.001));
// Stressed credit: latest sits above the whole window → percentile rank 1 → armed.
const ARMED_F1 = Array.from({ length: N_F1 }, (_, i) => (i === N_F1 - 1 ? 8 : 3));
// GT cushions derived from the RESOLVED band FIRE now consumes (CORE-B4) — never literals,
// so a GT retune moves these fixtures with the rule instead of test-locking the old cuts.
const GT_CUT = resolvedDerivedBands(GT).amber!;
const GT_QUIET = GT_CUT + FIRE_MA_APPROACH_SPREAD + 0.01; // clear of the band AND its pre-alert
const GT_APPROACH = GT_CUT + FIRE_MA_APPROACH_SPREAD / 2; // above the band, inside the pre-alert

describe("GET /api/exposure", () => {
  test("GT cushion clear of its resolved band → 200 Full, both keys quiet", async () => {
    store = new InMemoryStore();
    await seedF1(store as InMemoryStore, CALM_F1);
    await seedGT(store as InMemoryStore, [GT_CUT, GT_QUIET]); // GT scores GREEN → trend intact

    const res = await handle(store);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ExposureResponse;

    // K5: quiet keys with NEITHER approaching is Full (100% equity) — Core now means
    // "0 keys, but one is approaching", so this fixture would no longer reach it.
    expect(body.posture).toBe("Full");
    expect(body.equityPct).toBe(100);
    expect(body.arm.armed).toBe(false);
    expect(body.arm.approaching).toBe(false);
    expect(body.arm.degraded).toBe(false);
    expect(body.fire.fired).toBe(false);
    expect(body.fire.approaching).toBe(false); // latest cushion clears the amber+4pp pre-alert cut
    expect(body.fire.degraded).toBe(false);
    expect(body.asOf).not.toBeNull();
  });

  test("the raw F1 level, 30d ROC and GT's MA200 spread stay in the full body only — the wire gets arm.level/arm.roc/fire.maSpread null and summary's ROC slot \"—\", the rest unchanged", async () => {
    store = new InMemoryStore();
    await seedF1(store as InMemoryStore, CALM_F1);
    await seedGT(store as InMemoryStore, [GT_CUT, GT_QUIET]);
    const [redacted, full] = await Promise.all([handle(store), exposureBody(store, console.warn)]);
    const a = (await redacted.json()) as ExposureResponse;
    const r = JSON.parse(JSON.stringify(full)) as ExposureResponse;
    expect(r.arm.level).toBe(CALM_F1.at(-1));
    expect(a.arm.level).toBeNull();
    // 3.5b: the F1 30d change (a statistic over ONE licensed input) — the full body carries it (non-vacuity), the served body does not.
    const ROC_SLOT = /[+-]\d+bp\/\d+d/;
    expect(r.arm.roc).not.toBeNull();
    expect(r.summary).toMatch(ROC_SLOT);
    expect(a.arm.roc).toBeNull();
    expect(a.summary).toBe(r.summary.replace(ROC_SLOT, "—"));
    // GT's persisted decision IS ACWI's MA200 spread — a statistic over a licensed level (`/api/series` drops GT's decision too).
    expect(r.fire.maSpread).not.toBeNull();
    expect(a.fire.maSpread).toBeNull();
    expect(a.fire.fired).toBe(r.fire.fired); // the verdict stays
    expect({ ...a, arm: { ...a.arm, level: r.arm.level, roc: r.arm.roc }, fire: { ...a.fire, maSpread: r.fire.maSpread }, summary: r.summary }).toEqual(r);
  });

  test("approaching tier rides the DTO (E3 Decision 1)", async () => {
    store = new InMemoryStore();
    await seedF1(store as InMemoryStore, CALM_F1);
    await seedGT(store as InMemoryStore, [GT_QUIET, GT_APPROACH]); // inside the pre-alert, still GREEN

    const res = await handle(store);
    const body = (await res.json()) as ExposureResponse;
    // Post-K5 the pre-alert is EXACTLY what moves the posture: one approaching key steps
    // Full -> Core (100% -> 70% equity). It is a real de-risk step, not a heads-up.
    expect(body.posture).toBe("Core");
    expect(body.fire.fired).toBe(false);
    expect(body.fire.approaching).toBe(true);
  });

  test("armed credit + fired trend → 200 Defensive (2 keys)", async () => {
    store = new InMemoryStore();
    await seedF1(store as InMemoryStore, ARMED_F1);
    await seedGT(store as InMemoryStore, [GT_QUIET, -0.05]); // GT scores RED → fired

    const res = await handle(store);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ExposureResponse;

    expect(body.posture).toBe("Defensive");
    expect(body.arm.armed).toBe(true);
    expect(body.fire.fired).toBe(true);
  });

  test("empty store → 200 with posture null (warming up), asOf null", async () => {
    store = new InMemoryStore();
    const res = await handle(store);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ExposureResponse;
    expect(body.posture).toBeNull();
    expect(body.asOf).toBeNull();
  });

  test("store throw degrades to a 200 with degraded flags, never a 500", async () => {
    store = {
      getSeries: async () => {
        throw new Error("boom");
      },
    } as unknown as Store;

    const warned: unknown[][] = [];
    const res = await handle(store, { warn: (...args) => void warned.push(args) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ExposureResponse;
    expect(body.posture).toBeNull();
    expect(body.arm.degraded).toBe(true);
    expect(body.fire.degraded).toBe(true);
    expect(warned.map((c) => String(c[0]))).toEqual(["[exposure] verdict read failed - serving the rung-blind posture:"]);
  });

  // R1: the /exposure chip footnotes print live cut values, and the seam ruling (2026-07-26)
  // puts them on the WIRE so public/ holds no numeric copy. If the handler stops serving them
  // the footnote silently loses its numbers, so the wire half is pinned here — including on the
  // degraded path, where the copy is exactly as needed as on a healthy one.
  test("serves the ARM/FIRE cuts (EXPOSURE_THRESHOLDS) on every response, degraded included", async () => {
    store = new InMemoryStore(); // empty ⇒ posture null, the degraded shape
    const body = (await (await handle(store)).json()) as ExposureResponse;
    expect(body.posture).toBeNull();
    expect(body.thresholds).toEqual(EXPOSURE_THRESHOLDS);
  });

  test("sets the tagged vintage edge-cache headers", async () => {
    store = new InMemoryStore();
    const res = await handle(store);
    expect(res.headers.get("Cache-Control")).toBe(VINTAGE_HEADERS["Cache-Control"]);
    expect(res.headers.get("Vercel-Cache-Tag")).toBe(VINTAGE_TAG);
  });
});

/**
 * R8 Stage 1 falsifier 3 — the BOTH-CALL-SITES invariant. `/api/exposure` and the run path must
 * return the SAME compound-floor-bounded posture for a state in the blocked set. If only one side
 * bounds, the served posture and the pushed weight disagree on the same close — the exact
 * two-surface disagreement this rung exists to end.
 *
 * The state: raw posture `Defensive` (both keys tripped) holding rung 9 `Staples` — the deepest
 * blocked cell, whose relaxation chain runs Defensive → Reduced → Core → Full.
 */
describe("R8 compound floor - /api/exposure and the run path agree", () => {
  const STAPLES = LADDER[LADDER.length - 1]!; // rung 9, the most defensive leg

  /** The fixed-width band around the target rung (`dialBandFor`), via the shared `makeDial` — whose
   *  hand-typed `dangerScore`/`regime` beside `rung` is a shape `computeT1Dial` itself cannot emit.
   *  The in-band held pick then follows each leg's OWN danger, not the ● (band spans ≥3 legs). */
  const dialAt = (rung: number): T1DialResult => makeDial({ rung });

  test("both surfaces resolve Defensive x r9 to the same bounded posture", async () => {
    // --- surface A: the handler. Armed credit + fired trend ⇒ raw Defensive; the persisted
    // verdict supplies the held rung the pure engine cannot see.
    store = new InMemoryStore();
    await seedF1(store as InMemoryStore, ARMED_F1);
    await seedGT(store as InMemoryStore, [GT_QUIET, -0.05]);
    // `cashOverlay: "partial"` on the SAME row: the handler has no live overlay, so the persisted
    // column is its only cash input — and surface B's rising prior-rung window fires the overlay
    // below. Both surfaces must be on the same cash state or the R8 Stage 2 step-down applies to
    // one of them only, which is the disagreement this test exists to catch.
    await (store as InMemoryStore).recordAlert({
      date: dateAt(1),
      heldSleeve: STAPLES,
      cashOverlay: "partial",
    } as unknown as AlertRecord);
    const body = (await (await handle(store)).json()) as ExposureResponse;

    // --- surface B: the run path. Same raw posture, same held rung (the rung-9 band forces it).
    // The rising prior-rung window fires the cash overlay, which is what makes the run path RENDER
    // its equity weight — with the overlay off the push carries no sized line to compare.
    const prior = (date: string, dialTargetRung: number) =>
      ({ date, firedAt: `${date}T21:00:00.000Z`, dialTargetRung }) as unknown as AlertRecord;
    const { alert, notification } = assembleRun({
      readings: [] as Reading[],
      last: null,
      lastPush: null,
      now: "2026-07-31T21:00:00.000Z",
      dial: dialAt(9),
      // The band r7–r9 now spans EU-Fin/Health/Staples, so the field — not the ● — picks the held leg.
      // R5 RED + VT AMBER lift EU-Fin/Health danger clear of Staples (r9) ⇒ r9 is the strict calmest,
      // so the run genuinely holds the deepest cell (drop the seed and it holds EU-Fin, the guard reds).
      globalFamilies: gf([{ id: "R5", state: "RED" }, { id: "VT", state: "AMBER" }]).globalFamilies,
      recentAlerts: [prior("2026-07-30", 8), prior("2026-07-29", 9 - CASH_ACCEL_RUNGS)],
      exposurePosture: "Defensive",
    });
    expect(alert.cashOverlay).toBe("partial"); // vacuity guard: the sized line really is rendered
    expect(alert.heldSleeve).toBe(STAPLES); // vacuity guard: the run really is on the blocked cell

    // The invariant: one posture, two surfaces. The floor sends Defensive x r9 to `Full`
    // (1.7 → 4.4 → 7.8 → 11.1); R8 Stage 2 then steps that `Full` down one tier, because a
    // published `partial` at 100% equity would hold nothing back. End state: `Core`.
    expect(body.posture).toBe("Core");
    expect(body.equityPct).toBe(EQUITY_PCT.Core);
    // Non-vacuity, both mechanisms: the UNBOUNDED answer is Defensive/15 (so the floor really ran),
    // and the floor-only answer is Full/100 (so the step-down really ran) — this cell separates all
    // three rather than agreeing for an unrelated reason.
    expect(body.posture).not.toBe("Defensive");
    expect(body.posture).not.toBe("Full");
    // Run-path side: 70% equity ⇒ a 30% standing non-equity, which is what the push renders — the
    // sized `partial` that R8's round-2 falsifier demands. Before Stage 2 this same cell pushed
    // "fully invested — 0% cash": a `partial` whose size is zero.
    expect(notification.message.body).toMatch(/30% cash/);
    expect(notification.message.body).not.toMatch(/fully invested/);
  });

  /**
   * The RUNG half of the seam (review fix, 2026-07-31). The test above pins the FLOOR only: it
   * drives surface A from a persisted sleeve and surface B from a synthetic r9 dial — two different
   * rung inputs — so a MAPPING skew (an off-by-one on one side, or one side reading a renamed-out
   * sleeve as a rung) is structurally invisible to it. Since both surfaces now derive the rung
   * through `rungOfSleeve` (`src/families.ts`), that mapping is what this pins.
   *
   * Each loop step seeds BOTH surfaces with the SAME held sleeve — the calmest in-band leg of the
   * dial's band, which with zero danger is the band floor `LADDER[dialBandFor(...).lo - 1]` — across
   * every dial rung that renders a sized cash line (≥ CASH_ACCEL_RUNGS + 1). Raw posture `Defensive`
   * throughout; the served postures separate across the range (the size > 1 guard below), so a
   * one-rung mapping skew on either side lands on a different equity and reds.
   */
  test("both surfaces map the SAME sleeve name to the SAME rung (and a renamed-out sleeve to none)", async () => {
    const prior = (date: string, dialTargetRung: number) =>
      ({ date, firedAt: `${date}T21:00:00.000Z`, dialTargetRung }) as unknown as AlertRecord;
    /** The push renders `${100 - equityPct}% cash` (`resolveCash` standing) — including the
     *  `Full` case, whose copy is "fully invested — 0% cash". */
    const pushedNonEquity = (body: string): number => {
      const m = /(\d+)% cash/.exec(body);
      expect(m, body).not.toBeNull();
      return Number(m![1]);
    };

    const servedByRung = new Map<number, string | null>();
    for (let rung = CASH_ACCEL_RUNGS + 1; rung <= LADDER.length; rung++) {
      // The sleeve the run path actually holds: the calmest in-band leg = the dial band's floor at
      // zero danger. Both surfaces are driven from THIS one name, so the pin is the shared mapping.
      const heldName = LADDER[dialAt(rung).band.lo - 1]!;
      // --- surface A: the handler, rung supplied by the persisted sleeve NAME.
      store = new InMemoryStore();
      await seedF1(store as InMemoryStore, ARMED_F1);
      await seedGT(store as InMemoryStore, [GT_QUIET, -0.05]);
      await (store as InMemoryStore).recordAlert({
        date: dateAt(1),
        heldSleeve: heldName,
        // Same cash state as surface B (whose rising window fires the overlay) — see the first test.
        cashOverlay: "partial",
      } as unknown as AlertRecord);
      const body = (await (await handle(store)).json()) as ExposureResponse;

      // --- surface B: the run path, same rung, arrived at through the dial → sleeve → rung chain.
      const { alert, notification } = assembleRun({
        readings: [] as Reading[],
        last: null,
        lastPush: null,
        now: "2026-07-31T21:00:00.000Z",
        // The WHOLE book moves with the rung — the pre-fix form re-typed `band`/`rung`/`targetRung`
        // on top of a fixed rung-9 literal and left `dangerScore`/`regime` calm at every step.
        dial: dialAt(rung),
        globalFamilies: [],
        recentAlerts: [prior("2026-07-30", rung - 1), prior("2026-07-29", rung - CASH_ACCEL_RUNGS)],
        exposurePosture: "Defensive",
      });
      // Vacuity guards: the run really is on the band-floor sleeve and really renders a sized cash line.
      expect(alert.heldSleeve, `rung ${rung}`).toBe(heldName);
      expect(alert.cashOverlay, `rung ${rung}`).toBe("partial");

      // The invariant: one sleeve name, one rung, one bounded equity weight on both surfaces.
      expect(100 - body.equityPct!, `rung ${rung}`).toBe(pushedNonEquity(notification.message.body));
      servedByRung.set(rung, body.posture);
    }
    // Non-vacuity for the loop: the range must actually SEPARATE rungs — an implementation that
    // ignored the rung entirely would serve one posture everywhere and still satisfy the equality.
    expect(new Set(servedByRung.values()).size).toBeGreaterThan(1);

    // The RENAME case, which is why the seam is shared at all: after
    // the EU-Fin leg replacement renamed rung-7; a persisted `held_sleeve` can
    // still carry a name LADDER no longer contains (the pre-rename spelling itself is mapped forward
    // by `canonicalSleeve` at the store's hydration seam, so it is not what this pins). Both
    // surfaces must read such a string as rung-BLIND — the raw
    // posture passes through — never as rung 0 (arithmetically indistinguishable from a rung:
    // `effectiveEquityRisk(15, 0)` = 16.7 clears the floor) and never as a fabricated rung. The run
    // path cannot MINT an out-of-vocabulary sleeve (its held is always some in-band `LADDER[i]`),
    // so its half of the claim is pinned on the shared function itself in `src/families.test.ts`;
    // here we pin the surface that reads the persisted column.
    const renamedOut = "High-Div (pre-EU-Fin)";
    expect(LADDER as readonly string[]).not.toContain(renamedOut); // vacuity guard
    store = new InMemoryStore();
    await seedF1(store as InMemoryStore, ARMED_F1);
    await seedGT(store as InMemoryStore, [GT_QUIET, -0.05]);
    await (store as InMemoryStore).recordAlert({
      date: dateAt(1),
      heldSleeve: renamedOut,
    } as unknown as AlertRecord);
    const renamed = (await (await handle(store)).json()) as ExposureResponse;

    store = new InMemoryStore(); // no alert row at all — the reference rung-blind response
    await seedF1(store as InMemoryStore, ARMED_F1);
    await seedGT(store as InMemoryStore, [GT_QUIET, -0.05]);
    const noSleeve = (await (await handle(store)).json()) as ExposureResponse;

    expect(renamed.posture).toBe(noSleeve.posture);
    expect(renamed.equityPct).toBe(noSleeve.equityPct);
    expect(renamed.posture).toBe("Defensive"); // the RAW posture, unbounded
    expect(renamed.equityPct).toBe(EQUITY_PCT.Defensive);
    // Non-vacuity: read as a rung, the deepest rung would have relaxed it away from Defensive.
    expect(servedByRung.get(LADDER.length)).not.toBe(renamed.posture);
  });
});

describe("served verdict (rederive, ruled 2026-10-05)", () => {
  const STAPLES = LADDER[LADDER.length - 1]!;
  const EOD = { date: dateAt(1), firedAt: RUN_AT, heldSleeve: null, cashOverlay: "off" } as unknown as AlertRecord;
  const DAY = { date: dateAt(1), firedAt: "2026-06-26T12:00:00.000Z", heldSleeve: STAPLES, cashOverlay: "partial" } as unknown as AlertRecord;
  const seeded = async (rows: AlertRecord[], slot: AlertRecord | null): Promise<InMemoryStore> => {
    const s = new InMemoryStore();
    await seedF1(s, ARMED_F1);
    await seedGT(s, [GT_QUIET, -0.05]);
    for (const r of rows) await s.recordAlert(r);
    if (slot) await s.putIntradayVerdict(slot);
    return s;
  };
  const body = async (s: InMemoryStore) => (await (await handle(s)).json()) as ExposureResponse;

  test("a newer intraday slot bounds the posture exactly as that row would as the EOD row; an older slot is ignored", async () => {
    const eodOnly = await body(await seeded([EOD], null));
    const viaSlot = await body(await seeded([EOD], DAY));
    const { provisional, ...viaSlotRest } = viaSlot;
    expect([provisional, eodOnly.provisional]).toEqual([true, undefined]);
    expect(viaSlotRest).toEqual(await body(await seeded([DAY], null)));
    expect(viaSlot.posture).not.toBe(eodOnly.posture); // non-vacuity: the slot's held rung really moves the posture
    expect(await body(await seeded([EOD], { ...DAY, firedAt: "2026-06-25T12:00:00.000Z" }))).toEqual(eodOnly);
  });
});
