---
paths:
  - "src/registry.ts"
  - "src/family-descriptor.ts"
  - "scripts/new-indicator.ts"
  - "docs/reference.md"
  - "src/chart-rail.ts"
  - "public/detail-chart.js"
---
# Indicator loop — process

Working on an indicator arc (adding, retuning, or retiring one).

## A retune is a ONE-place edit — never restate a cut's value

`registry.ts` is the single source for an indicator's cuts. **Do not copy the current numbers into a
docblock, a test fixture, a mock level, a plan doc, or `docs/`/`public/` prose** — every copy is a second
source that has to be hand-found on the next retune, and neither `tsc` nor the goldens see it rot.

- **Check where the id resolves its cuts BEFORE promising a one-place change — for many ids the registry
  pair is not the live cut.** Two seams break that, both routing through `CALIB_MAP` (`domain-cuts.ts`) →
  `docs/reference.md` §[indicator] Where each indicator's bands live.
- **`scoring_constants.json` is a SECOND source of a cut** — the Python side reads it, not `registry.ts`,
  so a swept-cut retune re-emits it *first*, then replays.
- **Verify a cut retune by real-close replay, never `sim:notify`** → `research-probes.md`
  §`sim:notify` is not evidence.
- ⚠ **A golden snapshot is NOT a value pin for a CUT.** `golden-charts.json`'s band rows carry
  `{axis, level, metric, source}` and **no `value` key**, so this file's "perturb the cut — only the golden
  may redden" is FALSE for any id whose golden fixture sits far from its cuts. Corollary: a fixture DERIVED
  from the cut it tests pins WIRING only — it passes for a value 33× wrong.
- **Grep the OLD value repo-wide before calling a retune done.** Size a test pin through the helper the runtime
  uses, never off a raw band/descriptor field (it keeps asserting the retired geometry, green).
- **Key a provenance-doc `##` by the ENTITY id only** (`## TC.F1 — HY OAS`, never `… \`coin\``) — a value in
  a heading is a second touch point nothing pins; the value belongs in the section body's argument.

## Drawing a second axis or leg

- **Every scored leg gets its chart row in the SAME ship** — a leg that scores but is not drawn leaves the
  ribbon contradicting the visible lines (R6's moving pair scored AMBER under a drawn absolute-105 cut,
  2026-08-30). When a stage adds or remaps a scored leg, its `detail-chart.js` row + `chart-rail.ts` series
  are focus files of that stage, never a later cut-stage's.
- **A display fallback requiring BOTH legs of a pair silently freezes an axis the scorer reads a measured
  cut on** — an amber-only velocity axis (by design, e.g. F3/R2) then draws its degrade-fallback prior
  instead of the real cut, with every test green.
- **`cadence` states the RELEASE schedule, not the observation grid — never caption a span off it, and
  never add an arm to a cadence-keyed word map without enumerating every id that resolves into it.** G1/BRENT
  declare `cadence: "weekly"` over business-day rows, so their spans are TRADING days; check `nObs` in
  `scripts/backtest/synth_cuts.json` (genuinely weekly ≈ 783, business-day grid ≈ 3700) rather than
  trusting the field, and override the word with the id-level `obsCadence` without touching the span. Run
  the resolution expression over `ALL_INDICATORS` and diff the before/after word per id BEFORE changing the
  map — a captioning flip is invisible to `tsc` and to the goldens.

## Plan-time checks

- **Paste the touch list that `npm run new-indicator -- --dry-run` printed into the arc's plan doc.**
  Without it the per-indicator fan-out gets rediscovered by grep every session.
- **Resolve the scored-vs-context fan-out before naming cut values.** A plan that writes cut values and
  `thresholds: {}` in the same breath specifies a card that can never fire — the op leg is read off the
  registry `Thresholds` (`reference.md` §[arch] 9. Cross-file design invariants), so a CONTEXT-only registration scores GREEN forever.
- **A cuts round offers the hand-set route (`reference.md` §[arch] 4. Conventions) with the distribution IN the
  previews** — percentiles + per-candidate firing-day share + episodes lit, as ASCII (a FRED id is one
  `fredgraph.csv` curl). An expanding-percentile cut is ruled as `cutPctile` + `cutClamp`, never a number.
- **A scorer-BODY change bumps that id's `Indicator.logicVersion`** — `make ship`'s `probe:vintage-drift` gate
  restates only on config-hash/`logicVersion` drift, and persisted `readings.state` is served unscored.

## Keep-or-cut — an indicator earns its place

- **Default REMOVE or DEMOTE off the alert path; KEEP is earned, never fitted** — don't move a cut to rescue a
  weak indicator. Retiring one, trace its consumers first: a confirmer often feeds exactly one gate — retire both.
- **On-screen value = topical relevance to the board's purpose**, not "does it move the ladder".
  Answer a keep-or-cut challenge by each line's SOLO days-fired, measured — never by its role.
- **A measured percentile cut owes a window whose SPAN contains the stress it marks** — `PCT_MIN_OBS` /
  `synthHistoryUsable` certify depth only; a calm-only window lands an easier cut than the hand-set prior.

## One indicator arc per session

Two interleaved golden rebaselines make neither diff attributable to its own change.

---

Full per-indicator fan-out (every file that carries a per-indicator entry) → `docs/reference.md` §[indicator].
The verification gate and release path → `dev-workflow.md`.
