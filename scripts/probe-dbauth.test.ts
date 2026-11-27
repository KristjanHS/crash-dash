/**
 * The pinned Supabase pooler root (`certs/supabase-pooler.pem`) is what makes
 * `scripts/probe-dbauth.ts` able to run with `rejectUnauthorized: true` — the chain terminates on
 * Supabase's OWN private root, which is not in Node's bundle. That pin was previously an accepted
 * liability: nothing watched its expiry, so a rotation surfaced as an opaque TLS handshake failure
 * to be diagnosed by hand. This test is the watch. Pure crypto read, no network.
 */
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** Lead time before expiry. Wide enough to notice and re-pin without a fire drill. */
const WARN_DAYS = 60;
const DAY_MS = 86_400_000;

describe("pinned Supabase pooler CA", () => {
  const pem = readFileSync(new URL("../certs/supabase-pooler.pem", import.meta.url), "utf8");
  const cert = new X509Certificate(pem);

  it("is the Supabase root the probe expects, not some other pinned cert", () => {
    // Establish the parse is real before asserting on the date it yields.
    expect(cert.subject).toMatch(/Supabase Root/i);
    expect(Number.isFinite(Date.parse(cert.validTo))).toBe(true);
  });

  it(`does not expire within ${WARN_DAYS} days — re-pin it BEFORE probe:dbauth starts failing`, () => {
    const daysLeft = Math.floor((Date.parse(cert.validTo) - Date.now()) / DAY_MS);
    expect(
      daysLeft,
      `certs/supabase-pooler.pem expires ${cert.validTo} (${daysLeft} day(s) left). ` +
        `Re-fetch Supabase's current published root and replace the PEM; probe:dbauth will fail ` +
        `its TLS handshake once this lapses.`,
    ).toBeGreaterThan(WARN_DAYS);
  });
});
