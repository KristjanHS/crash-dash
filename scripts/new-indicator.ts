/**
 * `new-indicator` — the indicator scaffold generator (Stage 6.3).
 *
 * It writes exactly TWO sites — the `src/registry-fred.ts` `Indicator` entry and the
 * `src/family-descriptor-rows.ts` `FAMILY_OF` row — and PRINTS every remaining per-indicator touch
 * point as a checklist. It deliberately never writes `scripts/backtest/calibration.json`,
 * `config.json`, the feed files (`prices.ts`/`fred.ts`) or the `public/` per-indicator
 * id lists: each of those needs a measured cut, a hand-written explainer or a feed symbol, and a
 * mechanically-written wrong cut reaches SCORED output that the goldens cannot catch (a new id moves
 * them legitimately).
 *
 * SHAPE: four PURE functions (`parseArgs` / `renderRegistryEntry` / `renderFamilyAssignment` /
 * `insertAtAnchor`, plus the pure `renderChecklist`) and one impure `main`. Only `main` touches the
 * filesystem — that is what lets `new-indicator.test.ts` exercise the whole seam without any chance
 * of writing into `src/`.
 *
 * VALIDATION SETS ARE DERIVED, NEVER RETYPED: known ids and family tags come off `FAMILY_OF` +
 * the production registry arrays, and the channel set is the set of channels the production
 * universe actually carries. ⚠ Caveat on that last one: it is the LIVE population, not the
 * `Channel` union — all nine members are carried today (checked 2026-07-25), but if a channel
 * ever loses its last member the generator would reject a legitimate id in it. The remedy is to
 * derive `Channel` from a runtime `as const` array in `domain-types.ts`, not to retype a list here.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FAMILY_OF } from "../src/family-descriptor-rows.js";
import type { FamilyTag } from "../src/family-descriptor-core.js";
import { ALL_INDICATORS } from "../src/registry.js";
import {
  BOTTOM_INDICATORS,
  PENSION_INDICATORS,
  SLOW_INDICATORS,
} from "../src/registry-price.js";
import { VTP } from "../src/registry-composite.js";
import type { Channel, Direction, Thresholds } from "../src/domain-types.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const REGISTRY_ANCHOR = "new-indicator:INDICATORS-END";
export const FAMILY_ANCHOR = "new-indicator:FAMILY_OF-END";

/** Every id the production universe already carries (registry arrays ∪ the census keys). */
export const KNOWN_IDS: ReadonlySet<string> = new Set<string>([
  ...ALL_INDICATORS.map((i) => i.id),
  ...SLOW_INDICATORS.map((i) => i.id),
  ...PENSION_INDICATORS.map((i) => i.id),
  ...BOTTOM_INDICATORS.map((i) => i.id),
  VTP.id,
  ...Object.keys(FAMILY_OF),
]);

/** The family tags in use — `FamilyId` ∪ `"raw"` ∪ `"context"`, read off the census. */
export const KNOWN_FAMILIES: ReadonlySet<string> = new Set<string>(Object.values(FAMILY_OF));

/** The channels the production universe carries (see the docblock caveat). */
export const KNOWN_CHANNELS: ReadonlySet<string> = new Set<string>(
  [
    ...ALL_INDICATORS,
    ...SLOW_INDICATORS,
    ...PENSION_INDICATORS,
    ...BOTTOM_INDICATORS,
    VTP,
  ].map((i) => i.channel),
);

/** Families that score through a threshold pair — the ones §2.3.4's coherence check binds. */
const LEVEL_VELOCITY_FAMILY = "fred-level-velocity";
const UNSCORED_TAGS: ReadonlySet<string> = new Set(["raw", "context"]);

export interface IndicatorSpec {
  id: string;
  label: string;
  longLabel: string;
  series: string;
  channel: Channel;
  family: FamilyTag;
  unit?: string;
  direction?: Direction;
  velocityWindow?: number;
  thresholds: Thresholds;
  dryRun: boolean;
}

export const USAGE =
  'usage: npm run new-indicator -- --id=F17 --label="…" --long-label="…" --series=<FRED_OR_SYMBOL> ' +
  '--channel=FIN --family=fred-level-velocity [--unit="pp"] ' +
  "[--amber-level=3.0 --red-level=3.2] [--amber-velocity=… --red-velocity=… --velocity-window=20] " +
  "[--direction=LOW] [--dry-run]";

function fail(message: string): never {
  throw new Error(`${message}\n${USAGE}`);
}

