// BAND-column render seam. Plain `.js` so vitest's default
// glob collects it while `tsc` ignores it — no jsdom: band-panel.js is the pure HTML seam lab.js
// paints into #bandPanelHost. The DTO shapes below mirror src/families.ts's LabBand exactly.
import { describe, expect, it } from "vitest";
import { MEMBER_DESC, renderBandPanel } from "./band-panel.js";
// NB: `.ts` specifier (not the project's usual `.js`) — vitest resolves it and this `.js` test is
// invisible to tsc, so the prod `.js`-extension rule does not apply (same seam as leading-name.test.js).
import { ALL_INDICATORS } from "../src/registry.ts";
// The chips come from the REAL server builder, never a hand-typed mirror.
import { fallShapeChips } from "../src/v-bear.ts";
// The geo `basis` line is driven end-to-end through the real band builder + dial fixture.
import { buildLabBand, EW_HALF_MET_BREAK } from "../src/alert-band.ts";
import { makeDial } from "../src/test-helpers.ts";

/** RAG member: own confirmed `state` + its floor-capped `cappedState`. */
const ragMember = (id, label, state, cappedState) => ({ id, label, state, cappedState });

/** A settled live band: 5 floors most-severe-first. ALL FIVE render named member rows.
 *  `source: "credit"` is the binding floor. */
function liveBand(overrides = {}) {
  return {
    level: "WARNING",
    // The pre-floor dial band. EQUAL to `level` in the shared fixture on purpose — that is the
    // quiet (no-escalation) case, so every pre-dialBand assertion below still reads the unchanged head.
    dialBand: "WARNING",
    source: "credit",
    chain: { dangerScore: 0.42, regime: "Caution", band: "WARNING" },
    floors: [
      {
        id: "credit",
        level: "CRITICAL",
        cap: "CRITICAL",
        members: [ragMember("F1", "HY OAS", "RED", "RED"), ragMember("F2", "IG OAS", "AMBER", "AMBER")],
      },
      {
        id: "r4",
        level: "WARNING",
        cap: "CRITICAL",
        // The breaker's PHASE rides the floor head; the rows below tone by their own proximity to
        // their own gate instead, so `state` here is 8/8 = AMBER on its own merits, not because the
        // phase is `reentry`.
        phase: "reentry",
        phaseState: "AMBER",
        members: [
          // r4 enter-input row: proximity tone + live value vs gate; always shown (carries numbers).
          { id: "rung", label: "rung", state: "AMBER", cappedState: "AMBER", value: 8, threshold: 8, note: "rung ≥ 8 to enter" },
        ],
      },
      { id: "geo", level: "WATCH", cap: "WARNING", members: [ragMember("G1", "oil shock", "AMBER", "AMBER")] },
      {
        id: "rate",
        level: "WATCH",
        cap: "WATCH",
        // Own signal RED, floor caps at WATCH → the dot must be capped AMBER (class `a`), never RED.
        members: [ragMember("R6", "curve", "RED", "AMBER")],
      },
      { id: "ew", level: "OK", cap: "WATCH", members: [ragMember("DB_SMH", "semis", "GREEN", "GREEN")] },
    ],
    ...overrides,
  };
}

/** Pull one floor's full markup block by its data-floor id (compact or full) — sliced between this
 *  floor's opening div and the next floor's (floors are flat siblings in .bp-column).
 *  ⚠ The LAST floor has no next `data-floor`, so its slice must stop at the footnote instead of
 *  running to `html.length`: the panel emits `.bp-note` after `.bp-column`, and an unterminated tail
 *  slice swallows the column's close tag plus all of `bandNote()`'s prose — which would let a future
 *  NEGATIVE assertion (`expect(floorBlock(html,"ew")).not.toContain(…)`) scan footnote copy and pass
 *  or fail for the wrong reason. The terminator is the note's TOGGLE (`bandNote()` emits it first),
 *  not the `.bp-note` div behind it. */
const floorBlock = (html, id) => {
  const at = html.indexOf(`data-floor="${id}"`);
  if (at < 0) return undefined;
  const from = html.lastIndexOf('<div class="bp-floor', at);
  const nextData = html.indexOf('data-floor="', at + 1);
  const nextFloor = nextData < 0 ? -1 : html.lastIndexOf('<div class="bp-floor', nextData);
  const note = html.indexOf('<button type="button" class="bp-note-toggle"', at);
  const ends = [nextFloor, note].filter((i) => i >= 0);
  return html.slice(from, ends.length ? Math.min(...ends) : html.length);
};

/** Pull one full-floor member row by its data-id. */
const memberBlock = (html, id) =>
  html.match(new RegExp(`<div class="bp-member [gars]" data-id="${id}"[^>]*>.*?</div>`, "s"))?.[0];

describe("renderBandPanel - deduction chain (top strip)", () => {
  it("reads left→right as danger →cut→ REGIME →floors→ BAND", () => {
    expect(renderBandPanel(liveBand())).toContain("danger 0.42 -cut→ CAUTION -floors→ WARNING");
  });
});

