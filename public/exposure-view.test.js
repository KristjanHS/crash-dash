// Pure-logic test (no jsdom) over the exposure-view seam that exposure.js paints.
// Pins the projection ExposureResponse → view models: posture text/tone,
// ARM/FIRE chip tones + detail readouts, the PER-CHIP asOf date (R10), and the
// load-bearing invariant that a degraded response never renders as a confident Core.
import { describe, it, expect } from "vitest";
import {
  renderPosture,
  armChipModel,
  fireChipModel,
  asOfLabel,
  exposureViewModel,
  defaultEpisodeId,
  POSTURE_TONE,
} from "./exposure-view.js";
import {
  EQUITY_PCT,
  EXPOSURE_THRESHOLDS,
  FIRE_MA_APPROACH_SPREAD,
  ARM_ROC_APPROACH_BP,
  ARM_LEVEL_PCT,
  ARM_RANGE_WINDOW,
  ARM_RELEASE_PCT,
  ARM_ROC_BP,
  ARM_ROC_WINDOW,
  computeExposure,
} from "../src/exposure.ts";
import { GT } from "../src/registry-composite.ts";
import { resolvedDerivedBands, scoreDerivedDecision } from "../src/scorers-core.ts";

/** GT's resolved amber cut — the band FIRE consumes since CORE-B4. */
const GT_CUT = resolvedDerivedBands(GT).amber;

// A live "Core" response. A fully quiet book is `Full`; `Core` is reachable only
// with ONE key approaching — here FIRE, and not by choice: every DERIVED flag below is
// computed from the same cut the engine uses, so the fixture stays a book prod can emit
// even if a cut moves.
// The two key dates deliberately DIFFER by a day, which the per-chip dates exist to expose.
const ARM_ROC = 0.02;
const FIRE_SPREAD = GT_CUT + FIRE_MA_APPROACH_SPREAD / 2;
const core = {
  posture: "Core",
  equityPct: EQUITY_PCT.Core,
  arm: {
    armed: false,
    approaching: ARM_ROC >= ARM_ROC_APPROACH_BP,
    degraded: false,
    level: 3.1,
    percentile: 0.34,
    roc: ARM_ROC,
    asOf: "2026-07-23",
  },
  fire: {
    fired: scoreDerivedDecision(GT, FIRE_SPREAD) !== "GREEN",
    approaching: FIRE_SPREAD <= GT_CUT + FIRE_MA_APPROACH_SPREAD,
    degraded: false,
    maSpread: FIRE_SPREAD,
    asOf: "2026-07-24",
  },
  summary: "credit calm (34th pct, +2bp/30d); trend clear of GT's cut -> Core (70% equity)",
  asOf: "2026-07-24",
  // R1: the cuts ride the wire. Taken from the engine's own bundle —
  // a hand-typed block here would be a second source and could not see the two disagree.
  thresholds: EXPOSURE_THRESHOLDS,
};

// Expected tone per posture, pinned out-of-band (a tone derived from renderPosture would be circular).
const EXPECTED_TONE = { Full: "full", Core: "core", Reduced: "reduced", Defensive: "defensive" };

describe("renderPosture", () => {
  // Drift tripwire over the browser-side POSTURE_TONE mirror: the browser cannot import
  // the TS union, so nothing but this links the two. Both directions — ADDED upstream
  // (would otherwise fall through to "Warming up" silently) and REMOVED upstream (would
  // leave a dead key). Verified red by adding a fifth key to EQUITY_PCT.
  it("mirrors EQUITY_PCT's key set exactly", () => {
    expect(Object.keys(POSTURE_TONE).sort()).toEqual(Object.keys(EQUITY_PCT).sort());
  });

  it("renders every posture in EQUITY_PCT - own label/tone/weight, never a warming fallthrough", () => {
    for (const [posture, pct] of Object.entries(EQUITY_PCT)) {
      const m = renderPosture({ posture, equityPct: pct });
      expect(m.tone, `posture ${posture} tone`).toBe(EXPECTED_TONE[posture]);
      expect(m.label).toBe(posture);
      expect(m.detail).toBe(`${pct}% equity`);
    }
  });

  it("null posture renders 'Warming up', never a fabricated Core", () => {
    expect(renderPosture({ posture: null })).toEqual({
      label: "Warming up",
      tone: "warming",
      detail: "",
    });
    expect(renderPosture({})).toEqual({ label: "Warming up", tone: "warming", detail: "" });
  });

  it("a known posture with a missing equityPct renders no weight, never '0% equity'", () => {
    expect(renderPosture({ posture: "Core" })).toEqual({
      label: "Core",
      tone: "core",
      detail: "",
    });
  });
});

