/**
 * Per-member display copy for the board tiles: short display name + hover help.
 * Pure data module (no DOM) so vitest can assert coverage over the real registry while
 * `tsc` (no allowJs) ignores it — the same seam idiom as tile-members.js / format.js.
 */
// The help string is the SENTENCE alone — the indicator's short name (`Indicator.label`) is emitted
// by the render site (lab.js `legSpan` → `legTitle`) ahead of this copy, so no registry-keyed entry
// re-includes a leading "<label> — " clause. The three ↓ STRIP-CHIP keys keep their "Downside-break — "
// opener: it is prose, not a duplicated registry name (they have no `Indicator.label`).
// Chip text is the served `label` for EVERY member (`legSpan` → `chipLabel(m.label || m.id)`, id only
// as fallback) — there is no short-name table here.
// MEMBER_HELP covers all live members so each leg carries a [title] tooltip — enforced by
// leading-name.test.js over GLOBAL_FAMILIES, not merely asserted here.

export const MEMBER_HELP = {
  F1: "US high-yield credit spread; widening from its trough is early stress.",
  F2: "US investment-grade credit spread; widening = risk-off.",
  EBP: "excess bond premium: credit spread beyond fundamentals (risk appetite).",
  // Each condensed from its own INDICATOR_DESC `tip`, not invented.
  F3: "Chicago Fed leverage/funding/volatility subindex; leads HY OAS by ~6-12 weeks.",
  F10: "emerging-market corporate credit spread; widens before EM equity drawdowns.",
  BONOS: "Spanish 10y sovereign spread over Bunds; a fast widening or a level through the pair = euro sovereign stress landing on the banks holding Spanish debt.",
  F13: "credit appetite: high-yield vs investment-grade ETF ratio vs its 50-day average; rate-clean, leads cash-bond spreads by days.",
  CQS: "Baa−Aaa corporate quality spread, scored as a same-day nowcast bridge over EBP's month-stale print (Δ from EBP's anchor month, z-scaled).",
  R1: "the Treasury term spread; curve inversion (negative = recession signal).",
  R8: "the same term spread on a 21-day mean, at deeper cuts - confirms R1, never starts a warning.",
  R2: "10y velocity: speed of the 10-year Treasury-yield move (rate shock).",
  R3: "2y velocity: speed of the 2-year Treasury-yield move.",
  R4: "10y real-yield velocity: speed of the real 10-year yield move.",
  // Per-leg-only clause (ruled 2026-08-19, re-affirmed 2026-08-30): R7 keeps the band seat OFF
  // because the reach study is a two-sided null on all 32 leg x horizon cells and its RED lag share
  // (0.67) is the one statistic that clears its rotation placebo. Role clause mirrors R8's.
  R7: "2y-led: 2y falling faster than 10y (easing into stress). Per-leg only - its fires do not lead leg damage and its RED runs late, so it deepens legs but never arms the band.",
  T10YIE: "the 10-year inflation breakeven, the bond market's priced 10-year inflation expectation; climbing toward its 2022 stress zone = stagflation regime.",
  T5YIFR: "the 5y5y forward inflation rate, the Fed's preferred de-anchoring gauge; a confirmed break of the de-anchoring line = expectations unmoored.",
  OVX: "oil implied vol: crude-oil option-implied volatility; a sustained level in the shock band = oil-supply crisis regime, OR a fast five-session spike (G1's implied-vol sibling).",
  BRENT: "Brent crude, the seaborne oil benchmark; red on a fast 20-day run-up, but only while the close is at a new trailing 3-year high - the level leg is a gate, not a second way to fire (G1's Brent confirm).",
  EURC: "the euro curve (ECB AAA): euro-area curve inversion (policy LEVEL).",
  BUND: "the Bund curve (sovereign-quote German yields): speed of the 10y-2y slope move either way, off the expected policy PATH; a flat or inverted curve alone caps at amber, a 2y collapse out of inversion goes red.",
  ESTR: "euro overnight rate (ECB ESTR) quarter change: how fast the ECB is cutting - two cuts in a quarter warns, faster than that is the crisis-cut regime.",
  EPATH: "euro policy path (ECB AAA 1y minus ESTR, smoothed): how much hiking the market prices over the next year - context only, never scored into danger.",
  HICP: "euro-area inflation turn (HICP y/y minus its level 6 months earlier): amber while inflation is not falling - context only, never scored into danger.",
  EURGBP: "pounds per euro (ECB): red on a fast sterling slide vs the euro, 20-day move OR distance above its 50-day average - the EU-Fin leg's UK translation risk.",
  R5: "front-month implied equity volatility (fear level).",
  R6: "bond-market implied volatility.",
  VT: "the VIX term structure: near vs far vol; inversion = acute stress.",
  FXH: "FX havens: EUR/CHF/JPY bid vs risk currencies (flight to safety).",
  F9: "the broad trade-weighted US dollar, scored on its rate of climb alone; a FAST-rising dollar squeezes emerging-market financing.",
  F11: "yuan per US dollar, scored on its rate of depreciation alone; a FAST-weakening yuan is a China/EM risk-off tell.",
  F17: "yen per US dollar, scored on its rate of depreciation alone; a FAST-weakening yen is a Japan/carry-stress tell.",
  CG: "the copper/gold ratio: growth vs safety; falling = risk-off.",
  DISP: "SPY·FEZ·EEM: is the fall systemic or isolated to one region?",
  GT: "global trend: ACWI vs its 200-day average.",
  ECY: "excess CAPE yield (1/CAPE − 10y TIPS) ranked in its own full history; red only when expensive AND the global trend is broken.",
  GB: "share of 7 regional ETFs above their 200-day average.",
  F4: "US semis momentum; big-tech leadership proxy.",
  F5: "US breadth: mega-cap vs equal-weight participation.",
  SPCONC: "S&P 500 concentration, F5's broad-market twin: cap-weighted vs equal-weighted participation across the whole index.",
  F6: "SMH/SPY ratio vs its own 200-day average; red below - a coincident semis sector-risk flag.",
  F8: "the MU (Micron) memory-cycle leg: memory-chip pure-play vs its 200-day average +10%; soft memory-cycle confirmer.",
  INS_RS: "EXH5/EXSA ratio (European insurers vs the STOXX Europe 600) vs its own 50-day average; red below - insurers are ~31% of the held EU-Fin fund.",
  KBE_RS: "KBE/SPY ratio (US bank equities vs the S&P 500) vs its own 50-day average; red below - a US-bank proxy for the EU-Fin basket's bank risk.",
  EXSH_GATE: "the held EU-Fin fund's 3-check gate: red when its close is below its 200-day average; amber when it is below its 50-day average or lagging its STOXX Europe 600 parent (EXSH/EXSA vs its 50-day average); green when all three hold.",
  AT1: "XAT1/EXHA ratio (dollar AT1 CoCo bank sub-debt, hedged to euros, vs German government bonds) vs its own 50-day average; red below - European bank-capital repricing, read on the EU-Fin leg only.",
  CCC: "ICE BofA CCC & lower US high-yield spread (the junk tail of F1) on its level and 20-day change; red when both are high - distressed-credit stress, read per leg only (never the dial).",
  NVDA: "Nvidia, the AI bellwether vs its 200-day average.",
  // DB_SMH is a GLOBAL_FAMILIES member id, so it needs a hover-help entry here (the coverage pin).
  // Distinct from the "SMH↓" strip chip.
  DB_SMH: "downside break on SMH: drawdown from a 3-month high, MA50-gated; the fast semis tech-confirmer.",
  // DB_XLK: the same detector on the S&P 500 IT sector. Capped EARLY-WARN floor only, in no family.
  DB_XLK: "downside break on XLK (S&P 500 IT): drawdown from a 3-month high, MA50-gated; the direct fast break on the S&P 500 IT sector.",
  G1: "crude-oil shock: oil/commodity + geopolitical spike.",
  "price-accel": "price acceleration: QQQ 63-day return percentile (stretched melt-up).",
  "complacency-vix": "complacency: VIX percentile (suppressed volatility).",
  "complacency-high": "complacency: distance to the 252-day high.",
  "complacency-duration": "complacency: duration of calm (VIX run below its median).",
  // These three are STRIP CHIP keys (served as d.downsideDetectors, rendered as ↓-suffixed chips on
  // the live-only Early-Warn tile), not registry ids — they have no `Indicator.label`, so they keep
  // their descriptive "Downside-break — " opener (prose, not a duplicated name).
  "SMH↓": "Downside-break - SMH below its recent support (US-tech break detector).",
  "NVDA↓": "Downside-break - NVDA below its recent support (US-tech break detector).",
  "QQQ↓": "Downside-break - QQQ below its recent support (US-tech break detector).",
};