// The PRE-FLOOR dial band renders beside the final one, and ONLY when a floor (or the lag) raised it.
// Both halves are owed: the positive one alone would pass an always-on regression.
describe("renderBandPanel - the pre-floor dial band (R6)", () => {
  /** The panel HEAD: everything above the floor column, i.e. the chain strip + escalation line. */
  const head = (html) => html.slice(0, html.indexOf('<div class="bp-column"'));
  /** Band WORDS painted in a fragment (the regime word in the strip is `CALM`/`CAUTION` — never a
   *  band name — so this counts exactly the alert-level tokens on screen). ATTRIBUTE VALUES are
   *  stripped first: the chain strip's section tooltip (section-tips.js) names the whole band ladder
   *  inside its `title=`, and a tooltip is not paint — counting it would make every case below read
   *  as "both bands on screen". */
  const bandWords = (s) => (s.replace(/\s\w[\w-]*="[^"]*"/g, "").match(/\b(?:OK|WATCH|WARNING|CRITICAL)\b/g) || []);

  // LIVE PATH: the band comes from the real server builder, not a hand-typed view object — two
  // manual geo flags put the geo floor at WARNING over a Calm dial (`makeDial()` ⇒ dialBand OK).
  const escalated = () => buildLabBand(makeDial(), [], 2, "equity", "WARNING", 0);

  it("floor ACTIVE ⇒ both bands paint, and they differ", () => {
    const band = escalated();
    // Guard: the fixture really is an escalation, and `source` really is the geo floor.
    expect(band.dialBand).toBe("OK");
    expect(band.level).toBe("WARNING");
    expect(band.source).toBe("geo");
    const h = head(renderBandPanel(band));
    expect(h).toContain(
      'the market read is <b class="bp-esc-band">OK</b>; the geo floor raised it to <b class="bp-esc-band">WARNING</b>',
    );
    // BOTH bands on screen, and they are two DIFFERENT bands — the whole point of the rung.
    expect(new Set(bandWords(h))).toEqual(new Set(["OK", "WARNING"]));
  });

  it("floor INACTIVE ⇒ EXACTLY ONE band paints (the conditional is not always-on)", () => {
    // Same real builder, no flags, pushed band = the dial's own: nothing escalated anything.
    const band = buildLabBand(makeDial(), [], 0, "equity", "OK", 0);
    expect(band.dialBand).toBe(band.level); // guard: this really is the agreeing case
    const h = head(renderBandPanel(band));
    expect(h).not.toContain("bp-chain-esc");
    expect(bandWords(h)).toEqual(["OK"]);
  });

  it("names the LAG/hold instead of a floor when `source` is null", () => {
    // A de-escalation lag (or the divergence/stale hold) lifts the band with NO binding floor;
    // the copy must not invent one.
    const h = head(renderBandPanel(liveBand({ dialBand: "WATCH", source: null })));
    expect(h).toContain('the market read is <b class="bp-esc-band">WATCH</b>; it is held at');
    expect(h).not.toContain("floor raised it");
  });

  // The THIRD case the two above miss: a floor is NAMED (`source` is
  // set) but it did NOT reach the final band. `source` is the highest floor above OK, not the
  // binding one, so a lag-hold / divergence / verdict-hold day serves both a gap AND a source. The
  // positive fixture above cannot see this — its geo floor EQUALS `level`. Copy must fall back to
  // "held at": the geo floor at WATCH did not put the band at WARNING.
  it("does NOT credit a floor that sits BELOW the final band - it says the band is held there", () => {
    const band = liveBand({ level: "WARNING", dialBand: "OK", source: "geo" });
    // Guards: the named floor really is present, really is below `level`, and there IS a gap.
    const geo = band.floors.find((f) => f.id === "geo");
    expect(geo.level).toBe("WATCH");
    expect(band.level).toBe("WARNING");
    const h = head(renderBandPanel(band));
    expect(h).toContain('the market read is <b class="bp-esc-band">OK</b>; it is held at');
    expect(h).not.toContain("floor raised it");
    expect(h).not.toContain("geo floor");
  });

  it("reads `dialBand`, NOT the post-floor `chain.band`", () => {
    // The trap the rung names: `chain.band` is the pushed band and equals `level`, so a build that
    // read it would render nothing here. This fixture has chain.band === level and dialBand BELOW
    // both — only a dialBand reader can paint the escalation.
    const h = head(renderBandPanel(liveBand({ dialBand: "WATCH" })));
    expect(h).toContain("bp-chain-esc");
    expect(h).toContain('<b class="bp-esc-band">WATCH</b>');
  });
});

describe("renderBandPanel - floor chips", () => {
  it("renders all 5 escalator floor chips at their OWN computed level", () => {
    const html = renderBandPanel(liveBand());
    expect(floorBlock(html, "credit")).toContain('class="bp-floor-chip lvl-CRITICAL">CRITICAL');
    expect(floorBlock(html, "r4")).toContain('class="bp-floor-chip lvl-WARNING">WARNING');
    expect(floorBlock(html, "geo")).toContain('class="bp-floor-chip lvl-WATCH">WATCH');
    expect(floorBlock(html, "rate")).toContain('class="bp-floor-chip lvl-WATCH">WATCH');
    expect(floorBlock(html, "ew")).toContain('class="bp-floor-chip lvl-OK">OK');
    expect((html.match(/data-floor=/g) || []).length).toBe(5);
  });
});

describe("renderBandPanel - r4 phase chip on the floor head ([USER] E5, 2026-07-26)", () => {
  it("renders the served phase and its served tone on r4, and on no other floor", () => {
    const html = renderBandPanel(liveBand());
    // Tone comes from `phaseState` (server-owned table) — the FE must not re-derive it from `phase`.
    expect(floorBlock(html, "r4")).toContain('class="bp-floor-phase a"');
    expect(floorBlock(html, "r4")).toContain("phase: reentry");
    // Head ORDER: id · phase · level, so the level chip stays the last (hard-right) child on all
    // five floors — with the phase last, r4's level chip landed mid-head (`justify-content:
    // space-between` over three children) and broke the chips' vertical scan line.
    const head = floorBlock(html, "r4");
    expect(head.indexOf("bp-floor-phase")).toBeLessThan(head.indexOf("bp-floor-chip"));
    for (const id of ["credit", "geo", "rate", "ew"]) {
      expect(floorBlock(html, id)).not.toContain("bp-floor-phase");
    }
  });

  it("takes the SERVED tone, never one re-derived from `phase` in the FE", () => {
    // DELIBERATELY INCONSISTENT payload — `cash` tones RED in the server's phase→tone table
    // (R4_PHASE_TONE, src/alert-band.ts), yet `phaseState` here says AMBER. The engine can never
    // emit this pair; it exists only to probe the FE/server seam, so do NOT "fix" it into
    // consistency — a consistent fixture passes under both rules and pins nothing. If the FE ever
    // mirrors the phase table locally, this chip paints `r` and the assertion goes red.
    const band = liveBand();
    const r4 = band.floors.find((f) => f.id === "r4");
    r4.phase = "cash";
    r4.phaseState = "AMBER";
    const block = floorBlock(renderBandPanel(band), "r4");
    expect(block).toContain('class="bp-floor-phase a"');
    expect(block).not.toContain('class="bp-floor-phase r"');
  });

  it("omits the chip entirely when no phase is served (every non-r4 floor, and a pre-E5 payload)", () => {
    const noPhase = liveBand();
    const r4 = noPhase.floors.find((f) => f.id === "r4");
    delete r4.phase;
    delete r4.phaseState;
    expect(renderBandPanel(noPhase)).not.toContain("bp-floor-phase");
  });
});

// The geo floor's level is a SUM (manual flags + elevated auto readings +
// declared stage), so it is the one floor whose verdict cannot be read off its member rows; without
// the arithmetic a geo WARNING reads as "someone set a flag". Driven END-TO-END through the REAL
// server builder (`buildLabBand`) rather than a hand-typed `basis` string: the composition under
// test is production's, so a change to either half surfaces here.
describe("renderBandPanel - the geo floor prints its count arithmetic (R9)", () => {
  /** A GEO-channel reading in the shape `buildLabBand` consumes. */
  const geoReading = (id, state) => ({
    indicator: { id, label: id, longLabel: id, series: id, channel: "GEO", thresholds: {}, confirmer: false },
    date: "2026-07-31",
    level: 1,
    delta20: 0,
    rawState: state,
    state,
  });
  /** Render the real band for (auto readings, manual flags) and slice the geo floor's markup out. */
  const geoBlock = (readings, flags) =>
    floorBlock(renderBandPanel(buildLabBand(makeDial(), readings, flags, "equity", "OK", 0)), "geo");
  // The line is SPLIT: the printed text is the lead (`geo base N`) and the addends
  // ride the `title=` the ⓘ opens. Both halves are read separately so a regression that puts the
  // arithmetic back inline (the width defect) fails the first matcher, not the second.
  const basisText = (block) => block.match(/<div class="bp-floor-basis"[^>]*>([^<]*)<\/div>/)?.[1];
  const basisNote = (block) => block.match(/<div class="bp-floor-basis" title="([^"]*)"/)?.[1];

  it("FALSIFIER - one manual flag with every auto GEO reading GREEN renders WATCH and prints `base 1`", () => {
    // The plan's own falsifier: a lone manual flag does NOT reach WARNING, and the row must say so.
    const block = geoBlock([geoReading("G1", "GREEN"), geoReading("OVX", "GREEN"), geoReading("BRENT", "GREEN")], 1);
    expect(basisText(block)).toBe("geo base 1");
    expect(basisNote(block)).toBe("geo base 1 = 1 manual");
    expect(block).toContain('class="bp-floor-chip lvl-WATCH"');
  });

  it("names the auto reading that made the second flag, and never restates the floor's cuts", () => {
    const block = geoBlock([geoReading("G1", "GREEN"), geoReading("OVX", "RED"), geoReading("BRENT", "GREEN")], 1);
    // The addends are the FOOTNOTE now; the line itself carries the sum alone.
    expect(basisText(block)).toBe("geo base 2");
    expect(basisNote(block)).toBe("geo base 2 = 1 manual + 1 auto (OVX)");
    expect(block).toContain('class="bp-floor-chip lvl-WARNING"');
    // Round-2 ruling: the SUM only. A cut hand-copied into display copy is what drifts, so neither
    // the printed line nor its footnote may carry a threshold or a band word (the level chip beside
    // it is the band).
    expect(basisText(block)).not.toMatch(/≥|>=|WATCH|WARNING|CRITICAL/);
    expect(basisNote(block)).not.toMatch(/≥|>=|WATCH|WARNING|CRITICAL/);
  });

  it("prints it between the head and the member rows, and only where the server sent one", () => {
    const block = geoBlock([geoReading("OVX", "RED")], 1);
    expect(block.indexOf("bp-floor-head")).toBeLessThan(block.indexOf("bp-floor-basis"));
    expect(block.indexOf("bp-floor-basis")).toBeLessThan(block.indexOf("bp-members"));
    // Every other floor omits it — and so does a payload with no `basis` at all (liveBand()).
    const html = renderBandPanel(buildLabBand(makeDial(), [geoReading("OVX", "RED")], 1, "equity", "OK", 0));
    for (const id of ["credit", "r4", "rate", "ew"]) {
      expect(floorBlock(html, id)).not.toContain("bp-floor-basis");
    }
    expect(renderBandPanel(liveBand())).not.toContain("bp-floor-basis");
  });
});

