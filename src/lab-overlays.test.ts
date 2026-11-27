/**
 * Direct unit tests for the pure/store-fed overlay views in src/lab-overlays.ts (rung 7b) —
 * the behaviour the api/lab.test.ts round-trips used to own; that file keeps wiring pins.
 */
import { describe, expect, test } from "vitest";

import { fallShapeView, loadLegGrowth, r4View, resolveR1View, resolveR5View, resolveVixPersistenceView, resolveY1View } from "./lab-overlays.js";
import type { SeriesPoint, Store } from "./store.js";
import { LADDER } from "./families.js";
import { ALL_INDICATORS } from "./registry.js";
import { R1_FLOOR_RUNG } from "./r1.js";
import { R5_MIN_GROSS, R5_MIN_OBS, R5_TARGET_VOL } from "./r5.js";
import { Y1_MARGIN, Y1_MIN_OBS, Y1_PERSIST } from "./y1.js";
import { RERISK_DWELL_DAYS } from "./danger-ladder.js";
import {
  BEAR_DWELL_CLOSES,
  DD_GATE_FIELD_LABEL,
  FALL_SHAPE_CONFIDENCE_COPY,
  FALL_SHAPE_CONFIDENCE_VALUES,
  V_BEAR_INFLUENCE_ENABLED,
  V_VELOCITY_CUT,
} from "./v-bear.js";
import type { FallShapeOverlayViewDTO } from "./api/types.js";
import { legCloseId } from "./scoreboard.js";

const F1_LABEL = ALL_INDICATORS.find((i) => i.id === "F1")!.label;

const fieldOf = (view: { fields: { label: string; value: string }[] }, label: string) =>
  view.fields.find((f) => f.label === label)!.value;

describe("r4View", () => {
  test("reentry phase: own 'reentry' tone, whole-shape fields off the four inputs", () => {
    const v = r4View({ cash: false, phase: "reentry", reentryRung: 3, hyOas: 4.2, vt: 1.05, reason: "" });
    expect(v.id).toBe("r4");
    expect(v.headline).toContain("reentry");
    expect(v.tone).toBe("reentry");
    expect(v.fields).toEqual([
      { label: "phase", value: "reentry" },
      { label: "re-entry rung", value: "3" },
      { label: F1_LABEL, value: "4.20" },
      { label: "VIX/VIX3M", value: "1.05" },
    ]);
  });

  test("cash: tone 'alert' IS the wire cash flag; null rung renders '-'", () => {
    const v = r4View({ cash: true, phase: "cash", reentryRung: null, hyOas: 6.5, vt: 1.2, reason: "" });
    expect(v.tone).toBe("alert");
    expect(v.headline).toContain("cash");
    expect(fieldOf(v, "phase")).toBe("cash");
    expect(fieldOf(v, "re-entry rung")).toBe("-");
  });

  test("equity phase is neutral and never 'alert'", () => {
    const v = r4View({ cash: false, phase: "equity", reentryRung: null, hyOas: null, vt: null, reason: "" });
    expect(v.tone).toBe("neutral");
    expect(v.headline).toContain("equity");
    expect(fieldOf(v, F1_LABEL)).toBe("-");
    expect(fieldOf(v, "VIX/VIX3M")).toBe("-");
  });

  test("null phase renders the placeholder in both headline and field", () => {
    const v = r4View({ cash: true, phase: null, reentryRung: null, hyOas: null, vt: null, reason: "" });
    expect(v.headline).toBe("in cash (—)");
    expect(fieldOf(v, "phase")).toBe("-");
  });

  test("blank reason omits `note`; a non-blank reason rides it verbatim", () => {
    const bare = r4View({ cash: false, phase: "equity", reentryRung: null, hyOas: null, vt: null, reason: "" });
    expect("note" in bare).toBe(false);
    const noted = r4View({ cash: false, phase: "equity", reentryRung: null, hyOas: null, vt: null, reason: "tails clear" });
    expect(noted.note).toBe("tails clear");
  });
});

