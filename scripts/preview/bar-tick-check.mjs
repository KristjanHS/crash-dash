// Ledger band-cut hairline check (`.lg-bar-tick`) — the falsifier R4/G3 is cited against.
//
// Two claims, one invocation, both measured off a REAL render (never hand arithmetic — the
// `box-sizing: border-box` frame sits INSIDE `.lg-bar-track`'s 140px, which has burned two
// prior sessions' px tables):
//   1. PLACEMENT — each tick's rendered x lands where `bandTicks()`'s percentage puts it.
//      A `%` left is resolved against the track's PADDING box (140px − 2×1px border = 138px)
//      and is then offset by the 1px left border, so expected = pct/100 × 138 + 1 from the
//      track's OUTER left edge. Both numbers are read back from the DOM, never assumed.
//   2. CONTRAST — the WCAG ratio of each tick's rendered pixel column against every backdrop
//      THAT tick can sit on (empty track wash, amber/red fill), sampled from a screenshot of the
//      track re-decoded through a canvas. This is what a markup test cannot see: a unit test
//      proves the class is EMITTED, never that it is visible (`.claude/rules/frontend.md`).
//      Keyed per (tick band × backdrop) since H3(1) gave the two ticks different colours.
//
// Both cut sets are exercised: the cuts the page was SERVED (the mock fixture's `legRagCuts`)
// and the shipped `BAND_CUTS` default, because they put the ticks in different places and a
// reconciliation that only holds for one of them is not a reconciliation.
//
//   npm run preview:ticks
//
// Boots its own mock server (like `preview:shot`); needs the browser once:
//   npx playwright install chromium
// Exit 0 = placement reconciles and every backdrop clears its contrast floor; 1 = a violation.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT) || 4323;
const base = `http://localhost:${PORT}`;
const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
const EPS = 0.5; // px — sub-pixel rounding
// WCAG floors, keyed `<tick band>:<backdrop>`. H3(1) (2026-07-26) made the KEY a pair: the ticks no
// longer share one colour (`.lg-bar-tick.a` is dual-tone, lab.html), so a per-backdrop floor would
// silently be measured off whichever tick happened to be sampled first — which is exactly what the
// pre-H3 version did (the amber tick supplied all three backdrops and the red tick was never
// measured at all).
// The amber floor is 3 — the WCAG non-text/UI-component threshold — and is the assertion H3(1)
// added: before the dual-tone hairline the amber tick measured 1.63 on the amber fill, so this
// floor red-demos by reverting `.lg-bar-tick.a` to the base `var(--ink)`.
// Five pairs, and exactly five are reachable: an amber-band fill stops short of the RED tick, and a
// green fill stops short of BOTH ticks, so `r:amber`, `r:green` and `a:green` are absent on purpose
// — a floor for them would be a check that cannot fail. The coverage assert below pins that too.
const FLOORS = { "a:track": 8, "a:amber": 3, "a:red": 3, "r:track": 8, "r:red": 3 };

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("Playwright not installed. Run: npm i -D playwright && npx playwright install chromium");
  process.exit(1);
}

