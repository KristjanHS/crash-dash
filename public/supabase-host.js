/**
 * The browser-reachable copy of the Supabase host this site talks to (S-2).
 *
 * The repo copy holds PLACEHOLDERS (`PLACEHOLDER` in `scripts/stamp-deploy-config.ts`); the deploy
 * stamps the checkout's prod config over them in the uploaded tree, after bundle + minify, so the real
 * values never live in the repo. `api/security-headers.test.ts` pins this host and the `connect-src`
 * token in `vercel.json` to the same placeholder, and `public/gate-prefetch.test.js` pins the html
 * preconnects to this host, so the stamp rewrites all of them together. Not a secret — every journal
 * request carries it.
 *
 * The PUBLIC anon key lives here too (since the email-subscription page):
 * a zero-function public page has no other way to
 * hold it, and it is public by design — every browser request to the project carries it, and
 * RLS (not the key) is the security boundary. Its placeholder is a unique token rather than `""`:
 * minify renames the binding, so only a unique string literal can be found and stamped. An unstamped
 * page (local dev) holds a value that is not key-shaped, which `publicConnection` reads as "not
 * configured". The journal still takes it from its paste box.
 *
 * Consumers: the CSP pin, `normalizeConnection`'s host allowlist (S-3), `publicConnection`
 * (`subscribe-view.js`).
 */

/** Host only, no scheme. */
export const SUPABASE_HOST = "configrefplaceholder.supabase.co";

/** The CSP `connect-src` spelling: scheme + host, no trailing slash, no path. */
export const SUPABASE_ORIGIN = `https://${SUPABASE_HOST}`;

/** The project's PUBLIC anon (publishable) key — stamped at deploy from the prod config. */
export const SUPABASE_ANON_KEY = "anon-key-placeholder";
