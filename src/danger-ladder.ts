// Canonical per-leg danger-ladder constants (i7b removed the FE scoring engine). public/lab.js no
// longer mirrors any of these: it fetches the served /api/danger-model block (memberRelevance /
// memberLabel / superGroupOf / knobs) at load and reads live membership off d.globalFamilies, so
// there is no FE copy to drift and no parity test. Narrower for the preview fixtures: only the NAMES
// are imported (scripts/preview/mock-data.mjs imports MEMBER_LABEL) — its non-name fixture fields are
// still hand-authored and CAN drift.
/**
 * Per-leg danger-field constants — the 9-leg property model + the signal→member
 * relevance mask. Constants ONLY, no IO.
 */
// Value import (runtime edge danger-ladder → families). families.ts imports `SignalKey`
// from here type-only (erased) → no runtime cycle. Stage 2: FAMILY_MEMBERS derives from these.
import { GLOBAL_FAMILIES, LADDER, SIGNAL_OF, type FamilyDef } from "./families.js";
// Value import (runtime edge danger-ladder → registry) for the DIAL_FAMILIES derivation below.
// Acyclic since CORE-9 (2026-08-01): the scorers chain runs registry → scorers → scorers-core →
// `family-table.ts` (a zero-value-import leaf) and no longer reaches `families.ts` at all, while
// families.ts reaches back to danger-ladder TYPE-ONLY — so nothing in that chain runs this module.
// A `families.ts → registry.js` edge is now LEGAL too — see the DIAL_FAMILIES docblock below.
import { ALL_INDICATORS } from "./registry.js";
import { SLOW_INDICATOR_IDS } from "./registry-price.js";

/** A ladder sleeve NAME, as the compiler-checked union (`src/families.ts`'s `LADDER`, `as const`).
 *
 *  Exists so the two weight tables below can key their INNER record on the union rather than on
 *  plain `string` (design §11.7 / 2026-07-31). Call sites that hold a sleeve as a runtime `string`
 *  (`LEG_FIELD[].sleeve`, a persisted `held_sleeve`, a probe's CLI arg) narrow with `as LegKey` at
 *  the read — an unknown string reads `undefined` under `noUncheckedIndexedAccess` exactly as it did
 *  when the key was `string`, so the narrowing is behaviour-free. Sibling aliases of the same union
 *  already exist (`y1.ts`'s `Sleeve`, `event-study.ts`'s `Leg`); this one is the weight-table seam. */
export type LegKey = (typeof LADDER)[number];

/** A leg's static property row (design §2.1 — factual off the buyable-UCITS catalog).
 *  `risk` is the 1..9 ladder rank (aggressive → defensive); the band filter keys off it. */
export interface LegField {
  sleeve: string;
  region: string;
  rgn: string;
  exposure: string;
  sector: string;
  sec: string;
  style: string;
  /** 1..9 total-risk ladder rank (most-aggressive=1 → most-defensive=9). */
  risk: number;
  /** DECLARED cyclical/defensive partition — a standing property of the sleeve, never derived off a weight
   *  table. No engine reader since the shrink-target path retired; kept engine-only (stripped from the wire). */
  riskClass: "cyclical" | "defensive";
}

/** The 9-leg property model (design §2.1, factual off the buyable-UCITS catalog) — the SINGLE SOURCE,
 *  not a mirror of anything. `public/lab.js` holds NO `LEG_FIELD` copy (i7b removed the FE scoring
 *  engine): the FE reads the display fields off the served leg rows — `sleeve`, `rgn`/`sec`, `risk`, and
 *  `region`/`sector`/`exposure`/`style` in the descriptor copy — and `public/structure-map-axes.js` pins
 *  its `rgn`/`sec` axes against THIS table via `public/lab.structure-map.test.js`, which imports it
 *  directly. So there is no parity duty and nothing to keep verbatim.
 *
 *  ⚠ `riskClass` is DELIBERATELY ENGINE-ONLY and is NOT on the wire — a declared
 *  partition (2026-08-02 decoupling) no FE surface consumes.
 *  That is enforced in bytes, not merely typed: `LegRow extends LegField`, so the field WOULD ride
 *  `toServedField`'s `...r` spread by inheritance (it did, for one commit), and `toServedField`
 *  (`src/lab-served-field.ts`) now
 *  DELETES the `LegRowEngineOnly` keys (`src/api/types.ts`) off every served row — pinned at runtime
 *  in `api/lab.test.ts` ("no engine-only field rides a served leg row"), because the handler's
 *  closing `as unknown as` cast puts the served shape out of tsc's reach. Its absence from `public/`
 *  is the decision, not drift: promoting it to the wire means an `openapi.yaml` + contract-sample
 *  change, made deliberately — never by widening that alias to silence a red contract literal. */
export const LEG_FIELD: readonly LegField[] = [
  { sleeve: "Semis",    region: "Global-AW", rgn: "AW",   exposure: "Semiconductors",      sector: "Semiconductors",        sec: "Semis",   style: "Growth / high-beta", risk: 1, riskClass: "cyclical" },
  { sleeve: "S&P IT",   region: "US",        rgn: "US",   exposure: "Info-Tech",           sector: "Info-Tech",             sec: "Tech",    style: "Growth",             risk: 2, riskClass: "cyclical" },
  { sleeve: "EM",       region: "Emerging",  rgn: "EM",   exposure: "Broad",               sector: "Broad-market",          sec: "Broad",   style: "Cyclical",           risk: 3, riskClass: "cyclical" },
  { sleeve: "Value",    region: "Global-DM", rgn: "DM",   exposure: "Value",               sector: "Broad (Value factor)",  sec: "Value",   style: "Value",              risk: 4, riskClass: "cyclical" },
  { sleeve: "S&P 500",  region: "US",        rgn: "US",   exposure: "Broad",               sector: "Broad-market",          sec: "Broad",   style: "Blend",              risk: 5, riskClass: "cyclical" },
  { sleeve: "ex-US",    region: "Dev ex-US", rgn: "exUS", exposure: "Broad",               sector: "Broad-market",          sec: "Broad",   style: "Blend",              risk: 6, riskClass: "cyclical" },
  { sleeve: "EU-Fin",   region: "Europe",    rgn: "EU",   exposure: "High-dividend / fins-heavy", sector: "High-div (60% fins)", sec: "HiDiv",   style: "Value-income",       risk: 7, riskClass: "cyclical" },
  { sleeve: "Health",   region: "Global-DM", rgn: "DM",   exposure: "Healthcare",          sector: "Healthcare",            sec: "Health",  style: "Defensive",          risk: 8, riskClass: "defensive" },
  { sleeve: "Staples",  region: "Global-DM", rgn: "DM",   exposure: "Cons. staples",       sector: "Cons. staples",         sec: "Staples", style: "Defensive",          risk: 9, riskClass: "defensive" },
];

/** The signal-grid family keys (design §2.2), in super-group / render order (Stage 1.2 collapsed
 *  the old 8 keys `uT dS cr rt vl fl gp cp` → 7): `cp` folded into `vl` (volatility⊇complacency),
 *  `dS`+`fl` merged into `xa` (cross-asset), new stubbed `vb` (valuation, no live feed). `uT`/`gp`
 *  survive as keys. `uT` is member-sourced (GT/GB + F4/F5 + F6/F8); `gp` = geopolitics/oil. */
export type SignalKey = "cr" | "rt" | "vb" | "vl" | "xa" | "uT" | "gp";

/** Column order the danger engine iterates over — super-group lead-time order
 *  (EARLY-WARN cr,rt,vb → STRESS-NOW vl,xa → CONFIRMING uT → EXOGENOUS gp). */
export const SIGNALS: readonly SignalKey[] = ["cr", "rt", "vb", "vl", "xa", "uT", "gp"];

/** Lead-time super-groups (Stage 1) — a coarser layer over the signal columns, ordered by
 *  how early each cluster fires as danger builds: EARLY-WARN (leading credit/rates + stubbed
 *  valuation) → STRESS-NOW (live stress: vol⊇complacency / cross-asset) → CONFIRMING (trend, the
 *  slow confirmer) → EXOGENOUS (geopolitics, outside the market cycle). */
