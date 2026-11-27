// Pins the CARD's velocity caption (`velocity-span.js`) — the Δ chip and its tooltip — to the
// per-id registry facts, and to the DETAIL CHART's server-composed axis caption.
//
// What this guards: the caption is PER ID — F1 (`velocityWindow: 30`), F3 (4 weeks), F9 (a
// 60-trading-day quarter) — and the card and the chart compose their captions on OPPOSITE sides of
// the language boundary: the chart's arrives pre-made from `chart-rail.ts`, the card's is built in
// the browser off `IndicatorMeta`, so nothing but this file can see them disagree.
//
// Cross-boundary imports into `src/`/`api/` are EXTENSIONLESS (`frontend.md` §"A
// `public/*.test.js` importing a TS module must NOT use a `.js` specifier").
import { describe, it, expect } from "vitest";
import { DEFAULT_VELOCITY_WINDOW, velocityChipLabel, velocityTip } from "./velocity-span.js";
import { obsUnitWord } from "./detail-chart.js";
import { ALL_INDICATORS } from "../src/registry";
import { VELOCITY_WINDOW } from "../src/domain-types";
import { buildIndicatorChart } from "../api/indicators";

// The card meta as the wire emits it for these three fields — `api/indicators.ts` passes all
// three through raw, and `api/indicators.test.ts` pins that pass-through. Building it here from
// the registry keeps this file about the COMPOSER, not the emitter.
const cardMeta = (id) => {
  const i = ALL_INDICATORS.find((x) => x.id === id);
  expect(i, `${id} is a live indicator`).toBeDefined();
  return { id, velocityWindow: i.velocityWindow, obsCadence: i.obsCadence, cadence: i.cadence };
};

describe("velocity-span - the card's Δ caption is per-id, never a literal 20", () => {
  it("mirrors the server's global default window", () => {
    // The FE cannot import the TS constant at runtime, so `DEFAULT_VELOCITY_WINDOW` is a mirror.
    // This is the only thing keeping the two from drifting.
    expect(DEFAULT_VELOCITY_WINDOW).toBe(VELOCITY_WINDOW);
  });

  it.each([
    ["F9", "Δ60d", "Δ60d - change in the value versus 60 trading days ago."],
    ["F3", "Δ4w", "Δ4w - change in the value versus 4 weeks ago (this is a weekly series)."],
    ["R2", "Δ20d", "Δ20d - change in the value versus 20 trading days ago."],
  ])("%s captions %s", (id, chip, tip) => {
    const meta = cardMeta(id);
    expect(velocityChipLabel(meta)).toBe(chip);
    expect(velocityTip(meta)).toBe(tip);
  });

  it("chip label === the detail chart's server-composed velocity-axis label, for EVERY id that has one", () => {
    // The cross-boundary parity that makes the two composers one answer. Driven off the real
    // builder, so a change to `velocitySpanWord` in `chart-rail.ts` reds here.
    const seen = [];
    for (const i of ALL_INDICATORS) {
      const spec = buildIndicatorChart(i);
      const primary = spec?.axes?.find((a) => a.id === "primary");
      const isVelocityPrimary = spec?.series?.some((s) => s.axis === "primary" && s.fromPoint === "delta20");
      if (!isVelocityPrimary || !primary?.label) continue;
      seen.push(i.id);
      expect(velocityChipLabel(cardMeta(i.id)), `${i.id} card chip vs chart axis label`).toBe(primary.label);
    }
    // Vacuity guard: the loop must reach F9 (the re-horizoned id this arc is about) AND at least
    // one default-window id, so it can never pass by sweeping an empty or single-id set.
    expect(seen).toEqual(expect.arrayContaining(["F9", "R3"]));
  });

  it("chip label is the SUFFIX of the dual-axis route's secondary label - the non-daily arm too", () => {
    // F3 and F2 draw a level line, so their velocity caption rides the SECONDARY axis and carries
    // an id-name prefix by design (`"NFCI Risk Δ4w"`) — the same composer, one prefix apart.
    // Suffix rather than equality, so the prefix stays free to change. Restricted to a secondary
    // fed by the PERSISTED `delta20` column, which is the number the card chip prints: F1's
    // secondary is a client-`compute`d `roc30` overlay, a different series with its own label.
    const seen = [];
    for (const i of ALL_INDICATORS) {
      const spec = buildIndicatorChart(i);
      const secondary = spec?.axes?.find((a) => a.id === "secondary");
      const isVelocitySecondary = spec?.series?.some((s) => s.axis === "secondary" && s.fromPoint === "delta20");
      if (!isVelocitySecondary || !secondary?.label) continue;
      seen.push(i.id);
      const chip = velocityChipLabel(cardMeta(i.id));
      expect(secondary.label.endsWith(chip), `${i.id}: "${secondary.label}" should end with "${chip}"`).toBe(true);
    }
    // Vacuity guard: both discriminating arms must be swept — F3 (genuinely weekly grid, 4 weeks,
    // so the caption must read "w") and a plain daily-grid id, so the sweep can never collapse to
    // F3 alone and pass on one arm.
    // ⚠ The RELEASE-vs-GRID arm has no live carrier on this route: F11's level axis was retired and
    // F9/F11/FXH moved to daily feeds. The surviving release≠grid carriers G1/BRENT take the derived
    // chart route, so no dual-axis fixture can restore the arm here; the property is swept instead
    // by the test ABOVE, whose vacuity guard names F9 explicitly.
    expect(seen).toEqual(expect.arrayContaining(["F3", "F2"]));
  });
});

