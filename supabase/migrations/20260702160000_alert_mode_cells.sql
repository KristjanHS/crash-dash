-- Task 4 Stage 4.3 (modes-and-markets design): per-cell mode levels on alert_log.
-- Display-only ladder levels for the (ndx, mode) cells — never feed the fast
-- OK/WATCH/WARNING/CRITICAL verdict or the notify path. Nullable, no backfill:
-- old rows stay null and the UI degrades silently.
alter table alert_log
  add column mode_correction text,
  add column mode_bear text,
  add column mode_crash text;
