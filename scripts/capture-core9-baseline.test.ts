import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCensus, controlArmFaithful, serialize } from "./capture-core9-baseline.js";
import { SIGNALS, MEMBER_WEIGHT } from "../src/danger-ladder.js";
import { ALL_INDICATORS } from "../src/registry.js";

/**
 * CORE-9 Stage B — pins the COMMITTED module-eval census
 * (`capture-core9-baseline.snapshot.json`) against the live tables.
 *
 * CONSEQUENCE, INTENDED: this is a PERMANENT regression pin on the family / tier / weight tables
 * that outlives the CORE-9 plan. Any legitimate change to `GLOBAL_FAMILIES` / `CONFIRM_TIERS` /
 * `MEMBER_WEIGHT` / `LEG_FIELD` / `DANGER_CUTS` must consciously regenerate it:
 *
 *     npm run probe:core9
 *
 * Mutation check (the falsifier is ABLE to fail): change any value in the snapshot JSON — e.g. a
 * `CONFIRM_TIERS` entry 0 → 1 — and the equality test below goes red naming that line. For the
 * weight-table sibling, mutate a `dangerLadder.MEMBER_WEIGHT` cell in the snapshot instead: that
 * test reds separately, printing the ordering-table ceremony a weight change owes (demonstrated
 * red 2026-08-08).
 */
const SNAPSHOT = readFileSync(join(__dirname, "capture-core9-baseline.snapshot.json"), "utf8");

describe("CORE-9 module-eval census", () => {
  it("the live census still equals the committed snapshot", () => {
    // Compared line-by-line first so a drift reports the offending row rather than a 36 kB blob.
    const live = serialize(buildCensus()).split("\n");
    const pinned = SNAPSHOT.split("\n");
    const firstDiff = live.findIndex((l, i) => l !== pinned[i]);
    // The regen command rides IN the failure message, not only in the docblock above: the census is
    // regenerable by design, so a legitimate table change must cost a command, not a memory lookup.
    expect(
      { line: firstDiff, text: firstDiff < 0 ? null : live[firstDiff] },
      "census drift — if the table change is intended, regenerate with `npm run probe:core9` and commit the snapshot",
    ).toEqual({
      line: -1,
      text: null,
    });
    expect(live.length).toBe(pinned.length);
  });

  // Sibling to the equality pin above, and deliberately in its OWN `it`: the runner stops at the
  // first failing assertion, so a weight drift living inside that test would be masked by the
  // line-by-line assertion and never print the ceremony it owes. A weight/normalization change owes
  // MORE than a snapshot regen, and that duty used to stand as prose in
  // `.claude/rules/research-probes.md` — a rule gated on globs that never reached
  // `src/danger-ladder.ts`, where the weight tables actually live. It now rides in the failure
  // message below, so it is billed only when a weight table has actually moved and cannot go stale.
  it("the weight-bearing tables still equal the snapshot", () => {
    const snap = JSON.parse(SNAPSHOT) as { dangerLadder: Record<string, unknown> };
    const live = buildCensus().dangerLadder as Record<string, unknown>;
    const WEIGHT_KEYS = ["MEMBER_WEIGHT", "FAMILY_LEG_WEIGHT", "MEMBER_RELEVANCE"] as const;
    // Vacuity anchor: a renamed/dropped key would make `pick` compare {} to {} and pass forever.
    for (const k of WEIGHT_KEYS) {
      expect(Object.keys(snap.dangerLadder)).toContain(k);
      expect(Object.keys(live)).toContain(k);
    }
    // SECOND ORACLE, and the reason this is not just an equality pin: the snapshot is REGENERABLE by
    // design, so `pick(live) === pick(snap)` is also satisfied by a DEGENERATE regeneration — if
    // `buildCensus` ever emitted `MEMBER_WEIGHT: {}` both sides would be `{}` and both the equality
    // and the anchor above would still pass. (`MEMBER_RELEVANCE` cannot close that hole: its census
    // row is `stable(reach)`, the probe's own `deriveReach` REIMPLEMENTATION, so it pins the probe,
    // not the table.) Comparing the SNAPSHOT's member roster against the production symbol imported
    // here reds on exactly that: a snapshot that has stopped covering the table it claims to census.
    expect(
      Object.keys(snap.dangerLadder.MEMBER_WEIGHT as Record<string, unknown>).sort(),
      "the snapshot's MEMBER_WEIGHT roster no longer matches production `MEMBER_WEIGHT` — either a " +
        "member was seated/retired without regenerating (`npm run probe:core9`), or the census stopped " +
        "emitting the real table",
    ).toEqual(Object.keys(MEMBER_WEIGHT).sort());
    const pick = (o: Record<string, unknown>) =>
      Object.fromEntries(WEIGHT_KEYS.map((k) => [k, o[k]]));
    expect(
      pick(live),
      "weight-table drift — beyond regenerating the snapshot with `npm run probe:core9`, a weight or " +
        "normalization change owes ONE 9-leg before/after ordering table over `LADDER` " +
        "(`src/families.ts`) off a real-close replay — `npm run probe:leg-ordering` — batched per " +
        "change-SET at the end of the arc, never per edit, and pasted into the commit message. If a " +
        "vintage moved, commit the regenerated file in the SAME commit; CI never checks vintage " +
        "freshness.",
    ).toEqual(pick(snap.dangerLadder));
  });

  // NOT a "non-empty beside an exact pin": the snapshot is REGENERABLE by design, so the equality
  // test above can be satisfied by a degenerate regeneration. These pins read a DIFFERENT oracle —
  // the live `SIGNALS` / `ALL_INDICATORS` tables — and red exactly when a regenerated snapshot has
  // stopped covering the population it claims to census.
  it("the load-bearing rows cover their live population", () => {
    const snap = JSON.parse(SNAPSHOT) as {
      perFamilyMemberCount: { dial: Record<string, number> };
      memberRelevanceReachSet: string[];
      confirmClosesFor: Record<string, number>;
    };
    expect(Object.keys(snap.perFamilyMemberCount.dial).sort()).toEqual([...SIGNALS].sort());
    expect(Object.keys(snap.confirmClosesFor).sort()).toEqual(
      [...new Set(ALL_INDICATORS.map((i) => i.id))].sort(),
    );
    // Every pair is `<memberId>|<legSleeve>`, and the set is sorted — a reach row emitted in
    // insertion order (the non-determinism this census exists to exclude) reds here.
    expect(snap.memberRelevanceReachSet).toEqual([...snap.memberRelevanceReachSet].sort());
    expect(snap.memberRelevanceReachSet.every((p) => /^[^|]+\|[^|]+$/.test(p))).toBe(true);
  });

  // The census computes its `MEMBER_RELEVANCE` / reach rows from the probe's OWN reimplementation
  // (`deriveReach`), never from the production symbol. The cost is
  // that production `MEMBER_RELEVANCE` could change its rule with the snapshot, the pin above and
  // `npm run check` all staying green. `controlArmFaithful()` closes that hole, but it ran only
  // inside `main()` — i.e. never under `npm run check`. Asserted here so the permanent pin actually
  // pins production.
  it("the in-probe reach derivation still reproduces production MEMBER_RELEVANCE", () => {
    expect(controlArmFaithful()).toBeNull();
  });
});
