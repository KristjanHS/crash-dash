import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { readSentinel, reviewMigration, scanMigrationBody, stripSqlComments } from "./check-destructive-migrations.js";

// The gate's only real test is the record_run same-day-replace migration. Everything else here exists to keep that assertion honest.

const MIGRATION = (name: string) => readFileSync(`supabase/migrations/${name}`, "utf8");

describe("the acceptance falsifier — record_run_same_day_replace must not slip through", () => {
  // 20260717000000_record_run_same_day_replace.sql is the migration that motivated this gate: its DDL
  // verb is `create or replace function` (additive-looking) while its BODY unconditionally deletes from
  // alert_log — the table docs/reference.md §[dr] What we back up (and why) calls irreplaceable. It reached prod direct-to-main,
  // unpreviewed. A gate that misses this file has failed its only real test.
  const file = "20260717000000_record_run_same_day_replace.sql";
  const sql = MIGRATION(file);

  test("the body scan flags its DELETE", () => {
    const hazards = scanMigrationBody(sql);
    expect(hazards.some((h) => h.verb === "DELETE")).toBe(true);
  });

  test("the flagged DELETE is the executable one, not a comment describing it", () => {
    const hit = scanMigrationBody(sql).find((h) => h.verb === "DELETE");
    expect(hit?.text).toMatch(/^delete from alert_log/i);
    // Pin the line so a rewrite of the file that moves the delete cannot silently pass this test.
    expect(sql.split("\n")[hit!.line - 1]).toContain("delete from alert_log");
  });

  test("it carries no sentinel, so the gate fails it", () => {
    expect(reviewMigration(file, sql).ok).toBe(false);
  });
});

describe("the append-only migration that reversed it must NOT be flagged", () => {
  // 20260717010000_record_run_append_only.sql (Stage 1.2) is the fix: same body minus the delete. Its
  // header comments quote the removed `delete from alert_log …` verbatim and its plpgsql carries
  // `-- Drop top-level nulls` and `-- Append-only: no delete`. If comment-stripping regressed, this
  // clean migration would fail the gate on the prose describing the hazard it removed.
  const file = "20260717010000_record_run_append_only.sql";
  const sql = MIGRATION(file);

  test("no hazard survives comment-stripping", () => {
    expect(scanMigrationBody(sql)).toEqual([]);
  });

  test("its raw text really does contain the words, so the pass above is stripping and not luck", () => {
    expect(sql).toMatch(/delete from alert_log/i);
    expect(sql).toMatch(/-- Drop top-level nulls/);
  });

  test("`not attisdropped` is not a DROP", () => {
    expect(sql).toContain("not attisdropped");
    expect(scanMigrationBody(sql).some((h) => h.verb === "DROP")).toBe(false);
  });
});

