/**
 * probe-is7-diffusion-replay.ts — IS-7 §17.5.6 / §17.7.1-6 OWED: the REAL-CLOSE REPLAY of the
 * member-level diffusion copy on the push body.
 *
 *   npm run probe:is7-diffusion                        # the WHOLE date axis (the default)
 *   npm run probe:is7-diffusion -- --closes=2500 --show=12   # a truncated tail, for a quick look
 *
 * ⚠ **`npm run probe:is7-diffusion` is the notify-copy instrument** — `sim:notify` is blind to it.
 * ⚠ The push already had an OUTER family-level breadth line (`notify_format`'s `familyNote`); the IS-7
 * count is the INNER one — never call both "firing" unqualified.
 *
 * ⚠ `--closes=N` TRUNCATES the axis and can make the run RED for a reason that is not a
 * regression: the zero-firing NON-VACUITY check needs a calm close, and the recent tail has none.
 * The default is therefore the full axis — this is a whole-history instrument.
 *
 * WHY IT EXISTS. `npm run sim:notify` cannot judge this copy: per
 * `.claude/rules/research-probes.md` §"`sim:notify` is not evidence", its 15 worlds are
 * single synthesized closes with every family member set to the FAMILY's state and no cut layer —
 * so every diffusion count there is degenerate by construction (`N red / N elevated of N`, and
 * `absent` structurally 0). Those are exactly the numbers §17.1/§17.2 exist to discriminate, so the
 * copy has to be read off REAL persisted closes or it is not read at all.
 *
 * WHAT IT REPLAYS. For each close on the dev store's date axis it rebuilds the run's combined
 * readings by the shipped forward-fill horizon (`FFILL_MAX_CALENDAR_DAYS`), feeds them through the
 * SHIPPED `assembleDial` (raw panel → rank-7 `applyFamilyCarry` → dial), and renders the two push
 * surfaces verbatim: `formatRunSummary(...).summary` (the outer `· families K/N firing (...)` line)
 * and `diffusionLines(...)` (the inner IS-7 lines). Both are the shipped functions — no local
 * re-implementation of the copy, because the thing under measurement IS the shipped string.
 *
 * VINTAGE SHIM (why the store is wrapped). `assembleDial`'s carry reads last-known family states via
 * `store.getSeries(id, 2)` — the LATEST two points. At a historical anchor that is future data, so a
 * future-leaking carry renders a family off a state the real run of that day could not have known.
 * Every read therefore goes through a per-anchor shim that truncates each series to `date <= asOf`
 * before applying the caller's limit/range. Prefetch-once, filter-per-anchor.
 *
 * The shim is FALSIFIED, not asserted: the injected arm below renders its anchor TWICE — once
 * through the shim, once through `futureLeakingStore()` (the same reads with the truncation
 * removed) — and the run FAILS unless the two rendered lines DIFFER. Delete the `date <= asOf`
 * filter and that check goes red, so the claim above is measured on every run.
 *
 * ARMS:
 *   · REPLAY   — the real panel at every close. The measurement.
 *   · INJECTED — at one derived HISTORICAL anchor, one firing family's members are all dropped from
 *                the readings so `applyFamilyCarry`'s ZERO-MEMBER branch actually executes. Without
 *                it the `no members reporting` check could only ever pass by never running (§17.2's
 *                `0 of 0` guard would be asserted vacuously). This arm is a mutation of the INPUT
 *                readings, never of the store. The anchor is chosen as the latest close where the
 *                shim actually BITES (see above) — never the last row, where truncation is a no-op.
 *
 * NON-VACUITY the probe polices on itself: it FAILS if the replay produced zero rendered lines, if
 * the zero-firing neutrality claim was never exercised by a real close, if the injection arm did
 * not reach the zero-member branch, or if the vintage shim turned out to be inert (above) — a green
 * run with no exercised claim is a probe defect, not a result. Degeneracy of the counts is NOT a failure: it is a finding about the copy.
 *
 * ⚠ STRICTLY READ-ONLY: only `getSeries`/`getSeriesBulk` (selects) are ever called, always against
 * `--env=local`. There is no prod path and no write path in this file — the dev DB's history is
 * irreplaceable (`docs/reference.md` §[runbook] Database (local Supabase)).
 *
 * Data-pull, union axis and forward-fill come from `scripts/lib/replay-walk.ts` (`loadSeries` /
 * `unionCalendar` / `makeCursor` / `ffillReadings`). BOTH per-close walks stay here — the ascending
 * replay loop and the DESCENDING injected-arm scan — each under its own SEAM comment.
 */
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import { assembleDial, DIAL_FAMILIES } from "../src/dial-assembly.js";
import type { FamilyPanel } from "../src/families.js";
import { FACTOR_OF } from "../src/registry.js";
import { diffusionLines, formatRunSummary } from "../src/notify_format.js";
import { regimeToBand } from "../src/alert-band.js";
import type { ReadStore, SeriesPoint, SeriesRange, Store } from "../src/store.js";
import type { State } from "../src/domain-types.js";
import { argOf } from "./lib/cli.js";
import { ffillReadings, loadSeries, makeCursor, unionCalendar } from "./lib/replay-walk.js";

