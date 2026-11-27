# Claim verification — code-, consumer- and copy-surface claims

Shard of `docs/claim-verification.md`. **Ordinals are global and permanent** — a shard is a storage
location, not a namespace, so §61 is §61 wherever it lives and the cite form never changes.
Index, preamble and tombstones: `docs/claim-verification.md`. **The admission test — what may be
written here at all — is `.claude/rules/plan-hygiene.md` §Claims**; nothing licenses a write from
inside this file.

## 6. An "X is untouched" claim

Check every BRANCH of X, not the one you read. True on one branch and false on the next is a silently dropped
feature.

## 7. A "no-op / byte-identical / zero-change" deliverable

Check the fold's comparison operators (`>=` vs `>`) before staging work behind it. No coverage grep catches
this one — there is no named test to name.

## 8. The INVERSE claim — "this changes what the user sees"

Grep the consumer's own filter before asserting it. A render table keyed only on ids the consumer excludes is
dead code, so the edit is a no-op. `MEMBER_NAME` ∩ `TILE_HIDDEN_MEMBER_IDS`, 2026-07-24 — asserted visible in
three committed places, caught only by review.

**The inverse binds harder for COPY.** Editing an output-visible string is a claim that the function you
edited is the one production renders — and a retired-but-still-exported producer accepts the edit silently,
compiles, and keeps its tests green. Before believing user-facing text changed, grep the *producer's* own
consumers, not just the string: 2026-08-07 a narrowed /lab hover landed in `observedNote`, which nothing
renders, while the live hover kept promising a countdown from `cellTipHtml`.

## 10. A cycle claim

Walk it transitively. A direct-import grep misses `A → C → B` — 2026-07-20, a whole band of suites went
TDZ-dead on an edge no direct grep showed.

