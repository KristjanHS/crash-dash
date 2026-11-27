// Trading-rules pure seam (rules-view.js), plus the one page-level invariant a markup test alone
// cannot reach: every class the seam emits must resolve to a rule in journal.css (a green markup pin
// over a class with NO rule is the BAND-panel incident — frontend.md §"A markup test proves classes
// are EMITTED, never STYLED"). Plain `.js` test so vitest collects it while tsc (allowJs off) skips
// it; no jsdom, because the seam is DOM-free.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  liveRules,
  nextVersion,
  validateRuleForm,
  ruleInsertRow,
  ruleCardHTML,
  ruleListHTML,
  rulesUrl,
  ruleInsertUrl,
} from "./rules-view.js";

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const CSS = read("journal.css");
const SEAM = read("rules-view.js");
const SHELL = read("journal.js");

/** A trading_rules row shaped like the PostgREST select, one VERSION of a rule. */
const versionRow = (over = {}) => ({
  id: "id-1",
  user_id: "u-1",
  rule_key: "k-1",
  version: 1,
  mistake: "",
  cost: "",
  rule: "hold through a dip",
  tags: [],
  retired: false,
  source: "own",
  source_key: null,
  created_at: "2026-01-01T09:00:00Z",
  ...over,
});

describe("liveRules - fold the version history into the live list", () => {
  it("takes the HIGHEST version's wording for a key with three versions", () => {
    const rows = [
      versionRow({ rule_key: "k", version: 1, rule: "v1 wording", created_at: "2026-01-01T00:00:00Z" }),
      versionRow({ rule_key: "k", version: 2, rule: "v2 wording", created_at: "2026-02-01T00:00:00Z" }),
      versionRow({ rule_key: "k", version: 3, rule: "v3 wording", created_at: "2026-03-01T00:00:00Z" }),
    ];
    const live = liveRules(rows);
    expect(live).toHaveLength(1);
    // THE MAX-VERSION FALSIFIER: flip liveRules' `version > live.version` to `<` and this reddens to
    // "v1 wording". The live wording is the newest revision, never the first.
    expect(live[0].rule).toBe("v3 wording");
    expect(live[0].version).toBe(3);
  });

  it("drops a key whose LIVE version is retired (un-retire is out of scope)", () => {
    const rows = [
      versionRow({ rule_key: "keep", version: 1, rule: "still live" }),
      versionRow({ rule_key: "gone", version: 1, rule: "original" }),
      versionRow({ rule_key: "gone", version: 2, rule: "retired wording", retired: true }),
    ];
    const live = liveRules(rows);
    expect(live.map((r) => r.rule_key)).toEqual(["keep"]);
    // A retired LIVE version hides the whole key, even though v1 was not retired.
    expect(JSON.stringify(live)).not.toContain("retired wording");
  });

  it("keeps a key whose v1 was retired but was later revised back to live", () => {
    // The retire flag is read off the LIVE (highest) version only: an earlier retired version does
    // not suppress a key that a later version brought back.
    const rows = [
      versionRow({ rule_key: "k", version: 1, rule: "first", retired: true }),
      versionRow({ rule_key: "k", version: 2, rule: "revived", retired: false }),
    ];
    expect(liveRules(rows).map((r) => r.rule)).toEqual(["revived"]);
  });

  it("orders newest-first by the FIRST version's created_at, not the live version's", () => {
    // `older` was first written 2026-01-01 then revised LATE (2026-09-01); `newer` was first written
    // 2026-06-01. Sorting by the live version would put `older` on top; sorting by v1 keeps `newer`
    // first. The fixture's late revision is what discriminates the two sort keys.
    const rows = [
      versionRow({ rule_key: "older", version: 1, rule: "older v1", created_at: "2026-01-01T00:00:00Z" }),
      versionRow({ rule_key: "older", version: 2, rule: "older v2", created_at: "2026-09-01T00:00:00Z" }),
      versionRow({ rule_key: "newer", version: 1, rule: "newer v1", created_at: "2026-06-01T00:00:00Z" }),
    ];
    expect(liveRules(rows).map((r) => r.rule_key)).toEqual(["newer", "older"]);
  });

  it("returns an empty list on no rows, never throws", () => {
    expect(liveRules([])).toEqual([]);
    expect(liveRules(null)).toEqual([]);
    expect(liveRules(undefined)).toEqual([]);
  });
});

describe("nextVersion - the version an insert must claim", () => {
  const rows = [
    versionRow({ rule_key: "k", version: 1 }),
    versionRow({ rule_key: "k", version: 2 }),
    versionRow({ rule_key: "other", version: 5 }),
  ];

  it("is max(version) + 1 for an existing key", () => {
    expect(nextVersion(rows, "k")).toBe(3);
  });

  it("is 1 for a brand-new key", () => {
    expect(nextVersion(rows, "brand-new")).toBe(1);
    expect(nextVersion([], "k")).toBe(1);
    expect(nextVersion(null, "k")).toBe(1);
  });

  it("does not let another key's versions leak into the count", () => {
    // `other` sits at v5; it must not push `k`'s next version past 3.
    expect(nextVersion(rows, "k")).toBe(3);
  });
});

describe("validateRuleForm - a non-empty rule is the only hard requirement", () => {
  it("accepts a form whose only filled field is the rule", () => {
    expect(validateRuleForm({ rule: "cut losers fast" })).toEqual({ ok: true });
    expect(validateRuleForm({ rule: "cut losers fast", mistake: "", cost: "", tags: "" })).toEqual({ ok: true });
  });

  it("rejects an empty or whitespace-only rule", () => {
    for (const bad of ["", "   ", null, undefined]) {
      const out = validateRuleForm({ rule: bad });
      expect(out.ok, `${JSON.stringify(bad)} must not pass as a rule wording`).toBe(false);
      expect(out.errors.length).toBeGreaterThan(0);
    }
  });
});

