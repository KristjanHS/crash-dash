# Claim verification — grep / sweep claims

Shard of `docs/claim-verification.md`. **Ordinals are global and permanent** — a shard is a storage
location, not a namespace, so §61 is §61 wherever it lives and the cite form never changes.
Index, preamble and tombstones: `docs/claim-verification.md`. **The admission test — what may be
written here at all — is `.claude/rules/plan-hygiene.md` §Claims**; nothing licenses a write from
inside this file.

## 1. Cite by SYMBOL — and a constant CHANGE, or a CORRECTED claim, owes a symbol-grep across every live surface

Two moves on one axis: how you *write* a constant reference, and what you owe when you *change* it.

- **Cite constants by SYMBOL, never `file.ts:LINE`** — line cites rot within a day. A resume-falsifier is
  optional; if you write one, grep the stage's unique symbol
  (`--grep vixTermState`), never its number — many plans reuse `Stage 1.1`.
- **A tunable-constant change — or a widened UNION — owes a SYMBOL-grep across ALL live surfaces**:
  `src/` + `api/` + `public/`, **and the prose/schema mirrors — `openapi.yaml` and docblocks**, where a new
  union member leaves the old EXCLUSION TEST copy-pasted. Not just the plan-named test files: the plan's
  test-surface list is itself a claim. A `RERISK_DWELL_DAYS` bump's `x/10` and `~10 closes` display literals
  lived in `api/lab.test.ts`, omitted from the plan's Stage-A list.
- **A REFUTED statistic owes the same grep, and "reader" is the wrong unit — grep the statistic, not the
  symptom.** E7 (2026-07-26) refuted `medianGap`/`p90Gap` as a lag measure, repointed the surfaces that
  *displayed* lag, and left `classify`'s DEEP-LAG arm and `shouldCorrect` still *computing* on it — so the
  probe ended up recommending its own rung be reverted. A concept is retired when every consumer is
  repointed, not when every complaint about it stops.
  ⚠ **E7 SCOPED the statistic rather than removing it, and that is still a repointing — because the scope is
  written down.** `deepLagRhythm` deliberately returns bare `p90Gap` for the 58 implicit ids and `shouldCorrect`
  still reads `medianGap` for them (the ruling: "the implicit-id arm is byte-unchanged"). So a grep for residue
  will hit live, intentional call sites. A scoping that is not recorded is indistinguishable from a missed
  consumer — which is the whole failure this bullet describes.
- **CORRECTING a false claim owes the same file-wide sweep a constant change does — the claim is the symbol.**
  The generalization of the bullets above: once a world-claim is refuted, every *restatement* of it is now
  false, including the ones in the very file you are correcting. The auto-load correction (2026-08-08) patched
  `plan-hygiene.md` §Archiving and deleting a plan doc and shipped — leaving the same false mechanism asserted elsewhere in
  that file, caught only by review. Sweep the CONCEPT, not the sentence you edited: grep the
  claim's distinctive nouns across every surface, the correcting file included, and expect the residue to be
  largest in the file you were already looking at.
