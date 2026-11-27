/**
 * Pins for the measured release-delay term (`[USER]`-ruled):
 *  1. DRIFT — the committed snapshot covers exactly the live daily/weekly roster, so a new id (or a
 *     retired one) announces `npm run probe:release-delay` instead of silently scoring at 0.
 *  2. PARITY — F1 and R2 (same publisher, different containment grids) carry the same delay, and the
 *     one-missed-release margin is preserved: healthy = fresh, one miss = behind. Derived off the
 *     snapshot's own values, never restated.
 *  3. END-TO-END — `freshnessFrom` over an in-memory store: two T+1 ids sitting at the T+1 age read
 *     fresh, a delay-0 id at the same age reads behind.
 *
 * Red demo (recorded in the shipping commit): with `slotLag` mutated to `age > cut`, tests 2 and 3 fail.
 */
import { describe, expect, it } from "vitest";
import { CADENCE_OF, compositeLegParentIndex, freshnessFrom } from "./feed-lag.js";
import { LADDER } from "./families.js";
import { legCloseId, OFF_LADDER_LEG_KEYS, offLadderLegCloseId } from "./scoreboard.js";
import {
  RELEASE_DELAY_HAND_FLOOR,
  RELEASE_DELAY_INPUT_DONORS,
  RELEASE_DELAY_OF,
  RELEASE_DELAY_SNAPSHOT_TYPED,
  releaseDelayFor,
  slotLag,
} from "./release-delay.js";
import type { SeriesPoint, Store } from "./store.js";
import { resolveFreshness, type LagCalendars } from "./scorers-core.js";
import { publicationCalendar } from "./publication-calendar.js";

const REGEN = "run `npm run probe:release-delay` and commit scripts/release-delay.snapshot.json";
const slotIds = [...CADENCE_OF.keys()].filter((id) => {
  const c = CADENCE_OF.get(id) ?? "daily";
  return c === "daily" || c === "weekly";
});

describe("release-delay snapshot drift", () => {
  const snap = RELEASE_DELAY_SNAPSHOT_TYPED;
  const covered = new Set([...Object.keys(snap.delays), ...snap.unmeasured]);

  it("every live daily/weekly id is measured or listed unmeasured", () => {
    const missing = slotIds.filter((id) => !covered.has(id));
    expect(missing, `snapshot lacks ${missing.join(",")} - ${REGEN}`).toEqual([]);
  });
  it("ships every hand-floored id with a delay entry, never in `unmeasured` (the probe re-applies RELEASE_DELAY_HAND_FLOOR)", () => {
    // The value is NOT pinned: a measurement with ≥ MIN_LIVE_SAMPLES wins whatever it reads (a genuine 0 included), and
    // the snapshot does not record floored vs measured — so the only invariant is "never left unmeasured / at 0 by absence".
    const reverted = Object.keys(RELEASE_DELAY_HAND_FLOOR).filter((id) => !(id in snap.delays) || snap.unmeasured.includes(id));
    expect(
      reverted,
      `${reverted.join(",")} shipped unmeasured or without a delay - the snapshot predates the hand floor or was hand-edited; ${REGEN} (the probe re-applies RELEASE_DELAY_HAND_FLOOR)`,
    ).toEqual([]);
  });
  it("carries no id the registry no longer scores in slots", () => {
    const live = new Set(slotIds);
    const orphans = [...covered].filter((id) => !live.has(id));
    expect(orphans, `snapshot has retired ids ${orphans.join(",")} - ${REGEN}`).toEqual([]);
  });
  it("every served LEGP_* id carries ONE delay (one writer - seedLegClosesOnCron)", () => {
    // A new off-ladder leg lands backfill-only; left `unmeasured` it scores 0 and reads false-behind
    // every morning beside its T+1 siblings (LEGP_COMMOD/LEGP_RAFI, 2026-09-23). The probe pools it.
    const legs = [...LADDER.map(legCloseId), ...OFF_LADDER_LEG_KEYS.map(offLadderLegCloseId)].filter((id) => slotIds.includes(id));
    expect(legs.length).toBeGreaterThan(1);
    const unmeasuredLegs = legs.filter((id) => snap.unmeasured.includes(id));
    expect(unmeasuredLegs, `unmeasured leg(s) ${unmeasuredLegs.join(",")} - ${REGEN}`).toEqual([]);
    expect(new Set(legs.map(releaseDelayFor)).size, legs.join(",")).toBe(1);
  });
  it("a composite leg on a daily parent's grid carries its parent's delay", () => {
    const legs = [...compositeLegParentIndex()].filter(([, p]) => CADENCE_OF.get(p) === "daily");
    expect(legs.length).toBeGreaterThan(0);
    for (const [leg, parent] of legs) {
      if (snap.unmeasured.includes(leg)) continue; // ungriddable on BOTH grids ⇒ scored 0 by contract
      expect(releaseDelayFor(leg), `${leg} vs ${parent}`).toBe(releaseDelayFor(parent));
    }
  });
  it("a derived id never scores a shorter delay than the feeds carrying its inputs", () => {
    for (const [id, donors] of Object.entries(RELEASE_DELAY_INPUT_DONORS)) {
      expect(slotIds, id).toContain(id);
      for (const d of donors) expect(snap.delays, `${id} donor ${d}`).toHaveProperty(d);
      expect(releaseDelayFor(id), `${id} vs ${donors.join(",")} - ${REGEN}`).toBeGreaterThanOrEqual(
        Math.max(...donors.map(releaseDelayFor)),
      );
    }
  });
  it("delays are non-negative integers and an unmeasured id scores 0", () => {
    // Asserted on the RAW snapshot, not on RELEASE_DELAY_OF (which sanitizes with max(0, trunc)).
    for (const [id, d] of Object.entries(snap.delays)) expect(d, id).toBeGreaterThanOrEqual(0);
    for (const [id, d] of Object.entries(snap.delays)) expect(Number.isInteger(d), id).toBe(true);
    expect(RELEASE_DELAY_OF.size).toBe(Object.keys(snap.delays).length);
    for (const id of snap.unmeasured) expect(releaseDelayFor(id)).toBe(0);
    expect(releaseDelayFor("NOT_A_FEED")).toBe(0);
  });
});

