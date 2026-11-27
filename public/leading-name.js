/**
 * Board-leg tooltip name composers: `legTitle` (prepends the served `label` to the help sentence),
 * `chipLabel` (the compact-chip form of a label), `idIfDistinct` (drops a raw id that merely restates
 * the label beside it). The help tables (`MEMBER_HELP`, `MEMBER_DESC`, `INDICATOR_DESC[id].tip`) store
 * the bare SENTENCE; each render site composes the name segment ahead of the copy, so the name is
 * never re-added to the help copy itself.
 *
 * Pure data module (no DOM) so vitest can pin it while `tsc` (no allowJs) ignores it.
 */

/** Separator between the composed name segment and the help sentence. */
const SEP = " - ";

/**
 * Compose a board-leg `title=`: short name first, then the help sentence. The short `label` is carried
 * on the member DTO (`{ id, label, state, longLabel? }`, families.ts) and passed as the first argument;
 * the help copy is the bare sentence, appended raw. The descriptive `longLabel` still ships on the wire
 * but is NOT rendered here. A member with no `label` degrades to just the help sentence.
 * @param {string | undefined} label the served `Indicator.label` (short name)
 * @param {string | undefined} help the `MEMBER_HELP` entry (bare sentence)
 * @returns {string} the tooltip text ("" when there is nothing to say)
 */
export function legTitle(label, help) {
  return [label, help].filter(Boolean).join(SEP);
}

/**
 * The compact-chip form of a registry `label`: collapse internal spaces to underscores so a
 * multi-word label stays ONE unbroken token in the dense family-tile / signal-grid chips
 * (`HY OAS` → `HY_OAS`, `NFCI Risk` → `NFCI_Risk`) — a LAYOUT device for the chips, never a rename.
 * Single-word and already-compound labels (`CAPE`, `MOVE`, `SMH/SPY`, `MU`) pass through verbatim;
 * the prose surfaces (tooltips, aria-labels, options, chart titles) keep the real spacing and never
 * call this.
 * @param {string | undefined} label the served `Indicator.label`
 * @returns {string} the label with internal spaces joined by `_` ("" when there is no label)
 */
export function chipLabel(label) {
  return String(label ?? "").replace(/ /g, "_");
}

/**
 * The id segment to render ALONGSIDE its label — the raw id when it adds information, EMPTY when it
 * merely restates the label. Render sites emit `id` and `label` together, so a naive "replace the id
 * with the label" would stutter (`OVX OVX`); an id shown beside its label survives only when it is
 * genuinely DIFFERENT. Operational test: normalize BOTH sides — lowercase, drop every
 * non-alphanumeric — and drop the id when the normalized `label` is a substring of the normalized
 * `id`. So `F1`/`HY OAS`, `SPCONC`/`SPY/RSP`, `GT`/`ACWI trend`, `R6`/`MOVE` keep their id;
 * `OVX`/`OVX`, `NVDA`/`NVDA`, `EBP`/`EBP`, `BRENT`/`Brent` collapse to the label alone. A
 * missing/empty label cannot restate anything, so the id is kept (nothing to de-duplicate against).
 * @param {string | undefined} label the served `Indicator.label`
 * @param {string | undefined} id the internal registry id shown beside it
 * @returns {string} the id to render beside the label, or "" when it restates the label
 */
export function idIfDistinct(label, id) {
  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  const nl = norm(label);
  if (nl && norm(id).includes(nl)) return "";
  return id ?? "";
}
