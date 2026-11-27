-- crash-dash — held-leg min-dwell counter (M7).
--
-- The asymmetric min-dwell design (M7) blocks a re-risk rotation until the auto-held leg has
-- survived RERISK_DWELL_DAYS (=10) trading closes since it last changed. `run.ts` runs the small
-- commit machine (src/rotation-commit.ts `decideHold`) each cron close and needs a persisted counter
-- to accumulate the dwell across runs (mirror of the rerisk_confirm_count precedent, 20260714120000).
-- The counter ticks once per NEW trading close and resets to 0 whenever the held leg changes.
--
-- Additive + defaulted: `add column if not exists ... integer not null default 0` backfills every
-- pre-migration row to 0, so the FIRST post-deploy re-risk waits a full 10 closes — conservative by
-- design (mirror of the "deployed != run" empty-card discipline), not a bug. No run reads back a null
-- counter, so the dwell arithmetic in rotation-commit.ts is always over a real integer. RLS inherited
-- from alert_log's table-level policy (unchanged). `if not exists` keeps re-runs / `db reset`
-- idempotent (same posture as the rerisk_confirm_count / dial_band / held_sleeve migrations).
alter table alert_log add column if not exists held_days integer not null default 0;

-- record_run() re-created to carry the new alert column through the atomic write path.
-- ⚠ LOAD-BEARING: a new alert field NOT named in this INSERT silently drops to its column default
-- through the prod write (the mode-cell / pension-column trap in .claude/rules/migrations.md). All
-- prior columns are preserved so this body stays authoritative. Signature unchanged (jsonb, jsonb).
-- `coalesce(..., 0)` guards the NOT-NULL column against a degraded run whose payload omits the key
-- (run.ts always writes 0 for a dial-less run, but the coalesce keeps the write total).
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

  insert into alert_log (obs_date, alert_level, fin, rate, geo_flags, coincident, fin_reds, fired_at, pushed_at, slow_score, slow_band, bottom_state, vix, vix3m, ratio, pension_band, pension_dd, pension_us_dd, pension_nonus_dd, pension_nonus_source, mode_correction, mode_bear, mode_crash, spx_mode_correction, spx_mode_bear, spx_mode_crash, eafe_mode_correction, eafe_mode_bear, eafe_mode_crash, mode_channel_scores, r4_phase, r4_entry_fired_at, r4_reentry_rung, dial_band, held_sleeve, rerisk_confirm_count, held_days)
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
    coalesce((p_alert->>'rerisk_confirm_count')::integer, 0),
    coalesce((p_alert->>'held_days')::integer, 0)
  );
end;
$$;

-- create or replace preserves the existing grant, but re-assert for a clean apply.
grant execute on function record_run(jsonb, jsonb) to service_role;
