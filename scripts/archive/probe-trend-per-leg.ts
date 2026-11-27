/**
 * probe-trend-per-leg.ts — Stage-2 store-replay fidelity check for the
 * trend per-leg redesign (Option C).
 *
 * The DETERMINISTIC fixture GATE (src/trend-per-leg-gate.test.ts) is the load-bearing,
 * always-on regression pin. THIS probe is the fidelity replay: it runs the SAME real
 * engine functions over the ACTUAL DB_SMH episode (the store's LATEST persisted closes when
 * a store is reachable — it reads the STORE, not the live feed), checking:
 *   (i)  §3 cures the real DB_SMH solo-RED (dial rung does not trip on DB_SMH alone);
 *   (ii) V3 — no cell flips na→live and no per-leg power-mean denominator moves under the
 *        redesign (esp. the S&P 500 trend weights, now that per-leg trend affects the pick);
 *   (iii) V5 — the deadband/hysteresis pick (computeField is NOT a strict argmin) still
 *        behaves with `gatedTrend` in the effective danger;
 *   (iv) K1 — straight-max at floor=amber (TREND_GATE_FLOOR) does not over-rotate (trend
 *        does not re-LEAD the pick).
 *
 * FALLBACK: if no store is configured/reachable — OR the store's latest episode is not a
 * DB_SMH-solo RED — the probe uses a deterministic reconstruction of the signature and says so in
 * DATA PATH. It never blocks the stage on store availability (the fixture GATE covers correctness).
 *
 * Run: tsx --env-file-if-exists=.env.local scripts/probe-trend-per-leg.ts
 */
import type { State } from "../src/domain.js";
import {
  GLOBAL_FAMILIES,
  computeFamilyPanel,
  coincidentContribution,
  type FamilyPanel,
} from "../src/families.js";
import { computeT1Dial, techConfirmerFromPanel, techConfirmerBreadth } from "../src/t1dial.js";
import {
  computeField,
  computeCells,
  pillarValue,
  TREND_GATE_FLOOR,
  type DangerInput,
} from "../src/danger-engine.js";
import { buildMemberState } from "../src/danger-member-state.js";
import { LEG_FIELD, SIGNALS, type SignalKey } from "../src/danger-ladder.js";

const S = (id: string, state: State) => ({ id, state });
const panelOf = (r: { id: string; state: State }[]): FamilyPanel[] =>
  computeFamilyPanel(r, GLOBAL_FAMILIES).families;
const gf = (members: { id: string; state: State }[]): DangerInput => ({
  globalFamilies: [
    { key: "credit", label: "", state: null, live: true, firing: false, contribution: null, absent: 0, members: members.map((m) => ({ ...m, label: m.id })) },
  ],
});

let ok = true;
const check = (name: string, pass: boolean, detail = "") => {
  ok = ok && pass;
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
};

// ── Data path: fresh store closes when reachable, else synthesized ────────────────────
type MemberSnap = { id: string; state: State };
async function loadEpisode(): Promise<{ path: string; readings: MemberSnap[]; asOf: string }> {
  // DERIVED, not hand-typed: the literal here had gone doubly stale (still carried NVDA and
  // DB_SMH, both dropped from trend 2026-07-21/22; missing SPCONC, added 2026-07-23), so the
  // V3 arm below reasoned over a member set production no longer has.
  const trendIds = [...GLOBAL_FAMILIES.find((f) => f.key === "trend")!.ids];
  const armIds = ["F1", "R1", "R5", "CG", "G1"];
  try {
    const { getStore } = await import("../src/store.js");
    const store = getStore(); // fails loud without SUPABASE_URL + SUPABASE_SERVICE_KEY
    const ids = [...new Set([...trendIds, ...armIds])];
    const bulk = await store.getSeriesBulk(ids, { limit: 1 });
    const readings: MemberSnap[] = [];
    let asOf = "";
    for (const id of ids) {
      const pt = bulk.get(id)?.[0];
      if (pt) {
        readings.push(S(id, pt.state));
        if (pt.date > asOf) asOf = pt.date;
      }
    }
    if (readings.length > 0) return { path: "store (fresh closes)", readings, asOf: asOf || "latest" };
  } catch (e) {
    console.log(`  (store unreachable: ${(e as Error).message.split("\n")[0]}) — falling back`);
  }
  // Synthesized reconstruction of the 2026-07-21 DB_SMH-solo signature.
  return {
    path: "synthesized (deterministic reconstruction)",
    asOf: "2026-07-21",
    readings: [
      S("F1", "AMBER"), S("R1", "GREEN"), S("R5", "GREEN"), S("CG", "GREEN"),
      S("GT", "GREEN"), S("GB", "GREEN"), S("DB_SMH", "RED"), S("F5", "GREEN"),
      S("NVDA", "GREEN"), S("G1", "GREEN"),
    ],
  };
}