export type SuperGroup = "EARLY-WARN" | "STRESS-NOW" | "CONFIRMING" | "EXOGENOUS";

/** Super-groups in lead-time order (earliest-firing first). */
export const SUPER_GROUPS: readonly SuperGroup[] = [
  "EARLY-WARN",
  "STRESS-NOW",
  "CONFIRMING",
  "EXOGENOUS",
];

/** `SignalKey` → its lead-time super-group (7-key taxonomy, Stage 1.2). */
export const SUPER_GROUP_OF: Record<SignalKey, SuperGroup> = {
  cr: "EARLY-WARN",
  rt: "EARLY-WARN",
  vb: "EARLY-WARN",
  vl: "STRESS-NOW",
  xa: "STRESS-NOW",
  uT: "CONFIRMING",
  gp: "EXOGENOUS",
};

/** Stubbed families — cells forced `na` until their feed ships. Empty now that uT is
 *  member-sourced (2026-07-13): every column derives from live members. */
export const STUBBED_SIGNALS: ReadonlySet<SignalKey> = new Set<SignalKey>([]);

/**
 * GLOBAL_FAMILIES as the DIAL sees it — B-11, ruled 2026-07-20.
 *
 * The SLOW legs (`price-accel` + the three `complacency-*`) are DECLARED `volatility` members,
 * deliberately: they are the mechanism of the 2026-07-15 cp→vl fold. But that membership is
 * DISPLAY-ONLY. Slow→fast coupling was deliberately broken and is TEST-PINNED (`dashboard.notify.test.ts`
 * "on a no-dial run the armed bit is INERT"); feeding the track rows into
 * the cron dial was tried and REVERTED — it turned the fragile-calm case OK→WATCH.
 *
 * Those two rulings only coexist if the split is enforced HERE, at the one table every dial path
 * reduces against. The divergence it closes: the cron path never passes the slow rows (they reach
 * the DB via `recordRun`, separately), while /api/lab reduces the WHOLE persisted run via
 * `getReadingsForRun` and so DID pick them up — same run, two `volatility` panels, and volatility
 * is a FIRE family, so a RED slow leg could flip `fired` (which gates rungs 7-9).
 *
 * Stripping the ids from the DEF (rather than filtering the reading list) is what makes this hold
 * on the /lab SCENARIO path too: `computeFamilyPanelFromStates` enumerates members from `f.ids`,
 * so a reading-side filter would have left the scenario panel carrying legs the live panel had
 * dropped — breaking the Slice 2.1 scenario↔live field parity. It also keeps the rank-7 carry
 * honest: the carry loop reads `fam.ids` to fetch last-known state, and a slow id there would
 * re-admit the leg through the back door.
 *
 * /lab's BOARD is unaffected because `assembleDial` returns a SECOND panel for it: `displayPanel`,
 * the same reduction against the full `GLOBAL_FAMILIES` table, which /api/lab serves as
 * `globalFamilies` (the panel `public/lab.js` renders tiles, ledger member chips and replay member
 * lists from). Feeding the board the dial panel instead would delete the legs from the Volatility
 * tile — the exact opposite of "display-only". Display-only, exactly as ruled.
 *
 * DEFINED HERE (moved out of `dial-assembly.ts`, Stage 2.1) so `FAMILY_MEMBERS` below can derive
 * from it without importing `dial-assembly.js` — that import would close the runtime cycle
 * `danger-ladder → dial-assembly → danger-engine → danger-ladder` on a module-init const (TDZ).
 * Why `families.ts` is the natural — and, since CORE-9, LEGAL — home, and why that relocation was
 * deliberately NOT taken → `docs/member-weight-provenance.md` §DIAL_FAMILIES. `dial-assembly.ts`
 * re-exports this symbol,
 * so every existing importer is unchanged. ONE derivation of the SLOW exclusion, here.
 */
export const DIAL_FAMILIES: readonly FamilyDef[] = GLOBAL_FAMILIES.map((f) =>
  f.ids.some((id) => SLOW_INDICATOR_IDS.has(id))
    ? { ...f, ids: f.ids.filter((id) => !SLOW_INDICATOR_IDS.has(id)) }
    : f,
);

/** signal family → its member-indicator ids. **Derived** (Stage 2) from `DIAL_FAMILIES`
 *  directly above (this file, Stage 2.1) through the Stage-1 `SIGNAL_OF` bijection — server-side
 *  family membership is authored ONCE (`GLOBAL_FAMILIES` in families.ts), so this can never drift.
 *
 *  **`DIAL_FAMILIES`, not `GLOBAL_FAMILIES` (Stage 2.1, 2026-07-20).** Every consumer of this map
 *  is on the NOTIFY axis — `familyShare` (`danger-share.ts`), `computeCells`'s N/M signal grid and
 *  `observedAtLookback`'s regime-ROC depth check — and all read a panel folded against `DIAL_FAMILIES`.
 *  The wider display table would seat the four DISPLAY-ONLY SLOW ids (`price-accel` + the three
 *  `complacency-*`) in `vl`, inflating its `N` in the signal grid. The SLOW exclusion is derived exactly ONCE — in `DIAL_FAMILIES` directly above; never
 *  re-apply it in this reduce or in any consumer.
 *
 *  ⚠ Anything enumerating a family must read THIS export, never the prose. */
export const FAMILY_MEMBERS: Record<SignalKey, readonly string[]> = DIAL_FAMILIES.reduce(
  (acc, f) => {
    acc[SIGNAL_OF[f.key]] = f.ids;
    return acc;
  },
  {} as Record<SignalKey, readonly string[]>,
);

// All 9 leg sleeves in ladder order — the full-reach axis MEMBER_RELEVANCE is derived over.
const ALL_LEGS = LEG_FIELD.map((l) => l.sleeve);

