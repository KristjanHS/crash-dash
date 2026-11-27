-- crash-dash — R4 cash-breaker state columns (r4-cash-breaker plan Stage 2.1).
--
-- R4 = the extreme-only circuit-breaker layered OVER the 1–9 T1 dial: cash is a genuine
-- ladder state reached only past rung 9 (hardest-to-enter / easiest-to-exit). Its state is
-- persisted on every run so the next run reads the prior phase (the 3-close arming counter
-- is encoded in the `r4_phase` text as arm1/arm2 — no 4th counter column, decision #1).
--
-- ⚠ HISTORY as of NF-1(A) (2026-07-26): the sentence above records what was true when this
-- migration was written. The 3-close arming ladder is DELETED — the breaker enters on the
-- FIRST qualifying close, and the live phase set is `equity → cash → re-entry`. `r4_phase`
-- is plain `text` with no CHECK, so prod rows written before that date still carry the
-- retired `arm1`/`arm2`; `hydrateR4Phase` (src/r4.ts) narrows them to `equity` at the read
-- seam. This is a COMMENT-ONLY amendment — the DDL below is byte-unchanged and unapplied.
--
-- NULLABLE as a GROUP: a pre-migration/degraded run (no dial, or F1/VT feed down) writes all
-- three NULL together (run.ts leaves the literal null), and the next run's
-- `prior.phase = r4_phase ?? 'equity'` recovers. Notify-only to /lab — these never feed the
-- fast FIN/RATE/GEO verdict. `if not exists` keeps re-runs / `db reset` idempotent (same
-- posture as the pension/bottom/slow column migrations).
--
-- r4_phase           — equity/cash/reentry since NF-1(A) (historical rows: also arm1/arm2). The only
--                      field the /lab breaker reads (cash === 'cash').
-- r4_entry_fired_at  — ISO instant the run entered cash. Anchors the 20-day idle-cash ratchet.
-- r4_reentry_rung    — the on-ladder rung a laddered re-entry currently holds (9→target); null off-reentry.
alter table alert_log add column if not exists r4_phase text;
alter table alert_log add column if not exists r4_entry_fired_at timestamptz;
alter table alert_log add column if not exists r4_reentry_rung integer;

-- record_run() re-created to carry the three new alert columns through the atomic write
-- path. ⚠ LOAD-BEARING: a new alert field NOT named in this INSERT silently drops to NULL
-- through the prod write (the mode-cell / pension-column trap in .claude/rules/migrations.md).
-- (p_alert->>'r4_entry_fired_at')::timestamptz yields SQL NULL when the key is JSON null, so a
-- degraded run leaves the columns NULL (no CASE needed). ALL prior columns
-- (slow/bottom/vix/pension/mode/mode_channel_scores) are preserved so this body stays
-- authoritative. Signature unchanged (jsonb, jsonb) — only the alert INSERT lists grow.
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

  insert into alert_log (obs_date, alert_level, fin, rate, geo_flags, coincident, fin_reds, fired_at, pushed_at, slow_score, slow_band, bottom_state, vix, vix3m, ratio, pension_band, pension_dd, pension_us_dd, pension_nonus_dd, pension_nonus_source, mode_correction, mode_bear, mode_crash, spx_mode_correction, spx_mode_bear, spx_mode_crash, eafe_mode_correction, eafe_mode_bear, eafe_mode_crash, mode_channel_scores, r4_phase, r4_entry_fired_at, r4_reentry_rung)
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
    (p_alert->>'r4_reentry_rung')::integer
  );
end;
$$;

-- create or replace preserves the existing grant, but re-assert for a clean apply.
grant execute on function record_run(jsonb, jsonb) to service_role;
