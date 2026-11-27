/**
 * Per-id seed-depth constants the registry entries declare their `backfill` field from
 * (`Indicator.backfill`, domain-types.ts). `src/` never imports `scripts/`, so these live here and
 * `scripts/restate-policy.ts` re-exports them for its importers.
 */
import { DETAIL_WINDOW_DAYS } from "./family-descriptor-rows.js";

/** Seed-window depth in YEARS — the [USER] 2026-09-05 3y ruling's single touch point; `scripts/backfill.ts`
 *  re-exports it as its `BACKFILL_WINDOW.depth`, `src/series-db-first.ts`'s deep arms size off it. */
export const BACKFILL_YEARS = 3;

/** Lead-in the floor's fetch bound adds BEYOND the floor date. A windowed scorer emits nothing for
 *  its first observations — `ratioSpreadReadingSeries` (both EU-curve legs) spends `VELOCITY_WINDOW`
 *  (20) OBSERVATIONS un-scored — so fetching exactly from the floor would store the first row ~20
 *  trading days late and the floor would not be the first CHARTED date. 45 cal-days ⇒ ~31 business
 *  days, clearing 20 with room for holidays. Deeper per-scorer heads are a DEPTH declaration, not this
 *  (BONOS's σ warm-up rides its own `backfill`); this is the generic lead-in only. */
export const BACKFILL_FLOOR_WARMUP_DAYS = 45;

/**
 * Calendar days covering the detail chart's OWN span, warmup included — the depth EVERY indicator
 * must reach (`chartSpanBound`). No id declares it as its backfill depth (EURC did until 2026-10-05).
 * ⚠ DERIVED from `DETAIL_WINDOW_CONFIG.span`, never hand-set.
 */
export const CHART_SPAN_DAYS = DETAIL_WINDOW_DAYS + BACKFILL_FLOOR_WARMUP_DAYS;

/** Stored prefix the expanding-percentile cuts anchor over (F3 weekly, CG daily). CG's depth is a
 *  ruled value — reproduced here, never re-decided. */
export const EXPANDING_PERCENTILE_PREFIX_YEARS = 15;

/** ESTR (ECB overnight rate) seed depth — must reach ESTR inception (2019-10-01) at the prod seed; ECB holds nothing older. */
export const ESTR_BACKFILL_YEARS = 7;

/** ECISS (ECB CISS) seed depth — must reach 2007-01-01 (pre-GFC, [USER] eufin top5 C3) at the prod seed;
 *  20y ≈ 5,200 business days, so `DEEP_PROBE` must exceed that (backfill.policy.test.ts). */
export const ECISS_BACKFILL_YEARS = 20;

/** EURGBP (ECB EXR) seed depth — the MA50 head must burn before 2008 at the prod seed (eurgbp seat 10). */
export const EURGBP_BACKFILL_YEARS = 19;

/** EXSH_GATE seed depth — must reach 2008-02-01 (EXSH.DE/EXSA.DE closes-provider history start) at the prod seed
 *  (its retired rel-strength predecessor's floor, inherited 2026-10-06). */
export const EXSH_GATE_BACKFILL_YEARS = 19;

/** XAT1.DE (Invesco USD AT1 CoCo UCITS, EUR-hedged) closes-provider inception — the AT1 seed floor; the depth below is pinned against it. */
export const AT1_INCEPTION = "2018-07-12";

/** AT1 seed depth — the smallest whole-year window whose prod-seed bound reaches `AT1_INCEPTION` (XAT1.DE is
 *  the shallow leg; EXHA.DE serves from 2008). `backfill.policy.test.ts` pins the floor off the date constant. */
export const AT1_BACKFILL_YEARS = 9;

/** BONOS (Spain−Germany 10y, sovereign-quote ES10Y) seed depth — the store must reach 2008 (EXSH_GATE's floor) so the
 *  2011–12 / 2018 / 2022 episodes chart after the σ head (`oatLegBase`) burns from store on read. */
export const BONOS_BACKFILL_YEARS = EXSH_GATE_BACKFILL_YEARS;

/** EU-Fin (the HELD sleeve) seed depth — `[USER]` 2026-09-24: the leg's own EXSH.DE series
 *  (`LEGP_EUFIN`, `LEG_BACKFILL_YEARS`) and every indicator seated in its top-8 (`LEG_TOP["EU-Fin"]`,
 *  public/leg-top.js) reach 5y, so the detail tab's `5y` window chip paints a full span on that leg.
 *  A seat already declaring a DEEPER depth keeps its own; `backfill.policy.test.ts` pins
 *  every seat at ≥ this. A later roster swap owes the new seat this declaration + a `--deepen`. */
export const EUFIN_BACKFILL_YEARS = 5;

/** Semis seed depth (`[USER]` 2026-10-24): every `LEG_TOP.Semis` seat but `SEMIS_SHALLOW`'s (`leg-top.test.js`) reaches 5y so the `5y` chip paints.
 *  `LEGP_SEMIS` needs no row: its proxy join (`LEG_PROXY_SEED_YEARS` before 2021-08-06) already seeds deeper. */
export const SEMIS_BACKFILL_YEARS = 5;

/** DFII10's first FRED observation. ECY's F7 ⋈ DFII10 join — its expanding rank pool — starts here,
 *  and backfill's ECY seed ranks over the FULL feed (`fullHistory`), so the live arm reads back to it. */
export const DFII10_ORIGIN = "2003-01-02";

/** Per-leg `LEGP_*` seed depth in YEARS; an absent leg id rides the shared `BACKFILL_YEARS`. */
export const LEG_BACKFILL_YEARS: Readonly<Record<string, number>> = { LEGP_EUFIN: EUFIN_BACKFILL_YEARS };

/** A proxied leg (`LegQuote.proxy`) seeds at least this many YEARS before its `until` join, so the
 *  proxy stretch never ages out of the cutoff (a fixed year row would, and a reshadow would delete it). */
export const LEG_PROXY_SEED_YEARS = 2;
