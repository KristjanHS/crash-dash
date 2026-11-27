// Parity of the shared ladder-jobs forms — the speed, relative, recovery and regime oracles — against test-local VERBATIM copies of the
// retired probe code. Speed's: `giltZ` + `sd`/`mean` (probe-eufin), `v`/`Pt` (ladder-replay), `run` (probe-{value,semis,spit}); the rest per section.
// The copies stay frozen here: the leaf may never import `scripts/`.
import { describe, expect, it } from "vitest";
import { delta, extremeOf, lowSince, ma, maPair, newExtreme, noLowRun, offHigh, postShockLow, quietRun, retraced, retraceLine, speedQuiet, speedZ, type Peaked, type SpeedParams } from "./ladder-jobs.js";

type Pt = { date: string; value: number | null };
type Rules = { DELTA_N: number; Z_WINDOW: number };
const v = (c: Pt[], i: number): number => c[i]!.value!;
const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]): number => {
  const m = mean(a);
  return Math.sqrt(a.reduce((acc, x) => acc + (x - m) ** 2, 0) / (a.length - 1));
};
function giltZ(c: Pt[], i: number, r: Pick<Rules, "DELTA_N" | "Z_WINDOW">): number | null {
  if (i < r.DELTA_N + 2) return null;
  const dn = (k: number): number => v(c, k) - v(c, k - r.DELTA_N);
  const hist: number[] = [];
  for (let k = Math.max(r.DELTA_N, i - r.Z_WINDOW); k < i; k++) hist.push(dn(k));
  const s = sd(hist);
  return s > 0 ? dn(i) / s : null;
}
const run = (c: Pt[], need: number, ok: (i: number) => boolean): number => {
  let n = 0;
  for (let i = c.length - 1; n < need && i >= 0 && ok(i); i--) n++;
  return n;
};
/** The value/spit call shape the leaf's `speedQuiet` replaces. */
const oracleQuiet = (c: Pt[], p: SpeedParams) => {
  const k = { DELTA_N: p.n, Z_WINDOW: p.window };
  return { z: giltZ(c, c.length - 1, k), got: run(c, p.quiet, (i) => ((zi) => zi !== null && zi < p.zMax)(giltZ(c, i, k))) };
};

/** 400 closes: 40 flat (the `s > 0` null path), an LCG random walk, a +0.4 rate shock over 5 closes at 320, then the walk again. */
const FIXTURE: Pt[] = (() => {
  let seed = 12345;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  const out: Pt[] = [];
  let x = 5.0;
  for (let i = 0; i < 400; i++) {
    if (i >= 40) x += i >= 320 && i < 325 ? 0.08 : 0.02 * rnd();
    out.push({ date: `d${String(i).padStart(3, "0")}`, value: x });
  }
  return out;
})();
const LIVE: SpeedParams = { n: 20, window: 250, zMax: 1, quiet: 10 }; // GILT_* today (quiet 10); RATES_* / R2_* and FAST_RULES use quiet 5
/** Parity sample for a slice of FIXTURE starting at `off`: every 7th index, the whole 315–330 shock region, and the edges where
 *  speedZ's branches change — 0/1, the `n + 2` guard, the flat lead-in → walk transition (40/41), the clamp → full-window
 *  transition (`n + window` / `n + window + 1`), and the last two closes. Every-index sweeps cost O(n²·window) for no extra branch. */
const sampleIdx = (len: number, p: SpeedParams, off = 0): number[] => {
  const edges = [0, 1, p.n + 1, p.n + 2, 40 - off, 41 - off, p.n + p.window - 1, p.n + p.window, p.n + p.window + 1, len - 2, len - 1];
  const shock = Array.from({ length: 16 }, (_, k) => 315 + k - off);
  const all = [...Array.from({ length: len }, (_, i) => i).filter((i) => i % 7 === 0), ...shock, ...edges];
  return [...new Set(all.filter((i) => i >= 0 && i < len))].sort((a, b) => a - b);
};

