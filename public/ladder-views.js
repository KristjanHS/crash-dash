// Shared ladder view model — the Grid (one row per indicator × job, tranche columns) and Blockers (unmet rows per tranche, passing rows folded) —
// imported by BOTH renderers: src/ladder-live.ts (md; `// @ts-expect-error` + re-typed at the import, the
// src/lab-request.ts → lab-lookback.js precedent) and public/lab-reentry.js (/lab). Pure browser ESM: zero imports,
// no DOM, no `style=` (public/inline-pos.test.js lints every production public/*.js). Plain `.js`: vitest collects
// ladder-views.test.js, tsc ignores both.

/** The `tag.indicator` every probe sets on its `*-esc` gate row (`grep '"escalation box"' scripts/probe-*-tranches.ts` hits all four). */
export const BOX_INDICATOR = "escalation box";
/** Mirrors `TRANCHE_IDS` in src/ladder-live.ts — the grid's column order. */
export const TRANCHE_IDS = ["T1", "T2", "T3"];
const MARK = { met: "✓", unmet: "✗", na: "–" };
const mark = (verdict) => MARK[verdict] ?? "–";

/** The lean vocabularies by board group (▲ ◆ ▼ ○): eufin's `escalation-leaning/open/mixed/fizzle-leaning/quiet`, the US legs' `bear/neutral/fizzle`; `unknown` (bare or `until YYYY-MM-DD`) = not readable yet. Each leg's own list is `LEGS[leg].leans` (src/ladder-live.ts), the vet at apply. */
export const LEAN_GROUPS = [["escalation-leaning", "bear"], ["open", "mixed", "neutral"], ["fizzle-leaning", "quiet", "fizzle"], ["unknown"]];
/** The apply-written grade tags (` (press only)` / ` (single-source)` / ` (draft)`, src/ladder-run.ts) stripped off a lean or an event `status` — any order, repeated. */
export const stripTags = (text = "") => text.replace(/(?: \((?:press only|single-source|draft)\))+$/, "");
/** A lean's bare word: the grade tags (`stripTags`), then the ` until YYYY-MM-DD` suffix, stripped — the one strip every lean consumer (grouping, move detection, the vet) shares. */
export const leanWord = (lean = "") => stripTags(lean).replace(/ until \d{4}-\d{2}-\d{2}$/, "");
/** Lean → board group off `LEAN_GROUPS` by `leanWord`; anything off the table = not readable yet (3). */
export const leanGroup = (lean = "") => {
  const g = LEAN_GROUPS.findIndex((x) => x.includes(leanWord(lean)));
  return g < 0 ? 3 : g;
};
export const LEAN_GLYPH = ["▲", "◆", "▼", "○"];
/** A dated label (`UNCHANGED|STALE <MM-DD>`, `QUIET since <MM-DD>…`) + ` (+Nd)`, N = `checked` − label date (year off `checked`, a later MM-DD = last year), only when N ≥ 1. [USER 2026-10-17] */
export const labelAged = (label = "", checked = null) => {
  const md = /^(?:UNCHANGED|STALE|QUIET since) (\d{2})-(\d{2})\b/.exec(label);
  if (!md || !checked) return label;
  const at = Date.parse(`${checked}T00:00:00Z`);
  const y = Number(checked.slice(0, 4));
  const on = (yy) => Date.UTC(yy, Number(md[1]) - 1, Number(md[2]));
  const n = Math.round((at - (on(y) > at ? on(y - 1) : on(y))) / 864e5);
  return n >= 1 ? `${label} (+${n}d)` : label;
};
/** The `situation` slots (`LadderSituation`, src/ladder-live.ts) → their rendered heads, in order; md and /lab both paint `**head** — text`. */
export const SITUATION_SLOTS = [["lean", "Lean"], ["slow", "Slow threat"], ["fast", "Fast threat"], ["decides", "What decides it"], ["flips", "What flips the lean"]];
/** `sign ▲ · sign ◆ BLOCK`, `—` without rows. */
export const signsCell = (signs) => (signs?.length ? signs.map((s) => `${s.sign} ${LEAN_GLYPH[leanGroup(s.lean)]}${s.block ? " BLOCK" : ""}`).join(" · ") : "—");
/** The board reading beside a sign row: every `boardRows` row naming it as `name close ✓/✗[ TRIPPED][ near]` (`· live <reading>` when `live` is set and differs past a trailing ` @MM-DD` close-date stamp), joined ` · `; `—` when no family names it. */
export const boardReading = (verdict, sign, live = false) => {
  const fams = boardFamilies(verdict, sign);
  const cell = (c, near) => `${c.value} ${mark(c.verdict)}${c.verdict === "unmet" ? " TRIPPED" : ""}${near ? " near" : ""}`;
  return fams.length ? fams.map((f) => `${f.name} ${cell(f, f.near)}${live && f.live && f.live.value.replace(/ @\d\d-\d\d$/, "") !== f.value ? ` · live ${f.live.value} ${mark(f.live.verdict)}` : ""}`).join(" · ") : "—";
};
const CELL_VERDICT = { hit: "unmet", false: "met" };
/** A cluster member in family-row grammar: `hit` → unmet, `false` → met, else na; `live` only off a `liveCell`; `near` copied. */
const memberRow = (m) => ({ name: m.id, rule: m.rule ?? "—", value: m.value ?? "—", verdict: CELL_VERDICT[String(m.cell)] ?? "na", ...(m.liveCell !== undefined && { live: { value: m.live ?? m.value ?? "—", verdict: CELL_VERDICT[String(m.liveCell)] ?? "na" } }), signs: m.signs ?? [], ...(m.near && { near: true }), ...(m.tag && { tag: m.tag }) });
/** Every row a sign can name — `escalation.families`, then each cluster member (`memberRow`); board pointers, readings, probe leans and the hot cadence all read it. */
export const boardRows = (verdict) => [...(verdict?.escalation?.families ?? []), ...(verdict?.escalation?.clusters ?? []).flatMap((c) => c.members.map(memberRow))];
/** The `boardRows` naming `sign` (empty without a verdict/escalation). */
export const boardFamilies = (verdict, sign) => boardRows(verdict).filter((f) => f.signs?.some((s) => s.sign === sign));
/** The board POINTER a sign row prints (md table column, `- board:` line, /lab `<dt>board>`): `row → indicator` per `boardFamilies` row
 *  (the row name alone without a tag), `—` when none. [USER] 2026-10-16: never the value or the rule — a sign row only hints which indicators to look at
 *  (a probe row's finding cell carries the reading instead, `boardReading` — [USER] 2026-11-10). */
