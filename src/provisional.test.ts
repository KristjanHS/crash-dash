import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { DASHBOARD_FAMILIES, confirmClosesFor } from "./families.js";
import { FAST_CONFIRMERS } from "./confirmers.js";
import { scoreWithCuts } from "./confirmers.js";
import { ALL_INDICATORS } from "./registry.js";
import { type Observation, type Reading, type State } from "./domain-types.js";
import { REASSERT_AFTER_DAYS } from "./ladder.js";
import { assembleRun } from "./run-core.js";
import { makeAlert } from "./test-helpers.js";
import { PROVISIONAL_IDS, buildProvisionalMessage, decideProvisional } from "./provisional.js";
import type { CalibrationParam } from "./store.js";

const NOW = "2026-06-27T22:00:00.000Z";

/** A hand-built Reading double — raw/confirmed states are the ONLY axis under test here. */
const rd = (id: string, rawState: State, state: State, rawLeg?: string): Reading => ({
  indicator: { id, label: id, longLabel: id, series: id, channel: "FIN", thresholds: {} },
  date: "2026-06-26",
  level: 1.23,
  delta20: 0.1,
  rawState,
  state,
  decision: null,
  rawLeg,
});

// --- BEHAVIORALLY INERT under the directional fold (batch-2 row 7, 2026-08-26) ----------------
//
// `PROVISIONAL_IDS` is derived as (credit family ∪ FAST_CONFIRMERS) filtered to
// `confirmClosesFor(id) >= 2`. Every tier is 2 since the directional fold, so the filter admits
// the WHOLE roster — yet the path cannot fire off the LIVE fold: instant-up confirms a raw RED
// same-day, so the candidate condition `rawState === "RED" && state !== "RED"` is unreachable.
// These tests pin BOTH halves: the non-empty derivation, and the live-path inertness (proven
// over the real cut layer at the bottom of this file).
describe("PROVISIONAL_IDS - full roster admitted under the directional fold", () => {
  test("every source id passes the >= 2 filter and is admitted; nothing else sneaks in", () => {
    const creditIds = DASHBOARD_FAMILIES.find((f) => f.key === "credit")!.ids;
    // Non-vacuity: the sources are non-empty, so a set this size can only come from them.
    expect(creditIds.length).toBeGreaterThan(0);
    expect(FAST_CONFIRMERS.length).toBeGreaterThan(0);
    const sources = new Set([...creditIds, ...FAST_CONFIRMERS.map((c) => c.id)]);
    for (const id of sources) {
      expect(confirmClosesFor(id), `tier of ${id}`).toBeGreaterThanOrEqual(2);
      expect(PROVISIONAL_IDS.has(id), `admitted ${id}`).toBe(true);
    }
    expect(PROVISIONAL_IDS.size).toBe(sources.size);
  });
});

describe("decideProvisional - the contract, driven on injected divergent doubles", () => {
  // A divergent raw-RED double is PRODUCTION-UNREACHABLE (instant-up makes raw RED ⇒ state RED
  // on the live fold), but the gate's own contract still binds if one is injected.
  test("an admitted id with rawState RED / state AMBER fires (cooldown open)", () => {
    const d = decideProvisional([rd("F1", "RED", "AMBER", "vel-z")], null, NOW);
    expect(d.push).toBe(true);
    expect(d.candidate?.indicator.id).toBe("F1");
    expect(d.message?.title).toBe("crash-dash - PROVISIONAL - unconfirmed RED F1");
  });

  test("a fresh cooldown stamp silences it; an expired one does not", () => {
    const fresh = decideProvisional([rd("F1", "RED", "AMBER")], "2026-06-27T10:00:00.000Z", NOW);
    expect(fresh.push).toBe(false);
    const stale = new Date(Date.parse(NOW) - (REASSERT_AFTER_DAYS + 1) * 86_400_000).toISOString();
    expect(decideProvisional([rd("F1", "RED", "AMBER")], stale, NOW).push).toBe(true);
  });

  test("silent on a raw AMBER, on the LIVE raw===confirmed shape, and for a non-admitted id", () => {
    expect(decideProvisional([rd("F1", "AMBER", "GREEN")], null, NOW).push).toBe(false);
    expect(decideProvisional([rd("F1", "RED", "RED")], null, NOW).push).toBe(false); // the live shape
    expect(decideProvisional([rd("R5", "RED", "GREEN")], null, NOW).push).toBe(false);
  });
});

