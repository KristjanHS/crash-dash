/**
 * Unit coverage for the publish path's one decision: `decidePublish` — the guard that keeps
 * `make ship` (which publishes on EVERY release, ship.sh §5b) from appending a duplicate
 * vintage into the append-only `calibration` table, WITHOUT ever skipping a real cut-point
 * change.
 *
 * Stamps here use the `+00:00` form both real producers emit (python `isoformat`, PostgREST
 * timestamptz) — a `Z` fixture would sort above the same instant lexicographically and hide
 * the fact that the comparison must be instant-based, not string-based.
 *
 * Importing this module must not publish anything — the script's entry guard is what makes
 * that true, and this suite running at all under a credential-less `npm run check` is its
 * standing falsifier (getStore() would throw and exit(1)).
 */
import { describe, expect, it } from "vitest";
import { decidePublish } from "./publish-calibration.js";
import type { CalibrationParam } from "../../src/store.js";

const param = (
  metric: string,
  value: number,
  computedAt: string,
  over: Partial<CalibrationParam> = {},
): CalibrationParam => ({
  market: null,
  mode: null,
  channel: "credit",
  metric,
  value,
  ciLow: null,
  ciHigh: null,
  method: "measured",
  nEvents: null,
  windowStart: null,
  windowEnd: null,
  notes: null,
  computedAt,
  ...over,
});

const PINNED = "2026-07-18T18:25:59+00:00";
const NEWER = "2026-08-01T06:00:00+00:00";

describe("decidePublish", () => {
  it("publishes into an empty store, keeping the file's own stamp", () => {
    const d = decidePublish([], [param("amber", 1, PINNED)]);
    expect(d.action).toBe("publish");
    expect(d).toMatchObject({ computedAt: PINNED });
  });

  it("skips when every file param is already stored with identical values", () => {
    const file = [param("amber", 1, PINNED), param("red", 2, PINNED)];
    expect(decidePublish([...file], file).action).toBe("skip");
  });

  it("publishes a VALUE change that ships under the SOURCE_DATE_EPOCH-pinned stamp", () => {
    // The regression the stamp-only guard had: the retired harness.py pinned computed_at to the committed
    // value, so real cut-point edits carried an unchanged stamp.
    const d = decidePublish([param("amber", 1, PINNED)], [param("amber", 9, PINNED)]);
    expect(d.action).toBe("publish");
    // Equal stamps tie and LOSE the `computed_at DESC` collapse — must be re-stamped later.
    if (d.action !== "publish") throw new Error("unreachable");
    expect(Date.parse(d.computedAt)).toBeGreaterThan(Date.parse(PINNED));
  });

  it("publishes a key the store is missing (a partial prior insert)", () => {
    const stored = [param("amber", 1, PINNED)];
    const file = [param("amber", 1, PINNED), param("red", 2, PINNED)];
    expect(decidePublish(stored, file).action).toBe("publish");
  });

  it("publishes a method-only change (content is more than `value`)", () => {
    const stored = [param("amber", 1, PINNED, { method: "convention" })];
    expect(decidePublish(stored, [param("amber", 1, PINNED)]).action).toBe("publish");
  });

  it("refuses to revert a NEWER stored vintage — reports stale instead of publishing", () => {
    // Ex-backtest.yml dispatches (workflow deleted 2026-08-15) left wall-clock vintages never committed back.
    const d = decidePublish([param("amber", 5, NEWER)], [param("amber", 1, PINNED)]);
    expect(d.action).toBe("stale");
  });

  it("still SKIPS a newer stored vintage whose content matches the file", () => {
    const d = decidePublish([param("amber", 1, NEWER)], [param("amber", 1, PINNED)]);
    expect(d.action).toBe("skip");
  });

  it("keys content per (market, mode, channel, metric) — a cell change is not masked", () => {
    const stored = [param("amber", 1, PINNED, { market: "ndx", mode: "bear" })];
    const file = [param("amber", 1, PINNED, { market: "ndx", mode: "correction" })];
    expect(decidePublish(stored, file).action).toBe("publish");
  });
});
