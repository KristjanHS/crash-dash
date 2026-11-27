import { ALL_INDICATORS } from "./registry.js";
import { assessDrift, readFixture } from "../scripts/backtest/drift-guard.js";
import type { Indicator } from "./domain-types.js";

/** The registry entry for `id`, non-null — the lookup every suite here repeats. */
export const indById = (id: string): Indicator => ALL_INDICATORS.find((i) => i.id === id)!;

/** Lazy drift assessment over a guard CSV: memo so `-t`-filtered runs skipping the describe never pay the fold. */
export const driftMemo = (ind: Indicator, fixturePath: string) => {
  let memo: ReturnType<typeof assessDrift> | undefined;
  return (): ReturnType<typeof assessDrift> => (memo ??= assessDrift(ind, readFixture(fixturePath)));
};
