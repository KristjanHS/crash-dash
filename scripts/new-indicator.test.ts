/**
 * Tests for the `new-indicator` scaffold generator's PURE seam (Stage 6.3).
 *
 * Zero writes into `src/`: every assertion goes through `parseArgs`/`renderRegistryEntry`/
 * `renderFamilyAssignment`/`insertAtAnchor`/`renderChecklist`, and the round-trip test reads the
 * REAL `src/registry-fred.ts` as a string (never a fixture copy — a copy drifts, `testing-project.md`) and
 * transforms it in memory.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  FAMILY_ANCHOR,
  KNOWN_FAMILIES,
  REGISTRY_ANCHOR,
  insertAtAnchor,
  parseArgs,
  renderChecklist,
  renderFamilyAssignment,
  renderRegistryEntry,
  writesRegistry,
  type IndicatorSpec,
} from "./new-indicator.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A fixed, valid spec — the id is deliberately absent from the registry/census. */
const ARGV = [
  "--id=ZZTEST",
  "--label=ZZ test",
  "--long-label=ZZ scaffold probe",
  "--series=ZZSERIES",
  "--channel=FIN",
  "--family=fred-level-velocity",
  "--unit=pp",
  "--amber-level=3",
  "--red-level=3.2",
];
const spec: IndicatorSpec = parseArgs(ARGV);

describe("renderRegistryEntry", () => {
  test("emits the Indicator literal at the INDICATORS indent, trailing comma", () => {
    expect(renderRegistryEntry(spec)).toBe(
      [
        "  {",
        '    id: "ZZTEST",',
        '    label: "ZZ test",',
        '    longLabel: "ZZ scaffold probe",',
        '    series: "ZZSERIES",',
        '    channel: "FIN",',
        "    thresholds: { amberLevel: 3, redLevel: 3.2 },",
        '    unit: "pp",',
        "  },",
      ].join("\n"),
    );
  });
});

describe("renderFamilyAssignment", () => {
  test("emits the FAMILY_OF row for an id the census does not carry", () => {
    expect(renderFamilyAssignment(spec)).toBe('  ZZTEST: "fred-level-velocity",');
  });
});

describe("insertAtAnchor over the real registry", () => {
  test("lands the entry exactly once, immediately above the anchor line", () => {
    const source = readFileSync(join(REPO_ROOT, "src", "registry-fred.ts"), "utf8");
    const entry = renderRegistryEntry(spec);
    const out = insertAtAnchor(source, REGISTRY_ANCHOR, entry);

    expect(out.split(entry).length - 1).toBe(1); // exactly one occurrence
    const lines = out.split("\n");
    const anchorAt = lines.findIndex((l) => l.includes(REGISTRY_ANCHOR));
    const entryLines = entry.split("\n");
    expect(lines.slice(anchorAt - entryLines.length, anchorAt)).toEqual(entryLines);
  });

  test("the family-descriptor anchor is present exactly once too", () => {
    const source = readFileSync(join(REPO_ROOT, "src", "family-descriptor-rows.ts"), "utf8");
    const row = renderFamilyAssignment(spec) as string;
    const lines = insertAtAnchor(source, FAMILY_ANCHOR, row).split("\n");
    const anchorAt = lines.findIndex((l) => l.includes(FAMILY_ANCHOR));
    expect(lines[anchorAt - 1]).toBe(row);
  });

  test("throws when the anchor is missing", () => {
    expect(() => insertAtAnchor("a\nb\n", REGISTRY_ANCHOR, "x")).toThrow(/anchor not found/);
  });

  test("throws when the anchor is duplicated (a second 'helpful' marker)", () => {
    const dup = `a\n// ${REGISTRY_ANCHOR}\nb\n// ${REGISTRY_ANCHOR}\n`;
    expect(() => insertAtAnchor(dup, REGISTRY_ANCHOR, "x")).toThrow(/appears 2 times/);
  });
});

describe("parseArgs rejections name the offending flag", () => {
  const withArg = (replace: string, value: string): string[] => [
    ...ARGV.filter((a) => !a.startsWith(`--${replace}=`)),
    `--${replace}=${value}`,
  ];

  test("duplicate id", () => {
    expect(() => parseArgs(withArg("id", "F1"))).toThrow(/--id: duplicate id "F1"/);
  });

  test("unknown family", () => {
    expect(() => parseArgs(withArg("family", "fred-levl-velocity"))).toThrow(
      /--family: unknown family "fred-levl-velocity"/,
    );
  });

  test("unknown channel", () => {
    expect(() => parseArgs(withArg("channel", "FINN"))).toThrow(/--channel: unknown channel "FINN"/);
  });

  test("a scored fred-level-velocity spec with no threshold pair", () => {
    const bare = ARGV.filter((a) => !a.startsWith("--amber-level=") && !a.startsWith("--red-level="));
    expect(() => parseArgs(bare)).toThrow(
      /--amber-level\/--red-level: family "fred-level-velocity" needs a level or velocity pair/,
    );
  });
});

describe("renderChecklist", () => {
  // Review finding 1 (2026-07-25): the INDICATORS-END anchor sits in the array run-cycle-fred.ts
  // FRED-fetches per entry, so auto-write is only correct for fred-level-velocity. A non-FRED
  // family written there makes the cron fetch a series that never resolves.
  test("only fred-level-velocity may be auto-written into INDICATORS", () => {
    expect(writesRegistry(spec)).toBe(true);
    for (const family of [...KNOWN_FAMILIES].filter((f) => f !== "fred-level-velocity"))
      expect(
        writesRegistry({ ...spec, family: family as (typeof spec)["family"] }),
        `${family} must not auto-write`,
      ).toBe(false);
  });

  test("a non-auto-write family's checklist says the entry was SKIPPED and must be placed by hand", () => {
    const out = renderChecklist({ ...spec, family: "price-derived" });
    expect(out).toContain("[SKIPPED] src/registry-fred.ts");
    expect(out).toContain("PLACE THE ENTRY ABOVE BY HAND");
    expect(out).toContain("ALL_INDICATORS");
    // ...and the FRED branch must NOT claim the write happened.
    expect(out).not.toContain("[done] src/registry-fred.ts");
  });
});
