import { describe, expect, it } from "vitest";
import { isChurnHunk } from "./probe-test-churn.js";

describe("isChurnHunk", () => {
  it("qualifies a pure numeric toBe bump", () => {
    expect(isChurnHunk([
      '-    expect(checked, "assertions made").toBe(46);',
      '+    expect(checked, "assertions made").toBe(48);',
    ])).toBe(true);
  });

  it("qualifies a comment-only hunk", () => {
    expect(isChurnHunk(["-    // 23 overlay ids × 2 surfaces", "+    // 24 overlay ids × 2 surfaces", "+    /* new note */"])).toBe(true);
  });

  it("rejects a real assertion change", () => {
    expect(isChurnHunk([
      "-    expect(rows).toHaveLength(3);",
      "+    expect(cols).toHaveLength(4);",
    ])).toBe(false);
  });
});
