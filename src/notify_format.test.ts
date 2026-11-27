import { describe, expect, test } from "vitest";
import { formatMagnitude, formatDelta, buildNotification, compactBodyBlock, diffusionLines, driverAxisNote, formatRunSummary, LATE_NOTIFY_SEEN_SCOPE, newDegradeEvents, nonLiveSetChanged, NOTIFY_ANCHOR_IDS } from "./notify_format.js";
import { ALL_INDICATORS } from "./registry.js";
import { type Channel, type Reading, type State } from "./domain-types.js";
import type { AlertLevel } from "./ladder.js";
import type { AlertRecord, DegradeEvent } from "./store.js";
import { BAND_DRIVING_CREDIT_MEMBERS, computeFamilyPanel, GLOBAL_FAMILIES, PER_LEG_ONLY_MEMBERS, sleeveLabel, type FamilyDef, type FamilyKey, type FamilyPanel } from "./families.js";
import { computeT1Dial } from "./t1dial.js";
import { BUDGET_ABORT_SCOPE } from "./fetch-budget.js";
import { R4_RESTING } from "./r4.js";
import { applyFallShape } from "./v-bear.js";
import { DISCLAIMER_SHORT } from "./disclaimer.js";
import { drainDegradeLog, drainLateDegrades, recordDegrade, resetDegradeLog } from "./tracks.js";

// --- fixtures (mirrors dashboard.notify.test.ts's notify helpers) -----------------

const mkReading = (id: string, channel: Channel, state: State, level = 1.23, delta20 = 0.1): Reading => ({
  indicator: { id, label: id, longLabel: id, series: id, channel, thresholds: {} },
  date: "2026-06-26",
  level,
  delta20,
  rawState: state,
  state,
});

// buildNotification reads only `last?.level`; a level-only stub is enough.
const lastAt = (level: AlertLevel): AlertRecord => ({ level }) as unknown as AlertRecord;

// --- formatMagnitude -------------------------------------------------------

describe("formatMagnitude", () => {
  test("zero renders as a plain 2dp zero (never widened)", () => {
    expect(formatMagnitude(0)).toBe("0.00");
  });

  test("widens tiny sub-0.005 ratios so they don't collapse to a false 0.00", () => {
    expect(formatMagnitude(0.0019)).toBe("0.00190");
    expect(formatMagnitude(-0.0019)).toBe("-0.00190");
  });

  test("0.005 boundary stays at 2dp (only |v| < 0.005 widens)", () => {
    expect(formatMagnitude(0.005)).toBe("0.01");
  });
});

// --- formatDelta -----------------------------------------------------------

describe("formatDelta", () => {
  test("prefixes a sign and appends the unit", () => {
    expect(formatDelta(0.1, "%")).toBe("+0.10%");
    expect(formatDelta(-0.1, "%")).toBe("-0.10%");
  });

  test("zero counts as non-negative and gets a + sign", () => {
    expect(formatDelta(0, "%")).toBe("+0.00%");
  });
});

// --- compactBodyBlock (2026-07-24 push compaction) -------------------------
//
// The one regime the buildNotification suite can't reach without a full registry: an anchor that is
// ITSELF non-GREEN. It must render once (in the drivers run, where it carries the axis note), never
// a second time under the anchors rule — the bug a naive `[...drivers, ...anchors]` concat ships.

describe("compactBodyBlock", () => {
  const other = (id: string, state: State) => mkReading(id, "FIN", state);

  test("a non-GREEN anchor renders once as a driver, not again under the anchors rule", () => {
    // F1 is an anchor AND red here; R1/R5 are anchors still green; X1/X2 are neither.
    const block = compactBodyBlock([
      other("F1", "RED"),
      other("R1", "GREEN"),
      other("R5", "GREEN"),
      other("X1", "GREEN"),
      other("X2", "GREEN"),
    ]);
    expect(block.filter((l) => l.startsWith("F1:"))).toHaveLength(1);
    expect(block.indexOf("── anchors ──")).toBe(1); // straight after the single driver
    expect(block.filter((l) => l.startsWith("R1:") || l.startsWith("R5:"))).toHaveLength(2);
    // 5 readings − 1 driver − 2 green anchors = 2 omitted.
    expect(block.at(-1)).toBe("2 others GREEN");
  });

  test("an all-GREEN push collapses to the total, and a driver-only set omits nothing", () => {
    const allGreen = compactBodyBlock(NOTIFY_ANCHOR_IDS.map((id) => other(id, "GREEN")));
    expect(allGreen.at(-1)).toBe(`all ${NOTIFY_ANCHOR_IDS.length} GREEN`);
    // Every reading is a driver ⇒ no anchors section and no count tail at all.
    const allRed = compactBodyBlock([other("F1", "RED"), other("R1", "AMBER")]);
    expect(allRed).toHaveLength(2);
    expect(allRed.some((l) => l.includes("GREEN") || l.includes("anchors"))).toBe(false);
  });

  test("the Δ span unit comes off the OBSERVATION grid, not the release cadence", () => {
    // Stage 2 slice 2. F9 rendered "60d"
    // before this — the right answer, but only because `cadence: "weekly"` has no arm and fell
    // to the `"d"` default. A weekly-released id can therefore never DEMONSTRATE the
    // resolution; only a divergence the arms disagree about can. So: one synthetic id that
    // RELEASES monthly (arm: "mo") over a DAILY observation grid (arm: "d"). Reading
    // `cadence` here prints "20mo Δ" — a 30× overstatement — and reading `obsCadence ?? cadence`
    // prints "20d Δ". That is the exact line this pin guards.
    const monthlyReleased: Reading = {
      ...mkReading("XX", "FIN", "AMBER"),
      indicator: {
        ...mkReading("XX", "FIN", "AMBER").indicator,
        cadence: "monthly",
        obsCadence: "daily",
      },
    };
    expect(compactBodyBlock([monthlyReleased])[0]).toContain("20d Δ");
    // The genuinely monthly arm is still reachable — without this the fix is indistinguishable
    // from deleting the "mo" branch (EBP is a live monthly carrier).
    const monthlyObserved: Reading = {
      ...mkReading("YY", "FIN", "AMBER"),
      indicator: { ...mkReading("YY", "FIN", "AMBER").indicator, cadence: "monthly" },
    };
    expect(compactBodyBlock([monthlyObserved])[0]).toContain("20mo Δ");
  });

  test("a genuinely weekly-OBSERVED id captions its span in weeks, off the real registry entry", () => {
    // I5 (2026-08-08). F3 (`NFCIRISK`) is the ONLY id whose resolved `obsCadence ?? cadence` is
    // "weekly", and its `velocityWindow: 4` is a 4-WEEK change. Before the "w" arm it fell to the
    // "d" default and the NOTIFY PATH pushed "4d Δ" — a 7× understatement on the phone.
    //
    // The fixture takes the REAL F3 config, not a synthetic: the arm is only load-bearing while a
    // live id resolves into it, so a hand-built `cadence: "weekly"` stub would keep passing after
    // F3 declared `obsCadence: "daily"` and drained the branch. Reading the registry makes that
    // drain red instead.
    const f3 = ALL_INDICATORS.find((i) => i.id === "F3");
    if (f3 === undefined) throw new Error("F3 missing from the registry - this pin's premise is gone");
    expect(f3.obsCadence ?? f3.cadence).toBe("weekly"); // premise: F3 still resolves into the arm
    const weeklyObserved: Reading = { ...mkReading("F3", "FIN", "AMBER"), indicator: f3 };
    expect(compactBodyBlock([weeklyObserved])[0]).toContain(`${f3.velocityWindow}w Δ`);
  });
});