describe("renderBandPanel - uniform named member rows ([USER] 2026-07-24)", () => {
  it("renders NAMED member rows on all five floors, with the dot rail gone", () => {
    const html = renderBandPanel(liveBand());
    for (const id of ["credit", "r4", "geo", "rate", "ew"]) {
      expect(floorBlock(html, id)).toContain('class="bp-members"');
    }
    // The retired compact variant must leave no emitter behind — a partial revert would show here.
    expect(html).not.toContain("bp-compact");
    expect(html).not.toContain("bp-dot");
    // A formerly-dot-rail floor now names its indicator on screen, not just in a tooltip.
    expect(floorBlock(html, "geo")).toContain(">oil shock<");
  });

  it("caps a member ROW to the floor's reach - rate RED signal → AMBER bar (§7 Q2)", () => {
    const block = floorBlock(renderBandPanel(liveBand()), "rate");
    expect(block).toContain('class="bp-member a"'); // capped AMBER
    expect(block).not.toContain('class="bp-member r"'); // never the raw RED
  });
});

describe("MEMBER_DESC coverage - every band member carries a detailed tooltip", () => {
  // The ask is "enough detailed explanation of its meaning and triggering
  // condition" on EVERY member of all five floors. A markup pin can't see a MISSING entry (the row
  // still renders, just tooltip-less — the exact way BUND once shipped, leading-name.test.js §), so
  // pin the roster: every id `buildLabBand` can emit must resolve to a MEMBER_DESC entry. DERIVED from
  // `buildLabBand` over a reading for every registry id, so a new floor member without copy reds here.
  const everyReading = ALL_INDICATORS.map((indicator) => ({
    indicator, date: "2026-07-31", level: 1, delta20: 0, rawState: "AMBER", state: "AMBER",
  }));
  const ROSTER = buildLabBand(makeDial(), everyReading, 1, "equity", "OK", 1)
    .floors.flatMap((f) => (f.members ?? []).map((m) => m.id));

  it("derives exactly the MEMBER_DESC key set (no lost reading-driven member, no orphan copy)", () => {
    expect(new Set(ROSTER)).toEqual(new Set(Object.keys(MEMBER_DESC)));
  });

  it("gives every floor member a tooltip long enough to state meaning AND trigger", () => {
    const html = renderBandPanel({
      level: "OK",
      source: null,
      chain: { dangerScore: 0.1, regime: "Calm", band: "OK" },
      floors: [
        { id: "credit", level: "OK", cap: "CRITICAL", members: ROSTER.map((id) => ragMember(id, id, "AMBER", "AMBER")) },
      ],
    });
    for (const id of ROSTER) {
      const cell = memberBlock(html, id);
      const title = cell?.match(/title="([^"]*)"/)?.[1] ?? "";
      // 120 chars is well past a bare label but well under the shortest entry (~230), so this
      // fails on a missing/one-line entry and cannot be satisfied by the id alone.
      expect(title.length, `MEMBER_DESC["${id}"] missing or too short`).toBeGreaterThan(120);
    }
  });
});

