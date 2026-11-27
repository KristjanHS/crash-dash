/** The `/lab` board head's read of the served `t1dial.headline`.
 *
 *  The board paints the headline's ARM/FIRE clause ONLY; the `→ <regime>, rung N` tail is dropped
 *  because `.board-head` two rows up already shows `REGIME <regime>` and `danger score <n>`, so the
 *  tail restates what is on screen and buys nothing for a line of height.
 *
 *  This seam ONLY slices the server-authored string (`src/t1dial.ts`, the `headline` template). It
 *  deliberately does NOT re-derive arm/fire state from `armed`/`fired`/`firingLeaders` on the
 *  payload — a second front-end copy of a server rule is the bug class `public/lab.js`'s divergent
 *  `buildMemberState` mirror already demonstrates.
 *
 *  TWO slice rules, because production serves headlines this deploy did not build. `api/lab.ts`
 *  HYDRATES `t1dial` from the persisted `alert_log.dial_state` blob (`hydrateOrComputeT1Dial`), so a
 *  live row can carry a string written by an older template version:
 *    1. the separator `HEADLINE_TAIL_SEP` when present — the current template's shape; and
 *    2. failing that, `TAIL_RE`, which keys on the tail's own GRAMMAR (`<Regime>, rung <n>`) rather
 *       than on the arrow glyph, so a separator change does not resurrect the tail on rows persisted
 *       before it. Without rule 2 a template edit would red the pin (good) AND silently paint the
 *       dropped tail on every already-persisted row until the next alert row is written (not good) —
 *       an exposure the pin cannot see, since the pin computes a FRESH dial.
 *  Both rules are pinned in `public/dial-headline.test.js`; case 1 computes a REAL headline via
 *  `computeT1Dial` and asserts the separator appears exactly once. */

/** The current `headline` template's clause/tail separator (U+2192, verified identical to the
 *  codepoint in `src/t1dial.ts`). Hand-typed — it is what the test CHECKS, not what it derives. */
export const HEADLINE_TAIL_SEP = " → ";

/** The tail's grammar, glyph-independent: an optional short arrow, a `Regime` label, `, rung <n>`.
 *  The four regime labels are the `FamilyRegime` union (`src/families.ts`); they are a closed set and change
 *  only with a deliberate rename, which `public/dial-headline.test.js` would red.
 *  ⚠ The arrow group must be WHITESPACE-DELIMITED (`\s+\S{1,3}`, not `\s*\S{0,3}`): the looser form
 *  ate the last three characters of a preceding `fired (trend)` when no arrow was present. */
const TAIL_RE = /(?:\s+\S{1,3})?\s+(?:Calm|Caution|Stress|Crisis),\s*rung\s*\d+\s*$/;

/** `"primed (credit) + unfired → Caution, rung 4"` → `"primed (credit) + unfired"`.
 *
 *  Non-string / empty input ⇒ `""`. Defensive and unreachable today: `t1dial` is non-optional on
 *  both the live and scenario payloads and `headline` is a non-optional `string`, the replay path
 *  never reaches this row, and `lab.js` already dereferences `t1.regime` two lines earlier — so a
 *  missing dial throws before this is called. Kept because the cost is one comparison.
 *
 *  A string matching NEITHER rule returns WHOLE rather than empty: if the template drifts beyond
 *  both, a full clause still reads correctly, while an empty row would silently lose arm/fire state. */
export function armFireClause(headline) {
  if (typeof headline !== "string" || !headline) return "";
  const i = headline.indexOf(HEADLINE_TAIL_SEP);
  if (i !== -1) return headline.slice(0, i).trim();
  return headline.replace(TAIL_RE, "").trim();
}

/** E14: `EST · push band: <level>` iff the served
 *  (display) `t1dial.regime` ≠ the notify dial's `band.chain.regime`; `""` otherwise (scenario: no `band`). */
export function estPushTag(d) {
  const notify = d?.band?.chain?.regime;
  if (!notify || !d?.t1dial?.regime || d.t1dial.regime === notify) return "";
  return `EST · push band: ${d.band.level}`;
}