// --- buildNotification (payload shape for a representative reading set) -----

describe("buildNotification", () => {
  test("assembles a well-formed push payload on an upward transition", () => {
    const readings = [
      mkReading("F1", "FIN", "RED"),
      mkReading("R1", "RATE", "AMBER"),
      mkReading("R5", "COINCIDENT", "GREEN"),
    ];
    const { push, message } = buildNotification(
      lastAt("OK"),
      "WARNING",
      undefined,
      undefined,
      readings,
      "2026-06-26",
    );

    expect(push).toBe(true);
    expect(message.priority).toBe(4);
    expect(message.tags).toBe("orange_circle");
    expect(message.title).toBe("crash-dash - OK -> WARNING");
    // Title is sent as an HTTP header — must stay ASCII (rich arrow lives in the body).
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(message.title)).toBe(true);

    // Body carries the transition, the non-GREEN drivers AS the reading block (2026-07-24
    // compaction — the separate `Drivers:` id line is retired), the dial/families summary
    // (degraded head here — no dial passed), and the as-of stamp.
    expect(message.body).toContain("OK -> WARNING");
    expect(message.body).not.toContain("Drivers:");
    // Step 3 (official short names): the reading line leads with the label, no id prefix.
    // The fixture's indicator is hand-built with label "F1", so this reads "F1: …" once, not twice.
    expect(message.body).toContain("F1: 1.23% (RED)");
    expect(message.body).not.toContain("F1 F1:");
    // R5 is a NOTIFY_ANCHOR_ID and still GREEN here ⇒ it renders under the anchors rule, while
    // the two drivers render above it. Nothing is omitted, so no "others GREEN" tail.
    expect(message.body).toContain("── anchors ──");
    expect(message.body).toContain("R5: 1.23");
    expect(message.body).not.toContain("others GREEN");
    expect(message.body).toContain("degraded run (no dial) → WARNING");
    expect(message.body).toContain("as of 2026-06-26");
    // Stage A legal appendix — the SHORT disclaimer tails every push body (never the title, which
    // is ASCII-only). Sourced from src/disclaimer.ts, so this pins the wording end-to-end.
    expect(message.body).toContain(DISCLAIMER_SHORT);
    expect(message.body.endsWith(`\n\n${DISCLAIMER_SHORT}`)).toBe(true);
  });

  test("does not push on a same-level run and reports no drivers when all GREEN", () => {
    const { push, message } = buildNotification(
      lastAt("OK"),
      "OK",
      undefined,
      undefined,
      [mkReading("F1", "FIN", "GREEN")],
      "2026-06-26",
    );
    expect(push).toBe(false);
    // An all-GREEN body collapses to the count line (the anchor F1 still renders above it).
    expect(message.body).toContain("all 1 GREEN");
  });

  // W5-b review fix 1 — the shared resting default. `R4_RESTING` (r4.ts) is the ONE value both the
  // notify default (`opts.r4 ?? R4_RESTING`) and `run-core.ts`'s pre-`computeR4` initialiser use.
  test("an absent `r4` renders exactly as an explicit resting R4 - one shared default", () => {
    expect(Object.isFrozen(R4_RESTING)).toBe(true); // run-core.ts reassigns its binding; never mutates

    // …and the rendered push body agrees, through the `resolveCash` path the overlay line takes
    // (the only place the whole object, not just its phase, is read).
    const args: [AlertRecord | null, AlertLevel, undefined, undefined, Reading[], string] = [
      lastAt("OK"),
      "WARNING",
      undefined,
      undefined,
      [mkReading("F1", "FIN", "RED")],
      "2026-06-26",
    ];
    const overlay = { cashOverlay: { level: "partial" as const, reason: "accel" }, equityPct: 70 };
    const omitted = buildNotification(...args, overlay);
    const explicit = buildNotification(...args, { ...overlay, r4: R4_RESTING });
    expect(omitted.message.body).toBe(explicit.message.body);
  });

  // B-22 — a v-shape-suppressed overlay must be VISIBLE on the push, not silently swallowed.
  const cashArgs: [AlertRecord | null, AlertLevel, undefined, undefined, Reading[], string] = [
    lastAt("OK"),
    "WARNING",
    undefined,
    undefined,
    [mkReading("F1", "FIN", "RED")],
    "2026-06-26",
  ];

  test("B-22: a v-shape-suppressed overlay surfaces one calm 'suppressed' line - not a partial, not silence", () => {
    // Reason built through the SERVER suppressor so the asserted line can't drift from the marker.
    const suppressed = applyFallShape(
      { level: "partial", since: null, reason: "target rung 3→5 (+2)", nonEquityPct: null, recentTargetRungs: [] },
      "v-shaped",
      true,
    );
    expect(suppressed.level).toBe("off"); // the suppressor really fired
    const { message } = buildNotification(...cashArgs, {
      cashOverlay: { level: suppressed.level, reason: suppressed.reason },
      equityPct: 70,
    });
    expect(message.body).toContain("Cash overlay: suppressed - v-shaped fall; early de-risking deferred");
    expect(message.body).not.toContain("Cash overlay: partial");
  });

  test("B-22: a plain quiet off emits NO cash line - the discriminator is `suppressedBy`, not reason-presence", () => {
    // A quiet off carries a non-null reason too; a reason-presence gate would wrongly print a line here.
    const { message } = buildNotification(...cashArgs, {
      cashOverlay: { level: "off" as const, reason: "no acceleration (+0 over 2 closes)" },
      equityPct: 70,
    });
    expect(message.body).not.toContain("Cash overlay:");
  });

  test("auto-hold: names the held sleeve on every push", () => {
    const { message } = buildNotification(
      lastAt("OK"),
      "WARNING",
      undefined,
      undefined,
      [mkReading("F1", "FIN", "RED")],
      "2026-06-26",
      { hold: { held: "Value", dialSleeve: "Value", override: false, prevHeld: "EM", changed: true } },
    );
    expect(message.body).toContain("· hold Value");
  });

  test("auto-hold: a held-only push (band unchanged) renders a legible 'hold changed'", () => {
    const { push, message } = buildNotification(
      lastAt("WATCH"),
      "WATCH", // no band move — the hold is the sole reason
      undefined,
      undefined,
      [mkReading("F1", "FIN", "AMBER")],
      "2026-06-26",
      { hold: { held: "Value", dialSleeve: "Value", override: false, prevHeld: "EM", changed: true } },
    );
    expect(push).toBe(true); // bidirectional trigger fires even with no upward band change
    expect(message.body).toContain(`hold changed ${sleeveLabel("EM")} → ${sleeveLabel("Value")}`);
    expect(message.title).toContain(`hold changed ${sleeveLabel("EM")} -> ${sleeveLabel("Value")}`); // title stays ASCII
  });

  test("auto-hold: every printed sleeve is its display LABEL, while the rung direction still reads the KEY", () => {
    // Premise: the fixture sleeve really is relabelled, or every assertion below passes on the bare key.
    const label = sleeveLabel("EU-Fin");
    expect(label).not.toBe("EU-Fin");
    // EU-Fin (rung 7) is calmer than the dial sleeve Health (rung 8) ⇒ the "calmer" note — which a
    // label fed into `rungOfSleeve` would lose to the neutral "(differ)" fallback.
    const { message } = buildNotification(
      lastAt("WATCH"),
      "WATCH",
      undefined,
      undefined,
      [mkReading("F1", "FIN", "AMBER")],
      "2026-06-26",
      { hold: { held: "EU-Fin", dialSleeve: "Health", override: true, prevHeld: "Health", changed: true } },
    );
    const health = sleeveLabel("Health");
    expect(message.title).toContain(`hold changed ${health} -> ${label}`);
    expect(message.body).toContain(`hold changed ${health} → ${label} (band`);
    expect(message.body).toContain(`held ${label} · dial sleeve ${health} - per-leg read held calmer`);
    expect(message.body).toContain(`· hold ${label}\n`);
  });

  test("auto-hold: a de-risk-lag override (held ABOVE the ceiling) annotates a 'more defensively above' note, on a band-transition push too", () => {
    // EM (LADDER rung 3) is MORE defensive than the dial sleeve S&P IT (rung 2) ⇒ held sits ABOVE
    // the ceiling: the de-risk-lag path where a re-risk rotation is dwell/streak-blocked.
    const { message } = buildNotification(
      lastAt("OK"),
      "WARNING", // band also moved this run
      undefined,
      undefined,
      [mkReading("F1", "FIN", "RED")],
      "2026-06-26",
      { hold: { held: "EM", dialSleeve: "S&P IT", override: true, prevHeld: null, changed: true } },
    );
    expect(message.body).toContain(
      `held ${sleeveLabel("EM")} · dial sleeve ${sleeveLabel("S&P IT")} - holding more defensively above the dial ceiling (de-risk lag)`,
    );
    expect(message.body).toContain("OK -> WARNING"); // band transition still leads the body
  });

  test("auto-hold: a re-risk-hold override (held BELOW the ceiling) annotates a 'held calmer within the band ceiling' note", () => {
    // Semis (LADDER rung 1) is MORE aggressive / calmer than the dial sleeve EM (rung 3) ⇒ held
    // sits BELOW the ceiling: the common re-risk-hold case.
    const { message } = buildNotification(
      lastAt("OK"),
      "WARNING",
      undefined,
      undefined,
      [mkReading("F1", "FIN", "RED")],
      "2026-06-26",
      { hold: { held: "Semis", dialSleeve: "EM", override: true, prevHeld: null, changed: true } },
    );
    expect(message.body).toContain(
      `held ${sleeveLabel("Semis")} · dial sleeve ${sleeveLabel("EM")} - per-leg read held calmer within the band ceiling`,
    );
    expect(message.body).toContain("OK -> WARNING");
  });

  // Audit rank 6 — degradation annotation: every degrade path biases the band calm-ward, so
  // ≥2 non-live families append a caveat to the push body; below that it's silent.
  const fam = (key: FamilyKey, live: boolean): FamilyPanel => ({
    key,
    label: key,
    state: live ? "GREEN" : null,
    live,
    firing: false,
    contribution: live ? 0 : null,
    members: [],
    absent: 0,
  });

  // Audit-extras 1.2 — transition-only caveat: a chronically-dead feed (same events in the
  // previous run's persisted trace) stops re-inflating every push; new info re-fires.
  test("suppresses the caveat on a genuine REPEAT - same non-live set AND same degrade events (extras 1.2)", () => {
    const events: DegradeEvent[] = [{ scope: "[family:credit] dropped", reason: "last-known RED @ 2026-06-01", effect: "notify" }];
    const last = { level: "OK", degraded: events, nonLiveFamilies: ["credit", "rates"] } as unknown as AlertRecord;
    const families = [fam("credit", false), fam("rates", false), fam("trend", true)];
    const { message } = buildNotification(last, "WARNING", undefined, families, [mkReading("F1", "FIN", "RED")], "2026-06-26", {
      degradeEvents: events,
    });
    expect(message.body).not.toContain("non-live - band may read calm-ward");
  });

  // Same non-live set as last run, so only a NEW degrade event can arm the caveat — and only a `notify` one.
  test.each([{ previous: null }, { previous: [] }])("a new `trace` event leaves the caveat off; a new `notify` one sets it (previous $previous)", ({ previous }) => {
    const last = { level: "OK", degraded: previous, nonLiveFamilies: ["credit", "rates"] } as unknown as AlertRecord;
    const families = [fam("credit", false), fam("rates", false), fam("trend", true)];
    const bodyWith = (effect: DegradeEvent["effect"]) =>
      buildNotification(last, "WARNING", undefined, families, [mkReading("F1", "FIN", "RED")], "2026-06-26", {
        degradeEvents: [{ scope: "[prices] primary fell back to fallback", reason: "429", effect }],
      }).message.body;
    expect([bodyWith("trace").includes("calm-ward"), bodyWith("notify").includes("calm-ward")]).toEqual([false, true]);
  });

  // The defect this fix closes: the caveat FIRES on the non-live family count but USED to be gated
  // on the degrade LOG — an independent source. Two families can go non-live with no degrade event
  // at all (their indicators are simply absent from `readings`), and the old gate then went silent
  // on the FIRST occurrence. Goes RED against the pre-fix code.
  test("fires on the FIRST occurrence even when NO degrade event was recorded (fail open)", () => {
    // Empty degrade log, and the previous run recorded no non-live families at all.
    const last = { level: "OK", degraded: [], nonLiveFamilies: [] } as unknown as AlertRecord;
    const families = [fam("credit", false), fam("rates", false), fam("trend", true)];
    const { message } = buildNotification(last, "WARNING", undefined, families, [mkReading("F1", "FIN", "RED")], "2026-06-26", {
      degradeEvents: [],
    });
    expect(message.body).toContain("2 families non-live - band may read calm-ward");
  });

  // Stage 8.1 audit fix (leg b) — a run-wide fetch-budget abort forces the caveat regardless of the
  // non-live COUNT. The regime that breaks the old rule: exactly ONE starved family (below
  // DEGRADE_ANNOTATE_MIN=2) on a bidirectional hold-change push, which pre-fix emitted
  // "hold changed <defensive> → <aggressive>" with nothing saying a fetch deadline caused it.
  test("a fetch-budget abort forces the calm-ward caveat with only ONE non-live family", () => {
    const last = { level: "OK", degraded: [], nonLiveFamilies: [] } as unknown as AlertRecord;
    const families = [fam("credit", false), fam("rates", true), fam("trend", true)];
    const { message } = buildNotification(last, "WARNING", undefined, families, [mkReading("F1", "FIN", "RED")], "2026-06-26", {
      degradeEvents: [{ scope: BUDGET_ABORT_SCOPE, reason: "run fetch budget exhausted", effect: "notify" }],
      hold: { held: "Semis", dialSleeve: "Semis", override: false, prevHeld: "Gold", changed: true },
    });
    expect(message.body).toContain("run fetch budget exhausted - feeds incomplete (1 families non-live)");
    expect(message.body).toContain("band may read calm-ward");
  });

  // Control (keeps the fix from degenerating into "always annotate"): the same single non-live
  // family with an ordinary feed degrade — NOT a budget abort — stays silent, as designed.
  test("a NON-budget degrade with one non-live family still stays silent (fix is scope-keyed)", () => {
    const last = { level: "OK", degraded: [], nonLiveFamilies: [] } as unknown as AlertRecord;
    const families = [fam("credit", false), fam("rates", true), fam("trend", true)];
    const { message } = buildNotification(last, "WARNING", undefined, families, [mkReading("F1", "FIN", "RED")], "2026-06-26", {
      degradeEvents: [{ scope: "[F1] non-live - FRED fetch failed", reason: "500", effect: "notify" }],
    });
    expect(message.body).not.toContain("calm-ward");
  });

  test("re-fires the caveat when a degrade event is new vs the previous trace (extras 1.2)", () => {
    const last = { level: "OK", degraded: [{ scope: "[family:credit] dropped", reason: "old", effect: "notify" }] } as unknown as AlertRecord;
    const families = [fam("credit", false), fam("rates", false), fam("trend", true)];
    const { message } = buildNotification(last, "WARNING", undefined, families, [mkReading("F1", "FIN", "RED")], "2026-06-26", {
      degradeEvents: [{ scope: "[family:credit] dropped", reason: "changed reason", effect: "notify" }],
    });
    expect(message.body).toContain("2 families non-live - band may read calm-ward");
  });

  // `priorLateNotifyEvents`: a seed-tail degrade runs after its run's push, so the NEXT EOD push carries it.
  // The prior rows come from the real writer: record post-drain as the cycle does, then `drainLateDegrades`.
  const SCOPE = "[seed-tail] seed non-live this run";
  const lateRow = (late: { reason: string; effect: DegradeEvent["effect"] }[]): AlertRecord => {
    resetDegradeLog();
    drainDegradeLog();
    for (const e of late) recordDegrade(SCOPE, e.reason, e.effect);
    const degraded = drainLateDegrades();
    resetDegradeLog();
    return { level: "OK", degraded, nonLiveFamilies: [] } as unknown as AlertRecord;
  };
  const quiet = (last: AlertRecord) => buildNotification(last, "OK", undefined, undefined, [mkReading("F1", "FIN", "GREEN")], "2026-06-26");
  const CAPE = "[tail.cape] F7 skipped - unsettled at the run hard deadline";

  test("the last run's late-notify seed-tail degrade triggers this push and names its reason", () => {
    const { push, message } = quiet(lateRow([{ reason: CAPE, effect: "notify" }]));
    expect(push).toBe(true);
    expect(message.body).toContain(`\n[!] last run's seed tail: ${CAPE}`);
  });

  test("a late `trace` event (a routine seed warn) on the row before neither pushes nor renders", () => {
    const { push, message } = quiet(lateRow([{ reason: "[legp] off-ladder GLD close feed non-live this run: 429", effect: "trace" }]));
    expect([push, message.body.includes("last run's seed tail")]).toEqual([false, false]);
  });

  // Transition-only across nights: each run is the cycle's order through the real recorders — `quiet(prev)` decides the
  // push, its `lateSeen` markers are recorded pre-drain (run-cycle.ts), `drainDegradeLog` is the row, then the tail's
  // `tailFails` late events append (`drainLateDegrades`, persistRunTrace).
  // `tailFails`: `true` = the CAPE deadline skip, or the exact late reasons this night's tail records.
  const night = (prev: AlertRecord, tailFails: boolean | readonly string[]) => {
    resetDegradeLog();
    const out = quiet(prev);
    for (const m of out.lateSeen) recordDegrade(m.scope, m.reason, "trace");
    const committed = drainDegradeLog();
    for (const r of tailFails === true ? [CAPE] : tailFails === false ? [] : tailFails) recordDegrade(SCOPE, r, "notify");
    const degraded = [...committed, ...drainLateDegrades()];
    resetDegradeLog();
    return { push: out.push, line: out.message.body.includes("last run's seed tail"), body: out.message.body, row: { level: "OK", degraded, nonLiveFamilies: [] } as unknown as AlertRecord };
  };
  const MARK = { scope: LATE_NOTIFY_SEEN_SCOPE, reason: `${SCOPE}: [tail.cape] F7`, effect: "trace" };

  // A chronic task's reason text changes night to night (variable error detail; rejected <-> deadline-skipped) - still one push.
  test.each([
    [
      "tail task: rejected (429) -> rejected (another error) -> deadline-skipped",
      ["[tail.cape] F7 not seeded - task rejected: 429 retry-after 31", "[tail.cape] F7 not seeded - task rejected: 503 req 7f3a", CAPE],
    ],
    ["input-series id: error text changes", ["[input-series] NTFS seed non-live this run: 429 retry-after 12", "[input-series] NTFS seed non-live this run: aborted"]],
    [
      "roster-wide probe failure: error text changes",
      ["[input-series] seed non-live this run (probe failed): 429 - skipped A,B", "[input-series] seed non-live this run (probe failed): ETIMEDOUT - skipped A,B"],
    ],
  ])("multi-run (e): chronic, changing reason text pushes once - %s", (_, reasons) => {
    const n1 = night(lateRow([{ reason: reasons[0]!, effect: "notify" }]), [reasons[1]!]);
    // The surfacing line shows the full reason as recorded, not the key.
    expect([n1.push, n1.body.includes(`\n[!] last run's seed tail: ${reasons[0]}`)]).toEqual([true, true]);
    // Each later night reads the previous night's reworded event; the last night's tail is clean.
    let prev = n1.row;
    const pushes: boolean[] = [];
    for (const r of [...reasons.slice(2), null]) {
      const n = night(prev, r === null ? [] : [r]);
      pushes.push(n.push);
      prev = n.row;
    }
    expect(pushes).toEqual(pushes.map(() => false));
  });

  test("multi-run (f): a DIFFERENT task failing beside a chronic one is keyed separately and still surfaces", () => {
    const LEGS = "[tail.legs] LEGP_A,GRS_A skipped - unsettled at the run hard deadline";
    const NTFS_FAIL = "[input-series] NTFS seed non-live this run: aborted";
    const GOLD = "[input-series] GOLD seed non-live this run: aborted";
    const n1 = night(lateRow([{ reason: CAPE, effect: "notify" }, { reason: NTFS_FAIL, effect: "notify" }]), [CAPE, NTFS_FAIL, LEGS, GOLD]);
    expect(n1.push).toBe(true);
    const n2 = night(n1.row, false);
    const lines = n2.body.split("\n").filter((l) => l.startsWith("[!] last run's seed tail"));
    expect([n2.push, lines]).toEqual([true, [`[!] last run's seed tail: ${LEGS}`, `[!] last run's seed tail: ${GOLD}`]]);
  });

  test("multi-run (a): N+1 surfaces the late event and records the seen marker on its own row", () => {
    const n1 = night(lateRow([{ reason: CAPE, effect: "notify" }]), true);
    expect([n1.push, n1.line]).toEqual([true, true]);
    expect(n1.row.degraded).toContainEqual(MARK);
  });

  test("multi-run (b): chronic - N+2 reads N+1's marker for the same event: no push, no line, marker re-recorded", () => {
    const n1 = night(lateRow([{ reason: CAPE, effect: "notify" }]), true);
    const n2 = night(n1.row, true);
    expect([n2.push, n2.line]).toEqual([false, false]);
    expect(n2.row.degraded).toContainEqual(MARK);
    // Still suppressed a night later: the chain carries itself.
    expect(night(n2.row, true).push).toBe(false);
  });

  test("multi-run (c): a clean night drops the chain, so a recurrence surfaces again", () => {
    // N+1 surfaces + marks, and its own tail is clean; N+2 reads no late event, so records no marker (its tail fails again).
    const n1 = night(lateRow([{ reason: CAPE, effect: "notify" }]), false);
    const n2 = night(n1.row, true);
    expect([n2.push, n2.row.degraded!.some((e) => e.scope === LATE_NOTIFY_SEEN_SCOPE)]).toEqual([false, false]);
    const n3 = night(n2.row, false);
    expect([n3.push, n3.line]).toEqual([true, true]);
  });

  // A failed send on the surfacing night (`pushError`) lost the line — its marker must not dedupe, so N+2 surfaces again.
  test("multi-run (d): N+1 carries the marker AND a pushError - N+2 surfaces the event again", () => {
    const n1 = night(lateRow([{ reason: CAPE, effect: "notify" }]), true);
    expect(n1.row.degraded).toContainEqual(MARK);
    const failed = { ...n1.row, pushError: "ntfy 503" } as AlertRecord;
    const n2 = night(failed, true);
    expect([n2.push, n2.line]).toEqual([true, true]);
    expect(n2.row.degraded).toContainEqual(MARK);
  });

  test("the marker is inert: stored `trace`, no `late`, so it neither surfaces nor dedupes a live event", () => {
    const markerOnly = { level: "OK", degraded: [MARK], nonLiveFamilies: [] } as unknown as AlertRecord;
    expect([quiet(markerOnly).push, quiet(markerOnly).lateSeen]).toEqual([false, []]);
    expect(newDegradeEvents([{ ...MARK, effect: "notify" }], [MARK as DegradeEvent])).toHaveLength(1);
  });
});

