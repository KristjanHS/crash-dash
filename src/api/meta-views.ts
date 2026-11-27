/**
 * Meta-router VIEW bodies (audit rank 14 — Vercel function headroom).
 *
 * The five THIN read handlers (health / history / families / danger-model / config)
 * are consolidated behind ONE Vercel function (`api/meta.ts`) to reclaim function
 * slots on the Hobby 12/deployment cap. Each handler's logic moves here VERBATIM as a
 * `*View` function; the router dispatches on `?view=`, and `vercel.json` rewrites keep
 * the PUBLIC URLs (`/api/health` … `/api/config`) exactly as they were — so
 * `openapi.yaml`, `public/*.js` fetches, scripts, and tests keep working unchanged.
 *
 * These are plain source functions (NOT under `api/`), so they don't each become a
 * serverless function — only the one router does.
 */
import { POSTGREST_MAX_ROWS, type AlertRecord, type ReadStore } from "../store.js";
import { DASHBOARD_FAMILIES, CARD_ONLY_GROUPS } from "../families.js";
import {
  SUPER_GROUPS,
  SUPER_GROUP_OF,
  MEMBER_RELEVANCE,
  MEMBER_WEIGHT,
  MEMBER_LABEL,
  CLUSTERS,
  RERISK_CONFIRM,
  RERISK_DWELL_DAYS,
} from "../danger-ladder.js";
import { SIGNAL_OF, FAMILY_OF_SIGNAL, LADDER } from "../families.js";
import {
  DANGER_CUTS,
  CONC_THRESHOLD,
  CONC_WEIGHT,
  DERISK_DEADBAND,
  RERISK_DEADBAND,
  PILLAR_MEMBER_IDS,
} from "../danger-engine.js";
import { ALERT_RANK } from "../ladder.js";
import { PENSION_DIP, PENSION_CORRECTION, PENSION_BEAR } from "../pension.js";
import { CONFIRM_CLOSES } from "../domain-types.js";
import { legCloseId } from "../scoreboard.js";
import { ACCEL_AMBER_PCTILE, ACCEL_RED_PCTILE, VIX_LOW_PCTILE, NEAR_HIGH_FRAC } from "../slow.js";
import { VT_AMBER_RATIO, VT_RED_RATIO } from "../family-descriptor-rows.js";
import type { FamilyMeta, DangerModel } from "./types.js";
import { CACHE_STATIC, parseLimit, serveRedactable, VINTAGE_HEADERS } from "./http.js";
import { cronBearerOk } from "../config.js";

/**
 * GET /api/health — liveness probe. PUBLIC (D3, perf top-5 P5): ONE cheap read (`getLastAlert`)
 * → `{ ok: true }`, proving the store creds + DB are live. Never cached.
 *
 * Missing store creds or a failed read is a 503 naming the cause: `getStore("ro")` throws without
 * `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`.
 *
 * DEEP probe — only with `Authorization: Bearer $CRON_SECRET` (`cronBearerOk`; a missing/wrong
 * bearer gets the cheap body, never a 401): `store.checkSchema` asserts every column the code reads,
 * so a "code deployed, migration not pushed" drift is a legible 503 naming the column (the
 * 2026-06-27 outage class). It also reports `maxRows` — the PostgREST wire cap the deep reads assume
 * — with a count-gated LIVE reading of it (`maxRowsObserved`/`maxRowsMismatch`, 6.2).
 */
