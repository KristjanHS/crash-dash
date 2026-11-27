/**
 * GET /api/lab — What-If T1 danger panel. Read-only, interactive-only, no ntfy, no LLM.
 * Reads the store on every mode (incl. `?s=`), so not a pure function of the query string.
 * CONSUMES the persisted confirmed `.state` — never re-scores at read time (see api/status.ts).
 */

import { getStore, PRUNE_DEGRADE_SCOPE, type ReadStore } from "../src/store.js";
// `walkForward` via `await import()`, not static: both call sites sit inside `if (walk > 0)`, so
// the `?walk=N`-less common path never loads `src/run-core.ts`'s heavy transitive chain.
import type { WalkForwardResult } from "../src/run-core.js";
import { CASH_REHYDRATE_DATES } from "../src/cash-overlay.js";
import { loadGeoActiveCount } from "../src/geo.js";
import type { AlertLevel } from "../src/ladder.js";
import { CADENCE_OF, freshnessFrom, type FeedLagNote, type FreshnessStamp } from "../src/feed-lag.js";
import { computeFamilyPanel, computeFamilyPanelFromStates, US_FAMILIES, GLOBAL_FAMILIES, PER_LEG_ONLY_MEMBERS, type FamilyPanel, type LabResponse, type LegAttribution } from "../src/families.js";
import { hydrateOrComputeT1Dial, techConfirmerBreadth, techConfirmerFromPanel, LEG_WEIGHTED_IDS, NO_ARM_FAMILIES } from "../src/t1dial.js";
import { computeField, trendConfirming, PILLAR_MEMBER_IDS, type MemberFreshness, type MemberHistoryEntry } from "../src/danger-engine.js";
import { buildMemberState } from "../src/danger-member-state.js";
import { DEGRADED_HEADERS, rejectUnknownParams, serveRedactable, VINTAGE_HEADERS } from "../src/api/http.js";
import { assembleDial, fetchCissHistory, selectMemberStateMap, DIAL_FAMILIES } from "../src/dial-assembly.js";
import { buildLabBand, coverageArmed } from "../src/alert-band.js";
import { FACTOR_OF } from "../src/registry.js";
import { DOWNSIDE_DETECTORS } from "../src/registry-price.js";
import { type Observation } from "../src/domain-types.js";
import { memoByVintage } from "../src/api/vintage-memo.js";
import { readIntradaySlot, servedVerdict } from "../src/intraday.js";
import { getObservedSeries, unanchoredEstimateDates } from "../src/estimated.js";
import { computeR4, R4_HY_TAIL, R4_VT_TAIL, R4_EXIT_HY, R4_EXIT_VT, type R4State } from "../src/r4.js";
import { computeReplay, SERIES_FETCH_SLACK, type ReplayResult } from "../src/replay.js";
import { loadHyOasVintage } from "../src/hyoas-vintage.js";
import { readInputSeries, warnMissingInput } from "../src/input-series.js";
import { stitchHyOas } from "../src/hyoas-history.js";
import type { State } from "../src/domain-types.js";
import { computeScoreboard, withholdScoreboardStats, SB_STRAT_ID, SB_BENCH_ID, SCOREBOARD_WINDOW } from "../src/scoreboard.js";
import { parseWalk, parseScenario, parseReplay, parseHist, MS_PER_CALENDAR_DAY, HY_INPUT_ROW_LIMIT } from "../src/lab-request.js";
import { LONG_LABEL_OF, LABEL_OF, LAB_CARRY_LAG_CUT_BY_ID, applyLagKnob, reconstructReadings, readingsFromPanels, LOOKBACK_PAD, prevTargetOf, prevDialTargetOf, gateHeld } from "../src/lab-assembly.js";
import { toServedField } from "../src/lab-served-field.js";
import { resolveServedPanels } from "../src/lab-served-members.js";
import { computeLegAttribution } from "../src/lab-attribution.js";
import { r4View, fallShapeView, withFallShapeChips, withholdField, withholdBandMemberValue, withholdGrowthRs, withholdR5Stats, R4_HY_OAS_FIELD_LABEL, R4_HY_OAS_MEMBER_ID, FALL_VELOCITY_FIELD_LABEL, resolveVixPersistenceView, resolveR1View, resolveR5View, loadLegGrowth, resolveY1View } from "../src/lab-overlays.js";
import { isoDay } from "../src/dates.js";
import { readEnv } from "../src/config.js";
// Re-exported so api/lab.*.test.ts and public/prose-names.test.ts keep importing them from here.
export { legHistoryLimitFor } from "../src/lab-assembly.js";
export { ewPctCell } from "../src/lab-served-field.js";

// D3/D4 served roster: the browser reads member tone + no-arm from THIS, never a hand-listed
// roster in public/*.js (`indicator-loop.md` §A retune is a ONE-place edit).
const DANGER_ROSTER = { legWeightedIds: [...LEG_WEIGHTED_IDS], perLegOnlyIds: [...PER_LEG_ONLY_MEMBERS], noArmFamilies: [...NO_ARM_FAMILIES], pillarIds: [...PILLAR_MEMBER_IDS] };

/** Start a read now, `await` it later at its original site: the no-op handler stops a rejection that
 *  lands before that await from tripping Node's unhandled-rejection exit; the await still re-throws it. */
function prefetch<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

/** `handle`'s injectable seams; each default is the production one `GET` runs with. */
export interface LabSeams {
  /** The committed HY-OAS vintage the `?replay=` stitch reads (default `loadHyOasVintage`: fail-loud on a corrupt file, `undefined` when absent). */
  vintage?: () => Observation[] | undefined;
  /** The request clock, read once: `?s=` asOf fallback + r4 prior, `?replay=` validation + read window,
   *  the freshness stamp, the HY input staleness gate and the scoreboard cutoff. */
  now?: Date;
  /** Sink for the degrade logs (stamp unavailable, storeless `?s=`, missing HY input). */
  warn?: (...args: unknown[]) => void;
}

// `request?` OPTIONAL: callers (tests, scripts/*-probe) call GET() with no arg, so a required param fails tsc (TS2554).
export async function GET(request?: Request): Promise<Response> {
  const env = readEnv();
  return handle(() => getStore("ro", env), request);
}

/** The `?replay=` body. */
type LabReplayBody = { mode: "replay"; start: string; end: string } & ReplayResult;

/** Every 200 body `/api/lab` serves, one per mode. */
type LabBody = LabResponse | LabReplayBody;

/**
 * The redacted response body: the r4 HY OAS field, the fall-shape velocity field and the band's r4 HY OAS row `value` are
 * withheld (single-input series served state-only); everything else is the raw body untouched. Only the
 * live body carries them as stored values: the scenario r4 HY OAS is the synthesized knob level (`R4_HY_TAIL` /
 * `R4_EXIT_HY - 1`) with no fall shape or band, and replay points carry no level, so both pass through unchanged.
 * 3.5b (ruled 2026-11-25): the statistics computed off ONE licensed input are withheld on the live AND scenario
 * bodies (both read the store) — the R5 vol-target stats (`withholdR5Stats`), every `growthRs[].rs`
 * (`withholdGrowthRs`) and the scoreboard's NAV statistics (`withholdScoreboardStats`, live only).
 */
