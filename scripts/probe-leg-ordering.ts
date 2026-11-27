/**
 * probe-leg-ordering.ts — the 9-leg danger ORDERING table over `LADDER`, off a real-close replay.
 *
 *   npx tsx scripts/probe-leg-ordering.ts --env=prod --json=/tmp/leg-ordering-before.json
 *   npm run probe:leg-ordering -- --env=prod --walk=FROM..TO --held
 *   (`--held` folds the HEAD arm through `decideRotationHold`; exits 1 unless ≥1 de-risk AND ≥1 re-risk.)
 *
 * ⚠ `--json`'s SHAPE DEPENDS ON THE ARM. Under `--arm=before|after` the panel is top-level
 * (`rows`/`band`/`targetRung`/`held`/`exogenous`); under `--arm=diff` that block is OMITTED and the panel
 * lives only under `arms.before`/`arms.after`. Rationale at the `jsonOut` block. And on an A/A abort
 * `--arm=diff` exits non-zero BEFORE writing, so no file appears at all — a `--json` caller has two
 * distinct failure modes, not one. ⚠ `--before=hold` is the ONE exemption: its A/A is a result, so it
 * prints the verdict, writes the file and exits 0 (see the `hold` arm entry below).
 *
 * WHY IT EXISTS. The EU-Fin leg swap's Stage 1.2 / Stage 6.2(a) owes a
 * 9-leg BEFORE/AFTER ordering table over `LADDER` off a real-close replay (the standing
 * normalization/weight-change duty, carried since 2026-08-08 by the weight-table pin in
 * `scripts/capture-core9-baseline.test.ts`). The BEFORE arm is
 * unrecoverable once the rung-7 rename lands, so both arms run THIS instrument, same store, same
 * `asOf` convention. `probe-absence-field.ts` prints the same shape but is welded to the OQ-5
 * control arm (a densified calm-imputing panel) and to the LOCAL store; `probe-top2-position.ts`
 * emits dial terms (`positionP`/`rung`/band), not a per-leg danger table. Neither answers "what is
 * the ordering of the nine legs at one close", so this probe is the smallest honest instrument.
 *
 * THE ENGINE IS IMPORTED, NEVER REIMPLEMENTED. The scalar is the SHIPPED `computeField(...)`
 * `legRows[].danger` — the same number `run-core.ts` pushes on. Only the per-close panel
 * reconstruction (forward-fill → `computeFamilyPanel` → `computeT1Dial` → `computeField`) is
 * mirrored here, byte-for-byte as `probe-absence-field.ts` / `probe-drawdown-bite.ts` do it,
 * because `src/replay.ts`'s `ReplayPoint` exposes no per-leg danger.
 *
 * CONVENTIONS THE AFTER ARM MUST REPEAT (a before/after across two conventions is not a comparison):
 *   - store: whichever `--env` names (Stage §0.5 ruling 1: PROD for both arms);
 *   - `asOf`: `--asOf=YYYY-MM-DD`, defaulting to the LATEST close on the union axis of the dial
 *     members. State the resolved date beside the table — a default-resolved `asOf` differs between
 *     runs on different days;
 *   - no `freshness` stamp is passed (severity-neutral: S-2 holds a stale member at its last state),
 *     matching `probe-absence-field.ts`; `prevTarget` is `null` so no hysteresis from a prior close
 *     enters the pick.
 *
 * ⚠ STRICTLY READ-ONLY: the only store call is `getSeries`, which selects. Nothing here inserts,
 * updates, upserts or deletes — it is safe against prod, which is what §0.5 ruling 1 requires.
 *
 * ── `--arm=before|after|diff` (added 2026-08-02) ──────────────────────────────────────────────────
 * A ruling owes the same 9-leg before/after table for
 * the US-sourced-reach weight change — but that change ALREADY SHIPPED (`git log --grep 'seat the ruled
 * US-sourced reach'`), so the two-code-states protocol above is no longer available: the BEFORE weights
 * exist only in git. `--arm=before` reconstructs them IN-PROBE, from the frozen literals below, and
 * `--arm=diff` runs both arms in ONE process off ONE store read so the panel is provably identical
 * across arms.
 *
 * ⚠ THE LITERALS ARE FROZEN AND MUST NEVER BE IMPORTED. A control arm that read `MEMBER_WEIGHT` would
 * read the value under test, the arms would collapse to A/A, and the probe would still print a fully
 * populated table. `--arm=diff` therefore ABORTS when the two arms agree
 * leg-for-leg — see the collapse detector below.
 *
 * ⚠ AN A/A ABORT IS OFTEN THE GUARD WORKING, NOT A PROBE DEFECT — PICK A SEPARATING `--asOf`. A member
 * enters the leg fold as `weight × severity(state)`, and a GREEN member's severity is 0. So for a
 * MEMBER-WEIGHT cell, at a close where every seated member is calm the two arms MUST agree leg-for-leg:
 * the collapse is arithmetic, not a broken control arm. A FAMILY weight enters the share as a normalized
 * mass, so a calm panel is not by itself proof that a FAMILY-weight change is inert.
 * Do NOT soften the abort — it cannot tell that case from a genuinely collapsed control, which is exactly
 * why it refuses to print a populated all-zero table. Instead pass an `--asOf` at which the seated members
 * were LIT; `--asOf=2025-04-08` is a recorded separating close. To find out WHICH branch a given close is
 * in (present-and-calm vs absent), run `probe-member-contribution.ts` at that close — it prints the
 * per-member status words.
 *
 * ── `--before=eufin|brent|gpseat|hold|value|r6|s61|defleg|f5|eufinw` (added 2026-08-02; `gpseat` same
 *    day; `hold` 2026-08-04; `value` + `r6` + `s61` 2026-08-05; an `s62` arm existed 2026-08-05..08-07 and
 *    was DELETED with the lead-precedence gate — see the note at the end of the `s61` entry) ─────────
 * WHICH counterfactual the BEFORE arm reconstructs. A ruling settled
 * that the EXOGENOUS measurement extends THIS probe rather than adding a new one, and that the default
 * stays `eufin` so every pre-existing invocation is byte-identical. `--before` is orthogonal to `--arm`:
 * `--arm` picks which arms run, `--before` picks what the BEFORE arm is.
 *
 *   eufin  (DEFAULT) — the `EUFIN_SEATED_KEYS` EU-Fin member-reach arm documented above. Unchanged.
 *   gpseat           — the pre-Stage-A `gp × EU-Fin` magnitudes (`GP_SEAT_BEFORE`, below) against the
 *                      shipped row. A PURE MAGNITUDE swap: both cells stay seated in both arms, so no
 *                      `MEMBER_RELEVANCE` revert is owed. ⚠ NOT YET RUN — the
 *                      re-seat shipped unmeasured by user decision 2026-08-02; the arm exists so the
 *                      ordering table can still be taken later without reconstructing the before-state
 *                      from git.
 *   brent            — the §0.65-finding-2 INCREMENTAL arm. ⚠ **RE-INVERTED 2026-08-06** when the [USER]
 *                      ruling RE-SEATED `MEMBER_WEIGHT.BRENT` (at the shape ×1.0, tying `OVX`),
 *                      overturning §7.1's 2026-08-02 drop. It is back to its original DELETION shape:
 *                      `before` = HEAD minus BRENT's row (and its `MEMBER_RELEVANCE` entry), `after` =
 *                      HEAD with it. §6.5's bar: the row moves nothing iff removing it permutes NO leg's
 *                      rank on ANY close in the ruled window. That bar was MET in 2026-08-02 (293/293
 *                      A/A, zero permutations, `--env=prod --walk=2025-06-24..2026-07-27`) and the row was
 *                      dropped on it; the 2026-08-06 ruling re-seats the row at a weight tie with `OVX`,
 *                      which dominates only at equal severity (a BRENT RED · OVX GREEN close makes BRENT the
 *                      strict argmax), so A/A is NOT the prediction — the effect is UNMEASURED. ⚠ A re-run measures the LIVE ×1.0 row, not the
 *                      ×0.5 one the banked 293/293 was measured with (`BRENT_ROW_PRE_DROP`, kept below for
 *                      that provenance only).
 *   hold             — the pre-Stage-2.1 UNHELD member state.
 *                      ⚠ THE ONE ARM
 *                      THAT MUTATES NO CONSTANT: it threads `probeHoldOff: true` into the BEFORE arm's
 *                      `computeFieldProbe` call, which forces `holdOn = false` so all three member-state
 *                      reconstruction sites fall back to the unheld builders while `cissHistory` keeps
 *                      flowing to the pillars. There is therefore nothing to freeze, nothing to undo, and
 *                      no re-pin duty when a weight is retuned — the control is a code PATH, exact by
 *                      construction rather than by transcription.
 *                      ⛔ THE CONSTANT-MUTATION SHAPE (zeroing `SIGNAL_HOLD_CLOSES` in-probe, the idiom every
 *                      other arm uses) WAS CONSIDERED AND REJECTED, and must not be re-offered as
 *                      equivalent: `buildMemberStateHeldAt` floors its window at `Math.max(hold, 1)`, so a
 *                      zeroed map STILL reads the newest member-history close and can still resurrect a
 *                      member the live panel lacks. That arm isolates WINDOW LENGTH, not the seam.
 *                      ⚠ Zeroing `cissHistory` was rejected too — it also drops the
 *                      regime/ROC bases, so that arm would measure two changes at once.
 *                      ⚠ A/A IS A WRITABLE RESULT ON THIS ARM ALONE (ruling 2): under `--arm=diff` an
 *                      exact leg-for-leg agreement prints its verdict, writes `--json` and exits 0,
 *                      because "the hold moved nothing at this close" is the measurement. Every other
 *                      arm's single-close abort stays hard.
 *                      ⚠ `probeHoldOff` routes to the UNHELD builders, so a Δ here is the whole timing axis's
 *                      HOLD. (Until 2026-08-07 it also turned the lead-precedence gate off, and a
 *                      `leadgate` arm isolated that gate; the gate is retired,
 *                      and both notes with it.)
 *   holdrelease      — the hold fold as it stood BEFORE arm C, i.e. the plain MAX over the whole window
 *                      with no release on observed recovery.
 *                      THE SECOND ARM THAT MUTATES NO CONSTANT: it threads
 *                      `probeHoldNoRelease: true` into the BEFORE arm's `computeFieldProbe` call (and into the
 *                      dial-chip held map built off `buildMemberStateHeld`, so the field and the band ride
 *                      the SAME fold), which skips `heldFoldMap`'s release branch and nothing else.
 *                      ⛔ NOT `--before=hold`: that one unhelds the member state entirely, so it measures
 *                      C-vs-UNHELD and would double-count Stage 2.1's already-banked move. The contrast
 *                      owed here is C-vs-CUR, which is why the engine carries a SECOND flag rather than a
 *                      widened `probeHoldOff` (`probeHoldOff` keeps meaning "the pre-Stage-2.1 unheld control").
 *                      ⛔ THE CONSTANT-MUTATION SHAPE IS REJECTED HERE FOR THE SAME REASON AS ON `hold`:
 *                      there is no `SIGNAL_HOLD_CLOSES` value that expresses "fold without releasing", so no
 *                      in-probe map could reconstruct this counterfactual at all.
 *                      ⚠ A/A IS NOT WRITABLE ON THIS ARM off a single close (unlike `hold`): the plan
 *                      pre-registers that the table MUST move on a screened separating close (C changes
 *                      188 of 489 raises), so a single-close A/A aborts and sends you to `--walk`.
 *   value          — the `Value` COLUMN as it stood immediately before the retune commit ("feat(ladder)!:
 *                      Stage 2 -- retune the Value column on XDEV holdings", 2026-08-05), i.e. at
 *                      its parent. Owed by the Value weight retune's ruling 5.
 *                      ⚠ WHY THE RETUNE'S PARENT AND NOT `HEAD^`: the retune IS the commit that moved the
 *                      `Value` column, so its parent is the before-state by definition. ⚠ RETRACTION —
 *                      THE COMMIT MESSAGE THAT SHIPPED THIS ARM STATES A FALSE
 *                      MECHANISM for that choice: it claims the arc's later review-fix is "inside
 *                      the arc" and carries weight moves the arm must undo cumulatively. It carries
 *                      NONE — the review-fix's `src/danger-ladder.ts` diff is comment-only. The message was
 *                      NOT amended (this repo reports wrong commits, it does not rewrite them), so a
 *                      reader may still meet the false reason; the CONCLUSION it reached is nonetheless
 *                      correct. Falsifier — EMPTY on the review-fix, 26 lines on the retune (so it CAN fail):
 *                        git show <commit> -- src/danger-ladder.ts | grep -E "^[-+]" \
 *                          | grep -v "^[-+][-+]" | grep -vE "^[-+][[:space:]]*[/][/]"
 *                      This matters for the re-pin duty below: a future re-pin must target the commit
 *                      that MOVED the column, not the arc's last commit.
 *                      TWO SHAPES IN ONE ARM, and both are needed or it is not the before-state:
 *                      (1) the MAGNITUDE half — 7 `MEMBER_WEIGHT` cells (`R2`, `F1`, `EBP`,
 *                          `FXH`, `F9`, `GT`, `GB`) and 2 `FAMILY_LEG_WEIGHT` cells (`rt`, `xa`)
 *                          move back to their frozen pre-retune values; and
 *                      (2) the SEATING half — `F4`/`F6`/`F8` (all `uT`) GAINED a `Value` cell in the
 *                          retune, so the arm DELETES those three cells — the pre-retune key set
 *                          (`familyShare` skips an absent and a 0-weight cell alike).
 *                      `MEMBER_RELEVANCE` is re-derived for every touched member (see
 *                      `applyValueBeforeArm`) — it is built at MODULE EVAL from `MEMBER_WEIGHT`, so the
 *                      seating half never reaches it otherwise.
 *   r6               — the `MEMBER_WEIGHT.R6` row as it stood before the row-fill ("feat(audit §3.6):
 *                      fill MEMBER_WEIGHT.R6 to 9 cells off a stated duration mechanism", 2026-07-31)
 *                      — the 9-leg ordering table `danger-ladder.ts` records as still OWED at the `rt`
 *                      block. The row-fill was PURELY ADDITIVE on that row (4 cells → 9, no magnitude
 *                      moved), so the arm DELETES the five cells it added and touches nothing else.
 *                      ⚠ THAT IS DELIBERATELY NOT "revert R6 to the row-fill's parent". The pre-edit row's
 *                      `High-Div` 0.8 cell was RENAMED to `EU-Fin` (a later commit) and then CUT to 0.4 by
 *                      a SEPARATE later edit (EU-Fin Stage 4.1). Restoring the whole
 *                      literal row would fold that unrelated cut into the same before/after and the
 *                      measurement would no longer be the row-fill's. The surviving four cells are
 *                      identical in both arms by construction.
 *   s61              — the pre-Stage-6.1 DIAL-CHIP SEAM.
 *                      The THIRD arm that mutates no
 *                      constant, and a BUILDER-SEAM swap rather than a code-path flag: `evaluateArm`'s
 *                      held branch calls `buildMemberStateHeldAt(at.cissHistory, 0)` —
 *                      the window-only map both this probe and `assembleDial` built
 *                      until Stage 6.1 — instead of the shipped
 *                      `buildMemberStateHeld({ globalFamilies }, cissHistory)` =
 *                      merge(LIVE panel, raw-held). Δ here is 6.1's RAISE alone: a lead lit LIVE
 *                      but not yet in the persisted member-history window enters the merged map while the
 *                      window-only map leaves it dark.
 *                      ⚠ IT MUST NOT FLIP `probeHoldOff` — that is the `hold` arm; turning it on would fold
 *                      a second change into this one.
 *                      ⚠ THE COLD-STORE BRANCH IS DELIBERATELY SHARED, NOT REVERTED. The true
 *                      pre-6.1 line had no `noHoldDepth` branch (the predicate arrived with Stage
 *                      6.2, ruling 10), but reverting it here would measure 6.1 AND 6.2 as one edit. So
 *                      both arms take the identical cold-store fallback and this arm isolates 6.1's seam
 *                      alone; on a depth-less close the two arms are A/A by construction.
 *                      ⚠ IT FREEZES NO LITERAL — no weight table, no constant, no vintage. So unlike
 *                      `eufin`/`value`/`r6` it carries NO control-re-pin duty when a weight is retuned,
 *                      and NONE MAY BE ADDED: the control is a code path, exact by construction. (Its
 *                      A/A is still a hard ABORT under `--arm=diff`, unlike `hold` — see the
 *                      collapse detector.)
 *                      ⚠ IT DOES, HOWEVER, DEPEND ON `buildMemberStateHeldAt`'s SEMANTICS. That builder is
 *                      the baseline: the arm is exact only while it still computes what it computed
 *                      before 6.1 (raw-held over a window floored at `Math.max(hold, 1)` — before 6.1
 *                      the lead-precedence gate was still applied on top; it was retired 2026-08-07 and the
 *                      builder now returns the ungated map). 6.1 moved
 *                      the DIAL-CHIP call site off it (`assembleDial` now builds `buildMemberStateHeld`),
 *                      so no production dial path constrains it any more — it stays live only through
 *                      `computeField`'s `statePrev` and `pillarPairAt` (danger-engine.ts), which is why it
 *                      is not deletable-as-dead-code but IS silently re-definable. A change to its body
 *                      re-bases this arm's before-state without touching a literal, and nothing here would
 *                      abort. This is a semantics dependency, NOT a re-pin duty: there is no frozen copy to
 *                      re-pin, and the "freezes no literal / no re-pin duty" claim above is unaffected.
 *                      ⚠ RECORDED DEFECT — NOW DISCHARGED (Stage 6.4.2, 2026-08-05). As shipped at
 *                      `5884c0ec` the collapse detector was NARROWER THAN THIS ARM'S SURFACE: it compared
 *                      `danger` and `rank` only, while this seam reaches the dial chip ⇒ `techConfirmerP`
 *                      ⇒ `band`/`targetRung`/`held`/`inBand`, so a band-only Δ still ABORTED as A/A. Both
 *                      detectors now also compare `band`/`targetRung`/`held`/`inBand` under `s61`
 *                      (`seamSurfaceSeparated`); `techConfirmerP` itself stays uncompared because
 *                      `ArmResult` does not carry it. ⚠ THE BANKED `s61` VERDICT BELOW IS UNCHANGED BY
 *                      THE FIX — it was TOTAL A/A on every one of those columns, read by hand off
 *                      `--arm=before` beside `--arm=after`, so the widened detector reaches the same abort.
 *                      Measured 2026-08-05 on prod at `2025-04-08` and `2026-03-27`: A/A on danger, rank,
 *                      band, targetRung AND held. ⚠ THESE ARE NOT TWO INDEPENDENT CONFIRMATIONS.
 *                      `2025-04-08` is BAND-SATURATED (`band=[9,9]`), so every band-surfaced column is
 *                      pinned by the saturation and can register no Δ whatever the chip does — it is
 *                      DEGENERATE for this arm. The load-bearing close is `2026-03-27`.
 *                      ⚠ THE A/A's MECHANISM — corrected 2026-08-05 (Stage 6.4.2). A working-tree
 *                      perturbation of this branch to an EMPTY map moved none of the columns either. What
 *                      that SHOWS is: the branch is taken, and nothing DOWNSTREAM moved. What it was
 *                      originally read as — "the dial chip's held map was simply inert there" — is NOT
 *                      established by it, because 6.4.2 measured at the SAME close that `techConfirmerP`
 *                      is 0 on both arms: under the fixed /2 denominator with `TECH_CONFIRMER_FLOOR` at
 *                      2-of-2, an empty map drives BOTH slots null ⇒ p = 0, which is where the shipped arm
 *                      already sat. That annihilation explains a null perturbation result just as well as
 *                      inertness, so the perturbation cannot discriminate the two. ATTRIBUTE THE A/A TO
 *                      THE /2-FLOOR ANNIHILATION, not to an inert map. The VERDICT (A/A at both closes) is
 *                      untouched — only the mechanism sentence was unverified.
 *                      Read a `--arm=before` header beside `--arm=after` before concluding
 *                      "nothing moved" from an abort.
 *                      ⚠ THE `s62` ARM THAT SAT BESIDE THIS ONE IS GONE (2026-08-07).
 *                      It isolated Stage 6.2's
 *                      "a gate-DELETED confirmer member becomes a `null` slot" rule against a FROZEN
 *                      transcription of the pre-6.2 `techConfirmerFromPanel`. With the lead-precedence
 *                      gate retired the shipped merge asks no gate, so the frozen BEFORE and the shipped
 *                      AFTER were byte-equivalent and the arm could only ever abort A/A — vacuous by
 *                      construction, not a measurement. Deleted rather than left to print a dead control.
 *
 *   defleg           — the DEFENSIVE-COLUMN state before the cr<->rt swap commit, i.e. at its parent.
 *                      A PURE MAGNITUDE swap on four cells; nothing is seated or
 *                      de-seated, so `MEMBER_RELEVANCE` is identical across arms by construction and
 *                      the arm re-derives it anyway (the rule is `weight > 0`, and both F3 magnitudes
 *                      are > 0):
 *                        FAMILY_LEG_WEIGHT.cr.Health   0.9 → 1.0
 *                        FAMILY_LEG_WEIGHT.cr.Staples  0.9 → 0.85
 *                        FAMILY_LEG_WEIGHT.rt.Health   1.0 → 0.85
 *                        MEMBER_WEIGHT.F3.Staples      0.4 → 0.5
 *                      ⚠ `FAMILY_LEG_WEIGHT.rt.Staples` was 1.0 before and is 1.0 now — it is NOT
 *                      frozen here, deliberately: freezing a cell the arc did not move would make a
 *                      later legitimate retune of it re-base this counterfactual for no reason.
 *                      ⛔ THERE IS NO NAMED (`hold`/`s61`/`holdrelease`-style) A/A EXEMPTION ON THIS ARM —
 *                      a single-close A/A exits 1. ⚠ THAT IS NOT THE SAME AS "any A/A exits 1": the
 *                      ALGEBRA exemption still applies and exits 0, and it fires here routinely (it did
 *                      on the newest prod close, 2026-08-20). ⚠ AND THE ALGEBRA VERDICT IS
 *                      MEMBER-SCOPED ONLY — `snapshotWeights` captures `MEMBER_WEIGHT` alone and
 *                      `weight-algebra.ts` models only the `MEMBER_WEIGHT` → Level-1-max seam, so of
 *                      this arm's four cells it sees `F3.Staples` and NONE of the three FAMILY ones.
 *                      That costs no wrong measurement (`compareArms` evaluates both arms in full and
 *                      gates the verdict), but it means a ROTTED family literal — one that drifted back
 *                      to HEAD's magnitude, which the absence-only drift guard cannot see either — can
 *                      print "IDENTICAL BY ALGEBRA / screen another close" instead of announcing the
 *                      rot. Only walk mode's total-collapse abort catches that, which is the other
 *                      reason THE WALK IS THE MEASUREMENT on this arm.
 *                      Family weights enter `pillarShare`'s mean rather than a family share, so they
 *                      move a leg's number whenever that family carries any
 *                      severity at all — which is why a walk-wide A/A here would be a dead control.
 *                      ⚠ RE-PIN DUTY: any later retune of one of the four cells above re-bases this
 *                      arm — re-pin `DEFLEG_*_BEFORE` in the same commit. The drift guard catches a
 *                      cell that has gone ABSENT at HEAD; it cannot see a magnitude that moved (a
 *                      frozen BEFORE equal to HEAD would simply collapse that cell to A/A).
 *   eufinw           — the pre-retune EU-Fin cells (`EUFIN_CELLS_PRE_RETUNE`, AT1 unseated), a plain
 *                      weight arm. Re-pin on any cell retune.
 *
 * ⚠ SEPARATE ARMS, NEVER MERGED (§6.6 ruling 5). `value` and `r6` move DIFFERENT rows; a combined arm
 * can cancel to A/A and report "no ordering change" for two real edits. Run them one at a time.
 *
 * ⚠ `STATE_SEV` (below) is frozen at `severityOf ∘ SEV_NUM` (`danger-member-state.ts`) — never import it.
 * ⚠ THE `brent` ARM'S FROZEN LITERAL — PROVENANCE ONLY SINCE 2026-08-06 (the arm re-inverted to a
 * DELETION when the row was re-seated, so it reads the LIVE row; this literal is what the banked 293/293
 * A/A was measured with, and it differs from HEAD's ×1.0 row). LIKEWISE NEVER IMPORT IT:
 *     MEMBER_WEIGHT.BRENT (pre-§7.1)  transcribed at `BRENT_ROW_PRE_DROP` below
 *                                                          (from `src/danger-ladder.ts` at the last commit before §7.1)
 * ── `--walk=FROM..TO` (added 2026-08-02) ─────────────────────────────────────────────────────────
 * An ASCENDING sweep over the union axis instead of one anchor. `--asOf` remains the single-close form
 * and the two are MUTUALLY EXCLUSIVE (passing both aborts). Walk mode always runs BOTH arms — it IS the
 * diff — so `--arm` is ignored there. §6.4 merges the screening and the measurement: the ruled window is
 * §0.65 finding 1's co-covered BOUNDS, `2025-06-24 → 2026-07-27`.
 *
 * ⚠ THOSE BOUNDS SELECT 293 CLOSES HERE, NOT §0.65's 268 — TWO DIFFERENT AXES, NOT A DISCREPANCY. This
 * walk sweeps the DIAL UNION axis (every `DIAL_FAMILIES` member id — 36 members, 3975 closes on prod as
 * measured 2026-08-02), so a date enters the sweep when ANY dial member printed. §0.65's 268 was counted
 * on the `gp`-member OBSERVATION axis (G1/OVX/BRENT only). Identical bounds, different denominators.
 * Do NOT "correct" the walk's evaluated count back to 268 — a mismatch there is expected by construction.
 *
 * ⚠ IN WALK MODE THE A/A ABORT MOVES UP A LEVEL (§6.4) — AND IT IS SCOPED TO THE CONTROL ARMS. A
 * per-close collapse is EXPECTED on a max-fold (9 of 15 on the EU-Fin arc) and is Stage 2's screening
 * RESULT, not a defect — so the walk never aborts per close. For a CONTROL arm (`eufin` and the weight arms) a TOTAL
 * collapse is the genuine dead-control signal and still aborts non-zero: §6.4 ruled the abort for exactly
 * that case.
 *
 * ⛔ BUT UNDER `--before=brent` A TOTAL COLLAPSE IS THE DECISIVE MEASUREMENT, NOT A FAILURE. `brent` is
 * §6.5's INCREMENTAL arm and its bar is "drop `MEMBER_WEIGHT.BRENT` iff removing the row permutes NO
 * leg's rank on ANY close" — i.e. "every close collapsed" IS the DROP outcome. Aborting there would make
 * the `§6.5 BAR: … DROP` line this probe exists to print unreachable by construction, and would skip the
 * `--json` write in exactly the case that closes the decision. So under `--before=brent` a total collapse
 * prints the FULL aggregate block (DROP line included), writes `--json`, and exits 0. ⚠ This is now a
 * RE-PROOF, not an open question: the bar was met and §7.1 DROPPED the row (2026-08-02). ⚠⚠ The row was
 * then RE-SEATED [USER] 2026-08-06 at the shape ×1.0, a cell-wise weight TIE with `OVX` — which wins the
 * `max` whenever BRENT is the more severe of the two — so a total collapse is a MEASURED outcome here, not
 * the predicted one; the exit-0 handling is unchanged because the arm's bar is unchanged.
 * ⛔ `--before=hold` IS EXEMPT FROM BOTH ABORTS for the same structural reason (Stage 2.2 rulings 2+3):
 * it freezes no literal, so "the arms agree" can never mean "the control rotted" — it means the hold moved
 * nothing on the evaluated close(s), which is the result the stage owes. It prints, writes `--json`, exits 0.
 * Single-close `--asOf` mode keeps its own per-close abort unchanged for every OTHER `--before`.
 *
 * Walk stdout (§6.8 ruling 2): ONE compact line per SEPARATING close — date · which legs permuted rank ·
 * max |Δ| and the leg carrying it — then the aggregate block the commit message needs (A/A collapse
 * count, rank-move close count, held-move close count, overall max |Δ| + leg, rank-permutation count).
 * A/A-collapsed closes print NOTHING and are counted only.
 *
 * ⚠ `--json` GAINS A THIRD SHAPE UNDER `--walk`: no top-level panel and no `arms` block — the file is
 * `{probe, store, before, walk:{from,to,closes,evaluated}, aggregate, closes:[{date, collapsed,
 * rankMoves, heldMove, maxAbsDelta, arms:{before,after}}]}`. So all three shapes are distinguished by
 * naming: `.rows` (single arm), `.arms` (`--arm=diff`), `.closes` (`--walk`).
 *
 * ── THIS INSTRUMENT IS STRUCTURALLY BLIND TO STAGE 6.3 — the discharge in place of an arm ─────────
 * Stages
 * 6.1 and 6.2 each got a `--before=` arm and a 9-leg table; Stage 6.3 gets THIS ARGUMENT INSTEAD,
 * because running the table for it would bank an A/A that is guaranteed by construction and read like
 * safety evidence — a vacuous confirmer. Four facts, each about THIS FILE's wiring:
 *
 *   1. its only import from `src/dial-assembly.ts` is `DIAL_FAMILIES`, which ORIGINATES in
 *      `src/danger-ladder.ts` and was untouched by 6.3 — so the 132-line `dial-assembly.ts` hunk cannot
 *      reach this probe through the one symbol it borrows;
 *   2. it imports NOTHING from `api/lab.ts` and never calls `assembleDial`, so 6.3's two lab confirmer
 *      arms and its `heldMemberState` return are both off the measured path;
 *   3. 6.3's `src/replay.ts` hunk is a ruling-12 exemption COMMENT (+5 lines, no code), and this probe
 *      imports nothing from `src/replay.js` in any case;
 *   4. 6.3's review-fix hunk in `src/t1dial.ts` is DOCBLOCK PROSE ONLY
 *      (`git show <review-fix> -- src/t1dial.ts | grep -E '^[-+]'` returns no code line), so
 *      `techConfirmerFromPanel` — which this probe DOES import from there — is byte-identical across 6.3.
 *
 * ⚠ THE TWO COMMITS THE FOUR FACTS ARE ABOUT are the 6.3 feat and its review fix, and they
 * touch exactly five files: `api/lab.ts`, `api/lab.test.ts`, `src/dial-assembly.ts`, `src/replay.ts`,
 * `src/t1dial.ts`. That is a HISTORICAL fact about two landed commits — re-checkable with
 * `git show --name-only <feat> <review-fix>`, but NOT falsifiable by any grep of this file. Find both
 * by SUBJECT (ruling 14a) — never by a quoted hash: pre-rebase copies of them are NOT ancestors of `main`,
 * so re-derive and confirm with `git merge-base --is-ancestor`.
 *
 * ⛔ THIS IS A SCOPE CLAIM ABOUT THE INSTRUMENT, NOT A CLAIM THAT 6.3 IS BEHAVIOUR-FREE. Stage 6.3
 * changed `/api/lab`'s two confirmer arms; that change is real and is tested in `api/lab.test.ts`.
 * Never re-quote this paragraph as "6.3 moved nothing".
 *
 * ⚠ FACTS 1 AND 2 ARE ABOUT WIRING, AND NOTHING IN THE SUITE ENFORCES THEM — re-check this file for a
 * dial-assembly / `api/lab` specifier or a dynamic `import(` (comments stripped) before re-quoting them.
 * ⛔ NEVER ANCHOR A FALSIFIER OVER THIS FILE TO `^import` (`docs/claim-verification.md` §59). It writes
 * several top-level imports in MULTI-LINE form (`danger-ladder.js`, `danger-engine.js` among them), so a
 * line-anchored grep goes green on a real `api/` import written across lines while reading as file-wide. Match the SPECIFIER, which sits on the `} from …` line in both
 * shapes. (The denominator read `8` from this paragraph's first drafting until 2026-08-05; it was
 * carried forward once through a reconcile before a review re-counted it. Re-count, never re-quote.)
 */
