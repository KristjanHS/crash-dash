/**
 * Pure unit tests for the cred seam (design §5/§9, plan Phase 1). Injected
 * `fetch` + token-reader + env + `getStore` → NO network, NO real Management-API call, and no `process.env` write.
 * The only filesystem touch is the prod config dir: by default an absent one (so the ref must come from the env),
 * and one temp dir holding a `.env.prod` for the config-ref cases.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { InMemoryStore } from "../../src/store-memory.js";
import { requireProdWrites } from "../../src/prod-writes.js";
import { SupabaseStore } from "../../src/store.js";
import { type ResolveDeps, liveResolveDeps, pullProdCreds, resolveStore } from "./resolve-store.js";

/** What the fake `getStore` hands back — path 1's store, told apart from a pulled `SupabaseStore`. */
const ENV_STORE = new InMemoryStore();
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "resolve-store-cfg-"));
writeFileSync(join(CONFIG_DIR, ".env.prod"), "SUPABASE_URL=https://fileref.supabase.co\n");
afterAll(() => rmSync(CONFIG_DIR, { recursive: true, force: true }));
/** A prod config dir that does not exist: a ref-less env must refuse, never read this checkout's real config. */
const NO_CONFIG = { PROD_CONFIG_DIR: join(CONFIG_DIR, "absent") };
const deps = (env: Record<string, string>, fetch: ResolveDeps["fetch"], over: Partial<ResolveDeps> = {}): ResolveDeps => ({
  fetch,
  readAccessToken: async () => "tok",
  env,
  getStore: () => ENV_STORE,
  requireProdWrites: () => {},
  configEnv: NO_CONFIG,
  ...over,
});

/** A fake fetch returning an api-keys payload (or an error response). */
function fakeFetch(
  payload: unknown,
  init: { ok?: boolean; status?: number; statusText?: string } = {},
): { fetch: ResolveDeps["fetch"]; calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (url: string | URL | Request, opts?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (opts?.headers ?? {}) as Record<string, string>,
    });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: init.statusText ?? "OK",
      json: async () => payload,
    };
  }) as unknown as ResolveDeps["fetch"];
  return { fetch, calls };
}

const SERVICE_KEY = "eyJ-service-role-jwt";
const KEYS_PAYLOAD = [
  { name: "anon", api_key: "eyJ-anon" },
  { name: "service_role", api_key: SERVICE_KEY },
  { name: "sb_secret_x", api_key: "sb_secret_x" },
];

