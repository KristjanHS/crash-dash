# LYTR (Amundi Bloomberg Equal-weight Commodity ex-Agriculture) — top indicators research

2026-09-22. Instrument: Amundi Bloomberg Equal-weight Commodity ex-Agriculture UCITS ETF Acc — ISIN
LU1829218749 · WKN LYX0Z2 · ticker LYTR (`LYTR.DE`, EUR-native). Tracks the Bloomberg Energy & Metals
Equal-Weighted Index (BEMEWTR).

## 1. Index holdings (Bloomberg fact sheet)

12 futures, target 1/11 each, reset to target quarterly (last business day of Jan/Apr/Jul/Oct); platinum and
palladium share one slot 75/25.

| Sleeve | Contracts | Weight |
|---|---|---|
| Energy | WTI · Brent · low-sulphur gas oil · natural gas | ~36% |
| Industrial metals | copper · aluminium · nickel · zinc | ~36% |
| Precious metals | gold · silver · platinum (6.82%) · palladium (2.27%) | ~27% |

Energy + industrial metals ≈ 73% ⇒ the fund trades as a **global-growth** asset; no agriculture ⇒ no
food/weather exposure. Gas oil is Brent-priced, so oil effectively drives ~27%.

## 2. Top 5 — already backfilled (verified against `scripts/backfill.ts` job table)

| # | id | series | reach into LYTR |
|---|---|---|---|
| 1 | `G1` + `BRENT` | `DCOILWTICO` / `DCOILBRENTEU` | direct oil ~18%, + gas oil ≈ 27% — the largest single driver |
| 2 | `CG` | HG=F ÷ GC=F | both legs held; reads cyclical (73%) vs haven (27%) split; falling = growth scare. Only industrial-metals read |
| 3 | `F9` | `USDU` | all 12 contracts USD-priced; strong dollar = basket-wide headwind (EUR holder also carries `DEXUSEU`) |
| 4 | `R4` | `DFII10` | 10y real yield — the dominant gold/silver driver (18%) plus PGMs |
| 5 | `F11` | `CNY=X` | China ≈ half of world Cu/Al/Ni/Zn demand; yuan weakness = demand stress on the 36% metals sleeve |

## 3. Next tier (seats 6–8 candidates)

- `OVX` (`^OVX`) — crude implied vol; the violent form of the oil shock, not a direction.
- `T10YIE` — 10y breakeven; mostly *reflects* commodity prices (confirmer, not leader). The overlay design's
  D4 trigger already pairs oil with breakevens.
- `F1` (HY OAS) / `R5` (VIX) — matter in a demand-collapse regime (2008, 2020) when commodities fell with
  equities; weak day-to-day.

## 4. Coverage gaps

- Natural gas (9%) — no indicator. Keyless FRED Henry Hub `DHHNGSP` would fill it.
- Aluminium / nickel / zinc — only indirect via `CG` and `F11`.
- Ranking is exposure-mapping, NOT measured correlation. A `scripts/probe-*.ts` regressing LYTR returns on
  indicator changes would test it.

## Sources

- [Bloomberg Energy & Metals EW fact sheet](https://assets.bbhub.io/professional/sites/10/BEMEWTR-Fact-Sheet-2024_FINAL.pdf)
- [Index methodology](https://data.bloomberglp.com/professional/sites/10/Bloomberg-Energy-and-Metals-EW-Index-Methodology.pdf)
- [justETF — LU1829218749](https://www.justetf.com/en/etf-profile.html?isin=LU1829218749)
- [Amundi ETF product page](https://www.amundietf.co.uk/en/professional/products/commodities/amundi-bloomberg-equalweight-commodity-exagriculture-ucits-etf-acc/lu1829218749)
