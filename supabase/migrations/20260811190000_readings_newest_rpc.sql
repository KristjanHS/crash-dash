-- crash-dash — newest-reading-per-id RPC (the /lab freshness-stamp timeout fix).
--
-- freshnessFrom's stage-1 read wants ONE newest row per served id (getSeriesBulk limit:1),
-- but through `readings_latest` the LIMIT cannot push past the DISTINCT ON: measured on prod
-- (2026-08-11, EXPLAIN ANALYZE) the query walks the requested ids' ENTIRE history — 240k rows /
-- 84k buffers — to return 79 rows. Warm cache that is ~0.4s; cold cache on the free-tier
-- instance it exceeds the anon role's `statement_timeout=3s`, the read throws, api/lab degrades
-- to `freshnessMissing: true`, and the /lab Lag column paints every feed "NOT MEASURED".
--
-- This function replaces the scan with one index probe per id (readings_obs_idx, backward):
-- LATERAL limit-1 under unnest keeps the per-id LIMIT inside the plan. Ordering mirrors
-- `readings_latest`'s vintage rule — newest obs_date, then latest run_at, id as the final
-- tie-break (the same row `prune_shadowed_readings` keeps). Zero-row ids yield no row, so a
-- caller seeing an absent id knows the store holds nothing for it (never a fabricated point).
--
-- security invoker + STABLE: anon reads go through the readings_anon_read RLS policy
-- (20260716220000), same posture as the security_invoker view this fast-paths.
create function readings_newest(p_ids text[])
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
    select obs_date, indicator_id, value, delta20, raw_state, state, decision, run_at
    from readings
    where readings.indicator_id = i.indicator_id
    order by obs_date desc, run_at desc, id desc
    limit 1
  ) r
$$;

grant execute on function readings_newest(text[]) to anon, service_role;
