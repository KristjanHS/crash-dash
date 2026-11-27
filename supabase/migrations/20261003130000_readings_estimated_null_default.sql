-- A pre-20261003120000 build's record_run payload omits `estimated` ⇒ jsonb_populate_recordset NULL ⇒ 23502;
-- coerce NULL → false (a final row) so an old build keeps writing across the deploy/rollback window.
-- destructive: reviewed `drop trigger if exists` only re-creates this file's own trigger (idempotent); no row is deleted or updated.

create or replace function readings_estimated_default()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.estimated := coalesce(new.estimated, false);
  return new;
end;
$$;

drop trigger if exists readings_estimated_default on readings;

create trigger readings_estimated_default
before insert on readings
for each row execute function readings_estimated_default();
