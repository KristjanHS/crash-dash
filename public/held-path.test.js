// Held-leg trajectory seam. Plain `.js` so vitest collects it and tsc ignores it; no
// jsdom (pure string builder). Imports the seam DIRECTLY — never lab.js, which has module-level
// DOM/localStorage side effects.
//
// The load-bearing assertion is the OVERRUN one: a walk that is still moving at +N must never have
// its day-N sleeve printed as a destination, in the log summary OR in the footer clause.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SCENARIO_WALK_DAYS,
  deriveHeldPath,
  heldPathHtml,
  heldPathFootPhrase,
} from "./held-path.js";
// The ladder ORDER is the direction signal the reason string is derived from, so pin it against the
// server's own constant rather than re-typing a mirror (`frontend.md` §"A public/*.test.js importing
// a TS module must NOT use a `.js` specifier").
import { LADDER } from "../src/families.ts";
import { sleeveLabel } from "./sleeve-label.js";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const ladder = [...LADDER];

/** One `WalkLegStep` — only the three members this seam reads are material; the rest of the wire
 *  shape (date/band/r4Phase/r4ReentryRung/cashOverlay) is carried so the fixture is a real step. */
const step = (day, heldSleeve, reriskConfirmCount = 0) => ({
  day,
  date: `2026-08-${String(5 + day).padStart(2, "0")}`,
  band: "WARNING",
  heldSleeve,
  r4Phase: null,
  r4ReentryRung: null,
  cashOverlay: "off",
  reriskConfirmCount,
});

/** A flat walk of `n` days all holding `sleeve`, with an optional per-day confirm counter. */
const flat = (n, sleeve, confirm = 0) =>
  Array.from({ length: n }, (_, i) => step(i + 1, sleeve, confirm));

describe("deriveHeldPath - the incumbent row", () => {
  it("emits the incumbent UNCONDITIONALLY, from field.held (walkPath has no day-0 entry)", () => {
    const path = deriveHeldPath("Health", flat(12, "Health"), ladder);
    expect(path.rows[0]).toMatchObject({ day: 0, label: "today", sleeve: "Health", incumbent: true });
    expect(path.rows[0].reason).toBe("incumbent - the current position");
    // Never sourced from the walk: the walk's own day 1 is a different sleeve here, and the
    // incumbent row still reads the argument.
    const moved = deriveHeldPath("Health", [step(1, "Value"), ...flat(1, "Value")], ladder);
    expect(moved.rows[0].sleeve).toBe("Health");
  });

  it("returns null when there is no walk to describe (absent / empty walkPath)", () => {
    expect(deriveHeldPath("Health", undefined, ladder)).toBe(null);
    expect(deriveHeldPath("Health", null, ladder)).toBe(null);
    expect(deriveHeldPath("Health", [], ladder)).toBe(null);
  });

  it("emits one row per CHANGE only - a flat walk is the incumbent row alone", () => {
    expect(deriveHeldPath("Health", flat(12, "Health"), ladder).rows).toHaveLength(1);
  });
});

describe("deriveHeldPath - the three outcomes", () => {
  it("no move: nothing changed through +N, and no destination is claimed", () => {
    const path = deriveHeldPath("Health", flat(12, "Health"), ladder);
    expect(path.outcome).toBe("none");
    expect(path.lastChangeDay).toBe(null);
    expect(path.destination).toBe(null);
    expect(heldPathHtml("Health", flat(12, "Health"), ladder)).toContain("nothing changed through +12");
  });

  it("settled: last change at +k with k < N ⇒ settled by +k, destination = that sleeve", () => {
    const walk = [
      ...flat(3, "Health", 1),
      step(4, "Value", 0),
      ...Array.from({ length: 8 }, (_, i) => step(i + 5, "Value", 0)),
    ];
    const path = deriveHeldPath("Health", walk, ladder);
    expect(path.days).toBe(12);
    expect(path.outcome).toBe("settled");
    expect(path.lastChangeDay).toBe(4);
    expect(path.destination).toBe("Value");
    expect(heldPathHtml("Health", walk, ladder)).toContain(
      "settled by +4 · no further change through +12",
    );
  });

  // ── THE OVERRUN CASE — the assertion that stops the UI stating a false destination ──────────────
  it("overrun: still moving at +N ⇒ NO destination, and the day-N sleeve is never the answer", () => {
    const walk = [
      ...flat(4, "Health", 0),
      step(5, "Value", 0),
      step(6, "Value", 0),
      step(7, "S&P 500", 0), // the LAST close still moves ⇒ the path has not converged
    ];
    const path = deriveHeldPath("Health", walk, ladder);
    expect(path.outcome).toBe("overrun");
    expect(path.lastChangeDay).toBe(7);
    expect(path.destination).toBe(null);

    const html = heldPathHtml("Health", walk, ladder);
    expect(html).toContain("still moving at +7 - not settled");
    expect(html).not.toContain("settled by");

    // The footer is the surface a reader takes an action from, so it owes the same pin: it states
    // the non-settle and names NO leg.
    const foot = heldPathFootPhrase("Health", walk, ladder);
    expect(foot).toBe(" - not settled by +7 closes ");
    expect(foot).not.toContain("S&amp;P 500");
    expect(foot).not.toContain("→");
  });

  it("a change on the ONLY walked day is an overrun too (nothing followed it to settle)", () => {
    const path = deriveHeldPath("Health", [step(1, "Value", 0)], ladder);
    expect(path.outcome).toBe("overrun");
    expect(heldPathFootPhrase("Health", [step(1, "Value", 0)], ladder)).toBe(
      " - not settled by +1 close ",
    );
  });
});

