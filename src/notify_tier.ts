/**
 * Generic notify scaffold for the OFF-LADDER tiers (slow bubble, VIX bottom, and
 * the next one) — ONE abstraction hosting them without forcing the richer fast
 * ladder in. Pure: no IO, no time. Each tier supplies a `NotifyTierSpec` literal
 * (see `slow_tier.ts`'s `SLOW_TIER`); tracks.ts calls `buildTierNotification(spec, …)`.
 *
 * Captures the part that is byte-identical across the off-ladder tiers today:
 *   - notify-on-UPWARD-band-change (rank-compared); the calmest band never pushes
 *   - the ntfy Title format `<prefix> - <transition|band>`
 *   - per-band ntfy tag + priority lookup
 *   - degraded verdict (null) → silent, null message
 * Leaves the irreducibly per-tier 10% — the body text — as a closure on the spec.
 *
 * Collapses the THREE parallel band-keyed maps the slow tier carries today
 * (SLOW_BAND_RANK in slow.ts + SLOW_BAND_TAGS + SLOW_BAND_PRIORITY in run.ts) into
 * ONE exhaustive `bands` record, so they can no longer drift independently — and a
 * newly-added band must declare rank/tag/priority or fail to compile.
 */

import type { NtfyMessage } from "./ntfy.js";

/** Per-band notify metadata: rank (drives upward-change), ntfy tag + priority. */
interface TierBand {
  rank: number;
  tag: string;
  priority: number;
}

/**
 * A tier's notify policy. `Band` is the tier's band/state enum; `V` its verdict.
 * `bands` is exhaustive over `Band` at compile time, so a new band must declare its
 * rank/tag/priority — no silent omission, no drift across three hand-synced maps.
 */
export interface NotifyTierSpec<Band extends string, V> {
  /** Short id for the "no change" header line, e.g. "bubble". */
  id: string;
  /** ntfy Title prefix (ASCII — Title is a latin1 HTTP header), e.g. "crash-dash bubble". */
  titlePrefix: string;
  bands: Record<Band, TierBand>;
  /** Extract the band from a verdict. */
  bandOf: (v: V) => Band;
  /** Compose the message body from a non-degraded verdict + header line + asOf. */
  body: (v: V, header: string, asOf: string) => string;
}

interface TierNotification {
  push: boolean;
  message: NtfyMessage | null;
}

/** The calmest band (rank 0): an upward change *to* it is impossible, so it never pushes. */
function calmestBand<Band extends string>(bands: Record<Band, TierBand>): Band {
  const calm = (Object.entries(bands) as Array<[Band, TierBand]>).find(([, b]) => b.rank === 0);
  if (!calm) throw new Error("NotifyTierSpec.bands must include a rank-0 (calmest) band");
  return calm[0];
}

/**
 * Notify-on-upward-band-change — THE one upgrade-only policy (S4). Generic over
 * any band enum via `rankOf`; the fast ladder (ladder.ts `decideNotify`) and every
 * tier (`decideTierNotify`) delegate here, so the policy can't drift between them.
 * `baseline` is the caller's already-defaulted last band. Pure.
 */
export function decideUpward<Band extends string>(
  rankOf: (band: Band) => number,
  baseline: Band,
  next: Band,
): { push: boolean; transition: string | null } {
  const push = rankOf(next) > rankOf(baseline);
  return { push, transition: push ? `${baseline} -> ${next}` : null };
}

/**
 * Notify-on-upward-band-change over a tier spec's rank map. `last === null`
 * (first run / degraded prior) is the calmest baseline, so a first run already
 * elevated pushes. Pure.
 */
export function decideTierNotify<Band extends string, V>(
  spec: NotifyTierSpec<Band, V>,
  last: Band | null,
  next: Band,
): { push: boolean; transition: string | null } {
  return decideUpward((b) => spec.bands[b].rank, last ?? calmestBand(spec.bands), next);
}

/**
 * Build a tier's notify decision + ntfy payload. Degraded verdict (`null`) → silent,
 * null message (mirrors buildSlowNotification's degraded contract). Pure.
 */
export function buildTierNotification<Band extends string, V>(
  spec: NotifyTierSpec<Band, V>,
  lastBand: Band | null,
  verdict: V | null,
  asOf: string,
): TierNotification {
  if (!verdict) return { push: false, message: null };
  const band = spec.bandOf(verdict);
  const { push, transition } = decideTierNotify(spec, lastBand, band);
  const header = transition ?? `${spec.id} ${band} (no change)`;
  return {
    push,
    message: {
      title: `${spec.titlePrefix} - ${transition ?? band}`,
      body: spec.body(verdict, header, asOf),
      tags: spec.bands[band].tag,
      priority: spec.bands[band].priority,
    },
  };
}
