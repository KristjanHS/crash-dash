/**
 * Band-driving-per-leg split — the POST-HOC falsifier, per family via `--family=<credit|rates>`.
 *
 *   bash scripts/with-prod-config.sh tsx scripts/probe-band-split.ts --env=prod --family=rates                 # prod (the prod config), read-only
 *   bash scripts/with-prod-config.sh tsx scripts/probe-band-split.ts --env=prod --family=rates --closes=1500 --out=/tmp/band-split.json
 *
 * Both roster flips ship on `main`: `computeT1Dial` reads each restricted family's BAND role
 * (`bandOf(f)`), so a lone per-leg-only member (credit: F10/F13; rates: R6/R7/EURC/BUND)
 * firing no longer arms the dial. This replay is therefore a FALSIFIER, not a tuning aid: a split can
 * only ever LOWER a band, so ANY raise it finds is a SHIPPED DEFECT that owes a fix commit.
 *
 * Three separate report lines (§Verification harness + the owed-rung contract):
 *   1. band flips — the pushed notify band, TREATMENT (main) vs CONTROL (pre-split). Raises are
 *      reported LOUDLY and separately from lowers; a raise is the falsifier tripping.
 *   2. R4 ENTER-days before/after — the breadth key `leadingFiring + coincidentFiring >=
 *      R4_ENTER_FAMILIES` (`src/r4.ts`), counted per arm (S2's condition of ruling: report it, do
 *      not fold it into the flip count).
 *   3. bridge-seated days — the family's bridge rate: how often the bridge id (CQS for credit, R8 for
 *      rates) substituted for a stale/absent bridged id (EBP / R1) in the served `<family>.band.ids`.
 *
 * ⚠ **STRICTLY READ-ONLY:** `getSeries` selects only — never insert/update/delete/upsert. The
 * dev-DB history is irreplaceable (`docs/reference.md` §[runbook] Database (local Supabase)); do not add a write here.
 *
 * ⚠ **THE CONTROL ARM STRIPS ONLY THE MEASURED FAMILY'S BAND, never the imported treatment.**
 * This is the trap `scripts/probe-leader-split.ts` documents: once `t1dial.ts` reads `f.band`,
 * feeding the SAME panel to `computeT1Dial` for both arms collapses the comparison to A/A and its
 * perfect agreement reads as "no regression". The control is the PRE-SPLIT world FOR THE MEASURED
 * FAMILY ONLY, reconstructed by `stripBandRole(panel, family)` — deleting that family's `band` so
 * `bandOf` falls back to its unrestricted `state`/`firing`/`contribution`/`members`, while the OTHER
 * split family keeps its shipped restriction. With credit already flipped on `main`, stripping every
 * family would measure credit+rates COMBINED and attribute the sum to the one family; stripping one
 * isolates its split alone. The width `Math.max(firingSplit(leading), firingSplit(leading, bandOf))`
 * collapses on the stripped family to a single `firingSplit(leading)`, exactly the pre-S4 form.
 *
 * ⚠ **IDENTICAL-ARMS THROW-GUARD (`selfCheck`, runs FIRST — store or no store).** If the two arms
 * are identical BY CONSTRUCTION — `stripBandRole` a no-op, or the treatment imported for both — the
 * probe THROWS rather than reporting a vacuous agreement. `selfCheck(family)` proves non-identity on a
 * SYNTHETIC divergence panel (that family's band roster GREEN, a per-leg-only member firing ⇒
 * treatment `leadingFiring` 0, control 1) and proves the control is a faithful pre-split IDENTITY on a
 * band-unrestricted panel (the two agree). Either property failing aborts the run.
 */
import { writeFileSync } from "node:fs";
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import {
  computeFamilyPanel,
  CREDIT_BRIDGE,
  BAND_DRIVING_CREDIT_MEMBERS,
  RATES_BRIDGE,
  BAND_DRIVING_RATES_MEMBERS,
  type FamilyPanel,
  type FamilyKey,
} from "../src/families.js";
import { DIAL_FAMILIES } from "../src/dial-assembly.js";
import {
  computeT1Dial,
  techConfirmerBreadth,
  techConfirmerFromPanel,
  type T1DialResult,
} from "../src/t1dial.js";
import { computeR4, R4_ENTER_FAMILIES, type R4State } from "../src/r4.js";
import { computeAlertBandDetail, regimeToBand, DE_ESCALATION_DAYS } from "../src/alert-band.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { ALERT_RANK, type AlertLevel } from "../src/ladder.js";
import type { Reading, State } from "../src/domain-types.js";
import { argOf, envArg as envArgOf } from "./lib/cli.js";
import { loadSeries, calendarFrom, selectReplayDates, makeCursor, walkReplay } from "./lib/replay-walk.js";
import type { SeriesPoint } from "../src/store.js";

