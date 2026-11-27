// Every class a seam emits resolves to a selector in the sheet its page loads (frontend.md).
// Add a seam as one ROWS entry; never hand-roll a per-file sweep.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { renderBandPanel } from "./band-panel.js";
import { cellTipHtml } from "./cell-tip.js";
import { absentMark, heldMark, lagMark, legCellLagMark, legLagMark } from "./cell-observed.js";
import { holdingList } from "./ext-links.js";
import { renderFamiliesLit } from "./lab-board.js";
import {
  cardLagMark,
  familyLagCountMark,
  feedsBehindPill,
  intradayMark,
  intradayVerdictChip,
  lastPrintMark,
} from "./feed-age-mark.js";
import { MARKET_MODES, marketModeCellHtml, marketModeFootHtml, marketModeQuadrantHtml } from "./market-mode.js";
import { BOTTOM_META, SLOW_BAND_META } from "./off-ladder-specs.js";
import { bottomPanelHTML, slowPanelHTML } from "./off-ladder-panel.js";
import { DD_GATE_LABEL, ddGateLineHtml } from "./overlay-strip.js";
import { pillarBarHtml } from "./sub-dangers.js";
import { TONE_CLASS, deadLitMarkHtml } from "./tile-members.js";

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const decomment = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SHEETS = new Map();
const sheet = (name) => {
  if (!SHEETS.has(name)) SHEETS.set(name, decomment(read(name)));
  return SHEETS.get(name);
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A selector token followed by a non-name char: `.jr-card` never matches `.jr-card-x` or `.jr-cardX`. */
const resolvesIn = (css, sel) => new RegExp(`${escapeRe(sel)}(?![\\w-])`).test(css);
const CLASS_NAME = /^-?[a-zA-Z_][\w-]*$/;
/** Class tokens of every `class="…"`; `${…}` interpolations drop out (their values ride `extra`). */
const classesIn = (html) => [
  ...new Set(
    [...html.matchAll(/class="([^"]+)"/g)]
      .flatMap((m) => m[1].replace(/\$\{[^}]*\}/g, " ").split(/\s+/))
      .filter((c) => CLASS_NAME.test(c)),
  ),
];
const sourceClasses = (seam) => classesIn(decomment(read(seam)));

const ragMember = (id, label, state, cappedState) => ({ id, label, state, cappedState });
const bandPanelEveryBranch = () =>
  renderBandPanel({
    level: "WARNING",
    dialBand: "WATCH",
    source: "credit",
    chain: { dangerScore: 0.42, regime: "Caution", band: "WARNING" },
    floors: [
      {
        id: "credit",
        level: "CRITICAL",
        cap: "CRITICAL",
        members: [ragMember("F1", "HY", "RED", "RED"), ragMember("F2", "IG", "AMBER", "AMBER"), ragMember("F3", "loans", "GREEN", "GREEN")],
      },
      {
        id: "r4",
        level: "WARNING",
        cap: "CRITICAL",
        members: [{ id: "rung", label: "rung", state: "AMBER", cappedState: "AMBER", value: 8, threshold: 8, note: "rung ≥ 8" }],
      },
      {
        id: "geo",
        level: "WATCH",
        cap: "WARNING",
        basis: "geo base 1",
        basisDetail: "geo base 1 = 1 manual",
        members: [ragMember("G1", "oil", "GREEN", "GREEN"), ragMember("NA", "no feed", "SUPPRESSED", "SUPPRESSED")],
      },
      { id: "rate", level: "WATCH", cap: "WATCH", members: [ragMember("R6", "curve", "RED", "AMBER")] },
      { id: "ew", level: "OK", cap: "WATCH", members: [ragMember("DB_SMH", "semis", "GREEN", "GREEN")] },
    ],
  });

