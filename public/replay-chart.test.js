// Stage 3.1 seam: the historical-replay leg-path card is a pure HTML-string builder
// (no jsdom) so vitest can pin its markup with plain string assertions — same idiom
// as scoreboard-card.test.js / tile-members.test.js. It renders the server-computed
// ReplayResponse; NO engine math lives here, so these tests only pin projection.
import { describe, it, expect } from "vitest";
import { replayChartHtml } from "./replay-chart.js";
import { sleeveLabel } from "./sleeve-label.js";

/** A point with sane defaults; override per-day fields as needed. */
const pt = (date, over = {}) => ({
  date,
  targetRung: 5,
  band: "OK",
  regime: "Calm",
  r4Phase: "equity",
  cash: false,
  reentryRung: null,
  ...over,
});

const baseResp = (points, over = {}) => ({
  mode: "replay",
  start: "2025-01-02",
  end: "2025-01-08",
  points,
  coverage: [],
  notes: [],
  ...over,
});

const familyMembers = [
  { label: "Credit", ids: ["F1", "F2"], state: "AMBER" },
  { label: "Trend", ids: ["F4"], state: "GREEN" },
];

describe("replayChartHtml - leg-path projection", () => {
  it("draws one <path class=rp-step> step segment per trading day", () => {
    const points = [pt("2025-01-02"), pt("2025-01-03", { targetRung: 4 }), pt("2025-01-06", { targetRung: 6 })];
    const html = replayChartHtml(baseResp(points));
    const steps = html.match(/class="rp-step[^"]*"/g) || [];
    expect(steps.length).toBe(points.length);
  });

  it("renders a cash band rect IFF at least one point is cash", () => {
    const calm = [pt("2025-01-02"), pt("2025-01-03")];
    expect(replayChartHtml(baseResp(calm))).not.toContain("rp-cash-band");

    const withCash = [
      pt("2025-01-02"),
      pt("2025-01-03", { cash: true, r4Phase: "cash" }),
      pt("2025-01-06", { cash: true, r4Phase: "cash" }),
      pt("2025-01-07", { r4Phase: "reentry", reentryRung: 7 }),
    ];
    const html = replayChartHtml(baseResp(withCash));
    expect(html).toContain("rp-cash-band");
    // one contiguous cash run → exactly one band rect
    expect((html.match(/class="rp-cash-band"/g) || []).length).toBe(1);
  });

  it("gives reentry-phase days a distinct dashed step class", () => {
    const points = [pt("2025-01-02", { r4Phase: "reentry", reentryRung: 7 })];
    expect(replayChartHtml(baseResp(points))).toContain("rp-step rp-reentry");
  });

  it("echoes server notes verbatim (escaped) in the footer", () => {
    const note = "Geopolitics = auto G1 (oil) only; manual flags (`config.json`) have no history.";
    const html = replayChartHtml(baseResp([pt("2025-01-02")], { notes: [note] }));
    // rendered verbatim (backticks + the whole sentence survive; no HTML metachars here)
    expect(html).toContain(note);
    expect(html).toContain('<p class="rp-note">');
  });

  it("renders a per-family coverage strip from coverage × familyMembers", () => {
    const coverage = [
      { id: "F1", firstDate: "2020-03-01" },
      { id: "F2", firstDate: "2019-06-01" },
      { id: "F4", firstDate: null },
    ];
    const html = replayChartHtml(baseResp([pt("2025-01-02")], { coverage }), familyMembers);
    // one coverage bar with a hatched track per family (2), a family label per family (2)
    expect(html).toContain('class="rp-covbar"');
    expect((html.match(/class="rp-cov-gap"/g) || []).length).toBe(2);
    expect((html.match(/class="rp-cov-label"/g) || []).length).toBe(2);
    // Credit HAS covered members (earliest 2019-06-01) → a solid state-colored fill strip,
    // colored by its cached AMBER state; the <title> reports the covered-from date.
    expect(html).toContain('class="rp-cov-fill rp-cov-a"');
    expect(html).toContain("Credit: covered from 2019-06-01");
    // Trend has no covered members → honest "no history", NO fill strip for it
    expect(html).toContain("Trend: no history");
    expect((html.match(/class="rp-cov-fill/g) || []).length).toBe(1);
  });

  it("empty points → honest 'no history in range' placeholder, no SVG", () => {
    const html = replayChartHtml(baseResp([]));
    expect(html).toContain("no history in range");
    expect(html).toContain("rp-warming");
    expect(html).not.toContain("<svg");
  });

  it("null/absent response also yields the placeholder (never throws)", () => {
    expect(replayChartHtml(null)).toContain("no history in range");
    expect(replayChartHtml(undefined)).toContain("no history in range");
  });

  it("labels the y-axis with ladder sleeve names and an off-scale Cash lane", () => {
    const html = replayChartHtml(baseResp([pt("2025-01-02")]));
    expect(html).toContain(`>${sleeveLabel("Semis")}<`); // rung 1, aggressive (top)
    expect(html).toContain(`>${sleeveLabel("Staples")}<`); // rung 9, defensive
    expect(html).toContain(">Cash<"); // off-scale lane
  });
});
