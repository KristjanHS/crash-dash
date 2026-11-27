import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dpApart, dpCell, duplicateReads, familyRow, findingAge, fixNum, gatesText, HELD_NOTE, isReadTag, legOf, LEGS, mmdd, peakLow, renderLadderMd, runTime, SITUATION_SLOTS, speedCell, vs, type LadderLegId, type LadderLive, type LadderTranche, type ReadTag } from "./ladder-live.js";
import { ladderTz } from "./config.js";
import { boxOf } from "./ladder-box.js";
import { injectRowTags, injectWatch } from "./ladder-reads.test-helpers.js";
import { applyEvents } from "./ladder-run.js";

const eufinMd = (l: LadderLive): string => renderLadderMd(l, "eufin");
const tr = (id: LadderTranche["id"], ok: boolean, filledSince: string | null = null, via?: "time stop"): LadderTranche => ({ id, met: ok ? 4 : 1, total: 5, need: 4, ok, ready: ok, ...(via && { via }), filledSince });
const lg = (key: string, tranche: "T1" | "T2" | "T3") => ({ key, tranche, gate: false, leg: `crit ${key}`, rule: `rule ${key}`, value: `close ${key}`, verdict: "unmet" as const, count: { got: 1, need: 5 }, live: { value: `live ${key}`, verdict: "met" as const, count: { got: 5, need: 5 } } });
const runs = Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-${String(7 - i).padStart(2, "0")}`, t1: "4/5", t2: "2/7", t3: "2/6", live: "prov." }));
const LIVE: LadderLive = {
  run: "2026-10-07",
  verdict: {
    tranches: [tr("T1", true, "2026-10-06"), { ...tr("T2", false), gates: ["met", "unmet", "na"] }, tr("T3", false)],
    live: [tr("T1", true, "2026-10-06", "time stop"), tr("T2", false), tr("T3", false)],
    prov: true,
    regime: { set: "fast", exshVsMa200: 0.0512 },
    legs: [lg("t1-a", "T1"), lg("t1-b", "T1"), lg("t2-a", "T2"), { ...lg("t2-g", "T2"), gate: true, leg: "gate: crit t2-g" }, { ...lg("t2-v", "T2"), gate: true, leg: "veto t2-v" }, lg("t3-a", "T3")],
    escalation: { tripped: 3, need: 2, hits: ["BUND z ≥ 1.5", "BONOS z ≥ 1.5"] },
    sessionsSinceExit: 4,
  } as LadderLive["verdict"],
  signs: [
    { sign: "ECB stance", label: "CHANGED", lean: "open", finding: "hold, 10-06", why: "rates path", measurable: "yes (OIS)", block: false, checked: "2026-10-07", due: "2026-10-07", primary: ["https://ecb.europa.eu/rss"], search: ["ECB hike", "BCE hausse"], seed: [], sources: [{ date: "2026-10-06", url: "https://ecb.europa.eu/x" }] },
    { sign: "AT1 calls", label: "STALE 2026-09-30", lean: "escalation-leaning", finding: "two skipped, 09-30", why: "funding", measurable: "", block: true, checked: null, due: null, primary: [], search: [], seed: [], sources: [] },
  ],
  rules: ["g", "c", "e"],
  situation: { lean: "n", slow: "b", fast: "c!", decides: "w", flips: "z" },
  events: [
    { date: "2026-10-30", event: "ECB meeting", signs: [], escalationIf: "hike", fizzleIf: "pause", holds: [], secondary: true, status: "NOT DUE until 2026-10-30" },
    { date: "2026-10-23", event: "Moody's", signs: ["ECB stance"], escalationIf: "A1", fizzleIf: "affirmed", holds: ["T2", "T3"], secondary: false, status: "NOT DUE until 2026-10-23" },
  ],
  calendar: [
    { date: "2026-11-05", sign: "ECB stance", event: "BoE", matters: "UK rates", verified: false },
    { date: "2026-10-01", sign: "ECB stance", event: "debate", matters: "—", verified: true },
    { date: "2026-10-07", sign: "ECB stance", event: "vote", matters: "—", verified: true },
  ],
  runs,
};
const FAMILIES: NonNullable<LadderLive["verdict"]>["escalation"]["families"] = [
  { name: "credit", rule: "HY ≥ 6.00", value: "CCC 12.52/12 ↑", verdict: "unmet", live: { value: "CCC 12.52/12 ↑ est.", verdict: "unmet" }, signs: [{ sign: "credit", lean: "bear", block: false }] },
  { name: "rates", rule: "10y ≥ 5.35", value: "10y 5.22/5.35", verdict: "met", near: true, live: { value: "10y 5.19/5.35", verdict: "met" }, signs: [{ sign: "rates", lean: "neutral", block: false }] },
  { name: "Micron", rule: "DRAM ≤ −10%", value: "DRAM +0.0%/-10.0%", verdict: "unmet", signs: [{ sign: "hbm", lean: "fizzle", block: false }, { sign: "mu_strike", lean: "bear", block: true }] },
  { name: "banks", rule: "KBE ≤ −8% ×20", value: "KBE -3.1%/-8.0%", verdict: "met", signs: [] },
  { name: "capex", rule: "sign block only", value: "—", verdict: "na", signs: [{ sign: "capex", lean: "unknown", block: false }] },
];
const ROSTER = [{ name: "credit", kind: "coincident", members: ["F1", "CCC"] }, { name: "vol", kind: "coincident", members: ["VT"] }, { name: "rates", kind: "lead", members: ["R2", "R4"] }] as const;
const BOX = boxOf(ROSTER, { F1: "hit", CCC: "hit", VT: "na", R2: false, R4: "none" });
const DISP: Record<string, { rule?: string; value?: string; live?: string }> = { F1: { rule: "HY ≥ 6.00", value: "6.12/6.00", live: "6.20/6.00" }, CCC: { rule: "CCC ≥ 12", value: "12.5/12" }, R2: { rule: "10y ≥ 5.35", value: "5.22/5.35" } };
const CLUSTERED = { tripped: BOX.votes.length, need: 2, hits: BOX.votes, unread: ["vol (VT)"], families: FAMILIES, clusters: BOX.clusters.map((c) => ({ ...c, members: c.members.map((m) => ({ ...m, ...DISP[m.id] })) })), veto: BOX.veto, quorum: { live: BOX.live, n: BOX.n, need: BOX.quorum, t1Only: BOX.t1Only }, hold: BOX.hold };
const CLUSTER_HEAD = "Episode gates (hold on 1 coincident + 1 lead cluster vote, or a veto)";
const section = (md: string, head: string): string => md.slice(md.indexOf(`## ${head}`) + 3).split("\n## ")[0]!;
const rows = (md: string, head: string): string[] => section(md, head).split("\n").filter((l) => l.startsWith("|")).slice(2);
const cells = (l: string): number => l.split("|").length - 2;

