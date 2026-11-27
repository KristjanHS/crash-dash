// DOM-free policy for the mobile help-glyph decoration (help-bar.js decorateHelp).
// Kept out of app.js so the eligibility decision can be unit-tested under vitest
// without jsdom — the caller supplies the booleans it derives from each element, and
// this module owns the policy + the shared class/selector constants so the test
// and the runtime can't drift. Plain browser ESM (mirrors sparkline.js); no build.

/** Class on the injected ⓘ glyph button. */
export const HELP_GLYPH_CLASS = "help-i";

/**
 * Selector for the carve-out (pass-through tap): titled hosts that get NO injected ⓘ glyph but
 * stay tap-readable — a tap on the host itself reads its `title` → the help bar and the event
 * CONTINUES (no `stopPropagation`), because none of these hosts has a competing click action of
 * its own. See the capture handler in help-bar.js. Members:
 *   `.lab .sec-tip[title]` — the SECTION TITLES of the two `.lab` shells, /lab and /overview (the
 *                        band-panel chain strip, the families-board tag, the Danger-ledger /
 *                        Method-cards / Structure-map / Rotation-quadrant / Scoreboard /
 *                        Indicator-detail headings). CLASS-scoped, not `#lab`: /overview reuses these
 *                        same section renderers inside `<main id="overview" class="lab">`, and an
 *                        id-scoped entry left every one of its headings hover-only. Each is a heading
 *                        with no competing click action, so a tap reads its `title` straight into the
 *                        help bar — that tap IS the mobile affordance for these tooltips, since both
 *                        shells are tap-first (glyphless) pages.
 *                        A ⓘ beside a section heading would also sit in the one place the eye uses to
 *                        find the section.
 *   `#dangerField [title]` — the whole /lab Danger ledger (signal grid + footer): a ⓘ in
 *                        every dense cell/header clutters the table, AND the footer's tooltips
 *                        (knobs, R4 breaker chips) are written into #dfFoot AFTER the one-shot
 *                        decorateHelp(lab), so a glyph would never reach them anyway. So the
 *                        whole section keeps only its `title`s (native hover + tap-to-help), no
 *                        glyph.
 *   `#rrgQuadrant [title]` — the /lab rotation quadrant: each leg IS a tight name-box
 *                        positioned by an auto-fit declutter; an injected ⓘ widens the box
 *                        and defeats the anti-overlap fit, so legs keep only their `title`.
 *   `.tile .ids [title]:not([data-id])` — the /lab family-card leg-strip GROUP labels: a ⓘ per host
 *                        eats card width, so each keeps only its `title` (native hover + tap-to-help).
 *                        `:not([data-id])` EXCLUDES the member leg chips, which are carved by the
 *                        MODE-GATED entry below instead — not by this one.
 *   `.tile:not(.clickable) .ids [title][data-id]` — the member leg chips, LIVE ONLY ([USER]
 *                        2026-08-31, superseding #39's hover-only). `lab.js:584` writes `clickable`
 *                        for `d.mode === "scenario"` alone, so this gate hands the tap to help in
 *                        Live and to `onClick`'s cycle in Scenario. Keep them OUT of
 *                        HELP_TAP_PRIORITY: its `stopPropagation` would kill tap-cycling.
 *   `#boardLag [title]` — the board-head residual `⌁ⁿ` lag mark: no clickable ancestor.
 *   `#bandPanelHost [title]` — the alert-band floors/members/chips (box carriers already), EXCEPT
 *                        `.bp-fold`/`.bp-note-toggle` taps, excluded in the capture handler.
 *   `#smGridWrap [title]` — the structure-map cells: a ⓘ per number cell defeats the grid.
 *   `#sbBody .sb-na[title]` — the scoreboard "n/a yet" reason.
 * Keep in sync with lab.html's `cursor: pointer` tap-readable rule (the iOS click-delegation
 * unblocker) and its phone hit-box padding rule.
 */
