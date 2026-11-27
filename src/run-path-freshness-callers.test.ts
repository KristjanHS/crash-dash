/**
 * SINGLE-COMPUTATION-SITE lint for run-path freshness (slice 3,
 * 2026-09-09).
 *
 * Slice 3 collapsed the run path onto ONE freshness computation so the run/read unit divergence it
 * closed cannot re-open: `stampFreshness`/`resolveFreshness` (scorers-core.ts) are the only place a
 * `daily`/`weekly` id is scored, and everything downstream (`verdictHoldLegs` in alert-band.ts, the
 * absent-member carry gate in dial-assembly.ts) READS that stamp rather than resolving again. A
 * SECOND run-path caller reaching for `assessFreshness`/`assessIndicatorFreshness` is the exact
 * defect that shape forbids — three docblocks (alert-band.ts, scorers-core.ts ×2) cite THIS file as
 * the guard that reds on it, so the guard has to exist and has to be able to fail.
 *
 * WHAT IT CHECKS. It greps `src/` + `scripts/` (non-`.test.ts` `.ts`) for CALL sites of
 * `assessFreshness(` / `assessIndicatorFreshness(`, skipping comment-only lines, and excluding:
 *   · the READ path — `src/feed-lag.ts` (and `api/`, which this scan never reaches);
 *   · the DEFINITION module `src/ladder.ts`, where the two functions live and one delegates to the
 *     other (an implementation detail, not a run-path consumer).
 * The surviving call sites must be exactly ALLOWED below: `scorers-core.ts` (the one computation) and
 * `run-core.ts`'s whole-run heartbeat, which is EXEMPT on purpose
 * (it stays calendar-day, the
 * fail-safe backstop, and must NOT be converted). Any other file with a surviving call reds.
 *
 * NOT VACUOUS: the scan asserts it found a real population and that BOTH allowed files still appear
 * as callers, so a broken glob or a renamed symbol reds instead of passing empty. This file is
 * `.test.ts`, so it excludes itself — the symbols named in this docblock cannot indict it.
 *
 * CAN-FAIL DEMONSTRATION (2026-09-09): a throwaway `assessIndicatorFreshness(...)` added to the run
 * path (dial-assembly.ts's carry gate) makes `offenders` name that file:line, red; removed, green.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");

const CALL = /assess(?:Indicator)?Freshness\s*\(/;
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

/** Files a run-path call may legitimately live in, each with WHY (so a reader sees the exemption). */
const ALLOWED: Record<string, string> = {
  "src/scorers-core.ts": "resolveFreshness — the run path's ONE freshness computation (pass 2 of stampFreshness)",
  "src/run-core.ts": "whole-run calendar-day heartbeat — the fail-safe backstop, exempt from slot conversion",
};

/** Neither run path nor read: the read path (feed-lag.ts) and the module the functions are DEFINED in. */
const EXCLUDE = new Set(["src/feed-lag.ts", "src/ladder.ts"]);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") out.push(...tsFiles(p));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const files = [...tsFiles(join(ROOT, "src")), ...tsFiles(join(ROOT, "scripts"))]
  .map((f) => f.slice(ROOT.length + 1).split("\\").join("/"))
  .filter((rel) => !EXCLUDE.has(rel));

/** Every non-comment run-path call site, as `rel:line`. */
const callSites = files.flatMap((rel) => {
  const hits: { rel: string; ref: string }[] = [];
  readFileSync(join(ROOT, rel), "utf8").split("\n").forEach((line, i) => {
    if (COMMENT_LINE.test(line)) return;
    if (CALL.test(line)) hits.push({ rel, ref: `${rel}:${i + 1}: ${line.trim()}` });
  });
  return hits;
});

describe("run path has a single freshness computation site", () => {
  it("scans a real population (a broken glob must not make the guard vacuous)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("both allowed callers are actually present (a renamed symbol must red, not pass empty)", () => {
    const callerFiles = new Set(callSites.map((h) => h.rel));
    for (const rel of Object.keys(ALLOWED)) expect(callerFiles).toContain(rel);
  });

  it("no run-path freshness caller outside the allowed set", () => {
    const offenders = callSites.filter((h) => !(h.rel in ALLOWED)).map((h) => h.ref);
    expect(
      offenders,
      "a SECOND run-path freshness caller appeared — read the stamp (resolveFreshness), never compute again",
    ).toEqual([]);
  });
});

// THE RUN PATH'S "TODAY" IS PER FEED (2026-09-13): `stampFreshness` is handed a
// `feedCalendarTodayResolver` over the run instant, never `clock().slice(0, 10)` — the UTC date
// that stamped every `Europe/*` feed a slot younger than `/api/status` at the 22:00 UTC cron hour.
describe("run-cycle stamps freshness on each feed's publication calendar", () => {
  const lines = readFileSync(join(ROOT, "src/run-cycle-dial.ts"), "utf8")
    .split("\n")
    .filter((line) => !COMMENT_LINE.test(line));

  it("freshnessToday is the per-feed resolver over the run clock", () => {
    const defs = lines.filter((l) => /\bconst freshnessToday\b/.test(l));
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatch(/feedCalendarTodayResolver\(new Date\(clock\(\)\)\)/);
  });

  it("every stampFreshness call passes freshnessToday, none a bare clock date", () => {
    const calls = lines.filter((l) => /\bstampFreshness\(/.test(l));
    expect(calls.length).toBeGreaterThan(0);
    for (const l of calls) {
      expect(l).toMatch(/stampFreshness\([^,]+, freshnessToday\b/);
      expect(l).not.toMatch(/clock\(\)/);
    }
  });
});
