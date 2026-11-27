/** Run-cycle global feeds: the GLOBAL/CONTEXT feed table and the CQS EBP-bridge card. */

import {
  CQS,
  EURC,
  ESTR,
  EPATH,
  ECISS,
  EURGBP,
  BUND,
  VXNCLS,
  T10Y3M_RAW,
  VXSMH,
  BONOS,
  FXH,
  GT,
  GB,
  DISP,
  HCX,
  HCX_FETCH_OPTS,
  FDX,
  componentBackfillSeries,
  COMPOSITE_COMPONENTS,
} from "./registry-composite.js";
import {
  HICP,
  CCC,
} from "./registry-fred.js";
import { markPhase } from "./fetch-budget.js";
import {
  scoreRatioSpread,
  scoreCurve,
  scoreFxHaven,
  fxHavenReadingSeries,
  scoreGlobalBreadth,
  scoreDispersion,
  scoreCreditBridge,
  scoreBonosSpread,
  ratioSpreadReadingSeries,
  globalBreadthReadingSeries,
  dispersionReadingSeries,
  curveReadingSeries,
  bonosSpreadReadingSeries,
  creditBridgeReadingSeries,
} from "./scorers-composite.js";
import {
  scoreGlobalTrend,
  scoreHcx,
  scoreRatioVsMa,
  hcxBasketSeries,
  breadthBandRanked,
  returnOrMaSpreadReadingSeries,
  globalTrendReadingSeries,
  breadthReadingSeries,
  ratioVsMaReadingSeries,
  scoreReturnOrMaSpread,
} from "./scorers-price.js";
import {
  scoreDerived,
  alignByDate,
  alignByDates,
  withNewest,
  derivedReadingSeries,
  scoreIndicator,
  indicatorReadingSeries,
} from "./scorers-core.js";
import { GB_SYMBOLS, HCX_SYMBOLS } from "./family-descriptor-rows.js";
import { resolveCuts } from "./domain-cuts.js";
import { type Observation, type Reading } from "./domain-types.js";
import { estimateDatesOf } from "./estimated.js";
import { BUND_DESCRIPTOR, EPATH_DESCRIPTOR, EURC_DESCRIPTOR } from "./family-descriptor-rows.js";
import { readFxhLegs, FXH_SCORER_LEG_LIMIT } from "./fxh-legs.js";
import { HICP_SERIES, hicpDelta6m } from "./hicp.js";
import { degrade, recordDegrade } from "./tracks.js";
import { seamRunAt } from "./series-db-first.js";
import { estimatorOf } from "./nowcast-score.js";
import type { ConfirmerCtx } from "./confirmers.js";
import {
  backfillHistory,
  BACKFILL_PROBE_LIMIT,
} from "./run-seeds.js";
import { pushEstimatorRows } from "./run-cycle-estimates.js";
import type { RunCtx, RunBase } from "./run-cycle-ctx.js";
import { errMsg } from "./err-msg.js";

const CRON_ECB_IDS = ["SR_10Y", "SR_3M", "SR_1Y", "ESTR", "ECISS", "EURGBP"] as const;
export type EcbPrefetch = (id: (typeof CRON_ECB_IDS)[number]) => Promise<Observation[]>;

/** Start every cron ECB fetch at once, so their waits overlap the FRED batch; each id stamps `ecb.<id>` when it settles. */
export function startEcbFetches(feeds: RunBase["feeds"]): EcbPrefetch {
  const started = {} as Record<(typeof CRON_ECB_IDS)[number], Promise<Observation[]>>;
  for (const id of CRON_ECB_IDS) {
    const p = feeds.fetchEcbSeries(id).finally(() => markPhase(`ecb.${id}`));
    p.catch(() => {});
    started[id] = p;
  }
  return (id) => started[id];
}

