// The shared ladder view model: gridRows / gridCell / seriesNote
// and the moved lean helpers over hand fixtures + the committed leg JSONs. The md / lab renderers pin their own markup
// (src/ladder-live.test.ts, public/lab-reentry.test.js). Plain .js: a TS import takes a `.ts` specifier (frontend.md).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boxOf } from "../src/ladder-box.ts";
import { LEGS, READ_JOBS, readScope, TRANCHE_IDS as TS_TRANCHE_IDS } from "../src/ladder-live.ts";
import { injectRowTags, stripTags } from "../src/ladder-reads.test-helpers.ts";
import { blockers, boardHint, countdown, DECIDING_DAYS, decidingWeek, foldDates, otherWeek, foldLanded, landedWord, boardReading, boardText, BOX_INDICATOR, boxHoldsText, clusterRows, foldText, gridCell, gridRows, JOB_ABBR, JOB_LEGEND, jobText, labelAged, leanGroup, seriesIds, seriesNote, signsCell, TRANCHE_IDS, watchHead } from "./ladder-views.js";

const T = (indicator, job, agg, series = [indicator]) => ({ indicator, series, job, agg });
const leg = (key, tranche, tag, over = {}) => ({ key, tranche, leg: `crit ${key}`, rule: "r", gate: false, value: "1.0", verdict: "unmet", count: { got: 1, need: 5 }, live: { value: "1.1", verdict: "met" }, ...(tag && { tag }), ...over });
const CLUSTERS = [{ name: "credit", kind: "coincident", vote: true, members: [] }, { name: "vol", kind: "coincident", vote: true, members: [] }, { name: "rates", kind: "lead", vote: false, members: [] }, { name: "capex", kind: "lead", vote: false, members: [] }];
const V = (legs, families) => ({ legs, tranches: [], live: [], prov: false, regime: { set: "x" }, escalation: { tripped: 2, need: 2, hits: [], clusters: CLUSTERS, veto: [], quorum: { live: 4, n: 4, need: 3, t1Only: false }, hold: false, ...(families && { families }) } });
const HY = T("HY OAS", "level", "kOfN", ["F1"]);
const load = (id) => JSON.parse(readFileSync(new URL(`../${LEGS[id].json}`, import.meta.url), "utf8"));

