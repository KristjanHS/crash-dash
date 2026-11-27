/**
 * W4 Stage 4.3 falsifier 3 — `ECDF_WINDOW` validated against REALITY, not against a comment.
 *
 *   npm run probe:leg-percentile-depth     # the store `.env.local` names (dev; read-only, writes NOTHING)
 *   bash scripts/with-prod-config.sh tsx scripts/probe-leg-percentile-depth.ts   # the same read against prod
 *
 * WHAT IT CHECKS, AND WHY IT IS THIS AND NOT THE SPEC'S ORIGINAL METRIC. The spec asked for "the
 * shallowest EW-capable MEMBER's distinct-`obs_date` count >= ECDF_WINDOW". That metric is WRONG as
 * written and would fail forever: `EURC` holds 89 distinct obs_dates and `BUND` 85 (measured
 * 2026-07-25), because those members ENTERED an EW-capable family recently — yet a leg's EW pillar
 * is computed from whatever members are live on each day, so a short member does not shorten the
 * pillar series. What actually decides `warmup` vs `pct` in `src/lab-served-field.ts`'s `ewPctCell`
 * is the depth of the STORED `leg_pillars` series it reads: per
 * `(sleeve, 'EARLY-WARN', LEG_PILLAR_GENERATOR)`, the count of non-null values within the SERVED
 * read — the newest `ECDF_READ_SPAN` rows, not an arbitrary 4,000-row read (review 2026-07-25, I3).
 *
 * WHERE IT RUNS. Against a DB that actually CARRIES that history — the local dev stack seeded by the
 * `legpillars` backfill (`bash scripts/db.sh up dev` + `npm run backfill -- legpillars`). It was a
 * `DB_TESTS=1` vitest suite until 2026-10-09; it moved here because
 * the one runner that arms `DB_TESTS=1` targets the EMPTY ephemeral `crash-dash-ci` stack, where a
 * depth check is red-always. A target carrying the `_disposable_stack` marker is therefore SKIPPED
 * loudly (exit 0, reason printed), never measured.
 *
 * ⚠ STRICTLY READ-ONLY, BY HARD CONSTRAINT. The dev DB's history is irreplaceable. This script issues
 * SELECTs only — no insert, no delete, no truncate — and imports nothing from the truncating test
 * harness.
 *
 * GUARD (can fire): exits 1 when any leg's series is empty, its served window is not oldest→newest
 * (`rollingEcdfRank` takes the TAIL — a missing/duplicated reverse would rank against the OLDEST
 * closes), the served window does not end on the newest stored close, or it holds fewer than
 * `ECDF_WINDOW` non-null closes (= `/lab` serves `warmup` on that leg). Demonstrated 2026-07-25 by
 * raising `ECDF_WINDOW` above the shallowest stored depth; an unseeded dev stack is the runnable
 * non-zero demo (every series empty).
 */
import { createClient } from "@supabase/supabase-js";
import { LEG_FIELD } from "../src/danger-ladder.js";
import { supabaseMarkerProbe } from "../src/disposable-guard.js";
import { ECDF_READ_SPAN, ECDF_WINDOW, LEG_PILLAR_GENERATOR } from "../src/leg-percentile.js";
import { getStore } from "../src/store.js";
import { readEnv } from "../src/config.js";

const env = readEnv();

/** The one super-group W4 ranks — the literal `api/lab.ts` filters on and the Stage 4.2 walk wrote. */
const EW_SUPER_GROUP = "EARLY-WARN";

/** A deep read used ONLY for the diagnostic line and the newest-close check — never for the depth
 *  grade. Stays under the store's 5,000-row truncation sentinel. */
const DEPTH_DIAGNOSTIC_LIMIT = 4000;

const store = getStore("ro", env); // throws, naming the missing env, without SUPABASE_URL + SUPABASE_SERVICE_KEY
const url = env.SUPABASE_URL!;
const admin = createClient(url, env.SUPABASE_SERVICE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
if (await supabaseMarkerProbe(admin)()) {
  console.log(
    `[depth] SKIP: ${url} carries the _disposable_stack marker (the empty ephemeral CI stack) - ` +
      `this depth check needs a history-carrying dev DB.`,
  );
  process.exit(0);
}

const failures: string[] = [];
const lines: string[] = [];
for (const leg of LEG_FIELD) {
  // THE GRADED READ IS THE SERVED READ: the exact call `ewPctCell` issues, with the exact limit and
  // the exact null filter.
  const served = await store.getLegPillarSeries(leg.sleeve, EW_SUPER_GROUP, LEG_PILLAR_GENERATOR, ECDF_READ_SPAN);
  const deep = await store.getLegPillarSeries(leg.sleeve, EW_SUPER_GROUP, LEG_PILLAR_GENERATOR, DEPTH_DIAGNOSTIC_LIMIT);

  const dates = served.map((p) => p.date);
  const sorted = [...dates].sort();
  if (dates.some((d, i) => d !== sorted[i])) failures.push(`${leg.sleeve}: served window is not oldest→newest`);
  if (served.at(-1)?.date !== deep.at(-1)?.date) {
    failures.push(`${leg.sleeve}: the served window does not end on the newest stored close`);
  }

  const servedNonNull = served.filter((p) => p.value !== null).length;
  // The PK is (obs_date, sleeve, super_group, generator), so `obs_date` is already unique within one
  // series — count DISTINCT anyway rather than trusting that.
  const deepRows = new Set(deep.map((p) => p.date)).size;
  const deepNonNull = deep.filter((p) => p.value !== null).length;
  if (deepRows === 0) failures.push(`${leg.sleeve}: no stored EW rows (unseeded or wrong-generator DB)`);
  if (servedNonNull < ECDF_WINDOW) {
    failures.push(
      `${leg.sleeve}: only ${servedNonNull} non-null EW closes in the newest ${ECDF_READ_SPAN} stored rows ` +
        `(< ECDF_WINDOW ${ECDF_WINDOW}) - /lab serves \`warmup\` on this leg`,
    );
  }
  lines.push(`${leg.sleeve} served ${servedNonNull} (total ${deepNonNull}/${deepRows})`);
}

console.log(
  `[depth] generator=${LEG_PILLAR_GENERATOR} window=${ECDF_WINDOW} span=${ECDF_READ_SPAN} :: ${lines.join(" · ")}`,
);
if (failures.length > 0) {
  for (const f of failures) console.error(`[depth] FAIL ${f}`);
  process.exit(1);
}
console.log(`[depth] OK: every leg serves >= ${ECDF_WINDOW} non-null EW closes`);
