// crash-dash — /lab live scoreboard (D9): pure metrics leaf.
//
// Chain-linked EUR NAV math + drawdown-family metrics (ulcer / maxDD / Calmar /
// recovery) + the two D9 gates, computed as DISPLAY MATH over persisted rows
// (`SB_STRAT` / `SB_BENCH` readings rows written by the cron, Fork 4). This module
// is PURE (no IO, no clock — `now` is a parameter): it mirrors the isolation
// pattern of `pension.ts` / `r4.ts` and is never imported by ladder.ts or any
// alert roll-up, so it structurally cannot move the fast alert band. Notify-only
// dashboard surface — the scoreboard informs the D7 kill criterion, it never
// auto-decides and never notifies.

import type { Observation } from "./domain-types.js";
import { LADDER } from "./families.js";
import { drawdownSeries } from "./pension.js";
import type { R4Phase } from "./r4.js";
import type { StoredReading } from "./store.js";
import { isoDay } from "./dates.js";

// --- Constants (ALL provisional — settle at the rung that consumes them) ----------

/** NAV chain base level, seeded on the first SB run. Provisional. */
export const NAV_BASE = 100;
/** Read-window over SB rows: last N points fed to the metrics (>1 trading year). Provisional. */
export const SCOREBOARD_WINDOW = 400;
/** Ulcer index is `n/a yet` below this many runs. Provisional. @internal */
export const MIN_UI_RUNS = 10;
/** Calmar is `n/a yet` below this many runs. Provisional. @internal */
export const MIN_CALMAR_RUNS = 60;
/** Gate (a): PASS iff `UI_strat <= UI_bench * ULCER_GATE_RATIO` (equality passes). Provisional. */
const ULCER_GATE_RATIO = 1.0;
/** Gate (b): PASS iff trailing-365d override count `<= B1_OVERRIDES_PER_YEAR` (D7 B1). Provisional. @internal */
export const B1_OVERRIDES_PER_YEAR = 3;
/** Return-vs-fund RETUNE flag threshold, in pp/yr (custody drag). Provisional. */
const CUSTODY_DRAG_PP = 0.09;
/** Return-vs-fund KILL-FLOOR flag threshold, in pp/yr (feeds D7 M2 — display only). Provisional. @internal */
export const M2_RETURN_LAG_PP = 2;

/** Synthetic `readings` indicator id for the strategy NAV chain (Fork 4 write path). */
export const SB_STRAT_ID = "SB_STRAT";
/** Synthetic `readings` indicator id for the benchmark NAV chain (Fork 4 write path). */
export const SB_BENCH_ID = "SB_BENCH";

/** Fork 1 honesty label, verbatim (swapped only if the Pensionikeskus NAV probe succeeds). @internal */
export const YARDSTICK_LABEL = "yardstick: ACWI ETF proxy (USD→EUR) - not Tuleva EUR NAV";

// --- Leg → scored-series ticker map ------------------------------------------------

/** One ladder leg's scored series: the closes-feed ticker and its quote currency. */
export interface LegQuote {
  ticker: string;
  /** "USD" legs convert per-date via `P_EUR(d) = P_USD(d) / EURUSD(d)` (the closes feed's `EURUSD=X`). */
  currency: "USD" | "EUR";
  /** Pre-join fund (`until` = the held fund's first close): `spliceProxyCloses` chain-joins its € path; backfill-only fetch. */
  proxy?: { ticker: string; currency: "USD" | "EUR"; until: string };
}

/**
 * Ladder sleeve → scored-series ticker, sourced verbatim from the canonical 9-leg
 * table (verified 2026-07-15).
 * Keyed by the `LADDER` sleeve names (`families.ts`) — the values `heldSleeve`
 * persists. Their `.DE`/`.L` listings have no free source (prices.ts).
 */
export const LEG_TICKER: Record<(typeof LADDER)[number], LegQuote> = {
  Semis: { ticker: "SEC0.DE", currency: "EUR", proxy: { ticker: "SMH", currency: "USD", until: "2021-08-06" } },
  "S&P IT": { ticker: "QDVE.DE", currency: "EUR" },
  EM: { ticker: "IS3N.DE", currency: "EUR" },
  // ⚠ TWO STORE IDS, ONE TICKER — deliberate since 2026-08-08, do NOT de-duplicate.
  // `LEGP_VALUE` = the CHAINED EUR level the R5/Y1 relative-strength chain reads (`legCloseReadingRows`);
  // `XDEV` = the RAW EUR close (its PENSION registry row) and Value's ONE chart (`LEG_CHART_ID`, public/leg-chart.js).
  Value: { ticker: "XDEV.DE", currency: "EUR" },
  "S&P 500": { ticker: "SXR8.DE", currency: "EUR" },
  "ex-US": { ticker: "CHSI.DE", currency: "EUR", proxy: { ticker: "VEA", currency: "USD", until: "2025-03-03" } },
  // EUR-native (Xetra), unlike the USD `VHYD.L` it replaced — `currency` feeds the FX conversion
  // below, so this row changes a computed NAV, not only a label.
  "EU-Fin": { ticker: "EXSH.DE", currency: "EUR" },
  // RE-POINTED 2026-08-02 (user ruling): the two defensive rungs are now **US large-cap sector** funds,
  // not the global Xtrackers MSCI World sleeves they replaced (`XDWH.DE` / `XDWS.DE`). The whole
  // defensive-leg member-weight grid is priced on THESE underlyings — S&P 500
  // Health Care and Consumer Staples Select Sector — so the swap is the premise of every proposed cell,
  // not a cosmetic relabel. Both verified live on the then closes-provider `.DE` path,
  // XETRA/EUR-quoted with MORE history than the funds they replace (first trade 2015-12 / 2015-07 vs
  // 2016-04). `currency` stays `"EUR"` — the Xetra LINE is EUR; the USD underlying is the unhedged FX
  // translation channel the research prices at leg level (its §1), never here.
  // ✅ `LEGP_HEALTH` / `LEGP_STAPLES` re-provenance DONE on prod 2026-08-09: the
  // `legs --reshadow-all=` splice resolved the tell-tale identical 2613/2613 pair to single-fund
  // history — 2708 rows from 2015-12-03 (QDVG.DE) and 2817 from 2015-07-07 (ZPDS.DE). Leg-percentile
  // and velocity figures spanning the old boundary are quotable again.
  Health: { ticker: "QDVG.DE", currency: "EUR" },
  Staples: { ticker: "ZPDS.DE", currency: "EUR" },
};

