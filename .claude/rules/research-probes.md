---
paths:
  - "scripts/probe-*.ts"
  - "scripts/backtest/**"
  - "src/families.ts"
  - "src/danger-engine.ts"
---
# Probe / backtest evidence discipline

Gate itself → `dev-workflow.md` §Verification gate.

## Evidence ladder — take the cheapest rung that can answer

0. A "prod is stale" symptom: fetch the upstream source directly before touching prod.
1. A direct production-scorer run over the live feed — a scratchpad `.mts` importing `src/` by absolute path.
   It answers a question; anything a plan's §Verify cites or a retune re-runs is rung 2.
2. A committed `scripts/probe-<topic>.ts` + `probe:<topic>` entry on the shipped fetch/scorer seams — for
   stored state, prod vintage, or a re-runnable check.
3. A backtest (`scripts/backtest/`) — only for historical event performance.

Climb only when the rung below structurally cannot answer — never for extra confidence.

## The instrument is a claim too

- **A decision measurement reads the PROD DB, read-only** (`bash scripts/with-prod-config.sh tsx <probe>`).
- **A post-write assertion polls the table, never an edge-cached endpoint** — a `Cache-Control: no-cache` request
  header does not bust `s-maxage`; HTTP is admissible only with `x-vercel-cache: MISS` (`reference.md` §[prod] 4).
- **Grep which scorer/knob the restate or probe path resolves to for that id** — one wired through a RETIRED
  scorer measures a ghost and exits 0. A recompute that DROPS an input cannot see what that input drives.

## `sim:notify` is not evidence

It synthesizes confirmed STATES directly, so it never reaches `resolveCuts`, never emits
`delta20`/`evaluateLegs`, and carries no fold history — a green sim says nothing about a cut-layer,
leg-attribution, within-band or stateful-trigger change. Verify by real-close replay (`npm run probe:top2`,
`scripts/probe-*.ts`, or a cut-layer test).

**"Cut layer" is TWO seams.** `resolveCuts` (`domain-cuts.ts`) is the indicator calibration-cut seam;
`DANGER_CUTS` (`danger-concentration.ts`) is the share-lit danger-scale leg-RAG cut. A test at one proves nothing about
the other.

## The `DANGER_CUTS` gate

Measure the move and leave the cuts alone — absorbing it by nudging the cuts spends the drift budget.
Re-derive ONLY on a roster/structure change (a retired feed, a member seated or unseated on a
leg, the replay instrument itself); a pure weight change is not one.

## A conditional-return claim owes a PLACEBO arm

Rotate the trigger's RED labels forward N days (same count/clustering, wrong dates) and re-measure. The arm
count caps the p you may pre-register — a permutation p over N arms bottoms out at `1/(N+1)` — so fix N
before fixing the bar.

## A panel over a level-arm mask prints base rates + anchor counts

**D3 base-rate lesson** — F9/F11's level arms fire on 54.7%/34.1% of ALL days under `cuts: undefined`; any
panel over these masks must print base rates + anchor counts.

## The leg probes share code by import

A function another `scripts/probe-*-tranches.ts` defines is imported or extracted (`ladder-tranche.ts`, `ladder-replay.ts`), never copied; its generic
tests live once there, and a per-leg branch names its output-quality reason in the commit. Guard: `scripts/probe-tranches-shared.test.ts`.

## Three smaller traps

- **Never quote a probe fire-count as a prod count.** The probe walks a contiguous series; prod truncates at
  the first calendar gap or null `dial_target_rung`, and ignores `CASH_PRIOR_MAX_AGE_DAYS`. Count the rows
  the cron read returns and their max age.
- **Opening a previously-INERT leg/axis is a BEHAVIORAL expansion.** First making a cut reachable re-scores
  production confirmed STATES feeding downstream engines — verify the downstream ripple, not just the
  touched leg.
