/**
 * Deploy-time config stamp: the repo copy of every browser/runtime/CSP/openapi value that names the
 * prod target holds a PLACEHOLDER; this replaces each placeholder token across a deploy tree from the
 * checkout's prod config (env), right before the upload.
 *
 *     SUPABASE_URL=… PROD_ALIAS=… SUPABASE_ANON_KEY=… npx tsx scripts/stamp-deploy-config.ts <tree>
 *
 * Runs AFTER bundle + minify (`scripts/deploy-prod-local.sh`): every placeholder is a unique string
 * literal, and a string literal survives esbuild's bundle/minify byte-for-byte while the binding that
 * holds it does not (renamed). That is why the anon key's placeholder is a token, not `""`.
 *
 * Refuses (exit 1, `::error::` line, NOTHING written) on: a missing or malformed config key, an anon key
 * that is not this project's anon key (a JWT whose role is not `anon` or whose `ref` is another project,
 * or the value of `SUPABASE_SERVICE_KEY`), a declared (file, token) pair with zero hits, any placeholder
 * left anywhere in the scanned roots afterwards, and a `<tree>` that is the checkout itself (an in-place
 * stamp would dirty the repo). Never a fallback.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repo-copy placeholders. Tests pin cross-file consistency against THESE, never a real value. */
export const PLACEHOLDER = {
  /** Supabase-shaped (20 lowercase chars). */
  ref: "configrefplaceholder",
  host: "configrefplaceholder.supabase.co",
  baseUrl: "https://prod-alias.invalid",
  /** Not key-shaped, so an unstamped page reads "not configured" (`publicConnection`). */
  anonKey: "anon-key-placeholder",
} as const;

type TokenName = "host" | "baseUrl" | "anonKey";

/**
 * The declared stamp set: each (file, token) pair must take ≥1 substitution, else the repo copy has
 * drifted off its placeholder and the stamp would silently ship a stale literal.
 */
export const STAMP_SET: readonly { file: string; tokens: readonly TokenName[] }[] = [
  { file: "public/supabase-host.js", tokens: ["host", "anonKey"] },
  { file: "public/index.html", tokens: ["host"] },
  { file: "public/lab.html", tokens: ["host"] },
  { file: "public/exposure.html", tokens: ["host"] },
  { file: "vercel.json", tokens: ["host"] },
  { file: "openapi.yaml", tokens: ["baseUrl"] },
];

/** Everything replaced or left-over-checked lives under these (dirs) or is one of these (files). */
export const SCAN_ROOTS = ["public", "api", "src", "vercel.json", "openapi.yaml"] as const;
const TEXT_EXT = /\.(?:[cm]?js|ts|html|json|ya?ml|css|txt|map)$/;

/**
 * Placeholder fragments that must not survive a stamp (the bare ref catches every host/ref spelling). Also the
 * post-deploy smoke's list (`scripts/probe-prod-smoke.ts`): what must never be SERVED either.
 */
export const LEFTOVER = [PLACEHOLDER.ref, new URL(PLACEHOLDER.baseUrl).host, PLACEHOLDER.anonKey] as const;

export class StampRefusal extends Error {}

/** A legacy JWT anon key or a new-style publishable key — the same shape test `publicConnection` applies. */
export const isKeyShaped = (key: string): boolean => /^(sb_publishable_|eyJ)/.test(key);

/** The payload of a JWT-shaped key, or `null` when it is not three base64url segments around a JSON object. */
function jwtPayload(key: string): Record<string, unknown> | null {
  const parts = key.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The anon key is stamped into PUBLIC JS, so shape is not enough: the service-role key is ALSO `eyJ…`. Refuse the
 * service key's value (any shape), and a JWT that is not `role: "anon"` for THIS project (`ref` = the first DNS
 * label of the SUPABASE_URL host). A `sb_publishable_…` key carries no claims; its prefix is the role.
 */
export function assertAnonKeyForHost(anonKey: string, host: string, serviceKey: string | undefined): void {
  if (serviceKey?.trim() && anonKey === serviceKey.trim())
    throw new StampRefusal("SUPABASE_ANON_KEY equals SUPABASE_SERVICE_KEY — refusing to publish the service key");
  if (!anonKey.startsWith("eyJ")) return;
  const claims = jwtPayload(anonKey);
  if (!claims) throw new StampRefusal("SUPABASE_ANON_KEY is eyJ… but not a decodable JWT");
  if (claims.role !== "anon")
    throw new StampRefusal(`SUPABASE_ANON_KEY is a JWT with role ${JSON.stringify(claims.role)}, not "anon" — refusing to publish it`);
  const ref = host.split(".")[0];
  if (claims.ref !== ref)
    throw new StampRefusal(`SUPABASE_ANON_KEY is for project ${JSON.stringify(claims.ref)}, not SUPABASE_URL's ${JSON.stringify(ref)}`);
}

/** `PROD_ALIAS` as a bare host or a URL → `https://host`, no trailing slash, no path. */
export function baseUrlFromAlias(alias: string): string {
  const raw = alias.trim();
  const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (url.protocol !== "https:") throw new StampRefusal(`PROD_ALIAS must be https (got ${url.protocol})`);
  if (url.pathname !== "/" || url.search || url.hash) throw new StampRefusal("PROD_ALIAS must be a host, not a path");
  return `https://${url.host}`;
}

