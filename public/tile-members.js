/**
 * Board-tile display seams (pure, no DOM) so vitest collects the logic while `tsc`
 * (no allowJs) ignores it — same seam idiom as format.js / ew-badge.js.
 * Every projection here is DISPLAY-ONLY and never touches danger math.
 * DB_SMH stays off tiles — its cell lives in the BAND `ew` row, band-panel.js.
 */

/** ⚠ HAND-COPIED MIRROR of `COINCIDENT_TREND_MEMBERS` (src/families.ts): the trend ids adding
 *  `coincidentP` depth. `tile-members.test.js` pins the two equal. */
export const DEPTH_TREND_IDS = new Set(["GT", "GB"]);

/** ⚠ HAND-COPIED MIRROR of `SLOW_INDICATOR_IDS` (src/registry.ts) — same pin discipline. */
export const SLOW_VOLATILITY_IDS = new Set([
  "price-accel",
  "complacency-vix",
  "complacency-high",
  "complacency-duration",
]);

/** The weighted `valuation` member — the family's ONLY MEMBER_WEIGHT row. STATIC (no bridge), so a
 *  plain constant like volatility's, NOT the served `f.band.ids` trend/credit/rates read. The two
 *  inflation breakevens (T5YIFR/T10YIE) fall through to the CONTEXT group: rowless + dial-inert. */
export const WEIGHTED_VALUATION_IDS = new Set(["ECY"]);

/** Shared by the credit/rates/volatility tiles: in each, the group also carries per-leg danger. */
const BAND_DRIVING_GROUP = {
  key: "band",
  label: "band-driving",
  title: "These members also set the dial's uniform band depth - the whole notify band moves with them.",
};

/** Shared by trend (its whole off-band remainder) and credit/rates (the served `perLegOnlyIds` —
 *  `PER_LEG_ONLY_MEMBERS`, families.ts): these members are out of `legP` too, so they never move the
 *  dial. Credit/rates must section them off AHEAD of `PER_LEG_GROUP`, whose copy says the opposite. */
const PER_LEG_ONLY_GROUP = {
  key: "per-leg",
  label: "per-leg only",
  title: "These members score their legs' danger only - they never move the dial or the notify band.",
};

/** Credit/rates' per-leg-only seat, off the SERVED set. OPTIONAL: dropped when empty (rates seats no
 *  per-leg-only member today; an old cached payload serves no set), never nulling the whole grouping. */
const PER_LEG_ONLY_SERVED = {
  ...PER_LEG_ONLY_GROUP,
  has: (id, f, perLegOnlyIds) => !!perLegOnlyIds && perLegOnlyIds.has(id),
  optional: true,
};

const PER_LEG_GROUP = {
  key: "leg",
  label: "per-leg",
  title: "Off the band: these deepen an individual leg's danger and, via legP, can still move the dial position - but never fire this family.",
  has: () => true,
};

/** The served band seat (`f.band.ids`); a payload without `band` seats nobody. */
const onServedBand = (id, f) => ((f && f.band && f.band.ids) || []).includes(id);

/**
 * The role-sectioned chip strips, per family key. NOT a tile split: one tile, sectioned chips,
 * display-only — each split mirrors a distinction the ENGINE already enforces, it does not create one.
 * A member joins the FIRST group whose `has(id, f, perLegOnlyIds)` matches; the last group's `has` is total.
 */
