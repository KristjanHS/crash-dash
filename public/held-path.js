// Held-leg trajectory (the danger ledger's event log) — pure string/derivation seam over
// `LabResponse.walkPath`.
//
// Zero DOM, zero module-level side effects, so held-path.test.js can import it directly (FE tests
// run with NO jsdom, and lab.js has module-level DOM/localStorage side effects) — the
// cash-overlay-view.js / coverage-marks.js seam pattern. lab.js keeps the DOM write.
//
// WHAT THE WIRE GIVES US
//  · `field.held` — TODAY's position. Pinned to the un-walked incumbent server-side,
//    so it is the day-0 row and is NEVER read off `walkPath`.
//  · `walkPath: WalkLegStep[]` — days 1..N, **1-based, no day-0 entry**. Present only when the
//    request composed `?walk=N` over a seedable store; absent ⇒ this seam renders nothing at all
//    and the footer keeps its live wording byte-for-byte.
//
// NO BAND COLUMN, deliberately: `walkForward` passes `dial: frozen.dial` unchanged to
// every walk day, so the `{lo,hi}` rung band is CONSTANT days 1..N by construction and is served
// once at `field.band`; the notify level `walkPath[].band` measured flat across 12 days on two prod
// scenarios. `heldSleeve` is the only member that moves, so the log is `close · held · what changed`.
import { esc } from "./chart-primitives.js";
import { sleeveLabel } from "./sleeve-label.js";

/**
 * Walk depth the SCENARIO fetch defaults to (`/api/lab?s=…&walk=N`), when the URL names no `?walk=`.
 *
 * THE one touch point for the number — nothing else, not a comment, a fixture or a doc string, may
 * restate it; anything that needs the value imports this. Sized from the measured prod latency
 * (≈60 ms per walk day) to cost well under a second on top of a ~1.5 s baseline — with margin over
 * every delayed action a walk has to resolve, without making a rapid click-through drag.
 */
export const SCENARIO_WALK_DAYS = 10;

/** How a walked day's held sleeve reads when the band admits nothing (`heldSleeve: null`). */
const NO_SLEEVE = "no in-band sleeve";

/** The reason vocabulary. Every row's `reason` is one of these — see `reasonFor` for the
 *  derivation. A `band step-down admits a hotter leg` string is deliberately ABSENT: a frozen dial
 *  cannot step its band mid-walk, so it is mechanically impossible.
 *
 *  ⚠ `rerisk`/`derisk` state the DIRECTION and the timing, not a gate: both commit on one close
 *  (`RERISK_CONFIRM`/`RERISK_DWELL_DAYS` = 1/0), and only the trend veto can delay one. */
const REASON = {
  incumbent: "incumbent - the current position",
  rerisk: "re-risk - commits on one close",
  derisk: "de-risk - commits on one close",
  rotate: "hold rotates",
};

/** 1-based ladder rung of a sleeve, or 0 when it is off-ladder / the ladder was not served.
 *  `LabResponse.ladder` is ordered aggressive→defensive, so a SMALLER rung is the hotter leg. */
function rungOf(sleeve, ladder) {
  if (!sleeve || !Array.isArray(ladder)) return 0;
  const i = ladder.indexOf(sleeve);
  return i < 0 ? 0 : i + 1;
}

/**
 * Why the hold moved on this close.
 *
 * DIRECTION comes from the served ladder (aggressive→defensive), which is the only field that can
 * separate the two moves at the step itself: `decideRotationHold` (src/rotation-commit.ts) resets
 * `reriskConfirmCount` to 0 on EITHER kind of commit, so the counter read AT a change is 0 in both
 * cases. What the counter does carry is the pending streak on the closes BEFORE the change — a
 * non-zero prior count is a re-risk that was accumulating — so it is the fallback whenever the
 * direction is not derivable (an off-ladder sleeve, a null hold, or a degraded `ladder`).
 *
 * @param {number} prevConfirm the previous row's `reriskConfirmCount`, or -1 when unknown (the
 *   day-0 incumbent's counter is not on the wire).
 */
function reasonFor(prevSleeve, nextSleeve, ladder, prevConfirm) {
  const from = rungOf(prevSleeve, ladder);
  const to = rungOf(nextSleeve, ladder);
  if (from > 0 && to > 0 && to !== from) return to < from ? REASON.rerisk : REASON.derisk;
  // Direction not derivable — fall back to the streak: a confirm that was pending and is now spent
  // is a re-risk rotation; anything else is stated plainly rather than guessed.
  return prevConfirm > 0 ? REASON.rerisk : REASON.rotate;
}

/**
 * Derive the event-log rows + the settle outcome.
 *
 * Row rule: the incumbent row is emitted UNCONDITIONALLY (from `incumbentSleeve`, i.e. `field.held`
 * — `walkPath` has no day-0 entry), then one row per close whose `heldSleeve` differs from the
 * previous row's.
 *
 * Outcome — the three cases the footer must never mis-state:
 *  · `none`    — nothing moved across the whole walk.
 *  · `settled` — the last change is at +k with k < N, so +k..+N is flat.
 *  · `overrun` — the LAST close still moved. The path has not converged, and the day-N sleeve is
 *    NOT a destination: whatever the caller prints, it may not claim one.
 *
 * @returns {null|{rows: Array<{day:number,label:string,sleeve:string|null,reason:string,incumbent:boolean}>,
 *   days:number, outcome:"none"|"settled"|"overrun", lastChangeDay:number|null,
 *   destination:string|null}} `null` when there is no walk to describe.
 */
