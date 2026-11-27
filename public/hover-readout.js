/*
 * hover-readout.js — the pointer-driven detail-chart readout (crosshair + travelling chip +
 * the one viewport-pinned `#hover-bar`), extracted MOVE-ONLY from app.js so /overview can
 * wire the SAME implementation it renders charts with.
 *
 * WHY it is a module: `detail-tab.js` (P11.d) moved the chart STACK out of app.js but left
 * this seam behind, bound to app.js's `els.zoneD`/`els.hoverBar` module scope. /overview
 * therefore rendered every `.hover-layer` group (chart-primitives.js `hoverLayer`) and had
 * nothing to unhide it: charts painted, the crosshair never appeared. Any page that renders
 * `svg.chart[data-chart-slot]` into a stable host must call `wireHoverReadout` once at boot.
 *
 * `wireHoverReadout({ host, bar, getDetails })`:
 *   host        the STABLE parent the charts are re-rendered inside (#zone-d). Listeners are
 *               delegated on it so they survive the innerHTML re-render every poll.
 *   bar         the viewport-pinned `#hover-bar` <p> (static markup, outside the re-rendered
 *               zone). May be null — `paintBar` no-ops and only the in-SVG chip paints.
 *   getDetails  () => the live `zoneD.details` array (slot-indexed chart details), read at
 *               scrub time, never captured: the array is replaced on every render.
 *   timers      optional `{ setTimeout, clearTimeout }` for the long-press hold — defaults to the
 *               real globals; a test passes a hand-driven clock instead of faking the global ones.
 */
import { CH, STACK_CH, scrubIndex, plotW, parkY } from "./chart-primitives.js";
import { sampleForDate } from "./detail-chart.js";
import { SHOW_FIT_CLASS } from "./fit-toggle.js";