// The FULL census of live ids whose OBSERVATION grid is not daily, i.e. where
// `obsCadence ?? cadence` resolves to something other than "daily". Each entry is a series whose
// own ROW DATES sit on that grid — checked against the feed, never against its release schedule:
//   F3  (NFCIRISK) — one row per Friday, 7-day steps
//   EBP            — one row per month
//   F7  (CAPE)     — one row per month
//   ECY            — one row per month (excess CAPE yield, rides F7's monthly grid)
//   HICP           — one row per month (FRED euro-area HICP Δ6m)
// A weekly-RELEASED but business-day-OBSERVED id must NOT appear: the EIA oil family (G1/BRENT)
// carries `cadence: "weekly"` over business-day rows and declares `obsCadence: "daily"` to say so
// (the H.10 family F9/F11/FXH left for daily feeds). This census is deliberate: it is the one place
// a new id whose release schedule differs from its observation grid is FORCED to be declared,
// instead of silently flipping a legend from "N days" to "N weeks" (a ~5× overstatement of the
// visible history, on charts whose cuts are eyeballed off them).
const NON_DAILY_OBS = { F3: "weekly", EBP: "monthly", F7: "monthly", ECY: "monthly", HICP: "monthly" };

// One vocabulary per resolved grid, across the two surfaces that compose their own copy: the
// detail chart's spelled-out legend word (`obsUnitWord`, `detail-chart.js`) and the card's chip
// letter + tooltip noun (`OBS_GRID`, `velocity-span.js`). The server's short forms are already
// pinned by the two parity sweeps above, which drive the real `chart-rail.ts` builder.
const VOCAB = {
  daily: { legend: "day", chip: "d", noun: "trading days" },
  weekly: { legend: "week", chip: "w", noun: "weeks" },
  monthly: { legend: "month", chip: "mo", noun: "months" },
  quarterly: { legend: "quarter", chip: "q", noun: "quarters" },
};

describe("resolved observation word - a per-id table over EVERY live indicator", () => {
  it("each id's legend/chip/tooltip word matches the grid its registry entry declares", () => {
    const measured = {};
    const legendWords = new Set();
    for (const i of ALL_INDICATORS) {
      const meta = cardMeta(i.id);
      const resolved = i.obsCadence ?? i.cadence ?? "daily";
      expect(resolved, `${i.id}: resolved observation grid vs the census above`).toBe(NON_DAILY_OBS[i.id] ?? "daily");
      if (resolved !== "daily") measured[i.id] = resolved;
      const v = VOCAB[resolved];
      expect(obsUnitWord(meta), `${i.id}: detail-chart legend word`).toBe(v.legend);
      expect(velocityChipLabel(meta).endsWith(v.chip), `${i.id}: chip "${velocityChipLabel(meta)}" ends with "${v.chip}"`).toBe(
        true,
      );
      expect(velocityTip(meta), `${i.id}: tooltip noun`).toContain(` ${v.noun} ago`);
      legendWords.add(v.legend);
    }
    // Both directions: an id that DROPS its `obsCadence: "daily"` reds on the per-id assertion
    // above, and an id that gains a non-daily grid without being declared here reds on this one.
    expect(measured).toEqual(NON_DAILY_OBS);
    // Vacuity anchors, on the discriminating column rather than the total: the sweep must have
    // exercised the daily arm AND both live non-daily arms, so it cannot pass by resolving
    // everything to one word. `quarterly` is deliberately absent — it has no live carrier.
    expect([...legendWords].sort()).toEqual(["day", "month", "week"]);
  });
});
