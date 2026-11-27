/** `npm run <leg>:render` (= `tsx scripts/ladder-render.ts --leg=<leg>`) — render `LEGS[leg].md` whole from `LEGS[leg].json`
 *  (the primary artifact). A writer, not a probe. Also rewrites the JSON in the probe's 2-space form: a hand-edit of a
 *  user-set field in any indent lands as a field diff, never a whole-file one. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ladderTz, readEnv } from "../src/config.js";
import { legOf, LEGS, renderLadderMd, type LadderLive } from "../src/ladder-live.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const leg = legOf(process.argv, "ladder:render");
const SRC = `${ROOT}${LEGS[leg].json}`;
const OUT = `${ROOT}${LEGS[leg].md}`;

if (!existsSync(SRC)) throw new Error(`${leg}:render — ${LEGS[leg].json} is missing; seed it with \`npm run ${LEGS[leg].probe} -- --into=${LEGS[leg].json}\``);
const live = JSON.parse(readFileSync(SRC, "utf8")) as Partial<LadderLive>;
const reason = typeof live.run !== "string" ? "`run` missing" : live.verdict?.tranches?.length !== 3 ? "`verdict.tranches` is not 3 tranches" : null;
if (reason !== null) {
  console.error(`${leg}:render — ${LEGS[leg].json} fails the shape check: ${reason}`);
  process.exit(1);
}
writeFileSync(SRC, `${JSON.stringify(live, null, 2)}\n`);
writeFileSync(OUT, renderLadderMd(live as LadderLive, leg, ladderTz(readEnv())));
console.log(`wrote ${LEGS[leg].md} · run ${live.run} · ${live.signs?.length ?? 0} signs · ${live.events?.length ?? 0} events · ${Math.min(live.runs?.length ?? 0, 5)} runs`);