/**
 * Ladder sleeve → the slug used in its persisted per-leg close id, `LEGP_<slug>`
 * (the `SB_*` / `DB_*` / `CMP_*` synthetic-id idiom). Slugs exist because the sleeve
 * NAMES carry `&`, spaces and dots (`S&P 500`, `ex-US`) that have no business in an
 * `indicator_id`. `readings.indicator_id` is unconstrained free text and the family
 * tables whitelist by named id, so `LEGP_*` rows are excluded from every panel and
 * every firing member BY OMISSION — no migration; their registry rows are threshold-less card/detail rows.
 * Falsifier: `grep -n "LEGP_" src/danger-ladder.ts` → zero hits (never a weight/leg/timing row); in
 * families.ts the ONLY sanctioned seat is the `CARD_ONLY_GROUPS.pension-drawdown` ("ETFs") row —
 * every ladder leg's `legCloseId` but `LEGP_VALUE` (its chart is `XDEV`) + `LEGP_COMMOD`/`LEGP_RAFI` (off-ladder)
 * as detail-chart rows, card grouping only, never a family, a weight or a firing member.
 *
 * ⚠ TWO mechanisms keep these rows off `/status`'s run-reading path (the seated ones reach it via the ETF-card bridge).
 * `api/status.ts` reads `getReadingsForRun(firedAt)` GENERICALLY (a negative `isInternalSeries`
 * filter, not a whitelist) and would emit an unlabelled `LEGP_VALUE` row (the other 8 have META labels); what saves it is that
 * `seedLegClosesOnCron` runs AFTER `recordRun` with a distinct `run_at`, so `LEGP_*` rows are
 * never part of that run. Folding this block into `runStoredReadings` to "simplify" therefore
 * breaks `/status`, and no test catches it (Stage 3 review).
 */
export const LEG_SLUG: Record<(typeof LADDER)[number], string> = {
  Semis: "SEMIS",
  "S&P IT": "SPIT",
  EM: "EM",
  Value: "VALUE",
  "S&P 500": "SPX",
  "ex-US": "EXUS",
  "EU-Fin": "EUFIN",
  Health: "HEALTH",
  Staples: "STAPLES",
};

/** Persisted id for one leg's EUR close series. */
export function legCloseId(sleeve: (typeof LADDER)[number]): string {
  return `LEGP_${LEG_SLUG[sleeve]}`;
}

// Off-ladder legs (display-only detail charts, never a ladder position). `LEGP_COMMOD` from LYTR.DE,
// `LEGP_RAFI` from PSWD.DE — both EUR-native, so `eurCloseAt` never FX-divides them; kept off ladder
// P&L/journal/status by omission.
type OffLadderLeg = "Commodities" | "AW Fundam";
export const OFF_LADDER_LEG_TICKER: Record<OffLadderLeg, LegQuote> = {
  Commodities: { ticker: "LYTR.DE", currency: "EUR" },
  "AW Fundam": { ticker: "PSWD.DE", currency: "EUR" },
};
const OFF_LADDER_LEG_SLUG: Record<OffLadderLeg, string> = { Commodities: "COMMOD", "AW Fundam": "RAFI" };
export const OFF_LADDER_LEG_KEYS = Object.keys(OFF_LADDER_LEG_TICKER) as (keyof typeof OFF_LADDER_LEG_TICKER)[];

/** Persisted id for one off-ladder leg's EUR close series (`LEGP_COMMOD`). */
export function offLadderLegCloseId(leg: keyof typeof OFF_LADDER_LEG_TICKER): string {
  return `LEGP_${OFF_LADDER_LEG_SLUG[leg]}`;
}

/** Every `LEGP_*` id (ladder + off-ladder) with its quote — `source-holidays.ts` seats each on its venue's calendar. */
export function legCloseQuotes(): [string, LegQuote][] {
  return [
    ...LADDER.map((sleeve): [string, LegQuote] => [legCloseId(sleeve), LEG_TICKER[sleeve]]),
    ...OFF_LADDER_LEG_KEYS.map((leg): [string, LegQuote] => [offLadderLegCloseId(leg), OFF_LADDER_LEG_TICKER[leg]]),
  ];
}

/** A `LEGP_*` id's pre-join proxy (`LegQuote.proxy`), or undefined. */
export function legProxy(legId: string): LegQuote["proxy"] {
  return legCloseQuotes().find(([id]) => id === legId)?.[1].proxy;
}

