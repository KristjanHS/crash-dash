/**
 * The checkout's prod config — the directory holding `.env.prod` (the deploy target's keys) and `.vercel/project.json`
 * (its Vercel link). Every prod-touching script resolves it here, so one knob moves it.
 *
 *   `PROD_CONFIG_DIR` (absolute; a relative value refuses; empty = unset) → that directory
 *   unset → the MAIN worktree root of this checkout, resolved exactly like the prod-writes switch
 *           (`mainWorktreeRoot`, src/prod-writes.ts), so linked worktrees and trees with no git metadata inherit it
 *
 * Anything missing → throws ONE `::error:: no target configured — <dir>/.env.prod (set PROD_CONFIG_DIR)` line. Never a
 * fallback (not cwd, not another file).
 *
 *   `prodConfigDir(env)`     the directory
 *   `loadProdConfig(env, o)` assigns into `env` the keys `<dir>/.env.prod` sets (node's own dotenv parser), plus
 *                            `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` from `<dir>/.vercel/project.json` (orgId / projectId).
 *                            Values are read literally (a `$` or a backtick stays as written), identifier keys only.
 *                            A key already set non-empty in `env` WINS (`--env-file` / `process.loadEnvFile` semantics) —
 *                            except the identity keys `SUPABASE_URL`, `SUPABASE_PROJECT_REF`, `PROD_ALIAS`,
 *                            `SUPABASE_ANON_KEY` (vs `.env.prod`) and `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` (vs
 *                            project.json): an `env` value its file contradicts refuses (one `::error::` line, nothing
 *                            loaded; `optional` does not waive it; a key the file lacks is not compared).
 *                            `PROD_WRITES` and `PROD_CONFIG_DIR` are never taken from the file. `only` loads just the
 *                            named keys and refuses when one stays unset; `optional` turns every refusal about a
 *                            missing file or key into a quiet pass (a relative knob, an unreadable `.env.prod` — a
 *                            dangling symlink too — and an unparsable project.json still refuse).
 *   `prodConfigRef(env)`     the Supabase project ref: `SUPABASE_PROJECT_REF`, else `<ref>` of `SUPABASE_URL`'s host
 *                            `<ref>.supabase.co`; both set and disagreeing → refuse
 *   `prodConfigBaseUrl(env)` `https://<PROD_ALIAS>`: a bare host or an https URL, no trailing slash
 * The resolvers read `env` only — load first.
 *
 * Bash twin: `scripts/lib/prod-config.sh` — same resolution, same rules; change both together
 * (`scripts/lib/prod-config.test.ts` runs both over one table).
 */
import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { mainWorktreeRoot } from "../../src/prod-writes.js";

/** The env the helper reads (and the loader writes) — a required param: entries pass `process.env`, tests pass literals. */
export type ProdConfigEnv = Record<string, string | undefined>;

/** This module's checkout (`<checkout>/scripts/lib/../..`). */
const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** ASCII whitespace only — the bash twin trims the same set under `LC_ALL=C`. */
export const trimAscii = (s: string): string => s.replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, "");

/** Keys a config file may never set: the prod-writes override, and the knob that located the file. */
const NEVER_FROM_FILE = new Set(["PROD_WRITES", "PROD_CONFIG_DIR"]);

/** `.env.prod` keys naming the target itself: an `env` value the file contradicts refuses instead of winning.
 * `SUPABASE_ANON_KEY` among them: the deploy stamps it into public JS, so an env key the file contradicts refuses.
 * A key the file lacks is not compared here — an env value then wins; the deploy re-reads its stamp keys with the
 * env's unset (scripts/deploy-prod-local.sh), so a config lacking one refuses there. */
const IDENTITY_KEYS = new Set(["SUPABASE_URL", "SUPABASE_PROJECT_REF", "PROD_ALIAS", "SUPABASE_ANON_KEY"]);

/** The bash twin's export rule: only identifier-shaped keys (node's parser also yields `A.B` / `A-B`). */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const VERCEL_IDS = [
  ["VERCEL_ORG_ID", "orgId"],
  ["VERCEL_PROJECT_ID", "projectId"],
] as const;

const missing = (what: string): Error => new Error(`::error:: no target configured — ${what} (set PROD_CONFIG_DIR)`);

/** The prod config directory (rule in the header). `checkout` is a test seam; entries leave it defaulted. */
export function prodConfigDir(env: ProdConfigEnv, checkout: string = CHECKOUT): string {
  const d = env.PROD_CONFIG_DIR ?? "";
  if (d !== "") {
    if (!d.startsWith("/")) throw new Error(`::error:: PROD_CONFIG_DIR must be an absolute path — got '${d}'`);
    return d.replace(/(?<=.)\/+$/, "");
  }
  try {
    return mainWorktreeRoot(checkout);
  } catch {
    throw missing(`cannot locate the main worktree root of ${checkout}`);
  }
}

/** A file's text; `undefined` when nothing is at `path`. Something there that cannot be read — a directory, no
 * permission, a dangling symlink (ENOENT on read, yet `lstat` finds it) — refuses, `optional` or not. */
function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        lstatSync(path);
      } catch {
        return undefined;
      }
    }
    throw new Error(`::error:: cannot read ${path}`);
  }
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

export interface LoadProdConfigOpts {
  /** A missing file or key is a quiet pass, not a refusal. */
  readonly optional?: boolean;
  /** Load just these keys (a Vercel id among them or not); each must end up set unless `optional`. */
  readonly only?: readonly string[];
}

