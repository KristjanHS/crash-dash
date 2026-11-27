/**
 * A4 measurement: how often does each of
 * `containmentGrid`'s four containment/quorum knobs DECIDE a feed's publication grid?
 *
 * Counterfactual, not branch-counting: per target feed, build the live-knob grid, then rebuild it with
 * ONE knob neutralised (its mechanism switched off — see `NEUTRAL`) and count the grid dates that
 * changed. A knob whose neutralisation moves no feed's grid over the window decided nothing there; a
 * rejected peer or excused day that never reached the final grid is NOT a decision.
 *
 * ⚠ `outageQuorum → ∞` switches the whole excusal mechanism off, so its row is "the quorum path as a
 * whole"; `outageQuorumMinVoters → 0` removes only the voter-count gate, so its row is that gate's
 * MARGINAL contribution. Read the two together.
 *
 * Arms (default both): `--arm=fred` — keyless FRED, `--years=3`, the same FRED daily roster
 * `probe:readpath-lag` sweeps; `--arm=prod` — the store roster `freshnessFrom` scans, `LAG_SCAN_LIMIT`
 * observations deep (`--env=prod|local`, default prod, creds via `resolveStore`). Measurement only:
 * prints tables, never exits non-zero on a count.
 */
import { CADENCE_OF, compositeComponentLegIds, LAG_CHUNK_IDS, LAG_SCAN_LIMIT } from "../src/feed-lag.js";
import { CALENDAR_KNOBS, type CalendarKnobs, containmentGrid, type FeedObservations } from "../src/publication-calendar.js";
import { INDICATORS } from "../src/registry-fred.js";
import { FEED_OF } from "../src/registry.js";
import { resolveStore } from "./backfill/resolve-store.js";
import { argOf, envArgStrict } from "./lib/cli.js";

const DAY_MS = 86_400_000;

/** One knob's mechanism switched OFF. */
export const NEUTRAL: Readonly<Record<keyof CalendarKnobs, number>> = {
  containmentTolerance: Infinity, // no peer is ever rejected for printing on a chargeable silent day
  outageQuorum: Infinity, // no silent day is ever excused as the target's own outage (a ratio is ≤ 1)
  outageQuorumMinVoters: 0, // the voter-count gate is gone; the ratio alone excuses
  quorumVoterTolerance: Infinity, // every candidate is admitted as a voter
};

export interface KnobRow {
  knob: keyof CalendarKnobs;
  feedsDecided: number;
  datesChanged: number;
  throwFlips: number;
  top: { id: string; changed: number; flip?: boolean }[];
}

const gridDates = (target: FeedObservations, cands: readonly FeedObservations[], knobs: CalendarKnobs): Set<string> | "THROW" => {
  try {
    return new Set(containmentGrid(target, cands, knobs).dates);
  } catch {
    return "THROW";
  }
};

/** Per knob: targets whose grid (built over `feeds` as the candidate pool) moved when that knob alone
 *  was neutralised, and by how many dates. `targets` ⊆ `feeds` in practice; the pool stays whole. */
export function knobDecisions(targets: readonly FeedObservations[], feeds: readonly FeedObservations[] = targets): KnobRow[] {
  const base = new Map(targets.map((f) => [f.id, gridDates(f, feeds, CALENDAR_KNOBS)]));
  return (Object.keys(NEUTRAL) as (keyof CalendarKnobs)[]).map((knob) => {
    const alt: CalendarKnobs = { ...CALENDAR_KNOBS, [knob]: NEUTRAL[knob] };
    const per: { id: string; changed: number; flip?: boolean }[] = [];
    let throwFlips = 0;
    for (const f of targets) {
      const d0 = base.get(f.id)!;
      const d1 = gridDates(f, feeds, alt);
      if (d0 === "THROW" || d1 === "THROW") {
        // A grid that exists under one knob setting and THROWS (below the source floor) under the
        // other is a decision too, but of a different kind — counted apart, never as dates.
        if (d0 !== d1) {
          throwFlips++;
          per.push({ id: f.id, changed: 0, flip: true });
        }
        continue;
      }
      let changed = 0;
      for (const d of d0) if (!d1.has(d)) changed++;
      for (const d of d1) if (!d0.has(d)) changed++;
      if (changed > 0) per.push({ id: f.id, changed });
    }
    per.sort((a, b) => b.changed - a.changed || Number(b.flip ?? false) - Number(a.flip ?? false));
    return { knob, feedsDecided: per.length, datesChanged: per.reduce((a, p) => a + p.changed, 0), throwFlips, top: per.slice(0, 3) };
  });
}

