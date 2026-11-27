/**
 * `public/family-lag.js` — the families-board feed-lag roll-up.
 *
 * The load-bearing case is the DISCRIMINATING one (`§the live EU2 case` below): the family whose
 * `verdictHoldIds` is `[]` and `coverageDegraded` is `false` on the very day one of its feeds has been
 * dark for nine days. That is the case the existing coverage fields cannot see and the reason this
 * seam exists — if only that test were kept, it would still be worth keeping.
 *
 * The second load-bearing case is the PARTITION (`§nothing vanishes`): the USER ruling is that no
 * dark feed may vanish from the board, and a guarantee stated only in prose is not a guarantee.
 *
 * The third is the UNION PARSE (`§tierOf mirrors the server ladder`): the FE tier table is a
 * re-encoding of `lagTier`, and the drift that actually bites is an ADDED label — the server serves
 * it, the FE does not recognize it. Driving the parity cases off the union parsed out of
 * `src/feed-lag.ts` is what makes that addition red the FE suite instead of silently dropping a feed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { familyLagMark, familyLagMarks, tierOf } from "./family-lag.js";
import { lagTier } from "../src/feed-lag.ts";

/**
 * The `Label` union, PARSED OUT OF SOURCE. `lagTier` is importable but `Label` is a TS type with no
 * runtime handle, so the only way to drive parity over the WHOLE union — rather than over a list
 * hand-copied at authoring time — is to read `src/feed-lag.ts` as text. A hand-copied `it.each`
 * stayed green when a 7th label was added: the server served it, `tierOf` returned `null`, and the
 * FE dropped the feed off the board.
 */
