/**
 * The read-tag and roster lints every ladder leg owes, written once over a per-leg adapter.
 * Each `LEG_TAGS` / `LEG_ROSTERS` row names that leg's own tagged rows, evaluator and dash roster — the per-leg
 * facts are data here, the assertions are shared. A leg-specific pin with no twin stays in its own probe test.
 */
import { describe, expect, it } from "vitest";
import { META } from "../src/api/http.js";
import { BOX_INDICATOR, isReadTag, toVerdict, type ClusterView, type ReadTag } from "../src/ladder-live.js";
import type { Pt } from "./ladder-replay.js";
import * as eufin from "./probe-eufin-tranches.js";
import * as semis from "./probe-semis-tranches.js";
import * as semisSeries from "./semis-series.js";
import * as semisWatch from "./semis-watch.js";
import * as sp500 from "./probe-sp500-tranches.js";
import * as spit from "./probe-spit-tranches.js";
import * as value from "./probe-value-tranches.js";

type Tagged = { key: string; tag?: ReadTag; gate?: boolean };
type Emitted = { legs: readonly { key: string; tag?: ReadTag }[]; escalation: { families: readonly { name: string; tag?: ReadTag }[] } };
/** What one evaluation emits, as `[key, tag]` rows — legs, then box families. */
const emitRows = (res: Emitted) => ({ legs: res.legs.map((l) => [l.key, l.tag]), families: res.escalation.families.map((f) => [f.name, f.tag]) });
/** What it should emit: each def's tag on its leg row, each box family's on its family row. */
const defRows = (defs: readonly Tagged[], families: readonly (readonly [string, ReadTag])[]) => ({ legs: defs.map((d) => [d.key, d.tag]), families: families.map(([f, t]) => [f, t]) });
const emptyOf = <S extends string>(ids: readonly S[]) => Object.fromEntries(ids.map((id) => [id, []])) as unknown as Record<S, never[]>;
/** Each emitted box cluster member as a tagged row (`key` = its id). */
const memberRows = (res: { escalation: { clusters: readonly ClusterView[] } }): Tagged[] => res.escalation.clusters.flatMap((c) => c.members.map((m) => ({ key: m.id, tag: m.tag })));
/** A series set: every id reads `[]`, except `fill` (if any) reads 400 synthetic final closes; `seen` records each id read. */
const seriesSet = (seen: Set<string>, fill?: string) => {
  const pts: Pt[] = Array.from({ length: 400 }, (_, i) => ({ date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10), value: 2 + Math.sin(i / 7) + i / 100, state: "RED" }));
  return new Proxy({} as Record<string, Pt[]>, { get: (_t, k) => (typeof k === "string" ? (seen.add(k), k === fill ? pts : []) : undefined) });
};
/** Member → the ids its ruled read consumes, off the read itself: id k is member m's iff filling k alone changes m's read. */
const consumedIds = (ruled: LegTags["ruled"]): Record<string, string[]> => {
  const universe = new Set<string>();
  const base = ruled(seriesSet(universe));
  const out: Record<string, string[]> = Object.fromEntries(Object.keys(base).map((m) => [m, []]));
  for (const id of universe) {
    const got = ruled(seriesSet(new Set(), id));
    for (const m of Object.keys(base)) if (JSON.stringify(got[m]) !== JSON.stringify(base[m])) out[m]!.push(id);
  }
  return Object.fromEntries(Object.entries(out).map(([m, ids]) => [m, ids.sort()]));
};

interface LegTags {
  leg: string;
  /** Every tagged row the leg carries — static defs, box families, TAGGED_READS (and value's arm defs). */
  tagged: readonly Tagged[];
  /** TAGGED_READS keys, and what they must be: every LEGS key then every box family. */
  readKeys: readonly [readonly string[], readonly string[]];
  indicator: Readonly<Record<string, string>>;
  /** `[got, want]` emitted-vs-def rows off the leg's own evaluator. */
  emit: () => readonly [unknown, unknown];
  /** The named-variant pin: every `"<key> <variant>"` row of `tagged`, sorted. */
  variants: readonly string[];
  /** Each emitted box cluster member's row, off the leg's own evaluator. */
  members: () => readonly Tagged[];
  /** The leg's ruled member read (`ruledReads` / `memberReads`) over a series set. */
  ruled: (s: Record<string, Pt[]>) => Readonly<Record<string, unknown>>;
}