describe("speedZ / speedQuiet — verbatim parity with the retired probe copies", () => {
  it("speedZ equals giltZ at the sampled indices, for the live knobs and a short window, with and without the flat lead-in", () => {
    for (const [c, off] of [[FIXTURE, 0], [FIXTURE.slice(40), 40]] as const)
      for (const p of [LIVE, { n: 3, window: 8, zMax: 1, quiet: 5 }]) {
        const idx = sampleIdx(c.length, p, off);
        expect(idx.map((i) => speedZ(c, i, p))).toStrictEqual(idx.map((i) => giltZ(c, i, { DELTA_N: p.n, Z_WINDOW: p.window })));
      }
    expect(speedZ(FIXTURE.slice(40), LIVE.n + 2, LIVE)).not.toBeNull(); // the first index past the guard reads a z off the walk
  });
  it("speedQuiet equals the probe call shape on the sampled prefixes, quiet 10 and 5", () => {
    for (const p of [LIVE, { ...LIVE, quiet: 5 }]) {
      const ends = sampleIdx(FIXTURE.length, p).map((i) => i + 1);
      expect(ends.map((m) => speedQuiet(FIXTURE.slice(0, m), p))).toStrictEqual(ends.map((m) => oracleQuiet(FIXTURE.slice(0, m), p)));
    }
  });
  it("the fixture reaches every path: short-history and flat-window null z, a finite z ≥ zMax after the shock, quiet streaks 0, 1, 5 and the 10 cap", () => {
    const zs = FIXTURE.map((_, i) => speedZ(FIXTURE, i, LIVE));
    expect([zs.slice(0, LIVE.n + 2).every((z) => z === null), zs[30], zs.slice(320, 325).some((z) => z !== null && z >= LIVE.zMax)]).toEqual([true, null, true]);
    const gots = new Set(FIXTURE.map((_, i) => speedQuiet(FIXTURE.slice(0, i + 1), LIVE).got));
    expect([0, 1, 5, 10].map((g) => gots.has(g))).toEqual([true, true, true, true]);
    expect(Math.max(...gots)).toBe(LIVE.quiet);
  });
  it("quietRun equals run: capped at need, stops at index 0, breaks on the first failing close from the end", () => {
    const c = FIXTURE.slice(0, 12);
    const preds: ((i: number) => boolean)[] = [() => true, () => false, (i) => i % 3 !== 0, (i) => i > 4];
    for (const need of [0, 3, 12, 50]) expect(preds.map((ok) => quietRun(c, need, ok))).toStrictEqual(preds.map((ok) => run(c, need, ok)));
    expect([quietRun(c, 50, () => true), quietRun(c, 3, () => true), quietRun(c, 50, (i) => i > 4)]).toEqual([12, 3, 7]);
  });
});

// ── `relative` forms — verbatim parity with the probe copies the migration deletes.
type RPt = { date: string; value: number | null; provisional?: boolean | null; estimated?: boolean | null };
const vals = (c: RPt[]): number[] => c.map((p) => p.value!);
// EU-Fin (scripts/probe-eufin-tranches.ts): guarded.
const eufinNewHigh = (c: RPt[], i: number, n: number): boolean => i >= n && v(c, i) > Math.max(...c.slice(i - n, i).map((p) => p.value!));
const eufinNewLow = (c: RPt[], i: number, n: number): boolean => i >= n && v(c, i) < Math.min(...c.slice(i - n, i).map((p) => p.value!));
// Value (scripts/probe-value-tranches.ts; S&P IT + Semis `newHigh` are the same line): unguarded.
const valueNewHigh = (c: RPt[], i: number, n: number): boolean => c[i]!.value! > Math.max(...vals(c.slice(i - n, i)));
const valueNewLow = (c: RPt[], i: number, n: number): boolean => c[i]!.value! < Math.min(...vals(c.slice(i - n, i)));
function valueOffHigh(c: RPt[], n: number): { dd: number; high: number; highDate: string } | null {
  const w = c.slice(-n);
  if (!w.length) return null;
  const top = w.reduce((a, b) => (b.value! > a.value! ? b : a));
  return { dd: w.at(-1)!.value! / top.value! - 1, high: top.value!, highDate: top.date };
}
// EU-Fin `streak` + its `isFinal`/`byDate` (scripts/ladder-replay.ts).
const isFinal = (p: RPt): boolean => !p.provisional && !p.estimated && p.value !== null;
const byDate = (pts: RPt[]): RPt[] => [...pts].sort((a, b) => a.date.localeCompare(b.date));
function streak(pts: RPt[], need: number, ok: (c: RPt[], i: number) => boolean): number {
  const rows = byDate(pts);
  while (rows.length && !isFinal(rows.at(-1)!)) rows.pop();
  const c = rows.filter(isFinal);
  let n = 0;
  for (let j = rows.length - 1, i = c.length - 1; j >= 0 && n < need; j--, i--) {
    if (!isFinal(rows[j]!) || !ok(c, i)) break;
    n++;
  }
  return n;
}

