/** Per-signal cell types + liveness predicates: a leaf under `danger-engine.ts` and `growth.ts`. */
import type { SignalKey } from "./danger-ladder.js";

/** A member indicator's live severity (RED→lit, AMBER→elev, else calm). */
export type Severity = "lit" | "elev" | "calm";
/** A per-signal cell state: a severity, or `na` (family stubbed/memberless) vs `insensitive` (members,
 *  none relevant on this leg); neither carries a severity. */
export type CellState = Severity | "na" | "insensitive";

/** A per-signal cell for one leg: the rolled-up state + the M-of-N firing drill-down. */
export interface SignalCell {
  family: SignalKey;
  cellState: CellState;
  /** relevant members firing (elev or lit). */
  M: number;
  /** relevant members total. `0` → the cell is NOT sensitive: cellState is `na` or `insensitive`. */
  N: number;
  /** WEIGHTED severity ∈ [0,1] = max over observed relevant members of `memberWeight` × sev, unscaled;
   *  `null` for na/insensitive/fully-unobserved cells. */
  wsev: number | null;
  /** OQ-5 census over the members this cell's severity derives from (`fresh+lag` entered the `wsev` max,
   *  `absent` excluded). REQUIRED, built ONLY in `computeCells`. See `CellObserved`. */
  observed: CellObserved;
  /** `HeldMark` when the argmax member's `wsev` was RAISED/resurrected by the signal-hold window, else
   *  `null`. Scoped to the argmax member alone; display/audit only — no danger/band/pick/notify reads it. */
  held: HeldMark | null;
}

/** Held-window provenance (see `SignalCell.held`): `member` (argmax), `closes` (window length via
 *  `signalHoldWindowOf` — an UPPER BOUND), `ageCloses` (observed age, `0`=requested close; absent=unknown). */
export interface HeldMark {
  member: string;
  closes: number;
  ageCloses?: number;
}

/** Per-cell observation census — see `SignalCell.observed`. */
export interface CellObserved {
  fresh: number;
  lag: number;
  absent: number;
  /** DEEP-LAG SUBSET of `lag` (`lagTier`, src/feed-lag.ts): `fresh+lag+absent = N` still holds,
   *  `deepLag <= lag`. REQUIRED. */
  deepLag: number;
  /** The member ids behind `absent`, in roster order, so a `1 absent` on screen names what to
   *  investigate. Always emitted by `censusOf`. */
  absentIds?: readonly string[];
}

/** `true` iff a cell state is an actual severity (NOT `na`/`insensitive`). Single home so a third tag
 *  can never silently widen a `!== "na"` test. */
export function isSensitiveState(s: CellState): boolean {
  return s !== "na" && s !== "insensitive";
}

/** A cell counts as LIVE iff it carries a severity (`wsev !== null`) OR is a measured sensitive cell whose
 *  members all went dark (read as 0 by `computeLegGrowth` and the leg-percentile reach probe). */
export function isLiveCell(c: SignalCell): boolean {
  return c.wsev !== null || isSensitiveState(c.cellState);
}
