-- crash-dash — `scorer_vintage`: per-indicator CODE vintage (config hash + hand-bumped logic
-- version) stamped at persist time; `scripts/probe-vintage-drift.ts` diffs it against the live
-- registry to decide which ids `make ship` must restate.
-- Additive + idempotent ⇒ direct-to-main path (`.claude/rules/migrations.md`).

create table if not exists scorer_vintage (
  indicator_id  text        primary key,
  config_hash   text        not null,
  logic_version integer     not null,
  stamped_at    timestamptz not null
);

-- Mirrors the init RLS block: RLS on + service_role-only DML, so a browser-side key sees nothing.
alter table scorer_vintage enable row level security;
grant select, insert, update, delete on scorer_vintage to service_role;
