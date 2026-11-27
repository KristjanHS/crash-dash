# Claim verification — falsifier, gate, guard, confirmer and control-arm claims

Shard of `docs/claim-verification.md`. **Ordinals are global and permanent** — a shard is a storage
location, not a namespace, so §61 is §61 wherever it lives and the cite form never changes.
Index, preamble and tombstones: `docs/claim-verification.md`. **The admission test — what may be
written here at all — is `.claude/rules/plan-hygiene.md` §Claims**; nothing licenses a write from
inside this file.

## 4. A falsifier you author

Run it over the WHOLE file before the commit claims the class fixed, and re-run it before any later doc entry
lands on top — it binds hardest on the doc-correcting commit, because a test catches RESIDUE, not the artifact.

- **Exclude comment lines** — diff form `^[+-][^+-]`, file form `grep -vE "^[0-9]+:\s*(\*|//)"`. Reword the
  falsifier, never the comment.
- **Scope identifier falsifiers to LIVE surfaces** (`src/`, the cron path), never a repo-wide `docs/` grep — a
  docs grep never goes empty once a symbol has history.
- **…but a falsifier scoped to the DEPLOYED surface says nothing about the OPERATOR shell.** The same scoping
  that keeps a grep honest can cut away the environment the defect actually lives in. A clean prod-log grep
  for a missing-feed-key warning (LEGP Stage 0.1) certified the cron path while the *local* backfill shell — one
  stage later in the same plan — emitted that exact string, because `--env=prod` loads no env file. Prod and
  the operator's terminal are two populations; when a claim is about a command a human will type, run the
  falsifier **in the shell that will type it**, not against the deployment that never does.
- **Binds a REVIEWER-PRESCRIBED red demo too — a finding's suggested mutation is a claim, not an
  instruction.** A reviewer naming the exact line to break has not run it. 2026-08-01: "delete
  `verdictHoldIds: []` from the carried return and the totality test reds" — it does not, because the return
  spreads `{...f}` and `f` already owns the key, so `Object.hasOwn` can never see the drop. Execute the
  prescribed mutation before shipping the fix as though it bit; when it turns out vacuous, pin what the
  branch actually controls (there, the VALUE contract) instead of weakening the test until the demo works.
- **Binds a falsifier or red demo written INTO a plan doc identically** — demo that it CAN fail before the doc
  records it. Unrun, it reads as proof forever. 2026-07-24, twice: a grep that matched legitimate `id: "VIX"`
  rows, and a red demo (zero a `MEMBER_WEIGHT` cell) that the very fix it guarded made unfireable. A red demo
  the plan only *names* stays unverified until the executing session actually reds it. **Check the
  falsifier's POPULATION filter, not just its assertion** — the change it gates can drop the subject out of
  the set the guard iterates, which reads as "no drift" rather than "not monitored" (2026-08-07: F9's
  retirement of its level axis removed it from `levelCutIds()` — which derives its population from the
  presence of level thresholds — so the planned drift-guard fixture (`DRIFT_FIXTURES.F9`) became
  unreachable and the gate became vacuous at the instant it was needed — the guard's own selector, not its
  comparison, was what the change falsified). A falsifier whose membership filter is derived from a property
  the change deletes goes green not because the claim held, but because the subject left the set, and no
  assertion in it is wrong. Before banking
  a falsifier against a REMOVAL, read the membership predicate, not the assertion, and ask whether the
  removal satisfies it. If it does, the falsifier dies with the change — pick one whose population survives
  it (here: an explicit `registry.test.ts` velocity-only pin).
- An **inverted** falsifier (one that must print NOTHING) needs the same demonstration in reverse: make it
  print something on purpose, then restore.
- **A synthetic probe input must carry the BYTE SHAPE a real instance has.** Detectors key on that shape —
  allowlists match by VALUE, regexes by exact encoding — so a hand-built specimen differing in a byte the
  detector reads dodges the entry under test and returns an all-clear indistinguishable from a real one. Two
  in one session: a canonical vendor doc-example key the scanner allowlists by value, and a hand-assembled
  JWT whose `json.dumps` spaces made its header non-canonical, so it missed a repo-wide `jwt` mute entirely.
  Build the specimen the way the real producer does (the library, the real encoder), or assert the probe
  trips a detector rule you can NAME.

