-- crash-dash — auto-hold held-sleeve column (alert-engine Slice 3, i7a).
--
-- The Slice-3 i7 auto-hold computes the calmest-in-band leg ("held sleeve") from the per-leg
-- danger field each run and pushes it to ntfy on change. Persist the held sleeve so the
-- on-held-change push can dedup against the last pushed sleeve (mirror of the dial_band /
-- pushed_at persist-before-notify INTENT pattern). Additive + nullable (RLS inherited from
-- alert_log's table-level policy).
--
-- NULLABLE: pre-migration rows and degraded (no-field) runs read back null — the dedup then
-- treats them as "no prior hold" and the first computed sleeve pushes (fail-safe: never a
-- phantom suppression). `if not exists` keeps re-runs / `db reset` idempotent (same posture as
-- the dial_band / r4 / pension column migrations).
alter table alert_log add column if not exists held_sleeve text;

-- record_run() re-created to carry the new alert column through the atomic write path.
-- ⚠ LOAD-BEARING: a new alert field NOT named in this INSERT silently drops to NULL through the
-- prod write (the mode-cell / pension-column trap in .claude/rules/migrations.md). All prior
-- columns are preserved so this body stays authoritative. Signature unchanged (jsonb, jsonb) —
-- only the alert INSERT lists grow. `p_alert->>'held_sleeve'` yields SQL NULL when the key is JSON
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

  insert into alert_log (obs_date, alert_level, fin, rate, geo_flags, coincident, fin_reds, fired_at, pushed_at, slow_score, slow_band, bottom_state, vix, vix3m, ratio, pension_band, pension_dd, pension_us_dd, pension_nonus_dd, pension_nonus_source, mode_correction, mode_bear, mode_crash, spx_mode_correction, spx_mode_bear, spx_mode_crash, eafe_mode_correction, eafe_mode_bear, eafe_mode_crash, mode_channel_scores, r4_phase, r4_entry_fired_at, r4_reentry_rung, dial_band, held_sleeve)
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
    p_alert->>'held_sleeve'
  );
end;
$$;

-- create or replace preserves the existing grant, but re-assert for a clean apply.
grant execute on function record_run(jsonb, jsonb) to service_role;