describe("fallShapeView", () => {
  const confRow = (c: FallShapeOverlayViewDTO["confidence"]) =>
    `${c} - ${FALL_SHAPE_CONFIDENCE_COPY[c]}`;
  const TRIPLES: {
    name: string;
    shape: Parameters<typeof fallShapeView>[0];
    velocity: number | null;
    dwell: number | null;
    confidence: FallShapeOverlayViewDTO["confidence"];
    tone: string;
    probe: string;
    velocityRow: string;
    dwellRow: string;
    copyContains: string[];
  }[] = [
    { name: "v-shaped measured, probe would fire", shape: "v-shaped", velocity: -0.0105, dwell: 3,
      confidence: "measured", tone: "neutral", probe: "would fire",
      velocityRow: "-1.05 pp/day", dwellRow: "3 closes", copyContains: [] },
    { name: "bear is the one caution grind, probe would fire", shape: "bear", velocity: -0.001, dwell: 40,
      confidence: "measured", tone: "caution", probe: "would fire",
      velocityRow: "-0.10 pp/day", dwellRow: "40 closes", copyContains: [] },
    { name: "conflicting axes, probe off", shape: "indeterminate", velocity: -0.012, dwell: 40,
      confidence: "conflicting", tone: "neutral", probe: "off",
      velocityRow: "-1.20 pp/day", dwellRow: "40 closes", copyContains: ["DISAGREE", "NOT excluded"] },
    { name: "no-fall absence, dwell null, probe off", shape: "indeterminate", velocity: -0.002, dwell: null,
      confidence: "no-fall", tone: "neutral", probe: "off",
      velocityRow: "-0.20 pp/day", dwellRow: "-", copyContains: ["not an all-clear"] },
    { name: "dark all-null, probe off", shape: "indeterminate", velocity: null, dwell: null,
      confidence: "dark", tone: "neutral", probe: "off",
      velocityRow: "-", dwellRow: "-", copyContains: ["not a calm read"] },
  ];

  test.each(TRIPLES)(
    "projects $name",
    ({ shape, velocity, dwell, confidence, tone, probe, velocityRow, dwellRow, copyContains }) => {
      const fs = fallShapeView(shape, velocity, dwell);
      expect(Object.hasOwn(fs, "confidence")).toBe(true);
      expect(FALL_SHAPE_CONFIDENCE_VALUES).toContain(fs.confidence);
      expect(fs.confidence).toBe(confidence);
      expect(fs.headline).toBe(`shape: ${shape} · ${confidence}`);
      expect(fs.tone).toBe(tone);
      expect(fs.id).toBe("fallShape");
      expect(fs.fields).toEqual([
        { label: "shape", value: shape },
        { label: "confidence", value: confRow(confidence) },
        { label: "velocity", value: velocityRow },
        { label: "credit dwell", value: dwellRow },
        { label: DD_GATE_FIELD_LABEL, value: probe },
      ]);
      const row = fs.fields.find((f) => f.label === "confidence")!.value;
      expect(row).toBe(`${fs.confidence} - ${FALL_SHAPE_CONFIDENCE_COPY[fs.confidence]}`);
      for (const sub of copyContains) expect(row).toContain(sub);
    },
  );

  test.each([true, false])("the note derives its disclaimer from the kill switch (enabled=%s) and prints both cuts", (enabled) => {
    const note = fallShapeView("bear", -0.001, 40, enabled).note!;
    expect(note.includes("display only — influence disabled")).toBe(!enabled);
    expect(note).toContain(String(BEAR_DWELL_CLOSES));
    expect(note).toContain((V_VELOCITY_CUT * 100).toFixed(2));
    expect(note).toContain("steers nothing");
    expect(fallShapeView("bear", -0.001, 40).note === note, "the default reads the shipped kill switch").toBe(
      enabled === V_BEAR_INFLUENCE_ENABLED,
    );
  });
});

