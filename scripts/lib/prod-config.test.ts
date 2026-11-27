import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prodProjectRef } from "../supabase-project.js";
import { prodBaseUrl } from "./prod-base-url.js";
import { aliasUrl, loadProdConfig, prodConfigBaseUrl, prodConfigDir, prodConfigRef } from "./prod-config.js";

// The checkout's prod config: the bash helper and its TS twin must resolve the same directory, load the same keys and
// refuse with the same ONE line. Both run over a scratch "checkout" (no .git, so its default config dir is itself)
// holding copies of the bash helpers at scripts/lib/, and over scratch config dirs holding fake files only.

const LIB = import.meta.dirname;
const FAKE_URL = "https://fakefakefakefakefake1.supabase.co";
let tmp = "";
let repo = "";
let n = 0;

type Env = Record<string, string>;
type Op =
  | { fn: "dir" | "ref" | "project" | "base" }
  | { fn: "probeBase"; show: readonly string[] }
  | { fn: "load"; optional?: boolean; only?: string[]; show: readonly string[] };
type Result = { out: string } | { err: string };
/** A table row: the op, its env, the twins' shared answer, and `after` — a side-effect check run before the answers. */
type Row = { op: Op; env: Env; want: Result; after?: () => void };

/** A fresh scratch config dir: `env` → `.env.prod`, `project` → `.vercel/project.json` (an object is JSON-encoded). */
function cfg(files: { env?: string; project?: object | string } = {}): string {
  const dir = join(tmp, `cfg-${++n}`);
  mkdirSync(dir);
  if (files.env !== undefined) writeFileSync(join(dir, ".env.prod"), files.env);
  if (files.project !== undefined) {
    mkdirSync(join(dir, ".vercel"));
    writeFileSync(join(dir, ".vercel", "project.json"), typeof files.project === "string" ? files.project : JSON.stringify(files.project));
  }
  return dir;
}

const dump = (env: Readonly<Record<string, string | undefined>>, keys: readonly string[]): string =>
  keys.map((k) => `${k}=${env[k] ?? "<unset>"}`).join("\n");

function ts(op: Op, env: Env, checkout: string = repo): Result {
  const e: Record<string, string | undefined> = { ...env };
  try {
    switch (op.fn) {
      case "dir":
        return { out: prodConfigDir(e, checkout) };
      case "ref":
        return { out: prodConfigRef(e, checkout) };
      case "project": // reads PROD_CONFIG_DIR off the same env; every row sets it, so `checkout` is moot
        return { out: prodProjectRef(e, e) };
      case "base":
        return { out: prodConfigBaseUrl(e, checkout) };
      case "probeBase": // reads PROD_CONFIG_DIR off the same env; every row sets it, so `checkout` is moot
        return { out: [prodBaseUrl(e), dump(e, op.show)].join("\n") };
      case "load":
        loadProdConfig(e, { optional: op.optional, only: op.only }, checkout);
        return { out: dump(e, op.show) };
    }
  } catch (err) {
    return { err: (err as Error).message };
  }
}

function sh(op: Op, env: Env, checkout: string = repo): Result {
  const call =
    op.fn === "load"
      ? `load_prod_config${op.optional ? " --optional" : ""}${op.only ? ` --only ${op.only.join(",")}` : ""}
         for k in ${op.show.join(" ")}; do printf '%s=%s\\n' "$k" "\${!k-<unset>}"; done`
      : op.fn === "probeBase"
        ? // called in THIS shell, never a `$(…)`: only the function's own subshell keeps the load out of the caller
          `prod_base_url
         for k in ${op.show.join(" ")}; do printf '%s=%s\\n' "$k" "\${!k-<unset>}"; done`
      : { dir: "prod_config_dir", ref: "prod_config_ref", project: "prod_project_ref", base: "prod_config_base_url" }[op.fn];
  const r = spawnSync("bash", ["-c", `set -euo pipefail; . "${join(checkout, "scripts", "lib", "prod-config.sh")}"; ${call}`], {
    cwd: tmp, // never the checkout: the helper must resolve from its own location
    env: { PATH: process.env.PATH ?? "", HOME: tmp, LANG: "C.UTF-8", ...env },
    encoding: "utf8",
  });
  return r.status === 0 ? { out: r.stdout.trim() } : { err: r.stderr.trim() };
}

