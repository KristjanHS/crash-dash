import { describe, expect, it } from "vitest";
import { parseFindings, type Finding } from "./ladder-findings.js";
import { prelabel, type PrelabelRow } from "./ladder-prelabel.js";

const prelabelRow = (r: PrelabelRow, l: Finding[], today: string) => prelabel([r], l, today).rows[0]!;

const TODAY = "2026-11-14";
const row = (over: Partial<PrelabelRow> = {}): PrelabelRow => ({ sign: "r", since: "2026-11-07", held: null, ...over });
const lines = (...l: string[]) => parseFindings(l.join("\n"));
const label = (r: PrelabelRow, ...l: string[]) => prelabelRow(r, lines(...l), TODAY).label;

describe("prelabelRow", () => {
  it("an in-window finding is a judgement row dated by its newest source, even when held", () => {
    const p = prelabelRow(row({ held: "2026-11-08" }), lines("r | 2026-11-09 | https://a | fetch | x | ok", "r | 2026-11-12 | https://b | search | y | ok"), TODAY);
    expect([p.label, p.date]).toEqual([undefined, "11-12"]);
  });
  it("held newer than the in-window finding floors the date", () =>
    expect(((p) => [p.label, p.date])(prelabelRow(row({ held: "2026-11-10" }), lines("r | 2026-11-08 | https://a | fetch | x | ok"), TODAY))).toEqual([undefined, "11-10"]));
  it("a measured reading is an in-window finding on a non-measuredOnly row", () => {
    const measured = { asOf: "2026-11-11", text: "DFII10 2.64 %", sources: [{ date: "2026-11-11", url: "https://m" }] };
    expect(((p) => [p.label, p.date])(prelabelRow(row({ held: "2026-11-09", measured }), [], TODAY))).toEqual([undefined, "11-11"]);
  });
  it("held with no in-window finding → UNCHANGED <held>", () => expect(label(row({ held: "2026-11-08" }), "r | 2026-10-01 | https://a | fetch | old | ok")).toBe("UNCHANGED 11-08"));
  it("a same-year finding older than since → STALE, beating a no-item listing", () =>
    expect(label(row(), "r | 2026-10-20 | https://a | fetch | x | ok", "r | 2026-09-02 | https://c | fetch | y | ok", "r | 2026-10-01 | https://b | fetch | no item on the row | ok")).toBe("STALE 10-20"));
  it("an ok no-item listing → QUIET since max(since, its date)", () => {
    expect(label(row(), "r | 2026-10-01 | https://b | fetch | no item on the row | ok")).toBe("QUIET since 11-07 https://b");
    expect(label(row(), "r | 2026-11-10 | https://b | fetch | no item on the row | ok")).toBe("QUIET since 11-10 https://b");
  });
  it("FAILED, undated and other-year lines are no source → UNSOURCED", () =>
    expect(label(row(), "r | 2026-11-10 | https://a | fetch | — | FAILED", "r | — | https://b | search | x | ok", "r | 2025-11-10 | https://c | search | y | ok")).toBe("UNSOURCED"));
  it("an in-window finding from last year still counts across the year boundary", () =>
    expect(((p) => [p.label, p.date, p.sources])(prelabelRow(row({ since: "2026-12-22" }), lines("r | 2026-12-28 | https://a | fetch | x | ok"), "2027-01-05"))).toEqual([undefined, "12-28", [{ date: "2026-12-28", url: "https://a" }]]));
  it("a measuredOnly row reads measured.sources as its lines", () => {
    const measured = { asOf: "2026-11-13", text: "3MMA +2 %", sources: [{ date: "2026-11-13", url: "https://m" }] };
    expect(prelabelRow(row({ measured, measuredOnly: true }), lines("r | 2026-10-01 | https://x | fetch | old | ok"), TODAY)).toMatchObject({ date: "11-13" });
    expect(label(row({ measured: { ...measured, sources: [{ date: "2026-10-30", url: "https://m" }] }, measuredOnly: true }))).toBe("STALE 10-30");
  });
});

describe("prelabel", () => {
  it("fills the patch stub: mechanical rows with label + sources, judgement rows empty", () => {
    const out = prelabel([row({ sign: "a" }), row({ sign: "b" })], lines("a | 2026-11-10 | https://a | fetch | x | ok", "b | 2026-10-20 | https://b | fetch | y | ok"), TODAY);
    expect(out.patch.signs).toEqual({ a: { label: "" }, b: { label: "STALE 10-20", sources: [{ date: "2026-10-20", url: "https://b" }] } });
  });
  it("a measuredOnly row's stub keeps measuredOnly, so a filled row leaves its fails + extendedOn alone", () =>
    expect(prelabel([row({ sign: "m", measuredOnly: true })], [], TODAY).patch.signs).toEqual({ m: { label: "UNSOURCED", sources: [], measuredOnly: true } }));
});

describe("prelabel rungB", () => {
  const rb = (rows: PrelabelRow[], ...l: string[]) => prelabel(rows, lines(...l), TODAY).rungB;
  it("an extended row with no in-window finding owes its extended search; one with a finding does not", () =>
    expect(rb([row({ sign: "a", extended: true }), row({ sign: "b", extended: true }), row({ sign: "c" })], "b | 2026-11-10 | https://b | fetch | x | ok").extended).toEqual(["a"]));
  it("dating: one undated line per open, un-held row", () =>
    expect(rb([row({ sign: "a" }), row({ sign: "h", held: "2026-11-08" }), row({ sign: "w" })], "a | — | https://a.com/1 | search | x | ok", "a | — | https://a.com/2 | search | y | ok", "h | — | https://h.com/1 | search | z | ok", "w | 2026-11-10 | https://w | fetch | x | ok", "w | — | https://w.com/2 | search | y | ok").dating).toEqual([{ sign: "a", url: "https://a.com/1" }]));
  it("dating skips a domain that FAILED this run, roic.ai and no-item lines", () =>
    expect(rb([row({ sign: "a" })], "z | 2026-11-10 | https://www.bad.com/x | fetch | — | FAILED", "a | — | https://bad.com/1 | search | x | ok", "a | — | https://www.roic.ai/q | search | x | ok", "a | — | https://n.com | fetch | no item on the row | ok", "a | — | https://ok.com/1 | search | x | ok").dating).toEqual([{ sign: "a", url: "https://ok.com/1" }]));
  it("a measuredOnly row owes nothing", () => expect(rb([row({ sign: "m", measuredOnly: true, extended: true })])).toEqual({ extended: [], dating: [] }));
});
