/**
 * The `/lab` COVERAGE seam (`coverage-marks.js`): the `⊗` member badge + the one ledger-legend line.
 *
 * What is pinned:
 *  · the healthy (clean-coverage) case emits NOTHING on either surface — the badge and the legend
 *    must be absent, not an empty shell, so a board with full coverage keeps the legend it had;
 *  · the glyph is `⊗` and is NEVER `◌`/`⌁` (those are feed-LAG diagnostics — "behind, but not
 *    arming" — a different claim from "dark, and arming the coverage floor");
 *  · both copy surfaces state the REDEFINED claim: the member is not live and is HOLDING its
 *    family's verdict, which ARMS the coverage floor (band ≥ WATCH) because we cannot see — never
 *    because the market moved;
 *  · the feed symbol and the age come from the served MARK itself (recorded on the run that pushed
 *    the dial), never from the request-path `feedLag`, and the age clause is OMITTED when the wire
 *    carries none — never fabricated as `0d` (the same absence rule `feed-lag-foot.test.js` pins);
 *  · the badge carries no `data-id` — `lab.js` wires every `.ids [data-id]` as a state-cycling
 *    click target, and the badge is an annotation, not a leg.
 */

import { describe, expect, it } from "vitest";

import { COVERAGE_GLYPH, coverageBadgeHtml, coverageIndex, coverageLegendHtml } from "./coverage-marks.js";

/** A `CoverageMark`, the shape `run-cycle-dial.ts` records, `/api/lab` serves verbatim. */
const mark = (over) => ({ id: "R6", reason: "lag", series: "^MOVE", state: "GREEN", ageDays: 15, ...over });
/** One `CoverageDegrade` — a family whose verdict is held by the marks it carries. */
const degrade = (over) => ({ family: "rates", verdict: "GREEN", carried: false, members: [mark()], ...over });
/** The served id→short-label map (`dangerModel.memberLabel`) the legend names members from. */
const LABELS = { R6: "MOVE", R7: "2s10s", GT: "ACWI trend" };

describe("coverageIndex", () => {
  it("is empty for a payload with clean coverage, an absent field, or no payload", () => {
    expect(coverageIndex({ coverage: [] })).toEqual({});
    expect(coverageIndex({})).toEqual({});
    expect(coverageIndex(undefined)).toEqual({});
  });

  it("indexes every family's MEMBERS by member id, carrying the family and its held verdict", () => {
    const idx = coverageIndex({ coverage: [degrade()] });
    expect(idx.R6).toEqual({ ...mark(), family: "rates", verdict: "GREEN" });
  });

  it("flattens across families - a second degraded family's members are indexed too", () => {
    const idx = coverageIndex({
      coverage: [
        degrade(),
        degrade({ family: "trend", verdict: "AMBER", members: [mark({ id: "GT", series: "ACWI", ageDays: 9 })] }),
      ],
    });
    expect(Object.keys(idx).sort()).toEqual(["GT", "R6"]);
    expect(idx.GT.family).toBe("trend");
  });
});

describe("coverageBadgeHtml - the member chip's ⊗", () => {
  it("emits nothing for a member that is live", () => {
    expect(coverageBadgeHtml(undefined)).toBe("");
    expect(coverageBadgeHtml(null)).toBe("");
  });

  // Rule 2 (`public/prose-names.test.ts`): a registry id never renders bare in user-visible copy. The
  // chip beside this badge already reads its served short label, so the badge's own hover naming the
  // same member by its raw id ("R6 is not live") contradicted it. The label is passed by the caller
  // (`legSpan`, lab-board.js) off the member's served `label`.
  it("names the member by its served short label, not the registry id", () => {
    const html = coverageBadgeHtml({ ...mark(), family: "rates", verdict: "GREEN" }, "MOVE");
    expect(html).toContain("MOVE is not live (lag 15d) and is holding");
    expect(html).not.toContain("R6 is not live");
  });

  it("degrades to the id when no label was served - never to a nameless sentence", () => {
    const html = coverageBadgeHtml({ ...mark(), family: "rates", verdict: "GREEN" }, undefined);
    expect(html).toContain("R6 is not live");
  });

  // The REDEFINED claim (R7): not "this leg was flipped RED" but "this leg is dark and that is what
  // floored the band". A title that named a state override instead would red here.
  it("emits the ⊗ badge naming the hold and the floor it arms", () => {
    const html = coverageBadgeHtml({ ...mark(), family: "rates", verdict: "GREEN" });
    expect(html).toContain('class="leg-flip"');
    expect(html).toContain("⊗");
    expect(html).toContain("R6 is not live (lag 15d) and is holding rates&#39;s GREEN verdict");
    expect(html).toContain("this arms the coverage floor (band ≥ WATCH)");
  });

  // The two reasons are a DISCRIMINATING pair: an absent member has no reading this run, so it can
  // carry no age at all and must read `absent`, never `lag 0d`.
  it("says `absent` (with no age) for a member that did not report", () => {
    const html = coverageBadgeHtml({ ...mark({ reason: "absent", series: null, state: null, ageDays: null }), family: "trend", verdict: "AMBER" });
    expect(html).toContain("is not live (absent) and is holding trend&#39;s AMBER verdict");
    expect(html).not.toContain("0d");
  });

  // A CARRIED member (absent this run but folded on its own IN-CUT close) renders a distinct badge
  // that names `carried Xd` and does NOT claim it arms the floor — it is within its cut, so it doesn't.
  it("says `carried Xd` and does not claim the floor for a carried member", () => {
    const html = coverageBadgeHtml({ ...mark({ reason: "carried" }), family: "rates", verdict: "RED" });
    expect(html).toContain("⊗");
    expect(html).toContain("R6 is not live (carried 15d)");
    expect(html).toContain("does not arm the coverage floor");
    expect(html).not.toContain("this arms the coverage floor");
  });

  // The DISCRIMINATING case for "never reuse ◌/⌁": those are feed-LAG marks ("behind, but not
  // arming") and this one ARMS the floor. A badge borrowing either glyph (or the Lag column's
  // classes) reds here.
  it("never reuses the feed-lag glyphs or their classes", () => {
    const html = coverageBadgeHtml({ ...mark(), family: "rates", verdict: "GREEN" });
    expect(html).not.toContain("◌");
    expect(html).not.toContain("⌁");
    expect(html).not.toContain("sig-lag");
    expect(html).not.toContain("leg-lag");
  });

  // `lab.js` turns every `.ids [data-id]` into a state-cycling button on the scenario path; a badge
  // carrying `data-id` would become a second clickable target for the same member.
  it("carries no data-id", () => {
    expect(coverageBadgeHtml({ ...mark(), family: "rates", verdict: "GREEN" })).not.toContain("data-id");
  });
});

