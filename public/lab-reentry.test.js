// Re-entry block render seam — plain `.js` (vitest default glob, tsc ignores), no jsdom: string
// assertions on the returned HTML, same pattern as band-panel.test.js.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { boxOf } from "../src/ladder-box.ts";
import { LEG_FIELD } from "../src/danger-ladder.ts";
import { LEGS, renderLadderMd, runTime as mdRunTime, trancheCell } from "../src/ladder-live.ts";
import { injectRowTags, injectTags, injectWatch, stripTags } from "../src/ladder-reads.test-helpers.ts";
import { loadReentry, readOpen, readOpenState, renderReentry, REENTRY_BLOCKERS_CLASS, REENTRY_CRIT_CLASS, REENTRY_GRID_CLASS, REENTRY_LEGS, REENTRY_TOGGLES, REENTRY_WATCH_CLASS, resetReentryCache, runTime, tranche, watchBlock, writeOpen } from "./lab-reentry.js";
import { boardText, CLUSTER_HEAD, decidingWeek, otherWeek, gridRows, HELD_NOTE, JOB_LEGEND, seriesIds } from "./ladder-views.js";

const tr = (id, ok, filledSince = null) => ({ id, met: ok ? 4 : 1, total: 5, need: 4, ok, filledSince });
const lg = (key, tranche) => ({ key, tranche, gate: false, leg: `crit ${key}`, rule: `rule ${key}`, value: `close ${key}`, verdict: "unmet", count: { got: 1, need: 5 }, live: { value: `live ${key} <b>`, verdict: "met", count: { got: 5, need: 5 } } });
const ROSTER = [{ name: "credit", kind: "coincident", members: ["F1", "CCC"] }, { name: "vol", kind: "coincident", members: ["VT", "VXN"] }, { name: "rates", kind: "lead", members: ["R2", "R4"] }, { name: "capex", kind: "lead", members: ["HCX"] }];
const BOX = boxOf(ROSTER, { F1: "hit", CCC: false, VT: "hit", VXN: "hit", R2: "hit", R4: "na", HCX: "none" }, [{ name: "capex_guides", reach: "all" }]);
const DISP = { F1: { rule: "HY ≥ 6.00", value: "6.12/6.00", live: "6.20/6.00" }, CCC: { rule: "CCC ≥ 12", value: "11.8/12" }, VT: { rule: "VIX/VIX3M ≥ 1", value: "1.04/1" }, R2: { rule: "10y ≥ 5.35", value: "5.40/5.35", live: "5.31/5.35" } };
const FAMILIES = [{ name: "credit", rule: "HY ≥ 6.00", value: "CCC 12.52/12 ↑", verdict: "unmet", signs: [{ sign: "credit", lean: "bear", block: false }] }, { name: "capex", rule: "sign block only", value: "—", verdict: "na", signs: [{ sign: "capex_guides", lean: "unknown", block: true }] }];
/** A clustered box that holds (capex_guides veto, vol + rates votes); `NO_HOLD` = the same box with the veto off. */
const CLUSTERED = { tripped: BOX.votes.length, need: 2, hits: BOX.votes, unread: ["capex (HCX)"], families: FAMILIES, clusters: BOX.clusters.map((c) => ({ ...c, members: c.members.map((m) => ({ ...m, ...DISP[m.id] })) })), veto: BOX.veto, quorum: { live: BOX.live, n: BOX.n, need: BOX.quorum, t1Only: BOX.t1Only }, hold: BOX.hold };
const NO_HOLD = { ...CLUSTERED, veto: [], hold: false };
const LIVE = {
  run: "2026-10-07",
  verdict: {
    tranches: [tr("T1", true, "2026-10-06"), { ...tr("T2", false), gates: ["met", "unmet", "na"] }, tr("T3", false)],
    live: [tr("T1", true), tr("T2", false), tr("T3", false)],
    prov: true,
    regime: { set: "fast", exshVsMa200: 0.058 },
    legs: [lg("t1-a", "T1"), lg("t1-b", "T1"), lg("t2-a", "T2"), { ...lg("t2-g", "T2"), gate: true, leg: "gate: crit t2-g" }, { ...lg("t2-v", "T2"), gate: true, leg: "veto t2-v" }, lg("t3-a", "T3")],
    escalation: { tripped: 3, need: 2, hits: ["BONOS z ≥ 1.5", "BUND z ≥ 1.5"] },
    sessionsSinceExit: 4,
  },
  signs: Array.from({ length: 11 }, (_, i) => ({
    sign: `sign ${i}`,
    label: i ? "CHANGED" : "STALE 2026-09-30",
    lean: ["open", "open", "open", "open", "open", "escalation-leaning", "quiet", "unknown until 2026-10-22", "mixed", "open", "open"][i],
    finding: `fact ${i} <b>`,
    why: `why ${i}`,
    measurable: i === 2 ? "dates yes" : "",
    block: i === 3,
    checked: i ? "2026-10-07" : null,
    due: i ? "2026-10-14" : null,
    primary: i === 2 ? ["https://www.ecb.europa.eu/rss/press.html"] : [],
    search: ["q"],
    seed: [],
    sources: i === 1 ? [{ date: "2026-10-05", url: "https://www.example.org/a?x=1&y=2" }] : [],
  })),
  rules: ["T1 before 20 Oct <i>", "c", "e"],
  situation: { lean: "n", slow: "b <i>", fast: "c", decides: "w", flips: "z" },
  events: [
    { date: "2026-10-23", event: "Moody's on France", signs: ["sign 2"], escalationIf: "cut to A1", fizzleIf: "affirmed", holds: ["T2", "T3"], secondary: false, status: "NOT DUE until 2026-10-23" },
    { date: "2026-10-29", event: "ECB decision", signs: [], escalationIf: "hike", fizzleIf: "pause", holds: [], secondary: true, status: "NOT DUE until 2026-10-29" },
    { date: "2026-10-05", event: "Fitch on Italy", signs: ["sign 4"], escalationIf: "cut", fizzleIf: "affirmed", holds: ["T2"], secondary: false, status: "fizzle: affirmed, 10-05" },
  ],
  calendar: [
    { date: "2026-11-05", sign: "sign 2", event: "BoE MPC", matters: "UK rates", verified: false },
    { date: "2026-11-27", sign: "sign 2", event: "S&P France", matters: "rating", verified: true },
    { date: "2026-10-01", sign: "sign 2", event: "debate", matters: "—", verified: true },
    { date: "2026-10-09", sign: "sign 2", event: "S&P UK", matters: "UK leg", verified: false },
  ],
  runs: Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-0${7 - i}`, t1: "4/5 ✓", t2: "2/7 ✗", t3: "2/6 ✗", live: "✓✗✗ prov." })),
};
const tbody = (html, afterHead) => {
  const start = html.indexOf(afterHead);
  const body = html.slice(html.indexOf("<tbody>", start) + 7, html.indexOf("</tbody>", start));
  return body.split("<tr>").slice(1);
};

describe("tranche cell", () => {
  it("mirrors trancheCell over ok, via and gates; a dated tranche shows no date", () => {
    const cells = [tr("T1", true, "2026-10-06"), { ...tr("T1", true), via: "time stop" }, { ...tr("T2", true, "2026-10-08"), via: "after T1", gates: ["met", "unmet", "na"] }, { ...tr("T3", false), gates: [] }, { ...tr("T2", true, "2026-07-13"), ready: false, via: "after T1" }, { ...tr("T1", false, "2026-07-13") }];
    for (const t of cells) expect(tranche(t)).toBe(trancheCell(t));
    expect([tranche(cells[0]), tranche(cells[4]), tranche(cells[5])], "a dated tranche shows no fill date").toEqual(["✓: 4/5 need 4", "✓: 4/5 need 4 (after T1)", "✗: 1/5 need 4"]);
  });
});

describe("renderReentry", () => {
  it("the head shows runAt as HH:MM + zone beside the run date, mirroring runTime in src/ladder-live.ts; none without it", () => {
    expect(runTime("2026-10-07T13:37:00.000Z", "Europe/Tallinn")).toBe(mdRunTime("2026-10-07T13:37:00.000Z", "Europe/Tallinn"));
    expect(renderReentry({ ...LIVE, runAt: "2026-10-07T13:37:00.000Z" })).toMatch(/<span class="sm-note">run 2026-10-07 \d\d:\d\d \S+ · from /);
    expect(renderReentry(LIVE)).toContain('<span class="sm-note">run 2026-10-07 · from ');
    expect(renderReentry({ ...LIVE, runAt: "garbage" })).toContain('<span class="sm-note">run 2026-10-07 · from ');
  });
  it("footnotes: a superscript marker with its own hover ends the expected cell (first appearance, deduped by text); a hover:none-only list closes the Criteria detail; rows without `foot` unchanged", () => {
    const [a, b, c, ...rest] = LIVE.verdict.legs;
    const legs = [{ ...a, foot: "zeta", tip: "why a" }, { ...b, foot: "alpha" }, { ...c, foot: "zeta" }, ...rest];
    const html = renderReentry({ ...LIVE, verdict: { ...LIVE.verdict, legs } });
    const sup = (n, t) => `<sup class="reentry-foot" title="${t}">${n}</sup>`;
    expect([`<td title="why a">rule t1-a${sup("¹", "zeta")}</td>`, `<td>rule t1-b${sup("²", "alpha")}</td>`, `<td>rule t2-a${sup("¹", "zeta")}</td>`, "<td>rule t3-a</td>"].map((s) => html.includes(s))).toEqual([true, true, true, true]);
    // Inside the collapsed Criteria <details>, so on touch the list hides with its markers.
    const crit = html.match(new RegExp(`<details class="reentry-detail ${REENTRY_CRIT_CLASS}"[^>]*>[\\s\\S]*?</details>`))?.[0] ?? "";
    expect([crit.endsWith('<ol class="reentry-feet"><li>zeta</li><li>alpha</li></ol></details>'), html.split('<ol class="reentry-feet">').length]).toEqual([true, 2]);
    expect(html.replace(/<sup class="reentry-foot"[^>]*>.<\/sup>/g, "").replace(/<ol class="reentry-feet">.*?<\/ol>/, "").replace(' title="why a"', "")).toBe(renderReentry(LIVE));
    const css = readFileSync(fileURLToPath(new URL("./lab.css", import.meta.url)), "utf8");
    expect([/\.reentry \.reentry-foot \{/.test(css), /\.reentry \.reentry-feet \{[^}]*display: none;/.test(css), /@media \(hover: none\) \{ \.reentry \.reentry-feet \{ display: block; \} \}/.test(css)]).toEqual([true, true, true]);
  });
  it("Criteria detail paints collapsed by default and expanded on critOpen", () => {
    expect(renderReentry(LIVE)).toContain(`<details class="reentry-detail ${REENTRY_CRIT_CLASS}"><summary>`);
    expect(renderReentry(LIVE, "value", { critOpen: true })).toContain(`<details class="reentry-detail ${REENTRY_CRIT_CLASS}" open><summary>`);
  });
  it("lab.js wires every remembered toggle: the state read per paint, written from one CAPTURE-phase toggle listener walking REENTRY_TOGGLES (toggle never bubbles)", () => {
    // lab.js runs module-level DOM side effects (frontend.md) — the source scan pins its wiring.
    const src = readFileSync(fileURLToPath(new URL("./lab.js", import.meta.url)), "utf8");
    expect(src).toContain("renderReentry(live, leg, readOpenState(safeStorage()))");
    expect(src).toContain("const t = REENTRY_TOGGLES.find((t) => e.target.matches?.(`#reentry .${t.cls}`));\n  if (t) writeOpen(safeStorage(), t.key, e.target.open);");
    expect(src).toContain('document.addEventListener("toggle", onReentryToggle, true);');
  });
  it("remembered toggles: readOpen honours the default when unset, the stored value otherwise, the default on a blocked storage; readOpenState reads every REENTRY_TOGGLES entry; gridOpen paints ` open` on the Grid details only", () => {
    const map = {};
    const s = { getItem: (k) => (k in map ? map[k] : null), setItem: (k, v) => (map[k] = String(v)) };
    expect([readOpen(s, "k", true), readOpen(s, "k", false)]).toEqual([true, false]);
    writeOpen(s, "k", false);
    expect([readOpen(s, "k", true), map.k]).toEqual([false, "0"]);
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readOpen(blocked, "k", true)).toBe(true);
    expect(REENTRY_TOGGLES.map((t) => [t.cls, t.state, t.dflt])).toEqual([[REENTRY_CRIT_CLASS, "critOpen", false], [REENTRY_GRID_CLASS, "gridOpen", false], [REENTRY_BLOCKERS_CLASS, "blockersOpen", true], [REENTRY_WATCH_CLASS, "watchOpen", false]]);
    expect(readOpenState(s)).toEqual({ critOpen: false, gridOpen: false, blockersOpen: true, watchOpen: false });
    writeOpen(s, REENTRY_TOGGLES[1].key, true);
    writeOpen(s, REENTRY_TOGGLES[2].key, false);
    expect(readOpenState(s)).toEqual({ critOpen: false, gridOpen: true, blockersOpen: false, watchOpen: false });
    const html = renderReentry(LIVE, "value", { gridOpen: true });
    expect(html).toContain(`<details class="reentry-detail ${REENTRY_GRID_CLASS}" open><summary>Grid — one row per indicator × job</summary>`);
    expect(html).toContain(`<details class="reentry-detail ${REENTRY_CRIT_CLASS}"><summary>`);
    expect(renderReentry(LIVE, "value", { critOpen: true })).toContain(`<details class="reentry-detail ${REENTRY_GRID_CLASS}"><summary>`);
  });
  it("Deciding in the next 7 days: /lab and the md print the same decidingWeek text, above the Verdict table", () => {
    const live = { ...LIVE, run: "2026-10-25", events: [...LIVE.events, { date: "2026-10-28", event: "MSFT Q3", holds: ["T2"], status: "NOT DUE until 2026-10-28", signs: [] }] };
    const [html, md, text] = [renderReentry(live), renderLadderMd(live, "eufin"), decidingWeek(live)];
    const at = html.indexOf("<b>Deciding in the next 7 days</b> — ★ 10-23 Moody&#39;s on France (2d ago, holds T2+T3) · ★ 10-28 MSFT Q3 (3d, holds T2)");
    expect([text.includes("★ 10-28 MSFT Q3 (3d, holds T2)"), at > -1 && at < html.indexOf('<table class="sm-grid">'), md.includes(`**Deciding in the next 7 days** — ${text}`)]).toEqual([true, true, true]);
  });
  it("Other events in the next 7 days: /lab and the md print the same otherWeek text right after Deciding in the next 7 days", () => {
    const live = { ...LIVE, run: "2026-10-25", events: [...LIVE.events, { date: "2026-10-28", event: "FOMC", holds: [], status: "NOT DUE until 2026-10-28", signs: [] }] };
    const [html, md, text] = [renderReentry(live), renderLadderMd(live, "eufin"), otherWeek(live)];
    const at = (s, k) => s.indexOf(k);
    expect([
      text.includes("☆ 10-28 FOMC (3d)"),
      at(html, "<b>Deciding in the next 7 days</b>") < at(html, `<b>Other events in the next 7 days</b> — ${text}`) && at(html, "<b>Other events in the next 7 days</b>") < at(html, '<table class="sm-grid">'),
      md.includes(`**Deciding in the next 7 days** — ${decidingWeek(live)}\n\n**Other events in the next 7 days** — ${text}\n`),
    ]).toEqual([true, true, true]);
  });
  it("Grid: one closed <details> after the runs and before Episode gates; untagged → the empty-state note and no rows; tagged → 5 cells per row, one row per read key (families add none), mirroring the md Grid cell for cell; the series tip on a group's first indicator cell; the series + job notes after the table", () => {
    const html = renderReentry(LIVE);
    const at = (t) => html.indexOf(t);
    const open = `<details class="reentry-detail ${REENTRY_GRID_CLASS}"><summary>Grid — one row per indicator × job</summary>`;
    expect(html.split(open).length).toBe(2);
    expect([at("last 5 runs") < at(open), at(open) < at("Signs &amp; deciding events")]).toEqual([true, true]);
    const untagged = html.slice(at(open), html.indexOf("</details>", at(open)));
    expect([untagged.includes('<p class="sm-note">no read tags yet</p>'), untagged.includes("<tr>")]).toEqual([true, false]);
    const fixture = injectRowTags({ ...LIVE, verdict: { ...LIVE.verdict, legs: [...LIVE.verdict.legs, { ...lg("t2-esc", "T2"), gate: true, leg: "gate: escalation box" }], escalation: CLUSTERED } });
    fixture.verdict.legs[0].tag = { ...fixture.verdict.legs[0].tag, job: "composite", series: ["A1", "A2"] }; // t1-a → a second row in a's group (so "first row only" is observable) whose ids say more than its name (so it gets a tip; `b: b` does not)
    const tagged = renderReentry(fixture, "value");
    expect(renderReentry({ ...fixture, verdict: { ...fixture.verdict, escalation: { ...fixture.verdict.escalation, leadAlone: true } } }, "value")).toContain("Episode gates (hold on 1 lead cluster vote, or a veto)");
    const gridHtml = tagged.slice(tagged.indexOf(open), tagged.indexOf("</details>", tagged.indexOf(open)));
    expect([gridHtml.includes("Episode gates"), tagged.indexOf(open) < tagged.indexOf("Episode gates (hold")]).toEqual([false, true]);
    const rows = gridHtml.split("<tbody>")[1].split("<tr>").slice(1);
    expect(gridHtml).toContain("<thead><tr><th>indicator</th><th>job</th><th>T1</th><th>T2</th><th>T3</th></tr></thead>");
    for (const row of rows) expect((row.match(/<td[ >]/g) || []).length).toBe(5);
    const unesc = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const labCells = rows.map((r) => [...r.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => unesc(m[1])));
    const tipped = gridRows(fixture.verdict).rows.filter((r) => seriesIds(r).length); // one series tip per indicator group whose ids say more than its name, on its first row
    expect([tipped.length > 0, tipped.length < rows.length, rows.filter((r) => r.startsWith("<td title=")).length]).toEqual([true, true, tipped.length]);
    expect([...gridHtml.matchAll(/<td title="([^"]*)">/g)].map((m) => unesc(m[1]))).toEqual(tipped.map((r) => r.series.join(" · "))); // the tip IS the series list
    expect(gridHtml.split("</table>")[1]).toContain(`<p class="sm-note">series — `);
    expect(gridHtml.split("</table>")[1]).toContain(`<p class="sm-note">${JOB_LEGEND}</p>`);
    const md = renderLadderMd(fixture, "value");
    const mdGrid = md.slice(md.indexOf("## Grid")).split("\n## ")[0];
    const mdCells = mdGrid.split("\n").filter((l) => l.startsWith("|")).slice(2).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
    expect(labCells).toEqual(mdCells);
    expect(labCells.some((c) => c.includes("·")) && labCells.some((c) => c[1] === "comp" && c[2] === "·" && c[3].startsWith("2/4"))).toBe(true);
    // the rest of the block keeps the md's 5-column cap, the 6-column cluster table aside
    const eg = tagged.slice(tagged.indexOf(CLUSTER_HEAD));
    const clusterGrid = eg.slice(eg.indexOf("<table"), eg.indexOf("</table>"));
    const cellCount = (row) => (row.match(/<t[dh][\s>]/g) || []).length;
    expect(clusterGrid.split("<tr>").slice(1).map(cellCount)).toEqual(Array(8).fill(6));
    for (const row of tagged.replace(gridHtml, "").replace(clusterGrid, "").split("<tr>").slice(1)) expect(cellCount(row)).toBeLessThanOrEqual(5);
    expect(renderReentry({ ...LIVE, verdict: undefined })).not.toContain(REENTRY_GRID_CLASS);
  });
  it("Blockers: the three section roots each exactly once — reentry-blockers open by default (closed on blockersOpen: false), reentry-grid, reentry-crit; after the runs and before the Grid; per tranche an h4 head, then the unmet rows as li, the fold, the box note when it holds — li texts mirror the md's `- ` lines", () => {
    const html = renderReentry(LIVE);
    const roots = (h, cls) => h.split(`<details class="reentry-detail ${cls}"`).length - 1;
    expect([roots(html, REENTRY_BLOCKERS_CLASS), roots(html, REENTRY_GRID_CLASS), roots(html, REENTRY_CRIT_CLASS)]).toEqual([1, 1, 1]);
    expect(html).toContain(`<details class="reentry-detail ${REENTRY_BLOCKERS_CLASS}" open><summary>Blockers — T1 · T2 · T3</summary><h4>T1 ✓: 4/5 need 4 · live ✓: 4/5 need 4</h4><h4>T2 ✗: 1/5 need 4 · gates ✓✗– · live ✗: 1/5 need 4</h4><ul><li>crit t2-a — close t2-a ✗ 1/5 · live live t2-a &lt;b&gt; ✓ 5/5</li>`);
    expect(renderReentry(LIVE, "value", { blockersOpen: false })).toContain(`<details class="reentry-detail ${REENTRY_BLOCKERS_CLASS}"><summary>Blockers`);
    const at = (t) => html.indexOf(t);
    expect([at("last 5 runs") < at(REENTRY_BLOCKERS_CLASS), at(REENTRY_BLOCKERS_CLASS) < at(REENTRY_GRID_CLASS)]).toEqual([true, true]);
    expect(html).toContain(`<details class="reentry-detail ${REENTRY_CRIT_CLASS}"><summary>`); // the Criteria detail stays closed
    const met = (key, tranche, gate = false) => ({ ...lg(key, tranche), gate, verdict: "met", count: { got: 5, need: 5 }, ...(gate && { leg: `gate: crit ${key}` }) });
    const legs = [lg("t1-a", "T1"), met("t2-a", "T2"), lg("t2-b", "T2"), met("t2-c", "T2"), met("t2-g", "T2", true), { ...lg("t2-n", "T2"), gate: true, leg: "gate: crit t2-n", verdict: "na", count: undefined, value: "n/a" }, lg("t3-a", "T3")];
    const fixture = (escalation, leg = "value") => ({ live: { ...LIVE, verdict: { ...LIVE.verdict, legs, escalation } }, leg });
    const unesc = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const lab = (f) => {
      const h = renderReentry(f.live, f.leg);
      return h.slice(h.indexOf(`<details class="reentry-detail ${REENTRY_BLOCKERS_CLASS}"`), h.indexOf(`<details class="reentry-detail ${REENTRY_GRID_CLASS}"`));
    };
    const mdLines = (f) => {
      const md = renderLadderMd(f.live, f.leg);
      return md.slice(md.indexOf("## Blockers"), md.indexOf("## Grid")).split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
    };
    const liTexts = (h) => [...h.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => unesc(m[1]));
    for (const f of [fixture(NO_HOLD), fixture(CLUSTERED), fixture(NO_HOLD, "eufin")]) {
      expect(liTexts(lab(f)), `${f.leg} hold ${f.live.verdict.escalation.hold}`).toEqual(mdLines(f));
      expect(liTexts(lab(f)).length).toBeGreaterThan(4);
    }
    const holds = lab(fixture(CLUSTERED));
    expect(holds).toContain('<li>gate: crit t2-n — n/a – · live live t2-n &lt;b&gt; ✓ 5/5</li></ul><p class="sm-note">box holds: votes vol, rates · veto capex_guides</p><details class="reentry-detail"><summary>✓ 2/3 criteria (need 4) · ✓ 1 gates · box: holds (votes vol, rates)</summary><ul><li>crit t2-a —');
    // structure per unfilled tranche: h4 → ul (unmet) → [sm-note box line] → nested details (fold) → ul; the strings themselves are the md test's + the li parity above
    expect(lab(fixture(NO_HOLD)).trim().replace(/<li>[^<]*<\/li>/g, "").replace(/<summary>[^<]*<\/summary>/g, "<summary></summary>")).toBe(`<details class="reentry-detail ${REENTRY_BLOCKERS_CLASS}" open><summary></summary><h4>T1 ✓: 4/5 need 4 · live ✓: 4/5 need 4</h4><h4>T2 ✗: 1/5 need 4 · gates ✓✗– · live ✗: 1/5 need 4</h4><ul></ul><details class="reentry-detail"><summary></summary><ul></ul></details><h4>T3 ✗: 1/5 need 4 · live ✗: 1/5 need 4</h4><ul></ul><details class="reentry-detail"><summary></summary></details></details>`);
    const eu = lab(fixture(NO_HOLD, "eufin"));
    expect(eu.split("<summary>✓")[0].includes("t2-n"), "REENTRY_LEGS.eufin.naGateHolds is wired").toBe(false); // eufin: the na gate is unread, not a blocker
    expect(renderReentry({ ...LIVE, verdict: undefined })).not.toContain(REENTRY_BLOCKERS_CLASS);
  });
  it("REENTRY_LEGS mirrors LEGS: the same ids, json basenames and naGateHolds per leg", () => {
    expect(Object.keys(REENTRY_LEGS).sort()).toEqual(Object.keys(LEGS).sort());
    for (const id of Object.keys(LEGS)) expect([REENTRY_LEGS[id].json, REENTRY_LEGS[id].naGateHolds], id).toEqual([`/${LEGS[id].json.replace(/^public\//, "")}`, LEGS[id].naGateHolds]);
    expect([LEGS.eufin.naGateHolds, LEGS.value.naGateHolds]).toEqual([false, true]);
  });
  it("REENTRY_LEGS button order = ladder risk rank (LEG_FIELD sleeve → risk), riskiest first", () => {
    const risk = (id) => LEG_FIELD.find((r) => r.sleeve === REENTRY_LEGS[id].name)?.risk;
    const ids = Object.keys(REENTRY_LEGS);
    expect(ids.filter((id) => risk(id) === undefined), "every leg name is a LEG_FIELD sleeve").toEqual([]);
    expect(ids).toEqual([...ids].sort((a, b) => risk(a) - risk(b)));
  });
  it("paints the verdict, the newest 5 runs, ≤5 cells per row outside the Grid and the section heads in contract order", () => {
    const html = renderReentry(LIVE);
    expect(html).toContain("<th>live (prov.)</th>");
    expect(html).toContain("+5.8% vs MA200");
    expect(html).toContain("<td>T2</td><td>✗: 1/5 need 4 · gates ✓✗–</td><td>✗: 1/5 need 4</td>");
    for (const row of html.split("<tr>").slice(1)) expect((row.match(/<t[dh][\s>]/g) || []).length).toBeLessThanOrEqual(5);
    expect(tbody(html, "last 5 runs").length).toBe(5);
    const at = (t) => html.indexOf(`<h3 class="sm-title">${t}</h3>`);
    expect(html.indexOf("last 5 runs")).toBeLessThan(at("Signs &amp; deciding events"));
    for (const t of ["Deciding events", "Signs", "Events", "Calendar", "Rules", "Read", "Overall read", "Analysis", "Signs — detail", "Last 5 runs"]) expect(at(t)).toBe(-1);
    expect(html).not.toMatch(/style=/);
    const bare = renderReentry({ ...LIVE, calendar: undefined, rules: undefined, situation: undefined });
    expect(bare).not.toContain("reentry-rules");
    expect((bare.match(/reentry-para/g) || []).length).toBe(5);
    expect(bare.indexOf("<p class=\"reentry-para\"><b>Lean</b> — —</p>")).toBeLessThan(bare.indexOf("<b>Slow threat</b> — —"));
    expect(bare).not.toContain("<h3 class=\"sm-title\">Read</h3>");
    expect(html).not.toContain("dated, no sign");
    const lone = renderReentry({ ...LIVE, calendar: [...LIVE.calendar, { date: "2026-10-28", event: "FOMC", matters: "rates path", verified: true }, { date: "2026-10-13", sign: "gone", event: "bank Q3", matters: "—", verified: false }] });
    expect(lone).toContain('<p class="sm-note">dated, no sign</p><ul class="reentry-dates"><li>~ 2026-10-13 bank Q3 — date unverified</li><li>• 2026-10-28 FOMC — matters: rates path</li></ul>');
    const noted = renderReentry({ ...LIVE, calendar: [...LIVE.calendar, { date: "2026-10-28", event: "FOMC", matters: "—", verified: true, dateNote: "est." }, { date: "2026-10-13", event: "bank Q3", matters: "—", verified: false, dateNote: "~10-13" }] });
    expect(noted).toContain("<li>~ 2026-10-13 bank Q3 (~10-13) — date unverified</li><li>• 2026-10-28 FOMC</li>"); // dateNote only while unverified, as the md's eventItem / calendarItem
    const off = renderReentry({ ...LIVE, verdict: { ...LIVE.verdict, prov: false, regime: { set: "strict", exshVsMa200: null } } });
    expect(off).toContain("<th>live</th>");
    expect(off).not.toContain("(prov.)");
    expect(off).toContain("EXSH — vs MA200");
  });
  it("asOf dates the close + live heads of the tranche, criteria and gate grids like renderLadderMd; none → today's bare heads", () => {
    const at = (est, prov = true) => renderReentry({ ...LIVE, verdict: { ...LIVE.verdict, prov, asOf: { close: "2026-10-08", live: "2026-10-09", est } } });
    expect(at(true)).toContain("<th>tranche</th><th>close · Thu 10-08</th><th>live (prov.) · Fri 10-09 est.</th>");
    expect(at(true).split("<th>criterion</th><th>expected</th><th>close · Thu 10-08</th><th>live · Fri 10-09 est.</th>").length - 1).toBe(3);
    expect(at(true)).toContain("<th>gate (all must pass)</th><th>expected</th><th>close · Thu 10-08</th><th>live · Fri 10-09 est.</th>");
    expect(at(false, false)).toContain("<th>tranche</th><th>close · Thu 10-08</th><th>live · Fri 10-09</th>");
    expect(at(false, false)).not.toContain("est.");
    const bare = renderReentry(LIVE);
    expect(bare).toContain("<th>tranche</th><th>close</th><th>live (prov.)</th>");
    expect(bare.split("<th>criterion</th><th>expected</th><th>close</th><th>live</th>").length - 1).toBe(3);
  });
  it("signs board: lean group → soonest chip → signs[] order, an unattached event kept as its own last row, rules + tally on top", () => {
    const html = renderReentry(LIVE);
    const rows = html.split('<details class="reentry-detail reentry-sign"><summary>').slice(1);
    const names = rows.map((r) => r.match(/<span class="reentry-name"[^>]*>([^<]*)/)[1].trim());
    // escalation first; open/mixed by soonest upcoming chip (sign 2: 10-09) then index; quiet; not-yet; the orphan event last
    expect(names).toEqual(["sign 5", "sign 2", "sign 0", "sign 1", "sign 3", "sign 4", "sign 8", "sign 9", "sign 10", "sign 6", "sign 7", "ECB decision (secondary)"]);
    expect(rows.map((r) => r.match(/reentry-glyph lean-(\d)/)[1]).join("")).toBe("011111111233");
    expect(rows.filter((r) => r.includes("<b>BLOCK</b>")).length).toBe(1);
    expect(html).toContain('<p class="reentry-para"><b>Lean</b> — n</p>\n<p class="reentry-para"><b>Slow threat</b> — b &lt;i&gt;</p>\n<p class="reentry-para"><b>Fast threat</b> — c</p>\n<p class="reentry-para"><b>What decides it</b> — w</p>\n<p class="reentry-para"><b>What flips the lean</b> — z</p>');
    expect(html).toContain('<details class="reentry-detail"><summary>Rules (user-set)</summary><ul class="reentry-rules"><li>T1 before 20 Oct &lt;i&gt;</li><li>c</li><li>e</li></ul></details>');
    expect(html.indexOf("Slow threat")).toBeLessThan(html.indexOf("reentry-rules"));
    expect(html).toContain("▲1 escalation · ◆8 open/mixed · ▼1 fizzle/quiet · ○1 not yet — ★ deciding");
    expect(html.indexOf("reentry-rules")).toBeLessThan(html.indexOf("reentry-sign"));
  });
  it("a row a family names carries the board hint (indicators only) before its chips and the family → indicator pointer in its detail — never the value; rows no family names carry no hint", () => {
    const fam = { name: "credit", rule: "HY ≥ 6.00", value: "CCC 12.52/12 ↑", verdict: "unmet", signs: [{ sign: "sign 1", lean: "open", block: false }], tag: { indicator: "HY OAS · CCC", series: ["F1", "CCC"], job: "composite", agg: "box" } };
    const html = renderReentry({ ...LIVE, verdict: { ...LIVE.verdict, escalation: { ...LIVE.verdict.escalation, families: [fam] } } });
    const row = (n) => html.split('<details class="reentry-detail reentry-sign"><summary>').find((r) => r.includes(`>sign ${n}<`) || r.includes(`>sign ${n} <`));
    expect(row(1)).toContain('<span class="reentry-when"><span class="reentry-board" title="board: credit → HY OAS · CCC">HY OAS · CCC</span><span class="reentry-chip');
    expect(row(1)).toContain("<dt>board</dt><dd>credit → HY OAS · CCC</dd>");
    expect(row(1)).not.toMatch(/12\.52|TRIPPED|HY ≥ 6\.00/);
    expect(row(2)).not.toContain("reentry-board");
    expect(row(2)).toContain("<dt>board</dt><dd>—</dd>");
  });
  it("row cells carry their detail as tooltips: lean, why, finding + status, every event's sides, the next calendar row only ahead of the next event", () => {
    const html = renderReentry(LIVE);
    const row = (n) => html.split('<details class="reentry-detail reentry-sign"><summary>').find((r) => r.includes(`>sign ${n}<`) || r.includes(`>sign ${n} <`));
    expect(row(5)).toContain('<b class="reentry-glyph lean-0" title="escalation-leaning">▲</b>');
    expect(row(2)).toContain('<span class="reentry-name" title="why 2\nmeasurable: dates yes">sign 2</span>');
    expect(row(1)).toContain('<span class="reentry-find" title="fact 1 &lt;b&gt;\nCHANGED · checked 2026-10-07 · due 2026-10-14">fact 1 &lt;b&gt;</span>');
    // sign 2: the 10-09 calendar row precedes the 10-23 event → both chips; the 11-05 row (after the event) and the past 10-01 row are not chips
    const when = row(2).match(/<span class="reentry-when">(.*?)<\/span><\/summary>/s)[1];
    expect(when).toBe(
      '<span class="reentry-chip" title="2026-10-09 S&amp;P UK\nmatters: UK leg\ndate unverified">~ 10-09 2d</span>' +
        '<span class="reentry-chip" title="2026-10-23 Moody&#39;s on France\nholds T2+T3\nescalation if: cut to A1\nfizzle if: affirmed\nstatus: NOT DUE until 2026-10-23">★ 10-23 16d</span>',
    );
    // without the 10-09 row the next calendar row (11-05) trails the 10-23 event → the event is the only chip
    expect(renderReentry({ ...LIVE, calendar: LIVE.calendar.filter((c) => c.date !== "2026-10-09") })).toMatch(/>sign 2<\/span>.*?<span class="reentry-when"><span class="reentry-chip"[^>]*>★ 10-23 16d<\/span><\/span><\/summary>/s);
    // a landed event shows its outcome word, not a countdown; a chip-less row shows its research hold
    expect(row(4)).toContain(">★ 10-05 fizzle</span>");
    expect(row(4)).toContain("<li><b>★ 2026-10-05 Fitch on Italy</b> — holds T2 · status: fizzle: affirmed, 10-05</li>"); // settled → no escalation-if / fizzle-if
    // 2+ fizzles under one sign fold into one chip, each listed in its tooltip; a mixed event keeps its own chip (foldLanded, ladder-views.js)
    const fitch = LIVE.events.find((e) => e.event === "Fitch on Italy");
    const foldRow = renderReentry({ ...LIVE, events: [...LIVE.events, { ...fitch, date: "2026-10-06", event: "S&P on Italy", status: "fizzle: affirmed, 10-06" }, { ...fitch, date: "2026-10-06", event: "DBRS on Italy", status: "mixed: outlook cut, 10-06" }] });
    expect(foldRow).toContain('<span class="reentry-chip" title="★ 10-05 Fitch on Italy\n★ 10-06 S&amp;P on Italy">2 fizzled</span>');
    expect(foldRow).toMatch(/>2 fizzled<\/span><span class="reentry-chip" title="2026-10-06 DBRS on Italy[^"]*">★ 10-06 mixed<\/span>/);
    expect(renderReentry({ ...LIVE, events: LIVE.events.filter((e) => e !== fitch), eventsDone: [fitch] })).toBe(html); // a retired event renders as before (allEvents)
    expect(row(3)).toContain('<span class="reentry-chip reentry-held" title="CHANGED\nchecked 2026-10-07">held → 10-14</span>');
    expect(row(0)).toContain('<span class="reentry-chip">—</span>');
    expect(html).toContain('title="2026-10-29 ECB decision (secondary)\nholds no tranche\nescalation if: hike\nfizzle if: pause\nstatus: NOT DUE until 2026-10-29">☆ 10-29 22d</span>');
  });
  it("a dropped event: chip word `dropped`, no sides, folds to history after 7 d; a stored NOT DUE dated ≤ run reads `outcome owed` — /lab and the md alike", () => {
    const moodys = LIVE.events.find((e) => e.event === "Moody's on France");
    const live = {
      ...LIVE,
      events: [...LIVE.events.filter((e) => e !== moodys), { date: "2026-10-06", event: "Stale", signs: ["sign 5"], escalationIf: "x", fizzleIf: "y", holds: [], secondary: true, status: "NOT DUE until 2026-10-06" }],
      eventsDone: [{ ...moodys, holds: [], status: "dropped: cancelled" }, { date: "2026-09-20", event: "Gone", signs: ["sign 4"], holds: [], secondary: false, status: "dropped: duplicate" }],
    };
    for (const out of [renderReentry(live), renderLadderMd(live, "eufin")]) {
      expect(out).toContain("☆ 10-23 dropped"); // a drop stores holds: [] (applyEventPatch)
      expect(out).not.toContain("cut to A1"); // Moody's escalation-if
      expect(out).toContain("history: 1 settled (1 dropped)");
      expect([out.includes("status: outcome owed"), out.includes("status: NOT DUE until 2026-10-06")]).toEqual([true, false]);
    }
  });
  it("a future-dated dropped event is never the row's next event: the next calendar row after it stays a chip — /lab and the md alike", () => {
    const moodys = LIVE.events.find((e) => e.event === "Moody's on France");
    const live = { ...LIVE, calendar: LIVE.calendar.filter((c) => c.date !== "2026-10-09"), events: LIVE.events.filter((e) => e !== moodys), eventsDone: [{ ...moodys, holds: [], status: "dropped: cancelled" }] };
    for (const out of [renderReentry(live), renderLadderMd(live, "eufin")]) expect(out).toMatch(/~ 11-05 \d+d/); // sign 2's BoE MPC row, dated after the dropped 10-23
  });
  it("row detail: status, why, every dated item with its event sides, sources, pages", () => {
    const html = renderReentry(LIVE);
    expect(html).toContain(
      '<dt>dates</dt><dd><ul class="reentry-dates"><li>• 2026-10-01 debate</li><li>~ 2026-10-09 S&amp;P UK — matters: UK leg · date unverified</li><li><b>★ 2026-10-23 Moody&#39;s on France</b> — holds T2+T3 · escalation if: cut to A1 · fizzle if: affirmed · status: NOT DUE until 2026-10-23</li><li>~ 2026-11-05 BoE MPC — matters: UK rates · date unverified</li><li>• 2026-11-27 S&amp;P France — matters: rating</li></ul></dd>',
    );
    expect(html).toContain("<dt>status</dt><dd>STALE 2026-09-30 · open</dd>");
    expect(renderReentry({ ...LIVE, signs: LIVE.signs.map((x, i) => (i === 0 ? { ...x, label: "UNCHANGED 09-30", checked: "2026-10-07" } : x)) })).toContain("<dt>status</dt><dd>UNCHANGED 09-30 (+7d) · open · checked 2026-10-07</dd>");
    expect(html).toContain("<dt>why</dt><dd>why 4</dd><dt>board</dt><dd>—</dd>");
    expect(renderReentry({ ...LIVE, verdict: { ...LIVE.verdict, escalation: { ...LIVE.verdict.escalation, families: [{ name: "credit", rule: "r", value: "CCC 12.82/12.5 ↑", verdict: "unmet", live: { value: "CCC 12.77/12.5 ↑ est.", verdict: "unmet" }, signs: [{ sign: "sign 4", lean: "open", block: false }] }] } } })).toContain("<dt>board</dt><dd>credit</dd>"); // untagged family → its name alone, never the value
    expect(html).toContain("<i>(measurable: dates yes)</i>");
    expect(html).toContain('<a href="https://www.example.org/a?x=1&amp;y=2" target="_blank" rel="noopener">10-05 example.org</a>');
    expect(html).toContain('<dt>pages</dt><dd><a href="https://www.ecb.europa.eu/rss/press.html" target="_blank" rel="noopener">ecb.europa.eu</a></dd>');
    expect(html).not.toContain("<dt>press</dt>"); // no row carries press[]
    // press[] renders beside pages; a landed event's sources join its detail (mirrors eventItem in src/ladder-live.ts)
    const pressed = renderReentry({ ...LIVE, signs: LIVE.signs.map((x, i) => (i === 2 ? { ...x, press: ["https://www.reuters.com/a"] } : x)), events: LIVE.events.map((e, i) => (i === 0 ? { ...e, sources: [{ date: "2026-10-08", url: "https://a.org/x" }] } : e)) });
    expect(pressed).toContain('ecb.europa.eu</a></dd><dt>press</dt><dd><a href="https://www.reuters.com/a" target="_blank" rel="noopener">reuters.com</a></dd>');
    expect(pressed).toContain("status: NOT DUE until 2026-10-23 · sources: 2026-10-08 https://a.org/x");
  });
  it("a probe row: the finding is its live box reading; no held chip, sources, due or checked (mirrors the md probe rows)", () => {
    const probe = { ...LIVE.signs[1], sign: "cg", probe: true, finding: "metalcharts 637 intraday", label: "PROBE 10-06", checked: "2026-10-06", due: "2026-10-14", sources: [{ date: "2026-09-14", url: "https://metalcharts.org/x" }] };
    const verdict = { ...LIVE.verdict, escalation: { ...LIVE.verdict.escalation, families: [{ name: "cg_drop", rule: "r", value: "v", verdict: "met", live: { value: "w", verdict: "unmet" }, signs: [{ sign: "cg" }], tag: { indicator: "Cu/Au" } }] } };
    const row = renderReentry({ ...LIVE, verdict, signs: [probe] }).split('<details class="reentry-detail reentry-sign"><summary>').find((r) => r.includes(">cg<"));
    expect([row.includes("held →"), row.includes("<dt>sources</dt>"), row.includes("due "), row.includes("checked "), row.includes("metalcharts")]).toEqual([false, false, false, false, false]);
    expect(row.match(/<span class="reentry-find reentry-probe"[^>]*>(.*?)<\/span>/)[1]).toBe("cg_drop v ✓ · live w ✗");
  });
  it("shared-gates grid: gate rows identical across ≥ 2 tranches render once before T1, labelled with their tranches when fewer than three; own grids keep only their own rows (mirrors renderLadderMd)", () => {
    const g = (key, tranche, leg, rule = `rule ${leg}`) => ({ ...lg(key, tranche), gate: true, leg, rule, value: `close ${leg}`, live: { value: `live ${leg}`, verdict: "met" } });
    const legs = [lg("t1-a", "T1"), g("t1-v", "T1", "gate: veto"), g("t2-v", "T2", "gate: veto"), g("t2-h", "T2", "gate: HY guard"), g("t2-e", "T2", "gate: ew", "MA20 > MA50"), lg("t3-a", "T3"), g("t3-v", "T3", "gate: veto"), g("t3-h", "T3", "gate: HY guard"), g("t3-e", "T3", "gate: ew", "MA50 Δ10 > 0")];
    const html = renderReentry({ ...LIVE, verdict: { ...LIVE.verdict, legs } });
    const crit = html.slice(html.indexOf("<summary>Criteria detail"), html.indexOf("</details>", html.indexOf("<summary>Criteria detail")));
    const [every, t1, t2, t3] = crit.split(/<h4>(?:shared gates|T[123])<\/h4>/).slice(1);
    expect([crit.indexOf("<h4>shared gates</h4>") >= 0, crit.indexOf("<h4>shared gates</h4>") < crit.indexOf("<h4>T1</h4>")], "shared grid present and leads").toEqual([true, true]);
    expect(every.match(/<tr><td>[^<]*<\/td>/g)).toEqual(["<tr><td>veto</td>", "<tr><td>HY guard (T2·T3)</td>"]);
    expect([t1.includes("veto"), t2.includes("veto"), t2.includes("HY guard"), t3.includes("HY guard")], "own grids drop the shared rows").toEqual([false, false, false, false]);
    expect([t2.includes("<td>ew</td><td>MA20 &gt; MA50</td>"), t3.includes("<td>ew</td><td>MA50 Δ10 &gt; 0</td>"), every.includes("ew")], "a same-label gate whose rule differs stays per tranche").toEqual([true, true, false]);
    expect(renderReentry(LIVE)).not.toContain("every tranche");
  });
  it("criteria detail: one closed <details> after the tranche table and before the runs; per tranche a criteria grid, then a gate grid only when it has gates", () => {
    const html = renderReentry(LIVE);
    const at = (t) => html.indexOf(t);
    const open = '<details class="reentry-detail reentry-crit"><summary>Criteria detail — T1 · T2 · T3</summary>';
    expect(html.split(open).length).toBe(2);
    expect([at("<th>tranche</th>") < at(open), at(open) < at("last 5 runs")]).toEqual([true, true]);
    const crit = html.slice(at(open), html.indexOf("</details>", at(open)));
    expect(crit.match(/<h4>T[123]<\/h4>/g)).toEqual(["<h4>T1</h4>", "<h4>T2</h4>", "<h4>T3</h4>"]);
    const gateHead = "<th>gate (all must pass)</th>";
    const blocks = crit.split(/<h4>T[123]<\/h4>/).slice(1);
    expect(blocks.map((b) => b.split(gateHead).length - 1)).toEqual([0, 1, 0]);
    const [critGrid, gateGrid] = blocks[1].split(gateHead);
    expect([critGrid.includes("<td>crit t2-a</td>"), critGrid.includes("t2-g"), critGrid.includes("t2-v")]).toEqual([true, false, false]);
    expect([gateGrid.includes("<tr><td>crit t2-g</td><td>rule t2-g</td>"), gateGrid.includes("<tr><td>veto t2-v</td>"), crit.includes("gate: crit")]).toEqual([true, true, false]);
    expect(crit.split("<tr><td>").length - 1).toBe(6);
    expect(crit).toContain("<td>crit t1-a</td><td>rule t1-a</td><td>close t1-a ✗ 1/5</td><td>live t1-a &lt;b&gt; ✓ 5/5</td>");
    const tipped = renderReentry({ ...LIVE, verdict: { ...LIVE.verdict, legs: [{ ...lg("t1-a", "T1"), tip: "base = <median>" }] } });
    expect(tipped, "the expected cell carries the anchor tooltip").toContain('<td>crit t1-a</td><td title="base = &lt;median&gt;">rule t1-a</td>');
    expect(html).not.toMatch(/reentry-crit" open/); // the Blockers details is the one open by default
    expect(renderReentry({ ...LIVE, verdict: { ...LIVE.verdict, legs: undefined } })).not.toContain("reentry-crit");
  });
  it("Episode gates: between the Grid details and Signs, /lab paints the md's cluster → member rows, box footer and signs-shown family rows cell for cell; no clusters → nothing renders", () => {
    const [box, escalation] = [BOX, CLUSTERED];
    const live = { ...LIVE, verdict: { ...LIVE.verdict, asOf: { close: "2026-10-12", live: "2026-10-13", est: true }, escalation } };
    const md = renderLadderMd(live, "value");
    const html = renderReentry(live, "value");
    const g = md.slice(md.indexOf("## Episode gates"), md.indexOf("\n## Signs"));
    const mdTables = g.split("\n\n").filter((b) => b.startsWith("|")).map((t) => t.trim().split("\n").filter((_, i) => i !== 1).map((l) => l.split(" | ").map((c) => c.replace(/^\| ?| ?\|$/g, "").trim())));
    const labTables = html.slice(html.indexOf("Episode gates"), html.indexOf("Signs &amp; deciding events")).split("<table").slice(1).map((t) => t.split("</table>")[0].split("<tr>").slice(1).map((r) => [...r.matchAll(/<t[hd]>(.*?)<\/t[hd]>/g)].map((m) => m[1])));
    expect(mdTables.map((t) => t.length)).toEqual([8, 3]);
    expect(labTables).toEqual(mdTables);
    expect(mdTables[0].slice(0, 3)).toEqual([["cluster", "member", "trips when", "close · Mon 10-12", "live · Tue 10-13 est.", "signs"], ["credit · coincident · 1/2 of 2", "F1", "HY ≥ 6.00", "6.12/6.00 ✗ HIT", "6.20/6.00", "—"], ["", "CCC", "CCC ≥ 12", "11.8/12 ✓", "11.8/12", "—"]]);
    const foot = `box: holds every tranche · votes vol, rates · veto capex_guides · live ${box.live}/${box.n} need ${box.quorum} · unread: capex (HCX) · 4 closes since the drawdown opened`;
    expect([g.includes(`\n\n${foot}\n\n**signs (shown, no vote)**\n\n| family |`), html.includes(`<p class="sm-note">${foot}</p><p class="sm-note"><b>signs (shown, no vote)</b></p><table`)]).toEqual([true, true]);
    const at = (t) => html.indexOf(t);
    expect([at("last 5 runs") < at(REENTRY_GRID_CLASS), at(REENTRY_GRID_CLASS) < at("Episode gates"), at("Episode gates") < at("Signs &amp; deciding events"), renderReentry(LIVE).includes("Episode gates")]).toEqual([true, true, true, false]);
  });
  it("null → the empty state, the leg toggle still painted", () => {
    const html = renderReentry(null, "eufin");
    expect(html).toContain("No re-entry state published yet.");
    expect(html).toContain('data-leg="value"');
  });
  it("leg toggle: buttons in REENTRY_LEGS order, the first (Semis) pressed by default; the picked leg names the title + source; per-leg regime extras", () => {
    const def = renderReentry(LIVE);
    expect([...def.matchAll(/data-leg="(\w+)"/g)].map((m) => m[1])).toEqual(Object.keys(REENTRY_LEGS)); // the order itself is the risk-rank test's
    expect(def).toContain('data-leg="sp500" aria-pressed="false">S&amp;P 500<');
    expect(def).toContain('data-leg="semis" aria-pressed="true" class="active">Semis<');
    expect(def).toContain('data-leg="spit" aria-pressed="false">S&amp;P IT<');
    expect(def).toContain('data-leg="value" aria-pressed="false">Value<');
    expect(def).toContain('data-leg="eufin" aria-pressed="false">EU-Fin<');
    expect(def).toContain("Semis re-entry</h2>");
    expect(def).toContain("from /semis.json");
    const eu = renderReentry(LIVE, "eufin");
    expect(eu).toContain('data-leg="eufin" aria-pressed="true" class="active">EU-Fin<');
    expect(eu).toContain("EU-Fin re-entry</h2>");
    expect(eu).toContain("from /eufin.json");
    const va = renderReentry(LIVE, "value");
    expect(va).toContain('data-leg="value" aria-pressed="true" class="active">Value<');
    expect(va).toContain("Value re-entry</h2>");
    expect(va).toContain("from /value.json");
    const { exshVsMa200, ...regime } = LIVE.verdict.regime;
    const { sessionsSinceExit, ...rest } = LIVE.verdict;
    const val = renderReentry({ ...LIVE, verdict: { ...rest, regime: { ...regime, set: "entry" }, display: { maN: 50, vsMa: 0.025, zoneSince: "2026-10-02" } } }, "value");
    expect(val).toContain("entry set · display: +2.5% vs MA50 — never a gate · zone open since 2026-10-02");
    expect(val).not.toContain("EXSH");
  });
});

