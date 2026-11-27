-- crash-dash — newest-N-readings-per-id RPC (the getSeriesBulk general-path fix).
--
-- getSeriesBulk's general path (limit>1) read `readings_latest` with a global
-- `order by obs_date desc limit ids.length*limit`, then bucketed + sliced per id in JS.
-- Like the limit:1 case the RPC 20260811190000 already fixed, the LIMIT cannot push past
-- `readings_latest`'s DISTINCT ON, so the scan walks the requested ids' whole history:
-- measured on prod (2026-08-18, 5 samples) getSeriesBulk(9 ids, 400) is 832ms median vs
-- 162ms for the same work as 9 parallel getSeries calls — a 5.1x gap.
--
-- This function is the N-row generalization of readings_newest: LATERAL per id under
-- unnest keeps the per-id LIMIT inside the plan, so `readings_obs_idx` (indicator_id,
-- obs_date, run_at desc) serves the ordering and the LIMIT stops the scan early per id.
-- `distinct on (obs_date)` under `order by obs_date desc, run_at desc, id desc` IS the
-- per-(indicator_id, obs_date) latest-vintage collapse `readings_latest` performs (max
-- run_at, tie-break max id) — a readings_newest_n returning stale vintages would be a
-- correctness regression, not a perf win. Optional [p_from, p_to] filter obs_date BEFORE
-- the limit, so an old window survives the newest-N cap (getSeries' range contract).
-- Zero-row ids yield no row, so an absent id means the store holds nothing for it.
--
-- security invoker + STABLE: anon reads go through the readings_anon_read RLS policy,
-- same posture as readings_newest and the readings_latest view this fast-paths.
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
  run_at timestamptz
)
language sql
stable
as $$
  select r.obs_date, r.indicator_id, r.value, r.delta20, r.raw_state, r.state, r.decision, r.run_at
  from unnest(p_ids) as i(indicator_id)
  cross join lateral (
    select distinct on (obs_date)
      obs_date, indicator_id, value, delta20, raw_state, state, decision, run_at
    from readings
    where readings.indicator_id = i.indicator_id
      and (p_from is null or obs_date >= p_from)
      and (p_to is null or obs_date <= p_to)
    order by obs_date desc, run_at desc, id desc
    limit p_limit
  ) r
$$;

grant execute on function readings_newest_n(text[], int, date, date) to anon, service_role;
