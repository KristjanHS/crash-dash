import { describe, expect, it } from "vitest";
import { ALL_INDICATORS } from "./registry.js";
import { CHART_ONLY_INDICATORS, COMPOSITE_INPUTS } from "./registry-composite.js";
import { FEED_OF, INDICATORS } from "./registry-fred.js";
import { PRICE_SCORERS, RS_LEGS } from "./registry-price.js";
import { RATIO_DESCRIPTOR_OF } from "./family-descriptor-rows.js";
import { INPUT_SERIES } from "./input-series.js";
import { isSovereignYield } from "./quote-graft.js";
import { FRED_NOTES, isLicensed, isLicensedEstimateId, isLicensedId, isLicensedSource, levelSourceOf } from "./licensed.js";

const SERVED = [...ALL_INDICATORS, ...CHART_ONLY_INDICATORS];

/** The exhaustive R6 verdict per served id — licensed = the served value is one vendor/restricted source. */
const LICENSED: Readonly<Record<string, boolean>> = {
  F1: true, F2: true, R5: true, F9: true, F10: true, F11: true, OVX: true, F17: true, F4: true, NVDA: true, F8: true,
  DB_SMH: true, DB_XLK: true, EXSH_GATE: true, JPT: true, R6: true, FXH: true, GT: true,
  "price-accel": true, "complacency-vix": true, "complacency-high": true, "complacency-duration": true, SPY: true,
  DEXUSEU: true, SP500IT: true, LEGP_EUFIN: true, LEGP_HEALTH: true, LEGP_COMMOD: true, LEGP_RAFI: true,
  LEGP_SEMIS: true, LEGP_SPIT: true, LEGP_EM: true, LEGP_SPX: true, LEGP_EXUS: true, LEGP_STAPLES: true, VWO: true,
  VGK: true, XDEV: true, KBE: true, CCC: true, HYNIX: true, AMAT: true, KRW: true, COPPER: true, BBB: true,
  VIX: true, VIX3M: true, VXNCLS: true, VXSMH: true, F7: true, ECY: true,
  F3: false, R1: false, R8: false, R2: false, R3: false, R4: false, T10YIE: false, T5YIFR: false, F5: false,
  SPCONC: false, F6: false, F13: false, RS_SMH: false, RS_XLK: false, KBE_RS: false, INS_RS: false, AT1: false,
  MU_RS: false, G1: false, BRENT: false, NG: false, EBP: false, R7: false, CG: false, VT: false, VXNT: false, EURC: false,
  ESTR: false, EPATH: false, HICP: false, ECISS: false, EURGBP: false, BUND: false,
  BONOS: false, GB: false, DISP: false, CQS: false,
  VTP: false, HCX: false, FDX: false, T10Y3M_RAW: false,
};

