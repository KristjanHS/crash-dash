# Claim verification — measurement and number claims

Shard of `docs/claim-verification.md`. **Ordinals are global and permanent** — a shard is a storage
location, not a namespace, so §61 is §61 wherever it lives and the cite form never changes.
Index, preamble and tombstones: `docs/claim-verification.md`. **The admission test — what may be
written here at all — is `.claude/rules/plan-hygiene.md` §Claims**; nothing licenses a write from
inside this file.

## 12. A migration-state POINTER

Verify columns via `information_schema.columns` on the LIVE DB, not the pointer prose. One read claimed "dev
missing `fall_shape` + `dial_state`"; DB truth was only `fall_shape` missing.

## 25. A confident measurement that answers a DIFFERENT question than the one asked

The most expensive shape in this file, because the number is real and the arithmetic is right. NF-4(i) was
ruled correct, then killed on a `medianGap`/`p90Gap` census, then re-instated on E7 §Stage 1.4's finding that
those statistics measure **observation spacing** and are structurally blind to **release cadence** — a verdict
that flipped twice in one day, in opposite directions, each time on evidence. ⚠ **The second flip was a read
failure, not a new discovery:** §Stage 1.4 landed ~27 minutes BEFORE the kill, so the evidence that overturned
it already existed when it was written. A refuting measurement sitting in the repo is not the same as a
refutation anyone applied. H.10 releases Mondays covering the
previous business week (9d structural max) and EIA oil Wednesdays; our store matched FRED upstream exactly,
so the "rot" was a correct measurement of the wrong quantity.

**The check:** before a measurement settles anything, restate the question it actually answers and compare it
word-for-word to the question asked. For a feed, that means classifying it against its own **published
release schedule** — never against the ages we happened to observe, which is the same anti-pattern as
widening a threshold to silence a signal, wearing a statistic's clothes. "Measured, therefore settled" is a
claim about *relevance*, and relevance is the one thing a p90 cannot report on itself.

**A MECHANISM claim is a different sentence from the metric beside it, and owes its own measured column.**
"The 264-close hold was ended by the ratchet, not by conditions clearing" travelled with a correct
days-in-cash figure and was structurally impossible: the ratchet branch sits *inside* the exit-fired branch
(`src/r4.ts`), so `R4_RATCHET_DAYS` can only pick snap-to-equity over laddered re-entry — it can never END a
hold. A `countRatchetExits`-style tally certifies *how* an episode exited; nothing in it reports *why the
hold lasted*. Before a "X caused Y" sentence ships beside a measurement, either add the column that
distinguishes the causes (here: the exit reason per episode) or delete the causal clause — a right number
does not license the story told next to it, and the story is what a user rules on.

⚠ **And the blast radius is the whole CHAIN, not the one doc.** The same statistic had already propagated into
two committed plan docs and one shipped registry edit before anything touched ground truth. Every artefact in
that chain was internally consistent and each cited the one before it — so "three docs agree" was one claim
repeated, not three. The overturning check was a single read of the upstream `fredgraph.csv`; the propagation
took days. When a doc cites another doc for a number, treat the citation as **unverified** until you find the
artefact that actually touched the source — and verify a measurement against the thing it purports to
describe, never against the pipeline that produced it.

⚠ **An outage finding names an AUTH PATH, not a host.** A keyless CSV endpoint timing out (curl 000 at 40s)
became "FRED is down" and nearly parked a whole ruling — while the KEYED API, already the code's primary,
served in ~0.5s. Scope every reachability claim to the exact endpoint *and credential path* it was observed
on; "the provider is down" is a different, much larger claim than the one the probe made. A host-ROOT 200 is
not a probe of the data endpoint.

⚠ **A row-COUNT anchor names a QUANTITY, not a number.** Raw upstream timestamps and parsed non-null rows are
different quantities, so a small delta against a recorded count is a reconciliation to record, not a STOP.
Write the quantity beside the count, or the next reader reads ordinary parsing drift as data loss.

⚠ **A firing RATE owes its coverage denominator — a dark input divided by the full window reads as
"not firing".** The E8 r4 audit (2026-07-30/08-01) computed per-member and breadth rates over a fixed
1500-close window while some members' stored spans started years inside it, and did it **twice**, once
retracting an already-published 6/61 figure. The arithmetic was right both times; the denominator was a
different population from the numerator. Print each input's stored span and dark-close count **beside**
every rate, and report a member with no coverage as **dark**, never as a zero — a rate whose numerator
cannot be non-zero over part of its denominator is not a measurement of behaviour. Its non-vacuity
sibling is §28: also throw if a per-member count is constant across the whole window.

## 40. Setting a framework config option is a CLAIM that it took effect — measure the EFFECT, not the presence

