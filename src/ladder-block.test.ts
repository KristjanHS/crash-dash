import { describe, expect, it } from "vitest";
import { bindingOn, blockLine, deriveContract, heldSigns, liftsDue, liftTaken, measuredLift, reachOf, resolveBlocks, stuckProne, REVIEW_FALLBACK_DAYS, REVIEW_GRACE_DAYS, reviewedSigns, reviewMoves, STALE_REVIEW_DAYS, tierReason, vetBlockSet, vetContractOwed, withUnblocking, NEUTRAL_LIFT_GAP_DAYS, postPatchSources, sourceWindowStart } from "./ladder-block.js";
import { addDays, planRun, type LadderPatch } from "./ladder-run.js";
import { movesVerdict } from "./ladder-reverdict.js";
import { renderLadderMd, type LadderEvent, type LadderLive, type LadderSign } from "./ladder-live.js";

const TODAY = "2026-11-13";
const sign = (over: Partial<LadderSign>): LadderSign => ({ sign: "capex_guides", label: "UNCHANGED 11-08", lean: "neutral (press only) (draft)", finding: "no 2027 guide", why: "manual", measurable: "Big-4 first 2027 capex ≤ +10 % · draft: bear = cut ; fizzle = raise", block: true, checked: TODAY, due: TODAY, primary: [], search: [], seed: [], sources: [], blocked: { on: "2026-11-09", by: "US midterms" }, ...over });
const ev = (date: string, event: string, status: string, signs = ["capex_guides"], liftBy?: string[]): LadderEvent => ({ date, event, signs, escalationIf: "e", fizzleIf: "f", holds: [], secondary: false, status, ...(liftBy && { liftBy }) });
const EVENTS = [
  ev("2026-10-29", "Amazon Q3", "fizzle: AWS +39 %, 10-29"),
  ev("2026-11-17", "NVDA FQ3-27", "NOT DUE until 2026-11-17"),
  ev("2026-11-03", "US midterms", "escalation: Democrats won both chambers, 11-04", ["capex_guides", "ai_funding"]),
  ev("2027-01-03", "New Congress seated", "NOT DUE until 2027-01-03"),
  ev("2026-11-06", "Fed speakers", "NOT DUE until 2026-11-06"),
  ev("2026-11-10", "SOX rebalance", "mixed: weights trimmed, 11-10"),
];
const LEAN = "a sourced fizzle-leaning or fizzle lean";
const CAPEX_LINE = `since 11-09 (US midterms) · lifts on: NVDA FQ3-27 11-17 fizzle · New Congress seated 01-03 fizzle · ${LEAN}`;

describe("reachOf — a veto block's box reach", () => {
  it("an \"all\" leg reaches every tranche whatever its measured half; a graded leg reaches T2·T3 until the measured half trips, then all", () => {
    expect([reachOf(false, "all"), reachOf(true, "all"), reachOf(false, "graded"), reachOf(true, "graded")]).toEqual(["all", "all", "T2T3", "all"]);
    expect([reachOf(true, "graded", "T2T3"), reachOf(false, "all", "T2T3")], "a demoted block (blocked.reach T2T3) reaches T2·T3 whatever the leg or its measured half").toEqual(["T2T3", "T2T3"]);
  });
});

