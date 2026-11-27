-- crash-dash — Pension drawdown tier columns (pension-drawdown-track plan §7, Step 1).
--
-- A 4th isolated off-ladder track watching the user's developed-markets pension as
-- an EUR drawdown (US SPY + non-US VEA, each ÷ FRED DEXUSEU). Like the slow + bottom
-- tiers it is fully isolated — these columns never feed the fast FIN/RATE/GEO verdict.
--
-- NULLABLE on purpose and as a GROUP: the pension track degrades to a NULL verdict
-- (not CALM) when its SPY/VEA/DEXUSEU feed is down, in which case `pension_band` AND
-- all three drawdown numbers are written NULL together (run.ts: `pension ? … : null`),
-- so a degraded run stays distinguishable from a genuine CALM. `double precision`
-- matches the house decimal type (vix/vix3m/ratio in add_bottom_numbers; readings.value).
-- `if not exists` keeps re-runs / `db reset` idempotent (same posture as the bottom/slow
-- column migrations).
--
-- pension_band      — confirmed CALM/DIP/CORRECTION/BEAR band (the only field the notify tier compares).
-- pension_dd        — headline blended-portfolio (`P` series) drawdown, EUR. Read-only panel context.
-- pension_us_dd     — per-leg US (SPY) drawdown, EUR. Attribution only (the divergence read).
-- pension_nonus_dd  — per-leg non-US (VEA) drawdown, EUR. Attribution only.
alter table alert_log add column if not exists pension_band text;
alter table alert_log add column if not exists pension_dd double precision;
alter table alert_log add column if not exists pension_us_dd double precision;
alter table alert_log add column if not exists pension_nonus_dd double precision;

-- record_run() re-created to carry the four new alert columns through the atomic
-- write path (P4). The p_alert jsonb gains pension_* keys (built from ALERT_COLS in
-- store.ts), so the RPC and the direct recordAlert insert stay in sync. Signature is
-- unchanged (jsonb, jsonb) — only the alert INSERT column/value lists grow.
-- (p_alert->>'pension_dd')::double precision yields SQL NULL when the key is JSON null,
-- so a degraded run leaves the columns NULL (no CASE needed). All prior columns
-- (slow_score/slow_band/bottom_state/vix/vix3m/ratio) are preserved so this body stays
-- authoritative.
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

  insert into alert_log (obs_date, alert_level, fin, rate, geo_flags, coincident, fin_reds, fired_at, pushed_at, slow_score, slow_band, bottom_state, vix, vix3m, ratio, pension_band, pension_dd, pension_us_dd, pension_nonus_dd)
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
    (p_alert->>'pension_nonus_dd')::double precision
  );
end;
$$;

-- create or replace preserves the existing grant, but re-assert for a clean apply.
grant execute on function record_run(jsonb, jsonb) to service_role;
