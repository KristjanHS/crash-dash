// .claude/hooks/guard-ask.sh — flags edits to a gate, gate-bypassing commands and commits declaring a Guard-loosened trailer, stays silent otherwise.
// It warns the agent by default; GUARD_ASK=1 makes it prompt instead, which is the mode the classifier assertions below run in.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const CWD = "/repo";
type Out = { hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } };
/** The hook's output (undefined = silent); `stage` sets IMPAG_STAGE ("default" = no mode env at all; omitted = GUARD_ASK=1),
 *  `at` the hook's cwd (CLAUDE_PROJECT_DIR = `project` unless that is `at`). */
function hook(tool: string, input: Record<string, string>, stage?: string, raw?: string, at = CWD, project = CWD): Out["hookSpecificOutput"] | undefined {
  const { IMPAG_STAGE: _, GUARD_ASK: ____, CLAUDE_PROJECT_DIR: __, CLAUDE_CONFIG_DIR: ___, ...env } = process.env;
  const stdin = raw ?? JSON.stringify({ tool_name: tool, tool_input: input, cwd: at });
  const mode = stage === "default" ? {} : stage ? { IMPAG_STAGE: stage, GUARD_ASK: "1" } : { GUARD_ASK: "1" };
  const extra = { ...mode, ...(at === project ? {} : { CLAUDE_PROJECT_DIR: project }) };
  const r = spawnSync(".claude/hooks/guard-ask.sh", { input: stdin, encoding: "utf8", env: { ...env, ...extra } });
  if (r.status !== 0) throw new Error(`hook exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim() ? (JSON.parse(r.stdout) as Out).hookSpecificOutput : undefined;
}
/** "ask" | "warn" (additionalContext: the default mode or IMPAG_STAGE) | "allow" (no output). */
const label = (o: Out["hookSpecificOutput"] | undefined) => (!o ? "allow" : o.permissionDecision ?? "warn");
const decision = (tool: string, input: Record<string, string>, stage?: string, raw?: string, at = CWD) => label(hook(tool, input, stage, raw, at));

const ASK_PATHS = [".claude/hooks/guard-ask.sh", ".claude/settings.json", ".claude/settings.local.json", "scripts/git-hooks/pre-commit", "scripts/git-hooks/commit-msg", "knip.json",
  "scripts/size-ratchet.test.ts", "scripts/unused-exports.test.ts", "scripts/guard-loosen.ts", `${homedir()}/.claude/settings.json`];
// The baselines, rosters and snapshots are scored at commit (scripts/guard-loosen.ts); paths outside the repo are not its gates.
const ALLOW_PATHS = ["src/goldens/dispatch.ts", "scripts/capture-core9-baseline.snapshot.json", "src/silent-failure-roster.test.ts", "src/danger-engine.stand-ins.test.ts", "eslint-suppressions.json",
  "scripts/size-ceilings.json", "scripts/knip-prod-baseline.json", "src/run.ts", ".claude/hooks.json", ".claude/settings.md", "scripts/size-ratchet.ts", "docs/knip.json.md",
  "/home/u/.claude/hooks/x.sh", "/tmp/claude-1000/x/scratchpad/w/knip.json"];
const TRAILED = "\n\nGuard-loosened: scripts/size-ceilings.json — the split file needs the room";
const ASK_COMMANDS = ["git commit --no-verify -m x", "SKIP_TESTS=1 git push", "npx vitest run -u src/a.test.ts", "npm test -- --update", "npm install left-pad", "npm i -D -E knip@6.41.0", "npm add zod",
  "git commit -n -m x", "git commit -anm x", "SKIP_TESTS='1' git push", "git config core.hooksPath /dev/null", "bash scripts/run-unit-tests.sh -u", "npx vitest run --update=true",
  "cat a >>knip.json", "sed -i 's/a/b/' .claude/hooks/x.mjs", "echo x > scripts/git-hooks/pre-commit", "mv /tmp/x .claude/settings.json", "rm .claude/hooks/guard-ask.sh",
  "git restore scripts/unused-exports.test.ts", 'cp a "my dir/../knip.json"',
  "git -c core.hooksPath=/dev/null -c user.name=t commit -qm t", "git config --global core.hooksPath /tmp/h", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x",
  "bash <<'EOF'\ngit commit --no-verify -m x\nEOF", "bash -c 'git push --no-verify'", "cat <<'EOF' | sh\ngit commit -n -m x\nEOF", 'echo "$(git push --no-verify)"', "git commit -m x -n",
  // A substitution's own text is a command; flags after it still belong to the commit.
  "git commit -m \"$(cat <<'EOF'\nfeat: x\nEOF\n)\" -n", 'git commit -m "$(date)" -n', "echo \"$(printf ')'; git push --no-verify)\"",
  // A heredoc operator inside quotes or a comment opens no body.
  "grep -n '<<EOF' notes.md\ngit commit -n -m x\nEOF", "# see <<EOF below\ngit push --no-verify\nEOF", "echo ${x// #/}; git push --no-verify",
  // Quoted text a shell may run: the raw-text verdict stands.
  "echo 'git commit --no-verify -m x' | bash", "bash <<< 'git commit --no-verify -m x'", "env bash <<'EOF'\ngit commit --no-verify -m x\nEOF",
  "/bin/bash <<'EOF'\ngit commit --no-verify -m x\nEOF", "x=$(echo 'git push --no-verify'); eval \"$x\"", "cmd='git push --no-verify'; $cmd",
  "echo 'unbalanced; git push --no-verify", "cat <<< 'git push --no-verify'",
  // A scratch repo earlier in the command does not cover a later real one.
  "cd /tmp/x/wt && git add a\ncd /repo && git commit --no-verify -m x", "git -C /tmp/x/wt status; git commit -n -m x", "T=$(mktemp -d); X=$(date); cd $X && git config core.hooksPath /dev/null",
  // A cd ends with its subshell or pipeline; a dir the hook cannot resolve counts as the real repo.
  "(cd /tmp/x && git init -q) && git commit --no-verify -m x", "cd /tmp/x | true; git commit -n -m x", "cd /tmp/x && git init -q; cd - && git commit --no-verify -m x",
  "cd /tmp/x; cd ~/projects/crash-dash && git commit -n -m x", "cd /tmp/x && cd ../../repo && git commit --no-verify -m x", "cd /tmp/x; pushd /repo && git commit --no-verify -m x",
  "cd /tmp/x && git -c user.name=t -C /repo commit -n -m x",
  // A worktree shares the real config and remote: only a repo this command made may take a config write.
  "git -C /tmp/wt config core.hooksPath /dev/null", "cd /tmp/wt && SKIP_TESTS=1 git push", "cd /tmp/x && git init -q && git config --global core.hooksPath /dev/null",
  // A commit declaring a loosening asks, with the trailer as the reason.
  `git commit -q -m "x${TRAILED}"`, "git commit -q -m x --trailer 'Guard-loosened: knip.json — new entry file'", `git commit -q -F - -- a.ts <<'EOF'\nfeat: x${TRAILED}\nEOF`,
  'git commit -m fix -m "Guard-loosened: scripts/size-ceilings.json — why"', "git commit -m $'x\\n\\nGuard-loosened: a.json — b'", "printf 'x\\n\\nGuard-loosened: a.json — b' | git commit -F -",
  `git commit -m "$(cat <<'EOF'\nfeat: x${TRAILED}\nEOF\n)"`,
  // A message this hook cannot read may carry one.
  'git commit -m "$(cat /nonexistent/msg)"', "git commit -C HEAD", "git commit --amend --no-edit"];
// From a scratch cwd: a scratch commit is not the repo's, a -C back into the repo is.
const TMP_CWD = "/tmp/claude-1000/x/scratchpad";
const TMP_ASK = ["git -C ~/projects/crash-dash commit --no-verify -m x", "git -c user.name=t -C /repo commit -n -m x"];
const TMP_ALLOW = ["git commit --no-verify -m x"];
const ALLOW_COMMANDS = ["npm install", "npm ci", "npm install --no-audit", "npx vitest run --silent=true src/a.test.ts", "git commit -m 'no verify'", "SKIP_TESTS=0 npm run check",
  "git commit -m 'fix run'", "git commit -m x --amend", "SKIP_TESTS=10 npm run check", "npx vitest run --updated", "grep -n x scripts/knip-prod-baseline.json", "cat src/silent-failure-roster.test.ts",
  "sed -n 1,5p eslint-suppressions.json", "npx vitest run scripts/unused-exports.test.ts > /tmp/out 2>&1", "git checkout main", "cp knip.json /tmp/knip.bak.json",
  // The logged false positives (2026-11-04 → 11-09): reads and mentions, not actions.
  "git config --get core.hooksPath", "git config core.hooksPath", "git commit -q -F - -- a.ts <<'EOF'\nfeat: guard --no-verify / git commit -n\nEOF",
  "python3 - <<'EOF'\nsub(r'[/\\bgit commit\\b[^|;&]*\\s-\\w*n\\b/', 'core.hooksPath')\nEOF", "python3 - <<'EOF'\ns = \"--no-verify\"; t = \"ls | tee src/goldens/x.ts\"\nEOF",
  "git commit -q -m \"prune via find -name '*.log' — no glob\" -- a.sh", "git commit -m \"$(printf 'drop --no-verify (and -n)')\"", 'echo "a > knip.json" # git push --no-verify',
  // Writes to baselines, rosters and snapshots: the commit-msg gate scores them vs HEAD (11-04..11-13 window classes).
  "echo x > scripts/knip-prod-baseline.json", "sed -i 's/a/b/' scripts/size-ceilings.json", "ls | tee src/goldens/x.ts", "cp a /repo/eslint-suppressions.json",
  "git checkout -- src/silent-failure-roster.test.ts", "git show HEAD:scripts/knip-prod-baseline.json > scripts/knip-prod-baseline.json",
  "sed -i '/\"src\\/x.ts [exports] a\",/d; /\"src\\/x.ts [exports] b\",/d' scripts/knip-prod-baseline.json", "sed -i 's/15_000/60_000/' src/silent-failure-roster.test.ts",
  "cp knip.json /tmp/claude-1000/x/scratchpad/w/knip.json", "git commit -m \"$(cat <<'EOF'\nfeat: x\nEOF\n)\"",
  "cat > /nonexistent/m <<'EOF'\nfeat: x\nEOF\ngit commit -F /nonexistent/m",
  // A scratch-worktree commit (the 11-07 13:19 shape), and a node -e body that only mentions a bypass (11-09 07:19).
  "SP=/tmp/claude-1000/x/scratchpad; WT=$SP/bk-wt; git worktree add --quiet --detach $WT origin/backups\ncd $WT && git add scripts/zz.ts\nbash /repo/scripts/git-hooks/pre-commit >$SP/pc.out 2>&1\ngit -c core.hooksPath=/dev/null -c user.name=t commit -qm t\ncd /repo && git worktree remove --force $WT",
  "git -C /tmp/x/wt -c core.hooksPath=/dev/null commit -qm t", 'T=$(mktemp -d) && cd $T && git init -q && git config core.hooksPath "$T/.hooks"',
  'cd "$(mktemp -d)" && git init -q && git config core.hooksPath /dev/null', "S=/tmp/x; $S/old.sh < big.json; node -e '\nconst c=[\"git push --no-verify\"];'",
  // A trailer mentioned mid-line is not a trailer.
  'git commit -q -m "docs: explain the Guard-loosened: trailer"'];

describe("guard-ask hook", () => {
  // ~30 ms per spawn: decisions are fixture work, computed once outside TEST_CEILING_MS.
  let paths: string[] = [];
  let commands: string[] = [];
  let fromTmp: string[] = [];
  let siblings: string[] = [];
  let write = "";
  let read = "";
  let subdir = "";
  let chain: string[] = [];
  let fileMsg = "";
  let reason = "";
  const tmp = mkdtempSync(join(tmpdir(), "guard-ask-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  beforeAll(() => {
    writeFileSync(`${tmp}/msg`, `feat: x${TRAILED}\n`);
    fileMsg = decision("Bash", { command: `git commit -q -F ${tmp}/msg` });
    reason = hook("Bash", { command: `git commit -q -m "x${TRAILED}"` })?.permissionDecisionReason ?? "";
    chain = [
      decision("Edit", { file_path: `${CWD}/.claude/hooks/x.mjs` }, "3/10"),
      decision("Bash", { command: "SKIP_TESTS=1 git push" }, "3/10"),
      decision("Edit", { file_path: `${CWD}/src/run.ts` }, "3/10"),
      decision("Bash", {}, undefined, "not json"),
      decision("Edit", { file_path: `${CWD}/.claude/hooks/x.mjs` }, "default"),
      decision("Bash", { command: "git commit --no-verify -m x" }, "default"),
      decision("Edit", { file_path: `${CWD}/src/run.ts` }, "default"),
    ];
    paths = [...ASK_PATHS, ...ALLOW_PATHS].map((p) => `${decision("Edit", { file_path: p.startsWith("/") ? p : `${CWD}/${p}` })} ${p}`);
    commands = [...ASK_COMMANDS, ...ALLOW_COMMANDS].map((c) => `${decision("Bash", { command: c })} ${c}`);
    fromTmp = [...TMP_ASK, ...TMP_ALLOW].map((c) => `${decision("Bash", { command: c }, undefined, undefined, TMP_CWD)} ${c}`);
    const git = (...a: string[]) => spawnSync("git", a, { encoding: "utf8" });
    git("init", "-q", `${tmp}/main`);
    git("-C", `${tmp}/main`, "worktree", "add", "-q", "--orphan", "-b", "wt", `${tmp}/wt`);
    siblings = ([[`${tmp}/wt`, `${tmp}/main/.claude/hooks/x.mjs`], [`${tmp}/main`, `${tmp}/wt/knip.json`]] as const).map(([at, p]) => label(hook("Edit", { file_path: p }, undefined, undefined, at, at)));
    write = decision("Write", { file_path: `${CWD}/.claude/settings.json` });
    read = decision("Read", { file_path: `${CWD}/.claude/settings.json` });
    subdir = hook("Edit", { file_path: `${CWD}/knip.json` }, undefined, undefined, `${CWD}/src`)?.permissionDecisionReason ?? "";
  }, 60_000);

  test("Edit/Write: asks on every gate path, allows the look-alikes, the commit-scored files and non-repo paths", () => {
    expect([...paths, write]).toEqual([...ASK_PATHS.map((p) => `ask ${p}`), ...ALLOW_PATHS.map((p) => `allow ${p}`), "ask"]);
  });

  test("Edit of a gate in a sibling checkout (main from a worktree, and back) asks", () => {
    expect(siblings).toEqual(["ask", "ask"]);
  });

  test("Edit from a sub-dir cwd: the path resolves against CLAUDE_PROJECT_DIR", () => {
    expect(subdir).toMatch(/^knip\.json is /);
  });

  test("Bash: asks on gate bypasses, new dependencies, writes to a gate and declared loosenings; allows the look-alikes, scratch repos and data", () => {
    expect(commands).toEqual([...ASK_COMMANDS.map((c) => `ask ${c}`), ...ALLOW_COMMANDS.map((c) => `allow ${c}`)]);
    expect(fromTmp).toEqual([...TMP_ASK.map((c) => `ask ${c}`), ...TMP_ALLOW.map((c) => `allow ${c}`)]);
  });

  test("a declared loosening asks with its trailer as the reason, also from a -F message file", () => {
    expect([fileMsg, reason]).toEqual(["ask", expect.stringContaining("Guard-loosened: scripts/size-ceilings.json — the split file needs the room")]);
  });

  test("impag-chain stage (IMPAG_STAGE, even with GUARD_ASK=1) and the default mode never prompt — warn on a hit, silent otherwise; bad stdin fails open", () => {
    expect(chain).toEqual(["warn", "warn", "allow", "allow", "warn", "warn", "allow"]);
  });

  test("other tools pass through", () => {
    expect(read).toBe("allow");
  });
});
