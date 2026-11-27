---
paths:
  - "**/*.test.ts"
  - "public/*.test.js"
---
# Tests (crash-dash)

Verification gate → `dev-workflow.md`; FE-suite mechanics → `frontend.md`. This file carries assertion
validity — the red-demo duty, guard vacuity, vitest mock isolation — and what a test costs per run.

## A magnitude/age bound with no boundary fixture is unpinned

**W5-a-FIX-1 pairwise-age lesson** — the cash-overlay pairwise age bound sat in THREE prose sites and NO
test; deleting `cursor = row.date` left the suite green.

## A guard's vacuity anchor must not certify the thing it exists to catch

Anchor a defect-finding lint's vacuity floor on something the fix MOVES, never on the population it drains
(`expect(FOUND.length).toBeGreaterThan(0)` reds on the day the guard succeeds) — e.g. the key the rule
pivots on as it appears at call sites, plus one unrelated high-count fixture key only a broken walker/parser
can collapse. Over a roster, never an exact count (it churns on every legitimate add): anchor on a named
stable member or `> 0`, and turn a never-taken `continue` into an assert. Exclude the guard's own file from
every anchor, or a later edit lets it satisfy itself. Conversely, a guard asking only "did the measure move
at all" goes GREEN on a degenerate arm: pin it to the **discriminating column**, not the total.

## A fixture DERIVED from a constant goes vacuous when that constant is retired to zero

Deriving fixtures from the constant (never restating it) is the standing rule — but the derivation itself is
an unpinned claim: `CONST - 1` reads as "one short of the gate" only while `CONST >= 1`. Retire the gate to
`0` and it silently becomes `-1`, so the test passes on every input and nothing reds. **Recognition cue: an
arithmetic offset from a constant whose plausible future includes 0.** Retiring any gate constant therefore
owes a repo-wide grep for offsets off it — not just a run of the failing suites, since the hollowed tests
stay GREEN. **Never pin a constant's value** (`expect(CONST).toBe(n)`, [USER] 2026-10-18): guard the
derivation's premise instead (`expect(CONST).toBeGreaterThan(0)`), so a retune stays green and only a broken fixture reds.

## Every new assertion owes a mutate-and-confirm-red demonstration

**Rule: mutate the exact line the assertion guards and confirm the failure before calling a stage verified.**
This binds test assertions exactly as it binds authored falsifier greps.

⚠ **Scoped to NEW or CHANGED guards.** A data-only edit that leaves every assertion's text untouched — a cut
retune, a combine-mode flip, a window change — owes no
demo: re-running one for an existing guard re-proves what its own shipping demo already proved.

Assertion-level vacuity cues → `docs/claim-verification.md` §4.1 Vacuity cues.

## A consumer test on a hand-set fixture never verifies the writer → consumer seam

Build at least one fixture from the real writer's output (e.g. `applyRun`'s state), never only a hand-typed shape.

## `isolate: false` silently no-ops a `vi.mock`

⚠ `isolate: false` does not error on a `vi.mock` — it **silently no-ops** whenever an earlier file in the
same worker already imported the real module, so the test then runs against the real seam (`api/health-view.test.ts`
and `api/meta.test.ts` reached live Supabase at 7s/test). `src/isolation-manifest.test.ts` is the standing guard;
`ISOLATION_SEAMS` covers `mock`/`doMock`/`spyOn`/`stubEnv`/`stubGlobal`/`useFakeTimers`/`setSystemTime`,
a `globalThis.x =` assignment and a `process.env` WRITE — a bare env READ is inert and stays in `shared`.

## A probe hosted in a PASSING test prints nothing by default

vitest 4's non-TTY default reporter swallows stdout from a passing file — run a test-hosted probe with
`--reporter=verbose --silent=false`, or its measurement is silently absent.

## Cost

File count → `ISOLATED_TESTS_BUDGET` (`vitest.shared.ts`); time → the per-test ceiling in `scripts/test-budget-reporter.ts`.

