import type { State } from "./domain-types.js";
import { US_FAMILIES, GLOBAL_FAMILIES } from "./families.js";
import type { LastKnownFamily } from "./families.js";
import { DIAL_FAMILIES } from "./danger-ladder.js";

export const rows = (ids: readonly string[], state: State): { id: string; state: State }[] =>
  ids.map((id) => ({ id, state }));

export const FAMILY_TABLES = [
  ["US_FAMILIES", US_FAMILIES],
  ["GLOBAL_FAMILIES", GLOBAL_FAMILIES],
  ["DIAL_FAMILIES", DIAL_FAMILIES],
] as const;

// 2026-07-22 = one trading day before the suite's asOf, inside the carry window.
export const redLastKnown = (defs: readonly { key: string }[]): Record<string, LastKnownFamily> =>
  Object.fromEntries(defs.map((f) => [f.key, { state: "RED", date: "2026-07-22" }]));
