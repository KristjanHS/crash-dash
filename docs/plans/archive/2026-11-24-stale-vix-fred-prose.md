# Stale VIX-from-FRED prose sweep

**Status:** ✅ SHIPPED 2026-11-25 · **Opened:** 2026-11-24 · **Scope:** comments/docs only (no behaviour change)

## Why

`REFUSED_SERIES` (`src/fred-series-policy.ts`) now makes `fetchSeries` throw
`NoFreeSourceError` for **VIXCLS / VXVCLS / VXNCLS** before any routing. A later commit then deleted the
unreachable exchange-first route and its fallback plumbing, and fixed `src/vix_term.ts` and
`src/fred-series-policy.test.ts`. Prose elsewhere still claims these ids are fetched/served live
(from FRED, "keyless", "fetched ONCE per run", etc.). In production every consumer of these ids runs
degraded every cycle. VXSMH is the only id with a vol-index route (an exchange-only symbol map), and the
production `fetchVolIndexCloses` port throws `NoFreeSourceError` too (`src/feed-ports.ts`).

Not a CI issue. Found by a keyword grep over non-test files in `src/`, `scripts/`, `docs/` (archive
excluded) on 2026-11-24 — likely but not guaranteed complete; re-grep before closing.

## Hits (line numbers as of 2026-11-24)

- [ ] `src/tracks.ts:156` — "VIXCLS (keyless FRED, full history…)"; `:205` — "pre-fetched same-vendor (FRED) VIXCLS + VXVCLS legs"
- [ ] `src/registry-composite.ts:144` — "keyless FRED VIXCLS + VXVCLS via vix_term.ts"; `:172` — "comes from FRED VIXCLS/VXVCLS"; `:457` — "VXNCLS … keyless FRED level"
- [ ] `src/registry-price.ts:643, :658, :664, :789` — "scored from keyless FRED VIXCLS"; "both ride the SAME keyless FRED series"
- [ ] `src/market-closures.ts:172` — "R5 (VIXCLS) is fetched through FRED but its same-day head is grafted off …"
- [ ] `src/api/types.ts:628` — companion VIXCLS "served live off the keyless feeds"
- [ ] `src/run-cycle-feeds.ts:212` — "VXNCLS (FRED Nasdaq-100 vol)" (the `degradeMsg` string at `:216` is code — decide separately)
- [ ] `src/run-cycle-confirmers.ts:101, :103` — "fetched ONCE per run"; "per-run FRED memo ⇒ one fetch"
- [ ] `src/confirmers.ts:398, :444, :826` — VIXCLS/VXVCLS/VXNCLS "fetched ONCE per run" / "one fetch"
- [ ] `src/run-dbfirst.ts:251-259` — "The single VIXCLS/VXVCLS fetch on THIS path…", "THREE independent VIXCLS pulls"
- [ ] `scripts/backfill-slow.ts:68` — "Production feeds: keyless FRED VIXCLS (full history)"
- [ ] `scripts/ladder-replay-feeds.ts:102-103` — labels "FRED VIXCLS", "FRED VIXCLS ÷ VXVCLS" (its `fred()` helper goes through `realFeeds.fetchSeries`, so calls are refused; only labels stale)
- [ ] `scripts/restate-policy.ts:221` — "R5=VIXCLS (… VIX …" — may be a historical note; check
- [ ] `scripts/probe-readpath-lag.ts:63-64` — "VIXCLS still FRED" — may be historical; check
- [ ] `docs/bigtech-crash-dashboard-design-v4.md:123` — R5 row lists source "FRED `VIXCLS`"

Code strings (not comments) that say "from FRED": `src/vix_term.ts` `onFail` message (~line 61),
`src/run-cycle-feeds.ts:216` `degradeMsg`. Changing them changes logged/persisted degrade text —
check whether anything (tests, `public/`, probes) matches on them before editing.

## How to do it

1. Re-grep: `git grep -nE 'VIXCLS|VXVCLS|VXNCLS' -- src scripts docs ':!docs/**/archive/**' ':!*.test.ts'` and read each hit.
2. Rewrite each to the true state: refused at the FRED seam by `REFUSED_SERIES`, consumer degrades
   every run. Keep genuine history notes, but mark them as past tense ("until the refusal landed …").
3. Comments only, unless step "Code strings" above is decided. `npx tsc --noEmit` and
   `npm run coverage -- --silent` stay green.
4. Close: `git mv` this file into `docs/plans/archive/`.