export function wireHoverReadout({ host, bar: barEl, getDetails, timers = globalThis }) {
  // Destructured, so each is called with no receiver — exactly how the bare globals are called.
  const { setTimeout: setTimer, clearTimeout: clearTimer } = timers;
  // Pointer-driven detail-chart readout (desktop hover + phone long-press-then-drag, see the
  // touch block below). Delegated
  // on the stable host parent so it survives the innerHTML re-render every poll.
  function hideHover() {
    for (const l of host.querySelectorAll(".hover-layer")) l.setAttribute("visibility", "hidden");
    // The bar IS hidden (not just emptied) once the pointer leaves: it is position:fixed, so
    // hiding it reflows nothing — the reason the old per-chart strips could only be emptied.
    paintBar(null);
  }
  function paintHover(svg, s, geo = CH, staticYs = []) {
    const layer = svg.querySelector(".hover-layer");
    if (!layer) return;
    layer.querySelector(".xhair").setAttribute("x1", s.x);
    layer.querySelector(".xhair").setAttribute("x2", s.x);
    const dot = layer.querySelector(".hover-dot");
    // A null-primary sample carries `dotY: null` (detail-chart.js): paint no crosshair dot — a dot
    // pinned to the plot floor over a data gap is a phantom point. `removeAttribute` (not
    // visibility:"visible") when finite, so the dot inherits the layer's visibility and re-hides with
    // it on pointerleave; an explicit "visible" would survive hideHover's layer-level hide.
    if (Number.isFinite(s.dotY)) {
      dot.setAttribute("cx", s.x);
      dot.setAttribute("cy", s.dotY);
      dot.removeAttribute("visibility");
    } else {
      dot.setAttribute("visibility", "hidden");
    }
    paintChip(layer.querySelector(".hover-chip"), s, geo, staticYs);
    layer.setAttribute("visibility", "visible");
  }
  /** Position the chip beside the crosshair. Horizontally it sits at `s.x + CHIP_GAP`, flipped to the
   *  left of the line when it would cross the plot's right edge. Vertically the floor is the DEFAULT,
   *  not an unconditional pin: `parkY` returns the floor position (bottom edge `CHIP_LIFT` above
   *  `ribbonTop(geo)`) whenever that floor band is CLEAR at the hovered column, and only lifts the chip
   *  into the widest fitting gap when the floor band is occupied by a drawn line — so the readout
   *  stays put under a scrubbing finger (the floor pin's whole point) yet steps out of the way of a
   *  line it would otherwise sit on top of. The occupied set is `s.ys` (every per-index series + moving
   *  cut) ∪ the chart's STATIC band y's (`staticYs`) — the ribbon band is excluded inside `parkY`.
   *  `CHIP_LIFT`/`ribbonTop` live in chart-primitives.js, the shared definitions detail-chart.js draws
   *  the ribbon from, so pin and ribbon cannot drift. The backdrop rect is sized from `getBBox()` after
   *  the text is written, so it tracks the CSS font-size — including the 560px media query that grows
   *  the chip in viewBox user units — which is why `h` (the parking height) is measured, not assumed. */
  const CHIP_GAP = 8;
  const CHIP_PAD_X = 4;
  const CHIP_PAD_Y = 2;
  const fitLinesShown = () => typeof document !== "undefined" && document.documentElement.classList.contains(SHOW_FIT_CLASS);
  function paintChip(chip, s, geo, staticYs = []) {
    if (!chip) return;
    const text = chip.querySelector("text");
    const bg = chip.querySelector("rect");
    text.textContent = s.chip ?? s.readout;
    // Measure at the origin: `box.y` is then the (negative) ascent, which converts a wanted box
    // TOP back into the baseline the text must sit on.
    text.setAttribute("x", 0);
    text.setAttribute("y", 0);
    const box = text.getBBox();
    const w = box.width + CHIP_PAD_X * 2;
    const h = box.height + CHIP_PAD_Y * 2;
    const right = geo.ml + plotW(geo);
    // Flipped left but still too wide (phone font, long chip) ⇒ clamp at the SVG's left edge rather than clip the date.
    const x = s.x + CHIP_GAP + w > right ? Math.max(0, s.x - CHIP_GAP - w) : s.x + CHIP_GAP;
    const fitYs = fitLinesShown() ? (s.fitYs ?? []) : [];
    const top = parkY({ ys: [...(s.ys ?? []), ...fitYs, ...staticYs], geo, chipH: h });
    bg.setAttribute("x", x);
    bg.setAttribute("y", top);
    bg.setAttribute("width", w);
    bg.setAttribute("height", h);
    text.setAttribute("x", x + CHIP_PAD_X - box.x);
    text.setAttribute("y", top + CHIP_PAD_Y - box.y);
  }
  /** Fill the ONE viewport-pinned bar with the full readout of the chart under the pointer, or hide
   *  it (`null`). Real CSS type, so it stays legible where the viewBox-scaled SVG chip does not
   *  (≈0.57× on a 390px phone); pinned to the viewport, so it costs the stack no height and can
   *  never occlude a drawn line. `textContent`, never markup.
   *
   *  Phone dismiss (`[USER]` 2026-09-13, replacing the earlier compact-head fold): the bar shows
   *  the FULL readout by default, wrapped; a tap on it hides the bar to free the screen for the
   *  chart. The dismissal is keyed to the painted content — a same-content repaint (the pinned
   *  sample re-scrubbed) keeps it hidden, a NEW pin shows the bar again. */
  let lastPainted = null;
  let dismissed = false;
  function paintBar(readout) {
    const bar = barEl;
    if (!bar) return;
    if (readout !== lastPainted) dismissed = false;
    lastPainted = readout;
    bar.textContent = readout ?? "";
    bar.hidden = !readout || dismissed;
  }
  // --- Touch (`[USER]`, 2026-09-13): a TAP pins, a LONG-PRESS-then-drag scrubs. The SVG is
  // `touch-action: manipulation` (styles.css), so every pan and pinch stays the browser's —
  // including panning a pinch-zoomed chart, which `pan-y`/`none` both blocked. A lift within
  // the slop before HOLD_MS is a tap: it PINS the crosshair + bar at that sample, staying after
  // lift until the next tap (which moves the pin, any chart) or a tap outside every chart
  // (which clears it). A finger held still for HOLD_MS arms the scrub; the drag that follows scrubs,
  // with the non-passive touchmove handler below vetoing the browser's pan while armed, and the
  // LAST scrub position stays pinned on lift. A finger that moves past the slop unarmed is a
  // scroll/pan: it never pins, never scrubs, and leaves an existing pin alone. Mouse hover is
  // untouched: it scrubs on the first move, no hold, hides on leave.
  const HOLD_MS = 350;
  const SLOP_PX = 8; // a move past this before the timer fires is a pan, not a hold/tap
  const isTouch = (e) => e.pointerType === "touch" || e.pointerType === "pen";
  let hold = null; // { id, x, y, timer, dead } — the pending press; dead = slop-cancelled (a pan)
  let armed = null; // pointerId of the scrubbing touch, or null
  function clearHold() {
    if (hold) clearTimer(hold.timer);
    hold = null;
  }
  function disarm() {
    clearHold();
    armed = null;
  }
  function onDown(e) {
    if (!isTouch(e) || !e.target.closest("svg.chart")) return;
    clearHold();
    hold = { id: e.pointerId, x: e.clientX, y: e.clientY, dead: false, timer: setTimer(arm, HOLD_MS, e) };
  }
  function arm(e) {
    hold = null;
    armed = e.pointerId;
    // Capture so the scrub keeps tracking once the finger crosses the chart's edge; a fake or
    // legacy target without the API just loses that nicety.
    try {
      e.target.setPointerCapture?.(e.pointerId);
    } catch {}
    scrub(e);
  }
  function onScrub(e) {
    if (!isTouch(e)) return scrub(e);
    if (armed === e.pointerId) return scrub(e);
    if (hold && hold.id === e.pointerId && !hold.dead && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > SLOP_PX) {
      // The finger is panning — never arm under it, and its lift is a swipe's, not a tap's.
      clearTimer(hold.timer);
      hold.dead = true;
    }
  }
  function onUp(e) {
    if (!isTouch(e)) return;
    if (armed === e.pointerId) return disarm(); // scrub lift: the LAST scrub position stays pinned
    const tap = hold !== null && hold.id === e.pointerId && !hold.dead;
    const swipe = hold !== null && hold.id === e.pointerId && hold.dead;
    disarm();
    // A tap pins via the same scrub — anywhere on the chart, margins clamping to the edge
    // samples — and nothing hides it after lift. A swipe leaves any pin alone; a lift whose
    // press never touched a chart clears the pin.
    if (tap) scrub(e);
    else if (!swipe && !e.target.closest("svg.chart")) hideHover();
  }
  function onCancel() {
    // The browser took the gesture mid-scrub → hide; a cancelled UNARMED press was a pan the
    // browser claimed before the hold fired — it leaves an existing pin alone, like a swipe.
    const wasArmed = armed !== null;
    disarm();
    if (wasArmed) hideHover();
  }
  // A scrub bail must also DISARM ([USER] 2026-09-13 F5): a poll repaint mid-hold can detach the
  // pressed target or swap `details` out, and a lift off the host then never reaches onUp's
  // disarm — a stuck `armed` leaves the non-passive touchmove veto trapping page scroll forever.
  function bailHover() {
    disarm();
    return hideHover();
  }
  function scrub(e) {
    const svg = e.target.closest("svg.chart");
    // Sibling children (legend, picker, gate note) don't fire pointerleave — hide here.
    const details = getDetails();
    if (!svg || !details) return bailHover();
    const own = details[Number(svg.dataset.chartSlot)];
    if (!own) return bailHover();
    // Every stack chart renders the flush STACK_CH frame iff more than one entry is in the
    // stack (msg slots included) — scrubIndex's letterbox correction reads g.w/g.h, so the
    // scrub geometry MUST match the render geometry or the sample index comes back wrong.
    const geo = details.length > 1 ? STACK_CH : CH;
    const rect = svg.getBoundingClientRect();
    // Margins clamp, not hide (`[USER]` 2026-09-13, hit area re-expanded): `scrubIndex` clamps
    // a pointer over the y-label margins to the first/last sample so the edge datapoints are
    // easy to read. The retired `inPlotX` gate guarded a phone scroll starting on the margin —
    // dead under tap-pin: a swipe never pins or scrubs, and tap/hold are deliberate gestures.
    const s = own.samples[scrubIndex(e.clientX, rect, own.n, geo)];
    if (!s) return bailHover();
    // Paint EVERY stack chart at its sample nearest the hovered date; a chart whose own
    // date range excludes it hides its layer (sampleForDate's range check).
    for (const el of host.querySelectorAll("svg.chart[data-chart-slot]")) {
      const d = details[Number(el.dataset.chartSlot)];
      const match = d ? sampleForDate(d.samples, s.date) : null;
      // A stack chart whose own range excludes the hovered date just hides its layer.
      if (match) paintHover(el, match, geo, d.staticYs ?? []);
      else el.querySelector(".hover-layer")?.setAttribute("visibility", "hidden");
    }
    // ONE bar for the whole stack, carrying the readout of the chart actually under the pointer.
    paintBar(s.readout);
  }
  host.addEventListener("pointerdown", onDown);
  host.addEventListener("pointermove", onScrub);
  host.addEventListener("pointerup", onUp);
  // Mouse leave hides (desktop hover semantics); a touch pointer's SYNTHETIC leave right after
  // lift must not clear the tap/scrub pin the lift just kept.
  host.addEventListener("pointerleave", (e) => !isTouch(e) && hideHover());
  host.addEventListener("pointercancel", onCancel); // the browser took the gesture (pan/zoom)
  // Non-passive on purpose: only a cancelable touchmove can veto the browser's pan, and only
  // while a press has armed the scrub — an unarmed finger scrolls/pans exactly as the page does.
  host.addEventListener("touchmove", (e) => armed !== null && e.preventDefault(), { passive: false });
  // Android raises a context menu on a long press; while a press is pending or armed it is ours.
  host.addEventListener("contextmenu", (e) => (hold || armed !== null) && e.preventDefault());
  // Phone dismiss: under hover-none the bar takes `pointer-events: auto` (styles.css) and a
  // tap on it hides the bar until the next new pin. stopPropagation so the tap can never reach
  // the chart host’s pin-clear path; on desktop the bar stays `pointer-events: none`, so this
  // listener never fires there.
  barEl?.addEventListener("click", (e) => {
    e.stopPropagation();
    dismissed = true;
    barEl.hidden = true;
  });
}
