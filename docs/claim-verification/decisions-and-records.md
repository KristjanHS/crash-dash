# Claim verification — decision, ruling and record claims

Shard of `docs/claim-verification.md`. **Ordinals are global and permanent** — a shard is a storage
location, not a namespace, so §61 is §61 wherever it lives and the cite form never changes.
Index, preamble and tombstones: `docs/claim-verification.md`. **The admission test — what may be
written here at all — is `.claude/rules/plan-hygiene.md` §Claims**; nothing licenses a write from
inside this file.

## 3. Every element of a plan is a claim — even SAME-DAY

- **FILE / TEST / coverage:** grep the recompute SITE *and* the invariant's ASSERTION by symbol, file-wide. A
  hedge conflicting with a TESTED convention loses — fix the DOC. Grep sibling constants before "fixing" a
  lone one.
- **Predicted trace:** re-read each stage against what SHIPPED — an earlier stage can invalidate a later
  stage's output.
- **TEST VALUES:** probe the ENGINE for every literal, never hand-derive. A floor/cap edit can make a
  fixture's BASE bind, moving the DERIVED fields.
- **INVENTORY / id tables:** check the live source (`grep src/registry.ts src/families.ts`).
- **⚠ / trap notes:** grep the asserted anchor.
- **"Wire X" steps:** evaluate the derived set at RUNTIME — a sibling lever may already have done it.
- **Data-flow assumptions:** grep the CONSUMER and the source-choice comment before a "move the source" stage.
- **STAGE BOUNDARIES:** a split asserting slice N is independent of its sibling is a claim — run the slice
  ALONE before trusting the split. One stage asserted its weight change was coupled to the seating shipping
  beside it; the real coupling was to the *previous* slice's cut, so the "independent" halves were not.

## 5. A recorded SHA

`git merge-base --is-ancestor <sha> main` before citing. Scope SHA falsifiers to their own checkout — a
worktree rebase dangles pre-rebase SHAs. Corollary: never bank a SHA as a protocol constant without
`git merge-base --is-ancestor <sha> main` at quote time — a linked worktree resolves orphaned objects fine,
so `git cat-file -t` succeeding proves nothing.

## 9. An audit / review finding

True at capture only. Staged anywhere — `project_state`, a plan, a "delete this" TODO — it claims the
*current* tree. Re-grep the *mechanism* (not the symbol), the cited fossil, and the *inputs* its recommended
option assumes (measured-vs-hand-typed, persisted-vs-recomputed).

⚠ **A finding can also be false AT BIRTH, and briefing a fix agent on it ships the defect the finding
imagined.** Staleness is the familiar failure; a reviewer misreading a mechanism is the other one, and it
arrives already phrased as a defect report so it reads as verified. Verify the *premise* — not just the
freshness — before dispatching a fix: an "unescaped pipes" finding was wrong because `\|` **is** GNU BRE
alternation, i.e. the finding inverted the very rule it invoked. Cheapest discharge: run the construct the
finding calls broken and check it behaves as the finding claims.

⚠ **A rule can stay TRUE while its recorded EVIDENCE rots — and the rotted evidence then argues the rule is
obsolete.** A guard comment that cites a count and a named symptom is making two claims beyond the rule
itself; both decay independently of it. Re-measure before citing, and when the symptom changes SHAPE say so
loudly — a reader who greps for the old symptom, finds nothing, and infers the guard is stale will delete
it. CORE-9 Stage A, 2026-08-01: the `families → registry` prohibition held, but "44 suites fail to collect"
re-measured at 9.

⚠ **A COUNT quoted from a third party carries that party's population definition, not yours.** Two
aggregators reporting a 30-name index fund as holding 48 and 82 lines were both "right" — they were counting
cash, collateral, FX and zero-market-value futures alongside equity — and the disagreement read as evidence
the roster was dirty, nearly sinking a sourcing route on a phantom (2026-08-03, `EXSH`) — the objection
dissolves against the issuer CSV rather than being adjudicated. Before treating a count as a finding,
get the row-level source and re-derive it against the population you actually mean; disagreeing counts from
sources that agree on the NAME SET are a population-definition smell, not a data-quality one.

