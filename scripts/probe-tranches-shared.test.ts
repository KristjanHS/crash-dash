/** A function two `scripts/probe-*-tranches.ts` both define is a copy unless it is a `LEG_BINDINGS` / `LEG_LOCALS` wrapper over a shared kernel
 *  or a body of the leg's own; a new shared name is extracted (`ladder-tranche.ts`, `ladder-replay.ts`), never listed. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(import.meta.dirname);
/** The leg probes plus a leg module peeled out of one (`semis-watch.ts`). */
const PROBES = readdirSync(DIR).filter((f) => /^(?:probe-[a-z0-9]+-tranches|semis-watch)\.ts$/.test(f));

/** Names every leg defines over its own rules/series/roster — the leg's API that the run, skills and tests call. */
const LEG_BINDINGS = new Set([
  "asProbeResult", "boxBinds", "escalation", "evaluateShipped", "famNeed", "firesAt", "followed", "followOf", "liveLimit",
  "liveReverdict", "openExit", "ruledCells", "ruledReads", "tally", "tranchesAt", "unservedReadsEmpty", "verdictProvisional", "watchAt", "whyFills",
]);
/** Module-local names a leg binds to its own ids/feeds/roster, or whose body is the leg's own rows, text or rules. */
const LEG_LOCALS = new Set([
  "allOf", "bp", "eachId", "escLeg", "fam", "fetchSeries", "gateOf", "legsAt", "liveFetch", "liveSet", "memo", "needOf", "readIds", "readyAt", "table", "veto", "volOf", "volRung",
]);

/** The top-level function names a source defines, exported or not (declarations and arrow consts; re-exports and data tables excluded). */
export const topLevelFunctions = (src: string): string[] =>
  [...src.matchAll(/^(?:export )?(?:async )?function ([A-Za-z0-9_]+)|^(?:export )?const ([A-Za-z0-9_]+) = (?:async )?(?:<[^=\n]*>)?\(/gm)].map((m) => (m[1] ?? m[2])!);

/** name → the probes that define it, for names defined by two or more. */
const sharedNames = (files: Record<string, string>): Map<string, string[]> => {
  const by = new Map<string, string[]>();
  for (const [f, src] of Object.entries(files)) for (const n of new Set(topLevelFunctions(src))) by.set(n, [...(by.get(n) ?? []), f]);
  return new Map([...by].filter(([, fs]) => fs.length > 1));
};

describe("leg probes share code by import, not copy", () => {
  const files = Object.fromEntries(PROBES.map((f) => [f, readFileSync(join(DIR, f), "utf8")]));
  const shared = sharedNames(files);

  it("reads the leg probes", () => {
    expect(PROBES).toContain("probe-value-tranches.ts");
    expect(PROBES.length).toBeGreaterThan(1);
  });

  it("no two probes define the same top-level function outside the per-leg bindings — extract it into a shared module instead", () => {
    const copies = [...shared].filter(([n]) => !LEG_BINDINGS.has(n) && !LEG_LOCALS.has(n)).map(([n, fs]) => `${n}: ${fs.join(", ")}`);
    expect(copies).toEqual([]);
  });

  it("no probe redefines a function the shared kernels export — import it", () => {
    const exported = (src: string): string[] => topLevelFunctions(src.split("\n").filter((l) => l.startsWith("export ")).join("\n"));
    const kernel = new Set(["ladder-tranche.ts", "ladder-replay.ts"].flatMap((f) => exported(readFileSync(join(DIR, f), "utf8"))));
    expect(kernel.has("tallyOf")).toBe(true);
    expect(Object.entries(files).flatMap(([f, src]) => topLevelFunctions(src).filter((n) => kernel.has(n)).map((n) => `${n}: ${f}`))).toEqual([]);
  });

  it("every listed binding or local is still defined by two or more probes (a stale entry would let a copy back in)", () => {
    expect([...LEG_BINDINGS, ...LEG_LOCALS].filter((n) => !shared.has(n))).toEqual([]);
  });

  it("the scan sees exported and module-local declarations and arrow consts, not re-exports or data", () => {
    const src = ["export function a() {}", "export async function b() {}", "export const c = (x: number) => x;", "export const d = <T,>(x: T) => x;", "export const E = [1];", 'export { f } from "./x.js";', "const g = () => 1;", "function h() {}", "const i = async (x: number) => x;", "  const j = () => 1;"].join("\n");
    expect(topLevelFunctions(src)).toEqual(["a", "b", "c", "d", "g", "h", "i"]);
  });
});
