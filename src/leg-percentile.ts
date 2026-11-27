/**
 * W4 Stage 4.3 — the per-leg EARLY-WARN pillar percentile: a ROLLING-window ECDF rank of today's
 * pillar value against that leg's own stored `leg_pillars` history.
 *
 * DISPLAY-ONLY BY CONSTRUCTION. Nothing here is imported by `src/danger-engine.ts`; the cell it
 * feeds lives on `LegRowDTO` (`src/api/types.ts`), never on `LegRow`, so `danger` / `subDangers` /
 * `regime` / `inBand` / `held` / band / notify have no symbol to read.
 *
 * ⚠ ACCEPTED COST OF THE OPTION-C RULING (2026-07-25, USER — spec §1). `percentileRank`
 * (`src/slow.ts`) is a NEAR-TWIN of `rollingEcdfRank`'s inner loop: both count values `<= x` and
 * divide by the sample size, so both carry the same tie convention. A future fix to that tie
 * handling (e.g. midrank instead of `<= x`) MUST be applied in BOTH places, and **no test in this
 * repo catches the drift** — the two functions have disjoint suites and disjoint callers by design
 * (`slow.ts` is the retired crash-detection scorer module; this file is the rotation display path).
 * The duplication is thinner than it looks — a ROLLING rank is not an EXPANDING one (different
 * window semantics, different warm-up), which is why the ruling declined to share the code — but the
 * tie convention really is shared, and that is the part that can rot silently. Revisit at a third
 * consumer (spec §1 Option B).
 */
import { createHash } from "node:crypto";
import { isLiveCell } from "./danger-cell.js";
import { computeCells, type MemberHistoryEntry } from "./danger-engine.js";
import { buildMemberStateAt } from "./danger-member-state.js";
import { pillarShare, SYSTEMIC_KAPPA } from "./danger-share.js";
import { FAMILY_MEMBERS, LEG_FIELD, SIGNALS, SUPER_GROUP_OF, type SignalKey } from "./danger-ladder.js";
import type { State } from "./domain-types.js";
import type { SeriesPoint } from "./store.js";
import { ECDF_WINDOW } from "./ecdf-window.js";

// Re-exported so every existing `./leg-percentile.js` importer (and the ranker-site walk) keeps resolving it.
export { ECDF_WINDOW };

/**
 * Slack rows a reader must fetch ON TOP of `ECDF_WINDOW`, because a stored row can carry a `null`
 * value (an uncomparable DAY) and those are dropped before the rank.
 *
 * THE BUG THIS CLOSES (review 2026-07-25, I3). Stage 4.3 shipped `ewPctCell` reading exactly
 * `ECDF_WINDOW` ROWS and then filtering nulls, so ONE null inside the newest 500 rows left 499
 * samples ⇒ `warmup` on that leg — while 900 non-null closes sat in the table. Spec §2 asks for a
 * rolling window of 500 **closes**, not "500 rows minus holes".
 *
 * SIZE. 100 = 20% of the window. Measured 2026-07-25 on the backfilled dev DB: ZERO nulls in 900
 * stored rows on all nine legs, so this is pure insurance, not a fitted number. If a leg ever
 * exceeds a 20% uncomparable rate inside the span the cell degrades to `warmup` — short-sample-rank
 * is never the fallback — and `npm run probe:leg-percentile-depth` exits 1 first, since it
 * measures the non-null count over exactly this span.
 */
export const ECDF_READ_SLACK = 100;

/** Rows a reader asks `getLegPillarSeries` for: the window plus its null slack. The rank still uses
 *  the newest `ECDF_WINDOW` NON-NULL values — the extra rows only absorb holes. */
export const ECDF_READ_SPAN = ECDF_WINDOW + ECDF_READ_SLACK;

/** Formula-vintage fingerprint: hash the REAL pillar path's output over frozen synthetic worlds (no
 *  clock/random; sorted keys; `toFixed(12)`), so any constant, table or code edit that moves it mints a new tag. */

