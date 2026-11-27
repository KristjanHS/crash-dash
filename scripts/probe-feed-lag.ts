/**
 * Feed-lag classification probe (D4's live arm).
 *
 *   npm run probe:feed-lag -- --env=prod          # the decision-grade run (prod cron history)
 *   npm run probe:feed-lag                        # dev store; see the A/A guard below
 *
 * WHAT IT ANSWERS: for EVERY served indicator, is its current age (a) normal publication lag,
 * (b) a MIS-REGISTERED cadence — the registry claims one release rhythm and the feed has always
 * run on another — or (c) genuine DEEP-LAG: a feed whose own historical rhythm it has now broken.
 *
 * The distinction matters because `assessIndicatorFreshness` scores age against the id's RESOLVED
 * cut (`lagCutFor`: a per-indicator `lagAfterDays` where one is registered, else the cadence
 * tier). That is still a registry number, so a row that misdescribes the publisher's calendar is
 * cried stale on a normal week — the state F9 was in BEFORE E7 gave it `cadence: "weekly"` +
 * `lagAfterDays: 11` (its H.10 release was scored against the daily tier). A rotting feed is
 * genuinely dark and must NOT be silenced by widening a threshold. The two look identical from a
 * single age reading, and are separable only by comparing the feed against its OWN history.
 *
 * THE LADDER ITSELF LIVES IN `src/feed-lag.ts` (§I9.2) — `api/lab.ts` needs the same classifier and
 * must not import from `scripts/`. This file is the IO shell (store read, printing) and RE-EXPORTS
 * the pure core, so `scripts/probe-feed-lag.test.ts` keeps pinning it through this module path.
 * ⚠ Six symbols moved VERBATIM (`DEEP_LAG_MULTIPLE`, `MIN_GAPS`, `classify`, `impliedCadenceFor`,
 * `shouldCorrect`, `assertNonVacuous`) and the suite passing unmodified is the falsifier for THAT
 * HOIST ONLY. It says nothing about their CURRENT behaviour: `classify` and `shouldCorrect` both
 * gained an `explicit` arm afterwards (E7 §Stage 4 fork), covered by their own disagreeing-input
 * cases in `probe-feed-lag.test.ts`, not by this hoist argument.
 * `lagRowFor` was restructured out of this file's loop body and `lagTier`/`LAG_SCAN_LIMIT`/
 * `cadenceIndex` are new — see `src/feed-lag.ts`'s header for what covers each. The CLASSIFICATION
 * table and the per-label rationale live in that file's docblock; only the guards and the method
 * are restated here.
 *
 * METHOD — the expectation comes from the DATA, except where the registry has ASSERTED one:
 *   · `medianGap` / `p90Gap` = the spacing between consecutive DISTINCT observation dates over the
 *     scanned window. That is the feed's demonstrated OBSERVATION rhythm — and, per E7 §Stage 1.4,
 *     it is blind to a batch RELEASE grid (H.10 stamps daily dates inside a weekly release).
 *   · `impliedCadence` = the FINEST `AMBITION_THRESHOLDS` tier whose value still covers `p90Gap` (the
 *     pure release-SPACING table — deliberately NOT the alarm cuts, which carry publication lag too).
 *     This is the "changing our expectations about its lag" half, and it is published as a candidate
 *     correction ONLY for ids the registry never asserted a rhythm for. Where the registry DID assert
 *     one (a `cadence` key or a `lagAfterDays`, from the publisher's calendar — R1), that assertion
 *     is the better prior and the disagreement is withheld: observation gaps cannot see a release
 *     grid, so a correction derived from them could only advise undoing a correct registration.
 *   · `age` = today − newest observation. Rot is age ≫ the feed's DEEP-LAG RHYTHM: `p90Gap` for an
 *     unregistered id — a claim about the feed against itself, which survives a wrong registry row —
 *     but `max(p90Gap, LAG_THRESHOLDS[registered])` for an explicitly registered one, where the
 *     registry bounds how rottable the feed is. The floor is the CADENCE TIER, deliberately NOT the
 *     id's resolved cut (E7 §Stage 4.7-R2 — a per-id `lagAfterDays` encodes publication LAG, and
 *     only release SPACING bounds rottability). That bound is scoped to those ids on purpose (E7
 *     §Stage 4 fork — RULED); it can only ever RAISE the bar, and it never removes it.
 *
 * CLASSIFICATION (one label per indicator, first match wins): NO-DATA → DEEP-LAG → FRESH → MISCADENCED
 * → LATE, with UNKNOWN below `MIN_GAPS`. Each label's exact test and its rationale are in
 * `src/feed-lag.ts`'s docblock beside the code that implements them.
 *
 * ⚠ DEEP-LAG is the HEAVIER of the two `◌` tiers on `/lab` (the user's "lagging too much to react to
 * crashes on time"), MISCADENCED/LATE the QUIET one. Neither is a signal colour: since
 * the lag-diagnosis restyle both paint from the neutral `--lag-diag` ramp
 * (soft grey = late · bright grey = dark), never from the operational alarm ink.
 * A feed cannot be classified DEEP-LAG on a short window — see guard (b).
 *
 * ⚠ STRICTLY READ-ONLY: `getSeriesBulk` selects only. The dev-DB history is irreplaceable
 * (`docs/reference.md` §[runbook] Database (local Supabase)) — never insert/update/delete here.
 *
 * A/A-COLLAPSE GUARDS (a probe that cannot fail proves nothing):
 *   (a) The store must return a MIXED census — at least one FRESH and at least one non-FRESH
 *       indicator. An all-stale store (the dev DB: its cron is dead, so EVERY feed reads stale by
 *       construction — I6.1) makes every classification vacuous, since "age > cut" is then true for
 *       reasons that have nothing to do with the feed. Exits non-zero.
 *   (b) Every classified indicator needs >= MIN_GAPS observed gaps. With fewer, `p90Gap` is not an
 *       expectation and DEEP-LAG-vs-MISCADENCED is unfalsifiable; such ids report UNKNOWN and are
 *       excluded from the correction list rather than defaulting to a label.
 *   (c) At least one CLASSIFIED (non-UNKNOWN, non-NO-DATA) indicator must carry a registry cadence
 *       OTHER than the `daily` default — otherwise `impliedCadence != registered` could never be
 *       exercised against a non-default row and the mis-cadence arm would be structurally incapable
 *       of disagreeing. Testing the raw registry instead is vacuous: it always supplies 7 non-daily
 *       rows, so the only state that could fire it is one where guard (b) throws first.
 */
