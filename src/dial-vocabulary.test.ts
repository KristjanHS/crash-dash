/**
 * R5 ([USER] 2026-07-26 + round-2 2026-07-31) — the dial says PRIMED, `/exposure` says ARMED.
 *
 * `armed` means two unrelated things on two adjacent surfaces: on `/exposure` it is *credit is
 * stressed* (the ARM key), on the `/lab` dial it was *the leading channel is firing*. The ruling
 * renames the DIAL side to `primed` in rendered strings and leaves every IDENTIFIER alone —
 * `dialState.armed`, `ARMED_UNFIRED_CAP`, `UNARMED_CAP`, the wire field and the persisted
 * `dial_state` rows all keep the old spelling.
 *
 * Pinned here: every string literal in `DIAL_SIDE_FILES` (comments are not scanned), the headline
 * the producer writes, and the read-time restatement of a headline persisted before the rename.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeT1Dial, hydrateOrComputeT1Dial } from "./t1dial.js";
import type { FamilyPanel } from "./families.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The dial-side production surface whose string literals reach the `/lab` screen. */
const DIAL_SIDE_FILES = [
  "src/t1dial.ts",
  "src/alert-band.ts",
  "src/dial-assembly.ts",
  "src/cash-overlay.ts",
  "src/families.ts",
  "api/lab.ts",
  "public/lab.js",
  "public/lab-board.js",
  "public/lab-reader.js",
  "public/lab-chips.js",
  "public/dial-headline.js",
  "public/band-panel.js",
  "public/sub-dangers.js",
] as const;

/** The forbidden word on this axis, in any case, with or without the `un` prefix. */
const FORBIDDEN = /\b(un)?armed\b/i;

type Hit = { line: number; text: string };

/**
 * String-literal bodies per line; comment bodies are skipped. Line-scoped: a stray quote cannot blind
 * the rest of the file. `${…}` bodies are CODE, so the `armed` identifier inside one is not a hit.
 */
function stringLiterals(src: string): Hit[] {
  const strings: Hit[] = [];
  let inBlock = false;
  src.split("\n").forEach((line, idx) => {
    let str = "";
    let i = 0;
    let state: "code" | "dq" | "sq" | "tpl" = "code";
    while (i < line.length) {
      const c = line[i];
      const c2 = line.slice(i, i + 2);
      if (inBlock) {
        if (c2 === "*/") {
          inBlock = false;
          i += 2;
        } else i += 1;
        continue;
      }
      if (state === "code") {
        if (c2 === "//") break;
        if (c2 === "/*") {
          inBlock = true;
          i += 2;
          continue;
        }
        if (c === '"') state = "dq";
        else if (c === "'") state = "sq";
        else if (c === "`") state = "tpl";
        i += 1;
        continue;
      }
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (state === "tpl" && c2 === "${") {
        state = "code";
        i += 2;
        continue;
      }
      if ((state === "dq" && c === '"') || (state === "sq" && c === "'") || (state === "tpl" && c === "`")) {
        state = "code";
        i += 1;
        continue;
      }
      str += c;
      i += 1;
    }
    if (str.trim()) strings.push({ line: idx + 1, text: str });
  });
  return strings;
}

/** R5 violations in one file's rendered strings; the sim-oracle key `armed-unfired-cap` is protected. */
function violations(src: string): Hit[] {
  return stringLiterals(src).filter((h) => FORBIDDEN.test(h.text.replace(/\barmed-unfired-cap\b/g, " ")));
}

const SOURCES = DIAL_SIDE_FILES.map((f) => ({ file: f, src: readFileSync(ROOT + f, "utf8") }));

