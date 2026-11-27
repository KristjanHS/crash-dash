import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// The release lock (scripts/lib/release-lock.sh): `ship.sh` (ship AND verify — both run the DB-armed suite on the one
// shared crash-dash-ci stack), `smoke-cron.sh` and `run-integration-tests.sh` hold one flock file for their run and
// refuse when another process holds it; a child of a holder (ship.sh §7's smoke-cron.sh, any holder's
// run-integration-tests.sh) inherits the parent's lock instead; eufin-run-local.sh's busy probe reads it without
// keeping it. Every case points CRASH_DASH_RELEASE_LOCK at a temp
// file — never the real path — and PROD_CONFIG_DIR at a throwaway prod config dir, and runs verbatim copies of the scripts in a throwaway checkout whose CLIs are stubs
// that log their argv and exit 1 (as in scripts/prod-writes-wiring.test.ts).

const ROOT = join(import.meta.dirname, "..", "..");
const HELPER = "scripts/lib/release-lock.sh";
const STUBS = ["npx", "vercel", "curl", "supabase", "psql", "tsx", "git", "make", "npm"] as const;
const PC = ["scripts/lib/prod-writes.sh", "scripts/lib/prod-config.sh"];
const SMOKE_FILES = [...PC, "scripts/lib/cron-trigger.sh", HELPER, "scripts/smoke-cron.sh"];
const SHIP_FILES = [...PC, HELPER, "scripts/ship.sh"];
const INTEG_FILES = [HELPER, "scripts/run-integration-tests.sh"];
const SMOKE_ENV = { SUPABASE_URL: "https://fake.example.invalid", SUPABASE_SERVICE_KEY: "fakekey", BASE_URL: "http://127.0.0.1:9", MAX_WAIT_SECS: "0" };
const SMOKE_FIRST_CALL = /^curl -fsS .*https:\/\/fake\.example\.invalid\/rest\/v1\//;
const REFUSAL = /::error:: refusing (.+) — another release or CI-stack run \(ship\.sh \/ smoke-cron\.sh \/ run-integration-tests\.sh\) holds the release lock /;