const eufinRows = [...eufin.LEGS, ...eufin.FAST_LEGS, ...eufin.FAST_LEGS_AT1];
const valueTags: Tagged[] = [...value.LEGS, ...value.LEGS_SHIPPED, ...Object.entries(value.FAMILY_TAG).map(([key, tag]) => ({ key, tag })), ...value.TAGGED_READS];
const valueFamilies = Object.entries(value.FAMILY_TAG);

const LEG_TAGS: readonly LegTags[] = [
  {
    leg: "eufin",
    tagged: [...eufinRows, ...eufin.TAGGED_READS, ...eufin.FAST_TAGGED_READS],
    readKeys: [eufin.TAGGED_READS.map((t) => t.key), [...eufin.LEGS.map((d) => d.key), ...eufin.ESC_FAMILIES]],
    indicator: eufin.INDICATOR,
    emit: () => {
      const E = emptyOf(eufin.SERIES);
      const fams = eufin.ESC_FAMILIES.map((f) => [f, eufin.FAMILY_TAG[f]] as const);
      return [
        [emitRows(eufin.evaluate(E)), emitRows(eufin.evaluate(E, eufin.FAST_RULES, eufin.FAST_LEGS)), toVerdict(eufin.evaluateShipped(E), false).legs.every((l) => isReadTag(l.tag))],
        [defRows(eufin.LEGS, fams), defRows(eufin.FAST_LEGS, fams), true],
      ];
    },
    variants: [],
    members: () => memberRows(eufin.evaluate(emptyOf(eufin.SERIES))),
    ruled: (s) => eufin.ruledReads(s as eufin.SeriesSet, eufin.TRANCHE_RULES),
  },
  {
    leg: "value",
    tagged: [...valueTags, ...value.VALUE_ARMS.flatMap((a) => a.defs)],
    readKeys: [value.TAGGED_READS.map((t) => t.key), [...value.LEGS.map((d) => d.key), ...value.FAMILIES]],
    indicator: value.INDICATOR,
    emit: () => [emitRows(value.evaluateShipped(emptyOf(value.SERIES), [])), defRows(value.LEGS, valueFamilies)],
    // t1-banks = the BANKS fam's T1 rung, shipped("t2-kbe") re-keyed
    variants: ["kbe_rs_drop pctΔ21", "rates_jump absΔ21", "t1-banks worstDrop", "t1-veto σret", "t2-kbe worstDrop", "t2-veto σret", "t3-ew-trend maΔ10", "t3-low aboveLow", "t3-veto σret"],
    members: () => memberRows(value.evaluateShipped(emptyOf(value.SERIES), [])),
    ruled: (s) => value.memberReads({ s: s as value.SeriesSet, signs: [] }, value.VALUE_RULES),
  },
  {
    leg: "semis",
    tagged: [...semis.LEGS, ...semis.TAGGED_READS, ...semisWatch.SEMIS_WATCH.flatMap((d) => ("tag" in d && d.tag.job !== "manual" ? [{ key: `watch-${d.key}`, tag: d.tag }] : []))],
    readKeys: [semis.TAGGED_READS.map((t) => t.key), [...semis.LEGS.map((d) => d.key), ...semis.BOX_SIGNS]],
    indicator: semisSeries.INDICATOR,
    emit: () => [emitRows(semis.evaluateShipped(emptyOf(semisSeries.SERIES), [])), defRows(semis.LEGS, semis.BOX_SIGNS.map((b) => [b, semis.BOX_TAG[b]] as const))],
    variants: ["cg_drop pctΔ20", "real_yield absΔ120", "t1-capex absΔ10", "t1-memory absΔ10", "watch-bbb absΔ10∨lowRise", "watch-hcx absΔ20", "watch-hy absΔ10", "watch-rs pctΔ20", "watch-ry absΔ20", "watch-stretch k×MA200", "watch-vxsmh pctΔ10", "yen_carry worstΔ10"],
    members: () => memberRows(semis.evaluateShipped(emptyOf(semisSeries.SERIES), [])),
    ruled: (s) => semis.ruledReads({ s: s as semisSeries.SeriesSet, signs: [], exit: "", start: "" }, semis.SEMIS_RULES),
  },
  {
    leg: "spit",
    tagged: [...spit.LEGS, ...spit.TAGGED_READS],
    readKeys: [spit.TAGGED_READS.map((t) => t.key), [...spit.LEGS.map((d) => d.key), ...spit.BOX_SIGNS]],
    indicator: spit.INDICATOR,
    emit: () => [emitRows(spit.evaluateShipped(emptyOf(spit.SERIES), [])), defRows(spit.LEGS, spit.BOX_SIGNS.map((b) => [b, spit.TAGGED_READS.find((t) => t.key === b)!.tag!] as const))],
    variants: ["real_yield absΔ120", "t1-rates absΔ63", "t1-veto σret", "t2-veto σret", "t3-veto σret"],
    members: () => memberRows(spit.evaluateShipped(emptyOf(spit.SERIES), [])),
    ruled: (s) => spit.ruledReads({ s: s as spit.SeriesSet, signs: [], exit: "" }, spit.SPIT_RULES),
  },
  {
    leg: "sp500",
    tagged: [...sp500.LEGS, ...sp500.TAGGED_READS],
    readKeys: [sp500.TAGGED_READS.map((t) => t.key), [...sp500.LEGS.map((d) => d.key), ...sp500.BOX_SIGNS]],
    indicator: sp500.INDICATOR,
    emit: () => [emitRows(sp500.evaluateShipped(emptyOf(sp500.SERIES), [])), defRows(sp500.LEGS, sp500.BOX_SIGNS.map((b) => [b, sp500.TAGGED_READS.find((t) => t.key === b)!.tag!] as const))],
    variants: ["real_yield absΔ120", "t1-rates absΔ63", "t1-veto σret", "t2-veto σret", "t3-veto σret"],
    members: () => memberRows(sp500.evaluateShipped(emptyOf(sp500.SERIES), [])),
    ruled: (s) => sp500.ruledReads({ s: s as sp500.SeriesSet, signs: [], exit: "" }, sp500.SP500_RULES),
  },
];

