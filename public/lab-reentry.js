// /lab Re-entry block — a leg's live state (`/<leg>.json`, written by the `/<leg>`
// skill) rendered natively from JSON, with a one-click leg toggle (the riskiest leg, Semis, by default). Off by default
// (VIS_DEFAULTS.reentry = false); lab.js fetches lazily on the first toggle-on (and per leg on first pick) and
// paints into #reentry. No inline `style=` (CSP style-src 'self'). Plain `.js`: vitest
// collects lab-reentry.test.js, tsc ignores both.
import { esc } from "./chart-primitives.js";
import { baseFetch, request } from "./http.js";
import { allEvents, blockers, blockersSummary, countdown, decidingWeek, otherWeek, conditionsOwed, foldDates, foldLanded, holdingEvent, holdingNow, landedOn, landedWord, HELD_NOTE, boardHint, boardReading, boardText, boxHoldsText, clusterBoxText, clusterHead, clusterRows, foldText, gridRows, JOB_LEGEND, jobText, labelAged, LEAN_GLYPH, leanGroup, seriesIds, seriesNote, signsCell, SITUATION_SLOTS, shownStatus, TRANCHE_IDS, WATCH_CONTEXT_NOTE, watchContextRows, watchGrade, watchHead, watchRows, watchTable } from "./ladder-views.js";

/** The toggle's legs, in button order = ladder risk rank (`LEG_FIELD[].risk`, src/danger-ladder.ts; `name` = its `sleeve`) — riskiest first;
 *  the first (riskiest) leg is the default. Mirrors `LEGS` in src/ladder-live.ts (`naGateHolds` and the risk order pinned in lab-reentry.test.js). */
export const REENTRY_LEGS = {
  semis: { name: "Semis", json: "/semis.json", naGateHolds: true },
  spit: { name: "S&P IT", json: "/spit.json", naGateHolds: true },
  value: { name: "Value", json: "/value.json", naGateHolds: true },
  sp500: { name: "S&P 500", json: "/sp500.json", naGateHolds: true },
  eufin: { name: "EU-Fin", json: "/eufin.json", naGateHolds: false },
};
export const DEFAULT_REENTRY_LEG = Object.keys(REENTRY_LEGS)[0];
/** The Criteria detail's class — `criteria()` emits it, lab.js's toggle listener matches it (one source). */
export const REENTRY_CRIT_CLASS = "reentry-crit";
const REENTRY_CRIT_KEY = "lab.reentryCrit"; // localStorage "1"/"0"
/** The Grid's class — `gridBlock()` emits it. */
export const REENTRY_GRID_CLASS = "reentry-grid";
const REENTRY_GRID_KEY = "lab.reentryGrid";
/** The Blockers' class — `blockersBlock()` emits it; open by default (= the md's `<details open>`). */
export const REENTRY_BLOCKERS_CLASS = "reentry-blockers";
const REENTRY_BLOCKERS_KEY = "lab.reentryBlockers";
/** The Drawdown watch's class — `watchBlock()` emits it; collapsed by default, its grade rides the summary. */
export const REENTRY_WATCH_CLASS = "reentry-watch";
const REENTRY_WATCH_KEY = "lab.reentryWatch";
/** The remembered `<details>` toggles: the class the block emits (lab.js's capture-phase toggle listener matches it), its storage
 *  key, its default when unset, and the `renderReentry` option it feeds — one table, `readOpenState` and lab.js both walk it. */
export const REENTRY_TOGGLES = [
  { cls: REENTRY_CRIT_CLASS, key: REENTRY_CRIT_KEY, dflt: false, state: "critOpen" },
  { cls: REENTRY_GRID_CLASS, key: REENTRY_GRID_KEY, dflt: false, state: "gridOpen" },
  { cls: REENTRY_BLOCKERS_CLASS, key: REENTRY_BLOCKERS_KEY, dflt: true, state: "blockersOpen" },
  { cls: REENTRY_WATCH_CLASS, key: REENTRY_WATCH_KEY, dflt: false, state: "watchOpen" },
];

