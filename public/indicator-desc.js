/*
 * Per-indicator explainer copy — extracted from app.js into a DOM-free data
 * module so the coverage guard (indicator-desc.test.js) can import it and assert
 * every ALL_INDICATORS id has an entry. Imported back by app.js's indicatorBlurb.
 */

// Per-indicator explainer shown under the detail chart. Each entry carries:
//   tip    — one short "what it measures" line for the card hover tooltip. It does not lead with
//            the indicator's short name: app.js's cardTip prepends "<id> <label> — " itself,
//            detail-chart.js's caption prints it right after the primary-axis clause
//            ("<label>, <unit> (left) — <tip>", period dropped), and lab.js's episode-companion
//            picker reads the served label off /api/series rather than splitting a leading clause
//            off this prose. Ids are never added here beyond the ones
//            already present;
//   why    — the causal chain: who acts, why this number moves before equity damage (≤60 words);
//   lies   — known failure modes / when the signal misleads (≤50 words), rendered as the
//            "When it misleads." paragraph (number-free like everything here); mandatory for
//            every id outside CHART_ONLY_INDICATORS. The SLOW legs' and the
//            DB_*/RS_* pair's fold/gating facts live here too (ex-`engineNote`);
//   with   — "Read it with." (≤40 words, number-free): the sibling indicators to cross-check and
//            what agreement/disagreement means. Siblings are `{ID}` tokens (never the entry's own
//            id), substituted with the SERVED label in detail-tab.js and pinned to real registry ids
//            in indicator-desc.test.js; mandatory for every carded id;
//   links  — optional [{label, url}] external public charts, rendered as the compact
//            "Live charts." line (ext-links.js: https + allowlisted hosts only).
// `derivation`/`implications` were REMOVED 2026-09-12: cut reasoning is provenance
// (docs/indicator-cut-provenance.md), not user copy; the implications prose folded into `lies`.
// `drives` (D2) and then the derived "In the engine." line + `engineNote` (slice 2b) were REMOVED
// 2026-09-12: the role sentence restated the ladder block, and hand-authored engine claims rot
// against the registry — `with` names siblings by token instead, so a retired id fails the test.
// Deliberately threshold-free — the chart's amber/red band labels carry the live
// cut-points, so this prose can never drift from the engine's math (same
// discipline as LEGEND, P2). Keyed by indicator id; an id with no entry simply
// renders no explainer (and the tooltip falls back to the id/label/channel line).

