// Mobile tooltip audit for /lab: boots the mock preview, opens /lab at a phone
// viewport (390×844, touch), and reports every tooltip surface's mobile reachability:
//   1. horizontal overflow (body scrollWidth vs viewport) — the pinch-zoom driver,
//   2. every [title] host classified glyphed / carve-out / help-priority / DEAD (no mobile
//      path) — the tap-readability falsifier: any DEAD host (in NEITHER selector set AND
//      unglyphed) flips the exit code red, as does any glyph outside the irreducible set,
//   3. tap-target sizes of carve-out hosts (<24px = hard to hit),
//   4. live tap simulations: ⓘ glyph → #help-bar, carve-out → #help-bar,
//      td.sig[data-tip] → .cell-tip, each checked visible AND inside the viewport.
//
//   node scripts/preview/mobile-tooltip-audit.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The runtime's own selector sets (plain dep-free ESM) — the census can't drift from the policy.
import { HELP_CARVEOUT_SELECTOR, HELP_GLYPH_KEEP_SELECTOR, HELP_TAP_PRIORITY_SELECTOR } from "../../public/help-decorate.js";
import { TOKEN_KEY, TOKEN_EXP_KEY } from "../../public/auth-session.js";
import { DISMISS_KEY } from "../../public/disclaimer.js";

const PORT = Number(process.env.PORT) || 4323;
const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("Playwright not installed. Run: npm i -D playwright && npx playwright install chromium");
  process.exit(1);
}

