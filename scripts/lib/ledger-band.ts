/**
 * ledger-band.ts — the Danger-ledger band of a leg's `danger` scalar, and the before→after band-change
 * summary `probe-leg-ordering.ts --arm=diff` prints. Pure: no IO, no argv.
 *
 * ⚠ WHY THIS EXISTS (the probe-band row). An earlier commit read the probe's
 * `RAG` column — `legRAG`, the max-`wsev` leg colour on the SEVERITY scale — and missed that Semis'
 * `danger` fell 0.700 → 0.202, i.e. RED → GREEN on the ledger the user reads. The ledger band is
 * `danger` banded at `DANGER_CUTS` (danger scale), a DIFFERENT seam from `legRAG`; neither column
 * stands in for the other.
 *
 * ⚠ A SEPARATE MODULE ONLY BECAUSE THE PROBE CANNOT BE IMPORTED: `probe-leg-ordering.ts` parses argv and
 * loads the store at module top level, so a test importing it would run the probe.
 */
import { DANGER_CUTS } from "../../src/danger-concentration.js";
import type { State } from "../../src/domain-types.js";

/** `danger` banded at `DANGER_CUTS`: RED at or above `red`, AMBER at or above `amber`, GREEN below.
 *  Both cuts are INCLUSIVE lower bounds. Reads the constant — never restate its numbers. */
export function ledgerBand(danger: number, cuts: Readonly<{ amber: number; red: number }> = DANGER_CUTS): State {
  return danger >= cuts.red ? "RED" : danger >= cuts.amber ? "AMBER" : "GREEN";
}

export const BAND_LETTER: Readonly<Record<State, "G" | "A" | "R">> = { GREEN: "G", AMBER: "A", RED: "R" };

export interface BandChange {
  leg: string;
  before: State;
  after: State;
}

/** Legs whose ledger band differs between the arms, in the AFTER arm's row order. A leg absent from the
 *  BEFORE arm is not a band change (the diff table already marks it `(new)`). */
export function bandChanges(
  before: readonly { sleeve: string; ledgerBand: State }[],
  after: readonly { sleeve: string; ledgerBand: State }[],
): BandChange[] {
  const b = new Map(before.map((r) => [r.sleeve, r.ledgerBand]));
  const out: BandChange[] = [];
  for (const r of after) {
    const prev = b.get(r.sleeve);
    if (prev !== undefined && prev !== r.ledgerBand) out.push({ leg: r.sleeve, before: prev, after: r.ledgerBand });
  }
  return out;
}

/** The summary line under the diff table: `BAND CHANGE: Semis R → G, …` or `no band change`. */
export function formatBandChanges(changes: readonly BandChange[]): string {
  if (changes.length === 0) return "no band change";
  return `BAND CHANGE: ${changes.map((c) => `${c.leg} ${BAND_LETTER[c.before]} → ${BAND_LETTER[c.after]}`).join(", ")}`;
}
