// GET /api/status (openapi.yaml `getStatus`): any value needing re-scoring is PERSISTED at cron time, never recomputed here.
// A new nullable read-path column needs its prod migration applied BEFORE these api/*.ts deploy, else getLastAlert errors.
import { assessFreshness, assessIndicatorFreshness, LAG_THRESHOLDS, lagCutFor, type Freshness } from "../src/ladder.js";
import { feedCalendarTodayResolver } from "../src/dates.js";
import { CADENCE_OF, DEEP_LAG_MULTIPLE, freshnessFrom, LAG_CUT_OF, lagTier, type FreshnessStamp } from "../src/feed-lag.js";
import { intradayOverlay, isProvisional, readIntradaySlot, servedVerdict } from "../src/intraday.js";
import { lastPrintTag } from "../src/last-print.js";
import { getStore, type SeriesPoint, type ReadStore } from "../src/store.js";
import type { FeedLagRow, ReadingDTO, StatusResponse } from "../src/api/types.js";
import {
  META,
  rejectUnknownParams,
  serveRedactable,
} from "../src/api/http.js";
import { computeCapeValuation, VAL_Z_WINDOW, type CapeObs } from "../src/valuation.js";
import type { Cadence } from "../src/domain-types.js";
import { cardGroupOf } from "../src/families.js";
import { isLicensedEstimateId, isLicensedId } from "../src/licensed.js";
import { trailingReturnAt } from "../src/scorers-core.js";

// F7 rows beyond VAL_Z_WINDOW — too few and `computeCapeValuation` degrades (no CAPE card that run).
const CAPE_SERIES_PAD = 24;

// Internal run rows that must NEVER surface as a Dashboard card (prefix-matched).
// Never add DB_: DB_SMH is a display Trend card.
const INTERNAL_SERIES_PREFIXES = ["SB_", "CMP_"];
const isInternalSeries = (id: string): boolean =>
  INTERNAL_SERIES_PREFIXES.some((p) => id.startsWith(p));

const RETURN_WINDOW = 20;
const ETF_CARD_IDS = [...META.keys()].filter((id) => cardGroupOf(id) === "pension-drawdown");
// R7a: a PENSION / ETFs-card row's level, Δ20 and 20d return are restricted — always served null.
const ETF_CARD_SET = new Set(ETF_CARD_IDS);
const hidesLevel = (id: string): boolean => META.get(id)?.channel === "PENSION" || ETF_CARD_SET.has(id);

// Defined in src/registry.ts (src/ cannot import api/); re-exported to keep /api/series' import path.
export { PLACEHOLDER_STATE_IDS } from "../src/registry-price.js";
import { PLACEHOLDER_STATE_IDS } from "../src/registry-price.js";
/** Chart-only ids scored by `thresholds: {}` (GREEN always): `valueOnly` on card + chart, never `PLACEHOLDER_STATE_IDS` (that set also gates the band). */
export const CUTLESS_CHART_IDS: ReadonlySet<string> = new Set(["VXSMH", "VXNCLS", "T10Y3M_RAW"]);
import { dashboardUrl, readEnv, type Env } from "../src/config.js";

/** Vercel entry: request-only — never add a 2nd param (a platform-passed one would be mistaken for a store). */
export async function GET(request?: Request): Promise<Response> {
  const env = readEnv();
  return handle(() => getStore("ro", env), request, { env });
}

// `freshness`: the stamp reader seam (default `freshnessFrom`) — a test not asserting freshness passes `async () => undefined`.
type StatusSeams = { env: Env; now?: Date; freshness?: (store: ReadStore, now: Date) => Promise<FreshnessStamp | undefined>; warn?: (...args: unknown[]) => void };

/** A level is served iff it is neither a PENSION/ETFs-card row nor a restricted id (src/licensed.ts). */
const passesRedaction = (id: string): boolean => !hidesLevel(id) && !isLicensedId(id);

/** The served `/status` body from the FULL one: restricted reading levels (value/delta20/return20d) and the verdict's
 *  VIXCLS/VXVCLS levels null; `ratio` is a 2-input derived value and stays. `licensedEstimates` = the readings of
 *  THIS body whose served row is an estimate carried over a licensed lead (`isLicensedEstimateId`) — nulled the same
 *  way; the body cannot tell them apart itself (`estimated` is a card label, absent on an EOD run's own estimate row).
 *  Pure — `serveRedactable`'s redact. */
export function redactStatus(raw: StatusResponse, licensedEstimates: { has(r: ReadingDTO): boolean }): StatusResponse {
  return {
    ...raw,
    verdict: { ...raw.verdict, vix: null, vix3m: null, fallVelocity: null },
    readings: raw.readings.map((r) =>
      passesRedaction(r.indicatorId) && !licensedEstimates.has(r)
        ? r
        : { ...r, value: null, delta20: null, ...(r.return20d !== undefined ? { return20d: null } : {}) },
    ),
  };
}

