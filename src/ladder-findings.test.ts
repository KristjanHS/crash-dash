import { describe, expect, it } from "vitest";
import { isNoItem, parseFindings } from "./ladder-findings.js";

const TABLE = `row | date | url | via | fact | status
---|---|---|---|---|---
tsmc_monthly (Oct revenue released?) | 2026-11-10 | https://a.example/x | fetch | Oct revenue +16.9 % m/m | ok
capex_guides | 2026-10-02 | https://b.example/list | fetch | no item on the row | ok
mu_dio | undated | https://c.example/y | search | guide reiterated | ok
sia_3mma | 2026-10 | https://d.example/z | fetch | — | FAILED

| row | date | url | via | fact | status |
|:--|:--|:--|:--|:--|:--|
| \`yen_carry\` | 2026-11-12 | <https://e.example/q> | search | BoJ: a | b | ok |`;

describe("parseFindings", () => {
  const lines = parseFindings(TABLE);
  it("reads every line of repeated tables, skipping headers and separators and a row's (…) suffix", () => {
    expect(lines.map((l) => l.row)).toEqual(["tsmc_monthly", "capex_guides", "mu_dio", "sia_3mma", "yen_carry"]);
  });
  it("reads a `no item on the row` line with its listing date", () => {
    expect(lines[1]).toMatchObject({ date: "2026-10-02", status: "ok" });
    expect(isNoItem(lines[1]!)).toBe(true);
    expect(isNoItem(lines[0]!)).toBe(false);
  });
  it("reads `—`, `undated` and month-only dates as date null", () => expect(lines[2]).toMatchObject({ date: null, via: "search", status: "ok" }));
  it("reads a FAILED line", () => expect(lines[3]).toMatchObject({ date: null, status: "FAILED", url: "https://d.example/z" }));
  it("keeps a `|` inside the fact and strips backticks / angle brackets", () => expect(lines[4]).toMatchObject({ row: "yen_carry", url: "https://e.example/q", fact: "BoJ: a | b" }));
  it("rejects an unknown status loudly", () => expect(() => parseFindings("x | 2026-11-01 | https://u | fetch | f | maybe")).toThrow(/unknown status "maybe"/));
  it("rejects a malformed date and a short line", () => {
    expect(() => parseFindings("x | Nov 1 | https://u | fetch | f | ok")).toThrow(/malformed date/);
    expect(() => parseFindings("x | 2026-11-01 | https://u | ok")).toThrow(/4 cells/);
  });
});