describe("isLicensed (R6)", () => {
  it("every FRED-loop series carries a recorded FRED_NOTES row", () => {
    const fredLoop = INDICATORS.filter((i) => FEED_OF[i.id] === undefined).map((i) => i.series);
    expect(fredLoop).toContain("BAMLH0A0HYM2"); // vacuity anchor: a stable FRED-loop member
    for (const s of fredLoop) expect(FRED_NOTES[s], s).toBeDefined();
  });

  it("every single-source BAML* (ICE OAS) id is licensed", () => {
    const baml = SERVED.filter((i) => levelSourceOf(i)?.startsWith("BAML"));
    expect(baml.map((i) => i.id)).toEqual(expect.arrayContaining(["F1", "CCC"]));
    for (const ind of baml) expect(isLicensed(ind), ind.id).toBe(true);
  });

  it("every served id carries an explicit verdict, and isLicensed matches it", () => {
    // Key set == served set: a new registry id fails here until it is classified.
    expect(Object.keys(LICENSED).sort()).toEqual(SERVED.map((i) => i.id).sort());
    for (const ind of SERVED) expect(isLicensed(ind), ind.id).toBe(LICENSED[ind.id]);
  });

  it("a composite is licensed iff exactly one of its declared inputs is — the full derived set", () => {
    const composites = SERVED.filter((i) => levelSourceOf(i) === null);
    expect(composites.map((i) => i.id)).toEqual(expect.arrayContaining(["VT", "BUND", "ECY", "F5"])); // vacuity anchor
    // A new composite with one licensed input — or one declaring no inputs (fails closed) — fails here until named.
    expect(composites.filter((i) => isLicensed(i)).map((i) => i.id).sort()).toEqual(["ECY"]);
  });

  it("vendor feeds are licensed sources: sovereign-quote yields, Shiller CAPE, every estimator lead", () => {
    const sovereign = ["FR10Y-FR", "DE10Y-DE", "DE2Y-DE", "FR2Y-FR", "ES10Y-ES", "GB10Y-GB", "IT10Y-IT"];
    const yieldLegs = ["FR10Y", "DE10Y", "DE2Y", "FR2Y", "ES10Y", "GB10Y", "IT10Y"]; // the composites' declared keys
    const leads = SERVED.flatMap((i) => i.estimator?.leads ?? []);
    expect(leads).toEqual(expect.arrayContaining(["CL=F", "BZ=F"])); // oil futures
    const notLicensed = [...sovereign, ...yieldLegs, "F7", ...leads].filter((s) => !isLicensedSource(s));
    expect(notLicensed).toEqual([]);
  });

  it("an unlicensed id's estimate rows are licensed iff its estimator carries exactly one licensed lead — the full set", () => {
    const estimated = SERVED.filter((i) => i.estimator !== undefined);
    expect(estimated.map((i) => i.id)).toEqual(expect.arrayContaining(["G1", "BRENT", "R1", "VT"])); // vacuity anchor
    // Single licensed lead (oil futures, a sovereign-quote yield): the public print lets the lead's move be backed out.
    // Two licensed leads (R1's 10y−3m, T10YIE's TIP÷IEF, VT/VXNT's ratio) stay derived.
    const extra = estimated.filter((i) => !isLicensed(i) && isLicensedEstimateId(i.id)).map((i) => i.id);
    expect(extra.sort()).toEqual(["BRENT", "G1", "R2", "R3"]);
    for (const ind of SERVED.filter((i) => isLicensed(i))) expect(isLicensedEstimateId(ind.id), ind.id).toBe(true);
    expect(isLicensedEstimateId("LEGP_NOT_A_REGISTRY_ROW")).toBe(true);
  });

  it("every declared composite input and estimator lead is a classified source — an unknown name never counts as licensed by default", () => {
    // `isLicensedSource` reads any unknown string as a vendor feed, so a typo'd/new input would push a one-licensed
    // composite to two-licensed (⇒ public). Vendor evidence comes from the fetch-layer rosters, never from the
    // composite / estimator declarations under test; the hand list holds only the vendor tickers no roster names.
    const vendorOnlyHere = ["GOOGL", "META", "MSFT", "AMZN", "TSM", "EWJ", "XLP", "XLV", "VYM", "FEZ", "EEM", "GC=F", "IEI", "^VIX", "TIP", "^VIX3M"];
    const vendor = new Set([
      ...INPUT_SERIES.filter((s) => s.feed === "price").flatMap((s) => [s.id, s.symbol ?? s.id]),
      ...PRICE_SCORERS.flatMap((s) => s.inputs),
      ...RS_LEGS.flatMap((l) => l.symbols),
      ...SERVED.map(levelSourceOf).filter((s): s is string => s !== null),
      ...vendorOnlyHere,
    ]);
    const declared = [
      ...Object.values(COMPOSITE_INPUTS).flat(),
      ...Object.values(RATIO_DESCRIPTOR_OF).flatMap((d) => d.inputs),
      ...SERVED.flatMap((i) => i.estimator?.leads ?? []),
    ];
    expect(declared).toEqual(expect.arrayContaining(["BAA10Y", "F7", "ebp", "DE10Y", "^VIX"])); // vacuity anchor: one per class
    const classified = (s: string): boolean => s in FRED_NOTES || !isLicensedSource(s) || isSovereignYield(s) || vendor.has(s);
    expect([...new Set(declared)].filter((s) => !classified(s))).toEqual([]);
  });

  it("an id outside the registry fails closed", () => {
    expect(isLicensedId("LEGP_NOT_A_REGISTRY_ROW")).toBe(true);
    expect(isLicensedId("KBE_RS")).toBe(false);
  });
});
