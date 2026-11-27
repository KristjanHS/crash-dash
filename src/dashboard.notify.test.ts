import { expect, test, describe } from "vitest";
import { ALL_INDICATORS } from "./registry.js";
import { ESTR, VT } from "./registry-composite.js";
import { KBE_RS, MU_RS, NVDA } from "./registry-price.js";
import { type Channel, type Indicator, type Reading, type State } from "./domain-types.js";
import { computeFamilyPanel } from "./families.js";
import { DIAL_FAMILIES } from "./danger-ladder.js";
import type { AlertLevel } from "./ladder.js";
import { assembleRun } from "./run-core.js";
import { escalatorFloor, STAGE_TO_FLAGS } from "./alert-band.js";
import { RERISK_BASIS_EPOCH } from "./danger-engine.js";
import { R4_REENTRY_START, type R4Phase } from "./r4.js";
import { makeDial } from "./test-helpers.js";
import { buildNotification } from "./notify_format.js";
import type { OilNowcast } from "./oil-nowcast.js";
import { estimatorOf } from "./nowcast-score.js";
import { type AlertRecord, type StoredReading } from "./store.js";
import type { ScoredTrack } from "./tracks.js";
import { buildTierNotification } from "./notify_tier.js";
import { SLOW_TIER } from "./slow_tier.js";
import { type SlowVerdict, type SlowBand } from "./slow.js";

// --- notify payload helpers
const notifyReading = (id: string, channel: Channel, state: State): Reading => ({
  indicator: { id, label: id, longLabel: id, series: id, channel, thresholds: {} },
  date: "2026-06-26",
  level: 1.23,
  delta20: 0.1,
  rawState: state,
  state,
  decision: null,
});

const mkLast = (level: AlertLevel): AlertRecord => ({
  date: "2026-06-20",
  level,
  bandReason: "regime",
  fin: 0,
  rate: 0,
  geoFlags: 0,
  coincident: "GREEN",
  finReds: 0,
  firedAt: "2026-06-20T22:00:00.000Z",
  pushedAt: "2026-06-20T22:00:00.000Z",
  pushError: null,
  degraded: [],
  nonLiveFamilies: null,
  slowScore: null,
  slowBand: null,
  slowMaxScore: null,
  bottomState: null,
  vix: null,
  vix3m: null,
  ratio: null,
  r4Phase: null,
  r4EntryFiredAt: null,
  r4ReentryRung: null,
  dialBand: null,
  dialState: null,
  displayDialState: null,
  panelState: null,
  heldSleeve: null,
  reriskConfirmCount: 0,
  heldDays: 0,
  cashOverlay: "off",
  cashOverlaySince: null,
  cashOverlayReason: null,
  dialTargetRung: null,
  fallShape: "indeterminate",
  fallVelocity: null,
  creditDwellCloses: null,
});

