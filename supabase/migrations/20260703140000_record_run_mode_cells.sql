-- crash-dash — carry the per-cell mode columns through the atomic write RPC.
--
-- BUG (2026-07-03): 20260702160000_alert_mode_cells.sql + 20260703120000_alert_market_cells.sql
-- added the 9 (market, mode) columns to alert_log with a bare ALTER TABLE but did NOT
-- re-create record_run() to write them — unlike every prior column-adding migration
-- (slow/bottom/pension each re-created the RPC). run.ts computed the cells and store.ts
-- serialised them into p_alert, but the RPC's INSERT column list stopped at
-- pension_nonus_dd, so the extra JSON keys were silently dropped and every mode column
-- persisted NULL. The read-API returned them as null, and the UI (marketCellsPresent →
-- showTabs) hid the NDX/SPX/EAFE market tabs and mode strip entirely.
--
-- Fix: re-create record_run() with the 9 mode columns appended to both the INSERT column
-- list and the VALUES list (all text — the persisted ladder level, e.g. 'WATCH'). No
-- backfill: rows written before this migration keep their NULL cells and degrade silently
-- (display-only, never notifies). The next cron run writes non-null cells and the tabs
-- appear. This restores the ALERT_COLS ⇄ RPC invariant the RPC comment requires.
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

  insert into alert_log (obs_date, alert_level, fin, rate, geo_flags, coincident, fin_reds, fired_at, pushed_at, slow_score, slow_band, bottom_state, vix, vix3m, ratio, pension_band, pension_dd, pension_us_dd, pension_nonus_dd, mode_correction, mode_bear, mode_crash, spx_mode_correction, spx_mode_bear, spx_mode_crash, eafe_mode_correction, eafe_mode_bear, eafe_mode_crash)
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
    p_alert->>'eafe_mode_crash'
  );
end;
$$;

-- create or replace preserves the existing grant, but re-assert for a clean apply.
grant execute on function record_run(jsonb, jsonb) to service_role;
