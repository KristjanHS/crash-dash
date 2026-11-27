/**
 * Whether `<leg>:apply` re-probes a `blockReach: "graded"` leg live before its real `applyRun` pass (scripts/ladder-apply.ts).
 */
import { allEvents, type LadderLive } from "./ladder-live.js";
import { causeFalseLifts, contextRow, isReleased, liftsLean, reviewMoves, SOURCED_LABEL, withPatchSources } from "./ladder-block.js";
import { restatus, type LadderPatch } from "./ladder-run.js";

/** A `block` key, an added event, an event `status` / `date` differing from the stored one (`restatus`), an event `spares` key, a `drop` of a tranche-holding event (its `holds` leave `allFizzled`), or a block `resolveBlocks` may lift off the row itself
 *  (a blocked row patched with — or holding — a lifting lean, a blocked context row, a legacy block that reads released — `isReleased` — or one the probe's `verdict.lifts` names, a measured lift, a lifting `causeFalseLifts`), or a block whose `today` review moves its reach off the patched row (`reviewMoves`) — the reverdict's only inputs; an echoed stored value re-uses step 1's verdict. */
export const movesVerdict = (live: LadderLive, patch: LadderPatch, today: string): boolean =>
  Object.values(patch.signs).some((s) => "block" in s) ||
  live.signs.some((s) => s.block && (contextRow(s) || isReleased(s, allEvents(live)) || !!live.verdict?.lifts?.some((l) => l.sign === s.sign) || (!!patch.signs[s.sign] && SOURCED_LABEL.test(patch.signs[s.sign]!.label) && liftsLean(patch.signs[s.sign]!.lean ?? s.lean)) || causeFalseLifts(withPatchSources(s, patch.signs[s.sign], today), patch.signs[s.sign], today))) ||
  live.signs.some((s) => ((p) => reviewMoves(p ? { ...withPatchSources(s, p, today), label: p.label, lean: p.lean ?? s.lean } : s, allEvents(live), today))(patch.signs[s.sign])) ||
  !!patch.eventsAdd?.length ||
  Object.entries(patch.events ?? {}).some(([name, e]) => ((was) => restatus(live, name, e.status) || (e.spares !== undefined && JSON.stringify(e.spares) !== JSON.stringify(was?.spares)) || (e.date !== undefined && e.date !== was?.date) || ("drop" in e && !!was?.holds.length))(live.events.find((x) => x.event === name)));
