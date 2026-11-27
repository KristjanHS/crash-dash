/**
 * The family TABLE — a dependency-free leaf (CORE-9 Stage D).
 *
 * The 7 danger families, their member rosters and the confirmation-tier lookup, split out of
 * `families.ts` so `confirmClosesFor` can be imported without dragging the panel/view layer (and
 * its `domain-types.js`/`ladder.js`/`registry.js`-adjacent graph) along. Consumers may keep importing
 * every symbol here from `families.ts`, which re-exports all 8.
 *
 * ⚠ This file has ZERO value imports, by design — that is the whole point of the split. A value
 * import added here re-creates the edge CORE-9 cut. Type-only imports are acceptable (erased).
 */

/**
 * The fixed family keys as a literal union — so any per-family `Record<FamilyKey, …>`
 * map gets missing-key / typo checking at compile time. Widening this back to `string`
 * would silently swallow a key typo.
 */
export type FamilyKey =
  | "credit"
  | "rates"
  | "valuation"
  | "volatility"
  | "cross-asset"
  | "trend"
  | "geopolitics";

/** A danger family + its member indicator ids (registry ids). */
export interface FamilyDef {
  key: FamilyKey;
  label: string;
  ids: string[];
  /** on-screen caveat: a provisional-proxy note, or the stub's "awaiting feed". */
  note?: string;
  /** one-line "what this family is" for the per-tile ⓘ help bar. */
  desc?: string;
  /**
   * Sanctioned-stub reason: WHY this family has no members yet, rendered in place of the
   * generic "no live feed" empty state (`tileEmptyCopy`, public/tile-members.js). Set ONLY
   * on a family whose `ids` are deliberately empty and awaiting a feed that does not exist
   * keylessly — never on a live family, where it would paint "awaiting feed" on a working
   * tile. Distinct from `note`, which is the always-shown caveat line.
   */
  awaiting?: string;
}

/**
 * The 7 danger families (Stage 1.2 collapsed the old 8 → 7; 2026-07-15 added macro-cycle as an
 * 8th, and 2026-07-17's dead-feed retirement removed it again — see the TOMBSTONE below).
 * ALL are LIVE (≥1 fetched member) since ECY seated `valuation` (2026-08-11 E4) — no feedless
 * family remains, so the panel's absent-able branch (`ids:[] ⇒ present only when overridden`)
 * currently has no instance; the mechanism stays for a future feedless family.
 * Ordered by lead-time super-group (EARLY-WARN cr,rt,vb →
 * STRESS-NOW vl,xa → CONFIRMING uT → EXOGENOUS gp). `satisfies` keeps the literal `key`s
 * pinned to `FamilyKey`.
 *
 * TOMBSTONE — `macro-cycle`/`mc` (2026-07-15 → 2026-07-17): an EARLY-WARN family whose only
 * members were F12 (China credit impulse), F14 + F15 (OECD euro-area CLI / business climate).
 * All three feeds are dead or unreachable keyless (DEC-19/DEC-20/DEC-21), leaving `ids: []` in
 * every family set, so the family was dead by construction and the key was removed (DEC-22).
 *
 * Merges vs the old 8: `complacency`→folded into `volatility`; `dispersion`+`flight`→merged
 * into new `cross-asset`; MOVE (R6) reassigned `volatility`→`rates`; new stubbed `valuation`.
 */
