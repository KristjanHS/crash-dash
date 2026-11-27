// The generic overlay strip painted into the danger-ledger footer (#dfFoot). ONE row
// builder over `{ id, label, headline, tone, fields[], note? }` serves R4 today and
// R1/R5/Y1 as they land — no new render function per overlay.
//
// Pure string builder: zero DOM reads, zero localStorage, zero module-level side effects, so
// overlay-strip.test.js can import it with NO jsdom (`.claude/rules/frontend.md` forbids
// importing lab.js from a test — it has module-level DOM side effects). `.js` so vitest
// collects it while tsc (no allowJs) ignores it.
//
// CLASSES: `.overlay-row` / `.overlay-head` / `.overlay-field` / `.overlay-note` / `.overlay-climb` /
// `.overlay-group-head` / `.overlay-idle` / `.overlay-ddgate` / `.overlay-<tone>`, all styled in
// `public/styles.css` §"Overlay strip" — the SHARED sheet, not a per-page scoped block, because
// `index.html` has no scoped `<style>` and `lab.html` only `<link>`s the sheet. (Until 2026-09-19
// this docblock claimed they were "styled under `.df-foot` in lab.html"; nothing was styled at all,
// so `alert` and `caution` rows painted identically to `neutral`.)
//
// VALUES ARE PRE-FORMATTED UPSTREAM: `OverlayView.fields[].value` crosses the wire as a display
// string (src/lab-overlays.ts's `r4View` does the `.toFixed(2)` / `String(rung)` / "—" work). This module
// therefore NEVER parses or reformats a value — it escapes and prints it. The one thing it DOES
// judge is emptiness: a field whose value is nullish, blank, or the upstream "—" placeholder is
// DROPPED, not painted (see `isEmptyValue`).
import { esc } from "./chart-primitives.js";

const SEP = ' <span class="sep">·</span> ';

/** The wire's `OverlayView.tone` enum (openapi.yaml `OverlayView.tone`). An unknown value
 *  degrades to "neutral" — a newer server tone must never paint an unstyled class. */
const TONES = new Set(["neutral", "caution", "alert", "reentry"]);

/** The ◆ climb marker — rides the head of a `reentry`-tone row. Static markup, never user
 *  data ⇒ no escaping needed. */
const MARKER = '<span class="overlay-climb">◆</span> ';

/** A field with nothing to say. `"—"` is src/lab-overlays.ts's own null placeholder (r4View emits it for
 *  every null: phase, reentryRung, hyOas, vt) — printing "re-entry rung —" is noise, not data. */
function isEmptyValue(value) {
  if (value == null) return true;
  const s = String(value).trim();
  return s === "" || s === "-";
}

/** Read one field's value off an OverlayView by its label. Exported because `lab.js` needs R4's
 *  `phase` back out of the generic shape to feed the cash-claim precedence seam.
 *  @returns {string|null} the pre-formatted value, or null when the field is absent. */
export function overlayFieldValue(view, label) {
  const f = view && view.fields ? view.fields.find((x) => x.label === label) : null;
  return f ? f.value : null;
}

/** Nothing suppressed — the default second argument of `overlayRowHtml`, hoisted so the
 *  common call allocates no Set. */
const NO_SUPPRESS = new Set();

/** One `OverlayView` → one footer row. Returns "" for an absent view (a stale pre-overlays
 *  cached payload degrades to "no strip", never a crash — the edge caches at s-maxage=60).
 *
 *  `suppress` is a set of field LABELS this row must not paint, because some other line in
 *  the same strip already carries them (today: the dd-gate line, see `overlayStripHtml`).
 *  Without it the gate double-renders whenever its host row expands — `ddGateLineHtml` is
 *  unconditional, while `fallShape` still ships the field and `ALWAYS_RENDER_RULES` exempts
 *  that row from the idle collapse on every non-`equity` phase, so the same label+value
 *  painted twice, two rows apart. Suppressing here rather than
 *  dropping the field server-side keeps the wire generic: a pre-§3 cached payload, or any
 *  future consumer reading the row directly, still gets the field. */
