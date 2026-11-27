/** `npm run ladder:prelabel -- --state=<file> --table=<file>[,<file>]` — the `<leg>:state` JSON + Rung A/B findings tables → pre-labels + patch stub (JSON on stdout). */
import { readFileSync } from "node:fs";
import { parseFindings } from "../src/ladder-findings.js";
import { prelabel, type PrelabelRow } from "../src/ladder-prelabel.js";

const arg = (k: string): string => {
  const v = process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  if (!v) throw new Error(`usage: npm run ladder:prelabel -- --state=<file> --table=<file>[,<file>] (missing --${k})`);
  return v;
};
const state = JSON.parse(readFileSync(arg("state"), "utf8")) as { today: string; research?: PrelabelRow[] };
const lines = arg("table").split(",").flatMap((f) => parseFindings(readFileSync(f, "utf8")));
console.log(JSON.stringify(prelabel(state.research ?? [], lines, state.today), null, 1));
