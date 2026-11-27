/*
 * PARITY: the browser drawdown seam (`journal-drawdown.js`) must compute the SAME numbers as
 * the real server engine (`src/pension.ts` + the shared confirm fold). The browser cannot
 * import the `.ts` engine at runtime, so the JS is a hand-ported copy and THIS file is what
 * keeps the two in lock-step — every math export is asserted equal to its TS twin on the same
 * inputs (house pattern: `cash-precedence-parity.test.js`, `pension-book.test.js`).
 *
 * A `public/*.test.js` importing a TS module must NOT use a `.js` specifier (`frontend.md`):
 * an explicit `.ts` is used below.
 *
 * The confirm fold is included on purpose (the [USER 2026-09-07] J1 ruling): the card shows the
 * CONFIRMED band, so this is a like-for-like client-confirmed == server-confirmed equality, not
 * a raw-vs-confirmed comparison.
 *
 * SINGLE SOURCE for the leg ids: `ladder` is built from the real `LADDER` (families.ts) mapped
 * through the real `legCloseId` (scoreboard.ts) — the nine slugs are never re-typed here, and a
 * slug drift in the server seam would move this fixture, not slip past it.
 */
import { describe, it, expect } from "vitest";
import {
  portfolioSeries,
  drawdownSeries,
  bandOf as tsBandOf,
  pensionConfirmBand,
  PENSION_DIP,
  PENSION_CORRECTION,
  PENSION_BEAR,
} from "../src/pension.ts";
import { confirmedSeries as tsConfirmedSeries } from "../src/domain-fold.ts";
import { CONFIRM_CLOSES } from "../src/domain-types.ts";
import { legCloseId } from "../src/scoreboard.ts";
import { LADDER } from "../src/families.ts";
import {
  CASH,
  bookFromEntries,
  chainBook,
  drawdown,
  bandOf,
  confirmedSeries,
  confirmBand,
} from "./journal-drawdown.js";

// The rung-ordered leg-id array the server serves on /api/config, built here from the real seam.
const LADDER_IDS = LADDER.map(legCloseId);
const CUTS = { dip: PENSION_DIP, correction: PENSION_CORRECTION, bear: PENSION_BEAR };

/** Aligned per-day legs: each day carries every named leg id's value plus a minted CASH=1. */
function legsFrom(dates, prices) {
  return dates.map((date, i) => {
    const eur = { [CASH]: 1 };
    for (const [id, series] of Object.entries(prices)) eur[id] = series[i];
    return { date, eur };
  });
}

describe("bookFromEntries", () => {
  it("a single entry becomes one segment keyed by ladder[rung-1], never the sleeve text", () => {
    const rows = [
      { entry_date: "2026-01-01", rung: 1, cash_pct: 0, created_at: "2026-01-01T09:00:00Z", sleeve: "not-a-real-leg <script>" },
    ];
    const book = bookFromEntries(rows, LADDER_IDS);
    expect(book).toEqual([{ from: "2026-01-01", weights: { [legCloseId("Semis")]: 1, [CASH]: 0 } }]);
    // The stored sleeve text reaches no key — the security invariant, made red-able.
    expect(JSON.stringify(book)).not.toContain("not-a-real-leg");
  });

  it("a multi-entry book carries a rung change and a cash change, oldest-first", () => {
    const rows = [
      { entry_date: "2026-01-03", rung: 5, cash_pct: 40, created_at: "2026-01-03T09:00:00Z" },
      { entry_date: "2026-01-01", rung: 1, cash_pct: 0, created_at: "2026-01-01T09:00:00Z" },
    ];
    expect(bookFromEntries(rows, LADDER_IDS)).toEqual([
      { from: "2026-01-01", weights: { [legCloseId("Semis")]: 1, [CASH]: 0 } },
      { from: "2026-01-03", weights: { [legCloseId(LADDER[4])]: 0.6, [CASH]: 0.4 } },
    ]);
  });

  it("a same-date tie is broken by the latest created_at", () => {
    const rows = [
      { entry_date: "2026-01-01", rung: 1, cash_pct: 0, created_at: "2026-01-01T09:00:00Z" },
      { entry_date: "2026-01-01", rung: 3, cash_pct: 50, created_at: "2026-01-01T15:00:00Z" },
    ];
    const book = bookFromEntries(rows, LADDER_IDS);
    // The 15:00 decision wins the day; the 09:00 one leaves no trace.
    expect(book).toEqual([{ from: "2026-01-01", weights: { [legCloseId("EM")]: 0.5, [CASH]: 0.5 } }]);
    expect(book[0].weights[legCloseId("Semis")]).toBeUndefined();
  });

  it("drops a row whose rung falls outside the served ladder (no id to resolve)", () => {
    const rows = [{ entry_date: "2026-01-01", rung: 99, cash_pct: 0, created_at: "2026-01-01T09:00:00Z" }];
    expect(bookFromEntries(rows, LADDER_IDS)).toEqual([]);
  });
});