**Incident (2026-08-01).** Vitest 2's `isolate` and `fileParallelism` resolve from the **root** config or
the CLI only (`fileParallelism` is a declared `NonProjectOption`; `isolate` is dropped per project without
being one — and `pool`, which looks identical, is honoured). Set inside a `vitest.workspace.ts` project they
are accepted by the type system, accepted by the runner, and **silently dropped** — one such key shipped as a no-op performance
"optimization", and the same mistake then removed the serial guard protecting DB truncation, the config
reading correctly in the diff both times.

**Why every ordinary gate misses it.** The types check. The runner starts. The suite is green. A diff review
sees the key spelled correctly, in a plausible file, with a plausible value. Nothing in the toolchain
distinguishes "honoured" from "parsed and ignored" — the failure mode of a scope mismatch is silence.

**The verification move: assert on a consequence the option would have, never on the option's presence.**
`pool: "threads"` ⇒ measure wall-clock or count workers. `isolate: false` ⇒ measure it. `fileParallelism:
false` ⇒ assert two files that must not overlap in fact do not. Pick a consequence that is *cheap and
mechanical* — a stopwatch settles a pool/isolation claim, and a standing assertion is the only thing that
closes the safety one.

**Corollary — a silently-dropped option can be a SAFETY property, not just a performance knob.** Triage by
what the option was protecting, not by how it was framed: the "performance" key and the "serial DB guard"
key were the same key.

**Version-scoped, and the scope itself needs re-measuring.** The 2026-08-08 Vitest 2 → 4 upgrade (a dev-only
`npm audit` fix) deleted `vitest.workspace.ts` outright — projects now live in `vitest.config.ts`'s
`test.projects` — and per-project `isolate` IS honoured there: measured, `--project=shared` runs in 4.6s and
the same run with `--isolate` in 10.2s. `fileParallelism` is still root-only. So the dropped-option incident
below is history, not current behaviour; what survives is the move, which is also how the new claim was
settled — a stopwatch, not a reading of the config.

Nearest sibling: §14 (a gate you author can be unsatisfiable by construction) — same silence, one layer down:
there the gate admits nothing, here the gate was never installed.

## 42. A recorded numeric BASELINE can be a misread of an adjacent cell — reproduce the command before using it as the BEFORE arm

`project_state` and the defensive-leg EW-inversion plan both carried a 9-leg ordering baseline at
`--asOf=2026-07-31` reading `EU-Fin .036`. Re-running the recorded command
(`npx tsx scripts/probe-leg-ordering.ts --env=prod --asOf=2026-07-31`) returns **`EU-Fin 0.0079`** — rank 1,
the calmest leg. The `.036` is traceable to the parent plan's §1 table, where it is the **`Staples` SN**
cell: a row/column misread when the baseline was transcribed. `Value .025` matched exactly, which is what
made the row look sound.

The failure mode is specific and not covered by `plan-hygiene.md` §Claims' "recorded SHA" or "audit finding" classes: a
baseline is transcribed from a *table*, so a one-cell offset produces a plausible number in a plausible
range, and every later comparison against it is silently wrong in a direction nobody can predict. A drifting
baseline (prod DATA revisions — the standing warning) and a *misread* baseline present identically.

**Rule.** A recorded baseline is a claim about a command's output, so it owes that command. Before any
before/after arm is measured against it, **re-run the recorded command and confirm the recorded row
reproduces**. If it does not, the baseline is void — take a fresh BEFORE arm in the same sitting as the
AFTER, and do not "reconcile" the two. Corollary for the write side: transcribe a baseline row by naming its
column headers alongside the values, so a later reader can detect an offset without re-running anything.

Nearest sibling: `plan-hygiene.md` §Claims' "an audit or review finding is true at capture only" — there the world moved;
here the record was never right.

## 46 — a CAPTURED command output is not a rot carrier: date-mark it, never re-number it

A vintage move rots every prose copy of the old value, and the sweep that fixes them will happily walk into
a pasted command output — a fenced block introduced by the command that produced it. Rewriting the numbers
there is not a fix, it is a fabrication: the block then asserts that the named command printed rows it never
printed, and the reader loses the one artifact that could adjudicate the change. Worse, such a block is
usually the *evidence* for the surrounding argument, and the new vintage frequently cannot reproduce it at
all — a 6-row capture cannot be re-derived once the roster is 3.

**The move:** classify each carrier before editing. A **present-tense claim** ("shipped ŵ = X") gets the new
value. A **past-tense narrative** ("moved 0.7604 → 0.7109") keeps the move and gains the current value —
readers take the last number they see as current, which is how three arms once propagated a wrong ŵ off a
stale code comment. A **captured output** stays byte-verbatim and gains a dated superseded-by header naming
the current values and where to read them. The same reasoning governs a frozen control-arm literal in a
probe docblock: when the arc it belongs to has closed, freeze it as a dated record rather than committing to
re-pin it on every future vintage.

