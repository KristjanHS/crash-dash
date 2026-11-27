// Seam test for the per-leg top-indicator config + resolver (public/leg-top.js). Plain `.js` so vitest
// collects it and tsc skips it; TS imports are EXTENSIONLESS (frontend.md — a `.js` specifier
// makes vite report `no tests`, a collection error that reads like a pass).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { describe, it, expect } from "vitest";
import { LEG_TOP, TOP_N, topIndicatorsFor, DEFAULT_LEG, OFF_LADDER_LEGS } from "./leg-top.js";
import { LEG_DESC } from "./leg-desc.js";
import { LEG_FIELD } from "../src/danger-ladder";
import { ALL_INDICATORS, depthFromRegistry } from "../src/registry";
import { CHART_ONLY_IDS } from "../src/registry-composite";
import { EUFIN_BACKFILL_YEARS, SEMIS_BACKFILL_YEARS } from "../src/backfill-depth";
import { depthSince, isoCutoff } from "../scripts/restate-policy";

const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");
const SLEEVES = LEG_FIELD.map((l) => l.sleeve);
// A LEG_TOP key is a ladder sleeve OR a declared off-ladder leg (Commodities) — unioned from the
// source, never hand-typed, so a new off-ladder leg widens this set automatically.
const LEG_KEYS = new Set([...SLEEVES, ...OFF_LADDER_LEGS]);
// Chart-only ids (`HCX` today) are servable + chartable via /api/indicators, so a hand row may
// seat one; they carry no MEMBER_WEIGHT, so such a row can never be read back as a ranking.
const REGISTRY_IDS = new Set([...ALL_INDICATORS.map((i) => i.id), ...CHART_ONLY_IDS]);

describe("LEG_TOP config", () => {
  it("keys every row by a real LEG_FIELD sleeve or a declared off-ladder leg", () => {
    for (const key of Object.keys(LEG_TOP)) expect(LEG_KEYS.has(key), key).toBe(true);
  });

  // Length is asserted against TOP_N, never a literal — the seat count has moved once (5 → 8,
  // 2026-09-01) and the resolver's auto path slices to the same constant.
  it("names only real registry ids, exactly TOP_N per row, no duplicates", () => {
    for (const [key, row] of Object.entries(LEG_TOP)) {
      expect(row.ids, key).toHaveLength(TOP_N);
      expect(new Set(row.ids).size, key).toBe(TOP_N);
      for (const id of row.ids) expect(REGISTRY_IDS.has(id), `${key}: ${id}`).toBe(true);
    }
  });

  // ⚠ RETIRED, do not restore: "S&P 500 and S&P IT share no member" (`[USER]` 2026-08-29) was
  // superseded by the 5 → 8 expansion (`[USER]` 2026-09-01) — the no-duplicate-seats argument was
  // reasoned for 10 combined seats and does not survive 16. `HCX` deliberately sits on both.
  // What DOES still bind is per-row uniqueness, asserted above.

  // `doc` is optional (a row whose research doc was retired carries none); one that is set must resolve.
  it("every cited doc resolves to a real file under docs/", () => {
    const cited = Object.entries(LEG_TOP).filter(([, row]) => row.doc !== undefined);
    expect(cited.length).toBeGreaterThan(0); // the filter left something to check
    for (const [key, row] of cited)
      expect(existsSync(join(DOCS_DIR, row.doc)), `${key}: ${row.doc}`).toBe(true);
  });

  it("DEFAULT_LEG is a real sleeve AND a hand-researched LEG_TOP key", () => {
    expect(SLEEVES).toContain(DEFAULT_LEG);
    expect(Object.keys(LEG_TOP)).toContain(DEFAULT_LEG);
  });
});

describe("topIndicatorsFor", () => {
  // A leg the config does NOT cover — derived, so a future hand-research row for it flips this
  // fixture's premise loudly instead of letting the auto assertions go stale.
  const autoLeg = SLEEVES.find((s) => !(s in LEG_TOP));
  const configLeg = Object.keys(LEG_TOP)[0];

  it("config wins over auto, verbatim, even when the weights rank differently", () => {
    // Weights that would auto-rank a NON-config id first: if config didn't win, ids differ.
    const contrarian = { ZZZ: { [configLeg]: 9.9 } };
    const r = topIndicatorsFor(configLeg, contrarian);
    expect(r.source).toBe("config");
    expect(r.ids).toEqual(LEG_TOP[configLeg].ids);
  });

  it("auto ranks by the leg's weight descending and drops zero weights", () => {
    const weights = {
      A: { [autoLeg]: 0.4 },
      B: { [autoLeg]: 0 }, // zero = "does not reach that leg" — dropped, not ranked last
      C: { [autoLeg]: 1.0 },
      D: {}, // partial row omitting the leg entirely — same drop
      E: { [autoLeg]: 0.6 },
    };
    expect(topIndicatorsFor(autoLeg, weights)).toEqual({ ids: ["C", "E", "A"], source: "auto" });
  });

  it("auto takes the first TOP_N, breaking ties on the served key order (deterministic)", () => {
    // Roster DERIVED from TOP_N (one over), so the fixture follows a seat-count move instead of
    // going stale at a hand-typed 5/6.
    const roster = Array.from({ length: TOP_N + 1 }, (_, i) => `M${i + 1}`);
    const weights = Object.fromEntries(roster.map((id) => [id, { [autoLeg]: 0.5 }]));
    // All tied: stable sort keeps the served (insertion) order; the last one falls off.
    expect(topIndicatorsFor(autoLeg, weights).ids).toEqual(roster.slice(0, TOP_N));
  });

  it("falls back to auto for an unknown leg key", () => {
    const r = topIndicatorsFor("not-a-leg", { A: { "not-a-leg": 1 } });
    expect(r).toEqual({ ids: ["A"], source: "auto" });
  });

  it("returns empty rather than throwing while memberWeight is cold/failed", () => {
    expect(topIndicatorsFor(autoLeg, null)).toEqual({ ids: [], source: "auto" });
    expect(topIndicatorsFor(autoLeg, undefined)).toEqual({ ids: [], source: "auto" });
  });
});