describe("deriveContract / blockLine", () => {
  it("semis capex_guides: a legacy {on, by} row derives its pending lifts in date order, day = run − on", () => {
    const c = deriveContract(sign({}), EVENTS, TODAY)!;
    expect(c).toEqual({ on: "2026-11-09", by: "US midterms", cause: "US midterms", lifts: [{ event: "NVDA FQ3-27", date: "2026-11-17" }, { event: "New Congress seated", date: "2027-01-03" }], unblocking: false, sourcedLean: true, released: false, day: 4 });
    expect(blockLine(c)).toBe(CAPEX_LINE);
  });
  it("semis capex_guides as stored: a `called: capex_guides=neutral` (the pre-event lean) holds the legacy block; its escalation's `spares` reads it released (holds nothing, no lean or UNBLOCKING path, a RELEASED cell)", () => {
    const midterms = (over: Partial<LadderEvent>) => EVENTS.map((e) => (e.event === "US midterms" ? { ...e, status: `${e.status} · called: capex_guides=neutral, ai_funding=bear (press only)`, ...over } : e));
    expect([deriveContract(sign({}), midterms({}), TODAY)!.released, heldSigns([sign({})], midterms({}))[0]!.block]).toEqual([false, true]);
    const spared = midterms({ spares: ["capex_guides"] });
    expect(deriveContract(sign({}), spared, TODAY)).toMatchObject({ released: true, sourcedLean: false, unblocking: false, lifts: [{ event: "NVDA FQ3-27" }, { event: "New Congress seated" }] });
    expect(heldSigns([sign({})], spared)[0]!.block).toBe(false);
    expect(renderLadderMd({ run: TODAY, rules: [], signs: [sign({})], events: spared, calendar: [], runs: [] }, "semis")).toContain("(draft) · RELEASED since 11-09 (US midterms) | capex_guides |");
  });
  it("a no-`by` row renders no (), an escalation with `liftBy` lifts on its `liftBy` events only (not the row's own — those demote), an UNBLOCKING clause is named; a probe row names none; an unblocked row has no contract", () => {
    const events = EVENTS.map((e) => (e.event === "US midterms" ? { ...e, liftBy: ["Fed minutes"] } : e)).concat(ev("2026-11-20", "Fed minutes", "NOT DUE until 2026-11-20", []));
    const manual = deriveContract(sign({ blocked: { on: "2026-11-05" } }), EVENTS, TODAY)!;
    expect(["by" in manual, manual.cause]).toEqual([false, "manual"]);
    expect(blockLine(manual)).toBe(`since 11-05 · lifts on: Fed speakers 11-06 fizzle · NVDA FQ3-27 11-17 fizzle · New Congress seated 01-03 fizzle · ${LEAN}`);
    expect(blockLine(deriveContract(sign({ measurable: "BLOCKING = cut ; UNBLOCKING = raise" }), events, TODAY)!)).toBe(`since 11-09 (US midterms) · lifts on: Fed minutes 11-20 fizzle · UNBLOCKING clause · ${LEAN}`);
    expect(blockLine(deriveContract(sign({ sign: "other", probe: true, blocked: { on: "2026-11-05" } }), EVENTS, TODAY)!)).toBe("since 11-05 · lifts on: none named");
    expect([deriveContract(sign({ block: false }), EVENTS, TODAY), deriveContract(sign({ blocked: undefined }), EVENTS, TODAY)]).toEqual([undefined, undefined]);
  });
  it("renderLadderMd: the lean cell carries `since … · day N` and a footnote holding the lifts", () => {
    const live: LadderLive = { run: TODAY, rules: [], signs: [sign({}), sign({ sign: "pc_demand", lean: "bear", blocked: { on: "2026-11-05" } })], events: EVENTS, calendar: [], runs: [] };
    const md = renderLadderMd(live, "semis");
    expect(md).toContain("| ▲ bear · **BLOCK** since 11-05 · day 8[^1] | pc_demand |");
    expect(md).toContain("· **BLOCK** since 11-09 (US midterms) · day 4[^2] | capex_guides |");
    expect(md).toContain(`[^1]: lifts on: ${LEAN}\n\n[^2]: lifts on: NVDA FQ3-27 11-17 fizzle · New Congress seated 01-03 fizzle · ${LEAN}\n`);
  });
  it("a `liftBy` event dated before `on` is no lift (resolveBlocks' fizzle needs date ≥ on on both paths); a passed, unlanded one ≥ on is still the earliest due", () => {
    const events = [...EVENTS.map((e) => (e.event === "US midterms" ? { ...e, liftBy: ["Overdue", "Passed"] } : e)), ev("2026-11-07", "Overdue", "NOT DUE until 2026-11-07", []), ev("2026-11-10", "Passed", "outcome unsourced", [])];
    expect(deriveContract(sign({}), events, TODAY)!.lifts.map((l) => l.event)).toEqual(["Passed"]);
    expect(liftsDue([sign({})], events, TODAY)).toEqual([{ sign: "capex_guides", event: "Passed", date: "2026-11-10" }]);
  });
  it("a `dropped:` event naming the row is no lift", () => {
    expect(deriveContract(sign({}), [...EVENTS, ev("2026-11-12", "Gone", "dropped: cancelled")], TODAY)!.lifts.map((l) => l.event)).toEqual(["NVDA FQ3-27", "New Congress seated"]);
  });
});

describe("resolveBlocks — the stored lift contract", () => {
  const stamp = (s: LadderSign): LadderSign["blocked"] => {
    const live: LadderLive = { run: TODAY, rules: [], signs: [s], events: EVENTS, calendar: [], runs: [] };
    resolveBlocks(live, { signs: {} }, [], new Set(), TODAY);
    return live.signs[0]!.blocked;
  };
  it("sp500 private_credit: a manual legacy block, no lift event → on + 21 d", () => {
    expect(stamp(sign({ sign: "private_credit", blocked: { on: "2026-11-05" } }))).toEqual({ on: "2026-11-05", setRun: TODAY, cause: "manual", lifts: [], reviewBy: addDays("2026-11-05", REVIEW_FALLBACK_DAYS) });
  });
  it("capex_guides: earliest dated lift + 7 d, the UNBLOCKING clause named; a stored contract is kept", () => {
    expect(stamp(sign({ measurable: "BLOCKING = cut ; UNBLOCKING = raise" }))).toEqual({ on: "2026-11-09", by: "US midterms", setRun: TODAY, cause: "US midterms", lifts: ["NVDA FQ3-27", "New Congress seated", "UNBLOCKING clause"], reviewBy: addDays("2026-11-17", REVIEW_GRACE_DAYS) });
    const held = { on: "2026-11-09", by: "US midterms", setRun: "2026-11-10", cause: "US midterms", lifts: [], reviewBy: "2026-11-30" };
    expect(stamp(sign({ blocked: held }))).toEqual(held);
  });
  const STALE = { on: "2026-11-09", by: "US midterms", setRun: "2026-11-10", cause: "US midterms", lifts: [], reviewBy: "2026-11-30" };
  const SHOCK = ev("2026-11-12", "Shock", "escalation: gated, 11-12", ["capex_guides", "ai_funding"], ["Fed minutes"]);
  const escalate = (signs: LadderSign[], shock: LadderEvent): LadderSign["blocked"][] => {
    const live: LadderLive = { run: TODAY, rules: [], signs, events: [...EVENTS, ev("2026-11-20", "Fed minutes", "NOT DUE until 2026-11-20", []), shock], calendar: [], runs: [] };
    resolveBlocks(live, { signs: {} }, [shock], new Set(), TODAY);
    return live.signs.map((s) => s.blocked);
  };
  const LIFTS = ["NVDA FQ3-27", "Fed minutes", "New Congress seated"];
  it("a new `by` on a stamped block re-derives its whole contract — its `liftBy` events alone", () => {
    expect(escalate([sign({ blocked: STALE })], SHOCK)).toEqual([{ on: "2026-11-12", by: "Shock", setRun: TODAY, cause: "Shock", lifts: ["Fed minutes"], reviewBy: addDays("2026-11-20", REVIEW_GRACE_DAYS) }]);
  });
  it("a sparing escalation on an unblocked row stamps a fresh release", () => {
    const rel = { on: "2026-11-12", by: "Shock", reach: "released", setRun: TODAY, cause: "Shock" };
    expect(escalate([sign({ block: false, blocked: undefined }), sign({ sign: "ai_funding", block: false, blocked: { ...STALE, reach: "released" } })], { ...SHOCK, spares: ["capex_guides", "ai_funding"] })).toEqual([
      { ...rel, lifts: LIFTS, reviewBy: addDays("2026-11-17", REVIEW_GRACE_DAYS) },
      { ...rel, lifts: ["Fed minutes"], reviewBy: addDays("2026-11-20", REVIEW_GRACE_DAYS) },
    ]);
  });
});

