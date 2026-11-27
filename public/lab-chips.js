/**
 * /lab picker chip strip — one chip per method, grouped Active then Shelf.
 * Imported by lab.js; never imports lab.js (selection state stays there and
 * arrives as arguments).
 */
import { esc } from "./chart-primitives.js";
import { setHTML } from "./help-bar.js";
import { METHOD_CARDS } from "./method-cards.js";
import { shortTitle } from "./lab-reader.js";

/** Picker — a sticky chip strip atop the reader, one chip per method, grouped Active
    then Concept shelf. Built once; a chip click drives the board + opens the reader. */
export function buildPicker(selectedMethodId, onSelect) {
  const el = document.querySelector("#picker");
  const groups = [
    ["active", "Active"],
    ["shelf", "Shelf"],
  ];
  el.innerHTML = ""; // ALLOWLISTED raw write: a clear, not a markup write — nothing to decorate.
  for (const [g, label] of groups) {
    const sec = document.createElement("div");
    sec.className = "grp " + g;
    setHTML(sec, `<span class="grp-lbl">${esc(label)}</span>`);
    for (const m of METHOD_CARDS.filter((x) => x.group === g)) {
      const b = document.createElement("button");
      b.className = "chip-m";
      b.type = "button";
      b.dataset.id = m.id;
      b.setAttribute("aria-current", String(m.id === selectedMethodId));
      setHTML(b, `<span class="cm-t">${esc(shortTitle(m.title))}</span>`);
      b.addEventListener("click", () => onSelect(m.id));
      sec.appendChild(b);
    }
    el.appendChild(sec);
  }
}