describe("resolveStore / pullProdCreds", () => {
  it("the live deps re-read the env per access and build a store in the mode they are handed", () => {
    // A getter, not a snapshot: a value captured at import would miss `.env.local` loaded after it.
    expect(typeof Object.getOwnPropertyDescriptor(liveResolveDeps, "env")?.get).toBe("function");
    // Both modes need only URL + service key; "rw" returns the full SupabaseStore (PROD_WRITES named, so a local
    // `.prod-writes` file cannot sway it), "ro" a read handle with no write method.
    const creds = { SUPABASE_URL: "http://localhost:54321", SUPABASE_SERVICE_KEY: "k" };
    expect(liveResolveDeps.getStore("rw", { ...creds, PROD_WRITES: "on" })).toBeInstanceOf(SupabaseStore);
    const ro = liveResolveDeps.getStore("ro", { ...creds, PROD_WRITES: "off" });
    expect(ro).not.toBeInstanceOf(SupabaseStore);
    expect("recordRun" in ro).toBe(false);
  });

  it("env creds present + env=local → getStore() store, no pull", async () => {
    const env = { SUPABASE_URL: "http://localhost:54321", SUPABASE_SERVICE_KEY: "local-key" };
    const { fetch, calls } = fakeFetch(KEYS_PAYLOAD);
    const handed: unknown[] = [];
    const store = await resolveStore("local", "rw", deps(env, fetch, { getStore: (m, e) => (handed.push([m, e]), ENV_STORE) }));
    expect(store).toBe(ENV_STORE);
    expect(handed).toEqual([["rw", env]]); // path 1 builds from the env its guards checked, in the run's mode
    expect(calls).toHaveLength(0); // path 1 — never pulls
  });

  it("env creds present + env=prod → still path 1 (no pull) when the URL is the expected project", async () => {
    // The ref must agree with the URL: since SCRIPT-9 the prod branch rejects any other project's host.
    const env = { SUPABASE_PROJECT_REF: "myref", SUPABASE_URL: "https://myref.supabase.co", SUPABASE_SERVICE_KEY: "prod-key" };
    const { fetch, calls } = fakeFetch(KEYS_PAYLOAD);
    await resolveStore("prod", "rw", deps(env, fetch));
    expect(calls).toHaveLength(0);
  });

  it("project guard: prod-shaped url for the WRONG project + --env=prod → throws (SCRIPT-9)", async () => {
    const env = { SUPABASE_PROJECT_REF: "myref", SUPABASE_URL: "https://someoneelse.supabase.co", SUPABASE_SERVICE_KEY: "prod-key" };
    const { fetch } = fakeFetch(KEYS_PAYLOAD);
    await expect(resolveStore("prod", "rw", deps(env, fetch))).rejects.toThrow(
      /points at someoneelse\.supabase\.co, not the expected project myref\.supabase\.co/,
    );
  });

  it("project guard: no SUPABASE_PROJECT_REF → the prod config's ref is what the env URL must match", async () => {
    const cfg = { configEnv: { PROD_CONFIG_DIR: CONFIG_DIR } };
    const { fetch, calls } = fakeFetch(KEYS_PAYLOAD);
    const env = (ref: string) => ({ SUPABASE_URL: `https://${ref}.supabase.co`, SUPABASE_SERVICE_KEY: "prod-key" });
    await resolveStore("prod", "rw", deps(env("fileref"), fetch, cfg));
    // The env URL itself never supplies the expected ref — a different project still refuses.
    await expect(resolveStore("prod", "rw", deps(env("someoneelse"), fetch, cfg))).rejects.toThrow(
      /not the expected project fileref\.supabase\.co/,
    );
    expect(calls).toHaveLength(0);
  });

  it("no SUPABASE_PROJECT_REF and no prod config → refuses before any pull (no default project)", async () => {
    const { fetch, calls } = fakeFetch(KEYS_PAYLOAD);
    await expect(pullProdCreds(deps({}, fetch), "ro")).rejects.toThrow(/no target configured/);
    await expect(resolveStore("prod", "ro", deps({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_KEY: "k" }, fetch))).rejects.toThrow(
      /no target configured/,
    );
    expect(calls).toHaveLength(0);
  });

  it("cross-guard: PROD url in env + --env=local → throws (the '(local)' wrote-prod footgun)", async () => {
    const env = { SUPABASE_URL: "https://myref.supabase.co", SUPABASE_SERVICE_KEY: "prod-key" };
    const { fetch } = fakeFetch(KEYS_PAYLOAD);
    await expect(resolveStore("local", "rw", deps(env, fetch))).rejects.toThrow(
      /points at myref\.supabase\.co/,
    );
  });

  it("cross-guard: local url in env + --env=prod → throws", async () => {
    const env = { SUPABASE_URL: "http://localhost:54321", SUPABASE_SERVICE_KEY: "local-key" };
    const { fetch } = fakeFetch(KEYS_PAYLOAD);
    await expect(resolveStore("prod", "rw", deps(env, fetch))).rejects.toThrow(
      /points at localhost:54321/,
    );
  });

  it("no env creds + env=local → throws actionable message", async () => {
    const { fetch } = fakeFetch(KEYS_PAYLOAD);
    await expect(resolveStore("local", "rw", deps({}, fetch))).rejects.toThrow(
      /--env=local/,
    );
  });

  it("no env creds + env=prod → pulls and returns a SupabaseStore", async () => {
    const env = { SUPABASE_PROJECT_REF: "myref" };
    const { fetch, calls } = fakeFetch(KEYS_PAYLOAD);
    const store = await resolveStore("prod", "rw", deps(env, fetch));
    expect(store).toBeInstanceOf(SupabaseStore);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/v1/projects/myref/api-keys");
  });

  it("pullProdCreds derives url from ref + selects the service_role key", async () => {
    const env = { SUPABASE_PROJECT_REF: "myref" };
    const { fetch } = fakeFetch(KEYS_PAYLOAD);
    const { url, key } = await pullProdCreds(deps(env, fetch), "rw");
    expect(url).toBe("https://myref.supabase.co");
    expect(key).toBe(SERVICE_KEY);
  });

  it("pullProdCreds: SUPABASE_ACCESS_TOKEN env wins over readAccessToken()", async () => {
    const env = { SUPABASE_PROJECT_REF: "myref", SUPABASE_ACCESS_TOKEN: "env-token" };
    const { fetch, calls } = fakeFetch(KEYS_PAYLOAD);
    const readAccessToken = vi.fn(async () => "file-token");
    await pullProdCreds(deps(env, fetch, { readAccessToken }), "rw");
    expect(readAccessToken).not.toHaveBeenCalled();
    expect(calls[0]!.headers.Authorization).toBe("Bearer env-token");
  });

  it("pullProdCreds: falls back to readAccessToken() when no env token", async () => {
    const { fetch, calls } = fakeFetch(KEYS_PAYLOAD);
    const readAccessToken = vi.fn(async () => "file-token");
    await pullProdCreds(deps({ SUPABASE_PROJECT_REF: "myref" }, fetch, { readAccessToken }), "rw");
    expect(readAccessToken).toHaveBeenCalledOnce();
    expect(calls[0]!.headers.Authorization).toBe("Bearer file-token");
  });

  it("pullProdCreds: non-ok response throws with status", async () => {
    const { fetch } = fakeFetch([], { ok: false, status: 403, statusText: "Forbidden" });
    await expect(pullProdCreds(deps({ SUPABASE_PROJECT_REF: "myref" }, fetch), "rw")).rejects.toThrow(/403 Forbidden/);
  });

  it("pullProdCreds: response missing service_role throws", async () => {
    const { fetch } = fakeFetch([{ name: "anon", api_key: "eyJ-anon" }]);
    await expect(pullProdCreds(deps({ SUPABASE_PROJECT_REF: "myref" }, fetch), "rw")).rejects.toThrow(
      /no service_role key/,
    );
  });

  // The service_role guard runs FIRST, so this payload must carry service_role and OMIT anon — a
  // fixture with both (or with neither) can never reach the anon `find`.
  it("pullProdCreds: response missing anon throws — the anon key is part of its contract", async () => {
    const { fetch } = fakeFetch([{ name: "service_role", api_key: "eyJ-service" }]);
    await expect(pullProdCreds(deps({ SUPABASE_PROJECT_REF: "myref" }, fetch), "rw")).rejects.toThrow(
      /no anon key/,
    );
  });

  // The live seam is `requireProdWrites` (its file/parse/override rules are pinned in src/prod-writes.test.ts);
  // here only the WIRING: each --env=prod path consults it, and it fires before any IO.
  it("prod writes off: --env=prod refuses before the key pull, and before building the store from env creds", async () => {
    const off: Partial<ResolveDeps> = { requireProdWrites: (what) => requireProdWrites(what, { PROD_WRITES: "off" }) };
    const { fetch, calls } = fakeFetch(KEYS_PAYLOAD);
    await expect(resolveStore("prod", "rw", deps({ SUPABASE_PROJECT_REF: "myref" }, fetch, off))).rejects.toThrow(
      /refusing the prod store — prod writes are not on.*PROD_WRITES=on/,
    );
    expect(calls).toHaveLength(0);
    const built: unknown[] = [];
    const env = { SUPABASE_PROJECT_REF: "myref", SUPABASE_URL: "https://myref.supabase.co", SUPABASE_SERVICE_KEY: "prod-key" };
    await expect(
      resolveStore("prod", "rw", deps(env, fetch, { ...off, getStore: (_m, e) => (built.push(e), ENV_STORE) })),
    ).rejects.toThrow(/refusing the prod store/);
    expect(built).toHaveLength(0);
    await expect(pullProdCreds(deps({ SUPABASE_PROJECT_REF: "myref" }, fetch, off), "rw")).rejects.toThrow(/refusing the prod store/);
    expect(calls).toHaveLength(0);
  });

  // tsx never typechecks: archived scripts still call `resolveStore("prod", liveResolveDeps)`, landing the deps in the
  // mode slot. That must fail closed before ANY dep is touched — no env read, switch, token, fetch or store build.
  it("a mode outside the union throws before any IO (resolveStore and pullProdCreds)", async () => {
    const touched: string[] = [];
    const counting: ResolveDeps = {
      fetch: (async () => (touched.push("fetch"), new Response("[]"))) as ResolveDeps["fetch"],
      readAccessToken: async () => (touched.push("token"), "tok"),
      get env() {
        touched.push("env");
        return {};
      },
      getStore: () => (touched.push("getStore"), ENV_STORE),
      requireProdWrites: () => void touched.push("switch"),
      configEnv: NO_CONFIG,
    };
    await expect(resolveStore("prod", counting as never, counting)).rejects.toThrow(/resolveStore: mode must be "ro" or "rw"/);
    await expect(resolveStore("local", "write" as never, counting)).rejects.toThrow(/mode must be "ro" or "rw"/);
    await expect(pullProdCreds(counting, "write" as never)).rejects.toThrow(/pullProdCreds: mode must be "ro" or "rw"/);
    expect(touched).toEqual([]);
  });

  // A read probe states "ro": the switch is never consulted, so prod writes off still pulls and builds.
  it("prod writes off: --env=prod \"ro\" still pulls the creds and builds a read store, on both paths", async () => {
    const consulted: string[] = [];
    const off: Partial<ResolveDeps> = {
      requireProdWrites: (what) => (consulted.push(what), requireProdWrites(what, { PROD_WRITES: "off" })),
    };
    const { fetch, calls } = fakeFetch(KEYS_PAYLOAD);
    const built: unknown[] = [];
    const getStore: ResolveDeps["getStore"] = (m, e) => (built.push([m, e]), ENV_STORE);
    // Path 2 (no creds in env): the key pull runs, and the pulled creds build a "ro" store through deps.getStore.
    expect(await resolveStore("prod", "ro", deps({ SUPABASE_PROJECT_REF: "myref" }, fetch, { ...off, getStore }))).toBe(ENV_STORE);
    expect(calls).toHaveLength(1);
    expect(built).toEqual([["ro", { SUPABASE_URL: "https://myref.supabase.co", SUPABASE_SERVICE_KEY: SERVICE_KEY }]]);
    // Path 1 (creds in env): built in "ro" from the env the guards checked.
    const env = { SUPABASE_PROJECT_REF: "myref", SUPABASE_URL: "https://myref.supabase.co", SUPABASE_SERVICE_KEY: "prod-key" };
    expect(await resolveStore("prod", "ro", deps(env, fetch, { ...off, getStore }))).toBe(ENV_STORE);
    expect(built.at(-1)).toEqual(["ro", env]);
    // pullProdCreds "ro" pulls too.
    expect((await pullProdCreds(deps({ SUPABASE_PROJECT_REF: "myref" }, fetch, off), "ro")).key).toBe(SERVICE_KEY);
    expect(calls).toHaveLength(2);
    expect(consulted).toEqual([]);
  });
});