/** The chained display lines `estimateAnchored` binds (`ANCHOR_ROSTER`): every `LEGP_*` id plus the SB NAV pair. */
export function chainedDisplayIds(): string[] {
  return [...legCloseQuotes().map(([id]) => id), SB_STRAT_ID, SB_BENCH_ID];
}

// --- SB row builder -----------------------------------------------------------------

/**
 * Project one display-only scalar into a `StoredReading` row (mirrors `priceLegReadingSeries`,
 * pension.ts): no scorer — `rawState = state = "GREEN"` is a NOT-NULL placeholder no scorer
 * ever reads, and `US_FAMILIES`/`GLOBAL_FAMILIES` exclude these synthetic ids by omission
 * (whitelist membership). `delta20` stays 0: these rows are written one point per run, so no
 * 20-observation window exists at write time. Used for the `SB_*` NAV chain and the `LEGP_*`
 * per-leg EUR closes. Pure.
 */
export function navReadingRow(id: string, date: string, nav: number): StoredReading {
  return {
    date,
    indicatorId: id,
    value: nav,
    delta20: 0,
    rawState: "GREEN",
    state: "GREEN",
    decision: null, // raw stored NAV (no scorer/derived descriptor) — never a decision variable
  };
}

/** Prior chain anchor for one leg: its last persisted level and the date it sits on. */
export interface LegChainAnchor {
  level: number;
  date: string;
}

/**
 * Project the nine ladder legs into CHAIN-CONSISTENT `LEGP_*` EUR-close level rows
 * (active-5 Stage 3.1; chain rebase 2026-07-23) — the shared history R5 (realized vol of
 * the held book) and Y1 (cross-sectional relative strength) both read. Same display-only
 * row shape as `navReadingRow`.
 *
 * **The stored value stays a LEVEL, but is built by chaining EUR ratios (SB `nextNav`
 * pattern), not by writing each date's raw EUR close.** For each leg, a running level is
 * advanced across `dates` (oldest→newest) by `level_t = level_{t-1} × chainedRatio(…)`,
 * every ratio computed inside ONE fetch's consistent vintage. This cancels the
 * adjusted-close vintage seam (Defect A): a backfill row is total-return-scaled to the
 * seed date, a cron row is that day's price-only close, and writing raw levels persisted
 * two vintages of the same date. Multiplying a stored level by a within-this-fetch ratio
 * never re-anchors to an absolute cross-vintage level, so the seam cancels. Because all
 * dates in a SINGLE fetch share one vintage the chain telescopes to the direct EUR close,
 * so a full backfill from the seed base reproduces the direct-conversion shape exactly;
 * the seam only ever lived BETWEEN two fetches (the cron advancing off a backfilled level),
 * which this closes. (The cron also fills a live hole from a stored row rescaled to the live
 * vintage, and writes a date past the live newest `estimated` until a live fetch re-chains it —
 * `seedLegClosesOnCron`.)
 *
 * **EUR closes, never raw quotes.** Every leg quotes EUR; a pre-join proxy segment (`LegQuote.proxy`) is USD;
 * a raw-quote comparison across them would make any RS metric partly an FX signal.
 *
 * **Seed base = the first computable EUR close of that leg within the fetch**, so the chained level is
 * a real-€ TOTAL-RETURN level: it equals the quote at the seed, then a distributing leg runs above its
 * quote by every payout since (by design: never re-anchoring across vintages is how Defect A above is cancelled). The detail
 * charts serve it as real € (real-eur R1); the RS readers `computeLegRs`/`computeR5` use ratios only. A leg
 * absent from `prior` seeds on its first available date (that row carries the base EUR
 * close, no ratio); a leg present in `prior` advances FROM its stored `{level, date}`
 * anchor. Both writers pass the SAME (empty for backfill, DB-read for cron) — never a
 * second EUR-conversion path (anti-drift).
 *
 * Per-date skips, both benign — the chain anchor is preserved across each so the next
 * successful date bridges the gap as a multi-day ratio:
 * - **No close at `date`** (venue holiday — the legs trade Xetra, a pre-join proxy US): skipped,
 *   never fatal; an all-or-nothing block would drop all nine legs every German holiday.
 * - **Date at or before the leg's own `prior` anchor**: skipped. The cron passes a catch-up WINDOW
 *   (`seedLegClosesOnCron`), not a single date, so a leg already chained to the newest date in that
 *   window must neither re-write it nor chain backwards off it; the guard also makes a same-asOf
 *   re-run idempotent. Legs absent from `prior` (the backfill writer passes an empty map) are unaffected.
 * - **No usable FX rate** at either chain endpoint (the oldest dates precede the FX series;
 *   an outage): the date is skipped rather than fabricating a level. Skipping (not throwing)
 *   lets a backfill seed the FX-covered span instead of dying on a handful of early dates,
 *   and lets a cron write the six EUR legs when only the FX feed is down.
 *
 * Pure.
 *
 * ⚠ **`LEGP_*` rows hold CHAINED EUR LEVELS (dividend-adjusted, FX-converted for the USD legs), not raw quotes** (`legCloseReadingRows`),
 * and they SKIP venue-holiday dates (Xetra legs; a pre-join proxy segment US). A date-merge of a live tail onto a
 * `LEGP_*` series invents a cliff — rescale at the newest shared date (`chainPensionTail`), and never
 * assume a `LEGP_*` series has a row on a given US trading day.
 */
