/**
 * Disposable-stack barrier (audit TEST-2, Stage 4.1).
 *
 * WHY THIS EXISTS: `src/store.test-helpers.ts`'s truncating harness TRUNCATES every table in
 * whatever DB its creds reach. Its gates were `DB_TESTS=1` + `isLocalUrl` — but the
 * irreplaceable dev DB *is* localhost, so `isLocalUrl` separates local-from-prod, not
 * precious-from-disposable, and `DB_TESTS=1` is one line in an untracked `.env.local`
 * away from wiping it (it already wiped an 82k-row backfill once, 2026-07-16).
 *
 * The barrier: a truncating suite must first prove the target stack carries the
 * `_disposable_stack` marker table. CI's ephemeral stack seeds it; the dev stack never
 * does, so no `.env.local` line can make the dev DB truncatable.
 *
 * ⚠ THE MARKER IS DELIBERATELY **NOT** A `supabase/migrations/*.sql` FILE.
 * Migrations apply to prod (`.claude/rules/migrations.md`), so a marker living there would ship to
 * prod and mark PROD disposable — inverting the guard into a loaded gun. Its only homes are two
 * ephemeral-stack seed steps: `scripts/ci-stack.sh` (the local/CI `crash-dash-ci` stack, port-asserted
 * to :55322) and `.github/workflows/integration.yml`.
 * If you are here to "fix" the missing migration: don't. That is the whole mechanism.
 *
 * This is defence-in-depth — it REPLACES neither `DB_TESTS=1` nor `isLocalUrl`; all
 * three stay.
 *
 * ⚠ NEVER HAND-CREATE THE MARKER TABLE ON THE **DEV** STACK to make `DB_TESTS=1` pass. Throwing
 * there is the designed behaviour, not a setup gap: creating it by hand re-arms the truncate against
 * the irreplaceable dev DB — the exact 2026-07-16 loss this seam exists to prevent.
 *
 * ✅ THE SUPPORTED LOCAL PATH IS `npm run check:integration`. It runs
 * `scripts/run-integration-tests.sh` → `scripts/ci-stack.sh up` (brings up the isolated
 * `crash-dash-ci` stack on :55322 and seeds the marker there) and arms `DB_TESTS=1` against it.
 * `.claude/rules/dev-workflow.md` §Verification gate requires it **before pushing** any `src/store*` or
 * `supabase/migrations/**` change — so the DB half is provable locally, and a plain `npm run check`
 * (which does NOT arm `DB_TESTS`) is what says nothing about the store integration suite. Reach for that
 * gate, never for a hand-made marker.
 *
 * Falsifiers (run from the repo root; each executed on the clean tree, each able to go red):
 *   # A: exactly 2 creation sites — the ephemeral-stack seeds; ci.yml is NOT one of them
 *   #    expect: scripts/ci-stack.sh, .github/workflows/integration.yml
 *   grep -rln 'create table[^;]*_disposable_stack' --exclude-dir=node_modules --exclude-dir=.git .
 *   # B: must print nothing — a marker under supabase/ would ship to PROD and invert the guard
 *   #    (verified red by planting a throwaway supabase/migrations/*.sql naming the table)
 *   grep -rln '_disposable_stack' supabase/
 *   # C: exactly 1 file — this file owns the name (src/store.ts has zero hits)
 *   grep -rln 'DISPOSABLE_MARKER_TABLE = ' src/
 */

/** Marker table name (assigned by the Stage 4.1 plan). Must match the seed steps in
 *  `scripts/ci-stack.sh` and `.github/workflows/integration.yml` (falsifier A above). */
export const DISPOSABLE_MARKER_TABLE = "_disposable_stack";

/** Resolves true when the target stack carries the marker. */
type MarkerProbe = () => Promise<boolean>;

/** Minimal structural slice of a supabase-js client — keeps this seam DB-free to unit test. */
type MarkerReadable = {
  from: (table: string) => {
    select: (columns: string) => {
      limit: (n: number) => PromiseLike<{ error: unknown }>;
    };
  };
};

/** PostgREST's "table not in the schema cache" code — the ONE error that means "absent". */
const MARKER_ABSENT_CODE = "PGRST205";

/**
 * The real probe: a zero-row projection of the marker table. A missing table comes back
 * as a PostgREST error (PGRST205), never a throw — so absent ⇒ false, present ⇒ true.
 *
 * ANY OTHER error THROWS, naming its code + message. supabase-js folds transport failures
 * (`fetch failed`, a PostgREST 503 mid schema-reload, an exhausted pool) into the same
 * `{ error }` slot, so a bare `error === null` read them as "no marker" and printed the
 * dev-DB warning for what was a flaky stack (2026-09-06: the full DB-armed suite tripped
 * this intermittently on a freshly-restored crash-dash-ci stack, a different file each run).
 * The guard's job is to distinguish precious-from-disposable; a transient must fail as
 * itself, not masquerade as the barrier.
 */
export const supabaseMarkerProbe =
  (client: MarkerReadable): MarkerProbe =>
  async () => {
    const { error } = await client.from(DISPOSABLE_MARKER_TABLE).select("*").limit(1);
    if (error === null) return true;
    const e = error as { code?: unknown; message?: unknown; details?: unknown } | null;
    if (e?.code === MARKER_ABSENT_CODE) return false;
    throw new Error(
      `marker probe of \`${DISPOSABLE_MARKER_TABLE}\` errored (NOT a missing-table answer - ` +
        `the stack may be flaky, not unmarked): code=${String(e?.code)} message=${String(e?.message)}` +
        (e?.details ? ` details=${String(e.details)}` : ""),
    );
  };

/**
 * Throws (naming the DB) unless the target stack is marked disposable. Call this BEFORE
 * the first delete of any truncating helper — an unmarked DB must never reach a `.delete()`.
 */
export async function assertDisposableStack(url: string, probe: MarkerProbe): Promise<void> {
  if (await probe()) return;
  throw new Error(
    `refusing to truncate ${url}: no \`${DISPOSABLE_MARKER_TABLE}\` marker table. ` +
      `This DB is not a disposable CI stack - it may be the irreplaceable local dev DB. ` +
      `The marker is seeded ONLY on the ephemeral crash-dash-ci stack (deliberately not a migration, ` +
      `so it can never reach prod) - use \`npm run check:integration\`. Do NOT create it by hand on a ` +
      `stack whose data you cannot lose.`,
  );
}
