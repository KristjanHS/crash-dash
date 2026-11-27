// The section-title tooltips of the two `.lab` shells (/lab and /overview): a `title=` alone is
// DESKTOP-ONLY on either page. Both are tap-first
// (`data-help="tap-first"`, so decorateHelp injects no ⓘ), which means a tooltip is reachable on a
// phone only when its host is listed in HELP_CARVEOUT_SELECTOR — and the host is matched by the
// `sec-tip` CLASS, which the render site must emit next to the title. Three pieces, five files: the
// copy (section-tips.js), the class on the host (five render files), the selector entry
// (help-decorate.js) and the tap cue + hit box (lab.css). Any one missing ships a hover-only tooltip
// that no markup test sees, so this file pins all four together.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SECTION_TIP, secTip } from "./section-tips.js";
import { HELP_CARVEOUT_SELECTOR, HELP_GLYPH_KEEP_SELECTOR, needsGlyph } from "./help-decorate.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Every heading that owes a tooltip → the file it is rendered from, and the class its host carries. */
const SITES = {
  chain: { file: "band-panel.js", cls: "bp-chain" },
  floors: { file: "band-panel.js", cls: "bp-floors-title" },
  families: { file: "families-board.js", cls: "lg-sectag" },
  dangerLedger: { file: "lab-board.js", cls: "df-title" },
  methodCards: { file: "lab.js", cls: "rd-title" },
  structureMap: { file: "lab.js", cls: "sm-title" },
  rotationQuadrant: { file: "lab-board.js", cls: "rrg-title" },
  indicatorDetail: { file: "overview.js", cls: "zd-title" },
  scoreboard: { file: "scoreboard-card.js", cls: "sb-title" },
};

describe("section tooltips - roster", () => {
  it("covers exactly the nine headings, each a real explain-and-how-to-read sentence", () => {
    expect(Object.keys(SECTION_TIP).sort()).toEqual(Object.keys(SITES).sort());
    for (const [k, tip] of Object.entries(SECTION_TIP)) {
      // Long enough to say what the section is AND how to read it — a bare label is not a tooltip.
      expect(tip.length, `${k} is too short to explain a section`).toBeGreaterThan(160);
      // A raw `"` would close the attribute it is interpolated into; `esc` covers it, but the copy
      // rule keeps them out so the rendered title never carries `&quot;` noise.
      expect(tip, `${k} must not contain a double quote`).not.toContain('"');
    }
  });

  it("secTip emits an escaped attribute, and nothing at all for an unknown key", () => {
    expect(secTip("chain")).toBe(` title="${SECTION_TIP.chain}"`);
    expect(secTip("nope")).toBe("");
  });
});