export function legCloseReadingRows(
  closesByTicker: Record<string, Observation[]>,
  fx: Observation[],
  dates: readonly string[],
  prior: Map<string, LegChainAnchor>,
): StoredReading[] {
  return LADDER.flatMap((sleeve) =>
    chainLegCloseRows(legCloseId(sleeve), LEG_TICKER[sleeve], closesByTicker, fx, dates, prior),
  );
}

/**
 * Same chain-consistent EUR-level rows for the off-ladder legs (`OFF_LADDER_LEG_TICKER` — `LEGP_COMMOD`),
 * built through the SAME per-leg chain as the nine ladder legs. Off-ladder ids never enter any ladder
 * roll-up (every ladder reader iterates `LADDER`); this is a display-only detail-chart series. Pure.
 */
export function offLadderLegCloseReadingRows(
  closesByTicker: Record<string, Observation[]>,
  fx: Observation[],
  dates: readonly string[],
  prior: Map<string, LegChainAnchor>,
): StoredReading[] {
  return OFF_LADDER_LEG_KEYS.flatMap((leg) =>
    chainLegCloseRows(offLadderLegCloseId(leg), OFF_LADDER_LEG_TICKER[leg], closesByTicker, fx, dates, prior),
  );
}

/** One leg's `LEGP_*` level rows across `dates` — the shared per-leg loop of the two builders above. */
function chainLegCloseRows(
  id: string,
  leg: LegQuote,
  closesByTicker: Record<string, Observation[]>,
  fx: Observation[],
  dates: readonly string[],
  prior: Map<string, LegChainAnchor>,
): StoredReading[] {
  const rows: StoredReading[] = [];
  const held = closesByTicker[leg.ticker] ?? [];
  const closes = leg.proxy ? spliceProxyCloses(held, closesByTicker[leg.proxy.ticker] ?? [], fx, leg) : held;
  const currency = leg.proxy ? "EUR" : leg.currency; // the spliced path is already €
  let anchor = prior.get(id);
  for (const date of dates) {
    if (anchor !== undefined && date <= anchor.date) continue; // already chained — never re-write or chain backwards
    if (!closes.some((o) => o.date === date)) continue; // venue closed / feed gap — skip this leg's date
    let level: number;
    try {
      level =
        anchor === undefined
          ? eurCloseAt(closes, fx, date, currency) // seed: base = first computable EUR close
          : anchor.level * chainedRatio(closes, fx, anchor.date, date, currency);
    } catch {
      continue; // no usable FX / non-positive prior close — skip this date, keep the anchor
    }
    rows.push(navReadingRow(id, date, level));
    anchor = { level, date };
  }
  return rows;
}

/**
 * A proxied leg's € close path: d ≥ `until` → the held € close; d < `until` → proxy €(d) × held(J) / proxy€(≤J),
 * J = the held fund's first close ≥ `until`. No join (held or proxy absent) ⇒ the held € path alone. Pure.
 */
export function spliceProxyCloses(held: Observation[], proxy: Observation[], fx: Observation[], leg: LegQuote): Observation[] {
  const heldEur = eurPoints(held, fx, leg.currency);
  const p = leg.proxy;
  if (p === undefined) return heldEur;
  const join = heldEur.filter((o) => o.date >= p.until).reduce<Observation | undefined>((a, o) => (a === undefined || o.date < a.date ? o : a), undefined);
  if (join === undefined) return heldEur;
  let base: number;
  try {
    base = eurCloseAtOrBefore(proxy, fx, join.date, p.currency);
  } catch {
    return heldEur;
  }
  if (!(base > 0)) return heldEur;
  const k = join.value / base;
  const pre = eurPoints(proxy.filter((o) => o.date < p.until), fx, p.currency).map((o) => ({ ...o, value: o.value * k }));
  return [...pre, ...heldEur.filter((o) => o.date >= p.until)];
}

/** Each close in €, FX per its own date; a close with no usable FX is dropped. */
function eurPoints(obs: Observation[], fx: Observation[], currency: "USD" | "EUR"): Observation[] {
  return obs.flatMap((o) => {
    try {
      return [{ ...o, value: toEur(o.value, fx, o.date, currency) }];
    } catch {
      return [];
    }
  });
}

// --- NAV chaining -------------------------------------------------------------------

/**
 * Calendar-day cap between the run's date and the newest close every chain input shares: a weekend plus
 * a venue holiday (Fri → Tue) is 4, so past this a feed has stopped and the SB block degrades.
 * @internal
 */
export const SB_MAX_CLOSE_LAG_DAYS = 5;

/**
 * The date this run's NAV chain links to: the newest date ≤ `asOf` on which EVERY series in `closes` has
 * a close. The inputs trade on different venues and publish at different hours (ACWI in New York, a
 * Xetra leg like XDEV.DE), so demanding an exact `asOf` close froze the chain whenever one venue had not
 * published yet — every intraday run, and (2026-09-18..26) days on end. FX is not an input: `eurCloseAt`
 * already takes its nearest prior rate. THROWS (→ the SB degrade) when no common date exists or it trails
 * `asOf` by more than `SB_MAX_CLOSE_LAG_DAYS`, so a stopped feed still surfaces. Pure.
 * @internal
 */
