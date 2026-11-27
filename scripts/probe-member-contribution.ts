/**
 * probe-member-contribution.ts — WHY does each seated member contribute what it does, on ONE leg at
 * ONE close.
 *
 *   npx tsx scripts/probe-member-contribution.ts --env=prod --leg=EU-Fin --asOf=2026-07-31
 *   npm run probe:member-contribution -- --env=prod --leg=EU-Fin --asOf=2026-07-31
 *
 * WHY IT EXISTS. A ruling calls for a root-cause-only
 * investigation: the seven `EU-Fin` cells that arc seated move the 9-leg panel by 0.000 at
 * `asOf=2026-07-31`, and `probe-leg-ordering.ts --arm=diff` aborts on its A/A collapse detector there.
 * Two branches explain that, and they have opposite verdicts:
 *
 *   • CALM (benign, no defect) — the seated members are PRESENT and GREEN. A member enters its cell's
 *     max as `memberWeight × SEV_NUM[state]`; `SEV_NUM.calm = 0`, so a GREEN member adds 0 there.
 *   • ABSENT (a real defect) — the members have no reading at/near the close, so they never enter the
 *     max at all, and the reach the arc seated is dark rather than merely quiet.
 *
 * Nothing in the ordering probe separates those: both print the same zero Δ. This probe does, by
 * printing one row per member with weight > 0 on the leg — reach weight, the confirmed state it is
 * carrying at the close, the severity that state maps to, the product, and a STATUS WORD naming which
 * branch that row is in.
 *
 * STATUS WORDS (the classifier is the whole point — read it before reading the table):
 *   CALM      — a row exists at/before `asOf` (within the shipped forward-fill horizon) and the state
 *               is GREEN ⇒ severity 0 ⇒ contribution 0 BY CONSTRUCTION. Benign.
 *   LIT       — a row exists and its severity is non-zero (AMBER 0.5 / RED 1). The reach is live.
 *   ABSENT    — no row at or before `asOf`, or the newest such row is older than the forward-fill
 *               horizon. The member is excluded from `observedWeightedMax` entirely (OQ-5 Stage 5.2:
 *               an absent member is NOT imputed calm). This is the defect branch.
 *   NULL_WSEV — present, but `MEMBER_RELEVANCE[m]` does not carry the leg, so its severity never
 *               reaches the leg's cell.
 *
 * ⚠ `NULL_WSEV` IS UNREACHABLE BY CONSTRUCTION FOR THE ROWS THIS PROBE PRINTS, and that is stated here
 * rather than hidden: this probe only prints members with `MEMBER_WEIGHT[m][leg] > 0`, `MEMBER_RELEVANCE`
 * is DERIVED from `MEMBER_WEIGHT` (relevance ⇔ weight > 0). The arm
 * is kept as a TRIPWIRE on exactly that invariant — if the derived relevance table ever stops agreeing
 * with the weight table (a second copy of the fact, `docs/reference.md` §[arch] 9. Cross-file design invariants), a seated member
 * would silently route through an insensitive cell and this word would appear. It is not a measurement
 * branch and must not be read as one.
 *
 * THE ENGINE IS IMPORTED, NEVER REIMPLEMENTED. Reach comes from the shipped `memberWeight`, relevance
 * from the shipped `MEMBER_RELEVANCE`; the leg's danger/RAG footer from the shipped
 * `computeFamilyPanel` → `computeT1Dial` → `computeField`, exactly as `probe-leg-ordering.ts` /
 * `probe-absence-field.ts` rebuild it. The ONE re-typed production constant is `STATE_SEV` (`SEV_NUM` ∘
 * `severityOf` is module-private in `danger-member-state.ts`), and a restatement is a CLAIM, so it is checked
 * against the real exported composition `memberScaledBand` rather than asserted in prose — see
 * `assertSevMapMatchesProduction`.
 *
 * ⚠ STRICTLY READ-ONLY: the only store call is `getSeries`, which selects. Nothing here inserts,
 * updates, upserts or deletes — safe against prod, which is what Stage 2.6 requires.
 */
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import { MEMBER_WEIGHT, MEMBER_RELEVANCE, FAMILY_MEMBERS, SIGNALS, type LegKey, type SignalKey } from "../src/danger-ladder.js";
import { computeFamilyPanel, LADDER } from "../src/families.js";
import { DIAL_FAMILIES } from "../src/dial-assembly.js";
import { computeT1Dial, techConfirmerBreadth, techConfirmerFromPanel } from "../src/t1dial.js";
import { FFILL_MAX_CALENDAR_DAYS } from "../src/replay.js";
import {
  computeField,
  legRAG,
  memberScaledBand,
  memberWeight,
  pillarValue,
  scaledSevBand,
  type Sev,
} from "../src/danger-engine.js";
import type { SeriesPoint } from "../src/store.js";
import type { State } from "../src/domain-types.js";
import { argOf, envArg as envArgOf } from "./lib/cli.js";
import { loadSeriesWith, makeCursor, unionCalendar, panelAt, MEMBER_WINDOW } from "./lib/replay-walk.js";

