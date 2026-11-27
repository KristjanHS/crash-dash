/**
 * Rule/CLAUDE.md cite integrity guard — collected by `npm run check` (the vitest include
 * glob already picks up co-located test files under scripts/).
 *
 * Independent assertions, each red-demoed before commit:
 *
 *  2. Every `.claude/rules/*.md` file is REACHABLE — it opens with a `paths:` frontmatter block
 *     carrying at least one glob. Successor to the retired CLAUDE.md-rules-table pair: an earlier commit
 *     deleted that table (verified per file that every row's target auto-loads from its own
 *     `paths:`, so no run ever needed the index), which left both directions asserting against a
 *     surface that no longer exists — the failure `docs/backlog.md` carried from 2026-08-08. The
 *     table's real content was "every rule file is reachable"; frontmatter is where that now lives,
 *     so the guard reads the mechanism instead of an index restating it. The table's other
 *     direction (a row naming a missing file) is dissolved, not moved: with no index there is no
 *     second source to drift.
 *  3. Zero plan cites written as the `docs/plans/`-prefixed path (the dir immediately
 *     followed by a filename) under `src/`, `api/`, `scripts/`, `public/`. The compliant
 *     house style is the bare stem plus a directory hint —
 *     `<stem>.md (docs/plans/)` — which legitimately still contains the bare `docs/plans/`
 *     substring, so this asserts on the PREFIXED form (a filename immediately after the
 *     dir), never on the bare substring. Comment lines are the target and are in scope;
 *     a string literal carrying no filename right after the dir is skipped, no file exemption.
 *
 *  5. Every rule-file SECTION cite in a source file under `src/`, `api/`, `scripts/`, `public/`
 *     resolves to a real `##` heading in that rule file, and every `.claude/rules/<x>.md` path
 *     written in a source file names a file that exists. Retiring a heading is silent — the file
 *     still resolves — so this is the recurrence guard for the 2026-08-07 rule condenses.
 *
 *  6. Every DATED doc stem cited in a source file under `src/`, `api/`, `scripts/`, `public/`, in any
 *     repo markdown file, or in a migration / workflow YAML / `openapi.yaml` / script or leg JSON /
 *     git hook resolves: `YYYY-MM-DD-<slug>.md` to an existing `.md`, a bare `YYYY-MM-DD-<slug>` to
 *     any file whose extension-stripped basename equals it. Retiring a doc leaves every cite of it
 *     dangling silently; this is the sweep's recurrence guard. Its fixture stems are
 *     fragment-assembled, so this file never cites a missing stem as a literal.
 *
 *  4. Zero assistant-owed WORK ITEMS parked in `.claude/rules/*.md`. A rule is a standing
 *     directive; an owed item parked in one is invisible to every backlog sweep — its home is
 *     `docs/backlog.md` (`plan-hygiene.md` §"Archiving and deleting a plan doc"). Matches the
 *     CLASS, not one glyph: the
 *     `⚠` marker is shared with legitimate gotchas, so it discriminates nothing.
 *
 * SELF-INDICTMENT: assertion 3 walks `scripts/`, so this very file is scanned by it. The
 * forbidden PREFIXED cite therefore appears as a literal NOWHERE in this file — the CITE
 * regex is written as an escaped regex literal (`docs\/plans\/…`), whose source text is
 * `docs\/plans\/` and so never contains the unescaped `docs/plans/` the compiled regex
 * matches; and no example of the prefixed form is written out. Only the compliant bare hint
 * appears above. Hence assertion 3 does not trip on its own source, with no path exemption.
 *
 * SELF-INDICTMENT, assertion 5: it also walks `scripts/`, so this file is scanned. Its cite regex is
 * built from the rule STEMS actually on disk, so the placeholder `<rule>.md §Heading` used in the
 * prose below matches nothing, and the one real section cite in this docblock (assertion 4's) is a
 * live heading that the guard resolves like any other. No path exemption.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname, extname } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RULES_DIR = join(REPO_ROOT, ".claude", "rules");

/** All `.claude/rules/*.md` basenames (read once, memoized). */
let _rulesOnDisk: string[] | undefined;
function rulesOnDisk(): string[] {
  return (_rulesOnDisk ??= readdirSync(RULES_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort());
}

// ── Assertion 2 — every rule file is reachable via its own `paths:` frontmatter ──
// A rule with no `paths:` block auto-loads on nothing: it is invisible at every seam it claims to
// govern, and (since the CLAUDE.md index was retired) no other surface would notice.
// Matched on the FRONTMATTER, not a bare substring — `paths:` must sit inside the leading `---`
// fence, which is the only place the loader reads it, and carry at least one `- <glob>` entry.
function frontmatterGlobs(rule: string): string[] | undefined {
  const lines = readFileSync(join(RULES_DIR, rule), "utf8").split("\n");
  if (lines[0]?.trim() !== "---") return undefined; // no frontmatter fence at all
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return undefined; // unterminated fence — the loader sees no frontmatter
  const keyIdx = lines.findIndex((l, i) => i > 0 && i < end && /^paths:/.test(l));
  if (keyIdx < 0) return undefined;
  const globs: string[] = [];
  for (let i = keyIdx + 1; i < end; i++) {
    const line = lines[i] ?? "";
    if (/^\S/.test(line)) break; // next top-level key ends the block
    const m = line.match(/^\s+-\s+(\S.*)$/);
    if (m && m[1]) globs.push(m[1].trim());
  }
  return globs;
}

describe(".claude/rules/*.md are reachable", () => {
  it("every rule file carries a `paths:` frontmatter block with at least one glob", () => {
    const unreachable = rulesOnDisk().filter((f) => (frontmatterGlobs(f) ?? []).length === 0);
    expect(
      unreachable,
      `rule files that auto-load on nothing (no \`paths:\` glob in frontmatter): ${unreachable.join(", ")}`,
    ).toEqual([]);
  });
});

// ── Assertion 3 — no prefixed docs/plans/ path cites under source dirs ──────────
// Escaped regex literal: the SOURCE text here is `docs\/plans\/…`, which never contains
// the unescaped `docs/plans/` the compiled regex matches — so this line does not indict
// itself (see the SELF-INDICTMENT note in the docblock). `(?:archive/)?` also rejects the
// archive-prefixed form. The char class forbids quotes/backtick/paren right after the dir,
// so a bare hint `(docs/plans/)` or a glob string `"…/docs/plans/"` yields no match.
const CITE = /docs\/plans\/(?:archive\/)?[^\s`"')]+\.(?:md|html)/;
const SOURCE_DIRS = ["src", "api", "scripts", "public"];
const SOURCE_EXTS = new Set([".ts", ".js", ".mjs", ".py", ".sh", ".html", ".css"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue; // skip build output + dot-dirs
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXTS.has(extname(name))) out.push(full);
  }
}

// Source-dir file list, walked once and memoized. Callers ITERATE it read-only (never push into it).
let _sourceFiles: string[] | undefined;
function sourceFiles(): string[] {
  if (!_sourceFiles) {
    const files: string[] = [];
    for (const d of SOURCE_DIRS) walk(join(REPO_ROOT, d), files);
    _sourceFiles = files;
  }
  return _sourceFiles;
}

// Each scanned file's text, read once per module and shared by assertions 3, 5 and 6.
const _sourceText = new Map<string, string>();
function sourceText(file: string): string {
  let t = _sourceText.get(file);
  if (t === undefined) _sourceText.set(file, (t = readFileSync(file, "utf8")));
  return t;
}

// ── Assertion 4 — no assistant-owed work item parked in a rule file ─────────────
// Emphasis and code fences are stripped first so the patterns below read the prose,
// not its markup.
function normalizeRuleLine(line: string): string {
  return line.replace(/\*\*/g, "").replace(/`/g, "").trim();
}

