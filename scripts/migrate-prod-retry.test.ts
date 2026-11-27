import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// migrate-prod-local.sh retries a Supabase management-API call (`projects list`, `link`) on a transient 5xx and on
// nothing else. A copy of the script runs in a throwaway checkout against a stub `npx` whose management-API call fails
// with `fail` output for its first `failures` calls; every other call answers "nothing pending".

const ROOT = join(import.meta.dirname, "..");
const FILES = ["scripts/migrate-prod-local.sh", "scripts/lib/prod-writes.sh", "scripts/lib/prod-config.sh"];
const CF_502 =
  'Unexpected error retrieving remote project status: {"title":"Error 502: Bad gateway","status":502,"error_name":"origin_bad_gateway","retryable":true}';
const tmp = mkdtempSync(join(tmpdir(), "migrate-retry-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
function run(opts: { call: "link" | "projects"; failures: number; fail: string; token?: boolean }) {
  const base = join(tmp, String(seq++));
  const checkout = join(base, "checkout");
  const bin = join(base, "bin");
  const cfg = join(base, "prod-config");
  const log = join(base, "calls");
  const count = join(base, "count");
  for (const d of [checkout, bin, cfg, join(base, "home")]) mkdirSync(d, { recursive: true });
  for (const f of FILES) {
    mkdirSync(dirname(join(checkout, f)), { recursive: true });
    copyFileSync(join(ROOT, f), join(checkout, f));
  }
  writeFileSync(join(base, "fail.txt"), opts.fail);
  const stub = `#!/usr/bin/env bash
printf '%s\\n' "npx $*" >> "${log}"
case "$*" in
  "--yes supabase ${opts.call === "link" ? "link" : "projects list"}"*)
    n=$(( $(cat "${count}" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${count}"
    if [ "$n" -le ${opts.failures} ]; then cat "${join(base, "fail.txt")}" >&2; exit 7; fi ;;
  "--yes supabase migration list"*) printf 'Local | Remote | Time\\n------|--------|-----\\n' ;;
  "--yes supabase db push --dry-run"*) echo "Remote database is up to date." ;;
esac
exit 0
`;
  writeFileSync(join(bin, "npx"), stub);
  chmodSync(join(bin, "npx"), 0o755);
  const r = spawnSync("bash", ["scripts/migrate-prod-local.sh"], {
    cwd: checkout,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: join(base, "home"),
      PROD_CONFIG_DIR: cfg,
      PROD_WRITES: "on",
      SUPABASE_PROJECT_REF: "fakeref",
      SUPABASE_DB_PASSWORD: "fakepw",
      ...(opts.token === false ? {} : { SUPABASE_ACCESS_TOKEN: "faketoken" }),
      SUPABASE_API_BACKOFF: "0",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  const hits = calls.filter((c) => c.startsWith(`npx --yes supabase ${opts.call === "link" ? "link" : "projects list"}`));
  return { status: r.status, out: r.stdout + r.stderr, hits: hits.length };
}

describe("migrate-prod-local.sh — Supabase management-API retry", () => {
  it("link: one transient 502 → retried, the run completes", () => {
    const r = run({ call: "link", failures: 1, fail: CF_502 });
    expect(r.hits).toBe(2);
    expect(r.out).toContain("✓ nothing pending");
    expect(r.status).toBe(0);
  });

  it("link: the CLI's plain-text form (`unexpected … status 503: <body>`) → retried too", () => {
    const r = run({ call: "link", failures: 1, fail: "unexpected get pooler status 503: upstream request timeout" });
    expect(r.hits).toBe(2);
    expect(r.status).toBe(0);
  });

  it("link: a 502 on every attempt → fails after SUPABASE_API_ATTEMPTS (default 3) calls, with the CLI's exit code", () => {
    const r = run({ call: "link", failures: 99, fail: CF_502 });
    expect(r.hits).toBe(3);
    expect(r.out).toContain("::warning:: Supabase API transient 5xx (attempt 2)");
    expect(r.status).toBe(7);
  });

  it("link: a non-transient error (bad password) → fails on the first call, never retried", () => {
    const r = run({ call: "link", failures: 99, fail: "failed SASL auth (invalid SCRAM server-final-message received from server)" });
    expect(r.hits).toBe(1);
    expect(r.status).toBe(7);
  });

  it("stored-login probe: a 502 on every attempt → the retry warnings stay visible, then the refusal", () => {
    const r = run({ call: "projects", failures: 99, fail: CF_502, token: false });
    expect(r.hits).toBe(3);
    expect(r.out).toContain("::warning:: Supabase API transient 5xx");
    expect(r.out).toContain("or its API is down");
    expect(r.status).toBe(1);
  });

  it("stored-login probe: one transient 502 → retried, not misreported as unauthenticated", () => {
    const r = run({ call: "projects", failures: 1, fail: CF_502, token: false });
    expect(r.hits).toBe(2);
    expect(r.out).not.toContain("not authenticated");
    expect(r.status).toBe(0);
  });
});
