import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// eufin-run-local.sh's LADDER_RELEASE_MAKE: the make invocation for its two prod-facing targets. Every CLI the run
// touches up to `prodcron` is a stub on a temp PATH (curl, claude, make) under a temp HOME/XDG/TMPDIR, and the release
// lock (scripts/lib/release-lock.sh) is a temp file; the make stub records its argv and fails, so the run stops at
// "prodcron failed twice" — no leg, no ship, no network.

const SCRIPT = join(import.meta.dirname, "eufin-run-local.sh");
let tmp = "";
beforeAll(() => (tmp = mkdtempSync(join(tmpdir(), "eufin-run-local-"))));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const stub = (dir: string, name: string, body: string) => {
  writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
};

const releaseLock = (name: string) => join(tmp, name, "release.lock");
const holders: ChildProcess[] = [];
afterEach(() => {
  for (const h of holders.splice(0)) h.kill("SIGKILL");
});
const lockFree = (lock: string) => spawnSync("flock", ["-n", lock, "true"]).status === 0;

// `stubs` adds PATH stubs (name → body) on top of the defaults below.
function run(name: string, releaseMake: string | undefined, extra: Record<string, string> = {}, stubs: Record<string, string> = {}) {
  const root = join(tmp, name);
  mkdirSync(root, { recursive: true });
  const bin = join(root, "bin");
  const cfg = join(root, "cfg");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(cfg, "crash-dash"), { recursive: true });
  mkdirSync(join(root, "tmp"));
  const makeLog = join(root, "make.log");
  stub(bin, "make", `echo "$*" >>"${makeLog}"; exit 1`);
  stub(bin, "curl", `echo '{"ok":true}'`);
  stub(bin, "claude", `echo '{"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY"}'`);
  for (const [cmd, body] of Object.entries(stubs)) stub(bin, cmd, body);
  // A fresh manual-start request unlocks the billing cycle (§ Billing cycle), so the run reaches prodcron.
  writeFileSync(join(cfg, "crash-dash", "ladder-arm-request"), "");
  const env: Record<string, string> = {
    PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: root,
    XDG_CONFIG_HOME: cfg,
    XDG_STATE_HOME: join(root, "state"),
    TMPDIR: join(root, "tmp"),
    ANTHROPIC_API_KEY: "sk-test-not-a-key",
    PRODCRON_RETRY_S: "0",
    CRASH_DASH_RELEASE_LOCK: releaseLock(name),
    ...extra,
  };
  if (releaseMake !== undefined) env.LADDER_RELEASE_MAKE = releaseMake;
  const r = spawnSync("bash", [SCRIPT], { env, encoding: "utf8", timeout: 30_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, makeCalls: existsSync(makeLog) ? readFileSync(makeLog, "utf8").trim().split("\n") : [] };
}