describe("resolveR1View", () => {
  test("cold start (null prior) returns null - no invented walk", () => {
    expect(resolveR1View(5, null, 0, 0, true)).toBeNull();
  });

  test("already at target returns null - the key is omitted upstream", () => {
    expect(resolveR1View(5, 5, 0, 0, true)).toBeNull();
  });

  test("de-risk: caution tone, both rungs named with their LADDER sleeves, one-jump note", () => {
    const v = resolveR1View(7, 3, 0, 0, true)!;
    expect(v.id).toBe("r1");
    expect(v.tone).toBe("caution");
    expect(v.headline).toBe(`de-risk queued: r3 (${LADDER[2]}) → r7 (${LADDER[6]})`);
    expect(v.fields).toEqual([]);
    expect(v.note).toBe("fires as one jump, not a gradual walk");
  });

  test("re-risk with trend confirming: neutral 'pending', note names the deadband not a veto", () => {
    const v = resolveR1View(2, 6, 0, 4, true)!;
    expect(v.tone).toBe("neutral");
    expect(v.headline).toBe(`re-risk pending: r6 (${LADDER[5]}) → r2 (${LADDER[1]})`);
    expect(v.note).toContain("trend is NOT vetoing");
  });

  test("re-risk under a trend veto: 'held by trend' headline and the blocked note", () => {
    const v = resolveR1View(2, 6, 0, 4, false)!;
    expect(v.tone).toBe("neutral");
    expect(v.headline).toContain("re-risk held by trend");
    expect(v.note).toContain("blocked while a trend");
  });

  test("dwell chips render only while RERISK_DWELL_DAYS is armed", () => {
    const v = resolveR1View(2, 6, 0, 0, true)!;
    expect(v.fields.length).toBe(RERISK_DWELL_DAYS > 0 ? 2 : 0);
  });

  test("an off-ladder prior clamps to R1_FLOOR_RUNG in the headline", () => {
    const v = resolveR1View(4, 12, 0, 0, true)!;
    expect(v.headline).toContain(`r${R1_FLOOR_RUNG} (${LADDER[R1_FLOOR_RUNG - 1]})`);
  });

  test("an off-ladder target clamps the destination to R1_FLOOR_RUNG", () => {
    const v = resolveR1View(15, 3, 0, 0, true)!;
    expect(v.headline).toContain(`→ r${R1_FLOOR_RUNG} (${LADDER[R1_FLOOR_RUNG - 1]})`);
  });
});

describe("resolveY1View", () => {
  const STORE = {} as Store;
  const NOISE = 0.01;
  const day = (o: number) => new Date(Date.UTC(2026, 5, 24) + o * 86_400_000).toISOString().slice(0, 10);
  const pt = (date: string, value: number): SeriesPoint =>
    ({ date, value, delta20: 0, rawState: "GREEN", state: "GREEN" });

  /** Every leg ±NOISE around a constant drift ⇒ equal realized vol, so the cross-section ranks on
   *  drift alone; `leader` trends hard enough to clear Y1_MARGIN on every one of the last closes. */
  function bulkOf(leader: (typeof LADDER)[number], n = Y1_MIN_OBS + Y1_PERSIST + 3): Map<string, SeriesPoint[]> {
    return new Map(
      LADDER.map((sleeve) => {
        const drift = sleeve === leader ? 0.004 : 0;
        let logClose = Math.log(100);
        const rows = Array.from({ length: n }, (_, i) => {
          if (i > 0) logClose += drift + (i % 2 === 0 ? NOISE : -NOISE);
          return pt(day(i - n + 1), Math.exp(logClose));
        });
        return [legCloseId(sleeve), rows];
      }),
    );
  }

  test("no store ⇒ null (the key is omitted upstream)", async () => {
    expect(await resolveY1View(null, LADDER[0], { lo: 1, hi: 3 }, bulkOf("S&P IT"))).toBeNull();
  });

  test("D4 CEILING: a dominant leg above band.lo is never picked; inside the band it is", async () => {
    const bulk = bulkOf(LADDER[0]);
    const capped = (await resolveY1View(STORE, LADDER[2], { lo: 3, hi: 5 }, bulk))!.view;
    expect(fieldOf(capped, "candidates")).toBe("rungs 3-6");
    expect(fieldOf(capped, "pick")).not.toContain(LADDER[0]);
    expect(capped.headline).not.toContain("switching");
    const pickRung = Number(/rung (\d+)/.exec(fieldOf(capped, "pick"))![1]);
    expect(pickRung).toBeGreaterThanOrEqual(3);
    expect(pickRung).toBeLessThanOrEqual(6);

    const open = (await resolveY1View(STORE, LADDER[2], { lo: 1, hi: 3 }, bulk))!.view;
    expect(fieldOf(open, "pick")).toBe(`${LADDER[0]} (rung 1)`);
  });

  test("DEGRADED, not absent: too little history or zero rows still render, margin '-'", async () => {
    for (const bulk of [bulkOf("S&P IT", Y1_MIN_OBS - 1), new Map<string, SeriesPoint[]>()]) {
      const v = (await resolveY1View(STORE, LADDER[0], { lo: 1, hi: 3 }, bulk))!.view;
      expect(fieldOf(v, "margin")).toBe("-");
      expect(fieldOf(v, "streak")).toBe(`0/${Y1_PERSIST}`);
      expect(v.tone).toBe("neutral");
      expect(v.headline).toContain("RS unavailable");
    }
  });

  test("STREAK RECONSTRUCTION cuts every leg at a shared as-of DATE, not a per-leg row count", async () => {
    // Every leg carries PRIVATE trailing dates no other leg trades on (divergent venue calendars), so
    // dropping k ROWS per leg peels only those and copies the current close into every history slot.
    const SHARED = Y1_MIN_OBS + 3;
    const PRIVATE_TAIL = Y1_PERSIST + 1;
    const leader = LADDER[1];
    const bulk = new Map<string, SeriesPoint[]>();
    for (const [i, sleeve] of LADDER.entries()) {
      const rows: SeriesPoint[] = [];
      let logClose = Math.log(100);
      for (let k = 0; k < SHARED; k++) {
        // Tiny per-leg drifts hold every prior-close margin under Y1_MARGIN; the leader jumps on the
        // newest shared date only, so an honest streak is 1.
        if (k > 0) logClose += i * 0.00002 + (k % 2 === 0 ? NOISE : -NOISE);
        if (k === SHARED - 1 && sleeve === leader) logClose += 0.25;
        rows.push(pt(day(k - SHARED), Math.exp(logClose)));
      }
      for (let k = 0; k < PRIVATE_TAIL; k++) rows.push(pt(day(1 + i + 9 * k), Math.exp(logClose)));
      bulk.set(legCloseId(sleeve), rows);
    }

    const v = (await resolveY1View(STORE, LADDER[0], { lo: 1, hi: 3 }, bulk))!.view;
    expect(Number(fieldOf(v, "margin").replace(" sd", ""))).toBeGreaterThan(Y1_MARGIN);
    expect(v.headline).toContain(leader);
    expect(fieldOf(v, "streak")).toBe(`1/${Y1_PERSIST}`);
    expect(v.headline).not.toContain("switching");
    expect(v.tone).toBe("neutral");
  });
});

