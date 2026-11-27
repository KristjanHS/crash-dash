/**
 * Duplicate-read report over the four re-entry ladders: per leg, the groups of
 * static reads sharing `indicator` + `job` + `agg` (`duplicateReads`, src/ladder-live.ts) and the untagged count. The default mode
 * reports only; `--strict` (in `npm run check` / `check:cov`, `make ship` and CI) exits 1 on a group not in `ACCEPTED`, a stale
 * `ACCEPTED` entry, or an untagged read — `ACCEPTED` is the single owner of the pinned clone groups.
 * Usage: `npm run -s lint:ladder-reads [-- --strict]`.
 */
import { pathToFileURL } from "node:url";
import { duplicateReads, type ReadGroup, type TaggedRead } from "../src/ladder-live.js";
import { FAST_TAGGED_READS as EUFIN_FAST, TAGGED_READS as EUFIN } from "./probe-eufin-tranches.js";
import { TAGGED_READS as SEMIS } from "./probe-semis-tranches.js";
import { TAGGED_READS as SP500 } from "./probe-sp500-tranches.js";
import { TAGGED_READS as SPIT } from "./probe-spit-tranches.js";
import { TAGGED_READS as VALUE } from "./probe-value-tranches.js";

/** Each leg's static reads — tranche rows + escalation-box families (`TAGGED_READS` per probe); EU-Fin twice: the strict roster and the fast one its live `regime: fast` verdict reads. */
export const LEG_READS: Record<"eufin" | "eufin-fast" | "value" | "semis" | "spit" | "sp500", readonly TaggedRead[]> = { eufin: EUFIN, "eufin-fast": EUFIN_FAST, value: VALUE, semis: SEMIS, spit: SPIT, sp500: SP500 };

export type LegReport = { leg: string; groups: ReadGroup[]; untagged: string[] };
export const report = (reads: Record<string, readonly TaggedRead[]> = LEG_READS): LegReport[] =>
  Object.entries(reads).map(([leg, rows]) => ({ leg, groups: duplicateReads(rows), untagged: rows.filter((r) => !r.tag).map((r) => r.key) }));

export const format = (reports: LegReport[]): string[] => [
  reports.map((r) => `${r.leg} ${r.groups.length} clone group${r.groups.length === 1 ? "" : "s"}${r.untagged.length ? ` · ${r.untagged.length} untagged` : ""}`).join("   "),
  ...reports.flatMap((r) => r.groups.map((g) => `${r.leg.padEnd(10)} ${g.indicator.padEnd(14)} ${`${g.job}/${g.agg}`.padEnd(16)} ${g.keys.join(" ")}`)),
];

const groupId = (leg: string, g: ReadGroup): string => `${leg} · ${g.indicator} · ${g.job}/${g.agg} · ${g.keys.join(" ")}`;
/** The clone groups accepted at the ladder-reads closeout — a new or grown group is a new duplicate read: share its form or add it here. */
export const ACCEPTED: readonly string[] = [
  "eufin · AT1 · relative/allOf · t2-at1-guard t3-at1-guard",
  "eufin · escalation box · composite/allOf · t1-esc t2-esc t3-esc",
  "eufin · EXSH · regime/kOfN · t1-exsh-ma20 t2-price",
  "eufin-fast · AT1 · relative/allOf · t2-at1-guard t3-at1-guard",
  "eufin-fast · escalation box · composite/allOf · t1-esc t2-esc t3-esc",
  "eufin-fast · EXSH · recovery/kOfN · t1-price t2-vol t2-price t3-vol",
  "value · 10y · speed/kOfN · t2-rates t3-rates",
  "value · escalation box · composite/allOf · t1-esc t2-esc t3-esc",
  "value · HCX · level/allOf · t2-hcx-gate t3-hcx-gate",
  "value · HY OAS · recovery/allOf · t1-credit t2-credit t3-credit",
  "value · HY OAS · relative/allOf · t1-hy-guard t2-hy-guard t3-hy-guard",
  "value · MU_RS · relative/allOf · t2-mu-rs-guard t3-mu-rs-guard",
  "value · XDEV · recovery/kOfN · t1-price t2-price t2-vol",
  "value · XDEV · MU · speed/allOf · t1-veto t2-veto t3-veto",
  "semis · BBB OAS · recovery/allOf · t2-credit-bbb t3-credit-bbb",
  "semis · 10y RY · composite/kOfN · t2-rates t3-rates",
  "semis · escalation box · composite/allOf · t1-esc t2-esc t3-esc",
  "semis · HCX · level/allOf · t2-capex-rollover t3-capex-rollover",
  "semis · HY OAS · recovery/allOf · t1-credit t2-credit t3-credit",
  "semis · MU/SMH · regime/kOfN · t2-memory t3-memory",
  "semis · SEC0 · regime/kOfN · t1-price t3-price",
  "spit · escalation box · composite/allOf · t1-esc t2-esc t3-esc",
  "spit · HY OAS · recovery/allOf · t1-credit t2-credit t3-credit",
  "spit · QDVE · composite/allOf · t1-g1 t2-g1 t3-g1",
  "spit · QDVE · speed/allOf · t1-veto t2-veto t3-veto",
  "spit · VIX/VIX3M · QDVE · composite/kOfN · t2-vol t3-vol",
  "sp500 · 10y RY · HY OAS · speed/allOf · t1-c2 t2-c2 t3-c2",
  "sp500 · escalation box · composite/allOf · t1-esc t2-esc t3-esc",
  "sp500 · Global breadth · composite/kOfN · t1-breadth t2-breadth",
  "sp500 · HY OAS · recovery/allOf · t1-credit t1-c1 t2-c1 t3-credit t3-c1",
  "sp500 · MOVE · level/allOf · t2-c4 t3-c4",
  "sp500 · NFCI Risk · level/allOf · t1-c3 t2-c3 t3-c3",
  "sp500 · SXR8 · regime/allOf · t1-g2 t2-g2 t3-g2",
  "sp500 · SXR8 · speed/allOf · t1-veto t2-veto t3-veto",
  "sp500 · VIX/VIX3M · SXR8 · composite/kOfN · t2-vol t3-vol",
];
/** Every strict-mode violation: an unpinned group, a stale `ACCEPTED` entry, an untagged read. */
export function violations(reports: LegReport[]): string[] {
  const ids = reports.flatMap((r) => r.groups.map((g) => groupId(r.leg, g)));
  return [
    ...ids.filter((id) => !ACCEPTED.includes(id)).map((id) => `unpinned: ${id}`),
    ...ACCEPTED.filter((id) => !ids.includes(id)).map((id) => `stale: ${id}`),
    ...reports.flatMap((r) => r.untagged.map((k) => `untagged: ${r.leg} ${k}`)),
  ];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const reports = report();
  for (const line of format(reports)) console.log(line);
  const bad = process.argv.includes("--strict") ? violations(reports) : [];
  if (bad.length) {
    for (const b of bad) console.error(`[ladder-reads] ✖ ${b}`);
    process.exit(1);
  }
}
