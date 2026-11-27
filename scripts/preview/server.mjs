// Zero-dependency local preview server for the dashboard. Serves public/ and
// mocks the read API (/api/*) with faithful all-calm data, so the front-end can
// be eyeballed without a live Supabase + FRED. Front-end is plain ES modules, so
// this is the supported "run the app" path for public/*.js work (see
// .claude/rules/frontend.md: front-end gate = node --check + browser check).
//
// Runs under `tsx`, not plain `node` — mock-data.mjs imports its names from src/*.ts.
//
//   npm run preview                           # → http://localhost:4321
//   PORT=5000 npx tsx scripts/preview/server.mjs
//
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG, STATUS, SERIES, ALL_INDICATORS_META, FAMILIES_META, DANGER_MODEL, LAB, EXPOSURE, history } from "./mock-data.mjs";

const PUBLIC = fileURLToPath(new URL("../../public/", import.meta.url));
const PORT = Number(process.env.PORT) || 4321;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const json = (res, body) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  // --- Mock read API -------------------------------------------------------
  // Liveness probe (mirror of the api/meta healthView's PUBLIC body — the deep probe is bearer-gated
  // — + its vercel.json rewrite), kept so the drift-guard's rewrite mirror check (api/openapi-drift.test.ts) stays honest.
  if (path === "/api/health") return json(res, { ok: true });
  if (path === "/api/config") return json(res, CONFIG);
  if (path === "/api/status") return json(res, STATUS);
  if (path === "/api/indicators") return json(res, ALL_INDICATORS_META);
  // Static family grouping (mirror of api/families.ts) — Zone C headings + order.
  if (path === "/api/families") return json(res, FAMILIES_META);
  // Static danger-model reference block (mirror of api/danger-model.ts) — /lab parity.
  if (path === "/api/danger-model") return json(res, DANGER_MODEL);
  // All-calm /lab board fixture (mirror of api/lab.ts LIVE path). STATIC: query params
  // (?s= scenario, ?hist= momentum) are ignored — same payload for every request; use
  // `npm run preview:live` for scenario/momentum work (documented preview limitation).
  if (path === "/api/lab") return json(res, LAB);
  // Exposure dial — DEGRADED posture (mock F1 < ARM_MIN_OBS closes, GT unusable), so /lab's
  // footer cash chip paints only its "not yet sized" state in preview.
  if (path === "/api/exposure") return json(res, EXPOSURE);
  if (path === "/api/history") return json(res, history(Number(url.searchParams.get("limit")) || 90));
  if (path === "/api/series") {
    const id = url.searchParams.get("id");
    // Preview-fixture gap: `?detail=1` (the real api/series.ts recompute-on-read gate)
    // is a no-op here — the mock serves its hardcoded-state series either way.
    return json(res, SERIES[id] ?? { id, points: [] });
  }

  // --- Static files from public/ (path-traversal guarded) ------------------
  let rel = normalize(path === "/" ? "index.html" : path).replace(/^(\.\.[/\\])+/, "");
  // Mirror vercel.json `cleanUrls: true` (same line as server-live.mjs) — an extensionless
  // path serves its .html (so /lab → lab.html locally, exactly as prod does).
  if (!extname(rel)) rel = rel.replace(/\/$/, "") + ".html";
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) {
    res.statusCode = 403;
    return res.end("forbidden");
  }
  try {
    const buf = await readFile(file);
    res.setHeader("content-type", MIME[extname(file)] || "application/octet-stream");
    res.end(buf);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});

server.listen(PORT, () => console.log(`preview: http://localhost:${PORT}`));