/** Named variants (ladder-reads-stage3-speed, Stage 3): the non-z `speed` reads, each `"<key> <variant>"` row of a roster whose tag carries one — every such tag passes `isReadTag`. */
const variantRows = (rows: readonly Tagged[]): string[] => {
  const tagged = rows.filter((r) => r.tag?.variant !== undefined);
  for (const r of tagged) expect(isReadTag(r.tag), r.key).toBe(true);
  return [...new Set(tagged.map((r) => `${r.key} ${r.tag!.variant}`))].sort();
};

/** Every tag a leg carries: its static rows, then each emitted box cluster member. */
const allTagged = (a: LegTags): Tagged[] => [...a.tagged, ...a.members()];

describe("read tags — every leg", () => {
  it("every tagged row carries a structurally valid tag; TAGGED_READS is every LEGS row then every box family", () => {
    expect(LEG_TAGS.flatMap((a) => allTagged(a).filter((t) => !isReadTag(t.tag)).map((t) => `${a.leg} ${t.key}`))).toEqual([]);
    expect(LEG_TAGS.map((a) => [a.leg, a.readKeys[0]])).toEqual(LEG_TAGS.map((a) => [a.leg, a.readKeys[1]]));
  });
  it("each leg's evaluator copies each def's tag onto its leg rows and each box family's onto its family rows", () => {
    const emitted = LEG_TAGS.map((a) => [a.leg, a.emit()] as const);
    expect(emitted.map(([leg, [got]]) => [leg, got])).toEqual(emitted.map(([leg, [, want]]) => [leg, want]));
  });
  it("each distinct series set maps to exactly one indicator; a single-series row's is INDICATOR[series[0]]", () => {
    // a manual (sign-only) tag reads no series — `series: []` keys no set, as the semis watch list drops its manual rows;
    // an escalation-box gate row names the box, not a series — its `series` is the members' union (pinned by the ⊇ test below), which a one-member box shares with that member's own rows
    const seriesRows = (a: LegTags) => allTagged(a).filter(({ tag }) => tag!.indicator !== BOX_INDICATOR);
    const split = LEG_TAGS.flatMap((a) => {
      const byKey = new Map<string, Set<string>>();
      for (const { tag } of seriesRows(a).filter(({ tag }) => tag!.job !== "manual" && tag!.series.length > 0)) byKey.set([...tag!.series].sort().join("+"), (byKey.get([...tag!.series].sort().join("+")) ?? new Set()).add(tag!.indicator));
      return [...byKey].filter(([, names]) => names.size !== 1).map(([k, names]) => `${a.leg} ${k}: ${[...names].join(" | ")}`);
    });
    expect(split).toEqual([]);
    expect(LEG_TAGS.flatMap((a) => seriesRows(a).filter(({ tag }) => tag!.series.length === 1 && tag!.indicator !== a.indicator[tag!.series[0]!]).map((t) => `${a.leg} ${t.key}`))).toEqual([]);
  });
  it.each(LEG_TAGS.map((a) => [a.leg, a] as const))("%s: the named-variant rows are exactly its pinned list", (_, a) => {
    expect(variantRows(allTagged(a))).toEqual(a.variants);
  });
  it("each box cluster member's tag `series` is exactly the ids its ruled read consumes", () => {
    const want = LEG_TAGS.map((a) => [a.leg, consumedIds(a.ruled)] as const);
    expect(want.flatMap(([leg, ids]) => Object.entries(ids).filter(([, s]) => !s.length).map(([m]) => `${leg} ${m}`))).toEqual([]);
    expect(LEG_TAGS.map((a) => [a.leg, Object.fromEntries(a.members().map((m) => [m.key, [...(m.tag?.series ?? [])].sort()]))])).toEqual(want);
  });
  it("each escalation-box gate row's tag `series` ⊇ every box cluster member's tag `series`", () => {
    const boxRows = LEG_TAGS.map((a) => [a.leg, a.tagged.filter((t) => t.gate && t.tag?.indicator === BOX_INDICATOR).length > 0] as const);
    expect(boxRows).toEqual(LEG_TAGS.map((a) => [a.leg, true]));
    const missing = LEG_TAGS.flatMap((a) => ((want) => a.tagged.filter((t) => t.gate && t.tag?.indicator === BOX_INDICATOR).flatMap((r) => want.filter((id) => !r.tag!.series.includes(id)).map((id) => `${a.leg} ${r.key} ${id}`)))([...new Set(a.members().flatMap((m) => m.tag?.series ?? []))]));
    expect([...new Set(missing)]).toEqual([]);
  });
});

