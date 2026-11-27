-- crash-dash — persist WHICH instrument the displayed non-US drawdown was quoted from.
--
-- b4f5a74 pointed `pension_nonus_dd` at the user's actual holding (CHSI.DE) while the
-- band + `pension_dd` stayed on the SPY/VEA spine. The read-API had no way to say which
-- of the two produced the number, so the UI captioned CHSI's drawdown "Non-US (VEA, EUR)"
-- beside a VEA sparkline. Those two funds are NOT interchangeable: VEA tracks FTSE
-- Developed ex-US (Korea = developed), CHSI tracks MSCI World ex USA (Korea = emerging),
-- and over 2025-03→2026-07 that single classification split them by 5.6%/yr.
--
-- `ddNonus` degrades back to the raw VEA proxy whenever the Xetra feed has no close at or
-- before the verdict's asOf (tracks.ts scores the holding in its own try/catch), so the
-- source is a per-RUN fact, not a constant — it has to be persisted next to the number it
-- describes. Historical rows read back NULL, which the UI renders as the proxy label.
--
-- pension_nonus_source — 'CHSI' | 'VEA', or NULL on a degraded run / pre-migration row.
--   Grouped with the other pension_* columns: written NULL together when the verdict is null.
alter table alert_log add column if not exists pension_nonus_source text;

-- record_run() re-created with the new column appended to BOTH the INSERT column list and
-- the VALUES list. `create or replace function` swaps the WHOLE body, so every existing
-- column is preserved verbatim below — dropping one here would silently NULL it in prod,
-- which is exactly the 2026-07-03 record_run_mode_cells bug (a bare ADD COLUMN shipped a
-- column the prod write path never filled, and all 9 mode cells persisted NULL).
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

  insert into alert_log (obs_date, alert_level, fin, rate, geo_flags, coincident, fin_reds, fired_at, pushed_at, slow_score, slow_band, bottom_state, vix, vix3m, ratio, pension_band, pension_dd, pension_us_dd, pension_nonus_dd, pension_nonus_source, mode_correction, mode_bear, mode_crash, spx_mode_correction, spx_mode_bear, spx_mode_crash, eafe_mode_correction, eafe_mode_bear, eafe_mode_crash, mode_channel_scores)
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
    p_alert->>'pension_nonus_source',
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