export const boardText = (verdict, sign) => {
  const fams = boardFamilies(verdict, sign);
  return fams.length ? fams.map((f) => (f.tag?.indicator ? `${f.name} → ${f.tag.indicator}` : f.name)).join(" · ") : "—";
};
/** The /lab summary-row hint: the indicators alone (`HY OAS · CCC · US 10y`), "" when none. */
export const boardHint = (verdict, sign) => boardFamilies(verdict, sign).map((f) => f.tag?.indicator ?? f.name).join(" · ");

/** One grid cell for a tagged leg row: the box row → `h/n ✗` — the footer's vote count / `clusters.length`;
 *  `allOf` → the bare mark; `kOfN` → `3/5 ✓` with a `count`, the bare mark without ([USER] 2026-10-13: no `box ` / `gate ` words — the box row's indicator names it; gate-ness shows in Blockers only). */
export const gridCell = (leg, verdict) => {
  if (leg.tag?.indicator === BOX_INDICATOR) {
    const e = verdict.escalation;
    return `${votesOf(e).length}/${e?.clusters?.length ?? 0} ${mark(leg.verdict)}`;
  }
  if (leg.tag?.agg === "allOf") return mark(leg.verdict);
  return leg.count ? `${leg.count.got}/${leg.count.need} ${mark(leg.verdict)}` : mark(leg.verdict);
};

/** The Grid: `{ untagged, rows }` — `untagged` (no leg row carries `tag`) → `rows: []`. One row per `indicator + job + variant` as `readScope`
 *  keys it (a named variant never merges with the shared form's row; `agg` ignored; untagged rows skipped; two rows of one key in one tranche join with ` · `), `kind: "box"` on
 *  `BOX_INDICATOR` rows. `escalation.families[]` adds NO rows ([USER] 2026-10-13: the family box + sign rows restated the Episode gates
 *  table under the Grid). Order: indicator by first appearance, then job, then variant (the shared form first); `first` marks each indicator group's first row (the one
 *  `seriesNote` lists); `open` = a non-box `composite` read. Absent tranche → `·`. */
