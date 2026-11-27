// families-board.js — the /lab Families-board seam, extracted MOVE-ONLY (P11) so /overview can
// render the SAME board read-only. Plain vitest, NO jsdom and NEVER lab.js (module-level DOM /
// localStorage side effects, `.claude/rules/frontend.md`): the DOM is a tiny hand-rolled element
// stub — enough surface for setHTML (innerHTML + applyPositions/decorateHelp walks) and the
// module's own querySelector/attribute traffic. Assertions run on the RECORDED markup/attributes.
//
// Read-only contract (the reason /overview may call this with data only): with no `deps`, the
// board must attach ZERO event listeners and fire ZERO fetches, and no tile may carry the
// scenario tap-cycle affordances (`.clickable`, role="button", tabindex) — even on a payload
// whose mode says "scenario". No global is stubbed: `document` stays undefined (any reach for it
// throws), and "never fetches" is a static scan of the board's whole import closure.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { renderFamiliesBoard } from "./families-board.js";

// ── element stub ────────────────────────────────────────────────────────────────────────────────
// Selector-keyed: querySelector returns a lazily-created child stub per selector string, so the
// module's `$("#regime")`-style reads land on recordable objects without parsing HTML.
// querySelectorAll resolves only the selectors this test pre-seeds (the tile list).
let listenersAttached = 0;
function el(tag = "div") {
  const node = {
    tag,
    innerHTML: "",
    textContent: "",
    hidden: undefined,
    className: "",
    dataset: {},
    attrs: {},
    style: { setProperty() {} },
    children: new Map(),
    seededLists: new Map(),
    matches: () => false,
    closest: () => null,
    querySelector(sel) {
      if (!node.children.has(sel)) node.children.set(sel, el());
      return node.children.get(sel);
    },
    querySelectorAll(sel) {
      return node.seededLists.get(sel) || [];
    },
    setAttribute(k, v) {
      node.attrs[k] = String(v);
      if (k === "title") node.title = String(v);
    },
    removeAttribute(k) {
      delete node.attrs[k];
      if (k === "title") delete node.title;
    },
    getAttribute(k) {
      return k in node.attrs ? node.attrs[k] : null;
    },
    appendChild(c) {
      (node.appended ??= []).push(c);
    },
    addEventListener() {
      listenersAttached += 1;
    },
  };
  return node;
}
/** One built board tile as the module expects it (buildTiles markup shape, stub form). */
function tileStub(key) {
  const t = el();
  t.dataset.key = key;
  for (const sel of [".dot", ".st", ".t-cannot", ".t-lag", ".t-diff", ".ids"]) t.querySelector(sel);
  return t;
}

// ── fixture payload (shape: /api/lab — globalFamilies/t1dial/dangerRoster + familyOrder) ───────
const payload = (over = {}) => ({
  mode: "live",
  t1dial: { regime: "TENSE", dangerScore: 0.42, targetRung: 6, headline: "ARMED - one family firing" },
  globalFamilies: [
    {
      key: "credit",
      label: "Credit",
      live: true,
      firing: true,
      state: "RED",
      members: [{ id: "F1", label: "HY OAS", state: "RED" }],
    },
    {
      key: "valuation",
      label: "Valuation",
      live: true,
      firing: false,
      state: "GREEN",
      members: [{ id: "F7", label: "CAPE", state: "GREEN" }],
    },
  ],
  dialFamilies: [
    { key: "credit", members: [{ id: "F1", state: "RED" }] },
    { key: "valuation", members: [{ id: "F7", state: "GREEN" }] },
  ],
  dangerRoster: { legWeightedIds: ["F1", "F7"], perLegOnlyIds: [], noArmFamilies: ["valuation"] },
  familyOrder: ["credit", "valuation"],
  bandReason: "regime",
  ...over,
});

let tilesEl, host, tiles;
beforeEach(() => {
  listenersAttached = 0;
  host = el();
  // The board hands buildTiles its OWN host's `#tiles` — the lazily-created child stub — so the
  // emitted tile markup lands on a recordable object with no global document.
  tilesEl = host.querySelector("#tiles");
  tiles = [tileStub("credit"), tileStub("valuation")];
  host.seededLists.set("#tiles .tile", tiles);
});