// --- newDegradeEvents (audit-extras 1.2) -------------------------------------

describe("newDegradeEvents", () => {
  const ev = (scope: string, reason: string) => ({ scope, reason, effect: "notify" as const });
  test("same event two runs in a row → not new", () => {
    expect(newDegradeEvents([ev("a", "r")], [ev("a", "r")])).toEqual([]);
  });
  test("changed reason is new information → re-fires", () => {
    expect(newDegradeEvents([ev("a", "r2")], [ev("a", "r1")])).toEqual([ev("a", "r2")]);
  });
  // Fail open: a legacy `run_inputs.degradeEvents` replayed on rederive carries no `effect` — only `trace` is dropped.
  test("an event with no `effect` counts; a `trace` one does not", () => {
    const legacy = { scope: "a", reason: "r" } as DegradeEvent;
    expect(newDegradeEvents([legacy, { ...ev("b", "s"), effect: "trace" }], null)).toEqual([legacy]);
    expect(newDegradeEvents([legacy], [])).toEqual([legacy]);
  });
  test("a prior `trace` event with the same scope+reason does not dedupe a notify one", () => {
    expect(newDegradeEvents([ev("a", "r")], [{ ...ev("a", "r"), effect: "trace" }])).toEqual([ev("a", "r")]);
  });
  // A prior LATE notify event is stored `trace` — it surfaces once on its own line, and never dedupes a live one.
  test("a prior late-notify event with the same scope+reason does not dedupe a live notify one", () => {
    expect(newDegradeEvents([ev("a", "r")], [{ ...ev("a", "r"), effect: "trace", late: "notify" }])).toEqual([ev("a", "r")]);
  });
  test("null previous trace (first run) → everything is new", () => {
    expect(newDegradeEvents([ev("a", "r"), ev("b", "s")], null)).toEqual([ev("a", "r"), ev("b", "s")]);
  });
  // The structured `coverage` payload (2026-08-01 R8, /lab `coverage`) rides the SAME event the
  // `[coverage]` emitter already recorded. The dedupe key is scope+reason ONLY, so an unchanged
  // payload must stay deduped: were `coverage` folded into the equality, a chronically dark feed
  // whose age (and therefore nothing structural) changes would re-inflate the push every run. Both
  // sides of the pin: identical event + payload → not new; and it does not SUPPRESS a genuinely new
  // one.
  test("an unchanged event carrying a structured coverage payload is still deduped (it is not part of the key)", () => {
    // TWO distinct objects, structurally equal: the previous run's payload is re-hydrated from the
    // alert row's jsonb, so it is never the same reference — an equality that reached into
    // `coverage` at all (even by identity) would re-fire the push every run.
    // R6 is a `rates` member — a `volatility` here would be
    // a family the emitter cannot produce for this id.
    const coverage = () => ({
      family: "rates",
      verdict: "GREEN" as const,
      carried: false,
      members: [{ id: "R6", reason: "lag" as const, series: "^MOVE", state: "GREEN" as const, ageDays: 15 }],
    });
    expect(
      newDegradeEvents([{ ...ev("a", "r"), coverage: coverage() }], [{ ...ev("a", "r"), coverage: coverage() }]),
    ).toEqual([]);
    // A payload on a run whose previous trace had none (the ship boundary) is new by reason/scope alone.
    expect(newDegradeEvents([{ ...ev("a", "r2"), coverage: coverage() }], [ev("a", "r1")])).toEqual([
      { ...ev("a", "r2"), coverage: coverage() },
    ]);
  });
});

