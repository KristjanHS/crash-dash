// Every `create table` in schema `public` across the migrations enables row level security — in the
// SAME or a LATER migration — or is rostered here with its reason, pinned on the DDL text itself.
//
// Sibling `anon-read-coverage.test.ts` pins that anon holds no grant; this file pins RLS-on for every table
// (`authenticated` still holds Supabase's default grants, so RLS is its boundary).
// The live-DB twin (`pg_class … not relrowsecurity = ∅`) needs the stack and is a `check:integration` item, not this file.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { stripSqlComments } from "./check-destructive-migrations.js";

const DIR = "supabase/migrations";

/** Tables rightly left RLS-OFF, with the one-word reason. Empty today; a stale row (RLS now on) fails. */
const NO_RLS: Record<string, string> = {};

type Migration = { name: string; sql: string };

/**
 * Tables created in `public` (unqualified or `public.`-qualified; temp tables are session-scoped and
 * skipped) whose newest `create table` has no `enable row level security` in that migration or a later
 * one. Pure over the migration list so the synthetic check below exercises the same code path.
 */
export function rlsGaps(migrations: readonly Migration[]): string[] {
  const ordered = [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const createdAt = new Map<string, number>();
  const enabledAt = new Map<string, number>();
  ordered.forEach(({ sql }, i) => {
    const flat = stripSqlComments(sql).replace(/\s+/g, " ").toLowerCase();
    for (const m of flat.matchAll(
      /\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/g,
    )) {
      createdAt.set(m[1]!, i); // the newest create wins: a drop+recreate needs a fresh enable
    }
    for (const m of flat.matchAll(
      /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+enable\s+row\s+level\s+security\b/g,
    )) {
      enabledAt.set(m[1]!, i);
    }
  });
  return [...createdAt]
    .filter(([table, c]) => (enabledAt.get(table) ?? -1) < c)
    .map(([table]) => table)
    .sort();
}

const migrations: Migration[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .map((name) => ({ name, sql: readFileSync(`${DIR}/${name}`, "utf8") }));

const gaps = rlsGaps(migrations);

describe("RLS coverage (every public table enables row level security)", () => {
  it("the migration scan is live — guards a vacuous pass", () => {
    expect(migrations.length).toBeGreaterThan(10);
    // Both the create-side and the enable-side regexes see the real DDL (a silent regex miss zeroes one of them).
    const flat = migrations.map((m) => stripSqlComments(m.sql)).join("\n");
    expect(flat).toMatch(/create table if not exists readings\b/);
    expect(flat).toMatch(/alter table readings\s+enable row level security/);
  });

  it("every public table without RLS is rostered with a reason", () => {
    expect(gaps.filter((t) => !(t in NO_RLS))).toEqual([]);
  });

  it("no roster row is stale (the table exists AND is still RLS-off)", () => {
    const created = new Set(rlsGaps(migrations.map((m) => ({ ...m, sql: m.sql.replace(/enable row level security/gi, "") }))));
    const stale = Object.keys(NO_RLS).filter((t) => !created.has(t) || !gaps.includes(t));
    expect(stale).toEqual([]);
  });

  it("the classifier can fail: a synthetic table with no enable, and an enable that precedes its create", () => {
    const synthetic: Migration[] = [
      { name: "0001_a.sql", sql: "create table if not exists ok_t (id int);\nalter table ok_t enable row level security;" },
      { name: "0002_b.sql", sql: "-- alter table gap_t enable row level security; (comment only)\ncreate table public.gap_t (id int);" },
      { name: "0003_c.sql", sql: "alter table early_t enable row level security;" },
      { name: "0004_d.sql", sql: "drop table early_t; create table early_t (id int);" },
      { name: "0005_e.sql", sql: "create temp table scratch (id int);" },
    ];
    expect(rlsGaps(synthetic)).toEqual(["early_t", "gap_t"]);
  });
});
