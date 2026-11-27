/**
 * Transcription guards for the static method-card catalog (public/method-cards.js).
 * Plain JS so vitest's default glob collects it and tsc (no allowJs) ignores it.
 * These assert the SHAPE of the transcription — count, group split, and that no
 * card lost a required field — not the prose itself.
 */
import { describe, it, expect } from "vitest";
import { METHOD_CARDS } from "./method-cards.js";

describe("METHOD_CARDS", () => {
  it("every card has non-empty what / output / failureMode, a real group and ≥1 well-formed inputs row", () => {
    // The active/shelf split rides each card's `group` — a bad value silently drops the card from
    // both columns. Counts are NOT pinned (they churn on every legitimate add); the shape is.
    for (const g of ["active", "shelf"]) {
      expect(METHOD_CARDS.some((c) => c.group === g), `${g} group non-empty`).toBe(true);
    }
    for (const c of METHOD_CARDS) {
      expect(["active", "shelf"], `${c.id} group`).toContain(c.group);
      expect(c.what?.trim(), `${c.id} what`).toBeTruthy();
      expect(c.output?.trim(), `${c.id} output`).toBeTruthy();
      expect(c.failureMode?.trim(), `${c.id} failureMode`).toBeTruthy();
      expect(Array.isArray(c.inputs) && c.inputs.length >= 1, `${c.id} inputs`).toBe(true);
      for (const row of c.inputs) {
        expect(row.signal?.trim(), `${c.id} input signal`).toBeTruthy();
        expect(row.tag?.trim(), `${c.id} input tag`).toBeTruthy();
      }
    }
  });

  // iter-4 bench fields: gist = spine label; preset = the ?s= scenario that fires
  // the method on the board; cashBreaker = R4's view-only Cash(10) override flag.
  it("every card carries a non-empty gist and a well-formed preset", () => {
    const STATES = new Set(["GREEN", "AMBER", "RED"]);
    const FAMILIES = new Set(["credit", "volatility", "rates", "trend", "flight", "dispersion"]);
    for (const c of METHOD_CARDS) {
      expect(c.gist?.trim(), `${c.id} gist`).toBeTruthy();
      const p = c.preset;
      expect(p && typeof p === "object" && !Array.isArray(p), `${c.id} preset is a plain object`).toBe(
        true,
      );
      for (const [key, val] of Object.entries(p)) {
        expect(FAMILIES.has(key), `${c.id} preset key ${key}`).toBe(true);
        expect(STATES.has(val), `${c.id} preset value ${val}`).toBe(true);
      }
    }
  });

  it("cashBreaker flags R4 alone (view-only Cash override)", () => {
    const flagged = METHOD_CARDS.filter((c) => c.cashBreaker === true);
    expect(flagged.map((c) => c.id)).toEqual(["R4"]);
  });
});