function redactLab<B extends LabBody>(raw: B): B {
  if (raw.mode === "replay") return raw;
  const live = raw.mode === "live";
  const { r4, fallShape, r5 } = raw.overlays;
  return {
    ...raw,
    overlays: {
      ...raw.overlays,
      ...(live && r4 ? { r4: withholdField(r4, R4_HY_OAS_FIELD_LABEL) } : {}),
      ...(live && fallShape ? { fallShape: withholdField(fallShape, FALL_VELOCITY_FIELD_LABEL) } : {}),
      ...(r5 ? { r5: withholdR5Stats(r5) } : {}),
    },
    ...(live && raw.band ? { band: withholdBandMemberValue(raw.band, R4_HY_OAS_MEMBER_ID) } : {}),
    ...(raw.growthRs ? { growthRs: withholdGrowthRs(raw.growthRs) } : {}),
    ...(raw.scoreboard ? { scoreboard: withholdScoreboardStats(raw.scoreboard) } : {}),
  };
}

/** A built body plus the headers its 200 rides. */
type Built = { body: LabBody; publicHeaders: Readonly<Record<string, string>> };

/** `parseLabParams`'s parsed modes: the request URL, `?walk`, live `?hist` and a valid `?s=` scenario. */
type LabParams = { url: URL | undefined; walk: number; hist: number; parsedScenario: Exclude<ReturnType<typeof parseScenario>, { error: string }> | undefined };

/** What `handle` hands its `?s=` branch: the hoisted store (or why it failed) and the AWAITED stamp. */
interface ScenarioCtx {
  scenarioStore: ReadStore | null;
  sharedStoreError: unknown;
  freshness: readonly MemberFreshness[] | undefined;
  feedLag: readonly FeedLagNote[];
  freshnessMissing: boolean;
  walk: number;
  now: Date;
  warn: (...args: unknown[]) => void;
}