describe("value-cell numbers the four probes share", () => {
  it("a value and its expected widen together until they print apart; a true tie or a missing side stays at d", () => {
    expect([dpApart(3.231, 3.234), dpApart(3.2, 3.2), vs(3.231, 3.234), vs(0.76, 1), vs(null, 1.5), vs(2.5, Infinity, 1)]).toEqual([3, 2, ["3.231", "3.234"], ["0.76", "1.00"], ["—", "1.50"], ["2.5", "—"]]);
  });
  it("a negative zero rendering ties with 0.00 and keeps widening; no cell ever prints -0.00", () => {
    expect([vs(-0.004, 0), dpApart(-0.004, 0), vs(-0.001, 0.001), vs(-1e-10, 0), fixNum(-0.0001)]).toEqual([["-0.004", "0.000"], 3, ["-0.001", "0.001"], ["0.00", "0.00"], "0.00"]);
  });
  it("one width per cell: the widest pair sets every number's decimals; a pair with an absent side is skipped", () => {
    expect([dpCell([[60.604, 58], [60.604, 60.601]]), dpCell([[60.604, 58]]), dpCell([[1, null], [1, 1.5]]), dpCell([[2.5, Infinity]], 1)]).toEqual([3, 2, 2, 1]);
  });
  it("speed row: Δ, 0 and the max share one width (a -0.00 Δ widens), the max carries its MM-DD; an absent max stays at 2", () => {
    expect([speedCell({ d: -0.004, max: 0.12, maxDate: "2026-10-02" }), speedCell({ d: 0.1201, max: 0.1204, maxDate: "2026-10-02" }), speedCell({ d: 0.05, max: -Infinity, maxDate: null })]).toEqual(["-0.004 ≤0✓ <max 0.120 10-02✓", "0.1201 ≤0✗ <max 0.1204 10-02✓", "0.05 ≤0✗ <max —✗"]);
  });
  it("dates drop the year; a retrace source dates its peak and prints an undated floor bare", () => {
    expect([mmdd("2026-07-29"), fixNum(Number.NaN), peakLow({ value: 3.6, date: "2026-10-02" }, { value: 2.8, date: "2026-09-01" }), peakLow({ value: 140, date: "2026-10-12" }, { value: 83 }, "base")]).toEqual(["07-29", "—", "(peak 3.60 10-02 low 2.80 09-01)", "(peak 140.00 10-12 base 83.00)"]);
  });
});

