import { beforeAll, describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_INDICATORS } from "./registry.js";

/*
 * THRESHOLD SINGLE-SOURCE GUARD — `indicator-loop.md` §A retune is a ONE-place edit
 *
 * A user-set cut must be editable in ONE place. This test fails when a cut's literal VALUE is
 * re-typed outside the module that defines it, so a retune can never leave a stale second copy
 * behind (the class that `src/dashboard.synth-cuts.test.ts:336-338` carried for F9/F10/F11 until 2026-07-30).
 *
 * ── POPULATION IT ADMITS (both auto-discovered; no hand-typed id list to drift) ───────────────
 *   (a) every exported `*_AMBER` / `*_RED` constant with a numeric value, found by scanning
 *       `src/**` for `export const <NAME>_(AMBER|RED)` and importing the declaring module;
 *   (b) every `thresholds.amberLevel` / `thresholds.redLevel` on a live `ALL_INDICATORS` entry.
 * Each cut carries an ID TOKEN — the indicator id for (b), the constant name's first
 * underscore-segment for (a) (`BAA10Y_LEVEL_AMBER` → `BAA10Y`, `R4_PROXIMITY_AMBER` → `R4`).
 *
 * ── SCAN SET ──────────────────────────────────────────────────────────────────────────────────
 * `src/`, `scripts/`, `public/` — `.ts`/`.js`/`.mjs`/`.cjs` only — minus the cut's own DEFINING
 * MODULES. For (a) that is the file declaring the constant; for (b) it is the sanctioned pair
 * `src/registry.ts` + `src/family-descriptor-rows.ts` (the two threshold homes: the descriptor is the
 * source, the registry derives). `src/goldens/**` and every `*.json` are excluded as GENERATED
 * artifacts — the goldens legitimately contain band values, and regenerating them is not a retune.
 *
 * ── THE MATCH RULE, AND WHY IT IS SCOPED ──────────────────────────────────────────────────────
 * A bare repo-wide value grep is useless here: `0.25` is BRENT's `redRoc`
 * AND an ordinary fraction in a dozen unrelated subsystems. So a line is flagged only when it
 * carries BOTH the cut's id token (case-insensitive word match, so `f10` counts) AND a numeric
 * literal exactly equal to the cut. That is the same-line co-occurrence rule.
 *
 * ── WHAT IT DELIBERATELY CANNOT CATCH (stated, not overclaimed) ───────────────────────────────
 *   • a copy that sits on a DIFFERENT line from its id mention (`const amber = 3.5;` under an
 *     `// F10` heading) — same-line scope is the price of no false positives on shared values;
 *   • a copy expressed as arithmetic (`0.125 * 2`) or as a string (`"3.5"` inside a quoted span
 *     that the comment stripper truncates at a `//`);
 *   • duplication INSIDE a defining module, or between the two threshold homes;
 *   • non-level cuts that are neither exported `*_AMBER`/`*_RED` nor a registry level pair
 *     (velocity-only priors typed inline, scorer constants named `amberRoc`, …);
 *   • cuts whose value has ONE significant digit (`0.3`, `0.5`, `20`) — see `guardable` below;
 *   • `.py`, `.json`, `.md`, `.html` and every generated artifact.
 * Two exemption lists, both lag-checked: `ALLOWLIST` (sanctioned out-of-band value pins)
 * and `KNOWN_DEBT` (real duplications outside this slice's touch list, named as debt, not blessed).
 * Both are keyed (file, id, ANCHOR) — an entry exempts only the ONE line carrying its anchor
 * substring, never the whole file/id pair (see `Exemption`).
 * Comment spans (block comments and `//` tails alike) are stripped before matching, so neither this
 * docblock nor the ALLOWLIST's inline reasons can indict themselves — but the allowlist's own
 * literals live in CODE, so they are excluded structurally instead (see `isAllowlisted`).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SCAN_ROOTS = ["src", "scripts", "public"];
const CODE_EXT = new Set([".ts", ".js", ".mjs", ".cjs"]);
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "goldens", // GENERATED band values — regenerating them is not a retune
  "__snapshots__",
  ".vercel",
  ".venv", // vendored python tooling ships bundled .js
]);

/**
 * A cut is GUARDABLE only if its value has ≥2 significant digits. One-significant-digit values
 * (`0`, `1`, `0.5`, `0.8`, `20`, `30`, `0.3`) are ordinary numbers that occur by the dozen in
 * unrelated code — scoping them by id token still yields pure noise (an `R1`-scoped `0.5` fires
 * on every fixture that happens to use a half). They are dropped from the population, NOT
 * silently allowlisted: their duplication is genuinely undetectable by a value rule.
 * ⚠ Consequence worth naming: `F16_VEL_AMBER = 5` / `F16_VEL_RED = 10` are excluded on this rule.
 */
