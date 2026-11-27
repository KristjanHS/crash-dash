/**
 * Pure leaf: the 6-family danger panel (T1). Reads cron-persisted confirmed `.state`
 * (directional fold: instant-up, 2-close stand-down since 2026-08-26), never re-scores.
 * Family membership is fixed HERE, not derived from registry `channel`.
 */
import type { State } from "./domain-types.js";
import { STATE_RANK } from "./domain-types.js";
import { distinctFactorCount } from "./geo-factor.js";
import type { AlertLevel } from "./ladder.js";
import type { R4Phase } from "./r4.js";
import type { T1DialResult } from "./t1dial.js";
import type { CashLevel } from "./cash-overlay.js";
import type { CoverageDegrade } from "./store.js";
import type { FieldResult } from "./danger-engine.js";
import type { FeedLagNote } from "./feed-lag.js";
import type { LastPrintTag } from "./last-print.js";
import type { SignalKey } from "./danger-ladder.js";
import type { ScoreboardView } from "./scoreboard.js";
import type { WalkLegStep } from "./run-core.js";

/** Re-export the family table from the dependency-free leaf `family-table.ts` (CORE-9 Stage D). */
import {
  CONFIRM_TIERS,
  DASHBOARD_FAMILIES,
  GLOBAL_FAMILIES,
  US_FAMILIES,
  confirmClosesFor,
  familyOf,
} from "./family-table.js";
import type { FamilyDef, FamilyKey } from "./family-table.js";
import { DOWNSIDE_DETECTOR_IDS, RS_LEG_OF } from "./registry-price.js";
export { CONFIRM_TIERS, DASHBOARD_FAMILIES, GLOBAL_FAMILIES, US_FAMILIES, confirmClosesFor, familyOf };
export type { FamilyDef, FamilyKey };

/** Display-only Dashboard card grouping, SEPARATE from the dial-driving panel tables — never feeds
 *  the dial, the Lab board, or `confirmClosesFor`. Adding an id to `US_FAMILIES`/`GLOBAL_FAMILIES`/
 *  `DIAL_FAMILIES` would move leg selection, surface it on Lab, and change its confirm-tier.
 *  `"pension-drawdown"` is deliberately NOT a dial `FamilyKey`, so it can never spread into a `*_FAMILIES` table. */
type CardGroupKey = FamilyKey | "pension-drawdown";

/** Card-ONLY memberships: ids that render as Dashboard cards but must NOT join any panel/dial fold.
 *  These ids stay out of `US_FAMILIES`/`GLOBAL_FAMILIES` entirely. */
export const CARD_ONLY_GROUPS: { key: CardGroupKey; label: string; ids: string[] }[] = [
  // ⚠ Not a promotion: absence from a family's `ids` is the whole point of an overlay row (`familyOf`
  // stays undefined; NVDA's `MEMBER_WEIGHT` row folds no cell). Overlay and seat are EXCLUSIVE. ONE row per key — a
  // `find(g => g.key === …)` consumer must see every card-only id of that key.
  { key: "volatility", label: "Volatility", ids: ["VIX", "VIX3M"] },
  // VTP: the VIX backwardation STREAK is CHART-ONLY (`CHART_ONLY_INDICATORS`) — DISPLAY-ONLY, resolves
  // the card's `meta.family` without seating VTP (`familyOf("VTP")` stays undefined, no weight/leg/tier).
  // VXNCLS + VXNT (VXN term structure on VT's cuts) + VXSMH ride the same row: chart-only, display-only, unseated.
  { key: "volatility", label: "Volatility", ids: ["VTP", "VXNCLS", "VXNT", "VXSMH"] },
  // The DB_* downside detectors, each followed by its EW rel-strength sibling (RS_SMH/RS_XLK,
  // 2026-08-15) — DERIVED from the registry (CORE-9 severed the cycle that once forced a literal);
  // card grouping only (like every row here); no panel family, no weight, no confirm tier.
  // NVDA: F4's semis Red-gate partner — the card lets `COMBO_GROUPS` (app.js) box it beside F4.
  { key: "trend", label: "Trend & breadth", ids: ["NVDA", ...DOWNSIDE_DETECTOR_IDS.flatMap((id) => [id, RS_LEG_OF[id]!])] },
  { key: "valuation", label: "Valuation", ids: ["F7"] },
  // NG Henry Hub natgas (2026-09-22): scored CONTEXT id with no family/weight — a card-only row so it
  // draws a Dashboard card (else "registered but undrawn", families.test.ts). Display-only, off the dial.
  { key: "geopolitics", label: "Geopolitics", ids: ["NG"] },
  // ECISS ECB composite CISS + EURGBP sterling: CONTEXT, rowless (eufin top5 Q4, seat 10) — card-only, off the dial.
  { key: "cross-asset", label: "Euro systemic stress", ids: ["ECISS", "EURGBP"] },
  // BONOS Bonos−Bund spread: card-only by ruling [USER] 2026-09-30 — unseated from the credit family + `MEMBER_WEIGHT`
  // (a coincident sovereign spread with no forecasting value on any leg; provenance §BONOS). Card + chart stay.
  // KBE (US bank close, unscored drawdown): card-only, credit by shape (bank-capital stress like AT1). CCC LEFT
  // 2026-10-12 for the credit seat — seat and overlay are exclusive.
  // BBB OAS (value-only CONTEXT, semis drawdown-watch confirmer): card-only, off the dial.
  { key: "credit", label: "Credit", ids: ["BONOS", "KBE", "BBB"] },
  // HCX + FDX (AVGO idiosyncratic legs) — chart-only price-derived legs. A SEPARATE `trend` row (not
  // merged into the pinned downside row above); neither seats a panel family (`familyOf` undefined).
  // MU_RS (Micron vs SMH, 2026-09-29): display-only CONTEXT — card-only, no family/weight.
  { key: "trend", label: "AI capex leads", ids: ["HCX", "FDX", "MU_RS"] },
  // T10Y3M_RAW daily US 10y−3m (2026-10-18): CHART-ONLY (`CHART_ONLY_INDICATORS`) — no family/weight.
  // EPATH euro policy path + HICP Δ6m (its R4 gate's inflation half): CONTEXT, rowless (estr-hike-side-leg R3/R5) — card-only, off the dial.
  { key: "rates", label: "Rates & curve", ids: ["EPATH", "HICP", "T10Y3M_RAW"] },
  // JPT (TOPIX 1306.T vs MA200, 2026-09-29): display-only CONTEXT — card-only, no family/weight.
  { key: "trend", label: "Regional trend", ids: ["JPT"] },

  // The comparator sleeves ride the same card group as the held legs, as unweighted rows.
  // Card grouping only; no panel family, weight, or confirm tier.
  {
    key: "pension-drawdown",
    label: "ETFs",
    // Every ladder leg's `legCloseId` but `LEGP_VALUE` (Value charts `XDEV`) + `LEGP_COMMOD`/`LEGP_RAFI` (off-ladder) are
    // the `LEGP_*` detail rows seated on a card surface; scoreboard.ts's "zero hits" falsifier excepts the `LEGP_` prefix here.
    // Order = the leg picker's: the nine legs in `LADDER` rung order (Value at its rung as `XDEV`), then the off-ladder
    // legs, then the non-leg comparators. A literal (families → scoreboard would cycle); pinned by families.test.ts.
    ids: [
      "LEGP_SEMIS", "LEGP_SPIT", "LEGP_EM", "XDEV", "LEGP_SPX", "LEGP_EXUS", "LEGP_EUFIN", "LEGP_HEALTH", "LEGP_STAPLES",
      "LEGP_COMMOD", "LEGP_RAFI",
      "SPY", "DEXUSEU", "SP500IT", "VWO", "VGK",
    ],
  },
];

