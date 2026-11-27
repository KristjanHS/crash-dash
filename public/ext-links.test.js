// Seam test for the external chart-link renderer (public/ext-links.js) and the hand-authored link
// data it renders (indicator-desc.js `links`, leg-desc.js `holdings`). Plain `.js` so vitest
// collects it and tsc skips it (frontend.md); TS imports are extensionless.
import { describe, it, expect } from "vitest";
import { isChartUrl, linkList, holdingList } from "./ext-links.js";
import { INDICATOR_DESC } from "./indicator-desc.js";
import { LEG_DESC } from "./leg-desc.js";
import { LEG_FIELD } from "../src/danger-ladder";

const SLEEVES = LEG_FIELD.map((l) => l.sleeve);

describe("ext-links renderer", () => {
  it("renders an allowlisted https URL as an escaped new-tab anchor", () => {
    const html = linkList([{ label: "A<b>", url: "https://www.trading212.com/trading-instruments/cfd/CRUDE.SEP26" }]);
    expect(html).toBe(
      '<a href="https://www.trading212.com/trading-instruments/cfd/CRUDE.SEP26" target="_blank" rel="noopener noreferrer">A&lt;b&gt;↗</a>',
    );
  });

  it("fails closed: drops non-https, off-allowlist and non-URL entries", () => {
    for (const url of [
      "http://www.trading212.com/trading-instruments/cfd/CRUDE.SEP26",
      "https://evil.example/quote/NVDA/",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(isChartUrl(url), url).toBe(false);
      expect(linkList([{ label: "x", url }]), url).toBe("");
    }
  });

  it("holdingList renders escaped plain names, no anchors", () => {
    expect(holdingList([{ name: "A&B" }, { name: "TSMC" }])).toBe('<span class="ext-holding">A&amp;B</span> · <span class="ext-holding">TSMC</span>');
  });
});

describe("hand-authored chart links", () => {
  it("every indicator link is an allowlisted https chart URL", () => {
    const withLinks = Object.entries(INDICATOR_DESC).filter(([, d]) => d.links);
    expect(withLinks.map(([id]) => id)).toEqual(expect.arrayContaining(["BRENT"]));
    for (const [id, d] of withLinks) for (const l of d.links) expect(isChartUrl(l.url), `${id}: ${l.url}`).toBe(true);
  });

  // ≥4, not ==4: a user-named extra (Alphabet on S&P 500) may follow the top 4.
  it("every sleeve lists at least its top 4 holdings, each a bare {name} row (no links)", () => {
    for (const sleeve of SLEEVES) {
      const h = LEG_DESC[sleeve]?.holdings;
      expect(h?.length, sleeve).toBeGreaterThanOrEqual(4);
      for (const row of h) expect(Object.keys(row), `${sleeve} ${row.name}`).toEqual(["name"]);
    }
  });
});
