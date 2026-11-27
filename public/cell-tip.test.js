/*
 * The signal-cell drill-down panel (`cell-tip.js`).
 *
 * READING ORDER: the member that DECIDED the cell is first, the members that decided nothing are folded,
 * and the folded ones keep their weights (which /lab prints on no other surface). Plus two claim-discipline
 * properties: absent never renders as calm, and a missing weight prints nothing, not a fabricated zero.
 */
import { describe, it, expect } from "vitest";
import { cellTipHtml } from "./cell-tip.js";

const m = (id, sev, w, label) => ({ id, sev, w, label });
const cell = (over = {}) => ({
  family: "rt",
  cellState: "elev",
  M: 2,
  N: 8,
  observed: { fresh: 7, lag: 0, absent: 1 },
  held: null,
  ...over,
});

describe("cellTipHtml - reading order", () => {
  it("the member that decided the cell leads, ranked by weight × severity", () => {
    const html = cellTipHtml(cell(), [
      m("R1", "calm", 1, "10y−3m"),
      m("R6", "elev", 0.8, "MOVE"),
      m("R3", "lit", 1, "2y Δ"),
    ]);
    const rows = [...html.matchAll(/class="ct-name">([^<]+)</g)].map((x) => x[1]);
    // R3 (1 × lit) above R6 (0.8 × elev); the calm one is not in the unfolded set at all.
    expect(rows.slice(0, 2)).toEqual(["R3 2y Δ", "R6 MOVE"]);
  });

  it("non-firing members fold behind one affordance - and keep their weights inside it", () => {
    const html = cellTipHtml(cell(), [
      m("R6", "elev", 0.8, "MOVE"),
      m("R1", "calm", 1, "10y−3m"),
      m("BUND", "calm", 0.5, "Bund 10y−2y"),
    ]);
    expect(html).toContain("+2 calm ▸");
    const folded = html.slice(html.indexOf('class="ct-folded"'));
    // The weights are the [USER]'s stated reason the fold exists rather than a bare count.
    expect(folded).toContain("×1");
    expect(folded).toContain("×0.5");
    // …and the fold is CLOSED on open, so the panel's default height is the drivers alone.
    expect(html).toContain('class="ct-folded" hidden');
  });

  it("an absent member folds but never borrows calm's glyph or word", () => {
    const html = cellTipHtml(cell(), [m("R2", "absent", 0.8, "10y Δ")]);
    expect(html).toContain("∅");
    expect(html).toContain("ct-absent");
    expect(html).not.toContain(">calm<");
  });

  it("the fold label counts calm and absent SEPARATELY - never one 'not firing' total", () => {
    const html = cellTipHtml(cell(), [
      m("R1", "calm", 1, "10y−3m"),
      m("R6", "calm", 0.8, "MOVE"),
      m("R2", "absent", 0.8, "10y Δ"),
    ]);
    // A combined `+3` would assert three members were observed idle when one never reported.
    expect(html).toContain("+2 calm · 1 absent ▸");
    // …and an all-calm fold does not print a `0 absent` clause.
    expect(cellTipHtml(cell(), [m("R1", "calm", 1, "10y−3m")])).toContain("+1 calm ▸");
  });

  it("a member with no served weight prints no weight - never ×0, never ×-", () => {
    const html = cellTipHtml(cell({ M: 1 }), [m("R7", "lit", undefined, "Bull steepener")]);
    expect(html).toContain("R7 Bull steepener");
    expect(html).not.toMatch(/×/);
  });

  it("an unweighted firing member still outranks a weighted calm one", () => {
    const html = cellTipHtml(cell(), [m("R1", "calm", 1, "10y−3m"), m("R7", "lit", undefined, "Bull steepener")]);
    const rows = [...html.matchAll(/class="ct-name">([^<]+)</g)].map((x) => x[1]);
    expect(rows[0]).toBe("R7 Bull steepener");
  });
});