describe("renderLadderMd (eufin)", () => {
  it("renders the five sections in contract order, a null gap as —, and the live header with the prov. mark", () => {
    const md = eufinMd(LIVE);
    const heads = md.split("\n").filter((l) => l.startsWith("## "));
    expect(heads).toEqual(["## Verdict", "## Blockers", "## Grid", "## Signs & deciding events"]);
    expect(md).not.toContain("## Read");
    // one board: the five situation slots, the rules fold, tally + legend, then lean group → soonest chip → signs[] order (AT1 calls leans escalation, so it leads despite JSON order); an event naming no sign keeps its own last row
    // each situation slot is its own paragraph (a blank line between), so markdown never runs them together
    expect(md).toContain("## Signs & deciding events\n\n**Lean** — n\n\n**Slow threat** — b\n\n**Fast threat** — c!\n\n**What decides it** — w\n\n**What flips the lean** — z\n\n<details><summary>Rules (user-set)</summary>\n\n- g\n- c\n- e\n\n</details>\n\n_▲1 escalation · ◆1 open/mixed · ▼0 fizzle/quiet · ○0 not yet — ★ deciding");
    expect(rows(md, "Signs & deciding events")).toEqual([
      "| ▲ escalation-leaning · **BLOCK** | AT1 calls | two skipped, 09-30 | — | — |",
      // the run-day calendar row precedes the next event → both chips; the 11-05 row (after it) and the past 10-01 row are not chips
      "| ◆ open | ECB stance | hold, 10-06 | — | • 10-07 today · ★ 10-23 16d |",
      "| · | ECB meeting (secondary) | event, no sign row | — | ☆ 10-30 23d |",
    ]);
    // the board column + detail line print the family → indicator POINTER for a row a family names — never the value (the board grid is its only home)
    const fam = { name: "credit", rule: "r", value: "CCC 12.82/12.5 ↑", verdict: "unmet" as const, live: { value: "CCC 12.77/12.5 ↑ est.", verdict: "unmet" as const }, signs: [{ sign: "ECB stance", lean: "open", block: false }], tag: { indicator: "HY OAS · CCC", series: ["F1", "CCC"], job: "composite" as const, agg: "box" as const } };
    const boarded = eufinMd({ ...LIVE, verdict: { ...LIVE.verdict!, escalation: { ...LIVE.verdict!.escalation, families: [fam] } } });
    expect(boarded).toContain("| ◆ open | ECB stance | hold, 10-06 | credit → HY OAS · CCC | • 10-07 today · ★ 10-23 16d |");
    expect(boarded).toContain("- why: rates path (measurable: yes (OIS))\n- board: credit → HY OAS · CCC\n- dates:");
    expect(boarded.slice(boarded.indexOf("## Signs"))).not.toMatch(/12\.82|12\.77|TRIPPED/); // the value lives in Episode gates only
    // each row's detail follows in board order, every dated item carrying its event sides
    expect(md).toContain("**AT1 calls** — STALE 2026-09-30\n- why: funding (measurable: —)\n- board: —\n- dates: —\n- sources: —\n\n**ECB stance**");
    expect(md).toContain(
      "**ECB stance** — CHANGED · checked 2026-10-07 · due 2026-10-07\n- why: rates path (measurable: yes (OIS))\n- board: —\n- dates:\n  - • 2026-10-01 debate\n  - • 2026-10-07 vote\n  - ★ 2026-10-23 Moody's — holds T2+T3 · escalation if: A1 · fizzle if: affirmed · status: NOT DUE until 2026-10-23\n  - ~ 2026-11-05 BoE — matters: UK rates · date unverified\n- sources: 2026-10-06 https://ecb.europa.eu/x\n",
    );
    expect(md).toContain("**ECB meeting (secondary)** — event, no sign row\n- dates:\n  - ☆ 2026-10-30 ECB meeting (secondary) — holds no tranche · escalation if: hike · fizzle if: pause · status: NOT DUE until 2026-10-30\n");
    // without the run-day row the next calendar row (11-05) trails the 10-23 event → the event is the only chip
    expect(eufinMd({ ...LIVE, calendar: LIVE.calendar.filter((c) => c.date !== "2026-10-07") })).toContain("| hold, 10-06 | — | ★ 10-23 16d |");
    // a landed event shows its outcome word instead of a countdown; a chip-less row inside its research hold shows the hold
    const landed = eufinMd({ ...LIVE, events: [{ ...LIVE.events[1]!, date: "2026-10-05", status: "escalation: cut to A1, 10-05" }], signs: [LIVE.signs[0]!, { ...LIVE.signs[1]!, due: "2026-10-14" }] });
    expect(landed).toContain("| ★ 10-05 escalation · • 10-07 today |");
    // 2+ fizzles fold into one `N fizzled` chip, a mixed event keeps its own; the dates list keeps each (foldLanded, public/ladder-views.js)
    const settled = (date: string, status: string) => ({ ...LIVE.events[1]!, date, status });
    const folded = eufinMd({ ...LIVE, events: [settled("2026-10-03", "fizzle: affirmed, 10-03"), settled("2026-10-04", "fizzle: affirmed, 10-04"), settled("2026-10-05", "mixed: outlook cut, 10-05")] });
    expect(folded).toContain("| 2 fizzled · ★ 10-05 mixed · • 10-07 today |");
    // a settled (fizzle / escalation) event's dates line drops its conditions; a mixed one keeps them (a clause is still owed — conditionsOwed)
    expect(folded).toContain("  - ★ 2026-10-04 Moody's — holds T2+T3 · status: fizzle: affirmed, 10-04\n");
    expect(folded).toContain("  - ★ 2026-10-05 Moody's — holds T2+T3 · escalation if: A1 · fizzle if: affirmed · status: mixed: outlook cut, 10-05\n");
    expect(landed).toContain("| two skipped, 09-30 | — | held → 10-14 |");
    // an event's stored sources join its detail line (mirrored by eventItem in public/lab-reentry.js); none → no segment
    expect(eufinMd({ ...LIVE, events: [{ ...LIVE.events[1]!, sources: [{ date: "2026-10-08", url: "https://a.org/x" }, { date: "2026-10-08", url: "https://b.org/y" }] }] })).toContain("status: NOT DUE until 2026-10-23 · sources: 2026-10-08 https://a.org/x, 2026-10-08 https://b.org/y\n");
    expect(eufinMd(LIVE)).not.toContain("sources: 2026-10-08");
    // a dated label carries its age off `checked` (labelAged, [USER 2026-10-17])
    expect(eufinMd({ ...LIVE, signs: LIVE.signs.map((s) => (s.sign === "AT1 calls" ? { ...s, label: "UNCHANGED 09-30", checked: "2026-10-07" } : s)) })).toContain("**AT1 calls** — UNCHANGED 09-30 (+7d) · checked 2026-10-07");
    // a user-set base prints under measurable; unset → no line
    expect(eufinMd({ ...LIVE, signs: LIVE.signs.map((s) => (s.sign === "AT1 calls" ? { ...s, base: "2 of 3 skips preceded a sell-off" } : s)) })).toContain("- why: funding (measurable: —)\n- base: 2 of 3 skips preceded a sell-off\n- board:");
    expect(md).not.toContain("- base:");
    expect(md).toMatch(/^# .*\n\nrun 2026-10-07/);
    expect(md).toContain("| live (prov.) |");
    expect(md).toContain("+5.1% vs MA200");
    expect(md).toContain("| T1 | ✓: 4/5 need 4 | ✓: 4/5 need 4 (time stop) |");
    expect(md, "the pages never show a fill").not.toMatch(/· (filled|ready since) [0-9]/);
    expect(md).toContain("| T2 | ✗: 1/5 need 4 · gates ✓✗– | ✗: 1/5 need 4 |");
    expect(gatesText(["met", "bogus" as never])).toBe(" · gates ✓–");
    const off = eufinMd({ ...LIVE, verdict: { ...LIVE.verdict!, prov: false, regime: { set: "strict", exshVsMa200: null } } });
    expect(off).toContain("| live |");
    expect(off).not.toContain("(prov.)");
    expect(off).toContain("— vs MA200");
  });
  it("asOf dates the close + live heads of the tranche, criteria and gate tables (` est.` only on an estimate live head); none → today's bare heads", () => {
    const at = (est: boolean, prov = true) => eufinMd({ ...LIVE, verdict: { ...LIVE.verdict!, prov, asOf: { close: "2026-10-08", live: "2026-10-09", est } } });
    expect(at(true)).toContain("| tranche | close · Thu 10-08 | live (prov.) · Fri 10-09 est. |");
    expect(at(true).split("| criterion | expected | close · Thu 10-08 | live · Fri 10-09 est. |").length - 1).toBe(3);
    expect(at(true)).toContain("| gate (all must pass) | expected | close · Thu 10-08 | live · Fri 10-09 est. |");
    expect(at(false, false)).toContain("| tranche | close · Thu 10-08 | live · Fri 10-09 |");
    expect(at(false, false)).not.toContain("est.");
    const bare = eufinMd(LIVE);
    expect(bare).toContain("| tranche | close | live (prov.) |");
    expect(bare.split("| criterion | expected | close | live |").length - 1).toBe(3);
    expect(bare).toContain("| gate (all must pass) | expected | close | live |");
  });
  it("the EXSH line is the EU-Fin regime's; a verdict without it (Value) renders the set alone, and its display read when present", () => {
    const value = renderLadderMd({ ...LIVE, verdict: { ...LIVE.verdict!, regime: { set: "entry" }, display: { maN: 50, vsMa: -0.0213, zoneSince: "2026-10-01" } } }, "value");
    expect(value).toContain("\nregime: **entry** set\n\ndisplay: -2.1% vs MA50 — never a gate · zone open since 2026-10-01\n");
    expect(value).not.toContain("MA200");
    expect(renderLadderMd({ ...LIVE, verdict: { ...LIVE.verdict!, regime: { set: "entry" }, display: { maN: 50, vsMa: null, zoneSince: null } } }, "value")).toContain("\ndisplay: — vs MA50 — never a gate\n");
    expect(eufinMd(LIVE)).not.toContain("display:");
  });
  it("every table row has at most 5 cells outside the Grid and the cluster table, exactly 5 inside the Grid and 6 in the cluster table; 7 runs render as the newest 5, inside Verdict", () => {
    const md = eufinMd(LIVE);
    const withClusters = renderLadderMd(injectRowTags({ ...LIVE, verdict: { ...LIVE.verdict!, escalation: CLUSTERED } }), "value");
    const grid = section(withClusters, "Grid");
    const clusterTable = section(withClusters, CLUSTER_HEAD).split("\n\n")[1]!;
    const outside = [...md.split("\n"), ...withClusters.replace(`## ${grid}`, "").replace(clusterTable, "").split("\n")].filter((l) => l.startsWith("|"));
    const inside = grid.split("\n").filter((l) => l.startsWith("|"));
    const clusterRows = clusterTable.split("\n").filter((l) => l.startsWith("|"));
    expect([outside.length > 10, inside.length > 2, clusterRows.length > 2]).toEqual([true, true, true]);
    for (const l of outside) expect(cells(l)).toBeLessThanOrEqual(5);
    for (const l of inside) expect(cells(l)).toBe(5);
    for (const l of clusterRows) expect(cells(l)).toBe(6);
    const last = section(md, "Verdict").split("_last 5 runs_")[1]!.split("\n").filter((l) => l.startsWith("|")).slice(2);
    expect(last.length).toBe(5);
    expect(last.map((l) => l.split("|")[1]!.trim())).toEqual(runs.slice(0, 5).map((r) => r.date));
  });
  it("Grid: one closed <details> after the runs and before Episode gates, a 5-column table with one row per read key spanning its tranches (`·` where absent), jobs abbreviated with ° only on a non-box composite, the esc rows as `h/n`, no family rows; then the series footnote and the job legend", () => {
    const legs = [...LIVE.verdict!.legs, { ...lg("t2-esc", "T2"), gate: true, leg: "gate: escalation box" }, { ...lg("t3-esc", "T3"), gate: true, leg: "gate: escalation box" }];
    const tagged = injectRowTags({ ...LIVE, verdict: { ...LIVE.verdict!, legs, escalation: CLUSTERED } });
    tagged.verdict!.legs[0]!.tag = { ...tagged.verdict!.legs[0]!.tag!, job: "composite", series: ["A1", "A2"] }; // t1-a → the one non-box composite read, and the one group whose ids say more than its name
    const md = renderLadderMd(tagged, "value");
    expect(md).toContain("\n\n## Grid\n\n<details><summary>Grid — one row per indicator × job</summary>\n\n| indicator | job | T1 | T2 | T3 |\n|---|---|---|---|---|\n| a | comp° |");
    expect([md.indexOf("_last 5 runs_") < md.indexOf("## Grid"), md.indexOf("## Grid") < md.indexOf("## Episode gates")]).toEqual([true, true]);
    expect(section(md, "Grid")).not.toMatch(/<details[^>]* open/);
    expect(rows(md, "Grid")).toEqual([
      "| a | comp° | 1/5 ✗ | · | · |",
      "| a | lvl | · | 1/5 ✗ | 1/5 ✗ |",
      "| b | lvl | 1/5 ✗ | · | · |",
      "| g | reg | · | ✗ | · |",
      "| v | reg | · | ✗ | · |",
      "| escalation box | comp | · | 1/3 ✗ | 1/3 ✗ |",
    ]);
    expect(section(md, "Grid")).toContain("\n\n_series — a: A1 A2_\n\n_jobs — comp=composite (°=open) · rec=recovery · reg=regime · spd=speed · lvl=level · rel=relative · man=manual · ~name = named variant of the job’s shared form_\n\n</details>");
    expect(rows(md, "Grid").join("").split("°").length - 1).toBe(1); // the legend carries the other °
  });
  it("Blockers: one open <details> between Verdict and Grid; a filled tranche is its head line only; an unfilled one lists exactly its unmet rows, then a closed fold of the passing + unread rows; T3 renders while T2 is unfilled; a na gate reads – and is unmet only under the leg's naGateHolds; the box line is inline when it holds", () => {
    const met = (key: string, tranche: "T1" | "T2" | "T3", gate = false) => ({ ...lg(key, tranche), gate, verdict: "met" as const, count: { got: 5, need: 5 }, ...(gate && { leg: `gate: crit ${key}` }) });
    const legs = [lg("t1-a", "T1"), met("t2-a", "T2"), lg("t2-b", "T2"), met("t2-c", "T2"), lg("t2-d", "T2"), met("t2-e", "T2"), met("t2-g", "T2", true), { ...lg("t2-n", "T2"), gate: true, leg: "gate: crit t2-n", verdict: "na" as const, count: undefined, value: "n/a" }, lg("t3-a", "T3"), met("t3-b", "T3")];
    const live = (escalation: typeof CLUSTERED, leg: "value" | "eufin" = "value") => renderLadderMd({ ...LIVE, verdict: { ...LIVE.verdict!, legs, escalation } }, leg);
    const md = live(CLUSTERED);
    expect([md.indexOf("## Verdict") < md.indexOf("## Blockers"), md.indexOf("## Blockers") < md.indexOf("## Grid")]).toEqual([true, true]);
    const b = section(md, "Blockers");
    expect(b.startsWith("Blockers\n\n<details open><summary>Blockers — T1 · T2 · T3</summary>\n\n**T1** ✓: 4/5 need 4 · live ✓: 4/5 need 4 (time stop)\n\n**T2** ✗: 1/5 need 4 · gates ✓✗– · live ✗: 1/5 need 4\n- crit t2-b — close t2-b ✗ 1/5 · live live t2-b ✓ 5/5\n- crit t2-d — close t2-d ✗ 1/5 · live live t2-d ✓ 5/5\n- gate: crit t2-n — n/a – · live live t2-n ✓ 5/5\n\n<details><summary>✓ 3/5 criteria (need 4) · ✓ 1 gates · box: no hold (votes credit)</summary>\n\n- crit t2-a — close t2-a ✓ 5/5 · live live t2-a ✓ 5/5\n- crit t2-c —")).toBe(true);
    const [t1, t2, t3] = b.split(/^\*\*T[123]\*\*/m).slice(1) as [string, string, string];
    expect(t1.split("\n").filter((l) => l.startsWith("- ")).length, "a filled tranche is one line").toBe(0);
    expect(t2.split("\n").filter((l) => /^- crit t2-[bd] /.test(l) || /^- gate: crit t2-n /.test(l)).length).toBe(3);
    expect(t2.split("</summary>")[1]!.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).split(" — ")[0]), "the fold holds the passing rows").toEqual(["crit t2-a", "crit t2-c", "crit t2-e", "gate: crit t2-g"]);
    expect(t2.indexOf("- crit t2-a"), "passing rows only inside the fold").toBeGreaterThan(t2.indexOf("<details><summary>"));
    expect(t3).toContain("✗: 1/5 need 4 · live ✗: 1/5 need 4\n- crit t3-a — close t3-a ✗ 1/5 · live live t3-a ✓ 5/5\n\n<details><summary>✓ 1/2 criteria (need 4) · box: no hold (votes credit)</summary>\n\n- crit t3-b —");
    expect(b.match(/<details open>/g)?.length).toBe(1);
    // eufin: a na gate holds nothing → unread, folded with its count
    const eu = section(live(CLUSTERED, "eufin"), "Blockers").split(/^\*\*T[123]\*\*/m)[2]!;
    expect([eu.split("</summary>")[0]!.includes("t2-n"), eu.split("</summary>")[1]!.includes("- gate: crit t2-n — n/a –")], "LEGS.eufin.naGateHolds is wired").toEqual([false, true]);
    // the box holds → one indented line under the unmet rows
    const holds = section(live({ ...CLUSTERED, veto: ["capex_guides"], hold: true }), "Blockers").split(/^\*\*T[123]\*\*/m)[2]!;
    expect(holds).toContain("- gate: crit t2-n — n/a – · live live t2-n ✓ 5/5\n  - box holds: votes credit · veto capex_guides\n\n<details><summary>✓ 3/5 criteria (need 4) · ✓ 1 gates · box: holds (votes credit)</summary>");
    expect(section(eufinMd(LIVE), "Verdict")).not.toMatch(/<details[^>]* open/); // the Criteria detail stays closed
  });
  it("shared-gates block: gate rows identical across ≥ 2 tranches (label, rule, both readings) render once under the summary, labelled with their tranches when fewer than three; the tranche tables keep only their own rows", () => {
    const g = (key: string, tranche: "T1" | "T2" | "T3", leg: string, rule = `rule ${leg}`) => ({ ...lg(key, tranche), gate: true, leg, rule, value: `close ${leg}`, live: { value: `live ${leg}`, verdict: "met" as const } });
    const legs = [lg("t1-a", "T1"), g("t1-v", "T1", "gate: veto"), g("t2-v", "T2", "gate: veto"), g("t2-h", "T2", "gate: HY guard"), g("t2-e", "T2", "gate: ew", "MA20 > MA50"), lg("t3-a", "T3"), g("t3-v", "T3", "gate: veto"), g("t3-h", "T3", "gate: HY guard"), g("t3-e", "T3", "gate: ew", "MA50 Δ10 > 0")];
    const md = renderLadderMd({ ...LIVE, verdict: { ...LIVE.verdict, legs } } as LadderLive, "value");
    const crit = md.slice(md.indexOf("<details><summary>Criteria detail"), md.indexOf("</details>"));
    const [every, t1, t2, t3] = crit.split(/\*\*(?:shared gates|T[123])\*\*/).slice(1) as [string, string, string, string];
    expect([crit.indexOf("**shared gates**") >= 0, crit.indexOf("**shared gates**") < crit.indexOf("**T1**")], "shared block present and leads").toEqual([true, true]);
    expect(every.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| gate"))).toEqual(["| veto | rule gate: veto | close gate: veto ✗ 1/5 | live gate: veto ✓ |", "| HY guard (T2·T3) | rule gate: HY guard | close gate: HY guard ✗ 1/5 | live gate: HY guard ✓ |"]);
    expect([t1.includes("veto"), t2.includes("veto"), t2.includes("HY guard"), t3.includes("HY guard")], "own tables drop the shared rows").toEqual([false, false, false, false]);
    expect([t2.includes("| ew | MA20 > MA50 |"), t3.includes("| ew | MA50 Δ10 > 0 |"), every.includes("ew")], "a same-label gate whose rule differs stays per tranche").toEqual([true, true, false]);
    expect(renderLadderMd(LIVE, "eufin")).not.toContain("every tranche");
  });
  it("criteria detail: one closed <details> between the tranche table and the runs; per tranche a criteria table, then a gate table only when it has gates", () => {
    const v = section(eufinMd(LIVE), "Verdict");
    const at = (t: string): number => v.indexOf(t);
    expect([at("| tranche |") < at("<details><summary>Criteria detail — T1 · T2 · T3</summary>"), at("</details>") < at("_last 5 runs_")]).toEqual([true, true]);
    const crit = v.slice(at("<details>"), at("</details>"));
    expect(crit.match(/^\| criterion \| expected \| close \| live \|$/gm)?.length).toBe(3);
    expect(crit).toContain("**T1**\n\n| criterion | expected | close | live |\n|---|---|---|---|\n| crit t1-a | rule t1-a | close t1-a ✗ 1/5 | live t1-a ✓ 5/5 |\n| crit t1-b |");
    const gateHead = "| gate (all must pass) | expected | close | live |";
    const blocks = crit.split(/^\*\*T[123]\*\*$/m).slice(1);
    expect(blocks.map((b) => b.split(gateHead).length - 1)).toEqual([0, 1, 0]);
    expect([blocks[1]!.split(gateHead)[0]!.includes("t2-g"), blocks[1]!.split(gateHead)[0]!.includes("t2-v"), crit.includes("gate: crit")]).toEqual([false, false, false]);
    expect(blocks[1]).toContain(`| crit t2-a | rule t2-a | close t2-a ✗ 1/5 | live t2-a ✓ 5/5 |\n\n${gateHead}\n|---|---|---|---|\n| crit t2-g | rule t2-g | close t2-g ✗ 1/5 | live t2-g ✓ 5/5 |\n| veto t2-v |`);
    expect(crit.split("\n").filter((l) => /^\| (crit|veto) /.test(l)).length).toBe(6);
    expect(v).not.toMatch(/<details[^>]* open/);
  });
  it("footnotes: `foot` ends the expected cell with [^n] — numbered by first appearance, deduped by text, defined once at the doc end; rows without it unchanged", () => {
    const [a, b, c, ...rest] = LIVE.verdict!.legs;
    const legs = [{ ...a!, foot: "zeta" }, { ...b!, foot: "alpha" }, { ...c!, foot: "zeta" }, ...rest];
    const md = eufinMd({ ...LIVE, verdict: { ...LIVE.verdict!, legs } });
    const row = (k: string): string | undefined => md.split("\n").find((l) => l.startsWith(`| crit ${k} |`));
    expect([row("t1-a"), row("t1-b"), row("t2-a"), row("t3-a")]).toEqual(["| crit t1-a | rule t1-a[^1] | close t1-a ✗ 1/5 | live t1-a ✓ 5/5 |", "| crit t1-b | rule t1-b[^2] | close t1-b ✗ 1/5 | live t1-b ✓ 5/5 |", "| crit t2-a | rule t2-a[^1] | close t2-a ✗ 1/5 | live t2-a ✓ 5/5 |", "| crit t3-a | rule t3-a | close t3-a ✗ 1/5 | live t3-a ✓ 5/5 |"]);
    expect([md.endsWith("\n\n[^1]: zeta\n\n[^2]: alpha\n"), md.split("[^1]:").length - 1]).toEqual([true, 1]);
    expect(md.replace(/\[\^\d+\]/g, "").replace(/\n: zeta\n\n: alpha\n$/, "")).toBe(eufinMd(LIVE));
  });
  it("Episode gates: one row per cluster member under its cluster head, the box footer, the families as signs", () => {
    const [box, escalation, head] = [BOX, CLUSTERED, CLUSTER_HEAD];
    const md = renderLadderMd({ ...LIVE, verdict: { ...LIVE.verdict!, escalation } }, "value");
    expect(md.split("_last 5 runs_")[1]!).toMatch(/^\n\n\| date \|(?:[^\n]*\n)+\n## Episode gates \(hold on 1 coincident \+ 1 lead cluster vote, or a veto\)\n\n\| cluster \|/);
    const g = section(md, head);
    expect(renderLadderMd({ ...LIVE, verdict: { ...LIVE.verdict!, escalation: { ...escalation, leadAlone: true } } }, "eufin"), "a lead-alone box heads its own rule").toContain("\n## Episode gates (hold on 1 lead cluster vote, or a veto)\n");
    expect(g.split("\n\n").slice(1, 4)).toEqual([
      ["| cluster | member | trips when | close | live | signs |", "|---|---|---|---|---|---|", "| credit · coincident · 2/2 of 2 · votes | F1 | HY ≥ 6.00 | 6.12/6.00 ✗ HIT | 6.20/6.00 | — |", "|  | CCC | CCC ≥ 12 | 12.5/12 ✗ HIT | 12.5/12 | — |", "| vol · coincident · 0/0 of 1 | VT | — | — – | — | — |", "| rates · lead · 0/1 of 1 | R2 | 10y ≥ 5.35 | 5.22/5.35 ✓ | 5.22/5.35 | — |", "|  | R4 | — | — none | — | — |"].join("\n"),
      `box: no hold · votes credit · live ${box.live}/${box.n} need ${box.quorum} · unread: vol (VT) · 4 closes since the drawdown opened`,
      "**signs (shown, no vote)**",
    ]);
    expect(g).toContain("**signs (shown, no vote)**\n\n| family | trips when | close | live | signs |\n|---|---|---|---|---|\n| credit | HY ≥ 6.00 | CCC 12.52/12 ↑ ✗ TRIPPED |");
    expect(g.split("**signs (shown, no vote)**")[1]!.split("\n").filter((l) => l.startsWith("|")).slice(2)).toEqual([
      "| credit | HY ≥ 6.00 | CCC 12.52/12 ↑ ✗ TRIPPED | CCC 12.52/12 ↑ est. ✗ | credit ▲ |",
      "| rates | 10y ≥ 5.35 | 10y 5.22/5.35 ✓ near | 10y 5.19/5.35 ✓ | rates ◆ |",
      "| Micron | DRAM ≤ −10% | DRAM +0.0%/-10.0% ✗ TRIPPED | DRAM +0.0%/-10.0% ✗ | hbm ▼ · mu_strike ▲ BLOCK |",
      "| banks | KBE ≤ −8% ×20 | KBE -3.1%/-8.0% ✓ | KBE -3.1%/-8.0% ✓ | — |",
      "| capex | sign block only | — – | — – | capex ○ |",
    ]);
    const vetoed = renderLadderMd({ ...LIVE, verdict: { ...LIVE.verdict!, escalation: { ...escalation, families: undefined, veto: ["capex_guides"], hold: true } } }, "value");
    expect(section(vetoed, head)).toContain(`\n\nbox: holds every tranche · votes credit · veto capex_guides · live ${box.live}/${box.n} need ${box.quorum} · unread: vol (VT) · 4 closes since the drawdown opened\n`);
    const graded = renderLadderMd({ ...LIVE, verdict: { ...LIVE.verdict!, escalation: { ...escalation, families: undefined, veto: ["capex_guides"], hold: false, holdT2T3: true } } }, "value");
    expect(section(graded, head)).toContain(`\n\nbox: holds T2·T3 · votes credit · veto capex_guides · live ${box.live}/${box.n}`);
    expect(vetoed.includes("signs (shown, no vote)")).toBe(false);
  });
  it("familyRow: a block forces ✗ on both cells, no close reads —, a na close with sign rows reads off them, the live cell repeats the close when absent", () => {
    const signs = [{ sign: "a", lean: "open", block: false }];
    expect(familyRow("x", "r", { value: "1/2", verdict: "met" }, signs, { live: { value: "2/2", verdict: "unmet" } })).toEqual({ name: "x", rule: "r", value: "1/2", verdict: "met", live: { value: "2/2", verdict: "unmet" }, signs });
    expect(familyRow("x", "r", { value: "1/2", verdict: "met" }, [{ ...signs[0]!, block: true, label: "L" } as never], { near: true, live: { value: "2/2", verdict: "met" } })).toMatchObject({ value: "1/2", verdict: "unmet", near: true, live: { value: "2/2", verdict: "unmet" }, signs: [{ sign: "a", lean: "open", block: true }] });
    expect([familyRow("x", "r", null, signs), familyRow("x", "r", null, []), familyRow("x", "r", { value: "n/a", verdict: "na" }, signs)].map((f) => [f.value, f.verdict, f.live])).toEqual([["—", "met", { value: "—", verdict: "met" }], ["—", "na", { value: "—", verdict: "na" }], ["n/a", "met", { value: "n/a", verdict: "met" }]]);
  });
  it("the committed public/eufin.json honours the schema's label set and links every event and calendar sign to a signs[] row", () => {
    const live = JSON.parse(readFileSync(new URL("../public/eufin.json", import.meta.url), "utf8")) as LadderLive;
    const names = new Set(live.signs.map((s) => s.sign));
    for (const s of live.signs) expect(/^(CHANGED|UNCHANGED|STALE|QUIET since|NOT DUE until|HELD until|UNSOURCED)\b/.test(s.label), `${s.sign}: ${s.label}`).toBe(true);
    for (const e of live.events) for (const n of e.signs) expect(names.has(n), `${e.event} → ${n}`).toBe(true);
    for (const c of live.calendar) expect(c.sign !== undefined && names.has(c.sign), `${c.event} → ${c.sign}`).toBe(true);
    expect(Array.isArray(live.rules) && live.rules.length === 2).toBe(true);
    for (const s of live.signs) expect(s.measurable, `${s.sign}: measurable names no BLOCKING clause`).toContain("BLOCKING = ");
    expect(["read", "analysis"].some((k) => k in live)).toBe(false);
    expect(live.situation).toBeDefined();
    const situation = live.situation ?? {};
    expect(Object.keys(situation).filter((k) => k !== "asOf" && !SITUATION_SLOTS.some(([s]) => s === k))).toEqual([]); // `asOf`: apply-stamped
    for (const k of ["lean", "slow", "fast", "decides"]) expect(k in situation, `situation.${k}`).toBe(true); // `flips` owed until the next run writes it
    expect(live.events.some((e) => e.signs.length > 0)).toBe(true);
  });
  it.each(Object.keys(LEGS) as LadderLegId[])("public/%s.json carries `brief` with exactly the five keys, every value non-empty", (leg) => {
    const live = JSON.parse(readFileSync(new URL(`../${LEGS[leg].json}`, import.meta.url), "utf8")) as LadderLive;
    expect(Object.keys(live.brief ?? {}).sort()).toEqual(["eventScope", "fund", "gates", "holdsPolicy", "primaryTier"]);
    const { primaryTier, ...prose } = live.brief!;
    for (const [k, v] of Object.entries(prose)) expect(v.trim().length > 0, `${leg} brief.${k} is empty`).toBe(true);
    // each tier entry: a name + ≥ 1 bare lowercase domain (no scheme, path or `www.`) — `inTier` (src/ladder-run.ts) suffix-matches these
    expect(primaryTier.length).toBeGreaterThan(0);
    for (const t of primaryTier) expect(t.name.trim().length > 0 && t.hosts.length > 0 && t.hosts.every((h) => /^(?!www\.)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)), `${leg} brief.primaryTier "${t.name}"`).toBe(true);
  });
  it("the md carries no `- pages:` line — `primary`/`search` are config, read off `<leg>:state --full`", () => {
    expect(eufinMd(LIVE)).not.toMatch(/^- pages: /m);
  });
  it("a sign-less calendar row, or one naming no signs[] row, lands in the Dated-no-sign list, never under a sign", () => {
    const md = eufinMd({ ...LIVE, calendar: [...LIVE.calendar, { date: "2026-10-28", event: "FOMC", matters: "rates path", verified: true }, { date: "2026-10-13", sign: "gone", event: "bank Q3", matters: "—", verified: false }] });
    expect(md).toContain("**Dated, no sign**\n- ~ 2026-10-13 bank Q3 — date unverified\n- • 2026-10-28 FOMC — matters: rates path\n");
    expect(section(md, "Signs & deciding events").indexOf("FOMC")).toBe(section(md, "Signs & deciding events").lastIndexOf("FOMC"));
    expect(eufinMd(LIVE)).not.toContain("Dated, no sign");
  });
  it("the value skill's leans group too: bear → ▲, neutral → ◆, fizzle → ▼, `unknown until` → ○ (the shared leanGroup, public/ladder-views.js)", () => {
    const sign = LIVE.signs[0]!;
    const signs = ["bear", "neutral", "fizzle", "unknown until 2026-10-14"].map((lean, i) => ({ ...sign, sign: `s${i}`, lean }));
    expect(rows(eufinMd({ ...LIVE, signs, events: [], calendar: [] }), "Signs & deciding events").map((l) => l.split("|")[1]!.trim())).toEqual(["▲ bear", "◆ neutral", "▼ fizzle", "○ unknown until 2026-10-14"]);
  });
  it("a drafted row renders its ` · draft: ` segment inside the measurable and groups its ` (draft)` lean by the word (leanWord, public/ladder-views.js)", () => {
    const sign = { ...LIVE.signs[0]!, sign: "s0", lean: "bear (draft)", measurable: "a note; BLOCKING = none · draft: bear = a cut ; fizzle = affirmed" };
    const md = eufinMd({ ...LIVE, signs: [sign], events: [], calendar: [] });
    expect(rows(md, "Signs & deciding events").map((l) => l.split("|")[1]!.trim())).toEqual(["▲ bear (draft)"]);
    expect(md).toContain("(measurable: a note; BLOCKING = none · draft: bear = a cut ; fizzle = affirmed)");
  });
  it("renders the five situation slots always — `—` for a missing block or a blank slot", () => {
    expect(eufinMd({ ...LIVE, situation: undefined })).toContain("**Lean** — —\n\n**Slow threat** — —\n\n**Fast threat** — —\n\n**What decides it** — —\n\n**What flips the lean** — —\n");
    expect(eufinMd({ ...LIVE, situation: { ...LIVE.situation!, fast: "  " } })).toContain("**Slow threat** — b\n\n**Fast threat** — —\n\n**What decides it** — w\n");
  });
  it("renders a verdict-less skeleton without throwing", () => {
    const md = eufinMd({ run: "2026-10-07", rules: LIVE.rules, signs: [], events: [], calendar: [], runs: [] });
    expect(md).toContain("## Signs & deciding events\n\n**Lean** — —\n\n**Slow threat** — —\n\n**Fast threat** — —\n\n**What decides it** — —\n\n**What flips the lean** — —\n\n<details><summary>Rules (user-set)</summary>\n\n- g\n- c\n- e\n\n</details>\n\n_none_");
    expect(md).toContain("## Verdict");
    expect(md).toContain("no verdict yet");
  });
});

