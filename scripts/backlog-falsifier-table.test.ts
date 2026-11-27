/**
 * `scripts/backlog-falsifier-table.mjs`: the `extract`
 * section gate (§OWED[USER] / Plan-doc menu skipped, trailing sections kept) and `classify`, on a fixture.
 */
import { describe, it, expect } from "vitest";

// @ts-expect-error — ESM script without a .d.ts; the surface is two functions + a list
import { classify, extract } from "./backlog-falsifier-table.mjs";

const FIXTURE = `# Backlog

## Open

⚠ item A · seam · falsifier: \`grep -c foo src/x.ts\` is 0
⚠ item B · seam · falsifier: \`npm run probe:x -- --dry\` shows 3
- item C · seam · falsifier: \`curl -s https://example.test/api\` returns 200
⚠ item D · seam · falsifier: sign in and eyeball the card
⚠ item E without a clause
~~⚠ item F struck~~
  ⚠ CLOSED — continuation line

## 2026-08-08 — dated sub-section
⚠ item G · falsifier: \`git log -S foo\` finds a commit

## §OWED[USER] — open decisions only
- decision X

## Plan-doc menu — armable work
- **Plan** → archive/x.md

## trailing section
⚠ item H · falsifier per slice: \`ls scripts/\` lists it
`;

describe("backlog-falsifier-table extract (fixture)", () => {
  const rows = extract(FIXTURE);
  it("keeps §Open, dated sub-sections and trailing sections; skips §OWED[USER] and the plan menu", () => {
    expect(rows.map((r: { text: string }) => r.text.slice(0, 8))).toEqual([
      "⚠ item A", "⚠ item B", "- item C", "⚠ item D", "⚠ item E", "⚠ item G", "⚠ item H",
    ]);
    expect(rows.some((r: { text: string }) => /decision X|\*\*Plan\*\*|struck|CLOSED/.test(r.text))).toBe(false);
  });
  it("classifies first-match on the falsifier text", () => {
    expect(rows.map((r: { class: string }) => r.class)).toEqual([
      "grep", "npm-probe", "prod-curl", "other", "none", "grep", "grep",
    ]);
    expect(rows[6].falsifier).toBe("`ls scripts/` lists it");
  });
  it("classify: npm-probe wins over grep, prod-curl over grep", () => {
    expect(classify("`npm run probe:x` then `grep` it")).toBe("npm-probe");
    expect(classify("`curl` the URL then `wc -l`")).toBe("prod-curl");
    expect(classify(null)).toBe("none");
  });
});
