import { describe, expect, it } from "vitest";
import { NOWCAST_MAX_CARRY_DAYS, resolveCarryWindow, resolveCarryWindows } from "./nowcast-carry.js";

const obs = (rows: [string, number][]) => rows.map(([date, value]) => ({ date, value }));
const plusDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);

describe("resolveCarryWindow (R9/R10/R11)", () => {
  const prints = obs([["2026-09-16", 3.0], ["2026-09-17", 3.1]]);

  it("anchors on the newest print that has an exact-date close in every input", () => {
    const w = resolveCarryWindow(prints, [obs([["2026-09-17", 80], ["2026-09-18", 79]]), obs([["2026-09-17", 95], ["2026-09-18", 94]])]);
    expect(w!.print.date).toBe("2026-09-17");
    expect(w!.bases.map((b) => b.value)).toEqual([80, 95]);
    expect(w!.nows.map((n) => n.value)).toEqual([79, 94]);
  });

  it("R10: walks BACK a print when an input has no close on the newest print's date, rather than sliding the base", () => {
    const lead = obs([["2026-09-16", 80], ["2026-09-18", 79]]); // no 09-17 close
    const w = resolveCarryWindow(prints, [lead]);
    expect(w!.print.date).toBe("2026-09-16"); // NOT 09-17 anchored on the 09-16 close
    expect(w!.bases[0]!.date).toBe("2026-09-16");
  });

  it("R10: never anchors a print whose base would slide, even when an earlier close exists", () => {
    // 09-15 is the only close at or before either print — sliding it onto 09-16 or 09-17 would re-count 09-15..09-17.
    expect(resolveCarryWindow(prints, [obs([["2026-09-15", 80], ["2026-09-18", 79]])])).toBeNull();
  });

  it("pins every input to the LEAD's newest date, ignoring a newer close elsewhere (U4)", () => {
    const lead = obs([["2026-09-17", 80], ["2026-09-18", 79]]);
    const hedge = obs([["2026-09-17", 95], ["2026-09-18", 96], ["2026-09-21", 97]]); // other venue open, lead's shut
    const w = resolveCarryWindow(prints, [lead, hedge]);
    expect(w!.nows.map((n) => n.date)).toEqual(["2026-09-18", "2026-09-18"]);
  });

  it("returns null when a non-lead input has no close on the lead's newest date", () => {
    expect(resolveCarryWindow(prints, [obs([["2026-09-17", 80], ["2026-09-18", 79]]), obs([["2026-09-17", 95]])])).toBeNull();
  });

  it("is dropped, never blended, once the prints catch up with the lead close", () => {
    expect(resolveCarryWindow(prints, [obs([["2026-09-16", 80], ["2026-09-17", 79]])])).toBeNull();
  });

  it("R9: carries AT the cap and drops the print one day past it", () => {
    const t0 = "2026-09-01";
    const atCap = plusDays(t0, NOWCAST_MAX_CARRY_DAYS);
    const pastCap = plusDays(t0, NOWCAST_MAX_CARRY_DAYS + 1);
    const onePrint = obs([[t0, 3.0]]);
    expect(resolveCarryWindow(onePrint, [obs([[t0, 80], [atCap, 79]])])!.print.date).toBe(t0);
    expect(resolveCarryWindow(onePrint, [obs([[t0, 80], [pastCap, 79]])])).toBeNull();
  });

  it("returns null on an empty print series or an empty lead", () => {
    expect(resolveCarryWindow([], [obs([["2026-09-18", 79]])])).toBeNull();
    expect(resolveCarryWindow(prints, [[]])).toBeNull();
  });
});

describe("resolveCarryWindows (I2)", () => {
  it("one window per lead date past the newest print, all on one anchor; a date an input lacks is skipped, the cap drops the tail", () => {
    const t0 = "2026-09-17";
    const pastCap = plusDays(t0, NOWCAST_MAX_CARRY_DAYS + 1);
    const lead = obs([[t0, 80], ["2026-09-18", 79], ["2026-09-21", 78], ["2026-09-22", 77], [pastCap, 76]]);
    const hedge = obs([[t0, 95], ["2026-09-18", 94], ["2026-09-22", 93], [pastCap, 92]]); // no 09-21 close
    const ws = resolveCarryWindows(obs([[t0, 3.0]]), [lead, hedge]);
    expect(ws.map((w) => [w.nows[0]!.date, w.print.date])).toEqual([["2026-09-18", t0], ["2026-09-22", t0]]);
  });
});