// Each MEMBER_DESC entry is the bare sentence and `memberTitle` composes the name segment ahead of it.
// What remains here guards the synthetic rows' identity and the composed-title render.
describe("MEMBER_DESC - synthetic rows and title composition", () => {
  const LABEL_OF = new Map(ALL_INDICATORS.map((i) => [i.id, i.label]));
  /** MEMBER_DESC keys with no indicator behind them: the four r4 enter-gate rows synthesized by
   *  `buildLabBand`, the manual-flag summary row and the declared-stage addend row. */
  const SYNTHETIC_KEYS = ["r4-rung", "r4-families", "r4-hyoas", "r4-vt", "GEO_MANUAL", "GEO_STAGE"];

  it("the synthetic rows are absent from the registry yet carry their own MEMBER_DESC copy", () => {
    expect(SYNTHETIC_KEYS.filter((k) => LABEL_OF.has(k))).toEqual([]);
    expect(SYNTHETIC_KEYS.filter((k) => !MEMBER_DESC[k])).toEqual([]);
  });

  // The row emits its own name segment (`label · id`) and the copy is the bare sentence, so the short
  // name prints exactly once, from the name segment. Re-adding a leading label clause to the F1 copy would red this.
  it("emits a member's short name ONCE in the title, never stuttered", () => {
    const cell = memberBlock(renderBandPanel(liveBand()), "F1");
    const title = cell.match(/title="([^"]*)"/)[1];
    expect(title.match(/HY OAS/g).length).toBe(1);
    expect(title.startsWith("HY OAS · F1 · the US high-yield option-adjusted spread")).toBe(true);
  });

  // Stage 4.3: the synthetic r4 row renders its LabBandMember.label ("dial rung") as the name
  // segment, then the bare MEMBER_DESC sentence (its "T1 dial rung — " clause was dropped). Pins the
  // composed render — a band row whose stored label once differed from `LabBandMember.label` no
  // longer leaks the stored one into the tooltip.
  it("composes a synthetic row's title from its LabBandMember.label + the bare sentence", () => {
    const band = liveBand();
    band.floors[1].members = [
      { id: "r4-rung", label: "dial rung", state: "AMBER", cappedState: "AMBER", value: 8, threshold: 8, note: "rung ≥ 8 to enter" },
    ];
    const title = memberBlock(renderBandPanel(band), "r4-rung").match(/title="([^"]*)"/)[1];
    expect(title).toContain("dial rung · r4-rung · where the danger dial");
  });
});