describe("resolveR5View", () => {
  const SLEEVE = LADDER[0];
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

  function closes(n: number, annualVol: number): SeriesPoint[] {
    const r = annualVol / Math.sqrt(252);
    const out: SeriesPoint[] = [];
    let close = 100;
    for (let i = 0; i < n; i++) {
      if (i > 0) close *= Math.exp(i % 2 === 0 ? r : -r);
      const date = new Date(Date.UTC(2026, 5, 24) - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10);
      out.push({ date, value: close, delta20: 0, rawState: "GREEN", state: "GREEN" });
    }
    return out;
  }

  function storeOf(points: SeriesPoint[], calls?: { id?: string; limit?: number }): Store {
    return {
      getSeries: async (id: string, limit: number) => {
        if (calls) Object.assign(calls, { id, limit });
        return points;
      },
    } as unknown as Store;
  }

  test("no on-ladder held sleeve (null, undefined, off-ladder) returns null", async () => {
    expect(await resolveR5View(storeOf([]), null)).toBeNull();
    expect(await resolveR5View(storeOf([]), undefined)).toBeNull();
    expect(await resolveR5View(storeOf([]), "NotALeg")).toBeNull();
  });

  test("reads the held leg's LEGP series with at least R5_MIN_OBS closes requested", async () => {
    const calls: { id?: string; limit?: number } = {};
    await resolveR5View(storeOf(closes(R5_MIN_OBS + 5, 0.05), calls), SLEEVE);
    expect(calls.id).toBe(legCloseId(SLEEVE));
    expect(calls.limit).toBeGreaterThanOrEqual(R5_MIN_OBS);
  });

  test("a violent leg floors gross at R5_MIN_GROSS: caution tone, cash is the complement", async () => {
    const v = (await resolveR5View(storeOf(closes(R5_MIN_OBS + 5, 0.45)), SLEEVE))!;
    expect(v.id).toBe("r5");
    expect(v.tone).toBe("caution");
    expect(fieldOf(v, "held leg")).toBe(SLEEVE);
    expect(fieldOf(v, "gross")).toBe(pct(R5_MIN_GROSS));
    expect(fieldOf(v, "cash (R5)")).toBe(pct(1 - R5_MIN_GROSS));
    expect(fieldOf(v, "target vol")).toBe(pct(R5_TARGET_VOL));
  });

  test("a calm leg is silent: fully invested, neutral", async () => {
    const v = (await resolveR5View(storeOf(closes(R5_MIN_OBS + 5, 0.05)), SLEEVE))!;
    expect(v.tone).toBe("neutral");
    expect(fieldOf(v, "gross")).toBe("100%");
    expect(v.headline).toContain("fully invested");
  });

  test("no history degrades to warming-up: neutral, '-' rows, never a fabricated trim", async () => {
    const v = (await resolveR5View(null, SLEEVE))!;
    expect(v.tone).toBe("neutral");
    expect(fieldOf(v, "gross")).toBe("-");
    expect(fieldOf(v, "realized vol")).toBe("-");
    expect(v.headline).toContain("warming up");
  });

  test("one close short of R5_MIN_OBS still degrades", async () => {
    const v = (await resolveR5View(storeOf(closes(R5_MIN_OBS - 1, 0.02)), SLEEVE))!;
    expect(fieldOf(v, "gross")).toBe("-");
  });

  test("D's `estimated` LEGP row counts toward R5 like the push (R5_MIN_OBS closes incl. the estimate ⇒ sized)", async () => {
    const pts = closes(R5_MIN_OBS, 0.05);
    pts[pts.length - 1] = { ...pts[pts.length - 1]!, estimated: true };
    expect(fieldOf((await resolveR5View(storeOf(pts), SLEEVE))!, "gross")).toBe("100%");
  });

  test("a throwing store degrades instead of rejecting, and warns naming the leg series", async () => {
    const store = { getSeries: async () => { throw new Error("db down"); } } as unknown as Store;
    const warned: unknown[][] = [];
    const v = (await resolveR5View(store, SLEEVE, (...a) => warned.push(a)))!;
    expect(fieldOf(v, "gross")).toBe("-");
    expect(v.headline).toContain("warming up");
    expect(warned.map((a) => String(a[0]))).toEqual([expect.stringContaining(legCloseId(SLEEVE))]);
  });

  test("the note caps R5 cash at the R5_MIN_GROSS complement", async () => {
    const v = (await resolveR5View(null, SLEEVE))!;
    expect(v.note).toContain(pct(1 - R5_MIN_GROSS));
  });
});