export async function scoreGlobalFeeds(
  ctx: RunCtx,
  calib: ConfirmerCtx["calib"],
  fetchEcbSeries: EcbPrefetch = startEcbFetches(ctx.feeds),
) {
  const { fetchDailyCloses, fetchSeries } = ctx.feeds;
  // GLOBAL-channel feeds: scored + PERSISTED (so /lab's T1 dial can reduce them via GLOBAL_FAMILIES) but
  // kept OUT of the notify-facing `readings` (persist-but-don't-notify, like the off-ladder tracks). Each
  // degrades INDEPENDENTLY. Mutually independent, so parallelize the WAITS (a sequential batch could exhaust
  // `RUN_FETCH_BUDGET_MS` before recordRun); apply results in the ordering-sensitive spread order (`assembleReadingsAndDial`, run-cycle-dial.ts).
  const runAtMs = Date.parse(ctx.runAt);
  const runNow = new Date(runAtMs);
  const priceClock = (): number => runAtMs;
  // GLOBAL/CONTEXT feeds folded into ONE declarative table + an order-preserving Promise.all; each entry's
  // fetch body runs INSIDE `degrade(msg, new Map(), …)`.
  type GlobalFeed = {
    id: string;
    /** which readings array this feed's result spreads into (order fixed by the spreads in run-cycle-dial.ts). */
    target: "global" | "main";
    degradeMsg: string;
    /** fetch + score body, run inside `degrade(degradeMsg, new Map(), …)` — throws here degrade to an empty map. */
    fetch: () => Promise<Map<string, Reading[]>>;
  };
  // Per-id series: parent `withNewest(twin, scalar)` (scalar evaluated first), then its CMP_ ids in COMPOSITE_COMPONENTS
  // order. `bySymbol` = EVERY fetched leg: a leg's `estimated` obs marks the parent and its CMP_ row estimate-sourced.
  const feedSeries = (
    id: string,
    newest: Reading | null,
    twin: () => readonly Reading[],
    bySymbol: Record<string, Observation[]> = {},
  ): Map<string, Reading[]> => {
    const out = new Map<string, Reading[]>();
    if (newest !== null) out.set(id, withNewest(twin(), newest));
    for (const b of componentBackfillSeries(id, bySymbol)) out.set(b.id, b.series);
    for (const c of COMPOSITE_COMPONENTS[id] ?? []) ctx.markEstimateSourced(c.id, estimateDatesOf(bySymbol[c.symbol]));
    ctx.markEstimateSourced(id, estimateDatesOf(...Object.values(bySymbol)));
    for (const sym of Object.keys(bySymbol)) ctx.markFallbackSourced(id, sym);
    return out;
  };
  // Quote-grafted sovereign-quote legs: EOD, a card's head is stored `estimated`.
  const de10yP = ctx.graft.sovereignLeg("DE10Y-DE");
  const de2yP = ctx.graft.sovereignLeg("DE2Y-DE");
  const es10yP = ctx.graft.sovereignLeg("ES10Y-ES");
  const estrP = (): Promise<Observation[]> => fetchEcbSeries("ESTR"); // ESTR + EPATH share one ECB fetch
  const GLOBAL_FEEDS: GlobalFeed[] = [
    // EURC (ECB euro curve) — Rates family euro leg.
    {
      id: "EURC",
      target: "global",
      degradeMsg: "[EURC] ECB euro curve unavailable - Rates family euro leg non-live this run",
      fetch: async () => {
        const [sr10y, sr3m] = await Promise.all([fetchEcbSeries("SR_10Y"), fetchEcbSeries("SR_3M")]);
        ctx.recordFeedDates("EURC", sr10y.map((o) => o.date));
        // CMP_ rows persist the raw closes as display-only vintage rows (replayable if the ECB feed closes).
        return feedSeries(
          "EURC",
          scoreRatioSpread(EURC, EURC_DESCRIPTOR, sr10y, sr3m),
          () => ratioSpreadReadingSeries(EURC, EURC_DESCRIPTOR, sr10y, sr3m),
          { SR_10Y: sr10y, SR_3M: sr3m },
        );
      },
    },
    // ESTR (ECB overnight rate) — GLOBAL velocity leg; single raw series ⇒ no CMP_ vintage row.
    {
      id: "ESTR",
      target: "global",
      degradeMsg: "[ESTR] ECB ESTR feed unavailable - policy-rate leg non-live this run",
      fetch: async () => {
        const obs = await estrP();
        ctx.recordFeedDates("ESTR", obs.map((o) => o.date));
        return feedSeries("ESTR", scoreDerived(ESTR, obs), () => derivedReadingSeries(ESTR, obs));
      },
    },
    // EPATH (ECB SR_1Y − ESTR, meaned) — GLOBAL context-only policy-path leg, the EURC template.
    {
      id: "EPATH",
      target: "global",
      degradeMsg: "[EPATH] ECB SR_1Y/ESTR unavailable - policy-path leg non-live this run",
      fetch: async () => {
        const [sr1y, estr] = await Promise.all([fetchEcbSeries("SR_1Y"), estrP()]);
        ctx.recordFeedDates("EPATH", alignByDate(sr1y, estr).dates); // readings carry the SR_1Y ∩ ESTR dates
        return feedSeries(
          "EPATH",
          scoreRatioSpread(EPATH, EPATH_DESCRIPTOR, sr1y, estr),
          () => ratioSpreadReadingSeries(EPATH, EPATH_DESCRIPTOR, sr1y, estr),
        );
      },
    },
    // ECISS (ECB composite CISS) — CONTEXT display-only, unseated: `global` keeps it off notify; no CALIB_MAP row.
    {
      id: "ECISS",
      target: "global",
      degradeMsg: "[ECISS] ECB CISS feed unavailable - euro stress context card non-live this run",
      fetch: async () => {
        const obs = await fetchEcbSeries("ECISS");
        ctx.recordFeedDates("ECISS", obs.map((o) => o.date));
        const cuts = resolveCuts(ECISS.id, calib, ECISS.direction ?? "HIGH");
        return feedSeries("ECISS", scoreIndicator(ECISS, obs, cuts), () => indicatorReadingSeries(ECISS, obs, cuts));
      },
    },
    // HICP (FRED euro-area HICP) Δ6m — CONTEXT display-only, unseated: `global` keeps it off notify. Full history
    // (~6 kB monthly CSV) so the 18-month head + minObs fill; monthly ⇒ no feedDates (the EBP precedent).
    {
      id: "HICP",
      target: "global",
      degradeMsg: "[HICP] FRED euro-area HICP unavailable - inflation-gate card non-live this run",
      fetch: async () => {
        const obs = hicpDelta6m(await fetchSeries(HICP_SERIES, { fullHistory: true, now: runNow, env: ctx.env }));
        const cuts = resolveCuts(HICP.id, calib, HICP.direction ?? "HIGH");
        return feedSeries("HICP", scoreIndicator(HICP, obs, cuts), () => indicatorReadingSeries(HICP, obs, cuts));
      },
    },
    // VXNCLS (Nasdaq-100 vol) — CHART-ONLY: `global` persists it off notify; no CALIB_MAP row.
    {
      id: "VXNCLS",
      target: "global",
      degradeMsg: "[VXNCLS] FRED VXN unavailable - chart-only leg non-live this run",
      fetch: async () => {
        const obs = await fetchSeries(VXNCLS.series, { now: runNow, env: ctx.env });
        ctx.recordFeedDates("VXNCLS", obs.map((o) => o.date));
        const cuts = resolveCuts(VXNCLS.id, calib, VXNCLS.direction ?? "HIGH");
        const series = feedSeries("VXNCLS", scoreIndicator(VXNCLS, obs, cuts), () => indicatorReadingSeries(VXNCLS, obs, cuts));
        // A `^VIX` outage costs the estimate row only, never the FRED print — recorded `trace`, never `notify`: this
        // display-only (`CHART_ONLY_INDICATORS`) row owes no push caveat (`newDegradeEvents`).
        if (obs.length > 0) {
          await (async () =>
            pushEstimatorRows(ctx, VXNCLS.id, estimatorOf(VXNCLS.id, "carry-mult"), obs, await ctx.graft.estimatorLegs(VXNCLS.id), (ext) => scoreIndicator(VXNCLS, ext, cuts))
          )().catch((err: unknown) => {
            console.warn(`[nowcast] VXNCLS estimate row not written this run: ${errMsg(err)}`);
            recordDegrade("[nowcast] VXNCLS estimate row not written this run", errMsg(err), "trace");
          });
        }
        return series;
      },
    },
    // T10Y3M_RAW (FRED T10Y3M, unsmoothed) — CHART-ONLY: `global` persists it off notify; no CALIB_MAP row.
    {
      id: "T10Y3M_RAW",
      target: "global",
      degradeMsg: "[T10Y3M_RAW] FRED T10Y3M unavailable - chart-only leg non-live this run",
      fetch: async () => {
        const obs = await fetchSeries(T10Y3M_RAW.series, { now: runNow, env: ctx.env });
        ctx.recordFeedDates("T10Y3M_RAW", obs.map((o) => o.date));
        const cuts = resolveCuts(T10Y3M_RAW.id, calib, T10Y3M_RAW.direction ?? "HIGH");
        return feedSeries("T10Y3M_RAW", scoreIndicator(T10Y3M_RAW, obs, cuts), () => indicatorReadingSeries(T10Y3M_RAW, obs, cuts));
      },
    },
    // VXSMH (index-only semis-ETF vol) — CHART-ONLY: `global` persists it off notify; no CALIB_MAP row.
    {
      id: "VXSMH",
      target: "global",
      degradeMsg: "[VXSMH] VXSMH unavailable - chart-only leg non-live this run",
      fetch: async () => {
        const obs = await fetchSeries(VXSMH.series, { now: runNow, env: ctx.env });
        ctx.recordFeedDates("VXSMH", obs.map((o) => o.date));
        const cuts = resolveCuts(VXSMH.id, calib, VXSMH.direction ?? "HIGH");
        return feedSeries("VXSMH", scoreIndicator(VXSMH, obs, cuts), () => indicatorReadingSeries(VXSMH, obs, cuts));
      },
    },
    // CCC (FRED BAMLH0A3HYC) — Credit family `cr` member, per-leg only (never the dial or push band); no CALIB_MAP row.
    {
      id: "CCC",
      target: "global",
      degradeMsg: "[CCC] FRED CCC & lower HY OAS unavailable - Credit family CCC leg non-live this run",
      fetch: async () => {
        const obs = await fetchSeries(CCC.series, { now: runNow, env: ctx.env });
        ctx.recordFeedDates("CCC", obs.map((o) => o.date));
        const cuts = resolveCuts(CCC.id, calib, CCC.direction ?? "HIGH");
        return feedSeries("CCC", scoreIndicator(CCC, obs, cuts), () => indicatorReadingSeries(CCC, obs, cuts));
      },
    },
    // EURGBP (ECB EUR/GBP ref rate) — CONTEXT display-only, unseated: `global` keeps it off notify.
    {
      id: "EURGBP",
      target: "global",
      degradeMsg: "[EURGBP] ECB EXR feed unavailable - sterling vs euro context card non-live this run",
      fetch: async () => {
        const obs = await fetchEcbSeries("EURGBP");
        ctx.recordFeedDates("EURGBP", obs.map((o) => o.date));
        return feedSeries("EURGBP", scoreReturnOrMaSpread(EURGBP, obs), () => returnOrMaSpreadReadingSeries(EURGBP, obs));
      },
    },
    // FXH (FX-haven composite, EURUSD=X/CHF=X/JPY=X daily closes-feed pairs) — Flight family FX leg.
    // Bespoke worst-of 20d haven-bid move (scoreFxHaven; per-series polarity in scorers-composite.ts).
    {
      id: "FXH",
      target: "global",
      degradeMsg: "[FXH] FX havens unavailable - Flight family FX leg non-live this run",
      fetch: async () => {
        const [usEur, chfUsd, jpyUsd] = await Promise.all([
          fetchDailyCloses("EURUSD=X", { now: priceClock, env: ctx.env }),
          fetchDailyCloses("CHF=X", { now: priceClock, env: ctx.env }),
          fetchDailyCloses("JPY=X", { now: priceClock, env: ctx.env }),
        ]);
        const bySymbol: Record<string, Observation[]> = { "EURUSD=X": usEur, "CHF=X": chfUsd, "JPY=X": jpyUsd };
        // Persist the dense ~280d leg closes FIRST (insert-missing, so the stored CMP_FXH_* series
        // is daily, not one-point-per-run — leg-ink drift fix, §6b.1), then score off the READ-BACK
        // grid through the SAME `readFxhLegs` seam `api/series.ts` draws the ribbon from: the
        // positional 20-bar base is a property of the input grid, so scorer input ≡ chart input is
        // the only way the line and the ribbon cannot disagree.
        // A store failure throws into `degrade` (FXH non-live this run) — NEVER a fall-back to the
        // live grid, which is exactly the drift this removes. Stamped at `seamRunAt(runAt)` like every
        // other fetch-phase seam (`createRunCtx`'s runAt comment, run-cycle-ctx.ts): the run's own CMP_ row
        // stays strictly newer under `readings_latest`'s `run_at desc`.
        await Promise.all(
          componentBackfillSeries("FXH", bySymbol).map((b) =>
            backfillHistory(ctx.store, b.id, b.series, BACKFILL_PROBE_LIMIT, () => seamRunAt(ctx.runAt), undefined, false, undefined,
              undefined, undefined, new Set(estimateDatesOf(bySymbol[b.symbol]))),
          ),
        );
        const legs = await readFxhLegs(ctx.store, FXH_SCORER_LEG_LIMIT);
        if (!legs) throw new Error("[FXH] a stored CMP_FXH_* leg is empty after the persist");
        ctx.recordFeedDates("FXH", legs.usEur.map((o) => o.date));
        return feedSeries(
          "FXH",
          scoreFxHaven(FXH, legs.usEur, legs.chfUsd, legs.jpyUsd),
          () => fxHavenReadingSeries(FXH, legs.usEur, legs.chfUsd, legs.jpyUsd),
          bySymbol,
        );
      },
    },
    // Stage 5: GT (ACWI vs its MA200) — Trend family global-trend leg (price feed, not FRED).
    {
      id: "GT",
      target: "global",
      degradeMsg: "[GT] ACWI global trend unavailable - Trend family global-trend leg non-live this run",
      fetch: async () => {
        const acwi = await fetchDailyCloses("ACWI", { now: priceClock, env: ctx.env });
        ctx.recordFeedDates("GT", acwi.map((o) => o.date));
        return feedSeries("GT", scoreGlobalTrend(GT, acwi), () => globalTrendReadingSeries(GT, acwi), { ACWI: acwi });
      },
    },
    // Stage 5: GB (breadth participation of 7 ETFs above their own MA200) — Trend family breadth
    // leg. GT's ACWI and GB's seven symbols are disjoint (SPY appears once, in GB).
    {
      id: "GB",
      target: "global",
      degradeMsg: "[GB] global breadth unavailable - Trend family breadth leg non-live this run",
      fetch: async () => {
        const symbols = [...new Set(GB_SYMBOLS)]; // deduped (already distinct) fetch set
        const fetched = await Promise.all(symbols.map((s) => fetchDailyCloses(s, { now: priceClock, env: ctx.env })));
        const bySymbol: Record<string, Observation[]> = {};
        symbols.forEach((s, i) => (bySymbol[s] = fetched[i]!));
        ctx.recordFeedDates("GB", (bySymbol[symbols[0]!] ?? []).map((o) => o.date));
        return feedSeries("GB", scoreGlobalBreadth(GB, bySymbol), () => globalBreadthReadingSeries(GB, bySymbol), bySymbol);
      },
    },
    // Stage 6: DISP (global dispersion of SPY·FEZ·EEM) — Dispersion family. Re-fetches its own
    // trio for isolation (SPY also fetched by the pension US leg). Mean pairwise 20d return-corr
    // gated by a negative basket return.
    {
      id: "DISP",
      target: "global",
      degradeMsg: "[DISP] global dispersion unavailable - Dispersion family non-live this run",
      fetch: async () => {
        const [spy, fez, eem] = await Promise.all([
          fetchDailyCloses("SPY", { now: priceClock, env: ctx.env }),
          fetchDailyCloses("FEZ", { now: priceClock, env: ctx.env }),
          fetchDailyCloses("EEM", { now: priceClock, env: ctx.env }),
        ]);
        ctx.recordFeedDates("DISP", spy.map((o) => o.date));
        return feedSeries("DISP", scoreDispersion(DISP, spy, fez, eem), () => dispersionReadingSeries(DISP, spy, fez, eem), {
          SPY: spy,
          FEZ: fez,
          EEM: eem,
        });
      },
    },
    // HCX (hyperscaler capex basket ÷ SPY) — CHART-ONLY leg: `target: "global"` persists into
    // globalReadings but never reaches notify, and it is NOT in GLOBAL_FAMILIES so it can't move the dial.
    {
      id: "HCX",
      target: "global",
      degradeMsg: "[HCX] hyperscaler capex basket unavailable - chart-only leg non-live this run",
      fetch: async () => {
        const symbols = [...new Set(HCX_SYMBOLS)];
        // FULL feed depth on BOTH legs via `HCX_FETCH_OPTS`, never the shallow default: the basket index
        // is window-relative, so a shallow cron row beside a deep backfill row prints a distance-from-high cliff.
        const [fetched, spy] = await Promise.all([
          Promise.all(symbols.map((sym) => fetchDailyCloses(sym, { ...HCX_FETCH_OPTS, now: priceClock, env: ctx.env }))),
          fetchDailyCloses("SPY", { ...HCX_FETCH_OPTS, now: priceClock, env: ctx.env }),
        ]);
        const bySymbol: Record<string, Observation[]> = {};
        symbols.forEach((sym, i) => (bySymbol[sym] = fetched[i]!));
        ctx.recordFeedDates("HCX", (bySymbol[symbols[0]!] ?? []).map((o) => o.date));
        // Guard-light: below the rankable window (BREADTH_MIN_CLOSES) the band can't form, so emit no HCX
        // reading (never a warm-up GREEN) — but ALWAYS persist the component vintage rows. Deep prod history scores.
        const basket = hcxBasketSeries(bySymbol);
        const hcx = breadthBandRanked(basket, spy) ? scoreHcx(HCX, bySymbol, spy) : null;
        return feedSeries("HCX", hcx, () => breadthReadingSeries(HCX, basket, spy), { ...bySymbol, SPY: spy });
      },
    },
    // FDX (TSM ÷ SMH foundry-dependency ratio) — CHART-ONLY leg (Stage 1). Same global-target /
    // chart-only contract as HCX. Two-leg ratio-vs-MA scorer (ms50 + Δ20d), direction LOW.
    {
      id: "FDX",
      target: "global",
      degradeMsg: "[FDX] TSM/SMH foundry-dependency ratio unavailable - chart-only leg non-live this run",
      fetch: async () => {
        const [tsm, smh] = await Promise.all([fetchDailyCloses("TSM", { now: priceClock, env: ctx.env }), fetchDailyCloses("SMH", { now: priceClock, env: ctx.env })]);
        ctx.recordFeedDates("FDX", tsm.map((o) => o.date));
        return feedSeries("FDX", scoreRatioVsMa(FDX, tsm, smh), () => ratioVsMaReadingSeries(FDX, tsm, smh), { TSM: tsm, SMH: smh });
      },
    },
    // Rung 3: BUND (sovereign-quote Bund curve 10y−2y) — Rates family Bund leg, the policy-PATH sibling of EURC's
    // policy-LEVEL 10y−3m, off the shared `de10yP` + `de2yP`. Bespoke `scoreCurve`, knobs on BUND_DESCRIPTOR.
    {
      id: "BUND",
      target: "global",
      degradeMsg: "[BUND] Bund 10Y/2Y yields unavailable - Rates family Bund leg non-live this run",
      fetch: async () => {
        const [de10y, de2y] = await Promise.all([de10yP(), de2yP()]);
        const dates = alignByDates([de10y, de2y]).dates;
        ctx.recordFeedDates("BUND", dates);
        ctx.markEstimateSourced("BUND", estimateDatesOf(de10y, de2y));
        // BUND persists both sovereign-quote legs; CMP_BUND_DE10Y is the sovereign-quote German vintage (BONOS's leg).
        return feedSeries("BUND", scoreCurve(BUND, BUND_DESCRIPTOR, de10y, de2y), () => curveReadingSeries(BUND, BUND_DESCRIPTOR, de10y, de2y), { DE10Y: de10y, DE2Y: de2y });
      },
    },
    // BONOS (Spanish−German 10y sovereign spread, bp) — off `es10yP` + the shared `de10yP`.
    {
      id: "BONOS",
      target: "global",
      degradeMsg: "[BONOS] Bonos/Bund 10Y yields unavailable - Bonos−Bund sovereign-spread card non-live this run",
      fetch: async () => {
        const [es10y, de10y] = await Promise.all([es10yP(), de10yP()]);
        const dates = alignByDates([es10y, de10y]).dates;
        ctx.recordFeedDates("BONOS", dates);
        ctx.markEstimateSourced("BONOS", estimateDatesOf(es10y, de10y));
        return feedSeries("BONOS", scoreBonosSpread(BONOS, es10y, de10y), () => bonosSpreadReadingSeries(BONOS, es10y, de10y), {
          ES10Y: es10y,
        });
      },
    },
  ];
  // Component legs claimed up front, so a feed that throws after a hop still claims its symbols (`feedSeries` claims the rest).
  for (const f of GLOBAL_FEEDS) for (const c of COMPOSITE_COMPONENTS[f.id] ?? []) [c.id, f.id].forEach((id) => ctx.markFallbackSourced(id, c.symbol));
  // One order-preserving parallel batch of the table's degrade-wrapped feeds.
  const feedResults = await Promise.all(GLOBAL_FEEDS.map((f) => degrade<Map<string, Reading[]>>(f.degradeMsg, "notify", new Map(), f.fetch)));
  const feedById = new Map(GLOBAL_FEEDS.map((f, i) => [f.id, feedResults[i]!]));
  for (const byId of feedResults) for (const [id, series] of byId) ctx.carry(id, series);
  const feed = (id: string): Reading[] => [...(feedById.get(id)?.values() ?? [])].flatMap((s) => s.slice(-1));
  return { feed };
}

