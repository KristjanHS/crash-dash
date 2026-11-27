/**
 * `docs/claim-verification.md` index/shard integrity guard — collected by `npm run check`
 * (the vitest include glob already picks up co-located test files under scripts/).
 *
 * A rewrite cut that file down to an INDEX
 * (one `## N — <claim> → <shard>` line per ordinal) over topic shards in `docs/claim-verification/`.
 * The whole saving rests on a permanence contract that nothing in the repo pinned:
 *
 *   (a) every index line routes to a shard file that EXISTS and actually holds that ordinal's `## N`;
 *   (b) an ordinal lives in exactly ONE shard — a shard is a storage location, not a namespace;
 *   (c) every index ordinal is either a shard body or an INLINE tombstone (`→ merged into §X` /
 *       `→ retired, pinned by <test>`), never a dead end.
 *
 * Break any one and a cite of the form `docs/claim-verification.md` §N stops resolving silently:
 * the file still opens, the index line still reads fine, and no other check in the repo looks at it.
 * The cite form is mandated by `plan-hygiene.md` §Claims, so this is that rule's recurrence guard.
 *
 * ⚠ **Deliberately NOT asserted: title equality between an index line and its shard heading.**
 * R1 compressed the index titles while moving the bodies verbatim, so the same ordinal legitimately
 * carries two spellings (e.g. §60's index line says "A ROSTER SIZE is structural" where the shard
 * heading reads "a ROSTER SIZE is a structural constant"). Asserting equality would be red on a
 * faithful tree; the ordinal is the id, and the shard heading merely has to EXIST.
 *
 * SELF-INDICTMENT: this file lives under `scripts/`, which `check-rule-cites.test.ts` walks. It
 * writes no `docs/plans/`-prefixed cite (bare stem + directory hint only) and its one rule `§` cite
 * names a live `##`. It also cannot pass vacuously: the ordinal census carries a floor, so an index
 * that stops parsing (or a shard dir that empties) is red, not green.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(REPO_ROOT, "docs", "claim-verification.md");
const SHARD_DIR = join(REPO_ROOT, "docs", "claim-verification");

/** `## 12 — some claim → `measurements.md`` (shard route) or `## 32 → merged into §25` (tombstone). */
const INDEX_ORDINAL = /^## (\d+)\b(.*)$/;
/** The trailing route on an index line: a backticked `<name>.md`. */
const SHARD_ROUTE = /`([A-Za-z0-9._-]+\.md)`\s*$/;
/** An inline tombstone: `→ merged into §N` or `→ retired, pinned by <test>`. */
const TOMBSTONE = /→\s*(merged into|retired)/;

interface IndexEntry {
  n: number;
  line: number;
  shard: string | null;
  tombstone: boolean;
}

function readIndex(): IndexEntry[] {
  const entries: IndexEntry[] = [];
  readFileSync(INDEX, "utf8")
    .split("\n")
    .forEach((line, i) => {
      const m = INDEX_ORDINAL.exec(line);
      if (!m) return;
      const rest = m[2] ?? "";
      const route = SHARD_ROUTE.exec(rest);
      entries.push({
        n: Number(m[1]),
        line: i + 1,
        shard: route ? route[1]! : null,
        tombstone: TOMBSTONE.test(rest),
      });
    });
  return entries;
}

/** ordinal → shard basenames that carry a `## <ordinal>` heading. */
function shardOrdinals(): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const f of readdirSync(SHARD_DIR).filter((x) => x.endsWith(".md"))) {
    for (const line of readFileSync(join(SHARD_DIR, f), "utf8").split("\n")) {
      const m = INDEX_ORDINAL.exec(line);
      if (!m) continue;
      const n = Number(m[1]);
      out.set(n, [...(out.get(n) ?? []), f]);
    }
  }
  return out;
}

describe("docs/claim-verification.md index resolves into its shards", () => {
  it("every `## N` index line routes to a shard that holds that ordinal, or is a tombstone", () => {
    const entries = readIndex();
    // Vacuity anchor: the index is an append-only taxonomy well past 70 classes. A parse that
    // collapses (regex drift, index rewritten to another shape) must be RED, not silently green.
    expect(entries.length, "claim-verification index ordinal census collapsed — is the index still `## N` lines?").toBeGreaterThan(
      60,
    );
    const bad: string[] = [];
    for (const e of entries) {
      if (!e.shard) {
        // (c) — no route, so it must be an inline tombstone.
        if (!e.tombstone) bad.push(`:${e.line}: §${e.n} has neither a shard route nor a tombstone`);
        continue;
      }
      const path = join(SHARD_DIR, e.shard);
      if (!existsSync(path)) {
        bad.push(`:${e.line}: §${e.n} routes to missing shard ${e.shard}`);
        continue;
      }
      // (a) — the named shard must actually carry the ordinal. Heading TEXT is not compared; see
      // the ⚠ in this file's docblock.
      const has = readFileSync(path, "utf8")
        .split("\n")
        .some((l) => new RegExp(`^## ${e.n}\\b`).test(l));
      if (!has) bad.push(`:${e.line}: §${e.n} routes to ${e.shard}, which has no \`## ${e.n}\` heading`);
    }
    expect(bad, `broken claim-verification index routes:\n${bad.join("\n")}`).toEqual([]);
  });

  it("no ordinal appears in two shards", () => {
    const dupes = [...shardOrdinals().entries()]
      .filter(([, files]) => files.length > 1)
      .map(([n, files]) => `§${n} appears in ${files.join(", ")}`);
    // Vacuity anchor: the shards must be readable at all for the dupe check to mean anything.
    expect([...shardOrdinals().keys()].length, "no ordinals found in docs/claim-verification/ — shard walk is broken").toBeGreaterThan(
      60,
    );
    expect(dupes, `ordinals duplicated across shards:\n${dupes.join("\n")}`).toEqual([]);
  });
});