export function chainLinkDate(closes: Observation[][], asOf: string): string {
  const dateSets = closes.map((series) => new Set(series.filter((o) => o.date <= asOf).map((o) => o.date)));
  const newest = [...(dateSets[0] ?? [])].filter((d) => dateSets.every((s) => s.has(d))).sort().at(-1);
  if (newest === undefined) throw new Error(`[scoreboard] no common close at/before ${asOf}`);
  const lag = calendarDays(newest, asOf);
  if (lag > SB_MAX_CLOSE_LAG_DAYS) {
    throw new Error(`[scoreboard] newest common close ${newest} is ${lag}d behind ${asOf} (cap ${SB_MAX_CLOSE_LAG_DAYS}d)`);
  }
  return newest;
}

/**
 * This run's SB_STRAT / SB_BENCH NAV rows, each dated at `chainLinkDate` over the closes it needs (the
 * benchmark's, plus the prior held leg's while the strategy is invested). A chain whose last row is
 * already at/after that date gets NO row — nothing new closed since (an intraday re-run), not a degrade.
 * No prior row at all ⇒ both seed at NAV_BASE on `asOf`. Throws on missing data (→ the SB degrade). Pure.
 */
export function scoreboardNavRows(input: {
  asOf: string;
  prevStrat: { date: string; value: number } | undefined;
  prevBench: { date: string; value: number } | undefined;
  prior: { heldSleeve: string | null; r4Phase: R4Phase | null };
  fx: Observation[];
  benchCloses: Observation[];
  legCloses: Observation[];
}): StoredReading[] {
  const { asOf, prevStrat, prevBench, prior, fx, benchCloses, legCloses } = input;
  if (!prevStrat && !prevBench) {
    return [navReadingRow(SB_STRAT_ID, asOf, NAV_BASE), navReadingRow(SB_BENCH_ID, asOf, NAV_BASE)];
  }
  // An unknown sleeve links on the benchmark alone, so `nextNav` throws the precise "unknown held sleeve".
  const invested =
    prevStrat !== undefined &&
    prior.r4Phase !== "cash" &&
    prior.heldSleeve !== null &&
    Object.hasOwn(LEG_TICKER, prior.heldSleeve);
  const link = chainLinkDate(invested ? [benchCloses, legCloses] : [benchCloses], asOf);
  // A prev row can sit on a date the series didn't trade (NYSE-only day, a seed on asOf, a sleeve switch).
  const start = { startAtOrBefore: true };
  const rows: StoredReading[] = [];
  if (!prevStrat) rows.push(navReadingRow(SB_STRAT_ID, link, NAV_BASE));
  else if (link > prevStrat.date) {
    rows.push(navReadingRow(SB_STRAT_ID, link, nextNav(prevStrat.value, legCloses, fx, prevStrat.date, link, prior, start)));
  }
  if (!prevBench) rows.push(navReadingRow(SB_BENCH_ID, link, NAV_BASE));
  else if (link > prevBench.date) {
    rows.push(
      navReadingRow(SB_BENCH_ID, link, prevBench.value * chainedRatio(benchCloses, fx, prevBench.date, link, "USD", start)),
    );
  }
  return rows;
}

/**
 * EUR close of a series at exactly `date`: pass-through for EUR-quoted series,
 * per-date `usd / EURUSD(date)` for USD-quoted ones. FX uses the nearest PRIOR
 * observation (`fx.date <= date` — the closes feed's `EURUSD=X` rows are business-day only,
 * so a venue date can miss an exact FX row). THROWS on a
 * missing close / missing usable FX — the Stage-2 cron wraps the whole SB block
 * in `degrade()` so a feed gap writes no SB rows this run (chain resumes next
 * run across the gap), never a fabricated point.
 */
function eurCloseAt(
  closes: Observation[],
  fx: Observation[],
  date: string,
  currency: "USD" | "EUR",
): number {
  const close = closes.find((o) => o.date === date);
  if (close === undefined) throw new Error(`[scoreboard] no close at ${date}`);
  return toEur(close.value, fx, date, currency);
}

/**
 * `eurCloseAt` valued on `date` from the newest close at/before it — a series that did not trade on
 * `date` is worth its last close (FX still taken at `date`). Throws when no close precedes `date`.
 */
function eurCloseAtOrBefore(
  closes: Observation[],
  fx: Observation[],
  date: string,
  currency: "USD" | "EUR",
): number {
  let close: Observation | undefined;
  for (const o of closes) {
    if (o.date <= date && (close === undefined || o.date > close.date)) close = o;
  }
  if (close === undefined) throw new Error(`[scoreboard] no close at/before ${date}`);
  return toEur(close.value, fx, date, currency);
}

function toEur(value: number, fx: Observation[], date: string, currency: "USD" | "EUR"): number {
  if (currency === "EUR") return value;
  let rate: number | undefined;
  for (const o of fx) {
    if (o.date <= date && o.value > 0) rate = o.value; // fx oldest→newest: last prior wins
  }
  if (rate === undefined) throw new Error(`[scoreboard] no EURUSD rate at/before ${date}`);
  return value / rate;
}

/**
 * EUR total-return ratio of a close series between two run dates:
 * `R = P_EUR(asOfDate) / P_EUR(prevDate)`. A missed cron day is automatically
 * absorbed as a multi-day ratio (the endpoints are run dates, not calendar-adjacent).
 * `startAtOrBefore` values the `prevDate` endpoint via `eurCloseAtOrBefore` (default: exact).
 * Throws (→ upstream degrade) on missing data. Pure.
 */
