# Claim verification — coverage and test-suite claims

Shard of `docs/claim-verification.md`. **Ordinals are global and permanent** — a shard is a storage
location, not a namespace, so §61 is §61 wherever it lives and the cite form never changes.
Index, preamble and tombstones: `docs/claim-verification.md`. **The admission test — what may be
written here at all — is `.claude/rules/plan-hygiene.md` §Claims**; nothing licenses a write from
inside this file.

## 2. Coverage claims — the named test, the absent pin, the derived inventory

One class, three shapes; all three are discharged by grepping rather than by reading.

- **"(`openapi-drift.test.ts` pins this.)"** — grep the named test for the symbol. Absent ⇒ schedule the pin
  as work. Applies identically in a code docblock or a README.
- **"Nothing pins X" needs the same grep — grep the VALUE (`2.5`), not just a symbol.** Instances plus the
  sibling `requiredOf` trap are the same class.
- **Uniform-application prose** ("cross-referenced from each row") is a file-wide coverage claim — count the
  rows.
- **A TYPE annotation's docblock is a coverage claim** — and the annotation beside it can legalise exactly
  what the prose says it catches: a docblock promising "a missed or misspelled key fails" sat on a
  `Partial<…>`, which permits omission in the same sentence. Reproduce BOTH directions (omit one; misspell
  one) before writing down what a type catches.
- **Derived coverage:** a "tests verified by reading" inventory owes RUNNING the suite; an "every X does Y"
  quantifier owes a re-read when a change adds an X; a measured table owes a re-measure on a constant bump,
  and a SHA stamp. **A table enumerating what an edit touches is this same claim** — and a DERIVED
  classification is how it goes wrong silently: where a classifier is *defined as* a call on the thing being
  edited, changing that thing re-runs the classification and carries a second ruling nobody listed. Grep the
  classifier's definition for the edited symbol before trusting the table. `cardGroupOf` is defined as
  `familyOf(id) ?? CARD_ONLY_GROUPS…`, so seating `EU2` in `GLOBAL_FAMILIES.credit` silently re-ruled its
  card group and left a `CARD_ONLY_GROUPS` row unreachable. This is the **inverse** of §29 — that class
  catches a listed surface that never reads the thing; this one catches a reading surface the list never
  named.

## 30. "The suite stayed green, so the hoist was behaviour-preserving" only covers symbols that moved VERBATIM

A move/extract refactor splits into two populations: code relocated **character-identical** (where an unchanged
suite really is evidence) and code **restructured** in the same pass (where it is not). E7's hoist shipped five
docblocks claiming the whole change was covered; the one function actually rewritten during the move,
`lagRowFor`, had **zero** tests touching its new argument path.

**The check:** before invoking "unchanged suite ⇒ safe", partition the diff — `git diff -M --stat` names the
renames, and everything the rename detector did *not* pair is restructured code owing its own red demo. State
the partition in the commit message. A refactor's risk lives entirely in the residue, and the residue is
exactly what the green suite is silent about.

## 34. "Pre-existing at HEAD, therefore not mine" is a claim about the WRONG baseline

A subagent handed a red test and asked whether its own edit caused it will revert its edit, re-run,
see the same failure, and report **"pre-existing at HEAD — unrelated"**. That is literally true and
still misattributed whenever HEAD already carries an **earlier commit from the same session**: the
revert only clears the last change, not the one two commits back that actually broke it.

2026-07-31: `MEMBER_WEIGHT.R6` gained a `Health: 0.6` cell. Its self-verify ran a scoped
suite set that did not include `api/lab.test.ts`, so the break landed unseen. Two commits later the EBP
arc's full-suite run surfaced it; that agent reverted the EBP pair, reproduced the failure, and correctly
reported it as pre-existing at HEAD — with the inference "unrelated to this arc", which read as
"unrelated to this session". The real cause was the Health cell raising Health's danger until it was no
longer the strict in-band argmin the test's own PREMISE loop asserts. The ruling that caused it had even
NAMED the risk ("adding a `Health` cell changes the `Health` column's structure").

**The check, two halves:**
- **Baseline:** "pre-existing" must name the SHA it was measured against. If that SHA is inside the
  current session's range, the finding is *unexplained*, not *exonerated* — bisect to the session's base
  before filing it as someone else's bug.
- **Scope:** a weight/threshold/cut change invalidates test PREMISES, not just assertions, and a premise
  can live in a suite the change's own focus files never import. When a plan's own duty section says the
  edit changes a *column's structure* (or any shared ordering), the self-verify's scoped suite set is
  structurally too narrow — run the full suite once for that class of change, or grep for tests asserting
  an ordering over the touched dimension.

