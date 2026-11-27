-- crash-dash — per-leg super-group pillar history (EW W4 Stage 4.2).
--
-- One row per (trading day × leg × super-group): the replayed `PillarScore` the
-- danger engine emits for that leg's EARLY-WARN / STRESS-NOW sub-danger. Written
-- by the `legpillars` backfill job (Stage 4.2.4) over `replayLegPillars`; read by
-- the rolling-ECDF percentile served on `/lab`'s leg rows (Stage 4.3).
--
-- `value` is nullable BY DESIGN: an `uncomparable` pillar (structural / not-live)
-- carries no number, and that absence is data, not a gap to impute as 0.
--
-- `generator` sits in the PRIMARY KEY deliberately: a regenerated formula vintage
-- CO-EXISTS with the old rows rather than destroying them (dev-DB history is
-- irreplaceable; nothing in W4 deletes or restates a row). Stage 4.2 writes the
-- literal "ew-v0"; Stage 4.4 replaces the value with a computed formula vintage
-- and relies on the two co-existing under the same (obs_date, sleeve, super_group)
-- prefix.
create table if not exists leg_pillars (
  obs_date    date not null,
  sleeve      text not null,
  super_group text not null,
  value       double precision,      -- null ⇒ uncomparable that day
  estimated   boolean not null,      -- the number is partly imputed reach
  basis       text not null,         -- roster: sorted member-ids of the capable families
  generator   text not null,         -- engine-formula vintage (Stage 4.4)
  primary key (obs_date, sleeve, super_group, generator)
);

-- The reader is always a single (sleeve, super_group, generator) series ordered by
-- obs_date; the PK's leading obs_date column can't serve that prefix.
create index if not exists leg_pillars_series_idx
  on leg_pillars (sleeve, super_group, generator, obs_date);

-- RLS deny-by-default (same posture as readings/alert_log/calibration/overrides):
-- the app reads server-side with the service key, which bypasses RLS. Enabling it
-- with NO policies means any future anon/authenticated key is denied until an
-- explicit policy is added.
alter table leg_pillars enable row level security;

-- Explicit DML grant to service_role ONLY (bypasses RLS). anon/authenticated get
-- NO grant — combined with RLS-on, the table is double-locked to any
-- browser-side key.
--
-- destructive: reviewed — the DELETE/UPDATE tokens below are PRIVILEGE NAMES in a
-- `grant` on a table this same file creates empty; no statement here reads, deletes or
-- rewrites a row, so no snapshot precedes it.
grant select, insert, update, delete on leg_pillars to service_role;
