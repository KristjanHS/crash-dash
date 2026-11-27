-- crash-dash — GDPR self-erasure RPC (J0.5.1).
--
-- One sanctioned delete path on `holdings_journal`: a signed-in user erases their OWN account and
-- everything about them, in one transaction, with no service-role key in the browser and no 9th
-- Vercel function (`api/deploy-budget.test.ts` pins the handler count at 8). The browser POSTs
-- `/rest/v1/rpc/delete_my_account` with its own bearer; the function's `auth.uid()` scope IS the
-- boundary.
--
-- WHAT ERASURE DOES NOT TOUCH (J0.5.4): `readings`, `alert_log` and `calibration` hold no per-user
-- data. Supabase Auth's own audit trail `auth.audit_log_entries` SURVIVES the `auth.users` delete by
-- design (it is not FK-bound to the user). GoTrue's `auth.identities` / `auth.sessions` /
-- `auth.refresh_tokens` rows go WITH the user — their FKs cascade on the `auth.users` delete (the
-- live test asserts `auth.sessions` is empty only where GoTrue's tables exist; the slim local stack
-- has none). Brevo's send log and Vercel's request log are processor-side, out of this schema.
--
-- destructive: reviewed — the function BODY carries three `delete from` (holdings_journal,
-- email_subscribers, auth.users) that trip the keyword gate, but this is a per-CALLER self-erase
-- scoped to `auth.uid()`, run at call time, never at apply time: applying the migration only creates
-- the function and touches no history row, so no snapshot precedes it.
create function public.delete_my_account() returns void
language plpgsql
security definer
-- Supabase lint 0011: an EMPTY search path forces every object reference to be schema-qualified, so
-- a definer running as the migration owner cannot be steered onto an attacker-shadowed object on a
-- mutable search_path. Every name below is qualified: `public.*`, `auth.users`, `auth.uid()`.
set search_path = ''
as $$
begin
  -- No JWT, no subject claim — a call with no identity erases nothing.
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  -- A replayed call after erasure (a still-valid stateless JWT, up to ~1 h) is a CLEAN error, never
  -- a silent no-op that would report "deleted" a second time.
  if not exists (select 1 from auth.users where id = auth.uid()) then
    raise exception 'no such account';
  end if;
  -- Order matters: journal first so the RESTRICT FK below is satisfied by the time the user row goes;
  -- email_subscribers next (its FK would cascade anyway); the auth.users row last, in this one
  -- transaction.
  delete from public.holdings_journal where user_id = auth.uid();
  delete from public.email_subscribers where user_id = auth.uid();
  delete from auth.users where id = auth.uid();
end;
$$;

-- The boundary, not hygiene: Postgres grants EXECUTE to PUBLIC on every new function, and `anon`
-- inherits it — so an unrevoked definer function is a delete-anything endpoint for the open internet.
-- Revoke that inherited grant and hand EXECUTE to `authenticated` alone; this is the ONLY execute grant.
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- The FK the original `holdings_journal` table lacked (`email_subscribers` has one, `on delete
-- cascade`). RESTRICT, not cascade: a dashboard-side `auth.users` delete against a user WITH journal
-- rows must fail loudly rather than silently erase history — and the RPC's delete order above already
-- satisfies it. Without this FK an erased user's still-valid stateless JWT could re-insert orphan
-- rows under a dead uid before the token expires (~1 h).
alter table holdings_journal
  add constraint holdings_journal_user_fk
  foreign key (user_id) references auth.users (id) on delete restrict;
