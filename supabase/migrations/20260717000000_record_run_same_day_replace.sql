-- crash-dash — record_run same-day replace: last run of the day wins.
--
-- The rank-3 same-day no-op guard was removed (8a48172), so a manual intraday re-run inserts a
-- duplicate alert_log row for the same fired-day, corrupting deEscalationLag hold-counting and
-- re-risk streak semantics. This redefinition makes record_run atomically DELETE any alert_log
-- row(s) whose fired-date (UTC) equals the incoming row's fired-date before inserting.
--
--   * Key is the FIRED-AT date, NOT obs_date: an intraday run before the 21:05 UTC same-day-bar
--     cutoff carries yesterday's obs_date (price parsers drop today's provisional bar), so
--     replace-by-obs_date would delete yesterday's legitimate close row.
--   * Explicit `at time zone 'utc'` on BOTH sides — a bare `fired_at::date` casts in the session
--     timezone; never rely on the cluster default.
--   * Readings rows get NO dedup — readings_latest already picks max run_at per
--     (indicator_id, obs_date); orphaned same-day reading vintages are accepted.
--
-- Body otherwise identical to 20260716180000_record_run_populate_record.sql
-- (jsonb_populate_record insert, fail-loud column guard, counter-column defaults).
-- Signature unchanged (jsonb, jsonb). RLS/grants unchanged (security invoker + service_role grant).
create or replace function record_run(p_readings jsonb, p_alert jsonb)
returns void
language plpgsql
security invoker
as $$
declare
  bad_keys text;
  v_alert jsonb;
begin
  select string_agg(k, ', ') into bad_keys
  from jsonb_object_keys(coalesce(p_alert, '{}'::jsonb)) as k
  where k not in (
    select attname from pg_attribute
    where attrelid = 'alert_log'::regclass and attnum > 0 and not attisdropped
  );
  if bad_keys is not null then
    raise exception 'record_run: unknown alert_log key(s): %', bad_keys;
  end if;

  select string_agg(distinct k, ', ') into bad_keys
  from jsonb_array_elements(coalesce(p_readings, '[]'::jsonb)) as r,
       jsonb_object_keys(r) as k
  where k not in (
    select attname from pg_attribute
    where attrelid = 'readings'::regclass and attnum > 0 and not attisdropped
  );
  if bad_keys is not null then
    raise exception 'record_run: unknown readings key(s): %', bad_keys;
  end if;

  insert into readings overriding user value
  select * from jsonb_populate_recordset(null::readings, coalesce(p_readings, '[]'::jsonb));

  -- Drop top-level nulls, then seed defaults for the not-null counter columns.
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_alert
  from jsonb_each(coalesce(p_alert, '{}'::jsonb))
  where value <> 'null'::jsonb;
  v_alert := jsonb_build_object('rerisk_confirm_count', 0, 'held_days', 0) || v_alert;

  -- Same-day replace: one alert_log row per UTC fired-date, last run wins.
  delete from alert_log
  where (fired_at at time zone 'utc')::date
      = ((p_alert->>'fired_at')::timestamptz at time zone 'utc')::date;

  insert into alert_log overriding user value
  select * from jsonb_populate_record(null::alert_log, v_alert);
end;
$$;

-- create or replace preserves the existing grant, but re-assert for a clean apply.
grant execute on function record_run(jsonb, jsonb) to service_role;
