// scorer-vintage (A1b) — hash scope (ruling 4a: everything but display fields), the
// logicVersion default, and ruling 1's first-deploy edge (missing row ⇒ stampOnly, never drift).
import { describe, expect, test } from "vitest";
import type { DerivedView, Indicator } from "./domain-types.js";
import * as Rows from "./family-descriptor-rows.js";
import { ALL_INDICATORS } from "./registry.js";
import type { ScorerVintageRow } from "./store.js";
import { codeVintages, configHashFor, diffVintages } from "./scorer-vintage.js";

const base = (over: Partial<Indicator> = {}): Indicator => ({
  id: "TV1",
  label: "TV",
  longLabel: "Test vintage indicator",
  series: "TESTSERIES",
  channel: "FIN",
  thresholds: { amberLevel: 1, redLevel: 2 },
  ...over,
});

const rowFor = (i: Indicator, over: Partial<ScorerVintageRow> = {}): ScorerVintageRow => ({
  indicator_id: i.id,
  config_hash: configHashFor(i),
  logic_version: i.logicVersion ?? 1,
  stamped_at: "2026-09-01T00:00:00.000Z",
  ...over,
});

describe("configHashFor - per-id scorer tables off the registry entry", () => {
  const live = (id: string): Indicator => ALL_INDICATORS.find((i) => i.id === id)!;
  const withField = <T,>(o: object, k: string, v: unknown, f: () => T): T => {
    const r = o as Record<string, unknown>;
    const had = Object.hasOwn(r, k);
    const old = r[k];
    r[k] = v;
    try { return f(); } finally { if (had) r[k] = old; else delete r[k]; }
  };

  test("a scored table row edit moves the hash; its `chart` and an unscored table do not", () => {
    const cg = configHashFor(live("CG"));
    expect(withField(Rows.RATIO_DESCRIPTOR_OF.CG!.levelBand!, "redP", 0.2, () => configHashFor(live("CG")))).not.toBe(cg);
    const bund = configHashFor(live("BUND"));
    expect(Rows.RATIO_DESCRIPTOR_OF.BUND).toHaveProperty("chart");
    expect(withField(Rows.RATIO_DESCRIPTOR_OF.BUND!, "chart", { label: "x" }, () => configHashFor(live("BUND")))).toBe(bund);
    const f13 = configHashFor(live("F13"));
    expect(withField(Rows.SECOND_LEG_CHART_OF.F13!, "label", "renamed", () => configHashFor(live("F13")))).toBe(f13);
    const fxh = configHashFor(live("FXH"));
    const legs = [...Rows.CHART_DESCRIPTOR_OF.FXH!.seriesIds!].reverse();
    expect(withField(Rows.CHART_DESCRIPTOR_OF.FXH!, "seriesIds", legs, () => configHashFor(live("FXH")))).not.toBe(fxh);
    expect(withField(Rows.CHART_DESCRIPTOR_OF.FXH!, "probeField", 1, () => configHashFor(live("FXH")))).toBe(fxh);
  });

  test("every `*_OF`/`*_OVERRIDES` table outside NOT_HASHED moves its id's hash on a row edit", () => {
    // unscored · CHART_DESCRIPTOR_OF field-hashed (above) · RS_CUT_OVERRIDES copied into the registry's `derived`
    const NOT_HASHED = new Set(["FAMILY_OF", "SECOND_LEG_CHART_OF", "CHART_PARAMS_OF", "CHART_DESCRIPTOR_OF", "RS_CUT_OVERRIDES"]);
    const blind: string[] = [];
    const tables = (Object.entries(Rows) as [string, unknown][]).filter(([k]) => /_(OF|OVERRIDES)$/.test(k) && !NOT_HASHED.has(k));
    for (const [name, table] of tables as [string, Record<string, unknown>][]) {
      const id = Object.keys(table).find((k) => ALL_INDICATORS.some((i) => i.id === k));
      if (id === undefined) continue; // empty seam (COMPOSITE_LEVEL_BAND_OF) — nothing to restate
      const row = table[id]!;
      const before = configHashFor(live(id));
      const after = Array.isArray(row)
        ? (() => { row.push({ probe: 1 }); try { return configHashFor(live(id)); } finally { row.pop(); } })()
        : withField(row, "probeField", 1, () => configHashFor(live(id)));
      if (after === before) blind.push(`${name}.${id}`);
    }
    expect(tables.length).toBeGreaterThan(5);
    expect(blind).toEqual([]);
  });

  // Scorers reading `*_DESCRIPTOR.scorer.constants` directly (no registry copy, no table row).
  const constantsOf = (v: unknown): Record<string, unknown> | undefined => {
    const c = (v as { scorer?: { constants?: unknown } } | null)?.scorer?.constants;
    return c !== null && typeof c === "object" ? (c as Record<string, unknown>) : undefined;
  };
  const allHashes = (): Map<string, string> => new Map(ALL_INDICATORS.map((i) => [i.id, configHashFor(i)]));

  test("a DISP_DESCRIPTOR.scorer.constants edit moves DISP's hash and no other id's", () => {
    const before = allHashes();
    const after = withField(Rows.DISP_DESCRIPTOR.scorer.constants, "corr", 0.8, allHashes);
    expect(after.get("DISP")).not.toBe(before.get("DISP"));
    expect(after.get("GT")).toBe(before.get("GT"));
    expect([...after].filter(([id, h]) => before.get(id) !== h).map(([id]) => id)).toEqual(["DISP"]);
  });

  test("every `*_DESCRIPTOR.scorer.constants` edit moves its own id's hash, outside NO_VINTAGE_ROW", () => {
    // Ids `codeVintages` never stamps (not in ALL_INDICATORS): XDEV_GATE has no indicator; FDX/VTP are scored
    // outside the registry roster.
    const NO_VINTAGE_ROW = ["FDX_DESCRIPTOR", "VTP_DESCRIPTOR", "XDEV_GATE_DESCRIPTOR"];
    const descs = (Object.entries(Rows) as [string, unknown][]).filter(([k, v]) => k.endsWith("_DESCRIPTOR") && constantsOf(v));
    const blind: string[] = [];
    const misread: string[] = [];
    for (const [name, desc] of descs) {
      const before = allHashes();
      const after = withField(constantsOf(desc)!, "probeField", 1, allHashes);
      const moved = [...after].filter(([id, h]) => before.get(id) !== h).map(([id]) => id);
      const own = name.slice(0, -"_DESCRIPTOR".length);
      if (moved.length === 0) blind.push(name);
      else if (before.has(own) && !moved.includes(own)) misread.push(`${name} moved ${moved.join(",")}`);
    }
    expect(descs.map(([k]) => k)).toContain("DISP_DESCRIPTOR"); // walker anchor
    expect(blind.sort()).toEqual(NO_VINTAGE_ROW);
    expect(misread).toEqual([]);
    for (const n of NO_VINTAGE_ROW) expect(ALL_INDICATORS.some((i) => `${i.id}_DESCRIPTOR` === n)).toBe(false);
  });
});

