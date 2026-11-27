// Display-only board-tile seams (no jsdom). Pure-logic tests over the seams lab.js uses in
// buildTiles/applyBoard: the role-sectioned chip strips + the awaiting-feed stub copy.
import { describe, it, expect } from "vitest";
import {
  tileEmptyCopy,
  DEPTH_TREND_IDS,
  SLOW_VOLATILITY_IDS,
  tileMemberGroups,
  cannotArmMarkText,
  memberTone,
  TONE_CLASS,
  isNoArmFamily,
  NO_ARM_TITLE,
  CANNOT_ARM_TITLE,
  deadLitMarkHtml,
  DEAD_TITLE,
  LIVE_DEAD_TITLE,
  deadLitIds,
  DEAD_NOTE,
  dialLiveIdsOf,
} from "./tile-members.js";
import { LEG_WEIGHTED_IDS, NO_ARM_FAMILIES, memberTone as memberToneTs } from "../src/t1dial";
// Extensionless on purpose — a `.js` specifier in a plain `.test.js` fails to resolve the TS source
// and the suite reports "no tests" (`.claude/rules/frontend.md`). Imported rather than re-typed so
// the pins below read the ONE source of truth.
import { GLOBAL_FAMILIES, COINCIDENT_TREND_MEMBERS, PER_LEG_ONLY_MEMBERS, computeFamilyPanel, computeFamilyPanelFromStates } from "../src/families";
import { DIAL_FAMILIES } from "../src/danger-ladder";
import { SLOW_INDICATOR_IDS } from "../src/registry-price";
import { PILLAR_MEMBER_IDS } from "../src/danger-engine";
import { readFileSync } from "node:fs";
import { dangerModelView } from "../src/api/meta-views";

describe("tileEmptyCopy (rung-3 stub reason)", () => {
  it("prefixes the family's `awaiting` reason when one is set", () => {
    expect(tileEmptyCopy({ key: "valuation", awaiting: "no keyless source." })).toBe(
      "awaiting feed - no keyless source.",
    );
  });

  it("keeps the legacy copy verbatim when `awaiting` is absent (every live family)", () => {
    expect(tileEmptyCopy({ key: "credit" })).toBe("no live feed");
  });

  it("treats an empty `awaiting` as absent - never a dangling 'awaiting feed - '", () => {
    expect(tileEmptyCopy({ key: "valuation", awaiting: "" })).toBe("no live feed");
  });
});

// ── role-sectioned chip strips ───────────────────────
const mk = (...ids) => ids.map((id) => ({ id, state: "GREEN" }));

describe("the hand-copied mirrors match their server constants", () => {
  // The FE cannot import the TS sources at runtime, so both discriminator sets are hand-copied —
  // these pins are the only thing stopping a server-side membership change from leaving a tile
  // mislabelled (the hand-typed-mirror defect class, testing-project.md). RED-DEMO: dropping GB
  // from the trend depth set, or complacency-high from the SLOW set, reds this.
  it("DEPTH_TREND_IDS is exactly COINCIDENT_TREND_MEMBERS", () => {
    expect([...DEPTH_TREND_IDS].sort()).toEqual([...COINCIDENT_TREND_MEMBERS].sort());
  });

  it("SLOW_VOLATILITY_IDS is exactly SLOW_INDICATOR_IDS", () => {
    expect([...SLOW_VOLATILITY_IDS].sort()).toEqual([...SLOW_INDICATOR_IDS].sort());
  });
});

