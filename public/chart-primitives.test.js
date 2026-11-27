// Characterization tests for scrubIndex, the client-x → reading-index inverse of xAt
// that moved here from app.js. Plain `.js` so vitest's default glob collects it while
// `tsc` ignores it — no jsdom needed (pure geometry over a plain rect object). Pins the
// clamping, letterbox correction, and the xAt round-trip so the extraction is provably
// behavior-preserving. (chart-primitives had no test file before this stage.)
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scrubIndex, userXAt, xAt, yAt, hoverLayer, chartOpen, CH, COMPACT_CH, STACK_CH, STACK_NAME_X, STACK_AXIS_X, axisNameY, stackNameRightX, NAME_BAND_L, NAME_BAND_R, LANE_GAP, TICK_LABEL_W, STACK_PLOT_H, PLOT_W, PLOT_H, plotH, plotW, parkY, ribbonTop, RIBBON_H, CHIP_LIFT } from "./chart-primitives.js";
import { DETAIL_LIMIT, LEG_PHRASE as FE_PHRASE } from "./chart-primitives.js";
import { stepPathD, pathD } from "./sparkline.js";
import { DETAIL_WINDOW } from "../src/family-descriptor-rows";
import { LEG_PHRASE as BACKEND_PHRASE, LEG_ORDER } from "../src/domain-legs.ts";

// A rect whose aspect exactly matches the chart (w/h = 680/200 = 3.4) so drawnW === CH.w,
// xPad === 0, left === 0. In this frame client x maps 1:1 to SVG user x, isolating the
// index math from the letterbox correction.
const oneToOne = { left: 0, width: CH.w, height: CH.h };

describe("scrubIndex - clamping", () => {
  const n = 10;

  it("clamps to 0 at/past the left edge", () => {
    // ml (=50) is user-x 0 of the plot → index 0; anything further left stays clamped.
    expect(scrubIndex(CH.ml, oneToOne, n)).toBe(0);
    expect(scrubIndex(0, oneToOne, n)).toBe(0);
    expect(scrubIndex(-5000, oneToOne, n)).toBe(0);
  });

  it("clamps to n-1 at/past the right edge", () => {
    // ml + PLOT_W is the last sample's user-x → index n-1; further right stays clamped.
    expect(scrubIndex(CH.ml + PLOT_W, oneToOne, n)).toBe(n - 1);
    expect(scrubIndex(CH.w, oneToOne, n)).toBe(n - 1);
    expect(scrubIndex(5000, oneToOne, n)).toBe(n - 1);
  });
});

describe("scrubIndex - letterbox correction", () => {
  const n = 100;

  it("a wide rect letterboxes horizontally (centered draw), a tall rect does not", () => {
    // Wide: width 2× the aspect-correct width → drawnW = CH.w, xPad = (1360-680)/2 = 340.
    // The chart is centered, so the rect's midpoint (clientX 680) maps to the chart's
    // horizontal centre (user-x 340), NOT its right edge.
    const wide = { left: 0, width: CH.w * 2, height: CH.h };
    const wideMid = scrubIndex(CH.w, wide, n);
    // Tall: height doubled → drawnW = min(680, 1360) = rect.width = 680, xPad = 0. The same
    // clientX 680 now sits at the drawing's right edge → clamps to n-1.
    const tall = { left: 0, width: CH.w, height: CH.h * 2 };
    expect(scrubIndex(CH.w, tall, n)).toBe(n - 1);
    // The wide-rect midpoint lands mid-series, well short of the clamp — proving xPad shifted it.
    expect(wideMid).toBeLessThan(n - 1);
    expect(wideMid).toBeGreaterThan(0);
    // Exact value: round(((340-50)/614)*99) = 47.
    expect(wideMid).toBe(47);
  });

  it("honours rect.left offset (chart not at viewport origin)", () => {
    const offset = { left: 200, width: CH.w, height: CH.h };
    // clientX = left + ml maps to plot user-x 0 → index 0.
    expect(scrubIndex(200 + CH.ml, offset, n)).toBe(0);
    // clientX = left + ml + PLOT_W maps to the last sample → n-1.
    expect(scrubIndex(200 + CH.ml + PLOT_W, offset, n)).toBe(n - 1);
  });
});