/** 360 closes: 30 flat at 100 (ties), an LCG walk, a +12 jump at 200 (a fresh 250-close high), a −20 slide over 220–240 (a fresh low), then the walk; ends 20 closes under the 200s high. */
const RFIX: RPt[] = (() => {
  let seed = 987654;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  const out: RPt[] = [];
  let x = 100;
  for (let i = 0; i < 360; i++) {
    if (i >= 30) x += i === 200 ? 12 : i >= 220 && i < 240 ? -1 : rnd();
    out.push({ date: `d${String(i).padStart(3, "0")}`, value: x });
  }
  return out;
})();
const NS = [1, 20, 250] as const;
const SIDES = ["high", "low"] as const;

describe("newExtreme / offHigh — verbatim parity with the probe copies", () => {
  it("newExtreme equals the EU-Fin (guarded) and Value (unguarded) copies at every index, n ∈ {1, 20, 250}, on the full fixture and a sub-n slice", () => {
    for (const c of [RFIX, RFIX.slice(0, 15)])
      for (const n of NS) {
        const idx = c.map((_, i) => i);
        expect(idx.map((i) => newExtreme(c, i, n, "high", { guard: true }))).toStrictEqual(idx.map((i) => eufinNewHigh(c, i, n)));
        expect(idx.map((i) => newExtreme(c, i, n, "low", { guard: true }))).toStrictEqual(idx.map((i) => eufinNewLow(c, i, n)));
        expect(idx.map((i) => newExtreme(c, i, n, "high", { guard: false }))).toStrictEqual(idx.map((i) => valueNewHigh(c, i, n)));
        expect(idx.map((i) => newExtreme(c, i, n, "low", { guard: false }))).toStrictEqual(idx.map((i) => valueNewLow(c, i, n)));
      }
  });
  it("offHigh equals the Value copy on every prefix, n ∈ {1, 20, 250, 500} (n > length included) and the empty series", () => {
    const ends = [0, ...RFIX.map((_, i) => i + 1)];
    for (const n of [...NS, 500]) expect(ends.map((m) => offHigh(RFIX.slice(0, m), n))).toStrictEqual(ends.map((m) => valueOffHigh(RFIX.slice(0, m), n)));
  });
  it("the streak drivers compose unchanged: quietRun of !newExtreme equals the Value/S&P IT/Semis call shape; EU-Fin streak over !newExtreme(guard) equals its copy, non-final rows included", () => {
    const ends = RFIX.map((_, i) => i + 1);
    for (const n of NS)
      for (const side of SIDES) {
        const orc = side === "high" ? valueNewHigh : valueNewLow;
        expect(ends.map((m) => ((c) => quietRun(c, 10, (i) => !newExtreme(c, i, n, side, { guard: false })))(RFIX.slice(0, m)))).toStrictEqual(
          ends.map((m) => ((c) => quietRun(c, 10, (i) => !orc(c, i, n)))(RFIX.slice(0, m))),
        );
      }
    const mixed: RPt[] = RFIX.map((p, i) => (i === 350 ? { ...p, estimated: true } : i === 359 ? { ...p, provisional: true } : p));
    for (const pts of [RFIX, mixed, [...mixed].reverse()])
      for (const n of NS)
        for (const need of [1, 5, 10, 400]) {
          expect(streak(pts, need, (c, i) => !newExtreme(c, i, n, "high", { guard: true }))).toBe(streak(pts, need, (c, i) => !eufinNewHigh(c, i, n)));
          expect(streak(pts, need, (c, i) => !newExtreme(c, i, n, "low", { guard: true }))).toBe(streak(pts, need, (c, i) => !eufinNewLow(c, i, n)));
        }
    expect(streak(mixed, 400, (c, i) => !newExtreme(c, i, 20, "high", { guard: true }))).toBeLessThan(streak(RFIX, 400, (c, i) => !newExtreme(c, i, 20, "high", { guard: true }))); // the estimated row breaks it
  });
  it("the fixture reaches every path: guarded-false vs unguarded-true on an empty window, an unguarded clamped prefix, a flat tie (not new), a fresh high and low, and highDate ≠ the last date", () => {
    const n = 20;
    expect([newExtreme(RFIX, 5, n, "high", { guard: true }), newExtreme(RFIX, 5, n, "high", { guard: false }), RFIX.slice(5 - n, 5)]).toEqual([false, true, []]); // i < n, length ≥ n: empty window
    const short = RFIX.slice(0, 15);
    expect([short.slice(5 - n, 5).length, newExtreme(short, 5, n, "high", { guard: false }), newExtreme(short, 5, n, "low", { guard: false })]).toEqual([5, false, false]); // clamped prefix, flat → not new
    expect([newExtreme(RFIX, 25, n, "high", { guard: true }), newExtreme(RFIX, 25, n, "low", { guard: true })]).toEqual([false, false]); // flat stretch: a tie is not a new extreme
    expect([newExtreme(RFIX, 200, n, "high", { guard: true }), newExtreme(RFIX, 239, n, "low", { guard: false })]).toEqual([true, true]); // the jump and the slide
    const o = offHigh(RFIX, 250)!;
    expect([o.highDate !== RFIX.at(-1)!.date, o.dd < 0, o.high > RFIX.at(-1)!.value!]).toEqual([true, true, true]);
  });
  it("the guard's boundary i = n is read (`i >= n`): index n a fresh extreme over exactly n prior closes is true; index n − 1 is guarded false", () => {
    const pts = (vals: number[]): Pt[] => vals.map((value, i) => ({ date: `e${i}`, value }));
    const [hi, lo] = [pts([1, 1, 1, 2]), pts([2, 2, 2, 1])];
    expect([newExtreme(hi, 3, 3, "high", { guard: true }), newExtreme(lo, 3, 3, "low", { guard: true }), newExtreme(hi, 2, 3, "high", { guard: true })]).toEqual([true, true, false]);
  });
});

