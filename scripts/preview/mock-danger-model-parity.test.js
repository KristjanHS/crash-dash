// Schema-parity guard for the preview mock's DANGER_MODEL block (2026-08-07 review finding 5).
// `npm run preview` renders /lab off this block, so a missing or stale knob makes the preview lie
// about the LIVE engine: `reriskDwellDays` was absent entirely (though `openapi.yaml` lists it in
// `DangerModel.required`) and `reriskConfirm: 2` drove the footer down the RETIRED-gate branch.
// Two independent claims, because either alone is satisfiable by a wrong block:
//   1. SHAPE — every `DangerModel.required` key is present (catches the omission class).
//   2. VALUE — the knobs that mirror a live constant equal that constant (catches the drift class;
//      today they ARE the imports, so this is a pin against a future re-hand-mirroring).
// Plain `.js` (like public/*.test.js and mock-gates-parity.test.js) so vitest collects it and tsc
// skips it; the openapi `required` list is parsed with the same dep-free line grab
// src/api/contract.test.ts uses.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { DANGER_MODEL } from "./mock-data.mjs";
import { CONC_THRESHOLD, CONC_WEIGHT, DANGER_CUTS, DERISK_DEADBAND, RERISK_DEADBAND } from "../../src/danger-engine.ts";
import { RERISK_CONFIRM, RERISK_DWELL_DAYS } from "../../src/danger-ladder.ts";

const OPENAPI = readFileSync(fileURLToPath(new URL("../../openapi.yaml", import.meta.url)), "utf8");

/** `required:` names of a `components.schemas.<name>` block. The list spans several lines, so the
 *  grab runs from `required: [` to the closing bracket. Throws when the schema is missing, so a
 *  renamed schema reds here rather than silently asserting over an empty set. */
function requiredOf(name) {
  const lines = OPENAPI.split("\n");
  const start = lines.indexOf(`    ${name}:`);
  if (start < 0) throw new Error(`openapi.yaml has no schema named ${name}`);
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {0,4}\S/.test(lines[i])) break;
    body.push(lines[i]);
  }
  const list = body.join("\n").match(/required:\s*\[([^\]]*)\]/s)?.[1];
  return list ? list.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

describe("preview mock — DANGER_MODEL matches the served contract", () => {
  it("carries every openapi DangerModel.required key", () => {
    const required = requiredOf("DangerModel");
    expect(required.length).toBeGreaterThan(10); // vacuity: a failed parse reads 0 and asserts nothing
    expect(required).toContain("reriskDwellDays"); // the key that was missing — pinned by name
    for (const key of required) {
      expect(Object.keys(DANGER_MODEL), `DANGER_MODEL is missing ${key}`).toContain(key);
    }
  });

  it("every mirrored knob equals the live engine constant", () => {
    expect(DANGER_MODEL.concThreshold).toBe(CONC_THRESHOLD);
    expect(DANGER_MODEL.concWeight).toBe(CONC_WEIGHT);
    expect(DANGER_MODEL.deriskDeadband).toBe(DERISK_DEADBAND);
    expect(DANGER_MODEL.reriskDeadband).toBe(RERISK_DEADBAND);
    expect(DANGER_MODEL.reriskConfirm).toBe(RERISK_CONFIRM);
    expect(DANGER_MODEL.reriskDwellDays).toBe(RERISK_DWELL_DAYS);
    expect(DANGER_MODEL.legRagCuts).toEqual({ amber: DANGER_CUTS.amber, red: DANGER_CUTS.red });
  });
});
