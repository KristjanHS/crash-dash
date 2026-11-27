// Per-leg "top indicators" seam for the detail tab's leg stack.
//
// Hand-researched rows below always win; every other leg auto-ranks from the served
// `memberWeight` (`/api/danger-model`, the danger engine's own MEMBER_WEIGHT table) — same seam
// and same two binding rules as leg-impact.js: derive from the served row, never hand-type a
// mirror; a zero weight means "does not reach that leg", so drop it.
//
// DOM-free + `.js` so vitest collects it and tsc ignores it (frontend.md). `doc` (optional) names the
// row's research file under `docs/` (leg-top.test.js asserts it exists); a row whose research doc was
// retired carries none — its grounds are the comments above it. Keys are `LEG_FIELD[].sleeve`
// (src/danger-ladder.ts); id typos are caught by leg-top.test.js against the registry.

/** Seats per hand row. The SINGLE source — the auto path slices to it, the test lints row length
 *  against it, and the UI copy reads it. Was 5 until 2026-09-01, 8 until 2026-09-24. */
export const TOP_N = 10;

// ── 2026-09-01 `[USER]`: 5 → 8 seats on every row ────────────────────────────────────────────
// Three standing rulings from that pass, because they bind the next edit:
//
//   1. ORDER IS THE CLAIM. Each row sorts all 10 seats by crash/bear-market IMPACT on the held fund
//      (holdings reach × drawdown channel; the `MEMBER_WEIGHT` cell is the engine's own magnitude
//      read), largest first — `EU-Fin` 2026-09-25, `Value` 2026-09-29, `S&P IT` · `S&P 500`
//      2026-09-30 (all `[USER]`).
//      EXCEPTION (`Semis`, `[USER]` 2026-10-24): bear prognosis and re-entry readiness share the order.
//      EXCEPTION (the timing-era rows, `[USER]` 2026-09-30 D2): `EM` `ex-US` `Health` `Staples` keep
//      the 2026-09-01 ordering rule — seats 1–8 by market-timing potential FOR THAT LEG, best first, seats 9–10
//      appended per the 2026-09-24 fill (weight, or the row's ruling/bench).
//   2. EVERY ROW CARRIES A TWO-DIRECTIONAL SEAT. A member whose reversal is a RE-ENTRY trigger,
//      not only whose deterioration is an exit — `VT` (ratio back under 1.0), `GT` (MA200
//      re-cross), `CG` (turn off an extreme low), `R7` (bull steepener), `F13` (appetite
//      recovering), `R3` (2y falling = the dollar/discount-rate headwind turning). Never leave a
//      row with exits only. (`F6` carried this rule until the 2026-09-01 second pass evicted it.)
//   3. DAILY BEATS ENGINE REACH. Cadence is the first filter: a weekly/monthly print is not a
//      timer whatever its `MEMBER_WEIGHT` cell says (this evicted `F3` weekly and `EBP` monthly).
//      Display-only members are FINE here — the seam is display-only, so a chart-only id
//      (`HCX`) or a SLOW-channel id (`price-accel`, `complacency-high`) that scores nothing is
//      judged on its impact or timing value alone. The corollary is unchanged and absolute: never read a
//      row back as a weight ranking.
//
// ── 2026-09-01 SECOND PASS `[USER]`: five seats re-cut on a leadership check ─────────────────
// Out on a visual check that they never lead their leg's fall: `F6` (Semis, IT), `F5` (Semis),
// `price-accel` (IT), `SPCONC` (500) — plus `complacency-high` (500), same display-only
// price-momentum family as price-accel. Replacements had to be DAILY and `lead`-class.
// ⚠ Do NOT re-offer `F2` (IG OAS) for these three rows without a measured result: it is `coin`,
// Semis and S&P 500 already seat `F1`, and S&P IT's `F1` bar binds IG harder than HY.
// ⚠ `TIMING_CLASS["price-accel"]` stays `lead` — `[USER]` ruled this pass display-only; that
// table is on the notify path (`TIMING_CLASS.F6` went `coin` 2026-09-02 E4, its own ruling).
//
// ⚠ The S&P 500 ↔ S&P IT DISJOINTNESS PIN IS RETIRED (`[USER]` 2026-09-01, superseding the
// 4th pass of 2026-08-29). "One wider risk board, so no duplicate seats" was reasoned for 10
// combined seats; at 16 it forces both rows into members neither wants. The test no longer
// asserts it — do not restore that assertion without a fresh ruling.
// The retirement was then spent DELIBERATELY and NARROWLY (`[USER]` 2026-09-01, same pass): the
// two rows shared `VT` and `GT` only, and kept 6 distinct seats each.
// ⚠ THAT NET IS STALE as of the 2026-09-01 SECOND PASS and is recorded here as history, not as a
// live constraint: the two rows now share SIX members (`VT` `GT` `F13` `R3` `R2` `HCX` — the
// last since D1, 2026-09-30) and keep 4 distinct seats each. That is a direct consequence of
// filtering both rows to daily lead-class members — the qualifying pool is small, so they converge. The pin is retired and nothing
// asserts the overlap; if the convergence is judged too far, it is a fresh ruling, not a
// regression. Three members were considered
// for cross-seating and REJECTED with their reasons intact — re-offering them needs new evidence,
// not just the absent pin: `CG` stays broad-only (global growth belongs on the broad seat, the
// 4th pass's own reasoning); `R4` stays IT-only (the 2nd pass ruled it "a de-rating force, not a
// richness level" for the broad seat); `F1` stays off IT (this doc's standing caveat — credit
// leads badly for tech-led drawdowns: 2022, 2020, 2024 hit tech first and credit late or never).
export const LEG_TOP = {
  // Semis — bear + re-entry order (`[USER]` 2026-10-24; `R1` `R3` `R7` `F9` out): per-seat grounds → the
  // `doc` stem; `VXSMH` replaced `F17` at 9 (`[USER]` 2026-10-25). Two-directional seats: `MU_RS` `VT` `F8` `CG`.
  // `F17` back at 10 (`[USER]` 2026-11-21) when the memory-spot seat left the roster.
  // ⚠ `F6` and `F5` were EVICTED by the 09-01 second pass (see the leadership block above): F6 on
  // the visual check, F5 on its own `lag` class.
  Semis:     {
                                    ids: ["HCX", "R4", "MU_RS", "VT", "F1", "F8", "R6", "VXSMH", "CG", "F17"] },
  // S&P IT — IMPACT order (`[USER]` 2026-09-30, seats unchanged from 09-01): `R4` first — the direct
  // multiple-compression channel (XLK −28% in 2022 was a real-rate event); `HCX` — NVDA + AVGO + MSFT
  // earnings rest on hyperscaler capex, the fund's largest single exposure; `R2` the level form of the
  // same de-rating (wedge vs R4); `R3` where the discount-rate shock starts and the re-risk trigger;
  // `R6` the disorderly form that forces it through in days; `VT` vol regime flip, re-entry on
  // contango; `GT` the roster's only drawdown-REDUCTION record, MA200 re-cross = re-entry; `R1` the
  // slow recession clock (2001); `R5` VIX level, a symptom and VT's own input; `F13` last — the one
  // credit read this row admits, because the standing `F1` bar is about a spread LEVEL that slept
  // through 2022, not a daily appetite RATIO. ⚠ That level-vs-ratio distinction was ruled for EU-Fin,
  // not for this bar — it is an extension, and a measured pass could still take F13 back off this row.
  // Two-directional seats: `VT` `GT` `R3`.
  "S&P IT":  { doc: "2026-08-29-sp500-and-sp-it-top5-timing-research.md",
                                    ids: ["R4", "HCX", "R2", "R3", "R6", "VT", "GT", "R1", "R5", "F13"] },
  // S&P 500 — IMPACT order (`[USER]` 2026-09-30): `F13` first — daily risk-appetite withdrawal, the
  // row's highest cell (D3: above `F1`, cell order kept); `HCX` — the top-5 names are ~30% of the
  // index and all rest on hyperscaler capex, so an impact row reads concentration second; `F1`
  // credit-driven stress owns the deepest S&P bears (2007–09 −57%, 2000–02); `R7` the front end
  // pricing a slowdown — the recession channel behind every >30% bear; `R2` 10y speed (2022 was a
  // broad de-rating on nothing else); `R3` the earliest rates form of the same shock; `CG` global
  // growth for the cyclical ~third, turn off a low = re-entry; `GT` the drawdown-REDUCTION record,
  // MA200 re-cross = re-entry; `DISP` the repo's own bench pick — the only member that reads the
  // US/Europe/EM co-movement the index's assumed diversification rests on; `VT` last — a symptom
  // of the fall, kept as the fast two-directional seat. Two-directional: `VT` `GT` `CG` `R7` `F13`.
  // ⚠ `HCX` seated at 2 by D1 (`[USER]` 2026-09-30), EVICTING `R5` (the same VIX input `VT` reads,
  // as a level). This REVERSES the 2026-09-01 "do not re-seat" line, which was ruled for a TIMING
  // row — the same reversal Value made for `CG` on 09-29. `R1` stays benched: 12-24mo = arming.
  // `R4` remains barred from the broad seat by the 2nd pass ("a de-rating force, not a richness
  // level"). The 09-01 second pass's `SPCONC` + `complacency-high` evictions stand — the row still
  // has no positioning read, a deliberate cost.
  "S&P 500": { doc: "2026-08-29-sp500-and-sp-it-top5-timing-research.md",
                                    ids: ["F13", "HCX", "F1", "R7", "R2", "R3", "CG", "GT", "DISP", "VT"] },
  // Value — IMPACT order (`[USER]` 2026-09-29): Micron ~14% + semis sleeve first, then Japan 20% (F17), Finance
  // (KBE_RS), curve, credit, cyclicals (CG), global trend. `R1` stays benched — `R7` carries the curve slot.
  Value:     {
                                    ids: ["F8", "HCX", "RS_SMH", "DB_SMH", "F17", "KBE_RS", "R7", "F1", "CG", "GT"] },
  // EM — R3 is the Fed front-end that drives the dollar cycle, so it is EM's actual re-risk
  // trigger; OVX is a 1.0 cell and the energy-shock channel the row missed entirely; R7 also 1.0.
  EM:        {
                                    ids: ["F10", "R3", "F9", "CG", "F11", "OVX", "R7", "R1", "R2", "R4"] },
  // ex-US — EURC first: the euro curve is the region's policy read; BRENT because Europe
  // and Japan are the energy importers; GT for the trend re-cross.
  // `FXH` at 10 (2026-11-21) when the euro high-yield seat left the roster.
  "ex-US":   {
                                    ids: ["EURC", "F9", "CG", "F17", "BRENT", "GT", "BUND", "OVX", "FXH",
                                          "F13"] }, // provisional: F13 = highest unseated ex-US MEMBER_WEIGHT cell
  // EU-Fin — the row was 100% euro-native with no global transmission and no re-entry timer: VT
  // supplies both, F13 the daily risk-appetite read. ⚠ THIS ROW DEPARTS FROM RULING 1: its seats are
  // ordered by CRASH/BEAR-MARKET IMPACT on the fund, not by timing potential — bank sub-debt first.
  // ⚠ `EU2` was offered for a seat and REJECTED: its own docblock records multi-day CISS dataflow
  // stalls (not a timer). Do not re-offer it.
  // `[USER]` 2026-09-29: `BONOS` OUT, `BUND` IN on the Δ20-velocity rescore; BONOS keeps its card, EU-Fin
  // cell 0.
  // `[USER]` 2026-10-08 holdings re-cut:
  // `INS_RS` (STOXX 600 Insurance rel-strength) IN, `EXSH_GATE` card-only (keeps its engine cell).
  // `EURGBP` (the ~28% GBP translation channel) last.
  "EU-Fin":  {
                                    ids: ["AT1", "INS_RS", "F13", "BUND", "VT", "EURGBP",
                                          "F1", "R4", "F3", "R6"] }, // provisional: highest unseated EU-Fin MEMBER_WEIGHT cells that seed EUFIN_BACKFILL_YEARS (EXSH_GATE skipped: card-only ruling above; 0.4 ties in key order)
  // Health — R4 is the REAL-yield velocity, which is the actual bond-proxy discount channel (R2
  // is nominal); GT for trend, and the row's two-directional seat (MA200 re-cross = re-entry).
  // `[USER]` 2026-09-22 (QDVG sector-risk pass): `R1`, `R7` and `CQS` OUT; `R5` (the defensive-
  // rotation trigger — HC falls less than SPY, not zero), `F1` (spread widening is the rotation
  // INTO defensives) and `F9` (USD translation of big pharma's ex-US revenue; the fund is 97.5% US,
  // unhedged for a EUR holder) IN. `EBP` stays off (monthly AND retro-revised — a poor timer).
  Health:    {
                                    ids: ["R2", "R4", "R6", "F2", "R5", "F1", "GT", "F9", "R3", "F13"] },
  // Staples — OVX is the violent form of the margin shock G1 measures slowly; R1 is the recession
  // lead (the reason to HOLD staples); GT is the leave-staples signal.
  Staples:   { doc: "2026-10-01-staples-bear-triggers-research.md",
                                    ids: ["R2", "R6", "G1", "OVX", "F9", "F2", "R1", "GT", "F1", "R3"] },
  // LYTR (off-ladder, display-only): 8 seats ordered by timing potential, all daily.
  // `[USER]` 2026-09-22 — F1 over G1 (seat 8), NG seated, T10YIE evicted (confirmer, not leader).
  Commodities: { doc: "2026-09-22-lytr-commodity-top-indicators-research.md",
                                    ids: ["BRENT", "NG", "CG", "F9", "OVX", "R4", "F11", "F1", "G1", "T10YIE"] },
  // AW Fundam (off-ladder, display-only): RAFI All-World 3000, 8 seats by timing potential (research §2).
  // `[USER]` 2026-09-22 — KBE_RS takes BRENT's seat 5 (BRENT → bench); GT the two-directional re-entry.
  "AW Fundam": {
                                    ids: ["F1", "R7", "CG", "F9", "KBE_RS", "F10", "VT", "GT", "BRENT", "F17"] },
};

