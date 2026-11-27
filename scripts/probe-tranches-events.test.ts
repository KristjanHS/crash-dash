/** The leg probes' event history reaches `followed`'s fast fill: each `evaluateShipped` call site (`liveReverdict`, the CLI) passes `allEvents(...)` — a retired
 *  T2-holding fizzle in `eventsDone` still counts (`allFizzled`, src/ladder-run.ts). Those sites sit in fetch / CLI code, so the pin is static. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LEGS = ["value", "spit", "sp500", "semis"] as const;
/** The non-comment lines of a probe that call `evaluateShipped(` or `followed(` (definitions excluded). */
const callLines = (src: string): string[] =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && !/function (evaluateShipped|followed)\(/.test(l) && /\b(evaluateShipped|followed)\(/.test(l));

describe("leg probes pass allEvents to evaluateShipped", () => {
  it.each(LEGS)("%s: liveReverdict + the CLI pass allEvents(...), no call passes a bare `.events`", (leg) => {
    const lines = callLines(readFileSync(join(import.meta.dirname, `probe-${leg}-tranches.ts`), "utf8"));
    const shipped = lines.filter((l) => /\bevaluateShipped\(/.test(l));
    expect(shipped.filter((l) => /\ballEvents\(\w+\)(, \w+(\.\w+)?)*\)/.test(l)), "liveReverdict + the CLI").toHaveLength(2);
    expect(lines.filter((l) => /\b\w+\.events\b/.test(l))).toEqual([]);
  });
});
