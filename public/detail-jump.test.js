// Pure policy tests for the chip → Indicator detail jump (detail-jump.js), plus the source pins
// that keep help-bar.js's optional `detailAction`/`onDetail` seam wired. DOM-free (no jsdom in
// this suite): a host is a stub with matches/dataset/textContent.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CHIP_SELECTOR, chipDetailTarget, deepLinkIndicatorId, detailJumpUrl } from "./detail-jump.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const chip = (id, text = id, matches = true) => ({
  matches: (sel) => matches && sel === CHIP_SELECTOR,
  dataset: { id },
  textContent: ` ${text} `,
});
const METAS = [
  { id: "F1", label: "HY OAS" },
  { id: "DB_SMH", label: "" },
];

describe("chipDetailTarget", () => {
  it("non-chip host ⇒ null (a ⓘ glyph, a ledger cell, a band floor never offers a jump)", () => {
    expect(chipDetailTarget(chip("F1", "HY OAS", false))).toBeNull();
    expect(chipDetailTarget(null)).toBeNull();
    expect(chipDetailTarget({ matches: () => true, dataset: {} })).toBeNull(); // chip without an id
  });

  it("with metas (/overview): served id ⇒ {id, label}; label falls back to the id; unknown id ⇒ null", () => {
    expect(chipDetailTarget(chip("F1"), { metas: METAS })).toEqual({ id: "F1", label: "HY OAS" });
    expect(chipDetailTarget(chip("DB_SMH"), { metas: METAS })).toEqual({ id: "DB_SMH", label: "DB_SMH" });
    expect(chipDetailTarget(chip("NOPE"), { metas: METAS })).toBeNull();
  });

  it("without metas (/lab): the chip's own trimmed text is the label", () => {
    expect(chipDetailTarget(chip("F1", "HY OAS"))).toEqual({ id: "F1", label: "HY OAS" });
    expect(chipDetailTarget(chip("F1", ""))).toEqual({ id: "F1", label: "F1" });
  });

  it("scenario ⇒ null regardless of the host", () => {
    expect(chipDetailTarget(chip("F1"), { scenario: true })).toBeNull();
    expect(chipDetailTarget(chip("F1"), { metas: METAS, scenario: true })).toBeNull();
  });
});

describe("deep link", () => {
  it("url encodes the id and anchors Zone D on the dashboard", () => {
    expect(detailJumpUrl("F1")).toBe("/?ind=F1#zone-d");
    expect(detailJumpUrl("a b")).toBe("/?ind=a%20b#zone-d");
  });

  it("intake: a served id selects; unknown / absent / malformed ⇒ null, never a throw", () => {
    expect(deepLinkIndicatorId("?ind=F1", METAS)).toBe("F1");
    expect(deepLinkIndicatorId("?x=1&ind=F1", METAS)).toBe("F1");
    expect(deepLinkIndicatorId("?ind=NOPE", METAS)).toBeNull();
    expect(deepLinkIndicatorId("", METAS)).toBeNull();
    expect(deepLinkIndicatorId(undefined, METAS)).toBeNull();
    expect(deepLinkIndicatorId("?ind=F1", null)).toBeNull();
  });
});

describe("help-bar.js seam pins (source-level - the sheet renders in the browser, not here)", () => {
  const src = read("./help-bar.js");
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  it("the carve-out branch (the one a member chip fires) forwards the resolved target", () => {
    expect(code).toMatch(/showHelp\(tick\.getAttribute\("title"\) \|\| "", opts\.detailAction\?\.\(tick\)\)/);
  });

  it("an action-row tap closes the sheet and hands the id to the page's onDetail", () => {
    expect(code).toMatch(/closest\("\.help-bar-action"\)/);
    expect(code).toMatch(/opts\.onDetail\?\.\(/);
  });

  it("the dashboard caller passes no options - no row can ever render there", () => {
    const app = read("./app.js");
    expect(app).toMatch(/^wireHelpBar\(els\.dashboard, els\.helpBar\);/m);
  });
});
