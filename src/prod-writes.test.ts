import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PLACEHOLDER, STAMP_SET } from "../scripts/stamp-deploy-config.js";
import { requireProdWrites } from "./prod-writes.js";

// The prod-writes switch: the bash helper and its TS twin must read the same `.prod-writes` the same way, and the
// wired prod writers must refuse BEFORE touching anything outward. Both run over a scratch "checkout" holding a
// copy of the bash helper at scripts/lib/, so `<checkout>/.prod-writes` resolves inside the scratch dir.

const SCRIPTS = join(import.meta.dirname, "..", "scripts");
let tmp = "";
let repo = "";
const switchFile = () => join(repo, ".prod-writes");

/** Set the scratch checkout's switch: a string is written, `null` removes it, `"<dir>"` makes it a directory. */
function setSwitch(content: string | null): void {
  rmSync(switchFile(), { recursive: true, force: true });
  if (content === "<dir>") mkdirSync(switchFile());
  else if (content !== null) writeFileSync(switchFile(), content);
}

const baseEnv = (prodWrites?: string): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: tmp,
  ...(prodWrites === undefined ? {} : { PROD_WRITES: prodWrites }),
});

/** Both twins over one checkout (default: the scratch one): `{ ts, sh }` each `null` when passed, else the refusal. */
function both(prodWrites?: string, checkout: string = repo, extra: Record<string, string> = {}): { ts: string | null; sh: string | null } {
  let ts: string | null = null;
  try {
    requireProdWrites("the test write", { PROD_WRITES: prodWrites, ...extra }, checkout);
  } catch (e) {
    ts = (e as Error).message;
  }
  const lib = join(checkout, "scripts", "lib", "prod-writes.sh");
  const r = spawnSync("bash", ["-c", `set -euo pipefail; . "${lib}"; require_prod_writes "the test write"`], {
    cwd: tmp, // never the checkout: the helper must resolve the file from its own location
    env: { ...baseEnv(prodWrites), ...extra, LANG: "C.UTF-8" }, // a UTF-8 locale widens bash's [:space:] past ASCII
    encoding: "utf8",
  });
  return { ts, sh: r.status === 0 ? null : r.stderr.trim() };
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "prod-writes-"));
  repo = join(tmp, "repo");
  for (const f of ["deploy-prod-local.sh", "ship.sh", "lib/prod-writes.sh", "lib/prod-config.sh"]) {
    mkdirSync(dirname(join(repo, "scripts", f)), { recursive: true });
    copyFileSync(join(SCRIPTS, f), join(repo, "scripts", f));
  }
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("require_prod_writes ≡ requireProdWrites", () => {
  it.each<[string, string | null, string | undefined]>([
    ["file `off`", "off\n", undefined],
    ["file `Off` (case-insensitive, still off)", " Off \n", undefined],
    ["unknown file content", "yes\n", undefined],
    ["an empty file", "", undefined],
    ["a directory in place of the file", "<dir>", undefined],
    ["env `off` over file `on`", "on\n", " OFF "],
    ["unknown env value over file `on`", "on\n", "yes"],
    ["blank env (= unset) over file `off`", "off\n", "  "],
    ["a BOM before file `on` (ASCII-only trim)", "\uFEFFon\n", undefined],
    ["NBSP-padded env `on` (ASCII-only trim)", "off\n", "\u00A0on\u00A0"],
    ["EM-SPACE-padded env `on` (ASCII-only trim, even under a UTF-8 locale)", "off\n", "\u2003on\u2003"],
  ])("refuses %s — one ::error:: naming the write and the override", (_, file, env) => {
    setSwitch(file);
    const r = both(env);
    for (const msg of [r.ts, r.sh]) {
      expect(msg).toMatch(/^::error:: refusing the test write — /);
      expect(msg).toContain("PROD_WRITES=on");
    }
  });

  it.each<[string, string | null, string | undefined]>([
    ["file `on`", "on\n", undefined],
    ["file `ON` padded", "  ON \n", undefined],
    ["file `on` with CRLF", "on\r\n", undefined],
    ["no file, no .git (a tree with no git metadata)", null, undefined],
    ["no file, blank env", null, ""],
    ["env `on` over file `off`", "off\n", "on"],
  ])("passes %s", (_, file, env) => {
    setSwitch(file);
    expect(both(env)).toEqual({ ts: null, sh: null });
  });
});