import { writeFileSync } from "node:fs";
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import {
  MEMBER_WEIGHT,
  FAMILY_LEG_WEIGHT,
  MEMBER_RELEVANCE,
  FAMILY_MEMBERS,
} from "../src/danger-ladder.js";
import { computeFamilyPanel, LADDER, rungOfSleeve } from "../src/families.js";
import { DIAL_FAMILIES } from "../src/dial-assembly.js";
import {
  computeT1Dial,
  techConfirmerBreadth,
  techConfirmerFromPanel,
  TECH_LEGS,
  TECH_CONFIRMER_MEMBERS,
} from "../src/t1dial.js";
import {
  computeFieldProbe,
  pillarValue,
  scaledSevBand,
  type Sev,
  type MemberStateMap,
  trendConfirming,
} from "../src/danger-engine.js";
import type { Severity } from "../src/danger-cell.js";
import { DANGER_CUTS } from "../src/danger-concentration.js";
import { decideRotationHold } from "../src/rotation-commit.js";
import {
  buildMemberState,
  buildMemberStateHeld,
  buildMemberStateHeldAt,
  noHoldDepth,
} from "../src/danger-member-state.js";
import type { State } from "../src/domain-types.js";
import {
  weightEditVerdict,
  type CellEdit,
  type AlgebraVerdict,
} from "./lib/weight-algebra.js";
import { argOf, hasFlag, envArg as envArgOf } from "./lib/cli.js";
import { heldWalkVerdict, type HeldStep } from "./lib/held-walk.js";
import { ledgerBand, BAND_LETTER, bandChanges, formatBandChanges } from "./lib/ledger-band.js";
import { loadSeriesWith, unionCalendar, panelAt, makeCursor, MEMBER_WINDOW, type Panel } from "./lib/replay-walk.js";

