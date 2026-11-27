-- Clears every WARN+ finding of `supabase db advisors --type all`, pinned by
-- scripts/rls-live.test.ts. Behaviour-preserving: no data touched, same rows visible to every role.

-- security_definer_view: re-check the reader's RLS on base `calibration` (anon already holds its read policy).
alter view calibration_latest set (security_invoker = on);

-- function_search_path_mutable: pin to the schema every body already resolves against.
alter function record_run(jsonb, jsonb) set search_path = public;
alter function alert_log_recent(int) set search_path = public;
alter function prune_shadowed_readings(text[], integer, boolean, timestamptz) set search_path = public;
alter function readings_newest(text[]) set search_path = public;
alter function readings_newest_n(text[], int, date, date) set search_path = public;

-- auth_rls_initplan: wrap auth.uid()/current_setting() in a scalar subquery so it evaluates once per statement.
alter policy holdings_journal_owner_read on holdings_journal using (user_id = (select auth.uid()));
alter policy holdings_journal_owner_insert on holdings_journal with check (user_id = (select auth.uid()));
alter policy email_subscribers_owner_read on email_subscribers using (user_id = (select auth.uid()));
alter policy email_subscribers_owner_insert on email_subscribers
  with check (user_id = (select auth.uid()) and email = ((select current_setting('request.jwt.claims', true))::jsonb ->> 'email'));
alter policy email_subscribers_owner_update on email_subscribers
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and email = ((select current_setting('request.jwt.claims', true))::jsonb ->> 'email'));
alter policy email_subscribers_owner_delete on email_subscribers using (user_id = (select auth.uid()));
alter policy trading_rules_owner_read on trading_rules using (user_id = (select auth.uid()));
alter policy trading_rules_owner_insert on trading_rules with check (user_id = (select auth.uid()));
