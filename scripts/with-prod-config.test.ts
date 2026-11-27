import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// The npm-script wrapper over the checkout's prod config: runs over scratch config dirs holding fake files only.

const WRAPPER = join(import.meta.dirname, "with-prod-config.sh");
const tmp = mkdtempSync(join(tmpdir(), "with-prod-config-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/** A fresh scratch config dir: `env` → `.env.prod`, `project` → `.vercel/project.json`. */
function cfg(files: { env?: string; project?: object } = {}): string {
  const dir = join(tmp, `cfg-${++n}`);
  mkdirSync(dir);
  if (files.env !== undefined) writeFileSync(join(dir, ".env.prod"), files.env);
  if (files.project !== undefined) {
    mkdirSync(join(dir, ".vercel"));
    writeFileSync(join(dir, ".vercel", "project.json"), JSON.stringify(files.project));
  }
  return dir;
}

/** Runs the wrapper with a bare env (no inherited config) plus `env`; the command prints the named keys. */
function wrap(dir: string, flags: readonly string[], cmd: readonly string[], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [WRAPPER, ...flags, ...cmd], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: tmp, PROD_CONFIG_DIR: dir, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr.trim() };
}

const show = (...keys: string[]): string[] => ["bash", "-c", keys.map((k) => `echo "${k}=\${${k}:-<unset>}"`).join("; ")];
const FILE = "FAKE_A=alpha\nFAKE_B='two words'\n";
const LINK = { orgId: "team_fake", projectId: "prj_fake" };

describe("with-prod-config.sh", () => {
  it("loads the config dir's .env.prod + Vercel ids into the command's env and execs it (exit status is the command's)", () => {
    const dir = cfg({ env: FILE, project: LINK });
    expect(wrap(dir, [], show("FAKE_A", "FAKE_B", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"))).toEqual({
      code: 0,
      out: "FAKE_A=alpha\nFAKE_B=two words\nVERCEL_ORG_ID=team_fake\nVERCEL_PROJECT_ID=prj_fake\n",
      err: "",
    });
    expect(wrap(dir, [], ["bash", "-c", 'printf "%s|" "$@"; exit 7', "x", "a b", "--optional"])).toEqual({ code: 7, out: "a b|--optional|", err: "" });
  });

  it("refuses with an empty config dir — the one ::error:: line, exit 1, the command never runs", () => {
    const dir = cfg();
    const marker = join(tmp, `ran-${n}`);
    expect(wrap(dir, [], ["touch", marker])).toEqual({
      code: 1,
      out: "",
      err: `::error:: no target configured — ${dir}/.env.prod (set PROD_CONFIG_DIR)`,
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("--optional passes with an empty config dir and runs the command on the plain env", () => {
    expect(wrap(cfg(), ["--optional"], show("FAKE_A"))).toEqual({ code: 0, out: "FAKE_A=<unset>\n", err: "" });
    expect(wrap(cfg({ env: FILE }), ["--optional"], show("FAKE_A")).out).toBe("FAKE_A=alpha\n");
  });

  it("the default requires .env.prod but not the Vercel link (no npm script needs it)", () => {
    expect(wrap(cfg({ env: FILE }), [], show("FAKE_A", "VERCEL_PROJECT_ID"))).toEqual({
      code: 0,
      out: "FAKE_A=alpha\nVERCEL_PROJECT_ID=<unset>\n",
      err: "",
    });
  });

  it("--only reaches the helper (both spellings): just the named keys load, an unset one refuses", () => {
    const dir = cfg({ env: FILE });
    expect(wrap(dir, ["--only", "FAKE_A"], show("FAKE_A", "FAKE_B")).out).toBe("FAKE_A=alpha\nFAKE_B=<unset>\n");
    expect(wrap(dir, ["--only=FAKE_A,FAKE_C"], ["true"])).toEqual({
      code: 1,
      out: "",
      err: `::error:: no target configured — ${dir}/.env.prod has no FAKE_C (set PROD_CONFIG_DIR)`,
    });
  });

  it("a relative knob, an unknown option or no command refuses", () => {
    expect(wrap("rel/dir", ["--optional"], ["true"])).toMatchObject({ code: 1, err: "::error:: PROD_CONFIG_DIR must be an absolute path — got 'rel/dir'" });
    expect(wrap(cfg({ env: FILE }), ["--bogus"], ["true"])).toMatchObject({ code: 1, err: expect.stringMatching(/unknown option '--bogus'/) });
    expect(wrap(cfg({ env: FILE }), [], [])).toMatchObject({ code: 1, err: expect.stringMatching(/no command/) });
  });
});