describe("hoverLayer - parameterized frame (E3 Stage 1.1)", () => {
  it("default call keeps the pre-parameterization CH markup", () => {
    const html = hoverLayer();
    expect(html).toContain(`y1="${CH.mt}"`);
    expect(html).toContain(`y2="${CH.mt + PLOT_H}"`);
  });

  it("a custom frame moves the crosshair extent and readout with it", () => {
    const html = hoverLayer({ top: 20, height: 100 });
    expect(html).toContain('y1="20"');
    expect(html).toContain('y2="120"');
    // read-bg / read text track the custom top (top+1 / top+11)
    expect(html).toContain('y="21"');
    expect(html).toContain('y="31"');
  });
});

describe("scrubIndex - round-trips xAt for every sample index", () => {
  it("scrubIndex(xAt(i)) === i in the 1:1 frame", () => {
    for (const n of [2, 5, 10, 37]) {
      for (let i = 0; i < n; i++) {
        // xAt returns the SVG user-x for sample i; in the 1:1 frame that equals clientX.
        expect(scrubIndex(xAt(i, n), oneToOne, n)).toBe(i);
      }
    }
  });
});

describe("optional geometry arg (compact compare stack)", () => {
  it("COMPACT_CH keeps the frame except the squat height, so x math is unchanged", () => {
    expect({ ...COMPACT_CH, h: CH.h }).toEqual(CH);
    expect(COMPACT_CH.h).toBeLessThan(CH.h);
    expect(xAt(3, 10, COMPACT_CH)).toBe(xAt(3, 10));
    // y math compresses with the shorter plot.
    expect(plotH(COMPACT_CH)).toBe(COMPACT_CH.h - CH.mt - CH.mb);
    expect(yAt(0, 0, 1, COMPACT_CH)).toBe(COMPACT_CH.mt + plotH(COMPACT_CH));
  });

  it("scrubIndex round-trips xAt in the compact 1:1 frame", () => {
    const rect = { left: 0, width: COMPACT_CH.w, height: COMPACT_CH.h };
    for (const n of [2, 5, 37]) {
      for (let i = 0; i < n; i++) {
        expect(scrubIndex(xAt(i, n, COMPACT_CH), rect, n, COMPACT_CH)).toBe(i);
      }
    }
  });

  it("the geometry arg is load-bearing: default-aspect letterbox math misreads a compact rect", () => {
    // A wide rect around a COMPACT chart: drawnW = min(1360, 170·4) = 680, xPad = 340.
    // The default CH aspect (680/300) instead computes drawnW ≈ 385, xPad ≈ 487 — so an
    // OFF-CENTRE client x (the rect midpoint is aspect-invariant) lands on a different index.
    const wideCompact = { left: 0, width: COMPACT_CH.w * 2, height: COMPACT_CH.h };
    const n = 100;
    const x = 800; // compact: userX 460 → index 66; CH aspect: userX ≈ 552 → index 81
    const compactIdx = scrubIndex(x, wideCompact, n, COMPACT_CH);
    expect(compactIdx).toBe(66);
    expect(scrubIndex(x, wideCompact, n)).not.toBe(compactIdx);
  });
});

describe("chartOpen opening bytes", () => {
  it("start with `<svg class=\"chart\"` in every geometry - app.js's data-chart-slot injection string-replaces on them", () => {
    expect(chartOpen("t")).toMatch(/^<svg class="chart" /);
    expect(chartOpen("t", COMPACT_CH)).toMatch(/^<svg class="chart" /);
    // The stack head `<text>`s come AFTER the open tag, so the pin holds there too.
    expect(chartOpen("t", STACK_CH, { name: "n" })).toMatch(/^<svg class="chart" /);
  });
});

