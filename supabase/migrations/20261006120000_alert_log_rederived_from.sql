-- crash-dash — superseding verdict rows.
-- `rederived_from` = the ORIGINAL row's fired_at; the superseding row sits at that fired_at + 1 ms.
--
-- ADDITIVE ONLY: NULLABLE, no default; `record_run` maps keys by name (jsonb_populate_record), no re-create.
-- `alert_log_recent` returns `setof alert_log` (max fired_at per UTC date), so it serves the superseding row.
alter table alert_log
  add column if not exists rederived_from timestamptz;