/** Token → replacement, from the checkout's prod config. Throws `StampRefusal` on any missing/bad key. */
export function resolveStampValues(env: NodeJS.ProcessEnv): Record<TokenName, string> {
  const need = (k: string): string => {
    const v = env[k]?.trim();
    if (!v) throw new StampRefusal(`${k} is not set — no target configured`);
    return v;
  };
  let host: string;
  try {
    const u = new URL(need("SUPABASE_URL"));
    if (u.protocol !== "https:") throw new StampRefusal("SUPABASE_URL must be https");
    host = u.host;
  } catch (e) {
    if (e instanceof StampRefusal) throw e;
    throw new StampRefusal("SUPABASE_URL is not a URL");
  }
  const anonKey = need("SUPABASE_ANON_KEY");
  if (!isKeyShaped(anonKey)) throw new StampRefusal("SUPABASE_ANON_KEY is not key-shaped (sb_publishable_… or a JWT)");
  assertAnonKeyForHost(anonKey, host, env.SUPABASE_SERVICE_KEY);
  let baseUrl: string;
  try {
    baseUrl = baseUrlFromAlias(need("PROD_ALIAS"));
  } catch (e) {
    if (e instanceof StampRefusal) throw e;
    throw new StampRefusal("PROD_ALIAS is not a host or URL");
  }
  return { host, baseUrl, anonKey };
}

function listFiles(tree: string): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name === ".git") continue;
      const p = join(abs, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && TEXT_EXT.test(ent.name)) out.push(p);
    }
  };
  for (const root of SCAN_ROOTS) {
    const p = join(tree, root);
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) walk(p);
    else out.push(p);
  }
  return out;
}

const count = (s: string, token: string): number => s.split(token).length - 1;

/**
 * Stamp `tree` in place. All checks run on the computed result BEFORE the first write, so a refusal
 * leaves the tree untouched. Returns the per-file substitution counts.
 */
export function stampTree(tree: string, values: Record<TokenName, string>): Map<string, number> {
  const tokens: [TokenName, string][] = [
    ["host", PLACEHOLDER.host],
    ["baseUrl", PLACEHOLDER.baseUrl],
    ["anonKey", PLACEHOLDER.anonKey],
  ];
  const next = new Map<string, string>();
  const hits = new Map<string, Record<TokenName, number>>();
  for (const abs of listFiles(tree)) {
    const src = readFileSync(abs, "utf8");
    let out = src;
    const per = { host: 0, baseUrl: 0, anonKey: 0 };
    for (const [name, tok] of tokens) {
      per[name] = count(out, tok);
      if (per[name] > 0) out = out.split(tok).join(values[name]);
    }
    const rel = relative(tree, abs);
    hits.set(rel, per);
    if (out !== src) next.set(abs, out);
    const left = LEFTOVER.filter((t) => out.includes(t));
    if (left.length) throw new StampRefusal(`placeholder left in ${rel}: ${left.join(", ")}`);
  }
  for (const { file, tokens: want } of STAMP_SET) {
    const per = hits.get(file);
    if (!per) throw new StampRefusal(`declared file missing from the tree: ${file}`);
    for (const t of want) {
      if (per[t] === 0) throw new StampRefusal(`declared file ${file} took zero ${t} substitutions — repo copy drifted off its placeholder (or the tree is already stamped)`);
    }
  }
  const report = new Map<string, number>();
  for (const [abs, body] of next) {
    writeFileSync(abs, body);
    const per = hits.get(relative(tree, abs))!;
    report.set(relative(tree, abs), per.host + per.baseUrl + per.anonKey);
  }
  return report;
}

/**
 * The checkout this script lives in — the directory above `scripts/`, plus (when it has `.git`) its toplevel and
 * its main worktree root. A tree with no git metadata is its own root; a `.git` git cannot resolve refuses.
 */
function checkoutRoots(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "..");
  const roots = [root];
  if (existsSync(join(root, ".git"))) {
    const git = (...args: string[]): string =>
      execFileSync("git", ["-C", here, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    try {
      roots.push(git("rev-parse", "--show-toplevel"), dirname(resolve(here, git("rev-parse", "--git-common-dir"))));
    } catch {
      throw new StampRefusal(`${root}/.git exists but git cannot resolve it — cannot tell the checkout from a deploy tree`);
    }
  }
  return roots.map((r) => realpathSync(r));
}

/** Refuse a `<tree>` that IS the checkout: stamping it would rewrite tracked files. */
export function assertNotCheckout(tree: string, roots: readonly string[]): void {
  const real = realpathSync(tree);
  if (roots.includes(real)) throw new StampRefusal(`refusing to stamp the checkout itself (${real}) — pass a deploy tree`);
}

if (process.argv[1] && /stamp-deploy-config\.ts$/.test(process.argv[1])) {
  try {
    const arg = process.argv[2];
    if (!arg) throw new StampRefusal("usage: stamp-deploy-config.ts <tree>");
    const tree = resolve(arg);
    if (!existsSync(tree) || !statSync(tree).isDirectory()) throw new StampRefusal(`not a directory: ${tree}`);
    assertNotCheckout(tree, checkoutRoots());
    const report = stampTree(tree, resolveStampValues(process.env));
    const total = [...report.values()].reduce((a, b) => a + b, 0);
    console.log(`▶ stamped deploy config: ${total} substitution(s) across ${report.size} file(s)`);
  } catch (e) {
    if (!(e instanceof StampRefusal)) throw e;
    console.error(`::error:: stamp-deploy-config: ${e.message}`);
    process.exit(1);
  }
}
