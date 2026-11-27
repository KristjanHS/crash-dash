// Live-DB twin of `rls-coverage.test.ts`: every `public`
// table has RLS on, and `supabase db advisors --type all` reports no WARN+ finding. Runs in `check:integration` phase 1.
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { hasDb } from "../src/store.test-helpers.js";

/** RLS-off tables, with the reason. `_disposable_stack` = ci-stack.sh's CI marker, not a migration table. */
const NO_RLS: Record<string, string> = { _disposable_stack: "ci marker" };
/** WARN+ advisor findings kept on purpose, keyed `<name> <detail>`. A stale row fails. */
const ADVISOR_KEEP: Record<string, string> = {
  "fkey_to_auth_unique Table `auth`.`refresh_tokens` has a foreign key `refresh_tokens_parent_fkey` referencing an auth unique constraint":
    "GoTrue's own table (local stack runs GoTrue so `status -o env` emits the service-role key) — not our schema",
};

const RLS_OFF_SQL = `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity order by 1`;

function dbUrl(): string {
  const u = new URL(process.env.SUPABASE_DB_URL ?? process.env.SUPABASE_URL!);
  if (!["127.0.0.1", "localhost"].includes(u.hostname)) throw new Error(`rls-live: refusing non-local DB host ${u.hostname}`);
  return process.env.SUPABASE_DB_URL ?? `postgresql://postgres:postgres@${u.hostname}:${Number(u.port) + 1}/postgres`;
}

type Lint = { name: string; level: string; detail: string };

describe.runIf(hasDb)("live RLS + advisors (integration)", () => {
  let client: Client;
  let lints: Lint[];
  beforeAll(() => {
    client = new Client({ connectionString: dbUrl() });
    const url = new URL(dbUrl());
    url.searchParams.set("sslmode", "disable");
    const out = execFileSync("node_modules/.bin/supabase", ["db", "advisors", "--db-url", url.toString(), "--type", "all", "--level", "info", "--output-format", "json"], { encoding: "utf8", timeout: 120_000 });
    lints = (JSON.parse(out) as { results: Lint[] }).results;
    return client.connect();
  }, 150_000);
  afterAll(() => client?.end());

  test("no public table has RLS off outside NO_RLS — and the query sees a fresh RLS-off table", async () => {
    const { rows } = await client.query<{ relname: string }>(RLS_OFF_SQL);
    expect(rows.map((r) => r.relname).filter((t) => !(t in NO_RLS))).toEqual([]);
    await client.query("begin");
    try {
      await client.query("create table public._rls_live_probe (id int)");
      const probe = await client.query<{ relname: string }>(RLS_OFF_SQL);
      expect(probe.rows.map((r) => r.relname)).toContain("_rls_live_probe");
    } finally {
      await client.query("rollback");
    }
  });

  test("advisors report no WARN+ finding outside ADVISOR_KEEP, and every ADVISOR_KEEP row still fires", () => {
    // Vacuity anchor the migration never drains: INFO rls_enabled_no_policy on service-role-only scorer_vintage.
    expect(lints.some((l) => l.name === "rls_enabled_no_policy" && l.detail.includes("`public.scorer_vintage`"))).toBe(true);
    const hits = lints.filter((l) => l.level !== "INFO").map((l) => `${l.name} ${l.detail}`);
    expect(hits.filter((h) => !(h in ADVISOR_KEEP))).toEqual([]);
    expect(Object.keys(ADVISOR_KEEP).filter((k) => !hits.includes(k))).toEqual([]);
  });
});
