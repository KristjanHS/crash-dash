import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { allEvents, EVENT_HORIZON_DAYS, RETIRE_DAYS, familyRow, leanGroup, leanWord, LEGS, renderLadderMd, toVerdict, type LadderLive, type LadderSign, type LadderSource, type LadderTranche } from "./ladder-live.js";
import { printedSituation, situationRefusal, slotDates } from "./ladder-situation.js";
import { movesVerdict } from "./ladder-reverdict.js";
import { NTFY_BODY_MAX } from "./ntfy-limits.js";
import { injectWatch } from "./ladder-reads.test-helpers.js";
import * as semis from "../scripts/probe-semis-tranches.js";
import { SERIES as SEMIS_SERIES } from "../scripts/semis-series.js";
import { NEUTRAL_LIFT_GAP_DAYS, PIN_MAX_DAYS, REVIEW_FALLBACK_DAYS, REVIEW_GRACE_DAYS, STALE_REVIEW_CAP, STALE_REVIEW_DAYS } from "./ladder-block.js";
import { addDays, APPLY_ECHO_MAX, afterHolds, allFizzled, applyEcho, applyEvents, applyRun, dropMeasuredCalls, fillMechanical, fitBody, hostOf, inTier, uncitable, nowArg, planRun, primaryHosts, SEARCH_NEXT_MAX, runStamp, tagOf, withMeasured, type LadderPatch, type LadderEventsPatch } from "./ladder-run.js";
import { prelabel } from "./ladder-prelabel.js";

const TODAY = "2026-10-08";
/** The fixture's `decides`: names both tranche-holding pending events (`Votes` 10-09, Moody's 10-23) the slot owes. */
const DECIDES = "The 10-09 budget ballot and Moody's 10-23 review decide it";
/** The semis verdict's names on 2026-10-27 (clusters, families, gate legs) — the R2 lint derives its refusals from these, never a hand list. */
const SEMIS_NAMES = { legs: [{ leg: "rates 10y RY" }, { leg: "gate: credit HY OAS" }, { leg: "gate: DRAM spot vs contract" }, { leg: "gate: escalation box" }], escalation: { tripped: 2, need: 2, hits: ["credit"], clusters: [{ name: "credit", members: [] }, { name: "rates-shock", members: [] }], families: [{ name: "memory_turn", signs: [] }, { name: "cg_drop", signs: [] }] } } as unknown as Partial<LadderLive["verdict"]>;
const semisLive = (): LadderLive => { const live = fixture(); return { ...live, verdict: { ...live.verdict!, ...SEMIS_NAMES } }; };
/** The 2026-10-27 `/semis` lean verbatim — the slot R1 refuses (names the box, the credit cluster and the spot-vs-contract gate). */
const SEMIS_LEAN_10_27 = "No tranche fills at the close: T3 now has its count of signs but, like T2 and T1, is held by the episode box, which still votes on the credit cluster, and T1 also misses its spot-vs-contract gate. The lean stays fizzle on memory pricing and TSMC with the box as the binding gate, while the capex row reads neutral until a Big-4 gives a 2027 figure.";
const CLEAN_LEAN = "Memory pricing is still rolling over and TSMC's print did not change that, so the leg leans fizzle and the holder stays out of T2. Credit stress is widening slowly, which keeps the exit case alive into the Big-4 prints.";
const tr = (id: LadderTranche["id"], ok: boolean): LadderTranche => ({ id, met: ok ? 5 : 1, total: 6, need: 5, ok, ready: ok, filledSince: null });
const sign = (name: string, over: Partial<LadderSign> = {}): LadderSign => ({
  sign: name, label: "UNCHANGED 10-01", lean: "open", finding: `${name} fact`, why: "", measurable: "", block: false, checked: "2026-10-07", due: "2026-10-07",
  primary: [`https://${name}.example/list`], search: [`${name} a`, `${name} b`], seed: [], sources: [{ date: "2026-10-01", url: `https://${name}.example/1` }], ...over,
});
const fixture = (): LadderLive => ({
  run: "2026-10-07",
  rules: ["g", "c", "e"],
  situation: { lean: "l", slow: "s", fast: "f", decides: DECIDES, flips: "x", asOf: "2026-10-07" },
  verdict: { tranches: [tr("T1", true), tr("T2", true), tr("T3", false)], live: [tr("T1", true), tr("T2", false), tr("T3", false)], prov: true, regime: { set: "fast", exshVsMa200: 0.06 } } as LadderLive["verdict"],
  signs: [
    sign("rating"),
    sign("budget", { checked: TODAY }),
    sign("ecb"),
    sign("doom", { due: "2026-10-14" }),
    sign("earnings", { checked: null, due: "2026-10-22" }),
    sign("weekly", { checked: "2026-10-01", due: "2026-10-08" }),
  ],
  events: [
    { date: "2026-10-23", event: "Moody's", signs: ["rating"], escalationIf: "cut", fizzleIf: "affirm", holds: ["T2", "T3"], secondary: false, status: "NOT DUE until 2026-10-23" },
    { date: "2026-10-09", event: "Votes", signs: ["budget"], escalationIf: "censure", fizzleIf: "deal", holds: ["T2", "T3"], secondary: false, status: "NOT DUE until 2026-10-09", verified: true, sources: [{ date: "2026-10-05", url: "https://budget.example/v" }] },
    { date: "2026-10-29", event: "ECB", signs: ["ecb"], escalationIf: "hike", fizzleIf: "pause", holds: [], secondary: true, status: "NOT DUE until 2026-10-29" },
  ],
  calendar: [
    { date: "2026-10-07", sign: "rating", event: "passed", matters: "—", verified: true },
    { date: "2026-10-05", sign: "rating", event: "past", matters: "—", verified: false },
    { date: "2026-10-12", sign: "rating", event: "S&P UK", matters: "—", verified: false },
    { date: "2026-10-23", sign: "rating", event: "far", matters: "—", verified: false },
  ],
  runs: [{ date: TODAY, t1: "x", t2: "x", t3: "x", live: "x" }, ...["06", "05", "04", "03", "02"].map((d) => ({ date: `2026-10-${d}`, t1: "", t2: "", t3: "", live: "" }))],
});
const researched = (live: LadderLive, today = TODAY) => planRun(live, today).research.map((r) => r.sign);
/** The quiet patch the skill writes: `UNCHANGED <held>` off the row's newest in-window source, or a fresh same-day source when it holds none. */
const unchanged = (live: LadderLive, today = TODAY, leg?: Parameters<typeof planRun>[2]): LadderPatch => ({
  signs: Object.fromEntries(planRun(live, today, leg).research.map((r) => [r.sign, r.held ? { label: `UNCHANGED ${r.held.slice(5)}` } : { label: `UNCHANGED ${today.slice(5)}`, sources: [{ date: today, url: `https://${r.sign}.example/${today}` }] }])),
});
/** `patch` with each `contractOwed` row of `live`'s plan answered by a new `unblocking` clause body, dated so a re-owed row's next answer differs. */
const answered = (live: LadderLive, today: string, patch: LadderPatch, leg?: Parameters<typeof planRun>[2]): LadderPatch => {
  const owed = (planRun(live, today, leg).contractOwed ?? []).map((l) => l.split(" — ")[0]!);
  return { ...patch, signs: { ...patch.signs, ...Object.fromEntries(owed.map((s) => [s, { ...patch.signs[s]!, unblocking: `${s} cause resolved by ${today}` }])) } };
};
const SIT = { lean: "a", slow: "b", fast: "c", decides: "Moody's 10-23 review and the 10-09 ballot decide it", flips: "x" };
/** `SIT` with a `decides` naming every pending event of `live` dated on/after `today` (bar the ones the patch lands) — the slot apply's date lint admits on any run day. */
const sitFor = (live: LadderLive, today: string, landing: string[] = []): LadderPatch["situation"] => {
  const dates = live.events.filter((e) => !/^(escalation|fizzle|mixed): /.test(e.status) && e.date >= today && !landing.includes(e.event)).map((e) => e.date.slice(5));
  return { ...SIT, decides: dates.length ? `the ${dates.join(", ")} events decide it` : "no dated event is left to decide it" };
};
/** Two distinct primary-tier hosts (each a fixture row's `primary[]` host) — evidence the source grade leaves untagged. */
const graded = (today = TODAY, tag = "x") => [{ date: today, url: `https://rating.example/${tag}` }, { date: today, url: `https://budget.example/${tag}` }];
/** A patch landing `events` as apply now demands it: every named researched row's finding rewritten + the situation (a landed event owes both), each cited off `graded` sources. */
const land = (live: LadderLive, events: Record<string, string>, today = TODAY): LadderPatch => {
  const p = { ...unchanged(live, today), situation: sitFor(live, today, Object.keys(events)), events: Object.fromEntries(Object.entries(events).map(([k, status]) => [k, { status, sources: graded(today, k) }])) };
  for (const name of Object.keys(events)) for (const sign of live.events.find((e) => e.event === name)?.signs ?? []) if (p.signs[sign]) p.signs[sign] = { label: `UNCHANGED ${today.slice(5)}`, finding: `after ${name}, ${today}`, sources: graded(today, `after-${sign}`) };
  return p;
};

