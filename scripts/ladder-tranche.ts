/** Shared tranche-tally kernel for the ladder probes — pure, no IO; each leg binds its
 *  rules/roster/box through thin wrappers in its `probe-<leg>-tranches.ts`, per-leg facts stay in the leg's `NeedKnobs`. */
import type { Cell } from "../src/ladder-box.js";
import type { LadderLive, LadderSign, LadderVerdict, TrancheId as Tranche, Via, WatchRow } from "../src/ladder-live.js";
import { episodes, type Pt } from "./ladder-replay.js";

const EPS = 1e-9;
const TRANCHES = ["T1", "T2", "T3"] as const;

export type Verdict = "met" | "unmet" | "na";
export const tick = (ok: boolean): Verdict => (ok ? "met" : "unmet");
/** One cut of a row that reads several: `≤13.0✓`. */
export const cmp = (op: string, cut: string, ok: boolean): string => `${op}${cut}${ok ? "✓" : "✗"}`;
/** A watch side's cell: `none` with no history, `na` short of it, else hit/false. */
export const sideCell = (c: Pt[], ready: boolean, ok: () => boolean): Cell => (!c.length ? "none" : !ready ? "na" : ok() ? "hit" : false);
/** A watch side with no line (the row grades one side only). */
export const NO_LINE: WatchRow["correction"] = { rule: "—", cell: "none" };
export const shortOf = (n: number): string => `short of ${n} closes`;
/** A row is read once researched (`checked`) or blocked — an `escalation:` event sets `block` alone (`applyRun`). */
export const isRead = (g: LadderSign): boolean => g.checked !== null || g.block;
/** Each box member's cell off its read. */
export const cellsOf = <M extends string, C>(reads: Record<M, { cell: C }>): Record<M, C> => Object.fromEntries(Object.entries<{ cell: C }>(reads).map(([id, m]) => [id, m.cell])) as Record<M, C>;
/** One leg's read; `absorbed` = a rung its family's fill already covers (semis), so the need drops a family. */
export type Reading = { value: string; verdict: Verdict; count?: { got: number; need: number }; absorbed?: true };
export type TrancheResult = { tranche: Tranche; metCount: number; total: number; need: number; gates: Verdict[]; ready: boolean; clear: boolean; met: boolean; via?: Via; filled: boolean; since: string | null; fill?: true };
export type RawLeg = Reading & { key: string; tranche: Tranche; gate: boolean };
/** The roster row shape `legsAt` reads — every leg's `LegDef` is one. */
export type LegRow<R, X> = { key: string; tranche: Tranche; gate?: boolean; read: (r: R, x: X) => Reading };
/** The box fields `boxHolds` reads — every leg's `Escalation` is one; `holdT2T3` absent on a legacy stored verdict. */
export type BoxHold = { hold: boolean; holdT2T3?: boolean; quorum: { t1Only: boolean } };
/** The family-share knobs `famNeed` reads (a leg's rules, or value's arm constants). */
export type Shares = { FAM_T2_SHARE: number; FAM_T3_SHARE: number };
/** A leg's need policy: `famNeed` over `families` (uncapped when undefined), less one family on an `absorbed` rung when `absorbedDrops`;
 *  floored at `max(1, readable − slack)` when `slack` is set. */
export type NeedKnobs = { shares: Shares; families?: number; slack?: number; absorbedDrops?: boolean };

