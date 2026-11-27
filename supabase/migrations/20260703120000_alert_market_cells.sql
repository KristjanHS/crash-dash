-- Task 5 Stage 5.2 (modes-and-markets design): per-market cell mode levels on alert_log.
-- SPX + EAFE mirror the NDX (ndx, mode) cells (mode_correction/bear/crash, added in
-- 20260702160000_alert_mode_cells.sql); NDX keeps the unprefixed legacy trio. Display-only
-- ladder levels — never feed the fast OK/WATCH/WARNING/CRITICAL verdict or the notify path.
-- Nullable, no backfill: old rows stay null and the market tabs / mode strip degrade silently.
alter table alert_log
  add column spx_mode_correction text,
  add column spx_mode_bear text,
  add column spx_mode_crash text,
  add column eafe_mode_correction text,
  add column eafe_mode_bear text,
  add column eafe_mode_crash text;
