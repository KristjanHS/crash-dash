-- crash-dash — anon SELECT on `intraday_verdict` + `readings_warmup` (the Sec-B3 pattern, 20260716220000).
--
-- Both tables shipped RLS-on with a service_role-only grant, but the read handlers run on
-- `getStore("ro")` (the anon key), so to them both tables read as empty:
--   * `intraday_verdict` (20260930120000): `servedVerdict` never saw the slot, so /api/lab, /api/status
--     and /api/exposure served the EOD row all day; the intraday + estimated Families board, Danger
--     ledger and floors never reached prod.
--   * `readings_warmup` (20260905200000): /api/series' CG re-score (`resolveDbFirstArm`) ran without
--     the warm-up head that the run path stamps its cuts over.
-- Both are public market/verdict data of the same class as `readings` / `alert_log`. Additive + idempotent.
-- Pinned by `scripts/anon-read-coverage.test.ts`.
--
-- destructive: reviewed `drop policy if exists` re-creates only this file's own two policies (idempotent re-run); no row, column or table is touched, so no snapshot is needed.

drop policy if exists intraday_verdict_anon_read on intraday_verdict;
create policy intraday_verdict_anon_read on intraday_verdict for select to anon using (true);
grant select on intraday_verdict to anon;

drop policy if exists readings_warmup_anon_read on readings_warmup;
create policy readings_warmup_anon_read on readings_warmup for select to anon using (true);
grant select on readings_warmup to anon;