describe("cellTipHtml - footer states only what the server measured", () => {
  it("the census rides its own line", () => {
    expect(cellTipHtml(cell({ observed: { fresh: 8, lag: 0, absent: 0 } }), [])).toContain(
      "observed 8 fresh · 0 lag · 0 absent",
    );
  });

  // The served `absentIds` are NAMED in the census clause: a label the map resolves prints `id label`
  // (memberName's id-if-distinct rule), an unmapped id prints raw, and a pre-absentIds cached response
  // (no ids) keeps the bare count — never invented names.
  it("the census NAMES the served absentIds - labelled, raw-id fallback, silent when unserved", () => {
    const c = cell({ observed: { fresh: 2, lag: 0, absent: 1, absentIds: ["AT1"] } });
    expect(cellTipHtml(c, [], false, { AT1: "CoCo" })).toContain(
      "observed 2 fresh · 0 lag · 1 absent (AT1 CoCo)",
    );
    // no label map (older /api/danger-model cache) → the raw id still names the member
    expect(cellTipHtml(c, [])).toContain("1 absent (AT1)");
    // pre-absentIds cached /api/lab response → the bare count, unchanged
    expect(
      cellTipHtml(cell({ observed: { fresh: 2, lag: 0, absent: 1 } }), [], false, { AT1: "CoCo" }),
    ).toContain("observed 2 fresh · 0 lag · 1 absent");
  });

  // ⚠ Every `closes`/`ageCloses` literal below is a MADE-UP SERVED number, NOT a real hold window — the
  // FE holds no copy of those, and a fixture quoting one would be the first copy.
  it("the hold note names the member, the AGE and the window as a BOUND - or is absent entirely", () => {
    const held = cellTipHtml(cell({ held: { member: "R4", closes: 7, ageCloses: 2 } }), []);
    expect(held).toContain("ct-held");
    // The narrowed copy, verbatim: the age is the fact, the window is a bound, and the release is named.
    // A row that said only "carried by the hold window (≤7 closes)" reads as a countdown — false under
    // arm C, where a green print from the member ends the hold early.
    expect(held).toContain(
      "severity from <b>R4</b>, carried by the hold window - printed 2 closes back, " +
        "window ≤7 closes (an upper bound); the hold ends when R4 prints green",
    );
    // SINGULAR — a one-close age reads "1 close back", not "1 closes back".
    expect(cellTipHtml(cell({ held: { member: "R4", closes: 11, ageCloses: 1 } }), [])).toContain(
      "printed 1 close back",
    );
    expect(cellTipHtml(cell(), [])).not.toContain("ct-held");
  });

  // OVERLAP (addendum §2): the hold window and the directional fold are INDEPENDENT and can co-occur.
  // The window sentence is the primary and is NEVER replaced; the fold clause APPENDS only when the
  // argmax member (the one `cell.held` names) also carries a `fold` mark.
  it("appends the fold clause only when the argmax member is ALSO mid-stand-down", () => {
    const held = { member: "R4", closes: 7, ageCloses: 2 };
    const windowClause = "severity from <b>R4</b>, carried by the hold window";
    // window + fold: both clauses present.
    const both = cellTipHtml(cell({ held }), [{ ...m("R4", "lit", 0.8, "10y Δ"), fold: { raw: "GREEN", of: 2 } }]);
    expect(both).toContain(windowClause);
    expect(both).toContain(" - and <b>R4</b> is itself held by the fold (raw GREEN)");
    // window only (argmax carries no fold): the window clause stands alone.
    const windowOnly = cellTipHtml(cell({ held }), [m("R4", "lit", 0.8, "10y Δ")]);
    expect(windowOnly).toContain(windowClause);
    expect(windowOnly).not.toContain("held by the fold");
  });

  // THE ASYMMETRIC DEGRADE, on the surface the user actually reads (`heldOf`/`heldAgeNote`): a
  // pre-Stage-2 cached payload carries no age, and the row says UNKNOWN rather than inventing one —
  // not `0`, and not the window's own number standing in for the age.
  it("a served mark with no age says so - the row survives, the age is never fabricated", () => {
    const html = cellTipHtml(cell({ held: { member: "R4", closes: 7 } }), []);
    expect(html).toContain(
      "severity from <b>R4</b>, carried by the hold window - age unknown, " +
        "window ≤7 closes (an upper bound); the hold ends when R4 prints green",
    );
    expect(html).not.toContain("closes back");
    // …and `0` is a REAL served age (the newest stored close), never folded into "unknown".
    expect(cellTipHtml(cell({ held: { member: "R4", closes: 7, ageCloses: 0 } }), [])).toContain(
      "printed 0 closes back",
    );
  });

  // A held member's OWN row carries the mark, independent of `cell.held` — the argmax-only footer left
  // a held member invisible whenever a live member out-weighed it.
  it("a held member's OWN row carries the mark and the age - even when cell.held is null", () => {
    const html = cellTipHtml(cell({ held: null }), [
      { ...m("BRENT", "elev", 0.4, "Brent"), held: null },
      { ...m("G1", "elev", 0.2, "WTI oil"), held: { ageCloses: 1 } },
    ]);
    const rows = html.split("ct-row ");
    const g1Row = rows.find((r) => r.includes("G1"));
    const brentRow = rows.find((r) => r.includes("Brent"));
    expect(g1Row).toContain("ct-row-held");
    expect(g1Row).toContain("elev · held, printed 1 close back");
    // The live member stays unmarked — the mark means "this state is an earlier close's", nothing else.
    expect(brentRow).not.toContain("ct-row-held");
    expect(brentRow).not.toContain("held");
    // No age served ⇒ said, never fabricated (same degrade as the footer's `heldAgeNote`).
    expect(cellTipHtml(cell(), [{ ...m("G1", "elev", 0.2, "WTI oil"), held: {} }])).toContain(
      "elev · held, age unknown",
    );
  });

  it("a structural cell says so in one line and quantifies over nothing", () => {
    const html = cellTipHtml(cell({ N: 0, M: 0 }), []);
    expect(html).toContain("n/a to this sleeve");
    expect(html).not.toContain("observed");
  });
});

describe("cellTipHtml - the panel is the tooltip", () => {
  it("emits no title= and no ⓘ - [USER] 2026-08-07, the drill-down rides the existing cell", () => {
    const html = cellTipHtml(cell({ held: { member: "R4", closes: 7, ageCloses: 2 } }), [
      m("R3", "lit", 1, "2y Δ"),
      m("R1", "calm", 1, "10y−3m"),
    ]);
    expect(html).not.toContain("title=");
    expect(html).not.toContain("ⓘ");
  });
});
