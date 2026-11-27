/**
 * Shared read-API helpers (arch-refactor S4). The `?limit=` parse+clamp, the two
 * repeated Cache-Control policies, and the one `ALL_INDICATORS` lookup map each
 * live here once so the per-route handlers in `api/*.ts` stay thin without
 * re-deriving them. Behavior-preserving hoist — the handlers' GET shapes are
 * unchanged. (The per-route limit bounds stay at their call sites; only what was
 * duplicated is centralized. `/status` is no longer unique — it rides `VINTAGE_HEADERS`.)
 */
import { ALL_INDICATORS } from "../registry.js";
import { CHART_ONLY_INDICATORS } from "../registry-composite.js";

/**
 * Edge-cache policy for EVERY read whose body moves with a cron run (P-2). The day-long
 * TTL+SWR is safe only because `api/cron/run.ts` purges `VINTAGE_TAG` after each run.
 */
export const CACHE_VINTAGE = "s-maxage=86400, stale-while-revalidate=86400";

/** The one tag `api/cron/run.ts` invalidates; a response without it can never be purged. */
export const VINTAGE_TAG = "vintage";

/** Spread into a vintage-dependent `Response.json` — policy and tag must travel together. */
export const VINTAGE_HEADERS = { "Cache-Control": CACHE_VINTAGE, "Vercel-Cache-Tag": VINTAGE_TAG };

/**
 * Edge-cache policy for a DEGRADED 200 — a payload served despite a *store* failure (P12.d /
 * plan P7 negative caching). 60 s, not the vintage day, and not `no-store`: the degrade is
 * transient, so the edge retries ONE request per minute per key (instead of one full handler
 * run per user under `no-store`), while a recovered store is re-served within a minute
 * (instead of after the next cron purge under the day-long `CACHE_VINTAGE`). Carries
 * `VINTAGE_TAG` so the cron's purge still reaches a degraded copy early. 400s stay
 * `no-store` — an invalid request is not a transient condition worth caching.
 */
const CACHE_DEGRADED = "s-maxage=60";

/** Spread into a store-degraded 200 `Response.json` — policy and tag must travel together. */
export const DEGRADED_HEADERS = { "Cache-Control": CACHE_DEGRADED, "Vercel-Cache-Tag": VINTAGE_TAG };

/**
 * Edge-cache policy for static config that moves only on deploy. ONE live consumer:
 * `configView` in `./meta-views.ts`, served at `/api/config` (a `vercel.json` rewrite
 * onto `/api/meta?view=config`). `/indicators` is NOT on this policy — it is on
 * `VINTAGE_HEADERS` because it is vintage-dependent and deploy-only caching hid a calib
 * publish (`api/indicators.ts`). Re-grep `CACHE_STATIC` before extending this list.
 *
 * The hard hour lives at the EDGE (`s-maxage`), not in the browser, because a Vercel
 * deploy purges the edge cache but cannot reach a `max-age` copy already in a tab — a
 * constant shipped in a deploy would otherwise stay stale for up to an hour with no way
 * to bust it. The browser keeps a 60s copy, matching the per-tab poll interval, so a
 * poll still doesn't refetch identical bytes.
 */
export const CACHE_STATIC = "public, max-age=60, s-maxage=3600";

/**
 * Indicator metadata keyed by id — reconstructs the label/unit the readings store
 * omits (`/series`) and labels `/status` readings. Built once from ALL_INDICATORS
 * PLUS `CHART_ONLY_INDICATORS` (registry.ts) — ids that are persisted and charted but
 * deliberately outside `ALL_INDICATORS` (VTP).
 * `/series` gates its 400 on this map, so a
 * chart-only id is unreachable without membership; nothing here scores or bands an id.
 */
export const META = new Map([...ALL_INDICATORS, ...CHART_ONLY_INDICATORS].map((i) => [i.id, i]));

/**
 * Parse + validate a `?limit=` query param. Returns the integer when it's in
 * `[1, max]`, a 400 `Response` otherwise; an absent param (`null`) yields `def`.
 * Callers branch on `instanceof Response` to early-return the 400.
 */
export function parseLimit(raw: string | null, opts: { def: number; max: number }): number | Response {
  const limit = raw === null ? opts.def : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > opts.max) {
    return Response.json({ error: `limit must be an integer in 1..${opts.max}` }, { status: 400 });
  }
  return limit;
}

/**
 * Reject any request carrying a query param outside the handler's KNOWN set — the S-1
 * cache-key canonicalisation. An unrecognised param (`?cb=…`/`?_cb=…`) otherwise mints a
 * fresh edge-cache key that GUARANTEES a MISS with the endpoint's full work behind it; here
 * it costs a 400 instead, refused BEFORE any store read or upstream fetch. Returns a 400
 * `no-store` Response for the caller to early-return, or `null` when every param is known.
 * `allowed` is the exact set the GET (and every helper it calls) reads via
 * `searchParams.get`/`.has` — an EMPTY set means the endpoint takes no params, so any param 400s.
 */
export function rejectUnknownParams(params: URLSearchParams, allowed: readonly string[]): Response | null {
  const allow = new Set(allowed);
  for (const key of params.keys()) {
    if (!allow.has(key)) {
      return Response.json(
        { error: `unknown query param "${key}"` },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
  }
  return null;
}

type HeaderMap = Readonly<Record<string, string>>;

/** `serveRedactable`'s seam: the headers a 200 rides (default `VINTAGE_HEADERS`). A thunk is read only after the
 *  body settles, so a handler whose policy is decided while building the body (a store degrade) picks it then. */
export type RedactableOpts = { publicHeaders?: HeaderMap | (() => HeaderMap) };

/**
 * The one response rule for a read whose body carries redactable fields. The handler builds the FULL body;
 * every request is served `redact(raw)` on `opts.publicHeaders` (default `VINTAGE_HEADERS`) — one shared edge copy,
 * whatever headers the request carries. A `Response` from `bodyP` (a 404, a 400) passes through untouched.
 */
export async function serveRedactable<T, R = T>(
  bodyP: T | Response | Promise<T | Response>,
  redact: (raw: T) => R,
  opts: RedactableOpts = {},
): Promise<Response> {
  const raw = await bodyP;
  if (raw instanceof Response) return raw;
  const headers = typeof opts.publicHeaders === "function" ? opts.publicHeaders() : opts.publicHeaders;
  return Response.json(redact(raw), { headers: headers ?? VINTAGE_HEADERS });
}