describe("resolveBlocks — cause-matched lift vs unrelated demotion (one membership rule with deriveContract)", () => {
  const ON = { on: "2026-11-09", by: "Esc" };
  const esc = (liftBy?: string[]): LadderEvent => ev("2026-11-03", "Esc", "escalation: x, 11-04", ["capex_guides"], liftBy);
  const fz = (event: string, signs: string[] = ["capex_guides"]): LadderEvent => ev("2026-11-12", event, "fizzle: y, 11-12", signs);
  /** The run's LIFTED / DEMOTED lines over one hand-built (unstamped unless given) row. */
  const run = (s: LadderSign, by: LadderEvent, landing: LadderEvent[], patch: Parameters<typeof resolveBlocks>[1] = { signs: {} }): string[] => {
    const live: LadderLive = { run: TODAY, rules: [], signs: [s], events: [by, ...landing], calendar: [], runs: [] };
    return resolveBlocks(live, patch, landing, new Set(), TODAY).filter((l) => /^(LIFTED|DEMOTED) /.test(l));
  };
  const DEMOTED = "DEMOTED  capex_guides — unrelated evidence (Other; cause Esc) → T2·T3";
  it("a cause-matched fizzle beats an unrelated one in the same landing — LIFTED, never DEMOTED", () => {
    expect(run(sign({ blocked: ON }), esc(["Pay"]), [fz("Other"), fz("Pay", [])])).toEqual(["LIFTED   capex_guides — Pay fizzle (liftBy of Esc)"]);
  });
  it("unstamped `by` block: with `liftBy`, a naming non-liftBy fizzle demotes and a liftBy fizzle lifts; with no `liftBy`, a naming fizzle lifts", () => {
    expect([run(sign({ blocked: ON }), esc(["Pay"]), [fz("Other")]), run(sign({ blocked: ON }), esc(["Pay"]), [fz("Pay", [])]), run(sign({ blocked: ON }), esc(), [fz("Other")])]).toEqual([
      [DEMOTED],
      ["LIFTED   capex_guides — Pay fizzle (liftBy of Esc)"],
      ["LIFTED   capex_guides — Other fizzle"],
    ]);
  });
  it("drift: a block stamped `lifts: [Pay]` whose escalation's `liftBy` now also lists Y lifts on Y — the stamp is a record, never read", () => {
    const stamped = { ...ON, setRun: "2026-11-10", cause: "Esc", lifts: ["Pay"], reviewBy: "2026-11-30" };
    expect(run(sign({ blocked: stamped }), esc(["Pay", "Y"]), [fz("Y", [])])).toEqual(["LIFTED   capex_guides — Y fizzle (liftBy of Esc)"]);
  });
  it("a mixed: landing on a liftBy event lifts only with offCause — un-flagged it stays a pending lift; off liftBy it never lifts", () => {
    const mx = (offCause?: true, event = "Pay"): LadderEvent => ({ ...ev("2026-11-12", event, "mixed: y, 11-12 — unchecked: tape · called: capex_guides=neutral", ["capex_guides"]), ...(offCause && { offCause }) });
    expect([run(sign({ blocked: ON }), esc(["Pay"]), [mx()]), run(sign({ blocked: ON }), esc(["Pay"]), [mx(true)]), run(sign({ blocked: ON }), esc(), [mx(true)])]).toEqual([
      [],
      ["LIFTED   capex_guides — Pay mixed (off-cause: tape; liftBy of Esc)"],
      [],
    ]);
    expect(deriveContract(sign({ blocked: ON }), [esc(["Pay"]), mx()], TODAY)?.lifts).toEqual([{ event: "Pay", date: "2026-11-12" }]);
  });
  it("a sourced lifting lean beats a same-run unrelated naming fizzle — LIFTED on the lean", () => {
    const leaned = sign({ blocked: ON, lean: "fizzle-leaning", sources: [{ date: "2026-11-12", url: "https://example.test/a" }] });
    expect(run(leaned, esc(["Pay"]), [fz("Other")], { signs: { capex_guides: { label: "CHANGED" } } })).toEqual(["LIFTED   capex_guides — lean fizzle-leaning"]);
  });
});

