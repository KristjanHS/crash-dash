-- crash-dash — slow "bubble-state" tier columns (Phase 3 Stage 1B).
--
-- The slow track (src/slow.ts) is a mechanical Minsky/Kindleberger bubble-fuel
-- composite, fully ISOLATED from the fast OK/WATCH/WARNING/CRITICAL ladder. It has
-- its own band (CALM/ELEVATED/DE-RISK) and its own ntfy tier. notify-on-band-change
-- needs the PRIOR run's band, so every run records the composite score + band here.
--
-- Both columns are NULLABLE on purpose: the slow track degrades to a NULL verdict
-- (not CALM) when its feed (QQQ / VIXCLS) is down, so a degraded run is
-- distinguishable from a genuine CALM. `if not exists` keeps re-runs / `db reset`
-- idempotent (same posture as add_pushed_at).
alter table alert_log add column if not exists slow_score integer;
alter table alert_log add column if not exists slow_band  text;

-- record_run() re-created to carry the two new alert columns through the atomic
-- write path (P4). The p_alert jsonb gains slow_score / slow_band keys (built from
-- ALERT_COLS in store.ts), so the RPC and the direct recordAlert insert stay in
-- sync. Signature is unchanged (jsonb, jsonb) — only the alert INSERT column list
-- and value list grow. ->>'slow_score' yields SQL NULL when the key is JSON null,
-- so ::integer stays NULL (no CASE needed); slow_band stays text.
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

  insert into alert_log (obs_date, alert_level, fin, rate, geo_flags, coincident, fin_reds, fired_at, pushed_at, slow_score, slow_band)
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
    p_alert->>'slow_band'
  );
end;
$$;

-- create or replace preserves the existing grant, but re-assert for a clean apply.
grant execute on function record_run(jsonb, jsonb) to service_role;
