/** A series with no free data source (a daily-close symbol, an intraday ask, hourly bars) — unavailable by
 *  design, not an outage; needs a paid data API.
 *  Thrown, never served: callers' `degrade()` returns its fallback and logs the miss to the run's degrade trace
 *  (most sites with effect "notify") instead of aborting the run. */
export class NoFreeSourceError extends Error {
  constructor(readonly symbol: string) {
    super(`no free source for ${symbol} — requires a paid data API`);
    this.name = "NoFreeSourceError";
  }
}

/** Throws `NoFreeSourceError` for `series` — the binding of a port with no free source. */
export function noFreeSource(series: string): never {
  throw new NoFreeSourceError(series);
}

/** True for a `NoFreeSourceError` or an error whose `cause` is one (an aggregate whose every source had none). */
export const isNoFreeSource = (err: unknown): boolean => err instanceof NoFreeSourceError || (err instanceof Error && err.cause instanceof NoFreeSourceError);