describe("stuck-prone — earliest lift vs review", () => {
  const world = (signs: LadderSign[], events = EVENTS): LadderLive => ({ run: TODAY, rules: [], signs, events, calendar: [], runs: [] });
  const apply = (live: LadderLive, landing: LadderEvent[] = []): string[] => resolveBlocks(live, { signs: {} }, landing, new Set(), TODAY).filter((l) => l.startsWith("stuck-prone: "));
  const pc = (): LadderSign => sign({ sign: "private_credit", blocked: { on: "2026-11-05" } });
  it("sp500 private_credit: planRun carries it every run; the normalising apply notes it once, a later one not", () => {
    const line = `stuck-prone: private_credit — earliest lift none > review ${addDays("2026-11-05", REVIEW_FALLBACK_DAYS).slice(5)}`;
    const live = world([pc()]);
    expect(planRun(live, TODAY, "sp500").stuckProne).toEqual([line]);
    expect(apply(live)).toEqual([line]);
    expect([apply(live), planRun(live, TODAY, "sp500").stuckProne]).toEqual([[], [line]]);
  });
  it("a block set this run with no lift is noted at set", () => {
    const live = world([sign({ sign: "private_credit", block: false, blocked: undefined })]);
    expect(apply(live, [ev("2026-11-12", "Shock", "escalation: gated, 11-12", ["private_credit"])])).toEqual([`stuck-prone: private_credit — earliest lift none > review ${addDays("2026-11-12", REVIEW_FALLBACK_DAYS).slice(5)}`]);
  });
  it("a lift dated before the review is none", () => {
    const live = world([sign({})]);
    expect([planRun(live, TODAY, "semis"), apply(live)]).toEqual([expect.not.objectContaining({ stuckProne: expect.anything() }), []]);
  });
  it("a stamped block whose lift was re-dated past its reviewBy", () => {
    const events = EVENTS.map((e) => (e.event === "NVDA FQ3-27" ? { ...e, date: "2026-11-30", status: "NOT DUE until 2026-11-30" } : e));
    const live = world([sign({ blocked: { on: "2026-11-09", by: "US midterms", setRun: "2026-11-10", cause: "US midterms", lifts: ["NVDA FQ3-27"], reviewBy: "2026-11-24" } })], events);
    expect(planRun(live, TODAY, "semis").stuckProne).toEqual(["stuck-prone: capex_guides — earliest lift 11-30 > review 11-24"]);
  });
  it("contractOwed: a stuck-prone block owes its rewrite and is researched though not due; a lift inside its review owes none", () => {
    const plan = planRun(world([{ ...pc(), due: "2026-12-01" }]), TODAY, "sp500");
    expect([plan.contractOwed, plan.research.map((r) => r.sign)]).toEqual([[`private_credit — earliest lift none > review ${addDays("2026-11-05", REVIEW_FALLBACK_DAYS).slice(5)}`], ["private_credit"]]);
    expect(planRun(world([sign({})]), TODAY, "semis").contractOwed).toBeUndefined();
    expect([plan.armRules?.contractOwed, planRun(world([sign({})]), TODAY, "semis").armRules?.contractOwed]).toEqual([expect.stringContaining("owes ONE answer"), undefined]);
  });
  it("withUnblocking: a stored base UNBLOCKING clause is replaced in place, else one is appended; the draft segment stays after the base", () => {
    const m = "BLOCKING = a ; UNBLOCKING = old; fizzle = z · draft: bear = d ; fizzle = e";
    expect([withUnblocking(m, "new"), withUnblocking("bear = x · draft: bear = d", "c")]).toEqual(["BLOCKING = a ; UNBLOCKING = new; fizzle = z · draft: bear = d ; fizzle = e", "bear = x; UNBLOCKING = c · draft: bear = d"]);
  });
  it("a contractOwed lift answer on a legacy (unstamped) block is bounded by its stored contract's review, never by the patched one", () => {
    const answer = (date: string): [string[], string[]] => ((notes: string[]) => [vetContractOwed((m) => notes.push(m), world([pc()]), { signs: { private_credit: { label: "UNCHANGED 11-13" } }, eventsAdd: [{ ...ev(date, "Far", "", ["private_credit"]) }] }, TODAY), notes])([]);
    expect(answer("2027-06-01")).toEqual([[], [expect.stringMatching(/^private_credit: contractOwed unanswered/)]]);
    expect(answer(addDays("2026-11-05", REVIEW_FALLBACK_DAYS))).toEqual([["private_credit"], []]);
  });
  it("a released row (legacy: its escalation spares it) and a probe row are never stuck-prone", () => {
    const spare = { ...ev("2026-11-05", "Spare", "escalation: gated, 11-05", ["private_credit"]), spares: ["private_credit"] };
    const live = world([sign({ sign: "private_credit", blocked: { on: "2026-11-05", by: "Spare" } }), sign({ sign: "probe_row", probe: true, blocked: { on: "2026-11-05" } })], [...EVENTS, spare]);
    expect([planRun(live, TODAY, "sp500"), apply(live)]).toEqual([expect.not.objectContaining({ stuckProne: expect.anything() }), []]);
  });
});