export const gridRows = (verdict) => {
  const legs = verdict.legs ?? [];
  if (!legs.some((l) => l.tag)) return { untagged: true, rows: [] };
  const rows = [];
  const byKey = new Map();
  for (const l of legs) {
    if (!l.tag) continue;
    const k = `${l.tag.indicator}\u0000${l.tag.job}\u0000${l.tag.variant ?? ""}`;
    let r = byKey.get(k);
    if (!r) {
      const kind = l.tag.indicator === BOX_INDICATOR ? "box" : "read";
      r = { indicator: l.tag.indicator, series: [...(l.tag.series ?? [])], first: false, job: l.tag.job, ...(l.tag.variant && { variant: l.tag.variant }), kind, open: kind === "read" && l.tag.job === "composite", scope: [], cells: {} };
      byKey.set(k, r);
      rows.push(r);
    }
    const c = gridCell(l, verdict);
    r.cells[l.tranche] = r.cells[l.tranche] ? `${r.cells[l.tranche]} · ${c}` : c;
  }
  for (const r of rows) {
    r.scope = TRANCHE_IDS.filter((t) => t in r.cells);
    for (const t of TRANCHE_IDS) r.cells[t] ??= "·";
  }
  const order = [...new Set(rows.map((r) => r.indicator))];
  rows.sort((a, b) => order.indexOf(a.indicator) - order.indexOf(b.indicator) || a.job.localeCompare(b.job) || (a.variant ?? "").localeCompare(b.variant ?? ""));
  let prev;
  for (const r of rows) {
    r.first = r.indicator !== prev;
    prev = r.indicator;
  }
  return { untagged: false, rows };
};
/** The Grid's job column — one abbreviation per `READ_JOBS` entry (src/ladder-live.ts), `~name` marking a named variant, `°` the open composite; `JOB_LEGEND` spells them out under the table. */
export const JOB_ABBR = { composite: "comp", recovery: "rec", regime: "reg", speed: "spd", level: "lvl", relative: "rel", manual: "man" };
export const JOB_LEGEND = `jobs — comp=composite (°=open) · ${Object.entries(JOB_ABBR).filter(([j]) => j !== "composite").map(([j, a]) => `${a}=${j}`).join(" · ")} · ~name = named variant of the job’s shared form`;
/** `comp°` on the one open kind, `spd~name` on a named variant (before any `°`), the bare abbreviation otherwise (an unknown job prints as is). */
export const jobText = (row) => `${JOB_ABBR[row.job] ?? row.job}${row.variant ? `~${row.variant}` : ""}${row.open ? "°" : ""}`;
/** The series ids worth printing for a row: its group's first row only, and only when they say more than the indicator name (`XDEV: XDEV` is noise — [USER] 2026-10-13). */
export const seriesIds = (r) => (r.first && r.series.length && !(r.series.length === 1 && r.series[0] === r.indicator) ? r.series : []);
/** The series footnote under the Grid — `series — HY OAS: F1; escalation box: KBE F1 …` (`;` between groups: an indicator name may itself carry ` · `), one entry per
 *  indicator group with `seriesIds`, "" without any ([USER] 2026-10-13: the ids left the indicator cell, the Grid's widest). */
export const seriesNote = (g) => {
  const groups = g.rows.filter((r) => seriesIds(r).length).map((r) => `${r.indicator}: ${r.series.join(" ")}`);
  return groups.length ? `series — ${groups.join("; ")}` : "";
};

/** The clustered Episode gates head — both renderers print it. */
export const CLUSTER_HEAD = "Episode gates (hold on 1 coincident + 1 lead cluster vote, or a veto)";
/** The head a verdict's box prints: a lead vote alone holds when `escalation.leadAlone` (EU-Fin). */
export const clusterHead = (v) => (v?.escalation?.leadAlone ? "Episode gates (hold on 1 lead cluster vote, or a veto)" : CLUSTER_HEAD);
const CELL_MARK = { hit: "✗ HIT", false: "✓", na: "–", none: "none" };
const cellText = (text, cell) => `${text ?? "—"} ${CELL_MARK[String(cell)] ?? "–"}`;
/** One row per cluster member: `cluster | member | trips when | close | live | signs`; the cluster cell only on its first member; absent member text → `—`.
 *  The live cell carries its own mark off `liveCell` (a latest-print flip the close misses shows); without one it is the bare text. */
