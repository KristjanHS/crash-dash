/**
 * GET /api/exposure — the two-key exposure dial (slice E1, Stage 2).
 *
 * Computes the CURRENT-state posture (Full / Core / Reduced / Defensive) server-side
 * from the persisted F1 (HY OAS, ARM = credit) and GT (ACWI trend, FIRE) series
 * via the pure src/exposure.ts engine — no client-side rule math. Read-only, no
 * ntfy (the cron path owns the posture-change push, Stage 4), deterministic.
 *
 * Degrade-per-member (the cissHistory idiom, api/lab.ts:241): each getSeries has
 * a `.catch(() => [])`, so a store hiccup yields a degraded 200 (posture null),
 * never a 500. An empty pre-first-cron DB likewise returns 200 with posture null
 * (the honest "warming up" shape — this endpoint needs no verdict row, so no
 * /lab-style 404). Vercel Node function (Web-handler signature).
 */
import { getStore, type ReadStore } from "../src/store.js";
import { getPrintSeries } from "../src/estimated.js";
import { readIntradaySlot, servedVerdict } from "../src/intraday.js";
import { rungOfSleeve } from "../src/families.js";
import {
  EXPOSURE_F1_LIMIT,
  EXPOSURE_GT_LIMIT,
  EXPOSURE_THRESHOLDS,
  applyCompoundFloor,
  applyOverlayStepDown,
  computeExposure,
  withholdExposureStats,
  type ExposureResult,
} from "../src/exposure.js";
import { resolvePersistedCashLevel } from "../src/cash-overlay.js";
import { serveRedactable } from "../src/api/http.js";
import { readEnv } from "../src/config.js";

// param OPTIONAL + read via `request?`: the exposure.test.ts pins call GET() with
// no argument (the lab.test.ts pattern), so a required param would fail
// `tsc --noEmit` (TS2554).
/** The Vercel entry point: takes no params (the request carries nothing it reads), so a platform-passed argument
 *  can never be mistaken for a store. Store use goes through `handle` (rung 8a). */
export async function GET(): Promise<Response> {
  return handle(getStore("ro", readEnv()));
}

/** The redacted response body: `arm.level` (the raw F1 HY-OAS print) nulled, `arm.roc` (the F1 30d change) nulled with
 *  `summary`'s ROC slot "—", and `fire.maSpread` (GT's ACWI-vs-MA200 spread) nulled (`withholdExposureStats`, 3.5b —
 *  statistics over ONE licensed input); the percentile, verdicts and posture stay. Pure — `serveRedactable`'s redact. */
function redactExposure<T extends ExposureResult>(raw: T): T {
  const withheld = withholdExposureStats(raw);
  return { ...withheld, arm: { ...withheld.arm, level: null } };
}

// The injectable seam (rung 8a): tests pass a seeded InMemoryStore. A plain ReadStore (no thunk):
// this handler has no param check, so the store was always resolved first thing.
export async function handle(store: ReadStore, opts: { warn?: (...args: unknown[]) => void } = {}): Promise<Response> {
  return serveRedactable(exposureBody(store, opts.warn ?? console.warn), redactExposure);
}

/** The FULL `/exposure` body (`arm.level` in place). Exported so a suite asserting on the redactable fields reads
 *  them before `handle`'s response rule. */
