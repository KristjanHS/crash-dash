import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MAX_UNIT_LINES,
  REFERENCE_PATH,
  SECTIONS,
  unjoinableReason,
  sectionRange,
  units,
} from "./reference-shape.js";

// The shape contract itself (sections, ceilings, unit parsing, the joiner) lives in
// `scripts/reference-shape.ts` — shared with `npm run fix:shape`, which `npm run check` runs first.

const ref = readFileSync(REFERENCE_PATH, "utf8");

function sectionLines(start: string): string[] {
  const lines = ref.split("\n");
  const range = sectionRange(lines, start);
  expect(range, `${start} heading missing from docs/reference.md`).not.toBeNull();
  return lines.slice(range!.s, range!.e);
}

describe("docs/reference.md shape", () => {
  it.each(SECTIONS)(`$start: every unit ≤ ${MAX_UNIT_LINES} lines, unit count ≤ $ceiling`, ({ start, ceiling }) => {
    const all = units(sectionLines(start));
    expect(all.length).toBeGreaterThan(0);
    expect(
      all.length,
      `${all.length} units over the ${ceiling} ceiling — the section GREW; never auto-trimmed, edit it`,
    ).toBeLessThanOrEqual(ceiling);
    const offenders = all
      .filter((u) => u.length > MAX_UNIT_LINES)
      .map((u) => {
        const reason = unjoinableReason(u);
        const cls = reason ? `UNJOINABLE (${reason} — edit by hand)` : "MECHANICAL";
        return `${cls} ${u.length} lines: ${u[0]}`;
      });
    expect(
      offenders,
      `units over ${MAX_UNIT_LINES} lines:\n${offenders.join("\n")}\n` +
        `MECHANICAL rows are fixed by: npm run fix:shape`,
    ).toEqual([]);
  });
});
