/**
 * ⚠ **BEHAVIORALLY INERT under the directional fold (batch-2 row 7, 2026-08-26)** — this
 * path can no longer fire, though `PROVISIONAL_IDS` is now NON-empty (every tier is 2, so the
 * `confirmClosesFor(id) >= 2` filter admits the whole candidate roster). The candidate
 * condition is `rawState === "RED" && state !== "RED"`, which is impossible when a worse raw
 * state confirms same-day (`asymConfirmedStateSeries` instant-up — the R1-cooldown path
 * included, since the cooled series is the folded series), so `decideProvisional` always
 * returns `{push:false}`. Correct, not a bug: the module existed solely to bypass the confirm
 * buffer on ESCALATION, and instant-up removed that buffer — a raw RED IS the confirmed RED,
 * pushed by the band on the same run. (The surviving 2-close buffer is DOWN-only.)
 *
 * It is deliberately kept WIRED (module, call sites, the `AlertRecord.provisionalPushedAt`
 * column, `scripts/probe-provisional-cost.ts`). ✅ RULED [USER] 2026-07-31
 *: KEEP IT INERT AND WIRED — removal is not on the
 * table (it would be a migration; `provisionalPushedAt` is a live persisted jsonb key). Do not re-raise
 * removal-vs-retention;
 * re-buffering one family would revive it with a one-value edit in `families.ts`. Nothing below
 * describes live behaviour — read it as the contract this path WOULD honour if a tier ever
 * returns to >= 2. `src/provisional.test.ts` pins the inert contract.
 *
 * ---
 *
 * PROVISIONAL push — escalate on a RAW (unconfirmed) RED without waiting for the
 * 2-close confirm (lever 2(a)).
 *
 * The 2-close fold existed to stop chatter, not to survive crashes: only the CONFIRMED state
 * reaches the band and the push, so a credit breach notified one close late. This module
 * decides a SEPARATE, distinctly-titled notification on the raw breach.
 *
 * ORTHOGONALITY INVARIANT — nothing here touches the ladder. Stored states, the band,
 * the dial, the held sleeve and history stay byte-identical: the only state this path
 * owns is `AlertRecord.provisionalPushedAt` (its own jsonb key), never `level`/`pushedAt`/
 * `pushError`. `decideNotify` is upward-only against the LAST PERSISTED BAND, so writing
 * the level baseline here would make the real confirmed RED a day later read as "no
 * upward change" and stay silent — the exact failure this separation prevents.
 *
 * Pure: no IO, no clock (`now` is injected).
 */

import { DASHBOARD_FAMILIES, confirmClosesFor } from "./family-table.js";
import { FAST_CONFIRMERS } from "./confirmers.js";
import { REASSERT_AFTER_DAYS } from "./ladder.js";
import { legPhrase } from "./domain-legs.js";
import { type Reading } from "./domain-types.js";
import type { NtfyMessage } from "./ntfy.js";

/**
 * The indicator ids admitted to the provisional path — DERIVED, never hand-typed, from the
 * plan's scope ruling (2026-07-23 step 1): the **credit family** plus the **fast confirmers**,
 * minus anything whose confirmation tier is under 2 closes (a `confirmClosesFor` of 0 is a
 * same-day fold — there is no confirm to bypass, so a "provisional" would be the confirmed
 * state itself).
 *
 * ⚠ **NON-empty since the 2026-08-26 directional fold** (every tier is 2, so the filter
 * admits the full roster, `CG`/`VT` included) — yet the path stays inert: instant-up makes
 * the raw-RED-unconfirmed candidate condition unsatisfiable (see the file docblock).
 *
 * `BAA10Y` (retired outright 2026-08-11) was ALREADY absent before IS-5 for an independent
 * reason: `familyOf("BAA10Y")` was undefined, so it was not a credit-FAMILY member and never
 * reached this set. (It also LOST its `CARD_ONLY_GROUPS` "credit" display row on 2026-08-06 to
 * `CQS` — but that row was only ever a card
 * overlay and never made it a family member either way.)
 */
export const PROVISIONAL_IDS: ReadonlySet<string> = new Set(
  [
    ...(DASHBOARD_FAMILIES.find((f) => f.key === "credit")?.ids ?? []),
    ...FAST_CONFIRMERS.map((c) => c.id),
  ].filter((id) => confirmClosesFor(id) >= 2),
);