- **Never propose a NEW byte / count / response-size ceiling** — gate structure with intent rules in `npm run check` and alert on prod outcomes against externally-set thresholds. Code-file size only as a no-growth ratchet that never forces moving existing content.

- **Pick the cheapest seam that still touches the wiring you pin**: a direct call → `assembleRun` → `runScoringCycle` only when persistence or push order IS the subject.
  ✗ `run.wiring`'s db-first describes drove 17 cycles to read fetch options → `resolveDbFirstArm`.
- **An env-gated lane that nothing arms is a coverage deletion** — grep that some lane EXPORTS the var, not only that the gate reds when unset.
  ✗ `UPDATE_BUDGET` was exported nowhere after rung 2.
- **Gate a lane on an env READ; never write `process.env` in a test** — a write (`.X =`, `[k] =`, `delete`, `Object.assign`) re-isolates the file.
  Falsifier: `vitest run --silent=true src/isolation-manifest.test.ts`.
- **An IO function takes its seams as defaulted params** — `fetchImpl`, `log`/`warn`, timers, store/`storeOf` (a read-handler's `handle(store | storeOf, req, opts?)`, `GET` request-only), a job table — but `now`/`clock`/`env` are REQUIRED params (`src/boundary-guards.test.ts`); the first `vi.mock`/`spyOn` on a static import isolates the whole file.
  ✗ `fetchEbp`, `fetchCape` (audit 8 F8/F9). ✓ `seedInputSeriesOnCron`'s `feeds` — its `realFeeds` default delegates lazily, so `spyOn` still bites.
- **De-isolating a file owes a file-level `beforeEach` reset of every module latch a run cycle arms** (memo, intraday latch, run budget, price-feed cache) — file order on a shared worker reds it otherwise (`--sequence.shuffle`).
  ✗ `prices.test` red 2/71 beside `run.wiring.intraday` at seed 3.
- **A pure exported function is tested at its own layer; the handler test asserts only that the value reaches the wire** — extracting a shared seam moves its callers' edge-case tests onto it in the same commit; an inline expression pinned by ≥ 2 cycle tests is extracted.
  ✗ `computeLegAttribution`, the `lab-overlays` views and `buildIndicatorChart` had zero direct tests.
- **Keep an isolated handler's tests in ONE file, fixtures seeded inside the `describe`** — subject-splitting is cheap in `shared`, a full re-import per file in `isolated`.
  ✗ the two 1-test `status-feedlag-*` files.
- **Assert each fact once, at the layer that owns it** — grep `<fn>(` across `**/*.test.{ts,js}` first; a new id on an existing engine is a new `each` row, and ids sharing one code path collapse into one collecting assert.
  ✗ `run.alert-state` restated the `dialBand` projection `store.pure-seams` owns; `growth-hold`'s eps>0 twin.
- **A review brief for a diff touching `*.test.*` names this §Cost and global gate check 3 as criteria**, and asks for each new test's decisive assertion plus its other sites, the isolated-file delta and the `npm run test:slow` collect/test-ms delta of the touched files.
- **An expensive result — cycle, GET, replay, render — is computed once per world (`beforeAll`/describe const); worlds needing different mocks never merge**; an `expect` inside an N×M loop collects violations and asserts once.
  ✗ `status.test` 9 calls / 3 bodies, gdc XDEV ×6, `prose-names`; `run.wiring`'s FAILED / SUPPRESSED no-email pair.
- **Expensive fixture work goes in `beforeAll` or a lazy memo, never module scope** — module scope is invisible to the per-test ceiling; `npm run test:slow` lists per-file collect ms.
  ✗ event-study's 5× `runEventStudy()` at module scope, 2.3 s (audit 8 S4).
- **Bound a property loop by its own saturation flag and assert the floor** — a loop sitting AT its asserted floor is not re-trimmed.
- **When the reason a snapshot, golden or parity pin was added is discharged, replace it with targeted asserts or delete it** — an exemption list that grows with each feature is the discharge signal.
  ✗ `detail-chart`'s generic ≡ bespoke snapshots outlived the bespoke renderers.
