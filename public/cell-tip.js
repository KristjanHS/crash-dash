/**
 * The danger-ledger signal-cell DRILL-DOWN PANEL.
 *
 * THE SHAPE: a terse head (`rt · 2/8 firing`), then one row per FIRING member sorted by the
 * contribution that decides the cell (`weight × severity`, descending), then the members that are NOT
 * firing folded behind a `+N calm · M absent ▸` affordance — WITH THEIR WEIGHTS, because /lab shows a
 * member's per-leg weight nowhere else — then the census + hold provenance as a footer.
 *
 * ⚠ IT ASSERTS NOTHING THE SERVER DID NOT MEASURE. Same copy discipline as `observedNote`/`heldOf`:
 * every number here is served (`M`, `N`, the census counters, `held.member`/`held.closes`/`held.ageCloses`,
 * the weight table), the ordering is derived from served values, and no row explains WHY a member is
 * absent or held.
 *
 * ⚠ NO `title=` AND NO ⓘ ANYWHERE IN THIS MARKUP. The panel IS the tooltip; a `title=` inside it would
 * make `decorateHelp` inject a glyph into a hover surface, and a nested native tooltip would race the
 * panel it sits in. The one host is the existing `<td class="sig">` cell.
 *
 * A pure seam (`.claude/rules/frontend.md`): DOM-free, no module-level side effects, unit-tested in
 * `cell-tip.test.js`. It returns a markup STRING; `lab.js` owns the element and writes it via `setHTML`.
 */

import { esc } from "./chart-primitives.js";
import { idIfDistinct } from "./leading-name.js";
import { ABSENT_SEV, censusOf, foldOf, heldAgeNote, heldOf } from "./cell-observed.js";

/** Glyph + tone class per member severity. Deliberately the SAME four-state vocabulary the grid
 *  cells paint (`SIG_GLYPH`, lab.js) — a member row and the cell it explains must not speak two
 *  languages — with `absent` kept distinct from `calm`. */
const MEMBER_GLYPH = {
  absent: { g: "∅", cls: "ct-absent" },
  calm: { g: "○", cls: "ct-calm" },
  elev: { g: "◐", cls: "ct-elev" },
  lit: { g: "●", cls: "ct-lit" },
};

/** Severity → the number the family share (`familyShare`, src/danger-share.ts) multiplies the weight by: the
 *  FE mirror of `SEV_NUM`. Orders the rows ONLY; an absent member leaves the share, so it sorts as 0. */
const SEV_RANK = { lit: 1, elev: 0.5, calm: 0, [ABSENT_SEV]: 0 };

/** A member is a DRIVER — shown unfolded — when it is elev or lit: the same `elev || lit` predicate
 *  the server counts into `SignalCell.M`, so the head's `M` and the number of unfolded rows can only
 *  disagree when the wire disagrees with itself.
 *  ⚠ ABSENT IS NOT A DRIVER AND NOT CALM: it folds, because it entered no max, but it keeps its own
 *  `∅` glyph inside the fold rather than borrowing calm's `○`. */
function isDriver(m) {
  return m.sev === "elev" || m.sev === "lit";
}

/** One member's display name: the id beside its label only where the id ADDS information (`OVX OVX`
 *  collapses, `R4 10y RY Δ` does not). */
function memberName(m) {
  return [idIfDistinct(m.label, m.id), m.label].filter(Boolean).join(" ");
}

/** The weight cell: `×0.8`, or an EMPTY string when the served danger-model carried no weight for
 *  this (member, leg).
 *  ⚠ Empty, never `×—` and never `×0`: a missing weight means the model predates the field or failed
 *  to load, and printing a zero would assert the member cannot reach this leg — a claim the absence of
 *  the weight table cannot support. */
function weightCell(w) {
  return typeof w === "number" ? `×${w}` : "";
}

/** One member row — glyph, name, weight, state word. Ordered so the eye reads STATE first (the
 *  glyph column aligns), then who, then how hard it hits this leg.
 *  `m.held` (per-member, from the served `field.memberState`) marks THIS row's state as the hold
 *  window's, not today's close — independent of the footer's argmax-only `ct-held` line, so a held
 *  member out-weighed by a live one still reads held. Same facts-only copy: age via `heldAgeNote`. */
function memberRow(m) {
  const gl = MEMBER_GLYPH[m.sev] || MEMBER_GLYPH.absent;
  const held = m.held ? " ct-row-held" : "";
  const state = m.held ? `${m.sev} · held, ${heldAgeNote({ ageCloses: m.held.ageCloses ?? null })}` : m.sev;
  return (
    `<div class="ct-row ${gl.cls}${held}">` +
    `<span class="ct-glyph">${gl.g}</span>` +
    `<span class="ct-name">${esc(memberName(m))}</span>` +
    `<span class="ct-weight">${esc(weightCell(m.w))}</span>` +
    `<span class="ct-state">${esc(state)}</span>` +
    `</div>`
  );
}

/** Sort key, descending: the member's `weight × severity` term in the family share's numerator. No served
 *  weight ⇒ weight 1. Ties keep the server's `FAMILY_MEMBERS` order (`Array.prototype.sort` is stable). */
function contribution(m) {
  const w = typeof m.w === "number" ? m.w : 1;
  return w * (SEV_RANK[m.sev] ?? 0);
}

/** The census + hold footer, as its own labelled line. Reuses `censusOf`/`heldOf` — the same
 *  normalisers, so the numbers and their defensive degrades are unchanged. Empty when the cell
 *  quantifies over no members (an all-zero census is not a measurement and must not print as one). */
