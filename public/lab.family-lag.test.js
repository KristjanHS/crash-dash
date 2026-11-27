/**
 * The `/lab` FAMILIES-BOARD feed-lag mark, wired into the `#tiles` board.
 *
 * `lab.js` has two paint paths (`buildTiles` once at build, the `applyBoard` tile loop on every poll),
 * and the refresh path rewrites only `.dot`/`.st`/`.t-diff`/`.ids` by hand. A mark emitted only in
 * `buildTiles` therefore freezes at its build-time vintage — it keeps claiming a feed is behind after
 * the feed caught up. This pins ONE producer called from BOTH paths:
 *
 *  · the producer is pure over the same `marks` — a second render returns the identical markup
 *    (`lab.js` executes DOM/`localStorage` side effects at import and can never be imported from a
 *    test, per `.claude/rules/frontend.md`, so it runs against the smallest pure extract);
 *  · BOTH paint paths in `lab.js` really call that producer — a source-level check, because the pure
 *    double render alone would stay green with the refresh call deleted;
 *  · the residual (`orphans`) has a board-header host and is painted every `applyBoard` — no dark feed
 *    may vanish from the board.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { familyLagMarks, familyLagSlotHtml, orphanLagSlotHtml } from "./family-lag.js";
import { HELP_TAP_PRIORITY_SELECTOR } from "./help-decorate.js";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

/** EU2 / SovCISS FR dark 9 days, seated on `credit`. */
const EU2 = { id: "EU2", label: "DEEP-LAG", age: 9, p90Gap: 3, deepLagBar: 6, lagCut: 2, registered: "daily" };
/** The motivating ORPHAN: F7/CAPE is a real persisted series whose family stub has no ids. */
const F7 = { id: "F7", label: "LAG", age: 4, p90Gap: 1, deepLagBar: 9, lagCut: 2, registered: "monthly" };

const FAMILIES = [
  { key: "credit", members: [{ id: "F1" }, { id: "EU2" }], absentIds: [] },
  { key: "valuation", members: [], absentIds: [] },
];
const LABELS = { EU2: "SovCISS FR", F7: "CAPE" };

/** Strip comments before any source-level assertion: this file's own prose names the symbols it
 *  guards, and a raw-text match would count a MENTION as a call — leaving the check unable to fail
 *  for exactly the wiring it exists to pin (the `coverage-marks.test.js` comment-stripping rule). */
const decomment = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// The applyBoard refresh path moved into the families-board.js seam (2026-09-05 P11);
// the board-head/tile-loop pins below scan it there.
const LAB = decomment(readFileSync(here("./families-board.js"), "utf8"));
const BOARD = decomment(readFileSync(here("./lab-board.js"), "utf8"));

/** A top-level function body, sliced from its `function name(` header to the next top-level
 *  `function` — brace counting would have to survive template literals and regex literals in a
 *  2800-line file, and this file only needs the two paint paths. */
