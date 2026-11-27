-- crash-dash — atomic run write (architecture-review P4).
--
-- run.ts persisted a run as two independent PostgREST inserts: recordReadings then
-- recordAlert. If the alert insert failed after the readings insert succeeded, the
-- readings rows persisted orphaned — and getSeries (latest vintage per date) WOULD
-- surface that orphan, while /status (keyed off the latest alert) would not, so the
-- two endpoints could disagree about "latest". Orphans also accumulate silently.
--
-- record_run() does both inserts in one function call, which runs in a single
-- transaction: any error rolls back BOTH inserts, so a run is all-or-nothing. The
-- alert stays the commit point — there is now no window in which readings exist
-- without their alert.
--
-- Payloads are jsonb whose keys are the snake_case column names (the store builds
-- them from the same READINGS_COLS/ALERT_COLS maps used by every other query, so
-- the wire shape can't drift from the schema). An empty p_readings array inserts no
-- readings (matches recordReadings's empty no-op); the alert always records.
create or replace function record_run(p_readings jsonb, p_alert jsonb)
returns void
language plpgsql
security invoker
as $$
begin
  -- The column names below must stay in sync with READINGS_COLS / ALERT_COLS in
  -- store.ts: the p_readings/p_alert JSON keys are built from those maps, so a
  -- column rename means updating the map, the ALTER migration, AND this function.
  -- (A drift here hits a NOT NULL constraint = a loud failure, not a silent NaN.)
  insert into readings (obs_date, indicator_id, value, delta20, raw_state, state, run_at)
  select
    (r->>'obs_date')::date,
    r->>'indicator_id',
    (r->>'value')::double precision,
    (r->>'delta20')::double precision,
    r->>'raw_state',
    r->>'state',
    (r->>'run_at')::timestamptz
  from jsonb_array_elements(coalesce(p_readings, '[]'::jsonb)) as r;

  -- alert_log.obs_date is text (as-of date string), unlike readings.obs_date (date).
  -- pushed_at is null on a silent run: ->>'pushed_at' yields SQL NULL → ::timestamptz
  -- stays NULL, no CASE needed.
  insert into alert_log (obs_date, alert_level, fin, rate, geo_flags, coincident, fin_reds, fired_at, pushed_at)
  values (
    p_alert->>'obs_date',
    p_alert->>'alert_level',
    (p_alert->>'fin')::integer,
    (p_alert->>'rate')::integer,
    (p_alert->>'geo_flags')::integer,
    p_alert->>'coincident',
    (p_alert->>'fin_reds')::integer,
    (p_alert->>'fired_at')::timestamptz,
    (p_alert->>'pushed_at')::timestamptz
  );
end;
$$;

-- Reached server-side with the service key only, same posture as the base tables.
grant execute on function record_run(jsonb, jsonb) to service_role;
