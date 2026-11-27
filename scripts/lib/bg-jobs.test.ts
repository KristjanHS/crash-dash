import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// scripts/lib/bg-jobs.sh — the parallel runner behind scripts/check.sh.
// Each case sources the lib in a fresh bash and drives it with fake jobs; waited sleeps stay ≤ 0.3 s so a
// case sits far under the 1 000 ms per-test tripwire (scripts/test-budget-reporter.ts). A hang reds at the timeout.

const LIB = join(import.meta.dirname, "bg-jobs.sh");
const scratch = mkdtempSync(join(tmpdir(), "bg-jobs-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(body: string) {
  const r = spawnSync("bash", ["-c", `set -euo pipefail; source "${LIB}"; bg_jobs_init; ${body}`], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
  return { rc: r.status, out: r.stdout + r.stderr };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("bg_jobs_join", () => {
  it("all green: rc 0, table rows in START order even when the finish order differs", () => {
    const { rc, out } = run(`bg_job slow sleep 0.2; bg_job fast true; bg_jobs_join`);
    expect(rc).toBe(0);
    const rows = out.trimEnd().split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^ {2}ok +slow +\d+\.\d s$/);
    expect(rows[1]).toMatch(/^ {2}ok +fast +\d+\.\d s$/);
  });

  it("first failure: returns ITS rc, prints its full log, marks the still-running job killed", () => {
    const { rc, out } = run(`bg_job long sleep 5; bg_job bad bash -c 'echo boom-line; exit 3'; bg_jobs_join`);
    expect(rc).toBe(3);
    expect(out).toMatch(/killed +long +-/);
    expect(out).toMatch(/FAIL +bad /);
    expect(out).toContain("── bad failed (rc 3) — full log ──\nboom-line");
  });

  it("a kill reaches the job's grandchildren (its whole process group), not just the direct child", () => {
    const pidFile = join(scratch, "grandchild.pid");
    const { rc } = run(
      `bg_job tree bash -c 'sleep 30 & echo $! >"${pidFile}"; wait'; ` +
        `for _ in $(seq 200); do [ -s "${pidFile}" ] && break; sleep 0.01; done; bg_job bad false; bg_jobs_join`,
    );
    expect(rc).toBe(1);
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(grandchild).toBeGreaterThan(0);
    // TERM delivery is asynchronous to the join's return; give the kernel a beat.
    const until = Date.now() + 300;
    while (alive(grandchild) && Date.now() < until) spawnSync("sleep", ["0.02"]);
    expect(alive(grandchild)).toBe(false);
  });

  it("under set -e a failing join aborts the caller (check.sh relies on it)", () => {
    const { rc, out } = run(`bg_job bad bash -c 'exit 7'; bg_jobs_join; echo REACHED`);
    expect(rc).toBe(7);
    expect(out).not.toContain("REACHED");
  });
});
