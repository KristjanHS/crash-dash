// The ONE way a `public/` markup seam expresses a computed geometry (a bar fill's width, a tick's
// left, a scatter mark's left/top).
//
// prod's CSP (`style-src 'self'`, vercel.json) DROPS an inline style attribute, so a seam that wrote
// `style="width:62%"` painted the stylesheet default instead — full width for a track fill, i.e.
// every bar reading "at its gate". CSSOM (`el.style`) is not governed by the directive, so the
// markup carries the number as a data attribute and ONE post-write pass applies it. The pass is
// wired into `setHTML` (help-bar.js), the single writer both pages route through, so a new
// positioned element cannot miss it. Rule + the tone half of the same trap: `.claude/rules/frontend.md` §Inline style attributes are dead in prod.
//
// SCOPE ON PURPOSE: three properties, percent units, numbers only. There is no generic "data-style"
// channel here and must never be one — that hands back the injection surface the CSP closes.

/** css property → the data attribute carrying its percentage. */
export const POS_ATTR = {
  left: "data-css-left",
  top: "data-css-top",
  width: "data-css-width",
};

const SELECTOR = Object.values(POS_ATTR)
  .map((a) => `[${a}]`)
  .join(",");

/** Markup side: `{ left, top, width }` (numbers, percent) → the attribute string to splice into a
 *  tag. A missing / null / non-finite value emits nothing, so an absent geometry stays absent
 *  rather than pinning the element at 0%. Values are numbers ⇒ nothing to escape.
 *  @returns {string} e.g. ` data-css-left="62.5"`, leading space included. */
export function posAttrs(pos) {
  let out = "";
  for (const [prop, attr] of Object.entries(POS_ATTR)) {
    const raw = pos ? pos[prop] : undefined;
    if (raw === null || raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    out += ` ${attr}="${n}"`;
  }
  return out;
}

/** DOM side: apply every `data-css-*` under `root` (and on `root` itself) through CSSOM. Idempotent
 *  — re-running over the same subtree sets the same values, so a double call is harmless.
 *  Tolerates a DOM-less root (returns silently) so a non-browser caller cannot crash. */
export function applyPositions(root) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  const found = root.querySelectorAll(SELECTOR);
  const hosts = root.matches?.(SELECTOR) ? [root, ...found] : found;
  for (const el of hosts) {
    if (!el || !el.style) continue;
    for (const [prop, attr] of Object.entries(POS_ATTR)) {
      const raw = el.getAttribute?.(attr);
      if (raw === null || raw === undefined) continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      el.style.setProperty(prop, `${n}%`);
    }
  }
}