// ---------- args ----------
// DEFAULT = the full axis (`Infinity` ⇒ `axis.slice(-Infinity)` is the whole array). A finite
// default truncated the axis to a tail with no calm close, so the documented bare invocation
// exited 1 on a healthy build (review finding, 2026-07-31).
const closesArg = argOf("closes");
const REPLAY_N = closesArg === undefined ? Number.POSITIVE_INFINITY : Number(closesArg);
const SHOW_N = Number(argOf("show") ?? 8);
const fromArg = argOf("from");
const toArg = argOf("to");

const FETCH_LIMIT = 20_000;

if (!(REPLAY_N >= 1)) {
  console.log(`ABORT: --closes must be a positive integer (got ${closesArg}).`);
  process.exit(1);
}

let store: ReadStore;
try {
  store = await resolveStore("local", "ro", liveResolveDeps);
} catch (e: unknown) {
  console.log(
    `ABORT: no LOCAL store reachable — ${e instanceof Error ? e.message : String(e)}\n` +
      `    The dev stack defaults DOWN — start it (\`npx supabase start\`) or re-run under the\n` +
      `    front door: scripts/db.sh with dev -- npm run probe:is7-diffusion`,
  );
  process.exit(1);
}

// ---------- data pull (READ-ONLY) ----------
const memberIds = [...new Set(DIAL_FAMILIES.flatMap((f) => f.ids))];
// SEAM (Stage 3.C-2): `loadSeries` — same parallel read, same fail-loud on a swallowed fetch throw
// (the ABORT text is now the module's unified wording). `LoadOptions.asOf` is DECLINED: this probe's
// point-in-time truncation is PER ANCHOR and lives inside the read closure (`vintageStore`), so it
// cannot be applied once at load time. `coverageOf`/`printCoverage` are DECLINED too — the probe
// prints no per-member coverage block and §Stage 3.A (c) forbids inventing one.
const fullSeries = await loadSeries(store, memberIds, FETCH_LIMIT);

/** Lazy full-history cache for ids the shim is asked for beyond the dial roster (e.g. F7/CAPE). */
async function fullOf(id: string): Promise<SeriesPoint[]> {
  const hit = fullSeries.get(id);
  if (hit) return hit;
  const pts = await store.getSeries(id, FETCH_LIMIT).catch(() => [] as SeriesPoint[]);
  fullSeries.set(id, pts);
  return pts;
}

/** A READ-ONLY store view truncated to `asOf` — see the VINTAGE SHIM note in the docblock. */
function vintageStore(asOf: string): Pick<Store, "getSeries" | "getSeriesBulk"> {
  const read = async (id: string, limit: number, range?: SeriesRange): Promise<SeriesPoint[]> => {
    let pts = (await fullOf(id)).filter((p) => p.date <= asOf);
    if (range?.from) pts = pts.filter((p) => p.date >= range.from!);
    if (range?.to) pts = pts.filter((p) => p.date <= range.to!);
    return pts.slice(-limit);
  };
  return {
    getSeries: read,
    async getSeriesBulk(ids: string[], opts: { limit: number; range?: SeriesRange }) {
      const out = new Map<string, SeriesPoint[]>();
      for (const id of ids) out.set(id, await read(id, opts.limit, opts.range));
      return out;
    },
  };
}