describe("slotLag - the one-missed-release margin survives the delay term", () => {
  const cut = 1;
  it("F1 and R2 share the publisher's delay (T+1 at FRED)", () => {
    expect(releaseDelayFor("F1")).toBe(releaseDelayFor("R2"));
    expect(releaseDelayFor("F1")).toBeGreaterThan(0);
  });
  it("healthy at its own delay + cut is fresh; one more slot is behind", () => {
    for (const id of ["F1", "R2", "SPY"]) {
      const d = releaseDelayFor(id);
      expect(slotLag(d + cut, cut, id), `${id} healthy`).toBe(false);
      expect(slotLag(d + cut + 1, cut, id), `${id} one miss`).toBe(true);
    }
  });
});

describe("freshnessFrom - T+1 ids at the T+1 age are not behind", () => {
  const weekdays = (from: string, n: number): string[] => {
    const out: string[] = [];
    const t = new Date(`${from}T00:00:00Z`);
    while (out.length < n) {
      const day = t.getUTCDay();
      if (day !== 0 && day !== 6) out.push(t.toISOString().slice(0, 10));
      t.setUTCDate(t.getUTCDate() + 1);
    }
    return out;
  };
  // Dense weekday window ending on "today" (Thu 2026-09-10); the T+1 ids stop 2 slots earlier.
  const window = weekdays("2026-03-02", 139);
  const today = window.at(-1)!;
  const behindBy2 = window.slice(0, -2);
  const pts = (dates: readonly string[]): SeriesPoint[] => dates.map((date) => ({ date, value: 1 }) as SeriesPoint);
  const t1 = ["F1", "R2"];
  const sameDay = slotIds.find((id) => releaseDelayFor(id) === 0 && CADENCE_OF.get(id) === "daily" && !id.startsWith("CMP_"))!;
  // Honours `opts.limit` like the real store (newest `limit` rows, oldest→newest): the day-cadence probe reads 1 row.
  const store = {
    getSeriesBulk: async (ids: string[], opts: { limit: number }) =>
      new Map(ids.map((id) => [id, pts((t1.includes(id) || id === sameDay ? behindBy2 : window).slice(-opts.limit))])),
  } as unknown as Store;

  it("F1 and R2 read age 2, fresh; a delay-0 id at age 2 reads behind", async () => {
    expect(today).toBe("2026-09-10");
    expect(sameDay, "a delay-0 non-composite daily id must exist").toBeDefined();
    const stamp = await freshnessFrom(store, new Date(`${today}T12:00:00Z`));
    const by = new Map(stamp.freshness.map((f) => [f.id, f]));
    for (const id of t1) {
      expect(stamp.ageDays.get(id), id).toBe(2);
      expect(by.get(id)?.lag, `${id} must not be behind at its own T+1 age`).toBe(false);
    }
    expect(stamp.ageDays.get(sameDay), sameDay).toBe(2);
    expect(by.get(sameDay)?.lag, `${sameDay} (delay 0) at age 2 is behind`).toBe(true);
  });
});

/**
 * The 2026-10-13 live case ("17 of 123 feeds behind"): Columbus Day 2026-10-12 — FRED closed, NYSE open. Every FRED
 * feed's grid gains 10-12 from its equity peers (nobody printed since 10-08/10-09, so containment cannot charge them),
 * and a feed that is exactly where FRED's calendar leaves it read one slot behind. Both resolution points subtract
 * the closure (`isSlotExcused`); a feed that genuinely missed a release still flags.
 * Red demo: with `slotAge`'s `excused` term ignored, F1/R2/T10YIE/R6 all read `lag: true` here.
 */