describe("tileMemberGroups (one tile, chips sectioned by role)", () => {
  it("splits the LIVE trend roster into band + depth, band-driving, then per-leg off the SERVED band.ids", () => {
    // Roster AND band seat come from the real producer, not hand-typed: `computeFamilyPanel` emits the
    // `f.band.ids` /lab serves, so a `BAND_DRIVING.trend` change moves this pin with it.
    const served = computeFamilyPanel(mk(...GLOBAL_FAMILIES.find((f) => f.key === "trend").ids), GLOBAL_FAMILIES)
      .families.find((f) => f.key === "trend");
    const ids = served.members.map((m) => m.id);
    const bandIds = served.band.ids;
    const groups = tileMemberGroups(served, mk(...ids));
    expect(groups.map((g) => g.key)).toEqual(["depth", "band", "per-leg"]);
    expect(groups.map((g) => g.label)).toEqual(["band + depth", "band-driving", "per-leg only"]);
    expect(groups[0].members.map((m) => m.id)).toEqual(ids.filter((i) => DEPTH_TREND_IDS.has(i)));
    expect(groups[1].members.map((m) => m.id)).toEqual(ids.filter((i) => bandIds.includes(i) && !DEPTH_TREND_IDS.has(i)));
    expect(groups[2].members.map((m) => m.id)).toEqual(ids.filter((i) => !bandIds.includes(i)));
    // The "never move the dial" copy holds only while every off-band trend id is a (trend) PER_LEG_ONLY_MEMBERS id.
    expect(groups[2].members.map((m) => m.id).sort()).toEqual(PER_LEG_ONLY_MEMBERS.filter((i) => ids.includes(i)).sort());
    // Both groups are non-empty on the live roster — otherwise the seam would return null and
    // the whole grouping would be dead on the real board while these pins stayed green.
    expect(groups.every((g) => g.members.length > 0 && g.label && g.title)).toBe(true);
  });

  it("splits the LIVE volatility roster into band-driving then bubble watch, EVERY served member kept", () => {
    // The regression this guards is the retired prune: under it the 4 SLOW legs never reached the
    // strip (and the volatility tile had no grouping at all), so the family could sit AMBER over
    // an all-green chip row with the amber member invisible.
    const ids = GLOBAL_FAMILIES.find((f) => f.key === "volatility").ids;
    const groups = tileMemberGroups({ key: "volatility" }, mk(...ids));
    expect(groups.map((g) => g.key)).toEqual(["band", "bubble"]);
    expect(groups.map((g) => g.label)).toEqual(["band-driving", "bubble watch"]);
    expect(groups[0].members.map((m) => m.id)).toEqual(ids.filter((i) => !SLOW_VOLATILITY_IDS.has(i)));
    expect(groups[1].members.map((m) => m.id)).toEqual(ids.filter((i) => SLOW_VOLATILITY_IDS.has(i)));
    expect(groups.flatMap((g) => g.members).length).toBe(ids.length);
    expect(groups.every((g) => g.members.length > 0 && g.label && g.title)).toBe(true);
  });

  it("splits the LIVE valuation roster into weighted ECY then context breakevens, served order preserved", () => {
    const ids = GLOBAL_FAMILIES.find((f) => f.key === "valuation").ids;
    const groups = tileMemberGroups({ key: "valuation" }, mk(...ids));
    expect(groups.map((g) => g.key)).toEqual(["weighted", "context"]);
    expect(groups[0].members.map((m) => m.id)).toEqual(["ECY"]);
    expect(groups[1].members.map((m) => m.id)).toEqual(["T5YIFR", "T10YIE"]);
    // Both non-empty on the live roster — else the seam returns null and the grouping is dead on the board.
    expect(groups.every((g) => g.members.length > 0 && g.label && g.title)).toBe(true);
  });

  it("returns null for any other family, so every other tile keeps the flat strip", () => {
    expect(tileMemberGroups({ key: "cross-asset" }, mk("CG", "FXH"))).toBeNull();
    expect(tileMemberGroups(null, mk("GT"))).toBeNull();
  });

  it("credit sections off the SERVED band.ids, never a constant - CQS seat follows the day", () => {
    const ids = ["F1", "EBP", "F3", "F2", "BONOS", "BUND", "F10", "CQS", "F13"];
    const fresh = tileMemberGroups({ key: "credit", band: { ids: ["F1", "EBP", "F3", "F2"] } }, mk(...ids));
    expect(fresh.map((g) => g.members.map((m) => m.id))).toEqual([
      ["F1", "EBP", "F3", "F2"],
      ["BONOS", "BUND", "F10", "CQS", "F13"],
    ]);
    // EBP stale/absent (R3) => CQS takes the seat and EBP drops to per-leg. A constant mirror
    // would put EBP in the band group on this exact payload, so this case is the falsifier.
    const bridged = tileMemberGroups({ key: "credit", band: { ids: ["F1", "CQS", "F3", "F2"] } }, mk(...ids));
    expect(bridged.map((g) => g.members.map((m) => m.id))).toEqual([
      ["F1", "F3", "F2", "CQS"],
      ["EBP", "BONOS", "BUND", "F10", "F13"],
    ]);
  });

  it("credit sections the SERVED perLegOnlyIds (AT1) as 'per-leg only' AHEAD of per-leg - never the 'can move the dial' copy", () => {
    // AT1 is PER_LEG_ONLY_MEMBERS (out of legP): under the per-leg group its hover would claim it can
    // still move the dial position. The set is the server's own, not hand-typed.
    const ids = ["F1", "EBP", "F3", "F2", "BONOS", "BUND", "F10", "CQS", "F13", "AT1"];
    const served = { key: "credit", band: { ids: ["F1", "EBP", "F3", "F2"] } };
    const groups = tileMemberGroups(served, mk(...ids), new Set(PER_LEG_ONLY_MEMBERS));
    expect(groups.map((g) => g.label)).toEqual(["band-driving", "per-leg only", "per-leg"]);
    expect(groups.map((g) => g.members.map((m) => m.id))).toEqual([
      ["F1", "EBP", "F3", "F2"],
      ["AT1"],
      ["BONOS", "BUND", "F10", "CQS", "F13"],
    ]);
    // Same copy as trend's per-leg-only group — one wording, never a second claim.
    const trend = tileMemberGroups({ key: "trend", band: { ids: ["GT", "GB", "F6"] } }, mk("GT", "GB", "F6", "KBE_RS"));
    expect(groups[1].title).toBe(trend[2].title);
    expect(groups.find((g) => g.members.some((m) => m.id === "AT1")).title).not.toMatch(/can still move the dial/);
  });

  it("trend sections off the SERVED band.ids, never a constant - a member leaving the seat goes per-leg", () => {
    const ids = ["GT", "GB", "SPCONC", "F6", "KBE_RS"];
    const groups = tileMemberGroups({ key: "trend", band: { ids: ["GT", "GB", "F6"] } }, mk(...ids));
    expect(groups.map((g) => g.members.map((m) => m.id))).toEqual([["GT", "GB"], ["F6"], ["SPCONC", "KBE_RS"]]);
  });

  it("credit degrades to the flat strip when the payload carries no band", () => {
    expect(tileMemberGroups({ key: "credit" }, mk("F1", "F2", "BUND"))).toBeNull();
  });

  it("returns null when either group would be EMPTY - no label over an unsplit strip", () => {
    const trendBand = { key: "trend", band: { ids: ["GT", "GB", "F4", "F6"] } };
    expect(tileMemberGroups(trendBand, mk("GT", "GB", "F4"))).toBeNull();
    expect(tileMemberGroups(trendBand, mk("F4", "F6", "KBE_RS"))).toBeNull();
    expect(tileMemberGroups(trendBand, [])).toBeNull();
    expect(tileMemberGroups({ key: "trend" }, mk("GT", "F4", "KBE_RS"))).toBeNull();
    expect(tileMemberGroups({ key: "volatility" }, mk("VT", "R5"))).toBeNull();
    expect(tileMemberGroups({ key: "volatility" }, mk("price-accel", "complacency-vix"))).toBeNull();
  });
});

