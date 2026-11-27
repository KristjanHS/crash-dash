# Dashboard preview

Run and screenshot the front-end (`public/`) locally with faithful mock data —
no live Supabase or FRED needed. This is the supported "run the app" path for
`public/*.js` changes (the front-end sits outside `tsc`/`vitest`; see
`.claude/rules/frontend.md`).

```bash
npm run preview          # serve at http://localhost:4321 (set PORT=… to change)
npm run preview:live     # same UI against the REAL persisted store (.env.local Supabase)
npm run preview:check    # node --check the front-end JS (syntax gate)
npm run preview:shot     # headless screenshot + smoke check → scripts/preview/out/
npm run preview:ticks    # ledger band-cut hairlines: placement + rendered contrast
```

`preview:shot` needs the Playwright browser once: `npx playwright install chromium`.

**Runtime: every spawner of this fixture must run under `tsx`, never plain `node`.**
`mock-data.mjs` imports its indicator names from `src/*.ts` (registry) rather than
restating them, and `src/`'s `.js` import specifiers only resolve under tsc/tsx/vitest.
So the npm scripts that serve it use `tsx` directly, and the plain-`node` probes
(`screenshot.mjs`) spawn their server with `--import tsx`.
A new spawner that forgets it fails loudly at import, not silently — but copy the
`--import tsx` from an existing probe rather than rediscovering why.

## Files
- `mock-data.mjs` — single source of mock API payloads, shapes mirroring
  `src/api/types.ts` + the renderers in `public/app.js`. Names (`label`) come from
  the registry by import — a row restating one throws (see the guard in the file).
  Default scenario is
  "all calm" (every channel score 0, OK), matching the common prod state.
  Serves the off-ladder tracks' raw legs too (`SLOW_SERIES`, `PENSION_SERIES`:
  SPY/VEA/DEXUSEU) — not in `INDICATORS`, only via `/api/series` for their panels.
- `server.mjs` — zero-dependency static server for `public/` + mock `/api/*`. Its
  `/api/lab` is a STATIC all-calm fixture that ignores `?s=` — real/scenario `/lab`
  states need `preview:live`.
- `server-live.mjs` (`npm run preview:live`) — same UI against the real persisted
  store (`.env.local` Supabase); needed for `/lab` scenario states and any
  data-derived band behaviour. Seed helpers: `npm run seed:dump` (`dump-seed.sh`)
  and the `npm run preview:shift` probe alias.
- `bar-tick-check.mjs` (`npm run preview:ticks`) — the ledger band-cut hairlines
  (`.lg-bar-tick`). Boots its own mock server, mounts the REAL seam output
  (`pillarBarHtml`/`bandTicks`) in the real `/lab` document, then measures (a) each
  tick's rendered x against the percentage's containing block — the track's *padding*
  box, since `box-sizing: border-box` puts the 1px frame inside the 140px — and (b) the
  WCAG contrast of the tick's rendered pixel column against every backdrop it can sit on,
  sampled off a screenshot. Runs both the served `legRagCuts` and the `BAND_CUTS` default.
  This is the check the R4/G3 contrast bump is cited against; a markup test cannot see
  either fact. Exit-coded.
- `screenshot.mjs` — boots the mock server, drives it with Playwright, and captures
  a ~12-shot deterministic set (dashboard, indicator-detail, mode-{correction,bear,crash},
  low-signal, zone-slow, bubble-tier, lab — see `screenshot.mjs` for the
  current inventory), and reports console errors, tooltip coverage, tick-label
  overlap, that every indicator renders its detail-tab explainer (`.ind-about`),
  that the bubble-tier tab charts its 3 slow legs. Non-zero exit on any failure.

To preview a non-calm state (e.g. an amber channel), edit the `STATUS` /
`SERIES` values in `mock-data.mjs`.

## Ad-hoc probes (need `preview:live` up)
These drive the real `/lab` DOM (the mock `preview` serves `/lab` only as a static
all-calm fixture that ignores `?s=`). Start a live
server first (`npm run preview:live &`), then run the probe:
- `rrg-labels-check.mjs [baseUrl]` — asserts View C (RRG quadrant) labels don't overlap
  or escape the top edge; exit-coded, screenshot → `out/rrg-live.png`. For real-data legs
  run the cron once (`npm start`) so Live mode has a run.