export const clusterRows = (verdict) =>
  (verdict.escalation?.clusters ?? []).flatMap((c) =>
    c.members.map((m, k) => [k ? "" : `${c.name} · ${c.kind} · ${c.hits}/${c.live} of ${c.n}${c.vote ? " · votes" : ""}`, m.id, m.rule ?? "—", cellText(m.value, m.cell), m.liveCell === undefined ? (m.live ?? m.value ?? "—") : cellText(m.live ?? m.value, m.liveCell), signsCell(m.signs)]),
  );
const holdWord = (e) => (e.hold ? "holds every tranche" : e.holdT2T3 ? "holds T2·T3" : e.quorum?.t1Only ? "below quorum — T1 only" : "no hold");
const votesOf = (e) => (e?.clusters ?? []).filter((c) => c.vote).map((c) => c.name);
/** `box: no hold · votes credit · veto x · live 4/5 need 4 · unread: capex · 3 closes since the drawdown opened` under the clustered table. */
export const clusterBoxText = (verdict) => {
  const e = verdict.escalation;
  return `box: ${holdWord(e)} · votes ${votesOf(e).join(", ") || "—"}${e.veto?.length ? ` · veto ${e.veto.join(", ")}` : ""}${e.quorum ? ` · live ${e.quorum.live}/${e.quorum.n} need ${e.quorum.need}` : ""}${e.unread?.length ? ` · unread: ${e.unread.join(", ")}` : ""}${verdict.sessionsSinceExit === undefined ? "" : ` · ${verdict.sessionsSinceExit} closes since the drawdown opened`}`;
};

/** A watch grade as shown: the bare grade plus why a held HIGH holds — `HIGH (latched from 10-22 · stretched from 10-05 · lifted by hy, vxsmh)`, each part only when set. */
export const watchGrade = (w) => {
  const why = [w.latched && `latched from ${w.latched.slice(5)}`, w.stretched && `stretched from ${w.stretched.slice(5)}`, w.lifted?.length && `lifted by ${w.lifted.join(", ")}`].filter(Boolean);
  return `${w.grade}${why.length ? ` (${why.join(" · ")})` : ""}`;
};
/** The drawdown watch head: `HIGH · drawdown open since 10-20, 3 closes · correction box: holds · votes credit, macro · live 6/7 need 5 · bear box: …`; `no drawdown open` without one. */
export const watchHead = (verdict) => {
  const w = verdict.watch;
  const box = (name, b) => `${name} box: ${b.hold ? "holds" : "no hold"} · votes ${b.votes.join(", ") || "—"} · live ${b.live}/${b.n} need ${b.quorum}`;
  const state = w.held ? "no drawdown open" : `drawdown open since ${w.exit?.slice(5) ?? "—"}${verdict.sessionsSinceExit === undefined ? "" : `, ${verdict.sessionsSinceExit} closes`}`;
  return [watchGrade(w), state, box("correction", w.correction), box("bear", w.bear)].join(" · ");
};
export const WATCH_HEAD = ["row", "now", "correction", "bear", "signs"];
/** A row that never touches the grade: a `context` row or a `manual` (sign-lean) row. */
const isContext = (r) => !!r.manual || r.role === "context";
const watchRank = (r) => (r.manual ? 4 : r.role === "context" ? 3 : r.role === "step" ? 2 : r.role === "confirmer" ? 1 : 0);
const watchRow = (r) => {
  const cells = r.manual ? [`lean ${leanWord(r.signs?.[0]?.lean) || "—"}`, r.correction.rule, r.bear.rule] : [r.now, cellText(r.correction.rule, r.correction.cell), cellText(r.bear.rule, r.bear.cell)];
  return [`${r.label} (${r.cluster}${r.role && r.role !== "context" ? ` · ${r.role}` : ""})`, ...cells, signsCell(r.signs)];
};
const sortedWatch = (verdict, keep) => [...(verdict.watch?.rows ?? [])].filter(keep).sort((a, b) => watchRank(a) - watchRank(b)).map(watchRow);
/** The graded watch rows (5-col), stable-sorted voters → confirmer → step; a role row names its role in the label. */
export const watchRows = (verdict) => sortedWatch(verdict, (r) => !isContext(r));
/** The context rows, after `WATCH_CONTEXT_NOTE`: `context` rows keep their marks, then `manual` rows show their sign's lean — none of them touch the grade. */
export const watchContextRows = (verdict) => sortedWatch(verdict, isContext);
export const WATCH_CONTEXT_NOTE = "Context — shown for reading, never graded:";
/** A watch table as rendered: `WATCH_HEAD` + `rows`, minus the trailing signs column when no row carries a sign (every cell `—`). */
export const watchTable = (rows) => {
  const bare = rows.every((r) => r[r.length - 1] === signsCell(undefined));
  return { head: bare ? WATCH_HEAD.slice(0, -1) : WATCH_HEAD, rows: bare ? rows.map((r) => r.slice(0, -1)) : rows };
};