/** Whether the box holds `t`: `boxOf`'s hold, or on T2/T3 its `holdT2T3` (a T2·T3 veto) or below quorum. */
export const boxHolds = (t: Tranche, e: BoxHold): boolean => e.hold || (t !== "T1" && (e.holdT2T3 === true || e.quorum.t1Only));
/** Need per tranche over N families: 1 / ⌈FAM_T2_SHARE·N⌉ / ⌈FAM_T3_SHARE·N⌉. */
export const famNeedOf = (t: Tranche, n: number, s: Shares): number => (t === "T1" ? 1 : Math.ceil((t === "T2" ? s.FAM_T2_SHARE : s.FAM_T3_SHARE) * n - EPS));
/** One tranche's own legs only: ready = every gate met, the box (when read) not holding `t`, and the `NeedKnobs` need of its readable criteria met. */
export function tallyOf(t: Tranche, legs: readonly RawLeg[], esc: BoxHold | null, k: NeedKnobs): TrancheResult {
  const mine = legs.filter((l) => l.tranche === t);
  const gates = mine.filter((l) => l.gate);
  const rest = mine.filter((l) => !l.gate && l.verdict !== "na");
  const metCount = rest.filter((l) => l.verdict === "met").length;
  const fam = k.families === undefined ? Infinity : famNeedOf(t, k.families - (k.absorbedDrops && mine.some((l) => l.absorbed) ? 1 : 0), k.shares);
  const need = Math.min(fam, k.slack === undefined ? Infinity : Math.max(1, rest.length - k.slack));
  const clear = gates.every((l) => l.verdict === "met") && !(esc && boxHolds(t, esc));
  const ready = clear && metCount >= need;
  return { tranche: t, metCount, total: rest.length, need, gates: gates.map((l) => l.verdict), ready, clear, met: ready, filled: ready, since: null };
}
export type FamRung<S, Rule, Read, Tag> = { src?: S; leg?: string; tag: Tag; rule: Rule; foot?: Rule; read: Read };
/** A family's rungs as roster rows: rung k is tranche T(k+1), keyed `t<k+1>-<name>`; a rung's own `leg`/`src` beat the family's. */
export const famRows = <S, Rule, Read, Tag>(name: string, leg: string, src: S, rungs: readonly FamRung<S, Rule, Read, Tag>[]) =>
  rungs.map((g, k) => ({ key: `t${k + 1}-${name}`, tranche: TRANCHES[k]!, leg: g.leg ?? leg, src: g.src ?? src, tag: g.tag, rule: g.rule, ...(g.foot && { foot: g.foot }), read: g.read }));
/** Every roster row read at `x`, flattened to its tally row. */
export const legsOf = <R, X>(x: X, r: R, defs: readonly LegRow<R, X>[]): RawLeg[] => defs.map((d) => ({ key: d.key, tranche: d.tranche, gate: d.gate ?? false, ...d.read(r, x) }));
/** All three tranches' tallies over one leg read + box. */
export const tranchesOf = (legs: readonly RawLeg[], esc: BoxHold | null, k: NeedKnobs): TrancheResult[] => TRANCHES.map((t) => tallyOf(t, legs, esc, k));
/** A ready tranche's `since`: the oldest close of the newest unbroken run in `px` on which `readyAt` holds; null when the newest fails. */
export function sinceOf(px: readonly { date: string }[], readyAt: (d: string) => boolean): string | null {
  let since: string | null = null;
  for (let i = px.length - 1; i >= 0 && readyAt(px[i]!.date); i--) since = px[i]!.date;
  return since;
}

/** The ids `read` touches, recorded off a dry run over empty series; `blank` = the leg's empty non-series inputs. */
export const readIdsOf = <K extends string, X extends { s: unknown }>(read: (x: X) => unknown, blank: Omit<X, "s">): K[] => {
  const seen = new Set<K>();
  read({ s: new Proxy({}, { get: (_t, k) => (typeof k === "string" && seen.add(k as K), []) }), ...blank } as X);
  return [...seen];
};
/** The verdict's `prov.` flag: a provisional head on an id in `ids`. */
export const provisionalOn = (ids: ReadonlySet<string>, s: Partial<Record<string, readonly { provisional?: boolean | null }[]>>): boolean => [...ids].some((id) => s[id]?.at(-1)?.provisional === true);
/** `--into=`'s write: the live state with `verdict` replaced, every other field as read. */
export const intoLive = (live: LadderLive, verdict: LadderVerdict): LadderLive => ({ ...live, verdict });