export const US_FAMILIES = [
  {
    key: "credit",
    label: "Credit",
    // E6(a) IMPACT ORDER (2026-07-26): every `ids` array in this file and in `GLOBAL_FAMILIES`
    // below is ordered STRONGEST-FIRST by leading impact. It is a display contract, pinned by
    // value in `families.test.ts` — do not append a member to the end for convenience; insert it
    // at its rank.
    // FOUR surfaces consume this order (corrected 2026-07-29 — the earlier "THREE, not four"
    // note miscounted by folding the two `<select>` pickers into one non-existent "/lab indicator
    // detail list"): dashboard cards (`FamilyMeta.ids` + `public/family-order.js`), the /lab
    // family tiles, the Zone D detail picker and the replay compare picker (both via
    // `public/picker-groups.js`, added when they were found still painting registry order).
    // ⚠ The replay coverage bar (`public/replay-chart.js`) does NOT — it reduces each family's
    // ids to their EARLIEST first-seen date, a min over a set, and draws one row per family.
    // Don't add a member-order pin there; it would be vacuous by construction.
    ids: ["F1", "EBP", "F3", "F2"],
    note: "US$ spreads only - no EUR/EM credit.",
    desc: "Leading: HY/IG credit-spread stress - spreads widening from their trough (widening = risk-off); stress shows here first.",
  },
  {
    key: "rates",
    label: "Rates & curve",
    // R2 sits LAST of the six weighted members even though the Σ MEMBER_WEIGHT spine does not rank it
    // last: R2 TIES R4/R6/R7 on that spine and OUT-SUMS R3, which is placed ahead of it (R1 tops it).
    // USER-ruled 2026-07-26 — the literature order wins the conflict outright. (An earlier revision
    // justified this order with "R2 tops the Σ spine (6.20)". Both halves were wrong, and already wrong
    // before R2's `Semis` cell was shape-matched to R4 on 2026-08-03 — R2's row has never summed 6.20.
    // Review fix, 2026-08-03. Deliberately no Σ figures here: they are derived from `MEMBER_WEIGHT` and
    // restating them would rot on the next retune — recompute before quoting one.) R8 is rowless too
    // (no MEMBER_WEIGHT ⇒ excluded by `isRelevant`) and ranks LAST; it reads the same curve R1 tops the
    // roster with. (T5YIFR/T10YIE moved OUT to `valuation` — Stage B.)
    ids: ["R1", "R6", "R7", "R4", "R3", "R2", "R8"],
    note: "US Treasury curve + MOVE bond-vol - no Bund/JGB.",
    desc: "Leading: interest-rate / term-structure stress - curve inversion / rate shock + bond-vol (MOVE) (inverted polarity - lower/negative = worse).",
  },
  {
    key: "valuation",
    // "Valuation", NOT "Valuation / Bubble": the label promised bubble signals this family does not
    // own — the bubble-shaped legs (price-accel, complacency-*) live in `volatility`, whose copy now
    // carries the word (2026-07-20).
    label: "Valuation & inflation",
    // ECY (excess CAPE yield × GT trend gate, 2026-08-11 E4) is the family's ONLY weighted member —
    // this seat alone brings `vb` live (`FAMILY_MEMBERS`/`CAPABLE_FAMILIES` derive from it).
    // ⚠ T5YIFR/T10YIE (moved in from `rates`, Stage B) are rowless (no MEMBER_WEIGHT ⇒ excluded by
    // `isRelevant`), so their relative order is decorative; they rank LAST. "Excluded by `isRelevant`"
    // scopes to the 9-leg DANGER ENGINE; they are ALSO dial-inert — `valuation` is filtered out of both
    // `LEADING` and `COINCIDENT` (t1dial.ts), so no breakeven state moves a band/rung term. Still
    // output-visible on a cut retune: their confirmed state colours the valuation RAG chip and the
    // "K of N firing" board/push breadth, and `confirmClosesFor` resolves their confirm tier through
    // `valuation` (the CONFIRM_TIERS.valuation stand-down buffer applies to them too).
    ids: ["ECY", "T5YIFR", "T10YIE"],
    note: "ECY (excess CAPE yield, GT trend-gated) - the weighted member, RED only when expensive AND trend-broken; T5YIFR/T10YIE inflation breakevens are rowless CONTEXT rows, dial-inert by construction; F7 CAPE stays a CONTEXT card.",
    desc: "Leading: stretched equity valuation - ECY (excess-CAPE-yield, the weighted member) says a rich market has further to fall; the 5y5y forward and 10y breakeven inflation rates are rowless CONTEXT rows measuring the inflation wedge in that same discounting story, dial-inert by construction.",
    // Set on US_FAMILIES ONLY — GLOBAL_FAMILIES shares this family object BY REFERENCE
    // (no `valuation` re-point branch exists), so it propagates to both sets for free.
    awaiting: "regional CAPE (EU / ex-US / EM): no keyless source. ECY covers US valuation only.",
  },
  {
    key: "volatility",
    label: "Volatility",
    // VT ahead of R5: the VIX LEVEL is treated as coincident, the term structure as the leading
    // read. LOW-CONFIDENCE placement (the citation behind it is the least specified in the set).
    ids: ["VT", "R5", "complacency-vix", "complacency-duration", "complacency-high", "price-accel"],
    note: "US vol (VIX/VIX-term) + the bubble-state complacency legs - no V2X/regional. The slow legs are DISPLAY-only: shown here, excluded from the dial (DIAL_FAMILIES, B-11).",
    // ⚠ TWO CONSUMERS, ONE STRING — so `desc` may make NO surface-specific paint claim (E9):
    // the /lab volatility tile tooltip (public/lab.js `#tiles`; paints all 7 chips since the
    // SLOW-leg prune retired 2026-08-15, sectioned "bubble watch" — public/tile-members.js) and
    // the dashboard's Volatility channel title (public/app.js `renderChannelCards`). Keep the
    // closing clause location-free: the SLOW legs' durable fact is display-only — filtered out
    // of `DIAL_FAMILIES` via `SLOW_INDICATOR_IDS` (danger-ladder.ts), absent from the dial.
    desc: "Coincident fear: the realized/implied volatility regime - VIX level and VIX term structure. Slower bubble-state warnings (which fire in CALM markets too) belong to this family but are display-only - excluded from the dial score.",
  },
  {
    key: "cross-asset",
    label: "Cross-asset",
    ids: ["CG"],
    note: "US proxy (copper/gold) - dispersion + FX-haven legs are global-only.",
    desc: "Coincident risk-on/risk-off across assets: safe-haven demand (FX haven + copper/gold) plus the breadth of a systemic, all-regions-falling move (dispersion) - havens bid + is stress broad or isolated.",
  },
  {
    key: "trend",
    label: "Trend & breadth",
    // Single-name / single-sector trends (F4, F5) rank last: large in-sample weight, no
    // market-stress-level literature — treated as overfit risk.
    ids: ["SPCONC", "F5", "F4"],
    note: "US-tech proxies + broad-market concentration; F5/SPCONC now carry a full expanding-percentile band (RED at p95), worst-of into the trend family and the tech-confirmer dial.",
    desc: "Coincident: global trend + breadth (ACWI trend / Global breadth) plus the US-tech proxies (SMH / QQQ/QQQE) of a big-tech drawdown and the broad-market concentration read (SPY/RSP) - index vs trend + participation (real signal at bottoms, noisy at tops).",
  },
  {
    key: "geopolitics",
    label: "Geopolitics",
    ids: ["G1", "OVX", "BRENT"],
    note: "auto: WTI spike + oil implied vol + Brent as a GEO-escalator input",
    desc: "oil/commodity + geopolitical shock (WTI spike + OVX crude-oil implied vol + Brent ROC/level as a GEO-escalator input - Brent carries no leg weight).",
  },
] satisfies readonly FamilyDef[];

