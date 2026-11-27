-- crash-dash — manual-override log (D9 live scoreboard, Fork 2 — USER decision
-- 2026-07-15: migration-backed table over config.json / render-only stub).
--
-- One row per manual override of the rotation guidance: the user acted against
-- (or outside) the prescribed leg on `obs_date`. Gate (b) of the D9 scoreboard
-- counts rows with obs_date in the trailing 365 calendar days against the D7 B1
-- budget (B1_OVERRIDES_PER_YEAR). Recording affordance for now = manual insert
-- (Supabase SQL editor / psql one-liner); an in-UI control is a deferred rung.
--
-- Append-only by usage: the app only ever reads (store.ts getOverrides); writes
-- are manual, service-role-side.
create table if not exists overrides (
  id         bigint generated always as identity primary key,
  obs_date   date        not null,  -- the trading day the override applied to
  note       text,                  -- free-form why (nullable)
  created_at timestamptz not null default now()
);

-- Gate (b) reads a trailing-365d window keyed on obs_date.
create index if not exists overrides_obs_idx on overrides (obs_date desc);

-- RLS deny-by-default (same posture as readings/alert_log/calibration): the app
-- reads server-side with the service key, which bypasses RLS. Enabling it with
-- NO policies means any future anon/authenticated key is denied until an
-- explicit policy is added.
alter table overrides enable row level security;

-- Explicit DML grant to service_role ONLY (bypasses RLS). anon/authenticated get
-- NO grant — combined with RLS-on, the table is double-locked to any
-- browser-side key (mirrors the init-schema grants, not drifted prod state).
grant select, insert, update, delete on overrides to service_role;
