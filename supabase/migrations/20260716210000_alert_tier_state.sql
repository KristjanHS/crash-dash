-- crash-dash — alert_log tier_state JSONB split + dead-column drop (Info-B3 + S3 + D11).
--
-- The off-ladder / display-only tier fields (slow, VIX-bottom, pension, and the 9 mode cells)
-- accreted as 20 individual nullable columns on alert_log — each with its own ADD COLUMN migration and
-- a per-field getLastBand path. They never feed the fast OK/WATCH/WARNING/CRITICAL verdict, so they are
-- pure display/notify-baseline state; folding them into a single `tier_state` jsonb column collapses the
-- surface to one column + one parametric jsonb read (store.ts 3.2). The alert AUDIT CORE (obs_date,
-- alert_level, fin, rate, geo_flags, coincident, fin_reds, fired_at, pushed_at, push_error, degraded,
-- band_reason) and the live decision-state columns (r4_*, dial_band, held_sleeve, rerisk_confirm_count,
-- held_days) STAY as real columns — out of scope here.
--
-- Two-step migration (this is step 1): the 20 legacy columns are KEPT and back-populated into
-- tier_state; the code (3.2) DUAL-WRITES (legacy keys + tier_state) and READS from tier_state only. A
-- SEPARATE future migration drops the legacy columns + the dual-write keys once the two-step window
-- closes — zero-risk rollback in the interim (old columns stay truthful).
--
-- NO record_run() re-create: since 20260716180000 the atomic write goes through
-- jsonb_populate_record(null::alert_log, v_alert), which maps a new JSON key (`tier_state`) to its
-- like-named column automatically and coerces it via the column's jsonb input type
-- (.claude/rules/migrations.md). So tier_state is picked up the moment this migration applies — the code
-- change (3.2) must never deploy BEFORE this migration (CI applies migrations on merge before/with the
-- Vercel deploy, so the ordering holds).

-- 1. The jsonb column that supersedes the 20 tier columns.
alter table alert_log add column if not exists tier_state jsonb;

-- 2. Backfill every existing row: build tier_state from the 20 columns (keys = column names).
--    jsonb_strip_nulls drops null-valued keys so a degraded/pre-migration cell is absent (not a
--    literal json null) — matching how the code writes it (strip on the way in) and keeping the
--    `tier_state->>'<key>' is null` read filter exact for both "never set" and "degraded to null".
update alert_log
set tier_state = jsonb_strip_nulls(jsonb_build_object(
  'slow_score',           slow_score,
  'slow_band',            slow_band,
  'bottom_state',         bottom_state,
  'vix',                  vix,
  'vix3m',                vix3m,
  'ratio',                ratio,
  'pension_band',         pension_band,
  'pension_dd',           pension_dd,
  'pension_us_dd',        pension_us_dd,
  'pension_nonus_dd',     pension_nonus_dd,
  'pension_nonus_source', pension_nonus_source,
  'mode_correction',      mode_correction,
  'mode_bear',            mode_bear,
  'mode_crash',           mode_crash,
  'spx_mode_correction',  spx_mode_correction,
  'spx_mode_bear',        spx_mode_bear,
  'spx_mode_crash',       spx_mode_crash,
  'eafe_mode_correction', eafe_mode_correction,
  'eafe_mode_bear',       eafe_mode_bear,
  'eafe_mode_crash',      eafe_mode_crash
));

-- 3. Legacy columns are KEPT (two-step; the drop is a separate future migration).

-- 4. Drop the dead `mode_channel_scores` column (added 20260703150000, never in ALERT_COLS/AlertRecord,
--    never written by code since the rank-8 record_run rewrite — verified: zero TS/JS references) —
--    but ONLY where no row ever carried data. PROD has historical non-null rows from the pre-rewrite
--    cron era (the original hard guard aborted the whole migration there, 2026-07-16 migrate-prod run),
--    so on a data-bearing DB the column is KEPT (data-precious: never drop real values; it can go with
--    the future step-2 legacy-column drop after an explicit archive decision). On an all-null DB
--    (local/CI) the drop proceeds as before.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'alert_log'
               and column_name = 'mode_channel_scores') then
    if exists (select 1 from alert_log where mode_channel_scores is not null) then
      raise notice 'mode_channel_scores has non-null rows on this DB — keeping the column (drop skipped)';
    else
      execute 'alter table alert_log drop column mode_channel_scores';
    end if;
  end if;
end
$$;