export async function healthView(
  storeOf: () => ReadStore,
  req: Request | undefined,
  secret: string | undefined,
): Promise<Response> {
  try {
    // `storeOf` (a `ReadStore` thunk, rung 8a seam) THROWS without store creds — resolved INSIDE the try
    // so the catch below turns that into the 503.
    const store = storeOf();
    if (!req || !cronBearerOk(req, secret)) {
      await store.getLastAlert();
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }
    await store.checkSchema();
    const maxRows = await store.maxRowsProbe(POSTGREST_MAX_ROWS);
    const body: Record<string, unknown> = {
      ok: true,
      maxRows: POSTGREST_MAX_ROWS,
      // null when the readings count is at/under the assumed cap (nothing to probe).
      maxRowsObserved: maxRows.observed,
    };
    // Only present (and true) when the live cap came back BELOW the assumption — the
    // silent-truncation cliff (prod lowered `[api] max_rows`).
    if (maxRows.observed != null && maxRows.observed < POSTGREST_MAX_ROWS) body.maxRowsMismatch = true;
    // DELIBERATELY uncached: this is a liveness probe of the read-only store's DB path at request time —
    // a cached `ok:true` would mask a live DB outage, so it must never edge-cache. Never s-maxage.
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

const HISTORY_DEFAULT_LIMIT = 100;
const HISTORY_MAX_LIMIT = 500;

/**
 * GET /api/history?limit= — recent alert_log rows, newest first (openapi.yaml
 * `getHistory`). limit defaults to 100, clamped to 1..500.
 */
export async function historyView(req: Request, storeOf: () => ReadStore): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const limit = parseLimit(params.get("limit"), {
    def: HISTORY_DEFAULT_LIMIT,
    max: HISTORY_MAX_LIMIT,
  });
  if (limit instanceof Response) return limit; // the 400 stays uncached

  // Edge-cache the per-tab polls (P7) on the vintage default — one shared copy per `limit`.
  return serveRedactable(storeOf().getRecentAlerts(limit), redactHistory);
}

/** The redacted `/history` rows: each row's VIXCLS/VXVCLS levels (and the velocity read off them) null; `ratio` (2-input) stays. */
function redactHistory(alerts: AlertRecord[]): AlertRecord[] {
  return alerts.map((a) => ({ ...a, vix: null, vix3m: null, fallVelocity: null }));
}

/**
 * GET /api/families — the ordered Dashboard RENDER RANK (openapi.yaml `getFamilies`).
 * Pure static config derived from DASHBOARD_FAMILIES + CARD_ONLY_GROUPS (families.ts): the
 * SAME danger families the Lab board runs, in render order, each with key/label/desc.
 *
 * ⚠ ACCEPTED CONTRACT COST (E6(a) tail, USER-RULED 2026-07-30, option A). **`ids` means
 * "Dashboard render rank", NOT "family members".** The `CARD_ONLY_GROUPS` display overlay
 * (VIX/VIX3M under volatility, DB_SMH/DB_XLK under trend, F7 under
 * valuation) carries ids that are deliberately NOT panel/dial members, and before this they
 * had no rank at all — so both `<select>` pickers and the Zone C cards painted them in
 * registry order after the ranked members, and the replay picker filed them under "Other
 * indicators" while the Dashboard gave them a real heading. Appending the overlay ids AFTER
 * each family's ranked members gives the tail a rank for free (`sortByFamilyOrder` is a
 * stable partition), at the cost of the field's name no longer describing membership.
 * Membership itself lives on `/lab`'s panel and `DASHBOARD_FAMILIES`, never here.
 * Option B (a separate `cardIds`) was considered and REJECTED by the same ruling.
 *
 * The overlay is read from `CARD_ONLY_GROUPS` — never a hand-copied list, here or in
 * `public/app.js` (a hand-copy of exactly this roster is why the gap existed).
 */
export async function familiesView(): Promise<Response> {
  /** This family's display-overlay ids (`CARD_ONLY_GROUPS`), in overlay order. */
  const overlayIdsFor = (key: string): string[] =>
    CARD_ONLY_GROUPS.filter((g) => g.key === key).flatMap((g) => g.ids);

  const families: FamilyMeta[] = DASHBOARD_FAMILIES.map((f) => ({
    key: f.key,
    label: f.label,
    // `desc` is optional on FamilyDef; an absent one drops out of the JSON payload.
    desc: f.desc,
    // likewise `awaiting` — present only on the deliberately-feedless stub family.
    awaiting: f.awaiting,
    // E6(a): ranked members in impact order FIRST, then this family's card-only overlay ids,
    // so the Dashboard sorts its cards by rank rather than inheriting `/api/indicators`'
    // registry order. The Set keeps a rank position unique; members always lead the tail.
    ids: [...new Set([...f.ids, ...overlayIdsFor(f.key)])],
  }));

  // SYNTHETIC entries — a `CARD_ONLY_GROUPS` key that matches NO dial family. Today that is
  // `pension-drawdown` alone, and it is NOT A FAMILY: it drives no leg, no signal and no dial
  // fold (families.ts CardGroupKey deliberately widens FamilyKey so it can never be spread into
  // a `*_FAMILIES` table). It is served here purely so that display zone ranks and groups like
  // the rest — which is what lets `public/app.js` drop its hand-copy of the key/label.
  const synthetic: FamilyMeta[] = CARD_ONLY_GROUPS.filter(
    (g) => !DASHBOARD_FAMILIES.some((f) => f.key === g.key),
  ).map((g) => ({ key: g.key, label: g.label, ids: [...g.ids] }));
  families.push(...synthetic);
  // Static (moves only on deploy) but served with the same moderate TTL as /indicators
  // so a family label/desc edit surfaces without a hard cache-bust.
  return Response.json(families, { headers: VINTAGE_HEADERS });
}

/**
 * GET /api/danger-model — the STATIC danger-model reference block (openapi
 * `getDangerModel`). Identical every run, no DB hit: the SignalKey↔FamilyKey bijection,
 * the per-member×leg relevance mask + member labels, the correlated-leg clusters, and the
 * concentration / deadband knobs — single-sourced from danger-ladder.ts + families.ts.
 */
export async function dangerModelView(): Promise<Response> {
  const body: DangerModel = {
    signalOf: SIGNAL_OF,
    familyOfSignal: FAMILY_OF_SIGNAL,
    superGroups: [...SUPER_GROUPS],
    superGroupOf: SUPER_GROUP_OF,
    // ReadonlySet<string> → string[] for JSON; the FE rebuilds its own Sets.
    memberRelevance: Object.fromEntries(
      Object.entries(MEMBER_RELEVANCE).map(([id, set]) => [id, [...set]]),
    ),
    // R3: the RAW magnitudes behind that mask, so the M/N tooltip can print `×<weight>`.
    // Rows are already plain records; spread each so the served body cannot alias the frozen
    // module constant (a handler must never hand a caller a mutable view of source-of-truth).
    memberWeight: Object.fromEntries(
      Object.entries(MEMBER_WEIGHT).map(([id, row]) => [id, { ...row }]),
    ),
    memberLabel: MEMBER_LABEL,
    clusters: CLUSTERS.map((c) => [...c]),
    concThreshold: CONC_THRESHOLD,
    concWeight: CONC_WEIGHT,
    deriskDeadband: DERISK_DEADBAND,
    reriskDeadband: RERISK_DEADBAND,
    reriskConfirm: RERISK_CONFIRM,
    reriskDwellDays: RERISK_DWELL_DAYS,
    legRagCuts: { amber: DANGER_CUTS.amber, red: DANGER_CUTS.red },
    pillarIds: [...PILLAR_MEMBER_IDS],
  };
  return Response.json(body, { headers: VINTAGE_HEADERS });
}

/**
 * GET /api/config — the alert constants the browser renders (but must never redefine):
 * the alert-level ranking and the forensic scoring cut-points, served verbatim from the
 * real src/ exports so `public/app.js` renders against the exact same numbers the engine
 * uses. A served field is a THREE-place mirror (this body, the openapi `LadderConfig`
 * schema, and the contract.test.ts sample) — see config.test.ts's drift-guard.
 */
export async function configView(): Promise<Response> {
  const body = {
    alertRank: ALERT_RANK,
    // `ladder` + `pension.confirmCloses` are what /journal's drawdown card scores against —
    // it derives its leg from `ladder[rung - 1]` and folds its band through confirmCloses.
    ladder: [...LADDER],
    // The rung-ordered LEGP_* ids the card chains. Served (not re-typed in the browser) because
    // LEG_SLUG is a live constant with one source — public/journal-drawdown.js takes this array
    // and derives its leg as legIds[rung - 1], never from the unconstrained stored `sleeve`.
    legIds: LADDER.map((sleeve) => legCloseId(sleeve)),
    scoringCuts: {
      pension: {
        dip: PENSION_DIP,
        correction: PENSION_CORRECTION,
        bear: PENSION_BEAR,
        confirmCloses: CONFIRM_CLOSES,
      },
      slow: {
        accelAmber: ACCEL_AMBER_PCTILE,
        accelRed: ACCEL_RED_PCTILE,
        vixLow: VIX_LOW_PCTILE,
        nearHigh: NEAR_HIGH_FRAC,
      },
      vt: { amber: VT_AMBER_RATIO, red: VT_RED_RATIO },
    },
  };
  // Moves only on deploy (same as /indicators) — cache hard (P7).
  return Response.json(body, { headers: { "Cache-Control": CACHE_STATIC } });
}