describe("the grouping classes lab.js emits resolve to real selectors", () => {
  // A markup pin proves a class is EMITTED, never STYLED (testing-project.md) — `legStripHtml`
  // (lab.js) emits `.lg` / `.lg-l`, and without rules the sectioning paints as one unstyled
  // inline run, i.e. exactly the flat strip the grouping replaced.
  const html = readFileSync(new URL("./lab.css", import.meta.url), "utf8");
  it.each([".tile .ids .lg {", ".tile .ids .lg-l {"])("%s is styled in lab.css", (sel) => {
    expect(html).toContain(sel);
  });
});

// ── D3 member chip tone (family-colour-follows-danger) ───────────────────────
describe("memberTone (five tones off the SERVED rosters)", () => {
  const weighted = new Set(["ECY", "BUND"]); // a stand-in served set, NOT the live roster

  it("live = the member sits on the band ids (moves the band)", () => {
    expect(memberTone("F1", ["F1", "EBP"], weighted)).toBe("live");
    // On the band wins even when it also carries a weight row — live dominates leg-only.
    expect(memberTone("BUND", ["BUND"], weighted)).toBe("live");
  });

  it("leg-only = rowless of the band but in the served weighted set", () => {
    expect(memberTone("BUND", ["F1", "EBP"], weighted)).toBe("leg-only");
  });

  it("per-leg = in the served per-leg-only set, beating leg-only; the band still wins", () => {
    const perLeg = new Set(["BUND"]);
    expect(memberTone("BUND", ["F1"], weighted, perLeg)).toBe("per-leg");
    expect(memberTone("BUND", ["BUND"], weighted, perLeg)).toBe("live");
    expect(memberTone("ECY", ["F1"], weighted, perLeg)).toBe("leg-only");
  });

  it("grey = neither on the band nor in the served weighted set", () => {
    expect(memberTone("T10YIE", ["F1", "EBP"], weighted)).toBe("grey");
  });

  it("reads the PASSED set, never a hand list - a weighted id absent from the set greys out", () => {
    // The falsifier for a re-introduced literal roster: ECY is a real MEMBER_WEIGHT key, but the
    // function has no way to know that except the set it is handed. Pass an EMPTY set ⇒ grey.
    expect(memberTone("ECY", [], new Set())).toBe("grey");
    expect(memberTone("ECY", [], weighted)).toBe("leg-only");
  });

  it("dead = off-band and outside the served pillarIds, beating leg-only/grey; the band still wins; no set ⇒ never", () => {
    const pillar = new Set(["ECY"]);
    expect(memberTone("BUND", ["F1"], weighted, undefined, pillar)).toBe("dead"); // leg-only → dead
    expect(memberTone("T10YIE", ["F1"], weighted, undefined, pillar)).toBe("dead"); // grey → dead
    expect(memberTone("BUND", ["BUND"], weighted, undefined, pillar)).toBe("live");
    expect(memberTone("ECY", ["F1"], weighted, undefined, pillar)).toBe("leg-only");
    expect(memberTone("BUND", ["F1"], weighted, undefined, undefined)).toBe("leg-only"); // old payload
  });

  it("a not-in-pillar member on the DISPLAY band stays live only while it seats the dial band; pillar members ignore the dial set", () => {
    const pillar = new Set(["F1"]);
    expect(memberTone("R8", ["R8"], weighted, undefined, pillar, new Set(["R8"]))).toBe("live");
    expect(memberTone("R8", ["R8"], weighted, undefined, pillar, new Set())).toBe("dead");
    expect(memberTone("R8", ["R8"], weighted, undefined, pillar, undefined)).toBe("live"); // old payload
    expect(memberTone("F1", ["F1"], weighted, undefined, pillar, new Set())).toBe("live");
  });

  it("dialLiveIdsOf: dial band ids minus the served no-arm families; undefined without dialFamilies or a band", () => {
    const band = (ids) => ({ ids });
    const d = {
      dialFamilies: [{ key: "credit", band: band(["F1", "R8"]) }, { key: "valuation", band: band(["T10YIE"]) }],
      dangerRoster: { noArmFamilies: ["valuation"] },
    };
    expect([...dialLiveIdsOf(d)]).toEqual(["F1", "R8"]);
    expect(dialLiveIdsOf({ dangerRoster: d.dangerRoster })).toBeUndefined();
    expect(dialLiveIdsOf({ dialFamilies: [{ key: "credit" }] })).toBeUndefined();
  });

  it("over the REAL served bands: every shown not-in-pillar member reads dead (SLOW + valuation included), per-leg-only keeps per-leg", () => {
    // Bands come from the writer the payload serves: `globalFamilies` = the GLOBAL_FAMILIES panel,
    // `dialFamilies` = the DIAL_FAMILIES panel (`computeFamilyPanelFromStates`, the scenario producer).
    const display = computeFamilyPanelFromStates({}, GLOBAL_FAMILIES).families;
    const dial = computeFamilyPanelFromStates({}, DIAL_FAMILIES).families;
    const dialLive = dialLiveIdsOf({ dialFamilies: dial, dangerRoster: { noArmFamilies: [...NO_ARM_FAMILIES] } });
    const pillar = new Set(PILLAR_MEMBER_IDS);
    const perLeg = new Set(PER_LEG_ONLY_MEMBERS);
    const toneOf = new Map();
    for (const f of display) for (const m of f.members) toneOf.set(m.id, memberTone(m.id, f.band.ids, LEG_WEIGHTED_IDS, perLeg, pillar, dialLive));
    const displayBand = new Set(display.flatMap((f) => f.band.ids));
    // Precondition (the world the old `bandIds = []` fixture skipped): SLOW + valuation sit ON the display band.
    for (const id of [...SLOW_INDICATOR_IDS, "T5YIFR", "T10YIE"]) expect(displayBand.has(id), id).toBe(true);
    for (const id of [...SLOW_INDICATOR_IDS, "T5YIFR", "T10YIE"]) expect(toneOf.get(id), id).toBe("dead");
    const outside = [...toneOf.keys()].filter((id) => !pillar.has(id));
    expect(outside.length).toBeGreaterThan(0);
    for (const id of outside) expect(toneOf.get(id), id).toBe("dead");
    expect([...toneOf.values()]).toContain("live"); // non-vacuity: pillar band members still paint live
    const perLegShown = PER_LEG_ONLY_MEMBERS.filter((id) => toneOf.has(id));
    expect(perLegShown.length).toBeGreaterThan(0);
    for (const id of perLegShown) expect(toneOf.get(id), id).toBe("per-leg");
  });

  it("deadLitMarkHtml: the ⌁ carries the live copy on a band member, the dead copy otherwise, nothing inside/without the set", () => {
    const pillar = new Set(["F1"]);
    expect(deadLitMarkHtml("R8", "live", pillar)).toContain(`title="${LIVE_DEAD_TITLE}">⌁<`);
    expect(deadLitMarkHtml("R8", "dead", pillar)).toContain(`title="${DEAD_TITLE}">⌁<`);
    expect(deadLitMarkHtml("F1", "live", pillar)).toBe("");
    expect(deadLitMarkHtml("R8", "dead", undefined)).toBe("");
  });

  it("matches the TS memberTone (src/t1dial) byte-for-byte over the SERVED roster", () => {
    // Parity: the browser twin and the source of record agree for every weighted id + a grey one,
    // when the browser is handed the SAME served set. A drift in either reds this.
    const served = LEG_WEIGHTED_IDS;
    const perLeg = new Set(PER_LEG_ONLY_MEMBERS);
    for (const id of [...served, "T10YIE"]) {
      expect(memberTone(id, [], served, perLeg)).toBe(memberToneTs(id, []));
      expect(memberTone(id, [id], served, perLeg)).toBe(memberToneTs(id, [id]));
    }
  });

  it("TONE_CLASS maps every tone to a distinct chip class", () => {
    expect(new Set(Object.values(TONE_CLASS)).size).toBe(Object.keys(TONE_CLASS).length);
  });

  it("TONE_CLASS has a chip class for every tone memberTone returns (lab-board renders TONE_CLASS[memberTone(…)])", () => {
    const tones = [
      memberTone("F1", ["F1"], weighted),
      memberTone("BUND", ["F1"], weighted),
      memberTone("BUND", ["F1"], weighted, new Set(["BUND"])),
      memberTone("T10YIE", ["F1"], weighted),
      memberTone("T10YIE", ["F1"], weighted, undefined, new Set(["F1"])),
    ];
    expect(new Set(tones).size).toBe(tones.length);
    for (const tone of tones) expect(TONE_CLASS[tone], tone).toBeTruthy();
  });
});