- **A comment that QUOTES an expression is not its definition site.** Restating a formula or a cut in prose
  mints a second copy that no test binds, so the symbol-grep above must repoint every quoting comment — or,
  better, delete the quote and name the symbol, since the copy exists only to rot.
  ⚠ **The worst case is a quote of a REGENERATED artifact, because there is no symbol to grep.** A number
  read off a vintage (`cell_sensitivity.json`'s ŵ, a generator id, a backfilled count) has no definition
  site in code, so the constant-change grep above never fires — and the change that invalidates it is a
  *regen*, not an edit anyone would think to sweep. `danger-ladder.ts`'s estimated-ŵ enumeration rotted
  **twice**: once quoting pre-2026-08-01 reaches, which three independent research arms then trusted over
  the file and republished; then its replacement rotted inside one day when seating moved three of the six
  cells out of the vintage entirely. A ⚠ saying "re-read the JSON, never this line" did not save it — the
  next reader quoted the line anyway. **The only durable form names the cells and points at the deriving
  function** (`cellSensitivity`), carries no magnitude, and says that vintage MEMBERSHIP moves too. Where an
  argument genuinely needs a number, mark it as a dated read. Corollary for the stage doing the regen: its
  duty list includes a prose sweep for the old values, which is a grep for the LITERALS — the one thing a
  symbol-grep cannot find.

## 16. The cite rule binds CODE, not just prose

This is the code-binding half of `.claude/rules/plan-hygiene.md` §Cite plan docs by stem, and its only home —
kept here rather than in the L2 body so that reading a `*.ts` file does not inject it. **A script that reads a
plan file globs the basename across both `docs/plans/` and `docs/plans/archive/` and hardcodes neither**; a
comment's directory *hint* is always `docs/plans/`.

The incident: a hardcoded path breaks silently on archive, which is what ENOENT'd the F1 EPISODES falsifier
when a commit archived the EW-R1 plan (fixed 2026-07-21). A bare repoint to the archive path re-breaks on the
next move, so the two-dir glob is the fix and a new hardcode is not. Live pattern: `PLAN_BASENAME` in
`scripts/backtest/f1-percentile-cuts.test.ts`.

## 17. Deleting a SECTION HEADING dangles refs exactly like deleting a file

The directive and the verbatim repo-wide bare-stem grep are in `.claude/rules/plan-hygiene.md`
§Deleting a SECTION HEADING. This entry holds the two incidents behind it.

2026-07-19: a consolidation left 3 dangling `plan-hygiene.md §…` cites; review caught only the 2 in the
architecture doc — the third, in a plan doc, surfaced only on the repo-wide pass.

2026-07-25: the condense pass that *authored this very file* renamed `§Everything you write down is a claim`
→ `§Claims`, ran a hand-tightened variant of the grep (`plan-hygiene[^ ]\{0,3\}\s*§`, where `[^ ]` matched
`.md` but `\s*` could not match the closing backtick), and got a clean result. Three live cites were in fact
dangling — among them the architecture overview's line 14 — plus one archived. Only the code review found them.

Generalization: **a falsifier you retype from memory is a new falsifier and owes a fresh can-it-fire demo.**
The prescribed form existed and was correct; substituting a stricter-looking character class for the dot
turned an all-clear into no evidence at all. Copy the form, don't paraphrase it — and if you do vary it,
demonstrate the variant still matches a known-positive before trusting a zero-hit result.
Wrong-predicate falsifier — cf. §4.

## 18. A file-wide grep can SILENTLY SKIP a source file it classifies as binary

`grep`/`ripgrep` stop at the first NUL byte and report `Binary file … matches` — or, with the flags a
scripted sweep typically uses, emit **nothing at all**. A zero-hit result then reads as an all-clear when
the file was never searched.

This is not hypothetical: `src/danger-engine.ts` carried **two raw NUL bytes** (the `ESTIMATED_REACH`
map-key separator, introduced in W6 Stage 6.3/6.4 as a literal control character rather than as a
JS unicode escape). For the ~2 days that followed, every file-wide symbol grep over the largest file in
the engine returned a false negative. Fixed at Stage 6.5 by writing the escape instead (byte-identical
runtime keys) — the docblock had also mis-described the separator as a space.

**The check:** a grep whose zero-hit result you are about to treat as evidence owes
`grep -rlI '' <paths>` vs. `grep -rl '' <paths>` — the difference is the set of files the sweep silently
skipped. Cheaper habit: never write a control character as a literal in source; use its escape sequence.
Wrong-predicate falsifier — cf. §4.

## 22. A "every surface" sweep that lists directories will miss the PUBLISHED CONTRACT

E7 4.7 (2026-07-26) re-based the rot bar and swept `src/`, `api/`, `scripts/`, `public/` and
the architecture overview for prose stating the old rule. Review found `openapi.yaml` still publishing
it — on `rotBar`, the exact field the rung re-based. The sweep was directory-shaped, and the API contract
is not in a source directory.

**The check:** enumerate a doc sweep by **artifact class**, not by directory — source, tests, front-end,
architecture doc, **API contract (`openapi.yaml` + its mirrored `src/api/types.ts`)**, README, plan docs.
A served field's description is a claim about behaviour and rots exactly like a docblock.

**A GLOB is the same shape one level down — it is a surface claim, and its exclusions are invisible.**
`scripts/probe-*.ts` does not reach `scripts/backtest/`, so an inventory taken through it under-counts and
the "no scaffold exists for this" it produces is false. Enumerate the directory (or glob `**`) before
asserting absence — the false claim rides straight into an `AskUserQuestion` option description, where it
steers a ruling before review can catch it.

**THE DIFF'S FILE LIST IS NOT A SWEEP POPULATION EITHER — grep the CONCEPT, not the word.** After a
semantics flip, "I updated the copy in every file I touched" feels like coverage and is the same
directory-shaped error one level down: the surfaces that describe the old behaviour are exactly the ones the
edit did NOT need to touch, so they cannot appear in the diff. 2026-08-06, the oil OR→AND flip: sweeping the
diff left three live surfaces selling the retired rule (`public/band-panel.js` on G1 and OVX,
`danger-engine.ts`); only a grep over the *concept vocabulary* — the neighbouring words a reader would have
used, never the symbol that changed — found them. Enumerate the vocabulary before the sweep, not the files.

**Corollary — the claim's SCOPE must match the search's scope, and a file-local enumeration cannot
discharge a repo-wide claim.** A fix commit closed with "the last two inline `countBy`
duplicates — Stage 2 CLOSED" and scrupulously enumerated the two Map builders it had *skipped inside the two
files it edited*, while three more byte-identical bodies sat in files it never opened
(`probe-cash-overlay.ts`, `probe-growth.ts` ×2 — same `reduce`-into-`Map`, differing only in a trailing
ascending sort). Care spent inside the edited files reads as repo-wide diligence and is not; the enumeration
of near-misses owed by §78's move is owed over the **grep's** population, not the diff's.

**A DISPATCHED sweep's reported scope is a third claim — the orchestrator never sees the command that ran.**
A subagent reported a "file-wide" sweep as covering `docs`; it had run over `src api scripts public` only,
and `docs` held four live hits. Require the executed argument list in the report, or re-run the sweep
yourself before repeating its coverage in a commit message.

**A closing gate's PATH SCOPE is a claim too.** A gate is checked for what it MATCHES; nobody re-derives
what it REACHES. So a gate whose symbol list is complete still certifies nothing outside its path arguments,
and the surfaces it silently omits are exactly the ones swept by a hand-picked file list rather than by grep
— the half with no automated cover. The move: derive the gate's paths from the RULING'S scope, not from
where the code lives, and run it before writing the status line that cites it. Incident (2026-08-07): the
lag-unification plan ruled "Everything — user-visible copy, FE identifiers, `src/` identifiers, the wire
contract", its closing gate greps `src api public scripts openapi.yaml`. Both greps returned nothing and the plan
shipped on that proof, while six cites to symbols renamed two stages earlier survived in `README.md`, `docs/dial-logic-explainer.md` and `docs/backlog.md` — all of them in
the docs stage, the only stage the gate could not see.
When a carve-out is genuinely needed (a dated wire response quoted as a historical record), mark the line
in-band (`<!-- lag-gate:historical-quote -->`) rather than excluding a path — then demonstrate the filter
suppresses one LINE and not a POPULATION by running the gate without it. A "known survivors" list beside the
gate is a survivors list, never a completeness claim: say so in it, or the next reader reads a green gate
plus a short list as full coverage.

## 78. An ANCHOR TOKEN is not the population: a name/ID grep cannot see what is spelled or phrased otherwise

A sweep asks a body-shape or claim-level question — "how many copies of `X` remain?", "does anything still
assert Y about id `Z`?" — but greps a **spelling**, so every instance a previous author named differently, or
phrased without the id, is invisible and the sweep reports zero. Every ordinary gate misses it: `tsc` and the
suite are green on a duplicate, the output diff is green, and **the absence of a site leaves no artifact
anywhere** — a reviewer sees only the sites that were found. A sweep keyed on a series id read 0-hits green
while two front-end files still described the retired spine in words — and a test pinned that copy verbatim,
so the wrong sentence was ASSERTED green.

**The move: grep the BODY, not the anchor.** For code, a distinctive fragment of the *implementation*
(`(n-1)*q`, `new Map()` + `.sort((a,b)=>b[1]-a[1])`, `toFixed(4)`), comment lines excluded; for prose, the
claim's own predicate rather than the id that usually carries it. Then classify every hit — duplicate,
near-miss, unrelated — and report the near-misses, which a name-grep hides equally.

**Falsifier — run both anchors and diff the hit sets; a non-empty difference is the class firing:**

```
diff <(grep -rln '<the id>'      --include=*.md --include=*.ts .) \
     <(grep -rln '<the predicate>' --include=*.md --include=*.ts .)
```

**Corollary — a helper's local NAME is evidence of nothing, including its own semantics.** A local named
`pct` was 2dp where the shared `pct` is 1dp. Name-based reasoning is what an extraction exists to stop; it
cannot also be the method that verifies it.

**Corollary — a name-based PROXY falsifier moves in the OPPOSITE direction from the real predicate during
the very sweep it is meant to track.** Where a body-shape predicate is expensive, the tempting stand-in is a
grep for the constant the duplicated block imports. But a converged site that *declines* a helper leaves a
SEAM comment **naming that constant**, so each conversion pushes the proxy UP while the real count goes
DOWN. Measured 2026-08-02 (the carriers round): `lib/replay-walk.ts`'s docblock claimed the
`FFILL_MAX_CALENDAR_DAYS` proxy read 4; it read 6, having been broken to 5 by the previous slice unnoticed,
while the real predicate went to 0. A proxy whose drift is *anti-correlated* with the thing it proxies is
worse than no proxy — pin the mechanism at the proxy's own site, or delete it.

Nearest sibling: §14 (a gate you author can be unsatisfiable by construction) — there the gate admits
nothing; here the search space excluded the answer.

**Corollary — a count-drop falsifier that greps a WORD cannot see the bare NUMERAL restating the same
count.** "There are 9 indicators" and "…all 9…" carry the identical claim, but only the first is reachable
from `grep -rn 'indicators'`; a roster change greens the word-grep while the naked numeral goes stale. Sweep
every digit-bearing line in the affected files, not the noun (`grep -rn '\b<old-count>\b' --include=*.md
--include=*.ts`), and read each hit's sentence — the grep must be able to return non-zero on today's tree
before you trust its zero tomorrow.

## 45 — a "sweep the derived claims" duty must enumerate EVERY table derived from the one you edited

A plan that names *the* derived table teaches the sweep to stop at one. `MEMBER_WEIGHT` in
`danger-ladder.ts` has **two** derivations over `Object.keys(…)` — `MEMBER_RELEVANCE` and `MEMBER_LABEL` —
and only the first was named. Deleting a row therefore dropped a member's display label as a side effect
nobody reasoned about, and the label feeds a live UI path (`meta-views.ts` → `lab.js` →
`feed-lag-foot.js`), where the failure renders only once that id starts lagging. `tsc` cannot see it: both
derivations are `Record<string, …>`, so a missing key is a runtime lookup miss, not a type error.

Incident (review): the BRENT drop's sweep was scoped to
`MEMBER_RELEVANCE` because §7.1 said "`MEMBER_RELEVANCE` is DERIVED — do not hand-edit it". Correct advice,
wrong quantifier. The regenerated snapshot showed `MEMBER_LABEL` 40 → 39 keys and the sweep still passed.

**The move:** before editing a table, grep for every construct deriving from it (`Object.keys(<TABLE>)`,
`Object.entries`, `Object.fromEntries`, a `.filter` over its rows) and list them in the plan, not one. Then
pin the invariant the derivation is supposed to hold — here "every `FAMILY_MEMBERS` roster id resolves to a
`MEMBER_LABEL` entry", which failed for three ids on the day it was written and so was demonstrably not
vacuous. ⚠ A test asserting `served === <TABLE>` is **tautological under the derivation** and is never
coverage for this class (`api/danger-model.test.ts`'s `body.memberLabel` was green throughout).

**Corollary — a DELETION's derived surface includes integer COUNT PINS that name nothing.** Removing a
member fans out to every assertion that counted the table, and not one of them mentions the removed id — so
the name-grep that scopes the removal reports the work finished while the pins still carry the old
cardinality. 2026-08-05 (the PMKT leg removal): a *display-only* leg dragged 32 files, about
half of them out-of-band count pins — `ALL_INDICATORS` 57→56, `BESPOKE_COUNT` 37→36, lab `EXPLICIT_OF`
12→11, the picker overlay 34→32, both-halves families 4→3. These go loudly red rather than silently wrong,
so the cost is **scope estimation**, not correctness: "display-only, therefore small blast radius" is a
claim, and checking it means grepping the **old count as a literal** (plus its `toBe(<n>)` /
`toHaveLength(<n>)` forms) alongside the name. Re-derive each pin from its source of truth rather than
decrementing it — a pin that was already stale otherwise stays stale at a new value.

## 54 — a sweep regex blind to the citation form its own rule prescribes reports a false all-clear

`plan-hygiene.md` §"Cite plan docs by stem" prescribes a directory-hint form. §"Deleting a SECTION
HEADING…" shipped the sweep for prefix-only `§` cites as `grep -rn "<file-stem>.\{0,3\}§"` — a span of at
most 3 characters between stem and `§`, while the prescribed forms put roughly fifteen there. So the sweep
could not see the very shape the same file recommends, and every run over a doc cited that way returned
all-clear while prefix-only cites sat in it.

Surfaced 2026-08-04 on the gp arc: the sweep reported 5 inbound `§` cites, all resolving; a sixth in
`derive-gp-shape.test.ts` (deleted) used the directory-hint form and was prefix-only
(`§Ruled contract — qimpag round 4` against `### Ruled contract — qimpag round 4, 2026-08-03 (Stage 3)`).
A commit message then recorded "5 cites … all resolve" as a completeness claim. Caught at review, not by
the sweep. Span widened to `.\{0,20\}`.

**Then the repair repeated the class one level up.** The corrected note said "the population is SIX" — also
false. Widening a span only reaches cites that carry the stem; the **stem-less** form `plan §Heading` is
invisible to a stem-anchored grep *by construction*, no span can fix it, and four more inbound cites to the
same target used it (all prefix-only). The general statement → §78 — so the anchored count is evidence
about matched cites, never a completeness claim. The durable fix is to close the un-anchorable form (a `§` cite
must carry its stem) and sweep for the form itself, not to keep widening the span. Absent that, the count
is reported as "N matched by the stem-anchored sweep", never as "the population is N".

**Then it repeated a third time, on the form that carries no `§` at all.** The 2026-08-07
`research-probes.md` condense deleted seven headings and repointed every inbound `§` cite; the sweep went
clean and the pass was recorded as closed. But 35 further docblock cites named the file *bare* —
`` (`research-probes.md`) ``, `` see `.claude/rules/research-probes.md` `` — with no `§` to anchor on. Each
still invoked the rule, and each now asserted a duty the rewrite had removed, so the prose was wrong in
exactly the way the `§` sweep existed to prevent. It took its own commit (`412ab42b`) after the pass had
already been called done. The bare form is not the tail of this class — it was the **largest** residue,
larger than the anchored population the sweep reported. A fourth order, `§`-before-stem
(`` §Ruled contract item 4 (`<stem>.md`) ``), is live too and equally invisible.

**The move:** when you author a grep as a rule's falsifier, run it against the rule's OWN canonical examples
first. If a documented-correct form does not match, the falsifier is vacuous over that form — and a count it
produces may never be written down as a population. Before a heading deletion, **enumerate the cite SHAPES**
(stem→`§`, `§`→stem, stem-only, `§`-only) and run one grep per shape; the shape with no `§` is the one that
decides whether the sweep was a sweep. Per-shape counts, never one number. Sweeps →
`.claude/rules/plan-hygiene.md` §Deleting a SECTION HEADING dangles refs.

**Class, generalised:** a falsifier and the convention it polices are two artifacts that can drift apart.
Whenever a rule file carries both a prescribed FORM and a grep that hunts violations of it, the grep owes a
demonstration that it matches the prescribed form. Sibling of §17 (the tightened-variant regex that matched
nothing); §17 is a regex wrong on its own terms, this one is a regex wrong only relative to its sibling
section.

## 55 — a plan's own ledger of its leftovers is not the POPULATION of its defects

A closing plan lists what it knows it left behind, and the next session reads that list as the work. It is
neither complete nor accurate: it was written by the context that made the mistakes. 2026-08-04, both entries
in one Stage 9 leftover ledger were worse than written — one cited `GP_BETA_FLOOR` as a shipped constant that
had never shipped at all, and grepping the other's *class* found a second instance the plan never recorded.

**The move:** treat each leftover as a **class specimen, not a census entry** — grep the class file-wide
before believing the count, and re-verify each cited symbol exists at HEAD (`git grep <symbol>`) before acting
on the entry. Report what the sweep found, never what the ledger listed. Sibling of §54 (an anchored count is
never a population) and of §53 (a range you cite is not the set you reviewed); the distinguishing shape here
is that the enumeration's **author is the defect's author**.

## 59 — a LINE-ANCHORED two-stage grep is not a file-wide falsifier; it goes green on a reflow

`grep -rn A --include=*.ts src/ | grep -i "B"` requires A and B on the **same physical line**, so its
"after: 0 hits" is satisfied by any edit that merely moves B onto the next line — no repair needed. A
commit recorded exactly that pipeline as the falsifier for "the set of false claims is complete" while the
repaired text sat on two lines; the set happened to be complete, but the recorded evidence could not have
shown otherwise.

**The move:** a falsifier over prose-in-code must survive line breaks — widen the first stage (`grep -iE
"timing|lead|lag"` rather than one exact phrase) and add a context span (`grep -A3 -B3`) so an adjacent
line still matches, then re-run and read the hits rather than the count. Also check the paired
"same shape returns N, so the pattern is live" line: it usually names a DIFFERENT shape than the one that
returned zero, which proves nothing about the zero. Sibling of §17 and §54 — those are regexes wrong on
their own terms or against a prescribed form; this one is a regex right in isolation whose PIPELINE adds a
line-adjacency premise nobody wrote down.

## 71 → merged into §22