export const HELP_CARVEOUT_SELECTOR = [
  ".lab .sec-tip[title]",
  "#dangerField [title]",
  "#rrgQuadrant [title]",
  ".tile .ids [title]:not([data-id])",
  ".tile:not(.clickable) .ids [title][data-id]",
  "#boardLag [title]",
  "#bandPanelHost [title]",
  "#smGridWrap [title]",
  "#sbBody .sb-na[title]",
  //   `.masthead .fn[title]` — the /overview masthead's footnote-on-a-word terms ([USER] 2026-09-06:
  //                        no ⓘ in the intro prose — the dotted underline IS the affordance). Static
  //                        header markup, no competing click action, so a tap reads the title straight
  //                        into the help bar; `.fn` in styles.css carries the underline.
  ".masthead .fn[title]",
  // Dashboard pass-through set (tap-first): titled hosts with
  // no competing click action of their own. Zone-A spans, family headers, chart control labels,
  // and the
  // off-ladder panel labels the zone titles retargeted onto (off-ladder-panel.js).
  "#zone-a .alert-chip[title]",
  "#zone-a .verdict-title[title]",
  "#zone-a .verdict-subline [title]",
  "#zone-c h2[title]",
  "#zone-c .chan-title[title]",
  "#zone-c .chan-lag[title]",
  "#zone-c .combo-label[title]",
  "#zone-d .ctl-label[title]",
  "#dashboard .bottom-label[title]",
  "#dashboard .pension-label[title]",
  "#dashboard .slow-label[title]",
  "#dashboard .pension-dd[title]",
  "#dashboard .pension-sleeves[title]",
  "#dashboard .pension-comparators[title]",
].join(", ");

/**
 * Selector for the help-priority tap: glyphless titled hosts INSIDE a clickable ancestor.
 * wireHelpBar's capture branch `stopPropagation()`s, so a tap on the host reads its `title` and
 * NEVER fires the ancestor's action; a tap anywhere else on the ancestor still acts. Members:
 *   `.tile .t-h[title]` — the family-desc header; ancestor `.tile.clickable` cycles the family.
 *   `.tile .fam-lag[title]` — the tile `⌁ⁿ` lag mark (carrier incl. its `sup`); same ancestor.
 *   `.tile .ids .lg-l[title]` — the role-group label; ALSO matches the carve-out, but this branch
 *                        runs first, curing the label-tap-also-cycles-the-family dual fire.
 * Irreducible glyph (kept OUT of this selector; stays ⓘ even on a tap-first page via
 * HELP_GLYPH_KEEP_SELECTOR): `#episodeReplay .erp-chip[data-episode][title]` — its `title` covers
 * the WHOLE action button, so a help-priority tap would steal the episode-select action entirely.
 */
export const HELP_TAP_PRIORITY_SELECTOR = [
  ".tile .t-h[title]",
  ".tile .fam-lag[title]",
  ".tile .ids .lg-l[title]",
  // Dashboard card children (tap-first): ancestor .card[data-id] activates the
  // detail tab via bubble delegation (onCardActivate), so these need the capture-phase
  // stopPropagation. .card-label carries the retargeted spec.tip (the /lab .tile→.t-h mirror).
  "#dashboard .card .card-label[title]",
  "#dashboard .card .card-delta[title]",
  "#dashboard .card .card-lag[title]",
].join(", ");

/** Hosts that keep their ⓘ on a tap-first page — the irreducible set; reason in the docblock
 *  above. Dashboard additions: the ~15 controls whose
 *  titled element IS the whole action hit area (tap ⓘ = help, tap control = act), plus
 *  `.card-marker`, whose injected ⓘ IS its only rendering (styles.css `.card-marker`) — glyphless
 *  it would be a zero-width unreachable [title].
 *  ⛔ A `<select>` can NEVER be listed here: `decorateHelp` appends the glyph as a CHILD of the host,
 *  and a select renders no child but `option`/`optgroup`, so the glyph measures 0×0 — present in the
 *  DOM (which is all `keepNoGlyph` used to check) and untappable. The three Zone-D pickers therefore
 *  carry their tooltip on the adjacent `.ctl-label` (a carve-out host) instead. */
export const HELP_GLYPH_KEEP_SELECTOR = [
  "#episodeReplay .erp-chip[data-episode][title]",
  "#zone-d .tab[data-tab][title]",
  "#dashboard .range[title]",
  "#dashboard .card-marker[title]",
].join(", ");

/**
 * Should this `[title]` host receive an injected ⓘ glyph?
 *
 * DOM-free on purpose: the caller passes the booleans it reads off the element,
 * so the policy is testable without a real DOM. `tapFirstPage` (the root carries
 * `data-help="tap-first"`; /lab) suppresses every glyph except the irreducible
 * `keepsGlyph` hosts; both default false so the dashboard caller is unchanged.
 *
 * @param {{ isCarveOut: boolean, alreadyDecorated: boolean, tapFirstPage?: boolean, keepsGlyph?: boolean }} flags
 * @returns {boolean}
 */
export function needsGlyph({
  isCarveOut,
  alreadyDecorated,
  tapFirstPage = false,
  keepsGlyph = false,
}) {
  if (alreadyDecorated || isCarveOut) return false;
  return tapFirstPage ? keepsGlyph : true;
}
