/**
 * View-B structure-map AXES — the pure seam `lab.js` renders the grid from.
 *
 * The axes are a coverage contract over `src/danger-ladder.ts`'s `LEG_FIELD`, and
 * `renderStructureMap` fails SILENTLY when a leg's `(rgn, sec)` pair falls outside them — the cell
 * is simply never painted, with no error and no red suite. `lab.js` executes module-level DOM side
 * effects so a test can
 * never import it (`.claude/rules/frontend.md` §Testable slices go in a pure seam module); the
 * axes living here is what lets `lab.structure-map.test.js` pin that contract against the real
 * `LEG_FIELD` instead of a hand-typed mirror.
 *
 * Rows = region buckets (`LegField.rgn`), cols = exposure buckets (`LegField.sec`). Both may carry
 * a bucket no leg currently occupies (an empty row/column is CORRECT — the scaffold is derived from
 * constants, not from the data, so the matrix is stable when every leg reads 0).
 */

/** Region buckets, top→bottom. Every `LEG_FIELD[].rgn` must appear here. */
export const SM_ROWS = ["US", "exUS", "EM", "DM", "AW", "EU"];

/** Row header text per `SM_ROWS` entry — every row owes one, or the header paints `undefined`. */
export const SM_ROW_LABEL = {
  US: "US",
  exUS: "Dev ex-US",
  EM: "Emerging",
  DM: "Global-DM",
  AW: "Global-AW",
  EU: "Europe",
};

/** Exposure buckets, left→right. Every `LEG_FIELD[].sec` must appear here. */
export const SM_COLS = ["Semis", "Tech", "Broad", "Value", "Income", "Health", "Staples", "HiDiv"];
