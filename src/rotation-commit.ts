// Pure re-risk commit machine — the position/leg-layer decision that turns the LIVE band's
// candidate sleeve into the actually-HELD sleeve, applying the directional-asymmetry gates
// (M4/M5/M7/M8). Extracted VERBATIM from assembleRun's inline block (run.ts) so it is
// unit-testable without the heavyweight assembleRun scaffolding and so the run-core.ts wiring
// shrinks to a single call site. Constants come in via ./danger-ladder; the LADDER sleeve order
// via ./families (the W5-e rung clamp maps a clamped rung index back to a sleeve). No IO.
//
// Per-direction lag (M8, user-decided 2026-07-15): DE-RISK acts on 1 close — no deadband
// (DERISK_DEADBAND=0), no streak, no dwell, no trend gate. It once sat behind a 2-close member
// confirmation upstream; the directional fold (2026-08-26, instant-up) confirms a WORSE member
// state same-day, so this side still has no escalation buffering (stand-down is 2-close-buffered upstream).
//
// ⚠ **THE TIMING HALF OF THAT ASYMMETRY IS RETIRED — [USER] ruling 2026-08-07**.
// RE-RISK used to need ALL of: `improving`
// AND 2 consecutive improving closes (RERISK_CONFIRM) AND the trend family not RED AND
// >= RERISK_DWELL_DAYS closes held. Both timing constants went to zero and `improving` was dropped
// from the condition, so the shipped machine is now exactly:
//     !wantsMoreAggressive            -> commit (de-risk / hold-in-place / first hold)
//     wantsMoreAggressive && trendOk  -> commit
//     wantsMoreAggressive && !trendOk -> hold the prior leg
// The inline `RERISK_CONFIRM`/`RERISK_DWELL_DAYS` clauses are GONE from the condition; what replaced
// them is the `gates` SEAM (below), which defaults to those same constants (and to NO `improving`
// term) and is therefore `true` on every production close today. It is a re-arm seam, NOT protection
// — read its docblock before treating it as a live gate. The seam carries all THREE retired terms
// (`requireImproving` was added 2026-08-07, review finding 2): a `{confirm, dwellDays}`-only seam
// could not reproduce the pre-ruling decision, because `improving` left the condition rather than
// being tuned to a no-op value. `improving` went because it is a claim about the DIAL (`targetRung <
// prevTarget`) while `wantsMoreAggressive` is a claim about the CANDIDATE LEG; the field survives as
// the streak's accumulate/reset predicate only (see its `DecideRotationHoldInput` docblock).
// **THE ONE SURVIVING RE-RISK GATE IS `trendOk`** — a re-risk stays blocked while a uT member is
// confirmed RED. The counterweight to the lost timing gates is the halved `RERISK_DEADBAND`
// (`danger-engine.ts`), which narrows the PICK's candidate window upstream; it is not enforced here.
// The M6 vol-shock selection inherits the de-risk side: it escalates on 1 close off VT's same-day
// state (instant-up: a worse VT raw state confirms same-day, no escalation buffer), never gated
// here.
//
// Migration-default consequence (M7) — **NO LONGER A CONSEQUENCE, kept as the record of why the
// paragraph is gone.** It used to read: pre-migration alert rows report `held_days = 0`, so the FIRST
// post-deploy re-risk waits a full RERISK_DWELL_DAYS closes. With `RERISK_DWELL_DAYS = 0` a zero
// `held_days` costs nothing, so a pre-migration/degraded row no longer delays anything. `held_days`
// itself keeps ticking and keeps persisting (the FE renders it and a re-arm would need it); only its
// GATE is retired.
import { RERISK_CONFIRM, RERISK_DWELL_DAYS } from "./danger-ladder.js";
import { LADDER, rungOfSleeve } from "./families.js";

/** Inputs to the pure commit machine — all derived upstream in run-core.ts (band/field/trend reads +
 *  the prior persisted alert row). `newClose` is true only when this run sees a NEW trading close
 *  vs the prior row (weekend/holiday cron re-runs re-see the same close ⇒ false ⇒ no dwell tick). */
