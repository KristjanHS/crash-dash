/**
 * The ONE outbound-HTTP client for src: per-attempt `runFetchSignal`, the status check and the single retry loop.
 * Default policy is one attempt; each feed passes its own `retry` knobs and keeps its own messages.
 */

import { type FetchLike, runFetchSignal } from "./fetch-budget.js";

export type { FetchLike };

/** A non-OK response; `message` is the caller's (feeds' persisted degrade reasons match on it). */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  constructor(message: string, res: { status: number; statusText: string; url: string }) {
    super(message);
    this.name = "HttpStatusError";
    this.status = res.status;
    this.statusText = res.statusText;
    this.url = res.url.replace(/[?#].*$/s, ""); // origin + path only: a keyed query (FRED `api_key=`) never rides the error
  }
}

export interface RetryPolicy {
  /** Total attempts, first included (1 = no retry). */
  attempts: number;
  backoffMs: number;
  /** Veto: false rethrows `err` at once, unwrapped. Sees fetch, status AND parse errors. Default: retry all. */
  retryOn?: (err: unknown) => boolean;
  /** No retry STARTS once `elapsed + backoffMs >= windowMs` since the first attempt. */
  windowMs?: number;
  /** The URL for 1-based `attempt` (attempt 1 included — return `url` to keep it bare). */
  rewriteUrl?: (url: string, attempt: number) => string;
  /** On a retryable error that exhausted attempts/window: the value to throw instead of `err`. */
  giveUp?: (err: unknown, info: { attempts: number; elapsedMs: number }) => unknown;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}

export interface FeedHttpOpts {
  fetchImpl?: FetchLike;
  init?: RequestInit;
  /** Per-attempt timeout, composed with the run-wide deadline and any `init.signal`. */
  timeoutMs: number;
  /** Non-OK message = `${label}: ${status} ${statusText}` unless `statusMessage` overrides it. */
  label: string;
  statusMessage?: (res: Response) => string | Promise<string>;
  retry?: RetryPolicy;
  /** false = the bare per-attempt timeout, off the run deadline: a notify push runs AFTER that deadline has fired. */
  runBudget?: boolean;
}

// The default reads the global per CALL, so a test stubbing `fetch` after import still hits the stub.
const globalFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

async function attemptOnce<T>(url: string, read: (res: Response) => T | Promise<T>, opts: FeedHttpOpts): Promise<T> {
  const perAttempt = opts.runBudget === false ? AbortSignal.timeout(opts.timeoutMs) : runFetchSignal(opts.timeoutMs);
  const caller = opts.init?.signal;
  const res = await (opts.fetchImpl ?? globalFetch)(url, {
    ...opts.init,
    signal: caller ? AbortSignal.any([perAttempt, caller]) : perAttempt,
  });
  if (!res.ok) {
    const message = opts.statusMessage ? await opts.statusMessage(res) : `${opts.label}: ${res.status} ${res.statusText}`;
    throw new HttpStatusError(message, { status: res.status, statusText: res.statusText, url: res.url || url });
  }
  return read(res);
}

/** The one loop: fetch → status check → `read(res)`, all inside one attempt, under `opts.retry`. */
async function withRetry<T>(url: string, read: (res: Response) => T | Promise<T>, opts: FeedHttpOpts): Promise<T> {
  const r = opts.retry;
  const attempts = r?.attempts ?? 1;
  const backoffMs = r?.backoffMs ?? 0;
  const now = r?.now ?? (() => performance.now());
  const sleep = r?.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const t0 = now();
  for (let i = 1; ; i++) {
    try {
      return await attemptOnce(r?.rewriteUrl ? r.rewriteUrl(url, i) : url, read, opts);
    } catch (err) {
      if (r?.retryOn && !r.retryOn(err)) throw err;
      const windowShut = r?.windowMs !== undefined && now() - t0 + backoffMs >= r.windowMs;
      if (i >= attempts || windowShut) throw r?.giveUp ? r.giveUp(err, { attempts: i, elapsedMs: now() - t0 }) : err;
      await sleep(backoffMs);
    }
  }
}

/** fetch → status check → `parse(body)`, the body read inside the attempt (so a read failure retries). */
export function fetchParsed<T>(url: string, parse: (text: string) => T, opts: FeedHttpOpts): Promise<T> {
  return withRetry(url, async (res) => parse(await res.text()), opts);
}

/** A 2xx resolves unread — a body-read failure after a sent POST must not retry it (a duplicate push). */
export function fetchOk(url: string, opts: FeedHttpOpts): Promise<void> {
  return withRetry(url, (res) => void res.body?.cancel().catch(() => {}), opts);
}

export function fetchText(url: string, opts: FeedHttpOpts): Promise<string> {
  return fetchParsed(url, (text) => text, opts);
}

export interface FeedJsonOpts extends FeedHttpOpts {
  /** A non-JSON body throws this instead of the SyntaxError — still inside the attempt, so `retryOn` sees it. */
  badJson?: (text: string, err: unknown) => Error;
}

/** `JSON.parse` then the feed's hand `parse(u, text)` (`text` = the raw body its messages quote) — both inside the attempt. */
export function fetchJson<T>(url: string, parse: (u: unknown, text: string) => T, opts: FeedJsonOpts): Promise<T> {
  return fetchParsed(url, (text) => {
    let u: unknown;
    try {
      u = JSON.parse(text);
    } catch (err) {
      throw opts.badJson ? opts.badJson(text, err) : err;
    }
    return parse(u, text);
  }, opts);
}