describe("gridRows", () => {
  it("no tagged leg row → untagged with no rows; a partly tagged verdict skips the untagged rows", () => {
    expect(gridRows(V([leg("t1-a", "T1"), leg("t2-a", "T2")]))).toEqual({ untagged: true, rows: [] });
    expect(gridRows(V([]))).toEqual({ untagged: true, rows: [] });
    const g = gridRows(V([leg("t1-a", "T1"), leg("t2-a", "T2", HY)]));
    expect([g.untagged, g.rows.length, g.rows[0].scope]).toEqual([false, 1, ["T2"]]);
  });
  it("one row per indicator + job as readScope keys it (agg ignored), its scope = the tranches carrying rows, `·` where absent; two rows of one key in one tranche join with ·", () => {
    const legs = [leg("t2-hy", "T2", HY), leg("t3-hy", "T3", T("HY OAS", "level", "allOf", ["F1"]), { count: undefined, verdict: "met" }), leg("t1-hy", "T1", T("HY OAS", "speed", "kOfN", ["F1"]), { verdict: "na" }), leg("t2-hy2", "T2", HY, { count: { got: 4, need: 4 }, verdict: "met" })];
    const g = gridRows(V(legs));
    expect(g.rows.map((r) => [r.indicator, r.job, r.kind, r.scope, r.cells, r.first, r.open])).toEqual([
      ["HY OAS", "level", "read", ["T2", "T3"], { T1: "·", T2: "1/5 ✗ · 4/4 ✓", T3: "✓" }, true, false],
      ["HY OAS", "speed", "read", ["T1"], { T1: "1/5 –", T2: "·", T3: "·" }, false, false],
    ]);
    expect(readScope(legs).map((s) => [s.indicator, s.job, s.tranches])).toEqual(g.rows.map((r) => [r.indicator, r.job, r.scope]));
    expect(g.rows[0].series).toEqual(["F1"]);
  });
  it("a named variant gets its own row (key + `variant` carried), never merging with the shared form's row; the shared form sorts first; readScope keys it the same (in emit order)", () => {
    const legs = [leg("t1-v", "T1", { ...T("BONOS", "speed", "kOfN"), variant: "fast" }), leg("t2-s", "T2", T("BONOS", "speed", "kOfN")), leg("t3-v", "T3", { ...T("BONOS", "speed", "allOf"), variant: "fast" }, { verdict: "met" })];
    const g = gridRows(V(legs));
    expect(g.rows.map((r) => [r.job, r.variant, r.scope, r.cells])).toStrictEqual([
      ["speed", undefined, ["T2"], { T1: "·", T2: "1/5 ✗", T3: "·" }],
      ["speed", "fast", ["T1", "T3"], { T1: "1/5 ✗", T2: "·", T3: "✓" }],
    ]);
    expect("variant" in g.rows[0]).toBe(false);
    expect(readScope(legs).map((s) => [s.job, s.variant, s.tranches])).toStrictEqual([g.rows[1], g.rows[0]].map((r) => [r.job, r.variant, r.scope]));
  });
  it("a BOX_INDICATOR leg row is kind box — `h/n` off the cluster votes / clusters.length, never open; a non-box composite read is open", () => {
    const box = T(BOX_INDICATOR, "composite", "kOfN", ["F1", "F2"]);
    const fam = { name: "credit", rule: "r", value: "v", verdict: "met", signs: [] };
    const withFams = gridRows(V([leg("t2-esc", "T2", box, { gate: true }), leg("t3-esc", "T3", box, { gate: true, verdict: "met" }), leg("t1-c", "T1", T("XDEV", "composite", "kOfN"))], [fam, fam, fam]));
    expect(withFams.rows.map((r) => [r.indicator, r.kind, r.open, r.scope, r.cells])).toEqual([
      [BOX_INDICATOR, "box", false, ["T2", "T3"], { T1: "·", T2: "2/4 ✗", T3: "2/4 ✓" }],
      ["XDEV", "read", true, ["T1"], { T1: "1/5 ✗", T2: "·", T3: "·" }],
    ]);
    const clusters = [{ name: "a", vote: true, members: [] }, { name: "b", vote: false, members: [] }];
    expect(gridCell(leg("t2-esc", "T2", box), { escalation: { tripped: 9, families: [fam], clusters } }), "clustered: the footer's votes / clusters, never tripped / families").toBe("1/2 ✗");
    expect(gridCell(leg("t1-x", "T1", T("X", "level", "kOfN"), { count: undefined, verdict: "met" }), V([]))).toBe("✓");
    expect(gridCell(leg("t1-x", "T1", T("X", "regime", "allOf"), { verdict: "na" }), V([]))).toBe("–");
  });
  it("families add no Grid rows (their box + signs live on the Episode gates table); untagged legs leave the grid untagged", () => {
    const fams = [
      { name: "credit", rule: "r", value: "v", verdict: "unmet", signs: [{ sign: "credit", lean: "bear", block: true }], tag: T("HY OAS", "level", "box", ["F1"]) },
      { name: "rates", rule: "r", value: "v", verdict: "met", near: true, signs: [{ sign: "r1", lean: "neutral", block: false }, { sign: "r2", lean: "fizzle", block: false }] },
    ];
    const g = gridRows(V([leg("t1-a", "T1", T("XDEV", "speed", "kOfN"))], fams));
    expect(g.rows.map((r) => [r.indicator, r.job, r.kind, r.first, r.series, r.cells.T1, r.cells.T3])).toEqual([["XDEV", "speed", "read", true, ["XDEV"], "1/5 ✗", "·"]]);
    expect(gridRows(V([leg("t1-a", "T1")], fams))).toEqual({ untagged: true, rows: [] }); // Blockers, not the grid, is the tag-free view
  });
  it("order: indicator by first appearance, then job; `first` marks each indicator group's first row; a family sharing an indicator adds nothing", () => {
    const legs = [leg("t3-b", "T3", T("B", "level", "kOfN")), leg("t1-a", "T1", T("A", "speed", "kOfN")), leg("t2-b", "T2", T("B", "composite", "kOfN")), leg("t2-a", "T2", T("A", "level", "kOfN"))];
    const g = gridRows(V(legs, [{ name: "A", rule: "r", value: "v", verdict: "met", signs: [{ sign: "s", lean: "open", block: false }] }]));
    expect(g.rows.map((r) => `${r.indicator}/${r.job}/${r.kind}${r.first ? "*" : ""}`)).toEqual(["B/composite/read*", "B/level/read", "A/level/read*", "A/speed/read"]);
  });
  it("a tag-stripped committed leg JSON is untagged; injectRowTags makes one row per read key, none per family", () => {
    for (const id of Object.keys(LEGS)) {
      const live = load(id);
      expect(gridRows(stripTags(live).verdict), id).toEqual({ untagged: true, rows: [] });
      expect(gridRows(stripTags(injectRowTags(live)).verdict), id).toEqual({ untagged: true, rows: [] }); // stripTags really strips (the committed file is untagged today, so the line above alone cannot tell)
      const v = injectRowTags(live).verdict;
      const g = gridRows(v);
      expect(g.untagged, id).toBe(false);
      expect(g.rows.length, id).toBe(readScope(v.legs).length);
      expect(g.rows.filter((r) => r.kind === "box").length, id).toBe(1); // the three *-esc rows fold into one box row
      expect(g.rows.find((r) => r.kind === "box").scope, id).toEqual(["T1", "T2", "T3"]);
    }
  });
});

