/**
 * The fit lines' (Δ5d, `DELTA5_OVERLAY`) ONE shared show/hide switch. A click on any chart legend's
 * `.fit-toggle` flips `SHOW_FIT_CLASS` on the page root: styles.css shows `.fit-lines` only under it,
 * and hover-readout parks the chip around the lines' `fitYs` only under it. A root class (not per-chart
 * state) outlives every chart re-render and flips all charts at once. Off by default; not persisted.
 * Wired once per chart-hosting page (app.js, overview.js).
 */
export const SHOW_FIT_CLASS = "show-fit";

export function wireFitToggle(doc) {
  doc.addEventListener("click", (e) => {
    if (e.target.closest?.(".fit-toggle")) doc.documentElement.classList.toggle(SHOW_FIT_CLASS);
  });
}