const FLAGS = [
  "id",
  "label",
  "long-label",
  "series",
  "channel",
  "family",
  "unit",
  "direction",
  "velocity-window",
  "amber-level",
  "red-level",
  "amber-velocity",
  "red-velocity",
  "dry-run",
] as const;
type Flag = (typeof FLAGS)[number];

function num(raw: string | undefined, flag: Flag): number | undefined {
  if (raw === undefined) return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v)) fail(`--${flag}: not a finite number (${raw})`);
  return v;
}

/**
 * PURE. Parses the args-only CLI surface into a validated spec, throwing an Error whose message
 * NAMES the offending flag (a bare throw would pass a `toThrow()` assertion on a typo in the
 * test's own setup, so every message carries its flag).
 */
export function parseArgs(argv: string[]): IndicatorSpec {
  const got = new Map<string, string>();
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) fail(`unrecognized argument: ${arg}`);
    const flag = m[1] ?? "";
    if (!(FLAGS as readonly string[]).includes(flag)) fail(`unknown flag: --${flag}`);
    if (got.has(flag)) fail(`--${flag}: given twice`);
    got.set(flag, m[2] ?? "");
  }
  const req = (flag: Flag): string => {
    const v = got.get(flag);
    if (v === undefined || v === "") fail(`--${flag}: required`);
    return v;
  };

  const id = req("id");
  if (KNOWN_IDS.has(id)) fail(`--id: duplicate id "${id}" — already in the registry/census`);

  const channel = req("channel");
  if (!KNOWN_CHANNELS.has(channel))
    fail(`--channel: unknown channel "${channel}" (known: ${[...KNOWN_CHANNELS].sort().join(", ")})`);

  const family = req("family");
  if (!KNOWN_FAMILIES.has(family))
    fail(`--family: unknown family "${family}" (known: ${[...KNOWN_FAMILIES].sort().join(", ")})`);

  const direction = got.get("direction");
  if (direction !== undefined && direction !== "HIGH" && direction !== "LOW")
    fail(`--direction: must be HIGH or LOW (got "${direction}")`);

  const velocityWindow = num(got.get("velocity-window"), "velocity-window");
  if (velocityWindow !== undefined && (!Number.isInteger(velocityWindow) || velocityWindow <= 0))
    fail(`--velocity-window: must be a positive integer (got "${got.get("velocity-window")}")`);

  const amberLevel = num(got.get("amber-level"), "amber-level");
  const redLevel = num(got.get("red-level"), "red-level");
  const amberVelocity = num(got.get("amber-velocity"), "amber-velocity");
  const redVelocity = num(got.get("red-velocity"), "red-velocity");

  // Half-pairs are rejected: a lone amber (or lone red) leg is the silent half-armed shape.
  if ((amberLevel === undefined) !== (redLevel === undefined))
    fail(`--amber-level/--red-level: a level band needs BOTH cuts, not one`);
  if ((amberVelocity === undefined) !== (redVelocity === undefined))
    fail(`--amber-velocity/--red-velocity: a velocity band needs BOTH cuts, not one`);

  const thresholds: Thresholds = {
    ...(amberLevel !== undefined ? { amberLevel } : {}),
    ...(redLevel !== undefined ? { redLevel } : {}),
    ...(amberVelocity !== undefined ? { amberVelocity } : {}),
    ...(redVelocity !== undefined ? { redVelocity } : {}),
  };
  const hasCut = Object.keys(thresholds).length > 0;

  if (family === LEVEL_VELOCITY_FAMILY && !hasCut)
    fail(
      `--amber-level/--red-level: family "${LEVEL_VELOCITY_FAMILY}" needs a level or velocity pair — ` +
        "with neither it scores GREEN forever",
    );
  if (UNSCORED_TAGS.has(family) && hasCut)
    fail(`--amber-level: family "${family}" is unscored and must carry thresholds:{}`);

  return {
    id,
    label: req("label"),
    longLabel: req("long-label"),
    series: req("series"),
    channel: channel as Channel,
    family: family as FamilyTag,
    ...(got.get("unit") !== undefined ? { unit: got.get("unit") } : {}),
    ...(direction !== undefined ? { direction: direction } : {}),
    ...(velocityWindow !== undefined ? { velocityWindow } : {}),
    thresholds,
    dryRun: got.has("dry-run"),
  };
}

function thresholdsLiteral(t: Thresholds): string {
  const parts = (["amberLevel", "redLevel", "amberVelocity", "redVelocity"] as const)
    .filter((k) => t[k] !== undefined)
    .map((k) => `${k}: ${t[k]}`);
  return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
}