describe("causeFalse — a neutral lean's lift", () => {
  const CF = { label: "CHANGED", lean: "neutral", causeFalse: true as const };
  const pc = (over: Partial<LadderSign> = {}): LadderSign => sign({ sign: "private_credit", lean: "neutral", blocked: { on: "2026-11-05" }, sources: [{ date: "2026-11-06", url: "https://a.b/pc" }], ...over });
  const world = (s: LadderSign): LadderLive => ({ run: TODAY, rules: [], signs: [s], events: EVENTS, calendar: [], runs: [] });
  /** One apply's block pass on `live` at `day` — its LIFTED lines; `live` carries the stamp forward. */
  const run = (live: LadderLive, day: string, p?: object): string[] => resolveBlocks(live, { signs: p ? { private_credit: { label: "CHANGED", ...p } } : {} }, [], new Set(), day).filter((l) => l.startsWith("LIFTED"));
  it("sp500 private_credit: a second causeFalse ≥ NEUTRAL_LIFT_GAP_DAYS after the first lifts; one a day short holds the first stamp", () => {
    expect(NEUTRAL_LIFT_GAP_DAYS).toBeGreaterThan(1);
    const [held, lifted] = [world(pc()), world(pc())];
    expect([run(held, "2026-11-06", CF), run(lifted, "2026-11-06", CF)]).toEqual([[], []]);
    expect(run(held, addDays("2026-11-06", NEUTRAL_LIFT_GAP_DAYS - 1), CF)).toEqual([]);
    expect(held.signs[0]!.blocked?.causeFalseOn).toBe("2026-11-06");
    expect(run(lifted, addDays("2026-11-06", NEUTRAL_LIFT_GAP_DAYS), CF)).toEqual(["LIFTED   private_credit — cause sourced false"]);
    expect([lifted.signs[0]!.block, lifted.signs[0]!.blocked]).toEqual([false, undefined]);
  });
  it("a run without the key keeps the stamp; a lean off the neutral group clears it; the stamp alone lifts nothing", () => {
    const live = world(pc());
    run(live, "2026-11-06", CF);
    const late = addDays("2026-11-06", NEUTRAL_LIFT_GAP_DAYS);
    expect([run(live, "2026-11-08", {}), live.signs[0]!.blocked?.causeFalseOn, run(live, late, {})]).toEqual([[], "2026-11-06", []]);
    live.signs[0]!.lean = "bear";
    run(live, late, { lean: "bear" });
    expect(live.signs[0]!.blocked?.causeFalseOn).toBeUndefined();
  });
  it("vetBlockSet: causeFalse is `true` on a holding block with a SOURCED label and a neutral-group lean", () => {
    const notes = (s: LadderSign, p: object): string[] => ((n: string[]) => (vetBlockSet((m) => n.push(m), world(s), { signs: { private_credit: { ...CF, ...p } } }, TODAY), n))([]);
    expect([notes(pc(), {}), notes(pc({ sources: [] }), { sources: [{ date: "2026-11-06", url: "https://a.b/p" }] }), notes(pc(), { label: "UNCHANGED" })], "a source sent in the patch counts; a dateless UNCHANGED is sourced").toEqual([[], [], []]);
    expect([notes(pc(), { causeFalse: "yes" }), notes(pc(), { label: "STALE" }), notes(pc(), { lean: "bear" }), notes(pc({ block: false, blocked: undefined }), {}), notes(pc(), { block: true })]).toEqual([
      ["private_credit: causeFalse is `true` or absent"], [expect.stringContaining("causeFalse needs a SOURCED label")], [expect.stringContaining("neutral-group lean")],
      ["private_credit: causeFalse rides a holding block"], ["private_credit: causeFalse with a block key"]]);
  });
  it("a causeFalse whose newest source predates `blocked.on` neither stamps nor lifts; vetBlockSet notes it", () => {
    const OLD = { label: "UNCHANGED 10-20", lean: "neutral", causeFalse: true as const };
    const old = (): LadderLive => world(pc({ sources: [{ date: "2026-10-20", url: "https://a.b/old" }] }));
    const live = old();
    expect([run(live, "2026-11-06", OLD), run(live, TODAY, OLD), live.signs[0]!.block, live.signs[0]!.blocked?.causeFalseOn]).toEqual([[], [], true, undefined]);
    expect(((n: string[]) => (vetBlockSet((m) => n.push(m), old(), { signs: { private_credit: OLD } }, TODAY), n))([])).toEqual(["private_credit: causeFalse needs a source dated after 2026-11-05"]);
  });
  it("a source dated after today is no evidence: a stored one neither stamps nor lifts, a patched one leaves vetBlockSet's note", () => {
    const FUTURE = [{ date: addDays(TODAY, 1), url: "https://a.b/next" }];
    const live = world(pc({ sources: FUTURE }));
    expect([run(live, TODAY, CF), live.signs[0]!.blocked?.causeFalseOn]).toEqual([[], undefined]);
    expect(((n: string[]) => (vetBlockSet((m) => n.push(m), world(pc({ sources: [] })), { signs: { private_credit: { ...CF, sources: FUTURE } } }, TODAY), n))([])).toEqual(["private_credit: causeFalse needs a source dated after 2026-11-05"]);
  });
  it("the vets read the sources apply keeps (`postPatchSources`): a stored source before the window never answers for an out-of-window patch source", () => {
    // on 10-01, stored 10-20 (after on, before the 11-06 window start), patched 09-30: the union's newest (10-20) passes; apply keeps only the patched 09-30.
    const s = (): LadderSign => pc({ blocked: { on: "2026-10-01" }, sources: [{ date: "2026-10-20", url: "https://a.b/held" }] });
    const p = (date: string) => ({ signs: { private_credit: { ...CF, sources: [{ date, url: "https://a.b/sent" }] } } });
    expect(postPatchSources(s(), p("2026-09-30").signs.private_credit, sourceWindowStart(s(), TODAY)).map((x) => x.date)).toEqual(["2026-09-30"]);
    const notes = (date: string): [string[], string[]] => ((n: string[]) => [vetContractOwed((m) => n.push(m), world(s()), p(date), TODAY), (vetBlockSet((m) => n.push(m), world(s()), p(date), TODAY), n)])([]);
    expect(notes("2026-09-30")).toEqual([[], [expect.stringMatching(/^private_credit: contractOwed unanswered/), "private_credit: causeFalse needs a source dated after 2026-10-01"]]);
    expect(notes(TODAY), "an in-window patched source answers").toEqual([["private_credit"], []]);
  });
  it("contractOwed: causeFalse answers iff its earliest lift (stamp + gap) falls by the row's review", () => {
    const answered = (s: LadderSign, p: object = {}): string[] => vetContractOwed(() => {}, world(s), { signs: { private_credit: { ...CF, ...p } } }, TODAY);
    const review = addDays(TODAY, NEUTRAL_LIFT_GAP_DAYS);
    expect([answered(pc()), answered(pc({ sources: [] }), { sources: [{ date: "2026-11-06", url: "https://a.b/p" }] }), answered(pc({ sources: [] }))], "the patch's source counts; none after `on` answers nothing").toEqual([["private_credit"], ["private_credit"], []]);
    expect(answered(pc({ blocked: { on: "2026-11-05", setRun: "2026-11-06", cause: "manual", lifts: [], reviewBy: addDays(review, -1) } }))).toEqual([]);
    expect(answered(pc({ blocked: { on: "2026-11-05", setRun: "2026-11-06", cause: "manual", lifts: [], reviewBy: addDays(review, -1), causeFalseOn: "2026-11-10" } }))).toEqual(["private_credit"]);
  });
  it("movesVerdict: a lifting causeFalse re-verdicts, a stamping one does not", () => {
    const live = world(pc({ blocked: { on: "2026-11-05", setRun: "2026-11-06", cause: "manual", lifts: [], reviewBy: "2026-11-26", causeFalseOn: addDays(TODAY, -NEUTRAL_LIFT_GAP_DAYS) } }));
    const fresh = world(pc({ blocked: { on: "2026-11-05", setRun: "2026-11-06", cause: "manual", lifts: [], reviewBy: "2026-11-26" } }));
    expect([live, fresh].map((l) => movesVerdict(l, { signs: { private_credit: CF } } as unknown as LadderPatch, TODAY))).toEqual([true, false]);
    const bare = world(pc({ sources: [], blocked: { ...live.signs[0]!.blocked! } }));
    const sent = { ...CF, sources: [{ date: "2026-11-06", url: "https://a.b/p" }] };
    expect([sent, CF].map((p) => movesVerdict(bare, { signs: { private_credit: p } } as unknown as LadderPatch, TODAY)), "the patch's source counts").toEqual([true, false]);
  });
  it("movesVerdict's review reads the sources apply keeps: a stored source before the window never re-arms a stale review over an out-of-window patch source", () => {
    // on 10-01, review due 11-10; stored 10-20 (after on, before the 11-06 window); patched 09-30 — the union re-arms off 10-20 (no move), apply keeps only 09-30 (stale: a move).
    const l = world(pc({ blocked: { on: "2026-10-01", setRun: "2026-10-01", cause: "manual", lifts: [], reviewBy: "2026-11-10" }, sources: [{ date: "2026-10-20", url: "https://a.b/held" }] }));
    expect(sourceWindowStart(l.signs[0]!, TODAY), "the stored 10-20 source sits before the window").toBe("2026-11-06");
    expect(movesVerdict(l, { signs: { private_credit: { label: "CHANGED", lean: "bear", sources: [{ date: "2026-09-30", url: "https://a.b/sent" }] } } } as unknown as LadderPatch, TODAY)).toBe(true);
  });
});

