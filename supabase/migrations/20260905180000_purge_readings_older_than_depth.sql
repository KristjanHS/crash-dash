-- crash-dash — one-shot purge of `readings` rows deeper than each id's seed depth
-- (USER ruling 2026-09-05: 3y default, few exceptions).
--
-- destructive: reviewed deletes readings rows older than the id's seed depth — 3y default, F3 15y, OAT/F7 4y, F16 5y, CG untouched; the `backups`-branch tag `pre-3y-purge` (taken before `make ship`) is the only copy of the deleted rows
--
-- The per-id depths below are a COPY of `BACKFILL_WINDOW` (scripts/backfill.ts) — a `years` override
-- deeper than `BACKFILL_YEARS` gets its own row; day-bounded overrides (EURC/BUND) resolve shallower
-- than the default and ride it. `supabase/migrations/purge-depth-parity.test.ts` derives the expected
-- rows from the TS constants and fails when this file drifts. CG is EXCLUDED outright — its depth is
-- ruled elsewhere, not here.
-- Ships with the 3y code (the OLD deploy's DB-first shallow check would re-deepen the FRED series).

-- 1. Exception ids: their own depth.
with depth(indicator_id, years) as (
  values ('F3', 15), ('F16', 5), ('F7', 4), ('OAT', 4)
)
delete from readings r
 using depth d
 where r.indicator_id = d.indicator_id
   and r.obs_date < current_date - make_interval(years => d.years);

-- 2. Every other id: the shared default. CG is neither here nor above.
delete from readings
 where obs_date < current_date - interval '3 years'
   and indicator_id not in ('F3', 'F16', 'F7', 'OAT', 'CG');
