import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * OQ-5 Stage 3.1 — the silent stand-in ROSTER for the danger path.
 *
 * A "stand-in" here is a value SUBSTITUTED for something the code did not observe: `??` / `||`
 * with a literal or SCREAMING_CASE-constant right-hand side, `Number(x) || 0`, a `catch` that
 * returns a number, and the severity-defaulting ternary (`… ? … : "calm"`). Every such site on the
 * danger path is ruled individually, at the site, with a `STAND-IN AUDIT (OQ-5 Stage 3.1):
 * OK|WRONG` docblock; this test pins the COUNT and the IDENTITY of that ruling set by re-deriving
 * it from the sources at test time.
 *
 * What it buys: a NEWLY introduced `?? 0` on the danger path fails here, named with its file and
 * line, instead of waiting for a reviewer to remember. Red-demo'd 2026-07-26 by inserting a
 * throwaway `const x = someNumber ?? 0;` into `danger-engine.ts`.
 *
 * Deliberately NOT in the sweep (ruled in prose, not by regex):
 *  - `?? null` / `?? undefined` / `?? []` — absence-preserving, no value invented.
 *  - Classification ternaries over an OBSERVED value (`scaled >= red ? "RED" : …`) — a mapping,
 *    not a default.
 */

/** The danger path, as enumerated by the OQ-5 plan's Stage 3.1 focus list. */
const FILES = [
  "danger-engine.ts",
  // Added 2026-08-15 with the B4 MOVE-ONLY split: the deadband/exogenous/concentration constants
  // and `pickHeld` left `danger-engine.ts`; the focus list is a PATH, so the peeled files stay swept.
  "danger-concentration.ts",
  "danger-exogenous.ts",
  "danger-deadband.ts",
  // Added 2026-08-09 with audit round-2 §0 ruling R4: the member-observation builders were peeled out
  // of `danger-engine.ts` into their own module. The focus list is a PATH, not a file list — dropping
  // this entry would silently un-sweep `severityOf`'s ternary (roster entry 1), which is exactly what
  // the drift test reported when the move landed before this line did.
  "danger-member-state.ts",
  "danger-share.ts",
  "t1dial.ts",
  "families.ts",
  "leg-percentile.ts",
  "alert-band.ts",
  "danger-ladder.ts",
] as const;

/**
 * The sweep. Each arm targets one member of the stand-in family. The `catch`/`Number()` arms match
 * nothing today — they are forward guards, and the roster below would flag whatever they catch as
 * unruled, which is the intended failure.
 */
const SWEEP: RegExp[] = [
  /(\?\?|\|\|)\s*(-?\d+(\.\d+)?\b|"[^"]*"|'[^']*'|`[^`]*`)/, // literal RHS default
  /\?\?\s*[A-Z][A-Z0-9_]{2,}\b/, // SCREAMING_CASE constant RHS
  /catch\s*(\([^)]*\))?\s*\{[^}]*return\s+-?\d/, // catch → fabricated number
  /Number\([^()]*\)\s*\|\|/, // Number(x) || 0
  /\?[^?:]*:\s*"(calm|elev|lit)"\s*;/, // severity-defaulting ternary
];

const VERDICT_MARKER = /STAND-IN AUDIT \(OQ-5 Stage 3\.1\): (OK|WRONG)/;
/** How far above a site the test will look for that site's verdict docblock. */
const MARKER_LOOKBACK = 8;

type Verdict = "OK" | "WRONG";
interface RosterEntry {
  file: (typeof FILES)[number];
  /** The trimmed source line, so the pin survives line-number drift. */
  code: string;
  /** Occurrences of that exact line in that file — pins the COUNT, not just the identity. */
  count: number;
  verdict: Verdict;
}