/** Card grouping = panel family first, then the display overlay. Callers: `/api/indicators` (each
 *  card's `meta.family`) and `notify_format.ts` (`CARDLESS_CONTEXT_IDS`). NEVER call from the
 *  dial/Lab/confirm paths. */
export function cardGroupOf(id: string): CardGroupKey | undefined {
  // STAND-IN AUDIT (OQ-5 Stage 3.1): OK — an alternate LOOKUP, not a default: `undefined` still
  // propagates when neither table knows the id, so absence survives the expression.
  return familyOf(id) ?? CARD_ONLY_GROUPS.find((g) => g.ids.includes(id))?.key;
}

/** The ONE canonical `FamilyKey ↔ SignalKey` bijection. Every cross-vocabulary derivation reads THIS
 *  map instead of re-encoding the pairing (danger-ladder.ts's `FAMILY_MEMBERS` derives through it). */
export const SIGNAL_OF: Record<FamilyKey, SignalKey> = {
  credit: "cr",
  rates: "rt",
  valuation: "vb",
  volatility: "vl",
  "cross-asset": "xa",
  trend: "uT",
  geopolitics: "gp",
};

/** Inverse of `SIGNAL_OF` — `SignalKey` → `FamilyKey`. */
export const FAMILY_OF_SIGNAL: Record<SignalKey, FamilyKey> = Object.fromEntries(
  Object.entries(SIGNAL_OF).map(([f, s]) => [s, f]),
) as Record<SignalKey, FamilyKey>;

/** The 9-leg total-risk ladder, most-aggressive (rung 1) → most-defensive (rung 9). */
export const LADDER = [
  "Semis",
  "S&P IT",
  "EM",
  "Value",
  "S&P 500",
  "ex-US",
  "EU-Fin",
  "Health",
  "Staples",
] as const;

/**
 * Reader-facing sleeve names — overrides only; a sleeve absent here renders as its `LADDER` key.
 * DISPLAY ONLY: the key (`"EU-Fin"`) stays the identifier on every table, the wire, `/lab` params and
 * `alert_log.held_sleeve`; only rendered text (the push body/title) routes through `sleeveLabel`.
 * Mirrored by `public/sleeve-label.js` (a browser module can't import `src/`) and pinned equal by
 * `public/picker-groups.test.js`.
 */
export const SLEEVE_LABEL: Readonly<Partial<Record<(typeof LADDER)[number], string>>> = {
  Semis: "Semis SEC0",
  "S&P IT": "S&P IT QDVE",
  EM: "EM IS3N",
  Value: "Value XDEV",
  "S&P 500": "S&P 500 SXR8",
  "ex-US": "ex-US CHSI",
  "EU-Fin": "EU-Fin EXSH",
  Health: "Health QDVG",
  Staples: "Staples ZPDS",
};

/** The rendered name of a sleeve key — the key itself unless `SLEEVE_LABEL` overrides it. */
export function sleeveLabel(sleeve: string): string {
  return Object.hasOwn(SLEEVE_LABEL, sleeve) ? SLEEVE_LABEL[sleeve as (typeof LADDER)[number]]! : sleeve;
}

/**
 * The held sleeve's 1-based ladder RUNG (`LADDER` index + 1), or `null` when the string is not a
 * current ladder member. ⚠ **The ONLY executable sleeve→rung conversion in `src/`+`api/`** — never
 * re-inline one. ⚠ `null`, never `0`: a 0 sentinel reads as a real rung in arithmetic; the callers
 * wanting the legacy sentinel spell `rungOfSleeve(s) ?? 0` AT the call site (`decideRotationHold`
 * guards `> 0`) — never weaken this function to return 0.
 *
 * Falsifier (the bare `LADDER.indexOf` spelling misses this function's own
 * `(LADDER as readonly string[]).indexOf` form — use this pattern):
 * `grep -rnE 'LADDER[^)]*\)?\.indexOf' src/ api/ scripts/ | grep -vE ':[0-9]+: *(\*|//|/\*)'`
 * ⇒ exactly ONE hit under `src/`+`api/`: `families.ts` inside this function's body. `scripts/` carries
 * five live re-inlines, outside the claim's scope — do not copy them into `src/`.
 */
export function rungOfSleeve(sleeve: string | null): number | null {
  if (sleeve === null) return null;
  const i = (LADDER as readonly string[]).indexOf(sleeve);
  return i < 0 ? null : i + 1;
}

/**
 * Map a persisted sleeve NAME forward across the rung-7 rename: rows written before it carry
 * `"High-Div"` where the ladder now reads `"EU-Fin"`. Any other string passes through unchanged.
 * Applied at exactly ONE site — the `ALERT_COLS.heldSleeve` row mapper (`rowToAlert`, store.ts).
 */
export function canonicalSleeve(s: string): string {
  return s === "High-Div" ? "EU-Fin" : s;
}

export type FamilyRegime = "Calm" | "Caution" | "Stress" | "Crisis";

/** Graded danger contribution per family state — equal-weight, amber a half-step. */
const CONTRIBUTION: Record<State, number> = { GREEN: 0, AMBER: 0.5, RED: 1 };

export interface FamilyPanel {
  key: FamilyKey;
  label: string;
  /** worst confirmed state among present members; null when none present this
   *  run (stub, or a live family whose feeds all dropped). */
  state: State | null;
  /** counts toward the danger-score denominator (has ≥1 present member). */
  live: boolean;
  /** live AND amber-or-worse — contributes to the "K of N firing" headline. */
  firing: boolean;
  /** 0 / 0.5 / 1 for a live family, null for an excluded (non-live) one. */
  contribution: number | null;
  /** `label` = registry short name (defaults to member `id`; the ONLY source of the board-tooltip
   *  short name). `longLabel` = descriptive long name (absent when unsupplied). `factor` = registry
   *  `geoFactor`, so `diffusionLabel` counts DISTINCT FACTORS not rows (R2: gp's G1/BRENT/OVX are one
   *  oil factor); absent ⇒ the member counts as its OWN factor (`distinctFactorCount`, geo-factor.ts).
   *  All carried from the caller (no registry import here): live path rides the reading rows, scenario threads maps. */
  members: { id: string; label: string; state: State; longLabel?: string; factor?: string; /** the member's OWN folded obs_date (serve-time) — how stale this cell is. */ obs?: string; /** serve-time only (api/lab.ts): non-null when the served point is mid stand-down (raw ≠ confirmed); `of` = stand-down buffer. */ fold?: { raw: State; of: number } | null; /** serve-time only (api/lab.ts, B5): the served point is an INTRADAY row — the chip is labelled, never band-lagged. */ provisional?: true; /** serve-time only (api/lab.ts, L3/E3): the served row carries the stored `estimated` marker (a proxy nowcast) — the chip reads `EST`. */ estimated?: true; /** serve-time only (api/lab.ts, E22): the chip tooltip reads `last print D-n` (`lastPrintTag`). */ lastPrint?: LastPrintTag }[];
  /** `FamilyDef.ids.length − members.length` — roster members that did NOT report this run ("dark").
   *  0 on a fully-reporting family and a feedless stub. Load-bearing via `coverageDegraded` → the
   *  coverage floor (R5); the dark id SET rides `absentIds`. */
  absent: number;
  /** The dark ids behind `absent`, in roster order. OPTIONAL (≈18 files construct `FamilyPanel`
   *  literals) but ALWAYS emitted by the three producers; totality pinned by `families.test.ts`. */
  absentIds?: string[];
  /** R5 — this family's verdict is HELD (or tied) by data that is not live (a present roster member
   *  past its `lagCutFor` at the worst-of, or a coverage-roster member absent). A claim about SIGHT,
   *  not danger: moves nothing, only arms the WATCH-capped coverage floor. Coverage roster =
   *  `FamilyDef.ids`, EXCEPT `trend` → `COINCIDENT_TREND_MEMBERS` (B2). OPTIONAL; `undefined` ⇒
   *  `false` — fail toward NOT arming. */
  coverageDegraded?: boolean;
  /** live BUT every present member arrived via the absent-member carry (`carried` reading flag) —
   *  `applyFamilyCarry` folds it worse-of last-known, never exempts it. OPTIONAL, `undefined` ⇒ false. */
  carriedOnly?: boolean;
  /** B4 — PRESENT coverage-roster members past their `lagCutFor` AND at the restricted worst-of: the
   *  ids holding `coverageDegraded`'s lag clause. OPTIONAL, ALWAYS emitted by the three producers;
   *  `[]` on both synthetic producers (scenario carries no lag input; a CARRIED family has no present
   *  members). Consumers read `undefined` as "no lagging holders" — fail toward NOT arming. */
  verdictHoldIds?: string[];
  /** Stage-1 seam: the family's BAND role — mirrors its own state/firing/contribution + full ids. */
  band?: { state: State | null; firing: boolean; contribution: number | null; ids: readonly string[] };
  /** D2 — present members amber-or-worse but NOT in `band.ids` (cannot arm the band): count + worst
   *  severity + how many sit AT that severity (the number the tile mark and push print: reds when
   *  any, else ambers — [USER] 2026-09-27). ABSENT when none — every family outside BAND_DRIVING. */
  cannotArm?: { count: number; worst: State; worstCount: number };
  /** Serve-time (option C): member ids whose SERVED row disagrees with the state this panel folded.
   *  The cell serves that row; the run's band is unchanged and recomputes next run. */
  bandLagIds?: string[];
  note?: string;
  desc?: string;
  /** carried through from FamilyDef so /lab renders the stub's reason instead of the generic
   *  "no live feed" empty state. Absent on every live family. */
  awaiting?: string;
}

