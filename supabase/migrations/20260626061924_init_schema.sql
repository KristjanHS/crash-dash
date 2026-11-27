-- crash-dash persistence — v4 closure Phase 1 schema, now the first versioned
-- migration (env-parity Phase E Step 2). Single source of schema truth: dev, CI,
-- and prod all apply this file (supersedes the hand-applied db/schema.sql).
--
-- Two tables, durable + remote (Supabase Postgres), reached over PostgREST by
-- src/store.ts (@supabase/supabase-js).
--
-- Why two tables, not one {lastLevel} blob: vintage capture (readings stored as
-- known at run time — a later FRED revision can't reconstruct these), alert-log
-- auditing, and in-SQL regime-relative thresholds (Phase 6). See plan §2.

-- Every reading from every run, append-only. The same (obs_date, indicator_id)
-- is re-stored on each run on purpose: run_at pins the vintage, so the revised
-- CSV can never overwrite what was known at the time.
create table if not exists readings (
  id           bigint generated always as identity primary key,
  obs_date     date             not null,  -- FRED observation date (as-of)
  indicator_id text             not null,  -- F1, F2, R1, R2, R3, R5, ...
  value        double precision not null,  -- level
  delta20      double precision not null,  -- 20-trading-day change
  raw_state    text             not null,  -- GREEN/AMBER/RED (unconfirmed)
  state        text             not null,  -- confirmed state (the one that counts)
  run_at       timestamptz      not null   -- when this run captured the reading
);

-- "Current" = latest run per indicator; "as-known history" = filter by run_at.
create index if not exists readings_obs_idx on readings (indicator_id, obs_date, run_at desc);
create index if not exists readings_run_idx on readings (run_at desc);

-- One row per run's verdict, append-only. getLastAlert() reads the newest row;
-- Phase 2 notify-on-change compares against it.
create table if not exists alert_log (
  id          bigint generated always as identity primary key,
  obs_date    text        not null,  -- as-of date of the run's data
  alert_level text        not null,  -- OK/WATCH/WARNING/CRITICAL
  fin         integer     not null,  -- FIN_score
  rate        integer     not null,  -- RATE_score
  geo_flags   integer     not null,  -- active manual-flag count
  coincident  text        not null,  -- COINCIDENT_flag (GREEN/AMBER/RED)
  fin_reds    integer     not null,  -- # Red financing indicators
  fired_at    timestamptz not null   -- when this run fired
);

create index if not exists alert_log_fired_idx on alert_log (fired_at desc);

-- RLS deny-by-default (review §5-Q6): the app reaches both tables server-side
-- with the service key, which bypasses RLS. Enabling it with NO policies means
-- any future anon/authenticated key is denied until an explicit policy is added
-- — defense-in-depth for the day a browser-side reader is introduced.
alter table readings  enable row level security;
alter table alert_log enable row level security;

-- Explicit DML grant to service_role ONLY (the app's server-side role, which
-- bypasses RLS). Self-sufficient across local/cloud rather than relying on
-- Supabase default privileges. anon/authenticated get NO grant — combined with
-- RLS-on, both tables are double-locked to any browser-side key ("no anon DB
-- access", review §5-Q6).
grant select, insert, update, delete on readings, alert_log to service_role;
