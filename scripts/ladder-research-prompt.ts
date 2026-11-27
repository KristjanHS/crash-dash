/** `npm run ladder:research-prompt -- --state=<file> [--rung-b=<prelabels.json>]` — the `<leg>:state` JSON → the Rung 0+A (or, given the pre-labels, Rung B) `ladder-research` prompt on stdout; Rung B with nothing owed prints nothing. */
import { readFileSync } from "node:fs";
import type { PrelabelOut } from "../src/ladder-prelabel.js";
import { rungAPrompt, rungBPrompt, type ResearchState } from "../src/ladder-research-prompt.js";

const opt = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const file = opt("state");
if (!file) throw new Error("usage: npm run ladder:research-prompt -- --state=<file> [--rung-b=<prelabels.json>]");
const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ResearchState> & Pick<ResearchState, "today">;
const state: ResearchState = { today: raw.today, scan: raw.scan ?? [], verify: raw.verify ?? [], research: raw.research ?? [] };
const b = opt("rung-b");
const out = b ? rungBPrompt(state, (JSON.parse(readFileSync(b, "utf8")) as PrelabelOut).rungB) : rungAPrompt(state);
if (out) console.log(out);