// The ew half-met pair rows render the server `note` VERBATIM into member `title=` — server-owned
// (`src/alert-band.ts`), never recomputed here; the PROBE fixture is a string no FE table could produce.
describe("renderBandPanel - ew AND-gate pair rows + note-in-tooltip (Stage 4, 2026-08-15)", () => {
  const HALF_MET = EW_HALF_MET_BREAK;
  const PROBE = "zz-verbatim-probe: only the payload can say this";
  const ewBand = () =>
    liveBand({
      floors: [
        ...liveBand().floors.slice(0, 4),
        {
          id: "ew",
          level: "OK",
          cap: "WATCH",
          members: [
            { ...ragMember("DB_SMH", "SMH fast break", "AMBER", "AMBER"), note: HALF_MET },
            { ...ragMember("RS_SMH", "SMH rel strength", "GREEN", "GREEN"), note: HALF_MET },
            ragMember("DB_XLK", "XLK fast break", "GREEN", "GREEN"),
            { ...ragMember("RS_XLK", "XLK rel strength", "GREEN", "GREEN"), note: PROBE },
          ],
        },
      ],
    });

  it("renders all four rows and puts the half-met pair's note in BOTH rows' titles", () => {
    const html = renderBandPanel(ewBand());
    for (const id of ["DB_SMH", "RS_SMH", "DB_XLK", "RS_XLK"]) {
      expect(memberBlock(html, id), `ew row ${id}`).toBeTruthy();
    }
    // BOTH rows of the half-met pair carry the note — the firing one and the folded calm one.
    for (const id of ["DB_SMH", "RS_SMH"]) {
      const title = memberBlock(html, id).match(/title="([^"]*)"/)[1];
      expect(title, `${id} title carries the note`).toContain(HALF_MET);
    }
    // The un-noted detector's title stays note-free (no invented FE wording).
    // Absence asserted against the SAME constant the server emits — a hand-typed literal here goes
    // vacuous the moment the production copy is reworded, which is exactly how it rotted before.
    expect(memberBlock(html, "DB_XLK").match(/title="([^"]*)"/)[1]).not.toContain(HALF_MET);
  });

  it("renders the note VERBATIM from the payload - never recomputed in the FE", () => {
    const title = memberBlock(renderBandPanel(ewBand()), "RS_XLK").match(/title="([^"]*)"/)[1];
    expect(title).toContain(PROBE);
  });
});

describe("renderBandPanel - binding emphasis (plan #5)", () => {
  it("marks band.source with bp-binding and dims the rest", () => {
    const html = renderBandPanel(liveBand());
    expect(floorBlock(html, "credit")).toContain("bp-binding");
    expect(floorBlock(html, "r4")).toContain("bp-dim");
    expect(floorBlock(html, "credit")).not.toContain("bp-dim");
  });

  it("emphasises nothing when source is null (all-OK)", () => {
    const html = renderBandPanel(liveBand({ source: null }));
    expect(html).not.toContain("bp-binding");
    expect(html).not.toContain("bp-dim");
  });
});

describe("renderBandPanel - firing-only fold (plan #4)", () => {
  it("shows firing members, folds calm ones behind a +N calm affordance, r4 never folds", () => {
    const band = liveBand({
      floors: [
        {
          id: "credit",
          level: "CRITICAL",
          cap: "CRITICAL",
          members: [
            ragMember("F1", "HY OAS", "RED", "RED"),
            ragMember("F2", "IG OAS", "GREEN", "GREEN"),
            ragMember("F3", "loans", "GREEN", "GREEN"),
          ],
        },
        ...liveBand().floors.slice(1),
      ],
    });
    const html = renderBandPanel(band);
    const credit = floorBlock(html, "credit");
    expect(credit).toContain("+2 calm ▸");
    expect(credit).toContain('class="bp-calm" hidden'); // collapsed by default
    expect(memberBlock(html, "F1")).toBeTruthy(); // firing member shown
    // r4 (always-show) carries no fold button even though its single row could be calm.
    expect(floorBlock(html, "r4")).not.toContain("bp-fold");
  });
});