export const INDICATOR_DESC = {
  HCX: {
    tip: "an equal-weight basket of the four mega-cap cloud buyers, measured against the market.",
    why:
      "Alphabet, Meta, Microsoft and Amazon are the buyers of AI compute, so the market's pricing of their capex appetite is the demand side of the whole AI hardware cycle. When investors start pricing capex discipline into them, the basket de-rates against the index and drifts off its own high.",
    lies:
      "An equal-weight basket lets one member's own stumble - an antitrust ruling, a bad quarter - drag the read with no capex message. Dividing by the index mutes but does not remove a market-wide selloff.",
    with:
      "{FDX} is the supply-chain twin on the same cycle - both sagging is the AI trade cooling at both ends; {NVDA} says whether the leader's own trend agrees; {F4} whether absolute semis damage has followed.",
  },
  FDX: {
    tip: "Taiwan Semiconductor measured against the broad semiconductor group.",
    why:
      "Nearly every advanced chip is manufactured by TSMC, so allocation shifts, capacity trouble or export-control stress specific to the foundry shows up as TSM lagging the broad semiconductor group - the market repricing the supply chain's single point of failure while the rest of the sector still looks healthy.",
    lies:
      "TSM carries a standing Taiwan geopolitical discount, so a cross-strait headline moves the ratio with no cycle message. A rally led by TSMC's own customers can also lift the denominator faster than TSM.",
    with:
      "{HCX} reads the demand side of the same cycle; {F6} whether semis as a whole are losing ground against the market - stress here with {F6} intact is a foundry story, not a sector one.",
  },
  F7: {
    tip: "CAPE, cyclically-adjusted price/earnings: a long-horizon valuation gauge.",
    why:
      "Buyers at a rich multiple are paying today for growth a downturn removes, so an expensive market has both thinner forward returns and further to fall when a shock lands. Averaging a decade of inflation-adjusted earnings strips the cycle out of the denominator, leaving the price side exposed.",
    lies:
      "The worst timer on the board: markets can stay expensive for years - the late run into 2000 - and cheap through a whole crisis. The slow earnings denominator means it says nothing about when; it sizes the fall, not the odds of one starting.",
    with:
      "{ECY} converts this into an excess yield over risk-free real bonds and gates it on trend; {GT} is that trend - valuation only becomes danger once {GT} breaks.",
  },
  F1: {
    tip: "the high-yield credit spread: the market's price for corporate default and funding risk.",
    why:
      "When lenders doubt repayment they charge weak borrowers first, so this spread widens before defaults and before equity damage: refinancing shuts, leveraged firms cut spending, and the squeeze propagates to earnings. It led equities in 2000, 2008 and 2020.",
    lies:
      "Coincident-to-late in fast liquidity crashes; F3 tends to move first. Spread compression from yield-chasing can mask deteriorating credit for months.",
    with:
      "{F3} for the plumbing stress that usually moves first, {F13} for the faster ETF-priced read of the same appetite, {F2} for whether doubt has reached the core. Wide here with {F3} calm is a slow credit grind.",
  },
  F2: {
    tip: "the investment-grade credit spread: the premium on investment-grade corporate debt over Treasuries.",
    why:
      "Investment-grade issuers are the borrowers who lose funding access last, so when even their spread widens, the credit squeeze has moved past the junk tier into the market's core - pension and insurance money demanding more to hold blue-chip debt. That breadth of doubt is what precedes broad equity damage.",
    lies:
      "It moves in small steps and lags high-yield, so it confirms F1 more than it leads. In an orderly, equity-only selloff it can stay near its lows while stocks fall - IG issuers keep funding access until stress is deep.",
    with:
      "{F1} first - junk widens before investment grade, so a move here with {F1} still narrow is odd. {CQS} shows the same quality gap without the Treasury term; {EBP} says how much of it is pure risk appetite.",
  },
  F3: {
    tip: "the Chicago Fed's leverage/funding/volatility subindex of US financial conditions.",
    why:
      "Leverage, funding and volatility strains tighten inside the financial plumbing - dealer balance sheets, repo, money markets - before they surface as wider credit spreads or falling stocks. The Chicago Fed aggregates dozens of those series, so the squeeze shows here first: it tends to move earlier than F1.",
    lies:
      "Weekly, and released days after its observation window, so a fresh shock reads here late even though the index itself leads. As a composite it can be dragged by one noisy input, and calm plumbing has coexisted with equity-only selloffs - it reads funding stress, not valuation.",
    with:
      "{F1} and {F2} for whether plumbing strain has reached the borrowers, {R6} for the rates volatility that accompanies the funding leg and forces mechanical de-levering. Rising here while spreads sleep is the early shape; both together is the confirmed one.",
  },
  R1: {
    tip: "the term spread: the 10-year minus 3-month Treasury yield, i.e. the slope of the yield curve.",
    why:
      "Banks borrow short and lend long, so a flat or inverted curve chokes the profit in new lending and credit creation stalls; inversion also encodes the bond market's bet that policy is tight enough to break growth. The slowdown that follows reaches earnings and equities with a long lag.",
    lies:
      "The lead runs quarters to years, and equities often rally well after inversion. Un-inversion can be the more dangerous phase - R7 reads that move. A global flight into Treasuries can drag the long end down and deepen inversion without any US recession signal.",
    with:
      "{R7} reads the dangerous un-inversion this ignores, {R8} the near-term forward spread recession models actually use, {EURC} the euro twin - together they separate a global haven bid from a US growth call.",
  },
  R8: {
    tip: "the near-term forward spread: the bond market's bet on imminent Fed cuts, averaged to a monthly read.",
    why:
      "When investors expect weakness to force the Fed into cuts within the coming year, near-term forward rates drop below today's rate and this spread inverts - a recession bet less distorted by term premia than the long curve. The monthly mean matches the input the published recession models are estimated on.",
    lies:
      "Its cuts are percentiles of the mean's own anchored history, hand-set so past recessions fire without the recent long inversion plateau re-firing on every wiggle. The chart's recession-probit axis is display-only - it scores nothing. Like every curve signal, its lead is long and loose.",
    with:
      "{R1} is the classic long-curve read of the same recession question; {R7} watches the un-inversion move that can be the more dangerous phase - agreement across all three is a conviction recession bet, not noise.",
  },
  R2: {
    tip: "10-year Treasury yield velocity: how fast long rates are moving over roughly a month of closes.",
    why:
      "A fast rise in the 10-year yield reprices every long-dated cash flow at once: mortgages, corporate borrowing and the rate equities are discounted at all tighten before the real economy reports anything. Growth stocks, whose earnings sit furthest in the future, are mathematically the most exposed.",
    lies:
      "Yields also rise fast when growth surprises to the upside, which equities can absorb - the tell is what breakevens and real yields (R4) do alongside. A yield plunge on recession fear is a different danger it sits out.",
    with:
      "{R4} and {T10YIE} split the move: real yields rising while breakevens fall is pure tightening, both rising is a broader repricing equities can absorb. {R3} says whether the front end is driving it.",
  },
  R3: {
    tip: "2-year Treasury yield velocity: how fast the market is repricing the Fed path.",
    why:
      "The 2-year yield is the market's live estimate of the Fed's path. When it jumps, investors are repricing how hard policy will squeeze - and leveraged positions built on the old path unwind fast. That funding shock reaches equities before any policy meeting actually happens.",
    lies:
      "A fast 2-year drop is scored calm here, yet it often means the market smells recession - R7 exists to catch exactly that shape. Around a policy pivot moves are large in both directions, so single spikes near meetings are noise as often as signal.",
    with:
      "{R7} fired beside a calm reading here means the front end is collapsing, not rising - the recession sequence, not the tightening one. {R2} shows whether the long end followed, {R6} whether the repricing came with a rates-volatility shock.",
  },
  R4: {
    tip: "10-year real (TIPS) yield velocity: how fast inflation-adjusted long rates are moving.",
    why:
      "The TIPS yield is the risk-free real return investors can lock in, so it is the hurdle every equity cash flow must clear. When it rises fast, the discount rate on the whole market ratchets up at once, and long-duration assets - tech above all - reprice before earnings move at all.",
    lies:
      "A fast rise can be hawkish policy, a term-premium/supply repricing, or benign growth upside. The tell is the breakeven card: real yields rising while breakevens fall is pure tightening; rising together is a broader rates repricing. A lone amber is context, not a signal.",
    with:
      "{T10YIE} is the breakeven pair that decides whether the rise is pure tightening, {R2} the nominal yield it is a component of, {GT} for whether the global equity trend has started to break under it.",
  },
  R5: {
    tip: "the equity market's volatility 'fear gauge.'",
    why:
      "Option prices embed the hedging demand of every large investor at once, so when they scramble to protect portfolios the index jumps within hours - faster than any macro series can print. It is the fuse-is-lit gauge: the confirmation that turns a warning elsewhere into a live event.",
    lies:
      "Coincident by construction - by the time it spikes, prices have already fallen, so it confirms rather than warns. Extreme readings mark bottoms as often as tops, and a grinding bear market can bleed lower on an unremarkable reading.",
    with:
      "{VT} for whether near-term fear exceeds the longer outlook - the sharper panic read; {R6} for the bond-market twin that forces mechanical de-levering.",
  },
  R6: {
    tip: "the bond market's volatility 'fear gauge' (VIX for Treasuries).",
    why:
      "Treasury options price the market's anxiety about rates, and leveraged strategies - risk parity above all - are sized to bond volatility, so a spike here forces mechanical de-levering that spills into every asset. It is a distinct factor from equity volatility, not a proxy: the two move together far less than same-factor instruments do.",
    lies:
      "Coincident - it confirms stress has arrived rather than warning ahead. A rolling-percentile leg (the options world's IV-Rank) was tried twice and removed twice: on a series with a real published scale, unusual-for-the-window is the wrong question, and the velocity leg already catches a fast move.",
    with:
      "{R5} for the equity twin - both spiking together is a cross-asset shock, this one alone a rates event; {R2} and {R3} for which end of the curve the volatility is about; {F3} for whether funding strain accompanies it.",
  },
  R7: {
    tip: "the yield curve un-inverting because the 2-year is dropping fast - a flight to safety, not healthy growth.",
    why:
      "It separates two ways the curve can un-invert. When the 2-year collapses because investors are stampeding into safety - pricing emergency cuts - recessions have typically already begun; that is the 'dam breaks' move before the equity leg down. A long end rising on growth is the healthy twin it deliberately ignores.",
    lies:
      "A 2-year plunge can also be a benign disinflation repricing with no recession attached. It confirms late in the sequence - by the time the dam-breaks move prints, credit (F1, F3) has usually been widening for weeks. Cut-driven steepening around scheduled pivots is the routine false positive.",
    with:
      "{R3} is the front-end collapse it decodes, {R1} the curve it un-inverts. A dam-breaks print with {F1} and {F3} still calm is the odd case - a disinflation repricing rather than a credit event.",
  },
  G1: {
    tip: "WTI crude oil, a geopolitical and supply-shock proxy for the economy.",
    why:
      "Oil is both an input cost and a consumer tax, so a supply-driven spike pulls spending power out of the economy and compresses margins at once - the classic recession accelerant, as in 2008; the 2011 spike fed that year's global growth scare. Scoring the pace of the run-up rather than the price keeps the read meaningful across regimes.",
    lies:
      "A demand-led rise - a strong economy bidding for barrels - looks identical to a shock at first; the trailing-peak gate exists to hold back rallies off a low. And a crisis can crash oil instead, as in 2020, leaving this card calm mid-collapse.",
    with:
      "{BRENT} and {OVX} read the same oil factor from the seaborne benchmark and the options market - agreement across the three makes it a regime; {T10YIE} says whether the shock is turning stagflationary.",
  },
  NG: {
    tip: "Henry Hub natural gas, a heating and power-input shock the economy pays as a hidden tax.",
    why:
      "Gas is a direct input to electricity, heating and fertiliser, so a supply-driven run-up drains household and industrial spending power the way an oil shock does - scoring the pace of the run-up keeps the read meaningful across a famously volatile series.",
    lies:
      "Gas is far more weather- and storage-driven than oil, so a cold-snap spike can fire with no macro meaning; and its swings are wild enough that even the aggressive early cuts can whipsaw.",
    with:
      "{G1} and {BRENT} are the oil legs of the same energy-shock read - gas moving with them is a broad input-cost squeeze, gas alone a storage or weather story; {OVX} says whether options are pricing energy fear.",
  },
  CG: {
    tip: "the copper/gold ratio: industrial demand (copper) versus safe-haven bid (gold); a falling ratio is risk-off.",
    why:
      "Copper is bought by builders and factories; gold by the frightened. When industrial demand fades while the safe-haven bid firms, the ratio falls - a read on real-economy conviction taken from two deep commodity markets that reprice daily, ahead of the statistics that would confirm a growth scare.",
    lies:
      "Supply moves both legs: a mine strike lifts copper and central-bank buying lifts gold, with no growth message in either. Its cuts are unvalidated starting priors, and by design it can only amplify an already-elevated geopolitical read - it never raises an alarm alone.",
    with:
      "{G1} is its commodity sibling on the geopolitics side - oil spiking while this ratio falls is a supply shock meeting a growth scare; {GT} says whether the global equity trend agrees with the metals' verdict.",
  },
  VT: {
    tip: "the VIX term structure (VIX ÷ VIX3M): the curve inverting into backwardation is the real panic tell.",
    why:
      "Markets normally price more volatility into the three months ahead than into the next few weeks; when near-term protection is bid above that longer outlook the curve has inverted - and that only happens when large investors fear the coming weeks specifically. The curve's shape reads acute stress more sharply than the spot fear level alone.",
    lies:
      "It inverts with the selloff, not ahead of it, and one-day inversions around scheduled events are routine noise - VTP reads whether the inversion holds. A slow grind lower can keep the curve calm while damage accumulates.",
    with:
      "{VTP} for whether the inversion is holding day after day rather than flickering, {R5} for the raw fear level underneath, {R6} for whether bond-market volatility confirms a cross-asset shock.",
  },
  VTP: {
    tip: "how many days running the VIX curve has stayed inverted - the persistence of backwardation, not its depth.",
    why:
      "One-day inversions of the VIX curve around scheduled events are routine noise; an inversion that refuses to unwind day after day means hedgers keep paying more for immediate protection than for the future - the market failing to calm down, the shape that has accompanied real stress rather than a scare.",
    lies:
      "A single calm close resets the streak to zero, so one relief rally mid-crisis wipes the count while nothing is resolved. It reads persistence only - a shallow inversion held for weeks scores like a deep one.",
    with:
      "{VT} reads the same curve's level on the day - this card says whether {VT}'s inversion is holding or flickering; {R5} for the raw fear level the curve sits on.",
  },
  VXNCLS: {
    tip: "the Nasdaq-100 volatility index (VXN): the VIX of the tech-heavy index.",
    why:
      "It prices the next month's swings in the Nasdaq-100 rather than the whole S&P 500, so when fear concentrates in the mega-cap tech names that carry the index it rises faster than the VIX. A wide gap over the VIX is the market hedging the tech leaders specifically.",
    with:
      "{R5} for the broad-market fear level it should be read against - a widening gap is tech-specific stress; {VXNT} for whether tech fear has inverted its own curve; {F4} for the semis damage it often tracks.",
  },
  VXNT: {
    tip: "the VXN term structure: Nasdaq-100 volatility over the S&P's three-month volatility, rescaled by VXN's usual premium to the VIX.",
    why:
      "No three-month VXN exists, so the back leg is the VIX3M scaled by the VXN's usual premium over the VIX across the past year. Near-term tech protection bid above that adjusted outlook means the tech curve has inverted - VT's panic tell, read on the mega-cap index. Display only: no family, no weight, no alert, no push.",
    lies:
      "The back leg is borrowed from the S&P, so a tech-only scare that also lifts the VIX3M reads calmer than it is, and a year in which the tech premium drifted makes the scaling lag. It inverts with the selloff, not ahead of it.",
    with:
      "{VT} for the S&P curve it mirrors - both inverted is broad panic, only this one is tech-specific stress; {VXNCLS} for the raw tech fear level; {VTP} for whether the S&P inversion is holding.",
  },
  VXSMH: {
    tip: "the semiconductor ETF volatility index (VXSMH): the VIX of the chip stocks, read off SMH options.",
    why:
      "It prices the next month's swings in the semiconductor ETF alone, so a chip-only scare - a memory or export shock the broad market shrugs off - lifts it while the VIX and VXN stay calm. The semis ladder shows it as a box sign, no vote. Display only: no family, no weight, no alert, no push.",
    with:
      "{VXNCLS} for the tech-wide fear it should be read against - only this one high is semis-specific stress; {R5} for the broad market; {F4} for the semis price damage it prices.",
  },
  T10Y3M_RAW: {
    tip: "the daily 10-year minus 3-month Treasury spread (FRED T10Y3M), unsmoothed.",
    why:
      "It is the same curve {R1} scores, read close by close instead of as a one-month average, so an inversion or un-inversion shows the day it prints rather than weeks later. The semis ladder's curve box reads this daily print.",
    with:
      "{R1} for the smoothed reading the recession call rests on - a raw dip the average has not followed is a flicker, not a regime; {R7} for the un-inversion move; {R8} for the near-term forward spread.",
  },
  EURC: {
    tip: "the euro-area yield curve (ECB AAA 10y − 3m): the euro sibling of the US term spread.",
    why:
      "The euro area's own recession bet: when investors expect the ECB to have overtightened, they lock in long yields below today's policy rate and the curve inverts. It reads European danger at the source, so it still fires when the US curve is distorted by haven flows.",
    lies:
      "The long leg is a AAA basket whose membership changes when a country is downgraded, so a level shift can be composition, not conviction - BUND, a single issuer, is the cross-check. Like every curve signal its lead is long and loose; it times nothing.",
    with:
      "{BUND} is the single-issuer cross-check: inverted here with {BUND} unmoved points to composition, not conviction. {R1} is the US twin - both inverted is a global bet, only this one is European.",
  },
  BUND: {
    tip: "the Bund curve (German 10y − 2y): the euro curve's policy-PATH read, disinverting first at a pivot.",
    why:
      "The 2-year leg prices the ECB path the market expects, not today's rate - so when investors start betting on emergency easing, this curve moves first: the 2-year collapses and it bull-steepens while EURC still reads deeply inverted. It is the euro side's earliest pivot tell, from a single stable issuer.",
    lies:
      "A pivot-driven steepening is ambiguous on its own: cuts priced for recession and cuts priced for achieved disinflation look identical here. Bunds are also Europe's safe haven, so in a euro sovereign scare (2011) haven demand distorts both legs and the slope stops being a clean growth read.",
    with:
      "{EURC} for the slower, broader euro curve, {R7} for the same front-end collapse decoded on the US side.",
  },
  ESTR: {
    tip: "the euro overnight rate (ESTR): how much the ECB has cut over the last quarter.",
    why:
      "Banks earn the gap between loan yields and deposit costs: when the ECB cuts fast, loan yields reset lower before deposit costs follow, squeezing margins. Insurers suffer as lower reinvestment yields eat into guaranteed-rate policies. Fast cuts also mean the ECB sees trouble coming - a fast FALL is the signal here, not a rise.",
    lies:
      "It steps a week after each ECB meeting, then sits flat, so it confirms rather than leads - markets price cuts weeks earlier. Meetings are six weeks apart, so a quarter sees at most two: one standard cut never fires, two warn, only an oversized or emergency cut reaches red.",
    with:
      "{EURC} and {BUND} show whether the curve is steepening as a normal easing cycle would, or flattening into a growth scare, {EURGBP} for the UK quarter of the basket.",
  },
  EPATH: {
    tip: "the euro policy path (AAA 1-year yield minus ESTR, smoothed): ECB hikes priced for the next year.",
    why:
      "A 1-year yield above the overnight rate means the market expects the ECB to raise rates. Hikes lift bank deposit costs and squeeze rate-sensitive equities before earnings show it. Display-only context for the EU-Fin basket: it does not move the danger dial or any alert.",
    lies:
      "The AAA 1-year is a government bond, not a swap, so it carries a collateral basis that drifts with bond scarcity rather than policy. Smoothing lags a fast repricing by several days.",
    with:
      "{ESTR} for what the ECB has actually done, {EURC} for whether the curve agrees, {BUND} for the 2-year read on the same path.",
  },
  HICP: {
    tip: "euro-area inflation's 6-month turn: HICP y/y minus its own value six months earlier, in percentage points.",
    why:
      "A hiking path hurts banks most while inflation is still rising - the ECB keeps tightening into weakness. Once y/y inflation is below its level six months back, the path tends to be priced out and bank equities recover. Display-only context for the EU-Fin basket: it does not move the danger dial or any alert.",
    lies:
      "It is monthly and the final print lands about halfway through the following month, so a turn shows up late. An energy-price swing can flip the sign without any change in underlying inflation.",
    with:
      "{EPATH} for how much hiking the market prices, {ESTR} for what the ECB has actually done, {BRENT} for the energy driver behind a headline swing.",
  },
  ECISS: {
    tip: "the ECB's composite stress index for the euro area (CISS): how strained its financial markets are, 0 to 1.",
    why:
      "It aggregates stress across money, bond, equity and FX markets and financial intermediaries, weighting them by how closely they move together - so it climbs hardest when stress spreads across markets at once. Display-only context for the EU-Fin basket: it does not move the danger dial or any alert.",
    lies:
      "The ECB releases it once a week, so the latest days arrive in a batch and trail the market by several days. It measures stress already visible in prices, so it confirms trouble rather than leading it.",
    with:
      "{BONOS} for sovereign stress inside the euro area; {AT1} for whether that stress has reached bank capital.",
  },
  BONOS: {
    tip: "the Bonos−Bund spread (Spanish 10y minus German 10y): the market price of Spanish sovereign risk.",
    why:
      "Spain is the euro area's second peripheral debtor and the 2012 bank-rescue case: a fast widening, or a spread through the intervention zone, is euro sovereign stress landing on the banks that hold that debt - the same doom-loop channel as Italy, one border west.",
    lies:
      "Fires on a fast repricing OR an absolute level, so a slow grind to a wide plateau reads GREEN until the level cut; the feed is an unofficial keyless aggregator, so a dead feed drops the card rather than the whole board.",
    with:
      "{BUND} for haven flows in the German leg; {ECISS} for whether the strain has spread across euro-area markets.",
  },
  EURGBP: {
    tip: "pounds per euro (ECB reference rate): rising means sterling is weakening against the euro.",
    why:
      "Over a quarter of the held EU-Fin basket is UK-listed and priced in pounds, so a sterling slide cuts the fund's euro value directly. A fast fall in sterling is also the market's verdict on UK stress - Brexit 2016, the 2022 gilt crisis, March 2020.",
    lies:
      "Display-only: moves no dial or alert; the ECB fixes it daily at 16:00 CET, so evening moves land next day. One-sided: sterling RISING (a hawkish BoE) never fires. If only the moving-average leg fires, the line sits under the band; the card names that leg.",
    with:
      "{FXH} for euro-side haven flows; {ECISS} for whether euro-area markets share the strain.",
  },
  CQS: {
    tip: "the corporate quality spread (Baa − Aaa): what the market charges to step down the investment-grade ladder.",
    why:
      "Subtracting the Aaa from the Baa yield cancels the Treasury term entirely, leaving a pure credit-quality price that only moves when conviction about weaker borrowers changes. It updates daily, so it bridges the weeks EBP's monthly print leaves dark.",
    lies:
      "Both legs are Moody's index yields, so membership changes and rating migrations move the gap without any repricing. The Aaa universe has shrunk to a handful of issuers, making that leg thin. And it is a realized spread: in a fast crash it confirms rather than warns.",
    with:
      "{EBP} strips expected defaults out of corporate spreads generally; {F1} is the faster, index-priced market read. A rise here with {F1} flat is rating migration or a thin Aaa leg, not a repricing.",
  },
  FXH: {
    tip: "the FX-haven composite (EUR/CHF/JPY vs USD): the strongest single haven-bid move reads flight-to-safety in the currencies.",
    why:
      "When global money runs for safety it bids the franc, the yen and the dollar - a flight the deep, continuously traded currency markets register directly. The composite takes the strongest single haven bid of the three, so one quiet pair cannot dilute a real move.",
    lies:
      "Haven currencies also move on their own central banks - a Japanese policy surprise or a Swiss intervention reads as flight with no global stress behind it. Rate-differential trends can push the pairs for months, so a slow haven drift is often carry, not fear.",
    with:
      "{F17} for the opposite yen read - carry stress on weakening, haven bid here on strength; {BONOS} for whether a euro sovereign scare is driving the flight; {R5} for whether equity fear confirms it.",
  },
  ECY: {
    tip: "excess CAPE yield (1/CAPE minus the 10-year real yield) ranked against its own history: is the US market expensive?",
    why:
      "Allocators weigh what equities yield against what risk-free real bonds pay; when the gap ranks low against its own history, holders are unpaid for equity risk and have no cushion. Valuation alone times nothing, so expensive only turns dangerous here once the global trend breaks - the exit confirming the overpricing mattered.",
    lies:
      "It deviates from Shiller's published construction - the daily TIPS real yield stands in for nominal-minus-trailing-inflation - so levels are not comparable to his tables. Expensive markets can stay expensive for years, as the run into 2000 showed; cheap after a crash is not a buy signal here either.",
    with:
      "{GT} is the gate itself - expensive plus a broken {GT} is this card's dangerous shape; {F7} is the raw valuation input, {GB} whether thinning participation is starting to confirm the exit.",
  },
  GT: {
    tip: "global trend: the all-country world index (ACWI) above or below its own long-term moving average.",
    why:
      "When buyers thin out worldwide, the cushion between the world index and its own long-term trend erodes before the trend actually breaks. Reading that distance rather than waiting for a cross is what makes this the leading global-trend leg, covering every region in one read.",
    lies:
      "Trend reads are late by nature - a crash from the highs travels far before any moving-average cushion gives way. Sideways chop whipsaws it, and a strong US market can hold the cap-weighted world index above trend while everything else breaks down.",
    with:
      "{GB} for whether participation confirms the trend - a healthy margin here on thin breadth is the fragile shape; {DISP} for whether regions are breaking together; {ECY} turns expensive-market readings into danger only once this trend goes.",
  },
  GB: {
    tip: "the share of seven region and style funds trading above their own long-term average; thin participation is danger.",
    why:
      "Bull markets die from the inside: money retreats into a few large names while the average holding rolls over. Counting how many region and style funds still hold their own long-term trend reads that retreat directly - participation narrows before the headline index, held up by its biggest members, follows.",
    lies:
      "Defensive members of the basket hold their trend well into a downturn, softening the count exactly when it matters, and a fast crash takes everything below trend at once - by then it confirms rather than warns. Sideways markets whipsaw the marginal members.",
    with:
      "{GT} for the cap-weighted trend this breadth read cross-examines - index above trend on thin participation is the narrow, fragile market; {SPCONC} for the same narrowing measured inside the US index itself.",
  },
  DISP: {
    tip: "do the US, Europe and EM proxies (SPY·FEZ·EEM) fall together (systemic) or does one region drop alone (isolated)?",
    why:
      "Global investors dump everything at once only when stress is systemic; an isolated shock stays in its region. This reads whether the US, European and emerging-market proxies are falling together - regions moving as one on the way down is the signature of broad de-risking rather than a local story.",
    lies:
      "Coincident by construction - the trigger is a fall that has already happened. A shared macro repricing can couple the regions without a crash following, and a one-region crisis reads calm here at first. The plotted line is a correlation - high, not low, is the coupled and fragile end.",
    with:
      "{GB} for participation - thin breadth with regions falling together is the systemic shape; {GT} for whether the world trend has broken under it; {FXH} for the currency-side flight that accompanies real de-risking.",
  },
  F4: {
    tip: "semis momentum: SMH's own trailing multi-month return, moving-average gated - the SLOW semis read.",
    why:
      "Semiconductors are the market's most cyclical tech exposure, so a deep, sustained break in the sector's own price trend means the market has moved from fearing a downturn to pricing one. It is the slow, persistent semis read.",
    lies:
      "Coincident by design - the drawdown it needs has already happened, so it times nothing. Sector momentum also breaks on idiosyncratic supply gluts with no macro message, and a sharp V-shaped recovery leaves it fired well after the danger has passed.",
    with:
      "{F6} watches the same sector relative to the market - absolute damage here with relative strength intact is a market-wide fall, not a semis story; {DB_SMH} is the faster break detector on it; {NVDA} the leader's trend gate.",
  },
  NVDA: {
    tip: "Nvidia's price against its own long-run trend line: the AI leader's trend gate.",
    why:
      "Nvidia is the concentration of the AI trade in one name - the buyer confidence that funds the whole semis complex is priced through it daily. When its own trend breaks, the market has stopped paying up for the buildout the rest of the sector's revenue depends on.",
    lies:
      "A trend read fires only after the fall has happened - coincident by construction. Single-name news - earnings, export rules, a product stumble - can break the trend with no macro message, and a long sideways drift can hold it below trend while the sector is fine.",
    with:
      "{F4} is the semis leg this trend gates; {F6} says whether the sector is losing ground against the market; {HCX} whether the customers funding the buildout are de-rating too.",
  },
  F5: {
    tip: "market breadth: cap-weighted Nasdaq-100 (QQQ) versus its equal-weighted twin (QQQE).",
    why:
      "When conviction narrows, investors crowd into the few mega-caps still delivering, so the cap-weighted index outruns its equal-weighted twin. A market carried by a handful of names is fragile - one theme stumbling takes the index with it - the shape that marked the run into 2000.",
    lies:
      "Narrow leadership can persist for years before anything breaks, so it is a fragility read, not a timer. The ratio also falls in a healthy broadening rally - moving off the high alone says nothing about danger.",
    with:
      "{SPCONC} is the same read across the whole S&P - both at highs means the narrowing is market-wide, not a tech quirk; {GB} for whether global participation is thinning the same way.",
  },
  SPCONC: {
    tip: "S&P 500 concentration: cap-weighted SPY versus its equal-weighted twin RSP.",
    why:
      "The cap-weighted S&P against its equal-weighted twin reads how much of the market's advance rests on its largest names. Gains narrowing into a few giants means the average stock has already stopped participating - fragility the headline index hides until one crowded theme cracks.",
    lies:
      "Only fresh-high days signal: the at-high shape survived a date-rotation placebo while a rising-velocity read preceded stronger returns - the wrong sign - so a fast-rising ratio short of a new high is deliberately no signal. And concentration can build for years before it matters.",
    with:
      "{F5} is the same read inside the Nasdaq-100 - lit together, the narrowing is market-wide, not a tech story; {GT} says whether the world trend is still carrying the crowding.",
  },
  F6: {
    tip: "semis relative strength: the SMH/SPY ratio against its own long-term average - the sector-risk flag.",
    why:
      "When investors rotate out of the market's most cyclical sector relative to everything else, they are repricing the hardware cycle itself, not just de-risking. Dividing by the market strips the broad tape out, isolating the sector call - the slow flag that semis are losing leadership.",
    lies:
      "In a market-wide crash everything falls together, so relative strength can hold and this card reads calm mid-collapse - it flags sector rot, not systemic danger. Coincident: the ratio has to break its own trend before it says anything, and it says nothing about why.",
    with:
      "{F4} reads the sector's absolute damage - relative weakness here with {F4} calm is rotation, both broken is the cycle turning; {FDX} says whether the stress is concentrated in the foundry.",
  },
  F8: {
    tip: "the memory-chip cycle via MU (Micron): a pure-play memory maker against its own long-run trend.",
    why:
      "Memory is the most commodity-like corner of semiconductors - its prices swing hardest when chip demand turns, and a pure-play maker's share price tracks that cycle daily. A confirmed break here says the semis damage is the cycle itself rolling over, not one name's story.",
    lies:
      "A single equity is a noisy proxy for a commodity cycle - beta plus company-specific news move it with no memory message - so it is a soft confirmer, never a solo trigger. Its bands are deliberately wide starting priors, uncalibrated.",
    with:
      "{F4} is the broad semis leg this nudges - memory breaking while {F4} holds is an inventory story; {NVDA} says whether the AI end of the sector is cracking too.",
  },
  F13: {
    tip: "credit appetite: the HY-vs-IG ETF ratio's trend and its pace of change.",
    why:
      "Dividing the high-yield ETF by the investment-grade one cancels the shared rates move, leaving pure credit appetite - and ETF investors reprice that in the market daily, days before the official cash-bond spreads catch up. When the appetite rolls over, the funding squeeze F1 will later confirm is already starting.",
    lies:
      "ETF prices carry flow noise: a big rebalance or a liquidity air-pocket in HYG can move the ratio with no credit news behind it. The lead over cash spreads is measured in days, not weeks - it sharpens timing, it does not add a new warning horizon.",
    with:
      "{F1} - this is the fast ETF read of the same appetite: both rolling over together is the confirmed turn, a move {F1} never confirms was flow noise. {R5} tells whether a broad volatility shock is driving the ratio instead.",
  },
  F9: {
    tip: "the US dollar via the WisdomTree USD Bullish ETF (USDU): a FAST-rising dollar squeezes emerging-market financing.",
    why:
      "Emerging markets borrow in dollars, so a fast-rising dollar raises their debt burden and drains capital from their markets at the same time - the classic external squeeze. Because the dollar itself is the transmission channel, its rate of climb over a 60-TRADING-DAY window is the fastest external stressor the EM leg faces.",
    lies:
      "A dollar that grinds higher on rate differentials carries the same squeeze but never trips a speed read - and the level axis was retired because a trending gauge makes any level cut a date threshold in disguise. A haven-driven spike is a symptom of stress, not a forewarning.",
    with:
      "{F10} for whether EM credit spreads confirm the squeeze, {F11} for the China-specific side of the same pressure, {FXH} for whether the dollar's strength is haven flight rather than a financing story.",
  },
  F10: {
    tip: "the emerging-market corporate credit spread (BAMLEMCBPIOAS): EM spreads widen before EM equity drawdowns.",
    why:
      "Emerging-market borrowers are cut off first when global lenders retrench: flight-to-quality sells their bonds early, widening this spread before the EM equity leg draws down. It is the direct daily price of emerging-market default and funding risk.",
    lies:
      "Its cuts are hand-set priors on a corporate index standing in for the sovereign benchmark. Index membership shifts can move the spread without any repricing, and a global dollar-funding squeeze can widen it while EM equities hold up.",
    with:
      "{F9} for the dollar pressure that usually drives the squeeze, {F11} for the China-specific stress a broad index dilutes, {F1} for whether the widening is EM-specific or the global credit cycle turning.",
  },
  F11: {
    tip: "Chinese yuan per US dollar (CNY=X): a FAST-weakening yuan is a China/EM risk-off signal.",
    why:
      "The central bank manages the yuan, so it does not drift - when it weakens fast, policy is allowing or engineering depreciation, a deliberate signal of China stress. Markets read that as devaluation risk and pull capital across emerging markets; how fast it moves over a 60-TRADING-DAY window is the whole signal.",
    lies:
      "A managed float's level reads the peg regime, not danger - the level axis was retired for exactly that. Gradual depreciation to support exports looks identical to stress at first, and a heavy-handed defense can hold the rate flat while pressure builds unseen.",
    with:
      "{F10} for whether EM credit prices the same China stress, {F9} for the broad-dollar side - yuan weakness on a flat dollar is China-specific, both moving together is the global squeeze.",
  },
  F17: {
    tip: "Japanese yen per US dollar (JPY=X): a FAST-weakening yen is a Japan / carry-stress risk signal.",
    why:
      "The yen funds global carry trades - investors borrow it cheap to buy risk assets everywhere - and Japan is the largest developed-market slice outside the US in the ladder's coverage. A fast-weakening yen means the carry position is growing more crowded and fragile, strain that builds toward a violent unwind.",
    lies:
      "The unwind itself is a yen surge, which this direction deliberately sits out - the haven-strength side belongs to FXH. Policy is the usual mover: a Bank of Japan decision or an intervention can swing the rate hard with no global stress attached.",
    with:
      "{FXH} for the yen-strength unwind this card deliberately ignores, {R5} for whether a carry shake-out has reached equity volatility, {F9} for the broad-dollar move the yen leg often rides.",
  },
  T10YIE: {
    tip: "the 10-year inflation breakeven (T10YIE): the bond market's priced 10-year inflation expectation; a crisis regime discriminator.",
    why:
      "The gap between nominal Treasury and TIPS yields is the average inflation the bond market prices for the coming decade. It splits every shock into two regimes: breakevens falling is a growth scare policy can ease into; breakevens climbing is stagflation, where the central bank is trapped and bonds stop protecting equities.",
    lies:
      "In a liquidity crash TIPS cheapen faster than nominals and breakevens collapse mechanically - 2008 printed a deflation panic that was partly plumbing - so a plunge overstates the growth scare. It is a regime discriminator, not a danger gauge on its own.",
    with:
      "{T5YIFR} looks past the current shock to ask whether expectations are de-anchoring; {G1} spiking while this climbs is the stagflation shape, {G1} spiking while this falls a growth scare.",
  },
  T5YIFR: {
    tip: "the 5-year, 5-year forward inflation expectation (T5YIFR): the Fed's preferred de-anchoring gauge.",
    why:
      "Investors price this off inflation for the five years starting five years out - past any current shock - so a climb means the market doubts inflation will settle back. A central bank facing that doubt must stay tight into weakness, removing the easing cushion equities lean on in a downturn.",
    lies:
      "Anchored on policy landmarks - the de-anchoring line and the re-anchored band - rather than this series' own distribution, so it fires more readily than the ten-year card. And like any breakeven it collapses mechanically in a liquidity crash, overstating the growth scare.",
    with:
      "{T10YIE} carries the current shock; a rise here that {T10YIE} shares is de-anchoring, a rise only there is a spot repricing expectations still see fading. {G1} says whether an oil shock is driving it.",
  },
  OVX: {
    tip: "crude-oil implied volatility: the oil market's fear gauge; an auto geopolitics flag beside the WTI spike read (G1).",
    why:
      "Option writers on oil demand more premium when supply could gap - an embargo, a strait closure, an escalation - so elevated oil-implied volatility means the market is pricing a live shock regime rather than a noisy tape. It reads the fear on the barrel, distinct from the barrel's price.",
    lies:
      "Oil volatility also explodes when prices collapse - the 2020 demand crash sent it vertical with no supply shock anywhere - so an elevated read is not by itself geopolitical. Its cuts are hand-set provisional priors.",
    with:
      "{G1} and {BRENT} are the price legs of the same oil factor - vol elevated while they are quiet is hedging demand ahead of an event; all three lit is the confirmed shock.",
  },
  BRENT: {
    tip: "the seaborne oil benchmark; an auto geopolitics confirm beside the WTI spike read (G1).",
    links: [{ label: "Brent CFD (Sep 26)", url: "https://www.trading212.com/trading-instruments/cfd/CRUDE.SEP26" }],
    why:
      "Brent prices the seaborne barrels an embargo or strait closure actually strands, so a genuine geopolitical disruption bids it hardest. A fast run-up that also carries the price to its trailing multi-year peak is the market pricing a live supply shock, not a demand wiggle or a rally off a low.",
    lies:
      "The at-peak gate replaced a fixed dollar cut: a trailing peak is scale-invariant and never needs a hand retune, but a violent run-up off a deep low is held to a muted read as recovery, not shock, until the peak is actually reached.",
    with:
      "{G1} is the landlocked US twin - Brent stretching away from it is the seaborne-supply signature; {OVX} says whether the options market is pricing the shock as live rather than passed.",
  },
  EBP: {
    tip: "the excess bond premium: the slice of credit spreads driven by pure investor risk appetite.",
    why:
      "Researchers strip expected defaults out of corporate spreads; what remains is pure lender risk appetite. When that appetite evaporates, credit supply contracts before any default statistics move, and the pullback in lending is what drags growth and earnings down - which is why it is a validated recession predictor.",
    lies:
      "Monthly, and published with a long lag, so a fast crash is over before it prints - CQS exists as its daily bridge. It is a model output, not a market price: the default-expectation model it subtracts can itself be wrong at turning points.",
    with:
      "{CQS} bridges the weeks between its monthly prints; {F1} is the raw spread it is decomposed from. Elevated here while {F1} sat quiet means appetite was thinning before the price showed it - a confirmation, not an early read.",
  },
  // --- Slow "bubble-state" track (channel SLOW) -----------------------------
  // These have `thresholds: {}` and no Green/Amber/Red cut-points (scored 0–2
  // in slow.ts). They drive the slow CALM/ELEVATED/DE-RISK band
  // and its own notification — never the fast OK/WATCH/WARNING/CRITICAL ladder.
  "price-accel": {
    tip: "QQQ's trailing few-month return ranked against its own history: a melt-up / blow-off gauge.",
    why:
      "Late-cycle tops are preceded by price running away from its own history - buyers chasing performance, shorts giving up. Ranking the index's trailing few-month return against its own past flags when the advance has reached that unusual speed - the late-cycle fuel the bubble track exists to watch.",
    lies:
      "A strong recovery off a low ranks just as hot as a blow-off - speed alone cannot tell them apart. Scored fresh each day in both directions with no confirmation fold, so a single close can flip its state either way.",
    with:
      "{complacency-vix} and {complacency-high} are the other bubble-state legs - acceleration with complacent option pricing and price at the highs is the full late-cycle set-up; {GT} says whether the trend fuelling it is still intact.",
  },
  "complacency-vix": {
    tip: "where VIX sits in its own range: an unusually low reading flags market complacency.",
    why:
      "When calm persists, protection looks like wasted premium and investors stop paying for it - option prices drift to the floor of their own range while unhedged exposure builds. That positioning is the fragility: a shock then forces everyone to buy protection at once, turning a dip into a rush for the exit.",
    lies:
      "Calm can persist for years, so a low read times nothing on its own. No confirmation fold applies - each day's close rescores it outright, in either direction.",
    with:
      "{complacency-high} is the paired leg - calm options with price at the highs is the classic complacent set-up; {complacency-duration} asks how long the calm has run; {R5} is the same gauge read as stress rather than calm.",
  },
  "complacency-high": {
    tip: "how close QQQ sits to its own one-year high: at the highs is the second complacency leg.",
    why:
      "A market at its highs breeds complacent positioning - nothing in recent memory has punished holding, so exposure and leverage build. Reading the close as a fraction of its own trailing high flags that set-up.",
    lies:
      "Colours read inverted on purpose - at the highs is the dangerous end. A market already well below its high turns Green: not an all-clear, only the statement it is no longer complacent. Scored fresh each day in both directions, with no confirmation fold.",
    with:
      "{complacency-vix} is the options half of the same set-up - both lit is textbook complacency; {price-accel} says whether the run to the highs was also unusually fast, the melt-up variant.",
  },
  "complacency-duration": {
    tip: "how long VIX has sat at or below its own median: a prolonged calm run is fragile-calm fuel.",
    why:
      "The longer volatility stays pinned below its own norm, the more leverage and short-volatility positioning build on the assumption calm continues - stability breeding instability, the Minsky read. Counting the unbroken run of subdued closes reads that persistence directly, a different fact from how deep the calm is.",
    lies:
      "One loud close resets the run while nothing is resolved, and its cuts are unvalidated starting priors. Its confirmed state moves symmetrically - deterioration and improvement alike wait out the same clean closes, and Amber is its ceiling.",
    with:
      "{complacency-vix} reads the depth of the same calm this reads the length of; {VT} shows the moment calm actually breaks - the curve inverting ends the question this card is asking.",
  },
  // --- Portfolio drawdown track (channel PENSION) ---------------------------
  // Instrument detail rows: `thresholds: {}`, no own Green/Amber/Red state - charted for
  // attribution, never the fast alert ladder.
  SPY: {
    tip: "the S&P 500 (SPY), in USD adjusted close.",
    why:
      "The large-cap US benchmark, tracked through a US-listed ETF's dividend-adjusted close - the drawdown track's US sleeve and the yardstick the relative-strength legs divide by. Charted beside the holdings so a fall in the book can be attributed: the broad market, or the book's own tilts.",
    lies:
      "Dollar-quoted, so its euro-terms path carries the currency leg on top of the equity move. Cap-weighted: a handful of mega-caps can hold the line up while the average stock has already rolled over.",
    with:
      "{SPCONC} says how much of its advance rests on the largest names; {DEXUSEU} the rate that turns this line into euro terms - a fall here that {SP500IT} deepens is the book's tech tilt, not the broad market.",
  },
  DEXUSEU: {
    tip: "the USD-per-EUR exchange rate: converts the portfolio legs to EUR.",
    why:
      "Dollars per euro - the rate every dollar-quoted sleeve is divided by so the book reads in the holder's own currency. A euro investor's drawdown is the price move plus the currency move; charting the rate alongside the sleeves separates the two.",
    lies:
      "The currency leg can dominate a quiet tape: a falling dollar erodes every dollar sleeve in euro terms while prices sit still - and in a global scare a dollar haven bid can cushion those same sleeves as equities fall.",
    with:
      "{FXH} reads haven flight off this pair and its siblings; {F9} scores the dollar's speed of climb - the stress read of the move this line just charts - the two agreeing turns a currency drift into a stress story.",
  },
  SP500IT: {
    tip: "the S&P 500 Information Technology sector (via XLK), in USD adjusted close.",
    why:
      "The S&P 500 information-technology sector, tracked through a US-listed sector ETF's dividend-adjusted close - the direct series behind the book's own tech sleeve, where the board's other tech reads are proxies. Charted so a drawdown in the book can be attributed to the sector actually held.",
    lies:
      "A cap-weighted sector: a few giants dominate it, so the line reads their fortunes more than the industry's. Sector definitions shift - index reclassifications have moved big names in and out, bending long histories.",
    with:
      "{DB_XLK} is the fast break detector on this exact series and {RS_XLK} its relative-strength gate; {F6} asks the same leadership question of the semis proxy one level down.",
  },
  LEGP_EUFIN: {
    tip: "European high-dividend equity (EXSH.DE), in EUR.",
    why:
      "The rotation ladder's European high-dividend leg, priced off a euro-quoted 30-stock basket on Xetra - three-fifths financials, the rest cyclicals and energy, much UK-listed. The line is a real-euro total-return level, seeded at the fund's actual close and extended each run - not an index - and it charts what the leg the ladder can rotate into is doing.",
    lies:
      "Total return: if the fund distributes, each payout lifts the line above its quote. Financials-heavy but not a euro-bank fund: a quarter of it trades in sterling and a fifth is non-financial cyclicals, so UK rate and consumer news move it alongside euro sovereign spreads.",
    with:
      "{BONOS} prices the sovereign risk euro banks carry on their books - a widening there hits this leg first; {AT1} says whether that stress has reached the banks' own subordinated capital.",
  },
  LEGP_HEALTH: {
    tip: "US health-care equity (QDVG.DE), in EUR.",
    why:
      "The rotation ladder's defensive health-care leg, priced off the S&P 500 Health Care index quoted in euros on Xetra. The line is a real-euro total-return level, seeded at the fund's actual close and extended each run - not an index - and it charts what a defensive sleeve the ladder can rotate into is doing.",
    lies:
      "Total return: if the fund distributes, each payout lifts the line above its quote. It is a US sector in euro terms: the currency leg rides on top, so a falling dollar can drag the euro path down while the sector holds in dollars.",
    with:
      "{SP500IT} is the other US sector leg charted the same way, tech against health; {LEGP_EUFIN} is the European sleeve the ladder rotates between - divergence says whether the damage is regional or defensive.",
  },
  LEGP_COMMOD: {
    tip: "commodities basket (LYTR.DE), in EUR: an off-ladder detail sleeve, not held.",
    why:
      "An equal-weighted Bloomberg Energy & Metals basket of twelve commodity futures - roughly a third energy, a third industrial metals, a quarter precious metals, no agriculture - so it trades as a global-growth asset. The line is a real-euro total-return level, seeded at the fund's actual close - not an index.",
    lies:
      "Total return: if the fund distributes, each payout lifts the line above its quote. Off the ladder: watched for rotation context, never a held position, so its drawdown is informational. Energy and metals dominate, so an oil or China-demand shock moves it more than precious metals.",
    with:
      "{BRENT} and {NG} price the energy third directly; {CG} reads the industrial-metals cycle against the precious haven; {F9} the dollar every contract is priced in.",
  },
  LEGP_RAFI: {
    tip: "AW-Fundamental basket (PSWD.DE), in EUR: an off-ladder detail sleeve, not held.",
    why:
      "The Invesco FTSE RAFI All-World 3000 - thousands of developed and emerging names weighted on fundamentals (sales, cash flow, book, dividends) not market cap, so financials lead, the tilt is deep-value and cyclical, and half the capital sits outside the dollar. The line is a real-euro total-return level, seeded at the fund's actual close - not an index.",
    lies:
      "Total return: if the fund distributes, each payout lifts the line above its quote. Off the ladder: watched for rotation context, never a held position. A global sleeve in euro terms, so a falling dollar drags the euro path when the underlying holds in local currency.",
    with:
      "{F1} and {KBE_RS} read the credit and bank-equity stress that hits value first; {CG} the cyclical block; {F9} the non-dollar half of the book.",
  },
  LEGP_SEMIS: {
    tip: "semiconductor equity (SEC0.DE), in EUR.",
    why:
      "The rotation ladder's most aggressive leg, priced off the held SEC0 fund (an MSCI global semiconductors index) quoted in euros on Xetra. The line is a real-euro total-return level, seeded at the fund's actual close and extended each run - not an index - and it charts what the top rung of the ladder is doing.",
    lies:
      "Before the fund's first close in August 2021 the line is SMH converted to euros, joined to meet that close - a stand-in, shaded on the chart. Mostly US chip stocks in euro terms: a dollar swing moves it on top of the sector, and a few giants dominate.",
    with:
      "{DB_SMH} is the fast break detector on the same semis tape and {F6} its leadership read; {LEGP_SPIT} is the broader tech leg one rung down.",
  },
  LEGP_SPIT: {
    tip: "US information-technology equity (QDVE.DE), in EUR.",
    why:
      "The rotation ladder's S&P 500 IT leg, priced off an S&P 500 Information Technology fund quoted in euros on Xetra. The line is a real-euro total-return level, seeded at the fund's actual close and extended each run - not an index - and it charts the tech rung the ladder can hold.",
    lies:
      "Total return: if the fund distributes, each payout lifts the line above its quote. A US sector in euro terms: a falling dollar can drag the euro path while the sector holds in dollars, and a few giants dominate it.",
    with:
      "{SP500IT} is the same sector in dollars, so the gap between the two is the currency leg; {LEGP_SEMIS} is the more aggressive rung above.",
  },
  LEGP_EM: {
    tip: "emerging-market equity (IS3N.DE), in EUR.",
    why:
      "The rotation ladder's emerging-markets leg, priced off an MSCI emerging-markets IMI fund quoted in euros on Xetra. The line is a real-euro total-return level, seeded at the fund's actual close and extended each run - not an index - and it charts the EM rung the ladder can rotate into.",
    lies:
      "Total return: if the fund distributes, each payout lifts the line above its quote. EM equity in euro terms rides a basket of local currencies against the euro, and a few Asian chip and internet names carry much of the weight.",
    with:
      "{VWO} is the dollar EM comparator, so their gap is the currency translation; {F9} the dollar strength that historically squeezes emerging markets first.",
  },
  LEGP_SPX: {
    tip: "US large-cap equity (SXR8.DE), in EUR.",
    why:
      "The rotation ladder's S&P 500 leg, priced off an S&P 500 fund quoted in euros on Xetra. The line is a real-euro total-return level, seeded at the fund's actual close and extended each run - not an index - and it charts the broad US rung the ladder can hold.",
    lies:
      "Total return: if the fund distributes, each payout lifts the line above its quote. The US market in euro terms: a falling dollar can drag the euro path while the index holds in dollars, and mega-cap concentration means a few names drive it.",
    with:
      "{SPY} is the same index in dollars, so their gap is the currency leg; {SPCONC} reads how concentrated that index has become.",
  },
  LEGP_EXUS: {
    tip: "developed ex-US equity (CHSI.DE), in EUR.",
    why:
      "The rotation ladder's ex-US leg, priced off the held CHSI fund (MSCI World ex USA index) quoted in euros on Xetra. The line is a real-euro total-return level, seeded at the fund's actual close and extended each run - not an index - and it charts the non-US rung the ladder can rotate into.",
    lies:
      "Before the fund's first close in March 2025 the line is VEA converted to euros, joined to meet that close - a stand-in, shaded on the chart. The euro holdings carry no currency leg, but yen, sterling and franc swings stack on top of the equity.",
    with:
      "{VGK} is developed Europe, its largest region; {LEGP_EUFIN} the narrow European leg; {GT} whether the global trend behind all three has broken.",
  },
  LEGP_STAPLES: {
    tip: "US consumer-staples equity (ZPDS.DE), in EUR.",
    why:
      "The rotation ladder's most defensive equity leg, priced off the S&P Consumer Staples Select Sector index quoted in euros on Xetra. The line is a real-euro total-return level, seeded at the fund's actual close and extended each run - not an index - and it charts the last rung before cash.",
    lies:
      "Total return: if the fund distributes, each payout lifts the line above its quote. A US sector in euro terms, so a falling dollar drags the euro path; staples can slide in a rate shock even as they hold in a growth scare.",
    with:
      "{LEGP_HEALTH} is the other defensive US sector leg; {LEGP_SPX} the broad market the ladder rotates out of - staples holding while it falls is the defensive rotation working.",
  },
  // --- Comparator legs (channel PENSION) ------------------------------------
  // Alternative sleeves the book could hold but does not weight today: they are rows in the
  // same sleeve table, so they accrue and chart like any pension leg, but carrying no weight
  // keeps them out of the blend and out of the band. SPY is a comparator too — its entry is
  // above, under its sleeve role, and is never duplicated here.
  VWO: {
    tip: "emerging markets (VWO), USD adjusted close: a comparator sleeve, not held.",
    why:
      "Broad emerging-market equity in dollar terms, converted to euros for the book - a comparator sleeve: an alternative the ladder could hold but gives no weight, charted so its path can be judged against the sleeves actually held.",
    lies:
      "Dollar-quoted emerging-market equity stacks the currency leg on top of the riskiest equity sleeve, so its euro path swings hardest of the comparators. China-heavy: one country's policy cycle can move the whole line.",
    with:
      "{F9} for the dollar squeeze that drives EM drawdowns, {F10} for whether EM credit is pricing stress, {F11} for the yuan - the currency read on the China risk that dominates the basket.",
  },
  VGK: {
    tip: "developed Europe (VGK), USD adjusted close: a comparator sleeve, not held.",
    why:
      "Developed European equity through a US-listed, dollar-quoted fund, converted back to euros for the book - a comparator sleeve the ladder gives no weight. It benchmarks the European sleeves actually held against the broad regional market.",
    lies:
      "The dollar round-trip - euro assets in a dollar wrapper, converted back - adds noise the Xetra-quoted sleeves avoid. Value-tilted relative to the US index, so US-Europe divergence is partly a sector story, not a regional one.",
    with:
      "{LEGP_EXUS} is the wider developed ex-US read it sits inside; {LEGP_EUFIN} the narrow European leg the ladder holds - divergence among the three says whether Europe's damage is regional or sector-specific.",
  },
  XDEV: {
    tip: "World Value (XDEV.DE), EUR close: the comparator sleeve the value chip now prints.",
    why:
      "The world-value fund the value chip prices, quoted in euros on Xetra so it never passes through the dollar conversion. A comparator sleeve the book gives no weight; it replaced a US value proxy that explained little of this fund's actual movement - the chip now prints the real thing.",
    lies:
      "Long windows splice two different underlying indices end to end - the fund switched benchmark early in its history - so multi-year comparisons mix regimes; the detail window sits entirely post-switch. And value is a relative style: in a liquidity crash it falls with everything else.",
    with:
      "{GT} says whether the world trend both styles ride is intact; {GB} whether participation is broadening - value leading on thinning breadth is defensive rotation, not strength.",
  },
  // Value-ladder inputs: same comparator shape, read by the
  // value-tranche probe, display-only here.
  KBE: {
    tip: "US banks (KBE), USD adjusted close: display-only value-ladder input.",
    why:
      "The US bank fund's adjusted close, the numerator of the bank relative-strength card. The right-axis line is the value re-entry probe's bank-equity read: the worst close off its running high inside the probe's window, against the second third's block line and its near-miss.",
    lies:
      "A sector price, not a signal: banks can fall with the market on a liquidity scare and no credit story behind it. And the relative-strength card on this ticker can disagree with the eye's read of this line.",
    with:
      "{KBE_RS} is the strength-versus-market read on this very price; {F1} the credit spread that leads bank-equity stress; {LEGP_EUFIN} the European financials sleeve it benchmarks.",
  },
  BBB: {
    tip: "BBB US corporate spread (FRED), percent: a display-only credit card, never scored.",
    why:
      "The option-adjusted spread of the lowest investment-grade tier over Treasuries - the rung where downgrades turn into forced selling. Display-only here: it moves no dial, push band or panel. The semis drawdown watch reads its widening as a confirmer that can lift an elevated grade while a lead signal votes.",
    lies:
      "A daily FRED print that lands a day late, and investment-grade spreads move slowly - a sharp equity sell-off can run its course before this line widens. It says nothing about chips on its own.",
    with:
      "{F1} is the high-yield spread one tier down; {CCC} the distress end - BBB widening with both calm is a rates or supply story, not a credit crunch.",
  },
  CCC: {
    tip: "CCC & lower US high-yield spread (FRED), percent: a credit-panel member scored on its level and widening speed.",
    why:
      "The option-adjusted spread of the weakest US high-yield tier over Treasuries - the distress end of the credit market. A credit-panel member: it scores on every leg's credit cell but never moves the dial or the push band. Served raw in percent because the level itself is the criterion.",
    lies:
      "The tier is thin and issuer-concentrated, so one sector's defaults can gap the spread without a market-wide story. And it is a lagging, daily FRED print - the broad high-yield card moves first.",
    with:
      "{F1} is the broad high-yield spread this tier sits inside; {F2} the investment-grade read - a CCC blow-out with both calm is a distress pocket, not a credit crunch.",
  },
  HYNIX: {
    tip: "SK Hynix (000660.KS), KRW close: a value-ladder display-only comparator.",
    why:
      "The other memory maker beside Micron. The value re-entry probe prints how far each sits off its trailing high and which broke first - a read on whether the memory cycle is turning everywhere or in one name. Printed only; never a criterion.",
    lies:
      "A Korean listing: the won, KOSPI flows and a local session that closes before New York move it for reasons memory pricing never had.",
    with:
      "{F8} is the Micron close it is compared against; {MU_RS} Micron's strength versus the semis basket; {LEGP_SEMIS} the basket both ride.",
  },
  AMAT: {
    tip: "Applied Materials (AMAT), USD adjusted close: a value-ladder display-only comparator.",
    why:
      "The largest chip-equipment maker. The value re-entry probe prints its ratio to Micron against the ratio's own moving average - equipment leading memory says capex is being pulled forward, memory leading equipment says the cycle is spending itself. Printed only; never a criterion.",
    lies:
      "One name with its own order book, China exposure and export-licence headlines; the ratio can move on an AMAT-only story.",
    with:
      "{F8} is the Micron close under the ratio; {LEGP_SEMIS} the semis basket both belong to; {HCX} the hyperscaler capex read the equipment line should confirm.",
  },
  KRW: {
    tip: "Won per US dollar (KRW=X): a value-ladder display-only comparator.",
    why:
      "The won is the export-cycle currency - Korea sells the world's memory chips, and a weakening won tends to run with a falling chip and trade cycle. The value re-entry probe prints its change over the trailing high window beside the memory reads. Printed only; never a criterion.",
    lies:
      "A managed float: Bank of Korea smoothing, dollar-wide moves and local politics shift it for reasons the chip cycle never had.",
    with:
      "{HYNIX} is the Korean memory maker the won travels with; {F17} the yen, the other Asian currency the probe reads; {F8} the Micron close the memory reads compare against.",
  },
  COPPER: {
    tip: "COMEX copper front-month future (HG=F), USD per pound: a value-ladder display-only comparator.",
    why:
      "Copper prices track industrial demand across the cycle, so a falling copper line beside a falling value index says the slowdown is real, not a rotation. The value re-entry probe prints its change over the trailing high window. Printed only; never a criterion.",
    lies:
      "A front-month future: contract rolls, Chinese stockpiling, mine outages and tariff headlines move it without a demand story.",
    with:
      "{CG} is the copper-to-gold ratio built on this same future; {G1} the oil shock read; {XDEV} the value holding the probe gauges entries on.",
  },
  // --- Downside-break detector (channel GLOBAL) ------------------------------
  // Per-leg drawdown-from-3mo-high + MA50-gate detector over the SMH semis proxy
  // {SMH}, hand-set priors (still uncalibrated). NOT in the confirmer slot or trend family;
  // it feeds ONLY its own capped EARLY-WARN floor (`EARLY_WARN_MEMBERS`).
  DB_SMH: {
    tip: "downside break on SMH: drawdown from a recent rolling high, gated by the medium-term moving average.",
    why:
      "A crash announces itself as a fast fall from a recent high while price sits below its medium-term trend line - a shape the slow moving-average reads take weeks longer to flag. This detector reads exactly that on the semis fund, built to fire early on the leg most exposed to a tech break.",
    lies:
      "Any sharp pullback fits its shape, so it is gated: the break raises the early-warning floor only while the relative-strength sibling confirms semis are lagging the market too - though a missing sibling reading fails open, letting the break count alone. Its cuts are uncalibrated priors.",
    with:
      "{RS_SMH} is the gate leg - a break here with relative strength intact reads as a market-wide dip, not a semis story; {F4} is the slow trend read behind it; {DB_XLK} the same detector on the sector actually held.",
  },
  // DB_XLK: the SAME detector on XLK — the direct read on the S&P-500-IT pension sleeve (its weight
  // is quoted from the book, never typed — FE-D1). Same shape + MA50 gate, but its OWN cuts:
  // a whole sector falls shallower than the semis proxy, so the pair stays separately tunable from DB_SMH.
  DB_XLK: {
    tip: "downside break on XLK (S&P 500 IT): drawdown from a recent high, gated by the medium-term moving average.",
    why:
      "The same fast break detector as the semis version, run on the technology sector the book actually holds: a fast fall from a recent high while price sits below its medium-term trend - the crash shape slow moving-average reads take weeks longer to flag. Unlike the board's other tech reads, this one watches the sector itself, not a proxy.",
    lies:
      "Gated by its relative-strength sibling: the pair raises the early-warning floor only together, though a missing sibling reading fails open and the break counts alone. Any sharp sector pullback fits the shape, and its cuts are uncalibrated priors.",
    with:
      "{RS_XLK} is the gate leg - a break with relative strength intact reads as a market-wide dip, not a tech story; {DB_SMH} runs the same detector on the semis proxy; {SP500IT} is the raw series underneath.",
  },
  // RS_SMH/RS_XLK: the DB_* detectors' same-day rel-strength siblings — the
  // X/SPY ratio vs its own MA50; each is the second condition of its pair's ew AND-gate.
  RS_SMH: {
    tip: "relative strength of SMH vs SPY: the price ratio against its own medium-term moving average.",
    why:
      "The semis fund's price ratio to the broad market, read against its own medium-term average. A fall the whole market shares leaves the ratio flat, so it isolates a semis-specific breakdown from a general decline - scored same-day, the confirming half of the semis break pair.",
    lies:
      "Gate leg for the Semis downside break - the pair raises the early-warning floor only together, and a missing reading here fails open, letting the break fire alone.",
    with:
      "{DB_SMH} is the break leg this confirms; {F6} reads the same ratio on a slower trend gauge - both weak is sustained sector rot, this one alone a fresh stumble.",
  },
  RS_XLK: {
    tip: "relative strength of XLK vs SPY: the price ratio against its own medium-term moving average.",
    why:
      "The held tech sector's price ratio to the broad market against its own medium-term average - flat when everything falls together, so a break says the sector itself is being repriced rather than caught in a general decline. Scored same-day; the confirming half of the tech-sector break pair.",
    lies:
      "The confirming half of the S&P IT break pair - alone it raises nothing, and if its reading is missing the gate fails open and the break counts by itself.",
    with:
      "{DB_XLK} is the break leg it gates; {RS_SMH} the same read on the semis proxy; {SP500IT} the raw sector line the ratio's numerator tracks - weak here with {RS_SMH} firm is a sector story stopping above the semis layer.",
  },
  KBE_RS: {
    tip: "relative strength of KBE vs SPY: the bank-equity ratio against its own medium-term moving average.",
    why:
      "Financials are the largest sector of the fundamental-weighted book, yet no other card reads bank equity. KBE is an equal-weight basket of US banks including the money-centre names the book holds - JPM, BAC, WFC, C. Dividing by the market isolates a bank-specific break; in 2023 bank equity fell hard while the credit-spread flag barely moved.",
    lies:
      "A rate-driven bank rally - a steepening curve lifting net-interest margins - pushes the ratio up and reads as calm, even as funding or credit stress builds underneath. Coincident: the ratio must break its own trend before it says anything.",
    with:
      "{F1} is the high-yield credit spread that stayed quiet through the bank stress this card would have caught; {R7} reads the yield-curve steepening that both drives the benign bank rally and precedes the stress.",
  },
  INS_RS: {
    tip: "relative strength of EXH5 vs EXSA: European insurers against the STOXX Europe 600, versus their own medium-term average.",
    why:
      "Insurers are the largest block of the held EU-Fin fund - just under a third of it - and no other card reads them. EXH5 is the STOXX Europe 600 Insurance ETF; dividing by the parent index isolates an insurer-specific break from a general European sell-off.",
    lies:
      "A rate-driven insurer rally - higher yields lifting the sector - pushes the ratio up and reads as calm even as a market or catastrophe loss builds underneath. Coincident: the ratio must break its own trend before it says anything. Cuts are defaulted to KBE_RS's pair, not yet re-eyed.",
    with:
      "{EXSH_GATE} is the held fund's own trend gate - Red here with it Green is an insurer story the basket has not priced; {KBE_RS} is the same leadership question on US banks.",
  },
  EXSH_GATE: {
    tip: "EU-Fin re-entry gate: the held EXSH fund against its MA50 and MA200, and against its STOXX Europe 600 parent.",
    why:
      "The held EU-Fin sleeve's own price, read three ways. Red when the close is below its long-term average (the orange MA200 line) - the trend has broken. Amber when the trend holds but the close is below its medium-term average (the white MA50 line) or the fund lags its parent. Green only when all three hold.",
    lies:
      "All three are pure crosses on dividend-adjusted closes: read which side of each line the close sits, not the distance. A slow dividend basket chops around its lines. The plotted value is the MA200 read only; the MA50 check has the white line, the parent check has none.",
    with:
      "{KBE_RS} is the same leadership question on US banks; {AT1} breaking while this holds is bank stress the equity has not priced.",
  },
  AT1: {
    tip: "relative strength of XAT1 vs EXHA: euro-hedged dollar AT1 CoCo bonds against German government bonds (Bunds), versus their own trend.",
    why:
      "AT1 contingent convertibles are the first-loss layer of bank capital - written down or converted before any depositor or senior creditor takes a hit - so their price is the market's live read on how close the sector is to needing that cushion. Dividing by government bonds cancels the market-wide risk-on/risk-off swing; Credit Suisse 2023 repriced the whole AT1 market.",
    lies:
      "The ratio does not hedge rates - dollar, shorter, callable AT1 bonds against a longer euro government basket - so a rate move leaks in without a credit event. Thin, dealer-driven market: one large issue or call rumour moves it. Coincident: the ratio must break its own trend first.",
    with:
      "{EXSH_GATE} is the held fund's own trend and leadership gate - AT1 breaking with it Green is credit the equity has not priced; {KBE_RS} the same question on US banks; {ECISS} confirms euro-area spread; {BONOS} is the sovereign-bank loop.",
  },
  MU_RS: {
    tip: "relative strength of MU vs SMH: Micron against the semiconductor ETF, versus its own medium-term moving average.",
    why:
      "Micron is the single largest name in the value book after a memory-cycle rally. Dividing by the semis ETF strips out the sector move and leaves what is specific to memory: a Micron-led unwind shows here before the broad semis line looks unusual.",
    lies:
      "One stock against a basket that holds it - earnings days and single-name news swing the ratio without any cycle turn. Coincident: the ratio must break its own trend before it says anything.",
    with:
      "{F8} reads the memory cycle off Micron's own price; {RS_SMH} is the semis ETF against the market - MU breaking with SMH firm is a memory story, both breaking is sector-wide.",
  },
  JPT: {
    tip: "Japan equity trend: the TOPIX ETF (1306.T) above or below its own long-term moving average.",
    why:
      "Japan is the largest non-US market in the value book. The cushion between TOPIX and its own long-term trend erodes before the trend breaks, the same read as the world-index leg but isolated to Tokyo.",
    lies:
      "Priced in yen: a weak yen lifts exporters and flatters the index for a foreign holder. Trend reads are late by nature, and sideways chop whipsaws the cushion.",
    with:
      "{GT} is the same read on the world index - Japan breaking with ACWI firm is a local story, both breaking is global; {FXH} shows whether the yen is being bid as a haven.",
  },
  // --- VIX-bottom track (channel BOTTOM) ------------------------------------
  // Raw VIX term-structure legs (scored in bottom.ts): `thresholds: {}`, no own state — detail chart only.
  // They drive the bottom CALM/BOTTOM-FORMING/CAPITULATION-WATCH state + notification, never the alert ladder.
  VIX: {
    tip: "front-month implied vol (^VIX): the near-term leg of the VIX-bottom term structure.",
    why:
      "The raw front leg of the bottom watch - spot implied volatility, the price of near-term protection. On its own it is the fear level the board already scores elsewhere; here it exists as the numerator of the curve whose inversion - near fear above the longer view - flags possible capitulation.",
    lies:
      "A raw leg, not a signal: fear spikes recur all the way down a decline, not only at its low - the bottom track reads the curve's shape, never this level alone.",
    with:
      "{VIX3M} is the anchor it must overtake for the curve to invert; {VT} is that ratio and {VTP} its persistence - the shape and its staying power, not this level, carry the signal.",
  },
  VIX3M: {
    tip: "3-month implied vol (^VIX3M): the back leg of the VIX-bottom term structure.",
    why:
      "The longer-dated anchor of the bottom watch's term structure - what the options market charges for protection months out. It moves slower than the front leg, so it is the reference the near-term leg must overtake for the curve to invert into the acute-fear shape the track watches for.",
    lies:
      "An anchor, not a signal - it barely moves in most shocks, and a stress that lasts long enough to lift it makes the inversion read shallower even while nothing has calmed.",
    with:
      "{VIX} is the front leg measured against it; {VT} the ratio of the two - a rising anchor with {VT} still inverted means the market now fears the further future too.",
  },
};