describe("chainBook / drawdown / bandOf parity with src/pension.ts", () => {
  it("single-leg book: chainBook == portfolioSeries, and equals the hand value", () => {
    const dates = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"];
    const semis = legCloseId("Semis");
    const legs = legsFrom(dates, { [semis]: [100, 110, 90, 95, 120] });
    const book = bookFromEntries(
      [{ entry_date: "2026-01-01", rung: 1, cash_pct: 0, created_at: "2026-01-01T09:00:00Z" }],
      LADDER_IDS,
    );
    const js = chainBook(legs, book);
    const ts = portfolioSeries(legs, book);
    expect(js).toEqual(ts);
    // Non-self-referential anchor: a 100%-leg book at cash 0 is just the leg rebased to day 0.
    expect(js).toEqual([1, 1.1, 0.9, 0.95, 1.2]);
    // drawdown parity + anchor.
    expect(drawdown(js)).toEqual(drawdownSeries(ts));
    expect(drawdown(js)).toEqual([0, 0, 0.9 / 1.1 - 1, 0.95 / 1.1 - 1, 0]);
  });

  it("multi-leg book with a rung + cash switch: chainBook == portfolioSeries across the chain-link", () => {
    const dates = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"];
    const semis = legCloseId("Semis");
    const spx = legCloseId(LADDER[4]);
    const legs = legsFrom(dates, {
      [semis]: [100, 105, 102, 108, 115],
      [spx]: [50, 52, 49, 51, 53],
    });
    const book = bookFromEntries(
      [
        { entry_date: "2026-01-01", rung: 1, cash_pct: 0, created_at: "2026-01-01T09:00:00Z" },
        { entry_date: "2026-01-03", rung: 5, cash_pct: 40, created_at: "2026-01-03T09:00:00Z" },
      ],
      LADDER_IDS,
    );
    const js = chainBook(legs, book);
    const ts = portfolioSeries(legs, book);
    expect(js).toEqual(ts);
    // The blend is continuous across the switch (no re-peak step), so the drawdown spans it.
    expect(drawdown(js)).toEqual(drawdownSeries(ts));
  });

  it("bandOf agrees with the TS bandOf across every band, cut boundaries included", () => {
    const dds = [0, -0.14999, PENSION_DIP, -0.18, PENSION_CORRECTION, -0.3, PENSION_BEAR, -0.5];
    for (const dd of dds) expect(bandOf(dd, CUTS)).toBe(tsBandOf(dd));
    // Vacuity: the sweep really reaches all four bands, or "agrees" proves nothing.
    expect(new Set(dds.map((d) => bandOf(d, CUTS)))).toEqual(new Set(["CALM", "DIP", "CORRECTION", "BEAR"]));
  });
});

describe("confirm fold parity (the card shows the CONFIRMED band)", () => {
  it("a band that crosses a cut waits out the confirm buffer, client == server", () => {
    // A single-leg book whose drawdown crosses PENSION_DIP (-0.15) on day 2 and holds.
    const dates = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"];
    const semis = legCloseId("Semis");
    const legs = legsFrom(dates, { [semis]: [100, 100, 84, 84, 84] });
    const book = bookFromEntries(
      [{ entry_date: "2026-01-01", rung: 1, cash_pct: 0, created_at: "2026-01-01T09:00:00Z" }],
      LADDER_IDS,
    );
    const p = chainBook(legs, book);
    expect(p).toEqual(portfolioSeries(legs, book));

    const rawBands = drawdown(p).map((dd) => bandOf(dd, CUTS));
    // The regime the fold exists to police: a raw DIP appears before it is confirmed.
    expect(rawBands).toEqual(["CALM", "CALM", "DIP", "DIP", "DIP"]);

    const jsConfirmed = confirmedSeries(rawBands, CONFIRM_CLOSES);
    const tsConfirmed = tsConfirmedSeries(rawBands, CONFIRM_CLOSES);
    expect(jsConfirmed).toEqual(tsConfirmed);
    // The buffer actually DELAYED adoption: raw is DIP at index 2 but confirmed is still CALM.
    expect(rawBands[2]).toBe("DIP");
    expect(jsConfirmed[2]).toBe("CALM");
    expect(jsConfirmed[3]).toBe("DIP");

    // …and the headline the card prints matches the server's confirmed band.
    expect(confirmBand(rawBands, CONFIRM_CLOSES)).toBe(pensionConfirmBand(rawBands, CONFIRM_CLOSES));
    expect(confirmBand(rawBands, CONFIRM_CLOSES)).toBe("DIP");
  });
});

