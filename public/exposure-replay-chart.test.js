// Slice E2 seam: exposure-replay chart + episode picker are pure HTML-string builders
// (no jsdom) so vitest can pin markup with plain string assertions — same idiom as
// replay-chart.test.js. NO engine math lives here, so these tests pin projection only:
// lanes present, candidate-marking, degraded-gap, empty-payload placeholder.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  exposureReplayChartHtml,
  episodeChipsHtml,
  companionPickerHtml,
  companionSeriesUrl,
  eligibleStoredCompanions,
  EXTERNAL_COMPANIONS,
} from "./exposure-replay-chart.js";
import { EQUITY_PCT } from "../src/exposure.ts";
import { COMPANIONS } from "../api/replay.ts";

// data-hover is HTML-attribute-escaped JSON; unescape (&amp; LAST — esc escaped it first).
const unesc = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const hoverPayload = (html) => {
  const m = html.match(/data-hover="([^"]*)"/);
  return m ? JSON.parse(unesc(m[1])) : null;
};

/** A replay point with sane defaults; override per-day fields as needed. */
const pt = (date, over = {}) => ({
  date,
  price: 100,
  armed: false,
  fired: false,
  posture: "Core",
  degraded: false,
  ...over,
});

const episode = (over = {}) => ({
  id: "2008",
  label: "2008 GFC",
  start: "2006-10-31",
  end: "2008-11-20",
  candidate: false,
  rationale: "Lehman credit blowout",
  points: [pt("2008-01-02"), pt("2008-01-03"), pt("2008-01-04")],
  notes: [],
  ...over,
});

