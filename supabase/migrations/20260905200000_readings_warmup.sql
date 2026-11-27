-- crash-dash — `readings_warmup`: scorer INPUT below the first emitted reading for `warmup: true`
-- db-first seam sites.
--
-- Why a separate table, not nullable `readings` columns: the warm-up head is raw feed values the
-- scorer BURNS (CG's expanding percentile + trend window = 331 rows) and never scores, so it must
-- not appear in `readings_latest` / `/api/series` / the danger path. Only the seam's read/count and
-- the two probes see it. NOT vintaged — upsert on the pk, feed wins (scorer input, never a scored
-- reading). Additive + idempotent ⇒ direct-to-main path (`.claude/rules/migrations.md`).

create table if not exists readings_warmup (
  id           bigint      generated always as identity unique, -- keyset page key for scripts/backup/dump.ts
  indicator_id text        not null,
  obs_date     date        not null,
  value        double precision not null,
  run_at       timestamptz not null,
  primary key (indicator_id, obs_date)
);

-- Mirrors the init RLS block: RLS on + service_role-only DML, so a browser-side key sees nothing.
alter table readings_warmup enable row level security;
grant select, insert, update, delete on readings_warmup to service_role;