describe("cell text helpers", () => {
  it("jobText abbreviates every READ_JOBS entry, ° on the open composite; JOB_LEGEND spells them out; seriesNote lists each group's first row whose series say more than its name, \"\" without any", () => {
    const row = (over) => ({ indicator: "HY OAS", series: ["F1", "F2"], first: true, job: "level", kind: "read", open: false, scope: ["T2", "T3"], cells: {}, ...over });
    expect(Object.keys(JOB_ABBR).sort()).toEqual([...READ_JOBS].sort());
    expect([jobText(row({})), jobText(row({ job: "composite", open: true })), jobText(row({ job: "composite" })), jobText(row({ job: "recovery" }))]).toEqual(["lvl", "comp°", "comp", "rec"]);
    expect([jobText(row({ job: "speed", variant: "fast" })), jobText(row({ job: "composite", open: true, variant: "x" })), jobText(row({ job: "speed", variant: "" }))]).toEqual(["spd~fast", "comp~x°", "spd"]);
    for (const [job, abbr] of Object.entries(JOB_ABBR)) expect(JOB_LEGEND.split(`${abbr}=${job}`).length - 1, `${abbr}=${job}`).toBe(1);
    expect(JOB_LEGEND).toContain("°=open"); // the glyphs jobText emits, each spelled out
    expect(JOB_LEGEND).toContain("~name");
    expect(seriesNote({ untagged: false, rows: [row({}), row({ first: false }), row({ indicator: "XDEV", series: ["XDEV"] }), row({ indicator: "box", series: ["A", "B", "C"] }), row({ indicator: "n", series: [] })] })).toBe("series — HY OAS: F1 F2; box: A B C");
    expect([seriesIds(row({})), seriesIds(row({ first: false })), seriesIds(row({ indicator: "XDEV", series: ["XDEV"] })), seriesIds(row({ indicator: "XDEV", series: ["XDEV", "F8"] }))]).toEqual([["F1", "F2"], [], [], ["XDEV", "F8"]]);
    expect(seriesNote({ untagged: false, rows: [row({ series: [] })] })).toBe("");
    expect(TRANCHE_IDS).toEqual([...TS_TRANCHE_IDS]); // the JS mirror of src/ladder-live.ts's TRANCHE_IDS
  });
});