/** Per-member × leg DANGER WEIGHT ∈ [0,1] — THE sole canonical reach+magnitude table, covering
 *  EVERY member × all 9 legs (`MEMBER_RELEVANCE` is derived from it below). Weight = MAGNITUDE of
 *  that leg's sensitivity to the member's move; a leg that BENEFITS (e.g. Value under rising rates,
 *  defensives under inversion) gets a LOW weight so its danger stays low and it floats up as the
 *  rotation haven; `0` = that member is irrelevant on that leg. A family ALL of whose members are `0` on a
 *  leg has no share there (`familyShare` → `null`) and drops out of that leg's pillar mean. ALL families now carry
 *  researched 0–1 magnitudes: rates/curve (`rt`) and every
 *  other family from the Stage-2 parallel-research pass.
 *  Reach (non-zero support) is unchanged from the legacy REL_* mask — only magnitude is differentiated,
 *  so `MEMBER_RELEVANCE` is byte-identical. Legs, ladder order:
 *  Semis · S&P IT · EM · Value · S&P 500 · ex-US · EU-Fin · Health · Staples.
 *
 *  ⚠ THIS TABLE SETS **TWO DYNAMIC DENOMINATORS** (`danger-share.ts`): a family share is Σ w·sev / Σ w over
 *  its observed members with weight > 0 (`uT`: read via `trendShare`, × min(1, full roster Σ w) — the ceiling), so
 *  seating a calm member dilutes that family's share; and making a leg
 *  relevant to a family that had no weighted member adds it to the pillar's `FAMILY_LEG_WEIGHT` mean, so a
 *  calm newcomer lowers the leg's danger. No normalization step absorbs either.
 *
 *  ⚠ **THE TWO EXCLUSION RULES, AT THEIR SEAM** — `familyShare` drops an unobserved or 0-weight member from
 *  both sums, and a family with none left from the pillar mean; populations → `docs/member-weight-provenance.md`
 *  §Table-wide — re-derive them from `familyShare` over `SignalKey × LADDER`, never by editing the prose.
 *
 *  ⚠ VERIFYING AN EDIT HERE: `npm run sim:notify -- all` CANNOT see it — a green sim is not evidence.
 *  Its 15 worlds set every member of a family to that family's state, so the max fold saturates and
 *  per-member weight differentiation cancels; it is structurally blind to within-band aggregator moves
 *  (`.claude/rules/research-probes.md`). Observe the change by replaying real closes at the `resolveCuts`
 *  level — `npm run probe:top2` or a `scripts/probe-*.ts` — and read any band movement off that.
 *  `MEMBER_RELEVANCE` is DERIVED from this table (`weight > 0`),
 *  making it the SOLE source of truth for member×leg reach AND magnitude — never add a parallel
 *  relevance mask.
 *
 *  ⚠ **The INNER key is the `LADDER` union, not `string`** (2026-07-31, design §11.7). Precisely what
 *  that buys, and what it does NOT:
 *   • CAUGHT: a MISSPELLED leg cell is now a `tsc` error (TS2353) — it was silently legal under the
 *     old `string` key. That is the class the rung-7 rename to `EU-Fin` risked most.
 *   • NOT caught: an OMITTED cell. `Partial` is exactly the modifier that legalises omission, and it
 *     is load-bearing here — most rows are sparse by design (a leg absent from a row is out of that
 *     member's max, §10.7). A cell that SHOULD exist but does not is still covered only by
 *     `danger-ladder.test.ts`'s one-directional reach invariant. Design §11.7 claimed this stage
 *     closed that gap; it does not (found in Stage 0 review, 2026-07-31).
 *  Behaviour-free: under `noUncheckedIndexedAccess` a read off either shape is `number | undefined`.
 *  ⚠ Keep both tables' rows as INLINE object literals — excess-property checking (the misspelling
 *  guard above) fires only on fresh literals, so building a row through a widening intermediate or a
 *  spread would silently re-open the key to any string.
 *
 *  📜 PROVENANCE — the per-row constraint that binds a retune lives in `docs/member-weight-provenance.md`,
 *  organised by member id. Read that section before retuning a cell; write the retune's superseding
 *  constraint back into it (deleting what it replaces), never into this table, and its rationale into the
 *  commit message (`.claude/rules/doc-writing.md`).
 *
 *  ⚠ **A rowless `MEMBER_WEIGHT` DOES mean "moves the dial nothing" now** — this block asserted the
 *  opposite until 2026-08-20 and the claim is retired. It read: the panel state is an unweighted
 *  worst-of over present members, `credit`/`rates` are LEADING/ARM families, so a firing leader raises
 *  the dial floor and `GLOBAL_FAMILIES` membership is itself the dial-moving act. **D1
 *  killed that mechanism**: `FamilyPanel.firing` is now
 *  computed over the BAND-DRIVING set (`BAND_DRIVING`, `families.ts`), so a member the band does not
 *  seat cannot arm its family and cannot touch the floor, no matter what it does.
 *
 *  What replaced it is a DIFFERENT mechanism, and `MEMBER_WEIGHT` is now the gate on it. D6 (§6 of the
 *  same plan) added `legP` to `computeT1Dial`: an off-band member that carries a row here — or any
 *  rowed member of a `NO_ARM_FAMILIES` family, e.g. `ECY` — DEEPENS the dial through `positionP`, and
 *  only through `positionP`. It never touches `lo`/`armed`/`fired`/the band width/`shockFloor`. So:
 *   • rowed + band-seated  → arms its family (the floor path) AND scores legs;
 *   • rowed + off-band     → `legP` deepening + per-leg reach, never an arm (`F13`, `ECY`);
 *   • ROWLESS + off-band   → moves NOTHING on the dial (`R8` off its bridge, `T5YIFR`, `T10YIE`) —
 *     it still folds into the family's displayed worst-of and the `⌁` cannot-arm mark, which is paint;
 *   • card-only (`CARD_ONLY_GROUPS`, `familyOf` undefined) remains the total zero-effect shape.
 *  Adding a row here therefore now BUYS dial reach for an off-band member where it previously bought
 *  none — the reverse of the retired reading. Weigh that before adding one.
 *
 *  ⚠ **`MEMBER_WEIGHT.R6` carries a non-zero `Health` cell** (the row below is its only value site) — the `Health` column is no longer constant, so
 *  every "Health is structurally undifferentiated" reading is retired, and a weight change of this class
 *  can invalidate a TEST PREMISE in a suite its focus files never import (`claim-verification.md` §34). */
export const MEMBER_WEIGHT: Record<
  string,
  Readonly<Partial<Record<LegKey, number>>>