// Recovery oracles, frozen verbatim: `retraceLine` / `postShockLow` (scripts/ladder-shock.ts), S&P IT `noLow`, EU-Fin `priorLow`,
// the Value / EU-Fin `<= line` and Semis / S&P IT `<= line + EPS` predicates.
const EPS = 1e-9;
const oRetraceLine = (sh: Peaked, frac: number): number => sh.peak - frac * (sh.peak - sh.base);
const oPostShockLow = (c: Pt[], i: number, since: string): boolean => c[i]!.date >= since && c.slice(0, i).every((p) => p.date < since || p.value! > v(c, i));
const oPriorLow = (c: Pt[], since: string) => extremeOf(c.slice(0, -1).filter((p) => p.date >= since), "low");
function oNoLow(c: Pt[], exit: string | undefined, n: number) {
  if (exit === undefined || !c.some((p) => p.date >= exit)) return null;
  return { got: run(c, n, (i) => !oPostShockLow(c, i, exit)), low: extremeOf(c.slice(0, -1).filter((p) => p.date >= exit), "low") };
}

describe("retraceLine / retraced / postShockLow / lowSince / noLowRun — verbatim parity with the probe copies", () => {
  const SINCE = ["", "d200", "d200a", "d999"]; // all, mid, a date between closes, past the end
  it("retraceLine + retraced equal the copies at every index, eps 0 and EPS, ⅓ / ½ / ¾ of a FIXTURE shock", () => {
    const sh = { peak: Math.max(...FIXTURE.map((p) => p.value!)), base: FIXTURE[300]!.value! };
    for (const f of [1 / 3, 1 / 2, 3 / 4]) {
      const line = retraceLine(sh, f);
      expect(line).toBe(oRetraceLine(sh, f));
      expect(FIXTURE.map((_, i) => [retraced(FIXTURE, i, line, { eps: 0 }), retraced(FIXTURE, i, line, { eps: EPS })])).toStrictEqual(FIXTURE.map((p) => [p.value! <= line, p.value! <= line + EPS]));
    }
  });
  it("a close ON the line is retraced; EPS/2 above it is retraced only under eps EPS", () => {
    const c: Pt[] = [{ date: "a", value: 2 }, { date: "b", value: 2 + EPS / 2 }];
    expect([retraced(c, 0, 2, { eps: 0 }), retraced(c, 1, 2, { eps: EPS }), retraced(c, 1, 2, { eps: 0 })]).toEqual([true, true, false]);
  });
  it("postShockLow, lowSince and noLowRun equal the copies on sampled prefixes, every `since` and n ∈ {1, 5, 20}; undefined → null", () => {
    const ends = sampleIdx(FIXTURE.length, LIVE).map((i) => i + 1);
    for (const s of SINCE)
      for (const m of ends) {
        const c = FIXTURE.slice(0, m);
        expect(c.map((_, i) => postShockLow(c, i, s))).toStrictEqual(c.map((_, i) => oPostShockLow(c, i, s)));
        expect(lowSince(c, s)).toStrictEqual(oPriorLow(c, s));
        for (const n of [1, 5, 20]) expect(noLowRun(c, s, n)).toStrictEqual(oNoLow(c, s, n));
      }
    expect(noLowRun(FIXTURE, undefined, 5)).toBeNull();
    expect(new Set(FIXTURE.map((_, i) => postShockLow(FIXTURE, i, "d200")))).toEqual(new Set([true, false])); // both branches reached
  });
  it("a repeated low is not a new low (strict `>`), and lowSince keeps the latest of the tie", () => {
    const c: Pt[] = [{ date: "a", value: 3 }, { date: "b", value: 1 }, { date: "c", value: 1 }, { date: "d", value: 2 }];
    expect([postShockLow(c, 1, "a"), postShockLow(c, 2, "a"), lowSince(c, "a")]).toStrictEqual([true, false, { value: 1, date: "c" }]);
    expect(noLowRun(c, "a", 5)).toStrictEqual(oNoLow(c, "a", 5));
  });
});

