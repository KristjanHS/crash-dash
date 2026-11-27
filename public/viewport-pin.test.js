// Pure-geometry + feature-detect cover for the visual-viewport sheet pin (viewport-pin.js).
// No DOM: the two exported functions the runtime pinning is built on are pure, so the math
// and the ABSENT branch are unit-testable without jsdom (`.claude/rules/frontend.md`).

import { describe, it, expect } from "vitest";
import { sheetTopFor, sheetSpanFor, hasVisualViewport } from "./viewport-pin.js";

describe("sheetTopFor", () => {
  it("puts the sheet bottom on the visual-viewport bottom (zoom 1: offsetTop 0)", () => {
    // vv fills the layout viewport (height 844) → a 200px sheet starts at 644 so its
    // bottom edge (644 + 200) lands on 844, identical to CSS `bottom: 0`.
    expect(sheetTopFor({ offsetTop: 0, height: 844 }, 200)).toBe(644);
  });

  it("adds the visual-viewport offset when pinch-zoomed and scrolled down", () => {
    // Pinch-zoomed: the visible rect is 500px tall, scrolled 300px down the layout viewport.
    // The sheet's bottom must reach offsetTop + height = 800, so a 200px sheet starts at 600.
    expect(sheetTopFor({ offsetTop: 300, height: 500 }, 200)).toBe(600);
  });

  it("clamps at 0 when the sheet is taller than the visible area", () => {
    // A 700px sheet in a 500px visible rect would compute -200; clamp keeps its head on-screen.
    expect(sheetTopFor({ offsetTop: 0, height: 500 }, 700)).toBe(0);
  });
});

describe("sheetSpanFor", () => {
  it("spans the full layout width at zoom 1", () => {
    expect(sheetSpanFor({ offsetLeft: 0, width: 390 })).toEqual({ left: 0, width: 390 });
  });

  it("narrows to the visible rect when pinch-zoomed and panned right", () => {
    // 2× zoom on a 390px phone shows 195px; panned 120px right. A left:0/right:0 sheet would
    // stay 390 wide and push its right-hand (weight) column past the visible edge.
    expect(sheetSpanFor({ offsetLeft: 120, width: 195 })).toEqual({ left: 120, width: 195 });
  });
});

describe("hasVisualViewport", () => {
  it("is true only when the window exposes visualViewport; false without it or for a nullish window", () => {
    expect(hasVisualViewport({ visualViewport: {} })).toBe(true);
    expect(hasVisualViewport({})).toBe(false);
    expect(hasVisualViewport(null)).toBe(false);
    expect(hasVisualViewport(undefined)).toBe(false);
  });
});