const helperInto = (checkout: string) => {
  mkdirSync(join(checkout, "scripts", "lib"), { recursive: true });
  for (const f of ["prod-config.sh", "prod-writes.sh"]) copyFileSync(join(LIB, f), join(checkout, "scripts", "lib", f));
};

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "prod-config-")));
  repo = join(tmp, "repo");
  helperInto(repo);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const noTarget = (what: string) => ({ err: `::error:: no target configured — ${what} (set PROD_CONFIG_DIR)` });
const conflict = (k: string, dir: string, file = ".env.prod") => ({ err: `::error:: ${k} in the environment disagrees with ${dir}/${file} — unset it or set PROD_CONFIG_DIR` });
const ENV_PROD = [
  "# a comment line",
  `SUPABASE_URL=${FAKE_URL}`,
  "SUPABASE_PROJECT_REF=fakefakefakefakefake1",
  'export PROD_ALIAS="fake.example"',
  "SUPABASE_ANON_KEY=anon_fake",
  "NTFY_TOPIC=file_key",
  "QUOTED='a b'",
  "PROD_WRITES=on",
  "PROD_CONFIG_DIR=/somewhere/else",
  "",
].join("\n");
const PROJECT = { orgId: "team_fake", projectId: "prj_fake" };
const PROJECT_ENV = { VERCEL_ORG_ID: PROJECT.orgId, VERCEL_PROJECT_ID: PROJECT.projectId };
const SHOW = ["SUPABASE_URL", "PROD_ALIAS", "QUOTED", "PROD_WRITES", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"] as const;
/** probeBase's after-state: PROD_ALIAS first, so a value ending in whitespace never meets the bash twin's output trim. */
const SHOW_PB = ["PROD_ALIAS", "SUPABASE_URL", "QUOTED"] as const;

describe("prod-config.sh ≡ prod-config.ts", () => {
  it.each<[string, () => Row]>([
    // ── the directory ──
    ["dir: unset → this checkout's main worktree root (no .git → the checkout)", () => ({ op: { fn: "dir" }, env: {}, want: { out: repo } })],
    ["dir: blank = unset", () => ({ op: { fn: "dir" }, env: { PROD_CONFIG_DIR: "" }, want: { out: repo } })],
    ["dir: absolute, trailing slashes dropped", () => ({ op: { fn: "dir" }, env: { PROD_CONFIG_DIR: "/x/y//" }, want: { out: "/x/y" } })],
    ["dir: relative refuses", () => ({ op: { fn: "dir" }, env: { PROD_CONFIG_DIR: "rel/cfg" }, want: { err: "::error:: PROD_CONFIG_DIR must be an absolute path — got 'rel/cfg'" } })],
    // ── the loader ──
    ["load: PROD_CONFIG_DIR=/nonexistent refuses", () => ({ op: { fn: "load", show: SHOW }, env: { PROD_CONFIG_DIR: "/nonexistent" }, want: noTarget("/nonexistent/.env.prod") })],
    ["load: a relative PROD_CONFIG_DIR refuses, even --optional", () => ({ op: { fn: "load", optional: true, show: SHOW }, env: { PROD_CONFIG_DIR: "cfg" }, want: { err: "::error:: PROD_CONFIG_DIR must be an absolute path — got 'cfg'" } })],
    ["load: default dir with no .env.prod refuses naming it", () => ({ op: { fn: "load", show: SHOW }, env: {}, want: noTarget(join(repo, ".env.prod")) })],
    ["load: --optional with nothing there passes, loads nothing", () => ({ op: { fn: "load", optional: true, show: SHOW }, env: { PROD_CONFIG_DIR: "/nonexistent" }, want: { out: dump({}, SHOW) } })],
    ["load: every key + the Vercel ids; never PROD_WRITES / PROD_CONFIG_DIR from the file", () => {
      const dir = cfg({ env: ENV_PROD, project: PROJECT });
      return {
        op: { fn: "load", show: [...SHOW, "PROD_CONFIG_DIR"] },
        env: { PROD_CONFIG_DIR: dir },
        want: { out: dump({ SUPABASE_URL: FAKE_URL, PROD_ALIAS: "fake.example", QUOTED: "a b", VERCEL_ORG_ID: "team_fake", VERCEL_PROJECT_ID: "prj_fake", PROD_CONFIG_DIR: dir }, [...SHOW, "PROD_CONFIG_DIR"]) },
      };
    }],
    ["load: an ordinary key already set in the env wins over a differing file value (a blank one does not)", () => ({
      op: { fn: "load", show: [...SHOW, "NTFY_TOPIC"] },
      env: { PROD_CONFIG_DIR: cfg({ env: ENV_PROD, project: PROJECT }), NTFY_TOPIC: "env_key", QUOTED: "" },
      want: { out: dump({ SUPABASE_URL: FAKE_URL, PROD_ALIAS: "fake.example", QUOTED: "a b", VERCEL_ORG_ID: "team_fake", VERCEL_PROJECT_ID: "prj_fake", NTFY_TOPIC: "env_key" }, [...SHOW, "NTFY_TOPIC"]) },
    })],
    ["load: Vercel ids in the env with no project.json pass (nothing to compare against)", () => ({
      op: { fn: "load", show: SHOW },
      env: { PROD_CONFIG_DIR: cfg({ env: ENV_PROD }), VERCEL_ORG_ID: "team_env", VERCEL_PROJECT_ID: "prj_env" },
      want: { out: dump({ SUPABASE_URL: FAKE_URL, PROD_ALIAS: "fake.example", QUOTED: "a b", VERCEL_ORG_ID: "team_env", VERCEL_PROJECT_ID: "prj_env" }, SHOW) },
    })],
    // Read literally in BOTH twins: a sourced file would expand `$HOME`, run the `$(…)` and the backticks; a `'` must
    // survive the bash twin's single-quoted eval (a broken escape closes the quote and runs the `touch`).
    ["load: a `$`, a backtick, a `'` or a newline in a value stays as written", () => {
      const pwned = join(tmp, `pwned-${++n}`);
      const vals = { DOLLAR: "a$HOME$(echo b)c", TICK: "x`echo y`z", SQ: `it'; touch ${pwned}; : 's`, ML: "a\nb" };
      return {
        op: { fn: "load", show: Object.keys(vals) },
        env: { PROD_CONFIG_DIR: cfg({ env: `DOLLAR=${vals.DOLLAR}\nTICK="${vals.TICK}"\nSQ="${vals.SQ}"\nML="a\\nb"\n`, project: PROJECT }) },
        want: { out: dump(vals, Object.keys(vals)) },
        after: () => expect(existsSync(pwned), `${pwned} was created — a value ran as code`).toBe(false),
      };
    }],
    ["load: a .env.prod that is there but unreadable (a dangling symlink) refuses, even --optional", () => {
      const dir = cfg();
      symlinkSync(join(dir, "gone"), join(dir, ".env.prod"));
      return { op: { fn: "load", optional: true, show: SHOW }, env: { PROD_CONFIG_DIR: dir }, want: { err: `::error:: cannot read ${dir}/.env.prod` } };
    }],
    ["load: identity keys in the env equal to the file's (after its quoting) pass", () => ({
      op: { fn: "load", show: [...SHOW, "SUPABASE_PROJECT_REF"] },
      env: { PROD_CONFIG_DIR: cfg({ env: ENV_PROD, project: PROJECT }), SUPABASE_URL: FAKE_URL, SUPABASE_PROJECT_REF: "fakefakefakefakefake1", PROD_ALIAS: "fake.example", SUPABASE_ANON_KEY: "anon_fake", ...PROJECT_ENV },
      want: { out: dump({ SUPABASE_URL: FAKE_URL, PROD_ALIAS: "fake.example", QUOTED: "a b", VERCEL_ORG_ID: "team_fake", VERCEL_PROJECT_ID: "prj_fake", SUPABASE_PROJECT_REF: "fakefakefakefakefake1" }, [...SHOW, "SUPABASE_PROJECT_REF"]) },
    })],
    ...(["SUPABASE_URL", "SUPABASE_PROJECT_REF", "PROD_ALIAS", "SUPABASE_ANON_KEY"] as const).map((k): [string, () => Row] => [
      `load: env ${k} ≠ the file's refuses`,
      () => {
        const dir = cfg({ env: ENV_PROD, project: PROJECT });
        return { op: { fn: "load", show: SHOW }, env: { PROD_CONFIG_DIR: dir, [k]: "other" }, want: conflict(k, dir) };
      },
    ]),
    // The Vercel link is an identity too: an ambient VERCEL_ORG_ID / VERCEL_PROJECT_ID deploys to another project.
    ...(["VERCEL_ORG_ID", "VERCEL_PROJECT_ID"] as const).map((k): [string, () => Row] => [
      `load: env ${k} ≠ project.json's refuses, even --optional`,
      () => {
        const dir = cfg({ env: ENV_PROD, project: PROJECT });
        return { op: { fn: "load", optional: true, show: SHOW }, env: { PROD_CONFIG_DIR: dir, [k]: "other" }, want: conflict(k, dir, ".vercel/project.json") };
      },
    ]),
    ["load: an identity conflict refuses even --optional", () => {
      const dir = cfg({ env: ENV_PROD });
      return { op: { fn: "load", optional: true, show: SHOW }, env: { PROD_CONFIG_DIR: dir, PROD_ALIAS: "other.example" }, want: conflict("PROD_ALIAS", dir) };
    }],
    ["load: --only loads just the named keys (no Vercel link needed; an unloaded identity key is not compared)", () => ({
      op: { fn: "load", only: ["SUPABASE_URL"], show: SHOW },
      env: { PROD_CONFIG_DIR: cfg({ env: ENV_PROD }), PROD_ALIAS: "other.example" },
      want: { out: dump({ SUPABASE_URL: FAKE_URL, PROD_ALIAS: "other.example" }, SHOW) },
    })],
    ["load: --only with a key the file lacks refuses", () => {
      const dir = cfg({ env: ENV_PROD });
      return { op: { fn: "load", only: ["SUPABASE_URL", "FRED_API_KEY"], show: SHOW }, env: { PROD_CONFIG_DIR: dir }, want: noTarget(`${dir}/.env.prod has no FRED_API_KEY`) };
    }],
    ["load: no .vercel/project.json refuses", () => {
      const dir = cfg({ env: ENV_PROD });
      return { op: { fn: "load", show: SHOW }, env: { PROD_CONFIG_DIR: dir }, want: noTarget(`${dir}/.vercel/project.json`) };
    }],
    ["load: a project.json without projectId refuses", () => {
      const dir = cfg({ env: ENV_PROD, project: { orgId: "team_fake" } });
      return { op: { fn: "load", show: SHOW }, env: { PROD_CONFIG_DIR: dir }, want: noTarget(`${dir}/.vercel/project.json has no projectId`) };
    }],
    ["load: an unparsable project.json refuses", () => {
      const dir = cfg({ env: ENV_PROD, project: "{not json" });
      return { op: { fn: "load", show: SHOW }, env: { PROD_CONFIG_DIR: dir }, want: { err: `::error:: cannot parse ${dir}/.vercel/project.json` } };
    }],
    // ── the project ref ──
    ["ref: from SUPABASE_URL's host", () => ({ op: { fn: "ref" }, env: { SUPABASE_URL: `${FAKE_URL}/` }, want: { out: "fakefakefakefakefake1" } })],
    ["ref: SUPABASE_PROJECT_REF alone", () => ({ op: { fn: "ref" }, env: { SUPABASE_PROJECT_REF: "fakefakefakefakefake2" }, want: { out: "fakefakefakefakefake2" } })],
    ["ref: both set and agreeing", () => ({ op: { fn: "ref" }, env: { SUPABASE_PROJECT_REF: "fakefakefakefakefake1", SUPABASE_URL: FAKE_URL }, want: { out: "fakefakefakefakefake1" } })],
    ["ref: SUPABASE_PROJECT_REF ≠ SUPABASE_URL's host refuses", () => ({
      op: { fn: "ref" },
      env: { SUPABASE_PROJECT_REF: "fakefakefakefakefake2", SUPABASE_URL: FAKE_URL },
      want: { err: "::error:: SUPABASE_PROJECT_REF (fakefakefakefakefake2) disagrees with SUPABASE_URL's host (fakefakefakefakefake1.supabase.co) — fix the prod config" },
    })],
    ["ref: a SUPABASE_URL that is not <ref>.supabase.co refuses", () => ({ op: { fn: "ref" }, env: { SUPABASE_URL: "http://127.0.0.1:54321" }, want: { err: "::error:: SUPABASE_URL is not https://<ref>.supabase.co — got 'http://127.0.0.1:54321'" } })],
    ["ref: neither set refuses", () => ({ op: { fn: "ref" }, env: { PROD_CONFIG_DIR: "/nonexistent" }, want: noTarget("/nonexistent/.env.prod has no SUPABASE_URL") })],
    // ── the ops scripts' ref (prodProjectRef ≡ prod_project_ref): env ref, else ONLY the file's two ref keys ──
    ["project: an env SUPABASE_PROJECT_REF wins (the file, holding another ref, is not read)", () => ({
      op: { fn: "project" },
      env: { PROD_CONFIG_DIR: cfg({ env: ENV_PROD }), SUPABASE_PROJECT_REF: "fakefakefakefakefake2" },
      want: { out: "fakefakefakefakefake2" },
    })],
    ["project: an env SUPABASE_URL is ignored, even when the file's differs", () => ({
      op: { fn: "project" },
      env: { PROD_CONFIG_DIR: cfg({ env: ENV_PROD }), SUPABASE_URL: "https://fakefakefakefakefake9.supabase.co" },
      want: { out: "fakefakefakefakefake1" },
    })],
    ["project: a whitespace-only env ref is unset → the file's ref (no identity conflict)", () => ({
      op: { fn: "project" },
      env: { PROD_CONFIG_DIR: cfg({ env: ENV_PROD }), SUPABASE_PROJECT_REF: " \t " },
      want: { out: "fakefakefakefakefake1" },
    })],
    ["project: a non-ASCII-space env ref is NOT blank (ASCII trim, the shell's) → refused as a ref", () => ({
      op: { fn: "project" },
      env: { PROD_CONFIG_DIR: cfg({ env: ENV_PROD }), SUPABASE_PROJECT_REF: "\u00a0" },
      want: { err: "::error:: SUPABASE_PROJECT_REF is not a project ref — got '\u00a0'" },
    })],
    ["project: no config refuses", () => ({ op: { fn: "project" }, env: { PROD_CONFIG_DIR: "/nonexistent" }, want: noTarget("/nonexistent/.env.prod has no SUPABASE_URL") })],
    // ── the base URL ──
    ["base: a bare host", () => ({ op: { fn: "base" }, env: { PROD_ALIAS: " fake.example " }, want: { out: "https://fake.example" } })],
    ["base: an https URL, trailing slash dropped", () => ({ op: { fn: "base" }, env: { PROD_ALIAS: "https://fake.example/" }, want: { out: "https://fake.example" } })],
    ["base: an http URL refuses", () => ({ op: { fn: "base" }, env: { PROD_ALIAS: "http://fake.example" }, want: { err: "::error:: PROD_ALIAS must be a host or an https URL — got 'http://fake.example'" } })],
    ["base: a URL with a path refuses", () => ({ op: { fn: "base" }, env: { PROD_ALIAS: "fake.example/lab" }, want: { err: "::error:: PROD_ALIAS must be a host or an https URL — got 'https://fake.example/lab'" } })],
    ["base: unset refuses", () => ({ op: { fn: "base" }, env: { PROD_CONFIG_DIR: "/nonexistent" }, want: noTarget("/nonexistent/.env.prod has no PROD_ALIAS") })],
    // ── the probes' base URL (prodBaseUrl ≡ prod_base_url): a non-blank env PROD_ALIAS, else ONLY the file's ──
    ["probeBase: a non-blank env PROD_ALIAS wins, never compared against the file", () => ({
      op: { fn: "probeBase", show: SHOW_PB },
      env: { PROD_CONFIG_DIR: cfg({ env: ENV_PROD }), PROD_ALIAS: " other.example " },
      want: { out: `https://other.example\n${dump({ PROD_ALIAS: " other.example " }, SHOW_PB)}` },
    })],
    ["probeBase: a blank / ASCII-whitespace env PROD_ALIAS → the file's (no identity conflict)", () => ({
      op: { fn: "probeBase", show: SHOW_PB },
      env: { PROD_CONFIG_DIR: cfg({ env: ENV_PROD }), PROD_ALIAS: " \t\n " },
      want: { out: `https://fake.example\n${dump({ PROD_ALIAS: " \t\n " }, SHOW_PB)}` },
    })],
    ["probeBase: a non-ASCII-space env PROD_ALIAS is NOT blank (ASCII trim) → refused as an alias", () => ({
      op: { fn: "probeBase", show: [] },
      env: { PROD_CONFIG_DIR: cfg({ env: ENV_PROD }), PROD_ALIAS: "\u00a0" },
      want: { err: "::error:: PROD_ALIAS must be a host or an https URL — got 'https://\u00a0'" },
    })],
    ["probeBase: no config refuses", () => ({ op: { fn: "probeBase", show: [] }, env: { PROD_CONFIG_DIR: "/nonexistent" }, want: noTarget("/nonexistent/.env.prod") })],
    ["probeBase: the caller's env is never written (no file key reaches it)", () => ({
      op: { fn: "probeBase", show: SHOW_PB },
      env: { PROD_CONFIG_DIR: cfg({ env: ENV_PROD }) },
      want: { out: `https://fake.example\n${dump({}, SHOW_PB)}` },
    })],
  ])("%s", (_, row) => {
    const { op, env, want, after } = row();
    const got = { ts: ts(op, env), sh: sh(op, env) };
    after?.();
    expect(got.ts).toEqual(want);
    expect(got.sh).toEqual(want);
  });

  // The default must be the MAIN worktree root, so a linked worktree (`git worktree add`, `.claude/worktrees/*`)
  // reads the primary checkout's config, never a copy of its own.
  it("dir: unset, from a linked worktree → the main worktree root", () => {
    const main = join(tmp, "wt-main");
    const linked = join(tmp, "wt-linked");
    helperInto(main);
    const gitEnv = { PATH: process.env.PATH ?? "", HOME: tmp, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    for (const args of [["init", "-q", "-b", "main"], ["add", "scripts"], ["commit", "-q", "-m", "helper"], ["worktree", "add", "-q", "--detach", linked]]) {
      const r = spawnSync("git", ["-C", main, ...args], { env: gitEnv, encoding: "utf8" });
      expect(r.status, `git ${args.join(" ")}: ${r.stderr}`).toBe(0);
    }
    for (const r of [ts({ fn: "dir" }, {}, linked), sh({ fn: "dir" }, {}, linked)]) expect(r).toEqual({ out: main });
  });
});

describe("aliasUrl — the probes' PROD_ALIAS reader", () => {
  it("a bare host (the deploy's form) becomes an https URL; an https URL passes; a trailing slash drops", () => {
    expect(aliasUrl("prod-alias.invalid")).toBe("https://prod-alias.invalid");
    expect(aliasUrl("https://prod-alias.invalid/")).toBe("https://prod-alias.invalid");
    expect(() => new URL(aliasUrl("prod-alias.invalid"))).not.toThrow();
  });
  it("refuses another scheme or a path", () => {
    expect(() => aliasUrl("http://prod-alias.invalid")).toThrow(/PROD_ALIAS must be a host or an https URL/);
    expect(() => aliasUrl("prod-alias.invalid/x")).toThrow(/PROD_ALIAS must be a host or an https URL/);
  });
});
