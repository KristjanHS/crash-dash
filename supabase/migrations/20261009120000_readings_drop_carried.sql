-- crash-dash — drop `readings.carried` (user ruling: no carried values). No
-- writer has stored a carry row since the code stopped writing them; this purges the residue and the column.
-- `readings_latest` / `readings_newest` / `readings_newest_n` are re-created from 20261003150000_readings_carried.sql
-- verbatim minus `carried` (the view must be dropped: `create or replace view` cannot remove a column).
--
-- destructive: reviewed deletes every `carried` row (carry rows: the last print's value re-dated, a label never an
-- observation — `sweepRosterEstimates` already deleted them each run; no snapshot needed, nothing reads them), drops
-- the CHECK, trigger + its function and the column, and drops + re-creates one read-only view and two STABLE read-only
-- SQL functions (pure selects, fully defined by this file, grants re-asserted).

delete from readings where carried;

drop view if exists readings_latest;
drop function if exists readings_newest(text[]);
drop function if exists readings_newest_n(text[], int, date, date);

drop trigger if exists readings_carried_default on readings;
drop function if exists readings_carried_default();
alter table readings drop constraint if exists readings_carried_is_estimated;
alter table readings drop column if exists carried;

create view readings_latest as
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
