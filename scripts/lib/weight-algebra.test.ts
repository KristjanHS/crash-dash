import { describe, it, expect } from "vitest";
import { weightEditVerdict, type AlgebraInput, type DialSeam } from "./weight-algebra.js";
import { scaledSevBand, STATE_SEV, type Sev } from "../../src/danger-engine.js";

/** A two-family roster with one leg. `cr` carries the edited member `A` plus a sibling `B`; `vl` is
 *  there so a member in NO roster is distinguishable from a member in an empty one. */
const familyMembers = { cr: ["A", "B"], vl: ["C"] } as const;

const LEG = "Semis";

/** ⚠ THE CUTS COME FROM PRODUCTION. `band`/`sevLevels` read `scaledSevBand`/`STATE_SEV`
 *  (`danger-engine.ts`) so a cut retune moves this fixture with the code instead of past it. The default
 *  roster is `F4` — i.e. NOT the fixtures' edited member `A` — so the danger-seam cases below stay about
 *  the danger seam; the dial cases override `members` to seat `A` on it. */
const dial: DialSeam = {
  legs: [LEG],
  members: ["F4"],
  band: (scaled: number) => scaledSevBand(scaled as Sev),
  sevLevels: Object.values(STATE_SEV),
};

function input(over: Partial<AlgebraInput>): AlgebraInput {
  return {
    edits: [],
    familyMembers,
    dial,
    weight: () => undefined,
    severity: () => undefined,
    ...over,
  };
}

