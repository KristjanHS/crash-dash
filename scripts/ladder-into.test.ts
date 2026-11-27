import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LEGS, renderLadderMd, type LadderLive } from "../src/ladder-live.js";
import { writeInto } from "./ladder-into.js";

const LIVE: LadderLive = { run: "2026-10-12", rules: [], signs: [], events: [], calendar: [], runs: [] };
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const scratchRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "ladder-into-"));
  roots.push(root);
  mkdirSync(join(root, "public"));
  mkdirSync(join(root, "docs"));
  return root;
};

describe("writeInto — a probe's --into keeps the leg md in step with its JSON", () => {
  it("the canonical JSON path also re-renders LEGS[leg].md", () => {
    const root = scratchRoot();
    expect(writeInto(join(root, LEGS.value.json), LIVE, "value", root)).toBe(LEGS.value.md);
    expect(JSON.parse(readFileSync(join(root, LEGS.value.json), "utf8"))).toEqual(LIVE);
    expect(readFileSync(join(root, LEGS.value.md), "utf8")).toBe(renderLadderMd(LIVE, "value"));
  });

  it("a cwd-relative --into (the skills' `--into=public/<leg>.json` form) still matches", () => {
    const root = scratchRoot();
    expect(writeInto(relative(process.cwd(), join(root, LEGS.value.json)), LIVE, "value", root)).toBe(LEGS.value.md);
  });

  it("a scratch --into path writes the JSON alone", () => {
    const root = scratchRoot();
    const into = join(root, "scratch.json");
    expect(writeInto(into, LIVE, "value", root)).toBeUndefined();
    expect(existsSync(into)).toBe(true);
    expect(existsSync(join(root, LEGS.value.md))).toBe(false);
  });

  it("another leg's canonical JSON is a scratch target for this leg", () => {
    const root = scratchRoot();
    expect(writeInto(join(root, LEGS.semis.json), LIVE, "value", root)).toBeUndefined();
    expect(existsSync(join(root, LEGS.value.md))).toBe(false);
  });
});
