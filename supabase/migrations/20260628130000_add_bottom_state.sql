-- crash-dash — VIX bottom-signal tier column (vix-bottom-signal plan Stage 3).
--
-- The bottom track (src/bottom.ts) is a third, fully ISOLATED off-ladder track: it
-- reads the SAME instrument (VIX) in the OPPOSITE direction from the fast ladder's
-- R5 risk modifier — an extreme, peaking-and-receding VIX is a capitulation /
-- exhaustion marker ("fear may be peaking — downside risk remains", never "buy").
-- It has its own state (CALM/CAPITULATION-WATCH/BOTTOM-FORMING) and its own ntfy
-- tier. notify-on-upward-state-change needs the PRIOR run's state, so every run
-- records the confirmed state here.
--
-- NULLABLE on purpose: the bottom track degrades to a NULL verdict (not CALM) when
-- its feed (^VIX / ^VIX3M) is down, so a degraded run is distinguishable from a
-- genuine CALM. `if not exists` keeps re-runs / `db reset` idempotent (same posture
-- as add_slow_columns).
alter table alert_log add column if not exists bottom_state text;

-- record_run() re-created to carry the new alert column through the atomic write
-- path (P4). The p_alert jsonb gains a bottom_state key (built from ALERT_COLS in
-- store.ts), so the RPC and the direct recordAlert insert stay in sync. Signature is
-- unchanged (jsonb, jsonb) — only the alert INSERT column list and value list grow.
-- ->>'bottom_state' yields SQL NULL when the key is JSON null, so the text column
-- stays NULL (no CASE needed). The slow_score/slow_band columns from the prior
-- migration are preserved here so this single function body stays authoritative.
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

  insert into alert_log (obs_date, alert_level, fin, rate, geo_flags, coincident, fin_reds, fired_at, pushed_at, slow_score, slow_band, bottom_state)
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
    p_alert->>'bottom_state'
  );
end;
$$;

-- create or replace preserves the existing grant, but re-assert for a clean apply.
grant execute on function record_run(jsonb, jsonb) to service_role;
