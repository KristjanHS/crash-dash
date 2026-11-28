import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Wiring pins for the prod-writes switch: every shell writer refuses BEFORE its first CLI/network call when prod
// writes are off, and gets past the switch when they are on. Switch parsing is pinned in src/prod-writes.test.ts;
// the cron-trigger helpers in scripts/lib/cron-trigger.test.ts; the store seam in src/store.pure-seams.test.ts.
//
// Each case runs a verbatim COPY of the writer (plus the helpers it sources) inside a throwaway checkout, so the
// switch file the helper resolves is the throwaway one (absent → env decides), PROD_CONFIG_DIR is a throwaway prod
// config dir (no real `.env.prod` / `.vercel/` is read), and HOME is a temp dir. Every CLI the writers call is a stub on PATH that logs its argv and exits 1:
// `off` must log nothing; `on` must log the writer's first post-switch call (which then fails, ending the run).

const ROOT = join(import.meta.dirname, "..");
const STUBS = ["npx", "vercel", "curl", "supabase", "psql", "tsx"] as const;

interface Writer {
  readonly name: string;
  /** Repo-relative files copied into the throwaway checkout (the writer + whatever it sources/reads). */
  readonly files: readonly string[];
  /** argv for the run, cwd = the throwaway checkout. */
  readonly cmd: readonly [string, ...string[]];
  /** The `<what>` the writer passes to require_prod_writes. */
  readonly what: string;
  /** The first stub call the writer makes once past the switch. */
  readonly firstCall: RegExp;
  readonly env?: Readonly<Record<string, string>>;
  /** Extra fixture files (checkout-relative path → content); `~/` paths land in the temp HOME. */
  readonly fixtures?: Readonly<Record<string, string>>;
  /** Files in the throwaway prod config dir (PROD_CONFIG_DIR-relative path → content). */
  readonly config?: Readonly<Record<string, string>>;
}

const PW = ["scripts/lib/prod-writes.sh"];
const PC = [...PW, "scripts/lib/prod-config.sh"];
const CRON = [...PC, "scripts/lib/cron-trigger.sh"];
const VERCEL_LINK = { ".vercel/project.json": '{"orgId":"fake","projectId":"fake"}\n' };

