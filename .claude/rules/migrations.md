---
paths:
  - "supabase/migrations/**"
---
# Migrations apply to prod LOCALLY via `make ship` (auto-apply-on-merge removed 2026-07-19)

Editing or adding a file here means: it applies to prod when you run **`make ship`** (→
`scripts/migrate-prod-local.sh`: link → destructive gate → `supabase db push --include-all` → drift
verify). Auto-apply-on-CI-merge was removed to keep prod DDL off CI minutes — **a plain `git push` of a
migration NO LONGER applies it.** Running `make ship` stales any `project_state` line asserting
migration state; a pushed-but-not-shipped migration sits unapplied until shipped.

On touching a migration:
- **Apply it to the local dev stack + run the DB-backed suite in the SAME session that authors it** — never commit the DDL and leave a "pending ship" line for the user's `make ship` to first surface — the failure then lands loudly and late (the `dial_state` migration `20260721120000` shipped code writing a column whose DDL sat unapplied → prod cron failed `column alert_log.dial_state does not exist`; the local stack silently lacked it too). For an idempotent additive migration apply directly — `docker exec supabase_db_crash-dash psql -U postgres -d postgres -c "<the ALTER>"`, **never `supabase db reset`** (wipes irreplaceable dev data). Then `make ship` CONFIRMS what you verified locally instead of discovering it.
- Mark `project_state`'s migration line **"pending ship"** (falsifier form — name its check).
- Apply it with `make ship` (or, break-glass, dispatch the optional operator-side migrate job, README §Scheduled jobs and leg runs).
- Reconcile with `./scripts/verify-migration-state.sh` — but **only from a supabase-LINKED checkout**. From
  a **linked** worktree (wherever it lives) there is no `supabase/.temp/project-ref`, so it prints
  `RECONCILE-SKIPPED` and exits 0: that output is **no evidence of anything**, and reading it as "pending
  ship" blocked a stage for nothing on 2026-07-20. Query the linked main checkout instead:
  `npx supabase migration list --linked --output-format text --workdir ~/projects/crash-dash`.
  `migration list --linked` is the authoritative source — **NOT** `db diff`. An optional operator-side migration-drift check is the automated safety net
  that flags a migration pushed but never applied.

**Prove a destructive RPC inside a `ROLLBACK`ed psql transaction with synthetic fixtures** — never by
waiting for real rows to qualify. A gate you can only observe when production data happens to reach the
eligibility floor is a false falsifier: it reads green forever, including when the RPC is broken. Insert
rows that hit each branch (eligible / floored / out-of-scope), call the function, assert the row counts,
then `ROLLBACK`.

**No PITR and no down-migrations**, so a rollback is a NEW timestamped forward-fix migration that undoes
the bad change, never an edit of an applied file — except a comment-only edit (SQL byte-identical; `verify-migration-state.sh` compares versions only).

**Preview a destructive migration before it applies.** No apply path runs a `db push --dry-run`
preview (no `pull_request` trigger), so run it locally first; a DROP / non-additive ALTER / data-lossy
backfill applied without it lands unseen. Additive migrations (ADD COLUMN, CREATE INDEX IF NOT
EXISTS, widening ALTER TYPE) are safe without it.

## Destructive is a property of the migration BODY

Any migration whose body contains `DELETE` / `TRUNCATE` / `UPDATE` / `DROP` / `ALTER … TYPE` is destructive
**even when the statement wrapping it is additive-looking** — in particular `create or replace function`,
which rewrites the live write path without a single DROP or ALTER.

**This is now ENFORCED, not remembered** (Stage 2.1). The apply path runs
`scripts/check-destructive-migrations.ts` over the pending migrations before the apply step — the LOCAL
default (`make ship` → `scripts/migrate-prod-local.sh`); an optional operator-side break-glass migrate job
must run it too — so a destructive body fails the apply unless the file carries

```sql
-- destructive: reviewed <what it destroys; which snapshot precedes it>
```

The reason is required — a bare `-- destructive: reviewed` is rejected. Both paths also print the
`db push --dry-run` delta before applying, so nothing lands unseen; a PR previews it in the
check log too, and `workflow_dispatch` is ungated (a human applying deliberately).

**Never call `auth.jwt()` in a migration** — a local stack that has not run `scripts/sql/local-auth-shim.sql`
lacks it; read `current_setting('request.jwt.claims', true)::jsonb ->> …` instead.

**`record_run` maps `alert_log` columns by name.** A new column needs NO `record_run` re-create (JSON keys
map by name; an unknown/misspelled key raises loudly). A round-trip test must therefore go through
`recordRun`, not `recordAlert` (which still writes every column itself). Which delete regime is live —
delete-on-write or append-only — is answered by `./scripts/verify-migration-state.sh`, never by prose.