describe("ruleInsertRow - the exact snake_case PostgREST object", () => {
  const fields = { mistake: " sold too early ", cost: " missed the recovery ", rule: " hold the dip ", tags: "vix, fear , " };

  it("emits exactly the writable columns, snake_case, with source own and source_key null", () => {
    const row = ruleInsertRow(fields, "u-1", "k-9", 2);
    expect(Object.keys(row).sort()).toEqual(
      ["cost", "mistake", "retired", "rule", "rule_key", "source", "source_key", "tags", "user_id", "version"].sort(),
    );
    expect(row).toMatchObject({
      user_id: "u-1",
      rule_key: "k-9",
      version: 2,
      mistake: "sold too early",
      cost: "missed the recovery",
      rule: "hold the dip",
      retired: false,
      source: "own",
      source_key: null,
    });
    // The catalog columns ship now but slice 1 always writes its own rule with no source key.
    expect(row.source).toBe("own");
    expect(row.source_key).toBeNull();
  });

  it("splits the tags string into a trimmed, non-empty text[]", () => {
    expect(ruleInsertRow(fields, "u-1", "k", 1).tags).toEqual(["vix", "fear"]);
    expect(ruleInsertRow({ rule: "x", tags: "" }, "u-1", "k", 1).tags).toEqual([]);
    expect(ruleInsertRow({ rule: "x", tags: ["a", " b ", ""] }, "u-1", "k", 1).tags).toEqual(["a", "b"]);
  });

  it("carries a retired flag when a retire revision passes one", () => {
    expect(ruleInsertRow({ rule: "x", retired: true }, "u-1", "k", 3).retired).toBe(true);
  });
});

describe("markup", () => {
  const rule = { rule: "hold <the> dip", mistake: "sold early", cost: "missed 12%", tags: ["vix", "<x>"] };

  it("escapes every user field a rule card renders", () => {
    const html = ruleCardHTML(rule);
    expect(html).toContain("hold &lt;the&gt; dip");
    expect(html).toContain("&lt;x&gt;");
    expect(html).not.toContain("<the>");
    expect(html).not.toContain("<x>");
  });

  it("omits the optional lines a rule leaves blank", () => {
    const html = ruleCardHTML({ rule: "just a rule" });
    expect(html).toContain("just a rule");
    expect(html).not.toContain("tr-mistake");
    expect(html).not.toContain("tr-cost");
    expect(html).not.toContain("tr-tags");
  });

  it("renders the empty state rather than an empty list", () => {
    expect(ruleListHTML([])).toContain("tr-empty");
    expect(ruleListHTML([])).not.toContain("<ul");
    expect(ruleListHTML(null)).toContain("tr-empty");
  });

  it("wraps the cards in a list", () => {
    const html = ruleListHTML([rule, { rule: "second" }]);
    expect(html).toContain('<ul class="tr-list">');
    expect(html).toContain("second");
  });
});

describe("endpoints", () => {
  const conn = { url: "https://a.b" };

  it("lists trading_rules oldest-first so the shell folds the full history", () => {
    const url = rulesUrl(conn);
    expect(url).toBe("https://a.b/rest/v1/trading_rules?select=*&order=created_at.asc");
  });

  it("inserts against the same table with no query", () => {
    expect(ruleInsertUrl(conn)).toBe("https://a.b/rest/v1/trading_rules");
  });
});

describe("the page-level invariant a markup pin cannot reach", () => {
  it("styles every class the seam emits", () => {
    const style = CSS;
    const emitted = [...SEAM.matchAll(/class="([a-z0-9 -]+)"/g)].flatMap((m) => m[1].split(/\s+/));
    expect(emitted.length, "the class scan must find classes, or this test is vacuous").toBeGreaterThan(4);
    for (const cls of new Set(emitted)) {
      // The trailing boundary is load-bearing: a bare `toContain(".tr-row")` would be satisfied by a
      // rule for `.tr-rowMUTANT`, so the parity check would pass over a renamed selector.
      expect(style, `.${cls} is emitted by rules-view.js with no rule in journal.css`).toMatch(
        new RegExp(`\\.${cls}(?![a-zA-Z0-9_-])`),
      );
    }
  });
});

// The shell's own double-submit guard. Not a seam concern — saveRule() mints a fresh rule_key per
// call, so two in-flight saves take DIFFERENT keys, both claim version 1, and never collide on
// `unique (user_id, rule_key, version)`. The 409-reload path cannot see that, and slice 1 has no
// retire control, so a duplicate is unremovable. Source-scanned because journal.js has no jsdom test.
describe("journal.js shell: rule-save double-submit guard", () => {
  it("disables #rule-save for the duration of the save, and re-enables it in a finally", () => {
    const body = SHELL.slice(SHELL.indexOf("async function saveRule()"));
    const guard = body.slice(0, body.indexOf("async function saveRuleOnce()"));
    expect(guard, "saveRule() must re-enter-guard on the button's own disabled flag").toMatch(
      /if\s*\(\s*btn\.disabled\s*\)\s*return/,
    );
    expect(guard, "the guard must be set BEFORE the first await").toMatch(/btn\.disabled\s*=\s*true/);
    expect(guard, "a throw must not leave the button dead — re-enable in a finally").toMatch(
      /finally\s*\{[^}]*btn\.disabled\s*=\s*false/,
    );
  });
});
