/*
 * Per-leg explainer copy for the detail tab's leg stack - a DOM-free data module so the coverage
 * guard (leg-top.test.js) can import it and assert keys ⊆ LEG_FIELD sleeves + non-empty basis, and
 * that every {ID} token resolves to a real ALL_INDICATORS id.
 *
 * Each entry carries:
 *   basis - TICKER + the tracked INDEX, never a fund product name (Stage C 2026-08-20 stripped
 *           all 13 from public/);
 *   why   - one sentence per TOP_N indicator (leg-top.js), saying how that channel reaches THIS leg.
 *   holdings - the fund's top 4 holdings by weight (issuer / justETF / stockanalysis snapshots,
 *           Jul-Sep 2026 — a hand snapshot, not refreshed) as plain names, rendered as the
 *           "Top holdings." line (ext-links.js); S&P 500 also carries Alphabet (user-named, #5 by weight).
 * Both are hand-authored trusted constants, rendered RAW (same discipline as indicator-desc.js's
 * `why`/`lies`). The one dynamic thing in `why` is the `{ID}` tokens: the render site
 * (app.js's legDescBlock) substitutes each `{F9}`-style token with that indicator's SERVED label off
 * state.lastView.indicators (unknown/unloaded id ⇒ the bare id). Those labels come from served data,
 * so they are esc()'d at substitution - NO hand-typed indicator label ever enters this file (same
 * rule as legImpactClauses deriving its roster from the served weight table). Keyed by
 * LEG_FIELD[].sleeve (src/danger-ladder.ts); a sleeve with no row renders no extra prose.
 */