describe("armChipModel", () => {
  it("quiet: unarmed, healthy → tone quiet with percentile + ROC readout", () => {
    // toMatchObject, not toEqual: the R1 footnote keys (what/cuts/why) ride every chip model
    // and are pinned in their own describe below, key-set included.
    expect(armChipModel(core)).toMatchObject({
      label: "ARM: credit",
      tone: "quiet",
      // The ROC window is the SERVED `armRocWindow`, not a literal — see the R1 falsifier below.
      detail: `34th pct · +${Math.round(ARM_ROC * 100)}bp/${ARM_ROC_WINDOW}d`,
      asOf: "as of 2026-07-23",
    });
  });

  it("armed: armed key → tone armed, negative ROC formatted", () => {
    const m = armChipModel({
      arm: { armed: true, degraded: false, level: 6, percentile: 0.92, roc: -0.03 },
      thresholds: EXPOSURE_THRESHOLDS,
    });
    expect(m.tone).toBe("armed");
    expect(m.detail).toBe(`92nd pct · -3bp/${ARM_ROC_WINDOW}d`);
  });

  it("approaching: pre-alert tier → tone approaching", () => {
    const m = armChipModel({
      arm: { armed: false, degraded: false, approaching: true, percentile: 0.71, roc: 0.31 },
      thresholds: EXPOSURE_THRESHOLDS,
    });
    expect(m.tone).toBe("approaching");
    expect(m.detail).toBe(`71st pct · +31bp/${ARM_ROC_WINDOW}d`);
  });

  it("degraded: too little F1 history → tone degraded, never quiet", () => {
    expect(
      armChipModel({ arm: { armed: false, degraded: true, percentile: null, roc: null, asOf: "2026-07-23" } }),
    ).toMatchObject({
      label: "ARM: credit",
      tone: "degraded",
      detail: "data insufficient",
      asOf: "as of 2026-07-23",
    });
  });

  it("flat window / null ROC fall back to honest labels", () => {
    expect(armChipModel({ arm: { armed: false, degraded: false, percentile: null, roc: null } }).detail).toBe(
      "flat window · ROC n/a",
    );
  });
});

describe("fireChipModel", () => {
  it("intact: cushion clear of GT's cut → tone intact with % vs MA200", () => {
    // `core`'s own maSpread sits inside GT's amber + FIRE_MA_APPROACH_SPREAD — that is what
    // makes it Core — so an intact book needs a spread clear of the PRE-ALERT edge
    // (GT's resolved amber + FIRE_MA_APPROACH_SPREAD), derived from the cuts rather than
    // typed: a hand-set 0.081 sat INSIDE the edge and pinned a book the engine cannot emit.
    const intactSpread = GT_CUT + FIRE_MA_APPROACH_SPREAD + 0.01;
    expect(
      fireChipModel({ ...core, fire: { ...core.fire, approaching: false, maSpread: intactSpread } }),
    ).toMatchObject({
      label: "FIRE: trend",
      tone: "intact",
      detail: `+${(intactSpread * 100).toFixed(1)}% vs MA200`,
      asOf: "as of 2026-07-24",
    });
  });

  it("broken: fired (GT's band non-GREEN) → tone broken, negative spread", () => {
    const m = fireChipModel({ fire: { fired: true, degraded: false, maSpread: -0.081 } });
    expect(m.tone).toBe("broken");
    expect(m.detail).toBe("-8.1% vs MA200");
  });

  it("approaching: spread inside the pre-alert margin → tone approaching", () => {
    const m = fireChipModel({
      fire: { fired: false, degraded: false, approaching: true, maSpread: 0.021 },
    });
    expect(m.tone).toBe("approaching");
    expect(m.detail).toBe("+2.1% vs MA200");
  });

  it("withheld spread (served body, 3.5b): maSpread null on a live key keeps the tone and prints n/a", () => {
    const m = fireChipModel({ fire: { fired: false, degraded: false, approaching: false, maSpread: null, asOf: "2026-11-24" } });
    expect([m.tone, m.detail, m.asOf]).toEqual(["intact", "n/a vs MA200", "as of 2026-11-24"]);
  });

  it("degraded: missing GT decision → tone degraded, never intact", () => {
    expect(fireChipModel({ fire: { fired: false, degraded: true, maSpread: null, asOf: null } })).toMatchObject({
      label: "FIRE: trend",
      tone: "degraded",
      detail: "data missing",
      asOf: "as of -",
    });
  });
});

