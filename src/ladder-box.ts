/** Episode-box kernel: member cells → cluster votes → hold / veto / quorum. Pure; per-leg rosters live in each probe
 *  (`CLUSTERS satisfies Roster<Id>`). */

/** `na` = no read (counts against quorum); `none` = before the member's first point (out of the denominator). */
export type Cell = "hit" | false | "na" | "none";
type Kind = "coincident" | "lead";
type Cluster<Id extends string> = { readonly name: string; readonly kind: Kind; readonly members: readonly Id[] };
export type Roster<Id extends string> = readonly Cluster<Id>[];

export const BOX_KERNEL = { VOTE_SHARE: 0.5, QUORUM_SHARE: 0.7 } as const;

/** `members` = the cluster's cells in roster order. */
export type ClusterRead = { name: string; kind: Kind; members: { id: string; cell: Cell }[]; hits: number; live: number; n: number; vote: boolean };
/** `hold` = every tranche held; `holdT2T3` = T2·T3 held (`hold`, or any veto). */
export type Box = { clusters: ClusterRead[]; votes: string[]; hold: boolean; holdT2T3: boolean; veto: string[]; live: number; n: number; quorum: number; t1Only: boolean };
/** A tripped core-driver BLOCK row and how far it holds: `all` = every tranche, `T2T3` = T2·T3 only (`reachOf`, src/ladder-block.ts). */
export type Veto = { readonly name: string; readonly reach: "all" | "T2T3" };

/** Kleene AND for a conjunction member: any `false` → false, else any `na` → na; a `none` leg drops out (all `none` → none). */
export function kleeneAnd(...cells: Cell[]): Cell {
  if (cells.includes(false)) return false;
  if (cells.includes("na")) return "na";
  return cells.every((c) => c === "none") ? "none" : "hit";
}

/** Kleene OR for an either-read member: any `hit` → hit, else any `na` → na; a `none` leg drops out (all `none` → none). */
export function kleeneOr(...cells: Cell[]): Cell {
  if (cells.includes("hit")) return "hit";
  if (cells.includes("na")) return "na";
  return cells.every((c) => c === "none") ? "none" : false;
}

/** Per-leg kernel options. `leadAlone`: a lead vote holds without a coincident one — EU-Fin only (user ruling 2026-10-24, the 2011
 *  sovereign-only scare: credit and vol never confirmed, the leg fell −18.8%); every other leg keeps the cluster-kernel plan's lead ∧ coincident. */
export type BoxOpts = { leadAlone?: boolean };

/** `vetoes` = the tripped core-driver BLOCK rows — each holds its `reach` alone, outside the vote; `veto` keeps their names. */
export function boxOf<Id extends string>(roster: Roster<Id>, cells: Readonly<Record<Id, Cell>>, vetoes: readonly Veto[] = [], opts: BoxOpts = {}): Box {
  const clusters = roster.map(({ name, kind, members }): ClusterRead => {
    const cs = members.map((m) => cells[m]);
    const hits = cs.filter((c) => c === "hit").length;
    const live = cs.filter((c) => c === "hit" || c === false).length;
    const n = cs.filter((c) => c !== "none").length;
    return { name, kind, members: members.map((id, k) => ({ id, cell: cs[k]! })), hits, live, n, vote: hits > live * BOX_KERNEL.VOTE_SHARE };
  });
  const voting = clusters.filter((c) => c.vote);
  const live = clusters.reduce((a, c) => a + c.live, 0);
  const n = clusters.reduce((a, c) => a + c.n, 0);
  const quorum = Math.ceil(BOX_KERNEL.QUORUM_SHARE * n);
  const held = voting.some((c) => c.kind === "lead") && (opts.leadAlone === true || voting.some((c) => c.kind === "coincident"));
  const hold = held || vetoes.some((v) => v.reach === "all");
  return { clusters, votes: voting.map((c) => c.name), hold, holdT2T3: hold || vetoes.length > 0, veto: vetoes.map((v) => v.name), live, n, quorum, t1Only: n === 0 || live < quorum };
}

/** Drawdown watch grades, calmest first; a stored grade may end ` (thin)` (a box below quorum: CALM or ELEVATED only). Display/notify only — never a gate. */
const WATCH_GRADES = ["CALM", "ELEVATED", "HIGH", "SEVERE"] as const;
type WatchGrade = (typeof WATCH_GRADES)[number];
/** The bare grade word off a stored grade (` (thin)` dropped). */
export const watchWord = (grade: string): string => grade.replace(/ \(thin\)$/, "");
type WatchCells<Id extends string> = { key: Id; manual?: true; correction: { cell: Cell }; bear: { cell: Cell } };
/** `boxOf` over the correction and bear cells: bear hold → SEVERE · correction hold → HIGH · a correction vote → ELEVATED · else CALM; either box below quorum
 *  caps it at `ELEVATED (thin)` / `CALM (thin)`. Only measured rows grade: a roster member naming a `manual` row, or no row at all, throws. */
export function watchOf<Id extends string>(roster: Roster<Id>, rows: readonly WatchCells<Id>[]): { grade: string; correction: Box; bear: Box } {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const read = (m: Id) => byKey.get(m) ?? (() => { throw new Error(`watchOf: roster member ${m} has no watch row`); })();
  for (const m of roster.flatMap((c) => c.members)) if (read(m).manual) throw new Error(`watchOf: ${m} is a manual row — never graded`);
  const cells = (side: "correction" | "bear") => Object.fromEntries(roster.flatMap((c) => c.members).map((m) => [m, read(m)[side].cell])) as Record<Id, Cell>;
  const [correction, bear] = [boxOf(roster, cells("correction")), boxOf(roster, cells("bear"))];
  const word: WatchGrade = bear.hold ? "SEVERE" : correction.hold ? "HIGH" : correction.votes.length ? "ELEVATED" : "CALM";
  const thin = correction.t1Only || bear.t1Only;
  return { grade: thin ? `${word === "CALM" ? "CALM" : "ELEVATED"} (thin)` : word, correction, bear };
}
