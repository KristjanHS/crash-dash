/**
 * Scorer vintage — pure hashing + diffing for the vintage-drift detector (A1,
 * ruling 1 + 4a). No IO: this module
 * only computes per-id code vintages and diffs them against stored rows; the detector
 * probe, the restatable/NORESTATE partition and `--stamp` are Stage 6's
 * `scripts/probe-vintage-drift.ts`, deliberately NOT here.
 */
import { createHash } from "node:crypto";
import type { Indicator } from "./domain-types.js";
import {
  BREADTH_CONFIG_OF,
  CHART_DESCRIPTOR_OF,
  COMPOSITE_LEVEL_BAND_OF,
  CURVE_DESCRIPTOR_OF,
  DOWNSIDE_CUT_OVERRIDES,
  GEO_HYBRID_DESCRIPTOR_OF,
  POINT_BAND_CUTS_OF,
  RATIO_DESCRIPTOR_OF,
  RATIO_VS_MA_CONFIG_OF,
  RETURN_OR_MA_CONFIG_OF,
  SMOOTHED_LEVEL_OF,
  RS_CUT_OVERRIDES,
  VELOCITY_Z_CONSTANTS_OF,
} from "./family-descriptor-rows.js";
import * as Rows from "./family-descriptor-rows.js";
import { ALL_INDICATORS } from "./registry.js";
import { DOWNSIDE_DETECTORS, RS_LEGS } from "./registry-price.js";
import type { ScorerVintageRow } from "./store.js";

/**
 * The display-string `Indicator` fields excluded from the config hash (ruling 4a): pure display
 * strings that cannot move a scored state. EVERYTHING else on the entry hashes —
 * drift-by-default, so a brand-new scoring field added to `Indicator` changes the hash
 * of every carrier without this module being touched (and a `channel`/`feedTimeZone`/
 * `cadence` edit DOES restate — accepted cost, ruling 4a).
 * One more exclusion lives in `configHashFor`: a `derived` block flagged `displayOnly: true`
 * (F1's lowRise, KBE's worstDrop) keeps ONLY `kind` + `window` (+ the flag) in the hash. No
 * scorer scores its bands, so an `amber`/`red`/`label`/`unit` edit must not flag drift — but
 * `decisionAt` (scorers-core.ts) reads `kind` + `window` into F1's PERSISTED `decision`, so those
 * still restate. A SCORED `derived` block hashes whole.
 */
const DISPLAY_ONLY_FIELDS = ["label", "longLabel", "unit"] as const;

/** Per-id scorer tables OFF the registry entry — each hashes the id's row (its `chart` stripped). A new
 *  `*_OF`/`*_OVERRIDES` table in family-descriptor-rows.ts joins here or the test's `NOT_HASHED`; the test reds otherwise. */
const SCORED_TABLES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  BREADTH_CONFIG_OF, COMPOSITE_LEVEL_BAND_OF, CURVE_DESCRIPTOR_OF, DOWNSIDE_CUT_OVERRIDES, GEO_HYBRID_DESCRIPTOR_OF,
  POINT_BAND_CUTS_OF, RATIO_DESCRIPTOR_OF, RATIO_VS_MA_CONFIG_OF, RETURN_OR_MA_CONFIG_OF, SMOOTHED_LEVEL_OF,
  VELOCITY_Z_CONSTANTS_OF,
};
/** Chart tables a scorer also reads: only these fields hash (FXH's legs via `FXH_LEG_IDS`; persisted `band_cuts` keys). */
const SCORED_FIELDS_OF: Readonly<Record<string, readonly [Readonly<Record<string, object>>, readonly string[]]>> = {
  CHART_DESCRIPTOR_OF: [CHART_DESCRIPTOR_OF, ["seriesIds", "bandCuts"]],
};

/** Shared-default descriptors: also read by every roster id WITHOUT its own override row (`downsideCuts`/`rsCuts`). */
const SHARED_DEFAULT_READERS: Readonly<Record<string, readonly string[]>> = {
  DB_SMH_DESCRIPTOR: DOWNSIDE_DETECTORS.map((d) => d.indicator.id).filter((id) => !Object.hasOwn(DOWNSIDE_CUT_OVERRIDES, id)),
  RS_SMH_DESCRIPTOR: RS_LEGS.map((l) => l.indicator.id).filter((id) => !Object.hasOwn(RS_CUT_OVERRIDES, id)),
};

/**
 * id → [descriptor export name, its `scorer.constants`] for scorers reading `*_DESCRIPTOR.scorer.constants`
 * directly (the `configHashFor` descriptor row). DERIVED off the module's exports: `<ID>_DESCRIPTOR`
 * is read by id `<ID>` (when an `ALL_INDICATORS` id) plus its `SHARED_DEFAULT_READERS` — a new descriptor hashes
 * with no edit here. Skipped when the id's `SCORED_TABLES` row already IS the descriptor or its constants (that
 * row hashes them; a second copy would flag drift on an unchanged id). Held by reference, read at hash time.
 */
