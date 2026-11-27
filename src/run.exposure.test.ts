import { describe, expect, test, vi } from "vitest";
import { NOWCAST_MAX_CARRY_DAYS } from "./nowcast-carry.js";
import { InMemoryStore } from "./store-memory.js";
import type { AlertRecord, SeriesPoint, SeriesRange, StoredReading } from "./store.js";
import type { Observation, Reading } from "./domain-types.js";
import * as families from "./families.js";
import { LADDER } from "./families.js";
import * as exposureMod from "./exposure.js";
import { EQUITY_PCT, computeExposure } from "./exposure.js";
import { EXPOSURE_F1_LIMIT, EXPOSURE_GT_LIMIT, assembleRun, seedSeriesWithRun } from "./run-core.js";
import { CASH_ACCEL_RUNGS, CASH_ACCEL_WINDOW, CASH_PRIOR_MAX_AGE_DAYS, resolvePersistedCashLevel } from "./cash-overlay.js";
import { V_BEAR_F_LIMIT, V_VELOCITY_CUT } from "./v-bear.js";
import type { FallShape, FallShapeVerdict } from "./v-bear.js";
import { makeDial } from "./test-helpers.js";
import { f1RedBothLegs, fakeFeeds, fakeNotify, fredFlat, fredMock, installRunTestHooks, monotonicClock, priceCalm, priorAlert, runCycleWith, seedHyoasCalib, type FakeFeeds, type FakeNotify } from "./run.test-helpers.js";

let store: InMemoryStore;
installRunTestHooks((s) => {
  store = s;
});