describe("expiry breaker — a block's review (Stage 7 review fixes)", () => {
  const row = (over: Partial<LadderSign>): LadderSign => ({ sign: "x", label: "CHANGED", lean: "escalation-leaning", finding: "f", why: "w", measurable: "BLOCKING = credit; UNBLOCKING = spreads tighten", block: false, checked: null, due: null, primary: [], search: [], seed: [], sources: [], ...over });
  const esc = (date: string, over: Partial<LadderEvent> = {}): LadderEvent => ({ ...ev(date, "E", `escalation: hit, ${date.slice(5)}`, ["x"], []), ...over });
  const live = (signs: LadderSign[], events: LadderEvent[]): LadderLive => ({ run: TODAY, rules: [], signs, events, calendar: [], runs: [] });
  const resolve = (l: LadderLive, landing: LadderEvent[], today = TODAY, signs: Record<string, { label: string; pin?: string }> = {}) => resolveBlocks({ ...l, run: today }, { signs }, landing, new Set(), today);
  it("a block set this run is never reviewed that run, its past review floored at today + STALE_REVIEW_DAYS — and never re-armed off the sources it was set with", () => {
    const E = esc("2026-10-20", { sources: [{ date: "2026-10-20", url: "https://a.b/e" }] });
    const l = live([row({ sources: [{ date: "2026-10-25", url: "https://a.b/x" }] })], [E]);
    const lines = resolve(l, [E]);
    expect(lines.filter((x) => /^(STALE|CAPPED|RE-ARMED)/.test(x))).toEqual([]);
    expect([tierReason(lines, "x"), l.signs[0]!.block, l.signs[0]!.blocked]).toEqual([undefined, true, expect.objectContaining({ on: "2026-10-20", reviewBy: addDays(TODAY, STALE_REVIEW_DAYS) })]);
    expect(l.signs[0]!.blocked).not.toHaveProperty("staleReviews");
    const D = addDays(TODAY, 1);
    expect([resolve(l, [], D), l.signs[0]!.blocked?.reach, l.signs[0]!.blocked?.reviewed], "next run: neither stale nor re-armed off the set-time 10-25 source").toEqual([[], undefined, undefined]);
  });
  it("a legacy unstamped block re-arms off a fresh source dated after its `on` — the review reads the row before this run's stamp, as the pin vet does", () => {
    const E = esc("2026-10-01");
    const l = live([row({ block: true, blocked: { on: "2026-10-01", by: "E" }, sources: [{ date: "2026-11-12", url: "https://a.b" }] })], [E]);
    expect(reviewMoves(l.signs[0]!, l.events, TODAY), "the reverdict trigger agrees: a clock-only re-arm moves no reach").toBe(false);
    const lines = resolve(l, [], TODAY, { x: { label: "CHANGED" } });
    expect(lines.filter((x) => x.startsWith("STALE"))).toEqual([]);
    expect([l.signs[0]!.block, l.signs[0]!.blocked?.reach, l.signs[0]!.blocked?.staleReviews, l.signs[0]!.blocked?.reviewed]).toEqual([true, undefined, undefined, TODAY]);
  });
  it("a 6F.1 demotion is a review: a probe's same-day read of the persisted row holds the persisted reach", () => {
    const [E, L, F] = [esc("2026-10-01", { liftBy: ["L"] }), ev("2026-12-01", "L", "NOT DUE until 2026-12-01", []), ev(TODAY, "F", "fizzle: nope, 11-13", ["x"])];
    const l = live([row({ block: true, blocked: { on: "2026-10-01", by: "E", setRun: "2026-10-01", reviewBy: "2026-11-01" } })], [E, L, F]);
    resolve(l, [F]);
    const read = reviewedSigns(l.signs, l.events, TODAY)[0]!;
    expect([read.block, read.blocked?.reach]).toEqual([true, "T2T3"]);
    expect([l.signs[0]!.block, l.signs[0]!.blocked?.reach, l.signs[0]!.blocked?.reviewBy]).toEqual([true, "T2T3", addDays(TODAY, STALE_REVIEW_DAYS)]);
    const legacy = live([row({ block: true, blocked: { on: "2026-10-01", by: "E" } })], [E, L, F]);
    resolve(legacy, [F]);
    expect(legacy.signs[0]!.blocked, "a legacy block demoted this run is still stamped, its demotion's review kept").toMatchObject({ setRun: TODAY, cause: "E", reach: "T2T3", reviewBy: addDays(TODAY, STALE_REVIEW_DAYS) });
  });
  it("a legacy unstamped manual block past its fallback review: the probe's read (never persisted) holds the reach apply persists that day", () => {
    const l = live([row({ block: true, blocked: { on: addDays(TODAY, -(REVIEW_FALLBACK_DAYS + 10)) } })], []);
    const read = ((r) => [r.block, r.blocked?.reach])(reviewedSigns(l.signs, l.events, TODAY)[0]!);
    expect(l.signs[0]!.blocked).not.toHaveProperty("setRun");
    resolve(l, []);
    expect(read).toEqual([true, "T2T3"]);
    expect(read).toEqual([l.signs[0]!.block, l.signs[0]!.blocked?.reach]);
  });
  it("movesVerdict reads the patch's sources merged with the stored ones: a stale patched source beside a fresh stored one re-arms", () => {
    const l = live([row({ block: true, sources: [{ date: "2026-11-10", url: "https://a.b/s" }], blocked: { on: "2026-10-20", setRun: "2026-10-20", cause: "manual", lifts: [], reach: "T2T3", reviewed: "2026-11-05", reviewBy: "2026-11-20" } })], []);
    const p = { signs: { x: { label: "CHANGED", lean: "bear", sources: [{ date: "2026-11-01", url: "https://a.b/p" }] } } } as unknown as LadderPatch;
    expect(movesVerdict(l, p, TODAY)).toBe(true);
  });
  it("an escalation's stored source dated after today never dates its block — `on` is its newest source ≤ today", () => {
    const E = esc("2026-10-20", { sources: [{ date: "2026-11-01", url: "https://a.b/e" }, { date: addDays(TODAY, 3), url: "https://a.b/future" }] });
    const l = live([row({})], [E]);
    resolve(l, [E]);
    expect(l.signs[0]!.blocked?.on).toBe("2026-11-01");
  });
  it("a stale step's push names its tier — never a spares release's words", () => {
    const stale = (reach?: "T2T3") => ((l) => tierReason(resolve(l, []), "x"))(live([row({ block: true, label: "UNCHANGED 11-13", blocked: { on: "2026-10-01", by: "E", setRun: "2026-10-01", reviewBy: "2026-11-01", ...(reach && { reach }) } })], [esc("2026-10-01")]));
    expect([stale(), stale("T2T3")]).toEqual(["BLOCK stale: x → T2·T3", "BLOCK stale: x → released"]);
  });
  it("a block set this run is reviewed no sooner than today + STALE_REVIEW_DAYS — a review date of today or a day later is floored too; a later one is kept", () => {
    const D = addDays(TODAY, 1);
    for (const back of [REVIEW_FALLBACK_DAYS, REVIEW_FALLBACK_DAYS - 1]) {
      const E = esc(addDays(TODAY, -back));
      const l = live([row({})], [E]);
      resolve(l, [E]);
      const next = resolve(l, [], D);
      expect([next.filter((x) => x.startsWith("STALE")), l.signs[0]!.block, l.signs[0]!.blocked?.reach, l.signs[0]!.blocked?.reviewBy], `evidence ${back} d back`).toEqual([[], true, undefined, addDays(TODAY, STALE_REVIEW_DAYS)]);
    }
    const [E, L] = [esc("2026-11-10", { liftBy: ["L"] }), ev("2026-12-01", "L", "NOT DUE until 2026-12-01", [])];
    const l = live([row({})], [E, L]);
    resolve(l, [E]);
    expect(l.signs[0]!.blocked?.reviewBy, "a lift's review past today + STALE_REVIEW_DAYS is its own").toBe(addDays("2026-12-01", REVIEW_GRACE_DAYS));
  });
  it("a patch pin set on a holding block emits its delta line and pushes `BLOCK pinned` — ranked below a reach move on the row", () => {
    const l = live([row({ block: true, blocked: { on: "2026-11-01", by: "E", setRun: "2026-11-01", reviewBy: "2026-11-30" } })], [esc("2026-11-01")]);
    const lines = resolve(l, [], TODAY, { x: { label: "CHANGED", pin: "2026-11-20" } });
    expect(lines).toContain("PIN-SET  x — pinned to 11-20");
    expect([tierReason(lines, "x"), tierReason(lines, "x", "pin")]).toEqual([undefined, "BLOCK pinned: x to 11-20"]);
    expect(tierReason(["PIN-SET  x — pinned to 11-20", "STALE    x — review 11-01 passed, no fresh source → T2·T3"], "x", "pin"), "a reach move outranks the pin").toBeUndefined();
  });
});