/** A toggle's remembered open state; `dflt` when unset or storage is blocked. */
export function readOpen(storage, key, dflt) {
  try {
    const v = storage.getItem(key);
    return v === null ? dflt : v === "1";
  } catch {
    return dflt;
  }
}
/** Remember a toggle's open state; a throwing storage is swallowed (the choice won't survive the reload). */
export function writeOpen(storage, key, open) {
  try {
    storage.setItem(key, open ? "1" : "0");
  } catch {
    // blocked storage
  }
}
/** Every toggle's state for `renderReentry`'s options: `{ critOpen, gridOpen, blockersOpen, watchOpen }`. */
export const readOpenState = (storage) => Object.fromEntries(REENTRY_TOGGLES.map((t) => [t.state, readOpen(storage, t.key, t.dflt)]));

const cached = new Map(); // leg → parsed JSON, or null = fetched, unavailable

/** Fetch a leg's JSON once per page load; non-OK or a thrown fetch → null (the block paints its empty state). */
export async function loadReentry(leg = DEFAULT_REENTRY_LEG, fetchFn = baseFetch) {
  if (cached.has(leg)) return cached.get(leg);
  let live = null;
  try {
    const r = await request(REENTRY_LEGS[leg].json, { fetchImpl: fetchFn, cache: "no-cache" }); // request's default timeout
    live = r.ok ? await r.json() : null;
  } catch {
    live = null;
  }
  cached.set(leg, live);
  return live;
}

/** Test seam — forget the cached fetches. */
export function resetReentryCache() {
  cached.clear();
}

