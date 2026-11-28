/**
 * /lab request-string parsers (?walk / ?hist / ?s scenario / ?replay range)
 * with the id-set and bound constants they validate against.
 */

import { US_FAMILIES, GLOBAL_FAMILIES, type FamilyKey } from "./families.js";
import type { State } from "./domain-types.js";
import { REPLAY_MAX_YEARS, REPLAY_MIN_SPAN_DAYS } from "./replay.js";
import { HY_LIVE_TAIL_ROWS } from "./input-series.js";
// @ts-expect-error — public/*.js ships no .d.ts (allowJs is off); resolves fine at runtime. Re-typed
// as `HIST_WINDOW: number` below.
import { LAB_LOOKBACK } from "../public/lab-lookback.js";
import { isoDay } from "./dates.js";

const FAMILY_KEYS = new Set<string>(US_FAMILIES.map((f) => f.key));

// Every member id across BOTH panels — the per-leg `?s=` toggle accepts any as an `id:STATE` override.
const INDICATOR_IDS = new Set<string>([...US_FAMILIES, ...GLOBAL_FAMILIES].flatMap((f) => f.ids));
const STATES = new Set<string>(["GREEN", "AMBER", "RED"]);
export const MS_PER_CALENDAR_DAY = 86_400_000;

// `/lab?walk=N` forward-walk clamp. Covers the idle-cash ratchet (`R4_RATCHET_DAYS`) plus a full rung
// walk with headroom; pure in-memory `assembleRun` iterations.
/** @internal */
export const WALK_CAP = 90;

/** Parse `?walk=N`. Absent / NaN / negative ⇒ 0. Above `WALK_CAP` REJECTS with a 400 rather than
 *  clamping (S-1 part 2: an abusive request must be cheap to refuse, and a clamp is an amplifier). */