describe("coverageLegendHtml - the ledger legend line", () => {
  it("renders nothing at all when the run's coverage was clean", () => {
    expect(coverageLegendHtml([])).toBe("");
    expect(coverageLegendHtml(undefined)).toBe("");
    expect(coverageLegendHtml(null)).toBe("");
  });

  // R7's copy — the family, its HELD verdict, the member's SHORT LABEL and the run-time age. The
  // age is off the mark the run recorded (a legend sourcing it from the request-path `feedLag`
  // would print whatever today's read measured, not what the run cut on); the NAME is the served
  // `dangerModel.memberLabel` entry, so neither the registry id nor the feed symbol reaches the eye.
  it("names the family, its held verdict and the member holding it, by short label and age", () => {
    const html = coverageLegendHtml([degrade()], LABELS);
    expect(html).toContain(COVERAGE_GLYPH);
    expect(html).toContain("COVERAGE - rates GREEN held by MOVE, 15d old");
    expect(html).not.toContain("R6");
    expect(html).not.toContain("^MOVE");
  });

  // The hover copy is the whole point of the redefinition: WATCH because we cannot see.
  it("its hover says the band was floored because we cannot see, not because the market moved", () => {
    const html = coverageLegendHtml([degrade()]);
    expect(html).toContain("floored at WATCH because we cannot SEE, not because the market moved");
  });

  // The absence rule: `ageDays` is null on the wire for an absent member (and for a run that
  // recorded no freshness stamp), so the clause must be dropped, never printed as `0d`.
  it("omits the age clause when the mark carries no measured age", () => {
    for (const missing of [{ ageDays: null }, { ageDays: undefined }]) {
      const html = coverageLegendHtml([degrade({ members: [mark(missing)] })], LABELS);
      expect(html).toContain("rates GREEN held by MOVE");
      expect(html).not.toContain("0d");
    }
  });

  it("lists every degraded family, and every member holding each one", () => {
    const html = coverageLegendHtml(
      [
        degrade({ members: [mark(), mark({ id: "R7", series: "T10Y2Y", reason: "absent", ageDays: null })] }),
        degrade({ family: "trend", verdict: "AMBER", members: [mark({ id: "GT", series: "ACWI", ageDays: 9 })] }),
      ],
      LABELS,
    );
    expect(html).toContain("rates GREEN held by MOVE, 15d old, 2s10s · trend AMBER held by ACWI trend, 9d old");
  });

  // A CARRIED member (within its lag cut) rides c.members alongside the genuine holder but arms NO
  // floor, so it must NOT be enumerated under "held by" — doing so re-introduces the false "held by"
  // framing this change removed and contradicts the per-chip badge ("does not arm the coverage floor").
  it("separates a carried member from the holders - never enumerates it under `held by`", () => {
    const html = coverageLegendHtml(
      [degrade({ members: [mark(), mark({ id: "R7", reason: "carried", ageDays: 3 })] })],
      LABELS,
    );
    expect(html).toContain("rates GREEN held by MOVE, 15d old (2s10s, 3d old carried, not arming)");
    // The carried label must not fall inside the `held by …` enumeration (before the parenthetical).
    const heldClause = html.slice(html.indexOf("held by"), html.indexOf("("));
    expect(heldClause).not.toContain("2s10s");
  });

  // The label map is a SEPARATE serverless fetch (`/api/danger-model`) that can fail, and it is keyed
  // by the danger-model roster — so a member with no served label must still be named, by its id,
  // rather than dropping out of the clause or printing "undefined".
  it("falls back to the member id when no label was served for it", () => {
    expect(coverageLegendHtml([degrade()], {})).toContain("held by R6, 15d old");
    expect(coverageLegendHtml([degrade()], undefined)).toContain("held by R6, 15d old");
  });

  it("never reuses the feed-lag glyphs", () => {
    const html = coverageLegendHtml([degrade()]);
    expect(html).not.toContain("◌");
    expect(html).not.toContain("⌁");
  });
});
