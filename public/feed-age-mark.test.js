/*
 * The DASHBOARD feed-lag marks (`feed-age-mark.js`) — the card mark and the family-heading roll-up.
 *
 * The discriminating regimes pinned here, each of which a plausible implementation gets wrong:
 *   - the WEAK CLAIM: no rendered string may say "deep lag"/"dark"/"broken" — /api/status measures
 *     `lag`, not the /lab LAG-vs-DEEP-LAG tier, and asserting one would be the
 *     substitute-a-value-for-an-absence defect this whole area exists to remove. It binds the
 *     `LEGEND.feedLag`/`feedFresh` pill tooltips in `app.js` as well as the marks' own titles —
 *     same claim, same surface, and sweeping only the titles left half the copy unguarded;
 *   - `ageDays` null/absent renders `—`, never `0d`;
 *   - fresh / no-reading ⇒ `null`, i.e. an empty slot, never a `⌁ 0d` or `⌁⁰`;
 *   - the live EU2 case: a family whose `verdictHoldIds` is `[]` still gets a heading mark;
 *   - class parity (`.claude/rules/frontend.md`): every class these strings emit resolves to a
 *     selector in styles.css — index.html has no scoped <style>, so an unstyled class ships
 *     invisible with the markup test green.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { cardLagMark, familyLagCountMark, feedsBehindPill, intradayMark, intradayMarkLabel, intradayVerdictChip, lastPrintLabel, lastPrintMark } from "./feed-age-mark.js";

const STYLES = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

// Words that would claim a tier /api/status never measured, plus the incident vocabulary the plan
// forbids ("this feed is behind", not "something is broken here").
const FORBIDDEN = /(\bdeep[ -]lag\b|\b(dark|rot|broken|fault|error|failing)\b)/i;

describe("cardLagMark - the per-card mark", () => {
  // The SERVED unit prints as-is; a missing unit renders `N?` and a null/absent age `-`, never `Nd`/`0d`.
  it.each([
    [9, "slots", 9, "9 slots"],
    [40, "days", 40, "40d"],
    [1, "slots", 1, "1 slot"],
    [2, "slots", 2, "2 slots"],
    [2, undefined, 2, "2?"],
    [null, "slots", null, "-"],
    [undefined, undefined, null, "-"],
  ])("ageDays=%s unit=%s renders days=%s, text %s in badge and sentence", (ageDays, unit, days, text) => {
    const mark = cardLagMark({ indicatorId: "EU2", date: "2026-07-24", ageDays, unit, lag: true });
    expect(mark.days).toBe(days);
    expect(mark.text).toBe(text);
    expect(mark.html).toBe(`<span class="card-lag" title="${mark.title}">⌁ ${text}</span>`);
    expect(mark.title).toContain(`feed behind - newest observation is ${text} old.`);
    expect(mark.title).not.toMatch(FORBIDDEN);
  });

  it("stays null on a fresh reading and on no reading at all (empty slot, never ⌁ 0d)", () => {
    expect(cardLagMark({ ageDays: 0, lag: false })).toBeNull();
    expect(cardLagMark(undefined)).toBeNull();
    expect(cardLagMark(null)).toBeNull();
  });
});

describe("familyLagCountMark - the per-family heading roll-up", () => {
  // The live case: EU2 was GREEN while `credit` was AMBER, so `verdictHoldIds` was []
  // and `coverageDegraded` false on the very day the feed had been dark nine days. The heading
  // mark must fire anyway — the whole reason this seam exists.
  const credit = [
    { id: "F1", label: "HY OAS", state: "AMBER", lag: false, ageDays: 1 },
    { id: "F2", label: "IG OAS", state: "AMBER", lag: false, ageDays: 1 },
    { id: "EU2", label: "SovCISS FR", state: "GREEN", lag: true, ageDays: 9, unit: "slots" },
  ];

  it("fires for the lagging member of an otherwise-fresh family (the verdictHoldIds-blind case)", () => {
    const mark = familyLagCountMark(credit);
    expect(mark.count).toBe(1);
    expect(mark.ids).toEqual(["EU2"]);
    expect(mark.html).toContain('class="chan-lag"');
    expect(mark.html).toContain("<sup class=\"chan-lag-n\">1</sup>");
    // Rule 2 (prose-names): the id never renders bare — it is paired with the served label.
    expect(mark.which).toBe("EU2 SovCISS FR · 9 slots");
    expect(mark.title).toContain("1 feed is behind");
  });

  it("counts LAGGING MEMBERS, not families, and names each with its own age", () => {
    const mark = familyLagCountMark([
      ...credit,
      { id: "F13", label: "HYG/LQD", lag: true, ageDays: null, unit: "slots" },
    ]);
    expect(mark.count).toBe(2);
    expect(mark.html).toContain("<sup class=\"chan-lag-n\">2</sup>");
    // F13 has a null age ⇒ `-` regardless of unit; EU2 carries its served slot unit.
    expect(mark.which).toBe("EU2 SovCISS FR · 9 slots · F13 HYG/LQD · -");
    expect(mark.title).toContain("2 feeds are behind");
  });

  it("stays null for a clean family and degrades to null on a missing member list", () => {
    expect(familyLagCountMark(credit.slice(0, 2))).toBeNull();
    expect(familyLagCountMark([])).toBeNull();
    expect(familyLagCountMark(undefined)).toBeNull();
  });

  it("claims a COUNT, never a tier - no deep-lag/incident vocabulary", () => {
    expect(familyLagCountMark(credit).title).not.toMatch(FORBIDDEN);
  });
});

describe("the WEAK CLAIM binds the legend copy too, not only the mark titles", () => {
  // `LEGEND.feedLag`/`feedFresh` (`public/app.js`) are the tooltips on the feed-age PILLS beside
  // these marks — user-visible copy making the same claim about the same measurement, and it was
  // covered by nothing while the mark titles were swept. `app.js` executes DOM/`localStorage` side
  // effects at import and can never be imported from a test, so the strings are read out of source.
  const APP = readFileSync(fileURLToPath(new URL("./app.js", import.meta.url)), "utf8");
  const legend = (key) => {
    const m = new RegExp(`\\b${key}:\\s*"([^"]*)"`).exec(APP);
    // Non-vacuity: a renamed key or a re-quoted string must red HERE, not pass an empty sweep.
    expect(m, `LEGEND.${key} not found in public/app.js`).not.toBeNull();
    expect(m[1].length).toBeGreaterThan(20);
    return m[1];
  };

  // The key list is DERIVED from `app.js`'s own LEGEND block, never hand-enumerated: this arc's
  // `feedsBehind` was the proof that a hand-listed sweep skips the next key added (it shipped
  // unswept until the list was edited by hand). Any future `feed*` legend is swept the day it lands.
  const LEGEND_BLOCK = (() => {
    const start = APP.indexOf("const LEGEND = {");
    expect(start, "the LEGEND block is found in public/app.js").toBeGreaterThan(-1);
    const end = APP.indexOf("\n};", start);
    expect(end, "the LEGEND block terminates").toBeGreaterThan(start);
    return APP.slice(start, end);
  })();
  const FEED_LEGEND_KEYS = [...LEGEND_BLOCK.matchAll(/^ {2}(feed[A-Za-z0-9]*):/gm)].map((m) => m[1]);

  it("sweeps EVERY feed-copy legend key app.js declares - no tier, no incident vocabulary", () => {
    // Non-vacuity: the derivation must actually find the three shipped keys. A broken block slice or
    // a regex that matches nothing reds here rather than sweeping an empty list.
    expect(FEED_LEGEND_KEYS).toEqual(expect.arrayContaining(["feedFresh", "feedLag", "feedsBehind"]));
    for (const key of FEED_LEGEND_KEYS) expect(legend(key), `LEGEND.${key}`).not.toMatch(FORBIDDEN);
  });

  it("the per-feed pill legend says 'behind' - the sanctioned word", () => {
    expect(legend("feedsBehind")).toMatch(/\bbehind\b/);
  });
});

describe("feedsBehindPill - the zone-A per-feed pill", () => {
  const LEG = "Per-feed count - how many feeds are behind their own cut.";

  // The DISCRIMINATING case the whole plan exists for: the run-wide heartbeat can read fresh
  // (one current feed sets `verdict.date`) while most of the roster is behind. The pill must
  // print the DENOMINATOR, or "3 behind" is unreadable against a ~70-id roster.
  it("prints 'N of M behind' and names the lagging ids in its tooltip", () => {
    const pill = feedsBehindPill(
      { feedsLagging: 3, laggingFeedIds: ["EU2", "F13", "AT1"], feedsTotal: 70 },
      LEG,
    );
    expect(pill.lag).toBe(true);
    expect(pill.count).toBe(3);
    expect(pill.text).toBe("⌁ 3 of 70 feeds behind");
    expect(pill.html).toContain('class="pill pill-lag"');
    expect(pill.title).toContain(LEG);
    expect(pill.title).toContain("Behind: EU2 · F13 · AT1.");
    expect(pill.title).not.toMatch(FORBIDDEN);
  });

  it("caps the named ids and states the remainder as a count (no 70-id title dump)", () => {
    const ids = Array.from({ length: 24 }, (_, i) => `X${i + 1}`);
    const pill = feedsBehindPill({ feedsLagging: 24, laggingFeedIds: ids, feedsTotal: 70 }, LEG);
    expect(pill.text).toBe("⌁ 24 of 70 feeds behind");
    expect(pill.title).toContain("X10 … +14 more.");
    expect(pill.title).not.toContain("X11");
  });

  // Ruled contract 2: ANY id past its own cut, no count threshold. Only the count-of-ONE fixture
  // distinguishes that from a "2+ feeds" threshold — every larger fixture passes under both.
  it("goes lagging on a SINGLE late feed - no count threshold", () => {
    const pill = feedsBehindPill({ feedsLagging: 1, laggingFeedIds: ["EU2"], feedsTotal: 70 }, LEG);
    expect(pill.lag).toBe(true);
    expect(pill.text).toBe("⌁ 1 of 70 feeds behind");
    expect(pill.html).toContain('class="pill pill-lag"');
  });

  // `feedsLagging` and `laggingFeedIds` are INDEPENDENT wire fields (the server derives both from one
  // expression, but an older cached payload — or any future skew — can pair "3 behind" with one id).
  // The tooltip must not present one name under a claim of three as a COMPLETE list: the remainder
  // is measured against the printed COUNT, never against `ids.length`.
  it("names the remainder against the printed count when the two wire fields skew", () => {
    const pill = feedsBehindPill({ feedsLagging: 3, laggingFeedIds: ["EU2"], feedsTotal: 70 }, LEG);
    expect(pill.text).toBe("⌁ 3 of 70 feeds behind");
    expect(pill.title).toContain("Behind: EU2 … +2 more.");
  });

  // Rule 2's SPIRIT (`public/prose-names.test.ts`): a registry id never stands alone as prose. Note
  // that guard is a source scan for `>${esc(x.id)}` — element text only, attributes structurally
  // excluded by its own design — so it never covered this `title=` and still doesn't. The tooltip was
  // the last place a bare id could surface on the dashboard, because `freshnessFrom`'s roster covers
  // the composite components that `api/status.ts` strips from `readings`.
  //
  // Three regimes in one fixture. The exact-join assertion is the discriminating one — the three
  // `toContain`s alone are NOT: a naive `${id} ${lab}` join still satisfies (a) and (c), rendering
  // `CMP_FXH_DEXUSEU undefined`. Keep the join assertion or this test stops pinning composition.
  it("pairs each named id with its served label, per idIfDistinct", () => {
    const pill = feedsBehindPill(
      { feedsLagging: 3, laggingFeedIds: ["EU2", "OVX", "CMP_FXH_DEXUSEU"], feedsTotal: 75 },
      LEG,
      { EU2: "EA lending", OVX: "OVX" },
    );
    // (a) label genuinely distinct from the id ⇒ both render.
    expect(pill.title).toContain("EU2 EA lending");
    // (b) label restates the id ⇒ the id drops, no `OVX OVX` stutter.
    expect(pill.title).toContain("OVX");
    expect(pill.title).not.toContain("OVX OVX");
    // (c) a component id `/api/indicators` does not carry ⇒ keeps its bare id rather than vanishing.
    expect(pill.title).toContain("CMP_FXH_DEXUSEU");
    expect(pill.title).toContain("Behind: EU2 EA lending · OVX · CMP_FXH_DEXUSEU.");
    // Display-only: the pairing cannot move the count, which comes off the wire field.
    expect(pill.count).toBe(3);
    expect(pill.text).toBe("⌁ 3 of 75 feeds behind");
    expect(pill.title).not.toMatch(FORBIDDEN);
  });

  // ⚠ This does NOT discriminate slice-before-map from map-before-slice — those are byte-identical
  // output, so no mutation of that ordering can red it. What it DOES pin, and what nothing else
  // covers: with labels present the remainder still counts IDS (`+2 more`, not a name-length
  // budget), and a capped-out id stays absent from the title.
  it("keeps the remainder an ID count when labels are present", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `X${i + 1}`);
    const labels = Object.fromEntries(ids.map((id) => [id, `long label for ${id}`]));
    const pill = feedsBehindPill({ feedsLagging: 12, laggingFeedIds: ids, feedsTotal: 75 }, LEG, labels);
    expect(pill.title).toContain("X10 long label for X10 … +2 more.");
    expect(pill.title).not.toContain("X11");
  });

  it("stays a pill at zero - the clean roster is the reassuring read, not an empty slot", () => {
    const pill = feedsBehindPill({ feedsLagging: 0, laggingFeedIds: [], feedsTotal: 70 }, LEG);
    expect(pill.lag).toBe(false);
    expect(pill.text).toBe("0 of 70 feeds behind ✓");
    expect(pill.html).toContain('class="pill pill-fresh"');
  });

  it("appends '· K unmeasured' only when K > 0, keeping the word 'behind'", () => {
    const withUn = feedsBehindPill(
      { feedsLagging: 3, laggingFeedIds: ["EU2", "F13", "AT1"], feedsTotal: 70, unmeasuredFeedIds: ["BRENT", "OVX"] },
      LEG,
    );
    expect(withUn.text).toBe("⌁ 3 of 70 feeds behind · 2 unmeasured");
    expect(withUn.text).toMatch(/\bbehind\b/);
    // K = 0, and an old cached payload with NO such field, both render no clause (guard intact).
    expect(
      feedsBehindPill({ feedsLagging: 3, laggingFeedIds: ["EU2", "F13", "AT1"], feedsTotal: 70, unmeasuredFeedIds: [] }, LEG).text,
    ).toBe("⌁ 3 of 70 feeds behind");
  });

  it("renders NO pill when the wire fields are absent, never a fabricated 0 of 0", () => {
    expect(feedsBehindPill(undefined, LEG)).toBeNull();
    expect(feedsBehindPill({ lag: true, feedAgeDays: 9 }, LEG)).toBeNull();
    expect(feedsBehindPill({ feedsLagging: 0, feedsTotal: 0 }, LEG)).toBeNull();
  });
});

describe("intradayMark - the B5/B7 INTRADAY label", () => {
  it("labels a provisional row INTRADAY with its date in the title", () => {
    const html = intradayMark({ provisional: true }, "2026-06-26");
    expect(html).toContain('class="intraday-mark"');
    expect(html).toContain(">INTRADAY</span>");
    expect(html).toContain("INTRADAY · 2026-06-26");
    // N2: same-day finals (JPT, EU ETFs, index EODs) also land here — never claim a "live price".
    expect(html).toContain("provisional until the EOD close");
    expect(html).not.toContain("live price");
  });

  it("renders nothing for an EOD row or a missing one", () => {
    expect(intradayMark({ state: "RED" }, "2026-06-26")).toBe("");
    expect(intradayMark(undefined, undefined)).toBe("");
  });

  // Both consumers import DOM side effects, so pin the wiring by source scan (comment lines excluded).
  it("the /status card paints the badge; the /lab member chip folds the clause into its tooltip only (2026-09-30)", () => {
    const code = (f) =>
      readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
    expect(code("./app.js")).toContain("lagHtml: intradayMark(reading, reading?.date) + ");
    const lab = code("./lab-board.js");
    expect(lab).toContain("const intra = intradayMarkLabel(m, m.obs);");
    expect(lab).toMatch(/legTitle\(m\.label, \[MEMBER_HELP\[m\.id\], intra && intra\.title, lp && lp\.title\]/);
    // No visible marker on the families board: the badge renderer is not imported there at all.
    expect(lab).not.toMatch(/\bintradayMark\(/);
  });

  it("intradayMarkLabel is the one copy producer: INTRADAY / EST as data, null on an EOD row", () => {
    expect(intradayMarkLabel({ provisional: true }, "2026-06-26")).toEqual({
      text: "INTRADAY",
      title: expect.stringContaining("INTRADAY · 2026-06-26 - written before the EOD cutoff"),
    });
    expect(intradayMarkLabel({ provisional: true, estimated: true }, "2026-06-26")).toEqual({
      text: "EST · INTRADAY",
      title: expect.stringContaining("EST · INTRADAY · 2026-06-26 - estimate carried off"),
    });
    expect(intradayMarkLabel({ estimated: true }, "2026-06-26")?.title).toContain("The push reads an EOD estimate too");
    // E3: an EOD (non-provisional) row carrying the stored marker is still the estimate — EST.
    expect(intradayMarkLabel({ estimated: true }, "2026-06-26")?.text).toBe("EST");
    expect(intradayMarkLabel({ state: "RED" }, "2026-06-26")).toBeNull();
    expect(intradayMarkLabel(null, undefined)).toBeNull();
  });
});

describe("CSS custom properties", () => {
  // The marks are emitted into index.html, which carries NO scoped <style> — so the seam may
  // reference only custom properties styles.css declares.
  it("references no CSS var styles.css lacks", () => {
    const src = readFileSync(fileURLToPath(new URL("./feed-age-mark.js", import.meta.url)), "utf8");
    const declared = new Set([...STYLES.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = [...src.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
    expect(used.filter((v) => !declared.has(v))).toEqual([]);
  });
});

describe("intradayMark EST arm + intradayVerdictChip (L1/L3)", () => {
  it("an `estimated` provisional row paints the EST · INTRADAY label with the EST class", () => {
    const html = intradayMark({ provisional: true, estimated: true }, "2026-06-26");
    expect(html).toContain('class="intraday-mark intraday-mark-est"');
    expect(html).toContain(">EST · INTRADAY</span>");
  });

  it("the verdict chip renders only on a provisional LabResponse, with its asOf", () => {
    const html = intradayVerdictChip({ provisional: true, asOf: "2026-06-26" });
    expect(html).toContain('class="intraday-mark intraday-verdict"');
    expect(html).toContain("INTRADAY · 2026-06-26</span>");
    expect(html).toContain("the push still reads the last EOD run");
    expect(intradayVerdictChip({ asOf: "2026-06-26" })).toBe("");
    expect(intradayVerdictChip(null)).toBe("");
  });
});

describe("lastPrintMark / lastPrintLabel - the E22 `last print D-n` tag", () => {
  const weekly = { date: "2026-09-28", days: 5, cadence: "weekly", reason: "cadence" };
  const staleDaily = { date: "2026-09-12", days: 21, cadence: "daily", reason: "cap" };

  it("a weekly reading paints `last print D-5 · weekly`, muted while the feed is current", () => {
    const mark = lastPrintMark({ lastPrint: weekly, lag: false, ageDays: 1, unit: "slots" });
    expect(mark.text).toBe("last print D-5 · weekly");
    expect(mark.html).toContain('class="card-lag card-last-print"');
    expect(mark.html).toContain(">last print D-5 · weekly</span>");
    expect(mark.title).toContain("newest print 2026-09-28, 5 calendar days before this run's date");
    expect(mark.title).toContain("No estimate between releases");
    expect(mark.title).not.toMatch(FORBIDDEN);
  });

  it("a weekly-release daily id (oil) behind its market day reads the cap reason off `reason`, never off its weekly cadence", () => {
    const mark = lastPrintMark({ lastPrint: { ...weekly, days: 21, reason: "cap" }, lag: false });
    expect(mark.text).toBe("last print D-21 · weekly");
    expect(mark.title).toContain("Behind its market day");
    expect(mark.title).not.toContain("No estimate between releases");
  });

  it("a daily behind its market day paints `last print D-21 · daily`; a lagging feed keeps the amber tone + weak claim", () => {
    const mark = lastPrintMark({ lastPrint: staleDaily, lag: true });
    expect(mark.text).toBe("last print D-21 · daily");
    expect(mark.html).toContain('class="card-lag card-last-print card-last-print-behind"');
    expect(mark.title).toContain("Behind its market day");
    expect(mark.title).toContain("Feed behind its own release cut.");
    expect(mark.title).not.toMatch(FORBIDDEN);
  });

  it("no served `lastPrint` ⇒ null, so the card falls back to the generic age mark", () => {
    expect(lastPrintMark({ lag: true, ageDays: 3, unit: "slots" })).toBeNull();
    expect(lastPrintMark(null)).toBeNull();
    expect(lastPrintLabel({ date: "2026-09-28", cadence: "weekly" })).toBeNull(); // no measured days ⇒ no tag
  });

  it("the /status card puts it IN PLACE OF the age mark; the /lab chip folds its title into the tooltip", () => {
    const code = (f) =>
      readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
    expect(code("./app.js")).toContain("(lastPrintMark(reading)?.html ?? cardLagMark(reading)?.html ?? \"\")");
    const lab = code("./lab-board.js");
    expect(lab).toContain("const lp = lastPrintLabel(m.lastPrint);"); // joined into the tooltip: pinned above
  });
});
