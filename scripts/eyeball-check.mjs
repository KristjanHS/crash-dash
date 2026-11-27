#!/usr/bin/env -S npx tsx
// Eyeball-test support — precompute the server-side truth behind the manual
// (browser) eyeball checks, against the live deployment, and print a runbook
// with the CURRENT expected outcomes baked in.
//
// The dashboard has verification steps that only a human eye can close (does the
// color bar recolor, do the dashed band lines reposition, do the cards paint).
// This tool automates everything AROUND that eye: it confirms the data exists
// and is fresh, and — crucially — DISCOVERS which indicators' DETAIL ribbon actually
// differs from the stored one THIS run, so you know exactly what to open
// and what you should see. It does not (cannot) replace the visual confirmation.
//
// Three tasks, mirroring the OWED[USER] eyeballs:
//   [1] RIBBON     — `?detail=1` recompute vs stored state  → detail bar differs from the card
//   [2] BAND LINES — the drawn effAmber/effRed pair exists   → dashed lines are drawn at all
//   [3] CARDS      — off-ladder series (CG/VT/VIX/VIX3M) fresh & non-empty
//
// The tracking-mode (market × mode) cell system was removed 2026-08-27: `/api/series` now
// recomputes under the SHARED (null-row) cuts — the same cuts the notify path scores — gated
// on `?detail=1`, the flag `app.js` sends only for the detail chart. [1] and [2] therefore
// compare the recompute against the STORED series, the one divergence still observable.
// [2] must read the numbers the dashboard actually DRAWS: `app.js` renders the dashed
// lines from `/api/series`'s top-level `effAmber`/`effRed`. Both tasks share one fetch pair.
//
// Usage:
//   npm run eyeball                          # against the prod alias (PROD_ALIAS, else the prod config's)
//   BASE_URL=http://localhost:4321 npm run eyeball   # against a preview server
//   npx tsx scripts/eyeball-check.mjs --json   # tsx, not node: it imports the TS prod-config helper
//
// Flags:
//   --indicators=R1,R2,...    override the measured-indicator candidate set
//   --json                    machine-readable output (for /loop or CI)
//
// Exit code: 0 = preconditions OK (safe to eyeball). 1 = BLOCKED — a card is
// empty, an endpoint is unreachable, or the feed heartbeat reports lag (the
// whole dashboard is an old snapshot), so an eyeball would be meaningless.
//
// Requires: Node 18+ (global fetch). No auth — hits the public read-API only.

import { prodBaseUrl } from "./lib/prod-base-url.js";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const JSON_OUT = args.includes("--json");
const BASE = (process.env.BASE_URL || prodBaseUrl()).replace(/\/$/, "");
const MEASURED = flag("indicators", "R1,R2,R3,R4,R5,EBP").split(",").map((s) => s.trim()).filter(Boolean);
const CARDS = ["CG", "VT", "VIX", "VIX3M"];
const LAG_DAYS = 4; // a card lagging the freshest sibling by more than this is flagged

const OK = "\x1b[32m✓\x1b[0m", WARN = "\x1b[33m⚠\x1b[0m", BAD = "\x1b[31m✗\x1b[0m";
const out = [];
const say = (s = "") => { if (!JSON_OUT) console.log(s); };

async function getJson(path, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + path, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
      return await r.json();
    } catch (e) { lastErr = e.message; }
  }
  return { __err: lastErr || "unknown" };
}

// The drawn pair, as `app.js` receives it. Compare on the RAW numbers (`effKey`) and
// display rounded — a 3dp render would hide a real sub-milli divergence as "identical".
const fmtEff = (e) =>
  [["amber", e.effAmber], ["red", e.effRed]].filter(([, v]) => v != null)
    .map(([k, v]) => `${k}=${(+v).toFixed(3)}`).join(" ") || "(no effective cuts)";
const effKey = (e) => `${e.effAmber}|${e.effRed}`;
const hasCuts = (e) => e.effAmber != null || e.effRed != null;

const daysBetween = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