/** `labBody`'s `?s=` branch: the scenario body off the parsed states/knobs. */
async function scenarioBody(
  parsed: Exclude<ReturnType<typeof parseScenario>, { error: string }>,
  { scenarioStore, sharedStoreError, freshness, feedLag, freshnessMissing, walk, now, warn }: ScenarioCtx,
): Promise<LabResponse> {
  // THREE panels: veto fields off frozen US_FAMILIES; the DIAL reduces against DIAL_FAMILIES; the
  // SERVED `globalFamilies` reduces against full GLOBAL_FAMILIES.
  const usPanel = computeFamilyPanelFromStates(parsed.states, US_FAMILIES, parsed.members, LONG_LABEL_OF, LABEL_OF, FACTOR_OF);
  // DIAL_FAMILIES, not GLOBAL_FAMILIES: the scenario dial must reduce against the SAME table the
  // live path does (dial-assembly.ts drops the display-only SLOW legs) — scenario↔live parity.
  const globalPanel = computeFamilyPanelFromStates(parsed.states, DIAL_FAMILIES, parsed.members, LONG_LABEL_OF, LABEL_OF, FACTOR_OF);
  // DISPLAY twin over the full table (assembleDial's `displayPanel` mirror): serving `globalPanel`
  // instead would drop the SLOW legs and break the `globalFamilies` parity pin (api/lab.test.ts).
  const displayPanel = computeFamilyPanelFromStates(parsed.states, GLOBAL_FAMILIES, parsed.members, LONG_LABEL_OF, LABEL_OF, FACTOR_OF);
  // Scenario field runs the SAME engine inputs as live (live member history for hold / regime / ROC, live
  // prevTarget, live M5-gated held), substituting ONLY the `?s=` states at t — so `?s=`=today's
  // states deep-equals live UNCONDITIONALLY. History is never rewritten counterfactually.
  // Store reads sit ABOVE the dial: the `scenarioAsOf` anchor below needs the verdict's data date.
  // ⚠ scenario↔live parity holds only WITH a configured store; an unconfigured/cold store degrades
  // LOUDLY to the pre-2.1 shape (verdict null, empty member history ⇒ unheld, no ROC; ungated held), never 404/500 (openapi.yaml).
  if (!scenarioStore) {
    warn(
      "[lab] scenario path (?s=): no store available - DEGRADED to the pre-2.1 shape " +
        "(verdict: null, cissHistory: [] ⇒ unheld member state + no regime/ROC/momentum bases, ungated held). Scenario↔live parity does NOT hold " +
        "here; set SUPABASE_URL + SUPABASE_SERVICE_KEY. Cause:",
      sharedStoreError instanceof Error ? sharedStoreError.message : sharedStoreError,
    );
  }
  // Verdict FIRST so its `firedAt` keys the memoized member-history bulk read; a null verdict bypasses the memo.
  const scenarioVerdict = scenarioStore
    ? await scenarioStore.getLastAlert().catch((err: unknown) => {
        warn("[lab] scenario verdict read failed - DEGRADED to verdict: null:", err);
        return null;
      })
    : null;
  const cissHistory: MemberHistoryEntry[] = scenarioStore
    ? await memoByVintage(
        "ciss",
        scenarioVerdict?.firedAt,
        () => fetchCissHistory(scenarioStore, globalPanel.families),
        // All-empty histories = the loader swallowed a store failure — evict so the next request retries.
        { cacheIf: (h) => h.some((e) => e.history.length > 0) },
      )
    : [];
  // ⚠ SINGLE TOUCH POINT for the scenario `asOf` — the `?walk=` seed below consumes THIS binding,
  // do not re-type it. `?s=` sets states not dates, so `asOf` is the verdict's data date (today if none).
  const scenarioAsOf = scenarioVerdict?.date ?? isoDay(now);
  // `?s=` always recomputes: pass `undefined` dial through the SAME hydrate-or-compute helper live
  // uses (C1 persist-assembled-dial). Held map via `selectMemberStateMap` (the one `noHoldDepth`
  // site) since this arm never calls assembleDial. Degraded (no-store) path is byte-identical:
  // `cissHistory` []  ⇒ `noHoldDepth([])` true ⇒ unheld builder.
  const dial = hydrateOrComputeT1Dial(
    undefined,
    globalPanel.families,
    techConfirmerBreadth(
      techConfirmerFromPanel(
        globalPanel.families,
        undefined,
        selectMemberStateMap(globalPanel.families, cissHistory),
      ),
    ),
  );
  // Synthesize R4 inputs from the reserved knobs (kept here, not in r4.ts). `tail` picks tail-print
  // levels; otherwise levels sit just below the exit floors (clearly-clear).
  const { options } = parsed;
  // `lag:` knob applied HERE, downstream of the shared stamp, so a knob-free `?s=` stays byte-identical to live.
  const { freshness: scenarioFreshness, lag: scenarioFeedLag } = applyLagKnob(freshness, feedLag, options.lag);
  // `sustained` is a no-op ALIAS of `tail` (ScenarioOptions): either knob can now only print the tails.
  const tailPrint = options.tail || options.sustained;
  const hyOas = tailPrint ? R4_HY_TAIL : R4_EXIT_HY - 1;
  const vt = tailPrint ? R4_VT_TAIL : R4_EXIT_VT - 0.05;
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  // Single `nowMs` anchor so a `daysInCash:N` prior is exactly N days old (no sub-ms skew to N−1).
  const prior: R4State =
    options.daysInCash > 0
      ? {
          phase: "cash",
          entryFiredAt: new Date(nowMs - options.daysInCash * MS_PER_CALENDAR_DAY).toISOString(),
          reentryRung: null,
        }
      : { phase: "equity", entryFiredAt: null, reentryRung: null };
  const r4 = computeR4(dial, hyOas, vt, prior, () => nowIso);

  // `?s=` + `?walk=N` compose: scenario states/dial ARE the frozen conditions; seed day-0 from the
  // same prod reads and walk forward. Needs a configured store WITH a verdict, else no walk.
  let scenarioWalk: WalkForwardResult | null = null;
  if (walk > 0 && scenarioStore && scenarioVerdict) {
    const seedBand: AlertLevel | null =
      scenarioVerdict.dialBand ??
      ((await scenarioStore.getLastBandBefore("dialBand", scenarioVerdict.firedAt)) as AlertLevel | null);
    const recentAlerts = await scenarioStore.getCashPriors(CASH_REHYDRATE_DATES);
    const walkAsOf = scenarioAsOf; // the one anchor above — `scenarioVerdict.date` is non-null here
    const { walkForward } = await import("../src/run-core.js");
    scenarioWalk = walkForward(
      {
        alert: scenarioVerdict,
        recentDialBands: seedBand != null ? [seedBand] : [],
        recentAlerts,
      },
      {
        // Scenario-DERIVED readings: states from the display panel, R4 tail levels from the
        // synthesized `hyOas`/`vt` knobs (every other level is 0 — states drive the rest).
        readings: readingsFromPanels(displayPanel.families, walkAsOf, (id) =>
          id === "F1" ? hyOas : id === "VT" ? vt : 0,
        ),
        lastPush: null,
        geoFlags: loadGeoActiveCount(),
        dial, // the SCENARIO dial
        globalFamilies: globalPanel.families, // the SCENARIO DIAL panel
        cissHistory,
        exposurePosture: null,
        fallShape: null, // the scenario path carries no persisted fall shape
      },
      walk,
    );
  }
  // ⚠ INCUMBENT/WALKED SPLIT: everything the board presents AS TODAY'S POSITION (`field.held`,
  // the rung rotated from, the re-risk countdown) reads the UN-WALKED verdict, NOT the walk endpoint.
  // The walk feeds the TRAJECTORY only — it reaches the wire as `walkPath` and nowhere else.
  const incumbentHeld = scenarioVerdict?.heldSleeve;
  const incumbentConfirm = scenarioVerdict?.reriskConfirmCount ?? 0;
  const incumbentHeldDays = scenarioVerdict?.heldDays ?? 0;
  // Growth maps read ONCE, shared by the pick field, served field and `resolveY1View` (scenario
  // twin of the live hoist in `handle`); both paths derive growth from the same real series.
  const scenarioLegGrowth = await loadLegGrowth(scenarioStore, warn);
  // `memberHistory` undefined ⇒ no momentum on the scenario path (`?hist` is live-only).
  const scenarioField = computeField(
    { globalFamilies: globalPanel.families, freshness: scenarioFreshness },
    dial.band,
    undefined,
    prevDialTargetOf(scenarioVerdict), // INCUMBENT: today's persisted dial target, not the walk endpoint
    cissHistory,
    // ⚠ Growth never reaches the pick (`pickHeld`), but these maps feed the SERVED growth value.
    scenarioLegGrowth.rs,
    scenarioLegGrowth.mom,
    undefined, // opts — no degrade sink on the /lab path
    dial.targetRung, // the ●: `rising` reads it, not the now-floating `band.hi`
  );
  // R1. Prior rung = the INHERITED LIVE hold (`prevTargetOf` over the verdict); `?? 0` on a null
  // verdict is the honest cold-start count.
  const scenarioR1 = resolveR1View(
    dial.targetRung,
    prevTargetOf(incumbentHeld),
    incumbentConfirm,
    incumbentHeldDays,
    // Trend veto off the SCENARIO panel (`?s=trend:RED` must move it) — same call shape run-core.ts
    // hands `decideRotationHold`, so /lab can never name a veto the engine is not applying.
    trendConfirming(buildMemberState({ globalFamilies: globalPanel.families, freshness: scenarioFreshness })),
  );
  // R5. Sized off the GATED held sleeve (the body's `gateHeld` result), not `scenarioVerdict?.heldSleeve`,
  // so the strip never names a different leg than the field highlights (cold-start falls back to the field's pick).
  const scenarioGatedHeld = gateHeld(scenarioField, incumbentHeld);
  const scenarioR5 = await resolveR5View(scenarioStore, scenarioGatedHeld?.sleeve);
  // Y1. Same gated sleeve as the incumbent, SCENARIO `dial.band` as the candidate cap.
  const scenarioY1 = await resolveY1View(
    scenarioStore,
    scenarioGatedHeld?.sleeve,
    dial.band,
    scenarioLegGrowth.bulk,
  );
  // SERVED field: a SECOND, PURE computeField fed the held-independent rs/mom maps so the growth
  // pillar goes live. `scenarioField` above (maps-less) stays the source of `scenarioGatedHeld`.
  const scenarioServedField = await toServedField(
    scenarioStore,
    scenarioY1
      ? computeField(
          { globalFamilies: globalPanel.families, freshness: scenarioFreshness },
          dial.band,
          undefined,
          prevDialTargetOf(scenarioVerdict), // INCUMBENT, must match `scenarioField` above
          cissHistory,
          scenarioY1.rs,
          scenarioY1.mom,
          undefined, // opts — no degrade sink on the /lab path
          dial.targetRung, // the ●: `rising` reads it, not the now-floating `band.hi`
        )
      : scenarioField,
    scenarioY1?.mom ?? new Map<string, number | null>(),
    scenarioGatedHeld,
  );
  const body: LabResponse = {
    ...usPanel,
    t1dial: dial,
    globalFamilies: displayPanel.families,
    // DIAL fold beside it: `/lab`'s member-level diffusion count reads THIS, the population the push counts.
    dialFamilies: globalPanel.families,
    dangerRoster: DANGER_ROSTER,
    field: scenarioServedField,
    feedLag: [...scenarioFeedLag], // footnote payload, `lag:` knob entries folded in
    freshnessMissing,
    // Always `[]`: a coverage degrade is about a PERSISTED RUN; served (not omitted) so the key's
    // presence never distinguishes the two paths for a renderer.
    coverage: [],
    // Build EXPLICITLY (not `...r4`) so computeR4's `entryFiredAt` never leaks onto the wire. `group`
    // attached HERE (the centralized wire-assignment seam); scenario carries no fallShape/vtp.
    overlays: {
      r4: {
        ...r4View({
          cash: r4.cash,
          phase: r4.phase,
          reentryRung: r4.reentryRung,
          hyOas,
          vt,
          reason: r4.reason,
        }),
        group: "decision-now",
      },
      // Key absent ⇒ no strip row (resolveR1View's silence rule).
      ...(scenarioR1 ? { r1: { ...scenarioR1, group: "decision-pending" as const } } : {}),
      // Key absent ⇒ no strip row, when there is no on-ladder held leg to size.
      ...(scenarioR5 ? { r5: { ...scenarioR5, group: "not-wired" as const } } : {}),
      // Key absent ⇒ no strip row, when there is no store to rank the nine legs over.
      ...(scenarioY1 ? { y1: { ...scenarioY1.view, group: "not-wired" as const } } : {}),
    },
    // Display-only per-leg growth RS; key ABSENT (like y1) when there is no store.
    ...(scenarioY1 ? { growthRs: scenarioY1.growthRs, lookbacksUsed: scenarioY1.lookbacksUsed } : {}),
    mode: "scenario",
    // FULL echo of what `parseScenario` accepted (states, overrides, knobs) so a deep-link never
    // applies an override the payload does not name.
    states: parsed.states,
    members: parsed.members,
    knobs: {
      tail: options.tail,
      sustained: options.sustained,
      daysInCash: options.daysInCash,
      lag: [...options.lag],
    },
    // Day 1..N leg path — present only when composed with `?walk=N` over a seedable store.
    ...(scenarioWalk ? { walkPath: scenarioWalk.legPath } : {}),
  };
  return body;
}