/** The ONLY trend members whose depth the DIAL's `coincidentP` band-lever may read (§3) — the broad,
 *  slow, coincident global regime. The fast proxies (F4/F5/F6) add no `coincidentP` DEPTH — they still
 *  fire trend's band role (`BAND_DRIVING.trend`) and so reach `fired`/shockFloor; depth only is restricted. */
export const COINCIDENT_TREND_MEMBERS: readonly string[] = ["GT", "GB"];

/** [USER] 2026-09-24 (+AT1; EXSH_GATE took the EXSH rel-strength seat 2026-10-06; +INS_RS 2026-10-08;
 *  +CCC 2026-10-12): per-leg only — their EU-Fin MEMBER_WEIGHT cells score, but
 *  they never move the dial: off their family's `BAND_DRIVING` roster and skipped by the dial's `legP` (t1dial.ts). */
export const PER_LEG_ONLY_MEMBERS: readonly string[] = ["KBE_RS", "EXSH_GATE", "INS_RS", "AT1", "CCC"];

/** R1 — each band-restricted family's BAND-driving members plus its optional stale-bridge id. Every
 *  OTHER member keeps its per-leg role and loses only the band seat. Single touch point: the exported
 *  rosters/bridges below DERIVE from this table, never restate it. */
const BAND_DRIVING: Partial<
  Record<
    FamilyKey,
    {
      members: readonly string[];
      bridge?: { bridge: string; bridged: string };
      /** id → the WORST state it may contribute to the band role. A capped member still folds its
       *  own uncapped state into the family verdict, the danger ledger and its per-leg cells — the
       *  clamp is a BAND-only ceiling. Dropped on the substitution path (see `bandIdsFor`). */
      capped?: Readonly<Record<string, State>>;
    }
  >
> = {
  // CQS rides the band EVERY day since 2026-08-20 (U2) — daily where EBP is monthly. Capped at AMBER
  // (its RED is not a stress alarm): the band analogue of the ledger's never-solo-RED ceiling.
  credit: {
    members: ["F1", "EBP", "CQS", "F3", "F2"],
    bridge: { bridge: "CQS", bridged: "EBP" },
    capped: { CQS: "AMBER" },
  },
  rates: { members: ["R1", "R2", "R3", "R4"], bridge: { bridge: "R8", bridged: "R1" } },
  // S6.3 ([USER] 2026-09-24 A): the GLOBAL trend roster minus PER_LEG_ONLY_MEMBERS.
  trend: { members: GLOBAL_FAMILIES.find((f) => f.key === "trend")!.ids.filter((id) => !PER_LEG_ONLY_MEMBERS.includes(id)) },
};

/** R3 — CQS is EBP's same-day Baa−Aaa nowcast bridge; R8 is R1's smoothed NTFS spine. Each is
 *  band-driving ONLY while its bridged curve is not speaking, never both on the band the same day. */
export const BAND_DRIVING_CREDIT_MEMBERS: readonly string[] = BAND_DRIVING.credit!.members;
export const CREDIT_BRIDGE = BAND_DRIVING.credit!.bridge!;
export const BAND_DRIVING_RATES_MEMBERS: readonly string[] = BAND_DRIVING.rates!.members;
export const RATES_BRIDGE = BAND_DRIVING.rates!.bridge!;
/** The band-RESTRICTED family keys — every other family's `band.ids` is its full roster. */
export const BAND_RESTRICTED_KEYS: readonly FamilyKey[] = Object.keys(BAND_DRIVING) as FamilyKey[];

/**
 * The ids driving a family's BAND role — `FamilyDef.ids` for every family absent from `BAND_DRIVING`;
 * otherwise that family's restricted set with its bridge id substituted for the bridged one when the
 * bridged curve is dark. `speaking(bridged)` is the caller's per-family freshness predicate.
 */
function bandIdsFor(
  f: FamilyDef,
  speaking: (bridged: string) => boolean,
): { ids: readonly string[]; capped: Readonly<Record<string, State>> } {
  const cfg = BAND_DRIVING[f.key];
  if (cfg === undefined) return { ids: f.ids, capped: {} };
  const seated = cfg.members.filter((id) => f.ids.includes(id));
  const capped = cfg.capped ?? {};
  if (cfg.bridge === undefined) return { ids: seated, capped };
  const { bridge, bridged } = cfg.bridge;
  if (speaking(bridged) || !f.ids.includes(bridge)) return { ids: seated, capped };
  // SUBSTITUTION path — the bridged curve is dark, so the bridge STANDS IN with full voice: its cap is
  // dropped (U2). The `filter` dedupes a bridge that is ALSO a seated member (CQS since 2026-08-20).
  const substituted = seated.filter((id) => id !== bridge).map((id) => (id === bridged ? bridge : id));
  const { [bridge]: _dropped, ...rest } = capped;
  return { ids: substituted, capped: rest };
}

/** The band role's own worst-of over the seated ids. A band set with no present member yields
 *  `null`/`false` — "no band-driving members" ⇒ never arms (calm-ward). */
function bandRoleOf(
  members: FamilyPanel["members"],
  { ids, capped }: { ids: readonly string[]; capped: Readonly<Record<string, State>> },
): NonNullable<FamilyPanel["band"]> {
  // A capped member folds its CLAMPED state here and ONLY here — `FamilyPanel.members` keeps the true
  // state, so the family verdict, the /lab tile and the danger ledger are unmoved.
  const seated = members.map((m) => {
    const cap = capped[m.id];
    return cap !== undefined && STATE_RANK[m.state] > STATE_RANK[cap] ? { ...m, state: cap } : m;
  }).filter((m) => ids.includes(m.id));
  const state: State | null = seated.length
    ? seated.reduce<State>((worst, m) => (STATE_RANK[m.state] > STATE_RANK[worst] ? m.state : worst), seated[0]!.state)
    : null;
  return { state, firing: state !== null && state !== "GREEN", contribution: state === null ? null : CONTRIBUTION[state], ids };
}

