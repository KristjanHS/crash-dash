/**
 * delete_my_account() end-to-end against a LIVE local Postgres (J0.5.1).
 *
 * WHERE IT RUNS. `describe.runIf(hasDb)` — the house gate (`src/store.leg-pillars.test.ts`,
 * `src/store.test-helpers.ts`): local creds + `DB_TESTS=1`. `npm run check:integration` arms all three
 * against the isolated `crash-dash-ci` stack and lands this file in phase 1 (serial) automatically because
 * it carries `.runIf(hasDb)`. Absent the stack the whole block skips VISIBLY, never silently green.
 *
 * WHY A DIRECT `pg` CONNECTION, NOT supabase-js. The RPC's boundary is `set role authenticated` + a
 * `request.jwt.claims` GUC — PostgREST cannot role-switch on demand, so the impersonation must be raw SQL
 * over a superuser connection (`scripts/probe-dbauth.ts` is the in-repo `pg` precedent). The DB URL is
 * derived from `SUPABASE_URL` (API :5532x → DB :5532(x+1), the +1000 offset db.sh/ci-stack.sh use), or set
 * explicitly with `SUPABASE_DB_URL`.
 *
 * ⚠ TOUCHES ONLY THE TWO throwaway uids it mints (`crypto.randomUUID()`), never a truncate, never a
 * `db reset` — the local history is irreplaceable (`docs/reference.md` §[runbook] Database (local Supabase)). `afterAll` deletes exactly those
 * uids' rows, scoped by id, so a red mid-test still cleans up after itself.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
const isLocalUrl = Boolean(url && /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url));
const hasDb = Boolean(url && key) && isLocalUrl && process.env.DB_TESTS === "1";

/** DB URL: explicit override, else derive from the API URL (db port = api port + 1, postgres/postgres). */
function dbUrl(): string {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;
  const u = new URL(url!);
  return `postgresql://postgres:postgres@${u.hostname}:${Number(u.port) + 1}/postgres`;
}