export interface DecideRotationHoldInput {
  candidateSleeve: string;
  prevHeld: string | null;
  prevRung: number;
  candidateRung: number;
  /** Danger FALLING on the DIAL — `dial.targetRung < prevTarget`, derived in `run-core.ts`.
   *
   *  ⛔ **NOT part of the commit condition since 2026-08-07** ([USER] ruling).
   *  It survives as EXACTLY ONE thing: the accumulate/reset
   *  predicate for `reriskConfirmCount` — the streak advances while it is true and resets to 0 when it
   *  is false. **Do not delete this field as dead** and do not re-add it to the condition: it makes a
   *  claim about the DIAL, whereas the commit decision is about the CANDIDATE LEG
   *  (`wantsMoreAggressive`), and the two genuinely diverge — a stable band whose danger re-orders the
   *  field toward a more-aggressive leg reads `improving === false` and must still commit, which is
   *  the case the drop exists for. */
  improving: boolean;
  trendOk: boolean;
  prevConfirmCount: number;
  prevHeldDays: number;
  newClose: boolean;
  /** W5-e drawdown clamp toggle — **PROBE-ONLY**, deliberately NOT wired to production
   *  (2026-07-21 revert ruling: faithful committed effect
   *  near-degenerate — 1 de-risk
   *  hit/18y, 0 in 2022, redundant with M8). Production omits it ⇒ `false` ⇒ this machine is
   *  byte-identical to pre-W5-e. Only the `probe-drawdown-*` scripts pass `true` to demonstrate what
   *  the clamp WOULD do; kept toggle-able + unit-tested so a future promotion re-decision has the exact
   *  mechanism. `true` ⇒ cap the rung step to ±1 per run (BOTH directions, D-2/§9). */
  drawdownGateFires?: boolean;
  /** **PROBE SEAM** — the retired re-risk commit
   *  terms: the two TIMING gates `{confirm, dwellDays}` (defaulting to the live `RERISK_CONFIRM` /
   *  `RERISK_DWELL_DAYS`) plus `requireImproving`, the dropped `improving` term (default `false` =
   *  shipped behaviour). **Every production call site omits the whole object**, so the shipped path
   *  stays a single code path with no live toggle (W5-e `drawdownGateFires` precedent).
   *
   *  ⚠ **At the shipped values (1 / 0 / no `requireImproving`) the resulting term is `true` on every
   *  close** — it is a re-arm seam and a probe entry point, NOT protection; nothing here blocks a
   *  re-risk today. The timing halves are written as a read of the constants rather than deleted
   *  outright for one reason: §5's fallback ladder re-arms `RERISK_CONFIRM 1 → 2` (or
   *  `RERISK_DWELL_DAYS 0 → 1`) by editing the constant alone, and a condition that had stopped
   *  reading them would silently ignore that edit.
   *
   *  ⚠ **`requireImproving` exists because the seam is otherwise INCOMPLETE** (review finding 2,
   *  2026-08-07): `improving` left the CONDITION, not just the constants, so no value of
   *  `{confirm, dwellDays}` could restore the pre-ruling answer for `improving: false, trendOk: true,
   *  prevConfirmCount >= 2, prevHeldDays >= 3` — the stable-band re-order that HELD before the ruling
   *  and commits after it. Option (a) of the review (complete the seam) was taken over option (b)
   *  (narrow the docblocks) because §5 makes this seam the INSTRUMENT for the later churn
   *  re-decision, and a timing-only replay under-counts the legacy hold rate on every such close.
   *
   *  Probe arms pass `LEGACY_RERISK_GATES` (`danger-ladder.ts`, the frozen `{2, 3, requireImproving}`
   *  triple) to reproduce the pre-2026-08-07 decision EXACTLY — that is what demonstrates the seam can
   *  change the answer. */
  gates?: { confirm: number; dwellDays: number; requireImproving?: boolean };
}

interface DecideRotationHoldResult {
  heldSleeve: string;
  reriskConfirmCount: number;
  heldDays: number;
}

