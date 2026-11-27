/**
 * Registry-parity drift guard for the hand-typed, user-visible prose corpus
 * (2026-07-25 visible-copy name-sync plan, Stage 3.1).
 *
 * The 2026-07-24 official-short-names rename moved every surface that reads
 * `Indicator.label`/`longLabel` transitively. The hand-typed prose in `public/*.js`
 * feeds through no API, so it can silently drift back to a pre-rename form
 * (`Shiller CAPE`, `NFCIRISK`, `HY-OAS`, `ICE BofAML …`). This test is the
 * seam that catches that: Vitest can legally import BOTH `src/*.ts` and `public/*.js`;
 * the browser bundle cannot — which is exactly why the guard lives here and not as an
 * import in the shipped prose module.
 *
 * DESIGN — precise, not a broad capitalised-word heuristic:
 *   The one drift class the plan cares about is "a pre-rename name leaks back in". So
 *   the guard scans the ACTUAL exported prose OBJECT VALUES (comments / CSS classes /
 *   `src` symbols are automatically out of scope — they are not object values) for a
 *   CURATED, registry-grounded list of stale forms. It deliberately does NOT flag
 *   "any other indicator's longLabel", because legitimate cross-references use the
 *   CURRENT short label — e.g. F3's copy says "HY OAS" (F1's label) on purpose — so a
 *   broad cross-leak check would false-positive on ordinary correct prose. The curated
 *   forbidden list captures the genuinely-old branded/long forms without that noise.
 *   (Registry fact that would trip a naive author: SPCONC label is `SPY/RSP`, its prose
 *   legitimately reads "S&P 500 concentration" as description, never a name token.)
 *
 * Registry-parity binding (why `ALL_INDICATORS` is imported):
 *   - every id-keyed prose KEY must be a real `ALL_INDICATORS` id (catches a prose
 *     entry keyed by a renamed / deleted id);
 *   - each curated forbidden form is asserted to be GENUINELY stale — never equal to
 *     the current `label`/`longLabel` for its id — so if a future rename resurrected an
 *     "old" form as the live name, this meta-check breaks and forces reconciliation;
 *   - the single frozen gloss (`F8 → "MU (Micron)"`) is checked against the live label.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error — public/*.js ships no .d.ts; vitest resolves it at runtime, tsc can't type it (allowJs is off). Shape asserted structurally below.
import { INDICATOR_DESC } from "./indicator-desc.js";
// @ts-expect-error — see above.
import { MEMBER_HELP } from "./member-help.js";
// @ts-expect-error — see above.
import { MEMBER_DESC, FLOOR_DESC } from "./band-panel.js";
// @ts-expect-error — see above. The two Addendum-C name-sync composers (Stage C3) — the shared seam every
// render site routes bare-id→label / de-stutter through; asserted directly below.
import { chipLabel, idIfDistinct } from "./leading-name.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { CHART_ONLY_IDS } from "../src/registry-composite.js";
// Server-side prose corpus (Stage B4): the hand-typed family descriptions and the R4 overlay's
// hand-authored field labels reach /lab THROUGH api/lab.ts, so they were never in the public/*.js
// corpus above and can drift back to a pre-rename form unseen. Vitest imports both freely.
import { US_FAMILIES, GLOBAL_FAMILIES } from "../src/families.js";
import { r4View } from "../src/lab-overlays.js";
// buildLabBand (alert-band.ts) is the OTHER server-side producer of R4 floor `LabBandMember` rows —
// their `label`/`note` are hand-typed, reach /lab through api/lab.ts, and are rendered by
// public/band-panel.js (`m.label`). It carries the same drift risk as r4View's fields (Addendum B
// finding 1: the retired `HY-OAS` form was live here). `makeDial` gives a minimal dial fixture.
import { buildLabBand } from "../src/alert-band.js";
import { makeDial } from "../src/test-helpers.js";

const byId = new Map(ALL_INDICATORS.map((i) => [i.id, i] as const));
const registryIds = new Set(byId.keys());

/** The ONLY frozen gloss (Stage 1.1): F8's bare ticker earns a "(Micron)" gloss.
 *  The plan's `SPCONC (…)` gloss row was VOIDED — not encoded here. */
const GLOSS: Record<string, string> = { F8: "MU (Micron)" };

/**
 * Curated pre-rename forms, per the id they belong to (Stage 1.1 row-level inventory).
 * These are the OLD name tokens the rename retired; none may reappear in any id-keyed
 * prose value. Scanned globally (every form against every entry) — safe because none
 * of them is a substring of any legitimate current prose value (verified at authoring).
 */
const PRE_RENAME: Record<string, string[]> = {
  F7: ["Shiller CAPE"], // → CAPE
  F1: ["HY-OAS"], //        → HY OAS (hyphen retired; the space form is current)
  F3: ["NFCIRISK", "HY-OAS"], // → NFCI Risk / HY OAS
  R6: ["ICE BofAML"], //    → MOVE
  F10: ["ICE BofA Emerging Markets"], // → EM corporate
  F8: ["Micron (MU)", "Micron / MU"], //  → MU (Micron) (gloss order flipped)
};

