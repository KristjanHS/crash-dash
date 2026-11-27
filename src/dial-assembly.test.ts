import { describe, expect, test } from "vitest";
import { assembleDial, DIAL_FAMILIES } from "./dial-assembly.js";
import { InMemoryStore } from "./store-memory.js";
import { businessDayAgeOf } from "./lag-fixture.test-helpers.js";
import type { StoredReading } from "./store.js";
import {
  computeFamilyPanel,
  diffusionLabel,
  tradingDaysBetween,
  CARRY_MAX_TRADING_DAYS,
  GLOBAL_FAMILIES,
} from "./families.js";
import { techConfirmerBreadth, techConfirmerFromPanel } from "./t1dial.js";
import type { State } from "./domain-types.js";
import { isProvisional } from "./intraday.js";
import { SLOW_INDICATOR_IDS } from "./registry-price.js";
import { ALL_INDICATORS } from "./registry.js";
import { lagCutFor } from "./ladder.js";

/** id → its resolved `lagCutFor` — the SAME projection run-cycle/api-lab hand `assembleDial`. */
const LAG_CUT_BY_ID: ReadonlyMap<string, number> = new Map(ALL_INDICATORS.map((i) => [i.id, lagCutFor(i)]));
const daysBefore = (iso: string, n: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

// A representative combined reading set: every GLOBAL_FAMILIES member present (so nothing carries),
// with a firing credit leg + a firing volatility leg to push the dial off rung 1 — a non-trivial dial.
const FIXTURE: { id: string; state: State }[] = [
  ...new Set(GLOBAL_FAMILIES.flatMap((f) => f.ids)),
].map((id) => ({ id, state: (id === "F1" || id === "VT" ? "RED" : "GREEN") as State }));

/** FIXTURE as the DIAL sees it: the SLOW legs are declared `volatility` members but display-only,
 *  so assembleDial drops them before the panel fold (B-11, ruled 2026-07-20 — see the dedicated
 *  test below). The hand-composed reference panel has to reduce the same set or it pins the divergence. */
const DIAL_FIXTURE = FIXTURE.filter((r) => !SLOW_INDICATOR_IDS.has(r.id));

/** The registry NAMES `assembleDial` stamps onto every folded row before the panel reduction (the
 *  persisted panel is served verbatim by /lab, so a name-less row would paint a bare id). A
 *  hand-composed reference panel has to stamp the same names or it pins the divergence. */
const nameFixture = (rows: { id: string; state: State }[]) =>
  rows.map((r) => {
    const i = ALL_INDICATORS.find((x) => x.id === r.id);
    return i ? { ...r, label: i.label, longLabel: i.longLabel, ...(i.geoFactor ? { factor: i.geoFactor } : {}) } : r;
  });

describe("assembleDial - shared dial pipeline (audit rank 9)", () => {
  test("returns the uncarried DIAL panel, and a member-history window over exactly its members", async () => {
    const store = new InMemoryStore();
    const { globalPanel, cissHistory } = await assembleDial({
      readings: FIXTURE,
      asOf: "2026-07-16",
      store,
    });
    // The returned panel is the (uncarried, all-present) reduction, and the member-history window covers
    // exactly the panel's member ids.
    expect(globalPanel).toEqual(computeFamilyPanel(nameFixture(DIAL_FIXTURE), DIAL_FAMILIES).families);
    const panelMembers = [...new Set(globalPanel.flatMap((f) => f.members.map((m) => m.id)))].sort();
    expect(cissHistory.map((h) => h.id).sort()).toEqual(panelMembers);
  });

  test("B-11: a RED slow leg cannot flip `fired` - the lab reading set drives the SAME dial as cron", async () => {
    // The divergence this pins (B-11, ruled 2026-07-20): price-accel + the 3 complacency-* legs are
    // DECLARED `volatility` members but reach the two dial paths differently — cron builds its
    // readings from FAST sources only (the slow rows are persisted separately via recordRun), while
    // /api/lab reduces the WHOLE persisted run via getReadingsForRun and so sees them. Volatility is
    // a FIRE family ⇒ a RED slow leg fired volatility on the lab set and not the cron set, and
    // `fired` gates rungs 7-9.
    //
    // NOT circular: the two fixtures are built as the two REAL reading sets differ (lab = cron +
    // the persisted slow rows), not derived from US_FAMILIES' declaration. Contrast
    // `families.test.ts`'s allReadings, which derives its ids FROM the family table and so pins only
    // "the members are the ids I declared" — blind to whether anything feeds them.
    //
    // The fixture is chosen so the leg WOULD bite under the full table (mirrors replay.test.ts's
    // B-11 block): volatility's FAST members (R5/VT) are forced calm here, so a RED
    // `complacency-high` is the only thing that could fire the family — and volatility is a FIRE
    // family, which gates rungs 7-9. F1 stays RED so the dial itself is still non-trivial.
    // Mutating `DIAL_FAMILIES = GLOBAL_FAMILIES` therefore turns the DIAL-level assertion below
    // (`lab.dial` vs `cron.dial`) red, not merely the panel-membership ones — with the base
    // FIXTURE's `VT: "RED"` volatility fired on BOTH sets and that assertion was vacuous.
    const store = new InMemoryStore();
    const VOL_FAST_IDS = new Set(["R5", "VT"]);
    const cronSet = FIXTURE.filter((r) => !SLOW_INDICATOR_IDS.has(r.id)).map((r) =>
      VOL_FAST_IDS.has(r.id) ? { ...r, state: "GREEN" as State } : r,
    );
    const labSet = [
      ...cronSet,
      ...[...SLOW_INDICATOR_IDS].map((id) => ({
        id,
        state: (id === "complacency-high" ? "RED" : "GREEN") as State,
      })),
    ];

    // Guard the fixture itself: the sets must actually differ, and the RED leg must be present on
    // the lab side — otherwise this test passes vacuously whatever assembleDial does.
    expect(labSet.length).toBeGreaterThan(cronSet.length);
    expect(labSet.some((r) => r.id === "complacency-high" && r.state === "RED")).toBe(true);
    expect(cronSet.some((r) => r.id === "complacency-high")).toBe(false);
    // …and the leg must be the ONLY thing that could fire volatility: under the full
    // GLOBAL_FAMILIES table the lab set fires the family, under DIAL_FAMILIES it does not.
    // Without this the dial-parity assertion below survives the DIAL_FAMILIES=GLOBAL_FAMILIES
    // mutation (which is exactly how it was vacuous before 2026-07-20).
    const volUnderGlobal = computeFamilyPanel(labSet, GLOBAL_FAMILIES).families.find(
      (f) => f.key === "volatility",
    )!;
    const volUnderDial = computeFamilyPanel(labSet, DIAL_FAMILIES).families.find(
      (f) => f.key === "volatility",
    )!;
    expect(volUnderGlobal.firing).toBe(true);
    expect(volUnderDial.firing).toBe(false);

    const cron = await assembleDial({ readings: cronSet, asOf: "2026-07-16", store });
    const lab = await assembleDial({ readings: labSet, asOf: "2026-07-16", store });

    expect(lab.dial).toEqual(cron.dial);
    expect(lab.globalPanel).toEqual(cron.globalPanel);

    // The two halves of "display-only", and the ruling is the INVERSION between them.
    // (a) DIAL panel: the slow legs never appear as members ⇒ they cannot move `fired`/the band.
    const dialMemberIds = new Set(lab.globalPanel.flatMap((f) => f.members.map((m) => m.id)));
    for (const id of SLOW_INDICATOR_IDS) expect(dialMemberIds.has(id)).toBe(false);
    // (b) DISPLAY panel: they DO appear — this is the panel /api/lab serves as `globalFamilies`
    // and public/lab.js renders the board tiles, ledger chips and member help from. Goes RED if
    // `displayPanel` is wired back to DIAL_FAMILIES (the regression an earlier commit shipped: the legs
    // silently vanished from the Volatility tile).
    const displayMemberIds = new Set(lab.displayPanel.flatMap((f) => f.members.map((m) => m.id)));
    for (const id of SLOW_INDICATOR_IDS) expect(displayMemberIds.has(id)).toBe(true);
    // …and specifically as `volatility` members, the family that declares them.
    const displayVol = lab.displayPanel.find((f) => f.key === "volatility")!;
    expect(displayVol.members.map((m) => m.id)).toEqual(
      GLOBAL_FAMILIES.find((f) => f.key === "volatility")!.ids,
    );
    // The display panel is a strict superset of the dial panel by exactly the SLOW ids — the
    // split must not widen. (`labSet` feeds both, so any other difference is a real divergence.)
    const displayOnly = [...displayMemberIds].filter((id) => !dialMemberIds.has(id)).sort();
    expect(displayOnly).toEqual([...SLOW_INDICATOR_IDS].sort());
    // The RED slow leg is carried as a RED MEMBER on the display side and is simply not there on
    // the dial side — the divergence is directional, not just a membership-list difference.
    expect(displayVol.members.find((m) => m.id === "complacency-high")?.state).toBe("RED");
    const dialVol = lab.globalPanel.find((f) => f.key === "volatility")!;
    expect(dialVol.members.find((m) => m.id === "complacency-high")).toBeUndefined();
    // The cron reading set carries no slow rows at all, so its display panel legitimately shows
    // none — the legs are display-only, not display-invented.
    const cronDisplayIds = new Set(cron.displayPanel.flatMap((f) => f.members.map((m) => m.id)));
    for (const id of SLOW_INDICATOR_IDS) expect(cronDisplayIds.has(id)).toBe(false);

    // DIAL_FAMILIES strips the SLOW ids and NOTHING else — the exclusion must not quietly widen.
    // (Compared against GLOBAL_FAMILIES, the table the board/ledger side still uses.)
    expect(DIAL_FAMILIES.map((f) => f.key)).toEqual(GLOBAL_FAMILIES.map((f) => f.key));
    const globalIds = GLOBAL_FAMILIES.flatMap((f) => f.ids);
    const dialIds = DIAL_FAMILIES.flatMap((f) => f.ids);
    expect(globalIds.filter((id) => !SLOW_INDICATOR_IDS.has(id))).toEqual(dialIds);
    // Vacuity guard: GLOBAL_FAMILIES must actually declare the legs, or the line above is a tautology.
    expect(globalIds.filter((id) => SLOW_INDICATOR_IDS.has(id)).length).toBe(SLOW_INDICATOR_IDS.size);
  });

  test("rank-7 carry: onMissingTechMember + dropped/carried surfaced, not written by the fn", async () => {
    // A family whose feed dropped this run (member absent) but was firing recently is carried from
    // the store's last-known point; the missing tech member fires the callback. No feed history ⇒
    // nothing to carry, and the callback fires for absent F4/F5 (the trend confirmer members
    // after the D-C revert of the B5 swap; DB_SMH left the trend family entirely in D-D, and NVDA
    // was demoted out of the confirmer 2026-07-22).
    const store = new InMemoryStore();
    const missing: string[] = [];
    const noTrend = FIXTURE.filter((r) => r.id !== "F4" && r.id !== "F5");
    const { dropped, carried } = await assembleDial({
      readings: noTrend,
      asOf: "2026-07-16",
      store,
      onMissingTechMember: (id) => missing.push(id),
    });
    expect(missing.sort()).toEqual(["F4", "F5"]);
    // No persisted history for the dropped-trend family ⇒ nothing to carry, nothing aged-out.
    expect(carried).toEqual([]);
    expect(dropped).toEqual([]);
  });

  test("rank-7 carry: a months-dead AMBER member must NOT re-fire a family off a fresh sibling's date", async () => {
    // The credit family (F1/F2/F3/EBP) is FULLY dropped this run (all members absent from readings).
    // Persisted history is mixed-vintage: F1 died months ago at AMBER; F2 stayed live GREEN until
    // yesterday. The panel's last-live state was GREEN (worst-of covers PRESENT members only), so
    // the family must NOT carry. The bug: folding each member's latest point paired F1's stale AMBER
    // with F2's fresh max-date → lastKnown = {AMBER, yesterday}, and the CARRY_MAX_TRADING_DAYS gate
    // never bites on a fresh date ⇒ the family re-fires every run. The fix discards over-age member
    // points before the fold, so worst-of sees only F2's GREEN ⇒ no carry.
    const store = new InMemoryStore();
    const runAt = "2026-07-16T22:00:00.000Z";
    const stored: StoredReading[] = [
      { date: "2026-04-01", indicatorId: "F1", value: 1, delta20: 0, rawState: "AMBER", state: "AMBER", decision: null },
      { date: "2026-07-15", indicatorId: "F2", value: 1, delta20: 0, rawState: "GREEN", state: "GREEN", decision: null },
    ];
    await store.recordReadings(stored, runAt);
    // Drop every credit member from this run's readings so the family is non-live (carry candidate).
    const creditIds = new Set(["F1", "F2", "F3", "EBP"]);
    const noCredit = FIXTURE.filter((r) => !creditIds.has(r.id));
    const { carried, dropped } = await assembleDial({
      readings: noCredit,
      asOf: "2026-07-16",
      store,
    });
    expect(carried).toEqual([]); // GREEN last-live state ⇒ nothing to carry
    expect(dropped).toEqual([]); // and it never aged-out a firing state either
  });

  // G1's newest STORED row is D's EOD estimate (RED) over a GREEN print.
  const DAYTIME = "2026-07-16T15:00:00.000Z";
  const g1Store = async (estRunAt = "2026-07-16T22:00:00.001Z", id = "G1") => {
    const store = new InMemoryStore();
    const row = (date: string, state: State) => ({ date, indicatorId: id, value: 1, delta20: 0, rawState: state, state, decision: null });
    await store.recordReadings([row("2026-07-15", "GREEN")], "2026-07-15T22:00:00.000Z");
    await store.recordReadings([{ ...row("2026-07-16", "RED"), estimated: true }], estRunAt);
    return store;
  };

  // The admitted arms (`read(true)` on a settled estimate, `read(false, …)`) are also the pins that D's
  // `estimated` row IS read: it carries the dropped family, carries the absent member, folds into cissHistory.
  test("notifyToday: a daytime row stays out of the carry and the member-history window", async () => {
    expect([DAYTIME, "2026-07-16T22:00:00.001Z"].map((runAt) => isProvisional({ date: "2026-07-16", runAt }))).toEqual([true, false]);
    const GEO = new Set(DIAL_FAMILIES.find((f) => f.key === "geopolitics")!.ids);
    const read = async (notifyRead: boolean, estRunAt?: string, id = "G1") => {
      const store = await g1Store(estRunAt, id);
      const drop = id === "G1" ? GEO : new Set([id]);
      return {
        carried: (await assembleDial({ readings: FIXTURE.filter((r) => !drop.has(r.id)), asOf: "2026-07-16", store, notifyToday: notifyRead ? "2026-07-16" : undefined })).carried,
        member: (await assembleDial({ readings: FIXTURE.filter((r) => r.id !== id), asOf: "2026-07-16", store, notifyToday: notifyRead ? "2026-07-16" : undefined, carryLagCutById: LAG_CUT_BY_ID, carryAgeOf: businessDayAgeOf }))
          .carriedMembers.find((c) => c.id === id)?.state,
        ciss: (await assembleDial({ readings: FIXTURE, asOf: "2026-07-16", store, notifyToday: notifyRead ? "2026-07-16" : undefined })).cissHistory.find((h) => h.id === id)?.history.map((p) => p.state),
      };
    };
    expect(await read(true)).toEqual({ carried: ["geopolitics"], member: "RED", ciss: ["GREEN", "RED"] });
    expect(await read(true, DAYTIME)).toEqual({ carried: [], member: "GREEN", ciss: ["GREEN"] });
    expect(await read(false, DAYTIME)).toEqual({ carried: ["geopolitics"], member: "RED", ciss: ["GREEN", "RED"] });
  });

  test("notifyToday: a quote head re-stamped past a FINAL-less session carries the last FINAL, as the dial's gate reads it", async () => {
    const store = new InMemoryStore();
    const row = (date: string, state: State) => ({ date, indicatorId: "BUND", value: 1, delta20: 0, rawState: state, state, decision: null });
    await store.recordReadings([row("2026-07-14", "GREEN")], "2026-07-14T22:00:00.000Z");
    await store.recordReadings([{ ...row("2026-07-16", "RED"), estimated: true }], "2026-07-16T22:00:00.001Z");
    const RATES = new Set(DIAL_FAMILIES.find((f) => f.key === "rates")!.ids);
    const read = async (notifyRead: boolean) => {
      const member = (await assembleDial({ readings: FIXTURE.filter((r) => r.id !== "BUND"), asOf: "2026-07-16", store, notifyToday: notifyRead ? "2026-07-16" : undefined, carryLagCutById: LAG_CUT_BY_ID, carryAgeOf: () => 0 }))
        .carriedMembers.find((c) => c.id === "BUND");
      return {
        member: [member?.state, member?.date],
        carried: (await assembleDial({ readings: FIXTURE.filter((r) => !RATES.has(r.id)), asOf: "2026-07-16", store, notifyToday: notifyRead ? "2026-07-16" : undefined })).carried,
        ciss: (await assembleDial({ readings: FIXTURE, asOf: "2026-07-16", store, notifyToday: notifyRead ? "2026-07-16" : undefined })).cissHistory.find((h) => h.id === "BUND")?.history.map((p) => p.state),
      };
    };
    expect([await read(true), await read(false)]).toEqual([
      { member: ["GREEN", "2026-07-14"], carried: [], ciss: ["GREEN"] },
      { member: ["RED", "2026-07-16"], carried: ["rates"], ciss: ["GREEN", "RED"] },
    ]);
  });

  test("notifyToday: displayPanel keeps the rows the notify filter drops — family carry", async () => {
    const GEO = new Set(DIAL_FAMILIES.find((f) => f.key === "geopolitics")!.ids);
    const fam = await assembleDial({ readings: FIXTURE.filter((r) => !GEO.has(r.id)), asOf: "2026-07-16", store: await g1Store(DAYTIME), notifyToday: "2026-07-16" });
    const geo = (p: typeof fam.globalPanel) => p.find((f) => f.key === "geopolitics")?.state;
    expect([geo(fam.globalPanel), geo(fam.displayPanel)]).toEqual([null, "RED"]);
  });

  // R5/B1, END-TO-END through the shared seam: the panel every downstream consumer reads (cron
  // notify + /api/lab alike) carries the coverage claim, so the floor can never judge a different
  // population than the dial banded on. The unit pins live in families.test.ts; this pins the WIRING.
  test("coverage rides the assembled DIAL panel: a carried family degraded, a stale member degraded", async () => {
    const store = new InMemoryStore();
    const runAt = "2026-07-15T22:00:00.000Z";
    // Credit was firing RED at its last live observation, within the carry budget. The roster is
    // DERIVED from the dial's own table (never hand-typed) — a hand-typed subset leaves a sibling
    // member present, the family stays live, and the carry branch never runs.
    const creditIds = new Set(DIAL_FAMILIES.find((f) => f.key === "credit")!.ids);
    await store.recordReadings(
      [...creditIds].map((id) => ({
        date: "2026-07-15", indicatorId: id, value: 1, delta20: 0, rawState: "RED" as State, state: "RED" as State, decision: null,
      })),
      runAt,
    );
    const readings = FIXTURE.filter((r) => !creditIds.has(r.id)).map((r) =>
      // GT is a coincident trend member (the coverage roster for `trend`) — mark it stale at the
      // family's verdict so the SECOND arming path (present-but-dark) is exercised too.
      r.id === "GT" ? { ...r, lag: true } : { ...r, lag: false },
    );
    const { globalPanel, carried } = await assembleDial({ readings, asOf: "2026-07-16", store });
    expect(carried).toEqual(["credit"]); // precondition: the carry branch really ran
    expect(globalPanel.find((f) => f.key === "credit")!.coverageDegraded).toBe(true);
    expect(globalPanel.find((f) => f.key === "trend")!.coverageDegraded).toBe(true);
    // …and a family whose members all reported fresh claims nothing — non-vacuity for the two above.
    expect(globalPanel.find((f) => f.key === "rates")!.coverageDegraded).toBe(false);
  });

  // NAMES (2026-08-19): the panels this fn builds are PERSISTED (`alert_log.panel_state`) and served
  // VERBATIM by /api/lab — `computeFamilyPanel` defaults a label-less row to its own `id`, so an
  // unnamed producer paints raw registry ids (`F1`, `EBP`) on every /lab board chip. Both unnamed
  // producers are pinned here: the cron's `{id, state, lag, factor}` projection (FIXTURE's shape) and
  // the CARRIED absent-member rows, which have no reading row to inherit a name from at all.
  describe("registry names ride every folded row (the persisted panel is served verbatim)", () => {
    const LABEL_OF = new Map(ALL_INDICATORS.map((i) => [i.id, i.label] as const));

    test("(a) a name-less reading projection still yields labelled panel members", async () => {
      const store = new InMemoryStore();
      const { globalPanel, displayPanel } = await assembleDial({ readings: FIXTURE, asOf: "2026-07-16", store });
      const members = [...globalPanel, ...displayPanel].flatMap((f) => f.members);
      expect(members.length).toBeGreaterThan(0);
      // NON-VACUITY: at least one member's official label DIFFERS from its id (F1 → "HY OAS"), so a
      // regression back to the id default fails here rather than passing on id===label rows.
      expect(members.some((m) => m.label !== m.id)).toBe(true);
      const bare = members.filter((m) => m.label !== LABEL_OF.get(m.id));
      expect(bare.map((m) => m.id)).toEqual([]);
    });

    test("(b) a CARRIED absent member is labelled too - it has no reading row to inherit from", async () => {
      const ASOF = "2026-07-16";
      const absentId = DIAL_FAMILIES.find((f) => f.key === "credit")!.ids[0]!;
      const store = new InMemoryStore();
      await store.recordReadings(
        [{ date: daysBefore(ASOF, 1), indicatorId: absentId, value: 1, delta20: 0, rawState: "RED", state: "RED", decision: null }],
        `${daysBefore(ASOF, 1)}T22:00:00.000Z`,
      );
      const { globalPanel, carriedMembers } = await assembleDial({
        readings: FIXTURE.filter((r) => r.id !== absentId),
        asOf: ASOF,
        store,
        carryLagCutById: LAG_CUT_BY_ID, carryAgeOf: businessDayAgeOf,
      });
      expect(carriedMembers.map((c) => c.id)).toContain(absentId); // the row under test really carried
      const carried = globalPanel.flatMap((f) => f.members).find((m) => m.id === absentId)!;
      expect(carried.label).toBe(LABEL_OF.get(absentId));
      expect(carried.label).not.toBe(absentId);
    });

    // `named()` stamps `factor` (the registry `geoFactor`) as well, and `factor` is NOT purely
    // cosmetic: `diffusionLabel` counts DISTINCT FACTORS (R2), and that string reaches the PUSH BODY
    // via `diffusionLines` (notify_format.ts). The cron's PRESENT rows always carried `factor`
    // (run-cycle-dial.ts); the CARRIED rows did not, so a carried oil member used to count as its own
    // factor and the geopolitics line over-claimed breadth — `2 red … of 2` for what is ONE oil read
    // seen twice. That is exactly the over-claim R2 exists to prevent (families.ts `diffusionLabel`),
    // so the collapse is the CORRECTION; this pins it against a silent un-collapse.
    // (Nothing else consumes member `factor`: the geo floor reads `r.indicator.geoFactor` off the
    // READINGS, not the panel — alert-band.ts `autoGeoBase` — so no band or danger math moves here.)
    test("(c) a carried oil member collapses into the oil factor - the pushed diffusion line stops over-claiming", async () => {
      const ASOF = "2026-07-16";
      const GEO = DIAL_FAMILIES.find((f) => f.key === "geopolitics")!.ids;
      const [presentOil, , absentOil] = [GEO[0]!, GEO[1]!, GEO[2]!];
      // Every geo member shares `geoFactor: "oil"` — the premise the collapse rests on.
      expect(new Set(GEO.map((id) => ALL_INDICATORS.find((i) => i.id === id)!.geoFactor))).toEqual(new Set(["oil"]));
      const store = new InMemoryStore();
      await store.recordReadings(
        [{ date: daysBefore(ASOF, 1), indicatorId: absentOil, value: 1, delta20: 0, rawState: "RED", state: "RED", decision: null }],
        `${daysBefore(ASOF, 1)}T22:00:00.000Z`,
      );
      // One oil read present-and-RED, one dark-but-in-cut (carried RED): one factor, seen twice.
      const readings = FIXTURE.filter((r) => r.id !== absentOil).map((r) =>
        r.id === presentOil ? { ...r, state: "RED" as State } : r,
      );
      const { globalPanel, carriedMembers } = await assembleDial({
        readings, asOf: ASOF, store, carryLagCutById: LAG_CUT_BY_ID, carryAgeOf: businessDayAgeOf,
      });
      expect(carriedMembers.map((c) => c.id)).toContain(absentOil); // the row under test really carried
      const geo = globalPanel.find((f) => f.key === "geopolitics")!;
      expect(geo.members.find((m) => m.id === absentOil)!.factor).toBe("oil");
      expect(diffusionLabel(geo)).toBe("1 red / 1 elevated of 1");
      // NON-VACUITY: the SAME panel with the carried row left unnamed (the pre-fix shape) counts it as
      // its own factor and prints the over-claim — so the stamp, not the fixture, is what collapses it.
      // The pre-fix shape EXACTLY: present rows named (the cron always stamped `factor` on those),
      // the carried row appended bare — so the only difference from the assertion above is the stamp.
      const unnamed = computeFamilyPanel(
        [...nameFixture(readings), { id: absentOil, state: "RED" as State }],
        DIAL_FAMILIES,
      ).families.find((f) => f.key === "geopolitics")!;
      expect(diffusionLabel(unnamed)).toBe("2 red / 2 elevated of 2");
    });
  });

  // MEMBER-level absent-member carry: an
  // absent roster member whose last persisted close is within its OWN `lagCutFor` — counted by the
  // injected `carryAgeOf`, which since slice 3 is REQUIRED for any carry to happen — re-enters the fold
  // with that state; beyond the cut it stays absent. Distinct clock from the rank-7 FAMILY carry
  // (`CARRY_MAX_TRADING_DAYS`) by ruling. `asOf` fixed so the age gate never rides the wall clock.
  describe("absent-member carry (in-cut re-enters the fold, beyond-cut stays absent)", () => {
    const ASOF = "2026-07-16";
    const CREDIT = DIAL_FAMILIES.find((f) => f.key === "credit")!.ids;
    const absentId = CREDIT[0]!; // F1 in the base FIXTURE — its state is dropped, then carried
    // Present set: every FIXTURE member EXCEPT the absent credit one, and every OTHER credit member
    // forced GREEN — so the family fires ONLY if the carried RED re-enters. (FIXTURE has F1 RED.)
    const presentReadings = FIXTURE.filter((r) => r.id !== absentId).map((r) =>
      CREDIT.includes(r.id) ? { ...r, state: "GREEN" as State } : r,
    );
    const storeWithF1 = async (date: string) => {
      const store = new InMemoryStore();
      await store.recordReadings(
        [{ date, indicatorId: absentId, value: 1, delta20: 0, rawState: "RED", state: "RED", decision: null }],
        `${date}T22:00:00.000Z`,
      );
      return store;
    };

    test("(a) a carried RED re-enters the fold and keeps the family FIRING", async () => {
      const store = await storeWithF1(daysBefore(ASOF, 1)); // age 1 — inside any lag cut
      const { globalPanel, carriedMembers } = await assembleDial({
        readings: presentReadings,
        asOf: ASOF,
        store,
        carryLagCutById: LAG_CUT_BY_ID, carryAgeOf: businessDayAgeOf,
      });
      expect(carriedMembers).toContainEqual({ id: absentId, state: "RED", date: daysBefore(ASOF, 1), ageDays: 1 });
      const credit = globalPanel.find((f) => f.key === "credit")!;
      expect(credit.state).toBe("RED");
      expect(credit.firing).toBe(true);
      expect(credit.members.some((m) => m.id === absentId && m.state === "RED")).toBe(true);
      expect(credit.absentIds).not.toContain(absentId);
      // NON-VACUITY: the SAME store/readings with NO carry map leaves the family GREEN/not-firing and
      // the member dark — so the carry, not the fixture, is what fires it above.
      const noCarry = await assembleDial({ readings: presentReadings, asOf: ASOF, store });
      const creditNoCarry = noCarry.globalPanel.find((f) => f.key === "credit")!;
      expect(noCarry.carriedMembers).toEqual([]);
      expect(creditNoCarry.firing).toBe(false);
      expect(creditNoCarry.absentIds).toContain(absentId);
    });

    test("a carry read's store failure stays absent AND reaches `onReadFail` naming the id", async () => {
      const store = await storeWithF1(daysBefore(ASOF, 1));
      const failing = { getSeries: () => Promise.reject(new Error("db down")), getSeriesBulk: store.getSeriesBulk.bind(store) };
      const failed: string[] = [];
      const { carriedMembers } = await assembleDial({
        readings: presentReadings, asOf: ASOF, store: failing,
        carryLagCutById: LAG_CUT_BY_ID, carryAgeOf: businessDayAgeOf, onReadFail: (id) => failed.push(id),
      });
      expect(carriedMembers).toEqual([]);
      expect(failed).toContain(absentId);
    });

    test("a member-history bulk-read failure reaches `onCissReadError` naming the panel's member ids", async () => {
      const store = await storeWithF1(daysBefore(ASOF, 1));
      const failing = { getSeries: store.getSeries.bind(store), getSeriesBulk: () => Promise.reject(new Error("db down")) };
      const failed: string[][] = [];
      const { cissHistory } = await assembleDial({ readings: presentReadings, asOf: ASOF, store: failing, onCissReadError: (ids) => failed.push([...ids]) });
      expect(failed).toEqual([cissHistory.map((e) => e.id)]);
      expect(failed[0]).toContain(presentReadings[0]!.id);
    });

    test("(b) a member beyond its own lagCutFor stays absent/excluded - the stored row is not re-dated", async () => {
      const cut = LAG_CUT_BY_ID.get(absentId)!;
      const store = await storeWithF1(daysBefore(ASOF, cut + 5)); // aged strictly past its own cut
      const { globalPanel, carriedMembers } = await assembleDial({
        readings: presentReadings,
        asOf: ASOF,
        store,
        carryLagCutById: LAG_CUT_BY_ID, carryAgeOf: businessDayAgeOf,
      });
      expect(carriedMembers).toEqual([]); // vintage-bound out
      const credit = globalPanel.find((f) => f.key === "credit")!;
      expect(credit.absentIds).toContain(absentId);
      expect(credit.firing).toBe(false); // the RED never re-entered
    });

    test("(c) a SLOW display-only leg is NOT carried - the carry roster is DIAL_FAMILIES, not the full table", async () => {
      // A slow leg (stripped from DIAL_FAMILIES, display-only) is absent from THIS run yet persisted
      // in-cut every run; the carry must skip it, or it false-carries 4 phantom members each cron run.
      // Contrast the non-slow credit member on the SAME store/age/cut, which IS carried — so the dial
      // roster gate, not the fixture, is what excludes the slow one.
      const slowId = [...SLOW_INDICATOR_IDS][0]!;
      const date = daysBefore(ASOF, 1); // age 1 — inside any lag cut
      const store = new InMemoryStore();
      await store.recordReadings(
        [absentId, slowId].map((id) => ({
          date, indicatorId: id, value: 1, delta20: 0, rawState: "RED" as State, state: "RED" as State, decision: null,
        })),
        `${date}T22:00:00.000Z`,
      );
      const readings = presentReadings.filter((r) => r.id !== slowId); // both absent from the run
      const { carriedMembers } = await assembleDial({
        readings, asOf: ASOF, store, carryLagCutById: LAG_CUT_BY_ID, carryAgeOf: businessDayAgeOf,
      });
      const carriedIds = carriedMembers.map((c) => c.id);
      expect(carriedIds).toContain(absentId); // non-slow, carried — control proving the setup arms a carry
      expect(carriedIds).not.toContain(slowId); // slow display-only leg — excluded by the dial roster
    });

    // Stage C — a FULLY-DARK family whose ONLY present member is carried is no longer exempt from the
    // family carry: state = worse-of(carried fold, family last-known). The two clocks are distinct —
    // member B is beyond its OWN lagCutFor (publication days) while its RED is still within the family window
    // (CARRY_MAX_TRADING_DAYS, trading). Custom cut map so both ages derive from the cuts under test.
    const A = CREDIT[0]!; // carried in-cut GREEN
    const B = CREDIT[1]!; // beyond its own cut; last persisted RED
    const CUT_B = 1; // B's lag cut, in publication days — small enough that a 3-day-old close is beyond it
    const cutMap = new Map<string, number>([[A, 30], [B, CUT_B]]);
    const darkCredit = FIXTURE.filter((r) => !CREDIT.includes(r.id)); // credit fully dark this run
    const storeAB = async (bDate: string) => {
      const store = new InMemoryStore();
      await store.recordReadings(
        [
          { date: daysBefore(ASOF, 1), indicatorId: A, value: 1, delta20: 0, rawState: "GREEN" as State, state: "GREEN" as State, decision: null },
          { date: bDate, indicatorId: B, value: 1, delta20: 0, rawState: "RED" as State, state: "RED" as State, decision: null },
        ],
        `${ASOF}T22:00:00.000Z`,
      );
      return store;
    };

    test("(d) fully-dark family: carried GREEN + last-known RED (in family window) ⇒ stays firing + degraded", async () => {
      const bDate = daysBefore(ASOF, CUT_B + 2); // beyond B's own cut, still within the family window
      // B really is beyond its own cut — asserted in the unit the gate now uses (publication days
      // via `carryAgeOf`), not in calendar days: `CUT_B` is compared against `carryAgeOf`'s answer
      // inside `carryAbsentMembers`, so a calendar-day premise here could disagree with the gate.
      expect(businessDayAgeOf(B, bDate, ASOF)!).toBeGreaterThan(CUT_B);
      expect(tradingDaysBetween(bDate, ASOF)).toBeLessThanOrEqual(CARRY_MAX_TRADING_DAYS);
      const { globalPanel, carriedMembers } = await assembleDial({
        readings: darkCredit, asOf: ASOF, store: await storeAB(bDate), carryLagCutById: cutMap, carryAgeOf: businessDayAgeOf,
      });
      expect(carriedMembers.map((c) => c.id)).toEqual([A]); // only A re-entered; B stayed absent
      const credit = globalPanel.find((f) => f.key === "credit")!;
      expect(credit.state).toBe("RED"); // worse-of pulled up by the family last-known
      expect(credit.firing).toBe(true);
      expect(credit.coverageDegraded).toBe(true);
      expect(credit.absentIds).toContain(B);
      // NON-VACUITY: WITHOUT the worse-of pre-emption the carried GREEN fold alone reads GREEN.
      expect(computeFamilyPanel([{ id: A, state: "GREEN", carried: true }], DIAL_FAMILIES).families.find((f) => f.key === "credit")!.state).toBe("GREEN");
    });

    test("(e) inverse: the family last-known aged out ⇒ the carried GREEN fold stands alone", async () => {
      const bDate = daysBefore(ASOF, 20); // beyond B's cut AND beyond CARRY_MAX_TRADING_DAYS
      expect(tradingDaysBetween(bDate, ASOF)).toBeGreaterThan(CARRY_MAX_TRADING_DAYS);
      const { globalPanel } = await assembleDial({
        readings: darkCredit, asOf: ASOF, store: await storeAB(bDate), carryLagCutById: cutMap, carryAgeOf: businessDayAgeOf,
      });
      const credit = globalPanel.find((f) => f.key === "credit")!;
      expect(credit.state).toBe("GREEN"); // aged-out last-known ignored; only the carried GREEN remains
      expect(credit.firing).toBe(false);
      expect(credit.coverageDegraded).toBe(true); // still resting on carried/absent data
    });
  });

  // Stage 6.1, driven through the
  // PUBLIC witness `dial.techConfirmerP` (this block replaced a stopgap source pin over the call-site
  // text; its "the dial exposes no behavioural witness" justification was false).
  //
  // 6.1: `assembleDial` used to build `buildMemberStateHeldAt(cissHistory, 0)` (the raw held map),
  // while `computeField` builds `buildMemberStateHeld(d, cissHistory)` = merge(LIVE panel, raw-held);
  // 6.1 put the dial on the merged map so both read the SAME final map.
  describe("the dial's held map - merged with the LIVE panel (6.1)", () => {
    const withStates = (over: Partial<Record<string, State>>) =>
      FIXTURE.map((r) => (over[r.id] ? { ...r, state: over[r.id]! } : r));
    /** One persisted close per id, at the newest date ⇒ depth 0 of every hold window. Also what keeps
     *  `noHoldDepth` FALSE, so the held builder runs at all (a cold store takes the unheld branch by
     *  ruling 10 and the behaviour below is unreachable). */
    const storeWith = async (states: Record<string, State>) => {
      const store = new InMemoryStore();
      await store.recordReadings(
        Object.entries(states).map(([indicatorId, state]) => ({
          date: "2026-07-15", indicatorId, value: 1, delta20: 0, rawState: state, state, decision: null,
        })),
        "2026-07-15T22:00:00.000Z",
      );
      return store;
    };

    test("6.1 - a lead lit only in the LIVE panel admits its laggard, and the held RED raises the slot", async () => {
      // F5 live GREEN with a RED close in its member-history window; F6 live RED with a CALM (GREEN) window. The
      // merged map raises F5 to lit ⇒ the F5 slot reads RED, so with F4 also RED the 2-of-2 floor is met.
      //
      // F6's window is CALM rather than absent deliberately: it pins the merge's RAISE-ONLY direction
      // too — a held GREEN must not pull F6's live RED down.
      const store = await storeWith({ F5: "RED", F6: "GREEN" });
      const { dial } = await assembleDial({
        readings: withStates({ F4: "RED", F5: "GREEN", F6: "RED" }),
        asOf: "2026-07-16",
        store,
      });
      // Expectation derived OUT OF BAND: the same panel with F5 already live RED and no held map at
      // all. The hold's whole claim is that a held-over fire scores like a live one.
      const asIfLive = techConfirmerBreadth(
        techConfirmerFromPanel(
          computeFamilyPanel(withStates({ F4: "RED", F5: "RED", F6: "RED" }).filter((r) => !SLOW_INDICATOR_IDS.has(r.id)), DIAL_FAMILIES).families,
        ),
      );
      expect(asIfLive).toBeGreaterThan(0); // non-vacuity: the reference itself is a FIRING confirmer
      expect(dial.techConfirmerP).toBe(asIfLive);
    });
  });
});
