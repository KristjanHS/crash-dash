import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { paintLive } from "./lab-live-paint.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("paintLive - the /lab board never waits on /api/exposure", () => {
  it("paints the board while the exposure fetch never resolves", async () => {
    const painted = [];
    await paintLive({
      data: { id: "board" },
      dmReady: Promise.resolve(),
      expReady: new Promise(() => {}),
      isCurrent: () => true,
      paintBoard: (d) => painted.push(d.id),
      paintFoot: () => painted.push("foot"),
    });
    expect(painted).toEqual(["board"]);
  });

  it("re-paints only the footer once exposure lands, and not after a newer fetch", async () => {
    let gen = 1;
    let land;
    const painted = [];
    const args = {
      data: { id: "board" },
      dmReady: Promise.resolve(),
      expReady: new Promise((r) => (land = r)),
      isCurrent: () => gen === 1,
      paintBoard: (d) => painted.push(d.id),
      paintFoot: () => painted.push("foot"),
    };
    await paintLive(args);
    land(70);
    await tick();
    expect(painted).toEqual(["board", "foot"]);

    painted.length = 0;
    const stale = { ...args, expReady: new Promise((r) => (land = r)) };
    await paintLive(stale);
    gen = 2;
    land(70);
    await tick();
    expect(painted).toEqual(["board"]);
  });

  it("lab.js fetchLive routes through paintLive and never awaits expReady", () => {
    const src = readFileSync(new URL("./lab.js", import.meta.url), "utf8")
      .split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    const live = src.slice(src.indexOf("async function fetchLive"), src.indexOf("async function fetchReplay"));
    expect(live).toMatch(/paintLive\(\{/);
    expect(live).not.toMatch(/await expReady/);
  });
});