describe("chip footnotes (R1): what it is / which thresholds / why only these metrics", () => {
  // THE FALSIFIER the rung owes. Every number in the threshold line is read off the ENGINE's
  // constants here and must appear in the rendered text — so retuning a cut in src/exposure.ts
  // and leaving a stale literal in public/ goes red instead of shipping a wrong number on a
  // notify-visible surface (the drift class armMetricsAt's docblock records).
  it("ARM's threshold line prints every ARM cut, straight off the engine's constants", () => {
    const cuts = armChipModel(core).cuts;
    for (const [name, shown] of [
      ["ARM_LEVEL_PCT", `${Math.round(ARM_LEVEL_PCT * 100)}`],
      ["ARM_RANGE_WINDOW", `${ARM_RANGE_WINDOW}-day`],
      ["ARM_ROC_BP", `+${Math.round(ARM_ROC_BP * 100)}bp`],
      ["ARM_ROC_WINDOW", `/${ARM_ROC_WINDOW}d`],
      ["ARM_RELEASE_PCT", `${Math.round(ARM_RELEASE_PCT * 100)}`],
      ["ARM_ROC_APPROACH_BP", `+${Math.round(ARM_ROC_APPROACH_BP * 100)}bp`],
    ]) {
      expect(cuts, `${name} reaches the ARM footnote`).toContain(shown);
    }
  });

  // The falsifier's second half: the READOUT numbers, not just the
  // threshold line. `rocLabel` hardcoded `/30d` and `summarize` (src/exposure.ts) hardcoded
  // `bp/30d`, so a retune of ARM_ROC_WINDOW left two stale windows on a notify-visible surface
  // while the docblock claimed public/ held no numeric copy of a cut. Both sites now interpolate.
  it("the ARM readout and the served summary both carry the ENGINE's ROC window, not a literal", () => {
    // FE side: the chip detail reads the window off the served thresholds block.
    expect(armChipModel(core).detail).toContain(`bp/${ARM_ROC_WINDOW}d`);
    // Server side: the summary sentence the page and the push both print. Driven through the REAL
    // engine — a ramp long enough to have a ROC base, so the ROC term is a number, not "ROC n/a".
    const n = ARM_RANGE_WINDOW + ARM_ROC_WINDOW + 5;
    const day = (i) => new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    const f1 = Array.from({ length: n }, (_, i) => ({ date: day(i), value: 3 + i * 0.001 }));
    const gt = Array.from({ length: n }, (_, i) => ({ date: f1[i].date, value: 100 + i }));
    const summary = computeExposure(f1, gt).summary;
    expect(summary).toContain(`bp/${ARM_ROC_WINDOW}d`);
  });

  it("FIRE's threshold line prints the served pre-alert cushion and names GT's band as the fire edge", () => {
    const cuts = fireChipModel(core).cuts;
    expect(cuts).toContain(`${Math.round(FIRE_MA_APPROACH_SPREAD * 100)}pp`);
    // The fire edge itself is GT's RESOLVED band, not a constant — the copy must say so rather
    // than quote a number that does not exist on the wire.
    expect(cuts).toContain("GT's resolved band");
  });

  // The seam ruling's other half: public/ holds NO numeric copy. A payload without the served
  // block therefore renders an EMPTY threshold line — it can never fall back to typed literals.
  it("renders no threshold line at all when the response carries no thresholds block", () => {
    const noCuts = { ...core, thresholds: undefined };
    expect(armChipModel(noCuts).cuts).toBe("");
    expect(fireChipModel(noCuts).cuts).toBe("");
  });

  // ⚠ The rot-prone half (R1 round-2): the rationale explains the CHOICE OF METRIC and must
  // never restate a threshold's VALUE in words. Any digit in it is that restatement starting.
  it("the rationale lines carry no digits - they explain metric choice, never cut values", () => {
    expect(armChipModel(core).why).not.toMatch(/\d/);
    expect(fireChipModel(core).why).not.toMatch(/\d/);
  });

  it("both chips answer all three questions, in order, in every state", () => {
    for (const model of [
      armChipModel(core),
      fireChipModel(core),
      armChipModel({ arm: { degraded: true } }), // the copy is needed MOST when the data is out
      fireChipModel({ fire: { degraded: true } }),
    ]) {
      expect(model.what).toMatch(/^What it is: /);
      expect(model.why).toMatch(/^Why only this: /);
      // Key-set pin (the exactness the chip describes above traded for toMatchObject): no
      // fourth footnote field appears unannounced, and none of the three goes missing.
      expect(Object.keys(model).sort()).toEqual(
        ["asOf", "cuts", "detail", "label", "tone", "what", "why"].sort(),
      );
    }
    // Degraded payloads have no thresholds block of their own, so only the live ones print cuts.
    expect(armChipModel(core).cuts).toMatch(/^Thresholds: /);
    expect(fireChipModel(core).cuts).toMatch(/^Thresholds: /);
  });
});

