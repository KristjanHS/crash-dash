import { expect, test, describe } from "vitest";
import { readFileSync } from "node:fs";
import {
  deriveConfirmedState,
  confirmedStateSeries,
  asymConfirmedStateSeries,
} from "./domain-fold.js";
import {
  scoreIndicator,
  indicatorReadingSeries,
  indicatorLegSeries,
  buildReadings,
  stampFreshness,
  scoreOil,
  oilReadingSeries,
  mean,
} from "./scorers-core.js";
import {
  scoreSemis,
  semisReadingSeries,
  scoreBreadth,
  breadthReadingSeries,
  nvdaGateReadingSeries,
} from "./scorers-price.js";
import { NVDA } from "./registry-price.js";
import {
  MA_WINDOW,
  HIGH_WINDOW,
  G1_AMBER_RET,
  G1_RED_RET,
} from "./family-descriptor-rows.js";
import {
  VELOCITY_WINDOW,
  CONFIRM_CLOSES,
  type Indicator,
  type Observation,
  type Reading,
  type State,
} from "./domain-types.js";
import { G1 } from "./registry-geo.js";
import { breadthConfig } from "./scorers-price.js";
import { confirmClosesFor } from "./families.js";
import { combineLevelVelocity } from "./scorers-core.js";
import { G1_DESCRIPTOR } from "./family-descriptor-rows.js";
import { verdictHoldLegs } from "./alert-band.js";
import { lagCutFor } from "./ladder.js";
import { feedCalendarTodayResolver } from "./dates.js";
import { SLOT_TODAY, slotsOld, stampWithPeers } from "./lag-fixture.test-helpers.js";
import { readdirSync } from "node:fs";
import { FOLD_BY_SITE } from "./domain-fold.js";
import { CONFIRM_TIERS, DASHBOARD_FAMILIES } from "./families.js";
import { scoreBottom } from "./bottom.js";
import { type PensionBand, pensionConfirmBand } from "./pension.js";
import { SLOW_CALM_RUN_MIN, scoreDurationOfCalm } from "./slow.js";
import { DANGER_CUTS, confirmedRegime, type PillarPair } from "./danger-engine.js";
import { rawSeriesConfirmedByDate } from "../scripts/backtest/replay.js";
import type { TermPoint } from "./vix_term.js";
import { N, ramp, indicator, PN, priceSeries, f4, f5, BN, breadthClimb } from "./dashboard.test-helpers.js";

describe("deriveConfirmedState (2-close buffer)", () => {
  // Speed-tiered confirmation (L1 Stage 4): the fast tiers rely on closes ≤ 1 degenerating
  // to the identity fold — pin both so a fold rewrite can't silently break the vol tier.
  test("closes=0 and closes=1 both return the raw states (identity fold)", () => {
    const raw: State[] = ["GREEN", "RED", "GREEN", "AMBER", "RED"];
    expect(confirmedStateSeries(raw, 0)).toEqual(raw);
    expect(confirmedStateSeries(raw, 1)).toEqual(raw);
  });
});

// --- asymConfirmedStateSeries — THE indicator-tier fold (2026-08-26 directional ruling) ------
// Depth is DERIVED from the answer key, never a bare literal: the DOWN buffer is
// `FOLD_BY_SITE.indicator.closes`; escalation is instant by construction.
describe("asymConfirmedStateSeries (instant-up / buffered-down)", () => {
  const DOWN = FOLD_BY_SITE.indicator.closes;

  test("a worse raw state escalates SAME-DAY (GREEN→RED on one close)", () => {
    expect(asymConfirmedStateSeries(["GREEN", "GREEN", "RED"], DOWN)).toEqual([
      "GREEN", "GREEN", "RED",
    ]);
  });

  test("one clean close does NOT stand down; exactly DOWN consecutive do", () => {
    // RED confirmed, then a GREEN run: held RED through DOWN−1 clean closes, GREEN at DOWN.
    const raw: State[] = ["RED", ...Array.from({ length: DOWN }, (): State => "GREEN")];
    const out = asymConfirmedStateSeries(raw, DOWN);
    expect(out.slice(0, DOWN)).toEqual(Array.from({ length: DOWN }, () => "RED"));
    expect(out.at(-1)).toBe("GREEN");
  });

  test("mixed improved labels never accumulate a stand-down run", () => {
    // Confirmed RED, raw then alternates AMBER,GREEN — stays RED until DOWN consecutive of ONE
    // improved label; the trailing AMBER,AMBER pair is what finally stands down (to AMBER).
    expect(asymConfirmedStateSeries(["RED", "AMBER", "GREEN", "AMBER", "GREEN"], DOWN)).toEqual([
      "RED", "RED", "RED", "RED", "RED",
    ]);
    expect(
      asymConfirmedStateSeries(["RED", "AMBER", "GREEN", "AMBER", "AMBER"], DOWN).at(-1),
    ).toBe("AMBER");
  });

  test("downCloses <= 1 degenerates to the identity", () => {
    const raw: State[] = ["GREEN", "RED", "GREEN", "AMBER"];
    expect(asymConfirmedStateSeries(raw, 1)).toEqual(raw);
    expect(asymConfirmedStateSeries(raw, 0)).toEqual(raw);
  });

  test("bootstrap (rawStates[0]) washes out over a long history", () => {
    // A RED bootstrap on an otherwise-clean series stands down after DOWN closes and never
    // returns — the latest confirmed state is independent of where the window starts.
    const raw: State[] = ["RED", ...Array.from({ length: 10 }, (): State => "GREEN")];
    expect(asymConfirmedStateSeries(raw, DOWN).at(-1)).toBe("GREEN");
    expect(asymConfirmedStateSeries(raw.slice(1), DOWN).at(-1)).toBe("GREEN");
  });

  test("throws on empty history", () => {
    expect(() => asymConfirmedStateSeries([], DOWN)).toThrow(/empty history/);
  });
});

