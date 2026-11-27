/**
 * Pure seam — the RE-RISK TIMING copy on /lab's danger-field footer (`#dfFoot`): the tooltip
 * sentence plus the knob chips that ride the visible "knobs:" line.
 *
 * ⚠ **ONE CLAUSE PER SERVED FIELD**: each clause is derived from its own field and neither can
 * speak for the other, or a re-arm on one gate would make the copy assert the wrong thing about the
 * other. `reriskDwellDays` is on the wire (`src/api/meta-views.ts`, `DangerModel.required`).
 * `api/lab.ts`'s `dwellChipsLive = RERISK_DWELL_DAYS > 0` is the server-side twin of the `dwellLive`
 * test here.
 *
 * Derived, never restated: no constant value is hard-coded — a re-arm on the server changes the copy
 * with no edit in this file.
 *
 * @param {{reriskConfirm?: number, reriskDwellDays?: number}|null|undefined} dangerModel the served
 *        `/api/danger-model` block (null when the fetch failed — then both gates read retired, which
 *        is the same honest fallback the surrounding `knobs` span already applies).
 * @returns {{sentence: string, chips: string}} the tooltip clause and the chip suffix (both `""`-safe
 *        and already carrying their leading separator).
 */
export function reriskGateCopy(dangerModel) {
  const rc = dangerModel && dangerModel.reriskConfirm;
  const rdd = dangerModel && dangerModel.reriskDwellDays;
  // A confirm gate only bites above 1 (`prevConfirmCount + 1 >= confirm`); a dwell gate only bites
  // above 0 (`dwellNow >= dwellDays`). Both mirror `rotation-commit.ts`'s own arithmetic.
  const confirmLive = typeof rc === "number" && rc > 1;
  const dwellLive = typeof rdd === "number" && rdd > 0;

  if (!confirmLive && !dwellLive) {
    return {
      sentence:
        " Re-risk has no confirm-streak or dwell clock (both retired 2026-08-07): it commits on one close, blocked only while a trend (uT) member is confirmed RED.",
      chips: "",
    };
  }
  const clauses = [];
  if (confirmLive) clauses.push(`${rc} consecutive improving closes`);
  if (dwellLive) clauses.push(`${rdd} close${rdd === 1 ? "" : "s"} held since the leg last changed`);
  return {
    sentence: ` And re-risk to a more-aggressive leg needs ${clauses.join(" and ")}.`,
    chips: `${confirmLive ? ` · confirm ${rc}×` : ""}${dwellLive ? ` · dwell ${rdd}` : ""}`,
  };
}
