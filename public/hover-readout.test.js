// Pins the extracted pointer-readout seam (public/hover-readout.js). The bug it closes:
// /overview rendered the detail stack through detail-tab.js but wired NO scrub handler and
// carried no `#hover-bar`, so every `.hover-layer` it painted stayed `visibility="hidden"` —
// charts on the public page, no crosshair. app.js is never imported here (module-level DOM
// side effects, frontend.md); the seam is exercised over a minimal fake DOM instead, whose
// class names are pinned against the real `hoverLayer` emitter below.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { CH, STACK_CH, hoverLayer, plotW } from "./chart-primitives.js";
import { wireHoverReadout } from "./hover-readout.js";

const read = (f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");

/* --------------------------------------------------------------- minimal fake DOM */
// Supports exactly the selector shapes the seam uses: `tag`, `.class`, `[attr]` and their
// combination (`svg.chart[data-chart-slot]`).
function matchSel(n, sel) {
  const tag = sel.match(/^[a-z]+/)?.[0];
  if (tag && n.tag !== tag) return false;
  for (const c of sel.match(/\.[\w-]+/g) ?? []) if (!n.cls.includes(c.slice(1))) return false;
  for (const a of sel.match(/\[([\w-]+)\]/g) ?? []) if (!(a.slice(1, -1) in n.attrs)) return false;
  return true;
}
function walk(n, fn) {
  for (const k of n.kids) {
    fn(k);
    walk(k, fn);
  }
}
function node(tag, cls = "", extra = {}) {
  const n = {
    tag,
    cls: cls.split(" ").filter(Boolean),
    attrs: {},
    kids: [],
    parent: null,
    listeners: {},
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    getAttribute(k) {
      return this.attrs[k] ?? null;
    },
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
    fire(type, e) {
      for (const fn of this.listeners[type] ?? []) fn(e);
    },
    append(...c) {
      for (const k of c) {
        k.parent = this;
        this.kids.push(k);
      }
      return this;
    },
    closest(sel) {
      for (let n = this; n; n = n.parent) if (matchSel(n, sel)) return n;
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      walk(this, (k) => matchSel(k, sel) && out.push(k));
      return out;
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] ?? null;
    },
    ...extra,
  };
  // Real-DOM classList, backed by `cls` so class selectors keep matching.
  n.classList = {
    contains: (c) => n.cls.includes(c),
    add: (c) => n.classList.contains(c) || n.cls.push(c),
    remove: (c) => (n.cls = n.cls.filter((x) => x !== c)),
    toggle: (c, force) => {
      const on = force ?? !n.classList.contains(c);
      if (on) n.classList.add(c);
      else n.classList.remove(c);
      return on;
    },
  };
  return n;
}

/** One `svg.chart[data-chart-slot=i]` carrying the same layer `hoverLayer({chip:true})` emits. */
function chartNode(slot) {
  const text = node("text", "", { getBBox: () => ({ x: 0, y: -8, width: 40, height: 10 }) });
  const chip = node("g", "hover-chip").append(node("rect"), text);
  const layer = node("g", "hover-layer").append(node("line", "xhair"), node("circle", "hover-dot"), chip);
  layer.setAttribute("visibility", "hidden");
  const svg = node("svg", "chart", {
    dataset: { chartSlot: String(slot) },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: CH.w, height: CH.h }),
  });
  svg.setAttribute("data-chart-slot", String(slot));
  return svg.append(layer);
}

/* --------------------------------------------------------------- hand-driven clock */
// Injected as `timers`, so no global timer is faked. `advance(ms)` fires every due timer in
// due-time order (args forwarded, like the real setTimeout), then parks the clock at the target.
function manualClock() {
  let now = 0;
  let seq = 0;
  const due = new Map();
  return {
    setTimeout(fn, ms, ...args) {
      due.set(++seq, { at: now + ms, fn, args });
      return seq;
    },
    clearTimeout(id) {
      due.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...due].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        due.delete(next[0]);
        now = next[1].at;
        next[1].fn(...next[1].args);
      }
      now = end;
    },
  };
}
let clock;
beforeEach(() => {
  clock = manualClock();
});

