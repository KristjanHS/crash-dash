// Destructive-migration review gate (Stage 2.1; audit API-8).
//
// An apply-on-merge migrate job (since removed; break-glass is an optional operator-side dispatch) previewed
// ONLY on a pull_request event, so a destructive migration pushed straight to main applied unseen —
// which is exactly how `20260717000000_record_run_same_day_replace.sql` put an unconditional
// `delete from alert_log` into prod behind a `create or replace function` verb.
//
// This module is the enforcement: a pending migration whose BODY carries a destructive verb must
// carry a `-- destructive: reviewed <reason>` line naming what it destroys and which snapshot
// precedes it. It is an honour-system record (nothing here prints or diffs the live SQL), and that
// is the accepted cost of the ruling — what it buys is a durable statement in git next to the DDL.
//
// The comment-stripping is load-bearing in BOTH directions: the sentinel *is* a `--` comment, so the
// hazard scan reads the stripped body while the sentinel scan reads the raw file. Strip once for both
// and the sentinel strips itself.

import { readFileSync } from "node:fs";
import { basename } from "node:path";

/** A destructive verb found in a migration body. `verb` is the taxonomy id, not the matched text. */
export type Hazard = { line: number; verb: string; text: string };

export type Review = {
  file: string;
  hazards: Hazard[];
  /** The sentinel's reason text, or null when no well-formed sentinel is present. */
  sentinel: string | null;
  /** False only when the body is destructive and no sentinel vouches for it. */
  ok: boolean;
};

/**
 * The taxonomy `.claude/rules/migrations.md` names, plus DROP and ALTER … TYPE. Word-bounded on
 * purpose: `record_run`'s guard reads `not attisdropped`, which is not a DROP, and `jsonb_populate_record`
 * is not an UPDATE. Over-matching is the safe direction (a false hit costs one sentinel line), so this
 * deliberately does not try to parse SQL — any occurrence of the verb in executable text counts.
 */
const HAZARD_VERBS: ReadonlyArray<{ verb: string; re: RegExp }> = [
  { verb: "DELETE", re: /\bdelete\b/i },
  { verb: "TRUNCATE", re: /\btruncate\b/i },
  { verb: "UPDATE", re: /\bupdate\b/i },
  { verb: "DROP", re: /\bdrop\b/i },
  { verb: "ALTER … TYPE", re: /\balter\b.*\btype\b/i },
];

/**
 * `-- destructive: reviewed <reason>`. The reason is REQUIRED and must be non-empty — a bare
 * `-- destructive: reviewed` is a rubber stamp, not a record, so it does not satisfy the gate.
 */
const SENTINEL_RE = /^[ \t]*--[ \t]*destructive:[ \t]*reviewed[ \t]+(\S.*?)[ \t]*$/im;

/**
 * Blank out `--` line comments, preserving line count and line numbers so a hazard's reported line
 * still points into the real file. Block comments are NOT stripped: a hazard verb hidden in a `/* … *\/`
 * comment then reads as a hazard and fails closed, which is the harmless direction.
 */
export function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

/**
 * `grant`/`revoke` lines name PRIVILEGES (`grant … update, delete on t to service_role`), not
 * statements — every new table's RLS block carries one, and it destroys nothing. Line-anchored so a
 * `delete from` that merely follows a grant on the same line still counts.
 */
const PRIVILEGE_LINE_RE = /^[ \t]*(grant|revoke)\b/i;

/** Every destructive verb in the migration's executable body, with 1-based line numbers. */
export function scanMigrationBody(sql: string): Hazard[] {
  const hazards: Hazard[] = [];
  stripSqlComments(sql)
    .split("\n")
    .forEach((line, i) => {
      if (PRIVILEGE_LINE_RE.test(line)) return;
      for (const { verb, re } of HAZARD_VERBS) {
        if (re.test(line)) hazards.push({ line: i + 1, verb, text: line.trim() });
      }
    });
  return hazards;
}

/** The sentinel's reason, read from the RAW file (the sentinel is itself a comment). */
export function readSentinel(rawSql: string): string | null {
  return SENTINEL_RE.exec(rawSql)?.[1] ?? null;
}

export function reviewMigration(file: string, rawSql: string): Review {
  const hazards = scanMigrationBody(rawSql);
  const sentinel = readSentinel(rawSql);
  return { file, hazards, sentinel, ok: hazards.length === 0 || sentinel !== null };
}

function report(review: Review): void {
  const name = basename(review.file);
  if (review.hazards.length === 0) {
    console.log(`  OK  ${name} — no destructive verb in the body`);
    return;
  }
  const verbs = [...new Set(review.hazards.map((h) => h.verb))].join(", ");
  if (review.ok) {
    console.log(`  OK  ${name} — destructive (${verbs}), reviewed: ${review.sentinel}`);
    return;
  }
  console.log(`::error file=${review.file}::${name} has a destructive body (${verbs}) with no review sentinel.`);
  for (const h of review.hazards) console.log(`        line ${h.line}: [${h.verb}] ${h.text}`);
  console.log(
    [
      "",
      `  ${name} must carry a line of the form:`,
      "",
      "      -- destructive: reviewed <what it destroys; which snapshot precedes it>",
      "",
      "  Destructive is a property of the migration BODY, not its DDL verb — a",
      "  `create or replace function` that deletes rows is destructive. See",
      "  .claude/rules/migrations.md and docs/reference.md §[dr] before adding it.",
      "",
    ].join("\n"),
  );
}

export function main(files: string[]): number {
  if (files.length === 0) {
    console.log("No pending migrations to review.");
    return 0;
  }
  console.log(`Reviewing ${files.length} pending migration(s) for destructive bodies:`);
  const reviews = files.map((f) => reviewMigration(f, readFileSync(f, "utf8")));
  reviews.forEach(report);
  const failed = reviews.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(`::error::${failed.length} pending migration(s) are destructive without a review sentinel.`);
    return 1;
  }
  console.log("OK — every pending destructive migration carries a review sentinel.");
  return 0;
}

// CLI: `tsx scripts/check-destructive-migrations.ts <file.sql> …`. Import-safe (the test imports the
// scan seam directly), so the run-as-main guard is required.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