const offLadderAll = () => {
  const LEG = { legend: "legend text" };
  const out = [];
  for (const meta of [undefined, ...Object.values(BOTTOM_META)]) {
    out.push(bottomPanelHTML({ bottomState: meta ? "CAPITULATION-WATCH" : "CALM" }, { ...LEG, meta }));
  }
  for (const meta of [undefined, ...Object.values(SLOW_BAND_META)]) {
    const metrics = { accelM: 0.85, cvixM: 0.05, chighM: 0.99 };
    out.push(slowPanelHTML({ band: meta ? "ELEVATED" : "CALM", score: 2, maxScore: 4, metrics }, { ...LEG, meta }));
  }
  return out.join("");
};

const subDangerBars = () => {
  const scored = (value) => ({ kind: "scored", value });
  const opts = {
    ticksHtml: '<span class="lg-bar-tick" data-css-left="12.9"></span>',
    clauses: [" - COV"],
    titles: { na: "NA", g: (n) => `G ${n}`, a: (n) => `A ${n}`, r: (n) => `R ${n}` },
  };
  const arms = [
    scored(0.1),
    scored(0.4),
    scored(0.6),
    { kind: "uncomparable", reason: "not-live" },
  ];
  return arms.map((p) => pillarBarHtml("S", p, opts)).join("");
};

const cellObservedMarks = () => {
  const obs = (o) => ({ observed: { fresh: 1, lag: 0, absent: 0, deepLag: 0, ...o } });
  const late = obs({ lag: 1 });
  const rotted = obs({ lag: 1, deepLag: 1 });
  const marks = [
    absentMark(obs({ fresh: 0, absent: 1 })),
    lagMark(late),
    lagMark(rotted),
    legLagMark([late]),
    legLagMark([rotted]),
    legCellLagMark([{ family: "vl", ...late }]),
    legCellLagMark([{ family: "rt", ...rotted }]),
    heldMark({ held: { member: "R4", closes: 7 } }),
  ];
  return [...new Set(marks.flatMap((m) => [m.cls, ...classesIn(m.html ?? "")]))];
};

const cellTipPanel = () => {
  const m = (id, sev, w, label) => ({ id, sev, w, label });
  const cell = { family: "rt", cellState: "elev", M: 2, N: 8, observed: { fresh: 7, lag: 0, absent: 1 }, held: { member: "R4", closes: 7, ageCloses: 2 } };
  return cellTipHtml(cell, [
    m("R3", "lit", 1, "2y Δ"),
    { ...m("R6", "elev", 0.8, "MOVE"), held: { ageCloses: 1 } },
    m("R1", "calm", 1, "10y−3m"),
    m("R2", "absent", 0.8, "10y Δ"),
  ]);
};

const feedAgeMarks = () =>
  [
    cardLagMark({ lag: true, ageDays: 2 }).html,
    lastPrintMark({ lag: true, lastPrint: { date: "2026-09-12", days: 21, cadence: "daily", reason: "cap" } }).html,
    familyLagCountMark([{ id: "EU2", lag: true, ageDays: 9 }]).html,
    feedsBehindPill({ feedsLagging: 1, feedsTotal: 9 }).html,
    feedsBehindPill({ feedsLagging: 0, feedsTotal: 9 }).html,
    intradayMark({ provisional: true }, "2026-06-26"),
    intradayMark({ provisional: true, estimated: true }, "2026-06-26"),
    intradayVerdictChip({ provisional: true, asOf: "2026-06-26" }),
  ].join("");

const marketModeAll = () =>
  [marketModeFootHtml(), marketModeQuadrantHtml(), marketModeCellHtml(null), ...Object.values(MARKET_MODES).map(marketModeCellHtml)].join("");

const ddGateLine = () =>
  ddGateLineHtml([
    {
      id: "fallShape",
      label: "fallShape overlay",
      headline: "shape: v-shaped · confident",
      tone: "neutral",
      group: "decision-now",
      fields: [
        { label: "shape", value: "v-shaped" },
        { label: DD_GATE_LABEL, value: "would fire" },
      ],
    },
  ]);

