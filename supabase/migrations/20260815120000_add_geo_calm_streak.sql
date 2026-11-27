-- crash-dash — auto-geo crisis stage: persist the
-- calm streak the 1→0 / 4→0 stand-down dwell reads.
--
-- ADDITIVE ONLY: one nullable `add column if not exists` — safe on the direct-to-main path, no
-- `-- destructive: reviewed` marker needed. No `record_run` re-create: columns map by name.
--
--   geo_calm_streak — consecutive scored closes with all stage-trigger ids confirmed GREEN.
--                     NULLABLE: null on pre-migration rows ⇒ the read path seeds "assume calm".
alter table alert_log add column if not exists geo_calm_streak integer;
