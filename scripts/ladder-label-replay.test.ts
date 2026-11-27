import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { FIXTURE, replay, RULED, ruledKey, type ReplayFixture, type ReplayResult } from "./ladder-label-replay.js";

/** Compared rows on the fixture's first run — a floor, not a pin. */
const COMPARED_FLOOR = 60;

describe("label replay", () => {
  let fixture: ReplayFixture;
  let r: ReplayResult;
  beforeAll(() => {
    fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as ReplayFixture;
    r = replay(fixture);
  });

  it("replays every session over the compared floor", () => {
    expect(r.sessions).toBe(fixture.sessions.length);
    expect(r.compared).toBeGreaterThanOrEqual(COMPARED_FLOOR);
  });
  it("mismatches only the ruled rows, every ruled row still mismatching", () => {
    expect(r.open).toEqual([]);
    expect(r.mismatches.map(ruledKey).sort()).toEqual(Object.keys(RULED).sort());
  });
  it("a flipped or dropped mechanical label is reported", () => {
    const flipped = structuredClone(fixture);
    const s = flipped.sessions[0]!;
    s.applied.mu_dio!.label = "STALE 10-01";
    expect(replay(flipped).open).toEqual([{ session: s.id, today: s.today, sign: "mu_dio", opus: "STALE 10-01", rule: "UNSOURCED", why: "no usable source" }]);
    delete s.applied.mu_dio;
    expect(replay(flipped).open).toMatchObject([{ sign: "mu_dio", opus: "—", why: "missing" }]);
  });
});