import { AMBITION_THRESHOLDS, LAG_THRESHOLDS, lagCutFor } from "../src/ladder.js";
import type { ReadStore } from "../src/store.js";
import { resolveStore } from "./backfill/resolve-store.js";
import { prodProjectRef, projectHost } from "./supabase-project.js";
import {
  LAG_SCAN_LIMIT,
  MIN_GAPS,
  DEEP_LAG_MULTIPLE,
  assertNonVacuous,
  cadenceIndex,
  classify,
  explicitRegistrationIndex,
  impliedCadenceFor,
  isExplicitlyRegistered,
  lagRowFor,
  lagTier,
  deepLagRhythm,
  shouldCorrect,
  lagCutIndex,
  type Label,
  type Row,
} from "../src/feed-lag.js";
import { isoDay } from "../src/dates.js";
import { readEnv, type Env } from "../src/config.js";

// The pure core is hoisted to `src/feed-lag.ts` (§I9.2) and re-exported here UNCHANGED, so
// `probe-feed-lag.test.ts` keeps importing it from this module path — that unmodified suite is the
// falsifier for the hoist being behaviour-preserving.
export {
  LAG_SCAN_LIMIT,
  MIN_GAPS,
  DEEP_LAG_MULTIPLE,
  assertNonVacuous,
  cadenceIndex,
  classify,
  explicitRegistrationIndex,
  impliedCadenceFor,
  isExplicitlyRegistered,
  lagRowFor,
  lagTier,
  deepLagRhythm,
  shouldCorrect,
  type Label,
  type Row,
};