> = {
  // --- rates/curve (rt): differentiated 0–1 weights ---
  // ⚠ THE DEFENSIVE COLUMN SHAPE IS DERIVED, NEVER HAND-TYPED (a hand-typed enumeration was wrong twice); its derivation probe is archived — rung-5 audit trail → provenance doc §rt.
  R1: { Semis: 0.6, "S&P IT": 0.8, EM: 1.0, Value: 0.6, "S&P 500": 0.6, "ex-US": 0.6, "EU-Fin": 0.4, Health: 0.2, Staples: 0.4 },
  R2: { Semis: 0.6, "S&P IT": 1.0, EM: 0.8, Value: 0.6, "S&P 500": 0.6, "ex-US": 0.6, "EU-Fin": 0.4, Health: 0.4, Staples: 0.4 },
  R3: { Semis: 0.8, "S&P IT": 0.8, EM: 1.0, Value: 0.4, "S&P 500": 0.6, "ex-US": 0.6, "EU-Fin": 0.4, Health: 0.4, Staples: 0.4 },
  R4: { Semis: 1.0, "S&P IT": 1.0, EM: 0.8, Value: 0.4, "S&P 500": 0.6, "ex-US": 0.6, "EU-Fin": 0.4, Health: 0.4, Staples: 0.4 },
  R7: { Semis: 0.8, "S&P IT": 0.8, EM: 1.0, Value: 0.6, "S&P 500": 0.6, "ex-US": 0.6, "EU-Fin": 0.4, Health: 0.1, Staples: 0.3 },
  // ⚠ EU-Fin euro-curve pair: `BUND` stays STRICTLY BELOW `EURC` ([USER] 2026-09-26, re-ruled
  //    2026-10-08 with the holdings re-cut) — `danger-ladder.test.ts` "EU-Fin rates ordering" pins it.
  EURC: { Semis: 0.6, "S&P IT": 0.3, EM: 0.4, Value: 0.6, "S&P 500": 0.2, "ex-US": 0.8, "EU-Fin": 0.4, Health: 0.2, Staples: 0.2 },
  BUND: { Semis: 0.6, "S&P IT": 0.4, EM: 0.5, Value: 0.6, "S&P 500": 0.3, "ex-US": 0.8, "EU-Fin": 0.3, Health: 0.2, Staples: 0.2 },
  // SPARSE by ruling (eufin-top5 Q5): EU-Fin ONLY, off-band. Cell hand-set [USER] 2026-09-24 (was the peer median 0.4).
  ESTR: { "EU-Fin": 0.2 },
  // --- credit (cr): OAS widening — high-beta cyclicals/EM worst, defensives/value havens (Stage-2) ---
  // ⚠ SEATING A NEW LEG IS A COUPLED EDIT: it owes a `FAMILY_LEG_WEIGHT` entry in the SAME commit (`familyLegWeight`'s `measured` arm THROWS without one) and, if it flips a cell `estimated → measured`, the `cell-sensitivity.ts` regen + count re-pins.
  F1: { Semis: 0.6, "S&P IT": 1.0, EM: 0.8, Value: 0.8, "S&P 500": 0.6, "ex-US": 0.6, "EU-Fin": 0.5, Health: 0.6, Staples: 0.5 },
  F2: { Semis: 0.8, "S&P IT": 0.8, EM: 0.6, Value: 0.4, "S&P 500": 0.6, "ex-US": 0.6, "EU-Fin": 0.4, Health: 0.5, Staples: 0.5 },
  EBP: { Semis: 1.0, "S&P IT": 0.8, EM: 0.8, Value: 0.6, "S&P 500": 0.6, "ex-US": 0.6, "EU-Fin": 0.4, Health: 0.5, Staples: 0.5 },
  F3: { Semis: 1.0, "S&P IT": 0.9, EM: 0.8, Value: 0.4, "S&P 500": 0.7, "ex-US": 0.6, "EU-Fin": 0.4, Health: 0.5, Staples: 0.5 },
  // BONOS has NO row — card-only by ruling [USER] 2026-09-30 (provenance §BONOS): a coincident sovereign spread
  // whose level pair sat RED on ~93 % of 2010–2024 days; never re-seat without a new ruling.
  F13: { Value: 1.0, "S&P 500": 0.8, "ex-US": 0.7, EM: 0.7, "EU-Fin": 0.4, Semis: 0.5, "S&P IT": 0.4, Health: 0.3, Staples: 0.3 },
  // SPARSE by ruling (eufin-overlap R7): EU-Fin ONLY, per-leg only (PER_LEG_ONLY_MEMBERS). Cell hand-set [USER] 2026-10-08.
  AT1: { "EU-Fin": 0.7 },
  // CCC: F1's tail, every cell <= F1's (pinned) — per-leg only [USER].
  CCC: { Semis: 0.5, "S&P IT": 0.4, EM: 0.5, Value: 0.5, "S&P 500": 0.4, "ex-US": 0.4, "EU-Fin": 0.5, Health: 0.2, Staples: 0.2 },
  // CQS is EBP's nowcast BRIDGE, so its reach mirrors EBP's at ≤0.7× per cell (arbitration: it can
  // never out-weigh the member it front-runs). `EU-Fin` DROPPED not zeroed — a US quality spread does
  // not transmit to a European high-dividend rung. max row = 0.7 <
  // SEV_CUTS.red, so a full-RED bridge is AMBER-capable, never solo-RED. Row retained UNCHANGED
  // from its 2026-08-16 seating.
  CQS: { Semis: 0.7, "S&P IT": 0.5, EM: 0.5, Value: 0.4, "S&P 500": 0.4, "ex-US": 0.4, Health: 0.1, Staples: 0.3 },
  // --- vol (vl): VIX equity-vol / MOVE bond-vol spikes ---
  R5: { Semis: 0.6, "S&P IT": 1.0, EM: 0.8, Value: 0.6, "S&P 500": 0.6, "ex-US": 0.6, "EU-Fin": 0.4, Health: 0.5, Staples: 0.3 },
  VT: { Semis: 0.6, "S&P IT": 1.0, EM: 0.6, Value: 0.6, "S&P 500": 0.6, "ex-US": 0.6, "EU-Fin": 0.4, Staples: 0.3 },
  R6: { Semis: 0.8, "S&P IT": 0.8, EM: 0.8, Value: 0.4, "S&P 500": 0.6, "ex-US": 0.6, "EU-Fin": 0.4, Health: 0.5, Staples: 0.6 },
  // --- cross-asset (xa) ⊇ flight: haven bid = risk-off, cyclicals/EM hurt ---
  // FXH row max = 0.6 (< SEV_CUTS.red): haven FX is a COINCIDENT, downstream read of the vol shock
  // (VIX Granger-causes USD/JPY, not the reverse), so a solo FXH RED may never drive a leg to max —
  // vol's row owns that. High-beta cells shaped to the carry-unwind damage signature; EU-Fin /
  // Health / Staples are RULED floor seats, untouched (provenance §FXH). [USER] 2026-09-04.
  FXH: { Semis: 0.6, "S&P IT": 0.5, EM: 0.6, Value: 0.4, "S&P 500": 0.3, "ex-US": 0.5, "EU-Fin": 0.4, Health: 0.3, Staples: 0.3 },
  CG: { Semis: 0.6, "S&P IT": 0.6, EM: 1.0, Value: 0.4, "S&P 500": 0.6, "ex-US": 0.8, "EU-Fin": 0.2 },
  // --- cross-asset (xa) ⊇ dispersion: broad multi-region structure stress ---
  DISP: { EM: 0.8, Value: 0.6, "S&P 500": 0.6, "ex-US": 0.6, "EU-Fin": 0.4, Health: 0.3, Staples: 0.3 },
  // --- EM-leading indicators (F9/F10/F11) — EM-heavy reach ---
  F9: { EM: 1.0, "ex-US": 0.8, Semis: 0.6, "S&P IT": 0.4, "S&P 500": 0.4, Value: 1.0 },
  F10: { EM: 1.0, "ex-US": 0.6, Semis: 0.4, "S&P 500": 0.4, Value: 0.4, Health: 0.3, Staples: 0.4 },
  F11: { EM: 1.0, Semis: 0.8, "ex-US": 0.6, Value: 0.6, "S&P 500": 0.4 },
  // Value ONLY — ruled 2026-08-10; kept BELOW `F9`'s Value cell (2026-09-04) → `docs/member-weight-provenance.md` §F17.
  F17: { Value: 0.4 },
  // --- trend/breadth (uT): global trend break; F4/F5 tech-LED proxies ---
  GT: { Semis: 1.0, "S&P IT": 0.8, EM: 0.8, Value: 0.6, "S&P 500": 0.6, "ex-US": 0.6, "EU-Fin": 0.4, Health: 0.4, Staples: 0.3 },
  GB: { Semis: 1.0, "S&P IT": 0.8, EM: 0.8, Value: 0.6, "S&P 500": 0.6, "ex-US": 0.6, "EU-Fin": 0.4 },
  F4: { Semis: 0.8, "S&P IT": 0.8, "S&P 500": 0.4, Value: 0.5 },
  // ⚠ NOT A LIVE SCORED ROW — do not retune it. DB_SMH is in NO family (it left trend at D-D 2026-07-21 for its own capped EW sub-signal), so this row is never looked up; kept only because MEMBER_WEIGHT was out of scope that stage. `docs/member-weight-provenance.md` §DB_SMH.
  DB_SMH: { Semis: 0.8, "S&P IT": 0.8, "S&P 500": 0.4 },
  SPCONC: { Semis: 0.4, "S&P IT": 0.3, "S&P 500": 0.3 },
  // ⛔ DEMOTED 2026-08-30 [USER]. Keep every cell STRICTLY ABOVE the SPCONC cell on the same leg —
  //    `docs/member-weight-provenance.md` §SPCONC pins that row "quieter than F5"; re-rule it first.
  // ⚠ NOTIFY-path row: an F5 RED now bands AMBER in `memberScaledBand`. A retune here re-derives
  //    `src/t1dial.test.ts` and the `--before=f5` literals (`scripts/probe-leg-ordering.ts`).
  F5: { Semis: 0.6, "S&P IT": 0.4, "S&P 500": 0.4 },
  NVDA: { Semis: 1.0, "S&P IT": 0.6, "S&P 500": 0.4 },
  F6: { Semis: 1.0, "S&P IT": 0.8 },
  F8: { Semis: 0.6, "S&P IT": 0.4, "S&P 500": 0.2, Value: 1.0 },
  // EU-Fin ONLY by ruling (eufin-top5 Q10) — constraints → `docs/member-weight-provenance.md` §KBE_RS / §EXSH_GATE.
  KBE_RS: { "EU-Fin": 0.2 },
  EXSH_GATE: { "EU-Fin": 0.6 },
  // INS_RS: EU-Fin ONLY, per-leg only (insurers ~31% of EXSH)
  INS_RS: { "EU-Fin": 0.6 },
  // --- valuation (vb): ECY excess CAPE yield × GT trend gate — first live member (2026-08-11 E5) ---
  // Richest long-duration legs de-rate hardest; Value is the cheap-style haven cell. Constraints →
  // `docs/member-weight-provenance.md` §ECY.
  ECY: { Semis: 1.0, "S&P IT": 1.0, EM: 0.6, Value: 0.3, "S&P 500": 0.8, "ex-US": 0.6, "EU-Fin": 0.4, Health: 0.4, Staples: 0.4 },
  // --- geopolitics (gp) rows: oil/commodity shock — G1 (WTI) · OVX (crude implied vol) · BRENT ---
  // ⚠ THIS TABLE IS THE CROSS-LEG SHAPE ONLY — IT IS **NOT** THE FAMILY'S AUTHORITY. The `1.0` on
  // `OVX.EM` means "the most oil-sensitive leg", NOT "this member may set a leg's danger to 1.0".
  // The authority is the share arm's cap, `gp` term ≤ `GP_CAP_FRACTION` × `cuts.amber` (`danger-share.ts`):
  // retune a "too loud" exogenous family THERE; these rows only weight the members within the `gp` share.
  G1: { EM: 0.5, "ex-US": 0.4, "EU-Fin": 0.2, "S&P 500": 0.25, Semis: 0.2, "S&P IT": 0.2, Health: 0.15, Staples: 0.15, Value: 0.1 },
  OVX: { EM: 1.0, "ex-US": 0.8, "EU-Fin": 0.2, "S&P 500": 0.5, Semis: 0.4, "S&P IT": 0.4, Health: 0.3, Staples: 0.3, Value: 0.2 },
  BRENT: { EM: 1.0, "ex-US": 0.8, "EU-Fin": 0.2, "S&P 500": 0.5, Semis: 0.4, "S&P IT": 0.4, Health: 0.3, Staples: 0.3, Value: 0.2 },
  // --- volatility (vl) ⊇ complacency: stretched-positioning warnings, high-beta most vulnerable ---
  "price-accel": { Semis: 1.0, "S&P IT": 1.0, EM: 0.6, "S&P 500": 0.8, "ex-US": 0.4 },
  "complacency-vix": { Semis: 0.8, "S&P IT": 0.8, EM: 0.6, "S&P 500": 0.6, "ex-US": 0.4 },
  "complacency-high": { Semis: 1.0, "S&P IT": 1.0, EM: 0.6, "S&P 500": 0.8, "ex-US": 0.4 },
  "complacency-duration": { Semis: 0.6, "S&P IT": 0.6, EM: 0.4, "S&P 500": 0.6, "ex-US": 0.4 },
};

