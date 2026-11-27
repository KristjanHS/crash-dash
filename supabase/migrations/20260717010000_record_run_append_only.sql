-- crash-dash — record_run append-only: every run keeps its own alert_log row.
--
-- This REVERSES the same-day replace introduced by 20260717000000_record_run_same_day_replace.sql
-- (c84abee): that redefinition made record_run atomically DELETE any alert_log row(s) whose
-- fired-date (UTC) equalled the incoming row's fired-date before inserting, so a manual intraday
-- re-run replaced the day's earlier row instead of appending. alert_log is an irreplaceable audit
-- trail and a delete-on-write path is not an acceptable shape for it;
-- append-only is restored here and the read layer resolves the duplicates instead.
--
-- HISTORY — what the same-date key meant, and why it is gone. Recorded because it explains the
-- shape being removed, NOT as a live rule; nothing below is enforced any more:
--
--   * The key was the FIRED-AT date, NOT obs_date. An intraday run before the 21:05 UTC same-day-bar
--     cutoff carries YESTERDAY's obs_date (price parsers drop today's provisional bar), so a
--     replace-by-obs_date would have deleted yesterday's legitimate close row. Any future dedup —
--     including the read-layer collapse that replaces this delete — inherits that reasoning: it must
--     key on fired-date, never obs_date.
--   * Both sides of the predicate carried an explicit `at time zone 'utc'` cast, because a bare
--     `fired_at::date` casts in the session timezone and the cluster default is not to be trusted.
--   * Readings rows never got dedup at all — readings_latest already picks max run_at per
--     (indicator_id, obs_date); orphaned same-day reading vintages are accepted.
--     That is unchanged by this migration.
--
-- The correctness burden the delete used to carry (one logical state per UTC date, so hold-counting
-- and re-risk streaks don't double-count a day) moves to the reads. HALF of that is already true and
-- half is OWED — do not read the two clauses as one shipped fact:
--   * TRUE TODAY: the `.limit(1)` prev-state reads (getLastAlertBefore / getLastBandBefore ->
--     lastNonNullBand) resolve to max fired_at within a date. Proven live against Postgres by
--     Stage 1.1's fixture; this migration's own falsifier re-proves them over a recordRun-seeded one.
--   * OWED (Stage 1.3, NOT shipped by this migration): the multi-row reads (getRecentAlerts /
--     getAlertsSince) still return EVERY row, so they now serve N rows per UTC date. Until 1.3
--     collapses them to max fired_at per date, /api/history renders same-date duplicates after any
--     manual re-run and the lab's D9 time-in-cash guardrail can double-count a day.
--
-- Body otherwise identical to 20260717000000_record_run_same_day_replace.sql with ONLY the
-- `delete from alert_log where (fired_at at time zone 'utc')::date = ...` block removed
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

  -- Append-only: no delete. Every run's alert row stands; the reads resolve same-date duplicates.
  insert into alert_log overriding user value
  select * from jsonb_populate_record(null::alert_log, v_alert);
end;
$$;

-- create or replace preserves the existing grant, but re-assert for a clean apply.
grant execute on function record_run(jsonb, jsonb) to service_role;
