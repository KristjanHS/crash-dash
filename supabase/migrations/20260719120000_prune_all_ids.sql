-- crash-dash — GC-scope the shadowed-vintage prune (D5, 2026-07-19).
--
-- destructive: reviewed re-creates prune_shadowed_readings (body DELETEs shadowed `readings`
-- vintages) and WIDENS its scope — `p_ids is null` now means "every indicator_id" instead of
-- matching nothing, so a floored pass can delete shadowed rows for ids the calling run never
-- wrote. The keep-rule and the `p_retain_days` floor are unchanged, so no row is deleted that
-- an explicit-ids call with the same floor would have spared. Preceded by the daily
-- `backups`-branch snapshot (the scheduled backup job → supabase/backups/*.sql).
--
-- WHY: the cron prune was WRITE-scoped — it passed exactly the ids persisted by that run. An id
-- that stops being written (a retired indicator, a feed that fails on the night its vintage is
-- shadowed) is then excluded from every future prune FOREVER: eligibility depended on who wrote
-- the row, not on the row. Garbage-collection scope removes that failure mode by construction —
-- eligibility becomes a pure function of age, which is already the property that makes the
-- nightly prune safe (`CRON_PRUNE_RETAIN_DAYS`, src/store.ts).
--
-- SAFETY, BUILT IN NOT DOCUMENTED: `p_ids null` + `p_retain_days null` is an unfloored blanket
-- prune — it would destroy all per-run provenance in one statement (getReadingsForRun over past
-- run_ats returns empty; DB history here is irreplaceable). That
-- combination is made UNREPRESENTABLE by the guard below, not merely discouraged.
--
-- Signature is UNCHANGED from 20260718120000, so `create or replace` suffices — no drop/overload
-- dance, and PostgREST keeps resolving the single 2-arg function.

create or replace function prune_shadowed_readings(p_ids text[], p_retain_days integer default null)
returns integer
language plpgsql
security invoker
as $$
declare
  deleted integer;
begin
  -- Unfloored blanket prune: unrepresentable by construction (see SAFETY above).
  if p_ids is null and p_retain_days is null then
    raise exception 'prune_shadowed_readings: p_ids null (all indicators) requires a p_retain_days retention floor — an unfloored blanket prune would destroy all per-run provenance';
  end if;

  delete from readings d
  using readings k
  -- GC scope: null ids ⇒ every indicator_id (D5). A non-null array keeps the previous
  -- write-scoped semantics exactly, which is what the backfill caller still relies on.
  where (p_ids is null or d.indicator_id = any(p_ids))
    and k.indicator_id = d.indicator_id
    and k.obs_date = d.obs_date
    and (k.run_at > d.run_at or (k.run_at = d.run_at and k.id > d.id))
    -- Retention floor: null ⇒ no floor (backfill semantics, only reachable with explicit ids).
    and (p_retain_days is null or d.run_at < now() - make_interval(days => p_retain_days));
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

-- Reached server-side with the service key only, same posture as record_run.
grant execute on function prune_shadowed_readings(text[], integer) to service_role;
