# S&P 500 · S&P IT — top-5 indicator retune for market timing (2026-08-29)

**Status:** SUPERSEDED for seat composition and order
(5 → 8 seats). The per-member rationale below
is still live wherever a member survived.
⚠ Three things this doc asserts are now DEAD — see the 09-01 doc, do not act on them here: the
disjointness pin (retired), `HCX` on the S&P 500 row (removed; it is on Semis + S&P IT now), and
`VT` as S&P-IT-only (it took `R5`'s seat on the broad row). The file/symbol names below are also
pre-rename: `leg-top5.js` → `leg-top.js`, `LEG_TOP5` → `LEG_TOP`, `topFiveFor` → `topIndicatorsFor`.

**Originally applied** (`public/leg-top5.js`, `public/leg-desc.js`). Supersedes the shared row that both
legs carried from the S&P 500 Leaders top-5 transcript — that transcript researched ONE target
("S&P 500 Leaders") and the result was seated on both seats verbatim.

## Why the shared row was retired

| Old member | Kept? | Reason |
|---|---|---|
| `F1` HY OAS | S&P 500 only | Daily, canonical credit early-warning — but credit leads badly for tech-led drawdowns (see caveat below). |
| `EBP` excess bond premium | dropped (both) | **Monthly and retro-revised** — the whole history is rewritten each vintage (the reason `CQS` exists as a bridge). Good regime variable, poor *timer*. |
| `GT` ACWI vs MA200 | S&P 500 only | Keeps the one drawdown-*reduction* record on the roster. Global-macro, not tech-specific. |
| `R1` 10y−3m | dropped (both) | Leads by 12–24 months — an **arming** signal, per the source transcript's own wording. It says a bear is possible, not that one is starting. |
| `ECY` excess CAPE yield | **dropped (both), 2nd pass** | Seated in the first pass, evicted the same day — see §Second pass. |

**The caveat that drives the split** (carried over from the superseded transcript, and the reason the
two rows must differ): credit-spread widening leads well when the stress *is* credit-driven (2007–08,
2015–16 energy) and poorly when it isn't — discount-rate shocks (2022) and pure vol/leverage events
(2020, 2024) hit mega-cap tech first and hit credit late or never. So credit stays on the broad row
and comes **off** the IT row.

## S&P 500 (SPY seat, risk 5) — trend · breadth · credit · valuation

`GT · CG · F1 · F13 · VT`

| id | `MEMBER_WEIGHT["S&P 500"]` | Grounds |
|---|---|---|
| `GT` ACWI vs MA200 | 0.6 | 200-DMA rule cut max drawdown 83.4% → 29.6% (1929–2019) — a reduction record, not just a warning record. Confirming; pays for lateness with reliability. |
| `CG` copper/gold | 0.6 | Daily, `lead`, dial-seated in cross-asset. Industrial demand fading against a haven bid — a growth channel none of the other four touch. Replaced `GB` in the third pass; see §Third pass for the evidence limit. |
| `F1` HY OAS | 0.6 | Daily. Sustained >400bp is the conventional first alarm; 10 of 11 post-1950 bear markets were preceded within 24m by inversion, tight real FF, or sharp HY widening. |
| `F13` HYG/LQD | **0.8** | The highest credit cell into this leg *and* daily — replaces EBP's risk-appetite content without EBP's month-stale, revised print. |
| `VT` VIX/VIX3M | 0.6 | Daily, dial-reaching. The row's **only** volatility axis — term-structure inversion is the fastest regime flip available. Coincident: it confirms rather than warns, which is the price paid for the freshness. |

Bench (next in line if a slot frees): `F3` NFCI (0.7, weekly, broadest systemic composite) ·
`price-accel` / `complacency-high` (0.8 each, positioning) · `R5` VIX, `VT` (coincident vol).

## S&P IT (XLK/QDVE seat, risk 2) — real rates · leadership · vol · valuation

`R4 · F5 · CG · VT · price-accel`

| id | `MEMBER_WEIGHT["S&P IT"]` | Grounds |
|---|---|---|
| `R4` 10y TIPS Δ | **1.0** | The biggest gap in the old row. Tech is among the highest-beta sectors to real-rate moves; long-duration cash flows de-rate on the **real** yield, not the term spread. 2022 was this channel alone. |
| `F5` QQQ/QQQE from 12m high | 0.8 | Cap-vs-equal-weight divergence is the tech-INTERNAL breadth gauge; the gap widening and then breaking is the rotation trigger. (`SPCONC` is the SPY analogue but only 0.3 here.) |
| `CG` copper/gold | 0.6 | Daily, `lead`. Takes `F6`'s CONTENT one step closer to its source: semis turn first *because* industrial end-demand turns, and CG reads that demand directly. Third pass; the cost (no tech-specific member left) is stated below. |
| `VT` VIX/VIX3M | **1.0** | Term-structure inversion is the fast regime flip; XLK's realized damage tracks it far tighter than SPY's. |
| `ECY` | **1.0** | The single highest S&P IT cell — the richest leg de-rates hardest. |

Bench: `R2` 10y Δ (1.0 — nominal twin of R4; take it instead if breakeven moves should count) ·
`R5` VIX (1.0) · `NVDA` %vs MA200 (0.6, single-name leadership) · `F4` SMH (0.8).

**Net effect:** the two seats stop being copies. SPY = trend/growth/credit/vol, XLK = real
rates/leadership/growth/vol/speed.

## Second pass — ECY evicted from both rows (2026-08-29, same day)

**Ask:** every top-5 member on these two seats must update **daily** and be useful for *timing*.
`ECY` fails the first test outright — it is `1/CAPE − DFII10` over F7's monthly CAPE points
(`YYYY-MM-01`), GT-gated, and by construction it never triggers; it sets depth. A depth term is not
a timer, and the first pass seated it on both rows anyway.

Replacements were drawn only from **registry-real, daily-printing** ids, so each swap is a one-line
display-only edit — no feed, no scorer, no `MEMBER_WEIGHT` change.

| Seat | Candidates offered | Ruled `[USER]` | Why the other two lost |
|---|---|---|---|
| S&P 500 | `R4` (0.6, ECY's own fast half — the real-yield term isolated) · `complacency-high` (0.8, dist-to-12m-high) · `VT` (0.6, vol) | **`VT`** | `R4`: a de-rating *force*, not a richness level. `complacency-high`: QQQ standing in for SPX on the broad seat, **and** display-only. |
| S&P IT | `complacency-high` (1.0) · `price-accel` (1.0) · `R5` (1.0, VIX level) | **`price-accel`** | `R5`: same input series as the `VT` already in the row — a second read of one variable. `complacency-high`: same content, less directly the "run into the high" the leg de-rates from. |

⚠ **`price-accel` is a SLOW-channel id.** `DIAL_FAMILIES` filters `SLOW_INDICATOR_IDS` out
(`danger-ladder.ts`), so its `MEMBER_WEIGHT` cell of 1.0 **never reaches the danger engine** — the
member charts, is registry-real, and passes `leg-top5.test.js`, but it scores nothing. That is
acceptable on this seam *because the seam is display-only* ("what to watch"), and it is the reason
this row must never be read back as a weight ranking. Anything that makes the top-5 stack
load-bearing has to revisit this line first.

`VT` carries no such asterisk — it is dial-reaching on both seats.

## Third pass — `GB` and `F6` out, `CG` onto both seats (2026-08-29, same day)

**Ask:** the remaining non-leading members go too — replace them with **daily LEADING** reads.
`GB` is `TIMING_CLASS: "lag"` by the repo's own table, and the literature agrees breadth "often lags,
can produce false positives" and is "better used for confirming trend strength rather than calling
tops and bottoms" (StockCharts, Positioned — §Sources). `F6` *was* already `lead`, but a
relative-strength ratio reports the demand turn second-hand.

Candidates were restricted to ids that are daily, `TIMING_CLASS: "lead"`, **and dial-seated** (so the
cell actually scores, unlike `price-accel`):

| Seat | Offered | Ruled `[USER]` | Why the others lost |
|---|---|---|---|
| S&P 500 | `R3` 2y velocity (0.6, adds the absent rates axis) · `CG` (0.6) · `CQS` Baa−Aaa nowcast (0.4) | **`CG`** | `R3`: blind to any drawdown that is not rate-driven. `CQS`: would make the row 3-of-5 credit, on the smallest cell offered. |
| S&P IT | `R3` (0.8, the 2022 channel one leg ahead of R4) · `CG` (0.6) · `CQS` (0.5) | **`CG`** | `R3`: same-channel duplicate of R4's phase pair. `CQS`: reverses this doc's own ruling that credit leads badly for tech-led drawdowns. |

⚠ **The evidence limit on `CG`, recorded because it was ruled *with* this caveat, not despite it.**
The peer-reviewed result validates copper/gold as a short-term leading indicator of the **10-year
Treasury yield** (Zhang et al., §Sources) — *not* of equity drawdowns. A literature pass found no
equity-drawdown backtest. It is seated as a reasoned prior on a display-only seam, exactly the shape
`docs/reference.md` calls an unvalidated starting prior (its registry entry says the same). Do not
cite this row as evidence that CG times equities.

⚠ **Two properties the earlier passes asserted are now DEAD** — do not restore either:
1. The rows share members again (`CG`, `VT`). The second pass's "share no member" line is retired.
2. S&P IT has **no tech-specific member with engine reach**: `F5` is `lag`, `price-accel` is
   display-only, and `CG` is a global growth read. Dropping `F6` spent the chip-cycle lead, knowingly.

## Fourth pass — the two rows must share NO member (2026-08-29, same day)

**Ask `[USER]`:** the two US seats are read TOGETHER as one wider risk board, so every duplicate seat
spends a channel twice. `CG` and `VT` each picked a side, and each freed slot took a channel the other
row does not carry.

| Seat | Row | Change |
|---|---|---|
| S&P 500 | `GT · F1 · F13 · CG · HCX` | keeps `CG` (global growth belongs on the broad seat); `VT` out, **`HCX`** in |
| S&P IT | `R4 · F5 · R6 · VT · price-accel` | keeps `VT` (its 1.0 cell, and XLK's damage tracks term structure tighter); `CG` out, **`R6`** in |

- **`R6` MOVE → S&P IT** (0.8 there vs 0.6 on SPY). Rate *volatility* is the disorderly form of the
  `R4` real-rate shock — the move being violent, not merely large, is what forces a long-duration
  de-rating through in days. Daily, dial-seated, so the cell scores.
- **`HCX` → S&P 500.** The hyperscaler capex basket (GOOGL·META·MSFT·AMZN ÷ SPY, % from 12-mo high)
  reads the concentration the index now depends on. It sits on the BROAD seat, not IT, because only
  MSFT is an S&P IT constituent — the other three are comm-services/consumer-discretionary.
  ⚠ `HCX` is **chart-only** (`CHART_ONLY_INDICATORS`): absent from `ALL_INDICATORS`, no
  `MEMBER_WEIGHT` row, no dial family, and its `HCX_BAND` cuts are still `[OPEN]` priors pending
  calibration. Its colour is provisional;
  seating it here widened `leg-top5.test.js`/`leg-desc.test.js` to `ALL_INDICATORS ∪ CHART_ONLY_IDS`.
- **`F6` SOX/SPX was offered for the IT seat and NOT taken.** So the third pass's ⚠ stands: S&P IT
  still has no tech-specific member with engine reach (`F5` is `lag`, `price-accel` is SLOW-filtered).
- Disjointness was **pinned** here (`leg-top5.test.js`, "S&P 500 and S&P IT share no member") — a
  standing property again, not an observation. The third pass's "the rows share members again" line
  is dead. ⚠ **This pin was itself RETIRED on 2026-09-01** when the rows went to 8 seats: the
  argument was reasoned for 10 combined seats and does not survive 16. The assertion is gone from
  `leg-top.test.js`. Do not restore it off this paragraph.

## Scope

Display-only. This file governs the detail tab's leg stack (`topFiveFor`) and its explainer copy —
it does NOT touch `MEMBER_WEIGHT`, band math, or the notify path. The weights quoted above are read
off `src/danger-ladder.ts` to justify reach; none were edited.

## Sources

- [Every S&P 500 drawdown since 1950](https://eco3min.fr/en/every-sp500-crash-since-1950/)
- [200-day MA backtest](https://www.quantifiedstrategies.com/200-day-moving-average/)
- [XLK rate / AI-capex beta](https://www.kavout.com/market-lens/has-the-technology-sector-spdr-fund-xlk-reached-a-tipping-point)
- [QQQ vs QQQE breadth divergence](https://247wallst.com/investing/2026/05/20/the-ai-capex-cycle-is-crushing-equal-weight-nasdaq-heres-why-qqqs-concentration-bet-is-winning/)
- [SOX as a tech leading indicator](https://articles.stockcharts.com/article/trouble-for-technology-sector/)
- VIX term structure — the index publisher's own product page
- Third pass: [Can market breadth identify S&P 500 turning points?](https://articles.stockcharts.com/article/can-market-breadth-help-identify-s-p-500-turning-points/) · [Breadth divergence](https://positioned.app/traders-glossary/breadth-divergence) — the "breadth confirms, does not time" grounds for evicting `GB`.
- Third pass: Zhang et al., [Copper-to-gold ratio as a leading indicator for the 10-Year Treasury yield](https://www.sciencedirect.com/science/article/abs/pii/S1062940823001390) — what CG's lead IS validated against (yields), and by omission what it is not (equity drawdowns).
- Third pass, bench grounds: [ECB WP 1911, leading-indicator properties of corporate bond spreads](https://www.ecb.europa.eu/pub/pdf/scpwps/ecbwp1911.en.pdf) (`CQS`) · [Rising yields and the 2026 market](https://www.heygotrade.com/en/blog/10-year-treasury-at-4-6-how-rising-yields-are-reshaping-the-2026-stock-market/) (`R3`, the 2022 de-rating template).
- Gilchrist & Zakrajšek, [Credit Spreads and Business Cycle Fluctuations (AER 2012)](https://www.aeaweb.org/articles?id=10.1257%2Faer.102.4.1692) — the EBP grounds the old row leaned on.