export function chainedRatio(
  closes: Observation[],
  fx: Observation[],
  prevDate: string,
  asOfDate: string,
  currency: "USD" | "EUR",
  opts: { startAtOrBefore?: boolean } = {},
): number {
  const prev = (opts.startAtOrBefore ? eurCloseAtOrBefore : eurCloseAt)(closes, fx, prevDate, currency);
  if (prev <= 0) throw new Error(`[scoreboard] non-positive close at ${prevDate}`);
  return eurCloseAt(closes, fx, asOfDate, currency) / prev;
}

/**
 * One chain-link step of the strategy NAV: `NAV_t = NAV_{t-1} × R_t` where `R_t`
 * is the EUR return of the leg held during the elapsed interval — the sleeve the
 * PREVIOUS run persisted (`prior.heldSleeve`, what the user was prescribed to hold
 * between the two runs). Cash (`prior.r4Phase === "cash"`) and a null prior sleeve
 * (pre-column / degraded) are both flat: `R_t = 1` — an honest no-position baseline,
 * never a phantom return. `legCloses` are the prior held leg's adjusted closes in
 * its native currency (`LEG_TICKER` names it); an unknown sleeve throws (→ degrade).
 * Pure.
 */
export function nextNav(
  prevNav: number,
  legCloses: Observation[],
  fx: Observation[],
  prevDate: string,
  asOfDate: string,
  prior: { heldSleeve: string | null; r4Phase: R4Phase | null },
  opts: { startAtOrBefore?: boolean } = {},
): number {
  if (prior.r4Phase === "cash" || prior.heldSleeve === null) return prevNav;
  const leg = Object.hasOwn(LEG_TICKER, prior.heldSleeve)
    ? (LEG_TICKER as Record<string, LegQuote>)[prior.heldSleeve]
    : undefined;
  if (leg === undefined) throw new Error(`[scoreboard] unknown held sleeve "${prior.heldSleeve}"`);
  return prevNav * chainedRatio(legCloses, fx, prevDate, asOfDate, leg.currency, opts);
}

// --- Pure metric functions -----------------------------------------------------------

/**
 * Ulcer index over a NAV series: `D_t = 100 × (NAV_t / peak_t − 1)` with `peak_t`
 * the trailing peak WITHIN the window (`drawdownSeries`), `UI = sqrt(Σ D_t² / N)`.
 * ≥ 0; 0 for a monotone-rising series. Throws nothing; empty input → NaN guard by
 * caller (computeScoreboard gates on MIN_UI_RUNS first). Pure.
 * @internal
 */
export function ulcerIndex(navs: number[]): number {
  const dd = drawdownSeries(navs);
  const sumSq = dd.reduce((s, d) => s + (100 * d) ** 2, 0);
  return Math.sqrt(sumSq / dd.length);
}

/**
 * Max drawdown in percent (≤ 0): `min_t D_t` with `D_t = 100 × (NAV_t / peak_t − 1)`,
 * trailing peak within the window. Pure.
 * @internal
 */
export function maxDrawdown(navs: number[]): number {
  return 100 * Math.min(...drawdownSeries(navs));
}

/** Calendar days between two YYYY-MM-DD dates (UTC midnights). */
function calendarDays(start: string, end: string): number {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
}

/**
 * Annualized return over the window: `(NAV_end / NAV_start)^(365.25 / calendarDays) − 1`
 * — calendar-day annualization, tolerant of the ~weekdaily, gap-prone cadence.
 * Returns null when undefined (<2 points, zero elapsed days, non-positive start). Pure.
 */
function annualizedReturn(navs: number[], dates: string[]): number | null {
  if (navs.length < 2 || dates.length !== navs.length) return null;
  const days = calendarDays(dates[0]!, dates[navs.length - 1]!);
  const start = navs[0]!;
  if (days <= 0 || start <= 0) return null;
  return (navs[navs.length - 1]! / start) ** (365.25 / days) - 1;
}

/**
 * Calmar ratio: `annRet / |maxDD|` with maxDD as a FRACTION of the trailing peak
 * (unit-consistent with annRet). Returns null when annualized return is undefined
 * or `maxDD = 0` (nothing to divide by). The MIN_CALMAR_RUNS short-window gate
 * lives in `computeScoreboard`, not here. Pure.
 */
function calmar(navs: number[], dates: string[]): number | null {
  const annRet = annualizedReturn(navs, dates);
  if (annRet === null) return null;
  const maxDdFrac = Math.min(...drawdownSeries(navs));
  if (maxDdFrac === 0) return null;
  return annRet / Math.abs(maxDdFrac);
}

/**
 * Recovery time: run count from the max-DD trough to the FIRST later point with
 * `NAV ≥` the pre-trough peak. Returns null when unrecovered or `maxDD = 0`
 * (rendered "n/a yet"). Ties break to the earliest trough. Pure.
 * @internal
 */
export function recoveryRuns(navs: number[]): number | null {
  if (navs.length === 0) return null;
  const dd = drawdownSeries(navs);
  let trough = 0;
  for (let i = 1; i < dd.length; i++) if (dd[i]! < dd[trough]!) trough = i;
  if (dd[trough] === 0) return null; // maxDD = 0: nothing to recover from
  let peak = -Infinity;
  for (let i = 0; i <= trough; i++) if (navs[i]! > peak) peak = navs[i]!;
  for (let j = trough + 1; j < navs.length; j++) {
    if (navs[j]! >= peak) return j - trough;
  }
  return null; // unrecovered
}