describe("R4 probe rows — the live box reading is the finding; no checked / due / sources", () => {
  it("the table finding cell and detail block drop the stored web finding, its age, checked, due and sources", () => {
    const probe = { ...LIVE.signs[0]!, sign: "cg", probe: true as const, finding: "metalcharts 637 intraday", label: "PROBE 10-06", checked: "2026-10-06", due: "2026-10-14", sources: [{ date: "2026-09-14", url: "https://metalcharts.org/x" }] };
    const families = [{ name: "cg_drop", rule: "r", value: "v", verdict: "met", signs: [{ sign: "cg" }], tag: { indicator: "Cu/Au" } }];
    const md = eufinMd({ ...LIVE, verdict: { ...LIVE.verdict, escalation: { ...LIVE.verdict!.escalation!, families } } as LadderLive["verdict"], signs: [probe] });
    expect(md).toContain("| cg | cg_drop v ✓ | cg_drop → Cu/Au | — |"); // a due after the run holds no `held →`
    expect(md).toMatch(/\*\*cg\*\* — PROBE 10-06\n/);
    expect([md.includes("metalcharts"), md.includes("due 2026-10-14"), md.includes("checked 2026-10-06"), md.includes("(+")]).toEqual([false, false, false, false]);
  });
});

describe("findingAge — the `(+Nd)` after a finding whose newest source predates the window", () => {
  it("a source on the window start (run − 7, cadence absent) is fresh; a day earlier ages; no source never ages", () => {
    const at = (dates: string[]) => findingAge("2026-10-08", { ...LIVE.signs[0]!, sources: dates.map((date) => ({ date, url: "https://a.org/x" })) });
    expect([at(["2026-09-20", "2026-10-01"]), at(["2026-09-30"]), at([])]).toEqual(["", " (+8d)", ""]);
  });
});

