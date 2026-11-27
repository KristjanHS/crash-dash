// `npm run mutate:confirm -- <src/file.ts>` — re-run the last core-tests report's undetected lines of one file under the full isolated suite,
// then fail on every survivor `scripts/mutate-equivalents.json` does not excuse and every row of the file that no longer survives.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { type EquivalentRow, type MutationReport, pickReport, type ReportMutant, triageUndetected, undetectedRanges } from "./mutate-ranges.js";

// Core run first: a file it mutated is confirmed from its full survivor list, never the changed-lines subset.
const REPORTS = ["reports/mutation/mutation.json", "reports/mutation/changed.json"];
const CONFIRM_REPORT = "reports/mutation/confirm.json";
const EQUIVALENTS = "scripts/mutate-equivalents.json";
const file = process.argv[2];
if (!file) throw new Error("usage: npm run mutate:confirm -- <src/file.ts>");
const rows = JSON.parse(readFileSync(EQUIVALENTS, "utf8")) as EquivalentRow[];
const reports = REPORTS.filter((p) => existsSync(p)).map((path) => ({
  path,
  report: JSON.parse(readFileSync(path, "utf8")) as MutationReport,
}));
const { path, report } = pickReport(reports, file, readFileSync(file, "utf8"));
const ranges = undetectedRanges(report, file);
// Stale = no undetected match on a line the report mutated: the picked report judges the lines it covered, the rerun those it re-ran.
const picked = triageUndetected(report, file, rows);
let open = picked.open;
const stale = new Set(picked.stale);
if (ranges.length === 0) {
  console.log(`mutate:confirm — ${file}: no Survived/NoCoverage mutants in ${path}`);
} else {
  console.log(`mutate:confirm — ${file}: ${ranges.length} range(s) from ${path} under the full isolated suite`);
  const run = spawnSync("npx", ["stryker", "run", "stryker.confirm.config.mjs", "--mutate", ranges.join(",")], { stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
  const confirmed = triageUndetected(JSON.parse(readFileSync(CONFIRM_REPORT, "utf8")) as MutationReport, file, rows);
  open = confirmed.open;
  for (const r of confirmed.stale) stale.add(r);
}
const show = (m: ReportMutant) => `  ${file}:${m.location.start.line} ${m.mutatorName} → ${m.replacement}`;
if (open.length) console.log(`${open.length} survivor(s) to kill, or excuse one at a time in ${EQUIVALENTS}:\n${open.map(show).join("\n")}`);
if (stale.size) console.log(`${stale.size} stale row(s) in ${EQUIVALENTS} — the mutant is now killed or gone; delete the row:\n${[...stale].map((r) => `  ${r.mutator} → ${r.replacement} @ ${r.src}`).join("\n")}`);
if (!open.length && !stale.size) console.log(`mutate:confirm — ${file}: every survivor is a listed equivalent`);
process.exit(open.length || stale.size ? 1 : 0);
