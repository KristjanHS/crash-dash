/**
 * §4.2 — the `/lab` feed-lag PANEL seam (`feed-lag-panel.js`), hoisted out of `lab.js` so its
 * roster rendering is reachable by a test (`.claude/rules/frontend.md`). Plain `.js`: vitest
 * collects it, tsc skips it.
 *
 * Pins the §7.2 ruling's render half: every roster row prints its three numbers (age, healthy cut,
 * deep-lag bar) in their own columns in the served unit, carries exactly one meas/tier provenance
 * marker off `source`, the order is the served one (never re-sorted), a null `age` renders `-` not
 * `0`, and an absent/empty roster renders nothing. Plus the 2026-09-11 status colouring
 * (`feedLagStatus` → `fl-st-<key>`) and the age gauge.
 */
import { describe, expect, it } from "vitest";

import {
  FEED_LAG_INIT,
  FEED_LAG_STATUS_LABEL,
  feedLagPanelHtml,
  feedLagPanelShellHtml,
  feedLagReduce,
  feedLagStatus,
} from "./feed-lag-panel.js";

const row = (over) => ({
  id: "F1",
  cadence: "daily",
  age: 3,
  ageUnit: "slots",
  lagCut: 4,
  deepLagBar: 8,
  source: "tier",
  lag: false,
  ...over,
});

