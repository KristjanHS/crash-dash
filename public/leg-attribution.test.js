/**
 * D3 Stage 2.3 — the pure /lab attribution-badge seam (public/leg-attribution.js).
 *
 * Tests the seam, NOT lab.js: lab.js executes module-level DOM side effects and can never be
 * imported here (frontend.md rule). The seam is deliberately unfiltered — the server
 * (`src/lab-served-field.ts` dualAxisFiringIds) is the single gate on which ids may be attributed, and the
 * R2/R3/R4 exclusion is pinned there (api/lab.test.ts) rather than duplicated as a client-side
 * id list that could drift from `DUAL_AXIS_IDS`.
 */
import { describe, expect, it } from "vitest";

import {
  attributionIndex,
  axisBadgeText,
  axisBadgeTitle,
  declinedNoteText,
  declinedNoteTitle,
  notedDeclineReasons,
} from "./leg-attribution.js";
// `.ts` specifier, not `.js`: vite resolves a plain `.js` test file literally (no bundler
// extension rewrite), so `../src/families.js` fails to load. Same idiom as
// leading-name.test.js / indicator-desc.test.js — the import convention's `.js` rule governs
// TS sources compiled for Node ESM, which these test-only FE files never are.
import { LEG_ATTRIBUTION_DECLINED_REASONS } from "../src/families.ts";
import { LEG_PHRASE } from "./chart-primitives.js";

describe("attributionIndex", () => {
  it("indexes the legAttribution block by indicator id", () => {
    const d = {
      legAttribution: [
        { id: "F1", leg: "vel-op", axis: "velocity" },
        { id: "F11", leg: "op", axis: "level" },
      ],
    };
    const byId = attributionIndex(d);
    expect(byId.F1.axis).toBe("velocity");
    expect(byId.F11.axis).toBe("level");
  });

  it("is empty on the scenario/replay paths, where legAttribution is omitted", () => {
    expect(attributionIndex({ mode: "scenario" })).toEqual({});
    expect(attributionIndex(undefined)).toEqual({});
  });

  it("never invents an entry for an id the server did not attribute", () => {
    const byId = attributionIndex({ legAttribution: [{ id: "F1", leg: "vel-op", axis: "velocity" }] });
    // R2/R3/R4 are structurally absent from the server's block (velocity-only tautology),
    // so the reader must have nothing to render for them.
    for (const id of ["R2", "R3", "R4"]) expect(byId[id]).toBeUndefined();
    expect(byId.F2).toBeUndefined();
  });
});

describe("axisBadgeText", () => {
  it("names the LEG, mechanically and without severity language", () => {
    expect(axisBadgeText({ id: "F1", leg: "vel-op", axis: "velocity" })).toBe("(via velocity cut)");
    expect(axisBadgeText({ id: "F1", leg: "op", axis: "level" })).toBe("(via level cut)");
  });

  it("separates a borrowed Baa−10y leg from the id's OWN cut on the same axis", () => {
    // Both are `axis: "velocity"`, so only the leg NAME separates the borrowed Baa−10y leg from the
    // id's own cut — the distinction that matters on the two proxy ids.
    const borrowed = axisBadgeText({ id: "F1", leg: "vel-z", axis: "velocity" });
    const own = axisBadgeText({ id: "F1", leg: "vel-op", axis: "velocity" });
    expect(borrowed).toBe("(via velocity-z)");
    expect(borrowed).not.toBe(own);
  });

  it("takes its wording from LEG_PHRASE, never a local copy", () => {
    // Derived, not restated: a retune of the shared phrase table moves this badge with it.
    for (const [leg, phrase] of Object.entries(LEG_PHRASE)) {
      expect(axisBadgeText({ id: "F1", leg, axis: "level" })).toBe(`(via ${phrase})`);
    }
  });

  it("renders nothing for an unattributed / malformed entry", () => {
    expect(axisBadgeText(undefined)).toBe("");
    expect(axisBadgeText({ id: "F1", leg: "op", axis: "sideways" })).toBe("");
  });

  it("falls back to the bare axis for an unknown leg rather than leaking the token", () => {
    expect(axisBadgeText({ id: "F1", leg: "some-future-leg", axis: "level" })).toBe("(via level)");
    expect(axisBadgeText({ id: "F1", axis: "velocity" })).toBe("(via velocity)");
  });

  it("adds no exclamation or adjective (E-a copy discipline)", () => {
    for (const leg of Object.keys(LEG_PHRASE)) {
      const text = axisBadgeText({ id: "F1", leg, axis: "level" });
      expect(text).not.toMatch(/[!]/);
      expect(text).not.toMatch(/\b(red|amber|alert|warning|critical|danger)\b/i);
    }
  });
});

