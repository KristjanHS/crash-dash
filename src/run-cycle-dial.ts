/** Run-cycle readings stamp + dial: reading spreads, gap-fill sweep, freshness stamp, notify + display dial, carry/coverage degrades. */

import {
  stampFreshness,
  lagCalendarsFrom,
  resolveFreshness,
} from "./scorers-core.js";
import { type Reading } from "./domain-types.js";
import { compositeComponentLegIds } from "./feed-lag.js";
import { lagCutFor } from "./ladder.js";
import { feedCalendarTodayResolver } from "./dates.js";
import { ALL_INDICATORS } from "./registry.js";
import { SLOW_INDICATOR_IDS } from "./registry-price.js";
import type { CoverageMark, StoredReading } from "./store.js";
import { recordDegrade, type ScoredTrack } from "./tracks.js";
import { seamRunAt } from "./series-db-first.js";
import { gateUnanchoredReadings, withEstimateHeads, withoutEstimateSourced } from "./estimated.js";
import { GATE_FAILED_ESTIMATORS } from "./nowcast-score.js";
import { tradingDaysBetween, CARRY_MAX_TRADING_DAYS } from "./families.js";
import type { T1DialResult } from "./t1dial.js";
import { assembleDial, warnCissRead, type PersistedPanel } from "./dial-assembly.js";
import { runBudgetExhausted, runMsUntilHardDeadline, BUDGET_ABORT_SCOPE } from "./fetch-budget.js";
import { gapFillSweep } from "./run-seeds.js";
import { REDERIVE_STEP_FAILED_SCOPE, rederiveOnWrite } from "./rederive.js";
import { latestReadingDate } from "./run-core.js";
import { fallbackGate, INDICATOR_BY_ID, type RunBase } from "./run-cycle-ctx.js";
import { providerFallbackSymbols } from "./provider-fallback-latch.js";
import { finalRewriteHeld } from "./prices.js";
import { errMsg } from "./err-msg.js";

/** id → resolved `lagCutFor` over every indicator — assembleDial's `carryLagCutById`; /api/lab arms the same for band parity. */
const CARRY_LAG_CUT_BY_ID: ReadonlyMap<string, number> = new Map(
  ALL_INDICATORS.map((i) => [i.id, lagCutFor(i)]),
);