describe("lean helpers (moved from both renderers)", () => {
  it("leanGroup groups both skills' vocabularies, anything else → not yet; signsCell renders glyph + BLOCK, — without rows", () => {
    expect(["escalation-leaning", "bear", "open", "mixed", "neutral", "fizzle-leaning", "quiet", "unknown until 2026-10-14", undefined].map((l) => leanGroup(l))).toEqual([0, 0, 1, 1, 1, 2, 2, 3, 3]);
    expect(["unknown", "unknown until 2026-10-22", "fizzle", "unkown"].map((l) => leanGroup(l)), "bare and dated unknown both ○; off-table → ○").toEqual([3, 3, 2, 3]);
    expect(signsCell([{ sign: "hbm", lean: "fizzle", block: false }, { sign: "mu_strike", lean: "bear", block: true }])).toBe("hbm ▼ · mu_strike ▲ BLOCK");
    expect([signsCell([]), signsCell(undefined)]).toEqual(["—", "—"]);
    const fams = [{ name: "credit", rule: "r", value: "CCC 12.82/12.5 ↑", verdict: "unmet", live: { value: "CCC 12.77/12.5 ↑ est.", verdict: "unmet" }, signs: [{ sign: "credit", lean: "bear", block: false }], tag: { indicator: "HY OAS · CCC", series: ["F1", "CCC"], job: "composite", agg: "box" } }, { name: "rates", rule: "r", value: "10y 5.19/5.35", verdict: "met", near: true, live: { value: "10y 5.19/5.35", verdict: "met" }, signs: [{ sign: "credit", lean: "bear", block: false }, { sign: "rates", lean: "neutral", block: false }] }];
    const v = { escalation: { tripped: 1, need: 2, hits: [], families: fams } };
    expect(boardReading(v, "credit")).toBe("credit CCC 12.82/12.5 ↑ ✗ TRIPPED · rates 10y 5.19/5.35 ✓ near");
    expect(boardReading(v, "credit", true)).toBe("credit CCC 12.82/12.5 ↑ ✗ TRIPPED · live CCC 12.77/12.5 ↑ est. ✗ · rates 10y 5.19/5.35 ✓ near");
    expect(boardReading({ escalation: { ...v.escalation, families: [{ ...fams[1], live: { value: "10y 5.19/5.35 @10-26", verdict: "met" } }] } }, "credit", true), "a live copy of the close differing by its date stamp alone is no live reading").toBe("rates 10y 5.19/5.35 ✓ near");
    expect([boardReading(v, "nope"), boardReading({ escalation: { tripped: 0, need: 2, hits: [] } }, "credit"), boardReading(undefined, "credit")]).toEqual(["—", "—", "—"]);
    // the rendered board slot is a pointer (family → indicator), never the value; the hint drops the family names; untagged → the family name
    expect([boardText(v, "credit"), boardText(v, "rates"), boardHint(v, "credit"), boardHint(v, "nope")]).toEqual(["credit → HY OAS · CCC · rates", "rates", "HY OAS · CCC · rates", ""]);
    expect([boardText(v, "nope"), boardText(undefined, "credit")]).toEqual(["—", "—"]);
    expect(boardText(v, "credit")).not.toMatch(/12\.82|5\.19|TRIPPED/);
  });
});