// ---------------------------------------------------------------------------
async function main() {
  const status = await getJson("/api/status");
  // Reachability precondition only — the band check reads `/api/series`, not this.
  const indicators = await getJson("/api/indicators");

  const report = { base: BASE, firedAt: status?.verdict?.firedAt ?? null, tasks: {} };
  let blocked = false;

  say(`\ncrash-dash eyeball-check — ${BASE}`);
  say(`firedAt=${report.firedAt ?? "(status unreachable)"}\n`);
  if (status.__err) { blocked = true; say(`${BAD} /api/status unreachable (${status.__err}) — cannot proceed`); }
  if (indicators.__err) { blocked = true; say(`${BAD} /api/indicators unreachable (${indicators.__err})`); }

  // --- shared fetch: stored vs `?detail=1` recompute feeds BOTH task [2] and [1] ----
  const pairs = {};
  for (const id of MEASURED) {
    const stored = await getJson(`/api/series?id=${id}&limit=90`);
    const detail = await getJson(`/api/series?id=${id}&limit=90&detail=1`);
    pairs[id] =
      stored.__err || detail.__err
        ? { __err: stored.__err || detail.__err }
        : {
            stored: (stored.points || []).map((p) => p.state),
            recomputed: (detail.points || []).map((p) => p.state),
            effAmber: detail.effAmber ?? null,
            effRed: detail.effRed ?? null,
          };
  }

  // --- TASK 2: the band lines the detail chart actually draws ----------------
  // `?detail=1` carries the effective cut pair the dashed lines are drawn from; an id
  // without one draws NO band lines (EVT/z-only legs, or a branch that doesn't recompute),
  // so "no lines moved" there is a category error, not a finding.
  const bands = [];
  for (const id of MEASURED) {
    const p = pairs[id];
    if (p.__err) { bands.push({ id, ok: false, reason: p.__err }); continue; }
    if (!hasCuts(p)) { bands.push({ id, ok: false, reason: "no effective cuts drawn (EVT/z-only legs, or no recompute branch)" }); continue; }
    bands.push({ id, drawn: fmtEff(p) });
  }
  const bandDrawn = bands.filter((b) => b.drawn).map((b) => b.id);
  report.tasks.bands = { drawn: bandDrawn, detail: bands };

  say(`[2] BAND LINES — the dashed cut-lines the detail chart draws`);
  for (const b of bands) {
    if (b.reason) { say(`    ${WARN} ${b.id}: ${b.reason}`); continue; }
    say(`    ${OK} ${b.id.padEnd(4)} ${b.drawn}`);
  }
  say("");

  // --- TASK 1: detail recompute vs stored confirmed-state divergence ---------
  const ribbons = [];
  for (const id of MEASURED) {
    const p = pairs[id];
    if (p.__err) { ribbons.push({ id, ok: false, reason: p.__err }); continue; }
    const n = Math.min(p.stored.length, p.recomputed.length);
    let diffDays = 0;
    for (let i = 0; i < n; i++) if (p.stored.at(i - n) !== p.recomputed.at(i - n)) diffDays++;
    ribbons.push({ id, points: n, diffDays, latest: { stored: p.stored.at(-1), recomputed: p.recomputed.at(-1) } });
  }
  const ribbonMovers = ribbons.filter((r) => r.diffDays > 0).sort((a, b) => b.diffDays - a.diffDays);
  report.tasks.ribbon = { detail: ribbons, best: ribbonMovers[0]?.id ?? null };

  say(`[1] RIBBON — detail recompute (?detail=1) vs the stored series the cards paint`);
  for (const r of ribbons) {
    if (r.reason) { say(`    ${WARN} ${r.id}: ${r.reason}`); continue; }
    const mark = r.diffDays > 0 ? OK : "·";
    say(`    ${mark} ${r.id.padEnd(4)} differs on ${String(r.diffDays).padStart(2)}/${r.points} days` +
        `   (latest: stored=${r.latest.stored} detail=${r.latest.recomputed})`);
  }
  say("");

  // --- TASK 3: off-ladder card freshness -------------------------------------
  const cards = [];
  for (const id of CARDS) {
    const s = await getJson(`/api/series?id=${id}&limit=90`);
    const pts = s.points || [];
    cards.push({ id, points: pts.length, latest: pts.at(-1)?.date ?? null, state: pts.at(-1)?.state ?? null, err: s.__err });
  }
  const freshest = cards.map((c) => c.latest).filter(Boolean).sort().at(-1);
  // Bottom-track VIX/VIX3M are PERSISTED series (recordRun writes them each run),
  // unlike CG/VT which read live legs. A frozen one means the daily persist path
  // broke (the 2026-06-26 bug that dropped bottom rows from the hardcoded fold),
  // not a feed lag — so check them ABSOLUTELY against the run's as-of date and BLOCK.
  // The relative `lagDays` above can't catch this: both legs freeze in lockstep,
  // so each stays close to the other while both drift from the advancing run date.
  const BOTTOM_SPARK = new Set(["VIX", "VIX3M"]);
  const runDate = status?.asOf ?? null;
  for (const c of cards) {
    c.empty = c.points === 0;
    c.lagDays = c.latest && freshest ? daysBetween(freshest, c.latest) : null;
    c.lag = c.lagDays != null && c.lagDays > LAG_DAYS;
    c.behindRunDays = BOTTOM_SPARK.has(c.id) && c.latest && runDate ? daysBetween(runDate, c.latest) : null;
    c.frozen = c.behindRunDays != null && c.behindRunDays > LAG_DAYS;
    if (c.empty || c.err || c.frozen) blocked = true;
  }
  // Absolute freshness — the per-card `lagDays` above is RELATIVE to the freshest
  // card, so a feed lagging in lockstep (cron dead) hides (every card === one old date).
  // The status heartbeat (`lag`/`feedAgeDays`) is the absolute backstop → BLOCK on it.
  const feedLagging = status?.lag === true;
  if (feedLagging) blocked = true;
  report.tasks.cards = { detail: cards, freshest, feedAgeDays: status?.feedAgeDays ?? null, lag: feedLagging, bottomState: status?.verdict?.bottomState ?? null };

  say(`[3] OFF-LADDER CARDS — data present & fresh`);
  for (const c of cards) {
    const mark = c.empty || c.err || c.frozen ? BAD : c.lag ? WARN : OK;
    const note = c.err ? c.err : c.empty ? "EMPTY — card will render blank" :
      c.frozen ? `FROZEN — ${c.behindRunDays}d behind run date ${runDate}; bottom-track persist path likely broken` :
      c.lag ? `${c.lagDays}d behind freshest (${freshest})` : "";
    say(`    ${mark} ${c.id.padEnd(6)} pts=${String(c.points).padStart(3)}  latest=${c.latest ?? "—"}  ${c.state ?? ""}  ${note}`);
  }
  say(`    ${feedLagging ? BAD : OK} feed heartbeat: asOf=${status?.asOf ?? "—"} (${status?.feedAgeDays ?? "?"}d old)` +
      `${feedLagging ? "  — LAG: whole feed too old; dashboard shows an old snapshot" : ""}`);
  say(`    · bottomState (CALM dots): ${status?.verdict?.bottomState ?? "—"}  ` +
      `vix=${status?.verdict?.vix?.toFixed?.(2) ?? "—"}  vix3m=${status?.verdict?.vix3m?.toFixed?.(2) ?? "—"}  ` +
      `ratio=${status?.verdict?.ratio?.toFixed?.(4) ?? "—"}`);
  say("");

  // --- MANUAL runbook, with this-run expectations ----------------------------
  say(`── MANUAL EYEBALL STEPS (open ${BASE} in a browser) ──`);
  const rBest = ribbonMovers[0];
  say(`[1] Ribbon: open ${rBest ? rBest.id : "an indicator"} in the detail panel and compare its color bar to the card dot (stored state` +
      (rBest ? `: ${rBest.latest.stored ?? "—"} today vs recomputed ${rBest.latest.recomputed ?? "—"}).` : ")."));
  say(`    Expect them to differ on ${rBest ? `~${rBest.diffDays} of ${rBest.points}` : "some"} days` +
      (rBest ? ` (other movers: ${ribbonMovers.slice(1).map((r) => `${r.id}(${r.diffDays})`).join(", ") || "none"})` : "") +
      ` — the detail chart re-scores on read, the card value/dot paint the stored state.`);
  say(`    NOTE: the two are often equal in a calm market — look at the WHOLE bar, not the right edge.`);
  say(`[2] Bands: same panel — the dashed amber/red lines should be drawn for ${bandDrawn.join(", ") || "(none this run)"}.`);
  const bandNone = bands.filter((b) => b.reason?.startsWith("no effective cuts")).map((b) => b.id);
  if (bandNone.length) say(`    ${bandNone.join(", ")} draw NO band lines at all (EVT/z-only legs) — nothing to watch there.`);
  say(`[3] Cards: confirm CG, VT card values + dots, VIX/VIX3M detail charts + CALM dots all render (not blank).`);
  say("");

  // --- verdict ---------------------------------------------------------------
  const verdict = blocked ? "BLOCKED" : "OK";
  report.verdict = verdict;
  say(`SUMMARY: ${blocked ? BAD + " BLOCKED — an endpoint is down, a card is empty, or the feed is lagging; fix before eyeballing." : OK + " preconditions OK — safe to eyeball."}\n`);

  if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
  process.exit(blocked ? 1 : 0);
}

main().catch((e) => { console.error("eyeball-check crashed:", e); process.exit(2); });