// ---------- pure helpers ----------

/** The two band-restricted LEADING families this probe can measure. */
export type BandFamily = "credit" | "rates";

/** Per-family fixtures for `selfCheck`: the band roster, its stale-bridge, a PER-LEG-ONLY member
 *  (never in the band roster — its fire must NOT arm the treatment) and a band-roster IDENTITY member. */
export const FAMILY_CFG: Record<
  BandFamily,
  { members: readonly string[]; bridge: { bridge: string; bridged: string }; perLeg: string; identity: string }
> = {
  credit: { members: BAND_DRIVING_CREDIT_MEMBERS, bridge: CREDIT_BRIDGE, perLeg: "F10", identity: "F1" },
  rates: { members: BAND_DRIVING_RATES_MEMBERS, bridge: RATES_BRIDGE, perLeg: "R7", identity: "R1" },
};

/**
 * Reconstruct the pre-split panel for the CONTROL arm: strip the `band` field from ONLY the measured
 * `family` so the shipped `computeT1Dial`'s `bandOf` falls back to that family's unrestricted
 * state/firing/contribution/members, while every OTHER family keeps its shipped band role. With credit
 * already flipped on `main`, stripping every family would measure credit+rates COMBINED; stripping
 * one isolates exactly the measured family's split. Never mutates the input.
 */
export function stripBandRole(families: readonly FamilyPanel[], family: FamilyKey): FamilyPanel[] {
  return families.map((f) => {
    if (f.key !== family) return f;
    const { band: _band, ...rest } = f;
    return rest;
  });
}

/** Flip direction by notify rank. RAISE is the falsifier tripping; the split may only ever LOWER. */
export function classifyFlip(treatment: AlertLevel, control: AlertLevel): "raise" | "lower" | "same" {
  const t = ALERT_RANK[treatment];
  const c = ALERT_RANK[control];
  return t > c ? "raise" : t < c ? "lower" : "same";
}

/** R4 breadth key (S2) — the ENTER cond-1 breadth predicate, read off the dial. */
export function r4EnterBreadth(dial: T1DialResult): boolean {
  return dial.leadingFiring + dial.coincidentFiring >= R4_ENTER_FAMILIES;
}

const CONTRIB: Record<State, number> = { GREEN: 0, AMBER: 0.5, RED: 1 };

/** Minimal synthetic family for `selfCheck` — only the fields `computeT1Dial` reads. */
function synthFamily(
  key: FamilyPanel["key"],
  state: State,
  members: { id: string; state: State }[],
  band?: FamilyPanel["band"],
): FamilyPanel {
  const firing = state !== "GREEN";
  const f: FamilyPanel = {
    key,
    label: key,
    state,
    live: true,
    firing,
    contribution: firing ? CONTRIB[state] : null,
    absent: 0,
    members: members.map((m) => ({ ...m, label: m.id })),
    note: undefined,
    desc: undefined,
  };
  if (band !== undefined) f.band = band;
  return f;
}

/** Worst-of RAG over a member set → a band role (mirrors families.ts `bandRoleOf` closely enough
 *  for the synthetic panels; `selfCheck` only reads `.firing`). */
function bandRole(ids: readonly string[], members: { id: string; state: State }[]): FamilyPanel["band"] {
  const seated = members.filter((m) => ids.includes(m.id));
  const rank: Record<State, number> = { GREEN: 0, AMBER: 1, RED: 2 };
  const state: State | null = seated.length
    ? seated.reduce<State>((w, m) => (rank[m.state] > rank[w] ? m.state : w), seated[0]!.state)
    : null;
  return { state, firing: state !== null && state !== "GREEN", contribution: state === null ? null : CONTRIB[state], ids };
}

/** GREEN, live stand-in for a family the divergence panel is NOT exercising — folds without noise. */
function greenFamily(k: FamilyKey): FamilyPanel {
  return synthFamily(k, "GREEN", [{ id: `${k}-m`, state: "GREEN" }], bandRole([`${k}-m`], [{ id: `${k}-m`, state: "GREEN" }]));
}