const sigDigits = (v: number) =>
  String(Math.abs(v))
    .replace(".", "")
    .replace(/^0+/, "")
    .replace(/0+$/, "").length;
const guardable = (v: number) => Number.isFinite(v) && sigDigits(v) >= 2;

/**
 * An exemption is (file, id, ANCHOR) — never (file, id). The anchor is a distinctive substring
 * of the ONE line the entry sanctions, and only a line containing it is exempt, so a NEW copy
 * of the same cut elsewhere in the same file still fails (review 2026-07-30: the F10 entry was
 * (file, id) and blanket-blinded `dashboard.synth-cuts.test.ts` to every F10 level literal on every line —
 * re-typing the `describe.each` rows slice 3 removed was invisible again, and value-keying could
 * not fix it because the sanctioned pin carries the same two values).
 */
type Exemption = { file: string; id: string; anchor: string; reason: string };

/** Sanctioned second copies. Each entry states WHY it is not a drift hazard. */
const ALLOWLIST: readonly Exemption[] = [
  {
    file: "src/dashboard.synth-cuts.test.ts",
    id: "F10",
    anchor: "expect(f10.thresholds).toMatchObject(",
    reason:
      "The 2026-07-18 revert pin ('pinned by VALUE: a silent re-computation would move these') - " +
      "an out-of-band drift catcher of the same class; its two edge probes now derive from it.",
  },
];

/**
 * NOT sanctioned — real duplications this guard FOUND on its first run (2026-07-30) and could not
 * fix inside slice 3's touch list. Each entry is a live drift hazard, so deleting the entry (by
 * single-sourcing the copy it names) — never adding to it — is the fix. Drained 2026-07-31.
 */
const KNOWN_DEBT: readonly Exemption[] = [
  // EMPTY, and that is the intended end state — this list shrinks by DELETION, never by growth.
  // Retired 2026-07-31: a volatility id's entry, then a credit-spread id's row (never listed: it had drifted to a pair
  // matching NEITHER the live nor the retired cut, a shape this guard cannot recognise as a
  // duplication), then the F9/F10/F11 trio. All five `scripts/preview/mock-data.mjs` rows now take
  // the reachable IMPORT (`thresholdsOf(id)`, sourced from `ALL_INDICATORS`) instead of re-typing the
  // registry pair — which dissolves the drift class rather than exempting it, and keeps the preview
  // painting banded charts where a blanked `thresholds: {}` would have degraded them to context-only.
];

const EXEMPT = [...ALLOWLIST, ...KNOWN_DEBT];

type Cut = { id: string; value: number; homes: Set<string>; origin: string };

const rel = (abs: string) => path.relative(REPO, abs).split(path.sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (CODE_EXT.has(path.extname(abs))) out.push(abs);
  }
  return out;
}

/**
 * Blank out comments AND string contents, leaving only executable code. Comments go so no
 * comment (this docblock included) can be flagged; string bodies go because indicator PROSE is
 * full of unrelated numerals ("its 20-day velocity", "the 30-day expected move") that collide
 * with cut values under any co-occurrence rule.
 */
function stripNonCode(text: string): Line[] {
  let inBlock = false;
  return text.split("\n").map((raw) => {
    const uncommented: string[] = [];
    const code: string[] = [];
    let quote = "";
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!;
      if (inBlock) {
        if (raw.startsWith("*/", i)) (inBlock = false), i++;
        continue;
      }
      if (quote) {
        uncommented.push(ch);
        if (ch === "\\") uncommented.push(raw[i + 1] ?? ""), i++;
        else if (ch === quote) quote = "";
        continue;
      }
      if (raw.startsWith("/*", i)) (inBlock = true), i++;
      else if (raw.startsWith("//", i)) break;
      else {
        uncommented.push(ch);
        code.push(ch);
        if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      }
    }
    return { uncommented: uncommented.join(""), code: code.join(""), text: raw.trim() };
  });
}

type Line = { uncommented: string; code: string; text: string };