/** Per-member TIMING CLASS — the THIRD axis: **WHEN a member speaks**, not how hard and not how much.
 *  The argument for needing a third axis at all is settled — do not
 *  re-derive it here.
 *
 *  DISJOINT FROM BOTH WEIGHT AXES, deliberately:
 *   • `MEMBER_WEIGHT` (above) = ABSOLUTE cross-leg MAGNITUDE, inside the Level-1 `max`.
 *   • `FAMILY_LEG_WEIGHT` (below) = WITHIN-leg RELATIVE family IMPORTANCE, column-normalized.
 *   • `TIMING_CLASS` (here) = the member's phase relative to the damage it reports.
 *  Neither weight table encodes timing, which is why lead/lag arguments were previously priced INTO
 *  `MEMBER_WEIGHT` cells — a category error. Never "fix" a timing concern by moving a weight, and never
 *  read a class here as a magnitude.
 *
 *  ⚠ LOAD-BEARING SINCE STAGE 2.1 — re-classifying a member MOVES OUTPUT. `signalHoldClosesFor` (below)
 *  resolves this table into a per-member hold window, and `buildMemberStateHeldAt` /
 *  `buildMemberStateHeld` (`danger-member-state.ts`) apply that window at all three member-state
 *  reconstruction sites in `computeField`, so a class change re-times every leg the member reaches.
 *  (The hold is now this table's ONLY consumer.) An edit here is
 *  never a documentation change; nothing in the type system will tell you otherwise (see the
 *  completeness note below).
 *
 *  HAND-SET PRIORS, NOT AN ESTIMATION. Each class is derived from the rationale ALREADY RECORDED for
 *  that member — its `MEMBER_WEIGHT` row comment, its registry entry, or the family's own lead-time
 *  super-group (`SUPER_GROUP_OF` above: EARLY-WARN → STRESS-NOW → CONFIRMING is a timing ordering, and
 *  it is the default when a member carries no timing sentence of its own). A recorded per-member
 *  sentence always OVERRIDES the family default — that is why `F4` is `coin` inside CONFIRMING and `F1`
 *  is `coin` inside EARLY-WARN. The Conference Board's LEI/CEI/LagI partition is theory-assigned too;
 *  this table is the same kind of object. Do not re-classify off a fresh study without a plan ruling.
 *
 *  ⚠ COMPLETENESS IS NOT COMPILER-ENFORCED. There is NO member-id union type in this repo — the sibling
 *  tables (`MEMBER_WEIGHT`, `MEMBER_LABEL`, `MEMBER_RELEVANCE`) are all keyed by plain `string`, and the
 *  member roster is assembled at RUNTIME from `Object.keys(MEMBER_WEIGHT) ∪ FAMILY_MEMBERS`. `tsc`
 *  therefore CANNOT catch a new member that never gets a class here. The guard is the runtime union pin
 *  in `danger-ladder.test.ts` ("TIMING_CLASS is keyed exactly by the MEMBER_WEIGHT ∪ FAMILY_MEMBERS
 *  union"). Seating a new member means editing this table in the same commit. */
export type TimingClass = "lead" | "coin" | "lag";
/** @internal */
export const TIMING_CLASS: Record<string, TimingClass> = {
  // --- credit (cr) — EARLY-WARN by family, but the realized-SPREAD reads are coincident ---
  // 📜 EVERY row's class grounds live in `docs/member-weight-provenance.md` §TC.<member> (the
  // per-row rationales were evacuated there 2026-08-08). Read the member's section before
  // re-classifying it.
  F1: "coin",
  F2: "coin",
  EBP: "lead",
  F3: "lead",
  // CQS = lead by LATENCY (a same-day nowcast bridge over EBP's month-stale print), not by content —
  // its realized-spread content class is `coin`, like the other credit spreads above.
  CQS: "lead",
  F10: "coin",
  F13: "lead",
  AT1: "coin",
  CCC: "coin",
  // --- rates/curve (rt) — EARLY-WARN; curves and forward expectations lead, levels/vol do not ---
  R1: "lead",
  // R8 is R1's curve on a 21-obs mean. The class is the member's phase relative to the DAMAGE it
  // reports, not its lag behind R1 — the term spread leads a recession by quarters, and a one-month
  // smoother does not spend that lead.
  R8: "lead",
  R2: "coin",
  R3: "lead",
  R4: "coin",
  R6: "coin",
  R7: "lag",
  EURC: "coin",
  BUND: "lead",
  ESTR: "coin",
  T5YIFR: "lead",
  T10YIE: "lead",
  // --- valuation (vb) — EARLY-WARN; richness precedes the de-rate it warns of ---
  ECY: "lead",
  // --- volatility (vl) — STRESS-NOW: vol prints the stress as it happens ---
  R5: "coin",
  VT: "coin",
  // --- cross-asset (xa) — STRESS-NOW, except F9, whose translation damage lands later ---
  FXH: "coin",
  DISP: "coin",
  CG: "lead",
  F9: "lag",
  // ⚠ F11 does NOT inherit F9's class: F9's `lag` ground is EARNINGS TRANSLATION over reporting
  // quarters, a mechanism a daily spot-FX price does not have (grounds → provenance doc §TC.F11).
  F11: "coin",
  // F17 takes F11's ground, not F9's: a daily spot-FX price prints stress as it happens (§TC.F17).
  F17: "coin",
  // --- trend (uT) — CONFIRMING, "the slow confirmer"; F4/F6 are the recorded coin exceptions ---
  GT: "lag",
  GB: "lag",
  // ⛔ Two prohibitions the next re-classifier must obey (full argument → provenance doc §TC.SPCONC):
  // `MEMBER_WEIGHT.SPCONC`'s engine parenthetical is NOT a timing ground — do not re-cite it; and the
  // rule "a placebo-surviving forward-return effect is a leading property by definition" is REFUTED by
  // the S&P IT risk-coverage measurement, which attributes such gaps to regime clustering — do
  // not re-use it here or on `F5` (SPCONC's exact twin, also `lag`; both now carry a RED arm).
  SPCONC: "lag",
  F5: "lag",
  F4: "coin",
  F6: "coin",
  F8: "lag",
  KBE_RS: "coin",
  INS_RS: "coin",
  EXSH_GATE: "coin",
  // --- geopolitics/oil (gp) — EXOGENOUS: the shock and its implied vol are contemporaneous ---
  G1: "coin",
  BRENT: "coin",
  OVX: "coin",
  // --- weighted but off the dial roster (SLOW track + retired/inert single names) ---
  "price-accel": "lead",
  "complacency-vix": "lead",
  "complacency-high": "lead",
  "complacency-duration": "lead",
  NVDA: "coin",
  DB_SMH: "coin",
};