/** The inline box line when it holds: `box holds: votes credit, rates-shock · veto capex`, `box holds: T2·T3 · veto capex`, or `box holds: below quorum — T1 only · live 2/5 need 4`. */
export const boxHoldsText = (box) =>
  `box holds: ${box.hold || box.holdT2T3 ? [box.hold ? "" : "T2·T3", box.votes.length ? `votes ${box.votes.join(", ")}` : "", box.veto.length ? `veto ${box.veto.join(", ")}` : ""].filter(Boolean).join(" · ") : `below quorum — T1 only · live ${box.quorum?.live}/${box.quorum?.n} need ${box.quorum?.need}`}`;

/** Blockers: one entry per `verdict.tranches` (T1–T3 always — T3 shown while T2 is unfilled). Rows route by the CLOSE `verdict`: unmet → `unmet`,
 *  met → `passing`, na → `unread` — except a na GATE → `unmet` under `naGateHolds` (`LEGS[leg].naGateHolds`, the probe's `tally` convention).
 *  `box` = the close box: `hold`, `holdT2T3`, its cluster `votes`, `veto`, `quorum`; `holds` = `hold` ∨ (T2/T3 ∧ (`holdT2T3` ∨ `quorum.t1Only`)) — `boxHolds`, scripts/ladder-tranche.ts. Needs no tags. */
export const blockers = (verdict, { naGateHolds = true } = {}) => {
  const e = verdict.escalation ?? null;
  const box = { present: !!e, hold: !!e?.hold, holdT2T3: !!e?.holdT2T3, votes: votesOf(e), veto: e?.veto ?? [], quorum: e?.quorum ?? null };
  const holds = (id) => box.hold || (id !== "T1" && (box.holdT2T3 || !!box.quorum?.t1Only));
  const route = (l) => (l.verdict === "unmet" || (l.verdict === "na" && l.gate && naGateHolds) ? "unmet" : l.verdict === "met" ? "passing" : "unread");
  const tranches = (verdict.tranches ?? []).map((close) => {
    const by = { unmet: [], passing: [], unread: [] };
    for (const l of (verdict.legs ?? []).filter((l) => l.tranche === close.id)) by[route(l)].push(l);
    // `filled` = the probe's close `ok` — deciding-event holds and a sign veto (`afterHolds`, src/ladder-run.ts) are NOT folded in: a held tranche renders as filled here.
    return { id: close.id, close, live: (verdict.live ?? []).find((t) => t.id === close.id) ?? null, filled: !!close.ok, ...by, box: { ...box, holds: holds(close.id) } };
  });
  return { tranches, held: !!verdict.watch?.held };
};
/** The Blockers `<summary>`: `Would hold — T1 · T2 · T3` while `held` (`watch.held`: no drawdown open), then `HELD_NOTE` opens the block; else `Blockers — …`. */
export const blockersSummary = (b) => `${b.held ? "Would hold" : "Blockers"} — ${TRANCHE_IDS.join(" · ")}`;
export const HELD_NOTE = "No drawdown open — nothing to buy back; these rows show what would hold a re-entry.";
/** The fold summary: `✓ 2/5 criteria (need 2) · ✓ 4 gates · box: no hold (votes credit) · – 1 unread` — criteria counts come from the row lists
 *  (met / met + unmet criterion rows, na excluded, = `LadderTranche.met/total`); the gates / box / unread segments drop out when zero / absent. */