// ── D2 the cannot-arm secondary mark ─────────────────────────────────────────
describe("cannotArmMarkText (the tile's secondary mark)", () => {
  it("counts only reds when any is red, else only ambers", () => {
    // Prod 2026-09-27 credit: 3 red + 1 amber unseated read "⌁4 red" off the total `count`.
    expect(cannotArmMarkText({ cannotArm: { count: 4, worst: "RED", worstCount: 3 } })).toBe("⌁3 red");
    expect(cannotArmMarkText({ cannotArm: { count: 2, worst: "AMBER", worstCount: 2 } })).toBe("⌁2 amber");
  });

  it("is empty when the family seats every elevated member (undefined / zero cannotArm)", () => {
    // The falsifier: a D1-greened tile with a live red MUST show the mark, so an empty return here
    // is only correct when there is genuinely nothing unseated.
    expect(cannotArmMarkText({})).toBe("");
    expect(cannotArmMarkText({ cannotArm: undefined })).toBe("");
    expect(cannotArmMarkText(null)).toBe("");
  });
});

// ── D4 the no-arm family treatment ───────────────────────────────────────────
describe("isNoArmFamily (off the SERVED noArmFamilies, never a hand list)", () => {
  it("is true only for a served no-arm key", () => {
    expect(isNoArmFamily("valuation", ["valuation"])).toBe(true);
    expect(isNoArmFamily("credit", ["valuation"])).toBe(false);
  });

  it("reads the PASSED roster - an empty/absent served set marks nothing", () => {
    expect(isNoArmFamily("valuation", [])).toBe(false);
    expect(isNoArmFamily("valuation", undefined)).toBe(false);
  });
});