/** Mirrors `dial-assembly.ts`'s private `MEMBER_HISTORY_PAD` (=30), as `probe-absence-field.ts` does. */
const MEMBER_HISTORY_PAD = 30;
const FETCH_LIMIT = 20_000;


const envArg = envArgOf("local");
if (envArg !== "local" && envArg !== "prod") {
  console.log(`ABORT: --env must be local|prod (got ${argOf("env")}).`);
  process.exit(1);
}
const asOfArg = argOf("asOf");
if (asOfArg !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(asOfArg)) {
  console.log(`ABORT: --asOf must be YYYY-MM-DD (got ${asOfArg}).`);
  process.exit(1);
}
const jsonOut = argOf("json");
const armArg = (argOf("arm") ?? "after") as "before" | "after" | "diff";
if (armArg !== "before" && armArg !== "after" && armArg !== "diff") {
  console.log(`ABORT: --arm must be before|after|diff (got ${argOf("arm")}).`);
  process.exit(1);
}
/** WHICH counterfactual the BEFORE arm reconstructs. `eufin` is the default so every invocation that
 *  predates this flag stays byte-identical. */
const beforeArg = (argOf("before") ?? "eufin") as
  | "eufin"
  | "brent"
  | "gpseat"
  | "hold"
  | "holdrelease"
  | "value"
  | "r6"
  | "s61"
  | "defleg"
  | "f5"
  | "eufinw";
if (
  beforeArg !== "eufin" &&
  beforeArg !== "brent" &&
  beforeArg !== "gpseat" &&
  beforeArg !== "hold" &&
  beforeArg !== "holdrelease" &&
  beforeArg !== "value" &&
  beforeArg !== "r6" &&
  beforeArg !== "s61" &&
  beforeArg !== "defleg" &&
  beforeArg !== "f5" &&
  beforeArg !== "eufinw"
) {
  console.log(
    `ABORT: --before must be eufin|brent|gpseat|hold|holdrelease|value|r6|s61|defleg|f5|eufinw (got ${argOf("before")}).`,
  );
  process.exit(1);
}
const walkArg = argOf("walk");
if (walkArg !== undefined && !/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/.test(walkArg)) {
  console.log(`ABORT: --walk must be FROM..TO as YYYY-MM-DD..YYYY-MM-DD (got ${walkArg}).`);
  process.exit(1);
}
if (walkArg !== undefined && asOfArg !== undefined) {
  console.log(
    "ABORT: --walk and --asOf are mutually exclusive — --asOf is the single-close form, --walk the\n" +
      "    sweep. Pass exactly one.",
  );
  process.exit(1);
}
const [walkFrom, walkTo] = walkArg === undefined ? [undefined, undefined] : walkArg.split("..");
if (walkFrom !== undefined && walkTo !== undefined && walkFrom > walkTo) {
  console.log(`ABORT: --walk range is descending (${walkFrom} > ${walkTo}) — the sweep is ascending.`);
  process.exit(1);
}
/** `--held` (walk only): one HEAD arm folded close by close through `decideRotationHold`, as `run-core.ts` does. */
const heldArg = hasFlag("held");
if (heldArg && walkArg === undefined) {
  console.log("ABORT: --held needs --walk=FROM..TO — it threads hold state across closes.");
  process.exit(1);
}

/** ⚠ THIS PINS THE KEY SET, NOT THE VALUES — deliberately, and it is the stronger form. The seven
 *  `EU-Fin` cells listed here are the ones the EU-Fin seating commit SEATED, every one verifiably ABSENT before it, so
 *  the true before-state is *absence* and the BEFORE arm reconstructs it by DELETING these keys rather
 *  than overwriting them with frozen magnitudes. Nothing here COMPARES AGAINST a frozen magnitude (the
 *  arm does read each value, at `applyBeforeArm`'s presence check and to build the undo), so a later
 *  legitimate retune of e.g. `MEMBER_WEIGHT.F1["EU-Fin"]` does not re-base the counterfactual: the arm
 *  still deletes the same cell and still measures seated-vs-absent.
 *
 *  ⚠ THE DRIFT GUARD IS ONE-DIRECTIONAL — it catches the SUBTRACTIVE half only. `applyBeforeArm` aborts,
 *  per key, when one of these seven is gone from HEAD. It CANNOT see ADDITIVE drift: seat a NEW `EU-Fin`
 *  cell after that seating without adding it here and the BEFORE arm deletes the old seven, leaves the new
 *  one standing, the collapse detector still passes and the table still prints — but it is no longer a
 *  before/after of the seating. Two open weight-seating arcs make that live
 *  (defensive-leg member weights, R2 Semis weight demotion), so
 *  RE-DERIVE this set when either seats an `EU-Fin` cell.
 *
 *  NEVER import these from `danger-ladder.ts`: importing the table under test collapses the arms to A/A.
 *  The BEFORE arm removes precisely these keys and nothing else — `cr`/`rt`/`vl` on `EU-Fin` are out of the arc's
 *  scope and identical in both arms. */
const EUFIN_SEATED_KEYS = {
  member: ["F1", "R5", "FXH", "CG", "GT"],
  family: ["xa", "uT"],
} as const;
const EU_FIN = "EU-Fin";

/** Applies the BEFORE state by deleting the seven seated cells, and returns the undo. Mutation is safe:
 *  neither table is frozen and the engine reads them live on every call (no memo), so cell relevance
 *  re-derives inside the arm rather than leaking across arms.
 *
 *  ⚠ `MEMBER_RELEVANCE` MUST BE REVERTED TOO — and it is the one that actually bites. `isRelevant`
 *  (hence `computeCells`' relevant set) reads `MEMBER_RELEVANCE`, NOT `MEMBER_WEIGHT`. It is derived from
 *  `MEMBER_WEIGHT` at MODULE EVAL, so a post-eval mutation of the weight table alone never propagates. */
function applyBeforeArm(): () => void {
  const mw = MEMBER_WEIGHT as Record<string, Record<string, number>>;
  const fw = FAMILY_LEG_WEIGHT as Record<string, Record<string, number>>;
  const mr = MEMBER_RELEVANCE as Record<string, Set<string>>;
  const savedRelevance: Set<string>[] = [];
  for (const m of EUFIN_SEATED_KEYS.member) {
    const set = mr[m];
    if (set === undefined || !set.has(EU_FIN)) {
      console.log(`ABORT: MEMBER_RELEVANCE.${m} does not carry "${EU_FIN}" — re-derive the literals.`);
      process.exit(1);
    }
    savedRelevance.push(set);
    set.delete(EU_FIN);
  }
  const saved: [Record<string, number>, number][] = [];
  for (const m of EUFIN_SEATED_KEYS.member) {
    const row = mw[m];
    if (row?.[EU_FIN] === undefined) {
      console.log(`ABORT: MEMBER_WEIGHT.${m}["${EU_FIN}"] is already absent — the frozen BEFORE literals
    no longer describe HEAD, so the arms would not be a before/after. Re-derive them.`);
      process.exit(1);
    }
    saved.push([row, row[EU_FIN]]);
    delete row[EU_FIN];
  }
  for (const f of EUFIN_SEATED_KEYS.family) {
    const row = fw[f];
    if (row?.[EU_FIN] === undefined) {
      console.log(`ABORT: FAMILY_LEG_WEIGHT.${f}["${EU_FIN}"] is already absent — re-derive the literals.`);
      process.exit(1);
    }
    saved.push([row, row[EU_FIN]]);
    delete row[EU_FIN];
  }
  return () => {
    for (const [row, v] of saved) row[EU_FIN] = v;
    for (const set of savedRelevance) set.add(EU_FIN);
  };
}

// ───────────────────────── the `gp × EU-Fin` re-seat counterfactual (`--before=gpseat`) ───────────
/** FROZEN — the PRE-Stage-A `gp` rungs on `EU-Fin`, `git show HEAD:src/danger-ladder.ts` before the
 *  2026-08-02 re-seat (the row's rank-3 seat). NEVER import them: the control would
 *  read the retuned value, the arms would collapse to A/A, and the probe would still print a populated
 *  table.
 *
 *  ⚠ THIS ARM IS A PURE MAGNITUDE SWAP, NOT A SEATING CHANGE. Both cells are PRESENT in both arms, so
 *  `MEMBER_RELEVANCE` (derived at module eval) is identical across arms and needs no revert — unlike
 *  `applyBeforeArm`, which deletes keys and therefore must revert the derived set too. Do not copy that
 *  arm's `MEMBER_RELEVANCE` handling into here: mutating the relevance set when the key set did not
 *  change would make the arms differ in a way the shipped change never did.
 *
 *  ⚠ THESE ARE STAGE A's PRE-VALUES AND ARE NOW CORRECT AS-SHIPPED. The composition-derived Stage B that
 *  would have obsoleted them was measured and ABANDONED [USER] 2026-08-03 — the row stays hand-set at
 *  Stage A's shipped values, so "before" still means the pair below. The successor arc
 *  gates the `gp` TERM rather than retuning these cells — do not
 *  reuse this arm for it, or it would measure two changes at once. Re-pin here only if the cells themselves are ever retuned: the arm's presence guard
 *  below catches the cell disappearing entirely, but CANNOT catch a retune of the same cell, so this
 *  comment is the whole guard for that half. */
const GP_SEAT_BEFORE: Readonly<Record<string, number>> = { OVX: 0.7, G1: 0.5 };

/** The LIVE pair, snapshotted at MODULE EVAL — before any arm mutates `MEMBER_WEIGHT` — so the `gpseat`
 *  footer can narrate `before → after` from the two constants instead of a hand-typed literal string.
 *  ⛔ NEVER re-type these values into prose or a print: this constant is the arm's only AFTER touch point,
 *  and a printed copy would narrate the superseded pair on the next `gp` retune while the diff table
 *  beside it showed the new one. */
const GP_SEAT_AFTER: Readonly<Record<string, number | undefined>> = {
  OVX: (MEMBER_WEIGHT as Record<string, Record<string, number>>).OVX?.[EU_FIN],
  G1: (MEMBER_WEIGHT as Record<string, Record<string, number>>).G1?.[EU_FIN],
};

/** Applies the pre-re-seat `gp × EU-Fin` magnitudes and returns the undo. */
function applyGpSeatBeforeArm(): () => void {
  const mw = MEMBER_WEIGHT as Record<string, Record<string, number>>;
  const saved: [Record<string, number>, number][] = [];
  for (const [m, before] of Object.entries(GP_SEAT_BEFORE)) {
    const row = mw[m];
    if (row?.[EU_FIN] === undefined) {
      console.log(`ABORT: MEMBER_WEIGHT.${m}["${EU_FIN}"] is absent at HEAD — the frozen BEFORE literals
    no longer describe a re-seat of that cell, so the arms would not be a before/after. Re-derive them.`);
      process.exit(1);
    }
    saved.push([row, row[EU_FIN]]);
    row[EU_FIN] = before;
  }
  return () => {
    for (const [row, v] of saved) row[EU_FIN] = v;
  };
}

// ───────────────────────── the `Value` column retune counterfactual (`--before=value`) ───────────
const VALUE_LEG = "Value";

/** FROZEN — the WHOLE `Value` column of both weight tables as it stood at the Value retune's parent,
 *  read off `src/danger-ladder.ts` at that commit. NEVER IMPORT: a control that read `MEMBER_WEIGHT.R2.Value`
 *  would read the RETUNED 0.6, the arms would collapse to A/A, and the probe would still print a
 *  populated table.
 *
 *  ⚠ THE WHOLE COLUMN IS FROZEN, NOT ONLY THE EIGHT CELLS THE RETUNE MOVED — that is what makes the
 *  ADDITIVE drift guard below possible: with every `Value`
 *  cell enumerated, a cell seated on `Value` by some LATER arc shows up as an unknown key and aborts,
 *  instead of silently standing in both arms and turning this into a before/after of something else.
 *  (The `eufin` arm cannot do that — 19 members already reach `EU-Fin`; the `Value` column is small
 *  enough to freeze whole.)
 *
 *  ⚠ RE-PIN DUTY. Every constant below is a cell of `MEMBER_WEIGHT[*].Value` /
 *  `FAMILY_LEG_WEIGHT[*].Value` (`src/danger-ladder.ts`). A FUTURE RETUNE OF ANY ONE OF THEM RE-BASES
 *  THIS ARM and must re-pin it here in the same commit — the arm's guards catch a cell that VANISHES or
 *  a cell that APPEARS, but they cannot catch a cell that is merely re-valued: this docblock is the
 *  whole guard for that half. The same duty binds `VALUE_MEMBER_SEATED_BY_RETUNE`. */
const VALUE_FAMILY_BEFORE: Readonly<Record<string, number>> = {
  cr: 1.0,
  rt: 0.4,
  vl: 0.5,
  xa: 0.5,
  uT: 1.0,
};
/** FROZEN — see `VALUE_FAMILY_BEFORE` for the provenance, the exhaustiveness rationale and the re-pin
 *  duty. Every `MEMBER_WEIGHT` row carrying a `Value` cell at the retune's parent, and no other. */
const VALUE_MEMBER_BEFORE: Readonly<Record<string, number>> = {
  R1: 0.6,
  R2: 0.4,
  R3: 0.4,
  R4: 0.4,
  R7: 0.6,
  EURC: 0.6,
  BUND: 0.6,
  F1: 0.4,
  F2: 0.4,
  EBP: 0.4,
  F3: 0.4,
  F13: 1.0,
  R6: 0.4,
  FXH: 0.4,
  CG: 0.4,
  DISP: 0.6,
  F9: 0.4,
  F10: 0.4,
  F11: 0.6,
  GT: 0.4,
  GB: 0.4,
  G1: 0.15,
  OVX: 0.2,
};
/** The three `uT` members the Value retune's §4.2 SEATED on `Value` (they had no `Value` cell before it).
 *  ⚠ THE ARM DELETES THESE CELLS, IT DOES NOT ZERO THEM — the pre-retune KEY SET. This pins the KEY SET, not a magnitude, so a
 *  later legitimate retune of e.g. `MEMBER_WEIGHT.F8.Value` does not re-base this half. */
