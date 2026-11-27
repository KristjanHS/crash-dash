// W5-a Stage 3.1 — the ONE cash claim painted into the danger-ledger footer (#dfFoot),
// beside r4TailHtml. Pure string builder, zero DOM, zero module-level side effects, so
// cash-overlay-view.test.js can import it directly (FE tests run with NO jsdom and lab.js has
// module-level DOM/localStorage side effects — the tile-members.js / off-ladder-panel.js /
// scoreboard-card.js seam pattern).
//
// PRECEDENCE — this MIRRORS `resolveCash` in `src/cash-overlay.ts`
// (the source of truth). It is not a re-implementation by choice: `resolveCash` takes an `R4Result`, and the
// /lab wire does NOT have one — it has `r4.cash` / `r4.phase` read off the persisted alert row.
// Fabricating an R4Result to call the real function would invent fields the wire never carried,
// so the total is restated here in the SAME order and pinned by the test:
//   1. r4.cash        ⇒ "full"     — R4 is 100% cash; any early partial is a subset of it.
//   2. r4.phase==="reentry" ⇒ "off" — explicit branch, NOT a fallthrough: R4 is already walking
//      back onto the ladder and an early overlay re-firing here is the whipsaw D8 forbids.
//   3. cashOverlay.level === "partial" ⇒ "partial".
//   4. otherwise ⇒ "off".
// PRECEDENCE, not impossibility. A `cash` R4 and a standing `partial`
// overlay CAN both hold at once — `computeCashOverlay` and `computeR4` cannot see each other, and
// the overlay arms on `targetRung` rising `CASH_ACCEL_RUNGS` inside `CASH_ACCEL_WINDOW` (a 2-rung
// rise, NOT a 1→9 sweep), which a fall deep enough to trip R4 can easily also satisfy;
// cash-precedence-parity.test.js enumerates the pair as a live fixture. Branch 1 resolves it by
// unconditional R4 dominance, which is why only one claim PAINTS. Nothing is lost: R4's 100%
// non-equity strictly contains the overlay's `partial`, whose scalar is `100 − equityPct` — so
// ≤ 85 by the deepest EQUITY_PCT when the posture is known, and `null` when it is degraded.
//
// `cashOverlay` is LIVE-ONLY on LabResponse (absent on scenario/replay, and absent on any
// pre-migration alert row). Absent ⇒ exactly the `off` render — never a fabricated or "unknown"
// cash claim.
//
// COPY: the overlay TRIGGER stays boolean and NOTIFY-ONLY on an unvalidated trigger, so the chip
// must never read as a position instruction. W5-b Stage 4.2 sizes the claim — the chip now carries
// the standing non-equity % when the posture is known, and keeps "not yet sized" for exactly the
// degraded (`nonEquityPct === null`) case, where it is true rather than a blanket disclaimer.
import { esc } from "./chart-primitives.js";

// B-22 — hand-mirror of `V_SHAPE_SUPPRESS_PREFIX` in src/cash-overlay.ts (this /lab wire cannot import
// TS; the whole file is a documented hand-mirror). `/lab` reads the overlay straight from persisted
// columns, so no in-process discriminant survives — this prefix on the persisted `reason` is the only
// signal that an `off` overlay was v-shape-SUPPRESSED rather than merely quiet. cash-overlay-view.test.js
// generates a REAL suppressed overlay through the server's `applyFallShape` and asserts detection here, so
// a drift between this literal and the server's goes red.
const V_SHAPE_SUPPRESS_PREFIX = "v-shaped fall - early overlay suppressed";

/** Resolve the single cash claim. Mirrors `resolveCash` (src/cash-overlay.ts).
 *
 *  `equityPct` is the K5 posture's equity weight; W5-b Stage 4.2 mirrors `resolveCash`'s standing
 *  non-equity scalar off it. It is OPTIONAL because the /lab wire does not carry a posture today —
 *  omitted (or null) ⇒ `nonEquityPct: null`, the degraded case, which renders "not yet sized".
 *  Never fabricate a number here.
 *  @returns {{ level: "off"|"partial"|"full", nonEquityPct: number|null, reason: string|null,
 *    suppressedBy: "v-shape"|"r4-reentry"|null }} */
