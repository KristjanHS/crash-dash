/**
 * C1 persist-assembled-dial round-trip probe.
 *
 *   bash scripts/db.sh with dev -- tsx --env-file-if-exists=.env.local scripts/probe-dial-roundtrip.ts            # reads the LIVE DEV store (db.sh with dev)
 *   npx tsx --env-file-if-exists=.env.local scripts/probe-dial-roundtrip.ts --env=prod --limit=2000
 *
 * WHAT IT PROVES — THREE INDEPENDENT ARMS (rebuilt 2026-08-16).
 * The retired blob-vs-recompute arm was an
 * obsolete oracle: no consumer compares those two. `api/lab.ts`'s live read serves the blob verbatim;
 * its `?s=` scenario path forces a recompute because a hypothetical HAS no blob.
 *   · A  SERVE-VERBATIM — the helper returns the persisted blob, modulo the ONE documented read-time
 *        exception (`restateDialVocabulary` rewrites a pre-R5 `headline` into a shallow copy); an
 *        already-current headline must come back BY REFERENCE. Fails if it recomputes, deep-clones, or
 *        touches a second field. 10 of 27 prod rows exercise the restatement branch (July 2026).
 *   · B  JSONB FIDELITY — `JSON.parse(JSON.stringify(blob))` deep-equals `blob`. Fails on any value jsonb
 *        cannot hold as written (`undefined`, `NaN`, `Infinity`, `Date`, `-0`).
 *   · C  RECOMPUTE DETERMINISM — `assembleDial(readings)` deep-equals `assembleDial(reversed readings)`.
 *        ⚠ WEAK BY CONSTRUCTION, and knowingly kept: `computeFamilyPanel` keys readings into a Map and
 *        iterates the fixed `f.ids` roster, so order can only bite on a DUPLICATE id (Map last-wins) —
 *        which a persisted run never carries. It is a duplicate-id tripwire, not a real guard on the
 *        `?s=` scenario path. Do not cite it as one.
 *
 * A/A-COLLAPSE GUARD: the helper falls through to a recompute ONLY when the row's
 * `dial_state` is NULL. If EVERY scanned row were NULL, the hydrate arm would silently BE the recompute
 * arm and their agreement would prove nothing — so guard (a) exits non-zero when zero rows carry a
 * non-null `dial_state`. That is the WHOLE live A/A guard: `blobRows` is pre-filtered to non-null, so
 * once guard (a) passes every counted row genuinely hydrates. Arm A is what now catches a
 * regressed-to-recompute helper per row; the old `hydratedFromBlob` counter was retired 2026-08-16.
 *
 * ⚠ STRICTLY READ-ONLY: `getRecentAlerts`/`getReadingsForRun`/`getSeries` select only. The dev-DB
 * history is irreplaceable (`docs/reference.md` §[runbook] Database (local Supabase)) — never insert/update/delete here.
 */
import { deepStrictEqual } from "node:assert";
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import { assembleDial } from "../src/dial-assembly.js";
import {
  hydrateOrComputeT1Dial,
  restateDialVocabulary,
  techConfirmerBreadth,
  techConfirmerFromPanel,
} from "../src/t1dial.js";
import type { T1DialResult } from "../src/t1dial.js";
import { argOf, envArg as envArgOf } from "./lib/cli.js";

// ---------- args ----------
const envArg = envArgOf("local");
/** How many recent alert rows to scan for a non-null `dial_state` (append-only log; big by default). */
const LIMIT = Number(argOf("limit") ?? 5000);

if (!Number.isFinite(LIMIT) || LIMIT < 1) {
  console.log(`ABORT: --limit must be a positive integer (got ${argOf("limit")}).`);
  process.exit(1);
}

// ---------- store (READ-ONLY by usage) ----------
let store;
try {
  store = await resolveStore(envArg, "ro", liveResolveDeps);
} catch (e: unknown) {
  console.log(
    `ABORT: no store reachable for --env=${envArg} — ${e instanceof Error ? e.message : String(e)}\n` +
      `    The dev stack defaults DOWN — re-run under the front door:\n` +
      `      bash scripts/db.sh with dev -- tsx --env-file-if-exists=.env.local scripts/probe-dial-roundtrip.ts\n` +
      `    (or hold it open with \`scripts/db.sh up dev\`). Populate .env.local, or pass --env=prod.`,
  );
  process.exit(1);
}

// ---------- pull the persisted alert rows ----------
const alerts = await store.getRecentAlerts(LIMIT);
const blobRows = alerts.filter((a) => a.dialState != null);

