/** R6: the ONLY licensed-data classifier — the served value is ONE vendor/restricted source or a
 *  single-input transform of it; a ≥2-input ratio/composite/score is derived unless exactly ONE of its
 *  declared inputs is licensed (the public rest would let that one be backed out of the served value). */
import { type Indicator } from "./domain-types.js";
import { FAMILY_OF, RATIO_DESCRIPTOR_OF } from "./family-descriptor-rows.js";
import { ALL_INDICATORS } from "./registry.js";
import { CHART_ONLY_INDICATORS, COMPOSITE_INPUTS } from "./registry-composite.js";
import { PRICE_SCORERS, RS_LEGS } from "./registry-price.js";

/** FRED series the registry reads → its FRED-page notes (fetched 2026-10-10). `restricted` = the notes
 *  forbid reproduction / grant permission only (ICE, the index publisher, Moody's); the rest are public / citation-only. */
export const FRED_NOTES: Readonly<Record<string, { publisher: string; restricted: boolean }>> = {
  BAMLH0A0HYM2: { publisher: "ICE Data Indices", restricted: true },
  BAMLC0A0CM: { publisher: "ICE Data Indices", restricted: true },
  BAMLEMCBPIOAS: { publisher: "ICE Data Indices", restricted: true },
  BAMLH0A3HYC: { publisher: "ICE Data Indices", restricted: true },
  BAMLC0A4CBBB: { publisher: "ICE Data Indices", restricted: true },
  VIXCLS: { publisher: "CBOE (reprinted with permission)", restricted: true },
  VXVCLS: { publisher: "CBOE (reprinted with permission)", restricted: true },
  VXNCLS: { publisher: "CBOE (reprinted with permission)", restricted: true },
  BAA10Y: { publisher: "Moody's", restricted: true },
  AAA10Y: { publisher: "Moody's", restricted: true },
  NFCIRISK: { publisher: "Chicago Fed (citation required)", restricted: false },
  T10Y3M: { publisher: "St. Louis Fed (citation required)", restricted: false },
  T10Y2Y: { publisher: "St. Louis Fed (citation required)", restricted: false },
  T10YIE: { publisher: "St. Louis Fed (citation required)", restricted: false },
  T5YIFR: { publisher: "St. Louis Fed (citation required)", restricted: false },
  DGS10: { publisher: "Fed Board H.15 (public domain)", restricted: false },
  DGS2: { publisher: "Fed Board H.15 (public domain)", restricted: false },
  DGS3MO: { publisher: "Fed Board H.15 (public domain)", restricted: false },
  DFII10: { publisher: "Fed Board H.15 (public domain)", restricted: false },
  DEXUSEU: { publisher: "Fed Board H.10 (public domain)", restricted: false },
  DCOILWTICO: { publisher: "EIA (public domain)", restricted: false },
  DCOILBRENTEU: { publisher: "EIA (public domain)", restricted: false },
  DHHNGSP: { publisher: "EIA (public domain)", restricted: false },
  CPIAUCSL: { publisher: "BLS (public domain)", restricted: false },
  CP0000EZ19M086NEST: { publisher: "Eurostat (EU copyright, reuse permitted)", restricted: false },
};

/** Non-FRED public-sector / academic sources, keyed by `Indicator.series` or a declared input — never licensed. */
const PUBLIC_SOURCES: Readonly<Record<string, string>> = {
  ebp: "Fed Board EBP CSV",
  NTFS: "Fed Board GSW yield curve",
  ESTR: "ECB",
  ECISS: "ECB",
  EURGBP: "ECB reference rate",
  SR_10Y: "ECB yield curve",
  SR_3M: "ECB yield curve",
  SR_1Y: "ECB yield curve",
  IUDMNPY: "Bank of England series database",
};

/** Ids whose served `value` is ONE source although config says otherwise (multi-input scorer storing one
 *  close; a single-input "composite") — the only hand-set rows. */
const LEVEL_SOURCE_OF: Readonly<Record<string, string>> = {
  F4: "SMH", // level = the SMH close (NVDA rides as a gate)
  EXSH_GATE: "EXSH.DE", // level = the EXSH close (EXSA only in the rel-strength check)
  DEXUSEU: "EURUSD=X", // stored from the `EURUSD=X` daily close (`fetchDailyCloses`), not FRED (the row's `series` is the store id)
  R6: "^MOVE",
  FXH: "EURUSD=X", // level = the EURUSD=X close (CHF=X/JPY=X only in the haven-move state)
  R7: "T10Y3M", // level = the T10Y3M term spread (DGS2/DGS10 drive only the state)
  GT: "ACWI",
  ESTR: "ESTR",
  EURGBP: "EURGBP",
};

/** id → its declared inputs: PRICE_SCORERS' and RS_LEGS' own, the ratio-spread descriptors', COMPOSITE_INPUTS. */
const DECLARED_INPUTS = new Map<string, readonly string[]>([
  ...PRICE_SCORERS.map((s) => [s.indicator.id, s.inputs] as const),
  ...RS_LEGS.map((l) => [l.indicator.id, l.symbols] as const),
  ...Object.entries(RATIO_DESCRIPTOR_OF).map(([id, d]) => [id, d.inputs] as const),
  ...Object.entries(COMPOSITE_INPUTS),
]);

/** The single raw source behind the served value, or `null` when it combines ≥2 inputs. */
export function levelSourceOf(ind: Indicator): string | null {
  if (ind.id in LEVEL_SOURCE_OF) return LEVEL_SOURCE_OF[ind.id]!;
  const inputs = DECLARED_INPUTS.get(ind.id);
  if (inputs) return inputs.length === 1 ? inputs[0]! : null;
  const tag = FAMILY_OF[ind.id];
  if (tag === "ratio-spread" || tag === "composite") return null;
  return ind.series;
}

/** Is this raw source licensed? FRED ⇒ its notes; a listed public source ⇒ no; else a vendor feed ⇒ yes. */
export function isLicensedSource(source: string): boolean {
  const fred = FRED_NOTES[source];
  if (fred) return fred.restricted;
  return !(source in PUBLIC_SOURCES);
}

/** R6: does this indicator's served value carry a licensed series? A composite: exactly one of its ≥2
 *  declared inputs is licensed; one declaring no inputs fails closed ⇒ licensed. @internal */
export function isLicensed(ind: Indicator): boolean {
  const source = levelSourceOf(ind);
  if (source !== null) return isLicensedSource(source);
  const inputs = DECLARED_INPUTS.get(ind.id);
  if (inputs === undefined) return true;
  return inputs.length >= 2 && inputs.filter(isLicensedSource).length === 1;
}

const SERVED = new Map([...ALL_INDICATORS, ...CHART_ONLY_INDICATORS].map((i) => [i.id, i]));

/** By id; an id outside the registry (a `LEGP_*` leg close, a raw store series) fails closed ⇒ licensed. */
export function isLicensedId(id: string): boolean {
  const ind = SERVED.get(id);
  return ind ? isLicensed(ind) : true;
}

/** Does an `estimated` row of this id carry a licensed value? The id itself is licensed, or its registry
 *  `estimator` carries the public print over exactly ONE licensed lead — the print would let that lead's
 *  move be backed out of the served estimate (the same one-licensed-input rule as `isLicensed`). */
export function isLicensedEstimateId(id: string): boolean {
  if (isLicensedId(id)) return true;
  const leads = SERVED.get(id)?.estimator?.leads ?? [];
  return leads.filter(isLicensedSource).length === 1;
}
