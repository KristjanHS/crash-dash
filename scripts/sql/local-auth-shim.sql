-- Local-stack ONLY — applied by scripts/ci-stack.sh (CI) and scripts/db.sh (dev) after every
-- bring-up. NEVER a migration: on hosted Supabase the `auth` schema is owned by GoTrue, which
-- already installs exactly these bodies (plus `auth.jwt()`), so shipping them would fight the
-- owner for nothing.
--
-- Why it exists: the local `supabase/postgres` image's init script defines `auth.uid()`,
-- `auth.role()` and `auth.email()` against the LEGACY per-claim GUCs (`request.jwt.claim.sub`,
-- …) that PostgREST ≥ v9 no longer sets — it publishes one JSON GUC, `request.jwt.claims`.
-- GoTrue's own migrations upgrade the three to the `coalesce(legacy, claims ->> …)` form on
-- hosted projects. The local config long ran with GoTrue disabled, and without this shim every
-- RLS policy keyed on `auth.uid()` then evaluates to NULL locally under an `authenticated` JWT —
-- silently denying the very rows prod would serve. With `[auth]` now enabled it is a same-body
-- re-apply, kept so a stack whose GoTrue has not migrated yet still gets the upgraded bodies.
--
-- Bodies mirror GoTrue's (`20220317141400_add_email_to_uid_and_role`-era) definitions verbatim:
-- legacy claim first, JSON claims second, so both PostgREST generations keep working.
-- `create or replace` = idempotent; safe to re-run on every stack start. Runs as `supabase_admin`
-- (the image superuser): `postgres` is NOT superuser locally and gets "permission denied for schema auth".

create or replace function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.email() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

-- Hosted projects also expose `auth.jwt()` (the whole claims object). Provide it locally so a
-- migration written against prod's helper set applies here too — guarded, so this file stays a
-- no-op wherever GoTrue has already installed the real one.
create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