function footer(cell, unstamped, labels, members) {
  const c = censusOf(cell);
  const total = c.fresh + c.lag + c.absent;
  if (total === 0) return "";
  // The census's `absent` counts the ENGINE roster (FAMILY_MEMBERS × leg-relevance), which is
  // NARROWER than the panel roster the rows above join against (the display family carries the
  // SLOW ids; the engine's does not) — so N absent rows above can stand beside a smaller count
  // here. Naming the served `absentIds` is what makes the count investigable.
  const absentNames = (c.absentIds || [])
    .map((id) => (labels && labels[id] ? memberName({ id, label: labels[id] }) : id))
    .join(", ");
  const absentClause = c.absent > 0 && absentNames ? `${c.absent} absent (${esc(absentNames)})` : `${c.absent} absent`;
  const h = heldOf(cell);
  // B2 — named on its OWN line: it is provenance for the cell's severity, not another observation
  // counter. The hold ENDS AS SOON AS THE MEMBER PRINTS GREEN, so the window is an upper bound and the
  // AGE is the fact worth showing. THIS is the row the live `/lab` hover renders (`lab.js`), so the copy
  // and the age formatter (`heldAgeNote`) are shared with `observedNote` rather than re-typed — one
  // phrasing, one degrade. An age the server did not send prints `age unknown`, never a fabricated number.
  // The hold window and the directional fold are INDEPENDENT (addendum §2): when the argmax member is
  // ALSO mid-stand-down (`foldOf`), APPEND a fold clause — never replace the hold-window sentence.
  const argmaxFold = h ? foldOf((members || []).find((mm) => mm && mm.id === h.member)) : null;
  const foldClause = argmaxFold ? ` - and <b>${esc(h.member)}</b> is itself held by the fold (raw ${esc(argmaxFold.raw)})` : "";
  const held = h
    ? `<div class="ct-held">severity from <b>${esc(h.member)}</b>, carried by the hold window - ` +
      `${esc(heldAgeNote(h))}, window ≤${esc(String(h.closes))} closes (an upper bound); ` +
      `the hold ends when ${esc(h.member)} prints green${foldClause}</div>`
    : "";
  // A4 — with NO freshness stamp behind the payload, `c.lag` is `obsOf`'s unmeasured default for every
  // member, not an observation. The fresh/lag SPLIT is the part that was never measured, so it collapses
  // to `—`; the roster size is still a fact and stays. Printing `0 lag` here would be the mirrored defect
  // — absence reading as "every feed current".
  const census = unstamped
    ? `observed ${c.fresh + c.lag} reporting · fresh/lag - (freshness not measured) · ${absentClause}`
    : `observed ${c.fresh} fresh · ${c.lag} lag · ${absentClause}`;
  return `<div class="ct-census">${census}</div>` + held;
}

/** The fold's label, counting CALM and ABSENT separately.
 *
 *  ⚠ NEVER ONE COMBINED COUNT. `+6 not firing` over 3 calm + 3 absent members asserts six members
 *  were observed idle when three never reported — the substitution this panel exists to avoid. A count
 *  that is zero is omitted rather than printed, so an all-calm fold reads `+6 calm`. */
function foldLabel(folded) {
  const calm = folded.filter((m) => m.sev === "calm").length;
  const absent = folded.length - calm;
  return [calm ? `${calm} calm` : "", absent ? `${absent} absent` : ""].filter(Boolean).join(" · ");
}

/**
 * The panel markup for one signal cell.
 *
 * @param {object} cell the SERVED cell (`{family, cellState, M, N, observed, held}`)
 * @param {ReadonlyArray<{id: string, label: string, sev: string, held: {ageCloses: number|null}|null|undefined, w: number|undefined}>} members
 *        the cell's RELEVANT members, already joined against the served `field.memberState` — i.e.
 *        the HELD/GATED vintage the cell was built from, never the family panel's per-close fold.
 *        `sev` is `ABSENT_SEV` for a member with no entry in that map.
 * @param {Record<string, string>} [labels] served `memberLabel` map (id → short name) — names the
 *        census footer's `absentIds`; omitted/missing ids degrade to the raw id, never to silence.
 * @returns {string} markup, or "" when there is nothing to drill into.
 */
export function cellTipHtml(cell, members, unstamped, labels) {
  if (!cell) return "";
  const fam = cell.family || "";
  // `N === 0` is the structural "this family does not apply to this leg" cell. It has no roster and
  // no census, so the panel is one line.
  if (!cell.N) return `<div class="ct-head">${esc(fam)} · n/a to this sleeve</div>`;
  const rows = [...(members || [])].sort((a, b) => contribution(b) - contribution(a));
  const drivers = rows.filter(isDriver);
  const folded = rows.filter((m) => !isDriver(m));
  // The fold shows the calm AND absent members with their weights: /lab prints a member's per-leg
  // weight on no other surface, so folding them away without it would remove the only place the
  // weight table is legible.
  const fold = folded.length
    ? `<button type="button" class="ct-fold" aria-expanded="false">+${foldLabel(folded)} ▸</button>` +
      `<div class="ct-folded" hidden>${folded.map(memberRow).join("")}</div>`
    : "";
  return (
    `<div class="ct-head">${esc(fam)} · ${esc(String(cell.M))}/${esc(String(cell.N))} firing</div>` +
    `<div class="ct-rows">${drivers.map(memberRow).join("")}</div>` +
    fold +
    footer(cell, unstamped, labels, members)
  );
}