describe("configHashFor - hash scope (ruling 4a)", () => {
  test("display-only edits (label/longLabel/unit) leave the hash unchanged", () => {
    const h = configHashFor(base());
    expect(configHashFor(base({ label: "RENAMED" }))).toBe(h);
    expect(configHashFor(base({ longLabel: "A whole new long label" }))).toBe(h);
    expect(configHashFor(base({ unit: "bp" }))).toBe(h);
  });

  test("a displayOnly derived block hashes kind/window only; a scored one hashes whole", () => {
    const dv: DerivedView = { kind: "worstDrop", window: 21, amber: -0.1, red: -0.2, label: "worst drop", unit: "%" };
    const shown = (over: Partial<DerivedView> = {}) => configHashFor(base({ derived: { ...dv, ...over, displayOnly: true } }));
    const h = shown();
    expect(shown({ amber: -0.05, red: -0.3, label: "renamed", unit: "" })).toBe(h); // bands/labels: display only
    expect(shown({ window: 30 })).not.toBe(h); // window feeds the persisted decision (decisionAt)
    const scored = configHashFor(base({ derived: dv }));
    expect(configHashFor(base({ derived: { ...dv, amber: -0.05 } }))).not.toBe(scored);
  });

  test("a direction edit changes the hash", () => {
    expect(configHashFor(base({ direction: "LOW" }))).not.toBe(configHashFor(base()));
  });

  test("a value the hash could only misrepresent throws instead of hashing as {}/null", () => {
    const withExtra = (v: unknown): Indicator => ({ ...base(), extra: v }) as unknown as Indicator;
    expect(() => configHashFor(withExtra(new Set(["a"])))).toThrow(/non-plain object \(Set\)/);
    expect(() => configHashFor(withExtra(new Date(0)))).toThrow(/non-plain object \(Date\)/);
    expect(() => configHashFor(withExtra({ nested: new Map() }))).toThrow(/non-plain object \(Map\)/);
    expect(() => configHashFor(withExtra(Number.POSITIVE_INFINITY))).toThrow(/non-finite number Infinity/);
    expect(() => configHashFor(withExtra(Number.NaN))).toThrow(/non-finite number NaN/);
    // JSON-shaped values (nested plain objects, arrays, null-proto objects) still hash
    expect(configHashFor(withExtra({ a: [1, { b: null }] }))).toMatch(/^[0-9a-f]{12}$/);
    expect(configHashFor(withExtra(Object.create(null)))).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("diffVintages", () => {
  test("absent logicVersion diffs equal to an explicit 1", () => {
    const noVersion = base();
    const explicit = base({ logicVersion: 1 });
    expect(configHashFor(noVersion)).toBe(configHashFor(explicit)); // logicVersion is its own axis, stripped from the hash
    const { drift, stampOnly } = diffVintages([rowFor(noVersion)], [rowFor(explicit)]);
    expect(drift).toEqual([]);
    expect(stampOnly).toEqual([]);
  });

  test("missing stored row ⇒ stampOnly, never drift (ruling 1's first-deploy edge)", () => {
    const i = base();
    const { drift, stampOnly } = diffVintages([rowFor(i)], []);
    expect(drift).toEqual([]);
    expect(stampOnly).toEqual(["TV1"]);
  });

  test("equal hash but lower stored logic_version ⇒ drift", () => {
    const i = base({ logicVersion: 2 });
    const stored = rowFor(i, { logic_version: 1 });
    const { drift, stampOnly } = diffVintages([rowFor(i)], [stored]);
    expect(stampOnly).toEqual([]);
    expect(drift).toEqual([
      { id: "TV1", configHash: { old: stored.config_hash, new: stored.config_hash }, logicVersion: { old: 1, new: 2 } },
    ]);
  });

  test("a config-hash change ⇒ drift naming both hashes", () => {
    const i = base();
    const retuned = base({ thresholds: { amberLevel: 1, redLevel: 3 } });
    const { drift } = diffVintages([rowFor(retuned)], [rowFor(i)]);
    expect(drift).toEqual([
      { id: "TV1", configHash: { old: configHashFor(i), new: configHashFor(retuned) }, logicVersion: { old: 1, new: 1 } },
    ]);
  });
});

describe("codeVintages", () => {
  test("one row per ALL_INDICATORS id, 12-lowercase-hex hashes, stamped at `now`", () => {
    const now = new Date("2026-09-05T12:00:00.000Z");
    const rows = codeVintages(now);
    expect(rows.map((r) => r.indicator_id).sort()).toEqual(ALL_INDICATORS.map((i) => i.id).sort());
    expect(new Set(rows.map((r) => r.indicator_id)).size).toBe(rows.length);
    for (const r of rows) {
      expect(r.config_hash).toMatch(/^[0-9a-f]{12}$/);
      expect(r.logic_version).toBeGreaterThanOrEqual(1);
      expect(r.stamped_at).toBe(now.toISOString());
    }
  });
});