/**
 * The ruled roster. **Every entry now reads OK** — the WRONG column is empty, and that is the
 * shipped state of the audit, not a weakening of it:
 *  - `t1dial`'s `coincidentContribution(f) ?? 0` was the one non-headline WRONG; Stage 3.2 FIXED it
 *    (null contributions now drop from numerator AND denominator), removing the site.
 *  - The remaining 8 were the `memberState[m] ?? "calm"` family — the OQ-5 headline. **Stage 5.2**
 *    fixed them: 7 SOURCE LINES CEASED TO EXIST (`MemberStateMap` now carries `{sev, obs}`, absence
 *    is a missing key, and `observedMembers`/`observedWeightedMax`/`censusOf` replaced every
 *    `?? "calm"`), and the 8th — `severityOf`'s ternary — was RE-RULED OK at its site: it returns
 *    `Severity | null` now, so the ternary is a MAPPING over an observed value, not a default.
 *
 * The re-derivation was done by RUNNING this sweep against the post-5.2 sources and reading the
 * three failure lists (7 stale roster entries at `found 0×`, one docblock/roster disagreement, zero
 * UNRULED sites) — never by editing the counts to match arithmetic.
 *
 * ⚠ RESOLVED 2026-08-03 — the one site this file used to call out as gated. `observedWeightedMax`'s
 * `if (vals.length === 0) return 0` was the FULLY-UNOBSERVED cell held at its pre-5.2 answer; OQ-5
 * Stage 5.3 (Option A2) turned it into `return null`, which is absence-PRESERVING and therefore not a
 * stand-in at all. The surviving null→0 conversion on the focus list is `leg-percentile.ts`'s
 * `isLiveCell`-guarded map; a twin in `growth.ts` is NOT swept (not a Stage 3.1 focus file).
 */
const ROSTER: RosterEntry[] = [
  // --- src/danger-member-state.ts (was in danger-engine.ts until the R4 peel, 2026-08-09) -----
  {
    file: "danger-member-state.ts",
    code: `return state === "RED" ? "lit" : state === "AMBER" ? "elev" : "calm";`,
    count: 1,
    verdict: "OK",
  },
  // --- src/danger-engine.ts -----------------------------------------------------------------
  {
    file: "danger-engine.ts",
    code: "return scaledSevBand(Math.max(0, ...cells.map((c) => c.wsev ?? 0)) as Sev);",
    count: 1,
    verdict: "OK",
  },
  {
    file: "danger-engine.ts",
    code: "return MEMBER_WEIGHT[memberId]?.[sleeve as LegKey] ?? 0;",
    count: 1,
    verdict: "OK",
  },
  {
    file: "danger-engine.ts",
    code: `const live = capableSet.filter((f) => isSensitiveState(stateOf.get(f) ?? "na")).length;`,
    count: 1,
    verdict: "OK",
  },
  // The share arm's `gp` term, collected for `FieldResult.exogenous`: 0 is `Math.max`'s identity, the value
  // the arm itself folds an unobserved `gp` as, so the served floor cannot manufacture exogenous danger.
  {
    file: "danger-engine.ts",
    code: "gpTermBySleeve.set(l.sleeve, s.gp ?? 0);",
    count: 1,
    verdict: "OK",
  },
  {
    file: "danger-engine.ts",
    code: "ew: { value: s.earlyWarn ?? 0, live: s.earlyWarn !== null },",
    count: 1,
    verdict: "OK",
  },
  {
    file: "danger-engine.ts",
    code: "sn: { value: s.stressNow ?? 0, live: s.stressNow !== null },",
    count: 1,
    verdict: "OK",
  },
  {
    file: "danger-engine.ts",
    code: "return members.every((m) => (cissDepth.get(m) ?? 0) > lookback);",
    count: 1,
    verdict: "OK",
  },
  {
    file: "danger-engine.ts",
    code: "...cluster.filter((s) => s !== sleeve).map((s) => ownDanger.get(s) ?? 0),",
    count: 1,
    verdict: "OK",
  },
  // --- src/t1dial.ts -----------------------------------------------------------------------
  {
    file: "t1dial.ts",
    code: "(sum, f) => sum + ((bandOf(f).contribution ?? AMBER) - AMBER) / (RED - AMBER),",
    count: 1,
    verdict: "OK",
  },
  // --- src/families.ts ---------------------------------------------------------------------
  {
    file: "families.ts",
    code: "return familyOf(id) ?? CARD_ONLY_GROUPS.find((g) => g.ids.includes(id))?.key;",
    count: 1,
    verdict: "OK",
  },
  {
    file: "families.ts",
    code: `const base: State = override ?? "GREEN";`,
    count: 1,
    verdict: "OK",
  },
  // --- src/leg-percentile.ts ---------------------------------------------------------------
  {
    file: "leg-percentile.ts",
    code: `return JSON.stringify(value) ?? "null";`,
    count: 1,
    verdict: "OK",
  },
  {
    file: "leg-percentile.ts",
    code: `.map((c) => (isLiveCell(c) ? (c.wsev ?? 0).toFixed(12) : null)),`,
    count: 1,
    verdict: "OK",
  },
  // --- src/alert-band.ts -------------------------------------------------------------------
  {
    file: "alert-band.ts",
    code: `cadence: r.indicator.cadence ?? "daily",`,
    count: 1,
    verdict: "OK",
  },
  {
    // ADDED 2026-09-09: `verdictHoldLegs`
    // stopped computing freshness and now READS the `stampFreshness` stamp, which introduced this
    // narrowing. OK, and narrowly so: the site is reached only under `r.lag === true`, and `lag` and
    // `ageDays` are written by the SAME `Freshness` object — `stampFreshness` sets both or neither
    // — so the pair cannot half-exist and the `?? 0` can never fabricate an age for a lagging leg.
    // A reading that went unstamped ("not assessed") has `lag === undefined` and is filtered out
    // upstream, so it never reaches here at all.
    file: "alert-band.ts",
    code: `ageDays: r.ageDays ?? 0,`,
    count: 1,
    verdict: "OK",
  },
  {
    file: "alert-band.ts",
    code: `const hyRising = (readings.find((r) => r.indicator.id === "F1")?.delta20 ?? 0) > 0;`,
    count: 1,
    verdict: "OK",
  },
  // --- src/danger-ladder.ts ----------------------------------------------------------------
  {
    file: "danger-ladder.ts",
    code: "new Set(ALL_LEGS.filter((s) => (row[s as LegKey] ?? 0) > 0)),",
    count: 1,
    verdict: "OK",
  },
];