/** Mirrors `dial-assembly.ts`'s private `MEMBER_HISTORY_PAD` (=30), as `probe-leg-ordering.ts` does. */
const MEMBER_HISTORY_PAD = 30;
const FETCH_LIMIT = 20_000;
const MS_PER_CALENDAR_DAY = 86_400_000;


const envArg = envArgOf("local");
if (envArg !== "local" && envArg !== "prod") {
  console.log(`ABORT: --env must be local|prod (got ${argOf("env")}).`);
  process.exit(1);
}
const legArg = argOf("leg");
if (legArg === undefined || !(LADDER as readonly string[]).includes(legArg)) {
  console.log(`ABORT: --leg=<LegKey> is required and must be one of: ${LADDER.join(", ")} (got ${legArg}).`);
  process.exit(1);
}
const leg = legArg as LegKey;
const asOfArg = argOf("asOf");
if (asOfArg === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(asOfArg)) {
  console.log(`ABORT: --asOf=YYYY-MM-DD is required (got ${asOfArg}). A default-resolved close would make
    two runs incomparable — Stage 2.6 asks about ONE named close.`);
  process.exit(1);
}
const asOf = asOfArg;

/** `severityOf` ∘ `SEV_NUM` (`danger-member-state.ts`; `severityOf` is module-private there): RED→lit→1, AMBER→elev→0.5,
 *  anything else→calm→0. Re-typed, then CHECKED by `assertSevMapMatchesProduction` below. */
const STATE_SEV: Record<string, number> = { RED: 1, AMBER: 0.5, GREEN: 0 };

/**
 * THE RESTATEMENT GUARD. `memberScaledBand(m, state, [leg])` IS
 * `scaledSevBand(memberWeight(m, leg) · SEV_NUM[severityOf(state)])`, so driving it over every member
 * this probe prints × the leg under test × all three states pins `STATE_SEV` against production exactly
 * where this probe uses it. Without it, a `SEV_NUM` move would leave every severity/contribution number
 * below silently wrong while the table still printed.
 *
 * CAN FIRE: setting `STATE_SEV.AMBER` to `0.8` throws for any member whose reach × 0.8 bands differently
 * from reach × 0.5. It is a BAND pin, not a full value pin (a band is an interval, so a drift small
 * enough to stay inside one band can hide) — which is why the message says "drift".
 */
function assertSevMapMatchesProduction(members: readonly string[]): void {
  for (const m of members) {
    for (const state of ["RED", "AMBER", "GREEN"] as const) {
      const mine = scaledSevBand((memberWeight(m, leg) * STATE_SEV[state]!) as Sev);
      const prod = memberScaledBand(m, state, [leg]);
      if (mine !== prod) {
        throw new Error(
          `[probe-member-contribution] STATE_SEV drift: ${m} × ${leg} @ ${state} — this probe bands ` +
            `${(memberWeight(m, leg) * STATE_SEV[state]!).toFixed(4)} as ${mine}, production's ` +
            `memberScaledBand says ${prod}. The re-typed SEV_NUM literals no longer match ` +
            `danger-engine.ts; fix STATE_SEV before reading any number below.`,
        );
      }
    }
  }
}

/** Every member with non-zero reach on the leg, in family order — the population Stage 2.6 asks about. */
const familyOf = new Map<string, SignalKey>();
for (const f of SIGNALS) for (const m of FAMILY_MEMBERS[f]) if (!familyOf.has(m)) familyOf.set(m, f);
const weighted = Object.keys(MEMBER_WEIGHT).filter((m) => memberWeight(m, leg) > 0);
/** A `MEMBER_WEIGHT` row outside every `FAMILY_MEMBERS` list is never scored on the danger path — the
 *  display-only SLOW ids `DIAL_FAMILIES` strips, or a dead row like `DB_SMH` (`danger-ladder.ts`). Listed
 *  in the footer, never given a family-less table row (that was the `--leg=Semis` crash). */
const unfamilied = weighted.filter((m) => !familyOf.has(m)).sort();
const seated = weighted
  .filter((m) => familyOf.has(m))
  .sort((a, b) => familyOf.get(a)!.localeCompare(familyOf.get(b)!) || a.localeCompare(b));
if (seated.length === 0) {
  console.log(
    `ABORT: no FAMILY member has MEMBER_WEIGHT > 0 on ${leg} (${unfamilied.length} unfamilied) — there is nothing to attribute.`,
  );
  process.exit(1);
}
assertSevMapMatchesProduction(seated);