/** `labBody`'s `?replay=` branch: a 400 on a bad range, else the replayed path (store acquired after the parse). */
async function replayBody(
  raw: string,
  storeOf: () => ReadStore,
  { loadVintage, now, warn }: { loadVintage: () => Observation[] | undefined; now: Date; warn: (...args: unknown[]) => void },
): Promise<LabReplayBody | Response> {
  const parsed = parseReplay(raw, now.getTime());
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  const replayStore = storeOf();
  // Union of GLOBAL_FAMILIES member ids, off the STATIC table (no run-panel yet). One getSeries per
  // member in parallel, each degrading to [] (the cissHistory idiom). GLOBAL_FAMILIES not
  // DIAL_FAMILIES ON PURPOSE: this set drives the per-member `coverage` strip too; narrowing it
  // would blank the SLOW legs. `computeReplay` folds against DIAL_FAMILIES for the band itself.
  const memberIds = [...new Set(GLOBAL_FAMILIES.flatMap((f) => f.ids))];
  // limit = calendar days range-start→today + SERIES_FETCH_SLACK (R4 warm-up + publication lag);
  // a 10y window (~2,600 rows) stays under SupabaseStore's 5000 `max_rows` cap (store.ts getSeries).
  const limit =
    Math.floor((now.getTime() - Date.parse(parsed.start)) / MS_PER_CALENDAR_DAY) + SERIES_FETCH_SLACK;
  const memberSeries = await Promise.all(
    memberIds.map(async (id) => ({
      id,
      points: await getObservedSeries(replayStore, id, limit).catch((err: unknown) => {
        warn(`[lab] replay ${id} read failed - replayed as an absent member:`, err);
        return [];
      }),
    })),
  );
  // HY-OAS override: stored F1 rows begin after the earliest replay windows, so earlier days hit a
  // STRUCTURAL null HY level. The stitched feed (api/replay.ts) covers 1996→today. LEVEL only — F1
  // state stays the stored one (src/replay.ts `hyOasLevels` docblock). Degrade mirrors api/replay.ts:
  // a corrupt vintage + a stitch VIOLATION THROW → 500; an ABSENT vintage file or a MISSING stored input
  // degrades to the stored F1 behaviour + a note, never a 500, never an upstream fetch (api/no-upstream-fetch.test.ts).
  // WINDOW GATE: a range wholly inside stored F1 coverage skips the input read. Bound READ OFF THE
  // DATA (the stored member's own first obs in `memberSeries`), never a restated date literal.
  const replayNotes: string[] = [];
  const storedF1First = memberSeries.find((m) => m.id === "F1")?.points[0]?.date ?? null;
  // `null` (no stored F1 rows) can NEVER skip: the darkest window there is.
  const windowNeedsStitch = storedF1First === null || storedF1First > parsed.start;
  let hyOasLevels: readonly Observation[] | undefined;
  if (windowNeedsStitch) {
    const vintage = loadVintage(); // fail-loud: a corrupt/short vintage throws → 500; an absent file → undefined
    // Cron-persisted raw rows (src/input-series.ts): absent rows are caught (degrade), the stitch is NOT.
    const storedTail =
      vintage === undefined
        ? undefined
        : (await readInputSeries(replayStore, ["BAMLH0A0HYM2"], HY_INPUT_ROW_LIMIT, { now })).get("BAMLH0A0HYM2");
    if (vintage === undefined) {
      warn("[lab:replay] HY-OAS vintage file absent - R4 serves the stored F1 series");
      replayNotes.push(
        "HY-OAS history unavailable - R4 fell back to the STORED F1 series, which is dark before its first stored close.",
      );
    } else if (storedTail === undefined) {
      warnMissingInput("BAMLH0A0HYM2", "lab:replay", warn);
      replayNotes.push(
        "HY-OAS live tail unavailable - R4 fell back to the STORED F1 series, which is dark before its first stored close.",
      );
    } else {
      hyOasLevels = stitchHyOas(vintage, storedTail);
    }
  }
  const { points, coverage, notes } = computeReplay(
    memberSeries,
    { start: parsed.start, end: parsed.end },
    { hyOasLevels },
  );
  notes.push(...replayNotes);
  return { mode: "replay", start: parsed.start, end: parsed.end, points, coverage, notes };
}

// The read-handler idiom: a store THUNK, resolved only after the param 400s (and never on `?replay`'s
// shared hoist). A throwing `storeOf` is getStore's fail-loud on a missing SUPABASE_URL/SERVICE_KEY.
export async function handle(storeOf: () => ReadStore, request: Request | undefined, opts: LabSeams = {}): Promise<Response> {
  const params = parseLabParams(request);
  if (params instanceof Response) return params;
  // Every mode serves through `serveRedactable`; the body's own policy (a store degrade) is read once it settles.
  let publicHeaders: Readonly<Record<string, string>> = VINTAGE_HEADERS;
  const bodyP = labBody(storeOf, params.url, params, opts).then((built) => {
    if (built instanceof Response) return built;
    publicHeaders = built.publicHeaders;
    return built.body;
  });
  return serveRedactable(bodyP, redactLab, { publicHeaders: () => publicHeaders });
}

/** The FULL body (withheld fields in place) past the same param 400s — never served. Exported so a suite asserting
 *  on the redactable fields reads them before `handle`'s response rule (the `exposureBody` pattern). */
export async function labFullBody(storeOf: () => ReadStore, request: Request | undefined, opts: LabSeams = {}): Promise<LabBody | Response> {
  const params = parseLabParams(request);
  if (params instanceof Response) return params;
  const built = await labBody(storeOf, params.url, params, opts);
  return built instanceof Response ? built : built.body;
}

