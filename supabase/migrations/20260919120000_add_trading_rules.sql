-- crash-dash — trading rules.
-- One row per VERSION of a rule: rule_key is stable across revisions, version increments.
-- WRITE PATH (§E-4): browser writes DIRECTLY to PostgREST — no Vercel handler.
-- RLS: anon gets NO grant. SELECT/INSERT keyed to auth.uid() only. Every other table in this
--      schema is anon-SELECT-able because it is machine-written and browser-read; this one is the
--      inverse — the RLS policy is the ONLY barrier between the open internet and this text.
-- APPEND-ONLY: no UPDATE and no DELETE grant to any role, service_role included. Retire = insert a
--      version with retired = true. Revise = insert a new version. Nothing overwrites a wording.
create table if not exists trading_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  rule_key text not null,
  version smallint not null check (version >= 1),
  mistake text not null default '',
  cost text not null default '',
  rule text not null check (length(btrim(rule)) > 0),
  tags text[] not null default '{}',
  retired boolean not null default false,
  -- provisioned for the published-catalog increment: 'own' vs an adopted catalog entry + its id.
  -- Slice 1 writes the default and reads neither.
  source text not null default 'own',
  source_key text,
  created_at timestamptz not null default now(),
  unique (user_id, rule_key, version)
);
create index if not exists trading_rules_live_idx on trading_rules (user_id, rule_key, version desc);
alter table trading_rules enable row level security;
-- destructive: reviewed — the two DROPs below are `drop policy if exists` on the two policies
-- this same file re-creates immediately after (Postgres has no `create policy if not exists`, so
-- this is the house idempotency idiom — `20260802120000_add_holdings_journal.sql`). They are
-- catalog-only and touch no row; the table itself is created by this file, so nothing exists to
-- destroy and no snapshot precedes it.
drop policy if exists trading_rules_owner_read on trading_rules;
create policy trading_rules_owner_read on trading_rules for select to authenticated using (user_id = auth.uid());
drop policy if exists trading_rules_owner_insert on trading_rules;
create policy trading_rules_owner_insert on trading_rules for insert to authenticated with check (user_id = auth.uid());
grant select, insert on trading_rules to authenticated;
grant select, insert on trading_rules to service_role;