// ── the browser reads the SERVED roster, not a literal ───────────────────────
describe("families-board.js / lab-board.js wire the served roster, never a hand-listed one", () => {
  // The single-source pin (`indicator-loop.md` §A retune is a ONE-place edit): if someone re-hand-lists ids/families in
  // the browser, the `legWeighted`/`noArm` sources below stop reading `d.dangerRoster` and this reds.
  // (The refresh path moved out of lab.js into the families-board.js seam, 2026-09-05 P11.)
  const labJs = readFileSync(new URL("./families-board.js", import.meta.url), "utf8");
  const boardJs = readFileSync(new URL("./lab-board.js", import.meta.url), "utf8");

  it("legWeighted is built from d.dangerRoster.legWeightedIds in BOTH paint paths", () => {
    expect(labJs).toContain("d.dangerRoster && d.dangerRoster.legWeightedIds");
    expect(boardJs).toContain("d.dangerRoster && d.dangerRoster.legWeightedIds");
  });

  it("perLegOnly is built from d.dangerRoster.perLegOnlyIds and reaches legStripHtml in BOTH paint paths", () => {
    for (const src of [labJs, boardJs]) {
      expect(src).toContain("d.dangerRoster && d.dangerRoster.perLegOnlyIds");
      expect(src).toContain("legStripHtml(f, members, attrs, flips, legWeighted, perLegOnly,");
    }
    // ...and legStripHtml hands it on to the grouping seam, or the credit "per-leg only" group never paints.
    expect(boardJs).toContain("tileMemberGroups(f, members, perLegOnlyIds)");
  });

  it("noArm is built from d.dangerRoster.noArmFamilies", () => {
    expect(labJs).toContain("d.dangerRoster && d.dangerRoster.noArmFamilies");
  });
});

