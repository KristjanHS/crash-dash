/**
 * Method-card catalog — static Tier-1 rules-system reference rendered on /lab.
 * Active-5 (simulated): T1, R1, R4, R5, Y1. Concept
 * shelf-5 (NOT wired): Y2, Y3, T8, R8, Y5. Folded-5 (R3/T2/T3/T5/T7) have no card and are excluded.
 * Shelf cards mark `output` "Not wired (concept shelf)" and carry one derived `[SHELF]` `inputs` row.
 */
export const METHOD_CARDS = [
  // ---- Active-6 ---------------------------------------------------------------
  {
    id: "T1",
    group: "active",
    title: "T1 - Danger-regime dial",
    gist: "master risk gauge → rung",
    preset: { credit: "RED" },
    what:
      "The system's master risk gauge. Converts “how dangerous is the market right now?” into a single global danger score 0→1, which sets the target rung on the fixed 9-leg ladder (rung = 1 + round(score × 8)) and the named regime (Calm / Caution / Stress / Crisis). It owns how much risk - composition / which rung. It is not position sizing (that is R5, orthogonal) and not which leg within a rung (that is Y1 / relative strength). The Cash rung is not a normal dial output - it is R4's rare/extreme-only breaker.",
    inputs: [
      {
        signal: "Credit (leading) - spreads widening from trough (track the widening, not just the level)",
        feed: "US HY OAS BAMLH0A0HYM2, IG OAS BAMLC0A0CM (FRED); + EUR IG/HY, EM sovereign (EMBI-style)",
        tag: "[PARTIAL]",
      },
      {
        signal:
          "Volatility / fear (coincident + leading via sustained-low-vol) - implied-vol level + term structure + duration-of-calm (Minsky fragility)",
        feed: "VIX VIXCLS, MOVE ^MOVE (closes provider), VIX-term VIX3M/VIX; + V2X (Euro STOXX 50 vol)",
        tag: "[PARTIAL]",
      },
      {
        signal: "Trend & breadth (coincident) - index vs trend + participation (% above MA)",
        feed: "global: ACWI/World vs 200-DMA + % of legs above MA - reuse the mechanic, not v4's US-tech scope",
        tag: "[GREENFIELD]",
      },
      {
        signal: "Rates & curve (leading) - inversion / rate shock, inverted-polarity (lower/negative = worse)",
        feed: "US 10y-3m T10Y3M + 10y-2y T10Y2Y, 10y/2y velocity DGS10/DGS2 (FRED); + Bund / EUR curve",
        tag: "[PARTIAL]",
      },
      {
        signal: "Flight-to-safety (coincident) - havens bid vs risk; the EUR/USD axis",
        feed: "copper/gold HG=F÷GC=F, gold GC=F (closes provider, live only as GEO/CONTEXT today); + defensive FX (USD/CHF/JPY), EUR/USD, quality-vs-junk",
        tag: "[LIVE-as-GEO]",
      },
      {
        signal: "Global dispersion (coverage) - is stress broad (systemic) or isolated to one region?",
        feed: "cross-region return dispersion / correlation (US vs EU vs EM) - catches EM/Europe stress a US panel misses; no v4 analog",
        tag: "[GREENFIELD]",
      },
    ],
    output:
      "Per-family state: each family reduces its own indicators to one danger state (Calm → elevated; a G/A/R style), reusing v4's 2-close confirmation fold plus enter-high/exit-low hysteresis so a family doesn't flip on one print or chatter on a boundary. Breadth-of-danger aggregation: danger_score ≈ (# families in danger) / (family count) - no fitted weights; more families firing ⇒ higher score ⇒ deeper rung, read as “4 of 6 families firing.” Continuous dial → rung: target_rung = 1 + round(danger_score × 8) across the fixed 9-leg gradient, held with asymmetric hysteresis (de-risk fires easier than re-risk; the dial's own dwell/hysteresis is the only buffering left, since the per-indicator confirmation buffer is now zero and a raw indicator state counts same-day). Regime display: map the continuous dial to 4 named regimes (Calm / Caution / Stress / Crisis) - display layer only.",
    failureMode:
      "#R1 - US-scope blind spot (structural; FATAL if unaddressed): wired only to the live US series, the panel cannot see the risk 4 of 9 legs carry (EM, ex-US developed, global sectors); worse, a flight-to-quality into US Treasuries can move the dial the wrong way (US rates/credit look safer precisely as global equities fall). Correlated families ⇒ breadth double-counts: the reused v4 evidence caps useful channels at 3-5 weakly-correlated ones - T1 runs 6, and in a crisis cross-asset correlations run 0.65→0.95, so “5 of 6” overstates the independent evidence exactly when it matters most. Novel-regime blindness: a panel of known families is blind to a danger that shows in none of them (a liquidity/plumbing freeze with calm spreads) - the valuation family (ECY, a different clock) is the deliberate hedge. Late by construction: coincident families + hysteresis + confirmation buffer mean T1 always moves after the turn - embraced, not a bug; the ladder exists to make being late cheap.",
    framing: "simulated - see panel above",
  },
  {
    id: "R1",
    group: "active",
    title: "R1 - Defensive-sector rotation",
    gist: "walk down to defensives",
    preset: { rates: "RED" },
    what:
      "How a down-move is expressed. T1 sets which rung; R1 owns the path to it - the retreat runs down through the defensive-equity band (rung 7 EU-Fin → 8 Health → 9 Staples), one rung at a time, not a jump to cash. It is not the danger read (T1), not the cash decision (R4's extreme breaker), and not the within-rung leg pick (Y1). R1's distinct residual is the destination - the assertion that the ladder's floor is defensive equity, not cash - and the curation of which lower-beta, income-oriented sectors (European dividend/financials at rung 7, health, staples) populate rungs 7-9.",
    inputs: [
      {
        signal: "the defensive-band legs' price path (to walk them)",
        feed: "9-leg daily adjusted-close, rungs 7-9 - EXSH.DE, QDVG.DE, ZPDS.DE",
        tag: "[GREENFIELD]",
      },
      {
        signal: "the current rung target",
        feed: "T1's target_rung (internal, from the danger dial)",
        tag: "internal",
      },
    ],
    output:
      "As T1's dial deepens, walk down the fixed gradient toward the defensive rungs (7 → 8 → 9), one rung per step, never a jump to the floor. The de-risk destination is equity, not cash - cash is reached only past rung 9, under R4's separate and far higher bar. Hold at T1's target rung with asymmetric hysteresis (down fires easier than up).",
    failureMode:
      "Defensive ≠ uncorrelated in a systemic crash: cross-asset correlations run 0.65 → 0.95 in a crisis; Staples/Health fall too, just less - R1 reduces drawdown, it does not avoid it. Lags on the way up: defensive sectors underperform in recoveries; getting stuck in the band after danger recedes reproduces the return-drag, and climbing back out depends on the re-entry trigger firing. Sector defensiveness is regime-dependent: a rate-driven regime can hit rate-sensitive “defensive” sectors even as equities broadly fall - the gradient's defensive end is a structural prior, not a guarantee. Concentration (#R2): holding ~2 legs at the floor can still be concentrated (Health + Staples both hit by one shock) - needs the correlated-leg cap.",
    framing: "simulated - see panel above",
  },
  {
    id: "R4",
    group: "active",
    title: "R4 - Cash / haven circuit-breaker",
    gist: "extreme-only cash breaker",
    preset: { credit: "RED", volatility: "RED", rates: "RED", trend: "RED" },
    cashBreaker: true,
    what:
      "The one rung that leaves equities entirely - the extreme, rare-only breaker; the system's regime cash. It is not a normal dial output (T1's 1+round(score×8) maxes at rung 9, all-equity); R4 is a separate backstop that fires only in genuine tail conditions, and its hysteresis is inverted relative to every other rung: hardest of all to ENTER, easiest to EXIT. It is also the shape the strategy simplifies toward if the full ladder is judged not to earn its complexity - a minimal danger-dial + this breaker, never passive ACWI.",
    inputs: [
      {
        signal: "extreme, sustained, broad danger (a higher bar than T1's normal dial)",
        feed: "T1 danger_score near max / most families firing (internal); + a tail print on live feeds - HY OAS blowout BAMLH0A0HYM2, vol backwardation VIXCLS/VIX-term (FRED / the closes provider)",
        tag: "[PARTIAL]",
      },
      {
        signal: "time-in-cash (drives the exit ratchet)",
        feed: "internal state - days at the cash rung",
        tag: "internal",
      },
    ],
    output:
      "Enter cash only on extreme, sustained, broad danger - a bar far above any equity rung (near-max danger_score, most families firing, persisting well beyond the band-move buffer). Rare by design. Exit is easy: the moment danger clearly recedes, walk back up; the idle-cash ratchet accelerates re-entry once danger has receded AND time-in-cash exceeds a bound - and never fires while danger is still elevated (no forcing re-entry into a decline). Laddered exit: walk up one rung at a time, never all-in back onto an unconfirmed rebound.",
    failureMode:
      "Idle-cash rot (the confirmed killer): set the enter-bar too low or the exit-bar too high and R4 reproduces the exact PIK pathology it exists to prevent - 20% idle drag, below the ACWI yardstick. Re-entry whipsaw at panic rebounds: cash exits land where momentum crashes (loser up-beta 2.16); because trading is free the ratchet leans early deliberately, since a slightly-late re-entry misses the sharpest recovery days. Never-fires is the success case: with the bar set correctly high, R4 may almost never trigger - fine, since the PIK lock-in already blocks the catastrophe; if the Ch9 review finds the rung-9 equity floor already suffices, the ladder simplifies toward just this breaker (never passive ACWI).",
    framing: "simulated - see panel above",
  },
  {
    id: "R5",
    group: "active",
    title: "R5 - Volatility targeting",
    gist: "size the book by realized vol",
    preset: { volatility: "RED" },
    what:
      "Gross-exposure sizing - scale the whole book's risk by realized volatility, orthogonal in principle to T1 (T1 = which rung / composition; R5 = how much total exposure). Carried as the most tentative active method: the Lab flags that R5 and T1 are both brakes, and D3 chose discrete legs specifically to avoid a continuous weight vector - so R5's own keep-or-shelf decision is open (see failure mode).",
    inputs: [
      {
        signal: "realized volatility of the held book",
        feed: "rolling (~20-60d) realized vol computed from the 9-leg daily closes (data live; the computation is new)",
        tag: "[GREENFIELD]",
      },
      {
        signal: "optional forward vol",
        feed: "implied vol VIXCLS / V2X as a scaler overlay",
        tag: "[PARTIAL]",
      },
    ],
    output:
      "Target a constant portfolio volatility: gross = target_vol / realized_vol, capped at 100% - a PIK cannot lever, so R5 can only ever reduce below fully-invested, never boost above. Vol up → trim gross; vol down → restore toward full. Applied after T1 picks the rung - size the chosen leg, do not change which leg. The un-invested remainder is cash, so R5's floor is tied to R4's idle-cash constraint - its cash cannot be large or persistent.",
    failureMode:
      "Redundant second brake (the shelf risk): R5's vol-cut is correlated with T1's rung-cut; if the Ch9 review finds no marginal drawdown-reduction over T1 alone, shelf R5 (reasoned review, not backtest). Reintroduces the weight vector D3 rejected: discrete legs were chosen to keep the surfaced decision simple; a continuous gross knob makes every day a sizing decision → more override opportunities. Vol-targeting sells into crashes: scaling down as vol spikes = selling near the trough (vol peaks coincide with price bottoms), then missing the vol-crush recovery. The un-invested cash IS idle-cash: every point of gross reduction parks capital in cash - the confirmed PIK killer - and because a PIK cannot lever, R5 is asymmetric (cut-only), a pure drag in calm regimes.",
    framing: "simulated - see panel above",
  },
  {
    id: "Y1",
    group: "active",
    title: "Y1 - Factor tilts",
    gist: "pick the strongest leg in-rung",
    preset: { trend: "RED" },
    what:
      "The what to own cross-section within a rung. Given T1's rung and R1's band, Y1 picks which leg(s) to hold by factor/relative-strength character (value / quality / momentum / low-vol / geography). It is the horizontal within-band pick - the residual of the old “within-band RS pick” now that the ladder ordering is a fixed structural prior. It changes leg selection, not risk level (T1 / R5).",
    inputs: [
      {
        signal: "cross-sectional relative strength across the legs",
        feed: "ensemble-lookback, vol-scaled RS over the 9-leg daily closes (data live; RS metric is new - Design #2)",
        tag: "[GREENFIELD]",
      },
      {
        signal: "factor character (value/quality/momentum/low-vol)",
        feed: "the legs' own factor identity + optional dedicated factor indices (MSCI factor series - likely not keyless)",
        tag: "[PARTIAL]",
      },
    ],
    output:
      "Within T1's target rung/band, tilt toward the leg(s) with confirmed relative strength, scored by an ensemble-lookback, vol-scaled RS metric - never a single lookback. Downward-only reach: the pick may reach one leg below the band floor to hold a much-stronger lower leg, but can never breach T1's ceiling upward - danger's cap on aggression is inviolable to the RS pick. Carry the delete-if-no-edge gate: if the Ch9 review judges the RS pick does not beat “hold the band's default rung,” Y1's rule is deleted. Two-sided hysteresis on the “much-stronger” gate (RS-margin + persistence) so the pick does not chatter.",
    failureMode:
      "Parameter fragility + regime-flip: factor/RS edges are thin and decay; a single lookback overfits - ensemble + vol-scaling mitigates but does not eliminate; Y1 is the method most exposed to “the last regime's winner keeps winning” (US/ex-US 2010-23 → the 2022 flip). Momentum crash at rebounds: tilting toward the recent leader is worst at panic rebounds, when loser legs snap back (up-beta 2.16) - Y1 is on the wrong side exactly when the ladder re-risks. May have no marginal edge: if the Ch9 review judges the fixed gradient's default rung beats the RS pick net of whipsaw, Y1 is pure complexity → deleted; its existence is conditional on surviving that review. Concentration (#R2): “pick the strongest leg” can concentrate into ~1-2 correlated legs (Semis + IT before a tech selloff); needs the correlated-leg cap.",
    framing: "simulated - see panel above",
  },

  // ---- Concept shelf-5 --------------------------------------------------------
  {
    id: "Y2",
    group: "shelf",
    title: "Y2 - Sector / thematic leadership",
    gist: "chase the leading theme",
    preset: { trend: "RED" },
    what:
      "Rotate into the leading sector or theme (semis, energy, AI, biotech…) on relative strength - a finer-grained cousin of Y1, picking at the sector/theme level rather than the whole-leg level. It is the “catch the biggest single winner” method.",
    inputs: [
      {
        signal: "sector / theme relative strength (momentum, one level down)",
        feed: "sector & thematic ETF closes - overlaps Y1's within-rung RS pick at a level the 9-leg universe already spans",
        tag: "[SHELF]",
      },
    ],
    output:
      "Not wired (concept shelf). Would-be action: rotate into the leading sector or theme on relative strength - Y1's RS pick one level finer, concentrating leadership into a single thematic vehicle.",
    failureMode:
      "Redundant with Y1 (the shelf reason): the 9-leg universe already carries the main sector/factor axes (Semis, S&P-IT, Value, Health, Staples), and Y1's within-rung RS pick already captures leg-level leadership - a sector/theme layer just double-counts the same momentum read. Concentration (#R2), amplified: “own the hottest theme” collapses the book into one or two highly correlated bets - the tech-led-selloff blind spot in its purest form. Thematic ETFs sell the top to retail: new theme funds gather flows after the run (clean energy 2021, cannabis 2019) - a documented buy-high/sell-low vehicle. Whipsaw × notify-only: finer granularity ⇒ more frequent leadership flips ⇒ more pings to override, each an occasion for the self-kill.",
    framing:
      "Shelved because: it overlaps the ladder's own relative-strength pick (Y1) at a level the 9-leg universe already spans, and it concentrates the book exactly where #R2 warns.",
  },
  {
    id: "Y3",
    group: "shelf",
    title: "Y3 - Carry",
    gist: "get paid to wait (thin)",
    preset: {},
    what:
      "Harvest carry - the return earned just for holding while nothing moves (dividend yield on equities, roll yield on futures, rate differential on FX). Its equity expression is a tilt toward the higher-yielding legs.",
    inputs: [
      {
        signal: "carry / static yield known in advance (the most forecastable return component)",
        feed: "equity dividend yield (the executable slice); the strong forms need FX/futures roll-yield instruments a PIK cannot hold",
        tag: "[SHELF]",
      },
    ],
    output:
      "Not wired (concept shelf). Would-be action: tilt toward the higher-yielding legs (EU-Fin, leg 7 - a European dividend screen) to harvest carry - “get paid to wait,” no forecast required.",
    failureMode:
      "Thin for equity ETFs (the shelf reason): the powerful carry premia live in FX and futures roll yield, not in long-only equity funds; an equity dividend-yield tilt is a weak, largely-redundant income slice that overlaps the value factor and the EU-Fin dividend-screen leg the universe already offers. Carry is short volatility - “pennies in front of a steamroller”: high-carry books crash together in risk-off, correlated with exactly the crises the danger dial exists to catch (2008 FX carry, 2020); its return is negatively skewed. High yield is often a distress signal: a leg is high-yield partly because its price fell on impaired fundamentals - the value-trap failure. Not PIK-expressible in its strong form (D6): the futures/FX roll-carry engines need instruments the PIK can't hold; only the weak, redundant equity-dividend slice is executable.",
    framing:
      "Shelved because: the real carry premium is thin-to-absent in long-only equity ETFs - the strong versions need instruments a PIK cannot hold.",
  },
  {
    id: "T8",
    group: "shelf",
    title: "T8 - Mean-reversion",
    gist: "buy the loser, fade the winner",
    preset: { trend: "RED" },
    what:
      "The short-horizon contrarian method - buy the recent loser / fade the recent winner, betting that near-term overextensions snap back. The direct inverse of the trend methods (T1's trend family, Y1).",
    inputs: [
      {
        signal: "short-horizon cross-sectional reversal (1-week-to-1-month; oversold names bounce)",
        feed: "a single-stock, cross-sectional effect that weakens sharply at the diversified-ETF level (E4) - broad indices trend more than they revert at rotation horizons",
        tag: "[SHELF]",
      },
    ],
    output:
      "Not wired (concept shelf). Would-be action: buy the recent loser / fade the recent winner on short-horizon reversal - “buy fear, sell greed.”",
    failureMode:
      "Weak/absent for broad indices (E4, the shelf reason): short-term reversal is a single-stock, cross-sectional effect that weakens sharply at the diversified-ETF level - the ladder holds broad ETFs, so the signal T8 needs mostly isn't there. Head-on conflict with the trend methods: T1's trend family and Y1 ride momentum; T8 fades exactly what they buy - run together they fight, cancel toward noise, and double the whipsaw/override count. Catches the falling knife in a real regime break: “buy the loser” is ruinous when the loser is falling for a justified structural reason (2008, a secular derating) - mean-reversion assumes a stable mean. Sells winners early: the other half trims the leg that is compounding, capping the upside the positive-skew posture depends on.",
    framing:
      "Shelved because: it fights the trend methods head-on and the effect it needs largely vanishes at the broad-index level (E4).",
  },
  {
    id: "R8",
    group: "shelf",
    title: "R8 - Tail hedging",
    gist: "pay for crash insurance",
    preset: { volatility: "RED", credit: "RED" },
    what:
      "Explicitly pay for crash insurance - hold long-volatility / long-put exposure (or a standing small OTM-put sleeve) that bleeds a little in calm and pays off convex in a crash. The one method that buys protection instead of rotating away from risk.",
    inputs: [
      {
        signal: "convex long-vol / long-put payoff (cut the left tail without timing the exit)",
        feed: "options / long-vol instruments - structurally unavailable in a PIK (D6); the danger dial is its PIK-native substitute",
        tag: "[SHELF]",
      },
    ],
    output:
      "Not wired (concept shelf). Would-be action: carry a standing small long-vol / long-put sleeve as convex crash insurance - a permanent structural choice, not a signal.",
    failureMode:
      "Not PIK-executable (the shelf reason - decisive): the wrapper cannot hold options or long/short-vol instruments (D6) - a structural shelf, not a judgement call. Negative carry bleeds relentlessly: long-vol/long-put decays every calm day (theta / roll cost); over a multi-year calm the “small known cost” compounds into a large drag - most naive tail programs lose to simply holding less equity. Monetization is its own hard timing problem: a hedge only helps if you sell it near the bottom and redeploy; get that wrong and you pay the premium then hand back the payoff. The active methods already cover its job: rotating down the ladder / into cash (R4) is this book's synthetic tail hedge - same drawdown-cut with instruments the PIK can hold - so R8 is redundant even before the D6 constraint bites.",
    framing:
      "Shelved because: a PIK cannot hold options or vol instruments (D6) - the core mechanism is structurally unavailable, and the danger dial is its PIK-native substitute.",
  },
  {
    id: "Y5",
    group: "shelf",
    title: "Y5 - Concentration / leverage",
    gist: "amplify the best bet (ruin risk)",
    preset: { trend: "RED" },
    what:
      "The maximize-return extreme - concentrate into the highest-conviction bet and/or apply leverage to amplify it. The pure-offense pole, the opposite of R4's cash breaker.",
    inputs: [
      {
        signal: "not a signal - a sizing posture (amplifies whatever the other methods decide)",
        feed: "levered instruments un-PIK-able (D6); the concentrated half is the #R2 correlated-bet blind spot the diversified rungs exist to prevent",
        tag: "[SHELF]",
      },
    ],
    output:
      "Not wired (concept shelf). Would-be action: concentrate into the highest-conviction bet and/or apply leverage to amplify it - the aggressive-Kelly / pure-offense pole.",
    failureMode:
      "Ruin risk (the shelf reason - decisive, non-negotiable): leverage + concentration create an absorbing barrier - a deep enough drawdown is unrecoverable (−50% needs +100% back), and leverage can force liquidation at the bottom; a long-horizon portfolio book cannot survive ruin. It inverts the mission: the promised job is drawdown reduction; Y5 amplifies drawdown - the negation of the objective. Volatility drag / path-dependence: even with a positive edge, leverage's variance drag pushes the median outcome far below the mean - most paths do worse and a few blow up. The levered half is un-PIK-able (D6); the concentrated half is the #R2 blind spot. Behavioural ruin: a concentrated, levered book maximizes the emotional swings that drive the override-and-panic self-kill.",
    framing:
      "Shelved because: ruin risk - it introduces an absorbing barrier and directly inverts the strategy's drawdown-reduction mission. Its levered form is also un-PIK-able (D6).",
  },
];
