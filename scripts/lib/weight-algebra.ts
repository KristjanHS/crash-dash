/**
 * weight-algebra.ts — decide, BEFORE reading a before/after table, whether a `MEMBER_WEIGHT` cell edit
 * can move any leg's danger at one close. A null table and a rotted control arm look identical on
 * screen; this is the seam that tells them apart, so the verdict is printed instead of the table.
 *
 * ⚠ SCOPED TO `familyShare` (Σ w·sev / Σ w, `danger-share.ts`): a weight edit is invisible there only when
 * the member is absent, its family's sole observed member, or at the observed siblings' weighted mean.
 * `uT` reads `trendShare` = that mean × min(1, full roster Σ w on the leg): a `uT` edit on a leg whose full
 * Σ w < 1 in either arm moves the ceiling itself, so it is `undetermined`, always.
 *
 * ⛔ THE PREDICATE MAY NEVER CERTIFY A SEATING CHANGE. `MEMBER_RELEVANCE` is derived from
 * `MEMBER_WEIGHT > 0` at module eval and `isRelevant` reads RELEVANCE, so an edit
 * crossing 0 (or absence) moves the cell's relevant set, `N` and the pillar
 * mass — none of which this arithmetic sees. Those return `undetermined`, always.
 *
 * ⛔ THE DANGER SCALAR IS NOT THE ONLY SEAM, AND THE SECOND ONE IS OUTPUT-VISIBLE. `memberScaledBand`
 * (`danger-engine.ts`) reads `memberWeight(m, leg) × SEV_NUM[state]` DIRECTLY off `MEMBER_WEIGHT` and
 * bands it through `scaledSevBand` — never through `familyShare`. Production path:
 * `techConfirmerFromPanel` (`t1dial.ts`, over `TECH_CONFIRMER_MEMBERS` × `TECH_LEGS`) →
 * `techConfirmerBreadth` → `computeT1Dial`, and THE DIAL BAND IS THE NOTIFY BAND (`run-core.ts`). A cell
 * share-invariant on the danger seam can still cross a `scaledSevBand` cut here and move the confirmer, the
 * band, `targetRung` and `held`. So the verdict carries a SECOND inequality (`input.dial`): an edit on
 * a dial member × dial leg must leave `dialBand(weight × sev)` fixed for every severity the member's
 * dial state could take, or the verdict is `undetermined`. The callers use this verdict to suppress the
 * WHOLE comparison table, dial columns included — a scope disclaimer cannot discharge that.
 *
 * ⛔ AN EMPTY EDIT LIST IS `undetermined`, NOT `identical`. A predicate that certifies "nothing moved"
 * when it was handed nothing to reason about is vacuous by construction, and the code-path arms
 * (`--before=hold|holdrelease|s61`) mutate no weight cell at all.
 */

/** One `MEMBER_WEIGHT[member][leg]` cell as the two arms hold it. `undefined` = the cell is ABSENT in
 *  that arm — like a 0, not relevant on the leg, so `familyShare` skips it. */
export interface CellEdit {
  member: string;
  leg: string;
  before: number | undefined;
  after: number | undefined;
}

/** The DIAL seam a `MEMBER_WEIGHT` cell reaches without touching the danger scalar — `memberScaledBand`
 *  as the tech confirmer drives it. Every field is READ FROM PRODUCTION by the caller, never re-typed. */
export interface DialSeam {
  /** The legs the per-member band maxes over — `TECH_LEGS` (`t1dial.ts`). */
  legs: readonly string[];
  /** The members actually read through `memberScaledBand` — `TECH_CONFIRMER_MEMBERS` (`t1dial.ts`). */
  members: readonly string[];
  /** `scaledSevBand` (`danger-engine.ts`). Compared by returned band, so the cut values stay in one place. */
  band: (scaled: number) => string;
  /** Every severity a member's dial state can carry — `Object.values(STATE_SEV)` (`danger-engine.ts`). */
  sevLevels: readonly number[];
}

