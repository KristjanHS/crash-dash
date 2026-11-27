-- crash-dash — raw T1-dial band column (alert-engine Slice 3, Stage 3.5).
--
-- The Slice-3 alert engine derives the ntfy band from the T1 dial and applies a de-escalation
-- lag: a lower dial band must hold N=2 consecutive runs before the alert steps down. The lag
-- counts consecutive runs where the RAW dial band (`regimeToBand(dial.regime)`, before the
-- escalator floor) is low — but only the FINAL `alert_level` (`max(lag, floor)`) is persisted
-- today, and while an escalator floor holds the band up a dropping dial is invisible to history.
-- Persist the raw dial band so the lag state is recoverable. Additive + nullable (RLS inherited
-- from alert_log's table-level policy); this is the SOLE migration Slice 3 needs (decision #3).
--
-- NULLABLE: pre-migration rows and degraded (no-dial) runs read back null — the lag then treats
-- them as "no prior low read" and the band applies directly (fail-safe: never a phantom hold).
-- `if not exists` keeps re-runs / `db reset` idempotent (same posture as the r4/pension/slow
-- column migrations).
alter table alert_log add column if not exists dial_band text;

-- record_run() re-created to carry the new alert column through the atomic write path.
-- ⚠ LOAD-BEARING: a new alert field NOT named in this INSERT silently drops to NULL through the
-- prod write (the mode-cell / pension-column trap in .claude/rules/migrations.md). All prior
-- columns are preserved so this body stays authoritative. Signature unchanged (jsonb, jsonb) —
-- only the alert INSERT lists grow. `p_alert->>'dial_band'` yields SQL NULL when the key is JSON
-- null, so a degraded run leaves the column NULL (no CASE needed).
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

  insert into alert_log (obs_date, alert_level, fin, rate, geo_flags, coincident, fin_reds, fired_at, pushed_at, slow_score, slow_band, bottom_state, vix, vix3m, ratio, pension_band, pension_dd, pension_us_dd, pension_nonus_dd, pension_nonus_source, mode_correction, mode_bear, mode_crash, spx_mode_correction, spx_mode_bear, spx_mode_crash, eafe_mode_correction, eafe_mode_bear, eafe_mode_crash, mode_channel_scores, r4_phase, r4_entry_fired_at, r4_reentry_rung, dial_band)
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
    p_alert->>'dial_band'
  );
end;
$$;

-- create or replace preserves the existing grant, but re-assert for a clean apply.
grant execute on function record_run(jsonb, jsonb) to service_role;
