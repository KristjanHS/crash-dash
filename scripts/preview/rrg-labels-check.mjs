// Verifies View C (RRG quadrant) label de-collision on a *running* /lab page:
// no label overlaps, none escaping the top edge (the reported bug), none far off the
// bottom, no console errors. Measures the REAL rendered DOM via Playwright — the
// buildQuadrant() declutter depends on CSS box/label metrics, so this catches what a
// pure-JS unit test (public/*.test.js) can't.
//
// Usage — needs a preview server already serving /lab (preview:live renders it; mock
// `preview` does NOT):
//     npm run preview:live &          # or on another PORT
//     node scripts/preview/rrg-labels-check.mjs [baseUrl]
//     BASE=http://localhost:4321 node scripts/preview/rrg-labels-check.mjs
// For real-data legs, run the cron once first (`npm start`) so Live mode has a run;
// otherwise Live 404s on a fresh DB and no quadrant paints.
// Exit 0 = all invariants hold, 1 = a violation (CI-friendly). Writes out/rrg-live.png.
import { chromium } from "playwright";

const base = process.argv[2] || process.env.BASE || `http://localhost:${process.env.PORT || 4321}`;
const EPS = 0.5; // px tolerance for sub-pixel rounding

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1600 } });
const errs = [];
page.on("console", (m) => m.type() === "error" && errs.push(m.text()));

await page.goto(`${base}/lab`, { waitUntil: "networkidle" });
const painted = await page
  .waitForSelector("#rrgQuadrant .rrg-dot", { timeout: 15000 })
  .then(() => true)
  .catch(() => false);
if (!painted) {
  console.error(`FAIL: no #rrgQuadrant dots at ${base}/lab — is preview:live up with a cron run?`);
  await browser.close();
  process.exit(1);
}

// Pull each label's box relative to the quadrant, so the checks are resolution-independent.
const data = await page.evaluate(() => {
  const box = document.querySelector("#rrgQuadrant .rrg").getBoundingClientRect();
  const labels = [...document.querySelectorAll("#rrgQuadrant .rrg-label")].map((el) => {
    const r = el.getBoundingClientRect();
    return { text: el.textContent.trim(), top: r.top - box.top, bottom: r.bottom - box.top, left: r.left - box.left, right: r.right - box.left };
  });
  return { boxH: box.height, boxW: box.width, labels };
});

console.log(`box ${data.boxW.toFixed(0)}x${data.boxH.toFixed(0)}, ${data.labels.length} labels @ ${base}/lab`);
const sorted = [...data.labels].sort((a, b) => a.top - b.top);
let overlaps = 0, topOver = 0, botOver = 0;
for (const l of sorted) {
  const flags = [];
  if (l.top < -EPS) { flags.push("OVER-TOP"); topOver++; }
  if (l.bottom > data.boxH + EPS) { flags.push("OVER-BOTTOM"); botOver++; }
  console.log(`  ${l.text.padEnd(20)} top=${l.top.toFixed(0).padStart(4)} bot=${l.bottom.toFixed(0).padStart(4)} left=${l.left.toFixed(0).padStart(4)} ${flags.join(" ")}`);
}
// The declutter's contract is pure vertical separation, so a consecutive-by-top scan is a
// complete guard (labels are uniform height): any vertical overlap forces a consecutive one.
for (let i = 1; i < sorted.length; i++) {
  const a = sorted[i - 1], c = sorted[i];
  if (c.top < a.bottom - EPS) { overlaps++; console.log(`  OVERLAP: "${a.text}" & "${c.text}"`); }
}

console.log(`\nconsole errors: ${errs.length}${errs.length ? " -> " + errs.slice(0, 3).join(" | ") : ""}`);
console.log(`overlaps: ${overlaps} | over-top: ${topOver} | over-bottom: ${botOver}`);
const pass = overlaps === 0 && topOver === 0 && errs.length === 0; // bottom hang tolerated (full-span data only)
console.log(pass ? "PASS ✔  (no overlap, none over top edge)" : "FAIL �’");
await page.screenshot({ path: new URL("./out/rrg-live.png", import.meta.url).pathname });
await browser.close();
process.exit(pass ? 0 : 1);