// The env override must never come from an env file: a writer that sources `.env.prod` / loads `--env-file=` would
// otherwise carry `PROD_WRITES=on` into every run. Both twins refuse on the line itself — even with env `on` and file
// `on` — and never on a commented or blank one.
describe("PROD_WRITES in an env file", () => {
  const envFile = (name: string) => join(repo, name);
  afterEach(() => {
    for (const name of [".env.prod", ".env.local"]) rmSync(envFile(name), { force: true });
  });

  it.each<[string, string, string]>([
    ["`PROD_WRITES=on` in .env.prod", ".env.prod", "A=1\nPROD_WRITES=on\n"],
    ["`export PROD_WRITES=\"on\"` in .env.prod", ".env.prod", "export PROD_WRITES=\"on\"\n"],
    ["`PROD_WRITES=off` in .env.local (any value)", ".env.local", "  PROD_WRITES = off\r\n"],
  ])("refuses %s, even under env `on` + file `on`", (_, name, body) => {
    setSwitch("on\n");
    writeFileSync(envFile(name), body);
    const r = both("on");
    for (const msg of [r.ts, r.sh]) {
      expect(msg).toMatch(/^::error:: refusing the test write — PROD_WRITES must not be set in an env file \(/);
      expect(msg).toContain(`${join(realpathSync(repo), name)}) — remove it`);
    }
  });

  // The checkout's prod config dir (PROD_CONFIG_DIR, scripts/lib/prod-config.sh) is a third env-file location.
  it("refuses `PROD_WRITES=on` in <PROD_CONFIG_DIR>/.env.prod (a clean one passes), even under env `on` + file `on`", () => {
    setSwitch("on\n");
    const cfg = join(tmp, "prod-config");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, ".env.prod"), "SUPABASE_URL=https://fakefakefakefakefake1.supabase.co\n");
    expect(both("on", repo, { PROD_CONFIG_DIR: `${cfg}/` })).toEqual({ ts: null, sh: null });
    writeFileSync(join(cfg, ".env.prod"), "SUPABASE_URL=https://fakefakefakefakefake1.supabase.co\nPROD_WRITES=on\n");
    const r = both("on", repo, { PROD_CONFIG_DIR: `${cfg}/` });
    rmSync(cfg, { recursive: true });
    for (const msg of [r.ts, r.sh]) expect(msg).toBe(`::error:: refusing the test write — PROD_WRITES must not be set in an env file (${join(cfg, ".env.prod")}) — remove it`);
  });

  it("refuses a relative PROD_CONFIG_DIR (its env files cannot be located)", () => {
    setSwitch("on\n");
    const r = both("on", repo, { PROD_CONFIG_DIR: "prod-config" });
    for (const msg of [r.ts, r.sh]) expect(msg).toBe("::error:: refusing the test write — PROD_CONFIG_DIR must be an absolute path — got 'prod-config'");
  });

  it.each<[string, string]>([
    ["a commented `# PROD_WRITES=on`", "# PROD_WRITES=on\n  #PROD_WRITES=on\nOTHER=1\n"],
    ["a blank `PROD_WRITES=\"\"` / `PROD_WRITES=`", "PROD_WRITES=\"\"\nPROD_WRITES= # unset\n"],
    ["a different key containing the name", "NO_PROD_WRITES=on\nPROD_WRITES_X=on\n"],
  ])("passes %s in .env.prod", (_, body) => {
    setSwitch("on\n");
    writeFileSync(envFile(".env.prod"), body);
    expect(both("on")).toEqual({ ts: null, sh: null });
  });
});