// `--import tsx`: server.mjs → mock-data.mjs imports src/*.ts, unresolvable under plain node.
const server = spawn(process.execPath, ["--import", "tsx", serverPath], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});
async function waitReady(attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      if ((await fetch(`${base}/api/status`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("preview server did not become ready");
}

const lum = (c) => {
  const f = (v) => (v /= 255) <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

let browser;
let exitCode = 0;
try {
  await waitReady();
  browser = await chromium.launch();
  // deviceScaleFactor 1: one CSS px must be one device px or the 1px hairline is resampled.
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  page.on("console", (m) => m.type() === "error" && console.error("console error:", m.text()));
  await page.goto(`${base}/lab`, { waitUntil: "networkidle" });

  // H3(1) — the probe below renders its own tick markup, so it can prove the per-band COLOURS but
  // never that `renderPillarBars` (lab.js) still emits the band class that selects them. Read that
  // off the REAL board this page just painted: a mirror unanchored to the shipped source is how a
  // per-band rule goes silently dead. Fails if the class is dropped, or if only one band ever ships.
  await page.waitForSelector(".df-grid .lg-bar-tick", { timeout: 15000 });
  const shippedBands = await page.evaluate(() =>
    [
      ...new Set(
        [...document.querySelectorAll(".df-grid .lg-bar-tick")].map((t) =>
          [...t.classList].filter((c) => c !== "lg-bar-tick").join("+"),
        ),
      ),
    ].sort(),
  );
  const bandsOk = shippedBands.join(",") === "a,r";
  if (!bandsOk) exitCode = 1;
  console.log(
    `${bandsOk ? "ok  " : "FAIL"} shipped board: .df-grid .lg-bar-tick band classes = [${shippedBands.join(", ")}] (expected [a, r])`,
  );

  // The bars are the REAL seam output (`pillarBarHtml` + `bandTicks` from the served module),
  // mounted in the real /lab document so the real CSS applies. The mock `/api/lab` is a static
  // all-calm fixture that ignores `?s=` (README), and an all-calm board maxes ~0.035 — far below
  // either cut — so the pillar values are driven here instead, straight off the active cuts.
  const measure = async (useDefaultCuts) =>
    page.evaluate(async (useDefaultCuts) => {
      const m = await import("/sub-dangers.js");
      if (useDefaultCuts) m.setBandCuts(m.BAND_CUTS);
      const ticks = m.bandTicks();
      // `activeCuts` is module-private, so the live cuts are read BACK off the tick percentages
      // (`bandTicks` = cut / BAR_FULL_SCALE × 100) rather than assumed — that inversion is also a
      // check that the ticks really are on the rescaled axis.
      const cuts = {
        amber: (ticks[0].pct / 100) * m.BAR_FULL_SCALE,
        red: (ticks[1].pct / 100) * m.BAR_FULL_SCALE,
      };
      // the band class is load-bearing since H3(1) — it is what carries the per-band colour, so
      // this mirror of `renderPillarBars`' tick markup (lab.js) has to carry it too.
      const ticksHtml = ticks
        .map((t) => `<span class="lg-bar-tick ${t.band}" style="left:${t.pct}%"></span>`)
        .join("");
      const titles = { na: "n/a", g: (n) => `g${n}`, a: (n) => `a${n}`, r: (n) => `r${n}` };
      // one bar per backdrop: below amber (green), between the cuts (amber), past red (red)
      const values = { green: cuts.amber * 0.6, amber: (cuts.amber + cuts.red) / 2, red: cuts.red * 1.15 };
      document.getElementById("bartickprobe")?.remove();
      const host = document.createElement("div");
      host.id = "bartickprobe";
      host.style.cssText =
        "position:fixed;left:20px;top:20px;z-index:9999;background:var(--panel);padding:14px;display:flex;flex-direction:column;gap:12px;";
      host.innerHTML = Object.values(values)
        .map((v) => m.pillarBarHtml("E", { kind: "scored", value: v }, { ticksHtml, titles }))
        .join("");
      document.body.appendChild(host);
      const bars = [...host.querySelectorAll(".lg-bar")];
      const track0 = bars[0].querySelector(".lg-bar-track");
      const cs = getComputedStyle(track0);
      const outer = track0.getBoundingClientRect();
      // the % containing block for an absolutely-positioned child is the PADDING box
      const borderL = parseFloat(cs.borderLeftWidth);
      const cbWidth = outer.width - borderL - parseFloat(cs.borderRightWidth);
      return {
        cuts,
        tickPcts: ticks.map((t) => t.pct),
        track: { element: ".lg-bar-track", outerWidth: outer.width, borderLeft: borderL, cbWidth },
        placement: [...track0.querySelectorAll(".lg-bar-tick")].map((t, i) => ({
          band: ticks[i].band,
          pct: ticks[i].pct,
          measuredFromOuterLeft: t.getBoundingClientRect().x - outer.x,
          width: t.getBoundingClientRect().width,
        })),
        backdrops: Object.keys(values),
        fillEdges: bars.map((b) => {
          const tr = b.querySelector(".lg-bar-track").getBoundingClientRect();
          return b.querySelector(".lg-bar-fill").getBoundingClientRect().right - tr.x;
        }),
      };
    }, useDefaultCuts);

  // Rendered-pixel sampling: screenshot each track at DSF 1, re-decode in-page through a canvas.
  // EVERY pixel row of the tick column is returned, not just the middle one: since H3(1) the amber
  // hairline is dual-tone (2px ink / 2px ground / 1px ink over the track's 5px padding box), so a
  // single-row sample would report whichever segment happened to land at mid-height. The caller
  // scores a tick by HOW MANY rows clear the floor, not by its best one — "is a discernible SEGMENT
  // of this mark visible against what sits beside it", which is the question a banded hairline
  // actually poses, and which a max cannot answer. It is able to fail on both counts: the pre-R4
  // `var(--faint)` @ 0.55 tick measured 1.04 on the red fill at every row, and a sparser gradient
  // that lit a single pixel row would clear no count.
  const sampleTracks = async (tickX) => {
    const handles = await page.$$("#bartickprobe .lg-bar-track");
    const out = [];
    for (const h of handles) {
      const b64 = (await h.screenshot()).toString("base64");
      out.push(
        await page.evaluate(
          async ({ b64, tickX }) => {
            const img = new Image();
            img.src = "data:image/png;base64," + b64;
            await img.decode();
            const c = document.createElement("canvas");
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext("2d");
            ctx.drawImage(img, 0, 0);
            const all = ctx.getImageData(0, 0, img.width, img.height).data;
            const px = (x, y) => {
              const i = (y * img.width + x) * 4;
              return [all[i], all[i + 1], all[i + 2]];
            };
            // x rounded to the device column the hairline fully covers; backdrop sampled 2px off,
            // on the SAME row, so a banded tick is never scored against another row's backdrop.
            return tickX.map((rawX) => {
              const x = Math.round(rawX);
              const rows = [];
              for (let y = 0; y < img.height; y++) rows.push({ tick: px(x, y), back: px(x + 2, y) });
              return { x, rows };
            });
          },
          { b64, tickX },
        ),
      );
    }
    return out;
  };

  for (const useDefaultCuts of [false, true]) {
    const m = await measure(useDefaultCuts);
    const label = useDefaultCuts ? "BAND_CUTS default" : "served legRagCuts";
    console.log(
      `\n== ${label}: amber=${m.cuts.amber} red=${m.cuts.red} → ticks at ${m.tickPcts.map((p) => p.toFixed(3) + "%").join(" / ")}`,
    );
    console.log(
      `   measured against ${m.track.element}: outer ${m.track.outerWidth}px, border-left ${m.track.borderLeft}px, ` +
        `%-containing block (padding box) ${m.track.cbWidth}px`,
    );
    for (const t of m.placement) {
      const expected = (t.pct / 100) * m.track.cbWidth + m.track.borderLeft;
      const ok = Math.abs(t.measuredFromOuterLeft - expected) <= EPS;
      if (!ok) exitCode = 1;
      console.log(
        `   ${ok ? "ok  " : "FAIL"} tick[${t.band}] measured ${t.measuredFromOuterLeft.toFixed(2)}px from the track's outer left edge, ` +
          `expected ${expected.toFixed(2)}px (width ${t.width}px)`,
      );
    }
    console.log(`   fill edges (same origin): ${m.fillEdges.map((e) => e.toFixed(1) + "px").join(" / ")}`);

    const samples = await sampleTracks(m.placement.map((t) => t.measuredFromOuterLeft));
    // Every (tick band, backdrop) pair: the backdrop is the bar's fill where the tick sits left of
    // the fill edge, else the empty wash. A tick can never sit on a GREEN fill — a fill is green
    // only below the amber cut, i.e. it stops short of both ticks — so there is no green floor, and
    // the RED tick never reaches an amber fill either (see FLOORS).
    const seen = new Set();
    m.backdrops.forEach((fillBand, i) => {
      samples[i].forEach((s, ti) => {
        if (Math.abs(s.x - m.fillEdges[i]) <= 1) return; // straddling the edge: an ambiguous pixel
        const backName = s.x < m.fillEdges[i] ? fillBand : "track";
        const key = `${m.placement[ti].band}:${backName}`;
        if (seen.has(key)) return;
        seen.add(key);
        const floor = FLOORS[key];
        // The amber hairline is dual-tone, so its two segments answer different backdrops and only
        // ONE of them carries a given backdrop — but "some segment carries it" is not "the max row
        // carries it": scoring by the best row alone would pass a mark that is 4/5 invisible, so
        // count the rows that clear the floor and require a SEGMENT, not a pixel.
        //
        // N comes from the geometry. `.lg-bar-track` is 7px tall with 1px borders and
        // `box-sizing: border-box`, so the tick (`top:0; bottom:0`) fills a 5px padding box; the
        // screenshot's remaining rows are the 1px borders (plus one rounding row — the element
        // screenshot is 8 rows tall for the 7px track) and are never lit. `.lg-bar-tick.a`'s gradient
        // period is 4px, which truncates in that 5px box to 2px ink / 2px bg / 1px ink — 3 ink rows
        // and 2 ground rows (the solid `.r` tick lights all 5). Whichever tone answers a given
        // backdrop, the MINORITY tone is 2 rows, so N = 2 is the exact floor the shipped geometry
        // guarantees, and any sparser tone (a 1px-ink period, a single lit pixel) drops to 1 and
        // goes red. ⚠ Changing `.lg-bar-track`'s height changes the truncation phase and therefore
        // this count — re-derive N there, do not nudge it here.
        const LIT_ROWS_MIN = 2;
        const ratios = s.rows.map((r) => contrast(r.tick, r.back));
        const lit = floor === undefined ? 0 : ratios.filter((v) => v >= floor).length;
        const bestIdx = ratios.reduce((bi, v, i) => (v > ratios[bi] ? i : bi), 0);
        const best = { ratio: ratios[bestIdx], r: s.rows[bestIdx] };
        // an unlisted pair means a tick reached somewhere it cannot reach when placement is right
        // (a green fill stops short of both ticks) — that is a failure, not a missing floor
        const ok = floor !== undefined && lit >= LIT_ROWS_MIN;
        if (!ok) exitCode = 1;
        console.log(
          `   ${ok ? "ok  " : "FAIL"} contrast tick[${m.placement[ti].band}] on ${backName.padEnd(5)} backdrop: ` +
            `${lit}/${s.rows.length} rows clear the floor (need ${LIT_ROWS_MIN}); ` +
            `best row rgb(${best.r.tick}) vs rgb(${best.r.back}) = ${best.ratio.toFixed(2)} ` +
            (floor === undefined ? "(unreachable pair — placement is wrong)" : `(floor ${floor})`),
        );
      });
    });
    for (const need of Object.keys(FLOORS)) {
      if (!seen.has(need)) {
        exitCode = 1;
        console.log(`   FAIL no ${need.split(":")[0]} tick ever sampled against the ${need.split(":")[1]} backdrop — the check went vacuous`);
      }
    }
  }
} catch (e) {
  console.error("bar-tick-check failed:", e);
  exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
}
console.log(exitCode === 0 ? "\nbar-tick-check: PASS" : "\nbar-tick-check: FAIL");
process.exit(exitCode);