/**
 * The dial's family-def table (slice 1b, [USER DECISION] = B — parameterize). The
 * T1 dial goes global while the veto panel keeps `US_FAMILIES` byte-identical. It
 * SHARES every family with `US_FAMILIES` by reference EXCEPT the ones a re-point
 * stage mutates: the alias is broken by deep-COPYING just those families (the rest
 * stay the same object), so `US_FAMILIES` can never drift.
 *
 * The **rates** family gains `"EURC"` (the ECB euro-curve leg) and `"BUND"` (the German
 * 10y−2y curve — ADDED alongside EURC, not in place of it: 2026-07-18's overlap measurement
 * put marginal disagreement at 6.81% of closes, past the 5.0% pre-registered ADD floor); the **credit** family
 * gains its non-US tail — appended to `ids` as a worst-of alongside its US
 * legs. Only the mutated families are fresh objects (`{ ...f, ids: [...] }`); every other
 * family is the SAME reference as `US_FAMILIES`'s, so `US_FAMILIES` can never drift. The
 * re-point branches below fork FOUR families — credit, rates, cross-asset and trend;
 * `volatility`, `valuation` and `geopolitics` are shared by reference.
 *
 * ⚠ Member order inside each `ids` array is the E6(a) IMPACT ORDER, strongest first — see the
 * `US_FAMILIES.credit` docblock. This table is what the /lab BOARD paints (`api/lab.ts` folds it
 * into the served `globalFamilies`) and what `DASHBOARD_FAMILIES` derives from, so it is the
 * authoritative ordering for both. It is NOT the only one on screen: /lab's frozen veto panel
 * (`usPanel`, `computeFamilyPanel(readings, US_FAMILIES)`) still paints `US_FAMILIES` order, so
 * a rank edit belongs in BOTH tables.
 */
