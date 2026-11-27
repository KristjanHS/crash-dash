-- crash-dash Phase 3 — weekly re-assert.
--
-- A stuck alert (>= WARNING that never rises further) never re-fires under
-- notify-on-upward-change (Phase 2). To re-assert it weekly we need to know when
-- we last *pushed*, which is distinct from `fired_at` (set on EVERY run): a run
-- that records its verdict silently (same-level / downgrade) does not push.
--
-- `pushed_at` is null on a silent run, and the run's timestamp on a run that
-- pushed. The re-assert reads the newest non-null `pushed_at` to decide whether
-- >= 7 days have elapsed since the last notification.
alter table alert_log add column if not exists pushed_at timestamptz;

-- Partial index: the re-assert query only ever scans rows that actually pushed.
create index if not exists alert_log_pushed_idx on alert_log (pushed_at desc) where pushed_at is not null;
