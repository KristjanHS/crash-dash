// Coverage guard for the per-indicator explainer copy. The prose lives in a
// DOM-free data module (indicator-desc.js, keyed by indicator id); the detail
// picker (app.js) lists EVERY ALL_INDICATORS id with no channel filter, so any
// id without an entry renders a blank explainer. This is exactly how the SLOW/
// PENSION ids shipped textless. Plain `.js` so vitest's default glob collects it
// while `tsc` ignores it (frontend.md); it imports the real TS registry so a
// future indicator added without prose fails `npm run check` instead of shipping.
import { describe, it, expect } from "vitest";
import { INDICATOR_DESC } from "./indicator-desc.js";
// NB: `.ts` specifier (not the project's usual `.js`) — vitest resolves it, and
// this `.js` test is invisible to tsc, so the prod `.js`-extension rule (which
// guards real Node ESM resolution) does not apply here.
import { ALL_INDICATORS } from "../src/registry.ts";
import { CHART_ONLY_INDICATORS } from "../src/registry-composite.ts";
import { MEMBER_WEIGHT } from "../src/danger-ladder.ts";
import { withLabels } from "./detail-tab.js";

// The CARDED population, not `ALL_INDICATORS`: the chart-only ids (`CHART_ONLY_INDICATORS` — VTP)
// are served by /api/indicators too, so they get a card, a tooltip and a detail explainer exactly
// like a scored id — and would ship textless under the narrower set, which is the very failure mode
// this guard exists for.
const CARDED = [...ALL_INDICATORS, ...CHART_ONLY_INDICATORS];
const CHART_ONLY_IDS = new Set(CHART_ONLY_INDICATORS.map((m) => m.id));

// D3/D4 word caps: `why` is the causal chain (who acts, why it moves before equity damage),
// `lies` the known failure modes. Pinned here so the caps have one source.
const WHY_MAX_WORDS = 60;
const LIES_MAX_WORDS = 50;
const WITH_MAX_WORDS = 40;
const TOKEN = /\{([A-Za-z0-9_-]+)\}/g;