describe("deriveHeldPath - the reason vocabulary", () => {
  const reasons = (incumbent, walk, l = ladder) =>
    deriveHeldPath(incumbent, walk, l).rows.slice(1).map((r) => r.reason);

  it("a move to a MORE-AGGRESSIVE leg reads as a re-risk", () => {
    // Health (rung 8) → Value (rung 4): up the ladder, commits on ONE close exactly like a de-risk
    // — the confirm streak and dwell clocks are retired (src/rotation-commit.ts).
    expect(reasons("Health", [step(1, "Health", 1), step(2, "Value", 0), step(3, "Value", 0)])).toEqual([
      "re-risk - commits on one close",
    ]);
  });

  it("a move to a MORE-DEFENSIVE leg reads as a de-risk, which needs no confirm", () => {
    // Value (rung 4) → Staples (rung 9): down the ladder, one close, no streak.
    expect(reasons("Value", [step(1, "Staples", 0), step(2, "Staples", 0)])).toEqual([
      "de-risk - commits on one close",
    ]);
  });

  it("with no derivable direction it falls back to the CONFIRM COUNTER, never a guess", () => {
    // Off-ladder / degraded ladder ⇒ no rung either side. A non-zero counter standing on the close
    // BEFORE the change still identifies a re-risk (the streak accumulates whenever a wanted re-risk
    // was held back — that now means the trend veto, not a confirm clock); without one,
    // say only that the hold rotated.
    expect(reasons("Cash", [step(1, "Cash", 3), step(2, "Health", 0), step(3, "Health", 0)])).toEqual([
      "re-risk - commits on one close",
    ]);
    expect(reasons("Cash", [step(1, "Cash", 0), step(2, "Health", 0), step(3, "Health", 0)])).toEqual([
      "hold rotates",
    ]);
    // Same fallback when the ladder itself was not served.
    expect(reasons("Health", [step(1, "Health", 2), step(2, "Value", 0), step(3, "Value", 0)], undefined)).toEqual([
      "re-risk - commits on one close",
    ]);
  });

  it("the day-0 incumbent's counter is UNKNOWN, not 0 - a day-1 change is not called a de-risk", () => {
    // Nothing on the wire carries the incumbent's `reriskConfirmCount`, so a day-1 change with an
    // off-ladder sleeve cannot be attributed and must read plainly.
    expect(reasons("Cash", [step(1, "Bullion", 0), step(2, "Bullion", 0)])).toEqual(["hold rotates"]);
  });

  it("never emits the retired band-step reason (a frozen dial cannot move its rung band)", () => {
    const walk = [step(1, "Health", 0), step(2, "Value", 0), step(3, "Value", 0)];
    expect(heldPathHtml("Health", walk, ladder)).not.toContain("band step-down");
  });
});