/** `--env=prod|local` (default local). */
function envArg(): "local" | "prod" {
  return process.argv.includes("--env=prod") ? "prod" : "local";
}

/** The host the run will actually read — printed in the header so a captured table is attributable.
 *  For `prod` this is the same string `resolveStore`'s project guard requires; for `local` it is
 *  whatever `.env.local` (loaded below) supplied. */
function targetHost(env: "local" | "prod", appEnv: Env): string {
  if (env === "prod") return projectHost(prodProjectRef(appEnv));
  const url = appEnv.SUPABASE_URL;
  if (!url) return "(no SUPABASE_URL)";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function main(): Promise<void> {
  const today = isoDay(new Date());
  const env = envArg();
  if (env === "local") process.loadEnvFile(".env.local");
  const index = cadenceIndex();
  // The RESOLVED per-indicator cuts (E7 Stage 3.6) — the same map `/lab` scores against, so the
  // probe's FRESH/LATE boundary and the notify line's `verdictHoldLegs` can never disagree.
  const cuts = lagCutIndex();
  // Which ids the registry has ASSERTED a rhythm for (E7 §Stage 4 fork) — gates the DEEP-LAG arm and
  // silences the correction list for them.
  const explicitOf = explicitRegistrationIndex();
  const ids = [...index.keys()];

  const host = targetHost(env, readEnv());
  // A "ro" handle: only `getSeriesBulk` (a select) is ever called on it.
  const store: ReadStore = await resolveStore(env, "ro");
  const series = await store.getSeriesBulk(ids, { limit: LAG_SCAN_LIMIT });

  // The per-id row build (distinct-date gaps → p50/p90 → classify) lives in `src/feed-lag.ts` as
  // `lagRowFor` (§I9.6 item 1) — `/lab`'s stage-2 deep read calls the SAME function, so the probe
  // and the dashboard cannot drift on the p90 convention or the NO-DATA shape.
  const rows: Row[] = ids.map((id) => {
    const registered = index.get(id) ?? "daily";
    return lagRowFor({
      id,
      registered,
      // `ids` are `cadenceIndex`'s own keys and `lagCutIndex` walks the same registry, so the
      // lookup always hits; the fallback resolves the SAME id through `lagCutFor`, never a wider
      // number, and goes through the resolver rather than indexing the tier table directly.
      cut: cuts.get(id) ?? lagCutFor({ cadence: registered }),
      // `false` is the STRICT arm. It cannot silence a DEEP-LAG — but unlike `/lab`, this call site also
      // feeds `shouldCorrect`, so a missed lookup would additionally re-emit the `weekly → daily`
      // advice the fork withheld. `explicitOf` walks the same registry as `ids`, so it always hits.
      explicit: explicitOf.get(id) ?? false,
      dates: (series.get(id) ?? []).map((p) => p.date),
      today,
    });
  });

  // ---- guards (a) mixed census, (b) per-row above + "nothing classifiable", (c) classified non-daily ----
  assertNonVacuous(rows);
  const classified = rows.filter((r) => r.label !== "UNKNOWN" && r.label !== "NO-DATA");

  const order: Record<Label, number> = {
    "NO-DATA": 0,
    "DEEP-LAG": 1,
    MISCADENCED: 2,
    LAG: 3,
    UNKNOWN: 4,
    FRESH: 5,
  };
  rows.sort((a, b) => order[a.label] - order[b.label] || b.age - a.age);

  console.log(
    `feed-lag classification · today=${today} · target=${host} (${env}) · scanned ${rows.length} ids · window=${LAG_SCAN_LIMIT} obs`,
  );
  // ⚠ The header prints the ALARM table because that is what the `cut` column and the DEEP-LAG bar
  // resolve from. `impliedCadence` does NOT: since 2026-08-03 it buckets p90Gap against
  // `AMBITION_THRESHOLDS` (`impliedCadenceFor`, feed-lag.ts), so both are printed and labelled.
  console.log(
    `DEEP_LAG_MULTIPLE=${DEEP_LAG_MULTIPLE} MIN_GAPS=${MIN_GAPS} ` +
      `LAG_THRESHOLDS(cut,DEEP-LAG)=${JSON.stringify(LAG_THRESHOLDS)} ` +
      `AMBITION_THRESHOLDS(impliedCadence)=${JSON.stringify(AMBITION_THRESHOLDS)}`,
  );
  console.log("");
  console.log("label        id                       newest      age  cut  medGap  p90Gap  registered→implied");
  for (const r of rows) {
    const fix = r.impliedCadence !== r.registered ? `  ${r.registered}→${r.impliedCadence}` : "";
    console.log(
      `${r.label.padEnd(12)} ${r.id.padEnd(24)} ${r.newest}  ${String(r.age).padStart(3)}d ${String(r.cut).padStart(4)} ` +
        `${String(r.medianGap).padStart(6)}  ${String(r.p90Gap).padStart(6)}${fix}`,
    );
  }

  const corrections = classified.filter(shouldCorrect);
  const disagreeing = classified.filter((r) => r.impliedCadence !== r.registered && !shouldCorrect(r));
  // Two DIFFERENT reasons a disagreement is withheld — printing both under the §I8.3 coarsening
  // banner would mislabel every explicit-registration case as a median check that failed.
  const explicitHeld = disagreeing.filter((r) => r.explicit);
  const suppressed = disagreeing.filter((r) => !r.explicit);
  console.log("");
  console.log(`CANDIDATE REGISTRY CORRECTIONS (data disagrees with the registered cadence): ${corrections.length}`);
  for (const r of corrections)
    console.log(`  ${r.id.padEnd(24)} ${r.registered} → ${r.impliedCadence}   (p90Gap ${r.p90Gap}d, med ${r.medianGap}d)`);
  if (explicitHeld.length > 0) {
    console.log(
      `  — ${explicitHeld.length} suggestion(s) withheld: the registry ASSERTED these rhythms and ` +
        `observation gaps cannot see a release grid (E7 §Stage 4 fork):`,
    );
    for (const r of explicitHeld)
      console.log(`    ${r.id.padEnd(22)} would have said ${r.registered} → ${r.impliedCadence} (p90 ${r.p90Gap}d, med ${r.medianGap}d)`);
  }
  if (suppressed.length > 0) {
    console.log(`  — ${suppressed.length} COARSENING suggestion(s) withheld (median still in the finer tier; §I8.3):`);
    for (const r of suppressed)
      console.log(`    ${r.id.padEnd(22)} would have said ${r.registered} → ${r.impliedCadence} (p90 ${r.p90Gap}d, med ${r.medianGap}d)`);
  }

  const noData = rows.filter((r) => r.label === "NO-DATA");
  console.log("");
  console.log(`NO-DATA — served ids with ZERO stored observations: ${noData.length}`);
  for (const r of noData) console.log(`  ${r.id}`);

  const rot = rows.filter((r) => r.label === "DEEP-LAG");
  console.log("");
  console.log(`DEEP-LAG — feeds aged past their deep-lag bar (the heavier \`◌\` tier): ${rot.length}`);
  // Same clause shape as `/lab`'s footnote (`lagMeasure`, `public/feed-lag-foot.js`) — keep the two in step.
  for (const r of rot)
    console.log(
      `  ${r.id.padEnd(24)} age ${r.age}d vs lag cut ${r.cut}d · deep-lag bar ${deepLagRhythm(r) * DEEP_LAG_MULTIPLE}d  (newest ${r.newest})`,
    );
}

const isMain = process.argv[1]?.endsWith("probe-feed-lag.ts") ?? false;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