Nearest siblings: §21 (a guard asserting an outcome distribution inverts once the system gets healthy) and
§29 (N consuming surfaces owe a per-surface check) — this is the same blind spot at the *baseline* rather
than at the surface.

## 37. A test suite's mock surface is a per-file WHITELIST — adding an import to the code under test silently un-mocks it

**Incident (2026-08-01, E8 item 2).** `api/lab.ts`'s `?replay=` branch gained a
`fetchSeries("BAMLH0A0HYM2")` call. `api/lab.test.ts` mocks `../src/store.js` and nothing else, and
the repo has no vitest `setupFiles`, so the new feed import was never intercepted: `npm run check`
began making a live third-party HTTP request and running the real `stitchHyOas` over the committed
vintage. It went unnoticed because **the suite was green either way** — offline it took the degrade
branch, online the stitched branch, and no assertion distinguished them. The commit message recorded
the offline reading ("exercises the DEGRADE branch only") as if it were the fact.

**Why it evades every gate.** `tsc` sees a legal import. The suite is green. A diff review sees one
new call in a handler that already had 130 passing tests. The mock list lives in a *different* file
from the change, so nothing co-locates the two.

**The verification move.** When a change adds an I/O import to a module under test, **grep that test
file's `vi.mock` list for the new module before claiming any branch coverage.** Then make the
suite's network-freeness an assertion rather than an ambient property: stub the global `fetch` to
THROW, so an unmocked path fails loudly instead of succeeding quietly.

**The generalizable claim class: a test that passes both with and without the network is asserting
nothing about which branch it took.** Any "this test covers the degrade path" / "this test covers the
happy path" statement owes a demonstration that the OTHER path reddens it — the ordinary red demo,
applied to the branch selector rather than to the assertion. Establish it two ways where you can:
run under `unshare -rn` (a real no-network namespace — note a *sinkholed* DNS name still resolves and
is NOT the same as offline, see the host-DNS note in `docs/reference.md` §[arch] 9. Cross-file design invariants), and by
construction, by rewiring the mock to the real module and confirming the case goes red.

**Corollary — the gate inherits the dependency's VALUES, not just its availability.** `stitchHyOas`
throws on a `GROSS_TOLERANCE` overlap disagreement or a `MAX_GAP_DAYS` gap, so once the fetch was
live, an upstream FRED revision could redden the unit suite on a diff that touched nothing.

## 43. A test anchored on "whichever table cell happens to be vintage-absent" re-breaks on every family seating

A guard written as "the cell that has no vintage entry" (rather than a cell constructed for the purpose)
encodes a **transient property of `scripts/archive/cell_sensitivity.json`**, not an invariant. Every time a
family is seated onto the panel the vintage gains entries, some previously-absent cell becomes present, and
the test goes red for a reason that has nothing to do with what it was written to guard.

Hit twice on the same shape: first when `uT` was seated, then again when `gp` was. Both times the fix was mistaken for a normal re-pin, so the class
survived to bite the next seating.

**The move:** anchor the assertion on a **constructed fixture cell** the test owns, never on a lookup into
the live vintage. If a test genuinely must assert something about vintage absence, assert it about a cell it
inserted or deleted itself, and state in the docblock that the property is a vintage property rather than an
invariant — the same distinction `probe-leg-ordering.ts`'s `exo` arm makes explicit with its
`CELL_SENSITIVITY_VINTAGE` abort.

Nearest sibling: `plan-hygiene.md` §Claims' "a gate or quantifier you author owes the population it must admit" — there the
population was too small; here it drifts under the feet of a test that never named it.

## 67 — a combine-mode flip can make an EXISTING fixture unreachable, and the suite stays green

Flipping a scorer's two legs from OR to AND does not break any test that was already passing — it narrows
which inputs can reach the top severity, and a fixture built for the old rule keeps asserting a state it can
still produce for the wrong reason, or quietly drops to the tier below and takes its assertion with it.
Nothing red flags this: the fixture is still valid data, the scorer is still correct, and the assertion was
rewritten to match.

Incident (2026-08-06, oil trio R3/R4): a FLAT F1 fixture can no longer reach RED — flat ⇒ Δ30d = 0 ⇒ the
velocity leg is dark ⇒ AMBER under the AND. The fixture had been the canonical "RED" input for the family.

**The move:** on a combine-mode flip, re-derive each existing fixture's reachable ceiling under the NEW rule
before touching any assertion, and give the family one named constructor that produces a genuinely
top-severity input (`f1RedBothLegs(head)`, `src/run.test-helpers.ts`) so later fixtures inherit reachability instead
of re-deriving it. A degenerate input (flat, zero, constant) is the one most likely to have gone
unreachable — it satisfies the level leg trivially and the velocity leg never.