describe("renderBandPanel - r4 rows: inputs, note→tooltip, margin bar (plan #4/#6)", () => {
  it("keeps value vs threshold, moves the note into title=, and adds a margin bar", () => {
    const cell = memberBlock(renderBandPanel(liveBand()), "rung");
    expect(cell).toContain("<b>8</b> vs <b>8</b>"); // numbers kept (plan #6)
    // Note → tooltip (plan #4), behind the NAME segment. Addendum C-b-1: the fixture's id `rung`
    // RESTATES its label `rung`, so `idIfDistinct` drops the id and the name is just `rung` (not the
    // former `rung · rung` stutter). The fixture id has no MEMBER_DESC entry (prod emits `r4-rung`),
    // so nothing sits between the name and the note; a real r4 row prepends its description + " · ".
    expect(cell).toContain('title="rung · rung ≥ 8 to enter"');
    expect(cell).not.toContain('class="bp-note"'); // no longer an on-screen row
    expect(cell).not.toContain("bp-mstate"); // state word dropped (plan #1)
    expect(cell).toContain("bp-margin"); // fill bar present when both numbers exist
  });

  // The hover renders "short · id", never the longLabel (which still ships on the wire). Re-adding the
  // longLabel segment to memberTitle would red this.
  it("does NOT render longLabel in the hover even when the server sent one", () => {
    const band = liveBand();
    band.floors[0].members[0].longLabel = "Credit appetite (HYG/LQD)";
    const cell = memberBlock(renderBandPanel(band), "F1");
    expect(cell).toContain('title="HY OAS · F1');
    expect(cell).not.toContain("Credit appetite");
  });

  // The prod defect (2026-08-20): `style-src 'self'` (vercel.json, no 'unsafe-inline') DROPS an inline
  // style attribute, so every r4 fill inherited the track's full width and painted 100% on rows nowhere
  // near their gate. The width must therefore ride a CLASS. Both halves are owed — the class assertion
  // alone would pass a render that ALSO kept the dead attribute.
  it("carries the fill width as a data attribute, never an inline style (CSP)", () => {
    const band = liveBand();
    band.floors[1].members = [
      { id: "rung", label: "rung", state: "GREEN", cappedState: "GREEN", value: 5, threshold: 8, note: "n/a" },
    ];
    const cell = memberBlock(renderBandPanel(band), "rung");
    expect(cell).toContain('data-css-width="62.5"'); // 5/8 of the gate
    expect(cell).not.toContain("style=");
    expect(cell).not.toContain("width:");
  });

  // A value at/over its gate is the only 100% bar; anything short of the gate must render short.
  it("reaches 100 only when the value meets its gate", () => {
    expect(memberBlock(renderBandPanel(liveBand()), "rung")).toContain('data-css-width="100"'); // 8 vs 8
  });

  it("omits the margin bar when the live value is null (feed hiccup)", () => {
    const band = liveBand({
      floors: [
        liveBand().floors[0],
        {
          id: "r4",
          level: "WARNING",
          cap: "CRITICAL",
          members: [{ id: "rung", label: "rung", state: "GREEN", cappedState: "GREEN", value: null, threshold: 8, note: "n/a" }],
        },
        ...liveBand().floors.slice(2),
      ],
    });
    expect(memberBlock(renderBandPanel(band), "rung")).not.toContain("bp-margin");
  });
});

describe("renderBandPanel - live-only", () => {
  it("returns empty markup when band is absent (scenario/replay leave the host blank)", () => {
    // Absent panel ⇒ absent footnote too: the note markup below is emitted by this same
    // call, so there is no band-less state in which the footnote can survive on its own.
    expect(renderBandPanel(undefined)).toBe("");
    expect(renderBandPanel(null)).toBe("");
  });
});

// The assertions pin the DISCRIMINATING half — the position list names mechanisms that are NOT floors
// (rung window, deadband, overlay); a footnote merely repeating floor ids would say nothing.
describe("renderBandPanel - the ALERT-vs-POSITION footnote (NF-2)", () => {
  it("carries both lists, and the position list names non-floor mechanisms", () => {
    const html = renderBandPanel(liveBand());
    expect(html).toContain("move the ALERT LEVEL only");
    expect(html).toContain("Raises the alert level:");
    expect(html).toContain("Moves the position:");
    // The whole point of the second list: these four are NOT floors and appear nowhere above it.
    for (const mech of ["rung window", "re-risk deadband", "cash overlay", "concentration gate"]) {
      expect(html).toContain(mech);
    }
  });

  // Both claims are positional, not word-presence: "valuation / CAPE" is present either way — the test
  // pins WHICH clause it sits in.
  it("puts valuation / CAPE with the MEMBER WEIGHTS, not with the rung window", () => {
    const html = renderBandPanel(liveBand());
    // Scoped to the POSITION list alone — "member weights" also appears in the alert list (the
    // credit/rate floors' inputs do carry weights), so a note-wide indexOf would read that one.
    const list = html.slice(html.indexOf("Moves the position:"), html.indexOf('class="bp-note-foot"'));
    const cape = list.indexOf("valuation / CAPE");
    const rung = list.indexOf("rung window");
    const weights = list.indexOf("member weights");
    expect(cape).toBeGreaterThan(-1);
    expect(rung).toBeGreaterThan(-1);
    expect(weights).toBeGreaterThan(-1);
    // ⚠ This pin INVERTED 2026-08-20. It used to read "`MEMBER_WEIGHT.vb` is `{}` ⇒ the valuation
    // cell is always `na`; CAPE enters via computeT1Dial's severity multiplier, i.e. the rung
    // window" — both halves rotted. `MEMBER_WEIGHT.ECY` is a full row (danger-ladder.ts) since ECY
    // seated `vb` (2026-08-11 E5), and the `mEff` multiplier CAPE fed was retired (ruled O2, same
    // day): `valuation.ts` has no dial consumer. So valuation reaches the position through its
    // MEMBER WEIGHTS, and the clause must sit AFTER "member weights" — the order the engine has now.
    expect(cape).toBeGreaterThan(rung);
    expect(cape).toBeGreaterThan(weights);
  });

  it("names geo as well as r4 on the both-lists caveat, and the exogenous term in the position list", () => {
    const html = renderBandPanel(liveBand());
    const foot = html.slice(html.indexOf('class="bp-note-foot"'));
    const list = html.slice(html.indexOf("Moves the position:"), html.indexOf('class="bp-note-foot"'));
    expect(foot).toContain("r4 and geo are on both lists");
    // The mechanism that puts geo there: one confirmed oil shock adds a weighted PER-LEG danger term
    // (`legDangerShare`'s gp term, danger-share.ts) AND feeds the geo escalator floor — a real position mover.
    expect(list).toContain("exogenous danger term");
    expect(list).not.toContain("floors EVERY leg"); // the deleted uniform-overlay claim
  });

  // The `floorBlock` helper's tail slice ran to `html.length` before this footnote existed; the guard
  // is that a floor block can never contain footnote prose (else a future `.not.toContain` on the
  // last floor would scan copy that isn't in any floor).
  it("footnote prose is outside every floor block", () => {
    const html = renderBandPanel(liveBand());
    for (const id of ["credit", "r4", "geo", "rate", "ew"]) {
      expect(floorBlock(html, id)).not.toContain("Moves the position:");
    }
  });

  it("renders below the floors, not inside one", () => {
    const html = renderBandPanel(liveBand());
    expect(html.indexOf('class="bp-note"')).toBeGreaterThan(html.lastIndexOf('data-floor='));
  });

  // BOTH halves must hold: the note ships `hidden`, and the toggle's `aria-controls` matches the note's
  // id — lab.js `buildBandPanel` resolves the target by exactly that id (the button is out of flow).
  it("ships the note collapsed, behind a toggle wired to it by id", () => {
    const html = renderBandPanel(liveBand());
    const btn = html.match(/<button type="button" class="bp-note-toggle"[^>]*>/)?.[0];
    expect(btn).toBeDefined();
    expect(btn).toContain('aria-expanded="false"');
    const controls = btn.match(/aria-controls="([^"]+)"/)?.[1];
    const note = html.match(/<div class="bp-note"[^>]*>/)[0];
    expect(note).toContain(` id="${controls}"`);
    expect(note).toMatch(/\shidden[\s>]/);
    // The toggle is the panel's top-right micro-label, so it must precede the block it opens
    // (lab.html's `.lg-sectag` owns the top-LEFT corner of the same padding band).
    expect(html.indexOf("bp-note-toggle")).toBeLessThan(html.indexOf('class="bp-note"'));
  });

});