/** Key-level exemptions (Stage 1.1): entries that name 0 or >1 indicators, so an
 *  `id` field would be a lie. The test asserts each still EXISTS in its source, so a
 *  stale exemption naming a deleted key fails. */
const MEMBER_HELP_EXEMPT = ["SMH↓", "NVDA↓", "QQQ↓"]; // ↓ strip chips — no Indicator.label
const MEMBER_DESC_EXEMPT = ["r4-rung", "r4-families", "r4-hyoas", "r4-vt", "GEO_MANUAL", "GEO_STAGE"]; // synthetic floor rows

/** Wholesale source exemptions (Stage 1.1): scanned in full and cleared of drift, or
 *  faithful transcriptions of a strategy doc. Not imported here; asserted to still exist
 *  so a rename of the file surfaces as a failing exemption rather than silent rot. */
const WHOLESALE_EXEMPT_FILES = ["method-cards.js", "off-ladder-specs.js"];

/** Addendum C, Stage C3 — Rule 2 (`>${esc(x.id)}` element-text scan below). The ONLY sanctioned
 *  bare-id-as-element-text render: the CSS-class wrapper whose id is a NON-registry key with no
 *  `ALL_INDICATORS` label to substitute —
 *   - `bp-floor-id`     → band-panel danger-ladder FLOOR ids (synthetic — no registry label).
 *  ⚠ `cm-id` / `r-id` were RETIRED from this list by the 2026-07-25 [USER] ruling
 * , which OVERRODE Amendment C-b-2 of
 *  the visible-copy name sync. C-b-2 had ruled the two method-code chips EXEMPT on the
 *  grounds that a method code is a scanning key; the ruling retires that exemption — visible text
 *  carries the method NAME (`shortTitle(m.title)`), never the code, so both chips STOPPED rendering
 *  the id (`public/lab.js`) and the classes must now be genuinely ABSENT, not exempt. The
 *  stale-allowlist test below enforces that: a class here that renders no live bare-id fails it.
 *  The synthetic floor rows (`r4-rung`/`GEO_MANUAL`) and the `↓` strip chips (`SMH↓`…) are NOT
 *  element-text renders (they are MEMBER_DESC/MEMBER_HELP keys, already policed by the *_EXEMPT
 *  lists above), so they never reach this scan. Policed by the stale-allowlist test. */
const RULE2_ELEMENT_TEXT_EXEMPT_CLASSES = ["bp-floor-id"];

/** Collect every string leaf of a prose value (INDICATOR_DESC entries are
 *  {tip,why,lies?,with?,links?}; MEMBER_* values are strings). */
function collectStrings(val: unknown): string[] {
  if (typeof val === "string") return [val];
  if (val && typeof val === "object") return Object.values(val).flatMap(collectStrings);
  return [];
}

/** All id-keyed prose {id, text} pairs from one source, exempt keys removed. Throws the
 *  registry-parity failure via caller assertion, not here. */
function idKeyedProse(
  obj: Record<string, unknown>,
  exempt: string[],
): { id: string; text: string }[] {
  const ex = new Set(exempt);
  const out: { id: string; text: string }[] = [];
  for (const [key, val] of Object.entries(obj)) {
    if (ex.has(key)) continue;
    for (const text of collectStrings(val)) out.push({ id: key, text });
  }
  return out;
}

const publicDir = fileURLToPath(new URL(".", import.meta.url));

/** The PRODUCTION front-end corpus: every `public/*.js` EXCEPT the `*.test.js` suites (which carry
 *  fixtures/assertions that legitimately mention ids). Read raw so the Rule-2 scan sees source text,
 *  not runtime values. */
const productionPublicJs: { file: string; lines: string[] }[] = readdirSync(publicDir)
  .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
  .map((f) => ({ file: f, lines: readFileSync(publicDir + f, "utf8").split("\n") }));