describe("labelAged", () => {
  it("appends (+Nd) off checked on dated labels only when N ≥ 1; a later MM-DD is last year; undated / unchecked labels pass through", () => {
    const at = "2026-10-17";
    expect(["UNCHANGED 10-17", "UNCHANGED 10-04", "STALE 03-18", "QUIET since 09-20 bank", "HELD until 2026-10-21", "CHANGED", "UNSOURCED"].map((l) => labelAged(l, at)))
      .toEqual(["UNCHANGED 10-17", "UNCHANGED 10-04 (+13d)", "STALE 03-18 (+213d)", "QUIET since 09-20 bank (+27d)", "HELD until 2026-10-21", "CHANGED", "UNSOURCED"]);
    expect([labelAged("STALE 12-30", "2027-01-02"), labelAged("STALE 10-04", null)]).toEqual(["STALE 12-30 (+3d)", "STALE 10-04"]);
  });
});

describe("blockers + foldText", () => {
  const tr = (id, ok, need = 2) => ({ id, met: 0, total: 0, need, ok, ready: ok, filledSince: null });
  const row = (key, tranche, verdict, over = {}) => leg(key, tranche, undefined, { verdict, ...over });
  const T = (legs, families, tranches = [tr("T1", true), tr("T2", false), tr("T3", false, 3)]) => ({ ...V(legs, families), tranches, live: tranches.map((t) => ({ ...t, met: 9 })) });
  const keys = (rows) => rows.map((l) => l.key);
  it("one entry per tranche in order (T3 while T2 is unfilled), close + live + filled; rows route by the close verdict — unmet / met → passing / na → unread", () => {
    const legs = [row("t1-a", "T1", "met"), row("t2-a", "T2", "unmet"), row("t2-b", "T2", "met"), row("t2-c", "T2", "unmet"), row("t2-d", "T2", "met"), row("t2-e", "T2", "met"), row("t2-f", "T2", "na"), row("t3-a", "T3", "unmet")];
    const b = blockers(T(legs));
    expect(b.tranches.map((t) => [t.id, t.filled, t.close.id, t.live.met, keys(t.unmet), keys(t.passing), keys(t.unread)])).toEqual([
      ["T1", true, "T1", 9, [], ["t1-a"], []],
      ["T2", false, "T2", 9, ["t2-a", "t2-c"], ["t2-b", "t2-d", "t2-e"], ["t2-f"]],
      ["T3", false, "T3", 9, ["t3-a"], [], []],
    ]);
    expect(blockers({ ...T(legs), live: [] }).tranches.map((t) => t.live)).toEqual([null, null, null]);
  });
  it("a na gate is unmet under naGateHolds (the default) and unread without it; a na criterion is unread either way", () => {
    const legs = [row("t2-g", "T2", "na", { gate: true }), row("t2-c", "T2", "na")];
    const holds = blockers(T(legs)).tranches[1];
    const free = blockers(T(legs), { naGateHolds: false }).tranches[1];
    expect([keys(holds.unmet), keys(holds.unread), keys(free.unmet), keys(free.unread)]).toEqual([["t2-g"], ["t2-c"], [], ["t2-g", "t2-c"]]);
    expect([foldText(holds), foldText(free)]).toEqual(["✓ 0/0 criteria (need 2) · box: no hold (votes credit, vol) · – 1 unread", "✓ 0/0 criteria (need 2) · box: no hold (votes credit, vol) · – 2 unread"]);
  });
  describe("box: holds = hold ∨ (T2/T3 ∧ (holdT2T3 ∨ below quorum))", () => {
    const roster = [{ name: "credit", kind: "coincident", members: ["a", "b"] }, { name: "vol", kind: "coincident", members: ["c"] }, { name: "rates", kind: "lead", members: ["d"] }, { name: "capex", kind: "lead", members: ["e"] }];
    const calm = { a: false, b: false, c: false, d: false, e: false };
    const esc = (b) => ({ tripped: b.votes.length, need: 2, hits: b.votes, clusters: b.clusters, veto: b.veto, quorum: { live: b.live, n: b.n, need: b.quorum, t1Only: b.t1Only }, hold: b.hold, holdT2T3: b.holdT2T3 });
    const run = (cells, vetoes) => blockers({ ...T([]), escalation: esc(boxOf(roster, { ...calm, ...cells }, vetoes)) }).tranches.map((t) => t.box);
    it("2 coincident votes, no lead → no hold", () => {
      const boxes = run({ a: "hit", b: "hit", c: "hit" });
      expect([boxes[0].votes, boxes.map((b) => b.holds)]).toEqual([["credit", "vol"], [false, false, false]]);
      expect(foldText({ ...blockers(T([])).tranches[1], box: boxes[1] })).toBe("✓ 0/0 criteria (need 2) · box: no hold (votes credit, vol)");
    });
    it("veto, 0 votes → holds its reach: all → every tranche, T2T3 → T2·T3 only", () => {
      const boxes = run({}, [{ name: "capex_guides", reach: "all" }]);
      expect([boxes[0].votes, boxes.map((b) => b.holds)]).toEqual([[], [true, true, true]]);
      expect(boxHoldsText(boxes[0])).toBe("box holds: veto capex_guides");
      const t2t3 = run({}, [{ name: "capex_guides", reach: "T2T3" }]);
      expect([t2t3.map((b) => b.holds), boxHoldsText(t2t3[1])]).toEqual([[false, true, true], "box holds: T2·T3 · veto capex_guides"]);
      expect(boxHoldsText(run({ a: "hit", b: "hit", d: "hit" })[0])).toBe("box holds: votes credit, rates");
    });
    it("T2 below quorum → holds; T1 does not", () => {
      const boxes = run({ a: "na", b: "na", c: "na" });
      expect([boxes[0].quorum.t1Only, boxes.map((b) => b.holds)]).toEqual([true, [false, true, true]]);
      expect(boxHoldsText(boxes[1])).toBe(`box holds: below quorum — T1 only · live 2/5 need ${boxes[1].quorum.need}`);
    });
    it("clusterRows: the live cell marks off liveCell (close ✓, live ✗ HIT); a member without liveCell keeps the bare live text", () => {
      const clusters = [{ name: "credit", kind: "coincident", n: 2, live: 2, hits: 0, vote: false, members: [{ id: "a", cell: false, rule: "r", value: "4.9", live: "5.2", liveCell: "hit" }, { id: "b", cell: false, rule: "r", value: "1.0", live: "1.1" }] }];
      const rows = clusterRows({ escalation: { clusters } });
      expect(rows.map((r) => r.slice(3))).toEqual([["4.9 ✓", "5.2 ✗ HIT", "—"], ["1.0 ✓", "1.1", "—"]]);
    });
  });
  it("foldText: criteria from the row lists (na excluded), the gates / box / unread segments only when non-zero / present", () => {
    const legs = [row("t2-a", "T2", "unmet"), row("t2-b", "T2", "met"), row("t2-c", "T2", "met"), row("t2-g", "T2", "met", { gate: true }), row("t2-h", "T2", "unmet", { gate: true }), row("t2-n", "T2", "na")];
    expect(foldText(blockers(T(legs)).tranches[1])).toBe("✓ 2/3 criteria (need 2) · ✓ 1 gates · box: no hold (votes credit, vol) · – 1 unread");
    expect(foldText(blockers({ ...T(legs), escalation: undefined }).tranches[1])).toBe("✓ 2/3 criteria (need 2) · ✓ 1 gates · – 1 unread"); // no box at all
    const noBox = (legs) => ({ ...T(legs), escalation: undefined });
    expect(foldText(blockers(noBox([row("t2-a", "T2", "unmet"), row("t2-b", "T2", "met")])).tranches[1])).toBe("✓ 1/2 criteria (need 2)"); // zero gate rows
    expect(foldText(blockers(noBox([row("t2-a", "T2", "met"), row("t2-h", "T2", "unmet", { gate: true })])).tranches[1])).toBe("✓ 1/1 criteria (need 2)"); // an unmet gate adds no gates segment
  });
  it("on every committed leg JSON the fold's criteria counts equal LadderTranche.met/total (na excluded on both sides), and Blockers needs no tags", () => {
    for (const id of Object.keys(LEGS)) {
      const v = load(id).verdict;
      const b = blockers(v, { naGateHolds: LEGS[id].naGateHolds });
      expect(b.tranches.map((t) => t.id), id).toEqual(["T1", "T2", "T3"]);
      for (const t of b.tranches) {
        const crit = (rows) => rows.filter((l) => !l.gate).length;
        expect([crit(t.passing), crit(t.passing) + crit(t.unmet)], `${id} ${t.id}`).toEqual([t.close.met, t.close.total]);
        expect(foldText(t), `${id} ${t.id}`).toContain(`✓ ${t.close.met}/${t.close.total} criteria (need ${t.close.need})`);
      }
      // stripTags on the left: a committed JSON tagged by its leg's `--into` run must not flip this to a tag-vs-tag diff
      expect(JSON.stringify(blockers(stripTags(load(id)).verdict, { naGateHolds: LEGS[id].naGateHolds })), id).toBe(JSON.stringify(blockers(injectRowTags(load(id)).verdict, { naGateHolds: LEGS[id].naGateHolds })).replace(/,"tag":\{[^}]*\}/g, ""));
    }
  });
});

