import { describe, expect, it } from "vitest";

import { headObs } from "./domain-types.js";

// A3m-4: `estimated` ⇔ `source ≠ "bar"` — the ONE head-obs constructor must leave a bar head unflagged
// (a `?:` forced to its estimate branch would persist every official print as an estimate).
describe("headObs", () => {
  it("a bar head carries no `estimated` flag at all", () => {
    expect(headObs("2026-10-31", 1.5, "bar")).toStrictEqual({ date: "2026-10-31", value: 1.5, source: "bar" });
  });

  it.each(["quote", "proxyCarry"] as const)("a %s head is flagged estimated", (source) => {
    expect(headObs("2026-10-31", 1.5, source)).toStrictEqual({ date: "2026-10-31", value: 1.5, source, estimated: true });
  });
});
