# Claim verification — the full taxonomy

L3 reference for `.claude/rules/plan-hygiene.md` §Claims. **Not path-gated** — reached only from that
pointer and the `CLAUDE.md` rules table, so neither this index nor the incident detail in its shards is ever
injected into a session that didn't ask for it.

Everything you write down is a claim. Each class below names the **verification move** that falsifies it.

⛔ **A class is minted here only when the user asks for it** (`.claude/rules/plan-hygiene.md` §Claims).
An unasked lesson goes to the commit message. Nothing licenses a write from inside this file.

**Class numbers are permanent ids** — never renumbered; a merged class leaves a tombstone in place
(see `## 23`, `## 32` and `## 39` below). A **retired** class leaves one too, naming its replacement pin:
`## N → retired, pinned by <test>`. `scripts/check-claim-index.test.ts` fails if any ordinal stops resolving;
the every-extension repoint sweep → `.claude/rules/plan-hygiene.md` §Deleting a SECTION HEADING.

**This file is the INDEX; the class bodies live in shards under `docs/claim-verification/`.** A shard is a
storage location, **not a namespace** — ordinals stay global and permanent, so §61 is §61 wherever it lives
and the cite form (`docs/claim-verification.md` §61) does not change. Each line below names its shard; open
one shard only when this index shows a plausible collision with what you are about to write.

| shard (`docs/claim-verification/`) | seam |
|---|---|
| `grep-and-sweep.md` | the search itself — does the grep/sweep/cite-repoint reach the population it claims? |
| `coverage-and-tests.md` | what a test suite, a mock surface or a green run does and does not prove |
| `falsifiers-and-controls.md` | an instrument you author — can it fire, establish, or is it vacuous by construction? |
| `measurements.md` | a number: what question it answers, what population it ran over, how it rots |
| `decisions-and-records.md` | rulings, premises, options, baselines, plans and the durability of a record |
| `code-and-copy-surfaces.md` | claims about what the code, its consumers, the DB or user-facing copy actually do |

## 1 — Cite by SYMBOL; a constant CHANGE — or a CORRECTED claim — owes a symbol-grep across every live surface → `grep-and-sweep.md`
## 2 — Coverage claims: the named test, the absent pin, the derived inventory → `coverage-and-tests.md`
## 3 — Every element of a plan is a claim — even SAME-DAY → `decisions-and-records.md`
## 4 — A falsifier you author (incl. §4.1 vacuity cues) → `falsifiers-and-controls.md`
## 5 — A recorded SHA → `decisions-and-records.md`
## 6 — An "X is untouched" claim → `code-and-copy-surfaces.md`
## 7 — A "no-op / byte-identical / zero-change" deliverable → `code-and-copy-surfaces.md`
## 8 — The INVERSE claim: "this changes what the user sees" → `code-and-copy-surfaces.md`
## 9 — An audit / review finding → `decisions-and-records.md`
## 10 — A cycle claim → `code-and-copy-surfaces.md`
## 11 — A `[USER]` verdict's stated PREMISE — and a RULE's stated MECHANISM → `decisions-and-records.md`
## 12 — A migration-state POINTER → `measurements.md`
## 13 — A design's "won't break X" / "family-agnostic" claim → `code-and-copy-surfaces.md`
## 14 — A gate you author → `falsifiers-and-controls.md`
## 15 — A backlog's ORDERING → `decisions-and-records.md`
## 16 — The cite rule binds CODE, not just prose → `grep-and-sweep.md`
## 17 — Deleting a SECTION HEADING dangles refs exactly like deleting a file → `grep-and-sweep.md`
## 18 — A file-wide grep can SILENTLY SKIP a source file it classifies as binary → `grep-and-sweep.md`
## 19 — Copy with TWO consumers may assert nothing about WHERE things render → `code-and-copy-surfaces.md`
## 20 — A verdict recorded ONLY in a commit message is not durable → `decisions-and-records.md`
## 21 — A guard asserting an OUTCOME DISTRIBUTION inverts once the system gets healthy → `falsifiers-and-controls.md`
## 22 — An "every surface" sweep that lists directories will miss the PUBLISHED CONTRACT → `grep-and-sweep.md`

## 23 → merged into §4

"A red demo can go red for a reason unrelated to the thing you changed" — its own draft opened *"§4 asks
whether a falsifier can fire; this class is the next question"*, which is the merge signal, not a
cross-reference. Absorbed 2026-07-26. Tombstones stay.

## 24 — "Doc-only, therefore zero risk" is itself a claim, and it disarms the checks → `code-and-copy-surfaces.md`
## 25 — A confident measurement that answers a DIFFERENT question than the one asked → `measurements.md`
## 26 — An "X and Y can never both happen" invariant may be a PRECEDENCE outcome → `code-and-copy-surfaces.md`
## 27 — A plan's own confirmer can be UNHONOURABLE by the time you reach it → `decisions-and-records.md`
## 28 — A "no-move" / byte-identical proof is VACUOUS when its INPUT never moved → `falsifiers-and-controls.md`
## 29 — A plan step naming N consuming surfaces owes a per-surface check that each READS the thing → `code-and-copy-surfaces.md`
## 30 — "The suite stayed green, so the hoist was behaviour-preserving" covers only VERBATIM moves → `coverage-and-tests.md`
## 31 — A BANKED design list can silently drop a requirement its own plan already RULED → `decisions-and-records.md`
## 32 → merged into §25
## 33 — A refusal whose stated COST names a dependency rots when that dependency changes → `decisions-and-records.md`
## 34 — "Pre-existing at HEAD, therefore not mine" is a claim about the WRONG baseline → `coverage-and-tests.md`
## 35 — A PRODUCER-side proof says nothing about the PERSISTED value a reader serves → `code-and-copy-surfaces.md`
## 36 — A per-side identity property does NOT survive ASYMMETRIC inputs → `code-and-copy-surfaces.md`
## 37 — A test suite's mock surface is a per-file WHITELIST; a new import silently un-mocks → `coverage-and-tests.md`
## 38 — A "floor" measured through a window that serves the NEWEST N rows is not a floor → `code-and-copy-surfaces.md`

