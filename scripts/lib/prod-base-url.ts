/**
 * The prod read alias a probe targets, as `https://<host>`: `PROD_ALIAS` in `env` wins (a one-command override, never
 * compared against the config file); a blank one (unset, or ASCII whitespace only — `trimAscii`) → `PROD_ALIAS` from the
 * checkout's prod config (scripts/lib/prod-config.ts), loaded into a scratch env so `env` is never written. Neither →
 * throws the config's one `::error::` line.
 *
 * Call it at use, never at import: tests import the probes that hold it. A `--base` flag / `BASE_URL` override is the
 * caller's (`flag ?? prodBaseUrl()`), since those accept non-https targets (`http://localhost:3000`).
 *
 * Bash twin: `prod_base_url` (scripts/lib/prod-config.sh) — same rule, run in its own subshell so the load exports
 * nothing; scripts/lib/prod-config.test.ts runs both over one table. Shell callers:
 *   base="$(prod_base_url)" || exit 1
 */
import type { Env } from "../../src/config.js";
import { loadProdConfig, prodConfigBaseUrl, trimAscii, type ProdConfigEnv } from "./prod-config.js";

export function prodBaseUrl(env: ProdConfigEnv = process.env): string {
  const cfg: ProdConfigEnv = { PROD_ALIAS: env.PROD_ALIAS, PROD_CONFIG_DIR: env.PROD_CONFIG_DIR };
  if (trimAscii(cfg.PROD_ALIAS ?? "") === "") {
    cfg.PROD_ALIAS = undefined;
    loadProdConfig(cfg, { only: ["PROD_ALIAS"] });
  }
  return prodConfigBaseUrl(cfg);
}

/**
 * A push's env with its tap-link alias filled: `env` itself when its `PROD_ALIAS` is non-blank; else a copy whose
 * `PROD_ALIAS` is `prodBaseUrl`'s answer over the prod config (located by `raw.PROD_CONFIG_DIR`, the knob `readEnv()`
 * does not carry). Any refusal (no config, no key, a malformed value) → `env` unchanged, so the push still sends,
 * just without its link; every refusal but an absent config file (the expected no-config case) is warned on stderr
 * so a broken config is visible in the run log. Never throws, never writes `env` or `raw` — the fill lives only in
 * the returned object.
 */
export function withConfigAlias<E extends Env>(
  env: E,
  raw: ProdConfigEnv = process.env,
  warn: (line: string) => void = console.warn,
): E {
  if (trimAscii(env.PROD_ALIAS ?? "") !== "") return env;
  try {
    return { ...env, PROD_ALIAS: prodBaseUrl({ PROD_CONFIG_DIR: raw.PROD_CONFIG_DIR }) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!ABSENT_CONFIG.test(msg)) warn(`push link dropped — ${msg}`);
    return env;
  }
}

/** The loader's refusal for a config FILE that is not there at all (vs. one that exists but lacks or breaks a key). */
const ABSENT_CONFIG = /no target configured — \S*\.env\.prod \(set PROD_CONFIG_DIR\)$/;