describe("planRun", () => {
  it("an event-linked row is due once a day — re-researched the same day only within ±1 day of its event; others on their due date", () => {
    const live = fixture();
    expect(researched(live)).toEqual(["rating", "budget", "ecb", "weekly"]);
    const again = applyRun(live, unchanged(live), TODAY).next;
    expect(researched(again)).toEqual(["budget"]);
    // eventWatch: a linked event further out than 7 days leaves the row on its cadence — a quarterly row with a 60-day-out event is kept, not searched daily
    const far = { ...live, signs: [...live.signs, sign("far", { cadence: 91, checked: "2026-10-01", due: "2026-12-31" })], events: [...live.events, { ...live.events[0]!, date: addDays(TODAY, 60), event: "Far", signs: ["far"] }] };
    expect(planRun(far, TODAY).kept).toContain("far — HELD until 2026-12-31");
    const farDue = { ...far, signs: far.signs.map((s) => (s.sign === "far" ? { ...s, due: TODAY } : s)) };
    expect(applyRun(farDue, unchanged(farDue), TODAY).next.signs.find((s) => s.sign === "far")!.due).toBe(addDays(TODAY, 91));
    expect(researched({ ...far, events: far.events.map((e) => (e.event === "Far" ? { ...e, date: addDays(TODAY, 7) } : e)) })).toContain("far");
    expect(researched({ ...far, events: far.events.map((e) => (e.event === "Far" ? { ...e, date: addDays(TODAY, -10) } : e)) })).toContain("far"); // past and unlanded: its outcome is owed, so the row is pulled off its cadence
  });
  it("a linked release (calendar `~` date or landed event) dated after the last check ends a cadence hold, named in the delta", () => {
    const base = fixture();
    const held = (checked: string, link: "cal" | "ev"): LadderLive => ({
      ...base,
      signs: [...base.signs, sign("print", { checked, due: "2026-10-20", sources: [{ date: checked, url: "https://print.example/1" }] })],
      ...(link === "cal"
        ? { calendar: [...base.calendar, { date: "2026-10-06", sign: "print", event: "Oct print", matters: "—", verified: false }] }
        : { events: [...base.events, { ...base.events[2]!, date: "2026-09-25", event: "Sep print", signs: ["print"], status: "fizzle: soft" }] }),
    });
    const early = held("2026-10-03", "cal");
    expect(planRun(early, TODAY).released).toEqual(["print ← Oct print (2026-10-06)"]);
    expect(applyRun(early, unchanged(early), TODAY).delta).toContain("released print ← Oct print (2026-10-06)");
    expect(researched(held("2026-10-06", "cal"))).toContain("print"); // checked on the release day: that read may have preceded the print — re-read after
    expect(planRun(held("2026-10-06", "cal"), "2026-10-06").kept).toContain("print — HELD until 2026-10-20"); // …but not again the same day
    expect(planRun(held("2026-10-07", "cal"), TODAY).kept).toContain("print — HELD until 2026-10-20"); // read the day after: consumed
    expect(researched(held("2026-09-20", "ev"))).toContain("print");
    expect(planRun(held("2026-09-25", "ev"), TODAY).kept).toContain("print — HELD until 2026-10-20");
  });
  it("the plan carries a patch stub — one {label: \"\"} per research row, absent when nothing is due", () => {
    const live = fixture();
    const plan = planRun(live, TODAY);
    expect(plan.patch).toEqual({ signs: Object.fromEntries(plan.research.map((r) => [r.sign, { label: "" }])) });
    expect(plan.research.length).toBeGreaterThan(0);
    expect(Object.keys(plan.patchForms ?? {}), "the stub's blank fields carry their allowed forms").toEqual(["finding", "searchNext"]);
    expect(planRun({ ...live, signs: [] }, TODAY).patch).toBeUndefined();
    expect(planRun({ ...live, signs: [] }, TODAY).patchForms).toBeUndefined();
  });
  it("liveNumber names every row whose measurable carries a frozen `(live …)` number, absent when none does", () => {
    const live = fixture();
    expect(planRun(live, TODAY).liveNumber).toBeUndefined();
    live.signs[1]!.measurable = "MOVE < 250d median (live 1.36×, fails)";
    live.signs[2]!.measurable = "DFII10 ≥ 3.0 % (live 2.91 / 5.24, F:11)";
    expect(planRun(live, TODAY).liveNumber).toEqual([`measurable carries a live number: ${live.signs[1]!.sign}`, `measurable carries a live number: ${live.signs[2]!.sign}`]);
  });
  it("draftOrphan names every non-probe row whose lean ends ` (draft)` with no ` · draft: ` segment behind it, absent when none does", () => {
    const live = fixture();
    live.signs[0]!.lean = "open (draft)";
    live.signs[0]!.measurable = "note · draft: open = a ; quiet = b";
    expect(planRun(live, TODAY).draftOrphan).toBeUndefined();
    live.signs[0]!.measurable = "note";
    live.signs[3]!.lean = "quiet (draft)"; // a held (not due) row is linted too — the lint reads the state, not the research list
    expect(planRun(live, TODAY).draftOrphan).toEqual(["lean carries (draft) without a draft segment: rating", "lean carries (draft) without a draft segment: doom"]);
    live.signs[3]!.probe = true; // never researched, so nothing could clear it
    expect(planRun(live, TODAY).draftOrphan).toEqual(["lean carries (draft) without a draft segment: rating"]);
  });
  it("situationOwed flags a missing block or any blank slot, never a full one", () => {
    const live = fixture();
    expect(planRun(live, TODAY).situationOwed).toBe(false);
    expect(planRun({ ...live, situation: undefined }, TODAY).situationOwed).toBe(true);
    expect(planRun({ ...live, situation: { ...live.situation!, slow: "" } }, TODAY).situationOwed).toBe(true);
    expect(planRun({ ...live, situation: { ...live.situation!, fast: "  " } }, TODAY).situationOwed).toBe(true);
  });
  it("situationOwed when asOf is absent or > 7 days old; apply stamps asOf on a write, keeps it otherwise, refuses it in a patch", () => {
    const live = fixture();
    const { asOf: _a, ...slots } = live.situation!;
    expect([9, 7].map((n) => planRun({ ...live, situation: { ...slots, asOf: addDays(TODAY, -n) } }, TODAY).situationOwed)).toEqual([true, false]);
    expect(planRun({ ...live, situation: slots }, TODAY).situationOwed).toBe(true);
    expect(applyRun(live, { ...unchanged(live), situation: SIT }, TODAY).next.situation?.asOf).toBe(TODAY);
    expect(applyRun(live, unchanged(live), TODAY).next.situation?.asOf).toBe("2026-10-07");
    expect(() => applyRun(live, { ...unchanged(live), situation: { ...SIT, asOf: TODAY } as never }, TODAY)).toThrow(/situation: "asOf" is not writable/);
  });
  it("an eventsAdd or an event re-date owes the situation; a restated stored date does not", () => {
    const live = fixture();
    const add = { date: "2026-11-02", event: "Late", signs: ["ecb"], escalationIf: "a", fizzleIf: "b", holds: [] as [], secondary: true };
    expect(() => applyRun(live, { ...unchanged(live), eventsAdd: [add] }, TODAY)).toThrow(/situation not rewritten — write all five slots .*: added event\.$/m);
    expect(() => applyRun(live, { ...unchanged(live), events: { ECB: { date: "2026-10-30" } } }, TODAY)).toThrow(/situation not rewritten — .*: re-dated event\.$/m);
    expect(() => applyRun(live, { ...unchanged(live), events: { ECB: { date: live.events.find((e) => e.event === "ECB")!.date } } }, TODAY)).not.toThrow();
  });
  it("a stored slot naming a gate, cluster, vote, ✓/✗ or n/m count reads as situationOwed; conclusions over themes do not (R1/R2)", () => {
    const live = semisLive();
    expect(planRun({ ...live, situation: { ...live.situation!, lean: SEMIS_LEAN_10_27 } }, TODAY).situationOwed).toBe(true);
    expect(planRun({ ...live, situation: { ...live.situation!, slow: "HY OAS keeps widening (3/4 met), which commits the holder to cash" } }, TODAY).situationOwed).toBe(true);
    expect(planRun({ ...live, situation: { ...live.situation!, fast: "T1 ✗ until spot turns" } }, TODAY).situationOwed).toBe(true);
    expect(planRun({ ...live, situation: { ...live.situation!, lean: CLEAN_LEAN } }, TODAY).situationOwed).toBe(false);
    expect(planRun({ ...live, situation: { ...live.situation!, fast: "NVDA's print (~10-28/29) is the gap trigger" } }, TODAY).situationOwed).toBe(false);
  });
  it("situationWhy names a slot dating anything before today — MM-DD in the nearest year, YYYY-MM-DD, a range's last day; a dash vote or a non-date is none", () => {
    const live = fixture();
    const why = (slots: Partial<LadderLive["situation"]>, today = TODAY) => planRun({ ...live, situation: { ...live.situation!, asOf: addDays(today, -1), ...slots } }, today).situationWhy;
    expect(why({ fast: "the 10-05 print opened a gap" })).toEqual(["fast: names 10-05, before today"]);
    expect(planRun({ ...live, situation: { ...live.situation!, fast: "the 10-05 print opened a gap" } }, TODAY).situationOwed).toBe(true);
    expect(why({ slow: "since 2026-10-01 credit grinds wider" })).toEqual(["slow: names 10-01, before today"]);
    expect(why({ fast: "a 10-07/09 window", lean: "the 10–2 ruling, a 25-30 bp move and a 09-31 typo" })).toBeUndefined();
    expect(why({ fast: "a 10-06/07 window, then the 10-05 print" })).toEqual(["fast: names 10-06, 10-05, before today"]);
    expect(why({ decides: "the 01-14 print decides it" }, "2026-11-09"), "01-14 seen from 11-09 is next year's").toBeUndefined();
  });
  it("situationWhy reads MM-DD/MM-DD and MM-DD/DD ranges to their end, and skips a size range and a number-led close/intraday figure stamp", () => {
    const live = fixture();
    const why = (fast: string, today = TODAY) => planRun({ ...live, situation: { ...live.situation!, asOf: addDays(today, -1), decides: sitFor(live, today)!.decides!, fast } }, today).situationWhy;
    expect([why("the 11-10/11-12 window", "2026-11-12"), why("a 10-30/11-02 window", "2026-11-01"), why("the 12-08/09 FOMC", "2026-12-09"), why("a 10-12/10 split", "2026-10-11")]).toEqual([undefined, undefined, undefined, undefined]);
    expect(why("the 11-10/11-12 window", "2026-11-13")).toEqual(["fast: names 11-10, before today"]);
    expect([why("a 10-30/02 window", "2026-11-03"), why("the 10-28/11 run", "2026-11-09")], "a /DD below the start day ends next month").toEqual([["fast: names 10-30, before today"], undefined]);
    const sizes = ["a 10-05 bp move", "a 10-05bp move", "a 10-05 % drawdown", "a 10-05% drawdown", "a 10-05 pp gap", "the 10-05 day trend", "a 10-05 days run", "a 10-05-day trend"];
    expect(sizes.map((t) => why(t))).toEqual(sizes.map(() => undefined));
    expect([why("Bloomberg 154 bp intraday 10-02 and Fed 4.1% close 2026-10-01 frame it"), why("HY 154 bp close 10-06"), why("the 10-02 close frames it"), why("positions close 10-02 ahead")]).toEqual([undefined, undefined, ...[1, 2].map(() => ["fast: names 10-02, before today"])]);
  });
  it("slotDates resolves a range end off its start — next month / next year, never an independent nearest year — and keeps [start] when the end is unreal or not later", () => {
    const at = (text: string, today = "2026-11-09") => slotDates(text, today);
    expect([at("a 10-30/02 window"), at("the 05-01/05-20 window"), at("the 10-28/11 run"), at("12-30/01-02", "2026-12-20"), at("02-27/30 and 10-12/12")]).toEqual([[["2026-10-30", "2026-11-02"]], [["2027-05-01", "2027-05-20"]], [["2026-10-28", "2026-11-11"]], [["2026-12-30", "2027-01-02"]], [["2027-02-27"], ["2026-10-12"]]]);
    const live = { ...fixture(), events: [{ date: "2026-11-30", event: "Print", signs: ["ecb"], escalationIf: "a", fizzleIf: "b", holds: ["T2" as const], secondary: false, status: "NOT DUE until 2026-11-30" }] };
    const why = planRun({ ...live, situation: { ...live.situation!, decides: "the 11-30/02 window decides it" } }, "2026-11-28").situationWhy;
    expect(why?.filter((w) => w.startsWith("decides")), "a range cites its start").toEqual([]);
  });
  it("movesVerdict: a block key, an added event or a real event status/date change re-verdicts; an echoed stored status or date does not", () => {
    const live = fixture();
    const p = unchanged(live);
    const ecb = live.events.find((e) => e.event === "ECB")!;
    const add = { date: "2026-11-02", event: "Late", signs: ["ecb"], escalationIf: "a", fizzleIf: "b", holds: [] as [], secondary: true };
    const patches: LadderPatch[] = [p, { ...p, events: { ECB: { status: ecb.status, date: ecb.date } } }, { ...p, events: { ECB: { date: "2026-10-30" } } }, { ...p, events: { ECB: { status: "fizzle: pause, 10-29" } } }, { ...p, eventsAdd: [add] }, { ...p, signs: { ...p.signs, x: { label: "CHANGED", block: false } } }];
    expect(patches.map((x) => movesVerdict(live, x, TODAY))).toEqual([false, false, true, true, true, true]);
  });
  it("movesVerdict: dropping a tranche-holding event re-verdicts (its holds leave allFizzled); dropping a non-holding one does not", () => {
    const live = fixture();
    const p = unchanged(live);
    expect([movesVerdict(live, { ...p, events: { "Moody's": { drop: "cancelled" } } }, TODAY), movesVerdict(live, { ...p, events: { ECB: { drop: "cancelled" } } }, TODAY)]).toEqual([true, false]);
  });
  it("situationWhy names each pending event decides omits: a holder within EVENT_HORIZON_DAYS or any event within 3 days; a landed or farther one is not owed", () => {
    expect(EVENT_HORIZON_DAYS).toBeGreaterThan(3);
    const live = fixture();
    const ev = (date: string, holds: ("T2" | "T3")[], event = "Print") => ({ date, event, signs: ["ecb"], escalationIf: "a", fizzleIf: "b", holds, secondary: !holds.length, status: `NOT DUE until ${date}` });
    const why = (events: LadderLive["events"]) => planRun({ ...live, events: [...live.events, ...events] }, TODAY).situationWhy;
    const edge = addDays(TODAY, EVENT_HORIZON_DAYS);
    expect(why([ev(edge, ["T2"])])).toEqual([`decides: misses ${edge.slice(5)} Print`]);
    expect(why([ev(addDays(TODAY, EVENT_HORIZON_DAYS + 1), ["T2"])])).toBeUndefined();
    expect(why([ev("2026-10-10", [])])).toEqual(["decides: misses 10-10 Print"]);
    const votesLanded = live.events.map((e) => (e.event === "Votes" ? { ...e, status: "fizzle: deal, 10-08" } : e));
    expect(planRun({ ...live, events: votesLanded, situation: { ...live.situation!, decides: "the 10-23 review decides it" } }, TODAY).situationWhy).toBeUndefined();
  });
  it("apply refuses a patched slot dating anything before today, or a decides missing a pending event the post-patch events owe", () => {
    const live = fixture();
    expect(() => applyRun(live, { ...unchanged(live), situation: { ...SIT, lean: "the 10-05 print is behind the holder" } }, TODAY)).toThrow(/situation lean: names 10-05, before today — no slot/);
    const flash = { date: "2026-10-10", event: "Flash", signs: ["ecb"], escalationIf: "a", fizzleIf: "b", holds: [] as [], secondary: true };
    expect(() => applyRun(live, { ...unchanged(live), eventsAdd: [flash], situation: SIT }, TODAY)).toThrow(/situation decides: misses 10-10 Flash — /);
    expect(applyRun(live, { ...unchanged(live), eventsAdd: [flash], situation: { ...SIT, decides: `${SIT.decides}, after the 10-10 flash` } }, TODAY).next.events.at(-1)!.event).toBe("Flash");
  });
  it(":state prints the situation without asOf on a research-free owed run, and none on a research-free run owing nothing", () => {
    const sit = { ...SIT, decides: "no dated event decides it" };
    const after = applyRun({ ...fixture(), signs: [sign("rating", { checked: TODAY, due: "2026-10-14" })], events: [] }, { signs: {}, situation: sit }, TODAY).next;
    expect([planRun(after, TODAY).research, after.situation?.asOf]).toEqual([[], TODAY]);
    const stale = { ...after, situation: { ...after.situation!, fast: "the 10-05 print opened a gap" } };
    expect(printedSituation(stale, planRun(stale, TODAY), false)).toEqual({ ...sit, fast: "the 10-05 print opened a gap" });
    expect([printedSituation(after, planRun(after, TODAY), false), printedSituation(after, planRun(after, TODAY), true)]).toEqual([undefined, sit]);
  });
  it("a lint-only owed takes a patch of just the flagged slots, merged onto the stored with asOf kept; any rewrite trigger or a missing flagged slot refuses it", () => {
    const live = { ...fixture(), situation: { ...fixture().situation!, fast: "the 10-05 print opened a gap" } };
    const fast = "the 10-23 review is the gap trigger";
    expect(applyRun(live, { ...unchanged(live), situation: { fast } }, TODAY).next.situation).toEqual({ ...live.situation, fast });
    const rating = { label: "CHANGED", finding: "rating moved", lean: "escalation-leaning", sources: graded(TODAY, "rating") };
    expect(() => applyRun(live, { signs: { ...unchanged(live).signs, rating }, situation: { fast } }, TODAY)).toThrow(/situation: a partial patch, but a rewrite trigger fired \(CHANGED row\) — write all five slots/);
    expect(() => applyRun(live, { ...unchanged(live), situation: { lean: "z" } }, TODAY)).toThrow(/situation fast: names 10-05, before today — the partial patch omits that slot$/m);
    expect(() => applyRun(fixture(), { ...unchanged(fixture()), situation: { fast } }, TODAY)).toThrow(/situation: a partial patch, but situationWhy flags no slot — write all five slots/);
    expect(() => applyRun(fixture(), { ...unchanged(fixture()), situation: {} }, TODAY)).toThrow(/^eufin:apply — situation: \{\} names no slot/);
    expect(() => applyRun(live, { ...unchanged(live), situation: { fast: " " } }, TODAY)).toThrow(/^eufin:apply — situation\.fast: a patched slot is a non-empty string$/);
  });
  it("a lean the patch changes reaches the watch rows naming that sign in the same run", () => {
    const w = injectWatch(fixture());
    const live = { ...w, verdict: { ...w.verdict!, watch: { ...w.verdict!.watch!, rows: w.verdict!.watch!.rows.map((r) => (r.key === "F1" ? { ...r, signs: [{ sign: "rating", lean: "open", block: false }] } : r)) } } };
    const rating = { label: "CHANGED", finding: "rating moved", lean: "escalation-leaning", sources: graded(TODAY, "rating") };
    const { next } = applyRun(live, { signs: { ...unchanged(live).signs, rating }, situation: sitFor(live, TODAY) }, TODAY);
    expect(next.verdict!.watch!.rows.find((r) => r.key === "F1")!.signs).toEqual([{ sign: "rating", lean: "escalation-leaning", block: false }]);
  });
  it("a verdict name refuses on a content-word pair only — a stop-word pair inside a gate label (`no new`, `and rising`) never does", () => {
    const v = { ...semisLive().verdict!, legs: [...SEMIS_NAMES!.legs!, { leg: "guard: CCC no new high" }, { leg: "NFCI wide and rising" }] } as LadderLive["verdict"];
    expect(["spreads are wide and rising", "no new supply", "DRAM spot-vs-contract"].map((t) => situationRefusal(v, t))).toEqual([undefined, undefined, "DRAM spot vs contract"]);
  });
  it("a HELD row with no finding ever is due every run; a finding naming a date after its source and before today is due with eventOwed", () => {
    const run = (...signs: LadderSign[]) => planRun({ ...fixture(), signs }, TODAY);
    const sia = sign("sia", { label: "HELD until 2026-10-30", checked: "2026-10-07", due: "2026-10-30", sources: [], finding: "" });
    expect(researched({ ...fixture(), signs: [sia] })).toEqual(["sia"]); // no finding ever
    expect(researched({ ...fixture(), signs: [{ ...sia, finding: "nothing found" }] })).toEqual([]); // a sourceless QUIET/UNSOURCED finding is a finding
    const strike = sign("strike", { label: "HELD until 2026-10-14", checked: "2026-10-07", due: "2026-10-14", finding: "union set a strike for 10-05, ballot 10-01", sources: [{ date: "2026-10-02", url: "https://strike.example/2" }] });
    expect([researched({ ...fixture(), signs: [strike] }), run(strike).eventOwed]).toEqual([["strike"], ["strike 10-05"]]);
    expect(run(strike).armRules?.eventOwed).toContain("`eventsAdd` its outcome");
    expect(run({ ...strike, finding: "union ballot 10-01, strike for 10-12" }).eventOwed).toBeUndefined(); // 10-01 precedes the source, 10-12 is still ahead
    expect(run({ ...strike, finding: "2025-10-05 print" }).eventOwed).toBeUndefined(); // a full ISO date's MM-DD tail is not a named date
    const wrap = { ...strike, finding: "print 01-15", due: "2027-01-30", sources: [{ date: "2026-12-20", url: "https://strike.example/12" }] };
    expect(planRun({ ...fixture(), signs: [wrap] }, "2027-01-20").eventOwed).toEqual(["strike 01-15"]); // a December source naming January reads the next year
  });
  it("fetch skips read and twice-failed pages; extra stems only within 7 days of an event; extended only within 3", () => {
    const live = fixture();
    live.signs[0]!.seed = ["https://rating.example/list"];
    live.signs[2]!.fails = { "https://ecb.example/list": 2 };
    const rows = new Map(planRun(live, TODAY).research.map((r) => [r.sign, r]));
    expect(rows.get("rating")).toMatchObject({ fetch: [], more: [], extended: false, query: ["rating a October 2026"], since: "2026-10-01", held: "2026-10-01" }); // R3: today − max(7, cadence ?? 7)
    // The window is the row's cadence when that is longer than 7 days — a quarterly guide stays in-window all quarter.
    live.signs[3]!.cadence = 91;
    live.signs[3]!.due = TODAY;
    expect(planRun(live, TODAY).research.find((r) => r.sign === "doom")).toMatchObject({ since: "2026-07-09" });
    expect(rows.get("budget")).toMatchObject({ more: ["budget b October 2026"], extended: true });
    expect(rows.get("ecb")).toMatchObject({ fetch: [], primary: ["https://ecb.example/list"], replace: ["https://ecb.example/list"] });
    expect(rows.get("weekly")!.more).toEqual(["weekly b October 2026"]);
    const owed = planRun(live, "2026-10-16").research.find((r) => r.sign === "budget")!;
    expect(owed).toMatchObject({ more: ["budget b October 2026"], extended: true });
    live.events[0]!.status = "fizzle: affirmed, 2026-10-08";
    expect(planRun(live, TODAY).research.find((r) => r.sign === "rating")!.more).toEqual(["rating b October 2026"]);
  });
  it("an unresolved event dated on/before today adds `<event> outcome <event's month>` to query", () => {
    const live = fixture();
    live.events[1]!.event = "Votes (+ any 49.3, E:12)";
    const budget = (l: LadderLive, d: string) => planRun(l, d).research.find((r) => r.sign === "budget")!;
    expect(budget(live, TODAY).query).toEqual(["budget a October 2026"]);
    expect(budget(live, "2026-10-09").query).toEqual(["budget a October 2026", "Votes outcome October 2026"]);
    live.events[1]!.date = "2026-09-30";
    expect(budget(live, "2026-10-09").query).toEqual(["budget a October 2026", "Votes outcome September 2026"]);
    live.events[1]!.status = "fizzle: deal, 2026-09-30";
    expect(budget(live, "2026-10-09").query).toEqual(["budget a October 2026"]);
  });
  it("sides: HOT and event-day rows only — the linked event's escalationIf/fizzleIf, else measurable's clauses, a missing side → the stem", () => {
    const live = fixture();
    const fam = (signs: string[], verdict: "unmet" | "met", near = false) => familyRow(signs[0]!, "r", { value: "x", verdict }, signs.map((sign) => ({ sign, lean: "open", block: false })), { near });
    live.verdict!.escalation = { tripped: 1, need: 2, hits: [], families: [fam(["weekly"], "unmet"), fam(["rating"], "met", true), fam(["ecb"], "met")] };
    live.signs[5]!.measurable = "level; bear = CCC ≥ 12.5 %; neutral = flat; fizzle = CCC < 11.5 %";
    const rows = () => new Map(planRun(live, TODAY).research.map((r) => [r.sign, r.sides]));
    expect(rows().get("weekly")).toEqual({ escalation: "weekly a CCC ≥ 12.5 % October 2026", fizzle: "weekly a CCC < 11.5 % October 2026" });
    expect(rows().get("budget")).toEqual({ escalation: "Votes censure October 2026", fizzle: "Votes deal October 2026" }); // event-day (Votes 10-09), no family
    expect(rows().get("rating")).toEqual({ escalation: "rating a worsening October 2026", fizzle: "rating a easing October 2026" }); // near family, its only event 15 days out: stem, not the event
    expect(rows().get("ecb")).toBeUndefined(); // a met, not-near family and an event 21 days out
    live.events[2]!.date = "2026-10-11";
    expect(rows().get("ecb")).toBeUndefined(); // not HOT, its event 3 days out: outside ±1
    live.events[1]!.escalationIf = "censure (motion [art. 49.3] carried) passes — government falls; snap poll";
    live.events[1]!.fizzleIf = "deal agreed by all parties in parliament after long talks over the budget plan";
    expect(rows().get("budget")).toEqual({ escalation: "Votes censure passes October 2026", fizzle: "Votes deal agreed by all parties in parliament after long talks over the October 2026" });
    live.signs[5]!.measurable = "BLOCKING = none (context row)";
    expect(rows().get("weekly")).toEqual({ escalation: "weekly a worsening October 2026", fizzle: "weekly a easing October 2026" });
    live.signs[5]!.measurable = "x; BLOCKING = a downgrade (Fitch) — then S&P · draft: turn = spreads narrow: below 300 bp";
    expect(rows().get("weekly")).toEqual({ escalation: "weekly a a downgrade October 2026", fizzle: "weekly a spreads narrow October 2026" });
    live.signs[5]!.measurable = "BLOCKING = a downgrade; UNBLOCKING = an upgrade";
    expect(rows().get("weekly")).toEqual({ escalation: "weekly a a downgrade October 2026", fizzle: "weekly a an upgrade October 2026" });
  });
  it("extended turns on for a researched row holding no in-window source, through a non-due apply that relabels it HELD", () => {
    const live = fixture();
    // in-window at the 10-10 non-due apply (window 10-03), stale by 10-15 (window 10-08)
    live.signs[5]!.sources = [{ date: "2026-10-05", url: "https://weekly.example/old" }];
    const d1 = applyRun(live, { signs: { ...unchanged(live).signs, weekly: { label: "UNSOURCED" } } }, TODAY).next;
    const d2 = applyRun(d1, { ...unchanged(d1, "2026-10-10"), situation: { decides: sitFor(d1, "2026-10-10")!.decides } }, "2026-10-10").next;
    expect(d2.signs[5]!.label).toBe("HELD until 2026-10-15");
    const rows = new Map(planRun(d2, "2026-10-15").research.map((r) => [r.sign, r]));
    expect(rows.get("weekly")).toMatchObject({ held: null, extended: true });
    // the contrast: a cadence-due row holding an in-window source (10-10), pinned due 10-15
    const ratingDue = { ...d2, signs: d2.signs.map((s) => (s.sign === "rating" ? { ...s, due: "2026-10-15", sources: [{ date: "2026-10-10", url: "https://rating.example/n" }] } : s)) };
    expect(planRun(ratingDue, "2026-10-15").research.find((r) => r.sign === "rating")).toMatchObject({ held: "2026-10-10", extended: false });
    const fresh = fixture();
    fresh.signs[4] = { ...fresh.signs[4]!, sources: [], due: TODAY }; // never researched (checked null): no extended
    expect(planRun(fresh, TODAY).research.find((r) => r.sign === "earnings")).toMatchObject({ held: null, extended: false });
  });
  it("scan names the leg; verify lists, by date, unverified doubt-named pending events and unverified calendar rows ≤ 21 days out", () => {
    const live = fixture();
    live.events[2]!.event = "ECB (est.)"; // 2026-10-29 = TODAY + 21
    live.calendar[3]!.event = "[far]";
    expect(planRun(live, TODAY, "semis").scan).toEqual(["Semis catalyst calendar October 2026"]);
    expect(planRun(live, TODAY).verify).toEqual([
      { event: "S&P UK", date: "2026-10-12", query: "S&P UK date" },
      { event: "[far]", date: "2026-10-23", query: "[far] date" },
      { event: "ECB (est.)", date: "2026-10-29", query: "ECB date" },
    ]);
    const done = fixture();
    done.events[2] = { ...done.events[2]!, event: "ECB (est.)", verified: true };
    done.calendar[2] = { ...done.calendar[2]!, event: "S&P UK (est.)", verified: true };
    expect(planRun(done, TODAY).verify.map((v) => v.event)).toEqual(["far"]);
    const dated = applyRun(live, { ...unchanged(live), events: { "ECB (est.)": { date: "2026-10-28", verified: true } }, situation: SIT }, TODAY).next;
    expect(planRun(dated, TODAY).verify).toEqual([]); // apply stamped both rows `verifyChecked` today
    expect(planRun(dated, "2026-10-11").verify.map((v) => v.event)).toEqual(["S&P UK", "[far]"]); // 1 d out → daily; the stamp is 3 d old
    live.events[2]!.status = "fizzle: paused, 2026-10-29";
    live.calendar[3]!.date = "2026-10-30";
    expect(planRun(live, TODAY).verify.map((v) => v.event)).toEqual(["S&P UK"]);
  });
  it("dateNote: a doubt only in the note keeps an unverified event on verify, queried off the bare title; the apply admits the note on events / calendar / eventsAdd / calendarAdd", () => {
    const live = fixture();
    expect(planRun(live, TODAY).verify.map((v) => v.event)).not.toContain("ECB");
    live.events[2]!.dateNote = "10-29 E, one blog [conflict]";
    expect(planRun(live, TODAY).verify.find((v) => v.event === "ECB")).toEqual({ event: "ECB", date: "2026-10-29", query: "ECB date" });
    const note = (l: LadderLive) => planRun(l, TODAY).events.find((e) => e.event === "ECB")?.dateNote;
    expect([note(live), note({ ...live, events: live.events.map((e) => ({ ...e, verified: true })) })]).toEqual(["10-29 E, one blog [conflict]", undefined]); // the state prints the hints only while unverified
    const { status: _, ...ecb } = live.events[2]!;
    const patch = { ...unchanged(live), events: { ECB: { dateNote: "est." } }, eventsAdd: [{ ...ecb, event: "BoE", dateNote: "~" }], calendar: { "S&P UK": { dateNote: "single source" } }, calendarAdd: [{ date: "2026-10-20", event: "Gilt auction", dateNote: "~10-20" }], situation: SIT };
    const next = applyRun(live, patch, TODAY).next;
    expect([...["ECB", "BoE"].map((n) => next.events.find((e) => e.event === n)?.dateNote), ...["S&P UK", "Gilt auction"].map((n) => next.calendar.find((c) => c.event === n)?.dateNote)]).toEqual(["est.", "~", "single source", "~10-20"]);
  });
  it("a tranche-holding event ≤ 3 days out, unverified or verified by no primary-tier source, joins verify with its linked signs' primary pages as fetch; farther, verified or holding none, no fetch", () => {
    const live = fixture();
    live.signs[1]!.primary = ["https://ir.example/a"];
    live.signs[2]!.primary = ["https://ir.example/a", "https://ecb.example/list"];
    const votes = (over: Partial<LadderLive["events"][number]>) => ({ ...live, events: [{ ...live.events[1]!, signs: ["budget", "ecb"], verified: false, ...over }] });
    expect(planRun(votes({ date: "2026-10-10" }), TODAY).verify[0]).toEqual({ event: "Votes", date: "2026-10-10", query: "Votes date", fetch: ["https://ir.example/a", "https://ecb.example/list"] });
    expect(planRun(votes({ date: "2026-10-10", verified: true, sources: [{ date: "2026-10-05", url: "https://investor.ir.example/v" }] }), TODAY).verify.map((v) => v.event)).not.toContain("Votes");
    expect(planRun(votes({ date: "2026-10-10", verified: true, sources: [{ date: "2026-10-05", url: "https://blog.example/v" }] }), TODAY).verify[0]).toMatchObject({ event: "Votes", fetch: ["https://ir.example/a", "https://ecb.example/list"] }); // verified off-tier: still checked at the issuer
    const pageless = { ...live, signs: live.signs.map((s) => ({ ...s, primary: [] })), events: [{ ...live.events[1]!, signs: ["budget"], date: "2026-10-10", verified: true, sources: [{ date: "2026-10-05", url: "https://blog.example/v" }] }] };
    expect(planRun(pageless, TODAY).verify.map((v) => v.event)).not.toContain("Votes"); // no issuer page to fetch: the verified date stands, else it re-searches every run
    const doubt = { event: "Votes (est.)" }; // the doubt name keeps the row on verify, so only `fetch` can differ
    for (const over of [{ date: "2026-10-13" }, { date: "2026-10-10", holds: [] }]) expect(planRun(votes({ ...doubt, ...over }), TODAY).verify.find((v) => v.event === doubt.event), JSON.stringify(over)).toEqual({ event: doubt.event, date: over.date, query: "Votes date" });
  });
  it("siblings: another leg's event sharing a name word within ±10 days; an unverified date conflict joins verify, a verified sibling does not", () => {
    const live = fixture();
    const ev = (event: string, date: string, verified = false) => ({ ...live.events[0]!, event, date, verified, status: "NOT DUE" });
    live.events[1]!.event = "Votes Q3"; // a stop word never pairs it with the same-day TSMC row
    const others = {
      eufin: { events: [ev("ECB", "2026-10-29")] }, // the own leg — ignored
      semis: { events: [ev("Moody's on France", "2026-10-23", true), ev("FOMC", "2026-10-09"), ev("TSMC Q3", "2026-10-09"), ev("ECB meeting", "2026-10-28"), ev("ECB", "2026-11-09")] },
    };
    const plan = planRun(live, TODAY, "eufin", others);
    expect(plan.siblings).toEqual([
      { event: "Moody's", date: "2026-10-23", siblings: [{ sibling: "semis · Moody's on France · 2026-10-23", status: "NOT DUE", verified: true, conflict: false }] },
      { event: "ECB", date: "2026-10-29", siblings: [{ sibling: "semis · ECB meeting · 2026-10-28", status: "NOT DUE", verified: false, conflict: true }] },
    ]); // FOMC shares Votes' day but no word; ECB 11-09 is 11 days out
    expect(plan.verify.map((v) => v.event)).toEqual(["S&P UK", "far", "ECB"]);
    others.semis.events[3]!.verified = true; // a verified sibling date is copied, never re-searched
    expect(planRun(live, TODAY, "eufin", others).verify.map((v) => v.event)).toEqual(["S&P UK", "far"]);
    expect(planRun(live, TODAY).siblings).toBeUndefined();
    const src = [{ date: "2026-10-09", url: "https://x.example/votes" }];
    const mixed = { semis: { events: [ev("ECB", "2026-10-29", true), ev("ECB meeting", "2026-10-28"), ev("Moody's France review", "2026-10-23"), { ...ev("Votes final", "2026-10-09"), status: "escalation: censured, 2026-10-09", sources: src }] } };
    const p2 = planRun(live, TODAY, "eufin", mixed);
    expect(p2.siblings!.map((x) => [x.event, x.siblings.map((y) => y.sibling)])).toEqual([["Votes Q3", ["semis · Votes final · 2026-10-09"]], ["ECB", ["semis · ECB · 2026-10-29", "semis · ECB meeting · 2026-10-28"]]]); // pending unverified same-date Moody's copy dropped; the two ECB copies grouped under the one own event
    expect(p2.siblings![0]!.siblings[0]!.sources).toEqual(src);
    expect(p2.verify.map((v) => v.event)).not.toContain("ECB"); // a verified sibling outranks the unverified conflict
    live.events[0]!.status = "fizzle: affirmed, 2026-10-08";
    expect(planRun(live, TODAY, "eufin", others).siblings!.map((x) => x.event)).toEqual(["ECB"]); // landed own Moody's: no siblings
  });
  it("an own pending event's outcome query drops only while a landed sibling carries sources", () => {
    const live = fixture();
    const D = "2026-10-09";
    const sib = (over: Partial<LadderLive["events"][number]>) => ({ semis: { events: [{ ...live.events[1]!, event: "Votes final", verified: false, status: "NOT DUE", sources: [], ...over }] } });
    const query = (others: Parameters<typeof planRun>[3]) => planRun(live, D, "eufin", others).research.find((r) => r.sign === "budget")!.query;
    expect(query({})).toEqual(["budget a October 2026", "Votes outcome October 2026"]);
    expect(query(sib({ status: "escalation: censured, 2026-10-09", sources: [{ date: D, url: "https://x.example/votes" }] }))).toEqual(["budget a October 2026"]);
    expect(query(sib({}))).toEqual(["budget a October 2026", "Votes outcome October 2026"]); // pending sibling
    expect(query(sib({ status: "escalation: censured, 2026-10-09" }))).toEqual(["budget a October 2026", "Votes outcome October 2026"]); // landed, sourceless
    live.events[1]!.status = "mixed: deal, 2026-10-09 — unchecked: censure";
    expect(query(sib({ status: "escalation: censured, 2026-10-09", sources: [{ date: D, url: "https://x.example/votes" }] }))).toEqual(["budget a October 2026", "Votes outcome October 2026"]); // own mixed: no siblings printed
  });
  it("quiet counts researched UNCHANGED/QUIET runs (any other label clears it, kept rows untouched); at 2 a HOT row's sides merge into one query, an event-day row's never", () => {
    const live = fixture();
    const quietOf = (l: LadderLive) => new Map(l.signs.map((s) => [s.sign, s.quiet]));
    const due = researched(live);
    expect(due).toEqual(expect.arrayContaining(["budget", "weekly"]));
    expect(due.length).toBeLessThan(live.signs.length);
    const once = applyRun(live, unchanged(live), TODAY).next;
    expect(quietOf(once)).toEqual(new Map(live.signs.map((s) => [s.sign, due.includes(s.sign) ? 1 : undefined])));
    const sidesOf = (l: LadderLive) => planRun(l, TODAY).research.find((r) => r.sign === "budget")!.sides;
    expect(sidesOf(once)).toEqual({ escalation: "Votes censure October 2026", fizzle: "Votes deal October 2026" });
    Object.assign(once.signs.find((s) => s.sign === "weekly")!, { checked: "2026-10-07", due: TODAY }); // due again on the same day
    const p = unchanged(once);
    p.signs.weekly = { label: "QUIET since 10-01" };
    p.signs.budget = { label: "UNSOURCED" };
    const cleared = applyRun(once, p, TODAY).next;
    expect([quietOf(cleared).get("weekly"), quietOf(cleared).get("budget")]).toEqual([2, undefined]);
    const twice = applyRun(once, unchanged(once), TODAY).next;
    expect(twice.signs.find((s) => s.sign === "budget")!.quiet).toBe(2);
    expect(sidesOf(twice), "an event on the row's day keeps the two-sided read").toEqual({ escalation: "Votes censure October 2026", fizzle: "Votes deal October 2026" });
    const hot = { ...live, signs: live.signs.map((s) => (s.sign === "weekly" ? { ...s, quiet: 2 } : s)), verdict: { ...live.verdict!, escalation: { tripped: 1, need: 2, hits: [], families: [familyRow("weekly", "r", { value: "x", verdict: "unmet" }, [{ sign: "weekly", lean: "open", block: false }])] } } };
    expect(planRun(hot, TODAY).research.find((r) => r.sign === "weekly")!.sides).toEqual({ both: "weekly a worsening or easing October 2026" }); // the stem form merges too
  });
  it("a passed unverified calendar row that matters is owed: state prints calendarOwed, apply refuses until it is moved or dropped", () => {
    const live = fixture();
    expect(planRun(live, TODAY).calendarOwed, "verified / `matters: —` past rows are not owed").toBeUndefined();
    expect(applyRun(live, unchanged(live), TODAY).next.calendar.map((c) => c.event), "...and drop silently").toEqual(["S&P UK", "far"]);
    const added = applyRun(live, { ...unchanged(live), calendarAdd: [{ date: addDays(TODAY, -2), event: "x", matters: "holds T2" }] }, TODAY);
    expect(added.delta, "a passed added row that matters is reported, not refused").toContain("calendar passed, outcome unrecorded: x");
    live.calendar[1]!.matters = "holds T2";
    live.calendar[0]!.matters = "holds T3"; // verified: still drops silently
    expect(planRun(live, TODAY).calendarOwed).toEqual(["past (2026-10-05)"]);
    expect(Object.keys(planRun({ ...live, signs: [] }, TODAY).patchForms ?? {}), "a research: [] run owing a row gets the drop form alone").toEqual(["calendar.drop"]);
    expect(() => applyRun(live, unchanged(live), TODAY)).toThrow(/calendar "past" \(2026-10-05\) passed unrecorded/);
    const dropped = applyRun(live, { ...unchanged(live), calendar: { past: { drop: "held 10-06, no surprise" } } }, TODAY);
    expect(dropped.next.calendar.map((c) => c.event)).toEqual(["S&P UK", "far"]);
    expect(dropped.delta.filter((l) => l.startsWith("calendar "))).toEqual(["calendar dropped: past (2026-10-05) — held 10-06, no surprise"]);
    const moved = applyRun(live, { ...unchanged(live), calendar: { past: { date: addDays(TODAY, 3), verified: true } } }, TODAY).next.calendar;
    expect(moved.find((c) => c.event === "past")).toMatchObject({ date: addDays(TODAY, 3), verified: true, matters: "holds T2" });
    expect(() => applyRun(live, { ...unchanged(live), calendar: { past: { date: addDays(TODAY, -1) } } }, TODAY)).toThrow(/calendar "past" \(2026-10-05\) passed: a move needs date >= 2026-10-08/);
    expect(() => applyRun(live, { ...unchanged(live), calendar: { past: { drop: "r" }, "S&P UK": { drop: "not passed" } } }, TODAY)).toThrow(/calendar "S&P UK": drop is only for a passed unrecorded row/);
    expect(() => applyRun(live, { ...unchanged(live), calendar: { past: { drop: "x", verified: true } } }, TODAY)).toThrow(/calendar "past": drop is a non-empty reason, its entry's sole key/);
  });
  it("calendarAdd refuses a same-key twin of a calendar row or event, warns on a near one, and apply collapses stored twins", () => {
    const live = fixture();
    const add = (event: string, date = "2026-10-12") => applyRun(live, { ...unchanged(live), calendarAdd: [{ date, sign: "rating", event }] }, TODAY);
    expect(() => add("S&P (UK)", "2026-10-13")).toThrow(/calendarAdd "S&P \(UK\)": duplicates calendar "S&P UK" \(2026-10-12\)/);
    expect(() => add("Moody's", "2026-10-23")).toThrow(/duplicates event "Moody's"/);
    expect(add("S&P UK review").delta).toContain("calendar possible dup: S&P UK review (2026-10-12) ~ S&P UK (2026-10-12)");
    expect(add("Gilt auction").next.calendar.map((c) => c.event)).toEqual(["S&P UK", "far", "Gilt auction"]);
    const twin = { ...live, calendar: [...live.calendar, { ...live.calendar[2]!, event: "S&P  UK", verified: true }] };
    const out = applyRun(twin, unchanged(twin), TODAY);
    expect(out.next.calendar.map((c) => [c.event, c.verified])).toEqual([["S&P  UK", true], ["far", false]]);
    expect(out.delta).toContain("calendar deduped: S&P UK (2026-10-12) = S&P  UK");
    const blank = { ...live, calendar: [...live.calendar, { ...live.calendar[2]!, event: "S&P  UK", matters: "UK leg" }] };
    const merged = applyRun(blank, unchanged(blank), TODAY);
    expect(merged.next.calendar.find((c) => c.date === "2026-10-12"), "an unverified `—` survivor takes its twin's matters").toMatchObject({ event: "S&P UK", matters: "UK leg", verified: false });
    expect(merged.delta).toContain("calendar deduped: S&P  UK (2026-10-12) = S&P UK · merged matters");
  });
  it("identically named twins collapse before the calendar patch: state owes the name once, one drop clears the group", () => {
    const live = fixture();
    live.calendar[1]!.matters = "holds T2";
    live.calendar.push({ ...live.calendar[1]! });
    expect(planRun(live, TODAY).calendarOwed).toEqual(["past (2026-10-05)"]);
    const out = applyRun(live, { ...unchanged(live), calendar: { past: { drop: "held 10-06" } } }, TODAY);
    expect(out.next.calendar.map((c) => c.event)).toEqual(["S&P UK", "far"]);
    expect(out.delta.filter((l) => l.startsWith("calendar "))).toEqual(["calendar deduped: past (2026-10-05) = past", "calendar dropped: past (2026-10-05) — held 10-06"]);
  });
  it("more is one query: the newest searchNext stem, else search[1]; searchNext keeps SEARCH_NEXT_MAX, clears on an in-window source, refuses a dated stem", () => {
    let live = fixture();
    live.signs.find((s) => s.sign === "weekly")!.sources = [];
    const stems = ["decline in claims", "claims DOL", "continuing claims"];
    for (const q of stems) {
      const p = unchanged(live);
      p.signs.weekly = { label: "UNSOURCED", searchNext: q };
      live = applyRun(live, p, TODAY).next;
      live.signs.find((s) => s.sign === "weekly")!.due = TODAY;
    }
    expect(SEARCH_NEXT_MAX).toBeGreaterThan(0);
    expect(stems.length).toBeGreaterThan(SEARCH_NEXT_MAX);
    expect(live.signs.find((s) => s.sign === "weekly")!.searchNext).toEqual(stems.slice(-SEARCH_NEXT_MAX));
    expect(planRun(live, TODAY).research.find((r) => r.sign === "weekly")!.more).toEqual([`${stems.at(-1)} October 2026`]);
    live.signs.find((s) => s.sign === "weekly")!.search.push("weekly c");
    expect(planRun({ ...live, signs: live.signs.map((s) => ({ ...s, searchNext: undefined })) }, TODAY).research.find((r) => r.sign === "weekly")!.more).toEqual(["weekly b October 2026"]); // a third stem never runs
    expect(applyRun(live, unchanged(live), TODAY).next.signs.find((s) => s.sign === "weekly")!.searchNext).toBeUndefined();
    const refused = ["claims October", "claims 2026", "claims 10-27"].filter((q) => {
      const p = unchanged(live);
      p.signs.weekly = { label: "UNSOURCED", searchNext: q };
      try { applyRun(live, p, TODAY); return false; } catch { return true; }
    });
    expect(refused).toHaveLength(3);
    const forward = unchanged(live);
    forward.signs.weekly = { label: "UNSOURCED", searchNext: "Russell 2000 FY27 Q1 2027 claims guidance" };
    expect(applyRun(live, forward, TODAY).next.signs.find((s) => s.sign === "weekly")!.searchNext).toContain("Russell 2000 FY27 Q1 2027 claims guidance");
  });
  it("press pages are fetched after primary; their fail counts persist but never reach replace — at 2 they surface as pressDead", () => {
    const live = fixture();
    const press = "https://press.example/a";
    live.signs[1]!.press = [press];
    const row = planRun(live, TODAY).research.find((r) => r.sign === "budget")!;
    expect(row.fetch.at(-1)).toBe(press);
    const p = unchanged(live);
    p.signs.budget = { ...p.signs.budget!, failed: [press] };
    const once = applyRun(live, p, TODAY).next.signs[1]!;
    expect(once.fails).toEqual({ [press]: 1 });
    const withOnce = () => planRun({ ...live, signs: live.signs.map((s, i) => (i === 1 ? once : s)) }, TODAY);
    expect(withOnce().pressDead).toBeUndefined();
    once.fails = { [press]: 2 };
    expect(withOnce().research.find((r) => r.sign === "budget")).toMatchObject({ fetch: ["https://budget.example/list"], primary: ["https://budget.example/list"], replace: [] });
    expect(withOnce().pressDead).toEqual([`budget: ${press}`]);
    once.probe = true;
    expect(withOnce().pressDead, "a probe row is never fetched, so it never nags").toBeUndefined();
  });
  it("lists only unverified calendar rows in the next 14 days", () => {
    expect(planRun(fixture(), TODAY).calendar.map((c) => c.event)).toEqual(["S&P UK"]);
  });
  it("each research row carries the live board reading of the families naming it (close + live), `—` when none", () => {
    const live = fixture();
    live.verdict!.escalation = { tripped: 1, need: 2, hits: [], families: [{ name: "credit", rule: "r", value: "CCC 12.82/12.5 ↑", verdict: "unmet", live: { value: "CCC 12.77/12.5 ↑ est.", verdict: "unmet" }, signs: [{ sign: "rating", lean: "open", block: false }] }] };
    const rows = new Map(planRun(live, TODAY).research.map((r) => [r.sign, r.board]));
    expect([rows.get("rating"), rows.get("ecb")]).toEqual(["credit CCC 12.82/12.5 ↑ ✗ TRIPPED · live CCC 12.77/12.5 ↑ est. ✗", "—"]);
  });
  it("a probe row is never researched — not on its due date, its event's watch, nor a landed event its source predates — and is kept as PROBE", () => {
    const live = fixture();
    Object.assign(live.events[1]!, { status: "fizzle: deal, 10-08", sources: [{ date: TODAY, url: "https://budget.example/v" }] });
    expect(planRun(live, TODAY).findingOwed).toEqual(["budget after Votes"]); // premise: the landed Votes forces budget
    for (const s of live.signs) if (s.sign === "budget" || s.sign === "weekly") s.probe = true;
    const plan = planRun(live, TODAY);
    expect([researched(live), plan.findingOwed, plan.kept.filter((k) => k.endsWith("PROBE"))]).toEqual([["rating", "ecb"], undefined, ["budget — PROBE", "weekly — PROBE"]]);
  });
});

describe("thresholdless rows + measurableDraft", () => {
  const draft = (live: LadderLive, row: string, lean: string, measurableDraft: string, label = "CHANGED") =>
    applyRun(live, { signs: { ...unchanged(live).signs, [row]: { label, ...(label === "CHANGED" && { finding: "x, 10-08", lean }), measurableDraft, sources: [{ date: "2026-10-08", url: `https://${row}.example/8` }] } }, situation: SIT }, TODAY).next.signs.find((s) => s.sign === row)!;
  it("planRun lists every due row whose measurable carries no `<label> = …` clause but BLOCKING — a drafted row drops off", () => {
    const live = fixture();
    live.signs[0]!.measurable = "date yes, outcome no; BLOCKING = a sovereign or bank downgrade";
    live.signs[2]!.measurable = "bear = DFII10 ≥ 3.0 % sustained; fizzle = below 2.5 %";
    live.signs[5]!.measurable = "TrendForce next-qtr DRAM q/q: bear ≤ 0 %";
    live.signs[1]!.measurable = "no (read speeches); BLOCKING = none (context row) · draft: open = a hike priced ; quiet = pause priced";
    expect(planRun(live, TODAY).thresholdless).toEqual(["measurable has no threshold: rating", "measurable has no threshold: weekly"]);
    live.signs.forEach((s) => (s.measurable = "bear = a; fizzle = b"));
    expect(planRun(live, TODAY).thresholdless).toBeUndefined();
  });
  it("armRules carries only the fired arms' rules, `<leg>` rendered — absent when no arm fires", () => {
    const live = fixture();
    live.signs.forEach((s) => (s.measurable = "bear = a; fizzle = b"));
    expect(planRun(live, TODAY).armRules).toBeUndefined();
    live.signs[0]!.measurable = "date yes, outcome no; BLOCKING = a sovereign or bank downgrade";
    const rules = planRun(live, TODAY, "semis").armRules!;
    expect(Object.keys(rules)).toEqual(["thresholdless"]);
    expect(rules.thresholdless).toContain("`semis:apply` lands the draft");
  });
  it("a draft lands on a thresholdless row — appended as ` · draft: `, the lean suffixed ` (draft)` whether or not the CHANGED lean carries it", () => {
    const live = fixture();
    live.signs[0]!.measurable = "date yes; BLOCKING = a downgrade";
    expect(draft(live, "rating", "escalation-leaning (draft)", "escalation-leaning = a cut or negative outlook ; fizzle-leaning = affirmed, stable")).toMatchObject({
      lean: "escalation-leaning (draft)",
      measurable: "date yes; BLOCKING = a downgrade · draft: escalation-leaning = a cut or negative outlook ; fizzle-leaning = affirmed, stable",
    });
    expect(draft(live, "rating", "escalation-leaning", "escalation-leaning = a ; fizzle-leaning = b").lean, "a bare CHANGED lean gets the suffix appended, never doubled").toBe("escalation-leaning (draft)");
    // an UNCHANGED row takes the draft too — its held lean gets the suffix
    expect(draft(live, "rating", "", "escalation-leaning = a ; fizzle-leaning = b", "UNCHANGED 10-08")).toMatchObject({ lean: "open (draft)", measurable: "date yes; BLOCKING = a downgrade · draft: escalation-leaning = a ; fizzle-leaning = b" });
    // a second draft replaces the first segment, never stacks
    const once = { ...live, signs: live.signs.map((s) => (s.sign === "rating" ? { ...s, measurable: "date yes; BLOCKING = a downgrade · draft: open = o ; quiet = q", lean: "open (draft)" } : s)) };
    expect(draft(once, "rating", "mixed (draft)", "mixed = m ; quiet = q").measurable).toBe("date yes; BLOCKING = a downgrade · draft: mixed = m ; quiet = q");
  });
  it("an UNBLOCKING clause appended by `unblocking` keeps a row thresholdless", () => {
    const live = fixture();
    live.signs[0]!.measurable = "date yes; BLOCKING = a downgrade";
    const { next } = applyRun(live, { signs: { ...unchanged(live).signs, rating: { label: "UNCHANGED 10-01", block: true, unblocking: "affirmed" } }, situation: SIT }, TODAY);
    expect(next.signs[0]!.measurable).toBe("date yes; BLOCKING = a downgrade; UNBLOCKING = affirmed");
    const d2 = "2026-10-09";
    expect(planRun(next, d2).thresholdless).toContain("measurable has no threshold: rating");
    const later = applyRun(next, { signs: { ...unchanged(next, d2).signs, rating: { ...unchanged(next, d2).signs.rating!, measurableDraft: "escalation-leaning = a ; fizzle-leaning = b" } }, situation: SIT }, d2).next;
    expect(later.signs[0]!.measurable).toBe("date yes; BLOCKING = a downgrade; UNBLOCKING = affirmed · draft: escalation-leaning = a ; fizzle-leaning = b");
  });
  it("rejects a draft on a row with a threshold, a draft off the `<lean> = … ; <lean> = …` shape, and a ` (draft)` lean with no draft behind it", () => {
    const live = fixture();
    live.signs[0]!.measurable = "bear = a; fizzle = b";
    expect(() => draft(live, "rating", "open (draft)", "open = a ; quiet = b")).toThrow(/rating: measurable already carries a threshold/);
    live.signs[0]!.measurable = "";
    for (const bad of ["open = a", "bear = a ; fizzle = b", "open = a ; open = b", "open = a ; unknown = b", "open = ; quiet = b", "a hike ; a pause"]) expect(() => draft(live, "rating", "open (draft)", bad), bad).toThrow(/rating: measurableDraft ".*" is not `<lean> = … ; <lean> = …` \(one clause per side, each of escalation-leaning\/open\/mixed\/fizzle-leaning\/quiet\)/);
    expect(() => applyRun(live, { signs: { ...unchanged(live).signs, rating: { label: "CHANGED", finding: "f", lean: "open (draft)" } }, situation: SIT }, TODAY)).toThrow(/rating: lean "open \(draft\)" carries " \(draft\)" without a measurableDraft/);
    expect(() => draft(live, "rating", "unkown (draft)", "open = a ; quiet = b")).toThrow(/rating: lean "unkown \(draft\)" is not one of/);
    // a row already holding a draft segment keeps the ` (draft)` suffix on a later CHANGED whatever the patch's lean carries — the suffix stands until the user promotes the draft
    const drafted = { ...live, signs: live.signs.map((s) => (s.sign === "rating" ? { ...s, measurable: "note · draft: open = a ; quiet = b", lean: "open (draft)" } : s)) };
    const later = (lean: string) => applyRun(drafted, { signs: { ...unchanged(drafted).signs, rating: { label: "CHANGED", finding: "f, 10-08", lean, sources: [{ date: "2026-10-08", url: "https://rating.example/8" }] } }, situation: SIT }, TODAY).next.signs[0]!.lean;
    expect(later("quiet (draft)")).toBe("quiet (draft)");
    expect(later("quiet")).toBe("quiet (draft)");
  });
  it("a ` (draft)` lean groups and moves by its word — the title prints the raw lean, suffix included; the watch lines print the drafted sides as `draft: <lean> if …`", () => {
    const live = fixture();
    live.signs[0]!.measurable = "date yes; BLOCKING = a downgrade";
    const churn = researched(live).find((r) => r !== "rating")!;
    const run = (lean: string, measurableDraft?: string) => applyRun(live, { signs: { ...unchanged(live).signs, [churn]: { label: "UNCHANGED 10-05", sources: [{ date: "2026-10-05", url: `https://${churn}.example/10-05` }] }, rating: { label: "CHANGED", finding: "x, 10-08", lean, ...(measurableDraft && { measurableDraft }), sources: [{ date: "2026-10-08", url: "https://rating.example/8" }] } }, situation: SIT }, TODAY).alert;
    const moved = run("escalation-leaning (draft)", "escalation-leaning = a cut ; fizzle-leaning = affirmed");
    expect(moved).toMatchObject({ title: "EU-Fin: rating open->escalation-leaning (draft), tranches unchanged", priority: 3 });
    expect(moved!.body.split("\n")).toEqual(expect.arrayContaining(["rating  lean open → escalation-leaning (draft) · no block", "  rating: BLOCK if a downgrade", "  rating: draft: escalation-leaning if a cut", "  rating: draft: fizzle-leaning if affirmed"]));
    live.signs[0]!.measurable = "note · draft: open = a ; quiet = b";
    live.signs[0]!.lean = "open (draft)";
    expect(run("open"), "draft → the same word is no lean move").toBeUndefined();
  });
});

describe("applyRun", () => {
  it("a researched row is due in 3 days while a family naming it is TRIPPED or near, 7 (or its cadence) otherwise", () => {
    const live = fixture();
    live.events = []; // a linked event makes a row due today regardless
    const fam = (name: string, s: string, over: object) => ({ name, rule: "r", value: "v", verdict: "met" as const, signs: [{ sign: s, lean: "open", block: false }], ...over });
    live.verdict!.escalation = { tripped: 1, need: 2, hits: [], families: [fam("credit", "rating", { verdict: "unmet" }), fam("rates", "ecb", { near: true }), fam("calm", "weekly", {})] };
    live.signs.find((s) => s.sign === "weekly")!.cadence = 14;
    const due = new Map(applyRun(live, unchanged(live), TODAY).next.signs.map((s) => [s.sign, s.due]));
    expect([due.get("rating"), due.get("ecb"), due.get("weekly")]).toEqual(["2026-10-11", "2026-10-11", "2026-10-22"]);
    // the same rows, no hot family → the weekly default / the row's own cadence
    live.verdict!.escalation = { tripped: 0, need: 2, hits: [], families: [fam("credit", "rating", {}), fam("calm", "weekly", {})] };
    const cold = new Map(applyRun(live, unchanged(live), TODAY).next.signs.map((s) => [s.sign, s.due]));
    expect([cold.get("rating"), cold.get("ecb"), cold.get("weekly")]).toEqual(["2026-10-15", "2026-10-15", "2026-10-22"]);
    // a dropped box row's sign rides its member: off the semis writer, the capex member hit → 3 days, clear → 7
    live.signs.push({ ...live.signs.find((s) => s.sign === "rating")!, sign: "capex_guides" });
    const empty = Object.fromEntries(SEMIS_SERIES.map((id) => [id, []])) as unknown as Parameters<typeof semis.evaluateShipped>[0];
    const capex = (hcx: number) => {
      live.verdict = toVerdict(semis.asProbeResult(semis.evaluateShipped({ ...empty, HCX: [{ date: "2026-10-07", value: hcx }] }, live.signs)), false);
      return applyRun(live, unchanged(live), TODAY).next.signs.find((s) => s.sign === "capex_guides")!.due;
    };
    expect([capex(-0.5), capex(0.02)]).toEqual(["2026-10-11", "2026-10-15"]);
    // a value member carrying the sign near its cut → 3 days
    live.verdict!.escalation = { tripped: 0, need: 2, hits: [], families: [], clusters: [{ name: "c", kind: "lead", n: 1, live: 1, hits: 0, vote: false, members: [{ id: "dram_drop", cell: false, near: true, signs: [{ sign: "rating", lean: "open", block: false }] }] }] } as never;
    expect(new Map(applyRun(live, unchanged(live), TODAY).next.signs.map((s) => [s.sign, s.due])).get("rating")).toBe("2026-10-11");
  });
  it("a watch row whose correction cell is hit makes its signs due in 3 days; a false cell or no watch leaves the 7-day default", () => {
    const live = fixture();
    live.events = [];
    live.verdict!.escalation = { tripped: 0, need: 2, hits: [], families: [{ name: "credit", rule: "r", value: "v", verdict: "met", signs: [{ sign: "rating", lean: "open", block: false }] }] };
    const due = (l: LadderLive) => applyRun(l, unchanged(l), TODAY).next.signs.find((s) => s.sign === "rating")!.due;
    const watched = (F1: "hit" | false, role?: "context") => ((l) => ({ ...l, verdict: { ...l.verdict!, watch: { ...l.verdict!.watch!, rows: l.verdict!.watch!.rows.map((r) => (r.key === "F1" ? { ...r, ...(role && { role }), signs: [{ sign: "rating", lean: "open", block: false }] } : r)) } } }))(injectWatch(live, { F1, R5: false }));
    expect([due(watched("hit")), due(watched(false)), due(watched("hit", "context")), due(live)], "a hit context row is not HOT").toEqual(["2026-10-11", "2026-10-15", "2026-10-15", "2026-10-15"]);
  });
  it("a probe row's lean comes off its box family — tripped → bear, clear → fizzle, na/none → kept, tags stripped — never blocked by a landed escalation; a non-probe row is untouched", () => {
    const live = fixture();
    const fam = (s: string, verdict: "met" | "unmet") => familyRow(s, "r", { value: "x", verdict }, [{ sign: s, lean: "neutral", block: false }]);
    live.verdict!.escalation = { tripped: 2, need: 2, hits: [], families: [fam("budget", "unmet"), fam("doom", "met"), { ...fam("earnings", "met"), verdict: "na" }, fam("rating", "unmet")] };
    for (const s of live.signs) Object.assign(s, { lean: "neutral", ...(["budget", "doom", "earnings", "weekly"].includes(s.sign) && { probe: true }) });
    Object.assign(live.signs[1]!, { measurable: "m · draft: bear = a ; fizzle = b" }); // budget: a draft row the escalation blocks — gradedLean would tag it
    Object.assign(live.signs[3]!, { lean: "bear (press only)" });
    Object.assign(live.signs[4]!, { lean: "neutral (draft)" }); // earnings reads na: no draft segment, so the tag must go or draftOrphan nags forever
    Object.assign(live.signs[5]!, { label: "PROBE 10-01", checked: "2026-10-01" });
    const run = (leg: "semis" | "eufin") => new Map(applyRun(live, land(live, { Votes: "escalation: censure, 10-08" }), TODAY, leg).next.signs.map((s) => [s.sign, s]));
    const next = run("semis");
    expect(["budget", "doom", "earnings", "weekly", "rating"].map((n) => [next.get(n)!.lean, next.get(n)!.label, next.get(n)!.checked])).toEqual([
      ["bear", "PROBE 10-08", TODAY], ["fizzle", "PROBE 10-08", TODAY], ["neutral", "PROBE", null], ["neutral", "PROBE 10-01", "2026-10-01"], ["neutral", "UNCHANGED 10-01", TODAY],
    ]);
    expect([next.get("budget")!.block, next.get("doom")!.leanLog]).toEqual([false, [{ date: "2026-10-07", lean: "bear" }, { date: TODAY, lean: "fizzle" }]]);
    expect(["budget", "doom"].map((n) => run("eufin").get(n)!.lean), "the leg's own vocabulary, never a leg id").toEqual(["escalation-leaning", "fizzle-leaning"]);
  });
  it("a probe row's probeLeans replaces both words (tripped → fizzle, clear → neutral); a row without it keeps bear/fizzle; a word outside the leg's leans fails loud", () => {
    const live = fixture();
    const fam = (s: string, verdict: "met" | "unmet") => familyRow(s, "r", { value: "x", verdict }, [{ sign: s, lean: "neutral", block: false }]);
    live.verdict!.escalation = { tripped: 2, need: 2, hits: [], families: [fam("budget", "unmet"), fam("doom", "met"), fam("earnings", "unmet"), fam("weekly", "met")] };
    const flush = { tripped: "fizzle", clear: "neutral" };
    for (const s of live.signs) Object.assign(s, { lean: "unknown", ...(["budget", "doom", "earnings", "weekly"].includes(s.sign) && { probe: true }), ...(["budget", "doom"].includes(s.sign) && { probeLeans: flush }) });
    const leans = (l: LadderLive) => ((m) => ["budget", "doom", "earnings", "weekly"].map((n) => m.get(n)))(new Map(applyRun(l, unchanged(l, TODAY, "semis"), TODAY, "semis").next.signs.map((s) => [s.sign, s.lean])));
    expect(leans(live)).toEqual(["fizzle", "neutral", "bear", "fizzle"]);
    const patch = unchanged(live, TODAY, "semis");
    const doom = live.signs.find((s) => s.sign === "doom") as { probeLeans: unknown };
    for (const bad of [{ tripped: "fizzle", clear: "calm" }, null]) {
      doom.probeLeans = bad;
      const msg = `doom: probeLeans ${JSON.stringify(bad)} is not {tripped, clear} on a probe row, each one of bear/neutral/fizzle`;
      expect(() => applyRun(live, patch, TODAY, "semis")).toThrow(`semis:apply — ${msg}`);
      expect(() => planRun(live, TODAY, "semis"), ":state rejects it before any research").toThrow(`semis:state — ${msg}`);
    }
  });
  it("a probe read stamps the verdict's close date (label + checked), and its lean move never pushes", () => {
    const live = fixture();
    live.verdict!.escalation = { tripped: 1, need: 2, hits: [], families: [familyRow("budget", "r", { value: "x", verdict: "unmet" }, [{ sign: "budget", lean: "neutral", block: false }])] };
    live.verdict!.asOf = { close: "2026-10-06", live: TODAY, est: false };
    live.signs[1]!.probe = true;
    const { next, alert } = applyRun(live, unchanged(live), TODAY);
    expect([next.signs[1]!.lean, next.signs[1]!.label, next.signs[1]!.checked, alert]).toEqual(["escalation-leaning", "PROBE 10-06", "2026-10-06", undefined]);
  });
  it("an eventsAdd naming a probe row is rejected — on a run and on --events-only", () => {
    const live = fixture();
    live.signs[1]!.probe = true;
    const ev = { date: "2026-10-20", event: "New", signs: ["budget"], escalationIf: "a", fizzleIf: "b", holds: [], secondary: true };
    expect(() => applyRun(live, { ...unchanged(live), eventsAdd: [ev] }, TODAY)).toThrow(/eventsAdd "New": sign budget is a probe row/);
    expect(() => applyEvents(live, { eventsAdd: [ev] }, "eufin", TODAY)).toThrow(/eventsAdd "New": sign budget is a probe row/);
  });
  it("a landed event whose named row keeps its finding REJECTS the patch (finding not rewritten, listed before the situation nag); a rewritten finding clears it", () => {
    const live = fixture();
    const landed = { ...unchanged(live), events: { Votes: { status: "fizzle: deal, 10-08" } } };
    expect(() => applyRun(live, landed, TODAY)).toThrow(/^eufin:apply — finding not rewritten for budget after Votes — a landed event rewrites each named row's finding\.\nsituation not rewritten — /);
    const rewritten = { ...landed, signs: { ...landed.signs, budget: { label: "UNCHANGED 10-08", finding: "deal passed, calm", sources: [{ date: "2026-10-08", url: "https://budget.example/10-08" }] } } };
    expect(() => applyRun(live, rewritten, TODAY)).toThrow(/situation not rewritten/); // the finding fail cleared, the landed event still owes the situation
    expect(applyRun(live, { ...rewritten, situation: SIT }, TODAY).delta.some((l) => /not rewritten/.test(l))).toBe(false);
    // a slot kept byte-identical while naming the landing event's MM-DD fails; the same slot rewritten passes
    const pending = { ...SIT, decides: "the 10-23 review decides it", fast: "the 10-09 session sets the path" };
    const named = { ...fixture(), situation: pending };
    expect(() => applyRun(named, { ...rewritten, situation: { ...pending, lean: "z" } }, TODAY)).toThrow(/situation fast kept unchanged but names 10-09/);
    expect(applyRun(named, { ...rewritten, situation: { ...pending, fast: "the 10-09 session passed; path calm" } }, TODAY).next.situation?.fast).toBe("the 10-09 session passed; path calm");
    // a still-pending event sharing the landing event's date keeps that MM-DD nameable in a kept slot
    const shared = { ...named, events: [...named.events, { date: "2026-10-09", event: "Recount", signs: ["rating"], escalationIf: "a", fizzleIf: "b", holds: [], secondary: true, status: "NOT DUE until 2026-10-09" }] };
    expect(applyRun(shared, { ...rewritten, situation: { ...pending, lean: "z", decides: "the 10-09 recount and the 10-23 review decide it" } }, TODAY).next.situation?.fast).toBe("the 10-09 session sets the path");
    // an eventsAdd landing this run counts as landing: a kept slot naming its MM-DD fails
    const early = { date: TODAY, event: "Early", signs: ["ecb"], escalationIf: "a", fizzleIf: "b", holds: [], secondary: true, status: "fizzle: b, 10-08", sources: graded() };
    const today = { ...fixture(), situation: { ...SIT, decides: "the 10-08 session decides" } };
    const ecb = { label: "UNCHANGED 10-08", finding: "after the session", sources: graded() };
    expect(() => applyRun(today, { signs: { ...unchanged(today).signs, ecb }, eventsAdd: [early], situation: { ...today.situation, lean: "z" } }, TODAY)).toThrow(/situation decides kept unchanged but names 10-08/);
    // no fail when the event names no row at all
    const ghost = fixture();
    ghost.events[1]!.signs = ["ghost"]; // no such row (a named row the gate pulls onto the list IS researched, so it would fail)
    expect(applyRun(ghost, { ...unchanged(ghost), situation: SIT, events: { Votes: { status: "fizzle: deal, 10-08", sources: graded() } } }, TODAY).next.events[1]!.status).toBe("fizzle: deal, 10-08");
  });
  it("an EARLIER landed event whose outcome postdates the row's newest source forces the row onto research every run and rejects an unrewritten finding ([USER 2026-10-16] staleAfter)", () => {
    const prior = fixture();
    prior.events[1]!.status = "fizzle: deal, 10-07"; // landed before this run, no stored sources → outcome dated by the event (10-09 > doom's 10-01 source)
    prior.events[1]!.signs = ["doom"]; // HELD until 10-14 by its due date — only staleAfter puts it on the list
    expect(planRun(prior, TODAY)).toMatchObject({ findingOwed: ["doom after Votes"] });
    expect(researched(prior)).toContain("doom");
    expect(() => applyRun(prior, { ...unchanged(prior), situation: SIT }, TODAY)).toThrow(/^eufin:apply — finding not rewritten for doom after Votes — /);
    // rewritten off a source dated on/after the event's own (early) source: lands, and the next run no longer forces the row
    const resourced = { ...unchanged(prior), situation: SIT, events: { Votes: { status: "fizzle: deal, 10-08", sources: graded() } } };
    resourced.signs.doom = { label: "UNCHANGED 10-08", finding: "deal passed, doom calm", sources: [{ date: TODAY, url: "https://doom.example/10-08" }] };
    const { next } = applyRun(prior, resourced, TODAY);
    expect([planRun(next, "2026-10-09").findingOwed, researched(next, "2026-10-09")]).toEqual([undefined, expect.not.arrayContaining(["doom"])]);
  });
  it("staleAfter is judged on the pre-patch row and bounded to the window: apply rejects only what planRun forced, plus an eventsAdd landing this run", () => {
    /** `Votes` landed on `on`, naming the due `doom` row holding `sources`. */
    const at = (on: string, sources: LadderSign["sources"]) => {
      const live = fixture();
      Object.assign(live.events[1]!, { date: on, status: `fizzle: deal, ${on.slice(5)}`, signs: ["doom"] });
      Object.assign(live.signs[3]!, { due: "2026-10-07", sources });
      return live;
    };
    const quiet = (live: LadderLive, doom: LadderPatch["signs"][string]) => applyRun(live, { signs: { ...unchanged(live).signs, doom } }, TODAY);
    // landed before the window (since 09-24): never forced, and a QUIET patch that empties the window lands
    const old = at("2026-09-01", []);
    expect(planRun(old, TODAY).findingOwed).toBeUndefined();
    expect(() => quiet(old, { label: "QUIET since 09-24" })).not.toThrow();
    expect(() => quiet(at("2026-09-01", [{ date: "2026-09-05", url: "https://doom.example/0905" }]), { label: "QUIET since 09-24" })).not.toThrow();
    // forced: a post-event source with the finding unchanged is still rejected
    const forced = at("2026-10-05", [{ date: "2026-10-01", url: "https://doom.example/1" }]);
    expect(() => quiet(forced, { label: "UNCHANGED 10-08", sources: [{ date: TODAY, url: "https://doom.example/10-08" }] })).toThrow(/^eufin:apply — finding not rewritten for doom after Votes — /);
    // released: rewritten earlier off a source dated on the outcome — a quiet patch lands
    const released = at("2026-10-05", [{ date: "2026-10-05", url: "https://doom.example/1005" }]);
    expect(planRun(released, TODAY).findingOwed).toBeUndefined();
    expect(() => quiet(released, { label: "UNCHANGED 10-05" })).not.toThrow();
    // an eventsAdd landing this run: the named row's finding is owed even beside a same-day source
    const live = fixture();
    const early = { date: TODAY, event: "Early", signs: ["ecb"], escalationIf: "a", fizzleIf: "b", holds: [], secondary: true, status: "fizzle: b, 10-08", sources: graded() };
    expect(() => applyRun(live, { signs: { ...unchanged(live).signs, ecb: { label: "UNCHANGED 10-08", sources: graded() } }, eventsAdd: [early] }, TODAY)).toThrow(/^eufin:apply — finding not rewritten for ecb after Early — /);
  });
  it("a close tranche flip vs runs[0] owes the situation; a live-only flip does not", () => {
    const live = { ...fixture(), runs: [{ date: "2026-10-07", t1: "1/6 ✗", t2: "5/6 ✓", t3: "1/6 ✗", live: "✗✗✗" }] };
    expect(planRun(live, TODAY).situationWhy).toEqual(["all: tranche flip"]);
    expect(() => applyRun(live, unchanged(live), TODAY)).toThrow(/situation not rewritten — write all five slots \(lean, slow, fast, decides, flips\): tranche flip\.$/m);
    expect(() => applyRun(live, { ...unchanged(live), situation: { fast: "c" } }, TODAY)).toThrow(/situation: a partial patch, but a rewrite trigger fired \(tranche flip\)/);
    const intra = { ...fixture(), runs: [{ date: "2026-10-07", t1: "5/6 ✓", t2: "5/6 ✓", t3: "1/6 ✗", live: "✗✗✗" }] };
    expect(applyRun(intra, unchanged(intra), TODAY).next.run).toBe(TODAY);
  });
  it("a patch may not carry read/analysis; a situation patch needs all five non-empty slots; an owed situation rejects the patch", () => {
    const live = fixture();
    expect(() => applyRun(live, { ...unchanged(live), read: "x" } as never, TODAY)).toThrow(/"read" is not writable/);
    expect(() => applyRun(live, { ...unchanged(live), situation: { lean: "a", slow: "b", fast: "c", decides: "d" } as never }, TODAY)).toThrow(/all five slots \(lean, slow, fast, decides, flips\)/);
    expect(() => applyRun(live, { ...unchanged(live), situation: { lean: "a", slow: "b", fast: "c", decides: "", flips: "x" } }, TODAY)).toThrow(/situation\.decides: a patched slot is a non-empty string/);
    expect(() => applyRun(live, { ...unchanged(live), situation: { lean: "a", slow: "b", fast: "c", decides: DECIDES, flips: "x", why: "w" } as never }, TODAY)).toThrow(/situation: "why" is not writable/);
    const owed = { ...live, situation: undefined };
    expect(() => applyRun(owed, unchanged(owed), TODAY)).toThrow(/situation not rewritten — write all five slots .*: asOf absent\.$/m);
    expect(applyRun(owed, { ...unchanged(owed), situation: { lean: "a", slow: "b", fast: "c", decides: DECIDES, flips: "x" } }, TODAY).delta.some((l) => /situation not rewritten/.test(l))).toBe(false);
  });
  it("refuses a patch that misses a researched row, names an unplanned one, a lean off CHANGED, or a board number in a finding or situation slot", () => {
    const live = fixture();
    const p = unchanged(live);
    expect(() => applyRun(live, { signs: { ...p.signs, doom: { label: "UNCHANGED 10-01" } } }, TODAY)).toThrow(/doom: not on/);
    delete p.signs.rating;
    expect(() => applyRun(live, p, TODAY)).toThrow(/researched rows missing from the patch: rating — copy the `patch` stub whole/);
    expect(() => applyRun(live, { signs: { ...unchanged(live).signs, ecb: { label: "UNCHANGED 10-01", finding: "x", lean: "open" } } }, TODAY)).toThrow(/lean only on CHANGED/);
    expect(() => applyRun(live, { signs: { ...unchanged(live).signs, ecb: { label: "CHANGED", finding: "x" } } }, TODAY)).toThrow(/CHANGED carries finding \+ lean/);
    // an UNCHANGED row re-sourced fresher rewrites its finding, lean untouched
    expect(applyRun(live, { signs: { ...unchanged(live).signs, ecb: { label: "UNCHANGED 10-08", finding: "hold reaffirmed, 10-08", sources: [{ date: "2026-10-08", url: "https://ecb.example/10-08" }] } } }, TODAY).next.signs[2]).toMatchObject({ label: "UNCHANGED 10-08", finding: "hold reaffirmed, 10-08", lean: "open" });
    expect(() => applyRun(live, { signs: { ...unchanged(live).signs, ecb: { label: "UNCHANGED 10-08", finding: "CCC 12.52 % (10-08 close) over the line", sources: [{ date: "2026-10-08", url: "https://ecb.example/10-08" }] } } }, TODAY)).toThrow(/ecb: finding carries a board number "\(10-08 close\)"/);
    expect(() => applyRun(live, { ...unchanged(live), situation: { lean: "BUND 137 bp (10-15 close)", slow: "b", fast: "c", decides: DECIDES, flips: "x" } }, TODAY)).toThrow(/situation\.lean: carries a board number/);
    const semis = semisLive();
    expect(() => applyRun(semis, { ...unchanged(semis), situation: { lean: SEMIS_LEAN_10_27, slow: "b", fast: "c", decides: DECIDES, flips: "x" } }, TODAY)).toThrow(/situation\.lean: names "gate"/);
    expect(() => applyRun(semis, { ...unchanged(semis), situation: { lean: "a", slow: "the DRAM spot-vs-contract read is the slow grind", fast: "c", decides: DECIDES, flips: "x" } }, TODAY)).toThrow(/situation\.slow: names "DRAM spot vs contract"/);
    expect(applyRun(semis, { ...unchanged(semis), situation: { lean: CLEAN_LEAN, slow: "b", fast: "c", decides: DECIDES, flips: "x" } }, TODAY).next.situation!.lean).toBe(CLEAN_LEAN);
    expect(() => applyRun(live, { signs: { ...unchanged(live).signs, ecb: { label: "HELD until 2026-10-14" } } }, TODAY)).toThrow(/not a research label/);
    expect(() => applyRun(live, { signs: { ...unchanged(live).signs, ecb: { label: "CHANGED: x" } } }, TODAY)).toThrow(/not a research label/);
    // the lean is one of the leg's `leans` (LEGS); only unknown may carry ` until <date>`
    expect(() => applyRun(live, { signs: { ...unchanged(live).signs, ecb: { label: "CHANGED", finding: "f", lean: "unkown" } } }, TODAY)).toThrow(/ecb: lean "unkown" is not one of escalation-leaning\/open\/mixed\/fizzle-leaning\/quiet\/unknown/);
    expect(() => applyRun(live, { signs: { ...unchanged(live).signs, ecb: { label: "CHANGED", finding: "f", lean: "bear" } } }, TODAY)).toThrow(/ecb: lean "bear" is not one of/);
    expect(() => applyRun(live, { signs: { ...unchanged(live).signs, ecb: { label: "CHANGED", finding: "f", lean: "quiet until 2026-10-22" } } }, TODAY)).toThrow(/ecb: lean "quiet until 2026-10-22" is not one of/);
    const dated = { label: "CHANGED", finding: "f, 10-08", lean: "unknown until 2026-10-22", sources: [{ date: "2026-10-08", url: "https://ecb.example/8" }] };
    expect(applyRun(live, { signs: { ...unchanged(live).signs, ecb: dated }, situation: SIT }, TODAY).next.signs[2]!.lean).toBe("unknown until 2026-10-22");
    expect(applyRun(live, { signs: { ...unchanged(live).signs, ecb: { ...dated, lean: "unknown" } }, situation: SIT }, TODAY).next.signs[2]!.lean, "bare unknown stays valid").toBe("unknown");
    const add = (c: Record<string, unknown>) => applyRun(live, { ...unchanged(live), calendarAdd: [{ date: "2026-10-28", event: "FOMC", matters: "—", verified: true, ...c } as never] }, TODAY);
    expect(add({}).next.calendar.find((c) => c.event === "FOMC")?.sign, "a sign-less row is admitted").toBeUndefined();
    const bare = applyRun(live, { ...unchanged(live), calendarAdd: [{ date: "2026-10-28", event: "FOMC" }] }, TODAY).next.calendar.find((c) => c.event === "FOMC");
    expect(bare, "matters defaults —, verified false").toMatchObject({ matters: "—", verified: false });
    expect(() => applyRun(live, { ...unchanged(live), calendarAdd: [{ event: "FOMC" } as never] }, TODAY)).toThrow(/needs date \+ event/);
    expect(() => add({ sign: "gone" })).toThrow(/a given sign must be a signs\[\] row/);
    expect(() => applyRun(live, { signs: { ...unchanged(live).signs, ecb: { label: "UNCHANGED 10-01", why: "x" } as never } }, TODAY)).toThrow(/"why" is not writable/);
    expect(() => applyRun(live, { ...unchanged(live), events: { "Moody's": { holds: [] } as never } }, TODAY)).toThrow(/"holds" is not writable/);
    expect(() => applyRun(live, { ...unchanged(live), events: { "Moody's": { date: "23 Oct" } } }, TODAY)).toThrow(/not YYYY-MM-DD/);
    expect(() => applyRun(live, { signs: { ...unchanged(live).signs, ecb: { label: "UNCHANGED 10-01", sources: [{ date: "Oct 8", url: "u" }] } } }, TODAY)).toThrow(/not YYYY-MM-DD/);
    expect(() => applyRun(live, { signs: { ...unchanged(live).signs, ecb: { label: "UNCHANGED 10-01", primary: ["https://x"] } } }, TODAY)).toThrow(/primary only swaps/);
    const t1 = { date: "2026-11-02", event: "new", signs: ["ecb"], escalationIf: "a", fizzleIf: "b", holds: ["T1" as const], secondary: false, status: "" };
    expect(() => applyRun(live, { ...unchanged(live), eventsAdd: [t1] }, TODAY)).toThrow(/holds T2\/T3 only/);
    // the holdable tranches are the leg's: Value's first third has no fill before it, so an event may delay it too
    const sit = { ...SIT, decides: `${SIT.decides}, then the 11-02 print` };
    expect(applyRun(live, { ...unchanged(live), eventsAdd: [t1], situation: sit }, TODAY, "value").next.events.at(-1)).toMatchObject({ event: "new", holds: ["T1"], status: "NOT DUE until 2026-11-02" });
    const { status: _s, ...noStatus } = t1;
    expect(applyRun(live, { ...unchanged(live), eventsAdd: [noStatus], situation: sit }, TODAY, "value").next.events.at(-1), "status optional — recomputed off the date").toMatchObject({ event: "new", status: "NOT DUE until 2026-11-02" });
    expect(applyRun(live, { ...unchanged(live), eventsAdd: [{ ...noStatus, date: "2026-10-01" }], situation: SIT }, TODAY, "value").next.events.at(-1)).toMatchObject({ status: "DELAY — outcome unsourced" });
    const { signs: _g, ...noSigns } = noStatus;
    expect(() => applyRun(live, { ...unchanged(live), eventsAdd: [noSigns as never] }, TODAY, "value")).toThrow(/needs every field but `status`/);
    expect(() => applyRun(live, { ...unchanged(live), eventsAdd: [{ ...t1, secondary: true }] }, TODAY, "value")).toThrow(/holds T1\/T2\/T3 only, none when secondary/);
    // the thrown prefix names the leg the script was run for, eufin by default
    expect(() => applyRun(live, p, TODAY)).toThrow(/^eufin:apply — /);
    expect(() => applyRun(live, p, TODAY, "value")).toThrow(/^value:apply — researched rows missing from the patch: rating/);
  });
  it("refuses a patch string quoting a licensed index level, naming its path and the level; the state against the criterion passes", () => {
    const live = fixture();
    const quoting = { label: "CHANGED", finding: "CCC 13.16 % and rising", lean: "open", sources: [{ date: "2026-10-08", url: "https://ecb.example/10-08" }] };
    expect(() => applyRun(live, { signs: { ...unchanged(live).signs, ecb: quoting }, situation: SIT }, TODAY)).toThrow(/patch\.signs\.ecb\.finding: quotes the licensed index level "CCC 13\.16 %" — licensed index levels are not published; write "—"/);
    const priced = { ...quoting, finding: "MU 778.31 close 11-04, still above the bear line" }; // a licensed close (11.6c): refused
    expect(() => applyRun(live, { signs: { ...unchanged(live).signs, ecb: priced }, situation: SIT }, TODAY)).toThrow(/patch\.signs\.ecb\.finding: quotes the licensed close "MU 778\.31" — licensed closes are not published; write "—"/);
    // A `<mult>×<level>` threshold: refused, the note quotes the whole string as the scrub prints it — and following the hint passes.
    const multiplied = { ...quoting, finding: "MOVE — > 1.3×73.39" };
    expect(() => applyRun(live, { signs: { ...unchanged(live).signs, ecb: multiplied }, situation: SIT }, TODAY)).toThrow(/patch\.signs\.ecb\.finding: quotes the licensed index level "MOVE 1\.3×73\.39" — licensed index levels are not published; print the threshold as the scrub does: "MOVE — > 95\.41"/);
    for (const [finding, hint] of [["MOVE — > 1.3×73.39", "MOVE — > 95.41"], ["MOVE trips at 1.3×73.39", "MOVE trips at —"], ["VIX 1.2x18.5 and rising", "VIX — and rising"]] as const) {
      const run = (f: string) => () => applyRun(live, { signs: { ...unchanged(live).signs, ecb: { ...quoting, finding: f } }, situation: SIT }, TODAY);
      expect(run(finding), finding).toThrow(`print the threshold as the scrub does: "${hint}"`);
      expect(run(hint), `following the hint for ${finding}`).not.toThrow();
    }
    const ev = { date: "2026-11-02", event: "spread", signs: ["ecb"], escalationIf: "CCC widens past the bear line", fizzleIf: "fizzle = CCC < 11.5 %", holds: ["T2" as const], secondary: false };
    const stated = { ...quoting, finding: "CCC — (above fizzle line)" };
    const sit = { ...SIT, decides: `${SIT.decides}, then the 11-02 print` };
    const ok = applyRun(live, { signs: { ...unchanged(live).signs, ecb: stated }, eventsAdd: [ev], situation: sit }, TODAY);
    expect(ok.next.signs[2]!.finding).toBe("CCC — (above fizzle line)");
    expect(ok.next.events.at(-1)!.fizzleIf).toBe("fizzle = CCC < 11.5 %");
  });
  it("lists every patch defect in one apply error, one per line — across rows, slots and checks within one row", () => {
    const live = fixture();
    const ecb = { label: "UNCHANGED 10-08", finding: "CCC 12.52 % (10-08 close) over the line", lean: "open", sources: [{ date: "2026-10-08", url: "https://ecb.example/10-08" }] };
    const patch = { signs: { ...unchanged(live).signs, ecb, doom: { label: "UNCHANGED 10-01" } }, situation: { ...SIT, lean: "BUND 137 bp (10-15 close)" } };
    const lines = [
      `situation.lean: carries a board number "(10-15 close)" — the board column prints the live reading; say it in words`,
      `patch.signs.ecb.finding: quotes the licensed index level "CCC 12.52 %" — licensed index levels are not published; write "—" or its state against the criterion (e.g. "CCC — (above fizzle line)")`,
      "doom: not on this run's research list",
      "ecb: lean only on CHANGED",
      `ecb: finding carries a board number "(10-08 close)" — the board column prints the live reading; say it in words (above the line, rising)`,
    ];
    expect(() => applyRun(live, patch, TODAY)).toThrow(expect.objectContaining({ message: `eufin:apply — ${lines.join("\n")}` }));
  });
  it("a mis-shaped patch unit is a listed defect, never a TypeError: a typo'd `signs`, a non-object calendar entry (on a real row)", () => {
    const live = fixture();
    const typo = [`patch: "sign" is not writable here (signs, events, eventsAdd, calendar, calendarAdd, situation)`, "patch: signs is an object of row patches ({} when none)"];
    expect(() => applyRun(live, { sign: {} } as never, TODAY)).toThrow(expect.objectContaining({ message: `eufin:apply — ${typo.join("\n")}` }));
    expect(() => applyRun(live, { ...unchanged(live), calendar: { far: "drop" } } as never, TODAY)).toThrow(/^eufin:apply — (.*\n)*calendar "far": is not an object$/m);
  });
  it("stamps runAt from `at`, drops a stale one on a backfill (no `at`), and refuses a non-instant", () => {
    const live = fixture();
    const stamped = applyRun(live, unchanged(live), TODAY, "eufin", undefined, "2026-10-08T13:37:00.000Z").next;
    expect(stamped.runAt).toBe("2026-10-08T13:37:00.000Z");
    expect("runAt" in applyRun(stamped, unchanged(stamped), TODAY).next).toBe(false);
    expect(() => applyRun(live, unchanged(live), TODAY, "eufin", undefined, "2026-10-08")).toThrow(/at "2026-10-08" is not an ISO instant/);
  });
  it("runStamp stamps a run whose --today is now's local date (the skills' path) and none on a backfill", () => {
    const now = new Date("2026-10-08T12:00:00.000Z");
    expect(runStamp(now.toLocaleDateString("sv-SE"), now)).toBe("2026-10-08T12:00:00.000Z");
    expect(runStamp("2026-10-07", now)).toBeUndefined();
  });
  it("writes the researched fields, labels held rows, keeps sources in-window, counts fetch failures, and never mutates its input", () => {
    const live = fixture();
    const before = JSON.stringify(live);
    const p = unchanged(live);
    p.signs.rating = { label: "CHANGED", finding: "new fact, 10-08", lean: "mixed", sources: [{ date: "2026-10-08", url: "https://x.example/u8" }, { date: "2026-09-01", url: "https://x.example/old" }], failed: ["https://rating.example/list"] };
    p.signs.weekly = { label: "QUIET since 09-17" };
    p.situation = SIT; // a CHANGED row owes the situation
    const { next } = applyRun(live, p, TODAY);
    expect(JSON.stringify(live)).toBe(before);
    const by = new Map(next.signs.map((s) => [s.sign, s]));
    expect(by.get("rating")).toMatchObject({ label: "CHANGED", finding: "new fact, 10-08", lean: "mixed", checked: TODAY, due: "2026-10-15", fails: { "https://rating.example/list": 1 } });
    expect(by.get("rating")!.sources.map((s) => s.url)).toEqual(["https://x.example/u8", "https://rating.example/1"]);
    expect(by.get("weekly")).toMatchObject({ label: "QUIET since 09-17", checked: TODAY, due: "2026-10-15", finding: "weekly fact" });
    expect(by.get("weekly")!.sources.map((s) => s.date)).toEqual(["2026-10-01"]);
    const daily = fixture();
    daily.signs.find((s) => s.sign === "weekly")!.cadence = 1;
    expect(applyRun(daily, p, TODAY).next.signs.find((s) => s.sign === "weekly")!.due).toBe("2026-10-09");
    expect(by.get("doom")).toMatchObject({ label: "HELD until 2026-10-14", checked: "2026-10-07" });
    expect(by.get("earnings")!.label).toBe("NOT DUE until 2026-10-22");
    const reDue = { ...next, signs: next.signs.map((s, i) => (i === 0 ? { ...s, due: "2026-10-09" } : s)) }; // rating's event is far → it is on cadence; pull it due
    const again = applyRun(reDue, unchanged(reDue, "2026-10-09"), "2026-10-09");
    expect(again.next.signs[0]!.fails).toBeUndefined();
    const failTwice = (l: LadderLive, d: string) => applyRun(l, { signs: { ...unchanged(l, d).signs, ecb: { label: "UNSOURCED", failed: ["https://ecb.example/list"] } }, situation: sitFor(l, d) }, d).next;
    live.signs[2]!.cadence = 1; // ecb's event is 3 weeks out → on cadence; daily keeps it on each run's list
    const dead = failTwice(failTwice(live, TODAY), "2026-10-09");
    dead.situation!.decides = sitFor(dead, "2026-10-10")!.decides!;
    const row = planRun(dead, "2026-10-10").research.find((r) => r.sign === "ecb")!;
    expect(row).toMatchObject({ fetch: [], primary: ["https://ecb.example/list"], replace: ["https://ecb.example/list"] });
    expect(() => applyRun(dead, { signs: { ...unchanged(dead, "2026-10-10").signs, ecb: { label: "UNSOURCED", primary: ["https://ecb.example/new", "https://y"] } } }, "2026-10-10")).toThrow(/primary only swaps/);
    const swap = applyRun(dead, { signs: { ...unchanged(dead, "2026-10-10").signs, ecb: { label: "UNSOURCED", primary: ["https://ecb.example/new"] } } }, "2026-10-10").next;
    expect(swap.signs[2]).toMatchObject({ primary: ["https://ecb.example/new"] });
    expect(swap.signs[2]!.fails).toBeUndefined();
    expect(() => applyRun(dead, { signs: { ...unchanged(dead, "2026-10-10").signs, ecb: { label: "UNSOURCED", primary: ["https://finance.yahoo.com/q"] } } }, "2026-10-10")).toThrow('ecb: primary swap-in "https://finance.yahoo.com/q" is on a market-data vendor host (yahoo.com)');
    // ladder-skill-kaizen-critique applySign: a failed page may be dropped, never to an empty list; an appended page is neither a swap nor a drop
    const two = { ...dead, signs: dead.signs.map((s, i) => (i === 2 ? { ...s, primary: [...s.primary, "https://ecb.example/two"] } : s)) };
    const drop = applyRun(two, { signs: { ...unchanged(two, "2026-10-10").signs, ecb: { label: "UNSOURCED", primary: ["https://ecb.example/two"] } } }, "2026-10-10").next;
    expect(drop.signs[2]).toMatchObject({ primary: ["https://ecb.example/two"] });
    expect(drop.signs[2]!.fails).toBeUndefined();
    expect(() => applyRun(two, { signs: { ...unchanged(two, "2026-10-10").signs, ecb: { label: "UNSOURCED", primary: ["https://ecb.example/two", "https://y"] } } }, "2026-10-10")).toThrow(/primary only swaps/);
    expect(() => applyRun(dead, { signs: { ...unchanged(dead, "2026-10-10").signs, ecb: { label: "UNSOURCED", primary: [] } } }, "2026-10-10")).toThrow(/would leave none/);
  });
  it("state prints the row's full primary[] beside replace; the skill's in-place swap built off it round-trips through apply (R2)", () => {
    const live = fixture();
    live.signs[2]!.cadence = 1;
    live.signs[2]!.primary = ["https://ecb.example/list", "https://ecb.example/two"];
    live.signs[2]!.fails = { "https://ecb.example/list": 2 };
    const row = planRun(live, TODAY).research.find((r) => r.sign === "ecb")!;
    const NEW = "https://ecb.example/new";
    const p = unchanged(live);
    p.signs.ecb = { label: "UNSOURCED", primary: row.primary.map((u) => (u === row.replace[0] ? NEW : u)) };
    expect(applyRun(live, p, TODAY).next.signs[2]!.primary).toEqual([NEW, "https://ecb.example/two"]);
  });
  it("a row source dated after today, or not YYYY-MM-DD, is refused — it would pass a newest-date gate (causeFalse, a sourced lean) on a date no page bears yet", () => {
    const live = fixture();
    const ecb = (date: string) => () => applyRun(live, { signs: { ...unchanged(live).signs, ecb: { label: `UNCHANGED ${TODAY.slice(5)}`, sources: [{ date, url: "https://x.example/u" }] } } }, TODAY);
    expect(ecb(addDays(TODAY, 1))).toThrow(`ecb source: date ${addDays(TODAY, 1)} is after today ${TODAY}`);
    expect(ecb("Oct 9"), "exactly one note — a non-ISO date never also reads as after today").toThrow(/^\S+:apply — ecb source: date "Oct 9" is not YYYY-MM-DD$/);
    expect(ecb(TODAY)).not.toThrow();
  });
  it("a dated label dates the NEWEST source — apply writes it when absent, rewrites a wrong one with a warn line — needs one (patched or held in-window), and a STALE row keeps its newest patched source when the window empties; UNSOURCED carries none", () => {
    const live = fixture();
    const run = (patch: LadderPatch["signs"][string], l = live) => applyRun(l, { signs: { ...unchanged(l).signs, ecb: patch } }, TODAY);
    const ecb = (patch: LadderPatch["signs"][string], l = live) => run(patch, l).next.signs[2]!;
    const u5 = [{ date: "2026-10-05", url: "https://x.example/u5" }];
    for (const given of ["10-01", "10-20"]) {
      const { next, delta } = run({ label: `UNCHANGED ${given}`, sources: u5 });
      expect([next.signs[2]!.label, delta.filter((l) => l.startsWith("warn "))]).toEqual(["UNCHANGED 10-05", [`warn ecb — label date ${given} → 10-05`]]);
    }
    const { next: dateless, delta: quiet } = run({ label: "UNCHANGED", sources: u5 });
    expect([dateless.signs[2]!.label, quiet.some((l) => l.startsWith("warn "))], "an absent date is written silently").toEqual(["UNCHANGED 10-05", false]);
    expect(ecb({ label: "UNCHANGED 10-05", sources: u5 }).sources.map((x) => x.url)).toEqual(["https://x.example/u5", "https://ecb.example/1"]);
    expect(() => ecb({ label: "STALE", sources: u5 }), "a class error still refuses").toThrow(/ecb: STALE but the newest source 2026-10-05 is in-window/);
    const bare = { ...live, signs: live.signs.map((s) => (s.sign === "ecb" ? { ...s, sources: [] } : s)) };
    const old = [{ date: "2026-03-18", url: "https://x.example/old" }];
    const stale = run({ label: "STALE", finding: "x", sources: old }, bare);
    expect([stale.next.signs[2]!.label, stale.next.signs[2]!.finding, stale.delta.filter((l) => l.startsWith("warn "))]).toEqual(["STALE 03-18", bare.signs[2]!.finding, ["warn ecb — finding dropped: only on CHANGED or UNCHANGED"]]);
    const inWin = run({ label: "UNCHANGED", sources: u5, searchNext: "ecb hike odds" });
    expect([inWin.next.signs[2]!.searchNext, inWin.delta.filter((l) => l.startsWith("warn "))]).toEqual([undefined, ["warn ecb — searchNext dropped: the row holds an in-window source"]]);
    expect(() => ecb({ label: "UNCHANGED 10-01" }, bare)).toThrow(/ecb: UNCHANGED 10-01 needs a source/);
    expect(() => ecb({ label: "CHANGED", finding: "f", lean: "open" }, bare)).toThrow(/ecb: CHANGED needs a source/);
    expect(() => ecb({ label: "UNSOURCED", sources: [{ date: "2026-10-05", url: "https://x.example/u5" }] }, bare)).toThrow(/ecb: UNSOURCED carries no source/);
    expect(ecb({ label: "STALE 03-18", sources: [{ date: "2026-03-18", url: "https://x.example/old" }, { date: "2026-02-01", url: "https://x.example/older" }] }, bare).sources).toEqual([{ date: "2026-03-18", url: "https://x.example/old" }]);
    expect(planRun(bare, TODAY).research.find((r) => r.sign === "ecb")!.held).toBeNull();
  });
  it("a URL cited again keeps its NEWEST date — a re-dated patch beats the held entry, a stale patch never reverts it (R1)", () => {
    const live = fixture();
    const ecb = (patch: LadderPatch["signs"][string], l = live) => applyRun(l, { signs: { ...unchanged(l).signs, ecb: patch } }, TODAY).next.signs[2]!;
    expect(ecb({ label: "UNCHANGED 10-05", sources: [{ date: "2026-10-05", url: "https://ecb.example/1" }] }).sources).toEqual([{ date: "2026-10-05", url: "https://ecb.example/1" }]);
    const held = { ...live, signs: live.signs.map((s) => (s.sign === "ecb" ? { ...s, label: "UNCHANGED 10-05", sources: [{ date: "2026-10-05", url: "https://ecb.example/1" }] } : s)) };
    expect(ecb({ label: "UNCHANGED 10-05", sources: [{ date: "2026-10-01", url: "https://ecb.example/1" }] }, held).sources).toEqual([{ date: "2026-10-05", url: "https://ecb.example/1" }]);
  });
  it("replaces the same-day runs row off the reverdict when given, keeps 5, sets unlanded event statuses and drops passed calendar rows", () => {
    const live = fixture();
    const { next } = applyRun(live, unchanged(live), TODAY);
    expect(next.runs.map((r) => r.date)).toEqual([TODAY, "2026-10-06", "2026-10-05", "2026-10-04", "2026-10-03"]);
    expect(next.runs[0]).toEqual({ date: TODAY, t1: "5/6 ✓", t2: "5/6 ✓", t3: "1/6 ✗", live: "✓✗✗ prov." });
    const shut = (n: LadderLive) => ({ ...n.verdict!, tranches: n.verdict!.tranches.map((t) => ({ ...t, ok: false })) });
    const re = applyRun(live, unchanged(live), TODAY, "value", shut);
    expect([re.next.runs[0]!.t1, re.next.verdict!.tranches[0]!.ok]).toEqual(["5/6 ✗", false]);
    expect(re.delta[0]).toContain("after holds: T1 ✗ · T2 ✗ · T3 ✗");
    expect(next.calendar.map((c) => c.event)).toEqual(["S&P UK", "far"]);
    const later = applyRun(next, { ...unchanged(next, "2026-10-10"), situation: { decides: sitFor(next, "2026-10-10")!.decides } }, "2026-10-10").next;
    expect(later.events.map((e) => e.status)).toEqual(["NOT DUE until 2026-10-23", "DELAY — outcome unsourced", "NOT DUE until 2026-10-29"]);
    const after = applyRun(later, { ...unchanged(later, "2026-10-30"), situation: sitFor(later, "2026-10-30") }, "2026-10-30").next; // asOf 10-07 is > 7 days old
    expect(after.events.map((e) => e.status)).toEqual(["DELAY — outcome unsourced", "DELAY — outcome unsourced", "outcome unsourced"]);
    expect(() => applyRun(live, { ...unchanged(live), events: { Votes: { status: "passed" } } }, TODAY)).toThrow(/landed outcome/);
  });
});

describe("applyRun alert", () => {
  // This run's row off fixture()'s verdict: 5/6 ✓ · 5/6 ✓ · 1/6 ✗ · live ✓✗✗.
  const since = (over: Partial<LadderLive["runs"][number]> = {}): LadderLive => ({ ...fixture(), runs: [{ date: "2026-10-07", t1: "5/6 ✓", t2: "5/6 ✓", t3: "1/6 ✗", live: "✓✗✗ prov.", ...over }] });
  it("pushes close flips at 4 and a live-only flip at 2 vs runs[0]; count-only moves, glyph-less rows and same-day re-runs stay silent", () => {
    const flip = since({ t1: "1/6 ✗", t3: "6/6 ✓" });
    const first = applyRun(flip, { ...unchanged(flip), situation: SIT }, TODAY);
    expect(first.alert).toMatchObject({ title: "EU-Fin: T1 now OK, T3 lost OK", priority: 4 });
    expect(first.alert!.body).toBe("Tranches: T1 ✗ → ✓ 5/6 · T2 ✓ 5/6 (held until 23 Oct) · T3 ✓ → ✗ 1/6");
    expect(applyRun(first.next, unchanged(first.next), TODAY).alert).toBeUndefined();
    expect(applyRun(since({ live: "✗✗✗" }), unchanged(since()), TODAY).alert).toMatchObject({ title: "EU-Fin: live T1 now OK", priority: 2 });
    expect(applyRun(since({ t3: "3/6 ✗" }), unchanged(since()), TODAY).alert).toBeUndefined();
    // T2 is held by the pending Votes/Moody's events.
    expect(applyRun(since({ t2: "1/6 ✗" }), { ...unchanged(since()), situation: SIT }, TODAY).alert).toMatchObject({ title: "EU-Fin: T2 now OK (held)", priority: 3 });
    expect(applyRun(fixture(), unchanged(fixture()), TODAY).alert).toBeUndefined();
  });
  it("pushes a BLOCK on/off at 4 (the title names its escalation, the body line its lift contract) or a landed event at 3, with an ASCII-only title", () => {
    const live = since();
    const [row] = researched(live);
    const on = applyRun(live, { signs: { ...unchanged(live).signs, [row!]: { label: "UNCHANGED 10-01", block: true, unblocking: "affirmed" } } }, TODAY, "value");
    expect(on.alert).toMatchObject({ title: `Value: ${row} BLOCK, tranches unchanged`, priority: 4 });
    expect(on.alert!.body.split("\n")).toContain(`${row}  lean open (single-source) · BLOCK (new) since 10-08 · lifts on: Moody's 10-23 fizzle · UNBLOCKING clause · a sourced fizzle-leaning or fizzle lean`);
    const blocked = since();
    blocked.signs.find((s) => s.sign === row)!.block = true;
    expect(applyRun(blocked, { signs: { ...unchanged(blocked).signs, [row!]: { label: "UNCHANGED 10-01", block: false } } }, TODAY).alert?.title).toBe(`EU-Fin: ${row} unblocked, tranches unchanged`);
    live.events[2]!.event = "ECB – Oct";
    const landed = applyRun(live, land(live, { "ECB – Oct": "fizzle: pause, 10-08" }), TODAY);
    expect(landed.alert).toMatchObject({ title: "EU-Fin: ECB - Oct fizzle, tranches unchanged", priority: 3 });
    expect(applyRun(landed.next, { ...unchanged(landed.next), events: { "ECB – Oct": { status: "fizzle: pause, 10-08" } } }, TODAY).alert).toBeUndefined(); // a re-stated landed status: no push, no situation owed
    const hot = structuredClone(live);
    hot.signs.find((s) => s.sign === "budget")!.lean = "escalation-leaning"; // an escalation-group call blocks
    const hotLand = land(hot, { Votes: "escalation: censure, 10-08" });
    hotLand.events!.Votes!.liftBy = ["Moody's"];
    const esc = applyRun(hot, hotLand, TODAY).alert;
    expect(esc).toMatchObject({ title: "EU-Fin: budget BLOCK (Votes), Votes escalation, tranches unchanged", priority: 4 });
    expect(esc!.body.split("\n").slice(0, 4)).toEqual(["budget  lean escalation-leaning · BLOCK (new) since 10-08 (Votes) · lifts on: Moody's 10-23 fizzle · a sourced fizzle-leaning or fizzle lean", "  was: budget fact", "  now: after Votes, 2026-10-08", "Votes (9 Oct): escalation: censure, 10-08 · called: budget=escalation-leaning · holds T2/T3"]); // the rewritten finding prints was:/now:
    const fizzled = applyRun(live, land(live, { Votes: "fizzle: deal, 10-08" }), TODAY).alert;
    expect(fizzled!.body.split("\n").filter((l) => !/^  (was|now):/.test(l)).slice(0, 3)).toEqual(["budget  lean open · no block", "  hold: waits on Votes (9 Oct) → none", "Votes (9 Oct): fizzle: deal, 10-08 · called: budget=open · holds T2/T3"]);
  });
  it("a lean move pushes at 3 — never one into unknown, unknown → neutral, a date-only move or a same-lean CHANGED", () => {
    const live = since();
    const [row, churn] = researched(live);
    live.signs.find((s) => s.sign === row)!.measurable = "bear = a (x; y); fizzle = b; note";
    const moveTo = (from: string, to: string) => {
      live.signs.find((s) => s.sign === row)!.lean = from;
      return applyRun(live, { signs: { ...unchanged(live).signs, [churn!]: { label: "UNCHANGED 10-05", sources: [{ date: "2026-10-05", url: `https://${churn}.example/10-05` }] }, [row!]: { label: "CHANGED", finding: "x, 10-08", lean: to } }, situation: SIT }, TODAY).alert;
    };
    const moved = moveTo("open", "escalation-leaning");
    expect(moved).toMatchObject({ title: `EU-Fin: ${row} open->escalation-leaning, tranches unchanged`, priority: 3 });
    expect(moved!.body.split("\n")).toEqual([
      `${row}  lean open → escalation-leaning · no block`,
      `  was: ${row} fact`,
      "  now: x, 10-08",
      "Tranches: no change — T1 ✓ 5/6 · T2 ✓ 5/6 (held until 23 Oct) · T3 ✗ 1/6",
      "Watch:",
      `  ${row}: bear if a (x; y)`,
      `  ${row}: fizzle if b; note`,
      "  23 Oct Moody's — holds T2/T3; escalates if cut",
    ]);
    expect(moveTo("unknown", "escalation-leaning")?.title).toBe(`EU-Fin: ${row} unknown->escalation-leaning, tranches unchanged`);
    expect(moveTo("unknown", "fizzle-leaning")?.title).toBe(`EU-Fin: ${row} unknown->fizzle-leaning, tranches unchanged`);
    // unknown → the whole neutral group is silent (open / mixed here, neutral on the US legs), not only unknown → neutral
    for (const [from, to] of [["open", "open"], ["unknown", "open"], ["unknown", "mixed"], ["quiet", "unknown"], ["unknown until 2026-10-22", "unknown until 2026-10-27"]]) expect(moveTo(from!, to!)).toBeUndefined();
  });
});

describe("applyRun — drawdown watch", () => {
  // fixture()'s verdict this run: no tranche flips vs `runs[0]` below, so only the watch can push.
  const at = (was: string | undefined, cells?: Parameters<typeof injectWatch>[1]): LadderLive => injectWatch({ ...fixture(), runs: [{ date: "2026-10-07", t1: "5/6 ✓", t2: "5/6 ✓", t3: "1/6 ✗", live: "✓✗✗ prov.", ...(was && { watch: was }) }] }, cells);
  it("stores the grade on the run row and the delta head only with a verdict.watch", () => {
    const { next, delta } = applyRun(at(undefined), unchanged(at(undefined)), TODAY);
    expect([next.runs[0]!.watch, delta[0]!.endsWith(" · watch ELEVATED")]).toEqual(["ELEVATED", true]);
    const bare = applyRun(fixture(), unchanged(fixture()), TODAY);
    expect(["watch" in bare.next.runs[0]!, bare.delta[0]!.includes("watch")]).toEqual([false, false]);
  });
  it("a grade move either way pushes at 3 (same-day re-run dedupes); same grade, a ` (thin)`-only move or no prior grade stay silent", () => {
    const rewrite = (l: LadderLive): LadderPatch => ({ ...unchanged(l), situation: SIT });
    const up = applyRun(at("CALM"), rewrite(at("CALM")), TODAY);
    expect(up.alert).toMatchObject({ title: "EU-Fin: watch CALM->ELEVATED, tranches unchanged", priority: 3 });
    expect(up.alert!.body).toContain("Drawdown watch: CALM → ELEVATED (correction votes credit)");
    expect(applyRun(at("SEVERE"), rewrite(at("SEVERE")), TODAY).alert?.title).toBe("EU-Fin: watch SEVERE->ELEVATED, tranches unchanged");
    const thin = at("HIGH");
    thin.verdict!.watch!.grade = "ELEVATED (thin)"; // a quorum loss, not a calm: the title keeps the tag
    expect(applyRun(thin, rewrite(thin), TODAY).alert?.title).toBe("EU-Fin: watch HIGH->ELEVATED (thin), tranches unchanged");
    const wasThin = at("HIGH (thin)");
    expect(applyRun(wasThin, rewrite(wasThin), TODAY).alert?.title).toBe("EU-Fin: watch HIGH (thin)->ELEVATED, tranches unchanged");
    expect(applyRun(up.next, unchanged(up.next), TODAY).alert).toBeUndefined();
    expect(renderLadderMd({ ...up.next, verdict: { ...up.next.verdict!, legs: [], escalation: { tripped: 0, need: 2, hits: [] } } }, "eufin")).toContain("_grades, last 5 runs: 10-08 ELEVATED · 10-07 CALM_");
    for (const was of ["ELEVATED", "ELEVATED (thin)", undefined]) expect(applyRun(at(was), unchanged(at(was)), TODAY).alert, String(was)).toBeUndefined();
  });
  it("a watch-grade word change owes the situation; a ` (thin)`-only move does not", () => {
    expect(planRun(at("HIGH"), TODAY).situationWhy).toEqual(["all: watch HIGH → ELEVATED"]);
    expect(() => applyRun(at("HIGH"), unchanged(at("HIGH")), TODAY)).toThrow(/situation not rewritten — write all five slots \(lean, slow, fast, decides, flips\): watch HIGH → ELEVATED\.$/m);
    expect(() => applyRun(at("HIGH"), { ...unchanged(at("HIGH")), situation: { fast: "c" } }, TODAY)).toThrow(/situation: a partial patch, but a rewrite trigger fired \(watch HIGH → ELEVATED\)/);
    const thin = at("HIGH");
    thin.verdict!.watch!.grade = "HIGH (thin)";
    expect(planRun(thin, TODAY).situationWhy).toBeUndefined();
    expect(() => applyRun(thin, unchanged(thin), TODAY)).not.toThrow();
  });
  it("a watch-less newest row (degraded probe) is skipped: the move is vs the newest graded row; no graded row anywhere stays silent", () => {
    const behind = (older: string | undefined): LadderLive => {
      const l = at(undefined);
      return { ...l, runs: [l.runs[0]!, { ...l.runs[0]!, date: "2026-10-06", ...(older && { watch: older }) }] };
    };
    expect(planRun(behind("CALM"), TODAY).situationWhy).toEqual(["all: watch CALM → ELEVATED"]);
    expect(() => applyRun(behind("CALM"), unchanged(behind("CALM")), TODAY)).toThrow(/: watch CALM → ELEVATED\.$/m);
    const skipped = applyRun(behind("CALM"), { ...unchanged(behind("CALM")), situation: SIT }, TODAY).alert;
    expect([skipped?.title, skipped?.priority, skipped?.body.includes("Drawdown watch: CALM → ELEVATED")]).toEqual(["EU-Fin: watch CALM->ELEVATED, tranches unchanged", 3, true]);
    expect(applyRun(behind(undefined), unchanged(behind(undefined)), TODAY).alert).toBeUndefined();
  });
});

describe("applyEcho — `<leg>:apply`'s stdout", () => {
  const size = (lines: string[]) => new TextEncoder().encode(lines.join("\n")).length;
  it("a fixture run's overflowing delta prints as its head + the md pointer + the push line within APPLY_ECHO_MAX bytes; a short one prints whole", () => {
    const live = fixture();
    const ecb = { label: "CHANGED", finding: `the council signalled a hike, ${"the minutes stress sticky services inflation and wage pressure, ".repeat(12)}ECB 10-08`, lean: "escalation-leaning", sources: [{ date: TODAY, url: "https://ecb.example/10-08" }] };
    const run = applyRun(live, { signs: { ...unchanged(live).signs, ecb }, situation: SIT }, TODAY);
    const push = `ntfy     pushed — ${run.alert!.title}`;
    expect(size([...run.delta, push]), "the fixture overflows the cap").toBeGreaterThan(APPLY_ECHO_MAX);
    const echo = applyEcho(run.delta, LEGS.eufin.md, push);
    expect(echo).toEqual([run.delta[0], `delta in ${LEGS.eufin.md}`, push]);
    expect(size(echo)).toBeLessThanOrEqual(APPLY_ECHO_MAX);
    const long = applyEcho(run.delta, LEGS.eufin.md, `ntfy     pushed — ${"x".repeat(900)}`);
    expect([size(long), long[0]], "an overlong push line is clipped, the head kept").toEqual([APPLY_ECHO_MAX, run.delta[0]]);
    const warned = applyRun(live, { signs: { ...unchanged(live).signs, ecb: { ...ecb, searchNext: "ecb hike odds" } }, situation: SIT }, TODAY).delta;
    expect(applyEcho(warned, LEGS.eufin.md, push).slice(1), "apply's warn lines survive the cut").toEqual(["warn ecb — searchNext dropped: the row holds an in-window source", `delta in ${LEGS.eufin.md}`, push]);
    const quiet = applyRun(live, unchanged(live), TODAY).delta;
    expect(applyEcho(quiet, LEGS.eufin.md)).toEqual(quiet);
  });
});

describe("fitBody", () => {
  it("keeps the push under ntfy's limit: full → Watch pointer → clipped was/now → change lines cut, never the tranche impact", () => {
    const size = (lines: string[]): number => new TextEncoder().encode(lines.join("\n")).length;
    const x = (n: number): string => "✓".repeat(n);
    const imp = ["Tranches: no change — T1 ✓ 5/6"];
    const watch = [`  a: bear if ${x(1500)}`];
    expect(fitBody(["r"], imp, ["  w"], "docs/x.md")).toEqual(["r", ...imp, "Watch:", "  w"]);
    expect(fitBody(["r"], imp, watch, "docs/x.md")).toEqual(["r", ...imp, "Watch: in docs/x.md"]);
    expect(fitBody(["r", `  was: ${x(1000)}`, `  now: ${x(1000)}`], imp, watch, "docs/x.md")).toEqual(["r", `  was: ${x(153)}…`, `  now: ${x(153)}…`, ...imp, "Watch: in docs/x.md"]);
    const cut = fitBody(Array.from({ length: 40 }, (_, i) => [`row ${i}`, `  was: ${x(400)}`, `  now: ${x(400)}`]).flat(), imp, watch, "docs/x.md");
    const kept = cut.slice(0, -2);
    expect(size(cut)).toBeLessThanOrEqual(NTFY_BODY_MAX);
    expect(size(cut)).toBeGreaterThan(NTFY_BODY_MAX - 1000);
    // whole items only, each was/now clipped, the footer counting the items cut
    expect(kept.map((l) => l.slice(0, 6))).toEqual(Array.from({ length: kept.length / 3 }, () => ["row ", "  was:", "  now:"]).flat().map((p, i) => (i % 3 ? p : kept[i]!.slice(0, 6))));
    expect(kept.filter((l) => l.startsWith("  ")).every((l) => l.endsWith("…"))).toBe(true);
    expect(cut.slice(-2)).toEqual([`… ${40 - kept.length / 3} more items in docs/x.md`, ...imp]);
    expect(fitBody(["r", `  was: ${"a".repeat(152)}😀`, `  now: ${x(1400)}`], imp, [], "docs/x.md")[1]).toBe(`  was: ${"a".repeat(152)}…`);
  });
});

describe("tags + after holds", () => {
  it("a pending holding event delays its rows and holds a probe ✓ until its latest date; ✗ stays ✗; a secondary event holds nothing", () => {
    const live = fixture();
    expect(live.signs.map((s) => tagOf(live, s, TODAY))).toEqual(["DELAY until 23 Oct (Moody's)", "DELAY until 9 Oct (Votes)", "CLEAR", "CLEAR", "CLEAR", "CLEAR"]);
    expect(live.verdict!.tranches.map((t) => afterHolds(live, TODAY, t))).toEqual(["✓", "HELD until 23 Oct", "✗"]);
    expect(afterHolds(live, "2026-10-24", live.verdict!.tranches[1]!)).toBe("HELD — outcome unsourced");
  });
  it("an escalation outcome or a block flag makes BLOCK, which holds every ✓ tranche on a blockReach-all leg; elsewhere the escalated event holds its own tranches; a fizzle releases its hold", () => {
    const live = fixture();
    live.signs[1]!.lean = "escalation-leaning"; // budget: an escalation-group call blocks
    const p = land(live, { "Moody's": "fizzle: affirmed Aa3, 2026-10-08", Votes: "escalation: censure passed, 2026-10-08" });
    p.events!.Votes!.liftBy = ["Moody's"];
    const { next, delta } = applyRun(live, p, TODAY);
    expect(tagOf(next, next.signs[0]!, TODAY)).toBe("CLEAR");
    expect(tagOf(next, next.signs[1]!, TODAY)).toBe("BLOCK");
    expect(afterHolds(next, TODAY, live.verdict!.tranches[0]!)).toBe("HELD (BLOCK: budget)");
    expect(afterHolds(next, TODAY, live.verdict!.tranches[0]!, "value")).toBe("✓");
    expect(afterHolds(next, TODAY, live.verdict!.tranches[1]!, "value")).toBe("HELD (ESCALATION: Votes)");
    expect(delta[0]).toBe("EU-Fin 2026-10-08 · fast set · after holds: T1 HELD (BLOCK: budget) · T2 HELD (BLOCK: budget) · T3 ✗ · live HELD (BLOCK: budget) ✗ ✗ (prov.)");
    expect(delta).toContain("events   Moody's — NOT DUE until 2026-10-23 → fizzle: affirmed Aa3, 2026-10-08 · called: rating=open");
    const reversed = applyRun(next, { signs: { ...unchanged(next, "2026-10-09").signs, budget: { label: "UNCHANGED 10-09", block: false, sources: [{ date: "2026-10-09", url: "https://budget.example/10-09" }] } } }, "2026-10-09").next;
    expect(tagOf(reversed, reversed.signs[1]!, "2026-10-09")).toBe("CLEAR");
  });
  it("mixed: is a third landed outcome — the patch vet takes it, it sets no block, its tranches stay HELD (MIXED), allFizzled stays fizzle-only", () => {
    const live = fixture();
    const status = "mixed: deal passed, 10-08 — unchecked: censure motion tally"; // the TSMC-shaped status: landed, one escalation-side clause unsourced
    const { next, delta, alert } = applyRun(live, land(live, { Votes: status }), TODAY);
    expect(next.signs[1]!.block).toBe(false); // no block — the escalation's alone
    expect(tagOf(next, next.signs[1]!, TODAY)).toBe("MIXED (Votes)"); // landed, never DELAY — and never CLEAR while its tranches stay HELD
    expect([afterHolds(next, TODAY, live.verdict!.tranches[1]!, "value"), afterHolds(next, TODAY, live.verdict!.tranches[0]!, "value")]).toEqual(["HELD (MIXED: Votes)", "✓"]);
    // unresolved: the mixed: event's row stays under research every run (off its cadence, with the extended search) until it re-lands
    const later = planRun(next, "2026-10-12");
    expect([later.research.find((r) => r.sign === "budget")?.extended, later.kept.filter((k) => k.startsWith("budget "))]).toEqual([true, []]);
    expect(alert!.body).toContain("  hold: waits on Votes (9 Oct) → waits on Votes — a clause still unchecked");
    const votes = next.events.filter((e) => e.event === "Votes");
    expect([allFizzled(votes, "T2", "2026-10-09"), allFizzled([{ ...votes[0]!, status: "fizzle: deal, 10-08" }], "T2", "2026-10-09")]).toEqual([false, true]); // the T2 fast fill never reads mixed as fizzle
    expect(delta).toContain(`events   Votes — NOT DUE until 2026-10-09 → ${status} · called: budget=open`);
    expect(alert!.title).toBe("EU-Fin: Votes mixed, tranches unchanged");
    expect(alert!.body).toContain(`Votes (9 Oct): ${status} · called: budget=open · holds T2/T3`);
    expect(applyRun(next, unchanged(next, "2026-10-09"), "2026-10-09").next.events[1]!.status).toBe(`${status} · called: budget=open`); // landed: the next apply does not recompute it to pending
    expect(() => applyRun(live, land(live, { Votes: "split: deal, 10-08" }), TODAY)).toThrow(/a patch status is a landed outcome \(escalation: \/ fizzle: \/ mixed:\)/);
    // the grammar: a mixed: names its unchecked clause; a fizzle: that self-reports an unverified clause is a mixed:
    for (const bad of ["mixed: deal passed, 10-08", "mixed: deal passed, 10-08 — unchecked: "]) expect(() => applyRun(live, land(live, { Votes: bad }), TODAY), bad).toThrow(/event "Votes": a mixed: status is `mixed: <outcome, date> — unchecked: <clause>`/);
    for (const bad of ["fizzle: deal, 10-08 — tally unverified", "fizzle: deal, 10-08 (UNCHECKED: tally)", "fizzle: deal, 10-08; tally Not Re-Sourced"]) expect(() => applyRun(live, land(live, { Votes: bad }), TODAY), bad).toThrow(/event "Votes": a fizzle: with an unverified clause is a mixed:/);
  });
  it("the delta prints only rows whose tag, label or finding moved (a rewritten finding inline), every BLOCK row, and the re-read line after a CHANGED cell", () => {
    const live = fixture();
    const quiet = applyRun(live, unchanged(live), TODAY).delta;
    expect(quiet.slice(1)).toEqual(["HELD     doom — CLEAR — HELD until 2026-10-14", "NOT      earnings — CLEAR — NOT DUE until 2026-10-22"]);
    expect(applyRun(live, { signs: { ...unchanged(live).signs, ecb: { label: "UNCHANGED 10-08", finding: "hold reaffirmed, 10-08", sources: [{ date: "2026-10-08", url: "https://ecb.example/10-08" }] } } }, TODAY).delta).toContain("UNCHANGED ecb — CLEAR — UNCHANGED 10-08: hold reaffirmed, 10-08");
    const bare = unchanged(live);
    bare.signs.ecb = { label: "CHANGED", finding: "hike priced, 10-08", lean: "escalation-leaning" };
    expect(() => applyRun(live, bare, TODAY)).toThrow(/^eufin:apply — situation not rewritten — write all five slots \(lean, slow, fast, decides, flips\): CHANGED row\.$/);
    const p = { ...bare, situation: { lean: "a", slow: "b", fast: "c", decides: DECIDES, flips: "x" } };
    const { delta } = applyRun(live, p, TODAY);
    expect(delta).toContain("CHANGED  ecb — CLEAR — CHANGED: hike priced, 10-08");
    const next = applyRun(live, p, TODAY).next;
    expect(applyRun(next, unchanged(next), TODAY).delta.some((l) => /not rewritten/.test(l))).toBe(false);
    expect(applyRun(next, unchanged(next), TODAY, "value").delta[0]).toMatch(/^Value 2026-10-08 · fast set · after holds: /);
    const soon = { ...next, events: next.events.map((e) => (e.event === "ECB" ? { ...e, date: "2026-10-16" } : e)) }; // inside the 7-day eventWatch window → due again next day
    const day2 = { signs: { ...unchanged(soon, "2026-10-09").signs, ecb: { label: "CHANGED", finding: "hike done, 10-09", lean: "escalation-leaning", sources: [{ date: "2026-10-09", url: "https://ecb.example/10-09" }] } }, situation: SIT }; // R3: ecb's 10-01 source is out of the 10-09 window (10-02), so the CHANGED cites its own
    expect(applyRun(soon, day2, "2026-10-09").delta).toContain("CHANGED  ecb — CLEAR — CHANGED: hike done, 10-09");
  });
});

describe("applyEvents (--events-only)", () => {
  const patch = (): LadderEventsPatch => ({
    signsAdd: [sign("chips", { checked: null, due: "2026-10-21", lean: "neutral" })],
    events: { Votes: { holds: [] }, "Moody's": { holds: ["T1", "T3"] } },
    eventsAdd: [{ date: "2026-12-16", event: "MU FQ1", signs: ["chips", "rating"], escalationIf: "weak guide", fizzleIf: "beat-and-raise", holds: ["T2", "T3"], secondary: false, status: "NOT DUE until 2026-12-16" }],
  });
  it("adds the sign and the event and rewrites holds — run, runAt, runs, verdict, sign labels/due and every event status untouched", () => {
    const live = { ...fixture(), runAt: "2026-10-07T09:00:00.000Z" };
    const before = structuredClone(live);
    const { next, delta } = applyEvents(live, patch(), "value", TODAY);
    expect(live).toEqual(before);
    expect({ run: next.run, runAt: next.runAt, runs: next.runs, verdict: next.verdict }).toEqual({ run: before.run, runAt: before.runAt, runs: before.runs, verdict: before.verdict });
    expect(next.signs.slice(0, -1).map((s) => [s.label, s.due])).toEqual(before.signs.map((s) => [s.label, s.due]));
    expect(next.signs.at(-1)!.sign).toBe("chips");
    expect(next.events.slice(0, -1).map((e) => e.status)).toEqual(before.events.map((e) => e.status));
    expect(next.events.map((e) => [e.event, e.holds])).toEqual([["Moody's", ["T1", "T3"]], ["Votes", []], ["ECB", []], ["MU FQ1", ["T2", "T3"]]]);
    expect(delta).toEqual(["signs    chips — new", "events   Votes — holds [T2,T3] → []", "events   Moody's — holds [T2,T3] → [T1,T3]", "events   MU FQ1 — new (2026-12-16, holds [T2,T3]) → NOT DUE until 2026-12-16"]);
  });
  it("throws on any key a run writes, a hold outside the leg's tranches or on a secondary event, a duplicate or incomplete sign, an unknown sign", () => {
    const { status: _st, ...noStatus } = patch().eventsAdd![0]!;
    expect(applyEvents(fixture(), { eventsAdd: [{ ...noStatus, signs: ["rating"] }] }, "value", "2026-10-07").next.events.at(-1)!.status, "status optional — pending status off the date").toBe("NOT DUE until 2026-12-16");
    expect(applyEvents(fixture(), { eventsAdd: [{ ...noStatus, signs: ["rating"], date: "2026-10-01" }] }, "value", "2026-10-07").next.events.at(-1)!.status).toBe("DELAY — outcome unsourced");
    expect(() => applyEvents(fixture(), { signsAdd: [sign("chips", { lean: "open" })] }, "value", TODAY)).toThrow(/signsAdd "chips": lean "open" is not one of bear\/neutral\/fizzle\/unknown/);
    // a hand-written ` · draft: ` segment meets the same shape vet as a patch's measurableDraft — no bypass via signsAdd
    expect(() => applyEvents(fixture(), { signsAdd: [sign("chips", { lean: "neutral (draft)", measurable: "note · draft: bear = a cut" })] }, "value", TODAY)).toThrow(/signsAdd "chips": measurableDraft "bear = a cut" is not `<lean> = … ; <lean> = …` \(one clause per side, each of bear\/neutral\/fizzle\)/);
    expect(applyEvents(fixture(), { signsAdd: [sign("chips", { lean: "neutral (draft)", measurable: "note · draft: bear = a cut ; fizzle = affirmed" })] }, "value", TODAY).next.signs.at(-1)!.lean).toBe("neutral (draft)");
    const live = fixture();
    expect(() => applyEvents(live, { ...patch(), signs: {} } as LadderEventsPatch, "value", TODAY)).toThrow('value:apply — events-only patch: "signs" is not writable here (eventsAdd, events, signsAdd)');
    expect(() => applyEvents(live, { events: { Votes: { holds: ["T1"], status: "fizzle: x" } } } as LadderEventsPatch, "value", TODAY)).toThrow('event "Votes": "status" is not writable here (holds, liftBy)');
    expect(() => applyEvents(live, { events: { Votes: { holds: ["T1"] } } }, "eufin", TODAY)).toThrow('eufin:apply — event "Votes": holds T2/T3 only, none when secondary');
    expect(() => applyEvents(live, { events: { ECB: { holds: ["T2"] } } }, "value", TODAY)).toThrow('event "ECB": holds T1/T2/T3 only, none when secondary');
    expect(() => applyEvents(live, { events: { Nope: { holds: [] } } }, "value", TODAY)).toThrow('event "Nope" not found');
    expect(() => applyEvents(live, { events: { Votes: {} } }, "value", TODAY), "neither holds nor liftBy — never a silent no-op").toThrow('event "Votes": holds T1/T2/T3 only');
    expect(() => applyEvents(live, { signsAdd: [sign("rating")] }, "value", TODAY)).toThrow('signsAdd "rating": needs every required field and a new sign id');
    const { seed: _seed, ...partial } = sign("chips");
    expect(() => applyEvents(live, { signsAdd: [partial as LadderSign] }, "value", TODAY)).toThrow('signsAdd "chips": needs every required field and a new sign id');
    expect(() => applyEvents(live, { eventsAdd: [{ ...patch().eventsAdd![0]! }] }, "value", TODAY)).toThrow('eventsAdd "MU FQ1": sign "chips" is not a signs[] row');
  });
  it("sets an event's liftBy — naming a same-patch eventsAdd, holds untouched — and vets it as a full run does", () => {
    const add = { ...patch().eventsAdd![0]!, signs: ["rating"] };
    const { next, delta } = applyEvents(fixture(), { events: { Votes: { liftBy: ["MU FQ1"] } }, eventsAdd: [add] }, "value", TODAY);
    expect(next.events.find((e) => e.event === "Votes")).toMatchObject({ liftBy: ["MU FQ1"], holds: fixture().events.find((e) => e.event === "Votes")!.holds });
    expect(delta[0]).toBe("events   Votes — liftBy [] → [MU FQ1]");
    expect(() => applyEvents(fixture(), { events: { Votes: { liftBy: ["Votes"] } } }, "value", TODAY)).toThrow('event "Votes": liftBy names "Votes" — not another known event');
    // liftBy + holds in one entry writes both — the liftBy-only `continue` must not swallow the holds write
    const both = applyEvents(fixture(), { events: { Votes: { liftBy: ["ECB"], holds: ["T1"] } } }, "value", TODAY);
    expect([both.next.events.find((e) => e.event === "Votes"), both.delta.length]).toMatchObject([{ liftBy: ["ECB"], holds: ["T1"] }, 2]);
  });
  it("refuses a blocking new sign on a leg whose block moves the verdict (graded blockReach) — the events-only write never re-verdicts", () => {
    const live = fixture();
    expect(() => applyEvents(live, { signsAdd: [sign("chips", { block: true, lean: "neutral" })] }, "value", TODAY)).toThrow('value:apply — signsAdd "chips": block must be false here — --events-only never re-verdicts; set a block on a full `value:apply` run');
    expect(applyEvents(live, { signsAdd: [sign("chips", { block: true })] }, "eufin", TODAY).next.signs.at(-1)).toMatchObject({ sign: "chips", block: true });
  });
  it("a new sign's sources meet the row-source vet — a future-dated one is refused, as a full apply refuses it", () => {
    const add = (date: string) => () => applyEvents(fixture(), { signsAdd: [sign("chips", { lean: "neutral", sources: [{ date, url: "https://a.b/c" }] })] }, "value", TODAY);
    expect(add(addDays(TODAY, 1))).toThrow(`value:apply — signsAdd "chips" source: date ${addDays(TODAY, 1)} is after today ${TODAY}`);
    expect(add(TODAY)).not.toThrow();
  });
  it("a new source on a market-data vendor host (subdomains, a trailing root dot included) is dropped with a warn line; a look-alike host is kept", () => {
    const urls = ["https://finance.yahoo.com/x", "https://www.cnbc.com./y", "https://notyahoo.com/x"];
    const { next, delta } = applyEvents(fixture(), { signsAdd: [sign("chips", { lean: "neutral", sources: urls.map((url) => ({ date: TODAY, url })) })] }, "value", TODAY);
    expect([next.signs.at(-1)!.sources.map((x) => x.url), delta.filter((l) => l.startsWith("warn "))]).toEqual([
      ["https://notyahoo.com/x"],
      ['warn signsAdd "chips" — source https://finance.yahoo.com/x dropped: a market-data vendor host (yahoo.com) — cite the primary source', 'warn signsAdd "chips" — source https://www.cnbc.com./y dropped: a market-data vendor host (cnbc.com) — cite the primary source'],
    ]);
  });
  it("a new sign's primary page on a market-data vendor host is dropped with a warn line; an all-vendor primary list is refused", () => {
    const add = (primary: string[]) => applyEvents(fixture(), { signsAdd: [sign("chips", { lean: "neutral", primary })] }, "value", TODAY);
    const { next, delta } = add(["https://www.cnbc.com/q", "https://fed.gov/p"]);
    expect([next.signs.at(-1)!.primary, delta.filter((l) => l.startsWith("warn "))]).toEqual([
      ["https://fed.gov/p"],
      ['warn signsAdd "chips" — primary https://www.cnbc.com/q dropped: a market-data vendor host (cnbc.com) — cite the publisher\'s page'],
    ]);
    expect(() => add(["https://finance.yahoo.com/q"])).toThrow('value:apply — signsAdd "chips": every primary page is on a market-data vendor host');
    for (const bad of [[], ["HTTPS://www.cnbc.com/q"], "https://www.cnbc.com/q"] as unknown as string[][]) expect(() => add(bad)).toThrow('value:apply — signsAdd "chips": primary is a non-empty list of http(s):// pages');
  });
  it("an event patch resending its stored list drops only the vendor source (sources + preRead.sources), never refusing the list; an emptied list meets its own rule", () => {
    const vendor = { date: "2026-10-06", url: "https://finance.yahoo.com/v" };
    const kept = fixture().events.find((e) => e.event === "Votes")!.sources!;
    const patch = (preSources: string[]): LadderPatch => ({ ...unchanged(fixture()), events: { Votes: { sources: [...kept, vendor], preRead: { text: "t", sources: preSources } } }, situation: SIT });
    const { next, delta } = applyRun(fixture(), patch(["https://budget.example/p", "https://uk.finance.yahoo.com/p"]), TODAY);
    expect([next.events.find((e) => e.event === "Votes"), delta.filter((l) => l.startsWith("warn "))]).toMatchObject([
      { sources: kept, preRead: { text: "t", sources: ["https://budget.example/p"] } },
      ['warn event "Votes" — source https://finance.yahoo.com/v dropped: a market-data vendor host (yahoo.com) — cite the primary source', 'warn event "Votes" — source https://uk.finance.yahoo.com/p dropped: a market-data vendor host (yahoo.com) — cite the primary source'],
    ]);
    expect(() => applyRun(fixture(), patch(["https://onvista.de/p"]), TODAY)).toThrow('event "Votes": preRead.sources lists ≥ 1 source');
  });
  it("stored sources are not re-vetted: a stored vendor-host source survives an unrelated patch", () => {
    const live = fixture();
    const stored = { date: "2026-10-02", url: "https://finance.yahoo.com/stored" };
    live.signs[2]!.sources.push(stored);
    live.events.find((e) => e.event === "Votes")!.sources!.push(stored);
    const { next } = applyRun(live, { ...unchanged(live), events: { Votes: { dateNote: "ballot office date" } }, situation: SIT }, TODAY);
    expect([next.signs[2]!.sources, next.events.find((e) => e.event === "Votes")!.sources]).toEqual([expect.arrayContaining([stored]), expect.arrayContaining([stored])]);
  });
  it("lint: no leg names an uncitable host as a primary — brief.primaryTier hosts and every sign's primary[] page", () => {
    const hits = Object.values(LEGS).flatMap((L) => {
      const live = JSON.parse(readFileSync(L.json, "utf8")) as LadderLive;
      const urls = [...(live.brief?.primaryTier ?? []).flatMap((t) => t.hosts.map((h) => `https://${h}/`)), ...live.signs.flatMap((s) => s.primary)];
      expect(urls.length, `${L.json} names no primary`).toBeGreaterThan(0);
      return urls.filter((u) => uncitable(u)).map((u) => `${L.json}: ${u}`);
    });
    expect(hits).toEqual([]);
  });
});

describe("source grade — tier + corroboration", () => {
  /** A press host: on no fixture row's `primary[]` (the tier is `<row>.example`). */
  const press = (tag = "p", date = TODAY) => ({ date, url: `https://www.Reuters.com/${tag}` });
  const own = (tag = "o", date = TODAY) => ({ date, url: `https://ecb.example/${tag}` });
  /** The `ecb` row (researched, no holding event) patched alone; the others stay quiet. */
  const run = (live: LadderLive, row: LadderPatch["signs"][string], leg: "eufin" | "value" = "eufin", today = TODAY) => applyRun(live, { signs: { ...unchanged(live, today).signs, ecb: row }, situation: SIT }, today, leg);
  const ecb = (r: ReturnType<typeof applyRun>) => r.next.signs.find((s) => s.sign === "ecb")!;

  it("primaryHosts = every row's primary[] host ∪ brief.primaryTier hosts, lowercased, `www.` dropped", () => {
    const brief = { fund: "f", holdsPolicy: "h", gates: "g", eventScope: "e", primaryTier: [{ name: "TSMC IR", hosts: ["tsmc.com", "www.SEC.gov"] }] };
    expect([...primaryHosts({ signs: [sign("a", { primary: ["https://WWW.Fred.StLouisFed.org/x"] }), sign("b", { primary: ["https://sec.gov/y", "https://www.sec.gov/z"] })], brief })]).toEqual(["fred.stlouisfed.org", "sec.gov", "tsmc.com"]);
  });
  it("a brief-tier domain grades its subdomains primary on a dot boundary ([USER 2026-10-16] row 13b): investor.tsmc.com clears ` (press only)`, faketsmc.com does not", () => {
    const live = fixture();
    live.signs[2]!.sources = [];
    live.brief = { fund: "f", holdsPolicy: "h", gates: "g", eventScope: "e", primaryTier: [{ name: "TSMC IR", hosts: ["tsmc.com"] }] };
    const lean = (url: string) => ecb(run(live, { label: "CHANGED", finding: "capex cut", lean: "bear", sources: [{ date: TODAY, url }] }, "value")).lean;
    expect([lean("https://investor.tsmc.com/q3"), lean("https://www.tsmc.com/q3"), lean("https://faketsmc.com/q3")]).toEqual(["bear", "bear", "bear (press only)"]);
  });
  it("leanWord drops all three tags in any order, repeated, before the ` until` strip; a mid-string tag stays", () => {
    expect([leanWord("bear (draft) (press only) (single-source) (press only)"), leanWord("unknown until 2026-10-20 (single-source)"), leanGroup("escalation-leaning (press only) (draft)"), leanWord("bear (press only) x")]).toEqual(["bear", "unknown", 0, "bear (press only) x"]);
  });
  it("a group-0 lean with no primary-tier source (none at all counts) carries ` (press only)`; a neutral lean never; it clears when a primary-tier source lands", () => {
    const live = fixture();
    live.signs[2]!.sources = [];
    const first = run(live, { label: "CHANGED", finding: "hike priced", lean: "bear", sources: [press()] }, "value");
    expect(ecb(first).lean).toBe("bear (press only)");
    expect(ecb(run(live, { label: "CHANGED", finding: "hike priced", lean: "bear", sources: [press(), own()] }, "value")).lean).toBe("bear");
    expect(ecb(run(live, { label: "CHANGED", finding: "hike priced", lean: "neutral", sources: [press()] }, "value")).lean).toBe("neutral");
    // recomputed on every applied row: a fresher primary-tier source clears the tag, the lean word untouched
    first.next.signs[2]!.due = "2026-10-09";
    const cleared = run(first.next, { label: "UNCHANGED 10-09", sources: [own("n", "2026-10-09")] }, "value", "2026-10-09");
    expect([ecb(cleared).lean, cleared.alert]).toEqual(["bear", undefined]); // a tag-only lean change pushes nothing
    const bare = fixture();
    bare.signs[2]!.lean = "bear";
    bare.signs[2]!.sources = [];
    expect(ecb(run(bare, { label: "UNSOURCED" }, "value")).lean).toBe("bear (press only)");
  });
  it("a BLOCK row with < 2 distinct hosts (`www.` + case folded) carries ` (single-source)`; press-only adds ` (press only)` first; a reversal clears both", () => {
    const live = fixture(); // ecb holds one in-window ecb.example source
    live.signs[2]!.measurable = "UNBLOCKING = pause";
    expect(ecb(run(live, { label: "UNCHANGED 10-01", block: true })).lean).toBe("open (single-source)");
    expect(ecb(run(live, { label: "UNCHANGED 10-08", block: true, sources: [{ date: TODAY, url: "https://WWW.ECB.example/b" }] })).lean).toBe("open (single-source)");
    expect(ecb(run(live, { label: "UNCHANGED 10-08", block: true, sources: [press()] })).lean).toBe("open"); // a press page beside the held primary-tier one: two hosts, one primary-tier — clean
    live.signs[2]!.sources = [];
    const blocked = run(live, { label: "UNCHANGED 10-08", block: true, sources: [press()] });
    expect(ecb(blocked).lean).toBe("open (press only) (single-source)");
    expect(ecb(run(live, { label: "UNCHANGED 10-08", block: true, sources: [press(), own()] })).lean).toBe("open");
    expect(ecb(run(blocked.next, { label: "UNCHANGED 10-09", block: false, sources: [press("q", "2026-10-09")] }, "eufin", "2026-10-09")).lean).toBe("open");
  });
  it("the chain is canonical — press only → single-source → draft — whatever tags the patch lean carried; ` (draft)` stays refused without a draft", () => {
    const live = fixture();
    live.signs[2]!.sources = [];
    const drafted = run(live, { label: "CHANGED", finding: "hike priced", lean: "bear (draft) (single-source)", block: true, unblocking: "pause", sources: [press()], measurableDraft: "bear = hike ; fizzle = pause" }, "value");
    expect(ecb(drafted).lean).toBe("bear (press only) (single-source) (draft)");
    expect(ecb(run(live, { label: "CHANGED", finding: "hike priced", lean: "bear (press only)", sources: [own()] }, "value")).lean).toBe("bear"); // a patch cannot force a tag
    expect(() => run(live, { label: "CHANGED", finding: "hike priced", lean: "bear (press only) (draft)", sources: [own()] }, "value")).toThrow(/carries " \(draft\)" without a measurableDraft/);
  });
  it("a row an escalation blocks is graded even off the research list", () => {
    const live = fixture();
    live.events.push({ date: "2026-10-30", event: "Doom vote", signs: ["doom"], escalationIf: "x", fizzleIf: "y", holds: ["T2"], secondary: false, status: "NOT DUE until 2026-10-30" });
    expect(researched(live)).not.toContain("doom");
    live.signs.find((s) => s.sign === "doom")!.lean = "escalation-leaning";
    const { next } = applyRun(live, { ...unchanged(live), situation: SIT, events: { "Doom vote": { status: "escalation: x, 10-08", sources: graded(), liftBy: ["Moody's"] } } }, TODAY);
    expect(next.signs.find((s) => s.sign === "doom")).toMatchObject({ block: true, lean: "escalation-leaning (single-source)" });
  });
  it("a landed status set this run is graded off the event's stored sources; tags the patch wrote are stripped; a mixed: keeps parsing; pending statuses never tag", () => {
    const live = fixture();
    const p = land(live, { Votes: "fizzle: deal, 10-08 (single-source)" });
    p.events!.Votes!.sources = [press()];
    const { next } = applyRun(live, p, TODAY);
    expect(next.events[1]).toMatchObject({ status: "fizzle: deal, 10-08 · called: budget=open (press only) (single-source)", sources: [press()] });
    expect(next.events[0]!.status).toBe("NOT DUE until 2026-10-23");
    expect(applyRun(live, land(live, { Votes: "fizzle: deal, 10-08 (press only)" }), TODAY).next.events[1]!.status).toBe("fizzle: deal, 10-08 · called: budget=open");
    // re-landed with better sources: the tags clear, a grade-only change neither pushes nor owes a situation
    const again = applyRun(next, { ...unchanged(next, "2026-10-09"), events: { Votes: { status: "fizzle: deal, 10-08", sources: graded("2026-10-09") } } }, "2026-10-09");
    expect([again.next.events[1]!.status, again.alert]).toEqual(["fizzle: deal, 10-08 · called: budget=open", undefined]);
    // … nor prints an event line when something else pushes (a T1 flip here)
    const flipped = { ...next, runs: [{ date: "2026-10-07", t1: "1/6 ✗", t2: "5/6 ✓", t3: "1/6 ✗", live: "✓✗✗ prov." }] };
    const regraded = applyRun(flipped, { ...unchanged(flipped), situation: SIT, events: { Votes: { status: "fizzle: deal, 10-08", sources: graded() } } }, TODAY).alert!;
    expect([regraded.title, regraded.body.split("\n").filter((l) => l.startsWith("Votes "))]).toEqual(["EU-Fin: T1 now OK", []]);
    // sources alone re-grade a landed status; a pending one stays untagged
    const resourced = applyRun(next, { ...unchanged(next), events: { Votes: { sources: graded() }, "Moody's": { sources: [press()] } } }, TODAY).next;
    expect(resourced.events.slice(0, 2).map((e) => e.status)).toEqual(["NOT DUE until 2026-10-23", "fizzle: deal, 10-08 · called: budget=open"]);
    const m = land(live, { Votes: "mixed: deal passed, 10-08 — unchecked: tally (single-source)" });
    m.events!.Votes!.sources = [own()];
    const mixed = applyRun(live, m, TODAY).next;
    expect([mixed.events[1]!.status, tagOf(mixed, mixed.signs[1]!, TODAY), mixed.signs[1]!.block]).toEqual(["mixed: deal passed, 10-08 — unchecked: tally · called: budget=open (single-source)", "MIXED (Votes)", false]);
    const added = applyRun(live, { ...unchanged(live), eventsAdd: [{ date: "2026-11-02", event: "Late", signs: ["ecb"], escalationIf: "a", fizzleIf: "b", holds: [], secondary: true, sources: [press()] }], situation: SIT }, TODAY).next;
    expect(added.events.find((e) => e.event === "Late")).toMatchObject({ status: "NOT DUE until 2026-11-02", sources: [press()] });
    const early = applyRun(live, { signs: { ...unchanged(live).signs, ecb: { label: "UNCHANGED 10-08", finding: "after Early", sources: graded() } }, eventsAdd: [{ date: TODAY, event: "Early", signs: ["ecb"], escalationIf: "a", fizzleIf: "b", holds: [], secondary: true, status: "fizzle: b, 10-08 (single-source)", sources: graded() }], situation: SIT }, TODAY).next;
    expect(early.events.find((e) => e.event === "Early")!.status).toBe("fizzle: b, 10-08"); // a landed eventsAdd status: same strip + grade
  });
  it("landing drops a pending event's date-verification sources: the outcome is graded and dated off the patch's sources only", () => {
    const live = fixture(); // Votes (10-09) pending, holding its issuer date page budget.example/v 10-05
    const bare = land(live, { Votes: "fizzle: deal, 10-08" });
    delete bare.events!.Votes!.sources;
    const next = applyRun(live, bare, TODAY).next;
    expect([next.events[1]!.sources, next.events[1]!.status]).toEqual([undefined, "fizzle: deal, 10-08 · called: budget=open (press only) (single-source)"]);
    expect(planRun(next, "2026-10-10").findingOwed).toEqual(["budget after Votes"]); // landedOn = the 10-09 date, after budget's 10-08 source — not the 10-05 date page
    const sourced = land(live, { Votes: "fizzle: deal, 10-08" });
    sourced.events!.Votes!.sources = [press()];
    expect(applyRun(live, sourced, TODAY).next.events[1]!.sources).toEqual([press()]);
  });
  it("event sources are vetted like a row's: a list of {date, url}", () => {
    const live = fixture();
    const bad = (sources: unknown) => () => applyRun(live, { ...land(live, { Votes: "fizzle: deal, 10-08" }), events: { Votes: { status: "fizzle: deal, 10-08", sources } } } as never, TODAY);
    expect(bad("https://x")).toThrow(/event "Votes": sources is a list of \{date, url\}/);
    expect(bad([{ date: TODAY }])).toThrow(/event "Votes" source: needs date \+ url/);
    expect(bad([{ date: TODAY, url: "reuters.com/x" }])).toThrow(/url "reuters\.com\/x" is not http\(s\):\/\//);
    expect(bad([{ date: "10-08", url: "https://x" }])).toThrow(/date "10-08" is not YYYY-MM-DD/);
    expect(bad([{ date: TODAY, url: "https://x", note: "y" }])).toThrow(/"note" is not writable here/);
  });
  it("no press host — PRESS_HOSTS or any row's press[] host — grades primary-tier under suffix semantics (`inTier`) ([USER 2026-10-16])", () => {
    const PRESS_HOSTS = ["reuters.com", "theregister.com", "fxstreet.com", "mortgagenewsdaily.com", "taiwannews.com.tw", "koreatimes.co.kr", "etf.com", "datacenterdynamics.com", "investinglive.com", "countryeconomy.com"];
    const lives = Object.values(LEGS).map((L) => JSON.parse(readFileSync(L.json, "utf8")) as LadderLive);
    const onPrimary = lives.flatMap((l) => {
      const tier = primaryHosts(l);
      const press = l.signs.flatMap((s) => (s.press ?? []).map(hostOf));
      return [...PRESS_HOSTS, ...press].filter((h) => inTier(h, tier));
    });
    expect(onPrimary).toEqual([]);
    expect(lives.flatMap((l) => l.signs.flatMap((s) => s.press ?? [])).length).toBeGreaterThan(0);
  });
});

describe("user-set base", () => {
  it(":state carries a set base beside measurable, omits an unset one; a patch or signsAdd writing it is rejected", () => {
    const live = fixture();
    live.signs[0]!.base = "bear preceded 3 of 5 exits";
    const rows = new Map(planRun(live, TODAY).research.map((r) => [r.sign, r]));
    expect(rows.get("rating")!.base).toBe("bear preceded 3 of 5 exits");
    expect("base" in rows.get("ecb")!).toBe(false);
    const p = unchanged(live);
    p.signs.rating = { ...p.signs.rating!, base: "x" } as never;
    expect(() => applyRun(live, p, TODAY)).toThrow(/rating: "base" is not writable here/);
    expect(() => applyEvents(live, { signsAdd: [{ ...sign("fresh"), base: "x" }] }, "value", TODAY)).toThrow(/"base" is not writable here/);
  });
});

describe("user-set expect", () => {
  it(":state prints an event's expect; a landed status on it must carry `vs cons <x>`; a patch writing expect is rejected", () => {
    const live = fixture();
    live.events[1]!.expect = "cons 0.3, prior 0.3";
    const ev = new Map(planRun(live, TODAY).events.map((e) => [e.event, e]));
    expect(ev.get("Votes")!.expect).toBe("cons 0.3, prior 0.3");
    expect("expect" in ev.get("ECB")!).toBe(false);
    expect(() => applyRun(live, land(live, { Votes: "fizzle: deal struck, 10-08" }), TODAY)).toThrow('event "Votes": an `expect` event\'s status carries `vs cons <x>` (expect: cons 0.3, prior 0.3)');
    expect(applyRun(live, land(live, { Votes: "fizzle: deal struck vs cons no-deal, 10-08" }), TODAY).next.events[1]!.status).toMatch(/^fizzle: deal struck vs cons no-deal/);
    expect(applyRun(fixture(), land(fixture(), { Votes: "fizzle: deal struck, 10-08" }), TODAY).next.events[1]!.status).toMatch(/^fizzle: deal struck/);
    const p = land(live, { Votes: "fizzle: deal vs cons x, 10-08" });
    (p.events!.Votes as Record<string, unknown>).expect = "y";
    expect(() => applyRun(live, p, TODAY)).toThrow(/"expect" is not writable here/);
    const add = { date: "2026-11-02", event: "new", signs: ["ecb"], escalationIf: "a", fizzleIf: "b", holds: [], secondary: false, status: "", expect: "y" };
    expect(() => applyRun(live, { ...unchanged(live), eventsAdd: [add] }, TODAY)).toThrow(/eventsAdd "new": "expect" is not writable here/);
  });
});

describe("pre-event reads — `preRead` / `preReadOwed`", () => {
  const fomc = (date: string, status = `NOT DUE until ${date}`): LadderLive => {
    const live = fixture();
    live.events.push({ date, event: "FOMC", signs: [], escalationIf: "hike", fizzleIf: "hold", holds: [], secondary: true, status, preRead: "CME FedWatch hike odds" });
    return live;
  };
  it("a pending preRead event 0–7 d out is owed until its status holds a pre read dated ≥ yesterday", () => {
    expect(planRun(fomc("2026-10-09"), TODAY).preReadOwed).toEqual(["FOMC (2026-10-09): CME FedWatch hike odds"]);
    expect(planRun(fomc("2026-10-09", "NOT DUE until 2026-10-09 · pre 2026-10-07: hold 83 % · hike 17 %"), TODAY).preReadOwed).toBeUndefined();
    expect(planRun(fomc("2026-10-09", "NOT DUE until 2026-10-09 · pre 2026-10-06: hold 83 %"), TODAY).preReadOwed).toEqual(["FOMC (2026-10-09): CME FedWatch hike odds"]);
    expect(planRun(fomc("2026-10-15"), TODAY).preReadOwed).toEqual(["FOMC (2026-10-15): CME FedWatch hike odds"]);
    expect(planRun(fomc("2026-10-16"), TODAY).preReadOwed).toBeUndefined();
    expect(planRun(fomc("2026-10-07", "fizzle: held, 2026-10-07"), TODAY).preReadOwed).toBeUndefined();
  });
  it("apply writes a pre read after the pending status, keeps it through the next recompute, pushes nothing; a landed event or a date off yesterday/today refuses it", () => {
    const live = fomc("2026-10-09");
    const { next, alert } = applyRun(live, { ...unchanged(live), events: { FOMC: { status: "pre 2026-10-08: hold 83 % · hike 17 %" } } }, TODAY);
    expect(next.events.find((e) => e.event === "FOMC")!.status).toBe("NOT DUE until 2026-10-09 · pre 2026-10-08: hold 83 % · hike 17 %");
    expect(alert).toBeUndefined();
    const later = applyRun(next, unchanged(next, "2026-10-09"), "2026-10-09").next;
    expect(later.events.find((e) => e.event === "FOMC")!.status).toBe("outcome unsourced · pre 2026-10-08: hold 83 % · hike 17 %");
    expect(() => applyRun(live, { ...unchanged(live), events: { FOMC: { status: "pre 2026-10-09: hold" } } }, TODAY)).toThrow(/a `pre <date>: <read>` status is a pending event's, dated yesterday or today/);
    expect(() => applyRun(live, { ...unchanged(live), events: { FOMC: { status: "pre 2026-10-06: hold" } } }, TODAY)).toThrow(/dated yesterday or today/); // an older date would stay owed forever
    const done = fomc("2026-10-07", "fizzle: held, 2026-10-07");
    expect(() => applyRun(done, { ...unchanged(done), events: { FOMC: { status: "pre 2026-10-08: hold" } } }, TODAY)).toThrow(/a `pre <date>: <read>` status is a pending event's/);
  });
  const CME = "https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html";
  const INVESTING = "https://www.investing.com/central-banks/fed-rate-monitor";
  const sourcedRead = { text: "CME FedWatch hike odds", sources: [CME, INVESTING, "search: FedWatch hike odds"] };
  const sourced = (date: string, status?: string): LadderLive => {
    const live = fomc(date, status);
    live.events.find((e) => e.event === "FOMC")!.preRead = structuredClone(sourcedRead);
    return live;
  };
  const patchRead = (live: LadderLive, preRead: unknown): LadderPatch => ({ ...unchanged(live), events: { FOMC: { preRead } } } as LadderPatch);
  it("a sourced preRead prints {owed, sources} in walk order; the run patch lands it on a pending event", () => {
    expect(planRun(sourced("2026-10-09"), TODAY).preReadOwed).toEqual([{ owed: "FOMC (2026-10-09): CME FedWatch hike odds", sources: [CME, INVESTING, "search: FedWatch hike odds"] }]);
    const live = fomc("2026-10-09");
    const { next } = applyRun(live, patchRead(live, sourcedRead), TODAY);
    expect(next.events.find((e) => e.event === "FOMC")!.preRead).toEqual(sourcedRead);
    expect(planRun(next, TODAY).preReadOwed).toEqual([{ owed: "FOMC (2026-10-09): CME FedWatch hike odds", sources: [CME, INVESTING, "search: FedWatch hike odds"] }]);
  });
  it("a patched or added preRead is vetted: non-empty text, ≥ 1 source, each a URL or `search: <stem>`, no other key, never on a landed event", () => {
    const live = fomc("2026-10-09");
    expect(() => applyRun(live, patchRead(live, { ...sourcedRead, text: " " }), TODAY)).toThrow(/preRead\.text is non-empty/);
    expect(() => applyRun(live, patchRead(live, { ...sourcedRead, sources: [] }), TODAY)).toThrow(/preRead\.sources lists ≥ 1 source/);
    expect(() => applyRun(live, patchRead(live, { ...sourcedRead, sources: [CME, "fedwatch"] }), TODAY)).toThrow(/preRead source "fedwatch" is not an http\(s\):\/\/ URL or `search: <stem>`/);
    expect(() => applyRun(live, patchRead(live, { ...sourcedRead, note: "x" }), TODAY)).toThrow(/"note" is not writable here \(text, sources\)/);
    expect(() => applyRun(live, patchRead(live, "a string"), TODAY)).toThrow(/event "FOMC": a patch preRead is \{text, sources\}/);
    const done = fomc("2026-10-07", "fizzle: held, 2026-10-07");
    expect(() => applyRun(done, patchRead(done, sourcedRead), TODAY)).toThrow(/a preRead is a pending event's — this one has landed/);
    const add = (preRead: unknown): LadderPatch => ({ ...unchanged(live), eventsAdd: [{ date: "2026-10-14", event: "CPI", signs: [], escalationIf: "hot", fizzleIf: "cool", holds: [], secondary: true, preRead } as NonNullable<LadderPatch["eventsAdd"]>[number]], situation: SIT });
    expect(() => applyRun(live, add({ ...sourcedRead, sources: ["fedwatch"] }), TODAY)).toThrow(/eventsAdd "CPI": preRead source "fedwatch"/);
    expect(applyRun(live, add(sourcedRead), TODAY).next.events.find((e) => e.event === "CPI")!.preRead).toEqual(sourcedRead);
  });
  it("a sourced preRead's status cites the answering host or reports all unreadable; a bare preRead keeps the bare read", () => {
    const live = sourced("2026-10-09");
    const read = (l: LadderLive, status: string): LadderPatch => ({ ...unchanged(l), events: { FOMC: { status } } });
    expect(() => applyRun(live, read(live, "pre 2026-10-08: hold 84 %"), TODAY)).toThrow(/a sourced preRead's status ends ` \(<host>\)` \(the source that answered\) or is `pre <date>: n\/a \(all unreadable\)`/);
    expect(applyRun(live, read(live, "pre 2026-10-08: hold 84 % (investing.com)"), TODAY).next.events.find((e) => e.event === "FOMC")!.status).toBe("NOT DUE until 2026-10-09 · pre 2026-10-08: hold 84 % (investing.com)");
    expect(applyRun(live, read(live, "pre 2026-10-08: n/a (all unreadable)"), TODAY).next.events.find((e) => e.event === "FOMC")!.status).toBe("NOT DUE until 2026-10-09 · pre 2026-10-08: n/a (all unreadable)");
    expect(() => applyRun(live, read(live, "pre 2026-10-08: n/a (cmegroup.com)"), TODAY), "an n/a names no single host").toThrow(/a sourced preRead's status ends ` \(<host>\)` \(the source that answered\) or is `pre <date>: n\/a \(all unreadable\)`/);
    const bare = fomc("2026-10-09");
    expect(() => applyRun(bare, { ...unchanged(bare), events: { FOMC: { status: "pre 2026-10-08: hold 84 %", preRead: sourcedRead } } }, TODAY)).toThrow(/a sourced preRead's status ends/); // the patch's own preRead binds its status
  });
});

describe("staleContext", () => {
  it("lists the STALE findings of an unresolved event's rows once the event is due (≤ today); absent before it and after it lands", () => {
    const live = fixture();
    live.signs[1] = { ...live.signs[1]!, label: "STALE 09-20", finding: "old budget read" };
    expect(planRun(live, TODAY).staleContext).toBeUndefined(); // Votes is 10-09
    expect(planRun(live, "2026-10-09").staleContext).toEqual(["Votes: budget STALE 09-20 (+18d) — old budget read"]);
    expect([planRun(live, TODAY).armRules?.staleContext, planRun(live, "2026-10-09").armRules?.staleContext]).toEqual([undefined, expect.stringContaining("never as the outcome")]);
    live.events[1]!.status = "fizzle: deal, 10-09";
    expect(planRun(live, "2026-10-09").staleContext).toBeUndefined();
  });
});

describe("calibration record — leanLog, called, lean hit rate", () => {
  const changed = (live: LadderLive, row: string, lean: string, today: string): LadderPatch => {
    const p = unchanged(live, today);
    p.signs[row] = { label: "CHANGED", finding: `${row} moved`, lean, sources: graded(today, row) };
    return { ...p, situation: sitFor(live, today) };
  };
  it("leanLog appends only on a bare-lean change, seeded with the prior lean at its last check, capped at 5", () => {
    const live = fixture();
    const a = applyRun(live, changed(live, "rating", "escalation-leaning", TODAY), TODAY).next;
    expect(a.signs[0]!.leanLog).toEqual([{ date: "2026-10-07", lean: "open" }, { date: TODAY, lean: "escalation-leaning" }]);
    let n = a;
    for (const [d, l] of [["2026-10-09", "mixed"], ["2026-10-10", "escalation-leaning"], ["2026-10-11", "mixed"], ["2026-10-12", "escalation-leaning"]] as const) {
      n = { ...n, signs: n.signs.map((x) => (x.sign === "rating" ? { ...x, due: d } : x)) };
      n = applyRun(n, changed(n, "rating", l, d), d).next;
    }
    expect(n.signs[0]!.leanLog!.map((x) => x.date)).toEqual(["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"]);
    const due = { ...n, signs: n.signs.map((x) => (x.sign === "rating" ? { ...x, due: "2026-10-13" } : x)) };
    expect(applyRun(due, changed(due, "rating", "escalation-leaning", "2026-10-13"), "2026-10-13").next.signs[0]!.leanLog).toEqual(n.signs[0]!.leanLog); // same bare lean → no entry
  });
  it("called = each row's lean the day BEFORE the event; a change on the event day is not the call; a log with nothing earlier → unknown", () => {
    const live = fixture(); // Votes 10-09 names budget
    const pre = applyRun(live, changed(live, "budget", "escalation-leaning", TODAY), TODAY).next; // 10-08: open → bear
    const p = land(pre, { Votes: "escalation: censure, 10-09" }, "2026-10-09");
    p.events!.Votes!.liftBy = ["Moody's"];
    p.signs.budget = { label: "CHANGED", finding: "after Votes, censure", lean: "mixed", sources: graded("2026-10-09", "budget") }; // event day: bear → neutral
    expect(applyRun(pre, p, "2026-10-09").next.events[1]!.status).toBe("escalation: censure, 10-09 · called: budget=escalation-leaning");
    const early = { ...pre, events: pre.events.map((e) => (e.event === "Votes" ? { ...e, date: "2026-10-06" } : e)) };
    expect(applyRun(early, land(early, { Votes: "fizzle: deal, 10-06" }), TODAY).next.events[1]!.status).toBe("fizzle: deal, 10-06 · called: budget=unknown");
  });
  it("called reads the pre-run lean: a lean the landing run itself moves (seeding leanLog at the last check) is not the call", () => {
    const live = fixture();
    live.signs[1] = { ...live.signs[1]!, checked: "2026-10-09" }; // budget: open, checked on the event day, no leanLog
    const p = land(live, { Votes: "fizzle: deal, 10-09" }, "2026-10-10");
    p.signs.budget = { label: "CHANGED", finding: "after Votes, deal", lean: "fizzle-leaning", sources: graded("2026-10-10", "budget") };
    expect(applyRun(live, p, "2026-10-10").next.events[1]!.status).toBe("fizzle: deal, 10-09 · called: budget=open");
  });
  it("a re-sent identical outcome keeps its stored called segment and only regrades", () => {
    const live = fixture();
    live.events[1]!.status = "fizzle: deal, 10-08 · called: budget=open (press only)";
    live.signs[1] = { ...live.signs[1]!, lean: "escalation-leaning" }; // the lean moved since the call
    expect(applyRun(live, land(live, { Votes: "fizzle: deal, 10-08" }), TODAY).next.events[1]!.status).toBe("fizzle: deal, 10-08 · called: budget=open");
  });
  it("lean hit rate counts ▲ vs escalation and ▼ vs fizzle per event × row; ◆/○ calls and mixed: outcomes are uncounted; absent with no counted call", () => {
    const live = fixture();
    expect(planRun(live, TODAY).leanHitRate).toBeUndefined();
    live.events[0]!.status = "escalation: cut, 10-01 · called: rating=bear, budget=fizzle, ecb=neutral (single-source)";
    live.events[1]!.status = "fizzle: deal, 10-02 · called: budget=fizzle-leaning, rating=unknown";
    live.events[2]!.status = "mixed: hike, 10-03 — unchecked: dots · called: ecb=bear";
    expect(planRun(live, TODAY).leanHitRate).toBe("lean hit rate: 2 of 3 calls");
  });
  it("lean hit rate reads only the lean values: a comma-bearing row name with a lean word in a fragment counts once", () => {
    const live = fixture();
    live.events[0]!.status = "escalation: cut, 10-01 · called: Budget votes, bear, no-confidence=fizzle";
    expect(planRun(live, TODAY).leanHitRate).toBe("lean hit rate: 0 of 1 calls");
  });
});

describe("event windows — `landable`", () => {
  /** `doom` sourced 10-05 — in-window (today − 7) through 10-12. */
  const doom = (over: Partial<LadderSign> = {}): LadderSign => sign("doom", { sources: [{ date: "2026-10-05", url: "https://doom.example/1" }], ...over });
  /** One cadence-held row (`doom`, due 10-14) whose only event is dated 2026-10-09. */
  const votes = (over: Partial<LadderLive["events"][number]> = {}): LadderLive => {
    const live = fixture();
    live.signs = [doom({ due: "2026-10-14" })];
    live.events = [{ ...live.events[1]!, signs: ["doom"], date: "2026-10-09", ...over }];
    return live;
  };
  const D = "2026-10-09";
  const at = (hhmm: string, date = D) => new Date(`${date}T${hhmm}:00+03:00`); // EEST (DST ends 2026-10-25)
  const signs = (live: LadderLive, today: string, now?: Date) => planRun(live, today, "eufin", {}, now).research.map((r) => r.sign);
  it("an own-date event is owed only from its `at` window on the Tallinn clock; no clock = owed all day", () => {
    expect(signs(votes(), D)).toEqual(["doom"]);
    expect(planRun(votes(), D, "eufin", {}, at("09:00")).kept).toEqual(["doom — HELD until 2026-10-14"]); // `post` (default): not before midnight
    expect(signs(votes(), D, at("23:30"))).toEqual([]);
    expect(signs(votes(), "2026-10-10", at("09:00", "2026-10-10"))).toEqual(["doom"]); // the day after: past, owed every slot
    expect(signs(votes({ at: "close" }), D, at("22:30"))).toEqual([]);
    expect(signs(votes({ at: "close" }), D, at("23:00"))).toEqual(["doom"]);
    expect(signs(votes({ at: "pre" }), D, at("15:59"))).toEqual([]);
    expect(planRun(votes({ at: "pre" }), D, "eufin", {}, at("16:00")).research[0]).toMatchObject({ sign: "doom", extended: true, query: ["doom a October 2026", "Votes outcome October 2026"] });
    expect(signs(votes({ at: "pre" }), "2026-10-08", at("09:00", "2026-10-08"))).toEqual(["doom"]); // the day before: `near` (D−1), window not consulted
  });
  it("a row the D−1 watch checked is HELD until its event's window on D — block rows too; researched from the window (a real D−1 apply builds D's state)", () => {
    for (const block of [false, true]) {
      const base = { ...votes({ at: "pre" }), signs: [doom({ due: "2026-10-14", block })] };
      const d1 = applyRun(base, unchanged(base, "2026-10-08"), "2026-10-08", "eufin", undefined, undefined, at("09:00", "2026-10-08")).next;
      expect(d1.signs[0]).toMatchObject({ checked: "2026-10-08", due: "2026-10-08" }); // the D−1 watch
      expect(planRun(d1, D, "eufin", {}, at("09:00"))).toMatchObject({ research: [], kept: ["doom — HELD until 16:00"] });
      expect(applyRun(d1, { signs: {} }, D, "eufin", undefined, undefined, at("09:00")).next.signs[0]!.label).toBe("HELD until 16:00");
      expect(signs(d1, D, at("16:00"))).toEqual(["doom"]);
      const post = { ...d1, events: [{ ...d1.events[0]!, at: "post" as const }] };
      expect(planRun(post, D, "eufin", {}, at("23:30")).kept).toEqual(["doom — HELD until 2026-10-10"]);
      expect(signs(post, "2026-10-10", at("09:00", "2026-10-10"))).toEqual(["doom"]);
    }
  });
  it("a row waiting on its event's `at` window stays HELD even with a stale source", () => {
    const live = { ...votes({ at: "pre" }), signs: [doom({ due: D, checked: "2026-10-08", sources: [{ date: "2026-09-01", url: "https://doom.example/0901" }] })] };
    expect(planRun(live, D, "eufin", {}, at("09:00"))).toMatchObject({ research: [], kept: ["doom — HELD until 16:00"] });
  });
  it("an instant past midnight with `today` pinned to the window's date is past the window", () => {
    expect(signs(votes({ at: "close" }), D, at("00:03", "2026-10-10"))).toEqual(["doom"]);
  });
  it("before the window a cadence-due row asks no outcome query and no `more`", () => {
    const live = { ...votes({ at: "pre" }), signs: [doom()] };
    expect(planRun(live, D, "eufin", {}, at("09:00")).research[0]).toMatchObject({ query: ["doom a October 2026"], more: [], extended: false });
    expect(planRun(live, D, "eufin", {}, at("09:00")).research[0]).not.toHaveProperty("sides"); // no event-day sides before the window
    const pre = applyRun(live, { signs: { doom: { label: "UNCHANGED 10-05" } } }, D, "eufin", undefined, undefined, at("09:00")).next;
    expect(pre.signs[0]!.due).toBe("2026-10-16"); // apply's watch reads the same clock: pre-window = cadence due…
    expect(signs(pre, D, at("16:00"))).toEqual(["doom"]); // …and the window still re-reads it
    expect(planRun(live, D, "eufin", {}, at("16:00")).research[0]).toMatchObject({ query: ["doom a October 2026", "Votes outcome October 2026"], more: ["doom b October 2026"], extended: true });
  });
  it("applyRun re-plans with the same clock; eventsAdd takes `at` pre/close/post only", () => {
    const live = votes();
    expect(() => applyRun(live, { signs: {} }, D, "eufin", undefined, undefined, at("09:00"))).not.toThrow();
    expect(() => applyRun(live, { signs: {} }, D)).toThrow(/researched rows missing from the patch: doom — copy the `patch` stub whole/);
    const add = { date: "2026-11-05", event: "New", signs: ["doom"], escalationIf: "a", fizzleIf: "b", holds: [] as [], secondary: true };
    expect(() => applyRun(live, { ...unchanged(live, D), eventsAdd: [{ ...add, at: "noon" as "pre" }] }, D)).toThrow(/at "noon" is not pre \/ close \/ post/);
    expect(applyRun(live, { ...unchanged(live, D), eventsAdd: [{ ...add, at: "close" }], situation: SIT }, D).next.events.at(-1)).toMatchObject({ event: "New", at: "close" });
  });
});

describe("verify/scan cadence — `verifyChecked` / `scannedOn`", () => {
  it("an unanswered verify date is re-asked after 3 days, daily within 3 days of the date; apply stamps verifyChecked on the rows it sent", () => {
    const live = fixture(); // verify: S&P UK (10-12, 4 d out), far (10-23)
    live.calendar[2]!.verifyChecked = "2026-10-07"; // yesterday: 4 d out → held
    live.calendar[3]!.verifyChecked = "2026-10-05"; // 3 d ago → re-asked
    expect(planRun(live, TODAY).verify.map((v) => v.event)).toEqual(["far"]);
    live.calendar[2]!.date = "2026-10-11"; // 3 d out: daily again
    expect(planRun(live, TODAY).verify.map((v) => v.event)).toEqual(["S&P UK", "far"]);
    const next = applyRun(live, unchanged(live), TODAY).next;
    expect(next.calendar.filter((c) => c.verifyChecked === TODAY).map((c) => c.event)).toEqual(["S&P UK", "far"]);
    expect(next.calendar.find((c) => c.event === "passed")?.verifyChecked).toBeUndefined();
    expect(planRun(next, "2026-10-09").verify.map((v) => v.event)).toEqual(["S&P UK"]); // both stamped today; S&P UK is 2 d out → daily, far held
  });
  it("the scan query runs weekly off scannedOn, always with an unlanded event within 3 days; apply stamps scannedOn; a trailing `date` is not doubled", () => {
    const live = fixture();
    live.events = live.events.filter((e) => e.event !== "Votes"); // leaves Moody's 10-23 and ECB 10-29
    expect(planRun(live, TODAY).scan).toHaveLength(1); // never scanned
    live.scannedOn = "2026-10-02";
    expect(planRun(live, TODAY).scan).toEqual([]); // 6 d ago, no event within 3 d
    live.scannedOn = "2026-10-01";
    expect(planRun(live, TODAY).scan).toHaveLength(1); // 7 d ago
    live.scannedOn = TODAY;
    live.events[0]!.date = "2026-10-11";
    expect(planRun(live, TODAY).scan).toHaveLength(1); // an event 3 d out
    live.events[0]!.date = "2026-10-12";
    expect(planRun(live, TODAY).scan).toEqual([]);
    expect(applyRun(fixture(), unchanged(fixture()), TODAY).next.scannedOn).toBe(TODAY);
    const idle = { ...fixture(), signs: [sign("rating", { checked: TODAY, due: "2026-10-14" })], events: [] }; // research: [] — Rung 0 never runs
    expect(planRun(idle, TODAY)).toMatchObject({ research: [], scan: [expect.any(String)], verify: [{ event: "S&P UK" }, { event: "far" }] });
    const idled = applyRun(idle, { signs: {} }, TODAY).next;
    expect([idled.scannedOn, ...idled.calendar.map((c) => c.verifyChecked)]).toEqual([undefined, undefined, undefined]);
    const named = fixture();
    named.calendar[2]!.event = "NVDA sets its FQ3-27 date";
    expect(planRun(named, TODAY).verify[0]).toMatchObject({ query: "NVDA sets its FQ3-27 date" });
  });
});

describe("extended cadence — `extendedOn`", () => {
  const sourceless = (over: Partial<LadderSign> = {}): LadderLive => ({ ...fixture(), events: [], signs: [sign("dio", { checked: "2026-10-07", due: "2026-10-07", sources: [], ...over })] });
  const ext = (live: LadderLive) => planRun(live, TODAY).research[0]!.extended;
  it("a sourceless researched row gets the extended search only every 7 days; an event within 3 days overrides; apply stamps extendedOn", () => {
    expect(ext(sourceless())).toBe(true); // never searched extended
    expect(ext(sourceless({ extendedOn: "2026-10-02" }))).toBe(false); // 6 d ago
    expect(ext(sourceless({ extendedOn: "2026-10-01" }))).toBe(true); // 7 d ago
    const near = sourceless({ extendedOn: TODAY });
    near.events = [{ date: "2026-10-10", event: "Print", signs: ["dio"], escalationIf: "a", fizzleIf: "b", holds: [], secondary: true, status: "NOT DUE until 2026-10-10" }];
    expect(ext(near)).toBe(true);
    const live = sourceless({ extendedOn: "2026-10-01" });
    const next = applyRun(live, { signs: { dio: { label: "UNSOURCED" } } }, TODAY).next;
    expect(next.signs[0]!.extendedOn).toBe(TODAY);
    expect(ext({ ...next, signs: [{ ...next.signs[0]!, due: TODAY }] })).toBe(false); // stamped today → held for 7 d
    const quiet = applyRun(sourceless({ extendedOn: "2026-10-02" }), { signs: { dio: { label: "UNSOURCED" } } }, TODAY).next;
    expect(quiet.signs[0]!.extendedOn).toBe("2026-10-02"); // not planned extended → stamp untouched
  });
});

describe(":state events — unresolved ∪ landed ≤ 14 d ∪ a researched row's staleAfter, the rest counted, landed status clipped", () => {
  const landedEv = (event: string, date: string, signs: string[], status: string): LadderLive["events"][number] => ({ date, event, signs, escalationIf: "a", fizzleIf: "b", holds: [], secondary: true, status });
  it("drops an old landing a researched row has absorbed (counted as eventsSettled), keeps one its staleAfter owes; clips a landed status at 120 chars", () => {
    const live = fixture(); // doom held until 10-14
    live.signs[0] = { ...live.signs[0]!, cadence: 91, sources: [{ date: "2026-08-20", url: "https://rating.example/1" }] }; // rating: 91-d window, sourced 08-20
    const long = `fizzle: ${"x".repeat(200)}`;
    live.events.push(landedEv("Old", "2026-09-01", ["doom"], long), landedEv("Owed", "2026-09-01", ["rating"], long), landedEv("Absorbed", "2026-08-10", ["rating"], long), landedEv("Recent", "2026-10-01", ["doom"], "fizzle: short, 10-01"));
    const plan = planRun(live, TODAY);
    const ev = new Map(plan.events.map((e) => [e.event, e]));
    expect([...ev.keys()]).toEqual(["Moody's", "Votes", "ECB", "Owed", "Recent"]);
    expect(plan.eventsSettled).toBe(2); // Old + Absorbed
    expect(ev.get("Owed")!.status).toHaveLength(120);
    expect(ev.get("Owed")!.status.endsWith("…")).toBe(true);
    expect(ev.get("Recent")!.status).toBe("fizzle: short, 10-01");
    expect(live.events.find((e) => e.event === "Owed")!.status).toBe(long); // stored status untouched
  });
});

describe("retirement (applyEvents / applyRun) — settled landings move to eventsDone (retireEvents)", () => {
  const ev = (event: string, date: string, signs: string[], status: string, holds: LadderTranche["id"][] = []): LadderLive["events"][number] => ({ date, event, signs, escalationIf: "a", fizzleIf: "b", holds, secondary: !holds.length, status, preRead: "p" });
  const OLD = addDays(TODAY, -(RETIRE_DAYS + 1));
  const retiring = (): LadderLive => {
    const live = fixture(); // rating: checked 10-07, sourced 10-01
    live.signs.push(
      sign("blocker", { block: true, blocked: { on: OLD, by: "Blocking" } }),
      sign("stale", { sources: [{ date: addDays(OLD, -1), url: "https://stale.example/1" }] }),
      sign("unchecked", { checked: addDays(OLD, -1) }),
    );
    live.events.push(
      ev("Fizzled", OLD, ["rating"], `fizzle: affirmed, ${OLD.slice(5)}`, ["T2"]),
      ev("Escalated", OLD, ["rating"], `escalation: cut, ${OLD.slice(5)}`),
      ev("Mixed", OLD, ["rating"], `mixed: split, ${OLD.slice(5)} — unchecked: x`),
      ev("Pending", OLD, ["rating"], "DELAY — outcome unsourced", ["T2"]),
      ev("Holding", OLD, ["rating"], `escalation: cut, ${OLD.slice(5)}`, ["T3"]),
      ev("Blocking", OLD, ["rating"], `fizzle: affirmed, ${OLD.slice(5)}`),
      ev("Unabsorbed", OLD, ["stale"], `fizzle: affirmed, ${OLD.slice(5)}`),
      ev("Unread", OLD, ["unchecked"], `fizzle: affirmed, ${OLD.slice(5)}`),
      ev("Young", addDays(TODAY, -RETIRE_DAYS), ["rating"], `fizzle: affirmed, ${addDays(TODAY, -RETIRE_DAYS).slice(5)}`),
    );
    return live;
  };
  it("moves only a fizzle and a non-holding escalation landed > RETIRE_DAYS ago, absorbed by every linked row and named by no blocked.by — compact, input untouched", () => {
    const live = retiring();
    const { next, delta } = applyEvents(live, {}, "eufin", TODAY);
    expect(next.eventsDone!.map((e) => e.event)).toEqual(["Fizzled", "Escalated"]);
    expect(next.events.map((e) => e.event)).toEqual(["Moody's", "Votes", "ECB", "Mixed", "Pending", "Holding", "Blocking", "Unabsorbed", "Unread", "Young"]);
    expect(Object.keys(next.eventsDone![0]!).sort()).toEqual(["date", "event", "holds", "secondary", "signs", "status"]);
    expect(delta).toEqual([`events   Fizzled — retired (fizzle, ${RETIRE_DAYS + 1} d)`, `events   Escalated — retired (escalation, ${RETIRE_DAYS + 1} d)`]);
    expect(live.events).toHaveLength(12); // input untouched
  });
  it("a retired name stays taken: re-adding it, or patching its holds, is refused", () => {
    const { next } = applyEvents(retiring(), {}, "eufin", TODAY);
    const re = { date: "2026-10-20", event: "Fizzled", signs: ["rating"], escalationIf: "a", fizzleIf: "b", holds: [], secondary: true } as LadderEventsPatch["eventsAdd"] extends (infer E)[] | undefined ? E : never;
    expect(() => applyEvents(next, { eventsAdd: [re] }, "eufin", TODAY)).toThrow(/eventsAdd "Fizzled": .*and a new name/);
    expect(() => applyEvents(next, { events: { Fizzled: { holds: [] } } }, "eufin", TODAY)).toThrow(/event "Fizzled" is retired/);
  });
  it("applyRun retires after the patch lands, one delta line per move", () => {
    const live = fixture();
    live.events.push(ev("Settled", OLD, ["ecb"], `fizzle: paused, ${OLD.slice(5)}`));
    const res = applyRun(live, unchanged(live), TODAY);
    expect(res.next.eventsDone!.map((e) => e.event)).toEqual(["Settled"]);
    expect(res.delta).toContain(`events   Settled — retired (fizzle, ${RETIRE_DAYS + 1} d)`);
  });
  it("history reads see eventsDone: staleAfter (findingOwed), releasedBy (released) and allFizzled", () => {
    const live = fixture(); // rating: checked 10-07, sourced 10-01; doom held → 10-14, checked 10-07
    const done = (event: string, date: string, signs: string[]) => ({ date, event, signs, holds: ["T2" as const], secondary: false, status: `fizzle: affirmed, ${date.slice(5)}`, sources: [{ date, url: "https://x.example/1" }] });
    live.eventsDone = [done("Unread", "2026-10-03", ["rating"]), done("Released", TODAY, ["doom"])];
    const plan = planRun(live, TODAY);
    expect(plan.findingOwed).toContain("rating after Unread");
    expect(plan.released).toContain(`doom ← Released (${TODAY})`);
    const t2 = { ...live, events: live.events.filter((e) => !e.holds.includes("T2")) }; // the retired fizzles are the only T2 holders
    expect([allFizzled(t2.events, "T2", TODAY), allFizzled(allEvents(t2), "T2", TODAY)]).toEqual([false, true]);
  });
});

describe("event drop — `events: {<name>: {drop}}` moves a pending or non-holding landed event to eventsDone (applyEventPatch)", () => {
  const ev = (event: string, signs: string[], status: string, holds: LadderTranche["id"][] = []): LadderLive["events"][number] => ({ date: "2026-09-30", event, signs, escalationIf: "a", fizzleIf: "b", holds, secondary: !holds.length, status });
  const dropping = (...extra: LadderLive["events"]): LadderLive => ((live) => ({ ...live, events: [...live.events, ...extra] }))(fixture());
  const drop = (live: LadderLive, events: LadderPatch["events"]) => applyRun(live, { ...unchanged(live), events }, TODAY);
  it("a pending holding event moves as `dropped: <reason>` with a delta line; its name stays taken", () => {
    const res = drop(fixture(), { "Moody's": { drop: "cancelled by the agency" } });
    expect(res.next.events.map((e) => e.event)).toEqual(["Votes", "ECB"]);
    expect(res.next.eventsDone).toEqual([{ date: "2026-10-23", event: "Moody's", signs: ["rating"], holds: [], secondary: false, status: "dropped: cancelled by the agency" }]);
    expect(res.delta).toContain("events   Moody's — dropped: cancelled by the agency");
    const re = { date: "2026-10-30", event: "Moody's", signs: ["rating"], escalationIf: "a", fizzleIf: "b", holds: [], secondary: true } as LadderEventsPatch["eventsAdd"] extends (infer E)[] | undefined ? E : never;
    expect(() => applyEvents(res.next, { eventsAdd: [re] }, "eufin", TODAY)).toThrow(/eventsAdd "Moody's": .*and a new name/);
  });
  it("a landed fizzle holding nothing moves; a holding escalation, a blocked.by-named event, a co-keyed or blank drop are refused", () => {
    expect(drop(dropping(ev("Fizz", ["ecb"], "fizzle: held, 09-30")), { Fizz: { drop: "duplicate of ECB" } }).next.eventsDone?.map((e) => e.status)).toEqual(["dropped: duplicate of ECB"]);
    expect(() => drop(dropping(ev("Esc", ["ecb"], "escalation: cut, 09-30", ["T2"])), { Esc: { drop: "x" } })).toThrow(/event "Esc": drop is only for a pending event or a landed one holding no tranche — it holds T2/);
    const named = dropping(ev("Fizz", ["ecb"], "fizzle: held, 09-30"));
    named.signs[2] = { ...named.signs[2]!, block: true, blocked: { on: "2026-09-30", by: "Fizz" } };
    expect(() => drop(named, { Fizz: { drop: "x" } })).toThrow(/event "Fizz": drop refused — blocked\.by names it \(ecb\)/);
    expect(() => drop(fixture(), { "Moody's": { drop: "x", verified: true } })).toThrow(/event "Moody's": drop is a non-empty reason, its entry's sole key/);
    expect(() => drop(fixture(), { "Moody's": { drop: " " } })).toThrow(/event "Moody's": drop is a non-empty reason, its entry's sole key/);
  });
  it("--events-only refuses drop (its event entries take `holds` alone)", () => {
    expect(() => applyEvents(fixture(), { events: { "Moody's": { drop: "x" } } } as never, "eufin", TODAY)).toThrow(/event "Moody's": .*drop/);
  });
  it("a dropped holder is no outcome: allFizzled skips it, findingOwed never names it", () => {
    const res = drop(fixture(), { "Moody's": { drop: "cancelled" } });
    const fizzled = { date: "2026-10-05", holds: ["T3" as const], status: "fizzle: affirmed, 10-05" };
    expect(allFizzled([...res.next.eventsDone!, fizzled], "T3", TODAY)).toBe(true); // the dropped Moody's held T2+T3 — stored with holds: []
    const sourcedBefore = { ...res.next, eventsDone: res.next.eventsDone!.map((e) => ({ ...e, date: "2026-10-05" })) }; // rating sourced 10-01, inside the window
    expect(planRun(sourcedBefore, TODAY).findingOwed ?? []).not.toContain("rating after Moody's");
  });
});

describe("overdue pending events — `overdueOwed`", () => {
  /** `late` names the event's date in its finding (an `eventOwed` candidate); `quiet` names none — both checked today. */
  const overdue = (daysAgo: number): LadderLive => {
    const live = fixture();
    const date = addDays(TODAY, -daysAgo);
    live.signs.push(sign("late", { checked: TODAY, due: TODAY, finding: `vote ${date.slice(5)}`, sources: [{ date: "2026-09-20", url: "https://late.example/1" }] }), sign("quiet", { checked: TODAY, due: TODAY }));
    live.events.push({ date, event: "Late", signs: ["late", "quiet"], escalationIf: "a", fizzleIf: "b", holds: [], secondary: true, status: "outcome unsourced" });
    return live;
  };
  it("lists a pending event passed 8 days, not 7: asked once (its date leaves eventOwed), its rows researched though checked today", () => {
    const [eight, seven] = [planRun(overdue(8), TODAY), planRun(overdue(7), TODAY)];
    expect([eight.overdueOwed, seven.overdueOwed]).toEqual([["Late (2026-09-30)"], undefined]);
    expect([eight.eventOwed, seven.eventOwed]).toEqual([undefined, ["late 10-01"]]);
    expect([eight.research.some((r) => r.sign === "quiet"), seven.research.some((r) => r.sign === "quiet")]).toEqual([true, false]);
    expect([!!eight.armRules?.overdueOwed, !!seven.armRules?.overdueOwed, eight.patchForms?.["events.drop"] !== undefined]).toEqual([true, false, true]);
  });
  it("a date move to ≥ today or a drop clears it", () => {
    const live = overdue(8);
    const moved = applyRun(live, { ...unchanged(live), situation: sitFor(live, TODAY), events: { Late: { date: "2026-10-15" } } }, TODAY).next;
    expect(planRun(moved, TODAY).overdueOwed).toBeUndefined();
    expect(planRun(applyRun(live, { ...unchanged(live), events: { Late: { drop: "out of eventScope" } } }, TODAY).next, TODAY).overdueOwed).toBeUndefined();
  });
  it("a date move to < today is refused unless an outcome lands; a 7-day-passed (not overdue) event may still move into the past", () => {
    const live = overdue(8);
    const move = (l: LadderLive, events: LadderPatch["events"]) => () => applyRun(l, { ...unchanged(l), situation: sitFor(l, TODAY), events }, TODAY);
    expect(move(live, { Late: { date: addDays(TODAY, -1) } })).toThrow(/event "Late" \(2026-09-30\) overdue: a move needs date >= 2026-10-08, else land an outcome or drop it/);
    expect(move(live, { Late: { date: addDays(TODAY, -1), status: `fizzle: held, ${addDays(TODAY, -1).slice(5)}` } })).not.toThrow(/overdue/); // a landing owes its rows' findings, not a date ≥ today
    const seven = overdue(7);
    expect(move(seven, { Late: { date: addDays(TODAY, -2) } })).not.toThrow();
  });
});

describe("holding mixed: events — `mixedOwed` + the apply-time holds valve (P4-lean)", () => {
  /** `Split` (holds T2+T3) and `Context` (holds none) landed `mixed:` so that `Split` falls owed on TODAY; `mixrow` is sourced on the landing. */
  const LANDED = addDays(TODAY, -REVIEW_FALLBACK_DAYS);
  const mixed = (): LadderLive => {
    const live = fixture();
    live.signs.push(sign("mixrow", { checked: TODAY, due: addDays(TODAY, 7), sources: [{ date: LANDED, url: "https://mixrow.example/1" }] }));
    const ev = (event: string, holds: LadderTranche["id"][]): LadderLive["events"][number] => ({ date: LANDED, event, signs: ["mixrow"], escalationIf: "a", fizzleIf: "b", holds, secondary: !holds.length, status: `mixed: split, ${LANDED.slice(5)} — unchecked: guide`, sources: [{ date: LANDED, url: "https://mixrow.example/1" }] });
    live.events.push(ev("Split", ["T2", "T3"]), ev("Context", []));
    return live;
  };
  const split = (live: LadderLive) => live.events.find((e) => e.event === "Split")!;
  it("fires at the owed date, not the day before — a non-holding mixed: never; its linked row is researched", () => {
    const [due, early] = [planRun(mixed(), TODAY), planRun(mixed(), addDays(TODAY, -1))];
    expect([due.mixedOwed, early.mixedOwed]).toEqual([[`Split (${TODAY})`], undefined]);
    expect([!!due.armRules?.mixedOwed, !!early.armRules?.mixedOwed]).toEqual([true, false]);
    expect(due.research.map((r) => r.sign)).toContain("mixrow");
  });
  it("apply cuts T2+T3 → T3 at the owed date and → none at owed + STALE_REVIEW_DAYS, keeping the pre-cut holds; a same-day re-apply moves nothing", () => {
    const cut = applyEvents(mixed(), {}, "eufin", TODAY);
    expect([split(cut.next).holds, split(cut.next).heldBefore, cut.delta]).toEqual([["T3"], ["T2", "T3"], [`events   Split — mixed owed ${TODAY}: holds [T2,T3] → [T3]`]]);
    const again = applyEvents(cut.next, {}, "eufin", TODAY);
    expect([again.next, again.delta]).toEqual([cut.next, []]);
    const STALE = addDays(TODAY, STALE_REVIEW_DAYS);
    expect(split(applyEvents(cut.next, {}, "eufin", addDays(STALE, -1)).next).holds).toEqual(["T3"]);
    const gone = applyEvents(cut.next, {}, "eufin", STALE);
    expect([split(gone.next).holds, split(gone.next).heldBefore, gone.delta]).toEqual([[], ["T2", "T3"], [`events   Split — mixed unanswered ${STALE}: holds [T3] → []`]]);
    expect(planRun(gone.next, STALE).mixedOwed).toEqual([`Split (${TODAY})`]);
    expect(split(applyRun(mixed(), unchanged(mixed()), TODAY).next).holds).toEqual(["T3"]);
    // A holds write on an owed event would wipe `heldBefore` and dodge the valve — refused.
    expect(() => applyEvents(cut.next, { events: { Split: { holds: ["T2"] } } }, "eufin", TODAY)).toThrow(/event "Split" mixedOwed: a holds write does not answer it/);
    // …but a liftBy-only write leaves the valve alone (holds + heldBefore kept), as the full-run apply accepts it
    expect(split(applyEvents(cut.next, { events: { Split: { liftBy: ["Context"] } } }, "eufin", TODAY).next)).toMatchObject({ liftBy: ["Context"], holds: ["T3"], heldBefore: ["T2", "T3"] });
  });
  it("each cut step pushes at a block release's priority on both apply paths; a same-day re-apply pushes nothing", () => {
    const STALE = addDays(TODAY, STALE_REVIEW_DAYS);
    const cut = applyEvents(mixed(), {}, "eufin", TODAY);
    const gone = applyEvents(cut.next, {}, "eufin", STALE);
    const run = applyRun(mixed(), unchanged(mixed()), TODAY);
    const runGone = applyRun(run.next, { ...unchanged(run.next, STALE), situation: sitFor(run.next, STALE) }, STALE);
    const owed = { priority: 3, title: expect.stringContaining("Split mixed owed: holds [T2,T3]->[T3]") };
    const stale = { priority: 3, title: expect.stringContaining("Split mixed unanswered: holds [T3]->[]") };
    expect([cut.alert, gone.alert, run.alert, runGone.alert]).toMatchObject([owed, stale, owed, stale]);
    expect(applyEvents(cut.next, {}, "eufin", TODAY).alert).toBeUndefined();
  });
  it("an escalation: re-land restores the pre-cut holds, a fizzle: re-land drops the field; a date move is refused", () => {
    const cut = applyEvents(mixed(), {}, "eufin", TODAY).next;
    const escPatch = land(cut, { Split: `escalation: guide cut, ${TODAY.slice(5)}` });
    escPatch.events!.Split!.liftBy = ["Context"]; // an escalation that blocks a row names its lift
    const esc = applyRun(cut, escPatch, TODAY);
    expect([split(esc.next).holds, split(esc.next).heldBefore, planRun(esc.next, TODAY).mixedOwed]).toEqual([["T2", "T3"], undefined, undefined]);
    expect(esc.delta).toContain("events   Split — escalation re-land: holds [T3] → [T2,T3]");
    const fiz = applyRun(cut, land(cut, { Split: `fizzle: guide held, ${TODAY.slice(5)}` }), TODAY).next; // absorbed + old enough → retired
    expect([allEvents(fiz).find((e) => e.event === "Split")?.holds, planRun(fiz, TODAY).mixedOwed]).toEqual([["T3"], undefined]);
    const kept = structuredClone(cut); // a fizzle `retireEvents` keeps (blocked.by names it)
    split(kept).status = `fizzle: guide held, ${TODAY.slice(5)}`;
    kept.signs[0]!.blocked = { on: TODAY, by: "Split" };
    const held = applyEvents(kept, {}, "eufin", TODAY);
    expect([split(held.next).holds, "heldBefore" in split(held.next), held.delta]).toEqual([["T3"], false, []]);
    expect(() => applyRun(cut, { ...unchanged(cut), situation: sitFor(cut, TODAY), events: { Split: { date: TODAY } } }, TODAY)).toThrow(/event "Split" mixedOwed: a date move does not answer it/);
    // From the stale step (holds [] — nothing for drop's own holds check to see): drop is refused, escalation restores the full set.
    const STALE = addDays(TODAY, STALE_REVIEW_DAYS);
    const gone = applyEvents(cut, {}, "eufin", STALE).next;
    expect(() => applyRun(gone, { ...unchanged(gone, STALE), situation: sitFor(gone, STALE), events: { Split: { drop: "moot" } } }, STALE)).toThrow(/event "Split" mixedOwed: drop refused/);
    const late = land(gone, { Split: `escalation: guide cut, ${STALE.slice(5)}` }, STALE);
    late.events!.Split!.liftBy = ["Context"];
    const restored = applyRun(gone, late, STALE);
    expect([split(restored.next).holds, split(restored.next).heldBefore]).toEqual([["T2", "T3"], undefined]);
    expect(restored.delta).toContain("events   Split — escalation re-land: holds [] → [T2,T3]");
    // A re-land keeping the landing's sources (or carrying only ones dated on it) does not answer it.
    const stalePatch = (sources?: LadderSource[]): LadderPatch => {
      const p = land(cut, { Split: `fizzle: guide held, ${TODAY.slice(5)}` });
      if (sources) p.events!.Split!.sources = sources;
      else delete p.events!.Split!.sources;
      return p;
    };
    for (const sources of [undefined, split(cut).sources!]) expect(() => applyRun(cut, stalePatch(sources), TODAY)).toThrow(/event "Split" mixedOwed: a re-land answers it only from a source dated after the landing/);
  });
});

describe(":state events — a retired event a row's staleAfter owes is printed beside findingOwed", () => {
  it("prints the owed eventsDone entry (no escalationIf/fizzleIf) and leaves it out of eventsSettled", () => {
    const live = fixture(); // rating: checked 10-07, sourced 10-01
    live.eventsDone = [{ date: "2026-10-03", event: "Unread", signs: ["rating"], holds: [], secondary: true, status: "fizzle: affirmed, 10-03" }, { date: "2026-09-01", event: "Settled", signs: ["ecb"], holds: [], secondary: true, status: "fizzle: paused, 09-01" }];
    const plan = planRun(live, TODAY);
    expect(plan.findingOwed).toContain("rating after Unread");
    expect(plan.events.find((e) => e.event === "Unread")).toEqual({ date: "2026-10-03", event: "Unread", signs: ["rating"], holds: [], status: "fizzle: affirmed, 10-03" });
    expect(plan.eventsSettled).toBe(1); // Settled
  });
});

describe("clock + label vets", () => {
  it("nowArg: absent = the system clock, but a `--today` backfill without `--now` has no clock; a given `--now` wins; a non-instant fails", () => {
    const wall = new Date("2026-10-17T09:00:00Z");
    expect(nowArg([], "x", wall)).toBe(wall);
    expect(nowArg(["--today=2020-01-01"], "x", wall)).toBeUndefined();
    expect(nowArg(["--today=2020-01-01", "--now=2026-10-17T09:00:00+03:00"], "x", wall)?.toISOString()).toBe("2026-10-17T06:00:00.000Z");
    expect(() => nowArg(["--now=soon"], "x", wall)).toThrow(/--now "soon" is not an ISO instant/);
  });
  it("QUIET since <MM-DD> takes only a listing URL (bare or bracketed), never a note", () => {
    const live = fixture();
    const quiet = (label: string) => () => applyRun(live, { ...unchanged(live), signs: { ...unchanged(live).signs, weekly: { label } } }, TODAY);
    expect(quiet("QUIET since 10-01 (+3d)")).toThrow(/weekly: label "QUIET since 10-01 \(\+3d\)" is not a research label/);
    expect(quiet("QUIET since 10-01 [https://weekly.example/list]")).not.toThrow();
    expect(quiet("QUIET since 10-01 https://weekly.example/list")).not.toThrow();
  });
});

describe("withMeasured — a sign's `measure` script reading rides its due research row", () => {
  const live = (): LadderLive => ({ ...fixture(), signs: [sign("rating", { measure: "probe:x" }), sign("ecb")] });
  const rows = () => planRun(live(), TODAY).research.filter((r) => r.sign === "rating" || r.sign === "ecb");
  const ok = { asOf: "2026-10-07", text: "Yahoo close 10-07: 4 of 29 (14 %) above MA50", sources: [{ date: "2026-10-07", url: "https://finance.yahoo.com/quote/%5ESOX/history" }] };
  it("attaches the parsed reading to the measure row only, calling the row's own script", () => {
    expect(rows().map((r) => r.sign)).toEqual(["rating", "ecb"]);
    const calls: string[] = [];
    const out = withMeasured(rows(), live(), (s) => (calls.push(s), JSON.stringify(ok)));
    expect(calls).toEqual(["probe:x"]);
    expect(out.find((r) => r.sign === "rating")!.measured).toEqual(ok);
    expect(out.find((r) => r.sign === "ecb")!.measured).toBeUndefined();
  });
  it("turns a script's {error}, a throw or a malformed print into {error} naming the script", () => {
    const one = (print: () => string) => withMeasured(rows(), live(), print).find((r) => r.sign === "rating")!.measured;
    expect(one(() => JSON.stringify({ error: "no sheet" }))).toEqual({ error: "probe:x: no sheet" });
    expect(one(() => { throw new Error("spawn npm ENOENT\nstack"); })).toEqual({ error: "probe:x: spawn npm ENOENT" });
    expect(one(() => JSON.stringify({ ...ok, sources: [] }))).toEqual({ error: expect.stringMatching(/^probe:x: malformed/) });
    expect(one(() => JSON.stringify({ ...ok, asOf: "10-07" }))).toEqual({ error: expect.stringMatching(/^probe:x: malformed/) });
  });
});

describe("dropMeasuredCalls — R1: a measured non-block row skips its web calls", () => {
  const ok = { asOf: "2026-10-07", text: "FRED close 10-07: 1.9 %", sources: [{ date: "2026-10-07", url: "https://fred.example/x" }] };
  const live = (): LadderLive => ({ ...fixture(), events: [], signs: [sign("meas", { measure: "probe:ok" }), sign("gate", { measure: "probe:ok", block: true }), sign("err", { measure: "probe:err" }), sign("plain")] });
  const plan = () => {
    const p = planRun(live(), TODAY);
    return dropMeasuredCalls({ ...p, research: withMeasured(p.research, live(), (s) => JSON.stringify(s === "probe:ok" ? ok : { error: "down" })) }, live());
  };
  it("empties the reading row's calls and marks its stub; a block row and an {error} row keep theirs", () => {
    const { research, patch } = plan();
    const row = (s: string) => research.find((r) => r.sign === s)!;
    expect(row("meas")).toMatchObject({ fetch: [], query: [], more: [], extended: false, measuredOnly: true });
    expect(row("meas").sides).toBeUndefined();
    for (const s of ["gate", "err", "plain"]) expect([s, row(s).query.length > 0, row(s).measuredOnly]).toEqual([s, true, undefined]);
    expect(patch!.signs).toMatchObject({ meas: { measuredOnly: true } });
    expect(Object.entries(patch!.signs).filter(([, v]) => v.measuredOnly).map(([k]) => k)).toEqual(["meas"]);
  });
  it("apply leaves a measuredOnly row's fails + extendedOn alone; unmarked, it resets fails and stamps", () => {
    const url = "https://meas.example/list";
    const held = (): LadderLive => ({ ...fixture(), events: [], signs: [sign("meas", { measure: "probe:ok", sources: [], fails: { [url]: 1 }, extendedOn: "2026-10-01" })] });
    expect(planRun(held(), TODAY).research[0]).toMatchObject({ fetch: [url], extended: true });
    const after = (mark: boolean) => applyRun(held(), { signs: { meas: { label: "UNSOURCED", ...(mark && { measuredOnly: true as const }) } } }, TODAY).next.signs[0]!;
    expect([after(true).fails, after(true).extendedOn]).toEqual([{ [url]: 1 }, "2026-10-01"]);
    expect([after(false).fails, after(false).extendedOn]).toEqual([undefined, TODAY]);
  });
  it("a measuredOnly on a row without a non-block `measure` is dropped with a warning", () => {
    const l: LadderLive = { ...fixture(), events: [], signs: [sign("plain", { fails: { "https://plain.example/list": 1 } })] };
    const { next, delta } = applyRun(l, { signs: { plain: { label: "UNCHANGED", measuredOnly: true } } }, TODAY);
    expect(delta).toContain("warn plain — measuredOnly dropped: only on a non-block `measure` row");
    expect(next.signs[0]!.fails).toBeUndefined();
  });
});

it("fillMechanical fills a missing mechanical row from the pre-label stub with a warn; a missing judgement row still refuses", () => {
  const live = fixture();
  const research = planRun(live, TODAY).research;
  const stub = prelabel(research, [], TODAY).patch;
  const p = unchanged(live);
  delete p.signs.rating;
  const { patch, warned } = fillMechanical(p, stub, research.map((r) => r.sign));
  expect(warned).toEqual([`warn rating — missing from the patch: filled from its pre-label ${stub.signs.rating!.label}`]);
  expect(applyRun(live, patch as LadderPatch, TODAY).next.signs.find((s) => s.sign === "rating")!.label).toMatch(new RegExp(`^${stub.signs.rating!.label}`));
  const judged = fillMechanical(p, { signs: { ...stub.signs, rating: { label: "" } } }, research.map((r) => r.sign));
  expect(judged.warned).toEqual([]);
  expect(() => applyRun(live, judged.patch as LadderPatch, TODAY)).toThrow(/researched rows missing from the patch: rating/);
});

it("withMeasured runs no script for a measure sign that is not on the due rows", () => {
  const live: LadderLive = { ...fixture(), signs: [sign("rating", { measure: "probe:x" }), sign("ecb")] };
  const rows = planRun(live, TODAY).research.filter((r) => r.sign === "ecb");
  const out = withMeasured(rows, live, () => { throw new Error("ran"); });
  expect(out.map((r) => [r.sign, r.measured])).toEqual([["ecb", undefined]]);
});

describe(":state print size", () => {
  it("drops an event dated past today + EVENT_HORIZON_DAYS and every row's `why`; the stored JSON keeps both", () => {
    const live = fixture();
    live.events.push({ ...live.events[2]!, event: "edge", date: addDays(TODAY, EVENT_HORIZON_DAYS) }, { ...live.events[2]!, event: "beyond", date: addDays(TODAY, EVENT_HORIZON_DAYS + 1) });
    const plan = planRun(live, TODAY);
    expect(plan.events.map((e) => e.event)).toEqual(["Moody's", "Votes", "ECB", "edge"]);
    expect(plan.eventsLater).toEqual([`beyond (${addDays(TODAY, EVENT_HORIZON_DAYS + 1)})`]);
    expect(plan.research.length).toBeGreaterThan(0);
    for (const r of plan.research) expect(r).not.toHaveProperty("why");
    expect(live.events.map((e) => e.event)).toContain("beyond");
  });
});

describe("block lifecycle — auto-lift ([USER 2026-11-09]: a linked fizzle, a later fizzle naming a manual / liftBy-less block's row, or a sourced fizzle lean; an unrelated fizzle demotes)", () => {
  const D2 = "2026-10-09";
  /** The fixture + a second pending event on `budget` and a context row `ctx` the Votes escalation also names. */
  const world = (votes: Partial<LadderLive["events"][number]> = {}): LadderLive => {
    const live = fixture();
    live.signs.find((s) => s.sign === "budget")!.lean = "escalation-leaning"; // an escalation-group call: the landing blocks it
    live.signs.push(sign("ctx", { measurable: "a note; BLOCKING = none (context row)", due: "2026-10-30" }));
    live.events.push({ date: "2026-10-30", event: "Budget2", signs: ["budget"], escalationIf: "x", fizzleIf: "y", holds: [], secondary: false, status: "NOT DUE until 2026-10-30" });
    Object.assign(live.events.find((e) => e.event === "Votes")!, { date: "2026-10-07", signs: ["budget", "ctx"], liftBy: ["Budget2"], ...votes });
    return live;
  };
  const blockedBy = (live: LadderLive): LadderLive => applyRun(live, land(live, { Votes: "escalation: censure passed, 2026-10-08" }), TODAY).next;
  const row = (live: LadderLive, name: string) => live.signs.find((s) => s.sign === name)!;
  it("an escalation blocks its named rows but never a context row; a patch may not block one either", () => {
    const next = blockedBy(world());
    expect([row(next, "budget").block, row(next, "ctx").block]).toEqual([true, false]);
    const live = world();
    expect(() => applyRun(live, { ...unchanged(live), signs: { ...unchanged(live).signs, ecb: { label: "UNCHANGED 10-01", block: true, unblocking: "pause" } } }, TODAY)).not.toThrow();
    live.signs.find((s) => s.sign === "ecb")!.measurable = "BLOCKING = none (context row)";
    expect(() => applyRun(live, { ...unchanged(live), signs: { ...unchanged(live).signs, ecb: { label: "UNCHANGED 10-01", block: true } } }, TODAY)).toThrow(/ecb: a context row \(BLOCKING = none\) never blocks/);
  });
  it("a later fizzle on an event in the block's lifts lifts it — a same-run escalation beats the lift; an unrelated fizzle naming the row demotes one tier (all → T2·T3 → released), never lifts", () => {
    const b = blockedBy(world());
    const { next, delta, alert } = applyRun(b, land(b, { Budget2: "fizzle: deal, 2026-10-09" }, D2), D2);
    expect(row(next, "budget").block).toBe(false);
    expect(delta).toContain("LIFTED   budget — Budget2 fizzle");
    expect(alert?.title ?? "").toMatch(/budget unblocked/);
    const late = (from: LadderLive, event: string, d: string) => {
      const add = { date: d, event, signs: ["budget"], escalationIf: "x", fizzleIf: "y", holds: [] as LadderLive["events"][number]["holds"], secondary: false, status: `fizzle: y, ${d}`, sources: graded(d, event) };
      return applyRun(from, { ...unchanged(from, d), situation: sitFor(from, d), signs: { ...unchanged(from, d).signs, budget: { label: `UNCHANGED ${d.slice(5)}`, finding: `after ${event}, ${d.slice(5)}`, sources: graded(d, `after-${event}`) } }, eventsAdd: [add] }, d);
    };
    const once = late(b, "Late", D2);
    expect([row(once.next, "budget").block, row(once.next, "budget").blocked?.reach], "Late is not in the Votes block's lifts (liftBy: Budget2)").toEqual([true, "T2T3"]);
    expect(once.delta).toContain("DEMOTED  budget — unrelated evidence (Late; cause Votes) → T2·T3");
    expect(once.alert?.title ?? "", "the title flattens non-ASCII: — → -").toContain("budget demoted - unrelated evidence (Late; cause Votes)");
    expect(renderLadderMd({ ...once.next, verdict: { ...once.next.verdict!, legs: [], escalation: { tripped: 0, need: 2, hits: [] } } }, "eufin")).toContain("· T2·T3 (demoted)");
    const t = (id: "T1" | "T2") => ({ id, ok: true }) as LadderTranche;
    expect([afterHolds(once.next, D2, t("T1")), afterHolds(once.next, D2, t("T2"))], "a demoted block on an all-reach leg holds T2·T3 only").toEqual(["✓", "HELD (BLOCK: budget)"]);
    const twice = late(once.next, "Later", "2026-10-10");
    expect([row(twice.next, "budget").block, row(twice.next, "budget").blocked?.reach]).toEqual([false, "released"]);
    expect(twice.alert?.title ?? "", "the second demotion names its evidence, never a spares release").toContain("budget demoted - unrelated evidence (Later; cause Votes)");
    const both = world();
    expect(row(applyRun(both, land(both, { Votes: "escalation: censure passed, 2026-10-08", Budget2: "fizzle: deal, 2026-10-08" }), TODAY).next, "budget").block).toBe(true);
  });
  it("past reviewBy with no fresh source demotes one tier + pushes `BLOCK stale`; a fresh sourced escalation source re-arms full reach", () => {
    const b = blockedBy(world());
    const quiet = (from: LadderLive, d: string): LadderPatch => answered(from, d, { ...unchanged(from, d), situation: sitFor(from, d) });
    expect(movesVerdict(b, quiet(b, D2), D2), "before its review a quiet run moves no reach").toBe(false);
    row(b, "budget").blocked!.reviewBy = TODAY;
    expect(movesVerdict(b, quiet(b, D2), D2), "a stale demotion re-verdicts").toBe(true);
    const stale = applyRun(b, quiet(b, D2), D2);
    expect([row(stale.next, "budget").block, row(stale.next, "budget").blocked?.reach, row(stale.next, "budget").blocked?.reviewBy]).toEqual([true, "T2T3", addDays(D2, STALE_REVIEW_DAYS)]);
    expect(stale.alert?.title ?? "").toContain("BLOCK stale: budget - T2-T3");
    const D3 = "2026-10-10";
    const fresh: LadderPatch = { ...quiet(stale.next, D3), signs: { ...quiet(stale.next, D3).signs, budget: { label: "CHANGED", finding: "censure upheld", lean: "escalation-leaning", sources: graded(D3, "re") } } };
    const rearmed = applyRun(stale.next, fresh, D3);
    expect([row(rearmed.next, "budget").block, row(rearmed.next, "budget").blocked?.reach, row(rearmed.next, "budget").blocked?.reviewBy]).toEqual([true, undefined, addDays(D3, STALE_REVIEW_DAYS)]);
  });
  it("an escalation landing evidence dated past its own review is born at full reach — `BLOCK (Votes)`, no stale step", () => {
    const live = world();
    Object.assign(live.events.find((e) => e.event === "Budget2")!, { date: "2026-09-20", status: "NOT DUE until 2026-09-20" });
    const p = land(live, { Votes: "escalation: censure passed, 2026-09-10" });
    p.events!.Votes!.sources = graded("2026-09-10", "Votes");
    const { next, alert, delta } = applyRun(live, p, TODAY);
    expect([row(next, "budget").block, row(next, "budget").blocked?.on, row(next, "budget").blocked?.reach, row(next, "budget").blocked?.reviewBy]).toEqual([true, "2026-09-10", undefined, addDays(TODAY, STALE_REVIEW_DAYS)]);
    expect(alert?.title ?? "").toContain("budget BLOCK (Votes)");
    expect([alert?.title ?? "", delta.join("\n")].join("\n")).not.toMatch(/stale/i);
  });
  describe("contractOwed", () => {
    const quiet = (from: LadderLive, d: string): LadderPatch => ({ ...unchanged(from, d), situation: sitFor(from, d) });
    /** budget held at T2·T3 after one stale review, its Budget2 lift (10-30) inside its review — owed on the stale review alone. */
    const demoted = (): LadderLive => {
      const b = blockedBy(world());
      Object.assign(row(b, "budget").blocked!, { reach: "T2T3", staleReviews: 1, reviewed: TODAY, reviewBy: "2026-11-30" });
      return b;
    };
    const run = (from: LadderLive, p: Partial<LadderPatch["signs"][string]> = {}, extra: Partial<LadderPatch> = {}) =>
      ((q) => applyRun(from, { ...q, signs: { ...q.signs, budget: { ...q.signs.budget!, ...p } }, ...extra }, D2))(quiet(from, D2));
    const CHANGED = { label: "CHANGED", finding: "censure upheld", lean: "escalation-leaning" };
    it("a block neither stale-demoted nor stuck-prone owes nothing; one stale review owes the rewrite, and apply refuses the run unanswered", () => {
      expect(planRun(blockedBy(world()), D2).contractOwed).toBeUndefined();
      expect(planRun(demoted(), D2).contractOwed).toEqual(["budget — 1 stale review"]);
      expect(() => run(demoted())).toThrow(/budget: contractOwed unanswered/);
    });
    it("each answer passes and stamps `blocked.rewritten`, owing nothing next run: a fresh sourced escalation source, a new dated liftBy event, a new `unblocking` clause", () => {
      const add = { date: "2026-10-25", event: "Appeal", signs: [], escalationIf: "x", fizzleIf: "y", holds: [] as LadderLive["events"][number]["holds"], secondary: false };
      const answers = [run(demoted(), { ...CHANGED, sources: graded(D2, "re") }), run(demoted(), {}, { events: { Votes: { liftBy: ["Budget2", "Appeal"] } }, eventsAdd: [add] }), run(demoted(), { unblocking: "censure withdrawn" })];
      expect(answers.map((r) => [row(r.next, "budget").blocked?.rewritten, planRun(r.next, "2026-10-10").contractOwed])).toEqual(Array(3).fill([D2, undefined]));
      expect(row(answers[2]!.next, "budget").measurable).toBe("; UNBLOCKING = censure withdrawn");
    });
    it("on an owed row `unblocking` replaces its stored UNBLOCKING clause, never appends; a repeat (whitespace / case aside) answers nothing", () => {
      const owed = ((b) => ((row(b, "budget").measurable = "BLOCKING = censure; UNBLOCKING = censure lifted"), b))(demoted());
      expect(row(run(owed, { unblocking: "censure withdrawn" }).next, "budget").measurable).toBe("BLOCKING = censure; UNBLOCKING = censure withdrawn");
      expect(() => run(owed, { unblocking: "  Censure   LIFTED " })).toThrow(/budget: unblocking repeats the row's UNBLOCKING clause[^\n]*\n[^\n]*budget: contractOwed unanswered/);
      expect(() => run(((b) => ((row(b, "budget").measurable = "UNBLOCKING = censure lifted"), b))(blockedBy(world())), { unblocking: "censure withdrawn" }), "a row owing nothing keeps its clause").toThrow(/budget: unblocking on a row whose measurable already carries an UNBLOCKING clause/);
    });
    it("an answer landing on the run whose review goes stale leaves the row owed the next run", () => {
      const b = blockedBy(world());
      row(b, "budget").blocked!.reviewBy = TODAY;
      expect(planRun(b, D2).contractOwed).toEqual(["budget — earliest lift 10-30 > review 10-08"]);
      const { next } = run(b, { unblocking: "censure withdrawn" });
      expect([row(next, "budget").blocked?.staleReviews, planRun(next, "2026-10-10").contractOwed]).toEqual([1, [`budget — 1 stale review · earliest lift 10-30 > review ${addDays(D2, STALE_REVIEW_DAYS).slice(5)}`]]);
    });
    it("no answer: a source not dated after the last review, a liftBy naming only the stored lift, a measurableDraft UNBLOCKING clause", () => {
      expect(() => run(demoted(), { ...CHANGED, sources: graded(TODAY, "old") })).toThrow(/budget: contractOwed unanswered/);
      expect(() => run(demoted(), {}, { events: { Votes: { liftBy: ["Budget2"] } } })).toThrow(/budget: contractOwed unanswered/);
      expect(() => run(demoted(), { measurableDraft: "UNBLOCKING = censure withdrawn" }), "a draft clause is no answer").toThrow(/budget: contractOwed unanswered/);
    });
  });
  describe("STALE_REVIEW_CAP + pin", () => {
    const [D3, D4] = ["2026-10-10", "2026-10-11"];
    const quiet = (from: LadderLive, d: string): LadderPatch => answered(from, d, { ...unchanged(from, d), situation: sitFor(from, d) });
    /** One stale review applied (all → T2·T3, `staleReviews` 1), its new `reviewBy` forced past for the next run. */
    const staleOnce = (): LadderLive => {
      const b = blockedBy(world());
      row(b, "budget").blocked!.reviewBy = TODAY;
      const s1 = applyRun(b, quiet(b, D2), D2).next;
      row(s1, "budget").blocked!.reviewBy = D2;
      return s1;
    };
    it("the cap's stale review releases the block (cause kept, `BLOCK released` push, a re-verdict); a later escalation re-blocks at full reach, staleReviews cleared", () => {
      const s1 = staleOnce();
      expect(STALE_REVIEW_CAP).toBeGreaterThan(1);
      row(s1, "budget").blocked!.staleReviews = STALE_REVIEW_CAP - 1;
      expect(movesVerdict(s1, quiet(s1, D3), D3)).toBe(true);
      const capped = applyRun(s1, quiet(s1, D3), D3);
      expect(row(capped.next, "budget")).toMatchObject({ block: false, blocked: { reach: "released", cause: "Votes", staleReviews: STALE_REVIEW_CAP } });
      expect(capped.alert?.title ?? "").toContain(`BLOCK released: budget - ${STALE_REVIEW_CAP} stale reviews`);
      const add = { date: D4, event: "Votes2", signs: ["budget"], escalationIf: "x", fizzleIf: "y", holds: [] as LadderLive["events"][number]["holds"], secondary: false, status: `escalation: x, ${D4}`, sources: graded(D4, "Votes2"), liftBy: ["Budget2"] };
      row(capped.next, "budget").blocked!.pinned = { until: "2026-10-20" };
      const p = quiet(capped.next, D4);
      const re = applyRun(capped.next, { ...p, signs: { ...p.signs, budget: { label: `UNCHANGED ${D4.slice(5)}`, finding: `after Votes2, ${D4}`, sources: graded(D4, "after-Votes2") } }, eventsAdd: [add] }, D4);
      expect([row(re.next, "budget").block, row(re.next, "budget").blocked?.by, row(re.next, "budget").blocked?.reach, row(re.next, "budget").blocked?.staleReviews, row(re.next, "budget").blocked?.pinned]).toEqual([true, "Votes2", undefined, undefined, undefined]);
      expect(re.alert?.title ?? "").toContain("budget BLOCK (Votes2)");
    });
    it("a held T2·T3 block re-escalated to full reach pushes `BLOCK (<by>)` — outranking a pin set on the row that run, which alone pushes `BLOCK pinned`", () => {
      const s1 = staleOnce();
      expect([row(s1, "budget").block, row(s1, "budget").blocked?.reach]).toEqual([true, "T2T3"]);
      const add = { date: D3, event: "Votes2", signs: ["budget"], escalationIf: "x", fizzleIf: "y", holds: [] as LadderLive["events"][number]["holds"], secondary: false, status: `escalation: x, ${D3}`, sources: graded(D3, "Votes2"), liftBy: ["Budget2"] };
      const fresh = (pin?: string) => ({ label: `UNCHANGED ${D3.slice(5)}`, finding: `after Votes2, ${D3}`, sources: graded(D3, "after-Votes2"), ...(pin && { pin }) });
      const re = (pin?: string) => applyRun(s1, { ...quiet(s1, D3), signs: { ...quiet(s1, D3).signs, budget: fresh(pin) }, eventsAdd: [add] }, D3);
      const plain = re();
      expect([row(plain.next, "budget").block, row(plain.next, "budget").blocked?.reach]).toEqual([true, undefined]);
      expect(plain.alert?.title ?? "").toContain("budget BLOCK (Votes2)");
      expect(re("2026-10-20").alert?.title ?? "").toMatch(/budget BLOCK \(Votes2\)(?!.*pinned)/);
      const b = blockedBy(world());
      const pinOnly = applyRun(b, { ...quiet(b, D2), signs: { ...quiet(b, D2).signs, budget: { label: "CHANGED", finding: "censure upheld", lean: "escalation-leaning", sources: graded(D2, "re"), pin: "2026-10-20" } } }, D2);
      expect(pinOnly.alert?.title ?? "").toContain("BLOCK pinned: budget to 10-20");
    });
    it("a live pin holds the reach through a stale review at the cap (`BLOCK pinned` push, no re-verdict); once expired the cap releases it and apply drops the pin", () => {
      const s1 = staleOnce();
      row(s1, "budget").blocked!.pinned = { until: D3 };
      expect(movesVerdict(s1, quiet(s1, D3), D3)).toBe(false);
      const held = applyRun(s1, quiet(s1, D3), D3);
      expect([row(held.next, "budget").block, row(held.next, "budget").blocked?.reach, row(held.next, "budget").blocked?.staleReviews]).toEqual([true, "T2T3", 2]);
      expect(held.alert?.title ?? "").toContain("BLOCK pinned: budget to 10-10");
      row(held.next, "budget").blocked!.reviewBy = D3;
      const after = applyRun(held.next, quiet(held.next, D4), D4);
      expect([row(after.next, "budget").block, row(after.next, "budget").blocked?.reach, row(after.next, "budget").blocked?.pinned]).toEqual([false, "released", undefined]);
    });
    it("a patch `pin` is vetted — a fresh sourced escalation-group source in the same patch, today < date ≤ today + PIN_MAX_DAYS, a holding block — and stamps `blocked.pinned` (md `· pinned to MM-DD`)", () => {
      const b = blockedBy(world());
      const pin = (from: LadderLive, d: string, p: Partial<LadderPatch["signs"][string]>) => applyRun(from, { ...quiet(from, d), signs: { ...quiet(from, d).signs, budget: { label: "CHANGED", finding: "censure upheld", lean: "escalation-leaning", sources: graded(d, "re"), ...p } } }, d);
      const ok = pin(b, D2, { pin: "2026-10-20" });
      expect(row(ok.next, "budget").blocked?.pinned).toEqual({ until: "2026-10-20" });
      expect(ok.delta).toContain("PIN-SET  budget — pinned to 10-20");
      expect(renderLadderMd({ ...ok.next, verdict: { ...ok.next.verdict!, legs: [], escalation: { tripped: 0, need: 2, hits: [] } } }, "eufin")).toContain("· pinned to 10-20");
      expect(() => pin(b, D2, { pin: "2026-10-20", sources: graded(TODAY, "old") }), "a source not dated after the last review").toThrow(/budget: pin needs a fresh sourced escalation-group source/);
      expect(() => pin(b, D2, { pin: "2026-10-20", label: `UNCHANGED ${D2.slice(5)}`, finding: undefined, lean: undefined }), "UNCHANGED reads the stored escalation-group lean").not.toThrow();
      expect(() => pin(b, D2, { pin: addDays(D2, PIN_MAX_DAYS + 1) })).toThrow(/budget: pin is a YYYY-MM-DD date after today/);
      expect(() => pin(b, D2, { pin: D2 })).toThrow(/budget: pin is a YYYY-MM-DD date after today/);
      const rel = structuredClone(b);
      Object.assign(row(rel, "budget"), { block: false, blocked: { ...row(rel, "budget").blocked!, reach: "released" } });
      expect(() => pin(rel, D2, { pin: "2026-10-20" }), "a released row holds nothing").toThrow(/budget: pin rides a holding block/);
    });
  });
  it("liftBy: a fizzle on an event that does NOT name the row lifts it only when the blocking escalation lists that event", () => {
    const moodys = (b: LadderLive) => row(applyRun(b, land(b, { "Moody's": "fizzle: affirmed, 2026-10-09" }, D2), D2).next, "budget").block;
    expect(moodys(blockedBy(world()))).toBe(true);
    const linked = blockedBy(world({ liftBy: ["Moody's"] }));
    expect(moodys(linked)).toBe(false);
    expect(applyRun(linked, land(linked, { "Moody's": "fizzle: affirmed, 2026-10-09" }, D2), D2).delta).toContain("LIFTED   budget — Moody's fizzle (liftBy of Votes)");
    const live = world();
    expect(() => applyRun(live, { ...land(live, { Votes: "escalation: censure passed, 2026-10-08" }), events: { Votes: { status: "escalation: censure passed, 2026-10-08", sources: graded(TODAY, "Votes"), liftBy: ["Nope"] } } }, TODAY)).toThrow(/liftBy names "Nope"/);
  });
  it("offCause: a flagged mixed: on the block's liftBy event lifts it; un-flagged it holds; on a fizzle or a non-liftBy event apply refuses", () => {
    const linked = blockedBy(world({ liftBy: ["Moody's"] }));
    const MX = "mixed: affirmed, 2026-10-09 — unchecked: outlook";
    /** Lands `event` at `status` on `base`, flagged `offCause` when given; `edit` reshapes the patch first. */
    const mixed = (event: string, status: string, offCause?: unknown, base = linked, edit: (p: LadderPatch) => LadderPatch = (p) => p) =>
      ((p) => (offCause !== undefined && ((p.events![event] as Record<string, unknown>).offCause = offCause), applyRun(base, edit(p), D2)))(land(base, { [event]: status }, D2));
    const lifted = mixed("Moody's", MX, true);
    expect([row(lifted.next, "budget").block, lifted.next.events.find((e) => e.event === "Moody's")?.offCause]).toEqual([false, true]);
    expect(lifted.delta).toContain("LIFTED   budget — Moody's mixed (off-cause: outlook; liftBy of Votes)");
    const held = mixed("Moody's", MX).next;
    expect(row(held, "budget").block).toBe(true);
    const refused: [string, () => unknown, RegExp][] = [
      ["a fizzle", () => mixed("Moody's", "fizzle: affirmed, 2026-10-09", true), /offCause rides a mixed: status — this patch sends "fizzle:"/],
      ["a non-liftBy event", () => mixed("Budget2", "mixed: deal, 2026-10-09 — unchecked: vote", true), /offCause lifts no block/],
      ["a re-sent stored mixed:", () => mixed("Moody's", MX, true, held), /offCause rides a new status — this mixed: one is already stored/],
      ["offCause: false", () => mixed("Moody's", MX, false), /offCause is `true` or absent/],
      ["an event dated before blocked.on", () => mixed("Moody's", MX, true, ((b) => ((b.events.find((e) => e.event === "Moody's")!.date = "2026-10-07"), b))(structuredClone(linked))), /offCause lifts no block/],
      ["a patch block key on the row", () => mixed("Moody's", MX, true, linked, (p) => ({ ...p, signs: { ...p.signs, budget: { ...p.signs.budget!, block: true } } })), /offCause lifts no block/],
    ];
    for (const [why, run, msg] of refused) expect(run, why).toThrow(msg);
    // A same-patch liftBy rewrite counts whatever the key order: the vet reads the state every event patch left.
    const plain = blockedBy(world());
    const relinked = (votesFirst: boolean) =>
      mixed("Moody's", MX, true, plain, (p) => ({ ...p, events: ((v, m) => (votesFirst ? { Votes: v, "Moody's": m } : { "Moody's": m, Votes: v }))({ liftBy: ["Budget2", "Moody's"] }, p.events!["Moody's"]!) }));
    expect([row(relinked(true).next, "budget").block, row(relinked(false).next, "budget").block]).toEqual([false, false]);
    // Two held blocks of different causes both listing the event: off-cause is per block, the flag per event — refused.
    const two = structuredClone(linked);
    Object.assign(two.events.find((e) => e.event === "ECB")!, { date: "2026-09-30", status: "escalation: hike, 2026-09-30", liftBy: ["Moody's"] });
    Object.assign(two.signs.find((s) => s.sign === "ecb")!, { block: true, blocked: { on: "2026-09-30", by: "ECB" } });
    expect(row(mixed("Moody's", MX, undefined, two).next, "ecb").block, "the two-cause world holds both blocks").toBe(true);
    expect(() => mixed("Moody's", MX, true, two)).toThrow(/offCause is per event but off-cause is per block — it would lift blocks of 2 causes \(Votes, ECB\)/);
  });
  it("a researched row re-read to a fizzle lean lifts its own block; a quiet lean does not; a re-sent escalation does not re-block", () => {
    const b = blockedBy(world());
    const patch = (p: LadderPatch["signs"][string]) => ({ ...unchanged(b, D2), situation: sitFor(b, D2), signs: { ...unchanged(b, D2).signs, budget: p } });
    const src = graded(D2, "b2");
    const fizzled = applyRun(b, patch({ label: "CHANGED", finding: "deal agreed", lean: "fizzle-leaning", sources: src }), D2);
    expect(row(fizzled.next, "budget").block).toBe(false);
    expect(fizzled.delta).toContain("LIFTED   budget — lean fizzle-leaning");
    expect(row(applyRun(b, patch({ label: "CHANGED", finding: "no news", lean: "quiet", sources: src }), D2).next, "budget").block).toBe(true);
    expect(movesVerdict(b, patch({ label: "CHANGED", finding: "deal agreed", lean: "fizzle-leaning", sources: src }), D2)).toBe(true);
    expect(movesVerdict(b, patch({ label: "CHANGED", finding: "no news", lean: "quiet", sources: src }), D2)).toBe(false);
    const resent = applyRun(fizzled.next, { ...land(fizzled.next, {}, "2026-10-10"), events: { Votes: { status: "escalation: censure passed, 2026-10-08" } } }, "2026-10-10").next;
    expect(row(resent, "budget").block).toBe(false);
  });
  it("only evidence dated after the block lifts it: a quiet re-read or an old fizzle does not; the stamp records the escalation and liftBy reads only its own", () => {
    const b = blockedBy(world());
    row(b, "budget").lean = "fizzle-leaning"; // a lifting lean held off pre-block evidence
    expect(row(b, "budget").blocked).toMatchObject({ on: TODAY, by: "Votes" });
    expect(row(applyRun(b, { ...unchanged(b, D2), situation: sitFor(b, D2) }, D2).next, "budget").block, "UNCHANGED <held> re-cites pre-block evidence").toBe(true);
    const fresh = { ...unchanged(b, D2), situation: sitFor(b, D2), signs: { ...unchanged(b, D2).signs, budget: { label: "UNCHANGED 10-09", finding: "deal holds, 10-09", sources: graded(D2, "fresh") } } };
    expect(row(applyRun(b, fresh, D2).next, "budget").block).toBe(false);
    const quiet = structuredClone(b);
    row(quiet, "budget").sources.unshift({ date: D2, url: "https://budget.example/q" });
    expect(row(applyRun(quiet, { ...unchanged(quiet, D2), situation: sitFor(quiet, D2), signs: { ...unchanged(quiet, D2).signs, budget: { label: "QUIET since 10-09 https://budget.example/list" } } }, D2).next, "budget").block, "a QUIET label is no reading").toBe(true);
    const old = { date: "2026-10-05", event: "Old", signs: ["budget"], escalationIf: "x", fizzleIf: "y", holds: [] as LadderLive["events"][number]["holds"], secondary: false, status: "fizzle: y, 2026-10-05", sources: graded(D2, "old") };
    const o = blockedBy(world()); // a non-lifting lean, so only the event could lift it
    const backfill = applyRun(o, { ...unchanged(o, D2), situation: sitFor(o, D2), signs: { ...unchanged(o, D2).signs, budget: { label: "UNCHANGED 10-09", finding: "after Old, 10-09", sources: graded(D2, "after-old") } }, eventsAdd: [old] }, D2).next;
    expect(row(backfill, "budget").block, "a fizzle dated before the block").toBe(true);
    const kept = land(b, { Budget2: "fizzle: deal, 2026-10-09" }, D2);
    kept.signs.budget = { ...kept.signs.budget!, block: true };
    expect(row(applyRun(b, kept, D2).next, "budget").block, "a patch block key beats a lift").toBe(true);
    const linked = blockedBy(world({ liftBy: ["Moody's"] }));
    linked.events.find((e) => e.event === "Budget2")!.date = "2026-10-08";
    const reblLand = land(linked, { Budget2: "escalation: no deal, 2026-10-09" }, D2);
    reblLand.events!.Budget2!.liftBy = ["ECB"];
    const rebl = applyRun(linked, reblLand, D2).next;
    expect(row(rebl, "budget").blocked?.by).toBe("Budget2");
    expect(row(applyRun(rebl, land(rebl, { "Moody's": "fizzle: affirmed, 2026-10-10" }, "2026-10-10"), "2026-10-10").next, "budget").block, "Votes' liftBy never lifts Budget2's block").toBe(true);
  });
  it("an escalation's block dates from its evidence — the landed outcome's newest source, else the event's own date; a source dated past the run day is refused", () => {
    const live = world(); // Votes dated 10-07, landed on the 10-08 run
    const stamp = (sources?: LadderSource[]): LadderSign["blocked"] => {
      const p = land(live, { Votes: "escalation: censure passed, 2026-10-06" });
      p.events!.Votes!.sources = sources;
      return row(applyRun(live, p, TODAY).next, "budget").blocked;
    };
    const src = (date: string, host: string): LadderSource => ({ date, url: `https://${host}.example/v` });
    expect(stamp([src("2026-10-05", "rating"), src("2026-10-06", "budget")])).toMatchObject({ on: "2026-10-06", by: "Votes" });
    expect(() => stamp([src("2026-10-06", "budget"), src("2026-10-09", "later")])).toThrow(`event "Votes" source: date 2026-10-09 is after today ${TODAY}`);
    expect(stamp(), "no sources → the event's date").toMatchObject({ on: "2026-10-07", by: "Votes" });
  });
  it("a landed eventsAdd escalation blocks and stamps; --events-only refuses a landed escalation:/fizzle: (it never moves blocks)", () => {
    const live = world();
    const add = { date: TODAY, event: "Shock", signs: ["ecb"], escalationIf: "x", fizzleIf: "y", holds: [] as LadderLive["events"][number]["holds"], secondary: false, status: "escalation: x, 2026-10-08", sources: graded(TODAY, "shock"), liftBy: ["ECB"] };
    expect(row(applyRun(live, { ...unchanged(live), situation: SIT, signs: { ...unchanged(live).signs, ecb: { label: "UNCHANGED 10-08", finding: "after Shock, 10-08", sources: graded(TODAY, "after-shock") } }, eventsAdd: [add] }, TODAY).next, "ecb")).toMatchObject({ block: true, blocked: { on: TODAY, by: "Shock" } });
    expect(() => applyEvents(live, { eventsAdd: [add] }, "value", TODAY)).toThrow(/eventsAdd "Shock": a landed escalation:\/fizzle: moves blocks/);
  });
  it("planRun's blockLifts lists a block whose earliest lift (here a liftBy event) is within the window, by date; one 30 d out is absent", () => {
    /** `world()` blocked by Votes, whose `liftBy` names `Lift` (an event not on `budget`) dated `date`; Budget2 (the row's own lift) pushed past it. */
    const liftIn = (date: string): LadderLive => {
      const live = world({ liftBy: ["Lift"] });
      live.events.push({ date, event: "Lift", signs: ["ecb"], escalationIf: "x", fizzleIf: "y", holds: [], secondary: false, status: `NOT DUE until ${date}` });
      live.events.find((e) => e.event === "Budget2")!.date = "2026-11-30";
      return blockedBy(live);
    };
    expect(planRun(liftIn(addDays(TODAY, 10)), TODAY).blockLifts).toEqual([{ sign: "budget", event: "Lift", date: "2026-10-18" }]);
    expect(planRun(liftIn(addDays(TODAY, 30)), TODAY)).not.toHaveProperty("blockLifts");
  });
  it("an escalation releases a row its `spares` names — no block, due every run — until its cause's fizzle clears it; a `called:` off-group lean alone still blocks", () => {
    const live = world({ liftBy: ["Moody's"] });
    row(live, "budget").lean = "open"; // the pre-run lean `called:` records
    const landing = land(live, { Votes: "escalation: censure passed, 2026-10-08" });
    expect(row(applyRun(live, landing, TODAY).next, "budget"), "called: budget=open without spares").toMatchObject({ block: true, blocked: { by: "Votes" } });
    landing.events!.Votes!.spares = ["budget"];
    const rel = applyRun(live, landing, TODAY);
    expect(rel.next.events.find((e) => e.event === "Votes")).toMatchObject({ status: expect.stringMatching(/ · called: budget=open, ctx=open$/), spares: ["budget"] });
    expect(row(rel.next, "budget")).toMatchObject({ block: false, blocked: { on: TODAY, by: "Votes", reach: "released" }, due: TODAY });
    expect(rel.delta).toContain("RELEASED budget — Votes spares it");
    expect(rel.alert?.title ?? "").toMatch(/budget released \(Votes\)/);
    expect([researched(rel.next, D2), researched(rel.next, TODAY)], "watched: due every run, not re-researched the day it was checked").toEqual([expect.arrayContaining(["budget"]), expect.not.arrayContaining(["budget"])]);
    const again = applyRun(rel.next, { ...unchanged(rel.next, D2), situation: sitFor(rel.next, D2) }, D2).next;
    expect(row(again, "budget"), "still due on the run after").toMatchObject({ block: false, blocked: { reach: "released" }, due: D2 });
    const day3 = "2026-10-10";
    const cleared = applyRun(again, land(again, { "Moody's": "fizzle: affirmed, 2026-10-10" }, day3), day3);
    expect(row(cleared.next, "budget")).not.toHaveProperty("blocked");
    expect(cleared.delta).toContain("CLEARED  budget — Moody's fizzle (liftBy of Votes)");
    expect(cleared.alert?.title ?? "").toMatch(/budget cleared/);
  });
  it("`spares` is vetted: an escalation: status's own listed signs only", () => {
    const live = world();
    const on = (status: string, spares: string[]) => () => applyRun(live, { ...land(live, { Votes: status }), events: { Votes: { status, spares } } }, TODAY);
    expect(on("fizzle: deal, 2026-10-08", ["budget"])).toThrow(/spares rides an escalation: status/);
    expect(on("escalation: censure, 2026-10-08", ["rating"])).toThrow(/spares names "rating" — not a sign the event lists/);
  });
  it("a legacy block whose escalation `spares` the row reads released — no BLOCK tag, a re-verdict — and the next apply persists it", () => {
    const live = blockedBy(world());
    const spare = { ...unchanged(live, D2), situation: sitFor(live, D2), events: { Votes: { spares: ["budget"] } } };
    expect([movesVerdict(live, spare, D2), movesVerdict(live, { ...unchanged(live, D2), events: {} }, D2)], "a spares patch re-verdicts").toEqual([true, false]);
    const patched = applyRun(live, spare, D2);
    expect([row(patched.next, "budget"), patched.next.events.find((e) => e.event === "Votes")]).toMatchObject([{ block: false, blocked: { by: "Votes", reach: "released" } }, { spares: ["budget"] }]);
    expect(movesVerdict(patched.next, { ...unchanged(patched.next, D2), events: { Votes: { spares: ["budget"] } } }, D2), "an echoed stored spares re-uses step 1's verdict").toBe(false);
    live.events.find((e) => e.event === "Votes")!.spares = ["budget"]; // the stored shape a spares patch leaves
    expect(row(live, "budget")).toMatchObject({ block: true, blocked: { on: TODAY, by: "Votes" } });
    expect(tagOf(live, row(live, "budget"), D2)).not.toBe("BLOCK");
    const { next, delta, alert } = applyRun(live, { ...unchanged(live, D2), situation: sitFor(live, D2) }, D2);
    expect(row(next, "budget")).toMatchObject({ block: false, blocked: { on: TODAY, by: "Votes", reach: "released" }, due: D2 });
    expect(delta).toContain("RELEASED budget — Votes spares it");
    expect(alert?.title ?? "").toMatch(/budget released \(Votes\)/);
  });
  it("an escalation that blocks a row needs liftBy (patched or stored); one sparing every row it blocks does not", () => {
    const live = world({ liftBy: undefined });
    const landing = land(live, { Votes: "escalation: censure passed, 2026-10-08" });
    const votes = (over: Partial<NonNullable<LadderPatch["events"]>[string]>) => () => applyRun(live, { ...landing, events: { Votes: { ...landing.events!.Votes!, ...over } } }, TODAY);
    expect(votes({})).toThrow(/Votes: an escalation that blocks budget needs liftBy — the events whose fizzle lifts it/);
    expect(votes({ liftBy: ["Budget2"] })).not.toThrow();
    expect(votes({ spares: ["budget"] }), "ctx is a context row, budget spared").not.toThrow();
    const esc = world({ liftBy: undefined, status: "escalation: censure passed, 2026-10-08" });
    const again = (status: string) => () => applyRun(esc, land(esc, { Votes: status }), TODAY);
    expect(again("escalation: censure passed, 2026-10-08"), "a re-stated escalation sets no new block").not.toThrow();
    expect(again("escalation: censure widened, 2026-10-08")).toThrow(/Votes: an escalation that blocks budget needs liftBy/);
    const add = (liftBy?: string[]) => () => applyRun(live, { ...unchanged(live), situation: SIT, signs: { ...unchanged(live).signs, ecb: { label: "UNCHANGED 10-08", finding: "after Shock, 10-08", sources: graded(TODAY, "after-shock") } }, eventsAdd: [{ date: TODAY, event: "Shock", signs: ["ecb"], escalationIf: "x", fizzleIf: "y", holds: [], secondary: false, status: "escalation: x, 2026-10-08", sources: graded(TODAY, "shock"), ...(liftBy && { liftBy }) }] }, TODAY);
    expect(add()).toThrow(/Shock: an escalation that blocks ecb needs liftBy/);
    expect(add(["ECB"])).not.toThrow();
  });
  it("a new patch `block: true` needs an UNBLOCKING clause — stored, or `unblocking` appended to the base; a re-sent one does not", () => {
    const live = world();
    const blk = (l: LadderLive, p: Partial<LadderPatch["signs"][string]>, today = TODAY) => applyRun(l, { ...unchanged(l, today), situation: sitFor(l, today), signs: { ...unchanged(l, today).signs, ecb: { ...unchanged(l, today).signs.ecb!, block: true, ...p } } }, today);
    expect(() => blk(live, {})).toThrow(/ecb: block: true needs an UNBLOCKING = … clause — add unblocking: "<clause>"/);
    row(live, "ecb").measurable = "BLOCKING = hike · draft: bear = hike ; fizzle = pause";
    const { next } = blk(live, { unblocking: "a pause" });
    expect(row(next, "ecb")).toMatchObject({ block: true, measurable: "BLOCKING = hike; UNBLOCKING = a pause · draft: bear = hike ; fizzle = pause" });
    expect(row(next, "ecb").blocked, "the ECB event dates the review").toEqual({ on: TODAY, setRun: TODAY, cause: "manual", lifts: ["ECB", "UNBLOCKING clause"], reviewBy: addDays("2026-10-29", REVIEW_GRACE_DAYS) });
    expect(() => blk(next, { unblocking: "again" }, D2)).toThrow(/ecb: unblocking on a row whose measurable already carries an UNBLOCKING clause/);
    expect(() => blk(live, { unblocking: "x = y" })).toThrow(/ecb: unblocking is one clause body — no " = " or ";"/);
    const b = blockedBy(world());
    const resent = { ...unchanged(b, D2), situation: sitFor(b, D2) };
    resent.signs.budget = { ...resent.signs.budget!, block: true };
    expect(() => applyRun(b, resent, D2)).not.toThrow();
  });
  it("a stored block on a context row is lifted on the next run", () => {
    const live = world();
    row(live, "ctx").block = true;
    const { next, delta } = applyRun(live, { ...unchanged(live), situation: SIT }, TODAY);
    expect(row(next, "ctx").block).toBe(false);
    expect(delta).toContain("LIFTED   ctx — context row — BLOCKING = none");
  });
  it("causeFalse through applyRun: the first stamps `blocked.causeFalseOn`, a second NEUTRAL_LIFT_GAP_DAYS later lifts", () => {
    const live = fixture();
    Object.assign(row(live, "budget"), { block: true, lean: "open", blocked: { on: "2026-10-05" } });
    const cf = (from: LadderLive, d: string) => ((q) => applyRun(from, { ...q, situation: sitFor(from, d), signs: { ...q.signs, budget: { label: "CHANGED", finding: `cause false by ${d}`, lean: "open", causeFalse: true, sources: graded(d, d) } } }, d))(unchanged(from, d));
    const first = cf(live, TODAY);
    expect([row(first.next, "budget").block, row(first.next, "budget").blocked?.causeFalseOn]).toEqual([true, TODAY]);
    const second = cf(first.next, addDays(TODAY, NEUTRAL_LIFT_GAP_DAYS));
    expect(second.delta).toContain("LIFTED   budget — cause sourced false");
    expect([row(second.next, "budget").block, row(second.next, "budget").blocked]).toEqual([false, undefined]);
  });
});

describe("applyRun characterization — patch-shape vetting + event-patch arms", () => {
  const thrown = (f: () => unknown): string => {
    try {
      f();
    } catch (e) {
      return e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
    }
    return "no throw";
  };
  it("mis-shaped patch, unit and event entries: today's thrown error per case", () => {
    const live = fixture();
    const base = unchanged(live);
    const first = Object.keys(base.signs)[0]!;
    expect({
      nullPatch: thrown(() => applyRun(live, null as never, TODAY)),
      rowNotObject: thrown(() => applyRun(live, { ...base, signs: { ...base.signs, [first]: "x" } } as never, TODAY)),
      eventsList: thrown(() => applyRun(live, { ...base, events: [] } as never, TODAY)),
      eventsAddObject: thrown(() => applyRun(live, { ...base, eventsAdd: {} } as never, TODAY)),
      situationKeyAndSlot: thrown(() => applyRun(live, { ...base, situation: { ...SIT, bogus: "x", lean: "" } } as never, TODAY)),
      eventNull: thrown(() => applyRun(live, { ...base, events: { Votes: null } } as never, TODAY)),
      eventUnknown: thrown(() => applyRun(live, { ...base, events: { Nope: { status: "fizzle: x" } } }, TODAY)),
    }).toMatchSnapshot();
  });
  it("event-patch state: pre-read stores its preRead, a re-sent landing keeps sources, a patched called: is replaced, a pending sources-only patch keeps its pre read", () => {
    const live = fixture();
    live.events.push({ date: "2026-10-09", event: "FOMC", signs: [], escalationIf: "hike", fizzleIf: "hold", holds: [], secondary: true, status: "NOT DUE until 2026-10-09", preRead: "CME FedWatch hike odds" });
    const preRead = { text: "CME FedWatch hike odds", sources: ["https://www.investing.com/central-banks/fed-rate-monitor"] };
    const withRead = applyRun(live, { ...unchanged(live), events: { FOMC: { status: "pre 2026-10-08: hold 84 % (investing.com)", preRead } } }, TODAY).next;
    const landedOnce = applyRun(live, land(live, { Votes: "fizzle: deal, 10-08" }), TODAY).next;
    const resent = applyRun(landedOnce, { ...unchanged(landedOnce), events: { Votes: { status: "fizzle: deal, 10-08" } } }, TODAY).next;
    const recalled = applyRun(live, land(live, { Votes: "fizzle: deal, 10-08 · called: budget=escalation" }), TODAY).next;
    const pending = fixture();
    pending.events[1]!.status = "NOT DUE until 2026-10-09 · pre 2026-10-08: hold";
    const pressOnly = applyRun(pending, { ...unchanged(pending), events: { Votes: { sources: [{ date: TODAY, url: "https://press.example/v" }] } } }, TODAY).next;
    const ev = (l: LadderLive, name: string) => l.events.find((e) => e.event === name);
    expect({ withRead: ev(withRead, "FOMC"), resent: ev(resent, "Votes"), recalled: ev(recalled, "Votes")!.status, pressOnly: ev(pressOnly, "Votes")!.status }).toMatchSnapshot();
  });
});

describe("measured lifts — apply persists the probe's verdict.lifts", () => {
  const LIFT = { sign: "credit", series: "BAMLH0A3HYC", value: 11.4, date: "2026-10-07", since: "2026-10-06" };
  const world = (over: Partial<LadderSign> = {}, lifts = [LIFT]): LadderLive => {
    const live = fixture();
    live.signs.push(sign("credit", { block: true, blocked: { on: "2026-10-01" }, measurable: "bear = CCC ≥ 12.5 %; fizzle = CCC < 11.5 %", checked: TODAY, due: "2026-10-20", ...over }));
    live.verdict = { ...live.verdict!, lifts };
    return live;
  };
  const apply = (live: LadderLive, extra: LadderPatch["signs"] = {}) => applyRun(live, answered(live, TODAY, { ...unchanged(live, TODAY, "value"), signs: { ...unchanged(live, TODAY, "value").signs, ...extra }, situation: sitFor(live, TODAY) }, "value"), TODAY, "value");
  const credit = (live: LadderLive) => live.signs.find((s) => s.sign === "credit")!;
  it("verdict.lifts lifts the block with no patch key on the row: the LIFTED line, block cleared, a re-verdict owed", () => {
    const live = world();
    expect(unchanged(live, TODAY, "value").signs.credit, "the row is not even researched").toBeUndefined();
    const { next, delta } = apply(live);
    expect(delta).toContain("LIFTED   credit — measured: BAMLH0A3HYC 11.4");
    expect([credit(next).block, credit(next).blocked]).toEqual([false, undefined]);
    expect([movesVerdict(live, unchanged(live, TODAY, "value"), TODAY), movesVerdict(world({}, []), unchanged(live, TODAY, "value"), TODAY)]).toEqual([true, false]);
  });
  it("kept: an older close read dated before the block's `on` (the newest after it), a drifted clause, a leg without the binding, or a patch `block` key on the row", () => {
    const held = (r: ReturnType<typeof apply>) => [credit(r.next).block, r.delta.some((l) => l.startsWith("LIFTED   credit"))];
    expect(held(apply(world({}, [{ ...LIFT, since: "2026-09-30" }])))).toEqual([true, false]);
    expect(held(apply(world({ measurable: "fizzle = CCC < 11.0 %" })))).toEqual([true, false]);
    const live = world();
    expect(held(applyRun(live, answered(live, TODAY, { ...unchanged(live, TODAY, "sp500"), situation: sitFor(live, TODAY) }, "sp500"), TODAY, "sp500"))).toEqual([true, false]);
    expect(held(apply(world({ checked: "2026-10-01", due: "2026-10-07" }), { credit: { label: "UNCHANGED 10-01", block: true } }))).toEqual([true, false]);
  });
});

describe("applySign characterization — sign-patch vetting + merge arms", () => {
  const thrown = (f: () => unknown): string => {
    try {
      f();
    } catch (e) {
      return e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
    }
    return "no throw";
  };
  const withEcb = (live: LadderLive, ecb: unknown) => ({ signs: { ...unchanged(live).signs, ecb }, situation: SIT }) as never;
  it("mis-vetted sign patches: today's thrown error per case", () => {
    const live = fixture();
    const src = [{ date: TODAY, url: "https://x.example/8" }];
    const cases: Record<string, unknown> = {
      badKeyAndTyped: { label: "CHANGED", bogus: 1, finding: 1 },
      labelNotString: { label: 5 },
      changedBare: { label: "CHANGED", sources: src },
      leanOffChanged: { label: `UNCHANGED ${TODAY.slice(5)}`, lean: "open", sources: src },
      draftBad: { label: "CHANGED", finding: "f", lean: "nope", measurableDraft: "garbage", sources: src },
      findingOffChanged: { label: "UNSOURCED", finding: "f" },
      boardNumber: { label: "CHANGED", finding: "at 3.1 (10-07 close)", lean: "open", sources: src },
      sourcesNotList: { label: "UNSOURCED", sources: "x", searchNext: "ecb 2026 q3" },
      primaryNoReplace: { label: "UNSOURCED", primary: [], searchNext: " " },
      inWindowSearchNext: { label: "UNCHANGED 10-01", searchNext: "ecb hike odds" },
      labelDateOff: { label: "STALE 09-01", sources: src },
    };
    const ctx = fixture();
    ctx.signs[2]!.measurable = "bear = a; fizzle = b; BLOCKING = none (context row)";
    const ctxCases = { contextBlock: { label: "UNCHANGED 10-01", block: true }, draftOnThreshold: { label: "UNCHANGED 10-01", measurableDraft: "open = a ; quiet = b" } };
    const run = (l: LadderLive, c: Record<string, unknown>) => Object.entries(c).map(([k, p]) => [k, thrown(() => applyRun(l, withEcb(l, p), TODAY))]);
    expect(Object.fromEntries([...run(live, cases), ...run(ctx, ctxCases)])).toMatchSnapshot();
  });
  it("merged row state: CHANGED + draft + unblocking + block, a fail count, a bare row's searchNext + quiet, an extended stamp, an unblock", () => {
    const pick = ({ label, finding, lean, leanLog, measurable, sources, searchNext, block, blocked, fails, primary, quiet, checked, extendedOn }: LadderSign) => ({ label, finding, lean, leanLog, measurable, sources, searchNext, block, blocked, fails, primary, quiet, checked, extendedOn });
    const ecbOf = (l: LadderLive) => pick(l.signs.find((s) => s.sign === "ecb")!);
    const live = fixture();
    live.signs[2]!.measurable = "date yes; BLOCKING = a hike";
    const changed = applyRun(live, withEcb(live, { label: "CHANGED", finding: "hike priced, 10-08", lean: "escalation-leaning", measurableDraft: "escalation-leaning = a ; fizzle-leaning = b", unblocking: "a pause", block: true, failed: ["https://ecb.example/list"], sources: [{ date: TODAY, url: "https://x.example/8" }] }), TODAY).next;
    const bare = fixture();
    bare.signs[2]!.sources = [];
    bare.signs[2]!.searchNext = ["ecb old stem"];
    bare.signs[2]!.quiet = 2;
    const quietRow = applyRun(bare, withEcb(bare, { label: "UNSOURCED", searchNext: "ecb hike odds" }), TODAY).next;
    const again = applyRun(quietRow, { signs: { ...unchanged(quietRow, "2026-10-15").signs, ecb: { label: "UNSOURCED", searchNext: "ecb hike odds" } }, situation: sitFor(quietRow, "2026-10-15") }, "2026-10-15").next;
    const blockedLive = fixture();
    Object.assign(blockedLive.signs[2]!, { block: true, blocked: { on: "2026-10-01" }, measurable: "date yes; BLOCKING = a hike; UNBLOCKING = a pause" });
    const unblocked = applyRun(blockedLive, withEcb(blockedLive, { label: "UNCHANGED 10-01", block: false }), TODAY).next;
    expect({ changed: ecbOf(changed), quietRow: ecbOf(quietRow), again: ecbOf(again), unblocked: ecbOf(unblocked) }).toMatchSnapshot();
  });
});
