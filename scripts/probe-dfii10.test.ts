import { describe, expect, it } from "vitest";
import { measureDfii10, measure } from "./probe-dfii10.js";

const URL0 = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFII10&cosd=2026-01-01";
/** 121 business-day closes: 1.61 → … → 2.36 (Δ120 = +75 bp at the box line, a float hair under it: only the vote's EPS reads it ≥). */
const obs = Array.from({ length: 121 }, (_, i) => ({ date: `2026-${String(5 + Math.floor(i / 25)).padStart(2, "0")}-${String((i % 25) + 1).padStart(2, "0")}`, value: i === 120 ? 2.36 : i === 0 ? 1.61 : 2.2 }));

describe("probe:dfii10", () => {
  it("reads the latest close and its Δ120 in bp against the +75 bp box line, with the vote's ≥ / under verdict", () => {
    expect(measureDfii10(obs, URL0)).toEqual({ asOf: "2026-09-21", text: "DFII10 2.36 % close 09-21 · Δ120 +75 bp vs +75 bp line ≥ line", sources: [{ date: "2026-09-21", url: URL0 }] });
    expect(measureDfii10([...obs.slice(0, 120), { date: "2026-09-21", value: 1.5 }], URL0)).toMatchObject({ text: "DFII10 1.50 % close 09-21 · Δ120 −11 bp vs +75 bp line under line" });
  });
  it("is an {error} short of 121 observations", () => {
    expect(measureDfii10(obs.slice(1), URL0)).toEqual({ error: "DFII10: 120 observations, need 121 for Δ120" });
  });
  it("fetches the keyless fredgraph CSV it cites", async () => {
    const seen: string[] = [];
    const csv = `observation_date,DFII10\n${obs.map((o) => `${o.date},${o.value}`).join("\n")}\n`;
    const m = await measure(new Date("2026-10-27T12:00:00Z"), async (u) => (seen.push(u), new Response(csv)));
    expect(seen[0]).toMatch(/^https:\/\/fred\.stlouisfed\.org\/graph\/fredgraph\.csv\?id=DFII10&cosd=2025-12-31$/);
    expect(m).toMatchObject({ asOf: "2026-09-21", sources: [{ url: seen[0] }] });
  });
});
