/**
 * `npm run -s <leg>:state [--situation] [--full] [--today=YYYY-MM-DD] [--now=<ISO instant>]` (= `tsx scripts/ladder-state.ts --leg=<leg>`) — the
 * leg's skill run's read of `LEGS[leg].json`: `brief` + the leg's `leans`, the verdict tally + `planRun` (the rows to research and their calls), compact JSON
 * without `rules`; `situation` too when research is due or `situationOwed` (or `--situation`). `--full` = every field but `verdict.legs` and `situation.asOf`, indented.
 * `now` = the plan's clock (`nowArg`; absent on a backfill) — `<leg>:apply --now=<now>` re-plans on it, so a window crossed in between moves nothing.
 * Reads the other legs' JSONs for `siblings` — one missing or malformed is skipped. A due row whose sign names a `measure` script runs it (`withMeasured`; `--no-measure` skips).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { displayText, gatesText, legOf, trancheCell, watchContextRows, watchRows, LEGS, type LadderLegId, type LadderLive, type LadderTranche } from "../src/ladder-live.js";
import { dropMeasuredCalls, nowArg, planRun, withMeasured } from "../src/ladder-run.js";
import { printedSituation, slotsOf } from "../src/ladder-situation.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const leg = legOf(process.argv, "ladder:state");
const SRC = `${ROOT}${LEGS[leg].json}`;
if (!existsSync(SRC)) throw new Error(`${leg}:state — ${LEGS[leg].json} is missing; seed it with \`npm run ${LEGS[leg].probe} -- --into=${LEGS[leg].json}\``);
const live = JSON.parse(readFileSync(SRC, "utf8")) as LadderLive;
const now = nowArg(process.argv, `${leg}:state`, new Date());
const today = process.argv.find((a) => a.startsWith("--today="))?.slice(8) ?? new Date().toLocaleDateString("sv-SE");
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`${leg}:state — --today "${today}" is not YYYY-MM-DD`);
const v = live.verdict;
/** `null` = a licensed id's level, nulled in the public JSON (`scrubLicensedLevelsInLeg`) — prints `—`, as prose does. */
const level = (x: number | null) => (x === null ? "—" : `${+x.toFixed(2)}`);
const tally = (t: LadderTranche) =>
  `${t.id} ${trancheCell(t)}`;
const verdict = v
  ? {
      regime: v.regime,
      ...(v.display && { display: displayText(v.display) }),
      prov: v.prov,
      close: v.tranches.map(tally),
      live: v.live.map(tally),
      escalation: `${v.escalation.tripped}/${v.escalation.need} (${v.escalation.hits.join(" · ")})${v.escalation.near?.length ? ` · near: ${v.escalation.near.join(" · ")}` : ""}${v.sessionsSinceExit === undefined ? "" : ` · ${v.sessionsSinceExit} closes since the drawdown opened`}`,
      ...(v.shocks && {
        levels: Object.entries(v.shocks).flatMap(([id, sh]) =>
          sh ? [`${id}${sh.last === undefined ? "" : ` ${level(sh.last)} (${sh.lastDate!.slice(5)} close)`}, peak ${level(sh.peak)} (${sh.peakDate.slice(5)}), base ${level(sh.base)}`] : [],
        ),
      }),
      inactive: v.inactive ?`${v.inactive.set} set, not in force: ${v.inactive.tranches.map((t) => `${t.tranche} ${t.metCount}/${t.total}${gatesText(t.gates)}`).join(" · ")}` : null,
      ...(v.watch && { watch: { grade: v.watch.grade, drawdownOpen: !v.watch.held, ...(v.watch.exit && { openSince: v.watch.exit }), rows: watchRows(v).map((r) => r.slice(0, 4).join(" · ")), context: watchContextRows(v).map((r) => r.slice(0, 4).join(" · ")) } }),
    }
  : null;
/** Another leg's `events`, or undefined when its JSON is missing, malformed or holds no `events` array. */
const eventsOf = (l: LadderLegId): Pick<LadderLive, "events"> | undefined => {
  try {
    const o = JSON.parse(readFileSync(`${ROOT}${LEGS[l].json}`, "utf8")) as Partial<LadderLive>;
    return Array.isArray(o.events) ? { events: o.events } : undefined;
  } catch {
    return undefined;
  }
};
const others = Object.fromEntries((Object.keys(LEGS) as LadderLegId[]).filter((l) => l !== leg).flatMap((l) => ((o) => (o ? [[l, o] as const] : []))(eventsOf(l))));
const { rules: _rules, ...plan } = planRun(live, today, leg, others, now);
/** A failing script still prints its `{error}` JSON on stdout — hand that back rather than the exit status. */
const runScript = (script: string): string => {
  try {
    return execFileSync("npm", ["run", "-s", script, "--", "--json"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 45_000 });
  } catch (e) {
    const out = (e as { stdout?: string }).stdout;
    if (out?.trim()) return out;
    throw e;
  }
};
// Measured only on a live clock (a backfill plan gets no today-reading) and never for `--full` / the runner's `--no-measure` pre-check.
if (now && !process.argv.includes("--full") && !process.argv.includes("--no-measure")) Object.assign(plan, dropMeasuredCalls({ ...plan, research: withMeasured(plan.research, live, runScript) }, live));
const out: Record<string, unknown> = process.argv.includes("--full")
  ? { run: live.run, ...(now && { now: now.toISOString() }), brief: live.brief, leans: LEGS[leg].leans, rules: live.rules, situation: slotsOf(live.situation), verdict, ...(plan.thresholdless && { thresholdless: plan.thresholdless }), signs: live.signs, events: live.events, eventsDone: live.eventsDone, calendar: live.calendar, runs: live.runs }
  : (({ kept: _kept, ...printed }) => ({ ...(now && { now: now.toISOString() }), brief: live.brief, leans: LEGS[leg].leans, verdict, ...printed }))(plan);
const situation = printedSituation(live, plan, process.argv.includes("--situation"));
if (situation) Object.assign(out, { situation });
console.log(process.argv.includes("--full") ? JSON.stringify(out, null, 1) : JSON.stringify(out));
