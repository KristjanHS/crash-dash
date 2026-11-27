// Read schema: the md renderer's Criteria detail ignores tags over every committed
// leg JSON (Stage 2 narrowed the parity to that slice — the Grid prints them), and the scope / duplicate helpers are pinned at their own
// layer. The `/lab` renderer's parity twin lives in public/lab-reentry.test.js.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { duplicateReads, isReadTag, LEGS, makeTagOf, type LadderLegId, type LadderLive, readScope, renderLadderMd, type TaggedRead, type VerdictLeg } from "./ladder-live.js";
import { DUMMY_TAG, injectTags, stripTags } from "./ladder-reads.test-helpers.js";

const LEG_IDS = Object.keys(LEGS) as LadderLegId[];
const load = (leg: LadderLegId): LadderLive => JSON.parse(readFileSync(new URL(`../${LEGS[leg].json}`, import.meta.url), "utf8")) as LadderLive;
/** The untagged md per leg, rendered once and shared by every test below. */
const plainCache = new Map<LadderLegId, string>();
const plainMd = (leg: LadderLegId): string => {
  if (!plainCache.has(leg)) plainCache.set(leg, renderLadderMd(stripTags(load(leg)), leg));
  return plainCache.get(leg)!;
};
const section = (md: string, head: string): string => md.slice(md.indexOf(`## ${head}`) + 3).split("\n## ")[0]!;
/** The md with its `## Grid` section cut out — every other byte (Verdict, Criteria detail, Blockers, Episode gates, Signs, Read) must ignore tags,
 *  except the Signs board pointer (`family → tag.indicator`, the table's 4th cell, a probe row's finding cell + the `- board:` line) — `sansBoard` blanks those slots. */
const sansGrid = (md: string): string => {
  const grid = section(md, "Grid");
  expect(grid.length).toBeGreaterThan(40);
  return md.replace(`## ${grid}`, "");
};
const sansBoard = (md: string): string => {
  const signs = section(md, "Signs");
  expect(signs.length).toBeGreaterThan(40);
  const probeRows = (s: string): string => s.replace(/^(\|[^|\n]*\|[^|\n]*\|)([^|\n]*)\|\2\|/gm, "$1||"); // a probe row's finding cell IS its board pointer
  return md.replace(`## ${signs}`, `## ${probeRows(signs).replace(/^- board: .*$/gm, "- board:").replace(/^(\|[^|\n]*\|[^|\n]*\|[^|\n]*\|)[^|\n]*\|/gm, "$1|")}`);
};

describe("renderLadderMd ignores read tags everywhere but the Grid and the Signs board pointer", () => {
  it.each(LEG_IDS)("%s: tags reach only the Grid + the Signs board pointer — a fully tagged md (board pointer blanked) and a row-tagged md are byte-identical to the untagged JSON outside the Grid; the whole md differs (the Grid prints tags)", (leg) => {
    const live = stripTags(load(leg));
    const before = structuredClone(live);
    const plain = plainMd(leg);
    // Every row + family tagged: a family tag reaches only the Signs board pointer (table cell + `- board:` line).
    const allMd = renderLadderMd(injectTags(live), leg);
    expect(sansGrid(allMd)).toContain("→ TAGGED-indicator"); // every committed leg has a family naming a sign row
    expect(sansBoard(sansGrid(allMd))).toBe(sansBoard(sansGrid(plain)));
    expect(sansBoard(sansGrid(allMd))).not.toContain("TAGGED");
    // Rows tagged, families untagged (family tags print in the board pointer — pinned above): nothing outside the Grid moves.
    const tagged = injectTags(live);
    if (tagged.verdict?.escalation.families) tagged.verdict.escalation.families = live.verdict!.escalation.families;
    expect(live.verdict?.legs.length).toBeGreaterThan(0);
    expect(tagged.verdict?.legs.every((l) => l.tag === undefined)).toBe(false); // the fixture really differs from the stripped file
    expect(live).toEqual(before); // injectTags deep-copies — the loaded fixture is untouched
    const md = renderLadderMd(tagged, leg);
    expect(sansGrid(md)).toBe(sansGrid(plain));
    expect(sansGrid(md)).not.toContain("TAGGED"); // the canary strings reach nothing but the Grid
    expect(md).not.toBe(plain); // the exclusion is real: the Grid renders the tags
  });
  it.each(LEG_IDS)("%s: an untagged JSON renders the Grid's empty-state line naming the leg's --into run; a tagged one (the committed file after that run) renders rows", (leg) => {
    const live = load(leg);
    const grid = section(plainMd(leg), "Grid");
    expect(grid).toContain(`_no read tags yet — run \`npm run ${LEGS[leg].probe} -- --into=${LEGS[leg].json}\`_`);
    expect(grid).not.toContain("| indicator |");
    const tagged = live.verdict?.legs.some((l) => l.tag) ?? false;
    expect(section(renderLadderMd(live, leg), "Grid").includes("| indicator | job | T1 | T2 | T3 |")).toBe(tagged);
  });
  it("injectTags stamps every family too", () => {
    const live = load("value");
    expect(live.verdict?.escalation.families?.length).toBeGreaterThan(0);
    expect(injectTags(live).verdict?.escalation.families?.every((f) => f.tag?.indicator === DUMMY_TAG.indicator)).toBe(true);
  });
});