/** A plain cell, or `{ text, tip?, foot? }` = a cell carrying a hover tooltip and/or a footnote marker (`foot` = `[n, text]`, its own hover). */
const cell = (t) => (t && typeof t === "object" ? `<td${t.tip !== undefined ? tip([t.tip]) : ""}>${esc(t.text)}${t.foot ? `<sup class="reentry-foot"${tip([t.foot[1]])}>${sup(t.foot[0])}</sup>` : ""}</td>` : `<td>${esc(String(t))}</td>`);
const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const sup = (n) => String(n).replace(/\d/g, (d) => SUP[d]);
/** Per-render footnote numbers: 1-based in first-appearance order, deduped by text — mirrors `footer` in src/ladder-live.ts. */
const footer = () => {
  const m = new Map();
  return { n: (t) => m.get(t) ?? m.set(t, m.size + 1).size, all: () => [...m] };
};
const grid = (head, rows) =>
  `<table class="sm-grid"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map(cell).join("")}</tr>`).join("")}</tbody></table>`;
const head = (t) => `<div class="sm-head"><h3 class="sm-title">${esc(t)}</h3></div>`;
/** Mirrors `trancheCell` in src/ladder-live.ts — parity pinned in lab-reentry.test.js. */
export const tranche = (t) => `${t.ok ? "✓" : "✗"}: ${t.met}/${t.total} need ${t.need}${t.via ? ` (${t.via})` : ""}${gatesText(t.gates)}`;
/** ` · gates ✓✗–` in leg-definition order; "" when absent or empty — mirrors `gatesText` in src/ladder-live.ts. */
const gatesText = (gates) => (gates?.length ? ` · gates ${gates.map((g) => MARK[g] ?? "–").join("")}` : "");
const gap = (g) => (g === null || g === undefined ? "—" : `${g >= 0 ? "+" : ""}${(g * 100).toFixed(1)}%`);
const MARK = { met: "✓", unmet: "✗", na: "–" };
const reading = (r) => `${r.value} ${MARK[r.verdict] ?? "–"}${r.count ? ` ${r.count.got}/${r.count.need}` : ""}`;
const legRow = (l, label, feet) => [label, l.tip || l.foot ? { text: l.rule, ...(l.tip && { tip: l.tip }), ...(l.foot && { foot: [feet.n(l.foot), l.foot] }) } : l.rule, reading(l), reading(l.live)];
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** ` · Fri 10-09` off an ISO date, "" when absent — mirrors `stamp` in src/ladder-live.ts. */
const stamp = (d) => (d ? ` · ${DAY[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${d.slice(5)}` : "");
/** The close + live column heads, dated off `asOf` (` est.` when a live head is an estimate), bare without it — mirrors `heads` in src/ladder-live.ts. */
const heads = (v, live = "live") => [`close${stamp(v.asOf?.close)}`, `${live}${stamp(v.asOf?.live)}${v.asOf?.est ? " est." : ""}`];
/** Per tranche: its criteria grid, then a grid of its gates (`gate: ` prefix dropped) when it has any — mirrors `trancheCriteria` in src/ladder-live.ts. */
const trancheCriteria = (legs, h, feet) => {
  const gates = legs.filter((l) => l.gate);
  return (
    grid(["criterion", "expected", ...h], legs.filter((l) => !l.gate).map((l) => legRow(l, l.leg, feet))) +
    (gates.length ? grid(["gate (all must pass)", "expected", ...h], gates.map((l) => legRow(l, l.leg.replace(/^gate: /, ""), feet))) : "")
  );
};
/** Gate rows identical across ≥ 2 tranches (same label, rule and both readings) render once in the "shared gates" grid, labelled with their tranches when fewer than three; the tranche grids keep only their own rows — mirrors `splitGates` in src/ladder-live.ts. */
export const splitGates = (legs) => {
  const keyOf = (l) => [l.leg, l.rule, l.foot, l.value, l.verdict, l.count?.got, l.count?.need, l.live?.value, l.live?.verdict, l.live?.count?.got, l.live?.count?.need].join("\u0000");
  const tranches = new Map();
  for (const l of legs) if (l.gate) tranches.set(keyOf(l), [...(tranches.get(keyOf(l)) ?? []), l.tranche]);
  const isShared = (l) => l.gate && new Set(tranches.get(keyOf(l))).size >= 2;
  const seen = new Set();
  const shared = legs.filter((l) => isShared(l) && !seen.has(keyOf(l)) && seen.add(keyOf(l))).map((l) => ((ts) => ({ leg: l, label: `${l.leg.replace(/^gate: /, "")}${ts.length < 3 ? ` (${ts.join("·")})` : ""}` }))([...new Set(tranches.get(keyOf(l)))]));
  return { shared, own: legs.filter((l) => !isShared(l)) };
};
/** Per-leg detail (collapsed unless `open`): the shared-gates grid (`splitGates`), criteria + gate grids per tranche, then
 *  the hover:none footnote list (inside, so it hides with its markers) — mirrors `criteria` in src/ladder-live.ts (whose md list stays at doc end). */
const criteria = (v, open, feet, g = splitGates(v.legs ?? [])) =>
  v.legs?.length
    ? `<details class="reentry-detail ${REENTRY_CRIT_CLASS}"${open ? " open" : ""}><summary>Criteria detail — T1 · T2 · T3</summary>` +
      (g.shared.length ? `<h4>shared gates</h4>` + grid(["gate (all must pass)", "expected", ...heads(v)], g.shared.map((s) => legRow(s.leg, s.label, feet))) : "") +
      ["T1", "T2", "T3"].map((t) => `<h4>${t}</h4>` + trancheCriteria(g.own.filter((l) => l.tranche === t), heads(v), feet)).join("") +
      (feet.all().length ? `<ol class="reentry-feet">${feet.all().map(([t]) => `<li>${esc(t)}</li>`).join("")}</ol>` : "") +
      `</details>`
    : "";
/** The close cell: `value ✓/✗/–`, ` TRIPPED` on unmet, ` near` when near (the live cell is a bare `reading`) — mirrors `familyCell` in src/ladder-live.ts. */
const familyCell = (c, near = false) => `${c.value} ${MARK[c.verdict] ?? "–"}${c.verdict === "unmet" ? " TRIPPED" : ""}${near ? " near" : ""}`;
/** The open Episode gates block between the last-5-runs grid and Signs: one row per cluster member (`clusterRows`, its signs last), `clusterBoxText`, then the
 *  families as signs — mirrors `episodeGates` in src/ladder-live.ts. */
const episodeGates = (v) => {
  if (!v.escalation?.clusters) return "";
  const fams = v.escalation.families;
  const famGrid = (fs) => grid(["family", "trips when", ...heads(v), "signs"], fs.map((f) => [f.name, f.rule, familyCell(f, f.near), reading(f.live ?? f), signsCell(f.signs)]));
  return head(clusterHead(v)) + grid(["cluster", "member", "trips when", ...heads(v), "signs"], clusterRows(v)) + `<p class="sm-note">${esc(clusterBoxText(v))}</p>` + (fams?.length ? `<p class="sm-note"><b>signs (shown, no vote)</b></p>` + famGrid(fams) : "");
};
const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};
const source = (s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(`${s.date.slice(5)} ${host(s.url)}`)}</a>`;
/** Hover detail: the lines joined by newlines into a `title` (native tooltip — no inline style, CSP-safe). */
const tip = (lines) => ` title="${esc(lines.filter(Boolean).join("\n"))}"`;
const LEAN_NAME = ["escalation", "open/mixed", "fizzle/quiet", "not yet"];
// The item / chip / row-order helpers below mirror their namesakes in src/ladder-live.ts.
const noted = (r) => `${r.event}${r.dateNote && r.verified !== true ? ` (${r.dateNote})` : ""}`;
const eventItem = (e, live) => {
  const landed = landedWord(e.status);
  return {
    date: e.date,
    event: true,
    mark: e.holds?.length ? "★" : "☆",
    text: `${noted(e)}${e.secondary ? " (secondary)" : ""}`,
    detail: [e.holds?.length ? `holds ${e.holds.join("+")}` : "holds no tranche", ...(conditionsOwed(landed) ? [`escalation if: ${e.escalationIf}`, `fizzle if: ${e.fizzleIf}`] : []), `status: ${shownStatus(e.status, live.run)}`, ...(e.sources?.length ? [`sources: ${e.sources.map((x) => `${x.date} ${x.url}`).join(", ")}`] : [])],
    landed,
    ...(/^(escalation|fizzle|mixed)$/.test(landed) && { on: landedOn(e) }),
    holding: holdingEvent(live, e),
  };
};
/** `owed` = passed, unverified and mattering — mirrors `calendarItem` in src/ladder-live.ts. */
const calendarItem = (c, run) => ({ date: c.date, event: false, mark: c.verified ? "•" : "~", text: noted(c), detail: [c.matters && c.matters !== "—" ? `matters: ${c.matters}` : "", c.verified ? "" : "date unverified"].filter(Boolean), landed: "", owed: c.date < run && !c.verified && c.matters !== "—" });
const signItems = (live, sign) =>
  [...allEvents(live).filter((e) => e.signs?.includes(sign)).map((e) => eventItem(e, live)), ...(live.calendar ?? []).filter((c) => c.sign === sign).map((c) => calendarItem(c, live.run))].sort((a, b) => a.date.localeCompare(b.date));
const chipItems = (run, items) => {
  const nextEvent = items.find((i) => i.event && i.landed !== "dropped" && i.date >= run);
  const nextCal = items.find((i) => !i.event && i.date >= run);
  return foldLanded(items.filter((i) => i.event || (i === nextCal && (!nextEvent || i.date < nextEvent.date))));
};
const signRows = (live) =>
  live.signs
    .map((s, i) => {
      const items = signItems(live, s.sign);
      const chips = chipItems(live.run, items);
      return { s, i, group: leanGroup(s.lean), items, chips, next: chips.find((c) => c.date >= live.run)?.date ?? "9999" };
    })
    .sort((a, b) => a.group - b.group || a.next.localeCompare(b.next) || a.i - b.i);
const orphanEvents = (live) => {
  const names = new Set(live.signs.map((s) => s.sign));
  return allEvents(live).filter((e) => !e.signs?.some((n) => names.has(n)));
};
/** Calendar rows with no live sign row to sit under — mirrors `loneCalendar` in src/ladder-live.ts. */
const loneCalendar = (live) => {
  const names = new Set(live.signs.map((s) => s.sign));
  return (live.calendar ?? []).filter((c) => !c.sign || !names.has(c.sign)).map((c) => calendarItem(c, live.run)).sort((a, b) => a.date.localeCompare(b.date));
};
const chip = (run, i) =>
  i.fold ? `<span class="reentry-chip"${tip(i.detail)}>${esc(i.fold)}</span>` : `<span class="reentry-chip"${tip([`${i.date} ${i.text}`, ...i.detail])}>${esc(`${i.mark} ${i.date.slice(5)} ${i.landed || countdown(run, i.date)}`)}</span>`;
const itemLi = (i) => `<li>${i.event ? "<b>" : ""}${esc(`${i.mark} ${i.date} ${i.text}`)}${i.event ? "</b>" : ""}${i.detail.length ? esc(` — ${i.detail.join(" · ")}`) : ""}</li>`;
const datesDd = (items) => (items.length ? `<ul class="reentry-dates">${items.map(itemLi).join("")}</ul>` : "—");
/** Old non-holding landed items fold into one `<details>` history entry ahead of the rest (`foldDates`) — mirrors `datesBlock` in src/ladder-live.ts. */
const foldedDd = (run, items) => {
  const f = foldDates(run, items);
  return f.history ? `<ul class="reentry-dates"><li><details class="reentry-detail"><summary>${esc(f.history.text)}</summary>${datesDd(f.history.items)}</details></li>${f.shown.map(itemLi).join("")}</ul>` : datesDd(items);
};
/** One board row: lean glyph · sign · one-line finding · board hint (the indicators the row feeds, no value) · date chips (or the research hold) — each with its detail as a tooltip; expands to the full dates list, sources, pages and press (when any). */
const signRow = (live, r) => {
  const s = r.s;
  // R4 (mirrors `findingCell`/`signBlock` in src/ladder-live.ts): a probe row's finding is its live box reading — no checked/due/sources.
  const finding = s.probe ? boardReading(live.verdict, s.sign, true) : s.finding;
  const stamp = s.probe ? [] : [s.checked && `checked ${s.checked}`, s.due && `due ${s.due}`];
  const when = r.chips.length
    ? r.chips.map((c) => chip(live.run, c)).join("")
    : !s.probe && s.due && s.due > live.run
      ? `<span class="reentry-chip reentry-held"${tip([labelAged(s.label, s.checked), s.checked && `checked ${s.checked}`])}>${esc(`held → ${s.due.slice(5)}`)}</span>`
      : `<span class="reentry-chip">—</span>`;
  const hint = boardHint(live.verdict, s.sign);
  return (
    `<details class="reentry-detail reentry-sign"><summary>` +
    `<b class="reentry-glyph lean-${r.group}"${tip([s.lean])}>${LEAN_GLYPH[r.group]}</b>` +
    `<span class="reentry-name"${tip([s.why, s.measurable && `measurable: ${s.measurable}`])}>${esc(s.sign)}${s.block ? " <b>BLOCK</b>" : ""}</span>` +
    `<span class="reentry-find${s.probe ? " reentry-probe" : ""}"${tip([finding, [labelAged(s.label, s.checked), ...stamp].filter(Boolean).join(" · ")])}>${esc(finding || "—")}</span>` +
    `<span class="reentry-when">${hint ? `<span class="reentry-board"${tip([`board: ${boardText(live.verdict, s.sign)}`])}>${esc(hint)}</span>` : ""}${when}</span></summary>` +
    `<dl><dt>status</dt><dd>${esc([labelAged(s.label, s.checked), s.lean, ...stamp].filter(Boolean).join(" · "))}</dd>` +
    `<dt>why</dt><dd>${esc(s.why || "—")}${s.measurable ? ` <i>(measurable: ${esc(s.measurable)})</i>` : ""}</dd>${s.base ? `<dt>base</dt><dd>${esc(s.base)}</dd>` : ""}<dt>board</dt><dd>${esc(boardText(live.verdict, s.sign))}</dd><dt>dates</dt><dd>${foldedDd(live.run, r.items)}</dd>${s.probe ? "" : `<dt>sources</dt><dd>${s.sources?.length ? s.sources.map(source).join(" · ") : "—"}</dd>`}` +
    `<dt>pages</dt><dd>${s.primary?.length ? s.primary.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(host(u))}</a>`).join(" · ") : "—"}</dd>` +
    `${s.press?.length ? `<dt>press</dt><dd>${s.press.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(host(u))}</a>`).join(" · ")}</dd>` : ""}</dl></details>`
  );
};
/** An event naming no `signs[]` row keeps its own row, so a deciding event never drops off the board. */
const orphanRow = (live, e) => {
  const i = eventItem(e, live);
  return (
    `<details class="reentry-detail reentry-sign"><summary><b class="reentry-glyph lean-3">·</b><span class="reentry-name">${esc(i.text)}</span>` +
    `<span class="reentry-find">event, no sign row</span><span class="reentry-when">${chip(live.run, i)}</span></summary><dl><dt>dates</dt><dd>${foldedDd(live.run, [i])}</dd></dl></details>`
  );
};
/** Signs & deciding events as one board: the situation slots + the rules fold, the tally + legend, then the lean-sorted rows — mirrors `signsSection` in src/ladder-live.ts. */
const signsBoard = (live) => {
  const rows = signRows(live);
  const tally = LEAN_NAME.map((n, g) => `${LEAN_GLYPH[g]}${rows.filter((r) => r.group === g).length} ${n}`).join(" · ");
  return [
    ...SITUATION_SLOTS.map(([k, h]) => `<p class="reentry-para"><b>${esc(h)}</b> — ${esc(live.situation?.[k]?.trim() || "—")}</p>`),
    live.rules?.length ? `<details class="reentry-detail"><summary>Rules (user-set)</summary><ul class="reentry-rules">${live.rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></details>` : "",
    `<p class="sm-note">${esc(`${tally} — ★ deciding (holds a tranche) · ☆ event, holds none · • dated · ~ date unverified · hover for detail`)}</p>`,
    rows.map((r) => signRow(live, r)).join("") + orphanEvents(live).map((e) => orphanRow(live, e)).join(""),
    ((lone) => (lone.length ? `<p class="sm-note">dated, no sign</p>${datesDd(lone)}` : ""))(loneCalendar(live)),
  ].join("\n");
};

