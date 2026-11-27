/**
 * The cred seam for the reusable backfill runner.
 *
 * One `resolveStore(env)` with a precedence ladder; the Management-API pull is
 * host-only (`--env=prod` with no creds in env). All IO and the env are injected (`ResolveDeps`)
 * so the ladder + URL/key derivation unit-test with NO network, NO filesystem and NO env writes.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readEnv, type Env } from "../../src/config.js";
import { requireProdWrites } from "../../src/prod-writes.js";
import { assertStoreMode, getStore, SupabaseStore, type ReadStore, type Store, type StoreMode } from "../../src/store.js";
import { type ProdConfigEnv } from "../lib/prod-config.js";
import { prodProjectRef, projectHost } from "../supabase-project.js";

/** Injected IO so the resolver unit-tests with no network, no filesystem and no env writes. */
export interface ResolveDeps {
  fetch: typeof fetch;
  readAccessToken(): Promise<string>;
  /** The live deps re-read it on every access (a getter over `readEnv()`), so `.env.local` loaded after import still counts. */
  readonly env: Env;
  /** Path 1's store (and path 2's under "ro"), built in the run's mode from the same `env` the guards checked. */
  getStore(mode: StoreMode, env: Env): ReadStore | Store;
  /** Throws unless the checkout's prod-writes switch is on (`src/prod-writes.ts`). */
  requireProdWrites(what: string): void;
  /** Where the prod config lives (`PROD_CONFIG_DIR`): the live deps hand `process.env`. The project ref is read from that
   *  config when `env` has no `SUPABASE_PROJECT_REF` (`prodProjectRef`, scripts/supabase-project.ts). */
  readonly configEnv: ProdConfigEnv;
}

export const liveResolveDeps: ResolveDeps = {
  fetch: (...args) => globalThis.fetch(...args),
  readAccessToken: async () => (await readFile(join(homedir(), ".supabase", "access-token"), "utf8")).trim(),
  get env(): Env {
    return readEnv();
  },
  getStore: (mode, env) => getStore(mode, env),
  requireProdWrites: (what) => requireProdWrites(what, process.env),
  get configEnv(): ProdConfigEnv {
    return process.env;
  },
};

/** Derive prod {url, key, anonKey} live from the Management API (host --env=prod path).
 *  `anonKey` is the public anon key (auth `getUser`) — no store needs it; callers that
 *  only need a store destructure `{url, key}` and ignore it.
 *  `mode` is the caller's intent: anything but "ro" consults the prod-writes switch before the key pull; "ro" (the
 *  caller builds only a `getStore("ro")` handle from the creds) never does; a mode outside the union throws first. */
export async function pullProdCreds(
  deps: ResolveDeps,
  mode: StoreMode,
): Promise<{ url: string; key: string; anonKey: string }> {
  assertStoreMode(mode, "pullProdCreds");
  const ref = prodProjectRef(deps.env, deps.configEnv);
  // Before the key pull: unless "ro", these creds exist to write the project, so prod writes off stops here.
  if (mode !== "ro") deps.requireProdWrites("the prod store");
  const token = deps.env.SUPABASE_ACCESS_TOKEN || (await deps.readAccessToken());
  if (!token) throw new Error("[backfill] no Supabase access token (SUPABASE_ACCESS_TOKEN or ~/.supabase/access-token)");
  const res = await deps.fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`[backfill] Management API api-keys failed: ${res.status} ${res.statusText}`);
  const keys = (await res.json()) as Array<{ name?: string; api_key?: string }>;
  const svc = keys.find((k) => k.name === "service_role")?.api_key;
  if (!svc) throw new Error("[backfill] Management API returned no service_role key");
  const anon = keys.find((k) => k.name === "anon")?.api_key;
  if (!anon) throw new Error("[backfill] Management API returned no anon key");
  return { url: `https://${projectHost(ref)}`, key: svc, anonKey: anon };
}

/** Local-stack URL test — the cross-guard between `--env` and where the creds actually point. */
export function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(url);
}