/** A provisional notify decision — same `{push, message}` shape the off-ladder tracks use. */
export interface ProvisionalDecision {
  push: boolean;
  message: NtfyMessage | null;
  /** The reading that triggered it (null when not pushing) — for logging/tests. */
  candidate: Reading | null;
}

/** ntfy priority: strictly between `LEVEL_PRIORITY.WATCH` (2) and `WARNING` (4) — a
 *  provisional is louder than a watch and quieter than a confirmed warning. */
const PROVISIONAL_PRIORITY = 3;

/**
 * The push payload for one raw-RED candidate. Title is an HTTP header ⇒ **ASCII only**
 * (`ntfyHeaders` sets it verbatim), and follows `notify_format.ts`'s `crash-dash - ` prefix.
 * The leg clause renders through `legPhrase` (`LEG_PHRASE` + composite fallthrough) — the SAME
 * wording the FE ribbon tooltip renders, so the
 * push and the chart cannot disagree — and is OMITTED entirely when `rawLeg` is undefined
 * (the bespoke scorers G1/R7/F13/F10 attribute no leg).
 *
 * The confirm depth is DERIVED from `confirmClosesFor`, never typed. The `awaiting` clause is
 * OMITTED at zero (a symmetric-zero vintage rendered the gibberish "awaiting 0-close confirm")
 * and renders the tier for ids carrying one — unreachable today either way: under instant-up
 * (2026-08-26) no candidate exists to message.
 */
export function buildProvisionalMessage(reading: Reading, asOf: string): NtfyMessage {
  const id = reading.indicator.id;
  const phrase = reading.rawLeg === undefined ? undefined : legPhrase(reading.rawLeg);
  const via = phrase === undefined ? "" : ` - via ${phrase}`;
  const closes = confirmClosesFor(id);
  const awaiting = closes > 0 ? `, awaiting ${closes}-close confirm` : "";
  return {
    title: `crash-dash - PROVISIONAL - unconfirmed RED ${id}`,
    body: `${id} raw RED${awaiting}${via}.\nunconfirmed - may revert tomorrow.\nas of ${asOf}`,
    tags: "warning",
    priority: PROVISIONAL_PRIORITY,
  };
}

/**
 * Should this run send a provisional push?
 *
 * A CANDIDATE is a reading whose raw state has gone RED while the confirmed state has not
 * (`rawState === "RED" && state !== "RED"`) and whose id is in `PROVISIONAL_IDS`. Fires iff
 * a candidate exists AND the cooldown has expired.
 *
 * ⚠ The cooldown is **GLOBAL**, not per-indicator: ONE `lastProvisionalPushAt` timestamp
 * gates every id, reusing `ladder.ts`'s `REASSERT_AFTER_DAYS` and the same `Date.parse` day
 * math as `decideReassert`. That is a strict SUPERSET of the plan's "one provisional per
 * episode" constraint — a second indicator breaching inside the window is suppressed too.
 * Deliberate (the provisional is a nudge, not a feed) and the quiet direction: it can only
 * under-notify, never spam. A null timestamp (never pushed, or a pre-migration row) fires.
 *
 * On a multi-candidate day the FIRST candidate in `readings` order names the push; the
 * global cooldown then swallows the rest, so the message is deliberately singular.
 */
export function decideProvisional(
  readings: Reading[],
  lastProvisionalPushAt: string | null,
  now: string,
): ProvisionalDecision {
  const silent: ProvisionalDecision = { push: false, message: null, candidate: null };
  const candidate = readings.find(
    (r) => r.rawState === "RED" && r.state !== "RED" && PROVISIONAL_IDS.has(r.indicator.id),
  );
  if (candidate === undefined) return silent;
  if (lastProvisionalPushAt !== null) {
    const days = (Date.parse(now) - Date.parse(lastProvisionalPushAt)) / 86_400_000;
    if (days < REASSERT_AFTER_DAYS) return silent;
  }
  // Stamp the CANDIDATE's own date, never the scanned array's max: freshness is mixed here by
  // construction (FRED credit is T-1, the price feeds are T+0), so a run-level max would date an
  // F1 provisional by whatever price series happened to be newest.
  const asOf = candidate.date || now.slice(0, 10);
  return { push: true, message: buildProvisionalMessage(candidate, asOf), candidate };
}