export function parseWalk(raw: string | null | undefined): number | Response {
  if (raw === null || raw === undefined) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return 0;
  if (n > WALK_CAP) {
    return Response.json(
      { error: `walk must be ${WALK_CAP} or less` },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  return Math.max(n, 0);
}

/** The ONE momentum window any shipped client requests — `LAB_LOOKBACK` (public/lab-lookback.js), the
 *  same constant lab.js/overview.js build their `?hist=` URL from, so grid and URL can't split
 *  (`indicator-loop.md` §A retune is a ONE-place edit). */
const HIST_WINDOW: number = LAB_LOOKBACK;

/** Parse `?hist=N`. Absent / non-numeric / negative ⇒ 0 (OFF). CLOSED key space: `hist ∈ {0,
 *  HIST_WINDOW}` — any other positive int is REJECTED 400 `no-store`, never an arbitrary edge-cache key
 *  with the full member-history fan-out behind every MISS. */
export function parseHist(raw: string | null | undefined): number | Response {
  if (raw === null || raw === undefined) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return 0;
  if (n !== HIST_WINDOW) {
    return Response.json(
      { error: `hist must be 0 or ${HIST_WINDOW}` },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  return n;
}

/** Reserved scenario knobs (recognised before family validation). `tail` picks the synth R4 tail-print
 *  levels; `daysInCash` primes a cash prior N days old; `sustained` is a **no-op alias of `tail`**, kept
 *  so a bookmarked `&sustained` URL neither 404s nor changes meaning. SCENARIO-ONLY. */
export interface ScenarioOptions {
  tail: boolean;
  sustained: boolean;
  daysInCash: number;
  /** Each `lag:<id>` forces that member's freshness to `{ lag: true, label: "LAG" }` (the `◌` tier;
   *  repeats accumulate). SCENARIO-ONLY, applied downstream of the shared stamp so the no-knob case still
   *  satisfies `expect(scenario.field).toEqual(live.field)`. ⚠ `pair.split(":")` takes `[key, value]`, so
   *  a third segment (`lag:F9:rot`) is silently dropped. */
  lag: Set<string>;
}

/** Parse the `?s=` scenario override — `key:STATE,key:STATE` pairs. Empty string = a valid all-green
 *  scenario. Any unknown key / bad state / malformed pair → `{ error }` (→ 400). Over `SCENARIO_MAX_LEN`
 *  chars → `{ error }` too: the legit namespace fits in a few hundred chars, so reject rather than clamp. */
const SCENARIO_MAX_LEN = 4096;

export function parseScenario(
  raw: string,
): { states: Partial<Record<FamilyKey, State>>; members: Partial<Record<string, State>>; options: ScenarioOptions } | { error: string } {
  if (raw.length > SCENARIO_MAX_LEN) {
    return { error: `scenario too long - max ${SCENARIO_MAX_LEN} characters` };
  }
  const states: Partial<Record<FamilyKey, State>> = {};
  const members: Partial<Record<string, State>> = {};
  const options: ScenarioOptions = {
    tail: false,
    sustained: false,
    daysInCash: 0,
    lag: new Set<string>(),
  };
  if (raw.trim() === "") return { states, members, options }; // all-green scenario
  for (const pair of raw.split(",")) {
    const [key, value] = pair.split(":");
    if (!key || !value) {
      return { error: `bad scenario segment "${pair}" - expected key:STATE (GREEN|AMBER|RED)` };
    }
    // Reserved R4 knobs — recognised BEFORE family validation so they never fall
    // through to the key:STATE path.
    if (key === "tail" || key === "sustained") {
      if (value !== "0" && value !== "1") {
        return { error: `bad knob "${pair}" - expected ${key}:0|1` };
      }
      options[key] = value === "1";
      continue;
    }
    if (key === "daysInCash") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        return { error: `bad knob "${pair}" - expected daysInCash:<non-negative int>` };
      }
      options.daysInCash = n;
      continue;
    }
    if (key === "lag") {
      // 400 on an unknown id — a silently-dropped knob would read as a broken demo.
      if (!INDICATOR_IDS.has(value)) {
        return { error: `bad knob "${pair}" - expected lag:<indicator id>, e.g. lag:F1` };
      }
      options.lag.add(value);
      continue;
    }
    if (!STATES.has(value)) {
      return { error: `bad scenario segment "${pair}" - expected key:STATE (GREEN|AMBER|RED)` };
    }
    // Family key → whole-family base; else a member id → single-leg override. Namespaces are disjoint.
    if (FAMILY_KEYS.has(key)) {
      states[key as FamilyKey] = value as State;
    } else if (INDICATOR_IDS.has(key)) {
      members[key] = value as State;
    } else {
      return { error: `bad scenario segment "${pair}" - expected key:STATE (GREEN|AMBER|RED)` };
    }
  }
  return { states, members, options };
}

/** Newest-N row budget for the stored HY-OAS input read (`?replay=` only): the shared `HY_LIVE_TAIL_ROWS`
 *  cap (src/input-series.ts), keeping the stitch's vintage overlap off the deep revision-prone history. */
export const HY_INPUT_ROW_LIMIT = HY_LIVE_TAIL_ROWS;

/** Parse `?replay=YYYY-MM-DD:YYYY-MM-DD`. Rejected → `{ error }` (→ 400): malformed shape / start ≥ end /
 *  span < REPLAY_MIN_SPAN_DAYS / start older than today−REPLAY_MAX_YEARS. BOUNDS validated HERE, not
 *  replay.ts (computeReplay is a pure store-free leaf). `nowMs` injected so the floor is testable. */
export function parseReplay(raw: string, nowMs: number): { start: string; end: string } | { error: string } {
  const parts = raw.split(":");
  const bad = `bad replay range "${raw}" - expected YYYY-MM-DD:YYYY-MM-DD`;
  if (parts.length !== 2) return { error: bad };
  const [start, end] = parts as [string, string];
  // Shape + real-calendar-date check: Date.parse NaN rejects an impossible date (month 13) the regex passes.
  const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
  if (!isDate(start) || !isDate(end)) return { error: bad };
  if (start >= end) return { error: `bad replay range "${raw}" - start must be before end` };
  const spanDays = Math.floor((Date.parse(end) - Date.parse(start)) / MS_PER_CALENDAR_DAY);
  if (spanDays < REPLAY_MIN_SPAN_DAYS) {
    return { error: `replay range too short - need ≥ ${REPLAY_MIN_SPAN_DAYS} calendar days` };
  }
  // Bare-date floor with one calendar day of slack: a preset computed before UTC midnight, or client clock
  // skew, must not 400 (public/lab.js validateReplayRange mirrors it).
  const minStart = new Date(nowMs);
  minStart.setUTCFullYear(minStart.getUTCFullYear() - REPLAY_MAX_YEARS);
  minStart.setUTCDate(minStart.getUTCDate() - 1);
  const earliest = isoDay(minStart);
  if (start < earliest) {
    return { error: `replay start older than ${REPLAY_MAX_YEARS}y - earliest ${earliest}` };
  }
  return { start, end };
}