// Where the switch lives: a linked worktree (`git worktree add`, `.claude/worktrees/*`) has no `.prod-writes` of its
// own — both twins must read the MAIN worktree root's, and refuse when `.git` exists but git cannot resolve it.
describe("switch location under git", () => {
  let main = "";
  let linked = "";
  let broken = "";
  const helperInto = (checkout: string) => {
    mkdirSync(join(checkout, "scripts", "lib"), { recursive: true });
    copyFileSync(join(SCRIPTS, "lib", "prod-writes.sh"), join(checkout, "scripts", "lib", "prod-writes.sh"));
  };
  beforeAll(() => {
    main = join(tmp, "wt-main");
    linked = join(tmp, "wt-linked");
    broken = join(tmp, "wt-broken");
    helperInto(main);
    const gitEnv = { ...baseEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    for (const args of [["init", "-q", "-b", "main"], ["add", "scripts"], ["commit", "-q", "-m", "helper"], ["worktree", "add", "-q", "--detach", linked]]) {
      const r = spawnSync("git", ["-C", main, ...args], { env: gitEnv, encoding: "utf8" });
      expect(r.status, `git ${args.join(" ")}: ${r.stderr}`).toBe(0);
    }
    helperInto(broken);
    writeFileSync(join(broken, ".git"), `gitdir: ${join(tmp, "no-such-gitdir")}\n`);
  });

  it("a linked worktree refuses on the main root's `off` (its own checkout has no file)", () => {
    writeFileSync(join(main, ".prod-writes"), "off\n");
    expect(existsSync(join(linked, ".prod-writes"))).toBe(false);
    const r = both(undefined, linked);
    for (const msg of [r.ts, r.sh]) expect(msg).toContain(`not on (${join(realpathSync(main), ".prod-writes")})`);
  });

  it("a linked worktree passes on the main root's `on`", () => {
    writeFileSync(join(main, ".prod-writes"), "on\n");
    expect(both(undefined, linked)).toEqual({ ts: null, sh: null });
  });

  it("a PROD_WRITES env-file line at the main root OR the linked worktree's own checkout refuses the linked worktree", () => {
    writeFileSync(join(main, ".prod-writes"), "on\n");
    for (const [dir, name] of [[main, ".env.prod"], [linked, ".env.local"]] as const) {
      writeFileSync(join(dir, name), "PROD_WRITES=on\n");
      const r = both("on", linked);
      rmSync(join(dir, name));
      for (const msg of [r.ts, r.sh]) expect(msg).toContain(`must not be set in an env file (${join(realpathSync(dir), name)})`);
    }
  });

  it("`.git` present but unresolvable → refuses (fails closed, never `missing = pass`)", () => {
    const r = both(undefined, broken);
    for (const msg of [r.ts, r.sh]) expect(msg).toMatch(/^::error:: refusing the test write — cannot locate the \.prod-writes switch/);
  });
});

// End to end over COPIES of the wired scripts in the scratch checkout (no git; PROD_CONFIG_DIR = a scratch prod config
// whose .env.prod holds the stamp's three keys, plus a fake Vercel link): a refused run must stop before the Vercel CLI (a
// stub that records each call) is ever invoked. The deploy stamps its payload before the CLI, so the scratch checkout
// carries the real stamp script (+ this repo's node_modules for `npx tsx`), every run gets a fresh placeholder payload,
// and `STAMP_ENV` is the fake prod config it stamps from — written to the file, and also the runs' default env (an env
// value equal to the file's passes; the deploy reads all three from the file alone).
describe("wired prod writers", () => {
  let calls = "";
  let cfg = "";
  const STAMP_ENV = { SUPABASE_URL: "https://fakefakefakefakefake1.supabase.co", PROD_ALIAS: "fake.example", SUPABASE_ANON_KEY: "sb_publishable_fake" };
  const LINK = { projectId: "prj_fake1", orgId: "team_x", projectName: "fake-proj" };
  /** The fake config's `.env.prod`: every `STAMP_ENV` key but `omit`. */
  const envProd = (omit?: string) => Object.entries(STAMP_ENV).filter(([k]) => k !== omit).map(([k, v]) => `${k}=${v}\n`).join("");
  /** A fresh scratch config dir beside the default one: `.env.prod` text + a `.vercel/project.json` (`null` = none). */
  const cfgDir = (name: string, env: string, link: object | null) => {
    const dir = join(tmp, name);
    mkdirSync(join(dir, ".vercel"), { recursive: true });
    writeFileSync(join(dir, ".env.prod"), env);
    if (link) writeFileSync(join(dir, ".vercel", "project.json"), JSON.stringify(link));
    return dir;
  };
  beforeAll(() => {
    calls = join(tmp, "vercel-calls");
    cfg = join(tmp, "prod-config");
    mkdirSync(join(cfg, ".vercel"), { recursive: true });
    writeFileSync(join(cfg, ".env.prod"), envProd());
    writeFileSync(join(cfg, ".vercel", "project.json"), JSON.stringify(LINK));
    copyFileSync(join(SCRIPTS, "stamp-deploy-config.ts"), join(repo, "scripts", "stamp-deploy-config.ts"));
    symlinkSync(join(SCRIPTS, "..", "node_modules"), join(repo, "node_modules"), "dir");
    const stub = join(tmp, "vercel-stub");
    writeFileSync(stub, `#!/usr/bin/env bash\necho "$*" >> "${calls}"\nexit 1\n`);
    chmodSync(stub, 0o755);
  });
  /** The deploy tree (the checkout itself refuses), rebuilt per run: a stamped one would refuse its second stamp. */
  const payload = () => {
    const tree = join(tmp, "payload");
    rmSync(tree, { recursive: true, force: true });
    for (const { file } of STAMP_SET) {
      mkdirSync(dirname(join(tree, file)), { recursive: true });
      writeFileSync(join(tree, file), `https://${PLACEHOLDER.host} ${PLACEHOLDER.baseUrl} "${PLACEHOLDER.anonKey}"\n`);
    }
    return tree;
  };
  const run = (script: string, arg: string | null, file: string | null, prodWrites?: string, env: Record<string, string> = STAMP_ENV, cwd = repo) => {
    rmSync(calls, { force: true });
    setSwitch(file);
    const r = spawnSync("bash", [join(repo, "scripts", script), ...(arg ? [arg] : [])], {
      cwd,
      env: { ...baseEnv(prodWrites), PROD_CONFIG_DIR: cfg, ...env, VERCEL_BIN: join(tmp, "vercel-stub"), GIT_CEILING_DIRECTORIES: tmp },
      encoding: "utf8",
      timeout: 20_000,
    });
    return { status: r.status, err: r.stderr, cliCalled: existsSync(calls) };
  };

  it("deploy-prod-local.sh: `off` refuses before the CLI runs", () => {
    const refused = run("deploy-prod-local.sh", payload(), "off\n");
    expect(refused.err).toContain("::error:: refusing the deploy");
    expect(refused).toMatchObject({ status: 1, cliCalled: false });
  });

  // One run per test: each spawns the real stamp (`npx tsx`), ~0.5 s.
  it.each<[string, string | null, string | undefined]>([
    ["file `on`", "on\n", undefined],
    ["no file", null, undefined],
    ["env `on` over file `off`", "off\n", "on"],
  ])("deploy-prod-local.sh: %s stamps the payload and reaches the CLI", (_, file, prodWrites) => {
    const tree = payload();
    const r = run("deploy-prod-local.sh", tree, file, prodWrites);
    expect(r.err).not.toContain("stamp refused");
    expect(r.cliCalled).toBe(true);
    expect(readFileSync(join(tree, "vercel.json"), "utf8")).toBe(`https://${new URL(STAMP_ENV.SUPABASE_URL).host} https://fake.example "sb_publishable_fake"\n`);
  });

  it("deploy-prod-local.sh: a relative SRC_DIR resolves against the caller's cwd, not the checkout", () => {
    const tree = payload(); // <tmp>/payload; the checkout is <tmp>/repo, which has no `payload`
    const r = run("deploy-prod-local.sh", "payload", "on\n", undefined, STAMP_ENV, tmp);
    expect(r.cliCalled).toBe(true);
    expect(readFileSync(join(tree, "vercel.json"), "utf8")).not.toContain(PLACEHOLDER.host);
  });

  // The env wins over a file that lacks a key (the load compares only keys the file has), so an ambient stamp key would
  // stamp another project's URL / anon key / alias into public JS — the deploy reads all three from the file alone.
  it.each(Object.keys(STAMP_ENV))("deploy-prod-local.sh: a config with no %s refuses, even with one in the env, before the stamp and the CLI", (k) => {
    const dir = cfgDir(`prod-config-no-${k}`, envProd(k), LINK);
    const tree = payload();
    const r = run("deploy-prod-local.sh", tree, "on\n", undefined, { ...STAMP_ENV, PROD_CONFIG_DIR: dir });
    expect(r.err).toContain(`::error:: no target configured — ${dir}/.env.prod has no ${k} (set PROD_CONFIG_DIR)`);
    expect(r).toMatchObject({ status: 1, cliCalled: false });
    expect(readFileSync(join(tree, "vercel.json"), "utf8")).toContain(PLACEHOLDER.host);
  });

  // The same for the link: an env Vercel id the file lacks is not compared, so it would deploy under the ambient one.
  it.each([["orgId", "VERCEL_ORG_ID"], ["projectId", "VERCEL_PROJECT_ID"]])("deploy-prod-local.sh: a project.json with no %s refuses, even with %s in the env, before the stamp and the CLI", (field, k) => {
    const dir = cfgDir(`prod-config-no-${field}`, envProd(), Object.fromEntries(Object.entries(LINK).filter(([f]) => f !== field)));
    const tree = payload();
    const r = run("deploy-prod-local.sh", tree, "on\n", undefined, { ...STAMP_ENV, PROD_CONFIG_DIR: dir, [k]: "ambient_id" });
    expect(r.err.trim()).toBe(`::error:: no target configured — ${dir}/.vercel/project.json has no ${field} (set PROD_CONFIG_DIR)`);
    expect(r).toMatchObject({ status: 1, cliCalled: false });
    expect(readFileSync(join(tree, "vercel.json"), "utf8")).toContain(PLACEHOLDER.host);
  });

  // Vercel ids in the env satisfy the load without a link file; the deploy then needs the file itself.
  it("deploy-prod-local.sh: no .vercel/project.json refuses with the one line, before the stamp and the CLI", () => {
    const noLink = cfgDir("prod-config-no-link", envProd(), null);
    const r = run("deploy-prod-local.sh", payload(), "on\n", undefined, { ...STAMP_ENV, PROD_CONFIG_DIR: noLink, VERCEL_ORG_ID: "team_x", VERCEL_PROJECT_ID: "prj_fake1" });
    expect(r.err.trim()).toBe(`::error:: no target configured — ${noLink}/.vercel/project.json (set PROD_CONFIG_DIR)`);
    expect(r).toMatchObject({ status: 1, cliCalled: false });
  });

  it("deploy-prod-local.sh: no tree, or the checkout as its tree, refuses before the CLI runs", () => {
    const bare = run("deploy-prod-local.sh", null, "on\n");
    expect(bare.err).toContain("::error:: deploy-prod-local.sh needs a deploy tree");
    expect(bare).toMatchObject({ status: 1, cliCalled: false });
    const link = join(tmp, "repo-link");
    symlinkSync(repo, link, "dir");
    for (const tree of [repo, link]) {
      const inPlace = run("deploy-prod-local.sh", tree, "on\n");
      expect(inPlace.err).toContain("::error:: refusing to deploy this checkout in place");
      expect(inPlace).toMatchObject({ status: 1, cliCalled: false });
    }
  });

  it("ship.sh ship: `off` refuses before anything runs", () => {
    const r = run("ship.sh", "ship", "off\n");
    expect(r.err).toContain("::error:: refusing ship");
    expect(r.err).toContain("nothing was run");
    expect(r.status).toBe(1);
  });
});
