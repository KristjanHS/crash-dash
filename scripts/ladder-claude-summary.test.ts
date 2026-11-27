// scripts/ladder-claude-summary.mjs exit codes — 3 is the real run's WebFetch check (the invalid-key preflight can't see it).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "ladder-summary-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function summarize(transcript: string, flags: string[] = []) {
  const f = join(dir, "t.json");
  writeFileSync(f, transcript);
  return spawnSync("node", ["scripts/ladder-claude-summary.mjs", ...flags, f, join(dir, "denied"), join(dir, "res")], { encoding: "utf8" });
}
const exitOf = (transcript: string): number | null => summarize(transcript).status;
const init = (tools: string[]) => ({ type: "system", subtype: "init", permissionMode: "default", tools });
const result = { type: "result", subtype: "success", result: "done" };

describe("ladder-claude-summary exit", () => {
  test("init lists WebFetch → 0", () => {
    expect(exitOf(JSON.stringify([init(["Task", "Bash", "WebFetch", "WebSearch", "Write"]), result]))).toBe(0);
  });
  test("init lacks WebFetch → 3", () => {
    expect(exitOf(JSON.stringify([init(["Task", "Bash", "WebSearch", "Write"]), result]))).toBe(3);
  });
  test("no result outranks a missing WebFetch → 2", () => {
    expect(exitOf(JSON.stringify([init(["Task", "Bash", "WebSearch", "Write"])]))).toBe(2);
  });
});

describe("ladder-claude-summary stdout", () => {
  const say = (id: string, content: object[], parent?: string) => ({ type: "assistant", ...(parent && { parent_tool_use_id: parent }), message: { id, content } });
  const apply = (id: string) => ({ type: "tool_use", id, name: "Bash", input: { command: "npm run -s semis:apply -- p.json && git commit -q -m x && git log -1 --format=%h" } });
  const back = (id: string, content: string, is_error = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });
  const out = summarize(JSON.stringify([
    init(["WebFetch"]),
    say("m1", [{ type: "text", text: "applying" }]), say("m1", [apply("t1")]), back("t1", "semis: 2 changed\nabc1234"),
    say("s1", [{ type: "text", text: "research" }], "a1"),
    say("m2", [apply("t2")]), back("t2", "semis:apply — refused", true),
    say("m3", [{ type: "text", text: "done" }]), result,
  ])).stdout;
  test("prints the last successful apply result, not a later failed one", () => {
    expect(out).toContain("semis: 2 changed\nabc1234");
    expect(out).not.toContain("refused");
  });
  test("turns = distinct main-model message ids", () => {
    expect(out).toContain("· turns 3]");
  });
});

describe("ladder-claude-summary --research (runner pre-run transcript)", () => {
  const web = { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "w1", name: "WebSearch", input: { query: "q" } }] } };
  const warning = "main model made 1 web call(s)";
  test("default mode warns on a main-model web call", () => {
    expect(summarize(JSON.stringify([init(["WebFetch", "WebSearch"]), web, result])).stderr).toContain(warning);
  });
  test("--research drops that warning and still reads the transcript", () => {
    const r = summarize(JSON.stringify([init(["WebFetch", "WebSearch"]), web, result]), ["--research"]);
    expect(r.stderr).not.toContain(warning);
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, "res"), "utf8")).toBe("done");
  });
  test("--research keeps the WebFetch check → 3", () => {
    expect(summarize(JSON.stringify([init(["WebSearch"]), web, result]), ["--research"]).status).toBe(3);
  });
});
