import { describe, expect, it } from "vitest";
import { parseHist, parseReplay, parseScenario, parseWalk } from "./lab-request.js";
// @ts-expect-error — public/*.js ships no .d.ts; vitest resolves it at runtime (allowJs is off).
import { LAB_LOOKBACK } from "../public/lab-lookback.js";
import { REPLAY_MAX_YEARS } from "./replay.js";

describe("parseReplay", () => {
  const nowMs = Date.parse("2026-10-05T14:30:00Z");
  const y = 2026 - REPLAY_MAX_YEARS;
  const floor = `${y}-10-05`;
  const earliest = `${y}-10-04`; // one calendar day of slack below the floor

  it("accepts a start exactly REPLAY_MAX_YEARS ago, whatever the time of day", () => {
    expect(parseReplay(`${floor}:2026-10-04`, nowMs)).toEqual({ start: floor, end: "2026-10-04" });
  });

  it("accepts one day older than the floor (a tab open past UTC midnight, clock skew)", () => {
    expect(parseReplay(`${earliest}:2026-10-04`, nowMs)).toEqual({ start: earliest, end: "2026-10-04" });
  });

  it("rejects two days older than the floor, naming the earliest date", () => {
    expect(parseReplay(`${y}-10-03:2026-10-04`, nowMs)).toEqual({
      error: `replay start older than ${REPLAY_MAX_YEARS}y - earliest ${earliest}`,
    });
  });

  it.each([
    ["not a range", "garbage", /expected YYYY-MM-DD:YYYY-MM-DD$/],
    ["one half", "2026-09-01", /expected YYYY-MM-DD:YYYY-MM-DD$/],
    ["impossible calendar dates", "2026-13-40:2026-14-50", /expected YYYY-MM-DD:YYYY-MM-DD$/],
    ["start after end", "2026-10-01:2026-09-01", /start must be before end$/],
    ["start equal to end", "2026-09-01:2026-09-01", /start must be before end$/],
    ["a span under REPLAY_MIN_SPAN_DAYS", "2026-09-01:2026-09-03", /^replay range too short/],
  ])("rejects %s", (_name, raw, error) => {
    const r = parseReplay(raw, nowMs);
    expect("error" in r && r.error).toMatch(error);
  });
});

describe("parseScenario", () => {
  it("an empty string is the all-green scenario, every option at its default", () => {
    expect(parseScenario("")).toEqual({
      states: {},
      members: {},
      options: { tail: false, sustained: false, daysInCash: 0, lag: new Set() },
    });
  });

  it("reserved knobs parse alongside family and member pairs without entering either map", () => {
    const r = parseScenario("credit:RED,F2:AMBER,tail:1,sustained:1,daysInCash:20");
    expect(r).toEqual({
      states: { credit: "RED" },
      members: { F2: "AMBER" },
      options: { tail: true, sustained: true, daysInCash: 20, lag: new Set() },
    });
  });

  it.each([
    ["bad state", "credit:PURPLE", /^bad scenario segment "credit:PURPLE"/],
    ["unknown key", "nope:RED", /^bad scenario segment "nope:RED"/],
    ["no colon", "credit", /^bad scenario segment "credit"/],
    ["tail not 0|1", "tail:2", /^bad knob "tail:2" - expected tail:0\|1/],
    ["negative daysInCash", "daysInCash:-1", /^bad knob "daysInCash:-1"/],
    ["unknown lag id", "lag:NOSUCH", /^bad knob "lag:NOSUCH"/],
    ["over-long, rejected before the split", Array.from({ length: 5000 }, () => "credit:RED").join(","), /^scenario too long/],
  ])("rejects %s", (_name, raw, error) => {
    const r = parseScenario(raw);
    expect("error" in r && r.error).toMatch(error);
  });
});

describe("parseWalk", () => {
  it("absent / non-numeric / negative is 0; WALK_CAP (90) itself is served", () => {
    expect([undefined, null, "x", "-3", "0", "90"].map(parseWalk)).toEqual([0, 0, 0, 0, 0, 90]);
  });

  it("above WALK_CAP is REJECTED with an uncached 400, never clamped", async () => {
    const r = parseWalk("91") as Response;
    expect(r.status).toBe(400);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(await r.json()).toEqual({ error: "walk must be 90 or less" });
  });
});

// The closed `?hist` key space: `hist ∈ {0, LAB_LOOKBACK}` — any other positive integer is REJECTED (400
// `no-store`, the parseWalk off-grid posture), never honoured, because a free N minted a
// caller-selectable edge-cache key with the full member-history fan-out behind every MISS. The
// handler's wire half (the 400 precedes every store read) stays in api/lab.test.ts.
describe("parseHist", () => {
  it("absent / non-integer / ≤0 is OFF (0); LAB_LOOKBACK itself is served", () => {
    expect(LAB_LOOKBACK).toBeGreaterThan(1); // premise: LAB_LOOKBACK - 1 below is a positive off-grid N
    expect([undefined, null, "x", "1.5", "-3", "0", String(LAB_LOOKBACK)].map(parseHist)).toEqual([0, 0, 0, 0, 0, 0, LAB_LOOKBACK]);
  });

  it.each([LAB_LOOKBACK - 1, LAB_LOOKBACK + 1, 9999999])("off-grid hist=%i is REJECTED with an uncached 400", async (n) => {
    const r = parseHist(String(n)) as Response;
    expect(r).toBeInstanceOf(Response);
    expect(r.status).toBe(400);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(await r.json()).toEqual({ error: `hist must be 0 or ${LAB_LOOKBACK}` });
  });
});