## 39 → merged into §35

"A PERSISTED verdict and a LIVE recomputation of it are two different computations" — its own draft declared
itself the generalization of §35, which is the merge signal, not a cross-reference. Absorbed 2026-08-01; its
serving half (a recomputed panel beside a persisted verdict owes an on-screen marker for deliberate
live-only flips) is a design rule and moved to `.claude/rules/frontend.md`. Tombstones stay.

## 40 — Setting a framework config option is a CLAIM that it took effect — measure the EFFECT → `measurements.md`
## 41 → merged into §78
## 42 — A recorded numeric BASELINE can be a misread of an adjacent cell — reproduce the command → `measurements.md`
## 43 — A test anchored on "whichever cell happens to be vintage-absent" re-breaks on every seating → `coverage-and-tests.md`
## 44 — An abort ruled for the CONTROL arm can make the INCREMENTAL arm's verdict unreachable → `falsifiers-and-controls.md`
## 45 — A "sweep the derived claims" duty must enumerate EVERY table derived from the one you edited → `grep-and-sweep.md`
## 46 — A CAPTURED command output is not a rot carrier: date-mark it, never re-number it → `measurements.md`
## 47 — "An X fold absorbed it" owes a check of WHICH fold, at that layer → `measurements.md`
## 48 — A comment that LABELS itself a claim still rots; only a derivation or a test stops it → `code-and-copy-surfaces.md`
## 49 — An EPISODE-level Δ of 0 does not license "the mechanism is inert" → `measurements.md`
## 50 — An option you offer a decider is a claim, and a rank statistic erases most distinctions → `decisions-and-records.md`
## 51 — A universal quantifier in prose must be checked against every row of the table above it → `measurements.md`
## 52 — A comparand chosen "far from" its value is unsafe when a `min`/`max` folds it back → `falsifiers-and-controls.md`
## 53 — "Reviewed and clean" is a claim about a COMMIT SET, and the range you cite is not that set → `decisions-and-records.md`
## 54 — A sweep regex blind to the citation form its own rule prescribes reports a false all-clear → `grep-and-sweep.md`
## 55 — A plan's own ledger of its leftovers is not the POPULATION of its defects → `grep-and-sweep.md`
## 56 — A control arm built by NULLING an argument measures everything that argument gates → `falsifiers-and-controls.md`
## 57 — A doc that states its own evidentiary limit, then writes a conclusion exceeding it → `measurements.md`
## 58 — A candidate failing two bars must record BOTH; the softer verdict mis-directs the successor → `decisions-and-records.md`
## 59 — A LINE-ANCHORED two-stage grep is not a file-wide falsifier; it goes green on a reflow → `grep-and-sweep.md`
## 60 — A ROSTER SIZE is structural, so it can never be evidence that an OBSERVATION census moved → `measurements.md`
## 61 — A source cited for a SUPPORTING line is also ruling on the question you are deciding → `decisions-and-records.md`
## 62 → merged into §27
## 63 — A falsifier grep banked in a docblock can be UNPASTEABLE; the safe spelling is not the obvious one → `falsifiers-and-controls.md`
## 64 — A confirmer bar picked by INTUITION about proportions is red on a clean tree → `falsifiers-and-controls.md`
## 65 — A pre-registered GUARD SET is not uniform: each guard stops the arc only if verdicts share its denominator → `falsifiers-and-controls.md`
## 66 — One quantity named through two different populations is a silent scope bug → `measurements.md`
## 67 — A combine-mode flip can make an EXISTING fixture unreachable, and the suite stays green → `coverage-and-tests.md`
## 68 — A pre-registered "we will not measure this" is itself falsifiable, and the suite falsifies it → `coverage-and-tests.md`
## 69 — A NEW TABLE is as additive as a new leg, so pin the RESOLVER'S OUTPUT, not a table's identity → `coverage-and-tests.md`
## 70 — An algebraic claim drafted in a plan and pasted into a RULE ships unverified by construction → `decisions-and-records.md`
## 71 → merged into §22
## 72 — Deleting a DISCRIMINATOR silently un-tests every assertion built on it, suite stays green → `coverage-and-tests.md`
## 73 → merged into §4
## 74 — An option's stated COST and stated BENEFIT are both claims, and both mis-price the ruling → `decisions-and-records.md`
## 78 — An ANCHOR TOKEN is not the population: a name/ID grep cannot see what is spelled or phrased otherwise → `grep-and-sweep.md`

## 75 → merged into §72

## 76 → merged into §48

"A display FORMATTER is a claim about the value it renders" — minted 2026-08-08, absorbed into §48 the same
day because its own body closed "Sibling of §48", which is the merge signal. Tombstones stay.

## 77 → merged into §48
