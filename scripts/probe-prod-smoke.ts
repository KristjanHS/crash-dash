/**
 * Post-deploy prod smoke gate — the automated replacement for the standing "eyeball all four
 * pages after a deploy" step (a retired security audit, `### Still open`).
 *
 * It answers the two questions the eyeball answered: does every page still
 * SERVE (200 + the security headers the policy promises), and does its module graph still LOAD
 * under that policy? The second half is the one that matters: the CSP that first shipped
 * enumerated static resources only, so a policy slip darks a page while the HTML itself still
 * returns a perfectly healthy 200. It also refuses a deploy that went out UNSTAMPED: the served CSP and
 * `/supabase-host.js` must hold none of the deploy stamp's placeholders (`LEFTOVER`,
 * `scripts/stamp-deploy-config.ts`).
 *
 * Wired blocking into `scripts/ship.sh` between §5 deploy and §6 push, so a broken prod aborts
 * the release before it is published.
 *
 * Exit 1 in ALL THREE failure modes, kept clearly apart in the message:
 *   UNREACHABLE — network/DNS/timeout. Infra, not a bad deploy; the release is not indicted.
 *   MITIGATED   — Vercel's edge answered instead of the app (`X-Vercel-Mitigated`). Also not a
 *                 verdict on the deploy: the request never reached a function or a static file.
 *   BROKEN      — reached, but a page 4xx/5xx'd, a header is missing, or a module did not load.
 *
 * The MITIGATED arm exists because on 2026-08-20 Attack Challenge Mode was left armed on the
 * project after the `probe-dast.sh` nuclei pass, and this probe reported all four pages as bare
 * `HTTP 403 (expected 200)` — indistinguishable from a deploy that genuinely darked prod, when in
 * fact the app was never asked. `probe-dast.sh` already carries the same guard for the same
 * reason; a mitigated response is the dangerous shape precisely because it looks like an answer.
 */
import { prodBaseUrl } from "./lib/prod-base-url.js";
import { LEFTOVER } from "./stamp-deploy-config.js";

export {}; // top-level await needs this file to be a module; it imports nothing by design.

/** The prod read alias, resolved at use (`prodBaseUrl`) — never at import. */
const alias = (): string => prodBaseUrl();
const PAGES = ["/", "/lab", "/journal", "/exposure"];
const ATTEMPTS = 3;
/** Vercel Deployment Protection bypass — lets a non-domain deployment URL answer the probe. */
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();

/** Reaching prod is retried; a REACHED-but-wrong answer is not — that is a verdict, not a flake. */
class Unreachable extends Error {}

/** Vercel's edge intercepted the request. Deterministic, so it is thrown rather than retried. */
class Mitigated extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string): Promise<Response> {
  let last: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      // The bypass secret rides only same-origin requests, and never follows a redirect off them.
      const bypass = BYPASS && new URL(url).origin === new URL(alias()).origin;
      const res = await fetch(url, {
        headers: { "Cache-Control": "no-cache", ...(bypass ? { "x-vercel-protection-bypass": BYPASS } : {}) },
        ...(bypass ? { redirect: "manual" as const } : {}),
        signal: AbortSignal.timeout(15_000),
      });
      const mitigation = res.headers.get("x-vercel-mitigated");
      if (mitigation) {
        throw new Mitigated(`${url} — X-Vercel-Mitigated: ${mitigation} (HTTP ${res.status})`);
      }
      return res;
    } catch (err) {
      if (err instanceof Mitigated) throw err; // a verdict about the edge, not a network flake
      last = err;
      if (attempt < ATTEMPTS) await sleep(attempt * 1000);
    }
  }
  throw new Unreachable(`${url} — ${last instanceof Error ? last.message : String(last)}`);
}

const problems: string[] = [];
const fail = (where: string, what: string) => problems.push(`${where}: ${what}`);

/** Every `<script type="module" src=…>` the page declares — the graph the CSP can dark. */
const entryModules = (html: string): string[] =>
  [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1]!);

