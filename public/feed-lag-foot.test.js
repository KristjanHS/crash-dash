/**
 * §I9.8 J4 — the feed-lag footnote seam (`feed-lag-foot.js`), hoisted out of `lab.js` so its
 * load-bearing nullable guard is actually reachable by a test.
 *
 * What is pinned here is exactly what J4 called load-bearing: a null `age`, `deepLagBar` or `p90Gap`
 * must render `—`, NEVER a fabricated `0d` (the substitute-a-value-for-an-absence defect the §I9
 * wave removes), all-null collapses to ONE `—`, an empty list renders nothing at all, and the
 * id/label pairing runs through `idIfDistinct` rather than printing a bare registry key.
 *
 * Plus the clause's thresholds: age is compared against `lagCut` (the bar LAG crossed) and `deepLagBar`
 * (the bar DEEP-LAG crosses) — never against `p90Gap`, which renders only for MISCADENCED.
 */
import { describe, expect, it } from "vitest";

import { feedLagFootHtml } from "./feed-lag-foot.js";

const note = (over) => ({ id: "F1", label: "LAG", age: 9, p90Gap: 3, deepLagBar: 6, lagCut: 2, registered: "daily", ...over });

describe("feedLagFootHtml - the ledger's feed-lag footnote", () => {
  it("renders nothing at all for an empty or absent list", () => {
    expect(feedLagFootHtml([], {})).toBe("");
    expect(feedLagFootHtml(undefined, {})).toBe("");
    expect(feedLagFootHtml(null, {})).toBe("");
  });

  it("prints every measured number when the feed WAS measured", () => {
    const html = feedLagFootHtml([note({ label: "DEEP-LAG" })], { F1: "HY OAS" });
    expect(html).toContain("· DEEP-LAG · 9d vs lag cut 2d · deep-lag bar 6d · registered daily");
  });

  // EBP 2026-09-10: a monthly feed's p90 (31d) is observation spacing, so "71d · own p90 31d" read as
  // 40 days overdue when it was one day past its 70d publication cut.
  it("names the lag cut a LAG crossed, and no p90 beside it", () => {
    const html = feedLagFootHtml([note({ label: "LAG", age: 71, p90Gap: 31, deepLagBar: 80, lagCut: 70 })], {});
    expect(html).toContain("71d vs lag cut 70d · deep-lag bar 80d · registered");
    expect(html).not.toContain("· own p90");
  });

  it("keeps the own p90 for MISCADENCED, the one label it decides", () => {
    const html = feedLagFootHtml([note({ label: "MISCADENCED", age: 5, p90Gap: 7, deepLagBar: 14, lagCut: 3 })], {});
    expect(html).toContain("5d vs lag cut 3d · deep-lag bar 14d · own p90 7d");
  });

  it("prints - for a null age, never 0d", () => {
    const html = feedLagFootHtml([note({ age: null })], {});
    expect(html).not.toContain("0d");
    expect(html).toContain("- vs lag cut 2d · deep-lag bar 6d");
  });

  it("prints - for a null deepLagBar, lagCut or p90Gap, never 0d", () => {
    expect(feedLagFootHtml([note({ deepLagBar: null })], {})).toContain("9d vs lag cut 2d · deep-lag bar -");
    expect(feedLagFootHtml([note({ lagCut: undefined })], {})).toContain("9d vs lag cut - · deep-lag bar 6d");
    const html = feedLagFootHtml([note({ label: "MISCADENCED", p90Gap: null })], {});
    expect(html).not.toContain("0d");
    expect(html).toContain("9d vs lag cut 2d · deep-lag bar 6d · own p90 -");
  });

  // §I9.7's paint expectation for a `?s=lag:` knob entry (no axis measured) is
  // `F1 · LAG · — · registered daily` — ONE dash, not the hollow `— vs lag cut — · deep-lag bar —`.
  it("collapses to a single - when NO axis was measured", () => {
    const html = feedLagFootHtml([note({ age: null, p90Gap: null, deepLagBar: null, lagCut: null })], {});
    expect(html).toContain("F1 · LAG · - · registered daily");
    // Scoped forms — the `title` tooltip legitimately explains both terms, so a bare
    // `not.toContain("own p90")` would red on the tooltip rather than on the clause.
    expect(html).not.toContain("· own p90");
    expect(html).not.toContain("vs lag cut");
    expect(html).not.toContain("0d");
  });

  // Rule 2: a registry id never renders bare — it is paired with the served member label, and
  // collapses to the label alone when the id merely restates it (`idIfDistinct`).
  it("pairs the id with its served label, and drops a restating id", () => {
    expect(feedLagFootHtml([note()], { F1: "HY OAS" })).toContain(">F1 HY OAS · LAG");
    expect(feedLagFootHtml([note({ id: "OVX" })], { OVX: "OVX" })).toContain(">OVX · LAG");
    // No label served for the id ⇒ the id stands alone (there is nothing to de-duplicate against).
    expect(feedLagFootHtml([note()], {})).toContain(">F1 · LAG");
  });
});
