// Pin a bottom sheet to the VISUAL viewport (help bar + the ≤640px cell-tip sheet).
//
// WHY: both sheets are `position: fixed; bottom: 0`, which anchors them to the LAYOUT
// viewport. On a phone the layout and visual viewports diverge under pinch-zoom — the
// layout viewport stays the full page width/height, while the visual viewport is the
// smaller rect the reader actually sees. A sheet pinned to the layout bottom then renders
// BELOW the visible fold (the "opens far below the screen" symptom).
// `window.visualViewport` exposes the
// visible rect and fires `resize`/`scroll` as the reader zooms and pans; re-pinning the
// sheet's top to it keeps the sheet's bottom edge on the visible bottom, and re-pinning its
// left/width keeps its right-hand columns inside the visible right edge (`sheetSpanFor`).
//
// CSSOM only, never a `style=` attribute: prod serves `style-src 'self'` with no
// `'unsafe-inline'`, so a markup style attribute is DROPPED (`.claude/rules/frontend.md`);
// `el.style.setProperty` is not governed by the directive. The mobile cell-tip rule uses
// `inset: … !important`, so the top/bottom overrides are written with `"important"` too —
// an inline `!important` beats a stylesheet `!important`.

/**
 * The `top` (px, in the layout/`position: fixed` frame) at which a bottom sheet of height
 * `sheetHeight` must sit so its BOTTOM edge lands on the visual viewport's bottom edge.
 *
 * The visual viewport's bottom, expressed in the fixed frame, is `offsetTop + height`
 * (its offset from the layout viewport top plus its own height); the sheet's top is that
 * minus the sheet's own height. Clamped at 0 so a sheet taller than the visible area starts
 * at the top rather than pushing its head off the top edge.
 *
 * @param {{offsetTop: number, height: number}} vv a `visualViewport` snapshot
 * @param {number} sheetHeight the sheet's rendered height in px
 * @returns {number} the `top` in px for `position: fixed`
 */
export function sheetTopFor(vv, sheetHeight) {
  return Math.max(0, vv.offsetTop + vv.height - sheetHeight);
}

/**
 * The horizontal half of the pin: the `left`/`width` (px, fixed frame) that make the sheet span
 * exactly the VISUAL viewport. `left: 0; right: 0` spans the LAYOUT viewport, which under
 * pinch-zoom is wider than what the reader sees — the sheet's right-hand columns (the cell-tip's
 * `×weight`/state columns) then sit past the visible right edge (user report 2026-10-24).
 * Matching the visible rect makes the content wrap inside it instead.
 *
 * @param {{offsetLeft: number, width: number}} vv a `visualViewport` snapshot
 * @returns {{left: number, width: number}}
 */
export function sheetSpanFor(vv) {
  return { left: Math.max(0, vv.offsetLeft), width: Math.max(0, vv.width) };
}

/**
 * Feature-detect the visual-viewport API on a window-like object. Kept as a pure predicate
 * (the window is a parameter, not the ambient global) so the ABSENT branch — older browsers
 * and the jsdom-free test env, where the CSS `bottom: 0` positioning must be left untouched
 * — is unit-testable without a DOM.
 *
 * @param {{visualViewport?: unknown} | null | undefined} win
 * @returns {boolean}
 */
export function hasVisualViewport(win) {
  return !!(win && win.visualViewport);
}

/**
 * A controller that pins one bottom-sheet element to the visual viewport while it is shown.
 *
 * `show()` repositions the sheet and attaches the `resize`/`scroll` listeners; `hide()`
 * detaches them and clears the pinned top/bottom so the stylesheet's `bottom: 0` resumes
 * exactly. Listeners exist ONLY between show and hide — nothing does layout work while no
 * sheet is visible — and `hide()` before any `show()` is a true no-op, so a caller that
 * positions the element itself on desktop (cell-tip's `placeCellTip`) is never disturbed.
 *
 * When `window.visualViewport` is absent, both methods are no-ops: the caller needs no
 * branch of its own and the existing CSS positioning stands unchanged.
 *
 * @param {HTMLElement} el the fixed bottom-sheet element to pin
 * @returns {{ show: () => void, hide: () => void }}
 */
export function createSheetPin(el) {
  // Read the ambient global lazily and only here — the module stays import-safe under Node
  // (no top-level `window`), and the feature-detect uses the same pure predicate the test does.
  if (!hasVisualViewport(typeof window !== "undefined" ? window : null)) {
    return { show() {}, hide() {} };
  }
  const vv = window.visualViewport;
  let pinned = false;
  // `offsetHeight` (a forced layout) is read per event ON PURPOSE: the sheet's height is
  // content-driven and can differ per open, and this runs only while a small sheet is visible.
  // Horizontal span FIRST: the width decides how the content wraps, so the height read for the
  // vertical pin must come after it.
  const reposition = () => {
    const { left, width } = sheetSpanFor(vv);
    el.style.setProperty("left", `${left}px`, "important");
    el.style.setProperty("right", "auto", "important");
    el.style.setProperty("width", `${width}px`, "important");
    el.style.setProperty("top", `${sheetTopFor(vv, el.offsetHeight)}px`, "important");
    el.style.setProperty("bottom", "auto", "important");
  };
  return {
    show() {
      pinned = true;
      reposition();
      vv.addEventListener("resize", reposition);
      vv.addEventListener("scroll", reposition);
    },
    hide() {
      if (!pinned) return; // never touch styles this controller did not set
      pinned = false;
      vv.removeEventListener("resize", reposition);
      vv.removeEventListener("scroll", reposition);
      for (const p of ["top", "bottom", "left", "right", "width"]) el.style.removeProperty(p);
    },
  };
}