describe("weightEditVerdict — the two-sided claim", () => {
  it("CERTIFIES a member at its observed siblings' mean", () => {
    // `A` and `B` both lit: `cr`'s share is 1 whatever `A` weighs.
    const v = weightEditVerdict(
      input({
        edits: [{ member: "A", leg: LEG, before: 0.2, after: 0.3 }],
        weight: (m) => (m === "A" ? 0.3 : m === "B" ? 0.9 : undefined),
        severity: (m) => (m === "A" || m === "B" ? 1 : undefined),
      }),
    );
    expect(v.kind).toBe("identical");
    expect(v.kind === "identical" && v.lines[0]).toContain("IDENTICAL BY ALGEBRA");
    expect(v.kind === "identical" && v.lines[0]).toContain("sibling-mean member");
  });

  it("REFUSES a DIAL-seam cell the danger seam dominates — the SECOND inequality", () => {
    // The case above with `A` on the dial roster: share-invariant, but `memberScaledBand` bands 0.2
    // GREEN and 0.3 AMBER off MEMBER_WEIGHT directly, moving the confirmer, dial band and targetRung/held.
    const v = weightEditVerdict(
      input({
        edits: [{ member: "A", leg: LEG, before: 0.2, after: 0.3 }],
        dial: { ...dial, members: ["A"] },
        weight: (m) => (m === "A" ? 0.3 : m === "B" ? 0.9 : undefined),
        severity: (m) => (m === "A" || m === "B" ? 1 : undefined),
      }),
    );
    expect(v.kind).toBe("undetermined");
    expect(v.kind === "undetermined" && v.reason).toContain("moves the DIAL seam");
  });

  it("still CERTIFIES a dial member whose scaled band does NOT cross a cut", () => {
    // The refusal above must be the cut crossing, not "is a dial member" — 0.3 → 0.4 both band AMBER at
    // every severity the member can hold, and `B` still pins the share. Without this the second
    // inequality could degrade into a blanket refusal and the certify side would be dead.
    const v = weightEditVerdict(
      input({
        edits: [{ member: "A", leg: LEG, before: 0.3, after: 0.4 }],
        dial: { ...dial, members: ["A"] },
        weight: (m) => (m === "A" ? 0.4 : m === "B" ? 0.9 : undefined),
        severity: (m) => (m === "A" || m === "B" ? 1 : undefined),
      }),
    );
    expect(v.kind).toBe("identical");
  });

  it("IGNORES a dial member edited on a leg the dial never maxes over", () => {
    // `memberScaledBand` maxes over TECH_LEGS only, so an edit off that list cannot reach the dial —
    // the second inequality must not refuse it (0.2 → 0.3 WOULD cross, on a dial leg).
    const v = weightEditVerdict(
      input({
        edits: [{ member: "A", leg: "Health", before: 0.2, after: 0.3 }],
        dial: { ...dial, members: ["A"] },
        weight: (m) => (m === "A" ? 0.3 : m === "B" ? 0.9 : undefined),
        severity: (m) => (m === "A" || m === "B" ? 1 : undefined),
      }),
    );
    expect(v.kind).toBe("identical");
  });

  it("REFUSES a lit member beside a calm sibling — its weight moves the weighted share", () => {
    const v = weightEditVerdict(
      input({
        edits: [{ member: "A", leg: LEG, before: 0.2, after: 0.3 }],
        weight: (m) => (m === "A" ? 0.3 : m === "B" ? 0.9 : undefined),
        severity: (m) => (m === "A" ? 1 : m === "B" ? 0 : undefined),
      }),
    );
    expect(v.kind).toBe("undetermined");
    expect(v.kind === "undetermined" && v.reason).toContain("NOT share-invariant");
  });

  it.each([
    ["absent member", undefined, 1],
    ["sole observed member", 1, undefined],
  ])("certifies the %s", (line, sevA, sevB) => {
    const v = weightEditVerdict(
      input({
        edits: [{ member: "A", leg: LEG, before: 0.2, after: 0.9 }],
        weight: (m) => (m === "A" ? 0.9 : m === "B" ? 0.5 : undefined),
        severity: (m) => (m === "A" ? sevA : m === "B" ? sevB : undefined),
      }),
    );
    expect(v.kind === "identical" && v.lines[0]).toContain(line);
  });

  it("REFUSES a sibling-mean member when that sibling is edited in the same arm", () => {
    const v = weightEditVerdict(
      input({
        edits: [
          { member: "A", leg: LEG, before: 0.2, after: 0.3 },
          { member: "B", leg: LEG, before: 0.9, after: 0.8 },
        ],
        weight: (m) => (m === "A" ? 0.3 : m === "B" ? 0.8 : undefined),
        severity: (m) => (m === "A" || m === "B" ? 1 : undefined),
      }),
    );
    expect(v.kind === "undetermined" && v.reason).toContain("also edited");
  });

  it("certifies a member seated in NO family roster as unreachable", () => {
    const v = weightEditVerdict(
      input({
        edits: [{ member: "DB_SMH", leg: LEG, before: 0.2, after: 0.9 }],
        weight: () => 0.9,
        severity: () => 1,
      }),
    );
    expect(v.kind).toBe("identical");
    expect(v.kind === "identical" && v.lines[0]).toContain("unreachable");
  });

  it("REFUSES a seating change even when the arithmetic would dominate it", () => {
    // 0 → 0.3 beside a lit sibling at A's sev: the share is untouched, but MEMBER_RELEVANCE and
    // the family's observed n move, and this predicate cannot see either.
    const v = weightEditVerdict(
      input({
        edits: [{ member: "A", leg: LEG, before: 0, after: 0.3 }],
        weight: (m) => (m === "A" ? 0.3 : m === "B" ? 0.9 : undefined),
        severity: () => 1,
      }),
    );
    expect(v.kind).toBe("undetermined");
    expect(v.kind === "undetermined" && v.reason).toContain("SEATED or UNSEATED");
  });

  it("REFUSES an empty edit list rather than certifying it vacuously", () => {
    const v = weightEditVerdict(input({ edits: [] }));
    expect(v.kind).toBe("undetermined");
    expect(v.kind === "undetermined" && v.reason).toContain("no MEMBER_WEIGHT cell");
  });

  it("REFUSES a uT cell on a leg whose full uT Σ w < 1 — the weight IS trendShare's ceiling", () => {
    // GT×Health is uT's sole observed member there: relative-only algebra would certify it, but
    // trendShare reads 1 × min(1, Σ w) = .4 before vs .5 after.
    const v = weightEditVerdict(
      input({
        edits: [{ member: "GT", leg: "Health", before: 0.4, after: 0.5 }],
        familyMembers: { uT: ["GT", "GB"] },
        weight: (m, leg) => (m === "GT" && leg === "Health" ? 0.4 : undefined),
        severity: (m) => (m === "GT" ? 1 : undefined),
      }),
    );
    expect(v.kind).toBe("undetermined");
    expect(v.kind === "undetermined" && v.reason).toContain("trendShare's ceiling");
  });

  it("REFUSES when the edited member is share-invariant in one family but not its second", () => {
    // `A` sits in `cr` (at B's mean) and `vl` (beside a calm `C`) — the per-family AND the verdict owes.
    const v = weightEditVerdict(
      input({
        edits: [{ member: "A", leg: LEG, before: 0.2, after: 0.3 }],
        familyMembers: { cr: ["A", "B"], vl: ["A", "C"] },
        weight: (m) => (m === "A" ? 0.3 : m === "B" || m === "C" ? 0.9 : undefined),
        severity: (m) => (m === "A" || m === "B" ? 1 : m === "C" ? 0 : undefined),
      }),
    );
    expect(v.kind).toBe("undetermined");
  });
});