/** SIGNAL-HOLD WINDOW per timing class, in CLOSES — how long one member's fire stays visible to the
 *  danger path after it prints (Stage 2.1).
 *  A leading member is therefore still lit when its coincident confirmers arrive, so a
 *  leg reaches full danger on the LEADER's clock rather than the laggard's.
 *
 *  KEYED BY CLASS, NEVER PER MEMBER. Many classed members, exactly three windows; the
 *  per-member value is resolved through `signalHoldClosesFor` off `TIMING_CLASS`. Retuning a window is a
 *  ONE-place edit here — never restate one of these numbers in a comment, a fixture or a doc.
 *
 *  ⚠ HAND-SET PRIORS. `docs/reference.md` §[arch] 4 governs: these are judgement calls recorded as
 *  rationale, not estimated or searched constants. A literature search was run for this sub-fork
 *  specifically and returned NOTHING PRESCRIPTIVE for a daily-close persistence horizon — KLR's
 *  signal window is 24 MONTHS on monthly crisis data and does not transfer, and no daily-frequency
 *  stress index (OFR FSI, KCFSI, STLFSI, Cleveland Fed FSI) publishes a per-member persistence
 *  horizon. **Do not write, here or in a commit message, that 10/3/0 has literature support.**
 *  The rationale actually recorded:
 *   • `lead` — roughly two trading weeks, the span over which a leader's warning should still be
 *     standing when the coincident stress prints.
 *   • `coin` — just past `CONFIRM_CLOSES`, so a coincident read outlives the confirmation
 *     fold that already smooths it and nothing more.
 *   • `lag`  — a laggard never outlives itself; it reports damage already done.
 *
 *  ⛔ SANITY BOUND, pinned (not merely asserted here): every window must be **≤ `LOOKBACK` (20)** and
 *  **strictly < `MEMBER_HISTORY_WINDOW` (60)**. A hold at or above the fetched history depth lights a member
 *  PERMANENTLY, and the monotonicity invariant still passes in that state — a too-large window is
 *  one-sided-verifiable, so it needs its own bound. The bound is asserted over these values in
 *  `danger-ladder.test.ts`, derived from `LOOKBACK`/`MEMBER_HISTORY_WINDOW` themselves rather than typed.
 *  (Both live in modules that import THIS one — importing them back would close a cycle in an
 *  explicitly acyclic graph, so the assertion lives in the test, which can see both.)
 *
 *  ⚠ `0` and `1` denote the SAME window — the member's own close alone. The value counts closes the
 *  fire is VISIBLE for, and a fire is always visible on the close it prints. `0` is written for `lag`
 *  because it reads as "no hold", and `signalHoldClosesFor(m) === 0` is exactly the pre-Stage-2.1 behaviour
 *  (identity), which `danger-engine.growth-hold.test.ts` pins. @internal */
export const SIGNAL_HOLD_CLOSES: Record<TimingClass, number> = { lead: 10, coin: 3, lag: 0 };

/** The hold window for ONE member — the single lookup every consumer uses, so `SIGNAL_HOLD_CLOSES` stays the
 *  one touch point. An UNCLASSED member resolves to `0` (no hold, identity): the same fail-toward-the
 *  -pre-existing-behaviour direction the rest of this file takes for a missing table entry, and NOT a
 *  claim that no such member exists. Completeness of `TIMING_CLASS` is not compiler-checkable here
 *  (see that table's own note); the runtime union pin in `danger-ladder.test.ts` is the guard. */
export function signalHoldClosesFor(memberId: string): number {
  const cls = TIMING_CLASS[memberId];
  return cls === undefined ? 0 : SIGNAL_HOLD_CLOSES[cls];
}

/** Per-FAMILY × leg importance weight ∈ [0,1] — the SECOND, orthogonal weight axis (2026-07-14).
 *  Distinct from `MEMBER_WEIGHT`:
 *   • `MEMBER_WEIGHT` = cross-leg member weight inside a family's share (Σ w·sev / Σ w — carries the haven tilt;
 *     `uT` × min(1, full Σ w), `trendShare`).
 *   • `FAMILY_LEG_WEIGHT` = WITHIN-leg RELATIVE family importance (which family drives THIS leg most),
 *     column-normalized so each leg's top LIVE family = 1.0. Enters only as the family weight of the
 *     pillar mean (`pillarShare`, `danger-share.ts`), never multiplied into a family share — the two
 *     axes stay disjoint so the same leg-sensitivity is never double-counted.
 *  A family with no observed weighted member on a leg leaves BOTH sums of the pillar mean
 *  (`MEMBER_WEIGHT`'s §THE TWO EXCLUSION RULES above carries the rule); an observed family with no
 *  listed weight is a HARD ERROR (`pillarShare`/`familyLegWeight` throw — no silent `?? 1` default).
 *
 *  ⚠ Inner key = the `LADDER` union, `Partial` (rows are sparse by design). Same rationale as
 *  `MEMBER_WEIGHT`'s note above — see it, not this line.
 *
 *  ⚠ The OUTER key is `Record<Exclude<SignalKey, "gp">, …>` — TOTAL over every family except `gp`,
 *  whose row was deleted 2026-08-02 (see the ⛔ note at the foot of the table).
 *  The compiler enforces BOTH halves of the rule for free: every reader-family row is REQUIRED, and
 *  a restored `gp` row is an excess-property error at this literal. Widening the exemption means
 *  widening this type — there is no test-side pin to forget, and none needed.
 *
 *  📜 PROVENANCE — the per-row constraint that binds a retune, plus the 2026-07-15 research sources,
 *  live in `docs/member-weight-provenance.md`, sections `§FLW.<family>`. Read that section before
 *  retuning a cell; write the superseding constraint back into it (deleting what it replaces), never
 *  into this table, and its rationale into the commit message (`.claude/rules/doc-writing.md`). */
export const FAMILY_LEG_WEIGHT: Record<
  Exclude<SignalKey, "gp">,
  Readonly<Partial<Record<LegKey, number>>>
