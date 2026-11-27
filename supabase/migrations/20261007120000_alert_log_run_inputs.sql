-- crash-dash — per-run replay inputs.
-- `run_inputs` = every `assembleRun` input not derivable from stored readings (`RunInputs`, src/run-inputs.ts).
--
-- ADDITIVE ONLY: NULLABLE, no default; `record_run` maps keys by name (jsonb_populate_record), no re-create.
-- NULL = a pre-migration row: a re-derive copies its exposure/held/cash/fall/r4 instead of replaying.
alter table alert_log
  add column if not exists run_inputs jsonb;