describe("chartOpen stack name (STACK_CH `showHead`)", () => {
  const head = { name: "HY OAS (F1)" };

  it("writes the name ROTATED in the left margin, centred on the primary axis - never a head band", () => {
    const html = chartOpen("t", STACK_CH, head);
    const cy = (STACK_CH.mt + plotH(STACK_CH) / 2).toFixed(1);
    expect(html).toContain(`<text class="chart-name" x="${STACK_NAME_X}" y="${cy}" text-anchor="middle"`);
    expect(html).toContain(`transform="rotate(-90 ${STACK_NAME_X} ${cy})">${head.name}</text>`);
    // The whole point: the name sits in margin the frame already spends, so `mt` is bare padding
    // and a 3- or 5-chart stack pays no per-chart height for its name.
    expect(STACK_CH.mt).toBeLessThan(14);
    // ...and it stays clear of the right-anchored y-tick labels, which end at ml - 8.
    expect(STACK_NAME_X).toBeLessThan(STACK_CH.ml - 8);
  });

  it("mirrors the SAME name in the right margin, at the same centre - a phone zoomed into the right half still sees it", () => {
    const html = chartOpen("t", STACK_CH, head);
    const cy = (STACK_CH.mt + plotH(STACK_CH) / 2).toFixed(1);
    const rx = stackNameRightX(STACK_CH);
    expect(html).toContain(`<text class="chart-name" x="${rx}" y="${cy}" text-anchor="middle"`);
    expect(html).toContain(`transform="rotate(-90 ${rx} ${cy})">${head.name}</text>`);
    // Both copies, same string, no third.
    expect(html.match(/class="chart-name"/g)).toHaveLength(2);
    // The LANE rule, not a restatement of the literal: the mirror's glyph band must clear BOTH the
    // plot edge (w - mr) on one side and the secondary-axis name at `w - 3` on the other — the
    // overlap-with-the-last-samples bug this inset fixes.
    expect(rx - NAME_BAND_L).toBeGreaterThanOrEqual(STACK_CH.w - STACK_CH.mr + LANE_GAP);
    expect(rx + NAME_BAND_R).toBeLessThanOrEqual(STACK_CH.w - 3 - NAME_BAND_L - LANE_GAP);
  });

  it("the LEFT margin's three lanes are disjoint - chart name, axis name, then the y-tick labels", () => {
    // Every lane relation reads off the shared band model, so widening a name or a tick label
    // moves the assertion with it. Red demo: STACK_CH.ml = 50 (its value before the axis name
    // landed) fails the tick clause - which is exactly what printed a tick over both names.
    const nameBand = [STACK_NAME_X - NAME_BAND_L, STACK_NAME_X + NAME_BAND_R];
    const axisBand = [STACK_AXIS_X - NAME_BAND_L, STACK_AXIS_X + NAME_BAND_R];
    expect(nameBand[0]).toBeGreaterThanOrEqual(0); // inside the viewBox
    expect(axisBand[0] - nameBand[1]).toBeGreaterThanOrEqual(LANE_GAP);
    // The y-tick labels are right-anchored at `ml - 8` and run LEFT; a modelled worst-case tick
    // must stop clear of the axis-name lane. This is the whole reason STACK_CH widens `ml`.
    const tickLeftEdge = STACK_CH.ml - 8 - TICK_LABEL_W;
    expect(tickLeftEdge - axisBand[1]).toBeGreaterThanOrEqual(LANE_GAP);
    // ...and the rule CAN fail: CH's own `ml` (50) violates it, which is why the stack needs its own.
    expect(CH.ml - 8 - TICK_LABEL_W - axisBand[1]).toBeLessThan(LANE_GAP);
  });

  it("an axis NAME sits on the plot floor while the chart name stays vertically centred", () => {
    const floor = STACK_CH.mt + plotH(STACK_CH);
    expect(axisNameY(STACK_CH)).toBeLessThan(floor); // inside the plot, never over the ribbon
    expect(axisNameY(STACK_CH)).toBeGreaterThan(floor - 6); // and flush with it, not floating
    // The two alignments are DIFFERENT by construction: bottom for the axis names, centre for the name.
    expect(axisNameY(STACK_CH)).toBeGreaterThan(STACK_CH.mt + plotH(STACK_CH) / 2);
  });

  it("a non-showHead geometry ignores a passed head - the default open stays byte-identical", () => {
    expect(chartOpen("t", COMPACT_CH, head)).toBe(chartOpen("t", COMPACT_CH));
    expect(chartOpen("t", CH, head)).toBe(chartOpen("t"));
  });

  it("STACK_CH derives h from its own mt/mb + STACK_PLOT_H (one touch point)", () => {
    expect(plotH(STACK_CH)).toBe(STACK_PLOT_H);
  });
});

