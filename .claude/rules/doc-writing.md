---
name: Doc writing — moves, not narrative
description: What an unattended write to docs/**.md may admit, and the delete that must ride with every add
paths:
  - "docs/**/*.md"
---
# Doc writing — moves, not narrative

The two-line unit and supersede-by-replacing are global → `~/.claude/rules/prose-budget.md`. This file
carries only what is project-specific.

An observation you were not asked to write down goes in the **commit message**. It goes in a file only when
it (a) supersedes a line already there — rewrite that line — or (b) can be spelled as a value, a symbol, or
a command that returns non-zero. A net-new comment, docblock, `##` section or test name that supersedes
nothing and spells as none of those is not shortened; it is not written.

Write the retune into the `.ts` — the VALUE, plus at most the one line that binds the next edit
(`~/.claude/rules/prose-budget.md`; displacing a doc's narrative into a docblock is the violation,
not the fix). Write into the doc the one line that binds the next edit, **and delete the line it
supersedes** — `git show` keeps it.

⚠ **Check inbound cites before deleting** — `docs/` prose is cited from `src/*.ts` docblocks by `§` and, in
the provenance docs, by round marker. Repoint the cite in the same commit (`plan-hygiene.md` §Deleting a
SECTION HEADING dangles refs exactly like deleting a file).

## The writable set — each target with one admission row

Every `.md` outside the table is **read-only**: no append, ever — `docs/plans/archive/**` and the
merged-doc stubs. A write to any of them is the defect. `memory/<topic>.md` is
the one frozen-but-not-sealed target: its row below grants a mint, and only against a deletion.

| target | admits | refuses |
|---|---|---|
| `docs/reference.md` | a live value, the one move that binds the next edit, a falsifier — **only on the SECOND time a session re-derives it**, and the add names the earlier one. **One in, one out at the same write**: the add deletes or absorbs the weakest sibling in its section | why, history, measurements, status; a first-time fact (→ the commit message) |
| `docs/backlog.md` | **one 2-line unit** (`prose-budget.md`): ⚠ symptom · seam · falsifier — the falsifier is a COMMAND, never its demonstration — **and only if it is OWED: someone would act on it now**. **Deleted in the commit that ships it** | narrative, rationale, an item with no seam; the discovery story, provenance past one date, corrections of the entry's own earlier text, evidence a commit/probe holds; anything already ruled not-worth-doing (*nice-to-have, parked, refuted, benign, unreachable today*) — that hedge is the refusal, not a qualifier |
| `docs/backlog.md` §OWED[USER] | one line per open decision, deleted when ruled | the options, the trade-offs (→ the asking message) |
| `docs/backlog.md` §Plan-doc menu / §In-flight | stem + ≤1 hook line per doc | rulings, ⛔/⚠ restatements of the plan's own sections — the plan doc owns those |
| `docs/*-provenance.md` | one `## <id>` section = the live constraints for that id. A retune **replaces** the section | `###` round logs, a VALUE the `.ts` already carries |
| `docs/claim-verification*` | one class, **only when [USER] asks for it** (`plan-hygiene.md` §Claims) | a class minted mid-arc as a side effect |
| `docs/dial-logic-explainer.md` | nothing — its [USER] `mEff` mermaid one-shot is SPENT | every write; the doc is read-only |
| `public/<leg>.json` + its local md (`eufin`, `value`, `semis`, `spit`, `sp500`) | `/<leg>`, or `scripts/eufin-run-local.sh` on a `research: []` run (same commands) — `verdict` via `npm run probe:<leg>-tranches -- --into=public/<leg>.json`, every per-run field + the md via `npm run <leg>:apply -- <patch>` (`rules` + the user-set sign fields hand-set in the JSON, then `npm run <leg>:render`) | any other writer; a hand edit to the md; a 6th `runs` row |
| `docs/plans/**` | staged decisions and the edits that implement them — `id \| ruling \| edit site` | session narrative, measurement dumps, rejected-option prose, findings restated from the commit |
| `memory/project_state.md` | the ONE armed task + chain/sentinel state | everything else → `docs/reference.md` (durable) or `docs/backlog.md` (owed) |
| `memory/MEMORY.md` | one line per memory file, plus its three-line ⛔ admission header | any other content; a status |
| `memory/<topic>.md` | frozen — a new one owes a deletion in the same write | a second file on a topic already held |

The provenance docs are read by `grep -n '^## '` then a single-section read — that read is only cheap while
the section stays at its row's shape.

**The `.ts` stays the only source of every VALUE** (`indicator-loop.md`).
A number reaches a doc only as a measured input the `.ts` cites and cannot itself carry — a number the `.ts`
does not yet carry goes into the `.ts` first, not into the doc.