async function main() {
  const episode = await loadEpisode();
  const { readings, asOf } = episode;
  let path = episode.path;

  // If the store episode isn't a DB_SMH-solo one, force the solo signature so the checks are
  // meaningful — and REFLECT the swap in the reported DATA PATH (a store may currently be calm).
  const trend0 = panelOf(readings).find((f) => f.key === "trend")!;
  const dbSolo =
    trend0.members.find((m) => m.id === "DB_SMH")?.state === "RED" &&
    !["GT", "GB"].some((id) => trend0.members.find((m) => m.id === id)?.state === "RED");
  let epi = readings;
  if (!dbSolo) {
    if (path.startsWith("store")) path += " → FORCED synthesized solo (store episode was not a DB_SMH-solo RED)";
    epi = [
      S("F1", "AMBER"), S("R1", "GREEN"), S("R5", "GREEN"), S("CG", "GREEN"),
      S("GT", "GREEN"), S("GB", "GREEN"), S("DB_SMH", "RED"), S("F5", "GREEN"),
      S("NVDA", "GREEN"), S("G1", "GREEN"),
    ];
  }
  console.log(`\nprobe-trend-per-leg — DATA PATH = ${path}  (asOf ${asOf})\n`);

  // (i) §3 cures the solo-RED — neither band-depth path lifts the rung.
  const panel = panelOf(epi);
  const tp = panel.find((f) => f.key === "trend")!;
  const techP = techConfirmerBreadth(techConfirmerFromPanel(panel));
  const dial = computeT1Dial(panel, techP);
  check("(i) coincidentP path blocked — trend depth reads 0 (GT/GB calm)", coincidentContribution(tp) === 0);
  check("(i) techConfirmerP path blocked — <2-of-3 floor", techP === 0, `techP=${techP}`);
  check("(i) rung does NOT reach WARNING (targetRung < 5) on the DB_SMH solo", dial.targetRung < 5, `targetRung=${dial.targetRung}`);

  // (ii) V3 — na→live / denominator invariance. The redesign (Option C) changes NO family ids
  // and NO weights, so per-leg cell liveness must be byte-identical to a DB_SMH-absent panel.
  // Compare the live-cell (non-na) SIGNAL set per leg with DB_SMH present vs removed.
  const withoutDb = epi.filter((r) => r.id !== "DB_SMH");
  const liveSig = (members: { id: string; state: State }[]) => {
    const ms = buildMemberState(gf(members));
    return LEG_FIELD.map((l) => {
      const cells = computeCells(l, ms);
      const live = SIGNALS.filter((f: SignalKey) => cells.find((c) => c.family === f)!.wsev !== null);
      return `${l.sleeve}:${live.join(",")}`;
    }).join("|");
  };
  const denomStable = liveSig(epi) === liveSig(withoutDb);
  check("(ii) V3 — no cell flips na→live / denominator unmoved by DB_SMH (all legs)", denomStable);

  // (iii)/(iv) V5 + K1 — held pick behaves and trend does not RE-LEAD. Feed the FIELD path
  // (which carries gatedTrend) a DB_SMH-solo with NO EW/SN stress: gate CLOSED ⇒ the pick must
  // be identical to the DB_SMH-absent field (trend cannot lead a calm leg).
  const bandNow = dial.band;
  const soloField = computeField(gf([S("DB_SMH", "RED")]), bandNow);
  const calmField = computeField(gf([]), bandNow);
  check(
    "(iv) K1 — DB_SMH solo (no EW/SN stress) does NOT re-lead the pick (gate closed, held unchanged)",
    soloField.held?.sleeve === calmField.held?.sleeve,
    `held=${soloField.held?.sleeve} vs ${calmField.held?.sleeve}`,
  );
  // (iii) V5 — with EW/SN stress present the deadband pick is still a valid in-band leg (not a
  // crash, not out-of-band) once gatedTrend enters the effective danger.
  const stressed = computeField(gf([S("R5", "RED"), S("CG", "RED"), S("DB_SMH", "RED")]), bandNow);
  const held = stressed.held;
  const inBand = held ? held.risk >= bandNow.lo && held.risk <= bandNow.hi : bandNow.lo > 9;
  check("(iii) V5 — deadband pick stays in-band with gatedTrend in effective danger", inBand, `held=${held?.sleeve} band=[${bandNow.lo},${bandNow.hi}]`);
  check("(iii) V5 — gate OPEN vacuity: Semis SN clears TREND_GATE_FLOOR in the stressed replay",
    (pillarValue(stressed.legRows.find((r) => r.sleeve === "Semis")!.subDangers.stressNow) ?? 0) >= TREND_GATE_FLOOR);

  console.log(`\n  RESULT: ${ok ? "ALL CHECKS PASS" : "FAILURES ABOVE"}  (data path: ${path})\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
