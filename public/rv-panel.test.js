// The `/value` hooks off the Value XDEV ladder: `rv10` and `vetoBreach`, pinned
// to the probe's `realizedVol`/`noDrop` on each day's PREFIX, so a hook that peeks past day t reds. TS imports carry `.ts` (frontend.md).
import { describe, it, expect } from "vitest";
import { SERIES_HOOKS, RV_PANEL, VETO_PANEL } from "./detail-chart.js";
import { XDEV_GATE_DESCRIPTOR } from "../src/family-descriptor-rows.ts";
import { RV10_WINDOW, RV20_WINDOW } from "../src/chart-rail.ts";
import { realizedVol, TRANCHE_RULES } from "../scripts/probe-eufin-tranches.ts";
import { noDrop, VALUE_RULES } from "../scripts/probe-value-tranches.ts";

/** ~200 closes: rise · dip · new high · dip · new high; LCG noise, louder in dips. */
function fixture() {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  const legs = [[70, 0.004, 1], [25, -0.008, 2.5], [45, 0.006, 1], [25, -0.007, 2.5], [35, 0.007, 1]];
  const vals = [];
  let x = 100;
  for (const [len, drift, loud] of legs) for (let k = 0; k < len; k++) vals.push((x *= Math.exp(drift + 0.01 * loud * rnd())));
  const day0 = Date.UTC(2025, 0, 1);
  return { pts: vals.map((value, i) => ({ date: new Date(day0 + i * 86_400_000).toISOString().slice(0, 10), value })) };
}

const near = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b)));

describe("rv10 hook vs the probe's realizedVol", () => {
  it("RV_PANEL (client mirror) equals RV10_WINDOW / RV20_WINDOW, and RV20 is the EU-Fin ladder's slow window", () => {
    expect(RV_PANEL).toEqual({ rvWindow: RV10_WINDOW, rvSlowWindow: RV20_WINDOW });
    expect(RV20_WINDOW).toBe(TRANCHE_RULES.RV_SLOW_N);
  });

  it.each([
    ["rv10", VALUE_RULES.RV_N],
    ["rv20", TRANCHE_RULES.RV_SLOW_N],
  ])("%s: every day t equals realizedVol(closes, t, %i)", (hook, n) => {
    const { pts: c } = fixture();
    const got = SERIES_HOOKS[hook](c);
    const bad = [];
    for (let t = 0; t < c.length; t++) {
      const want = realizedVol(c, t, n);
      if (!near(got[t], want)) bad.push(`${hook}[${t}] ${got[t]} ≠ ${want}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
    expect(got.filter((v) => v !== null).length).toBeGreaterThan(150); // vacuity: drawn on most days
  });
});

describe("vetoBreach hook vs the probe's noDrop", () => {
  it("VETO_PANEL (client mirror) equals the descriptor's constants", () => {
    const { vetoSd, vetoWindow, sigmaWindow } = XDEV_GATE_DESCRIPTOR.scorer.constants;
    expect(VETO_PANEL).toEqual({ vetoSd, vetoWindow, sigmaWindow });
  });

  it("every day t: a dot (at the close) iff noDrop's ret < −cap on closes[0..t]", () => {
    const { pts: c } = fixture();
    const r = VALUE_RULES;
    const dot = SERIES_HOOKS.vetoBreach(c);
    const bad = [];
    let cold = 0;
    let dots = 0;
    for (let t = 0; t < c.length; t++) {
      const want = noDrop(c.slice(0, t + 1), r);
      if (want === null) {
        if (dot[t] !== null) bad.push(`vetoBreach[${t}] ${dot[t]} before noDrop warms`);
        cold++;
        continue;
      }
      if ((dot[t] !== null) !== want.ret < -want.cap) bad.push(`vetoBreach[${t}] ${dot[t]} vs ret ${want.ret} cap ${want.cap}`);
      if (dot[t] !== null && dot[t] !== c[t].value) bad.push(`vetoBreach[${t}] ${dot[t]} ≠ close ${c[t].value}`);
      if (dot[t] !== null) dots++;
    }
    expect(bad.slice(0, 5)).toEqual([]);
    // The cap warms on exactly noDrop's first day; the fixture's loud dips break −3σ on a few days, not most.
    expect(cold).toBe(r.SIGMA_N + r.VETO_N);
    expect(dots).toBeGreaterThan(0);
    expect(dots).toBeLessThan((c.length - cold) / 2);
  });
});