⚠ **And the RE-measurement is a claim too — a symptom observed under ONE runtime is not the symptom.** The
same Stage A generalized its vitest observation ("the binding reads `undefined`, not thrown") into the guard
comment; review found native ESM — the cron and CLI paths — still throws a TDZ `ReferenceError`, and that a
different entry order can produce no error at all. Before writing "it fails like X", name the runtime and
the entry path you measured under, and check whether the surface you are warning is the one you ran.

## 11. A `[USER]` verdict's stated PREMISE — and a RULE's stated MECHANISM

A world-claim, not a preference. Check it before executing, not before filing.

⚠ **A RULED/CLOSED marker stamped on a PREMISE makes the false half self-protecting.** Once a row reads
CLOSED, later passes re-read the verdict and never re-check the world-claim under it, so a dead premise
survives behind a marker whose whole meaning is *do not re-open*. Mark the OUTCOME closed; never the premise.

**A premise can falsify itself mid-execution, and the verdict may still bind.** EW W6's E-3 ruled the
`MOMENTUM_DIVISOR` ripple a Stage 6.9 blocker *because the cut remap might have staled `dial_state`*;
measuring it showed `dial_state` is insensitive to `DANGER_CUTS` on those rows and the red probe is a
**pre-existing, unrelated** defect. The outcome held (no restatement) but its *reason* inverted. When this
happens, **correct the ruling's stated reason in the doc in the same burst** — do not carry the dead reason
forward, and do not treat the inverted premise as licence to re-litigate the outcome.

⚠ **A single doc's prose can mint several false premises at once.** The notify-path eyeball round (2026-07-26)
returned TWO user verdicts resting on false world-claims — that r4's delay was "the 2-day confirmation lag"
(it is three closes, a different mechanism) and that the exogenous floor moves which leg is *held* (it floored
leg danger; the pick was a separate axis — **TRUE ONLY UNTIL 2026-08-02**, see the tombstone below). Both trace
to the same walkthrough doc's §1 narrative being read as
**causal** when it was written as **sequential**. So when one premise in a feedback round collapses, re-check
the *siblings that came from the same source section* — the defect is in the explanation, and an explanation
mis-states its whole neighbourhood, not one line.

⚠ **TOMBSTONE (2026-08-02, C1): the second correction above has
INVERTED, and the user's original premise is now the true one.** `exogenousFloor`/`EXO_CAP_FLOOR` are deleted;
the exogenous contribution is a per-leg weighted `gp` term inside `combineLegDanger`, so it enters `ownDanger`
→ `effDanger` → `pickHeld` → the pushed `held_sleeve`. It **does** move which leg is held. Kept rather than
rewritten because the *lesson* is unchanged (a false-premise cluster from one narrative section), and because
this is the sibling class of this section's own "a premise can falsify itself mid-execution": a correction is itself a
claim with a shelf life, so **when the engine change lands, sweep the corrections you banked against it** —
this one and its counterpart in §24 (the `exogenousFloor` "on both axes" note) were minted in the same round
and both needed the same tombstone.

