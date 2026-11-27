-- crash-dash — carry `band_cuts` through the readings_newest{,_n} RPCs.
--
-- 20260902070000 put `band_cuts` into the `readings_latest` view, restoring getSeries. But
-- getSeriesBulk does NOT read that view: limit:1 goes through `readings_newest`
-- (20260811190000) and limit>1 through `readings_newest_n` (20260818140000), each of which
-- pins its projection in a `returns table (...)` SIGNATURE. Those two signatures stopped at
-- `decision`, so the three read paths for the same rows disagreed on their column set.
--
-- Harmless only for as long as `rowToSeriesPoint` ignores the column. The moment `bandCuts`
-- lands on `SeriesPoint`, getSeries would serve the stored cut and getSeriesBulk would serve
-- `undefined` for the same date — a silent per-path divergence, not an error, and exactly the
-- class of drift the 20260818140000 docblock calls "a correctness regression, not a perf win".
-- Closing it here means that later change is a pure TypeScript edit with no DB half to forget.
-- `src/store.contract.test.ts` ("readings_newest{,_n} RPCs carry band_cuts") is the tripwire
-- that keeps the column non-dead: it asserts both RPCs round-trip a stored `band_cuts` today,
-- before any reader exists. It calls the RPCs DIRECTLY — routing through getSeriesBulk would
-- pass against a column-less RPC, since rowToSeriesPoint does not read the column yet.
--
-- WHY DROP AND NOT `create or replace`: adding a column to `returns table (...)` CHANGES THE
-- RETURN TYPE, and Postgres rejects that on `create or replace function` (42P13, "cannot
-- change return type of existing function"). The column must also be APPENDED last — same
-- constraint as the view — so no existing ordinal moves.
--
-- destructive: reviewed drops two STABLE read-only SQL functions (readings_newest,
-- readings_newest_n) and immediately re-creates them with one column appended; no table, row
-- or grant is destroyed and no data is touched (both are pure `select` over `readings`, which
-- this migration does not write). Recovery needs no snapshot — the functions are fully defined
-- by this file. The only live-window risk is a getSeriesBulk call landing between the DROP and
-- the CREATE inside the same transactional `db push` apply; it would error loudly (missing
-- function), never serve a wrong number.
--
-- Bodies are otherwise preserved VERBATIM from their source migrations — the LATERAL/unnest
-- plan, the `distinct on (obs_date)` vintage collapse, the [p_from,p_to]-before-limit filter
-- and the `order by obs_date desc, run_at desc, id desc` tie-break are all load-bearing and
-- documented there; this migration adds a column and changes nothing else. Grants are
-- re-asserted because DROP takes them with it.
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
  band_cuts jsonb
)
language sql
stable
as $$
  select r.obs_date, r.indicator_id, r.value, r.delta20, r.raw_state, r.state, r.decision, r.run_at, r.band_cuts
  from unnest(p_ids) as i(indicator_id)
  cross join lateral (
    select obs_date, indicator_id, value, delta20, raw_state, state, decision, run_at, band_cuts
    from readings
    where readings.indicator_id = i.indicator_id
    order by obs_date desc, run_at desc, id desc
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
  band_cuts jsonb
)
language sql
stable
as $$
  select r.obs_date, r.indicator_id, r.value, r.delta20, r.raw_state, r.state, r.decision, r.run_at, r.band_cuts
  from unnest(p_ids) as i(indicator_id)
  cross join lateral (
    select distinct on (obs_date)
      obs_date, indicator_id, value, delta20, raw_state, state, decision, run_at, band_cuts
    from readings
    where readings.indicator_id = i.indicator_id
      and (p_from is null or obs_date >= p_from)
      and (p_to is null or obs_date <= p_to)
    order by obs_date desc, run_at desc, id desc
    limit p_limit
  ) r
$$;

grant execute on function readings_newest_n(text[], int, date, date) to anon, service_role;
