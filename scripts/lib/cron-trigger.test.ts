import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { triggerCron } from "./cron-trigger.js";

// The cron trigger is a prod WRITE: both twins consult the prod-writes switch before any network call, and no
// script sends the CRON_SECRET bearer to the cron route except through them. Switch parsing itself is pinned in
// src/prod-writes.test.ts; here the env override (which wins over the file) drives each case.

const SCRIPTS = join(import.meta.dirname, "..");
const ROOT = join(SCRIPTS, "..");
let tmp = "";
beforeAll(() => (tmp = mkdtempSync(join(tmpdir(), "cron-trigger-"))));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("triggerCron", () => {
  const counting = () => {
    const calls: { url: string; auth: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") ?? "" });
      return new Response("{}");
    }) as typeof fetch;
    return { calls, fetchImpl };
  };

  it("prod writes off: refuses before any fetch", async () => {
    const { calls, fetchImpl } = counting();
    await expect(triggerCron("https://x.example/", "?email=force", "s3cret", { PROD_WRITES: "off" }, { fetchImpl })).rejects.toThrow(
      /refusing the cron trigger/,
    );
    expect(calls).toHaveLength(0);
  });

  it("prod writes on: one GET on <base>/api/cron/run<query> with the bearer", async () => {
    const { calls, fetchImpl } = counting();
    await triggerCron("https://x.example/", "?email=force", "s3cret", { PROD_WRITES: "on" }, { fetchImpl });
    expect(calls).toEqual([{ url: "https://x.example/api/cron/run?email=force", auth: "Bearer s3cret" }]);
  });
});

describe("cron_trigger (bash)", () => {
  const run = (prodWrites: string) => {
    const log = join(tmp, "curl-calls");
    rmSync(log, { force: true });
    const bin = join(tmp, "bin");
    spawnSync("mkdir", ["-p", bin]);
    writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash\n{ echo "$*"; cat; } >> "${log}"\n`);
    chmodSync(join(bin, "curl"), 0o755);
    const r = spawnSync("bash", ["-c", `. "${join(SCRIPTS, "lib", "cron-trigger.sh")}"; cron_trigger https://x.example/ '?rederive=0' s3cret -sS`], {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: tmp, PROD_WRITES: prodWrites },
      encoding: "utf8",
    });
    return { status: r.status, err: r.stderr, curl: existsSync(log) ? readFileSync(log, "utf8") : null };
  };

  it("prod writes off: returns 1 with one ::error::, curl never runs", () => {
    const r = run("off");
    expect(r).toMatchObject({ status: 1, curl: null });
    expect(r.err).toMatch(/^::error:: refusing the cron trigger/);
  });

  it("prod writes on: curl gets the route + passthrough args on argv, the bearer only on stdin", () => {
    const r = run("on");
    expect(r.status).toBe(0);
    expect(r.curl).toBe("-H @- -sS https://x.example/api/cron/run?rederive=0\nauthorization: Bearer s3cret\n");
  });
});

it("probe:email-send refuses before any fetch when prod writes are off", () => {
  const r = spawnSync(join(ROOT, "node_modules", ".bin", "tsx"), [join(SCRIPTS, "probe-email-send.ts"), "--base=http://127.0.0.1:9"], {
    env: { PATH: process.env.PATH ?? "", HOME: tmp, CRON_SECRET: "s3cret", PROD_WRITES: "off" },
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/refusing the cron trigger/);
  expect(r.stdout).not.toContain("HTTP"); // no response line: the fetch never ran
});

// The cron secret travels as a bearer: a logical line (backslash continuations joined) that puts `Bearer` next to
// a `*secret*` value is a CRON_SECRET send, and only the twins may make one. Other bearers (service keys, access
// tokens) never name a secret. Comment lines are skipped; archived scripts and tests are out of scope.
describe("no stray CRON_SECRET trigger", () => {
  /** Files allowed a secret bearer: the twins, plus readers whose bearer goes to another route. */
  const ALLOWED: Record<string, string> = {
    "lib/cron-trigger.sh": "the bash twin",
    "lib/cron-trigger.ts": "the TS twin",
    "probe-prod-full.ts": "the bearer goes to /api/health (a read), never the cron route",
  };
  const logicalCode = (text: string) =>
    text
      .replace(/\\\n/g, " ")
      .split("\n")
      .filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l));

  it("only the allowed files send a secret bearer", () => {
    // Walks the disk, not `git ls-files`: `make ship` tests a `git archive` tree with no `.git`. Regular files only;
    // dot-dirs (backtest/.venv), node_modules and archive/ are never entered — same shape as check-rule-cites' repoFiles.
    const files: string[] = [];
    const walk = (rel: string): void => {
      for (const e of readdirSync(join(SCRIPTS, rel), { withFileTypes: true })) {
        if (e.name.startsWith(".") || e.name === "node_modules" || (rel === "" && e.name === "archive")) continue;
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && /\.(sh|ts)$/.test(e.name) && !e.name.endsWith(".test.ts")) files.push(p);
      }
    };
    walk("");
    expect(files).toContain("lib/cron-trigger.sh"); // the walker reaches the twins it must report
    const offenders = files.filter((f) =>
      logicalCode(readFileSync(join(SCRIPTS, f), "utf8")).some((l) => /bearer/i.test(l) && /secret/i.test(l)),
    );
    expect(offenders.sort()).toEqual(Object.keys(ALLOWED).sort());
  });
});