describe.runIf(hasDb)("delete_my_account() — live self-erase (integration)", () => {
  const A = crypto.randomUUID();
  const B = crypto.randomUUID();
  let client: Client;
  let sessionsCascade = false;
  let sessionsLeftForA: number | null = null;

  const claims = (sub: string) => JSON.stringify({ sub, role: "authenticated" });

  /** Run `fn`'s queries under `role` with A/B's JWT claims, in a transaction that commits. */
  async function asRoleCommit(role: string, sub: string | null, fn: () => Promise<void>): Promise<void> {
    await client.query("begin");
    try {
      if (sub) await client.query("select set_config('request.jwt.claims', $1, true)", [claims(sub)]);
      await client.query(`set local role ${role}`);
      await fn();
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    }
  }

  /** Same, but expects `fn` to throw; returns the pg error code (e.g. 42501, 23503, P0001). */
  async function expectRaise(role: string, sub: string | null, fn: () => Promise<void>): Promise<string> {
    await client.query("begin");
    try {
      if (sub) await client.query("select set_config('request.jwt.claims', $1, true)", [claims(sub)]);
      await client.query(`set local role ${role}`);
      await fn();
      await client.query("rollback");
      throw new Error("expected a raise, got none");
    } catch (e) {
      await client.query("rollback").catch(() => {});
      return (e as { code?: string }).code ?? String((e as Error).message);
    }
  }

  const count = async (sql: string, params: unknown[]): Promise<number> =>
    Number((await client.query(sql, params)).rows[0].n);

  beforeAll(async () => {
    client = new Client({ connectionString: dbUrl() });
    await client.connect();
    sessionsCascade =
      (await client.query(
        `select 1 from pg_constraint c
          where c.confrelid = 'auth.users'::regclass and c.contype = 'f'
            and c.conrelid = to_regclass('auth.sessions') and c.confdeltype = 'c'`,
      )).rowCount === 1;

    // Seed TWO throwaway auth users + a journal row + a subscriber row each (as superuser — RLS bypassed).
    for (const id of [A, B]) {
      await client.query("insert into auth.users (id) values ($1)", [id]);
      await client.query(
        "insert into holdings_journal (user_id, entry_date, sleeve, rung, cash_pct) values ($1, current_date, 'AGGR', 5, 20)",
        [id],
      );
      await client.query("insert into email_subscribers (user_id, email) values ($1, $2)", [id, `${id}@example.test`]);
    }
    if (sessionsCascade) await client.query("insert into auth.sessions (id, user_id) values (gen_random_uuid(), $1)", [A]);
  });

  afterAll(async () => {
    if (!client) return;
    // Scoped cleanup — only the two minted uids, in FK-safe order. Never a truncate.
    for (const id of [A, B]) {
      await client.query("delete from holdings_journal where user_id = $1", [id]).catch(() => {});
      await client.query("delete from email_subscribers where user_id = $1", [id]).catch(() => {});
      if (sessionsCascade) await client.query("delete from auth.sessions where user_id = $1", [id]).catch(() => {});
      await client.query("delete from auth.users where id = $1", [id]).catch(() => {});
    }
    await client.end();
  });

  test("A erases exactly A's rows; B untouched; a replay raises; anon denied; a post-erase insert hits the FK", async () => {
    // Sanity: both users are fully seeded before erasure.
    expect(await count("select count(*)::int n from holdings_journal where user_id in ($1,$2)", [A, B])).toBe(2);
    expect(await count("select count(*)::int n from email_subscribers where user_id in ($1,$2)", [A, B])).toBe(2);

    // A calls the RPC as `authenticated` with A's JWT claims.
    await asRoleCommit("authenticated", A, async () => {
      await client.query("select public.delete_my_account()");
    });

    // A gone from all three tables; B intact in all three.
    expect(await count("select count(*)::int n from holdings_journal where user_id = $1", [A])).toBe(0);
    expect(await count("select count(*)::int n from email_subscribers where user_id = $1", [A])).toBe(0);
    expect(await count("select count(*)::int n from auth.users where id = $1", [A])).toBe(0);
    expect(await count("select count(*)::int n from holdings_journal where user_id = $1", [B])).toBe(1);
    expect(await count("select count(*)::int n from email_subscribers where user_id = $1", [B])).toBe(1);
    expect(await count("select count(*)::int n from auth.users where id = $1", [B])).toBe(1);

    // Counted here, right after the erase; asserted by the session-cascade test below.
    sessionsLeftForA = sessionsCascade ? await count("select count(*)::int n from auth.sessions where user_id = $1", [A]) : null;

    // A replayed call after erasure is a CLEAN error, never a silent no-op.
    const replay = await expectRaise("authenticated", A, async () => {
      await client.query("select public.delete_my_account()");
    });
    expect(replay).toBe("P0001"); // raise_exception — the message is "no such account"

    // anon has no EXECUTE grant → insufficient_privilege, not a delete.
    const anon = await expectRaise("anon", null, async () => {
      await client.query("select public.delete_my_account()");
    });
    expect(anon).toBe("42501");

    // The erased user's still-valid JWT cannot re-insert orphan rows — the FK (RESTRICT) rejects it.
    const orphan = await expectRaise("authenticated", A, async () => {
      await client.query(
        "insert into holdings_journal (user_id, entry_date, sleeve, rung, cash_pct) values ($1, current_date, 'AGGR', 5, 20)",
        [A],
      );
    });
    expect(orphan).toBe("23503"); // foreign_key_violation
  });

  // A's GoTrue session rows cascade with the user — asserted only where the table exists and cascades
  // (a stack without GoTrue has no `auth.sessions`; `docs/reference.md` §[runbook] Database (local Supabase)).
  test("A's GoTrue session rows cascade with the erase", (ctx) => {
    ctx.skip(!sessionsCascade, "auth.sessions absent/uncascaded on this stack (GoTrue not running)");
    expect(sessionsLeftForA).toBe(0);
  });
});