export const LEG_DESC = {
  Semis: {
    holdings: [
      { name: "NVIDIA" },
      { name: "TSMC" },
      { name: "Micron" },
      { name: "Broadcom" },
    ],
    basis:
      "Held via SEC0.DE, tracking the MSCI ACWI IMI Semiconductors & Semiconductor Equipment index.",
    why:
      "Semis carries the most beta on the ladder, so this row reads both ways: what warns of the fall, and what says it is safe to come back. The hyperscaler capex basket ({HCX}) leads because it is the marginal buyer of every chip the fund holds, and it is the only cycle read measured here to separate real bears from dips: once it rolls over, the odds of a further 15% fall roughly double (39% against 20%). Real yields ({R4}) discount cash flows that sit further out than any other sleeve on the ladder; 2022 was this channel alone, and a real-yield high the fund shrugs off marks the rates shock as absorbed. Micron's strength against the sector ({MU_RS}) is the re-entry leader: Micron has bottomed roughly two to three months ahead of DRAM prices. The volatility term structure ({VT}) is the fast panic read, and its flip back from backwardation to contango is the entry confirmation. Junk spreads ({F1}) are late as a warning but set how deep the bear runs (the semis bears past 60% were credit bears), and its retrace off the shock peak gates every re-entry step. The yen ({F17}) is the carry-unwind read: a sharp yen rally has marked the disorderly semis drawdowns. The memory bellwether ({F8}) lags the top but leads the bottom, so it sits here as a two-directional seat. Bond volatility ({R6}) is the disorderly form of the rates shock, the one the re-entry box already reads. Semiconductor ETF volatility ({VXSMH}) covers the gap in the broad vol read: at the July-2026 semis-only low the VIX curve stayed calm while chip volatility spiked, though its history is barely a year deep. Copper against gold ({CG}) closes the row as a re-entry tell: a sharp flush in the ratio has marked capitulation, with better forward returns after it.",
  },
  "S&P IT": {
    holdings: [
      { name: "NVIDIA" },
      { name: "Apple" },
      { name: "Microsoft" },
      { name: "Broadcom" },
    ],
    basis:
      "Held via QDVE.DE, tracking the S&P 500 Information Technology index.",
    why:
      "US large-cap tech de-rates through rates and through its own leadership, not through credit; the 2022 drawdown was a discount-rate event that credit barely flagged, and the row is ordered by how much of the fund each channel can take down. Real 10y yields ({R4}) lead as the direct multiple-compression channel: XLK's 28% fall in 2022 was a real-rate event. The hyperscaler capex basket ({HCX}) sits second because NVIDIA, Broadcom and Microsoft earnings now rest on hyperscaler spending, and that concentration is the fund's largest single exposure. The nominal 10-year ({R2}) is the level form of the same de-rating, seated beside the real one so the inflation-expectation wedge between them is readable rather than assumed. The 2-year yield ({R3}) is where the discount-rate shock starts, since policy expectations reprice at the front end before the long end follows, and a falling 2-year is this leg's clearest re-entry evidence. Rate volatility ({R6}) is the disorderly form of the same shock, and it is the violence, not the size, that forces a repricing through in days. The VIX curve inverting ({VT}) has preceded every major drawdown since 1990; tech damage tracks the term structure tighter than the broad index does, and the reversal back into contango is the re-entry trigger for the leg you most want to be early back into. The global trend ({GT}) is the row's discipline member: the 200-day rule cut maximum drawdown from 83.4% to 29.6% across 1929 to 2019, a reduction record rather than merely a warning record, and its re-cross upward is the re-entry rule this leg had no other way to express. The 10-year against 3-month curve ({R1}) is the slow recession clock behind a tech de-rating, 2001 being the case. The VIX level ({R5}) shows how far the fear has already run, a symptom that reads the same input as the term structure. The high-yield against investment-grade ratio ({F13}) closes the stack as the one credit read this row admits, an appetite ratio that moves daily in ETF prices rather than the spread level that slept through 2022, seated last because credit leads badly for tech-led drawdowns.",
  },
  EM: {
    holdings: [
      { name: "TSMC" },
      { name: "Samsung" },
      { name: "SK hynix" },
      { name: "Tencent" },
    ],
    basis:
      "Held via VWO / IS3N.DE, tracking the broad FTSE Emerging / MSCI EM IMI indexes.",
    why:
      "EM downside is mostly a dollar-funding story, so the row is built around the dollar cycle and what turns it. EM credit spreads ({F10}) are the cleanest market-priced read of that stress, and flight-to-quality widens them before the equity leg draws down. The 2-year yield ({R3}) is what actually drives the cycle: the front end is where Fed expectations reprice first, and a falling 2-year is the earliest evidence that the dollar headwind is about to become a tailwind. A rising broad dollar ({F9}) tightens conditions across the region by itself and raises the cost of every dollar-denominated debt. Copper against gold ({CG}) is the growth read for the most commodity-geared sleeve on the ladder, and its turn off a low is the region's classic re-entry signal. The yuan ({F11}) is the China channel: the 1.9% fix cut in August 2015 took EM FX down with it within hours and the S&P 500 down 11% inside a fortnight. Oil implied volatility ({OVX}) is a full-weight channel the row otherwise missed entirely — EM contains both the exporters that gain and the importers that break when energy repricing turns violent. The bull steepener ({R7}) is the recovery regime EM leads out of. The US curve ({R1}) keeps the recession lead, since the global risk-off that EM amplifies usually starts with a US slowdown. Two rate reads close the stack: the speed of the 10-year yield ({R2}) is the US discount-rate shock EM imports, and the real-yield speed ({R4}) is the part of that shock that tightens dollar funding for EM borrowers.",
  },
  Value: {
    holdings: [
      { name: "Micron" },
      { name: "Cisco" },
      { name: "Verizon" },
      { name: "AT&T" },
    ],
    basis:
      "Held via XDEV.DE, tracking MSCI World Enhanced Value — Micron alone is ~14% of the index (Aug 2026).",
    why:
      "Value is cheap and cyclical, but on this index the dominant risk is one name: Micron sits at ~14% after a memory-cycle rally, so this row is ranked by how much of the fund each read reaches, not by how early it fires. The memory bellwether ({F8}) comes first because a memory-cycle turn outweighs any macro factor at that weight. Hyperscaler capex ({HCX}) is the marginal buyer of the high-bandwidth memory Micron sells, so a capex slowdown shows there before Micron earnings do. The semis sleeve (Micron, Qualcomm and the rest, ~17%+) comes next: semis leadership against the market ({RS_SMH}) is the relative read, and the semis downside break ({DB_SMH}) is the fast trend-break detector. Japan is a fifth of the fund, and a sharp yen rally ({F17}) is both a carry unwind and an exporter margin hit, the August 2024 shape. Finance is the second-largest sector, and US bank leadership ({KBE_RS}) reads its US half. The bull steepener ({R7}) is the rate read: a front end falling on weakness is the classic cyclical-value recession tell, and its reversal is the rate-cut-led recovery value re-rates into first. Junk spreads ({F1}) matter because value tilts to leveraged balance sheets — the telecoms, autos and hardware names carry more credit beta than growth. Copper against gold ({CG}) is the global-growth read for the quarter of the fund in cyclicals, industrials, materials and energy, and its turn off a low is a re-entry signal. The global trend ({GT}) is the broad equity-beta backstop across the whole portfolio.",
  },
  "S&P 500": {
    holdings: [
      { name: "NVIDIA" },
      { name: "Apple" },
      { name: "Microsoft" },
      { name: "Amazon" },
      { name: "Alphabet" },
    ],
    basis:
      "Held via SXR8.DE, tracking the S&P 500.",
    why:
      "The broad index takes its risk from credit, from the few names now carrying the earnings, from rates and from growth, and the row is ordered by how much of the fund each channel can take down. The high-yield against investment-grade ratio ({F13}) leads: it reads the withdrawal, and the return, of risk appetite daily in ETF prices, and it is the highest-weighted member on this row. The hyperscaler capex basket ({HCX}) sits second because the top five names are roughly 30% of the index and all of them now rest on hyperscaler spending, so concentration is the fund's largest single exposure. Junk spreads ({F1}) are the spread level behind the deepest drawdowns the index has had, 57% in 2007 to 2009 and the 2000 to 2002 bear, and they earn their seat in credit-driven stress even though they slept through 2022. A bull steepener ({R7}) is the front end pricing cuts into a slowdown, the recession channel behind every bear market deeper than 30%. A fast move in the 10-year ({R2}) is the broad de-rating channel, and 2022 is the reminder that a bear market can be nothing else. The 2-year yield ({R3}) is the earliest rates form of the same shock, where policy expectations reprice before the long end follows. Copper against gold ({CG}) covers growth for the cyclical third of the index: industrial demand fading against a haven bid, and the ratio turning up off an extreme low has historically marked the start of cyclical bull runs. The global trend break ({GT}) is the discipline member, the one signal here with a drawdown-reduction record rather than just a warning record, and the re-cross up is the cleanest re-entry rule on the roster. Cross-market dispersion ({DISP}) reads whether the US, Europe and emerging markets have stopped moving together, because when they have, the diversification this index is assumed to carry is already gone. The volatility term structure ({VT}) closes the stack as a symptom of the fall rather than a cause, kept as the fast two-directional seat: inversion is the regime flip, and the return to contango has historically been worth far more as an entry than buying the panic itself.",
  },
  "ex-US": {
    holdings: [
      { name: "ASML" },
      { name: "HSBC" },
      { name: "Roche" },
      { name: "Royal Bank of Canada" },
    ],
    basis:
      "Held via CHSI.DE, tracking the developed-markets-ex-US MSCI World ex USA index (Europe ~half, Japan the largest single country).",
    // provisional: the last sentence names the provisional LEG_TOP seats (leg-top.js); re-seat round pending.
    why:
      "About half the index is Europe and the largest single country is Japan, so the reads here are European rates plus a yen line. The euro curve ({EURC}) carries the recession lead, with the caveat that ECB bond holdings have muddied that signal since 2015. A strong dollar ({F9}) is the global tightening signal that pressures every non-US asset at once. Copper against gold ({CG}) keeps a growth read on what is, in the end, a cyclical blend. The yen ({F17}) earns a seat the index weights would never give it: when the carry trade unwound in August 2024 the Topix fell more than 12% in a day, its worst since 1987, and it dragged the rest of the world along. Crude ({BRENT}) is the input-cost channel that matters more here than anywhere else on the ladder, because Europe and Japan are the two large energy importers in the index. The global trend ({GT}) supplies the exit and re-entry discipline the row otherwise had no member for. Two confirmers close the stack: the German 2s10s ({BUND}) reads the euro curve anchored to the expected policy path, and oil volatility ({OVX}) is the violent form of the energy-import shock. The haven currencies ({FXH}) close the row: a flight into the franc and the yen marks the contagion stage of a global sell-off. The high-yield against investment-grade ratio ({F13}) adds the broad risk-appetite read.",
  },
  "EU-Fin": {
    holdings: [
      { name: "Legal & General" },
      { name: "Teleperformance" },
      { name: "B&M" },
      { name: "Taylor Wimpey" },
    ],
    basis:
      "Held via DE0002635299, tracking the STOXX Europe Select Dividend 30 high-dividend-equity index - about 60% financials (insurers and banks), the rest cyclicals and energy, with heavy UK weight.",
    // provisional: the last sentence names the provisional LEG_TOP seats (leg-top.js); re-seat round pending.
    why:
      "Insurers and banks lead the basket - alongside UK-heavy cyclicals and energy names - so the risks are credit and curve shaped. The stack is ordered by how hard each channel has hit this fund in crashes and bear markets. Bank subordinated debt ({AT1}) comes first, because bank-solvency scares cause this basket's deepest falls, and in March 2020 and around Credit Suisse in 2023 the AT1 bonds repriced ahead of the shares. Insurers are the largest single block, about a third of the fund, so the STOXX 600 insurance sector against the whole STOXX 600 ({INS_RS}) is the basket's own sector trend: insurers dropping behind the market is the warning, and catching back up is the re-entry. The high-yield against investment-grade ratio ({F13}) is the broad risk-appetite read. The German 2s10s ({BUND}) reads how fast the euro curve's slope is moving, in either direction - a sharp steepening is often the market pricing emergency ECB cuts, a sharp flattening a policy squeeze; a flat or inverted curve holds amber on its own however slowly it got there, and a 2-year collapse out of inversion is the pivot tell that goes red. The volatility term structure ({VT}) catches the global crashes that start in the US, and turning back to normal is the re-entry signal. The euro against sterling ({EURGBP}) is the translation channel for the UK-listed quarter of the fund. Four US-led global reads complete the row: the high-yield spread ({F1}) for credit stress, financial conditions ({F3}) for funding strain, real-yield velocity ({R4}) for a fast rates repricing, and bond-market volatility ({R6}) for a disorderly one.",
  },
  Health: {
    holdings: [
      { name: "Eli Lilly" },
      { name: "Johnson & Johnson" },
      { name: "AbbVie" },
      { name: "UnitedHealth" },
    ],
    basis:
      "Held via QDVG.DE, tracking the S&P 500 Health Care index.",
    why:
      "Healthcare trades as a bond proxy, so rates do most of the damage; the bond-proxy sectors returned about 26% while world equities did 61% over the post-2020 rate rise. A fast move in the 10-year ({R2}) is the mechanical de-rating. The real 10-year ({R4}) is the same channel stripped of inflation expectations, which is the discount rate a long-duration defensive actually re-rates on. Rate volatility ({R6}) is the disorderly form of both, which is when the selling actually happens. The quality tilt argues for investment-grade reads over junk: IG spreads ({F2}) show stress reaching the safest borrowers, roughly the point a defensive sleeve starts falling too. High-yield spread widening ({F1}) is the rotation INTO defensives — the signal that risk appetite is leaving equities for safety, which is when a healthcare sleeve earns its place. The defensive-rotation trigger ({R5}) fires on the relative move that makes the sleeve worth holding: healthcare falling less than the broad market, not falling to zero. The dollar ({F9}) matters because the fund is almost entirely US and unhedged, so big pharma's ex-US revenue re-translates for a euro holder as the dollar moves. The global trend ({GT}) supplies the exit and re-entry discipline. Two confirmers close the stack: the speed of the 2-year yield ({R3}) is the Fed repricing the bond-proxy trade, and the high-yield against investment-grade ratio ({F13}) is the daily risk-appetite read behind a rotation into defensives.",
  },
  Commodities: {
    basis:
      "Held via LYTR.DE, tracking the Bloomberg Energy & Metals Equal-Weighted index — 12 commodity futures at roughly 1/11 each, split about 36% energy / 36% industrial metals / 27% precious metals, no agriculture.",
    why:
      "Energy plus industrial metals are about 73% of the basket, so it trades as a global-growth asset priced in dollars. Crude ({BRENT}) is the single largest driver: direct oil is ~18% and the low-sulphur gas oil contract is Brent-priced, so oil reaches roughly 27% of the index. Henry Hub natural gas ({NG}) fills the ~9% gas slot no other read here touches. Copper against gold ({CG}) is the only clean industrial-metals read and the row's growth gauge — the ratio falling is the cyclical-versus-haven turn the 73% growth block feels first. A strong dollar ({F9}) is a basket-wide headwind because all 12 contracts are USD-priced. Oil implied volatility ({OVX}) is the violent form of the energy shock rather than its direction, so it flags the disorderly moves. The 10-year real yield ({R4}) is the dominant driver of the 27% precious-metals sleeve — gold, silver and the platinum-group metals re-rate off the real discount rate. The yuan ({F11}) is the China channel: China is about half of world copper, aluminium, nickel and zinc demand, so yuan weakness reads straight through as demand stress on the 36% metals sleeve. Junk spreads ({F1}) earn the last seat for the demand-collapse regime — 2008 and 2020, when commodities fell alongside equities as financing seized. Two confirmers close the stack: US crude ({G1}) moves with Brent but reads the US barrel, and the 10-year breakeven ({T10YIE}) confirms the inflation trade after it is already running.",
  },
  "AW Fundam": {
    basis:
      "Held via PSWD.DE, tracking the Invesco FTSE RAFI All-World 3000 index — ~3000 DM+EM names weighted on fundamentals (sales, cash flow, book, dividends) not market cap, so ~22% financials, about half the capital non-USD, and it behaves like a ~60/40 Value + ex-US blend.",
    why:
      "Deep-value and cyclical with no single-name concentration, so the risks are credit, the rate cycle and the dollar rather than one stock. Junk spreads ({F1}) lead because credit stress hits levered value balance sheets and the 22% financials block first — the 2008 and 2020 channel. The bull steepener ({R7}) is the recession-onset shape, a Fed cutting into weakness: the bad steepening for bank net-interest margins, and its reversal is the re-risk trigger. Copper against gold ({CG}) is the growth-versus-haven read of the ~37% cyclical block, two-directional — the ratio turning up off a low is the re-entry. A strong dollar ({F9}) is a broad headwind on the half of the book that is non-USD plus the EM and commodity producers. Bank equity relative strength ({KBE_RS}) reads the sector no spread does: March 2023 saw regional banks fall while junk spreads barely moved, so bank shares flag a bank shock credit misses. EM credit spreads ({F10}) price the Korea/Taiwan/China/Brazil tail the fund carries, with Samsung among its largest holdings. The VIX term structure ({VT}) is the fastest daily risk-off timer for any broad equity book, and the global trend ({GT}) is the closest price proxy for an all-world fund — the 200-day re-cross is the row's re-entry rule. Two bench reads close the stack: crude ({BRENT}) is the energy weight in a fundamentally-weighted index, and the yen ({F17}) is the carry-unwind shock that drags every market at once.",
  },
  Staples: {
    holdings: [
      { name: "Walmart" },
      { name: "Costco" },
      { name: "Coca-Cola" },
      { name: "Procter & Gamble" },
    ],
    basis:
      "Held via ZPDS.DE, tracking the S&P Consumer Staples Select Sector index.",
    why:
      "Staples share the bond-proxy problem, so the duration pair leads: a 10-year yield shock ({R2}) for the de-rating, rate volatility ({R6}) for the version that arrives in days. What separates staples is the cost line. An oil run-up ({G1}) feeds straight into resin packaging, freight and food inputs, and margins this thin cannot absorb it; the last crude surge put HDPE, the plastic in every bottle and cap, up more than 50%. Oil implied volatility ({OVX}) is the fast form of that same margin shock — it moves while the crude price is still deciding. A strong dollar ({F9}) shrinks the translated revenue of the sector's internationally billed mega-caps, a headwind that has run into the billions in a single year. IG spreads ({F2}) carry the quality-credit recession read. Curve inversion ({R1}) is on the row for the opposite reason to everywhere else on the ladder: it is the signal that the recession this sleeve is held FOR is coming, so it argues for holding, not selling. The global trend ({GT}) is the mirror of that — a trend re-cross upward is the leave-staples signal, since a defensive sleeve's real risk is being sat in one through a recovery. Two confirmers close the stack: junk spreads ({F1}) widening is the rotation into defensives, and the speed of the 2-year yield ({R3}) is the Fed repricing the bond-proxy discount rate.",
  },
};