const FEED_LAG_SRC = readFileSync(
  fileURLToPath(new URL("../src/feed-lag.ts", import.meta.url)),
  "utf8",
);
const LABEL_UNION = (() => {
  const decl = /export type Label\s*=([^;]+);/.exec(FEED_LAG_SRC);
  if (!decl) throw new Error("could not find `export type Label = …` in src/feed-lag.ts");
  return [...decl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
})();

/** The live prod entry: SovCISS FR, dark for 9 days against a 6d deep-lag bar. */
const EU2 = { id: "EU2", label: "DEEP-LAG", age: 9, p90Gap: 3, deepLagBar: 6, lagCut: 2, registered: "daily" };
const F1_LATE = { id: "F1", label: "LAG", age: 4, p90Gap: 2, deepLagBar: 6, lagCut: 2, registered: "daily" };
/** A `?s=lag:<id>` knob-forced entry: the knob ASSERTS a classification, it measures nothing. */
const KNOB = { id: "F2", label: "LAG", age: null, p90Gap: null, deepLagBar: null, lagCut: null, registered: "daily" };

const credit = (extra = {}) => ({
  key: "credit",
  members: [
    { id: "F1", label: "HY OAS", state: "AMBER" },
    { id: "F2", label: "EBP", state: "AMBER" },
    { id: "EU2", label: "SovCISS FR", state: "GREEN" },
  ],
  ...extra,
});
const labels = { EU2: "SovCISS FR", F1: "HY OAS", F2: "EBP", F7: "CAPE" };

describe("tierOf mirrors the server ladder", () => {
  // The re-encoded table exists only because a browser ESM module cannot import a `.ts` source.
  // Pinning it against the REAL `lagTier` across the whole `Label` union — DERIVED from the source
  // text, never hand-listed — is what keeps it from becoming a second source of truth: ADD a member
  // to `Label` and this describe grows a case that reds, rather than drifting silently.

  // Non-vacuity: a regex that matched nothing (or only the first alternative) would make `it.each`
  // pass for any table at all. The union has had 6 members since it was written, so a parse below
  // that floor is a broken parse, not a shrunken union.
  it("parsed the whole Label union out of src/feed-lag.ts", () => {
    expect(LABEL_UNION.length).toBeGreaterThanOrEqual(6);
    // …and the parse must yield real labels the server ladder knows, not arbitrary strings: every
    // tier-bearing arm of `lagTier` has to be reachable from what we parsed.
    expect(LABEL_UNION.map((l) => lagTier(l))).toContain("deep");
    expect(LABEL_UNION.map((l) => lagTier(l))).toContain("soft");
  });

  it.each(LABEL_UNION)("agrees with lagTier(%s)", (label) => {
    expect(tierOf(label)).toBe(lagTier(label));
  });

  it("treats an unknown label as not-a-mark rather than guessing a tier", () => {
    expect(tierOf("SOMETHING-NEW")).toBeNull();
    expect(tierOf(undefined)).toBeNull();
  });
});

describe("familyLagMark", () => {
  it("fires for the live EU2-in-credit case", () => {
    const m = familyLagMark(["F1", "F2", "EU2"], [EU2], labels);
    expect(m).not.toBeNull();
    expect(m.cls).toBe("sig-lag-deep");
    expect(m.count).toBe(1);
    expect(m.html).toContain("⌁");
    expect(m.html).toContain("SovCISS FR");
  });

  it("returns null for a clean family - an empty slot, never a ⌁⁰", () => {
    expect(familyLagMark(["F1", "F2"], [], labels)).toBeNull();
    // A marked feed belonging to a DIFFERENT family must not leak into this one.
    expect(familyLagMark(["F1", "F2"], [EU2], labels)).toBeNull();
  });

  it("takes the worst tier - one rot beats any number of lates", () => {
    expect(familyLagMark(["F1", "EU2"], [F1_LATE, EU2], labels).cls).toBe("sig-lag-deep");
    expect(familyLagMark(["F1"], [F1_LATE], labels).cls).toBe("sig-lag-soft");
  });

  it("counts marked MEMBERS, not families", () => {
    const m = familyLagMark(["F1", "F2", "EU2"], [F1_LATE, KNOB, EU2], labels);
    expect(m.count).toBe(3);
    expect(m.html).toContain(">3</sup>");
  });

  it("renders a knob-forced all-null entry as ONE -, never 0d", () => {
    const m = familyLagMark(["F2"], [KNOB], labels);
    expect(m.which).toBe("F2 EBP · LAG · -");
    expect(m.html).not.toContain("0d");
    expect(m.html).not.toContain("deep-lag bar -");
    expect(m.html).not.toContain("vs lag cut");
  });

  it("still prints the measured axes when only SOME are null", () => {
    const partial = { ...EU2, deepLagBar: null, lagCut: 2 };
    expect(familyLagMark(["EU2"], [partial], labels).which).toContain("9d vs lag cut 2d · deep-lag bar -");
  });

  it("pairs the id with its label rather than rendering a bare registry key", () => {
    // Rule 2 (`prose-names.test.ts`) — and a label that already restates the id collapses to one.
    expect(familyLagMark(["EU2"], [EU2], labels).which).toContain("EU2 SovCISS FR");
    expect(familyLagMark(["EU2"], [EU2], { EU2: "EU2" }).which).toContain("EU2 ·");
  });

  it("degrades to null on a short or missing read, never to a mark", () => {
    expect(familyLagMark(["EU2"], undefined, labels)).toBeNull();
    expect(familyLagMark(undefined, [EU2], labels)).toBeNull();
    expect(familyLagMark(["EU2"], [EU2], undefined)).not.toBeNull(); // labels are optional
  });

  it("MARKS AT THE QUIET TIER a note whose label this FE table does not recognize, rather than dropping it", () => {
    // `api/lab.ts` serves only notes it classified as marked, so a label `tierOf` does not know means
    // the FE MIRROR drifted — and dropping it is what makes a feed vanish from the board on the exact
    // path built to guarantee it cannot. The quiet tier, not the heavier one: we do not know the
    // tier, so we do not claim one.
    const drifted = familyLagMark(["F1"], [{ ...F1_LATE, label: "STALLED" }], labels);
    expect(drifted).not.toBeNull();
    expect(drifted.cls).toBe("sig-lag-soft");
    expect(drifted.ids).toEqual(["F1"]);
    // FRESH is the same case — the server should never have served it, and silently dropping a
    // served entry is the defect, not the fix.
    expect(familyLagMark(["F1"], [{ ...F1_LATE, label: "FRESH" }], labels)).not.toBeNull();
  });
});

describe("familyLagMarks - the live EU2 case", () => {
  it("fires even though verdictHoldIds is [] and coverageDegraded is false", () => {
    // THE discriminating case. `verdictHoldIds` fires only for a stale member that IS the family's
    // worst state — one holding the verdict up. EU2 is GREEN while `credit` is AMBER, so on the very
    // day the ECB feed had been dark nine days both coverage fields read clean. This mark does not.
    const { byFamily, orphans } = familyLagMarks([credit()], [EU2], labels);
    expect(byFamily.get("credit").cls).toBe("sig-lag-deep");
    expect(orphans).toBeNull();
  });
});

describe("familyLagMarks - nothing vanishes", () => {
  it("joins the family's DARK roster (absentIds), not only its served members", () => {
    // A feed dark enough to drop out of `members` entirely is exactly the case a roster-only join
    // would lose. `absentIds` is already on the wire, so this level costs no wire change.
    const dark = { key: "credit", members: [{ id: "F1", label: "HY OAS" }], absentIds: ["EU2"] };
    const { byFamily, orphans } = familyLagMarks([dark], [EU2], labels);
    expect(byFamily.get("credit").cls).toBe("sig-lag-deep");
    expect(orphans).toBeNull();
  });

  it("routes a feed on NO family roster to orphans - the F7/CAPE case", () => {
    // `valuation`'s FamilyDef.ids is [] (the feedless CAPE stub), so a dark F7 is in no family's
    // members AND no family's absentIds. This is the motivating orphan, not a defensive hypothetical.
    const f7 = { id: "F7", label: "DEEP-LAG", age: 12, p90Gap: 4, deepLagBar: 8, lagCut: 2, registered: "monthly" };
    const valuation = { key: "valuation", members: [], absentIds: [] };
    const { byFamily, orphans } = familyLagMarks([credit(), valuation], [f7], labels);
    expect(byFamily.size).toBe(0);
    expect(orphans).not.toBeNull();
    expect(orphans.cls).toBe("sig-lag-deep");
    expect(orphans.which).toContain("CAPE");
  });

  it("keeps a note whose label the FE table does not recognize - quiet tier, never dropped", () => {
    // The label leak, at the BOARD level: a 7th server label the FE mirror has not learned yet must
    // still reach a mark. Both halves matter — the on-roster id must land in `byFamily` and the
    // off-roster one in `orphans`; dropping either is a feed vanishing off the board.
    const drifted = { id: "EU2", label: "STALLED", age: 9, p90Gap: 3, deepLagBar: 6, lagCut: 2, registered: "daily" };
    const strayDrift = { ...drifted, id: "F7" };
    const { byFamily, orphans } = familyLagMarks([credit()], [drifted, strayDrift], labels);
    expect(byFamily.get("credit").cls).toBe("sig-lag-soft");
    expect(byFamily.get("credit").ids).toEqual(["EU2"]);
    expect(orphans).not.toBeNull();
    expect(orphans.ids).toEqual(["F7"]);
  });

  it("PARTITION: every marked id lands in exactly one of (per-family marks ∪ orphans)", () => {
    // The falsifier for the USER ruling. Without it "nothing vanishes" is prose. `eu` deliberately
    // SHARES `EU2` with `credit` so the double-marking rule is exercised: an id on two rosters marks
    // both while counting as matched exactly once, which is why `orphans` comes off the matched SET
    // and not off a count subtraction (see `familyLagMarks`' docblock).
    const families = [
      credit(),
      { key: "eu", members: [{ id: "EU2", label: "SovCISS FR" }], absentIds: [] },
      { key: "valuation", members: [], absentIds: [] },
    ];
    const pool = ["F1", "F2", "EU2", "F7", "GHOST", "F13"];
    const eu2Marked = [];
    for (let mask = 1; mask < 1 << pool.length; mask++) {
      const feedLag = pool
        .filter((_, i) => mask & (1 << i))
        .map((id, i) => ({ id, label: i % 2 ? "DEEP-LAG" : "LAG", age: 5, p90Gap: 2, deepLagBar: 4, lagCut: 2, registered: "daily" }));
      const { byFamily, orphans } = familyLagMarks(families, feedLag, labels);
      const marks = [...byFamily.values(), ...(orphans ? [orphans] : [])];
      const seen = new Set();
      for (const m of marks) for (const id of m.ids) seen.add(id);
      expect([...seen].sort()).toEqual(feedLag.map((n) => n.id).sort());
      if (feedLag.some((n) => n.id === "EU2")) eu2Marked.push({ byFamily, orphans });
      // …and `ids` may not claim coverage the RENDERED mark lacks: every id it names must have
      // reached the html the user actually sees. (No label here restates its own id, so each
      // survives `idIfDistinct` — the assertion is not vacuous.)
      for (const m of marks) for (const id of m.ids) expect(m.html).toContain(id);
    }
    // DOUBLE-MARKING: `EU2` is on both rosters, so whenever it is marked BOTH families carry it —
    // under-marking would be dishonest, and it must not become an orphan either.
    expect(eu2Marked.length).toBeGreaterThan(0);
    for (const { byFamily, orphans } of eu2Marked) {
      expect(byFamily.get("credit").ids).toContain("EU2");
      expect(byFamily.get("eu").ids).toEqual(["EU2"]);
      expect(orphans ? orphans.ids : []).not.toContain("EU2");
    }
  });

  it("orphans is null when every marked feed found a family - the steady state", () => {
    expect(familyLagMarks([credit()], [F1_LATE], labels).orphans).toBeNull();
    expect(familyLagMarks([credit()], [], labels).orphans).toBeNull();
  });

  it("degrades to empty on a missing read rather than fabricating a mark", () => {
    expect(familyLagMarks(undefined, undefined, labels)).toEqual({
      byFamily: new Map(),
      orphans: null,
    });
  });
});
