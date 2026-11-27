import { describe, expect, it } from "vitest";
import { DANGER_CUTS } from "./danger-concentration.js";
import {
  computeField,
  pillarValue,
  type DangerBand,
  type DangerInput,
  type FieldResult,
} from "./danger-engine.js";
import { gf } from "./danger-engine.test-helpers.js";
import { FAMILY_MEMBERS, LEG_FIELD, MEMBER_WEIGHT, SIGNALS, type SignalKey } from "./danger-ladder.js";
import { buildMemberState } from "./danger-member-state.js";
import type { State } from "./domain-types.js";
import {
  familiesLit,
  familyShare,
  GP_CAP_FRACTION,
  legDangerShare,
  pillarShare,
  SYSTEMIC_KAPPA,
  trendShare,
  type ShareMemberState,
} from "./danger-share.js";

type Rag = "RED" | "AMBER" | "GREEN";
const SEV = { RED: "lit", AMBER: "elev", GREEN: "calm" } as const;
const st = (spec: Record<string, Rag>): ShareMemberState =>
  Object.fromEntries(Object.entries(spec).map(([id, s]) => [id, { sev: SEV[s] }]));
const every = (families: readonly SignalKey[], s: Rag): Record<string, Rag> =>
  Object.fromEntries(families.flatMap((f) => FAMILY_MEMBERS[f].map((m) => [m, s])));
const EW: SignalKey[] = ["cr", "rt", "vb"];

describe("familyShare", () => {
  it("Σ w·sev / Σ w over observed relevant members; absent and irrelevant members leave both sums", () => {
    // xa × Semis: FXH .6 RED, F11 .8 AMBER, F9 .6 GREEN, CG absent, DISP irrelevant ⇒ (.6 + .4) / 2.0
    expect(familyShare("xa", "Semis", st({ FXH: "RED", F11: "AMBER", F9: "GREEN", DISP: "RED" }))).toBeCloseTo(0.5, 12);
    expect(familyShare("xa", "Semis", st({ VT: "RED" }))).toBeNull();
  });
});

describe("pillarShare", () => {
  it("unobserved family leaves n", () => {
    // Semis EW: cr = F1 RED alone (1), rt dark, vb ECY GREEN (0) ⇒ (.6·1 + .6·0) / (.6 + .6); rt at 0 would read .27
    const p = pillarShare("EARLY-WARN", "Semis", st({ F1: "RED", ECY: "GREEN" }), 0.5);
    expect(p).toEqual({ value: expect.closeTo(0.5, 12) as number, lit: 1, of: 2 });
  });

  it("irrelevant family not counted", () => {
    // Semis SN: xa observed only through DISP/F17 (no Semis weight), vl = VT GREEN ⇒ vl alone
    expect(pillarShare("STRESS-NOW", "Semis", st({ DISP: "RED", F17: "RED", VT: "GREEN" }), 0.5)).toEqual({
      value: 0,
      lit: 0,
      of: 1,
    });
  });

  it("n = 1 takes no boost", () => {
    expect(pillarShare("EARLY-WARN", "Semis", st(every(["cr"], "AMBER")), 0.5)).toEqual({ value: 0.5, lit: 1, of: 1 });
  });

  it("boost = κ·(lit − 1)/(of − 1), none below two lit", () => {
    // Semis: cr .5, rt .5, vb 0 ⇒ mean (.6·.5 + 1·.5) / 2.2; 2 of 3 lit ⇒ × (1 + .25·1/2)
    const two = st({ ...every(["cr", "rt"], "AMBER"), ECY: "GREEN" });
    expect(pillarShare("EARLY-WARN", "Semis", two, 0.25)!.value).toBeCloseTo((0.8 / 2.2) * 1.125, 12);
    // cr = F1 RED alone (F1's Semis weight over the cr family's Semis weight sum), rt GREEN ⇒ 0 lit of 2, mean stays unboosted
    const none = st({ ...every(["cr", "rt"], "GREEN"), F1: "RED" });
    const crSum = FAMILY_MEMBERS.cr.reduce((a, m) => a + (MEMBER_WEIGHT[m]?.Semis ?? 0), 0);
    expect(pillarShare("EARLY-WARN", "Semis", none, 0.5)!.value).toBeCloseTo((0.6 * (MEMBER_WEIGHT.F1!.Semis! / crSum)) / 1.6, 12);
  });

  it("caps the boosted pillar at 1", () => {
    expect(pillarShare("EARLY-WARN", "Semis", st(every(EW, "RED")), 0.5)).toEqual({ value: 1, lit: 3, of: 3 });
  });
});