/**
 * Resolve the Store for a run. Precedence:
 *  1. SUPABASE_URL + SUPABASE_SERVICE_KEY already in env → getStore() (local .env.local OR CI secrets),
 *     BUT only if the URL agrees with `--env` (cross-guard below).
 *  2. env === "prod", none in env → pull live (host).
 *  3. env === "local", none in env → fail loud.
 * The runner loads .env.local ONLY for --env=local (see backfill/run.ts), so a host --env=prod never hits (1)
 * with local creds.
 *
 * Cross-guard (2026-07-16): creds already exported in the SHELL silently beat .env.local —
 * `process.loadEnvFile` never overrides existing vars — so under rule 1 an `--env=local` run
 * could write prod while logging "(local)". Refuse any env/URL mismatch instead of trusting
 * the flag, and log the actual target host so the destination is always visible.
 *
 * Project guard (audit SCRIPT-9, 2026-07-20): non-local was never enough — any prod-SHAPED URL passed,
 * so creds for the WRONG Supabase project got written to under `--env=prod`. Under rule 1 the host must
 * now equal `projectHost(prodProjectRef(...))` (env `SUPABASE_PROJECT_REF`, else the prod config's ref) EXACTLY — the same string
 * `pullProdCreds` derives. It compares the HOST only, so scheme, path and query are not constrained;
 * what it guarantees is the project, not a byte-identical URL. A custom domain or pooler host is a
 * deliberate opt-out (set SUPABASE_PROJECT_REF), never a silent pass.
 *
 * Mode: "ro" returns a `ReadStore` (no write method) and never consults the prod-writes switch; anything else is a
 * write and consults it on both prod paths here, and the live `getStore("rw")` consults it again for any target,
 * local included. A mode outside the union (a stale `resolveStore(env, deps)` caller) throws before any IO.
 */
export function resolveStore(env: "local" | "prod", mode: "ro", deps?: ResolveDeps): Promise<ReadStore>;
export function resolveStore(env: "local" | "prod", mode: "rw", deps?: ResolveDeps): Promise<Store>;
export async function resolveStore(
  env: "local" | "prod",
  mode: StoreMode,
  deps: ResolveDeps = liveResolveDeps,
): Promise<ReadStore | Store> {
  assertStoreMode(mode, "resolveStore");
  const creds = deps.env;
  const envUrl = creds.SUPABASE_URL;
  if (envUrl && creds.SUPABASE_SERVICE_KEY) {
    // Host for messages only — a malformed URL must not mask the guard with a URL TypeError.
    let host: string;
    try {
      host = new URL(envUrl).host;
    } catch {
      host = envUrl;
    }
    if (env === "local" && !isLocalUrl(envUrl)) {
      throw new Error(
        `[backfill] --env=local but SUPABASE_URL in the environment points at ${host} — unset SUPABASE_URL/SUPABASE_SERVICE_KEY in the shell (or pass --env=prod deliberately)`,
      );
    }
    if (env === "prod" && isLocalUrl(envUrl)) {
      throw new Error(
        `[backfill] --env=prod but SUPABASE_URL in the environment points at ${host} — unset the local creds so prod creds are pulled via the Management API`,
      );
    }
    if (env === "prod") {
      const ref = prodProjectRef(creds, deps.configEnv);
      const expected = projectHost(ref);
      if (host !== expected) {
        throw new Error(
          `[backfill] --env=prod but SUPABASE_URL in the environment points at ${host}, not the expected project ${expected} — refusing to write to a different Supabase project (set SUPABASE_PROJECT_REF if this is deliberate)`,
        );
      }
      if (mode !== "ro") deps.requireProdWrites("the prod store");
    }
    console.log(`[backfill] target: ${host} (${env})`);
    return deps.getStore(mode, creds);
  }
  if (env === "prod") {
    const { url, key } = await pullProdCreds(deps, mode);
    console.log(`[backfill] target: ${new URL(url).host} (prod)`);
    return mode === "ro" ? deps.getStore("ro", { SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key }) : new SupabaseStore(url, key);
  }
  throw new Error(
    "[backfill] No SUPABASE_URL/SUPABASE_SERVICE_KEY for --env=local. The dev stack defaults DOWN — `npm run backfill` wraps itself in `scripts/db.sh with dev` and brings it up for you; you are seeing this from `backfill:raw` or a bare tsx run. Use `npm run backfill`, or hold the stack open with `scripts/db.sh up dev`, and populate .env.local. Or use --env=prod.",
  );
}