describe("asOfLabel + the per-chip date rule (R10)", () => {
  it("labels ONE key's date, dash fallback when null", () => {
    expect(asOfLabel("2026-07-16")).toBe("as of 2026-07-16");
    expect(asOfLabel(null)).toBe("as of -");
  });

  // R10's ruling is UNCONDITIONAL per-chip dates: both fixtures below must print two
  // dates. The declined variant (show only on mismatch) would pass the first case and
  // fail the second, so this pair is what discriminates the two designs.
  it("both chips print their own date when the keys DIVERGE", () => {
    const vm = exposureViewModel(core); // arm 2026-07-23, fire 2026-07-24
    expect(vm.arm.asOf).toBe("as of 2026-07-23");
    expect(vm.fire.asOf).toBe("as of 2026-07-24");
  });

  it("both chips still print their own date when the keys MATCH", () => {
    const matched = {
      ...core,
      arm: { ...core.arm, asOf: "2026-07-24" },
      fire: { ...core.fire, asOf: "2026-07-24" },
    };
    const vm = exposureViewModel(matched);
    expect(vm.arm.asOf).toBe("as of 2026-07-24");
    expect(vm.fire.asOf).toBe("as of 2026-07-24");
    // The MATCHED case is where a shared page-level line would be rendered, so the
    // "single `as of` line is gone" half of the ruling has to be pinned HERE — the
    // same pin on the divergent fixture passes vacuously under a hybrid design
    // (shared line when matched, per-chip when divergent).
    // This IS the R10 pin: the page-level `as of` line is gone, the shell writes only the
    // two chips, and a resurrected `vm.asOf` would be a second, unrendered source of truth.
    expect(vm).not.toHaveProperty("asOf");
  });
});

describe("exposureViewModel + degraded-never-Core invariant", () => {
  it("composes the whole view model", () => {
    const vm = exposureViewModel(core);
    expect(vm.posture).toEqual({ label: "Core", tone: "core", detail: "70% equity" });
    expect(vm.arm.tone).toBe("quiet");
    expect(vm.fire.tone).toBe("approaching"); // the key that makes `Core` reachable at all
  });

  it("has no summary key - the chips carry the per-key detail (E1 feedback)", () => {
    expect(exposureViewModel(core)).not.toHaveProperty("summary");
  });

  it("a degraded response (posture null, degraded keys) never renders as a confident Core", () => {
    const degraded = {
      posture: null,
      arm: { armed: false, degraded: true, percentile: null, roc: null },
      fire: { fired: false, degraded: true, maSpread: null },
      summary: "credit data insufficient; trend data missing -> insufficient data",
      asOf: "2026-07-16",
    };
    const vm = exposureViewModel(degraded);
    expect(vm.posture.label).toBe("Warming up");
    expect(vm.posture.tone).not.toBe("core");
    expect(vm.arm.tone).toBe("degraded");
    expect(vm.fire.tone).toBe("degraded");
  });
});

describe("defaultEpisodeId (Rung C1: default = most recent, never first chip)", () => {
  // Chronological (oldest-first) picker order — the default must NOT be eps[0].
  const chrono = [
    { id: "2002", start: "2002-03-01" },
    { id: "2020", start: "2019-02-19" },
    { id: "2022", start: "2020-11-19" },
  ];
  it("picks the episode with the latest start, independent of list position", () => {
    expect(defaultEpisodeId(chrono)).toBe("2022");
    expect(defaultEpisodeId([...chrono].reverse())).toBe("2022"); // order-independent
  });
  it("is null on an empty/missing list - the caller renders its own empty state", () => {
    expect(defaultEpisodeId([])).toBe(null);
    expect(defaultEpisodeId(undefined)).toBe(null);
  });
});
