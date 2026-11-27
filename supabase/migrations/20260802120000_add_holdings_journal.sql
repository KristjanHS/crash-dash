-- crash-dash — holdings journal (W5-c / J-2 + J-3).
--
-- One row per recorded holdings decision: which ladder rung/sleeve is held, how much
-- cash sits beside it, on what date, plus a DENORMALIZED snapshot of what the dial was
-- saying at that moment and a free-text note. DEC-14 + DEC-18 ruled the field set; J-3
-- ruled the snapshot SHAPE: five flat columns for the B1/M2 measurement (which needs to
-- group and average over them in SQL) beside one jsonb blob that keeps the whole dial
-- payload for provenance across dial retunes — a flat column re-read years later means
-- whatever today's engine meant by it, the blob is what was actually served.
--
-- WRITE PATH (§E-4, which SUPERSEDES J-1's bare anon key). The browser writes DIRECTLY to
-- PostgREST — no Vercel function (the Hobby 12-cap has 4 slots of headroom and
-- `api/deploy-budget.test.ts` pins the handler count at exactly 8, so a 9th handler is not
-- available to spend). That makes the RLS policy the ONLY thing between the open internet
-- and this table, so:
--   * `anon` gets NO grant here at all. Every other table in this schema is anon-SELECT-able
--     (`20260716220000_anon_read_policies.sql`, `20260725230000_leg_pillars_anon_read.sql`)
--     precisely because those tables are machine-written and browser-read. This one is the
--     inverse and does not join that set.
--   * both SELECT and INSERT are keyed to `auth.uid()`, so a signed-in reader sees only
--     their own rows and can only write rows carrying their own id.
-- Magic-link auth is wired into `public/journal.{html,js}` ALONE; `index.html`, `lab.html`
-- and `exposure.html` keep reading anon with no login and no auth SDK.
--
-- APPEND-ONLY BY CONVENTION, NOT YET BY MECHANISM. J-5 (soft-delete / correction rows) is
-- DEFERRED, so there is deliberately no UPDATE or DELETE grant to ANY role here — not to
-- `authenticated`, not to `service_role`. A typo is fixed by a future migration that adds
-- the correction mechanism, never by a hand-run statement against irreplaceable history.
create table if not exists holdings_journal (
  id             uuid primary key default gen_random_uuid(),
  -- The owning auth user. Sent by the client and CHECKED against auth.uid() by the insert
  -- policy below, so a forged id is rejected rather than trusted.
  user_id        uuid not null,
  -- The date the holding decision applies to (user-chosen — it can lag the entry itself).
  entry_date     date not null,
  -- The held leg, spelled as the ladder sleeve name, plus its 1..9 rung. Both are stored:
  -- the sleeve is what the user recognises, the rung is what sorts and subtracts.
  sleeve         text not null,
  rung           smallint not null check (rung between 1 and 9),
  -- Cash beside the leg, in percent of the account (0..100).
  cash_pct       double precision not null check (cash_pct >= 0 and cash_pct <= 100),
  note           text not null default '',

  -- ---- Denormalized dial snapshot (J-3): flat columns for measurement ----------------
  -- What the dial SUGGESTED at the moment of writing, against which `rung` above is the
  -- action actually taken. Nullable as a set: a pre-first-cron or degraded read serves no
  -- dial, and a row written then is still a real journal entry.
  suggested_rung double precision,        -- the dial's target rung (continuous)
  band           text,                    -- the dial's notify band / regime label
  armed          boolean,                 -- two-key #1: an ARM/leading family firing
  fired          boolean,                 -- two-key #2: a FIRE/coincident family firing
  severity       text,                    -- the alert-ladder level (OK/WATCH/WARNING/CRITICAL)
  -- ---- Provenance blob: the served payload the five columns above were read off --------
  dial           jsonb,

  created_at     timestamptz not null default now()
);

-- The only reader is "my last N entries, newest first" (J-4's list). The primary key's
-- leading `id` cannot serve that.
create index if not exists holdings_journal_recent_idx
  on holdings_journal (user_id, entry_date desc, created_at desc);

-- RLS on, same deny-by-default posture as every other table here — but unlike them this
-- one carries policies, because the browser (not the server) is the client.
alter table holdings_journal enable row level security;

-- destructive: reviewed — the two DROPs below are `drop policy if exists` on the two
-- policies this same file re-creates immediately after (Postgres has no
-- `create policy if not exists`, so this is the house idempotency idiom —
-- `20260725230000_leg_pillars_anon_read.sql`). They are catalog-only and touch no row;
-- nothing in this file reads, rewrites or removes data, so no snapshot precedes it.
drop policy if exists holdings_journal_owner_read on holdings_journal;
create policy holdings_journal_owner_read on holdings_journal
  for select to authenticated using (user_id = auth.uid());

drop policy if exists holdings_journal_owner_insert on holdings_journal;
create policy holdings_journal_owner_insert on holdings_journal
  for insert to authenticated with check (user_id = auth.uid());

-- Grants: `authenticated` may read and append, nothing more. `service_role` (which
-- bypasses RLS) gets the same two verbs so an operator read stays possible without
-- handing anyone a way to rewrite history. `anon` is granted NOTHING — combined with
-- RLS-on that leaves the table invisible to the browser until a real login.
grant select, insert on holdings_journal to authenticated;
grant select, insert on holdings_journal to service_role;
