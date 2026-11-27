-- crash-dash — Stage 1 (Decision D1):
-- persist the per-(market, mode) channel scores (fin/rate/geoFlags/finReds) latest-only.
--
-- run.ts already computes a per-cell Verdict at the mode-cell loop (task 4/5) but today
-- only its `.level` is kept (the mode_*/spx_mode_*/eafe_mode_* band columns). The
-- fin/rate/geoFlags/finReds numbers behind each cell's band are computed and discarded.
-- This is a lossless, zero-new-compute capture of that SAME already-computed value: ONE
-- nullable jsonb column, keyed Record<Market, Record<ModeCell, {fin,rate,geoFlags,finReds}>>
-- (coincident omitted — mode-invariant/off-map). Nullable ⇒ no backfill; historical rows
-- stay NULL, read back as "fall back to main verdict" (frontend contract, Stage 2/3).
--
-- Mirrors 20260703140000_record_run_mode_cells.sql: re-create record_run() with the new
-- column appended, preserving every existing column verbatim — `create or replace
-- function` swaps the WHOLE body, so dropping one here would silently NULL it in prod,
-- the exact 2026-07-03 record_run_mode_cells bug this migration must not repeat.
alter table alert_log add column mode_channel_scores jsonb;

create or replace function record_run(p_readings jsonb, p_alert jsonb)
returns void
language plpgsql
security invoker
as $$
begin
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

  insert into alert_log (obs_date, alert_level, fin, rate, geo_flags, coincident, fin_reds, fired_at, pushed_at, slow_score, slow_band, bottom_state, vix, vix3m, ratio, pension_band, pension_dd, pension_us_dd, pension_nonus_dd, mode_correction, mode_bear, mode_crash, spx_mode_correction, spx_mode_bear, spx_mode_crash, eafe_mode_correction, eafe_mode_bear, eafe_mode_crash, mode_channel_scores)
  values (
    p_alert->>'obs_date',
    p_alert->>'alert_level',
    (p_alert->>'fin')::integer,
    (p_alert->>'rate')::integer,
    (p_alert->>'geo_flags')::integer,
    p_alert->>'coincident',
    (p_alert->>'fin_reds')::integer,
    (p_alert->>'fired_at')::timestamptz,
    (p_alert->>'pushed_at')::timestamptz,
    (p_alert->>'slow_score')::integer,
    p_alert->>'slow_band',
    p_alert->>'bottom_state',
    (p_alert->>'vix')::double precision,
    (p_alert->>'vix3m')::double precision,
    (p_alert->>'ratio')::double precision,
    p_alert->>'pension_band',
    (p_alert->>'pension_dd')::double precision,
    (p_alert->>'pension_us_dd')::double precision,
    (p_alert->>'pension_nonus_dd')::double precision,
    p_alert->>'mode_correction',
    p_alert->>'mode_bear',
    p_alert->>'mode_crash',
    p_alert->>'spx_mode_correction',
    p_alert->>'spx_mode_bear',
    p_alert->>'spx_mode_crash',
    p_alert->>'eafe_mode_correction',
    p_alert->>'eafe_mode_bear',
    p_alert->>'eafe_mode_crash',
    p_alert->'mode_channel_scores'
  );
end;
$$;

-- create or replace preserves the existing grant, but re-assert for a clean apply.
grant execute on function record_run(jsonb, jsonb) to service_role;
