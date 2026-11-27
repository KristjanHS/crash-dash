# XDEV (Xtrackers MSCI World Value) — top 10 risk indicators research

2026-09-29. Instrument: Xtrackers MSCI World Value UCITS ETF 1C — ISIN IE00BL25JM42 · WKN A1103E · ticker XDEV
(held via `XDEV.DE`, the Value leg). Scope: rank only indicators **already backfilled** in the registry, by
impact on the fund's risk (reach × drawdown channel) — not by timing.

## 1. Holdings (as pasted 2026-09-29)

400 names; top 10 = 28.67%. Index = **MSCI World Enhanced Value** (sector-neutral to the parent).

| | |
|---|---|
| Top 10 | Micron 13.72 · Cisco 2.96 · Verizon 2.21 · AT&T 1.72 · Toyota 1.70 · Comcast 1.49 · Qualcomm 1.34 · HPE 1.29 · Pfizer 1.12 · GM 1.12 |
| Countries | US 46.02 · Japan 20.05 · UK 8.35 · France 5.63 · Germany 4.43 · Spain 1.92 · Italy 1.66 · Netherlands 1.52 · Canada 1.48 · Ireland 1.41 · Hong Kong 1.33 · other 6.20 |
| Sectors | Technology 30.55 · Finance 18.84 · Cons. cyclicals 8.05 · Industrials 7.80 · Healthcare 7.74 · Telecom 7.71 · Cons. non-cyclicals 7.13 · Non-energy materials 4.80 · Energy 3.84 · Utilities 2.42 · other 1.12 |

Read: sector neutrality forces a ~31% tech sleeve, but the value screen removes Nvidia/Apple/Microsoft, so the
sleeve is filled by the remaining cheap names — Micron. Its weight went ~3.4% (Oct 2025) → 4.7% (Dec 2025) →
6.1% (Feb 2026) → 13.7% (now) on an ~800% one-year rally. The same mechanics put Micron at ~23–25% of VLUE
(MSCI USA Enhanced Value). The fund is a memory-cycle bet wrapped in a value label.

## 2. Top 10 — ranked by impact (reach × drawdown channel)

| # | id | reach | channel |
|---|---|---|---|
| 1 | `F8` MU 6-mo return | 13.7% single name | largest single risk; a memory-cycle turn outweighs any macro factor |
| 2 | `HCX` hyperscaler capex basket | MU's demand | AI-server HBM demand drives the MU rally; a capex slowdown shows here before MU earnings |
| 3 | `RS_SMH` SMH/SPY vs MA50 | ~17%+ semis (MU, QCOM …) | semis leadership vs the market — the relative read, not the level |
| 4 | `DB_SMH` SMH downside break | same | fast semis trend-break detector |
| 5 | `F17` USD/JPY | Japan 20% (Toyota, JP banks) | sharp yen rally = carry unwind + exporter margin hit (Aug-2024 shape) |
| 6 | `KBE_RS` KBE/SPY vs MA50 | Finance 18.8% | 2nd-largest sector; US-bank half (`EXSH_RS` partial for EU fins) |
| 7 | `R7` bull steepener (`R1` curve level) | banks' NIM + value/growth rate beta | a front end falling on weakness is the classic cyclical-value recession tell |
| 8 | `F1` HY OAS (`F13` HYG/LQD) | levered value names — VZ, T, CMCSA, GM, HPE | value tilts to leveraged balance sheets → higher credit beta than growth |
| 9 | `CG` copper/gold | cyclicals/industrials/materials/energy ~25% | global-growth expectations; value underperforms when it falls |
| 10 | `GT` / `GB` ACWI trend, global breadth | whole portfolio | broad global-equity beta backstop |

Bench: `DISP` (MU-driven concentration), `F16` / `ECISS` (Europe ~27%), `FDX` (memory supply-chain), `VT`.

## 3. Gaps — no backfilled indicator covers

| gap | reach | cheapest candidate |
|---|---|---|
| Japanese equity trend (TOPIX / Nikkei) | Japan 20% | TOPIX via `1306.T`, or `^N225` (Nikkei is price-weighted and tech-heavy — less like the value holdings) |
| Memory-specific cycle | MU 13.7% | `MU/SMH` ratio — isolates the memory cycle from the semis tide (no free daily DRAM/NAND spot feed) |
| Telecoms | 7.7% | none needed — low beta, covered by `F1` and `R2` |

## Sources

- [Morningstar — How Micron Became 25% of a Value ETF](https://www.morningstar.com/funds/how-micron-became-25-value-etf)
- [Benzinga — Why a Value ETF Holds 23% in MU](https://www.benzinga.com/markets/tech/26/09/61951487/micron-value-stock-vlue-etf-23-percent-weight)
- [MSCI World Value Index factsheet](https://www.msci.com/documents/10199/255599/msci-world-value-index.pdf)
- [stockanalysis — LON:XDEV holdings](https://stockanalysis.com/quote/lon/XDEV/holdings/) · [ETR:XDEV holdings](https://stockanalysis.com/quote/etr/XDEV/holdings/)
- [DWS — XDEV product page](https://etf.dws.com/en-gb/IE00BL25JM42-msci-world-value-ucits-etf-1c/) · [justETF — XDEV](https://www.justetf.com/en/etf-profile.html?isin=IE00BL25JM42)