> = {
  // ⚠ A DEMOTION IS A COUPLED EDIT. `danger-ladder.test.ts` ("keeps each leg's column normalized — the
  // top live-in-mean family is exactly 1.0") reds if a row's cell drops without another row taking the
  // 1.0 on that leg. Enumerate the leg's live-in-mean rows (cr/rt/vl/xa) before demoting one.
  // Row narrative + research sources → provenance doc §FLW — table-wide, §FLW.cr.
  // ⚠ `Health` and `Staples` LEAD ON DIFFERENT FAMILIES (Health on `cr`, Staples on `rt`) — that swap is
  // the ONLY thing that differentiates the two defensive legs' danger, and it is a PAIRED edit across
  // this row and `rt` below: re-equalising either pair re-ties them exactly. Every `MEMBER_WEIGHT`
  // asymmetry between the two measured inert on the 2026-08-20 closes (R6 / FXH·DISP held the max) — do NOT reach for one.
  // Ruling + measured deltas → provenance doc §FLW.cr.
  cr: { Semis: 0.6, "S&P IT": 0.6, EM: 1.0, Value: 1.0, "S&P 500": 1.0, "ex-US": 1.0, "EU-Fin": 1.0, Health: 1.0, Staples: 0.85 },
  // Row narrative → provenance doc §FLW.rt (the `EU-Fin` demotion is the other half of `cr`'s coupled
  // edit above).
  rt: { Semis: 1.0, "S&P IT": 0.9, EM: 0.7, Value: 0.9, "S&P 500": 0.9, "ex-US": 0.8, "EU-Fin": 0.9, Health: 0.85, Staples: 1.0 },
  // vb LIVE since ECY seated (2026-08-11 E5): sole member, monthly, GT-gated ⇒ never a leg's top
  // family — every cell < 1.0 (cr/rt keep each leg's 1.0). Row narrative → provenance doc §FLW.vb.
  vb: { Semis: 0.6, "S&P IT": 0.6, EM: 0.4, Value: 0.3, "S&P 500": 0.6, "ex-US": 0.4, "EU-Fin": 0.3, Health: 0.4, Staples: 0.4 },
  // ⚠ `Staples` is a SEATED `vl` cell (mechanism seat, no falsifier on today's data) — read
  // `MEMBER_WEIGHT.R5`/`VT` and provenance doc §vl before retuning it.
  // Health/Staples split → `MEMBER_WEIGHT.vl`. Row narrative → provenance doc §FLW.vl.
  vl: { Semis: 1.0, "S&P IT": 1.0, EM: 0.8, "S&P 500": 0.7, "ex-US": 0.6, Value: 0.7, "EU-Fin": 0.6, Health: 0.4, Staples: 0.4 },
  // ⚠ ADDING A LEG HERE IS A COUPLED EDIT: it must land in the SAME commit as the matching
  // `MEMBER_WEIGHT` entries or `danger-ladder.test.ts`'s reach-coverage pin fails (the
  // stale-leg-reach bug class, now guarded). `Health`/`Staples` are SEATED (DISP/FXH mechanism
  // seats) — read `MEMBER_WEIGHT.FXH`/`DISP` and provenance doc §xa before retuning either cell.
  // Row narrative → provenance doc §FLW.xa.
  xa: { Semis: 0.6, "S&P IT": 0.5, EM: 1.0, Value: 1.0, "S&P 500": 0.4, "ex-US": 0.8, "EU-Fin": 0.4, Health: 0.5, Staples: 0.5 },
  // `uT` is OUT of the pillar means but NOT display-only: `legDangerShare` (`danger-share.ts`) takes its
  // `trendShare` × `trendGateFactor` as a `Math.max` term, so `uT` DOES move `LegRow.danger` (`gp` likewise, capped).
  // ⚠ TWO DIFFERENT CLAIMS — do not collapse them:
  //   • MECHANISM — TRUE. `uT` moves `LegRow.danger` through `legDangerShare`'s trend `Math.max`
  //     term without ever consulting this table, so an absent row key does NOT make the family inert on a
  //     leg, and adding one does NOT by itself turn anything on.
  //   • REACH-COVERAGE PIN — FALSE. `danger-ladder.test.ts` ("%s lists every leg its members reach")
  //     iterates EVERY family, `uT` included, and demands a cell for every leg any member reaches. So
  //     seating a `uT` member on a new leg still OWES a `FAMILY_LEG_WEIGHT.uT` entry in the SAME commit —
  //     the coupling is the pin's, not the mechanism's, and the suite goes red without it.
  // ⚠ DECLARING a cell here makes `computeLegGrowth`'s trend term LIVE on that leg (an absent cell
  // resolves `wsev` `null` and drops the term from both of its sums), so a seat here moves
  // `GROWTH_RS_WEIGHT`'s measured mean — see that constant's docblock in `src/growth.ts` and re-derive
  // it in the same commit. Row narrative → provenance doc §FLW.uT.
  uT: { Semis: 1.0, "S&P IT": 0.9, EM: 0.9, Value: 1.0, "S&P 500": 1.0, "ex-US": 1.0, "EU-Fin": 0.8, Health: 0.9, Staples: 0.9 },
  // ⛔ **NO `gp` ROW — DELETED 2026-08-02, DO NOT RESTORE**.
  // This table is the WITHIN-leg family importance axis of the pillar mean, read only by `pillarShare`
  // over `EARLY-WARN`/`STRESS-NOW` families and by `computeLegGrowth`'s `GROWTH_SIGNALS` — none admits `gp`.
  // So a `gp` row has NO READER; why the reach-coverage pin is not a reason to restore it → provenance doc §FLW.gp.
  // ⚠ **`uT` IS NOT THE SAME CASE — its row above stays, and stays reach-covered.** `uT` is also out of
  // the L2 danger mean, which is the ONLY thing the two families have in common. Unlike `gp` it HAS live
  // readers: `familyLegWeight("uT", sleeve)` is resolved by `computeLegGrowth` (`src/growth.ts`, whose
  // `GROWTH_RS_WEIGHT` docblock records the measured 0.944444 mean over exactly these nine cells), and
  // `src/run.alert-state.test.ts`'s held-sleeve push test turns on `FAMILY_LEG_WEIGHT.uT["EU-Fin"]` having raised
  // `EU-Fin`'s `LegRow.danger`. The exemption is grounded in READERSHIP, not in "out of the mean" — do
  // not generalise it to `uT`.
};

/** Per-FAMILY × leg pillar weight (`FAMILY_LEG_WEIGHT`) for a family relevant on `sleeve`; throws on `gp`
 *  (no row by design) or an unlisted cell — add its weight to `FAMILY_LEG_WEIGHT`. */
export function familyLegWeight(family: SignalKey, sleeve: string): number {
  const w = family === "gp" ? undefined : FAMILY_LEG_WEIGHT[family][sleeve as LegKey];
  if (w === undefined)
    throw new Error(`familyLegWeight: ${family}×${sleeve} has no FAMILY_LEG_WEIGHT entry - add its reach weight to FAMILY_LEG_WEIGHT.${family}.`);
  return w;
}

/** Per-leg danger sensitivity, seeded from the legacy all-RED C=J ceiling (max-normalised); pick/notify read `LEG_SENSITIVITY[leg] × danger`. */
export const LEG_SENSITIVITY: Readonly<Record<LegKey, number>> = {
  Semis: 1.0, "S&P IT": 1.0, EM: 0.86, "ex-US": 0.83, Value: 0.76, "EU-Fin": 0.72, "S&P 500": 0.59, Health: 0.32, Staples: 0.32,
};

/** Per-member × leg relevance mask, keyed by member id → set of relevant leg sleeves
 *  (design §10.4/§10.7). DERIVED from `MEMBER_WEIGHT`: a leg is relevant iff its weight > 0, so the
 *  table is the single source of truth (relevance is just its non-zero support). A family's cell is
 *  `na` on a leg iff NONE of its members are relevant. */
export const MEMBER_RELEVANCE: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries(MEMBER_WEIGHT).map(([id, row]) => [
    id,
    // STAND-IN AUDIT (OQ-5 Stage 3.1): OK — `MEMBER_WEIGHT` rows are the sole reach table, so a leg
    // missing from a row IS zero weight (relevance is just its non-zero support), never an
    // unobserved one.
    new Set(ALL_LEGS.filter((s) => (row[s as LegKey] ?? 0) > 0)),
  ]),
);

/** Short display label per member id — the human name shown in each signal cell's M/N drill-down
 *  tooltip (served on /api/danger-model so `lab.js`'s `decorateCell` renders it FE-side without a
 *  mirror). Also served as `memberLabel` on /api/danger-model and read by the feed-lag footnote
 *  (`public/feed-lag-foot.js`), which renders the raw feed id when a label is missing.
 *
 *  KEYED BY THE UNION of `MEMBER_WEIGHT`'s keys and the `FAMILY_MEMBERS` roster (widened 2026-08-02).
 *  It used to key off `MEMBER_WEIGHT` alone, which silently dropped every family member with no weight
 *  row — `T5YIFR`/`T10YIE` (gp siblings) always. Those ids are still scored, still fetched, and still
 *  reachable by the lag footnote, so a missing label paints a bare id as element text — forbidden by
 *  `public/leading-name.js` Rule 2 / Amendment C-b-1. Weightlessness is a LEG-REACH fact, never a
 *  display fact, so the label table must not inherit the weight table's key set.
 *
 *  DERIVED from `ALL_INDICATORS[].label` (2026-07-24 official-short-names plan, step 4): the
 *  registry's `label` IS the one official short name per indicator, so a hand-written second table
 *  here could only ever drift from it. The `?? id` arm is unreachable by construction and is pinned
 *  so in `danger-ladder.test.ts` ("every MEMBER_WEIGHT and TIMING_CLASS key resolves to a real ALL_INDICATORS id" plus the
 *  roster-coverage pin) — an unmatched key would ship a raw id into /api/meta and the /lab
 *  drill-down. */