/** D2 — present members amber-or-worse that `band.ids` does not seat (cannot arm). `undefined` when
 *  none, so every family outside BAND_DRIVING (band.ids = full roster) omits the field by construction.
 *  `PER_LEG_ONLY_MEMBERS` never count ([USER] 2026-09-24): the mark reads "deepens the dial", and they don't. */
function cannotArmMark(
  members: FamilyPanel["members"],
  bandIds: readonly string[],
): FamilyPanel["cannotArm"] {
  const excluded = members.filter(
    (m) => STATE_RANK[m.state] >= STATE_RANK.AMBER && !bandIds.includes(m.id) && !PER_LEG_ONLY_MEMBERS.includes(m.id),
  );
  if (excluded.length === 0) return undefined;
  const worst = excluded.reduce<State>((w, m) => (STATE_RANK[m.state] > STATE_RANK[w] ? m.state : w), excluded[0]!.state);
  return { count: excluded.length, worst, worstCount: excluded.filter((m) => m.state === worst).length };
}

/**
 * The member set a family's COVERAGE is judged over (R5/B2) — the family's BAND ids for every family
 * except `trend`, which restricts to its coincident GT/GB members (the same restricted set
 * `coincidentContribution` folds, §3). Judged over exactly the members whose non-liveness could
 * mislead the uniform band; `FamilyPanel.state` is deliberately NOT the `trend` comparison verdict
 * (it folds `band.ids` — the full roster only for families outside `BAND_RESTRICTED_KEYS`).
 */
function coverageRosterFor(f: FamilyDef, bandIds: readonly string[]): readonly string[] {
  return f.key === "trend" ? f.ids.filter((id) => COINCIDENT_TREND_MEMBERS.includes(id)) : bandIds;
}

/** Damping on the TREND family's `coincidentP` contribution — and ONLY there (the per-leg path is
 *  untouched), because GT/GB enter both the dial's band-depth lever and per-leg trend danger.
 *  Single touch point — never restate this number in a comment, fixture or doc; derive from the
 *  symbol. Re-run `npm run probe:top2` all three arms (undamped / shipped / half) before moving it. */
export const TREND_COINCIDENT_DAMPING = 0.75;

/** A coincident family's contribution to the DIAL's `coincidentP`: full worst-of `contribution`
 *  EXCEPT `trend`, restricted to GT/GB (§3) and damped by `TREND_COINCIDENT_DAMPING`. Null when
 *  neither GT nor GB is present (0 to the numerator; the family still counts in the live denominator).
 *  ⚠ ASSUMES the GLOBAL panel: GT/GB live only in `GLOBAL_FAMILIES`' trend — the dial must always
 *  reduce the GLOBAL panel (`dial-assembly.ts`), or this silently zeroes trend's band depth. */
export function coincidentContribution(f: FamilyPanel): number | null {
  if (f.key !== "trend") return f.contribution;
  const states = f.members.filter((m) => COINCIDENT_TREND_MEMBERS.includes(m.id)).map((m) => m.state);
  if (states.length === 0) return null;
  const worst: State = states.includes("RED") ? "RED" : states.includes("AMBER") ? "AMBER" : "GREEN";
  return CONTRIBUTION[worst] * TREND_COINCIDENT_DAMPING;
}

/**
 * The FORMATTER OF RECORD for a family's member-level diffusion count — one producer, so
 * `notify_format.ts` and `/lab` can never disagree. Pure, display-only: `1 red / 5 elevated of 6 (2 dark)`.
 *
 * - ⚠ Every number counts DISTINCT FACTORS, not members (R2): `gp`'s G1/BRENT/OVX are one oil factor.
 *   `factor ?? id` via `distinctFactorCount` — the SAME seam `alert-band.ts`'s `autoGeoBase` collapses
 *   the geo floor with, so floor and printed count cannot drift. Untagged ⇒ own factor.
 * - `red` = factors with ≥1 RED member; `elevated` = factors with ≥1 amber-or-worse member (the
 *   family's `firing` predicate). ⚠ `elevated >= red` ALWAYS (red set ⊂ elevated set); nested, never a sum.
 * - Denominator = distinct factors among present members. `(N dark)` renders `absent` (a ROSTER count,
 *   NOT collapsed), OMITTED when `absent === 0`.
 * - `members.length === 0` renders `no members reporting` (not `0/0 of 0`, which reads as measured
 *   calm) — reachable on the push via `applyFamilyCarry`.
 */
export function diffusionLabel(f: FamilyPanel): string {
  const dark = f.absent > 0 ? ` (${f.absent} dark)` : "";
  if (f.members.length === 0) return `no members reporting${dark}`;
  const factors = (ms: FamilyPanel["members"]): number => distinctFactorCount(ms, (m) => m.factor, (m) => m.id);
  const red = factors(f.members.filter((m) => m.state === "RED"));
  const elevated = factors(f.members.filter((m) => STATE_RANK[m.state] >= STATE_RANK.AMBER));
  return `${red} red / ${elevated} elevated of ${factors(f.members)}${dark}`;
}

interface FamilyPanelResult {
  families: FamilyPanel[];
  /** denominator = families with ≥1 present member (stubs + all-dropped families excluded). */
  liveFamilyCount: number;
  /** K = live families amber-or-worse — the board's "K of N firing" breadth. */
  firingCount: number;
  ladder: string[];
}

/** One /lab overlay, projected to display shape. VIEW-ONLY layers over the T1 dial output; values
 *  arrive pre-formatted as strings, the FE strip renders `fields` in order and never re-derives.
 *  `tone` is the overlay's OWN severity: "alert" = override active (R4 = in cash), "caution" =
 *  primed, "neutral" = off, "reentry" = laddering back IN (a DIRECTION, not a step between the two).
 *
 *  ⚠ **`OverlayView.fields[].label` values are LOOKUP KEYS** the FE matches by string equality
 *  (`R4_PHASE_FIELD_LABEL` → `overlay-strip.js`'s `r4Phase`) — a label with no parity-pinned constant
 *  renames silently. `"phase"` is pinned by `R4_PHASE_FIELD_LABEL`'s parity test in overlay-strip.test.js. */
export interface OverlayView {
  /** stable overlay key, mirroring the `overlays` record key (e.g. "r4") */
  id: string;
  /** short human label for the strip row */
  label: string;
  /** one-line summary — the overlay's headline state */
  headline: string;
  tone: "neutral" | "caution" | "alert" | "reentry";
  /** ordered display rows; values are already formatted for print */
  fields: { label: string; value: string }[];
  /** optional trailing rationale line (absent when the overlay has nothing to say) */
  note?: string;
  /** which /lab danger-ledger group the strip renders this overlay under. Assigned at the api/lab.ts
   *  `overlays` assembly point, not the resolver. Absent on a pre-grouping payload ⇒ FE renders ungrouped. */
  group?: "decision-now" | "decision-pending" | "not-wired";
}

/**
 * D3 wire shape: which OR-leg attributed one dual-axis indicator's confirmed state today, and which
 * AXIS it lives on. `leg` is kept a bare `string` to mirror `SeriesPointDTO.leg` on /series.
 * EXACTLY ONE of (`leg` + `axis`) or `declined` is present — a firing id that cannot be attributed
 * says WHY. See `attributeLeg` (src/lab-attribution.ts) for the per-reason semantics.
 */
/** The reason list is the VALUE; the type derives from it. `public/leg-attribution.js` renders one
 *  muted note per reason and its test imports this array — a hand-copied FE mirror would drift silently. */