// LADDER_PREFLIGHT: a command run once before prodcron; its stub logs `<cwd>|<argv>` and exits with its first argument.
describe("eufin-run-local.sh LADDER_PREFLIGHT", () => {
  const preflight = (name: string, args: string, extra: Record<string, string> = {}, stubs: Record<string, string> = {}) => {
    const log = join(tmp, `${name}.preflight.log`);
    const cmd = join(tmp, `${name}.preflight`);
    writeFileSync(cmd, `#!/usr/bin/env bash\necho "$PWD|$*" >>"${log}"\nexit "$1"\n`);
    chmodSync(cmd, 0o755);
    const r = run(name, "make -C /abs/release", { LADDER_PREFLIGHT: `${cmd} ${args}`, ...extra }, stubs);
    return { ...r, calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
  };
  const REPO_DIR = join(import.meta.dirname, "..");

  it("non-zero exit → the run fails with `run-preflight` before prodcron (exit 1)", () => {
    const r = preflight("pf-fail", "3 x");
    expect(r.calls).toEqual([`${REPO_DIR}|3 x`]);
    expect(r.stderr).toMatch(/::error:: LADDER_PREFLIGHT failed \(exit 3\)/);
    expect(r.stderr).toMatch(/::error:: failed: run-preflight$/m);
    expect(r.makeCalls).toEqual([]);
    expect(r.status).toBe(1);
  });

  it("exit 0 → called once from the repo, the run goes on to prodcron", () => {
    const r = preflight("pf-ok", "0");
    expect(r.calls).toEqual([`${REPO_DIR}|0`]);
    expect(r.makeCalls).toEqual(["-C /abs/release -s prodcron", "-C /abs/release -s prodcron"]);
  });

  it("unset → no preflight step: the run goes straight on to prodcron", () => {
    const r = run("pf-unset", "make -C /abs/release");
    expect(r.stderr).not.toMatch(/preflight/i);
    expect(r.stdout).not.toMatch(/preflight ok/);
    expect(r.makeCalls).toEqual(["-C /abs/release -s prodcron", "-C /abs/release -s prodcron"]);
  });

  it("DRY_RUN=1 → the preflight is never called, even a failing one", () => {
    // unknown leg → ends soon after the preflight point; the npm stub skips the five real `<leg>:state` calls of the
    // state-size warn loop (~2 s) on the way there.
    const r = preflight("pf-dry", "3", { DRY_RUN: "1", LEGS: "none", PREFLIGHT_RETRY_S: "0" }, { npm: "exit 0" });
    expect(r.calls).toEqual([]);
    expect(r.stderr).not.toMatch(/LADDER_PREFLIGHT failed/);
  });

  it("whitespace-only → refused at start, before any make call", () => {
    const r = run("pf-blank", "make -C /abs/release", { LADDER_PREFLIGHT: " \t " });
    expect(r.stderr).toMatch(/::error:: LADDER_PREFLIGHT=.* names no command/);
    expect(r.makeCalls).toEqual([]);
    expect(r.status).toBe(1);
  });
});

describe("eufin-run-local.sh LADDER_RELEASE_MAKE", () => {
  it("control: a real value reaches the make stub (so 'no make call' below is observable)", () => {
    const r = run("control", "make -C /abs/release");
    expect(r.makeCalls).toEqual(["-C /abs/release -s prodcron", "-C /abs/release -s prodcron"]);
    expect(r.stderr).toMatch(/::error:: make -C \/abs\/release -s prodcron failed twice/);
    expect(r.status).toBe(1);
  });

  it("release lock held by another release → prodcron not fired, every leg skipped (exit 1)", async () => {
    const lock = releaseLock("busy");
    mkdirSync(dirname(lock), { recursive: true });
    holders.push(spawn("flock", ["-n", lock, "sleep", "60"], { stdio: "ignore" }));
    for (let i = 0; i < 200 && lockFree(lock); i++) await new Promise((r) => setTimeout(r, 10));
    expect(lockFree(lock)).toBe(false);
    const r = run("busy", "make -C /abs/release");
    expect(r.makeCalls).toEqual([]);
    expect(r.stderr).toMatch(/another release or CI-stack run .* holds the release lock — make -C \/abs\/release -s prodcron not fired/);
    expect(r.stderr).toMatch(/::error:: failed: prodcron-busy/);
    expect(r.status).toBe(1);
  });

  it("whitespace-only: refused with exit 1 before any make call or prodcron attempt", () => {
    const r = run("blank", "  \t ");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error:: LADDER_RELEASE_MAKE=.* names no command/);
    expect(r.stderr).not.toMatch(/prodcron|command not found/);
    expect(r.makeCalls).toEqual([]);
  });

  it("no user-facing line names a bare `make ship` / `make prodcron` — the release make may not be plain make", () => {
    const offenders = readFileSync(SCRIPT, "utf8")
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => !line.trimStart().startsWith("#") && /\bmake (ship|prodcron)\b/.test(line));
    expect(offenders).toEqual([]);
  });
});

