-- crash-dash — anon SELECT on leg_pillars (EW W4 Stage 4.3 review, C1 follow-on).
--
-- WHY THIS EXISTS. `20260725220000_add_leg_pillars.sql` created the table with RLS ON,
-- ZERO policies and a service_role-only grant — the correct deny-by-default posture for
-- a table nothing read yet. Stage 4.3 then made `/lab` read it: `api/lab.ts` calls
-- `getStore("ro")`, i.e. the least-privilege ANON key (Sec-B3, store.ts getStore), so
-- every `getLegPillarSeries` call in prod would come back "permission denied for table
-- leg_pillars" — and `ewPctCell` degrades a failed read to `{kind:"warmup"}`, so the
-- board would paint `(—)` on all nine legs FOREVER with the table fully populated.
-- `checkSchema` also probes with the anon key, so /health reports it too.
--
-- Exactly the same shape as `20260716220000_anon_read_policies.sql`: SELECT only, no
-- insert/update/delete policy and no write grant, so the anon key stays read-only by
-- construction. Policies are dropped-then-created for idempotent re-apply (Postgres has
-- no `create policy if not exists`); grants are naturally idempotent.
--
-- ADDITIVE to DATA — it adds a read policy and a SELECT grant, and touches no row. The one
-- DROP below is a `drop policy if exists` (catalog-only, re-created two lines later), which is
-- why the sentinel is still required; it is not a contradiction of this line.
-- destructive: reviewed — the only DROP is `drop policy if exists` on the policy this
-- same file re-creates two lines later (Postgres has no `create policy if not exists`);
-- it touches no rows, so no snapshot precedes it.

drop policy if exists leg_pillars_anon_read on leg_pillars;
create policy leg_pillars_anon_read on leg_pillars for select to anon using (true);
grant select on leg_pillars to anon;
