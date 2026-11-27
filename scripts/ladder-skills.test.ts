import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEGS, type LadderLegId } from "../src/ladder-live.js";
import { renderSkill, skillPath, TEMPLATE } from "./ladder-skills.js";

const legs = Object.keys(LEGS) as LadderLegId[];
const template = readFileSync(TEMPLATE, "utf8");
/** Leg ids, held funds and leg-only vocabulary — none may sit in the shared body (the per-leg facts are `brief` in the state print). */
const LEG_WORDS = /eufin|value|semis|spit|sp500|SXR8|S&P 500|EXSH|XDEV|QDVE|SEC0|Micron|BONOS|gilt|Xetra|MSCI|NVDA|TSMC|hyperscaler|DRAM|ORCL|Moody|ECB/i;

describe("ladder skills — one template rendered ×4 (scripts/ladder-skill-body.md)", () => {
  it.each(legs)("%s/SKILL.md is byte-identical to its render — `npm run ladder:skills` regenerates it", (leg) => {
    expect(readFileSync(skillPath(leg), "utf8"), `.claude/skills/${leg}/SKILL.md drifted from scripts/ladder-skill-body.md — run \`npm run ladder:skills\``).toBe(renderSkill(leg, template));
  });
  it("the template carries no leg id or leg-only word outside the `<leg>` token", () => {
    const hit = template.split("\n").find((l) => LEG_WORDS.test(l.replaceAll("<leg>", "")));
    expect(hit, `leg-specific line in the template: ${hit}`).toBeUndefined();
    expect(template).toContain("<leg>");
  });
  it.each(legs)("%s/SKILL.md stays ≤ 17574 chars (14645 + 20 % [USER 2026-11-13]) — rare-arm prose goes to `ARM_RULES` (src/ladder-run.ts)", (leg) => {
    expect(readFileSync(skillPath(leg), "utf8").length).toBeLessThanOrEqual(17574);
  });
  it.each(legs)("%s/SKILL.md carries no `pages:` or `rules[` leftover and no unrendered token", (leg) => {
    const md = readFileSync(skillPath(leg), "utf8");
    expect(md).not.toMatch(/pages:|rules\[|<leg>/);
    expect(md.startsWith(`---\nname: ${leg}\ndescription: ONLY on /${leg}.\n---\n`)).toBe(true);
  });
});
