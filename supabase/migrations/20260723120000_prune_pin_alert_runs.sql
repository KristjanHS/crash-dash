-- crash-dash — pin alert runs out of the shadowed-vintage prune (review FINDING 1+2, 2026-07-23).
--
-- destructive: reviewed drops the 2-arg prune_shadowed_readings and re-creates it with a third
-- argument. The DROP is required, not cosmetic: `create or replace` cannot change the signature, and
-- keeping both would make every existing 2-arg call ambiguous ("function is not unique") the moment
-- the 3-arg form carries a default. The new body only ever deletes FEWER rows than the old one, so
-- no data is at risk from the swap itself. Preceded by the daily `backups`-branch snapshot.
--
-- WHY: 7ab3591 gave the BACKFILL caller a 3-day retention floor after an unfloored pass deleted the
-- live cron run's rows (DB_SMH/DB_XLK vanished from /lab's EW row). A temporal floor is the wrong
-- shape for that guarantee, twice over:
--   1. The prune's scope is (indicator_id, obs_date) — it cannot tell WHO wrote a shadowed row. So a
--      backfill pass deletes CRON-written vintages aged 3–30 days for every id it touches, silently
--      undercutting CRON_PRUNE_RETAIN_DAYS = 30. `--restate=<id>` shadows an id's whole history and
--      would take every cron vintage of it older than 3 days with it; scripts/backfill/dial-state.ts
--      then treats those emptied runs as "no reconstructable readings" and skips them forever.
--   2. Three days is not even a margin: the cron is `0 22 * * 1-5`, so the routine Fri→Mon gap is
--      exactly 72h. One missed Monday run (a Hobby function-cap freeze does exactly this) makes the
--      latest run's rows eligible again, reproducing the bug on the day it is hardest to notice.
--
-- THE FIX IS STRUCTURAL, NOT TEMPORAL: `alert_log.fired_at` is written on EVERY run and is exactly
-- the key `getReadingsForRun` is asked about (api/lab's BAND members, scripts/trace-fired.ts,
-- backfill/dial-state.ts). Pinning those run_ats makes "a prune emptied a run someone can query"
-- unrepresentable rather than merely unlikely. Default TRUE = the safe direction: a caller that says
-- nothing gets the guarantee. The nightly cron passes FALSE explicitly — every cron vintage carries a
-- fired_at, so the pin would make its long-tail GC a permanent no-op, and collapsing that tail is its
-- whole purpose (src/run.ts).
--
-- The p_ids GC scope (20260719120000), the keep-rule and the unfloored-blanket-prune guard are
-- unchanged.

drop function if exists prune_shadowed_readings(text[], integer);

create function prune_shadowed_readings(
  p_ids text[],
  p_retain_days integer default null,
  p_pin_alert_runs boolean default true
)
returns integer
language plpgsql
security invoker
as $$
declare
  deleted integer;
begin
  -- Unfloored blanket prune: unrepresentable by construction (20260719120000).
  if p_ids is null and p_retain_days is null then
    raise exception 'prune_shadowed_readings: p_ids null (all indicators) requires a p_retain_days retention floor — an unfloored blanket prune would destroy all per-run provenance';
  end if;

  delete from readings d
  using readings k
  -- GC scope: null ids ⇒ every indicator_id (D5). A non-null array keeps write-scoped semantics.
  where (p_ids is null or d.indicator_id = any(p_ids))
    and k.indicator_id = d.indicator_id
    and k.obs_date = d.obs_date
    and (k.run_at > d.run_at or (k.run_at = d.run_at and k.id > d.id))
    -- Retention floor: null ⇒ no floor.
    and (p_retain_days is null or d.run_at < now() - make_interval(days => p_retain_days))
    -- Alert-run pin: a run getReadingsForRun can be asked about is never emptied (see WHY above).
    and (not p_pin_alert_runs or not exists (select 1 from alert_log a where a.fired_at = d.run_at));
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

-- Reached server-side with the service key only, same posture as record_run.
grant execute on function prune_shadowed_readings(text[], integer, boolean) to service_role;