const WRITERS: readonly Writer[] = [
  {
    name: "apply-waf-rules.sh (stage)",
    files: [...PC, "scripts/apply-waf-rules.sh", "scripts/waf-rules.json"],
    cmd: ["bash", "scripts/apply-waf-rules.sh"],
    what: "the firewall write",
    firstCall: /^npx --yes vercel firewall rules add /,
    config: { ".env.prod": "", ...VERCEL_LINK }, // the Vercel link comes from the config, never the cwd
  },
  {
    name: "apply-waf-rules.sh --confirm-publish",
    files: [...PC, "scripts/apply-waf-rules.sh", "scripts/waf-rules.json"],
    cmd: ["bash", "scripts/apply-waf-rules.sh", "--confirm-publish"],
    what: "the firewall write",
    firstCall: /^npx --yes vercel firewall rules add /,
    config: { ".env.prod": "", ...VERCEL_LINK },
  },
  {
    name: "migrate-prod-local.sh",
    files: [...PC, "scripts/migrate-prod-local.sh"],
    cmd: ["bash", "scripts/migrate-prod-local.sh"],
    what: "the schema migration",
    firstCall: /^npx --yes supabase link --project-ref fakeref /,
    env: { SUPABASE_PROJECT_REF: "fakeref", SUPABASE_DB_PASSWORD: "fakepw", SUPABASE_ACCESS_TOKEN: "faketoken" },
  },
  {
    name: "publish-calibration-prod.sh",
    files: [...PC, "scripts/publish-calibration-prod.sh"],
    cmd: ["bash", "scripts/publish-calibration-prod.sh"],
    what: "the calibration publish",
    firstCall: /^npx tsx scripts\/backtest\/publish-calibration\.ts/,
    config: { ".env.prod": "SUPABASE_URL=https://fake.example.invalid\nSUPABASE_SERVICE_KEY=fakekey\n" },
  },
  {
    name: "deploy-prod-local.sh",
    files: [...PC, "scripts/deploy-prod-local.sh"],
    cmd: ["bash", "scripts/deploy-prod-local.sh", "payload"], // a deploy tree: the checkout itself refuses
    what: "the deploy",
    // The config stamp runs before any network call (CLI resolve, whoami, roster), so it is the first stub call.
    firstCall: /^npx tsx \S+\/scripts\/stamp-deploy-config\.ts \S+\/payload$/,
    fixtures: { "payload/index.html": "" },
    // The stamp's three keys in the file: the deploy reads them from the config alone and refuses a config lacking one.
    config: { ".env.prod": "VERCEL_TOKEN=\nSUPABASE_URL=https://fake.example.invalid\nSUPABASE_ANON_KEY=fakekey\nPROD_ALIAS=fake.example.invalid\n", ...VERCEL_LINK },
  },
  {
    name: "setup-prod-ro-role.sh",
    files: [...PC, "scripts/setup-prod-ro-role.sh"],
    cmd: ["bash", "scripts/setup-prod-ro-role.sh"],
    what: "the read-only role setup",
    // The project ref and the pooler host come from the prod config (no default) — `fakeref` proves it reached the call.
    firstCall: /^curl -sS -X POST https:\/\/api\.supabase\.com\/v1\/projects\/fakeref\/database\/query /,
    config: { ".env.prod": "SUPABASE_URL=https://fakeref.supabase.co\nSUPABASE_DB_HOST=db.fake.example.invalid\n" },
    fixtures: { "~/.supabase/access-token": "faketoken\n" },
  },
  {
    name: "make purge",
    files: [...PC, "Makefile"],
    cmd: ["make", "--no-print-directory", "purge"],
    what: "the edge-cache purge",
    firstCall: /^npx vercel cache purge --yes$/,
    config: { ".env.prod": "", ...VERCEL_LINK },
  },
  {
    name: "smoke-cron.sh",
    files: [...CRON, "scripts/lib/release-lock.sh", "scripts/smoke-cron.sh"],
    cmd: ["bash", "scripts/smoke-cron.sh"],
    what: "the cron trigger",
    firstCall: /^curl -fsS .*https:\/\/fake\.example\.invalid\/rest\/v1\//,
    env: { SUPABASE_URL: "https://fake.example.invalid", SUPABASE_SERVICE_KEY: "fakekey", BASE_URL: "http://127.0.0.1:9", MAX_WAIT_SECS: "0" },
    config: { ".env.prod": "VERCEL_TOKEN=\n", ...VERCEL_LINK },
  },
  {
    name: "verify-calibration-publish.sh --cron",
    files: [...CRON, "scripts/verify-calibration-publish.sh"],
    cmd: ["bash", "scripts/verify-calibration-publish.sh", "--cron"],
    what: "the cron trigger",
    firstCall: /^curl -fsS -X POST https:\/\/api\.supabase\.com\/v1\/projects\/fakeref\/database\/query /,
    env: { SUPABASE_ACCESS_TOKEN: "faketoken", CRON_SECRET: "fakesecret", BASE_URL: "http://127.0.0.1:9" },
    config: { ".env.prod": "SUPABASE_URL=https://fakeref.supabase.co\n" },
  },
];

