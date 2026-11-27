// Stage 0.2 — pins for the generic overlay strip. Plain `.js` so vitest collects it and tsc
// ignores it; no jsdom (pure string builder). Imports the seam module DIRECTLY — never lab.js,
// which has module-level DOM/localStorage side effects.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  overlayStripHtml,
  overlayRowHtml,
  overlayFieldValue,
  ddGateLineHtml,
  DD_GATE_LABEL,
  R4_PHASE_LABEL,
} from "./overlay-strip.js";
// A `public/*.test.js` importing a TS module must NOT use a `.js` specifier (frontend.md) — vite
// resolves a plain `.js` test file's specifier literally and the suite reports "no tests".
import { DD_GATE_FIELD_LABEL } from "../src/v-bear.ts";
import { R4_PHASE_FIELD_LABEL } from "../src/lab-overlays.ts";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

// Fixture `label`s are DELIBERATELY synthetic ("<id> overlay"), never a copy of the title
// api/lab.ts actually serves. This file is testing-project.md's named drift incident: hand-mirrored
// `r4View`/`r1View`/`y1View` titles went stale on a rename while the suite stayed green. A card
// title carries NO front-end contract — only `fields[].label`
// does, as the lookup key `overlayFieldValue` reads — so pinning served copy here bought nothing.
// Rule: derive from the producer, or assert only the structure the FE depends on. The producer's
// titles are inline literals inside api/lab.ts's view builders, not exported, so this file takes
// the second half: synthetic titles, and the real copy is policed by public/prose-names.test.ts.
/** Shaped like src/lab-overlays.ts's `r4View` output — real field labels, synthetic card title. */
const R4 = {
  id: "r4",
  label: "r4 overlay",
  headline: "phase: reentry",
  tone: "reentry",
  fields: [
    { label: "phase", value: "reentry" },
    { label: "re-entry rung", value: "3" },
    { label: "HY OAS", value: "4.20" },
    { label: "VIX/VIX3M", value: "1.05" },
  ],
  note: "breaker walking back",
};

describe("overlayRowHtml", () => {
  it("renders the reentry head with its ◆ marker, the fields in wire order, and the note", () => {
    const field = (l, v) => `<span class="sep">·</span> <span class="overlay-field">${l} <b>${v}</b></span>`;
    expect(overlayRowHtml(R4)).toBe(
      '<span class="overlay-row overlay-reentry"><span class="overlay-head"><span class="overlay-climb">◆</span> r4 overlay - phase: reentry</span> ' +
        [field("phase", "reentry"), field("re-entry rung", "3"), field("HY OAS", "4.20"), field("VIX/VIX3M", "1.05")].join(" ") +
        ' <span class="sep">·</span> <span class="overlay-note">breaker walking back</span></span>',
    );
  });

  // Finding 1(a): api/lab.ts emits "—" for every null (phase, reentryRung, hyOas, vt), and the
  // deleted r4TailHtml rendered the re-entry line CONDITIONALLY. Painting "re-entry rung —" is a
  // regression; the strip drops empty fields generically instead of learning R4's nulls.
  it("drops fields whose value is empty, nullish, or the '-' placeholder", () => {
    const html = overlayRowHtml({
      ...R4,
      fields: [
        { label: "phase", value: "-" },
        { label: "re-entry rung", value: null },
        { label: "HY OAS", value: "  " },
        { label: "VIX/VIX3M", value: "1.05" },
      ],
    });
    expect(html).not.toContain("re-entry rung");
    expect(html).not.toContain(">phase <b>");
    expect(html).not.toContain("HY OAS");
    // …and the field that DOES carry a value still prints, so this isn't a blanket blank-out.
    expect(html).toContain(">VIX/VIX3M <b>1.05</b>");
  });

  it("renders '' when every field is empty and there is no head or note", () => {
    expect(
      overlayRowHtml({ id: "x", fields: [{ label: "phase", value: "-" }] }),
    ).toBe("");
  });

  it("omits the note line when the overlay has nothing to say", () => {
    expect(overlayRowHtml({ ...R4, note: undefined })).not.toContain("overlay-note");
  });
});

