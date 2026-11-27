// Non-mock local preview server. Serves public/ and routes /api/* to the REAL
// `api/*.ts` handlers (Web-handler signature) against your LOCAL Supabase — the
// same code prod runs, so backfilled history renders exactly as it will live.
//
// Contrast with server.mjs, which mocks /api/* with hardcoded all-calm data and
// needs no DB. Use THIS one to eyeball real backfilled data:
//
//   npm run backfill -- all                          # populate readings (once)
//   npm run preview:live                             # → http://localhost:4321
//
// No `supabase start` step: both stacks default DOWN and each npm script wraps itself
// in `scripts/db.sh with dev`, which brings the dev stack up and always takes it down on
// exit (Ctrl-C included). To keep it up across several commands: `scripts/db.sh up dev`,
// then the `:raw` variants. `make preview-live` wraps the CRON RUN + serve in ONE cycle
// — it does NOT backfill, so run `npm run backfill -- all` once first or you get a single
// day of `readings`. (The cron run is what writes `alert_log`; /api/lab Live 404s without it.)
//
// Runs under tsx (see the npm script) so the .ts handler imports resolve and
// .env.local (SUPABASE_URL + SUPABASE_SERVICE_KEY) is loaded before getStore().
//
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { GET as statusGET } from "../../api/status.js";
import { GET as indicatorsGET } from "../../api/indicators.js";
import { GET as seriesGET } from "../../api/series.js";
import { GET as labGET } from "../../api/lab.js";
// Audit rank 14: health/history/families/danger-model/config now fold into the one
// api/meta.ts router; mirror vercel.json's rewrites here so the folded paths still route.
import { GET as metaGET } from "../../api/meta.js";

// Mirror vercel.json's rewrites: /api/<view> → /api/meta?view=<view>. Wrap metaGET so
// the folded paths reach the router with the right view param (query params preserved).
const metaView = (view) => (req) => {
  const u = new URL(req.url);
  u.searchParams.set("view", view);
  return metaGET(new Request(u, { method: "GET" }));
};

// Mirror of vercel.json's /api/* routes → the real handler for each path.
const ROUTES = {
  "/api/config": metaView("config"),
  "/api/status": statusGET,
  "/api/indicators": indicatorsGET,
  "/api/history": metaView("history"),
  "/api/series": seriesGET,
  "/api/health": metaView("health"),
  "/api/lab": labGET,
  // Static reference config (no DB hit): the ordered family list + the danger-model block
  // lab.js fetches once. Routed via the meta router, so /lab + the family headings render locally.
  "/api/families": metaView("families"),
  "/api/danger-model": metaView("danger-model"),
};

const PUBLIC = fileURLToPath(new URL("../../public/", import.meta.url));
const PORT = Number(process.env.PORT) || 4321;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const handler = ROUTES[url.pathname];

  // --- Real read API (api/*.ts against local Supabase) ---------------------
  if (handler) {
    try {
      // The handlers read only the URL (never the request body/headers), so a
      // bare GET Request faithfully reproduces the Vercel invocation.
      const response = await handler(new Request(url, { method: "GET" }));
      res.statusCode = response.status;
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      // getStore() fails loud without .env.local creds — surface it, don't 200 a lie.
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: String(err?.stack || err) }));
    }
    return;
  }

  // --- Static files from public/ (path-traversal guarded, mirrors server.mjs) --
  let rel = normalize(url.pathname === "/" ? "index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
  // Mirror vercel.json `cleanUrls: true` — an extensionless path serves its .html
  // (so /lab → lab.html locally, exactly as prod does). Trailing slash tolerated.
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

server.listen(PORT, () => console.log(`preview (live, local Supabase): http://localhost:${PORT}`));