function printTable(label: string, targets: readonly FeedObservations[], feeds: readonly FeedObservations[], rows: readonly KnobRow[]): void {
  const throwing = targets.filter((f) => gridDates(f, feeds, CALENDAR_KNOBS) === "THROW").map((f) => f.id);
  console.log(`\n${label}: ${targets.length} targets over a ${feeds.length}-feed pool (live-knob grid throws for ${throwing.length}: ${throwing.join(", ") || "-"})`);
  console.log(`  ${"knob".padEnd(24)} ${"feeds-decided".padStart(13)} ${"dates-changed".padStart(13)} ${"throw-flips".padStart(11)}  top feeds`);
  for (const r of rows) {
    const top = r.top.map((t) => `${t.id}:${t.flip ? "throw-flip" : t.changed}`).join(" ");
    console.log(`  ${r.knob.padEnd(24)} ${`${r.feedsDecided}/${targets.length}`.padStart(13)} ${String(r.datesChanged).padStart(13)} ${String(r.throwFlips).padStart(11)}  ${top}`);
  }
}

async function fredObservationDates(series: string): Promise<string[]> {
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}`);
  if (!res.ok) throw new Error(`${series}: HTTP ${res.status}`);
  return (await res.text())
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(","))
    .filter(([, v]) => v !== undefined && v.trim() !== "" && v.trim() !== "." && Number.isFinite(Number(v)))
    .map(([d]) => d as string);
}

async function fredArm(years: number): Promise<void> {
  const roster = INDICATORS.filter((i) => (i.cadence ?? "daily") === "daily" && FEED_OF[i.id] !== "prices" && FEED_OF[i.id] !== "ntfs").map((i) => i.series);
  const from = new Date(Date.now() - years * 365 * DAY_MS).toISOString().slice(0, 10);
  const feeds: FeedObservations[] = [];
  for (const id of roster) feeds.push({ id, dates: (await fredObservationDates(id)).filter((d) => d >= from), independent: true });
  printTable(`ARM fred — keyless FRED, ${years}y from ${from}, roster ${roster.join(", ")}`, feeds, feeds, knobDecisions(feeds));
}

async function prodArm(): Promise<void> {
  const env = envArgStrict("prod");
  const store = await resolveStore(env);
  const ids = [...CADENCE_OF.keys()].filter((id) => (CADENCE_OF.get(id) ?? "daily") === "daily");
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += LAG_CHUNK_IDS) chunks.push(ids.slice(i, i + LAG_CHUNK_IDS));
  const maps = await Promise.all(chunks.map((c) => store.getSeriesBulk(c, { limit: LAG_SCAN_LIMIT })));
  const legIds = compositeComponentLegIds();
  const feeds: FeedObservations[] = [];
  for (const m of maps) for (const [id, pts] of m) feeds.push({ id, dates: pts.map((p) => p.date), independent: !legIds.has(id) });
  // TARGETS mirror what `freshnessFrom` actually grids: a composite leg is gridded through its PARENT
  // (never itself), and a zero-row id short-circuits to `lag: true` before any grid work. The candidate
  // POOL stays the whole daily roster, legs included, exactly as `allDailyFeeds` does. Weekly targets
  // (gridded against the same pool) are not swept here.
  const targets = feeds.filter((f) => !legIds.has(f.id) && f.dates.length > 0);
  printTable(`ARM ${env} — freshnessFrom's daily grid targets (non-leg, ≥1 row) over its whole daily pool, ${LAG_SCAN_LIMIT} obs deep`, targets, feeds, knobDecisions(targets, feeds));
}

async function main(): Promise<void> {
  const arm = argOf("arm") ?? "both";
  const show = (o: object): string => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`live knobs: ${show(CALENDAR_KNOBS)}\nneutralised one at a time to: ${show(NEUTRAL)}`);
  if (arm === "fred" || arm === "both") await fredArm(Number(argOf("years") ?? 3));
  if (arm === "prod" || arm === "both") await prodArm();
}

const isMain = process.argv[1]?.endsWith("probe-knob-decisions.ts") ?? false;
if (isMain) await main();