// --- nonLiveSetChanged (the caveat's real dedupe key, 2026-07-18) ------------

describe("nonLiveSetChanged", () => {
  test("null previous (unknown / pre-migration / first run) → NEWS (fail open)", () => {
    expect(nonLiveSetChanged(["credit", "rates"], null)).toBe(true);
  });
  test("identical set (a chronically non-live family) → not news - this is the §1.2 dedupe", () => {
    expect(nonLiveSetChanged(["credit", "rates"], ["rates", "credit"])).toBe(false);
  });
  test("same count, different members → news", () => {
    expect(nonLiveSetChanged(["credit", "trend"], ["credit", "rates"])).toBe(true);
  });
  test("a family recovering (set shrinks) → news", () => {
    expect(nonLiveSetChanged(["credit"], ["credit", "rates"])).toBe(true);
  });
});

// --- formatRunSummary — the LIVE notify head (O2 step 4) ---------------------

describe("formatRunSummary - live dial head", () => {
  const CONTRIB: Record<State, number> = { GREEN: 0, AMBER: 0.5, RED: 1 };
  const familyPanel = (key: FamilyKey, state: State, live = true): FamilyPanel => ({
    key,
    label: key,
    state: live ? state : null,
    live,
    firing: live && state !== "GREEN",
    contribution: live ? CONTRIB[state] : null,
    members: [],
    absent: 0,
  });

  test("pins the exact head: dial regime+rung, live/firing family filter, K/N count, keys join", () => {
    // Mixed panel: credit live+firing (RED leader), volatility live+firing (AMBER),
    // rates live-but-calm (counts in N, not K), trend NOT live (excluded from both).
    const families = [
      familyPanel("credit", "RED"),
      familyPanel("rates", "GREEN"),
      familyPanel("volatility", "AMBER"),
      familyPanel("trend", "RED", false), // dropped feed — a RED here must not leak into K/N
    ];
    // A REAL dial over the same panel: RED credit leader → band [4,6]; leadingP=1 ⇒
    // rung 6, dangerScore 0.625 ⇒ Stress, targetRung 6.
    const dial = computeT1Dial(families);
    expect(dial.regime).toBe("Stress");
    expect(dial.targetRung).toBe(6);

    const { summary } = formatRunSummary([], "WARNING", dial, families);
    expect(summary).toBe("Dial Stress r6 · families 2/3 firing (credit, volatility) → WARNING");
  });
});