const DESCRIPTOR_CONSTANTS_OF: ReadonlyMap<string, ReadonlyArray<readonly [string, object]>> = (() => {
  const ids = new Set(ALL_INDICATORS.map((i) => i.id));
  const out = new Map<string, [string, object][]>();
  for (const [name, desc] of Object.entries(Rows) as [string, unknown][]) {
    if (!name.endsWith("_DESCRIPTOR")) continue;
    const constants = (desc as { scorer?: { constants?: unknown } } | null)?.scorer?.constants;
    if (constants === null || typeof constants !== "object") continue;
    const readers = new Set([name.slice(0, -"_DESCRIPTOR".length), ...(SHARED_DEFAULT_READERS[name] ?? [])]);
    for (const id of readers) {
      if (!ids.has(id)) continue;
      const inTable = Object.values(SCORED_TABLES).some((t) => t[id] === desc || t[id] === constants);
      if (!inTable) out.set(id, [...(out.get(id) ?? []), [name, constants]]);
    }
  }
  return out;
})();

/** One drifted id: stored vs code vintage, both axes. */
export interface DriftLine {
  id: string;
  configHash: { old: string; new: string };
  logicVersion: { old: number; new: number };
}

/**
 * Deterministic JSON: object keys sorted, recursion into arrays/objects; `undefined`
 * and function-valued object entries are DROPPED (array slots holding them render as
 * `null`, matching JSON.stringify). Consequence, and the reason `logicVersion` exists:
 * a scorer FUNCTION reference sitting on a registry entry is invisible to the hash —
 * a scorer-body rewrite must be hand-declared via `Indicator.logicVersion`.
 *
 * THROWS on a value the hash could only misrepresent: a non-plain object (Date/Map/Set/
 * RegExp/class instance — JSON would render it `{}`, a permanent false-clean) or a
 * non-finite number (`null`). The drift-by-default promise holds for JSON-shaped values
 * only, and `codeVintages()` over `ALL_INDICATORS` (pinned in the test) is the lint that
 * keeps the registry inside that shape.
 */
function stableStringify(v: unknown): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "number") {
    if (!Number.isFinite(v)) throw new Error(`stableStringify: non-finite number ${String(v)} would hash as null`);
    return JSON.stringify(v);
  }
  if (t === "boolean") return JSON.stringify(v);
  if (t === "string") return JSON.stringify(v);
  if (t === "undefined" || t === "function") return "null"; // array-slot rendering; object entries are dropped below
  if (Array.isArray(v)) return `[${v.map((x) => stableStringify(x)).join(",")}]`;
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) {
    const name = (proto as { constructor?: { name?: string } }).constructor?.name ?? "?";
    throw new Error(`stableStringify: non-plain object (${name}) would hash as {} — store it as JSON-shaped data`);
  }
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined && typeof val !== "function")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(",")}}`;
}

/**
 * sha256 of the entry's stable JSON (display-only fields + a `displayOnly` derived block's
 * bands/labels stripped), first 12 hex chars.
 * `logicVersion` is also stripped — it is its own vintage axis (the `logic_version` column),
 * and an absent value must hash identically to an explicit 1.
 */
export function configHashFor(i: Indicator): string {
  const hashed: Record<string, unknown> = { ...i };
  for (const f of DISPLAY_ONLY_FIELDS) delete hashed[f];
  if (i.derived?.displayOnly === true) {
    const { kind, window, displayOnly } = i.derived;
    hashed.derived = { kind, window, displayOnly };
  }
  delete hashed.logicVersion;
  for (const [name, table] of Object.entries(SCORED_TABLES)) {
    const row = table[i.id];
    if (row === undefined) continue;
    hashed[`table:${name}`] = row !== null && typeof row === "object" && !Array.isArray(row) ? { ...row, chart: undefined } : row;
  }
  for (const [name, [table, fields]] of Object.entries(SCORED_FIELDS_OF)) {
    const row = table[i.id] as Record<string, unknown> | undefined;
    const picked = Object.fromEntries(fields.filter((f) => row?.[f] !== undefined).map((f) => [f, row![f]]));
    if (Object.keys(picked).length > 0) hashed[`fields:${name}`] = picked;
  }
  for (const [name, constants] of DESCRIPTOR_CONSTANTS_OF.get(i.id) ?? []) hashed[`descriptor:${name}`] = constants;
  return createHash("sha256").update(stableStringify(hashed)).digest("hex").slice(0, 12);
}

/** The live code's vintage rows — one per `ALL_INDICATORS` id, stamped at `now`. */
export function codeVintages(now: Date): ScorerVintageRow[] {
  const stampedAt = now.toISOString();
  return ALL_INDICATORS.map((i) => ({
    indicator_id: i.id,
    config_hash: configHashFor(i),
    logic_version: i.logicVersion ?? 1,
    stamped_at: stampedAt,
  }));
}

/**
 * Diff code vintages against stored rows. A code id with NO stored row goes to
 * `stampOnly`, never `drift` — ruling 1's first-deploy edge: an empty/partial
 * `scorer_vintage` table must not make the first ship restate everything. A stored
 * row for an id no longer in code is ignored (retired id — nothing to restate).
 */
export function diffVintages(
  code: readonly ScorerVintageRow[],
  stored: readonly ScorerVintageRow[],
): { drift: DriftLine[]; stampOnly: string[] } {
  const byId = new Map(stored.map((r) => [r.indicator_id, r]));
  const drift: DriftLine[] = [];
  const stampOnly: string[] = [];
  for (const c of code) {
    const s = byId.get(c.indicator_id);
    if (!s) {
      stampOnly.push(c.indicator_id);
    } else if (s.config_hash !== c.config_hash || s.logic_version !== c.logic_version) {
      drift.push({
        id: c.indicator_id,
        configHash: { old: s.config_hash, new: c.config_hash },
        logicVersion: { old: s.logic_version, new: c.logic_version },
      });
    }
  }
  return { drift, stampOnly };
}
