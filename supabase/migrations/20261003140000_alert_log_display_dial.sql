-- crash-dash — E12 DISPLAY dial: estimates-included twins of `dial_state`/`panel_state` on alert_log.
-- Existing columns stay the notify axis.
--
-- ADDITIVE ONLY: NULLABLE, no default; `record_run` maps keys by name (jsonb_populate_record), no re-create.
-- Null on legacy and dial-less rows; readers take `display_* ?? dial_state`.
alter table alert_log
  add column if not exists display_dial_state jsonb,
  add column if not exists display_panel_state jsonb;