// --- D5 (family-colour-follows-danger) — cannot-arm suffix ONLY when nothing fires ---
// Folded through the real `computeFamilyPanel`, so `cannotArm` is the producer's, not a hand-typed
// mirror. credit is BAND_DRIVING (band ids = `BAND_DRIVING_CREDIT_MEMBERS`); a red only on an unseated
// member seats nothing → GREEN. Every member id is drawn from the live rosters, never hand-typed.
describe("formatRunSummary - D5 cannot-arm suffix", () => {
  const rosterOf = (key: FamilyKey) => GLOBAL_FAMILIES.find((f) => f.key === key)!.ids;
  // One seated credit member, and the credit members the band does NOT seat (per-leg-only never count).
  const seated = BAND_DRIVING_CREDIT_MEMBERS[0]!;
  const unseated = rosterOf("credit").filter(
    (id) => !BAND_DRIVING_CREDIT_MEMBERS.includes(id) && !PER_LEG_ONLY_MEMBERS.includes(id),
  );
  const panelOf = (defs: FamilyDef[], states: Record<string, State>): FamilyPanel[] =>
    computeFamilyPanel(
      Object.entries(states).map(([id, state]) => ({ id, state })),
      defs,
    ).families;
  const bodyFor = (families: FamilyPanel[], band: AlertLevel) =>
    buildNotification(lastAt("OK"), band, undefined, families, [mkReading(seated, "FIN", "GREEN")], "2026-06-26")
      .message.body;

  test("case A — something fires ⇒ NO suffix, even with a live cannot-arm red on credit", () => {
    // The plan's reproduction: credit RED via an unseated member (→ GREEN), cross-asset RED (fires),
    // valuation AMBER (fires). The body names cross-asset, not credit, and carries no suffix.
    const cross = rosterOf("cross-asset")[0]!;
    const val = rosterOf("valuation")[0]!;
    const families = panelOf(
      [
        { key: "credit", label: "credit", ids: [seated, unseated[0]!] },
        { key: "cross-asset", label: "cross-asset", ids: [cross] },
        { key: "valuation", label: "valuation", ids: [val] },
      ],
      { [seated]: "GREEN", [unseated[0]!]: "RED", [cross]: "RED", [val]: "AMBER" },
    );
    // Precondition: the mark IS set — so a suppressed suffix proves the firing gate, not an empty mark.
    const credit = families.find((f) => f.key === "credit")!;
    expect(credit.firing).toBe(false);
    expect(credit.cannotArm).toEqual({ count: 1, worst: "RED", worstCount: 1 });

    const { summary } = formatRunSummary([], "WARNING", undefined, families);
    expect(summary).toContain("(cross-asset, valuation)");
    expect(summary).not.toContain("credit");
    expect(summary).not.toContain("cannot arm");
    expect(bodyFor(families, "WARNING")).not.toContain("cannot arm");
  });

  const creditOf = (states: State[]) => {
    const ids = unseated.slice(0, states.length);
    return panelOf(
      [{ key: "credit", label: "credit", ids: [seated, ...ids] }],
      Object.fromEntries([[seated, "GREEN"], ...ids.map((id, i) => [id, states[i]!])]),
    );
  };

  test("premise — credit keeps ≥2 unseated members for B/C to mix", () => {
    expect(unseated.length).toBeGreaterThanOrEqual(2);
  });

  test("case B — nothing fires but a non-seated red ⇒ append '(credit: 1 red, cannot arm)', ambers uncounted", () => {
    // 1 red + 1 amber unseated: the count names the reds only ([USER] 2026-09-27) — the total
    // (2) would print "2 red" over a mixed set, the prod 2026-09-27 "4 red" over 3 red + 1 amber.
    const families = creditOf(["RED", "AMBER"]);
    expect(families.every((f) => !f.firing)).toBe(true);
    const { summary } = formatRunSummary([], "OK", undefined, families);
    expect(summary).toContain("(credit: 1 red, cannot arm)");
    expect(bodyFor(families, "OK")).toContain("(credit: 1 red, cannot arm)");
  });

  test("case C — no unseated red ⇒ the ambers are counted", () => {
    expect(formatRunSummary([], "OK", undefined, creditOf(["AMBER", "AMBER"])).summary).toContain("(credit: 2 amber, cannot arm)");
  });
});