export function overlayRowHtml(view, suppress = NO_SUPPRESS) {
  if (!view) return "";
  const tone = TONES.has(view.tone) ? view.tone : "neutral";
  const parts = [];
  const head = [view.label, view.headline].filter(Boolean).map((s) => esc(s)).join(" - ");
  // The ◆ climb marker rides the head of a `reentry` row — the one tone-specific mark
  // in this module, and generic in the sense that ANY overlay emitting `reentry` gets it.
  if (head) parts.push(`<span class="overlay-head">${tone === "reentry" ? MARKER : ""}${head}</span>`);
  for (const f of view.fields || []) {
    if (!f || isEmptyValue(f.value) || suppress.has(f.label)) continue;
    parts.push(`<span class="overlay-field">${esc(f.label)} <b>${esc(f.value)}</b></span>`);
  }
  if (view.note) parts.push(`<span class="overlay-note">${esc(view.note)}</span>`);
  if (!parts.length) return "";
  return `<span class="overlay-row overlay-${tone}">${parts.join(SEP)}</span>`;
}

/** The wire label under which `fallShapeView` (src/lab-overlays.ts) ships the W5-e drawdown-gate probe's
 *  verdict. HAND-TYPED here only because a browser ESM module cannot import from `src/`; the
 *  producer's `DD_GATE_FIELD_LABEL` (src/v-bear.ts) is the single source, and
 *  overlay-strip.test.js pins this literal against it — a rename there reds the FE rather than
 *  silently dropping the row. */
export const DD_GATE_LABEL = "dd gate (probe)";

/** r4's phase field label — hand-typed for the same reason; `R4_PHASE_FIELD_LABEL`
 *  (src/lab-overlays.ts) is the single source, pinned against this in overlay-strip.test.js. */
export const R4_PHASE_LABEL = "phase";

/** Static hover copy for the dd-gate line. FE-owned prose about WHY the line is where it is; the
 *  gate's own disclaimer ("measurement only, steers nothing") already rides the fall-shape row's
 *  server `note`, so this must not restate the measurement — only the placement rule. */
const DD_GATE_TITLE =
  "drawdown-gate probe (W5-e) - measurement only, steers nothing. Pinned outside the fold on purpose: a benign v-shaped fall collapses the fall-shape row into the idle line, and the gate can read 'would fire' on exactly that fall.";

/**
 * The dd-gate probe's state as ONE line, ALWAYS visible.
 *
 * WHY it is not simply a field on the fall-shape row: `fallShape` is a `decision-now` member with
 * tone `neutral` on every non-`bear` shape, and it is exempt from the idle collapse only while the
 * breaker is off the ladder (`ALWAYS_RENDER_RULES`). So on the common case — breaker in equity, a
 * benign `v-shaped` fall — the whole row folds into the idle line, which prints the HEADLINE only.
 * `drawdownGateWouldFire` returns TRUE for `v-shaped`, so precisely the reassuring case is the one
 * that hid a would-fire gate. This line is emitted BEFORE the first section head, so no group and
 * no collapse branch can reach it.
 *
 * Generic in the same sense as the rest of this module: it searches every view for the field and
 * knows nothing about fall shapes. The VALUE crosses the wire pre-formatted ("would fire" / "off")
 * and is printed verbatim — this module never compares it against a string, so there is no FE
 * spelling of the gate's semantics to drift from `drawdownGateWouldFire`.
 *
 * Absent field (scenario/replay carry no `fallShape`, and a pre-W5-e cached payload carries no such
 * row) ⇒ "" ⇒ nothing renders, matching the module's standing "silence is the empty render" rule.
 *
 * @param {Array<object>} views every overlay in the payload.
 */
export function ddGateLineHtml(views) {
  for (const v of views) {
    const value = overlayFieldValue(v, DD_GATE_LABEL);
    if (isEmptyValue(value)) continue;
    return (
      `<span class="overlay-row overlay-neutral overlay-ddgate" title="${esc(DD_GATE_TITLE)}">` +
      `<span class="overlay-field">${esc(DD_GATE_LABEL)} <b>${esc(value)}</b></span>` +
      `</span>`
    );
  }
  return "";
}

/** The three danger-ledger groups, rendered in this order. `decision-now` and `decision-pending`
 *  share the DECISION-LOGIC section header; `not-wired` opens the NOT-WIRED section. The server
 *  (api/lab.ts) stamps each `OverlayView.group` at its assembly point; the FE only reads it. */