describe("familiesLit", () => {
  it("a lower cuts.amber flips a family to lit", () => {
    // xa × Semis: FXH RED, F9/F11/CG GREEN ⇒ .6 / 2.6 ≈ .2308, between .2 and DANGER_CUTS.amber
    const s = st({ FXH: "RED", F9: "GREEN", F11: "GREEN", CG: "GREEN" });
    expect(0.6 / 2.6).toBeLessThan(DANGER_CUTS.amber);
    expect(familiesLit("Semis", s).stressNow).toEqual({ lit: 0, of: 1 });
    expect(familiesLit("Semis", s, { amber: 0.2, red: 0.4 }).stressNow).toEqual({ lit: 1, of: 1 });
  });
});

describe("legDangerShare", () => {
  it("Semis EW 3/3 lit ⇒ trend at full weight", () => {
    // EW families all .5 ⇒ 3/3 lit, κ = .5 ⇒ .5 × 1.5; uT = GT RED, rest GREEN ⇒ 1 / 5.4
    const s = st({ ...every(EW, "AMBER"), ...every(["uT"], "GREEN"), GT: "RED" });
    const r = legDangerShare("Semis", s, 0.5);
    expect(r.familiesLit.earlyWarn).toEqual({ lit: 3, of: 3 });
    expect(r.earlyWarn!.value).toBeCloseTo(0.75, 12);
    expect(r.trend).toBeCloseTo(1 / 5.4, 12);
  });

  it("a leg whose trend weights sum below 1 tops out at that sum (GT alone on Health / Staples)", () => {
    // EW families all .5 ⇒ gate fully open; GT is the only uT member reaching either defensive leg.
    // A plain average over that one member cancels its weight to 1.0 — prod 2026-11-06 read 1.0 on both.
    const { Health: h, Staples: sp } = MEMBER_WEIGHT.GT!;
    expect(h).toBeLessThan(1);
    expect(sp).toBeLessThan(1);
    const s = st({ ...every(EW, "AMBER"), ...every(["uT"], "GREEN"), GT: "RED" });
    expect(familyShare("uT", "Health", s)).toBe(1);
    expect(legDangerShare("Health", s, 0.5).trend).toBeCloseTo(h!, 12);
    expect(legDangerShare("Staples", s, 0.5).trend).toBeCloseTo(sp!, 12);
  });

  it("an unobserved uT member is dropped, not read calm: ex-US GT RED, GB absent ⇒ trend share 1", () => {
    // premise: GT and GB are the only uT members reaching ex-US, and their full Σ w ≥ 1 (no ceiling)
    const reach = FAMILY_MEMBERS.uT.filter((m) => (MEMBER_WEIGHT[m]?.["ex-US"] ?? 0) > 0);
    expect(reach).toEqual(["GT", "GB"]);
    expect(MEMBER_WEIGHT.GT!["ex-US"]! + MEMBER_WEIGHT.GB!["ex-US"]!).toBeGreaterThanOrEqual(1);
    expect(trendShare("ex-US", st({ GT: "RED" }))).toBeCloseTo(1, 12);
  });

  it("EW share = amber/2 ⇒ trend term = uT share/2", () => {
    // rt × Semis: R4 1.0 AMBER, R1 .6 + R3/R6/R7 .8 GREEN ⇒ .5 / 4.0 = .125 = amber/2; uT = GT RED, GB GREEN ⇒ .5
    const s = st({ R4: "AMBER", R1: "GREEN", R3: "GREEN", R6: "GREEN", R7: "GREEN", GT: "RED", GB: "GREEN" });
    const r = legDangerShare("Semis", s, 0, { amber: 0.25, red: 0.75 });
    expect(r.earlyWarn!.value).toBeCloseTo(0.125, 12);
    expect(r.trend).toBeCloseTo(0.25, 12);
    expect(r.danger).toBeCloseTo(0.25, 12);
  });

  it("gp alone caps strictly below cuts.amber; unobserved terms read null and 0", () => {
    const cap = GP_CAP_FRACTION * DANGER_CUTS.amber;
    const r = legDangerShare("Semis", st(every(["gp"], "RED")), 0.5);
    expect([r.gp, r.danger, r.earlyWarn, r.stressNow, r.trend]).toEqual([cap, cap, null, null, null]);
    expect(r.danger).toBeLessThan(DANGER_CUTS.amber);
    expect(legDangerShare("Semis", st(every(["gp"], "RED")), 0.5, { amber: 0.1, red: 0.4 }).danger).toBeLessThan(0.1);
  });

  it("solo FXH RED with every other member observed GREEN keeps every leg below cuts.red", () => {
    // worst leg Health/Staples: SN = .5·(.3 / .6) / (.4 + .5) ≈ .278; one family lit ⇒ no boost
    const s = st({ ...every(SIGNALS, "GREEN"), FXH: "RED" });
    const dangers = LEG_FIELD.map((l) => [l.sleeve, legDangerShare(l.sleeve, s, 0.5).danger] as const);
    expect(dangers.filter(([, d]) => d >= DANGER_CUTS.red)).toEqual([]);
    expect(Math.max(...dangers.map(([, d]) => d))).toBeCloseTo(0.25 / 0.9, 12);
  });
});