/**
 * The NON-VACUITY + identical-arms guard for the SELECTED `family`. Returns an error string when the
 * arms are A/A by construction (or the control is not a faithful pre-split identity), else `null`.
 *
 * Every other family is GREEN and live, so the dial folds without absence noise; only the measured
 * family's band role is varied. Runs against `computeT1Dial` DIRECTLY (no store) so it fires whether
 * or not prod is reachable.
 */
export function selfCheck(family: BandFamily): string | null {
  const cfg = FAMILY_CFG[family];
  const others = (["credit", "rates", "volatility", "cross-asset", "trend"] as const)
    .filter((k) => k !== family)
    .map(greenFamily);

  // (A) DIVERGENCE panel: the measured family's band roster all GREEN, a per-leg-only member
  //     AMBER-firing. Treatment reads band.firing=false ⇒ the family does NOT arm; control (its band
  //     stripped) reads the full-roster f.firing=true ⇒ it arms. leadingFiring MUST differ.
  const divMembers = [
    ...cfg.members.map((id) => ({ id, state: "GREEN" as State })),
    { id: cfg.perLeg, state: "AMBER" as State },
  ];
  const famDiv = synthFamily(family, "AMBER", divMembers, bandRole(cfg.members, divMembers));
  const divPanel = [famDiv, ...others];
  const tDiv = computeT1Dial(divPanel);
  const cDiv = computeT1Dial(stripBandRole(divPanel, family));
  // The identical-arms guard FIRST — on UN-narrowed counts, so it fires when stripBandRole is a
  // no-op or the treatment is imported for both arms (the A/A trap).
  if (tDiv.leadingFiring === cDiv.leadingFiring)
    return `arms are A/A BY CONSTRUCTION — control did not diverge from treatment on a per-leg-only ${family} fire (${cfg.perLeg}) (stripBandRole a no-op, or treatment imported for both). Refusing to report.`;
  if (tDiv.leadingFiring !== 0) return `divergence: treatment leadingFiring must be 0 (band roster GREEN), got ${tDiv.leadingFiring}`;
  if (cDiv.leadingFiring !== 1) return `divergence: control leadingFiring must be 1 (full roster fires), got ${cDiv.leadingFiring}`;

  // (B) IDENTITY panel: a BAND-roster member AMBER-firing ⇒ band.firing=true=f.firing. The control
  //     must be a FAITHFUL pre-split identity here (no spurious divergence).
  const idMembers = [
    { id: cfg.identity, state: "AMBER" as State },
    ...cfg.members.filter((id) => id !== cfg.identity).map((id) => ({ id, state: "GREEN" as State })),
  ];
  const famId = synthFamily(family, "AMBER", idMembers, bandRole(cfg.members, idMembers));
  const idPanel = [famId, ...others];
  const tId = computeT1Dial(idPanel);
  const cId = computeT1Dial(stripBandRole(idPanel, family));
  if (tId.leadingFiring !== cId.leadingFiring)
    return `identity: a band-roster fire must leave the arms equal, got treatment=${tId.leadingFiring} control=${cId.leadingFiring}`;

  return null;
}

// ---------- IO / main (guarded — the test imports the helpers above without running this) ----------

