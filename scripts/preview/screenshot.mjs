// Headless screenshot + smoke check of the dashboard preview. Boots the mock
// preview server, drives it with Playwright, captures full-page + channel-roll-up
// PNGs, and reports console errors, tooltip coverage, and any tick-label overlap.
//
// THIS is the real safety net for public/*.js: no vitest/tsc covers app.js render
// logic, so this DOM-asserting e2e (console errors + hardcoded selectors/counts)
// is the only guard. Any FE change to panel markup MUST update the selectors/
// counts here, else the e2e breaks or silently goes stale. Run it as the LAST gate
// on public/*.js work.
//
//   npm run preview:shot
//
// Requires the Playwright browser once:  npx playwright install chromium
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TOKEN_KEY, TOKEN_EXP_KEY } from "../../public/auth-session.js";
import { DISMISS_KEY } from "../../public/disclaimer.js";

const PORT = Number(process.env.PORT) || 4322;
const OUT = fileURLToPath(new URL("./out/", import.meta.url));
const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("Playwright not installed. Run: npm i -D playwright && npx playwright install chromium");
  process.exit(1);
}

await mkdir(OUT, { recursive: true });

// --- boot the preview server as a child, wait until it answers --------------
// `--import tsx`: server.mjs → mock-data.mjs imports src/*.ts for its labels, which plain `node`
// cannot resolve (`.js` specifiers, tsconfig is noEmit with no dist/). Mirrors `npm run preview`.
const server = spawn(process.execPath, ["--import", "tsx", serverPath], { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
const base = `http://localhost:${PORT}`;
async function waitReady(attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`${base}/api/status`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("preview server did not become ready");
}

let browser;
let exitCode = 0;
try {
  await waitReady();
  try {
    browser = await chromium.launch();
  } catch (e) {
    console.error("Could not launch Chromium. Run: npx playwright install chromium\n", e.message);
    throw e;
  }
  const page = await browser.newPage({ viewport: { width: 1400, height: 1600 }, deviceScaleFactor: 2 });
  // P11-gate: `/` and `/lab` redirect to `/overview` without a live session, so seed one (a token that
  // expires a day out — no renewal call); the first-visit disclaimer bar is fixed-position and
  // intercepts the glyph taps below.
  await page.addInitScript(
    (pairs) => pairs.forEach(([k, v]) => localStorage.setItem(k, v)),
    [[TOKEN_KEY, "preview-session"], [TOKEN_EXP_KEY, String(Date.now() + 86_400_000)], [DISMISS_KEY, "1"]],
  );
  const errs = [];
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("response", (r) => r.status() >= 400 && errs.push(`HTTP ${r.status()} ${r.url()}`)); // names the URL a bare "Failed to load resource" omits

  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  await page.waitForSelector("#zone-a .alert-chip", { timeout: 5000 });

  await page.screenshot({ path: `${OUT}dashboard.png`, fullPage: true });

  // Tooltip coverage. (Zone-B channel bars + their tick-label overlap check were
  // retired 2026-07-15, O2 step 3.)
  const report = await page.evaluate(() => {
    const tips = document.querySelectorAll("[title]").length;
    // Mobile-help glyph coverage: tap-first, so a glyph rides only the irreducible
    // controls keep-set — never every [title]. Re-decoration must not stack a 2nd.
    const glyphs = document.querySelectorAll(".help-i").length;
    const stacked = [...document.querySelectorAll("[title]")].filter(
      (el) => el.querySelectorAll(":scope > .help-i").length > 1,
    ).length;
    return { tips, glyphs, stacked };
  });

  // Mobile help: tap a non-card glyph → bar shows its host's title; close hides
  // it; a card glyph shows help WITHOUT activating the card (stopPropagation). The detail
  // tab is already the default, so "no nav" = the picker did NOT jump to the card's id.
  // Run before the detail-tab navigation below so the no-nav assert is clean.
  const help = { tapShows: false, closeHides: false, cardNoNav: false };
  await page.click("#zone-d .tab .help-i"); // a tab glyph (zone A is glyphless under tap-first)
  help.tapShows = await page.evaluate(() => {
    const bar = document.querySelector("#help-bar");
    return !!bar && !bar.hidden && (bar.querySelector(".help-bar-text")?.textContent.trim().length ?? 0) > 0;
  });
  await page.click(".help-bar-close");
  help.closeHides = await page.evaluate(() => document.querySelector("#help-bar")?.hidden === true);
  const cardId = await page.$eval("#zone-c .card .help-i", (g) => g.closest(".card[data-id]")?.dataset.id);
  const pickBefore = await page.$eval(".ind-picker", (s) => s.value);
  await page.click("#zone-c .card .help-i"); // a card glyph
  await page.waitForTimeout(150); // let any (unwanted) onCardActivate async-render settle
  help.cardNoNav = await page.evaluate(
    ([card, before]) => {
      const barShown = document.querySelector("#help-bar")?.hidden === false;
      const pick = document.querySelector(".ind-picker")?.value; // onCardActivate sets indicatorId = card id
      return barShown && !!card && before !== card && pick === before;
    },
    [cardId, pickBefore],
  );
  await page.evaluate(() => {
    const bar = document.querySelector("#help-bar"); // hide so it doesn't overlay later screenshots
    if (bar) bar.hidden = true;
  });

  // Indicator-detail explainer: every indicator must render an `.ind-about`
  // block (heading naming it + the "Why it matters." paragraph, after the optional "Live charts."
  // links — the 2026-09-12 slices dropped the old two labels) under its chart.
  // Drive the tab, step through every picker option, and assert the block is well-formed —
  // catches a missing/renamed INDICATOR_DESC entry or a broken render branch.
  await page.click("#tab-detail");
  await page.waitForSelector(".ind-picker", { timeout: 5000 });
  // Skip the "" (— none —) option; the heading must name the pick exactly as its option does.
  const detailOpts = await page.$$eval(".ind-picker option", (os) =>
    os.filter((o) => o.value).map((o) => [o.value, o.textContent.trim()]),
  );
  const detailIds = detailOpts.map(([id]) => id);
  // Indicators whose detail chart must draw a SECONDARY derived line + bands
  // (bespoke scorers F4/G1/NVDA/F5). Their mock series are seeded deep enough
  // (mock-data.mjs) that the derived line renders fully, not just the stub.
  const derivedIds = ["F4", "G1", "NVDA", "F5"].filter((id) => detailIds.includes(id));
  const aboutMissing = [];
  const derivedMissing = [];
  let f4GateOff = false;
  // h4 "About <id> · <label>" vs option "<id> <label>" (detail-tab.js: same parts, other joiner).
  for (const [id, optText] of detailOpts) {
    await page.selectOption(".ind-picker", id);
    await page
      .waitForFunction(
        (want) => document.querySelector(".ind-about h4")?.textContent.trim().replace(/^About /, "").split(" · ").join(" ") === want,
        optText,
        { timeout: 5000 },
      )
      .catch(() => {});
    const ok = await page.evaluate((want) => {
      const sec = document.querySelector(".ind-about");
      const head = sec?.querySelector("h4")?.textContent.trim().replace(/^About /, "").split(" · ").join(" ");
      if (!sec || head !== want) return false;
      const labels = [...sec.querySelectorAll("p strong")].map((s) => s.textContent.trim()).filter((l) => l !== "Live charts.");
      return labels[0] === "Why it matters.";
    }, optText);
    if (!ok) aboutMissing.push(id);

    // Dual-axis assert: a derived indicator must render the secondary line + the
    // amber band; F4's Case-4 gate-off window (the mock seeds a 20-day both-gates-off
    // span) now paints a UNIFORM line — an earlier commit dropped the `.line-gated` dim segment —
    // so assert the legend's hover-pointing gate-off clause (anyOff reached the renderer), that the
    // legend does not describe the retired dim/dashed mark, and no dim ink.
    if (derivedIds.includes(id)) {
      const dual = await page.evaluate(() => {
        const line = !!document.querySelector("#zone-d-panel .line-derived");
        const band = !!document.querySelector("#zone-d-panel .chart .band");
        return line && band;
      });
      if (!dual) derivedMissing.push(id);
      if (id === "F4") {
        f4GateOff = await page.evaluate(
          () =>
            !document.querySelector("#zone-d-panel .line-gated") &&
            [...document.querySelectorAll("#zone-d-panel .chart-legend")].some((p) => p.textContent.includes("hover reads “gate off”") && !p.textContent.includes("dim/dashed")),
        );
      }
    }
  }
  // Capture F4 (dual-axis + gate-off window) as the indicator-detail shot.
  if (detailIds.includes("F4")) {
    await page.selectOption(".ind-picker", "F4");
    await page.waitForSelector("#zone-d-panel .line-derived", { timeout: 5000 }).catch(() => {});
  }
  await page.locator("#zone-d-panel").screenshot({ path: `${OUT}indicator-detail.png` });

  // Slow "bubble-state" panel + Zone D "Bubble tier" tab: the off-ladder slow
  // surface. Capture the always-visible panel, then drive the new tab and assert
  // it charts the three observability legs.
  await page.locator("#zone-slow").screenshot({ path: `${OUT}zone-slow.png` });

  // Off-ladder panels are verdict BANNERS, not leg cards (`off-ladder-panel.js` head
  // comment): the VIX/VIX3M and bubble-state legs render as Zone-C cards, so the panels
  // stopped duplicating them. Assert both panels paint AND that no `.card` came back —
  // a re-duplication reds here, as does a panel that never renders.
  const offladder = await page.evaluate(() => ({
    bottom: document.querySelectorAll("#zone-bottom .card").length,
    slow: document.querySelectorAll("#zone-slow .card").length,
    panels: document.querySelectorAll("#zone-bottom .bottom-panel, #zone-slow .slow-panel").length,
  }));

  await page.click("#tab-bubble");
  await page.waitForSelector(".bubble-chart", { timeout: 5000 });
  const bubbleCharts = await page.$$eval(".bubble-chart", (els) => els.length);
  await page.locator("#zone-d-panel").screenshot({ path: `${OUT}bubble-tier.png` });

  // Stage 7.1 (compacted 2026-07-15): /lab board from the MOCK server (mock /api/lab +
  // cleanUrls). Divider rows are retired — assert each tile carries its inline .t-g
  // super-group micro-label instead.
  // Tile count DERIVED from the served fixture (one tile per d.globalFamilies entry, lab-board.js
  // buildTiles) — the hardcoded 8 went stale when the macro-cycle family was removed.
  const expectTiles = (await (await fetch(`${base}/api/lab`)).json()).globalFamilies?.length ?? 0;
  await page.goto(`${base}/lab`, { waitUntil: "networkidle" });
  await page.waitForSelector("#tiles .tile", { timeout: 5000 });
  const labBoard = await page.evaluate(() => ({
    tiles: document.querySelectorAll("#tiles .tile").length,
    groupLabels: [...document.querySelectorAll("#tiles .tile .t-g")].map((el) => el.textContent.trim()),
    // Ledger idiom rebuild (2026-07-15 eyeball verdicts): every row renders the three surviving
    // idiom elements — SN number+speed glyph + dual pillar bars in its own-danger cell, X exo glyph
    // in its own Exo column (split out by an earlier commit) — (regime chip + bullet graph KILLED; mock
    // legRows all ship subDangers + varied snRoc).
    ledgerRows: document.querySelectorAll("#dfGrid tbody .df-row").length,
    idiomCells: [...document.querySelectorAll("#dfGrid tbody .df-row")].filter(
      (r) => r.querySelector(".col-danger .lg-glyph") && r.querySelector(".col-danger .lg-bars") && r.querySelector(".col-exo .lg-exo"),
    ).length,
    // SN speed arrows: the mock seeds numeric snRoc on all rows but the first (row 0
    // omits it — the no-arrow path), so exactly rows−1 arrows must render — pins both
    // the arrow path and the missing-snRoc suppression (false-green guard).
    spdArrows: document.querySelectorAll("#dfGrid .lg-glyph .lg-spd").length,
  }));
  await page.screenshot({ path: `${OUT}lab.png`, fullPage: true });

  console.log(`screenshots → ${OUT}`);
  console.log(
    `/lab board: tiles=${labBoard.tiles} (expect ${expectTiles} = fixture globalFamilies), inline group labels=${labBoard.groupLabels.length} (expect ${expectTiles}, one per tile) [${labBoard.groupLabels.join(" · ")}]`,
  );
  if (expectTiles === 0 || labBoard.tiles !== expectTiles || labBoard.groupLabels.length !== labBoard.tiles) exitCode = 1;
  console.log(
    `/lab ledger two-pillar idiom rows (glyph+bars, exo column): ${labBoard.idiomCells}/${labBoard.ledgerRows} rows (expect all, >0), SN speed arrows=${labBoard.spdArrows} (expect rows−1: row 0 omits snRoc)`,
  );
  if (labBoard.ledgerRows === 0 || labBoard.idiomCells !== labBoard.ledgerRows || labBoard.spdArrows !== labBoard.ledgerRows - 1) exitCode = 1;
  console.log(`bubble-tier charts: ${bubbleCharts} (expect 3)`);
  if (bubbleCharts !== 3) exitCode = 1;
  console.log(`off-ladder panels: ${offladder.panels}/2 painted, leg cards bottom=${offladder.bottom} slow=${offladder.slow} (expect 0 — banners only)`);
  if (offladder.panels !== 2 || offladder.bottom !== 0 || offladder.slow !== 0) exitCode = 1;
  // The dashboard went tap-first (steps 2–4), so a glyph on every [title] is no longer the
  // invariant — glyphs survive only on the irreducible controls set. WHICH hosts may carry one
  // is pinned by `mobile-tooltip-audit.mjs` §6 (the step-7 falsifier); this run keeps the two
  // page-level guards that census cannot see: glyphs must not vanish entirely, and
  // re-decoration must never stack a 2nd on one host.
  console.log(`title= tooltips on page: ${report.tips}`);
  console.log(`help glyphs: ${report.glyphs} (tap-first: keep-set only, not one per [title]), stacked: ${report.stacked}`);
  if (report.glyphs === 0 || report.glyphs >= report.tips || report.stacked !== 0) exitCode = 1;
  console.log(`help: tap→bar=${help.tapShows} close→hide=${help.closeHides} card-glyph-no-nav=${help.cardNoNav}`);
  if (!help.tapShows || !help.closeHides || !help.cardNoNav) exitCode = 1;
  console.log(`indicator-detail explainers: ${detailIds.length - aboutMissing.length}/${detailIds.length} ok`);
  if (detailIds.length === 0) exitCode = 1; // an empty picker must not read as 0/0 green
  console.log(`derived dual-axis: ${derivedIds.length - derivedMissing.length}/${derivedIds.length} (line + band), F4 gate-off legend+uniform line=${f4GateOff}`);
  if (derivedMissing.length || (derivedIds.includes("F4") && !f4GateOff)) exitCode = 1;
  console.log("console errors:", errs.length ? errs : "none");
  console.log("missing detail explainers:", aboutMissing.length ? aboutMissing : "none");
  if (errs.length || aboutMissing.length) exitCode = 1;

} catch (e) {
  console.error(e.message);
  exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill();
}
// Say the verdict out loud. Every check above prints `name=false` inline and then this
// script exits 1 — which reads as green to anyone skimming the tail (or piping through
// `tail`, where the exit code is the pipeline's, not ours). A failing run must end with
// the word FAILED.
console.log(exitCode === 0 ? "\npreview:shot PASSED — all checks green." : "\npreview:shot FAILED — a check above reads false.");
process.exit(exitCode);