export const LEG_ATTRIBUTION_DECLINED_REASONS = [
  "no-history",
  "mid-confirm",
  "recompute-disagreed",
] as const;

type LegAttributionDeclined = (typeof LEG_ATTRIBUTION_DECLINED_REASONS)[number];

export interface LegAttribution {
  id: string;
  leg?: string;
  axis?: "level" | "velocity";
  declined?: LegAttributionDeclined;
  /** The id's confirmation-buffer depth (`confirmClosesFor`), present ONLY on `mid-confirm`. Shipping
   *  the number keeps `CONFIRM_TIERS` a ONE-place edit — never restate the tier value here or in FE copy. */
  confirmCloses?: number;
}

/** One `/lab` per-leg growth-RS row: the relative-strength value the Y1 resolver ranked, surfaced per
 *  LADDER sleeve. `rs` is `null` (never `0`) when the leg has no defensible RS; see `LegRsResult.rs`. */
export interface GrowthRsLeg {
  sleeve: string;
  rs: number | null;
}

/** The escalator-floor ids, mirroring `alert-band.ts` `FloorSource` (pinned equal there by a
 *  compile-time assertion). Ordered most-severe-first, `coverage` LAST (loses `source` ties). */
export type LabFloorId = "credit" | "geo" | "r4" | "rate" | "ew" | "coverage";

/** One member row inside a BAND-column escalator floor. RAG members (credit/geo/rate/ew) carry
 *  `state` + `cappedState` (capped to the floor's reachable scale — rate/ew never render RED, §5).
 *  r4's phase-input rows carry `value`/`threshold`/`note` instead; their `state` is PROXIMITY to the
 *  gate (`r4ProximityTone`, alert-band.ts). Optional fields absent where they don't apply. */
export interface LabBandMember {
  id: string;
  label: string;
  /** the indicator's DESCRIPTIVE long name (`Indicator.longLabel`) — hover text beside `label`.
   *  Absent on SYNTHETIC rows (r4 enter-input, GEO manual-flag, EW fallback). */
  longLabel?: string;
  /** the signal's own confirmed RAG (RAG members); proximity-to-own-gate (r4 rows). */
  state: State;
  /** `state` capped to the floor's reachable scale (rate/ew: RED→AMBER); equals `state` on
   *  RED-capable floors (credit/geo/r4). */
  cappedState: State;
  /** r4 enter/exit rows only — the live input value and the gate threshold it is tested against
   *  (`null` when the input is unavailable this run). Absent on RAG members. */
  value?: number | null;
  threshold?: number | null;
  /** short human note — r4 rows (e.g. "rung ≥ 8 to enter") and ew rows on a half-met AND-gate
   *  pair (names the unmet condition, alert-band.ts); absent elsewhere. */
  note?: string;
}

/** One extra SERVER-TONED chip on a floor head — display text, hover copy, RAG tone. Generic: the FE
 *  renders what it is given and derives NO tone. `state` ABSENT = quiet/base outline (context, not GREEN). */
export interface LabFloorChip {
  label: string;
  /** the tone; ABSENT ⇒ quiet (no RAG colour) — never GREEN as a stand-in for "nothing measured". */
  state?: State;
  /** the hover copy: the chip's short label in full words. */
  title: string;
}

/** One escalator floor in the BAND column: its own computed band level, the cap it can reach,
 *  and its member rows. `id === LabBand.source` marks the single binding floor. */
export interface LabBandFloor {
  id: LabFloorId;
  /** this floor's OWN computed level (not the binding max) — the floor chip. */
  level: AlertLevel;
  /** the highest level this floor can ever reach (rate/ew: WATCH; geo: WARNING; credit/r4: CRITICAL)
   *  — drives the capped member-cell scale (§2 decision 5). */
  cap: AlertLevel;
  /** `r4` ONLY — the cash/haven breaker's live phase + display tone. Absent on every other floor. */
  phase?: R4Phase;
  phaseState?: State;
  /** extra server-toned chips after the phase chip, in order. `r4` ONLY: the fall-shape class +
   *  confidence, promoted while the breaker is OFF the ladder (`phase !== "equity"`). Absent/empty ⇒
   *  head byte-identical to before (the `equity` case and every other floor). */
  chips?: LabFloorChip[];
  /** `geo` ONLY (R9) — the floor's count in words: `geo base 4`. Composed SERVER-SIDE off the addends
   *  the escalator summed (`formatGeoBasisLead`, alert-band.ts), FE prints it verbatim. Carries NO
   *  threshold (cuts stay in the engine). The addends ride {@link basisDetail}; the two ship together. */
  basis?: string;
  /** the addend breakdown behind {@link basis} — the full `geo base 4 = 1 manual + 1 auto (OVX,
   *  BRENT) + 2 stage` sentence (`formatGeoBasis`). `geo` ONLY, present exactly when `basis` is. */
  basisDetail?: string;
  members: LabBandMember[];
}

/** LIVE-ONLY BAND drill-down riding `LabResponse.band` — the read-time recompute of the alert-band
 *  escalator floors, surfacing the chain dangerScore →(cut)→ regime →(floors)→ band + each floor's
 *  members. ABSENT on scenario/replay (the escalator engine runs only at push time). */
export interface LabBand {
  /** the pushed alert band = max of every floor over the lagged dial band. */
  level: AlertLevel;
  /** R6 — the PRE-FLOOR dial band (`regimeToBand(dial.notifyRegime)`), the thing `level` was
   *  escalated FROM. ⚠ NOT `chain.band` (the POST-floor band, equals `level`) — reading that makes the
   *  escalation invisible. INVARIANT (production): `ALERT_RANK[level] >= ALERT_RANK[dialBand]`. */
  dialBand: AlertLevel;
  /** the binding floor id, or `null` when every floor is OK (the band stands on the raw dial). */
  source: LabFloorId | null;
  /** the top-strip deduction: raw `dangerScore` → the dial's DISPLAY regime → final band. */
  chain: { dangerScore: number; regime: FamilyRegime; band: AlertLevel };
  /** every floor, most-severe-first (credit, r4, geo, rate, ew, coverage). */
  floors: LabBandFloor[];
}

