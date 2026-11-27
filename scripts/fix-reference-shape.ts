/**
 * `npm run fix:shape` — joins over-long units in `docs/reference.md` back to one line. Run first by
 * `npm run check`, so the MECHANICAL half of the shape gate never blocks. Always exits 0: the blocking
 * verdict (ceilings, and any unit too structural to join) belongs to `scripts/reference-shape.test.ts`.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { REFERENCE_PATH, joinOverlongUnits } from "./reference-shape.js";

const before = readFileSync(REFERENCE_PATH, "utf8");
const { text, joined, unjoinable } = joinOverlongUnits(before);

if (text !== before) writeFileSync(REFERENCE_PATH, text);

for (const u of joined) console.log(`joined ${u.lines} lines -> 1  ${u.section}  ${u.head.slice(0, 70)}`);
for (const u of unjoinable) {
  console.log(
    `UNJOINABLE ${u.lines} lines (${u.reason}) ${u.section}  ${u.head.slice(0, 70)}`,
  );
}
console.log(
  joined.length || unjoinable.length
    ? `fix:shape — joined ${joined.length}, left ${unjoinable.length} for the gate`
    : "fix:shape — no over-long units",
);