const DECL = /export\s+const\s+([A-Z][A-Z0-9_]*_(?:AMBER|RED))\b/g;
const THRESHOLD_HOMES = ["src/registry.ts", "src/family-descriptor-rows.ts"];

let SOURCE: Map<string, Line[]>;
let POPULATION: Cut[];

/** Builds SOURCE + POPULATION; run in `beforeAll` so collecting the file costs nothing. */
async function loadGuard(): Promise<void> {
  SOURCE = new Map(
    SCAN_ROOTS.flatMap((r) => walk(path.join(REPO, r))).map((f) => [rel(f), stripNonCode(readFileSync(f, "utf8"))]),
  );

  // ── (a) exported `*_AMBER` / `*_RED` constants, discovered then imported ──────────────────────
  const declared = new Map<string, string[]>(); // file → names
  for (const [file, lines] of SOURCE) {
    if (!file.startsWith("src/") || file.endsWith(".test.ts")) continue;
    const names = [...lines.map((l) => l.code).join("\n").matchAll(DECL)].map((m) => m[1]!);
    if (names.length) declared.set(file, names);
  }

  const cuts: Cut[] = [];
  for (const [file, names] of declared) {
    const mod: Record<string, unknown> = await import(
      /* @vite-ignore */ "./" + file.replace(/^src\//, "").replace(/\.ts$/, ".js")
    );
    for (const name of names) {
      const value = mod[name];
      if (typeof value !== "number" || !guardable(value)) continue;
      cuts.push({ id: name.split("_")[0]!, value, homes: new Set([file]), origin: name });
    }
  }

  // ── (b) live registry level pairs ─────────────────────────────────────────────────────────────
  for (const ind of ALL_INDICATORS) {
    // PRE-multiplier pair (`family-golden.test.ts`'s form): under a `ThresholdConfig != 1` the
    // populated `thresholds` no longer equals the SOURCE literal, so keying on it would silently
    // drop that id's coverage — the guard would look for a number nobody typed.
    const source = ind.rawThresholds ?? ind.thresholds;
    for (const key of ["amberLevel", "redLevel"] as const) {
      const value = source[key];
      if (typeof value !== "number" || !guardable(value)) continue;
      cuts.push({
        id: ind.id,
        value,
        homes: new Set(THRESHOLD_HOMES),
        origin: `${ind.id}.thresholds.${key}`,
      });
    }
  }

  /** Merge cuts that share an id+value so `homes` is the union of every legitimate home. */
  POPULATION = [...cuts.reduce((acc, c) => {
    const key = `${c.id}|${c.value}`;
    const prior = acc.get(key);
    if (prior) {
      for (const h of c.homes) prior.homes.add(h);
      if (!prior.origin.includes(c.origin)) prior.origin += ` / ${c.origin}`;
    } else acc.set(key, { ...c, homes: new Set(c.homes) });
    return acc;
  }, new Map<string, Cut>()).values()];
}

const NUMBER = /(?<![\w.$])-?\d+(?:\.\d+)?/g;
// `_` counts as part of the token so `BAA10Y` matches inside `BAA10Y_LEVEL_AMBER`, but `MYF10`
// does not match `F10`. Case-insensitive so a `f10` local still scopes.
// Memoized: the scan is O(files × cuts × lines) and called `idRe` on every one of those, so
// compiling a fresh RegExp per call was ~2s — the single slowest test in the suite. The cache
// is keyed on the id and the pattern is unchanged, so this is a pure speedup, not a rescope.
const ID_RE = new Map<string, RegExp>();
const idRe = (id: string): RegExp => {
  let re = ID_RE.get(id);
  if (!re) ID_RE.set(id, (re = new RegExp(`(?<![A-Za-z0-9])${id}(?![A-Za-z0-9])`, "i")));
  return re;
};

/**
 * The id token is looked for in the COMMENT-stripped line (an id inside `byId("F9")` or a JSON
 * key is legitimate scoping evidence); the numeric literal only in the STRING-stripped code.
 */
function lineHits(line: Line, cut: Cut): boolean {
  if (!idRe(cut.id).test(line.uncommented)) return false;
  return [...line.code.matchAll(NUMBER)].some((m) => Number(m[0]) === cut.value);
}

const SELF = "src/threshold-single-source.test.ts";

/** Exempt only where an entry's ANCHOR is on THIS line — see the `Exemption` docblock. */
const isExempt = (file: string, cut: Cut, line: Line, list: readonly Exemption[] = EXEMPT) =>
  list.some((a) => a.file === file && a.id === cut.id && line.uncommented.includes(a.anchor));

type Violation = { file: string; line: number; cut: Cut; text: string };

function scan(): Violation[] {
  const found: Violation[] = [];
  for (const [file, lines] of SOURCE) {
    if (file === SELF) continue; // this file's own allowlist literals
    // One whole-file id probe per cut, instead of a per-LINE probe: a cut whose id appears
    // nowhere in the file cannot hit any of its lines, and most (file, cut) pairs are that
    // case. Same predicate as lineHits' first clause, just hoisted — no rescope.
    const whole = lines.map((l) => l.uncommented).join("\n");
    for (const cut of POPULATION) {
      if (cut.homes.has(file)) continue;
      if (!idRe(cut.id).test(whole)) continue;
      lines.forEach((line, i) => {
        if (lineHits(line, cut) && !isExempt(file, cut, line)) {
          found.push({ file, line: i + 1, cut, text: line.text });
        }
      });
    }
  }
  return found;
}

describe("threshold single-source guard", () => {
  beforeAll(loadGuard);

  test("the guard's own population and scan set are non-empty (vacuity guard)", () => {
    // If either collapses the guard passes for free, so pin both floors well below today's counts.
    expect(POPULATION.length).toBeGreaterThan(20);
    expect(SOURCE.size).toBeGreaterThan(50);
    expect(POPULATION.map((c) => c.id)).toContain("CCC");
  });

  test("the detector CAN fire - positive control on a synthetic line", () => {
    const ccc = POPULATION.find((c) => c.id === "CCC" && c.value > 0)!;
    const asLine = (src: string) => stripNonCode(src)[0]!;
    expect(lineHits(asLine(`const x = { CCC: ${ccc.value} };`), ccc)).toBe(true);
    // ...and the scoping really scopes: the same value under a DIFFERENT id is not a hit.
    expect(lineHits(asLine(`const x = { SOMEOTHER: ${ccc.value} };`), ccc)).toBe(false);
    // ...nor is a near-miss value under the right id.
    expect(lineHits(asLine(`const x = { CCC: ${ccc.value + 1} };`), ccc)).toBe(false);
    // ...nor is the value when it lives in PROSE inside a string.
    expect(lineHits(asLine(`const x = { CCC: "a ${ccc.value} pp spread" };`), ccc)).toBe(false);
  });

  test("an exemption covers its ANCHORED line only, not every line of (file, id)", () => {
    // Synthetic entry over any live cut, so the test never leans on (or dies with) a real ALLOWLIST row.
    const cut = POPULATION[0]!;
    const ex: Exemption = { file: "src/synthetic.test.ts", id: cut.id, anchor: "SYNTHETIC_ANCHOR(", reason: "test-only" };
    const asLine = (src: string) => stripNonCode(src)[0]!;
    const anchored = asLine(`  ${ex.anchor}byId("${ex.id}").amber ?? ${cut.value});`);
    const elsewhere = asLine(`  { ind: byId("${ex.id}"), amber: ${cut.value} },`);
    expect(lineHits(anchored, cut) && lineHits(elsewhere, cut)).toBe(true); // both are hits…
    expect(isExempt(ex.file, cut, anchored, [ex])).toBe(true); // …only the sanctioned one is exempt
    expect(isExempt(ex.file, cut, elsewhere, [ex])).toBe(false);
  });

  test("no cut value is re-typed outside its defining module", () => {
    const violations = scan();
    const report = violations.map(
      (v) => `${v.file}:${v.line}  ${v.cut.origin} = ${v.cut.value}\n    ${v.text}`,
    );
    expect(report).toEqual([]);
  });

  test("every exemption (allowlist + known debt) still matches something", () => {
    // A debt entry that stops matching means the duplication was FIXED — delete the entry.
    // Anchored: an entry whose anchor no longer lands on a hitting line is stale too — the
    // line moved or was rewritten, so the entry now sanctions nothing and must be re-aimed.
    const stale = EXEMPT.filter(({ file, id, anchor }) => {
      const lines = SOURCE.get(file);
      if (!lines) return true;
      return !POPULATION.some(
        (cut) =>
          cut.id === id &&
          !cut.homes.has(file) &&
          lines.some((l) => lineHits(l, cut) && l.uncommented.includes(anchor)),
      );
    });
    expect(stale.map((s) => `${s.file} / ${s.id} @ ${s.anchor}`)).toEqual([]);
  });
});
