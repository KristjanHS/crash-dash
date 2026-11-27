/**
 * Trading-rules PURE seam. DOM-free by
 * construction: every function takes plain data and returns plain data or a markup STRING, so
 * `rules-view.test.js` can cover it with no jsdom (`.claude/rules/frontend.md` §"Testable slices go
 * in a pure seam module"). It touches no `document`, no `fetch`, no `localStorage` — `journal.js`
 * (the shell) owns all three, exactly as it does for `journal-view.js`.
 *
 * The table is APPEND-ONLY (migration `20260919120000_add_trading_rules.sql`): one row per VERSION
 * of a rule, `rule_key` stable across revisions, `version` incrementing. A revise inserts a new
 * version; a retire inserts a version with `retired = true`. Nothing overwrites a wording.
 */

import { esc } from "./journal-view.js";

/** How many rows the list shows is not capped here — the fold runs over whatever the shell fetched. */

/**
 * Collapse the full version history into the LIVE rule list.
 *
 * Per `rule_key`: the LIVE wording is the row with the HIGHEST version; the SORT timestamp is the
 * row with the LOWEST version (`version = 1` when the history is intact) — a rule keeps its place in
 * the list from the day it was first written, not from its latest revision. A key whose live version
 * carries `retired = true` is dropped (un-retire is out of scope for slice 1). The two-timestamp
 * split is the one non-obvious step, so it is spelled out rather than folded into one pass.
 */
export function liveRules(rows) {
  const byKey = new Map();
  for (const row of rows ?? []) {
    const key = row?.rule_key;
    if (key === undefined || key === null || key === "") continue;
    const version = Number(row?.version);
    if (!Number.isInteger(version)) continue;
    let group = byKey.get(key);
    if (!group) {
      group = { live: null, first: null };
      byKey.set(key, group);
    }
    // LIVE wording = the highest version seen for this key.
    if (group.live === null || version > Number(group.live.version)) group.live = row;
    // SORT anchor = the lowest version (the v1 row when the chain is intact).
    if (group.first === null || version < Number(group.first.version)) group.first = row;
  }

  const out = [];
  for (const group of byKey.values()) {
    if (group.live === null) continue;
    if (group.live.retired === true) continue;
    const firstCreatedAt = (group.first ?? group.live).created_at ?? null;
    out.push({ ...group.live, first_created_at: firstCreatedAt });
  }
  // Newest-first by the FIRST version's created_at, not the live version's.
  out.sort((a, b) => String(b.first_created_at ?? "").localeCompare(String(a.first_created_at ?? "")));
  return out;
}

/**
 * The version an insert must claim for `ruleKey`: `max(version) + 1`, or `1` when the key is new.
 * A race between two devices collides on `unique (user_id, rule_key, version)` and surfaces as a
 * 409 — slice 1's shell shows the error and reloads rather than retrying.
 */
export function nextVersion(rows, ruleKey) {
  let max = 0;
  for (const row of rows ?? []) {
    if (row?.rule_key !== ruleKey) continue;
    const version = Number(row?.version);
    if (Number.isInteger(version) && version > max) max = version;
  }
  return max + 1;
}

/**
 * Validate the "+ new rule" form. Returns `{ ok: true }` or `{ ok: false, errors }`; a non-empty
 * `rule` wording is the only hard requirement (mistake/cost/tags are all optional — the DB defaults
 * them). Never throws: the caller is a submit handler.
 */
export function validateRuleForm(fields) {
  const errors = [];
  if (String(fields?.rule ?? "").trim() === "") errors.push("A rule needs wording before you can save it.");
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

/**
 * Build the exact PostgREST insert row. Keys are the SNAKE_CASE column names — PostgREST posts the
 * object verbatim, so a camelCase key would be a 400 from the database. `user_id` rides the row
 * because the insert policy checks it against `auth.uid()`; a forged id is rejected by the DB.
 *
 * `source: "own"` and `source_key: null` are written for every slice-1 row: the columns exist for
 * the future published-catalog increment (an adopted catalog entry would carry `source_key`), which
 * needs no schema change — nothing READS them yet (spec §Out of scope).
 */
export function ruleInsertRow(fields, userId, ruleKey, version) {
  return {
    user_id: userId,
    rule_key: ruleKey,
    version,
    mistake: String(fields?.mistake ?? "").trim(),
    cost: String(fields?.cost ?? "").trim(),
    rule: String(fields?.rule ?? "").trim(),
    tags: parseTags(fields?.tags),
    retired: fields?.retired === true,
    source: "own",
    source_key: null,
  };
}

/** A comma-separated tag string (or an already-split array) → the trimmed, non-empty `text[]`. */
function parseTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags ?? "").split(",");
  return list.map((t) => String(t).trim()).filter((t) => t !== "");
}

/**
 * One live rule as markup. Emits `.tr-*` classes ONLY — `rules-view.test.js` pins every one against
 * `journal.css`, because a markup test proves a class is EMITTED and never that it is STYLED
 * (`frontend.md`). No inline `style=` attribute: `public/inline-pos.test.js` lints for exactly that.
 */
export function ruleCardHTML(rule) {
  const tags = Array.isArray(rule?.tags) ? rule.tags.filter((t) => String(t).trim() !== "") : [];
  const tagsHtml = tags.length
    ? `<ul class="tr-tags">${tags.map((t) => `<li class="tr-tag">${esc(t)}</li>`).join("")}</ul>`
    : "";
  return [
    `<li class="tr-row">`,
    `<p class="tr-rule">${esc(rule?.rule)}</p>`,
    rule?.mistake ? `<p class="tr-mistake">${esc(rule.mistake)}</p>` : "",
    rule?.cost ? `<p class="tr-cost">${esc(rule.cost)}</p>` : "",
    tagsHtml,
    `</li>`,
  ].join("");
}

/** The live-rules list, newest-first. An empty list renders the empty state, never an empty `<ul>`. */
export function ruleListHTML(rules) {
  if (!rules || rules.length === 0) {
    return `<p class="tr-empty">No rules yet - add the first one below.</p>`;
  }
  return `<ul class="tr-list">${rules.map((rule) => ruleCardHTML(rule)).join("")}</ul>`;
}

/**
 * PostgREST endpoints, mirroring `rowsUrl`/`insertUrl` in `journal-view.js`. The list is ordered
 * oldest-first (`created_at.asc`) so the shell holds the full history in version order; `liveRules`
 * folds it. No bearer is baked in here — the shell attaches `authHeaders()`.
 */
export const rulesUrl = (conn) => `${conn.url}/rest/v1/trading_rules?select=*&order=created_at.asc`;
export const ruleInsertUrl = (conn) => `${conn.url}/rest/v1/trading_rules`;
