// Danger-ledger numerals read the served share-lit `danger` / `subDangers`; EW/SN stack the served `familiesLit` count.
import { describe, expect, it } from "vitest";

import { renderDangerNum, renderEwSpeed, renderFamiliesLit, renderSnSpeed, renderTrend } from "./lab-board.js";

const scored = (value) => ({ kind: "scored", value });
const LEG = {
  danger: 0.32,
  subDangers: { earlyWarn: scored(0.4), stressNow: scored(0.1) },
  trend: { value: 0.2, counting: true },
  familiesLit: { earlyWarn: { lit: 2, of: 3 }, stressNow: { lit: 0, of: 2 } },
};
const num = (html) => html.match(/class="lg-dotv[^"]*"[^>]*>([^<]*)</)[1];
const band = (html) => html.match(/class="lg-dotv ([^"]*)"/)[1];
const title = (html) => html.match(/class="lg-dotv[^"]*" title="([^"]*)"/)[1];

describe("ledger numerals: the served share value, no % sub-numeral", () => {
  it.each([
    ["Own-Danger", renderDangerNum, "32"],
    ["EW", renderEwSpeed, "40"],
    ["SN", renderSnSpeed, "10"],
    ["Trend", renderTrend, "20"],
    ["Trend gated", (l) => renderTrend({ ...l, trend: { ...l.trend, counting: false } }), "(20)"],
  ])("%s", (_name, render, shown) => {
    const html = render(LEG);
    expect(num(html)).toBe(shown);
    expect(html).not.toMatch(/\d%/);
  });

  it("Own-Danger numeral === served `danger` on a row with no `reach`, title still 'of 100 = every input lit'", () => {
    const html = renderDangerNum({ ...LEG, danger: 0.61, reach: undefined });
    expect(num(html)).toBe("61");
    expect(band(html)).toBe("r");
    expect(title(html)).toContain("OWN-DANGER 61 (of 100 = every input lit)");
    expect(title(renderEwSpeed(LEG))).toContain("EARLY-WARN 40 (of 100 = every input lit)");
    expect(title(renderSnSpeed(LEG))).toContain("STRESS-NOW 10 (of 100 = every input lit)");
  });

  it("a stale `reach` on the payload is ignored: the numeral stays the share", () => {
    const stale = { ...LEG, reach: { earlyWarn: 0.9, stressNow: 0.9, trend: 0.9, danger: 0.9 } };
    expect([renderDangerNum, renderEwSpeed, renderSnSpeed].map((r) => num(r(stale)))).toEqual(["32", "40", "10"]);
  });
});

describe("ledger families-lit count from `familiesLit`", () => {
  it("renders N/M per pillar from the served counts", () => {
    expect(renderFamiliesLit(LEG, "earlyWarn")).toMatch(/>2\/3 lit</);
    expect(renderFamiliesLit(LEG, "stressNow")).toMatch(/>0\/2 lit</);
    expect(renderFamiliesLit(LEG, "earlyWarn")).toContain('title="2/3 families lit');
  });

  it("absent counts or no observed family render nothing, never 0/0", () => {
    expect(renderFamiliesLit({ ...LEG, familiesLit: undefined }, "earlyWarn")).toBe("");
    expect(renderFamiliesLit({ ...LEG, familiesLit: { ...LEG.familiesLit, earlyWarn: { lit: 0, of: 0 } } }, "earlyWarn")).toBe("");
  });
});
