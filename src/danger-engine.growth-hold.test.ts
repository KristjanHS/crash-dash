import { describe, it, expect } from "vitest";
import type { State } from "./domain-types.js";
import { GLOBAL_FAMILIES, LADDER } from "./families.js";
import {
  memberWeight,
  computeCells,
  computeField,
  type LegRow,
  type FieldResult,
  type MemberStateMap,
  type MemberHistoryEntry,
} from "./danger-engine.js";
import {
  buildMemberState,
  buildMemberStateAt,
  buildMemberStateHeld,
  buildMemberStateHeldAt,
} from "./danger-member-state.js";
import { FAMILY_MEMBERS, LEG_FIELD, SIGNAL_HOLD_CLOSES, signalHoldClosesFor } from "./danger-ladder.js";
import { gf } from "./danger-engine.test-helpers.js";

describe("G2 Stage G2.1 - the growth maps are BEHAVIOURALLY INERT on the pick", () => {
  // G2.1 makes `rsBySleeve`/`momBySleeve` live on BOTH production pick paths (the cron, via
  // `run-cycle.ts` → `assembleRun` → `computeField`, and `api/lab.ts`'s pick-bearing fields). The
  // WHOLE safety claim of the stage is that lighting the growth pillar changes NO pick: `held`,
  // every leg's `danger`/`subDangers`/`regime`/`concentrated` must be identical
  // with the maps present and absent — only `legRows[].growth` may move.
  const band = { lo: 1, hi: 9 }; // whole ladder in band, so `held` has the widest choice to change
  // Real-shaped inputs: a live danger source (so `held` is a genuine argmin over unequal dangers,
  // not a degenerate all-zero tie) plus a lit trend family (so the growth pillar has its `uT` term
  // as well as the two map terms).
  const uTIds = [...GLOBAL_FAMILIES.find((f) => f.key === "trend")!.ids];
  const d = gf([
    { id: "R4", state: "RED" as State },
    { id: "F1", state: "AMBER" as State },
    ...uTIds.map((id) => ({ id, state: "AMBER" as State })),
  ]);
  // Cross-sectional RS / vol-adjusted momentum in the shape `computeLegRs`/`computeVolAdjMom`
  // return: one entry per LADDER sleeve, spread across negative/zero/positive, DERIVED from LADDER
  // (never hand-typed) so a ladder edit cannot silently starve the maps.
  const rs = new Map<string, number | null>(LADDER.map((s, i) => [s, (i - 4) / 4]));
  const mom = new Map<string, number | null>(LADDER.map((s, i) => [s, (4 - i) / 8]));

  const withMaps = computeField(d, band, undefined, null, undefined, rs, mom);
  const without = computeField(d, band);

  it("held/danger/regime are byte-identical with and without the rs/mom maps", () => {
    const project = (r: LegRow) => ({
      sleeve: r.sleeve,
      risk: r.risk,
      danger: r.danger,
      subDangers: r.subDangers,
      regime: r.regime,
      concentrated: r.concentrated,
    });
    expect(withMaps.legRows.map(project)).toEqual(without.legRows.map(project));
    expect(withMaps.held?.sleeve).toBe(without.held?.sleeve);
    // Non-degeneracy of the fixture: a pick actually exists and the dangers are NOT all equal, so
    // "same held" is a real agreement rather than an argmin over a flat field that could not differ.
    expect(withMaps.held).not.toBeNull();
    expect(new Set(withMaps.legRows.map((r) => r.danger)).size).toBeGreaterThan(1);
  });

  it("the maps DO reach the growth pillar - every leg's growth value moves (non-vacuity)", () => {
    // Without this the equality above would be satisfiable by the maps never arriving at all, which
    // is precisely the pre-G2.1 state the stage exists to leave.
    const growthOf = (f: FieldResult) => new Map(f.legRows.map((r) => [r.sleeve, r.growth!.value]));
    const lit = growthOf(withMaps);
    const dark = growthOf(without);
    for (const [sleeve, v] of lit) expect(v).not.toBe(dark.get(sleeve));
    // …and the pillar reports itself live on both sides only because `uT` is lit here; the maps are
    // what make the value a three-term fold rather than the trend term alone.
    for (const r of withMaps.legRows) expect(r.growth!.live).toBe(true);
  });

  it("a starved map (all-null, the degraded-store posture) reproduces the maps-absent row exactly", () => {
    // `run-cycle-exposure.ts`'s starve-first catch yields `undefined` maps; `computeLegRs` on a thin store
    // yields all-null ones. Both must land on the pre-G2.1 growth value, or a cold start would
    // paint a different pillar than a degraded one.
    const nullRs = new Map<string, number | null>(LADDER.map((s) => [s, null]));
    const nullMom = new Map<string, number | null>(LADDER.map((s) => [s, null]));
    const starved = computeField(d, band, undefined, null, undefined, nullRs, nullMom);
    expect(starved.legRows.map((r) => r.growth)).toEqual(without.legRows.map((r) => r.growth));
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Stage 2.1 — the per-member SIGNAL HOLD
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("signal hold - held member-state builders", () => {
  /** A member history, oldest→newest, from a list of confirmed states. */
  const hist = (states: State[]): MemberHistoryEntry["history"] =>
    states.map((s, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      value: 0,
      delta20: 0,
      rawState: s,
      state: s,
    }));

  // The three classes are read off `TIMING_CLASS` through `signalHoldClosesFor`, never hand-typed — a
  // re-tune of `SIGNAL_HOLD_CLOSES` or a re-classification must move these fixtures, not silently pass.
  const LAG_ID = "F9"; // hold 0
  const COIN_ID = "F1"; // hold 3
  const LEAD_ID = "F6"; // hold 10

  it("is IDENTITY at hold 0 - a lag-class member's held map equals the unheld map, key for key", () => {
    // `SIGNAL_HOLD_CLOSES.lag` is 0, and `0`/`1` denote the same window (the member's own close alone), so
    // the held builder must reduce EXACTLY to `buildMemberStateAt` for every lag member and every
    // depth. This is the pre-Stage-2.1 behaviour the hold falls back to.
    expect(signalHoldClosesFor(LAG_ID)).toBe(SIGNAL_HOLD_CLOSES.lag);
    const h = [{ id: LAG_ID, history: hist(["GREEN", "RED", "AMBER", "GREEN"]) }];
    for (const depth of [0, 1, 2, 3, 4]) {
      // ← RED DEMO: `Math.max(signalHoldClosesFor(id), 1)` → `Math.max(signalHoldClosesFor(id), 2)` in
      // `signalHoldWindowOf` and depth 0 reads `lit` where the unheld map reads `calm`.
      expect(buildMemberStateHeldAt(h, depth)).toEqual(buildMemberStateAt(h, depth));
    }
  });

  it("MONOTONICITY: a longer hold lights weakly MORE closes, never fewer - over all three windows", () => {
    // One shared series, three members differing ONLY in timing class. The invariant is per-depth
    // implication (strictly stronger than "more lit closes in total"): if the shorter window reads a
    // member lit at depth j, the longer window must too.
    const states: State[] = [
      "GREEN", "GREEN", "RED", "GREEN", "GREEN", "GREEN", "AMBER", "GREEN", "GREEN", "GREEN",
      "GREEN", "GREEN", "GREEN", "GREEN", "RED", "GREEN", "GREEN", "GREEN", "GREEN", "GREEN",
    ];
    const ids = [LAG_ID, COIN_ID, LEAD_ID];
    const h = ids.map((id) => ({ id, history: hist(states) }));
    // Ordered shortest→longest window, DERIVED from the table.
    const byHold = [...ids].sort((a, b) => signalHoldClosesFor(a) - signalHoldClosesFor(b));
    const litAt = (id: string, depth: number) => buildMemberStateHeldAt(h, depth)[id]?.sev === "lit";
    let anyStrict = false;
    for (let depth = 0; depth < states.length; depth++) {
      for (let i = 0; i + 1 < byHold.length; i++) {
        const shortId = byHold[i]!;
        const longId = byHold[i + 1]!;
        const s = litAt(shortId, depth);
        const l = litAt(longId, depth);
        // ← RED DEMO: flip `SEV_NUM[sev] > SEV_NUM[best]` to `<` in `heldFoldMap` (a MIN
        // fold) and the longer window goes DARK where the shorter one is lit.
        expect(s && !l, `depth ${depth}: ${shortId} lit but ${longId} dark`).toBe(false);
        if (!s && l) anyStrict = true;
      }
    }
    // NON-VACUITY: the fixture must actually reach the regime where the windows DIFFER, or the
    // implication above holds trivially (e.g. an all-GREEN series lights nothing at any hold).
    expect(anyStrict).toBe(true);
  });

  it("SPANS an absent close - lit at t−2 with a hold of 3 reads lit at t, `obs: stale`, no `lag`", () => {
    // The ruled exception to the OQ-5 Stage 5.2 "absent is not a value" invariant, scoped to the held
    // map. The hole models the `!pt` branch — the depth at which the member did not report.
    const h0 = hist(["GREEN", "RED", "GREEN"]);
    const withHole = [...h0];
    delete withHole[withHole.length - 1]; // absent at t
    const h = [{ id: COIN_ID, history: withHole }];
    expect(signalHoldClosesFor(COIN_ID)).toBe(SIGNAL_HOLD_CLOSES.coin);
    expect(buildMemberStateAt(h, 0)[COIN_ID]).toBeUndefined(); // unheld: ABSENT, as before
    // ← RED DEMO: change the `if (!pt) continue;` inside `heldFoldMap` to `break` and the
    // hold stops at the gap instead of spanning it — this reads `undefined`.
    expect(buildMemberStateHeldAt(h, 0)[COIN_ID]).toEqual({ sev: "lit", obs: "lag" });
    // …and the key carries NO `lag`: the lag axis is a live feed measurement, and a held-over close
    // has none. `toEqual` above already excludes it; pinned explicitly because a `...spread` of the
    // live entry is the natural way to write this builder and would smuggle one in.
    expect("lag" in buildMemberStateHeldAt(h, 0)[COIN_ID]!).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Arm C: the window SPANS
  // ABSENCE but STOPS AT CONTRADICTION. Every pin below is at `COIN_ID`, whose window is long
  // enough that the release — not the length — is what ends the walk; none restates a window number.
  // ───────────────────────────────────────────────────────────────────────────────────────────

  it("RELEASES on an observed recovery - a GREEN print ends the hold on the NEXT close", () => {
    // fire at t−2, the member itself prints GREEN at t−1, anchor t. On t−1 the fire is still held
    // (the recovery is the anchor there, and an anchor never releases); one close later the GREEN
    // sits OLDER than the anchor and truncates the walk before the fire.
    const h = [{ id: COIN_ID, history: hist(["RED", "GREEN", "GREEN"]) }];
    expect(signalHoldClosesFor(COIN_ID)).toBeGreaterThan(2); // the fire is INSIDE the window at both depths
    expect(buildMemberStateHeldAt(h, 1)[COIN_ID]).toEqual({ sev: "lit", obs: "lag" });
    // ← RED DEMO: delete `if (sev === "calm" && k > N) break;` from `heldFoldMap` (the CUR
    // fold) and this reads `lit` — the ratchet the plan measured at 78% contradicted raises.
    expect(buildMemberStateHeldAt(h, 0)[COIN_ID]).toEqual({ sev: "calm", obs: "lag" });
  });

  it("does NOT release on a close the member did not report - spanning survives arm C", () => {
    // The DISCRIMINATING TWIN of the test above: same fire, same depth, the t−1 close ABSENT instead
    // of GREEN. Silence is not a contradiction, so the fire still reads through the gap.
    const withHole = hist(["RED", "GREEN", "GREEN"]);
    delete withHole[1]; // t−1 unreported
    const h = [{ id: COIN_ID, history: withHole }];
    // ← RED DEMO: widen the release to absent closes (`if (!pt) break`) and this reads `calm`.
    expect(buildMemberStateHeldAt(h, 0)[COIN_ID]).toEqual({ sev: "lit", obs: "lag" });
  });

  it("a PARTIAL cooldown (lit→elev) neither releases the hold nor inflates the severity", () => {
    // ARM 1 — the member is still saying something at t−1, so the walk continues past it and the MAX
    // keeps the older, higher severity.
    const cooling = [{ id: COIN_ID, history: hist(["RED", "AMBER", "GREEN"]) }];
    // ← RED DEMO: broaden the release to any cooling print (`sev !== "lit"` instead of
    // `sev === "calm"`) and this reads `calm`.
    expect(buildMemberStateHeldAt(cooling, 0)[COIN_ID]).toEqual({ sev: "lit", obs: "lag" });
    // ARM 2 — …and NOT inflated: with no fire behind it, the same `elev` print folds to `elev`, not
    // `lit`. Without this arm the assertion above would pass under a fold that lifts every held
    // non-calm reading to `lit`.
    const elevOnly = [{ id: COIN_ID, history: hist(["GREEN", "AMBER", "GREEN"]) }];
    expect(buildMemberStateHeldAt(elevOnly, 0)[COIN_ID]).toEqual({ sev: "elev", obs: "lag" });
  });

  it("the ANCHOR's own calm close never releases - and a calm-only window still folds to calm", () => {
    // The requested close is the one being reported ON, not evidence against its own window: a member
    // that fired yesterday and is green today is exactly the leader-clock case the hold exists for.
    const fired = [{ id: COIN_ID, history: hist(["RED", "GREEN"]) }];
    // ← RED DEMO: relax the release guard from `k > N` to `k >= N` and this reads `calm`.
    expect(buildMemberStateHeldAt(fired, 0)[COIN_ID]).toEqual({ sev: "lit", obs: "lag" });
    // The plan's own paragraph: calm today, calm-only behind it ⇒ `calm`, byte-identical to the
    // unheld map. Nothing is held either way, so the release cannot be observed here.
    const quiet = [{ id: COIN_ID, history: hist(["GREEN", "GREEN", "GREEN"]) }];
    expect(buildMemberStateHeldAt(quiet, 0)).toEqual(buildMemberStateAt(quiet, 0));
    expect(buildMemberStateHeldAt(quiet, 0)[COIN_ID]!.sev).toBe("calm");
  });

  it("RAISES the live map, never lowers it - and resurrects a member the live panel lacks", () => {
    const d = gf([{ id: COIN_ID, state: "GREEN" }, { id: LEAD_ID, state: "RED" }]);
    const ciss = [
      // Fired at t−1 and inside its window ⇒ still lit. RE-SHAPED for arm C: the fire used to sit at
      // t−2 behind a GREEN print at t−1, which the release now truncates the walk at.
      { id: COIN_ID, history: hist(["GREEN", "RED", "GREEN"]) },
      { id: LEAD_ID, history: hist(["GREEN", "GREEN", "GREEN"]) }, // calm history, live RED
      { id: LAG_ID, history: hist(["RED"]) }, // absent from the live panel entirely
    ];
    const held = buildMemberStateHeld(d, ciss);
    // RAISED: the live GREEN member inherits its own recent fire…
    expect(held[COIN_ID]!.sev).toBe("lit");
    // ← RED DEMO: drop the `SEV_NUM[h.sev] > SEV_NUM[cur.sev]` guard in `buildMemberStateHeld` (assign
    // unconditionally) and this member's live RED is overwritten by its calm history ⇒ "calm".
    expect(held[LEAD_ID]!.sev).toBe("lit"); // …and the live RED is NOT dulled by a calm window
    // RESURRECTED: a key the unheld/live map lacks, carrying `stale` and no `lag`.
    expect(buildMemberState(d)[LAG_ID]).toBeUndefined();
    // B2: the resurrected entry also carries `held: true` — its severity comes wholly from an
    // earlier close, which is the same story the raise branch tells.
    // …and the Stage-2 AGE rides WITH the flag: this member's only stored close IS the newest one, so
    // the age is 0 — a real served answer (the newest STORED close can predate the live panel), which
    // is why `heldAge` absent must mean UNKNOWN and never 0.
    expect(held[LAG_ID]).toEqual({ sev: "lit", obs: "lag", held: true, heldAge: 0 });
    // The RAISED member's age is the walk's own depth, not the window and not a constant.
    expect(held[COIN_ID]!.heldAge).toBe(1);
  });

  // The ledger cell paints the
  // HELD map while the family chip strip paints the LIVE panel, so a cell can read `elev`/`lit` with
  // every one of its chips green. `SignalCell.held` is what says so, and it is SCOPED TO THE ARGMAX
  // MEMBER: this pins BOTH arms, since a mark that fires on any held member would be indistinguishable
  // from one that explains this cell's number.
  it("names the hold in SignalCell.held when the cell's argmax rests on it, and NOT otherwise", () => {
    const leg = LEG_FIELD.find((l) => memberWeight(COIN_ID, l.sleeve) > 0)!;
    const crCell = (st: MemberStateMap) => computeCells(leg, st).find((c) => c.family === "cr")!;
    // ONE cr member reports, so it is trivially the argmax and the two arms differ in PROVENANCE only.
    // The fire is at t−1 (RE-SHAPED for arm C — a GREEN print between the fire and t would release
    // the hold and leave nothing for the mark to explain).
    const fired = [{ id: COIN_ID, history: hist(["GREEN", "RED", "GREEN"]) }];

    // ARM 1 — live GREEN, held lit: the cell's severity comes from a close the chips no longer show.
    const heldArm = crCell(buildMemberStateHeld(gf([{ id: COIN_ID, state: "GREEN" }]), fired));
    expect(heldArm.cellState).toBe("lit"); // the hold is what put it here…
    // …and the mark names the member and its OWN window, read through `signalHoldClosesFor` — never a
    // restated `SIGNAL_HOLD_CLOSES` literal, so a re-tune or a re-classification moves this expectation.
    // `ageCloses`: the fire sits
    // at t−1 in THIS fixture, so the age is 1 — a fixture property, not a window value.
    expect(heldArm.held).toEqual({
      member: COIN_ID,
      closes: Math.max(signalHoldClosesFor(COIN_ID), 1),
      ageCloses: 1,
    });
    // NON-VACUITY of the pin above: the age and the window must DIFFER here, or an implementation that
    // reported the window length as the age (the pre-Stage-2 conflation this stage exists to end) would
    // satisfy it. The window is the CAP; the age is what was actually shown.
    expect(heldArm.held!.ageCloses).toBeLessThan(heldArm.held!.closes);

    // ARM 1b — THE DISCRIMINATING AGE ARM: same member, same window, the fire one close OLDER (an
    // `AMBER` print between it and t, which is a partial cooldown and does NOT release). A constant
    // `ageCloses` — 1, or the window, or 0 — passes ARM 1 and reds here.
    // ← RED DEMO: pin `bestAge = 0` in `heldFoldMap` (a constant age) — reds here AND in ARM 1. ⚠ NOT
    // `bestAge = k`: every assertion here reads the fold at N = 0, where `k - N === k` and that
    // mutation is INERT — a red demo must be able to fail on the fixture the test actually uses.
    const older = [{ id: COIN_ID, history: hist(["RED", "AMBER", "GREEN"]) }];
    const olderArm = crCell(buildMemberStateHeld(gf([{ id: COIN_ID, state: "GREEN" }]), older));
    expect(olderArm.cellState).toBe("lit"); // the MAX still keeps the older, higher severity…
    expect(olderArm.held!.ageCloses).toBe(2); // …and the age says WHICH close it came from
    expect(olderArm.held!.closes).toBe(heldArm.held!.closes); // same window — only the age moved

    // ARM 2 — THE DISCRIMINATING CASE: same cell, same severity, but the member is lit TODAY, so the
    // hold raised nothing and there is nothing to explain. A mark keyed off "the map is a held map",
    // or off any member carrying the flag, would fire here too.
    const liveArm = crCell(buildMemberStateHeld(gf([{ id: COIN_ID, state: "RED" }]), fired));
    expect(liveArm.cellState).toBe("lit");
    expect(liveArm.wsev).toBe(heldArm.wsev); // the two arms are severity-identical…
    expect(liveArm.held).toBe(null); // …and provenance-distinct. THIS is the assertion that reds.

    // ARM 3 — an UNHELD map (the cold-store degrade, `buildMemberState`) stamps nothing anywhere, so
    // every cell reads the honest "nothing is known to be held" rather than a fabricated mark.
    expect(crCell(buildMemberState(gf([{ id: COIN_ID, state: "RED" }]))).held).toBe(null);
  });

  // ARM 4 — the CALM RESURRECT, the case ARMs 1–3 all miss because each lights `COIN_ID`. Found in
  // review 2026-08-07: the resurrect branch stamped `held: true` for ANY severity, and in an all-calm
  // cell every weighted value is 0, so the max — which advances on strict `>` — keeps the FIRST
  // member in `FAMILY_MEMBERS` order, i.e. exactly that resurrected entry. Every one of the 9 legs
  // then painted the `sig-held` overline at `wsev 0`, under a legend asserting the severity came from
  // the window. A GREEN close cannot carry a severity, so nothing was held.
  it("does NOT mark a CALM resurrect as held - an ordinary feed gap is not a hold", () => {
    const leg = LEG_FIELD.find((l) => memberWeight(COIN_ID, l.sleeve) > 0)!;
    // Live panel = every cr member EXCEPT the coin, all GREEN (derived from the roster, never typed):
    // the coin is the one the window resurrects, and its resurrection is calm.
    const others = FAMILY_MEMBERS.cr.filter((m) => m !== COIN_ID);
    const d = gf(others.map((id) => ({ id, state: "GREEN" as State })));
    const calmHistory = [{ id: COIN_ID, history: hist(["GREEN", "GREEN", "GREEN"]) }];
    const st = buildMemberStateHeld(d, calmHistory);
    // NON-VACUITY: the resurrect branch really is the one taken — the live map lacks the key and the
    // held map has it, `obs: "lag"` (a held-over close carries no live lag measurement).
    expect(buildMemberState(d)[COIN_ID]).toBeUndefined();
    // ← RED DEMO: drop the `SEV_NUM[h.sev] > 0` test in `buildMemberStateHeld`'s RESURRECT branch
    // (stamp `held: true` unconditionally) and this reads `{…, held: true}`.
    expect(st[COIN_ID]).toEqual({ sev: "calm", obs: "lag" });
    // …and the OUTPUT-VISIBLE half: the cell that entry wins the argmax of paints no mark.
    const cell = computeCells(leg, st).find((c) => c.family === "cr")!;
    expect(cell.cellState).toBe("calm");
    expect(cell.wsev).toBe(0); // an all-calm max — which is why the resurrected entry IS the argmax
    expect(cell.held).toBe(null);
  });

  it("computeField DEGRADES to unheld - and SAYS so - with no cissHistory or an all-empty one", () => {
    const d = gf([{ id: COIN_ID, state: "RED" }]);
    const band = { lo: 1, hi: 9 };
    const seen: string[] = [];
    const onDegrade = (scope: string, reason: string) => seen.push(`${scope}|${reason}`);
    const none = computeField(
      d,
      band,
      undefined,
      null,
      undefined,
      undefined,
      undefined,
      { onDegrade },
    );
    // ⚠ THE DISCRIMINATING ARM. `fetchCissHistory` ALWAYS returns an array, so `[]` (and, in prod, an
    // array of zero-length histories) is the shape a bare `cissHistory === undefined` test would miss
    // — that emitter could never fire on the live path.
    const empty = computeField(
      d,
      band,
      undefined,
      null,
      [{ id: COIN_ID, history: [] }],
      undefined,
      undefined,
      { onDegrade },
    );
    // ← RED DEMO: narrow the gate to `cissHistory === undefined` in `computeField` and this reads 1.
    expect(seen.length).toBe(2);
    expect(seen.every((s) => s.startsWith("danger:timing-hold|"))).toBe(true);
    // …and the degraded path is a NO-OP: an empty window scores exactly like no window at all.
    expect(empty.legRows.map((r) => r.danger)).toEqual(none.legRows.map((r) => r.danger));
    // The callback is OPTIONAL — every non-cron caller omits it and must not throw.
    expect(() => computeField(d, band)).not.toThrow();
  });
});
