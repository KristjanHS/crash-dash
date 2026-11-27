// Families-board chip → Indicator detail jump: the PURE policy behind the `detailAction` /
// `onDetail` options of `wireHelpBar` (help-bar.js). Pages own the navigation; this module owns
// only "which chip may offer a jump, to which id, under what label" and the deep-link intake the
// dashboard runs at boot. DOM-free on purpose — the suite has no jsdom — so a host is anything
// with `matches`/`dataset`/`textContent` (a real element in the page, a stub in the test).

/** A member chip on the families board: `legSpan` (lab-board.js) emits `data-id` = the raw
 *  registry id inside the tile's `.ids` strip. Disjoint from every glyph / ledger / band host. */
export const CHIP_SELECTOR = ".tile .ids [data-id]";

/** Query param the dashboard reads once at boot to preselect Zone D's indicator. */
export const DEEP_LINK_PARAM = "ind";

/**
 * Resolve the detail-jump target for a tapped `[title]` host, or null when the host is not a
 * member chip / must not offer one.
 *  - `scenario: true` ⇒ always null (Scenario chips cycle state; belt-and-braces — an interactive
 *    Scenario chip never opens the sheet at all, see the plan's as-built notes).
 *  - `metas` (the `/api/indicators` list) given ⇒ the id must be served, and the label is the
 *    meta's; an unknown id yields null (no row, never a dead jump).
 *  - `metas` absent (/lab holds no meta list) ⇒ the chip's own text is the label.
 */
export function chipDetailTarget(host, { metas = null, scenario = false } = {}) {
  if (scenario || !host || typeof host.matches !== "function" || !host.matches(CHIP_SELECTOR)) return null;
  const id = host.dataset?.id;
  if (!id) return null;
  if (metas) {
    const meta = metas.find((m) => m.id === id);
    return meta ? { id, label: meta.label || id } : null;
  }
  const text = (host.textContent || "").trim();
  return { id, label: text || id };
}

/** The cross-page jump: `/lab` lands on the DASHBOARD's Zone D with the indicator preselected. */
export function detailJumpUrl(id) {
  return `/?${DEEP_LINK_PARAM}=${encodeURIComponent(id)}#zone-d`;
}

/**
 * Boot intake: the `?ind=` id when it names a served indicator, else null (the tab keeps its
 * normal prompt). The hash is NOT read — `#zone-d` is the scroll anchor, not a param channel.
 */
export function deepLinkIndicatorId(search, metas) {
  const id = new URLSearchParams(search || "").get(DEEP_LINK_PARAM);
  if (!id || !Array.isArray(metas)) return null;
  return metas.some((m) => m.id === id) ? id : null;
}
