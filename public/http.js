/*
 * http.js — the ONE module in public/ that reaches the global `fetch`: `baseFetch` (no timeout, the
 * injectable default every seam takes) and `request`/`getJson`/`send` (`timeoutMs`, default 15 s; null = none).
 */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** ≥ vercel.json `functions` maxDuration (60 s): a same-origin /api read never aborts before its handler may. */
export const API_TIMEOUT_MS = 60_000;

/** The global fetch, looked up per call (a test's stubbed global still lands); arity forwarded as given. */
export const baseFetch = (...args) => globalThis.fetch(...args);

function composeSignal(signal, timeoutMs) {
  const timeout = timeoutMs ? AbortSignal.timeout?.(timeoutMs) : undefined;
  if (!signal || !timeout) return signal ?? timeout;
  return AbortSignal.any?.([signal, timeout]) ?? signal;
}

/** The raw Response, never thrown on status — for callers that branch on status, text or headers. */
export function request(url, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl, ...init } = {}) {
  const f = fetchImpl ?? baseFetch;
  const composed = composeSignal(signal, timeoutMs);
  if (composed) init.signal = composed;
  // An empty init goes as NO init; gate-prefetch's fetchOnce hands over a prefetch only to no init or a signal-only one.
  return Object.keys(init).length ? f(url, init) : f(url);
}

/** GET + parse; a non-2xx throws `HTTP <status>` with `.status` set. */
export async function getJson(url, opts) {
  const res = await request(url, opts);
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

/** A write: `body` (when given) goes as JSON with a JSON content-type; returns the raw Response. */
export function send(url, { method = "POST", body, headers, ...opts } = {}) {
  const init = { ...opts, method };
  if (body === undefined) init.headers = headers;
  else Object.assign(init, { headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (init.headers === undefined) delete init.headers;
  return request(url, init);
}
