-- crash-dash — calibration (market, mode) cell dimension (modes-and-markets design ②,
-- task 1 — 2026-07-02).
--
-- ③ publishes per-(market, mode) calibrated cut-points (e.g. market='ndx',
-- mode='crash') into the same append-only `calibration` table. Both columns are
-- NULLABLE: null = the legacy shared/target-blind rows every vintage published so
-- far — they stay valid and keep collapsing per (channel, metric) exactly as before,
-- because DISTINCT ON groups NULLs as equal (IS NOT DISTINCT FROM semantics).

alter table calibration
  add column market text,  -- 'ndx' | 'spx' | 'eafe' | null (legacy shared rows)
  add column mode   text;  -- 'correction' | 'bear' | 'crash' | null (legacy shared rows)

-- Re-key the latest-vintage rule to the full cell: latest computed_at per
-- (market, mode, channel, metric). Rebuild the ordered-scan index to match the
-- new DISTINCT ON leading columns (an index can't be altered — drop + recreate
-- under the same name).
drop index if exists calibration_latest_idx;
create index if not exists calibration_latest_idx
  on calibration (market, mode, channel, metric, computed_at desc);

-- `create or replace view` requires existing output columns to keep their
-- position/name/type, so market/mode are APPENDED after computed_at (grants on
-- the view are preserved by the replace).
create or replace view calibration_latest as
select distinct on (market, mode, channel, metric)
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
  computed_at,
  market,
  mode
from calibration
order by market, mode, channel, metric, computed_at desc;
