-- crash-dash — persist the per-point DECISION VARIABLE at cron (Case 2, single-source-at-cron).
--
-- The 8 derived ids (F4/F5/F6/F8/G1/NVDA/CG/GT) score their state on a DERIVED quantity — a
-- trailing return, distance from a moving average, or distance from a rolling high of the
-- plotted `value` — not the stored level itself. That scalar was computed transiently at
-- cron to classify `state`, then discarded; the read path + the frontend each RE-derived it
-- (public/derived.js computeDerived, api/series.ts bespokeStateSeries), and the F6 re-score
-- divided by SPY twice (the ribbon-vs-line bug). This column captures the exact cron-time
-- scalar so the read path becomes a passthrough (Stages 2/3 delete the re-derivations).
--
-- Additive + nullable: `add column if not exists ... double precision` (no default → NULL).
-- NULL is the correct value for every non-derived id and for pre-migration rows — the FE
-- renders a null decision as a line gap (same as today). RLS is inherited from the readings
-- table-level policy (unchanged). `if not exists` keeps re-runs / `db reset` idempotent
-- (same posture as the dial_band / held_sleeve / rerisk column migrations).
alter table readings add column if not exists decision double precision;

-- readings_latest recreated to carry the new column (the view names columns explicitly, so a
-- bare ADD COLUMN would leave getSeries/checkSchema blind to it — the same trap the
-- record_run RPC has for alert_log). `decision` is appended at the END of the projection,
-- which `create or replace view` permits. security_invoker + the service_role grant are
-- re-asserted (idempotent) so the view keeps its 20260628073500 posture on a clean apply.
create or replace view readings_latest as
select distinct on (indicator_id, obs_date)
  obs_date,
  indicator_id,
  value,
  delta20,
  raw_state,
  state,
  run_at,
  decision
from readings
order by indicator_id, obs_date, run_at desc;

alter view readings_latest set (security_invoker = on);
grant select on readings_latest to service_role;

-- record_run() re-created to carry `decision` through the ATOMIC prod write path.
-- ⚠ LOAD-BEARING: a readings field NOT named in this INSERT silently drops to its column
-- default (NULL) through the prod write (the mode-cell / pension-column trap in
-- .claude/rules/migrations.md) — recordAlert/direct .insert() would hide the drift, only a
-- recordRun round-trip catches it. The full alert_log INSERT is preserved verbatim from
-- 20260714120000 so this body stays authoritative. Signature unchanged (jsonb, jsonb).
create or replace function record_run(p_readings jsonb, p_alert jsonb)
returns void
language plpgsql
security invoker
as $$
begin
  insert into readings (obs_date, indicator_id, value, delta20, raw_state, state, decision, run_at)
  select
    (r->>'obs_date')::date,
    r->>'indicator_id',
    (r->>'value')::double precision,
    (r->>'delta20')::double precision,
    r->>'raw_state',
    r->>'state',
    (r->>'decision')::double precision,
    (r->>'run_at')::timestamptz
  from jsonb_array_elements(coalesce(p_readings, '[]'::jsonb)) as r;

  insert into alert_log (obs_date, alert_level, fin, rate, geo_flags, coincident, fin_reds, fired_at, pushed_at, slow_score, slow_band, bottom_state, vix, vix3m, ratio, pension_band, pension_dd, pension_us_dd, pension_nonus_dd, pension_nonus_source, mode_correction, mode_bear, mode_crash, spx_mode_correction, spx_mode_bear, spx_mode_crash, eafe_mode_correction, eafe_mode_bear, eafe_mode_crash, mode_channel_scores, r4_phase, r4_entry_fired_at, r4_reentry_rung, dial_band, held_sleeve, rerisk_confirm_count)
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
    p_alert->'mode_channel_scores',
    p_alert->>'r4_phase',
    (p_alert->>'r4_entry_fired_at')::timestamptz,
    (p_alert->>'r4_reentry_rung')::integer,
    p_alert->>'dial_band',
    p_alert->>'held_sleeve',
    coalesce((p_alert->>'rerisk_confirm_count')::integer, 0)
  );
end;
$$;

-- create or replace preserves the existing grant, but re-assert for a clean apply.
grant execute on function record_run(jsonb, jsonb) to service_role;