describe("watchHead", () => {
  const w = (over) => ({ held: true, grade: "HIGH", rows: [], correction: boxOf([], {}), bear: boxOf([], {}), ...over });
  it("a held HIGH names why — latched, stretched, lifted, each only when set; an unheld grade is bare", () => {
    const grade = (over) => watchHead({ watch: w(over) }).split(" · no drawdown open")[0];
    expect([grade({ latched: "2026-10-26" }), grade({ stretched: "2026-10-05" }), grade({ lifted: ["hy", "vxsmh"] }), grade({ latched: "2026-10-26", stretched: "2026-10-05", lifted: [] }), grade({})]).toEqual(["HIGH (latched from 10-26)", "HIGH (stretched from 10-05)", "HIGH (lifted by hy, vxsmh)", "HIGH (latched from 10-26 · stretched from 10-05)", "HIGH"]);
  });
});

describe("decidingWeek", () => {
  it("lists unlanded ★ events (NOT DUE / DELAY) up to DECIDING_DAYS past the run, overdue and same-day kept, unverified est. dates ~-marked (title or dateNote), soonest first; ☆, landed and later events drop; none when empty", () => {
    const ev = (date, event, holds = ["T2", "T3"], status = "NOT DUE until x") => ({ date, event, holds, status, signs: [] });
    const edge = new Date(Date.parse("2026-10-25") + DECIDING_DAYS * 864e5).toISOString().slice(0, 10);
    const late = new Date(Date.parse(edge) + 864e5).toISOString().slice(0, 10);
    const live = { run: "2026-10-25", events: [ev(edge, "Edge Q3 (est.)"), ev("2026-10-28", "FOMC", []), ev("2026-10-27", "Lam Q1", ["T3"], "fizzle: beat"), ev(late, "Late Q3"), ev("2026-10-24", "Owed Q3", ["T2", "T3"], "DELAY — outcome unsourced"), ev("2026-10-25", "Today Q3 (est.)", ["T3"], "DELAY — outcome unsourced"), ev("2026-10-28", "MSFT Q3"), { ...ev("2026-10-26", "Note Q3"), dateNote: "est." }, { ...ev("2026-10-27", "Firm Q3 (est.)"), verified: true }] };
    expect([decidingWeek(live), decidingWeek({ run: "2026-10-25", events: [ev(late, "Late Q3")] })]).toEqual([
      `★ 10-24 Owed Q3 (1d ago, holds T2+T3) · ★ 10-25~ Today Q3 (today, holds T3) · ★ 10-26~ Note Q3 (1d, holds T2+T3) · ★ 10-27 Firm Q3 (2d, holds T2+T3) · ★ 10-28 MSFT Q3 (3d, holds T2+T3) · ★ ${edge.slice(5)}~ Edge Q3 (${countdown("2026-10-25", edge)}, holds T2+T3)`,
      "none",
    ]);
  });
  it("otherWeek lists unlanded ☆ events from today to DECIDING_DAYS ahead, soonest first, no holds suffix; ★, landed, overdue and later events drop; none when empty", () => {
    const ev = (date, event, holds = [], status = "NOT DUE until x") => ({ date, event, holds, status, signs: [] });
    const edge = new Date(Date.parse("2026-10-25") + DECIDING_DAYS * 864e5).toISOString().slice(0, 10);
    const late = new Date(Date.parse(edge) + 864e5).toISOString().slice(0, 10);
    const live = { run: "2026-10-25", events: [ev(edge, "Edge CPI (est.)"), ev("2026-10-28", "FOMC"), ev("2026-10-27", "MSFT Q3", ["T2"]), ev("2026-10-26", "ECB", [], "fizzle: held"), ev(late, "Late PMI"), ev("2026-10-24", "Past GDP", [], "outcome unsourced"), ev("2026-10-25", "Today ISM", undefined)] };
    expect([otherWeek(live), otherWeek({ run: "2026-10-25", events: [ev(late, "Late PMI")] })]).toEqual([
      `☆ 10-25 Today ISM (today) · ☆ 10-28 FOMC (3d) · ☆ ${edge.slice(5)}~ Edge CPI (${countdown("2026-10-25", edge)})`,
      "none",
    ]);
  });
});

