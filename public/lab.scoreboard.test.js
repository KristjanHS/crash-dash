// D9 live-scoreboard card (Stage 4). Plain `.js` so vitest's default glob collects it
// while `tsc` ignores it — no jsdom needed: scoreboard-card.js is the pure HTML seam
// lab.js's renderScoreboard paints into #sbBody (same pattern as tile-members.test.js).
// The DTO shapes below mirror src/scoreboard.ts's ScoreboardView exactly.
import { describe, expect, it } from "vitest";
import { scoreboardCardHtml } from "./scoreboard-card.js";

const cell = (value) => ({ value, naReason: null });
const na = (reason) => ({ value: null, naReason: reason });

/** A settled live scoreboard: ulcer gate FAIL, overrides gate PASS (deliberately split so a
 *  combined/merged verdict could not satisfy both assertions), recovery unrecovered. */
function liveSb(overrides = {}) {
  return {
    warmingUp: false,
    since: "2026-07-15",
    runs: 42,
    windowStatement:
      "measuring since 2026-07-15 · 42 runs - short window: informational, not yet kill-grade (D7 needs ≥2 non-overlapping windows)",
    yardstickLabel: "yardstick: ACWI ETF proxy (USD→EUR) - not Tuleva EUR NAV",
    strategy: {
      ulcer: cell(1.84),
      maxDD: cell(-6.3),
      calmar: na("n/a yet - 42 runs < 60"),
      recoveryRuns: na("n/a yet - unrecovered"),
      annRet: cell(0.041),
    },
    benchmark: {
      ulcer: cell(1.02),
      maxDD: cell(-4.1),
      calmar: na("n/a yet - 42 runs < 60"),
      recoveryRuns: cell(7),
      annRet: cell(0.055),
    },
    gates: {
      ulcer: { verdict: "FAIL", naReason: null, strategyUi: 1.84, benchmarkUi: 1.02 },
      overrides: { verdict: "PASS", count: 1, limit: 3 },
    },
    returnVsFundPp: -1.4,
    returnFlag: "RETUNE",
    timeInCashShare: 0.12,
    ...overrides,
  };
}

/** The pre-first-cron shape Stage 3 serves (zero SB rows): every metric n/a, gate (a) n/a. */
function warmingSb() {
  const warm = na("n/a yet - warming up");
  const col = { ulcer: warm, maxDD: warm, calmar: warm, recoveryRuns: warm, annRet: warm };
  return {
    warmingUp: true,
    since: null,
    runs: 0,
    windowStatement: "",
    yardstickLabel: "yardstick: ACWI ETF proxy (USD→EUR) - not Tuleva EUR NAV",
    strategy: col,
    benchmark: col,
    gates: {
      ulcer: { verdict: null, naReason: "n/a yet - warming up", strategyUi: null, benchmarkUi: null },
      overrides: { verdict: "PASS", count: 0, limit: 3 },
    },
    returnVsFundPp: null,
    returnFlag: null,
    timeInCashShare: null,
  };
}

describe("scoreboardCardHtml - gates", () => {
  it("renders the two gates as SEPARATE verdicts, each row carrying its own badge", () => {
    const html = scoreboardCardHtml(liveSb());
    // Two distinct gate rows, addressable independently.
    const ulcerRow = html.match(/<div class="sb-gate" data-gate="ulcer">.*?<\/div>/s)?.[0];
    const ovrRow = html.match(/<div class="sb-gate" data-gate="overrides">.*?<\/div>/s)?.[0];
    expect(ulcerRow).toBeTruthy();
    expect(ovrRow).toBeTruthy();
    // Split verdicts survive independently — impossible for any combined figure.
    expect(ulcerRow).toContain('class="sb-badge fail"');
    expect(ovrRow).toContain('class="sb-badge pass"');
    // Gate (a) shows BOTH ulcer numbers (never a ratio-of-gates)...
    expect(ulcerRow).toContain("1.84");
    expect(ulcerRow).toContain("1.02");
    // ...and gate (b) shows count/limit.
    expect(ovrRow).toContain("<b>1</b>/3 recorded");
  });

  it("gate (a) goes n/a (null verdict) with the server reason, keeping gate (b) real", () => {
    const sb = liveSb({
      gates: {
        ulcer: { verdict: null, naReason: "n/a yet - 3 runs < 10", strategyUi: null, benchmarkUi: null },
        overrides: { verdict: "FAIL", count: 4, limit: 3 },
      },
    });
    const html = scoreboardCardHtml(sb);
    const ulcerRow = html.match(/<div class="sb-gate" data-gate="ulcer">.*?<\/div>/s)?.[0];
    expect(ulcerRow).toContain('class="sb-badge na"');
    expect(ulcerRow).toContain("n/a yet - 3 runs &lt; 10");
    expect(html.match(/<div class="sb-gate" data-gate="overrides">.*?<\/div>/s)?.[0]).toContain(
      'class="sb-badge fail"',
    );
  });
});