const server = spawn(process.execPath, ["--import", "tsx", serverPath], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});
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
// Assertions (added once S1/S2 landed, 2026-08-15) — any failure flips the exit code red.
const failures = [];
const expect = (ok, msg) => {
  if (!ok) failures.push(msg);
};
// The ruled host classes (S3 five + the tile leg chips leg-r/leg-a/leg-calm) must meet 24px —
// a small-target regression on them goes red. §3 keys carry ALL class segments of the element.
const RULED_SMALL = /^(span|div|td|th|button|a|em|strong|sub|sup)\.(?:[\w-]+\.)*(lg-dotv|mode-glyph|lg-arrow|lg-exo-x|lg-l|leg-r|leg-a|leg-calm|fam-lag|sb-na)\b/;
try {
  await waitReady();
  browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
  });
  // P11-gate: without a live session `/` and `/lab` redirect to `/overview` — seed one a day out (mirrors screenshot.mjs).
  const session = [[TOKEN_KEY, "preview-session"], [TOKEN_EXP_KEY, String(Date.now() + 86_400_000)]];
  await ctx.addInitScript((pairs) => pairs.forEach(([k, v]) => localStorage.setItem(k, v)), [...session, [DISMISS_KEY, "1"]]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}/lab.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);

  // --- 1. horizontal overflow ------------------------------------------------
  const overflow = await page.evaluate(() => {
    const offenders = [];
    const vw = document.documentElement.clientWidth;
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width > vw + 2 && !el.closest(".df-grid-wrap, .sm-grid-wrap, [class*='scroll']")) {
        // report only topmost offenders (skip if parent already reported)
        if (!offenders.some((o) => o.el.contains(el))) offenders.push({ el, w: Math.round(r.width) });
      }
    }
    return {
      viewport: vw,
      bodyScrollWidth: document.body.scrollWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      offenders: offenders.slice(0, 15).map((o) => ({
        sel: o.el.tagName.toLowerCase() + (o.el.id ? "#" + o.el.id : "") + (o.el.className && typeof o.el.className === "string" ? "." + o.el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""),
        width: o.w,
      })),
    };
  });
  console.log("== 1. horizontal overflow ==");
  console.log(JSON.stringify(overflow, null, 1));
  expect(overflow.offenders.length === 0, `§1 overflow offenders: ${JSON.stringify(overflow.offenders)}`);
  expect(overflow.bodyScrollWidth <= overflow.viewport, `§1 bodyScrollWidth ${overflow.bodyScrollWidth} > viewport ${overflow.viewport}`);
  expect(overflow.docScrollWidth <= overflow.viewport, `§1 docScrollWidth ${overflow.docScrollWidth} > viewport ${overflow.viewport}`);

  // --- 1b. held-row reveal fits the phone ------------------------------------
  // The dial attribution renders in a `<td colspan>` of `.df-grid`, a table deliberately WIDER
  // than a phone, so it inherited `white-space: nowrap` and a content box sized to the TABLE:
  // the prose laid out off-screen and could only be read by scrolling sideways. `.attrib-fit`
  // (width from `--attrib-w`, measured off `.df-grid-wrap` by `fitAttribWidth` in lab-board.js)
  // is the clamp. This asserts BOTH halves — the box is viewport-sized, and its content wraps
  // inside it. §1 cannot see any of it: the reveal is closed by default, and `.df-grid-wrap` is
  // on §1's own scroll-container exclusion list.
  await page.locator(".df-row.held.has-attrib").first().scrollIntoViewIfNeeded().catch(() => {});
  await page.locator(".df-row.held.has-attrib").first().tap().catch(() => {});
  await page.waitForTimeout(300);
  const reveal = await page.evaluate(() => {
    const el = document.querySelector(".attrib-fit");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const foot = el.querySelector(".attrib-why-foot");
    const cs = foot && getComputedStyle(foot);
    return {
      viewport: document.documentElement.clientWidth,
      visible: r.width > 0 && r.height > 0,
      boxWidth: Math.round(r.width),
      right: Math.round(r.right),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      footLines: foot && cs ? Math.round(foot.getBoundingClientRect().height / parseFloat(cs.lineHeight)) : 0,
      footChars: foot ? foot.textContent.trim().length : 0,
    };
  });
  console.log("\n== 1b. held-row reveal fit ==");
  console.log(JSON.stringify(reveal));
  if (!reveal || !reveal.visible) {
    expect(false, "§1b no visible .attrib-fit after tapping the held row — the reveal did not open");
  } else {
    expect(
      reveal.boxWidth <= reveal.viewport + 2,
      `§1b reveal box ${reveal.boxWidth}px wider than the ${reveal.viewport}px viewport (the --attrib-w clamp is not applied)`,
    );
    expect(
      reveal.right <= reveal.viewport + 2,
      `§1b reveal runs past the right edge (right ${reveal.right} > viewport ${reveal.viewport})`,
    );
    expect(
      reveal.scrollWidth <= reveal.clientWidth + 2,
      `§1b reveal content overflows its own box (scrollWidth ${reveal.scrollWidth} > clientWidth ${reveal.clientWidth}) — the prose is not wrapping`,
    );
    // The footnote is one condensed paragraph ([USER] 2026-09-06); the two it replaced ran ~740
    // chars. A generous ceiling — it fails on a re-expansion, not on a wording tweak.
    expect(
      reveal.footChars > 0 && reveal.footChars < 420,
      `§1b the rung footnote is ${reveal.footChars} chars — it was condensed to one short paragraph`,
    );
  }


  // --- 2. [title] host census — THE tap-readability falsifier ----------------
  const CARVEOUT = HELP_CARVEOUT_SELECTOR;
  const PRIORITY = HELP_TAP_PRIORITY_SELECTOR;
  const TAPPABLE = `${CARVEOUT}, ${PRIORITY}`;
  async function titleCensus(label) {
    const census = await page.evaluate(
      ({ CARVEOUT, PRIORITY, KEEP }) => {
        const out = { total: 0, glyphed: 0, carveout: 0, priority: 0, dead: [], rogueGlyphs: [], inSvg: [] };
        const pathOf = (el) => {
          const bits = [];
          let n = el;
          for (let i = 0; n && n !== document.body && i < 4; i++, n = n.parentElement) {
            bits.unshift(n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + (typeof n.className === "string" && n.className ? "." + n.className.trim().split(/\s+/)[0] : ""));
          }
          return bits.join(" > ");
        };
        for (const el of document.querySelectorAll("[title]")) {
          out.total++;
          const svg = !!el.closest("svg");
          // RENDERED, not merely present: a glyph appended into a `<select>` is a real DOM node
          // that measures 0×0 (a select renders no child but option/optgroup), so a node-presence
          // check certified an untappable tooltip as covered. Measure the box.
          const g = el.querySelector(":scope > .help-i");
          const gr = g?.getBoundingClientRect();
          const glyph = !!gr && gr.width > 0 && gr.height > 0;
          const carve = el.matches(CARVEOUT);
          const pri = el.matches(PRIORITY);
          if (svg) out.inSvg.push(pathOf(el));
          // /lab is tap-first: a glyph is legal ONLY on the irreducible keep set.
          if (g && !el.matches(KEEP)) out.rogueGlyphs.push(pathOf(el));
          if (glyph) out.glyphed++;
          else if (pri) out.priority++;
          else if (carve) out.carveout++;
          else out.dead.push({ path: pathOf(el), title: el.getAttribute("title").slice(0, 60) });
        }
        // dedupe dead by path prefix, keep counts
        const byPath = new Map();
        for (const d of out.dead) {
          const k = d.path;
          byPath.set(k, (byPath.get(k) || 0) + 1);
        }
        out.deadGrouped = [...byPath.entries()].map(([path, n]) => ({ path, n })).slice(0, 40);
        out.deadCount = out.dead.length;
        delete out.dead;
        out.svgCount = out.inSvg.length;
        out.inSvg = out.inSvg.slice(0, 10);
        return out;
      },
      { CARVEOUT, PRIORITY, KEEP: HELP_GLYPH_KEEP_SELECTOR },
    );
    console.log(`\n== 2. [title] census [${label}] (dead = no glyph AND in neither selector set) ==`);
    console.log(JSON.stringify(census, null, 1));
    expect(census.deadCount === 0, `§2 [${label}] DEAD [title] hosts (unreachable on mobile): ${JSON.stringify(census.deadGrouped)}`);
    expect(census.rogueGlyphs.length === 0, `§2 [${label}] glyphs outside HELP_GLYPH_KEEP_SELECTOR on a tap-first page: ${JSON.stringify(census.rogueGlyphs)}`);
    return census;
  }
  // Live-board marker: tiles paint only once applyBoard ran on the live payload.
  expect((await page.locator(".tile .t-h[title]").count()) > 0, "§2 live census ran on an unpainted board — no .tile .t-h[title] present");
  await titleCensus("live/families");

  // --- 3. carve-out tap-target sizes ----------------------------------------
  const targets = await page.evaluate((TAPPABLE) => {
    const small = [];
    for (const el of document.querySelectorAll(TAPPABLE)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.width < 24 || r.height < 24) small.push({ sel: el.tagName.toLowerCase() + "." + String(el.className).trim().split(/\s+/).join("."), w: Math.round(r.width), h: Math.round(r.height) });
    }
    const bySel = new Map();
    for (const s of small) {
      const k = `${s.sel} ~${s.w}x${s.h}`;
      bySel.set(k, (bySel.get(k) || 0) + 1);
    }
    return { smallCount: small.length, grouped: [...bySel.entries()].slice(0, 25) };
  }, TAPPABLE);
  console.log("\n== 3. tap-readable targets under 24px ==");
  console.log(JSON.stringify(targets, null, 1));
  const ruledSmall = targets.grouped.filter(([k]) => RULED_SMALL.test(k));
  expect(ruledSmall.length === 0, `§3 ruled S3 classes back under 24px: ${JSON.stringify(ruledSmall)}`);

  // --- 4. live tap simulations ----------------------------------------------
  async function barState() {
    return page.evaluate(() => {
      const bar = document.getElementById("help-bar");
      const r = bar?.getBoundingClientRect();
      return {
        hidden: bar?.hidden ?? "no-bar",
        text: bar?.querySelector(".help-bar-text")?.textContent.slice(0, 50) || "",
        rect: r ? { top: Math.round(r.top), bottom: Math.round(r.bottom) } : null,
        viewportH: window.innerHeight,
      };
    });
  }
  console.log("\n== 4. tap simulations ==");

  // help-priority host: the family-desc header — tap must open the help bar (its clickable-tile
  // ancestor is inert in live mode; the no-cycle half is pinned by the capture stopPropagation).
  const pri = page.locator(".tile .t-h[title]").first();
  if (await pri.count()) {
    await pri.tap();
    await page.waitForTimeout(200);
    const gs = await barState();
    console.log("tap .tile .t-h[title] →", JSON.stringify(gs));
    expect(gs.hidden === false, `§4 help-priority tap did not open help bar: ${JSON.stringify(gs)}`);
    expect(gs.rect && gs.rect.bottom <= gs.viewportH + 1, `§4 help bar below viewport: ${JSON.stringify(gs)}`);
    await page.tap("body", { position: { x: 5, y: 5 } }).catch(() => {});
    await page.waitForTimeout(150);
  } else expect(false, "§4 no .tile .t-h[title] found on page");

  // carve-out inside the danger ledger (a column header with a title)
  const dfTitled = page.locator("#dangerField [title]:visible").first();
  if (await dfTitled.count()) {
    await dfTitled.scrollIntoViewIfNeeded();
    await dfTitled.tap().catch((e) => console.log("  tap failed:", e.message.split("\n")[0]));
    await page.waitForTimeout(200);
    console.log("tap #dangerField [title] →", JSON.stringify(await barState()));
  } else console.log("tap #dangerField [title] → none found");

  // signal cell → cell-tip
  const sig = page.locator("td.sig[data-tip]:visible").first();
  if (await sig.count()) {
    await sig.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      window.__scrolls = 0;
      window.addEventListener("scroll", () => window.__scrolls++, true);
      window.__tipOpened = false;
      const t = document.querySelector(".cell-tip");
      new MutationObserver(() => {
        if (!t.hidden) window.__tipOpened = true;
      }).observe(t, { attributes: true, attributeFilter: ["hidden"] });
    });
    await sig.tap().catch((e) => console.log("  tap failed:", e.message.split("\n")[0]));
    await page.waitForTimeout(250);
    console.log(
      "  scroll events during tap / tip transiently opened:",
      JSON.stringify(await page.evaluate(() => ({ scrolls: window.__scrolls, opened: window.__tipOpened }))),
    );
    const tip = await page.evaluate(() => {
      const t = document.querySelector(".cell-tip");
      const r = t?.getBoundingClientRect();
      return {
        hidden: t?.hidden ?? "no-panel",
        rect: r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) } : null,
        viewportH: window.innerHeight,
        mq640: matchMedia("(max-width: 640px)").matches,
        helpBarAlsoOpen: !document.getElementById("help-bar")?.hidden,
      };
    });
    console.log("tap td.sig[data-tip] →", JSON.stringify(tip));
    expect(tip.hidden === false, `§4 drill-down closed after opening tap: ${JSON.stringify(tip)}`);
    expect(tip.rect && tip.rect.top >= 0 && tip.rect.bottom <= tip.viewportH + 1, `§4 drill-down sheet outside viewport: ${JSON.stringify(tip)}`);
    expect(tip.helpBarAlsoOpen === false, `§4 help bar stacked under the drill-down: ${JSON.stringify(tip)}`);
  } else expect(false, "§4 no td.sig[data-tip] found");

  // tile leg (.tile .ids [title]) — carve-out with a competing tile action
  const leg = page.locator(".tile .ids [title]:visible").first();
  if (await leg.count()) {
    await leg.scrollIntoViewIfNeeded();
    await leg.tap().catch((e) => console.log("  tap failed:", e.message.split("\n")[0]));
    await page.waitForTimeout(200);
    console.log("tap .tile .ids [title] →", JSON.stringify(await barState()));
  } else console.log("tap .tile .ids [title] → none found");

  // --- 5. tap-first census: every [title] host × nearest clickable ancestor ---
  // Clickable set mirrors the delegated handlers: lab.js onClick (.tile.clickable /
  // .ids [data-id] / [data-knob]), buildBandPanel (.bp-fold/.bp-note-toggle), buildDangerField
  // (#dfToggle/.df-legend-toggle/.df-row.held.has-attrib), wireCellTip (td.sig[data-tip]),
  // onQuadrantClick (.rrg-leg, scenario), replay (data-preset/data-edge), bars (data-mode/
  // data-section/data-lab-section), picker chips (.chip-m), episode chips (data-episode).
  const CLICKABLES = [
    ".tile.clickable .ids [data-id]",
    ".tile.clickable",
    "[data-knob]",
    ".bp-fold",
    ".bp-note-toggle",
    "#dfToggle",
    ".df-legend-toggle",
    ".df-row.held.has-attrib",
    "td.sig[data-tip]",
    "#rrgQuadrant .rrg-leg.clickable",
    "[data-preset]",
    "input[data-edge]",
    "[data-mode]",
    "[data-section]",
    "[data-lab-section]",
    ".chip-m",
    "[data-episode]",
    "button",
    "a[href]",
    "input",
    "select",
    "summary",
  ];
  async function censusTapFirst(label) {
    const rows = await page.evaluate(
      ({ CARVEOUT, PRIORITY, CLICKABLES }) => {
        const keyOf = (el) =>
          el.tagName.toLowerCase() +
          (el.id ? "#" + el.id : "") +
          (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).join(".") : "");
        const zones = ["#dangerField", "#rrgQuadrant", "#bandPanelHost", "#tiles", "#boardLag", "#reader", "#scoreboard", "#smGridWrap", "#replayCard", "#episodeReplay", "#picker", "#labToolbar"];
        const byKey = new Map();
        for (const el of document.querySelectorAll("[title]")) {
          // nearest clickable ancestor: deepest match across the selector list
          let anc = null;
          let ancSel = "";
          for (const sel of CLICKABLES) {
            const a = el.closest(sel);
            if (a && (!anc || anc.contains(a))) {
              anc = a;
              ancSel = sel;
            }
          }
          const zone = zones.find((z) => el.closest(z)) || "(other)";
          const k = [
            zone,
            keyOf(el),
            anc ? (anc === el ? "SELF:" : anc.contains(el) ? "ANC:" : "?:") + ancSel : "none",
          ].join(" | ");
          const e = byKey.get(k) || {
            n: 0,
            glyph: !!el.querySelector(":scope > .help-i"),
            carve: el.matches(CARVEOUT),
            pri: el.matches(PRIORITY),
            title: (el.getAttribute("title") || "").slice(0, 45),
          };
          e.n++;
          byKey.set(k, e);
        }
        return [...byKey.entries()].map(([k, v]) => ({ k, ...v }));
      },
      { CARVEOUT, PRIORITY, CLICKABLES },
    );
    console.log(`\n== 5. tap-first census [${label}] — zone | host | clickable-ancestor ==`);
    for (const r of rows) console.log(`${r.glyph ? "ⓘ" : r.pri ? "PR" : r.carve ? "CO" : "--"} ×${String(r.n).padStart(3)} ${r.k} :: ${r.title}`);
    return rows;
  }
  await censusTapFirst("live/families");
  // scenario mode (tiles become clickable; rrg legs cycle). The mock server is static and
  // ignores ?s= (mode stays "live"), so rewrite the payload's mode in flight — without this
  // the scenario census is vacuous (no .tile.clickable can ever appear).
  await page.route("**/api/lab*", async (route) => {
    const resp = await route.fetch();
    const body = await resp.json();
    body.mode = "scenario";
    await route.fulfill({ response: resp, json: body });
  });
  await page.tap('#modebar [data-mode="scenario"]').catch(() => {});
  await page.waitForTimeout(800);
  const scen = await censusTapFirst("scenario/families");
  expect(
    scen.some((r) => r.k.includes("ANC:.tile.clickable")),
    "§5 scenario census saw no [title] host inside a .tile.clickable — mode rewrite broke or tiles lost their titles",
  );
  await titleCensus("scenario/families");
  await page.unroute("**/api/lab*");
  // replay mode (range controls own the card). Same static-mock problem as scenario: the
  // fetchReplay payload comes back mode:"live", so rewrite it or the census is a live board.
  await page.route("**/api/lab*", async (route) => {
    const resp = await route.fetch();
    const body = await resp.json();
    body.mode = "replay";
    await route.fulfill({ response: resp, json: body });
  });
  await page.tap('#modebar [data-mode="replay"]').catch(() => {});
  await page.waitForTimeout(1200);
  // Replay marker: [data-preset] range controls paint ONLY on the replay branch (renderReplay
  // and showReplayError both emit them; the card stays .is-hidden + empty otherwise).
  expect(
    (await page.locator("#replayCard:not(.is-hidden) [data-preset]").count()) > 0,
    "§5 replay census: #replayCard range controls not painted — replay mode never took hold",
  );
  await censusTapFirst("replay");
  await titleCensus("replay");
  await page.unroute("**/api/lab*");
  // episodes section (episode chips)
  await page.tap('#sectionStrip [data-lab-section="episodes"]').catch(() => {});
  await page.waitForTimeout(1200);
  // Episodes marker: #episodeReplay unhides + paints only via applySection("episodes") — on
  // the mock /api/replay 404s, so the error branch's .erp-empty is the guaranteed paint.
  expect(
    (await page.locator("#episodeReplay:not(.is-hidden) .erp-empty, #episodeReplay:not(.is-hidden) svg.erp-chart").count()) > 0,
    "§5 episodes census: #episodeReplay never painted (no .erp-empty error branch, no erp-chart) — section tap broke",
  );
  await censusTapFirst("episodes");
  await titleCensus("episodes");
  await page.tap('#sectionStrip [data-lab-section="families"]').catch(() => {});

  // --- 6. DASHBOARD PAGE PASS (index.html) -----------------------------------
  // The dashboard (`#dashboard`, data-help="tap-first") carries the SAME per-mode
  // presence-expect discipline as the /lab passes above: enumerate every [title] host
  // under #dashboard, classify against the three runtime selector sets, and RED on any
  // host in NONE of them — the plan's step-7 falsifier ("a [title] host in no selector
  // set goes red"). On this tap-first page a glyph-keep control MUST carry its ⓘ; a
  // carve-out / help-priority host must NOT (its whole box is the tap surface).
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);

  async function dashboardCensus(label) {
    // Board marker (every state, not just ladder): cards paint only once applyView ran on
    // the mock /status payload — re-checked per tab/mode so no census runs on a blank board.
    expect(
      (await page.locator("#dashboard:not([hidden]) .card[data-id]").count()) > 0,
      `§6 [${label}] dashboard census ran on an unpainted board — no visible #dashboard .card[data-id] present`,
    );
    const census = await page.evaluate(
      ({ CARVEOUT, PRIORITY, KEEP }) => {
        const out = { total: 0, keep: 0, priority: 0, carveout: 0, unclassified: [], keepNoGlyph: [], tapHasGlyph: [] };
        const pathOf = (el) => {
          const bits = [];
          let n = el;
          for (let i = 0; n && n !== document.body && i < 4; i++, n = n.parentElement) {
            bits.unshift(n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + (typeof n.className === "string" && n.className ? "." + n.className.trim().split(/\s+/)[0] : ""));
          }
          return bits.join(" > ");
        };
        const dash = document.getElementById("dashboard");
        for (const el of dash.querySelectorAll("[title]")) {
          out.total++;
          // RENDERED, not merely present — see §2. A `<select>`'s appended glyph measures 0×0.
          const g = el.querySelector(":scope > .help-i");
          const gr = g?.getBoundingClientRect();
          const glyph = !!gr && gr.width > 0 && gr.height > 0;
          const title = (el.getAttribute("title") || "").slice(0, 60);
          // glyph-keep is a legal FOURTH class on the dashboard (unlike /lab's DEAD test):
          // these controls keep their ⓘ, so it is checked FIRST and its glyph asserted present.
          if (el.matches(KEEP)) {
            out.keep++;
            if (!glyph) out.keepNoGlyph.push({ path: pathOf(el), title, glyphNodePresent: !!g });
          } else if (el.matches(PRIORITY)) {
            out.priority++;
            if (g) out.tapHasGlyph.push(pathOf(el));
          } else if (el.matches(CARVEOUT)) {
            out.carveout++;
            if (g) out.tapHasGlyph.push(pathOf(el));
          } else {
            out.unclassified.push({ path: pathOf(el), title });
          }
        }
        const byPath = new Map();
        for (const d of out.unclassified) byPath.set(d.path, { n: (byPath.get(d.path)?.n || 0) + 1, title: d.title });
        out.unclassifiedGrouped = [...byPath.entries()].map(([path, v]) => ({ path, ...v }));
        out.unclassifiedCount = out.unclassified.length;
        delete out.unclassified;
        return out;
      },
      { CARVEOUT: HELP_CARVEOUT_SELECTOR, PRIORITY: HELP_TAP_PRIORITY_SELECTOR, KEEP: HELP_GLYPH_KEEP_SELECTOR },
    );
    console.log(`\n== 6. dashboard [title] census [${label}] (unclassified = in NONE of carve-out/priority/glyph-keep) ==`);
    console.log(JSON.stringify(census, null, 1));
    expect(
      census.unclassifiedCount === 0,
      `§6 [${label}] [title] host under #dashboard in NO selector set (step-7 falsifier): ${JSON.stringify(census.unclassifiedGrouped)}`,
    );
    expect(census.keepNoGlyph.length === 0, `§6 [${label}] glyph-keep control missing its ⓘ glyph (tap-first regression): ${JSON.stringify(census.keepNoGlyph)}`);
    expect(census.tapHasGlyph.length === 0, `§6 [${label}] carve-out/help-priority host wrongly carries a ⓘ glyph: ${JSON.stringify(census.tapHasGlyph)}`);
    return census;
  }

  // Ladder tab — Zone A verdict strip, Zone C cards + family headers, the three off-ladder
  // panels, the Zone D tab row + the range selector. NOT the default tab: app.js seeds
  // `zoneD.tab: "detail"`, so this pass has to tap its way in or it censuses `detail` twice and
  // its `.range` marker can never be satisfied.
  await page.tap('#zone-d .tab[data-tab="ladder"]').catch(() => {});
  await page.waitForTimeout(700);
  expect((await page.locator("#zone-d .range[title]").count()) > 0, "§6 ladder census: #zone-d .range range control never painted");
  await dashboardCensus("ladder");
  // Detail tab — adds the ctl-labels and the indicator + compare pickers.
  await page.tap('#zone-d .tab[data-tab="detail"]').catch(() => {});
  await page.waitForTimeout(700);
  // Detail marker: the indicator picker paints only on the detail branch.
  // The picker carries no `title=` of its own (a `<select>` cannot render the ⓘ; its `.ctl-label`
  // holds the tooltip) — the marker is its PRESENCE, which is detail-tab-only either way.
  expect((await page.locator("#zone-d .ind-picker").count()) > 0, "§6 detail census: #zone-d .ind-picker never painted — detail tab never took hold");
  const det = await dashboardCensus("detail");
  expect(det.keep > 0, "§6 detail census saw no glyph-keep control — the ruled-B controls lost their titles");
  // Bubble tab — the third Zone D view.
  await page.tap('#zone-d .tab[data-tab="bubble"]').catch(() => {});
  await page.waitForTimeout(700);
  // Bubble marker: the slow-tier charts (.bubble-chart) render ONLY on the bubble branch
  // (renderBubbleTab, app.js) — present on no other tab, so a swallowed tap reds here.
  expect((await page.locator("#zone-d .bubble-chart").count()) > 0, "§6 bubble census: #zone-d .bubble-chart never painted — bubble tab never took hold");
  await dashboardCensus("bubble");
  // --- 7. dashboard capture-order pin (plan step 5) --------------------------
  // help-bar.js binds ONE capture-phase click listener; its help-priority branch
  // stopPropagation()s before onCardActivate's bubble delegation on #dashboard can fire.
  // Pin BOTH directions: a tap on a help-priority host (.card-delta[title]) opens help and
  // must NOT activate the detail tab; a tap on the card BODY (an untitled child) opens the
  // detail tab and must NOT open help. Authoring a pin — behaviour already correct by inspection.
  await page.tap('#zone-d .tab[data-tab="ladder"]').catch(() => {});
  await page.waitForTimeout(300);
  // The help signal negates #help-bar.hidden; a MISSING bar negates undefined to true and
  // would pass the forward pin spuriously — pin the bar's existence before reading it.
  expect((await page.locator("#help-bar").count()) > 0, "§7 #help-bar absent — the help signal reads 'open' when the bar never rendered");
  const barSelected = () =>
    page.evaluate(() => ({
      help: !document.getElementById("help-bar")?.hidden,
      detail: document.querySelector('#zone-d .tab[data-tab="detail"]')?.getAttribute("aria-selected") === "true",
    }));
  const priHost = page.locator("#dashboard .card .card-delta[title]").first();
  if (await priHost.count()) {
    await priHost.scrollIntoViewIfNeeded();
    await priHost.tap();
    await page.waitForTimeout(300);
    const st = await barSelected();
    console.log("\n== 7. capture-order pin ==");
    console.log("tap #dashboard .card .card-delta[title] →", JSON.stringify(st));
    expect(st.help === true, `§7 help-priority tap on .card-delta did not open help: ${JSON.stringify(st)}`);
    expect(st.detail === false, `§7 help-priority tap on .card-delta ALSO activated the detail tab (capture stopPropagation failed): ${JSON.stringify(st)}`);
    await page.tap("body", { position: { x: 5, y: 5 } }).catch(() => {});
    await page.waitForTimeout(200);
  } else expect(false, "§7 no #dashboard .card .card-delta[title] host found — cannot pin the help-priority half");

  // Inverse: tap the card's empty bottom row (below .card-value, untitled, unconditional per card).
  await page.tap('#zone-d .tab[data-tab="ladder"]').catch(() => {});
  await page.waitForTimeout(300);
  const bodyHost = page.locator("#dashboard .card[data-id]").first();
  if (await bodyHost.count()) {
    await bodyHost.scrollIntoViewIfNeeded();
    // The empty row below the value keeps the tap target tall: card bottom − value bottom ≥ 40px.
    const gap = await bodyHost.evaluate((c) => c.getBoundingClientRect().bottom - c.querySelector(".card-value").getBoundingClientRect().bottom);
    expect(gap >= 40, `§7 card's empty bottom row collapsed to ${gap}px (< 40) — the click target shrank`);
    await bodyHost.tap({ position: { x: 16, y: (await bodyHost.boundingBox()).height - gap / 2 } });
    await page.waitForTimeout(500);
    const st2 = await barSelected();
    console.log(`tap #dashboard .card[data-id] empty bottom row (gap ${gap}px) →`, JSON.stringify(st2));
    expect(st2.detail === true, `§7 card-body tap did not open the detail tab: ${JSON.stringify(st2)}`);
    expect(st2.help === false, `§7 card-body tap ALSO opened help: ${JSON.stringify(st2)}`);
  } else expect(false, "§7 no #dashboard .card[data-id] body target found");

  console.log("\n== console errors ==");
  console.log(errors.length ? errors.join("\n") : "(none)");

  console.log("\n== assertions ==");
  if (failures.length) {
    for (const f of failures) console.log("FAIL:", f);
    exitCode = 1;
    failures.length = 0; // reported — keeps the `finally` re-print (below) from doubling them
  } else console.log(`all green`);
} catch (e) {
  console.error("AUDIT FAILED:", e);
  exitCode = 1;
} finally {
  // The assertions ALWAYS report, abort or not. A throw partway down the script (today: the §5-7
  // `dashboardCensus` crash, present on HEAD before this section existed) used to skip the summary
  // block entirely, so every `expect` that had already run — including §1b's — was collected into
  // `failures` and then never printed: a check that cannot announce its own failure is vacuous by
  // construction. Printing here is idempotent for the happy path (the block below runs first and
  // empties nothing), so this only ever ADDS the report the abort would have eaten.
  if (failures.length) {
    console.log("\n== assertions (reported from finally) ==");
    for (const f of failures) console.log("FAIL:", f);
    exitCode = 1;
  }
  await browser?.close();
  server.kill();
}
process.exit(exitCode);