export type LabResponse = FamilyPanelResult & {
  /** LIVE ONLY (L1): set iff the served verdict is the daytime `intraday_verdict` slot — fold, dial, floors and
   *  field are the intraday run's (`/status` serves the same slot); the push and every notify baseline still read the EOD row. */
  provisional?: true;
  /** view-only overlays keyed by overlay id. `vtp` (LIVE ONLY) is the CHART-ONLY VIX-backwardation
   *  streak — UNWEIGHTED, feeds no band/family/roll-up/notify; absent when a ^VIX/^VIX3M leg is down. */
  overlays: Record<string, OverlayView>;
  /** the §5 two-tier dial (L/K/band/rung + headline) over the same families. */
  t1dial: T1DialResult;
  /** the GLOBAL_FAMILIES panel members exposed individually (the panel `t1dial` aggregates over).
   *  Top-level `families` stays the US_FAMILIES panel that drives the board/veto. */
  globalFamilies: FamilyPanel[];
  /** the DIAL_FAMILIES panel members — the SAME fold the pushed alert body counts (`GLOBAL_FAMILIES`
   *  minus display-only SLOW legs), so /lab's diffusion count prints the notify axis' numbers. Bites
   *  `volatility` alone; every other family element-identical to `globalFamilies`. */
  dialFamilies: FamilyPanel[];
  /** D3/D4 — the served danger roster the browser cannot derive: `legWeightedIds` = `MEMBER_WEIGHT`
   *  keys + `perLegOnlyIds` = `PER_LEG_ONLY_MEMBERS` (chip tone), `noArmFamilies` = never-arm families (D4 tile),
   *  `pillarIds` = `PILLAR_MEMBER_IDS` (danger-engine.ts; a shown member outside it is dead-lit). */
  dangerRoster: { legWeightedIds: string[]; perLegOnlyIds: string[]; noArmFamilies: string[]; pillarIds: string[] };
  /** `computeField` over `globalFamilies`: `legRows[].subDangers` = the four share terms (earlyWarn/stressNow
   *  `PillarScore`, trend, gp) whose max is `danger`; `legRows[].momentum` set ONLY on `?hist=N`. */
  field: FieldResult;
  /** the signal-grid footnote (`◌` marks) payload: one entry per marked feed `lagTier`, with the
   *  label and the two numbers justifying it (`age` vs the feed's `p90Gap`). EMPTY when nothing is
   *  marked (the healthy state). DISPLAY ONLY: reaches neither band, pick, nor notify. */
  feedLag: FeedLagNote[];
  /** A4 — was there NO freshness stamp behind this payload's `observed` census? `true` = the
   *  `freshnessFrom` read threw (or no store), so every member reads `obs: "lag"` and `feedLag` is
   *  `[]` for want of a measurement, NOT because feeds are fine. DISPLAY/diagnostic only. */
  freshnessMissing: boolean;
  /** R5/R8 — the COVERAGE DEGRADES the served run recorded (`DegradeEvent.coverage`, store.ts): each
   *  family whose verdict rested on non-live data, with the members holding it. EMPTY when clean;
   *  scenario/replay always `[]`. DISPLAY ONLY: the coverage floor arms off the panel, not this list. */
  coverage: CoverageDegrade[];
  /** per-leg downside-break detector states (drawdown-from-high + MA50 gate over {SMH, XLK}).
   *  LIVE ONLY (needs fetched closes); computed+persisted in run-cycle-dial.ts, re-read by api/lab.ts.
   *  ⚠ This id union is HAND-MAINTAINED — widen it alongside any new `DOWNSIDE_DETECTORS` row and
   *  `openapi.yaml`'s enum (a missed widen fails the typecheck at api/lab.ts's assignment, not silently). */
  downsideDetectors?: { id: "SMH" | "XLK"; state: State }[];
  /** "live" = latest cron snapshot; "scenario" = hand-set states at t over the LIVE
   *  member history + held sleeve (same-states scenario ≡ live). */
  mode: "live" | "scenario";
  /** the verdict's data date (asOf). Live only — absent on the scenario path. */
  asOf?: string;
  /** the run id (AlertRecord.firedAt) whose readings this panel reduced. Live only. */
  firedAt?: string;
  /** the LATEST EOD run's failed cron prune (`PRUNE_DEGRADE_SCOPE` on its `degraded`): that run's `firedAt` + the error.
   *  LIVE ONLY; ABSENT on a clean prune. DISPLAY ONLY — never reaches band, pick or notify. */
  pruneFailed?: { firedAt: string; reason: string };
  /** the persisted band-reason (`alert-band.ts` BandReason: `regime` | `lag-hold` | `floor:<src>` |
   *  `no-dial`), read off the alert row so /lab explains the recorded divergence. LIVE ONLY (scenario
   *  shows the RAW dial band). `null` on a pre-migration row. */
  bandReason?: string | null;
  /** the LIVE-ONLY BAND-column drill-down: the escalator-floor recompute + deduction chain explaining
   *  the pushed band (`escalatorFloorBreakdown`, alert-band.ts). ABSENT on scenario/replay (escalators
   *  run only at push time). */
  band?: LabBand;
  /** W5-a — the PERSISTED Tier-1 cash overlay (`cash_overlay*` columns), read off the alert row.
   *  **Never re-derived on the read path** (the trigger is stateful). `level` is the OVERLAY's OWN
   *  magnitude, never `"full"` (that belongs to R4; §3's `resolveCash` is the single merge point) — a
   *  renderer must merge the two, never show two cash claims. LIVE ONLY; `reason`/`since` null on a
   *  pre-migration row. */
  cashOverlay?: { level: Exclude<CashLevel, "full">; since: string | null; reason: string | null };
  /** D3 — per-indicator level-vs-velocity attribution for the DUAL-AXIS ids (`DUAL_AXIS_IDS`,
   *  domain-legs.ts — the one canonical set, NOT enumerated here). One entry per dual-axis id confirmed
   *  non-GREEN this run whose read-time recompute reproduces the persisted state. R2/R3/R4 NEVER appear
   *  (velocity-only ⇒ tautological). LIVE ONLY; display-only (does NOT feed the band). */
  legAttribution?: LegAttribution[];
  /** scenario only: the parsed per-family overrides echoed back to the client. */
  states?: Partial<Record<FamilyKey, State>>;
  /** scenario only: the parsed per-MEMBER (single-indicator id) overrides echoed back, e.g.
   *  `?s=R5:RED`. Disjoint from `states` (a `?s=` segment resolves to one, family key first).
   *  `{}` when the string carried none. */
  members?: Partial<Record<string, State>>;
  /** scenario only: the reserved `?s=` knobs echoed back, always all four (defaults included) so the
   *  served shape is total. `lag` is an array in first-seen order. An ECHO, never a second input. */
  knobs?: { tail: boolean; sustained: boolean; daysInCash: number; lag: string[] };
  /** D9 live scoreboard: NAV-chain metrics + the two gate verdicts, computed pure at read over the
   *  persisted SB_STRAT/SB_BENCH rows + overrides + recent alerts. LIVE ONLY. Zero SB rows still
   *  attaches it (`warmingUp: true`, every metric `n/a`). */
  scoreboard?: ScoreboardView;
  /** G0 — the per-leg growth RS the Y1 resolver computed, one entry per LADDER sleeve, display-only.
   *  `rs` is `null` (never `0`) on a leg with no defensible RS. Feeds no band/field/pick. Present
   *  whenever a store was read; ABSENT on the unconfigured-env scenario path. */
  growthRs?: GrowthRsLeg[];
  /** G0 — how many of `Y1_LOOKBACKS` contributed to `growthRs` this read (0–3). Present/absent in
   *  lockstep with `growthRs`. */
  lookbacksUsed?: number;
  /** `/lab?walk=N` forward-walk leg path (day 1..N) — the read-only projection of prod's accumulated
   *  position walked N days forward with today's conditions frozen. Present ONLY when `walk>0`; the
   *  board fields then render day-N. Omitted at `walk=0` (byte-untouched). */
  walkPath?: WalkLegStep[];
};

/** The three ascending boundaries of a `FamilyRegime` cut table. Every boundary is STRICT (`<`), so a
 *  score landing exactly on a cut takes the HIGHER regime. */
type RegimeCuts = { caution: number; stress: number; crisis: number };

/** The DIAL/display quartile cuts over `dangerScore = (rung−1)/8` — a legibility layer, NOT a fitted
 *  parameter. The notify axis is SEPARATE (`NOTIFY_REGIME_CUTS`); these drive only the regime a human
 *  reads. Do NOT derive these from `SEV_CUTS`/`DANGER_CUTS` (danger-engine.ts — different scales). */
export const DIAL_REGIME_CUTS: Readonly<RegimeCuts> = Object.freeze({
  caution: 0.25,
  stress: 0.5,
  crisis: 0.75,
});

/** The one regime fold, parameterized by cut table — so two axes can differ in their CUTS but never
 *  in how those cuts are applied. */
function regimeForCuts(score: number, cuts: Readonly<RegimeCuts>): FamilyRegime {
  if (score < cuts.caution) return "Calm";
  if (score < cuts.stress) return "Caution";
  if (score < cuts.crisis) return "Stress";
  return "Crisis";
}