export const foldText = (t) => {
  const crit = (rows) => rows.filter((l) => !l.gate).length;
  const gates = t.passing.filter((l) => l.gate).length;
  return [
    `✓ ${crit(t.passing)}/${crit(t.passing) + crit(t.unmet)} criteria (need ${t.close.need})`,
    ...(gates ? [`✓ ${gates} gates`] : []),
    ...(t.box.present ? [`box: ${t.box.holds ? "holds" : "no hold"} (votes ${t.box.votes.join(", ") || "—"})`] : []),
    ...(t.unread.length ? [`– ${t.unread.length} unread`] : []),
  ].join(" · ");
};

/** Whole days from `from` to `to` as a countdown: `6d` · `today` · `3d ago`. */
export const countdown = (from, to) => {
  const n = Math.round((Date.parse(to) - Date.parse(from)) / 864e5);
  return n > 0 ? `${n}d` : n === 0 ? "today" : `${-n}d ago`;
};
/** A sign chip's outcome word off an event's `status`: `escalation` / `fizzle` / `mixed` once landed (the `outcomeOf` prefixes, src/ladder-live.ts), `dropped` (never an outcome), `DELAY` while a holding event is owed; "" otherwise (NOT DUE, or a non-holding `outcome unsourced` — the chip then shows its countdown). */
export const landedWord = (status = "") => /^(escalation|fizzle|mixed|dropped): /.exec(status)?.[1] ?? (status.startsWith("DELAY") ? "DELAY" : "");
/** An event's escalation-if / fizzle-if conditions still matter: pending, DELAY or `mixed` (a clause unchecked) — a settled `fizzle` / `escalation` or a `dropped` one drops them from its detail. */
export const conditionsOwed = (word) => !["fizzle", "escalation", "dropped"].includes(word);
/** A stored pending `NOT DUE until <date>` read against `run`: `outcome owed` once `date` ≤ `run` (an events-only apply leaves the stored text stale). */
export const shownStatus = (status, run) => status.replace(/^NOT DUE until (\d{4}-\d{2}-\d{2})/, (m, d) => (d <= run ? "outcome owed" : m));
/** A sign row's chips with 2+ `fizzle` events folded into one `N fizzled` chip at the first one's slot — `fold` = its chip text, `detail` = one line per folded event (the expanded dates list keeps each). `mixed` (still followed up — a clause unchecked) and `escalation` keep their own chips [USER 2026-11-03]. The fold is dated at the first folded event (its slot), so a fizzle dated on/after the run never counts as the row's next upcoming chip (`signRows`). */
export const foldLanded = (chips) => {
  const done = chips.filter((c) => c.landed === "fizzle");
  if (done.length < 2) return chips;
  const fold = { date: done[0].date, event: false, mark: "", text: "", landed: "", fold: `${done.length} fizzled`, detail: done.map((c) => `${c.mark} ${c.date.slice(5)} ${c.text}`) };
  return chips.flatMap((c) => (c === done[0] ? [fold] : done.includes(c) ? [] : [c]));
};
/** Days past the run a ★ event still counts (`decidingWeek`), and days ahead a ☆ event counts too (`otherWeek`). */
export const DECIDING_DAYS = 7;
/** The Verdict's "Deciding in the next 7 days" text: each unlanded ★ event (no `outcomeOf` prefix, src/ladder-live.ts — `NOT DUE` / `DELAY`) dated ≤ `DECIDING_DAYS` past `run`, soonest first; `~` = an unverified est./conflict date (title or `dateNote`); `none` when empty. */
export const decidingWeek = (live) =>
  weekEvents(live, (e, d) => e.holds?.length && d <= DECIDING_DAYS * 864e5, "★", (e) => `, holds ${e.holds.join("+")}`);