/** A host with `n` charts + the `#hover-bar` stand-in, already wired. `details` is live. */
function harness(details, { withBar = true } = {}) {
  const host = node("section", "zone zone-d");
  const charts = details.map((_, i) => chartNode(i));
  host.append(...charts);
  let bar = null;
  if (withBar) {
    // Mirrors the static #hover-bar markup (index.html/overview.html): a flat text bar.
    bar = node("p", "hover-bar", { hidden: true, textContent: "" });
  }
  wireHoverReadout({ host, bar, getDetails: () => details, timers: clock });
  return { host, charts, bar, layer: (i) => charts[i].querySelector(".hover-layer") };
}

/** clientX of the LAST sample under CH geometry (rect === the viewBox, so no letterboxing). */
const lastX = CH.ml + plotW(CH);
const sample = (over = {}) => ({ x: 120, dotY: 40, date: "2026-01-02", readout: "R", ys: [], ...over });

describe("the fake DOM mirrors the real hoverLayer emission", () => {
  it("every class the seam querySelectors is in hoverLayer({chip:true})", () => {
    const html = hoverLayer({ chip: true });
    for (const c of ["hover-layer", "xhair", "hover-dot", "hover-chip"]) expect(html).toContain(c);
  });
});

describe("wireHoverReadout (the seam /overview was missing)", () => {
  it("a pointermove over a chart unhides its layer and paints crosshair, dot and bar", () => {
    // Distinct dates: the second pass re-paints every chart at the hovered chart's DATE.
    const d = {
      n: 2,
      samples: [
        sample({ x: 10, date: "2026-01-02", readout: "first" }),
        sample({ x: 300, date: "2026-01-03", readout: "last" }),
      ],
    };
    const { host, charts, bar, layer } = harness([d]);
    host.fire("pointermove", { target: charts[0], clientX: lastX });
    expect(layer(0).getAttribute("visibility")).toBe("visible");
    expect(layer(0).querySelector(".xhair").getAttribute("x1")).toBe("300");
    expect(layer(0).querySelector(".hover-dot").getAttribute("cx")).toBe("300");
    expect(bar.textContent).toBe("last");
    expect(bar.hidden).toBe(false);
  });

  it("paints EVERY stacked chart at the hovered DATE, and hides a chart whose range excludes it", () => {
    const hovered = { n: 1, samples: [sample({ date: "2026-03-02", readout: "hovered" })] };
    const linked = { n: 1, samples: [sample({ x: 200, date: "2026-03-02" })] };
    const elsewhere = { n: 1, samples: [sample({ date: "2020-01-01" })] };
    const { host, charts, layer, bar } = harness([hovered, linked, elsewhere]);
    // A 3-chart stack scrubs under STACK_CH, whose plot band is narrower than CH's: `lastX`
    // (CH's last sample) lands on STACK_CH's right margin and the plot gate hides it.
    host.fire("pointermove", { target: charts[0], clientX: STACK_CH.ml + plotW(STACK_CH) });
    expect(layer(0).getAttribute("visibility")).toBe("visible");
    expect(layer(1).getAttribute("visibility")).toBe("visible");
    expect(layer(1).querySelector(".xhair").getAttribute("x1")).toBe("200");
    expect(layer(2).getAttribute("visibility")).toBe("hidden");
    expect(bar.textContent).toBe("hovered"); // ONE bar, the chart actually under the pointer
  });

  it("a null-primary sample paints NO dot - a floor-pinned dot over a gap is a phantom point", () => {
    const { host, charts, layer } = harness([{ n: 1, samples: [sample({ dotY: null })] }]);
    host.fire("pointermove", { target: charts[0], clientX: lastX });
    expect(layer(0).querySelector(".hover-dot").getAttribute("visibility")).toBe("hidden");
  });

  it("a pointer over the y-label MARGIN clamps to the edge sample - the hit area spans the chart", () => {
    // Re-expanded (`[USER]` 2026-09-13): scrubIndex clamps the margins to the first/last
    // sample so the edge datapoints are easy to read; the old inPlotX gate hid instead.
    const { host, charts, bar, layer } = harness([{ n: 2, samples: [sample({ x: 10, date: "2026-01-02", readout: "first" }), sample({ x: 300, date: "2026-01-03", readout: "last" })] }]);
    host.fire("pointermove", { target: charts[0], clientX: CH.ml - 1 });
    expect(layer(0).getAttribute("visibility")).toBe("visible");
    expect(layer(0).querySelector(".xhair").getAttribute("x1")).toBe("10");
    expect(bar.textContent).toBe("first");
    host.fire("pointermove", { target: charts[0], clientX: lastX + 1 });
    expect(layer(0).querySelector(".xhair").getAttribute("x1")).toBe("300");
    expect(bar.textContent).toBe("last");
  });

  it("the chart SVG is touch-action: manipulation - every pan and pinch stays the browser's", () => {
    const css = read("./styles.css");
    const rule = css.match(/\n\.chart \{[^}]*\}/)[0];
    expect(rule).toMatch(/touch-action:\s*manipulation/);
    expect(rule).toMatch(/-webkit-touch-callout:\s*none/); // iOS long-press callout
  });

  it("the chip-row touch hint is hover-none gated - hidden by default, shown only where hover is absent", () => {
    const css = read("./styles.css");
    expect(css).toMatch(/\n\.touch-hint \{[^}]*display:\s*none/); // desktop never sees it
    const media = css.match(/@media \(hover: none\) \{[\s\S]*?\n\}/g) ?? [];
    expect(media.some((m) => /\.touch-hint \{[^}]*display:\s*inline/.test(m))).toBe(true);
  });

  it("pointerleave hides every layer AND the bar", () => {
    const { host, charts, bar, layer } = harness([{ n: 1, samples: [sample()] }]);
    host.fire("pointermove", { target: charts[0], clientX: lastX });
    host.fire("pointerleave", {});
    expect(layer(0).getAttribute("visibility")).toBe("hidden");
    expect(bar.hidden).toBe(true);
  });

  it("no details yet (the boot 'Pick an indicator.' prompt) is a no-op, not a throw", () => {
    const host = node("section", "zone zone-d");
    wireHoverReadout({ host, bar: null, getDetails: () => null });
    expect(() => host.fire("pointermove", { target: host, clientX: lastX })).not.toThrow();
  });
});

