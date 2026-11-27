// scripts/git-hooks/commit-msg + scripts/guard-loosen.ts: real commits in a scratch repo, scored vs HEAD.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loosening, trailerAudit } from "./guard-loosen.js";

const ROOT = join(import.meta.dirname, "..");
const CHECK = "expect([n].reduce((s, x) => { return s + x; }, 0)).toBeGreaterThan(2);";
const ROSTER = (rows: string, check = CHECK, timeout = "15_000") => `import { it } from "vitest";
const ROWS = [
  { file: "a.ts", code: "x ?? 0", count: 1, reason: "ok: absent is zero" },
  { file: "b.ts", code: "y || 1", count: 2, reason: "ok: one is identity" },${rows}
];
it("rows", () => {
  ${check}
}, ${timeout});
`;
const BASE: Record<string, string> = {
  "scripts/size-ceilings.json": '{"LIMIT":600,"ceilings":{"a.ts":750},"note":"x"}\n',
  "scripts/knip-prod-baseline.json": '["a","b"]\n',
  "eslint-suppressions.json": '{"a.ts":{"r":{"count":2}}}\n',
  "src/x-roster.test.ts": ROSTER(""),
  ".claude/hooks/h.mjs": "x\n",
  "scripts/c.snapshot.json": '{"v":1}\n',
  "src/a.ts": "a\n",
};
const TRAILER = "\n\nGuard-loosened: scripts/size-ceilings.json — the split file needs the room";