// Each pattern carries a `hit` fixture the anchor below MUST match — fragment-assembled so this
// file never spells a parked-item line out as a literal.
const OWED_PATTERNS: { name: string; re: RegExp; hit: string }[] = [
  // (a) LABEL shape — an owed marker opening the line (optionally behind a list
  // bullet and/or the `⚠` glyph) with the item's payload on the SAME line. The
  // trailing `\s+\S` is the discriminator that keeps a standing section LABEL out:
  // a bare `**Owed:**` line introducing a checklist of duties is a directive, not a
  // parked item, and ends right after the colon, so it does not match.
  {
    name: "owed-label",
    re: /^(?:[-*+]\s+)?(?:⚠\s*)?(?:Owed|Suspected|TODO|FIXME)\b\s*:?\s+\S/i,
    hit: "- ⚠ **Ow" + "ed:** move the retune to the backlog",
  },
  // (b) Mid-line TODO/FIXME, but only in its PARKED form — the marker followed by
  // a colon and a payload. The colon is the discriminator: a rule that states the
  // directive ("a TODO parked in a rule is invisible to every backlog sweep") is
  // compliant prose and must stay green, and a bare `\bTODO\b` would red it.
  { name: "todo-marker", re: /\b(?:TODO|FIXME)\s*:\s+\S/, hit: "see the TO" + "DO: rewire the walker" },
  // (c) DEFERRED-UPGRADE shape — work postponed to a future dependency bump. This
  // is the arm the two-marker grep missed: such a line carries neither `Owed` nor
  // `Suspected`, yet it is a parked assistant-owed item.
  {
    name: "deferred-upgrade",
    re: /\bon the\b[^.\n]{0,60}\bupgrade\b/i,
    hit: "revisit this on the next vitest upg" + "rade",
  },
  { name: "deferred-upgrade", re: /\bwhen we upgrade\b/i, hit: "drop the shim when we upg" + "rade node" },
];

