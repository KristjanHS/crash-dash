// W5-a — CROSS-IMPLEMENTATION parity for the single cash claim
//.
//
// Why this file exists, and why it is `.js` in `public/`:
// `resolveCash` (src/cash-overlay.ts) is the source of truth for cash precedence. Three paths
// reach a user:
//   1. `resolveCash`            — src/cash-overlay.ts  (the truth)
//   2. `resolveCashClaim`       — public/cash-overlay-view.js  (the /lab footer chip) — still a
//      hand-kept MIRROR: the /lab wire carries no `R4Result`, so it cannot call the real function.
//   3. `cashOverlayNote`        — src/notify_format.ts `buildNotification`  (the push body) — as of
//      W5-b Stage 4.2 this CALLS `resolveCash` rather than restating it, which is what makes the
//      declared truth a live production dependency instead of a test-only one.
// Only (2) can now desynchronise from (1) silently — this file is what stops it, and it pins the
// SCALAR (`nonEquityPct`) as well as the level, since Stage 4.1 sized the claim.
// This file feeds the FULL R4 × overlay product to all three and asserts exactly ONE cash
// magnitude across the set. It is a plain `.js` test because only `public/*.test.js` may import
// both a `public/*.js` seam module and `../src/*.ts` (tsc skips `.js`; vitest collects it).
//
// It also pins the NON-OBVIOUS PREMISE the surfaces rest on: `resolveCash` branches on `r4.cash`
// while `alert-band.ts`'s escalator floor (and `api/lab.ts`'s r4 view, which feeds the chip's
// derived `cash`) branches on `phase === "cash"`. Those agree only because every
// `cash: true` return in `src/r4.ts` also carries `phase: "cash"` — an internal coincidence that
// was neither typed nor tested until the last describe block below.
import { describe, it, expect } from "vitest";
import { resolveCash } from "../src/cash-overlay.ts";
import { EQUITY_PCT } from "../src/exposure.ts";
import { computeR4, R4_REENTRY_START } from "../src/r4.ts";
import { buildNotification } from "../src/notify_format.ts";
import { cashClaimHtml, resolveCashClaim } from "./cash-overlay-view.js";
import { makeDial } from "../src/test-helpers.ts";

/**
 * A full `T1DialResult` at the top of the ladder; only `targetRung`, the two firing counts and
 * `pillarsLive` matter to `computeR4`.
 *
 * Built through the shared `makeDial` + `DialOverrides` so one override moves the whole book (a bare
 * literal froze a rung-9 book and only overrode the label). `makeDial` defaults `pillarsLive: true`,
 * making the rung-clear EXIT leg reachable — the reachability test at the bottom pins that it fires.
 *
 * `leaderSplit: 1` reproduces the old hand-typed `{lo: 7, hi: 9}` through `dialBandFor`, and
 * `creditFiring: true` earns the "Crisis" label the crisis gate would otherwise demote — consistent
 * with `leadingFiring: 2`.
 */
function dial(over = { targetRung: 9 }) {
  return makeDial(
    {
      leadingFiring: 2,
      coincidentFiring: 2,
      leadingP: 1,
      coincidentP: 1,
      positionP: 1,
      armed: true,
      fired: true,
      ...over,
    },
    { leaderSplit: 1, creditFiring: true },
  );
}

/** The K5 posture axis. Stage 4.2 made it a real axis: all three implementations now carry the
 *  scalar, so the product below sweeps posture too.
 *
 *  ⚠ `Full` is the load-bearing case, not a filler. It yields `nonEquityPct === 0` — FALSY, and a
 *  REAL size. Any mirror written `if (claim.nonEquityPct)` renders fully-invested identically to a
 *  degraded `null`, and without this fixture that bug ships green. `Core` (30) is the distinctive
 *  non-boundary value; `null` is the degraded posture, the only case allowed to render unsized. */
const POSTURE_CASES = [
  { name: "Core", equityPct: EQUITY_PCT.Core },
  { name: "Full", equityPct: EQUITY_PCT.Full },
  { name: "degraded", equityPct: null },
];