/** The SAME reads with the `date <= asOf` truncation REMOVED — the future-leaking counterfactual
 *  the shim exists to prevent. Used only by the injected arm's shim falsifier. */
function futureLeakingStore(): Pick<Store, "getSeries" | "getSeriesBulk"> {
  const read = async (id: string, limit: number, range?: SeriesRange): Promise<SeriesPoint[]> => {
    let pts = await fullOf(id);
    if (range?.from) pts = pts.filter((p) => p.date >= range.from!);
    if (range?.to) pts = pts.filter((p) => p.date <= range.to!);
    return pts.slice(-limit);
  };
  return {
    getSeries: read,
    async getSeriesBulk(ids: string[], opts: { limit: number; range?: SeriesRange }) {
      const out = new Map<string, SeriesPoint[]>();
      for (const id of ids) out.set(id, await read(id, opts.limit, opts.range));
      return out;
    },
  };
}

// ---------- the replay axis ----------
// SEAM (Stage 3.C-2): `unionCalendar` — the axis is the union of every DIAL MEMBER's observation
// dates. `memberIds` is passed EXPLICITLY rather than leaning on the `ids` default (`fullSeries`'
// keys): `fullOf` MUTATES `fullSeries`, inserting off-roster ids (F7/CAPE) on demand, so the default
// is only equal to the roster while no shim read has run yet. Passing it makes the axis roster-pinned
// regardless of call order, matching `readingsAt`, which already passes `memberIds`.
// `calendarFrom` is DECLINED: a single-series F4 axis would drop every close only another member moved on.
const axis = unionCalendar(fullSeries, memberIds);
if (axis.length === 0) {
  console.log("ABORT: the store returned zero closes for every dial member — nothing to replay.");
  process.exit(1);
}
// SEAM (Stage 3.C-2): `selectReplayDates` is DECLINED — its three aborts do not match this probe's
// two, and one of them is UNSATISFIABLE here. Guard 1 (`calendar.length < replayN + CALENDAR_MARGIN`)
// fires for EVERY axis when `REPLAY_N` is the documented default `Infinity`, so adopting it would make
// the bare invocation exit 1 — the exact regression the 2026-07-31 review fixed. Guard 3
// (`fromArg && replayDates[0] > fromArg`) is newly REACHABLE behaviour this probe does not have: it
// deliberately runs the whole axis and lets a too-early `--from` be a no-op. Guard 2 (empty window) is
// the one it already carries, kept below with its own wording.
const windowed = axis.slice(-REPLAY_N);
let replayDates = windowed;
if (fromArg) replayDates = replayDates.filter((d) => d >= fromArg);
if (toArg) replayDates = replayDates.filter((d) => d <= toArg);
if (replayDates.length === 0) {
  console.log(`ABORT: the --from/--to window selects 0 of the last ${windowed.length} closes. Widen --closes.`);
  process.exit(1);
}

type Reading = { id: string; state: State; factor?: string };
/**
 * The run's combined readings at `d`, under the shipped forward-fill horizon (`ffillReadings`).
 *
 * `factor` — the registry `geoFactor` tag, stamped from the SHARED `FACTOR_OF` (registry.ts), not a
 * second table. This probe exists to render the shipped `diffusionLabel`, which since R2 (2026-08-06)
 * counts DISTINCT FACTORS: without the tag `gp`'s three oil reads (G1/BRENT/OVX) print as `3 red …
 * of 3` and the replay would certify a breadth prod never emits. An untagged id is absent from the
 * map ⇒ `undefined` ⇒ it counts as its own factor, exactly as before the tag existed.
 *
 * `cursor` is a PARAMETER DEFAULT, re-evaluated per call: omitting it yields a fresh full scan, which
 * is what keeps the INJECTED arm's DESCENDING walk correct (a shared monotonic cursor would
 * forward-fill from the future there). Only the ascending REPLAY loop passes the shared cursor.
 */
