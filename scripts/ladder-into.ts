/**
 * A leg probe's `--into=` write: the live state as 2-space JSON, plus `LEGS[leg].md` re-rendered when `into` is the leg's
 * canonical JSON — so a probe-only refresh (skill step 1 with no `<leg>:apply` after it) can't leave the md stale. A
 * scratch `--into` path writes the JSON alone.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ladderTz, readEnv } from "../src/config.js";
import { LEGS, renderLadderMd, type LadderLegId, type LadderLive } from "../src/ladder-live.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Writes `live` to `into`; returns the md path it re-rendered, or `undefined` for a scratch target. `root` = the test seam. */
export const writeInto = (into: string, live: LadderLive, leg: LadderLegId, root = ROOT): string | undefined => {
  writeFileSync(into, `${JSON.stringify(live, null, 2)}\n`);
  if (resolve(into) !== resolve(root, LEGS[leg].json)) return undefined;
  writeFileSync(resolve(root, LEGS[leg].md), renderLadderMd(live, leg, ladderTz(readEnv())));
  return LEGS[leg].md;
};