// ── D2 two-tone + D4 no-arm are EMITTED and STYLED (glyph pins) ───────────────
describe("the D2/D4 tile treatment is emitted by families-board.js and styled in lab.css", () => {
  const labJs = readFileSync(new URL("./families-board.js", import.meta.url), "utf8");
  const boardJs = readFileSync(new URL("./lab-board.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("./lab.css", import.meta.url), "utf8");

  it("buildTiles emits the .t-cannot mark host beside the .st primary state", () => {
    // Two-tone: `.st` (band role, D1) + `.t-cannot` (D2 secondary mark) both live in the header.
    expect(boardJs).toContain('<span class="st"></span><span class="t-cannot"></span>');
  });

  it("renderFamiliesBoard fills the D2 mark from cannotArmMarkText", () => {
    expect(labJs).toContain("cannotArmMarkText(f)");
  });

  // Both hover titles open with "deepens the dial"; the no-arm wiring is pinned in families-board.test.js.
  it("D6c: both cannot-arm titles say DEEPENS", () => {
    expect(NO_ARM_TITLE).toMatch(/^deepens the dial/);
    expect(CANNOT_ARM_TITLE).toMatch(/^deepens the dial/);
  });

  it("D6c: families-board.js actually WIRES the cannot-arm title onto the DOM (a constant nobody sets paints nothing)", () => {
    expect(labJs).toContain("cannot.title = CANNOT_ARM_TITLE");
    // …and it is imported, or the assignment above is a ReferenceError at runtime.
    expect(labJs).toMatch(/import \{[^}]*CANNOT_ARM_TITLE[^}]*\} from "\.\/tile-members\.js"/);
    // The mute case is wired too: no mark ⇒ no stale tooltip left behind.
    expect(labJs).toContain('cannot.removeAttribute("title")');
  });

  // A class is a treatment only if it is STYLED, never merely emitted (testing-project.md): a bare
  // .tile.noarm with no rule paints as an unstyled tile, i.e. the green it was meant to replace.
  it.each([".tile.noarm {", ".tile .t-cannot {", ".tile .t-cannot.ca-red {", ".tile .ids .mt-grey {", ".tile .ids .mt-perleg {"])(
    "%s is styled in lab.css",
    (sel) => {
      expect(css).toContain(sel);
    },
  );
});