const VALUE_MEMBER_SEATED_BY_RETUNE = ["F4", "F6", "F8"] as const;

/** Applies the pre-retune `Value` column and returns the undo.
 *
 *  ⚠ `MEMBER_RELEVANCE` IS RE-DERIVED FOR EVERY TOUCHED MEMBER, from the rule (`weight > 0`), not
 *  imported and not hand-typed. It is computed from `MEMBER_WEIGHT` at MODULE EVAL, so an in-process
 *  weight override never reaches it — and `isRelevant` reads RELEVANCE, not the weight
 *  table, so skipping this would leave the three de-seated cells still classified `sensitive` with no
 *  weight behind them. Doing it generically (rather than "delete Value from F4/F6/F8") keeps it correct
 *  if a frozen magnitude is ever re-pinned to 0. `FAMILY_LEG_WEIGHT` has no module-eval derivation —
 *  file-wide grep 2026-08-05: the only tables built from either weight table are `MEMBER_RELEVANCE` and
 *  `MEMBER_LABEL`, and `MEMBER_LABEL` keys off member IDS (no row is added or removed here), so it is
 *  identical across arms by construction. */
function applyValueBeforeArm(): () => void {
  const mw = MEMBER_WEIGHT as Record<string, Record<string, number>>;
  const fw = FAMILY_LEG_WEIGHT as Record<string, Record<string, number>>;
  const mr = MEMBER_RELEVANCE as Record<string, Set<string>>;

  // ⛔ ADDITIVE-DRIFT GUARD. A `Value` cell that exists at HEAD but in neither frozen set is an arc that
  // shipped after this arm was pinned: the arm would leave it standing in BOTH arms, the collapse
  // detector would still pass, and the table would still print — but it would no longer be a
  // before/after of the Value retune. This is the guard the `eufin` arm documents as impossible for itself.
  const unknownM = Object.keys(mw).filter(
    (m) =>
      mw[m]?.[VALUE_LEG] !== undefined &&
      VALUE_MEMBER_BEFORE[m] === undefined &&
      !(VALUE_MEMBER_SEATED_BY_RETUNE as readonly string[]).includes(m),
  );
  const unknownF = Object.keys(fw).filter(
    (f) => fw[f]?.[VALUE_LEG] !== undefined && VALUE_FAMILY_BEFORE[f] === undefined,
  );
  if (unknownM.length > 0 || unknownF.length > 0) {
    console.log(
      `ABORT: HEAD carries "${VALUE_LEG}" cells this arm does not know about ` +
        `(MEMBER_WEIGHT: ${unknownM.join(", ") || "none"}; FAMILY_LEG_WEIGHT: ${unknownF.join(", ") || "none"}).\n` +
        "    The frozen column is exhaustive by design, so an unknown cell means a later arc seated one and\n" +
        "    the arm would leave it standing in BOTH arms — no longer a before/after of the Value retune. Re-pin.",
    );
    process.exit(1);
  }

  const savedWeights: [Record<string, number>, number | undefined][] = [];
  const savedRelevance: [Set<string>, boolean][] = [];
  const touchMember = (m: string, before: number | undefined) => {
    const row = mw[m];
    if (row === undefined) {
      console.log(
        `ABORT: MEMBER_WEIGHT.${m} has no row at HEAD — the frozen "${VALUE_LEG}" column no longer\n` +
          "    describes HEAD, so the arms would not be a before/after. Re-derive the literals.",
      );
      process.exit(1);
    }
    if (row[VALUE_LEG] === undefined) {
      console.log(
        `ABORT: MEMBER_WEIGHT.${m}["${VALUE_LEG}"] is already absent at HEAD — the frozen BEFORE column\n` +
          "    no longer describes HEAD (a later arc de-seated it). Re-derive the literals.",
      );
      process.exit(1);
    }
    savedWeights.push([row, row[VALUE_LEG]]);
    if (before === undefined) delete row[VALUE_LEG];
    else row[VALUE_LEG] = before;
    const set = mr[m];
    if (set !== undefined) {
      const had = set.has(VALUE_LEG);
      savedRelevance.push([set, had]);
      // Re-derive from the rule the shipped table uses: relevant iff weight > 0.
      if ((row[VALUE_LEG] ?? 0) > 0) set.add(VALUE_LEG);
      else set.delete(VALUE_LEG);
    }
  };

  for (const [m, before] of Object.entries(VALUE_MEMBER_BEFORE)) touchMember(m, before);
  for (const m of VALUE_MEMBER_SEATED_BY_RETUNE) touchMember(m, undefined);
  for (const [f, before] of Object.entries(VALUE_FAMILY_BEFORE)) {
    const row = fw[f];
    if (row?.[VALUE_LEG] === undefined) {
      console.log(
        `ABORT: FAMILY_LEG_WEIGHT.${f}["${VALUE_LEG}"] is absent at HEAD — the frozen BEFORE column no\n` +
          "    longer describes HEAD. Re-derive the literals.",
      );
      process.exit(1);
    }
    savedWeights.push([row, row[VALUE_LEG]]);
    row[VALUE_LEG] = before;
  }

  return () => {
    for (const [row, v] of savedWeights) {
      if (v === undefined) delete row[VALUE_LEG];
      else row[VALUE_LEG] = v;
    }
    for (const [set, had] of savedRelevance) {
      if (had) set.add(VALUE_LEG);
      else set.delete(VALUE_LEG);
    }
  };
}

// ─────────── the defensive-column cr<->rt swap counterfactual (`--before=defleg`) ───────────
/** THE FOUR CELLS THE cr<->rt SWAP COMMIT MOVED, frozen at its parent's `src/danger-ladder.ts`.
 *
 *  ⚠ MAGNITUDES, NOT A KEY SET — unlike `EUFIN_SEATED_KEYS`/`R6_SEATED_BY_ROW_FILL`, this arc seated
 *  and de-seated nothing, so the before-state genuinely IS a set of past numbers and there is no
 *  stronger key-set form available. That is what creates the re-pin duty documented above.
 *
 *  NEVER IMPORT THESE FROM `danger-ladder.ts` — reading the table under test collapses the arms to A/A
 *  while still printing a fully populated table. */
const DEFLEG_FAMILY_BEFORE: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  cr: { Health: 0.9, Staples: 0.9 },
  rt: { Health: 1.0 },
};
const DEFLEG_MEMBER_BEFORE: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  F3: { Staples: 0.4 },
};

/** Applies the pre-swap defensive-column state and returns the undo.
 *
 *  `MEMBER_RELEVANCE` is re-derived from the shipped rule (`weight > 0`) for the touched member cell,
 *  for the reason every table-override arm here must: the table is built at MODULE EVAL from
 *  `MEMBER_WEIGHT`, and `isRelevant` reads RELEVANCE rather than the weight row. Here it
 *  is a no-op by arithmetic (0.4 and 0.5 are both > 0) — done generically so it stays correct if a
 *  frozen magnitude is ever re-pinned to 0. `FAMILY_LEG_WEIGHT` has no module-eval derivation. */
function applyDeflegBeforeArm(): () => void {
  const mw = MEMBER_WEIGHT as Record<string, Record<string, number>>;
  const fw = FAMILY_LEG_WEIGHT as Record<string, Record<string, number>>;
  const mr = MEMBER_RELEVANCE as Record<string, Set<string>>;

  const savedWeights: [Record<string, number>, string, number][] = [];
  const savedRelevance: [Set<string>, string, boolean][] = [];

  for (const [f, cells] of Object.entries(DEFLEG_FAMILY_BEFORE)) {
    for (const [leg, before] of Object.entries(cells)) {
      const row = fw[f];
      if (row?.[leg] === undefined) {
        console.log(
          `ABORT: FAMILY_LEG_WEIGHT.${f}["${leg}"] is absent at HEAD — the frozen BEFORE column no\n` +
            "    longer describes HEAD, so the arms would not be a before/after of the cr<->rt swap. Re-derive.",
        );
        process.exit(1);
      }
      savedWeights.push([row, leg, row[leg]]);
      row[leg] = before;
    }
  }
  for (const [m, cells] of Object.entries(DEFLEG_MEMBER_BEFORE)) {
    for (const [leg, before] of Object.entries(cells)) {
      const row = mw[m];
      if (row?.[leg] === undefined) {
        console.log(
          `ABORT: MEMBER_WEIGHT.${m}["${leg}"] is absent at HEAD — the frozen BEFORE column no longer\n` +
            "    describes HEAD, so the arms would not be a before/after of the cr<->rt swap. Re-derive.",
        );
        process.exit(1);
      }
      savedWeights.push([row, leg, row[leg]]);
      row[leg] = before;
      const set = mr[m];
      if (set !== undefined) {
        savedRelevance.push([set, leg, set.has(leg)]);
        if (before > 0) set.add(leg);
        else set.delete(leg);
      }
    }
  }

  return () => {
    for (const [row, leg, v] of savedWeights) row[leg] = v;
    for (const [set, leg, had] of savedRelevance) {
      if (had) set.add(leg);
      else set.delete(leg);
    }
  };
}

// ───────────────────────── the `MEMBER_WEIGHT.R6` row-fill counterfactual (`--before=r6`) ─────────
/** THE KEY SET THE ROW-FILL ADDED TO `MEMBER_WEIGHT.R6` — the 2026-07-31 §3.6 ruling that filled the row
 *  from 4 cells to 9 (the pre-edit row is
 *  `{ Semis: 0.8, "S&P IT": 0.8, "High-Div": 0.8, Staples: 0.6 }`). The `rt`-block
 *  comment in `danger-ladder.ts` records the 9-leg before/after ordering table as still OWED for it.
 *
 *  ⚠ THIS PINS THE KEY SET, NOT MAGNITUDES — deliberately, and it is the stronger form (same reasoning
 *  as `EUFIN_SEATED_KEYS`). The row-fill was PURELY ADDITIVE on this row: it moved no existing cell, so
 *  the true before-state of those five legs is ABSENCE and the arm reconstructs it by DELETING them.
 *  Nothing here compares against a frozen magnitude, so a later legitimate retune of e.g.
 *  `MEMBER_WEIGHT.R6.Value` does not re-base the counterfactual.
 *
 *  ⛔ DO NOT "COMPLETE" THIS BY RESTORING THE PRE-EDIT ROW WHOLESALE. The surviving four cells are NOT
 *  frozen here on purpose: `High-Div` was renamed `EU-Fin` (a later commit) and its R6 magnitude was then
 *  cut 0.8 → 0.4 by an unrelated later edit (EU-Fin Stage 4.1). Reinstating the literal row
 *  would fold that cut into this before/after and the result would no longer attribute to the row-fill.
 *  Those four cells are identical in both arms, which is exactly what isolates the row-fill.
 *
 *  ⚠ RE-PIN DUTY: this arm is re-based by any edit that changes WHICH legs `R6` reaches — a de-seating
 *  of one of the five below (the guard catches that one and aborts) or a NEW leg seated on `R6` after
 *  2026-08-05 (the guard CANNOT see that: an extra cell would stand in both arms). Re-pin here in the
 *  same commit as any `R6` roster change. Magnitude retunes of `R6` do not re-base it. */
const R6_SEATED_BY_ROW_FILL = ["EM", "Value", "S&P 500", "ex-US", "Health"] as const;

/** Applies the pre-row-fill `MEMBER_WEIGHT.R6` row and returns the undo. `MEMBER_RELEVANCE.R6` is
 *  re-derived (`weight > 0`) for the reason every table-override arm here must handle relevance: the
 *  table is built at MODULE EVAL, and `isRelevant` reads RELEVANCE, not the weight row —
 *  skipping it would leave five `rt × leg` cells classified `sensitive` with no weight behind them.
 *  (`applyBrentBeforeArm` no longer re-derives — since its 2026-08-06 re-inversion it SAVES AND RESTORES
 *  the live entry instead, which is the deletion shape's equivalent of the same duty.) */
function applyR6BeforeArm(): () => void {
  const mw = MEMBER_WEIGHT as Record<string, Record<string, number>>;
  const mr = MEMBER_RELEVANCE as Record<string, Set<string>>;
  const row = mw.R6;
  const rel = mr.R6;
  if (row === undefined || rel === undefined) {
    console.log(
      "ABORT: MEMBER_WEIGHT.R6 / MEMBER_RELEVANCE.R6 is absent at HEAD — the row this arm un-fills does\n" +
        "    not exist, so the arms would not be a before/after. Re-derive the literals.",
    );
    process.exit(1);
  }
  const saved: [string, number][] = [];
  const savedRel: string[] = [];
  for (const leg of R6_SEATED_BY_ROW_FILL) {
    if (row[leg] === undefined) {
      console.log(
        `ABORT: MEMBER_WEIGHT.R6["${leg}"] is already absent at HEAD — the row-fill seated it, so the frozen\n` +
          "    key set no longer describes HEAD and the arm would measure a partial revert. Re-derive it.",
      );
      process.exit(1);
    }
    saved.push([leg, row[leg]]);
    delete row[leg];
    if (rel.has(leg)) {
      savedRel.push(leg);
      rel.delete(leg);
    }
  }
  return () => {
    for (const [leg, v] of saved) row[leg] = v;
    for (const leg of savedRel) rel.add(leg);
  };
}

// ───────────── the `MEMBER_WEIGHT.F5` demotion counterfactual (`--before=f5`) ─────────────
/** THE PRE-DEMOTION `MEMBER_WEIGHT.F5` ROW, frozen 2026-08-30. The demotion followed the F5
 *  forward-return event study (PLACEBO-FAIL on a POWERED sample), and the ceremony printed by the weight-table pin in
 *  `scripts/capture-core9-baseline.test.ts` owes a 9-leg before/after ordering table for it. This arm
 *  is that table's BEFORE.
 *
 *  ⚠ UNLIKE `--before=r6` THIS IS A MAGNITUDE ARM, NOT A KEY-SET ARM. The demotion was a pure retune:
 *  the same three legs before and after, so `MEMBER_RELEVANCE.F5` is UNCHANGED (every cell stays
 *  `> 0`) and this arm must NOT re-derive it — doing so would be a no-op that reads like a duty
 *  discharged. The r6 docblock's relevance duty applies to seat/de-seat arms only.
 *
 *  ⛔ RE-PIN DUTY, AND IT IS THE STRICT KIND: because this freezes MAGNITUDES, ANY later retune of an
 *  `F5` cell re-bases the counterfactual. The guard below aborts when HEAD no longer carries the
 *  post-demotion row, so a silent re-base is impossible — but the fix is to re-derive BOTH literals
 *  here in the same commit as the retune, never to loosen the guard. */
const F5_ROW_BEFORE_DEMOTION: Record<string, number> = { Semis: 1.0, "S&P IT": 0.8, "S&P 500": 0.4 };
/** The post-demotion row this arm expects to find at HEAD — the guard's oracle, not a second source of
 *  truth: `applyF5BeforeArm` reads the LIVE row and only compares against this. */
const F5_ROW_AT_DEMOTION: Record<string, number> = { Semis: 0.6, "S&P IT": 0.4, "S&P 500": 0.4 };

