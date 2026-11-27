import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DOWNSIDE_DETECTORS, RS_LEGS } from "../src/registry-price.js";

// The prod re-score wrapper ship.sh's vintage-drift gate auto-runs: `npm` is a PATH stub that records its argv
// (one line per call), and PROD_CONFIG_DIR is an empty scratch dir — no prod config, no network, no write.

const SCRIPT = join(import.meta.dirname, "restate-prod.sh");
const tmp = mkdtempSync(join(tmpdir(), "restate-prod-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

function run(...args: string[]) {
  const dir = join(tmp, `run-${++n}`);
  const bin = join(dir, "bin");
  const cfg = join(dir, "cfg");
  mkdirSync(bin, { recursive: true });
  mkdirSync(cfg);
  const log = join(dir, "npm.log");
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env bash\necho "$*" >>"${log}"\n`);
  chmodSync(join(bin, "npm"), 0o755);
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: dir, PROD_CONFIG_DIR: cfg },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : [];
  return { code: r.status, calls, err: r.stderr };
}

describe("restate-prod.sh", () => {
  it("no ids → usage line, exit 2, no npm call", () => {
    for (const args of [[], ["dry"], [","]]) {
      const r = run(...args);
      expect(r.code, `args ${JSON.stringify(args)}`).toBe(2);
      expect(r.err).toMatch(/^usage: bash scripts\/restate-prod\.sh <id,…> \[dry\]/);
      expect(r.calls).toEqual([]);
    }
  });

  it("a mixed list → indicators gets the non-detector ids, dbreak the real detector ids, both --confirm-destructive", () => {
    const db = DOWNSIDE_DETECTORS[0]!.indicator.id;
    const rs = RS_LEGS[0]!.id;
    const r = run(`F9,${db},F11,${rs}`);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([
      "run backfill:raw -- indicators --restate=F9,F11 --env=prod --confirm-destructive",
      `run backfill:raw -- dbreak --restate=${db},${rs} --env=prod --confirm-destructive`,
    ]);
  });

  it("dry → --dry-run instead; a single-seam list runs only that job", () => {
    expect(run("F9,F11", "dry").calls).toEqual(["run backfill:raw -- indicators --restate=F9,F11 --env=prod --dry-run"]);
    expect(run("DB_SMH", "dry").calls).toEqual(["run backfill:raw -- dbreak --restate=DB_SMH --env=prod --dry-run"]);
  });
});