/** `pctBadge` lives in lab-board.js (DOM side effects, not importable): lifted as its own test lifts it.
 *  A moved seam returns "" here, so the row's anchors red rather than collection crashing. */
const pctBadgeEveryArm = () => {
  const src = read("lab-board.js").match(/function pctBadge\(ewPct\)\s*\{[\s\S]*?\n\}/)?.[0];
  if (!src) return "";
  const pctBadge = new Function(`return (${src});`)();
  return [
    { kind: "warmup" },
    { kind: "na" },
    { kind: "stale-basis" },
    { kind: "pct", value: 0.5 },
    { kind: "pct", value: 0.5, basisSpans: ["2026-05-15"] },
  ]
    .map((c) => String(pctBadge(c)))
    .join("");
};

const htmlJrClasses = (page) => classesIn(read(page)).filter((c) => c.startsWith("jr-"));

/**
 * name · sheets (a class resolves in ANY of them) · emitted() · anchors (must be emitted) ·
 * extra (selectors that must resolve) · altSheet (class → the only sheet it may resolve in) · unstyled.
 */
const ROWS = [
  {
    name: "band-panel",
    sheets: ["styles.css"],
    emitted: () => classesIn(bandPanelEveryBranch()),
    anchors: ["bp-binding", "bp-dim", "bp-fold", "bp-calm", "bp-margin", "bp-members", "bp-note-toggle", "bp-floor-basis", "bp-chain-esc", "bp-esc-band"],
    extra: ["g", "a", "r", "s"].flatMap((t) => [`.bp-member.${t}`, `.bp-floor-fchip.${t}`]),
    altSheet: { "sec-tip": "lab.css" },
  },
  {
    name: "coverage-marks",
    sheets: ["lab.css"],
    emitted: () => sourceClasses("coverage-marks.js"),
    anchors: ["leg-flip"],
    extra: ["#dfFlipLegend"],
  },
  {
    name: "held-path",
    sheets: ["lab.css"],
    emitted: () => sourceClasses("held-path.js"),
    anchors: ["hp-row"],
    extra: ["#heldPathHost", ".held-path"],
  },
  {
    name: "family-lag",
    sheets: ["lab.css"],
    emitted: () => sourceClasses("family-lag.js"),
    anchors: ["fam-lag"],
    extra: [".sig-lag-deep", ".sig-lag-soft", ".t-lag:empty", ".board-lag:empty"],
  },
  {
    name: "off-ladder panels",
    sheets: ["styles.css"],
    emitted: () => classesIn(offLadderAll()),
    anchors: ["slow-metrics"],
  },
  {
    name: "sub-dangers pillar bar",
    sheets: ["lab.css"],
    emitted: () => classesIn(subDangerBars()),
    anchors: ["lg-bar-fill", "g", "a", "r"],
  },
  {
    name: "cell-observed marks",
    sheets: ["lab.css"],
    emitted: cellObservedMarks,
    anchors: ["sig-absent", "sig-abs-n", "sig-lag-soft", "sig-lag-deep", "leg-lag", "sig-held"],
  },
  {
    name: "cell-tip panel",
    sheets: ["lab.css"],
    emitted: () => classesIn(cellTipPanel()),
    anchors: ["ct-head"],
  },
  {
    name: "disclaimer",
    sheets: ["styles.css"],
    emitted: () => [...read("disclaimer.js").matchAll(/className\s*=\s*"([a-z0-9-]+)"/g)].map((m) => m[1]),
    anchors: ["disclaimer-bar", "site-footer-legal"],
  },
  {
    name: "overlay-strip dd-gate line",
    sheets: ["lab.css", "styles.css"],
    emitted: () => classesIn(ddGateLine()),
    anchors: ["overlay-ddgate"],
    unstyled: ["overlay-neutral", "overlay-caution", "overlay-alert"],
  },
  {
    name: "market-mode",
    sheets: ["lab.css"],
    emitted: () => classesIn(marketModeAll()),
    anchors: ["mode-key"],
  },
  {
    name: "feed-age-mark",
    sheets: ["styles.css"],
    emitted: () => classesIn(feedAgeMarks()),
    anchors: ["intraday-mark-est"],
  },
  {
    name: "ext-links",
    sheets: ["styles.css"],
    emitted: () => ["ext-links", ...classesIn(holdingList([{ name: "MU" }]))],
    anchors: ["ext-holding"],
  },
  {
    name: "journal-view",
    sheets: ["journal.css"],
    emitted: () => sourceClasses("journal-view.js"),
    anchors: ["jr-empty"],
  },
  { name: "signin.html jr-*", sheets: ["journal.css"], emitted: () => htmlJrClasses("signin.html"), anchors: ["jr-card"] },
  { name: "subscribe.html jr-*", sheets: ["journal.css"], emitted: () => htmlJrClasses("subscribe.html"), anchors: ["jr-card"] },
  {
    name: "leg-percentile badge",
    sheets: ["lab.css"],
    emitted: () => classesIn(pctBadgeEveryArm()),
    anchors: ["lg-pct", "est"],
    // `.est` is a modifier: only the COMPOUND selector styles this badge, not a bare `.est` elsewhere.
    extra: [".lg-pct.est"],
  },
  {
    name: "ledger families-lit count",
    sheets: ["lab.css"],
    emitted: () => classesIn(renderFamiliesLit({ familiesLit: { earlyWarn: { lit: 1, of: 2 } } }, "earlyWarn")),
    anchors: ["lg-lit"],
  },
  {
    name: "member chip tones + dead-lit mark",
    sheets: ["lab.css"],
    emitted: () => [...Object.values(TONE_CLASS), ...classesIn(deadLitMarkHtml("R8", "dead", new Set()))],
    anchors: ["mt-dead", "leg-dead"],
    // `mt-live` is full weight by design — the tones dim from it, so it carries no rule.
    unstyled: ["mt-live"],
  },
];

