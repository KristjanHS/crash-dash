---
paths:
  - "public/**"
---
# Front-end (`public/`)

Unbundled browser ESM, **outside `tsc`** — a green `npm run check` says nothing about whether the dashboard
paints. Gate via `node --check` (`npm run preview:check`) + review + a browser check.
**`impeccable` runs as a sub-agent** (never inline), instructed to skip accessibility and keep output concise.

## Testable slices go in a pure seam module
A DOM-free slice of FE logic IS unit-testable: factor it into a plain `public/*.js` module and add a **plain
`.js`** test (`public/<name>.test.js`) — vitest's default glob collects it while `tsc` (`allowJs` off) ignores
it, so coverage with **no jsdom**. `lab.js`/`app.js` execute module-level DOM/`localStorage` side effects, so
markup logic needing tests goes in a pure seam module (`tile-members.js`, `scoreboard-card.js` pattern) and
is **never imported from `lab.js` in a test**. Anything touching real DOM/tap stays in the Playwright harness
(`scripts/preview/screenshot.mjs`).
**A move-only extraction retargets every location-pinned source-scan guard** (tests that grep `lab.js`/`app.js` for a
literal) to the new seam file in the same commit, assertions intact — otherwise they pass vacuously on the emptied source.

## A `public/*.test.js` importing a TS module must NOT use a `.js` specifier
`../src/families.ts` or extensionless `../src/families` — **never** `.js`, the inverse of the repo's TS
import convention (`dev-workflow.md` §Import convention), which governs TS sources compiled for Node ESM.
Vite resolves a plain `.js` test file's specifier **literally**, so `../src/families.js` fails to load
("Does the file exist?") and the suite reports `no tests` — a collection error, not a failure, easy to
misread. Either surviving form works: explicit `.ts` (`leading-name.test.js`, `indicator-desc.test.js`,
`cash-precedence-parity.test.js`) or extensionless, letting vite's default resolver pick the `.ts`
(`detail-chart.test.js`). **`.test.js`-only** — a `public/*.test.ts` is a TS importer and follows the normal
`.js` convention (`prose-names.test.ts`). Reach for it whenever an FE test must pin against
a server-side source of truth (an enum/union, a registry) rather than re-typing it — a hand-copied mirror
guards only one direction.

## A markup test proves classes are EMITTED, never STYLED or PLACED
Every class a seam emits must resolve to a selector in `styles.css` or the page's scoped `<style>`, and
the host element must land in the right grid slot — five green markup tests shipped an invisible section.
A new seam adds a row to `public/class-coverage.test.js` (dynamic suffixes enumerated, deliberately-unstyled seams allowlisted there) — never a hand-rolled sweep.
**Live-only seams (`band`, `bandReason`, `cashOverlay`) render `""` under scenario/replay fixtures**, so no
fixture ever exercises their populated markup — a source-level parity check is the only automated cover.

## Inline style attributes are dead in prod — geometry and tone both ride the seam
prod serves `style-src 'self'` with no `'unsafe-inline'` (`vercel.json`), so the browser DROPS a style
attribute in generated markup and the element paints its **stylesheet default** — silently, on prod only:
a track fill defaults to full width, i.e. every bar reads "at its gate". Shipped that way on five sites in
four files before anyone saw it (2026-08-20). CSSOM (`el.style.setProperty`) and SVG presentation
attributes (`fill=`/`stroke=`) are NOT governed by the directive — only markup.

- **A computed percentage** (bar width, tick/mark position) → `posAttrs({left,top,width})` from
  `inline-pos.js`; `setHTML` applies it through CSSOM in the same task as the write. Never hand-type
  `data-css-*` — the attribute names are one table.
- **A tone from a fixed set** (RAG, ladder level, pair hue) → a CLASS, styled in the sheet. A colour
  CONSTANT (`STATE_COLORS`, `ALERT_COLORS`, `PAIR_HUES`) may reach only CSSOM or an SVG attribute; markup
  takes its `*_CLASS` twin.
- **Fail-safe default**: every runtime-positioned rule declares `width: 0` (not `auto`) in the sheet, so an
  unapplied fill reads *empty* rather than maxed.

Falsifier: `public/inline-pos.test.js` lints every production `public/*.js` for `style="` outside comments,
and pins the `setHTML` wiring. It reds on a re-introduction; do not allowlist a site, move it to the seam.

## A recomputed panel served beside a PERSISTED verdict owes an on-screen marker
When a read path recomputes one half of a view live while the other half comes from a stored row (the
`dial_state` jsonb, persisted member states), the screen is showing two vintages at once and reads as one
coherent state. Mark every deliberate live-only flip on screen — the disagreement is the interesting signal,
so surface it rather than letting the fresher half quietly win. Claim class →
`docs/claim-verification.md` §35.

## Async render: no await between the state reads that feed a paint and the paint
Do every `await` BEFORE creating the stale-render guard token and reading the state a paint consumes;
an await between read and paint opens a window where a newer render's state paints under the old token.

## Build-time DOM decoration dies on the next poll re-render
`decorateHelp(root)` runs ONCE at build, but the poll path rewrites whole slots' `innerHTML` (`applyBoard`'s
`.t-lag` per tile, `#boardLag` and `#bandPanelHost`; `renderStructureMap`'s `#smGridWrap`;
`renderScoreboard`'s `#sbBody`), destroying any injected `ⓘ`. **A host whose build-time paint is EMPTY is the
worst case, not an exception** — `#bandPanelHost` is written only by the poll path (`buildBandPanel` merely
wires a delegated click), so its `[title]`s had never carried a glyph on any render. Where the fact lives only in a `title=`, that
silently degrades to desktop-hover-only — invisible on mobile, and no test sees it unless one asserts the
glyph. Every `[title]`-hosting write in `app.js`/`lab.js` goes through the exported `setHTML` from `help-bar.js` —
one writer that decorates in the same task (idempotent via the `:scope > .help-i` guard), so a
decorate-that-runs-before-its-write is unrepresentable and no ordering assertion is owed.
`public/write-seam.test.js` is the file-wide guard: it parses both consumers and reds on any raw
`innerHTML`/`outerHTML`/`insertAdjacentHTML` writer that lacks a named allowlist entry stating why that site
cannot host a `[title]`.
Routing a tile-level mark through `HELP_CARVEOUT_SELECTOR` is NOT the fix — that branch deliberately skips
`stopPropagation`, so a tap would also cycle the tile in Scenario mode.

## Preview servers, mock drift, screenshots
`npm run preview` (mock) vs `npm run preview:live` (real store), the mock's hand-authored fields, `/lab`
`?s=` deep-links, and the byte-compare PNG baseline for behavior-preserving refactors → runbook §Front-end.