**The repair is a carrier too.** A pass that refreshed one stale cell of a hand-typed table stamped the whole
table with the repair date while a *different* cell stayed stale — so a fresh date now vouched for an old
number, and the next reader had no cue to re-check. A date stamp is a claim about **every** cell beneath it:
re-derive the full table from its source, or date-mark only the cells you actually re-derived.

**Corollary — a measured figure is pinned to the PARAMETER ARM that produced it, not only to its vintage.** A
docblock quoting a fire-rate or episode count for a tuned estimator is unreproducible the moment any knob in
that arm moves, and the move is silent: nothing in the retune commit touches the docblock. Cite the
provenance row that names the arm, never the number; when a knob moves, grep every digit-bearing line under
the affected symbol (`grep -rn '[0-9]' --include=*.ts` scoped to the estimator's files, comment lines
included) and re-point each hit rather than re-numbering it.

## 47 — "an X fold absorbed it" owes a check of WHICH fold, at that layer

**Class:** a mechanism claim naming an aggregation seam. **Cue:** the sentence explains why a measured
change did *not* propagate, and the explanation rests on the shape of a fold (a max, a sum, a mean).

A max and a normalized weighted form fail in opposite directions, and a system usually has BOTH at different
layers. In crash-dash, `combineLegDanger` is a max **across pillars**, `danger-ladder.ts` rule 2 is a max
**within a family over its members**, and two *families* co-contribute to one pillar through `cissForm`'s
weight-normalized quadratic form — no max anywhere on that path. Writing "the max fold absorbed the rise"
about two families (2026-08-02, the Stage A′ drop ruling) therefore named a seam that does not exist: the
rise DID reach the pillar and was simply outweighed.

The measured conclusion survived, but the **re-open trigger derived from the wrong mechanism did not** — it
told a future reader to watch for a term "dominating a max fold" that nothing computes, so the trigger was
unobservable from birth and would have silently never fired. That is the real cost of this class: a
mis-named fold produces a *check* nobody can run, which reads as a satisfied guard forever
(`~/.claude/references/anti-patterns-common-rationalizations.md` §Verification Anti-Pattern's shape, arrived at from the mechanism side).

**The move:** before writing "the fold absorbed it", name the two operands and trace which function combines
*those two specific things* — not the one whose name matches the concept. Then cross-check against the
arithmetic: a max over {a, b} returns one of them exactly, so a net that equals neither operand's Δ is proof
the fold is not a max. Here Staples moved −0.066 against operands of −0.119 and +0.027 — arithmetic that
refutes the max reading without reading any code at all.

## 49 — an EPISODE-level Δ of 0 does not license "the mechanism is inert"

**Class:** a null result reported at a coarser grain than the mechanism operates at. **Cue:** a summary
statistic reduces over a dimension, comes out identical under two variants, and the prose upgrades that to a
statement about the underlying mechanism.

Measuring `gp` solo-lead co-sign under two definitions — seat-scoped (a co-signer counts only where
`MEMBER_WEIGHT[member][leg] > 0`) and market-wide (seat ignored) — returned **Δ 0 episodes, Δ 0.0% at K=3**.
The write-up (and its commit message, immutable and standing uncorrected) concluded *"no close had
only those lit … seating does not bite here"*. The review pass replayed the same 293 closes at the **flag**
level and refuted it: on **2026-04-09 the only lit co-signer was `EU2`**, seated on six legs and zero-weight
on `S&P 500` / `S&P IT` / `EM`, so the two definitions disagreed on **3 close × leg cells**. Seating bit. It
simply did not move any episode's *first* co-sign latency — the only quantity the episode-level summary
reduces over — so that summary collapsed to Δ 0 **by construction**.

The cost is not the number, which survived. It is that "the mechanism is inert" would have licensed treating
the two definitions as interchangeable in later stages, including after the open `EU2`/`EHY` re-seating
follow-up lands — precisely the change that would widen the gap.

**The move:** before reading a Δ 0 as "no mechanism", name the dimension the statistic **reduced over** and
ask whether the mechanism could act entirely inside it. If it could, the null is untested there: re-measure
one grain finer (flag level, cell level, per close) before writing any sentence about the mechanism. Report
the finer measurement even when it agrees — "the two definitions disagreed on 1 of 293 closes and it did not
propagate" is strictly stronger evidence than "they are the same", and unlike it, checkable.

## 51 — a universal quantifier in prose must be checked against every row of the table directly above it

Rung 4's §M2 summary paragraph said the folded value's mean rho "is smaller in magnitude than any single
term's **at either horizon**." The 60d row supports it. The 20d row does not: `mom` is −0.0068 against the
fold's −0.0090. The table two lines above the sentence contained its own counterexample, and the paragraph
shipped through a code review and a seven-finding fix pass.

The sentence was written while reading one horizon and then generalised to both — the failure mode is
scanning for confirmation across a dimension rather than enumerating it. `tsc` and the suite cannot see it
(§4 territory: the instruments validate the code around a measured claim, never the claim), and neither can
re-reading it in the context that wrote it.

**The move:** any prose quantifier over a dimension the adjacent table enumerates — *every*, *any*, *all*,
*at either*, *none of* — owes a per-row check against that table before the sentence is committed, and the
check is mechanical, not a re-read. When the quantifier ranges over more than three rows, weaken it to the
claim you actually verified rather than widening the check. Cheapest discharge: state the bound the weakest
row supports ("never *larger* than the best single term") instead of the extremum you eyeballed on one row.

**Same shape without a quantifier: quoting ONE cell of a PARTITION as the aggregate's bound.** When the
table enumerates mutually exclusive outcome bands and the claim is about a UNION over them, the sibling
rows are not context — they are addends, and omitting one inverts the direction of the conclusion.
2026-08-08: an F13 duty-cycle table's Amber 42.6% was quoted as the OR-fold's floor ("≳42.6%") while the
adjacent Red 29.4% feeds the same fold; the true figure is ~72%, and the arc was mis-described as a small
frequency change. **The move:** before quoting a band off a partition, name which rows the aggregate
consumes and sum them — a rate read off a partition owes its denominator AND its sibling numerators.

## 57 — a doc that states its own evidentiary limit, then writes a conclusion exceeding it

The limit is recorded honestly and in good faith, and it does not travel with the conclusion. A plan's banked
search evidence read: "the standard specification includes the aggregate market return as a regressor (Ready
**explicitly**)" — and, three lines below, "**honest limit: abstracts were read, not the coefficient
tables**." The first sentence is a claim about a regression specification; an abstract cannot support it. The
sweep the plan then aimed at that premise found it false on the very first source checked (Ready's table note
reads "univariate regressions"), which had mis-aimed the entire arc.