export const GLOBAL_FAMILIES: readonly FamilyDef[] = US_FAMILIES.map((f) => {
  if (f.key === "rates") return { ...f, ids: [...f.ids, "EURC", "BUND", "ESTR"] };
  // credit gains "F13" (HYG/LQD credit appetite — leading, rate-clean,
  // CONTEXT-channel but read here off globalFamilies so it moves the Value + credit leg RAG).
  // credit gains "F10" (EM corporate OAS) alongside the HYG/LQD appetite leg — a CONTEXT
  // member read here off globalFamilies so it moves the EM/credit leg RAG.
  // E6(a): the tail order is F10 · CQS · F13 · CCC · AT1. F10 is EM-corporate-dominant and
  // F13 is the least-evidenced dial-reaching member. F13 below CQS is a RANK, not an accident — no source found either way.
  // CQS (Baa−Aaa quality-spread nowcast bridge over EBP) seated in the context tail beside F10;
  // CONTEXT-channel, weakest reach in the family.
  // BONOS (Spanish−German 10y spread) LEFT the seat 2026-09-30 [USER] → `CARD_ONLY_GROUPS` credit row (families.ts).
  // AT1 (EUR-hedged USD AT1 CoCo vs € govt rel-strength) appended after F13 — per-leg only (PER_LEG_ONLY_MEMBERS).
  // CCC (CCC & lower US HY OAS, F1's tail) seated after F13, before AT1 — per-leg only.
  if (f.key === "credit") return { ...f, ids: [...f.ids, "F10", "CQS", "F13", "CCC", "AT1"] };
  // RE-POINT cross-asset ["CG"] → ["FXH","CG","DISP"] (Stage 1.2 merge of the old flight +
  // dispersion families): FX-haven composite + copper/gold + the SPY·FEZ·EEM systemic/isolated
  // read all live on the `xa` ledger column and the Cross-asset tile. The deep copy keeps
  // US_FAMILIES's cross-asset (["CG"]) frozen, so the veto panel is unchanged.
  // cross-asset gains "F9" (broad USD) + "F11" (CNY/China risk) — CONTEXT EM-leading members
  // that live on the xa ledger column beside the FX-haven / copper-gold / dispersion legs
  // — and "F17" (USD/JPY yen weakness), seated beside F11.
  if (f.key === "cross-asset") return { ...f, ids: ["F9", "FXH", "F11", "F17", "CG", "DISP"] };
  // RE-POINT trend ["F4","F5"] → ["GT","GB","F4","F5","F6","F8"]: global trend +
  // breadth JOIN the US-tech proxies so the uT ledger column and Trend tile carry all (2026-07-13).
  // DB_SMH REMOVED (2026-07-21, fast-breaks EARLY-WARN redesign D-D): the fast semis
  // downside-break detector left the CONFIRMING/trend worst-of fold — a worst-of family
  // "inherits the noise profile of its fastest member while claiming the semantics of its slowest",
  // and DB_SMH solo-tripped a lone RED in prod. It now feeds its OWN capped EARLY-WARN sub-signal
  // (`earlyWarnFires` / `ewFloor`), NOT the trend family. Trend reverts to slow-only.
  // SPCONC JOINS here too (2026-07-23): this literal is NOT a spread of US_FAMILIES.trend,
  // so adding a member above alone leaves it invisible to GLOBAL_FAMILIES → DIAL_FAMILIES →
  // FAMILY_MEMBERS.uT. Both sites or nothing.
  // KBE_RS + the EXSH rel-strength row JOIN (2026-09-24 [USER], eufin-top5 Q9; EXSH_GATE took that seat 2026-10-06): CONTEXT; seated uT (EU-Fin cell only) —
  // per-leg only: `PER_LEG_ONLY_MEMBERS` (families.ts) keeps them off the band and out of the dial's `legP`.
  // INS_RS JOINS 2026-10-08 ([USER]): same CONTEXT / uT / per-leg-only seat.
  if (f.key === "trend") return { ...f, ids: ["GT", "GB", "SPCONC", "F6", "F5", "F4", "F8", "KBE_RS", "EXSH_GATE", "INS_RS"] };
  // `macro-cycle` gained "F12"/"F14"/"F15" here until 2026-07-17 — all three feeds were deleted
  // (DEC-19/DEC-20/DEC-21, dead-feed retirement), which left the family memberless in BOTH
  // tables, so the key itself was removed (DEC-22). Tombstone: `families.ts` FamilyKey docblock.
  return f;
});

