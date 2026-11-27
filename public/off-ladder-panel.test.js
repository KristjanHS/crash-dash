// Characterization tests for the three off-ladder panel markup builders. Plain `.js`
// so vitest collects it and tsc ignores it — no jsdom (pure string builders).
// Mirrors format.test.js / app-state.test.js. Pins the output BYTE-FOR-BYTE (no
// whitespace normalization).
//
// The panels are verdict banners: no builder takes a `body`, and the slow footer carries the
// continuous metrics and renders in the muted branch too.
//
// Meta fixtures are the REAL BOTTOM_META / SLOW_BAND_META (imported from
// off-ladder-specs.js) rather than a hand-copy that could drift; the builder renders
// whatever meta it is handed, so the muted branch is `meta === undefined`.
import { describe, it, expect } from "vitest";
import { bottomPanelHTML, slowPanelHTML, slowMetricsText } from "./off-ladder-panel.js";
import { BOTTOM_META, SLOW_BAND_META } from "./off-ladder-specs.js";

const LEGEND = "the-bottom-legend"; // no esc-relevant chars → esc is a no-op here

describe("bottomPanelHTML", () => {
  it("muted CALM → bottom-muted class, calm note, no head/frame, NO card body", () => {
    const out = bottomPanelHTML({ bottomState: "CALM" }, { legend: LEGEND, meta: undefined });
    expect(out).toBe(
      `<div class="bottom-panel bottom-muted">
      <span class="bottom-label" title="the-bottom-legend">VIX bottom watch</span>
      <span class="bottom-sub">calm - no capitulation signal.</span>
    </div>`,
    );
  });

  it("muted null/degraded → feed-unavailable note", () => {
    const out = bottomPanelHTML({ bottomState: null }, { legend: LEGEND, meta: undefined });
    expect(out).toBe(
      `<div class="bottom-panel bottom-muted">
      <span class="bottom-label" title="the-bottom-legend">VIX bottom watch</span>
      <span class="bottom-sub">signal unavailable (VIX feed).</span>
    </div>`,
    );
  });

  it("active CAPITULATION-WATCH → meta.cls, head + frame line, meta.sub", () => {
    const out = bottomPanelHTML(
      { bottomState: "CAPITULATION-WATCH" },
      { legend: LEGEND, meta: BOTTOM_META["CAPITULATION-WATCH"] },
    );
    expect(out).toBe(
      `<div class="bottom-panel bottom-watch">
      <div class="bottom-head">
        <span class="bottom-label" title="the-bottom-legend">Capitulation watch</span>
        <span class="bottom-frame">Fear may be peaking - downside risk remains.</span>
      </div>
      <span class="bottom-sub">Acute panic active - a heads-up, not a buy. Downside may continue.</span>
    </div>`,
    );
  });

  it("active BOTTOM-FORMING → its own meta.cls/label/sub", () => {
    const out = bottomPanelHTML({ bottomState: "BOTTOM-FORMING" }, { legend: LEGEND, meta: BOTTOM_META["BOTTOM-FORMING"] });
    expect(out).toContain(`<div class="bottom-panel bottom-forming"`);
    expect(out).toContain(`<span class="bottom-label" title="the-bottom-legend">Bottom forming</span>`);
    expect(out).toContain(`<span class="bottom-sub">Spike cresting + term structure normalising - a contrarian re-risk hint.</span>`);
  });

  it("escapes the legend into the title attribute", () => {
    const out = bottomPanelHTML({ bottomState: "CALM" }, { legend: `a"&<b`, meta: undefined });
    expect(out).toContain(`title="a&quot;&amp;&lt;b"`);
  });
});

const SL = "the-slow-legend";
const METRICS = { accelM: 0.85, cvixM: 0.05, chighM: 0.99 };

