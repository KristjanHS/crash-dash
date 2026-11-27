// The §E-4 write-path invariants for `holdings_journal`, pinned on the DDL itself.
//
// This table is the ONLY one in the schema the browser writes to, and it is written DIRECTLY
// (no Vercel function stands in front of it), so its RLS policy is the whole security
// boundary. Two properties must survive every later migration:
//   1. `anon` never gains a grant here (anon-read-coverage.test.ts).
//   2. both SELECT and INSERT stay keyed to `auth.uid()`, not to `true`.
// A later migration CAN legitimately change this, but it will have to change this test too,
// which is the point.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { stripSqlComments } from "./check-destructive-migrations.js";

const DIR = "supabase/migrations";

/** Every migration whose executable body touches holdings_journal, oldest→newest. */
const touching = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .filter((f) => /holdings_journal/i.test(stripSqlComments(readFileSync(`${DIR}/${f}`, "utf8"))))
  .sort();

const bodies = touching.map((f) => stripSqlComments(readFileSync(`${DIR}/${f}`, "utf8")));

/**
 * The GRANT STATEMENTS in one migration body that name `holdings_journal`.
 *
 * Matched per STATEMENT, never per line. SQL is newline-indifferent, so
 * `grant select, update\n  on holdings_journal to anon;` is one grant that a line-wise scan sees as
 * two fragments — neither carrying both `grant` and `holdings_journal`, so a widening migration
 * written that way would match nothing and pass every guard below in silence. Splitting on `;` and
 * flattening the whitespace makes the unit of the scan the same unit the database executes.
 */
function grantStatements(body: string): string[] {
  return body
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => /\bgrant\b/i.test(s) && /holdings_journal/i.test(s));
}

describe("holdings_journal RLS (§E-4)", () => {
  it("has a migration at all — guards a vacuous pass over an empty file list", () => {
    expect(touching.length).toBeGreaterThanOrEqual(1);
    expect(touching.some((f) => /add_holdings_journal/.test(f))).toBe(true);
  });

  it("enables row level security", () => {
    expect(bodies.join("\n")).toMatch(/alter\s+table\s+holdings_journal\s+enable\s+row\s+level\s+security/i);
  });

  it("keeps both the read and the insert policy keyed to auth.uid()", () => {
    const all = bodies.join("\n");
    expect(all).toMatch(/for\s+select\s+to\s+authenticated\s+using\s*\(\s*user_id\s*=\s*auth\.uid\(\)\s*\)/i);
    expect(all).toMatch(/for\s+insert\s+to\s+authenticated\s+with\s+check\s*\(\s*user_id\s*=\s*auth\.uid\(\)\s*\)/i);
    // No policy may open the table to everyone.
    expect(all).not.toMatch(/on\s+holdings_journal[\s\S]{0,120}?using\s*\(\s*true\s*\)/i);
  });

  it("grants no UPDATE or DELETE to any role — J-5's correction mechanism is deferred", () => {
    for (const [i, body] of bodies.entries()) {
      const grants = grantStatements(body);
      for (const stmt of grants) {
        expect(stmt, `${touching[i]} grants a mutating verb on append-only history`).not.toMatch(
          /\b(update|delete)\b/i,
        );
      }
    }
  });
});

describe("delete_my_account RPC — the sanctioned self-erase path (J0.5.1)", () => {
  // The ONE migration that adds the GDPR-erasure function. Read it by name, not off `touching`
  // (which is broader): if the file is ever renamed this find() returns undefined and every
  // assertion below throws — a rot that surfaces loudly rather than silently skipping the checks.
  const file = readdirSync(DIR).find((f) => /_delete_my_account\.sql$/.test(f));
  // Comments are STRIPPED before every scan below — the migration header talks ABOUT `revoke`,
  // `on delete restrict` and `grant execute` in prose, so a scan over the raw text would match a
  // comment and pass vacuously. `stripSqlComments` blanks `--` lines, so only executable SQL is seen.
  const body = file ? stripSqlComments(readFileSync(`${DIR}/${file}`, "utf8")) : "";
  const flat = body.replace(/\s+/g, " ").trim();
  /** Executable statements, whitespace-flattened — the unit the database runs, per grantStatements above. */
  const statements = body
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  it("the migration exists — guards a vacuous pass over an empty body", () => {
    expect(file, "no *_delete_my_account.sql migration found").toBeTruthy();
    // The scan is live: the executable body really carries the create, so a missing property below
    // is a real absence, not a stripped-to-nothing file.
    expect(flat).toMatch(/create function public\.delete_my_account\(\)/i);
  });

  it("the function is SECURITY DEFINER with an empty search_path (Supabase lint 0011)", () => {
    expect(flat).toMatch(/security\s+definer/i);
    expect(flat).toMatch(/set\s+search_path\s*=\s*''/i);
  });

  it("revokes execute from public, anon AFTER the create, and grants it to authenticated ALONE", () => {
    const createAt = flat.search(/create function public\.delete_my_account\(\)/i);
    const revokeAt = flat.search(/revoke\s+execute\s+on\s+function\s+public\.delete_my_account\(\)\s+from\s+public\s*,\s*anon/i);
    expect(createAt).toBeGreaterThanOrEqual(0);
    expect(revokeAt, "revoke must appear and follow the create").toBeGreaterThan(createAt);

    // Exactly one EXECUTE grant, and it hands the privilege to `authenticated` and no other role —
    // an unrevoked PUBLIC/anon execute on a definer delete is a delete-anything endpoint.
    const execGrants = statements.filter((s) => /\bgrant\b/i.test(s) && /\bexecute\b/i.test(s));
    expect(execGrants.length, `execute grants: ${execGrants.join(" | ")}`).toBe(1);
    // The grantee is everything after the final ` to ` (the schema-qualified `public.` in the
    // function name is BEFORE it, so it never confuses the role list). It must be `authenticated`
    // alone — a second role, or public/anon, would widen the delete-anything surface.
    const grantee = (execGrants[0] ?? "").replace(/.*\bto\s+/i, "").trim();
    expect(grantee, `execute granted to: ${grantee}`).toBe("authenticated");
  });

  it("adds the FK from holdings_journal.user_id to auth.users with ON DELETE RESTRICT", () => {
    expect(flat).toMatch(
      /alter\s+table\s+holdings_journal\s+add\s+constraint\s+\w+\s+foreign\s+key\s*\(\s*user_id\s*\)\s+references\s+auth\.users\s*\(\s*id\s*\)\s+on\s+delete\s+restrict/i,
    );
    // Not cascade — a dashboard-side user delete with journal rows must fail loudly, not erase history.
    expect(flat).not.toMatch(/references\s+auth\.users\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i);
  });
});

describe("supabase/migrations holds only <timestamp>_name.sql (the CLI enumerates every file)", () => {
  // `supabase db push` warns "Skipping migration <file>... (file name must match pattern)" for any
  // stray file — a test dropped there once spammed every make-ship step. Tests live in scripts/.
  it("every entry matches the CLI's migration pattern", () => {
    const stray = readdirSync(DIR).filter((f) => !/^\d{14}_[a-z0-9_]+\.sql$/.test(f));
    expect(stray).toEqual([]);
  });
});
