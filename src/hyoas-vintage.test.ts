import { describe, expect, it } from "vitest";
import { loadHyOasVintage, loadHyOasVintageAsFiled, parseVintageCsv, readVintageText, requireVintage } from "./hyoas-vintage.js";

const GOOD = "date,value\n1996-12-31,3.13\n1997-01-02,3.06\n1997-01-03,3.09\n";

describe("parseVintageCsv", () => {
  it("parses a well-formed CSV into ascending observations", () => {
    expect(parseVintageCsv(GOOD)).toEqual([
      { date: "1996-12-31", value: 3.13 },
      { date: "1997-01-02", value: 3.06 },
      { date: "1997-01-03", value: 3.09 },
    ]);
  });

  it.each<{ name: string; csv: string; checks?: Parameters<typeof parseVintageCsv>[1]; err: RegExp }>([
    { name: "a bad header", csv: "DATE,VALUE\n1996-12-31,3.13\n", err: /bad header/ },
    { name: "a malformed row (extra column)", csv: "date,value\n1996-12-31,3.13,x\n", err: /malformed row/ },
    { name: "a non-ISO date", csv: "date,value\n12/31/1996,3.13\n", err: /non-ISO date/ },
    { name: "a non-finite value", csv: "date,value\n1996-12-31,nope\n", err: /out-of-range/ },
    { name: "a value above 30 (accepts 0-30 only)", csv: "date,value\n1996-12-31,31.5\n", err: /out-of-range/ },
    { name: "a value below 0 (accepts 0-30 only)", csv: "date,value\n1996-12-31,-0.1\n", err: /out-of-range/ },
    { name: "a descending date", csv: "date,value\n1997-01-02,3.06\n1996-12-31,3.13\n", err: /not ascending/ },
    { name: "a duplicate date", csv: "date,value\n1996-12-31,3.13\n1996-12-31,3.13\n", err: /not ascending/ },
    { name: "a first date off the expected anchor", csv: GOOD, checks: { firstDate: "1996-12-30" }, err: /first date/ },
    { name: "a row count below the floor", csv: GOOD, checks: { minRows: 7000 }, err: /only 3 rows/ },
  ])("throws on $name", ({ csv, checks, err }) => {
    expect(() => parseVintageCsv(csv, checks)).toThrow(err);
  });
});

// The vintage file is not distributed with this repository: the integration block runs only when present.
describe.skipIf(readVintageText() === undefined)("loadHyOasVintage (integration: vintage file)", () => {
  it("loads the real vintage and passes validation", () => {
    const obs = requireVintage(loadHyOasVintage());
    expect(obs.length).toBeGreaterThanOrEqual(7000);
    expect(obs[0]).toEqual({ date: "1996-12-31", value: 3.13 });
    expect(obs[obs.length - 1]?.date).toBe("2025-04-10");
    // cached: second call returns the same array instance
    expect(loadHyOasVintage()).toBe(obs);
  });

  it("drops the file's ICE BofA weekend month-end marks; the as-filed loader keeps them", () => {
    const isWeekend = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() % 6 === 0;
    const filed = requireVintage(loadHyOasVintageAsFiled());
    expect(filed.some((o) => isWeekend(o.date))).toBe(true); // premise: the committed file carries weekend marks
    expect(loadHyOasVintage()).toEqual(filed.filter((o) => !isWeekend(o.date)));
  });
});

describe("absent vintage file", () => {
  it("reads as undefined only when the file is missing; any other read error still throws", () => {
    expect(readVintageText(new URL("./no-such-vintage.csv", import.meta.url))).toBeUndefined();
    expect(() => readVintageText(new URL("./", import.meta.url))).toThrow(/EISDIR/);
  });

  it("requireVintage names the missing file for callers that cannot degrade", () => {
    expect(() => requireVintage(undefined)).toThrow(/vintage CSV absent: .*BAMLH0A0HYM2-vintage\.csv/);
  });
});