describe("Drawdown watch (verdict.watch)", () => {
  it("renders before ## Verdict: head, ≤ 5-col rows (a manual row shows its lean, never graded), the stored grades; absent → no section", () => {
    const md = eufinMd(injectWatch({ ...LIVE, runs: [{ ...runs[0]!, watch: "ELEVATED" }, ...runs.slice(1)] }, undefined, "2026-10-20"));
    expect(md.indexOf("## Drawdown watch")).toBeGreaterThan(-1);
    expect(md.indexOf("## Drawdown watch")).toBeLessThan(md.indexOf("## Verdict"));
    expect(section(md, "Drawdown watch")).toContain("\nELEVATED · drawdown open since 10-20, 4 closes · correction box: no hold · votes credit · live 2/2 need 2 · bear box: no hold · votes — · live 2/2 need 2\n");
    const [graded = "", context = ""] = section(md, "Drawdown watch").split("_Context — shown for reading, never graded:_");
    const lines = (t: string) => t.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("|---"));
    expect(
      [lines(graded), lines(context)],
      "graded rows above the context note, sign-less → no signs column; the manual row below it, its sign kept",
    ).toEqual([
      ["| row | now | correction | bear |", "| HY OAS (credit) | 3.10 | ≥ 3.00 ✗ HIT | ≥ 5.00 ✓ |", "| 10y (macro) | 4.10 | ≥ 4.50 ✓ | ≥ 5.00 ✓ |"],
      ["| row | now | correction | bear | signs |", "| ICSA claims (macro) | lean bear | 4-wk ≥ 1.15× low | — | claims ▲ |"],
    ]);
    expect(section(md, "Drawdown watch").split("\n").filter((l) => l.startsWith("|")).every((l) => cells(l) <= 5)).toBe(true);
    expect(section(md, "Drawdown watch")).toContain("_grades, last 5 runs: 10-07 ELEVATED_");
    expect(eufinMd(injectWatch(LIVE))).toContain("\nELEVATED · no drawdown open · ");
    expect(eufinMd(LIVE)).not.toContain("Drawdown watch");
  });
  it("held (no drawdown open) → Blockers summary `Would hold` + the note; an open exit or no watch keeps `Blockers`", () => {
    const blk = (l: LadderLive): string => section(eufinMd(l), "Blockers");
    expect(blk(injectWatch(LIVE))).toContain(`<details open><summary>Would hold — T1 · T2 · T3</summary>\n\n${HELD_NOTE}\n\n**T1**`);
    expect([blk(injectWatch(LIVE, undefined, "2026-10-20")), blk(LIVE)].map((b) => b.includes("<summary>Blockers — T1 · T2 · T3</summary>\n\n**T1**"))).toEqual([true, true]);
  });
  it.each(["eufin", "value", "semis", "spit", "sp500"] as const)("committed %s json renders the same md under the default and ladderTz({}) tz; an injected watch breaks it", (leg) => {
    const live = JSON.parse(readFileSync(new URL(`../${LEGS[leg].json}`, import.meta.url), "utf8")) as LadderLive;
    const md = renderLadderMd(live, leg);
    // Reds under a non-default process TZ if renderLadderMd's default tz param is dropped.
    expect(md).toBe(renderLadderMd(live, leg, ladderTz({})));
    expect(renderLadderMd(injectWatch(live), leg)).not.toBe(md);
  });
});