const GROUP_ORDER = ["decision-now", "decision-pending", "not-wired"];

/** group → section id: decision-now and decision-pending are one section (DECISION LOGIC). */
const SECTION_OF = {
  "decision-now": "decision",
  "decision-pending": "decision",
  "not-wired": "not-wired",
};

/** section id → the header printed once when the section first has content. */
const SECTION_HEAD = {
  decision: "DECISION LOGIC · drives the held rung",
  "not-wired": "NOT WIRED · candidates - feed nothing today",
};

/** A decision-now overlay is FIRING when its tone is not the off/neutral state — R4 arming/in-cash
 *  (caution/alert/reentry) or a `bear` fall shape (caution). All-neutral ⇒ idle ⇒ collapse. */
function isFiring(view) {
  return !!view && !!view.tone && view.tone !== "neutral";
}

/** Overlay ids EXEMPT from the idle collapse — they paint their full row even when quiet.
 *  The collapse is otherwise correct: one line for "all quiet" is the whole
 *  point of the danger-ledger footer. But R4 carries the ONLY per-row detail that is worth reading
 *  on a calm day — E5's proximity-toned floor bars and the phase chip on the floor head — and a
 *  calm day is most days, so collapsing it hid the instrument almost always.
 *
 *  ⚠ This is a DATA table on purpose. The exemption must never be re-expressed as an inline
 *  `view.id === "r4"` test inside the render loop: two rules already coexist in the collapse branch
 *  (exempt rows expand, the rest fold into the idle line), and a second, scattered spelling of the
 *  same rule is how they drift apart. Add an id here; change nothing else.
 *
 *  Ids are the wire's `OverlayView.id` (src/lab-overlays.ts stamps them: `r4`, `fallShape`, …).
 *
 *  The table is id + PREDICATE: the fall-shape exemption is CONDITIONAL (worth a row only while
 *  the breaker is OFF the ladder). `when` is evaluated ONCE per render (see `alwaysRenderIds`),
 *  never inside the row loop.
 *
 *  `when(views)` receives every overlay in the payload; `() => true` is an unconditional exemption. */
const ALWAYS_RENDER_RULES = [
  { id: "r4", when: () => true },
  // ⚠ `!== "equity"` — population {cash, reentry}, NEVER `=== "cash"`. A cash-only test would go
  // dark for the whole re-entry walk, which is precisely the stretch where "was this fall a bear or
  // a V?" decides whether re-risking into it is sane.
  { id: "fallShape", when: (views) => r4Phase(views) !== "equity" },
];

/** The breaker's phase as the SERVER stated it, off the r4 overlay's own `phase` field — never
 *  re-derived and never string-parsed out of a headline. Absent r4, absent field or the "—" null
 *  placeholder all read `equity`, i.e. today's fold behaviour, so a stale/partial cached payload
 *  degrades to the pre-Stage-6 strip rather than to a wrong claim. */
function r4Phase(views) {
  const v = views.find((x) => x.id === "r4");
  const phase = overlayFieldValue(v, R4_PHASE_LABEL);
  return isEmptyValue(phase) ? "equity" : String(phase).trim();
}

/** The exemption set for THIS payload — built once at the top of `overlayStripHtml`. */
function alwaysRenderIds(views) {
  return new Set(ALWAYS_RENDER_RULES.filter((r) => r.when(views)).map((r) => r.id));
}

function isAlwaysRendered(view, exempt) {
  return !!view && exempt.has(view.id);
}

/** The QUIET decision-now group's parts, in paint order: the ALWAYS_RENDER_RULES members expand as
 *  usual; only the REST fold into the idle line, which names what it folded whenever those views
 *  carry a `headline`. `rerisk` = a decision-pending group is in the payload. */