/** Applies the pre-demotion `MEMBER_WEIGHT.F5` row and returns the undo. */
function applyF5BeforeArm(): () => void {
  const mw = MEMBER_WEIGHT as Record<string, Record<string, number>>;
  const row = mw.F5;
  if (row === undefined) {
    console.log(
      "ABORT: MEMBER_WEIGHT.F5 is absent at HEAD — this arm retunes a row that no longer exists, so the\n" +
        "    arms would not be a before/after. Re-derive the literals (or drop the arm with the row).",
    );
    process.exit(1);
  }
  const headKeys = Object.keys(row).sort().join(",");
  const wantKeys = Object.keys(F5_ROW_AT_DEMOTION).sort().join(",");
  if (headKeys !== wantKeys) {
    console.log(
      `ABORT: MEMBER_WEIGHT.F5's leg set at HEAD is {${headKeys}}, not the {${wantKeys}} this arm was\n` +
        "    frozen against — a seat/de-seat happened, which re-bases the counterfactual. Re-derive it.",
    );
    process.exit(1);
  }
  for (const [leg, want] of Object.entries(F5_ROW_AT_DEMOTION)) {
    if (row[leg] !== want) {
      console.log(
        `ABORT: MEMBER_WEIGHT.F5["${leg}"] is ${row[leg]} at HEAD, not the ${want} this arm froze on\n` +
          "    2026-08-30 — an F5 retune landed without re-pinning, so the BEFORE/AFTER no longer\n" +
          "    attributes to the demotion. Re-derive BOTH literals above in the retune's commit.",
      );
      process.exit(1);
    }
  }
  const saved: [string, number][] = Object.entries(row).map(([leg, v]) => [leg, v]);
  for (const [leg, v] of Object.entries(F5_ROW_BEFORE_DEMOTION)) row[leg] = v;
  return () => {
    for (const [leg, v] of saved) row[leg] = v;
  };
}

// ───────────── the EU-Fin overlap weight retune counterfactual (`--before=eufinw`) ─────────────
/** FROZEN HISTORY — `MEMBER_WEIGHT[id]["EU-Fin"]` at the retune's parent commit, never the live
 *  values: `src/danger-ladder.ts` at that commit. */
const EUFIN_CELLS_PRE_RETUNE: Record<string, number> = { BUND: 0.6, R5: 0.6, GT: 0.6, GB: 0.6 };
/** Members with NO `EU-Fin` cell at the retune's parent commit — the arm deletes the cell and its relevance entry. */
const EUFIN_ABSENT_PRE_RETUNE = ["AT1"] as const;

/** Applies the pre-retune `EU-Fin` cells and returns the undo. ABORTS when a HEAD cell already equals
 *  its frozen value or an unseated one is already absent — the arms would be A/A on that cell. */
function applyEufinWeightsBeforeArm(): () => void {
  const mw = MEMBER_WEIGHT as Record<string, Record<string, number>>;
  const mr = MEMBER_RELEVANCE as Record<string, Set<string>>;
  const saved: [Record<string, number>, number][] = [];
  const savedRel: Set<string>[] = [];
  for (const [m, before] of Object.entries(EUFIN_CELLS_PRE_RETUNE)) {
    const row = mw[m];
    const head = row?.[EU_FIN];
    if (row === undefined || head === undefined || head === before) {
      console.log(
        `ABORT (A/A): MEMBER_WEIGHT.${m}["${EU_FIN}"] is ${head ?? "absent"} at HEAD, frozen before-value ${before}\n` +
          "    (the retune's parent commit) — the retune is missing on this cell, so the arms would not be a before/after.",
      );
      process.exit(1);
    }
    saved.push([row, head]);
    row[EU_FIN] = before;
  }
  for (const m of EUFIN_ABSENT_PRE_RETUNE) {
    const row = mw[m];
    const head = row?.[EU_FIN];
    const rel = mr[m];
    if (row === undefined || head === undefined || rel === undefined || !rel.has(EU_FIN)) {
      console.log(
        `ABORT (A/A): MEMBER_WEIGHT.${m}["${EU_FIN}"] / MEMBER_RELEVANCE.${m} is already unseated at HEAD —\n` +
          "    the S2 seat is missing, so the arms would not be a before/after of the EU-Fin overlap retune.",
      );
      process.exit(1);
    }
    saved.push([row, head]);
    delete row[EU_FIN];
    savedRel.push(rel);
    rel.delete(EU_FIN);
  }
  return () => {
    for (const [row, v] of saved) row[EU_FIN] = v;
    for (const rel of savedRel) rel.add(EU_FIN);
  };
}

// ───────────────────────── the EXOGENOUS counterfactual (`--before=brent`) ─────────────────────────
/** FROZEN — `severityOf ∘ SEV_NUM` (`danger-member-state.ts`; `severityOf` is module-private there). */
const STATE_SEV: Record<State, number> = { RED: 1, AMBER: 0.5, GREEN: 0 };

/** FROZEN FOR PROVENANCE ONLY — `MEMBER_WEIGHT.BRENT`
 *  as it stood in `src/danger-ladder.ts` at the last commit before §7.1 deleted it (2026-08-02).
 *  ⚠ THE ARM NO LONGER USES IT. Between 2026-08-02 and 2026-08-06 it WAS the arm's whole BEFORE state
 *  (the row had to be re-added because HEAD had none); the 2026-08-06 re-seat put a row back into
 *  `danger-ladder.ts` at ×1.0, so the arm reverted to its original DELETION shape and reads the LIVE row.
 *  Kept because the banked 293/293 A/A result was measured against THIS literal, not the live ×1.0 row —
 *  a reader reproducing that specific number needs the weights it was measured with. NEVER re-derive it
 *  from a live symbol. Exported only so `noUnusedLocals` keeps this provenance literal. */
export const BRENT_ROW_PRE_DROP: Readonly<Record<string, number>> = {
  EM: 0.5,
  "ex-US": 0.4,
  "EU-Fin": 0.35,
  "S&P 500": 0.25,
  Semis: 0.2,
  "S&P IT": 0.2,
  Health: 0.15,
  Staples: 0.15,
  Value: 0.1,
};

/** The §0.65-finding-2 INCREMENTAL arm: `MEMBER_WEIGHT.BRENT` alone, nothing else — no overlay, no
 *  suppression. `G1`/`OVX` stay seated in BOTH arms, so the fourth term still fires on them and the
 *  measurement is "what does BRENT's row add on top of the shipped EXOGENOUS engine".
 *
 *  ⚠ **RE-INVERTED 2026-08-06, BACK TO ITS ORIGINAL DELETION SHAPE.** History in two hops: until §7.1
 *  (2026-08-02) the arm DELETED the row from HEAD; §7.2 inverted it to RE-ADD a frozen literal once HEAD
 *  had no row; the 2026-08-06 [USER] re-seat put a row back (`MEMBER_WEIGHT.BRENT`, the shape ×1.0), so
 *  the arm deletes again — BEFORE = HEAD minus BRENT's row, AFTER = HEAD (with BRENT). The measured
 *  CONTRAST is the same one throughout — with the row vs without it. ⚠ But the ROW is not: the banked
 *  293/293 A/A was measured with the pre-drop ×0.5 literal above, and HEAD now carries ×1.0. A re-run
 *  therefore re-measures the claim rather than reproducing the same arithmetic. ⛔ AND A/A IS NO LONGER THE
 *  PREDICTION — do not quote the banked result as one. A weight TIE is NOT domination: `observedWeightedMax`
 *  maxes `weight × SEVERITY`, and BRENT/OVX are different scorers on different feeds, so `BRENT RED ·
 *  OVX GREEN` is an ORDINARY close on which BRENT is the strict argmax (measured on HEAD: `EM` 0 → 0.38,
 *  all nine legs re-order). The 2026-08-02 emptiness of {BRENT non-GREEN ∧ OVX GREEN} was measured on the
 *  OLD BRENT scorer, replaced the same week,
 *  so it does not transfer. This arm is exactly what would measure the re-seat; the replay was WAIVED
 *  [USER] 2026-08-06 and the effect is UNMEASURED.
 *
 *  ⚠ `MEMBER_RELEVANCE` IS SAVED AND RESTORED HERE, not re-derived and not hand-typed — the deletion shape's
 *  form of the same duty. The table is computed from `MEMBER_WEIGHT` at MODULE EVAL (`danger-ladder.ts`), so
 *  an in-process weight override never reaches it, and `isRelevant` reads RELEVANCE, not the
 *  weight table: touching one without the other leaves the arm measuring nothing. (While the arm RE-ADDED a
 *  frozen row, 2026-08-02 → 2026-08-06, it re-derived relevance the way the `eufin` and `R6` arms still do —
 *  a leg is relevant iff its weight > 0. A deletion has the live entry in hand, so it saves it instead.)
 *
 *  ⚠ THE GUARD IS INVERTED WITH THE ARM. It must fire when the row is ABSENT: a rowless HEAD means
 *  deleting the row is a no-op and both arms are the SAME engine — A/A by construction, a populated
 *  table measuring nothing. */
function applyBrentBeforeArm(): () => void {
  const mw = MEMBER_WEIGHT as Record<string, Record<string, number>>;
  const mr = MEMBER_RELEVANCE as Record<string, Set<string>>;
  // A member seated in exactly one of the two tables is a broken derivation, so BOTH halves gate the arm.
  if (mw.BRENT === undefined || mr.BRENT === undefined) {
    console.log(
      "ABORT: MEMBER_WEIGHT.BRENT is ABSENT at HEAD — this arm DELETES the row to build its AFTER state\n" +
        "    (re-inverted 2026-08-06 when the row was re-seated), so a rowless HEAD makes both arms the\n" +
        "    same engine and the walk would report A/A by construction. Either the row was dropped again\n" +
        "    — see its 📜 HISTORY note in `danger-ladder.ts` — or this arm needs inverting back to a\n" +
        "    re-add of BRENT_ROW_PRE_DROP.",
    );
    process.exit(1);
  }
  const savedWeight = mw.BRENT;
  const savedRelevance = mr.BRENT;
  delete mw.BRENT;
  delete mr.BRENT;
  return () => {
    mw.BRENT = savedWeight;
    if (savedRelevance !== undefined) mr.BRENT = savedRelevance;
  };
}