async function main(): Promise<void> {
  const envArg = envArgOf("local");
  const REPLAY_N = Number(argOf("closes") ?? 1500);
  const fromArg = argOf("from");
  const toArg = argOf("to");
  const outArg = argOf("out");
  const FETCH_SLACK = 400;

  const familyArg = (argOf("family") ?? "credit") as BandFamily;
  if (familyArg !== "credit" && familyArg !== "rates") {
    console.log(`ABORT: --family must be credit|rates (got ${argOf("family")}).`);
    process.exit(1);
  }
  const FAMILY: BandFamily = familyArg;
  const CFG = FAMILY_CFG[FAMILY];

  if (!Number.isFinite(REPLAY_N) || REPLAY_N < 1) {
    console.log(`ABORT: --closes must be a positive integer (got ${argOf("closes")}).`);
    process.exit(1);
  }

  // Non-vacuity / identical-arms guard FIRST — store or no store.
  const selfErr = selfCheck(FAMILY);
  if (selfErr) throw new Error(`SELF-CHECK FAILED (probe would be vacuous): ${selfErr}`);
  console.log(
    `SELF-CHECK OK (${FAMILY}): on a per-leg-only ${FAMILY} fire (${CFG.perLeg}) the arms diverge (treatment 0 vs control 1 ` +
      "leading), and on a band-roster fire the control is a faithful pre-flip identity.\n",
  );

  // ---------- store (read-only usage) ----------
  let store;
  try {
    store = await resolveStore(envArg, "ro", liveResolveDeps);
  } catch (e: unknown) {
    console.log(
      `ABORT (store): no store reachable for --env=${envArg} — ${e instanceof Error ? e.message : String(e)}\n` +
        "    For prod: .env.prod creds (npm entry) or ~/.supabase/access-token.",
    );
    process.exit(1);
  }

  // ---------- data pull (READ-ONLY: getSeries selects only) ----------
  const indicatorById = new Map(ALL_INDICATORS.map((ind) => [ind.id, ind]));
  const memberIds = [...new Set(ALL_INDICATORS.map((i) => i.id))];
  const seriesById: Map<string, SeriesPoint[]> = await loadSeries(store, memberIds, REPLAY_N + FETCH_SLACK);

  const empty = memberIds.filter((id) => (seriesById.get(id) ?? []).length === 0);
  console.log(`band-split falsifier — family=${FAMILY}  env=${envArg}  closes=${REPLAY_N}`);
  console.log(
    `indicators: ${memberIds.length} configured, ${memberIds.length - empty.length} with persisted series, ${empty.length} empty`,
  );

  const calendar = calendarFrom(seriesById);
  const replayDates = selectReplayDates({ calendar, replayN: REPLAY_N, fromArg, toArg });
  const cursor = makeCursor(seriesById);

  // ---------- per-arm fold state (lag + R4 are path-dependent, so each arm carries its own) ----------
  /** de-escalation lag looks back `n−1` raw bands (n = DE_ESCALATION_DAYS). */
  const RECENT_KEEP = Math.max(1, DE_ESCALATION_DAYS - 1);
  interface Arm {
    recent: AlertLevel[];
    bands: AlertLevel[];
    r4Prior: R4State;
    r4EnterDays: number; // report line 2
  }
  const mkArm = (): Arm => ({ recent: [], bands: [], r4Prior: { phase: "equity", entryFiredAt: null, reentryRung: null }, r4EnterDays: 0 });

  function stepArm(arm: Arm, date: string, dial: T1DialResult, readings: Reading[], f1: number | null, vt: number | null): void {
    const r4 = computeR4(dial, f1, vt, arm.r4Prior, () => date);
    arm.r4Prior = { phase: r4.phase, entryFiredAt: r4.entryFiredAt, reentryRung: r4.reentryRung };
    if (r4EnterBreadth(dial)) arm.r4EnterDays++;
    const band = computeAlertBandDetail({
      dial,
      readings,
      geoFlags: 0, // no replayable manual-flag/stage history (replay GEO note)
      r4Phase: r4.phase,
      recentDialBands: arm.recent,
      n: DE_ESCALATION_DAYS,
    }).band;
    arm.recent = [regimeToBand(dial.notifyRegime), ...arm.recent].slice(0, RECENT_KEEP);
    arm.bands.push(band);
  }

  interface Fold {
    dates: string[];
    treat: Arm;
    control: Arm;
    bridgeSeatedDays: number; // report line 3 — the bridge id (CQS/R8) seated in the served band.ids
    bridgedSeatedDays: number; // the bridged id (EBP/R1) seated
    bandRestrictedDays: number; // days the family's band roster ⊊ full roster (the split biting)
  }

  const fold = await walkReplay<Fold>({
    dates: replayDates,
    seriesById,
    ids: memberIds,
    cursor,
    initial: { dates: [], treat: mkArm(), control: mkArm(), bridgeSeatedDays: 0, bridgedSeatedDays: 0, bandRestrictedDays: 0 },
    onClose: ({ date: d, readings: simple, state }) => {
      const readings: Reading[] = simple.map(({ id }) => {
        const p = seriesById.get(id)![cursor(id, d)]!;
        return { indicator: indicatorById.get(id)!, date: p.date, level: p.value, delta20: p.delta20, rawState: p.rawState, state: p.state };
      });

      // TREATMENT panel — the shipped `band` role (credit+rates restricted). techP reads members only.
      const panel = computeFamilyPanel(simple, DIAL_FAMILIES);
      const techP = techConfirmerBreadth(techConfirmerFromPanel(panel.families));
      const treatDial = computeT1Dial(panel.families, techP);
      // CONTROL — the measured family's band stripped ⇒ `bandOf` falls back to its unrestricted role,
      // while the OTHER split family keeps its shipped restriction. Isolates FAMILY's split alone.
      const controlDial = computeT1Dial(stripBandRole(panel.families, FAMILY), techP);

      const f1 = readings.find((r) => r.indicator.id === "F1")?.level ?? null;
      const vt = readings.find((r) => r.indicator.id === "VT")?.level ?? null;
      stepArm(state.treat, d, treatDial, readings, f1, vt);
      stepArm(state.control, d, controlDial, readings, f1, vt);

      // Report line 3 — the bridge rate off the SERVED band ids (state-dependent) for the measured family.
      const fam = panel.families.find((f) => f.key === FAMILY);
      const bandIds = fam?.band?.ids ?? [];
      if (bandIds.includes(CFG.bridge.bridge)) state.bridgeSeatedDays++;
      if (bandIds.includes(CFG.bridge.bridged)) state.bridgedSeatedDays++;
      const fullRoster = new Set(fam?.members.map((m) => m.id) ?? []);
      if (bandIds.length < fullRoster.size) state.bandRestrictedDays++;

      state.dates.push(d);
      return state;
    },
  });

  // ---------- report ----------
  const { dates, treat, control } = fold;
  const flips = dates.map((_, i) => classifyFlip(treat.bands[i]!, control.bands[i]!));
  const raises = flips.map((f, i) => ({ f, i })).filter((x) => x.f === "raise");
  const lowers = flips.filter((f) => f === "lower").length;

  console.log(`\nreplayed ${dates.length} closes  ${dates[0]} → ${dates.at(-1)}  (≈ ${(dates.length / 252).toFixed(2)} trading-yrs)`);

  console.log(`\n① BAND FLIPS (treatment=main vs control=pre-split, on the pushed notify band):`);
  console.log(`    lowers (expected — the split relaxes a band): ${lowers}`);
  if (raises.length === 0) {
    console.log(`    RAISES: 0  → falsifier holds: no replayed close raised a band. ✅`);
  } else {
    console.log(`    ⛔ RAISES: ${raises.length}  → SHIPPED DEFECT (the flip is on main). Each raise owes a fix commit:`);
    for (const r of raises.slice(0, 20)) {
      console.log(`        ${dates[r.i]}  control ${control.bands[r.i]} → treatment ${treat.bands[r.i]}  (RAISED)`);
    }
    if (raises.length > 20) console.log(`        … and ${raises.length - 20} more`);
  }

  console.log(`\n② R4 ENTER-DAYS (breadth key leadingFiring+coincidentFiring ≥ ${R4_ENTER_FAMILIES}):`);
  console.log(`    before (control / pre-split): ${control.r4EnterDays}`);
  console.log(`    after  (treatment / main):   ${treat.r4EnterDays}   (Δ ${treat.r4EnterDays - control.r4EnterDays}; narrowing ${FAMILY} can only ever REDUCE this)`);

  console.log(`\n③ BRIDGE-SEATED DAYS (${CFG.bridge.bridge} substituted for a stale/absent ${CFG.bridge.bridged} in ${FAMILY}.band.ids):`);
  console.log(`    ${CFG.bridge.bridge} seated: ${fold.bridgeSeatedDays}/${dates.length}  ·  ${CFG.bridge.bridged} seated: ${fold.bridgedSeatedDays}/${dates.length}  ·  ${FAMILY} band restricted below full roster: ${fold.bandRestrictedDays}/${dates.length}`);

  if (outArg) {
    writeFileSync(
      outArg,
      JSON.stringify(
        {
          family: FAMILY,
          env: envArg,
          closes: REPLAY_N,
          window: { from: dates[0], to: dates.at(-1), days: dates.length },
          bandFlips: { lowers, raises: raises.map((r) => ({ date: dates[r.i], control: control.bands[r.i], treatment: treat.bands[r.i] })) },
          r4EnterDays: { before: control.r4EnterDays, after: treat.r4EnterDays },
          bridge: CFG.bridge.bridge,
          bridged: CFG.bridge.bridged,
          bridgeSeatedDays: fold.bridgeSeatedDays,
          bridgedSeatedDays: fold.bridgedSeatedDays,
          bandRestrictedDays: fold.bandRestrictedDays,
        },
        null,
        2,
      ),
    );
    console.log(`\nwrote summary → ${outArg}`);
  }

  if (raises.length > 0) process.exitCode = 1;
}

const isMain = process.argv[1]?.endsWith("probe-band-split.ts") ?? false;
if (isMain) {
  await main();
}