/** `pushBody`'s default posture — the level read-back is posture-invariant. */
const POSTURE_EQUITY = EQUITY_PCT.Core;

/** The R4 axis — one representative `R4Result` per reachable phase. */
const R4_CASES = [
  { name: "equity", r4: { cash: false, phase: "equity", entryFiredAt: null, reentryRung: null, reason: "calm" } },
  { name: "cash", r4: { cash: true, phase: "cash", entryFiredAt: "2026-07-01T00:00:00Z", reentryRung: null, reason: "entered cash" } },
  { name: "reentry", r4: { cash: false, phase: "reentry", entryFiredAt: null, reentryRung: R4_REENTRY_START, reason: "re-entry - rung 6" } },
];

/** The overlay axis — the two magnitudes `computeCashOverlay` can emit. */
const OVERLAY_CASES = [
  {
    name: "partial",
    overlay: {
      level: "partial",
      since: "2026-07-18T00:00:00Z",
      reason: "target rung 3→5 (+2) within 3 closes",
      nonEquityPct: null,
      recentTargetRungs: [3, 5],
    },
  },
  {
    name: "off",
    overlay: {
      level: "off",
      since: null,
      reason: "no acceleration (+0 over 2 closes)",
      nonEquityPct: null,
      recentTargetRungs: [5, 5],
    },
  },
];

/** What the PUSH BODY claims, reduced to the same three-state magnitude the other two return.
 *  `buildNotification` speaks cash in two places: the `R4:` line (R4's voice) and the
 *  `Cash overlay: partial` line (the overlay's). Reading both back is what makes this a real
 *  third implementation and not a restatement of `cashOverlayNote`'s own condition. */
function pushBody(r4, overlay, equityPct = POSTURE_EQUITY) {
  const { message } = buildNotification(
    null, // no prior row ⇒ an upward transition ⇒ the push fires and a body exists
    "WARNING",
    undefined,
    undefined,
    [],
    "2026-07-18",
    {
      r4,
      // run-core.ts hands the raw overlay result through; `full` is unreachable by construction.
      cashOverlay: { level: overlay.level, reason: overlay.reason },
      equityPct,
    },
  );
  return message.body;
}

function bodyCashLevel(r4, overlay) {
  const body = pushBody(r4, overlay);
  const saysOverlayPartial = body.includes("Cash overlay: partial");
  const saysR4Cash = body.includes("\nR4: cash");
  const saysR4Reentry = body.includes("\nR4: reentry");
  // Exactly-one-magnitude at the BODY level: R4's terminal cash and the overlay's partial must
  // never both appear in one push.
  expect(saysOverlayPartial && saysR4Cash).toBe(false);
  if (saysR4Cash) return "full";
  if (saysR4Reentry) return "off"; // R4 is walking back onto the ladder; the overlay is suppressed
  return saysOverlayPartial ? "partial" : "off";
}

