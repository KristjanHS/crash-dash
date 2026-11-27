import { readFileSync, globSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { API_VIEWS } from "./meta.js";
import { RUN_MAX_DURATION_MS } from "../src/fetch-budget.js";

// Vercel turns EVERY file under api/ into a Serverless Function. The Hobby (free)
// plan caps a deployment at 12 functions; crossing it fails the deploy at the
// "Deploying outputs..." stage with the BUILD still green — a silent breakage
// that already froze prod once (6 *.test.ts files ate half the budget, and
// adding api/lab.ts + api/lab.test.ts tipped 12 -> 14). This guard trips LOCALLY
// on `npm run check` the moment a change would breach the cap, before any deploy.
// We stay on Hobby by design (no paid components), so 12 is a hard ceiling.
const HOBBY_FUNCTION_CAP = 12;
// Audit rank 14 folded 5 thin handlers (health/history/families/danger-model/config)
// into the single api/meta.ts router, dropping the deployed count 12 → 8 and reclaiming
// 4 slots of headroom under the cap. Assert the RECLAIMED level too, so a regression that
// re-splits a view back into its own function (silently eating the headroom) trips here.
const DEPLOYED_AFTER_FOLD = 8;

describe("vercel deploy budget", () => {
  it("keeps test files out of the deployment via .vercelignore", () => {
    // If this line is ever dropped from .vercelignore, all 6 *.test.ts files
    // reappear as functions and the deploy breaks again — assert it stays.
    const ignore = readFileSync(new URL("../.vercelignore", import.meta.url), "utf8");
    expect(ignore).toMatch(/^\*\.test\.ts$/m);
  });

  it(`deploys exactly ${DEPLOYED_AFTER_FOLD} serverless functions (Hobby cap: ${HOBBY_FUNCTION_CAP})`, () => {
    // Deployed functions = every api/**/*.ts NOT excluded by .vercelignore
    // (which drops *.test.ts). Mirror that filter here. When the cap nears,
    // the fix is NOT to shave a function — it is to split the new surface into
    // its own Vercel project (see docs), because Hobby offers no more headroom.
    const deployed = globSync("api/**/*.ts").filter((f) => !f.endsWith(".test.ts"));
    // After the rank-14 fold we sit at 8 with 4 slots of headroom — assert the exact level
    // so a re-split (silently spending the reclaimed headroom) fails here, not at deploy time.
    expect(deployed.length).toBe(DEPLOYED_AFTER_FOLD);
    // Slice E1 took slot 11 (getExposure); slice E2 (getReplay). Assert both still ship as
    // functions — a stray *.test.ts-style ignore rule or a misplaced file would silently drop
    // one from the deploy while the cap check stays green.
    expect(deployed).toContain("api/exposure.ts");
    expect(deployed).toContain("api/replay.ts");
    // The consolidated router ships; the folded handlers are gone (their URLs are rewrites now).
    expect(deployed).toContain("api/meta.ts");
    expect(deployed).not.toContain("api/health.ts");
    expect(deployed).not.toContain("api/config.ts");
  });

  it("every handler matches exactly ONE functions glob; the cron's maxDuration is RUN_MAX_DURATION_MS", () => {
    // Vercel documents no precedence between overlapping `functions` globs, so overlap is the defect.
    const cfg = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
      functions: Record<string, { maxDuration: number }>;
    };
    const deployed = globSync("api/**/*.ts").filter((f) => !f.endsWith(".test.ts"));
    const owners = deployed.map((f) => [f, Object.keys(cfg.functions).filter((g) => globSync(g).includes(f))] as const);
    expect(owners.filter(([, globs]) => globs.length !== 1)).toEqual([]);
    const cronGlob = owners.find(([f]) => f === "api/cron/run.ts")![1][0]!;
    expect(cfg.functions[cronGlob]!.maxDuration * 1000).toBe(RUN_MAX_DURATION_MS);
  });

  it("API_VIEWS is exactly vercel.json's rewrite set - a handler-less URL is still live", () => {
    const cfg = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
      rewrites: { source: string; destination: string }[];
    };
    const fromConfig = Object.fromEntries(
      cfg.rewrites.map((r) => [r.source, new URL(r.destination, "https://x").searchParams.get("view")]),
    );
    expect(Object.keys(fromConfig).length).toBeGreaterThan(0); // vacuity guard
    expect(fromConfig).toEqual({ ...API_VIEWS });
    // Every rewrite must land on THIS router, or the view name above pins nothing.
    for (const r of cfg.rewrites) expect(r.destination.split("?")[0]).toBe("/api/meta");
    // No rewritten URL may also exist as a handler file — a rewrite fires only where no
    // function matches, so a same-named file silently shadows the view.
    const deployed = globSync("api/**/*.ts");
    for (const source of Object.keys(API_VIEWS)) {
      expect(deployed).not.toContain(`api/${source.slice("/api/".length)}.ts`);
    }
  });
});