describe("resolveVixPersistenceView", () => {
  test("a throwing store omits the overlay and warns naming VTP", async () => {
    const store = { getSeries: async () => { throw new Error("db down"); } } as unknown as Store;
    const warned: unknown[][] = [];
    expect(await resolveVixPersistenceView(store, (...a) => warned.push(a))).toBeNull();
    expect(warned.map((a) => String(a[0]))).toEqual([expect.stringContaining("VTP")]);
  });
});

describe("loadLegGrowth", () => {
  test("the /lab growth bulk keeps D's `estimated` LEGP row, as `pushLegSeries` does", async () => {
    const fin: SeriesPoint = { date: "2026-10-05", value: 100, delta20: 0, rawState: "GREEN", state: "GREEN" };
    const est: SeriesPoint = { ...fin, date: "2026-10-06", value: 101, estimated: true };
    const store = {
      getSeriesBulk: async (ids: string[]) => new Map(ids.map((id) => [id, [fin, est]])),
    } as unknown as Store;
    expect((await loadLegGrowth(store)).bulk.get(legCloseId(LADDER[0]))).toEqual([fin, est]);
  });

  test("a failed growth bulk read warns naming the leg ids and serves an empty bulk", async () => {
    const store = { getSeriesBulk: () => Promise.reject(new Error("db down")) } as unknown as Store;
    const warned: unknown[][] = [];
    expect((await loadLegGrowth(store, (...a) => void warned.push(a))).bulk.size).toBe(0);
    expect(warned.map((a) => String(a[0]))).toEqual([expect.stringContaining(legCloseId(LADDER[0]))]);
  });
});
