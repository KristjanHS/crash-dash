import type TS from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { expectClean, handlerBody, loadTs, misfires, scan, type ScanReport, scanText, type Visitor } from "./source-scan.test-helpers.js";

let ts: typeof TS;
const calls: Visitor = { visit: (n) => (ts.isCallExpression(n) && n.expression.getText() === "Date.now" ? "clock" : null) };
const text = "const a = Date.now();\nconst b = Date.now();\nfunction f() { return Date.now(); }\n";

describe("source-scan harness", () => {
  beforeAll(async () => {
    ts = await loadTs();
  });

  it("a rostered file is clean; a new hit, a stale row, an unknown kind and a failed check each fail", () => {
    const files = [{ file: "x.ts", text }];
    const clean = scan({ ...calls, files, reasons: { entry: null }, roster: [
      { file: "x.ts", code: "const a = Date.now();", count: 1, reason: "entry: a" },
      { file: "x.ts", code: "const b = Date.now();", count: 1, reason: "entry: b" },
      { file: "x.ts", code: "function f() { return Date.now(); }", count: 1, reason: "entry: f" },
    ] });
    expect([clean.unrostered, clean.stale, clean.badReason]).toEqual([[], [], []]);

    const bad = scan({ ...calls, files, reasons: { entry: (h) => (h.code.startsWith("const") ? null : "not a module const") }, roster: [
      { file: "x.ts", code: "const a = Date.now();", count: 2, reason: "entry: a" },
      { file: "x.ts", code: "const b = Date.now();", count: 1, reason: "guess: b" },
      { file: "x.ts", code: "function f() { return Date.now(); }", count: 1, reason: "entry: f" },
      { file: "x.ts", code: "const gone = Date.now();", count: 1, reason: "entry:" },
      { file: "x.ts", code: "const b = Date.now();", count: 1, reason: "entry: b again" },
    ] });
    expect(bad.unrostered).toEqual([]);
    expect(bad.stale).toEqual([
      "x.ts: pinned 2×, found 1× - const a = Date.now();",
      "x.ts: pinned 1×, found 0× - const gone = Date.now();",
      "x.ts: duplicate row - const b = Date.now();",
    ]);
    expect(bad.badReason).toEqual([
      "x.ts: reason kind \"guess\" ∉ {entry} - const b = Date.now();",
      "x.ts:3 [entry] not a module const - function f() { return Date.now(); }",
      "x.ts: reason kind \"entry:\" ∉ {entry} - const gone = Date.now();",
    ]);
    const partial = scan({ ...calls, files, keep: (h) => h.line > 1, reasons: { entry: null }, roster: [{ file: "x.ts", code: "const b = Date.now();", count: 1, reason: "entry: b" }] });
    expect(partial.unrostered).toEqual(["x.ts:3 [clock] function f() { return Date.now(); }"]);
  });

  it("`expectClean` fails on each class alone, and prints every failing class in one message", () => {
    const msg = { what: "w", why: "y", move: "m", never: "n" };
    const only = (p: Partial<ScanReport>): ScanReport => ({ hits: [], unrostered: [], stale: [], badReason: [], ...p });
    expect(() => expectClean(only({}), msg)).not.toThrow();
    expect(() => expectClean(only({ unrostered: ["u"] }), msg)).toThrow(/UNROSTERED — w: y\n {2}the move: m\n {2}never: n\n {2}u/);
    expect(() => expectClean(only({ stale: ["s"] }), msg)).toThrow(/STALE ROW/);
    expect(() => expectClean(only({ badReason: ["b"] }), msg)).toThrow(/BAD REASON/);
    expect(() => expectClean(only({ unrostered: ["u"], badReason: ["b"] }), msg)).toThrow(/UNROSTERED[\s\S]*BAD REASON/);
  });

  it("`handlerBody` reaches the code a catch clause, `.catch(fn)` and `.then(ok, fn)` run", () => {
    const body: Visitor = {
      visit: (n) => (ts.isCatchClause(n) || (ts.isCallExpression(n) && /\.(catch|then)$/.test(n.expression.getText())) ? "h" : null),
    };
    const src = "try { a(); } catch { warn(1); }\np.catch(() => warn(2));\np.then(ok, (e) => { warn(3); });\n";
    expect(scanText("h.ts", src, body).map((h) => handlerBody(h.node).getText())).toEqual(["{ warn(1); }", "warn(2)", "{ warn(3); }"]);
  });

  it("`misfires` reports an unfixtured kind, a fixture firing the wrong kind, and a decoy hit", () => {
    expect(misfires(calls, ["clock"], [["Date.now();", "clock"]], ["new Date();"])).toEqual([]);
    expect(misfires(calls, ["clock", "tz"], [["now();", "clock"]], ["Date.now();"])).toEqual([
      "no fixture fires tz",
      "fixture wants clock, got nothing: now();",
      "decoy hit [clock]: Date.now();",
    ]);
  });
});