describe("ReadTag.variant — a named variant of the job’s shared form", () => {
  const base: ReadTag = { indicator: "BUND", series: ["BUND"], job: "speed", agg: "kOfN" };
  it("isReadTag accepts a non-empty variant or none, rejects an empty or non-string one", () => {
    expect([base, { ...base, variant: "x" }, { ...base, variant: "" }, { ...base, variant: 42 }, { ...base, variant: ["x"] }].map(isReadTag)).toEqual([true, true, false, false, false]);
  });
  it("duplicateReads still groups two tags differing only in variant", () => {
    expect(duplicateReads([{ key: "a", tag: base }, { key: "b", tag: { ...base, variant: "fast" } }])).toEqual([{ indicator: "BUND", job: "speed", agg: "kOfN", keys: ["a", "b"] }]);
  });
  it("the md Grid gives a variant its own `spd~name` row beside the shared form's", () => {
    const tagged = injectRowTags(LIVE);
    const [a, b] = tagged.verdict!.legs;
    a!.tag = { ...a!.tag!, indicator: "BUND", job: "speed" };
    b!.tag = { ...b!.tag!, indicator: "BUND", job: "speed", variant: "fast" };
    expect(rows(renderLadderMd(tagged, "value"), "Grid").slice(0, 2)).toEqual(["| BUND | spd | 1/5 ✗ | · | · |", "| BUND | spd~fast | 1/5 ✗ | · | · |"]);
  });
});

