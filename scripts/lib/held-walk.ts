/**
 * held-walk.ts — transitions + exit verdict for `probe-leg-ordering.ts --walk --held`. Pure: a separate
 * module only because the probe loads the store at top level and cannot be imported by a test.
 */

/** One walked close: the sleeve `decideRotationHold` committed and its `LADDER` rung (1 = most aggressive). */
export interface HeldStep {
  date: string;
  held: string;
  rung: number;
}
export interface HeldTransition {
  date: string;
  from: string;
  to: string;
  direction: "de-risk" | "re-risk";
}
export interface HeldWalkVerdict {
  transitions: HeldTransition[];
  deRisks: number;
  reRisks: number;
  distinctHeld: string[];
  /** ≥1 de-risk AND ≥1 re-risk — a window that never rotates both ways cannot rank an engine. */
  ok: boolean;
}

/** A held change between consecutive closes; a higher rung is a de-risk, a lower one a re-risk. */
export function heldTransitions(steps: readonly HeldStep[]): HeldTransition[] {
  const out: HeldTransition[] = [];
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1]!;
    const cur = steps[i]!;
    if (cur.held === prev.held) continue;
    out.push({ date: cur.date, from: prev.held, to: cur.held, direction: cur.rung > prev.rung ? "de-risk" : "re-risk" });
  }
  return out;
}

export function heldWalkVerdict(steps: readonly HeldStep[]): HeldWalkVerdict {
  const transitions = heldTransitions(steps);
  const deRisks = transitions.filter((t) => t.direction === "de-risk").length;
  const reRisks = transitions.length - deRisks;
  return {
    transitions,
    deRisks,
    reRisks,
    distinctHeld: [...new Set(steps.map((s) => s.held))],
    ok: deRisks >= 1 && reRisks >= 1,
  };
}