// --- Derived scorer characterization (S2 refactor) -------------------------
// Lock the generic derived path (derivedValue + classifyDerived + buildReadings,
// driving oil + NVDA off each indicator's `derived` descriptor) against the
// PRE-refactor bespoke loops, byte-for-byte over the FULL per-day series. The
// reference re-implements the old oilReadingSeries / nvdaGateReadingSeries inline
// so a polarity, window-offset, or base-guard regression in the generic code fails
// here even when the scalar spot-checks above still pass.
describe("derived scorers ≡ pre-refactor loops (full per-day series) - S2", () => {
  const refOil = (obs: Observation[]): Reading[] => {
    const raw: State[] = [];
    for (let i = VELOCITY_WINDOW; i < obs.length; i++) {
      const base = obs[i - VELOCITY_WINDOW]!.value;
      const r = base > 0 ? obs[i]!.value / base - 1 : 0; // non-positive base → no shock (GREEN)
      const velocity: State = r >= G1_RED_RET ? "RED" : r >= G1_AMBER_RET ? "AMBER" : "GREEN";
      // The level leg cannot resolve on this 80-obs fixture (underrun ⇒ GREEN, `levelGateState`),
      // so the combined raw state is the descriptor's join of a GREEN level with the velocity read.
      raw.push(combineLevelVelocity(G1_DESCRIPTOR.combine, "GREEN", velocity));
    }
    if (raw.length === 0) return [];
    // The INDICATOR tier's own DIRECTIONAL fold at G1's tier (`asymConfirmedStateSeries`,
    // 2026-08-26) — the same primitive `buildReadings` folds through, so the ref
    // characterizes polarity / window-offset / base-guard, not a divergent buffer.
    const confirmed = asymConfirmedStateSeries(raw, confirmClosesFor(G1.id));
    return raw.map((rs, k) => {
      const i = k + VELOCITY_WINDOW;
      const base = obs[i - VELOCITY_WINDOW]!.value;
      return {
        indicator: G1,
        date: obs[i]!.date,
        level: obs[i]!.value,
        delta20: obs[i]!.value - obs[i - VELOCITY_WINDOW]!.value,
        rawState: rs,
        state: confirmed[k]!,
        // decision = the SAME 20d return the state is scored on (null on a non-positive base).
        decision: base > 0 && Number.isFinite(base) ? obs[i]!.value / base - 1 : null,
      };
    });
  };

  const refNvda = (obs: Observation[]): Reading[] => {
    const v = obs.map((o) => o.value);
    const out: Reading[] = [];
    for (let i = MA_WINDOW - 1; i < v.length; i++) {
      const ma = mean(v, i - MA_WINDOW + 1, i);
      // INCLUSIVE `<=`, tracking `classifyDerived`'s LOW branch since row 18
      //: a close sitting EXACTLY on its MA200 is AMBER, not
      // GREEN (NVDA's amber cut is 0, so `close === ma` ⇔ `maSpread === amber`). The tie-day
      // test below is what actually reaches this boundary — the sine fixture never does.
      const state: State = v[i]! <= ma ? "AMBER" : "GREEN"; // raw === confirmed (no buffer)
      out.push({
        indicator: NVDA,
        date: obs[i]!.date,
        level: v[i]!,
        delta20: v[i]! - v[i - VELOCITY_WINDOW]!,
        rawState: state,
        state,
        // decision = the SAME MA200 spread the gate scores on (null on a non-positive MA base).
        decision: ma > 0 && Number.isFinite(ma) ? v[i]! / ma - 1 : null,
      });
    }
    return out;
  };

  test("oil: oilReadingSeries ≡ old loop over a wavy series crossing +20/+40% + a negative-base day", () => {
    const obs = Array.from({ length: 80 }, (_, i) => ({
      date: `oil-${String(i).padStart(3, "0")}`,
      value: i === 40 ? -5 : 70 + 25 * Math.sin(i / 5) + (i > 55 ? (i - 55) * 2 : 0),
    }));
    expect(oilReadingSeries(G1, obs)).toEqual(refOil(obs));
  });

  test("NVDA: nvdaGateReadingSeries ≡ old gate loop over a series crossing its MA200 repeatedly", () => {
    const obs = Array.from({ length: 320 }, (_, i) => ({
      date: `nvda-${String(i).padStart(4, "0")}`,
      value: 100 + 30 * Math.sin(i / 23),
    }));
    expect(nvdaGateReadingSeries(NVDA, obs)).toEqual(refNvda(obs));
  });

  test("NVDA: a close sitting EXACTLY on its MA200 is AMBER (the row-18 inclusive boundary)", () => {
    // The sine fixture above never lands on its own trailing mean, so it cannot reach the
    // `<` vs `<=` boundary at all. This fixture does, exactly: a 60-day wiggle followed by a
    // FLAT run at 100. Once the whole 200-day window lies inside the flat run the mean is
    // 100 exactly (200 additions of an integer-valued double, then a power-of-nothing divide
    // that still lands on 100), so `level === ma` and the maSpread decision variable is 0 —
    // NVDA's amber cut. Under the pre-row-18 strict `<` these days read GREEN.
    const obs = Array.from({ length: 320 }, (_, i) => ({
      date: `nvdatie-${String(i).padStart(4, "0")}`,
      value: i < 60 ? 100 + 10 * Math.sin(i / 7) : 100,
    }));
    const series = nvdaGateReadingSeries(NVDA, obs);
    expect(series).toEqual(refNvda(obs));

    // Vacuity guard: the fixture must actually REACH the tie, or the assertion below pins
    // nothing. A tie day is one whose decision (close/MA200 − 1) is exactly 0.
    const ties = series.filter((r) => r.decision === 0);
    expect(ties.length).toBeGreaterThan(0);
    for (const r of ties) expect(r.state, `${r.date} sits ON its MA200`).toBe("AMBER");
  });
});