describe("commit-msg guard-loosening gate", () => {
  const tmp = mkdtempSync(join(tmpdir(), "guard-loosen-"));
  const sh = (cmd: string) => spawnSync("bash", ["-c", cmd], { cwd: tmp, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  /** Reset to the base commit, apply `files` (null = delete) or a shell `edit`, stage all, commit; → "<exit> <label>". */
  const commit = (label: string, files: Record<string, string | null>, msg = "x", edit = "", how = "git add -A && git commit -q -F .msg") => {
    sh("git reset -q --hard base && git clean -fdq");
    for (const [p, body] of Object.entries(files)) body === null ? rmSync(join(tmp, p)) : writeFileSync(join(tmp, p), body);
    writeFileSync(join(tmp, ".msg"), msg);
    const r = sh(`${edit}\n${how}`);
    return `${r.status} ${label}`;
  };
  let got: string[] = [];
  const want: string[] = [];
  const add = (exit: 0 | 1, label: string) => want.push(`${exit} ${label}`);
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  beforeAll(() => {
    for (const d of ["scripts", "src", ".claude/hooks", ".hooks"]) mkdirSync(join(tmp, d), { recursive: true });
    for (const [p, body] of Object.entries(BASE)) writeFileSync(join(tmp, p), body);
    symlinkSync(join(ROOT, "node_modules"), join(tmp, "node_modules"));
    symlinkSync(join(ROOT, "scripts/guard-loosen.ts"), join(tmp, "scripts/guard-loosen.ts"));
    copyFileSync(join(ROOT, "scripts/git-hooks/commit-msg"), join(tmp, ".hooks/commit-msg"));
    chmodSync(join(tmp, ".hooks/commit-msg"), 0o755);
    // The base commit adds a hook file, so the gate is installed only after it.
    const init = sh(`git init -q && git config user.name t && git config user.email t@t
      printf 'node_modules\\nscripts/guard-loosen.ts\\n.msg\\n.hooks\\n' > .git/info/exclude && git add -A && git commit -q -m base && git tag base
      git config core.hooksPath "${tmp}/.hooks"`);
    if (init.status !== 0) throw new Error(`fixture repo: ${init.stderr}`);
    const ceilings = (n: number) => `{"LIMIT":600,"ceilings":{"a.ts":${n}},"note":"x"}\n`;
    const raise = "python3 - <<'EOF'\nimport json\np='scripts/size-ceilings.json'\nd=json.load(open(p))\nd['ceilings']['a.ts']=900\nopen(p,'w').write(json.dumps(d))\nEOF";
    const row = '\n  { file: "c.ts", code: "z ?? 0", count: 1, reason: "ok: new" },';
    const cases: [0 | 1, string, Record<string, string | null>, string?, string?, string?][] = [
      [1, "ceiling raised by a python heredoc, no trailer", {}, "x", raise],
      [0, "same, with the trailer", {}, `x${TRAILER}`, raise],
      [1, "trailer names another path", {}, "x\n\nGuard-loosened: eslint-suppressions.json — wrong file", raise],
      [1, "pathspec commit (own index) of a raised ceiling", { "scripts/size-ceilings.json": ceilings(900) }, "x", "", "git commit -q -F .msg -- scripts/size-ceilings.json"],
      [0, "ceiling lowered", { "scripts/size-ceilings.json": ceilings(700) }],
      [0, "text-only ceilings change", { "scripts/size-ceilings.json": '{"LIMIT":600,"ceilings":{"a.ts":750},"note":"y"}\n' }],
      [1, "new ceiling key", { "scripts/size-ceilings.json": '{"LIMIT":600,"ceilings":{"a.ts":750,"b.ts":10},"note":"x"}\n' }],
      [1, "LIMIT deleted", { "scripts/size-ceilings.json": '{"ceilings":{"a.ts":750},"note":"x"}\n' }],
      [1, "LIMIT set to a string", { "scripts/size-ceilings.json": '{"LIMIT":"Infinity","ceilings":{"a.ts":750},"note":"x"}\n' }],
      [0, "ceiling key removed", { "scripts/size-ceilings.json": '{"LIMIT":600,"ceilings":{},"note":"x"}\n' }],
      [1, "LIMIT raised", { "scripts/size-ceilings.json": '{"LIMIT":601,"ceilings":{"a.ts":750},"note":"x"}\n' }],
      [1, "knip entry added", { "scripts/knip-prod-baseline.json": '["a","b","c"]\n' }],
      [0, "knip entry removed", { "scripts/knip-prod-baseline.json": '["a"]\n' }],
      [1, "knip baseline deleted", { "scripts/knip-prod-baseline.json": null }],
      [1, "knip baseline no longer JSON", { "scripts/knip-prod-baseline.json": '["a",\n' }],
      [1, "eslint suppression count rose", { "eslint-suppressions.json": '{"a.ts":{"r":{"count":3}}}\n' }],
      [0, "eslint suppression entry pruned", { "eslint-suppressions.json": "{}\n" }],
      [0, "eslint suppression count fell", { "eslint-suppressions.json": '{"a.ts":{"r":{"count":1}}}\n' }],
      [1, "roster row added", { "src/x-roster.test.ts": ROSTER(row) }],
      [1, "roster row count raised", { "src/x-roster.test.ts": ROSTER("").replace("count: 2", "count: 3") }],
      [1, "roster reason changed", { "src/x-roster.test.ts": ROSTER("").replace("ok: absent is zero", "ok: whatever") }],
      [0, "roster code re-synced", { "src/x-roster.test.ts": ROSTER("").replace("x ?? 0", "x ?? 0 // moved") }],
      [0, "roster row removed", { "src/x-roster.test.ts": ROSTER("").replace(/\n {2}\{ file: "b\.ts".*/, "") }],
      [0, "roster timeout raised", { "src/x-roster.test.ts": ROSTER("", undefined, "60_000") }],
      [0, "comment added outside the rows", { "src/x-roster.test.ts": ROSTER("", `// why\n  /* and why */ ${CHECK}`) }],
      [1, "assertion commented out in a block comment", { "src/x-roster.test.ts": ROSTER("", `/*\n  ${CHECK}\n  */`) }],
      [1, "reduce initial value changed", { "src/x-roster.test.ts": ROSTER("", CHECK.replace("}, 0)", "}, 5)")) }],
      [1, "roster check loosened outside the rows", { "src/x-roster.test.ts": ROSTER("", "expect(n).toBeGreaterThan(0);") }],
      [0, "new roster file", { "src/y-roster.test.ts": ROSTER(row) }],
      [1, "hook edited", { ".claude/hooks/h.mjs": "y\n" }],
      [0, "snapshot hand-edited (never gated)", { "scripts/c.snapshot.json": '{"v":2}\n' }],
      [0, "flip-and-restore nets zero", { "src/a.ts": "b\n" }, "x", "sed -i 's/750/900/' scripts/size-ceilings.json && sed -i 's/900/750/' scripts/size-ceilings.json"],
      [0, "unguarded source only", { "src/a.ts": "b\n" }],
    ];
    for (const [exit, label, files, msg, edit, how] of cases) {
      add(exit, label);
      got.push(commit(label, files, msg, edit, how));
    }
  }, 120_000);

  test("a loosening vs HEAD needs a Guard-loosened trailer naming its path; tightening, text, rows re-synced or removed, snapshots and net-zero diffs pass", () => {
    expect(got).toEqual(want);
  });

  test("the scorer the hook runs from the working tree is itself a gate", () => {
    expect(loosening("scripts/guard-loosen.ts", "a\n", "b\n")).toBe("edits a gate");
  });
});

describe("trailerAudit", () => {
  const tmp = mkdtempSync(join(tmpdir(), "guard-audit-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  test("each committed trailer since `since` is re-scored vs its parent; one at 00:00:01 on the since-day counts; an older trailer and a prose mention list nothing", () => {
    const ceil = (n: number) => `{"LIMIT":600,"ceilings":{"a.ts":${n}}}`;
    // No offset: git reads the commit date in the same local zone it reads `since` in, whatever TZ the runner has.
    const at = (day: string, msg: string, edit: string, time = "12:00:00Z") =>
      `${edit} && git add -A && GIT_COMMITTER_DATE=2026-11-${day}T${time} git commit -q -m '${msg}'`;
    const r = spawnSync("bash", ["-c", [
      "git init -q && git config user.name t && git config user.email t@t && mkdir scripts",
      at("01", "base", `echo '${ceil(750)}' > scripts/size-ceilings.json && echo a > a.ts`),
      at("02", "old\n\nGuard-loosened: scripts/size-ceilings.json — before the window", `echo '${ceil(800)}' > scripts/size-ceilings.json`),
      at("05", "edge\n\nGuard-loosened: scripts/size-ceilings.json — first second of the since-day", `echo '${ceil(850)}' > scripts/size-ceilings.json`, "00:00:01"),
      at("10", "raise\n\nGuard-loosened: scripts/size-ceilings.json — split needs room", `echo '${ceil(900)}' > scripts/size-ceilings.json`),
      at("11", "lower\n\nGuard-loosened: scripts/size-ceilings.json — not a loosening", `echo '${ceil(700)}' > scripts/size-ceilings.json`),
      at("12", "src\n\nGuard-loosened: eslint-suppressions.json — wrong file", "echo b > a.ts"),
      at("13", "prose mentions Guard-loosened: a.ts — inline", "echo c > a.ts"),
    ].join("\n")], { cwd: tmp, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    expect(r.status, r.stderr).toBe(0);
    expect(trailerAudit(tmp, "2026-11-05").map((t) => `${t.verdict} ${t.path} — ${t.why}`)).toEqual([
      "UNTOUCHED eslint-suppressions.json — wrong file",
      "NOT-LOOSENED scripts/size-ceilings.json — not a loosening",
      "OK scripts/size-ceilings.json — split needs room",
      "OK scripts/size-ceilings.json — first second of the since-day",
    ]);
  });
});