const DEPTH_NOW = new Date("2026-10-24T00:00:00Z");
const seedsAtLeast = (id, years) => {
  const d = depthFromRegistry(id);
  return d !== undefined && depthSince(d, DEPTH_NOW) <= isoCutoff(DEPTH_NOW, years);
};

// [USER] 2026-09-24: every EU-Fin seat seeds ≥ EUFIN_BACKFILL_YEARS so the detail tab's `5y` chip paints
// a full span on the held leg. Off the SERVED roster: a seat swap without the depth declaration goes red.
describe("EU-Fin top-8 seed depth", () => {
  it.each(LEG_TOP["EU-Fin"].ids)("%s declares a registry depth of at least EUFIN_BACKFILL_YEARS", (id) => {
    expect(seedsAtLeast(id, EUFIN_BACKFILL_YEARS), JSON.stringify(depthFromRegistry(id))).toBe(true);
  });
});

// [USER] 2026-10-24: same for Semis, bar the seats whose source has no 5y to seed.
const SEMIS_SHALLOW = { VXSMH: "the index history starts 2025-09-16 (2026-10-25)" };
describe("Semis top-10 seed depth", () => {
  it.each(LEG_TOP.Semis.ids.filter((id) => !(id in SEMIS_SHALLOW)))("%s declares a registry depth of at least SEMIS_BACKFILL_YEARS", (id) => {
    expect(seedsAtLeast(id, SEMIS_BACKFILL_YEARS), JSON.stringify(depthFromRegistry(id))).toBe(true);
  });
  it.each(Object.keys(SEMIS_SHALLOW))("%s (excepted) is a current Semis seat that does not already seed 5y", (id) => {
    expect([LEG_TOP.Semis.ids.includes(id), seedsAtLeast(id, SEMIS_BACKFILL_YEARS)]).toEqual([true, false]);
  });
});

// ── LEG_DESC copy (ex-leg-desc.test.js) ────────────────────────────────────────────────────────
// Seam test for the per-leg basis/why copy (public/leg-desc.js). Plain `.js` so vitest collects it
// and tsc skips it; TS imports are EXTENSIONLESS (frontend.md — a `.js` specifier makes vite report
// `no tests`, a collection error that reads like a pass).
// SLEEVES / LEG_KEYS / REGISTRY_IDS are the module-level sets above (identical derivations).
describe("LEG_DESC copy", () => {
  const TOKEN = /\{([A-Za-z0-9_-]+)\}/g;

  it("keys only real LEG_FIELD sleeves or declared off-ladder legs", () => {
    for (const key of Object.keys(LEG_DESC)) expect(LEG_KEYS.has(key), key).toBe(true);
  });

  it("carries a non-empty basis for every one of the 9 sleeves", () => {
    for (const sleeve of SLEEVES) {
      expect(LEG_DESC, sleeve).toHaveProperty([sleeve]);
      expect(LEG_DESC[sleeve].basis.trim().length, sleeve).toBeGreaterThan(0);
    }
  });

  it("resolves every {ID} token in every why string to a real registry id", () => {
    for (const [key, { why }] of Object.entries(LEG_DESC)) {
      const tokens = [...why.matchAll(TOKEN)].map((m) => m[1]);
      expect(tokens.length, `${key}: has at least one {ID} token`).toBeGreaterThan(0);
      for (const id of tokens) expect(REGISTRY_IDS.has(id), `${key}: {${id}}`).toBe(true);
    }
  });

  // The <summary> promises "Why these indicators", so the prose must name the SAME set the stack
  // charts — order-free, but set-equal. Without this, a retune silently leaves the blurb
  // explaining charts that are no longer on screen.
  it("names exactly the leg's LEG_TOP ids, for every hand-researched leg", () => {
    for (const [key, { why }] of Object.entries(LEG_DESC)) {
      const ids = LEG_TOP[key]?.ids;
      if (!ids) continue; // auto-ranked leg: its members are served, not pinnable here
      const tokens = [...why.matchAll(TOKEN)].map((m) => m[1]);
      expect([...new Set(tokens)].sort(), key).toEqual([...ids].sort());
    }
  });
});