describe("dark leg day parity with src/pension.ts (a LEGP_* series with no row)", () => {
  // readings_latest is a union of the nine leg calendars, so a venue holiday leaves one
  // LEGP_* series dark on a day the others price. These three cases lock the branches every
  // fixture above misses — each asserted equal to (or throwing like) the TS engine.

  it("switch into a leg dark on every prior day: pricedBaseIdx null mid-series carries the level (== portfolioSeries)", () => {
    // legB's feed starts AT the switch date (2026-01-04), so no prior day prices it and
    // pricedBaseIdx returns null at i=3 — not day 0 — hitting `baseLevel = out[i-1]`.
    const dates = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"];
    const semis = legCloseId("Semis");
    const legB = legCloseId(LADDER[4]);
    const legs = legsFrom(dates, {
      [semis]: [100, 110, 120, 130, 140],
      [legB]: [undefined, undefined, undefined, 50, 55], // dark until the switch date
    });
    const book = bookFromEntries(
      [
        { entry_date: "2026-01-01", rung: 1, cash_pct: 0, created_at: "2026-01-01T09:00:00Z" },
        { entry_date: "2026-01-04", rung: 5, cash_pct: 0, created_at: "2026-01-04T09:00:00Z" },
      ],
      LADDER_IDS,
    );
    const js = chainBook(legs, book);
    const ts = portfolioSeries(legs, book);
    expect(js).toEqual(ts);
    // The signature of the null-base carry: the switch day does NOT step the level (it is
    // rebased onto out[i-1]=out[2], blend 1), so out[3] === out[2]. Mutating `out[i-1]` to a
    // constant reds this pair.
    expect(js[2]).toBe(1.2);
    expect(js[3]).toBe(js[2]);
    expect(drawdown(js)).toEqual(drawdownSeries(ts));
  });

  it("day-0 book weighting a dark leg: blendAt throws on the absent base sleeve, like portfolioSeries", () => {
    // Semis has no row on day 0 (venue holiday); the book weights it from day 0, so the
    // chain-link base IS day 0 and its base value is absent → the blendAt guard throws.
    const dates = ["2026-01-01", "2026-01-02"];
    const semis = legCloseId("Semis");
    const legs = legsFrom(dates, { [semis]: [undefined, 100] });
    const book = bookFromEntries(
      [{ entry_date: "2026-01-01", rung: 1, cash_pct: 0, created_at: "2026-01-01T09:00:00Z" }],
      LADDER_IDS,
    );
    expect(() => chainBook(legs, book)).toThrow(/weighted sleeve .* is absent .* cannot blend/);
    // Parity: the TS engine throws on the same shape (its own [pension] prefix).
    expect(() => portfolioSeries(legs, book)).toThrow(/absent from the aligned legs/);
  });

  it("a leg day before the earliest book segment: effectiveWeights throws, like portfolioSeries", () => {
    // The union calendar carries a day the book has no answer for (the first entry is later)
    // → no segment covers it. The card's window must never reach here; the throw is the guard.
    const dates = ["2026-01-01", "2026-01-02"];
    const semis = legCloseId("Semis");
    const legs = legsFrom(dates, { [semis]: [100, 110] });
    const book = bookFromEntries(
      [{ entry_date: "2026-01-02", rung: 1, cash_pct: 0, created_at: "2026-01-02T09:00:00Z" }],
      LADDER_IDS,
    );
    expect(() => chainBook(legs, book)).toThrow(/no book segment covers 2026-01-01/);
    // Parity: the TS engine throws on the same uncovered date (its own [pension] prefix).
    expect(() => portfolioSeries(legs, book)).toThrow(/no holdings segment covers 2026-01-01/);
  });
});
