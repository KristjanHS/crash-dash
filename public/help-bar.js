// Shared mobile-help wiring: inject a ⓘ glyph on every [title] and funnel a tap
// into the one fixed #help-bar. Extracted from app.js (Stage 3.1) so both the
// dashboard and /lab can import the identical behavior. Plain browser ESM; no
// build. The `title=` strings stay the single source of truth (esc()'d by the
// caller). See app.js for the original inline design notes.

import { applyPositions } from "./inline-pos.js";
import { HELP_GLYPH_CLASS, HELP_CARVEOUT_SELECTOR, HELP_TAP_PRIORITY_SELECTOR, HELP_GLYPH_KEEP_SELECTOR, needsGlyph } from "./help-decorate.js";
import { createSheetPin } from "./viewport-pin.js";

/**
 * Inject a ⓘ glyph on the root (if titled) and every descendant [title] host.
 * Idempotent: the `:scope > .help-i` guard blocks a double-decorate, and
 * carve-out marks (abs-positioned) get no glyph — a tap reads their title
 * directly via the capture handler below.
 */
export function decorateHelp(root) {
  // The root itself counts. querySelectorAll("[title]") only matches descendants, which was
  // harmless while the only caller passed the dashboard ancestor — but setHTML() now scopes
  // this to the element being written, and a titled write target would silently go unglyphed.
  const hosts = root.matches?.("[title]") ? [root, ...root.querySelectorAll("[title]")] : root.querySelectorAll("[title]");
  // Derived ONCE per write: /lab's root carries data-help="tap-first" (glyphless page — a tap on
  // the host itself reads the title); the dashboard root carries no marker, so app.js is unchanged.
  const tapFirstPage = !!root.closest?.('[data-help="tap-first"]');
  for (const el of hosts) {
    const isCarveOut = el.matches(HELP_CARVEOUT_SELECTOR); // pass-through host — tap it directly (see handler)
    const alreadyDecorated = !!el.querySelector(`:scope > .${HELP_GLYPH_CLASS}`);
    const keepsGlyph = tapFirstPage && el.matches(HELP_GLYPH_KEEP_SELECTOR);
    if (!needsGlyph({ isCarveOut, alreadyDecorated, tapFirstPage, keepsGlyph })) continue;
    const g = document.createElement("button");
    g.type = "button";
    g.className = HELP_GLYPH_CLASS;
    g.setAttribute("aria-label", "explain");
    g.textContent = "ⓘ";
    el.appendChild(g);
  }
}

/**
 * The one seam for a zone-level markup write: decorate in the SAME task as the
 * write, so the glyphs are present the first time the browser lays the new
 * content out. Every writer that can host a `[title]` must go through this —
 * a bare `el.innerHTML = …` reintroduces the bug below.
 *
 * Why not restore the glyphs afterwards: they are in-flow 24px buttons on ~83
 * hosts, so a write that destroys them all and puts them back later transiently
 * shrinks the document ~227px. Zone D is the last zone, so reading the detail
 * chart parks scrollY at max — and at max scroll a shrinking document makes the
 * browser clamp scrollY down irreversibly (`scrollBy(0, +delta)` at max is a
 * no-op). That clamp was the residual ~54px viewport jump on a no-op mode
 * re-click. Deferring the restore cannot fix it: an rAF lands a whole frame
 * late, and even a MutationObserver callback is only a microtask, so it still
 * runs *after* the synchronous forced layout that commits the clamp. The write
 * is the sole point early enough.
 *
 * Decorating here also means the glyph can stay in flow: no out-of-flow
 * positioning is needed, and the rendering is pixel-identical to before.
 */
export function setHTML(el, html) {
  el.innerHTML = html;
  // Computed geometry (bar fills, ticks, scatter marks) is applied through CSSOM HERE, in the same
  // task as the write — the markup cannot carry it as a style attribute (inline-pos.js).
  applyPositions(el);
  decorateHelp(el);
}

/** Hides the wired help bar; a no-op until `wireHelpBar` runs (same idiom as lab.js `closeCellTip`).
 *  Exported so another bottom sheet's open (lab.js cell-tip) can close this one under it. */
export let hideHelp = () => {};