describe("LEGS + legOf — the per-leg paths the three ladder scripts resolve", () => {
  it("each leg resolves its own json/md/skill paths, eufin is the default, and an unknown --leg throws with the script's name", () => {
    for (const [leg, d] of Object.entries(LEGS)) expect(d, leg).toMatchObject({ json: `public/${leg}.json`, md: `docs/${leg}.md`, skill: `/${leg}` });
    expect(legOf(["node", "x", "--leg=semis"])).toBe("semis");
    expect(legOf(["node", "x"])).toBe("eufin");
    expect(legOf(["node", "x", "--leg=value"])).toBe("value");
    expect(() => legOf(["node", "x", "--leg=xyz"], "ladder:state")).toThrow(/^ladder:state — unknown --leg "xyz" \(one of eufin, value, semis, spit, sp500\)$/);
  });
  it("renderLadderMd takes its title, writer skill and probe from the leg; the eufin call is renderLadderMd(live, eufin)", () => {
    const value = renderLadderMd({ ...LIVE, verdict: undefined }, "value");
    expect(value).toMatch(/^# Value live state\n\nrun 2026-10-07 · rendered from `public\/value.json` — never hand-edit; writer: `\/value`\n/);
    expect(value).toContain("run `npm run probe:value-tranches -- --into=public/value.json`");
    expect(renderLadderMd(LIVE, "eufin")).toMatch(/^# EU-Fin live state\n\nrun 2026-10-07 · rendered from `public\/eufin.json` — never hand-edit; writer: `\/eufin`\n/);
  });
  it("a runAt renders beside the run date as local HH:MM + zone, in the given timeZone", () => {
    const at = { ...LIVE, runAt: "2026-10-07T13:37:00.000Z" };
    expect(renderLadderMd(at, "value", "Europe/Tallinn")).toContain("\n\nrun 2026-10-07 16:37 EEST · rendered from");
    expect(runTime("2026-01-07T13:37:00.000Z", "Europe/Tallinn")).toBe("15:37 EET");
  });
});

describe("dateNote — the date's provenance renders after the title only while the row is unverified", () => {
  it("an unverified event / calendar row prints ` (<note>)`; a verified one prints the bare title", () => {
    const [ecb, moodys] = LIVE.events;
    const [boe, debate] = LIVE.calendar;
    const live = { ...LIVE, events: [{ ...moodys!, dateNote: "E:1 [conflict]" }, { ...ecb!, signs: ["ECB stance"], verified: true, dateNote: "est. ECB" }], calendar: [{ ...boe!, dateNote: "~11-05" }, { ...debate!, dateNote: "single source debate" }] };
    const md = eufinMd(live);
    expect([md.includes("Moody's (E:1 [conflict])"), md.includes("BoE (~11-05)"), md.includes("est. ECB"), md.includes("single source debate")]).toEqual([true, true, false, false]);
  });
});

describe("Holding now + the folded dates history", () => {
  const ev = (date: string, event: string, holds: ("T2" | "T3")[], status: string, more = {}) => ({ ...LIVE.events[1]!, date, event, holds, status, ...more });
  const FOLD: LadderLive = {
    ...LIVE,
    run: "2026-10-30",
    signs: [LIVE.signs[0]!, { ...LIVE.signs[1]!, blocked: { on: "2026-10-04", by: "Scope" } }],
    events: [
      ev("2026-10-01", "Fitch", ["T2"], "fizzle: affirmed, 10-01"),
      ev("2026-10-02", "S&P (est.)", [], "escalation: cut, 10-02"),
      ev("2026-10-03", "Scope", [], "escalation: cut, 10-03"),
      ev("2026-10-05", "Moody's", ["T2", "T3"], "mixed: outlook cut, 10-05", { sources: [{ date: "2026-10-04", url: "https://m.com/x" }] }),
      ev("2026-10-27", "DBRS", ["T2"], "fizzle: affirmed, 10-27"),
    ],
    calendar: LIVE.calendar.filter((c) => c.date !== "2026-10-07"),
  };
  it("Holding now lists each landed escalation/mixed event holding a tranche (age off its landing day) and each blocked sign, before Deciding; none → no line", () => {
    const md = eufinMd(FOLD);
    expect(md).toContain("\n**Holding now** — Moody's (mixed, 26 d) holds T2+T3 · AT1 calls BLOCK (by Scope, 26 d)\n\n**Deciding in the next 7 days**");
    expect(eufinMd({ ...FOLD, signs: [LIVE.signs[0]!], events: FOLD.events.filter((e) => e.event !== "Moody's") })).not.toContain("Holding now");
  });
  it("dates: old non-holding landed items and old calendar rows fold into one history line; an old holding event (mixed with holds, or a block's), a recent landing and upcoming rows stay", () => {
    const md = eufinMd(FOLD);
    const block = md.slice(md.indexOf("**ECB stance**"), md.indexOf("- sources:", md.indexOf("**ECB stance**")));
    expect(block.split("\n").slice(4)).toEqual([
      "  - history: 3 settled (1 fizzle · 1 escalation · 1 dated) · last 10-02 S&P escalation",
      "  - ☆ 2026-10-03 Scope — holds no tranche · status: escalation: cut, 10-03",
      "  - ★ 2026-10-05 Moody's — holds T2+T3 · escalation if: A1 · fizzle if: affirmed · status: mixed: outlook cut, 10-05 · sources: 2026-10-04 https://m.com/x",
      "  - ★ 2026-10-27 DBRS — holds T2 · status: fizzle: affirmed, 10-27",
      "  - ~ 2026-11-05 BoE — matters: UK rates · date unverified",
      "",
    ]);
  });
  it("a retired event still renders under its row: the md after an events-only retire is byte-identical", () => {
    const live = { ...FOLD, events: FOLD.events.map((e) => (e.event === "Moody's" ? { ...e, holds: ["T3" as const] } : e)) }; // already at the mixedOwed T3 step — the valve moves nothing
    const { next } = applyEvents(live, {}, "eufin", FOLD.run);
    expect(next.eventsDone?.map((e) => e.event)).toEqual(["Fitch", "S&P (est.)"]);
    expect(eufinMd(next)).toBe(eufinMd(live));
  });
});
