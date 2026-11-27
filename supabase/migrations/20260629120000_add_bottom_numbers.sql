-- crash-dash — VIX bottom-signal tier numbers (vix-bottom-signal plan Stage 5).
--
-- Stage 3 (20260628130000) added only `bottom_state`. Stage 5 surfaces the LIVE
-- VIX level & term-structure ratio that drive that state on the dashboard panel +
-- read API (/qimpag numbers-fork → option (b), 2026-06-29), so the three numbers
-- behind the state must be persisted alongside it. They are read-only context for
-- the panel — the state itself remains the only thing the notify tier compares.
--
-- NULLABLE on purpose and as a GROUP: the bottom track degrades to a NULL verdict
-- (not CALM) when its ^VIX/^VIX3M feed is down, in which case `bottom_state` AND all
-- three numbers are written NULL together (run.ts: `bottom ? bottom.vix : null`), so
-- a degraded run stays distinguishable from a genuine CALM. `double precision` matches
-- the readings.value column type. `if not exists` keeps re-runs / `db reset`
-- idempotent (same posture as add_bottom_state / add_slow_columns).
alter table alert_log add column if not exists vix double precision;
alter table alert_log add column if not exists vix3m double precision;
alter table alert_log add column if not exists ratio double precision;

-- record_run() re-created to carry the three new alert columns through the atomic
-- write path (P4). The p_alert jsonb gains vix/vix3m/ratio keys (built from ALERT_COLS
-- in store.ts), so the RPC and the direct recordAlert insert stay in sync. Signature
-- is unchanged (jsonb, jsonb) — only the alert INSERT column/value lists grow.
-- (p_alert->>'vix')::double precision yields SQL NULL when the key is JSON null, so a
-- degraded run leaves the columns NULL (no CASE needed). All prior columns
-- (slow_score/slow_band/bottom_state) are preserved so this body stays authoritative.
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

  insert into alert_log (obs_date, alert_level, fin, rate, geo_flags, coincident, fin_reds, fired_at, pushed_at, slow_score, slow_band, bottom_state, vix, vix3m, ratio)
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
    (p_alert->>'ratio')::double precision
  );
end;
$$;

-- create or replace preserves the existing grant, but re-assert for a clean apply.
grant execute on function record_run(jsonb, jsonb) to service_role;