/**
 * Load the prod config into `env` (rule in the header) and return the keys it assigned. `checkout` is a test seam.
 */
export function loadProdConfig(
  env: ProdConfigEnv,
  opts: LoadProdConfigOpts = {},
  checkout: string = CHECKOUT,
): Record<string, string> {
  const { optional = false, only } = opts;
  const dir = prodConfigDir(env, checkout);
  const envFile = join(dir, ".env.prod");
  const vercelFile = join(dir, ".vercel", "project.json");
  const wanted = (k: string): boolean => only === undefined || only.includes(k);
  const isSet = (k: string): boolean => (env[k] ?? "") !== "";
  const assigned: Record<string, string> = {};

  // Three phases, so a refusal loads nothing: read both files, check (identity conflicts, a missing Vercel id), assign.
  const text = readIfExists(envFile);
  if (text === undefined && !optional) throw missing(envFile);
  const fromFile: [string, string][] = [];
  for (const [k, v] of Object.entries(text === undefined ? {} : parseEnv(text))) {
    if (v !== undefined && IDENT.test(k) && wanted(k)) fromFile.push([k, v]);
  }
  const link: Partial<Record<(typeof VERCEL_IDS)[number][1], string>> = {};
  if (VERCEL_IDS.some(([k]) => wanted(k)) && isFile(vercelFile)) {
    try {
      const j = JSON.parse(readFileSync(vercelFile, "utf8")) as Record<string, unknown>;
      for (const [, field] of VERCEL_IDS) {
        const v = j[field];
        if (typeof v === "string" && v !== "") link[field] = v;
      }
    } catch {
      throw new Error(`::error:: cannot parse ${vercelFile}`);
    }
  }

  const conflict = (k: string, file: string): Error =>
    new Error(`::error:: ${k} in the environment disagrees with ${file} — unset it or set PROD_CONFIG_DIR`);
  const fileVal = new Map(fromFile);
  for (const k of IDENTITY_KEYS) { // the bash twin's order, so two conflicts name the same first one
    const v = fileVal.get(k);
    if (v !== undefined && isSet(k) && env[k] !== v) throw conflict(k, envFile);
  }
  for (const [k, field] of VERCEL_IDS) {
    if (!wanted(k)) continue;
    const v = link[field];
    if (isSet(k)) {
      if (v !== undefined && env[k] !== v) throw conflict(k, vercelFile);
    } else if (v === undefined && !optional) {
      throw missing(isFile(vercelFile) ? `${vercelFile} has no ${field}` : vercelFile);
    }
  }

  for (const [k, v] of fromFile) if (!NEVER_FROM_FILE.has(k) && !isSet(k)) env[k] = assigned[k] = v;
  for (const [k, field] of VERCEL_IDS) {
    const v = link[field];
    if (wanted(k) && !isSet(k) && v !== undefined) env[k] = assigned[k] = v;
  }

  if (only !== undefined && !optional) {
    for (const k of only) if (k !== "" && !isSet(k)) throw missing(`${envFile} has no ${k}`);
  }
  return assigned;
}

/** The Supabase project ref (rule in the header). `checkout` only names the dir in a refusal. */
export function prodConfigRef(env: ProdConfigEnv, checkout: string = CHECKOUT): string {
  const ref = trimAscii(env.SUPABASE_PROJECT_REF ?? "").toLowerCase();
  const url = trimAscii(env.SUPABASE_URL ?? "");
  let fromUrl = "";
  let host = "";
  if (url !== "") {
    host = (url.split("://")[1] ?? url).split("/")[0]!.toLowerCase();
    const m = /^([a-z0-9]+)\.supabase\.co$/.exec(host);
    if (!url.startsWith("https://") || !m) throw new Error(`::error:: SUPABASE_URL is not https://<ref>.supabase.co — got '${url}'`);
    fromUrl = m[1]!;
  }
  if (ref !== "") {
    if (!/^[a-z0-9]+$/.test(ref)) throw new Error(`::error:: SUPABASE_PROJECT_REF is not a project ref — got '${ref}'`);
    if (fromUrl !== "" && fromUrl !== ref) {
      throw new Error(`::error:: SUPABASE_PROJECT_REF (${ref}) disagrees with SUPABASE_URL's host (${host}) — fix the prod config`);
    }
    return ref;
  }
  if (fromUrl !== "") return fromUrl;
  throw missing(`${join(prodConfigDir(env, checkout), ".env.prod")} has no SUPABASE_URL`);
}

/** `https://<PROD_ALIAS>` (rule in the header). `checkout` only names the dir in a refusal. */
export function prodConfigBaseUrl(env: ProdConfigEnv, checkout: string = CHECKOUT): string {
  let a = trimAscii(env.PROD_ALIAS ?? "");
  if (a === "") throw missing(`${join(prodConfigDir(env, checkout), ".env.prod")} has no PROD_ALIAS`);
  return aliasUrl(a);
}

/** A `PROD_ALIAS` value (bare host — the deploy's form — or an https URL) → `https://<host>`, no trailing slash. */
export function aliasUrl(alias: string): string {
  let a = trimAscii(alias).replace(/\/+$/, "");
  const bad = (): Error => new Error(`::error:: PROD_ALIAS must be a host or an https URL — got '${a}'`);
  if (!a.startsWith("https://")) {
    if (a.includes("://")) throw bad();
    a = `https://${a}`;
  }
  if (!/^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?$/.test(a)) throw bad();
  return a;
}