/** The deploy stamp's placeholder fragments a served body still carries — any hit means an unstamped deploy. */
const placeholdersIn = (body: string): string[] => LEFTOVER.filter((t) => body.includes(t));

let modulesChecked = 0;

try {
  for (const page of PAGES) {
    const url = `${alias()}${page}`;
    const res = await get(url);
    if (res.status !== 200) {
      fail(page, `HTTP ${res.status} (expected 200)`);
      continue;
    }

    const csp = res.headers.get("content-security-policy");
    if (!csp) fail(page, "no Content-Security-Policy header");
    else if (!csp.includes("connect-src"))
      fail(page, "CSP has no connect-src — runtime fetches fall back to default-src and dark the page");
    if (csp && placeholdersIn(csp).length)
      fail(page, `CSP still holds deploy-stamp placeholder(s) ${placeholdersIn(csp).join(", ")} — the deploy was not stamped`);
    if (res.headers.get("x-content-type-options") !== "nosniff")
      fail(page, `X-Content-Type-Options is ${res.headers.get("x-content-type-options") ?? "absent"}, want nosniff`);
    if (!res.headers.get("referrer-policy")) fail(page, "no Referrer-Policy header");

    const html = await res.text();
    const modules = entryModules(html);
    if (modules.length === 0) fail(page, "declares no module script — the entry-graph check would be vacuous");
    for (const src of modules) {
      const modUrl = new URL(src, url).toString();
      const mod = await get(modUrl);
      modulesChecked += 1;
      const type = mod.headers.get("content-type") ?? "";
      if (mod.status !== 200) fail(page, `module ${src} → HTTP ${mod.status}`);
      else if (!/javascript|ecmascript/i.test(type))
        fail(page, `module ${src} served as "${type}" — a module the browser will refuse to execute`);
    }
  }

  // The browser copy of the Supabase host + anon key: an unstamped one reads "not configured" on every page.
  const hostJs = await get(`${alias()}/supabase-host.js`);
  if (hostJs.status !== 200) fail("/supabase-host.js", `HTTP ${hostJs.status} (expected 200)`);
  else {
    const left = placeholdersIn(await hostJs.text());
    if (left.length) fail("/supabase-host.js", `still holds deploy-stamp placeholder(s) ${left.join(", ")} — the deploy was not stamped`);
  }
} catch (err) {
  if (err instanceof Mitigated) {
    console.log(`[probe:prod-smoke] MITIGATED — Vercel's edge answered, the app did not: ${err.message}`);
    console.log("[probe:prod-smoke] Every page will 403 while this stands, and NONE of it indicts the deploy.");
    console.log("[probe:prod-smoke] Usual cause: Attack Challenge Mode left armed after a DAST run");
    console.log("[probe:prod-smoke] (see scripts/probe-dast.sh §escalation). Turn it off under");
    console.log("[probe:prod-smoke] Vercel → the project → Firewall → Attack Challenge Mode, then re-run.");
    process.exit(1);
  }
  if (!(err instanceof Unreachable)) throw err;
  console.log(`[probe:prod-smoke] UNREACHABLE — could not reach ${alias()}: ${err.message}`);
  console.log(`[probe:prod-smoke] ${ATTEMPTS} attempt(s) failed at the network layer. This is INFRA,`);
  console.log("[probe:prod-smoke] not a verdict on the deploy — prod was never asked the question.");
  process.exit(1);
}

console.log(
  `[probe:prod-smoke] ${alias()} — checked ${PAGES.length} page(s), ${modulesChecked} entry module(s) and /supabase-host.js.`,
);
if (problems.length === 0) {
  console.log("[probe:prod-smoke] PROD SMOKE: PASS — every page serves 200 with its headers and loads its modules; no stamp placeholder served.");
  process.exit(0);
}
console.log(`[probe:prod-smoke] PROD SMOKE: FAIL — prod is BROKEN (reached fine; ${problems.length} problem(s)).`);
for (const p of problems) console.log(`    ${p}`);
process.exit(1);