**Corollary — an independent REFERENCE IMPLEMENTATION inside a test is a second copy of the convention, and
it rots silently.** A test that re-derives the rule rather than calling the symbol under test stops being an
oracle the moment the convention flips: it now asserts the old rule against the old rule, and its fixture may
never reach the boundary that would red it — the same green-by-unreachability as above, one layer up. Before
flipping a convention, grep the suite for a hand-rolled restatement of it (the formula's operators, not its
function name) and either delete the copy in favour of the imported symbol or red-demo it against the new
rule.

## 68 — a pre-registered "we will not measure this" is itself falsifiable, and the suite is what falsifies it

A pre-registration that scopes an arc by declaring a quantity out of scope reads as a *decision*, not a
claim, so nothing is aimed at it. But "this cannot be measured here" / "no test observes this" is an
assertion about the repo, and the existing suite frequently already observes it — in which case the
exclusion was never a real narrowing and the arc under-reports what it moved.

Incident (2026-08-06): the arc's E2 exclusion was retracted after the suite turned out to assert the very
quantity E2 had declared unmeasured.

**The move:** treat every negative scope line in a pre-registration as a coverage claim (§2) — grep the
suite for the quantity before banking the exclusion, and if a test does observe it, drop the exclusion
rather than arguing the test doesn't count.

## 69 — a NEW TABLE is as additive as a new leg, so pin the RESOLVER'S OUTPUT, not a table's identity

A test that asserts *which table* a value came from is pinning an implementation identity. Adding a second
table that the resolver consults first is a purely additive change by every other measure — no signature
moves, no existing row is edited — and it silently changes the answer while the identity assertion stays
green, because the named table still exists and still holds the old value.

Sibling of §43, which covers the same table layer from the fragility side (an anchor that re-breaks); this
is the green-but-wrong direction.

**The move:** assert on `resolveCuts`'s (or the equivalent resolver's) returned value for a named id, never
on the presence, contents, or precedence of any one source table. If precedence itself is the behaviour
under test, pin it by constructing a conflicting pair and asserting the winning VALUE.

## 72 — deleting a DISCRIMINATOR silently un-tests every assertion built on it, and the suite stays green

Removing a gate, a precedence rule, or any branch that made two paths produce *different* outputs does not
break the tests written to tell those paths apart. It collapses them: both arms now return the same value,
so the assertion passes whichever arm runs. Nothing is red, no test is deleted, and the coverage report is
unchanged — the tests simply stop discriminating. This is the inverse of a broken test and far quieter,
because the reassuring signal (green) is produced *by* the defect. It also arrives in bulk: one discriminator
is usually the load-bearing difference under several tests at once.

Incident (2026-08-07, the lead-precedence gate's retirement): the gate's deletion left three live tests
asserting nothing — a held-vs-raw member-map choice whose two branches became unobservable through their only
consumer, a "a COLD store takes the unheld map" case whose fixture now yields identical output on both
branches, and two `api/lab.ts` wiring arms whose only cover had run *through* the gate. All three were
confirmed by mutation: reverting or inverting the branch each guarded left the full suite green. One of them
could move the prod dial band — which IS the notify band — with nothing red.

**The move:** when a change deletes a discriminator, do not ask "which tests fail?" — none will. Grep the
tests that *named* the deleted concept, and for each one **mutate the behaviour it claims to pin and confirm
red**. Every one that stays green is now unpinned: either rebuild its discrimination on a surviving
difference (a second consumer, a function-level assertion, a fixture that separates the arms without the
gate) or record it as an open coverage hole with the mutation that demonstrates it. Deleting such a test is
correct only when its discrimination ran *entirely* through the removed concept — and that is a claim owing
the same mutation.

**The LOUD form is the same defect announcing itself, and it is the one that gets rationalized:** while
planning a change you notice that an existing test *would* go dark — no-reading, degraded, `skip`ped — under
it. That observation is the defect report, not a fixture inconvenience: answer *is the darkness correct new
behaviour, or the change's first symptom?* by running that test against the new code and reading what it
reports, BEFORE touching the fixture. Moving the oracle to a sibling id, relaxing the assertion or skipping
it converts a bug report into a plan step, and the commit then reads as a tidy relocation. A relocation
licensed by that answer still owes a replacement assertion pinning the darkness as intended (a positive
"yields no reading here" case), never a silent removal.

Sibling of §67, which is the fixture-side form: there the input can no longer reach the
asserted state; here the assertion can no longer separate the states it names. §4's population-filter bullet is the
gate-side form:
there the subject leaves the checked population entirely.

## 75 → merged into §72
