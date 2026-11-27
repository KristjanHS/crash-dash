-- crash-dash — newest-alert-per-UTC-fired-date RPC (P2 perf: retire the two paging loops).
--
-- getRecentAlerts / getCashPriors each paged alert_log `fired_at DESC` until `limit` DISTINCT UTC
-- fired-dates were collected — one extra round trip per date carrying a re-run. This pushes the
-- collapse into SQL. It MUST reproduce the JS collapse exactly: `p_limit` counts DATES not rows,
-- one row per UTC fired-DATE, the LATEST run of that date winning (max fired_at, tie-break max id —
-- fired_at is NOT unique), newest-date-first. A wrong tie-break is a correctness regression.
--
-- Lateral-per-date mirrors readings_newest's lateral-per-id (20260811190000): the inner limit-1 is
-- served by alert_log_fired_idx on alert_log (fired_at desc) (init_schema, :44). Returns
-- `setof alert_log` so PostgREST vertical-filters the wide (rowToAlert) and narrow
-- ({obs_date, dial_target_rung}) projections off one function; callers add `.order(fired_at desc)`.
--
-- security invoker (the default) + STABLE: same posture as readings_newest — anon reads still pass
-- the alert_log RLS policy.
create function alert_log_recent(p_limit int)
returns setof alert_log
language sql
stable
as $$
  select r.*
  from (
    select distinct (fired_at at time zone 'utc')::date as fired_date
    from alert_log
    order by fired_date desc
    limit p_limit
  ) dates
  cross join lateral (
    select *
    from alert_log
    where (alert_log.fired_at at time zone 'utc')::date = dates.fired_date
    order by alert_log.fired_at desc, alert_log.id desc
    limit 1
  ) r
  order by r.fired_at desc
$$;

grant execute on function alert_log_recent(int) to anon, service_role;