describe("append-only is a live invariant, not just a shipped file (audit DATA-6's successor)", () => {
  // DATA-6 asked for a unique index against a delete-then-insert race. That premise died when
  // 20260717010000 removed the DELETE — but append-only is now load-bearing (docs/reference.md §[dr]
  // reasons about restores on it, and the read layer's same-date collapse assumes N rows per date are
  // legitimate) while being held by nothing except the absence of a line. A LATER `create or replace
  // function record_run` could restore delete-on-write; the destructive gate would demand a sentinel,
  // but a sentinel is satisfiable — someone can write one and still be wrong about alert_log.
  //
  // So this pins the WINNING definition, not a filename: whichever record_run-defining migration sorts
  // last is the one Postgres ends up with, and its body must not delete from alert_log.
  const defining = readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    // Stripped, not raw: a migration that merely MENTIONS `create or replace function record_run` in a
    // header comment must not be mistaken for a definer, and the body check below strips too.
    .filter((f) => /create\s+or\s+replace\s+function\s+record_run/i.test(stripSqlComments(MIGRATION(f))))
    .sort();

  test("the scan actually found the record_run lineage (guards against a vacuous pass)", () => {
    // Goes red when the definer regex stops matching the lineage — e.g. a rewrite that changes the
    // declaration's spelling. (An emptied migrations dir does NOT reach here: readdirSync throws at
    // collection time, which is a loud failure rather than a silent pass.)
    expect(defining.length).toBeGreaterThanOrEqual(2);
    expect(defining).toContain("20260717010000_record_run_append_only.sql");
  });

  test("the newest record_run definition does not delete from alert_log", () => {
    const winner = defining[defining.length - 1];
    // Not decoration: without it an empty lineage would make the assertion below read a file that
    // doesn't exist rather than silently passing over `undefined`.
    expect(winner).toBeDefined();
    const body = stripSqlComments(MIGRATION(winner!));
    expect(body).not.toMatch(/delete\s+from\s+alert_log/i);
  });

  test("append-only really is the winner today, not merely a file that exists", () => {
    // Pins the ordering claim itself: if a migration newer than 20260717010000 redefines record_run,
    // this goes red and forces a human to re-read what it did to alert_log.
    expect(defining[defining.length - 1]).toBe("20260717010000_record_run_append_only.sql");
  });
});

describe("hazard taxonomy", () => {
  test.each([
    ["delete from alert_log where id = 1;", "DELETE"],
    ["truncate readings;", "TRUNCATE"],
    ["update alert_log set band = 'OK';", "UPDATE"],
    ["drop table readings;", "DROP"],
    ["alter table alert_log alter column obs_date type date;", "ALTER … TYPE"],
  ])("%s is flagged as %s", (sql, verb) => {
    expect(scanMigrationBody(sql).some((h) => h.verb === verb)).toBe(true);
  });

  // Grant/revoke privilege lists are not DML (20260905200000_readings_warmup tripped this).
  test.each([
    "alter table alert_log add column push_error text;",
    "grant select, insert, update, delete on readings_warmup to service_role;",
    "  REVOKE update, delete ON t FROM anon;",
  ])("%s is clean", (sql) => {
    expect(scanMigrationBody(sql)).toEqual([]);
  });

  test("the live readings_warmup migration passes the gate with no sentinel", () => {
    const file = "20260905200000_readings_warmup.sql";
    const sql = MIGRATION(file);
    expect(sql).toMatch(/^grant .*\bdelete\b/im);
    expect(reviewMigration(file, sql)).toMatchObject({ hazards: [], sentinel: null, ok: true });
  });

  test("hazard lines are 1-based and point into the raw file", () => {
    expect(scanMigrationBody("-- header\n\ndelete from t;")).toEqual([
      { line: 3, verb: "DELETE", text: "delete from t;" },
    ]);
    // The grant exemption is line-anchored: a real delete on a following line still fires.
    expect(scanMigrationBody("grant delete on t to r;\ndelete from t;").map((h) => h.line)).toEqual([2]);
  });
});

describe("the sentinel is read raw; the body is read stripped", () => {
  const destructive = "-- destructive: reviewed drops alert_log's same-date rows; backups branch 2026-07-17 precedes\ndelete from alert_log;";

  test.each([
    ["a sentinel with a reason satisfies the gate", destructive, true],
    ["a bare rubber stamp with no reason does NOT", "-- destructive: reviewed\ndelete from alert_log;", false],
    ["a clean migration needs no sentinel", "alter table t add column c text;", true],
  ])("%s", (_label, sql, ok) => {
    expect(reviewMigration("x.sql", sql).ok).toBe(ok);
  });

  test("the sentinel does not strip itself", () => {
    // The regression this guards: stripping comments before the sentinel grep erases the sentinel.
    expect(readSentinel(destructive)).toBe("drops alert_log's same-date rows; backups branch 2026-07-17 precedes");
    expect(readSentinel(stripSqlComments(destructive))).toBeNull();
  });
});