describe("buildProvisionalMessage - pure formatter (reachable only via an injected double)", () => {
  test("title is ASCII, prefixed, and names the indicator", () => {
    const m = buildProvisionalMessage(rd("F1", "RED", "AMBER", "vel-z"), "2026-06-26");
    expect(m.title).toBe("crash-dash - PROVISIONAL - unconfirmed RED F1");
    // Title is an HTTP header (latin1) — no em dash, no arrow, no emoji.
    expect(m.title).toMatch(/^[\x20-\x7e]+$/);
  });

  test("the confirm depth is single-sourced off confirmClosesFor - no typed literal, no '0-close'", () => {
    // The claim under test is the SINGLE-SOURCING, not the rendered sentence: a re-typed
    // literal ("awaiting 2-close confirm") would have survived the IS-5 tier change and
    // shipped a false claim, and the derived-but-unguarded form shipped the gibberish
    // "awaiting 0-close confirm". So: the body may name ONLY the depth the resolver reports,
    // and at depth 0 it may not claim a confirm wait at all.
    const n = confirmClosesFor("F1");
    const m = buildProvisionalMessage(rd("F1", "RED", "AMBER", "vel-z"), "2026-06-26");
    for (const k of [0, 1, 2, 3, 5].filter((d) => d !== n)) expect(m.body).not.toContain(`${k}-close`);
    expect(m.body.includes(n > 0 ? `awaiting ${n}-close confirm` : "-close")).toBe(n > 0);
  });

  test("tags/priority sit between WATCH and WARNING", () => {
    const m = buildProvisionalMessage(rd("F1", "RED", "AMBER", "vel-z"), "2026-06-26");
    expect(m.tags).toBe("warning");
    expect(m.priority).toBe(3);
  });
});

// --- Fold level: the run's wiring, driven both ways (silence on live shapes; stamp on a fire) --
describe("assembleRun - the provisional wiring", () => {
  test("LIVE-shape readings (raw === confirmed) are silent and a prior stamp is carried untouched", () => {
    const prior = "2026-06-25T22:00:00.000Z";
    const out = assembleRun({
      readings: [rd("F1", "RED", "RED", "vel-z"), rd("F2", "AMBER", "AMBER"), rd("R5", "GREEN", "GREEN")],
      globalReadings: [rd("AT1", "RED", "RED")],
      last: makeAlert({ level: "OK", provisionalPushedAt: prior }),
      lastPush: makeAlert({ level: "OK" }),
      now: NOW,
    });
    expect(out.provisional.push).toBe(false);
    expect(out.provisional.candidate).toBeNull();
    // No push ⇒ the cooldown column stays exactly as carried, never cleared.
    expect(out.alert.provisionalPushedAt).toBe(prior);
  });

  test("an injected divergent GLOBAL reading fires and stamps `now` (the union scan is live)", () => {
    const out = assembleRun({
      readings: [rd("R5", "GREEN", "GREEN")],
      globalReadings: [rd("AT1", "RED", "AMBER")],
      last: makeAlert({ level: "OK", provisionalPushedAt: null }),
      lastPush: makeAlert({ level: "OK" }),
      now: NOW,
    });
    expect(out.provisional.push).toBe(true);
    expect(out.provisional.candidate?.indicator.id).toBe("AT1");
    expect(out.alert.provisionalPushedAt).toBe(NOW);
  });
});

