/**
 * Regenerate `scripts/backtest/synth_cuts.json` — the committed, reviewable record of the
 * Stage-6.3 runtime-computed cuts for the `synthPriors` ids (F3 — F10 reverted to
 * hand-typed priors 2026-07-18, truncated feed;
 * F9 2026-08-08 and F11 2026-08-09, rolling-σ standardization).
 *
 *   npm run emit:synth-cuts        # writes the golden from the CURRENT store history
 *
 * WHY this file exists: Option B computes cuts at RUN time, so unlike the harness ids there
 * is no `calibration.json` row a human can read to see what the phone is firing on. This
 * artifact buys that reviewability back — it is the after-the-fact attribution record for
 * every band the three move. It is NOT read by any production path (`synth-cuts.ts` recomputes
 * from the live store); it is a review + regression surface only.
 *
 * The regen path is what stops it rotting (`.claude/rules/research-probes.md`,
 * regen/vintage-freshness): re-run this after a backfill, a percentile retune, or whenever the
 * committed numbers stop matching what `/lab` shows. `dashboard.synth-cuts.test.ts` pins the file's
 * shape, its per-id invariants, and — the tripwire that matters — that its `method` block
 * still equals the live constants, so a knob bump cannot leave a stale golden looking
 * authoritative.
 *
 * Needs `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (run under `tsx --env-file-if-exists=.env.local`,
 * which the npm script wires). A store with less than `PCT_MIN_OBS` history for a LEG emits
 * that leg's registry PRIOR and flags it in `degradedLegs` — the same fail-safe the live path
 * takes, recorded honestly rather than hidden. Per-leg, not per-id: the |Δ20| window is
 * `SYNTH_VEL_WINDOW` shorter than the level one, so an id can carry real level cuts and prior
 * velocity cuts at the same time (a whole-history flag reported that as a clean `false`).
 *
 * The emitted `source` names the store the history came from (`prod` or `dev (<host>)`) — never a
 * hosted hostname, URL or key, since this file is committed. Without it `nObs` is uninterpretable: F10's 767
 * observations against F11's ~3,700 is a property of the local dev DB, not of the feed.
 */
import { writeFileSync } from "node:fs";
import { ALL_INDICATORS } from "../src/registry.js";
import { SYNTH_PRIOR_IDS } from "../src/domain-cuts.js";
import { getStore } from "../src/store.js";
import {
  SYNTH_AMBER_PCTILE,
  SYNTH_RED_PCTILE,
  SYNTH_VEL_WINDOW,
  computeSynthCutsDetailed,
  loadSynthHistories,
  priorThresholds,
  synthAxesFor,
} from "../src/synth-cuts.js";
import { PCT_MIN_OBS } from "../src/slow.js";
import { isoDay } from "../src/dates.js";
import { readEnv, type Env } from "../src/config.js";

const OUT = new URL("./backtest/synth_cuts.json", import.meta.url);

/**
 * Which store the numbers came from — a LABEL, never a hosted hostname, URL or key: the
 * artifact is committed, so neither the project host nor a credential may ride along. Without this the `nObs` column
 * is unreadable: F10's 767 observations vs F11's ~3,700 is a property of the LOCAL dev DB
 * (prod has the full backfill), and a reviewer cannot tell which one a checked-in golden
 * describes. Local Supabase resolves to a loopback host ⇒ `dev (<host>)`; any other host ⇒ `prod`.
 */