/** A full-line comment (block-comment body `*`, or a `//` / `/*` line). Excludes the docblock
 *  EXAMPLES that name a bare id in prose (`OVX/OVX`) from the Rule-2 source scan — a reworded scan,
 *  never a reworded comment. Inline trailing comments are rare in this corpus and left in scope. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
}

describe("prose-names registry-parity drift guard", () => {
  it("the curated forbidden list is genuinely stale vs the live registry", () => {
    for (const [id, forms] of Object.entries(PRE_RENAME)) {
      expect(registryIds.has(id), `PRE_RENAME id ${id} must be a real indicator`).toBe(true);
      const ind = byId.get(id)!;
      for (const f of forms) {
        expect(f, `forbidden form "${f}" must not equal ${id}.label`).not.toBe(ind.label);
        expect(f, `forbidden form "${f}" must not equal ${id}.longLabel`).not.toBe(ind.longLabel);
      }
    }
  });

  it("the frozen gloss is consistent with the live registry label", () => {
    for (const [id, gloss] of Object.entries(GLOSS)) {
      const ind = byId.get(id)!;
      expect(ind, `gloss id ${id} must be a real indicator`).toBeTruthy();
      // "MU (Micron)" leads with the live label, then the descriptive gloss.
      expect(gloss.startsWith(ind.label), `gloss "${gloss}" must lead with ${id}.label`).toBe(true);
    }
  });

  it("every id-keyed prose key is a real registry id", () => {
    // CHART-ONLY ids (`CHART_ONLY_INDICATORS` — VTP) are real registry identities that are
    // deliberately outside `ALL_INDICATORS`, yet they DO get a Dashboard card + detail chart
    // (2026-07-31 ruling), so their explainer copy is legitimate prose, not an orphan key. Widened
    // HERE only: `registryIds` still drives the weld/leak guards below, where adding a
    // never-rendered id would only broaden what they forbid.
    const proseKeyIds = new Set([...registryIds, ...CHART_ONLY_IDS]);
    const check = (name: string, obj: Record<string, unknown>, exempt: string[]) => {
      const ex = new Set(exempt);
      for (const key of Object.keys(obj)) {
        if (ex.has(key)) continue;
        expect(proseKeyIds.has(key), `${name} key "${key}" is not an ALL_INDICATORS/CHART_ONLY id`).toBe(true);
      }
    };
    check("INDICATOR_DESC", INDICATOR_DESC, []);
    check("MEMBER_HELP", MEMBER_HELP, MEMBER_HELP_EXEMPT);
    check("MEMBER_DESC", MEMBER_DESC, MEMBER_DESC_EXEMPT);
  });

  it("no id-keyed prose value contains a pre-rename name form", () => {
    const forbidden = Object.entries(PRE_RENAME).flatMap(([id, forms]) =>
      forms.map((form) => ({ id, form })),
    );
    const prose = [
      ...idKeyedProse(INDICATOR_DESC, []),
      ...idKeyedProse(MEMBER_HELP, MEMBER_HELP_EXEMPT),
      ...idKeyedProse(MEMBER_DESC, MEMBER_DESC_EXEMPT),
    ];
    const bad = prose.flatMap(({ id, text }) =>
      forbidden
        .filter(({ form }) => text.includes(form))
        .map(({ id: owner, form }) => `prose keyed by ${id} contains pre-rename form "${form}" (retired ${owner} name)`),
    );
    expect(bad).toEqual([]);
  });

  /** Addendum D1 — `FLOOR_DESC` (band-panel.js) is FREE prose keyed by the five danger-ladder FLOOR
   *  ids, so it stays out of the key-parity check above (a floor id is not an `ALL_INDICATORS` id).
   *  But its VALUES name indicators in prose — the `r4` row carries `HY OAS` — so they can drift back
   *  to a retired form exactly like the id-keyed corpus, and until this test the shipped
   *  `HY-OAS`→`HY OAS` rewrite could be reverted with nothing red. Values only. */
  it("no FLOOR_DESC value contains a pre-rename name form (Addendum D1)", () => {
    const forbidden = Object.entries(PRE_RENAME).flatMap(([id, forms]) =>
      forms.map((form) => ({ id, form })),
    );
    const entries = Object.entries(FLOOR_DESC as Record<string, string>);
    expect(entries.map(([floor]) => floor)).toContain("r4");
    for (const [floor, text] of entries) {
      for (const { id: owner, form } of forbidden) {
        expect(
          text.includes(form),
          `FLOOR_DESC.${floor} contains pre-rename form "${form}" (retired ${owner} name)`,
        ).toBe(false);
      }
    }
  });

  /** Addendum D2 — the POSITIVE half of the gloss rule. The forbidden-form scan is structurally blind
   *  to a regression that drops the gloss without typing a retired form: F8's pre-rename wording was
   *  `the Micron memory-cycle leg`, which contains neither `Micron (MU)` nor `Micron / MU`, and bare
   *  `Micron` cannot be forbidden — it lives inside the gloss itself. So assert the gloss is PRESENT
   *  in every source that keys the id. The negative forms stay: they are scanned globally (every form
   *  against every entry), catching a flipped gloss under ANOTHER id's key, which this cannot see. */
  it("every prose source keying a glossed id renders the gloss verbatim (Addendum D2)", () => {
    const sources: [string, Record<string, unknown>][] = [
      ["INDICATOR_DESC", INDICATOR_DESC],
      ["MEMBER_HELP", MEMBER_HELP],
      ["MEMBER_DESC", MEMBER_DESC],
    ];
    for (const [id, gloss] of Object.entries(GLOSS)) {
      let keyed = 0;
      for (const [name, obj] of sources) {
        if (!(id in obj)) continue;
        keyed++;
        expect(
          collectStrings(obj[id]).some((t) => t.includes(gloss)),
          `${name}["${id}"] must render the frozen gloss "${gloss}" — a bare-label rewording regresses undetected`,
        ).toBe(true);
      }
      // Vacuity guard: a gloss no source keys would make the loop above a no-op.
      expect(keyed, `gloss id ${id} is keyed by no prose source — nothing was asserted`).toBeGreaterThan(0);
    }
  });

  it("every key-level exemption still exists in its source (no stale allowlist)", () => {
    for (const k of MEMBER_HELP_EXEMPT) {
      expect(k in MEMBER_HELP, `exempt MEMBER_HELP key "${k}" no longer exists`).toBe(true);
    }
    for (const k of MEMBER_DESC_EXEMPT) {
      expect(k in MEMBER_DESC, `exempt MEMBER_DESC key "${k}" no longer exists`).toBe(true);
    }
    for (const f of WHOLESALE_EXEMPT_FILES) {
      expect(existsSync(publicDir + f), `wholesale-exempt source "${f}" no longer exists`).toBe(true);
    }
    // Stage C3: each Rule-2 exempt CSS class must still render a `>${esc(x.id)}` element-text id in
    // some production public/*.js — else the exemption is stale (the surface was renamed/removed and
    // the allowlist is protecting nothing). Grep the production corpus for `class="<cls>">${esc(…id…)}`.
    const prodSrc = productionPublicJs;
    for (const cls of RULE2_ELEMENT_TEXT_EXEMPT_CLASSES) {
      const re = new RegExp(`class="${cls}">\\$\\{esc\\([a-zA-Z]+\\.id[^}]*\\)\\}`);
      const live = prodSrc.some(({ lines }) => lines.some((l) => !isCommentLine(l) && re.test(l)));
      expect(live, `Rule-2 exempt class "${cls}" renders no bare-id element text — stale exemption`).toBe(true);
    }
  });

  it("iterates the id-keyed prose corpus (vacuity guard)", () => {
    const idKeys = (obj: Record<string, unknown>, exempt: string[]) =>
      Object.keys(obj).filter((k) => registryIds.has(k) && !exempt.includes(k));
    expect(idKeys(INDICATOR_DESC, [])).toContain("F1");
    expect(idKeys(MEMBER_HELP, MEMBER_HELP_EXEMPT)).toContain("F13");
    expect(idKeys(MEMBER_DESC, MEMBER_DESC_EXEMPT)).toContain("F1");
  });
});