// Regime oracles, frozen verbatim: `ma` / `maPair` / `delta` (probe-{semis,spit}-tranches.ts), S&P IT `deltaAt`, Value `rise`.
const oMa = (c: Pt[], n: number): number | null => (c.length >= n ? vals(c.slice(-n)).reduce((a, b) => a + b, 0) / n : null);
const oDelta = (c: Pt[], n: number): number | null => (c.length > n ? c.at(-1)!.value! - c.at(-1 - n)!.value! : null);
const oDeltaAt = (c: Pt[], i: number, n: number): number | null => (i >= n ? c[i]!.value! - c[i - n]!.value! : null);

describe("ma / maPair / delta — verbatim parity with the probe copies", () => {
  it("equal the copies on sampled prefixes, n ∈ {1, 20, 50, 250}, lag ∈ {0, 5}, the n-boundary prefixes included", () => {
    for (const n of [1, 20, 50, 250]) {
      const ends = [...new Set([...sampleIdx(FIXTURE.length, LIVE).map((i) => i + 1), n - 1, n, n + 1, n + 5])].filter((m) => m >= 0 && m <= FIXTURE.length);
      for (const m of ends) {
        const c = FIXTURE.slice(0, m);
        expect([ma(c, n), delta(c, n), delta(c, n)]).toStrictEqual([oMa(c, n), oDelta(c, n), m ? oDeltaAt(c, m - 1, n) : null]);
        for (const lag of [0, 5]) expect(maPair(c, n, lag)).toStrictEqual([oMa(c, n), oMa(c.slice(0, c.length - lag), n)]);
      }
    }
    expect([ma(FIXTURE.slice(0, 19), 20), delta(FIXTURE.slice(0, 20), 20), delta(FIXTURE.slice(0, 21), 20)]).toStrictEqual([null, null, FIXTURE[20]!.value! - FIXTURE[0]!.value!]);
  });
});