// Legs that are NOT ladder sleeves: display-only detail-tab stacks (no MEMBER_WEIGHT, no notify).
// The single source — the picker appends these, tests union them with LEG_FIELD.
export const OFF_LADDER_LEGS = ["Commodities", "AW Fundam"];

// Display names for the off-ladder legs: short leg name + held ticker, the same "leg TICKER" shape
// `sleeveLabel` gives the ladder sleeves (sleeve-label.js is LADDER-only by its parity test).
export const OFF_LADDER_LABEL = Object.freeze({ Commodities: "Commodities LYTR", "AW Fundam": "AW Fundam PSWD" });

// The leg the detail tab lands on by default — a `LEG_FIELD[].sleeve` that is also a LEG_TOP key,
// so the landing view is always a hand-researched stack (pinned in leg-top.test.js).
export const DEFAULT_LEG = "S&P 500";

/**
 * The `TOP_N` indicators that most affect one leg's risk.
 *
 * @param {string} legKey  a `LEG_FIELD[].sleeve` name (unknown ⇒ auto path).
 * @param {Record<string, Record<string, number>>|null|undefined} memberWeight
 *   `memberWeight` off /api/danger-model — member id → { sleeve → magnitude }. Rows are partial
 *   (a member can omit sleeves it does not reach). Cold/failed fetch ⇒ `{ ids: [], source: "auto" }`.
 * @returns {{ ids: string[], source: "config" | "auto" }}
 *   `config`: the hand row, verbatim — already ordered per rule 1 (crash impact; the four timing-era
 *   rows by timing potential), NOT by weight.
 *   `auto`: members ranked by `row[legKey]` descending, zero (and absent) weights dropped, first
 *   `TOP_N`. Ties break on the served key order — the server literal's ladder order, which JSON
 *   preserves — via the stable sort, so the result is deterministic.
 */
export function topIndicatorsFor(legKey, memberWeight) {
  const cfg = LEG_TOP[legKey];
  if (cfg) return { ids: [...cfg.ids], source: "config" };
  if (!memberWeight) return { ids: [], source: "auto" };
  const ids = Object.entries(memberWeight)
    .map(([id, row]) => [id, row?.[legKey]])
    .filter(([, w]) => typeof w === "number" && w > 0)
    .sort((a, b) => b[1] - a[1]) // Array#sort is stable ⇒ ties keep served order
    .slice(0, TOP_N)
    .map(([id]) => id);
  return { ids, source: "auto" };
}