export async function exposureBody(store: ReadStore, warn: (...args: unknown[]) => void) {
  // Fetch both histories in parallel; each degrades to [] on a store hiccup so a
  // single feed's failure yields a degraded 200 rather than aborting the response.
  // Bounds are single-sourced in src/exposure.ts — this handler and the cron path
  // (run-core.ts's seedSeriesWithRun re-slice) MUST read the same depths or the two
  // disagree about which window `scanArmLatch` sees.
  // `verdict`: the served alert row, read for the three columns the R8 bind needs —
  // `heldSleeve` (the held ladder rung the compound floor needs, which `computeExposure` — pure,
  // rung-blind — cannot see) plus `r4Phase`/`cashOverlay` (the published cash level the Stage-2
  // overlay step-down keys off, below). Same degrade-per-member `.catch` as the two series reads,
  // so a store hiccup leaves the posture rung-BLIND (unbounded) rather than 500-ing.
  // Rederive (ruled 2026-10-05): the row is the SERVED verdict (`servedVerdict`) — a newer daytime
  // `intraday_verdict` slot outranks the EOD row, as on `/status` and `/lab`; a failed slot read degrades to EOD.
  const [f1, gt, eodVerdict, slot] = await Promise.all([
    getPrintSeries(store, "F1", EXPOSURE_F1_LIMIT).catch(() => []), // prints only, as the cron read (E25 carry rows)
    getPrintSeries(store, "GT", EXPOSURE_GT_LIMIT).catch(() => []),
    // `Promise.resolve().then(...)`, not a bare call: this must degrade on a store that throws
    // SYNCHRONOUSLY (or lacks the method) exactly as the two `.catch`es above degrade on a
    // rejection — the handler's contract is a degraded 200, never a 500.
    Promise.resolve().then(() => store.getLastAlert()).catch((err: unknown) => {
      warn("[exposure] verdict read failed - serving the rung-blind posture:", err);
      return null;
    }),
    readIntradaySlot(store, "exposure"),
  ]);
  const verdict = servedVerdict(eodVerdict, slot);
  // `rungOfSleeve` (families.ts) is the ONE sleeve-name → 1..9 rung map, shared with the run path
  // so both R8 surfaces read the SAME persisted string the SAME way — including a sleeve that has
  // been RENAMED out of LADDER, which both must treat as rung-blind (null), never as rung 0.
  const heldSleeve = verdict?.heldSleeve ?? null;
  const riskRank = rungOfSleeve(heldSleeve);

  // Newest date across the two series (each oldest→newest, so `.at(-1)` is newest);
  // null when both are empty.
  const f1AsOf = f1.at(-1)?.date ?? null;
  const gtAsOf = gt.at(-1)?.date ?? null;
  const asOf =
    f1AsOf && gtAsOf ? (f1AsOf > gtAsOf ? f1AsOf : gtAsOf) : f1AsOf ?? gtAsOf;

  // `thresholds`: the ARM/FIRE cuts, served so the chip footnotes can print live literals
  // with ZERO numeric copy in public/ (R1 seam ruling, 2026-07-26). Static per deploy — the
  // cost of re-sending them each load was accepted deliberately over a client-side mirror.
  // R8 Stage 1 — the served posture is the COMPOUND-FLOOR-BOUNDED one. Both surfaces or neither:
  // the run path (`assembleRun`) bounds the same way off the same resolver, so the push and this
  // response can never report different postures for the same close.
  // R8 Stage 2 — the OVERLAY STEP-DOWN, applied AFTER the floor (that order is the round-3 ruling)
  // and off the same `resolveCash` precedence the run path uses, so a `partial` that R4 outranks or
  // suppresses moves nothing here either. The cash inputs come off the SAME persisted verdict row
  // as `heldSleeve` above — this handler holds no live overlay — and a missing/degraded row reads as
  // the resting `equity`/`off` pair, i.e. no step-down, matching the floor's rung-blind passthrough.
  const bounded = applyCompoundFloor(computeExposure(f1, gt), riskRank);
  const publishedCashLevel = resolvePersistedCashLevel(
    verdict?.r4Phase ?? null,
    verdict?.cashOverlay ?? "off",
    bounded.equityPct,
  );
  const body = {
    ...applyOverlayStepDown(bounded, publishedCashLevel),
    asOf,
    thresholds: EXPOSURE_THRESHOLDS,
    // The posture's held rung / cash level came off the daytime slot — the page marks it INTRADAY.
    ...(verdict !== null && verdict === slot ? { provisional: true as const } : {}),
  };
  // Same vintage policy as /status and /lab (serveRedactable's default headers, `VINTAGE_HEADERS`): the posture
  // moves once per weekday, and the cron's `VINTAGE_TAG` purge — not the TTL — is what makes a new run visible.
  return body;
}