describe("touch: a long-press arms the scrub, a pan never does", () => {
  const touch = (over) => ({ pointerType: "touch", pointerId: 7, clientX: lastX, clientY: 50, ...over });

  it("a touch move with no press arms nothing (the drag is the browser's pan)", () => {
    const { host, charts, layer, bar } = harness([{ n: 1, samples: [sample()] }]);
    host.fire("pointermove", touch({ target: charts[0] }));
    expect(layer(0).getAttribute("visibility")).toBe("hidden");
    expect(bar.hidden).toBe(true);
  });

  it("held still for 350ms → crosshair at the press; the drag then scrubs; lift keeps the last position pinned", () => {
    const d = { n: 2, samples: [sample({ x: 10, date: "2026-01-02", readout: "first" }), sample({ x: 300, date: "2026-01-03", readout: "last" })] };
    const { host, charts, layer, bar } = harness([d]);
    host.fire("pointerdown", touch({ target: charts[0], clientX: CH.ml }));
    clock.advance(349);
    expect(layer(0).getAttribute("visibility")).toBe("hidden");
    clock.advance(1);
    expect(layer(0).getAttribute("visibility")).toBe("visible");
    expect(bar.textContent).toBe("first");
    host.fire("pointermove", touch({ target: charts[0], clientX: lastX }));
    expect(bar.textContent).toBe("last");
    host.fire("pointerup", touch({ target: charts[0], clientX: lastX }));
    expect(layer(0).getAttribute("visibility")).toBe("visible"); // the drag's LAST position stays pinned
    expect(bar.textContent).toBe("last");
    expect(bar.hidden).toBe(false);
  });

  it("omitted `timers` defaults to the REAL timers (globalThis)", () => {
    // Every other hold test injects the hand clock, so this is the only pin on the default. A static
    // read of the signature: a runtime proof needs a real 350 ms wait (or a globalThis write, which
    // re-isolates the file) — same trade as audit 8 Q-H.
    const src = read("./hover-readout.js");
    expect(src).toMatch(/export function wireHoverReadout\(\{[^}]*\btimers = globalThis\b[^}]*\}\)/);
  });

  it("a finger that moves past the slop before the timer never arms", () => {
    const { host, charts, layer } = harness([{ n: 1, samples: [sample()] }]);
    host.fire("pointerdown", touch({ target: charts[0] }));
    host.fire("pointermove", touch({ target: charts[0], clientY: 50 + 20 })); // a vertical scroll
    clock.advance(400);
    expect(layer(0).getAttribute("visibility")).toBe("hidden");
  });

  it("pointercancel (the browser took the gesture) disarms and hides", () => {
    const { host, charts, layer } = harness([{ n: 1, samples: [sample()] }]);
    host.fire("pointerdown", touch({ target: charts[0] }));
    clock.advance(350);
    expect(layer(0).getAttribute("visibility")).toBe("visible");
    host.fire("pointercancel", touch({ target: charts[0] }));
    expect(layer(0).getAttribute("visibility")).toBe("hidden");
    host.fire("pointermove", touch({ target: charts[0] }));
    expect(layer(0).getAttribute("visibility")).toBe("hidden");
  });

  it("touchmove is vetoed only while armed - an unarmed finger scrolls the page", () => {
    const { host, charts } = harness([{ n: 1, samples: [sample()] }]);
    let prevented = 0;
    const ev = { preventDefault: () => prevented++ };
    host.fire("touchmove", ev);
    expect(prevented).toBe(0);
    host.fire("pointerdown", touch({ target: charts[0] }));
    clock.advance(350);
    host.fire("touchmove", ev);
    expect(prevented).toBe(1);
  });

  it("a scrub bail (details swapped out by a repaint mid-hold) DISARMS - scroll is not trapped", () => {
    // F5: arm() fires on a press whose state a poll repaint invalidated; the bail path used to
    // hideHover() without clearing `armed`, so the non-passive touchmove veto trapped page
    // scroll until the next clean lift on the host.
    const host = node("section", "zone zone-d");
    const chart = chartNode(0);
    host.append(chart);
    let details = [{ n: 1, samples: [sample()] }];
    wireHoverReadout({ host, bar: null, getDetails: () => details, timers: clock });
    host.fire("pointerdown", touch({ target: chart }));
    details = null; // the repaint swapped the state slice out from under the pending hold
    clock.advance(350); // arm fires -> scrub bails on no details
    let prevented = 0;
    host.fire("touchmove", { preventDefault: () => prevented++ });
    expect(prevented).toBe(0); // armed was reset on the bail - the finger scrolls the page
  });

  it("a scrub bail on a missing sample index DISARMS too", () => {
    const host = node("section", "zone zone-d");
    const chart = chartNode(0);
    host.append(chart);
    // A details entry whose samples array is empty: scrubIndex resolves, samples[i] is undefined.
    wireHoverReadout({ host, bar: null, getDetails: () => [{ n: 1, samples: [] }], timers: clock });
    host.fire("pointerdown", touch({ target: chart }));
    clock.advance(350);
    let prevented = 0;
    host.fire("touchmove", { preventDefault: () => prevented++ });
    expect(prevented).toBe(0);
  });

  it("mouse hover still scrubs on the first move, no hold", () => {
    const { host, charts, layer } = harness([{ n: 1, samples: [sample()] }]);
    host.fire("pointermove", { pointerType: "mouse", target: charts[0], clientX: lastX });
    expect(layer(0).getAttribute("visibility")).toBe("visible");
  });
});