describe("the viewport-pinned readout bar (S1)", () => {
  const read = (f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");

  // BOTH pages that render an Indicator-detail stack: index.html (app.js) and overview.html
  // (overview.js). /overview shipped without the bar and without the scrub wiring, so its
  // charts painted a `.hover-layer` nothing ever unhid — no crosshair on the public page.
  it.each(["./index.html", "./overview.html"])(
    "%s carries the bar as STATIC markup outside #dashboard, so Zone D's innerHTML re-render cannot destroy it",
    (page) => {
      const html = read(page);
      const bar = html.match(/<p id="hover-bar"[^>]*>/);
      expect(bar, `#hover-bar is not in ${page}`).not.toBeNull();
      expect(bar[0]).toContain('class="hover-bar"');
      expect(bar[0]).toContain("hidden"); // starts hidden; hover-readout.js unhides it mid-scrub
      // After </main>: inside the dashboard it would sit in a zone that gets re-rendered.
      expect(html.indexOf('<p id="hover-bar"')).toBeGreaterThan(html.indexOf("</main>"));
    },
  );

  it("costs the chart stack ZERO layout height - the point of replacing the per-chart strips", () => {
    const css = read("./styles.css");
    const block = css.match(/^\.hover-bar \{[^}]*\}/m);
    expect(block, ".hover-bar has no rule in styles.css").not.toBeNull();
    expect(block[0]).toMatch(/^\s+position: fixed;/m);
  });
});

