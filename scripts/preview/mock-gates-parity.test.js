// Drift guard — GATES_MOCK (mock-data.mjs) is a HAND-mirror of src/gates.ts GATES
// (a shape mirror of the real chart builder, which the mock does not call — see the SEAM
// note above buildChartMock). Same pattern as the repo's display-band drift guards:
// pin the mirrored fields per mocked id so a GATES edit that forgets the mirror
// fails here instead of silently skewing the /lab preview's gate legend.
// Plain `.js` (like public/*.test.js) so vitest collects it while tsc skips it.
import { describe, it, expect } from "vitest";
import { GATES_MOCK, ALL_INDICATORS_META, FAMILIES_META } from "./mock-data.mjs";
import { GATES } from "../../src/gates.ts";
import { US_FAMILIES } from "../../src/families.ts";

// F8's gate legend is intentionally NOT mirrored in the preview mock (buildChartMock
// omits it) — the one documented exclusion the reverse drift guard must skip.
const NOT_MOCKED = new Set(["F8"]);

describe("preview mock — GATES_MOCK mirrors src/gates.ts GATES", () => {
  it("every mocked id pins the real key/label/appliesTo, in order", () => {
    expect(Object.keys(GATES_MOCK).length).toBeGreaterThan(0); // vacuity guard
    for (const [id, mocked] of Object.entries(GATES_MOCK)) {
      const real = GATES[id];
      expect(real, `${id} is mocked but absent from GATES`).toBeDefined();
      expect(mocked, `${id} gate mirror drifted`).toEqual(
        real.map(({ key, label, appliesTo }) => ({ key, label, appliesTo })),
      );
    }
  });

  it("every GATES id the mock renders is mirrored in GATES_MOCK (reverse drift; F8 excluded)", () => {
    // The forward check above is GATES_MOCK ⊆ GATES; without this, a mocked indicator
    // that later GAINS gates in src/gates.ts passes silently while the /lab preview
    // legend drops them. Assert the reverse for every gated id the mock actually
    // renders (present in ALL_INDICATORS_META), minus the documented F8 exclusion.
    const MOCK_IDS = new Set(ALL_INDICATORS_META.map((m) => m.id));
    for (const id of Object.keys(GATES)) {
      if (NOT_MOCKED.has(id) || !MOCK_IDS.has(id)) continue;
      expect(GATES_MOCK[id], `${id} has gates in src/gates.ts + is mocked, but no GATES_MOCK mirror`).toBeDefined();
    }
  });
});

describe("preview mock — every families.ts family is mirrored (reverse drift)", () => {
  it("every families.ts US_FAMILIES key is rendered by the preview mock", () => {
    // The mock's per-family LABELS are now IMPORTED from families.ts (stage 3, name-dup backlog), so
    // they cannot drift — but an import can't cover the STRUCTURAL half: a families.ts family the
    // mock's curated US_FAMILIES table simply forgot to add. Without this, a NEW family goes silently
    // missing from the /lab + dashboard preview. Assert the reverse: every families.ts key appears in
    // the mock's served family set (FAMILIES_META). Same shape as the GATES reverse drift guard above.
    // SCOPE: the population is `US_FAMILIES` — the dashboard family panel (DASHBOARD_FAMILIES is
    // `.map`-derived from it, so the keys coincide). It is NOT every family-shaped table in
    // families.ts: `CARD_ONLY_GROUPS` is a separate one carrying `pension-drawdown`, which is absent
    // from US_FAMILIES and therefore NOT covered here. A new card-only group needs its own guard.
    const MOCK_KEYS = new Set(FAMILIES_META.map((f) => f.key));
    expect(US_FAMILIES.length).toBeGreaterThan(0); // vacuity guard
    for (const f of US_FAMILIES) {
      expect(MOCK_KEYS.has(f.key), `families.ts family "${f.key}" is not mirrored in the preview mock`).toBe(true);
    }
  });
});
