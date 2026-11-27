// Display labels for the ladder sleeve KEYS — the one FE place a sleeve key becomes reader text.
//
// The key (`"EU-Fin"`) is an identifier: it rides the wire (`ladder`, `legRows[].sleeve`,
// `heldSleeve`), `alert_log.held_sleeve`, the `/lab` URL params and every weight/lookup table, and
// it NEVER changes. Only the rendered name may differ from it, and only via this map — every site
// that prints a sleeve into HTML/SVG text, a `title=` or an `aria-label` calls `sleeveLabel(key)`
// and keeps the raw key for `data-*` attributes, `value=`s and map lookups.
//
// Mirror of `SLEEVE_LABEL` in src/families.ts (the push text's map): a browser module cannot import
// `src/`, so `public/picker-groups.test.js` pins the two tables equal.

/** Overrides only: a sleeve absent here renders as its key. */
export const SLEEVE_LABEL = Object.freeze({
  Semis: "Semis SEC0",
  "S&P IT": "S&P IT QDVE",
  EM: "EM IS3N",
  Value: "Value XDEV",
  "S&P 500": "S&P 500 SXR8",
  "ex-US": "ex-US CHSI",
  "EU-Fin": "EU-Fin EXSH",
  Health: "Health QDVG",
  Staples: "Staples ZPDS",
});

/**
 * The reader-facing name of a sleeve key (the key itself unless `SLEEVE_LABEL` overrides it).
 * Non-ladder strings (`"Cash"`, an off-ladder id) pass through unchanged.
 * @param {string} key
 * @returns {string}
 */
export function sleeveLabel(key) {
  return Object.hasOwn(SLEEVE_LABEL, key) ? SLEEVE_LABEL[key] : key;
}
