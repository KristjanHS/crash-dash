/**
 * PostgREST response caps — a ZERO-IMPORT leaf, deliberately.
 *
 * `POSTGREST_MAX_ROWS` used to live in `store.ts`, but `store.ts` sits inside a value-import cluster
 * (`store → alert-band → t1dial → danger-engine → feed-lag`), so any module in that cluster that
 * needs the cap closes a runtime cycle — `src/import-cycle.test.ts` reds on exactly that. Splitting
 * the constant into a leaf lets `feed-lag.ts` (`LAG_CHUNK_IDS`) read it without an edge back to the
 * persistence seam. `store.ts` RE-EXPORTS it, so every existing `from "./store.js"` importer is
 * untouched.
 */

/**
 * PostgREST's `[api] max_rows` caps EVERY response at this many rows (local config.toml
 * + a SEPARATE prod project setting, both 5000) REGARDLESS of any `.limit(n)` — a deep
 * read that expects more silently truncates at the cap. config.toml is NOT a migration,
 * so bumping it locally does not propagate to prod: the code must never depend on the cap
 * being anything but 5000 in prod. Exported so the /health probe can report it and tests
 * can inject a smaller page size into `paginateRows`.
 */
export const POSTGREST_MAX_ROWS = 5000;