// --- Scoreboard DTO -------------------------------------------------------------------

/** One NAV point as read back from the store (`SeriesPoint` is structurally assignable). */
export interface NavPoint {
  date: string; // YYYY-MM-DD, oldest→newest
  value: number;
}

/** One recorded manual override (Fork 2 `overrides` table row, via `getOverrides`). */
export interface OverrideRow {
  obsDate: string; // YYYY-MM-DD
  note: string | null;
}

/** The alert-row slice the scoreboard reads (time-in-cash guardrail). */
export interface ScoreboardAlertRow {
  date: string; // YYYY-MM-DD
  r4Phase: R4Phase | null;
}

type GateVerdict = "PASS" | "FAIL";

/** One metric value or its honest absence (`naReason` set exactly when `value` is null). */
interface MetricCell {
  value: number | null;
  naReason: string | null;
}

/** The per-series metric column (strategy and benchmark each get one). */
interface ScoreboardMetrics {
  /** Ulcer index (≥ 0). */
  ulcer: MetricCell;
  /** Max drawdown in percent (≤ 0). */
  maxDD: MetricCell;
  /** Calmar ratio. */
  calmar: MetricCell;
  /** Runs from max-DD trough to recovery of the pre-trough peak. */
  recoveryRuns: MetricCell;
  /** Annualized return, fraction/yr (calendar-day annualization). */
  annRet: MetricCell;
}

/**
 * The full /lab scoreboard DTO: two SEPARATE gate verdicts (never combined into a
 * product), the metric columns, the window statement and warming-up flag (Fork 3),
 * and the watched guardrails (M2 flags — display only). Attached to the /lab live
 * response in Stage 3; rendered in Stage 4.
 */
export interface ScoreboardView {
  /** True before the first SB row exists (pre-first-cron prod) — FE renders the honest empty card. */
  warmingUp: boolean;
  /** First SB row date in the window, or null when warming up. */
  since: string | null;
  /** SB run count in the window. */
  runs: number;
  /** Fork 3 verbatim window statement ("" while warming up). */
  windowStatement: string;
  /** Fork 1 honesty label, verbatim. */
  yardstickLabel: string;
  strategy: ScoreboardMetrics;
  benchmark: ScoreboardMetrics;
  gates: {
    /** Gate (a) — ulcer: both numbers + verdict, never a ratio-of-gates. Null verdict = n/a yet. */
    ulcer: {
      verdict: GateVerdict | null;
      naReason: string | null;
      strategyUi: number | null;
      benchmarkUi: number | null;
    };
    /** Gate (b) — overrides in the trailing 365 calendar days vs the B1 budget. */
    overrides: {
      verdict: GateVerdict;
      count: number;
      limit: number;
    };
  };
  /** Watched guardrail: `annRet_strat − annRet_bench` in pp/yr (feeds M2 — display only). */
  returnVsFundPp: number | null;
  /** M2 flag chip: RETUNE below −CUSTODY_DRAG_PP, KILL-FLOOR below −M2_RETURN_LAG_PP. */
  returnFlag: "RETUNE" | "KILL-FLOOR" | null;
  /** Share of last-365d alert rows with `r4Phase === "cash"` (null when no rows in window). */
  timeInCashShare: number | null;
}

/** The `naReason` a withheld metric cell carries (the cell invariant: set exactly when `value` is null). */
const SB_WITHHELD_REASON = "withheld - licensed closes";
/** The `naReason` of every cell of a column with no NAV rows — the one column shape that carries no statistic. */
const SB_WARMING_UP_REASON = "n/a yet - warming up";

/**
 * The redacted `/lab` scoreboard (3.5b, ruled 2026-11-25): every statistic over the licensed-close NAVs — the
 * metric columns (returns, ulcer, max-DD, calmar, recovery runs), the ulcer gate's two numbers and
 * `returnVsFundPp` — nulls. The verdicts, flag, override count, window and time-in-cash stay. No early return
 * on `warmingUp`: that flag reads the STRATEGY rows only, so a warming-up view can still carry a computed
 * benchmark column. A column with no rows keeps its honest "warming up" cells (they carry no statistic); every
 * other cell is withheld. Pure; a copy.
 */
export function withholdScoreboardStats(sb: ScoreboardView): ScoreboardView {
  const cell: MetricCell = { value: null, naReason: SB_WITHHELD_REASON };
  const withhold = (column: ScoreboardMetrics): ScoreboardMetrics =>
    Object.values(column).every((c) => c.naReason === SB_WARMING_UP_REASON)
      ? column
      : { ulcer: cell, maxDD: cell, calmar: cell, recoveryRuns: cell, annRet: cell };
  return {
    ...sb,
    strategy: withhold(sb.strategy),
    benchmark: withhold(sb.benchmark),
    gates: { ...sb.gates, ulcer: { ...sb.gates.ulcer, strategyUi: null, benchmarkUi: null } },
    returnVsFundPp: null,
  };
}

// --- computeScoreboard -----------------------------------------------------------------

const naCell = (reason: string): MetricCell => ({ value: null, naReason: reason });
const okCell = (value: number): MetricCell => ({ value, naReason: null });

/**
 * The metric column for one NAV series, with per-metric `n/a yet` rules.
 */
