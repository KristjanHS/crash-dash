import { existsSync, globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { ALL_INDICATORS } from "../src/registry.js";

import { buildIndicatorChart } from "./indicators.js";

/**
 * openapi ⇄ handler drift guard (6.1, Evol-B4). The read-API contract (`openapi.yaml`), the
 * live handler files under `api/`, the `vercel.json` rewrite map, and the local preview mock
 * (`scripts/preview/server.mjs`) are four hand-synced copies of the same route table. When a
 * new endpoint ships in one but not the others — the `/health` rewrite existed with NO openapi
 * path for months — the contract silently lies. This suite fails the moment they diverge.
 * Enum-VALUE parity (TS enum/union ⟷ openapi.yaml enum) is not here: it is the enum-sync table
 * in `src/api/contract.test.ts`.
 *
 * Paths are the `paths:` keys of the `yaml`-parsed spec (so openapi.yaml must stay valid YAML);
 * `vercel.json` is JSON. `.vercelignore` keeps `*.test.ts` out of the deploy, so this
 * file (and its siblings) never count as a Vercel function (also pinned in deploy-budget.test.ts).
 */

const root = new URL("../", import.meta.url);
const readRoot = (rel: string) => readFileSync(new URL(rel, root), "utf8");

// Every top-level path key in openapi.yaml, sans leading slash: "status", "cron/run", "health".
const openapiPaths = Object.keys((parseYaml(readRoot("openapi.yaml")) as { paths: Record<string, unknown> }).paths).map((p) => p.slice(1));

const vercel = JSON.parse(readRoot("vercel.json")) as {
  rewrites: { source: string; destination: string }[];
};
const rewrites = vercel.rewrites;

// A handler FILE for a route name (relative to api/): "meta" → api/meta.ts, "cron/run" → api/cron/run.ts.
const handlerExists = (name: string) => existsSync(fileURLToPath(new URL(`api/${name}.ts`, root)));
// "/api/health" → "health"; "/api/meta?view=health" → "meta" (dest handler behind a rewrite).
const publicName = (p: string) => p.match(/^\/api\/([^?]+)/)?.[1] ?? null;

describe("openapi ⇄ handler drift", () => {
  it("every openapi path maps to a live handler file or a rewrite whose destination exists", () => {
    for (const p of openapiPaths) {
      const direct = handlerExists(p);
      const rewrite = rewrites.find((r) => r.source === `/api/${p}`);
      const viaRewrite = rewrite != null && handlerExists(publicName(rewrite.destination)!);
      expect(direct || viaRewrite, `openapi path /${p} has no handler (direct or via rewrite)`).toBe(true);
    }
  });

  it("every non-test api/**/*.ts handler is reachable from an openapi path or a rewrite destination", () => {
    const handlers = globSync("api/**/*.ts")
      .filter((f) => !f.endsWith(".test.ts"))
      .map((f) => f.replace(/^api\//, "").replace(/\.ts$/, ""));
    const rewriteDestHandlers = new Set(rewrites.map((r) => publicName(r.destination)));
    for (const h of handlers) {
      const reachable = openapiPaths.includes(h) || rewriteDestHandlers.has(h);
      expect(reachable, `handler api/${h}.ts is unreachable (no openapi path, no rewrite destination)`).toBe(true);
    }
  });

  // probe:prod-full c7 walks these paths as the live-endpoint roster, so equality — not just reachability — binds.
  it("openapi paths = api/ handlers (meta excluded) ∪ vercel.json /api rewrite sources", () => {
    const handlers = globSync("api/**/*.ts")
      .filter((f) => !f.endsWith(".test.ts"))
      .map((f) => f.replace(/^api\//, "").replace(/\.ts$/, ""))
      .filter((h) => h !== "meta");
    const sources = rewrites.flatMap((r) => publicName(r.source) ?? []);
    expect(openapiPaths).toContain("health");
    expect([...openapiPaths].sort()).toEqual([...new Set([...handlers, ...sources])].sort());
  });

  /**
   * A `ChartSeries.fromPoint` / a `perPoint` `ChartBand.fromPoint` names a field the client reads
   * off each wire point — but `fromPoint` is a plain `string` on the TS type, so a spec may name a
   * field the contract never documents and nothing reds: the line just renders empty (exactly what
   * `fromPoint: "cusum"` did before 2026-08-09 — the FE's `pointField` is a CLOSED if/else too).
   * Every plotted field is checked against `SeriesPoint`'s documented property list, with the two
   * indirections spelled out: a dotted path (`havenLegs.eur`) resolves to its container property,
   * and a `perPoint` band key resolves through `bandCuts` (a free-form `additionalProperties` map,
   * so the KEY is not a documented property and the map is what the contract promises).
   */
  it("every chart-spec fromPoint resolves to a documented SeriesPoint property", () => {
    const lines = readRoot("openapi.yaml").split("\n");
    const start = lines.findIndex((l) => /^ {4}SeriesPoint:/.test(l));
    expect(start, "openapi.yaml has no SeriesPoint schema").toBeGreaterThan(-1);
    const after = lines.slice(start + 1);
    const end = after.findIndex((l) => /^ {0,4}\S/.test(l));
    const props = new Set(
      (end === -1 ? after : after.slice(0, end)).flatMap((l) => l.match(/^ {8}([A-Za-z][\w-]*):/)?.[1] ?? []),
    );
    // Vacuity floor: the block parser really found the schema's properties.
    expect(props.has("value"), "SeriesPoint property parse failed (shape changed?)").toBe(true);

    const plotted = new Set<string>();
    for (const i of ALL_INDICATORS) {
      const spec = buildIndicatorChart(i);
      for (const s of spec.series) if (s.fromPoint) plotted.add(s.fromPoint);
      if (spec.bands !== "context-only")
        for (const b of spec.bands) if (b.source === "perPoint" && b.fromPoint) plotted.add("bandCuts");
    }
    // Vacuity floor: the id sweep really produced plotted fields, including the F9 accumulator
    // this guard was written for.
    expect(plotted.has("cusum"), "no id plots `cusum` (spec regressed?)").toBe(true);
    for (const f of plotted) {
      const documented = f.includes(".") ? f.split(".")[0]! : f;
      expect(props.has(documented), `chart spec plots \`${f}\` but SeriesPoint documents no \`${documented}\``).toBe(
        true,
      );
    }
  });

  it("scripts/preview/server.mjs mirrors every vercel.json rewrite source", () => {
    const server = readRoot("scripts/preview/server.mjs");
    for (const { source } of rewrites) {
      expect(server, `preview server does not mock rewrite source ${source}`).toContain(`"${source}"`);
    }
  });
});