describe("deadLitIds (the Dashboard card's ⌁ note, off the served /api/danger-model body)", () => {
  it("over the REAL served body: weighted ids no pillar folds - NVDA and DB_SMH qualify, no pillar id does", async () => {
    const body = await (await dangerModelView()).json();
    const dead = deadLitIds(body);
    expect(dead.has("NVDA")).toBe(true);
    expect(dead.has("DB_SMH")).toBe(true);
    const pillar = new Set(body.pillarIds);
    for (const id of dead) expect(id in body.memberWeight && !pillar.has(id), id).toBe(true);
    for (const id of Object.keys(body.memberWeight)) expect(dead.has(id) || pillar.has(id), id).toBe(true);
  });

  it("an old payload without pillarIds (or no body) yields null - no note", () => {
    expect(deadLitIds({ memberWeight: { NVDA: { semis: 1 } } })).toBeNull();
    expect(deadLitIds(null)).toBeNull();
  });

  it("app.js seeds it from the same danger-model fetch and pushes DEAD_NOTE onto a qualifying card", () => {
    const appJs = readFileSync(new URL("./app.js", import.meta.url), "utf8");
    expect(appJs).toContain("deadLitIds: deadLitIds(body)");
    expect(appJs).toContain("if (state.deadLitIds?.has(meta.id)) notes.push(DEAD_NOTE);");
  });
});