⚠ **Cite the class, not the count** — this section itself carried "44 suites TDZ-dead" until 2026-08-01, and
that is exactly the rot §9 warns about: re-measurement of the same edge returned **9**
(CORE-9 Stage A) and **45** (Stage E), because how many files fail to collect depends on the runtime and the
entry order, not on the cycle. A cycle claim is citable as *"this edge breaks collection"*; the number is
not. And once the cycle is SEVERED (CORE-9, 2026-08-01)
the collect failure stops being a falsifier
at all — anything still naming it as a live gate is a check incapable of failing. (Merging this class into
§9 was considered and DECLINED 2026-08-01: §9 owns finding-rot generally, §10 owns the transitive walk; only
this ⚠ overlaps, and it is the count-shaped instance §9's rule does not name.)

## 13. A design's "won't break X" / "family-agnostic" claim

It is a WORLD-claim about a CONSUMER — grep the consumer first. `techConfirmerP` was called agnostic;
`techConfirmerFromPanel` flattens the family PANEL.

⚠ **A structural exclusion argued at the BAND says nothing about the BODY.** VTP's chart-only exclusion was
argued where the band is computed and left `opts.verdictHoldLegs` — a second, unfiltered consumer of the same array
— leaking it into the push, the same defect class twice in one review range. An exclusion lives at every
consumer that reads the array, never at the concept: enumerate them (§29) and grep each one's own filter.

## 19. Copy with TWO consumers may assert nothing about WHERE things render

One string reached by two surfaces can be true on one and false on the other, and fixing it for the surface
you are looking at is how the falsehood gets introduced. `src/families.ts`'s volatility `desc` is the /lab
tile tooltip (members then PRUNED by a `TILE_HIDDEN_MEMBER_IDS` set, retired 2026-08-15) **and** the main dashboard's channel title
(`renderChannelCards`, NO prune). E9 rewrote it to say the slow legs "paint in the off-ladder zone, not on
this tile" — correct for /lab, false on the dashboard where those legs paint as cards directly beneath that
very heading, and false outright for `complacency-duration`, which has no off-ladder card at all.

**The check:** before editing user-facing copy, grep every consumer of the string (`\.desc\b`, the field
name, the constant) and ask whether each claim holds on ALL of them. A claim that cannot be made true
everywhere must be replaced by a surface-independent fact, not re-scoped — here, "display-only, excluded
from the dial" (a `DIAL_FAMILIES` property) instead of a location.

⚠ **A name-based falsifier does not cover this class.** E9's guard
(`public/tile-members.test.js`) bans the pruned legs' *names* from the `desc` and stayed green
throughout — it policed vocabulary, not assertions. Wrong-predicate falsifier — cf. §4.

## 24. "Doc-only, therefore zero risk" is itself a claim — and it disarms the checks

NF-2 (2026-07-26) wrote copy — a `/lab` footnote and its hand-synced README twin — whose entire job was to
separate what raises the ALERT from what moves the POSITION. Framed as having no behavioural surface, it
shipped **three false engine facts** green: it misattributed CAPE (valuation reaches the position only
through the dial's rung `hi`, never through member weights), invented a `va` super-group that does not
exist, and called `r4` the only both-lists floor. Its test pinned the one discriminating half the rung was
*about* and was blind to all three — the same wrong-predicate failure as §19 (cf. §4).

⚠ **The three did not all live on the same surface** — the `va` claim was **README-only**, which is why a
sweep of the footnote alone would still have missed it. Two consumers, one rung, and the copy is hand-synced
with no single source: §19's lesson and this one compound.

⚠ **And the both-lists fact is subtler than the correction was.** What reaches both axes is the **G1
reading**, not one function: at the time, `exogenousFloor` (`src/danger-engine.ts`; DELETED 2026-08-02 by
C1 — the position-axis carrier is now `combineLegDanger`'s weighted `gp` term, which does not change the
lesson) floored leg danger on the POSITION
axis, while the GEO escalator base carries the same reading into the ALERT band (`alert-band.ts`) —
`danger-engine.ts` states the separation in its own comment. Naming the function as "on both axes" is the
loose version of a true claim, and that is exactly the register in which the original three were written.

**The check:** copy that asserts ENGINE FACTS owes the identical source-grep as code — one grep per named
symbol, at the seam that implements it, on **every** surface the copy is synced to. The "doc-only" label
describes the *deployment* risk, never the *truth* risk, and a footnote explaining a mechanism is a denser
pile of claims per line than the mechanism is.

## 26. An "X and Y can never both happen" invariant may be a PRECEDENCE outcome wearing an impossibility's clothes

Three production comments (`public/cash-overlay-view.js` twice, `public/lab.js` once) assert *"R4's `full`
and the overlay's `partial` can never both paint"*. The sentence is TRUE — and it is true because a
downstream resolver silently drops one of them, not because the pair is unreachable. R7 (2026-07-26) found
the exclusivity is manufactured by `resolveCash`'s unconditional `if (r4.cash)` dominance branch, which never
inspects the overlay at all; its own docblock says R4 *"dominates unconditionally"*. The producers
(`computeCashOverlay`, `computeR4`) never receive each other's result, so **nothing about the states is
exclusive** — only the render is. The co-occurring input is the canonical fast crash, not a corner case.

⚠ **The parity test read as reassurance and was the opposite.** `cash-precedence-parity.test.js` *enumerates*
`r4=cash × overlay=partial` as a live fixture. A test that CONSTRUCTS the pair is evidence the pair exists;
it can only ever pin which one wins, never that the pair is impossible.

**The check:** an impossibility claim is about the *inputs*, so verify it at the producers' **signatures**
before believing it — can the two functions even see each other? If they cannot, the exclusivity lives
downstream and the honest word is *precedence*. Then ask the question precedence owes and impossibility does
not: **what happens to the loser?** A dropped claim is fine when it is strictly subsumed (R4's 100% contains
the overlay's bounded 85%) and a defect when the two disagree — which is why the sibling `r4-reentry` branch
already carries a `suppressedBy` discriminant and the dominant branch does not. Verbs matter: "can never both
**paint**" is a render claim; "can never both **happen**" is a state claim; the file said the first and was
read as the second for three surfaces and one plan rung.

## 29. A plan step naming N consuming surfaces owes a per-surface check that each one READS the thing

E6a (2026-07-26) reordered `US_FAMILIES[].ids` and its plan named **four** consuming surfaces. Two of the four
did not consume member order at all: the replay coverage bar takes a `Math.min` over the set (order-insensitive
by construction) and one listed surface was never wired to that array. A pin authored on either would have
been vacuous — green forever, guarding nothing.

**The check:** a surface list is a claim per entry, not one claim. For each named consumer, grep the *access
pattern*, not the identifier: an `.ids[0]` / `find` / `findIndex` / index-preserving map genuinely consumes
order; a `Set`, a `sort`, an id-keyed lookup, a `Math.max`/`min` or a counter does not. Then say out loud which
entries survived — "3 of the 4" is the useful output, and the dropped one usually explains why the rung felt
larger than it was.

## 35. A PRODUCER-side proof says nothing about the PERSISTED value a reader serves

**The claim, in its two commonest forms:** "the rename shipped — the confirmer drives the real producer and
it emits the new word", and "the stored `state` column shows what the notify path does".

**Why it rots:** a value that is both *persisted* and *recomputable* has two producers, and they routinely
resolve their inputs differently. **Copy shape:** `/lab`'s dial headline lives in the `dial_state` jsonb and
`hydrateOrComputeT1Dial` returns the stored row verbatim, so the `armed`→`primed` sweep was green on
`computeT1Dial` while every live, historical, replay and scenario row would have kept painting the old word
— and a file-wide grep cannot see it, because the stale copy is in the database, not the tree.
**Verdict shape:** `scripts/backfill.ts` calls **none** of `loadSynthHistories` / `synthesizedCalib` /
`getCalibration` while `run-cycle.ts`, `api/series.ts`, `api/indicators.ts` and `api/lab.ts` all do, so every
backfilled row for a `synthPriors` id persists a **degrade-fallback** state — the stored column and the live
recomputation are both real and answer different questions (§25). Output-visible, not academic:
`computeReplay` folds the stored member states.

**The move:** before calling a producer-side proof done, ask *where does the value come from at read time?*
If any part of it is stored, name the **writer** that produced those rows and check it resolves its inputs
through the same path the live producer does; if it does not, the column is evidence about the *backfill*,
and the live claim owes a recomputation over the same dates. For copy the discharge is a **READ-path test**
(a stored row renders the new string) — restating a word on read is safe, recomposing the whole sentence
usually is not, because the fields it needs come from a different run than the persisted row.

Nearest siblings: §29 (N consuming surfaces owe a per-surface check) — this is the same gap where one of
the "surfaces" is the database; §25 (a confident measurement that answers a DIFFERENT question than the one
asked); and the emitted-vs-rendered distinction in `frontend.md`.

## 36. A per-side identity property does NOT survive ASYMMETRIC inputs

**The claim:** "if a side's input is absent this reduces to the identity, so binding per side is safe."

**Why it rots:** the property is proved on a *symmetric* world. A pair-binder pinned that way shipped, and
when one side carried a rung while the other was rung-blind, the two halves bound differently and
manufactured a phantom push (caught in review, not by the pins). Symmetric fixtures cannot distinguish
"binds as a pair" from "binds per side" — they agree on every case the fixtures contain.

**The check, two halves:**
- **Asymmetry:** an "absent input ⇒ identity" claim owes the ASYMMETRIC fixture — one side present, one side
  absent — not two symmetric ones.
- **Wiring:** a pure-function pin is not a wiring pin. Proving the resolver returns the identity says nothing
  about whether the caller routes both sides through it; pin the CALL SITE too.

Nearest siblings: §29 (N surfaces owe a per-surface check) and §13 (a "won't break X" claim is about a
consumer) — this is the same gap where the two consumers are the two SIDES of one pair.

## 38. A "floor" measured through a window that serves the NEWEST N rows is not a floor

`scripts/probe-feed-diff.ts`'s stale-prefix check compares each id's earliest STORED date against its
earliest FETCHED date. It reads the stored side via `getSeries(id, BASELINE_PROBE)` — which returns the
**newest** `BASELINE_PROBE` rows. So `dates[0]` is the window's floor, not the table's: once a series
exceeds the probe size, the check prints `0 rows` while the real gap is arbitrarily large, and it prints
it forever. The bug is invisible in review because the arithmetic is correct — only the *population* the
arithmetic runs over is wrong (§4's "arithmetic covered, POPULATION uncovered", specialised to a
read-window bound rather than a predicate).

**Verification move:** whenever an assertion names a MIN, an EARLIEST, or a FLOOR, find the read that
produced the collection and check whether it is bounded and from which end. A bound taken from the
opposite end of the quantity you are asserting makes the check unfalsifiable. Report `unknown` on
saturation rather than the computed value — a saturated window has no information about the floor, and
emitting `0` there is a claim the data cannot support. Headroom that makes it safe today ("20y ≈ 5040
rows < 6500") is not a guard; it is a coincidence with an expiry date, and it owes an explicit test arm.

## 48 — a comment that LABELS itself a claim still rots; only a derivation or a test stops it

**Class:** a hand-maintained roster/inventory in prose. **Cue:** a docblock lists the members of a set the
code derives elsewhere, and the comment says something like "this is a CLAIM — re-derive it before trusting".

`FAMILY_MEMBERS`' roster docblock in `src/danger-ladder.ts` carried exactly that self-aware warning and was
**still stale in three families at once** (2026-08-03) — the `rt` entry hand-listed 8 members and
omitted `T5YIFR` / `T10YIE`, which the derived set contains. The warning label did nothing: every reader who
saw it was a reader who had already read the stale list, and nobody re-derives on the strength of a comment.

This is the general shape: **a self-labelled claim is still a claim.** Marking prose as untrusted transfers
the verification duty to a future reader who has no trigger to discharge it, so the label buys the *feeling*
of a guard while leaving the same rot. It is the prose cousin of `~/.claude/references/anti-patterns-common-rationalizations.md` §Verification Anti-Pattern — a check nobody
can be made to run reads as satisfied forever.

**The move:** don't write the roster. Either (a) delete the enumeration and point at the derivation
(`FAMILY_MEMBERS.rt` — read it), or (b) if the list genuinely aids a reader, pin it with a test that parses
the comment and compares it to the derived set (the precedent exists: `family-lag.test.js` parses
`export type Label` out of the source to drive parity). A probe or script that **enumerates** rather than
hand-listing is immune by construction — which is why the same session's `probe-gp-cosign.ts` measurement
was unaffected by the stale docblock it sat next to.

**Three more labels the same way.** (a) The **INVERSE** marker — `(verified)`, `premise confirmed`,
`checked against the code` — asserts a check RAN, and nothing downstream separates a discharged check from
a self-certified one, so it permanently disarms the duty instead of deferring it. A `(verified)` marker
owes the command or symbol-grep that discharged it, written beside it; no command, no marker, and an
intended-but-unrun check is `UNVERIFIED`. (b) A **display FORMATTER** is a label too: rounding, truncation
and unit suffixes change what the caption asserts while leaving the value that produced it correct, so a
caption may only name a quantity its formatter can represent exactly — otherwise widen the format or
reword to a relation the rounding preserves. (c) An **ALLOWANCE / whitelist row** — an orphan-date
allowance, a context-only allowlist, a named test exclusion, a `CARD_ONLY_GROUPS`-style carve-out — asserts
two things, *this member is exempt* and *this is why*, and only the membership half is enforced: the suite
goes green on it alone, so the stated cause can be wrong at birth or rot with nothing re-reading it, and the
row then licenses a sibling under a cause that no longer holds. Such a row owes a falsifier for its CAUSE (a
command or grep going non-zero once the reason stops applying) written on the row, or an explicit
`as of <date>, unpinned` marker — and an allowance is never widened into a predicate on an unpinned cause;
re-derive the cause per member first. All three share §48's shape: the composed string is the claim, and
the derivation beside it is what should have produced it. The formatter seam carries its own directive at
`chart-rail.ts`'s band-label composer — read it before changing a label format.

## 76 → merged into §48

"A display FORMATTER is a claim about the value it renders" — minted 2026-08-08 and absorbed the same day:
its own body closed *"Sibling of §48"*, which is the merge signal, not a cross-reference, and its incident
(`Math.round` captioning a p7.5 cut `<p8`) is already pinned at its seam in `chart-rail.ts`. Tombstones stay.