// W5-b Stage 4.2 — the SCALAR, not just the level. `resolveCash` now has a production caller
// (`cashOverlayNote` in src/notify_format.ts), so the push body renders the number and the /lab chip
// mirrors it. Both must branch on `nonEquityPct === null`, never on truthiness.
describe("cash SIZE - the scalar agrees across all three implementations, posture axis included", () => {
  /** The size the PUSH BODY renders, read back out of the rendered line. `null` = the line is
   *  absent (no partial claim); `"unsized"` = it rendered the degraded copy. */
  function bodyCashSize(r4, overlay, equityPct) {
    const line = pushBody(r4, overlay, equityPct)
      .split("\n")
      .find((l) => l.startsWith("Cash overlay: "));
    if (!line) return null;
    if (line.includes("not yet sized")) return "unsized";
    // E10b: zero carries the extra `fully invested — ` clause, so the scalar is no longer flush
    // against "heads-up only, ". The group still captures the NUMBER — this reader compares
    // scalars, and the copy itself is pinned separately in the vacuity guard below.
    const m = /heads-up only, (?:fully invested - )?(-?\d+)% cash/.exec(line);
    if (!m) throw new Error(`unparseable cash overlay line: ${line}`);
    return Number(m[1]);
  }

  /** Same read-back for the /lab chip's rendered HTML. */
  function chipCashSize(r4, overlay, equityPct) {
    const html = cashClaimHtml(r4, overlay, equityPct);
    if (html === "") return null;
    // B-22: a HELD-BACK overlay paints a muted chip but carries NO size (a hold has no position),
    // so it has no rendered scalar to compare — same as an empty render for this SIZE table.
    if (html.includes("cash-claim-suppressed")) return null;
    if (html.includes("not yet sized")) return "unsized";
    // E10b: zero carries the extra `fully invested — ` clause, so the scalar is no longer flush
    // against "heads-up only, ". The group still captures the NUMBER — this reader compares
    // scalars, and the copy itself is pinned separately in the vacuity guard below.
    const m = /heads-up only, (?:fully invested - )?(-?\d+)% cash/.exec(html);
    if (!m) throw new Error(`unparseable cash chip: ${html}`);
    return Number(m[1]);
  }

  for (const { name: r4Name, r4 } of R4_CASES) {
    for (const { name: ovName, overlay } of OVERLAY_CASES) {
      for (const { name: pName, equityPct } of POSTURE_CASES) {
        it(`r4=${r4Name} × overlay=${ovName} × posture=${pName} - one scalar, three implementations`, () => {
          const truth = resolveCash(r4, overlay, equityPct);
          const claim = resolveCashClaim(r4, overlay, equityPct);
          const level = r4.cash ? "full" : r4.phase === "reentry" ? "off" : overlay.level;
          expect([claim.level, bodyCashLevel(r4, overlay), truth.level]).toEqual([level, level, level]);
          expect(claim.reason).toBe(truth.reason);

          // 2. the /lab chip's mirror, at the FUNCTION level — live in every state, including the
          //    ones the chip does not paint.
          expect(claim.nonEquityPct).toBe(truth.nonEquityPct);

          // …and the scalar is the one §3/DEC-15 prescribes, so all three agreeing on a WRONG
          // number still fails (the table is not self-referential).
          const expected = r4.cash ? 100 : equityPct === null ? null : 100 - equityPct;
          expect(truth.nonEquityPct).toBe(expected);

          // 3. the RENDERS. Both surfaces paint only the `partial` claim, so that is the only
          //    state where a rendered number exists to compare — and it is exactly the state the
          //    falsy-zero hazard lives in.
          const rendered = truth.level === "partial" ? (equityPct === null ? "unsized" : 100 - equityPct) : null;
          expect(bodyCashSize(r4, overlay, equityPct)).toBe(rendered);
          expect(chipCashSize(r4, overlay, equityPct)).toBe(rendered);
        });
      }
    }
  }

  it("VACUITY GUARD - a rendered 0% (the falsy `Full` size) is painted on both surfaces", () => {
    // Without this, a mirror written `if (claim.nonEquityPct)` could pass the table above simply
    // because no fixture ever put a 0 on a rendered surface.
    //
    // Scope, stated honestly: this does NOT inspect the sweep — it reads `EQUITY_PCT.Full`
    // directly and asserts the 0 renders. That is deliberately STRONGER than a sweep-inspection
    // would be: it survives deletion of the `Full` posture from the sweep's fixture set (which
    // would silently make the table vacuous on this axis) and still goes red.
    const r4 = R4_CASES.find((c) => c.name === "equity").r4;
    const overlay = OVERLAY_CASES.find((c) => c.name === "partial").overlay;
    expect(bodyCashSize(r4, overlay, EQUITY_PCT.Full)).toBe(0);
    expect(chipCashSize(r4, overlay, EQUITY_PCT.Full)).toBe(0);
    // The degraded copy is reserved for the degraded posture, and must NOT appear at `Full`.
    expect(pushBody(r4, overlay, EQUITY_PCT.Full)).not.toContain("not yet sized");
    expect(cashClaimHtml(r4, overlay, EQUITY_PCT.Full)).not.toContain("not yet sized");
    // E10b — zero reads as a MEASUREMENT, not an unfilled field: both surfaces say so in words,
    // and they say it identically (the mirror is the point of this file).
    expect(pushBody(r4, overlay, EQUITY_PCT.Full)).toContain("fully invested - 0% cash");
    expect(cashClaimHtml(r4, overlay, EQUITY_PCT.Full)).toContain("fully invested - 0% cash");
    // …and the clause is EXCLUSIVE to zero — a non-zero sizing must not inherit it.
    const nonZero = POSTURE_CASES.map((c) => c.equityPct).find((p) => p != null && p !== EQUITY_PCT.Full);
    expect(nonZero).toBeDefined(); // non-vacuity: a sweep of only Full/null would prove nothing here
    expect(pushBody(r4, overlay, nonZero)).not.toContain("fully invested");
    expect(cashClaimHtml(r4, overlay, nonZero)).not.toContain("fully invested");
    // …and it DOES appear when the posture is genuinely absent, so the string still has a home.
    expect(bodyCashSize(r4, overlay, null)).toBe("unsized");
    expect(chipCashSize(r4, overlay, null)).toBe("unsized");
  });
});