/** `handle`'s param 400s (all of them, above any store read) — or the parsed modes `labBody` builds from. */
function parseLabParams(request: Request | undefined): LabParams | Response {
  const url = request?.url ? new URL(request.url) : undefined;
  if (url) {
    const unknown = rejectUnknownParams(url.searchParams, ["walk", "s", "replay", "hist"]);
    if (unknown) return unknown;
  }
  // `?walk=N` composes with `?s=`, not `?replay`. 0/absent ⇒ every path below is byte-untouched.
  const parsedWalk = parseWalk(url?.searchParams.get("walk"));
  // Reject ABOVE the store read: an over-cap walk costs a 400, not a read.
  if (parsedWalk instanceof Response) return parsedWalk;
  const walk = parsedWalk;
  // Live-only `?hist` (`?s`/`?replay` ignore it): an off-grid N 400s here, above the freshness stamp
  // and every other store read — a free N must never buy a single read.
  const isLive = !url?.searchParams.has("s") && !url?.searchParams.has("replay");
  const hist = isLive ? parseHist(url?.searchParams.get("hist")) : 0;
  if (hist instanceof Response) return hist;
  if (url?.searchParams.has("s") && url.searchParams.has("replay")) {
    return Response.json({ error: "?s and ?replay are mutually exclusive modes" }, { status: 400 });
  }
  // Parse ABOVE the freshness hoist so a malformed `?s=` 400s before paying the store reads.
  const parsedScenario = url?.searchParams.has("s")
    ? parseScenario(url.searchParams.get("s") ?? "")
    : undefined;
  if (parsedScenario && "error" in parsedScenario) {
    return Response.json({ error: parsedScenario.error }, { status: 400 });
  }
  return { url, walk, hist, parsedScenario };
}

