-- crash-dash — self-prune of shadowed vintages (backup plan Rung 4).
--
-- Backfill passes (backfill-slow especially) INSERT whole histories under a fresh
-- run_at, shadowing the prior vintage in readings_latest but leaving it on disk —
-- ~15k dead rows per pass, the 441k→117k bloat pruned one-off on 2026-07-16. This
-- function is that same prune as a reusable primitive: for the given indicator_ids,
-- keep per (indicator_id, obs_date) one row: max run_at, tie-break max id. The
-- readings_latest view has NO id tie-break (run_at ties are served plan-dependently);
-- the prune resolves such ties to max id, making the view deterministic afterwards. The backfill runner calls it after every pass, so the table
-- stays at ~1 vintage per pair between passes.
--
-- Deliberately NOT a UNIQUE(indicator_id, obs_date) + upsert: upsert mutates rows
-- in place, which the incremental backup's count-guard cannot detect (rows must
-- stay immutable; deletes are what it is built to catch). Write-then-delete keeps
-- the live path INSERT-only.
create or replace function prune_shadowed_readings(p_ids text[])
returns integer
language plpgsql
security invoker
as $$
declare
  deleted integer;
begin
  delete from readings d
  using readings k
  where d.indicator_id = any(p_ids)
    and k.indicator_id = d.indicator_id
    and k.obs_date = d.obs_date
    and (k.run_at > d.run_at or (k.run_at = d.run_at and k.id > d.id));
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

-- Reached server-side with the service key only, same posture as record_run.
grant execute on function prune_shadowed_readings(text[]) to service_role;
