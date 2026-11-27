/**
 * Prod-writes switch — one gitignored file, `.prod-writes`, at the MAIN worktree root says whether this checkout may
 * write to its deploy target (rows, schema, roles, cron runs, deploys, pushes). Reads never consult it.
 *
 *   file says `on`          → writes pass
 *   file says `off`         → every wired writer refuses before its first write (or the network call that exists
 *                             only to perform one)
 *   file missing            → no guard (a fresh clone is unaffected)
 *   any other content       → refuse (a typo fails closed; an unreadable file or a directory fails closed too)
 *   env `PROD_WRITES=on|off` → wins over the file for one command; an empty/blank value counts as unset
 *   `PROD_WRITES=<non-blank>` in an env file → refuse, whatever the value: a writer that loads `.env.prod` /
 *                             `.env.local` into its env (`tsx --env-file=.env.local`, a hand-run `set -a` source) would
 *                             otherwise turn a one-command override into a permanent one. Checked in
 *                             `.env.prod` + `.env.local` at the switch's directory, at this checkout (a
 *                             linked worktree's own) AND at an absolute `PROD_CONFIG_DIR` (the checkout's prod
 *                             config; a relative value refuses); only that one key is read, a `#` comment line never
 *                             counts, an `export ` prefix and quotes are allowed, an unreadable file refuses.
 *
 * Values are trimmed of ASCII whitespace only (space, \t, \n, \r, \v, \f — so CRLF passes, a BOM or NBSP refuses) and
 * compared case-insensitively.
 *
 * Where the file lives — resolved from THIS module's checkout (`<checkout>/src/..`), never from cwd:
 *   `<checkout>/.git` absent → `<checkout>/.prod-writes` (a tree with no git metadata)
 *   `<checkout>/.git` present → `<parent of git rev-parse --git-common-dir>/.prod-writes`, i.e. the main worktree
 *                               root, so every linked worktree obeys the primary's switch; `git` failing here refuses
 *
 * Bash twin: `scripts/lib/prod-writes.sh` (`require_prod_writes`) — same file, same parse, same rule; change both
 * together (`src/prod-writes.test.ts` runs both over one table).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childProcessEnv } from "./config.js";

/** The env slice the switch reads — entries pass `process.env`, tests pass literals. */
export interface ProdWritesEnv {
  readonly PROD_WRITES?: string;
  /** The checkout's prod config dir (`scripts/lib/prod-config.ts`) — its env files are scanned too. */
  readonly PROD_CONFIG_DIR?: string;
}

/** This module's checkout (`<checkout>/src/..`). */
const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** ASCII whitespace only — the bash twin trims the same set under `LC_ALL=C`. */
const trimAscii = (s: string): string => s.replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, "");

const GIT_REPO_VARS = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]);

/**
 * The directory holding `checkout`'s switch — the MAIN worktree root (rule in the header); also the default prod
 * config dir (`scripts/lib/prod-config.ts`). Throws when `.git` exists but `git` cannot resolve it.
 */
export function mainWorktreeRoot(checkout: string): string {
  if (!existsSync(join(checkout, ".git"))) return checkout;
  // Strip inherited repo-pointing vars (set inside git hooks) so the answer is about THIS checkout; git needs no app config.
  const env = childProcessEnv(GIT_REPO_VARS);
  const common = execFileSync("git", ["-C", checkout, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!common) throw new Error("git rev-parse --git-common-dir printed nothing");
  return dirname(common);
}

/** The env files the override must never come from (header), per directory. */
const ENV_FILES = [".env.prod", ".env.local"] as const;

/** A `PROD_WRITES=` assignment line — leading ASCII whitespace, optional `export `; group 1 = the raw value. */
const ENV_FILE_LINE = /^[ \t\n\r\v\f]*(?:export[ \t\n\r\v\f]+)?PROD_WRITES[ \t\n\r\v\f]*=(.*)$/s; // `s`: a CRLF line keeps its `\r`, which a bare `.` would not match

/** True when `text` holds a `PROD_WRITES=<non-blank>` line (blank = empty, `""`/`''`, or only a `#` comment). */
function envFileSetsProdWrites(text: string): boolean {
  return text.split("\n").some((line) => {
    const m = ENV_FILE_LINE.exec(line);
    if (!m) return false;
    let v = trimAscii(m[1] ?? "");
    if (v.startsWith("#")) return false;
    const quoted = /^"(.*)"$/s.exec(v) ?? /^'(.*)'$/s.exec(v);
    if (quoted) v = trimAscii(quoted[1] ?? "");
    return v !== "";
  });
}

/** A file's text; `undefined` when it does not exist. Any other read error (EISDIR, EACCES) propagates. */
function readProdWritesFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/**
 * Throw (one `::error::` line naming `what`, the deciding source and the override) unless prod writes are on.
 * Call it BEFORE the first write — and before any network call that only exists to perform one. `checkout` is a
 * test seam; entries leave it defaulted.
 */
export function requireProdWrites(
  what: string,
  env: ProdWritesEnv,
  checkout: string = CHECKOUT,
): void {
  let dir: string | undefined;
  let locateError: unknown; // stashed, not swallowed: the no-override path below throws naming it
  try {
    dir = mainWorktreeRoot(checkout);
  } catch (e) {
    locateError = e;
  }
  // The checkout's prod config dir is the third place a loader reads env files from.
  let cfg = env.PROD_CONFIG_DIR ?? "";
  if (cfg !== "") {
    if (!cfg.startsWith("/")) throw new Error(`::error:: refusing ${what} — PROD_CONFIG_DIR must be an absolute path — got '${cfg}'`);
    cfg = cfg.replace(/(?<=.)\/+$/, "");
  }
  // The env-file check runs first and whatever the env says: it is what makes the env override trustworthy.
  const dirs = [...new Set([dir, checkout, cfg].filter((d): d is string => d !== undefined && d !== ""))];
  for (const d of dirs) {
    for (const name of ENV_FILES) {
      const envFile = join(d, name);
      let text: string | undefined;
      try {
        text = readProdWritesFile(envFile);
      } catch (e) {
        throw new Error(`::error:: refusing ${what} — cannot read ${envFile} to check it for PROD_WRITES (${(e as Error).message})`);
      }
      if (text !== undefined && envFileSetsProdWrites(text)) {
        throw new Error(`::error:: refusing ${what} — PROD_WRITES must not be set in an env file (${envFile}) — remove it`);
      }
    }
  }
  const envValue = trimAscii(env.PROD_WRITES ?? "");
  let value: string;
  let source: string;
  if (envValue) {
    value = envValue;
    source = "env PROD_WRITES";
  } else {
    if (dir === undefined) {
      throw new Error(`::error:: refusing ${what} — cannot locate the .prod-writes switch for ${checkout} (${(locateError as Error).message.split("\n")[0] ?? ""}); re-run with PROD_WRITES=on to override`);
    }
    const path = join(dir, ".prod-writes");
    let text: string | undefined;
    try {
      text = readProdWritesFile(path);
    } catch (e) {
      throw new Error(`::error:: refusing ${what} — cannot read ${path} (${(e as Error).message}); re-run with PROD_WRITES=on to override`);
    }
    if (text === undefined) return;
    value = trimAscii(text);
    source = path;
  }
  if (value.toLowerCase() === "on") return;
  throw new Error(`::error:: refusing ${what} — prod writes are not on (${source}); re-run with PROD_WRITES=on to override`);
}