/** `handle` past its param 400s: the mode's RAW body (withheld fields included) and its response headers. */
async function labBody(
  storeOf: () => ReadStore,
  url: URL | undefined,
  { walk, hist, parsedScenario }: { walk: number; hist: number; parsedScenario: Exclude<ReturnType<typeof parseScenario>, { error: string }> | undefined },
  opts: LabSeams,
): Promise<Built | Response> {
  const { vintage: loadVintage = loadHyOasVintage, now = new Date(), warn = console.warn } = opts;
  // Freshness stamp read for BOTH the `?s=` branch (which returns before the live path reads the
  // store) and the live path: stamping only the live calls would break the `scenario.field` deep-equals `live.field`
  // parity pin (api/lab.test.ts). Store handle SHARED downstream — `storeOf` (getStore) is not memoized.
  // Skipped on `?replay` (no danger field).
  let freshness: readonly MemberFreshness[] | undefined;
  let feedLag: readonly FeedLagNote[] = [];
  // `freshnessMissing`: true = NO stamp behind the `observed` census (read threw or no store);
  // false = stamp read (whatever it found). The board must degrade, never 500.
  let freshnessMissing = false;
  let sharedStore: ReadStore | null = null;
  let sharedStoreError: unknown = null;
  // STARTED here, AWAITED by `applyStamp` at each branch's first use: on the live path the stamp (the
  // slowest read, ~2.4s on prod) overlaps the verdict-keyed waves below instead of preceding them.
  let stampP: Promise<FreshnessStamp | undefined> | undefined;
  if (!url?.searchParams.has("replay")) {
    try {
      sharedStore = storeOf();
    } catch (err) {
      sharedStoreError = err; // reported loudly by the scenario branch / rethrown by the live path
    }
    stampP = sharedStore
      ? freshnessFrom(sharedStore, now, warn).catch((err: unknown) => {
          warn(
            "[lab] freshness stamp UNAVAILABLE - the observed census carries no measurement " +
              "(serving freshnessMissing: true). Cause:",
            err,
          );
          return undefined;
        })
      : Promise.resolve(undefined);
  }
  const applyStamp = async (): Promise<void> => {
    if (!stampP) return;
    const stamp = await stampP;
    freshness = stamp?.freshness;
    feedLag = stamp?.lag ?? [];
    freshnessMissing = stamp === undefined; // covers both a thrown read and no store
  };
  if (parsedScenario) {
    await applyStamp();
    // Per-input, never edge-cached.
    const body = await scenarioBody(parsedScenario, {
      scenarioStore: sharedStore, // one `storeOf()` per request, acquired by the hoist above
      sharedStoreError,
      freshness,
      feedLag,
      freshnessMissing,
      walk,
      now,
      warn,
    });
    return { body, publicHeaders: { "Cache-Control": "no-store" } };
  }

  // Replay path: the SAME pure pipeline advanced one historical close at a time over caller-fetched
  // stored series (src/replay.ts). BEFORE the live getLastAlert() — replay needs NO verdict.
  if (url?.searchParams.has("replay")) {
    const body = await replayBody(url.searchParams.get("replay") ?? "", storeOf, { loadVintage, now, warn });
    // A past range is stable between backfills ⇒ longer edge window than the live snapshot; per-query-string keyed.
    return body instanceof Response ? body : { body, publicHeaders: { "Cache-Control": "s-maxage=600" } };
  }

  // Reuses the hoist's handle; the `??` re-acquires (and still THROWS) when the hoist was skipped —
  // the live path must keep failing loud.
  const store = sharedStore ?? storeOf();
  // READ WAVES: wave 0 = every verdict-independent read (+ the stamp above), wave 1 = the `firedAt`/
  // panel-keyed reads. Each is `prefetch`ed and still AWAITED at its original site, so a failing read
  // surfaces exactly where it did when serial (same 404/500 precedence, same degrades).
  // `withPanel`: /api/lab is the ONE reader of persisted `panel_state` (served off `verdict.panelState`);
  // a null panel triggers the degraded fallback, an ABSENT one would break it, so this read must be wide.
  const eodVerdictP = store.getLastAlert({ withPanel: true });
  // L1 (a retired plan): a NEWER daytime verdict in the `intraday_verdict`
  // slot IS the served verdict (`servedVerdict`, shared with `/status` + `/api/exposure`) — its own readings
  // (`getReadingsForRun(firedAt)`), panel, dial, floors and field. The EOD row stays what the push and every
  // notify baseline read. A failed slot read degrades to the EOD row (never a 500); a stale slot is ignored.
  const intradayVerdictP = prefetch(readIntradaySlot(store, "lab"));
  const recentAlertsP = walk > 0 ? prefetch(store.getCashPriors(CASH_REHYDRATE_DATES)) : null;
  const liveLegGrowthP = prefetch(loadLegGrowth(store, warn));
  const since365 = isoDay(new Date(now.getTime() - 365 * MS_PER_CALENDAR_DAY));
  // The two NAV series share one window ⇒ one getSeriesBulk round trip; overrides + alerts stay their own reads.
  const scoreboardReadsP = prefetch(
    Promise.all([
      store.getSeriesBulk([SB_STRAT_ID, SB_BENCH_ID], { limit: SCOREBOARD_WINDOW }),
      store.getOverrides(since365),
      store.getAlertsSince(since365),
    ]),
  );
  const vtpOverlayP = prefetch(resolveVixPersistenceView(store));
  const eodVerdict = await eodVerdictP;
  if (!eodVerdict) {
    await applyStamp();
    return Response.json({ error: "no runs recorded yet" }, { status: 404 });
  }
  const intradayVerdict = await intradayVerdictP;
  const verdict = servedVerdict(eodVerdict, intradayVerdict) ?? eodVerdict;
  const provisionalVerdict = verdict !== eodVerdict;
  const pruneEvent = eodVerdict.degraded?.find((e) => e.scope === PRUNE_DEGRADE_SCOPE);

  // Wave 1.
  const rawReadingsP = prefetch(store.getReadingsForRun(verdict.firedAt));
  const seedBandP =
    walk > 0 && verdict.dialBand == null ? prefetch(store.getLastBandBefore("dialBand", verdict.firedAt)) : null;
  // The two member-keyed reads, over the DISPLAY panel (`?hist`) and DISPLAY ∪ DIAL panels (newest close).
  const memberReads = (displayPanel: FamilyPanel[], dialPanel: FamilyPanel[]) => {
    const memberIds = [...new Set([...displayPanel, ...dialPanel].flatMap((f) => f.members.map((m) => m.id)))];
    return {
      history:
        hist > 0
          ? prefetch(
              Promise.all(
                [...new Set(displayPanel.flatMap((f) => f.members.map((m) => m.id)))].map(
                  async (id) => ({ id, history: await getObservedSeries(store, id, hist + LOOKBACK_PAD) }),
                ),
              ),
            )
          : undefined,
      // Four rows: `notifyGapDates` judges the newest only with its previous session inside the read — a non-session row between pushes it out at 2.
      newest: prefetch(store.getSeriesBulk(memberIds, { limit: 4 })),
    };
  };
  // A PERSISTED panel is known now ⇒ wave 1; a legacy null panel waits for `assembleDial` below.
  const earlyMemberReads = verdict.panelState
    ? memberReads((verdict.displayPanelState ?? verdict.panelState).displayPanel, verdict.panelState.globalPanel)
    : null;

  // Reduce the run's readings to {id, state}. No isInternalSeries filter (families.ts whitelists by
  // member id): Geopolitics [G1] + Complacency [price-accel, complacency-*] map formerly off-ladder
  // ids onto the board by id. PENSION + the VIX/VIX3M capitulation subsystem stay excluded by OMISSION.
  const rawReadings = await rawReadingsP;
  await applyStamp();
  // `lag` off the hoisted `freshness` (per-id `assessIndicatorFreshness`, the SAME `lagCutFor` seam the
  // cron stamps with). Feeds `FamilyPanel.coverageDegraded` (R5). ⚠ REQUEST-clock stamp — the
  // AUTHORITATIVE record is the persisted `bandReason`, not this read-time re-derivation; a degraded
  // read (`freshness === undefined`) leaves every row NOT ASSESSED (fail-toward-not-arming).
  const lagOf = new Map((freshness ?? []).map((f) => [f.id, f.lag]));
  const readings = rawReadings.map((r) => ({
    id: r.indicatorId,
    state: r.state,
    rawState: r.rawState, // serve-time fold badge: `resolveServedPanels` marks a mid-stand-down member.
    lag: lagOf.get(r.indicatorId),
    // The row's OWN obs date (`toStoredReadings`), NOT the run's `asOf`; `computeLegAttribution`
    // anchors its fidelity gate on this per-id date.
    date: r.date,
    label: LABEL_OF[r.indicatorId],
    longLabel: LONG_LABEL_OF[r.indicatorId],
    // `geoFactor` tag the diffusion count collapses over (R2); absent ⇒ counts as its own factor.
    factor: FACTOR_OF[r.indicatorId],
  }));
  // Level-vs-velocity attribution for the firing dual-axis ids. Display-only (feeds none of band/dial/
  // field), so `bandReason` stays what run-core.ts persisted. Never throws — a degrade drops entries.
  const legResultP = computeLegAttribution(store, readings, verdict.firedAt).catch((err: unknown) => {
    warn("[lab] leg attribution failed - served empty, degraded:", err);
    return { attribution: [] as LegAttribution[], degraded: true };
  });
  // Raw level lookup for the two tail-context reads beside R4 (F1 = HY-OAS, VT ratio).
  const level = (id: string): number | null =>
    rawReadings.find((r) => r.indicatorId === id)?.value ?? null;

  // Veto fields from the frozen US_FAMILIES panel (board/veto + top-level `families`).
  // ⚠ NEVER diff a dial headline against this field: US-only, so it can read GREEN for a family the
  // dial reports `armed` (e.g. rates primed by BUND, absent from US_FAMILIES). The dial folds
  // DIAL_FAMILIES, the board paints SERVED `globalFamilies` (= `displayFamilies`, the full fold — NOT
  // the local `globalFamilies` binding below). Nothing reads this field except public/lab.js's
  // empty-panel fallback.
  const usPanel = computeFamilyPanel(readings, US_FAMILIES);
  // `globalFamilies` = the DIAL panel (DIAL_FAMILIES), feeds computeField. `displayFamilies` = the
  // full GLOBAL_FAMILIES fold, SERVED as `globalFamilies` (B-11: the SLOW legs stay VISIBLE). `dial`
  // is NOT destructured — the live path serves the PERSISTED dial (C1 persist-assembled-dial).
  // Stage C′: serve the four consumed fields off PERSISTED `panel_state` on the served row, so the
  // common path SKIPS `assembleDial`. A null `panelState` (legacy/no-panel row) DEGRADES to a fresh
  // `assembleDial` with the SAME cron member-carry, resolving at the first post-deploy cron. Scenario/
  // replay/hist returned above never reach here.
  const notifyPanel =
    verdict.panelState ??
    (await assembleDial({
      readings,
      asOf: verdict.date,
      store,
      carryLagCutById: LAB_CARRY_LAG_CUT_BY_ID,
    }));
  const { globalPanel: globalFamilies, cissHistory, heldMemberState } = notifyPanel;
  // E12: board/pick/headline read the DISPLAY
  // twin (estimate heads folded in); band chain, walk, R1 and `dialFamilies` stay on the notify panel above.
  const displayPanelState = verdict.displayPanelState ?? notifyPanel;
  const displayFamilies = displayPanelState.displayPanel;
  // C1 (persist-assembled-dial): hydrate the `T1DialResult` persisted to `alert_log.dial_state` on
  // the served row — the live dial IS the pushed dial. A null `dialState` (legacy row) falls back
  // through the SAME helper to a fresh `computeT1Dial`, consuming `heldMemberState` straight off this
  // request's `assembleDial` return. The legacy arm is NOT deleted — legacy rows must still render.
  const dial = hydrateOrComputeT1Dial(
    verdict.dialState,
    globalFamilies,
    techConfirmerBreadth(techConfirmerFromPanel(globalFamilies, undefined, heldMemberState)),
  );
  // E12: `displayDialState ?? dialState` — a legacy (null) row serves the notify dial unchanged.
  const displayDial = verdict.displayDialState ? hydrateOrComputeT1Dial(verdict.displayDialState, displayPanelState.globalPanel) : dial;
  const displayDialFamilies = displayPanelState.globalPanel;
  const displayCissHistory = displayPanelState.cissHistory;

  // Wave-1 member reads, or (legacy null panel) started now off the freshly assembled panels.
  const { history: memberHistoryP, newest: newestCloseP } =
    earlyMemberReads ?? memberReads(displayFamilies, globalFamilies);
  // View-C momentum window (`?hist=N`): each DISPLAY-panel member's last N+PAD observations, read IN
  // PARALLEL (B-11: covers the SLOW legs too). Absent / 0 ⇒ omitted; scenario never reaches here.
  const memberHistory = memberHistoryP ? await memberHistoryP : undefined;

  // Downside-break detectors: re-read the DB_* rows this run persisted, map each to its visible id
  // ("SMH"/"XLK"). Consumes the persisted `.state` — no read-time re-score. Rows absent ⇒ [].
  const downsideDetectors = DOWNSIDE_DETECTORS.map((d) => {
    const r = rawReadings.find((x) => x.indicatorId === d.indicator.id);
    return r ? { id: d.id, state: r.state } : null;
  }).filter((x): x is { id: (typeof DOWNSIDE_DETECTORS)[number]["id"]; state: State } => x !== null);

  // Forward walk (`?walk=N`): seed day-0 from the prod reads above and FREEZE today's conditions,
  // advancing N calendar days so every delayed action resolves. Read-only (no recordRun, no push).
  // `walkedVerdict` is computed AFTER the day-0 reads so the seed is the ORIGINAL verdict.
  let walkResult: WalkForwardResult | null = null;
  if (walk > 0) {
    const seedBand: AlertLevel | null =
      verdict.dialBand ?? ((await seedBandP) as AlertLevel | null);
    const recentAlerts = await recentAlertsP!;
    const { walkForward } = await import("../src/run-core.js");
    walkResult = walkForward(
      {
        alert: verdict,
        recentDialBands: seedBand != null ? [seedBand] : [],
        recentAlerts,
      },
      {
        readings: reconstructReadings(rawReadings),
        lastPush: null, // v1 is notify-free — no re-fire baseline needed
        // Active MANUAL geo flags (config.json), the count the cron feeds `computeAlertBand`; auto G1 oil rides in `readings`.
        geoFlags: loadGeoActiveCount(),
        dial,
        globalFamilies, // the DIAL panel assembleDial fed computeT1Dial (mirrors the cron)
        cissHistory,
        exposurePosture: null, // v1: /lab never sizes exposure; affects only the discarded notify message
        // Rebuilt from persisted alert columns. STEERS the walk: `applyFallShape` suppresses the cash
        // overlay on any `v-shaped` day. v1 LIMITATION: the seed verdict is frozen for all N days.
        fallShape: {
          shape: verdict.fallShape,
          velocity: verdict.fallVelocity,
          dwell: verdict.creditDwellCloses,
          reason: "frozen from persisted alert (walk)",
        },
      },
      walk,
    );
  }
  // Day-N verdict: the walked endpoint alert merged over the seed verdict (untouched fields keep their
  // persisted value). `walk===0` ⇒ the seed verdict.
  const walkedVerdict = walkResult ? { ...verdict, ...walkResult.final.alert } : verdict;

  // Field over the live panel + live dial band. `memberHistory` (server-only) only when `?hist=N`. prevTarget +
  // M5-gated held via the SHARED `prevDialTargetOf`/`gateHeld` the scenario path also calls (a live-only
  // copy is the divergence the scenario↔live deep-equal forbids). `freshness` rides BOTH live sites.
  // Growth maps read ONCE (live twin of the scenario hoist), shared by the pick/served field and `resolveY1View`.
  const liveLegGrowth = await liveLegGrowthP;
  const liveField = computeField(
    { globalFamilies: displayDialFamilies, freshness },
    displayDial.band,
    memberHistory,
    prevDialTargetOf(walkedVerdict),
    displayCissHistory,
    // ⚠ Growth never reaches the pick (`pickHeld`), but these maps feed the SERVED growth value.
    liveLegGrowth.rs,
    liveLegGrowth.mom,
    undefined, // opts — no degrade sink on the /lab path
    displayDial.targetRung, // the ●: `rising` reads it, not the now-floating `band.hi`
  );
  const gatedHeld = gateHeld(liveField, walkedVerdict.heldSleeve);

  // Scoreboard (live path ONLY): pure display math over persisted SB NAV rows + trailing-365d
  // overrides + alert slices (wave 0). No writes/re-score. Zero rows ⇒ the honest `warmingUp: true` shape.
  const [sbNav, sbOverrides, sbAlerts] = await scoreboardReadsP;
  const legResult = await legResultP;
  const legAttribution = legResult.attribution;
  // A store-degrade must not be day-cached as the vintage — rides DEGRADED_HEADERS below like `freshnessMissing`.
  const degraded = legResult.degraded;

  // R1. Pure + synchronous: inputs in hand (dial target, persisted held via SHARED `prevTargetOf`,
  // confirm count). Returns null (key omitted) on the no-walk majority.
  const r1Overlay = resolveR1View(
    dial.targetRung,
    prevTargetOf(walkedVerdict.heldSleeve),
    walkedVerdict.reriskConfirmCount,
    walkedVerdict.heldDays,
    // Live trend veto — same call `run-core.ts` hands `decideRotationHold`, over the folded dial panel.
    trendConfirming(buildMemberState({ globalFamilies, freshness })),
  );

  // R5. Sized off `gatedHeld` (the sleeve the field highlights), so strip and board never name
  // different legs. One `getSeries` on the held leg's `LEGP_*` history, overlapping Y1 + the served field.
  const r5OverlayP = prefetch(resolveR5View(store, gatedHeld?.sleeve));

  // Y1. Incumbent = the same `gatedHeld` sleeve. One `getSeriesBulk` over all nine `LEGP_*` ids.
  const y1Overlay = await resolveY1View(store, gatedHeld?.sleeve, displayDial.band, liveLegGrowth.bulk);

  // SERVED field: a SECOND, PURE computeField fed the held-independent rs/mom maps so the growth
  // pillar goes live. `liveField` above (maps-less) stays the source of `gatedHeld`.
  const liveServedField = await toServedField(
    store,
    y1Overlay
      ? computeField(
          { globalFamilies: displayDialFamilies, freshness },
          displayDial.band,
          memberHistory,
          prevDialTargetOf(walkedVerdict),
          displayCissHistory,
          y1Overlay.rs,
          y1Overlay.mom,
          undefined, // opts — no degrade sink on the /lab path
          displayDial.targetRung, // the ●: `rising` reads it, not the now-floating `band.hi`
        )
      : liveField,
    y1Overlay?.mom ?? new Map<string, number | null>(),
    gatedHeld,
  );
  const r5Overlay = await r5OverlayP;

  // R3. Chart-only VIX-backwardation streak, READ from persisted `VTP`. Display-only + unweighted
  // (feeds neither band nor family); degrades to null (key omitted) when no VTP is stored.
  const vtpOverlay = await vtpOverlayP;

  // `estimateAnchored`: a NAV estimate whose previous session holds no FINAL row is a gap (the persist sweep's rule).
  const anchoredNav = (id: string) => {
    const nav = sbNav.get(id) ?? [];
    const unanchored = new Set(unanchoredEstimateDates(id, nav));
    return nav.filter((p) => !unanchored.has(p.date));
  };
  const scoreboard = computeScoreboard(
    anchoredNav(SB_STRAT_ID),
    anchoredNav(SB_BENCH_ID),
    sbOverrides,
    sbAlerts,
    now,
  );

  // Served member rows (`resolveServedPanels`): MUST stay AFTER computeField/dial — band/bandReason stay UNTOUCHED.
  const served = {
    runRows: rawReadings,
    newestRows: await newestCloseP,
    asOf: walkedVerdict.date,
    verdict: { firedAt: verdict.firedAt, provisional: provisionalVerdict },
  };
  const displayFamiliesServed = resolveServedPanels(displayFamilies, true, served);
  const dialFamiliesServed = resolveServedPanels(globalFamilies, false, served);

  const body: LabResponse = {
    ...usPanel,
    t1dial: displayDial,
    globalFamilies: displayFamiliesServed, // the DISPLAY panel (B-11)
    // The DIAL fold served in its OWN field — the population the pushed body counts; `/lab`'s
    // member-level diffusion count reads this one.
    dialFamilies: dialFamiliesServed,
    dangerRoster: DANGER_ROSTER,
    field: liveServedField,
    feedLag: [...feedLag], // grid footnote (`◌` marks); `[]` when nothing marked or the read degraded
    freshnessMissing, // tells the two `[]` cases apart (see the hoist)
    // Coverage degrades projected STRAIGHT off the alert row's structured `degraded[].coverage`
    // (run-cycle-dial.ts's `[coverage]` emitter) — no scope-string parsing. `[]` on a clean run.
    coverage: (verdict.degraded ?? []).flatMap((d) => (d.coverage ? [d.coverage] : [])),
    downsideDetectors,
    // PERSISTED R4 state (verdict.r4* columns) + tail levels, no read-time recompute. `group` attached
    // HERE (centralized wire-assignment seam): decision-now = r4 + fallShape; decision-pending = r1;
    // not-wired = r5/y1/vtp. The FE (public/overlay-strip.js) groups by `view.group`.
    overlays: {
      // RAW HY OAS + fall velocity fields: `redactLab` withholds them from the served body.
      r4: {
        ...r4View({
          cash: walkedVerdict.r4Phase === "cash",
          phase: walkedVerdict.r4Phase,
          reentryRung: walkedVerdict.r4ReentryRung,
          hyOas: level("F1"),
          vt: level("VT"),
          reason: "",
        }),
        group: "decision-now",
      },
      // Key absent ⇒ no strip row, on every close with no walk (see resolveR1View).
      ...(r1Overlay ? { r1: { ...r1Overlay, group: "decision-pending" as const } } : {}),
      // Key absent ⇒ no strip row, when there is no on-ladder held leg to size.
      ...(r5Overlay ? { r5: { ...r5Overlay, group: "not-wired" as const } } : {}),
      // Key absent ⇒ no strip row (live path always has a store, so unconditional here).
      ...(y1Overlay ? { y1: { ...y1Overlay.view, group: "not-wired" as const } } : {}),
      // PERSISTED fall-shape class, off the same alert row (fallShapeView). LIVE ONLY.
      fallShape: {
        ...fallShapeView(walkedVerdict.fallShape, walkedVerdict.fallVelocity, walkedVerdict.creditDwellCloses),
        group: "decision-now",
      },
      // R3 VIX-backwardation streak. Key ABSENT ⇒ no strip row, when no `VTP` is stored. Display-only.
      ...(vtpOverlay ? { vtp: { ...vtpOverlay, group: "not-wired" as const } } : {}),
    },
    mode: "live",
    asOf: walkedVerdict.date,
    firedAt: walkedVerdict.firedAt,
    // L1/L3: set iff the served verdict is the daytime `intraday_verdict` slot — the floors strip, board head
    // and ledger head carry the `INTRADAY · <date>` chip (as does `/status`'s head); the push is still the EOD row.
    ...(provisionalVerdict ? { provisional: true as const } : {}),
    // Off `eodVerdict`, never the daytime slot: only an EOD run prunes (run-cycle-persist.ts). Key ABSENT on a clean prune.
    ...(pruneEvent ? { pruneFailed: { firedAt: eodVerdict.firedAt, reason: pruneEvent.reason } } : {}),
    // Persisted band-reason, read straight off the alert row — never re-derived. Live-only (the
    // scenario path shows the raw dial band, no persisted notify decision).
    bandReason: walkedVerdict.bandReason,
    // LIVE-ONLY BAND drill-down: a read-time recompute of the escalator floors (`buildLabBand`) over
    // the notify path's inputs. `level`/`chain.band` reuse the persisted pushed band (bandReason
    // discipline); `source`/`floors` are the recompute. ABSENT on scenario/replay. `withFallShapeChips`
    // adds fall-shape + confidence chips to the r4 floor head when the breaker is OFF the ladder.
    // The r4 HY OAS row's `value` is the raw F1 level — `redactLab` nulls it in the served body.
    band: withFallShapeChips(
        buildLabBand(
          dial,
          reconstructReadings(rawReadings),
          loadGeoActiveCount(),
          walkedVerdict.r4Phase ?? "equity",
          walkedVerdict.level,
          undefined, // crisisStage — the live committed config, as before
          // R6: the PRE-FLOOR dial band, off the SAME row as `level`. `null` (dial-less row) ⇒ undefined
          // ⇒ buildLabBand's own `regimeToBand(dial.notifyRegime)`.
          walkedVerdict.dialBand ?? undefined,
          // COVERAGE floor, judged over `globalFamilies` so /lab and notify arm it over the identical
          // panel. ⚠ Only the panel is identical: peer rows differ (cron's `readings` vs this path's
          // RECONSTRUCTED served readings), both calm-ward. `someDailyFeedFresh` reads the same `lag`
          // field (the request-clock stamp hoisted above, NOT a second threshold).
          coverageArmed(
            globalFamilies,
            readings.map((r) => ({ cadence: CADENCE_OF.get(r.id), lag: r.lag })),
          ),
          // The panel again, for the floor's synthetic member ROWS only (buildLabBand never re-derives the LEVEL from it).
          globalFamilies,
          // PERSISTED calm streak; a null (pre-migration) becomes undefined ⇒ buildLabBand's assume-calm default.
          walkedVerdict.geoCalmStreak ?? undefined,
        ),
        walkedVerdict.r4Phase ?? "equity",
        walkedVerdict.fallShape,
        walkedVerdict.fallVelocity,
        walkedVerdict.creditDwellCloses,
      ),
    // PERSISTED cash overlay, read off the alert row — never re-derived (the trigger is a stateful
    // `targetRung` window). `cashOverlay.level` is the overlay's OWN magnitude ('off'|'partial');
    // 'full' is R4's in `overlays.r4` — `resolveCash` is the one place they merge.
    cashOverlay: {
      level: walkedVerdict.cashOverlay,
      since: walkedVerdict.cashOverlaySince,
      reason: walkedVerdict.cashOverlayReason,
    },
    legAttribution,
    // Display-only per-leg growth RS (Y1 resolver ranked); live path always has a store ⇒ unconditional,
    // mirroring the scenario path's absent-when-storeless shape to keep the two keys in lockstep.
    ...(y1Overlay ? { growthRs: y1Overlay.growthRs, lookbacksUsed: y1Overlay.lookbacksUsed } : {}),
    scoreboard,
    // Day 1..N leg path — present ONLY when walked. Endpoint already rides the fields above.
    ...(walkResult ? { walkPath: walkResult.legPath } : {}),
  };

  // Same vintage policy as /status (panel moves once per weekday; the cron's `VINTAGE_TAG` purge is
  // the bust). A store-failure degrade (`freshnessMissing` OR `degraded`) rides `DEGRADED_HEADERS`
  // (s-maxage=60) so the edge retries once a minute and a recovered store replaces it within a minute.
  return { body, publicHeaders: freshnessMissing || degraded ? DEGRADED_HEADERS : VINTAGE_HEADERS };
}

