import { expect, test, describe } from "vitest";
import { parseEbpCsv } from "./ebp.js";

describe("parseEbpCsv (federalreserve.gov EBP monthly CSV)", () => {
  const HEADER = "date,gz_spread,ebp,est_prob";

  test("picks the ebp column (not gz_spread), keeping the monthly date", () => {
    const csv = [
      HEADER,
      "1973-01-01,1.1307,-0.0468,0.1862",
      "1973-02-01,1.0754,-0.0581,0.1824",
    ].join("\n");
    expect(parseEbpCsv(csv)).toEqual([
      { date: "1973-01-01", value: -0.0468 },
      { date: "1973-02-01", value: -0.0581 },
    ]);
  });

  test("resolves columns BY HEADER NAME - a reorder still maps to ebp, not position 2", () => {
    const csv = ["ebp,date,gz_spread", "0.9,2026-05-01,1.2"].join("\n");
    expect(parseEbpCsv(csv)).toEqual([{ date: "2026-05-01", value: 0.9 }]);
  });

  test("drops blank lines, missing-value rows ('.'/empty), and non-numeric ebp", () => {
    const csv = [
      HEADER,
      "2026-01-01,1.0,1.5,0.2",
      "",
      "2026-02-01,1.0,.,0.2", // missing ebp
      "2026-03-01,1.0,,0.2", // empty ebp
      "2026-04-01,1.0,NaNish,0.2", // non-numeric
      "2026-05-01,1.0,2.0,0.2",
    ].join("\n");
    expect(parseEbpCsv(csv)).toEqual([
      { date: "2026-01-01", value: 1.5 },
      { date: "2026-05-01", value: 2.0 },
    ]);
  });

  test("tolerates CRLF line endings (no guaranteed encoding from the Fed host)", () => {
    const csv = `${HEADER}\r\n2026-04-01,0.9,-0.21,0.13\r\n2026-05-01,0.8,-0.39,0.09\r\n`;
    expect(parseEbpCsv(csv)).toEqual([
      { date: "2026-04-01", value: -0.21 },
      { date: "2026-05-01", value: -0.39 },
    ]);
  });

  test("empty / header-only input yields []", () => {
    expect(parseEbpCsv("")).toEqual([]);
    expect(parseEbpCsv(HEADER)).toEqual([]);
  });

  test("throws when the ebp column is absent (guards a silent wrong-column map)", () => {
    expect(() => parseEbpCsv("date,gz_spread,est_prob\n2026-05-01,1.0,0.2")).toThrow(/ebp/);
  });

  // The 2026-08-06 incident: the Fed switched this file from YYYY-MM-DD to M/D/YYYY.
  // Un-normalized, "7/1/2026" outsorts every real ISO date under the lexicographic max
  // that picks the run's asOf, so the run dated itself at a day with no data.
  test("normalizes the Fed's M/D/YYYY dates to ISO, zero-padding month and day", () => {
    const csv = [HEADER, "7/1/2026,0.84,-0.319,0.108", "12/1/2025,0.9,-0.28,0.11"].join("\n");
    expect(parseEbpCsv(csv)).toEqual([
      { date: "2026-07-01", value: -0.319 },
      { date: "2025-12-01", value: -0.28 },
    ]);
  });

  test("throws on a THIRD date format rather than leaking an unsortable string", () => {
    expect(() => parseEbpCsv([HEADER, "01-Jul-2026,0.84,-0.319,0.108"].join("\n"))).toThrow(
      /neither YYYY-MM-DD nor M\/D\/YYYY/,
    );
  });
});
