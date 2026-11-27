#!/usr/bin/env node
// Backlog falsifier sweep — Stage 1 extractor.
//
// Reads `docs/backlog.md` and emits one JSON row per assistant-owed item:
//   { line, section, text, falsifier, class }
// Scope: every `⚠ ` / `- ` item line under `## Open` and its dated `##` sub-sections, plus the
// trailing assistant-owed sections after the plan-doc menu. The `## §OWED[USER]` and
// `## Plan-doc menu` sections are skipped whole. Already-struck `~~` lines are NOT rows (they are
// deleted by hand in the first apply batch; their evidence is in their own commits).
//
// Class = what kind of falsifier the item states, first match wins on the falsifier text:
//   npm-probe  — `npm run probe:` / `npx tsx scripts/probe-`            (excluded from the sweep)
//   prod-curl  — `curl` or an http(s) URL                               (excluded from the sweep)
//   grep       — grep/rg/ls/wc/git log/git -S/git grep/cat/test -f     (RUN by the sweep)
//   other      — a falsifier clause that names none of the above (a manual / eyeball step)
//   none       — no `falsifier` clause at all
//
// Usage: node scripts/backlog-falsifier-table.mjs <out.json> [backlog.md]
import { readFileSync, writeFileSync } from "node:fs";

export const CLASSES = ["grep", "npm-probe", "prod-curl", "other", "none"];

const SKIP_SECTION = /^## (§OWED\[USER\]|Plan-doc menu)/;
const ITEM = /^(⚠ |- )/;
const FALSIFIER = /falsifier[^:`]{0,30}:\s*(.*)$/i;

export function classify(falsifier) {
  if (falsifier == null) return "none";
  if (/npm run probe:|npx tsx scripts\/probe-/.test(falsifier)) return "npm-probe";
  if (/\bcurl\b|https?:\/\//.test(falsifier)) return "prod-curl";
  if (/\b(grep|rg|ls|wc|git log|git -S|git grep|cat|test -f)\b/.test(falsifier)) return "grep";
  return "other";
}

export function extract(markdown) {
  const rows = [];
  let section = null;
  let inScope = false;
  let seenOpen = false;
  markdown.split("\n").forEach((raw, i) => {
    if (raw.startsWith("## ")) {
      section = raw.slice(3).trim();
      if (raw.startsWith("## Open")) seenOpen = true;
      inScope = seenOpen && !SKIP_SECTION.test(raw);
      return;
    }
    if (!inScope || !ITEM.test(raw)) return;
    const m = raw.match(FALSIFIER);
    const falsifier = m ? m[1].replace(/^\*\*\s*/, "").trim() : null;
    rows.push({ line: i + 1, section, text: raw, falsifier, class: classify(falsifier) });
  });
  return rows;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const [out, src = "docs/backlog.md"] = process.argv.slice(2);
  if (!out) {
    console.error("usage: node scripts/backlog-falsifier-table.mjs <out.json> [backlog.md]");
    process.exit(2);
  }
  const rows = extract(readFileSync(src, "utf8"));
  writeFileSync(out, JSON.stringify(rows, null, 1));
  const counts = Object.fromEntries(CLASSES.map((c) => [c, rows.filter((r) => r.class === c).length]));
  console.log(`${rows.length} rows → ${out}`, JSON.stringify(counts));
}
