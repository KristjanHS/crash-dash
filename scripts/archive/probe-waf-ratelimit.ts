/**
 * Prod WAF rate-limit falsifier — bursts the live alias' /api/lab past the threshold declared in
 * scripts/waf-rules.json and asserts a 429 appears. It is the ONLY proof the rule is actually live
 * (a green unit test proves the payload's shape, never that Vercel enforces it).
 *
 * It MUST be demonstrably capable of non-zero: run it BEFORE the rule is published and it exits 1
 * (no 429 yet) — that is the proof it can fail. Only then publish, and re-run to confirm the 429.
 *
 * Exit 1 in BOTH failure modes, kept apart in the message:
 *   UNREACHABLE — network/DNS/timeout. Infra, not a verdict on the rule.
 *   NO-429      — reached fine, burst the threshold, never saw a 429. The rule is not enforcing.
 *
 * Bounded + sequential-ish: it sends just past the threshold, not a load test.
 */

import { readFileSync } from "node:fs";

import { prodBaseUrl } from "../lib/prod-base-url.js";

const rule = JSON.parse(
  readFileSync(new URL("./waf-rules.json", import.meta.url), "utf8"),
) as { requests: number; windowSeconds: number; paths: string[] };

/** The prod read alias, resolved at use (`prodBaseUrl`) — never at import. */
const alias = (): string => prodBaseUrl();
const PATH = "/api/lab"; // one of rule.paths — the abuse-exposed panel endpoint
const ATTEMPTS = 3;
// Send enough to cross the window's cap with margin, but stay bounded — a falsifier, not a flood.
const BURST = rule.requests + 10;

class Unreachable extends Error {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function once(url: string): Promise<number> {
  let last: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(15_000),
      });
      return res.status;
    } catch (err) {
      last = err;
      if (attempt < ATTEMPTS) await sleep(attempt * 500);
    }
  }
  throw new Unreachable(`${url} — ${last instanceof Error ? last.message : String(last)}`);
}

const url = `${alias()}${PATH}`;
const seen = new Map<number, number>();
let saw429 = false;

// Waves, not a sequential drip: 60 hits must land INSIDE the 60s window, so a ~1s round-trip
// on a cold lambda would roll the window before the threshold is ever crossed.
const WAVE = 10;
const startedAt = Date.now();
let rolledOver = false;

try {
  for (let i = 0; i < BURST && !saw429; i += WAVE) {
    const n = Math.min(WAVE, BURST - i);
    const statuses = await Promise.all(Array.from({ length: n }, () => once(url)));
    for (const status of statuses) {
      seen.set(status, (seen.get(status) ?? 0) + 1);
      if (status === 429) saw429 = true;
    }
    if (!saw429 && Date.now() - startedAt > rule.windowSeconds * 1000) {
      rolledOver = true;
      break;
    }
  }
} catch (err) {
  if (!(err instanceof Unreachable)) throw err;
  console.log(`[probe:waf-ratelimit] UNREACHABLE — could not reach ${alias()}: ${err.message}`);
  console.log(`[probe:waf-ratelimit] ${ATTEMPTS} attempt(s) failed at the network layer. INFRA,`);
  console.log("[probe:waf-ratelimit] not a verdict on the rule — prod was never asked the question.");
  process.exit(1);
}

const tally = [...seen.entries()].map(([s, n]) => `${s}×${n}`).join(", ");
console.log(
  `[probe:waf-ratelimit] ${url} — burst up to ${BURST} (threshold ${rule.requests}/${rule.windowSeconds}s). Statuses: ${tally}.`,
);

if (saw429) {
  console.log("[probe:waf-ratelimit] WAF RATE-LIMIT: PASS — a 429 appeared; the rule is enforcing.");
  process.exit(0);
}
if (rolledOver) {
  // Cannot distinguish "rule absent" from "we were too slow" — so refuse to call it either way.
  console.log(
    `[probe:waf-ratelimit] INCONCLUSIVE — the ${rule.windowSeconds}s window elapsed before ${rule.requests} requests landed.`,
  );
  console.log("[probe:waf-ratelimit] Too slow to prove anything; re-run on a faster link. NOT a verdict on the rule.");
  process.exit(1);
}
console.log(
  "[probe:waf-ratelimit] WAF RATE-LIMIT: FAIL — reached prod, burst past the threshold, NEVER saw a 429.",
);
console.log("[probe:waf-ratelimit] The rule is not live/enforcing (expected BEFORE publish; a verdict AFTER).");
process.exit(1);
