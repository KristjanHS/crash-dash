-- crash-dash — latest-vintage view (architecture-review P5).
--
-- "Current view of history" = for each (indicator_id, obs_date), the reading from
-- the LATEST run_at. PostgREST has no DISTINCT ON, so getSeries previously rebuilt
-- this rule in JS over a `min(limit*5, 10000)` over-fetch — a heuristic that could
-- silently return a short series if one date had > 5 revisions. Pushing the collapse
-- into SQL makes the vintage rule a single authoritative definition the server reads
-- directly, and `LIMIT n` then yields exactly n distinct dates (no over-fetch cap).
--
-- DISTINCT ON keeps the first row per (indicator_id, obs_date) under the ORDER BY,
-- so `run_at DESC` makes that first row the latest vintage. The leading
-- (indicator_id, obs_date) in the ORDER BY is required by DISTINCT ON and is served
-- by readings_obs_idx (indicator_id, obs_date, run_at desc) as an ordered index scan.
create or replace view readings_latest as
select distinct on (indicator_id, obs_date)
  obs_date,
  indicator_id,
  value,
  delta20,
  raw_state,
  state,
  run_at
from readings
order by indicator_id, obs_date, run_at desc;

-- The view is reached server-side with the service key only (same posture as the
-- base tables). A plain (security-invoker = off) view runs as its owner, so reads
-- don't trip the base table's RLS; the explicit grant keeps anon/authenticated out,
-- matching readings/alert_log. service_role already bypasses RLS regardless.
grant select on readings_latest to service_role;