/**
 * Wire the document-level help behavior for a help bar. Registers ONE
 * capture-phase click handler + the Escape keydown handler. `rootEl` is the
 * element `decorateHelp` was initially run over (kept for API symmetry with the
 * caller / Stage 3.2 lab wiring); the handlers themselves are document-level.
 * `helpBarEl` is the fixed #help-bar this instance drives.
 *
 * `opts` (optional — the dashboard passes none, so nothing below changes there):
 *  - `detailAction(host)` → `{ id, label }` when THIS [title] host should offer a jump to the
 *    indicator's detail view, else null. Resolved per open; the sheet then carries one
 *    `.help-bar-action` button under the text. Policy lives with the page (detail-jump.js).
 *  - `onDetail(id)` → the page's navigation (in-page state set on /overview, a deep link from
 *    /lab). The sheet closes first. This file knows nothing of indicators, Zone D or modes.
 */
export function wireHelpBar(rootEl, helpBarEl, opts = {}) {
  // The bar is a `bottom: 0` fixed sheet; under pinch-zoom that anchors it below the visible
  // fold, so pin its top to the visual viewport WHILE SHOWN (no-op where the API is absent).
  const pin = createSheetPin(helpBarEl);
  function showHelp(text, action) {
    const p = helpBarEl.querySelector(".help-bar-text"); // degrade gracefully if markup drifts
    if (p) p.textContent = text;
    // The action row is rebuilt on every open and dropped when this host offers none — a
    // stale row from the previous chip must never survive into an unrelated description.
    helpBarEl.querySelector(".help-bar-action")?.remove();
    if (action && action.id) {
      const b = document.createElement("button"); // createElement, not markup: write-seam pins the one innerHTML line
      b.type = "button";
      b.className = "help-bar-action";
      b.dataset.ind = action.id;
      b.textContent = `→ Open ${action.label || action.id} indicator detail`;
      helpBarEl.appendChild(b); // flex-wrap + flex-basis:100% (styles.css) drop it to its own row
    }
    helpBarEl.hidden = false;
    pin.show(); // reposition + attach resize/scroll listeners AFTER unhiding so offsetHeight is real
  }
  hideHelp = () => {
    helpBarEl.querySelector(".help-bar-action")?.remove(); // a closed sheet carries no stale jump
    helpBarEl.hidden = true;
    pin.hide(); // detach the listeners + clear the pinned top so CSS `bottom: 0` resumes
  };

  // CAPTURE phase (3rd arg `true`): the card/tab/range actions are delegated bubble
  // listeners on els.zoneC / els.zoneD — descendants of document, so on a glyph tap
  // they would fire BEFORE a document-level bubble handler could stopPropagation.
  // Capturing at document runs first (top-down), so stopPropagation here halts the
  // event before any of those see it. That's what keeps a glyph tap from also
  // opening card→history / switching a tab / setting a range.
  document.addEventListener(
    "click",
    (e) => {
      if (e.target.closest(".help-bar-close")) {
        hideHelp();
        return;
      }
      const act = e.target.closest(".help-bar-action");
      if (act) {
        e.stopPropagation();
        const id = act.dataset.ind;
        hideHelp();
        opts.onDetail?.(id);
        return;
      }
      const glyph = e.target.closest(`.${HELP_GLYPH_CLASS}`);
      if (glyph) {
        e.stopPropagation(); // suppress the host's own action (card/tab/range)
        const host = glyph.closest("[title]"); // glyph is appended inside the [title] host
        showHelp(host?.getAttribute("title") || "");
        return;
      }
      // Help-priority (checked BEFORE the carve-out): host sits inside a clickable ancestor
      // (Scenario tile) — stopPropagation so the tap reads help and never cycles.
      const pri = e.target.closest(HELP_TAP_PRIORITY_SELECTOR);
      if (pri) {
        e.stopPropagation();
        showHelp(pri.getAttribute("title") || "");
        return;
      }
      const tick = e.target.closest(HELP_CARVEOUT_SELECTOR); // carve-out: ticks have no competing action
      // `.bp-fold`/`.bp-note-toggle` sit inside the titled `.bp-floor` — their toggle tap must
      // not also open the floor's help.
      if (tick && !e.target.closest(".bp-fold, .bp-note-toggle")) {
        showHelp(tick.getAttribute("title") || "", opts.detailAction?.(tick));
        return;
      }
      if (!e.target.closest("#help-bar")) hideHelp(); // tap-outside dismiss (no stopPropagation — let the tap also act)
    },
    true,
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideHelp();
  });
}
