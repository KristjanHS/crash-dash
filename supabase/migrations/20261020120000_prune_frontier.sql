-- crash-dash — frontier-scoped shadowed-vintage prune.
--
-- destructive: reviewed drops the 3-arg prune_shadowed_readings and re-creates it with a fourth
-- argument `p_since timestamptz default null`. The DROP is required, not cosmetic: `create or replace`
-- cannot change the signature, and keeping both would make every existing 3-arg named call ambiguous
-- ("function is not unique") once the 4-arg form defaults `p_since`. With `p_since` null the DELETE
-- body is the 20261003120000 body verbatim; with it set the same predicates run over a SUBSET of
-- rows, so the swap never deletes a row the old function would have kept. Preceded by the daily
-- `backups`-branch snapshot.
--
-- WHY: the old body is one DELETE … USING self-join whose work scales with the FULL stored history of
-- every id in scope (backfill scope: 73.5k index probes to find ~3k rows; cron scope: 173k join
-- candidates → 3.8k), and PostgREST runs it under `authenticator`'s fixed statement_timeout = 8s on an
-- instance whose speed swings ~10× — so it times out (the 2026-10-20 05:51Z backfill prune did).
--
-- FRONTIER RULE. A row d is deletable at t iff it is shadowed ∧ d.run_at < t − R (R = p_retain_days,
-- null ⇒ 0) ∧ not pinned. A row that became deletable since p_since did so because either
--   (1) a shadower arrived: some k at d's (indicator_id, obs_date) has k.run_at >= p_since — found by
--       readings_run_idx (k) then readings_obs_idx (d); or
--   (2) d crossed the floor: d.run_at ∈ [p_since − R, now() − R) — readings_run_idx range scan
--       (d's own late insert under an older shadower is inside this range too).
-- Only those candidates reach the unchanged shadow / floor / pin predicates, so the work scales with
-- the window, not with history. Callers pass the start of the window they own (backfill: its job's
-- start; cron: run_at − CRON_PRUNE_FRONTIER_DAYS, so a run of failed prunes up to that long self-heals).
--
-- MISSED BY DESIGN: a pin removed after the fact (its alert_log row deleted) makes an OLD row eligible
-- with no new shadower and no floor crossing — and any row whose window was skipped by a gap longer
-- than the caller's overlap. Both are caught by a manual `p_since => null` sweep (today's full body).
--
-- The id scope, the keep-rule, the pin, and the unfloored-blanket-prune guard are unchanged.

drop function if exists prune_shadowed_readings(text[], integer, boolean);

create function prune_shadowed_readings(
  p_ids text[],
  p_retain_days integer default null,
  p_pin_alert_runs boolean default true,
  p_since timestamptz default null
)
returns integer
language plpgsql
security invoker
as $$
declare
  deleted integer;
  retain interval := make_interval(days => coalesce(p_retain_days, 0));
begin
  if p_ids is null and p_retain_days is null then
    raise exception 'prune_shadowed_readings: p_ids null (all indicators) requires a p_retain_days retention floor — an unfloored blanket prune would destroy all per-run provenance';
  end if;

  if p_since is null then
    -- Full sweep (manual catch-up): the 20261003120000 body, verbatim.
    -- k shadows d iff k sorts first under readings_latest's order (estimated asc, run_at desc, id desc).
    delete from readings d
    using readings k
    where (p_ids is null or d.indicator_id = any(p_ids))
      and k.indicator_id = d.indicator_id
      and k.obs_date = d.obs_date
      and (
        (d.estimated and not k.estimated)
        or (k.estimated = d.estimated and (k.run_at > d.run_at or (k.run_at = d.run_at and k.id > d.id)))
      )
      and (p_retain_days is null or d.run_at < now() - make_interval(days => p_retain_days))
      and (not p_pin_alert_runs or not exists (select 1 from alert_log a where a.fired_at = d.run_at));
  else
    -- Frontier: the same predicates, over only the rows that can have become deletable since p_since.
    -- Shape is PINNED to index-driven nested loops (a naive `d.id in (candidates)` + self-join let the
    -- planner fall back to a full merge join of readings — measured slower than the full sweep):
    -- `offset 0` / `limit 1` keep each lateral un-flattened, so every probe is a readings_obs_idx
    -- lookup per candidate and the work scales with the window, never with history.
    with fresh_keys as materialized (
      -- (1) newly shadowed: the keys of rows written at/after p_since (readings_run_idx).
      select distinct n.indicator_id, n.obs_date
      from readings n
      where n.run_at >= p_since
        and (p_ids is null or n.indicator_id = any(p_ids))
    ),
    candidates as materialized (
      -- (1) every row at a fresh key (readings_obs_idx).
      select c.id, c.indicator_id, c.obs_date, c.run_at, c.estimated
      from fresh_keys f
      cross join lateral (
        select r.id, r.indicator_id, r.obs_date, r.run_at, r.estimated
        from readings r
        where r.indicator_id = f.indicator_id and r.obs_date = f.obs_date
        offset 0
      ) c
      union
      -- (2) newly past the floor: crossed now() − R inside [p_since − R, now() − R) (readings_run_idx).
      select c.id, c.indicator_id, c.obs_date, c.run_at, c.estimated
      from readings c
      where c.run_at >= p_since - retain
        and c.run_at < now() - retain
        and (p_ids is null or c.indicator_id = any(p_ids))
    ),
    doomed as (
      -- The full-sweep body's predicates, verbatim, with each candidate as d.
      select d.id
      from candidates d
      cross join lateral (
        -- k shadows d iff k sorts first under readings_latest's order (estimated asc, run_at desc, id desc).
        select 1
        from readings k
        where k.indicator_id = d.indicator_id
          and k.obs_date = d.obs_date
          and (
            (d.estimated and not k.estimated)
            or (k.estimated = d.estimated and (k.run_at > d.run_at or (k.run_at = d.run_at and k.id > d.id)))
          )
        limit 1
      ) k
      where (p_ids is null or d.indicator_id = any(p_ids))
        and (p_retain_days is null or d.run_at < now() - make_interval(days => p_retain_days))
        and (not p_pin_alert_runs or not exists (select 1 from alert_log a where a.fired_at = d.run_at))
    )
    delete from readings
    where id = any(array(select id from doomed));
  end if;
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

grant execute on function prune_shadowed_readings(text[], integer, boolean, timestamptz) to service_role;
