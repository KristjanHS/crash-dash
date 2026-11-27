// Pins the GFS retention of scripts/backup/prune-backups-branch.sh on a synthetic git repo:
// one empty commit per day, `PRUNE_NOW` pinned, ages asserted off the rewritten branch.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./prune-backups-branch.sh", import.meta.url));
const DAY = 86_400;
const NOW = 1_800_000_000; // fixed epoch; only ages matter

// House integration gate (`src/store.test-helpers.ts`, `scripts/backfill-slow.test.ts`): this suite
// spawns `git init` + 40 `git commit` subprocesses (~1.01 s) — build/subprocess work that does not
// belong in the every-save unit lane. `describe.runIf(hasDb)` moves it to the DB/integration lane:
// `run-integration-tests.sh` greps for `.runIf(hasDb)` and runs it in phase 1 with the CI stack armed
// (hasDb → true), so `make ship` (always) and the pre-push hook (on a src/store* |
// supabase/migrations/** push, which runs that same script) still catch retention drift. It skips
// VISIBLY in the unit lane rather than vanishing silently. Note: the git-subprocess retention logic
// has no DB dependency; `hasDb` is reused as the lane selector because it is the signal that script
// arms.
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
const isLocalUrl = Boolean(url && /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url));
const hasDb = Boolean(url && key) && isLocalUrl && process.env.DB_TESTS === "1";

let repo: string;
/**
 * process.env with every `GIT_*` variable stripped. Under a git hook (the pre-push hook runs
 * this suite via run-integration-tests.sh) git exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE, and a child `git init` +
 * `git commit` with those inherited targets the HOOK'S repo, not `repo` — on 2026-09-05 that
 * put these 40 empty "snapshot age N" commits onto a live checkout's branch. Demonstrated:
 * `GIT_DIR=<scratch>/.git npx vitest run <this file>` grows <scratch>'s branch by 40 commits
 * without the strip, and `isolated` below is the pin.
 */
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
  // The fixture is hermetic against the USER's git config too (commit.gpgsign, core.hooksPath,
  // init.templateDir would otherwise reach the temp repo).
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: ENV }).trim();
const prune = (now: number, extra: Record<string, string> = {}) =>
  execFileSync("bash", [SCRIPT, "backups"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...ENV, PRUNE_NOW: String(now), ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
/** Whole-day ages of every commit on `backups`, newest first. */
const ages = (now: number) =>
  git("log", "--format=%ct", "backups")
    .split("\n")
    .map((ct) => Math.floor((now - Number(ct)) / DAY));

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "prune-gfs-"));
  git("init", "-q", "-b", "backups");
  // Pin: every git call above targets the temp repo, whatever GIT_* the parent exported.
  // `--absolute-git-dir` is canonicalized (symlinked tmpdirs: macOS /var → /private/var), so compare realpaths.
  const isolated = git("rev-parse", "--absolute-git-dir");
  const real = realpathSync(repo);
  if (!isolated.startsWith(real)) throw new Error(`fixture git targets ${isolated}, not ${real} — a GIT_* leak`);
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.com");
  // 40 daily snapshots: ages 39 … 0 (oldest first, like the real branch)
  for (let age = 39; age >= 0; age--) {
    const date = String(NOW - age * DAY);
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", `snapshot age ${age}`], {
      cwd: repo,
      env: { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  }
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe.runIf(hasDb)("prune-backups-branch.sh", () => {
  it("keeps every snapshot < 7 days plus the OLDEST in each 1/2/3/4-week window", () => {
    expect(ages(NOW)).toHaveLength(40);
    const tipBefore = git("rev-parse", "backups");
    prune(NOW);
    expect(ages(NOW)).toEqual([0, 1, 2, 3, 4, 5, 6, 13, 20, 27, 34]);
    expect(git("rev-parse", "backups")).not.toBe(tipBefore);
    // Linear chain, messages/dates intact — the newest kept commit is the untouched tip's twin.
    expect(git("log", "-1", "--format=%s", "backups")).toBe("snapshot age 0");
    expect(git("rev-list", "--count", "backups")).toBe("11");
  });

  it("is a no-op when nothing falls out (same tip SHA — no spurious force push)", () => {
    const tip = git("rev-parse", "backups");
    prune(NOW);
    expect(git("rev-parse", "backups")).toBe(tip);
  });

  it("rolls: a day later the ladder shifts by one and the 34-day rung falls off", () => {
    const survivorsBefore = git("log", "--format=%H", "backups").split("\n");
    prune(NOW + DAY);
    expect(ages(NOW + DAY)).toEqual([1, 2, 3, 4, 5, 6, 7, 14, 21, 28]);
    // Every survivor's tree/date came from the previous set — a rung graduated, none was refilled.
    const subjects = git("log", "--format=%s", "backups").split("\n");
    expect(subjects).toEqual(survivorsBefore.slice(0, 10).map((_, i) => `snapshot age ${[0, 1, 2, 3, 4, 5, 6, 13, 20, 27][i]}`));
  });

  it("PRUNE_DRY_RUN reports without rewriting", () => {
    const tip = git("rev-parse", "backups");
    const out = prune(NOW + 40 * DAY, { PRUNE_DRY_RUN: "1" });
    expect(git("rev-parse", "backups")).toBe(tip);
    expect(out).toBe(""); // report goes to stderr; stdout stays clean for callers
  });
});