describe("hoverLayer chip mode (S2)", () => {
  it("default emission is UNCHANGED - the four other hoverLayer consumers still get hover-read", () => {
    // replay-chart.js, exposure-replay-chart.js and lab.js's two painters querySelector
    // (".hover-read") and would null-throw on a chip-only layer. They opt in at S5.
    expect(hoverLayer()).toContain('class="hover-read"');
    expect(hoverLayer()).toContain('class="hover-read-bg"');
    expect(hoverLayer()).not.toContain("hover-chip");
    expect(hoverLayer({ chip: false })).toBe(hoverLayer());
  });

  it("chip mode swaps the corner-pinned pair for a group paintChip positions", () => {
    const html = hoverLayer({ chip: true });
    expect(html).toContain('class="hover-chip"');
    expect(html).not.toContain("hover-read");
    // rect + text start collapsed at the origin; every coordinate is written at paint time.
    expect(html).toMatch(/<rect x="0" y="0" width="0" height="0" rx="2" \/>/);
    expect(html).toMatch(/<text x="0" y="0" text-anchor="start"><\/text>/);
  });

  it("chip mode keeps the crosshair and dot the non-chip layer has", () => {
    const html = hoverLayer({ geo: STACK_CH, chip: true });
    expect(html).toContain(`y1="${STACK_CH.mt}"`);
    expect(html).toContain(`y2="${STACK_CH.mt + plotH(STACK_CH)}"`);
    expect(html).toContain('class="hover-dot"');
  });

  it("both chip font sizes resolve in styles.css - the 560px rule is what makes it legible", () => {
    const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
    const rules = [...css.matchAll(/\.hover-layer \.hover-chip text \{([^}]*)\}/g)].map((m) => m[1]);
    expect(rules.length, "chip text needs a base rule AND a 560px override").toBe(2);
    expect(rules[0]).toMatch(/font-size: 11px;/);
    expect(rules[1]).toMatch(/font-size: 20px;/);
    // Source order alone is not enough: a 20px rule moved to TOP LEVEL after the base would keep
    // the two assertions above green while growing the chip on DESKTOP too. Pin the context —
    // the override must sit inside the 560px block, and that block must follow the base rule.
    const media = css.indexOf("@media (max-width: 560px)", css.lastIndexOf(".hover-layer .hover-chip text {"));
    expect(media, "the 20px override is not inside any @media block below the base rule").toBe(-1);
    const lastMedia = css.lastIndexOf("@media (max-width: 560px)", css.lastIndexOf(".hover-layer .hover-chip text {"));
    expect(lastMedia).toBeGreaterThan(css.indexOf(".hover-layer .hover-chip text {"));
  });
});

// --- parkY: S4 occlusion-aware vertical park for the travelling readout chip ---
// Every fixture y is DERIVED from the exported frame geometry (ribbonTop / CHIP_LIFT / RIBBON_H /
// CH.mt), never a restated literal, so a geometry change moves the test with the code it guards.
describe("parkY - occlusion-aware chip park", () => {
  const top = CH.mt; // plot frame top — the upper walk sentinel
  const floor = ribbonTop(CH) - CHIP_LIFT; // chip bottom can descend no further
  const chipH = 20;
  const floorTop = floor - chipH; // the pinned chip's TOP y
  // A divider line well up the plot, clear of the floor band; the two gaps it creates are unequal.
  const mid = top + (floor - top) * 0.7;

  it("floor band CLEAR -> pins the chip at the floor (stable default)", () => {
    // `mid` sits above the floor band [floorTop, floor], so that band is clear -> floor pin.
    expect(parkY({ ys: [mid], geo: CH, chipH })).toBe(floorTop);
  });

  it("floor band OCCUPIED -> centres the chip in the widest fitting gap", () => {
    const floorOcc = floor - 1; // inside the floor band -> forces the gap walk
    // Gaps: [top..mid] (widest), [mid..floorOcc], [floorOcc..floor] (too small). Widest is the first.
    const expected = (top + mid) / 2 - chipH / 2;
    expect(parkY({ ys: [mid, floorOcc], geo: CH, chipH })).toBeCloseTo(expected, 6);
  });

  it("excludes the ribbon band - a y at/below the floor never occupies the floor band", () => {
    const ribbonY = ribbonTop(CH) + RIBBON_H / 2; // squarely inside the drawn ribbon strip
    // The ribbon y is below the floor sentinel, so it is dropped: floor band stays clear -> pin.
    expect(parkY({ ys: [ribbonY, mid], geo: CH, chipH })).toBe(floorTop);
  });

  it("no gap fits (dense lines, floor band occupied) -> falls back to the floor pin", () => {
    const dense = [];
    for (let y = top + 10; y < floor; y += 10) dense.push(y); // every gap = 10 < chipH + 4
    expect(parkY({ ys: dense, geo: CH, chipH })).toBe(floorTop);
  });

  it("ignores null / NaN y's in the occupied set", () => {
    // A null-primary sample must not poison the walk: [null, NaN] leaves the floor band clear.
    expect(parkY({ ys: [null, NaN], geo: CH, chipH })).toBe(floorTop);
  });
});