// LADDER_LEG_WRAP + LADDER_PROTECTED_PATHS: a COPY of the script runs in a temp git repo (its REPO is the script's own
// checkout) with a bare `origin`; make (prodcron/ship), npm (probe/state/apply → the no-claude leg) and vercel are stubs.
const REAL = join(import.meta.dirname, "..");
const LEG_FILES = ["scripts/eufin-run-local.sh", "scripts/ladder-pause.sh", "scripts/lib/release-lock.sh", ".claude/agents/ladder-research.md"];
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

// Wrapper variants: [before the inner, the inner call, after it]. $res = the result-file path off the inner's command line.
const WRAPS = {
  ok: ["", `(cd "$wt" && "$@")`, ""],
  "fail-after": ["", `(cd "$wt" && "$@")`, "rc=3"],
  "fail-stop": ["", `(cd "$wt" && "$@")`, `echo "stop 1" >>"$res"; rc=3`],
  noop: ["", "true", ""],
  drift: [`git -C "$wt" commit -q --allow-empty -m drift`, `(cd "$wt" && "$@")`, ""],
  "no-proto": ["", `(cd "$wt" && "$@")`, `sed -i '/^proto /d' "$res"`],
  // A copy that predates inner-leg mode (its knobs renamed away), on a lock file of its own.
  "old-copy": [`sed -i -E 's/LADDER_(INNER_LEG|LEG_WRAP|PROTECTED_PATHS)/OLD_\\1/g' "$wt/scripts/eufin-run-local.sh"`,
    `(cd "$wt" && TMPDIR="$(mktemp -d)" "$@")`, ""],
} as const;
interface LegRun { wrap?: boolean | keyof typeof WRAPS; protectedList?: string | null; unshipped?: boolean; env?: Record<string, string> }
function runLeg(name: string, { wrap = false, protectedList, unshipped = false, env: extra = {} }: LegRun) {
  const root = join(tmp, name);
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const cfg = join(root, "cfg");
  for (const d of [bin, join(cfg, "crash-dash"), join(root, "tmp"), repo]) mkdirSync(d, { recursive: true });
  for (const f of LEG_FILES) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    copyFileSync(join(REAL, f), join(repo, f));
  }
  writeFileSync(join(repo, ".nvmrc"), `${process.versions.node.split(".")[0]}\n`);
  mkdirSync(join(repo, "public"));
  mkdirSync(join(repo, "docs"));
  // As in production the leg mds are gitignored and untracked, so a git pathspec naming one errors;
  // a tracked sibling keeps docs/ in a fresh worktree.
  writeFileSync(join(repo, ".gitignore"), "/docs/eufin.md\n/docs/semis.md\n");
  writeFileSync(join(repo, "docs/README.md"), "docs\n");
  for (const leg of ["eufin", "semis"]) {
    writeFileSync(join(repo, `public/${leg}.json`), "{}\n");
    writeFileSync(join(repo, `docs/${leg}.md`), `# ${leg}\n`);
  }
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@t.invalid");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "remote", "add", "origin", join(root, "origin.git"));
  git(repo, "push", "-q", "origin", "main");
  const base = git(repo, "rev-parse", "HEAD");

  const makeLog = join(root, "make.log");
  const npmLog = join(root, "npm.log");
  const wtLog = join(root, "wt.log");
  stub(bin, "make", `echo "$*" >>"${makeLog}"`);
  stub(bin, "curl", `echo '{"ok":true}'`);
  stub(bin, "vercel", `echo tester`);
  stub(bin, "claude", `case "$1 \${2:-}" in
  auth*) echo '{"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY"}' ;;
  "-p preflight") echo '{"type":"system","subtype":"init","apiKeySource":"ANTHROPIC_API_KEY","tools":["Bash","Write","Edit","WebSearch","Task"],"agents":["ladder-research"]}' ;;
esac`);
  // Nothing due → the leg is probe → state → apply (writes its cwd into both artifacts) → the runner's own commit.
  stub(bin, "npm", `echo "$PWD|\${LADDER_INNER_LEG:-}|$*" >>"${npmLog}"
case "$3" in
  *:state) echo '{"research":[],"today":"2026-11-20","now":"2026-11-20T00:00:00.000Z"}' ;;
  *:apply) if [ -n "\${STUB_ADD_REVERT:-}" ]; then mkdir -p src; echo x >src/prices.ts; git add src/prices.ts
    git commit -qm add -- src/prices.ts; git rm -q src/prices.ts; git commit -qm revert -- src/prices.ts; fi
    echo "$PWD" >"public/\${3%%:*}.json"; echo "$PWD" >"docs/\${3%%:*}.md" ;;
esac`);
  // The wrapper contract: run "$@" with cwd = a detached worktree of the repo at $LADDER_BASE_SHA, propagate its status.
  const [pre, call, post] = WRAPS[wrap === true || wrap === false ? "ok" : wrap];
  stub(root, "leg-wrap", `wt="$(mktemp -d)/wt"; echo "$wt" >>"${wtLog}"
res=""; for a; do case "$a" in LADDER_LEG_RESULT_FILE=*) res="\${a#*=}" ;; esac; done
git -C "${repo}" worktree add -q --detach "$wt" "$LADDER_BASE_SHA" || exit 1
${pre}
rc=0; ${call} || rc=$?
${post}
git -C "${repo}" worktree remove --force "$wt"; exit $rc`);
  writeFileSync(join(cfg, "crash-dash", "ladder-arm-request"), "");
  if (unshipped) writeFileSync(join(cfg, "crash-dash", "eufin-unshipped"), `${base}\n`);

  const env: Record<string, string> = {
    PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: root,
    XDG_CONFIG_HOME: cfg,
    XDG_STATE_HOME: join(root, "state"),
    TMPDIR: join(root, "tmp"),
    GIT_CONFIG_NOSYSTEM: "1",
    ANTHROPIC_API_KEY: "sk-test-not-a-key",
    PRODCRON_RETRY_S: "0",
    PREFLIGHT_RETRY_S: "0",
    CRASH_DASH_RELEASE_LOCK: releaseLock(name),
    VERCEL_BIN: join(bin, "vercel"),
    LEGS: "semis",
    SHIP: "0",
    PUSH: "1",
    ...extra,
  };
  if (wrap !== false) env.LADDER_LEG_WRAP = join(root, "leg-wrap");
  if (protectedList === null) env.LADDER_PROTECTED_PATHS = join(root, "no-such-list");
  else if (protectedList !== undefined) {
    writeFileSync(join(root, "protected"), protectedList);
    env.LADDER_PROTECTED_PATHS = join(root, "protected");
  }
  const r = spawnSync("bash", [join(repo, "scripts/eufin-run-local.sh")], { env, encoding: "utf8", timeout: 60_000 });
  const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n") : []);
  // The leg's own steps (the state calls also run once per leg in the run-level size check, outside any worktree).
  const legSteps = lines(npmLog).map((l) => l.split("|")).filter(([, , args = ""]) => / (probe:semis-tranches|semis:apply) /.test(args));
  return {
    status: r.status,
    stderr: r.stderr,
    repo,
    base,
    head: git(repo, "rev-parse", "HEAD"),
    origin: git(join(root, "origin.git"), "rev-parse", "main"),
    headLeg: (leg = "semis") => git(repo, "show", `HEAD:public/${leg}.json`),
    makeCalls: lines(makeLog),
    worktrees: lines(wtLog),
    legSteps,
  };
}

