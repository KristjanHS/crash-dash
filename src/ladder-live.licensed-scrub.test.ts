import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LEGS, type LadderLegId } from "./ladder-live.js";
import { findLicensedLevels, findLicensedLevelsInLeg, LICENSED_ALIASES, scrubLicensedLevels, scrubLicensedLevelsInLeg } from "./licensed-levels.js";

const ROOT = new URL("..", import.meta.url);

describe("licensed index levels are not published — the committed leg JSONs", () => {
  for (const leg of Object.keys(LEGS) as LadderLegId[]) {
    it(`${LEGS[leg].json} prints no observed licensed level`, () => {
      const live: unknown = JSON.parse(readFileSync(new URL(LEGS[leg].json, ROOT), "utf8"));
      expect(findLicensedLevelsInLeg(live)).toEqual([]);
    });
  }
});

describe("scrubLicensedLevels — observed values → —", () => {
  const cases: [string, string][] = [
    ["FRED close 11-03 CCC 13.16 %", "FRED close 11-03 CCC —"],
    ["RV20 9.9/14.3✓ · VIX 16.61/20.70✗", "RV20 9.9/14.3✓ · VIX —/20.70✗"], // RV20: no licensed subject in context
    ["bear = IG ≥ 1.10 % while held, or ≥ 1.21 % (the 2025 peak) after T1", "bear = IG ≥ 1.10 % while held, or ≥ — (the 2025 peak) after T1"],
    ["FRED close 11-03 BB 2.03 % is back over 2.0 % from FRED 1.84 % close 10-28", "FRED close 11-03 BB — is back over 2.0 % from FRED — close 10-28"],
    ["VIX rose, FRED 21.15 close 11-02 — under the 25 line", "VIX rose, FRED — close 11-02 — under the 25 line"],
    ["BB carries the watch: 2.5 % correction, 3.0 % bear (2025 peaked at 3.06)", "BB carries the watch: 2.5 % correction, 3.0 % bear (2025 peaked at —)"],
    ["HY 3.40/3.08 (peak 3.44 10-30 base 2.71) · 2/10 closes", "HY —/3.08 (peak — 10-30 base —) · 2/10 closes"],
    ["RY Δ63 0.25/0.50 · HY Δ63 0.69/0.30", "RY Δ63 0.25/0.50 · HY Δ63 —/0.30"],
    // A `<mult>×<level>` threshold prints the product (the base's decimals and unit): the multiplier is ours, the base the series' observed MA.
    ["MOVE 98.79 > 1.3×73.39", "MOVE — > 95.41"],
    ["VXSMH — ≤ 1.2×43.70 @11-23", "VXSMH — ≤ 52.44 @11-23"],
    ["HY 3.40 > 1.25 × 2.71 %", "HY — > 3.39 %"],
    ["CCC under 2×1,050 bp", "CCC under 2,100 bp"],
    ["VIX > 1.3x73.39", "VIX > 95.41"], // an ASCII `x` multiplier is a `×`
    // No comparison before it: the product would read as an observed level (and re-scan as one), so the span is `—`.
    ["VIX 1.2×18.5", "VIX —"],
    ["VIX 1.3x73.39", "VIX —"],
    ["MOVE trips at 1.3×73.39", "MOVE trips at —"],
    ["MOVE > 1.3×73.39 close 11-03", "MOVE > — close 11-03"], // a print annotation after it quotes it
    ["CCC Δ20 +39bp · 3.54%", "CCC Δ20 — · —"],
    ["BBB 1.11 · Δ10 +0.04 · low 0.92", "BBB — · Δ10 — · low —"],
    ["unarmed: BBB widened 0.18 < 0.23 (peak 1.17 11-02 base 0.99)", "unarmed: BBB widened — < 0.23 (peak — 11-02 base —)"],
    ["CCC OAS 13.25 % close 10-29, still above the 12.5 % bear line but off its 13.56 % 10-23 high", "CCC OAS — close 10-29, still above the 12.5 % bear line but off its — 10-23 high"],
    ["CAPE 38.4 close 10-31", "CAPE — close 10-31"],
    // Integer prints: a bp / % unit, a print verb, an OAS between label and number, a thousands group, a range.
    ["HY OAS 312 bp", "HY OAS —"],
    ["HY OAS 312", "HY OAS —"], // OAS between label and number is transparent
    ["HY sits near 312 bp", "HY sits near —"], // an unsigned unit alone makes a candidate
    ["HY at 312 bp", "HY at —"],
    ["HY now 312 bp", "HY now —"],
    ["VIX ended at 22", "VIX ended at —"],
    ["VIX rose to 24", "VIX rose to —"],
    ["VIX peaked 52 in April 2025", "VIX peaked — in April 2025"],
    ["MOVE at 105", "MOVE at —"],
    ["CCC 1,050 bp", "CCC —"],
    ["VIX 22.1–23.4 range", "VIX —–— range"],
    ["VIX 2025 high 52.3", "VIX 2025 high —"], // the year stays, the level goes
    // CLOSE: a vendor equity / ETF / FX / commodity close (11.6c) — the price goes, the move, criterion and ✓/✗ stay.
    ["SPX closed LSEG 7,688.62 close 11-04", "SPX closed LSEG — close 11-04"], // a source after the print verb is transparent
    ["SPX 6,750 close 10-24, under the 1.10× fizzle line", "SPX — close 10-24, under the 1.10× fizzle line"],
    ["MU 778.31", "MU —"],
    ["MU 707.70 · -41.7% off 250-close high", "MU — · -41.7% off 250-close high"],
    ["tradingnews USD/JPY 159.666 intraday 11-11, just under the 160 line", "tradingnews USD/JPY — intraday 11-11, just under the 160 line"],
    ["USD/JPY near 158 (FXStreet 10-30)", "USD/JPY near — (FXStreet 10-30)"], // a source-dated parenthetical quotes it
    ["DRAM spot 60.27", "DRAM spot —"],
    ["MU $112.40", "MU —"], // a `$` close: the span takes the `$`
    ["DRAM spot $3.85", "DRAM spot —"],
    ["MU $112 close 11-04", "MU — close 11-04"], // a `$` integer on a close is a price, not a count
    ["SPX — 6,750 close", "SPX — — close"], // a grouped number before `close` is a print, dated or not
    ["SEC0 14.44 · MA50 16.86 · MA200 15.92", "SEC0 — · MA50 — · MA200 —"], // an MA of a close is that close's transform
    ["SXR8 730.28 ≥ MA200 683.13 · MA ≥ 677.93 (10 back)", "SXR8 — ≥ MA200 — · MA ≥ — (10 back)"],
    ["XDEV 72.43 >MA50 73.60✗ · MA50 Δ10 0.180>0✓", "XDEV — >MA50 —✗ · MA50 Δ10 0.180>0✓"], // a Δn on a close is a move
  ];
  it.each(cases)("%s", (input, want) => {
    expect(findLicensedLevels(input)).not.toEqual([]); // the apply refusal fires on the same form
    expect(scrubLicensedLevels(input)).toBe(want);
    expect(scrubLicensedLevels(want)).toBe(want); // idempotent
    expect(findLicensedLevels(want)).toEqual([]); // scan-stable: the scrubbed string is never refused
  });

  it("a structured value with no label takes the context subject; a dated slash half is a print", () => {
    expect(scrubLicensedLevels("3.20/3.09 (peak 3.48 11-05 base 2.71) · easing: HY Δ30 -0.01 ≤ 0.22 · 3.20 < 10-close high 3.48", { subject: "HY" })).toBe(
      "—/3.09 (peak — 11-05 base —) · easing: HY Δ30 — ≤ 0.22 · — < 10-close high —",
    );
    expect(scrubLicensedLevels("3.40/3.44 (10-30)", { subject: "HY" })).toBe("—/— (10-30)");
    expect(scrubLicensedLevels("3.40/3.44 (10-30)", { subject: "RS_SMH" })).toBe("3.40/3.44 (10-30)");
  });

  it("echo: a kept threshold repeating a scrubbed level is that level", () => {
    expect(scrubLicensedLevels("3.54/3.28 (peak 3.64 10-23 base 2.57) · max5 3.59 <3.64✓", { subject: "CCC" })).toBe("—/3.28 (peak — 10-23 base —) · max5 — <—✓");
  });

  const kept: string[] = [
    "bear = BB ≥ 2.5 % ; fizzle = CCC < 11.5 %", // our own thresholds
    "bear = HY ≥ 3.60 % (+100 bp over its 6-mo low) or HY crosses 4.0 % from below", // bp delta = relative criterion
    "HY peaked within ±10 days of the SPX trough in 9 of 12 episodes", // counts, not levels
    "RV20 9.9/14.3✓", // no licensed subject in context
    "FRED close 11-03 CCC far above the 11.5 % fizzle line, 11-03", // dates
    "VIX/VIX3M ≥ 1.00 on 3 closes (the 2022 bear peaked at 1.02)", // a ratio of two licensed series is derived
    "armed at peak ≥ min(base, exit close) + 0.23 for BBB", // arithmetic in a criterion
    "ORCL BBB- [S: E §1]; MU −4.7 % on 10-08", // a rating, then another clause
    "5 VIX closes ≥ 25 led to a ≥ 15 % drawdown in 15 of 19 cases since 1997",
    // CLOSE subjects: dates, moves, shares, our criteria, counts, money and rule text stay (11.6c over-scrub guards).
    "SEC0 2026-10-05 high 1.32× its MA200", // a date and a multiplier
    "NVDA −2.94 %, MU −4.7 %, AVGO −4.1 % on 10-08", // signed % moves
    "SOX closed −3.13 % on 11-04",
    "MU FQ1 GM vs the 86.25 % guide", // a % is never a close
    "MU 12 % of SMH",
    "MU ≤ −20% off 250-close high", // our criteria
    "SEC0 off high > −10%",
    "XDEV +0.6%/-2.1% · MU -7.0%/-8%",
    "SPX < MA200 on 3 closes",
    "QDVE ≥ −3σ ×5",
    "Nasdaq SOX member sheet of 11-02: 0 of 30 (0 %) above MA50", // share counts
    "NVDA 3 analysts raised",
    "NVDA 3 beats in a row", // a bare integer on a close is a count unless grouped, quoted or after a print verb
    "SPX 30 members above MA50",
    "SPX trough in 9 of 12 episodes",
    "NVDA beats $108 B", // money is not a close
    "MU guided $12.5 bn in capex",
    "MU revenue $1.2T",
    "VIX $20 calls", // a `$` number on an index subject is money
    "SPX 6750", // an ungrouped bare integer on a close stays a count by design
    "SEC0 high 1.32x its MA200", // an ASCII multiplier with no base
    "record 3Q26 revenue KRW 104.6T",
    "RSP_SPY 0.2819/0.2802✓ · KBE/SPY +7.8%/-10.0%", // a ratio is derived
    "MU_RS > MA50 (±1% ×2), MA50 Δ10 > 0",
    "https://fred.stlouisfed.org/series/BAMLH0A3HYC",
    // Counts, years and hyphenated modifiers are never levels.
    "VIX 2 closes over 25",
    "CCC 5 closes over the line",
    "VIX 3 of 5 closes ≥ 25",
    "VIX 2 days",
    "VIX 2025 peak",
    "HY 2026 Q1 low",
    "HY 10-close high",
    // Our own criteria: a criterion noun, a comparison tail, a deadline.
    "VIX 25 trigger",
    "CCC 12.5 or above",
    "HY 4.0 % or wider",
    "VIX 30+ escalates",
    "HY 3.5 % level",
    "HY 0.22 velocity cap",
    "VIX 17.5 (our re-entry line)",
    "VIX 25 by 12-05",
    "MOVE 100 is the escalation",
    "HY: no close past its since-shock 50% line ×5", // a % criterion and a ×n count
    "HY trips at its mean ×1.25", // a multiplier after a bare × is ours
    "VIX < 25 ×5", // a spaced `×n` after a threshold is a count, never a multiplier's base
    "HY still under the 3.60 % correction line and nowhere near a 75 bp retrace", // a move size, not a level
  ];
  it.each(kept)("keeps %s", (text) => {
    expect(findLicensedLevels(text)).toEqual([]);
    expect(scrubLicensedLevels(text)).toBe(text);
  });

  it("the alias set carries the licensed.ts index families and no derived or public series", () => {
    for (const a of ["HY", "CCC", "IG", "BB", "VIX", "VIX3M", "MOVE", "CAPE", "BAMLH0A3HYC", "VIXCLS"]) expect(LICENSED_ALIASES.has(a), a).toBe(true);
    for (const a of ["VIX/VIX3M", "RV20", "RY", "NFCI", "T10Y3M", "DGS10"]) expect(LICENSED_ALIASES.has(a), a).toBe(false);
  });

  it("the alias set carries every licensed close: registry ids, source tickers and the pinned prose names — never a ratio, a derived series or an id code", () => {
    for (const a of ["SPX", "MU", "USD/JPY", "DRAM", "SEC0", "SXR8", "QDVE", "XDEV", "EXSH", "SPY", "NVDA"]) expect(LICENSED_ALIASES.has(a), a).toBe(true);
    for (const a of ["KBE/SPY", "RSP_SPY", "MU_RS", "RS_SMH", "HCX", "F8", "AT1"]) expect(LICENSED_ALIASES.has(a), a).toBe(false);
  });
});