/**
 * PURE. The `Indicator` object literal text as it lands inside `INDICATORS` — 2-space base
 * indent (4 inside the braces, matching the live entries) and a trailing comma.
 */
export function renderRegistryEntry(spec: IndicatorSpec): string {
  const lines = [
    "  {",
    `    id: ${JSON.stringify(spec.id)},`,
    `    label: ${JSON.stringify(spec.label)},`,
    `    longLabel: ${JSON.stringify(spec.longLabel)},`,
    `    series: ${JSON.stringify(spec.series)},`,
    `    channel: ${JSON.stringify(spec.channel)},`,
    `    thresholds: ${thresholdsLiteral(spec.thresholds)},`,
  ];
  if (spec.direction !== undefined) lines.push(`    direction: ${JSON.stringify(spec.direction)},`);
  if (spec.unit !== undefined) lines.push(`    unit: ${JSON.stringify(spec.unit)},`);
  if (spec.velocityWindow !== undefined) lines.push(`    velocityWindow: ${spec.velocityWindow},`);
  lines.push("  },");
  return lines.join("\n");
}

const BARE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * PURE. The `FAMILY_OF` census row, or `null` when the id already HAS one (the census is a
 * bijection over the production universe — `family-descriptor.test.ts` — so a raw/context id needs
 * its row exactly as much as a scored one; the only no-op case is an id already present).
 */
export function renderFamilyAssignment(spec: IndicatorSpec): string | null {
  if (Object.hasOwn(FAMILY_OF, spec.id)) return null;
  const key = BARE_KEY.test(spec.id) ? spec.id : JSON.stringify(spec.id);
  return `  ${key}: ${JSON.stringify(spec.family)},`;
}

/**
 * PURE string→string. Inserts `block` immediately ABOVE the single line carrying `anchor`.
 * Throws when the anchor appears 0 or ≥2 times — a moved, dropped or "helpfully" duplicated
 * marker is loud, never a silent insert at the wrong place.
 */
export function insertAtAnchor(source: string, anchor: string, block: string): string {
  const lines = source.split("\n");
  const hits = lines.map((l, i) => (l.includes(anchor) ? i : -1)).filter((i) => i >= 0);
  if (hits.length === 0) throw new Error(`anchor not found: ${anchor}`);
  if (hits.length > 1)
    throw new Error(`anchor appears ${hits.length} times (must be exactly 1): ${anchor}`);
  lines.splice(hits[0] ?? 0, 0, block);
  return lines.join("\n");
}

/**
 * PURE. Whether the generated `Indicator` entry may be written into `src/registry-fred.ts` automatically.
 *
 * The `new-indicator:INDICATORS-END` anchor sits INSIDE `export const INDICATORS`, and `run-cycle-fred.ts`
 * does a FRED fetch per entry of that array. So an auto-write is only correct for the
 * `fred-level-velocity` family; for every other family the entry belongs in `PRICE_SCORERS` or in its
 * own scored block, and writing it here would silently make the cron fetch a series that never
 * resolves (2026-07-25 Stage-6 review finding 1).
 */
export function writesRegistry(spec: IndicatorSpec): boolean {
  return spec.family === LEVEL_VELOCITY_FAMILY;
}

/**
 * PURE. The remaining per-indicator touch points. Derived from `docs/reference.md` §[indicator] 1–7
 * and `docs/reference.md` §[arch] 9. Cross-file design invariants ("Registry fan-out (adding an id)"), re-checked against the
 * live tree 2026-07-25 (that check moved MEMBER_HELP to `public/member-help.js` and dropped the
 * "bump FRED_COUNT" step — it is `INDICATORS.length`, derived).
 */
