---
name: <leg>
description: ONLY on /<leg>.
---

Takes the tranche probe's verdicts **unchanged**, researches one sourced line per qualitative criterion, and
writes it to the live state; the chat gets the delta only. A hold can turn a probe `✓` into `HELD`; nothing here
turns a `✗` into a `✓` or fills a tranche.

**`public/<leg>.json` is the only input and the only artifact**, rendered to `docs/<leg>.md`. **Never `Read` it**
and never edit it by hand — `<leg>:state` prints what the run needs, `<leg>:apply` is its only writer. The leg's
research set under `docs/plans/` is never opened on a run.

**The leg's facts come from the `<leg>:state` print, never from memory**: `brief.fund` (the held fund — a weight or
composition is checked at the issuer, never recalled), `brief.primaryTier`, `brief.holdsPolicy`, `brief.gates`,
`brief.eventScope`, and `leans` (the leg's `lean` vocabulary).

## Process

A run is ≤ 7 assistant turns (probe, unless the prompt carries it · Rung 0+A · Rung B · patch + apply · print). Every web call goes through
ONE foreground `Agent` call to `ladder-research` per rung (never `run_in_background`); a `WebSearch`/`WebFetch` of your own is a defect.

1. **Probe + plan.** A prompt carrying the `<leg>:state` print (a timer run) IS this step's output — no call. Otherwise ONE Bash call from the repo root:
   `npm run -s probe:<leg>-tranches -- --into=public/<leg>.json >/dev/null && npm run -s <leg>:state`.
   A non-zero exit → print the output and stop; never research on top of a missing verdict.
   - `verdict.close[]` / `verdict.live[]` = the tally (live = provisional head, not a purchase); a third is ✓ on its own legs or
     by the leg's follow path (`via` names it). `verdict.inactive`, when printed, is the other set — **never a verdict, never a
     reason for a hold or a fill**; `verdict.escalation` is inside the tally — it moves no hold here.
   - `research[]` = the rows due this run, with their calls; `measurable` = the criterion a finding is
     judged against (`measurable` carries the row's level).
     `situationOwed: true` → step 3 fixes what `situationWhy` names. `research: []` → skip to step 4 with `{"signs": {}}` (+ the owed `situation`). `today` / `now` go back to step 4 as printed.
   - `armRules` = the rule for each rare arm the state prints — follow it at the step it names.
   - `research[].board` = the live board reading of the families the row feeds (`—` when none) — the skill's input; a
     `finding` names no board figure, it describes the reading in words.
   - `research[].measured` = the row's own `measure` script's reading: `{asOf, text, sources}` is a finding dated `asOf` — judge `text`
     against `measurable`, quote it whole (its leading `<source> <close|intraday> <MM-DD>` dates every figure) and cite its `sources`. A `measuredOnly` row has no calls — its `measured` text + `sources` are the finding; keep its stub's `measuredOnly`. `{error}` → calls are back, step 5 prints it.
   - `events[]` = the deciding events (pending, `mixed:`, ≤ 14 d, `findingOwed`; rest: `eventsSettled`): `signs` = the rows each is about;
     `escalationIf` / `fizzleIf` = the two sides a sourced outcome is tagged against. `calendar[]` = unverified dates in the next 14 days.
   - `eventsLater[]` (`<event> (<date>)`) = known deciding events past the `events[]` horizon — never `eventsAdd` / `calendarAdd` them.

2. **Research** each `research[]` row in two rungs, each ONE `ladder-research` call whose prompt lists the rung's calls per row with
   the row's `since`; it returns `row | date | url | fetch or search | fact | ok or FAILED` lines. In-window = dated on or after the row's `since` (today − the longer
   of 14 days and the row's `cadence`).
   - **Pre-run mode** — a prompt carrying `rungA` (the Rung 0+A table) + `prelabels` = Rung 0+A done, no call; read `rungA` (+ `rungB`) as its table.
     Carrying `rungB` too → Rung B = only the opening fetches per landing candidate; without it, Rung B as below.
   - **Rung 0 — horizon + dates, in Rung A's call.** Search each `scan` query and each `verify[].query` — a `verify` row carrying `fetch` lists that issuer page first, its `query` searched only when the fetch cannot date it (`in order`). A dated item no
     `events[]`/`calendar[]` row holds → `calendarAdd`; a source dating a `verify` row → `calendar` `{verified, date}` (an event → `events` `{date, verified: true, sources}` — a ★ event within 3 days stays on `verify` until a `sources` host is primary-tier).
   - **Rung A — every `fetch`, `query`, `sides` and `more` call of every row, in ONE call.** Each URL in `fetch` (one fetch serves every
     row listing it), each `query`, every `sides` query (`escalation` + `fizzle`, or one merged `both` — label the row only after reading them) and each
     `more` query. A `FAILED` line goes in the row's `failed`.
   - **Rung B — `extended`, dating + opening, ONE call, only when one is owed.** Every `extended` search (one per row whose `extended` is true — an event
     within 3 days, or the row holds no in-window source after an earlier run and had no extended search in the last 7 days — and that still has no in-window finding), every dating
     fetch of every row, and ONE opening fetch per landing candidate (an outcome or BLOCK source that came back `search`, or the landed sibling `sources` URL the own event would land on). **No dating fetch** for a row holding one in-window source; at most ONE per row; still undated after it → date it from
     URL/title/snippet, never a third call. Never list a dating fetch to a domain that failed this run or to `roic.ai` (403s fetchers; its URL ends
     `-MM-DD-YYYY`) — date it from URL/title/snippet.
   - A finding = a table line's fact + date + URL; an undated line is dated only by Rung B. Prefer `brief.primaryTier` over press; never fill a row from memory.
   - **Source grade** — primary tier = issuer / agency / regulator pages and data originators: a source is primary-tier iff its
     host or a parent domain is on some row's `primary[]` or in `brief.primaryTier[].hosts` (news and republishers sit in `press[]` — fetched
     alike, graded press); any other host is press. Write the
     bare lean: `<leg>:apply` appends ` (press only)` (a `block: true` or escalation-group lean citing no primary-tier source),
     ` (single-source)` (a `block: true` row citing < 2 distinct hosts) and ` (draft)`. A landed event status cites its own `sources` — ≥ 2 distinct hosts, one primary-tier — or carries the same tags.
   - **Judge** (2b) — before labelling, read each finding against the row's `measurable` clauses (`<lean> = …`) and its `board`
     reading: the clause the finding meets is the row's `lean`.
   - **Label** — `CHANGED` when an in-window finding contradicts or sharpens the row's `finding` (compare facts,
     not dates); otherwise the first that applies (`MM-DD` optional — apply writes the newest source's date):
     | label | when |
     |---|---|
     | `UNCHANGED [MM-DD]` | an in-window finding that agrees with the row's fact; a row whose `held` is set and nothing contradicts → `UNCHANGED`, no dating fetch; when the finding postdates the fact `finding` cites, the patch rewrites `finding` to the fresher fact (lean untouched) |
     | `STALE [MM-DD]` | a same-year finding older than `since`, its source in the patch — never `CHANGED`, never settles an event, never a BLOCK or its reversal |
     | `QUIET since <MM-DD> [url]` | a `no item on the row` line (a fetched listing, none on the row's subject) — `MM-DD` = `since`, or its date (the oldest item) when later; `url` = its URL |
     | `UNSOURCED` | none of the above — a failed fetch counts as no page; a better stem that showed up → `searchNext` (step 3), never a search for the user to run |
   - A row with a non-empty `replace` gets a new `primary` list built off the printed `primary`: each `replace` page swapped in place for the page
     the search found, or dropped (the same list minus that URL); a lone failed page is swapped, never dropped.
   - A `calendar[]` row a source confirms → `verified` + the corrected `date` in the patch.

3. **Patch** — `Write` `<scratchpad>/<leg>-patch.json`, a `LadderPatch` (`src/ladder-run.ts`), filling the `patch` stub:
   - Pre-run mode: start from `prelabels.patch` (mechanical rows filled); replace a mechanical label only by adding an in-window source; step 4 adds the prompt's `--prelabels=<path>`.
   - `patchForms` = each listed field's allowed form.
   - `signs` — exactly the `research[]` rows: `{label, finding?, lean?, sources?: [{date, url}], block?, unblocking?, pin?, causeFalse?, failed?, primary?, measurableDraft?, searchNext?}`.
     `searchNext` — on a row still lacking an in-window source, ONE better stem (no current/past year, month name or MM-DD — a forward year like 2027 or a report like FY27 Q1 stays; the plan appends the month) the next run searches under `more`.
   - `finding` (`<fact, source date>`) + `lean` on `CHANGED`; `finding` alone on `UNCHANGED` when its source postdates the
     one the row cites — that postdate check is yours (apply does not date-compare it). `lean` ∈ the `leans` the state prints; `unknown` may be bare
     or `unknown until YYYY-MM-DD` (`unknown` → any neutral-group lean is silent in the delta); write the bare lean — apply appends the grade tags.
   - A landed event rewrites the `finding` of each `signs[]` row it names (`CHANGED` when the lean moves). A `findingOwed` row stays on `research[]` until its
     finding is rewritten citing a source dated on/after the event's outcome — the event's own outcome source qualifies.
     `causeFalse: true` on a blocked row at a neutral-group lean, its cause sourced false (`CHANGED` / `UNCHANGED MM-DD`): the first run stamps it, a second ≥ 7 d later lifts the block.
   - `block: true` only when the row's `BLOCKING = …` clause in `measurable` is met
     **and its source line came back `fetch`** — cite ≥ 2 distinct hosts, one primary-tier, or the lean carries the step-2 tags;
     Apply lifts a block on its cause-matched fizzle (an event in its escalation's `liftBy`; a manual / `liftBy`-less block: any naming the row), its `liftBy` event's new `mixed:` sent with `offCause: true`, or a fizzle lean;
     an unrelated fizzle demotes it one tier; else `block: false` on a sourced reversal (not `QUIET`/`STALE`).
     A held block re-confirmed by a fresh sourced escalation-group source may carry `pin: "<YYYY-MM-DD>"` (≤ today + 21 d): through that day a stale review neither demotes nor releases it.
     A NEW block needs an `UNBLOCKING = …` clause in `measurable` — else send `unblocking: "<what lifts it>"` (appended). `stuckProne` → add a dated event (`eventsAdd` it if new) to `events.<by>.liftBy` (send the whole list — it replaces) (a manual / `liftBy`-less block: `eventsAdd` one naming the row), dated ≤ its review.
   - `events` — `{"<event>": {status: "escalation: <outcome, date>" | "fizzle: <outcome, date>" | "mixed: <outcome, date> — unchecked: <clause>", sources?: [{date, url}], date?, verified?, liftBy?: [<undoing event>], spares?: [<sign>], offCause?: true} | {drop: "<why>"}}`,
     an `escalation:` (here or in `eventsAdd`) that blocks a row needs `liftBy`; `spares` = its listed rows it leaves unblocked (due every run till the cause resolves).
     only for a sourced outcome (a `fetch` line), a sourced date move (`verified: true` once source-dated), a `pre <date>:` read or `{drop}`; a landed status carries its `sources` (they replace the stored list; step 2's grade). `fizzle:` only when EVERY clause of the event's
     `escalationIf` is sourced false; one unsourced clause → `mixed: <outcome, date> — unchecked: <clause>`.
     **The payer's own tape is a clause of every print** ([USER] 2026-10-31): a report-day close that is the issuer's worst on record (or worst in years) on raised or
     reaffirmed spend is never `fizzle:` — land it `mixed: <outcome, date> — unchecked: tape` (the market read the raise as spend without return), or `escalation:` when `escalationIf` names the tape.
     An event the state prints with `expect` (user-set consensus) lands with `vs cons <x>` in its status.
     A `mixed:` event keeps its tranche hold, sets no block, and its rows are re-researched every run until you re-land it
     `fizzle:` / `escalation:` — on a block's `liftBy` event whose unchecked clause is not the block's cause, send `offCause: true` with it: apply lifts the block. `eventsAdd` — a newly announced event a source names as deciding for `brief.eventScope`
     (`signs`, both sides, `holds` per `brief.holdsPolicy`, `secondary`; optional `status`, `sources`, and `at`: `pre` a pre-US-open print · `close` the US close · default `post`, after hours — the slot from which its outcome is owed).
   - `calendar` — `{"<event>": {verified, date}}`. `calendarAdd` — a newly announced dated item that is not
     deciding — `sign` names its `signs[]` row; omit `sign` when no row fits (it renders under "Dated, no sign"); `matters` optional.
     An `eventsAdd`/`calendarAdd` `event` is the bare title: the date's provenance or doubt (`est.`, `~`, `[conflict]`, who dates it) goes in `dateNote`, never the title.
     **No dated figure in `eventsAdd` / `calendarAdd` / `measurableDraft` text** (an odds %, a y/y %, a positioning count — true only as of a date): write the rule (`hike priced`, `exports turn negative y/y`); the figure goes in the row's `finding` or, for a pre-event read, in the event's `pre` status — a rule's own threshold (`≥ 1.5`, `+75 bp`) is not a dated figure.
   - A `CHANGED` row, a landed, added or re-dated event, or an `all:` `situationWhy` (age, tranche flip, watch grade) → `situation`, all five slots `lean` · `slow` · `fast` · `decides` · `flips`; `<slot>:` reasons only → those slots
     (Lean: the conclusion — where the leg stands and what it commits the holder to · Slow threat: the grind and its carrier · Fast threat: the gap and its trigger · What decides it: per dated event, which slot it moves and which way · What flips the lean: the fact that moves the lean a group) — ≤ 2 sentences each, plain language.
     A slot never restates a metric, gate, criterion, cluster vote, tranche count or board figure — the Verdict / Blockers / Episode tables hold them; apply refuses gate / cluster / family names, `✓`/`✗`, `n/m`. A slot no window event touches stays byte-identical (unless it dates an event landing this run); the rest are rewritten. No slot dates a day before today (bar a `close`/`intraday` stamp); `decides` names by MM-DD each `decides: misses` event and each `eventsAdd` ≤ 3 days out (≤ 31 if it holds a tranche).
   - A `verdict.watch` in the state print → the `lean` slot opens with its `grade` — no row names, no numbers.
   - **No board number in `finding` or `situation`** — the grid and probe-row cells render the number;
     describe a board series in words (`CCC above the 12.5 % bear line and rising`); a licensed level, board or not — an index level (credit spread, vol index, CAPE) or a vendor close (equity, ETF, FX, commodity spot — the leg's own fund too) — never print the number: state it against the criterion or its move (`SPX above its 200-day`, `−4.7 % on 10-08`, `USD/JPY just under the 160 line`); apply refuses a quoted level or close; any other non-board figure only as `<source> <figure> <intraday|close> <MM-DD>` (`Bloomberg 154 bp intraday 10-02`), never bare or `~`.

4. **Apply + commit** — in the SAME message as the `Write`, ONE Bash call:
   `npm run -s <leg>:apply -- <patch> --today=<today> --now=<now> && git commit -q -m "docs(<leg>): live state <YYYY-MM-DD>" -- public/<leg>.json && git log -1 --format=%h`.
   The script writes everything else, renders the md and prints the delta — whole when it fits 600 bytes, else its first line + `delta in docs/<leg>.md` — then the `ntfy` line. A `<leg>:apply —` error names the patch defect: fix the patch with `Edit` (drop a key: `old_string` `"finding": "…",` → `new_string` ``; add a missing row: insert it after `"signs": {`), rerun the call.
   ⛔ Never reshape the patch through Bash (`node -e`, `jq`, `sed`, `python`, `cd … &&`) — a headless run allows only `npm run` / `git commit` / `git log`; anything else is denied and pages the user.

5. **Close** — a headless run (the runner's prompt says so) replies `done` after a successful apply, else the last `<leg>:apply —` error line; the runner journals the rest.
   Interactive: print apply's output with the commit sha appended to its first line, then only the `pressDead` entries and each `measured` `{error}` (step 1). **`brief.gates` are price/credit
   facts, not research rows — a run never argues one open.**
