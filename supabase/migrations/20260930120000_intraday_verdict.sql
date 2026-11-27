-- crash-dash — `intraday_verdict`: the ONE provisional (daytime, pre-21:05 UTC) run's assembled
-- verdict, persisted as the same jsonb shape `alert_log` takes (`alertRow`), so `/api/lab` can serve
-- the intraday fold / dial / floors / field while the push, `/status` and every notify baseline keep
-- reading `alert_log` (a retired plan, L1/E1).
-- Singleton (`id = true`): each intraday run overwrites it; the EOD run clears it.
-- Additive + idempotent ⇒ direct-to-main path (`.claude/rules/migrations.md`).

create table if not exists intraday_verdict (
  id      boolean     primary key default true check (id),
  run_at  timestamptz not null,
  row     jsonb       not null
);

-- Mirrors the init RLS block: RLS on + service_role-only DML, so a browser-side key sees nothing.
alter table intraday_verdict enable row level security;
grant select, insert, update, delete on intraday_verdict to service_role;