describe("touch: a TAP pins the readout, a swipe never does", () => {
  const touch = (over) => ({ pointerType: "touch", pointerId: 7, clientX: lastX, clientY: 50, ...over });
  const two = () => ({
    n: 2,
    samples: [sample({ x: 10, date: "2026-01-02", readout: "first" }), sample({ x: 300, date: "2026-01-03", readout: "last" })],
  });

  it("down+up within the slop before the hold → pinned at the tap's sample, staying after lift", () => {
    const { host, charts, layer, bar } = harness([two()]);
    host.fire("pointerdown", touch({ target: charts[0], clientX: CH.ml }));
    clock.advance(100); // well under HOLD_MS
    expect(layer(0).getAttribute("visibility")).toBe("hidden"); // nothing paints before lift
    host.fire("pointerup", touch({ target: charts[0], clientX: CH.ml }));
    expect(layer(0).getAttribute("visibility")).toBe("visible");
    expect(layer(0).querySelector(".xhair").getAttribute("x1")).toBe("10");
    expect(bar.textContent).toBe("first");
    expect(bar.hidden).toBe(false);
    // The touch pointer's SYNTHETIC leave right after lift must not clear the pin …
    host.fire("pointerleave", touch({}));
    expect(layer(0).getAttribute("visibility")).toBe("visible");
    clock.advance(1000); // … and the press timer is dead: no late arm repaints
    expect(bar.textContent).toBe("first");
  });

  it("a second tap moves the pin", () => {
    const { host, charts, layer, bar } = harness([two()]);
    host.fire("pointerdown", touch({ target: charts[0], clientX: CH.ml }));
    host.fire("pointerup", touch({ target: charts[0], clientX: CH.ml }));
    expect(bar.textContent).toBe("first");
    host.fire("pointerdown", touch({ target: charts[0], clientX: lastX }));
    host.fire("pointerup", touch({ target: charts[0], clientX: lastX }));
    expect(layer(0).querySelector(".xhair").getAttribute("x1")).toBe("300");
    expect(bar.textContent).toBe("last");
  });

  it("a tap outside every chart clears the pin", () => {
    const { host, charts, layer, bar } = harness([two()]);
    host.fire("pointerdown", touch({ target: charts[0], clientX: CH.ml }));
    host.fire("pointerup", touch({ target: charts[0], clientX: CH.ml }));
    expect(layer(0).getAttribute("visibility")).toBe("visible");
    host.fire("pointerdown", touch({ target: host, clientX: 5 })); // off-chart: no press is taken
    host.fire("pointerup", touch({ target: host, clientX: 5 }));
    expect(layer(0).getAttribute("visibility")).toBe("hidden");
    expect(bar.hidden).toBe(true);
  });

  it("a tap on a chart's y-label margin pins the edge sample", () => {
    const { host, charts, layer, bar } = harness([two()]);
    host.fire("pointerdown", touch({ target: charts[0], clientX: CH.ml - 1 }));
    host.fire("pointerup", touch({ target: charts[0], clientX: CH.ml - 1 }));
    expect(layer(0).getAttribute("visibility")).toBe("visible");
    expect(layer(0).querySelector(".xhair").getAttribute("x1")).toBe("10");
    expect(bar.textContent).toBe("first");
    host.fire("pointerdown", touch({ target: charts[0], clientX: lastX + 1 }));
    host.fire("pointerup", touch({ target: charts[0], clientX: lastX + 1 }));
    expect(layer(0).querySelector(".xhair").getAttribute("x1")).toBe("300");
    expect(bar.textContent).toBe("last");
  });

  it("a finger that moves past the slop then lifts pins nothing - and leaves an existing pin alone", () => {
    const fresh = harness([two()]);
    fresh.host.fire("pointerdown", touch({ target: fresh.charts[0] }));
    fresh.host.fire("pointermove", touch({ target: fresh.charts[0], clientY: 50 + 20 })); // a scroll
    clock.advance(400);
    fresh.host.fire("pointerup", touch({ target: fresh.charts[0] }));
    expect(fresh.layer(0).getAttribute("visibility")).toBe("hidden");
    expect(fresh.bar.hidden).toBe(true);
    // With a pin standing, the same swipe leaves it in place.
    const pinned = harness([two()]);
    pinned.host.fire("pointerdown", touch({ target: pinned.charts[0], clientX: CH.ml }));
    pinned.host.fire("pointerup", touch({ target: pinned.charts[0], clientX: CH.ml }));
    pinned.host.fire("pointerdown", touch({ target: pinned.charts[0] }));
    pinned.host.fire("pointermove", touch({ target: pinned.charts[0], clientY: 50 + 20 }));
    clock.advance(400);
    pinned.host.fire("pointerup", touch({ target: pinned.charts[0] }));
    expect(pinned.bar.textContent).toBe("first");
    expect(pinned.layer(0).getAttribute("visibility")).toBe("visible");
  });
});