export function resolveCashClaim(r4, cashOverlay, equityPct = null) {
  // Mirrors `resolveCash`'s `standing`: live in EVERY state, `null` only when the posture is
  // degraded. R4's terminal cash is 100 BY DEFINITION and does not consult the posture, which is
  // what keeps 100 reserved for it even when `equityPct` is null.
  const standing = equityPct === null || equityPct === undefined ? null : 100 - equityPct;
  if (r4 && r4.cash) return { level: "full", nonEquityPct: 100, reason: r4.reason || null, suppressedBy: null };
  if (r4 && r4.phase === "reentry") {
    return {
      level: "off",
      nonEquityPct: standing,
      reason: r4.reason ? `r4 re-entry - overlay suppressed (${r4.reason})` : null,
      // B-22 — an r4-reentry HOLD (D8 whipsaw). Mirrors `resolveCash`; surfaced as the muted chip.
      suppressedBy: "r4-reentry",
    };
  }
  if (cashOverlay && cashOverlay.level === "partial") {
    return { level: "partial", nonEquityPct: standing, reason: cashOverlay.reason || null, suppressedBy: null };
  }
  // Mirrors `resolveCash`'s terminal branch, which carries the OVERLAY's own off-reason through
  // rather than nulling it — the overlay is the only mechanism with something to say here. The parity
  // test pins the two strings equal.
  //
  // B-22 — `suppressedBy: "v-shape"` iff the persisted reason carries the marker prefix (r4-reentry is
  // already handled above, so this branch is only plain-off vs v-shape-suppressed off; a
  // reason-presence test would misfire — a plain quiet off carries a non-null reason too).
  const reason = (cashOverlay && cashOverlay.reason) || null;
  return {
    level: "off",
    nonEquityPct: standing,
    reason,
    suppressedBy: reason && reason.startsWith(V_SHAPE_SUPPRESS_PREFIX) ? "v-shape" : null,
  };
}

/**
 * Footer chip for the resolved cash claim.
 *
 * Renders ONLY the `partial` claim. Two suppressions, for two different reasons:
 *  - `off` ⇒ "": the ledger footer already reads as fully-invested, so silence IS the off render.
 *  - `full` ⇒ "": R4's terminal cash ALREADY has two voices in this same footer — the `⛔ BREAKER`
 *    base string ("leaves equities entirely → held ▶ Cash") and `r4TailHtml`, both built in
 *    `public/lab.js`. A third "cash: full" chip painted two cash sentences side by side on the live
 *    breaker path. The chip's job is the OVERLAY's claim; R4 speaks for itself.
 *
 * `resolveCashClaim`'s precedence total is UNCHANGED — it still returns `full`, which is what keeps
 * an active overlay's `partial` suppressed underneath it. Only the RENDER is narrowed, so the §3
 * single-claim render (a `cash` R4 WINS by precedence, resolving to level `full`, over a `partial`
 * that may well be standing — the pair is reachable, not impossible) holds a fortiori.
 */
export function cashClaimHtml(r4, cashOverlay, equityPct = null) {
  const claim = resolveCashClaim(r4, cashOverlay, equityPct);

  // B-22 — a HELD-BACK overlay (v-shape or r4-reentry) paints a muted "suppressed" chip so the hold is
  // visible instead of dropping silently to "". Both sources are `level: "off"`, so this never collides
  // with R4's `full` voice or a live `partial` — the §3 single-claim render (precedence, not
  // impossibility) holds a fortiori. No size (a hold has no position); just the label and the reason that explains it.
  if (claim.suppressedBy) {
    const suppBits = [`<span class="cash-claim-label">${esc("cash overlay: suppressed")}</span>`];
    if (claim.reason) suppBits.push(`<span class="cash-claim-reason">${esc(claim.reason)}</span>`);
    return (
      ` <span class="sep">·</span> ` +
      `<span class="cash-claim cash-claim-suppressed">${suppBits.join(' <span class="sep">·</span> ')}</span>`
    );
  }

  if (claim.level !== "partial") return "";

  // ⚠ `=== null`, NEVER truthiness: the `Full` posture sizes the claim at `nonEquityPct === 0`,
  // which is falsy and is a REAL size. `if (claim.nonEquityPct)` would paint fully-invested
  // identically to degraded. `src/notify_format.ts` branches the same way; the parity test pins
  // both against `resolveCash` with a `Full` fixture.
  //
  // A lone `0% non-equity` reads as an unfilled field, so zero gets its own words. Three states,
  // not two: null = never sized, 0 = sized and fully invested, >0 = sized with a cash sleeve.
  const size =
    claim.nonEquityPct === null
      ? "not yet sized"
      : claim.nonEquityPct === 0
        ? "fully invested - 0% cash"
        : `${claim.nonEquityPct}% cash`;
  const text = `cash overlay: partial - heads-up only, ${size}`;

  const since = cashOverlay && cashOverlay.since ? cashOverlay.since : null;
  const bits = [`<span class="cash-claim-label">${esc(text)}</span>`];
  if (since) bits.push(`<span class="cash-claim-since">since ${esc(since)}</span>`);
  if (claim.reason) bits.push(`<span class="cash-claim-reason">${esc(claim.reason)}</span>`);

  return (
    ` <span class="sep">·</span> ` +
    `<span class="cash-claim cash-claim-${claim.level}">${bits.join(' <span class="sep">·</span> ')}</span>`
  );
}