describe("drawdown watch block", () => {
  it("cell + head texts == the md's `## Drawdown watch`; without `verdict.watch` the render is the watch-bearing one minus exactly that block", () => {
    const live = injectWatch(LIVE, undefined, "2026-10-20");
    const html = watchBlock(live.verdict);
    const md = renderLadderMd(live, "value").split("## Drawdown watch")[1].split("\n## ")[0];
    const mdCells = md.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("| row |") && !l.startsWith("|---")).flatMap((l) => l.slice(2, -2).split(" | "));
    expect([...html.matchAll(/<td>(.*?)<\/td>/g)].map((m) => m[1])).toEqual(mdCells);
    const notes = [...html.matchAll(/<p class="sm-note">(.*?)<\/p>/g)].map((m) => m[1]);
    expect(md).toContain(`\n${notes[0]}\n`);
    expect([notes.length, md.includes(`\n_${notes[1]}_\n`)], "the context note heads its own grid in both renders").toEqual([2, true]);
    const withWatch = renderReentry(live, "value");
    expect(withWatch.indexOf(html)).toBeLessThan(withWatch.indexOf("<table"));
    expect(withWatch.replace(`${html}\n`, "")).toBe(renderReentry({ ...live, verdict: LIVE.verdict }, "value"));
  });
  it("a remembered toggle: collapsed by default with the grade in its summary, ` open` on watchOpen", () => {
    const live = injectWatch(LIVE, undefined, "2026-10-20");
    const summary = `<summary>Drawdown watch — ${live.verdict.watch.grade}`;
    expect(renderReentry(live, "value")).toContain(`<details class="reentry-detail ${REENTRY_WATCH_CLASS}">${summary}`);
    expect(renderReentry(live, "value", { watchOpen: true })).toContain(`<details class="reentry-detail ${REENTRY_WATCH_CLASS}" open>${summary}`);
  });
  it("held (no drawdown open) → Blockers summary `Would hold` + the note; an open exit keeps `Blockers`", () => {
    expect(renderReentry(injectWatch(LIVE), "value")).toContain(`<summary>Would hold — T1 · T2 · T3</summary><p class="sm-note">${HELD_NOTE}</p><h4>T1`);
    expect(renderReentry(injectWatch(LIVE, undefined, "2026-10-20"), "value")).toContain("<summary>Blockers — T1 · T2 · T3</summary><h4>T1");
  });
});