export const MEMBER_LABEL: Record<string, string> = Object.fromEntries(
  [...new Set([...Object.keys(MEMBER_WEIGHT), ...Object.values(FAMILY_MEMBERS).flat()])].map((id) => [
    id,
    ALL_INDICATORS.find((i) => i.id === id)?.label ?? id,
  ]),
);

// --- #R2 concentration cap (design §2.5, i6 Task 2) ---------------------------------
/** Static correlated-leg clusters, keyed by `sleeve` (the one correlated pair today —
 *  Semis/S&P IT are both tech-growth despite region×sector NOT grouping them). Named
 *  `const` so a future cluster can be appended without touching the engine. This is the
 *  BASE cluster set, active while DISP is calm (GREEN); when DISP is AMBER/RED the engine
 *  swaps in `DISP_WIDE_CLUSTERS` (regions moving together ⇒ EM joins the "one bet").
 *  `CONC_THRESHOLD`/`CONC_WEIGHT` (danger-engine.ts) are untouched by that swap — only
 *  cluster MEMBERSHIP is state-conditional. Affects the held-leg pick only (`effDanger`),
 *  never `danger`/band/`targetRung`. */
export const CLUSTERS: readonly (readonly string[])[] = [["Semis", "S&P IT"]];

/** DISP-elevated concentration cluster (2026-07-22 disp redesign, Change 2): active ONLY
 *  while DISP's confirmed state is AMBER or RED. The three region proxies in the DISP basket
 *  (SPY·FEZ·EEM ⇒ sleeves Semis-adjacent US / S&P IT / EM) count as ONE bet when regions move
 *  together, so EM joins `[Semis, S&P IT]`. Widened to EM ONLY — over-widening (adding ex-US /
 *  S&P 500) would leave no diversifier for the held-pick to rotate toward, defeating the point.
 *  Base `CLUSTERS` applies when DISP is calm (GREEN) or its state is absent (fail-safe). */
export const DISP_WIDE_CLUSTERS: readonly (readonly string[])[] = [["Semis", "S&P IT", "EM"]];

// NOTE: `CONC_THRESHOLD` / `CONC_WEIGHT` / `DERISK_DEADBAND` / `RERISK_DEADBAND` used to live here.
// They moved to `danger-engine.ts` (2026-07-17) where they are now derived from `DANGER_CUTS`;
// deriving them here would invert the danger-engine→danger-ladder import edge into a cycle. No
// re-export shim — import them from `./danger-engine.js`.

/** Re-risk confirmation gate: consecutive IMPROVING closes required before the auto-held leg may step
 *  to a MORE-aggressive (lower risk-rank) sleeve.
 *
 *  **RETIRED to `1` — [USER] ruling 2026-08-07**. At 1 the gate
 *  is a TAUTOLOGY (`prevConfirmCount + 1 >= 1` on every close) and `decideRotationHold` no longer reads it, so
 *  re-risk commits on the first close exactly as de-risk does. The superseded grounds for the prior
 *  value 2 → `docs/member-weight-provenance.md` §RERISK_CONFIRM.
 *  Do NOT restore 2 from the old comment; the frozen historical set — this gate, the dwell,
 *  AND the dropped `improving` term — lives in `LEGACY_RERISK_GATES` below, reachable only through
 *  `decideRotationHold`'s probe override.
 *
 *  ⚠ **The streak COUNTER survives as bookkeeping, not as a gate.** `run-core.ts` still owns and persists
 *  `rerisk_confirm_count` on `alert_log`; `computeField` stays stateless. Nothing reads it today — it is
 *  retained for the re-arm case (§5's fallback ladder), so do not delete it as dead and do not describe
 *  it as a live operator control.
 *
 *  ⚠ **The counter advances per FIRED-DATE, not per close — INTENDED, ruled 2026-08-07, NOT a bug.**
 *  `getLastAlertBefore` keys on `fired_at`, so a manual re-run of an already-scored close
 *  (`scripts/smoke-cron.sh` / `vercel crons run`) sees the earlier row as `prevDay` and advances the
 *  streak, while `heldDays` correctly does not tick (`newClose = asOf > prevDay.date` is false). The
 *  asymmetry vs. `heldDays` is the point: dwell counts market CLOSES, the streak counts RUNS — which
 *  makes the streak pushable-forward by hand and the dwell not. A future audit re-finding this must read
 *  it as designed, not file it as a fired-date keying bug. If the re-arm in §5 wants that pushable
 *  property back, re-arm THIS constant, never `RERISK_DWELL_DAYS`. */
export const RERISK_CONFIRM = 1;

/** Asymmetric held-leg min-dwell: re-risk blocked until >= RERISK_DWELL_DAYS trading closes since the
 *  held leg last changed. Position-layer only — bands/dial stay fully live.
 *
 *  **RETIRED to `0` — [USER] ruling 2026-08-07**, the plan's
 *  "make re-risk as fast as de-risk". At 0 the gate is a TAUTOLOGY (`dwellNow >= 0` always) and
 *  `decideRotationHold` no longer reads it. The superseded grounds for the prior value 3 →
 *  `docs/member-weight-provenance.md` §RERISK_DWELL_DAYS — do not restore 3 from the archived
 *  reasoning. The
 *  frozen set (both timing gates + the dropped `improving` term) lives in `LEGACY_RERISK_GATES` below.
 *
 *  ⚠ **`held_days` keeps ticking and keeps persisting** — only its GATE is retired. It is the dwell
 *  ledger the FE renders and the input a re-arm would need. `run-core.ts` owns the counter (ticks once per new
 *  trading close, resets on any held-leg change).
 *
 *  ⚠ A dwell re-arm is NOT hand-pushable: `held_days` is `newClose`-gated by construction, so a manual
 *  cron re-run cannot pay it down (unlike `RERISK_CONFIRM`). §5's fallback ladder is `0 → 1` here — one
 *  close, not three — but pick by which property you want back. Accepted cost of the retirement: churn
 *  (an estimated ~5 rotations where the old gates gave 2 over 2026-07-17
 *  → 07-24). */
export const RERISK_DWELL_DAYS = 0;

/** **FROZEN historical values** — the M4/M5/M7/M8 re-risk commit terms as they stood 2026-07-15 →
 *  2026-08-07, before they were retired.
 *
 *  ⚠ **`requireImproving` is the THIRD term, added 2026-08-07 (review finding 2).** The old condition
 *  was `improving && trendOk && dwell && confirm`; `improving` left the CONDITION entirely (it survives
 *  only as the streak's accumulate/reset predicate), so a `{confirm, dwellDays}`-only seam could NOT
 *  reproduce the pre-ruling decision: `improving: false, trendOk: true, prevConfirmCount: 2,
 *  prevHeldDays: 3` HELD before the ruling and COMMITS under a timing-only replay, under-counting the
 *  legacy hold rate on exactly the stable-band re-orders §5's churn re-decision is about. The live
 *  default omits the key ⇒ `false` ⇒ the shipped path is byte-unchanged.
 *
 *  The literals here are legitimate and are NOT a single-touch-point violation: they are a historical
 *  RECORD, not a second copy of a live cut — nothing moves them when the live constants are retuned,
 *  which is exactly the point. **Nothing in `src/` or `api/` may read this except through `decideRotationHold`'s
 *  optional `gates` override** (probe seam, W5-e `drawdownGateFires` precedent); every production call
 *  site omits that argument, so the shipped path stays a single code path with no live toggle. */
export const LEGACY_RERISK_GATES = { confirm: 2, dwellDays: 3, requireImproving: true } as const;