describe("exposureReplayChartHtml - episode projection", () => {
  it("renders the three state lanes (ARM · FIRE · Posture)", () => {
    const html = exposureReplayChartHtml(episode());
    expect(html).toContain(">ARM<");
    expect(html).toContain(">FIRE<");
    expect(html).toContain(">Posture<");
    expect(html).toContain("<svg");
  });

  // Drift tripwire over the POSTURE_SLUG mirror: the chart's `|| "core"` fallback paints an unmapped
  // posture as Core, so a posture ADDED upstream collapses two bands into one here.
  it("paints a distinct band class for every posture in EQUITY_PCT", () => {
    const postures = Object.keys(EQUITY_PCT);
    const html = exposureReplayChartHtml(
      episode({
        points: postures.map((posture, i) =>
          pt(`2008-01-${String(i + 2).padStart(2, "0")}`, { posture }),
        ),
      }),
    );
    const slugs = new Set((html.match(/erp-band erp-([a-z]+)/g) || []).map((s) => s.split(" ")[1]));
    expect(slugs.size, `postures ${postures.join("/")} collapsed to ${[...slugs].join("/")}`).toBe(
      postures.length,
    );
  });

  it("the legend carries a swatch for every posture in EQUITY_PCT", () => {
    const html = exposureReplayChartHtml(episode());
    for (const posture of Object.keys(EQUITY_PCT)) {
      expect(html, `no legend key for ${posture}`).toContain(`</span>${posture}</span>`);
    }
  });

  it("degraded days render as a GAP - never a fabricated Core band", () => {
    // Core, <degraded>, Core → the run is split, so exactly two erp-core rects and the
    // degraded middle day contributes no posture band at all.
    const html = exposureReplayChartHtml(
      episode({
        points: [
          pt("2008-01-02", { posture: "Core" }),
          pt("2008-01-03", { degraded: true, posture: null }),
          pt("2008-01-04", { posture: "Core" }),
        ],
      }),
    );
    // two separate <rect class="erp-band erp-core"> (run split by the gap), not one.
    expect((html.match(/erp-band erp-core/g) || []).length).toBe(2);
  });

  it("shades the ARM and FIRE lanes only where the key is set and not degraded", () => {
    const withKeys = exposureReplayChartHtml(
      episode({ points: [pt("2008-01-02", { armed: true, fired: true })] }),
    );
    expect(withKeys).toContain("erp-arm-on");
    expect(withKeys).toContain("erp-fire-on");

    const armedButDegraded = exposureReplayChartHtml(
      episode({ points: [pt("2008-01-02", { armed: true, fired: true, degraded: true, posture: null })] }),
    );
    expect(armedButDegraded).not.toContain("erp-arm-on");
    expect(armedButDegraded).not.toContain("erp-fire-on");
  });

  it("draws the faint IEF defensive line only when defensive points are present", () => {
    const bare = exposureReplayChartHtml(episode());
    expect(bare).not.toContain("erp-defensive-line");

    const withDef = exposureReplayChartHtml(
      episode({
        defensive: [
          { date: "2008-01-02", price: 88 },
          { date: "2008-01-03", price: 87 },
          { date: "2008-01-04", price: 86 },
        ],
      }),
    );
    expect(withDef).toContain("erp-defensive-line");
  });

  it("IEF line derives from its OWN right-hand scale - a small IEF range no longer renders flat (E3 Stage 1.2)", () => {
    const html = exposureReplayChartHtml(
      episode({
        points: [
          pt("2008-01-02", { price: 100 }),
          pt("2008-01-03", { price: 150 }),
          pt("2008-01-04", { price: 200 }),
        ],
        defensive: [
          { date: "2008-01-02", price: 86 },
          { date: "2008-01-03", price: 87 },
          { date: "2008-01-04", price: 88 },
        ],
      }),
    );
    const m = html.match(/erp-defensive-line" points="([^"]*)"/);
    const ys = m[1].split(" ").map((p) => Number(p.split(",")[1]));
    // own min/max scale spans the full price panel; the old shared scale drew ~3px of travel
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(100);
    // right-side y-ticks + axis label present, native IEF values
    expect(html).toContain("erp-ylabel-r");
    expect(html).toContain(">IEF<");
    expect(html).toContain(">86.0<");
    expect(html).toContain(">88.0<");
  });

  it("empty / absent episode → honest placeholder, no SVG (never throws)", () => {
    expect(exposureReplayChartHtml(episode({ points: [] }))).toContain("erp-empty");
    expect(exposureReplayChartHtml(episode({ points: [] }))).not.toContain("<svg");
    expect(exposureReplayChartHtml(null)).toContain("erp-empty");
    expect(exposureReplayChartHtml(undefined)).toContain("erp-empty");
  });
});

describe("exposureReplayChartHtml - crosshair hover layer (E3 Stage 1.1)", () => {
  it("data-hover carries one entry per trading day with a date · price · posture readout", () => {
    const html = exposureReplayChartHtml(episode());
    expect(html).toContain("hover-layer"); // the group itself embeds (xhair pinned by Rung B3 below)
    const hv = hoverPayload(html);
    expect(hv).not.toBeNull();
    expect(hv.days.length).toBe(3);
    expect(hv.days[0].d).toBe("2008-01-02");
    expect(hv.days[0].r).toBe("2008-01-02 · 100.00 · Core");
    expect(hv.days[0].y).not.toBeNull();
    // frame fields let lab.js letterbox-correct without importing the geometry
    expect(hv.w).toBe(720);
    expect(hv.ml).toBeGreaterThan(0);
  });

  it("readout carries the IEF native value where a defensive point exists, 'degraded' on gap days", () => {
    const hv = hoverPayload(
      exposureReplayChartHtml(
        episode({
          points: [pt("2008-01-02"), pt("2008-01-03", { degraded: true, posture: null })],
          defensive: [{ date: "2008-01-02", price: 88 }],
        }),
      ),
    );
    expect(hv.days[0].r).toBe("2008-01-02 · 100.00 · IEF 88.00 · Core");
    expect(hv.days[1].r).toBe("2008-01-03 · 100.00 · degraded");
  });
});

describe("companion overlay on the replay chart (Rung E1)", () => {
  const series = (over = {}) => ({
    indicatorId: "F1",
    label: "US High Yield OAS",
    unit: "%",
    points: [
      { date: "2008-01-02", value: 5.1 },
      { date: "2008-01-03", value: 5.4 },
      { date: "2008-01-04", value: 6.2 },
    ],
    ...over,
  });

  it("picker renders a none option + one option per indicator, selected marked", () => {
    const html = companionPickerHtml(
      [
        { id: "F1", label: "High-yield credit spread" },
        { id: "R5", label: "VIX" },
      ],
      "R5",
    );
    expect(html).toContain("erp-ind-picker");
    expect(html).toMatch(/<option value=""[^>]*>- none -</);
    // Step 3 (official short names): option text is the name alone — the id survives as `value`.
    expect(html).toContain('<option value="F1">High-yield credit spread</option>');
    expect(html).toContain('<option value="R5" selected>VIX</option>');
    expect(companionPickerHtml([], null)).toBe("");
  });

  it("companionPickerHtml renders <optgroup>s for the grouped shape (E6 item 4)", () => {
    const html = companionPickerHtml(
      [
        { key: "__ext", label: "Market series", items: [{ id: "VIXCLS", label: "VIX" }] },
        {
          key: "credit",
          label: "Credit",
          items: [
            { id: "F1", label: "High-yield credit spread" },
            { id: "F2", label: "IG credit spread" },
          ],
        },
      ],
      "F2",
    );
    // Group ORDER and member order are the caller's; the seam must not re-sort either.
    expect(html.indexOf('label="Market series"')).toBeLessThan(html.indexOf('label="Credit"'));
    expect(html.indexOf('value="F1"')).toBeLessThan(html.indexOf('value="F2"'));
    expect(html).toContain('<optgroup label="Credit">');
    expect(html).toContain('<option value="F2" selected>IG credit spread</option>');
    // The "none" option stays OUTSIDE every group — it is not an indicator.
    expect(html).toMatch(/<option value=""[^>]*>- none -<\/option><optgroup/);
    // A grouped list whose groups are all empty is an empty picker, not a bare "none".
    expect(companionPickerHtml([{ label: "Credit", items: [] }], null)).toBe("");
  });

  it("the picker's EXTERNAL_COMPANIONS are exactly the handler's COMPANIONS, label for label", () => {
    // The picker dropdown reads EXTERNAL_COMPANIONS while the chart legend reads the label off the
    // /api/replay response (COMPANIONS) — a drift shows one name in the picker and another in the legend.
    expect(EXTERNAL_COMPANIONS.map((c) => c.id)).toEqual(Object.keys(COMPANIONS));
    for (const { id, label } of EXTERNAL_COMPANIONS) expect(label, id).toBe(COMPANIONS[id].label);
  });

  it("companionSeriesUrl routes external ids to /api/replay?companion=, stored ids to /api/series", () => {
    // Bounds snap onto the month grid (P5, api/series.ts parseRange): from floors, the inclusive
    // to ceils — a month-start pair passes through, a within-month to widens to the next 1st.
    expect(companionSeriesUrl("VIXCLS", "2002-03-01", "2003-03-31")).toBe(
      "/api/replay?companion=VIXCLS&from=2002-03-01&to=2003-04-01",
    );
    expect(companionSeriesUrl("^IXIC", "2002-03-01", "2003-03-31")).toContain(
      "/api/replay?companion=%5EIXIC",
    );
    expect(companionSeriesUrl("F1", "2002-03-01", "2003-03-31")).toBe(
      "/api/series?id=F1&from=2002-03-01&to=2003-04-01",
    );
  });

  it("companionSeriesUrl snaps within-month episode bounds onto the month grid (P5)", () => {
    // EPISODES bounds are hand-set off the grid (e.g. 2006-10-31 → 2008-11-20); the emitted
    // from floors and the inclusive to ceils, so the /series 400 can never break a live chart.
    expect(companionSeriesUrl("F1", "2006-10-31", "2008-11-20")).toBe(
      "/api/series?id=F1&from=2006-10-01&to=2008-12-01",
    );
    // A bound already ON the grid is emitted verbatim (no needless widening of the to).
    expect(companionSeriesUrl("F1", "2015-06-01", "2016-03-01")).toBe(
      "/api/series?id=F1&from=2015-06-01&to=2016-03-01",
    );
  });

  it("draws the companion line ON the price panel with its own left-hand axis + legend entry", () => {
    const html = exposureReplayChartHtml(episode(), series());
    expect(html).toContain("erc-value-line");
    expect(html).toContain("erp-ylabel-l");
    expect(html).toContain(">F1<"); // left-axis id label (the IEF right-axis idiom mirrored)
    expect(html).toContain("erp-swatch-comp");
    expect(html).toContain("F1 (companion)");
    // D3: the picked companion owns the left tick column - the equity axis yields.
    expect(html).not.toContain(">Price<");
  });

  it("no companion arg → no overlay/legend entry; left axis shows the equity scale (D3)", () => {
    const html = exposureReplayChartHtml(episode());
    expect(html).not.toContain("erc-value-line");
    expect(html).not.toContain("erp-swatch-comp");
    // D3: the left tick column carries the equity price axis when no companion owns it.
    expect(html).toContain(">Price<");
    expect(html).toContain("erp-ylabel-l");
  });

  it("values match by DATE onto trading days - a gap day is a readout gap, never a shifted line", () => {
    // day 2 missing from the series → drawn points skip it; the crosshair readout
    // carries the native value only where one exists.
    const html = exposureReplayChartHtml(
      episode(),
      series({ points: [series().points[0], series().points[2]] }),
    );
    const m = html.match(/erc-value-line" points="([^"]*)"/);
    expect(m[1].split(" ").length).toBe(2);
    const hv = hoverPayload(html);
    expect(hv.days[0].r).toBe("2008-01-02 · 100.00 · F1 5.10% · Core");
    expect(hv.days[1].r).toBe("2008-01-03 · 100.00 · Core");
    expect(hv.days[2].r).toBe("2008-01-04 · 100.00 · F1 6.20% · Core");
  });

  it("history starting inside the window gets the explicit degrade note; full coverage gets none", () => {
    const partial = exposureReplayChartHtml(
      episode(),
      series({ points: series().points.slice(1) }),
    );
    expect(partial).toContain("history starts 2008-01-03");

    // series first date == episode start ⇒ full coverage, no note
    const full = exposureReplayChartHtml(episode({ start: "2008-01-02" }), series());
    expect(full).not.toContain("history starts");
  });

  it("empty window / under two observations → honest note, the replay chart itself still draws", () => {
    const empty = exposureReplayChartHtml(episode(), series({ points: [] }));
    expect(empty).toContain("erp-empty");
    expect(empty).toContain("<svg"); // overlay degrades, the replay chart never does
    expect(empty).not.toContain("erc-value-line");

    const one = exposureReplayChartHtml(episode(), series({ points: [series().points[0]] }));
    expect(one).toContain("under two observations");
    expect(one).not.toContain("erc-value-line");
  });
});

describe("episodeChipsHtml - episode picker", () => {
  // Synthetic fixture: the live set has no open candidates after the E3 prune, but the
  // candidate-marking machinery stays for future eyeball rounds.
  const episodes = [
    { id: "2008", label: "2008 GFC", candidate: false },
    { id: "2020", label: "2020 COVID", candidate: false },
    { id: "cand", label: "Candidate window", candidate: true },
  ];

  it("renders one chip per episode with the selected chip marked aria-current", () => {
    const html = episodeChipsHtml(episodes, "2020");
    expect((html.match(/data-episode=/g) || []).length).toBe(3);
    expect(html).toContain('data-episode="2020"');
    // the selected chip carries aria-current
    expect(html).toMatch(/data-episode="2020"[^>]*aria-current="true"/);
  });

  it("visibly marks candidate episodes (dimmed/dashed erp-candidate class)", () => {
    const html = episodeChipsHtml(episodes, "2008");
    // the candidate chip carries the erp-candidate marker class
    expect(html).toMatch(/class="[^"]*erp-candidate[^"]*"\s+data-episode="cand"/);
    // only the one candidate is marked
    expect((html.match(/erp-candidate/g) || []).length).toBe(1);
  });

  it("empty episode list → empty string (no stray markup)", () => {
    expect(episodeChipsHtml([], null)).toBe("");
    expect(episodeChipsHtml(undefined, null)).toBe("");
  });
});

/** Sequential daily points from 2008-01-01, n days. */
const daysN = (n) =>
  Array.from({ length: n }, (_, i) =>
    pt(new Date(Date.parse("2008-01-01") + i * 86_400_000).toISOString().slice(0, 10)),
  );
const tickDates = (html) => [...html.matchAll(/erp-xlabel[^>]*>([^<]+)</g)].map((m) => m[1]);

describe("x-axis tick de-dup (Rung B1)", () => {
  it("end tick evicts a last regular tick that would land nearly on top of it", () => {
    // n=27, step=4 → regular ticks …, 24; end tick 26 is only 2 steps' days away
    // (< 0.7·step) — the old code kept BOTH, painting a doubled right-most date.
    const points = daysN(27);
    const labels = tickDates(exposureReplayChartHtml(episode({ points })));
    expect(labels[labels.length - 1]).toBe(points[26].date);
    expect(labels).not.toContain(points[24].date);
    // no two ticks share a date (the doubled-label symptom)
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("keeps the last regular tick when the end tick sits clear of it", () => {
    // n=30, step=5 → last regular tick 25, end tick 29: gap 4 ≥ 0.7·step → both stay.
    const points = daysN(30);
    const labels = tickDates(exposureReplayChartHtml(episode({ points })));
    expect(labels).toContain(points[25].date);
    expect(labels[labels.length - 1]).toBe(points[29].date);
  });
});

describe("eligibleStoredCompanions (P4 — companionAnchorDate gate)", () => {
  const metas = [
    { id: "F1", label: "HY spread", companionAnchorDate: "2014-12-31" }, // reaches ≥2015 → eligible
    { id: "F3", label: "Term spread" }, // no anchor (history short of 2015) → gated out
    { id: "VTP", label: "Chart only", companionAnchorDate: "2010-01-01" }, // eligible but no desc → out
    { id: "F1x", label: "Absent", companionAnchorDate: "2013-01-01" }, // not a desc key → out
  ];
  const descKeys = ["F1", "F3", "F5"]; // F5 has a desc but no meta here

  it("keeps only ids with a companionAnchorDate AND a reader description; label off the meta", () => {
    expect(eligibleStoredCompanions(metas, descKeys)).toEqual([{ id: "F1", label: "HY spread" }]);
  });

  it("falls back to the id when a meta has no label, and tolerates an empty/absent payload", () => {
    expect(eligibleStoredCompanions([{ id: "F1", companionAnchorDate: "2014-01-01" }], ["F1"])).toEqual([{ id: "F1", label: "F1" }]);
    expect(eligibleStoredCompanions([], ["F1"])).toEqual([]);
    expect(eligibleStoredCompanions(null, ["F1"])).toEqual([]);
  });
});

describe("crosshair spans the state lanes (Rung B3)", () => {
  it("the xhair line extends from the price panel down through the Posture lane", () => {
    const html = exposureReplayChartHtml(episode());
    const m = html.match(/class="xhair"[^>]*y1="([\d.]+)"[^>]*y2="([\d.]+)"/);
    expect(m).not.toBeNull();
    // frame math: price panel top 16; Posture lane bottom = 16+150+26 + 2·(22+8) + 22 = 274
    expect(Number(m[1])).toBe(16);
    expect(Number(m[2])).toBe(274);
  });
});

describe("withheld licensed lines", () => {
  const nulled = (ep) => ({ ...ep, points: ep.points.map((p) => ({ ...p, price: null })) });

  it("a redacted body (every price null) paints no price line or equity axis, a withheld legend key + note, lanes intact", () => {
    const html = exposureReplayChartHtml(nulled(episode()));
    expect(html).not.toContain("erp-price-line");
    expect(html).not.toContain(">Price<");
    expect(html).not.toContain("NaN");
    expect(html).toContain("Price (equity) - withheld");
    expect(html).toContain("Price lines withheld");
    expect(html).toContain("erp-band erp-core"); // posture lane still draws
  });

  it("a withheld IEF line gets its legend key marked withheld, never a polyline", () => {
    const def = [{ date: "2008-01-02", price: null }, { date: "2008-01-03", price: null }];
    const html = exposureReplayChartHtml(nulled(episode({ defensive: def })));
    expect(html).not.toContain("erp-defensive-line");
    expect(html).toContain("IEF (bond rung) - withheld");
  });

  it("a redacted companion says withheld - never the misleading no-history note", () => {
    const comp = { indicatorId: "VIXCLS", label: "VIX", unit: "", points: [], redacted: true };
    const html = exposureReplayChartHtml(episode(), comp);
    expect(html).not.toContain("erc-value-line");
    expect(html).toContain("VIX: licensed data, values withheld");
    expect(html).toContain("VIXCLS (companion) - withheld");
    expect(html).not.toContain("no VIX history");
  });

  it("lab.js loads the episode payload through apiFetch, the gated pages' read seam", () => {
    const code = readFileSync(new URL("./lab.js", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join("\n").replace(/\brequest\(((?:(?!\brequest\()[^;])*?), \{ fetchImpl: apiFetch, timeoutMs: API_TIMEOUT_MS \}\)/g, "apiFetch($1)");
    expect(code).toContain('apiFetch("/api/replay")');
    expect(code).not.toMatch(/[^h](fetch|getJson|request|send)\("\/api\/replay"[,)]/);
  });

  it("a full body carries no withheld copy at all", () => {
    const def = [{ date: "2008-01-02", price: 90 }, { date: "2008-01-03", price: 91 }];
    const html = exposureReplayChartHtml(episode({ defensive: def }));
    expect(html).toContain("erp-price-line");
    expect(html).not.toContain("withheld");
  });
});

describe("defensive + companion overlays - characterization snapshots", () => {
  const def = (prices) => prices.map((price, i) => ({ date: `2008-01-0${i + 2}`, price }));
  const comp = (vals, over = {}) => ({
    indicatorId: "F1",
    label: "US High Yield OAS",
    unit: "%",
    points: vals.map((value, i) => ({ date: `2008-01-0${i + 2}`, value })),
    ...over,
  });
  const cases = {
    "defensive: ranged line + right axis": [episode({ defensive: def([90, 91.5, 93]) })],
    "defensive: flat series guard": [episode({ defensive: def([90, 90, 90]) })],
    "defensive: one matched date -> no line, no axis": [episode({ defensive: [{ date: "2008-01-02", price: 90 }, { date: "2009-01-01", price: 95 }] })],
    "defensive: partially null prices": [episode({ defensive: def([90, null, 93]) })],
    "defensive: all null -> withheld": [episode({ defensive: def([null, null]) })],
    "companion: ranged overlay owns the left axis": [episode(), comp([5.1, 5.4, 6.2])],
    "companion: flat series guard": [episode(), comp([5, 5, 5])],
    "companion: history starts after episode start -> note": [episode({ start: "2008-01-02" }), { ...comp([]), points: [{ date: "2008-01-03", value: 5.4 }, { date: "2008-01-04", value: 6.2 }] }],
    "companion: no episode start -> no late-start note": [episode({ start: undefined }), comp([5.1, 5.4, 6.2])],
    "companion: empty window": [episode(), comp([])],
    "companion: under two drawn observations": [episode(), { ...comp([]), points: [{ date: "2008-01-02", value: 5 }, { date: "2009-01-01", value: 6 }] }],
    "companion: non-finite values filtered": [episode(), comp([5.1, NaN, 6.2])],
    "companion: redacted, label falls back to id": [episode(), { indicatorId: "VIXCLS", unit: "", points: [], redacted: true }],
    "companion: no label, no unit, no id": [episode(), { points: [{ date: "2008-01-02", value: 1 }, { date: "2008-01-03", value: 2 }] }],
    "both overlays + withheld equity": [
      { ...episode({ defensive: def([90, 92]) }), points: episode().points.map((p) => ({ ...p, price: null })) },
      comp([5.1, 5.4, 6.2]),
    ],
  };
  for (const [name, args] of Object.entries(cases)) {
    it(name, () => {
      expect(exposureReplayChartHtml(...args)).toMatchSnapshot();
    });
  }
});