function quietDecisionNowHtml(groupViews, exempt, suppress, rerisk) {
  const parts = [];
  const expanded = groupViews.filter((v) => isAlwaysRendered(v, exempt));
  const folded = groupViews.filter((v) => !isAlwaysRendered(v, exempt));
  // Count rows that ACTUALLY painted, not views that were selected: `overlayRowHtml` returns ""
  // for a view with no head, no note and only empty/"—" fields, so an exempt-but-silent overlay
  // would otherwise let the idle line claim a companion row that is not on screen.
  let expandedRows = 0;
  for (const v of expanded) {
    const row = overlayRowHtml(v, suppress);
    if (row) {
      parts.push(row);
      expandedRows++;
    }
  }
  // What the idle line ABSORBED, in the folded rows' own words — WHEN they have words: a folded
  // view's `OverlayView.headline` is usually its one-phrase summary ("shape: indeterminate"),
  // but it is optional on the wire, and a folded view without one contributes nothing here (all
  // headline-less ⇒ no summary segment at all, just the lead + suffix). Stays generic — nothing
  // here knows what a fall shape is. Server data ⇒ escaped, unlike the static text around it.
  const foldedSummary = folded
    .map((v) => v.headline)
    .filter(Boolean)
    .map((s) => esc(s))
    .join(" · ");
  // "held at dial target" only holds when nothing is queued: a decision-pending r1 re-risk means
  // the held leg lags the target by construction, so claiming it here would repeat the very
  // held-vs-target mislead this strip was rebuilt to kill. The r1 row renders just below.
  const suffix = rerisk ? "re-risk pending below" : "held at dial target";
  // "nothing ELSE firing" only when something DID render above it — otherwise the line would
  // claim a companion row that is not on screen.
  const lead = expandedRows ? "nothing else firing" : "nothing firing";
  const idleText = foldedSummary
    ? `${lead} - ${foldedSummary} · ${suffix}`
    : `${lead} - ${suffix}`;
  parts.push(`<span class="overlay-row overlay-neutral overlay-idle">${idleText}</span>`);
  return parts;
}

/** The whole strip, grouped into the danger-ledger's three sections. An absent or empty `overlays`
 *  renders exactly "" — silence is the empty render, never a placeholder. Overlays lacking a `group`
 *  (a pre-grouping cached payload) still render, ungrouped and headerless, at the end — a dropped
 *  overlay would be worse than a missing header. */
export function overlayStripHtml(overlays) {
  if (!overlays) return "";
  const views = Object.values(overlays).filter(Boolean);
  if (!views.length) return "";
  // ONE evaluation of the exemption rules per render, over the whole payload —
  // the collapse branch below only ever asks the resulting SET.
  const exempt = alwaysRenderIds(views);

  const byGroup = new Map();
  const ungrouped = [];
  for (const v of views) {
    if (GROUP_ORDER.includes(v.group)) {
      if (!byGroup.has(v.group)) byGroup.set(v.group, []);
      byGroup.get(v.group).push(v);
    } else {
      ungrouped.push(v);
    }
  }

  const parts = [];
  // FIRST, ahead of every section head: the dd-gate line belongs to no group, so no group's
  // collapse branch can swallow it. Pushed before the loop rather than inside it
  // precisely so nothing in the grouping machinery below has to be told about it.
  const ddGate = ddGateLineHtml(views);
  if (ddGate) parts.push(ddGate);
  // …and once it is on screen, the row that OWNS the field must not paint it a second time.
  // The double-render is invisible on the common `equity` phase (the fall-shape row folds
  // into the idle line), and shows up exactly on the phases where the row is exempt from the
  // collapse — cash and the whole re-entry walk.
  const suppress = ddGate ? new Set([DD_GATE_LABEL]) : NO_SUPPRESS;
  let openSection = null;
  for (const group of GROUP_ORDER) {
    const groupViews = byGroup.get(group);
    if (!groupViews || !groupViews.length) continue;

    const section = SECTION_OF[group];
    if (section !== openSection) {
      parts.push(`<span class="overlay-group-head">${esc(SECTION_HEAD[section])}</span>`);
      openSection = section;
    }

    // decision-now PARTIALLY collapses while every member is idle (no R4/fall-shape firing); it
    // expands to full rows the moment either fires. Per-line status tokens are gone — the grouping
    // IS the marker.
    if (group === "decision-now" && !groupViews.some(isFiring)) {
      parts.push(...quietDecisionNowHtml(groupViews, exempt, suppress, byGroup.has("decision-pending")));
      continue;
    }
    for (const v of groupViews) {
      const row = overlayRowHtml(v, suppress);
      if (row) parts.push(row);
    }
  }

  for (const v of ungrouped) {
    const row = overlayRowHtml(v, suppress);
    if (row) parts.push(row);
  }

  return parts.join("");
}