/** The box fields the run's box line reads — eufin's, value's and semis' `Escalation` are one. */
export type BoxVotes = { hits: readonly string[]; veto: readonly string[]; quorum: { live: number; n: number; need: number } };
/** The box in one cell: voting clusters · veto rows · live/n vs quorum. */
export const votesText = (e: BoxVotes): string => `votes ${e.hits.join(", ") || "—"}${e.veto.length ? ` · veto ${e.veto.join(", ")}` : ""} · live ${e.quorum.live}/${e.quorum.n} need ${e.quorum.need}`;
/** The box's hold, as the run's box line words it. */
export const boxStatus = (e: BoxHold): string => (e.hold ? "holds every tranche" : e.holdT2T3 ? "holds T2·T3" : e.quorum.t1Only ? "below quorum — T1 only" : "no hold");
/** The box with its hold lifted (no hold, quorum met) — the "would fire" counterfactual a binding close reads. */
export const clearedBox = <E extends BoxHold>(e: E): E => ({ ...e, hold: false, holdT2T3: false, quorum: { ...e.quorum, t1Only: false } });
/** The fizzle fast fill: a fizzled T2 deciding event fires T2 on T1's fill close `d` when T2 is clear (`t2Clear`, read only then). Sets `out[1]`, returns `out`. */
export function fizzleFill(out: boolean[], fills: readonly (string | null)[], d: string, fizzled: boolean, t2Clear: () => boolean): boolean[] {
  if (fizzled && (fills[0] ?? (out[0] ? d : null)) === d && t2Clear()) out[1] = true;
  return out;
}

/** The open `episodes` exit over a leg's closes (no episode end yet); undefined = none open. */
export const openExitOf = (px: Pt[]): string | undefined => ((e) => (e?.open ? e.exit : undefined))(episodes(px).at(-1));
export type Follow = { exit: string; fills: (string | null)[]; n: number };
/** A follow's starting fills: a `latched` date (the stored verdict's `filledSince`) on/after `exit` stays as-is, so today's signs cannot un-fill it; one older drops. */
export const latchedFills = (exit: string, latched: readonly (string | null)[] = []): (string | null)[] => [0, 1, 2].map((k): string | null => ((d) => (d && d >= exit ? d : null))(latched[k] ?? null));
/** The follow walk: each tranche's first close in `after` on which `fire` fires it, from `latchedFills`, stopping once all three are filled; `n` = closes after the exit.
 *  `fire` sees the fills as they stand before that close. */
export function walkFollow(exit: string, after: readonly { date: string }[], latched: readonly (string | null)[], fire: (d: string, fills: readonly (string | null)[]) => readonly boolean[]): Follow {
  const fills = latchedFills(exit, latched);
  for (const p of after) {
    if (fills.every((d) => d !== null)) break;
    fire(p.date, fills).forEach((f, i) => f && (fills[i] ??= p.date));
  }
  return { exit, fills, n: after.length };
}
/** The live tranche rows: `met` = the follow's `fired` at the newest close `d` (else the tally's own ready); a tranche met by the follow alone, not its own count, names `via(k, t)`,
 *  and a filled one carries its fill as `since` (`fill`), met or not, so the stored verdict keeps the latch the next follow reads. */
export const followedOf = (ts: readonly TrancheResult[], fired: readonly boolean[] | null, fills: readonly (string | null)[] | undefined, d: string | undefined, via: (k: number, t: TrancheResult) => Via): TrancheResult[] =>
  ts.map((t, k) => {
    const met = fired?.[k] ?? t.ready;
    const fill = fills?.[k] ?? (met && !t.ready ? (d ?? null) : null);
    return { ...t, met, filled: met, ...(met && !t.ready && { via: via(k, t) }), ...(fill !== null && { since: fill, fill: true as const }) };
  });