describe("loadReentry", () => {
  it("a 404 → null, and the second call does not re-fetch", async () => {
    resetReentryCache();
    const fetchFn = vi.fn(async () => ({ ok: false, status: 404 }));
    expect(await loadReentry(undefined, fetchFn)).toBe(null);
    expect(await loadReentry(undefined, fetchFn)).toBe(null);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe("/semis.json");
  });
  it("an OK body is parsed and cached", async () => {
    resetReentryCache();
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => LIVE }));
    expect((await loadReentry("eufin", fetchFn)).run).toBe("2026-10-07");
    expect((await loadReentry("eufin", fetchFn)).run).toBe("2026-10-07");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe("/eufin.json");
    await loadReentry("value", fetchFn);
    expect(fetchFn.mock.calls.map((c) => c[0])).toEqual(["/eufin.json", "/value.json"]);
  });
});

// Read schema: the lab renderer ignores `tag` everywhere but the Grid over every
// committed leg JSON (tag-stripped — the stored file carries tags after an `--into` run) — md twin in src/ladder-reads.test.ts.
describe("renderReentry ignores read tags everywhere but the Grid and the sign rows' board pointer", () => {
  const load = (leg) => stripTags(JSON.parse(readFileSync(new URL(`../${LEGS[leg].json}`, import.meta.url), "utf8")));
  /** The html with the Grid details cut out — every other byte must ignore tags. */
  const sansGrid = (html) => {
    const at = html.indexOf(`<details class="reentry-detail ${REENTRY_GRID_CLASS}"`);
    const end = html.indexOf("</details>", at) + "</details>".length;
    expect(end - at).toBeGreaterThan(40);
    return html.slice(0, at) + html.slice(end);
  };
  /** The html with every sign row's board pointer (the `reentry-board` hint + the `<dt>board>` dd) blanked — the one tag-printing slot outside the Grid. */
  const sansBoard = (html) => html.replace(/<span class="reentry-(?:board|find reentry-probe)"[^>]*>[^<]*<\/span>/g, "").replace(/<dt>board<\/dt><dd>[^<]*<\/dd>/g, "<dt>board</dt><dd></dd>");
  it.each(Object.keys(LEGS))("%s: tags print only in the Grid and the board pointer — byte-identical elsewhere, criteria open and closed; the whole html differs", (leg) => {
    const live = load(leg);
    // A family tag reaches only the board pointer: blanked, the tagged html is byte-identical outside the Grid.
    const html0 = renderReentry(injectTags(live), leg);
    expect(sansGrid(html0)).toContain(">TAGGED-indicator</span>");
    expect(sansBoard(sansGrid(html0))).toBe(sansBoard(sansGrid(renderReentry(live, leg))));
    expect(sansBoard(sansGrid(html0))).not.toContain("TAGGED");
    // Family tags restored to the untagged ones: no board blanking needed, and only the Grid prints tags.
    const tagged = injectTags(live);
    if (tagged.verdict.escalation.families) tagged.verdict.escalation.families = live.verdict.escalation.families;
    expect(tagged.verdict.legs.every((l) => l.tag !== undefined)).toBe(true);
    for (const critOpen of [true, false]) {
      const html = renderReentry(tagged, leg, { critOpen });
      expect(sansGrid(html)).toBe(sansGrid(renderReentry(live, leg, { critOpen })));
      expect(sansGrid(html)).not.toContain("TAGGED");
      expect(html).not.toBe(renderReentry(live, leg, { critOpen }));
    }
  });
});

