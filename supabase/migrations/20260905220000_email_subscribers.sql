-- crash-dash — email subscribers.
--
-- One row per address that confirmed a magic link on `public/subscribe.html`. The magic link
-- IS the double opt-in: Supabase Auth mails it (Brevo SMTP), the browser lands with a session
-- and writes its own row here DIRECTLY via PostgREST — no Vercel function (the handler count is
-- pinned at 8, `api/deploy-budget.test.ts`). So, exactly as `holdings_journal`
-- (`20260802120000_add_holdings_journal.sql`, §E-4), RLS is the whole security boundary:
--   * `anon` gets NO grant — the table is invisible to the browser until a real login.
--   * Every verb is keyed to BOTH JWT claims: `user_id = auth.uid()` (`sub`) and, on the write
--     paths, `email = <the JWT's email claim>` — so a visitor can neither forge another id nor
--     enrol a victim's address under their own. The email claim is read straight off PostgREST's
--     `request.jwt.claims` GUC rather than via `auth.jwt()`: that helper is installed by the
--     GoTrue auth service, which the slim local config disables (`[auth] enabled = false`), so
--     a bare local stack lacks it (scripts/sql/local-auth-shim.sql now backfills it after every
--     bring-up, but a migration must apply on a stack that has not run the shim yet). `auth.jwt()`
--     on prod is exactly this GUC read, so the semantics match.
--   * UPDATE exists ONLY so the re-subscribe upsert is idempotent: PostgREST's
--     `Prefer: resolution=merge-duplicates` emits `ON CONFLICT DO UPDATE`, a 42501 without an
--     UPDATE policy AND grant. Its `using` + `with check` keep it own-row, same pair as INSERT.
--   * Unlike the journal, DELETE is granted (unsubscribe = delete own row) — this is a
--     membership list, not append-only history.
-- The cron (`service_role`, bypasses RLS) reads the list to BCC the band mail (`src/email.ts`).
-- Additive-only in effect: nothing here reads, rewrites or removes a row.
--
-- destructive: reviewed — the gate's DELETE/DROP/UPDATE hits are all keyword false positives:
-- `on delete cascade` is a foreign-key action on a table this same file creates empty; `for
-- update` / `for delete` name the verb a policy governs; the four `drop policy if exists` are the
-- house idempotency idiom (Postgres has no `create policy if not exists`), each re-created on the
-- next statement and catalog-only (`20260802120000_add_holdings_journal.sql`). The `grant` on
-- line ~56 lists privilege names (`20260725220000_add_leg_pillars.sql`). No snapshot precedes it.
create table if not exists email_subscribers (
  -- One row per auth user; the primary key makes a re-subscribe an idempotent upsert
  -- (`Prefer: resolution=merge-duplicates`) and the cascade removes the row if the auth
  -- user is ever deleted from the dashboard.
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  created_at timestamptz not null default now()
);

alter table email_subscribers enable row level security;

-- Idempotency idiom: Postgres has no `create policy if not exists`. These DROPs are catalog-only
-- and re-created immediately below (the destructive gate DOES flag them — sentinel above).
drop policy if exists email_subscribers_owner_read on email_subscribers;
create policy email_subscribers_owner_read on email_subscribers
  for select to authenticated using (user_id = auth.uid());

drop policy if exists email_subscribers_owner_insert on email_subscribers;
create policy email_subscribers_owner_insert on email_subscribers
  for insert to authenticated with check (user_id = auth.uid() and email = (current_setting('request.jwt.claims', true)::jsonb ->> 'email'));

drop policy if exists email_subscribers_owner_update on email_subscribers;
create policy email_subscribers_owner_update on email_subscribers
  for update to authenticated using (user_id = auth.uid())
  with check (user_id = auth.uid() and email = (current_setting('request.jwt.claims', true)::jsonb ->> 'email'));

drop policy if exists email_subscribers_owner_delete on email_subscribers;
create policy email_subscribers_owner_delete on email_subscribers
  for delete to authenticated using (user_id = auth.uid());

-- Grants: `authenticated` may read, add, merge and remove its own row (RLS scopes each verb).
-- `service_role` reads the list for the cron send. `anon` is granted NOTHING.
grant select, insert, update, delete on email_subscribers to authenticated;
grant select on email_subscribers to service_role;