/** The two super-groups a `leg_pillars` row is ever computed for (`leg-pillar-walk.ts`'s
 *  `PILLAR_SUPER_GROUPS`). A THIRD ranked super-group must extend this union — which reds the
 *  `SUPER_GROUP_PREFIX` map below at compile time rather than silently reusing a tag prefix. */
export type PillarSuperGroup = "EARLY-WARN" | "STRESS-NOW";

/** One frozen world per depth; the depth only salts each world's `fnv1a` member states. Literals, never
 *  derived from engine constants. */
const FIXTURE_DEPTHS = [200, 21, 20, 19, 8] as const;

/** The three confirmed member states `severityOf` maps to lit / elev / calm. */
const FIXTURE_STATES: readonly State[] = ["RED", "AMBER", "GREEN"];

/** FNV-1a/32 over a literal key — a pure, allocation-light integer hash used ONLY to spread the
 *  fixture's member states deterministically. Not security-relevant, and not the vintage digest
 *  (that is sha256, below). `Math.imul` keeps the multiply in int32, so the result is identical on
 *  every V8, and the key is a literal string, so it carries no clock and no environment. */
function fnv1a(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Every family member, de-duplicated and SORTED — the sort is what makes the enumeration
 *  independent of `Set` insertion order (and therefore of registry edit order). */
const FIXTURE_MEMBERS: readonly string[] = [...new Set(SIGNALS.flatMap((f) => FAMILY_MEMBERS[f]))].sort();

/**
 * Each world's member histories, built ONCE at module load: every member `depth` closes long, each
 * close carrying a deterministic state.
 *
 * Only `.state` is read (by `severityOf` through `buildMemberStateAt`); the other `SeriesPoint`
 * fields are filled to satisfy the type and are never inspected — `date` is a synthetic ordinal, NOT
 * a calendar date, precisely so no clock or calendar can leak into the digest.
 */
const FIXTURE_HISTORIES: readonly { depth: number; history: MemberHistoryEntry[] }[] = FIXTURE_DEPTHS.map(
  (depth) => ({
    depth,
    history: FIXTURE_MEMBERS.map((id) => ({
      id,
      history: Array.from({ length: depth }, (_, i): SeriesPoint => {
        const state = FIXTURE_STATES[fnv1a(`state ${depth} ${id} ${i}`) % FIXTURE_STATES.length]!;
        return { date: `d${String(i).padStart(4, "0")}`, value: 0, delta20: 0, rawState: state, state };
      }),
    })),
  }),
);

/** Fingerprint part 1 — per world × leg, `pillarShare` at `SYSTEMIC_KAPPA`: kind/value/of. Must stay
 *  `DANGER_CUTS`-independent (no `lit`): a cut retune must not mint a vintage and stale every ewPct. */
function pillarWorldFingerprint(sg: PillarSuperGroup): unknown {
  return FIXTURE_HISTORIES.map(({ depth, history }) => ({
    world: depth,
    legs: LEG_FIELD.map((leg) => {
      const share = pillarShare(sg, leg.sleeve, buildMemberStateAt(history, 0), SYSTEMIC_KAPPA);
      return {
        sleeve: leg.sleeve,
        kind: share === null ? "uncomparable" : "scored",
        value: share === null ? null : share.value.toFixed(12),
        of: share?.of ?? null,
      };
    }),
  }));
}

/** Fingerprint part 2 — each member SOLO-lit through `computeCells`, so a non-maximal member's
 *  `MEMBER_WEIGHT` edit still moves the digest (an aggregate max masks it). */
function memberReachFingerprint(sg: PillarSuperGroup): unknown {
  const families = fingerprintFamilies(sg);
  return FIXTURE_MEMBERS.map((member) => ({
    member,
    legs: LEG_FIELD.map((leg) => ({
      sleeve: leg.sleeve,
      wsev: computeCells(leg, { [member]: { sev: "lit", obs: "lag" } })
        .filter((c) => families.has(c.family))
        // OQ-5 Stage 5.3 (A2 seam): `isLiveCell`, not a bare `wsev === null`. The probe fires ONE
        // member and leaves every other ABSENT, so most (member, leg, family) triples are now
        // FULLY-UNOBSERVED cells carrying `wsev: null` where they carried a fabricated 0. Printing
        // that null would mint a NEW `LEG_PILLAR_GENERATOR` vintage for a stage that moves no served
        // number — a false drift signal, and a percentile recompute nothing earned. `na` cells (`vb`)
        // still print `null`, exactly as before.
        // STAND-IN AUDIT (OQ-5 Stage 3.1): OK — the reach probe measures the WEIGHT TABLE, and a
        // member that does not reach a family/leg has always been reported as reach 0. No absence is
        // destroyed: the cell layer's `SignalCell.observed` is where absence is told.
        .map((c) => (isLiveCell(c) ? (c.wsev ?? 0).toFixed(12) : null)),
    })),
  }));
}

/** The families of super-group `sg` the reach probe reports on — the same set the percentile ranks,
 *  so a STRESS-NOW-only weight edit reaches the `sn-` tag and never the `ew-` one. DERIVED from
 *  `SUPER_GROUP_OF`, never hardcoded. */
function fingerprintFamilies(sg: PillarSuperGroup): ReadonlySet<SignalKey> {
  return new Set(SIGNALS.filter((f) => SUPER_GROUP_OF[f] === sg));
}

/** The whole hash input for super-group `sg`: both parts, in a fixed array order. `sg` scopes the
 *  fixture but is NEVER a key/field of this object — the tag prefix carries it, so the EW digest is
 *  byte-identical to the pre-parameterization value and no stored row is stranded. */
function pillarFingerprintInput(sg: PillarSuperGroup): unknown {
  return { pillars: pillarWorldFingerprint(sg), reach: memberReachFingerprint(sg) };
}

/**
 * Deterministic canonical JSON: object keys sorted at EVERY depth, arrays kept in order.
 *
 * `JSON.stringify` alone would not do — it serializes in insertion order, so reordering two entries
 * of `FAMILY_LEG_WEIGHT` (a pure no-op for the arithmetic) would mint a new vintage and orphan the
 * whole table. Sorting makes the hash a function of the VALUES, not of how the source file happens
 * to be typed. No clock, no locale, no `Map` iteration — the same constants hash identically in a
 * Vercel function, a backfill script and a vitest worker.
 *
 * EXPORTED FOR TEST, not for callers: the order-insensitivity is the load-bearing half of the
 * vintage's determinism and cannot be observed through `LEG_PILLAR_GENERATOR` (one fixed input,
 * one fixed digest — a hash over insertion-ordered JSON would pin exactly the same literal).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(",")}}`;
  }
  // STAND-IN AUDIT (OQ-5 Stage 3.1): OK — `JSON.stringify` returns undefined only for
  // undefined/function/symbol, and "null" is exactly that absence's JSON encoding, keeping the
  // canonical form total. This is the digest serializer, not a danger number.
  return JSON.stringify(value) ?? "null";
}

/** The per-super-group tag prefix. `Record<PillarSuperGroup, …>` so extending that union without
 *  assigning a prefix reds the build — a new super-group can never silently reuse `ew-`/`sn-`. */
const SUPER_GROUP_PREFIX: Record<PillarSuperGroup, string> = { "EARLY-WARN": "ew", "STRESS-NOW": "sn" };

/** `<prefix>-` + first 12 hex of sha256(canonical fixture output); 12 hex = 48 bits. NOT memoized:
 *  EW is paid once at module load (`LEG_PILLAR_GENERATOR` below) and SN only on demand, so `api/lab.ts`
 *  (reads the EW const only) never pays SN's ~6 ms; the backfill hot loop memoizes at its own call
 *  site. Recomputing each call is what lets the §11.1 falsifier see a `MEMBER_WEIGHT` edit move the tag. */
export function legPillarGenerator(sg: PillarSuperGroup): string {
  const digest = createHash("sha256").update(canonicalJson(pillarFingerprintInput(sg))).digest("hex");
  return `${SUPER_GROUP_PREFIX[sg]}-${digest.slice(0, 12)}`;
}

/**
 * Formula-vintage tag written into every `leg_pillars` row's `generator` column and REQUIRED as a
 * read filter by `getLegPillarSeries` (co-existing vintages share the (obs_date, sleeve,
 * super_group) PK prefix by design, so a read that omitted it would interleave two vintages into
 * one percentile window).
 *
 * It lives HERE, in `src/`, rather than in `scripts/backfill/leg-pillar-walk.ts` where Stage 4.2
 * introduced it, because Stage 4.3 made `api/lab.ts` a second consumer: a Vercel function may not
 * import out of `scripts/` (that tree is excluded from the deployed bundle), and duplicating it
 * would let the writer's vintage and the reader's filter drift into a permanently empty read.
 * `leg-pillar-walk.ts` re-exports it, so every Stage 4.2 importer is unchanged.
 *
 * COMPUTED, not a literal, since Stage 4.4: a sha256 over the EARLY-WARN pillar values the live
 * engine produces on a frozen synthetic fixture (`pillarFingerprintInput` above), so any edit to the
 * EARLY-WARN pillar's constants, tables, vintage artifact OR arithmetic mints a NEW vintage
 * automatically.
 *
 * SUPER-GROUP-SCOPED SINCE §11.1 (2026-08-20). `legPillarGenerator(sg)` filters the fixture to `sg`'s
 * families/pillars, so an SN-only `MEMBER_WEIGHT` edit (a `vl`/`xa` cell) moves the `sn-` tag and never
 * this `ew-` one — `leg-pillar-walk.ts` stamps each row `legPillarGenerator(r.superGroup)`, so the two
 * vintages no longer interleave under one hash. This const stays the EARLY-WARN arm, byte-identical.
 * Stage 4.2 shipped the literal `"ew-v0"` on purpose — 4.4 needed a distinct prior value to co-exist
 * with under the same PK prefix — and every row backfilled under that literal is now, BY DESIGN, a
 * stale vintage `ewPctCell` refuses to rank (`{kind:"stale-basis"}` ⇒ `—` on all nine legs) until the
 * regen writes the new one: `npm run backfill -- legpillars --closes=900`. (NOT `--reshadow-all` —
 * that flag is neither wired for `legpillars` nor needed, since `generator` is part of the 4-column
 * PK, so the ordinary insert-missing pass writes the whole history under the new hash and leaves the
 * old vintage intact. Rationale: `scripts/backfill/registry.ts`'s `legpillars` docblock.)
 *
 * Declared AFTER the fixture consts, not beside the docblock at the top: `const` is not hoisted, so
 * calling the (hoisted) function any earlier would hit the TDZ at module load.
 */
export const LEG_PILLAR_GENERATOR = legPillarGenerator("EARLY-WARN");

/** The two arms `rollingEcdfRank` can return — the `pct` / `warmup` half of `PercentileCell`
 *  (`src/api/types.ts`). The `na` and `stale-basis` arms are decided by the CALLER (an
 *  uncomparable pillar / a vintage mismatch), never by the arithmetic here. */
export type EcdfRank = { kind: "pct"; value: number } | { kind: "warmup" };

/**
 * Rank of `x` inside the NEWEST `ECDF_WINDOW` observations of `history` (oldest → newest):
 * the fraction of those values `<= x`, ∈ [0, 1].
 *
 * The interval is CLOSED at both ends, and 0 is a real reading, not a defect: `x` strictly below
 * every observation in the window counts nothing (`leg-percentile.test.ts` pins `{kind:"pct",
 * value: 0}`; `leg-percentile-badge.test.js` pins the `p0` paint; `openapi.yaml`'s `pct` arm says
 * `minimum: 0`). Do not re-tighten this to `(0, 1]` — that is the review-corrected claim
 * (2026-07-25, I4), and it described behaviour the code has never had.
 *
 * ROLLING, not expanding (the OQ-3 ruling, spec §2). Two consequences, both deliberate:
 *  • Fewer than `ECDF_WINDOW` observations ⇒ `{kind:"warmup"}`. Never a rank over a short sample,
 *    never an imputed number — the FE prints `—`.
 *  • **The reading moves with NO new data.** When an old close falls out the back of the window the
 *    denominator's contents change, so the same `x` can rank differently tomorrow. The FE title
 *    states this; `leg-percentile.test.ts` pins it as behaviour rather than prose.
 *
 * Pure: no IO, no clock, no mutation of `history` (the window is a copy-free tail read).
 * Callers pass only NON-NULL stored values — a `null` `leg_pillars` row is an uncomparable day and
 * carries no number, so it is dropped BEFORE the count rather than entering as a calm 0.
 */
export function rollingEcdfRank(history: readonly number[], x: number): EcdfRank {
  if (history.length < ECDF_WINDOW) return { kind: "warmup" };
  const start = history.length - ECDF_WINDOW;
  let count = 0;
  // Tie convention `<= x` — see the twin warning in this file's header docblock.
  for (let i = start; i < history.length; i++) if (history[i]! <= x) count++;
  return { kind: "pct", value: count / ECDF_WINDOW };
}

/**
 * W4 Stage 4.4, the `basis` half — the obs_dates at which the ROSTER changed inside an already-sliced
 * ranked window, ascending, newer side of each boundary. Empty ⇒ the whole window shares one roster.
 *
 * `basis` is the roster hash of the EW-capable families' member ids that produced each stored close
 * (written per row by `scripts/backfill/leg-pillar-walk.ts`). Two closes with different `basis` values
 * were computed off DIFFERENT member sets, so they are not strictly comparable observations.
 *
 * WHY WE DO NOT REFUSE TO MIX (spec §3 Stage 4.4, ruled 2026-07-25). `EURC` entered an EW-capable
 * family on 2026-05-15 and `BUND` on 2026-05-25, so EVERY 500-close window necessarily straddles a
 * roster change until ~2028. Refusing to rank a mixed window would print `—` on the affected legs for
 * two years — unshippable. The ruling is instead: serve the number and carry these dates onto the wire
 * so the FE title can say WHICH change and WHY the older half reads colder (a smaller member set). It
 * degrades automatically as the window rolls past 2026-05.
 *
 * ⚠ THE SPANS DO NOT FORCE `estimated` (review 2026-07-25, finding 3 — this SUPERSEDES the spec §3
 * Stage 4.4 wording "force `estimated: true`"). `estimated` keeps its Stage-4.3 meaning: the pillar's
 * OWN value was imputed/shrunk. The forced form made a MEASURED pillar in a spanned window claim an
 * imputation that never happened — and since every 500-close window straddles May 2026 until ~2028,
 * that was the default state of all nine tooltips. "Not a clean measured rank" is the disjunction
 * `estimated || basisSpans.length > 0`, which `public/lab.js` already computes for its single `~`
 * marker; keeping the two apart on the wire is what lets the tooltip name the right cause.
 *
 * Pure, allocation-light, NO extra DB read by construction: the caller has already read these rows to
 * rank them, so the detection is over data in hand. Callers MUST pass the exact rows the rank ran on
 * — nulls dropped, newest `ECDF_WINDOW` only — or the dates would name changes outside the window.
 */
export function basisChangeDates(points: readonly { date: string; basis: string }[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i]!.basis !== points[i - 1]!.basis) out.push(points[i]!.date);
  }
  return out;
}
