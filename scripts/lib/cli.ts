/**
 * Shared CLI-argument parsing for `scripts/` entrypoints.
 *
 * Before this module, `argOf` existed as 18 byte-identical copies and the
 * `--env`/`--from`/`--to`/`--out` quartet as 15. The duplication was harmless until a
 * probe needed a second argv source (tests pass a synthetic argv), at which point two
 * files grew a divergent `(argv, name)` signature. This module is the single form.
 *
 * ⚠ Argv-parsing only. Nothing here may grow a default that a probe's *measurement*
 * depends on — a shared default is exactly the "control arm imported from production"
 * failure. Each probe still states its own window/closes
 * defaults as in-file literals.
 */

/** `--name=value` → `value`; absent flag → `undefined`. */
export const argOf = (name: string, argv: readonly string[] = process.argv): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

/** Bare `--name` presence. */
export const hasFlag = (name: string, argv: readonly string[] = process.argv): boolean =>
  argv.includes(`--${name}`);

export type StoreEnv = "local" | "prod";

/**
 * `--env=local|prod`, defaulting per-probe. The cast is unchecked on purpose — it mirrors
 * the pre-existing call sites exactly; probes that validate the value keep doing so
 * in-file (`envArgStrict` below is the checked form).
 */
export const envArg = (
  fallback: StoreEnv = "local",
  argv: readonly string[] = process.argv,
): StoreEnv => (argOf("env", argv) ?? fallback) as StoreEnv;

/**
 * Checked `--env`: aborts with the same message `probe-member-contribution.ts` used, rather
 * than letting a typo (`--env=prd`) silently resolve to a store neither arm intended.
 */
export const envArgStrict = (
  fallback: StoreEnv = "local",
  argv: readonly string[] = process.argv,
): StoreEnv => {
  const raw = argOf("env", argv) ?? fallback;
  if (raw !== "local" && raw !== "prod") {
    console.log(`ABORT: --env must be local|prod (got ${argOf("env", argv)}).`);
    process.exit(1);
  }
  return raw;
};

/** The `--from` / `--to` / `--out` trio every replay probe declares together. */
export interface WindowArgs {
  fromArg: string | undefined;
  toArg: string | undefined;
  outArg: string | undefined;
}

export const windowArgs = (argv: readonly string[] = process.argv): WindowArgs => ({
  fromArg: argOf("from", argv),
  toArg: argOf("to", argv),
  outArg: argOf("out", argv),
});
