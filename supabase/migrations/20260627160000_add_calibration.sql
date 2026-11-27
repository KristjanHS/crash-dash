-- crash-dash — calibration seam (crash-logic plan Phase 1 Stage 2, Task B).
--
-- Derived cut-points (EVT/GPD levels, bootstrap CIs, credit-depth thresholds, ...)
-- computed off-line by the calibration harness (GitHub Actions — Vercel can't host
-- the stats) and read by the Vercel app at scoring time. The harness writes here;
-- the app reads `calibration_latest`. Same split as readings: one durable table the
-- producer appends to, one view the consumer reads.
--
-- Append-only + vintage capture (mirrors `readings`): each harness run stamps every
-- param with `computed_at`, and a re-run of the same (channel, metric) is RE-stored,
-- never overwritten — so a later calibration can't reconstruct (or silently mutate)
-- what an earlier run published. `calibration_latest` collapses to the newest vintage.

-- Every param from every calibration run, append-only. The same (channel, metric)
-- is re-stored on each run on purpose: computed_at pins the vintage.
create table if not exists calibration (
  id           bigint generated always as identity primary key,
  channel      text             not null,  -- credit, rate, semis, breadth, oil, ...
  metric       text             not null,  -- evt_level_red, ci_low, depth_thresh, ...
  value        double precision not null,  -- the derived cut-point / statistic
  ci_low       double precision,           -- lower bound (nullable — not every method emits a CI)
  ci_high      double precision,           -- upper bound (nullable)
  method       text             not null,  -- evt_gpd, block_bootstrap, quantile, ...
  n_events     integer,                    -- # events behind the estimate (nullable)
  window_start date,                       -- calibration window lower bound (nullable)
  window_end   date,                       -- calibration window upper bound (nullable)
  notes        text,                        -- free-form provenance (nullable)
  computed_at  timestamptz      not null   -- harness run stamp — the vintage key
);

-- "Current" = latest computed_at per (channel, metric); serves the latest-view's
-- DISTINCT ON ordering as an ordered index scan.
create index if not exists calibration_latest_idx on calibration (channel, metric, computed_at desc);

-- RLS deny-by-default (same posture as readings/alert_log): the harness writes and
-- the app reads server-side with the service key, which bypasses RLS. Enabling it
-- with NO policies means any future anon/authenticated key is denied until an
-- explicit policy is added.
alter table calibration enable row level security;

-- Explicit DML grant to service_role ONLY (bypasses RLS). anon/authenticated get NO
-- grant — combined with RLS-on, the table is double-locked to any browser-side key.
grant select, insert, update, delete on calibration to service_role;

-- Latest-vintage view (mirrors readings_latest): for each (channel, metric), the
-- param from the LATEST computed_at. PostgREST has no DISTINCT ON, so the app reads
-- this view directly rather than rebuilding the vintage rule in JS.
--
-- DISTINCT ON keeps the first row per (channel, metric) under the ORDER BY, so
-- `computed_at DESC` makes that first row the latest vintage. The leading
-- (channel, metric) in the ORDER BY is required by DISTINCT ON and is served by
-- calibration_latest_idx (channel, metric, computed_at desc) as an ordered index scan.
create or replace view calibration_latest as
select distinct on (channel, metric)
  channel,
  metric,
  value,
  ci_low,
  ci_high,
  method,
  n_events,
  window_start,
  window_end,
  notes,
  computed_at
from calibration
order by channel, metric, computed_at desc;

-- The view is reached server-side with the service key only (same posture as the
-- base table). A plain (security-invoker = off) view runs as its owner, so reads
-- don't trip the base table's RLS; the explicit grant keeps anon/authenticated out.
-- service_role already bypasses RLS regardless.
grant select on calibration_latest to service_role;
