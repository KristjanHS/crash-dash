/**
 * /lab served-member resolver: per panel member, the served row (run row vs stored head), its
 * provisional / estimated / fold / lastPrint tags, and the family `bandLagIds`. Pure — no IO.
 */

import type { SeriesPoint, StoredReading } from "./store.js";
import { confirmClosesFor, type FamilyPanel } from "./families.js";
import { intradayOverlay, isProvisional } from "./intraday.js";
import { lastPrintTag } from "./last-print.js";
import { keptRows, notifyObservationOn } from "./estimated.js";
import { utcFiredDate } from "./store-rows.js";

export interface ServedMemberInputs {
  /** The run's OWN post-monotonicity-guard rows (`getReadingsForRun(verdict.firedAt)`). */
  runRows: readonly Pick<StoredReading, "indicatorId" | "date" | "state" | "rawState" | "estimated">[];
  /** Per-id newest stored rows, ascending (`getSeriesBulk(ids, { limit: 4 })`). */
  newestRows: ReadonlyMap<string, readonly SeriesPoint[]>;
  /** The payload's `asOf` — `lastPrint` ages against it. */
  asOf: string;
  /** The served verdict's `firedAt`, and whether it is the intraday slot (not the EOD row). */
  verdict: { firedAt: string; provisional: boolean };
}

/**
 * A member whose SERVED row disagrees with the folded panel state serves that row and marks the
 * family `bandLagIds`. Callers run it AFTER computeField/dial — band/bandReason stay UNTOUCHED.
 * Served row = freshest of TWO vintages: the run's OWN post-monotonicity-guard reading (carries a
 * CARRIED newer close that `panel_state` missed) and `readings_latest` (a close from a LATER run).
 * The mark is decided STATE-vs-panel, not date-vs-date (the guard rewrote the run row's date).
 * `intraday: false` (the DIAL panel) serves only a row the notify dial folds (`keptRows` under `notifyObservationOn` of the verdict's fired date): its diffusion count mirrors the EOD push.
 */
export function resolveServedPanels(panels: FamilyPanel[], intraday: boolean, inputs: ServedMemberInputs): FamilyPanel[] {
  const { runRows, newestRows, asOf, verdict } = inputs;
  const estimatedRunIds = new Set(runRows.flatMap((r) => (r.estimated === true ? [r.indicatorId] : [])));
  const runRowOf = new Map(runRows.map((r) => [r.indicatorId, { date: r.date, state: r.state, rawState: r.rawState, estimated: estimatedRunIds.has(r.indicatorId) }] as const));
  const newestClose = new Map<string, SeriesPoint>();
  const newestNotify = new Map<string, SeriesPoint>();
  const notifyKeep = notifyObservationOn(utcFiredDate(verdict.firedAt));
  for (const [id, pts] of newestRows) {
    const p = pts.at(-1);
    if (p) newestClose.set(id, p);
    const q = keptRows(id, pts, notifyKeep).at(-1);
    if (q) newestNotify.set(id, q);
  }
  return panels.map((f) => {
    const bandLagIds: string[] = [];
    const members = f.members.map((m) => {
      const own = runRowOf.get(m.id); // the member's OWN folded obs_date + state
      const newest = newestClose.get(m.id);
      // E22: `last print D-n` off the raw stored head, aged to the payload's `asOf` — run row or not.
      const lastPrint = lastPrintTag(m.id, newest, asOf);
      const tag = lastPrint ? { lastPrint } : {};
      // A member absent from this run's readings is the CARRY path's business — leave it as folded.
      if (own === undefined) return lastPrint ? { ...m, ...tag } : m;
      // The DIAL panel serves an `estimated` head like the push folded it — never a provisional, failed-gate or `notifyGapDates` row.
      const fresh = intraday || (newest !== undefined && newestNotify.get(m.id) === newest) ? newest : undefined;
      const served = fresh && fresh.date > own.date ? { date: fresh.date, state: fresh.state, rawState: fresh.rawState } : own;
      // A provisional served row colours + labels the chip but never marks a band lag.
      // L3: on the intraday verdict the run's OWN row is the provisional one when it is dated the run's
      // day (`isProvisional` over the row's date + the run's `firedAt` — the same rule the series wire uses).
      const provisional =
        intradayOverlay(fresh, own.date, m.id) !== undefined ||
        (served === own && verdict.provisional && isProvisional({ date: own.date, runAt: verdict.firedAt }, m.id));
      // L3/E3: the served row's STORED marker — an intraday or EOD estimate reads `EST`, and never marks a band lag.
      const estimated = served === own ? own.estimated : fresh?.estimated === true;
      if (served.state !== m.state && !provisional && !estimated) bandLagIds.push(m.id);
      // fold badge: non-null iff the SERVED point is mid-stand-down (raw ≠ confirmed). `of` from
      // `confirmClosesFor` — never an FE literal (single touch point).
      const fold = served.rawState !== served.state ? { raw: served.rawState, of: confirmClosesFor(m.id) } : null;
      return {
        ...m,
        state: served.state,
        obs: served.date,
        fold,
        ...(provisional ? { provisional: true as const } : {}),
        ...(estimated ? { estimated: true as const } : {}),
        ...tag,
      };
    });
    return bandLagIds.length ? { ...f, members, bandLagIds } : { ...f, members };
  });
}
