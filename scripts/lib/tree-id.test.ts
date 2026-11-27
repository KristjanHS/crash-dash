import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// scripts/lib/tree-id.sh — the key of scripts/check.sh's pass stamp. A stamp is only as sound as this id:
// it must MOVE on every change the gate reads, and a git failure must degrade to "no stamp", never abort.

const LIB = join(import.meta.dirname, "tree-id.sh");
let repo = "";
let outside = "";

const git = (...args: string[]) =>
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" }).stdout.trim();
const treeId = (cwd = repo) => {
  const r = spawnSync("bash", ["-c", `set -euo pipefail; source "${LIB}"; tree_id; echo " rc=$?"`], { cwd, encoding: "utf8", timeout: 5000 });
  return { out: r.stdout, err: r.stderr, status: r.status };
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "tree-id-repo-"));
  outside = mkdtempSync(join(tmpdir(), "tree-id-outside-"));
  git("init", "-q");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, ".gitignore"), "ign.txt\n");
  git("add", "-A");
  git("commit", "-qm", "init");
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("tree_id", () => {
  it("equals HEAD's tree on a clean checkout and moves on a tracked edit or an untracked file, not an ignored one", () => {
    const clean = treeId().out;
    expect(clean).toBe(`${git("rev-parse", "HEAD^{tree}")} rc=0\n`);

    writeFileSync(join(repo, "ign.txt"), "ignored\n");
    expect(treeId().out).toBe(clean);

    writeFileSync(join(repo, "a.txt"), "two\n");
    const edited = treeId().out;
    expect(edited).not.toBe(clean);
    writeFileSync(join(repo, "a.txt"), "one\n");
    expect(treeId().out).toBe(clean);

    writeFileSync(join(repo, "new.txt"), "untracked\n");
    expect(treeId().out).not.toBe(clean);
    unlinkSync(join(repo, "new.txt"));
  });

  it("outside a git checkout: prints no id, warns, and still returns 0 under set -e", () => {
    const r = treeId(outside);
    expect(r.status).toBe(0);
    expect(r.out).toBe(" rc=0\n");
    expect(r.err).toContain("tree id unavailable");
  });
});
