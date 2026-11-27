import type { LadderSource } from "./ladder-live.js";

/** The labels a researched row may carry (a bare `UNCHANGED`/`STALE` takes its date from `labelDate`); `HELD until` / `NOT DUE until` are the gate's, never the patch's. `QUIET since <MM-DD>` takes only a listing URL, bare or `[…]`-bracketed — never a note (`(+3d)`). */
export const RESEARCH_LABEL = /^(CHANGED|UNSOURCED|(UNCHANGED|STALE)( \d{2}-\d{2})?|QUIET since \d{2}-\d{2}( (\[https?:\/\/[^\s\]]+\]|https?:\/\/\S+))?)$/;

/** The `MM-DD` a dated label carries: the newest source's date; `undefined` with no source. */
export const labelDate = (sources: readonly LadderSource[]): string | undefined => sources.map((x) => x.date).sort().at(-1)?.slice(5);
