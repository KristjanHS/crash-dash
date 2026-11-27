import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Env } from "../../src/config.js";
import { pushNtfy } from "../../src/ntfy.js";
import { prodBaseUrl, withConfigAlias } from "./prod-base-url.js";

let dir = "";
const cfg = (name: string, envProd: string | undefined): string => {
  const d = join(dir, name);
  mkdirSync(d);
  if (envProd !== undefined) writeFileSync(join(d, ".env.prod"), envProd);
  return d;
};
beforeAll(() => (dir = mkdtempSync(join(tmpdir(), "prod-base-url-"))));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("prodBaseUrl", () => {
  it("env PROD_ALIAS wins, never compared against the config file", () => {
    const d = cfg("env-wins", "PROD_ALIAS=file-alias.invalid\n");
    expect(prodBaseUrl({ PROD_ALIAS: "env-alias.invalid", PROD_CONFIG_DIR: d })).toBe("https://env-alias.invalid");
  });
  it("no env alias → the config file's, normalized", () => {
    const d = cfg("from-file", "PROD_ALIAS=https://file-alias.invalid/\n");
    expect(prodBaseUrl({ PROD_ALIAS: "  ", PROD_CONFIG_DIR: d })).toBe("https://file-alias.invalid");
  });
  it("the env passed in is never written", () => {
    const env = { PROD_CONFIG_DIR: cfg("no-write", "PROD_ALIAS=file-alias.invalid\nOTHER=x\n") };
    prodBaseUrl(env);
    expect(env).toEqual({ PROD_CONFIG_DIR: env.PROD_CONFIG_DIR });
  });
  it("no file, or a file without PROD_ALIAS → refuses (no built-in default)", () => {
    expect(() => prodBaseUrl({ PROD_CONFIG_DIR: cfg("no-file", undefined) })).toThrow(/::error:: no target configured/);
    expect(() => prodBaseUrl({ PROD_CONFIG_DIR: cfg("no-key", "OTHER=x\n") })).toThrow(/PROD_ALIAS/);
  });
});

// The ladder / sim:notify push env: a host run's env has no PROD_ALIAS, so the tap link comes from the prod config.
describe("withConfigAlias — the push's tap link", () => {
  /** Push through the real `pushNtfy` with a recording fetch; returns the request headers (it must have sent). */
  async function pushedHeaders(env: Env): Promise<Record<string, string>> {
    const calls: RequestInit[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => (calls.push(init ?? {}), new Response("ok"));
    await pushNtfy({ title: "t", body: "b" }, { fetchImpl, env, sleep: async () => {} });
    expect(calls).toHaveLength(1);
    return calls[0]!.headers as Record<string, string>;
  }
  it("config file with PROD_ALIAS + an env without one ⇒ the push carries Click: https://<alias>", async () => {
    const env: Env = { NTFY_TOPIC: "test-topic" };
    const headers = await pushedHeaders(withConfigAlias(env, { PROD_CONFIG_DIR: cfg("push-alias", "PROD_ALIAS=file-alias.invalid\n") }));
    expect(headers.Click).toBe("https://file-alias.invalid");
    expect(env).toEqual({ NTFY_TOPIC: "test-topic" }); // the fill lives only in the returned object
  });
  it("no config ⇒ the push still sends, with no Click, and nothing is warned", async () => {
    const warned: string[] = [];
    const env = withConfigAlias({ NTFY_TOPIC: "test-topic" }, { PROD_CONFIG_DIR: cfg("push-none", undefined) }, (l) => warned.push(l));
    expect(await pushedHeaders(env)).not.toHaveProperty("Click");
    expect(warned).toEqual([]);
  });
  it("a config that exists but refuses (malformed alias) ⇒ no Click, and the refusal is warned", async () => {
    const warned: string[] = [];
    const dir = cfg("push-bad", "PROD_ALIAS=http://file-alias.invalid\n");
    const env = withConfigAlias({ NTFY_TOPIC: "test-topic" }, { PROD_CONFIG_DIR: dir }, (l) => warned.push(l));
    expect(await pushedHeaders(env)).not.toHaveProperty("Click");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/^push link dropped — .*PROD_ALIAS/);
  });
  it("a non-blank env PROD_ALIAS is kept as given (the file is not read)", () => {
    const env: Env = { NTFY_TOPIC: "test-topic", PROD_ALIAS: "env-alias.invalid" };
    expect(withConfigAlias(env, { PROD_CONFIG_DIR: cfg("push-env", "PROD_ALIAS=file-alias.invalid\n") })).toBe(env);
  });
});
