/**
 * GET /api/meta?view=<view> — consolidated ROUTER for the thin read handlers
 * (audit rank 14). Folds health / history / families / danger-model / config into ONE
 * Vercel serverless function to reclaim slots against the Hobby 12/deployment cap.
 *
 * The PUBLIC URLs stay `/api/health` … `/api/config`: `vercel.json` rewrites map each
 * to `/api/meta?view=<name>` (rewrites fire only for paths with NO filesystem function,
 * so the surviving real /api/* functions match first and are never shadowed). The view
 * bodies live in `src/api/meta-views.ts` (plain source ⇒ not their own functions).
 * Vercel Node function (Web-handler signature).
 */
import {
  healthView,
  historyView,
  familiesView,
  dangerModelView,
  configView,
} from "../src/api/meta-views.js";
import { rejectUnknownParams } from "../src/api/http.js";
import { getStore, type ReadStore } from "../src/store.js";
import { readEnv, cronSecret, type Env } from "../src/config.js";

/**
 * The public URLs that have NO handler file — each is a `vercel.json` rewrite onto this router.
 * `api/deploy-budget.test.ts` pins this map against `vercel.json`, so the two cannot drift and
 * "no file named X" is never evidence the URL is dead.
 */
export const API_VIEWS = {
  "/api/health": "health",
  "/api/history": "history",
  "/api/families": "families",
  "/api/danger-model": "danger-model",
  "/api/config": "config",
} as const;

/** The Vercel entry point: request-only, so a platform-passed 2nd argument can never be
 *  mistaken for a store. All store use goes through `handle`'s thunk (rung 8a). */
export async function GET(req: Request): Promise<Response> {
  const env = readEnv();
  return handle(() => getStore("ro", env), req, { env });
}

// The injectable seam (rung 8a): tests pass `() => new InMemoryStore()`. A THUNK, not a Store,
// so resolution stays lazy — only the store-reading views (health/history) ever call it, each
// at its own site (healthView inside its try, preserving the missing-anon-key 503), and an
// unknown-param 400 / pure view never touches Supabase env. `opts.env` is the entry's `readEnv()`;
// its CRON_SECRET is the deep-health bearer secret.
export async function handle(
  storeOf: () => ReadStore,
  req: Request,
  opts: { env: Env },
): Promise<Response> {
  const params = new URL(req.url).searchParams;
  // `limit` is read by historyView (the ?view=history body); every other view is paramless.
  const unknown = rejectUnknownParams(params, ["view", "limit"]);
  if (unknown) return unknown;
  const view = params.get("view");
  switch (view) {
    case "health":
      return healthView(storeOf, req, cronSecret(opts.env));
    case "history":
      return historyView(req, storeOf);
    case "families":
      return familiesView();
    case "danger-model":
      return dangerModelView();
    case "config":
      return configView();
    default:
      return Response.json(
        { error: `unknown view "${view ?? ""}" - expected one of: ${Object.values(API_VIEWS).join(", ")}` },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
  }
}