console.log(`C1 dial round-trip probe — env=${envArg}  scanned=${alerts.length} alert rows`);
console.log(`rows with a persisted dial_state: ${blobRows.length}`);

// ---------- A/A-collapse guard (a): zero persisted blobs ⇒ nothing to prove ----------
if (blobRows.length === 0) {
  console.log(
    `ABORT: 0 of ${alerts.length} scanned rows carry a non-null dial_state.\n` +
      `    The hydrate arm would fall through to recompute for EVERY row (A/A collapse) — this probe\n` +
      `    would pass vacuously, so it FAILS instead. Populate dial_state first: run a local cron\n` +
      `    (Stage 2 persists it on every fresh run) or the Stage-4 backfill, then re-run.`,
  );
  process.exit(1);
}

// ---------- the round-trip ----------
let compared = 0;
const mismatches: { arm: "A" | "B" | "C"; date: string; firedAt: string; detail: string }[] = [];

/** Record `fn`'s assertion failure against `arm` instead of throwing, so one bad row can't hide the rest. */
function check(arm: "A" | "B" | "C", a: { date: string; firedAt: string }, fn: () => void): void {
  try {
    fn();
  } catch (e: unknown) {
    mismatches.push({
      arm,
      date: a.date,
      firedAt: a.firedAt,
      detail: e instanceof Error ? e.message.split("\n").slice(0, 4).join(" ") : String(e),
    });
  }
}

for (const a of blobRows) {
  const blob = a.dialState as T1DialResult;

  const stored = await store.getReadingsForRun(a.firedAt);
  if (stored.length === 0) {
    // A blob with no reconstructable readings can't drive arm C (pre-readings-provenance row). Skip —
    // it neither passes nor pollutes the comparison.
    continue;
  }
  const readings = stored.map((r) => ({ id: r.indicatorId, state: r.state }));
  const { globalPanel } = await assembleDial({ readings, asOf: a.date, store });

  compared++;

  // ARM A — serve-verbatim, modulo the ONE documented read-time exception: `restateDialVocabulary`
  // rewrites a pre-R5 `headline` (`armed`→`primed`) and returns a shallow copy. Every OTHER field must
  // be the persisted one, and an already-current headline must return the blob BY REFERENCE. Fails if
  // the helper ever recomputes, deep-clones, or touches a second field.
  const hydrated = hydrateOrComputeT1Dial(
    a.dialState,
    globalPanel,
    techConfirmerBreadth(techConfirmerFromPanel(globalPanel)),
  );
  const restatedHeadline = restateDialVocabulary(blob.headline);
  check("A", a, () => {
    deepStrictEqual(hydrated, { ...blob, headline: restatedHeadline });
    if (restatedHeadline === blob.headline && hydrated !== blob) {
      throw new Error("headline needed no restatement, yet the helper did not return the blob by reference");
    }
  });

  // ARM B — jsonb fidelity. A blob that is not a JSON fixed-point carries a value the column cannot
  // hold as written (undefined / NaN / Infinity / Date / -0).
  check("B", a, () => deepStrictEqual(JSON.parse(JSON.stringify(blob)), blob));

  // ARM C — recompute determinism under reorder. Reversing is the falsifier a twice-same-input call
  // could never be, but see the docblock: it only bites on a duplicate id. Weak, deliberately kept.
  const { dial: forward } = await assembleDial({ readings, asOf: a.date, store });
  const { dial: reversed } = await assembleDial({
    readings: [...readings].reverse(),
    asOf: a.date,
    store,
  });
  check("C", a, () => deepStrictEqual(forward, reversed));
}

console.log(`compared (blob rows with reconstructable readings): ${compared}`);

// ---------- did we actually compare anything? ----------
if (compared === 0) {
  console.log(
    `ABORT: ${blobRows.length} rows carry a dial_state but none had reconstructable readings ` +
      `(getReadingsForRun empty) — nothing round-tripped. Not a pass.`,
  );
  process.exit(1);
}

// ---------- verdict ----------
const byArm = (arm: "A" | "B" | "C") => mismatches.filter((m) => m.arm === arm).length;

if (mismatches.length > 0) {
  console.log(
    `\nFAIL over ${compared} row(s) — A(serve-verbatim)=${byArm("A")} ` +
      `B(jsonb-fidelity)=${byArm("B")} C(recompute-determinism)=${byArm("C")}:`,
  );
  for (const m of mismatches.slice(0, 10)) {
    console.log(`    [${m.arm}] ${m.date} (${m.firedAt}): ${m.detail}`);
  }
  process.exit(1);
}

console.log(`\nPASS: all three arms hold for all ${compared} row(s).`);
process.exit(0);
