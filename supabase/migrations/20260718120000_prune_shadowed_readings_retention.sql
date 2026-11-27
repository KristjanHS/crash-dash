-- crash-dash — retention floor for the shadowed-vintage prune (review FINDING 1).
--
-- destructive: reviewed re-creates prune_shadowed_readings (body DELETEs shadowed `readings`
-- vintages, unchanged keep-rule) and DROPs the old 1-arg overload so PostgREST stays unambiguous;
-- deletes strictly FEWER rows than the function it replaces. Preceded by the daily
-- `backups`-branch snapshot (the scheduled backup job → supabase/backups/*.sql).
--
-- WHY: 20260716150000 defined this prune for the BACKFILL path, where a pass re-inserts whole
-- histories under a fresh run_at and the shadowed vintage is a genuinely redundant duplicate
-- (~15k dead rows per pass). It was then also wired into the DAILY CRON (src/run.ts), where the
-- same predicate destroys real provenance: the cron writes one row per indicator at that
-- indicator's LATEST obs_date, and that obs_date does NOT advance daily —
--   * weekends/holidays: Sat/Sun/Mon runs all carry Friday's obs_date, so Sunday's prune deletes
--     Saturday's row for every indicator;
--   * monthly / low-cadence series (CAPE/F7, monthly FRED): ~29 of every 30 daily rows go.
-- getReadingsForRun(<a past run_at>) — the "which run observed this value" audit trail that
-- scripts/trace-fired.ts reads over getRecentAlerts history — then returns empty for pruned runs.
-- DB history here is irreplaceable, so this is not recoverable.
--
-- FIX: a parameterised retention floor. `p_retain_days` null (the DEFAULT) reproduces the previous
-- behavior EXACTLY, so the backfill caller is untouched; the cron caller passes a floor (see
-- CRON_PRUNE_RETAIN_DAYS in src/store.ts) so only shadowed rows older than it are eligible —
-- recent provenance survives, the long-tail bloat fix is retained.
--
-- The keep-rule itself is unchanged and deliberately NOT a UNIQUE + upsert: rows must stay
-- immutable for the incremental backup's count-guard, so the live path stays INSERT-only.

-- Signature change ⇒ `create or replace` would leave the 1-arg function in place and PostgREST
-- could not resolve a `{p_ids}` call between the two. Drop it first.
drop function if exists prune_shadowed_readings(text[]);

create or replace function prune_shadowed_readings(p_ids text[], p_retain_days integer default null)
returns integer
language plpgsql
security invoker
as $$
declare
  deleted integer;
begin
  delete from readings d
  using readings k
  where d.indicator_id = any(p_ids)
    and k.indicator_id = d.indicator_id
    and k.obs_date = d.obs_date
    and (k.run_at > d.run_at or (k.run_at = d.run_at and k.id > d.id))
    -- Retention floor: null ⇒ no floor (backfill semantics, the pre-existing behavior).
    and (p_retain_days is null or d.run_at < now() - make_interval(days => p_retain_days));
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

-- Reached server-side with the service key only, same posture as record_run.
grant execute on function prune_shadowed_readings(text[], integer) to service_role;
