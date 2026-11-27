# Glossary

Plain-English definitions of the financial terms crash-dash uses. The app-specific scoring mechanics
(confirmation buffer, danger dial, alert band) live in the
[README → How the score works](../README.md#-how-the-score-works).

**Credit spread** — the *extra* interest rate companies must pay to borrow, compared to the US
government. When lenders get nervous about the economy, they demand more extra interest, so the spread
**widens**. Credit markets usually get nervous *before* the stock market falls, which is why this is an
early warning. A widening spread = a warning sign.

**HY OAS / IG OAS** — two flavours of that spread:
- **HY** = "High Yield" = riskier companies. Moves first and most. (Indicator **F1**.)
- **IG** = "Investment Grade" = safer companies. Moves later but confirms a real problem. (Indicator **F2**.)
- *OAS* is just the technical name for how the spread is measured. You can ignore the acronym.

**% vs bps** — the data is in **percent**. Finance people say "basis points" (bps): `2.71%` = `271 bps`.
1% = 100 bps. The app shows percent.

**Green / Amber / Red** — each indicator's traffic light, set per-indicator: registry priors ×
`threshold-config.json` multiplier, calibration-overridable (`resolveCuts`). GREEN = below all
thresholds, AMBER = elevated, RED = severe.

**Danger dial / regime** — the live alert engine: the family panel rolls up into a graded dial whose
regime (Calm/Caution/Stress/Crisis) maps 1:1 to the pushed band (OK/WATCH/WARNING/CRITICAL).

**9-leg rotation ladder / held leg** — nine risk rungs from aggressive equities down to cash; the
danger field picks which rung ("held leg") to hold as danger shifts.

**20d Δ (velocity)** — the change over the last 20 trading days. A spread can be *low but rising fast* —
the speed of the move can trip a warning even when the level itself looks fine.

**10y−3m (term spread)** — the 10-year Treasury yield minus the 3-month. Normally positive (long money
costs more). When it goes to zero or **negative** ("inverted"), markets are betting on rate cuts / a
slowdown — historically one of the most reliable recession lead signals. (Indicator **R1**; it's the one
indicator where a *lower* number is worse.)

**10y Δ / 2y Δ / 10y TIPS Δ (yield velocity)** — how fast a Treasury yield is *moving*, not its level. A
sharp 20-day jump in the 10-year (**R2**), 2-year (**R3**), or 10-year real (inflation-adjusted) yield
(**R4**) is a rate-shock signal — the kind of move that re-prices risk assets quickly.

**VIX** — the stock market's "fear gauge": the expected size of S&P 500 swings over the next month. Calm
markets sit in the teens; > 20 is jittery, > 30 is panic. Here it's a *coincident* gauge feeding the
volatility family of the danger dial — it moves the band's position rather than leading it.
(Indicator **R5**.)

**EBP (excess bond premium)** — the part of credit spreads not explained by default risk; a
research-validated leading gauge of investor risk appetite.

**VIX/VIX3M (VT — VIX term-structure backwardation)** — near-term VIX above 3-month VIX; holds partial
band-selection rights in a vol shock (`t1dial.ts`).

**SMH (semis momentum, F4)** — chip stocks (the **SMH** ETF, with **NVDA** as a confirming input) lead the
AI/tech trade, so a sustained breakdown in semis often precedes broader big-tech weakness. F4 flags when
SMH is both below its long-term trend (200-day moving average) and deeply down over ~6 months.

**QQQ/QQQE (breadth, F5)** — compares the normal Nasdaq-100 (**QQQ**, mega-cap-weighted) against its
*equal-weight* twin (**QQQE**). When the ratio pushes to new highs, a handful of giants are carrying the
index while the average stock lags — fragile "narrow" leadership. Feeds the trend family of the danger
dial (amber-only — F5 never reads RED).
