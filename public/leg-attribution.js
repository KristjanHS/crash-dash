/**
 * Level-vs-velocity attribution badge for a board-tile member chip. Pure module (no DOM) so vitest
 * collects it while `tsc` (no allowJs) ignores it; `lab.js` runs module-level DOM side effects and
 * can never be imported from a test, so the markup logic lives HERE.
 *
 * The server (`src/lab-served-field.ts` → `dualAxisFiringIds`) is the SINGLE gate on which ids may be attributed
 * (`DUAL_AXIS_IDS`, canonical in `src/domain-legs.ts`). This module does NOT re-filter — a client copy
 * would be free to drift from the canonical set. It renders exactly what it is handed.
 */
import { LEG_PHRASE, legPhrase } from "./chart-primitives.js";

/** Index `d.legAttribution` (absent on scenario/replay) by indicator id. */
export function attributionIndex(d) {
  const list = (d && d.legAttribution) || [];
  const byId = {};
  for (const a of list) if (a && a.id) byId[a.id] = a;
  return byId;
}

/**
 * The badge text for one member chip, or "" when the id has no attribution — either no entry at
 * all (calm / non-dual-axis) or an entry carrying a `declined` reason instead of an axis
 * (`no-history` / `mid-confirm` / `recompute-disagreed`). The axis check below covers both: a declined
 * entry has no `axis`. The declined case is rendered separately by `declinedNoteText`.
 *
 * Phrasing comes from `legPhrase`/`LEG_PHRASE`, the same table `detail-chart.js` uses for the ribbon
 * tooltip, pinned key-for-key against `src/domain-legs.ts` by `public/chart-primitives.test.js`, so a
 * chip and a ribbon cell can never word one leg two ways. The `legPhrase` call is gated on the token
 * having at least one RECOGNISED part (`legPhrase` is total — an unmapped part renders as itself), so an
 * unrecognised leg falls back to the axis rather than leaking a raw enum token. The gate is derived from
 * the key grammar (split on `+`), so a COMPOSITE leg passes with no entry hand-listed here.
 */
export function axisBadgeText(attr) {
  if (!attr || (attr.axis !== "velocity" && attr.axis !== "level")) return "";
  const known =
    attr.leg !== undefined && String(attr.leg).split("+").some((part) => LEG_PHRASE[part] !== undefined);
  return paren(`via ${known ? legPhrase(attr.leg) : attr.axis}`);
}

/** BOTH badge-slot notes are bracketed [USER 2026-08-19] — the chip strip also carries bare GROUP
 *  labels ("band-driving"/"per-leg", tile-members.js), and an aside must not read as a grouper. */
function paren(text) {
  return `(${text})`;
}

/**
 * Tooltip for the badge: names the raw OR-leg token and its units axis, so the chip can be
 * cross-checked against the same day's `leg` on the /series ribbon (which already ships it).
 */
export function axisBadgeTitle(attr) {
  return attr && attr.leg ? `confirmed state attributed to the ${attr.axis} axis (winning leg: ${attr.leg})` : "";
}

/**
 * The muted note for a firing id the server DECLINED to attribute. `axisBadgeText` returns "" for
 * both declined and calm firings, so this note disambiguates — it reports the attribution's outcome,
 * not the leg's state, so it stays subordinate to the coloured leg name. All three are unresolved
 * attempts, so all three read "held".
 */
const DECLINED_NOTE = {
  "no-history": () => "attribution held - no history",
  // Names the MECHANISM, not the enum token [USER 2026-09-02]: "mid-confirm" said nothing about
  // what was holding the leg back. The close count comes off the server's `confirmCloses`
  // (`src/lab-attribution.ts` attributeLeg) — NEVER hardcoded here, so a `CONFIRM_TIERS` retune stays a
  // one-place edit. A payload without it (older deploy) degrades to the unnumbered phrase rather
  // than rendering "undefined-close".
  "mid-confirm": (attr) =>
    `attribution held - mid ${Number.isFinite(attr.confirmCloses) ? `${attr.confirmCloses}-close ` : ""}confirmation fold`,
  "recompute-disagreed": () => "attribution held - recompute disagreed",
}; // BARE phrasing — `declinedNoteText` brackets it through `paren`.

/** The reasons this module has copy for. The test pins this against the canonical
 *  `LEG_ATTRIBUTION_DECLINED_REASONS` (src/families.ts) in BOTH directions, so a reason added
 *  server-side without copy here fails the suite instead of silently rendering no note. */
export function notedDeclineReasons() {
  return Object.keys(DECLINED_NOTE);
}

/** Note text for a declined entry, or "" for an attributed / absent / unknown-reason one. */
export function declinedNoteText(attr) {
  if (!attr || !attr.declined) return "";
  const note = DECLINED_NOTE[attr.declined];
  return note ? paren(note(attr)) : "";
}

/** Tooltip spelling out WHY the axis is unknown — mirrors the openapi `declined` enum copy. */
const DECLINED_TITLE = {
  "no-history": "no stored rows to recompute from, so neither axis could be reconstructed for today's confirmed state",
  "mid-confirm":
    "the raw state disagrees with the confirmed one - the id is mid-way through its confirmation fold, so no single axis owns today's state",
  "recompute-disagreed": "the recompute did not reproduce the persisted date/state, so the server declined to name an axis rather than guess",
};

export function declinedNoteTitle(attr) {
  if (!attr || !attr.declined) return "";
  const why = DECLINED_TITLE[attr.declined];
  return why ? `no level/velocity axis for this firing: ${why}` : "";
}