describe("phone readout bar: full by default, a tap dismisses until the next new pin", () => {
  const longReadout = "2026-01-02 · 1.42% · trend 0.30% · gate off · amber";
  const one = (readout) => [{ n: 1, samples: [sample({ readout })] }];

  it("a tap on the bar hides it and never reaches the host (stopPropagation)", () => {
    const { host, charts, bar } = harness(one(longReadout));
    host.fire("pointermove", { target: charts[0], clientX: lastX });
    let stopped = 0;
    bar.fire("click", { stopPropagation: () => stopped++ });
    expect(bar.hidden).toBe(true);
    expect(stopped).toBe(1);
  });

  it("a same-content repaint keeps the dismissal; a NEW pin shows the bar again", () => {
    const d = {
      n: 2,
      samples: [
        sample({ x: 10, date: "2026-01-02", readout: "2026-01-02 · 1 · a · b · amber" }),
        sample({ x: 300, date: "2026-01-03", readout: "2026-01-03 · 2 · c · d · red" }),
      ],
    };
    const { host, charts, bar } = harness([d]);
    host.fire("pointermove", { target: charts[0], clientX: CH.ml });
    bar.fire("click", { stopPropagation: () => {} });
    expect(bar.hidden).toBe(true);
    host.fire("pointermove", { target: charts[0], clientX: CH.ml }); // same sample, same content
    expect(bar.hidden).toBe(true);
    host.fire("pointermove", { target: charts[0], clientX: lastX }); // a new pin
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toBe("2026-01-03 · 2 · c · d · red");
  });

  it("styles: desktop keeps pointer-events none; hover-none makes the bar tappable and never clamps it", () => {
    const css = read("./styles.css");
    const base = css.match(/\n\.hover-bar \{[^}]*\}/)[0]; // first .hover-bar rule = the base
    expect(base).toMatch(/pointer-events:\s*none/);
    const media = css.match(/@media \(hover: none\) \{[\s\S]*?\n\}/g) ?? [];
    const block = media.find((m) => m.includes(".hover-bar"));
    expect(block).toBeTruthy();
    expect(block).toMatch(/\.hover-bar \{[^}]*pointer-events:\s*auto/);
    // Full at rest: no single-line clamp, no fold selectors survive.
    const rules = block.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/nowrap|text-overflow|hover-bar-head|expanded|foldable/);
  });

  it("both page shells carry a flat #hover-bar with no span pair", () => {
    for (const f of ["./index.html", "./overview.html"]) {
      expect(read(f)).toMatch(/<p id="hover-bar" class="hover-bar" aria-live="off" hidden><\/p>/);
    }
  });
});