describe("measured lifts", () => {
  const B = { series: "BAMLH0A3HYC", label: "CCC", below: 11.5 };
  const pts = (...v: number[]) => v.map((value, i) => ({ date: `2026-11-1${i}`, value }));
  it("measuredLift: the last two closes all strictly under `below` lift (the newest returned, `since` the oldest read); fewer closes, one at or over it, do not", () => {
    expect([measuredLift(B, pts(11.4, 11.4)), measuredLift(B, pts(12, 11.4, 11.3))]).toEqual([{ date: "2026-11-11", value: 11.4, since: "2026-11-10" }, { date: "2026-11-12", value: 11.3, since: "2026-11-11" }]);
    expect([measuredLift(B, []), measuredLift(B, pts(11.4)), measuredLift(B, pts(11.4, 11.6)), measuredLift(B, pts(11.6, 11.4)), measuredLift(B, pts(11.4, 11.5))]).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
  it("bindingOn: the base's `fizzle = CCC < 11.5` clause; a moved cut, a longer number, a draft-only clause or a trailing conjunct is drift", () => {
    expect(["bear = CCC ≥ 12.5 %; fizzle = CCC < 11.5 %", "bear = CCC ≥ 12.5 %; fizzle = CCC < 11.0 %", "fizzle = CCC < 11.55 %", "bear = x · draft: fizzle = CCC < 11.5 %"].map((m) => bindingOn(B, m))).toEqual([true, false, false, false]);
    expect(["bear = CCC ≥ 12.5 %; fizzle = CCC < 11.5 % and HY OAS < 3 %", "fizzle = CCC < 11.5; bear = CCC ≥ 12.5 %"].map((m) => bindingOn(B, m))).toEqual([false, true]);
  });
  it("liftTaken: every close read dated ≥ `blocked.on` — block 11-13: closes 11-12 + 11-13 keep it, 11-13 + 11-16 lift; a released row or another series takes none", () => {
    const row = sign({ sign: "credit", measurable: "fizzle = CCC < 11.5 %", blocked: { on: "2026-11-13" } });
    const lift = (...d: string[]) => ({ series: B.series, ...measuredLift(B, d.map((date) => ({ date, value: 11.4 })))! });
    const late = lift("2026-11-13", "2026-11-16");
    expect([liftTaken(row, lift("2026-11-12", "2026-11-13"), B), liftTaken(row, late, B), liftTaken({ ...row, blocked: { on: "2026-11-13", reach: "released" } }, late, B), liftTaken(row, { ...late, series: "X" }, B)]).toEqual([false, true, false, false]);
  });
  it("stuck-prone: a block whose measured binding is on is daily-observable — never stuck-prone; drifted, it is", () => {
    const row = (measurable: string) => sign({ sign: "credit", measurable, blocked: { on: "2026-10-13" } });
    const line = `stuck-prone: credit — earliest lift none > review ${addDays("2026-10-13", REVIEW_FALLBACK_DAYS).slice(5)}`;
    const [on, off] = [row("fizzle = CCC < 11.5 %"), row("fizzle = CCC < 11.0 %")];
    expect([stuckProne([on], EVENTS, TODAY, { credit: B }), stuckProne([off], EVENTS, TODAY, { credit: B }), stuckProne([on], EVENTS, TODAY)]).toEqual([[], [line], [line]]);
    expect(planRun({ run: TODAY, rules: [], signs: [on], events: EVENTS, calendar: [], runs: [] }, TODAY, "value").stuckProne, "value's LEGS binding reaches planRun").toBeUndefined();
  });
});