describe("eufin-run-local.sh LADDER_LEG_WRAP / LADDER_PROTECTED_PATHS", { timeout: 60_000 }, () => {
  it("(a) wrap set → the leg runs in the wrapper's worktree and the repo fast-forwards to its commit", () => {
    const r = runLeg("wrap", { wrap: true, protectedList: "# protected\n\n  src/prices.ts\nscripts/x.ts\n" });
    expect(r.stderr).not.toMatch(/::error::/);
    expect(r.status).toBe(0);
    expect(r.worktrees).toHaveLength(1);
    const [wt] = r.worktrees;
    expect(r.legSteps.map(([cwd, inner]) => [cwd, inner])).toEqual([[wt, "semis"], [wt, "semis"]]);
    expect(r.head).not.toBe(r.base);
    expect(r.headLeg()).toBe(wt);
    expect(r.origin).toBe(r.head);
    expect(r.makeCalls).toEqual(["-s prodcron"]);
  });

  // A leftover unshipped marker makes the ship line reachable without this run's commit; push needs one, so that case
  // proves only that nothing reached origin.
  it.each([
    ["no ship of a leftover unshipped marker", "ship", { SHIP: "1" }],
    ["origin unchanged", "push", { SHIP: "0", PUSH: "1" }],
  ])("(b) a worktree commit touching a protected path → refused, exit 1, repo HEAD unchanged, %s", (_claim, mode, env) => {
    const r = runLeg(`protected-${mode}`, { wrap: true, protectedList: "# protected\nsrc/prices.ts\npublic/semis.json\n", unshipped: mode === "ship", env });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error:: \/semis worktree commits refused — protected paths: public\/semis\.json;/);
    expect(r.worktrees).toHaveLength(1);
    expect(r.head).toBe(r.base);
    expect(r.makeCalls).toEqual(["-s prodcron"]);
    expect(r.origin).toBe(r.base);
  });

  it.each([
    ["ship", { SHIP: "1" }],
    ["push", { SHIP: "0", PUSH: "1" }],
  ])("(b) a refused leg after a merged one → the run stops: exit 1, no %s of the merged leg", (mode, env) => {
    const r = runLeg(`protected-2-${mode}`, { wrap: true, protectedList: "public/semis.json\n", env: { ...env, LEGS: "eufin semis" } });
    expect(r.status).toBe(1);
    expect(r.worktrees).toHaveLength(2);
    expect(r.headLeg("eufin")).toBe(r.worktrees[0]);
    expect(r.headLeg("semis")).toBe("{}");
    expect(r.makeCalls).toEqual(["-s prodcron"]);
    expect(r.origin).toBe(r.base);
  });

  it("(c) protected-paths file missing → refused at start: no prodcron, no leg, exit 1", () => {
    const r = runLeg("missing-list", { wrap: true, protectedList: null });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error:: LADDER_PROTECTED_PATHS='.*no-such-list' is not a readable list .* — refused/);
    expect(r.makeCalls).toEqual([]);
    expect(r.legSteps).toEqual([]);
    expect(r.head).toBe(r.base);
  });

  it.each([
    ["only comments", "# protected\n   # none yet\n\n"],
    ["a kind-prefixed line", "src/prices.ts\nR public/semis.json\n"],
    ["two fields", "src/prices.ts extra\n"],
  ])("(5) a list with %s → refused at start: no prodcron, no leg, exit 1", (_what, list) => {
    const r = runLeg(`bad-list-${_what.replace(/\W+/g, "-")}`, { wrap: true, protectedList: list });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error:: LADDER_PROTECTED_PATHS='.*protected' is not a readable list .* — refused/);
    expect(r.makeCalls).toEqual([]);
    expect(r.legSteps).toEqual([]);
  });

  it("(5) an inline comment after a path still protects that path", () => {
    const r = runLeg("inline-comment", { wrap: true, protectedList: "public/semis.json  # the leg's own artifact\n" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error:: \/semis worktree commits refused — protected paths: public\/semis\.json;/);
    expect(r.head).toBe(r.base);
    expect(r.origin).toBe(r.base);
  });

  it("(6) protected paths without a leg wrap → refused at start: no prodcron, no leg, exit 1", () => {
    const r = runLeg("protected-no-wrap", { protectedList: "src/prices.ts\n" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error:: LADDER_PROTECTED_PATHS is set but LADDER_LEG_WRAP is not .* refused/);
    expect(r.makeCalls).toEqual([]);
    expect(r.legSteps).toEqual([]);
  });

  it("(4) a protected path added then reverted across two leg commits → refused (every commit, not the net diff)", () => {
    const r = runLeg("add-revert", { wrap: true, protectedList: "src/prices.ts\n", env: { STUB_ADD_REVERT: "1" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error:: \/semis worktree commits refused — protected paths: src\/prices\.ts;/);
    expect(r.head).toBe(r.base);
    expect(r.origin).toBe(r.base);
  });

  it("(1) wrapper exits non-zero after the leg committed → not merged, leg failed, exit 1, origin unchanged", () => {
    const r = runLeg("wrap-fails", { wrap: "fail-after" });
    expect(r.legSteps).toHaveLength(2); // the leg really ran and committed in the worktree
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error:: \/semis worktree run exited 3 \(proto '1', head '[0-9a-f]{40}'\) — nothing merged/);
    expect(r.stderr).toMatch(/::error:: failed: semis$/m);
    expect(r.head).toBe(r.base);
    expect(r.origin).toBe(r.base);
  });

  it("(1) wrapper fails after an inner leg that set stop → the remaining legs do not run", () => {
    const r = runLeg("wrap-fails-stop", { wrap: "fail-stop", env: { LEGS: "semis eufin" } });
    expect(r.status).toBe(1);
    expect(r.worktrees).toHaveLength(1);
    expect(r.head).toBe(r.base);
  });

  it("(2) wrapper exits 0 without running the inner leg → nothing merged, leg failed", () => {
    const r = runLeg("wrap-noop", { wrap: "noop" });
    expect(r.legSteps).toEqual([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error:: \/semis worktree run exited 0 \(proto '', head ''\) — nothing merged/);
    expect(r.head).toBe(r.base);
    expect(r.origin).toBe(r.base);
  });

  it("(3) wrapper whose worktree HEAD is not LADDER_BASE_SHA → the inner refuses, nothing merged", () => {
    const r = runLeg("wrap-drift", { wrap: "drift" });
    expect(r.legSteps).toEqual([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error:: LADDER_INNER_LEG=semis needs cwd at LADDER_BASE_SHA .* refused/);
    expect(r.head).toBe(r.base);
    expect(r.origin).toBe(r.base);
  });

  it("(N8) a result file without the protocol marker → refused, nothing merged", () => {
    const r = runLeg("no-proto", { wrap: "no-proto" });
    expect(r.legSteps).toHaveLength(2);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error:: \/semis worktree run exited 0 \(proto '', head '[0-9a-f]{40}'\) — nothing merged/);
    expect(r.head).toBe(r.base);
    expect(r.origin).toBe(r.base);
  });

  it("(N8) a copy without inner-leg mode runs as a full run → its prodcron fails, no leg, no push or ship", () => {
    const r = runLeg("old-copy", { wrap: "old-copy", env: { SHIP: "0", PUSH: "1" } });
    expect(r.origin).toBe(r.base);
    expect(r.makeCalls).toEqual(["-s prodcron"]);
    expect(r.head).toBe(r.base);
    expect(r.legSteps).toEqual([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error:: false -s prodcron failed twice/); // the copy really ran as a full run
  });

  it("(d) wrap unset → the leg runs in the repo itself, no inner leg (unchanged behaviour)", () => {
    const r = runLeg("plain", {});
    expect(r.stderr).not.toMatch(/::error::/);
    expect(r.status).toBe(0);
    expect(r.worktrees).toEqual([]);
    expect(r.legSteps.map(([cwd, inner]) => [cwd, inner])).toEqual([[r.repo, ""], [r.repo, ""]]);
    expect(r.headLeg()).toBe(r.repo);
    expect(r.origin).toBe(r.head);
  });
});
