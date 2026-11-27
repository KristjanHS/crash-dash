// `anon` reads nothing in schema public: the revoke migration strips every grant, no later migration re-grants,
// and the browser's direct REST calls reach only the per-user tables (bearer → `authenticated`). Prod twin: the migration's falsifier.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { stripSqlComments } from "./check-destructive-migrations.js";

const DIR = "supabase/migrations";
const REVOKE_ALL_TABLES = "revoke all on all tables in schema public from anon";

/** Per-user tables + RPC the browser calls directly with the user's bearer; their own RLS tests pin them. */
const BROWSER_REST = new Set(["holdings_journal", "trading_rules", "email_subscribers", "rpc/delete_my_account"]);

const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
/** Statement-wise, whitespace-flattened (a grant split across lines is still one grant). */
const stmts = (f: string): string[] =>
  stripSqlComments(readFileSync(`${DIR}/${f}`, "utf8")).split(";").map((s) => s.replace(/\s+/g, " ").trim().toLowerCase());
const revokeAt = files.findIndex((f) => stmts(f).includes(REVOKE_ALL_TABLES));
const widensAnon = (s: string): boolean => /^(grant|alter default privileges\b.*\bgrant)\b.*\bto\b[^;]*\b(anon|public)\b/.test(s) || /^create policy\b.*\bto\b[^;]*\banon\b/.test(s);

describe("anon reads nothing in schema public", () => {
  it("the revoke migration strips tables, sequences, functions (anon + PUBLIC) and the defaults", () => {
    expect(revokeAt).toBeGreaterThanOrEqual(0);
    expect(stmts(files[revokeAt]!)).toEqual(
      expect.arrayContaining([
        REVOKE_ALL_TABLES,
        "revoke all on all sequences in schema public from anon",
        "revoke all on all functions in schema public from anon",
        "revoke all on all functions in schema public from public",
        "alter default privileges in schema public revoke all on tables from anon",
        "alter default privileges in schema public revoke all on sequences from anon",
        "alter default privileges in schema public revoke all on functions from anon",
        "alter default privileges revoke execute on functions from public",
      ]),
    );
  });

  it("no later migration grants anon or PUBLIC anything", () => {
    // Liveness: the same matcher sees the pre-revoke anon grants.
    expect(files.slice(0, revokeAt).flatMap(stmts).some(widensAnon)).toBe(true);
    expect(files.slice(revokeAt + 1).flatMap((f) => stmts(f).filter(widensAnon).map((s) => `${f}: ${s}`))).toEqual([]);
  });

  it("browser code calls Supabase REST only on the per-user tables", () => {
    const hits = readdirSync("public")
      .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
      .flatMap((f) => [...readFileSync(`public/${f}`, "utf8").matchAll(/\/rest\/v1\/([^?"'`\s]*)/g)].map((m) => `${f}: ${m[1]}`));
    expect(hits.some((h) => h.endsWith(": holdings_journal"))).toBe(true);
    expect(hits.filter((h) => !BROWSER_REST.has(h.slice(h.indexOf(": ") + 2)))).toEqual([]);
  });
});