/**
 * Stage B4 — the SERVER-SIDE prose corpus. Two /lab surfaces carry hand-typed names that reach the
 * browser through api/lab.ts (never public/*.js), so the guard above cannot see them:
 *   - `US_FAMILIES`/`GLOBAL_FAMILIES` `desc` — the danger-ledger family-column footnotes;
 *   - the R4 overlay's `fields[].label` — hand-authored in `r4View` (src/lab-overlays.ts).
 * The RULED business rule (2026-07-25): prose names an indicator by its registry `label`, and uses a
 * bare id only where the id IS the label (no distinct short name exists). Family `note` is served but
 * never rendered on /lab, so it is out of scope — only `desc` is scanned.
 */
const R4_PROBE = { cash: false, phase: null, reentryRung: null, hyOas: null, vt: null, reason: "" };

/** Word-boundary matcher for a bare id token — boundaries exclude word chars AND `-` so hyphenated
 *  ids (`price-accel`, `DB_SMH`) match as whole tokens and never inside a longer word. */
function bareIdRe(id: string): RegExp {
  return new RegExp(`(?<![\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
}

describe("server-side prose registry-parity drift guard (Stage B4)", () => {
  const families = [...US_FAMILIES, ...GLOBAL_FAMILIES];
  const forbidden = Object.entries(PRE_RENAME).flatMap(([id, forms]) =>
    forms.map((form) => ({ id, form })),
  );

  // buildLabBand's R4 floor member rows — the second server-side producer of hand-typed R4 labels
  // (the first, r4View, is scanned below). Explicit crisisStage 0 keeps the probe deterministic
  // (the default reads loadGeoInputs()); empty readings/OK band are enough — the labels + reason
  // `note` strings are static text (the F1 label + R4_HY_TAIL), independent of the dial.
  const r4FloorMembers = buildLabBand(makeDial(), [], 0, "equity", "OK", 0).floors.find(
    (f) => f.id === "r4",
  )!.members;

  it("every family `ids` entry is a real ALL_INDICATORS id", () => {
    for (const f of families) {
      for (const id of f.ids) {
        expect(registryIds.has(id), `family "${f.key}" ids has non-registry id "${id}"`).toBe(true);
      }
    }
  });

  it("no family `desc` contains a pre-rename name form", () => {
    for (const f of families) {
      if (!f.desc) continue;
      for (const { id: owner, form } of forbidden) {
        expect(
          f.desc.includes(form),
          `family "${f.key}" desc contains pre-rename form "${form}" (retired ${owner} name)`,
        ).toBe(false);
      }
    }
  });

  it("no family `desc` names one of its own members by bare id (names use the registry label)", () => {
    for (const f of families) {
      if (!f.desc) continue;
      for (const id of f.ids) {
        const ind = byId.get(id);
        // Skip ids whose label IS the id verbatim (e.g. OVX, whose label is "OVX"): a bare token
        // there IS the current label, not a drift. This is a label-equality test, NOT a fixed
        // exemption list — VIX (label "VIX spot") does NOT qualify and is not skipped here.
        if (!ind || ind.label === id) continue;
        expect(
          bareIdRe(id).test(f.desc),
          `family "${f.key}" desc names member "${id}" by id — use its label ${JSON.stringify(ind.label)}`,
        ).toBe(false);
      }
    }
  });

  it("the R4 overlay field labels carry no pre-rename name form", () => {
    for (const { label } of r4View(R4_PROBE).fields) {
      for (const { id: owner, form } of forbidden) {
        expect(
          label.includes(form),
          `R4 overlay field label "${label}" contains pre-rename form "${form}" (retired ${owner} name)`,
        ).toBe(false);
      }
    }
  });

  it("the R4 floor member rows (buildLabBand) carry no pre-rename name form", () => {
    for (const m of r4FloorMembers) {
      // Scan the visible `label` AND the reason `note` — both are hand-typed and both render on /lab.
      for (const text of [m.label, m.note ?? ""]) {
        for (const { id: owner, form } of forbidden) {
          expect(
            text.includes(form),
            `R4 floor member "${m.id}" text "${text}" contains pre-rename form "${form}" (retired ${owner} name)`,
          ).toBe(false);
        }
      }
    }
  });

  it("iterates the Stage-B4 server corpus (vacuity guard)", () => {
    expect(families.filter((f) => f.desc).map((f) => f.key)).toContain("credit");
    expect(r4View(R4_PROBE).fields.map((f) => f.label)).toContain("HY OAS");
    expect(r4FloorMembers.map((m) => m.id)).toContain("r4-hyoas");
  });
});

/**
 * 2026-07-25 [USER] ruling — the NEW
 * shape that slipped past every earlier guard: a method-card code (`T#`/`R#`/`Y#`/`F#`/`G#`) or a
 * registry id WELDED to a descriptive phrase inside a served/hand-typed label ("R5 vol target",
 * "VT backwardation streak"). The Rule-2 scan (public/*.js) only catches a bare id emitted as raw
 * element TEXT — never an id concatenated with a name in a string literal — and these titles live in
 * src/lab-overlays.ts, server-side, outside that corpus entirely.
 *
 * Scope: the OVERLAY-VIEW CARD TITLES only — `view.label` on the OverlayView objects r4View/…/y1View
 * return, rendered by `overlayStripHtml` into the "text under the Danger ledger table" region. NOT
 * `fields[].label` (those are LOOKUP KEYS read via `overlayFieldValue(view, R4_PHASE_LABEL)`), and NOT
 * `method-cards.js` (WHOLESALE_EXEMPT — its titles legitimately carry the codes they document).
 *
 * The titles are read from src/lab-overlays.ts SOURCE: the builders take assorted store/probe args,
 * so a source scan of the `label:` string literals is the
 * robust seam. They sit at the OverlayView object's own indent (4 spaces), beside its `id:`; the
 * generic reading→view `label: LABEL_OF[…]` (also 4 spaces) is computed (no quote) and excluded, and
 * `fields[].label` renders at deeper indent inside `fields: [`.
 */
describe("overlay card titles carry no method code or id-welded name (2026-07-25 ruling)", () => {
  const labLines = readFileSync(fileURLToPath(new URL("../src/lab-overlays.ts", import.meta.url)), "utf8").split("\n");
  const overlayTitles = labLines
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !isCommentLine(line))
    .map(({ line, n }) => ({ m: /^ {4}label: "([^"]+)"/.exec(line), n }))
    .filter((x): x is { m: RegExpExecArray; n: number } => x.m !== null)
    .map((x) => ({ title: x.m[1]!, n: x.n })); // group 1 is required by the regex ⇒ always present

  it("scans the full overlay-title inventory (vacuity guard)", () => {
    expect(overlayTitles.map((t) => t.title)).toContain("Cash / haven circuit-breaker");
  });

  it("no overlay card title LEADS with a method-card code (T#/R#/Y#/F#/G#)", () => {
    for (const { title, n } of overlayTitles) {
      expect(
        /^(?:T|R|Y|F|G)\d+\s/.test(title),
        `src/lab-overlays.ts:${n} overlay title "${title}" leads with a method-card code — the ruling renders the ` +
          `method NAME (shortTitle) instead, never the code`,
      ).toBe(false);
    }
  });

  it("no overlay card title WELDS a bare registry id to a descriptive phrase", () => {
    // id as the leading token, followed by whitespace and at least one more non-space char: the
    // "VT backwardation streak" shape. A title that IS exactly the id (label === id) is a
    // different concern, out of this guard's stated scope.
    const welds = [...registryIds].map((id) => ({ id, re: new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+\\S`) }));
    const bad = overlayTitles.flatMap(({ title, n }) =>
      welds
        .filter(({ re }) => re.test(title))
        .map(
          ({ id }) =>
            `src/lab-overlays.ts:${n} overlay title "${title}" welds registry id "${id}" to a descriptive phrase — ` +
            `use its registry label instead`,
        ),
    );
    expect(bad).toEqual([]);
  });
});

/**
 * 2026-07-25 [USER] ruling — the SECOND producer this class escaped through (surfaced by the previous
 * slice, fixed here). `public/families-board.js` `BAND_REASON_LABEL` (moved out of lab.js, 2026-09-05 P11) maps a persisted alert-band `reason` code to
 * the human copy rendered UNDER the danger ledger (`bandReasonLabel` → the band-reason line). Its
 * `floor:r4` value welded the method code `R4` to a name — `"band floored by the R4 cash breaker"` —
 * the exact §RULING shape, mid-string rather than leading. The overlay-title guard above reads ONLY
 * src/lab-overlays.ts, so a guard that stopped there let this rot; this arm closes the gap.
 *
 * `public/lab.js` executes DOM/`localStorage` side effects at import (frontend.md), so it cannot be
 * imported into a test — the values are parsed out of the SOURCE, exactly like the overlay titles.
 * The forbidden shape is a method-card code (`T#/R#/Y#/F#/G#`, catches method-only codes like `T6`/`Y1`
 * that are not registry ids) OR a bare registry id token (catches `VT`/`SPY`-shaped welds), anywhere in
 * the value — not just leading, since the code sits mid-sentence here.
 */
describe("band-reason labels carry no method code or welded registry id (2026-07-25 ruling)", () => {
  const labJsLines = readFileSync(fileURLToPath(new URL("./families-board.js", import.meta.url)), "utf8").split("\n");
  const bandReasonValues: { value: string; n: number }[] = (() => {
    const start = labJsLines.findIndex((l) => /^const BAND_REASON_LABEL\s*=\s*\{/.test(l.trim()));
    // A missing block means the source scan is silently blind — fail loud rather than iterate nothing.
    expect(start, "BAND_REASON_LABEL object not found in public/families-board.js — source scan is blind").toBeGreaterThanOrEqual(0);
    const out: { value: string; n: number }[] = [];
    for (let i = start + 1; i < labJsLines.length; i++) {
      const line = labJsLines[i]!;
      if (line.trim() === "};") break;
      if (isCommentLine(line)) continue;
      // Grab the VALUE literal — the second double-quoted run on the line (a quoted key like
      // `"floor:ew"` never matches `:\s*"`, so the first `:\s*"` reliably heads the value).
      const m = /:\s*"((?:[^"\\]|\\.)*)"/.exec(line);
      if (m) out.push({ value: m[1]!, n: i + 1 });
    }
    return out;
  })();

  it("scans the full BAND_REASON_LABEL value inventory (vacuity guard)", () => {
    expect(bandReasonValues.map((v) => v.value)).toContain("band set by the dial regime");
  });

  it("no band-reason value WELDS a method-card code (T#/R#/Y#/F#/G#)", () => {
    for (const { value, n } of bandReasonValues) {
      expect(
        /(?<![\w-])(?:T|R|Y|F|G)\d+(?![\w-])/.test(value),
        `public/families-board.js:${n} band-reason value "${value}" welds a method-card code — the ruling renders the ` +
          `method NAME (shortTitle) instead, never the code`,
      ).toBe(false);
    }
  });

  it("no band-reason value WELDS a bare registry id", () => {
    const ids = [...registryIds].map((id) => ({ id, re: bareIdRe(id) }));
    const bad = bandReasonValues.flatMap(({ value, n }) =>
      ids
        .filter(({ re }) => re.test(value))
        .map(({ id }) => `public/families-board.js:${n} band-reason value "${value}" names registry id "${id}" — use its registry label`),
    );
    expect(bad).toEqual([]);
  });
});

/**
 * Addendum C, Stage C3 — the visible-surface sweep's two RULES, made executable, plus direct
 * assertions on the two name-sync composers C2 added (`chipLabel`, `idIfDistinct`) that shipped
 * without any of their own.
 *
 * Rule 1 (footnote restatement) — a RETIRED descriptive name may survive in the /lab footnote prose
 * only when it is genuinely DIFFERENT from the current label; if the label is a substring of it, it
 * is a restatement and must be gone. The registry `longLabel` IS the retired descriptive name (still
 * shipped on the wire, no longer rendered), so it is the registry-grounded source — no hand-curated
 * second table. But a blunt `prose.includes(longLabel)` FALSE-POSITIVES: a longLabel that is a plain
 * descriptive phrase (`5y5y forward inflation`, `Copper/gold ratio`) legitimately appears MID-sentence
 * in the explanatory body ("the copper/gold ratio: growth vs safety…"). What C1 actually removed was
 * a LEADING retired-name CLAUSE — "Brent crude oil (DCOILBRENTEU): <sentence>" — the name prepended
 * before the copy. So the sound test is: no footnote prose string may START with its own restatement
 * longLabel. That greens on the C1-swept corpus and reds the instant a leading clause returns.
 *
 * Rule 2 (bare id) — a raw registry id must not render as user-visible element TEXT. See the
 * describe below for the shape chosen and its honest limits.
 */
/** A `longLabel` that RESTATES its `label`: the label appears verbatim inside a strictly-longer
 *  longLabel (case-insensitive, per the plan's operational test). `HY OAS`/`HY OAS` (equal) is not a
 *  restatement — there is no retired form to drop. */
function isRestatementLongLabel(ind: { label?: string; longLabel?: string }): boolean {
  const l = String(ind.label ?? "").toLowerCase();
  const ll = String(ind.longLabel ?? "").toLowerCase();
  return !!l && !!ll && ll !== l && ll.includes(l);
}

/** Every footnote-prose string keyed by `id` across the three hand-typed tables. */
function footnoteProseFor(id: string): string[] {
  return [
    ...collectStrings((INDICATOR_DESC as Record<string, unknown>)[id]),
    ...collectStrings((MEMBER_HELP as Record<string, unknown>)[id]),
    ...collectStrings((MEMBER_DESC as Record<string, unknown>)[id]),
  ];
}

describe("Addendum C Stage C3 — Rule 1 footnote restatement guard", () => {
  const restatementInds = ALL_INDICATORS.filter(isRestatementLongLabel);

  it("no footnote prose LEADS with its indicator's retired restatement longLabel (Rule 1)", () => {
    for (const ind of restatementInds) {
      const ll = String(ind.longLabel).toLowerCase();
      for (const text of footnoteProseFor(ind.id)) {
        expect(
          text.toLowerCase().startsWith(ll),
          `${ind.id} footnote prose leads with retired name "${ind.longLabel}" — Rule 1 says drop the ` +
            `restatement clause (label "${ind.label}" ⊂ it); the bare explanation sentence stays`,
        ).toBe(false);
      }
    }
  });

  it("the Rule-1 scan examines a non-trivial restatement corpus (vacuity guard)", () => {
    const withProse = restatementInds.filter((i) => footnoteProseFor(i.id).length > 0);
    expect(withProse.map((i) => i.id)).toContain("BRENT");
  });
});

describe("Addendum C Stage C3 — Rule 2 bare-id render guard", () => {
  // SHAPE CHOSEN (stated honestly): a SOURCE scan for the ONE bare-id-in-visible-text shape that can
  // be matched soundly — `>${esc(<v>.id…)}`, an id emitted as ELEMENT TEXT (right after a `>` tag
  // close). Attributes (`data-id="${esc(m.id)}"`, `value="…"`) use `="…"`, never `>…`, so they are
  // structurally excluded; comment lines are dropped. Every such occurrence must be the sanctioned
  // exempt span (synthetic `bp-floor-id`; the method-code `cm-id`/`r-id` renders were dropped by the
  // 2026-07-25 [USER] ruling).
  //
  // What this DOES cover: the family-tile leg-chip regression (reverting `chipLabel(m.label||m.id)`
  // back to `esc(m.id)` adds a NON-exempt element-text match → red), and any new `>${esc(x.id)}`
  // element-text render.
  // What it does NOT cover: id-BESIDE-label sites that render via template concatenation
  // (`${meta.id} ${meta.label}`, `(${meta.id})`, `${m.label} · ${m.id}`) — those route through
  // `idIfDistinct`, whose de-stutter correctness is pinned directly below, but whether each SITE
  // still CALLS it is not asserted here (a source regex for "an id token in a template" cannot be
  // made non-flaky against the legit `value="${esc(m.id)}">${label}` option shape). Nor does it
  // cover aria-labels/tooltips built off `leg.dataset.id` at runtime.
  const bareIdText = /(?<![=])>\$\{esc\([a-zA-Z]+\.id[^}]*\)\}/g;
  const exemptText = new RegExp(
    `class="(?:${RULE2_ELEMENT_TEXT_EXEMPT_CLASSES.join("|")})">\\$\\{esc\\([a-zA-Z]+\\.id[^}]*\\)\\}`,
    "g",
  );

  function scanElementTextIds() {
    const bare: string[] = [];
    const exempt: string[] = [];
    for (const { file, lines } of productionPublicJs) {
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        const b = line.match(bareIdText);
        if (!b) return;
        for (const _ of b) bare.push(`${file}:${i + 1}`);
        const e = line.match(exemptText);
        for (const _ of e ?? []) exempt.push(`${file}:${i + 1}`);
      });
    }
    return { bare, exempt };
  }

  it("every bare-id element-text render is an exempt method/floor span (Rule 2)", () => {
    const { bare, exempt } = scanElementTextIds();
    // The exempt pattern is a strict refinement of the bare pattern, so exempt ⊆ bare always; they
    // are EQUAL in size iff every bare-id element-text render is exempt. A reintroduced non-exempt
    // one (e.g. legSpan → `>${esc(m.id)}`) lifts `bare` above `exempt`.
    expect(bare.length, `bare-id element-text sites: [${bare.join(", ")}]`).toBe(exempt.length);
  });

  it("the Rule-2 element-text scan is non-vacuous (vacuity guard)", () => {
    // The one live exempt render since the 2026-07-25 ruling dropped cm-id/r-id (lab.js stopped
    // rendering both): band-panel bp-floor-id. A scan matching zero would mean the pattern stopped
    // matching source it must police.
    expect(scanElementTextIds().bare.length).toBeGreaterThanOrEqual(1);
  });
});

describe("2026-07-25 ruling — retired name-sweep classes have NO live emitter (public/*.js)", () => {
  // The 47d615e sweep retired the method-card `cm-id` and rule-card `r-id` code spans (and pruned
  // their CSS) after verifying "the label already renders" by grepping ONLY public/lab.js. That
  // missed a SECOND, unrelated emitter — public/exposure-replay-chart.js's episode picker kept
  // emitting `class="cm-id"` for its "candidate" badge, which then rendered unstyled because the
  // `.chip-m .cm-id` rule was gone. The Rule-2 scan above only polices bare-id *element text*, so it
  // could not see a class-ATTRIBUTE emitter. This guard closes that gap: neither retired class name
  // may appear as a class token in ANY production public JS render string, so a re-introduced or
  // overlooked emitter reds HERE instead of shipping without styling.
  const RETIRED_SWEEP_CLASSES = ["cm-id", "r-id"];
  // Match a retired name only as a whole class token inside a class="…" attribute, so a longer
  // hyphenated neighbour never false-positives: `bp-floor-id` contains the substring `r-id`, and
  // the rename target `erp-chip-cand` is adjacent in the same file.
  const emitterRe = new RegExp(
    `class="[^"]*(?<![\\w-])(?:${RETIRED_SWEEP_CLASSES.join("|")})(?![\\w-])[^"]*"`,
  );

  function retiredClassEmitters(): string[] {
    const hits: string[] = [];
    for (const { file, lines } of productionPublicJs) {
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (emitterRe.test(line)) hits.push(`${file}:${i + 1}`);
      });
    }
    return hits;
  }

  it("neither cm-id nor r-id is emitted by any production public JS", () => {
    const hits = retiredClassEmitters();
    expect(hits, `retired name-sweep class still emitted at: [${hits.join(", ")}]`).toEqual([]);
  });

  it("the emitter scanner CAN fire, and tolerates hyphenated neighbours (machinery non-vacuity)", () => {
    // A "must be absent" guard is vacuously green if its detector never matches anything. Prove the
    // detector fires on a synthetic emitter (both retired names, bare and in a class list) and does
    // NOT fire on the longer hyphenated neighbours it must let through.
    expect(emitterRe.test('<span class="cm-id">candidate</span>')).toBe(true);
    expect(emitterRe.test('<button class="chip-m r-id">x</button>')).toBe(true);
    expect(emitterRe.test('<span class="bp-floor-id">x</span>')).toBe(false);
    expect(emitterRe.test('<span class="erp-chip-cand">x</span>')).toBe(false);
  });
});

describe("Addendum C Stage C3 — name-sync composers", () => {

  describe("chipLabel — label as one compact token (Amendment C-a)", () => {
    it.each([
      ["10y RY Δ", "10y_RY_Δ"],
      ["SMH/SPY", "SMH/SPY"],
      [undefined, ""],
    ])("chipLabel(%j) → %j", (label, out) => {
      expect(chipLabel(label)).toBe(out);
    });
  });

  describe("idIfDistinct — keep the id beside its label only when it adds information (C-b-1)", () => {
    it.each([
      ["KBE RS", "KBE_RS", ""],
      ["Brent", "BRENT", ""],
      ["HY OAS", "F1", "F1"],
      [undefined, "F1", "F1"],
      ["", "F1", "F1"],
    ])("idIfDistinct(%j, %j) → %j", (label, id, out) => {
      expect(idIfDistinct(label, id)).toBe(out);
    });
  });
});