describe("Columbus week - a FRED publisher closure is not lateness (read path + run path)", () => {
  const weekdays = (from: string, to: string): string[] => {
    const out: string[] = [];
    for (const t = new Date(`${from}T00:00:00Z`); t.toISOString().slice(0, 10) <= to; t.setUTCDate(t.getUTCDate() + 1)) {
      if (t.getUTCDay() !== 0 && t.getUTCDay() !== 6) out.push(t.toISOString().slice(0, 10));
    }
    return out;
  };
  const TODAY = "2026-10-13"; // Tuesday, before FRED's first post since Friday
  const through = (last: string) => weekdays("2026-04-06", last);
  const pts = (dates: readonly string[]): SeriesPoint[] => dates.map((date) => ({ date, value: 1 }) as SeriesPoint);
  // newest FINAL print per id on prod that morning (FRED tails read 05:41Z): T+1 ICE/H.15 ids at Thu 10-08,
  // the same-day T10YIE at Fri 10-09, MOVE at Fri 10-09 (no bar on a SIFMA close), NYSE feeds at Mon 10-12.
  // F2 is the control: dark since Wed 10-07 — one genuine missed release.
  // The 24/5 FX feeds (F11/FXH/F17/DEXUSEU, `NO_HOLIDAY_IDS`) had already printed Tue 10-13 — that is what puts
  // today on every grid; without a 10-13 slot the window `(newest, today]` would end at Monday.
  const newestOf: Record<string, string> = { F1: "2026-10-08", R2: "2026-10-08", T10YIE: "2026-10-09", R6: "2026-10-09", F2: "2026-10-07", F11: TODAY, FXH: TODAY, F17: TODAY, DEXUSEU: TODAY };
  const store = {
    getSeriesBulk: async (ids: string[], opts: { limit: number }) =>
      new Map(ids.map((id) => [id, pts(through(newestOf[id] ?? "2026-10-12").slice(-opts.limit))])),
  } as unknown as Store;

  it("read path: F1/R2 (T+1) age 2, T10YIE/R6 age 1 — none behind; the dark F2 is", async () => {
    expect([releaseDelayFor("F1"), releaseDelayFor("R2"), releaseDelayFor("T10YIE"), releaseDelayFor("R6")]).toEqual([1, 1, 0, 0]);
    const stamp = await freshnessFrom(store, new Date(`${TODAY}T05:30:00Z`));
    const by = new Map(stamp.freshness.map((f) => [f.id, f]));
    expect([stamp.ageDays.get("F1"), stamp.ageDays.get("R2"), stamp.ageDays.get("T10YIE"), stamp.ageDays.get("R6")]).toEqual([2, 2, 1, 1]);
    for (const id of ["F1", "R2", "T10YIE", "R6", "SPY"]) expect(by.get(id)?.lag, `${id} must not be behind on a FRED holiday week`).toBe(false);
    expect(stamp.ageDays.get("F2")).toBe(3);
    expect(by.get("F2")?.lag, "F2 missed a real release").toBe(true);
  });

  it("run path: `resolveFreshness` over a grid carrying 10-12 reads F1 age 2 / fresh, and SPY (NYSE, not excused) age 1", () => {
    const grid = publicationCalendar("fred", through("2026-10-13"), 2);
    const calendars: LagCalendars = { gridFor: () => grid };
    const f1 = resolveFreshness({ id: "F1", cadence: "daily" }, "2026-10-08", TODAY, calendars);
    expect(f1).toEqual({ lag: false, ageDays: 2, unit: "slots" });
    const spy = resolveFreshness({ id: "SPY", cadence: "daily" }, "2026-10-12", TODAY, calendars);
    expect(spy).toEqual({ lag: false, ageDays: 1, unit: "slots" });
    // Wed 10-14 (FRED posted 10-09 + 10-12 on Tuesday): an F1 still at 10-09 missed a real post — Columbus Day is
    // no longer excused (two post days after it), so it reads 3 − 1 = 2 > 1 behind; a healthy F1 at 10-12 reads 1.
    const wed = publicationCalendar("fred", through("2026-10-14"), 2);
    const wedCal: LagCalendars = { gridFor: () => wed };
    expect(resolveFreshness({ id: "F1", cadence: "daily" }, "2026-10-09", "2026-10-14", wedCal)).toEqual({ lag: true, ageDays: 3, unit: "slots" });
    expect(resolveFreshness({ id: "F1", cadence: "daily" }, "2026-10-12", "2026-10-14", wedCal)).toEqual({ lag: false, ageDays: 2, unit: "slots" });
    // The control: SPY stuck at Fri 10-09 is NOT excused Monday — it is one real miss behind.
    expect(resolveFreshness({ id: "SPY", cadence: "daily" }, "2026-10-09", TODAY, calendars)).toEqual({ lag: true, ageDays: 2, unit: "slots" });
  });
});