/** The leg toggle: one button per `REENTRY_LEGS` entry, the shown leg pressed; lab.js handles the `data-leg` click. */
const legToggle = (leg) =>
  `<div class="modeToggle reentry-legs" role="group" aria-label="re-entry leg">${Object.entries(REENTRY_LEGS)
    .map(([id, l]) => `<button type="button" data-leg="${id}" aria-pressed="${id === leg}"${id === leg ? ' class="active"' : ""}>${esc(l.name)}</button>`)
    .join("")}</div>`;
/** The never-a-gate display read (Value) — mirrors `displayText` in src/ladder-live.ts. */
const displayText = (d) => `display: ${gap(d.vsMa)} vs MA${d.maN} — never a gate${d.zoneSince ? ` · zone open since ${d.zoneSince}` : ""}`;

/** `runAt` → `16:37 EEST` in the viewer's own zone (`timeZone` pins it for tests) — mirrors `runTime` in src/ladder-live.ts. */
export const runTime = (at, timeZone) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short", timeZone }).format(new Date(at));

/** The Grid: one `<details>` (collapsed unless `open`) holding the 5-column indicator × job grid (`gridRows`, ladder-views.js) + the series and job notes — mirrors `gridSection` in src/ladder-live.ts (the series ids also ride a hover tip on the group's first indicator cell); the empty-state note until the leg's JSON carries tags. */
const gridBlock = (v, open) => {
  const g = gridRows(v);
  return (
    `<details class="reentry-detail ${REENTRY_GRID_CLASS}"${open ? " open" : ""}><summary>Grid — one row per indicator × job</summary>` +
    (g.untagged ? `<p class="sm-note">no read tags yet</p>` : `<div class="sm-grid-wrap">${grid(["indicator", "job", ...TRANCHE_IDS], g.rows.map((r) => [seriesIds(r).length ? { text: r.indicator, tip: r.series.join(" · ") } : r.indicator, jobText(r), ...TRANCHE_IDS.map((t) => r.cells[t])]))}</div>${[seriesNote(g), JOB_LEGEND].filter(Boolean).map((n) => `<p class="sm-note">${esc(n)}</p>`).join("")}`) +
    `</details>`
  );
};