/** Each leg's dash roster: SERIES (every id must be served by /api/series), the ids a leg may read, and the ids kept off the verdict. */
const LEG_ROSTERS = [
  { leg: "value", series: value.SERIES, reads: [...value.SERIES, ...value.LIVE_FEEDS], defs: value.LEGS, verdict: undefined },
  { leg: "semis", series: semisSeries.SERIES, reads: semisSeries.SERIES, defs: semis.LEGS, verdict: { ids: semis.VERDICT_IDS, off: ["RS_SMH", "F17", "VXSMH"] } },
  { leg: "spit", series: spit.SERIES, reads: spit.SERIES, defs: spit.LEGS, verdict: { ids: spit.VERDICT_IDS, off: [] } },
  { leg: "sp500", series: sp500.SERIES, reads: sp500.SERIES, defs: sp500.LEGS, verdict: { ids: sp500.VERDICT_IDS, off: ["R5", "SPY"] } },
] as const satisfies readonly { leg: string; series: readonly string[]; reads: readonly string[]; defs: readonly { key: string; src: { id: string } }[]; verdict?: { ids: ReadonlySet<string>; off: readonly string[] } }[];

describe("roster — every leg", () => {
  it("every dash id is served by /api/series; every leg reads a roster id; the verdict reads SERIES less the off-verdict ids", () => {
    expect(LEG_ROSTERS.flatMap((r) => r.series.filter((id) => !META.has(id)).map((id) => `${r.leg} ${id}`))).toEqual([]);
    expect(LEG_ROSTERS.flatMap((r) => r.defs.filter((d) => !(r.reads as readonly string[]).includes(d.src.id)).map((d) => `${r.leg} ${d.key}`))).toEqual([]);
    const withVerdict = LEG_ROSTERS.flatMap((r) => (r.verdict ? [{ leg: r.leg, series: r.series as readonly string[], ...r.verdict }] : []));
    expect(withVerdict.map((r) => [r.leg, [...r.ids].sort()])).toEqual(withVerdict.map((r) => [r.leg, r.series.filter((id) => !(r.off as readonly string[]).includes(id)).sort()]));
  });
});