const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
/** One top-level function's source, `export function NAME(` up to its closing column-0 brace. */
function fnBody(file, name) {
  const s = src(file);
  const start = s.indexOf(`export function ${name}(`);
  return start < 0 ? "" : s.slice(start, s.indexOf("\n}\n", start) + 2);
}
const codeLines = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l));

describe("build + head paint (fixture in, markup/hidden out)", () => {
  it("builds the skeleton once per host, then updates in place", () => {
    renderFamiliesBoard(host, payload());
    expect(host.innerHTML).toContain('id="board"');
    expect(host.innerHTML).toContain('id="tiles"');
    expect(host.innerHTML).toContain('class="lg-sectag sec-tip"');
    // buildTiles really emitted the tile markup through the shared lab-board producer.
    expect(tilesEl.innerHTML).toContain('data-key="credit"');
    expect(tilesEl.innerHTML).toContain('class="t-lag"');
    const skeleton = host.innerHTML;
    tilesEl.innerHTML = "SENTINEL"; // a rebuild would overwrite this via buildTiles
    renderFamiliesBoard(host, payload());
    expect(host.innerHTML).toBe(skeleton); // built once — the second render never rewrote the host
    expect(tilesEl.innerHTML).toBe("SENTINEL");
  });

  it("paints regime, score, firing count and the band-reason caption", () => {
    renderFamiliesBoard(host, payload());
    expect(host.querySelector("#regime").textContent).toBe("TENSE");
    expect(host.querySelector("#score").textContent).toBe("0.42");
    expect(host.querySelector("#firing").innerHTML).toContain("<b>1</b> of 2 families firing");
    const reason = host.querySelector("#bandReason");
    expect(reason.textContent).toBe("band set by the dial regime");
    expect(reason.hidden).toBe(false);
  });

  it("paints the E14 EST tag only on a display-vs-notify regime split", () => {
    const band = (regime) => ({ level: "WARNING", chain: { regime } });
    renderFamiliesBoard(host, payload({ band: band("Calm") }));
    expect(host.querySelector("#regimeEst").textContent).toBe("EST · push band: WARNING");
    expect(host.querySelector("#regimeEst").hidden).toBe(false);
    renderFamiliesBoard(host, payload({ band: band("TENSE") }));
    expect(host.querySelector("#regimeEst").hidden).toBe(true);
  });

  it("hides the band-reason caption when the payload omits d.bandReason (scenario/replay)", () => {
    renderFamiliesBoard(host, payload({ bandReason: undefined }));
    expect(host.querySelector("#bandReason").hidden).toBe(true);
    expect(host.querySelector("#bandReason").textContent).toBe("");
  });

  it("marks a failed cron prune on the latest EOD run, and hides the mark once a clean payload lands", () => {
    renderFamiliesBoard(host, payload({ pruneFailed: { firedAt: "2026-10-20T05:51:00.000Z", reason: "statement timeout" } }));
    expect(host.innerHTML).toContain('id="pruneNote"');
    expect(host.querySelector("#pruneNote").textContent).toBe("⚠ prune failed 2026-10-20");
    expect(host.querySelector("#pruneNote").hidden).toBe(false);
    renderFamiliesBoard(host, payload());
    expect(host.querySelector("#pruneNote").hidden).toBe(true);
    expect(host.querySelector("#pruneNote").textContent).toBe("");
  });

  it("updates tiles in place: state class, no-arm label, member strip", () => {
    renderFamiliesBoard(host, payload());
    const [credit, valuation] = tiles;
    expect(credit.className).toBe("tile r");
    expect(credit.querySelector(".st").textContent).toBe("RED");
    expect(credit.querySelector(".ids").innerHTML).toContain('data-id="F1"');
    // D4: a GREEN no-arm family paints `noarm`, never the calm green.
    expect(valuation.className).toBe("tile noarm");
    expect(valuation.querySelector(".st").textContent).toBe("◇ no-arm");
    expect(valuation.querySelector(".st").title).toBe("deepens the dial, never arms");
  });

  it("a member outside the served pillarIds paints mt-dead + ⌁ on BOTH paint paths; an old payload marks none", () => {
    const globalFamilies = payload().globalFamilies.map((f) =>
      f.key === "credit" ? { ...f, members: [...f.members, { id: "R8", label: "R8", state: "RED" }] } : f,
    );
    const roster = payload().dangerRoster;
    renderFamiliesBoard(host, payload({ globalFamilies, dangerRoster: { ...roster, pillarIds: ["F1", "F7"] } }));
    for (const html of [tilesEl.innerHTML, tiles[0].querySelector(".ids").innerHTML]) {
      expect(html).toMatch(/class="leg-r mt-dead" data-id="R8"/);
      expect(html).toContain('class="leg-dead"');
      expect(html).not.toMatch(/mt-dead" data-id="F1"/);
    }
    host = el(); // fresh host ⇒ buildTiles runs again for the old-payload arm
    tilesEl = host.querySelector("#tiles");
    tiles = [tileStub("credit"), tileStub("valuation")];
    host.seededLists.set("#tiles .tile", tiles);
    renderFamiliesBoard(host, payload({ globalFamilies }));
    for (const html of [tilesEl.innerHTML, tiles[0].querySelector(".ids").innerHTML]) expect(html).not.toContain("dead");
  });

  it("a not-in-pillar member on the display band reads mt-dead unless the served DIAL band seats it, on BOTH paint paths", () => {
    // R8 sits on credit's DISPLAY band; whether it stays live is decided by the dial panel's band.
    const globalFamilies = payload().globalFamilies.map((f) =>
      f.key === "credit" ? { ...f, members: [...f.members, { id: "R8", label: "R8", state: "RED" }], band: { ids: ["F1", "R8"] } } : f,
    );
    const roster = { ...payload().dangerRoster, pillarIds: ["F1", "F7"] };
    const dial = (creditIds) => [
      { key: "credit", members: [], band: { ids: creditIds } },
      { key: "valuation", members: [], band: { ids: ["F7"] } },
    ];
    const paths = () => [tilesEl.innerHTML, tiles[0].querySelector(".ids").innerHTML];
    renderFamiliesBoard(host, payload({ globalFamilies, dangerRoster: roster, dialFamilies: dial(["F1"]) }));
    for (const html of paths()) {
      expect(html).toMatch(/class="leg-r mt-dead" data-id="R8"/);
      expect(html).toContain('title="not in pillar - moves no danger pillar"');
    }
    host = el(); // fresh host ⇒ buildTiles runs again for the dial-seated arm
    tilesEl = host.querySelector("#tiles");
    tiles = [tileStub("credit"), tileStub("valuation")];
    host.seededLists.set("#tiles .tile", tiles);
    renderFamiliesBoard(host, payload({ globalFamilies, dangerRoster: roster, dialFamilies: dial(["F1", "R8"]) }));
    for (const html of paths()) {
      expect(html).toMatch(/class="leg-r mt-live" data-id="R8"/);
      expect(html).toContain('title="moves the dial, not in any danger pillar"');
    }
  });

  it("the .t-diff count folds d.dialFamilies by key, and paints nothing without it", () => {
    const dialFamilies = [{ key: "credit", members: [{ id: "F1", state: "RED" }], absent: 1 }];
    renderFamiliesBoard(host, payload({ dialFamilies }));
    expect(tiles[0].querySelector(".t-diff").textContent).toBe("1 red / 1 elevated of 1 (1 dark)");
    renderFamiliesBoard(host, payload({ dialFamilies: undefined }));
    expect(tiles[0].querySelector(".t-diff").textContent).toBe("");
  });
});

describe("read-only mode (no interactive deps — the /overview contract)", () => {
  it("attaches no listeners and marks no tile clickable even in scenario mode", () => {
    renderFamiliesBoard(host, payload({ mode: "scenario" }));
    expect(listenersAttached).toBe(0);
    for (const t of tiles) {
      expect(t.className).not.toContain("clickable");
      expect(t.attrs.role).toBeUndefined();
      expect(t.attrs.tabindex).toBeUndefined();
    }
  });

  it("deps.interactive + scenario mode is what re-enables the tap-cycle affordances (lab.js's call)", () => {
    renderFamiliesBoard(host, payload({ mode: "scenario" }), { interactive: true });
    expect(tiles[0].className).toContain("clickable");
    expect(tiles[0].attrs.role).toBe("button");
    // …but live mode strips them again even for the interactive caller.
    renderFamiliesBoard(host, payload(), { interactive: true });
    expect(tiles[0].className).not.toContain("clickable");
    expect(tiles[0].attrs.role).toBeUndefined();
    expect(listenersAttached).toBe(0); // affordances are attributes only — listeners stay in lab.js
  });

  it("no code line in the board's whole import closure calls a fetch (the old throwing-stub's reach)", () => {
    // The retired `globalThis.fetch` stub threw on ANY call the import + render reached: module
    // top-level code of every transitive import, and every helper the render path calls. Statically
    // that is the full relative-import closure of families-board.js, scanned for a fetch CALL
    // (`fetch(`, `fetchImpl(`, a `.fetch` reference) — an over-approximation, never narrower.
    // `loadDangerModel` is the one exclusion, mirroring the stub exactly: it fetches, but only when
    // CALLED, and the board path never calls it (it reads the cached `dangerModel`) — so its body is
    // cut out and a CALL to it anywhere in the closure is itself a hit. A dynamic `import(` is a hit
    // too: the closure walk cannot follow it.
    const closure = new Map();
    for (const queue = ["./families-board.js"]; queue.length; ) {
      const f = queue.pop();
      if (closure.has(f)) continue;
      closure.set(f, src(f));
      // Any `from "./x"` (static import / re-export, multi-line specifier lists included) PLUS a bare
      // side-effect `import "./x";` — an over-approximation of the import graph, never narrower.
      for (const m of closure.get(f).matchAll(/(?:\bfrom\s*|^\s*import\s*)["'](\.\/[^"']+)["']/gm)) queue.push(m[1]);
    }
    const ldm = fnBody("./lab-board.js", "loadDangerModel");
    // Vacuity: the walk reached past the direct imports (help-decorate.js is only imported
    // transitively, via help-bar.js), and the excised body is one the scan WOULD flag.
    expect([...closure.keys()]).toEqual(expect.arrayContaining(["./lab-board.js", "./help-bar.js", "./help-decorate.js"]));
    const CALL = /\bfetch\w*\s*\(|\.fetch\b|\bloadDangerModel\s*\(|\bimport\s*\(|\b(?:baseFetch|getJson|request|send)\s*\(/;
    expect(codeLines(ldm).filter((l) => CALL.test(l)).length).toBeGreaterThan(0);
    closure.set("./lab-board.js", closure.get("./lab-board.js").replace(ldm, ""));
    // http.js (reached for loadDangerModel's default) is excised the same way: it fetches only when its exports are CALLED.
    expect(codeLines(closure.get("./http.js") ?? "").filter((l) => CALL.test(l)).length, "http.js left the closure: drop this excision").toBeGreaterThan(0);
    closure.delete("./http.js");
    const hits = [...closure].flatMap(([f, s]) => codeLines(s).filter((l) => CALL.test(l)).map((l) => `${f}: ${l.trim()}`));
    expect(hits).toEqual([]);
  });
});

describe("lab.js wiring (source-read — lab.js is never imported)", () => {
  it("every name lab.js imports from families-board.js is a function export of it", async () => {
    const src = readFileSync(new URL("./lab.js", import.meta.url), "utf8");
    const named = /^import\s*\{([^}]*)\}\s*from\s*"\.\/families-board\.js";/m.exec(src);
    expect(named).not.toBeNull();
    const names = named[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    expect(names).toContain("buildFamiliesBoard");
    const mod = await import("./families-board.js");
    expect(names.filter((n) => typeof mod[n] !== "function")).toEqual([]);
  });
});