describe("feedLagPanelHtml - the /lab feed-lag roster panel", () => {
  it("renders nothing at all for an empty or absent roster", () => {
    expect(feedLagPanelHtml([], {})).toBe("");
    expect(feedLagPanelHtml(undefined, {})).toBe("");
    expect(feedLagPanelHtml(null, {})).toBe("");
  });

  it("prints the three numbers in their own columns, with the served unit and no repeated words", () => {
    const html = feedLagPanelHtml([row({ age: 9, ageUnit: "slots", lagCut: 4, deepLagBar: 8 })], {});
    expect(html).toContain('<td class="fl-num fl-age">9 <span class="fl-u">slots</span></td>');
    expect(html).toContain('<td class="fl-num fl-cut">4 <span class="fl-u">slots</span></td>');
    expect(html).toContain('<td class="fl-num fl-bar">8 <span class="fl-u">slots</span></td>');
    // the words live once, in the header — never repeated per row
    expect(html).toContain("<th>Feed</th><th>Status</th>");
    expect(html).toContain('<th class="fl-num">Healthy ≤</th><th class="fl-num">Deep-lag &gt;</th>');
    const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    expect(body).not.toMatch(/ now|healthy |deep-lag /);
  });

  it("labels a calendar-day feed in days, not slots", () => {
    const html = feedLagPanelHtml([row({ cadence: "monthly", age: 40, ageUnit: "days", lagCut: 45, deepLagBar: 90 })], {});
    expect(html).toContain('<td class="fl-num fl-age">40 <span class="fl-u">days</span></td>');
    expect(html).not.toContain("slots");
  });

  it("carries meas for a p90 source and tier for a tier source, one per row", () => {
    const meas = feedLagPanelHtml([row({ source: "p90" })], {});
    expect(meas).toContain('<td class="fl-src fl-src-meas">meas</td>');
    expect(meas).not.toContain('<td class="fl-src fl-src-tier">');
    const tier = feedLagPanelHtml([row({ source: "tier" })], {});
    expect(tier).toContain('<td class="fl-src fl-src-tier">tier</td>');
  });

  it("a run-row source reads 'last fetched' with a fetched mark", () => {
    const html = feedLagPanelHtml([row({ source: "run-row", age: 1, ageUnit: "days", lag: undefined, unmeasured: true })], {});
    expect(html).toContain('1 <span class="fl-u">day</span> <span class="fl-when">last fetched</span></td>');
    expect(html).toContain('<td class="fl-src fl-src-fetched">fetched</td>');
    expect(html).toContain('class="fl-row fl-st-unmeasured is-unmeasured"');
    // a measured row carries no when-note
    expect(feedLagPanelHtml([row()], {})).not.toContain("fl-when");
  });

  it("a provisional row reads age 0 with an INTRADAY marker (R10); a final row carries none", () => {
    const html = feedLagPanelHtml([row({ age: 0, provisional: true })], {});
    expect(html).toContain('0 <span class="fl-u">slots</span> <span class="fl-when">INTRADAY</span></td>');
    expect(feedLagPanelHtml([row({ age: 0 })], {})).not.toContain("INTRADAY");
  });

  it("names both provenance markers and every status in the legend", () => {
    const html = feedLagPanelHtml([row()], {});
    expect(html).toContain("measured lag gap — 2× the larger of this feed’s p90 and its tier");
    expect(html).toContain("derived from the cadence tier");
    const legend = html.slice(html.indexOf('<p class="fl-legend">'));
    for (const key of ["lag", "deep", "nodata", "unmeasured"]) {
      expect(legend).toContain(`<span class="fl-pill fl-st-${key}">${FEED_LAG_STATUS_LABEL[key]}</span>`);
    }
  });

  it("prints - for a null age, never 0, and still labels its cut/bar off the cadence", () => {
    const html = feedLagPanelHtml([row({ age: null, ageUnit: null, cadence: "daily", lagCut: 4, deepLagBar: 8 })], {});
    expect(html).toContain('<td class="fl-num fl-age">-</td>');
    expect(html).not.toContain('<td class="fl-num fl-age">0');
    // the zero-row feed's always-present cut/bar still carry the cadence unit
    expect(html).toContain('<td class="fl-num fl-cut">4 <span class="fl-u">slots</span></td>');
  });

  it("marks a lagging row and renders rows in the served order (never re-sorted)", () => {
    const html = feedLagPanelHtml([row({ id: "F9", lag: true }), row({ id: "F1", lag: false })], {});
    expect(html).toContain('<tr class="fl-row fl-st-lag is-lag">');
    expect(html.indexOf("F9")).toBeLessThan(html.indexOf("F1"));
  });

  it("pairs the id with its served label, and drops a restating id", () => {
    expect(feedLagPanelHtml([row({ id: "F1" })], { F1: "HY OAS" })).toContain('<td class="fl-name">F1 HY OAS</td>');
    expect(feedLagPanelHtml([row({ id: "OVX" })], { OVX: "OVX" })).toContain('<td class="fl-name">OVX</td>');
    expect(feedLagPanelHtml([row({ id: "F1" })], {})).toContain('<td class="fl-name">F1</td>');
  });

  it("singularizes a one-unit quantity", () => {
    const html = feedLagPanelHtml([row({ age: 1, ageUnit: "slots", lagCut: 1, deepLagBar: 1 })], {});
    expect(html).toContain('<td class="fl-num fl-age">1 <span class="fl-u">slot</span></td>');
    expect(html).not.toContain(">slots<");
  });

  it("colours each row by status: a pill and the row class share the same fl-st-<key>", () => {
    const html = feedLagPanelHtml([row({ id: "D", lag: true, age: 9, deepLagBar: 8 })], {});
    expect(html).toContain('<tr class="fl-row fl-st-deep is-lag">');
    expect(html).toContain('<span class="fl-pill fl-st-deep">DEEP LAG</span>');
  });

  it("gauges age on a 0 → deep-lag scale: fill = age/bar clamped at 100, tick at the healthy cut", () => {
    const html = feedLagPanelHtml([row({ age: 2, lagCut: 4, deepLagBar: 8 })], {});
    expect(html).toContain('<span class="fl-gauge-fill fl-st-fresh" data-css-width="25"></span>');
    expect(html).toContain('<span class="fl-gauge-tick" data-css-left="50"></span>');
    const over = feedLagPanelHtml([row({ age: 20, lag: true, lagCut: 4, deepLagBar: 8 })], {});
    expect(over).toContain('data-css-width="100"');
    // a null age emits NO width — the fill stays at the sheet's width:0, never a fabricated position
    const none = feedLagPanelHtml([row({ age: null, ageUnit: null, lag: true })], {});
    expect(none).toContain('<span class="fl-gauge-fill fl-st-nodata"></span>');
  });
});

