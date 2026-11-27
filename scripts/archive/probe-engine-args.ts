/**
 * probe-engine-args.ts — the `--engine=legacy|share --kappa=<n> --cuts=<amber>,<red>` triple shared by
 * `probe-leg-ordering.ts` and `probe-danger-cut-percentile.ts`. Pure: argv in, `ShareProbeEngine` out.
 */
import type { ShareCuts, ShareProbeEngine } from "../../src/danger-share.js";
import { argOf } from "./cli.js";

export type ProbeEngineArgs = { ok: true; engine: ShareProbeEngine | undefined } | { ok: false; error: string };

/** Absent / `legacy` ⇒ `engine: undefined`; `--kappa`/`--cuts` are share-only and rejected otherwise. */
export function parseProbeEngine(argv: readonly string[] = process.argv): ProbeEngineArgs {
  const kind = argOf("engine", argv) ?? "legacy";
  const kappaRaw = argOf("kappa", argv);
  const cutsRaw = argOf("cuts", argv);
  if (kind !== "legacy" && kind !== "share") return { ok: false, error: `--engine must be legacy|share (got ${kind}).` };
  if (kind === "legacy") {
    if (kappaRaw !== undefined || cutsRaw !== undefined)
      return { ok: false, error: "--kappa / --cuts are only valid with --engine=share." };
    return { ok: true, engine: undefined };
  }
  if (kappaRaw === undefined) return { ok: false, error: "--engine=share requires --kappa=<n>." };
  const kappa = Number(kappaRaw);
  if (kappaRaw.trim() === "" || !Number.isFinite(kappa) || kappa < 0)
    return { ok: false, error: `--kappa must be a finite number >= 0 (got ${kappaRaw}).` };
  if (cutsRaw === undefined) return { ok: true, engine: { kind: "share", kappa } };
  const parts = cutsRaw.split(",");
  const [amber, red] = parts.map((p) => (p.trim() === "" ? NaN : Number(p)));
  if (parts.length !== 2 || !Number.isFinite(amber) || !Number.isFinite(red) || !(0 < amber! && amber! < red! && red! <= 1))
    return { ok: false, error: `--cuts must be <amber>,<red> with 0 < amber < red <= 1 (got ${cutsRaw}).` };
  const cuts: ShareCuts = { amber: amber!, red: red! };
  return { ok: true, engine: { kind: "share", kappa, cuts } };
}

/** One-line label for a probe banner: `legacy` or `share κ=<k> cuts=<a>,<r>`. */
export function engineLabel(engine: ShareProbeEngine | undefined, defaults: ShareCuts): string {
  if (engine === undefined) return "legacy";
  const c = engine.cuts ?? defaults;
  return `share κ=${engine.kappa} cuts=${c.amber},${c.red}${engine.cuts === undefined ? " (DANGER_CUTS)" : ""}`;
}
