/** The semis leg's `[dash]` series table + the row helpers its probe and drawdown watch (`semis-watch.ts`) both read — a leaf, so neither imports the other's values. */
import { makeTagOf, type LadderSign } from "../src/ladder-live.js";
import { isRead } from "./ladder-tranche.js";
import { eachSeries, knob } from "./ladder-replay.js";
import type { Pt } from "./probe-eufin-tranches.js";

/** Every `[dash]` input — each must be a served `/api/series` id (`META`); anything else is a `[manual]` sign row. */
export const SERIES = ["LEGP_SEMIS", "F8", "RS_SMH", "MU_RS", "HCX", "F1", "R4", "VT", "F17", "R6", "T10Y3M_RAW", "CG", "VXSMH", "BBB"] as const;
export type Id = (typeof SERIES)[number];
export type SeriesSet = Record<Id, Pt[]>;
/** Series id → the leg's ONE canonical name (`ReadTag.indicator`, `src/ladder-live.ts`); `tagOf` derives it for a single-series row — a multi-series row names it by hand. */
export const INDICATOR: Record<Id, string> = { LEGP_SEMIS: "SEC0", F8: "MU", RS_SMH: "RS_SMH", MU_RS: "MU/SMH", HCX: "HCX", F1: "HY OAS", R4: "10y RY", VT: "VT", F17: "USD/JPY", R6: "MOVE", T10Y3M_RAW: "10y−3m", CG: "Cu/Au", VXSMH: "VXSMH", BBB: "BBB OAS" };
/** A row's read tag, written at its call site: `job`/`agg`/`series` chosen there, `indicator` named only on multi-series / `composite` rows. */
export const tagOf = makeTagOf(INDICATOR);
/** The vote's float tolerance on a `≥` cut — `probe-dfii10.ts` reads its line verdict with it. */
export const EPS = 1e-9;
/** `MA(n)` rule text, `k×MA(n)` off 1. */
export const kMa = (m: number, n: number): string => (m === 1 ? `MA${n}` : `${knob(m)}×MA${n}`);
/** Whether a read `dram_contract` row blocks; null = no read row. */
export const contractBlocks = (signs: readonly LadderSign[]): boolean | null => ((rows) => (rows.length ? rows.some((g) => g.block) : null))(signs.filter((g) => g.sign === "dram_contract" && isRead(g)));
/** `f` over every `SERIES` id of `s`. */
export const eachId = (s: SeriesSet, f: (c: Pt[]) => Pt[]): SeriesSet => eachSeries(SERIES, s, f);