/** Blockers: one `<details>` (open unless `!open`) — per tranche an `<h4>` head (`T2 close · live`), then unless filled a `<ul>` of the unmet rows
 *  (`blockers`, `naGateHolds` per leg), the box note when it holds, and a closed fold (`foldText`) of the passing + unread rows
 *  — the same strings as `blockersSection` in src/ladder-live.ts (li texts == its `- ` lines). */
const blockersBlock = (v, open, naGateHolds) => {
  const b = blockers(v, { naGateHolds });
  const li = (l) => `<li>${esc(`${l.leg} — ${reading(l)} · live ${reading(l.live)}`)}</li>`;
  const ul = (items) => (items.length ? `<ul>${items.join("")}</ul>` : "");
  return (
    `<details class="reentry-detail ${REENTRY_BLOCKERS_CLASS}"${open ? " open" : ""}><summary>${esc(blockersSummary(b))}</summary>` +
    (b.held ? `<p class="sm-note">${esc(HELD_NOTE)}</p>` : "") +
    b.tranches
      .map(
        (t) =>
          `<h4>${esc(`${t.id} ${tranche(t.close)} · live ${t.live ? tranche(t.live) : "—"}`)}</h4>` +
          (t.filled
            ? ""
            : ul(t.unmet.map(li)) +
              (t.box.holds ? `<p class="sm-note">${esc(boxHoldsText(t.box))}</p>` : "") +
              `<details class="reentry-detail"><summary>${esc(foldText(t))}</summary>${ul([...t.passing.map(li), ...t.unread.map(li)])}</details>`),
      )
      .join("") +
    `</details>`
  );
};

