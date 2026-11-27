/** `npm run <leg>:scrub` (= `tsx scripts/ladder-scrub.ts --leg=<leg>`) — licensed index levels are not published:
 *  rewrite every observed licensed level in `LEGS[leg].json` to "—" and null a licensed id's `shocks` numbers
 *  (`scrubLicensedLevelsInLeg`, src/licensed-levels.ts),
 *  write the JSON in the probe's 2-space form, then render `LEGS[leg].md` exactly as `<leg>:render` does. A writer,
 *  not a run: `runs` / `runAt` / `asOf` / `run` stay byte-identical, nothing is pushed, a second pass is a no-op. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ladderTz, readEnv } from "../src/config.js";
import { legOf, LEGS, renderLadderMd, type LadderLive } from "../src/ladder-live.js";
import { scrubLicensedLevelsInLeg } from "../src/licensed-levels.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const leg = legOf(process.argv, "ladder:scrub");
const SRC = `${ROOT}${LEGS[leg].json}`;
const OUT = `${ROOT}${LEGS[leg].md}`;

if (!existsSync(SRC)) throw new Error(`${leg}:scrub — ${LEGS[leg].json} is missing`);
const { live, count } = scrubLicensedLevelsInLeg(JSON.parse(readFileSync(SRC, "utf8")) as LadderLive);
writeFileSync(SRC, `${JSON.stringify(live, null, 2)}\n`);
writeFileSync(OUT, renderLadderMd(live, leg, ladderTz(readEnv())));
console.log(`wrote ${LEGS[leg].json} + ${LEGS[leg].md} · ${count} licensed level(s) scrubbed`);