// The CANONICAL reason list, imported (not mirrored) from the server-side source of truth —
// `.js` importing `.ts` is fine here: vitest transforms it and tsc skips this file. A
// hand-copied array would have left the TS→JS direction unguarded: a new reason added in
// families.ts renders "" on the board, i.e. the calm-vs-declined ambiguity R2 exists to remove.
const DECLINED_REASONS = [...LEG_ATTRIBUTION_DECLINED_REASONS];

// [USER 2026-08-19] Both badge-slot notes are PARENTHESISED, so neither reads as one of the bare
// group labels ("band-driving" / "per-leg") that share the chip strip with them.
describe("the parenthesis contract", () => {
  it("wraps both the axis badge and every declined note", () => {
    expect(axisBadgeText({ id: "F1", leg: "op", axis: "level" })).toMatch(/^\(.+\)$/);
    for (const declined of LEG_ATTRIBUTION_DECLINED_REASONS) {
      expect(declinedNoteText({ id: "F11", declined })).toMatch(/^\(.+\)$/);
    }
  });

  it("leaves the empty cases empty - never a bare pair of brackets", () => {
    expect(axisBadgeText(undefined)).toBe("");
    expect(declinedNoteText({ id: "F1", declined: "not-a-reason" })).toBe("");
  });
});

describe("declinedNoteText", () => {
  it("gives every declined reason a note, so no firing paints as calm", () => {
    expect(DECLINED_REASONS.length).toBeGreaterThan(0);
    for (const declined of DECLINED_REASONS) {
      expect(declinedNoteText({ id: "F11", declined })).not.toBe("");
    }
  });

  it("carries copy for exactly the canonical reason set - no drift either way", () => {
    // The reverse direction: copy for a reason the server can never emit is dead code that
    // reads as coverage. Sorted compare so declaration order is free to differ.
    expect(notedDeclineReasons().sort()).toEqual([...DECLINED_REASONS].sort());
  });

  it("names which attempt failed - every reason gets its own phrase, none share copy", () => {
    expect(declinedNoteText({ id: "F11", declined: "no-history" })).toBe("(attribution held - no history)");
    // Names the fold and its DEPTH, off the payload — never a hardcoded tier [USER 2026-09-02].
    expect(declinedNoteText({ id: "F11", declined: "mid-confirm", confirmCloses: 2 })).toBe(
      "(attribution held - mid 2-close confirmation fold)",
    );
    expect(declinedNoteText({ id: "F11", declined: "mid-confirm", confirmCloses: 3 })).toBe(
      "(attribution held - mid 3-close confirmation fold)",
    );
    // A payload with no count (older deploy) still reads as a sentence — never "undefined-close".
    expect(declinedNoteText({ id: "F11", declined: "mid-confirm" })).toBe(
      "(attribution held - mid confirmation fold)",
    );
    const notes = DECLINED_REASONS.map((declined) => declinedNoteText({ id: "F11", declined }));
    expect(new Set(notes).size).toBe(DECLINED_REASONS.length);
  });

  it("renders nothing for an attributed, absent, or unknown-reason entry", () => {
    expect(declinedNoteText({ id: "F11", leg: "op", axis: "level" })).toBe("");
    expect(declinedNoteText(undefined)).toBe("");
    // Forward-compat: an unrecognised reason renders nothing rather than leaking a raw enum
    // token into chip copy.
    expect(declinedNoteText({ id: "F11", declined: "some-future-reason" })).toBe("");
  });

  it("names the attribution's outcome, never a severity (E-a copy discipline)", () => {
    for (const declined of DECLINED_REASONS) {
      const text = declinedNoteText({ id: "F11", declined });
      expect(text).toMatch(/^\(attribution (n\/a|held) - /);
      expect(text).not.toMatch(/[!]|\b(red|amber|alert|warning|critical|danger)\b/i);
    }
  });
});

describe("declinedNoteTitle", () => {
  it("explains every reason, so the note is never a bare unexplained phrase", () => {
    for (const declined of DECLINED_REASONS) {
      expect(declinedNoteTitle({ id: "F11", declined })).toContain("no level/velocity axis");
    }
  });

  it("is empty when there is nothing declined to explain", () => {
    expect(declinedNoteTitle(undefined)).toBe("");
    expect(declinedNoteTitle({ id: "F11", leg: "op", axis: "level" })).toBe("");
  });
});

describe("axisBadgeTitle", () => {
  it("names the winning leg so the chip cross-checks against the /series ribbon", () => {
    expect(axisBadgeTitle({ id: "F1", leg: "vel-z", axis: "velocity" })).toContain("vel-z");
  });

  it("is empty when there is no attribution", () => {
    expect(axisBadgeTitle(undefined)).toBe("");
  });
});