export function deriveHeldPath(incumbentSleeve, walkPath, ladder) {
  if (!Array.isArray(walkPath) || walkPath.length === 0) return null;
  const days = walkPath.length;
  const rows = [
    {
      day: 0,
      label: "today",
      sleeve: incumbentSleeve ?? null,
      reason: REASON.incumbent,
      incumbent: true,
    },
  ];
  let prevSleeve = incumbentSleeve ?? null;
  let prevConfirm = -1; // the incumbent's confirm count is not served — unknown, not 0
  for (const step of walkPath) {
    const sleeve = step.heldSleeve ?? null;
    if (sleeve !== prevSleeve) {
      rows.push({
        day: step.day,
        label: `+${step.day}`,
        sleeve,
        reason: reasonFor(prevSleeve, sleeve, ladder, prevConfirm),
        incumbent: false,
      });
      prevSleeve = sleeve;
    }
    prevConfirm = typeof step.reriskConfirmCount === "number" ? step.reriskConfirmCount : -1;
  }
  const last = rows.length > 1 ? rows[rows.length - 1] : null;
  const outcome = !last ? "none" : last.day >= days ? "overrun" : "settled";
  return {
    rows,
    days,
    outcome,
    lastChangeDay: last ? last.day : null,
    // A destination exists only once the path has stopped moving. `overrun` gets `null` on purpose:
    // it is the whole point of the case that the day-N sleeve is not where this ends up.
    destination: outcome === "settled" ? last.sleeve : null,
  };
}

/** The footer line under the log — one sentence per outcome, never naming a destination the walk
 *  has not reached. */
function summaryText(path) {
  if (path.outcome === "none") return `nothing changed through +${path.days}`;
  if (path.outcome === "overrun") return `still moving at +${path.days} - not settled`;
  return `settled by +${path.lastChangeDay} · no further change through +${path.days}`;
}

const closesWord = (n) => (n === 1 ? "close" : "closes");

/** The `close · held · what changed` event log. `""` when there is no walk (absent `walkPath`,
 *  `?walk=0`, or a store too cold to seed one) — the ledger then paints exactly as it did before. */
export function heldPathHtml(incumbentSleeve, walkPath, ladder) {
  const path = deriveHeldPath(incumbentSleeve, walkPath, ladder);
  if (!path) return "";
  const body = path.rows
    .map((r) => {
      const cls = r.incumbent ? `<tr class="hp-row hp-incumbent">` : `<tr class="hp-row">`;
      return (
        cls +
        `<td class="hp-close">${esc(r.label)}</td>` +
        `<td class="hp-held">${esc(r.sleeve === null ? NO_SLEEVE : sleeveLabel(r.sleeve))}</td>` +
        `<td class="hp-why">${esc(r.reason)}</td>` +
        `</tr>`
      );
    })
    .join("");
  // The unsettled summary carries its own class so the one outcome that must not read as a
  // destination is visually distinct from a settled one.
  const sumCls = path.outcome === "overrun" ? `<span class="hp-unsettled">` : `<span class="hp-settled">`;
  return (
    `<table class="hp-log">` +
    `<caption class="hp-cap">held-leg trajectory · walk ${path.days} ${closesWord(path.days)}</caption>` +
    `<thead><tr><th class="hp-close">close</th><th class="hp-held">held</th>` +
    `<th class="hp-why">what changed</th></tr></thead>` +
    `<tbody>${body}</tbody>` +
    `<tfoot><tr><td class="hp-foot" colspan="3">${sumCls}${esc(summaryText(path))}</span></td></tr></tfoot>` +
    `</table>`
  );
}

/**
 * The scenario footer's held clause, replacing the live `— most aggressive sleeve the danger buffer
 * permits ` (reworded 2026-08-19: the old "calmest sleeve" gloss described only the de-risk half of
 * `pickHeld` — see the comment at the `lab-board.js` call site).
 *
 * `""` on the live path, on an absent walk, and on a no-move walk — all three keep today's wording
 * byte-for-byte. The overrun variant names NO destination, and neither does the ROUND TRIP: a
 * settled walk can leave the incumbent and come back, and `destination` is compared only against the
 * PREVIOUS row, never the incumbent — so printing it as a move would read `Health today → Health`,
 * claiming a rotation into the leg already held.
 */
export function heldPathFootPhrase(incumbentSleeve, walkPath, ladder) {
  const path = deriveHeldPath(incumbentSleeve, walkPath, ladder);
  if (!path || path.outcome === "none") return "";
  if (path.outcome === "overrun") return ` - not settled by +${path.days} ${closesWord(path.days)} `;
  // Null-tolerant, the same normalisation the row loop compares sleeves with (`?? null`), so a walk
  // out of and back into a null hold is a round trip too rather than a move to `no in-band sleeve`.
  if (path.destination === (incumbentSleeve ?? null))
    return ` - round trip: back to today's hold by +${path.lastChangeDay} ${closesWord(path.lastChangeDay)} `;
  return ` today → <b>${esc(path.destination === null ? NO_SLEEVE : sleeveLabel(path.destination))}</b> in ${path.lastChangeDay} ${closesWord(path.lastChangeDay)} `;
}
