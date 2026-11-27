/**
 * Policy truth table for the mobile help decoration (help-decorate.js) — the tap-first /lab page
 * against the unchanged dashboard. DOM-free: needsGlyph takes the booleans decorateHelp derives per
 * element, so every row here is the policy itself, not a jsdom render.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  HELP_CARVEOUT_SELECTOR,
  HELP_GLYPH_KEEP_SELECTOR,
  HELP_TAP_PRIORITY_SELECTOR,
  needsGlyph,
} from "./help-decorate.js";

describe("needsGlyph - policy truth table", () => {
  it("flagless page (neither root carries data-help - the legacy call shape): glyph on, carve-out/decorated off", () => {
    // Both pages are tap-first now; the flag defaults still define the policy for a titled
    // fragment outside a data-help root, and decorateHelp derives them per write.
    expect(needsGlyph({ isCarveOut: false, alreadyDecorated: false })).toBe(true);
    expect(needsGlyph({ isCarveOut: true, alreadyDecorated: false })).toBe(false);
    expect(needsGlyph({ isCarveOut: false, alreadyDecorated: true })).toBe(false);
  });

  it("dashboard is tap-first DOM-side: index.html's #dashboard root carries data-help", () => {
    // The policy flags above only fire off the DOM marker — without this pin index.html could
    // drop (or never gain) data-help and every selector-set entry would silently go glyph-mode.
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    expect(html).toMatch(/<main id="dashboard"[^>]*data-help="tap-first"/);
  });

  it("tap-first page: NO glyph anywhere except the irreducible keepsGlyph hosts", () => {
    const base = { isCarveOut: false, alreadyDecorated: false, tapFirstPage: true };
    expect(needsGlyph({ ...base })).toBe(false);
    expect(needsGlyph({ ...base, keepsGlyph: true })).toBe(true);
    // keepsGlyph never overrides the other suppressors.
    expect(needsGlyph({ ...base, keepsGlyph: true, isCarveOut: true })).toBe(false);
    expect(needsGlyph({ ...base, keepsGlyph: true, alreadyDecorated: true })).toBe(false);
  });
});

describe("selector membership - the census classification", () => {
  const carve = HELP_CARVEOUT_SELECTOR.split(", ");
  const pri = HELP_TAP_PRIORITY_SELECTOR.split(", ");

  it("a member leg chip is carved MODE-GATED - help in Live, cycle in Scenario (#39 ruling superseded 2026-08-31)", () => {
    // The member chip `.tile .ids [data-id][title]` is the one carve-out host with a COMPETING
    // ACTION (`lab.js` onClick -> cycleMember) — but it owns that action in ONE mode only:
    // `lab.js:584` writes `clickable` onto the tile just for `d.mode === "scenario"`. So the chip
    // is carved through `.tile:not(.clickable)`, which fires in Live and cannot match in Scenario —
    // the #39 dual-fire (help AND cycle on one tap) stays structurally impossible. It still may not
    // enter help-priority: that branch stopPropagations and would kill tap-cycling outright.
    // Asserted on the selector STRINGS (this file is DOM-free by design, header docblock). The
    // click-time behaviour itself is NOT unit-tested anywhere: there is no jsdom in this repo
    // (`inline-pos.test.js:11`), so nothing here can prove a tap opens the bar.
    expect(pri.some((s) => s.includes("data-id"))).toBe(false);
    expect(carve.filter((s) => s.includes(".ids"))).toEqual([
      ".tile .ids [title]:not([data-id])",
      ".tile:not(.clickable) .ids [title][data-id]",
    ]);
    // Non-vacuity: the leg strip is NOT simply unhosted — its group label still sits in both
    // branches, so a wholesale deletion of the `.tile .ids` zone could not pass this test.
    expect(pri).toContain(".tile .ids .lg-l[title]");
  });

  it("dashboard pass-through carve-out covers the census table's zone-A/C/D + panel-label hosts", () => {
    for (const sel of [
      "#zone-a .alert-chip[title]",
      "#zone-a .verdict-title[title]",
      "#zone-a .verdict-subline [title]",
      "#zone-c h2[title]",
      "#zone-c .chan-title[title]",
      "#zone-c .chan-lag[title]",
      "#zone-c .combo-label[title]",
      "#zone-d .ctl-label[title]",
      "#dashboard .bottom-label[title]",
      "#dashboard .pension-label[title]",
      "#dashboard .slow-label[title]",
      "#dashboard .pension-dd[title]",
      "#dashboard .pension-sleeves[title]",
      "#dashboard .pension-comparators[title]",
    ])
      expect(carve).toContain(sel);
    // Card children must NOT be pass-through: that branch skips stopPropagation, so a tap
    // would also fire onCardActivate (same dual-fire the tile hosts dodge below).
    expect(carve).not.toContain("#dashboard .card .card-label[title]");
    expect(carve).not.toContain("#dashboard .card .card-delta[title]");
  });

  it("pass-through carve-out gained the census hosts and kept the original three zones", () => {
    for (const sel of [
      "#dangerField [title]",
      "#rrgQuadrant [title]",
      "#boardLag [title]",
      "#bandPanelHost [title]",
      "#smGridWrap [title]",
      "#sbBody .sb-na[title]",
    ])
      expect(carve).toContain(sel);
    // Help-priority hosts must NOT be pass-through: that branch skips stopPropagation, so a tap
    // would also fire the tile's cycle action (`.lg-l` nests inside the carved `.ids` zone by
    // design — the priority branch runs first and cures that dual fire).
    expect(carve).not.toContain(".tile .t-h[title]");
    expect(carve).not.toContain(".tile .fam-lag[title]");
  });

  it("glyph-keep stays disjoint from both tap selectors", () => {
    const keep = HELP_GLYPH_KEEP_SELECTOR.split(", ");
    expect(keep.length).toBeGreaterThan(0); // non-vacuity: the keep set really has entries
    for (const sel of keep) {
      expect(carve).not.toContain(sel);
      expect(pri).not.toContain(sel);
    }
  });

  // `decorateHelp` appends the ⓘ as a CHILD of the titled host, and a `<select>` renders no child
  // but `option`/`optgroup` — measured 0×0 by `npm run preview:mobile-audit`, i.e. a DOM node that
  // certifies the tooltip as covered while being untappable. The three Zone-D pickers carry their
  // tooltip on the adjacent `.ctl-label` (a carve-out host) instead, and none of the three may
  // reappear here. Source-level because the selector set is where the mistake gets made.
  it("no `<select>` is in the glyph-keep set - its ⓘ would be an unrenderable 0x0 phantom", () => {
    for (const sel of ["ind-picker", "ind-picker-compare", "leg-picker"]) {
      expect(HELP_GLYPH_KEEP_SELECTOR, `.${sel} is a <select> and can never host a glyph`).not.toContain(sel);
    }
    // …and the selects really did give their `title=` up, so nothing is left with no mobile path.
    const app = readFileSync(fileURLToPath(new URL("./app.js", import.meta.url)), "utf8");
    for (const m of app.matchAll(/<select class="([\w-]+)"[^>]*>/g)) {
      expect(m[0], `<select class="${m[1]}"> must carry no title= (its .ctl-label does)`).not.toContain("title=");
    }
  });
});

describe("member leg chip - the LIVE-mode footnote needs its own iOS unblocker ([USER] 2026-08-31)", () => {
  // The selector membership above is necessary but NOT sufficient. /lab is tap-first, and on iOS a
  // click only delegates to the document-level capture handler when the host looks clickable —
  // `cursor: pointer` is that unblocker. A member chip's ONLY other source of it is
  // `.tile.clickable .ids [data-id]` (lab.css ~462), which is the SCENARIO cycle affordance and is
  // absent in Live. So without a mode-matched cursor rule the carve-out entry would be inert on a
  // phone in exactly the mode it was added for — a fix that passes every selector test and still
  // does nothing on the reported device. Comments are stripped first: this rule DOCUMENTS its own
  // selector in prose, and a raw-text match would pass off the comment alone.
  const css = readFileSync(fileURLToPath(new URL("./lab.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("lab.css gives the Live-mode chip `cursor: pointer` from the tap-readable block", () => {
    expect(css).toMatch(/\.tile:not\(\.clickable\) \.ids \[title\]\[data-id\],[\s\S]{0,400}?cursor: pointer;/);
  });

  it("the cursor rule is MODE-GATED, never a blanket chip rule", () => {
    // A blanket `.tile .ids [data-id][title] { cursor: pointer }` would also pass the test above by
    // matching the carve-out's intent loosely; it is not the same contract, because the Scenario
    // chip must keep its cycle affordance as the source of its pointer, not borrow a help one.
    expect(css).not.toMatch(/^\s*\.tile \.ids \[data-id\]\[title\],[\s\S]{0,400}?cursor: pointer;/m);
    // Non-vacuity: the Scenario cycle rule must still be there — if it vanished, the assertion
    // above would pass for the wrong reason (no chip pointer rule at all).
    expect(css).toMatch(/\.tile\.clickable \.ids \[data-id\] \{[\s\S]{0,120}?cursor: pointer;/);
  });

  it("the phone hit box stays mode-agnostic - both modes tap the same ≥24px target", () => {
    // Deliberately NOT split by mode: the chip is a tap target in Live (footnote) and in Scenario
    // (cycle), so one rule serves both. A `:not(.clickable)` here would shrink the Scenario target.
    expect(css).toMatch(/max-width: 640px\)[\s\S]*?\.tile \.ids \[data-id\]\[title\] \{[\s\S]{0,120}?padding: 7px 6px;/);
  });
});
