/**
 * `npm run -s <leg>:apply -- <patch.json> [--today=YYYY-MM-DD] [--now=<ISO instant>] [--prelabels=<ladder:prelabel JSON>]` (= `tsx scripts/ladder-apply.ts --leg=<leg>`) — the leg's
 * skill run's only writer: `applyRun` the research patch onto `LEGS[leg].json` (2-space), render `LEGS[leg].md`, push the
 * run's `alert` to the ladder's ntfy topic (an `ntfy` line; a failed push still exits 0 so the skill's commit lands), then
 * print `applyEcho` (the delta, or its head + a pointer to the md, ≤ `APPLY_ECHO_MAX` bytes); a `blockReach: "graded"` leg re-probes (after a dry `applyRun` pass, only on `movesVerdict` — its triggers are its own docblock, src/ladder-reverdict.ts) so a flipped `block` reaches the verdict. Commits nothing.
 * `--events-only` = `applyEvents` instead: `eventsAdd` / event `holds` / `signsAdd` only — no re-probe, no run stamp, no research demand; its only push is a `degradeMixed` holds cut.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { ladderTz, readEnv } from "../src/config.js";
import { legOf, LEGS, renderLadderMd, type LadderLegId, type LadderLive, type LadderVerdict } from "../src/ladder-live.js";
import { applyEcho, applyEvents, applyRun, fillMechanical, nowArg, planRun, runStamp, type LadderEventsPatch, type LadderPatch } from "../src/ladder-run.js";
import { movesVerdict } from "../src/ladder-reverdict.js";
import { ntfyPushEnabled, pushNtfy, type NtfyMessage } from "../src/ntfy.js";
import { withConfigAlias } from "./lib/prod-base-url.js";

/** The `blockReach: "graded"` leg ids, derived off `LEGS` — a new one without a `REPROBE` entry fails `tsc`. */
type ReprobeLeg = { [K in LadderLegId]: (typeof LEGS)[K]["blockReach"] extends "all" ? never : K }[LadderLegId];
const REPROBE: Record<ReprobeLeg, () => Promise<{ liveReverdict: () => Promise<(n: LadderLive) => LadderVerdict> }>> = { value: () => import("./probe-value-tranches.js"), semis: () => import("./probe-semis-tranches.js"), spit: () => import("./probe-spit-tranches.js"), sp500: () => import("./probe-sp500-tranches.js") };
const isReprobe = (l: LadderLegId): l is ReprobeLeg => l in REPROBE;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const leg = legOf(process.argv, "ladder:apply");
const SRC = `${ROOT}${LEGS[leg].json}`;
const path = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!path) {
  console.error(`usage: npm run -s ${leg}:apply -- <patch.json> [[--today=YYYY-MM-DD] [--now=<ISO instant>] | --events-only]`);
  process.exit(1);
}
if (!existsSync(SRC)) throw new Error(`${leg}:apply — ${LEGS[leg].json} is missing; seed it with \`npm run ${LEGS[leg].probe} -- --into=${LEGS[leg].json}\``);
const live = JSON.parse(readFileSync(SRC, "utf8")) as LadderLive;
// argv is parsed before the try: a bad `--now` is a command defect, never one the patch repair hint fixes.
const now = nowArg(process.argv, `${leg}:apply`, new Date());
const today = process.argv.find((a) => a.startsWith("--today="))?.slice(8) ?? new Date().toLocaleDateString("sv-SE");
// Headless runs deny a Bash/`node` rewrite of the patch (a denial ntfy) — point the model at `Edit`.
const repair: (why: string) => never = (why) => {
  console.error(`${why}\n→ repair: \`Edit\` the patch file, then rerun the same call`);
  process.exit(1);
};
let patch: unknown;
try {
  patch = JSON.parse(readFileSync(path, "utf8"));
} catch (err) {
  if (!(err instanceof SyntaxError)) throw err;
  repair(`${leg}:apply — the patch is not valid JSON: ${err.message}`);
}
let result: { next: LadderLive; delta: string[]; alert?: NtfyMessage };
try {
  result = process.argv.includes("--events-only") ? applyEvents(live, patch as LadderEventsPatch, leg, new Date().toLocaleDateString("sv-SE")) : await runApply(patch as LadderPatch);
} catch (err) {
  if (!(err instanceof Error && err.message.startsWith(`${leg}:apply — `))) throw err;
  repair(err.message);
}
const { next, delta, alert } = result;
writeFileSync(SRC, `${JSON.stringify(next, null, 2)}\n`);
writeFileSync(`${ROOT}${LEGS[leg].md}`, renderLadderMd(next, leg, ladderTz(readEnv())));
console.log(applyEcho(delta, LEGS[leg].md, alert && (await push(alert))).join("\n"));

/** Only `NTFY_TOPIC` is taken from `.env.local` (the ladder's topic, as in `ladder-alert.sh`) — loading the whole file would hand the re-probe the feed keys step 1's probe ran without. */
async function push(msg: NtfyMessage): Promise<string> {
  const envFile = `${ROOT}.env.local`;
  let env = readEnv();
  if (!env.NTFY_TOPIC?.trim() && existsSync(envFile)) {
    const topic = parseEnv(readFileSync(envFile, "utf8")).NTFY_TOPIC;
    if (topic) env = { ...env, NTFY_TOPIC: topic };
  }
  if (!ntfyPushEnabled(env)) return `ntfy     suppressed (no NTFY_TOPIC in env or .env.local) — ${msg.title}`;
  // The tap link: a host run's env carries no PROD_ALIAS, so it comes from the prod config — into this object only.
  env = withConfigAlias(env);
  try {
    await pushNtfy(msg, { env });
    return `ntfy     pushed — ${msg.title}`;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    // The run commits `runs[0]` = today, so the next run dedupes this alert away — the timer's failure alert is its only trace.
    if (process.env.LADDER_PUSH_FAILED_FILE) appendFileSync(process.env.LADDER_PUSH_FAILED_FILE, `${leg}: ${msg.title} — ${why}\n`);
    return `ntfy     push FAILED (${why}) — ${msg.title}`;
  }
}

async function runApply(given: LadderPatch): Promise<ReturnType<typeof applyRun>> {
  const stubFile = process.argv.find((a) => a.startsWith("--prelabels="))?.slice("--prelabels=".length);
  const stub = stubFile ? (JSON.parse(readFileSync(stubFile, "utf8")) as { patch: { signs: Record<string, LadderPatch["signs"][string]> } }).patch : { signs: {} };
  const { patch: filled, warned } = fillMechanical(given, stub, planRun(live, today, leg, {}, now).research.map((r) => r.sign));
  const patch = filled as LadderPatch;
  // Dry pass first: `applyRun` is pure and raises every patch rejection itself, so a bad patch fails before any live feed is fetched.
  applyRun(live, patch, today, leg, undefined, undefined, now);
  const reverdict = isReprobe(leg) && movesVerdict(live, patch, today) ? await (await REPROBE[leg]()).liveReverdict() : undefined;
  const out = applyRun(live, patch, today, leg, reverdict, runStamp(today, now), now);
  return { ...out, delta: [out.delta[0]!, ...warned, ...out.delta.slice(1)] };
}