describe("the premise the three implementations rest on: r4.cash === (phase === 'cash')", () => {
  // `resolveCash` reads `r4.cash`; the escalator floor and the /lab r4 view read `phase === "cash"`.
  // If a future
  // `computeR4` leg ever returns `cash: true` under another phase (or `phase: "cash"` with
  // `cash: false`), the push and /lab desynchronise SILENTLY. This makes that loud.
  it("holds across every reachable computeR4 transition", () => {
    const clock = () => "2026-07-18T00:00:00Z";
    const priors = [
      { phase: "equity", entryFiredAt: null, reentryRung: null },
      { phase: "cash", entryFiredAt: "2026-05-01T00:00:00Z", reentryRung: null }, // old ⇒ ratchet-eligible
      { phase: "cash", entryFiredAt: "2026-07-17T00:00:00Z", reentryRung: null }, // fresh ⇒ not
      { phase: "reentry", entryFiredAt: null, reentryRung: R4_REENTRY_START },
    ];
    const dials = [
      dial({ targetRung: 9, leadingFiring: 2, coincidentFiring: 2 }), // deep, entering
      dial({ targetRung: 8, leadingFiring: 2, coincidentFiring: 1 }),
      dial({ targetRung: 5, leadingFiring: 1, coincidentFiring: 1 }), // mid
      dial({ targetRung: 2, leadingFiring: 0, coincidentFiring: 0 }), // clear, exiting
    ];
    const tails = [
      [null, null],
      [8, 1.2],
      [2, 0.8],
    ];

    let sawCash = false;
    let sawNonCash = false;
    for (const prior of priors) {
      for (const d of dials) {
        for (const [hy, vt] of tails) {
          const r = computeR4(d, hy, vt, prior, clock);
          expect(r.cash).toBe(r.phase === "cash");
          if (r.cash) sawCash = true;
          else sawNonCash = true;
        }
      }
    }
    // Vacuity guard: the sweep must actually reach BOTH sides, or the invariant is untested.
    expect(sawCash).toBe(true);
    expect(sawNonCash).toBe(true);
  });

  // FIXTURE-HOLE GUARD. The rung-clear EXIT leg is `dial.pillarsLive && dial.targetRung <= R4_EXIT_RUNG`
  // (`src/r4.ts`); this pins that the rung leg is live in this file's fixtures — the PILLARS half doing it.
  it("the rung-clear EXIT leg is reachable in these fixtures (it needs `pillarsLive`)", () => {
    const clock = () => "2026-07-18T00:00:00Z";
    const inCash = { phase: "cash", entryFiredAt: "2026-05-01T00:00:00Z", reentryRung: null };
    // Both tails null ⇒ the tails-clear leg cannot fire, so ONLY the rung leg can end the cash phase.
    expect(computeR4(dial({ targetRung: 2 }), null, null, inCash, clock).cash).toBe(false);
    // …and it really is the liveness half: a starved close at the same clear rung stays in cash.
    const starved = { ...dial({ targetRung: 2 }), pillarsLive: false };
    expect(computeR4(starved, null, null, inCash, clock).cash).toBe(true);
  });
});