describe("section tooltips - wiring (the mobile path)", () => {
  it("every heading emits its tip AND the sec-tip class, at the site that owns it", () => {
    for (const [key, { file, cls }] of Object.entries(SITES)) {
      const src = read(`./${file}`);
      // The class and the title are emitted on ONE element: `class="… <cls> sec-tip"…${secTip(key)}`.
      const re = new RegExp(`class="[^"]*\\b${cls}\\b[^"]*\\bsec-tip"\\$\\{secTip\\("${key}"\\)\\}`);
      expect(src, `${file} must render ${key} on .${cls} with the sec-tip class`).toMatch(re);
      expect(src).toMatch(/import \{ secTip \} from "\.\/section-tips\.js";/);
    }
  });

  it("the sec-tip host is tap-readable on BOTH .lab shells, and stays glyphless", () => {
    // CLASS-scoped: /overview reuses these renderers, and an `#lab` entry left every /overview
    // heading hover-only (the families tag, the floors title, the ledger title, the new detail one).
    expect(HELP_CARVEOUT_SELECTOR).toContain(".lab .sec-tip[title]");
    expect(HELP_CARVEOUT_SELECTOR).not.toContain("#lab .sec-tip[title]");
    for (const html of ["lab.html", "overview.html"]) {
      expect(read(`./${html}`), `${html} must host its sections in a .lab shell`).toMatch(
        /<main id="(?:lab|overview)" class="lab" data-help="tap-first"/,
      );
    }
    // The carve-out branch is what suppresses the glyph; a section heading is the one place a ⓘ
    // would sit between the eye and the section name.
    expect(needsGlyph({ isCarveOut: true, alreadyDecorated: false, tapFirstPage: true, keepsGlyph: false })).toBe(false);
    expect(HELP_GLYPH_KEEP_SELECTOR).not.toContain("sec-tip");
  });

  it("lab.css gives it the iOS pointer unblocker, a tap cue, and a phone hit box", () => {
    const css = read("./lab.css").replace(/\/\*[\s\S]*?\*\//g, "");
    // `cursor: pointer` is the iOS click-delegation unblocker — without it the capture handler
    // never sees the tap on a phone. `.lab`, not `#lab`, so /overview's headings get it too.
    expect(css).toMatch(/\.lab \.sec-tip\[title\],[\s\S]{0,400}?cursor: pointer;/);
    // A cue, so the tooltip is discoverable: dotted underline on the text hosts, bg tint on the
    // bordered chain strip.
    expect(css).toMatch(/\.lab h2\.sec-tip\[title\][\s\S]{0,200}?text-decoration: underline dotted/);
    expect(css).toMatch(/\.lab \.bp-chain\.sec-tip\[title\][\s\S]{0,200}?linear-gradient/);
    // `.lg-sectag` is pointer-events:none by default and 0.5rem tall — it needs both back.
    expect(css).toMatch(/\.lab \.lg-sectag\.sec-tip\[title\][\s\S]{0,120}?pointer-events: auto;/);
    expect(css).toMatch(/max-width: 640px\)[\s\S]{0,200}?\.lab \.sec-tip\[title\][\s\S]{0,120}?padding-block: 6px;/);
    // That blanket rule is (0,3,0) and outranks every heading's own (0,1,0) BLOCK spacing, so the
    // two headings that declare any must re-state it folded into the ±6px pair — otherwise the
    // phone loses `.rd-title`'s 12px top gap and `.rrg-title`'s 4px gap to its note. Measured with
    // a 390px playwright pass: text 12px inside the reader border, 4px title→note.
    expect(css).toMatch(/\.lab \.rd-title\.sec-tip\[title\] \{\s*padding-block: 12px 6px;\s*margin-block: 0 -6px;/);
    expect(css).toMatch(/\.lab \.rrg-title\.sec-tip\[title\] \{\s*margin-block: -6px -2px;/);
    // The tag is absolutely positioned at `top: 3px` into a 16px pad — it grows DOWNWARD only, or
    // its hit box overhangs the board's own border and steals taps from content scrolling under it.
    expect(css).toMatch(/\.lab \.lg-sectag\.sec-tip\[title\] \{\s*padding: 3px 10px 14px;\s*margin: -3px -10px -14px;/);
  });
});

describe("lab landing view", () => {
  it("shows the floors strip, the families board and the danger ledger - nothing else - to a new user", () => {
    const src = read("./lab.js");
    const block = src.slice(src.indexOf("const VIS_DEFAULTS"), src.indexOf("const VIS_HIDEABLE"));
    for (const mode of ["live", "scenario"]) {
      expect(block, `${mode} default`).toContain(
        `${mode}: { familiesBoard: true, cards: false, dangerField: true, structureMap: false, rrgQuadrant: false, scoreboard: false, reentry: false }`,
      );
    }
    // The floors strip has no visibility chip at all — it is always in the bench, its own
    // `floors ▸` disclosure collapsed, so the landing shows just its status (chain) line.
    expect(src).toContain('<section class="band-panel-host" id="bandPanelHost"');
    expect(read("./band-panel.js")).toMatch(/class="bp-floors-toggle" aria-expanded="false"/);
    // …and it is TITLED: the heading is a separate element from the button, so a phone tap on the
    // footnote host never also toggles the disclosure (help-bar.js's capture handler).
    expect(read("./band-panel.js")).toMatch(/<h2 class="bp-floors-title sec-tip"/);
  });
});