describe("computeField share engine", () => {
  const ALL_IDS = [...new Set(SIGNALS.flatMap((f) => FAMILY_MEMBERS[f]))];
  const redOnly = (ids: string[]): DangerInput =>
    gf(ALL_IDS.map((id) => ({ id, state: (ids.includes(id) ? "RED" : "GREEN") as State })));
  const row = (f: FieldResult, s: string) => f.legRows.find((l) => l.sleeve === s)!;
  const ALL: DangerBand = { lo: 1, hi: 9 };

  it("each row's danger and familiesLit equal the pure module at SYSTEMIC_KAPPA", () => {
    // FXH+R5 RED: Health reads .722 at κ = 0, 1 at κ = .5 — the fixture discriminates κ
    const d = redOnly(["FXH", "R5"]);
    const ms = buildMemberState(d);
    const f = computeField(d, ALL);
    expect(f.legRows.map((l) => [l.sleeve, l.danger, l.familiesLit])).toEqual(
      LEG_FIELD.map((l) => {
        const r = legDangerShare(l.sleeve, ms, SYSTEMIC_KAPPA);
        return [l.sleeve, r.danger, r.familiesLit];
      }),
    );
  });

  it("row.subDangers carries the share terms: pillars === pillarShare at SYSTEMIC_KAPPA, danger === max(EW, SN, trend ?? 0, gp ?? 0)", () => {
    const world = (spec: Record<string, Rag>): DangerInput =>
      gf(ALL_IDS.map((id) => ({ id, state: (spec[id] ?? "GREEN") as State })));
    const worlds = [
      world({ FXH: "RED", R5: "RED" }),
      world(every(["gp"], "RED")), // gp is the only lit term
      world({ ...every(EW, "AMBER"), ...every(["uT"], "RED") }), // trend out-ranks both pillars
    ];
    const rows = worlds.flatMap((d) => {
      const ms = buildMemberState(d);
      return computeField(d, ALL).legRows.map((r) => ({ r, ms }));
    });
    const terms = rows.map(({ r, ms }) => {
      const ew = pillarValue(r.subDangers.earlyWarn);
      const sn = pillarValue(r.subDangers.stressNow);
      const { trend, gp } = r.subDangers;
      const pure = (p: "EARLY-WARN" | "STRESS-NOW") => pillarShare(p, r.sleeve, ms, SYSTEMIC_KAPPA)?.value ?? null;
      return { r, ew, sn, trend, gp, pillarMax: Math.max(ew ?? 0, sn ?? 0), pureEw: pure("EARLY-WARN"), pureSn: pure("STRESS-NOW") };
    });
    expect(terms.filter((t) => t.ew !== t.pureEw || t.sn !== t.pureSn).map((t) => t.r.sleeve)).toEqual([]);
    expect(terms.filter((t) => t.r.danger !== Math.max(t.pillarMax, t.trend ?? 0, t.gp ?? 0)).map((t) => t.r.sleeve)).toEqual([]);
    // vacuity: each non-pillar term is the strict max on some row, and EW ≠ SN on some row
    expect(terms.some((t) => t.trend !== null && t.trend > Math.max(t.pillarMax, t.gp ?? 0))).toBe(true);
    expect(terms.some((t) => t.gp !== null && t.gp > Math.max(t.pillarMax, t.trend ?? 0))).toBe(true);
    expect(terms.some((t) => t.ew !== t.sn)).toBe(true);
  });

  it("the ledger Trend column reads the weight-capped trend share, not the plain average", () => {
    // GT RED alone: Health's/Staples' only uT member ⇒ its weight (a plain average would read 1.0)
    const { Health: h, Staples: sp } = MEMBER_WEIGHT.GT!;
    expect(h).toBeLessThan(1);
    expect(sp).toBeLessThan(1);
    const f = computeField(redOnly(["GT"]), ALL);
    expect(row(f, "Health").trend.value).toBeCloseTo(h!, 12);
    expect(row(f, "Staples").trend.value).toBeCloseTo(sp!, 12);
  });

  it("the pick reads LEG_SENSITIVITY × danger while rows keep plain danger", () => {
    // FXH RED: Health .278 > EU-Fin .160 plain, but .32·.278 < .72·.160 scaled
    const f = computeField(redOnly(["FXH"]), { lo: 7, hi: 8 });
    expect(row(f, "Health").danger).toBeGreaterThan(row(f, "EU-Fin").danger);
    expect(f.held?.sleeve).toBe("Health");
  });
});
