-- crash-dash — `readings.estimated` + E7 precedence
-- (Stage 0). An estimate row (proxy nowcast / carry, Stage 2) is stored with `estimated = true`; per
-- (indicator_id, obs_date) a FINAL row beats any estimate whatever their run_at, then newest run_at,
-- then latest insert: `order by estimated asc, run_at desc, id desc` (E1/E7). `pickRecent`
-- (src/estimated.ts) mirrors it for InMemoryStore; `src/store.contract.test.ts` runs both.
--
-- Every site that picks "the served row" per (indicator_id, obs_date) takes the new order here:
--   * `readings_latest` view — `create or replace`, `estimated` APPENDED last (the only shape
--     `create or replace view` permits; 20260902070000 header).
--   * `readings_newest` / `readings_newest_n` RPCs — return type gains a column ⇒ drop + create
--     (42P13 on `create or replace`), bodies otherwise verbatim from 20260902073000 (the LATERAL/
--     unnest plan, the [p_from,p_to]-before-limit filter and the id tie-break stay load-bearing).
--   * `prune_shadowed_readings` — its contract is "keep the readings_latest row"; on the old keep-rule
--     a final shadowed by a NEWER estimate would be deleted and the estimate served. Same signature ⇒
--     `create or replace` keeps its grant; floor / pin / GC-guard clauses verbatim from 20260723120000.
--
-- `record_run` needs no re-create: it maps readings keys by name via jsonb_populate_recordset, and
-- `readingRow` (src/store.ts) always sends `estimated` (a missing key would populate NULL and fail the
-- NOT NULL loud, never default silently).
--
-- destructive: reviewed drops + re-creates two STABLE read-only SQL functions (readings_newest,
-- readings_newest_n; pure selects, no data touched — fully defined by this file, grants re-asserted)
-- and re-defines prune_shadowed_readings' keep-rule, whose DELETE body only narrows which shadowed
-- vintage dies (a final is never deleted in favour of an estimate). No row is deleted or updated by
-- this migration; the ADD COLUMN backfills `false`, so every existing row keeps today's precedence.

alter table readings add column if not exists estimated boolean not null default false;

create or replace view readings_latest as
select distinct on (indicator_id, obs_date)
  obs_date,
  indicator_id,
  value,
  delta20,
  raw_state,
  state,
  run_at,
  decision,
  band_cuts,
  estimated
from readings
order by indicator_id, obs_date, estimated asc, run_at desc, id desc;

alter view readings_latest set (security_invoker = on);
grant select on readings_latest to service_role;
grant select on readings_latest to anon;

drop function if exists readings_newest(text[]);

create function readings_newest(p_ids text[])
returns table (
  obs_date date,
  indicator_id text,
  value double precision,
  delta20 double precision,
  raw_state text,
  state text,
  decision double precision,
  run_at timestamptz,
  band_cuts jsonb,
  estimated boolean
)
language sql
stable
as $$
  select r.obs_date, r.indicator_id, r.value, r.delta20, r.raw_state, r.state, r.decision, r.run_at, r.band_cuts, r.estimated
  from unnest(p_ids) as i(indicator_id)
  cross join lateral (
    select obs_date, indicator_id, value, delta20, raw_state, state, decision, run_at, band_cuts, estimated
    from readings
    where readings.indicator_id = i.indicator_id
    order by obs_date desc, estimated asc, run_at desc, id desc
    limit 1
  ) r
$$;

grant execute on function readings_newest(text[]) to anon, service_role;

drop function if exists readings_newest_n(text[], int, date, date);

create function readings_newest_n(
  p_ids text[],
  p_limit int,
  p_from date default null,
  p_to date default null
)
returns table (
  obs_date date,
  indicator_id text,
  value double precision,
  delta20 double precision,
  raw_state text,
  state text,
  decision double precision,
  run_at timestamptz,
  band_cuts jsonb,
  estimated boolean
)
language sql
stable
as $$
  select r.obs_date, r.indicator_id, r.value, r.delta20, r.raw_state, r.state, r.decision, r.run_at, r.band_cuts, r.estimated
  from unnest(p_ids) as i(indicator_id)
  cross join lateral (
    select distinct on (obs_date)
      obs_date, indicator_id, value, delta20, raw_state, state, decision, run_at, band_cuts, estimated
    from readings
    where readings.indicator_id = i.indicator_id
      and (p_from is null or obs_date >= p_from)
      and (p_to is null or obs_date <= p_to)
    order by obs_date desc, estimated asc, run_at desc, id desc
    limit p_limit
  ) r
$$;

grant execute on function readings_newest_n(text[], int, date, date) to anon, service_role;

create or replace function prune_shadowed_readings(
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
  if p_ids is null and p_retain_days is null then
    raise exception 'prune_shadowed_readings: p_ids null (all indicators) requires a p_retain_days retention floor — an unfloored blanket prune would destroy all per-run provenance';
  end if;

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
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

grant execute on function prune_shadowed_readings(text[], integer, boolean) to service_role;