describe("no assistant-owed work items in .claude/rules/*.md", () => {
  it("owed follow-ups live in docs/backlog.md, never parked in a rule", () => {
    const violations: string[] = [];
    for (const rule of rulesOnDisk()) {
      const lines = readFileSync(join(RULES_DIR, rule), "utf8").split("\n");
      lines.forEach((raw, i) => {
        const line = normalizeRuleLine(raw);
        for (const { name, re } of OWED_PATTERNS) {
          if (re.test(line)) {
            violations.push(`${rule}:${i + 1} [${name}]: ${line.slice(0, 100)}`);
            return;
          }
        }
      });
    }
    expect(
      violations,
      `assistant-owed work items parked in rule files (move to docs/backlog.md):\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  // Vacuity anchor (the r4-gloss guard's live-match pattern) — the rules are drained of owed
  // items BY DESIGN, so only fixtures can prove the regexes still bite; each runs through the
  // same normalizeRuleLine the scan uses, and the documented discriminators stay negative.
  it("every OWED_PATTERNS regex still matches its fixture, and the compliant forms stay green", () => {
    const dead = OWED_PATTERNS.filter(({ re, hit }) => !re.test(normalizeRuleLine(hit)));
    expect(
      dead.map(({ name, re }) => `${name}: ${re}`),
      `OWED_PATTERNS regexes that no longer match their own fixture:\n${dead.map((d) => d.name).join("\n")}`,
    ).toEqual([]);
    // Discriminators: a bare section LABEL and directive prose about parked items must NOT match.
    const compliant = ["**Ow" + "ed:**", "a TO" + "DO parked in a rule is invisible to every backlog sweep"];
    for (const line of compliant) {
      const hits = OWED_PATTERNS.filter(({ re }) => re.test(normalizeRuleLine(line)));
      expect(hits.map((h) => h.name), `compliant line flagged: ${line}`).toEqual([]);
    }
  });
});

describe("no prefixed docs/plans cites under source dirs", () => {
  it("cites use the bare stem, never the docs/plans-prefixed path", () => {
    const files = sourceFiles();
    const violations: string[] = [];
    for (const file of files) {
      const text = sourceText(file);
      if (!text.includes("docs/plans/")) continue;
      text.split("\n").forEach((line, i) => {
        if (CITE.test(line)) violations.push(`${file.slice(REPO_ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(violations, `prefixed plan cites (use "<stem>.md" hint instead):\n${violations.join("\n")}`).toEqual([]);
  });

  // Vacuity anchor — fragment-assembled (join keeps the forbidden prefixed form out of this
  // file's source, preserving the SELF-INDICTMENT property): the CITE regex MUST match the
  // prefixed forms it forbids and MUST skip the compliant bare hint.
  it("the CITE regex still matches the prefixed form and still skips the bare hint", () => {
    expect(CITE.test(`see ${["docs", "plans", "retired-plan.md"].join("/")} for history`)).toBe(true);
    expect(CITE.test(`see ${["docs", "plans", "archive", "retired-plan.md"].join("/")} for history`)).toBe(true);
    expect(CITE.test(`mockup: ${["docs", "plans", "mockup.html"].join("/")}`)).toBe(true);
    expect(CITE.test(`retired-plan.md (${["docs", "plans"].join("/")}/)`)).toBe(false); // compliant hint
  });
});

// ── Assertion 5 — rule SECTION cites under source dirs resolve to a real `##` ────
//
// SHAPES matched (enumerated from the tree 2026-08-08: 49 cites sit on a single line, 7 more only
// resolve once contiguous comment lines are joined, so the walker sees 56; every shape below is
// present, and the `§`-before-stem order returned 0 hits so it is not matched):
//   `<rule>.md` §Bare Heading            ·  `<rule>.md` §"Quoted Heading"
//   .claude/rules/<rule>.md` §Heading    ·  <rule>.md §Heading (no backticks, .sh comments)
//   <rule>.md § Heading                  (one space after the section glyph)
// The stem alternation is built from the files ON DISK, so a `<rule>.md` placeholder in prose
// matches nothing; a cite naming a NON-existent rule file is caught by the second `it()` below,
// which checks the `.claude/rules/`-prefixed path form (65 such paths live in the tree, all
// resolving today). A bare stem naming a non-existent rule file is indistinguishable from an
// ordinary doc cite and is deliberately out of scope.
//
// LINE JOINING, then PREFIX COMPARISON. Cites wrap across comment lines in two places — at the
// stem→`§` boundary and mid-heading — so matching per LINE is blind to them (6 such cites in the
// tree, one of which was dangling unseen). Contiguous comment lines are therefore stripped of
// their markup and joined into one search string before matching (`citeBlocks`), with offsets
// mapped back to real line numbers for the report.
//
// Both sides are normalized (lowercased; backticks, quotes and `*` stripped; whitespace collapsed)
// and compared on their common prefix, which must reach `CITE_PREFIX_LEN` chars — or the whole
// HEADING if it is shorter. Evidence that 20 discriminates: the longest common prefix between any
// TWO `##` headings inside the same rule file is 2 chars (measured over all 8 rule files), so a
// cite that reaches 20 can only have come from the heading it matched. The bar is NEVER lowered by
// the cite's own length (a cite truncated to a few chars would otherwise resolve against anything
// sharing that prefix — the 1-char false resolutions found 2026-08-08); a cite carrying fewer than
// `CITE_MIN_LEN` normalized chars is reported as unresolvable instead.
//
// SCOPE: source dirs only. `docs/**` is deliberately OUT — rule-§ cites in plan/archive markdown are
// allowed to dangle (some are deliberate tombstones recording a heading that WAS retired), so
// walking them would red the guard on intentional history. Do not widen the walker.
const CITE_PREFIX_LEN = 20;

/** This guard's own path, excluded from the vacuity anchors (never from the dangling check). */
const SELF_REL = "scripts/check-rule-cites.test.ts";

/** Cited-heading text: quoted cites end at the closing quote, bare ones at the first `)` or EOL. */
function citedHeadingText(rest: string): string {
  if (rest.startsWith('"')) return rest.slice(1).split('"')[0] ?? "";
  return rest.split(")")[0] ?? "";
}

/** Case/markup/whitespace-insensitive form used on BOTH the cite and the real heading. */
function normalizeHeading(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`"'*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Normalized `##`+ headings of a rule file. */
function ruleHeadings(rule: string): string[] {
  return readFileSync(join(RULES_DIR, rule), "utf8")
    .split("\n")
    .filter((l) => /^#{2,}\s+/.test(l))
    .map((l) => normalizeHeading(l.replace(/^#+\s+/, "")));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type SectionCite = {
  key: string;
  where: string;
  rule: string;
  cited: string;
  best: string;
  hit: number;
  /** Shape flags — the per-shape vacuity floors below pin one of each. */
  quoted: boolean;
  prefixed: boolean;
  backticked: boolean;
  wrapped: boolean;
};

/** Leading comment markup of a slash-slash, block-comment, star-continuation or hash comment line. */
const COMMENT_PREFIX = /^\s*(?:\/\/+|\/\*+|\*+\/?|#+)\s?/;

type CiteBlock = { text: string; starts: { at: number; line: number }[] };

/**
 * Contiguous comment lines JOINED into one search string (markup stripped, single space between),
 * so a cite that wraps at the stem→`§` boundary or mid-heading is still one contiguous string.
 * Non-comment lines become one-line blocks. `starts` maps a character offset back to a line number.
 */
function citeBlocks(text: string): CiteBlock[] {
  const blocks: CiteBlock[] = [];
  const lines = text.split("\n");
  let cur: CiteBlock | undefined;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (!COMMENT_PREFIX.test(raw)) {
      if (cur) blocks.push(cur);
      cur = undefined;
      blocks.push({ text: raw, starts: [{ at: 0, line: i + 1 }] });
      continue;
    }
    const body = raw.replace(COMMENT_PREFIX, "").trimEnd();
    if (!cur) cur = { text: body, starts: [{ at: 0, line: i + 1 }] };
    else {
      cur.starts.push({ at: cur.text.length + 1, line: i + 1 });
      cur.text += ` ${body}`;
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

/** Source line holding character offset `idx` of a joined block. */
function lineAt(block: CiteBlock, idx: number): number {
  let line = block.starts[0]?.line ?? 1;
  for (const s of block.starts) {
    if (s.at > idx) break;
    line = s.line;
  }
  return line;
}

/** Offset just past the last character of the source line holding `idx`. */
function lineEndAt(block: CiteBlock, idx: number): number {
  for (const s of block.starts) if (s.at > idx) return s.at - 1;
  return block.text.length;
}

function collectSectionCites(): SectionCite[] {
  const rules = rulesOnDisk();
  const stems = rules.map((r) => escapeRe(r.replace(/\.md$/, ""))).join("|");
  // `(?<![\w-])` gives the stem alternation a LEFT boundary, so a same-suffix filename
  // (`…-frontend.md`) is not mis-attributed to the rule file. The opening backtick is captured
  // BEFORE the optional `.claude/rules/` prefix, which is where it sits in the tree's prefixed
  // cites. The heading text is captured through a LOOKAHEAD, not consumed — otherwise `.*$` would
  // swallow the rest of a joined block and hide every later cite in it.
  const re = new RegExp(
    `(\`?)(\\.claude/rules/)?(?<![\\w-])((?:${stems})\\.md)\`?[\\s,]{0,2}§\\s*(?=(.*)$)`,
    "g",
  );
  const headings = new Map(rules.map((r) => [r, ruleHeadings(r)]));
  const files = sourceFiles();
  const cites: SectionCite[] = [];
  for (const file of files) {
    const rel = file.slice(REPO_ROOT.length + 1);
    const text = sourceText(file);
    if (!text.includes("§")) continue;
    for (const block of citeBlocks(text)) {
      for (const m of block.text.matchAll(re)) {
        const rule = m[3];
        const rest = m[4];
        if (!rule || rest === undefined) continue;
        const rawCited = citedHeadingText(rest);
        const cited = normalizeHeading(rawCited).slice(0, 2 * CITE_PREFIX_LEN);
        if (!cited) continue; // a bare `§` with no text carries no target to resolve
        let best = "";
        let hit = 0;
        for (const h of headings.get(rule) ?? []) {
          const n = commonPrefixLen(h, cited);
          if (n > hit) {
            hit = n;
            best = h;
          }
        }
        const startLine = lineAt(block, m.index);
        // WRAPPED means exactly "a per-LINE matcher would have read this cite differently" — the
        // stem and its `§` on separate lines (the matcher sees nothing at all), or heading text
        // continuing past the line end (the matcher sees a truncated cite). Measured, not guessed:
        // re-derive the cited text from the `§` line alone and compare.
        const restStart = m.index + m[0].length;
        const restOnLine = block.text.slice(restStart, lineEndAt(block, restStart));
        const citedOnLine = normalizeHeading(citedHeadingText(restOnLine)).slice(0, 2 * CITE_PREFIX_LEN);
        const wrapped = lineAt(block, restStart) !== startLine || citedOnLine !== cited;
        cites.push({
          key: `${rel}|${cited}`,
          where: `${rel}:${startLine}`,
          rule,
          cited,
          best,
          hit,
          quoted: rest.startsWith('"'),
          prefixed: m[2] === ".claude/rules/",
          backticked: m[1] === "`",
          wrapped,
        });
      }
    }
  }
  return cites;
}

/**
 * A cite shorter than this (normalized) carries too little heading text to discriminate between
 * a live heading and a retired one, so it is REPORTED as unresolvable rather than passed. Fix such
 * a cite by making it carry more of the heading, never by lowering this floor.
 */
const CITE_MIN_LEN = 8;

function dangling(cites: SectionCite[]): SectionCite[] {
  return cites.filter((c) => {
    if (c.cited.length < CITE_MIN_LEN) return true;
    // Bound on the HEADING only — never on the cite's own length, which would let a cite
    // truncated to a handful of chars set its own (trivially satisfied) bar.
    const need = Math.min(CITE_PREFIX_LEN, c.best.length || CITE_PREFIX_LEN);
    return !(c.hit > 0 && c.hit >= need);
  });
}

describe("rule section cites under source dirs resolve", () => {
  it("every `<rule>.md` §Heading cite names a real ## in that rule file", () => {
    const cites = collectSectionCites();
    // ── Vacuity anchors: PER SHAPE, not a total ──────────────────────────────────────────────
    // A single total is blind to partial regression — drop the quoted arm, the
    // `.claude/rules/`-prefixed arm or the line-joining and the total stays above its floor while
    // a whole shape goes unseen. That is the failure named in `testing-project.md`
    // §"A guard's vacuity anchor must not certify the thing it exists to catch", so each shape the
    // regex claims to match carries its own floor. Counted over cites OUTSIDE this file, so the
    // guard's own docblock can never satisfy its own anchor. No floor on `.sh` (exactly 1 cite) or
    // `.py`/`.html`/`.css` (0) — a floor there would pin a population, not a shape.
    const others = cites.filter((c) => !c.where.startsWith(SELF_REL));
    expect(others.length, "rule section-cite census collapsed — regex or walker is broken").toBeGreaterThan(25);
    const shapes = {
      quoted: others.filter((c) => c.quoted).length,
      prefixed: others.filter((c) => c.prefixed).length,
      bare: others.filter((c) => !c.backticked).length,
      wrapped: others.filter((c) => c.wrapped).length,
    };
    expect(shapes.quoted, `quoted §"Heading" cites unseen (shapes: ${JSON.stringify(shapes)})`).toBeGreaterThan(0);
    expect(
      shapes.prefixed,
      `.claude/rules/-prefixed cites unseen (shapes: ${JSON.stringify(shapes)})`,
    ).toBeGreaterThan(0);
    expect(shapes.bare, `non-backticked cites unseen (shapes: ${JSON.stringify(shapes)})`).toBeGreaterThan(0);
    expect(
      shapes.wrapped,
      `cites wrapping across comment lines unseen — line-joining is broken (shapes: ${JSON.stringify(shapes)})`,
    ).toBeGreaterThan(0);
    // No allowlist by design: the two 2026-08-08 dangles it was drafted for were fixed instead
    // (`velocity-firing.test.ts`'s fragment cite, the local backup script's cite onto prose).
    const violations = dangling(cites).map(
      (c) => `${c.where}: ${c.rule} §${c.cited}  (closest ##: "${c.best}", matched ${c.hit} chars)`,
    );
    expect(violations, `dangling rule section cites:\n${violations.join("\n")}`).toEqual([]);
  });

  it("every .claude/rules/<x>.md path written in a source file exists", () => {
    const files = sourceFiles();
    const disk = new Set(rulesOnDisk());
    const RULE_PATH = /\.claude\/rules\/([A-Za-z0-9._-]+\.md)/g;
    const missing: string[] = [];
    for (const file of files) {
      const text = sourceText(file);
      if (!text.includes(".claude/rules/")) continue;
      text
        .split("\n")
        .forEach((line, i) => {
          for (const m of line.matchAll(RULE_PATH)) {
            if (m[1] && !disk.has(m[1])) missing.push(`${file.slice(REPO_ROOT.length + 1)}:${i + 1}: ${m[1]}`);
          }
        });
    }
    expect(missing, `cites naming a missing rule file:\n${missing.join("\n")}`).toEqual([]);
  });
});

// A backticked repo-relative PATH in an instruction file or a live writable doc names a file that exists. Plans are
// out (their edit-site column names files the plan will create); globs, placeholders and fenced blocks are skipped.
function livePathDocs(): string[] {
  const rules: string[] = [];
  const walkMd = (dir: string): void => {
    for (const e of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true }))
      if (e.isDirectory()) walkMd(`${dir}/${e.name}`);
      else if (e.name.endsWith(".md")) rules.push(`${dir}/${e.name}`);
  };
  walkMd(".claude/rules");
  const docs = readdirSync(join(REPO_ROOT, "docs")).filter((f) => /-provenance\.md$|^claim-verification.*\.md$/.test(f));
  const taxonomy = readdirSync(join(REPO_ROOT, "docs/claim-verification")).filter((f) => f.endsWith(".md"));
  return ["CLAUDE.md", ...rules, "docs/reference.md", "docs/backlog.md", ...docs.map((f) => `docs/${f}`), ...taxonomy.map((f) => `docs/claim-verification/${f}`)];
}

/** `line:path` for every backticked repo-relative path that resolves to nothing (as-is, or as a `.ts`/`.js` module). */
function unresolvedPaths(text: string, exists: (p: string) => boolean): string[] {
  const out: string[] = [];
  let fenced = false;
  text.split("\n").forEach((line, i) => {
    if (line.trimStart().startsWith("```")) return void (fenced = !fenced);
    if (fenced) return;
    for (const [, raw] of line.matchAll(/`([^`\s]+)`/g)) {
      const p = raw!.replace(/:\d+(?:-\d+)?$/, "").replace(/[.,;)]+$/, "").split("#")[0]!;
      if (!p.includes("/") || /[*{}<>$|…]|\.\.\./.test(p)) continue;
      const top = p.split("/")[0]!;
      if (!top || top === "." || top === ".." || !exists(top)) continue; // `./x.js` specifiers, `~/…`, `a/b` prose
      // `.git/…` is git's own state, not repo content: a dir in the main checkout, a file in a linked worktree.
      if (top === ".git") continue;
      if (![p, `${p}.ts`, `${p}.js`].some(exists)) out.push(`${i + 1}:${p}`);
    }
  });
  return out;
}

// Instruction-surface misses (CLAUDE.md, `.claude/rules/`, `.claude/skills/`) whose rewording waits on the
// owner's approval round — never edited by a bulk cite pass. Keyed `<file>:<cite>` (line number dropped, so an
// unrelated edit above does not churn the key). Each entry must stay a LIVE miss: once its line is fixed the
// stale entry reds below and must be deleted, so these sets only shrink. No other file may be listed.
// The stems are fragment-assembled (as in assertion 6's fixture) so this file never cites one as a literal.
const PENDING_INSTRUCTION_PATHS = new Set<string>([]);
const PENDING_INSTRUCTION_STEMS = new Set<string>([]);
const missKey = (miss: string): string => miss.replace(/:\d+:\s?/, ":");
function unpendedMisses(misses: string[], pending: Set<string>): { open: string[]; stale: string[] } {
  const keys = new Set(misses.map(missKey));
  return {
    open: misses.filter((m) => !pending.has(missKey(m))),
    stale: [...pending].filter((p) => !keys.has(p) || !/^(?:CLAUDE\.md|\.claude\/(?:rules|skills)\/)/.test(p)),
  };
}

describe("backticked repo paths in instruction files and live docs resolve", () => {
  const onDisk = (p: string): boolean => existsSync(join(REPO_ROOT, p));
  // A gitignored path (e.g. `supabase/.temp/project-ref`) is machine-local state: present in a linked
  // main checkout, absent from the `git archive` tree `make ship` tests in. Its presence says nothing
  // about the repo, so a cite of it counts as resolved. Matched off the `.gitignore` files along the
  // path, not `git check-ignore` — the ship tree has no `.git`. Literal patterns only: a glob or negation
  // line is skipped, which errs toward "not ignored" (the cite must then exist). Kept from gitignore: a
  // pattern with a leading or inner `/` is anchored to its `.gitignore`'s dir; a trailing `/` matches
  // directories only (here: a segment with more path after it).
  const gitIgnored = (p: string): boolean => {
    const segs = p.split("/");
    for (let d = 0; d < segs.length; d++) {
      const gi = join(REPO_ROOT, ...segs.slice(0, d), ".gitignore");
      if (!existsSync(gi)) continue;
      const rel = segs.slice(d);
      for (const line of readFileSync(gi, "utf8").split("\n")) {
        const raw = line.trim();
        if (!raw || raw.startsWith("#") || /[!*?[\]\\]/.test(raw)) continue;
        const dirOnly = raw.endsWith("/");
        const pat = raw.replace(/\/$/, "");
        const anchored = pat.includes("/");
        const parts = pat.replace(/^\//, "").split("/");
        const lastStart = anchored ? 0 : rel.length - parts.length; // anchored = only at this dir
        for (let s = 0; s <= lastStart; s++) {
          const at = parts.every((x, k) => rel[s + k] === x);
          if (at && (!dirOnly || s + parts.length < rel.length)) return true;
        }
      }
    }
    return false;
  };
  const resolvable = (p: string): boolean => onDisk(p) || gitIgnored(p);

  it("can fail: a missing path hits; existing files, extensionless modules, globs, placeholders, fences, specifiers, `~/` and `.git/` do not", () => {
    const text = [
      "see `src/gone.ts` and `docs/nope.md:12`",
      "ok `src/ntfy.ts` `api/cron/run` `src/*.ts` `public/<name>.test.js` `~/.claude/x.md` `and/or` `./fred.js` `../src/x.ts` `.git/never-here`",
      "```",
      "`src/also-gone.ts`",
      "```",
    ].join("\n");
    expect(unresolvedPaths(text, onDisk)).toEqual(["1:src/gone.ts", "1:docs/nope.md"]);
  });

  it("a gitignored path resolves whether or not it is on disk; a missing tracked-tree path still hits", () => {
    expect(unresolvedPaths("`supabase/.temp/never-created` `src/gone.ts`", resolvable)).toEqual(["1:src/gone.ts"]);
  });

  it("every cited path exists", () => {
    const docs = livePathDocs();
    expect(docs).toEqual(expect.arrayContaining(["CLAUDE.md", ".claude/rules/frontend.md", "docs/member-weight-provenance.md", "docs/claim-verification/grep-and-sweep.md"]));
    const misses = docs.flatMap((d) => unresolvedPaths(readFileSync(join(REPO_ROOT, d), "utf8"), resolvable).map((m) => `${d}:${m}`));
    const { open, stale } = unpendedMisses(misses, PENDING_INSTRUCTION_PATHS);
    expect(open, "repoint the cite to the file's current path, or drop it if the file is gone").toEqual([]);
    expect(stale, "no longer a miss (or not an instruction file) — delete it from PENDING_INSTRUCTION_PATHS").toEqual([]);
  });
});

// ── Assertion 6 — dated doc-stem cites resolve ─────────────────────────────────
// Walks the disk, not `git ls-files`: `make ship` tests a `git archive` tree with no `.git`.
// `.claude/` is walked only for rules + skills (its worktrees/ hold whole checkouts).
// Two cite forms. (a) `<stem>.md` must name an existing `.md`. (b) A bare stem (no `.md`) must equal the
// extension-stripped basename of ANY file in the tree — a trailing `-` (a stem wrapped onto the next
// line) or a following `…` (an elided tail) marks it TRUNCATED, resolved by any basename it prefixes.
// (b)'s shape is the measured line between doc names and dated prose: a doc slug is at least two words
// (`(?:w-)+w*`, so a one-word `<date>-retune` / `<date>-final` is prose); no leading `-` (`Post-<date>-x`,
// `estimate-without-<date>-final` test data); no `vs-`/`to-`/`through-` slug (a date comparison or range);
// URLs are stripped first (dated news-article slugs). The right boundary `(?![-\w])` keeps a cite of a
// longer live stem from matching as its shorter, retired prefix.
const DATED_STEM = /\b20\d\d-\d\d-\d\d-[A-Za-z0-9._-]*?\.md\b/g;
const DATED_BARE = /(?<![-\w])20\d\d-\d\d-\d\d-(?!(?:vs|to|through)-)(?:[a-z0-9]+-)+[a-z0-9]*(?![-\w])/g;
function repoFiles(): string[] {
  const out: string[] = [];
  const rec = (abs: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const p = join(abs, e.name);
      if (e.isDirectory()) rec(p);
      else if (!e.name.endsWith(".local.md")) out.push(p); // `*.local.md` = untracked machine-local
    }
  };
  rec(REPO_ROOT);
  for (const d of [".claude/rules", ".claude/skills"]) if (existsSync(join(REPO_ROOT, d))) rec(join(REPO_ROOT, d));
  return out;
}
// Cite-carrying files outside the `.md` + SOURCE_DIRS/SOURCE_EXTS walk: migration comments, workflow
// YAML, the API contract, script + leg JSON, extensionless git hooks. `[dir, basename filter, recursive]`.
const EXTRA_CITE_SCOPES: [string, RegExp, boolean][] = [
  ["supabase/migrations", /\.sql$/, false],
  ["scripts/sql", /\.sql$/, false],
  [".github", /\.ya?ml$/, true],
  [".", /^(?:openapi\.yaml|vercel\.json|Makefile)$/, false],
  ["scripts", /\.json$/, false],
  ["public", /\.json$/, false],
  ["scripts/git-hooks", /^[^.]+$/, false],
];
function extraCiteFiles(): string[] {
  const out: string[] = [];
  const rec = (abs: string, re: RegExp, deep: boolean): void => {
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const p = join(abs, e.name);
      if (e.isDirectory()) { if (deep && !SKIP_DIRS.has(e.name)) rec(p, re, deep); }
      else if (re.test(e.name)) out.push(p);
    }
  };
  for (const [d, re, deep] of EXTRA_CITE_SCOPES) rec(join(REPO_ROOT, d), re, deep);
  return out;
}
const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const stemOf = (name: string): string => name.replace(/\.[^.]*$/, "");
function danglingStems(files: string[], read: (f: string) => string, md: Set<string>, stems: Set<string>): string[] {
  const out: string[] = [];
  const stemList = [...stems];
  for (const f of files)
    read(f).split("\n").forEach((line, i) => {
      const hit = (s: string): number => out.push(`${f.slice(REPO_ROOT.length + 1)}:${i + 1}: ${s}`);
      for (const [stem] of line.matchAll(DATED_STEM)) if (!md.has(stem)) hit(stem);
      const bare = line.replace(/\bhttps?:\/\/\S+/g, "");
      for (const m of bare.matchAll(DATED_BARE)) {
        const s = m[0];
        const next = bare.slice(m.index + s.length);
        if (next.startsWith(".md")) continue; // form (a), checked above
        const truncated = s.endsWith("-") || next.startsWith("…");
        if (truncated ? !stemList.some((x) => x.startsWith(s)) : !stems.has(s)) hit(truncated ? `${s}…` : s);
      }
    });
  return out;
}

describe("dated doc-stem cites resolve", () => {
  it("can fail: a missing dated stem hits, `.md` or bare; existing, truncated-live, prose and URL forms do not", () => {
    const d = (day: string, ...w: string[]): string => [`2001-01-${day}`, ...w].join("-");
    const gone = d("01", "retired-plan.md");
    const kept = d("02", "live-plan.md");
    const goneBare = d("03", "retired-plan");
    const keptBare = d("04", "live", "mockup"); // resolves through a non-`.md` file
    const longer = d("05", "eyeball", "walkthrough", "feedback"); // live; its shorter prefix is not
    const cutLive = d("02", "live", ""); // wrapped: trailing `-`
    const cutGone = d("06", "never", "");
    const text = [
      `see ${gone} and ${kept}; undated backlog.md; ${goneBare} §3; ${keptBare} and \`${longer}.md\``,
      `wrapped ${cutLive}`,
      `wrapped ${cutGone}`,
      `elided ${d("05", "eyeball", "walk")}… and ${d("07", "no", "pe")}…`,
      `prose: post-${d("08", "x", "y")}, ${d("09", "retune")}, ${d("10", "vs", "today")}, https://ex.com/${d("11", "news", "slug")}`,
    ].join("\n");
    const md = new Set([kept, `${longer}.md`]);
    const stems = new Set([stemOf(kept), `${keptBare}`, longer]);
    expect(danglingStems([join(REPO_ROOT, "fixture.md")], () => text, md, stems)).toEqual([
      `fixture.md:1: ${gone}`,
      `fixture.md:1: ${goneBare}`,
      `fixture.md:3: ${cutGone}…`,
      `fixture.md:4: ${d("07", "no", "pe")}…`,
    ]);
  });

  it("every cited dated stem names an existing file", () => {
    const all = repoFiles();
    const md = all.filter((p) => p.endsWith(".md"));
    const mdNames = new Set(md.map(baseName));
    const stems = new Set(all.map((p) => stemOf(baseName(p))));
    expect(mdNames.has("reference.md")).toBe(true); // walker reached docs/
    const extra = extraCiteFiles();
    const rel = extra.map((p) => p.slice(REPO_ROOT.length + 1));
    // each scope reached (a renamed dir would silently drop it)
    for (const want of [/^supabase\/migrations\/.+\.sql$/, /^\.github\/.+\.ya?ml$/, /^openapi\.yaml$/, /^scripts\/[^/]+\.json$/, /^scripts\/git-hooks\/commit-msg$/])
      expect(rel.some((p) => want.test(p)), String(want)).toBe(true);
    const misses = danglingStems([...sourceFiles(), ...md, ...extra], sourceText, mdNames, stems);
    const { open, stale } = unpendedMisses(misses, PENDING_INSTRUCTION_STEMS);
    expect(open, "drop the cite (inline its one-line why) or repoint it to the file's current name").toEqual([]);
    expect(stale, "no longer a miss (or not an instruction file) — delete it from PENDING_INSTRUCTION_STEMS").toEqual([]);
  });
});