export interface AlgebraInput {
  /** The `MEMBER_WEIGHT` cells the BEFORE arm moves. */
  edits: readonly CellEdit[];
  /** The second seam the verdict owes — see the ⛔ paragraph above. */
  dial: DialSeam;
  /** family id → its member roster (`FAMILY_MEMBERS`). A member in no roster is never read. */
  familyMembers: Readonly<Record<string, readonly string[]>>;
  /** The live weight of a cell; `undefined` when the cell is absent. */
  weight: (member: string, leg: string) => number | undefined;
  /** The member's numeric severity at the evaluated close (`SEV_NUM ∘ the held state map`);
   *  `undefined` when the member did not report — which EXCLUDES it from the family share. */
  severity: (member: string) => number | undefined;
}

export type AlgebraVerdict =
  /** every edit provably leaves every family share unchanged at this close; `lines` are the printable verdicts */
  | { kind: "identical"; lines: string[] }
  /** the arithmetic does not settle it — run the arms */
  | { kind: "undetermined"; reason: string };

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, ""));

/** Σ w·sev and Σ w over the OTHER observed, leg-relevant members of `family` — `familyShare`'s sums minus
 *  the edited member; `members` names them so a sibling edited in the same arm can be refused. */
function siblingSums(
  family: string,
  edited: string,
  leg: string,
  input: AlgebraInput,
): { num: number; den: number; members: string[] } {
  let num = 0;
  let den = 0;
  const members: string[] = [];
  for (const m of input.familyMembers[family] ?? []) {
    if (m === edited) continue;
    const w = input.weight(m, leg);
    if (w === undefined || w <= 0) continue;
    const s = input.severity(m);
    if (s === undefined) continue;
    num += w * s;
    den += w;
    members.push(m);
  }
  return { num, den, members };
}

/** The trend family — `trendShare` caps its mean at min(1, full roster Σ w), so its weights are not relative-only. */
const TREND_FAMILY = "uT";

/** Σ w (> 0) over the family's WHOLE roster on `leg`, observed or not, as one arm holds it — an edited cell
 *  reads that arm's value, every other cell `input.weight`. */
function fullWeight(family: string, leg: string, arm: "before" | "after", input: AlgebraInput): number {
  let sum = 0;
  for (const m of input.familyMembers[family] ?? []) {
    const e = input.edits.find((o) => o.member === m && o.leg === leg);
    const w = e === undefined ? input.weight(m, leg) : e[arm];
    if (w !== undefined && w > 0) sum += w;
  }
  return sum;
}

/**
 * THE SECOND INEQUALITY. `null` = the edit provably cannot move this member's dial band; otherwise the
 * severity at which `dialBand(weight × sev)` differs between the arms.
 *
 * ⚠ THE PER-LEG TEST IS THE MAX TEST, not a weaker stand-in for it. `memberScaledBand` bands
 * `max over legs`, and `band` is MONOTONE, so `band(max(x, o)) = max(band(x), band(o))` — if the edited
 * leg's own band is fixed across the arms, the max's band is too (any other dial leg that also moved is
 * itself an edit in this list and gets its own check).
 *
 * ⚠ THE HELD SEVERITY IS A FLOOR, NOT THE VALUE. `techConfirmerFromPanel` bands
 * `eff = max(live panel state, held state)`, so the dial severity is only ever `>=` the held one this
 * predicate is handed — every severity at or above it must be checked, and an unheld member (`undefined`)
 * costs the full sweep. An absent weight is 0, exactly as `memberWeight` reads it.
 */
function dialCrossing(e: CellEdit, dial: DialSeam, heldSev: number | undefined): number | null {
  if (!dial.members.includes(e.member) || !dial.legs.includes(e.leg)) return null;
  const before = e.before ?? 0;
  const after = e.after ?? 0;
  for (const sev of dial.sevLevels) {
    if (sev < (heldSev ?? 0)) continue;
    if (dial.band(before * sev) !== dial.band(after * sev)) return sev;
  }
  return null;
}

/** The share-invariance predicate: `identical` ⇔ every edited cell leaves each of its families' `familyShare`
 *  — and so `danger` — identical (up to fp rounding) at this close, so a before/after table is a guaranteed null run. */
