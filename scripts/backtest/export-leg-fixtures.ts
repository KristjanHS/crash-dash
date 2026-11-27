/**
 * G4 slice 1 — export the nine persisted `LEGP_*` EUR close series from PROD into the CSV shape
 * `event-study.ts` already reads (`readFixture` → `date,value`), so the placebo event study can run
 * on the legs' OWN instruments instead of the committed `LEG_FIXTURE` proxies.
 *
 *     npm run g4:export-legs            # reads .env.prod, writes scripts/backtest/data-g4/*.csv
 *
 * ⚠ **PROD, not dev** (`research-probes.md` §The instrument is a claim too): the dev DB has no cron, so its `LEGP_*` depth is an
 * artifact of when someone last ran a backfill.
 *
 * ⚠ **NEVER writes into `scripts/backtest/data/`.** Those CSVs are the harness's shared
 * `MARKET_FIXTURES` and the pension calibration's legs — appending a row there is a tracked vintage
 * change, not a fetch (`.claude/rules/research-probes.md` §Three smaller traps). This script writes
 * ONLY under `scripts/backtest/data-g4/`, which is gitignored throwaway, and `OUT_DIR_REL` is
 * asserted against that prefix below so the sentence is executable rather than asserted.
 *
 * STRICTLY READ-ONLY on the store: `getSeries` selects only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LADDER } from "../../src/families.js";
import { legCloseId } from "../../src/scoreboard.js";
import { getStore } from "../../src/store.js";
import { readEnv } from "../../src/config.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Repo-relative because `readFixture` joins every path onto `REPO_ROOT`. */
export const OUT_DIR_REL = "scripts/backtest/data-g4";

/** Rows to pull per leg. Deeper than any plausible `LEGP_*` history, so the pull is never the
 *  binding constraint on the study window — the DB's own depth is. */
const LIMIT = 20_000;

/** Executable form of the docblock's "never writes into the shared fixture dir" claim. */
export function assertThrowawayDir(rel: string): void {
  if (!rel.startsWith("scripts/backtest/data-g4/") && rel !== "scripts/backtest/data-g4") {
    throw new Error(
      `[export-leg-fixtures] refusing to write outside the throwaway dir: ${rel}. ` +
        `scripts/backtest/data/ is the SHARED tracked fixture set — writing there is a vintage bump.`,
    );
  }
}

/** `date,value` — exactly what `readFixture` parses (header line skipped, one pair per line). */
export function toCsv(points: readonly { date: string; value: number }[]): string {
  return ["date,value", ...points.map((p) => `${p.date},${p.value}`)].join("\n") + "\n";
}

const isMain = process.argv[1]?.endsWith("export-leg-fixtures.ts") ?? false;
if (isMain) {
  assertThrowawayDir(OUT_DIR_REL);
  mkdirSync(join(REPO_ROOT, OUT_DIR_REL), { recursive: true });
  const store = getStore("ro", readEnv());
  let wrote = 0;
  let empty = 0;
  console.log(`=== G4 leg-fixture export → ${OUT_DIR_REL}/ ===`);
  console.log(`${"leg".padEnd(10)}${"id".padEnd(14)}${"rows".padStart(7)}  range`);
  for (const leg of LADDER) {
    const id = legCloseId(leg);
    const pts = await store.getSeries(id, LIMIT);
    const rel = `${OUT_DIR_REL}/${id}.csv`;
    assertThrowawayDir(rel);
    writeFileSync(join(REPO_ROOT, rel), toCsv(pts));
    if (pts.length === 0) empty++;
    else wrote++;
    console.log(
      `${leg.padEnd(10)}${id.padEnd(14)}${String(pts.length).padStart(7)}  ` +
        (pts.length === 0 ? "EMPTY — this leg is UNMEASURABLE in the study" : `${pts[0]!.date} → ${pts.at(-1)!.date}`),
    );
  }
  console.log(`\n${wrote} leg fixture(s) written, ${empty} empty.`);
  if (wrote === 0) {
    // Non-vacuity: a run that wrote nine empty CSVs measured nothing and must not read as success.
    throw new Error(
      `[export-leg-fixtures] every one of the ${LADDER.length} LEGP_* series came back EMPTY — check the ` +
        `DB target (.env.prod) before reading any study run against these fixtures.`,
    );
  }
}
