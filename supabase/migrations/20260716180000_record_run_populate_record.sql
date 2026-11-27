-- crash-dash — record_run rewritten on jsonb_populate_record (audit rank 8).
--
-- The old body named every alert_log column in an explicit INSERT and pulled each value with
-- p_alert->>'key' — any column its newest re-create didn't name was SILENTLY dropped to NULL through
-- the prod write path (this is how all 9 mode-cell columns persisted NULL for weeks). Every ADD COLUMN
-- migration therefore had to re-create this function by hand (.claude/rules/migrations.md).
--
-- This rewrite retires that hand-sync class entirely:
--   * jsonb_populate_record(null::alert_log, ...) / jsonb_populate_recordset(null::readings, ...)
--     map JSON keys → columns by name and coerce via each column's input type, so a future
--     ADD COLUMN is picked up automatically — no record_run re-create needed.
--   * The silent-IGNORE direction of the same trap (a misspelled key in alertRow()/readingRow()
--     simply vanishing) is closed with a fail-loud guard: any p_alert / p_readings key that is not
--     an actual column RAISEs, naming the offender.
--   * OVERRIDING USER VALUE lets the populated record's NULL id defer to the identity sequence
--     (both tables use `generated always as identity`).
--   * Top-level null-valued keys are dropped before populating so `not null default 0` columns
--     (rerisk_confirm_count, held_days) keep their defaults when a caller sends null/omits them —
--     the coalesce(...,0) posture of the old body. A dropped key populates NULL anyway for nullable
--     columns (pushed_at etc.), so behavior there is unchanged. Only TOP-LEVEL nulls are filtered:
--     jsonb_strip_nulls would also strip nulls nested inside `degraded`/`mode_channel_scores`.
--
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

  insert into alert_log overriding user value
  select * from jsonb_populate_record(null::alert_log, v_alert);
end;
$$;

-- create or replace preserves the existing grant, but re-assert for a clean apply.
grant execute on function record_run(jsonb, jsonb) to service_role;