interface Site {
  file: string;
  line: number;
  code: string;
  /** The verdict found in the docblock above the site, or null when there is none. */
  marked: Verdict | null;
}

/** Read one focus file and return its stand-in sites, comment lines excluded. */
function sweepFile(file: string): Site[] {
  const lines = readFileSync(new URL(`./${file}`, import.meta.url), "utf8").split("\n");
  const sites: Site[] = [];
  let inBlockComment = false;
  lines.forEach((raw, i) => {
    const t = raw.trim();
    const wasInBlock = inBlockComment || t.startsWith("/*");
    if (t.startsWith("/*")) inBlockComment = true;
    if (inBlockComment && t.includes("*/")) inBlockComment = false;
    // Comment lines never count — a verdict docblock must not indict itself.
    if (wasInBlock || t.startsWith("//") || t.startsWith("*")) return;
    if (!SWEEP.some((re) => re.test(raw))) return;
    let marked: Verdict | null = null;
    for (let k = i - 1; k >= 0 && k >= i - MARKER_LOOKBACK; k--) {
      const m = VERDICT_MARKER.exec(lines[k] ?? "");
      if (m) {
        marked = m[1] as Verdict;
        break;
      }
    }
    sites.push({ file, line: i + 1, code: t, marked });
  });
  return sites;
}

const SITES: Site[] = FILES.flatMap(sweepFile);
const key = (file: string, code: string) => `${file} ${code}`;

describe("OQ-5 Stage 3.1 - danger-path stand-in roster", () => {
  it("the sweep can see the danger path at all (guards a silently empty regex list)", () => {
    // Vacuity guard only (a silently empty regex list / unreadable file would zero this). This floor
    // was 20 pre-5.2, when 7 more `?? "calm"` sites existed.
    expect(SITES.length).toBeGreaterThan(12);
  });

  it("every stand-in on the danger path is in the roster", () => {
    const known = new Set(ROSTER.map((r) => key(r.file, r.code)));
    const unruled = SITES.filter((s) => !known.has(key(s.file, s.code))).map(
      (s) => `UNRULED stand-in src/${s.file}:${s.line} - ${s.code}`,
    );
    expect(unruled).toEqual([]);
  });

  it("no roster entry is stale, and each occurs exactly as many times as pinned", () => {
    const seen = new Map<string, number>();
    for (const s of SITES) seen.set(key(s.file, s.code), (seen.get(key(s.file, s.code)) ?? 0) + 1);
    const drift = ROSTER.filter((r) => (seen.get(key(r.file, r.code)) ?? 0) !== r.count).map(
      (r) => `src/${r.file}: pinned ${r.count}×, found ${seen.get(key(r.file, r.code)) ?? 0}× - ${r.code}`,
    );
    expect(drift).toEqual([]);
  });

  it("each site carries its verdict docblock, and the docblock agrees with the roster", () => {
    const byKey = new Map(ROSTER.map((r) => [key(r.file, r.code), r.verdict]));
    const bad = SITES.filter((s) => byKey.has(key(s.file, s.code)))
      .filter((s) => s.marked !== byKey.get(key(s.file, s.code)))
      .map(
        (s) =>
          `src/${s.file}:${s.line} - docblock says ${s.marked ?? "NOTHING"}, roster says ${byKey.get(
            key(s.file, s.code),
          )}`,
      );
    expect(bad).toEqual([]);
    expect(ROSTER.filter((r) => r.verdict === "WRONG")).toEqual([]);
  });
});
