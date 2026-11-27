/**
 * `npm run ladder:skills` — renders `scripts/ladder-skill-body.md` once per leg of `LEGS` (`<leg>` → the leg id) into
 * `.claude/skills/<leg>/SKILL.md`; `scripts/ladder-skills.test.ts` pins each file to its render. Edit the template, never a SKILL.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LEGS, type LadderLegId } from "../src/ladder-live.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const TEMPLATE = `${ROOT}scripts/ladder-skill-body.md`;
export const skillPath = (leg: LadderLegId): string => `${ROOT}.claude/skills/${leg}/SKILL.md`;
/** The template with every `<leg>` token replaced by the leg id — the whole of what varies between the four skills. */
export const renderSkill = (leg: LadderLegId, template = readFileSync(TEMPLATE, "utf8")): string => template.replaceAll("<leg>", leg);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const leg of Object.keys(LEGS) as LadderLegId[]) {
    mkdirSync(`${ROOT}.claude/skills/${leg}`, { recursive: true });
    writeFileSync(skillPath(leg), renderSkill(leg));
    console.log(`wrote .claude/skills/${leg}/SKILL.md`);
  }
}