describe("feedLagStatus - the row's status key", () => {
  it("takes LAG from the served verdict, never re-derived from age vs the healthy cut", () => {
    // age past the cut, but the server netted a release delay and ruled it fresh
    expect(feedLagStatus(row({ age: 6, lagCut: 4, deepLagBar: 8, lag: false }))).toBe("fresh");
    expect(feedLagStatus(row({ age: 3, lagCut: 4, deepLagBar: 8, lag: true }))).toBe("lag");
  });

  it("splits deep lag strictly past the deep-lag bar", () => {
    expect(feedLagStatus(row({ age: 8, deepLagBar: 8, lag: true }))).toBe("lag");
    expect(feedLagStatus(row({ age: 9, deepLagBar: 8, lag: true }))).toBe("deep");
  });

  it("a served deep verdict wins over the age-vs-bar comparison, both ways", () => {
    expect(feedLagStatus(row({ age: 5, deepLagBar: 5, lag: true, deep: true }))).toBe("deep");
    expect(feedLagStatus(row({ age: 9, deepLagBar: 8, lag: true, deep: false }))).toBe("lag");
  });

  it("a lagging row with no age is NO DATA; an unmeasured row wins over everything", () => {
    expect(feedLagStatus(row({ age: null, ageUnit: null, lag: true }))).toBe("nodata");
    expect(feedLagStatus(row({ age: 99, deepLagBar: 8, lag: undefined, unmeasured: true }))).toBe("unmeasured");
  });
});

describe("feedLagReduce - the lazy disclosure gate (§4.3)", () => {
  it("fetches on the FIRST expand only - never before, never on a later expand/collapse", () => {
    const r1 = feedLagReduce(FEED_LAG_INIT, "toggle"); // first expand
    expect(r1.fetch).toBe(true);
    expect(r1.state.phase).toBe("loading");
    const s2 = feedLagReduce(r1.state, "loaded", [row()]).state; // fetch resolves
    const r3 = feedLagReduce(s2, "toggle"); // collapse
    expect(r3.fetch).toBe(false);
    const r4 = feedLagReduce(r3.state, "toggle"); // second expand
    expect(r4.fetch).toBe(false);
  });

  it("does not re-fetch after a failed load", () => {
    const r1 = feedLagReduce(FEED_LAG_INIT, "toggle");
    const s = feedLagReduce(r1.state, "failed").state;
    expect(s.phase).toBe("error");
    const collapse = feedLagReduce(s, "toggle");
    const reexpand = feedLagReduce(collapse.state, "toggle");
    expect(reexpand.fetch).toBe(false);
  });
});

describe("feedLagPanelShellHtml - the disclosure markup", () => {
  it("renders the toggle up front and NO body while collapsed", () => {
    const html = feedLagPanelShellHtml(FEED_LAG_INIT, {});
    expect(html).toContain('<button class="fl-toggle" type="button" aria-expanded="false"');
    expect(html).not.toContain('class="fl-body"');
  });

  it("shows a loading note while the first fetch is in flight", () => {
    const html = feedLagPanelShellHtml({ open: true, phase: "loading", rows: null }, {});
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('<p class="fl-note">Loading feed lag');
  });

  it("shows a quiet failure note, not an empty silent body, on error", () => {
    const html = feedLagPanelShellHtml({ open: true, phase: "error", rows: null }, {});
    expect(html).toContain('<p class="fl-note fl-err">Couldn');
  });

  it("renders the full roster body once ready", () => {
    const html = feedLagPanelShellHtml({ open: true, phase: "ready", rows: [row({ id: "F9", lag: true })] }, {});
    expect(html).toContain('<div class="fl-body" id="flBody">');
    expect(html).toContain('<tr class="fl-row fl-st-lag is-lag">');
    expect(html).toContain('<td class="fl-num fl-age">3 <span class="fl-u">slots</span></td>');
  });
});
