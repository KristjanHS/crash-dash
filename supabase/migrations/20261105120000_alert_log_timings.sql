-- crash-dash — per-run phase timings on alert_log (cron slow-tail plan D2).
-- jsonb `{cold, anchorMs, marks: {<phase>: ms since run anchor}}` (fetch-budget.ts `RunTimings`).
-- Additive; record_run picks it up via jsonb_populate_record, alert_log_recent via `r.*`.
alter table alert_log add column if not exists timings jsonb;