describe("Holding now + the folded dates history — /lab mirrors the md", () => {
  const ev = (date, event, holds, status) => ({ date, event, signs: ["sign 2"], escalationIf: "cut", fizzleIf: "affirmed", holds, secondary: false, status });
  const FOLD = {
    ...LIVE,
    run: "2026-10-30",
    signs: LIVE.signs.map((s) => (s.sign === "sign 3" ? { ...s, blocked: { on: "2026-10-04", by: "Scope" } } : s)),
    events: [ev("2026-10-01", "Fitch", ["T2"], "fizzle: affirmed, 10-01"), ev("2026-10-03", "Scope", [], "escalation: cut, 10-03"), ev("2026-10-05", "Moody's", ["T2", "T3"], "mixed: outlook cut, 10-05"), ev("2026-10-27", "DBRS", ["T2"], "fizzle: affirmed, 10-27")],
  };
  it("the Holding now line sits right above Deciding, with the md's text", () => {
    const text = "Moody's (mixed, 25 d) holds T2+T3 · sign 3 BLOCK (by Scope, 26 d)";
    expect(renderReentry(FOLD)).toContain(`<p class="sm-note"><b>Holding now</b> — ${text.replace("'", "&#39;")}</p><p class="sm-note"><b>Deciding in the next 7 days</b>`);
    expect(renderLadderMd(FOLD, "eufin")).toContain(`\n**Holding now** — ${text}\n`);
    expect(renderReentry({ ...FOLD, signs: LIVE.signs.map((s) => ({ ...s, block: false })), events: [] })).not.toContain("Holding now");
  });
  it("a row's old non-holding items fold into one <details> history entry (the md's history text) expanding to them; holding, owed, recent and upcoming items stay", () => {
    const dd = renderReentry(FOLD).split("<dt>dates</dt><dd>").slice(1).map((d) => d.split("</dd>")[0]).find((d) => d.includes("Moody"));
    const summary = "history: 2 settled (1 fizzle · 1 dated) · last 10-01 debate";
    expect(dd).toBe(
      `<ul class="reentry-dates"><li><details class="reentry-detail"><summary>${summary}</summary><ul class="reentry-dates">` +
        "<li><b>★ 2026-10-01 Fitch</b> — holds T2 · status: fizzle: affirmed, 10-01</li><li>• 2026-10-01 debate</li></ul></details></li>" +
        "<li><b>☆ 2026-10-03 Scope</b> — holds no tranche · status: escalation: cut, 10-03</li>" +
        "<li><b>★ 2026-10-05 Moody&#39;s</b> — holds T2+T3 · escalation if: cut · fizzle if: affirmed · status: mixed: outlook cut, 10-05</li>" +
        "<li>~ 2026-10-09 S&amp;P UK — matters: UK leg · date unverified</li>" + // passed, unverified, mattering: its outcome is owed
        "<li><b>★ 2026-10-27 DBRS</b> — holds T2 · status: fizzle: affirmed, 10-27</li>" +
        "<li>~ 2026-11-05 BoE MPC — matters: UK rates · date unverified</li><li>• 2026-11-27 S&amp;P France — matters: rating</li></ul>",
    );
    const md = renderLadderMd(FOLD, "eufin");
    expect(md).toContain(`\n  - ${summary}\n`);
    expect(md).toContain("\n  - ~ 2026-10-09 S&P UK — matters: UK leg · date unverified\n  - ★ 2026-10-27 DBRS");
  });
});
