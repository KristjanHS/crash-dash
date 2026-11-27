/**
 * Retention policy — which indicator ids the store may persist rows for.
 *
 * The ONE predicate behind `keep()` (`store-keep.ts`): referenced by the default `retain` policy of
 * `SupabaseStore` and `InMemoryStore` and by `scripts/backup/restore-rows.ts` (the one out-of-store
 * `readings` writer). This file carries the policy alone, so a narrower policy changes only this file.
 * Today every id is retainable (no behaviour change); a narrower policy returns false for ids whose
 * rows must not be stored. `retention.wiring.test.ts` proves the id-keyed row writers honour it; the
 * `alert_log` writers are exempt, and their `run_inputs` blob still carries per-id values.
 */
export function retainable(_id: string): boolean {
  return true;
}