⚠ **A RULE's stated MECHANISM is the same class of claim — and it is the one nobody checks.** A verdict's
premise at least reads as an assertion; a rule's "because X happens" reads as settled contract, so work gets
*sized* off it without verification. `plan-hygiene.md` stated that a `docs/plans/` file auto-loads into every
session as pseudo-active work; a whole rung
existed to harvest that saving. It is false — plans never enter context unread (`.claudeignore` unimplemented,
anthropics/claude-code#4160) — and the rung's savings claim was dropped, not restated. **Before sizing a rung
off a rule's mechanism, verify the mechanism the same way you would a `[USER]` premise**, and when it falls,
correct the rule in the same burst (which owes §1's file-wide sweep, not a single-clause patch).

⚠ **A deletion ruled on "these rows are unusable" owes a grep of what READS them.** "Unscoreable" describes a
row's own output, never its role: a scorer's warmup head is unscoreable *and* is the base every later
expanding-window percentile is drawn from, so deleting it blanks a year of cuts (CG arc, 2026-08-08). Resolve
the population's consumers before executing a delete ruling, not just the reason it was called stale.

## 15. A backlog's ORDERING

An ordering is a claim. Re-falsify each rung's done-state before picking — the "next unfinished" rung may
already be shipped.

**A decision QUEUE is the same shape, and the falsifier runs BEFORE the question.** An audit that walks a
queue and asks the user per row will mint rulings on rows whose premise already died elsewhere — a round-trip
spent, and a verdict recorded against a dead world. Run each item's own falsifier first; the ones that
survive are the questions — and an OPTION's premise likewise, before it reaches the user (2026-08: a
questions-round live-e2e fork rested on "the feed is unreachable" — only the keyless path was dark; §25).

## 20. A verdict recorded ONLY in a commit message is not durable

A resolved investigation is a claim about *state*, and the next session reads state from the plan doc and
`project_state`, not from `git log`. E11 (2026-07-26) traced `armed (rates)` vs the "GREEN Rates tile" to a
false premise and ruled the headline should render; the verdict, the falsified premise and the owed render
lived only in `32e1b69c`'s message. Both durable surfaces still said *"trace first, render conditionally"*
— so the next session would have re-run a finished trace, or taken the not-clean branch, seen the comment
the trace had left in `api/lab.ts`, and closed the rung as *ruled API-only*, silently dropping the render.
The commit message was accurate and complete; that is exactly why it reads as sufficient.

**The check:** when a rung's outcome CHANGES what the remaining work is, the same edit burst must write it
to the plan doc **and** the pointer — before the commit, not after. A commit message may be the only record
of *how* something was verified; it may never be the only record of *what was decided*.

⚠ **Deleting the superseded instruction is the wrong repair.** Keep the pre-verdict text marked as
superseded — a future reader needs to see that the conditional branch was evaluated and did not fire,
otherwise the rung looks like it was simply never gated.

## 27. A plan's own confirmer can be UNHONOURABLE by the time you reach it

NF-1 Stage 7 (2026-07-26) instructed: re-run `probe:cash-overlay` and *"confirm its fire count is
**unchanged**"* — the confirmer that Stage 1's decoupling was behaviour-neutral. At execution there was
nothing to compare against: Stage 1's own commit records no fire count, and the only figure on record was
eight days old (31/1500, 17 episodes) with eight intervening dial-layer commits that move
`computeT1Dial.targetRung` — the sequence the overlay folds. The honest current reading, 38/1500 across 19
episodes, is **not** evidence of a Stage-1 change and **not** evidence of neutrality; it is a fresh baseline.
Reporting it as "unchanged" would have been false, and reporting the delta as a Stage-1 regression would have
been false in the other direction.

**The check:** a before/after confirmer is only as good as the *provenance of its BEFORE*. Before running one,
ask where the baseline is written down and **what has landed since** — `git log --oneline <baseline-sha>..HEAD`
over the files the metric depends on. If anything in that range can move the metric, the comparison is
uncontrolled and the confirmer is dead; say so and substitute a claim you *can* establish. Here that was
**value identity** — pre-change `CASH_ACCEL_WINDOW = R4_ENTER_CLOSES` with `R4_ENTER_CLOSES = 3`, post-change
the literal `CASH_ACCEL_WINDOW = 3`, same number ⇒ nothing could have moved — which is checkable at any time
and does not decay. A plan step that names a confirmer owes the baseline's SHA; one that names only the
command is asking a future session to invent the comparison.

⚠ **A DEFERRED chore inherits the baseline its ruling assumed, and that baseline expires.** A verification
ruled "vs a pre-X run" was written when HEAD *was* X's tip; by the time the chore runs, both arms have
drifted. Re-derive both arms from the arc's own boundary before running, never from today's HEAD.

⚠ **The INSTRUMENT can move too, not just the range.** A stage ships, its owed before/after measurement is
deferred, and the plan records the protocol as "check out each SHA". The protocol reads as durable because
SHAs are durable. But the *instrument* is not pinned by the SHA under test — and the very next commit is
often the review fix that re-pins the instrument onto the new seam. From that moment the recorded protocol
measures nothing: at the arm's own SHA the instrument still carries the OLD seam, so the arm reads A/A by
construction. Incident (2026-08-05): Stage 6.1
deferred its clause-(a) 9-leg arm. Its review fix — one commit later — re-pinned
`scripts/probe-leg-ordering.ts`'s dial seam from `buildMemberStateHeldAt(cissHistory, 0)` onto
`buildMemberStateHeld(...)`, and said so in its own message ("would have reported 6.1 as a no-op — banking
the deferred clause-(a) number through the wrong seam. Take it BEFORE 6.2 lands."). It was not taken before
6.2 landed. By then the checkout protocol had TWO independent blockers: each tree's own probe carries the
pre-6.1 seam (A/A by construction), and the current probe cannot even load against either before-tree
because it imports `noHoldDepth`, a symbol Stage 6.2 introduced. A second failure mode compounded it — a
sibling rebase orphaned three of the four pinned SHAs, so the protocol also named objects that are not
ancestors of `main`. **The move:** a deferred measurement's protocol must name its
INSTRUMENT's required state, not only the subject SHAs — and when the instrument is re-pinned, the deferral
is void, not merely stale. Either take the measurement before the re-pin lands (the review fix usually IS the
re-pin), or convert the arm to an **in-probe control arm** at HEAD, which the retired `research-probes.md`
§*An A/B probe's CONTROL arm must be reimplemented in-probe* (2026-08-07) mandated and which no later commit
can invalidate silently. Second incident: F11 (2026-08-10) banked a `rect 1260` row from
`probe:sigma-response`, then ruling 5 set `F11_SIGMA_WINDOW = 504` — the arm set derives from the id's own
window, so that row has no producer any more. Re-run the named instrument and check the arm/column still
exists before quoting a banked figure; when it is gone the row is frozen evidence — pin it `⛔ FIXED`, never
re-derive it, and never let a sweep re-score it.

⚠ **The same decay hits a GATE SCRIPT's banked evidence, not just a prose baseline.** D4's
`probe:d4-freshness` capture (2026-07-26) shipped its census *before* the FXH re-cadence and before the `rot`
field existed, and the script's own `Census` silently dropped `rot` rather than erroring — so the artefact
kept reading as a passing gate while certifying a tree that no longer existed. A gate must be **re-run at the
HEAD it certifies**; a stored capture certifies its own SHA and nothing after it. When a gate's output shape
is derived from live fields, a missing field must be a hard error, never an omitted column.

## 31. A BANKED design list can silently drop a requirement its own plan already RULED

§I9.7 (2026-07-26) carried a distilled item list standing in for several earlier ruled sections. It omitted
§I1's per-leg half outright, and its item 2 had drifted into a glyph swap that §I1's own mock **contradicts**.
Nothing flagged either: a summary list is prose, so no test, type or grep sees the loss, and the list reads as
more authoritative than the sections it summarises precisely because it is shorter and later.

**The check:** a distilled list is a *cache*, and it can be stale against its source. Execute from the
**RULING** — re-read the section the item cites, not the item — whenever the list is more than one session old
or was written by a different pass. If the list and the ruling disagree, the ruling wins and the list gets
corrected in the same burst (never silently followed, never silently ignored). A banked list that cannot name,
per item, which ruling it came from is not usable as a contract.

## 33. A refusal whose stated COST names a dependency rots when that dependency changes

`/lab` declined leg attribution for F1/F2 with a `proxy-id-excluded` enum, and its docblock argued the cost:
a live FRED fetch per request. BAA10Y became a stored indicator elsewhere, which silently made the refusal
free — while the docblock kept arguing for it, and nothing red. The claim class is prose asserting a cost
that no longer exists; a decline is the shape it hides in, because a decline reads as a design decision
rather than as a measurement.

**The check:** when a refusal, cap or exclusion states *why* (a fetch, a quota, a budget, a cap), that
"why" is a live claim against another subsystem — re-verify the dependency before citing the refusal as
current, and re-check every such decline when the named dependency is stored-ified, cached or removed.

**A ruling's stated BLOCKER decays identically.** A round-2 block cited a decision an earlier arc had already
CLOSED, and the next stage's deliverable inherited the stale framing verbatim — the block reads as settled
precisely because someone ruled it. Re-check a cited blocker's own status before restating it as live.

Nearest siblings: §9 (a finding is true at capture only — re-grep the mechanism before acting on it) and
§27 (a plan's own confirmer can be unhonourable by the time you reach it). All are the same decay, at four
surfaces: a refusal, a blocker, a finding, a confirmer.

## 50 — an option you offer a decider is a claim, and a rank statistic erases most distinctions between offered options

Rung 4 Stage 1 (2026-08-03) put three "what should the rank correlation be measured against?" options to the
user: cross-sectional demean, pooled time-series excess, and raw forward return. The raw option's
description asserted that "a common market move dominates and swamps any cross-leg ranking signal". The user
ruled for the demean. Implemented, the demean subtracts **one scalar per close** from all nine legs, and
Spearman is rank-only — a constant shift cannot change a single rank. Every measured number is byte-identical
to the raw arm the ruling declined, and the declining reason was false as stated.

The measurement survived (the *other* axis in the same option — within-close vs pooled — is real and was
genuinely chosen), so no number moved. What did not survive is the decision record: the plan doc asserted a
distinction the code cannot express, in the section a later fork ruling reads.

**The move:** before offering options that differ by a transformation, check the transformation against the
**statistic that consumes it**. Rank statistics are invariant to any monotone per-group transform, so
demeaning, scaling, and standardizing *within the grouping unit* are all no-ops against a within-group rank
correlation; they only bite under a Pearson, a pooled fold, or a magnitude threshold. Two options that
collapse under the consuming statistic must be presented as one — and when the collapse is only discovered
after the ruling, record it as a correction **beneath** the original ruling text, leaving that text unedited,
so the decision history stays readable.

**A MECHANISM you derived inline is a claim exactly as a cited fact is — and it is the more dangerous of the
two, because nothing about it looks like a citation to check.** 2026-08-04: "relative betas make `Σ w·β ≈ 0`,
therefore `Σ w·|β|` dilutes toward zero" shipped as the factual premise of a ruling round and into a code
docblock; the user ruled on it, review refuted it, a sim confirmed the refutation. The two expressions are one
`|·|` apart and the absolute value destroys the cancellation the argument rests on. **The move:** when an
option's description contains a *therefore*, the algebra between the premise and the conclusion is the thing
to check — compute both sides on a toy input (a sim before the ruling round, not after), or write the option
so it states the mechanism as untested.

## 53 — "reviewed and clean" is a claim about a COMMIT SET, and the range you cite is not that set

`A..B` excludes `A`. A review dispatched over `<first-commit-of-the-stage>..<last>` therefore never reads the
first commit, and a range whose base is a *descendant* of the code reads nothing at all — yet both record
identically in the commit message and in `project_state`, as a range that looks like full coverage.

Incident (2026-08-04, R4 Option A). `project_state` carried "Review of `9b09251e..cf689e77` RAN and is clean";
`git rev-list` on that range returns one commit, the archive doc. The two commits that actually shipped the
danger-model weight change had never been read, and the clean-review sentence is precisely what would have
stopped anyone re-opening them. In the same 40-commit span one commit escaped the milder way — its four
successors were reviewed, it was the base.

**The move:** resolve the range with `git rev-list --oneline <range>` **before** dispatching, and record the
resolved commit list — not the range expression — as what was reviewed. A "review ran" line that names only
a range is unfalsifiable at read time: the reader would have to re-resolve it, and never does. Related:
§16-family cite rot (an expression that resolves differently later) and the orphaned-SHA hazard — a sibling
rebase can leave the cited base unreachable from `main`, so the range silently narrows.

## 58 — a candidate failing two bars must record BOTH; the softer verdict mis-directs the successor

When one item fails several independent gates, only one verdict gets written, and the softer disposition is
the natural pick — it feels more careful. It is the opposite: a candidate recorded `unscoreable` when it also
`fail`s tells the next session the thing is *rescuable* (supply the missing mapping and re-score) when the
other bar says it is dead however that mapping goes. 2026-08-04: a sourcing candidate was recorded
`unscoreable on bar 3` for a missing transfer assumption while its own paragraph stated the coverage fact —
four ladder legs with no counterpart — that had scored a sibling candidate an outright FAIL on the same bar.

**The move:** score every bar the evidence reaches, then record the verdict as the **conjunction**, hardest
disposition first (`failed bar 3 (coverage); additionally unscoreable on the transfer requirement`). The
recognition cue is a verdict line naming ONE bar while the section body establishes a violation of another.

## 61 — a source cited for a SUPPORTING line is also ruling on the question you are deciding

An audit reaches a conclusion, finds a project doc that supports one step of it, and cites that doc. The
citation gets checked the way citations usually are — does the quoted line say what the audit says it says?
— and it does. What nobody checks is the **rest of the source**: the same doc had already measured the exact
question the audit was deciding, and answered it the other way.

Incident (2026-08-05, a retraction): the Stage 6.0 timing audit moved `SPCONC` from `lag` to
`lead`, citing the S&P-IT risk-coverage plan. That plan measures the concentration drawdown
**leading F5** (r=+0.42 at k=−20/−60) — a `lag`-side finding on the very axis being re-classified — and it
attributes placebo-surviving forward-return gaps to regime clustering, which is precisely the rule the audit
had minted to justify the move. It was also inert by construction (`breadthReadingSeries` emits no RED and
`severityOf` maps only RED→`lit`, so the class could never open the gate), so no test, no `tsc` run and no
output diff could have caught it. **The cited source was the only available witness, and it was against.**

**The move:** when a doc is cited in support of a classification, ordering or threshold decision, grep that
doc for the decision's OWN subject before quoting it, and record its verdict even when it agrees — a source
is admissible for a supporting line only once you know it does not rule against the conclusion that line is
supporting. Corollary: a decision rule stated as self-evident ("a placebo-surviving forward-return effect is
a leading property by definition") is a claim about the literature; when the doc you are citing states the
opposite mechanism, that is a falsifier, not a difference of framing. Where §11 and §57 have a doc
undercutting *itself*, here it undercuts the reader quoting it.

## 62 → merged into §27

## 70 — an algebraic claim drafted in a plan and pasted into a RULE ships unverified by construction

Plan prose is drafting: it is allowed to be a sketch, and review reads it as one. A `.claude/rules/*.md` file
is a standing directive that later sessions execute without re-deriving. Moving a sentence between them
changes its evidentiary bar, and nothing in the move enforces the higher bar — the paste looks like
transcription, which is exactly the operation reviewers do not re-check.

Incident (2026-08-06): the dominated-row exemption was drafted comparing reachable *ceilings* and pasted
into `research-probes.md` as a waiver rule — but `observedWeightedMax` compares realized `w × SEV_NUM[sev]`,
so the rule as shipped could waive a replay for a row that can in fact win the argmax.

**The move:** when promoting a derivation from a plan into a rule, re-derive it against the consuming symbol
(read `observedWeightedMax`, not the plan's description of it) and state in the rule which expression it
matches. A rule carrying an inequality owes the name of the function that evaluates it.

**Corollary — a plan rung naming two functions as an EQUALITY can be signature-false, not merely unproven.**
`dialBand(x) === notifyBand(x)` reads as a claim awaiting a test, but the two symbols may not share arity or
return type at all, in which case the rung has no executable form and the verify step will be quietly
reinterpreted into something weaker. Check arity and return type first — `grep -n 'export .*function
<name>\|export const <name>' src/` on both sides — before authoring any rung that asserts, verifies, or
waives such an identity.

## 74 — an option's stated COST and stated BENEFIT are both claims, and both mis-price the ruling

An `AskUserQuestion` option is priced on two numbers a reader cannot check: what it costs and what it buys.
Each fails in its own direction, and each produces a ruling that has to be re-opened.

- **Cost — an option can be unimplementable by construction, because a SECOND guard touches the artifact.**
  2026-08-07: "keep the F9 level mask, relax the guard" was ruled, then collapsed — `assert_velocity_masks_fresh`
  compares each mask to its source's last row, and the emitter had already stopped running, so the kept file
  could never be refreshed. Neither the plan nor the option's stated cost named that guard. **Price an option
  against every guard touching the artifact, not only the one the finding surfaced** — enumerate them by
  grepping the artifact's path, not by recalling the review.
- **Benefit — a stated benefit is only real if it is EXCLUSIVE to the option.** The same round argued "keep
  the CSV so the axis can be re-measured later"; the file was git-tracked, so `git show <sha>:<path>` bought
  that under *every* option, including deletion. A benefit both arms deliver is not a reason to choose one.

**The move:** for each option, name the guard set it must satisfy and ask of each stated benefit "what does
the rejected arm lose?" — if the answer is nothing, delete the clause before the round, not after the ruling.
