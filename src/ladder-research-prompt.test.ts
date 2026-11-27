import { describe, expect, it } from "vitest";
import { rungAPrompt, rungBPrompt, type ResearchState } from "./ladder-research-prompt.js";

const state: ResearchState = {
  today: "2026-11-16",
  scan: ["Semis catalyst calendar November 2026"],
  verify: [
    { event: "TSMC Oct sales", date: "2026-11-10", query: "TSMC October revenue date", fetch: ["https://investor.tsmc.com/a", "https://investor.tsmc.com/b"] },
    { event: "SIA Sept", date: "2026-11-05", query: "SIA September sales" },
  ],
  research: [
    { sign: "capex", since: "2026-11-02", fetch: ["https://x.com/p", "https://shared.com/q"], query: ["hyperscaler capex"], more: ["capex guide"], sides: { escalation: "capex cut", fizzle: "capex raise" } },
    { sign: "hbm", since: "2026-11-09", fetch: ["https://shared.com/q"], query: ["HBM price"], more: [], sides: { both: "HBM glut OR shortage" } },
    { sign: "mu_dio", since: "2026-11-02", fetch: [], query: ["stray mu dio call"], more: [], measuredOnly: true },
  ],
};
const calls = (s: ResearchState): string[] => [
  ...s.scan,
  ...s.verify.flatMap((v) => [...(v.fetch ?? []), v.query]),
  ...s.research.filter((r) => !r.measuredOnly).flatMap((r) => [...r.fetch, ...r.query, ...r.more, ...(r.sides ? ("both" in r.sides ? [r.sides.both] : [r.sides.escalation, r.sides.fizzle]) : [])]),
];
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

describe("rungAPrompt", () => {
  const out = rungAPrompt(state);
  it("lists every state call exactly once (a shared fetch once, naming both rows)", () => {
    for (const c of new Set(calls(state))) expect(count(out, c), c).toBe(1);
    expect(out).toContain("- fetch https://shared.com/q · rows: capex (since 2026-11-02), hbm (since 2026-11-09)");
  });
  it("omits a measuredOnly row", () => expect(out).not.toContain("mu_dio"));
  it("keeps a verify row's issuer fetches before its query, in order", () =>
    expect(out).toContain("- row verify: TSMC Oct sales (2026-11-10) · in order: fetch https://investor.tsmc.com/a → fetch https://investor.tsmc.com/b → search TSMC October revenue date"));
  it("demands the literal no-item line (R5)", () => expect(out).toContain("| no item on the row | ok`"));
  it("drops an empty rung's heading", () => expect(rungAPrompt({ ...state, scan: [], verify: [] })).not.toContain("Rung 0 —"));
});

describe("rungBPrompt", () => {
  const out = rungBPrompt(state, { extended: ["capex"], dating: [{ sign: "hbm", url: "https://d.com/x" }] });
  it("lists each extended row's first query as an extended search", () => expect(out).toContain("- row capex (since 2026-11-02) · search extended: hyperscaler capex"));
  it("lists each dating fetch once under its row", () => expect(count(out, "https://d.com/x")).toBe(1));
  it("prints nothing when nothing is owed", () => expect(rungBPrompt(state, { extended: [], dating: [] })).toBe(""));
});