export function weightEditVerdict(input: AlgebraInput): AlgebraVerdict {
  if (input.edits.length === 0) {
    return { kind: "undetermined", reason: "this arm moves no MEMBER_WEIGHT cell — nothing to decide" };
  }
  const lines: string[] = [];
  for (const e of input.edits) {
    const cell = `${e.member}×${e.leg}`;
    if (e.before === e.after) {
      lines.push(`IDENTICAL BY ALGEBRA (no-op cell: ${cell} holds the same value in both arms)`);
      continue;
    }
    // ⚠ BEFORE the family-roster shortcut below, deliberately: `memberScaledBand` does not consult a
    // family roster at all, so a member "unreachable" on the danger seam can still be a dial member.
    const crossAt = dialCrossing(e, input.dial, input.severity(e.member));
    if (crossAt !== null) {
      const b = (e.before ?? 0) * crossAt;
      const a = (e.after ?? 0) * crossAt;
      return {
        kind: "undetermined",
        reason:
          `${cell} moves the DIAL seam: at severity ${fmt(crossAt)}, memberScaledBand reads MEMBER_WEIGHT ` +
          `directly and bands ${fmt(b)} as ${input.dial.band(b)} before vs ${fmt(a)} as ` +
          `${input.dial.band(a)} after — the tech confirmer, the dial band and so targetRung/held can ` +
          "move with no family-share change at all, which this arithmetic does not see — run the arms",
      };
    }
    const families = Object.keys(input.familyMembers).filter((f) =>
      (input.familyMembers[f] ?? []).includes(e.member),
    );
    if (families.length === 0) {
      lines.push(
        `IDENTICAL BY ALGEBRA (unreachable: ${e.member} sits in no family roster, so no cell ever reads ` +
          `MEMBER_WEIGHT.${cell})`,
      );
      continue;
    }
    if (e.before === undefined || e.after === undefined || e.before === 0 || e.after === 0) {
      return {
        kind: "undetermined",
        reason:
          `${cell} is SEATED or UNSEATED by this edit (${e.before ?? "absent"} → ${e.after ?? "absent"}). ` +
          "MEMBER_RELEVANCE and the family's observed n move with it, which this arithmetic does not " +
          "see — run the arms",
      };
    }
    const sev = input.severity(e.member);
    for (const f of families) {
      if (f === TREND_FAMILY) {
        const lo = Math.min(fullWeight(f, e.leg, "before", input), fullWeight(f, e.leg, "after", input));
        if (lo < 1) {
          return {
            kind: "undetermined",
            reason:
              `${cell} edits the trend family on a leg whose full ${f} Σ w is ${fmt(lo)} < 1 in an arm — ` +
              "trendShare's ceiling min(1, Σ w) moves with the weight, so run the arms",
          };
        }
      }
      if (sev === undefined) {
        lines.push(
          `IDENTICAL BY ALGEBRA (absent member: ${e.member} did not report at this close, so ${cell} is ` +
            `excluded from ${f}'s share under both arms whatever its weight)`,
        );
        continue;
      }
      const sib = siblingSums(f, e.member, e.leg, input);
      if (sib.den === 0) {
        lines.push(
          `IDENTICAL BY ALGEBRA (sole observed member: ${f}'s share on ${e.leg} = sev(${e.member}) ` +
            `${fmt(sev)} under both arms whatever its weight)`,
        );
        continue;
      }
      const coEdited = sib.members.find((m) => input.edits.some((o) => o.member === m && o.leg === e.leg));
      if (coEdited !== undefined) {
        return {
          kind: "undetermined",
          reason: `${cell} shares family ${f} with ${coEdited}, also edited on ${e.leg} — the sibling mean moves too, so run the arms`,
        };
      }
      const mean = sib.num / sib.den;
      if (Math.abs(sev - mean) > 1e-12) {
        return {
          kind: "undetermined",
          reason:
            `${cell} is NOT share-invariant in family ${f}: sev ${fmt(sev)} ≠ the observed siblings' mean ` +
            `${fmt(mean)} (${sib.members.join(", ")}) — the edit moves ${f}'s weighted share, so run the arms`,
        };
      }
      lines.push(
        `IDENTICAL BY ALGEBRA (sibling-mean member: sev(${e.member}) ${fmt(sev)} = ${f}'s observed siblings' ` +
          "mean, so its weight cannot move the weighted share)",
      );
    }
  }
  return { kind: "identical", lines };
}