**The move:** a stated limit must be enforced on each conclusion *individually*, not parked in a sibling
paragraph. When you write the limit, immediately downgrade every claim it undercuts — "the specification
**appears** to control for the market (abstract only, unverified)" — because a later reader takes the
confident sentence and never re-reads the caveat. A caveat placed *near* an over-claim does not bound it.

## 60 — a ROSTER SIZE is a structural constant, so it can never be evidence that an OBSERVATION census moved

Per-family member counts, handler counts, table row counts and the like come from a static table. A change
that gates, filters or drops *observations* cannot move them by construction — so quoting them as
"census UNCHANGED" is a guard incapable of failing, dressed as a measurement. A member-state gate shipped
with `probe:core9`'s per-family dial counts cited as proof the census held, while the same commit correctly
described the REAL move two paragraphs later (a gated member goes `lag` → `absent`) — the two statements
contradict each other and only the roster line was labelled evidence.

**The move:** before quoting a number as census evidence, ask what INPUT would have to change for it to
move. If the answer is "the roster/table", it measures structure, not observation — quote the
observation-side counter instead (`censusOf`, the `absent`/`lag`/`fresh` split, the served coverage
denominator) and state its delta, including when the delta is zero. Sibling of §28 (a guard satisfied by
the artifact it exists to catch) and §40 (presence is not effect).

## 66 — one quantity named through two different populations reads as consistent prose and is a silent scope bug

A decision rule states its population once in an opening line and again where each input is sourced. Both
sentences are English, neither contradicts the other on its face, and a reader checking "is the population
stated?" answers yes. They can still denote different sets — and nothing in the doc, the types, or the tests
sees it, because a population is a *set*, not a symbol a checker can compare.

Test it by **counting the members of each named population and comparing the two numbers**, not by re-reading
the two sentences for agreement.

Incident (2026-08-05, the F1/F2 leg-structure probe): its decision rule opened "measured per id over
the co-covered prod window" while sourcing all four inputs "from Stage 2" — but Stage 2 is full-series per id
(774 and 773 scored days) and the co-covered intersection is 734 days, a population that does not even exist
per id. The two phrasings sat one line apart through a spec review that fixed fourteen other defects; only
putting the scored-day counts side by side surfaced it.

**The move:** when a quantity's population is named more than once in a doc, resolve each name to a count
before shipping the rule, and delete the redundant naming rather than reconciling the wording.