const TILE_GROUPING = {
  /** Served `f.band.ids`, as credit/rates. GT/GB first (the only trend `coincidentP` depth); the rest
   *  off the band is `PER_LEG_ONLY_MEMBERS` (families.ts), out of `legP` too. */
  trend: [
    {
      key: "depth",
      label: "band + depth",
      title: "These members drive the notify band AND set the dial's band depth (coincidentP).",
      has: (id, f) => DEPTH_TREND_IDS.has(id) && onServedBand(id, f),
    },
    {
      key: "band",
      label: "band-driving",
      title: "These members drive the notify band - their state fires this family - but add no dial band depth.",
      has: onServedBand,
    },
    { ...PER_LEG_ONLY_GROUP, has: () => true },
  ],
  /** Credit's band seat is STATE-DEPENDENT (CQS substitutes for a stale/absent EBP, R3), so it reads
   *  the served `f.band.ids` — never a hand-mirrored constant the way volatility does. A payload
   *  without `band` yields an empty band group, which the empty-group rule below folds to the flat strip.
   *  AT1 (`PER_LEG_ONLY_MEMBERS`) sections off as "per-leg only" ahead of the `legP`-carrying per-leg group. */
  credit: [
    { ...BAND_DRIVING_GROUP, has: onServedBand },
    PER_LEG_ONLY_SERVED,
    { ...PER_LEG_GROUP },
  ],
  /** Rates' band seat is STATE-DEPENDENT too (R8 substitutes for a stale/absent R1, the R1-bridge),
   *  so it reads the served `f.band.ids` exactly as credit does — never a hand-mirrored constant. */
  rates: [
    { ...BAND_DRIVING_GROUP, has: onServedBand },
    PER_LEG_ONLY_SERVED,
    { ...PER_LEG_GROUP },
  ],
  /** Valuation is STATIC (no bridge), so it mirrors a plain constant the way `volatility` does — never the
   *  state-dependent `f.band.ids`. The weighted ECY member sections off from the two rowless inflation
   *  breakevens, which are dial-inert by construction (`valuation` is filtered out of LEADING/COINCIDENT). */
  valuation: [
    { key: "weighted", label: "weighted", title: "The excess-CAPE-yield member - the one weighted row that carries this family's leg danger.", has: (id) => WEIGHTED_VALUATION_IDS.has(id) },
    { key: "context", label: "context", title: "Inflation breakevens - rowless CONTEXT rows, dial-inert by construction: they colour the tile but feed no notify band and no leg danger.", has: () => true },
  ],
  volatility: [
    { ...BAND_DRIVING_GROUP, has: (id) => !SLOW_VOLATILITY_IDS.has(id) },
    {
      key: "bubble",
      label: "bubble watch",
      title:
        "Slow complacency / bubble-state warnings (they fire in CALM markets too) - display-only: they can colour this tile but feed no dial band and no leg danger.",
      has: () => true,
    },
  ],
};

/**
 * Split a family's members into labelled role groups, or return null when the flat strip is
 * correct: not a grouped family, or a group would be EMPTY — a lone role label over the whole
 * strip claims a distinction the strip does not show, which is worse than no label. An `optional`
 * group is instead DROPPED when empty. Both render paths fall back to the flat join. Member ORDER
 * inside each group is the served order, untouched. `perLegOnlyIds` = the served
 * `dangerRoster.perLegOnlyIds` Set (absent on an old payload ⇒ nobody seats per-leg only).
 */
export function tileMemberGroups(f, members, perLegOnlyIds) {
  const config = f && TILE_GROUPING[f.key];
  if (!config) return null;
  const groups = config.map((g) => ({ key: g.key, label: g.label, title: g.title, members: [] }));
  for (const m of members || []) {
    groups[config.findIndex((g) => g.has(m.id, f, perLegOnlyIds))].members.push(m);
  }
  if (groups.some((g, i) => !g.members.length && !config[i].optional)) return null;
  return groups.filter((g) => g.members.length);
}

/** D6c copy (2026-08-20) — the hover text for the two "cannot arm" surfaces. Both say DEEPENS: D6
 *  gave off-band and no-arm members `legP`, a real
 *  within-band deepener on `dangerScore`, so the shipped "scores legs, never arms" understated them by
 *  naming only the per-leg ledger. Neither can arm — `legP` enters `positionP` and nothing else. */
export const CANNOT_ARM_TITLE = "deepens the dial, cannot arm it";
export const NO_ARM_TITLE = "deepens the dial, never arms";

/** D2 (family-colour-follows-danger) — the tile's secondary "cannot arm" mark off the Stage-1
 *  served `f.cannotArm`: `⌁N red` when any unseated member is red, else `⌁N amber` — N counts ONLY
 *  that severity (`worstCount`, [USER] 2026-09-27; the total `count` read "4 red" over 3 red + 1
 *  amber). "" when the family seats every elevated member. Keeps a D1-greened tile from hiding a live
 *  red it cannot arm — it carries `CANNOT_ARM_TITLE` on hover (D6c; it was mute until then). */
export function cannotArmMarkText(f) {
  const ca = f && f.cannotArm;
  if (!ca || !ca.count) return "";
  // `?? count`: a payload cached across the deploy that added `worstCount` keeps the old reading.
  return `⌁${ca.worstCount ?? ca.count} ${ca.worst === "RED" ? "red" : "amber"}`;
}