describe("slowPanelHTML", () => {
  // Ruling 4: the metrics ARE the informative half of this read, so the score line and
  // the metric line both survive into the muted branch (where the always-on leg cards
  // used to carry them). The muted footer is new — it is why this file was re-baselined.
  it("muted CALM → slow-muted, calm note, score line AND metric line", () => {
    const out = slowPanelHTML({ band: "CALM", score: 0, maxScore: 4, metrics: METRICS }, { legend: SL, meta: undefined });
    expect(out).toBe(
      `<div class="slow-panel slow-muted">
      <span class="slow-label" title="the-slow-legend">Bubble-state watch</span>
      <span class="slow-sub">calm - no bubble-state signal.</span>
      <span class="slow-score">score 0 / 4</span>
      <span class="slow-metrics">price-accel 0.85 · complacency-vix 0.05 · complacency-high 0.99</span>
    </div>`,
    );
  });

  it("muted null/degraded → feed-unavailable note, em-dash score", () => {
    const out = slowPanelHTML({ band: null, score: NaN, maxScore: 4, metrics: METRICS }, { legend: SL, meta: undefined });
    expect(out).toContain(`<span class="slow-sub">signal unavailable (slow feed).</span>`);
    expect(out).toContain(`<span class="slow-score">score - / 4</span>`);
  });

  it("active ELEVATED + finite score → meta.cls, frame, score + metrics", () => {
    const out = slowPanelHTML({ band: "ELEVATED", score: 3, maxScore: 4, metrics: METRICS }, { legend: SL, meta: SLOW_BAND_META.ELEVATED });
    expect(out).toBe(
      `<div class="slow-panel slow-elevated">
      <div class="slow-head">
        <span class="slow-label" title="the-slow-legend">Elevated bubble state</span>
        <span class="slow-frame">Bubble fuel - not a crash call.</span>
      </div>
      <span class="slow-sub">Speculative fuel is building - a heads-up, not a crash call.</span>
      <span class="slow-score">score 3 / 4</span>
      <span class="slow-metrics">price-accel 0.85 · complacency-vix 0.05 · complacency-high 0.99</span>
    </div>`,
    );
  });

  it("active DE-RISK + non-finite score → score line shows em dash", () => {
    const out = slowPanelHTML({ band: "DE-RISK", score: NaN, maxScore: 4, metrics: METRICS }, { legend: SL, meta: SLOW_BAND_META["DE-RISK"] });
    expect(out).toContain(`<div class="slow-panel slow-derisk"`);
    expect(out).toContain(`<span class="slow-score">score - / 4</span>`);
  });

  // The /series pull can fail or be skipped; the banner must still paint its verdict
  // rather than a row of em dashes pretending to be readings.
  it("no metrics threaded → score line only, no metric span", () => {
    const out = slowPanelHTML({ band: "ELEVATED", score: 3, maxScore: 4 }, { legend: SL, meta: SLOW_BAND_META.ELEVATED });
    expect(out).toContain(`<span class="slow-score">score 3 / 4</span>`);
    expect(out).not.toContain("slow-metrics");
  });

  it("a null metric renders an em dash, never a fabricated number", () => {
    expect(slowMetricsText({ accelM: 0.85, cvixM: null, chighM: 0.99 })).toBe(
      "price-accel 0.85 · complacency-vix - · complacency-high 0.99",
    );
  });

  // OFF-2 — the denominator is the SERVER's `verdict.slowMaxScore` for that run, not a
  // constant and not the count of legs quoted on the metric line (complacency-duration
  // scores in src/slow.ts without a continuous /series metric to print here). A maxScore
  // that is NOT 4 must reach the screen verbatim — that is what makes this test bite: the
  // old hardcoded `/ 4` renderer passed every fixture above and would fail only here.
  it("the denominator is whatever the server sent, not a hardcoded 4", () => {
    const out = slowPanelHTML({ band: "ELEVATED", score: 4, maxScore: 6, metrics: METRICS }, { legend: SL, meta: SLOW_BAND_META.ELEVATED });
    expect(out).toContain("score 4 / 6");
    expect(out).not.toContain("/ 4");
    expect(slowMetricsText(METRICS).split(" · ")).toHaveLength(3);
  });

  // A pre-OFF-2 row (and a degraded slow run) carries no denominator. Unknown must READ as
  // unknown — never fall back to the retired constant.
  it("a null/absent maxScore renders an em-dash denominator, never a fallback constant", () => {
    const out = slowPanelHTML({ band: "ELEVATED", score: 3, maxScore: null, metrics: METRICS }, { legend: SL, meta: SLOW_BAND_META.ELEVATED });
    expect(out).toContain(`<span class="slow-score">score 3 / -</span>`);
  });
});