// --- Same-day escalation, proven over the REAL cut layer ---------------------------------------
//
// `sim:notify` is structurally blind here (it synthesizes CONFIRMED states directly, never calls
// `resolveCuts` — `.claude/rules/research-probes.md`), so the inertness claim — a live-fold raw
// RED IS confirmed, hence never a candidate — is proven at the `resolveCuts` seam: a real F1
// observation series scored through the shipped cut layer, breach magnitude DERIVED, never typed.
describe("instant-up over the real cut layer (F1, registry-derived breach magnitude)", () => {
  const CALIB = (
    JSON.parse(readFileSync(new URL("../scripts/backtest/calibration.json", import.meta.url), "utf8")) as {
      params: CalibrationParam[];
    }
  ).params;
  const F1 = ALL_INDICATORS.find((i) => i.id === "F1")!;
  const T = F1.thresholds;

  // FIXTURE MOVED: the breach used to be sized off the
  // MEASURED `credit/hyoas_evt_vel_red` calibration row, which reached RED on its own. F1 now folds
  // AMBER=OR / RED=AND over exactly two legs (`op` level + `vel-op` velocity), so a velocity-only
  // breach lands AMBER — and that row is inert for F1 besides (`CALIB_MAP.F1.evtVelocity: false`).
  // The subject here is the CONFIRMATION BUFFER (raw === confirmed), never "velocity alone reaches
  // RED", so the fixture moves onto a close that breaches BOTH Red legs and the buffer claim is
  // pinned again — now at BOTH tiers. Magnitudes are DERIVED from the registry pair, never typed.
  const overBothRed = Math.max(T.redLevel!, T.redVelocity!) * 1.01;
  const velocityOnly = Math.max(T.redVelocity!, T.amberVelocity!) * 1.01; // ≪ the level pair ⇒ vel leg alone

  /** 79 flat closes at 0, then one close at `jump` — so level_t == Δ30d_t == `jump`. */
  const series = (jump: number): Observation[] => {
    const out: Observation[] = [];
    for (let i = 0; i < 80; i++) {
      const d = new Date(Date.UTC(2026, 2, 1) + i * 86_400_000).toISOString().slice(0, 10);
      out.push({ date: d, value: i === 79 ? jump : 0 });
    }
    return out;
  };

  test("a fresh BOTH-LEG breach confirms the SAME DAY ⇒ raw === state, and no provisional", () => {
    // Non-vacuity: the registry pair exists and the fixture really clears both Red legs.
    expect(overBothRed).toBeGreaterThan(T.redLevel!);
    expect(overBothRed).toBeGreaterThan(T.redVelocity!);
    const r = scoreWithCuts(F1, series(overBothRed), CALIB);
    // A ONE-day breach on the newest close: under a SYMMETRIC 2-close fold this scored raw RED /
    // confirmed AMBER-or-lower — instant-up escalation confirms it same-day instead. The fixture
    // DISCRIMINATES the directional fold from a symmetric re-buffering.
    expect(r.rawState).toBe("RED");
    expect(r.state).toBe("RED");
    expect(confirmClosesFor("F1")).toBe(2); // the DOWN buffer — escalation never waits on it
    // raw === state ⇒ no candidate, even though F1 IS admitted and the cooldown is wide open:
    // THE behavioral-inertness pin, off the live fold rather than an injected double.
    expect(decideProvisional([r], null, NOW).push).toBe(false);
  });

  test("a velocity-only breach also confirms the SAME DAY - at AMBER, under the option-D fold", () => {
    // Same buffer claim, other tier: the AND at Red keeps this off RED (the arc's ruled behaviour),
    // and the OR at Amber lights it. raw === confirmed either way.
    expect(velocityOnly).toBeLessThan(T.amberLevel!); // the level leg is demonstrably dark here
    const r = scoreWithCuts(F1, series(velocityOnly), CALIB);
    expect(r.rawState).toBe("AMBER");
    expect(r.state).toBe("AMBER");
    expect(decideProvisional([r], null, NOW).push).toBe(false);
  });
});