describe("scrubLicensedLevelsInLeg — the <leg>:scrub writer", () => {
  const fixture = {
    run: "2026-11-04 HY 3.40",
    runAt: "2026-11-04T21:00:00Z",
    runs: [{ date: "2026-11-04", t1: "HY 3.40 ✗", live: "✗✗✗" }],
    signs: [{ finding: "FRED close 11-03 CCC 13.16 %", measurable: "bear = CCC ≥ 12.5 %", sources: [{ url: "https://fred.stlouisfed.org/series/BAMLH0A3HYC" }] }],
    verdict: {
      asOf: "HY 3.40",
      legs: [
        { tag: { indicator: "HY OAS" }, rule: "no close past its since-shock 50% line ×5", value: "3.40/3.20 (peak 3.44 10-30 base 2.71)", live: { value: "3.33/3.20 @11-04 est." } },
        { tag: { indicator: "MOVE" }, rule: "MOVE > 1.3×250d median", value: "MOVE 98.79 > 1.3×73.39", live: { value: "MOVE 98.79 > 1.3×73.39 @11-04" } },
      ],
    },
  };

  it("scrubs prose + leg values, leaves the run stamps and history byte-identical, and is idempotent", () => {
    const { live, count } = scrubLicensedLevelsInLeg(fixture);
    expect(count).toBe(9);
    expect(live.signs[0]!.finding).toBe("FRED close 11-03 CCC —");
    expect(live.signs[0]!.measurable).toBe("bear = CCC ≥ 12.5 %");
    expect(live.verdict.legs[0]!.value).toBe("—/3.20 (peak — 10-30 base —)");
    expect(live.verdict.legs[0]!.live.value).toBe("—/3.20 @11-04 est.");
    expect([live.verdict.legs[1]!.rule, live.verdict.legs[1]!.value, live.verdict.legs[1]!.live.value]).toEqual(["MOVE > 1.3×250d median", "MOVE — > 95.41", "MOVE — > 95.41 @11-04"]);
    expect([live.run, live.runAt, live.runs, live.verdict.asOf, live.signs[0]!.sources]).toEqual([fixture.run, fixture.runAt, fixture.runs, fixture.verdict.asOf, fixture.signs[0]!.sources]);
    const again = scrubLicensedLevelsInLeg(live);
    expect(again.count).toBe(0);
    expect(again.live).toEqual(live);
  });

  it("nulls a licensed id's shocks numbers, keeps its dates and flags and every public id's numbers", () => {
    const shock = { base: 2.57, peak: 3.64, peakDate: "2026-10-23", last: 3.54, lastDate: "2026-11-03", sigma: 0.04, broke: true };
    const leg = { verdict: { shocks: { CCC: shock, FXH: { ...shock, base: 18.2 }, BUND: { ...shock, base: 65 }, BONOS: null } } };
    expect(findLicensedLevelsInLeg(leg).map((h) => h.path)).toEqual(["CCC", "FXH"].flatMap((id) => ["base", "peak", "last", "sigma"].map((k) => `.verdict.shocks.${id}.${k}`)));
    const { live, count } = scrubLicensedLevelsInLeg(leg);
    expect(count).toBe(8);
    expect(live.verdict.shocks.CCC).toEqual({ ...shock, base: null, peak: null, last: null, sigma: null });
    expect([live.verdict.shocks.BUND, live.verdict.shocks.BONOS]).toEqual([leg.verdict.shocks.BUND, null]);
    expect(findLicensedLevelsInLeg(live)).toEqual([]);
  });

  it("a close tag's structured value scrubs, a derived series of that one close included (`RV10` under `EXSH`)", () => {
    const leg = {
      verdict: {
        legs: [
          { tag: { indicator: "QDVE" }, rule: "no new low since the drawdown opened ×5", value: "no low 42.07/42.01 (11-05)" },
          { tag: { indicator: "EXSH" }, rule: "RV10 fading, or ≤ 1.5× base", value: "17.5 ≤18.6 (23.3 10-14)✓ <11.6 (10-28)✗ | ≤15.7✗" },
        ],
      },
    };
    const { live, count } = scrubLicensedLevelsInLeg(leg);
    expect([live.verdict.legs[0]!.value, live.verdict.legs[1]!.value, count]).toEqual(["no low —/— (11-05)", "— ≤18.6 (— 10-14)✓ <— (10-28)✗ | ≤15.7✗", 5]);
  });

  it("a labelled realized vol of the tag's close scrubs as that close (`RV20` under `XDEV`, `RV10` under `EXSH`)", () => {
    const refused = { verdict: { legs: [{ tag: { indicator: "EXSH" }, rule: "RV10 ≤ 1.5× base", value: "RV10 17.5/15.7" }] } };
    expect(findLicensedLevelsInLeg(refused).map((h) => h.hit)).toEqual(["EXSH 17.5"]);
    const leg = { verdict: { legs: [{ tag: { indicator: "XDEV RV · VIX" }, rule: "RV20 ≤ 1.2× base", value: "RV20 9.9/14.3✓ · VIX 16.61/20.70✗", live: { value: "RV20 9.9/14.3✓ · VIX —/20.70✗" } }] } };
    const { live, count } = scrubLicensedLevelsInLeg(leg);
    expect([live.verdict.legs[0]!.value, live.verdict.legs[0]!.live.value, count]).toEqual(["RV20 —/14.3✓ · VIX —/20.70✗", "RV20 —/14.3✓ · VIX —/20.70✗", 3]);
    expect(scrubLicensedLevels("RV20 9.9/14.3✓", { subject: "EXSH" })).toBe("RV20 —/14.3✓");
    expect(scrubLicensedLevels("RV20 9.9/14.3✓", { subject: "RS_SMH" })).toBe("RV20 9.9/14.3✓");
  });

  it("a rule opening on a ratio under a close tag measures the ratio: its values stay; a pinned pair is one series", () => {
    const ratio = { verdict: { legs: [{ tag: { indicator: "EXSH" }, rule: "EXSH/SPY RS at a 60-close low", value: "0.952/0.948 (11-05)" }] } };
    expect(findLicensedLevelsInLeg(ratio)).toEqual([]);
    expect(scrubLicensedLevelsInLeg(ratio)).toEqual({ live: ratio, count: 0 });
    const pair = { verdict: { legs: [{ tag: { indicator: "XDEV" }, rule: "USD/JPY over the 160 line", value: "159.67 (11-11)" }] } };
    expect(findLicensedLevelsInLeg(pair).map((h) => h.hit)).toEqual(["USD/JPY 159.67"]);
  });

  it("a joined tag's subject is its first id (`EXSH+VSTOXX` → EXSH); a trailing `+` is still a rating", () => {
    const leg = { verdict: { legs: [{ tag: { indicator: "EXSH+VSTOXX" }, value: "17.5/15.7" }] } };
    expect(findLicensedLevelsInLeg(leg).map((h) => h.hit)).toEqual(["EXSH 17.5"]);
    expect(findLicensedLevels("ORCL BBB+ [S: E §1] 3.20")).toEqual([]);
  });

  it("the script imports no notifier and stamps no run", () => {
    const src = readFileSync(new URL("scripts/ladder-scrub.ts", ROOT), "utf8");
    const imports = src.split("\n").filter((l) => /^import /.test(l));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((l) => /ntfy|ladder-run|ladder-reverdict|probe-/.test(l))).toEqual([]);
    expect(src).toContain("scrubLicensedLevelsInLeg(");
  });
});