function bodyOf(name, src = BOARD) {
  const m = src.match(new RegExp(`\\n(?:export )?function ${name}\\(`));
  expect(m, `${name} is a top-level function in its file`).toBeTruthy();
  const rest = src.slice(m.index + 1);
  const end = rest.search(/\n(?:export )?function /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("familyLagSlotHtml / orphanLagSlotHtml - the producer both paint paths call", () => {
  it("renders the family's mark, and the SAME markup on a second render", () => {
    const marks = familyLagMarks(FAMILIES, [EU2], LABELS);
    const first = familyLagSlotHtml(marks, "credit");
    const second = familyLagSlotHtml(marks, "credit");

    expect(first).toContain("fam-lag");
    expect(first).toContain("sig-lag-deep");
    expect(first).toContain("SovCISS FR");
    // The refresh path re-renders from the same marks: the mark must SURVIVE the second render
    // byte-for-byte, never be consumed by the first (the plan's first-listed risk, at the seam).
    expect(second).toBe(first);
    expect(marks.byFamily.size).toBe(1);
  });

  it("renders NOTHING for a family that fired nothing - an empty slot, never a ⌁⁰", () => {
    const marks = familyLagMarks(FAMILIES, [EU2], LABELS);
    expect(familyLagSlotHtml(marks, "valuation")).toBe("");
    expect(familyLagSlotHtml(marks, "no-such-family")).toBe("");
    // Degraded reads (no marks resolved yet, a payload without feedLag) paint nothing, not a throw.
    expect(familyLagSlotHtml(undefined, "credit")).toBe("");
    expect(familyLagSlotHtml({}, "credit")).toBe("");
    expect(familyLagSlotHtml(familyLagMarks(FAMILIES, [], LABELS), "credit")).toBe("");
  });

  it("renders the residual for a marked feed on no roster, idempotently", () => {
    const marks = familyLagMarks(FAMILIES, [EU2, F7], LABELS);
    const first = orphanLagSlotHtml(marks);
    expect(first).toContain("fam-lag");
    expect(first).toContain("CAPE");
    expect(orphanLagSlotHtml(marks)).toBe(first);
    // …and nothing when every marked id found a family (the expected steady state).
    expect(orphanLagSlotHtml(familyLagMarks(FAMILIES, [EU2], LABELS))).toBe("");
    expect(orphanLagSlotHtml(undefined)).toBe("");
  });
});

describe("families-board.js + lab-board.js wire the producer into BOTH paint paths", () => {
  const build = bodyOf("buildTiles");
  const refresh = bodyOf("renderFamiliesBoard", LAB);

  // Non-vacuity for the slicer itself: `legStripHtml` is the file's OWN precedent for a producer
  // called from both paint paths, so both slices must contain it. If a slice were empty or
  // mis-anchored, this fails before the assertions below can false-pass.
  it("the slices really are the two paint paths", () => {
    expect(build).toContain("legStripHtml(");
    expect(refresh).toContain("legStripHtml(");
    expect(build).not.toContain("function renderFamiliesBoard");
    expect(refresh).not.toContain("function buildTiles");
  });

  it("buildTiles emits the tile-header slot through the producer", () => {
    expect(build).toContain('class="t-lag"');
    expect(build).toContain("familyLagSlotHtml(");
  });

  // THE trap: without this call the mark paints once and then freezes at its build-time vintage.
  it("the renderFamiliesBoard tile loop re-renders the slot through the SAME producer", () => {
    expect(refresh).toContain('querySelector(".t-lag")');
    expect(refresh).toContain("familyLagSlotHtml(");
  });

  it("renderFamiliesBoard paints the residual into a board-header host", () => {
    expect(refresh).toContain("orphanLagSlotHtml(");
    expect(refresh).toContain('$("#boardLag")');
    // The host is in the once-built skeleton, inside the board head.
    expect(LAB).toContain('id="boardLag"');
  });

  // The mark itself carries no copy — WHICH feed is behind lives only in its `title`, so both hosts
  // must be tap-readable BY SELECTOR MEMBERSHIP (/lab is tap-first; no glyphs). The routing choice
  // `write-seam.test.js`'s lint cannot see: the tile form needs stopPropagation, the residual not.
  it("routes the tile mark help-priority", () => {
    // A pass-through `.tile .fam-lag` tap would ALSO cycle the tile in Scenario mode — that branch
    // deliberately skips stopPropagation, so only HELP_TAP_PRIORITY_SELECTOR may carry the tile form.
    expect(HELP_TAP_PRIORITY_SELECTOR.split(", ")).toContain(".tile .fam-lag[title]");
  });

  it("both paths derive the join from the ONE famLagMarks helper (one read, one truth)", () => {
    expect(build).toContain("famLagMarks(d)");
    expect(refresh).toContain("famLagMarks(d)");
    // …which names feeds off the SAME map the ledger footnote uses, so the two surfaces cannot
    // print different names for one feed.
    expect(bodyOf("famLagMarks")).toContain("dangerModel.memberLabel");
    expect(bodyOf("feedLagFoot")).toContain("dangerModel.memberLabel");
  });
});
