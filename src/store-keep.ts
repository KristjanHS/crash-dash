/**
 * `keep(rows, idsOf, retain)` — the filter every row-bearing store write applies before persisting
 * (`SupabaseStore` in `store.ts`, `InMemoryStore` in `store-memory.ts`). A row survives iff EVERY
 * indicator id it carries passes `retain` — the stores' `retain` defaults to `retainable`
 * (`retention.ts`). Writers outside its reach (alert_log, calibration, scorer_vintage) are enumerated
 * with their reason in `retention.wiring.test.ts`. Pure — no imports.
 */
export type RetainPolicy = (id: string) => boolean;

export function keep<T>(rows: readonly T[], idsOf: (row: T) => readonly string[], retain: RetainPolicy): T[] {
  return rows.filter((r) => idsOf(r).every((id) => retain(id)));
}

/** A `readings` / `readings_warmup` row carries exactly its own indicator id. */
export const readingIds = (r: { readonly indicatorId: string }): readonly string[] => [r.indicatorId];

/** A `leg_pillars` row carries the member ids of its `basis` roster (sorted, `,`-joined); an empty roster carries none. */
export const pillarIds = (r: { readonly basis: string }): readonly string[] => r.basis.split(",").filter((id) => id !== "");