function readingsAt(d: string, cursor: (id: string, dd: string) => number = makeCursor(fullSeries)): Reading[] {
  return ffillReadings(fullSeries, cursor, memberIds, d).map((r) => ({
    ...r,
    ...(FACTOR_OF[r.id] !== undefined ? { factor: FACTOR_OF[r.id]! } : {}),
  }));
}

/** Render the exact push-body fragment IS-7 touches: the summary line + the inner lines. */
async function renderAt(
  d: string,
  readings: Reading[],
  storeView: Pick<Store, "getSeries" | "getSeriesBulk"> = vintageStore(d),
): Promise<{ summary: string; lines: string[]; panel: FamilyPanel[] }> {
  const { globalPanel, dial } = await assembleDial({ readings, asOf: d, store: storeView });
  const band = regimeToBand(dial.notifyRegime);
  // `readings` is passed EMPTY to formatRunSummary on purpose: its `lines` output (the full
  // per-reading list) is not part of the push body, and `summary` — the only thing rendered here —
  // reads nothing but `band`, `dial` and the panel.
  const { summary } = formatRunSummary([], band, dial, globalPanel);
  return { summary, lines: diffusionLines(globalPanel), panel: globalPanel };
}

// ---------- the shipped line grammar, as a parser (checks read the STRING, not the panel) ----------
const COUNT_RE = /^ {2}(\S+) +(GREEN|AMBER|RED), (?:(\d+) red \/ (\d+) elevated of (\d+)|no members reporting)( \((\d+) dark\))?$/;
interface Parsed {
  date: string;
  line: string;
  key: string;
  state: string;
  red: number | null;
  elevated: number | null;
  present: number | null;
  dark: number;
}
function parseLine(date: string, line: string): Parsed | null {
  const m = COUNT_RE.exec(line);
  if (!m) return null;
  return {
    date,
    line,
    key: m[1]!,
    state: m[2]!,
    red: m[3] === undefined ? null : Number(m[3]),
    elevated: m[4] === undefined ? null : Number(m[4]),
    present: m[5] === undefined ? null : Number(m[5]),
    dark: m[7] === undefined ? 0 : Number(m[7]),
  };
}