function metricsFor(points: NavPoint[]): ScoreboardMetrics {
  const n = points.length;
  if (n === 0) {
    const warm = naCell(SB_WARMING_UP_REASON);
    return { ulcer: warm, maxDD: warm, calmar: warm, recoveryRuns: warm, annRet: warm };
  }
  const navs = points.map((p) => p.value);
  const dates = points.map((p) => p.date);
  const maxDd = maxDrawdown(navs);

  const ulcer =
    n < MIN_UI_RUNS ? naCell(`n/a yet - ${n} runs < ${MIN_UI_RUNS}`) : okCell(ulcerIndex(navs));

  const annRetVal = annualizedReturn(navs, dates);
  const annRet = annRetVal === null ? naCell("n/a yet - need ≥2 runs") : okCell(annRetVal);

  let calmarCell: MetricCell;
  if (n < MIN_CALMAR_RUNS) calmarCell = naCell(`n/a yet - ${n} runs < ${MIN_CALMAR_RUNS}`);
  else {
    const c = calmar(navs, dates);
    calmarCell = c === null ? naCell("n/a yet - no drawdown") : okCell(c);
  }

  let recovery: MetricCell;
  if (maxDd === 0) recovery = naCell("n/a yet - no drawdown");
  else {
    const r = recoveryRuns(navs);
    recovery = r === null ? naCell("n/a yet - unrecovered") : okCell(r);
  }

  return { ulcer, maxDD: okCell(maxDd), calmar: calmarCell, recoveryRuns: recovery, annRet };
}

/** ISO date exactly 365 calendar days before `now` (UTC). */
function cutoff365(now: Date): string {
  return isoDay(new Date(now.getTime() - 365 * 86_400_000));
}

/**
 * The full scoreboard from persisted state: SB NAV series (strategy + benchmark,
 * oldest→newest), recorded overrides, and recent alert rows. Pure display math —
 * no store, no fetch, no clock (`now` is a parameter). Defensively re-windows to
 * the last SCOREBOARD_WINDOW points. Zero SB rows → `warmingUp: true` with every
 * metric `n/a` (the FE renders the honest empty card, never crashes).
 */
export function computeScoreboard(
  strat: NavPoint[],
  bench: NavPoint[],
  overrides: OverrideRow[],
  recentAlerts: ScoreboardAlertRow[],
  now: Date,
): ScoreboardView {
  const s = strat.slice(-SCOREBOARD_WINDOW);
  const b = bench.slice(-SCOREBOARD_WINDOW);
  const runs = s.length;
  const warmingUp = runs === 0;
  const since = warmingUp ? null : s[0]!.date;
  const windowStatement = warmingUp
    ? ""
    : `measuring since ${since} · ${runs} runs - short window: informational, not yet kill-grade (D7 needs ≥2 non-overlapping windows)`;

  const strategy = metricsFor(s);
  const benchmark = metricsFor(b);

  // Gate (a) — ulcer: PASS iff UI_strat <= UI_bench * ULCER_GATE_RATIO (equality passes).
  const sUi = strategy.ulcer.value;
  const bUi = benchmark.ulcer.value;
  const ulcerGate =
    sUi === null || bUi === null
      ? {
          verdict: null,
          naReason: strategy.ulcer.naReason ?? benchmark.ulcer.naReason,
          strategyUi: sUi,
          benchmarkUi: bUi,
        }
      : {
          verdict: (sUi <= bUi * ULCER_GATE_RATIO ? "PASS" : "FAIL") as GateVerdict,
          naReason: null,
          strategyUi: sUi,
          benchmarkUi: bUi,
        };

  // Gate (b) — overrides in the trailing 365 calendar days vs the B1 budget.
  const cutoff = cutoff365(now);
  const overrideCount = overrides.filter((o) => o.obsDate >= cutoff).length;
  const overridesGate = {
    verdict: (overrideCount <= B1_OVERRIDES_PER_YEAR ? "PASS" : "FAIL") as GateVerdict,
    count: overrideCount,
    limit: B1_OVERRIDES_PER_YEAR,
  };

  // Watched guardrails (displayed, not gates).
  let returnVsFundPp: number | null = null;
  let returnFlag: "RETUNE" | "KILL-FLOOR" | null = null;
  if (strategy.annRet.value !== null && benchmark.annRet.value !== null) {
    returnVsFundPp = 100 * (strategy.annRet.value - benchmark.annRet.value);
    // Flags gated by MIN_UI_RUNS (2026-07-15 post-review): annualizedReturn exponentiates by
    // 365.25/days, so a tiny week-1 dip explodes into a huge annualized lag — the pp number
    // stays displayed, but RETUNE/KILL-FLOOR chips stay off until the window is meaningful.
    if (runs >= MIN_UI_RUNS) {
      if (returnVsFundPp < -M2_RETURN_LAG_PP) returnFlag = "KILL-FLOOR";
      else if (returnVsFundPp < -CUSTODY_DRAG_PP) returnFlag = "RETUNE";
    }
  }

  const windowAlerts = recentAlerts.filter((a) => a.date >= cutoff);
  const timeInCashShare =
    windowAlerts.length === 0
      ? null
      : windowAlerts.filter((a) => a.r4Phase === "cash").length / windowAlerts.length;

  return {
    warmingUp,
    since,
    runs,
    windowStatement,
    yardstickLabel: YARDSTICK_LABEL,
    strategy,
    benchmark,
    gates: { ulcer: ulcerGate, overrides: overridesGate },
    returnVsFundPp,
    returnFlag,
    timeInCashShare,
  };
}