const tag = (indicator: string, job: TaggedRead["tag"] extends infer T ? (T extends { job: infer J } ? J : never) : never, agg: "kOfN" | "allOf" | "box", series = [indicator]) => ({ indicator, series, job, agg });

describe("duplicateReads", () => {
  it("groups ≥ 2 rows sharing indicator + job + agg, in emit order, sorted by indicator/job/agg", () => {
    const reads: TaggedRead[] = [
      { key: "t3-hy", tag: tag("HY OAS", "level", "allOf") },
      { key: "t1-xdev", tag: tag("XDEV", "speed", "kOfN") },
      { key: "t2-hy", tag: tag("HY OAS", "level", "allOf") },
      { key: "t2-xdev", tag: tag("XDEV", "speed", "kOfN") },
      { key: "t1-hy-veto", tag: tag("HY OAS", "speed", "allOf") }, // same indicator, different job → not a clone
      { key: "t3-xdev-rel", tag: tag("XDEV", "relative", "kOfN") },
      { key: "untagged" },
    ];
    expect(duplicateReads(reads)).toEqual([
      { indicator: "HY OAS", job: "level", agg: "allOf", keys: ["t3-hy", "t2-hy"] },
      { indicator: "XDEV", job: "speed", agg: "kOfN", keys: ["t1-xdev", "t2-xdev"] },
    ]);
  });
  it("same indicator + job with a different agg is not a clone; an empty or untagged list reports nothing", () => {
    expect(duplicateReads([{ key: "a", tag: tag("X", "level", "kOfN") }, { key: "b", tag: tag("X", "level", "allOf") }])).toEqual([]);
    expect(duplicateReads([])).toEqual([]);
    expect(duplicateReads([{ key: "a" }, { key: "b" }])).toEqual([]);
  });
});

describe("readScope", () => {
  it("derives each indicator + job's tranches from its rows, in T1·T2·T3 order, skipping untagged rows", () => {
    const row = (tranche: VerdictLeg["tranche"], t?: VerdictLeg["tag"]): Pick<VerdictLeg, "tranche" | "tag"> => ({ tranche, ...(t && { tag: t }) });
    const rows = [row("T3", tag("HY OAS", "level", "allOf")), row("T2", tag("HY OAS", "level", "allOf")), row("T1", tag("HY OAS", "speed", "allOf")), row("T2", tag("HY OAS", "level", "kOfN")), row("T1")];
    expect(readScope(rows)).toEqual([
      { indicator: "HY OAS", job: "level", tranches: ["T2", "T3"] },
      { indicator: "HY OAS", job: "speed", tranches: ["T1"] },
    ]);
  });
});

describe("makeTagOf", () => {
  const tagOf = makeTagOf({ F1: "HY OAS", CCC: "CCC" });
  it("derives a single-series row's indicator from the table; a named one wins", () => {
    expect(tagOf({ series: ["F1"], job: "level", agg: "kOfN" })).toEqual({ indicator: "HY OAS", series: ["F1"], job: "level", agg: "kOfN" });
    expect(tagOf({ series: ["F1", "CCC"], job: "composite", agg: "box", indicator: "credit", variant: "v" })).toEqual({ indicator: "credit", series: ["F1", "CCC"], job: "composite", agg: "box", variant: "v" });
  });
  it("throws on a multi-series row without `indicator` — never falls back to series[0]'s name", () => {
    expect(() => tagOf({ series: ["F1", "CCC"], job: "composite", agg: "kOfN" })).toThrow("a multi-series read names its indicator: F1+CCC");
  });
});

describe("isReadTag", () => {
  it("accepts a full tag, rejects a missing field, an unknown enum value and an empty series on a non-manual job", () => {
    expect(isReadTag(tag("HY OAS", "level", "allOf"))).toBe(true);
    expect(isReadTag({ indicator: "x", series: [], job: "manual", agg: "box" })).toBe(true);
    expect(isReadTag({ indicator: "x", series: [], job: "level", agg: "box" })).toBe(false);
    expect(isReadTag({ indicator: "x", series: ["F1"], job: "velocity", agg: "box" })).toBe(false);
    expect(isReadTag({ indicator: "x", series: ["F1"], job: "level" })).toBe(false);
    expect(isReadTag({ indicator: "", series: ["F1"], job: "level", agg: "allOf" })).toBe(false);
    expect(isReadTag(null)).toBe(false);
  });
});
