import { describe, it, expect } from "vitest";
import { BUND_MAX_STALE_DAYS, fetchBundYield, parseBundesbankCsv } from "./bundesbank.js";

// Fixtures inline as template strings — the repo convention (ecb.test.ts
// inline; there is no fixtures/ dir).
//
// ⚠ The preamble below is the shape of the RETIRED host — captured live 2026-07-25 from the
// `www.bundesbank.de` legacy CSV export, which the Bundesbank decommissioned and production
// left on 2026-08-08 (`bundesbank.ts` docblock). Production now reads
// `api.statistiken.bundesbank.de`, whose preamble is the LONGER 9-line form this comment used
// to call "the retired host's" — it carries `Comment (in english)`, `Decimals`,
// `Time format code` and `category` on top of the five lines below.
//
// Kept deliberately rather than re-captured: the parser skips the preamble BY SHAPE (first
// field matches `YYYY-MM-DD`), never by line count, so a fixture with a SHORTER preamble than
// production is the stricter test of exactly that property — a length-based parser would pass
// on the live shape and fail here. Nothing pins the live 9-line preamble, and nothing needs to:
// the shape test below covers preamble growth in either direction.
const PREAMBLE = `﻿"",BBSIS.D.I.ZST.ZI.EUR.S1311.B.A604.R10XX.R.A.A._Z._Z.A,BBSIS.D.I.ZST.ZI.EUR.S1311.B.A604.R10XX.R.A.A._Z._Z.A_FLAGS
"",Term structure of interest rates on listed Federal securities (method by Svensson) / residual maturity of 10.0 years / daily data,
unit,Prozent,
unit multiplier,one,
last update,2026-07-24 12:27:29,`;

describe("parseBundesbankCsv", () => {
  it("skips the metadata preamble and parses the observation rows", () => {
    const obs = parseBundesbankCsv(`${PREAMBLE}
2026-07-16,3.21,
2026-07-17,3.19,`);
    expect(obs).toEqual([
      { date: "2026-07-16", value: 3.21 },
      { date: "2026-07-17", value: 3.19 },
    ]);
  });

  it("skips the preamble BY SHAPE, not by line count", () => {
    // A preamble that grew by three lines must not eat the first three observations.
    const obs = parseBundesbankCsv(`${PREAMBLE}
extra metadata line,whatever,
another one,42,
source,Deutsche Bundesbank,
2026-07-17,3.19,`);
    expect(obs).toEqual([{ date: "2026-07-17", value: 3.19 }]);
  });

  it("drops a `.` holiday row", () => {
    const obs = parseBundesbankCsv(`${PREAMBLE}
2026-07-16,.,No value available
2026-07-17,3.19,`);
    expect(obs).toEqual([{ date: "2026-07-17", value: 3.19 }]);
  });

  it('drops a row whose value is the literal "No value available"', () => {
    const obs = parseBundesbankCsv(`${PREAMBLE}
2026-07-16,No value available,
2026-07-17,3.19,`);
    expect(obs.map((o) => o.date)).toEqual(["2026-07-17"]);
  });

  it("does NOT turn an empty value field into 0", () => {
    // The spurious-zero regression: Number("") === 0 is finite, so a parser without the
    // empty guard silently injects a 0 that corrupts the 20d velocity window downstream.
    // This test must FAIL against such a parser — hence the explicit value assertion.
    const obs = parseBundesbankCsv(`${PREAMBLE}
2026-07-16,,
2026-07-17,3.19,`);
    expect(obs).toEqual([{ date: "2026-07-17", value: 3.19 }]);
    expect(obs.some((o) => o.value === 0)).toBe(false);
  });

  it("sorts ascending by date and dedups (last wins)", () => {
    const obs = parseBundesbankCsv(`${PREAMBLE}
2026-07-17,3.19,
2026-07-15,3.25,
2026-07-16,9.99,
2026-07-16,3.21,`);
    expect(obs).toEqual([
      { date: "2026-07-15", value: 3.25 },
      { date: "2026-07-16", value: 3.21 },
      { date: "2026-07-17", value: 3.19 },
    ]);
  });

  it("tolerates \\r\\n line endings", () => {
    const obs = parseBundesbankCsv("last update,2026-07-17 13:02:08,\r\n2026-07-17,3.19,\r\n");
    expect(obs).toEqual([{ date: "2026-07-17", value: 3.19 }]);
  });

  it("returns nothing for empty or garbage input (the caller throws)", () => {
    expect(parseBundesbankCsv("")).toEqual([]);
    expect(parseBundesbankCsv(PREAMBLE)).toEqual([]);
    expect(parseBundesbankCsv("<html><body>503</body></html>")).toEqual([]);
  });
});

describe("fetchBundYield error surface", () => {
  // The Enodia challenge answers 303 -> /.enodia/challenge; `fetch` follows it, so `res.status`
  // is the challenge page's, and only `res.url` distinguishes it from a real bad request.
  const ENODIA = "https://api.statistiken.bundesbank.de/.enodia/challenge?redirect=%2Frest%2Fdownload";
  it.each<{ name: string; maturity: "Y02" | "Y10"; res: () => Response; err: RegExp }>([
    {
      name: "names the Enodia bot challenge rather than reporting its page's bare 400",
      maturity: "Y10",
      res: () => Object.defineProperty(new Response("<!doctype html>", { status: 400, statusText: "Bad Request" }), "url", { value: ENODIA }),
      err: /blocked for Y10.*Enodia bot challenge/s,
    },
    {
      name: "keeps the plain status throw for a non-challenge failure",
      maturity: "Y02",
      res: () => new Response("", { status: 503, statusText: "Service Unavailable" }),
      err: /Bundesbank fetch failed for Y02: 503/,
    },
    {
      name: "throws on a 200 whose body parses to zero observations",
      maturity: "Y10",
      res: () => new Response("<html><body>ok</body></html>", { status: 200 }),
      err: /zero parsable observations for Y10/,
    },
  ])("$name", async ({ maturity, res, err }) => {
    await expect(fetchBundYield(maturity, { now: "2026-08-08", fetchImpl: async () => res() })).rejects.toThrow(err);
  });

  it("throws on a dead-but-200 feed, and only past BUND_MAX_STALE_DAYS", async () => {
    const newest = "2026-08-03";
    const plusDays = (d: number) => new Date(Date.parse(newest) + d * 86_400_000).toISOString().slice(0, 10);
    const fetchImpl = async () => new Response(`${PREAMBLE}\n${newest},3.21,`, { status: 200 });
    await expect(fetchBundYield("Y10", { now: plusDays(BUND_MAX_STALE_DAYS), fetchImpl })).resolves.toHaveLength(1);
    await expect(fetchBundYield("Y10", { now: plusDays(BUND_MAX_STALE_DAYS + 1), fetchImpl })).rejects.toThrow(
      /feed stale for Y10: newest observation 2026-08-03/,
    );
  });
});