let ok = true;
const check = (name: string, pass: boolean, detail = "") => {
  ok = ok && pass;
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log(
  `[probe-is7-diffusion-replay] IS-7 §17.5.6 real-close replay — env=local, ${replayDates.length} closes ` +
    `${replayDates[0]} → ${replayDates.at(-1)}, ${memberIds.length} DIAL members`,
);

// ---------- REPLAY arm ----------
interface Row {
  date: string;
  summary: string;
  lines: string[];
  parsed: Parsed[];
  firing: number;
  panel: FamilyPanel[];
}
const rows: Row[] = [];
// SEAM (Stage 3.C-2): the loop stays in-probe — `walkReplay`'s fold does not apply. The point-in-time
// vintage truncation lives INSIDE the read closure (`asOf` within `vintageStore`, reached from
// `readingsAt`'s caller `renderAt`), downstream of where `walkReplay` fetches, and the INJECTED arm
// mutates the readings array in memory rather than folding at the walk layer.
const walkCursor = makeCursor(fullSeries); // ascending-only — `replayDates` is sorted ascending.
for (const d of replayDates) {
  const readings = readingsAt(d, walkCursor);
  const { summary, lines, panel } = await renderAt(d, readings);
  rows.push({
    date: d,
    summary,
    lines,
    parsed: lines.map((l) => parseLine(d, l)).filter((p): p is Parsed => p !== null),
    firing: panel.filter((f) => f.live && f.firing).length,
    panel,
  });
}

const allLines = rows.flatMap((r) => r.lines);
const allParsed = rows.flatMap((r) => r.parsed);
const unparsed = rows.flatMap((r) => r.lines.filter((l) => parseLine(r.date, l) === null));

console.log(`\n══ rendered corpus ══`);
console.log(`  closes replayed ${rows.length} · closes with ≥1 firing family ${rows.filter((r) => r.firing > 0).length} · rendered lines ${allLines.length}`);

check("NON-VACUITY: the replay rendered at least one diffusion line", allLines.length > 0);
check(
  "every rendered line matches the §17.1/§17.2 grammar",
  unparsed.length === 0,
  unparsed.length ? `unparsed: ${unparsed.slice(0, 3).map((l) => JSON.stringify(l)).join(" · ")}` : `${allParsed.length} parsed`,
);

// ---------- finding 1: degeneracy ----------
const counted = allParsed.filter((p) => p.red !== null);
const nonDegenerate = counted.filter((p) => p.red! < p.elevated! || p.elevated! < p.present!);
const distinct = new Map<string, Parsed>();
for (const p of nonDegenerate) if (!distinct.has(p.line.trim())) distinct.set(p.line.trim(), p);
console.log(`\n══ finding 1 — degeneracy ══`);
console.log(
  `  counted lines ${counted.length} · NON-degenerate (red<elevated OR elevated<present) ${nonDegenerate.length}` +
    ` (${((100 * nonDegenerate.length) / Math.max(1, counted.length)).toFixed(1)}%) · distinct forms ${distinct.size}`,
);
for (const [, p] of [...distinct].slice(0, SHOW_N)) console.log(`    ${p.date}  ${p.line}`);
if (nonDegenerate.length === 0) {
  console.log(`  ⚠ EVERY real close is DEGENERATE (N red / N elevated of N) — a finding about the copy's value.`);
}

// ---------- finding 2: the `(N dark)` clause ----------
const dark = allParsed.filter((p) => p.dark > 0);
const darkForms = new Map<string, Parsed>();
for (const p of dark) if (!darkForms.has(p.line.trim())) darkForms.set(p.line.trim(), p);
console.log(`\n══ finding 2 — the (N dark) clause ══`);
console.log(`  lines with absent>0: ${dark.length} / ${allParsed.length} · distinct forms ${darkForms.size}`);
for (const [, p] of [...darkForms].slice(0, SHOW_N)) console.log(`    ${p.date}  ${p.line}`);
if (dark.length === 0) console.log(`  ⚠ UNEXERCISED on real data — no replayed close ever printed "(N dark)".`);

// ---------- finding 3: elevated >= red, read off the STRING ----------
const invBreaches = counted.filter((p) => p.elevated! < p.red! || p.red! > p.present! || p.elevated! > p.present!);
check(
  "§17.1 invariant on every rendered line: red ≤ elevated ≤ present",
  invBreaches.length === 0,
  invBreaches.length ? `first breach ${invBreaches[0]!.date} ${invBreaches[0]!.line}` : `${counted.length} counted lines`,
);

// ---------- finding 4: zero-firing neutrality ----------
const calm = rows.filter((r) => r.firing === 0);
const calmWithLines = calm.filter((r) => r.lines.length > 0);
check(
  "§17.3 neutrality: a close with ZERO firing families emits ZERO diffusion lines",
  calmWithLines.length === 0,
  `${calm.length} zero-firing closes examined` + (calmWithLines.length ? `, offender ${calmWithLines[0]!.date}` : ""),
);
check(
  "NON-VACUITY: the zero-firing case was actually exercised by a real close",
  calm.length > 0,
  calm.length === 0 ? "every replayed close had ≥1 firing family — widen --closes" : "",
);

// ---------- finding 5: the applyFamilyCarry ZERO-MEMBER branch ----------
console.log(`\n══ finding 5 — applyFamilyCarry zero-member branch ══`);
const naturalZero = allParsed.filter((p) => p.red === null);
console.log(`  natural occurrences in the replay: ${naturalZero.length}` + (naturalZero.length ? ` (e.g. ${naturalZero[0]!.date}  ${naturalZero[0]!.line})` : ""));

// INJECTED arm — derived anchor: walking back from the latest close, the first one whose panel has
// a firing family with ≥1 present member AND where the VINTAGE SHIM changes what that family
// renders (see the docblock). That family's members are dropped from the readings so the carry must
// re-mark it live+firing off last-known state with ZERO present members. Anchoring on the shim's
// bite is what keeps the shim falsifiable: the last row is structurally a no-op for truncation, so
// an arm pinned there could never tell a working shim from a deleted one. Nothing is written; only
// the in-memory readings array is mutated.
let injected: { date: string; key: string; line: string } | null = null;
let shimBite: { date: string; key: string; vintage: string; leaked: string | null } | null = null;
// SEAM (Stage 3.C-2): the second per-close walk, DESCENDING, stays in-probe for the same reason as
// the ascending one above — and it deliberately calls `readingsAt` WITHOUT a cursor, taking the
// fresh-scan default. Sharing the ascending walk's monotonic cursor here would forward-fill from the
// future; the hazard is written out in `readingsAt`'s own docblock, not duplicated here.
for (const r of [...rows].reverse()) {
  const victim = r.panel.find((f) => f.live && f.firing && f.members.length > 0);
  if (!victim) continue;
  const victimIds = new Set(DIAL_FAMILIES.find((f) => f.key === victim.key)!.ids);
  const starved = readingsAt(r.date).filter((x) => !victimIds.has(x.id));
  const lineOf = (out: { lines: string[] }) => out.lines.find((l) => l.trim().startsWith(victim.key)) ?? null;
  const vintageLine = lineOf(await renderAt(r.date, starved, vintageStore(r.date)));
  if (vintageLine === null) continue;
  injected ??= { date: r.date, key: victim.key, line: vintageLine };
  const leakedLine = lineOf(await renderAt(r.date, starved, futureLeakingStore()));
  if (leakedLine !== vintageLine) {
    shimBite = { date: r.date, key: victim.key, vintage: vintageLine, leaked: leakedLine };
    injected = { date: r.date, key: victim.key, line: vintageLine };
    break;
  }
}
if (injected) {
  console.log(`  INJECTED (all "${injected.key}" members dropped from the readings, ${injected.date}):`);
  console.log(`    ${injected.line}`);
}
if (shimBite) {
  console.log(`  SHIM FALSIFIER at ${shimBite.date} (family "${shimBite.key}"):`);
  console.log(`    vintage (date <= asOf) : ${JSON.stringify(shimBite.vintage)}`);
  console.log(`    future-leaking (no cut): ${JSON.stringify(shimBite.leaked)}`);
}
check(
  "VINTAGE SHIM is load-bearing: at the injected anchor the truncated and untruncated carry DIFFER",
  shimBite !== null,
  shimBite === null
    ? "no anchor on the whole axis where dropping `date <= asOf` changed the rendered line — the shim is INERT here, so its docblock claim is unsupported"
    : `${shimBite.date} ${shimBite.key}`,
);
const zeroMemberLines = [...naturalZero.map((p) => p.line), ...(injected ? [injected.line] : [])];
check(
  "NON-VACUITY: the zero-member branch was reached (naturally or by injection)",
  zeroMemberLines.length > 0,
  `${naturalZero.length} natural + ${injected ? 1 : 0} injected`,
);
check(
  "§17.2 zero-member branch prints `no members reporting` and NEVER `0 of 0`",
  zeroMemberLines.length > 0 && zeroMemberLines.every((l) => l.includes("no members reporting") && !/of 0\b/.test(l)),
  zeroMemberLines[0] ?? "(unreached)",
);

// ---------- sample: the richest real pushes, verbatim ----------
console.log(`\n══ verbatim push fragments (richest real closes: most firing families, then most lines) ══`);
const richest = [...rows]
  .filter((r) => r.lines.length > 0)
  .sort((a, b) => b.firing - a.firing || b.lines.length - a.lines.length || (a.date < b.date ? 1 : -1))
  .slice(0, SHOW_N);
for (const r of richest) {
  console.log(`\n  ── ${r.date}`);
  console.log(`  ${r.summary}`);
  for (const l of r.lines) console.log(`  ${l}`);
}

console.log(`\n[probe-is7-diffusion-replay] ${ok ? "ALL CHECKS PASS" : "CHECKS FAILED"}`);
process.exit(ok ? 0 : 1);