export function decideRotationHold(input: DecideRotationHoldInput): DecideRotationHoldResult {
  const {
    candidateSleeve,
    prevHeld,
    prevRung,
    candidateRung,
    improving,
    trendOk,
    prevConfirmCount,
    prevHeldDays,
    newClose,
    drawdownGateFires = false,
    gates = { confirm: RERISK_CONFIRM, dwellDays: RERISK_DWELL_DAYS },
  } = input;

  // Held-leg min-dwell LEDGER (M7): trading closes the current held leg has survived. Ticks once per
  // NEW close only. It no longer GATES anything at the shipped `RERISK_DWELL_DAYS = 0` — it is
  // persisted, rendered by the FE, and read by the `gates` seam below.
  const dwellNow = prevHeldDays + (newClose ? 1 : 0);

  const wantsMoreAggressive = prevHeld != null && candidateRung > 0 && candidateRung < prevRung;

  // Retired-terms seam — see `DecideRotationHoldInput.gates`. `true` on every close at the shipped defaults
  // (1 / 0 / no `requireImproving`), so the live condition below reduces to
  // `wantsMoreAggressive && trendOk`. Only a probe passing `LEGACY_RERISK_GATES` (or a §5 re-arm of
  // the constants) can make it false. `requireImproving` re-ands the DROPPED `improving` term — the
  // half no timing value can reproduce (review finding 2).
  const legacyOk =
    prevConfirmCount + 1 >= gates.confirm &&
    dwellNow >= gates.dwellDays &&
    (!gates.requireImproving || improving);

  let heldSleeve: string;
  let reriskConfirmCount: number;
  if (!wantsMoreAggressive) {
    // de-risk / hold-in-place / step MORE defensive / first-ever hold — commit now, reset the streak.
    heldSleeve = candidateSleeve;
    reriskConfirmCount = 0;
  } else if (trendOk && legacyOk) {
    // A re-risk with the trend family confirming — commit on THIS close, exactly as de-risk does, and
    // reset the streak. No `improving` term: a stable band whose field re-orders toward a
    // more-aggressive leg rotates here too (2026-08-07 ruling, §3.2).
    heldSleeve = candidateSleeve;
    reriskConfirmCount = 0;
  } else {
    // The one surviving blocker: trend NOT confirming (a uT member is confirmed RED) — or, under a
    // probe/re-armed `gates`, an unmet legacy term (timing, or the frozen `improving`). HOLD the
    // prior leg. The streak accumulates while
    // the DIAL is improving and resets otherwise — that predicate, and nothing else, is what
    // `improving` is still here for.
    heldSleeve = prevHeld!;
    reriskConfirmCount = improving ? prevConfirmCount + 1 : 0;
  }

  // W5-e drawdown-gate clamp — PROBE-ONLY seam, NOT wired to production (2026-07-21 revert ruling).
  // Production omits `drawdownGateFires` ⇒ false ⇒ this
  // block is skipped ⇒ output
  // byte-identical to pre-W5-e; only the `probe-drawdown-*` scripts pass `true`. When it DOES fire, it
  // caps the rung STEP to ±1 per run in EITHER direction (D-2/§9), applied to the FINAL M8-committed
  // rung (`heldSleeve` above) so it composes with the re-risk gates: M8 decides WHETHER to re-risk;
  // this caps HOW FAR per run. `prevRung > 0` guards cold-start. Reuses the run-core.ts `rungOf` semantics
  // (LADDER index+1), never a 2nd index.
  if (drawdownGateFires && prevRung > 0) {
    const committedRung = rungOfSleeve(heldSleeve) ?? 0; // 0 = absent (the guard below reads it)
    if (committedRung > 0 && Math.abs(committedRung - prevRung) > 1) {
      const clampedRung = prevRung + Math.sign(committedRung - prevRung); // one rung toward the target
      heldSleeve = LADDER[clampedRung - 1]!;
    }
  }

  // heldDays resets to 0 on ANY held-leg change (either direction) — so a de-risk move restarts the
  // dwell LEDGER. At the shipped `RERISK_DWELL_DAYS = 0` that reset costs nothing: a de-risk →
  // immediate re-bounce is free (it was blocked a full 3 closes before 2026-08-07). The reset is kept
  // because the ledger must stay truthful for the FE and for any `gates` re-arm.
  const heldDays = heldSleeve !== prevHeld ? 0 : dwellNow;

  return { heldSleeve, reriskConfirmCount, heldDays };
}