/** Drawdown watch: one `<details>` (collapsed unless `open`, `Drawdown watch — <grade>` summary) holding `watchHead` + the graded `watchRows` grid + `WATCH_CONTEXT_NOTE` and the `watchContextRows` grid when any — mirrors `watchSection` in src/ladder-live.ts, minus its md-only grade history. */
export const watchBlock = (v, open = false) => {
  const ctx = watchContextRows(v);
  const tbl = (rows) => ((t) => grid(t.head, t.rows))(watchTable(rows));
  return (
    `<details class="reentry-detail ${REENTRY_WATCH_CLASS}"${open ? " open" : ""}><summary>${esc(`Drawdown watch — ${watchGrade(v.watch)}`)}</summary>` +
    `<p class="sm-note">${esc(watchHead(v))}</p>` + tbl(watchRows(v)) + (ctx.length ? `<p class="sm-note">${esc(WATCH_CONTEXT_NOTE)}</p>` + tbl(ctx) : "") +
    `</details>`
  );
};

/** The whole block's inner HTML for `leg`: the toggle always, then the leg's state; `null` → the empty state. `critOpen` / `gridOpen` / `blockersOpen` / `watchOpen` paint the Criteria detail / the Grid / the Blockers / the Drawdown watch expanded (`readOpenState`). */
export function renderReentry(live, leg = DEFAULT_REENTRY_LEG, { critOpen = false, gridOpen = false, blockersOpen = true, watchOpen = false } = {}) {
  const L = REENTRY_LEGS[leg];
  const title = `<div class="sm-head"><h2 class="sm-title">${esc(L.name)} re-entry</h2>${legToggle(leg)}${live ? `<span class="sm-note">run ${esc(live.run)}${live.runAt && !Number.isNaN(Date.parse(live.runAt)) ? ` ${esc(runTime(live.runAt))}` : ""} · from ${esc(L.json)}</span>` : ""}</div>`;
  if (!live) return `${title}\n<p class="empty">No re-entry state published yet.</p>`;
  const v = live.verdict;
  const feet = footer();
  const verdict = v
    ? `<p class="sm-note">${esc(`${v.regime.set} set${v.regime.exshVsMa200 === undefined ? "" : ` · EXSH ${gap(v.regime.exshVsMa200)} vs MA200`}${v.display ? ` · ${displayText(v.display)}` : ""}`)}</p>` +
      ((h) => (h ? `<p class="sm-note"><b>Holding now</b> — ${esc(h)}</p>` : ""))(holdingNow(live)) +
      `<p class="sm-note"><b>Deciding in the next 7 days</b> — ${esc(decidingWeek(live))}</p>` +
      `<p class="sm-note"><b>Other events in the next 7 days</b> — ${esc(otherWeek(live))}</p>` +
      grid(["tranche", ...heads(v, v.prov ? "live (prov.)" : "live")], v.tranches.map((t, i) => [t.id, tranche(t), v.live?.[i] ? tranche(v.live[i]) : "—"])) +
      criteria(v, critOpen, feet)
    : `<p class="sm-note">no verdict yet</p>`;
  const runs = live.runs.length
    ? `<details class="reentry-detail"><summary>last 5 runs</summary>${grid(["date", "T1", "T2", "T3", "live"], live.runs.slice(0, 5).map((r) => [r.date, r.t1, r.t2, r.t3, r.live]))}</details>`
    : "";
  return [
    title,
    ...(v?.watch ? [watchBlock(v, watchOpen)] : []),
    verdict,
    runs,
    v ? blockersBlock(v, blockersOpen, L.naGateHolds) : "",
    v ? gridBlock(v, gridOpen) : "",
    live.verdict ? episodeGates(live.verdict) : "",
    head("Signs & deciding events"),
    signsBoard(live),
  ].join("\n");
}