/** The DIAL/display regime. Exported so `t1dial.ts` maps its own dangerScore through the SAME
 *  quartile bands. Notify consumers want `notifyRegimeFor`. */
export function regimeFor(score: number): FamilyRegime {
  return regimeForCuts(score, DIAL_REGIME_CUTS);
}

/** The `dangerScore` a given ladder rung sits at — `(r − 1) / 8`. **The SINGLE source of the
 *  rung→score span**: both `dangerScore` (`t1dial.ts`) and `NOTIFY_REGIME_CUTS` derive through it, so
 *  a score and its cuts can never sit on different spans. Class falsifier:
 *  `grep -rn -- '- 1) / 8' src/ scripts/ api/ | grep -vE ':[0-9]+: *\*'` (comment lines excluded, so
 *  this line cannot certify itself) → exactly ONE hit (`rungCut`'s body). Do NOT re-inline a `/8`. */
export function rungCut(rung: number): number {
  return (rung - 1) / 8;
}

/** The NOTIFY cuts — the axis that decides which alert band gets pushed. Expressed as rung BOUNDARIES,
 *  not float quantiles, so they cannot drift off the rung grid. Do not "single-source" them back onto
 *  `DIAL_REGIME_CUTS` (the split lets them move without relabelling the dial).
 *  ⚠ Moving the `stress` rung obliges re-ruling `CREDIT_UNFIRED_FLOOR` (`t1dial.ts`) in the same
 *  change (raising Stress past rung 5 demotes the one-key credit escalator). */
export const NOTIFY_REGIME_CUTS: Readonly<RegimeCuts> = Object.freeze({
  caution: rungCut(3),
  stress: rungCut(5),
  crisis: rungCut(7),
});

/** The NOTIFY regime — what `computeAlertBandDetail` bands and `run-core.ts` persists. Equals `regimeFor`
 *  while the two cut sets coincide. */
export function notifyRegimeFor(score: number): FamilyRegime {
  return regimeForCuts(score, NOTIFY_REGIME_CUTS);
}

/**
 * Reduce already-scored per-family panels to the board's breadth summary: live-family denominator,
 * "K of N firing" count, ladder legs. NO magnitude/veto roll-up (the T1 dial is the sole danger read
 * on /lab). The seam both the live-readings and scenario-states paths funnel through.
 */
function finalizePanel(families: FamilyPanel[]): FamilyPanelResult {
  const liveFamilies = families.filter((f) => f.live);
  return {
    families,
    liveFamilyCount: liveFamilies.length,
    firingCount: liveFamilies.filter((f) => f.firing).length,
    ladder: [...LADDER],
  };
}

/**
 * Reduce a run's confirmed readings to the 6-family danger panel. `readings` is the run's `{id, state}`
 * rows (directionally folded at cron time). `lag` rides each row OPTIONALLY, resolved upstream through
 * the ONE lag cut (`lagCutFor`, ladder.ts — this file declares no threshold); `undefined` = NOT
 * ASSESSED, treated as not-lagging for arming (the conservative direction).
 */
export function computeFamilyPanel(
  readings: { id: string; label?: string; state: State; longLabel?: string; factor?: string; lag?: boolean; carried?: boolean }[],
  familyDefs: readonly FamilyDef[] = US_FAMILIES,
): FamilyPanelResult {
  const byId = new Map(readings.map((r) => [r.id, r]));

  const families: FamilyPanel[] = familyDefs.map((f) => {
    const members = f.ids
      .filter((id) => byId.has(id))
      // `longLabel`/`factor` ride through ONLY when the caller supplied them; keys omitted otherwise.
      .map((id) => {
        const r = byId.get(id)!;
        // `label` rides the reading row like `longLabel`; default to `id` when the caller supplied none.
        const label = r.label ?? id;
        const m: FamilyPanel["members"][number] = { id, label, state: r.state };
        if (r.longLabel !== undefined) m.longLabel = r.longLabel;
        if (r.factor !== undefined) m.factor = r.factor;
        return m;
      });
    const live = members.length > 0;
    // Roster members that did not report — unrecoverable downstream once `members` is filtered.
    const absentIds = f.ids.filter((id) => !byId.has(id));
    const absent = f.ids.length - members.length;
    // R3's per-family bridge input: SPEAKING iff the bridged curve is present and `lag !== true`;
    // `lag === undefined` (NOT ASSESSED) ⇒ speaking — never seat the nowcast on an unassessed run.
    const bridgeSpeaking = (bridged: string): boolean => {
      const r = byId.get(bridged);
      return r !== undefined && r.lag !== true;
    };
    const band = bandRoleOf(members, bandIdsFor(f, bridgeSpeaking));
    const roster = coverageRosterFor(f, band.ids);
    const rosterPresent = members.filter((m) => roster.includes(m.id));
    const rosterVerdict: State | null = rosterPresent.reduce<State | null>(
      (worst, m) => (worst === null || STATE_RANK[m.state] > STATE_RANK[worst] ? m.state : worst),
      null,
    );
    // B4: the lag clause's id SET, kept (not discarded) — consumers need the ids; one fold, one place.
    const verdictHoldIds = rosterPresent
      .filter((m) => byId.get(m.id)?.lag === true && m.state === rosterVerdict)
      .map((m) => m.id);
    // Carried-only: live but NO genuinely-present member (every id arrived via the `carried` carry) —
    // degrades coverage, and `applyFamilyCarry` no longer exempts it.
    const carriedOnly = live && members.every((m) => byId.get(m.id)?.carried === true);
    const coverageDegraded =
      live && (carriedOnly || absentIds.some((id) => roster.includes(id)) || verdictHoldIds.length > 0);
    // D1: the family's own state/firing/contribution ARE the band role (band-driving set), so a
    // member that cannot move the band no longer fires its family. `cannotArm` (D2) keeps that red visible.
    const cannotArm = cannotArmMark(members, band.ids);
    return { key: f.key, label: f.label, state: band.state, live, firing: band.firing, contribution: band.contribution, members, absent, absentIds, coverageDegraded, carriedOnly, verdictHoldIds, band, cannotArm, note: f.note, desc: f.desc, awaiting: f.awaiting };
  });

  return finalizePanel(families);
}

/**
 * Rank 7 (fail-toward-calm): max age in TRADING DAYS that a previously-firing family whose feed goes
 * non-live keeps its last-known firing state on the dial before it is dropped (caller then emits a
 * degrade event). Exported so tests pin the limit.
 */
export const CARRY_MAX_TRADING_DAYS = 5;

/** The last-known confirmed worst-of state of a family + the date it was last live — sourced by the
 *  CALLER from persisted readings, kept out of this pure leaf so `applyFamilyCarry` stays IO-free. */
export interface LastKnownFamily {
  state: State;
  /** YYYY-MM-DD observation date of the last-known state. */
  date: string;
}

interface FamilyCarryResult {
  /** the panel with carried families re-marked live+firing from last-known state. */
  panel: FamilyPanel[];
  /** families kept firing from last-known state this run (within the age limit). */
  carried: FamilyKey[];
  /** previously-firing families dropped past the age limit — caller emits a degrade event. */
  dropped: FamilyKey[];
}

/**
 * Count TRADING days (Mon–Fri; holidays IGNORED) strictly after `from` through `to`; 0 when
 * `to <= from`. Ignoring holidays only ever ages a dropped feed marginally FASTER (errs toward
 * dropping, never toward a phantom-firing family).
 */