describe("buildNotification (what-changed payload + priority §6.5)", () => {
  test("T11: CRITICAL is max priority with the alarm tag", () => {
    const { message } = buildNotification(
      mkLast("WARNING"),
      "CRITICAL",
      undefined,
      undefined,
      [notifyReading("F1", "FIN", "RED")],
      "2026-06-26",
    );
    expect(message.priority).toBe(5);
    expect(message.tags).toBe("rotating_light");
  });

  test("T12b: a stale feed annotates a push that fires for another reason (ASCII, no header break)", () => {
    const { message } = buildNotification(
      mkLast("OK"),
      "WARNING",
      undefined,
      undefined,
      [notifyReading("F1", "FIN", "RED")],
      "2026-06-20",
      { freshness: { lag: true, ageDays: 6, unit: "days" } },
    );
    expect(message.body).toContain("feed lag: latest data 6d old");
    // Title is an HTTP header — stale marker lives in the body only.
    expect(message.title).not.toContain("lag");
  });

  test("T12c: a fresh feed adds no stale line", () => {
    const { message } = buildNotification(
      mkLast("OK"),
      "WARNING",
      undefined,
      undefined,
      [notifyReading("F1", "FIN", "RED")],
      "2026-06-26",
      { freshness: { lag: false, ageDays: 0, unit: "days" } },
    );
    expect(message.body).not.toContain("feed lag");
  });

  test("T14: a weekly re-assert pushes a same-level alert as 'still <level>'", () => {
    const { push, message } = buildNotification(
      mkLast("CRITICAL"), // same level — notify-on-change alone would stay silent
      "CRITICAL",
      undefined,
      undefined,
      [notifyReading("F1", "FIN", "RED")],
      "2026-06-26",
      { reassertDue: true },
    );
    expect(push).toBe(true);
    expect(message.title).toBe("crash-dash - still CRITICAL");
    expect(message.body).toContain("still CRITICAL (weekly re-assert)");
    // ASCII-only title (HTTP header).
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(message.title)).toBe(true);
  });

  test("T15: an upward change still wins the header over a coincident re-assert flag", () => {
    const { message } = buildNotification(
      mkLast("WARNING"),
      "CRITICAL",
      undefined,
      undefined,
      [notifyReading("F1", "FIN", "RED")],
      "2026-06-26",
      { reassertDue: true },
    );
    expect(message.title).toBe("crash-dash - WARNING -> CRITICAL");
  });

  // S5 (oil-nowcast): the BRENT/G1 est. clause + GREEN surfacing (R6/R7/R12/R13). Fixtures DERIVE the
  // divergence from each id's OWN registry `estimator.cutPct` — never restating the value (R6).
  describe("BRENT/G1 same-day oil estimate clause", () => {
    const PRINT: Record<"BRENT" | "G1", number> = { BRENT: 100, G1: 50 };
    // deltaPct = pct exactly, since est = print * (1 + pct/100).
    const estAt = (id: "BRENT" | "G1", pct: number): OilNowcast => ({
      date: "2026-06-26",
      value: PRINT[id] * (1 + pct / 100),
      fromDate: "2026-06-25",
    });
    const oilReading = (id: "BRENT" | "G1", state: State = "GREEN"): Reading => ({
      ...notifyReading(id, "GEO", state),
      level: PRINT[id],
      indicator: { id, label: id, longLabel: id, series: id, channel: "GEO", thresholds: {}, unit: "" },
    });
    const body = (id: "BRENT" | "G1", pct: number | null, state: State = "GREEN") =>
      buildNotification(mkLast("OK"), "WARNING", undefined, undefined, [oilReading(id, state)], "2026-06-26", {
        oilEst: { [id]: pct === null ? null : estAt(id, pct) },
      }).message.body;

    test("BRENT clause appears past its cut, glued ↓bias token, dated at the future close (BZ=F)", () => {
      const cut = estimatorOf("BRENT", "carry-log").cutPct;
      const over = cut + 0.5;
      const value = (100 * (1 + over / 100)).toFixed(2);
      expect(body("BRENT", over)).toContain(`est. ${value}↓bias today (+${over.toFixed(2)}%, BZ=F)`);
      // Down direction carries the same token and a signed negative delta.
      const downVal = (100 * (1 - over / 100)).toFixed(2);
      expect(body("BRENT", -over)).toContain(`est. ${downVal}↓bias today (-${over.toFixed(2)}%, BZ=F)`);
    });

    test("G1 clause appears past its cut with NO bias token, off CL=F", () => {
      const cut = estimatorOf("G1", "carry-log").cutPct;
      const over = cut + 0.5;
      const value = (50 * (1 + over / 100)).toFixed(2);
      expect(body("G1", over)).toContain(`est. ${value} today (+${over.toFixed(2)}%, CL=F)`);
      expect(body("G1", over)).not.toContain("bias");
    });

    test("absent when the estimate is null (feed degrade), each id", () => {
      for (const id of ["BRENT", "G1"] as const) expect(body(id, null)).not.toContain("est.");
    });

    test("R12: a GREEN BRENT past its cut SURFACES its line; a GREEN BRENT inside the cut stays omitted", () => {
      const cut = estimatorOf("BRENT", "carry-log").cutPct;
      const surfaced = body("BRENT", cut + 0.5, "GREEN");
      expect(surfaced).toContain("BRENT:");
      expect(surfaced).toContain("est.");
      const omitted = body("BRENT", cut - 0.5, "GREEN");
      expect(omitted).not.toContain("BRENT:");
      expect(omitted).toContain("all 1 GREEN");
    });

    // Run-path wiring — the cheapest seam that proves oilEst reaches the push is `assembleRun`
    // (run-core threads it to buildNotification). run-cycle's fetch/compute is IO, tested no deeper.
    test("wiring: oilEst threaded through assembleRun surfaces on the push body", () => {
      const cut = estimatorOf("G1", "carry-log").cutPct;
      const r = assembleRun({
        readings: [oilReading("G1", "GREEN")],
        last: mkLast("OK"),
        lastPush: mkLast("OK"),
        now: "2026-06-27T22:00:00.000Z",
        oilEst: { G1: estAt("G1", cut + 0.5) },
      });
      expect(r.notification.message.body).toContain(`, CL=F)`);
    });

    test("a G1 head GREEN→RED under oil's own cut rides the head clause on the G1 line", () => {
      const cut = estimatorOf("G1", "carry-log").cutPct;
      const b = buildNotification(mkLast("OK"), "WARNING", undefined, undefined, [oilReading("G1", "GREEN")], "2026-06-26", {
        oilEst: { G1: { ...estAt("G1", cut / 2), state: "RED" } },
      }).message.body;
      expect(b.split("\n").find((l) => l.startsWith("G1: "))).toMatch(/ · est\. [\d.]+ \(RED\)$/);
      expect(b).not.toContain("CL=F"); // oil's own clause stays under its cut
    });
  });

  // A notify-dial estimate head carries an `est.` clause only where its OWN state is not its print's — never the panel's held state.
  describe("notify-dial estimate-head clause", () => {
    const R2 = ALL_INDICATORS.find((i) => i.id === "R2")!;
    const print = (indicator: Indicator, state: State): Reading => ({ ...notifyReading(indicator.id, indicator.channel, state), indicator, level: 4.5 });
    const head = (state: State): OilNowcast => ({ date: "2026-06-26", value: 4.75, fromDate: "2026-06-25", state });
    const body = (main: Reading, global: Reading, heads: Record<string, State>, scored: Record<string, State> = heads) =>
      buildNotification(mkLast("OK"), "WARNING", undefined, computeFamilyPanel(Object.entries(scored).map(([id, state]) => ({ id, state })), DIAL_FAMILIES).families, [main], "2026-06-26", {
        oilEst: Object.fromEntries(Object.entries(heads).map(([id, s]) => [id, head(s)])),
        globalReadings: [global],
      }).message.body;
    const lineOf = (b: string, ind: Indicator) => b.split("\n").find((l) => l.startsWith(`${ind.label}: `));

    test("a head scored past its print's state rides that member's line — a GREEN GLOBAL print surfaces to carry it", () => {
      const b = body(print(R2, "GREEN"), print(ESTR, "GREEN"), { R2: "AMBER", ESTR: "RED" });
      expect(lineOf(b, R2)).toMatch(/ \(GREEN\) · .* · est\. 4\.75% \(AMBER\)$/);
      expect(lineOf(b, ESTR)).toMatch(/ \(GREEN\) · .* · est\. 4\.75% \(RED\)$/);
    });

    test("a head at its print's state adds no clause, and a GREEN GLOBAL print stays off the body", () => {
      const b = body(print(R2, "AMBER"), print(ESTR, "GREEN"), { R2: "AMBER", ESTR: "GREEN" });
      expect(lineOf(b, R2)).toBeDefined(); // premise: the line the clause would ride is rendered
      expect(b).not.toContain("est.");
      expect(lineOf(b, ESTR)).toBeUndefined();
    });

    test("a held-RED member whose print AND head are GREEN adds no clause", () => {
      const b = body(print(R2, "AMBER"), print(ESTR, "GREEN"), { R2: "AMBER", ESTR: "GREEN" }, { R2: "AMBER", ESTR: "RED" });
      expect(lineOf(b, R2)).toBeDefined(); // premise: the body renders
      expect(b).not.toContain("est.");
    });
  });

  // I7 / E-a — each elevated tier carries its calm, graduated GUIDANCE line; OK carries
  // none (OK never pushes). N5: the binary "to-cash" / "all-or-nothing" negations are gone.
  test("T17: each elevated tier carries a calm GUIDANCE line; OK carries none", () => {
    const bodyFor = (level: AlertLevel, driver: State) =>
      buildNotification(
        mkLast("OK"),
        level,
        undefined,
        undefined,
        [notifyReading("F1", "FIN", driver)],
        "2026-06-26",
      ).message.body;
    expect(bodyFor("WATCH", "RED")).toContain("risk is elevating one notch");
    expect(bodyFor("WARNING", "RED")).toContain("graduated trim");
    expect(bodyFor("CRITICAL", "RED")).toContain("steady and mechanical");
    expect(bodyFor("WARNING", "RED")).not.toContain("to-cash");
    expect(bodyFor("CRITICAL", "RED")).not.toContain("all-or-nothing");
    expect(bodyFor("OK", "GREEN")).not.toContain("Guidance:");
  });

  // W5-a Stage 4.1 (UD-3 = (b) FOLDED LINE). These are the ONLY coverage the overlay's notify line
  // has: `sim:notify` is structurally blind to it (every world is a single synthesized close with no
  // rung history, so the stateful acceleration trigger prints `off` in all 15 worlds and always
  // will — see `.claude/rules/research-probes.md`). A green sim is therefore ZERO evidence here, and
  // the ACCEPT case below is what keeps the suite from passing against a renderer that no-ops.
  const overlayBody = (
    cashOverlay: { level: "off" | "partial"; reason: string } | undefined,
    r4Phase?: R4Phase,
    equityPct?: number | null,
  ) =>
    buildNotification(
      mkLast("OK"),
      "WARNING",
      undefined,
      undefined,
      [notifyReading("F1", "FIN", "RED")],
      "2026-06-26",
      {
        cashOverlay,
        // Stage 4.2: the option is the whole `R4Result` (`resolveCash`'s input), not the phase.
        // `cash` tracks `phase === "cash"` — the premise `cash-precedence-parity.test.js` pins.
        r4: r4Phase
          ? { cash: r4Phase === "cash", phase: r4Phase, entryFiredAt: null, reentryRung: null, reason: "test r4" }
          : undefined,
        equityPct,
      },
    ).message;

  test("T18: an ACTIVE cash overlay appends its heads-up line, with its reason", () => {
    const active = { level: "partial" as const, reason: "target rung 2→4 (+2) within 2 closes" };
    // No posture supplied ⇒ the DEGRADED case, where "not yet sized" is now literally true.
    expect(overlayBody(active).body).toContain(
      "Cash overlay: partial - heads-up only, not yet sized (target rung 2→4 (+2) within 2 closes)",
    );
    // Sized (Stage 4.2): the standing non-equity scalar, `100 - equityPct`.
    expect(overlayBody(active, undefined, 70).body).toContain(
      "Cash overlay: partial - heads-up only, 30% cash (target rung 2→4 (+2) within 2 closes)",
    );
    // ⚠ `Full` posture ⇒ equityPct 100 ⇒ nonEquityPct 0, which is FALSY but a real size. A
    // truthiness branch would print the degraded copy here.
    // E10b (2026-07-26): zero also carries its own words on the PUSH, mirroring the /lab chip — a
    // lone `0%` read as an unfilled field. The 30% pin above is what keeps the clause zero-only.
    expect(overlayBody(active, undefined, 100).body).toContain(
      "Cash overlay: partial - heads-up only, fully invested - 0% cash (target rung 2→4 (+2) within 2 closes)",
    );
    // The line stays a heads-up: sized or not, it must never read as a position instruction.
    expect(overlayBody(active, undefined, 70).body).not.toMatch(/go to cash|sell|raise \d/i);
  });

  test("T20: the folded line changes no tag, title or priority, and never doubles R4's cash claim", () => {
    const active = { level: "partial" as const, reason: "target rung 2→4 (+2) within 2 closes" };
    const off = overlayBody(undefined);
    const on = overlayBody(active);
    expect(off.body).not.toContain("Cash overlay");
    expect([on.title, on.tags, on.priority]).toEqual([off.title, off.tags, off.priority]);
    // Mirrors `resolveCash`: R4 `cash` is TOTAL (subsumes any partial) and `reentry` is walking back
    // onto the ladder — in both, R4 is the single cash voice and the overlay stays silent.
    expect(overlayBody(active, "cash").body).not.toContain("Cash overlay");
    expect(overlayBody(active, "reentry").body).not.toContain("Cash overlay");
    // An on-ladder (equity) R4 leaves the overlay free to speak — no contradiction to suppress.
    expect(overlayBody(active, "equity").body).toContain("Cash overlay: partial");
  });
});