let store;
try {
  store = await resolveStore(envArg, "ro", liveResolveDeps);
} catch (e: unknown) {
  console.log(`ABORT: no ${envArg} store reachable — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

// ---------- data pull (READ-ONLY: getSeries selects only) ----------
// The full dial member set, not just the seated ones: the footer's leg danger/RAG is the SHIPPED
// `computeField` number, which needs the whole panel.
const memberIds = [...new Set(DIAL_FAMILIES.flatMap((f) => f.ids))];
// `loadSeriesWith` carries the fail-loud ABORT this block used to spell out: a member that silently
// resolves to [] reads ABSENT at every date, which is precisely the verdict under test — a partial
// panel cannot answer calm-vs-absent.
const seriesById = await loadSeriesWith((id) => store.getSeries(id, FETCH_LIMIT), memberIds);

const axis = unionCalendar(seriesById, memberIds);
if (axis.length === 0) {
  console.log("ABORT: the store returned zero closes for every dial member — nothing to attribute.");
  process.exit(1);
}
if (asOf < axis[0]!) {
  console.log(`ABORT: --asOf=${asOf} precedes the store's first close ${axis[0]}.`);
  process.exit(1);
}
// The SYMMETRIC guard. Without it, an asOf past the store's last close puts every member beyond the
// forward-fill horizon, every row reads ABSENT, and the footer confidently prints the "the reach is DARK,
// not quiet. Defect branch." verdict — the exact discrimination this probe exists to make, fabricated out
// of a date that simply has not happened yet.
if (asOf > axis[axis.length - 1]!) {
  console.log(
    `ABORT: --asOf=${asOf} is past the store's last close ${axis[axis.length - 1]}. Every seated member ` +
      `would read ABSENT purely because that close does not exist, and the footer would report the ` +
      `DARK-reach defect branch off it. Pass an asOf within ${axis[0]} .. ${axis[axis.length - 1]}.`,
  );
  process.exit(1);
}

// SEAM (Stage 3.B-2): `walkReplay`'s fold does NOT apply here — this probe has no calendar walk; it
// evaluates ONE anchor. The panel ASSEMBLY is shared via `panelAt`; `nearestBefore` is NOT, and stays
// here: the attribution table needs a nearest-before pick for every SEATED member, including the ones
// the forward-fill horizon excludes (an ABSENT row still prints its date/ageDays/state). That is
// attribution over a measurement-bearing roster, not panel assembly.
/** One cursor shared by `nearestBefore` and `panelAt`. Safe: both resolve the SAME fixed `asOf`, so the
 *  monotonic per-id pointers never have to move backwards, whatever the call order. */
const cursor = makeCursor(seriesById);

/** Newest point at/before `asOf` for `id`, with its index — the same "nearest-before" pick the panel
 *  rebuild uses. `null` when the member has no row at or before the close at all. */
function nearestBefore(id: string): { pt: SeriesPoint; i: number } | null {
  const i = cursor(id, asOf);
  return i < 0 ? null : { pt: seriesById.get(id)![i]!, i };
}

/** Members present at `asOf` under the shipped forward-fill horizon, with their member-history slice —
 *  the same `lib/replay-walk.ts` `panelAt` `probe-leg-ordering.ts` calls, so the footer is the same
 *  number that probe reads. */
const { readings, cissHistory } = panelAt(seriesById, memberIds, asOf, {
  historyLen: MEMBER_WINDOW + MEMBER_HISTORY_PAD,
  cursor,
});
if (readings.length === 0) {
  console.log(`ABORT: no dial member is observed at ${asOf} under the forward-fill horizon.`);
  process.exit(1);
}
const inPanel = new Set(readings.map((r) => r.id));

// ---------- per-member attribution ----------
type Status = "CALM" | "LIT" | "ABSENT" | "NULL_WSEV";
interface Row {
  id: string;
  family: SignalKey;
  weight: number;
  date: string | null;
  ageDays: number | null;
  state: State | null;
  sev: number | null;
  contribution: number | null;
  status: Status;
  note: string;
}

const rows: Row[] = seated.map((id) => {
  const family = familyOf.get(id)!;
  const weight = memberWeight(id, leg);
  const near = nearestBefore(id);
  const ageDays =
    near === null ? null : Math.floor((Date.parse(asOf) - Date.parse(near.pt.date)) / MS_PER_CALENDAR_DAY);
  const base = { id, family, weight, date: near?.pt.date ?? null, ageDays };
  if (near === null)
    return { ...base, state: null, sev: null, contribution: null, status: "ABSENT" as const, note: "no row at or before asOf" };
  if (!inPanel.has(id))
    return {
      ...base,
      state: near.pt.state,
      sev: null,
      contribution: null,
      status: "ABSENT" as const,
      note: `newest row is ${ageDays}d old > ffill horizon ${FFILL_MAX_CALENDAR_DAYS}d`,
    };
  if (!MEMBER_RELEVANCE[id]?.has(leg))
    return {
      ...base,
      state: near.pt.state,
      sev: null,
      contribution: null,
      status: "NULL_WSEV" as const,
      note: `MEMBER_RELEVANCE.${id} lacks ${leg} — relevance/weight tables disagree`,
    };
  const sev = STATE_SEV[near.pt.state]!;
  return {
    ...base,
    state: near.pt.state,
    sev,
    contribution: weight * sev,
    status: sev === 0 ? ("CALM" as const) : ("LIT" as const),
    note: sev === 0 ? "present + GREEN ⇒ contributes 0 by construction" : "reach is live at this close",
  };
});

// ---------- the leg's shipped danger, for context ----------
const panel = computeFamilyPanel(readings, DIAL_FAMILIES);
const dial = computeT1Dial(panel.families, techConfirmerBreadth(techConfirmerFromPanel(panel.families)));
const field = computeField({ globalFamilies: panel.families }, dial.band, undefined, null, cissHistory);
const legRow = field.legRows.find((r) => r.sleeve === leg);

const f3 = (n: number | null) => (n === null ? "   na" : n.toFixed(3).padStart(5));
console.log(
  `\n[probe-member-contribution] per-member contribution on ${leg} — store=${envArg}, asOf=${asOf}\n` +
    `  DATA PATH: ${axis.length} closes ${axis[0]} .. ${axis[axis.length - 1]}, ` +
    `${readings.length}/${memberIds.length} dial members observed at asOf, ffill horizon ${FFILL_MAX_CALENDAR_DAYS}d\n` +
    `  LEG (shipped computeField): danger=${legRow ? legRow.danger.toFixed(3) : "na"} ` +
    `RAG=${legRow ? legRAG(legRow.cells) : "na"} ` +
    `EW=${f3(legRow ? pillarValue(legRow.subDangers.earlyWarn) : null).trim()} ` +
    `SN=${f3(legRow ? pillarValue(legRow.subDangers.stressNow) : null).trim()}\n`,
);
console.log("  member   | fam | weight |   asOf row | age | state | sev   | contrib | status    | why");
for (const r of rows) {
  console.log(
    `  ${r.id.padEnd(8)} | ${r.family.padEnd(3)} | ${r.weight.toFixed(3).padStart(6)} | ` +
      `${(r.date ?? "(none)").padStart(10)} | ${String(r.ageDays ?? "-").padStart(3)} | ` +
      `${(r.state ?? "-").padEnd(5)} | ${f3(r.sev)} | ${f3(r.contribution)}   | ` +
      `${r.status.padEnd(9)} | ${r.note}`,
  );
}

const count = (s: Status) => rows.filter((r) => r.status === s).length;
const live = rows.filter((r) => r.status === "LIT");
console.log(
  `\n  FOOTER — family members with weight>0 on ${leg}: ${rows.length}\n` +
    `    CALM ${count("CALM")} · LIT ${count("LIT")} · ABSENT ${count("ABSENT")} · NULL_WSEV ${count("NULL_WSEV")}\n` +
    `    weight>0 but in NO family (never scored, not in the table): ${
      unfamilied.length === 0 ? "none" : unfamilied.join(", ")
    }\n` +
    `    max contribution: ${
      live.length === 0
        ? "0.000 (every member with reach here contributes the max's identity element)"
        : (() => {
            const top = Math.max(...live.map((r) => r.contribution!));
            const who = live.filter((r) => r.contribution === top).map((r) => r.id);
            return `${top.toFixed(3)} (argmax: ${who.join(", ")})`;
          })()
    }\n` +
    `    VERDICT: ${
      count("ABSENT") > 0
        ? `${count("ABSENT")} seated member(s) are ABSENT — the reach is DARK, not quiet. Defect branch.`
        : count("NULL_WSEV") > 0
          ? `${count("NULL_WSEV")} seated member(s) hit NULL_WSEV — the relevance/weight tables disagree.`
          : count("LIT") === 0
            ? `every seated member is PRESENT and CALM — the reach contributes 0 by construction, and any ` +
              `before/after over these MEMBER_WEIGHT cells MUST agree at this close. Benign branch. ` +
              `(NOT a FAMILY_LEG_WEIGHT claim: family weight enters the share as a normalized mass — see ` +
              `probe-leg-ordering.ts's docblock.)`
            : `${count("LIT")} seated member(s) are LIT — ${live.map((r) => r.id).join(", ")}. Every OTHER ` +
              `seated member on this leg is present and calm, contributing 0 by construction; a ` +
              `before/after over a MEMBER_WEIGHT cell of a CALM member still MUST agree at this close ` +
              `(a FAMILY_LEG_WEIGHT change is NOT covered — it re-masses the share).`
    }`,
);