// ── The floors disclosure ([USER] 2026-08-29) ──────────────────────────────────────────────────
// The floor column and its escalation caption ship COLLAPSED. Same two-halves contract as the note:
// the body ships `hidden`, and the toggle's `aria-controls` resolves it (lab-board.js
// `buildBandPanel` resolves every aria-controls carrier by id, not as a sibling).
describe("floors disclosure", () => {
  it("ships the floors collapsed, behind a toggle wired to it by id", () => {
    const html = renderBandPanel(liveBand());
    const btn = html.match(/<button type="button" class="bp-floors-toggle"[^>]*>/)?.[0];
    expect(btn).toBeDefined();
    expect(btn).toContain('aria-expanded="false"');
    const controls = btn.match(/aria-controls="([^"]+)"/)?.[1];
    const body = html.match(/<div class="bp-floors"[^>]*>/)[0];
    expect(body).toContain(` id="${controls}"`);
    expect(body).toMatch(/\shidden[\s>]/);
    expect(html.indexOf("bp-floors-toggle")).toBeLessThan(html.indexOf('class="bp-floors"'));
  });

  // The escalation sentence is a CAPTION for the column, so it must be inside the same disclosure —
  // revealing one without the other leaves a sentence describing floors nobody can see.
  it("encloses BOTH the escalation sentence and the floor column", () => {
    const html = renderBandPanel(liveBand({ dialBand: "WATCH" }));
    const open = html.indexOf('<div class="bp-floors"');
    expect(open).toBeGreaterThan(-1);
    expect(html.indexOf("bp-chain-esc")).toBeGreaterThan(open);
    expect(html.indexOf('<div class="bp-column"')).toBeGreaterThan(open);
    // Non-vacuity: the chain strip stays OUTSIDE (it is what a collapsed panel still shows).
    expect(html.indexOf('class="bp-chain"')).toBeLessThan(open);
  });
});