describe("INDICATOR_DESC coverage", () => {
  it("every carded id has an explainer entry", () => {
    const missing = CARDED.filter((m) => !INDICATOR_DESC[m.id]).map((m) => m.id);
    expect(missing).toEqual([]);
  });

  // `with` names siblings by `{ID}` token — the token set is what keeps the copy from rotting the
  // way the old engine claims did (X1): a retired or misspelt id fails here, and the render site
  // substitutes the SERVED label. Mandatory for the whole CARDED population, chart-only included.
  it("every carded entry carries a with paragraph: <= 40 words, >= 2 sibling tokens, all real ids, never itself", () => {
    const ids = new Set(CARDED.map((m) => m.id));
    const words = (v) => v.split(/\s+/).filter(Boolean).length;
    const offenders = [];
    for (const id of CARDED.map((m) => m.id)) {
      const w = INDICATOR_DESC[id]?.with;
      if (typeof w !== "string") {
        offenders.push(`${id}: no with`);
        continue;
      }
      const tokens = [...w.matchAll(TOKEN)].map((t) => t[1]);
      if (words(w) > WITH_MAX_WORDS) offenders.push(`${id}.with (${words(w)} words)`);
      if (new Set(tokens).size < 2) offenders.push(`${id}.with (${tokens.length} tokens)`);
      if (tokens.includes(id)) offenders.push(`${id}.with names itself`);
      for (const t of tokens) if (!ids.has(t)) offenders.push(`${id}.with {${t}} is not a carded id`);
    }
    expect(offenders).toEqual([]);
  });

  // The render helper: tokens become the served label, everything else is esc'd, an unknown id
  // stays bare — so a `{`-bearing prose typo can never render raw markup.
  it("withLabels substitutes served labels and escapes the rest", () => {
    const metas = [{ id: "F3", label: "NFCI leverage" }];
    expect(withLabels("{F3} first, {ZZ} <b>second</b>", metas)).toBe("NFCI leverage first, ZZ &lt;b&gt;second&lt;/b&gt;");
  });

  // The file's own header rule: cut values live in the registry and reach the user as the chart's
  // band labels, never re-typed into this prose — a retyped number silently rots on the next retune.
  // Day-count forms added batch 4: window constants typed as day-counts (`20-day`, `63 trading
  // days`) rot on a re-horizon exactly like cut values.
  it("no top-level string field hand-types a cut value or day-count", () => {
    const CUT_NUMBER = /\d+(\.\d+)?\s?%|std-dev|\u03c3| days is (Amber|Red)|\d+[- ]?(?:trading[- ])?days?\b/i;
    const offenders = [];
    for (const [id, d] of Object.entries(INDICATOR_DESC)) {
      for (const [field, v] of Object.entries(d)) {
        if (field === "links" || typeof v !== "string") continue;
        // The uppercase `NN-TRADING-DAY` pin (derived from velocityWindow, F9/F11) is the ONLY allowed window mention.
        if (CUT_NUMBER.test(v.replace(/\b\d+-TRADING-DAY\b/g, ""))) offenders.push(`${id}.${field}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every tip is a tooltip, not a paragraph (X4: <= 20 words)", () => {
    const offenders = Object.entries(INDICATOR_DESC)
      .filter(([, d]) => d.tip.split(/\s+/).filter(Boolean).length > 20)
      .map(([id, d]) => `${id} (${d.tip.split(/\s+/).filter(Boolean).length} words)`);
    expect(offenders).toEqual([]);
  });

  // D3/D4 caps over the whole CARDED population. `lies` is mandatory for every id outside
  // CHART_ONLY_INDICATORS (D4), optional — but still capped when present — for chart-only ids.
  it("every entry respects the why/lies word caps; lies mandatory outside chart-only (D3/D4)", () => {
    const words = (v) => v.split(/\s+/).filter(Boolean).length;
    const offenders = CARDED.flatMap((m) => {
      const d = INDICATOR_DESC[m.id];
      const out = [];
      if (words(d.why) > WHY_MAX_WORDS) out.push(`${m.id}.why (${words(d.why)} words)`);
      if (!CHART_ONLY_IDS.has(m.id) && typeof d.lies !== "string") out.push(`${m.id}: no lies`);
      if (d.lies && words(d.lies) > LIES_MAX_WORDS) out.push(`${m.id}.lies (${words(d.lies)} words)`);
      return out;
    });
    expect(offenders).toEqual([]);
  });

  // The card copy is the surface the user reads the hand-set cuts off, and no gate can see it:
  // `tsc` ignores this file and the goldens never render prose. A window move that leaves the copy
  // naming the old span is exactly what this guard catches.
  const WINDOW_OVERRIDERS = CARDED.filter((m) => m.velocityWindow != null);
  const proseOf = (id) => Object.values(INDICATOR_DESC[id]).flatMap((v) => (typeof v === "string" ? [v] : Object.values(v))).join(" ");

  it("no id with its OWN velocity window has explainer copy still naming the global 20", () => {
    // Vacuity anchor: the override set must be non-empty AND must contain the ids this class is
    // about, so a registry refactor that drops `velocityWindow` cannot turn the sweep into a no-op.
    expect(WINDOW_OVERRIDERS.map((m) => m.id)).toEqual(expect.arrayContaining(["F1", "F3", "F9", "F11"]));
    const stale = WINDOW_OVERRIDERS.filter((m) => /\b20[\s-](?:trading[\s-])?days?\b/i.test(proseOf(m.id))).map((m) => m.id);
    expect(stale).toEqual([]);
  });

  it("F9's explainer names the span the registry actually scores", () => {
    // Derived from the constant, never re-typed: a re-horizon moves the copy check with it.
    const f9 = CARDED.find((m) => m.id === "F9");
    expect(INDICATOR_DESC.F9.why).toContain(`${f9.velocityWindow}-TRADING-DAY`);
  });

  // The mirror, for the same class one id over. The sweep above only catches copy still naming the
  // GLOBAL 20 — prose naming no span at all passes it, so this positive pin is what makes the span's
  // presence load-bearing.
  it("F11's explainer names the span the registry actually scores", () => {
    const f11 = CARDED.find((m) => m.id === "F11");
    expect(INDICATOR_DESC.F11.why).toContain(`${f11.velocityWindow}-TRADING-DAY`);
  });

  // Member-role ids NOT scored through the directional indicator fold — the SLOW channel legs,
  // scored in src/slow.ts (same-day symmetric, or the slowCalm fold for complacency-duration).
  // With the engine line gone (slice 2b) nothing generic states a fold, so each of these ids
  // MUST say its own in `lies`. Set derived (MEMBER_WEIGHT ∩ SLOW), anchored on one named member
  // so the sweep cannot go vacuous.
  it("every SLOW member id states its own fold in lies", () => {
    const slowMembers = ALL_INDICATORS.filter((m) => m.channel === "SLOW" && m.id in MEMBER_WEIGHT).map((m) => m.id);
    expect(slowMembers).toContain("complacency-duration");
    const noteless = slowMembers.filter((id) => typeof INDICATOR_DESC[id]?.lies !== "string");
    expect(noteless).toEqual([]);
    // "fold-stating", not just present: each must actually speak to confirmation behaviour.
    const silent = slowMembers.filter((id) => !/fold|closes/i.test(INDICATOR_DESC[id].lies));
    expect(silent).toEqual([]);
  });

  it("has no orphan entries for ids absent from the registry", () => {
    const ids = new Set(CARDED.map((m) => m.id));
    const orphans = Object.keys(INDICATOR_DESC).filter((k) => !ids.has(k));
    expect(orphans).toEqual([]);
  });
});