describe("scoreboardCardHtml - honesty labels", () => {
  it("carries both verbatim labels: the Fork-1 yardstick proxy and the Fork-3 window statement", () => {
    const html = scoreboardCardHtml(liveSb());
    expect(html).toContain("yardstick: ACWI ETF proxy (USD→EUR) - not Tuleva EUR NAV");
    expect(html).toContain(
      "measuring since 2026-07-15 · 42 runs - short window: informational, not yet kill-grade (D7 needs ≥2 non-overlapping windows)",
    );
  });
});

describe("scoreboardCardHtml - n/a rendering", () => {
  it("shows `n/a yet` for unrecovered recovery (reason on [title]), value cells stay numeric", () => {
    const html = scoreboardCardHtml(liveSb());
    const recoveryRow = html.match(/<tr><th>recovery<\/th>.*?<\/tr>/s)?.[0];
    expect(recoveryRow).toBeTruthy();
    // strategy column: honest n/a with the server's reason; benchmark column: the real count.
    expect(recoveryRow).toContain('title="n/a yet - unrecovered">n/a yet</span>');
    expect(recoveryRow).toContain("<b>7 runs</b>");
  });
});

describe("scoreboardCardHtml - warming up", () => {
  it("renders the honest empty card (no metrics strip, no crash), gates still separate", () => {
    const html = scoreboardCardHtml(warmingSb());
    expect(html).toContain("warming up - no scoreboard runs recorded yet");
    expect(html).not.toContain("<table"); // no metrics strip on the empty card
    // Gate (a) n/a, gate (b) real from day 0 (override-backed, needs no SB rows).
    expect(html.match(/<div class="sb-gate" data-gate="ulcer">.*?<\/div>/s)?.[0]).toContain(
      'class="sb-badge na"',
    );
    expect(html.match(/<div class="sb-gate" data-gate="overrides">.*?<\/div>/s)?.[0]).toContain(
      "<b>0</b>/3 recorded",
    );
    // The yardstick honesty label still shows while warming.
    expect(html).toContain("yardstick: ACWI ETF proxy (USD→EUR) - not Tuleva EUR NAV");
  });
});

describe("scoreboardCardHtml - scenario mode", () => {
  it("returns null when the response has no scoreboard field, so the section is absent", () => {
    // renderScoreboard(sb) sets #scoreboard.hidden = (html === null) — null IS the absence contract.
    expect(scoreboardCardHtml(undefined)).toBeNull();
    expect(scoreboardCardHtml(null)).toBeNull();
  });
});

describe("scoreboardCardHtml - M2 flag chips", () => {
  it("renders the RETUNE chip on the return-vs-fund line", () => {
    const html = scoreboardCardHtml(liveSb());
    expect(html).toContain('<span class="sb-flag retune">RETUNE</span>');
    expect(html).toContain("-1.40 pp/yr");
  });

  it("renders the KILL-FLOOR chip, and no chip when the flag is null", () => {
    const killed = scoreboardCardHtml(liveSb({ returnVsFundPp: -2.6, returnFlag: "KILL-FLOOR" }));
    expect(killed).toContain('<span class="sb-flag kill">KILL-FLOOR</span>');
    const clean = scoreboardCardHtml(liveSb({ returnVsFundPp: 0.4, returnFlag: null }));
    expect(clean).not.toContain("sb-flag");
    expect(clean).toContain("+0.40 pp/yr");
  });
});