describe("heldPathHtml / heldPathFootPhrase - rendering", () => {
  const walk = [step(1, "Health", 1), step(2, "Value", 0), ...Array.from({ length: 8 }, (_, i) => step(i + 3, "Value", 0))];

  it("renders nothing at all when there is no walk - the ledger paints exactly as before", () => {
    expect(heldPathHtml("Health", undefined, ladder)).toBe("");
    expect(heldPathHtml("Health", [], ladder)).toBe("");
    expect(heldPathFootPhrase("Health", undefined, ladder)).toBe("");
    expect(heldPathFootPhrase("Health", [], ladder)).toBe("");
  });

  it("the footer keeps today's wording when nothing moved (empty clause, not a new sentence)", () => {
    expect(heldPathFootPhrase("Health", flat(12, "Health"), ladder)).toBe("");
  });

  it("the settled footer names the delta and the settle", () => {
    expect(heldPathFootPhrase("Health", walk, ladder)).toBe(` today → <b>${sleeveLabel("Value")}</b> in 2 closes `);
  });

  it("prints sleeves by their display label (log cells + footer), never the bare key", () => {
    const label = sleeveLabel("EU-Fin");
    expect(label).not.toBe("EU-Fin"); // premise: the fixture sleeve really is relabelled
    const toEuFin = [step(1, "EU-Fin", 0), ...Array.from({ length: 9 }, (_, i) => step(i + 2, "EU-Fin", 0))];
    expect(heldPathHtml("Health", toEuFin, ladder)).toContain(`<td class="hp-held">${label}</td>`);
    expect(heldPathFootPhrase("Health", toEuFin, ladder)).toContain(`<b>${label}</b>`);
  });

  // A settled walk whose destination IS the incumbent: `destination` is compared only against the
  // previous row, so without the round-trip branch this footer reads "Health today → Health" —
  // claiming a rotation into the leg already held. Reachable inside the 10-day default (both
  // directions commit on one close — the only thing that can delay one is the trend veto).
  it("a ROUND TRIP back to the incumbent is stated as such, never as a move to the held leg", () => {
    const walk = [
      step(1, "Staples", 0), // de-risk out, one close
      step(2, "Staples", 1),
      step(3, "Staples", 2),
      step(4, "Staples", 2),
      step(5, "Health", 0), // re-risk back into the incumbent
      ...Array.from({ length: 5 }, (_, i) => step(i + 6, "Health", 0)),
    ];
    const path = deriveHeldPath("Health", walk, ladder);
    expect(path.outcome).toBe("settled");
    expect(path.destination).toBe("Health"); // the derivation is right — only the wording was wrong
    const foot = heldPathFootPhrase("Health", walk, ladder);
    expect(foot).toBe(" - round trip: back to today's hold by +5 closes ");
    expect(foot).not.toContain("→");
    expect(foot).not.toContain("<b>Health</b>");
    // Null hold out and back is the same case — the `?? null` normalisation the row loop uses, not
    // a move to "no in-band sleeve".
    const nullTrip = [step(1, "Cash", 0), step(2, null, 0), step(3, null, 0)];
    expect(heldPathFootPhrase(null, nullTrip, ladder)).toBe(
      " - round trip: back to today's hold by +2 closes ",
    );
  });

  it("escapes sleeve names - they reach the DOM", () => {
    const w = [step(1, "S&P 500", 0), step(2, "S&P 500", 0)];
    expect(heldPathHtml("Health", w, ladder)).toContain("S&amp;P 500");
    expect(heldPathHtml("Health", w, ladder)).not.toContain("S&P 500");
    expect(heldPathFootPhrase("Health", [...w, step(3, "S&P 500", 0)], ladder)).toContain(
      `<b>${sleeveLabel("S&P 500").replace("&", "&amp;")}</b>`,
    );
  });

  it("a null hold renders as an explicit no-in-band-sleeve row, never a blank cell", () => {
    const html = heldPathHtml("Health", [step(1, null, 0), step(2, null, 0)], ladder);
    expect(html).toContain("no in-band sleeve");
    expect(deriveHeldPath(null, flat(3, null), ladder).rows).toHaveLength(1); // null → null is no move
  });

  it("the header counts the walked closes, singular at 1", () => {
    expect(heldPathHtml("Health", flat(1, "Health"), ladder)).toContain("walk 1 close<");
    expect(heldPathHtml("Health", flat(12, "Health"), ladder)).toContain("walk 12 closes<");
  });

  it("there is no band column - the dial is frozen across a walk", () => {
    const html = heldPathHtml("Health", walk, ladder);
    expect(html).toContain("what changed");
    expect(html).not.toContain("WARNING"); // the notify level rides the fixture but is never painted
    expect(html).not.toMatch(/r\d+-r\d+/);
  });
});

describe("SCENARIO_WALK_DAYS - one touch point", () => {
  const lab = readFileSync(here("./lab.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("is a positive integer depth (its VALUE is stated only in held-path.js)", () => {
    expect(Number.isInteger(SCENARIO_WALK_DAYS)).toBe(true);
    expect(SCENARIO_WALK_DAYS).toBeGreaterThan(0);
  });

  it("the SCENARIO fetch defaults the walk to it; the LIVE fetch does not", () => {
    // Source-text pins: this is the only surface the default has, and there is no jsdom here to
    // drive `walkParam` through a real `location`.
    expect(lab).toContain("walkParam(SCENARIO_WALK_DAYS)");
    expect(lab).toContain('request("/api/lab?hist=" + LOOKBACK + walkParam(), { fetchImpl: liveFetch, timeoutMs: API_TIMEOUT_MS })');
    expect(lab.match(/walkParam\(SCENARIO_WALK_DAYS\)/g)).toHaveLength(1);
  });

  it("an explicit ?walk= wins by PRESENCE, so ?walk=0 cannot be read as absent", () => {
    // The falsy trap this guards: `raw || defaultDays` would turn an explicit "0" into the default.
    expect(lab).toContain("raw != null ? Number.parseInt(raw, 10) : defaultDays");
  });
});