let tmp = "";
beforeAll(() => (tmp = mkdtempSync(join(tmpdir(), "prod-writes-wiring-"))));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
function run(w: Writer, prodWrites: "on" | "off") {
  const base = join(tmp, String(seq++));
  const checkout = join(base, "checkout");
  const home = join(base, "home");
  const bin = join(base, "bin");
  const cfg = join(base, "prod-config");
  const log = join(base, "calls");
  for (const d of [checkout, home, bin, cfg]) mkdirSync(d, { recursive: true });
  for (const f of w.files) {
    mkdirSync(dirname(join(checkout, f)), { recursive: true });
    copyFileSync(join(ROOT, f), join(checkout, f));
  }
  for (const [p, body] of Object.entries(w.fixtures ?? {})) {
    const dest = p.startsWith("~/") ? join(home, p.slice(2)) : join(checkout, p);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
  }
  for (const [p, body] of Object.entries(w.config ?? {})) {
    mkdirSync(dirname(join(cfg, p)), { recursive: true });
    writeFileSync(join(cfg, p), body);
  }
  spawnSync("git", ["init", "-q", checkout]); // deploy-prod-local.sh reads `git status` (a read, never a stub)
  for (const s of STUBS) {
    writeFileSync(join(bin, s), `#!/usr/bin/env bash\nprintf '%s\\n' "${s} $*" >> "${log}"\necho "${s} stub failed" >&2\nexit 1\n`);
    chmodSync(join(bin, s), 0o755);
  }
  const r = spawnSync(w.cmd[0], w.cmd.slice(1), {
    cwd: checkout,
    // The release lock (scripts/lib/release-lock.sh) goes to a per-run temp file, never the machine-wide path.
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, CRASH_DASH_RELEASE_LOCK: join(base, "release.lock"), PROD_CONFIG_DIR: cfg, ...w.env, PROD_WRITES: prodWrites },
    encoding: "utf8",
    timeout: 30_000,
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { status: r.status, out: r.stdout, err: r.stderr, calls };
}

describe.each(WRITERS)("$name", (w) => {
  it("prod writes off: refuses with the ::error:: line, no CLI/network call", () => {
    const r = run(w, "off");
    expect(r.calls).toEqual([]);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain(`::error:: refusing ${w.what} — prod writes are not on (env PROD_WRITES)`);
  });

  it("prod writes on: passes the switch and reaches its first CLI/network call", () => {
    const r = run(w, "on");
    expect(r.err).not.toContain("refusing");
    expect(r.calls[0]).toMatch(w.firstCall);
  });
});

// The publish captures its run's stdout+stderr to assert on it; a failed run must still print that capture, or the
// failure's reason never reaches the ship log (`set -e` used to exit on the failed substitution before the printf).
it("publish-calibration-prod.sh: a failed publish exits non-zero and still prints the run's own output", () => {
  const publish = WRITERS.find((w) => w.name === "publish-calibration-prod.sh");
  if (!publish) throw new Error("publish-calibration-prod.sh missing from WRITERS");
  const r = run(publish, "on");
  expect(r.status).toBe(1);
  expect(r.out).toContain("npx stub failed");
});

// An env file must never carry the override: the writer loads the prod config's `.env.prod` into its env, so a
// `PROD_WRITES=on` line there would pass every run. Refused even when the command's own env says `on`.
it("a writer whose prod config's .env.prod sets PROD_WRITES=on is refused, no CLI/network call", () => {
  const deploy = WRITERS.find((w) => w.name === "deploy-prod-local.sh");
  if (!deploy) throw new Error("deploy-prod-local.sh missing from WRITERS");
  const r = run({ ...deploy, config: { ...deploy.config, ".env.prod": "VERCEL_TOKEN=\nPROD_WRITES=on\n" } }, "on");
  expect(r.calls).toEqual([]);
  expect(r.status).not.toBe(0);
  expect(r.err).toContain(`::error:: refusing ${deploy.what} — PROD_WRITES must not be set in an env file (`);
});

// The writers that need the prod config refuse without it — one `no target configured` line, before any CLI/network
// call — never falling back to the cwd's files or the ambient env (smoke-cron's case carries SUPABASE_* in its env).
it.each(["publish-calibration-prod.sh", "deploy-prod-local.sh", "make purge", "smoke-cron.sh"])(
  "%s with an empty prod config dir → the no-target refusal, no CLI/network call",
  (name) => {
    const w = WRITERS.find((x) => x.name === name);
    if (!w) throw new Error(`${name} missing from WRITERS`);
    const r = run({ ...w, config: {} }, "on");
    expect(r.calls).toEqual([]);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("::error:: no target configured — ");
  },
);
