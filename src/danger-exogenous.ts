// The CONFIRMING re-risk veto, peeled from danger-engine.ts; the back-import is type-only (erased).
import type { MemberStateMap } from "./danger-engine.js";

/** The uT members that may VETO a re-risk (R4, 2026-07-18). `FAMILY_MEMBERS["uT"]` is the whole
 *  trend column — `GT, GB, F4, F5, NVDA, F6, F8` — but the US-tech proxies (F4/F5/NVDA/F6/F8) were
 *  joined onto the ledger column for DISPLAY (2026-07-13), not to gate rotation. Letting a lone weak
 *  proxy veto re-risk over-weights a single narrow leg against `indicator-loop.md` §Keep-or-cut — an indicator earns its place; the
 *  CONFIRMING gate was always meant to read the GLOBAL trend + breadth pair. Kept as an explicit
 *  subset (not a filter over the column) so a future member added to `uT` for display cannot silently
 *  re-acquire veto power. @internal */
export const CONFIRMING_TREND_MEMBERS: readonly string[] = ["GT", "GB"];

/** CONFIRMING gate predicate (Stage 3.2, narrowed R4): the trend family "confirms" a re-risk when
 *  neither GT nor GB (`CONFIRMING_TREND_MEMBERS`) is confirmed RED. `uT` reaches danger only via `legDangerShare`'s ramped trend term —
 *  this is its whole role. Reads the same confirmed member states as the field (never re-scores); an
 *  absent member is calm ⇒ confirming (a missing feed can't block re-risk, mirroring "absent can
 *  never manufacture danger"). De-risk never consults this. */
export function trendConfirming(memberState: MemberStateMap): boolean {
  // STAND-IN AUDIT (OQ-5 Stage 3.1 → RE-RULED OK in Stage 5.2): SHAPE fixed, BEHAVIOUR held. An
  // absent GT/GB still does not veto, and that is now an explicit absence test rather than a
  // `?? "calm"` that fabricated a severity. Why the behaviour is held: flipping it (absent ⇒ veto)
  // changes the ARMING/FIRING gate itself, which the OQ-5 plan puts explicitly OUT OF SCOPE (§8)
  // — it is a rotation-policy decision with its own measurement obligation, not a stand-in fix.
  // The absence is no longer destroyed: it is visible as `observed.absent` on the `uT` cell.
  return CONFIRMING_TREND_MEMBERS.every((m) => memberState[m]?.sev !== "lit");
}