export async function scoreCqs(
  ctx: RunBase,
  baa10yTail: Promise<Observation[]>,
  aaa10yTail: Promise<Observation[]>,
  ebpTail: Promise<Observation[]>,
): Promise<Reading[]> {
  // CQS — the Baa−Aaa EBP-bridge card, consumer of baa10yTail/aaa10yTail/ebpTail. `scoreCreditBridge`
  // inner-joins Baa/Aaa and anchors on EBP's latest month-END; empty join ⇒ degrade drops the leg, empty
  // EBP tail ⇒ silent GREEN. CONTEXT channel, off the FIN alert roll-up — but a SEATED
  // `GLOBAL_FAMILIES.credit` dial member (registry.ts §CQS: moves the credit leg RAG), so it is NOT
  // off the notify path; the dial band it feeds floors the notify band.
  const cqsSeries = await degrade<Reading[]>(
    "[CQS] Baa−Aaa EBP-bridge non-live this run - card + chart hold their last stored close",
    "notify",
    [],
    async () => {
      const [baa, aaa, ebp] = await Promise.all([baa10yTail, aaa10yTail, ebpTail]);
      if (baa.length === 0 || aaa.length === 0) return [];
      ctx.recordFeedDates("CQS", baa.map((o) => o.date));
      const newest = scoreCreditBridge(CQS, baa, aaa, ebp);
      return withNewest(creditBridgeReadingSeries(CQS, baa, aaa, ebp), newest);
    },
  );
  if (cqsSeries.length) ctx.carry("CQS", cqsSeries);
  return cqsSeries;
}