// --- Series-as-primitive refactor (backfill design §3/§4) ------------------
// The per-day confirmed-state series is the primitive; every scalar scorer is
// its last element. These lock the two contracts that keep them from drifting:
// (1) confirmedStateSeries.at(-1) ≡ the legacy scalar fold; (2) scoreX ≡
// xReadingSeries(...).at(-1). Plus series shape + that the buffer (NOT NVDA's
// raw=confirmed shortcut) is applied to every non-NVDA series.
describe("confirmedStateSeries (running 2-close fold) - characterization", () => {
  // Independent re-implementation of the PRE-refactor deriveConfirmedState loop.
  // The property below asserts confirmedStateSeries.at(-1) still equals THIS, so
  // a future edit to the fold can't silently change the live scalar.
  const legacyDerive = (rawStates: State[], closes: number): State => {
    let confirmed = rawStates[0]!;
    for (let i = closes - 1; i < rawStates.length; i++) {
      const candidate = rawStates[i]!;
      if (candidate === confirmed) continue;
      let held = true;
      for (let j = i - closes + 1; j <= i; j++) if (rawStates[j] !== candidate) { held = false; break; }
      if (held) confirmed = candidate;
    }
    return confirmed;
  };

  test("per-day running fold: a 1-day spike never flips; 2 consecutive do", () => {
    expect(confirmedStateSeries(["GREEN", "RED", "GREEN", "RED", "RED"], 2)).toEqual([
      "GREEN", "GREEN", "GREEN", "GREEN", "RED",
    ]);
  });

  test("property: at(-1) ≡ legacy scalar fold over random raw-state arrays", () => {
    // Compare against legacyDerive (the independent pre-refactor fold), NOT
    // deriveConfirmedState — the latter now IS confirmedStateSeries(...).at(-1),
    // which would make this a tautology. legacyDerive makes it a real check.
    // Deterministic seeded LCG — no Math.random, reproducible failures.
    let seed = 0x2545f491;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const states: State[] = ["GREEN", "AMBER", "RED"];
    // Saturation: per depth, a draw whose fold HOLDS (last ≠ raw last) and one that FLIPPED off the
    // bootstrap (last ≠ raw first). All 4 are seen by draw 4 (measured 2026-10-18); stop past 200.
    const seen = new Set<string>();
    for (let t = 0; t < 600; t++) {
      if (t >= 200 && seen.size === 4) break;
      const len = 1 + Math.floor(rnd() * 40);
      const closes = 2 + Math.floor(rnd() * 2); // {2,3}
      const rs = Array.from({ length: len }, () => states[Math.floor(rnd() * 3)]!);
      const series = confirmedStateSeries(rs, closes);
      expect(series.length).toBe(len);
      expect(series.at(-1)).toBe(legacyDerive(rs, closes));
      if (series.at(-1) !== rs.at(-1)) seen.add(`held-${closes}`);
      if (series.at(-1) !== rs[0]) seen.add(`flipped-${closes}`);
    }
    expect([...seen].sort()).toEqual(["flipped-2", "flipped-3", "held-2", "held-3"]);
  });

  test("throws on empty history", () => {
    expect(() => confirmedStateSeries([], 2)).toThrow(/empty history/);
    expect(() => deriveConfirmedState([], 2)).toThrow(/empty history/);
  });
});