describe("every emitted class resolves to a selector in its page's sheet", () => {
  it.each(ROWS)("$name", (row) => {
    const emitted = row.emitted();
    for (const a of row.anchors) expect(emitted, `${row.name} no longer emits ${a}`).toContain(a);
    const unstyled = new Set(row.unstyled ?? []);
    const alt = row.altSheet ?? {};
    const resolves = (c) =>
      alt[c] ? resolvesIn(sheet(alt[c]), `.${c}`) : row.sheets.some((s) => resolvesIn(sheet(s), `.${c}`));
    expect(emitted.filter((c) => !unstyled.has(c) && !resolves(c))).toEqual([]);
    for (const sel of row.extra ?? []) expect(row.sheets.some((s) => resolvesIn(sheet(s), sel)), sel).toBe(true);
    for (const [c, s] of Object.entries(alt)) {
      expect(row.sheets.some((p) => resolvesIn(sheet(p), `.${c}`)), `${c} resolves in ${row.sheets} - drop it from altSheet`).toBe(false);
      expect(resolvesIn(sheet(s), `.${c}`)).toBe(true);
    }
  });

  it("the resolver rejects a near-miss name and a class styled only on another page's sheet", () => {
    expect(resolvesIn(".jr-card-x { color: red }", ".jr-card")).toBe(false);
    expect(resolvesIn(".jr-cardX { color: red }", ".jr-card")).toBe(false);
    expect(resolvesIn(".jr-card, .x { color: red }", ".jr-card")).toBe(true);
    expect(resolvesIn(sheet("lab.css"), ".bp-note-toggle")).toBe(false);
    expect(resolvesIn(sheet("styles.css"), ".bp-note-toggle")).toBe(true);
  });
});
