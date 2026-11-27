/*
 * View-B structure map — the AXIS-COVERAGE guard over `LEG_FIELD`.
 *
 * `renderStructureMap` (lab.js) indexes legs by `${rgn}|${sec}` and paints only the cells of
 * `SM_ROWS × SM_COLS`. A leg whose descriptor codes fall OUTSIDE those axes is therefore dropped
 * from the map SILENTLY — no error, no red suite, the sleeve just vanishes from View B. A PERMANENT
 * guard, not an in-session check: it closes the class for all nine legs, so the next descriptor edit
 * inherits it.
 *
 * Pins against the REAL `LEG_FIELD` (extensionless TS specifier, never `.js` —
 * `.claude/rules/frontend.md` §A `public/*.test.js` importing a TS module) and the REAL axes seam
 * `lab.js` imports, so neither side is a hand-typed mirror.
 */
import { describe, expect, test } from "vitest";

import { SM_ROWS, SM_ROW_LABEL, SM_COLS } from "./structure-map-axes.js";
import { LEG_FIELD } from "../src/danger-ladder";

describe("structure-map axes cover every ladder leg", () => {
  test("every leg's (rgn, sec) pair lies inside SM_ROWS × SM_COLS", () => {
    expect(LEG_FIELD.map((l) => l.sleeve)).toContain("Semis");
    for (const leg of LEG_FIELD) {
      expect(SM_ROWS, `${leg.sleeve}: rgn "${leg.rgn}" is not a structure-map row`).toContain(leg.rgn);
      expect(SM_COLS, `${leg.sleeve}: sec "${leg.sec}" is not a structure-map column`).toContain(leg.sec);
    }
  });

  test("no two legs share a cell - grid position alone identifies the sleeve", () => {
    const seen = new Map();
    for (const leg of LEG_FIELD) {
      const cell = `${leg.rgn}|${leg.sec}`;
      expect(seen.get(cell), `${leg.sleeve} collides with ${seen.get(cell)} at ${cell}`).toBeUndefined();
      seen.set(cell, leg.sleeve);
    }
  });

  test("every SM_ROWS bucket has a header label", () => {
    for (const rgn of SM_ROWS) {
      expect(typeof SM_ROW_LABEL[rgn], `row "${rgn}" has no SM_ROW_LABEL`).toBe("string");
    }
  });
});