describe("*ReadingSeries - scalar ≡ last, shape, and buffer routing", () => {
  const r2 = indicator({ id: "R2", thresholds: { amberVelocity: 0.4, redVelocity: 0.7 } });

  test("indicatorReadingSeries: oldest→newest, length = n − VELOCITY_WINDOW, last ≡ scoreIndicator", () => {
    const obs = ramp(0.025); // length N, steady AMBER-velocity climb
    const series = indicatorReadingSeries(r2, obs);
    expect(series.length).toBe(N - VELOCITY_WINDOW);
    expect(series[0]!.date < series.at(-1)!.date).toBe(true);
    expect(series.at(-1)).toEqual(scoreIndicator(r2, obs));
  });

  // D3 Stage 2.0 regression: `indicatorReadingSeries` moved from `rawStateSeries` to
  // `scoredDaySeries`, which ALWAYS passes `attribution` and so unconditionally reached
  // `confirmedStateSeries` — and `confirmedSeries` THROWS on an empty array. A history shorter
  // than VELOCITY_WINDOW+1 yields zero scored days, so the extraction turned the old graceful
  // `[]` into an anonymous "confirmedSeries: empty history" with no indicator id, replacing the
  // informative downstream `latest()` error ("[R2] need 22 observations, got 5"). Nothing covered
  // this, which is why the refactor read as behaviour-preserving. Pin BOTH short shapes.
  test("indicatorReadingSeries below VELOCITY_WINDOW+1 returns [] - never throws 'empty history'", () => {
    for (const n of [0, 1, 5, VELOCITY_WINDOW, VELOCITY_WINDOW + 1]) {
      const obs: Observation[] = Array.from({ length: n }, (_, i) => ({
        date: `d${String(i).padStart(2, "0")}`,
        value: 0,
      }));
      // n ≤ VELOCITY_WINDOW ⇒ no scored day at all ⇒ []; n = VELOCITY_WINDOW+1 ⇒ exactly one.
      expect(() => indicatorReadingSeries(r2, obs)).not.toThrow();
      expect(indicatorReadingSeries(r2, obs).length).toBe(Math.max(0, n - VELOCITY_WINDOW));
    }
  });

  test("indicatorReadingSeries: instant-up on the spike close, 2-close stand-down after it", () => {
    // All-flat except one spike → exactly one AMBER raw day (its 20d Δ alone clears 0.4).
    const obs: Observation[] = Array.from({ length: 60 }, (_, i) => ({
      date: `d${String(i).padStart(2, "0")}`,
      value: i === 40 ? 0.5 : 0,
    }));
    const series = indicatorReadingSeries(r2, obs);
    expect(series.filter((r) => r.rawState === "AMBER")).toHaveLength(1); // vacuity guard
    const k = series.findIndex((r) => r.rawState === "AMBER");
    // Instant-up: the lone raw-AMBER close is confirmed AMBER the SAME day...
    expect(series[k]!.state).toBe("AMBER");
    // ...buffered-down: AMBER holds through the first clean close, stands down at the
    // FOLD_BY_SITE.indicator.closes-th — so exactly closes confirmed-AMBER days in total.
    expect(series.filter((r) => r.state === "AMBER")).toHaveLength(FOLD_BY_SITE.indicator.closes);
    expect(series[k + 1]!.state).toBe("AMBER");
    expect(series[k + FOLD_BY_SITE.indicator.closes]!.state).toBe("GREEN");
  });

  test("oilReadingSeries: length = n − VELOCITY_WINDOW, last ≡ scoreOil", () => {
    const obs = priceSeries((i) => 100 * Math.pow(1.02, i)); // steep climb → oil-shock RED tail
    const series = oilReadingSeries(G1, obs);
    expect(series.length).toBe(PN - VELOCITY_WINDOW);
    expect(series.at(-1)).toEqual(scoreOil(G1, obs));
  });

  test("semisReadingSeries: length = aligned − MA_WINDOW + 1, last ≡ scoreSemis", () => {
    const smh = priceSeries((i) => 100 * Math.pow(0.9975, i));
    const nvda = priceSeries((i) => 100 * Math.pow(0.998, i));
    const series = semisReadingSeries(f4, smh, nvda);
    expect(series.length).toBe(PN - MA_WINDOW + 1);
    expect(series[0]!.date < series.at(-1)!.date).toBe(true);
    expect(series.at(-1)).toEqual(scoreSemis(f4, smh, nvda));
  });

  test("breadthReadingSeries: length = aligned − HIGH_WINDOW + 1 − the unranked minObs head, last ≡ scoreBreadth", () => {
    // BN clears the dynamic-band rankable floor (HIGH_WINDOW + PCT_MIN_OBS + CONFIRM_CLOSES).
    const { qqq, qqqe } = breadthClimb(0.002);
    const series = breadthReadingSeries(f5, qqq, qqqe);
    expect(series.length).toBe(BN - HIGH_WINDOW + 1 - breadthConfig("F5").minObs);
    expect(series.at(-1)).toEqual(scoreBreadth(f5, qqq, qqqe));
  });
});