let tmp = "";
let seq = 0;
const holders: ChildProcess[] = [];
beforeAll(() => (tmp = mkdtempSync(join(tmpdir(), "release-lock-"))));
afterEach(() => {
  for (const h of holders.splice(0)) h.kill("SIGKILL");
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** `flock -n <lock> true` → true when the lock is free right now (opened fresh, so it never inherits anything). */
const isFree = (lock: string) => spawnSync("flock", ["-n", lock, "true"]).status === 0;

/** Holds `lock` from an unrelated process until the test ends; resolves once it is really held. */
async function holdElsewhere(lock: string) {
  const h = spawn("flock", ["-n", lock, "sleep", "60"], { stdio: "ignore" });
  holders.push(h);
  for (let i = 0; i < 200 && isFree(lock); i++) await new Promise((r) => setTimeout(r, 10));
  expect(isFree(lock)).toBe(false);
}

function checkout(files: readonly string[]) {
  const base = join(tmp, String(seq++));
  const co = join(base, "checkout");
  const bin = join(base, "bin");
  const home = join(base, "home");
  const cfg = join(base, "prod-config");
  for (const d of [co, bin, home, join(cfg, ".vercel")]) mkdirSync(d, { recursive: true });
  for (const f of files) {
    mkdirSync(dirname(join(co, f)), { recursive: true });
    copyFileSync(join(ROOT, f), join(co, f));
  }
  writeFileSync(join(cfg, ".env.prod"), "VERCEL_TOKEN=\n");
  writeFileSync(join(cfg, ".vercel", "project.json"), '{"orgId":"fake","projectId":"fake"}\n');
  const log = join(base, "calls");
  for (const s of STUBS) {
    writeFileSync(join(bin, s), `#!/usr/bin/env bash\nprintf '%s\\n' "${s} $*" >> "${log}"\nexit 1\n`);
    chmodSync(join(bin, s), 0o755);
  }
  /** Replaces checkout-relative script `rel` with a stub that logs `<rel> <argv>` and runs `body` (default: exit 1). */
  const stubScript = (rel: string, body = "exit 1") => {
    mkdirSync(dirname(join(co, rel)), { recursive: true });
    writeFileSync(join(co, rel), `#!/usr/bin/env bash\nprintf '%s\\n' "${rel} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(co, rel), 0o755);
  };
  const lock = join(base, "release.lock");
  const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, PROD_WRITES: "on", CRASH_DASH_RELEASE_LOCK: lock, PROD_CONFIG_DIR: cfg };
  const exec = (cmd: readonly [string, ...string[]], extra: Record<string, string> = {}) => {
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd: co, env: { ...env, ...extra }, encoding: "utf8", timeout: 30_000 });
    const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    return { status: r.status, out: r.stdout, err: r.stderr, calls };
  };
  return { co, lock, exec, stubScript };
}

describe("smoke-cron.sh", () => {
  it("control: lock free → takes it and reaches its first call", () => {
    const c = checkout(SMOKE_FILES);
    const r = c.exec(["bash", "scripts/smoke-cron.sh"], SMOKE_ENV);
    expect(r.err).not.toMatch(REFUSAL);
    expect(r.calls[0]).toMatch(SMOKE_FIRST_CALL);
    expect(isFree(c.lock)).toBe(true); // released when the run ends
  });

  it("lock held by another process → refuses before any call", async () => {
    const c = checkout(SMOKE_FILES);
    await holdElsewhere(c.lock);
    const r = c.exec(["bash", "scripts/smoke-cron.sh"], SMOKE_ENV);
    expect(r.calls).toEqual([]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(REFUSAL);
    expect(r.err).toContain("refusing the cron trigger");
  });

  it("run as a child of a lock-holding release (ship.sh §7) → inherits the lock, does NOT refuse", () => {
    const c = checkout(SMOKE_FILES);
    // The parent mirrors ship.sh: source the helper, take the lock, then `bash smoke-cron.sh` while still holding it;
    // it also reports whether the lock is still held by it after the child has exited.
    const parent = `. "${HELPER}"; release_lock_acquire "parent" || exit 9; bash scripts/smoke-cron.sh; echo "child=$?"; flock -n "$CRASH_DASH_RELEASE_LOCK" true && echo after=free || echo after=held`;
    const r = c.exec(["bash", "-c", parent], SMOKE_ENV);
    expect(r.err).not.toMatch(REFUSAL);
    expect(r.calls[0]).toMatch(SMOKE_FIRST_CALL);
    expect(r.out).toContain("after=held"); // the child's exit did not drop the parent's lock
  });

  it("the hand-down needs the inherited descriptor: marker env alone (fd 8 closed) → refuses", () => {
    const c = checkout(SMOKE_FILES);
    const parent = `. "${HELPER}"; release_lock_acquire "parent" || exit 9; bash scripts/smoke-cron.sh 8>&-`;
    const r = c.exec(["bash", "-c", parent], SMOKE_ENV);
    expect(r.calls).toEqual([]);
    expect(r.err).toMatch(REFUSAL);
  });

  it("a spoofed marker from an unrelated process → refuses", async () => {
    const c = checkout(SMOKE_FILES);
    await holdElsewhere(c.lock);
    const r = c.exec(["bash", "scripts/smoke-cron.sh"], { ...SMOKE_ENV, CRASH_DASH_RELEASE_LOCK_HELD: c.lock });
    expect(r.calls).toEqual([]);
    expect(r.err).toMatch(REFUSAL);
  });
});

describe("ship.sh ship", () => {
  it("lock held by another process → refuses before any call", async () => {
    const c = checkout(SHIP_FILES);
    await holdElsewhere(c.lock);
    const r = c.exec(["bash", "scripts/ship.sh", "ship"]);
    expect(r.calls).toEqual([]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(REFUSAL);
    expect(r.err).toContain("refusing ship");
    expect(r.err).toContain("✗ ship: release lock not taken");
  });
});

describe("ship.sh verify", () => {
  it("lock held by another process (e.g. a ladder `make ship`) → refuses before any gate or stack call", async () => {
    const c = checkout(SHIP_FILES);
    await holdElsewhere(c.lock);
    const r = c.exec(["bash", "scripts/ship.sh", "verify"]);
    expect(r.calls).toEqual([]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(REFUSAL);
    expect(r.err).toContain("refusing verify");
    expect(r.err).toContain("✗ verify: release lock not taken");
  });
});

describe("run-integration-tests.sh", () => {
  /** A checkout whose db.sh / db-test-files.sh are logging stubs, so "touched the CI stack" is an observable call. */
  const integCheckout = () => {
    const c = checkout(INTEG_FILES);
    c.stubScript("scripts/db.sh", "exit 0");
    c.stubScript("scripts/db-test-files.sh", "echo src/store.contract.test.ts");
    return c;
  };

  it("lock held by another process → refuses before db-test-files.sh or db.sh is called", async () => {
    const c = integCheckout();
    await holdElsewhere(c.lock);
    const r = c.exec(["bash", "scripts/run-integration-tests.sh"]);
    expect(r.calls).toEqual([]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(REFUSAL);
    expect(r.err).toContain("refusing the integration suite");
  });

  it("run as a child of a lock-holding ship.sh → inherits the lock, reaches `db.sh with ci`", () => {
    const c = integCheckout();
    // The parent mirrors ship.sh: source the helper, take the lock, run the suite while still holding it.
    const parent = `. "${HELPER}"; release_lock_acquire "ship" || exit 9; bash scripts/run-integration-tests.sh; echo "child=$?"`;
    const r = c.exec(["bash", "-c", parent]);
    expect(r.err).not.toMatch(REFUSAL);
    expect(r.out).toContain("child=0");
    expect(r.calls).toEqual(["scripts/db-test-files.sh ", expect.stringMatching(/^scripts\/db\.sh with ci -- /)]);
  });
});

describe("release_lock_busy (eufin-run-local.sh's probe)", () => {
  const probe = (c: ReturnType<typeof checkout>) =>
    c.exec(["bash", "-c", `. "${HELPER}"; if release_lock_busy; then echo busy; else echo free; fi`]).out.trim();

  it("free lock → free, and the probe does not keep it", () => {
    const c = checkout([HELPER]);
    expect(probe(c)).toBe("free");
    expect(isFree(c.lock)).toBe(true);
  });

  it("lock held by another process → busy", async () => {
    const c = checkout([HELPER]);
    await holdElsewhere(c.lock);
    expect(probe(c)).toBe("busy");
  });

  it("unopenable lock path → busy (fail safe)", () => {
    const c = checkout([HELPER]);
    const r = c.exec(["bash", "-c", `. "${HELPER}"; if release_lock_busy; then echo busy; else echo free; fi`], {
      CRASH_DASH_RELEASE_LOCK: join(c.co, "no-such-dir", "release.lock"),
    });
    expect(r.out.trim()).toBe("busy");
  });
});
