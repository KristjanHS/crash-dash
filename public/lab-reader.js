/**
 * /lab reader region — the selected method's full text + the "Firing now on the
 * board" callout. Imported by lab.js and lab-chips.js; never imports lab.js.
 */
import { esc } from "./chart-primitives.js";
import { sleeveLabel } from "./sleeve-label.js";
import { setHTML } from "./help-bar.js";

const $ = (sel) => document.querySelector(sel);

/** "T1 — Danger-regime dial" → "Danger-regime dial" (the id shows in its own chip). */
export function shortTitle(t) {
  return String(t).replace(/^[A-Za-z]+\d+\s*[—–-]\s*/, "");
}
// "Credit + Vol RED" when reds exist; on an amber-only firing board (reachable by
// tile-cycling a red family down while a method is selected) fall back rather than
// render a dangling " RED" with no family name.
const firingLabel = (b) => (b.redLabels.length ? `${b.redLabels.map(esc).join(" + ")} RED` : "elevated families");

/** The "Firing now on the board ↑" callout — ties the reader to what the board shows. */
function calloutFor(m, b) {
  if (m.group === "shelf") {
    // D1: a board calm ONLY because elevated members can't arm is not a genuinely calm board.
    const sig = b.firing ? firingLabel(b) : b.cannotArm ? "a board calm only because nothing can arm" : "a calm board";
    return {
      cls: "shf",
      ic: "○",
      html: `<div><b>Not wired into the ladder.</b> Shelf methods aren't simulated. The board above shows <b>${sig}</b> - the signal this method <em>would</em> react to - so you can see its world, but the held rung is not this method's doing. Read “where it breaks” for why it stays on the shelf.</div>`,
    };
  }
  let move;
  if (b.breaker) {
    const redt = `<span class="k">${firingLabel(b)}</span>`;
    move = `${redt} · danger <code>${b.danger.toFixed(2)}</code> (${b.regime}) - extreme &amp; broad. The dial points to rung <b>${b.target} (${esc(sleeveLabel(b.ladder[b.target - 1]))})</b>; the breaker overrides it and leaves equities entirely → <b>Cash</b> (off-ladder).`;
  } else if (b.firing === 0) {
    // D1: name the elevated-but-cannot-arm reds/ambers when they are the whole reason nothing fires,
    // so "calm" never silently hides the only red on the board (the D2 tile mark's reader twin).
    const hidden = b.cannotArm
      ? ` <b>${b.cannotArm}</b> elevated member${b.cannotArm > 1 ? "s" : ""} can't arm any family (see the ⌁ marks) - the board reads calm only for that reason;`
      : " the board stays calm -";
    move = `${hidden} nothing firing, danger <code>${b.danger.toFixed(2)}</code>, holding rung <b>${b.held} (${esc(sleeveLabel(b.ladder[b.held - 1]))})</b>. This method earns its keep precisely when the fast methods are quiet.`;
  } else {
    const redt = `<span class="k">${firingLabel(b)}</span>`;
    const mag = `magnitude points to rung <b>${b.target} (${esc(sleeveLabel(b.ladder[b.target - 1]))})</b>`;
    move =
      b.held !== b.target
        ? `${redt} · danger <code>${b.danger.toFixed(2)}</code> (${b.regime}) · ${mag}, then the veto walks it to <b>${b.held} (${esc(sleeveLabel(b.ladder[b.held - 1]))})</b>.`
        : `${redt} · danger <code>${b.danger.toFixed(2)}</code> (${b.regime}) · holds rung <b>${b.held} (${esc(sleeveLabel(b.ladder[b.held - 1]))})</b>.`;
  }
  return { cls: "act", ic: "▶", html: `<div><b>Firing now on the board ↑</b> - ${move}</div>` };
}

/** Full method text: What / Reads→indicators / The rule / where it breaks / Framing. */
export function renderReader(m, b) {
  if (!m) return;
  const co = calloutFor(m, b);
  const active = m.group === "active";
  const readerHtml = `
    <div class="r-head">
      <h2 class="r-title">${esc(shortTitle(m.title))}</h2>
      <span class="r-status ${active ? "act" : "shf"}">${active ? "active" : "concept shelf"}</span>
    </div>
    <div class="callout ${co.cls}"><span class="ic">${co.ic}</span>${co.html}</div>
    <div class="prose">
      <div class="sec what"><h3>What it is</h3><p>${esc(m.what)}</p></div>
      <div class="sec"><h3>Reads → indicators</h3>
        <div class="inputs">${m.inputs
          .map(
            (i) => `
          <div class="inp"><div class="sig">${esc(i.signal)}<span class="tag">${esc(i.tag)}</span></div>
          ${i.feed ? `<div class="feed">${esc(i.feed)}</div>` : ""}</div>`,
          )
          .join("")}</div></div>
      <div class="sec"><h3>The rule</h3><p>${esc(m.output)}</p></div>
      <div class="breaks"><span class="lbl">where it breaks</span><div class="body">${esc(m.failureMode)}</div></div>
      <p class="framing"><b>Framing.</b> ${esc(m.framing)}</p>
    </div>`;
  setHTML($("#reader-body"), readerHtml);
}