// D3 Stage 2.1 — the `legs` escape hatch on buildReadings. Same alignment contract as
// `decisions`: index-aligned to rawStates, NOT to values/dates. In-memory only (never
// persisted — readingRow maps column-by-column via READINGS_COLS).
describe("buildReadings - the optional `legs` alignment contract", () => {
  const r2 = indicator({ id: "R2", thresholds: { amberVelocity: 0.4, redVelocity: 0.7 } });
  const OFF = VELOCITY_WINDOW;
  const values = Array.from({ length: OFF + 3 }, (_, i) => i);
  const dates = Array.from({ length: OFF + 3 }, (_, i) => `d${String(i).padStart(2, "0")}`);
  const rawStates: State[] = ["GREEN", "AMBER", "RED"];

  test("legs[k] lands on the Reading built from rawStates[k], NOT values/dates[k]", () => {
    const readings = buildReadings(r2, values, dates, rawStates, OFF, false, undefined, [
      undefined,
      "lvl:amber",
      "evt:red",
    ]);
    expect(readings.map((r) => r.leg)).toEqual([undefined, "lvl:amber", "evt:red"]);
    // The offset is the point: the leg tagged k=1 sits on the date at index OFF+1, so a
    // `legs`-aligned-to-dates implementation would put "lvl:amber" on d00 instead.
    expect(readings[1]!.date).toBe(dates[OFF + 1]);
    expect(readings[1]!.rawState).toBe("AMBER");
  });

  test("omitting `legs` leaves every `leg` undefined (nothing is recomputed here)", () => {
    const readings = buildReadings(r2, values, dates, rawStates, OFF, false);
    expect(readings.every((r) => r.leg === undefined)).toBe(true);
  });

  test("a short `legs` array leaves the uncovered tail undefined rather than throwing", () => {
    const readings = buildReadings(r2, values, dates, rawStates, OFF, false, undefined, ["lvl:amber"]);
    expect(readings.map((r) => r.leg)).toEqual(["lvl:amber", undefined, undefined]);
  });

  // OQ-5 Stage 5.1 — the freshness stamp `buildReadings` deliberately does NOT apply
  // (it holds no evaluation clock; a defaulted one would report a frozen feed fresh).
  test("buildReadings leaves ageDays/stale UNDEFINED - 'not assessed', never a false fresh", () => {
    const readings = buildReadings(r2, values, dates, rawStates, OFF, false);
    expect(readings.every((r) => r.ageDays === undefined && r.lag === undefined)).toBe(true);
  });

  test("indicatorReadingSeries stamps the SAME legs indicatorLegSeries serves at the read edge", () => {
    // The single-fold payoff: the cron-path Reading and the read-API DTO must not drift.
    const obs = ramp(0.025);
    const readings = indicatorReadingSeries(r2, obs);
    expect(readings.map((r) => r.leg)).toEqual(indicatorLegSeries(r2, obs));
    // Vacuity guard — the fixture must actually reach a firing regime, else this passes
    // on two all-undefined arrays.
    expect(readings.some((r) => r.leg !== undefined)).toBe(true);
  });
});

