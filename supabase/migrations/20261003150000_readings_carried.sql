-- crash-dash — `readings.carried` (E20, Stage 6.1). A carry row
-- (the last print's value+state, E25) is stored `estimated = true, carried = true`; the CHECK pins that
-- implication, so the E7 order `estimated asc, run_at desc, id desc` already ranks a carry under any print.
--
-- `carried` joins every served-row read site, APPENDED last (20261003120000's pattern): `readings_latest`
-- via `create or replace view`; `readings_newest` / `readings_newest_n` gain a return column ⇒ drop + create,
-- bodies otherwise verbatim from 20261003120000. `prune_shadowed_readings` / `record_run` need no re-create
-- (keep-rule unchanged; record_run maps keys by name). An old build's payload omits `carried` ⇒ NULL ⇒ the
-- trigger below coerces it to false (20261003130000's pattern).
--
-- destructive: reviewed drops + re-creates two STABLE read-only SQL functions (readings_newest,
-- readings_newest_n; pure selects, no data touched — fully defined by this file, grants re-asserted) and
-- `drop trigger/constraint if exists` re-create only this file's own trigger and CHECK. No row is deleted or updated; the ADD
-- COLUMN backfills `false`, so every existing row satisfies the CHECK and keeps today's precedence.

alter table readings add column if not exists carried boolean not null default false;

alter table readings drop constraint if exists readings_carried_is_estimated;
alter table readings add constraint readings_carried_is_estimated check (not carried or estimated);

create or replace function readings_carried_default()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.carried := coalesce(new.carried, false);
  return new;
end;
$$;

drop trigger if exists readings_carried_default on readings;

create trigger readings_carried_default
before insert on readings
for each row execute function readings_carried_default();

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
  estimated,
  carried
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
  estimated boolean,
  carried boolean
)
language sql
stable
as $$
  select r.obs_date, r.indicator_id, r.value, r.delta20, r.raw_state, r.state, r.decision, r.run_at, r.band_cuts, r.estimated, r.carried
  from unnest(p_ids) as i(indicator_id)
  cross join lateral (
    select obs_date, indicator_id, value, delta20, raw_state, state, decision, run_at, band_cuts, estimated, carried
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
  estimated boolean,
  carried boolean
)
language sql
stable
as $$
  select r.obs_date, r.indicator_id, r.value, r.delta20, r.raw_state, r.state, r.decision, r.run_at, r.band_cuts, r.estimated, r.carried
  from unnest(p_ids) as i(indicator_id)
  cross join lateral (
    select distinct on (obs_date)
      obs_date, indicator_id, value, delta20, raw_state, state, decision, run_at, band_cuts, estimated, carried
    from readings
    where readings.indicator_id = i.indicator_id
      and (p_from is null or obs_date >= p_from)
      and (p_to is null or obs_date <= p_to)
    order by obs_date desc, estimated asc, run_at desc, id desc
    limit p_limit
  ) r
$$;

grant execute on function readings_newest_n(text[], int, date, date) to anon, service_role;
