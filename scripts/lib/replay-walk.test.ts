import { describe, expect, it, vi } from "vitest";

import type { State } from "../../src/domain-types.js";
import type { SeriesPoint } from "../../src/store.js";
import {
  ffillReadings,
  loadSeriesWith,
  makeCursor,
  panelAt,
  unionCalendar,
  walkReplay,
} from "./replay-walk.js";

const pt = (date: string, state: State = "GREEN"): SeriesPoint => ({
  date,
  value: 1,
  delta20: 0,
  rawState: state,
  state,
});

describe("loadSeriesWith", () => {
  it("routes every id through the injected read", async () => {
    const seen: string[] = [];
    const got = await loadSeriesWith(async (id) => {
      seen.push(id);
      return [pt("2026-01-02")];
    }, ["A", "B"]);
    expect(seen.sort()).toEqual(["A", "B"]);
    expect(got.get("A")).toHaveLength(1);
    expect(got.get("B")).toHaveLength(1);
  });

  it("truncates each series to asOf, inclusive of the asOf date itself", async () => {
    const got = await loadSeriesWith(
      async () => [pt("2026-01-01"), pt("2026-01-02"), pt("2026-01-03")],
      ["A"],
      { asOf: "2026-01-02" },
    );
    expect(got.get("A")!.map((p) => p.date)).toEqual(["2026-01-01", "2026-01-02"]);
  });

  // The ABORT branch: no probe run ever enters it, so a byte-diff of the rewired probes cannot
  // cover it — and the fail-loud is the module's stated load-bearing contract.
  it("ABORTs naming the failed id when the injected read rejects", async () => {
    const exit = vi.fn((_code: number): never => {
      throw new Error("process.exit called");
    });
    const log = vi.fn((_msg: string) => {});
    await expect(
      loadSeriesWith(
        async (id) => {
          if (id === "B") throw new Error("feed 503");
          return [pt("2026-01-02")];
        },
        ["A", "B"],
        { log, exit },
      ),
    ).rejects.toThrow("process.exit called");
    expect(exit).toHaveBeenCalledWith(1);
    const msg = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(msg).toContain("ABORT:");
    expect(msg).toContain("B: feed 503");
    expect(msg).not.toContain("A:");
  });

  it("leaves the series untouched with no asOf", async () => {
    const got = await loadSeriesWith(
      async () => [pt("2026-01-01"), pt("2026-01-03")],
      ["A"],
      {},
    );
    expect(got.get("A")!.map((p) => p.date)).toEqual(["2026-01-01", "2026-01-03"]);
  });
});

describe("unionCalendar", () => {
  it("merges every member's dates, sorted and de-duplicated", () => {
    const seriesById = new Map<string, SeriesPoint[]>([
      ["A", [pt("2026-01-03"), pt("2026-01-01")]],
      ["B", [pt("2026-01-02"), pt("2026-01-03")]],
    ]);
    expect(unionCalendar(seriesById)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
  });

  it("restricts to the ids given", () => {
    const seriesById = new Map<string, SeriesPoint[]>([
      ["A", [pt("2026-01-01")]],
      ["B", [pt("2026-01-02")]],
    ]);
    expect(unionCalendar(seriesById, ["B"])).toEqual(["2026-01-02"]);
  });
});

describe("walkReplay", () => {
  const seriesById = new Map<string, SeriesPoint[]>([
    ["A", [pt("2026-01-01", "RED"), pt("2026-01-03", "AMBER")]],
  ]);

  it("visits the dates in order and threads the caller's fold state", async () => {
    const final = await walkReplay<string[]>({
      dates: ["2026-01-01", "2026-01-02", "2026-01-03"],
      seriesById,
      ids: ["A"],
      initial: [],
      onClose: ({ date, index, readings, state }) => [
        ...state,
        `${index}:${date}:${readings[0]?.state ?? "—"}`,
      ],
    });
    expect(final).toEqual([
      "0:2026-01-01:RED",
      "1:2026-01-02:RED", // forward-filled from the 01-01 point
      "2:2026-01-03:AMBER",
    ]);
  });

  it("awaits an async per-close body before the next close", async () => {
    const order: string[] = [];
    await walkReplay<number>({
      dates: ["2026-01-01", "2026-01-03"],
      seriesById,
      ids: ["A"],
      initial: 0,
      onClose: async ({ date, state }) => {
        await Promise.resolve();
        order.push(`${date}#${state}`);
        return state + 1;
      },
    });
    expect(order).toEqual(["2026-01-01#0", "2026-01-03#1"]);
  });

  it("drops a member whose newest point is past the horizon", async () => {
    // `initial: -1` (not 0) so a walk that never enters `onClose` FAILS rather than returning
    // the seed that happens to equal the expected empty-reading count.
    const seen = await walkReplay<number>({
      dates: ["2026-01-05"],
      seriesById,
      ids: ["A"],
      initial: -1,
      horizon: 1,
      onClose: ({ readings }) => readings.length,
    });
    expect(seen).toBe(0);
  });
});

describe("panelAt", () => {
  // A is live through 01-05; B's newest point is stale by 4 days at 01-05; C has not started.
  const seriesById = new Map<string, SeriesPoint[]>([
    [
      "A",
      [pt("2026-01-01", "GREEN"), pt("2026-01-03", "AMBER"), pt("2026-01-04"), pt("2026-01-05", "RED")],
    ],
    ["B", [pt("2026-01-01", "RED")]],
    ["C", [pt("2026-01-10", "RED")]],
  ]);
  const ids = ["A", "B", "C"];

  it("emits ffillReadings' member set, and drops an absent member from BOTH lists", () => {
    const panel = panelAt(seriesById, ids, "2026-01-05", { historyLen: 90, horizon: 2 });
    // Non-vacuous: B is dropped by the horizon and C has no point at all, so the two lists are
    // being compared over a fixture where a WIDER or NARROWER presence rule would disagree.
    expect(panel.readings).toEqual([{ id: "A", state: "RED" }]);
    expect(panel.cissHistory.map((h) => h.id)).toEqual(["A"]);
    expect(panel.readings).toEqual(
      ffillReadings(seriesById, makeCursor(seriesById), ids, "2026-01-05", 2),
    );
  });

  it("ends each slice at the forward-filled point and caps it at historyLen", () => {
    const panel = panelAt(seriesById, ["A"], "2026-01-04", { historyLen: 2 });
    expect(panel.cissHistory[0]!.history.map((p) => p.date)).toEqual(["2026-01-03", "2026-01-04"]);

    // Forward-filled close: the slice must still end at 01-05, not run on to a later point.
    const filled = panelAt(seriesById, ["A"], "2026-01-06", { historyLen: 2 });
    expect(filled.cissHistory[0]!.history.map((p) => p.date)).toEqual(["2026-01-04", "2026-01-05"]);
  });
});

describe("ffillReadings horizon (unchanged contract)", () => {
  const seriesById = new Map<string, SeriesPoint[]>([["A", [pt("2026-01-01", "RED")]]]);
  const at = (d: string, horizon: number) =>
    ffillReadings(seriesById, makeCursor(seriesById), ["A"], d, horizon);

  it("fills at a gap exactly equal to the horizon", () => {
    expect(at("2026-01-03", 2)).toEqual([{ id: "A", state: "RED" }]);
  });

  it("drops at a gap strictly larger than the horizon", () => {
    expect(at("2026-01-04", 2)).toEqual([]);
  });
});