// OQ-5 Stage 5.1 — the reading-layer freshness stamp (S-4's computation half). The
// evaluation clock is PINNED here (never `new Date()`): a wall-clock fixture on a
// now-relative lag gate is a calendar time-bomb (.claude/rules/testing-project.md).
describe("stampFreshness - cadence-aware feed freshness on the Reading", () => {
  // ⚠ EVERY FIXTURE DATE HERE IS DERIVED FROM `lagCutFor`, NEVER TYPED (threshold single-touch-point):
  // `slotsOld(n)` is the date exactly `n` publication days before the pinned `SLOT_TODAY`, so moving
  // a cut in `LAG_THRESHOLDS` moves the fixture with it instead of rotting an expected number here.
  const DAILY_CUT = lagCutFor({ cadence: "daily" });
  const WEEKLY_CUT = lagCutFor({ cadence: "weekly" });
  const TODAY = SLOT_TODAY;
  const reading = (id: string, date: string, cadence?: Indicator["cadence"], lagAfterDays?: number): Reading => ({
    indicator: indicator({ id, cadence, lagAfterDays }),
    date,
    level: 0,
    delta20: 0,
    rawState: "GREEN",
    state: "GREEN",
  });

  // The fixtures below need the daily tier to bite STRICTLY INSIDE the weekly one, or the
  // discriminating pair degenerates and two broken arms agree. Asserted, not assumed.
  test("the fixture ladder actually separates the two daily/weekly cuts", () => {
    expect(DAILY_CUT).toBeLessThan(WEEKLY_CUT);
  });

  test("a long-dark DAILY reading stamps stale with its exact SLOT age, in slots", () => {
    // One publication day past the weekly cut is comfortably past the daily one. The unit is
    // asserted alongside the number: a `days`-stamped age here would be the two-unit defect
    // slice 3 exists to delete, and would read the SAME integer across a weekend-free window.
    const age = WEEKLY_CUT + 1;
    const [r] = stampWithPeers([reading("F1", slotsOld(age))], TODAY);
    expect(r!.ageDays).toBe(age);
    expect(r!.unit).toBe("slots");
    expect(r!.lag).toBe(true);
  });

  // SLOT vs CALENDAR, asserted rather than commented: the same observation is FEWER publication
  // slots old than it is calendar days old whenever the window spans a weekend. This is the line
  // that reds if the stamp ever falls back to `assessIndicatorFreshness` for a daily id.
  test("a daily age is counted in PUBLICATION slots, not calendar days", () => {
    const age = WEEKLY_CUT + 1;
    const asOf = slotsOld(age);
    const calendarDays = Math.round((Date.parse(`${TODAY}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000);
    const [r] = stampWithPeers([reading("F1", asOf)], TODAY);
    expect(r!.ageDays).toBe(age);
    expect(calendarDays).toBeGreaterThan(age); // the window spans a weekend - the fixture is not vacuous
  });

  test("the threshold comes from the indicator's OWN cadence, not one constant", () => {
    // The discriminating pair: identical age, opposite verdicts. A stamp that looked up
    // a single (daily) threshold instead of `r.indicator.cadence` reds on the weekly row —
    // this is the line the mutate-and-confirm-red demo flips. The age is the WEEKLY cut itself:
    // exactly at it (so weekly is fresh, `>` being strict) and far past the daily one.
    const [weekly, daily] = stampWithPeers(
      [reading("FXH", slotsOld(WEEKLY_CUT), "weekly"), reading("F1", slotsOld(WEEKLY_CUT))],
      TODAY,
    );
    expect(weekly!.ageDays).toBe(WEEKLY_CUT);
    expect(weekly!.lag).toBe(false);
    expect(daily!.ageDays).toBe(WEEKLY_CUT);
    expect(daily!.lag).toBe(true);
  });

  // MONTHLY/QUARTERLY STAY ON CALENDAR DAYS (a daily
  // containment grid has no opinion about
  // when a monthly feed is due). The unit stamp is the discriminator — without it a consumer could
  // pair a calendar-day number with a slot cut, which is exactly what `api/status.ts`'s fallback was
  // fixed to stop doing.
  test("a monthly reading keeps CALENDAR days and stamps the unit as such", () => {
    const asOf = "2026-05-25";
    const [r] = stampWithPeers([reading("EBP", asOf, "monthly")], TODAY);
    expect(r!.unit).toBe("days");
    expect(r!.ageDays).toBe(Math.round((Date.parse(`${TODAY}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000));
    expect(r!.lag).toBe(false); // 30d, well inside the monthly tier
  });

  // ⚠ NOT ASSESSED, NEVER FRESH (`lagCalendarsFrom`'s ⚠): a daily target with too few independent
  // peers falls below `MIN_CALENDAR_SOURCES` and `containmentGrid` throws. The stamp must leave the
  // row UNSTAMPED — both fields undefined — rather than coalescing the absence to age 0. Driven
  // through the bare `stampFreshness` (no peer pool) precisely because that is the below-floor case.
  // A `Europe/*` feed is judged on ITS publisher's calendar (2026-09-13 fix): at the 22:00 UTC cron
  // hour the US-Central default is still on the UTC date while Berlin has rolled to the next one,
  // so the SAME observation date is one slot older for the Berlin feed. The old stamp (`clock()`'s
  // UTC date for every feed) read both as age 0 — the defect /api/status never had.
  test("a per-feed today resolver stamps a Europe/* feed one slot older than a US-default feed at the cron hour", () => {
    const obs = slotsOld(1);
    const todayOn = feedCalendarTodayResolver(new Date(`${obs}T22:30:00Z`));
    // Fixture premise, asserted: Central is still on `obs`, Berlin has reached SLOT_TODAY.
    expect(todayOn(undefined)).toBe(obs);
    expect(todayOn("Europe/Berlin")).toBe(TODAY);
    const berlin: Reading = { ...reading("F1", obs), indicator: indicator({ id: "F1", feedTimeZone: "Europe/Berlin" }) };
    const [central, onBerlin] = stampWithPeers([reading("F1", obs), berlin], todayOn);
    expect(central!.ageDays).toBe(0);
    expect(onBerlin!.ageDays).toBe(1);
    expect(onBerlin!.unit).toBe("slots");
  });

  test("a daily reading with no derivable grid is left NOT ASSESSED, not stamped fresh", () => {
    const [r] = stampFreshness([reading("F1", slotsOld(WEEKLY_CUT + 1))], TODAY);
    expect(r!.ageDays).toBeUndefined();
    expect(r!.lag).toBeUndefined();
  });

  test("the stamp agrees with the notify seam's verdictHoldLegs - one rule, not two", () => {
    // Since slice 3 `verdictHoldLegs` READS this stamp rather than resolving a second freshness,
    // so what this pins is that it PROPAGATES the stamp faithfully — it must name exactly the
    // stamped-lagging ids, dropping none and inventing none — plus the stamp's own verdicts.
    const readings = [
      reading("FXH", slotsOld(WEEKLY_CUT), "weekly"), // at the weekly cut → fresh
      reading("F1", slotsOld(WEEKLY_CUT)), // same age, daily → stale
      reading("EBP", "2026-05-25", "monthly"), // 30 calendar days, monthly → fresh
      // E7: the DISCRIMINATING leg — an
      // age one publication PAST the weekly tier, on a per-source override that is looser still.
      // Fresh only if BOTH sides resolve the cut through `lagCutFor`; a side that fell back to the
      // weekly tier would flag it and break parity. Without this row every leg agrees under the
      // tier table alone and the override is untested at this seam.
      reading("F9", slotsOld(WEEKLY_CUT + 1), "weekly", WEEKLY_CUT + 2),
    ];
    const stampedReadings = stampWithPeers(readings, TODAY);
    const stamped = stampedReadings.filter((r) => r.lag).map((r) => r.indicator.id);
    expect(stamped).toEqual(verdictHoldLegs(stampedReadings).map((l) => l.id));
    // Vacuity guard — an all-fresh (or all-stale) fixture would let two broken sides agree.
    expect(stamped).toEqual(["F1"]);
  });
});


// ---------------------------------------------------------------------------------------
// FOLD_BY_SITE — the confirmation-fold answer key (domain-fold.ts) held honest.
//
// The table is DATA: nothing folds through it. These assertions are the half that works.
// For every `checkedBy: "behaviour"` site a probe drives the site's OWN live function with a
// tail of `k` consecutive off-state closes and reports whether the site's confirmed output
// flipped; the test then measures the SMALLEST k that flips and compares it to the table.
// A fold of `c` closes flips at `max(c, 1)` — 0 and 1 both degenerate to same-day.
// Mutating any site's buffer constant without editing the table makes the probe disagree.
// ---------------------------------------------------------------------------------------
describe("FOLD_BY_SITE - every confirmation-fold site matches its table entry", () => {
  /** Smallest tail run (1..max) that flips the site's confirmed output; 0 if none does. */
  const minRunToFlip = (flipsAt: (k: number) => boolean, max = 6): number => {
    for (let k = 1; k <= max; k++) if (flipsAt(k)) return k;
    return 0;
  };
  const repN = <T,>(n: number, v: T): T[] => Array.from({ length: n }, () => v);

  // --- per-site probes: each calls the LIVE function at that site ------------------------
  const termSeries = (vix: number[], ratio: number[]): TermPoint[] =>
    vix.map((v, i) => ({ date: String(i), vix: v, vix3m: v / ratio[i]!, ratio: ratio[i]! }));
  const pair = (v: number): PillarPair => ({ ew: { value: v, live: true }, sn: { value: v, live: true } });
  const REPLAY_IND: Indicator = indicator({ id: "FOLDPROBE", direction: "HIGH", thresholds: { redLevel: 5 } });

  const PROBES: Record<string, (k: number) => boolean> = {
    // Indicator tier — `buildReadings` folds through `confirmClosesFor(indicator.id)`. The fold
    // is DIRECTIONAL, so the table's `closes` is the DOWN (stand-down) depth — probed in the
    // DOWN direction here, and per DASHBOARD family (both directions) in the family loop below.
    indicator: (k) => indicatorFlip(DASHBOARD_FAMILIES[0]!.ids[0]!)(k),
    // Leg/pillar regime — danger-engine's own fold, deliberately NOT the indicator tier.
    pillarRegime: (k) =>
      confirmedRegime([...repN(10, pair(0)), ...repN(k, pair(DANGER_CUTS.amber))]) === "stress",
    // Off-ladder bottom track — flat VIX 45 with a ratio toggle drives a clean CALM↔WATCH raw
    // series (same isolation bottom.test.ts uses), so only the buffer decides the tail.
    bottom: (k) =>
      scoreBottom(termSeries(repN(40, 45), [...repN(40 - k, 0.85), ...repN(k, 1.1)])) ===
      "CAPITULATION-WATCH",
    // Off-ladder pension band fold — CALM history + k raw DIP closes; the buffer decides the tail.
    pension: (k) =>
      pensionConfirmBand([...repN<PensionBand>(10, "CALM"), ...repN<PensionBand>(k, "DIP")], CONFIRM_CLOSES) === "DIP",
    // Slow track — a calm run of SLOW_CALM_RUN_MIN-1+k closes leaves exactly k raw AMBER days.
    slowCalm: (k) =>
      scoreDurationOfCalm(
        [...repN(5, 40), ...repN(SLOW_CALM_RUN_MIN - 1 + k, 10)].map((value, i) => ({
          date: `d${i}`,
          value,
        })),
      ).fragileCalm,
    // Calibration replay — the vintage state the CALIB_MAP reads are taken off.
    calibrationReplay: (k) => {
      const n = VELOCITY_WINDOW + 10 + k;
      const obs: Observation[] = Array.from({ length: n }, (_, i) => ({
        date: `d${i}`,
        value: i < n - k ? 0 : 10,
      }));
      const { dates, state } = rawSeriesConfirmedByDate(REPLAY_IND, obs);
      return state.get(dates.at(-1)!) === "RED";
    },
  };

  /** Drive the REAL indicator-layer fold (`buildReadings` → `confirmClosesFor`) for one id, in
   *  the DOWN direction (the buffered one): RED history + k GREEN tail → did it stand down? */
  const indicatorFlip =
    (id: string) =>
    (k: number): boolean => {
      const raw: State[] = [...repN<State>(10, "RED"), ...repN<State>(k, "GREEN")];
      const readings = buildReadings(
        indicator({ id, direction: "HIGH", thresholds: { redLevel: 5 } }),
        repN(raw.length, 10),
        raw.map((_, i) => `d${i}`),
        raw,
        0,
        true,
      );
      return readings.at(-1)!.state === "GREEN";
    };

  /** The UP direction of the same live path: GREEN history + ONE RED close → confirmed RED? */
  const indicatorEscalatesSameDay = (id: string): boolean => {
    const raw: State[] = [...repN<State>(10, "GREEN"), "RED"];
    const readings = buildReadings(
      indicator({ id, direction: "HIGH", thresholds: { redLevel: 5 } }),
      repN(raw.length, 10),
      raw.map((_, i) => `d${i}`),
      raw,
      0,
      true,
    );
    return readings.at(-1)!.state === "RED";
  };

  test("every behaviour-checked site has a probe, and every probe a table entry", () => {
    const behavioural = Object.entries(FOLD_BY_SITE)
      .filter(([, s]) => s.checkedBy === "behaviour")
      .map(([k]) => k);
    expect(behavioural.sort()).toEqual(Object.keys(PROBES).sort());
    expect(behavioural.length).toBeGreaterThan(0); // vacuity guard
  });

  for (const [site, entry] of Object.entries(FOLD_BY_SITE)) {
    if (entry.checkedBy !== "behaviour") continue;
    test(`${site}: live code folds at ${entry.closes} close(s)`, () => {
      // `max(closes, 1)`: a 0-close (identity) fold still needs one close to show the new state.
      expect(minRunToFlip(PROBES[site]!), `${site} (${entry.folds})`).toBe(Math.max(entry.closes, 1));
    });
  }

  test("indicator: instant-up on ONE close, for every dashboard family", () => {
    for (const fam of DASHBOARD_FAMILIES) {
      expect(indicatorEscalatesSameDay(fam.ids[0]!), `${fam.key} (${fam.ids[0]})`).toBe(true);
    }
  });

  test("indicator: EVERY dashboard family stands down at the table's buffer, not just the first", () => {
    const expected = Math.max(FOLD_BY_SITE.indicator.closes, 1);
    for (const fam of DASHBOARD_FAMILIES) {
      expect(minRunToFlip(indicatorFlip(fam.ids[0]!)), `${fam.key} (${fam.ids[0]})`).toBe(expected);
    }
    // The tier table the fold reads must agree with the entry too — a family retuned to 2
    // without editing FOLD_BY_SITE fails here as well as in the probe above.
    for (const [key, closes] of Object.entries(CONFIRM_TIERS)) {
      expect(closes, key).toBe(FOLD_BY_SITE.indicator.closes);
    }
  });

  test("constant-checked sites: their `via` symbol still resolves to the table's buffer", () => {
    const byConstant = Object.entries(FOLD_BY_SITE).filter(([, s]) => s.checkedBy === "constant");
    expect(byConstant.length).toBeGreaterThan(0); // vacuity guard
    for (const [site, entry] of byConstant) {
      expect(entry.via, site).toBe("CONFIRM_CLOSES");
      expect(CONFIRM_CLOSES, site).toBe(entry.closes);
    }
  });

  // --- completeness: the table must NAME every file that calls a fold primitive ------------
  // ONE shared lazy tree scan feeds both completeness tests: every non-test .ts under
  // src/ · api/ · scripts/ read once, both primitive verdicts precomputed per file.
  const PRIMITIVES =
    /\b(confirmedSeries|confirmedStateSeries|asymConfirmedStateSeries|deriveConfirmedState|scoredDaySeries|winningLegSeries|pensionConfirmBand|confirmedRegime|foldConfirmed)\(/;
  const DEFINITION =
    /^\s*(export\s+)?function\s+(confirmedSeries|confirmedStateSeries|asymConfirmedStateSeries|deriveConfirmedState|scoredDaySeries|winningLegSeries|pensionConfirmBand|confirmedRegime)\(/;
  let scanMemo: Map<string, { site: boolean; raw: boolean }> | undefined;
  const scanTree = (): Map<string, { site: boolean; raw: boolean }> => {
    if (scanMemo) return scanMemo;
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
      );
    const memo = new Map<string, { site: boolean; raw: boolean }>();
    const files = ["src", "api", "scripts"]
      .flatMap((d) => walk(d))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    for (const file of files) {
      let site = false;
      let raw = false;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const code = line.trimStart();
        if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) continue;
        if (!PRIMITIVES.test(line)) continue;
        raw = true;
        if (!DEFINITION.test(line)) site = true; // the primitive's own declaration is not a site
      }
      memo.set(file, { site, raw });
    }
    scanMemo = memo;
    return memo;
  };

  test("no unlisted fold site exists under src/ · api/ · scripts/backtest/", () => {
    const scan = scanTree();
    const sources = [...scan.keys()].filter((f) => /^(src|api|scripts\/backtest)\//.test(f));
    expect(sources.length).toBeGreaterThan(20); // vacuity guard — the walk found real files

    const found = sources.filter((f) => scan.get(f)!.site);
    const listed = new Set(Object.values(FOLD_BY_SITE).flatMap((s) => s.files));
    expect(found.sort()).toEqual([...listed].sort());
  });

  // --- the RESIDUE: fold callers deliberately OUTSIDE the table's scope ---------------------
  // One-off measurement probes directly under `scripts/` are not table sites, but leaving them
  // unenumerated is how a probe ends up folding at a buffer nobody chose and printing the result
  // as if it were production behaviour. `probe-provisional-cost.ts` is exactly that risk: two of
  // its three calls pass hardcoded literals (2 and 3) rather than a named constant — deliberate
  // there (it MEASURES the cost of the buffer, so the pair must be free to differ), which is the
  // reason this is a named residue instead of a defect.
  const OUT_OF_SCOPE_FOLD_CALLERS = [
    "scripts/probe-provisional-cost.ts", // literals 2 and 3, plus a threaded `closes`
  ];

  test("the out-of-scope fold callers under scripts/ are exactly the enumerated residue", () => {
    const scan = scanTree();
    const probes = [...scan.keys()].filter((f) => /^scripts\/[^/]+\.ts$/.test(f));
    expect(probes.length).toBeGreaterThan(5); // vacuity guard — the listing found real files
    const found = probes.filter((f) => scan.get(f)!.raw);
    expect(found.sort()).toEqual([...OUT_OF_SCOPE_FOLD_CALLERS].sort());
  });
});
