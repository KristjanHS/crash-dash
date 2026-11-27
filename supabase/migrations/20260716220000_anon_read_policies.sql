-- crash-dash — anon SELECT-only RLS policies (Sec-B3, audit-extras Stage 5.1).
--
-- The read API handlers (status/lab/series/indicators/families/exposure/replay/meta)
-- move to a least-privilege ANON key (store.ts getStore("ro")). Today every table has
-- RLS ON with a service_role-only grant and ZERO policies, so anon is denied everything.
-- This migration opens exactly ONE capability to anon: SELECT. No insert/update/delete
-- policy and no write grant is added, so the anon key stays read-only by construction —
-- a leaked browser-side key can read published history but can never mutate the store.
--
-- Covers every base table the store READ methods touch (grep src/store.ts):
--   readings          getReadingsForRun / getSeries(via readings_latest) / getSeriesBulk
--   alert_log         getLastAlert/getLastPush/getLastBand/getRecentAlerts/getAlertsSince
--   calibration       getCalibration (via calibration_latest) + checkSchema direct probe
--   overrides         getOverrides
-- readings_latest is `security_invoker = on`, so a SELECT through it re-checks the
-- querying role's RLS on base `readings` — the readings policy below governs it; anon
-- also needs an explicit view GRANT. calibration_latest is a plain (security_invoker off)
-- view that runs as owner, so the view GRANT alone lets anon read it; the calibration
-- base policy is added anyway for uniformity + checkSchema's direct `calibration` probe.
--
-- Policies are dropped-then-created for idempotent re-apply (Postgres has no
-- `create policy if not exists`). Grants are naturally idempotent.

-- readings -----------------------------------------------------------------
drop policy if exists readings_anon_read on readings;
create policy readings_anon_read on readings for select to anon using (true);
grant select on readings to anon;
grant select on readings_latest to anon;

-- alert_log ----------------------------------------------------------------
drop policy if exists alert_log_anon_read on alert_log;
create policy alert_log_anon_read on alert_log for select to anon using (true);
grant select on alert_log to anon;

-- calibration --------------------------------------------------------------
drop policy if exists calibration_anon_read on calibration;
create policy calibration_anon_read on calibration for select to anon using (true);
grant select on calibration to anon;
grant select on calibration_latest to anon;

-- overrides ----------------------------------------------------------------
drop policy if exists overrides_anon_read on overrides;
create policy overrides_anon_read on overrides for select to anon using (true);
grant select on overrides to anon;