// --- D3 Stage 2.3 — driver-line level-vs-velocity attribution ---------------

describe("driverAxisNote (push copy)", () => {
  const withLeg = (id: string, state: State, leg?: string): Reading => ({
    ...mkReading(id, "FIN", state),
    ...(leg ? { leg } : {}),
  });

  test("names the axis for a dual-axis id, in the shape `<id> <STATE> - via <axis>`", () => {
    expect(driverAxisNote(withLeg("F1", "RED", "vel-op"))).toBe(" - via velocity");
    expect(driverAxisNote(withLeg("F1", "RED", "op"))).toBe(" - via level");
    // The z legs are σ-restatements of their OWN axis (axisClass), so `z` reads level and
    // `vel-z` reads velocity — the one classification that could silently invert.
    expect(driverAxisNote(withLeg("CCC", "AMBER", "z"))).toBe(" - via level");
    expect(driverAxisNote(withLeg("CCC", "AMBER", "vel-z"))).toBe(" - via velocity");
  });

  test("R2/R3/R4 get NO axis note - velocity-only, so 'via velocity' is a tautology", () => {
    for (const id of ["R2", "R3", "R4"]) {
      expect(driverAxisNote(withLeg(id, "RED", "vel-op"))).toBe("");
      expect(driverAxisNote(withLeg(id, "RED", "vel-evt"))).toBe("");
    }
  });

  test("an unattributed reading (no leg - raw ≠ confirmed, or unscored) stays bare", () => {
    expect(driverAxisNote(withLeg("F1", "RED"))).toBe("");
  });

  test("E-a discipline: no severity language, no exclamation, no adjective", () => {
    for (const leg of ["op", "vel-op", "evt", "vel-evt", "z", "vel-z"]) {
      const note = driverAxisNote(withLeg("F1", "RED", leg));
      expect(note).toMatch(/^ - via (level|velocity)$/);
    }
  });

  test("rides the rendered driver line of a real push body", () => {
    const readings = [withLeg("F1", "RED", "vel-op"), withLeg("R2", "RED", "vel-op")];
    const { message } = buildNotification(lastAt("OK"), "WARNING", undefined, undefined, readings, "2026-06-26");
    // Post-compaction the note rides the READING line (the `Drivers:` id line is retired), so it
    // lands after the delta rather than after the state.
    const f1 = message.body.split("\n").find((l) => l.startsWith("F1:"));
    expect(f1).toMatch(/ - via velocity$/);
    // …and the R2 entry carries no axis note at all (the exclusion, on the wire).
    expect(message.body).not.toContain("R2 RED - via");
    expect(message.body.split("\n").find((l) => l.startsWith("R2:"))).not.toMatch(/ - via /);
  });
});