describe("R5 - the dial's on-screen strings say `primed`, never `armed`", () => {
  it("every scanned file exists and yields string literals the checker can read", () => {
    for (const { file, src } of SOURCES) {
      expect(stringLiterals(src).length, `${file} yielded no string literals - the scanner is blind`).toBeGreaterThan(0);
    }
  });

  it("every DIAL_SIDE_FILES string says primed, not armed (collecting — a red lists every file:line)", () => {
    const hits = SOURCES.flatMap(({ file, src }) => violations(src).map((h) => `${file}:${h.line}: ${h.text.trim()}`));
    expect(hits).toEqual([]);
  });

  it("scans a synthetic file - the checker CAN fail, and skips comments + protected symbols", () => {
    const fixture = [
      "// the leading channel is armed but unfired", // comment: not scanned
      "const label = `armed (${familyList(x)})`;", // VIOLATION (rendered string)
      '  key: "armed-unfired-cap",', // protected (sim-oracle key)
      "  const armed = leadingFiring > 0;", // protected (identifier)
      "  if (!armed) rung = Math.min(rung, UNARMED_CAP);", // protected (identifier + constant)
      "  const headline = `${armed ? `primed (x)` : \"unprimed\"} + `;", // clean
      "  /* armed */ const s = 'unarmed';", // VIOLATION (string after a block comment)
    ].join("\n");
    expect(violations(fixture).map((h) => h.line)).toEqual([2, 7]);
  });
});

describe("R5 - the dial's served word is `primed`, never `armed`", () => {
  const panel = (key: string, state: "GREEN" | "AMBER" | "RED"): FamilyPanel =>
    ({
      key,
      label: key,
      state,
      live: true,
      firing: state !== "GREEN",
      members: [],
      contribution: state === "RED" ? 1 : state === "AMBER" ? 0.5 : 0,
    }) as unknown as FamilyPanel;

  // The READ path, which the producer confirmer below cannot see (review finding, 2026-07-31):
  // `/lab` serves the headline PERSISTED in `alert_log.dial_state`, so the live row and every
  // historical row would keep painting the pre-R5 word until the next cron write without a
  // read-time restatement. Fixture = a real dial with a legacy-vocabulary headline swapped in,
  // i.e. exactly what a row written by the previous deploy carries.
  it("the READ path restates a PERSISTED headline - a stored row renders primed", () => {
    const fresh = computeT1Dial([
      panel("credit", "GREEN"),
      panel("rates", "RED"),
      panel("volatility", "GREEN"),
      panel("cross-asset", "GREEN"),
      panel("trend", "GREEN"),
    ]);
    const stored = { ...fresh, headline: "armed (rates) + unfired → Caution, rung 3" };
    const hydrated = hydrateOrComputeT1Dial(stored, []);
    expect(hydrated.headline).toBe("primed (rates) + unfired → Caution, rung 3");
    expect(FORBIDDEN.test(hydrated.headline)).toBe(false);
    // The FIELD keeps its name (the ruling's protected half) and nothing else is rewritten.
    expect(hydrated.armed).toBe(true);
    expect(hydrated.targetRung).toBe(fresh.targetRung);
    // The negative polarity restates too — a calm stored row must not read the old word either.
    expect(
      hydrateOrComputeT1Dial({ ...fresh, headline: "unarmed + unfired → Calm, rung 1" }, []).headline,
    ).toBe("unprimed + unfired → Calm, rung 1");
    // A row this deploy wrote is untouched — the restatement is identity on current copy.
    expect(hydrateOrComputeT1Dial(fresh, [])).toBe(fresh);
  });

  it("the SERVED headline reads primed/unprimed - the confirmer, on the real producer", () => {
    const calm = computeT1Dial(
      ["credit", "rates", "volatility", "cross-asset", "trend"].map((k) => panel(k, "GREEN")),
    );
    expect(calm.headline).toContain("unprimed");
    const lit = computeT1Dial([
      panel("credit", "RED"),
      panel("rates", "GREEN"),
      panel("volatility", "RED"),
      panel("cross-asset", "GREEN"),
      panel("trend", "GREEN"),
    ]);
    expect(lit.armed).toBe(true); // the FIELD keeps its name — the ruling's out-of-scope half
    expect(lit.headline).toMatch(/^primed \(credit\)/);
    expect(FORBIDDEN.test(lit.headline)).toBe(false);
    expect(FORBIDDEN.test(calm.headline)).toBe(false);
  });
});
