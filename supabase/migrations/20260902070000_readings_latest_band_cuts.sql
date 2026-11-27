-- crash-dash — carry `band_cuts` through the `readings_latest` projection.
--
-- 20260901120000_add_band_cuts.sql added the column to the `readings` TABLE only. But
-- `readings_latest` NAMES ITS COLUMNS EXPLICITLY, so a bare ADD COLUMN leaves every read
-- through the view blind to it — the trap 20260715120000_add_decision_value.sql documents
-- and handled by re-creating the view in the same migration. `band_cuts` missed that step.
--
-- Not a latent gap: `READINGS_COLUMNS` (store.ts) is ONE list used for both the base-table
-- and the view projections, so the moment `bandCuts` joined it, `getSeries`' select against
-- `readings_latest` began erroring `column readings_latest.band_cuts does not exist` — 14
-- integration failures in `src/store.contract.test.ts` + `scripts/backfill-slow.test.ts`,
-- among them `checkSchema`, whose whole job is to catch exactly this drift. `npm run check`
-- is structurally blind to it (the SupabaseStore suites are `describe.runIf(hasDb)`), so the
-- red first appears in `make ship` / `check:integration`.
--
-- ADDITIVE ONLY: `create or replace view` with `band_cuts` APPENDED at the end of the
-- projection (the only shape `create or replace` permits — existing columns keep name, type
-- and position). No DROP / ALTER TYPE / DELETE / UPDATE, so no `-- destructive: reviewed`
-- marker is owed (.claude/rules/migrations.md taxonomy).
--
-- security_invoker + the service_role/anon grants are re-asserted (idempotent) so the view
-- keeps its 20260628073500 + 20260716220000 posture on a clean `db reset` apply.
--
-- The `readings_newest` / `readings_newest_n` RPCs (getSeriesBulk's fast paths) still do NOT
-- return `band_cuts`, and that is correct today: `rowToSeriesPoint` does not read it, so the
-- two paths agree. If a later stage puts `bandCuts` on `SeriesPoint`, those two function
-- signatures must gain the column IN THE SAME CHANGE or getSeriesBulk will silently serve
-- undefined where getSeries serves the cut — a drop+create (return-type change), not a
-- `create or replace`.
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
  band_cuts
from readings
order by indicator_id, obs_date, run_at desc;

alter view readings_latest set (security_invoker = on);
grant select on readings_latest to service_role;
grant select on readings_latest to anon;
