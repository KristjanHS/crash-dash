-- crash-dash — anon reads nothing in schema public; every data read goes through /api/* on the service key.
-- destructive: reviewed drops the 7 anon SELECT policies only (no rows, columns or functions); the grants they served are revoked below
-- Falsifier: scripts/prod-sql-ro.sh "select count(*) from information_schema.role_table_grants where grantee='anon' and table_schema='public'" → 0, and
-- "select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and has_function_privilege('anon', p.oid, 'execute')" → ∅.

drop policy if exists readings_anon_read on readings;
drop policy if exists alert_log_anon_read on alert_log;
drop policy if exists calibration_anon_read on calibration;
drop policy if exists overrides_anon_read on overrides;
drop policy if exists leg_pillars_anon_read on leg_pillars;
drop policy if exists intraday_verdict_anon_read on intraday_verdict;
drop policy if exists readings_warmup_anon_read on readings_warmup;

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;
-- PUBLIC's default EXECUTE reaches anon too; authenticated + service_role keep their explicit grants.
revoke all on all functions in schema public from public;

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;
-- The GLOBAL default (EXECUTE to PUBLIC on every new function) is untouched by the per-schema lines above.
alter default privileges revoke execute on functions from public;