// --- W4-e FLAG slice: stale-legs line on the push -------------------------------
describe("buildNotification stale-legs FLAG (W4-e Stage 3)", () => {
  const lastOK = { level: "OK" } as unknown as AlertRecord;
  const readings = [mkReading("F1", "FIN", "RED")];

  test("renders one line naming each stale leg's label + age when verdictHoldLegs is non-empty", () => {
    const { message } = buildNotification(lastOK, "WARNING", undefined, undefined, readings, "2026-06-26", {
      verdictHoldLegs: [
        { id: "FXH", label: "FX havens (EUR/CHF/JPY bid)", ageDays: 12, cadence: "weekly" },
        { id: "R1", label: "Term spread", ageDays: 5, cadence: "daily" },
      ],
    });
    expect(message.body).toContain("lagging legs:");
    expect(message.body).toContain("FX havens (EUR/CHF/JPY bid) (12d)");
    expect(message.body).toContain("Term spread (5d)");
  });

  test("omits the stale-legs line entirely when verdictHoldLegs is empty/absent", () => {
    const emptyArr = buildNotification(lastOK, "WARNING", undefined, undefined, readings, "2026-06-26", {
      verdictHoldLegs: [],
    });
    const absent = buildNotification(lastOK, "WARNING", undefined, undefined, readings, "2026-06-26");
    expect(emptyArr.message.body).not.toContain("lagging legs:");
    expect(absent.message.body).not.toContain("lagging legs:");
  });
});