describe("overlayStripHtml", () => {
  it("renders every overlay on the wire", () => {
    const html = overlayStripHtml({ r4: R4, y1: { ...R4, id: "y1", label: "y1 overlay" } });
    expect(html).toContain("r4 overlay");
    expect(html).toContain("y1 overlay");
  });

  it("renders '' for an absent or empty overlays record", () => {
    expect(overlayStripHtml(undefined)).toBe("");
    expect(overlayStripHtml(null)).toBe("");
    expect(overlayStripHtml({})).toBe("");
  });

  it("escapes markup in a field value - the wire is untrusted print", () => {
    const html = overlayStripHtml({
      x: { ...R4, fields: [{ label: "phase", value: "<script>alert(1)</script>" }], note: "<img>" },
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<img>");
  });
});

describe("emitted class names (Stage 1 - the r4-* rename)", () => {
  // These names are the CONTRACT with lab.css's `.df-foot .overlay-*` rules; nothing else pins
  // them, so the Stage-0.2→Stage-1 rename was invisible to a green suite until this block existed.
  it("emits only generic overlay-* hooks - no R4-specific class survives on a non-R4 row", () => {
    const y1x = { ...R4, id: "y1", label: "y1 overlay", headline: "hold - margin thin", tone: "caution" };
    const html = overlayRowHtml(y1x);
    expect(html).toContain('class="overlay-row overlay-caution"');
    expect(html).toContain('class="overlay-head"');
    expect(html).toContain('class="overlay-field"');
    expect(html).toContain('class="overlay-note"');
    // The whole point of the rename: a non-R4 row must not wear an R4 name.
    expect(html).not.toMatch(/class="[^"]*\br4-/);
  });

  it("tone drives the row's modifier class, and an unknown/absent tone falls back to neutral", () => {
    expect(overlayRowHtml({ ...R4, tone: "alert" })).toContain("overlay-row overlay-alert");
    expect(overlayRowHtml({ ...R4, tone: "neutral" })).toContain("overlay-row overlay-neutral");
    expect(overlayRowHtml({ ...R4, tone: "bogus" })).toContain("overlay-row overlay-neutral");
    // An ABSENT tone must degrade the same way as an unknown one (no junk class).
    expect(overlayRowHtml({ ...R4, tone: undefined })).toContain("overlay-row overlay-neutral");
  });

  it("no OTHER tone gets the marker - it is the re-entry signal, not decoration", () => {
    for (const tone of ["neutral", "caution", "alert"]) {
      expect(overlayRowHtml({ ...R4, tone })).not.toContain("overlay-climb");
    }
  });

  it("a reentry view with no head emits no orphan marker", () => {
    // Marker rides the head; a view with neither label nor headline must not paint a bare ◆.
    const html = overlayRowHtml({ ...R4, label: "", headline: "", tone: "reentry" });
    expect(html).not.toContain("overlay-climb");
    expect(html).toContain("overlay-field"); // the row itself still renders its fields
  });
});

describe("danger-ledger grouping (overlay redesign 2026-07-21)", () => {
  // Minimal grouped fixtures — only the fields the grouping logic reads (group + tone).
  const r4Idle = { id: "r4", label: "r4 overlay", headline: "phase: equity", tone: "neutral", fields: [{ label: "phase", value: "equity" }], group: "decision-now" };
  const r4Firing = { ...r4Idle, headline: "in cash (cash)", tone: "alert", fields: [{ label: "phase", value: "cash" }] };
  const fallIdle = { id: "fallShape", label: "fallShape overlay", headline: "shape: v-shaped", tone: "neutral", fields: [{ label: "shape", value: "v-shaped" }], group: "decision-now" };
  const r1 = { id: "r1", label: "r1 overlay", headline: "re-risk queued: r5 (S&P 500) → r3 (EM)", tone: "neutral", fields: [{ label: "dwell", value: "1/3" }], group: "decision-pending" };
  const y1x = { id: "y1", label: "y1 overlay", headline: "hold", tone: "caution", fields: [{ label: "margin", value: "-" }], group: "not-wired" };

  it("renders both section headers, DECISION LOGIC before NOT WIRED", () => {
    const html = overlayStripHtml({ r4: r4Firing, r1, y1: y1x });
    const decision = html.indexOf("DECISION LOGIC · drives the held rung");
    const notWired = html.indexOf("NOT WIRED · candidates - feed nothing today");
    expect(decision).toBeGreaterThan(-1);
    expect(notWired).toBeGreaterThan(-1);
    expect(decision).toBeLessThan(notWired);
    // The DECISION LOGIC header prints ONCE even though it covers two groups.
    expect(html.split("DECISION LOGIC").length - 1).toBe(1);
  });

  it("orders groups decision → pending → not-wired regardless of record key order", () => {
    // Feed the record in the WRONG order; the strip must still emit r4 (now) < r1 (pending) < y1.
    const html = overlayStripHtml({ y1: y1x, r1, r4: r4Firing });
    const now = html.indexOf("r4 overlay");
    const pending = html.indexOf("r1 overlay");
    const nw = html.indexOf("y1 overlay");
    expect(now).toBeGreaterThan(-1);
    expect([now, pending, nw]).toEqual([...[now, pending, nw]].sort((a, b) => a - b));
  });

  // The collapse exempts ALWAYS_RENDER_RULES (`r4`, unconditionally) and folds only the rest into
  // the idle line, which names what it folded.
  it("exempts the R4 card from the idle collapse and folds the rest into the idle line", () => {
    const html = overlayStripHtml({ r4: r4Idle, fallShape: fallIdle, y1: y1x });
    expect(html).toContain("overlay-idle");
    // The exempted R4 row paints IN FULL even though nothing is firing — this is the whole point of
    // the rung: E5's proximity-toned floor bars are reachable on a quiet day.
    expect(html).toContain("r4 overlay");
    // Its FIELDS, not just its head: a bare "phase" would also be satisfied by the headline
    // ("phase: equity"), so pin the emitted field markup itself.
    expect(html).toContain(">phase <b>equity</b>");
    // fallShape does NOT get its own row — it folds, and the idle line speaks in its headline.
    expect(html).not.toContain("fallShape overlay");
    expect(html).toContain("nothing else firing - shape: v-shaped · held at dial target");
    // "nothing ELSE" is load-bearing: the bare form would claim no companion row is on screen.
    expect(html).not.toContain("nothing firing -");
    // …and the not-wired member still renders under its own header (collapse is decision-now only).
    expect(html).toContain("y1 overlay");
    expect(html).toContain("NOT WIRED");
  });

  it("says 'nothing firing' (not 'nothing else') when no decision-now member is exempt", () => {
    // No r4 in the payload ⇒ nothing paints above the idle line ⇒ the "else" would be a lie.
    const html = overlayStripHtml({ fallShape: fallIdle, y1: y1x });
    expect(html).toContain("nothing firing - shape: v-shaped · held at dial target");
    expect(html).not.toContain("nothing else firing");
  });

  it("says 'nothing firing' when the exempt row itself renders nothing", () => {
    // Exemption is by id, but `overlayRowHtml` returns "" for a view with no head, no note and only
    // empty/"—" fields. Keying the lead off the SELECTED views would print "nothing else firing"
    // with no companion row on screen; it must key off rows actually pushed.
    const r4Blank = { id: "r4", label: "", headline: "", tone: "neutral", fields: [{ label: "phase", value: "-" }], group: "decision-now" };
    const html = overlayStripHtml({ r4: r4Blank, fallShape: fallIdle });
    expect(html).not.toContain("overlay-row overlay-neutral\">"); // non-vacuity: no r4 row painted
    expect(html).toContain("nothing firing - shape: v-shaped · held at dial target");
    expect(html).not.toContain("nothing else firing");
  });

  it("escapes a folded overlay's headline into the idle line", () => {
    // The idle line now carries SERVER data (the folded headlines), unlike the static text it
    // replaced — so it owes escaping. `<` must survive as an entity, never as raw markup.
    const html = overlayStripHtml({ fallShape: { ...fallIdle, headline: "shape: <b>x</b>" } });
    expect(html).toContain("shape: &lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("shape: <b>x</b>");
  });

  it("the idle line drops the 'held at dial target' claim when an r1 re-risk is pending", () => {
    // held-vs-target: a decision-pending re-risk means the held leg lags the target, so the collapsed
    // line must not assert "held at dial target" (the exact mislead this strip was rebuilt to kill).
    const html = overlayStripHtml({ r4: r4Idle, fallShape: fallIdle, r1 });
    expect(html).toContain("nothing else firing - shape: v-shaped · re-risk pending below");
    expect(html).not.toContain("held at dial target");
    // the pending r1 row still paints under DECISION LOGIC (only decision-now collapses). Match a
    // sub-string clear of the '&' in "S&P 500", which esc() renders as "S&amp;P".
    expect(html).toContain("re-risk queued: r5");
  });

  it("expands decision-now to full rows when ANY member fires", () => {
    // r4 fires (alert) while fallShape is idle — one firing member forces the whole section open.
    const html = overlayStripHtml({ r4: r4Firing, fallShape: fallIdle });
    expect(html).not.toContain("nothing firing");
    expect(html).toContain("r4 overlay");
    expect(html).toContain("fallShape overlay");
  });

  it("renders ungrouped overlays headerless (a pre-grouping cached payload still paints)", () => {
    const html = overlayStripHtml({ r4: R4 }); // R4 fixture carries NO group
    expect(html).toContain("r4 overlay");
    expect(html).not.toContain("DECISION LOGIC");
    expect(html).not.toContain("NOT WIRED");
  });
});

describe("overlayFieldValue", () => {
  it("reads a field by label, null when absent", () => {
    expect(overlayFieldValue(R4, "phase")).toBe("reentry");
    expect(overlayFieldValue(R4, "nope")).toBe(null);
    expect(overlayFieldValue(null, "phase")).toBe(null);
  });
});

// The fall-shape overlay needs NO new FE code: the strip is generic over
// `OverlayView` (field render, placeholder-drop and multi-overlay are each pinned above on
// the generic seam). The one regime those pins don't reach: a row whose non-headline fields
// are ALL "—" placeholders must still render its head, not vanish with them.
describe("the fallShape overlay renders through the generic strip", () => {
  it("an all-placeholder indeterminate row still paints its head", () => {
    const html = overlayRowHtml({
      id: "fallShape",
      label: "fallShape overlay",
      headline: "shape: indeterminate",
      tone: "neutral",
      fields: [
        { label: "shape", value: "indeterminate" },
        { label: "velocity", value: "-" },
        { label: "credit dwell", value: "-" },
      ],
      note: "fast <= -0.75 pp/day · grinding >= 30 closes",
    });
    expect(html).toContain("indeterminate"); // non-vacuity: the row DID render
    expect(html).not.toContain("velocity");
    expect(html).not.toContain("credit dwell");
  });
});

// The fall-shape row must NOT be absorbed into the one-line idle summary while the
// breaker is off the ladder (`r4Phase !== "equity"`, population {cash, reentry} — a `cash`-only rule
// would go dark for the whole re-entry walk). Driven through `overlayStripHtml`,
// asserting emitted HTML.
//
// ⚠ MEASURED, and load-bearing for how this reads: at `cash`/`reentry` production's `r4View` emits
// tone `alert`/`reentry` (api/lab.ts), so `isFiring` ALREADY expands the whole decision-now group and
// the fall-shape row already paints. The tests below therefore drive the phases with the tones
// production actually pairs them with — that is the user-visible guarantee — and the LAST test drives
// the exemption RULE itself with an off-ladder-but-neutral r4, which is the state a future tone
// change (or a partial cached payload) would produce. Both layers must hold.
describe("the fall-shape row survives the idle collapse while the breaker is off the ladder", () => {
  const PHASE_TONE = { equity: "neutral", cash: "alert", reentry: "reentry" };
  const r4For = (phase) => ({
    id: "r4",
    label: "r4 overlay",
    headline: phase === "cash" ? `in cash (${phase})` : `phase: ${phase}`,
    tone: PHASE_TONE[phase],
    fields: [{ label: "phase", value: phase }],
    group: "decision-now",
  });
  const fallFor = (shape, confidence) => ({
    id: "fallShape",
    label: "fallShape overlay",
    headline: `shape: ${shape} · ${confidence}`,
    // `bear` is the only shape with a non-neutral tone of its own (api/lab.ts) — the others rely
    // entirely on the promotion under test.
    tone: shape === "bear" ? "caution" : "neutral",
    fields: [{ label: "shape", value: shape }, { label: "confidence", value: `${confidence} - copy` }],
    group: "decision-now",
  });

  // r4's firing tone already expands the whole decision-now group regardless of the fall-shape
  // content, so one (shape, confidence) pair per phase carries the whole table.
  for (const phase of ["cash", "reentry"]) {
    it(`${phase}: the fall-shape row paints its own row, never the idle line`, () => {
      const html = overlayStripHtml({ r4: r4For(phase), fallShape: fallFor("indeterminate", "conflicting") });
      expect(html).toContain("fallShape overlay");
      // Its FIELDS, not just the head: an absorbed row would still leave the headline text behind.
      expect(html).toContain(">shape <b>indeterminate</b>");
      expect(html).toContain(">confidence <b>conflicting - copy</b>");
      // Nothing collapsed at all here (r4 fires), so there is no idle line to absorb anything.
      expect(html).not.toContain("overlay-idle");
    });
  }

  // The equity fold keys only on the row's TONE: `bear` fires on its own, every other shape folds.
  it("equity: bear fires on its own tone - the group expands, exactly as before Stage 6", () => {
    const html = overlayStripHtml({ r4: r4For("equity"), fallShape: fallFor("bear", "measured") });
    expect(html).toContain("fallShape overlay");
    expect(html).not.toContain("overlay-idle");
    // The r4 row itself still paints (E10a) — non-vacuity for the branch above.
    expect(html).toContain(">phase <b>equity</b>");
  });

  it("equity: a non-bear shape keeps today's fold behaviour (headline verbatim on the idle line)", () => {
    const html = overlayStripHtml({ r4: r4For("equity"), fallShape: fallFor("indeterminate", "dark") });
    expect(html).not.toContain("fallShape overlay");
    expect(html).toContain("nothing else firing - shape: indeterminate · dark · held at dial target");
    expect(html).toContain(">phase <b>equity</b>");
  });

  it("the exemption RULE covers reentry as well as cash, on an off-ladder-but-quiet r4", () => {
    // Defense in depth: strip r4's firing tone away (a future tone change / a partial cached
    // payload) and the promotion must still hold for BOTH off-ladder phases — this is the
    // assertion that goes red if the predicate is narrowed to `phase === "cash"`.
    for (const phase of ["cash", "reentry"]) {
      const html = overlayStripHtml({
        r4: { ...r4For(phase), tone: "neutral" },
        fallShape: fallFor("indeterminate", "conflicting"),
      });
      expect(html, phase).toContain("overlay-idle"); // non-vacuity: the collapse branch DID run
      expect(html, phase).toContain("fallShape overlay");
      expect(html, phase).toContain(">confidence <b>conflicting - copy</b>");
      // …and the idle line no longer speaks in its headline, because the row is on screen.
      expect(html, phase).not.toContain("shape: indeterminate · conflicting ·");
    }
  });
});

/* ── the always-visible dd-gate line ─────────────────────────────────────────────────────────── */
describe("dd-gate line", () => {
  // `fallShape` on a BENIGN v-shaped fall with the breaker in equity: tone neutral (only `bear`
  // fires) and NOT exempt from the collapse (`ALWAYS_RENDER_RULES`' fallShape predicate needs
  // phase !== "equity"). So the row folds into the idle line and its fields vanish — while
  // `drawdownGateWouldFire("v-shaped")` is TRUE. That is the hazard the line exists for, so it is
  // the fixture every assertion below runs on.
  const r4Equity = {
    id: "r4", label: "r4 overlay", headline: "phase: equity", tone: "neutral",
    fields: [{ label: "phase", value: "equity" }], group: "decision-now",
  };
  const fallVBenign = {
    id: "fallShape", label: "fallShape overlay", headline: "shape: v-shaped · confident",
    tone: "neutral", group: "decision-now",
    fields: [
      { label: "shape", value: "v-shaped" },
      { label: DD_GATE_LABEL, value: "would fire" },
    ],
  };

  it("the FE's lookup labels ARE the producer's constants", () => {
    // The only link between api/lab.ts's emitted field labels and this browser module's literals.
    // Rename either producer constant and the FE's row lookup silently stops matching — this reds.
    expect([DD_GATE_LABEL, R4_PHASE_LABEL]).toEqual([DD_GATE_FIELD_LABEL, R4_PHASE_FIELD_LABEL]);
  });

  it("survives the idle collapse that swallows the fall-shape row on a benign v-shaped fall", () => {
    const html = overlayStripHtml({ r4: r4Equity, fallShape: fallVBenign });
    // Non-vacuity: the collapse DID run and DID swallow the row carrying the field.
    expect(html).toContain("overlay-idle");
    expect(html).not.toContain("fallShape overlay");
    expect(html).not.toContain(">shape <b>v-shaped</b>");
    // …and the gate's state is on screen anyway.
    expect(html).toContain(`>${DD_GATE_LABEL} <b>would fire</b>`);
  });

  // On `phase: "equity"` the fall-shape row folds away, hiding any DOUBLE render.
  // Off `equity` the row is exempt from the collapse (`ALWAYS_RENDER_RULES`), expands, and its
  // field loop painted the same label+value the standalone line already carries, two rows apart.
  it("phase cash → the gate is on screen EXACTLY once, never in both the line and the row", () => {
    const r4Cash = {
      id: "r4", label: "r4 overlay", headline: "in cash", tone: "neutral",
      fields: [{ label: "phase", value: "cash" }], group: "decision-now",
    };
    const html = overlayStripHtml({ r4: r4Cash, fallShape: fallVBenign });
    // Non-vacuity: the fall-shape row DID expand (this is the exempt branch, not the collapse).
    expect(html).toContain("fallShape overlay");
    expect(html).toContain(">shape <b>v-shaped</b>");
    expect(html).toContain("overlay-ddgate");
    expect(html.split(`>${DD_GATE_LABEL} <b>would fire</b>`).length - 1).toBe(1);
    // …and the surviving one is the standalone line, not the row's field.
    expect(html.indexOf(DD_GATE_LABEL)).toBeLessThan(html.indexOf("fallShape overlay"));
  });

  it("the row keeps the field when NO standalone line renders (nothing else carries it)", () => {
    // Suppression is conditional on the line actually painting: an empty/"—" gate value means
    // no line, and the row must not lose a field to a suppressor guarding nothing.
    const r4Cash = {
      id: "r4", label: "r4 overlay", headline: "in cash", tone: "neutral",
      fields: [{ label: "phase", value: "cash" }], group: "decision-now",
    };
    const noGate = { ...fallVBenign, fields: [{ label: "shape", value: "v-shaped" }] };
    const html = overlayStripHtml({ r4: r4Cash, fallShape: noGate });
    expect(html).not.toContain("overlay-ddgate");
    expect(html).toContain(">shape <b>v-shaped</b>");
  });

  it("sits OUTSIDE every group - ahead of the first section head", () => {
    const html = overlayStripHtml({ r4: r4Equity, fallShape: fallVBenign });
    const line = html.indexOf("overlay-ddgate");
    const firstHead = html.indexOf("overlay-group-head");
    expect(line).toBeGreaterThan(-1);
    expect(firstHead).toBeGreaterThan(-1);
    expect(line).toBeLessThan(firstHead);
  });

  it("prints the server's value VERBATIM - no FE spelling of the gate's semantics", () => {
    // `off` must render too: a line that appears only when the gate is armed teaches the reader
    // that a missing line means "not measured", which is the ambiguity §3 removes.
    const off = { ...fallVBenign, fields: [{ label: DD_GATE_LABEL, value: "off" }] };
    expect(overlayStripHtml({ r4: r4Equity, fallShape: off })).toContain(
      `>${DD_GATE_LABEL} <b>off</b>`,
    );
    // An unrecognised value is printed, not judged — this module never compares the string.
    const odd = { ...fallVBenign, fields: [{ label: DD_GATE_LABEL, value: "clipped" }] };
    expect(overlayStripHtml({ r4: r4Equity, fallShape: odd })).toContain(
      `>${DD_GATE_LABEL} <b>clipped</b>`,
    );
  });

  it("renders nothing when no overlay carries the field, and escapes the value", () => {
    // Scenario/replay carry no fallShape overlay at all; a pre-W5-e cached payload carries no row.
    expect(overlayStripHtml({ r4: r4Equity })).not.toContain("overlay-ddgate");
    expect(ddGateLineHtml([])).toBe("");
    // "—" is api/lab.ts's null placeholder — an empty field is an absent field here too.
    expect(ddGateLineHtml([{ ...fallVBenign, fields: [{ label: DD_GATE_LABEL, value: "-" }] }])).toBe("");
    const esc = ddGateLineHtml([{ ...fallVBenign, fields: [{ label: DD_GATE_LABEL, value: "<b>x</b>" }] }]);
    expect(esc).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(esc).not.toContain("<b>x</b></b>");
  });

  describe("host slot", () => {
    // Comments stripped: lab.css's prose names retired `.r4-*` classes.
    const labCss = readFileSync(here("./lab.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

    it("the styled rule is scoped to the host lab.js actually injects the strip into", () => {
      // `.df-foot .overlay-ddgate` is a DESCENDANT selector: it paints only if `#dfFoot` also
      // carries `class="df-foot"`. dangerFieldSkeletonHtml (lab-board.js, the shared skeleton
      // producer lab.js interpolates) builds that element; read it as a FILE (never import —
      // it has module-level DOM side effects, `.claude/rules/frontend.md`).
      expect(/\.df-foot\s+\.overlay-ddgate(?![\w-])/.test(labCss)).toBe(true);
      const labJs = readFileSync(here("./lab-board.js"), "utf8");
      expect(labJs).toMatch(/class="df-foot"\s+id="dfFoot"/);
    });
  });
});

/* ── characterization (ai-debt sweep 5.10a) ──────────────────────────────────────────────────── */
// Pins the WHOLE strip's markup across the decision-now collapse branch's inputs — exempt row
// painted / blank / absent, folded headlines present / absent / mixed, a decision-pending r1 on or
// off, the dd-gate suppress set threaded into the exempt row — so extracting the branch into a
// helper must reproduce every byte. Snapshots live in public/__snapshots__/ (.vercelignore'd).
describe("overlayStripHtml decision-now collapse (characterization)", () => {
  const now = (o) => ({ tone: "neutral", group: "decision-now", ...o });
  const r4 = now({ id: "r4", label: "r4 overlay", headline: "phase: equity", fields: [{ label: R4_PHASE_LABEL, value: "equity" }] });
  const r4Cash = { ...r4, headline: "in cash", fields: [{ label: R4_PHASE_LABEL, value: "cash" }] };
  const r4Blank = now({ id: "r4", label: "", headline: "", fields: [{ label: R4_PHASE_LABEL, value: "-" }] });
  const fall = now({ id: "fallShape", label: "fallShape overlay", headline: "shape: v-shaped", fields: [{ label: "shape", value: "v-shaped" }, { label: DD_GATE_LABEL, value: "would fire" }] });
  const extra = now({ id: "x9", label: "x9 overlay", headline: "x9 <quiet>", fields: [{ label: "k", value: "v" }] });
  const mute = now({ id: "m1", label: "m1 overlay", headline: "", fields: [{ label: "k", value: "v" }] });
  const r1 = { id: "r1", label: "r1 overlay", headline: "re-risk queued", tone: "neutral", fields: [{ label: "dwell", value: "1/3" }], group: "decision-pending" };
  const cases = {
    "exempt r4 + folded fall": { r4, fallShape: fall },
    "exempt r4 + folded fall + pending r1": { r4, fallShape: fall, r1 },
    "blank exempt r4 + folded fall": { r4: r4Blank, fallShape: fall },
    "no exempt, folded fall": { fallShape: fall },
    "folded headline-less only": { m1: mute },
    "folded headline-less only + pending r1": { m1: mute, r1 },
    "mixed folded headlines, escaped": { r4, fallShape: fall, m1: mute, x9: extra },
    "cash: fallShape exempt, dd-gate suppressed in its row": { r4: r4Cash, fallShape: fall, x9: extra },
    "only exempt rows, nothing folded": { r4 },
  };
  for (const [name, overlays] of Object.entries(cases)) {
    it(name, () => {
      const html = overlayStripHtml(overlays);
      expect(html).toContain("overlay-idle"); // non-vacuity: every case runs the collapse branch
      expect(html).toMatchSnapshot();
    });
  }
});
