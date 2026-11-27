import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The DB helpers' pooler host (SUPABASE_DB_HOST): an exported value wins, else the checkout's prod config supplies it
// (scripts/lib/prod-config.{sh,ts}); neither → a refusal before any connection. setup-prod-ro-role.sh's config path is
// pinned in scripts/prod-writes-wiring.test.ts (its host reaches the run only through the config there).

const ROOT = join(import.meta.dirname, "..");
let tmp = "";
beforeAll(() => (tmp = mkdtempSync(join(tmpdir(), "prod-db-host-"))));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
/** A throwaway prod config dir holding `envProd` as its `.env.prod` (null = no file), plus a psql stub logging argv. */
function setup(envProd: string | null) {
  const base = join(tmp, String(seq++));
  const cfg = join(base, "cfg");
  const bin = join(base, "bin");
  mkdirSync(cfg, { recursive: true });
  mkdirSync(bin, { recursive: true });
  if (envProd !== null) writeFileSync(join(cfg, ".env.prod"), envProd);
  const log = join(base, "psql.log");
  writeFileSync(join(bin, "psql"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\n`);
  chmodSync(join(bin, "psql"), 0o755);
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  return { cfg, bin, calls };
}

describe("prod-psql-ro.sh SUPABASE_DB_HOST", () => {
  const psqlRo = (envProd: string | null, env: Record<string, string> = {}) => {
    const s = setup(envProd);
    const r = spawnSync("bash", [join(ROOT, "scripts/prod-psql-ro.sh"), "select 1"], {
      env: { PATH: `${s.bin}:${process.env.PATH ?? ""}`, HOME: tmp, PROD_CONFIG_DIR: s.cfg, ...env },
      encoding: "utf8",
    });
    return { status: r.status, err: r.stderr, calls: s.calls() };
  };

  it("unset in the env → the prod config's host reaches psql", () => {
    const r = psqlRo("SUPABASE_URL=https://fakeref.supabase.co\nSUPABASE_DB_HOST=cfg-host.invalid\n");
    expect(r.err).toBe("");
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toContain("host=cfg-host.invalid port=5432 dbname=postgres user=crash_ro.fakeref ");
  });

  it("an exported host wins over the config's", () => {
    const r = psqlRo("SUPABASE_URL=https://fakeref.supabase.co\nSUPABASE_DB_HOST=cfg-host.invalid\n", { SUPABASE_DB_HOST: "env-host.invalid" });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toContain("host=env-host.invalid ");
  });

  it("neither → the config's no-target refusal, no psql call", () => {
    const r = psqlRo("SUPABASE_URL=https://fakeref.supabase.co\n");
    expect(r.calls).toEqual([]);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("::error:: no target configured — ");
    expect(r.err).toContain("has no SUPABASE_DB_HOST");
  });
});

describe("probe-dbauth.ts SUPABASE_DB_HOST", () => {
  // No project ref → the probe stops at its missing-creds report (exit 2) before any connection; the report's host
  // line shows whether the host was found.
  const dbauth = (envProd: string | null) => {
    const s = setup(envProd);
    const r = spawnSync(join(ROOT, "node_modules/.bin/tsx"), [join(ROOT, "scripts/probe-dbauth.ts")], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: tmp, PROD_CONFIG_DIR: s.cfg, SUPABASE_DB_PASSWORD: "fakepw" },
      encoding: "utf8",
      timeout: 60_000,
    });
    return { status: r.status, err: r.stderr };
  };

  it("unset in the env → the prod config's host is found", () => {
    const r = dbauth("SUPABASE_DB_HOST=cfg-host.invalid\n");
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/SUPABASE_DB_HOST {7}set\n/);
  });

  it("no config file → reported MISSING, not thrown", () => {
    const r = dbauth(null);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/SUPABASE_DB_HOST {7}MISSING \(env, or the prod config's \.env\.prod\)/);
  });
});