// --- IS-7 §17.3 — the inner, member-level diffusion lines -------------------
// One line per FIRING family, directly under the summary's outer `K/N firing` breadth.
// Panels are folded through `computeFamilyPanel` over synthetic rosters rather than typed by
// hand, so present/absent counts are the producer's, not a mirror that can drift from it.
describe("buildNotification - per-family diffusion lines (IS-7 §17.3)", () => {
  const roster = (key: FamilyKey, n: number): FamilyDef => ({
    key,
    label: key,
    ids: Array.from({ length: n }, (_, i) => `${key}${i + 1}`),
  });
  /** Fold `defs` over the given per-id states; ids with no state are dark. */
  const panelOf = (defs: FamilyDef[], states: Record<string, State>): FamilyPanel[] =>
    computeFamilyPanel(
      Object.entries(states).map(([id, state]) => ({ id, state })),
      defs,
    ).families;
  const bodyFor = (families: FamilyPanel[] | undefined, band: AlertLevel = "WARNING") =>
    buildNotification(lastAt("OK"), band, undefined, families, [mkReading("F1", "FIN", "GREEN")], "2026-06-26")
      .message.body;

  test("appends one line per firing family, under the summary and above the as-of line", () => {
    // volatility: 6 of 8 present, 1 RED + 2 AMBER ⇒ worst-of RED. valuation: 8 of 8 present, 3 AMBER
    // ⇒ worst-of AMBER. (§17.3's illustrative sample shows a 3-red AMBER family, which the
    // worst-of fold cannot produce — a RED member always reddens its family.)
    // D1: both are non-BAND_DRIVING keys, so their full-roster worst-of fires — credit/rates/trend would
    // seat none of these synthetic ids and fold GREEN, off-point for this diffusion-line mechanics test.
    const defs = [roster("volatility", 8), roster("valuation", 8)];
    const families = panelOf(defs, {
      volatility1: "RED",
      volatility2: "AMBER",
      volatility3: "AMBER",
      volatility4: "GREEN",
      volatility5: "GREEN",
      volatility6: "GREEN",
      ...Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`valuation${i + 1}`, i < 3 ? "AMBER" : "GREEN"] as const),
      ),
    } as Record<string, State>);
    const body = bodyFor(families);
    expect(body).toContain(
      "\ndegraded run (no dial) · families 2/2 firing (volatility, valuation) → WARNING" +
        "\n  volatility RED, 1 red / 3 elevated of 6 (2 dark)" +
        "\n  valuation  AMBER, 0 red / 3 elevated of 8" +
        "\nas of 2026-06-26",
    );
  });

  test("zero firing families ⇒ the body is byte-identical to the pre-IS-7 push", () => {
    // The whole neutrality claim, pinned as a literal: nothing between the summary line and
    // `as of`. (The only body-template change this build makes is interpolating `diffusionNote`
    // there, and it is "" on this path.)
    const calm = panelOf([roster("credit", 3)], { credit1: "GREEN", credit2: "GREEN" });
    expect(bodyFor(calm, "WATCH")).toBe(
      "OK -> WATCH\nGuidance: risk is elevating one notch - monitor; no action required yet." +
        "\n\n── anchors ──\nF1: 1.23% (GREEN) · 20d Δ +0.10%\nall 1 GREEN" +
        "\ndegraded run (no dial) · families 0/1 firing → WATCH\nas of 2026-06-26" +
        `\n\n${DISCLAIMER_SHORT}`,
    );
  });

  test("is not capped at 3 - the anchor block's ≤3 rule does not govern a derived list", () => {
    // D1: all four are non-BAND_DRIVING keys, so each fires on its full-roster worst-of.
    const keys: FamilyKey[] = ["volatility", "cross-asset", "geopolitics", "valuation"];
    const defs = keys.map((k) => roster(k, 2));
    const families = panelOf(defs, Object.fromEntries(keys.map((k) => [`${k}1`, "RED"])) as Record<string, State>);
    expect(diffusionLines(families)).toHaveLength(4);
    expect(bodyFor(families)).toContain("volatility  RED, 1 red / 1 elevated of 1 (1 dark)");
  });

  test("the inner line never says 'firing' - only the outer count carries that word (§17.0)", () => {
    const families = panelOf([roster("volatility", 2)], { volatility1: "RED", volatility2: "GREEN" });
    for (const line of diffusionLines(families)) expect(line).not.toContain("firing");
    // ...and the outer count still does, unchanged.
    expect(bodyFor(families)).toContain("· families 1/1 firing (volatility) →");
  });

  test("a NON-firing live family gets no line, even beside a firing one", () => {
    // D1: `volatility`/`cross-asset` are non-BAND_DRIVING keys, so the RED one fires on its full roster.
    const families = panelOf([roster("volatility", 2), roster("cross-asset", 2)], {
      volatility1: "RED",
      "cross-asset1": "GREEN",
      "cross-asset2": "GREEN",
    });
    const lines = diffusionLines(families);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("volatility RED,");
  });
});