export async function assembleReadingsAndDial(
  ctx: RunBase,
  { fredScored, price, feed, cqsSeries, scoredConfirmers, scored, estimateRows }: {
    fredScored: Reading[];
    price: { readings: Reading[]; downside: Reading[]; rs: Reading[] };
    feed: (id: string) => Reading[];
    cqsSeries: Reading[];
    scoredConfirmers: ReadonlyArray<{ series: Reading[] }>;
    scored: ScoredTrack[];
    estimateRows: StoredReading[];
  },
) {
  const { clock, opts } = ctx;
  // An estimate-sourced reading breaking `estimateAnchored` reads its last FINAL — before the dial AND the persist.
  const gate = async (rs: readonly Reading[]): Promise<Reading[]> =>
    [...(await gateUnanchoredReadings(rs, { runAt: ctx.runAt, sourced: ctx.estimateSourced, carried: ctx.gapCarry }, ctx.store, (scope, reason) => {
      console.warn(`${scope}: ${reason}`);
      recordDegrade(scope, reason, "notify");
    }))];
  // `stampFreshness` is order-preserving, so the ordering-sensitive spreads are byte-unchanged;
  // `ageDays`/`lag` are in-memory only (READINGS_COLS maps column-by-column), so nothing new is written.
  const rawStampedReadings: Reading[] = await gate([
      ...fredScored,
      ...price.readings,
      ...cqsSeries.slice(-1),
      // The confirmers in FAST_CONFIRMERS order (G1, EBP, R6, R7, CG, VT, BRENT, VTP, ECY, NG, VXNT).
      ...scoredConfirmers.flatMap((s) => s.series.slice(-1)),
  ]);
  const [downside, rs] = [await gate(price.downside), await gate(price.rs)];
  // Off-ladder track legs on the asOf `assembleRun` derives (same `latestReadingDate` over the same dates).
  const trackAsOf = latestReadingDate(rawStampedReadings) ?? ctx.runAt.slice(0, 10);
  for (const t of scored) {
    for (const [id, series] of t.storedSeries(trackAsOf)) {
      ctx.gapCarry.set(id, series);
      for (const sym of t.priceSymbols ?? []) ctx.markFallbackSourced(id, sym);
    }
  }
  // ONE sweep over every carried id, before any stored-history reader (the exposure seam's F1 series, `computeExposureInputs`):
  // a run that scored off a hole-y store and then filled it would push a line its own history can't reproduce.
  opts.onGapFillSeries?.(ctx.gapCarry);
  // Never throws — its failures are `recordDegrade` events, so it MUST stay above `drainDegradeLog()`.
  // Intraday and EOD price reads differ: a daytime value repair would flip every EOD-price id's window twice a day.
  // A provider hop (peeked, never drained — persist owns the drain) holds its ids insert-only; an unclaimed hop holds the run.
  const { insertOnlyIds, unclaimed } = fallbackGate(ctx.fallbackClaims, providerFallbackSymbols());
  await gapFillSweep(ctx.store, withoutEstimateSourced(ctx.gapCarry, ctx.estimateSourced), ctx.firedDateIso, () => seamRunAt(ctx.runAt), {
    valueRepair: !ctx.intraday && unclaimed.length === 0,
    insertOnlyIds,
    // Intraday past dates: only an absent/estimated head, never an id an EOD price symbol feeds.
    insertOnOrAfter: ctx.intraday ? ctx.firedDateIso : undefined,
    pastHeldIds: new Set([...ctx.fallbackClaims].filter(([sym]) => ctx.priceFed.has(sym) && finalRewriteHeld(sym)).flatMap(([, ids]) => [...ids])),
    insertOnlyReason: ctx.intraday ? undefined : unclaimed.length > 0 ? `unclaimed provider fallback ${unclaimed.join(",")}` : "provider fallback",
  });
  // EOD only: a FINAL row no EOD run has read, on an (id, date) a recent verdict read off an estimate — whoever wrote it — supersedes
  // that verdict BEFORE run-cycle's prev-state reads. Never pushes.
  if (!ctx.intraday) {
    try {
      for (const r of await rederiveOnWrite(ctx.store, opts.msUntilHardDeadline ?? (() => runMsUntilHardDeadline(performance.now())))) {
        // A failed or deferred verdict is `rederiveOnWrite`'s own degrade (`rederiveFailedScope`), which the next EOD re-checks.
        if (!("error" in r)) console.log(`[rederive] ${r.orig.date}: ${r.unverifiable !== undefined ? `unverifiable, left as served - ${r.unverifiable}` : r.row === null ? "twins agree" : `superseded ${r.orig.level} -> ${r.row.level}`} (${r.removed} stale row(s) removed)`);
      }
    } catch (err) {
      recordDegrade(REDERIVE_STEP_FAILED_SCOPE, errMsg(err), "notify"); // the next EOD re-checks every verdict
    }
  }
  // The ONE freshness evaluation clock for BOTH reading arrays — deliberately the RUN's wall-clock instant,
  // not `dialAsOf`: a frozen feed must read as lagging against today, else one live feed masks a dead one.
  // Resolved PER FEED on the publisher's calendar (`feedTimeZone`, default `FEED_CALENDAR_TZ`) — the same
  // resolver `/api/status` uses — never `clock().slice(0, 10)`: that UTC date stamped every `Europe/*`
  // feed a slot younger than the status page at the 22:00 UTC cron hour (pinned in
  // `run-path-freshness-callers.test.ts`).
  const freshnessToday = feedCalendarTodayResolver(new Date(clock()));
  const rawGlobalReadings: Reading[] = await gate([
    ...feed("EURC"),
    ...feed("FXH"),
    ...feed("GT"),
    ...feed("GB"),
    ...feed("DISP"),
    // Appended at the END: this spread is ordering-sensitive persisted output, so new legs go last.
    ...feed("BUND"),
    ...feed("HCX"),
    ...feed("FDX"),
    ...feed("ESTR"),
    ...feed("ECISS"),
    ...feed("BONOS"),
    ...feed("EURGBP"),
    ...feed("EPATH"),
    ...feed("HICP"),
    ...feed("CCC"),
    ...feed("VXNCLS"),
    ...feed("T10Y3M_RAW"),
    ...feed("VXSMH"),
  ]);
  // PASS 1 freshness stamp: ONE publication-calendar pool
  // over EVERY reading this run
  // produced. MUST be built over the union, not per group — `price.downside`/`price.rs` are
  // single-indicator arrays that would fall below `MIN_CALENDAR_SOURCES` alone and go UNSTAMPED. Pure.
  // `compositeComponentLegIds` is injected because a composite leg shares its parent's fetch (not a source).
  opts.onFeedDatesCollected?.(ctx.feedDates);
  const lagCalendars = lagCalendarsFrom(
    [...rawStampedReadings, ...rawGlobalReadings, ...downside, ...rs],
    compositeComponentLegIds(),
    ctx.feedDates,
  );
  const globalReadings: Reading[] = stampFreshness(rawGlobalReadings, freshnessToday, lagCalendars);
  const stampedReadings: Reading[] = stampFreshness(rawStampedReadings, freshnessToday, lagCalendars);
  // A lagging member folds its LAST-KNOWN state uniformly (S-2/`obsOf`); lag acts only through the
  // COVERAGE FLOOR (`coverageArmed`, alert-band.ts). No live-only flip, so the notify array and the
  // array handed to the store are the SAME — nothing diverges.
  const readings: Reading[] = stampedReadings;
  // Build the T1 danger dial the SAME way /api/lab does — reduce COMBINED main + global readings through
  // GLOBAL_FAMILIES (globalReadings alone leaves the dial ≈ rung 1 ⇒ R4 could never enter). Shared
  // `assembleDial` seam so the shown band can't diverge from the pushed band. The cron path passes
  // `onMissingTechMember` + turns `dropped`/`carried` into degrade events; /api/lab passes neither.
  // `latestReadingDate` THROWS on a non-ISO date (`trackAsOf` above runs it first).
  const dialAsOf = latestReadingDate(readings) ?? clock().slice(0, 10);
  // The FULL print rows under the dial — the `[coverage]` emitter below looks a member's feed symbol/state/age up by id
  // off their notify fold (`notifyReadings`). The `{id, state, lag}` rows handed to `assembleDial` do NOT carry `series`.
  const dialReadings: Reading[] = [
    ...readings,
    ...globalReadings,
    // `price.rs`/`price.downside` ride an inline stamp (else they'd read "not assessed" forever); persistence byte-unchanged.
    ...stampFreshness(downside, freshnessToday, lagCalendars),
    ...stampFreshness(rs, freshnessToday, lagCalendars),
  ];
  // Bubble-arming: ARMED := this run's scored slow band ≥ ELEVATED; a degraded/absent slow track stays unarmed.
  const slowAlertFields = scored.find((s) => s.baselineField === "slowBand")?.alertFields;
  const slowBand = slowAlertFields && "slowBand" in slowAlertFields ? slowAlertFields.slowBand : null;
  const slowArmed = slowBand !== null && slowBand !== "CALM";
  const dialCarryAgeOf = (id: string, date: string, asOf: string): number | null => {
    const ind = INDICATOR_BY_ID.get(id);
    return ind === undefined ? null : (resolveFreshness(ind, date, asOf, lagCalendars)?.ageDays ?? null);
  };
  const dialRow = (r: Reading) => ({ id: r.indicator.id, state: r.state, lag: r.lag, factor: r.indicator.geoFactor });
  // The SLOW bubble-watch legs score on the slow TRACK, never in `dialReadings`, yet GLOBAL_FAMILIES.volatility
  // lists them — without these rows the persisted display panel served them as 4 absent members (+ coverage
  // degraded). Display-only by construction: DIAL_FAMILIES strips `SLOW_INDICATOR_IDS`, so the dial panel,
  // band and push never see them. Each series' newest point = the row the persist step writes (run-core.ts).
  // An id already in `dialReadings` keeps that row (the panel's by-id Map would let a later duplicate win).
  const dialIds = new Set(dialReadings.map((r) => r.indicator.id));
  const slowDisplayRows = scored.flatMap((t) =>
    [...t.storedSeries(trackAsOf)]
      .filter(([id]) => SLOW_INDICATOR_IDS.has(id) && !dialIds.has(id))
      .flatMap(([id, series]) => {
        const last = series.at(-1);
        return last === undefined ? [] : [{ id, state: last.state, lag: undefined, factor: INDICATOR_BY_ID.get(id)?.geoFactor }];
      }),
  );
  const restampHead = (r: Reading) => stampFreshness([r], freshnessToday, lagCalendars)[0]!;
  // The notify dial folds this run's estimate heads too — never a failed-gate estimator's (`GATE_FAILED_ESTIMATORS`).
  const notifyReadings = withEstimateHeads(dialReadings, estimateRows.filter((e) => !GATE_FAILED_ESTIMATORS.has(e.indicatorId)), restampHead) ?? dialReadings;
  const { globalPanel, displayPanel, dial, cissHistory, heldMemberState, carried, dropped, lastKnownFamily, carriedMembers } = await assembleDial({
    // `price.downside` (DB_SMH) is folded in HERE so its confirmed state reaches the trend family on the
    // NOTIFY path (the cron dial from `readings + globalReadings` alone leaves the confirmer slot dark).
    // `lag` rides each row so the panel can judge COVERAGE (`FamilyPanel.coverageDegraded`) — the stamp
    // `stampFreshness` already resolved; IN-MEMORY only, so `downsideStoredReadings` (`buildStoredRows`) is byte-unchanged.
    // `factor` (registry `geoFactor`) rides each row so the push body's diffusion count collapses one
    // factor to one signal (gp's G1/BRENT/OVX = one oil factor); untagged ⇒ member counts as its own factor.
    readings: [...notifyReadings.map(dialRow), ...slowDisplayRows],
    asOf: dialAsOf,
    store: ctx.store,
    // Member-carry cut map: an absent roster member within its own `lagCutFor` re-enters the fold with its
    // last persisted state (a fetch hiccup no longer shrinks the denominator). /api/lab passes the same map.
    carryLagCutById: CARRY_LAG_CUT_BY_ID,
    // The carry gate's vintage clock — this run's ONE resolver over its ONE calendar pool, so an absent
    // member's age is counted in `CARRY_LAG_CUT_BY_ID`'s unit. `null` (off-registry/no grid) ⇒ stays absent.
    carryAgeOf: dialCarryAgeOf,
    // fail-toward-calm: a MISSING tech member is a null non-live slot, NOT a silent calm GREEN — record it.
    onMissingTechMember: (id) =>
      recordDegrade(
        `[tech-confirmer] member ${id} non-live - excluded (was defaulting to GREEN)`,
        "missing from GLOBAL_FAMILIES trend panel this run",
        "notify",
      ),
    onReadFail: (id, err) => {
      console.warn(`[dial-carry] ${id} stored-close read failed - read as no persisted close: ${errMsg(err)}`);
      recordDegrade(`[dial-carry] ${id} stored-close read failed - member read as dark`, errMsg(err), "notify");
    },
    onCissReadError: (ids, err) => {
      warnCissRead(ids, err);
      recordDegrade("[ciss] member-history bulk read failed - signal hold off, member states unheld", `${ids.length} members: ${errMsg(err)}`, "notify");
    },
    slowArmed,
    notifyToday: ctx.firedDateIso,
  });
  // E13: the DISPLAY dial folds EVERY estimate head, failed-gate included.
  // The display assembly ALWAYS runs unfiltered (no `notifyToday`), heads or not; a failure falls back to the notify one — a `trace` (display only).
  const notifyPanelState: PersistedPanel = { globalPanel, displayPanel, cissHistory, heldMemberState };
  const displayReadings = withEstimateHeads(dialReadings, estimateRows, restampHead);
  const display: { dial: T1DialResult; panel: PersistedPanel } =
    await assembleDial({ readings: [...(displayReadings ?? dialReadings).map(dialRow), ...slowDisplayRows], asOf: dialAsOf, store: ctx.store, carryLagCutById: CARRY_LAG_CUT_BY_ID, carryAgeOf: dialCarryAgeOf, slowArmed })
      .then((d) => ({ dial: d.dial, panel: { globalPanel: d.globalPanel, displayPanel: d.displayPanel, cissHistory: d.cissHistory, heldMemberState: d.heldMemberState } }))
      .catch((err: unknown) => {
        console.warn(`[display-dial] display assembly failed - display = notify dial: ${errMsg(err)}`);
        recordDegrade("[display-dial] display assembly failed - display = notify dial", errMsg(err), "trace");
        return { dial, panel: notifyPanelState };
      });
  // Carry bookkeeping → side-effects (assembleDial returns the lists so /api/lab's read-only path writes
  // none): a family dropped past the age limit gets a degrade event; a carried one is logged.
  for (const key of dropped) {
    const lk = lastKnownFamily[key]!;
    recordDegrade(
      `[family:${key}] previously-firing feed non-live > ${CARRY_MAX_TRADING_DAYS} trading days - dropped from dial`,
      `last-known ${lk.state} @ ${lk.date}`,
      "notify",
    );
  }
  for (const key of carried) {
    const lk = lastKnownFamily[key]!;
    console.log(
      `[family:${key}] feed non-live - carrying last-known ${lk.state} @ ${lk.date} (${tradingDaysBetween(lk.date, dialAsOf)}≤${CARRY_MAX_TRADING_DAYS} trading days)`,
    );
  }
  // MEMBER-level carry: an absent member re-entered on its in-cut close — logged (not a degrade event; it arms no floor while in-cut).
  for (const c of carriedMembers) {
    console.log(`[member:${c.id}] absent this run - carrying last-known ${c.state} @ ${c.date} (${c.ageDays}d, within lag cut)`);
  }
  // R5/R8 coverage trace: one degrade event per family whose verdict rested on non-live data. Read STRAIGHT
  // off the carried panel's `verdictHoldIds`/`absentIds` (no roster lookup here — that lives in `computeFamilyPanel`).
  // Per-id detail is recorded AT RUN TIME (the reading's `date` is frozen; an age measured later would be larger).
  const dialReadingById = new Map(notifyReadings.map((r) => [r.indicator.id, r]));
  // MEMBER-carry detail by id: a carried member is now PRESENT (in `f.members`) so it's in neither
  // absentIds/verdictHoldIds; surfaced below as its own `reason: "carried"` mark.
  const carriedById = new Map(carriedMembers.map((c) => [c.id, c]));
  const seriesById = new Map(ALL_INDICATORS.map((i) => [i.id, i.series]));
  for (const f of globalPanel) {
    // `f.state === null` is DEFENSIVE ONLY (unreachable today) — kept so the `${f.state} held by …` line can't emit "null".
    if (f.coverageDegraded !== true || f.state === null) continue;
    const verdictHoldIds = f.verdictHoldIds ?? [];
    const absentIds = f.absentIds ?? [];
    const members: CoverageMark[] = [
      ...verdictHoldIds.map((id): CoverageMark => {
        const r = dialReadingById.get(id);
        return {
          id,
          reason: "lag",
          series: r?.indicator.series ?? null,
          state: r?.state ?? null,
          ageDays: r?.ageDays ?? null,
        };
      }),
      // No reading exists for an absent member — the three detail fields are null by construction, not a fabricated zero.
      ...absentIds.map((id): CoverageMark => ({ id, reason: "absent", series: null, state: null, ageDays: null })),
      // CARRIED members of THIS family — present now, on last-known in-cut data; detail from carriedById + seriesById.
      ...f.members
        .filter((m) => carriedById.has(m.id))
        .map((m): CoverageMark => {
          const c = carriedById.get(m.id)!;
          return { id: m.id, reason: "carried", series: seriesById.get(m.id) ?? null, state: c.state, ageDays: c.ageDays };
        }),
    ];
    const held = members.length
      ? members
          .map((m) =>
            m.reason === "absent"
              ? `${m.id} (absent)`
              : `${m.id} (${m.reason}${m.ageDays === null ? "" : ` ${m.ageDays}d`})`,
          )
          .join(", ")
      : "carried last-known data";
    recordDegrade(
      `[coverage] ${f.key} verdict held by non-live data`,
      `${f.state} held by ${held}`,
      "notify",
      { coverage: { family: f.key, verdict: f.state, carried: carried.includes(f.key), members } },
    );
  }
  // If the run-wide fetch deadline fired, record it ONCE: a budget abort can starve a family and bias the
  // band calm-ward, so `notify_format` forces the calm-ward caveat on this scope regardless of non-live count.
  if (runBudgetExhausted()) {
    console.warn(`${BUDGET_ABORT_SCOPE} - feeds aborted mid-run; band may read calm-ward`);
    recordDegrade(BUDGET_ABORT_SCOPE, `run fetch budget exhausted before the fetch phase completed`, "notify");
  }

  return { readings, stampedReadings, globalReadings, downside, rs, dial, display, globalPanel, cissHistory, notifyPanelState };
}
