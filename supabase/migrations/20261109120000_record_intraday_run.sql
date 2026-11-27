-- crash-dash — record_intraday_run: an intraday run's readings AND its `intraday_verdict` slot in ONE
-- transaction, the intraday twin of `record_run` (readings + alert_log).
--
-- Why: the slot used to be a separate best-effort upsert AFTER the readings insert, the estimate rows
-- and two roster sweeps — on prod 2026-11-09 it landed > 30 s after the readings, and a failed upsert left
-- the board a MIXED VINTAGE (new readings beside an older run's verdict). Committed together, both land
-- or neither does, and the slot's `run_at` is the intraday run's commit marker (scripts/smoke-cron.sh).
--
-- `rederive=0` (readings only) does NOT use this function: it keeps `recordReadings` + the slot clear.
-- Readings guard copied verbatim from record_run (unknown key ⇒ loud raise). New function, additive.
-- destructive: reviewed the `on conflict … do update` overwrites only the singleton intraday_verdict cache row, exactly as SupabaseStore.putIntradayVerdict's upsert already does on every intraday run; no audit data is touched, so no snapshot precedes it
create or replace function record_intraday_run(p_readings jsonb, p_run_at timestamptz, p_slot jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  bad_keys text;
begin
  select string_agg(distinct k, ', ') into bad_keys
  from jsonb_array_elements(coalesce(p_readings, '[]'::jsonb)) as r,
       jsonb_object_keys(r) as k
  where k not in (
    select attname from pg_attribute
    where attrelid = 'readings'::regclass and attnum > 0 and not attisdropped
  );
  if bad_keys is not null then
    raise exception 'record_intraday_run: unknown readings key(s): %', bad_keys;
  end if;

  insert into readings overriding user value
  select * from jsonb_populate_recordset(null::readings, coalesce(p_readings, '[]'::jsonb));

  -- `row` is NOT NULL: a null slot raises here and rolls the readings back with it.
  insert into intraday_verdict (id, run_at, row) values (true, p_run_at, p_slot)
  on conflict (id) do update set run_at = excluded.run_at, row = excluded.row;
end;
$$;

grant execute on function record_intraday_run(jsonb, timestamptz, jsonb) to service_role;