/**
 * The Dashboard's family grouping (Stage 5): the SAME 7 families the Lab board runs,
 * each family's membership = the UNION of its `GLOBAL_FAMILIES` and `US_FAMILIES` ids,
 * deduped. Both tables share the same 7 keys in the same order
 * (`GLOBAL_FAMILIES = US_FAMILIES.map(...)`), so we zip by index — that index zip is over
 * FAMILIES, and E6(a) reorders MEMBERS, so it is untouched by the impact order.
 *
 * ⚠ GLOBAL-FIRST, deliberately (E6(a), 2026-07-26 — it was US-first until then). Under the
 * old order every US id preceded every global-only id, which forced a global-only member LAST on the
 * dashboard while /lab painted it in rank: a second, hand-maintained member order created by
 * the very rung that forbids one. The flip is safe only because `GLOBAL_FAMILIES.ids` is a
 * SUPERSET of `US_FAMILIES.ids` in every family — `families.test.ts` pins that relation, so
 * a future US-only member reds a test instead of silently appending out of rank. The
 * `...u.ids` tail is the guard that keeps such a member visible at all.
 * Single-sourced HERE so `US_FAMILIES` / `GLOBAL_FAMILIES` / `DASHBOARD_FAMILIES` — and
 * downstream `DIAL_FAMILIES` + `FAMILY_MEMBERS` (both in danger-ladder.ts; Stage 2.1 re-pointed
 * `FAMILY_MEMBERS` off `GLOBAL_FAMILIES` onto `DIAL_FAMILIES`) — can never drift. `family` on each
 * `/api/indicators` meta is `familyOf(id)`; the Dashboard groups its cards by it.
 */
export const DASHBOARD_FAMILIES: readonly FamilyDef[] = US_FAMILIES.map((u, i) => ({
  ...u,
  ids: [...new Set([...(GLOBAL_FAMILIES[i]?.ids ?? []), ...u.ids])],
}));

/** The family a served indicator id belongs to, or `undefined` (PENSION/BOTTOM → no card). */
export function familyOf(id: string): FamilyKey | undefined {
  return DASHBOARD_FAMILIES.find((f) => f.ids.includes(id))?.key;
}

/**
 * Per-family DOWN buffer for the DIRECTIONAL indicator fold (batch-2 row 7, [USER]
 * 2026-08-26, overturning IS-5's symmetric zero): a WORSE raw state confirms same-day
 * (instant-up, `domain-fold.ts asymConfirmedStateSeries`); an IMPROVED one stands down
 * only after this many consecutive clean closes. The tier value is the DOWN buffer only.
 *
 * The feed-lag rationale stands and now explains why UP is instant: data arrival is
 * *already* late on the keyless/free feeds (some multi-day), so escalation must not
 * stack a self-inflicted delay on an unavoidable one — the buffer applies only to
 * stand-down, where whipsaw is the cost being bought back.
 *
 * The tier is DATA (IS-1 rails): retuning one family's stand-down is a one-value edit here.
 *
 * ⚠ INDICATOR-level confirmation ONLY — the LEG-level pillar-regime fold
 * (`danger-engine.ts confirmedRegime`/`pillarPairAt`) keeps its own SYMMETRIC `CONFIRM_CLOSES = 2`
 * and is a DIFFERENT mechanism on the POSITION side (the re-risk deadband + dwell gates are its
 * brakes). The off-ladder `BottomState` and `PensionBand` folds likewise pass `CONFIRM_CLOSES`
 * to the symmetric primitives directly and are untouched by this table.
 */
export const CONFIRM_TIERS: Record<FamilyKey, number> = {
  credit: 2,
  rates: 2,
  valuation: 2,
  volatility: 2,
  "cross-asset": 2,
  trend: 2,
  geopolitics: 2,
};

/** DOWN-buffer closes for a served indicator id, resolved via `DASHBOARD_FAMILIES`
 *  membership (the US∪GLOBAL id union). One-speed layer (2026-08-26 ruling): family
 *  members take their family tier (all 2 today) and an id in NO family
 *  (overlay-only/context cards NVDA, DB_SMH, DB_XLK; the PENSION/BOTTOM legs;
 *  unknowns) takes the same 2 rather than a slow-tier fallback — a two-speed
 *  indicator layer would contradict the ruling, and the live fold users outside the
 *  family tables are all off every roll-up.
 *  ⚠ NOT `CONFIRM_CLOSES`: that constant stays the LEG-level / off-ladder SYMMETRIC fold's. */
export function confirmClosesFor(indicatorId: string): number {
  const fam = familyOf(indicatorId);
  return fam === undefined ? 2 : CONFIRM_TIERS[fam];
}
