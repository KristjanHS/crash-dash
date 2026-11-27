/**
 * The one definition of which Supabase project the ops scripts talk to.
 *
 * `SUPABASE_PROJECT_REF` in the env wins; otherwise the ref comes from the checkout's prod config
 * (`scripts/lib/prod-config.ts`: its `SUPABASE_PROJECT_REF`, else the `<ref>` of its `SUPABASE_URL`). No default:
 * neither set → one `::error:: no target configured` refusal. Script-scoped on purpose — nothing at runtime reads it.
 *
 * Only those two keys are read from the file, into a scratch copy — the caller's env is never written, and its
 * `SUPABASE_URL` is never consulted, so a guard comparing an env URL against this ref can still fail.
 *
 * A blank env ref (empty or ASCII whitespace only, the shell twin's trim) counts as unset and is left OUT of the scratch
 * copy, so the loader's identity check never compares it against the file's ref.
 *
 * Shell twin: `prod_project_ref` (`scripts/lib/prod-config.sh`), which runs `load_prod_config` itself, in a subshell.
 */
import { loadProdConfig, prodConfigRef, trimAscii, type ProdConfigEnv } from "./lib/prod-config.js";

/** The prod project ref (rule above). `configEnv` carries `PROD_CONFIG_DIR` — `process.env` in entries, a fake in tests. */
export function prodProjectRef(
  env: { readonly SUPABASE_PROJECT_REF?: string },
  configEnv: ProdConfigEnv = process.env,
): string {
  const envRef = trimAscii(env.SUPABASE_PROJECT_REF ?? "") === "" ? undefined : env.SUPABASE_PROJECT_REF;
  const scratch: ProdConfigEnv = { SUPABASE_PROJECT_REF: envRef, PROD_CONFIG_DIR: configEnv.PROD_CONFIG_DIR };
  if (envRef === undefined) {
    loadProdConfig(scratch, { only: ["SUPABASE_PROJECT_REF", "SUPABASE_URL"], optional: true });
  }
  return prodConfigRef(scratch);
}

/** The host `pullProdCreds` derives for a ref — and therefore the only host `--env=prod` accepts. */
export function projectHost(ref: string): string {
  return `${ref}.supabase.co`;
}