/** The "Other events in the next 7 days" text, shown right after "Deciding in the next 7 days": each unlanded ☆ event (no tranche held) dated today to `DECIDING_DAYS` ahead of `run` — overdue ones drop — in `decidingWeek`'s format minus the holds; `none` when empty. */
export const otherWeek = (live) =>
  weekEvents(live, (e, d) => !e.holds?.length && d >= 0 && d <= DECIDING_DAYS * 864e5, "☆", () => "");
const days = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 864e5);
/** When a landed event's outcome came out: its newest stored source when that precedes the scheduled `date` (an early landing), else `date`. */
export const landedOn = (e) => [e.date, (e.sources ?? []).map((x) => x.date).sort().at(-1) ?? e.date].sort()[0];
const SETTLED = ["escalation", "fizzle", "mixed", "dropped"];
/** Live `events` + retired `eventsDone` — every history read (`retireEvents`, src/ladder-run.ts); live-only reads keep `events`. */
export const allEvents = (live) => [...(live.events ?? []), ...(live.eventsDone ?? [])];
/** A landed `escalation` / `mixed` event delaying a tranche, or the event a sign's `blocked.by` names — still holding at any age. */
export const holdingEvent = (live, e) => (["escalation", "mixed"].includes(landedWord(e.status)) && !!e.holds?.length) || (live.signs ?? []).some((s) => s.block && s.blocked?.by === e.event);
/** The Verdict's "Holding now" text: each holding landed event (`<event> (<outcome>, <age> d) holds T2+T3`), then each blocked sign; "" when none. */
export const holdingNow = (live) =>
  [
    ...allEvents(live).filter((e) => ["escalation", "mixed"].includes(landedWord(e.status)) && e.holds?.length).sort((a, b) => a.date.localeCompare(b.date))
      .map((e) => `${e.event.replace(/\s*\(.*$/, "")} (${landedWord(e.status)}, ${days(landedOn(e), live.run)} d) holds ${e.holds.join("+")}`),
    ...(live.signs ?? []).filter((s) => s.block).map((s) => `${s.sign} BLOCK${s.blocked ? ` (${s.blocked.by ? `by ${s.blocked.by}, ` : ""}${days(s.blocked.on, live.run)} d)` : ""}`),
  ].join(" · ");
/** A sign row's dates split: pending events, holding items, owed calendar rows and anything dated within `DECIDING_DAYS` before `run` (or later) stay `shown`;
 *  the rest fold into `history` = `{ text, items }` (null when nothing folds). Items carry `on` (landing day), `holding` (`holdingEvent`) and `owed` (a passed calendar row's outcome still owed). */
export const foldDates = (run, items) => {
  const settled = (i) => !i.event || SETTLED.includes(i.landed);
  const keep = (i) => !settled(i) || i.holding || i.owed || i.landed === "mixed" || days(i.on ?? i.date, run) <= DECIDING_DAYS;
  const old = items.filter((i) => !keep(i));
  if (!old.length) return { shown: items, history: null };
  const counts = ["fizzle", "escalation", "mixed", "dropped", ""].map((w) => [old.filter((i) => i.landed === w).length, w || "dated"]).filter(([n]) => n).map(([n, w]) => `${n} ${w}`);
  const last = old.reduce((a, i) => (i.date >= a.date ? i : a));
  return { shown: items.filter(keep), history: { text: `history: ${old.length} settled (${counts.join(" · ")}) · last ${last.date.slice(5)} ${last.text.replace(/\s*\(.*$/, "")}${last.landed ? ` ${last.landed}` : ""}`, items: old } };
};
/** The shared body of `decidingWeek` / `otherWeek`: unlanded events passing `keep(e, ms past run)`, soonest first, one `mark mm-dd[~] name (countdown…)` per event, joined by ` · `. */
const weekEvents = (live, keep, mark, tail) =>
  (live.events ?? [])
    .filter((e) => !/^(escalation|fizzle|mixed): /.test(e.status) && keep(e, Date.parse(e.date) - Date.parse(live.run)))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => `${mark} ${e.date.slice(5)}${e.verified !== true && /est\.|conflict|not confirmed/i.test(`${e.event} ${e.dateNote ?? ""}`) ? "~" : ""} ${e.event.replace(/\s*\(.*$/, "")}${e.secondary ? " (secondary)" : ""} (${countdown(live.run, e.date)}${tail(e)})`)
    .join(" · ") || "none";