describe("assembleRun (pure scoring-cycle core, P9)", () => {
  // F1 RED + F2 AMBER (Σ rank 3 ≥ warn 3, < crit 4) → WARNING from the financing channel
  // alone. Post Stage-D crit 6→4, two FIN Reds now sum to fin 4 = CRITICAL, so the WARNING
  // baseline uses one RED + one AMBER; one GREEN coincident keeps the modifier off.
  const warningReadings = (): Reading[] => [
    notifyReading("F1", "FIN", "RED"),
    notifyReading("F2", "FIN", "AMBER"),
    notifyReading("R5", "COINCIDENT", "GREEN"),
  ];
  const NOW = "2026-06-27T22:00:00.000Z";

  test("dial-less band = escalatorFloor; legacy verdict columns carry neutral sentinels", () => {
    const r = assembleRun({ readings: warningReadings(), last: mkLast("OK"), lastPush: mkLast("OK"), now: NOW });
    // F1 confirmed RED trips the credit-blowout escalator. This is the DIAL-LESS path, so
    // `fired` is passed false (fail-safe — no dial ⇒ the FIRE key can't be confirmed) ⇒ the
    // W3-d unfired tier ⇒ WARNING floor, not CRITICAL (alert-band.ts).
    expect(r.alert.level).toBe("WARNING");
    // The reason must survive the re-tier: still the credit escalator, one tier lower.
    expect(r.alert.bandReason).toBe("floor:credit");
    // Legacy NOT-NULL verdict columns — neutral constants (column drop is DDL, Stage-3 gate).
    expect(r.alert.fin).toBe(0);
    expect(r.alert.rate).toBe(0);
    expect(r.alert.geoFlags).toBe(0);
    expect(r.alert.coincident).toBe("GREEN");
    expect(r.alert.finReds).toBe(0);
  });

  test("slow tier: a degraded run between two ELEVATED runs stays silent (lastSlowBand baseline, 2026-06-28 regression)", () => {
    const elevated: SlowVerdict = {
      band: "ELEVATED",
      score: 2,
      activeCount: 2,
      maxScore: 4,
      ratio: 0.5,
      components: [
        { id: "price-accel", label: "Price acceleration", score: 1 },
        { id: "complacency", label: "Complacency", score: 1 },
      ],
    };
    // A ScoredTrack for the slow tier, sealing `elevated` into the notify projection —
    // the shape tracks.ts's slowTrack.score() produces (the test omits the bottom/pension
    // tracks, so their alert fields stay null and their notifications stay silent).
    const slowScored: ScoredTrack = {
      baselineField: "slowBand",
      rows: [],
      alertFields: { slowScore: elevated.score, slowBand: elevated.band, slowMaxScore: elevated.maxScore },
      storedSeries: () => new Map(),
      notification: (lastBand, asOf) => buildTierNotification(SLOW_TIER, lastBand as SlowBand | null, elevated, asOf),
      consoleLine: "",
    };
    // Prior REAL band was ELEVATED; an intervening degraded run persisted null, which
    // getLastBand("slowBand") skips → baseline ELEVATED → no re-fire. (Reading last.slowBand
    // would have collapsed the null to CALM and re-pushed — the original bug.)
    const held = assembleRun({ readings: warningReadings(), last: mkLast("OK"), lastPush: mkLast("OK"), now: NOW, geoFlags: 0, scored: [slowScored], lastBands: ["ELEVATED"] });
    expect(held.slowNotification.push).toBe(false);
    // First-ever elevation (no prior real band) still pushes once.
    const first = assembleRun({ readings: warningReadings(), last: mkLast("OK"), lastPush: mkLast("OK"), now: NOW, geoFlags: 0, scored: [slowScored], lastBands: [null] });
    expect(first.slowNotification.push).toBe(true);
  });

  // Minimal slow ScoredTrack at a given band (bubble-arming K5 fixture below).
  const mkSlowTrack = (band: SlowBand | null): ScoredTrack => ({
    baselineField: "slowBand",
    rows: [],
    alertFields: { slowScore: band === null ? null : 1, slowBand: band, slowMaxScore: band === null ? null : 4 },
    storedSeries: () => new Map(),
    notification: () => ({ push: false, message: null }),
    consoleLine: "",
  });

  test("K5: the scored slow band persists onto the alert row; degraded/absent track keeps null", () => {
    const base = { readings: warningReadings(), last: mkLast("OK"), lastPush: mkLast("OK"), now: NOW, geoFlags: 0 };
    const elevated = mkSlowTrack("ELEVATED");
    const r = assembleRun({ ...base, scored: [elevated], lastBands: [null] });
    expect("slowBand" in elevated.alertFields && r.alert.slowBand === elevated.alertFields.slowBand).toBe(true);
    const degraded = assembleRun({ ...base, scored: [mkSlowTrack(null)], lastBands: [null] });
    expect(degraded.alert.slowBand).toBeNull();
    const trackless = assembleRun({ ...base });
    expect(trackless.alert.slowBand).toBeNull();
  });

  test("trackStoredReadings folds EVERY scored track's rows - the bottom-track persist-freeze guard", () => {
    // Regression for the frozen-VIX3M-sparkline bug: the bottom track was wired for
    // notify + `storedSeries(asOf)` but its persist rows were dropped from a hardcoded
    // slow/pension list, so the daily cron never advanced the bottom VIX/VIX3M series.
    // The generic fold over `scored` must carry EVERY track's rows into the persisted
    // set; a revert to a hardcoded pair drops VIX/VIX3M and fails here.
    const row = (indicatorId: string): StoredReading => ({
      date: "2026-06-26",
      indicatorId,
      value: 1,
      delta20: 0,
      rawState: "GREEN",
      state: "GREEN",
    });
    const mkTrack = (
      baselineField: ScoredTrack["baselineField"],
      alertFields: ScoredTrack["alertFields"],
      ids: string[],
    ): ScoredTrack => ({
      baselineField,
      rows: [],
      alertFields,
      storedSeries: () => new Map(ids.map((id) => [id, [row(id)]])),
      notification: () => ({ push: false, message: null }),
      consoleLine: "",
    });
    const scored: ScoredTrack[] = [
      mkTrack("slowBand", { slowScore: null, slowBand: null, slowMaxScore: null }, ["price-accel"]),
      mkTrack("bottomState", { bottomState: null, vix: null, vix3m: null, ratio: null }, ["VIX", "VIX3M"]),
    ];
    const r = assembleRun({
      readings: warningReadings(),
      last: mkLast("OK"),
      lastPush: mkLast("OK"),
      now: NOW,
      geoFlags: 0,
      scored,
      lastBands: [null, null, null],
    });
    const ids = r.trackStoredReadings.map((sr) => sr.indicatorId);
    // The bottom legs — whose absence was the bug — must be persisted.
    expect(ids).toContain("VIX");
    expect(ids).toContain("VIX3M");
    // ...alongside every other track's rows, proving the fold is generic, not a pair.
    expect(ids).toEqual(expect.arrayContaining(["price-accel", "VIX", "VIX3M"]));
  });

  test("asOf is the newest reading date; firedAt is the injected now", () => {
    const r = assembleRun({ readings: warningReadings(), last: mkLast("OK"), lastPush: mkLast("OK"), now: NOW });
    expect(r.asOf).toBe("2026-06-26");
    expect(r.alert.date).toBe("2026-06-26");
    expect(r.alert.firedAt).toBe(NOW);
    // 2026-06-27 vs 2026-06-26 obs date → 1 day old, not stale.
    expect(r.freshness).toEqual({ lag: false, ageDays: 1, unit: "days" });
  });

  test("an upward change pushes and stamps pushedAt = now", () => {
    const r = assembleRun({ readings: warningReadings(), last: mkLast("OK"), lastPush: mkLast("OK"), now: NOW });
    expect(r.notification.push).toBe(true);
    expect(r.alert.pushedAt).toBe(NOW);
  });

  test("a same-level repeat (no re-assert) is silent and leaves pushedAt null", () => {
    // lastPush pushed yesterday → weekly re-assert not yet due, so a same-level
    // run stays silent (notify-on-change alone).
    // W3-d: warningReadings() now bands WARNING (unfired credit), so the fixtures must be
    // WARNING too — a CRITICAL baseline would make this a DOWNGRADE case and silently void
    // the "same-level repeat" subject while the assertion still passed.
    const lastPush = { ...mkLast("WARNING"), pushedAt: "2026-06-26T22:00:00.000Z" };
    const r = assembleRun({ readings: warningReadings(), last: mkLast("WARNING"), lastPush, now: NOW });
    expect(r.alert.level).toBe("WARNING"); // vacuity guard: it really is same-level
    expect(r.notification.push).toBe(false);
    expect(r.alert.pushedAt).toBeNull();
  });

  test("a same-level repeat past the re-assert interval fires and stamps pushedAt", () => {
    // lastPush pushed 8 days ago → weekly re-assert is due, so a same-level run
    // pushes even though notify-on-change alone would stay silent (exercises the
    // decideReassert path end-to-end through assembleRun).
    const lastPush = { ...mkLast("WARNING"), pushedAt: "2026-06-19T22:00:00.000Z" };
    const r = assembleRun({ readings: warningReadings(), last: mkLast("WARNING"), lastPush, now: NOW });
    // W3-d vacuity guard: pre-gate this world banded CRITICAL vs a WARNING baseline, so it
    // passed on the UPWARD-push path and never reached decideReassert — the test was vacuous.
    // At the unfired tier it is genuinely same-level, so the reassert path is really exercised.
    expect(r.alert.level).toBe("WARNING");
    expect(r.notification.push).toBe(true);
    expect(r.alert.pushedAt).toBe(NOW);
  });

  test("last run's push FAILED (push_error set) ⇒ a same-level repeat re-fires now (rank 1)", () => {
    // The prior WARNING push never delivered (push_error set, pushed_at null). Even though
    // the re-assert interval hasn't elapsed and notify-on-change is silent (same level), the
    // undelivered band must re-fire this run so the owner finally receives it.
    const last = { ...mkLast("WARNING"), pushError: "ntfy 503", pushedAt: null };
    const lastPush = { ...mkLast("WARNING"), pushedAt: "2026-06-25T22:00:00.000Z" }; // < 7d ago
    const r = assembleRun({ readings: warningReadings(), last, lastPush, now: NOW });
    expect(r.alert.level).toBe("WARNING"); // W3-d vacuity guard: genuinely same-level now
    expect(r.notification.push).toBe(true);
  });

  test("injected geoFlags feeds escalatorFloor - 2 manual flags raise the band to WARNING", () => {
    // All-Green readings: only the injected geo count can move the dial-less band.
    const greens = [notifyReading("F1", "FIN", "GREEN"), notifyReading("R5", "COINCIDENT", "GREEN")];
    const r = assembleRun({ readings: greens, last: mkLast("OK"), lastPush: mkLast("OK"), now: NOW, geoFlags: 2 });
    expect(r.alert.level).toBe("WARNING");
    // Rank 13: the REAL injected geoFlags is persisted on the row (was hardcoded 0), and the
    // band-reason names the deciding branch — a dial-less geo-floor run reads "floor:geo".
    expect(r.alert.geoFlags).toBe(2);
    expect(r.alert.bandReason).toBe("floor:geo");
    // Default (omitted) geoFlags stays 0 → OK; no dial + no floor ⇒ "no-dial".
    const calm = assembleRun({ readings: greens, last: mkLast("OK"), lastPush: mkLast("OK"), now: NOW });
    expect(calm.alert.level).toBe("OK");
    expect(calm.alert.geoFlags).toBe(0);
    expect(calm.alert.bandReason).toBe("no-dial");
  });

  test("injected crisisStage folds into the geo floor (Stage 4): stage 2 alone raises the dial-less band to WARNING", () => {
    // All-Green readings + 0 flags: only the declared stage can move the band. EXPECTED derived
    // from the exported mapping: stage 2 ≡ STAGE_TO_FLAGS[2] manual flags through the same floor.
    const greens = [notifyReading("F1", "FIN", "GREEN"), notifyReading("R5", "COINCIDENT", "GREEN")];
    const base = { readings: greens, last: mkLast("OK"), lastPush: mkLast("OK"), now: NOW };
    const staged = assembleRun({ ...base, crisisStage: 2 });
    expect(staged.alert.level).toBe(escalatorFloor(greens, STAGE_TO_FLAGS[2], "equity", false));
    expect(staged.alert.bandReason).toBe("floor:geo");
    // Omitted stage defaults to 0 — byte-identical to the pre-stage run.
    expect(assembleRun({ ...base }).alert.level).toBe("OK");
  });

  test("rank 13 band-reason: a dial run distinguishes regime (raw dial stands) from floor:geo (escalator lifts it)", () => {
    const greens = [notifyReading("F1", "FIN", "GREEN"), notifyReading("R5", "COINCIDENT", "GREEN")];
    // Stress dial, no floor, no prior-band lag ⇒ the raw regime→band (WARNING) stands: "regime".
    const regimeRun = assembleRun({
      readings: greens,
      last: mkLast("OK"),
      lastPush: mkLast("OK"),
      now: NOW,
      dial: makeDial({ rung: 5 }), // rung 5 ⇒ dangerScore 0.5 ⇒ notify regime "Stress" (derived)
      globalFamilies: [],
    });
    expect(regimeRun.alert.level).toBe("WARNING");
    expect(regimeRun.alert.dialBand).toBe("WARNING");
    expect(regimeRun.alert.bandReason).toBe("regime");
    // Same calm dial, but 2 geo flags floor the band to WARNING ABOVE the raw dial (OK) ⇒ "floor:geo".
    const floorRun = assembleRun({
      readings: greens,
      last: mkLast("OK"),
      lastPush: mkLast("OK"),
      now: NOW,
      geoFlags: 2,
      dial: makeDial(), // rung 1 ⇒ "Calm" (derived)
      globalFamilies: [],
    });
    expect(floorRun.alert.level).toBe("WARNING");
    expect(floorRun.alert.dialBand).toBe("OK");
    expect(floorRun.alert.bandReason).toBe("floor:geo");
    expect(floorRun.alert.geoFlags).toBe(2);
  });

  test("consoleLines = one line per reading + a summary line, and the summary matches the notification body (single formatter, no drift)", () => {
    const readings = warningReadings();
    const r = assembleRun({ readings, last: mkLast("OK"), lastPush: mkLast("OK"), now: NOW });
    expect(r.consoleLines).toHaveLength(readings.length + 1);
    const summaryLine = r.consoleLines.at(-1)!;
    expect(summaryLine).toContain(`· as of ${r.asOf}`);
    // The summary (minus the "as of" suffix) is the exact string the notification
    // body embeds — proves both render through formatRunSummary.
    const summary = summaryLine.replace(` · as of ${r.asOf}`, "");
    expect(r.notification.message.body).toContain(summary);
  });


  // R4 cash-breaker wiring (Stage 3.1): assembleRun builds the R4 prior from `last`'s
  // persisted r4 columns, reads the tail levels from THIS run's F1/VT readings, runs the
  // pure computeR4 with the injected `dial`, and overwrites the 3 r4 alert columns. The leaf
  // logic itself is unit-tested in r4.test.ts; these pin the WIRING + the dial-less fail-safe.
  // F1 level = HY-OAS %, VT level = VIX/VIX3M ratio — the two tail reads the ENTER/EXIT gates need.
  const r4Readings = (hyOas: number, vt: number): Reading[] => [
    { ...notifyReading("F1", "FIN", "RED"), level: hyOas },
    { ...notifyReading("VT", "COINCIDENT", "GREEN"), level: vt },
    notifyReading("R5", "COINCIDENT", "GREEN"),
  ];

  test("R4: a deep dial + F1 tail + prior equity enters cash on ONE close and stamps r4EntryFiredAt (dial + F1 level + prior all wired)", () => {
    // Enter-gate met: targetRung 8 (≥ R4_ENTER_RUNG), 2+1 firing families (≥ R4_ENTER_FAMILIES),
    // F1 = 9.0 ≥ R4_HY_TAIL (VT 1.0 < R4_VT_TAIL, so ONLY F1 supplies the tail — pins the F1 read).
    // The dial + F1 reads are pinned by the ENTRY half: were the dial not read the rung/breadth
    // conditions fail, and were F1's level not read the tail is un-met — either way this close
    // stays `equity` instead of entering.
    const r = assembleRun({
      readings: r4Readings(9.0, 1.0),
      last: { ...mkLast("OK"), r4Phase: "equity" },
      lastPush: mkLast("OK"),
      now: NOW,
      dial: makeDial({ targetRung: 8, leadingFiring: 2, coincidentFiring: 1 }),
    });
    expect(r.alert.r4Phase).toBe("cash");
    expect(r.alert.r4EntryFiredAt).toBe(NOW); // ratchet clock anchored to this close
    expect(r.alert.r4ReentryRung).toBeNull();

    // The PRIOR read needs its own discriminating fixture now that NF-1(A) makes `equity` and the
    // no-prior default agree on an entering close: the same close against a prior ALREADY in cash
    // must CARRY that entry stamp, not re-stamp it. Were `last.r4Phase` ignored, this would take
    // the equity→cash arm above and print NOW.
    const earlier = "2026-07-01T00:00:00.000Z";
    const held = assembleRun({
      readings: r4Readings(9.0, 1.0),
      last: { ...mkLast("OK"), r4Phase: "cash", r4EntryFiredAt: earlier },
      lastPush: mkLast("OK"),
      now: NOW,
      dial: makeDial({ targetRung: 8, leadingFiring: 2, coincidentFiring: 1 }),
    });
    expect(held.alert.r4Phase).toBe("cash");
    expect(held.alert.r4EntryFiredAt).toBe(earlier);
  });

  test("R4: a receded dial from prior cash exits into a laddered re-entry (reentryRung written, entryFiredAt cleared)", () => {
    // targetRung 3 ≤ R4_EXIT_RUNG ⇒ exit fires; the stay is short (entryFiredAt ~now) so no ratchet
    // snap ⇒ begin re-entry at R4_REENTRY_START. Proves the result's reentryRung/entryFiredAt (not
    // just r4Phase) flow through to the alert columns, and that prior.phase "cash" was rehydrated.
    const r = assembleRun({
      readings: r4Readings(5.0, 0.9),
      last: { ...mkLast("OK"), r4Phase: "cash", r4EntryFiredAt: NOW },
      lastPush: mkLast("OK"),
      now: NOW,
      dial: makeDial({ targetRung: 3 }),
    });
    expect(r.alert.r4Phase).toBe("reentry");
    expect(r.alert.r4ReentryRung).toBe(R4_REENTRY_START);
    expect(r.alert.r4EntryFiredAt).toBeNull();
  });

  test("R4 fail-safe: a dial-less run leaves the 3 r4 columns null even with a cash prior + tail readings", () => {
    // The `if (dial)` guard: no dial ⇒ computeR4 never runs ⇒ the literal-null columns stand,
    // regardless of prior state or tail levels. Pure-logic tests / a degraded run (no families
    // panel) take this path — R4 can never fire without the danger dial.
    const r = assembleRun({
      readings: r4Readings(9.0, 1.2),
      last: { ...mkLast("OK"), r4Phase: "cash", r4EntryFiredAt: NOW },
      lastPush: mkLast("OK"),
      now: NOW,
    });
    expect(r.alert.r4Phase).toBeNull();
    expect(r.alert.r4EntryFiredAt).toBeNull();
    expect(r.alert.r4ReentryRung).toBeNull();
  });

  describe("de-risk rotation (M5/M8)", () => {
    // Basis epoch (W6 Addendum E-2): a prior row dated BEFORE `RERISK_BASIS_EPOCH` has its streak
    // read as 0 (a pre-remap streak isn't cashable under the new RERISK_DEADBAND). Dates are DERIVED
    // from the constant (setup only), so a retune of the epoch moves them with it.
    const EPOCH_DAY = RERISK_BASIS_EPOCH; // prior row: earliest non-stale date (`<` is strict)
    const CLOSE_DAY = new Date(Date.parse(`${EPOCH_DAY}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const POST_EPOCH_NOW = `${CLOSE_DAY}T22:00:00.000Z`;
    // Re-dated readings ⇒ asOf = CLOSE_DAY > prior date ⇒ this run sees a NEW close (dwell ticks).
    const reriskReadings = (): Reading[] => warningReadings().map((r) => ({ ...r, date: CLOSE_DAY }));
    const lastHeld = (sleeve: string): AlertRecord => ({
      ...mkLast("OK"),
      date: EPOCH_DAY,
      heldSleeve: sleeve,
      reriskConfirmCount: 0,
      // A banked dwell ledger, pre-clearing NOTHING: `RERISK_DWELL_DAYS` is 0 since 2026-08-07, so
      // there is no streak gate and no dwell gate left for a fixture to satisfy. The gate arithmetic
      // that DOES still exist — the frozen legacy pair behind `decideRotationHold`'s `gates` seam — is
      // pinned in rotation-commit.test.ts.
      heldDays: 10,
    });

    test("de-risk (rising danger) rotates to the more-defensive leg immediately - no confirm gate", () => {
      // prev held = Semis (rung 1); a deep band {lo:6,hi:9} rises the target far above rung 1 ⇒ de-risk.
      // The move is to a MORE-defensive leg (ex-US, rung 6 = in-band min risk) ⇒ un-gated, commits on
      // this single close, counter stays 0.
      const r = assembleRun({
        readings: reriskReadings(),
        last: lastHeld("Semis"),
        lastPush: mkLast("OK"),
        now: POST_EPOCH_NOW,
        dial: makeDial({ rung: 9 }, { leaderSplit: 1 }), // ⇒ band {lo:6,hi:9}, derived
        globalFamilies: [],
      });
      expect(r.alert.heldSleeve).toBe("ex-US");
      expect(r.alert.reriskConfirmCount).toBe(0);
    });
  });
});

// Card-less CONTEXT exclusion (2026-08-11 `[USER]`) — the VTP body-exclusion generalized: a CONTEXT
// id with no card group (`cardGroupOf` undefined) is invisible on the board, so it must not print in
// a push. The display-only arm extends it to carded ids outside every pillar: NVDA (carded now) and
// MU_RS are its live members; VT (CONTEXT, carded) is the vacuity control.
describe("card-less and display-only CONTEXT ids never reach the push body", () => {
  const red = (ind: Indicator): Reading => ({
    indicator: ind,
    date: "2026-06-26",
    level: 1,
    delta20: 0,
    rawState: "RED",
    state: "RED",
  });
  const body = (readings: Reading[]) =>
    buildNotification(null, "WARNING", undefined, undefined, readings, "2026-06-26").message.body;

  test("a RED NVDA (carded, weighted, outside every pillar) prints no driver line; a VT control does", () => {
    expect(body([red(VT)])).toContain(VT.label); // vacuity guard: the filter is an exclusion, not a dead body
    expect(body([red(NVDA)])).not.toContain(NVDA.label);
    // Byte-identical with and without — not a line, not an omitted-count entry.
    expect(body([red(VT), red(NVDA)])).toBe(body([red(VT)]));
  });

  test("a RED display-only (carded, familyless, no pillar) CONTEXT reading prints no driver line", () => {
    expect(body([red(KBE_RS)])).toContain(KBE_RS.label); // control: weighted CONTEXT still prints
    expect(body([red(MU_RS)])).not.toContain(MU_RS.label);
    expect(body([red(KBE_RS), red(MU_RS)])).toBe(body([red(KBE_RS)]));
  });

  test("a stale display-only NVDA leg prints no lagging-legs entry either", () => {
    const leg = (ind: Indicator) => ({ id: ind.id, label: ind.label, ageDays: 16, cadence: "daily" as const });
    const bodyWith = (legs: ReturnType<typeof leg>[]) =>
      buildNotification(null, "WARNING", undefined, undefined, [], "2026-06-26", { verdictHoldLegs: legs })
        .message.body;
    expect(bodyWith([leg(VT)])).toContain(`${VT.label} (16d)`); // vacuity guard
    expect(bodyWith([leg(NVDA)])).not.toContain("NVDA");
    expect(bodyWith([leg(VT), leg(NVDA)])).toBe(bodyWith([leg(VT)]));
  });
});
