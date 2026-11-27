// Run-wide provider-fallback record — a zero-import leaf so the read-path seam (`series-db-first.ts`) can read it without
// reaching the feed layer. a price source marks every provider hop (uncapped) and resets at run entry; the persist drain never clears it.
const hopped = new Set<string>();

export function markProviderFallback(symbol: string): void {
  hopped.add(symbol);
}

export function resetProviderFallbackLatch(): void {
  hopped.clear();
}

/** True once `symbol` hopped providers since run entry — `finalRewriteHeld` (prices.ts) reads it. */
export function providerFallbackHopped(symbol: string): boolean {
  return hopped.has(symbol);
}

/** The distinct symbols hopped since run entry, first-seen order — the gap-fill gate's input (`fallbackGate`). */
export function providerFallbackSymbols(): readonly string[] {
  return [...hopped];
}