// W5-a Stage 2.1 — the CASH OVERLAY is persisted on the alert row every run, BEFORE notify
// (INTENT semantics, mirror of dialBand/heldSleeve). These pin the two ends the plan names:
// a dial-less/degraded run must persist 'off' (never null, never a fabricated state), and a
// firing dial must actually reach the column — without which the first test alone would pass
// against a hardcoded 'off'.
describe("assembleRun - cash overlay persistence (W5-a Stage 2.1)", () => {
  const NOW = "2026-07-18T22:00:00.000Z";

  // The dial fixture is the SHARED `makeDial` (test-helpers.ts) — the local copy this block used to
  // carry was a second helper with the same job, and its `Partial<T1DialResult>` override type let a
  // caller re-open the very drift the shared one closes (the four derived fields are re-assigned after
  // the spread, so `{ regime: "Crisis" }` compiled, ran green, and produced the Calm book anyway).
  // Nothing here was run-specific: no family panel ⇒ neither credit nor volatility fires, which is
  // exactly `makeDial`'s `creditFiring`/`volatilityFiring` default of false beside its
  // `armed: false`/`fired: false` base book.

  // Only `date` / `dialTargetRung` / `cashOverlaySince` are read off `prevDay` by the overlay, so
  // the cast keeps the fixture to the fields under test rather than restating all ~50 AlertRecord
  // keys. `date` defaults to the trading day before `asOf` — a FRESH prior, since the overlay now
  // rejects a prior older than CASH_PRIOR_MAX_AGE_DAYS calendar days.
  const prevWith = (over: Partial<AlertRecord>): AlertRecord =>
    ({ date: "2026-07-17", cashOverlaySince: null, ...over }) as unknown as AlertRecord;

  test("a dial-less run persists 'off' - never null, never a fabricated state", () => {
    const { alert } = assembleRun({ readings: [], last: null, lastPush: null, now: NOW });

    expect(alert.cashOverlay).toBe("off");
    expect(alert.cashOverlaySince).toBeNull();
    // `dialTargetRung` is the stateful trigger's prior: null with no dial, exactly like dialBand.
    expect(alert.dialTargetRung).toBeNull();
    expect(alert.dialBand).toBeNull();
  });

  // LAG BOUND (the calendar axis of the window truncation). `getLastAlertBefore` has no
  // recency bound, so after a holiday cluster / feed outage / cron gap the prior fired-day row can
  // be months old. Comparing today's rung against it would fire and print "within 2 closes" for a
  // rise that took a quarter — a FALSE cash call. The PAIR is the point: the stale case alone
  // would also pass against a renderer that always says 'off', so the fresh case pins the accept
  // path with the SAME rungs.
  test("a STALE prevDay (past CASH_PRIOR_MAX_AGE_DAYS) does NOT fire - the same rungs fresh DO", () => {
    const dial = makeDial({ targetRung: 2 + CASH_ACCEL_RUNGS });
    const base = { readings: [] as Reading[], last: null, lastPush: null, now: NOW, dial };

    // asOf is 2026-07-18; this prior is ~2 months old but carries a qualifying rung.
    const stale = prevWith({ date: "2026-05-15", dialTargetRung: 2 });
    const { alert: lagAlert } = assembleRun({ ...base, prevDay: stale });
    expect(lagAlert.cashOverlay).toBe("off");
    expect(lagAlert.cashOverlaySince).toBeNull();

    // Identical rungs, a prior inside the bound ⇒ the trigger fires. Without this half the test
    // above passes against an overlay that never fires at all.
    const fresh = prevWith({ date: "2026-07-17", dialTargetRung: 2 });
    const { alert: freshAlert } = assembleRun({ ...base, prevDay: fresh });
    expect(freshAlert.cashOverlay).toBe("partial");
    expect(freshAlert.cashOverlaySince).toBe(NOW);
    expect(freshAlert.cashOverlayReason).toMatch(/target rung 2/);
    expect(freshAlert.dialTargetRung).toBe(2 + CASH_ACCEL_RUNGS);

    // Boundary: exactly CASH_PRIOR_MAX_AGE_DAYS old is still admitted (the bound is inclusive).
    const edgeDate = new Date(Date.parse("2026-07-18") - CASH_PRIOR_MAX_AGE_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const { alert: edgeAlert } = assembleRun({
      ...base,
      prevDay: prevWith({ date: edgeDate, dialTargetRung: 2 }),
    });
    expect(edgeAlert.cashOverlay).toBe("partial");
  });

  test("ORTHOGONALITY: the firing overlay leaves band/dialBand/heldSleeve identical to a calm prior", () => {
    const dial = makeDial({ targetRung: 2 + CASH_ACCEL_RUNGS });
    const base = { readings: [] as Reading[], last: null, lastPush: null, now: NOW, dial };

    const { alert: off } = assembleRun({ ...base });
    const { alert: on } = assembleRun({ ...base, prevDay: prevWith({ dialTargetRung: 2 }) });

    // Vacuity guard: the two runs really do differ in the overlay...
    expect(off.cashOverlay).toBe("off");
    expect(on.cashOverlay).toBe("partial");
    // ...and in NOTHING the ladder decides. The overlay READS the dial, never writes it.
    expect(on.level).toBe(off.level);
    expect(on.bandReason).toBe(off.bandReason);
    expect(on.dialBand).toBe(off.dialBand);
    expect(on.heldSleeve).toBe(off.heldSleeve);
    expect(on.pushedAt).toBe(off.pushedAt);
  });

  // ─── W5-d Stage 5.1: the flip. §2.7 ruling (A) — a v-shaped fall suppresses the overlay ─────
  // NON-VACUITY IS THE WHOLE POINT: the fixture is the FIRING one above (prior rung 2 + a
  // CASH_ACCEL_RUNGS rise ⇒ 'partial'), so the v-shaped arm is a real state change
  // 'partial' → 'off', not merely a reworded reason on an already-off overlay. On a calm fixture
  // `applyFallShape`'s `level: "off"` is a no-op and only the reason moves — that fixture would
  // pin nothing about suppression.
  const mkVerdict = (shape: FallShape): FallShapeVerdict => ({
    shape,
    velocity: -0.01,
    dwell: 0,
    reason: `test ${shape}`,
  });

  test("a v-shaped fall SUPPRESSES a firing cash overlay; bear/indeterminate are byte-identical", () => {
    const base = {
      readings: [] as Reading[],
      last: null,
      lastPush: null,
      now: NOW,
      dial: makeDial({ targetRung: 2 + CASH_ACCEL_RUNGS }),
      prevDay: prevWith({ dialTargetRung: 2 }),
    };

    // Pre-flip expectation: this fixture fires. Pinned here so the two control arms below are
    // compared against a KNOWN-ON baseline, not against whatever the code happens to emit.
    const { alert: unshaped } = assembleRun({ ...base });
    expect(unshaped.cashOverlay).toBe("partial");
    expect(unshaped.cashOverlaySince).toBe(NOW);

    // v-shaped ⇒ the one diverging state.
    const { alert: v } = assembleRun({ ...base, fallShape: mkVerdict("v-shaped") });
    expect(v.cashOverlay).toBe("off");
    expect(v.cashOverlaySince).toBeNull();
    expect(v.cashOverlayReason).toMatch(/v-shaped fall - early overlay suppressed/);
    // ...and the ladder is untouched by the suppression (the orthogonality invariant).
    expect(v.level).toBe(unshaped.level);
    expect(v.bandReason).toBe(unshaped.bandReason);
    expect(v.dialBand).toBe(unshaped.dialBand);
    expect(v.heldSleeve).toBe(unshaped.heldSleeve);
    expect(v.dialTargetRung).toBe(unshaped.dialTargetRung);

    // bear + indeterminate ⇒ today's behaviour, field-for-field.
    for (const shape of ["bear", "indeterminate"] as const) {
      const { alert } = assembleRun({ ...base, fallShape: mkVerdict(shape) });
      expect(alert.cashOverlay).toBe(unshaped.cashOverlay);
      expect(alert.cashOverlaySince).toBe(unshaped.cashOverlaySince);
      expect(alert.cashOverlayReason).toBe(unshaped.cashOverlayReason);
    }
  });

  // ─── W5-a FIX-1 Stage 1.3: the cron path supplies the real N-row window ────────────────────
  // Deliberately NOT a contiguous in-memory walk: `scripts/probe-cash-overlay.ts` folds state
  // contiguously and therefore never reproduced the prod symptom (one persisted prior ⇒ a rise
  // spread over CASH_ACCEL_WINDOW closes can never fire live).

  // T-B — the prod symptom, end to end. Live prod prints "no acceleration (+0 over 1 closes)"
  // because the cron path never supplied `recentAlerts`; window LENGTH is the one thing the
  // reason string exposes end to end, so this is the assertion that goes red on a regression.
  test("assembleRun with recentAlerts reports the FULL window length in cashOverlayReason", () => {
    const flat = 2;
    const recentAlerts = [
      priorAlert({ date: "2026-07-17", firedAt: "2026-07-17T21:00:00.000Z", dialTargetRung: flat }),
      priorAlert({ date: "2026-07-16", firedAt: "2026-07-16T21:00:00.000Z", dialTargetRung: flat }),
    ];
    const dial = makeDial({ targetRung: flat });

    const { alert } = assembleRun({ readings: [], last: null, lastPush: null, now: NOW, dial, recentAlerts });

    expect(alert.cashOverlay).toBe("off"); // flat rungs: no acceleration...
    // ...but over the FULL window, not one prior. `1 closes` here is the shipped prod bug.
    expect(alert.cashOverlayReason).toMatch(new RegExp(`${CASH_ACCEL_WINDOW} closes`));
  });

  // T-C — the accept path the 1-prior code could NOT reach: a rise of CASH_ACCEL_RUNGS spread
  // across CASH_ACCEL_WINDOW closes. Fixture derived from the symbols, never a literal.
  test("a rise spread across the whole window fires - and does NOT with the old 1-prior seed", () => {
    const BASE = 2;
    // Priors climb one rung short of the trigger; today's close completes it.
    const older = priorAlert({ date: "2026-07-16", firedAt: "2026-07-16T21:00:00.000Z", dialTargetRung: BASE });
    const newer = priorAlert({
      date: "2026-07-17",
      firedAt: "2026-07-17T21:00:00.000Z",
      dialTargetRung: BASE + CASH_ACCEL_RUNGS - 1,
    });
    const dial = makeDial({ targetRung: BASE + CASH_ACCEL_RUNGS });
    const base = { readings: [] as Reading[], last: null, lastPush: null, now: NOW, dial };

    // WITH the N-row window: trough = BASE ⇒ rise = CASH_ACCEL_RUNGS ⇒ fires.
    const { alert: wide } = assembleRun({ ...base, recentAlerts: [newer, older] });
    expect(wide.cashOverlay).toBe("partial");

    // Vacuity guard — the identical rungs through the OLD single-prior seed: trough is the
    // NEWER prior, so rise = 1 and the trigger stays off. This pair is what proves the fix
    // WIDENS the trigger rather than no-op-ping.
    const { alert: narrow } = assembleRun({ ...base, prevDay: newer });
    expect(narrow.cashOverlay).toBe("off");
  });

  // W5-b Stage 5.1 — the OTHER half of the hoist's wire: `runScoringCycle` computes the exposure
  // before this call and hands its POSTURE in via the opt (R8 Stage 1 renamed it from `equityPct`,
  // so the compound floor derives the weight here rather than trusting a second input), which must
  // reach buildNotification's cash line. The cycle tests above pin the VALUE; this pins the THREAD.
  test("the exposurePosture opt sizes the pushed cash-overlay line; absent ⇒ 'not yet sized'", () => {
    const BASE = 2;
    const at = (date: string, rung: number) =>
      priorAlert({ date, firedAt: `${date}T21:00:00.000Z`, dialTargetRung: rung });
    const dial = makeDial({ targetRung: BASE + CASH_ACCEL_RUNGS });
    const rising = [at("2026-07-17", BASE + CASH_ACCEL_RUNGS - 1), at("2026-07-16", BASE)];
    const base = { readings: [] as Reading[], last: null, lastPush: null, now: NOW, dial, recentAlerts: rising };

    // Rung-blind fixture (no globalFamilies ⇒ no held sleeve), so the floor cannot bind and the
    // weight is exactly `EQUITY_PCT[posture]` — the thread, not the bound, is what this pins.
    const sized = assembleRun({ ...base, exposurePosture: "Reduced" });
    const unsized = assembleRun({ ...base });

    // The magnitude itself is `resolveCash`'s to derive (re-deriving it here would make this test
    // a second source for it); what this pins is that a number arrives at all when the opt does.
    // The `(?:fully invested — )?` prefix is E10b's zero-size wording (notify_format.ts): a 0% size
    // says so in words. Optional here so the pin survives whichever posture the fixture resolves to.
    expect(sized.notification.message.body).toMatch(
      /Cash overlay: partial - heads-up only, (?:fully invested - )?\d+% cash/,
    );
    expect(unsized.notification.message.body).toContain("not yet sized");
  });
});

// W5-b Stage 5.1 — the exposure fetch + `computeExposure` were HOISTED above the notify/alert
// assembly so the band push can carry THIS close's equity weight. The boundary these tests pin:
// the hoisted, run-seeded value is byte-equal to what the retired post-`recordRun` `getSeries`
// path computed. Every assertion below compares the run's OWN emitted exposure (its transcript
// line, written from the hoisted value) against a recomputation over the store AFTER persist.
describe("runScoringCycle - W5-b Stage 5.1 exposure hoist (seed-from-this-run)", () => {
  // ARM needs ARM_MIN_OBS(252) F1 points; seed a rising-but-not-flat history so the rank is
  // defined (a perfectly flat window degrades by design) and the run's own close is the head.
  const f1History = (n: number): StoredReading[] =>
    Array.from({ length: n }, (_, i) => ({
      date: new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      indicatorId: "F1",
      value: 1 + i * 0.001,
      delta20: 0,
      rawState: "GREEN" as const,
      state: "GREEN" as const,
      decision: null,
    }));
  // The run's own transcript line, written from the HOISTED value — the only observable of what
  // the notify path was handed.
  const exposureLine = (): string | undefined =>
    vi.mocked(console.log).mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("Exposure: "));
  // The retired path, verbatim: read the store AFTER recordRun and compute from that.
  const postPersistExposure = async () =>
    computeExposure(
      await store.getSeries("F1", EXPOSURE_F1_LIMIT),
      await store.getSeries("GT", EXPOSURE_GT_LIMIT),
    );
  // fakeFeeds' calm prices/EBP; only F1's FRED leg (BAMLH0A0HYM2) is re-pointed.
  const withF1 = (value: number): FakeFeeds =>
    fakeFeeds({ fetchSeries: async (series) => (series === "BAMLH0A0HYM2" ? fredFlat(value) : fredMock(series)) });
  // The RED arm of the same seam: a STEP to `head` rather than a flat level, because F1 Red is an
  // AND over its level and velocity legs since 2026-08-06. The head
  // close is identical to the flat fixture it replaces, so the exposure rank/ROC this suite reads off
  // the STORE (seeded history + this run's head) is untouched — only F1's own state changes.
  const withF1Red = (head: number): FakeFeeds =>
    fakeFeeds({ fetchSeries: async (series) => (series === "BAMLH0A0HYM2" ? f1RedBothLegs(head) : fredMock(series)) });
  /** The cron's prints-only F1 exposure read (`getPrintSeries` over-reads by the carry span) fails; every other read is real. */
  class ExposureF1ReadFailStore extends InMemoryStore {
    override async getSeries(id: string, limit: number, range?: SeriesRange): Promise<SeriesPoint[]> {
      if (id === "F1" && limit === EXPOSURE_F1_LIMIT + NOWCAST_MAX_CARRY_DAYS + 1) throw new Error("store read failed");
      return super.getSeries(id, limit, range);
    }
  }

  test("seeded pre-persist exposure === post-persist getSeries exposure (THIS run's close), and it reaches the PUSH: the cash-overlay line is sized", async () => {
    await store.recordReadings(f1History(300), "2025-12-31T00:00:00.000Z");
    // Two fresh priors parked at rung 1 arm the overlay's acceleration window: this run's dial
    // (F1 confirmed RED ⇒ CRITICAL) sits far above rung 1 + CASH_ACCEL_RUNGS, so the overlay
    // resolves `partial` and buildNotification renders its sized line.
    for (const date of ["2026-01-28", "2026-01-29"]) {
      await store.recordAlert(priorAlert({ date, firedAt: `${date}T21:00:00.000Z`, dialTargetRung: 1 }));
    }
    const feeds = withF1Red(7); // 7.0 tops the seeded 1.0–1.3 history ⇒ rank 1.0 ≥ ARM_LEVEL_PCT ⇒ armed

    const notify = fakeNotify();
    const alert = await runCycleWith(feeds, store, monotonicClock("2026-02-01T00:00:00.000Z"), { notify });
    const post = await postPersistExposure();

    // Vacuity guard: the posture is one ONLY this run's own F1 close can produce — the seeded
    // history alone ends at 1.299 with a NEGATIVE 30d ROC, which arms nothing.
    expect(post.posture).toBe("Reduced");
    expect(post.equityPct).toBe(EQUITY_PCT.Reduced);
    // The boundary: what the hoisted path emitted is byte-equal to the post-persist recomputation.
    expect(exposureLine()).toBe(`Exposure: ${post.posture} - ${post.summary}`);
    expect(alert.level).toBe("CRITICAL"); // the band push still fires, unchanged by the hoist
    expect(alert.cashOverlay).toBe("partial"); // vacuity guard: the sized line is reachable at all
    const body = notify.pushNtfy.mock.calls.at(-1)?.[0]?.body ?? "";
    // The magnitude is `resolveCash`'s to derive; what this pins is that the run's OWN computed
    // equityPct reached `buildNotification` — a null there renders "not yet sized" instead.
    // `(?:fully invested — )?` — E10b's zero-size wording; `equityPct` here is run-computed, so the
    // Full posture (0% cash) is reachable and must not red this pin for a copy reason.
    expect(body).toMatch(/Cash overlay: partial - heads-up only, (?:fully invested - )?\d+% cash/);
  });

  test("degraded exposure read: the band push STILL fires unsized and the outage is a degrade event ([USER] ruling 3)", async () => {
    const failing = new ExposureF1ReadFailStore();
    seedHyoasCalib(failing);
    await failing.recordReadings(f1History(300), "2025-12-31T00:00:00.000Z");

    // A genuine CRITICAL (F1 RED), so a band push is warranted.
    const notify = fakeNotify();
    const alert = await runCycleWith(withF1Red(7), failing, monotonicClock("2026-02-01T00:00:00.000Z"), { notify });

    // The danger band is orthogonal to exposure (§4.3.1): it still fires.
    expect(alert.level).toBe("CRITICAL");
    expect(alert.pushedAt).toBe(alert.firedAt);
    expect(notify.pushNtfy).toHaveBeenCalled();
    // Exposure went silent — no computed value, so no exposure transcript line and no push.
    expect(exposureLine()).toBeUndefined();
    // ...and the outage reached the PERSISTED trace, which only works because the hoist sits
    // above drainDegradeLog(). Below it, this event would never persist (console.error only).
    expect((alert.degraded ?? []).map((e) => e.scope)).toContain("[exposure] non-live - F1/GT history unavailable");
    expect(((await failing.getLastAlert())?.degraded ?? []).map((e) => e.scope)).toContain(
      "[exposure] non-live - F1/GT history unavailable",
    );
  });

  // The GT call site's real limit is 10, so its overflow regime is reachable without a 545-row
  // fixture — pinned directly on the seam, with the same exported constant production passes.
  test("seedSeriesWithRun re-applies the limit: GT's 10-point bound survives the run-row merge", () => {
    const stored = Array.from({ length: EXPOSURE_GT_LIMIT + 4 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      value: i,
      delta20: 0,
      rawState: "GREEN" as const,
      state: "GREEN" as const,
      decision: null,
    }));
    const runRow: StoredReading = { ...stored[stored.length - 1]!, date: "2026-02-01", indicatorId: "GT", value: 99 };
    const seeded = seedSeriesWithRun(stored, [runRow], "GT", EXPOSURE_GT_LIMIT);

    expect(seeded.length).toBe(EXPOSURE_GT_LIMIT); // 11 without the re-slice
    expect(seeded[seeded.length - 1]?.date).toBe("2026-02-01"); // this run's row is the head
    expect(seeded[0]?.date).toBe("2026-01-06"); // ...and the 5 OLDEST stored points are dropped
    expect(seeded.some((p) => "indicatorId" in p)).toBe(false); // ruling 2: the projection drops it
  });

  test("seedSeriesWithRun keeps a stored final over this run's estimate, and seeds an estimate onto an open date (E7)", () => {
    const final = { date: "2026-01-02", value: 1, delta20: 0, rawState: "GREEN" as const, state: "GREEN" as const, decision: null };
    const est = (date: string): StoredReading => ({ ...final, date, indicatorId: "GT", value: 50, estimated: true });
    const seeded = seedSeriesWithRun([final], [est("2026-01-02"), est("2026-01-03")], "GT", EXPOSURE_GT_LIMIT);
    expect(seeded.map((p) => [p.date, p.value, p.estimated])).toEqual([
      ["2026-01-02", 1, undefined],
      ["2026-01-03", 50, true],
    ]);
  });

  test("seedSeriesWithRun: this run's row wins its date on an intraday re-run (one point per date); a run without the id adds nothing", () => {
    const pt = (date: string, value: number) => ({ date, value, delta20: 0, rawState: "GREEN" as const, state: "GREEN" as const, decision: null });
    const stored = [pt("2026-01-01", 1), pt("2026-01-02", 1.05)];
    const rerun: StoredReading = { ...pt("2026-01-02", 7), indicatorId: "F1" };
    expect(seedSeriesWithRun(stored, [rerun], "F1", EXPOSURE_F1_LIMIT).map((p) => [p.date, p.value])).toEqual([["2026-01-01", 1], ["2026-01-02", 7]]);
    expect(seedSeriesWithRun(stored, [{ ...rerun, indicatorId: "GT" }], "F1", EXPOSURE_F1_LIMIT)).toEqual(stored);
  });

  /**
   * R8 Stage 2.2 — the CALL-SITE wiring of the push bind. Every other pin on this seam exercises
   * `exposurePushPair` directly, so passing `null` rows here — behaviourally the pre-fix RAW
   * comparator, restoring R1(i)/(ii)/(iii) — left the whole suite green. These drive
   * `runScoringCycle` end to end and read the ntfy title the phone would show.
   */
  describe("the exposure PUSH carries the bounded postures (call-site wiring)", () => {
    const exposureTitle = (notify: FakeNotify): string | undefined =>
      notify.pushNtfy.mock.calls
        .map((c) => String(c[0]?.title ?? ""))
        .find((t) => t.startsWith("Exposure: "));

    /**
     * F1 history whose OWN tail arms ARM (rank ~1.0 with a 30d ROC far past `ARM_ROC_BP`), so the
     * seeded PRIOR state can carry the SAME raw posture as this run computes. Only the bind can then
     * separate the two sides, which is what makes the pushed title evidence about the bind rather
     * than about the market state.
     */
    const f1ArmedTail = (n: number): StoredReading[] =>
      f1History(n).map((r, i) => (i >= n - 3 ? { ...r, value: 7 } : r));
    /** Two GT closes clear of the cut: FIRE quiet, and — crucially — non-degraded after the drop. */
    const gtClear = (): StoredReading[] =>
      ["2026-01-28", "2026-01-29"].map((date) => ({
        date,
        indicatorId: "GT",
        value: 100,
        delta20: 0,
        rawState: "GREEN" as const,
        state: "GREEN" as const,
        decision: 5,
      }));
    /** The row the PREVIOUS run left behind. Rung 9 (`LADDER[8]`) with the overlay FIRED: the floor
     *  lifts its `Reduced` to `Full`, and the step-down then takes that `Full` to `Core` — a move on
     *  the SERVED variable alone. Its `exposureState` is what this run compares against. */
    const priorRow = (exposureState: AlertRecord["exposureState"] = null) =>
      priorAlert({
        date: "2026-01-30",
        firedAt: "2026-01-30T21:00:00.000Z",
        heldSleeve: LADDER[8],
        cashOverlay: "partial",
        exposureState,
      });
    /** The production COMPOSITION (floor → published level → step-down), re-stated off a persisted
     *  row — never a call into `exposurePushPair`, whose wiring is what is under test here. Every
     *  expectation is derived from the shipped resolvers, none typed. */
    const bind = (posture: ReturnType<typeof computeExposure>["posture"], row: AlertRecord) => {
      const rung = families.rungOfSleeve(row.heldSleeve);
      const floored = exposureMod.resolveCompoundFloor(posture, rung);
      const level = resolvePersistedCashLevel(row.r4Phase, row.cashOverlay, floored.equityPct);
      return { rung, floored, stepped: exposureMod.resolveOverlayStepDown(floored.posture, level) };
    };
    /** This run's raw exposure, off the SAME seeded series the cycle will read. */
    const rawFromStore = async () =>
      computeExposure(
        await store.getSeries("F1", EXPOSURE_F1_LIMIT),
        await store.getSeries("GT", EXPOSURE_GT_LIMIT),
      );
    /** The prior run's persisted state, bound at rung 9 with the overlay fired — the exact shape
     *  `run-cycle.ts` stamps, built here from the SAME raw posture this run will compute, so the raw
     *  axis is silent and only the bind can separate the two sides. */
    const seedAll = async (withPriorState = true) => {
      await store.recordReadings(f1ArmedTail(300), "2025-12-31T00:00:00.000Z");
      await store.recordReadings(gtClear(), "2026-01-29T21:00:00.000Z");
      const raw = await rawFromStore();
      const priorBind = bind(raw.posture, priorRow());
      await store.recordAlert(
        priorRow(
          withPriorState && raw.posture !== null && priorBind.stepped.posture !== null
            ? {
                posture: priorBind.stepped.posture,
                rawPosture: raw.posture,
                rungBlind: false,
                arm: { armed: raw.arm.armed, approaching: raw.arm.approaching },
                fire: { fired: raw.fire.fired, approaching: raw.fire.approaching },
              }
            : null,
        ),
      );
      return { raw, priorBind, feeds: withF1(7) };
    };

    /**
     * THE REPEAT-PUSH FIX (2026-08-09), end to end. Prod re-sent the identical
     * `Exposure: Core -> Full` on every cron for two days: the retired `derivePreviousExposure` prior
     * re-derived "yesterday" off the same two series on every run, so a transition sitting on the
     * newest close never aged out of the comparison — and F1/GT print nothing over a weekend.
     * A same-day re-run must now be SILENT. The pre-fix code pushed on both runs below.
     */
    test("the pushed title is the BOUNDED pair (a served-variable move the raw comparator cannot see), and it fires ONCE - a same-day re-run is silent", async () => {
      const { raw, priorBind, feeds } = await seedAll();
      const clock = monotonicClock("2026-02-01T00:00:00.000Z");

      const notify = fakeNotify();
      const first = await runCycleWith(feeds, store, clock, { notify });
      const curr = bind(raw.posture, first);

      // Non-vacuity: both sides carry a rung (a rung-blind side drops BOTH back to the raw axis),
      // the two RAW postures are IDENTICAL — so the un-wired call site pushes nothing at all on this
      // close — and the bind really did separate them.
      expect(curr.rung).not.toBeNull();
      expect(priorBind.rung).not.toBeNull();
      expect(priorBind.floored.floorApplied).toBe(true);
      expect(priorBind.stepped.steppedDown).toBe(true);
      expect(priorBind.stepped.posture).not.toBe(curr.stepped.posture);
      expect(exposureTitle(notify)).toBe(`Exposure: ${priorBind.stepped.posture} -> ${curr.stepped.posture}`);

      notify.pushNtfy.mockClear();
      const second = await runCycleWith(feeds, store, clock, { notify });
      expect(second.date).toBe(first.date); // vacuity guard: it really is a same-day re-run
      expect(exposureTitle(notify)).toBeUndefined();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// W5-d Stage 3.1 — the V-vs-bear class is COMPUTED AND PERSISTED. That it steers nothing in the
// LADDER is pinned on `assembleRun` ("a v-shaped fall SUPPRESSES a firing cash overlay").
// ─────────────────────────────────────────────────────────────────────────────
describe("runScoringCycle - W5-d fall shape is computed and persisted (Stage 3.1)", () => {
  // A V: flat at 100 (so the trailing peak sits at index 240, NOT index 0 ⇒ `peakClipped` false —
  // a clipped peak would be routed to `indeterminate` and this fixture would pin nothing), then a
  // 20% fall over 19 closes. dd −0.20 ≤ V_MIN_DRAWDOWN; velocity −0.0105 ≤ V_VELOCITY_CUT.
  const acwiVShape = (): Observation[] =>
    Array.from({ length: 260 }, (_, i) => ({
      date: new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      value: i <= 240 ? 100 : 100 - 20 * ((i - 240) / 19),
    }));

  // `state: "GREEN"` ⇒ tailRedRun 0 ⇒ dwell 0, i.e. NOT grinding — the `fast && !grinding` row.
  const creditRows = (id: string, n: number): StoredReading[] =>
    Array.from({ length: n }, (_, i) => ({
      date: new Date(Date.UTC(2023, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      indicatorId: id,
      value: 1,
      delta20: 0,
      rawState: "GREEN" as const,
      state: "GREEN" as const,
      decision: null,
    }));

  const runWithCreditDepth = async (f2Depth: number): Promise<AlertRecord> => {
    await store.recordReadings(creditRows("F1", V_BEAR_F_LIMIT), "2023-06-01T21:00:00.000Z");
    await store.recordReadings(creditRows("F2", f2Depth), "2023-06-01T21:00:00.000Z");
    const feeds = fakeFeeds({ fetchDailyCloses: async (symbol) => (symbol === "ACWI" ? acwiVShape() : priceCalm(symbol)) });
    return runCycleWith(feeds, store, monotonicClock("2026-06-25T21:00:00.000Z"));
  };

  test("a crafted V classifies as v-shaped, reached via both fold measures", async () => {
    const vshaped = await runWithCreditDepth(V_BEAR_F_LIMIT);
    expect(vshaped.fallShape).toBe("v-shaped");
    expect(vshaped.creditDwellCloses).toBe(0);
    expect(vshaped.fallVelocity).not.toBeNull();
    expect(vshaped.fallVelocity!).toBeLessThanOrEqual(V_VELOCITY_CUT);
  });
});