function storeLabel(env: Env): string {
  const raw = env.SUPABASE_URL;
  if (!raw) return "unknown";
  try {
    const { hostname } = new URL(raw);
    return /^(127\.|localhost$|\[?::1)/.test(hostname) ? `dev (${hostname})` : "prod";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const env = readEnv();
  const store = getStore("ro", env);
  const histories = await loadSynthHistories(store);
  const byId = new Map(ALL_INDICATORS.map((i) => [i.id, i]));
  const cuts: Record<string, unknown> = {};
  for (const id of SYNTH_PRIOR_IDS) {
    const ind = byId.get(id);
    if (!ind) throw new Error(`synthPriors id ${id} is not in ALL_INDICATORS`);
    const history = histories.get(id) ?? [];
    const prior = priorThresholds(ind);
    const velWindow = ind.velocityWindow ?? SYNTH_VEL_WINDOW;
    const { cuts: c, degraded } = computeSynthCutsDetailed(history, prior, velWindow);
    cuts[id] = {
      series: ind.series,
      label: ind.label,
      nObs: history.length,
      // The velocity array is SYNTH_VEL_WINDOW shorter than the level one, so the two axes
      // cross minObs at different depths: an id with 253–272 observations computes real
      // level cuts while BOTH velocity cuts are silently the prior. A whole-history flag off
      // the level series alone records that id as `degraded: false` — a false all-clear. So
      // emit the observation count per AXIS plus the per-leg flags `computeSynthCutsDetailed`
      // already returns; `degraded` is kept as the any-leg roll-up for a quick scan.
      // …and OMITTED entirely for a LEVEL-ONLY id (F3): `synthAxesFor` computes no velocity
      // axis for a prior that defines none, so an `nObsVelocity` there would advertise a
      // window that is never measured against anything.
      // The per-id velocity window on the ENTRY (not the global `method.velocityWindow`, which
      // stays the default): F3 (R2) scores a 4-WEEK |Δ| via `velocityWindow: 4`, so `nObsVelocity`
      // is `history.length - 4` for it, not `- SYNTH_VEL_WINDOW`. Recording the window here makes
      // that shift readable from the entry alone.
      ...(synthAxesFor(prior).velocity
        ? { velocityWindow: velWindow, nObsVelocity: Math.max(0, history.length - velWindow) }
        : {}),
      degraded: degraded.any,
      degradedLegs: {
        amberLevel: degraded.amberLevel,
        redLevel: degraded.redLevel,
        amberVelocity: degraded.amberVelocity,
        redVelocity: degraded.redVelocity,
      },
      amberLevel: c.amberLevel,
      redLevel: c.redLevel,
      amberVelocity: c.amberVelocity,
      redVelocity: c.redVelocity,
      // The hand-typed `PRIORS — uncalibrated` bands 6.3 replaced — kept alongside so the
      // review question ("did the computed cut move the band, and which way?") is answerable
      // from this file alone.
      prior,
    };
  }
  const golden = {
    generatedAt: isoDay(new Date()),
    source: storeLabel(env),
    regen: "npm run emit:synth-cuts",
    notes:
      "Stage 6.3 — Option B runtime expanding percentile. Review record only; production recomputes from " +
      "the live store on every run. `degradedLegs.<leg>: true` means that leg's window was thinner than " +
      "minObs and it fell back to `prior`; `degraded` is the any-leg roll-up. The velocity window is " +
      "`velocityWindow` observations SHORTER than the level one (see nObs vs nObsVelocity), so the two " +
      "axes can degrade independently. `source` is the store the numbers were read from — nObs is only " +
      "comparable across ids from the SAME store. An AMBER-ONLY velocity id (F3, R2) emits `amberVelocity` " +
      "+ `nObsVelocity` but NO `redVelocity` — its registry prior defines no red velocity cut, so none is " +
      "computed. F3 carries a per-id `velocityWindow` on the ENTRY that differs from the global " +
      "`method.velocityWindow` (20, which is the DEFAULT and does not move when an entry overrides it): F3 " +
      "= 4 (a weekly series scoring a 4-WEEK |Δ|). `nObsVelocity = nObs - velocityWindow` per id, so read " +
      "the depth off the entry's own window, never off `method`. The covered set is F3 alone (added " +
      "2026-07-20, W1 slice 2 — its 0.5/1.0 prior was unreachable by the series). THREE ids left it: F10 " +
      "(BAMLEMCBPIOAS) 2026-07-18 (option C) — keyless FRED serves the ICE BofA OAS series over a rolling " +
      "~3-year window, so its percentile was fitted to one benign credit regime with no event in it, which " +
      "no minObs floor can detect; F9 (DTWEXBGS) 2026-08-08 and F11 (DEXCHUS) 2026-08-09, both of which " +
      "now standardize their Δ60 by a strictly-historical rolling σ and cut at fixed σ values on their " +
      "registry pair. All three score off registry pairs now.",
    method: {
      amberPercentile: SYNTH_AMBER_PCTILE,
      redPercentile: SYNTH_RED_PCTILE,
      velocityWindow: SYNTH_VEL_WINDOW,
      minObs: PCT_MIN_OBS,
      estimator: "expanding-window empirical CDF (point-in-time, pre-t only)",
    },
    cuts,
  };
  writeFileSync(OUT, `${JSON.stringify(golden, null, 2)}\n`);
  console.log(`wrote ${OUT.pathname}`);
  for (const [id, c] of Object.entries(cuts)) console.log(id, JSON.stringify(c));
}

void main();