export function tradingDaysBetween(from: string, to: string): number {
  const end = new Date(`${to}T00:00:00Z`);
  const d = new Date(`${from}T00:00:00Z`);
  let count = 0;
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

// Stage-2 band roster is band-driving; a silent `[]` = "no band-driving members" ⇒ never arms (calm-ward).
function requireBand(f: FamilyPanel): NonNullable<FamilyPanel["band"]> {
  if (f.band === undefined) throw new Error(`applyFamilyCarry(${f.key}): missing \`band\` - every producer emits \`band\``);
  return f.band;
}

/**
 * Rank 7 fail-toward-calm. A family whose feed dropped THIS run but was FIRING in its most-recent
 * persisted observation keeps that last-known state for up to `CARRY_MAX_TRADING_DAYS`; beyond the limit (or
 * if it wasn't firing) it stays excluded and is reported in `dropped`. Pure (caller passes the store
 * reads), so dial-assembly.ts and /lab share behavior. Only FULLY-dropped families are candidates.
 */
export function applyFamilyCarry(
  panel: FamilyPanel[],
  lastKnown: Partial<Record<FamilyKey, LastKnownFamily>>,
  asOf: string,
): FamilyCarryResult {
  const carried: FamilyKey[] = [];
  const dropped: FamilyKey[] = [];
  const out = panel.map((f) => {
    // A CARRIED-ONLY family (live but every present member arrived via the absent-member carry) is NOT
    // exempt; a genuinely-live one is — it already carries a real worst-of over present members.
    if (f.live && f.carriedOnly !== true) return f; // present this run — nothing to carry
    const lk = lastKnown[f.key];
    const lkFresh = lk !== undefined && lk.state !== "GREEN" && tradingDaysBetween(lk.date, asOf) <= CARRY_MAX_TRADING_DAYS;
    if (f.carriedOnly === true) {
      // D1: the family state IS the band role, so carry the BAND's own verdict as BOTH — worse-of
      // (band fold, fresh last-known); a per-leg-only member cannot re-enter through the carry.
      const bandFold = requireBand(f).state;
      const bandWorst: State | null =
        lkFresh && (bandFold === null || STATE_RANK[lk.state] > STATE_RANK[bandFold]) ? lk.state : bandFold;
      const bandRole = { state: bandWorst, firing: bandWorst !== null && bandWorst !== "GREEN", contribution: bandWorst === null ? null : CONTRIBUTION[bandWorst], ids: requireBand(f).ids };
      return { ...f, state: bandRole.state, firing: bandRole.firing, contribution: bandRole.contribution, coverageDegraded: true, band: bandRole };
    }
    // No history, or not firing last time ⇒ no calm-ward bias to correct; leave excluded silently.
    if (!lk || lk.state === "GREEN") return f;
    if (tradingDaysBetween(lk.date, asOf) > CARRY_MAX_TRADING_DAYS) {
      dropped.push(f.key); // aged out — stays excluded, caller degrades
      return f;
    }
    carried.push(f.key);
    // `coverageDegraded: true` UNCONDITIONALLY on the carried branch: zero members reported, so the
    // whole re-marked verdict is last-known data (the "not live" claim the coverage floor makes).
    // `verdictHoldIds: []` (B4): a carried family has no present member to name as a lagging holder.
    // Its band inherits the family-level last-known state; the seated ids ride through unchanged.
    return { ...f, state: lk.state, live: true, firing: true, contribution: CONTRIBUTION[lk.state], coverageDegraded: true, verdictHoldIds: [], band: { state: lk.state, firing: true, contribution: CONTRIBUTION[lk.state], ids: requireBand(f).ids } };
  });
  return { panel: out, carried, dropped };
}

/**
 * Scenario path: compute the panel from hand-set per-family states. Live families are ALWAYS present
 * (default GREEN, overridden by `states`) — anti-fake-calm. A FEEDLESS family (empty `ids`) is the one
 * absent-able family: present only when `states` gives it a state. No family is feedless today (ECY
 * seated `valuation`), so the branch has no instance; kept for a future feedless family.
 */
export function computeFamilyPanelFromStates(
  states: Partial<Record<FamilyKey, State>>,
  familyDefs: readonly FamilyDef[] = US_FAMILIES,
  memberStates: Partial<Record<string, State>> = {},
  // id → registry descriptive long name, supplied by the CALLER. Default `{}` ⇒ members omit
  // `longLabel`; the live path passes the same table (scenario↔live deep-equal, api/lab.test.ts).
  longLabelOf: Partial<Record<string, string>> = {},
  // id → registry short name (`Indicator.label`), threaded like `longLabelOf`. Default `{}` ⇒ `label`
  // falls back to `id`.
  labelOf: Partial<Record<string, string>> = {},
  // id → registry `geoFactor`, threaded like `labelOf`. Default `{}` ⇒ members omit `factor` and count
  // as their OWN factor in `diffusionLabel` (pre-R2 member-count behaviour).
  factorOf: Partial<Record<string, string>> = {},
): FamilyPanelResult {
  const families: FamilyPanel[] = familyDefs.map((f) => {
    const override = states[f.key];
    // A FEEDLESS family (empty ids, e.g. the unscored valuation family) is present only when explicitly
    // given a state; every fed / live family is always present.
    const feedlessStub = f.ids.length === 0;
    const present = feedlessStub ? override !== undefined : true;
    if (!present) {
      return {
        key: f.key,
        label: f.label,
        state: null,
        live: false,
        firing: false,
        contribution: null,
        members: [],
        // Only a FEEDLESS family (`ids: []`) reaches this branch, so this is 0 — written as the
        // general expression so it stays right if the absent-able rule ever widens.
        absent: f.ids.length,
        absentIds: [...f.ids],
        // The scenario path carries no lag input at all, so it can never CLAIM degraded
        // coverage — emitted explicitly (not omitted) so the field is total on this path too.
        coverageDegraded: false,
        carriedOnly: false,
        verdictHoldIds: [],
        // Only a FEEDLESS family (`ids: []`) reaches this branch, so the band set is empty too.
        band: { state: null, firing: false, contribution: null, ids: bandIdsFor(f, () => true).ids },
        note: f.note,
        desc: f.desc,
        awaiting: f.awaiting,
      };
    }
    // `base` seeds every member from the family-level state (default GREEN); a per-indicator override
    // (`memberStates`) wins for that one leg. Family state is worst-of the resolved members.
    // STAND-IN AUDIT (OQ-5 Stage 3.1): OK — a scenario-DSL default, not a measurement: this function's
    // input language IS "omitted ⇒ GREEN"; it synthesizes /lab + sim panels and never reads a live feed.
    const base: State = override ?? "GREEN";
    const members = f.ids.map((id) => {
      const state = memberStates[id] ?? base;
      const label = labelOf[id] ?? id;
      const longLabel = longLabelOf[id];
      const factor = factorOf[id];
      const m: FamilyPanel["members"][number] = { id, label, state };
      if (longLabel !== undefined) m.longLabel = longLabel;
      if (factor !== undefined) m.factor = factor;
      return m;
    });
    // D1: the family's state/firing/contribution ARE the band role (band-driving set) — a scenario
    // that reddens only a per-leg member no longer fires its family, exactly as the live path.
    const band = bandRoleOf(members, bandIdsFor(f, (bridged) => f.ids.includes(bridged)));
    const cannotArm = cannotArmMark(members, band.ids);
    // The scenario path synthesizes EVERY roster id, so nothing is dark (0 / []) and there is no lag
    // input ⇒ coverage is never degraded. Derived with the same expressions as the live path.
    const presentIds = new Set(members.map((m) => m.id));
    return { key: f.key, label: f.label, state: band.state, live: true, firing: band.firing, contribution: band.contribution, members, absent: f.ids.length - members.length, absentIds: f.ids.filter((id) => !presentIds.has(id)), coverageDegraded: false, carriedOnly: false, verdictHoldIds: [], band, cannotArm, note: f.note, desc: f.desc, awaiting: f.awaiting };
  });

  return finalizePanel(families);
}
