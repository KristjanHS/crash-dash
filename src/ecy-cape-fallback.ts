import type { Observation } from "./domain-types.js";
import type { SeriesPoint, Store } from "./store.js";
import { ECY_MAX_STALE_DAYS } from "./family-descriptor-rows.js";
import { daysBetween } from "./nowcast-carry.js";
import { errMsg } from "./err-msg.js";
import { isNoFreeSource } from "./no-free-source.js";
import { recordDegrade } from "./tracks.js";
import { CAPE_PROBE_LIMIT } from "./run-seeds.js";

type DegradeKind = { kind: "no-free-source" } | undefined;

/** ECY's F7 input: the live CAPE fetch; on a failed fetch, stored F7 if its newest date is ≤ `ECY_MAX_STALE_DAYS` before `now`
 *  (a `trace`), else null (intraday `trace`, full/EOD `notify`). A no-free-source fetch error tags either event, as `degrade()` did. */
export async function capeOrStoredF7(
  fetchCape: () => Promise<Observation[]>,
  store: Pick<Store, "getSeries">,
  now: string,
  intraday: boolean,
  label: string,
): Promise<Observation[] | null> {
  try {
    return await fetchCape();
  } catch (err) {
    const kind: DegradeKind = isNoFreeSource(err) ? { kind: "no-free-source" } : undefined;
    return storedF7OrOmit(store, now, intraday, label, errMsg(err), kind);
  }
}

async function storedF7OrOmit(
  store: Pick<Store, "getSeries">,
  now: string,
  intraday: boolean,
  label: string,
  why: string,
  kind: DegradeKind,
): Promise<Observation[] | null> {
  let stored: SeriesPoint[];
  try {
    stored = await store.getSeries("F7", CAPE_PROBE_LIMIT);
  } catch (readErr) {
    return omitEcyDegrade(label, intraday, `${why} · stored F7 read failed: ${errMsg(readErr)}`, kind);
  }
  const newest = stored.at(-1)?.date;
  if (newest === undefined) return omitEcyDegrade(label, intraday, `${why} · no stored F7`, kind);
  const detail = `${why} · newest stored F7 ${newest} (${stored.length} rows)`;
  if (daysBetween(newest, now) > ECY_MAX_STALE_DAYS) return omitEcyDegrade(label, intraday, detail, kind);
  recordDegrade(`[ECY] ${label} fetch failed - ECY scored off stored F7`, detail, "trace", kind);
  return stored.map((p) => ({ date: p.date, value: p.value }));
}

function omitEcyDegrade(label: string, intraday: boolean, reason: string, kind: DegradeKind): null {
  recordDegrade(`[ECY] ${label} fetch failed, stored F7 stale/empty - ECY omitted this run`, reason, intraday ? "trace" : "notify", kind);
  return null;
}
