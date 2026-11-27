// The write-path invariants for `email_subscribers`, pinned on the DDL itself.
//
// Like `holdings_journal` (`holdings-journal-rls.test.ts`), the browser writes this table DIRECTLY
// through PostgREST with no Vercel function in front, so the RLS policy is the whole security
// boundary. That sibling test filters its grant scan to `holdings_journal` and so cannot cover
// this table — hence a second file. Properties every later migration must keep:
//   1. `anon` never gains a grant here, nor a schema-wide one (anon-read-coverage.test.ts).
//   2. Every verb stays keyed to `auth.uid()`, never `true`, and both write paths bind the
//      `email` column to the JWT's own `email` claim (else a visitor enrols a victim's address).
//   3. `service_role` (the cron's BCC reader) is never granted a mutating verb — the list is the
//      visitors' to edit, the cron's only to read.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { stripSqlComments } from "./check-destructive-migrations.js";

const DIR = "supabase/migrations";
const TABLE = /email_subscribers/i;

/** Every migration whose executable body touches email_subscribers, oldest→newest. */
const touching = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .filter((f) => TABLE.test(stripSqlComments(readFileSync(`${DIR}/${f}`, "utf8"))))
  .sort();

const bodies = touching.map((f) => stripSqlComments(readFileSync(`${DIR}/${f}`, "utf8")));

/** One normalized statement per `;`, comments already stripped. */
function statements(body: string): string[] {
  return body
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s !== "");
}

/** GRANT statements naming the table — per STATEMENT, never per line (SQL is newline-indifferent). */
function grantStatements(body: string): string[] {
  return body
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => /\bgrant\b/i.test(s) && TABLE.test(s));
}

describe("email_subscribers RLS", () => {
  it("has a migration at all — guards a vacuous pass over an empty file list", () => {
    expect(touching.length).toBeGreaterThanOrEqual(1);
    expect(touching.some((f) => /_email_subscribers\.sql$/.test(f))).toBe(true);
  });

  it("enables row level security", () => {
    expect(bodies.join("\n")).toMatch(/alter\s+table\s+email_subscribers\s+enable\s+row\s+level\s+security/i);
  });

  it("keeps every policy keyed to auth.uid(), with both write paths bound to the JWT email claim", () => {
    const all = bodies.join("\n");
    expect(all).toMatch(/for\s+select\s+to\s+authenticated\s+using\s*\(\s*user_id\s*=\s*auth\.uid\(\)\s*\)/i);
    expect(all).toMatch(/for\s+insert\s+to\s+authenticated\s+with\s+check\s*\(\s*user_id\s*=\s*auth\.uid\(\)/i);
    expect(all).toMatch(/for\s+update\s+to\s+authenticated\s+using\s*\(\s*user_id\s*=\s*auth\.uid\(\)\s*\)/i);
    expect(all).toMatch(/for\s+delete\s+to\s+authenticated\s+using\s*\(\s*user_id\s*=\s*auth\.uid\(\)\s*\)/i);
    // BOTH write paths (insert + update) must bind the email column to the caller's own claim.
    const withChecks = bodies
      .flatMap(statements)
      .filter((s) => /create\s+policy/i.test(s) && TABLE.test(s) && /with\s+check/i.test(s));
    expect(withChecks.length).toBeGreaterThanOrEqual(2);
    // Two spellings of the same read are admitted: prod's `auth.jwt() ->> 'email'` helper, and the
    // raw PostgREST GUC it wraps, `current_setting('request.jwt.claims', true)::jsonb ->> 'email'`.
    // The migration uses the raw form because a bare local stack has no `auth.jwt()` (GoTrue is
    // disabled; scripts/sql/local-auth-shim.sql backfills it only AFTER bring-up).
    const emailClaim =
      /with\s+check\s*\([^;]*\bemail\s*=\s*\(?\s*(?:auth\.jwt\(\)|current_setting\(\s*'request\.jwt\.claims'\s*,\s*true\s*\)\s*::\s*jsonb)\s*->>\s*'email'\s*\)?/i;
    for (const stmt of withChecks) {
      expect(stmt, `a with-check on email_subscribers ignores the JWT email claim`).toMatch(emailClaim);
    }
    // No policy may open the table to everyone, on either clause.
    expect(all).not.toMatch(/on\s+email_subscribers[\s\S]{0,120}?using\s*\(\s*true\s*\)/i);
    expect(all).not.toMatch(/on\s+email_subscribers[\s\S]{0,120}?with\s+check\s*\(\s*true\s*\)/i);
  });

  it("grants service_role SELECT only — the cron reads the list, never edits it", () => {
    for (const [i, body] of bodies.entries()) {
      for (const stmt of grantStatements(body).filter((s) => /\bto\s+service_role\b/i.test(s))) {
        expect(stmt, `${touching[i]} grants service_role a mutating verb`).not.toMatch(
          /\b(insert|update|delete)\b/i,
        );
      }
    }
  });
});