**A falsifier that fires on the WRONG PREDICATE returns an all-clear indistinguishable from a real one** — its
silence proves nothing about the defect actually present. This is the single failure recurring at §17 (a
retyped grep that matched nothing), §18 (a grep that never searched the file), §19 (a guard policing
vocabulary, not assertions) and §24; those classes cite this line rather than re-deriving it.

**A red demo can also go red for a reason unrelated to the thing you changed.** The bullets above ask whether a
falsifier *can* fire; this asks the next question — **when it fires, is it firing on the CLAIM?** Two shapes,
both from E7, both green-looking and both empty:

- **Arithmetic coverage is not POPULATION coverage.** E7 4.6 shipped three red demos on `deepLagRhythm` and
  `shouldCorrect` — what the new arm *computes* — and zero on `isExplicitlyRegistered`, which decides *which
  ids reach it*. Emptying `explicitRegistrationIndex()` restored the exact false DEEP-LAG the rung removed and
  left 3068 tests green. A new branch owes a pin on its predicate's population, not only on its arithmetic
  (the repair is `api/lab.test.ts`'s `EXPLICIT_OF` parity test).
- **A discriminating case needs its two inputs to DISAGREE.** E7 3.6 renamed `classify`'s `tierCut` → `cut`
  and recorded the stage falsified — but both `lagRowFor` fixtures passed `cut === LAG_THRESHOLDS[registered]`,
  so argument and tier were indistinguishable and the test could not tell the old code from the new. The
  repair came from the **4.4 review** (`git log --oneline --grep '3.6 a falsifier'`), which authored a
  `lagRowFor` case where the two DO disagree — `registered: "weekly"` (tier 9) with `cut: 11`, age 10 ⇒
  FRESH against the cut, LAG against the tier (`scripts/probe-feed-lag.test.ts`, "classified against the
  CUT ARGUMENT, not the registered tier").
  ⚠ Do not confuse it with 4.7-R2's `{registered: "monthly", cut: 70, p90Gap: 31, age: 100}` case (LAG under
  `max(p90Gap, cut)`, DEEP-LAG under `max(p90Gap, tier)`) — same *shape*, different **axis**: that one separates
  `deepLagRhythm`'s floor inside `classify` and says nothing about 3.6's cut-plumbing. The test file marks the
  split in its own comments. Two fixtures can both make their inputs disagree and still cover different claims.

**The check, for both:** before recording a stage as falsified, name the two hypotheses the test is supposed
to separate and confirm the fixture makes them produce *different* outputs. A stage that only RENAMES a
parameter cannot be falsified by a test of that function at all — the discriminating evidence has to live
where the two values differ.

**A QUOTED red-demo transcript is itself a claim, and it rots the moment the code changes.** A docblock or
plan that pastes the failure output has to paste what *this* file would print: `probe-e6b-overlap.ts` quoted
`not one of the 12 pairs cleared MIN_OBS=…` while its own `GROUPS` yielded 14, so the record could not have
come from the file it lived in (2026-07-30, caught in review). Check a pasted transcript against the code
that produces it — every count, id and threshold in it — or re-run the demo and paste the real stderr; and
prefer a message that *derives* its numbers over one that hand-types them, so the next edit cannot desync it.

**The same binds an ILLUSTRATIVE SAMPLE in a contract or spec doc.** A hand-typed "for example" row is read
as the shape the code emits and gets built against; label it illustrative and it is still a claim, because
nothing downstream distinguishes an example from a specimen. Generate the sample from the code, or check it
field-for-field against the emitter.

Assertion-level mechanics — the mutate-and-confirm-red loop and restoring by re-typing rather than
`git checkout` — are in
`.claude/rules/testing-project.md` §Every new assertion owes a mutate-and-confirm-red demonstration. Edit the twin
when you edit this.

### 4.1 Vacuity cues — the assertion-level mirror of this class

Recognition cues, each from an assertion that shipped green and was caught ONLY by mutating the
production line and confirming THAT assertion's line goes red. The directive stays at
`.claude/rules/testing-project.md` §Every new assertion owes a mutate-and-confirm-red demonstration; the
cues live here.

- **Self-referential expectation** — the pinned figure is derived from the same rows the test reads, so it
  tracks any change to the cut and can never disagree; pin a literal measured out-of-band, or a relation the
  cut's removal breaks.
  ⚠ Its **committed-artifact** form, where the trap is picking the wrong SOURCE rather than the wrong value:
  in a vintage suite BOTH the frozen artifact and a live recompute are in scope, and an assertion about the
  GENERATOR's behaviour written against the artifact compares two artifact-derived values, so no production
  edit can move either side. Pinning the artifact against itself is the correct idiom for reproducibility
  claims and the vacuous one for behaviour claims — route by what the assertion is ABOUT, and red-demo by
  mutating the generator, which is exactly what a same-source pin survives.
  ⚠ Its **shared-predicate** form, where the same-source trap swallows the RED DEMO rather than the
  assertion: single-sourcing a test's expectation to the predicate the engine uses (`isLiveCell`) makes that
  half of the deep-equal tautological, AND makes a demo that mutates the predicate's BODY move both sides at
  once — so the widening it exists to catch reports fewer reds than it causes (OQ-5 Stage 5.3 measured 4;
  mutating the CALL SITES instead reds 7). Mutate where the predicate is CALLED, never its definition, and
  drop any expectation key the import has made incapable of failing.
- **Confounded red demos** — running two mutations in one pass can make the first's *wrong* state the
  *correct* one for the second, so the second assertion passes and reads as vacuous when it is not (enlarging
  `LIMITED_TRANSLATION_D` until no cell binds makes a hardcoded `bounded: false` genuinely right). This is
  sharper than "the runner stops at the first failure": here the intended assertion is REACHED and green.
  Restore between demos, or pick mutations whose expected states cannot overlap.
- **Right value, unscored path** — asserting the *emitted* value leaves the scoring path that produces it
  unchecked, so a passthrough or cached field satisfies it; assert on the scored output.
- **Catch-all branch shadowing** — the fixture lands on a LATER catch-all branch of the function under test,
  so deleting the branch the test *names* leaves the verdict unchanged; check which branch the fixture
  actually reaches before naming one.
- **Parity vacuity** — a parity assertion (`expect(lab.dial).toEqual(cron.dial)`) is vacuous when the fixture
  makes both sides agree for an unrelated reason (`VT: "RED"` fires `volatility` on both reading sets
  regardless of the filter under test), so confirm THAT line fails — a neighbouring
  membership-line failure means the claim never bit — then pin non-vacuity by asserting the fold differs
  under the two tables. It generalizes past parity into §4's *A discriminating case needs its two inputs to
  DISAGREE* above.
- **Arithmetic covered, POPULATION uncovered** — red demos on what a new arm *computes* say nothing about
  *which ids reach it*, so a new branch owes a pin on its predicate's population alongside the ones on its
  arithmetic (incident + repair: §4's *Arithmetic coverage is not POPULATION coverage* above).
- **Suppressor/kill-switch no-op** — a suppressor is a no-op where its target is already off
  (`applyFallShape` on a CALM fixture only rewrites the reason string, passing with the feature disabled);
  pick a fixture that FIRES first (unsuppressed arm reaches `"partial"`), assert the suppressed arm flips
  it, and land the red demo on the state assertion.
- **Convergence vacuity** — when two per-id variants CONVERGE on one value every pin that discriminated them
  goes vacuous at once and a VALUE pin can no longer prove the per-id seam exists, so pin the SEAM by
  *registration* (`Object.hasOwn`) plus an injected table for *routing*, and keep value pins for values.
- **Confirmer vacuity** — a CONFIRMER goes vacuous exactly like a falsifier that can't fail, since a placebo
  shifting only ONE side of a lead comparison prints NOT-ESTABLISHED for real and fake alike; author a
  CAN-establish demo (a synthetic true leader flips it to ESTABLISHED) beside the CAN-fail one.
- **Float round-trip kills an exactly-at-cut fixture** — pinning a `>=` cut needs a fixture landing EXACTLY
  on it, but `cut * threshold` must divide back to `cut` in IEEE-754 or the fixture sits a hair off and
  passes under `>` too — `0.8 * 6.0` → `0.8000000000000002` (useless), while `0.8 * 1.05` and `0.8 * 8`
  round-trip exactly. Pick the threshold that round-trips, assert `expect(atCut / threshold).toBe(cut)` as a
  vacuity guard, and red-demo by flipping `>=` to `>`.
  ⚠ An integer-valued input can make equality **structurally unreachable** (`0.8 * 8 = 6.4`, rungs are
  integers), so no fixture on that row can ever pin the cut direction — move the pin to the pure function.
- **Fixture shorter than the estimator's WINDOW** — a windowed/min-obs estimator returns `undefined` (or a
  degenerate constant) on every row of a fixture shorter than its lookback, so each arm agrees for the one
  reason that has nothing to do with the arithmetic under test. Three σ tests for a new rolling estimator
  passed with `window` larger than the fixture, leaving `a = 0` green across the whole suite (2026-08-08,
  F9). **Any new estimator carrying a `window` / `minObs` owes a fixture that CLEARS the lower bound**, and
  a second one sitting exactly one row BELOW it asserting the no-reading result — otherwise the bound
  itself is untested and the passing arm is vacuous.
- **The demo mutated a DIFFERENT line than the guard's NAME cites** — a guard named for a discrimination
  (same-id restate + `only`) red-demoed by mutating the FILTER, never the VALIDATION the name claims, so it
  shipped green with the named check absent. Mutate the line the NAME cites, not the nearest one that reds.

## 14. A gate you author

It can be unsatisfiable by construction, revealed only once the blocked stage is built. Name the population it
must admit, and check that the cheapest-passing and slowest-cadence members clear it.

**A ruling and a falsifier authored in the SAME round can be mutually unsatisfiable.** One round's "floor
last" ordering reddened the unification pin drafted beside it — each was sound alone. Trace a proposed option
through every pin the same round proposes before offering it: the gate and the thing it gates come from one
pass, so nothing downstream will notice the contradiction.

**A script's DEFAULT invocation is a claim of the same kind.** `probe:is7-diffusion` shipped with a default
sample size its own non-vacuity check could not satisfy, so the documented command aborted out of the box
while the gate itself was sound. Defaults are part of the gate — run the command exactly as written down.

## 21. A guard asserting an OUTCOME DISTRIBUTION inverts once the system gets healthy

`probe:feed-lag`'s `assertNonVacuous` guard (a) demanded a MIXED census — some FRESH, some lagging — on the
theory that a uniform one makes classification vacuous. It passed for months. E7 4.6 (2026-07-26) then
removed three FALSE DEEP-LAGs, every classified prod feed read FRESH, and the guard threw on the exact steady
state the rung was built to produce: its green had been load-bearing on the defect sitting beside it.

**The check:** a guard must assert a **capability of the code**, never a **distribution of the data**. Ask
what the guard reads when the system is perfectly healthy — if the answer is "failure", it is an outcome
guard. The repair is a perturbation: feed the code an input that MUST produce the other label and require
it (E7 4.7-R1 — re-classify each row at `age = deepLagBar + 1` and require DEEP-LAG). That stays green on a healthy
census and reds on a classifier that stopped discriminating.

⚠ **Then check the perturbation's own reach.** 4.7's first draft claimed the new guard also caught an "arm
reordered below FRESH"; it did not — the probe age `bar + 1` exceeds every real id's cut, so the FRESH arm
could never win at that input. **A perturbation covers only the branches its probe input can actually
reach** — derive them, don't assume the mutation you had in mind is among them.

## 28. A "no-move" / byte-identical proof is VACUOUS when its INPUT never moved

D4 (2026-07-26) proved a change behaviour-neutral by capturing output before and after and diffing bytes —
identical, therefore neutral. But the capture ran against the dev DB, whose newest run predates the change by
days and whose contents are frozen (no cron). The input to both arms was the *same stored rows*, so
byte-identity was guaranteed by construction and said nothing about the code.

**The check:** an invariance proof owes a **non-vacuity control in the same run** — one deliberately perturbed
arm that MUST differ. If you cannot make the harness produce a difference, you have not shown invariance, you
have shown the harness is insensitive. Put the control inside the proof, not in a follow-up: a control that
runs later is a control nobody runs. (`scripts/capture-d4-freshness.ts` now exits non-zero when the census
fails to move between arms — that guard is this class's repair, and it is the shape to copy.)

**The dual shape: a pin that no INPUT swap can red.** A measured-zero loop stayed green under either fixture,
because no leg beat the placebo on *either* arm — so the fixtures were free to move while the assertion could
not. Its can-fail demo had to attack the placebo COMPUTATION instead. When swapping a fixture-driven pin's
fixtures cannot red it, the demo moves a layer DOWN (the function the fixtures feed), never sideways to
another fixture.

**The mirror shape: a guard SATISFIED by the artifact it exists to catch.** IS-4's bespoke-flip probe
(2026-07-28) measured leave-one-out over a worst-of family roll-up — a day counted when the family's state
differed with one member removed. Members carry **unequal feed coverage**, so removing the only member with a
reading that day empties the population and the roll-up returns `state: null` rather than a state;
`null !== "GREEN"` scored as a flip. G1 ranked #1 at 632/900 with **zero** real flips — all 632 were "the
family stopped existing", and the pre-registered guard (throw when total flips are 0) passed on exactly those
days, certifying the run while the headline number meant something other than its label. Same failure as the
vacuous control above, inverted: over-satisfiable by construction rather than unsatisfiable. The operating
rule → `testing-project.md` §A guard's vacuity anchor must not certify the thing it exists to catch.

**The third arm: always-red by construction — a falsifier that can never ESTABLISH.** A re-score check diffed
stored values against a fresh recompute expecting zero, but the stored side was scored off persisted closes
while the scorer reads a deeper feed base, so a non-zero delta was guaranteed and no run could ever clear it
(CG arc, 2026-08-08). Before writing an `expect 0`, confirm both arms read the **same base**; where they
cannot, the expectation is a dated allowance SET — the enumerated rows known to skew — never zero.

## 44. An abort ruled for the CONTROL arm can make the INCREMENTAL arm's verdict unreachable

A/B probes in this repo abort when the two arms agree on every close — the dead-control guard
(the `research-probes.md` §control-arm rule, retired 2026-08-07).
That guard is correct for a *control* arm, where
total agreement means the counterfactual no longer describes the shipped change. It is exactly wrong for an
*incremental* arm asking "does removing this one row change anything", because there total agreement **is
the answer** — and the abort fires before the aggregate block and before the JSON write, so the one number
the probe exists to print can only ever appear in the opposite case.

Incident: `--before=brent` returned "zero rank
permutations" as an *inference from an abort message*, not as instrument output, and wrote no JSON — while
the pre-registered bar read "drop the row iff the permutation count is 0". A gate that cannot print its own
PASS. Caught in review, not by the run.

**The move:** when one probe hosts arms with opposite null hypotheses, scope every abort to the arms it was
ruled for, and check that each pre-registered decision rule has a path on which the instrument *prints the
deciding number*. Sibling classes: `plan-hygiene.md` §Claims' "a gate you author owes the population it must
admit" (unsatisfiable by construction) and `testing-project.md` §A guard's vacuity anchor must not
certify the thing it exists to catch (over-satisfiable). This one is neither — the gate is satisfiable, but its
verdict is unobservable.

## 52 — a comparand chosen "far from" the value it must differ from is unsafe when a `min`/`max` folds it back

A non-vacuity arm of the shape `expect(f(WIDE)).not.toBe(f())` needs `WIDE` to produce a different
*effective* input from the default. The instinct is to pick a value far outside the plausible range — the
further out, the safer. **Under a clamping combinator that instinct is exactly inverted.**

Incident (2026-08-03, Rung 4 Stage 2). `pickHeld`'s growth window is `min(deadband, eps)`. The sweep-seam
arm had already collapsed to `x !== x` twice — once when the G2.3 pin moved `GROWTH_EPS` onto the
comparand `RERISK_DEADBAND`, once when the option-E retirement moved it onto the comparand `0`. The fix
reached for `RERISK_DEADBAND * 2`, reasoning that it "exceeds every width the tiebreak can ship at, since
`min` caps the window at the deadband". The cap is what makes the wide end **unsafe**: the board is
falling, so the active deadband *is* `RERISK_DEADBAND`, and every `eps >= RERISK_DEADBAND` — including the
value shipped 24 hours earlier, the obvious re-arm — folds onto the identical window. The third collapse
was already written into the file, in the comment authored to prevent it.

**The move:** identify the combinator between the comparand and the behaviour (`min`, `max`, `clamp`, a
saturating cast, a bucketing round), and place the comparand where that combinator is the IDENTITY —
strictly inside the open interval it does not fold, never at or past the saturating end. Then add a
coincidence guard (`expect(WIDE).not.toBe(SHIPPED)`) as the durable half: prose reasoning about which
values are reachable rots at the next retune, an executable guard reds instead. Discharge by mutating the
constant to the most likely future value and confirming the arm still SEPARATES — the pins that are
*designed* to red on that mutation are not evidence about this one.

**Corollary — the sibling trap in §56's arc:** the *other* candidate control, zeroing the
`SIGNAL_HOLD_CLOSES` constant, was also not identity — `buildMemberStateHeldAt` floors its window at
`Math.max(hold, 1)`, so a zeroed map still reads one close of history and can resurrect a member the live
panel lacks. **A constant set to its "off" value is only an off switch if no `max`/`clamp` downstream
re-floors it** — check the consumer, not the constant.

Sibling classes: §4.1 (vacuity cues) and `plan-hygiene.md` §Claims (a gate can be unsatisfiable by
construction — this is the same defect one level down, at a single assertion).

## 56 — a control arm built by NULLING an argument measures everything that argument gates

The natural way to build an A/B control for a new behaviour is to null the input the behaviour reads. It is
only a valid control if that input gates *nothing else*. 2026-08-04, Stage 2.2 of the timing-hold arc was
about to use `computeField(..., cissHistory = undefined)` as the "before the signal hold" arm — but inside
`computeField` that same argument ALSO selects `superGroupDangerCiss` vs `superGroupDangerJ` for every pillar
and supplies the regime-confirmation walk's window. The arm would have measured the CISS pillar form and the
hold together, and the resulting 9-leg table would have been banked as "the hold alone".

Nothing about the call site shows this: the argument's *name* describes the data, not its fan-out.

**The move:** before nulling an argument to build a control, **grep that parameter's name inside the callee
body and count the distinct decisions it feeds**. More than one ⇒ it is not a control, it is a bundle. The
fix is a dedicated seam that forces exactly the branch under test (here the `ProbeArms.probeHoldOff` arm,
reachable only through `computeFieldProbe` and not expressible on the production `computeField` signature,
which flips only the `holdOn` gate and leaves `cissHistory` flowing) — an exact control by construction
rather than by hope.

Related: the retired `research-probes.md` §"An A/B probe's CONTROL arm must be reimplemented
in-probe" (2026-08-07), whose
frozen-literal rule assumes the arm *can* be expressed as a literal; a seam arm freezes nothing and therefore
carries no re-pin duty — say so at the arm, or a later reader will add one.

## 63 — a falsifier grep banked in a docblock can be UNPASTEABLE, and the safe spelling is not the obvious one

Banking a grep falsifier beside the claim it guards (§59's remedy, and the standing habit here) means pasting
regex source into a TS block comment. Two character sequences make that paste destructive rather than
merely wrong, and both are ordinary regex spellings:

- the block-comment **terminator** anywhere in the pattern ends the comment early — every line after it is
  parsed as code and `tsc` fails with dozens of errors far from the edit;
- a **negated character class over the two comment characters** has two semantically identical spellings and
  only one is paste-safe: written with the slash first it is inert inside the comment, written with the star
  first it reproduces the terminator and does the same damage.

The trap is recursive, which is what makes it worth a class of its own: a prose note *warning* about the bad
form reproduces it while describing it, so the warning breaks the file the same way the regex would.

**The move:** bracket every delimiter character in a banked pattern (`[/][/]`, `[*][/]`), write the negated
class slash-first, and **describe the hazardous form in words rather than quoting it**. Then `tsc --noEmit`
before committing — a comment terminated early is a compile error, never a silent wrong answer, so the gate
catches it if you run it. Sibling classes: §59 (the falsifier's SCOPE) and §17/§54 (a regex wrong on its own
terms); this one is about its TRANSCRIPTION.

Incident (2026-08-05): the star-then-slash spelling
broke `scripts/probe-leg-ordering.ts` with ~60 parse errors, then bit a second time in the same edit inside
the note added to warn about it.

## 64 — a confirmer bar picked by INTUITION about proportions is red on a clean tree

A negative assertion (nothing matches X) needs a confirmer establishing the scan still sees real content,
or an over-eager filter satisfies it by returning nothing. The tempting confirmer is a **ratio** — "code is
at least N% of the file", "comments are a minority" — because it is one line and feels self-evident. It is
a guess about a proportion nobody measured, and it fails in the direction that costs most: RED on a tree
where nothing is wrong, indistinguishable from a real regression until someone reads the assertion.

**The move:** confirm with **anchors, not proportions** — a handful of known-present strings spread across
the file (head, middle, tail), so an over-eager filter that ate any region fails there rather than
satisfying the negatives. Anchors also survive prose edits that move every ratio. If a proportion really is
the only available confirmer, MEASURE it first and pin the measurement to a named commit (§63's sibling
discipline for counts), never pick the bar by intuition.

Incident (2026-08-05, ruling 15): `probe-leg-ordering.structure.test.ts` (deleted)'s first draft asserted
`code > 0.4 x source` and went red immediately — the probe is 32_284 non-whitespace code chars of 97_255,
i.e. two thirds comments, which is simply what a heavily-documented probe looks like.

## 65 — a pre-registered GUARD SET is not uniform: each guard stops the arc only if every verdict shares its denominator

A decision rule with several guards invites reading them as one class — "any guard fires ⇒ NULL, so any guard
firing means stop building." That is a claim about **denominators**, not about the guard list, and it is false
whenever the doc carries more than one verdict.

Test each guard separately: *which verdicts does this guard's quantity appear under?* A guard on a quantity
that every verdict divides by is a genuine stop — nothing downstream is defined without it. A guard on a
quantity only ONE verdict reads kills that verdict alone, and stopping there silently abandons the others.

Incident (2026-08-05, the F1/F2 leg-structure probe): its decision rule carried two guards — fewer
than 60 union fire days, and fewer than 20 separating closes — and an earlier ruling had made the first an
early stop at Stage 2. Extending that to the second by symmetry would have stopped the arc at Stage 4. But
union fire days is the denominator under BOTH the D-verdict and the §5.4 F2-survival sub-verdict, while
separating closes is read only by the D-verdict: the F2 sub-verdict is `f2Unique ÷ F2 union fire days` and
never touches it. Stopping on the second guard would have shipped a D-`NULL` while abandoning the F2 question
the fork doc's §5.4 ruling ordered measured in that same run. The two guards were split by ruling
(§Stage-gating rulings, rulings A and B) and the plan now states that a guard-`NULL` and a clause-`NULL` are
different findings implying different next moves.

**The move:** when a plan names a guard, record its BUILD consequence beside its verdict consequence, and
derive that consequence from the guard's denominator rather than from its neighbours in the list.

## 73 → merged into §4

## 77 → merged into §48