// Resolve the store THUNK only AFTER the param check, so an unknown-param 400 never touches Supabase env.
export async function handle(
  storeOf: () => ReadStore,
  request: Request | undefined,
  opts: StatusSeams,
): Promise<Response> {
  const params = request?.url ? new URL(request.url).searchParams : new URLSearchParams();
  const unknown = rejectUnknownParams(params, []);
  if (unknown) return unknown;
  // The 24h SWR in VINTAGE_HEADERS is safe ONLY because `api/cron/run.ts` purges `VINTAGE_TAG` after each run.
  // `statusBody` marks the readings whose served row is a licensed-lead estimate; the redact reads the marks off THIS body.
  const licensedEstimates = new WeakSet<ReadingDTO>();
  return serveRedactable(statusBody(storeOf, opts, licensedEstimates), (raw) => redactStatus(raw, licensedEstimates));
}

/** The FULL `/status` body (every redactable level in place), or the 404 when no run is recorded yet. Exported so a
 *  suite asserting on the redactable fields reads them before `handle`'s response rule. */
export async function statusBody(storeOf: () => ReadStore, opts: StatusSeams, licensedEstimates: WeakSet<ReadingDTO>): Promise<StatusResponse | Response> {
  const warn = opts.warn ?? console.warn;
  const store = storeOf();
  // A NEWER `intraday_verdict` slot IS the served verdict (`servedVerdict`, shared with /lab and /api/exposure); the
  // push and notify baselines stay on the EOD `alert_log` row. A failed slot read degrades to the EOD row, never a 500.
  const [eodVerdict, slot] = await Promise.all([
    store.getLastAlert(),
    readIntradaySlot(store, "status"),
  ]);
  const servedRow = servedVerdict(eodVerdict, slot);
  if (!servedRow) {
    return Response.json({ error: "no runs recorded yet" }, { status: 404 });
  }
  const provisionalVerdict = servedRow !== eodVerdict;
  // Strip the slot's panel blobs: `/status` serves the narrow (no-panel) shape.
  const { panelState: _panel, displayPanelState: _displayPanel, ...verdict } = servedRow;

  // Read THIS verdict's run (firedAt), never an independent max(run_at) — keeps /status self-consistent.

  // Ages use the FEED's calendar date (`feedTimeZone`, default `FEED_CALENDAR_TZ`), never UTC; ONE clock read
  // (`now`) per response via `feedCalendarTodayResolver` — never read the clock again below.
  const now = opts.now ?? new Date();
  const todayOn = feedCalendarTodayResolver(now);
  // DEFAULT-calendar date: only for the run-wide heartbeat (`verdict.date` spans every feed).
  const today = todayOn();

  // Freshness DEGRADES, never 500s (`stamp` undefined ⇒ run-row ages; pill + feedLag omitted).
  // Keep each `.catch` on its own promise — never hoisted onto the `Promise.all` (a readings fault must throw).
  const [stamp, runReadings, etfBulk] = await Promise.all([
    (opts.freshness ?? freshnessFrom)(store, now).catch((err: unknown) => {
      warn("[status] freshness stamp read failed - serving run-row ages, no pill or feedLag:", err);
      return undefined;
    }),
    store.getReadingsForRun(verdict.firedAt),
    store
      .getSeriesBulk(ETF_CARD_IDS, { limit: RETURN_WINDOW + 1 })
      .catch((e: unknown) => {
        console.warn("[status] ETF return20d read degraded", e);
        return new Map<string, SeriesPoint[]>();
      }),
  ]);
  const returnOf = (id: string): number | undefined => {
    const v = (etfBulk.get(id) ?? []).map((p) => p.value);
    return v.length > RETURN_WINDOW ? (trailingReturnAt(v, v.length - 1, RETURN_WINDOW) ?? undefined) : undefined;
  };
  const freshById = new Map((stamp?.freshness ?? []).map((f) => [f.id, f]));
  const seriesAgeDays: ReadonlyMap<string, number> = stamp?.ageDays ?? new Map();
  const seriesAgeUnit: ReadonlyMap<string, "slots" | "days"> = stamp?.ageUnit ?? new Map();
  const laggingFeedIds = stamp ? stamp.freshness.filter((f) => f.lag).map((f) => f.id) : null;
  // Unmeasured (calendar uncomputable) ids are their own set — never count them as lagging.
  const unmeasuredFeedIds = stamp ? stamp.freshness.filter((f) => f.unmeasured).map((f) => f.id) : null;

  // The ONE run-row ageing seam — readings, the CAPE bridge and feedLag all route through it.
  const runRow = (id: string, asOf: string, cadenceDefault: Cadence): Freshness => {
    const meta = META.get(id);
    return assessIndicatorFreshness(
      asOf,
      todayOn(meta?.feedTimeZone),
      meta?.cadence ?? cadenceDefault,
      meta?.lagAfterDays,
    );
  };

  // ATOMIC: ageDays/lag/unit/source come from ONE source — the roster when it holds an observation, else the
  // run row (`source: "run-row"`). Never pair fields across sources.
  const freshnessOf = (
    id: string,
    asOf: string,
    cadenceDefault: Cadence,
  ): { ageDays: number; lag: boolean; unit: "slots" | "days"; source: "roster" | "run-row" } => {
    const seriesAge = seriesAgeDays.get(id);
    const seriesLagging = freshById.get(id)?.lag;
    const seriesUnit = seriesAgeUnit.get(id);
    if (seriesAge !== undefined && seriesLagging !== undefined && seriesUnit !== undefined)
      return { ageDays: seriesAge, lag: seriesLagging, unit: seriesUnit, source: "roster" };
    const rr = runRow(id, asOf, cadenceDefault);
    return { ageDays: rr.ageDays, lag: rr.lag, unit: rr.unit, source: "run-row" };
  };

  const readings: ReadingDTO[] = runReadings
    .filter((r) => !isInternalSeries(r.indicatorId))
    .map((r) => {
      const meta = META.get(r.indicatorId);
      // ⚠ Open contradiction (user ruling owed): no calendar + recent rows reads FRESH here but `lag: true` in
      // `feedLag` below — a fix must tell "no observation" from "observation, no calendar", not blanket-change this.
      // A newer INTRADAY row or `estimated` EOD head overlays the card only — never the verdict.
      const newest = stamp?.newest.get(r.indicatorId);
      const intra = intradayOverlay(newest, r.date, r.indicatorId) ?? (newest?.estimated === true && newest.date > r.date ? newest : undefined);
      const row = intra ?? r;
      const { ageDays, lag: rLagging, unit, source } = freshnessOf(r.indicatorId, row.date, "daily");
      const dto: ReadingDTO = {
        indicatorId: r.indicatorId,
        label: meta?.label ?? r.indicatorId,
        date: row.date,
        value: row.value,
        delta20: row.delta20,
        rawState: row.rawState,
        state: row.state,
        ageDays,
        unit,
        lag: rLagging,
        source,
      };
      if (PLACEHOLDER_STATE_IDS.has(r.indicatorId) || CUTLESS_CHART_IDS.has(r.indicatorId)) dto.valueOnly = true;
      if (intra && isProvisional(intra, r.indicatorId)) dto.provisional = true;
      // Served intraday verdict ⇒ the run's OWN row is provisional — keep in parity with `/lab`.
      if (!intra && provisionalVerdict && isProvisional({ date: r.date, runAt: verdict.firedAt }, r.indicatorId)) {
        dto.provisional = true;
        if (r.estimated === true) dto.estimated = true;
      }
      if (intra?.estimated === true) dto.estimated = true;
      if (row.estimated === true && isLicensedEstimateId(r.indicatorId)) licensedEstimates.add(dto);
      const lastPrint = lastPrintTag(r.indicatorId, stamp?.newest.get(r.indicatorId), verdict.date);
      if (lastPrint) dto.lastPrint = lastPrint;
      const return20d = returnOf(r.indicatorId);
      if (return20d !== undefined) dto.return20d = return20d;
      return dto;
    });

  const served = new Set(readings.map((r) => r.indicatorId));
  for (const id of ETF_CARD_IDS.filter((id) => !served.has(id))) {
    const head = etfBulk.get(id)?.at(-1);
    const return20d = returnOf(id);
    if (!head || return20d === undefined) continue;
    const { ageDays, lag, unit, source } = freshnessOf(id, head.date, "daily");
    const lastPrint = lastPrintTag(id, stamp?.newest.get(id), verdict.date);
    readings.push({
      indicatorId: id,
      label: META.get(id)?.label ?? id,
      date: head.date,
      value: head.value,
      delta20: head.delta20,
      rawState: "GREEN",
      state: "GREEN",
      ageDays,
      unit,
      lag,
      source,
      valueOnly: true,
      return20d,
      ...(isProvisional(head, id) ? { provisional: true as const } : {}),
      ...(head.estimated ? { estimated: true as const } : {}),
      ...(lastPrint ? { lastPrint } : {}),
    });
  }

  // CAPE (F7): value-only, recomputed read-time (its row has its own run_at) — the one exemption from
  // persist-at-cron. A degraded read serves NO card, never a null value.
  const capeMeta = META.get("F7");
  const capeToday = todayOn(capeMeta?.feedTimeZone);
  const capeSeries: (CapeObs & { estimated?: boolean })[] = await store.getSeries("F7", VAL_Z_WINDOW + CAPE_SERIES_PAD).catch((err: unknown) => {
    warn("[status] F7 read failed - serving no CAPE card:", err);
    return [];
  });
  const cape = computeCapeValuation(capeSeries, capeToday);
  if (!cape.degraded && cape.value !== null) {
    const capeDate = capeSeries
      .filter((o) => o.date <= capeToday && Number.isFinite(o.value))
      .map((o) => o.date)
      .sort()
      .at(-1);
    if (capeDate) {
      // `date` is the SERVED observation while the age is the newest STORED F7 row — they differ on future-dated /
      // non-finite rows by design; `api/status-freshness.test.ts` pins it.
      const { ageDays, lag, unit, source } = freshnessOf("F7", capeDate, "monthly");
      const lastPrint = lastPrintTag("F7", stamp?.newest.get("F7"), verdict.date);
      readings.push({
        indicatorId: "F7",
        label: capeMeta?.label ?? "F7",
        date: capeDate,
        value: cape.value,
        delta20: 0,
        rawState: "GREEN",
        state: "GREEN",
        ageDays,
        unit,
        lag,
        source,
        valueOnly: true,
        ...(capeSeries.some((o) => o.date === capeDate && o.estimated === true) ? { estimated: true as const } : {}),
        ...(lastPrint ? { lastPrint } : {}),
      });
    }
  }

  const { lag, ageDays } = assessFreshness(verdict.date, today);

  // FEED-LAG roster: built off `stamp` (NO new store read) over `stamp.freshness` — never a CADENCE_OF/LAG_CUT_OF
  // projection (a coverage check on one is tautological). Emitted only when the stamp read succeeded.
  const feedLag: FeedLagRow[] | undefined = stamp
    ? (() => {
        const lagNoteById = new Map(stamp.lag.map((n) => [n.id, n]));
        const runRowById = new Map(runReadings.map((r) => [r.indicatorId, r.date]));
        const rows: FeedLagRow[] = stamp.freshness.map((f) => {
          const cadence = CADENCE_OF.get(f.id) ?? "daily";
          const note = lagNoteById.get(f.id);
          // Serve the bar in the row's `ageUnit` (`deepLagBarInAgeUnit`), never the note's day bar.
          const measured = note?.deepLagBar != null ? (stamp.deepLagBarInAgeUnit.get(f.id) ?? null) : null;
          const stampAge = stamp.ageDays.get(f.id);
          let age = stampAge ?? null;
          let ageUnit = stamp.ageUnit.get(f.id) ?? null;
          let source: "p90" | "tier" | "run-row" = measured != null ? "p90" : "tier";
          // Unmeasured + run row ⇒ run-row age, `source: "run-row"` — keep in step with `freshnessOf`.
          const runDate = f.unmeasured && stampAge === undefined ? runRowById.get(f.id) : undefined;
          if (runDate !== undefined) {
            const rr = runRow(f.id, runDate, cadence);
            age = rr.ageDays;
            ageUnit = rr.unit;
            source = "run-row";
          }
          return {
            id: f.id,
            cadence,
            age,
            ageUnit,
            // Fallback is type-narrowing only — resolve via `lagCutFor`, never the tier table raw.
            lagCut: LAG_CUT_OF.get(f.id) ?? lagCutFor({ cadence }),
            deepLagBar: measured ?? LAG_THRESHOLDS[cadence] * DEEP_LAG_MULTIPLE,
            source,
            ...(note ? { deep: lagTier(note.label) === "deep" } : {}),
            // Unmeasured ⇒ NO `lag` key — never fabricate a value for an absence.
            ...(f.unmeasured ? { unmeasured: true as const } : { lag: f.lag === true }),
            ...(f.provisional ? { provisional: true as const } : {}),
          };
        });
        return [...rows.filter((r) => r.lag), ...rows.filter((r) => !r.lag)];
      })()
    : undefined;

  return {
    verdict,
    readings,
    asOf: verdict.date,
    lag,
    feedAgeDays: ageDays,
    // `public/refetch-gate.js` paints from storage only when firedAt AND this match; must stay null outside Vercel.
    deployId: opts.env.VERCEL_DEPLOYMENT_ID || null,
    // Derived only — never the url itself: whether this deploy resolves the push/mail link host.
    alertLinks: dashboardUrl(opts.env) !== undefined,
    ...(provisionalVerdict ? { provisional: true as const } : {}),
    // OMITTED on a degraded freshness read (never `feedsLagging: 0`); count and ids stay off ONE expression.
    // Never add a count threshold — it would be an uncalibrated hand-set cut.
    ...(laggingFeedIds && unmeasuredFeedIds && stamp
      ? {
          feedsLagging: laggingFeedIds.length,
          laggingFeedIds,
          feedsTotal: stamp.freshness.length,
          unmeasuredFeedIds,
        }
      : {}),
    ...(feedLag ? { feedLag } : {}),
  };
}