// ── Class-parity guard (.claude/rules/frontend.md §A markup test proves classes are EMITTED, never STYLED or PLACED) ──
// NF-1 Stage 6.2 — the fall-shape promotion, driven THROUGH THE RENDER (never against a view
// object): the chip pair the server sends must paint on the r4 floor head, each chip with its OWN
// tone, for BOTH off-ladder phases — and the head must be untouched while the breaker is on the
// ladder. The chips come from the real producer (`fallShapeChips`), so the predicate under test is
// production's, not a mirror; only the EXPECTED classes/labels are pinned out-of-band below.
describe("the r4 floor head carries the fall-shape + confidence chips while off the ladder", () => {
  const PHASE_TONE = { equity: "GREEN", cash: "RED", reentry: "AMBER" };

  /** The 5 REACHABLE (shape, confidence) pairs (Stage 5.1's table), with the chip text + tone class
   *  each must paint. Pinned out-of-band on purpose: deriving them from `fallShapeChips` too would
   *  make the assertion tautological (testing-project.md). */
  const PAIRS = [
    { shape: "v-shaped", confidence: "measured", chips: [["V-shaped", "g"], ["measured", "s"]] },
    { shape: "bear", confidence: "measured", chips: [["bear", "a"], ["measured", "s"]] },
    { shape: "indeterminate", confidence: "conflicting", chips: [["unclear", "s"], ["AXES DISAGREE", "a"]] },
    { shape: "indeterminate", confidence: "no-fall", chips: [["unclear", "s"], ["no fall measured", "s"]] },
    { shape: "indeterminate", confidence: "dark", chips: [["unclear", "s"], ["feed dark", "s"]] },
  ];

  const headFor = (phase, shape, confidence) => {
    const band = liveBand();
    const r4 = band.floors.find((f) => f.id === "r4");
    r4.phase = phase;
    r4.phaseState = PHASE_TONE[phase];
    // The REAL server builder — including its `phase !== "equity"` predicate.
    r4.chips = fallShapeChips(phase, shape, confidence);
    const block = floorBlock(renderBandPanel(band), "r4");
    return block.slice(0, block.indexOf("</div>", block.indexOf("bp-floor-head")));
  };

  // ONE non-equity phase carries all five pairs: the phase axis is the single predicate
  // `phase !== "equity"` (fallShapeChips), so a second off-ladder phase re-runs byte-identical asserts.
  for (const { shape, confidence, chips } of PAIRS) {
    it(`cash: ${shape} · ${confidence} paints both chips with their own tone`, () => {
      const head = headFor("cash", shape, confidence);
      const [[shapeLabel, shapeCls], [confLabel, confCls]] = chips;
      expect(head).toContain(`class="bp-floor-fchip ${shapeCls}"`);
      expect(head).toContain(`>${shapeLabel}</span>`);
      expect(head).toContain(`class="bp-floor-fchip ${confCls}"`);
      expect(head).toContain(`>${confLabel}</span>`);
    });
  }

  // The head-shape invariants, hoisted once — they hold per RENDER, not per (shape, confidence) pair.
  it("head invariants: two chips, shape before confidence, phase first, level hard right, worded hover", () => {
    const head = headFor("cash", "indeterminate", "conflicting");
    // TWO chips, never one merged pill, and the shape reads before the confidence.
    expect(head.match(/bp-floor-fchip/g).length).toBe(2);
    expect(head.indexOf(">unclear</span>")).toBeLessThan(head.indexOf(">AXES DISAGREE</span>"));
    // Order invariant: phase chip → the two chips → the level chip HARD RIGHT (only
    // `.bp-floor-phase` carries margin-left:auto, so the level chip must stay last).
    expect(head.indexOf("bp-floor-phase")).toBeLessThan(head.indexOf("bp-floor-fchip"));
    expect(head.lastIndexOf("bp-floor-fchip")).toBeLessThan(head.indexOf("bp-floor-chip lvl-"));
    // Every chip states itself in WORDS on hover — a bare `unclear`/`feed dark` is the reading
    // the [USER] ruling forbids.
    expect(head).toMatch(/bp-floor-fchip [gars]" title="[^"]+"/);
  });

  // The equity arm is the single predicate `phase !== "equity"` — one pair carries all five.
  it("equity: the head is left exactly as before, whatever the pair", () => {
    const head = headFor("equity", "indeterminate", "conflicting");
    expect(head).not.toContain("bp-floor-fchip");
    // …and the pre-Stage-6 head is intact (non-vacuity: we are looking at a real r4 head).
    expect(head).toContain("phase: equity");
    expect(head).toContain('<span class="bp-floor-chip lvl-WARNING">WARNING</span>');
  });

  it("the conflict case never renders as a bare `indeterminate`", () => {
    for (const phase of ["cash", "reentry"]) {
      const head = headFor(phase, "indeterminate", "conflicting");
      expect(head).toContain("AXES DISAGREE");
      expect(head).toContain("DISAGREE - a bear is NOT excluded");
      // The bare word is never what a chip SAYS: it survives only inside the shape chip's hover
      // copy, which immediately sends the reader to the confidence chip beside it.
      expect(head).not.toContain(">indeterminate<");
      expect(head).toContain('title="fall shape: indeterminate');
    }
  });
});

// The COVERAGE floor renders like every other floor, but its rows are FAMILIES, not indicators: no
// MEMBER_DESC entry, so they fall through to the server-composed note.
describe("renderBandPanel - the coverage floor (R4)", () => {
  const covered = () =>
    liveBand({
      source: "coverage",
      floors: [
        ...liveBand().floors,
        {
          id: "coverage",
          level: "WATCH",
          cap: "WATCH",
          members: [
            {
              id: "rates",
              label: "rates",
              state: "AMBER",
              cappedState: "AMBER",
              note: "this family's GREEN verdict - computed without R6 (not reporting)",
            },
          ],
        },
      ],
    });

  it("renders the family row and takes its tooltip from the note, with no MEMBER_DESC entry", () => {
    const html = renderBandPanel(covered());
    const block = floorBlock(html, "coverage");
    expect(block).toContain('class="bp-member a"'); // AMBER under the WATCH cap
    expect(block).toContain(">rates<");
    // The seam tolerates a missing MEMBER_DESC entry: the title is name + note, nothing between.
    expect(MEMBER_DESC.rates).toBeUndefined();
    expect(memberBlock(html, "rates")).toContain(
      'title="rates · this family\'s GREEN verdict - computed without R6 (not reporting)"',
    );
    // The floor head carries its own FLOOR_DESC copy.
    expect(block).toContain("COVERAGE floor");
  });
});