// ── DETAIL_LIMIT pin (ex-detail-limit.test.js) ─────────────────────────────────────────────────
// DETAIL_LIMIT cannot import the TS source at browser runtime (public/ is unbundled ESM outside
// tsc), so the literal is pinned here against the server's single source instead.
describe("detail window - FE literal pinned to the server's single source", () => {
  it("chart-primitives DETAIL_LIMIT === family-descriptor DETAIL_WINDOW", () => {
    expect(DETAIL_LIMIT).toBe(DETAIL_WINDOW);
  });
});

// ── LEG_PHRASE parity (ex-leg-phrase-parity.test.js) ───────────────────────────────────────────
// CROSS-IMPLEMENTATION parity for the leg WORDING.
//
// Why this file exists, and why it is `.js` in `public/`:
// `LEG_PHRASE` (src/domain-legs.ts) is the source of truth for how a winning OR-leg is NAMED to a
// user. Two paths reach one:
//   1. the backend push text  — src/domain-legs.ts `LEG_PHRASE` (the truth)
//   2. the detail-ribbon tooltip — public/chart-primitives.js `LEG_PHRASE`, a hand-kept MIRROR:
//      a browser module cannot import from `src/`, so it must restate the table.
// Only (2) can desynchronise silently — this file is what stops it. A plain `.js` test because
// only `public/*.test.js` may import both a `public/*.js` seam module and a `../src/*.ts`
// (tsc skips `.js`; vitest collects it).
//
// The FE side really is its own literal (not a re-export of the backend one), which is exactly
// what makes this assertion non-vacuous — mutate either value and this goes red.
// ⚠ Import ONLY `../src/domain-legs.ts` for this pin: it imports only pure domain leaves. Pulling any module
// that transitively reaches confirmers/fred/prices/config would drag network+env into a FE test.
describe("LEG_PHRASE parity (src/domain-legs.ts ↔ public/chart-primitives.js)", () => {
  it("is key-for-key and value-for-value identical", () => {
    expect(FE_PHRASE).toEqual(BACKEND_PHRASE);
  });

  // The table must cover the whole leg vocabulary — a newly-added LEG_ORDER member with no
  // phrase would degrade both surfaces to the bare leg id without either table disagreeing.
  //
  // The second half is the KEY-GRAMMAR check, deliberately GENERIC: a key is legal iff it is a
  // LEG_ORDER member, or a composite of ≥2 LEG_ORDER members joined by `+`. No composite is
  // hand-listed, so adding one never re-opens this file — while a typo'd or junk key (an unknown
  // part, or a bare non-member) still reds.
  it("covers every LEG_ORDER member, and every other key is a well-formed composite", () => {
    for (const leg of LEG_ORDER) expect(typeof BACKEND_PHRASE[leg]).toBe("string");
    const members = new Set(LEG_ORDER);
    for (const key of Object.keys(BACKEND_PHRASE)) {
      if (members.has(key)) continue;
      const parts = key.split("+");
      expect(parts.length, `composite key ${key} needs ≥2 parts`).toBeGreaterThanOrEqual(2);
      for (const part of parts) expect(members.has(part), `${key}: unknown part ${part}`).toBe(true);
    }
  });
});

// ── sparkline path primitives (ex-sparkline.test.js) ───────────────────────────────────────────
// Pure-seam tests for the sparkline.js path primitives. Plain `.js` so vitest collects it and tsc
// skips it (frontend.md).
describe("stepPathD (the `style: \"step\"` staircase)", () => {
  it("holds the prior y to each new x before rising - one extra L per hop vs pathD", () => {
    const pts = [[0, 10], [5, 2], [9, 6]];
    expect(stepPathD(pts)).toBe("M0.0 10.0 L5.0 10.0 L5.0 2.0 L9.0 2.0 L9.0 6.0");
    expect(pathD(pts)).toBe("M0.0 10.0 L5.0 2.0 L9.0 6.0");
  });
});