export function renderChecklist(spec: IndicatorSpec): string {
  const id = spec.id;
  const wrote = writesRegistry(spec)
    ? `Wrote:
  [done] src/registry-fred.ts          — Indicator entry for ${id} (INDICATORS + ALL_INDICATORS reach it)
  [done] src/family-descriptor-rows.ts — FAMILY_OF["${id}"] = "${spec.family}"

Still yours (docs/reference.md §[indicator]):
  [ ] feed array — this id is FRED level/velocity, so INDICATORS is the right home (done)`
    : `Wrote:
  [done] src/family-descriptor-rows.ts — FAMILY_OF["${id}"] = "${spec.family}"
  [SKIPPED] src/registry-fred.ts — the entry above was NOT written. The generator's anchor sits inside
      INDICATORS, which run-cycle-fred.ts fetches from FRED per entry; family "${spec.family}" is not
      FRED level/velocity, so an entry there would make the cron fetch a series that never resolves.

Still yours (docs/reference.md §[indicator]):
  [ ] PLACE THE ENTRY ABOVE BY HAND, in the array that matches its feed — price-fed => a
      PRICE_SCORERS row (id -> scorer + inputs), NOT PRICE_INDICATORS unless a bespoke fn consumes it
      by name; own feed (EBP/ECB/global) => own scored block in run-cycle-*.ts
  [ ] add the id to ALL_INDICATORS — else /api/indicators + /api/series skip it`;
  return `${wrote}
  [ ] public/indicator-desc.js — INDICATOR_DESC["${id}"] = {tip, means, drives, derivation}
      (else indicator-desc.test.js reds)
  [ ] scripts/backfill.ts specs() — {id, build} reusing the SAME *ReadingSeries builder as the live
      scorer; bump the hermetic count + id list in scripts/backfill.jobs.test.ts
  [ ] bespoke scorer? add scoreX + xReadingSeries in scorers-price.ts / scorers-composite.ts, cuts on a
      family descriptor (never module-level: src/locality-lint.test.ts enforces)
  [ ] movable bands? REACHABLE_IDS row + threshold-config.json entry (else validateMultiplierConfig throws)
  [ ] drives the dial? MEMBER_WEIGHT + MEMBER_LABEL in src/danger-ladder.ts, MEMBER_HELP in
      public/member-help.js, FAMILY_LEG_WEIGHT if it sits on a leg
  [ ] CONTEXT-only (thresholds:{})? feed ALL FOUR gates in this commit — chart-bands.test.ts
      CONTEXT_ONLY_ALLOWLIST, public/indicator-desc.js, status handler PLACEHOLDER_STATE_IDS,
      families CARD_ONLY_GROUPS  (reference.md §[arch] 9. Cross-file design invariants)
  [ ] scripts/preview/mock-data.mjs entry; a NON-FRED persisted id also needs an EXPECTED_EXTRA row in
      src/run.wiring.test.ts, + src/run.wiring.secondary-feeds.test.ts unless price/oil/EBP-fed (a FRED id needs no bump — FRED_COUNT is INDICATORS.length, derived)
  [ ] calibration? scripts/backtest/calibration.json is NOT generated — publish cuts deliberately
  [ ] npm run check, then npm run golden:regen (a NEW id legitimately changes the goldens — review the
      diff, it must contain only ${id} rows)
  [ ] ship: make ship; then backfill -- indicators --env=prod for deep history
Do NOT add an api/ handler: api/deploy-budget.test.ts pins exactly 8. Extend an existing response.`;
}

/** The ONLY impure function: read → pure transform → write, then print the checklist. */
async function main(): Promise<void> {
  const spec = parseArgs(process.argv.slice(2));
  const registryPath = join(REPO_ROOT, "src", "registry-fred.ts");
  const familyPath = join(REPO_ROOT, "src", "family-descriptor-rows.ts");

  const entry = renderRegistryEntry(spec);
  const row = renderFamilyAssignment(spec);
  // Anchor validity is checked for BOTH files regardless of family, so a dropped or duplicated marker
  // fails loudly here rather than at the next run that happens to need it.
  const nextRegistry = insertAtAnchor(readFileSync(registryPath, "utf8"), REGISTRY_ANCHOR, entry);
  const nextFamily =
    row === null
      ? null
      : insertAtAnchor(readFileSync(familyPath, "utf8"), FAMILY_ANCHOR, row);

  const auto = writesRegistry(spec);
  if (spec.dryRun) {
    const head = auto
      ? "src/registry-fred.ts:"
      : `src/registry-fred.ts (NOT auto-written for family "${spec.family}" — place by hand):`;
    console.log(`--dry-run: nothing written.\n\n${head}\n${entry}\n`);
    if (row !== null) console.log(`src/family-descriptor-rows.ts:\n${row}\n`);
  } else {
    if (auto) writeFileSync(registryPath, nextRegistry);
    else console.log(`src/registry-fred.ts entry (place by hand, see below):\n${entry}\n`);
    if (nextFamily !== null) writeFileSync(familyPath, nextFamily);
  }
  console.log(renderChecklist(spec));
}

// Run only as a CLI entry, never on import (the test imports the pure seam).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
