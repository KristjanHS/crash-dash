-- crash-dash — compact `alert_log.panel_state->'cissHistory'` to one G/A/R string per id.
--
-- The persisted CISS window was 40 ids × 90 full `SeriesPoint`s ≈ 576 KB per row — 96 % of the row —
-- while every reader of it uses only `.length` and `pt.state` (`MemberHistoryEntry`, src/danger-engine.ts).
-- The write path now stores `[{ id, states: "GAR…" }]` (`encodeCissHistory`, src/store-rows.ts) and
-- `rowToAlert` expands it back; this rewrites the rows written BEFORE that deploy so the `backups`
-- branch snapshot shrinks too (alert_log pages are kept verbatim there — new-rows-only never shrinks it).
--
-- Shape mapping, per entry `{ id, history: [{ state, … }] }` → `{ id, states }`: the first letter of each
-- `state` (GREEN/AMBER/RED → G/A/R) in array order, so `length(states)` = the old point count and
-- position i is close i. `date`, `value`, `delta20`, `rawState`, `decision` are dropped — no reader
-- of the persisted copy ever touched them.
--
-- Idempotent: the WHERE matches only the legacy shape (first entry has a `history` key); a rewritten
-- row's first entry has `states` instead and is skipped. Rows with a null panel or an empty
-- `cissHistory` (`->0` is null ⇒ `?` is null ⇒ not matched) are untouched. The decoder accepts both
-- shapes until this has landed on prod, so ordering against the deploy is not load-bearing for the
-- cron; a `/api/lab` panel read of a rewritten row by the OLD code fails until the deploy takes the
-- alias (accepted, plan R4).
--
-- destructive: reviewed rewrites alert_log.panel_state->'cissHistory' in place for every legacy-shape
-- row (431 on prod 2026-09-05), dropping the per-close date/value/delta20/rawState/decision fields
-- that no reader of the persisted copy consumes; backups branch 2026-09-05 (ff318d49) holds the
-- full-point rows should a reader for them ever be wanted.

update alert_log
set panel_state = jsonb_set(
  panel_state,
  '{cissHistory}',
  (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', e -> 'id',
          'states', coalesce(
            (
              -- `?` for a missing/null state: `decodeCissHistory` THROWS on it instead of a silent
              -- drop shifting every later close by one (string_agg skips NULLs).
              select string_agg(coalesce(left(p ->> 'state', 1), '?'), '' order by pord)
              from jsonb_array_elements(e -> 'history') with ordinality as h(p, pord)
            ),
            ''
          )
        )
        order by eord
      ),
      '[]'::jsonb
    )
    from jsonb_array_elements(panel_state -> 'cissHistory') with ordinality as x(e, eord)
  )
)
where panel_state is not null
  and jsonb_typeof(panel_state -> 'cissHistory') = 'array'
  and panel_state -> 'cissHistory' -> 0 ? 'history';