/** D3 — member chip tone: `live` (moves the band, in `bandIds`) / `leg-only` (off the band but carries
 *  a MEMBER_WEIGHT row, so under D6 it DEEPENS the dial via `legP` and scores legs, never arms) /
 *  `grey` (neither — moves the dial nothing); `per-leg` (served `perLegOnlyIds`) scores its leg, never
 *  the dial; `dead` = any member outside the served `pillarIds` (moves no danger pillar; absent set ⇒
 *  never) that is off the band — or on the display band but NOT in `dialLiveIds` (`dialLiveIdsOf`: a
 *  SLOW or never-arm seat moves no dial; absent set ⇒ the display band decides, the old-payload read).
 *  Members inside `pillarIds` ignore `dialLiveIds`. Browser twin of `memberTone` (src/t1dial.ts) for the
 *  first four tones; every set is SERVED. */
export function memberTone(id, bandIds, legWeightedIds, perLegOnlyIds, pillarIds, dialLiveIds) {
  const outside = !!pillarIds && !pillarIds.has(id);
  if ((bandIds || []).includes(id) && !(outside && dialLiveIds && !dialLiveIds.has(id))) return "live";
  if (outside) return "dead";
  if (perLegOnlyIds && perLegOnlyIds.has(id)) return "per-leg";
  return legWeightedIds && legWeightedIds.has(id) ? "leg-only" : "grey";
}

/** Tone → chip class. `mt-dead` dims hardest (moves no danger pillar); `mt-grey` = neither the band nor a leg. */
export const TONE_CLASS = { live: "mt-live", "per-leg": "mt-perleg", "leg-only": "mt-leg", grey: "mt-grey", dead: "mt-dead" };

/** Ids seated on the served DIAL band — every `d.dialFamilies[].band.ids` outside the served
 *  `noArmFamilies` (a no-arm seat never moves the dial). `undefined` when the payload has no
 *  `dialFamilies` or a dial family carries no `band` (old cache) ⇒ `memberTone` falls back. */
export function dialLiveIdsOf(d) {
  if (!d || !Array.isArray(d.dialFamilies)) return undefined;
  const noArm = (d.dangerRoster && d.dangerRoster.noArmFamilies) || [];
  const ids = new Set();
  for (const f of d.dialFamilies) {
    if (!f.band || !Array.isArray(f.band.ids)) return undefined;
    if (!noArm.includes(f.key)) for (const id of f.band.ids) ids.add(id);
  }
  return ids;
}

export const DEAD_TITLE = "not in pillar - moves no danger pillar";
export const LIVE_DEAD_TITLE = "moves the dial, not in any danger pillar";
/** Dead-lit `⌁` beside a chip outside the served `pillarIds` ("" when inside, or on an old payload). */
export function deadLitMarkHtml(id, tone, pillarIds) {
  if (!pillarIds || pillarIds.has(id)) return "";
  return ` <span class="leg-dead" title="${tone === "live" ? LIVE_DEAD_TITLE : DEAD_TITLE}">⌁</span>`;
}

/** Weighted ids no pillar folds (`memberWeight` keys − `pillarIds`), off a served /api/danger-model body;
 *  `null` without `pillarIds` (old payload ⇒ no note). The Dashboard card's twin of the chip `⌁`. */
export function deadLitIds(model) {
  if (!model || !model.memberWeight || !Array.isArray(model.pillarIds)) return null;
  const pillar = new Set(model.pillarIds);
  return new Set(Object.keys(model.memberWeight).filter((id) => !pillar.has(id)));
}
export const DEAD_NOTE = { kind: "context", text: "⌁ not in pillar", tip: "its own reading folds into no danger pillar" };

/** D4 — a family that deepens the dial (D6 `legP`) and scores legs but can never arm (SERVED
 *  `noArmFamilies`, `{valuation}` today): the tile paints a distinct no-arm treatment, never green,
 *  so the calm colour keeps ONE meaning. Its label carries `NO_ARM_TITLE`. */
export function isNoArmFamily(key, noArmFamilies) {
  return !!noArmFamilies && noArmFamilies.includes(key);
}

/**
 * Rung 3 (Stage 5.2): the empty-state copy for a tile with no member chips.
 *
 * A deliberately-feedless family carries `awaiting` (families.ts) explaining WHY it has
 * no feed; render that instead of the bare "no live feed", which reads as breakage rather
 * than as a sanctioned stub. Every live family — and any family whose feeds merely dropped
 * this run — has no `awaiting` and keeps the legacy string verbatim.
 *
 * The falsy guard is deliberate: `awaiting: ""` falls back to the legacy copy rather than
 * rendering a dangling "awaiting feed — ".
 */
export function tileEmptyCopy(f) {
  return f && f.awaiting ? `awaiting feed - ${f.awaiting}` : "no live feed";
}