describe("landedWord / foldLanded — a sign row's settled events take one chip", () => {
  it("landedWord: the three outcome prefixes and DELAY; a pending or non-holding owed status reads empty (the chip falls back to its countdown)", () => {
    expect(["fizzle: x", "mixed: y", "escalation: z", "DELAY — outcome unsourced", "outcome unsourced · pre 10-31", "NOT DUE until 2026-11-18", undefined].map(landedWord)).toEqual(["fizzle", "mixed", "escalation", "DELAY", "", "", ""]);
  });
  it("2+ fizzle chips fold into one at the first one's slot; mixed, escalation, DELAY and pending chips keep their own; one fizzle stays unfolded", () => {
    const c = (date, landed, text = `ev ${date}`) => ({ date, event: true, mark: "★", text, detail: [], landed });
    const [a, b, d, e, f, g] = [c("2026-10-15", "fizzle"), c("2026-10-20", "escalation"), c("2026-10-21", "mixed"), c("2026-10-22", "DELAY"), c("2026-10-23", "fizzle"), c("2026-11-18", "")];
    const out = foldLanded([a, b, d, e, f, g]);
    expect(out.slice(1)).toEqual([b, d, e, g]);
    expect(out[0]).toMatchObject({ date: "2026-10-15", fold: "2 fizzled", detail: ["★ 10-15 ev 2026-10-15", "★ 10-23 ev 2026-10-23"] });
    expect(foldLanded([a, b, d, g])).toEqual([a, b, d, g]);
    // a fizzle dated after the run never becomes the row's next chip (signRows: first chip dated ≥ run) — the pending 11-04 one stays next
    const owed = c("2026-11-04", "DELAY");
    expect(foldLanded([a, owed, c("2026-11-06", "fizzle")]).find((x) => x.date >= "2026-11-03")).toBe(owed);
  });
});
describe("foldDates", () => {
  it("an old mixed landing stays shown even when it holds no tranche; an old fizzle folds", () => {
    const run = "2026-11-13";
    const item = (landed, on) => ({ event: true, landed, on, date: on, text: `${landed} print (x)`, holding: false });
    const { shown, history } = foldDates(run, [item("mixed", "2026-10-01"), item("fizzle", "2026-10-02")]);
    expect(shown.map((i) => i.landed)).toEqual(["mixed"]);
    expect(history.text).toBe("history: 1 settled (1 fizzle) · last 10-02 fizzle print fizzle");
  });
});