let store;
try {
  store = await resolveStore(envArg, "ro", liveResolveDeps);
} catch (e: unknown) {
  console.log(`ABORT: no ${envArg} store reachable — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

// ---------- data pull (READ-ONLY: getSeries selects only) ----------
// `loadSeriesWith` carries the fail-loud ABORT this block used to spell out: a member that silently
// resolves to [] is ABSENT at every date, which drops it from the wsev max and MOVES the very
// ordering under measurement.
const memberIds = [...new Set(DIAL_FAMILIES.flatMap((f) => f.ids))];
const seriesById = await loadSeriesWith((id) => store.getSeries(id, FETCH_LIMIT), memberIds);

const axis = unionCalendar(seriesById, memberIds);
if (axis.length === 0) {
  console.log("ABORT: the store returned zero closes for every dial member — nothing to replay.");
  process.exit(1);
}
const asOf = asOfArg ?? axis[axis.length - 1]!;
if (asOf < axis[0]!) {
  console.log(`ABORT: --asOf=${asOf} precedes the store's first close ${axis[0]}.`);
  process.exit(1);
}

// SEAM (Stage 3.B-2): `walkReplay`'s fold does NOT apply here — under `--asOf` this probe evaluates ONE
// anchor, and under `--walk` it keeps its own ascending loop so both arms fold side by side per close.
// Only the panel assembly is shared. At each close the panel is built ONCE and both arms read it,
// deliberately: `panelAt` returns data and holds no state, so that sharing is preserved.
const PANEL_OPTS = { historyLen: MEMBER_WINDOW + MEMBER_HISTORY_PAD };
// ⚠ The walk's cursor is shared across closes (ascending only — `PanelOptions.cursor`'s invariant), and
// is NEVER handed to the single-anchor path, which must keep its fresh full scan.
const walkCursor = walkArg === undefined ? undefined : makeCursor(seriesById);
const walkDates = walkArg === undefined ? [] : axis.filter((d) => d >= walkFrom! && d <= walkTo!);
if (walkArg !== undefined && walkDates.length === 0) {
  console.log(`ABORT: --walk=${walkArg} selects zero closes on the union axis (${axis[0]} .. ${axis[axis.length - 1]}).`);
  process.exit(1);
}
const singlePanel = walkArg === undefined ? panelAt(seriesById, memberIds, asOf, PANEL_OPTS) : undefined;
if (singlePanel !== undefined && singlePanel.readings.length === 0) {
  console.log(`ABORT: no dial member is observed at ${asOf} under the forward-fill horizon.`);
  process.exit(1);
}

interface Row {
  rank: number;
  rung: number;
  sleeve: string;
  danger: number;
  /** The Danger-ledger band — `danger` at `DANGER_CUTS` (`ledgerBand`). */
  ledgerBand: State;
  ew: number | null;
  sn: number | null;
  inBand: boolean;
}
interface ArmResult {
  rows: Row[];
  band: { lo: number; hi: number };
  targetRung: number;
  held: string | null;
  exogenous: { floor: number; active: boolean };
}
interface ArmOptions {
  /** The `hold` arm (Stage 2.2): run this arm with the Stage-2.1 signal hold OFF. It flows to BOTH
   *  clock-bearing seams of the arm — `computeFieldProbe`'s `probe.probeHoldOff` (the member states) and the tech
   *  confirmer's held map (the dial chip) — because a control arm that unheld one and not the other
   *  would be a half-pipeline and its `band`/`inBand` columns would not be a before-state at all. */
  probeHoldOff?: boolean;
  /** The `holdrelease` arm (hold-release Stage 4): run this arm with the hold ON but its RELEASE-on-
   *  observed-recovery branch skipped — the pre-arm-C (CUR) fold. Like `probeHoldOff` it flows to BOTH
   *  clock-bearing seams (`computeFieldProbe`'s `probe.probeHoldNoRelease` and the dial chip's held map) for the same
   *  half-pipeline reason. ⚠ IT MUST NOT SET `probeHoldOff`: the two are different counterfactuals
   *  (C-vs-CUR here, C-vs-UNHELD there) and are never both set on one arm. */
  probeHoldNoRelease?: boolean;
  /** The `s61` arm (Stage 6.1): build the dial chip's held map through the PRE-6.1 seam
   *  (`buildMemberStateHeldAt(cissHistory, 0)` = the window-only raw-held map) instead of the shipped
   *  `buildMemberStateHeld` = merge(LIVE panel, raw-held). ⚠ IT TOUCHES `probeHoldOff` NOT AT ALL — the hold
   *  stays exactly as shipped, so Δ here is 6.1's live-panel RAISE alone. It mutates no constant and freezes no literal, hence carries NO re-pin duty. */
  preS61Seam?: boolean;
  /** `--held` walk only: the prior close's dial target (`run-core.ts`'s `prevTarget`); default `null`. */
  prevTarget?: number | null;
}

/** One full evaluation off the SHARED panel readings. The panel rebuild lives inside the arm so that any
 *  weight dependence anywhere in the chain is captured by the arm, not frozen before it. */
function evaluateArm(
  at: Panel,
  {
    probeHoldOff = false,
    probeHoldNoRelease = false,
    preS61Seam = false,
    prevTarget = null,
  }: ArmOptions = {},
): ArmResult {
  const panel = computeFamilyPanel(at.readings, DIAL_FAMILIES);
  // THE DIAL CHIP RUNS ON THE SAME CLOCK AS THE FIELD (Stage 2.2 ruling 4). `assembleDial` (the prod
  // seam this probe mirrors) feeds `techConfirmerFromPanel` the HELD member map at t since Stage 2.1;
  // the probe never routes through `assembleDial`, so before this line its `band`/`inBand` columns ran
  // on the pre-Stage-2.1 clock while its field ran held — a silent fidelity gap that would have ridden
  // into every banked table. This is `dial-assembly.ts`'s seam mirrored, NOT a second hold path.
  //
  // ⛔ RE-PINNED BY STAGE 6.1 — DO NOT
  // REVERT TO `buildMemberStateHeldAt`. Until 6.1 both this line and `assembleDial` built
  // `buildMemberStateHeldAt(cissHistory, 0)` = the window-only raw-held map. 6.1 moved the prod seam to
  // `buildMemberStateHeld({ globalFamilies }, cissHistory)` = merge(LIVE panel, raw-held), the
  // same map `computeField` builds. A probe left on the old builder cannot see the very raise 6.1
  // enables (a lead lit LIVE but not yet in the persisted member-history window enters the merged map and was dark
  // in the window-only one), so it would report 6.1 as a no-op and bank the measurement
  // through the pre-6.1 seam.
  //
  // Under the `hold` BEFORE arm it is omitted, exactly as `probeHoldOff` unhelds the field — the arm is a
  // whole-pipeline pre-Stage-2.1 control or it is not a control.
  // ⛔ AND THE COLD-STORE BRANCH IS THE ENGINE'S (Stage 6.2, ruling 10) — the THIRD site of the shape
  // ruling 10 closed. This line used to call `buildMemberStateHeld` on every non-`probeHoldOff` arm, so on a
  // depth-less arm the chip's map disagreed with the `computeField` call below, which took
  // `buildMemberState(d)`. A depth-less arm is REACHABLE here — `panelAt` yields whatever the replay window
  // holds, and `noHoldDepth` is true not only for an absent history but for one whose per-member
  // histories are all empty (an early close, a store with no rows for the walked ids). The predicate is
  // IMPORTED, never re-typed: "cold store" has one definition and it lives at `noHoldDepth`.
  //
  // ⚠ `preS61Seam` (the `--before=s61` arm) IS THE ONE SANCTIONED EXCEPTION to the ⛔ above, and it is
  // not a revert of the re-pin: the AFTER arm keeps the shipped builder and only the BEFORE arm walks
  // back to `buildMemberStateHeldAt(cissHistory, 0)`, so the re-pin duty is discharged where it is owed
  // (production's seam) while the counterfactual stays measurable. The cold-store branch stays SHARED
  // across both arms deliberately — reverting it too would fold Stage 6.2's ruling-10 fix into a Stage
  // 6.1 before/after. See the docblock's `s61` entry.
  //
  // ⚠ `probeHoldNoRelease` (the `--before=holdrelease` arm) rides the SHIPPED builder and only changes its
  // FOLD, so it needs no branch of its own here — it threads through as the builder's third argument,
  // for the same whole-pipeline reason `probeHoldOff` reaches this seam at all: the field below takes the
  // matching `probe.probeHoldNoRelease`, and an arm that unreleased one and not the other would put the
  // `band`/`inBand` columns and the field on two different folds.
  const heldMemberState = probeHoldOff
    ? undefined
    : noHoldDepth(at.cissHistory)
      ? buildMemberState({ globalFamilies: panel.families })
      : preS61Seam
        ? buildMemberStateHeldAt(at.cissHistory, 0)
        : buildMemberStateHeld({ globalFamilies: panel.families }, at.cissHistory, probeHoldNoRelease);
  // THE SEVERITY HALF OF THE A/A ALGEBRA (see `algebraVerdict`). Stashed rather than re-derived: this map
  // is what the arm actually scored against, and rebuilding it at the detector would be a second
  // transcription of the branch above. It is arm-INDEPENDENT in the only way that matters here — no
  // builder on this line reads `MEMBER_WEIGHT` (the panel comes from `computeFamilyPanel(readings, …)`),
  // so a weight arm cannot move it and last-writer-wins is not a fidelity gap. `probeHoldOff` leaves it
  // `undefined`, which `algebraVerdict` refuses rather than reading as "every member is absent".
  armHeldMemberState = heldMemberState;
  const confirmerSlots = techConfirmerFromPanel(panel.families, undefined, heldMemberState);
  const dial = computeT1Dial(panel.families, techConfirmerBreadth(confirmerSlots));
  const field = computeFieldProbe(
    { globalFamilies: panel.families },
    dial.band,
    undefined,
    prevTarget,
    at.cissHistory,
    undefined,
    undefined,
    undefined, // opts — no degrade channel on a probe arm
    // `probeDeadbandOverride` is omitted: this probe measures the hold seam, never the pick deadband.
    // Never both arms — `probeHoldOff` is the C-vs-UNHELD arm, `probeHoldNoRelease` the C-vs-CUR one,
    // and no arm sets the two together (`evaluateBeforeArm` dispatches exactly one).
    {
      ...(probeHoldOff ? { probeHoldOff: true } : probeHoldNoRelease ? { probeHoldNoRelease: true } : {}),
    },
    dial.targetRung, // the ●: `rising` compares it (not `band.hi`) to prevTarget, as `run-core.ts` does
  );
  /** Ranked CALMEST-first — the pick's own order (`held` = the calmest in-band leg). Ties break on
   *  the ladder rung, so the ordering is total and reproducible across arms. */
  const rows: Row[] = field.legRows
    .map((r) => ({
      rank: 0,
      rung: LADDER.indexOf(r.sleeve as (typeof LADDER)[number]) + 1,
      sleeve: r.sleeve,
      danger: r.danger,
      ledgerBand: ledgerBand(r.danger, DANGER_CUTS),
      ew: pillarValue(r.subDangers.earlyWarn),
      sn: pillarValue(r.subDangers.stressNow),
      inBand: r.risk >= dial.band.lo && r.risk <= dial.band.hi,
    }))
    .sort((a, b) => a.danger - b.danger || a.rung - b.rung)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  return {
    rows,
    band: dial.band,
    targetRung: dial.targetRung,
    held: field.held?.sleeve ?? null,
    exogenous: field.exogenous,
  };
}

// ───────────────────────── the A/A ALGEBRA SEAM (`scripts/lib/weight-algebra.ts`) ──────────────────
/**
 * ⚠ CAPTURED AS A SIDE EFFECT OF THE ARM RUN, NEVER RE-DERIVED AT THE DETECTOR. Every mutating arm undoes
 * itself in a `finally`, so by the time the A/A collapse detector runs `MEMBER_WEIGHT` is back at HEAD and
 * the edit list is unrecoverable from the table. These two are what the arm actually moved and what it
 * scored against.
 *
 * ⛔ NO ARM FUNCTION KNOWS THIS EXISTS, DELIBERATELY. The diff is taken around the `apply*BeforeArm()`
 * CALL, so a seventh arm is covered the day it is written, and an arm author cannot forget to declare its
 * cells (a hand-declared edit list would be a second transcription of the very literals the arms freeze —
 * the defect class this probe's aborts exist to catch).
 */
let armCellEdits: CellEdit[] = [];
let armHeldMemberState: MemberStateMap | undefined;

/** `Severity` → the numeric weight the Level-1 max multiplies. ⛔ DERIVED FROM `STATE_SEV`, NEVER
 *  RE-TYPED: `SEV_NUM` (`danger-member-state.ts`) is the live scale, and `STATE_SEV` above is this file's
 *  frozen transcription of it, so a third copy of the scale here would be a third thing to re-pin. */
const SEVERITY_NUM: Record<Severity, number> = {
  calm: STATE_SEV.GREEN,
  elev: STATE_SEV.AMBER,
  lit: STATE_SEV.RED,
};

/** The `cellKey` separator: ASCII 31, the unit separator. Spelled as a code point, never as a raw
 *  control byte in the source.
 *  ⚠ NEVER A NUL. A literal NUL byte makes GNU grep classify this whole file BINARY, so
 *  `grep -rn <anything> scripts/probe-leg-ordering.ts` returns NOTHING over the densest
 *  cite-carrying probe in the tree — every mandated stem / § / coverage sweep then reports a false
 *  all-clear, and `git grep` keeps hitting, which is what hid it (2026-08-08 review).
 *  A printable separator is out for the other reason: leg names carry spaces, `&` and `-`
 *  (`"S&P 500"`, `"ex-US"`), so one could collide with a future leg name. */
const CELL_SEP = String.fromCharCode(31);

/** `member` + `leg` as one map key. */
const cellKey = (member: string, leg: string): string => `${member}${CELL_SEP}${leg}`;

/** A flat `member×leg → weight` snapshot of `MEMBER_WEIGHT`. Absence of a key IS the absent cell — the
 *  distinction the predicate needs to refuse a seating change. */
function snapshotWeights(): Map<string, number> {
  const out = new Map<string, number>();
  for (const [m, row] of Object.entries(MEMBER_WEIGHT as Record<string, Record<string, number>>)) {
    for (const [leg, w] of Object.entries(row)) out.set(cellKey(m, leg), w);
  }
  return out;
}

/** The cells that differ between the two snapshots, as the predicate's `CellEdit[]`. */
function diffWeights(before: Map<string, number>, after: Map<string, number>): CellEdit[] {
  const edits: CellEdit[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(key);
    const a = after.get(key);
    if (b === a) continue;
    const [member, leg] = key.split(CELL_SEP) as [string, string];
    edits.push({ member, leg, before: b, after: a });
  }
  return edits;
}

/** Asks `weightEditVerdict` whether the arms' A/A is provable arithmetic rather than a dead control.
 *
 *  ⚠ THE SIBLING WEIGHTS ARE READ AT THEIR WEAKEST ARM, NOT AT HEAD. A multi-cell arm (`value`, `r6`,
 *  `gpseat`) can edit the very sibling that dominates another edited cell, and the live table is back at
 *  HEAD when this runs — so quoting HEAD would let the AFTER arm's dominator certify a cell the BEFORE
 *  arm's weaker one does not cap. An edited sibling therefore contributes `min(before, after)`, and one
 *  ABSENT in either arm contributes nothing at all. That is an INPUT choice, not a loosening of the
 *  predicate: it can only ever refuse where HEAD would have certified. */
function algebraVerdict(): AlgebraVerdict {
  const held = armHeldMemberState;
  if (held === undefined) {
    return { kind: "undetermined", reason: "no held member state was captured (an unheld arm)" };
  }
  const edited = new Map(armCellEdits.map((e) => [cellKey(e.member, e.leg), e]));
  const mw = MEMBER_WEIGHT as Record<string, Record<string, number>>;
  return weightEditVerdict({
    edits: armCellEdits,
    familyMembers: FAMILY_MEMBERS,
    // The SECOND seam — read from production, never re-typed here. `ArmResult` carries `band`,
    // `targetRung`, `held` and per-row `inBand`, all downstream of `memberScaledBand`, so a verdict that
    // reasoned about `wsev` alone would `exit 0` on a comparison it never covered.
    dial: {
      legs: TECH_LEGS,
      members: TECH_CONFIRMER_MEMBERS,
      band: (scaled) => scaledSevBand(scaled as Sev),
      sevLevels: Object.values(STATE_SEV),
    },
    weight: (member, leg) => {
      const e = edited.get(cellKey(member, leg));
      if (e === undefined) return mw[member]?.[leg];
      return e.before === undefined || e.after === undefined ? undefined : Math.min(e.before, e.after);
    },
    severity: (member) => {
      const sev = held[member]?.sev;
      return sev === undefined ? undefined : SEVERITY_NUM[sev];
    },
  });
}

/** Dispatches on `--before`. Each arm mutates its table(s), evaluates, and undoes in a `finally`, so no
 *  arm can leak into the next close of a walk. */
function evaluateBeforeArm(at: Panel): ArmResult {
  // ⚠ RESET FIRST, AND EVERY CALL — under `--walk` this function runs once per close, and a stale edit
  // list from the previous close would be read as this one's.
  armCellEdits = [];
  // ⚠ THE `hold` ARM MUTATES NOTHING — no table to apply, no `finally` to undo. Its counterfactual is a
  // code PATH (`computeFieldProbe`'s `probe.probeHoldOff` + the omitted confirmer held map), so it returns here
  // before the mutate/undo machinery below ever runs. See the docblock's `hold` entry for why the
  // constant-mutation shape (zeroing `SIGNAL_HOLD_CLOSES`) is NOT an equivalent control.
  if (beforeArg === "hold") return evaluateArm(at, { probeHoldOff: true });
  // Same shape a third time (hold-release Stage 4): the counterfactual is a code PATH — the release branch
  // in `heldFoldMap` skipped — so it mutates nothing and needs no `finally`. ⚠ It does NOT pass `probeHoldOff`:
  // the hold stays ON, only its release is withheld.
  if (beforeArg === "holdrelease") return evaluateArm(at, { probeHoldNoRelease: true });
  // Same shape again (Stage 6.1, RULING 14c): a builder-seam swap, not a mutated constant — nothing to
  // freeze, nothing to undo, and NO control-re-pin duty. ⚠ It does NOT pass `probeHoldOff`.
  if (beforeArg === "s61") return evaluateArm(at, { preS61Seam: true });
  // ⚠ ARGUMENT ORDER below: the post-apply snapshot is the BEFORE arm's table, `head` the AFTER (HEAD) arm's.
  const head = snapshotWeights();
  const undo =
    beforeArg === "brent"
      ? applyBrentBeforeArm()
      : beforeArg === "gpseat"
        ? applyGpSeatBeforeArm()
        : beforeArg === "value"
          ? applyValueBeforeArm()
          : beforeArg === "r6"
            ? applyR6BeforeArm()
            : beforeArg === "defleg"
              ? applyDeflegBeforeArm()
              : beforeArg === "f5"
                ? applyF5BeforeArm()
                : beforeArg === "eufinw"
                  ? applyEufinWeightsBeforeArm()
                  : applyBeforeArm();
  armCellEdits = diffWeights(snapshotWeights(), head);
  try {
    return evaluateArm(at);
  } finally {
    undo();
  }
}

const f3 = (n: number | null) => (n === null ? "   na" : n.toFixed(3).padStart(5));
const header = (label: string, a: ArmResult) =>
  `\n[probe-leg-ordering] 9-leg danger ordering over LADDER — store=${envArg}, asOf=${asOf}, arm=${label}\n` +
  `  DATA PATH: ${axis.length} closes ${axis[0]} .. ${axis[axis.length - 1]}, ` +
  `${singlePanel?.readings.length ?? 0}/${memberIds.length} dial members observed at asOf\n` +
  `  band=[${a.band.lo},${a.band.hi}] targetRung=${a.targetRung} held=${a.held ?? "(none)"}` +
  // `exoMinLeg` = `FieldResult.exogenous.floor`, the MINIMUM over the 9 legs — most legs carry more.
  `  exoMinLeg=${a.exogenous.floor.toFixed(3)}${a.exogenous.active ? " (ACTIVE)" : ""}\n`;
function printArm(label: string, a: ArmResult): void {
  console.log(header(label, a));
  // `ledger` = the Danger-ledger band (`danger` at DANGER_CUTS).
  console.log("  rank | rung | leg       | danger | ledger |    EW |    SN | inBand");
  for (const r of a.rows) {
    console.log(
      `  ${String(r.rank).padStart(4)} | ${String(r.rung).padStart(4)} | ${r.sleeve.padEnd(9)} | ` +
        ` ${r.danger.toFixed(3)} | ${BAND_LETTER[r.ledgerBand].padStart(6)} | ${f3(r.ew)} | ${f3(r.sn)} | ` +
        (r.inBand ? "yes" : "no"),
    );
  }
}

const byLeg = (a: ArmResult) => new Map(a.rows.map((r) => [r.sleeve, r]));

/** THE SEAM ARM'S OWN SEPARATION SURFACE (`s61`) — added 2026-08-05 (Stage 6.4.2), discharging the
 *  defect `5884c0ec` RECORDED but did not fix. (It was shared with the `s62` arm until that arm was
 *  deleted with the lead-precedence gate, 2026-08-07.)
 *
 *  Both collapse detectors (walk-mode `compareArms` and `--arm=diff`'s inline one) compare `danger` and
 *  `rank`. Every WEIGHT arm moves those, so that was the whole surface. The DIAL-CHIP SEAM arm cannot
 *  move `danger` AT ALL: it changes only the member map handed to `techConfirmerFromPanel`, so its Δ
 *  travels `techConfirmerP` ⇒ `computeT1Dial` ⇒ `band`/`targetRung` ⇒ `inBand` ⇒ (via the band) `held`.
 *  A real band-level move therefore reported as "A/A" and aborted, and the 6.1 measurement would have
 *  been unreadable off this instrument.
 *
 *  ⛔ SCOPED TO `s61` BY DESIGN — it returns `false` unconditionally on every other arm, so
 *  `eufin`/`brent`/`gpseat`/`value`/`r6` abort semantics are byte-identical to before this function
 *  existed. Widening it to all arms would turn a band-only wobble into a "separating close" for arms whose
 *  measurement is the ORDERING, and would silence their dead-control abort.
 *
 *  ⚠ `techConfirmerP` ITSELF IS NOT COMPARED — `ArmResult` does not carry it (checked 2026-08-05: the
 *  interface holds `rows`/`band`/`targetRung`/`held`/`exogenous`). `computeT1Dial` is monotone in
 *  it but not injective, so a confirmer move that does not reach the band is invisible here. That is a
 *  known, bounded blindness of this detector, not a claim that the confirmer did not move.
 *
 *  ⚠ WHAT IT ADDS DIFFERS BY DETECTOR. To `--arm=diff`'s inline detector (danger/rank only) it adds all four
 *  of `band`/`targetRung`/`held`/`inBand`. To `compareArms` it adds only `band`/`targetRung`/`inBand` —
 *  `held` was ALREADY part of `separated` there via `heldMove`, so this function's `b.held !== a.held` test
 *  is redundant on the walk path and load-bearing on the `--arm=diff` path. It is kept in one shared
 *  function deliberately: two detectors with two surfaces is how the 6.4.1 defect happened.
 *
 *  ⚠ IT DOES NOT WEAKEN `s61`'s BANKED VERDICT. `s61` measured TOTAL A/A on danger, rank, band,
 *  targetRung AND held at both screened closes, read off `--arm=before` beside `--arm=after` — every
 *  column this function adds was already read by hand there and every one agreed. This makes the
 *  instrument say so; it changes no number. */
function seamSurfaceSeparated(b: ArmResult, a: ArmResult): boolean {
  if (beforeArg !== "s61") return false;
  if (b.band.lo !== a.band.lo || b.band.hi !== a.band.hi) return true;
  if (b.targetRung !== a.targetRung) return true;
  if (b.held !== a.held) return true;
  const bMap = byLeg(b);
  // A leg missing from the BEFORE arm is a separation too (`undefined !== boolean`), consistent with the
  // `b === undefined` branch of the danger/rank tests.
  return a.rows.some((r) => bMap.get(r.sleeve)?.inBand !== r.inBand);
}

/** The WALK's comparison. `separated` = a leg missing from the BEFORE arm, OR a danger move, OR a rank move
 *  (all three per leg), **OR a held move**, OR — under `s61` ONLY — the seam band surface
 *  (`seamSurfaceSeparated`: `band`/`targetRung`/`held`/`inBand`).
 *
 *  ⚠ `--arm=diff`'s single-close detector is inline below and is NOT unchanged — `ef14aa5d` (Stage 6.4.2)
 *  widened BOTH detectors with `seamSurfaceSeparated`. Existing `--asOf` invocations still stay
 *  byte-identical, but the reason is the SCOPING, not an untouched detector: `seamSurfaceSeparated` returns
 *  `false` unconditionally unless `beforeArg` is `s61`, so on every weight arm the added disjunct
 *  is a constant `false` and the abort semantics are exactly what they were before that commit.
 *
 *  ⛔ `heldMove` IS PART OF `separated`: a held-only close would otherwise count `collapsed` yet feed
 *  `held-move closes`. A held move IS a separation — it is the leg the rotation would actually hold. */
function compareArms(b: ArmResult, a: ArmResult) {
  const [bMap, aMap] = [byLeg(b), byLeg(a)];
  const rankMoves: string[] = [];
  let maxAbs = { leg: "", delta: 0 };
  const heldMove = b.held !== a.held;
  // ⚠ PLUS THE SEAM ARM'S BAND SURFACE (`s61` only — see `seamSurfaceSeparated`). Without this a
  // walk over a chip-seam arm would count every band-only close as `collapsed`, print nothing for it, and
  // then abort the whole walk as a dead control if the band was the ONLY thing that ever moved.
  let separated = heldMove || seamSurfaceSeparated(b, a);
  for (const r of a.rows) {
    const prev = bMap.get(r.sleeve);
    if (prev === undefined || prev.danger !== r.danger || prev.rank !== r.rank) separated = true;
    if (prev !== undefined && prev.rank !== r.rank) rankMoves.push(`${r.sleeve} ${prev.rank}→${r.rank}`);
    const d = prev === undefined ? 0 : r.danger - prev.danger;
    if (Math.abs(d) > Math.abs(maxAbs.delta)) maxAbs = { leg: r.sleeve, delta: d };
  }
  return { bMap, aMap, separated, rankMoves, maxAbs, heldMove };
}

/** The CODE-PATH arms freeze no literal, so "frozen literals" would be a FALSE claim in the header of a
 *  table that gets pasted into a commit message (`hold`, `holdrelease`, `s61` all reconstruct their
 *  counterfactual by taking a different branch, not by transcribing a past table). Named per-arm rather
 *  than inferred, so a NEW arm has to classify itself here. */
const CODE_PATH_ARMS = new Set(["hold", "holdrelease", "s61"]);
const beforeLabel =
  beforeArg === "eufin"
    ? "before (frozen literals)"
    : `before (${beforeArg}, ${CODE_PATH_ARMS.has(beforeArg) ? "code path — no literal frozen" : "frozen literals"})`;

if (walkArg !== undefined && heldArg) {
  // ── HELD WALK: the HEAD arm only (no `--before` arm), threading hold state as `run-core.ts`'s
  // `assembleRun` does — `prevTarget` = prior DIAL target, `prevHeld`/`prevRung` = prior held.
  console.log(
    `\n[probe-leg-ordering] HELD WALK — store=${envArg}, ` +
      `${walkDates.length} closes ${walkDates[0]} .. ${walkDates[walkDates.length - 1]}\n` +
      "  per close: held [cand → if the CONFIRMING veto held it] dial=<target rung>; transitions marked.\n",
  );
  const steps: HeldStep[] = [];
  let prevHeld: string | null = null;
  let prevTarget: number | null = null;
  let prevConfirmCount = 0;
  let prevHeldDays = 0;
  let skipped = 0;
  let vetoes = 0;
  for (const d of walkDates) {
    const at = panelAt(seriesById, memberIds, d, { ...PANEL_OPTS, cursor: walkCursor });
    if (at.readings.length === 0) {
      skipped++;
      continue;
    }
    const arm = evaluateArm(at, { prevTarget });
    const panel = computeFamilyPanel(at.readings, DIAL_FAMILIES);
    const dialSleeve = LADDER[arm.targetRung - 1] ?? LADDER[LADDER.length - 1]!;
    const candidateSleeve = arm.held ?? dialSleeve;
    const prevRung = rungOfSleeve(prevHeld) ?? 0;
    const candidateRung = rungOfSleeve(candidateSleeve) ?? 0;
    // The CONFIRMING re-risk veto — applied pick-side in `run-core.ts`, not inside `computeFieldProbe`.
    const trendOk = trendConfirming(buildMemberState({ globalFamilies: panel.families }));
    const decision = decideRotationHold({
      candidateSleeve,
      prevHeld,
      prevRung,
      candidateRung,
      improving: prevRung > 0 && arm.targetRung < prevRung,
      trendOk,
      prevConfirmCount,
      prevHeldDays,
      newClose: true,
    });
    const vetoed = prevHeld !== null && candidateRung > 0 && candidateRung < prevRung && decision.heldSleeve === prevHeld;
    if (vetoed) vetoes++;
    const held = decision.heldSleeve;
    const rung = rungOfSleeve(held) ?? 0;
    const move =
      prevHeld === null || held === prevHeld ? "" : `  ${rung > prevRung ? "DE-RISK" : "RE-RISK"} ${prevHeld} → ${held}`;
    console.log(
      `  ${d} | held ${held.padEnd(8)}${vetoed ? ` [cand ${candidateSleeve} — veto]` : ""} dial=${arm.targetRung}${move}`,
    );
    steps.push({ date: d, held, rung });
    prevHeld = held;
    prevTarget = arm.targetRung;
    prevConfirmCount = decision.reriskConfirmCount;
    prevHeldDays = decision.heldDays;
  }
  const v = heldWalkVerdict(steps);
  console.log(
    `\n  HELD WALK SUMMARY: de-risks=${v.deRisks} re-risks=${v.reRisks} ` +
      `distinct-held=${v.distinctHeld.length} [${v.distinctHeld.join(", ")}] vetoed-re-risks=${vetoes} ` +
      `over ${steps.length} closes (${skipped} skipped, no observed member)`,
  );
  console.log(
    v.ok
      ? "  VERDICT: rotates both ways (≥1 de-risk AND ≥1 re-risk)."
      : "  VERDICT: FAIL — the window lacks a de-risk or a re-risk; an engine that cannot rotate both ways here is ineligible.",
  );
  process.exit(v.ok ? 0 : 1);
}

if (walkArg !== undefined) {
  // ── WALK MODE (§6.4): the screening IS the measurement. NEVER abort per close — a per-close A/A
  // collapse is the expected max-fold arithmetic and is Stage 2's RESULT. Abort only when EVERY close
  // collapsed, the genuine dead-control signal.
  interface CloseResult {
    date: string;
    observed: number;
    collapsed: boolean;
    rankMoves: string[];
    heldMove: boolean;
    maxAbs: { leg: string; delta: number };
    before: ArmResult;
    after: ArmResult;
  }
  const closes: CloseResult[] = [];
  const skipped: string[] = [];
  console.log(
    `\n[probe-leg-ordering] WALK — store=${envArg}, before=${beforeArg}, ` +
      `${walkDates.length} closes ${walkDates[0]} .. ${walkDates[walkDates.length - 1]}\n` +
      `  DATA PATH: ${axis.length} closes on the union axis ${axis[0]} .. ${axis[axis.length - 1]}\n` +
      `  One line per SEPARATING close; A/A-collapsed closes are counted only.\n`,
  );
  for (const d of walkDates) {
    const at = panelAt(seriesById, memberIds, d, { ...PANEL_OPTS, cursor: walkCursor });
    if (at.readings.length === 0) {
      skipped.push(d);
      continue;
    }
    const a = evaluateArm(at);
    const b = evaluateBeforeArm(at);
    const cmp = compareArms(b, a);
    closes.push({
      date: d,
      observed: at.readings.length,
      collapsed: !cmp.separated,
      rankMoves: cmp.rankMoves,
      heldMove: cmp.heldMove,
      maxAbs: cmp.maxAbs,
      before: b,
      after: a,
    });
    if (!cmp.separated) continue;
    const sign = cmp.maxAbs.delta >= 0 ? "+" : "";
    console.log(
      `  ${d} | rank: ${cmp.rankMoves.length === 0 ? "none" : cmp.rankMoves.join(", ")}` +
        ` | max |Δ| ${sign}${cmp.maxAbs.delta.toFixed(3)} on ${cmp.maxAbs.leg || "(none)"}` +
        (cmp.heldMove ? ` | held ${b.held ?? "(none)"} → ${a.held ?? "(none)"}` : ""),
    );
  }
  const collapsed = closes.filter((c) => c.collapsed);
  // NOT the A/A case: zero closes reached an arm at all, so there is nothing to collapse. Kept a distinct
  // branch because "all 0 evaluated close(s) collapsed to A/A" named the wrong failure and sent a reader
  // to the frozen literals when the real fault is the forward-fill horizon or the window.
  // ⚠ DEFENSIVE, not currently reachable — and deliberately kept: `walkDates` is filtered from the SAME
  // `unionCalendar` that `panelAt` forward-fills, so every selected date has at least one zero-gap member
  // and `skipped` stays empty. It goes live the moment the walk axis and the panel axis diverge (a
  // narrower sweep axis, or a horizon knob) — which is exactly when the message must not lie.
  if (closes.length === 0) {
    console.log(
      `\nABORT: ${skipped.length} close(s) in the window, and NOT ONE had an observed dial member under the\n` +
        "    forward-fill horizon — no close was evaluated, so no arm ran and nothing was compared. This is\n" +
        "    NOT an A/A collapse: pick a window the dial members actually cover, or check the store/--env.",
    );
    process.exit(1);
  }
  // ⛔ THE DEAD-CONTROL ABORT IS SCOPED TO THE CONTROL ARMS (`eufin` and the weight arms) — see the docblock. For those,
  // "the arms never separated" means the counterfactual is dead and a populated aggregate would be a false
  // measurement. For `brent` (§6.5's INCREMENTAL arm) total collapse IS the DROP verdict, so it must fall
  // through to the aggregate and the `--json` write; aborting made the DROP line unreachable.
  // `hold` joins `brent` in the exemption, and for the SAME reason in a different dress: it freezes no
  // literal that could rot (its control is a code path), so a total collapse here cannot be the
  // dead-control signal this abort detects — it is Stage 2.2 ruling 3's "record an honest A/A", which
  // needs the aggregate block and the `--json` write to be recordABLE at all.
  // `holdrelease` joins them on the SAME argument, and it is the arm's only writable A/A path: the plan
  // pre-registers that an honest A/A for arm C is writable ONLY after a `--walk` sweep found no separating
  // close (which is why the single-close `--arm=diff` abort above stays hard). Aborting here would make
  // that ruled result unreachable.
  if (
    collapsed.length === closes.length &&
    beforeArg !== "brent" &&
    beforeArg !== "hold" &&
    beforeArg !== "holdrelease"
  ) {
    console.log(
      `\nABORT: all ${closes.length} evaluated close(s) collapsed to A/A — the BEFORE and AFTER arms agree\n` +
        "    leg-for-leg on danger, rank and held at EVERY close in the window. That is the dead-control\n" +
        "    signal (a per-close collapse is expected and is not): either the frozen literals no longer\n" +
        "    describe the shipped change, or the counterfactual reaches nothing on this window.",
    );
    process.exit(1);
  }
  const rankMoveCloses = closes.filter((c) => c.rankMoves.length > 0);
  const heldMoveCloses = closes.filter((c) => c.heldMove);
  const overallMax = closes.reduce(
    (m, c) => (Math.abs(c.maxAbs.delta) > Math.abs(m.delta) ? { ...c.maxAbs, date: c.date } : m),
    { leg: "", delta: 0, date: "" },
  );
  const permutations = rankMoveCloses.reduce((n, c) => n + c.rankMoves.length, 0);
  console.log(
    `\n  AGGREGATE — before=${beforeArg}, ${closes.length} closes evaluated` +
      `${skipped.length > 0 ? ` (${skipped.length} skipped: no member observed)` : ""}\n` +
      `  A/A collapsed closes : ${collapsed.length} / ${closes.length}\n` +
      `  rank-move closes     : ${rankMoveCloses.length}\n` +
      `  held-move closes     : ${heldMoveCloses.length}\n` +
      `  overall max |Δ|      : ${(overallMax.delta >= 0 ? "+" : "") + overallMax.delta.toFixed(3)} on ` +
      `${overallMax.leg || "(none)"}${overallMax.date === "" ? "" : ` at ${overallMax.date}`}\n` +
      `  rank permutations    : ${permutations} (close × leg rank moves)\n` +
      // A total collapse is framed differently per arm: dead control for `eufin` (which aborted
      // above and never reach here), DECISIVE for `brent` — removing the row moved nothing anywhere.
      (beforeArg === "hold" && collapsed.length === closes.length
        ? `  ⚠ EVERY evaluated close collapsed to A/A. On the "hold" SEAM arm that is a RECORDABLE result\n` +
          `     (Stage 2.2 ruling 3), not a dead control — no literal is frozen here, so nothing could have\n` +
          `     rotted. It says the signal hold moved no leg's danger/rank/held ON THIS WINDOW; widen the\n` +
          `     window before generalising it.\n`
        : "") +
      (beforeArg === "holdrelease" && collapsed.length === closes.length
        ? `  ⚠ EVERY evaluated close collapsed to A/A. On the "holdrelease" FOLD arm that is the ONE writable\n` +
          `     A/A (the plan's pre-registered fallback), not a dead control — no literal is frozen here. It\n` +
          `     says arm C's release moved no leg's danger/rank/held ON THIS WINDOW; the sim measured C\n` +
          `     changing 188 of CUR's 489 raised member-closes, so a total collapse over a NARROW window is\n` +
          `     evidence about the window, not about C. Widen it before generalising.\n`
        : "") +
      (beforeArg === "brent" && collapsed.length === closes.length
        ? `  ⛔ EVERY evaluated close collapsed to A/A. On this INCREMENTAL arm that is the MEASUREMENT, not a\n` +
          `     dead control: MEMBER_WEIGHT.BRENT moved no leg's danger, rank or held anywhere in the\n` +
          `     window — precisely §6.5's DROP condition, which is why §7.1 dropped the row.\n`
        : "") +
      (beforeArg === "brent"
        ? `  §6.5 BAR (CLOSED — the row was DROPPED by §7.1 on this evidence; this run RE-PROVES it):\n` +
          `     drop MEMBER_WEIGHT.BRENT iff the rank-permutation count is 0 — it is ${permutations}, so ` +
          `${permutations === 0 ? "DROP (reproduced)" : "KEEP — ⛔ CONTRADICTS THE SHIPPED DROP, investigate"}.\n`
        : ""),
  );
  if (jsonOut) {
    writeFileSync(
      jsonOut,
      JSON.stringify(
        {
          probe: "leg-ordering",
          store: envArg,
          before: beforeArg,
          // ⚠ THE THIRD `--json` SHAPE. No top-level panel, no `arms` block — `closes` is what names it.
          walk: { from: walkFrom, to: walkTo, closes: walkDates.length, evaluated: closes.length, skipped },
          aggregate: {
            collapsed: collapsed.length,
            rankMoveCloses: rankMoveCloses.length,
            heldMoveCloses: heldMoveCloses.length,
            overallMax,
            permutations,
          },
          closes,
        },
        null,
        2,
      ),
    );
    console.log(`  wrote ${jsonOut}`);
  }
  process.exit(0);
}

const single = armArg === "before" ? evaluateBeforeArm(singlePanel!) : evaluateArm(singlePanel!);
let before: ArmResult | undefined;
let after: ArmResult | undefined;

if (armArg === "diff") {
  before = evaluateBeforeArm(singlePanel!);
  after = single;
  const [bMap, aMap] = [byLeg(before), byLeg(after)];
  // A/A COLLAPSE DETECTOR. A control arm that read the table under test would print this same
  // fully-populated diff with every Δ at zero. Fail loudly instead.
  // ⚠ EXTENDED 2026-08-05 (Stage 6.4.2) FOR THE CHIP-SEAM ARM ONLY: `seamSurfaceSeparated` adds
  // `band`/`targetRung`/`held`/`inBand` under `--before=s61`, which cannot move `danger` at all and
  // whose real Δ would otherwise be reported as an A/A collapse. It is a no-op on every other arm.
  const separated =
    [...aMap.keys()].some((leg) => {
      const b = bMap.get(leg);
      const a2 = aMap.get(leg)!;
      return b === undefined || b.danger !== a2.danger || b.rank !== a2.rank;
    }) || seamSurfaceSeparated(before, after);
  if (!separated) {
    // ⛔ THE ALGEBRA EXEMPTION, AND IT IS NOT A `--allow-identical` FLAG EITHER. It exempts nothing by
    // NAME: it prints only when `weightEditVerdict` can PROVE, from the cells this arm actually moved and
    // the severities it scored them at, that no leg's `wsev` could have differed. A dead control — a
    // frozen literal that rotted into HEAD's value — moves NO cell, so its edit list is empty and the
    // predicate refuses it by construction. The two failure modes stay distinguishable, which is the
    // whole reason an earlier commit's prose exemptions were deleted rather than re-worded.
    const verdict = algebraVerdict();
    if (verdict.kind === "identical") {
      for (const line of verdict.lines) console.log(`  ${line}`);
      console.log(
        "    — a before/after table here would be a GUARANTEED null run, not a measurement. This is a\n" +
          "    proof about THIS close only: screen another (`--walk`) before reading the edit as inert.",
      );
      writeRunJson();
      process.exit(0);
    }
    // ⚠ THE EXEMPTION IS NAMED PER-ARM, exactly as walk mode names `beforeArg !== "brent"` — NOT a general
    // `--allow-identical` flag (Stage 2.2 ruling 2 rejected one: it would silence a real dead-control
    // collapse on the arms whose whole point is to fail loudly). `hold` mutates no constant, so "the arms
    // agree" cannot mean "the frozen literals rotted" here; it means the signal hold moved nothing at this
    // close, which is a MEASUREMENT and is owed the printed table and the `--json` write.
    if (beforeArg === "hold") {
      console.log(
        "  A/A — the BEFORE (unheld) and AFTER (held) arms agree leg-for-leg on danger and rank at this\n" +
          "    close: the Stage-2.1 signal hold changed NOTHING here. Honest result, not a dead control —\n" +
          "    this arm freezes no literal that could rot. Screen another close (`--walk`) before reading it\n" +
          "    as the hold being inert in general.",
      );
    } else if (beforeArg === "s61") {
      // ⚠ ABORT, NOT AN EXEMPTION (RULING 14e / the task's A/A discipline). `s61` freezes no literal, so
      // the generic "the frozen literals rotted" diagnosis would be wrong — but the single-close abort
      // still stands, because a table printed off a non-separating close is not the 6.1 measurement.
      // The honest reading is below; screen another close rather than banking this one.
      console.log(
        "ABORT (A/A): the BEFORE (pre-6.1 window-only held map) and AFTER (shipped merged held map) arms\n" +
          "    agree leg-for-leg on danger and rank AND on band/targetRung/held/inBand at this close —\n" +
          "    Stage 6.1's live-panel RAISE changed\n" +
          "    NOTHING here (no lead lit LIVE while absent from the persisted member-history window, or the raise\n" +
          "    reached no leg's max). This arm freezes NO literal, so it is NOT a dead control and NOT a\n" +
          "    re-pin failure; it is a non-separating close. Screen another (`exoMinLeg`, or `--walk`).",
      );
      process.exit(1);
    } else if (beforeArg === "holdrelease") {
      // ⚠ ABORT, NOT AN EXEMPTION, and NOT the generic diagnosis below. This arm freezes no literal (it is
      // a code path, like `hold` and `s61`), so "the frozen literals no longer describe the shipped
      // change" would be a FALSE diagnosis. The abort still stands because the hold-release plan
      // PRE-REGISTERS that the table must move on a screened separating close (arm C changes 188 of CUR's
      // 489 raises), so an A/A read off ONE close is a non-separating close, never the measurement.
      // ⛔ Deliberately NOT widened into `seamSurfaceSeparated` (which stays `s61`-only): a band-only Δ
      // with every leg's danger identical would not satisfy the pre-registered "moves on at least one leg".
      console.log(
        "ABORT (A/A): the BEFORE (CUR — hold with no release) and AFTER (arm C — releases on observed\n" +
          "    recovery) arms agree leg-for-leg on danger and rank at this close: no member's window carried\n" +
          "    a severity past a reported recovery into any leg's max here. This arm freezes NO literal, so\n" +
          "    it is NOT a dead control — it is a non-separating close, and the plan pre-registers that an\n" +
          "    honest A/A is writable only after a `--walk` sweep found no separating close. Run\n" +
          "    `--walk=FROM..TO` rather than banking this close.",
      );
      process.exit(1);
    } else {
      console.log(
        "ABORT: the BEFORE and AFTER arms agree leg-for-leg on both danger and rank — the control arm has\n" +
          "    collapsed to A/A. Either the frozen literals no longer describe the shipped change, or the\n" +
          "    weights stopped reaching this leg. A populated table here would be a false measurement.",
      );
      process.exit(1);
    }
  }
  printArm(beforeLabel, before);
  printArm("after (HEAD)", after);
  console.log(
    `\n  DIFF — before → after. Ranked by the AFTER arm; rank 1 = calmest.\n` +
      `  HELD: ${before.held ?? "(none)"} → ${after.held ?? "(none)"}\n` +
      `  IN-BAND: {${before.rows.filter((r) => r.inBand).map((r) => r.sleeve).join(", ")}}\n` +
      `        →  {${after.rows.filter((r) => r.inBand).map((r) => r.sleeve).join(", ")}}\n`,
  );
  // `ledger` = the Danger-ledger band before → after; a changed band is flagged `⚠ BAND` on its row.
  console.log("  leg       | before | after  |      Δ | ledger      | rank move");
  for (const r of after.rows) {
    const b = bMap.get(r.sleeve);
    const d = b === undefined ? NaN : r.danger - b.danger;
    const move =
      b === undefined
        ? "  (new)"
        : b.rank === r.rank
          ? `${b.rank} → ${r.rank}`
          : `${b.rank} → ${r.rank}  ${b.rank > r.rank ? "^" : "v"}${Math.abs(b.rank - r.rank)}`;
    const ledger =
      b === undefined
        ? `  → ${BAND_LETTER[r.ledgerBand]}`.padEnd(11)
        : `${BAND_LETTER[b.ledgerBand]} → ${BAND_LETTER[r.ledgerBand]}${b.ledgerBand !== r.ledgerBand ? " ⚠ BAND" : ""}`.padEnd(11);
    console.log(
      `  ${r.sleeve.padEnd(9)} | ${(b?.danger ?? NaN).toFixed(3).padStart(6)} | ` +
        `${r.danger.toFixed(3).padStart(6)} | ${(d >= 0 ? "+" : "") + d.toFixed(3)} | ${ledger} | ${move}`,
    );
  }
  console.log(`\n  ${formatBandChanges(bandChanges(before.rows, after.rows))}`);
  const flips = after.rows.filter((r) => bMap.get(r.sleeve)?.rank !== r.rank).map((r) => r.sleeve);
  console.log(
    `  RANK MOVEMENT: ${flips.length === 0 ? "NONE — the ordering is unchanged" : flips.join(", ")}\n` +
      (beforeArg === "eufin"
        ? `  ⚠ The BEFORE arm reverts the seven WEIGHT cells only.`
          : beforeArg === "gpseat"
            ? `  ⚠ MAGNITUDE arm: only MEMBER_WEIGHT.OVX/G1["EU-Fin"] differ ` +
              `(${GP_SEAT_BEFORE.OVX}/${GP_SEAT_BEFORE.G1} → ${GP_SEAT_AFTER.OVX ?? "absent"}/${GP_SEAT_AFTER.G1 ?? "absent"}). Both cells\n` +
              `    stay SEATED in both arms, so cell sensitivity and MEMBER_RELEVANCE are identical across\n` +
              `    them — any movement here is the re-seat alone.`
            : beforeArg === "hold"
              ? `  ⚠ SEAM arm: no constant differs. The BEFORE arm runs the SAME weights with the SIGNAL HOLD\n` +
                `    off, on both the member states and the dial's tech chip. Every Δ here is the hold.`
              : beforeArg === "holdrelease"
                ? `  ⚠ FOLD arm: no constant differs, and NO literal is frozen (so no re-pin duty). The BEFORE arm\n` +
                  `    runs the SAME weights and the SAME hold WINDOWS with the release-on-observed-recovery\n` +
                  `    branch withheld (the CUR fold), on both the member states and the dial's tech chip. Every\n` +
                  `    Δ here is arm C's release alone — NOT the hold itself, which is on in both arms\n` +
                  `    (that contrast is \`--before=hold\`).`
              : beforeArg === "value"
                  ? `  ⚠ COLUMN arm: the whole "Value" column differs — 8 MEMBER_WEIGHT + 2 FAMILY_LEG_WEIGHT\n` +
                    `    magnitude cells, plus F4/F6/F8 DELETED\n` +
                    `    (not zeroed: the pre-retune key set).`
                  : beforeArg === "r6"
                    ? `  ⚠ ROW arm: MEMBER_WEIGHT.R6's five row-fill-seated legs (EM, Value, S&P 500, ex-US, Health)\n` +
                      `    are DELETED and its surviving four cells are identical in both arms, so every Δ here is\n` +
                      `    the §3.6 row-fill alone — NOT the later EU-Fin 0.8→0.4 cut.`
                    : beforeArg === "s61"
                      ? `  ⚠ SEAM arm: no constant differs, and NO literal is frozen (so no re-pin duty). The BEFORE arm\n` +
                        `    builds the dial chip's held map through the PRE-6.1 window-only seam\n` +
                        `    (buildMemberStateHeldAt(cissHistory, 0)); the hold is untouched in BOTH arms, so\n` +
                        `    every Δ here is 6.1's live-panel raise alone — via techConfirmerP ⇒ band/inBand.`
                      : beforeArg === "defleg"
                        ? `  ⚠ MAGNITUDE arm: four cells differ — FAMILY_LEG_WEIGHT.cr.Health 0.9→1.0,\n` +
                          `    cr.Staples 0.9→0.85, rt.Health 1.0→0.85, MEMBER_WEIGHT.F3.Staples 0.4→0.5. Nothing is\n` +
                          `    seated or de-seated, so MEMBER_RELEVANCE and cell sensitivity are identical across the\n` +
                          `    arms — every Δ here is the cr<->rt defensive swap alone.`
                    : beforeArg === "eufinw"
                      ? `  ⚠ MAGNITUDE + SEAT arm: BUND/R5/GT/GB["EU-Fin"] at their pre-retune values and\n` +
                        `    AT1["EU-Fin"] unseated in BEFORE; every Δ here is the EU-Fin overlap retune (S1+S2).`
                    :`  ⚠ INCREMENTAL arm: MEMBER_WEIGHT.BRENT alone differs — the BEFORE arm DELETES the live row\n` +
              `    (re-inverted 2026-08-06) and G1/OVX stay seated in both, so this is BRENT's marginal reach on top of\n` +
              `    shipped EXOGENOUS engine, not the pre-C1 state.`),
  );
} else {
  printArm(armArg, single);
}

/** The single-close `--json` write. A FUNCTION, not a trailing `if`, for exactly one reason: the algebra
 *  exemption above exits 0 from inside the collapse detector and owes the same file the fall-through path
 *  writes. Two copies of this shape would be two things to keep in step. */
function writeRunJson(): void {
  if (!jsonOut) return;
  writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        probe: "leg-ordering",
        store: envArg,
        asOf,
        axis: { first: axis[0], last: axis[axis.length - 1], closes: axis.length },
        observedMembers: singlePanel!.readings.length,
        totalMembers: memberIds.length,
        arm: armArg,
        // Names the counterfactual the BEFORE arm reconstructed. Always present, including under
        // `--arm=after` where no before arm ran: a consumer must never have to infer it from the shape.
        before: beforeArg,
        // ⚠ Under `--arm=diff` the top-level panel block is OMITTED, not renamed: it would carry the
        // AFTER arm alone, and a consumer reading `.rows` beside `arm: "diff"` would silently get one
        // arm of a two-arm run. Diffing therefore exposes the panel ONLY under `arms.before`/`arms.after`,
        // so an arm can only be read by naming it. A `jq '.rows'` written for `--arm=after|before` breaks
        // loudly here rather than returning a half-answer. ⚠ Second failure mode: on an A/A collapse
        // `--arm=diff` exits non-zero above, before this block, so no JSON is written at all — EXCEPT
        // under `--before=hold`, whose named exemption (Stage 2.2 ruling 2) falls through and writes the
        // all-zero-Δ table as the honest measurement it is.
        ...(armArg === "diff"
          ? { arms: { before, after } }
          : {
              band: single.band,
              targetRung: single.targetRung,
              held: single.held,
              exogenous: single.exogenous,
              rows: single.rows,
            }),
      },
      null,
      2,
    ),
  );
  console.log(`\n  wrote ${jsonOut}`);
}

writeRunJson();
